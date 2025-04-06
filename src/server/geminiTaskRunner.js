const { emitLog, emitContextLogEntry } = require("./utils");
const { saveCurrentTaskState } = require("./socketListeners");
const { buildInitialPrompt } = require("./taskSetup"); // Assuming taskSetup exports this

// Custom error for persistent API issues
class PersistentInternalServerError extends Error {
    constructor(message) {
        super(message);
        this.name = "PersistentInternalServerError";
    }
}

async function sendMessageWithRetry(chatSession, message, socket, generationConfig, toolConfig, maxRetries = 3, delay = 120000) {
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        lastError = null; // Reset last error for this attempt
        try {
            // Ensure message is in the correct format (array of parts)
            const messageToSend = Array.isArray(message) ? message : [{ text: message }];

            // Log the attempt before sending
            // emitLog(socket, `Attempt ${attempt + 1}/${maxRetries}: Sending message to Gemini...`, "debug");

            const result = await chatSession.sendMessage(messageToSend);

            // Basic validation of the result structure
            if (!result || !result.response) {
                throw new Error("API returned empty result or response.");
            }

            emitLog(socket, ` 💬 Gemini responded (Attempt ${attempt + 1})`, "debug");
            return result; // Success

        } catch (error) {
            lastError = error;
            const errorMessage = error.message || String(error);
            // Try to extract status code robustly
            const statusCode = error.httpStatusCode || error.status || error.code ||
                               (error.error && error.error.code) ||
                               (error.cause && error.cause.status) ||
                               (error.response && error.response.status);

            console.error(`API Error (Attempt ${attempt + 1}/${maxRetries}, Status: ${statusCode || 'N/A'}): ${errorMessage}`);

            const isBadRequestJsonError = statusCode === 400 && errorMessage.toLowerCase().includes("invalid json payload");
            const isRateLimitError = statusCode === 429 || errorMessage.toLowerCase().includes("rate limit") || errorMessage.toLowerCase().includes("resource exhausted") || errorMessage.toLowerCase().includes("quota");
            const isInternalOrUnavailable = statusCode === 500 || statusCode === 503;
            const isOverloadedError = statusCode === 429 && errorMessage.toLowerCase().includes("model is overloaded"); // More specific 429

            // Specific handling for non-retryable errors
            if (isBadRequestJsonError) {
                emitLog(socket, `🚨 API Bad Request Error (Status: 400): ${errorMessage}. Cannot retry. Check payload structure.`, "error", true);
                emitContextLogEntry(socket, { type: 'error', text: `API Bad Request: ${errorMessage}` }); // Updated context log
                throw new Error(`API Error: Bad Request (400) - Invalid JSON Payload. Details: ${errorMessage}`);
            }

            // Determine if retry is appropriate
            const shouldRetry = (isRateLimitError || isOverloadedError || isInternalOrUnavailable);

            if (shouldRetry && attempt < maxRetries - 1) {
                const errorType = isRateLimitError ? (isOverloadedError ? "Overloaded" : "Rate Limit/Quota") : "Internal Server/Unavailable";
                const retryDelaySec = Math.round(delay / 1000);
                emitLog(socket, `🚦 API ${errorType} Error (Status: ${statusCode || 'N/A'}). Retrying in ${retryDelaySec}s... (Attempt ${attempt + 1}/${maxRetries})`, "warn", true);
                emitContextLogEntry(socket, { type: 'api_retry', text: `API Error (${errorType}). Retrying (${attempt + 1}).` }); // Updated context log
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Exponential backoff
            } else if (attempt >= maxRetries - 1) {
                // Max retries reached
                emitLog(socket, `🚨 API call failed after ${attempt + 1} attempt(s). Last Status: ${statusCode || 'N/A'}, Last Error: ${errorMessage}`, "error", true);
                break; // Exit loop, will throw based on lastError below
            } else {
                // Error is not retryable
                emitLog(socket, `🚨 Unretryable API Error encountered (Status: ${statusCode || 'N/A'}): ${errorMessage}`, "error", true);
                throw lastError; // Throw immediately
            }
        }
    }

    // If loop finished due to max retries, handle the last error
    if (lastError) {
        const lastErrorMessage = lastError.message || String(lastError);
        const lastStatusCode = lastError.httpStatusCode || lastError.status || lastError.code ||
                               (lastError.error && lastError.error.code) ||
                               (lastError.cause && lastError.cause.status) ||
                               (lastError.response && lastError.response.status);

        if (lastStatusCode === 500) {
            // Specific handling for persistent 500 errors
            emitLog(socket, `🧱 Persistent API Error (Status: 500) after ${maxRetries} attempts. Will signal for potential auto-continuation. (Message: ${lastErrorMessage})`, "warn", true);
            emitContextLogEntry(socket, { type: 'error', text: `API Error: Persistent 500 after retries.` }); // Updated context log
            throw new PersistentInternalServerError(`API Error: Persistent 500 after ${maxRetries} attempts. (Details: ${lastErrorMessage})`);
        } else {
            // General unrecoverable error after retries
            emitLog(socket, `🚨 Unrecoverable API Error after ${maxRetries} attempts (Status: ${lastStatusCode || 'N/A'}): ${lastErrorMessage}`, "error", true);
            emitContextLogEntry(socket, { type: 'error', text: `API Error: ${lastErrorMessage}` }); // Updated context log
            throw new Error(`API Error: ${lastErrorMessage} (Status: ${lastStatusCode || 'N/A'}) after ${maxRetries} attempts.`);
        }
    }
    // Should not be reached if logic is correct, but acts as a safeguard
    throw new Error("sendMessageWithRetry finished unexpectedly without success or error.");
}


