// c:\dev\gemini-coder\src\server\socketListeners.js
const { emitLog, emitContextLogEntry } = require("./utils");
const { performUndoOperation } = require("./fileSystem");

/**
 * Saves the current task state (changes log) associated with the connection's
 * base directory and original prompt. This is typically called when a task
 * segment completes or encounters an error requiring state preservation.
 * It merges changes if the same task (baseDir + originalPrompt) was previously saved.
 * @param {SocketIO.Socket} socket The socket instance.
 * @param {object} state The overall server state containing taskStates and connectionState.
 */
function saveCurrentTaskState(socket, state) {
    const { taskStates, connectionState } = state;
    const { currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef } = connectionState;

    const baseDir = currentBaseDirRef.value;
    const changes = currentChangesLogRef.value;
    const originalPrompt = currentOriginalPromptRef.value;

    if (!baseDir) {
        emitLog(socket, `ℹ️ Cannot save task state: Base directory not set for this task run.`, "info");
        currentChangesLogRef.value = []; // Clear anyway
        return;
    }

    if (!originalPrompt) {
        emitLog(socket, `⚠️ Cannot save task state for ${baseDir}: Original prompt is missing. State NOT saved.`, "warn", true);
        currentChangesLogRef.value = []; // Clear anyway
        return;
    }

    const existingState = taskStates.get(baseDir);
    const promptMatches = existingState?.originalPrompt === originalPrompt;

    // Save if there are new changes, or if it's a new task for this dir, or if prompt changed
    if (changes.length > 0 || !existingState || !promptMatches) {
        let stateToSave;
        if (existingState && promptMatches) {
            // Merge changes with existing state for the *same* original prompt
            const mergedChanges = [...existingState.changes, ...changes];
            emitLog(socket, `💾 Merging ${changes.length} new changes with existing state for ${baseDir}. Total changes: ${mergedChanges.length}.`, "info", true);
            if (changes.length > 0) emitLog(socket, ` (Note: Merged change list may contain redundant operations if task was complex)`, "debug");
            stateToSave = {
                originalPrompt: originalPrompt,
                baseDir: baseDir,
                changes: mergedChanges,
                timestamp: Date.now()
            };
        } else {
            // Replace previous state (if prompt changed) or save new state
            if (existingState && !promptMatches) {
                 emitLog(socket, `💾 Replacing previous state for ${baseDir} due to different original prompt.`, "info", true);
            } else {
                emitLog(socket, `💾 Saving initial task state for ${baseDir} with ${changes.length} changes.`, "info", true);
            }
            stateToSave = {
                originalPrompt: originalPrompt,
                baseDir: baseDir,
                changes: [...changes], // Create a new array copy
                timestamp: Date.now()
            };
        }
        taskStates.set(baseDir, stateToSave);
        emitLog(socket, ` ✅ State saved for base directory: ${baseDir}.`, "info", true);
    } else {
        emitLog(socket, `ℹ️ No file changes detected in this run segment for ${baseDir}. State not updated.`, "info");
    }

    // Always clear the *current* connection's change log after attempting to save
    currentChangesLogRef.value = [];
    emitLog(socket, `🧹 Cleared current change log for connection ${socket.id}.`, "debug");
}


/**
 * Sets up standard socket event listeners for a connected client.
 * @param {SocketIO.Socket} socket The newly connected socket instance.
 * @param {object} state The overall server state (taskStates, activeChatSessions, connectionState).
 */
