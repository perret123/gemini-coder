const { emitLog, emitContextLog } = require('./utils');

// Helper function to send message with retry logic for specific errors
async function sendMessageWithRetry(chatSession, message, socket, generationConfig, toolConfig, maxRetries = 3, delay = 30000) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Send message with generationConfig. ToolConfig is usually set at chat start.
            const result = await chatSession.sendMessage(message /*, { generationConfig } */); // Let SDK handle config inheritance

            if (!result || !result.response) {
                throw new Error("API returned empty result or response.");
            }
            emitLog(socket, ` 💬 Gemini responded (Attempt ${attempt + 1})`, 'debug');
            return result; // Success
        } catch (error) {
            const errorMessage = error.message || String(error);
            // Try to get status code, might be nested differently
             const statusCode = error.httpStatusCode // Older structure?
                             || error.status         // Common structure
                             || error.code           // Sometimes used
                             || (error.error && error.error.code) // Nested structure
                             || (error.cause && error.cause.status) // Node fetch error cause
                             || (error.response && error.response.status); // Axios-like response

             // Check for specific error details if available (like in the 400 Bad Request)
             const isBadRequestJsonError = statusCode === 400 && errorMessage.toLowerCase().includes('invalid json payload');
             const isRateLimitError = statusCode === 429 ||
                                     errorMessage.toLowerCase().includes('rate limit') ||
                                     errorMessage.toLowerCase().includes('resource exhausted') ||
                                     errorMessage.toLowerCase().includes('quota');
            const isInternalError = statusCode === 500 ||
                                    statusCode === 503 ||
                                    errorMessage.toLowerCase().includes('internal server error') ||
                                    errorMessage.toLowerCase().includes('backend error') ||
                                    errorMessage.toLowerCase().includes('service unavailable');
            const isOverloadedError = statusCode === 429 && errorMessage.toLowerCase().includes('model is overloaded'); // Specific 429 type

            // Don't retry on Bad Request JSON errors, as it indicates a structural problem
            if (isBadRequestJsonError) {
                 emitLog(socket, `🚨 API Bad Request Error (Status: 400): ${errorMessage}. Cannot retry. Check payload structure.`, 'error');
                 emitContextLog(socket, 'error', `API Bad Request: ${errorMessage}`);
                 // Rethrow a specific error or the original one
                 throw new Error(`API Error: Bad Request (400) - Invalid JSON Payload. Details: ${errorMessage}`);
            }


            // Retry on rate limits, internal errors, or specific overload errors
            if ((isRateLimitError || isInternalError || isOverloadedError) && attempt < maxRetries - 1) {
                const errorType = isRateLimitError ? (isOverloadedError ? 'Overloaded' : 'Rate Limit/Quota') : 'Internal Server';
                const retryDelaySec = Math.round(delay / 1000);
                emitLog(socket, `🚦 API ${errorType} Error (Status: ${statusCode || 'N/A'}). Retrying in ${retryDelaySec}s... (Attempt ${attempt + 1}/${maxRetries})`, 'warn');
                emitContextLog(socket, 'api_retry', `API Error (${errorType}). Retrying (${attempt+1}).`); // Add context log for retry
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Exponential backoff
            } else {
                // Unrecoverable error or max retries reached
                emitLog(socket, `🚨 Unrecoverable API Error after ${attempt + 1} attempt(s) (Status: ${statusCode || 'N/A'}): ${errorMessage}`, 'error');
                emitContextLog(socket, 'error', `API Error: ${errorMessage}`);
                if (isRateLimitError) {
                    throw new Error(`API Error: Rate limit/quota error persisted after ${maxRetries} attempts. Please wait and try again later. (Details: ${errorMessage})`);
                } else if (isInternalError) {
                    throw new Error(`API Error: Internal server error persisted after ${maxRetries} attempts. Please try again later. (Details: ${errorMessage})`);
                } else {
                     throw new Error(`API Error: ${errorMessage} (Status: ${statusCode || 'N/A'})`); // Throw original or wrapped error
                }
            }
        }
    }
    // Should not be reachable if loop completes, but satisfy TS/lint
    throw new Error('sendMessageWithRetry failed after exhausting all retries.');
}


