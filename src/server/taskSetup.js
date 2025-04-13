// c:\dev\gemini-coder\src\server\taskSetup.js
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url"; // Needed for __dirname replacement
import ignore from "ignore";
import mime from "mime-types"; // Ensure this package supports ES module import

import { emitLog, getDirectoryStructure, emitFullContextUpdate, emitContextLogEntry } from "./utils.js"; // Added .js
import { createFileSystemHandlers, loadGitignore } from "./fileSystem/index.js"; // Import from index, added .js
import { runGeminiTask } from "./geminiTaskRunner.js"; // Added .js
import { model, getToolsDefinition } from "./geminiSetup.js"; // Added .js

// Derive __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define UPLOAD_DIR using the derived __dirname
const UPLOAD_DIR = path.resolve(__dirname, "../../uploads");

// Function to build the initial system prompt and context messages
// Kept separate for clarity
export function buildInitialPrompt(BASE_DIR, structureString) {
    const coreRoleText = `You are an AI assistant programmer specialized in **precise file system modifications**.
Your primary goal is to execute the user"s instructions by interacting with the file system within a strictly defined **Base Directory** using only the provided **Tools**.
**Base Directory:** ".${BASE_DIR}.". (All file paths MUST be relative to this directory).
**Critical Rule:** You **MUST** operate exclusively using the provided **Tools** (function calls).
Use ."task_finished.". to end the task.
Use ."showInformationTextToUser.". for ALL intermediate status updates, plans, or observations.`;

    const structureContextText = `**Initial Project File Structure (limited depth, respects .gitignore):**
."""
${structureString || "- (Directory is empty or initial scan found no relevant files)"}
."""
**Note:** This structure might be incomplete. Use the ."listFiles.". tool if you need the contents of a specific subdirectory not shown here.`;

    const toolsInfoText = `**Available Tools (Use ONLY these functions via function calls):**
*   **Reading/Searching:**
    *   ."readFileContent(filePath).".: Get full content of one RELATIVE file path.
    *   ."listFiles(directoryPath?).".: List files/subdirs in a RELATIVE directory (default: base). Respects .gitignore.
    *   ."searchFiles(pattern).".: Find files by RELATIVE glob pattern (e.g., ."src/**/*.js.".). Respects .gitignore.
    *   ."searchFilesByRegex(regexString, directoryPath?).".: Search file *content* with RELATIVE JS regex (e.g., ."/myFunc/gi.".). Respects .gitignore. Returns only matching file paths and counts.
*   **Writing/Modification (Requires User Confirmation unless "yes/all"):**
    *   ."writeFileContent(filePath, content).".: Write/Overwrite a RELATIVE file with FULL, RAW content.
    *   ."createDirectory(directoryPath).".: Create a RELATIVE directory (and parents).
    *   ."deleteFile(filePath).".: Delete a single RELATIVE file (NOT directories).
    *   ."moveItem(sourcePath, destinationPath).".: Move/Rename a RELATIVE file or directory.
    *   ."deleteDirectory(directoryPath).".: DANGEROUSLY delete RELATIVE directory recursively.
*   **Interaction & Control:**
    *   ."askUserQuestion(question).".: Ask user for clarification ONLY when blocked or instructions are ambiguous.
    *   ."showInformationTextToUser(messageToDisplay).".: **USE THIS** for ALL status updates, plans, errors, or confirmations. DO NOT reply with plain text.
    *   ."task_finished(finalMessage).".: **USE THIS** to signal successful completion or unrecoverable failure. Provide a summary message. This ENDS the task.`;

    const rulesAndProcessText = `**Mandatory Rules & Execution Process:**
1.  **STRICT CONFINEMENT:** All operations **MUST** target paths **RELATIVE** to the Base Directory (."${BASE_DIR}.".). Never use absolute paths or ."..". Check paths carefully.
2.  **FUNCTIONS FOR EVERYTHING:** Interact *exclusively* through the provided function calls. You **MUST** call a function in every turn.
3.  **NO INTERMEDIATE TEXT:** Use ."showInformationTextToUser.". for progress updates, plans, errors, or confirmations. Returning plain text (except in ."task_finished.".). WILL cause an error.
4.  **FULL & RAW CONTENT FOR WRITES:** ."writeFileContent.". requires the *complete* and *character-for-character exact, raw* source code content for the file.
    *   **CRITICAL:** The string provided in the ."content.". argument **MUST NOT** contain any Markdown formatting (like ."... code ...".), escaping, or linking. Preserve original indentation and line endings (typically ."\\n".). unless explicitly instructed to change them. The file system operations expect raw source code.
5.  **HANDLE CONFIRMATION/QUESTIONS:** Be prepared for modification tools to require user confirmation (."yes.".)., ."no.".)., ."yes/all.".).). Also handle potential user responses from ."askUserQuestion.". Adapt your plan based on the outcome (provided in the function result). If rejected (."no.".)., use ."showInformationTextToUser.". to explain why you cannot proceed, or call ."task_finished.". if it"s a dead end.
6.  **HANDLE ERRORS:** If a tool call returns an error in its result, use ."showInformationTextToUser.". to report it, then decide whether to try an alternative, ask the user (."askUserQuestion.".)., or give up (."task_finished.".).
7.  **PLAN & EXPLORE:** Analyze the request. Use ."showInformationTextToUser.". to outline complex plans *before* acting. Use reading/searching tools *before* modifying if unsure about the current state. Explain *why* using ."showInformationTextToUser.".
8.  **CONCLUDE WITH ."task_finished.".:** Call ."task_finished.". with a final summary message ONLY when the entire original request is complete, OR if you have encountered an unrecoverable error or user rejection. This is the ONLY way to end the task successfully.`;

    return { coreRoleText, structureContextText, toolsInfoText, rulesAndProcessText };
}