function setupSocketListeners(socket, state) {
    const { taskStates, activeChatSessions, connectionState } = state;
    const { feedbackResolverRef, questionResolverRef, currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef, confirmAllRef } = connectionState;

    // Listen for the event name the client actually emits for confirmations
    socket.on("confirmation-response", (data) => {
        const decision = data?.decision; // Client sends { confirmed: boolean, decision: 'yes'|'no'|'yes/all'|... }
        const confirmed = data?.confirmed;
        emitLog(socket, `Received confirmation response: Decision='${decision}', Confirmed=${confirmed}`, "info");
        if (feedbackResolverRef.value && typeof feedbackResolverRef.value === "function") {
            feedbackResolverRef.value(decision); // Resolve the promise with the decision string ('yes', 'no', 'yes/all')
            feedbackResolverRef.value = null;
        } else {
            emitLog(socket, `⚠️ Warning: Received confirmation response '${decision}' but no confirmation was actively pending for ${socket.id}. Ignoring.`, "warn");
        }
    });

    // Listen for the event name the client actually emits for question answers
    socket.on("question-response", (data) => {
        const answer = data?.answer;
        emitLog(socket, `Received user question response: ${JSON.stringify(answer)}`, "info");
        if (questionResolverRef.value && typeof questionResolverRef.value === "function") {
            questionResolverRef.value(answer); // Resolve the promise with the answer object
            questionResolverRef.value = null;
        } else {
            emitLog(socket, `⚠️ Warning: Received user question response '${JSON.stringify(answer)}' but no question was actively pending for ${socket.id}. Ignoring.`, "warn");
        }
    });

    // These are internal signals, typically triggered by the Gemini task runner, not direct user UI interactions
    socket.on("task-complete", (data) => {
        const message = data?.message || "Completed.";
        // Use the prompt associated with the *specific task run* that just completed
        const promptForState = data?.originalPromptForState || currentOriginalPromptRef.value;
        emitLog(socket, `Internal: task-complete signal received for ${socket.id}. Saving state. Message: ${message}`, "debug");

        // Ensure the correct prompt is used for saving state, especially if multiple tasks ran quickly
        if (promptForState && promptForState !== currentOriginalPromptRef.value) {
            emitLog(socket, `Using original prompt from event data ('${promptForState.substring(0,30)}...') instead of ref ('${currentOriginalPromptRef.value?.substring(0,30)}...') for state saving.`, "debug");
            currentOriginalPromptRef.value = promptForState; // Temporarily set ref for save function
        } else if (!currentOriginalPromptRef.value && promptForState) {
             currentOriginalPromptRef.value = promptForState; // Set if ref was somehow null
        }
        // If promptForState is still null, saveCurrentTaskState will log a warning and not save

        saveCurrentTaskState(socket, state);
        confirmAllRef.value = false; // Reset yes/all state after task completion
        // Don't clear currentOriginalPromptRef here, it might be needed if the user immediately starts a new task
    });

    socket.on("task-error", (data) => {
        const message = data?.message || "Unknown error.";
        // Task errors mean the current segment's changes are likely invalid or incomplete.
        emitLog(socket, `Internal: task-error signal received for ${socket.id}. Discarding current changes. Message: ${message}`, "debug");
        currentChangesLogRef.value = []; // Discard unsaved changes for this segment
        emitLog(socket, `🧹 Discarded unsaved changes for connection ${socket.id} due to error.`, "warn", true);
        confirmAllRef.value = false; // Reset yes/all state on error
        // Don't clear currentOriginalPromptRef here
    });

    socket.on("disconnect", (reason) => {
        console.log(`🔌 User disconnected: ${socket.id}. Reason: ${reason}`);
        if (activeChatSessions.has(socket.id)) {
            // Potentially end any ongoing Gemini API calls gracefully here if possible/needed
            activeChatSessions.delete(socket.id);
            console.log(`🧹 Cleared active chat session for disconnected user: ${socket.id}`);
        }

        // Cancel any pending interactions
        if (feedbackResolverRef.value) {
            console.log(`Sys: User disconnected with pending confirmation for ${socket.id}. Cancelling interaction.`);
            if (typeof feedbackResolverRef.value === "function") {
                feedbackResolverRef.value("disconnect"); // Resolve with a special value
            }
            feedbackResolverRef.value = null;
        }
        if (questionResolverRef.value) {
            console.log(`Sys: User disconnected with pending question for ${socket.id}. Cancelling interaction.`);
            if (typeof questionResolverRef.value === "function") {
                questionResolverRef.value("disconnect"); // Resolve with a special value
            }
            questionResolverRef.value = null;
        }

        // Clear connection-specific state
        currentChangesLogRef.value = [];
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        confirmAllRef.value = false;
        console.log(`🧹 Cleared connection state refs for ${socket.id}.`);
    });

    socket.on("error", (err) => {
        console.error(` Socket error for ${socket.id}:`, err);
        emitLog(socket, `Critical socket error: ${err.message}. Please refresh.`, "error", true);
        emitContextLogEntry(socket, "error", `Socket Error: ${err.message}`);

        // Attempt to cancel pending interactions
        if (feedbackResolverRef.value) {
            console.warn(`Sys: Socket error with pending confirmation for ${socket.id}. Cancelling interaction.`);
            if(typeof feedbackResolverRef.value === "function") {
                 feedbackResolverRef.value("error");
            }
            feedbackResolverRef.value = null;
        }
        if (questionResolverRef.value) {
            console.warn(`Sys: Socket error with pending question for ${socket.id}. Cancelling interaction.`);
             if(typeof questionResolverRef.value === "function") {
                questionResolverRef.value("error");
            }
            questionResolverRef.value = null;
        }

        // Clear connection-specific state
        currentChangesLogRef.value = [];
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        confirmAllRef.value = false;
        console.log(`🧹 Cleared connection state refs for ${socket.id} due to socket error.`);
    });

    console.log(`Socket listeners setup for ${socket.id}`);
}

module.exports = { setupSocketListeners, saveCurrentTaskState };