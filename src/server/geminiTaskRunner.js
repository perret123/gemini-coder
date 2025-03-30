// src/geminiTaskRunner.js
const { emitLog } = require('./utils');

// Helper function for sending messages with retry logic for rate limits
// MODIFIED: Accepts generationConfig
async function sendMessageWithRetry(chatSession, message, socket, generationConfig, maxRetries = 3, delay = 30000) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Pass generationConfig to the actual sendMessage call
            const result = await chatSession.sendMessage(message, generationConfig);
            return result;
        } catch (error) {
            const isRateLimitError = (error.message && (error.message.toLowerCase().includes('rate limit') || error.message.toLowerCase().includes('resource exhausted'))) || (error.httpStatusCode === 429);
            if (isRateLimitError && attempt < maxRetries - 1) {
                emitLog(socket, `🚦 Rate limit detected. Retrying in ${delay / 1000} seconds... (Attempt ${attempt + 1}/${maxRetries})`, 'warn');
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                emitLog(socket, `🚨 API Error after ${attempt + 1} attempts: ${error}`, 'error');
                if (isRateLimitError) {
                   throw new Error(`Rate limit error persisted after ${maxRetries} attempts: ${error.message}`);
                } else {
                   throw error;
                }
            }
        }
    }
    throw new Error('sendMessageWithRetry failed after exhausting all retries.');
}