async function runGeminiTask(context) {
    const {
        socket,
        BASE_DIR,
        messageToSend, // Initial message (can be array of parts)
        chatSession,
        functionHandlers,
        confirmAllRef, // Reference object { value: boolean }
        feedbackResolverRef, // Reference object { value: function | null }
        questionResolverRef, // Reference object { value: function | null }
        temperature,
        originalPromptForState, // The initial user prompt for saving state correctly
        retryDelay = 30000, // Initial retry delay in ms
        toolConfig // Pass the toolConfig for retries if needed
    } = context;

    emitLog(socket, `🚀 Starting Gemini task execution loop (Base: ${BASE_DIR}, Temp: ${temperature}, ToolMode: ${toolConfig?.functionCallingConfig?.mode})`, 'info');

    const generationConfig = {
        temperature: temperature,
    };
    emitLog(socket, `Generation Config: ${JSON.stringify(generationConfig)}`, 'debug');

    let nextMessageToSend = messageToSend; // Start with the initial message/prompt
    let taskFinishedSignalled = false; // Flag to indicate task_finished was called

    try {
        // Main execution loop
        while (true) {
            if (taskFinishedSignalled) break; // Exit if task_finished was called in previous iteration
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
                // Use the retry wrapper
                result = await sendMessageWithRetry(
                    chatSession,
                    nextMessageToSend, // Can be string or array of Parts
                    socket,
                    generationConfig,
                    toolConfig,
                    3, // Max retries
                    retryDelay
                );
                nextMessageToSend = null; // Clear message for next iteration unless set by function response
            } catch (apiError) {
                 socket.emit('task-error', { message: `Failed to communicate with Gemini API: ${apiError.message}`, originalPromptForState: originalPromptForState });
                 break; // Stop execution on API error
            }

            const response = result.response;
            let responseText = "";
            let functionCalls = null;

            // Safely extract response parts
            try {
                if (response && typeof response.functionCalls === 'function') {
                    functionCalls = response.functionCalls(); // Returns array or undefined
                }
                if (response && typeof response.text === 'function') {
                     responseText = response.text() ?? ""; // Get text, default to empty string
                }
            } catch (processingError) {
                 emitLog(socket, `🚨 Error processing Gemini response content: ${processingError}`, 'error');
                 try { responseText = response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(Could not extract response text)'; } catch (fallbackError) { /* Ignore */ }
                 emitLog(socket, `💬 Gemini Raw Response Text (on error): ${responseText}`, 'gemini-resp');
                 emitContextLog(socket, 'error', `Response Processing Error: ${processingError.message}`);
                 socket.emit('task-error', { message: `Error processing Gemini's response: ${processingError.message}`, originalPromptForState: originalPromptForState });
                 break; // Stop on processing error
            }

            // --- Handle Function Calls ---
            if (functionCalls && functionCalls.length > 0) {
                emitLog(socket, `⚙️ Gemini wants to call ${functionCalls.length} function(s):`, 'func-call');

                const functionResponses = []; // Array to hold results for Gemini

                for (const call of functionCalls) {
                    if (feedbackResolverRef?.value || questionResolverRef?.value) {
                        const pendingType = feedbackResolverRef?.value ? 'feedback' : 'question';
                        emitLog(socket, `🛑 Halting function execution sequence due to pending user input (${pendingType}). Will retry after input.`, 'warn');
                        emitContextLog(socket, 'user_wait', `Waiting for user ${pendingType}`);
                        functionResponses.length = 0;
                        nextMessageToSend = null;
                        taskFinishedSignalled = true; // End the task loop prematurely
                        socket.emit('task-error', {message: `Task interrupted waiting for user ${pendingType}. Please restart task if needed.`, originalPromptForState});
                        break; // Break inner loop
                    }
                    if (socket.disconnected) break; // Check disconnect again

                    const functionName = call.name;
                    const args = call.args || {};
                    emitLog(socket, ` L Calling: ${functionName}(${JSON.stringify(args)})`, 'func-call');
                    emitContextLog(socket, 'function_call', `Call: ${functionName}`); // Log function call start

                    const handler = functionHandlers[functionName];
                    if (!handler) {
                        emitLog(socket, ` 🚨 Error: Unknown function "${functionName}" requested.`, 'error');
                        emitContextLog(socket, 'error', `Unknown function: ${functionName}`);
                        // Provide an error response FOR THIS FUNCTION CALL
                        functionResponses.push({
                             functionName: functionName, // Keep track of which call failed
                             response: { error: `Function ${functionName} is not implemented.` }
                         });
                        continue; // Skip to next function call
                    }

                    // Execute the handler
                    try {
                        const functionResult = await handler(args);

                        // --- Special Handling for task_finished ---
                        if (functionName === 'task_finished' && functionResult?.finished) {
                             emitLog(socket, `🏁 Gemini requested task finish: ${functionResult.message}`, 'success');
                             emitContextLog(socket, 'task_finished', `Finished: ${functionResult.message}`);
                             socket.emit('task-complete', {
                                 message: functionResult.message || "Task marked finished by Gemini.",
                                 originalPromptForState: originalPromptForState
                                });
                             taskFinishedSignalled = true; // Set flag to break outer loop
                             functionResponses.length = 0; // Don't send any response back for task_finished
                             break; // Exit the FOR loop over function calls immediately
                        }
                        // --- End Special Handling ---

                        // Store result for sending back (even errors)
                         functionResponses.push({
                            functionName: functionName,
                            response: functionResult // Store the entire result object (could contain success, error, data, etc.)
                         });

                        // Log success/error based on result content
                         if (functionResult && functionResult.error) {
                            if (functionResult.error.toLowerCase().includes('rejected') || functionResult.error.toLowerCase().includes('cancelled')) {
                                 emitLog(socket, `🔶 Function ${functionName} cancelled/rejected by user/system: ${functionResult.error}`, 'warn');
                            } else {
                                 emitLog(socket, `❌ Function ${functionName} failed: ${functionResult.error}`, 'error');
                            }
                         } else if (functionResult && functionResult.success !== undefined) {
                            const resultSummary = JSON.stringify(functionResult)?.substring(0, 150) + (JSON.stringify(functionResult)?.length > 150 ? '...' : '');
                             emitLog(socket, ` ✅ Function ${functionName} executed. Result snippet: ${resultSummary}`, 'func-result');
                         } else {
                             emitLog(socket, ` ⚠️ Function ${functionName} returned unexpected format: ${JSON.stringify(functionResult)}. Treating as success with note.`, 'warn');
                              emitContextLog(socket, 'warning', `Unexpected result from ${functionName}`);
                         }

                    } catch (execError) {
                         emitLog(socket, ` ❌ CRITICAL Error executing function ${functionName}: ${execError}`, 'error');
                         console.error(`Execution error for ${functionName}:`, execError);
                         emitContextLog(socket, 'error', `Exec Error (${functionName}): ${execError.message}`);
                         // Store error result for this function call
                         functionResponses.push({
                            functionName: functionName,
                            response: { error: `Internal server error during execution: ${execError.message}` }
                         });
                    }
                } // End FOR loop over function calls

                if (taskFinishedSignalled) break; // Exit outer loop if task_finished was called

                // If we processed function calls and didn't signal finish, send results back
                if (functionResponses.length > 0) {
                    emitLog(socket, "🤖 Preparing function results to send back...", 'debug');

                    // *** CORRECTED STRUCTURE ***
                    // Create an array of FunctionResponse Parts, one for each result.
                    // This structure aligns with what the Gemini API expects for function responses.
                    const functionResponseParts = functionResponses.map(fr => ({
                        functionResponse: {
                            name: fr.functionName, // The name of the function that was called
                            response: fr.response   // The actual result object returned by the handler
                        }
                    }));

                    // Set this array of parts to be sent in the next iteration
                    nextMessageToSend = functionResponseParts; // Send as Part[]
                    continue; // Continue the WHILE loop

                 } else if (!socket.disconnected && !feedbackResolverRef?.value && !questionResolverRef?.value) {
                     emitLog(socket, "🤔 No function responses generated or execution halted.", 'info');
                     socket.emit('task-error', { message: "Task halted: Function calls failed, were cancelled, or resulted in no action.", originalPromptForState });
                     emitContextLog(socket, 'error', 'Function call sequence failed or halted.');
                     break; // Exit the main loop
                 } else {
                     emitLog(socket, `🏁 Task loop ending due to ${socket.disconnected ? 'disconnect' : 'pending user input'} after function calls.`, 'info');
                     break;
                 }

            }
            // --- Handle Text Response (Should NOT happen with toolMode ANY) ---
            else if (responseText) {
                 emitLog(socket, "⚠️ Gemini returned TEXT response unexpectedly (ToolMode is ANY):", 'warn');
                 emitLog(socket, responseText, 'gemini-resp');
                 emitContextLog(socket, 'warning', `Unexpected text response: ${responseText.substring(0, 50)}...`);
                 socket.emit('task-complete', { message: "Gemini provided unexpected final text.", finalResponse: responseText, originalPromptForState: originalPromptForState });
                 break; // Exit loop
            }
            // --- Handle Empty Response ---
            else {
                emitLog(socket, "🤔 Gemini finished without providing text or function calls.", 'warn');
                emitContextLog(socket, 'task_finished', 'Finished (No further action)');
                socket.emit('task-complete', { message: "Task finished: Gemini completed without further actions or text.", originalPromptForState: originalPromptForState });
                break; // Exit loop
            }

        } // End WHILE loop

    } catch (error) {
        // Catch unexpected errors in the loop logic itself
        emitLog(socket, `💥 An unexpected error occurred during the task execution loop: ${error}`, 'error');
        console.error("Gemini Task Runner Error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        emitContextLog(socket, 'error', `Runner Error: ${errorMessage}`);
        socket.emit('task-error', { message: `An unexpected error occurred: ${errorMessage}`, originalPromptForState: originalPromptForState });
    } finally {
        // Cleanup resolvers regardless of how the loop ended
         if (feedbackResolverRef?.value) {
             emitLog(socket, `🧹 Clearing pending feedback resolver in finally block for ${socket.id} (task ended).`, 'warn');
             if (typeof feedbackResolverRef.value === 'function') { feedbackResolverRef.value('task-end'); }
             feedbackResolverRef.value = null;
         }
         if (questionResolverRef?.value) {
             emitLog(socket, `🧹 Clearing pending question resolver in finally block for ${socket.id} (task ended).`, 'warn');
              if (typeof questionResolverRef.value === 'function') { questionResolverRef.value('task-end'); }
            questionResolverRef.value = null;
         }
         emitLog(socket, "🏁 Task execution loop finished.", 'info');
    }
}

module.exports = { runGeminiTask };