async function runGeminiTask(context, state) {
    const {
        socket, BASE_DIR, messageToSend, chatSession, functionHandlers,
        confirmAllRef, feedbackResolverRef, questionResolverRef,
        temperature, originalPromptForState, retryDelay = 120000, toolConfig
    } = context;
    const { taskStates } = state;

    emitLog(socket, `🚀 Starting Gemini task execution loop (Base: ${BASE_DIR}, Temp: ${temperature}, ToolMode: ${toolConfig?.functionCallingConfig?.mode})`, "info", true);
    const generationConfig = { temperature: temperature };
    emitLog(socket, `Generation Config: ${JSON.stringify(generationConfig)}`, "debug");

    let nextMessageToSend = messageToSend;
    let taskFinishedSignalled = false;
    let isAutoContinuing = false;

    try {
        while (true) {
            if (taskFinishedSignalled) break; // Exit loop if task finished signal received

            if (socket.disconnected) {
                emitLog(socket, "🛑 User disconnected, aborting task.", "warn", true);
                emitContextLogEntry(socket, { type: 'disconnect', text: 'Task aborted due to disconnect.' }); // Updated context log
                break;
            }

            if (!nextMessageToSend) {
                emitLog(socket, "⚠️ Internal Warning: nextMessageToSend is null, breaking loop.", "warn", true);
                emitContextLogEntry(socket, { type: 'error', text: 'Internal loop error.' }); // Updated context log
                socket.emit("task-error", { message: "Internal error: No further actions from Gemini.", originalPromptForState: originalPromptForState });
                break;
            }

            emitLog(socket, "🤖 Sending request to Gemini...", "gemini-req"); // Not a bubble
            let result;
            try {
                result = await sendMessageWithRetry(
                    chatSession,
                    nextMessageToSend,
                    socket,
                    generationConfig,
                    toolConfig,
                    3, // Max retries
                    retryDelay
                );
                nextMessageToSend = null; // Clear the message to send for the next iteration unless set otherwise
                if (isAutoContinuing) {
                    emitLog(socket, `✅ Auto-continuation attempt succeeded. Resuming normal operation.`, "info", true);
                    isAutoContinuing = false; // Reset flag after successful continuation
                }
            } catch (apiError) {
                if (apiError instanceof PersistentInternalServerError && !isAutoContinuing) {
                    // Attempt auto-continuation on persistent 500
                    emitLog(socket, `🔄 Detected Persistent 500 Error. Attempting automatic continuation (1 try)...`, "info", true);
                    emitContextLogEntry(socket, { type: 'api_retry', text: 'Persistent 500. Attempting auto-resume.' }); // Updated context log
                    isAutoContinuing = true;

                    if (!context.originalPromptForState) {
                        emitLog(socket, `⚠️ Cannot save state for auto-resume: Original prompt reference missing. Aborting task.`, "error", true);
                        socket.emit("task-error", { message: `Failed to auto-resume: Internal state error (missing original prompt). Details: ${apiError.message}`, originalPromptForState: context.originalPromptForState });
                        break;
                    }

                    saveCurrentTaskState(socket, state); // Save the current state before attempting resume

                    const savedState = taskStates.get(BASE_DIR);
                    if (!savedState || !savedState.originalPrompt) {
                        emitLog(socket, `⚠️ Cannot auto-resume: Failed to retrieve valid saved state for ${BASE_DIR} after saving. Aborting task.`, "error", true);
                        socket.emit("task-error", { message: `Failed to auto-resume: Internal state error (cannot retrieve valid saved state). Details: ${apiError.message}`, originalPromptForState: context.originalPromptForState });
                        break;
                    }

                    // Construct the resume message
                    const contextChangesToSend = savedState.changes || [];
                    const changesSummary = contextChangesToSend.length > 0
                        ? contextChangesToSend.map(c => `- ${c.type}: ${c.filePath || c.directoryPath || `${c.sourcePath} -> ${c.destinationPath}`}`).join("\n")
                        : "(None recorded)";
                    const resumePreambleText = `You previously encountered a persistent server error (500). You are resuming the task for the base directory '${BASE_DIR}'. **Original User Request:** "${savedState.originalPrompt}" **Previously Applied Changes (Context):** ${changesSummary} --- **Continue executing the original request based on the context above.** Analyze the original goal and previous changes, then proceed using function calls. Remember to call 'task_finished' when done.`;
                    emitLog(socket, `📄 Constructed resume preamble for auto-continuation.`, "debug"); // Not a bubble
                    nextMessageToSend = [{ text: resumePreambleText }];
                    continue; // Skip to the next loop iteration to send the resume message

                } else {
                    // Unrecoverable API error or auto-continuation failed
                    const failureReason = isAutoContinuing ? "Auto-continuation attempt failed" : "Failed to communicate with Gemini API";
                    emitLog(socket, `❌ ${failureReason}. Stopping task. Error: ${apiError.message}`, "error", true);
                    socket.emit("task-error", { message: `${failureReason}: ${apiError.message}`, originalPromptForState: context.originalPromptForState });
                    break; // Stop the task
                }
            }

            // Process the successful response
            const response = result.response;
            let responseText = "";
            let functionCalls = null;

            try {
                // Safely access functionCalls and text
                if (response && typeof response.functionCalls === "function") {
                    functionCalls = response.functionCalls();
                }
                if (response && typeof response.text === "function") {
                    responseText = response.text() ?? ""; // Use nullish coalescing for safety
                }
            } catch (processingError) {
                emitLog(socket, `🚨 Error processing Gemini response content: ${processingError}`, "error", true);
                try {
                    // Attempt fallback extraction if primary methods fail
                    responseText = response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(Could not extract response text)';
                } catch (fallbackError) {
                    // Ignore fallback error, responseText remains default
                }
                emitLog(socket, `💬 Gemini Raw Response Text (on error): ${responseText}`, "gemini-resp"); // Not a bubble
                emitContextLogEntry(socket, { type: 'error', text: `Response Processing Error: ${processingError.message}` }); // Updated context log
                socket.emit("task-error", { message: `Error processing Gemini's response: ${processingError.message}`, originalPromptForState: originalPromptForState });
                break; // Stop the task
            }

            // Handle function calls if present
            if (functionCalls && functionCalls.length > 0) {
                emitLog(socket, `⚙️ Gemini wants to call ${functionCalls.length} function(s):`, "func-call"); // Not a bubble
                const functionResponses = [];

                for (const call of functionCalls) {
                    // Check for pending user input BEFORE executing the function call
                    if (feedbackResolverRef?.value || questionResolverRef?.value) {
                        const pendingType = feedbackResolverRef?.value ? "feedback" : "question";
                        emitLog(socket, `🛑 Halting function execution sequence due to pending user input (${pendingType}). Saving state before stopping.`, "warn", true);
                        emitContextLogEntry(socket, { type: 'user_wait', text: `Waiting for user ${pendingType}` }); // Updated context log
                        saveCurrentTaskState(socket, state); // Save state before halting
                        taskFinishedSignalled = true; // Signal to break outer loop cleanly
                        socket.emit("task-error", { message: `Task interrupted waiting for user ${pendingType}. Context saved. Restart with 'Continue Context' if needed.`, originalPromptForState });
                        break; // Break inner function call loop
                    }

                    if (socket.disconnected) {
                        taskFinishedSignalled = true; // Signal to break outer loop
                        break; // Break inner loop
                    }

                    const functionName = call.name;
                    const args = call.args || {};
                    emitLog(socket, ` - Calling: ${functionName}(${JSON.stringify(args)})`, "func-call"); // Log the call itself

                    const handler = functionHandlers[functionName];
                    if (!handler) {
                        emitLog(socket, ` ⚠️ Function handler not found: ${functionName}. Skipping.`, "warn", true); // Make this a bubble
                        functionResponses.push({ functionName: functionName, response: { error: `Function handler '${functionName}' not found.` } });
                        continue; // Skip to next function call
                    }

                    try {
                        const functionResult = await handler(args);
                        emitLog(socket, ` ✔️ Result [${functionName}]: ${JSON.stringify(functionResult)}`, "func-result"); // Log the result

                        // Check specifically for task_finished signal
                        if (functionName === "task_finished" && functionResult?.finished) {
                            emitLog(socket, `🏁 Gemini requested task finish: ${functionResult.message}`, "success", true);
                            emitContextLogEntry(socket, { type: 'task_finished', text: `Finished: ${functionResult.message}` }); // Updated context log
                            socket.emit("task-complete", { message: functionResult.message || "Task marked finished by Gemini.", originalPromptForState: originalPromptForState });
                            taskFinishedSignalled = true; // Signal outer loop to break
                            functionResponses.length = 0; // Clear responses as task is ending
                            break; // Break inner function call loop
                        }
                        // Add successful result to responses
                        functionResponses.push({ functionName: functionName, response: functionResult });

                    } catch (execError) {
                        emitLog(socket, ` ❌ CRITICAL Error executing function ${functionName}: ${execError}`, "error", true);
                        console.error(`Execution error for ${functionName}:`, execError);
                        emitContextLogEntry(socket, { type: 'error', text: `Exec Error (${functionName}): ${execError.message}` }); // Updated context log
                        // Provide error feedback to Gemini
                        functionResponses.push({ functionName: functionName, response: { error: `Internal server error during execution: ${execError.message}` } });
                        // Decide if we should stop the whole task on function execution error?
                        // For now, we continue and let Gemini decide based on the error response.
                    }
                } // End of function call loop

                if (taskFinishedSignalled) break; // Break outer loop if signalled

                // Send responses back to Gemini if any were generated and task not finished
                if (functionResponses.length > 0) {
                    emitLog(socket, "🤖 Preparing function results to send back...", "debug"); // Not a bubble
                    const functionResponseParts = functionResponses.map(fr => ({
                        functionResponse: { name: fr.functionName, response: fr.response }
                    }));
                    nextMessageToSend = functionResponseParts;
                    continue; // Continue outer loop to send function responses
                } else if (!socket.disconnected && !taskFinishedSignalled) {
                    // If loop finished without responses and wasn't due to disconnect or task finished signal
                     emitLog(socket, "🤔 No function responses generated or execution halted unexpectedly.", "info", true);
                     socket.emit("task-error", { message: "Task halted: Function calls resulted in no actionable response.", originalPromptForState });
                     emitContextLogEntry(socket, { type: 'error', text: 'Function call sequence failed or halted.' }); // Updated context log
                     break; // Stop the task
                 }

            } else if (responseText) {
                // Handle unexpected text response when function calling is expected
                emitLog(socket, "⚠️ Gemini returned TEXT response unexpectedly (ToolMode is ANY):", "warn", true);
                emitLog(socket, responseText, "gemini-resp"); // Log the text itself (not bubble)
                emitContextLogEntry(socket, { type: 'warning', text: `Unexpected text response: ${responseText.substring(0, 50)}...` }); // Updated context log
                // Treat unexpected text as completion, but log it clearly
                socket.emit("task-complete", { message: "Gemini provided unexpected final text.", finalResponse: responseText, originalPromptForState: originalPromptForState });
                break; // Stop the task

            } else {
                // Gemini finished without function calls or text
                emitLog(socket, "🤔 Gemini finished without providing text or function calls.", "warn", true);
                emitContextLogEntry(socket, { type: 'task_finished', text: 'Finished (No further action)' }); // Updated context log
                socket.emit("task-complete", { message: "Task finished: Gemini completed without further actions or text.", originalPromptForState: originalPromptForState });
                break; // Stop the task
            }
        } // End of while loop
    } catch (error) {
        // Catch errors originating from the loop itself or sendMessageWithRetry
        emitLog(socket, `💥 An unexpected error occurred during the task execution loop: ${error}`, "error", true);
        console.error("Gemini Task Runner Error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        emitContextLogEntry(socket, { type: 'error', text: `Runner Error: ${errorMessage}` }); // Updated context log
        socket.emit("task-error", { message: `An unexpected error occurred: ${errorMessage}`, originalPromptForState: context.originalPromptForState });
    } finally {
        // Cleanup: Ensure any pending resolvers are cleared if the task loop exits
        if (feedbackResolverRef?.value) {
            emitLog(socket, `🧹 Clearing pending feedback resolver in finally block for ${socket.id} (task ended).`, "warn"); // Not a bubble
            if (typeof feedbackResolverRef.value === "function") {
                feedbackResolverRef.value("task-end"); // Notify resolver the task ended
            }
            feedbackResolverRef.value = null;
        }
        if (questionResolverRef?.value) {
            emitLog(socket, `🧹 Clearing pending question resolver in finally block for ${socket.id} (task ended).`, "warn"); // Not a bubble
            if (typeof questionResolverRef.value === "function") {
                questionResolverRef.value("task-end"); // Notify resolver the task ended
            }
            questionResolverRef.value = null;
        }
        emitLog(socket, "🏁 Task execution loop finished.", "info", true);
    }
}

module.exports = { runGeminiTask };