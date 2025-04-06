const path = require('node:path');
const fs = require('node:fs/promises');
const ignore = require('ignore');
const mime = require('mime-types');
const { emitLog, getDirectoryStructure, emitFullContextUpdate } = require('./utils');
const { createFileSystemHandlers, loadGitignore } = require('./fileSystem');
const { runGeminiTask } = require('./geminiTaskRunner');
const { model, getToolsDefinition } = require('./geminiSetup');

const UPLOAD_DIR = path.resolve(__dirname, '../../uploads');

// Function to build the system prompt parts
function buildInitialPrompt(BASE_DIR, structureString) {
    const coreRoleText = `You are an AI assistant programmer specialized in **precise file system modifications**. Your primary goal is to execute the user's instructions by interacting with the file system within a strictly defined **Base Directory** using only the provided **Tools**.
**Base Directory:** \`${BASE_DIR}\` (All file paths MUST be relative to this directory).
**Critical Rule:** You **MUST** operate exclusively using the provided **Tools** (function calls). Tool mode is set to 'ANY', meaning you **MUST** respond with a function call. Use \`task_finished\` to end the task. Use \`showInformationTextToUser\` for ALL intermediate status updates, plans, or observations. **DO NOT** output raw text unless it is the 'finalMessage' argument of the 'task_finished' function.`;

    const structureContextText = `**Initial Project File Structure (limited depth, respects .gitignore):**
\`\`\`
${structureString || '- (Directory is empty or initial scan found no relevant files)'}
\`\`\`
**Note:** This structure might be incomplete. Use the \`listFiles\` tool if you need the contents of a specific subdirectory not shown here.`;

    const toolsInfoText = `**Available Tools (Use ONLY these functions via function calls):**
*   **Reading/Searching:**
    *   \`readFileContent(filePath)\`: Get full content of one RELATIVE file path.
    *   \`listFiles(directoryPath?)\`: List files/subdirs in a RELATIVE directory (default: base). Respects .gitignore.
    *   \`searchFiles(pattern)\`: Find files by RELATIVE glob pattern (e.g., \`src/*.js\`). Respects .gitignore.
    *   \`searchFilesByRegex(regexString, directoryPath?)\`: Search file *content* with RELATIVE JS regex (e.g., \`/myFunc/gi\`). Respects .gitignore.
*   **Writing/Modification (Requires User Confirmation unless 'yes/all'):**
    *   \`writeFileContent(filePath, content)\`: Write/Overwrite a RELATIVE file with FULL content.
    *   \`createDirectory(directoryPath)\`: Create a RELATIVE directory (and parents).
    *   \`deleteFile(filePath)\`: Delete a single RELATIVE file (NOT directories).
    *   \`moveItem(sourcePath, destinationPath)\`: Move/Rename a RELATIVE file or directory.
    *   \`deleteDirectory(directoryPath)\`: DANGEROUSLY delete RELATIVE directory recursively.
*   **Interaction & Control:**
    *   \`askUserQuestion(question)\`: Ask user for clarification ONLY when blocked or instructions are ambiguous.
    *   \`showInformationTextToUser(messageToDisplay)\`: **USE THIS** for ALL status updates, plans, errors, or confirmations. DO NOT reply with plain text.
    *   \`task_finished(finalMessage)\`: **USE THIS** to signal successful completion or unrecoverable failure. Provide a summary message. This ENDS the task.`;

    const rulesAndProcessText = `**Mandatory Rules & Execution Process:**
1.  **STRICT CONFINEMENT:** All operations **MUST** target paths **RELATIVE** to the Base Directory (\`${BASE_DIR}\`). Never use absolute paths or \`..\`.
2.  **FUNCTIONS FOR EVERYTHING:** Interact *exclusively* through the provided function calls. You **MUST** call a function in every turn.
3.  **NO INTERMEDIATE TEXT:** Use \`showInformationTextToUser\` for progress updates, plans, errors, or confirmations. Returning plain text (except in \`task_finished\`) WILL cause an error.
4.  **FULL & RAW CONTENT FOR WRITES:** \`writeFileContent\` requires the *complete* and *character-for-character exact, raw* source code content for the file.
    *   **CRITICAL:** The string provided in the \`content\` argument **MUST NOT** contain any Markdown formatting, escaping, or linking (e.g., DO NOT use \`\\[\\\\\`code\\\\\`\\](\\\`code\\\`)\`).
    *   Preserve original indentation and line endings (typically \`\\n\`) unless explicitly instructed to change them. The file system operations expect raw source code.
5.  **HANDLE CONFIRMATION/QUESTIONS:** Be prepared for modification tools to require user confirmation (\`yes\`, \`no\`, \`yes/all\`). Also handle potential user responses from \`askUserQuestion\`. Adapt your plan based on the outcome (provided in the function result). If rejected (\`no\`), use \`showInformationTextToUser\` to explain why you cannot proceed, or call \`task_finished\` if it's a dead end.
6.  **HANDLE ERRORS:** If a tool call returns an error in its result, use \`showInformationTextToUser\` to report it, then decide whether to try an alternative, ask the user (\`askUserQuestion\`), or give up (\`task_finished\`).
7.  **PLAN & EXPLORE:** Analyze the request. Use \`showInformationTextToUser\` to outline complex plans *before* acting. Use reading/searching tools *before* modifying if unsure about the current state. Explain *why* using \`showInformationTextToUser\`.
8.  **CONCLUDE WITH \`task_finished\`:** Call \`task_finished\` with a final summary message ONLY when the entire original request is complete, OR if you have encountered an unrecoverable error or user rejection. This is the ONLY way to end the task successfully.`;

    return { coreRoleText, structureContextText, toolsInfoText, rulesAndProcessText };
}

