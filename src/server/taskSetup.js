const path = require('node:path');
const fs = require('node:fs/promises');
const ignore = require('ignore');
const mime = require('mime-types');
const { emitLog, getDirectoryStructure, emitContextLog } = require('./utils'); // Added emitContextLog
const { createFileSystemHandlers, loadGitignore } = require('./fileSystem'); // Added loadGitignore
const { runGeminiTask } = require('./geminiTaskRunner');
const { model, getToolsDefinition } = require('./geminiSetup');

const UPLOAD_DIR = path.resolve(__dirname, '../../uploads');

// --- Build Initial Prompt ---
function buildInitialPrompt(BASE_DIR, structureString) {
    const coreRoleText = `You are an AI assistant specialized in **precise file system modifications**. Your primary goal is to execute the user's instructions by interacting with the file system within a strictly defined **Base Directory** using only the provided **Tools**.
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
    *   \`searchFiles(pattern)\`: Find files by RELATIVE glob pattern (e.g., \`src/**/*.js\`). Respects .gitignore.
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
4.  **FULL CONTENT FOR WRITES:** \`writeFileContent\` requires the *complete* final content of the file.
5.  **HANDLE CONFIRMATION/QUESTIONS:** Be prepared for modification tools to require user confirmation (\`yes\`, \`no\`, \`yes/all\`). Also handle potential user responses from \`askUserQuestion\`. Adapt your plan based on the outcome (provided in the function result). If rejected (\`no\`), use \`showInformationTextToUser\` to explain why you cannot proceed, or call \`task_finished\` if it's a dead end.
6.  **HANDLE ERRORS:** If a tool call returns an error in its result, use \`showInformationTextToUser\` to report it, then decide whether to try an alternative, ask the user (\`askUserQuestion\`), or give up (\`task_finished\`).
7.  **PLAN & EXPLORE:** Analyze the request. Use \`showInformationTextToUser\` to outline complex plans *before* acting. Use reading/searching tools *before* modifying if unsure about the current state. Explain *why* using \`showInformationTextToUser\`.
8.  **CONCLUDE WITH \`task_finished\`:** Call \`task_finished\` with a final summary message ONLY when the entire original request is complete, OR if you have encountered an unrecoverable error or user rejection. This is the ONLY way to end the task successfully.`;

    return { coreRoleText, structureContextText, toolsInfoText, rulesAndProcessText };
}

