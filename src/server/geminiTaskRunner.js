// c:\dev\gemini-coder\src\server\geminiTaskRunner.js
import { emitLog, emitContextLogEntry } from "./utils.js"; // Added .js extension
import { saveCurrentTaskState } from "./socketListeners.js"; // Added .js extension
// buildInitialPrompt is only used in taskSetup.js, so no import needed here.

// Custom error class for specific retry scenarios
class PersistentInternalServerError extends Error {
  constructor(message) {
    super(message);
    this.name = "PersistentInternalServerError";
  }
}

// Internal helper for sending messages with retry logic
async function sendMessageWithRetry(
  chatSession,
  message,
  socket,
  generationConfig,
  toolConfig,
  maxRetries = 3,
  initialDelay = 120000,
) {
  let lastError = null;
  let delay = initialDelay;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lastError = null; // Reset last error for this attempt
    try {
      // Ensure message is in the expected format (array of parts)
      const messageToSend = Array.isArray(message)
        ? message
        : [{ text: message }];

      emitLog(
        socket,
        ` Gemini API Call (Attempt ${attempt + 1}/${maxRetries})`,
        "debug",
      );
      const result = await chatSession.sendMessage(
        messageToSend /*, {generationConfig, toolConfig} - Config passed during startChat */,
      ); // Pass message array

      // Basic validation of the result structure
      if (!result || !result.response) {
        throw new Error("API returned invalid or empty result/response.");
      }

      emitLog(socket, ` 💬 Gemini responded (Attempt ${attempt + 1})`, "debug");
      return result; // Success
    } catch (error) {
      lastError = error; // Store the error from this attempt
      const errorMessage = error.message || String(error);
      // Try to extract status code robustly
      const statusCode =
        error.httpStatusCode ||
        error.status ||
        error.code ||
        (error.error && error.error.code) ||
        (error.cause && error.cause.status) ||
        (error.response && error.response.status);

      console.error(
        `API Error (Attempt ${attempt + 1}/${maxRetries}, Status: ${statusCode || "N/A"}): ${errorMessage}`,
      );

      // --- Error Classification ---
      const isBadRequestJsonError =
        statusCode === 400 &&
        errorMessage.toLowerCase().includes("invalid json payload");
      const isRateLimitError =
        statusCode === 429 ||
        errorMessage.toLowerCase().includes("rate limit") ||
        errorMessage.toLowerCase().includes("resource exhausted") ||
        errorMessage.toLowerCase().includes("quota");
      const isInternalOrUnavailable = statusCode === 500 || statusCode === 503;
      // Sometimes rate limits manifest as 429 with specific messages
      const isOverloadedError =
        statusCode === 429 &&
        errorMessage.toLowerCase().includes("model is overloaded");

      // --- Decision Logic ---
      if (isBadRequestJsonError) {
        // Specific error for bad JSON - likely unrecoverable by retry
        emitLog(
          socket,
          `🚨 API Bad Request Error (Status: 400): ${errorMessage}. Cannot retry. Check payload structure.`,
          "error",
          true,
        );
        emitContextLogEntry(
          socket,
          "error",
          `API Bad Request: ${errorMessage}`,
        ); // Log to client context
        throw new Error(
          `API Error: Bad Request (400) - Invalid JSON Payload. Details: ${errorMessage}`,
        );
      }

      const shouldRetry =
        isRateLimitError || isOverloadedError || isInternalOrUnavailable;

      if (shouldRetry && attempt < maxRetries - 1) {
        // Retryable error and more attempts left
        const errorType = isRateLimitError
          ? isOverloadedError
            ? "Overloaded"
            : "Rate Limit/Quota"
          : "Internal Server/Unavailable";
        const retryDelaySec = Math.round(delay / 1000);
        emitLog(
          socket,
          `🚦 API ${errorType} Error (Status: ${statusCode || "N/A"}). Retrying in ${retryDelaySec}s... (Attempt ${attempt + 1}/${maxRetries})`,
          "warn",
          true,
        );
        emitContextLogEntry(
          socket,
          "api_retry",
          `API Error (${errorType}). Retrying (${attempt + 1}).`,
        ); // Update context

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 1.5; // Exponential backoff (simple version)
        continue; // Go to next iteration
      } else if (shouldRetry && attempt >= maxRetries - 1) {
        // Retryable error, but out of attempts
        emitLog(
          socket,
          `🚨 API call failed after ${attempt + 1} attempt(s). Last Status: ${statusCode || "N/A"}, Last Error: ${errorMessage}`,
          "error",
          true,
        );
        // If it's a persistent 500, throw the specific error type
        if (isInternalOrUnavailable && statusCode === 500) {
          emitLog(
            socket,
            `🧱 Persistent API Error (Status: 500) after ${maxRetries} attempts. Signaling for potential auto-continuation.`,
            "warn",
            true,
          );
          throw new PersistentInternalServerError(
            `API Error: Persistent 500 after ${maxRetries} attempts. (Details: ${errorMessage})`,
          );
        }
        break; // Exit loop, will throw generic error below
      } else {
        // Unretryable error (not 429/500/503 or specific 400)
        emitLog(
          socket,
          `🚨 Unretryable API Error encountered (Status: ${statusCode || "N/A"}): ${errorMessage}`,
          "error",
          true,
        );
        throw lastError; // Throw the original error immediately
      }
    }
  }

  // If loop finished without returning/throwing explicitly, it means retries exhausted for a non-500 retryable error
  if (lastError) {
    const lastErrorMessage = lastError.message || String(lastError);
    const lastStatusCode =
      lastError.httpStatusCode ||
      lastError.status ||
      lastError.code ||
      (lastError.error && lastError.error.code) ||
      (lastError.cause && lastError.cause.status) ||
      (lastError.response && lastError.response.status);

    emitLog(
      socket,
      `🚨 Unrecoverable API Error after ${maxRetries} attempts (Status: ${lastStatusCode || "N/A"}): ${lastErrorMessage}`,
      "error",
      true,
    );
    emitContextLogEntry(socket, "error", `API Error: ${lastErrorMessage}`);
    throw new Error(
      `API Error: ${lastErrorMessage} (Status: ${lastStatusCode || "N/A"}) after ${maxRetries} attempts.`,
    );
  }

  // Should not be reached, but fallback
  throw new Error(
    "sendMessageWithRetry finished unexpectedly without success or error.",
  );
}