// Main function to set up and kick off the task
async function setupAndStartTask(socket, data, state) {
    const { taskStates, activeChatSessions, connectionState } = state;
    const { confirmAllRef, feedbackResolverRef, questionResolverRef, currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef } = connectionState;

    console.log(`Processing start-task request for ${socket.id}...`);
    console.debug("Task data received:", { ...data, prompt: data.prompt ? data.prompt.substring(0, 50) + '...' : '', uploadedFiles: data.uploadedFiles?.length });

    // Reset connection-specific state for the new task
    confirmAllRef.value = false;
    feedbackResolverRef.value = null;
    questionResolverRef.value = null;
    currentChangesLogRef.value = [];
    currentBaseDirRef.value = null;
    currentOriginalPromptRef.value = null;

    // Extract data from the client request
    const relativeBaseDir = data.baseDir?.trim();
    const userPrompt = data.prompt?.trim();
    const continueContext = data.continueContext || false;
    const uploadedFiles = data.uploadedFiles || [];
    const temperature = data.temperature ?? 1; // Default temperature

    // Basic validation
    if (!userPrompt || !relativeBaseDir) {
        const missing = !userPrompt ? "Your Instructions (prompt)" : "Base Directory";
        // ADDED isAction flag
        emitLog(socket, `Error: ${missing} cannot be empty.`, 'error', true);
        socket.emit('task-error', { message: `${missing} is required.` });
        return;
    }

    let BASE_DIR;
    try {
        // Resolve and validate the base directory
        BASE_DIR = path.resolve(relativeBaseDir);
        currentBaseDirRef.value = BASE_DIR; // Store resolved path for this connection
        // ADDED isAction flag
        emitLog(socket, `Resolved Base Directory: ${BASE_DIR}`, 'info', true);

        // Use updated emitFullContextUpdate structure
        emitFullContextUpdate(socket, { type: 'initial_prompt', text: `Task Started. Base Dir: ${BASE_DIR}` });
        emitFullContextUpdate(socket, { type: 'initial_prompt', text: `Prompt: ${userPrompt.substring(0, 100)}${userPrompt.length > 100 ? '...' : ''}` });

        const stats = await fs.stat(BASE_DIR);
        if (!stats.isDirectory()) {
            throw new Error(`Specified base path exists but is not a directory.`);
        }
        // ADDED isAction flag
        emitLog(socket, `✅ Base directory confirmed: ${BASE_DIR}`, 'success', true);

        // Load .gitignore rules
        const ig = await loadGitignore(BASE_DIR, socket); // loadGitignore already logs debug info

        // Get initial directory structure
        // ADDED isAction flag
        emitLog(socket, `Scanning directory structure (max depth 2)...`, 'info', true);
        let structureLines = await getDirectoryStructure(BASE_DIR, BASE_DIR, ig, 2);
        const structureString = structureLines.join('\n');
        // ADDED isAction flag (for the structure itself)
        emitLog(socket, `Initial Directory Structure (filtered):\n${structureString || '(empty or all ignored)'}`, 'info', true);

        // --- Process Uploaded Images ---
        const imageParts = [];
        if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
            // ADDED isAction flag
            emitLog(socket, `Processing ${uploadedFiles.length} uploaded image reference(s)...`, 'info', true);
            emitFullContextUpdate(socket, { type: 'initial_prompt', text: `Processing ${uploadedFiles.length} image(s)` });

            for (const filename of uploadedFiles) {
                // Basic security check on filename
                if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
                    // ADDED isAction flag
                    emitLog(socket, ` - ⚠️ Skipping potentially unsafe filename '${filename}'.`, 'warn', true);
                    continue;
                }
                const filePath = path.join(UPLOAD_DIR, filename);
                try {
                    await fs.access(filePath); // Check if file exists
                    const fileBuffer = await fs.readFile(filePath);
                    const mimeType = mime.lookup(filePath) || 'application/octet-stream'; // Determine MIME type

                    if (mimeType.startsWith('image/')) {
                        imageParts.push({ inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } });
                        // ADDED isAction flag
                        emitLog(socket, ` - Added image '${filename}' (${mimeType}, ${Math.round(fileBuffer.length / 1024)} KB).`, 'info', true);
                    } else {
                        // ADDED isAction flag
                        emitLog(socket, ` - ⚠️ Skipping non-image file '${filename}' (type: ${mimeType}).`, 'warn', true);
                    }
                } catch (fileError) {
                    if (fileError.code === 'ENOENT') {
                        // ADDED isAction flag
                        emitLog(socket, ` - ⚠️ Error: Uploaded file reference not found on server: '${filename}'. Skipping.`, 'error', true);
                    } else {
                        // ADDED isAction flag
                        emitLog(socket, ` - ⚠️ Error processing uploaded file '${filename}': ${fileError.message}`, 'error', true);
                    }
                }
            }
            // ADDED isAction flag
            emitLog(socket, `Processed ${imageParts.length} valid image(s) for Gemini input.`, 'info', true);
        }
        // --- End Image Processing ---


        // --- Initialize Chat Session and History ---
        let chatSession;
        let initialMessageParts = []; // Parts for the *first* message to Gemini
        let historyForGemini = []; // History *before* the first message
        let contextChangesToSend = []; // Changes to send to client UI

        const tools = getToolsDefinition(BASE_DIR);
        const toolConfig = { functionCallingConfig: { mode: "ANY" } }; // Force function calling

        if (continueContext && activeChatSessions.has(socket.id)) {
            // Option 1: Continue in-memory session (if available and requested)
            chatSession = activeChatSessions.get(socket.id);
            // ADDED isAction flag
            emitLog(socket, "🔄 Continuing previous active chat session (in-memory).", 'info', true);
            // The user prompt is the next message, along with any images
            initialMessageParts = [{ text: `User Request (Continue Task): "${userPrompt}"` }, ...imageParts];
            currentOriginalPromptRef.value = userPrompt; // Update original prompt for this continuation segment? Or keep the very first? Let's update for now.

            // Load context from task state to send to UI if needed
            const savedState = taskStates.get(BASE_DIR);
            contextChangesToSend = savedState?.changes || [];
            emitFullContextUpdate(socket, { type: 'resume_prompt', text: `Continuing Task...` });

        } else if (continueContext && taskStates.has(BASE_DIR)) {
            // Option 2: Resume from saved state (if available and requested, but no active session)
            const savedState = taskStates.get(BASE_DIR);
            currentOriginalPromptRef.value = savedState.originalPrompt; // Keep the original prompt
            contextChangesToSend = savedState.changes || [];

            const changesSummary = contextChangesToSend.length > 0
                ? contextChangesToSend.map(c => `- ${c.type}: ${c.filePath || c.directoryPath || `${c.sourcePath} -> ${c.destinationPath}`}`).join('\n')
                : '(None recorded)';

            const resumePreamble = `You are resuming a previous task for the base directory '${BASE_DIR}'.\r\n**Original User Request:** "${savedState.originalPrompt}"\r\n**Previously Applied Changes:**\r\n${changesSummary}\r\n---\r\n**Current User Request (Continue Task):** "${userPrompt}"\r\n---\r\nAnalyze the current request in the context of the original goal and previous changes, then proceed using function calls. Remember to call 'task_finished' when done.`;

            // ADDED isAction flag
            emitLog(socket, `🔄 Resuming task from saved state for ${BASE_DIR}. Original Goal: "${savedState.originalPrompt}"`, 'info', true);
            if (changesSummary !== '(None recorded)') {
                // ADDED isAction flag
                emitLog(socket, `ℹ️ Previous changes loaded:\n${changesSummary}`, 'info', true);
            }
            emitFullContextUpdate(socket, { type: 'resume_prompt', text: `Resuming Task (Original: ${savedState.originalPrompt.substring(0, 50)}...)` });

            // Clear any lingering in-memory session if we are resuming from storage
            if (activeChatSessions.has(socket.id)) {
                emitLog(socket, "🧹 Clearing previous in-memory session before resuming from saved state.", 'debug'); // Not bubble
                activeChatSessions.delete(socket.id);
            }

            // Start a new chat session for the resume
            chatSession = model.startChat({ tools: [tools], toolConfig: toolConfig, history: [] }); // Start fresh, preamble contains context
            activeChatSessions.set(socket.id, chatSession);
            initialMessageParts = [{ text: resumePreamble }, ...imageParts];

        } else {
            // Option 3: Start a new task (default or if continueContext is false/unavailable)
            currentOriginalPromptRef.value = userPrompt; // This is the original prompt
            contextChangesToSend = []; // No previous context for UI

            const { coreRoleText, structureContextText, toolsInfoText, rulesAndProcessText } = buildInitialPrompt(BASE_DIR, structureString);
            const initialUserRequestText = `**Begin Task Execution for User Request:**\n"${userPrompt}"`;

            // Clear any old session/state if starting fresh
            if (activeChatSessions.has(socket.id)) {
                emitLog(socket, "🧹 Starting new task, clearing previous in-memory session.", 'debug'); // Not bubble
                activeChatSessions.delete(socket.id);
            }
            if (!continueContext && taskStates.has(BASE_DIR)) {
                // ADDED isAction flag
                emitLog(socket, `🗑️ Clearing saved state for ${BASE_DIR} as 'Continue Context' is unchecked.`, 'info', true);
                taskStates.delete(BASE_DIR);
            }

            // ADDED isAction flag
            emitLog(socket, "✨ Starting new chat session.", 'info', true);

            // Initialize chat with system instruction and context
            chatSession = model.startChat({
                tools: [tools],
                toolConfig: toolConfig,
                systemInstruction: { role: "system", parts: [{ text: coreRoleText + "\n" + rulesAndProcessText }] },
                history: [
                    { role: "user", parts: [{ text: structureContextText + "\n" + toolsInfoText }] },
                     // Optionally add an empty model response if needed by the API structure
                    // { role: "model", parts: [{ text: "Okay, I understand the rules and context. Please provide the task instructions." }] }
                ]
            });
            activeChatSessions.set(socket.id, chatSession); // Store the new session

            // The first message will contain the user's actual prompt and images
            initialMessageParts = [
                { text: initialUserRequestText },
                ...imageParts
            ];
        }
        // --- End Chat Session Initialization ---

        // Send initial context state to client UI if needed
        if (contextChangesToSend.length > 0) {
            // ADDED isAction flag
            emitLog(socket, `📊 Sending initial context state to client (changes: ${contextChangesToSend.length})`, 'info', true);
            socket.emit('context-update', { changes: contextChangesToSend });
        }

        // --- Validate Session and Message ---
        if (!chatSession) {
            throw new Error("Internal error: Chat session was not initialized.");
        }
        if (!initialMessageParts || initialMessageParts.length === 0) {
             // Check if it was just images
            if (!userPrompt && imageParts.length === 0) {
                 throw new Error("Internal error: Failed to construct initial message for Gemini (empty prompt/images).");
            }
            // If only images were provided, ensure initialMessageParts is at least an empty array
             initialMessageParts = initialMessageParts || [];
         }
        // --- End Validation ---


        // Prepare context and handlers for the task runner
        const handlerContext = { socket, BASE_DIR, confirmAllRef, feedbackResolverRef, questionResolverRef, changesLog: currentChangesLogRef.value };
        const fileSystemHandlers = createFileSystemHandlers(handlerContext, currentChangesLogRef.value);

        const taskContext = {
            socket,
            BASE_DIR,
            messageToSend: initialMessageParts, // The first message for Gemini
            chatSession,
            functionHandlers: fileSystemHandlers,
            confirmAllRef,
            feedbackResolverRef,
            questionResolverRef,
            temperature,
            currentChangesLog: currentChangesLogRef.value, // Pass the ref's value
            originalPromptForState: currentOriginalPromptRef.value, // Pass the ref's value
            retryDelay: parseInt(process.env.GEMINI_RETRY_DELAY || '120000', 10), // Use env var or default
            toolConfig: toolConfig
        };

        // Start the asynchronous task execution loop
        runGeminiTask(taskContext, state);

    } catch (error) {
        // Catch errors during setup (e.g., directory access)
        const targetDir = currentBaseDirRef.value || relativeBaseDir || '(unknown)';
        let userMessage = `Error preparing task: ${error.message}`;

        // Provide more specific error messages
        if (error.code === 'ENOENT' && (error.path === BASE_DIR || error.syscall === 'stat')) {
            userMessage = `Base directory not found or inaccessible: ${targetDir}`;
        } else if (error.code === 'EACCES') {
            userMessage = `Permission denied when accessing base directory or its contents: ${targetDir}`;
        } else if (error.message.includes('not a directory')) {
             userMessage = `Specified base path is not a directory: ${targetDir}`;
         }

        // ADDED isAction flag
        emitLog(socket, `❌ Error during task setup for ${targetDir}: ${error.message}`, 'error', true);
        console.error(`Task Setup Error for ${targetDir}:`, error);
        // Use updated emitFullContextUpdate structure
        emitFullContextUpdate(socket, { type: 'error', text: `Setup Error: ${userMessage}` });
        socket.emit('task-error', { message: userMessage });

        // Clean up state refs on error
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        currentChangesLogRef.value = [];
        if (activeChatSessions.has(socket.id)) {
            activeChatSessions.delete(socket.id);
            console.log(`🧹 Cleared active chat session for ${socket.id} due to setup error.`);
        }
    }
}

module.exports = { setupAndStartTask, buildInitialPrompt };