// --- Main Task Setup Function ---
async function setupAndStartTask(socket, data, state) {
    const { taskStates, activeChatSessions, connectionState } = state;
    const { confirmAllRef, feedbackResolverRef, questionResolverRef, currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef } = connectionState;

    console.log(`Processing start-task request for ${socket.id}...`);
    console.debug("Task data received:", { ...data, prompt: data.prompt ? data.prompt.substring(0, 50) + '...' : '' });

    // --- Reset connection-specific state ---
    confirmAllRef.value = false;
    feedbackResolverRef.value = null;
    questionResolverRef.value = null;
    currentChangesLogRef.value = []; // Reset changes log for this run
    currentBaseDirRef.value = null; // Reset base dir ref
    currentOriginalPromptRef.value = null; // Reset original prompt ref

    // --- Extract and Validate Input Data ---
    const relativeBaseDir = data.baseDir?.trim();
    const userPrompt = data.prompt?.trim();
    const continueContext = data.continueContext || false;
    const uploadedFiles = data.uploadedFiles || [];
    const temperature = data.temperature ?? 0.7; // Default temperature

    if (!userPrompt || !relativeBaseDir) {
        const missing = !userPrompt ? "Your Instructions (prompt)" : "Base Directory";
        emitLog(socket, `Error: ${missing} cannot be empty.`, 'error');
        socket.emit('task-error', { message: `${missing} is required.` });
        return;
    }

    let BASE_DIR;
    try {
        // --- Resolve and Validate Base Directory ---
        BASE_DIR = path.resolve(relativeBaseDir);
        currentBaseDirRef.value = BASE_DIR; // Store resolved path
        emitLog(socket, `Resolved Base Directory: ${BASE_DIR}`, 'info');
        // Initial context log entry
        emitContextLog(socket, 'initial_prompt', `Task Started. Base Dir: ${BASE_DIR}`);
        emitContextLog(socket, 'initial_prompt', `Prompt: ${userPrompt.substring(0,100)}${userPrompt.length > 100 ? '...' : ''}`);


        const stats = await fs.stat(BASE_DIR);
        if (!stats.isDirectory()) {
            throw new Error(`Specified base path exists but is not a directory.`);
        }
        emitLog(socket, `✅ Base directory confirmed: ${BASE_DIR}`, 'success');

        // --- Load .gitignore and Get Initial Structure ---
        const ig = await loadGitignore(BASE_DIR, socket); // Use helper from fileSystem
        emitLog(socket, `Scanning directory structure (max depth 2)...`, 'info');
        let structureLines = await getDirectoryStructure(BASE_DIR, BASE_DIR, ig, 2); // Max depth 2
        const structureString = structureLines.join('\n');
        emitLog(socket, `Initial Directory Structure (filtered):\n${structureString || '(empty or all ignored)'}`, 'info');
        // emitContextLog(socket, 'initial_state', `Scanned Structure:\n${structureString || '(empty)'}`); // Maybe too verbose for context

        // --- Process Uploaded Images ---
        const imageParts = [];
        if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
            emitLog(socket, `Processing ${uploadedFiles.length} uploaded image reference(s)...`, 'info');
            emitContextLog(socket, 'initial_prompt', `Processing ${uploadedFiles.length} image(s)`);
            for (const filename of uploadedFiles) {
                 // Basic security check on filename
                 if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
                     emitLog(socket, ` - ⚠️ Skipping potentially unsafe filename '${filename}'.`, 'warn');
                     continue;
                 }
                const filePath = path.join(UPLOAD_DIR, filename);
                try {
                    await fs.access(filePath); // Check if file exists server-side
                    const fileBuffer = await fs.readFile(filePath);
                    const mimeType = mime.lookup(filePath) || 'application/octet-stream';

                    if (mimeType.startsWith('image/')) {
                         imageParts.push({ inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } });
                         emitLog(socket, ` - Added image '${filename}' (${mimeType}, ${Math.round(fileBuffer.length / 1024)} KB).`, 'info');
                    } else {
                         emitLog(socket, ` - ⚠️ Skipping non-image file '${filename}' (type: ${mimeType}).`, 'warn');
                    }
                } catch (fileError) {
                     if (fileError.code === 'ENOENT') {
                         emitLog(socket, ` - ⚠️ Error: Uploaded file reference not found on server: '${filename}'. Skipping.`, 'error');
                     } else {
                         emitLog(socket, ` - ⚠️ Error processing uploaded file '${filename}': ${fileError.message}`, 'error');
                     }
                 }
            }
            emitLog(socket, `Processed ${imageParts.length} valid image(s) for Gemini input.`, 'info');
        }

        // --- Prepare Chat Session and Initial Message ---
        let chatSession;
        let initialMessageParts = [];
        let contextChangesToSend = []; // For initial client display if resuming

        // Get Tool definitions and config
        const tools = getToolsDefinition(BASE_DIR); // Returns { functionDeclarations: [...] }
        const toolConfig = { functionCallingConfig: { mode: "ANY" } }; // Force function calling

        if (continueContext && activeChatSessions.has(socket.id)) {
            // Option 1: Continue in-memory session (if same socket connection)
             chatSession = activeChatSessions.get(socket.id);
             emitLog(socket, "🔄 Continuing previous active chat session (in-memory).", 'info');
             // Send only the new user prompt and images
             initialMessageParts = [{ text: `User Request (Continue Task): "${userPrompt}"` }, ...imageParts];
             currentOriginalPromptRef.value = userPrompt; // Update prompt ref for this segment
             // Get current state for context display
              const savedState = taskStates.get(BASE_DIR);
              contextChangesToSend = savedState?.changes || [];
              emitContextLog(socket, 'resume_prompt', `Continuing Task...`);


        } else if (continueContext && taskStates.has(BASE_DIR)) {
            // Option 2: Resume from saved state (different connection or cleared memory)
            const savedState = taskStates.get(BASE_DIR);
            currentOriginalPromptRef.value = savedState.originalPrompt; // Restore original prompt for context
            contextChangesToSend = savedState.changes || []; // Load previous changes

            const changesSummary = contextChangesToSend.length > 0
                ? contextChangesToSend.map(c => `- ${c.type}: ${c.filePath || c.directoryPath || `${c.sourcePath} -> ${c.destinationPath}`}`).join('\n')
                : '(None recorded)';

            const resumePreamble = `You are resuming a previous task for the base directory '${BASE_DIR}'.
**Original User Request:** "${savedState.originalPrompt}"
**Previously Applied Changes:**
${changesSummary}
---
**Current User Request (Continue Task):** "${userPrompt}"
---
Analyze the current request in the context of the original goal and previous changes, then proceed using function calls. Remember to call 'task_finished' when done.`;

            emitLog(socket, `🔄 Resuming task from saved state for ${BASE_DIR}. Original Goal: "${savedState.originalPrompt}"`, 'info');
            if (changesSummary !== '(None recorded)') emitLog(socket, `ℹ️ Previous changes loaded:\n${changesSummary}`, 'info');
            emitContextLog(socket, 'resume_prompt', `Resuming Task (Original: ${savedState.originalPrompt.substring(0,50)}...)`);

            // Clear any old in-memory session for this socket
            if (activeChatSessions.has(socket.id)) {
                 emitLog(socket, "🧹 Clearing previous in-memory session before resuming from saved state.", 'debug');
                 activeChatSessions.delete(socket.id);
            }

            // Start a new chat session with the resume preamble
            chatSession = model.startChat({
                 tools: [tools], // Pass the array of FunctionDeclaration objects
                 toolConfig: toolConfig, // Force ANY mode
                 history: [] // Start fresh history with resume context
             });
             activeChatSessions.set(socket.id, chatSession);
             initialMessageParts = [{ text: resumePreamble }, ...imageParts];

        } else {
            // Option 3: Start a fresh task
            currentOriginalPromptRef.value = userPrompt; // Store the prompt for state saving
            contextChangesToSend = []; // No initial context changes

            const { coreRoleText, structureContextText, toolsInfoText, rulesAndProcessText } = buildInitialPrompt(BASE_DIR, structureString);
            const initialUserRequestText = `**Begin Task Execution for User Request:**\n"${userPrompt}"`;

            // Clear any old session or state if not continuing
            if (activeChatSessions.has(socket.id)) {
                emitLog(socket, "🧹 Starting new task, clearing previous in-memory session.", 'debug');
                activeChatSessions.delete(socket.id);
            }
            if (!continueContext && taskStates.has(BASE_DIR)) {
                emitLog(socket, `🗑️ Clearing saved state for ${BASE_DIR} as 'Continue Context' is unchecked.`, 'info');
                 taskStates.delete(BASE_DIR);
            }

            emitLog(socket, "✨ Starting new chat session.", 'info');
            chatSession = model.startChat({
                tools: [tools], // Pass the array of FunctionDeclaration objects
                toolConfig: toolConfig, // Force ANY mode
                // history: [] // Start with empty history
                // Optionally include system instruction here if preferred over message parts
                 systemInstruction: { role: "system", parts: [{ text: coreRoleText + "\n" + rulesAndProcessText }] },
                 history: [
                     { role: "user", parts: [{ text: structureContextText + "\n" + toolsInfoText }] }, // Provide context as 'user' turn? Or system?
                     // Let's try sending the core rules as system instruction, context/tools as user, then the real prompt.
                 ]
            });
            activeChatSessions.set(socket.id, chatSession);

            // Construct initial message parts for the first sendMessage call
            // Combine prompt and images
             initialMessageParts = [
                 // { text: coreRoleText }, // Now in systemInstruction
                 // { text: structureContextText },
                 // { text: toolsInfoText },
                 // { text: rulesAndProcessText }, // Now in systemInstruction
                 { text: initialUserRequestText },
                 ...imageParts
             ];
        }

        // Send initial context state to client (mostly relevant for resumes)
        // For new tasks, client clears context anyway.
        if (contextChangesToSend.length > 0) {
             emitLog(socket, `📊 Sending initial context state to client (changes: ${contextChangesToSend.length})`, 'info');
             socket.emit('context-update', { changes: contextChangesToSend });
        }
        // For new tasks, the initial context logs already sent via emitContextLog are sufficient.


        if (!chatSession) {
            throw new Error("Internal error: Chat session was not initialized.");
        }
        if (!initialMessageParts || initialMessageParts.length === 0) {
             // If using system instruction, initial message might just be the prompt part
             if (!userPrompt && imageParts.length === 0) {
                throw new Error("Internal error: Failed to construct initial message for Gemini (empty prompt/images).");
             }
             // Ensure initialMessageParts is at least an empty array if only images are present
             initialMessageParts = initialMessageParts || [];
        }

        // --- Prepare Function Handlers and Start Execution ---
        const handlerContext = {
            socket,
            BASE_DIR,
            confirmAllRef,
            feedbackResolverRef,
            questionResolverRef,
            changesLog: currentChangesLogRef.value // Pass the reference array directly
        };
        const fileSystemHandlers = createFileSystemHandlers(handlerContext, currentChangesLogRef.value);

        const taskContext = {
            socket,
            BASE_DIR,
            messageToSend: initialMessageParts,
            chatSession,
            functionHandlers: fileSystemHandlers, // Pass the created handlers
            confirmAllRef,
            feedbackResolverRef,
            questionResolverRef,
            temperature,
            currentChangesLog: currentChangesLogRef.value, // Pass the array for runner access if needed
            originalPromptForState: currentOriginalPromptRef.value, // Pass the correct original prompt
            retryDelay: process.env.GEMINI_RETRY_DELAY || 120000,
            toolConfig: toolConfig // Pass toolConfig to runner
        };

        // Start the asynchronous task runner
        runGeminiTask(taskContext);

    } catch (error) {
        // --- Handle Setup Errors ---
        const targetDir = currentBaseDirRef.value || relativeBaseDir || '(unknown)';
        let userMessage = `Error preparing task: ${error.message}`;

        // Provide more specific user messages for common errors
        if (error.code === 'ENOENT' && (error.path === BASE_DIR || error.syscall === 'stat')) {
            userMessage = `Base directory not found or inaccessible: ${targetDir}`;
        } else if (error.code === 'EACCES') {
             userMessage = `Permission denied when accessing base directory or its contents: ${targetDir}`;
        } else if (error.message.includes('not a directory')) {
            userMessage = `Specified base path is not a directory: ${targetDir}`;
        }

        emitLog(socket, `❌ Error during task setup for ${targetDir}: ${error.message}`, 'error');
        console.error(`Task Setup Error for ${targetDir}:`, error);
        emitContextLog(socket, 'error', `Setup Error: ${userMessage}`);
        socket.emit('task-error', { message: userMessage });

        // Clean up state refs on error during setup
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        currentChangesLogRef.value = [];
        if (activeChatSessions.has(socket.id)) {
            activeChatSessions.delete(socket.id);
            console.log(`🧹 Cleared active chat session for ${socket.id} due to setup error.`);
        }
    }
}

module.exports = { setupAndStartTask };