// --- Main Task Runner Logic ---
export async function runGeminiTask(context, state) {
  const {
    socket,
    BASE_DIR,
    messageToSend,
    chatSession,
    functionHandlers,
    feedbackResolverRef,
    questionResolverRef,
    temperature,
    originalPromptForState, // Passed for state saving association
    retryDelay = 120000, // Default retry delay from context or global default
    toolConfig, // Passed from taskSetup
  } = context;
  const { taskStates } = state; // Global state map

  emitLog(
    socket,
    `🚀 Starting Gemini task execution loop (Base: ${BASE_DIR}, Temp: ${temperature}, ToolMode: ${toolConfig?.functionCallingConfig?.mode})`,
    "info",
    true,
  );

  const generationConfig = { temperature: temperature }; // Set generation config
  emitLog(
    socket,
    `Generation Config: ${JSON.stringify(generationConfig)}`,
    "debug",
  ); // Log the config used

  let nextMessageToSend = messageToSend; // Initial message
  let taskFinishedSignalled = false; // Flag to break the loop
  let isAutoContinuing = false; // Flag for handling persistent 500 errors

  try {
    // Main execution loop
    while (true) {
      if (taskFinishedSignalled) {
        emitLog(socket, "🏁 Task finish signalled, exiting loop.", "debug");
        break;
      }

      if (socket.disconnected) {
        emitLog(socket, "🛑 User disconnected, aborting task.", "warn", true);
        emitContextLogEntry(
          socket,
          "disconnect",
          "Task aborted due to disconnect.",
        );
        break;
      }

      // Safety check: If nextMessageToSend is somehow null/undefined, break
      if (!nextMessageToSend) {
        emitLog(
          socket,
          "⚠️ Internal Warning: nextMessageToSend is null, breaking loop.",
          "warn",
          true,
        );
        emitContextLogEntry(socket, "error", "Internal loop error.");
        socket.emit("task-error", {
          message: "Internal error: No further actions from Gemini.",
          originalPromptForState: originalPromptForState,
        });
        break;
      }

      // --- Call Gemini API ---
      emitLog(socket, "🤖 Sending request to Gemini...", "gemini-req"); // Log request start
      let result;
      try {
        result = await sendMessageWithRetry(
          chatSession,
          nextMessageToSend,
          socket,
          generationConfig,
          toolConfig, // Pass toolConfig for potential use in retry logic? (Currently not used there)
          3, // Max retries
          retryDelay, // Initial delay
        );
        nextMessageToSend = null; // Clear message buffer after successful send
        if (isAutoContinuing) {
          emitLog(
            socket,
            `✅ Auto-continuation attempt succeeded. Resuming normal operation.`,
            "info",
            true,
          );
          isAutoContinuing = false; // Reset flag
        }
      } catch (apiError) {
        // Handle Persistent 500 specifically for auto-continue
        if (
          apiError instanceof PersistentInternalServerError &&
          !isAutoContinuing
        ) {
          emitLog(
            socket,
            `🔄 Detected Persistent 500 Error. Attempting automatic continuation (1 try)...`,
            "info",
            true,
          );
          emitContextLogEntry(
            socket,
            "api_retry",
            "Persistent 500. Attempting auto-resume.",
          );
          isAutoContinuing = true; // Set flag

          // Save current state before attempting resume
          if (!originalPromptForState) {
            emitLog(
              socket,
              `⚠️ Cannot save state for auto-resume: Original prompt reference missing. Aborting task.`,
              "error",
              true,
            );
            socket.emit("task-error", {
              message: `Failed to auto-resume: Internal state error (missing original prompt). Details: ${apiError.message}`,
              originalPromptForState: originalPromptForState,
            });
            break;
          }
          saveCurrentTaskState(socket, state); // Save the current changes

          // Retrieve the saved state to build the resume prompt
          const savedState = taskStates.get(BASE_DIR);
          if (!savedState || !savedState.originalPrompt) {
            emitLog(
              socket,
              `⚠️ Cannot auto-resume: Failed to retrieve valid saved state for ${BASE_DIR} after saving. Aborting task.`,
              "error",
              true,
            );
            socket.emit("task-error", {
              message: `Failed to auto-resume: Internal state error (cannot retrieve valid saved state). Details: ${apiError.message}`,
              originalPromptForState: originalPromptForState,
            });
            break;
          }

          const contextChangesToSend = savedState.changes || [];
          // Format changes for the prompt
          const changesSummary =
            contextChangesToSend.length > 0
              ? contextChangesToSend
                  .map(
                    (c) =>
                      `- ${c.type}: ${c.filePath || c.directoryPath || `${c.sourcePath} -> ${c.destinationPath}` || "Unknown Change"}`,
                  )
                  .join("\n")
              : "(None recorded)";

          // Construct the resume preamble
          const resumePreambleText = `You previously encountered a persistent server error (500). You are resuming the task for the base directory '${BASE_DIR}'.\n**Original User Request:** "${savedState.originalPrompt}"\n**Previously Applied Changes (Context):**\n${changesSummary}\n---\n**Continue executing the original request based on the context above.** Analyze the original goal and previous changes, then proceed using function calls. Remember to call 'task_finished' when done.`;
          emitLog(
            socket,
            `📄 Constructed resume preamble for auto-continuation.`,
            "debug",
          );
          nextMessageToSend = [{ text: resumePreambleText }];
          continue; // Go to the start of the loop to send the resume message
        } else {
          // Handle other API errors (retry exhausted, unretryable)
          const failureReason = isAutoContinuing
            ? "Auto-continuation attempt failed"
            : "Failed to communicate with Gemini API";
          emitLog(
            socket,
            `❌ ${failureReason}. Stopping task. Error: ${apiError.message}`,
            "error",
            true,
          );
          socket.emit("task-error", {
            message: `${failureReason}: ${apiError.message}`,
            originalPromptForState: originalPromptForState,
          });
          break; // Stop the task
        }
      }

      // --- Process Gemini Response ---
      const response = result.response;
      let responseText = "";
      let functionCalls = null;

      try {
        // Use SDK helper methods if available and safe
        if (response && typeof response.functionCalls === "function") {
          functionCalls = response.functionCalls(); // Returns array or undefined
        }
        if (response && typeof response.text === "function") {
          responseText = response.text() ?? ""; // Get text content, default to empty string
        }
      } catch (processingError) {
        // Error extracting content from the response
        emitLog(
          socket,
          `🚨 Error processing Gemini response content: ${processingError}`,
          "error",
          true,
        );
        // Try a more robust fallback to get text if possible
        try {
          responseText =
            response?.candidates?.[0]?.content?.parts?.[0]?.text ??
            ".(Could not extract response text).";
        } catch (fallbackError) {
          responseText =
            ".(Response parsing failed completely)." + fallbackError;
        }
        emitLog(
          socket,
          `💬 Gemini Raw Response Text (on error): ${responseText}`,
          "gemini-resp",
        );
        emitContextLogEntry(
          socket,
          "error",
          `Response Processing Error: ${processingError.message}`,
        );
        socket.emit("task-error", {
          message: `Error processing Gemini's response: ${processingError.message}`,
          originalPromptForState: originalPromptForState,
        });
        break; // Stop the task
      }

      // --- Handle Function Calls ---
      if (functionCalls && functionCalls.length > 0) {
        emitLog(
          socket,
          `⚙️ Gemini wants to call ${functionCalls.length} function(s):`,
          "func-call",
        );
        const functionResponses = []; // Array to hold results for the next API call

        for (const call of functionCalls) {
          // Check for pending user interactions *before* executing the next function
          if (feedbackResolverRef?.value || questionResolverRef?.value) {
            const pendingType = feedbackResolverRef?.value
              ? "feedback"
              : "question";
            emitLog(
              socket,
              `🛑 Halting function execution sequence due to pending user input (${pendingType}). Saving state before stopping.`,
              "warn",
              true,
            );
            emitContextLogEntry(
              socket,
              "user_wait",
              `Waiting for user ${pendingType}`,
            );
            saveCurrentTaskState(socket, state); // Save progress before halting
            taskFinishedSignalled = true; // Set flag to exit loop
            // Notify client the task stopped due to waiting
            socket.emit("task-error", {
              message: `Task interrupted waiting for user ${pendingType}. Context saved. Restart with 'Continue Context' if needed.`,
              originalPromptForState,
            });
            break; // Exit the inner for loop
          }

          if (socket.disconnected) {
            // Check connection again inside loop
            taskFinishedSignalled = true;
            break;
          }

          const functionName = call.name;
          const args = call.args || {}; // Ensure args is an object

          emitLog(
            socket,
            ` - Calling: ${functionName}(${JSON.stringify(args)})`,
            "func-call",
          );

          const handler = functionHandlers[functionName];
          if (!handler) {
            emitLog(
              socket,
              ` ⚠️ Function handler not found: ${functionName}. Skipping.`,
              "warn",
              true,
            );
            emitContextLogEntry(
              socket,
              "error",
              `Function handler not found: ${functionName}`,
            );
            // Provide an error response back to Gemini
            functionResponses.push({
              functionName: functionName, // Echo the name
              response: {
                error: `Function handler "${functionName}" not found on server.`,
              },
            });
            continue; // Skip to the next function call
          }

          try {
            // Execute the handler function
            const functionResult = await handler(args);
            emitLog(
              socket,
              ` ✔️ Result [${functionName}]: ${JSON.stringify(functionResult)}`,
              "func-result",
            );

            // Special handling for 'task_finished'
            if (functionName === "task_finished" && functionResult?.finished) {
              emitLog(
                socket,
                `🏁 Gemini requested task finish: ${functionResult.message}`,
                "success",
                true,
              );
              emitContextLogEntry(
                socket,
                "task_finished",
                `Finished: ${functionResult.message}`,
              );
              // Don't save state here, let the task-complete handler do it
              socket.emit("task-complete", {
                message:
                  functionResult.message || "Task marked finished by Gemini.",
                originalPromptForState: originalPromptForState,
              });
              taskFinishedSignalled = true;
              functionResponses.length = 0; // Clear responses, task is ending
              break; // Exit the inner for loop immediately
            }

            // Add successful result to responses for Gemini
            functionResponses.push({
              functionName: functionName,
              response: functionResult, // Send back the result object from the handler
            });
          } catch (execError) {
            // Catch errors *during* function execution
            emitLog(
              socket,
              ` ❌ CRITICAL Error executing function ${functionName}: ${execError}`,
              "error",
              true,
            );
            console.error(`Execution error for ${functionName}:`, execError);
            emitContextLogEntry(
              socket,
              "error",
              `Exec Error (${functionName}): ${execError.message}`,
            );
            // Provide error response back to Gemini
            functionResponses.push({
              functionName: functionName,
              response: {
                error: `Internal server error during execution: ${execError.message}`,
              },
            });
            // Optionally: Decide whether to break the loop on execution error
            // taskFinishedSignalled = true; break;
          }
        } // End of for loop over function calls

        if (taskFinishedSignalled) break; // Break outer loop if finish/error signalled inside

        // If we processed calls and are not finished, prepare response for Gemini
        if (functionResponses.length > 0) {
          emitLog(
            socket,
            "🤖 Preparing function results to send back...",
            "debug",
          );
          // Format for the API: array of { functionResponse: { name, response } }
          const functionResponseParts = functionResponses.map((fr) => ({
            functionResponse: { name: fr.functionName, response: fr.response },
          }));
          nextMessageToSend = functionResponseParts;
          continue; // Continue the while loop to send results back
        } else if (!socket.disconnected && !taskFinishedSignalled) {
          // This case means the loop finished but no responses were generated (e.g., all skipped due to missing handlers?)
          emitLog(
            socket,
            "🤔 No function responses generated or execution halted unexpectedly.",
            "info",
            true,
          );
          socket.emit("task-error", {
            message:
              "Task halted: Function calls resulted in no actionable response.",
            originalPromptForState,
          });
          emitContextLogEntry(
            socket,
            "error",
            "Function call sequence failed or halted.",
          );
          break; // Exit the main loop
        }

        // --- Handle Text Response ---
      } else if (responseText) {
        // Tool mode is 'ANY', so text response is unexpected unless it's the final answer?
        // Treat it as task completion for now.
        emitLog(
          socket,
          "⚠️ Gemini returned TEXT response unexpectedly (ToolMode is ANY):",
          "warn",
          true,
        );
        emitLog(socket, responseText, "gemini-resp");
        emitContextLogEntry(
          socket,
          "warning",
          `Unexpected text response: ${responseText.substring(0, 50)}...`,
        );
        socket.emit("task-complete", {
          message: "Gemini provided unexpected final text.",
          finalResponse: responseText,
          originalPromptForState: originalPromptForState,
        });
        taskFinishedSignalled = true; // End the loop
        break;

        // --- Handle Empty Response ---
      } else {
        // No function calls and no text - model finished its turn without action.
        emitLog(
          socket,
          "🤔 Gemini finished turn without providing text or function calls.",
          "warn",
          true,
        );
        emitContextLogEntry(
          socket,
          "task_finished",
          "Finished (No further action)",
        );
        socket.emit("task-complete", {
          message:
            "Task finished: Gemini completed without further actions or text.",
          originalPromptForState: originalPromptForState,
        });
        taskFinishedSignalled = true; // End the loop
        break;
      }
    } // End while loop
  } catch (error) {
    // Catch unexpected errors in the runner logic itself
    emitLog(
      socket,
      `💥 An unexpected error occurred during the task execution loop: ${error}`,
      "error",
      true,
    );
    console.error("Gemini Task Runner Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitContextLogEntry(socket, "error", `Runner Error: ${errorMessage}`);
    socket.emit("task-error", {
      message: `An unexpected error occurred: ${errorMessage}`,
      originalPromptForState: context.originalPromptForState,
    });
  } finally {
    // --- Cleanup ---
    // Ensure any pending resolvers are cleared if the loop exits for any reason
    if (feedbackResolverRef?.value) {
      emitLog(
        socket,
        `🧹 Clearing pending feedback resolver in finally block for ${socket.id} (task ended).`,
        "warn",
      );
      if (typeof feedbackResolverRef.value === "function") {
        feedbackResolverRef.value("task-end"); // Resolve with a specific signal
      }
      feedbackResolverRef.value = null;
    }
    if (questionResolverRef?.value) {
      emitLog(
        socket,
        `🧹 Clearing pending question resolver in finally block for ${socket.id} (task ended).`,
        "warn",
      );
      if (typeof questionResolverRef.value === "function") {
        questionResolverRef.value("task-end"); // Resolve with a specific signal
      }
      questionResolverRef.value = null;
    }
    emitLog(socket, "🏁 Task execution loop finished.", "info", true);
    // State saving is handled by task-complete/task-error socket event listeners
  }
}
