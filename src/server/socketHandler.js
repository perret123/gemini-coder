// src/server/socketHandler.js
const path = require('node:path');
const fs = require('node:fs/promises');
const ignore = require('ignore');
const mime = require('mime-types');
const { emitLog, getDirectoryStructure } = require('./utils');
const { createFileSystemHandlers } = require('./fileSystem');
const { runGeminiTask } = require('./geminiTaskRunner');
const { model, getToolsDefinition } = require('./geminiSetup');

const activeChatSessions = new Map();

function handleSocketConnection(socket, io) {
    console.log(`🔌 User connected: ${socket.id}`);
    emitLog(socket, 'Connected to server.', 'success');

    let confirmAllRef = { value: false };
    let feedbackResolverRef = { value: null };
    let questionResolverRef = { value: null };

    socket.on('start-task', async (data) => {
        console.log(`Received start-task from ${socket.id}:`, data);
        const relativeBaseDir = data.baseDir || '.';
        const userPrompt = data.prompt;
        const continueContext = data.continueContext || false;
        const uploadedFiles = data.uploadedFiles || [];
        const temperature = data.temperature ?? 0.7; // <<< NEW: Get temperature, default if missing

        confirmAllRef.value = false;
        feedbackResolverRef.value = null;
        questionResolverRef.value = null;

        if (!userPrompt) {
            emitLog(socket, "Error: Prompt is missing.", 'error');
            socket.emit('task-error', { message: "Prompt cannot be empty." });
            return;
        }
        if (!relativeBaseDir) {
            emitLog(socket, "Error: Base directory is missing.", 'error');
            socket.emit('task-error', { message: "Base directory cannot be empty." });
            return;
        }

        let BASE_DIR;
        try {
            BASE_DIR = path.resolve(relativeBaseDir);
            emitLog(socket, `Received task. Base directory resolved to: ${BASE_DIR}`, 'info');

            const stats = await fs.stat(BASE_DIR);
            if (!stats.isDirectory()) {
                emitLog(socket, `Error: Base path is not a directory: ${BASE_DIR}`, 'error');
                socket.emit('task-error', { message: `Specified base path is not a directory: ${BASE_DIR}` });
                return;
            }
            emitLog(socket, `Base directory confirmed: ${BASE_DIR}`, 'info');

            const gitignorePath = path.join(BASE_DIR, '.gitignore');
            const ig = ignore();
            try {
                const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
                if (gitignoreContent) {
                    ig.add(gitignoreContent);
                    emitLog(socket, `ℹ️ Applying .gitignore rules from ${path.relative(process.cwd(), gitignorePath) || '.gitignore'}`, 'info');
                } else {
                     emitLog(socket, `ℹ️ Found empty .gitignore at ${path.relative(process.cwd(), gitignorePath) || '.gitignore'}`, 'info');
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    emitLog(socket, `ℹ️ No .gitignore file found at root of base directory (${BASE_DIR}). Listing all non-hidden items.`, 'info');
                } else {
                    emitLog(socket, `⚠️ Error reading .gitignore file: ${error.message}`, 'warn');
                }
            }
            ig.add('.git/');

            emitLog(socket, `Scanning directory structure (max depth 3, respecting .gitignore)...`, 'info');
            let structureLines = [];
            try {
                structureLines = await getDirectoryStructure(BASE_DIR, BASE_DIR, ig, 2);
            } catch (scanError) {
                emitLog(socket, `Error scanning directory structure: ${scanError.message}`, 'error');
                structureLines.push("[Error occurred while scanning directory structure]");
            }
            const structureString = structureLines.join('\\r\\n');
            emitLog(socket, `Directory Structure (filtered):\\r\\n${structureString || '(empty or all ignored)'}`, 'info');


             const imageParts = [];
            if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
                emitLog(socket, `Processing ${uploadedFiles.length} uploaded image file(s)...`, 'info');
                const uploadDir = path.resolve(__dirname, '../../uploads');

                for (const filename of uploadedFiles) {
                    if (filename.includes('..') || filename.includes('/') || filename.includes('\\\\\\')) {
                         emitLog(socket, `  - ⚠️ Skipping potentially unsafe filename '${filename}'.`, 'warn');
                         continue;
                    }
                    const filePath = path.join(uploadDir, filename);
                    try {
                        const fileBuffer = await fs.readFile(filePath);
                        const mimeType = mime.lookup(filePath);
                         if (!mimeType) {
                            emitLog(socket, `  - ⚠️ Could not determine MIME type for '${filename}'. Skipping file.`, 'warn');
                            continue;
                         }
                         if (!mimeType.startsWith('image/')) {
                             emitLog(socket, `  - ⚠️ File '${filename}' is not a supported image type (${mimeType}). Skipping.`, 'warn');
                             continue;
                         }

                        const base64Data = fileBuffer.toString('base64');
                        imageParts.push({
                            inlineData: {
                                data: base64Data,
                                mimeType: mimeType
                            }
                        });
                        emitLog(socket, `  - Added '${filename}' (${mimeType}) to message parts for Gemini.`, 'info');
                    } catch (fileError) {
                        if (fileError.code === 'ENOENT') {
                            emitLog(socket, `  - ⚠️ Error processing uploaded file '${filename}': File not found at expected path ${filePath}. Was it deleted?`, 'warn');
                        } else {
                            emitLog(socket, `  - ⚠️ Error processing uploaded file '${filename}': ${fileError.message}`, 'warn');
                        }
                    }
                }
                 if (imageParts.length > 0) {
                    emitLog(socket, `Successfully prepared ${imageParts.length} image(s) for Gemini.`, 'info');
                 } else {
                    emitLog(socket, `No valid images were processed from the upload list.`, 'info');
                 }
            }


            let chatSession;
            let messageToSend;
            const tools = getToolsDefinition(BASE_DIR);

            if (continueContext && activeChatSessions.has(socket.id)) {
                chatSession = activeChatSessions.get(socket.id);
                emitLog(socket, "🔄 Continuing previous chat context.", 'info');

                const userRequestPart = { text: `User Request: \\"${userPrompt}\\"` };
                messageToSend = [userRequestPart];
                if (imageParts.length > 0) {
                    messageToSend.push(...imageParts);
                }

            } else {
                 const coreRoleText = `You are a precise AI programmer executing file system operations based on user instructions.\\r\\n**Primary Goal:** Modify files and directories within the designated Base Directory according to user instructions.\\r\\n**Base Directory:** '${BASE_DIR}'\\r\\n**Critical Rule:** You MUST operate exclusively using the provided tools and stay strictly within the Base Directory. Use function calls for ALL interactions, including informational messages.`;
                 const structureContextText = `**Current Project File Structure (limited depth, respects .gitignore):**\\r\\n${structureString || '- (Directory is empty or all items are gitignored)'}\\\\r\\n\\n**Note:** This structure may not be exhaustive. Use the 'listFiles' tool if you require more detail about a specific directory\'s contents.`;
                const toolsInfoText = `**Available Tools (Use ONLY these functions, always with relative paths from '${BASE_DIR}'):**\\r\\n* **Informational Output:**\\r\\n*   \`showInformationTextToUser(messageToDisplay)\`: Show a message/update to the user *without* stopping the task. Use this for status or explanations instead of plain text responses.\\r\\n* **File/Directory Reading:**\\r\\n*   \`readFileContent(filePath)\`: Reads the full content of a file.\\r\\n*   \`listFiles(directoryPath)\`: Lists files/subdirs in a directory (defaults to base, respects .gitignore). Use when the provided structure is insufficient.\\r\\n*   \`searchFiles(pattern)\`: Finds files via glob pattern (e.g., 'src*.js'). Respects .gitignore. Do not use '..'.\\r\\n*   \`searchFilesByRegex(regexString, directoryPath)\`: Searches file *content* recursively using a JS regex. Respects .gitignore. Returns path, content, and occurrences for matches.\\r\\n* **File/Directory Writing & Modification:**\\r\\n*   \`writeFileContent(filePath, content)\`: Writes the **entire** content to a file (overwrites existing). Requires user confirmation.\\r\\n*   \`createDirectory(directoryPath)\`: Creates a directory (including parents).\\r\\n*   \`deleteFile(filePath)\`: Deletes a single file (NOT directories). Requires user confirmation.\\r\\n*   \`moveItem(sourcePath, destinationPath)\`: Moves or renames a file OR directory. Requires user confirmation.\\r\\n*   \`deleteDirectory(directoryPath)\`: Deletes a directory recursively. DANGEROUS. Requires confirmation. (Undo NOT fully supported).\\r\\n* **User Interaction:**\\r\\n*   \\\`askUserQuestion(question)\\\`: Ask the user for clarification or required input ONLY when you are blocked, unsure how to proceed, or the request is ambiguous.`;
                const rulesAndProcessText = `**Mandatory Rules & Execution Process:**\\r\\n* **Strict Confinement:** Absolutely NO operations outside the Base Directory ('${BASE_DIR}').\\r\\n* **Relative Paths ONLY:** ALWAYS use relative paths from the Base Directory for all tool arguments (\`filePath\`, \`directoryPath\`, \`sourcePath\`, \`destinationPath\`). NEVER use '..' or absolute paths.\\r\\n* **Function Calls for EVERYTHING:** Interact *exclusively* through the provided function calls. **Crucially: Do NOT output plain text responses unless the *entire* task is complete.** For intermediate status updates, explanations, or observations, use \`showInformationTextToUser\`. Returning plain text prematurely WILL terminate the process.\\r\\n* **Full Content for Writes:** For \`writeFileContent\`, you MUST provide the complete, final source code for the file, not just the changed parts. Also don't add comments like \\"remains unchanged\\" or \\"START new function\\" etc., this will only bloat the diff.\\r\\n* **Confirmation Awareness:** Critical actions (write, delete, move) require user confirmation. The user might reject an action ('no') or approve all subsequent actions for this task ('yes/all'). You will be notified of the outcome. Proceed or adjust your plan accordingly. If rejected, consider using \`askUserQuestion\` if clarification is needed, or explain the situation using \`showInformationTextToUser\` before deciding how to proceed (or stopping if necessary).\\r\\n* **Error Handling:** If a tool call results in an error, use \`showInformationTextToUser\` to report the error, then decide if you can try an alternative approach (call another function) or if you must stop (by providing a final text-only response).\\r\\n* **Tool Limitations:** Remember \`searchFiles\` uses glob patterns, while \`searchFilesByRegex\` uses JavaScript regex for content searching. Use \`listFiles\` for accurate directory contents.\\r\\n* **Execution Flow:**\\r\\n 1. **Analyze:** Understand the user\'s request relative to the Base Directory and initial file structure.\\r\\n 2. **Plan:** Determine the sequence of tool calls required. Use \`showInformationTextToUser\` to outline your plan if it\'s complex.\\r\\n 3. **Explore (If Needed):** Use \`readFileContent\`, \`listFiles\`, \`searchFiles\`, or \`searchFilesByRegex\` judiciously to gather necessary information *before* making changes if the initial context is insufficient. Use \`showInformationTextToUser\` to explain *why* you need more info.\\r\\n 4. **Execute:** Call the planned functions one or more at a time.\\r\\n 5. **Adapt:** React to user confirmations, question answers, or function errors. Use \`showInformationTextToUser\` to explain adaptations. If you need more information, use \`askUserQuestion\` to clarify the user\'s intent.\\r\\n 6. **Intermediate Updates:** Use \`showInformationTextToUser\` frequently for non-trivial tasks to keep the user informed about progress or your reasoning.\\r\\n 7. **Conclude:** Provide a final summary message **as plain text (no function call)** ONLY when the entire task is complete according to the original request, OR if you have encountered an unrecoverable error or user rejection that prevents completion (after explaining why using \`showInformationTextToUser\` if appropriate).`;
                const userRequestText = `**Begin Task Execution for User Request:**\\r\\n\\\\"${userPrompt}\\\\"`;

                if (activeChatSessions.has(socket.id)) {
                    emitLog(socket, "🧹 Starting new task, clearing previous context (as requested).", 'info');
                    activeChatSessions.delete(socket.id);
                } else {
                    emitLog(socket, "✨ Starting new chat context.", 'info');
                }

                chatSession = model.startChat({
                    tools: tools,
                    history: [],
                    // Temperature is set per-request via generationConfig
                });
                activeChatSessions.set(socket.id, chatSession);

                messageToSend = [
                    { text: coreRoleText },
                    { text: structureContextText },
                    { text: toolsInfoText },
                    { text: rulesAndProcessText },
                    { text: userRequestText }
                ];
                 if (imageParts.length > 0) {
                    messageToSend.push(...imageParts);
                }
            }

            if (!messageToSend || (Array.isArray(messageToSend) && messageToSend.length === 0)) {
                 emitLog(socket, "Error: messageToSend is empty after processing parts.", 'error');
                 socket.emit('task-error', { message: "Internal error: Failed to construct message for Gemini." });
                 return;
            }

            const fileSystemHandlers = createFileSystemHandlers({ socket, BASE_DIR, confirmAllRef, feedbackResolverRef, questionResolverRef });

            const taskContext = {
                socket,
                BASE_DIR,
                messageToSend,
                chatSession,
                functionHandlers: fileSystemHandlers,
                confirmAllRef,
                feedbackResolverRef,
                questionResolverRef,
                temperature // <<< NEW: Pass temperature to task runner
            };

            runGeminiTask(taskContext);

        } catch (error) {
             const targetDir = BASE_DIR || relativeBaseDir;
            if (error.code === 'ENOENT' && error.path === BASE_DIR) {
                 emitLog(socket, `Error: Base directory does not exist: ${targetDir}`, 'error');
                 socket.emit('task-error', { message: `Base directory not found: ${targetDir}` });
            } else if (error.code === 'EACCES') {
                 emitLog(socket, `Error: Permission denied accessing base directory: ${targetDir}`, 'error');
                 socket.emit('task-error', { message: `Permission denied for base directory: ${targetDir}` });
            } else {
                emitLog(socket, `Error preparing task for ${targetDir}: ${error.message}`, 'error');
                console.error(`Error preparing task for ${targetDir}:`, error);
                socket.emit('task-error', { message: `Error preparing task: ${error.message}` });
            }
        }
    });

     socket.on('user-feedback', (data) => {
         const decision = data.decision;
         emitLog(socket, `Received user feedback: ${decision}`, 'info');
         if (feedbackResolverRef.value && typeof feedbackResolverRef.value === 'function') {
             feedbackResolverRef.value(decision);
             feedbackResolverRef.value = null;
         } else {
             emitLog(socket, `Warning: Received user feedback '${decision}' but no confirmation was pending.`, 'warn');
         }
     });

     socket.on('user-question-response', (data) => {
         const answer = data.answer;
         emitLog(socket, `Received user question response: ${JSON.stringify(answer)}`, 'info');
         if (questionResolverRef.value && typeof questionResolverRef.value === 'function') {
             questionResolverRef.value(answer);
             questionResolverRef.value = null;
         } else {
             emitLog(socket, `Warning: Received user question response '${JSON.stringify(answer)}' but no question was pending.`, 'warn');
         }
     });


     socket.on('disconnect', () => {
         console.log(`🔌 User disconnected: ${socket.id}`);
         if (activeChatSessions.has(socket.id)) {
             activeChatSessions.delete(socket.id);
             console.log(`🧹 Cleared chat session for disconnected user: ${socket.id}`);
         } else {
             console.log(`ℹ️ No active chat session found for disconnected user: ${socket.id}`);
         }
         if (feedbackResolverRef.value) {
             emitLog(socket, `User disconnected with pending confirmation for ${socket.id}. Cancelling confirmation.`, 'warn');
             if(typeof feedbackResolverRef.value === 'function') {
                 feedbackResolverRef.value('disconnect');
             }
             feedbackResolverRef.value = null;
         }
         if (questionResolverRef.value) {
              emitLog(socket, `User disconnected with pending question for ${socket.id}. Cancelling question.`, 'warn');
             if(typeof questionResolverRef.value === 'function') {
                 questionResolverRef.value('disconnect');
             }
             questionResolverRef.value = null;
         }
     });

     socket.on('error', (err) => {
         console.error(`Socket error for ${socket.id}:`, err);
         emitLog(socket, `Socket error: ${err.message}`, 'error');
         if (feedbackResolverRef.value) {
             if(typeof feedbackResolverRef.value === 'function') {
                 feedbackResolverRef.value('error');
             }
             feedbackResolverRef.value = null;
         }
         if (questionResolverRef.value) {
              emitLog(socket, `Socket error occurred with pending question for ${socket.id}. Cancelling question.`, 'warn');
             if(typeof questionResolverRef.value === 'function') {
                 questionResolverRef.value('error');
             }
             questionResolverRef.value = null;
         }
     });
}

module.exports = { handleSocketConnection };