async function runGeminiTask(context) {
    // Destructure context, including temperature
    const {
        socket, BASE_DIR, messageToSend, chatSession,
        functionHandlers, confirmAllRef, feedbackResolverRef,
        temperature, // <<< NEW
        retryDelay = 30000
    } = context;

    emitLog(socket, `🚀 Running task logic with Temperature: ${temperature}...`, 'info'); // Log temperature

    // Define generation config based on passed temperature
    const generationConfig = {
        temperature: temperature,
        // Add other config like topP, topK if needed later
    };
    emitLog(socket, `Generation Config: ${JSON.stringify(generationConfig)}`, 'info');


    try {
        emitLog(socket, "🤖 Sending request to Gemini...", 'gemini-req');
        // Pass generationConfig to sendMessageWithRetry
        let result = await sendMessageWithRetry(chatSession, messageToSend, socket, generationConfig, 3, retryDelay);


        // --- The rest of the loop remains largely the same ---
        while (true) {
            const response = result.response;

            // --- Feedback wait logic (unchanged) ---
            if (feedbackResolverRef.value) {
                emitLog(socket, "⏳ Waiting for user feedback (geminiTaskRunner)...", 'info');
                await new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (!feedbackResolverRef.value) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                });
                 emitLog(socket, "👍 User feedback resolved (geminiTaskRunner). Continuing...", 'info');
            }

            // --- Process response and function calls (unchanged) ---
            let functionCalls;
            try {
                if (response && typeof response.functionCalls === 'function') {
                     functionCalls = response.functionCalls();
                     if (!functionCalls) {
                        const text = response?.text() ?? "Gemini finished without text or function calls.";
                        emitLog(socket, "💬 Gemini Response (no function calls):", 'gemini-resp');
                        emitLog(socket, text, 'gemini-resp');
                        socket.emit('task-complete', { message: "Gemini provided final response without function calls." });
                        break;
                     }
                } else {
                    const text = response?.text() ?? "No response text.";
                    emitLog(socket, "💬 Gemini Response (final):", 'gemini-resp');
                    emitLog(socket, text, 'gemini-resp');
                    socket.emit('task-complete', { message: "Gemini provided final text response." });
                    break;
                }
            } catch (error) {
                emitLog(socket, `🚨 Error processing Gemini response: ${error}`, 'error');
                 try {
                     emitLog(socket, `💬 Gemini Raw Response Text: ${response?.text() ?? 'N/A'}`, 'gemini-resp');
                 } catch (textError) {
                     emitLog(socket, `🚨 Error getting text from Gemini response: ${textError}`, 'error');
                 }
                socket.emit('task-error', { message: `Error processing Gemini's response: ${error.message}` });
                return;
            }


            if (functionCalls && functionCalls.length > 0) {
                emitLog(socket, `⚙️ Gemini wants to call ${functionCalls.length} function(s):`, 'func-call');
                const functionResponses = [];

                for (const call of functionCalls) {
                     if (feedbackResolverRef.value) {
                         emitLog(socket, `🛑 Halting function calls as feedback is still pending (likely due to disconnect/error).`, 'warn');
                         break;
                     }

                    const functionName = call.name;
                    const args = call.args || {};
                    emitLog(socket, ` - Calling: ${functionName}(${JSON.stringify(args)})`, 'func-call');

                    const handler = functionHandlers[functionName];
                    if (!handler) {
                        emitLog(socket, ` 🚨 Error: Unknown function \"${functionName}\" requested.`, 'error');
                        functionResponses.push({
                            functionName: functionName,
                            response: { error: `Function ${functionName} is not implemented.` },
                        });
                        continue;
                    }

                    try {
                        const functionResult = await handler(args);
                         if (functionResult && functionResult.error && functionResult.error.startsWith('User rejected')) {
                             emitLog(socket, ` ⚠️ Function ${functionName} cancelled by user: ${functionResult.error}`, 'warn');
                             functionResponses.push({ functionName: functionName, response: functionResult });
                             if (!confirmAllRef.value) {
                                emitLog(socket, ` 🛑 Halting further function calls in this batch due to user rejection.`, 'warn');
                                break;
                            }
                         } else if (functionResult && functionResult.error) {
                             emitLog(socket, ` ⚠️ Function ${functionName} reported error: ${functionResult.error}`, 'warn');
                             functionResponses.push({ functionName: functionName, response: functionResult });
                         } else {
                            const resultSummary = JSON.stringify(functionResult)?.substring(0, 150) + (JSON.stringify(functionResult)?.length > 150 ? '...' : '');
                            emitLog(socket, ` ✅ Function ${functionName} executed. Result snippet: ${resultSummary}`, 'func-result');
                            functionResponses.push({
                                functionName: functionName,
                                response: functionResult || { success: true, message: "Operation completed successfully." },
                            });
                        }
                    } catch (error) {
                        emitLog(socket, ` ❌ Error executing function ${functionName}: ${error}`, 'error');
                        console.error(`Execution error for ${functionName}:`, error);
                        functionResponses.push({
                            functionName: functionName,
                            response: { error: `Execution failed: ${error.message}` },
                        });
                    }
                     if (feedbackResolverRef.value) {
                         emitLog(socket, `🛑 Halting function calls post-execution as feedback is now pending.`, 'warn');
                         break;
                     }
                } // End FOR loop for function calls


                // --- Send function results back (unchanged logic, but uses passed-in chatSession) ---
                if (!feedbackResolverRef.value && functionResponses.length > 0) {
                     emitLog(socket, "🤖 Sending function results back to Gemini...", 'gemini-req');
                     try {
                         const functionResponsePart = { functionResponse: { responses: functionResponses } };
                         // Pass generationConfig here too for consistency, although it might not affect function response processing
                         result = await sendMessageWithRetry(chatSession, JSON.stringify(functionResponsePart), socket, generationConfig, 3, retryDelay);
                     } catch(apiError) {
                         emitLog(socket, `🚨 Final API Error sending function responses: ${apiError}`, 'error');
                         emitLog(socket, ` Function responses attempted: ${JSON.stringify(functionResponses)}`, 'info');
                         console.error("Gemini API send error (after retries):", apiError);
                         socket.emit('task-error', { message: `API Error sending function results: ${apiError.message}` });
                         return;
                     }
                 } else if (functionResponses.length === 0 && !feedbackResolverRef.value) {
                      emitLog(socket, "🤔 No function responses to send back to Gemini.", 'info');
                      socket.emit('task-complete', { message: "Task finished after processing function calls (no results sent)."});
                      break;
                 } else {
                    emitLog(socket, "⏳ Deferring sending function results, waiting for user feedback resolution.", 'info');
                 }

            } // End IF functionCalls

        } // End WHILE loop

    } catch (error) {
        // --- Error handling (unchanged) ---
        emitLog(socket, `💥 An unexpected error occurred during the task: ${error}`, 'error');
        console.error("Task Error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        socket.emit('task-error', { message: `An unexpected error occurred: ${errorMessage}` });
    } finally {
        // --- Finally block (unchanged) ---
        if (feedbackResolverRef.value) {
            emitLog(socket, "🧹 Clearing pending feedback resolver due to task end/error.", 'warn');
             if (typeof feedbackResolverRef.value === 'function') {
                feedbackResolverRef.value('task-end');
            }
            feedbackResolverRef.value = null;
        }
        emitLog(socket, "🏁 Task run loop finished.", 'info');
    }
}

module.exports = { runGeminiTask };