// Main function to set up and start a task
export async function setupAndStartTask(socket, data, state) {
    const { taskStates, activeChatSessions, connectionState } = state;
    // Destructure refs directly for easier access to .value
    const {
        confirmAllRef,
        feedbackResolverRef,
        questionResolverRef,
        currentChangesLogRef,
        currentBaseDirRef,
        currentOriginalPromptRef
    } = connectionState;

    console.log(`Processing start-task request for ${socket.id}...`);
    // Log sensitive data carefully
    console.debug("Task data received:", {
        baseDir: data.baseDir,
        prompt: data.prompt ? data.prompt.substring(0, 50) + "..." : "(no prompt)",
        continueContext: data.continueContext,
        temperature: data.temperature,
        uploadedFiles: data.uploadedFiles?.length ?? 0
    });

    // Reset connection-specific state for the new task run
    confirmAllRef.value = false;
    feedbackResolverRef.value = null;
    questionResolverRef.value = null;
    currentChangesLogRef.value = []; // Reset change log for this run
    currentBaseDirRef.value = null;
    currentOriginalPromptRef.value = null;

    // Extract and validate task parameters
    const relativeBaseDir = data.baseDir?.trim();
    const userPrompt = data.prompt?.trim();
    const continueContext = data.continueContext || false;
    const uploadedFiles = data.uploadedFiles || []; // Ensure it"s an array
    const temperature = data.temperature ?? 1; // Default temperature

    if (!userPrompt || !relativeBaseDir) {
        const missing = !userPrompt ? "Your Instructions (prompt)" : "Base Directory";
        emitLog(socket, `Error: ${missing} cannot be empty.`, "error", true);
        emitContextLogEntry(socket, "error", `Task Start Failed: ${missing} required.`);
        socket.emit("task-error", { message: `${missing} is required.` });
        return; // Stop processing
    }

    let BASE_DIR;
    try {
        // Resolve and validate BASE_DIR
        BASE_DIR = path.resolve(relativeBaseDir);
        currentBaseDirRef.value = BASE_DIR; // Store resolved path in state ref
        emitLog(socket, `Resolved Base Directory: ${BASE_DIR}`, "info", true);
        // Use emitContextLogEntry for simpler context updates
        emitContextLogEntry(socket, "initial_state", `Task Starting. Base Dir: ${BASE_DIR}`);
        emitContextLogEntry(socket, "initial_prompt", `Prompt: ${userPrompt.substring(0, 100)}${userPrompt.length > 100 ? "..." : ""}`);

        const stats = await fs.stat(BASE_DIR);
        if (!stats.isDirectory()) {
            // Throw specific error if path is not a directory
            throw new Error(`Specified base path exists but is not a directory.`);
        }
        emitLog(socket, `✅ Base directory confirmed: ${BASE_DIR}`, "success", true);

        // Load .gitignore and get initial directory structure
        const ig = await loadGitignore(BASE_DIR, socket);
        emitLog(socket, `Scanning directory structure (max depth 2)...`, "info", true);
        let structureLines = await getDirectoryStructure(BASE_DIR, BASE_DIR, ig, 2); // Max depth 2
        const structureString = structureLines.join("\n");
        emitLog(socket, `Initial Directory Structure (filtered):\n${structureString || "(empty or all ignored)"}`, "info", true);
        // Optionally send structure to context? Might be too verbose.
        // emitContextLogEntry(socket, "initial_state", `Structure: ${structureString.substring(0,100)}...`);

        // Process uploaded images
        const imageParts = [];
        if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
            emitLog(socket, `Processing ${uploadedFiles.length} uploaded image reference(s)...`, "info", true);
            emitContextLogEntry(socket, "initial_state", `Processing ${uploadedFiles.length} image(s)`);

            for (const filename of uploadedFiles) {
                // Basic security check on filename
                if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
                    emitLog(socket, ` - ⚠️ Skipping potentially unsafe filename "${filename}".`, "warn", true);
                    continue;
                }

                const filePath = path.join(UPLOAD_DIR, filename);
                try {
                    await fs.access(filePath); // Check if file exists
                    const fileBuffer = await fs.readFile(filePath);
                    const mimeType = mime.lookup(filePath) || "application/octet-stream"; // Get MIME type

                    if (mimeType.startsWith("image/")) {
                        // Prepare image data for Gemini API
                        imageParts.push({
                            inlineData: {
                                data: fileBuffer.toString("base64"),
                                mimeType: mimeType
                            }
                        });
                        emitLog(socket, ` - Added image "${filename}" (${mimeType}, ${Math.round(fileBuffer.length / 1024)} KB).`, "info", true);
                    } else {
                        emitLog(socket, ` - ⚠️ Skipping non-image file "${filename}" (type: ${mimeType}).`, "warn", true);
                    }
                } catch (fileError) {
                    if (fileError.code === "ENOENT") {
                        emitLog(socket, ` - ⚠️ Error: Uploaded file reference not found on server: "${filename}". Skipping.`, "error", true);
                    } else {
                        emitLog(socket, ` - ⚠️ Error processing uploaded file "${filename}": ${fileError.message}`, "error", true);
                    }
                    emitContextLogEntry(socket, "warning", `Image Processing Error: ${filename} - ${fileError.message}`);
                }
            }
            emitLog(socket, `Processed ${imageParts.length} valid image(s) for Gemini input.`, "info", true);
        }

        // --- Prepare Gemini Chat Session ---
        let chatSession;
        let initialMessageParts = [];
        let contextChangesToSend = []; // Holds context items for the client UI

        const tools = getToolsDefinition(BASE_DIR);
        const toolConfig = { functionCallingConfig: { mode: "ANY" } }; // Force function calling

        // Case 1: Continue IN-MEMORY session (highest priority if available)
        if (continueContext && activeChatSessions.has(socket.id)) {
            chatSession = activeChatSessions.get(socket.id);
            emitLog(socket, "🔄 Continuing previous active chat session (in-memory).", "info", true);
            // Construct message for continuing task
            initialMessageParts = [{ text: `User Request (Continue Task): "${userPrompt}"` }, ...imageParts];
            currentOriginalPromptRef.value = userPrompt; // Update ref with the new prompt for this segment
            // Retrieve saved state for context display, even if using in-memory session
            const savedState = taskStates.get(BASE_DIR);
            contextChangesToSend = savedState?.changes || []; // Show context from last saved state
            emitContextLogEntry(socket, "resume_prompt", `Continuing Task...`);

        // Case 2: Resume from SAVED STATE (if no in-memory session but continueContext is true)
        } else if (continueContext && taskStates.has(BASE_DIR)) {
            const savedState = taskStates.get(BASE_DIR);
            currentOriginalPromptRef.value = savedState.originalPrompt; // Use original prompt for state continuity
            contextChangesToSend = savedState.changes || []; // Load history for client UI

            const changesSummary = contextChangesToSend.length > 0
                 ? contextChangesToSend.map(c => `- ${c.type}: ${c.filePath || c.directoryPath || `${c.sourcePath} -> ${c.destinationPath}` || "Unknown Change"}`).join("\n")
                 : "(None recorded)";

            // Construct a preamble explaining the resume context to Gemini
             const resumePreamble = `You are resuming a previous task for the base directory "${BASE_DIR}".\n**Original User Request:** "${savedState.originalPrompt}"\n**Previously Applied Changes:**\n${changesSummary}\n---\n**Current User Request (Continue Task):** "${userPrompt}"\n---\nAnalyze the current request in the context of the original goal and previous changes, then proceed using function calls. Remember to call "task_finished" when done.`;

            emitLog(socket, `🔄 Resuming task from saved state for ${BASE_DIR}. Original Goal: "${savedState.originalPrompt}"`, "info", true);
            if (changesSummary !== "(None recorded)") {
                emitLog(socket, `ℹ️ Previous changes loaded:\n${changesSummary}`, "info", true);
            }
             emitContextLogEntry(socket, "resume_prompt", `Resuming Task (Original: ${savedState.originalPrompt.substring(0, 50)}...)`);

            // Clear any lingering in-memory session if resuming from saved state
            if (activeChatSessions.has(socket.id)) {
                emitLog(socket, "🧹 Clearing previous in-memory session before resuming from saved state.", "debug");
                activeChatSessions.delete(socket.id);
            }

            // Start a *new* chat session for the resume, but provide context in the first message
            chatSession = model.startChat({ tools: [tools], toolConfig: toolConfig, history: [] }); // Start fresh history for API
            activeChatSessions.set(socket.id, chatSession); // Store new session
            initialMessageParts = [{ text: resumePreamble }, ...imageParts]; // Send resume preamble + images

        // Case 3: Start a NEW task
        } else {
            currentOriginalPromptRef.value = userPrompt; // This is the original prompt for this new task
            contextChangesToSend = []; // No previous context to send

            // Build system prompt and initial user message parts
            const { coreRoleText, structureContextText, toolsInfoText, rulesAndProcessText } = buildInitialPrompt(BASE_DIR, structureString);
            const initialUserRequestText = `**Begin Task Execution for User Request:**\n"${userPrompt}"`;

            // Clear any old session and state if not continuing
            if (activeChatSessions.has(socket.id)) {
                emitLog(socket, "🧹 Starting new task, clearing previous in-memory session.", "debug");
                activeChatSessions.delete(socket.id);
            }
            if (!continueContext && taskStates.has(BASE_DIR)) {
                emitLog(socket, `🗑️ Clearing saved state for ${BASE_DIR} as "Continue Context" is unchecked.`, "info", true);
                taskStates.delete(BASE_DIR);
                 emitContextLogEntry(socket, "initial_state", "Cleared previous saved state.");
            }

            emitLog(socket, "✨ Starting new chat session.", "info", true);
            // Start chat with system instructions and tool/structure context
            chatSession = model.startChat({
                tools: [tools],
                toolConfig: toolConfig,
                systemInstruction: { role: "system", parts: [{ text: coreRoleText + "\n\n" + rulesAndProcessText }] },
                history: [
                    // Provide structure and tools as initial user message for context
                    { role: "user", parts: [{ text: structureContextText + "\n\n" + toolsInfoText }] },
                    // Optional: Add an empty model response to pair with the initial user message?
                    // { role: "model", parts: [{ text: "Understood. Ready for your request."}]}
                ]
            });
            activeChatSessions.set(socket.id, chatSession); // Store the new session
            initialMessageParts = [{ text: initialUserRequestText }, ...imageParts]; // First message is the actual request
        }

        // Send initial context update to the client UI (if any changes were loaded)
        if (contextChangesToSend.length > 0) {
            emitLog(socket, `📊 Sending initial context state to client (changes: ${contextChangesToSend.length})`, "info", true);
            // Use emitFullContextUpdate which expects an array
            emitFullContextUpdate(socket, contextChangesToSend);
        }

        // --- Final Checks and Start Task Runner ---
        if (!chatSession) {
             // This should not happen if logic above is correct
             throw new Error("Internal error: Chat session was not initialized.");
        }
        if (!initialMessageParts || initialMessageParts.length === 0) {
            // Should not happen if prompt or images exist
            throw new Error("Internal error: Failed to construct initial message for Gemini (empty prompt/images).");
        }

        // Create handlers context, including the reference to the *current* changesLog array
        const handlerContext = {
            socket,
            BASE_DIR,
            confirmAllRef, // Pass the ref itself
            feedbackResolverRef,
            questionResolverRef,
            changesLog: currentChangesLogRef.value // Pass the array itself for handlers to modify
        };
        const fileSystemHandlers = createFileSystemHandlers(handlerContext, currentChangesLogRef.value); // Pass array explicitly

        // Create context for the task runner
        const taskContext = {
            socket,
            BASE_DIR,
            messageToSend: initialMessageParts,
            chatSession,
            functionHandlers: fileSystemHandlers,
            confirmAllRef, // Pass refs
            feedbackResolverRef,
            questionResolverRef,
            temperature,
            currentChangesLog: currentChangesLogRef.value, // Pass the array itself
            originalPromptForState: currentOriginalPromptRef.value, // Pass the specific prompt for this run"s state
            retryDelay: parseInt(process.env.GEMINI_RETRY_DELAY || "120000", 10), // Configurable retry delay
            toolConfig: toolConfig
        };

        // Run the task
        // No await here, let it run in the background
        runGeminiTask(taskContext, state);
        // Signal client that task is running
        socket.emit("task-running"); // Add this signal

    } catch (error) {
        // --- Error Handling for Setup Phase ---
        const targetDir = currentBaseDirRef.value || relativeBaseDir || "(unknown)";
        let userMessage = `Error preparing task: ${error.message}`;

        // Provide more specific user messages for common errors
        if (error.code === "ENOENT" && (error.path === BASE_DIR || error.syscall === "stat")) {
             userMessage = `Base directory not found or inaccessible: ${targetDir}`;
        } else if (error.code === "EACCES") {
             userMessage = `Permission denied when accessing base directory or its contents: ${targetDir}`;
        } else if (error.message.includes("not a directory")) {
            userMessage = `Specified base path is not a directory: ${targetDir}`;
        }

        emitLog(socket, `❌ Error during task setup for ${targetDir}: ${error.message}`, "error", true);
        console.error(`Task Setup Error for ${targetDir}:`, error); // Log full error server-side
        emitContextLogEntry(socket, "error", `Setup Error: ${userMessage}`);
        socket.emit("task-error", { message: userMessage }); // Send error to client

        // Clean up refs
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        currentChangesLogRef.value = [];
        // Clear potentially half-initialized session
        if (activeChatSessions.has(socket.id)) {
             activeChatSessions.delete(socket.id);
             console.log(`🧹 Cleared active chat session for ${socket.id} due to setup error.`);
        }
    }
}
