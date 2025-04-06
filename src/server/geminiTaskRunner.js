// src/server/geminiTaskRunner.js
const { emitLog, emitContextLog } = require('./utils');
// Import necessary functions/objects
const { saveCurrentTaskState } = require('./socketListeners');
const { buildInitialPrompt } = require('./taskSetup'); // Assuming this is exported or available

// --- NEW Custom Error ---
class PersistentInternalServerError extends Error {
    constructor(message) {
        super(message);
        this.name = "PersistentInternalServerError";
    }
}
// ---

async function sendMessageWithRetry(chatSession, message, socket, generationConfig, toolConfig, maxRetries = 3, delay = 120000) {
    let lastError = null; // Keep track of the last error encountered

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        lastError = null; // Reset last error for this attempt
        try {
            const messageToSend = Array.isArray(message) ? message : [{ text: message }];
            const result = await chatSession.sendMessage(messageToSend);
            if (!result || !result.response) {
                throw new Error("API returned empty result or response.");
            }
            emitLog(socket, ` 💬 Gemini responded (Attempt ${attempt + 1})`, 'debug');
            return result; // Success
        } catch (error) {
            lastError = error; // Store the error
            const errorMessage = error.message || String(error);
            const statusCode = error.httpStatusCode || error.status || error.code || (error.error && error.error.code) || (error.cause && error.cause.status) || (error.response && error.response.status);

            const isBadRequestJsonError = statusCode === 400 && errorMessage.toLowerCase().includes('invalid json payload');
            const isRateLimitError = statusCode === 429 || errorMessage.toLowerCase().includes('rate limit') || errorMessage.toLowerCase().includes('resource exhausted') || errorMessage.toLowerCase().includes('quota');
            const isInternalOrUnavailable = statusCode === 500 || statusCode === 503; // Group 500 and 503 for retry
            const isOverloadedError = statusCode === 429 && errorMessage.toLowerCase().includes('model is overloaded');

            if (isBadRequestJsonError) {
                emitLog(socket, `🚨 API Bad Request Error (Status: 400): ${errorMessage}. Cannot retry. Check payload structure.`, 'error');
                emitContextLog(socket, 'error', `API Bad Request: ${errorMessage}`);
                throw new Error(`API Error: Bad Request (400) - Invalid JSON Payload. Details: ${errorMessage}`);
            }

            // Retry on Rate Limit, Overload, 500, or 503 if more attempts are left
            const shouldRetry = (isRateLimitError || isOverloadedError || isInternalOrUnavailable);

            if (shouldRetry && attempt < maxRetries - 1) {
                const errorType = isRateLimitError ? (isOverloadedError ? 'Overloaded' : 'Rate Limit/Quota') : 'Internal Server/Unavailable';
                const retryDelaySec = Math.round(delay / 1000);
                emitLog(socket, `🚦 API ${errorType} Error (Status: ${statusCode || 'N/A'}). Retrying in ${retryDelaySec}s... (Attempt ${attempt + 1}/${maxRetries})`, 'warn');
                emitContextLog(socket, 'api_retry', `API Error (${errorType}). Retrying (${attempt+1}).`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5;
            } else if (attempt >= maxRetries - 1) {
                // This is the final attempt or an unretryable error occurred earlier
                emitLog(socket, `🚨 API call failed after ${attempt + 1} attempt(s). Last Status: ${statusCode || 'N/A'}, Last Error: ${errorMessage}`, 'error');
                break; // Exit the retry loop, will use lastError below
            } else {
                 // Unretryable error before exhausting retries (e.g., 403, 404)
                 emitLog(socket, `🚨 Unretryable API Error encountered (Status: ${statusCode || 'N/A'}): ${errorMessage}`, 'error');
                 throw lastError; // Re-throw the original unretryable error
            }
        }
    } // End retry loop

    // After the loop, check the outcome based on lastError
    if (lastError) {
        const lastErrorMessage = lastError.message || String(lastError);
        const lastStatusCode = lastError.httpStatusCode || lastError.status || lastError.code || (lastError.error && lastError.error.code) || (lastError.cause && lastError.cause.status) || (lastError.response && lastError.response.status);

        // --- Check if the FINAL failure was a 500 ---
        if (lastStatusCode === 500) {
            emitLog(socket, `🧱 Persistent API Error (Status: 500) after ${maxRetries} attempts. Will signal for potential auto-continuation. (Message: ${lastErrorMessage})`, 'warn');
            emitContextLog(socket, 'error', `API Error: Persistent 500 after retries.`);
            // Throw the specific error to be caught by runGeminiTask
            throw new PersistentInternalServerError(`API Error: Persistent 500 after ${maxRetries} attempts. (Details: ${lastErrorMessage})`);
        } else {
            // Throw a generic error for other persistent failures (e.g., 429, 503 after retries)
             emitLog(socket, `🚨 Unrecoverable API Error after ${maxRetries} attempts (Status: ${lastStatusCode || 'N/A'}): ${lastErrorMessage}`, 'error');
             emitContextLog(socket, 'error', `API Error: ${lastErrorMessage}`);
             throw new Error(`API Error: ${lastErrorMessage} (Status: ${lastStatusCode || 'N/A'}) after ${maxRetries} attempts.`);
        }
        // ---
    }

    // Should only be reached if sendMessage succeeded within the loop
    throw new Error('sendMessageWithRetry finished unexpectedly without success or error.');
}


async function runGeminiTask(context, state) { // Pass 'state'
    const { socket, BASE_DIR, messageToSend, chatSession, functionHandlers, confirmAllRef, feedbackResolverRef, questionResolverRef, temperature, originalPromptForState, retryDelay = 120000, toolConfig } = context;
    const { taskStates } = state; // Destructure taskStates

    emitLog(socket, `🚀 Starting Gemini task execution loop (Base: ${BASE_DIR}, Temp: ${temperature}, ToolMode: ${toolConfig?.functionCallingConfig?.mode})`, 'info');
    // ... (generationConfig setup) ...
    const generationConfig = { temperature: temperature, };
    emitLog(socket, `Generation Config: ${JSON.stringify(generationConfig)}`, 'debug');

    let nextMessageToSend = messageToSend;
    let taskFinishedSignalled = false;
    // --- Flag for auto-continuation attempt ---
    let isAutoContinuing = false;
    // ---

    try {
        while (true) {
            // ... (standard checks for taskFinished, disconnect, nextMessageToSend) ...
             if (taskFinishedSignalled) break;
             if (socket.disconnected) {
                 emitLog(socket, "🛑 User disconnected, aborting task.", 'warn');
                 emitContextLog(socket, 'disconnect', 'Task aborted due to disconnect.');
                 break;
             }
             if (!nextMessageToSend) {
                 emitLog(socket, "⚠️ Internal Warning: nextMessageToSend is null, breaking loop.", 'warn');
                 emitContextLog(socket, 'error', 'Internal loop error.');
                 socket.emit('task-error', { message: "Internal error: No further actions from Gemini.", originalPromptForState: originalPromptForState });
                 break;
             }


            emitLog(socket, "🤖 Sending request to Gemini...", 'gemini-req');
            let result;
            try {
                result = await sendMessageWithRetry(
                    chatSession,
                    nextMessageToSend,
                    socket,
                    generationConfig,
                    toolConfig,
                    3, // Max *standard* retries
                    retryDelay
                );
                nextMessageToSend = null; // Clear message if successful
                 // If an auto-continuation was successful, reset the flag
                 if (isAutoContinuing) {
                    emitLog(socket, `✅ Auto-continuation attempt succeeded. Resuming normal operation.`, 'info');
                    isAutoContinuing = false;
                 }

            } catch (apiError) {
                // --- CATCH BLOCK MODIFIED ---
                if (apiError instanceof PersistentInternalServerError && !isAutoContinuing) {
                    // First time encountering persistent 500 error - attempt auto-continue
                    emitLog(socket, `🔄 Detected Persistent 500 Error. Attempting automatic continuation (1 try)...`, 'info');
                    emitContextLog(socket, 'api_retry', 'Persistent 500. Attempting auto-resume.');

                    // Mark that we are now trying to auto-continue
                    isAutoContinuing = true;

                    // 1. Save the state *before* the error
                    if (!context.originalPromptForState) {
                         emitLog(socket, `⚠️ Cannot save state for auto-resume: Original prompt reference missing. Aborting task.`, 'error');
                         socket.emit('task-error', { message: `Failed to auto-resume: Internal state error (missing original prompt). Details: ${apiError.message}`, originalPromptForState: context.originalPromptForState });
                         break; // Stop the task
                    }
                    saveCurrentTaskState(socket, state); // Pass the overall state object

                    // 2. Retrieve the potentially updated saved state
                    const savedState = taskStates.get(BASE_DIR);
                    if (!savedState || !savedState.originalPrompt) { // Check if state or original prompt is missing
                        emitLog(socket, `⚠️ Cannot auto-resume: Failed to retrieve valid saved state for ${BASE_DIR} after saving. Aborting task.`, 'error');
                        socket.emit('task-error', { message: `Failed to auto-resume: Internal state error (cannot retrieve valid saved state). Details: ${apiError.message}`, originalPromptForState: context.originalPromptForState });
                        break; // Stop the task
                    }

                    // 3. Construct the resume preamble
                    const contextChangesToSend = savedState.changes || [];
                    const changesSummary = contextChangesToSend.length > 0
                        ? contextChangesToSend.map(c => `- ${c.type}: ${c.filePath || c.directoryPath || `${c.sourcePath} -> ${c.destinationPath}`}`).join('\n')
                        : '(None recorded)';

                    // Use the *original* prompt stored in the state
                    const resumePreambleText = `You previously encountered a persistent server error (500). You are resuming the task for the base directory '${BASE_DIR}'.
**Original User Request:** "${savedState.originalPrompt}"
**Previously Applied Changes (Context):**
${changesSummary}
---
**Continue executing the original request based on the context above.** Analyze the original goal and previous changes, then proceed using function calls. Remember to call 'task_finished' when done.`;

                    emitLog(socket, `📄 Constructed resume preamble for auto-continuation.`, 'debug');

                    // 4. Set the next message and continue the loop for the single retry
                    nextMessageToSend = [{ text: resumePreambleText }];
                    continue; // Go to the next iteration of the while loop

                } else {
                    // Handle:
                    // 1. Errors during the auto-continuation phase (isAutoContinuing is true)
                    // 2. Other non-500 persistent errors after retries (e.g., 429)
                    // 3. Initial unretryable errors (e.g., 400, 403, 404)
                    const failureReason = isAutoContinuing ? "Auto-continuation attempt failed" : "Failed to communicate with Gemini API";
                    emitLog(socket, `❌ ${failureReason}. Stopping task. Error: ${apiError.message}`, 'error');
                    socket.emit('task-error', { message: `${failureReason}: ${apiError.message}`, originalPromptForState: context.originalPromptForState });
                    break; // Stop the task definitively
                }
                // --- END CATCH BLOCK MODIFICATION ---
            }

            // ... rest of the loop (processing response, function calls, etc.) remains the same ...
            // Ensure task-complete/error signals from function calls break correctly
            // Ensure function call results set nextMessageToSend and `continue` correctly
            // Handle unexpected text or empty responses correctly

            const response = result.response;
             let responseText = "";
             let functionCalls = null;
             // ...(keep existing response processing logic) ...

              try {
                  if (response && typeof response.functionCalls === 'function') {
                      functionCalls = response.functionCalls();
                  }
                  if (response && typeof response.text === 'function') {
                      responseText = response.text() ?? "";
                  }
              } catch (processingError) {
                  emitLog(socket, `🚨 Error processing Gemini response content: ${processingError}`, 'error');
                  try {
                      responseText = response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(Could not extract response text)';
                  } catch (fallbackError) { }
                  emitLog(socket, `💬 Gemini Raw Response Text (on error): ${responseText}`, 'gemini-resp');
                  emitContextLog(socket, 'error', `Response Processing Error: ${processingError.message}`);
                  socket.emit('task-error', { message: `Error processing Gemini's response: ${processingError.message}`, originalPromptForState: originalPromptForState });
                  break;
              }

              if (functionCalls && functionCalls.length > 0) {
                   // ...(keep existing function call handling, including checks for pending input/disconnect) ...
                   // Crucially, ensure state is saved if halting for user input
                   emitLog(socket, `⚙️ Gemini wants to call ${functionCalls.length} function(s):`, 'func-call');
                   const functionResponses = [];
                   for (const call of functionCalls) {
                       // Check for pending user input or disconnect *before* execution
                       if (feedbackResolverRef?.value || questionResolverRef?.value) {
                           const pendingType = feedbackResolverRef?.value ? 'feedback' : 'question';
                           emitLog(socket, `🛑 Halting function execution sequence due to pending user input (${pendingType}). Saving state before stopping.`, 'warn');
                           emitContextLog(socket, 'user_wait', `Waiting for user ${pendingType}`);
                           saveCurrentTaskState(socket, state); // SAVE STATE HERE
                           taskFinishedSignalled = true; // Signal outer loop to stop
                           socket.emit('task-error', { message: `Task interrupted waiting for user ${pendingType}. Context saved. Restart with 'Continue Context' if needed.`, originalPromptForState });
                           break; // Break inner function call loop
                       }
                       if (socket.disconnected) {
                           taskFinishedSignalled = true; // Ensure outer loop stops
                           break; // Break inner function call loop
                       }

                       const functionName = call.name;
                       const args = call.args || {};
                        // ...(keep log lines for function call)...

                       const handler = functionHandlers[functionName];
                        // ...(keep handler not found logic)...

                       try {
                           const functionResult = await handler(args);
                           // Handle task_finished specifically
                           if (functionName === 'task_finished' && functionResult?.finished) {
                                emitLog(socket, `🏁 Gemini requested task finish: ${functionResult.message}`, 'success');
                                emitContextLog(socket, 'task_finished', `Finished: ${functionResult.message}`);
                                // Let the 'task-complete' listener handle state saving
                                socket.emit('task-complete', { message: functionResult.message || "Task marked finished by Gemini.", originalPromptForState: originalPromptForState });
                                taskFinishedSignalled = true;
                                functionResponses.length = 0; // No need to send responses back
                                break; // Break inner loop
                           }

                           functionResponses.push({ functionName: functionName, response: functionResult });
                            // ...(keep logging for function results/errors)...

                       } catch (execError) {
                           // ...(keep existing handler execution error logging)...
                            emitLog(socket, ` ❌ CRITICAL Error executing function ${functionName}: ${execError}`, 'error');
                            console.error(`Execution error for ${functionName}:`, execError);
                            emitContextLog(socket, 'error', `Exec Error (${functionName}): ${execError.message}`);
                            functionResponses.push({ functionName: functionName, response: { error: `Internal server error during execution: ${execError.message}` } });
                            // Decide if this error should stop the whole task or just this function call
                            // For now, we continue processing other function calls if any
                       }
                   } // End for...of functionCalls loop

                   if (taskFinishedSignalled) break; // Break outer loop if finished or halted

                   // Process function responses if any were generated and task didn't finish/halt
                   if (functionResponses.length > 0) {
                       emitLog(socket, "🤖 Preparing function results to send back...", 'debug');
                       const functionResponseParts = functionResponses.map(fr => ({
                           functionResponse: { name: fr.functionName, response: fr.response }
                       }));
                       nextMessageToSend = functionResponseParts;
                       continue; // Continue the loop to send results back
                   } else if (!socket.disconnected) {
                       // This case means functions were called but produced no usable responses,
                       // or the loop was broken internally without signaling finish/halt properly.
                       // Treat as an error unless taskFinished was signaled.
                       if (!taskFinishedSignalled) {
                          emitLog(socket, "🤔 No function responses generated or execution halted unexpectedly.", 'info');
                          socket.emit('task-error', { message: "Task halted: Function calls resulted in no actionable response.", originalPromptForState });
                          emitContextLog(socket, 'error', 'Function call sequence failed or halted.');
                          break; // Break outer loop
                       }
                       // If taskFinishedSignalled is true, the loop will break anyway
                   }
                   // If socket disconnected, the outer loop's check will handle it

              } else if (responseText) {
                  // ...(keep existing handling for unexpected text response)...
                   emitLog(socket, "⚠️ Gemini returned TEXT response unexpectedly (ToolMode is ANY):", 'warn');
                   emitLog(socket, responseText, 'gemini-resp');
                   emitContextLog(socket, 'warning', `Unexpected text response: ${responseText.substring(0, 50)}...`);
                   socket.emit('task-complete', { message: "Gemini provided unexpected final text.", finalResponse: responseText, originalPromptForState: originalPromptForState });
                   break;
              } else {
                  // ...(keep existing handling for finishing without text/calls)...
                   emitLog(socket, "🤔 Gemini finished without providing text or function calls.", 'warn');
                   emitContextLog(socket, 'task_finished', 'Finished (No further action)');
                   socket.emit('task-complete', { message: "Task finished: Gemini completed without further actions or text.", originalPromptForState: originalPromptForState });
                   break;
              }


        } // End while loop
    } catch (error) {
        // Catch unexpected errors *within* the loop/task runner logic itself
        // This is different from API errors caught inside the loop
        emitLog(socket, `💥 An unexpected error occurred during the task execution loop: ${error}`, 'error');
        console.error("Gemini Task Runner Error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        emitContextLog(socket, 'error', `Runner Error: ${errorMessage}`);
        // Ensure originalPromptForState is passed correctly from context
        socket.emit('task-error', { message: `An unexpected error occurred: ${errorMessage}`, originalPromptForState: context.originalPromptForState });
    } finally {
        // ... (keep existing finally block for cleanup) ...
        if (feedbackResolverRef?.value) {
             emitLog(socket, `🧹 Clearing pending feedback resolver in finally block for ${socket.id} (task ended).`, 'warn');
             if (typeof feedbackResolverRef.value === 'function') {
                 feedbackResolverRef.value('task-end');
             }
             feedbackResolverRef.value = null;
         }
         if (questionResolverRef?.value) {
             emitLog(socket, `🧹 Clearing pending question resolver in finally block for ${socket.id} (task ended).`, 'warn');
             if (typeof questionResolverRef.value === 'function') {
                 questionResolverRef.value('task-end');
             }
             questionResolverRef.value = null;
         }
        emitLog(socket, "🏁 Task execution loop finished.", 'info');
    }
}

module.exports = { runGeminiTask };
