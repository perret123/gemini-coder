const { emitLog, emitContextLog } = require('./utils'); // Added emitContextLog
const { performUndoOperation } = require('./fileSystem'); // Assuming undo might be triggered via socket later

/**
 * Saves the current task's change log to the persistent taskStates map.
 * Keyed by the base directory. Only saves if changes exist or state is new.
 */
function saveCurrentTaskState(socket, state) {
    const { taskStates, connectionState } = state;
    const { currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef } = connectionState;

    const baseDir = currentBaseDirRef.value;
    const changes = currentChangesLogRef.value;
    const originalPrompt = currentOriginalPromptRef.value;

    if (!baseDir) {
         emitLog(socket, `ℹ️ Cannot save task state: Base directory not set for this task run.`, 'info');
         currentChangesLogRef.value = []; // Clear log even if not saved
        return;
    }
    if (!originalPrompt) {
         emitLog(socket, `⚠️ Cannot save task state for ${baseDir}: Original prompt is missing. State NOT saved.`, 'warn');
         // Don't clear the log here, might be needed if task continues somehow? Or clear it? Let's clear.
         currentChangesLogRef.value = [];
        return;
    }

    // Check if there are changes or if this is the first time saving for this baseDir/prompt combo
    const existingState = taskStates.get(baseDir);
    const promptMatches = existingState?.originalPrompt === originalPrompt;

    if (changes.length > 0 || !existingState || !promptMatches) {
        let stateToSave;
        if (existingState && promptMatches) {
            // Merge changes if the prompt is the same (continuing the same logical task)
            const mergedChanges = [...existingState.changes, ...changes];
             emitLog(socket, `💾 Merging ${changes.length} new changes with existing state for ${baseDir}. Total changes: ${mergedChanges.length}.`, 'info');
             if (changes.length > 0) emitLog(socket, ` (Note: Merged change list may contain redundant operations if task was complex)`, 'debug');
             stateToSave = {
                originalPrompt: originalPrompt, // Keep original prompt
                baseDir: baseDir,
                changes: mergedChanges,
                timestamp: Date.now()
             };
        } else {
            // Replace state if prompt differs or no existing state
            if (existingState && !promptMatches) {
                emitLog(socket, `💾 Replacing previous state for ${baseDir} due to different original prompt.`, 'info');
            } else {
                 emitLog(socket, `💾 Saving initial task state for ${baseDir} with ${changes.length} changes.`, 'info');
            }
             stateToSave = {
                originalPrompt: originalPrompt,
                baseDir: baseDir,
                changes: [...changes], // Save a copy
                timestamp: Date.now()
             };
        }
        taskStates.set(baseDir, stateToSave);
        emitLog(socket, ` ✅ State saved for base directory: ${baseDir}.`, 'info');

    } else {
        // No changes in this segment, no need to update saved state
        emitLog(socket, `ℹ️ No file changes detected in this run segment for ${baseDir}. State not updated.`, 'info');
    }

    // Clear the *current run's* change log after attempting save
    currentChangesLogRef.value = [];
    emitLog(socket, `🧹 Cleared current change log for connection ${socket.id}.`, 'debug');
}


function setupSocketListeners(socket, state) {
    const { taskStates, activeChatSessions, connectionState } = state;
    const { feedbackResolverRef, questionResolverRef, currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef, confirmAllRef } = connectionState;

    // --- User Responses ---

    socket.on('user-feedback', (data) => {
        const decision = data?.decision; // 'yes', 'no', 'yes/all', 'error', 'disconnect', 'task-end'
        emitLog(socket, `Received user feedback decision: '${decision}'`, 'info');
        // Context log added by the function handler or runner based on the decision

        if (feedbackResolverRef.value && typeof feedbackResolverRef.value === 'function') {
            feedbackResolverRef.value(decision);
            feedbackResolverRef.value = null; // Clear resolver after use
        } else {
            emitLog(socket, `⚠️ Warning: Received user feedback '${decision}' but no confirmation was actively pending for ${socket.id}. Ignoring.`, 'warn');
        }
         // Do NOT re-enable controls here. Let the task runner continue or finish.
    });

    socket.on('user-question-response', (data) => {
        const answer = data?.answer; // { type: 'text'/'button', value: string } or 'error', 'disconnect', 'task-end'
        emitLog(socket, `Received user question response: ${JSON.stringify(answer)}`, 'info');
         // Context log added by the askUserQuestion handler when it receives the resolved promise

        if (questionResolverRef.value && typeof questionResolverRef.value === 'function') {
             questionResolverRef.value(answer);
             questionResolverRef.value = null; // Clear resolver after use
        } else {
            emitLog(socket, `⚠️ Warning: Received user question response '${JSON.stringify(answer)}' but no question was actively pending for ${socket.id}. Ignoring.`, 'warn');
        }
         // Do NOT re-enable controls here.
    });

    // --- Task Lifecycle (Internal Signals from Runner/Setup) ---
    // These are emitted *server-side* to trigger state saving/cleanup
    // They correspond to the events sent *to the client*.

    socket.on('task-complete', (data) => {
        const message = data?.message || 'Completed.';
        const promptForState = data?.originalPromptForState || currentOriginalPromptRef.value;
        emitLog(socket, `Internal: task-complete signal received for ${socket.id}. Saving state. Message: ${message}`, 'debug');

        // Ensure the correct original prompt is used for saving state
        if (promptForState && promptForState !== currentOriginalPromptRef.value) {
             emitLog(socket, `Using original prompt from event data ('${promptForState.substring(0,30)}...') instead of ref ('${currentOriginalPromptRef.value?.substring(0,30)}...') for state saving.`, 'debug');
             currentOriginalPromptRef.value = promptForState;
        } else if (!currentOriginalPromptRef.value && promptForState) {
             currentOriginalPromptRef.value = promptForState;
        }

        saveCurrentTaskState(socket, state);
        confirmAllRef.value = false; // Reset 'yes/all' flag
        // Context log for completion is added by the runner/handler that signals completion
    });

    socket.on('task-error', (data) => {
         const message = data?.message || 'Unknown error.';
         emitLog(socket, `Internal: task-error signal received for ${socket.id}. Discarding current changes. Message: ${message}`, 'debug');
         currentChangesLogRef.value = []; // Discard changes for this run segment on error
         emitLog(socket, `🧹 Discarded unsaved changes for connection ${socket.id} due to error.`, 'warn');
         confirmAllRef.value = false; // Reset 'yes/all' flag
         // Context log for error is added by the runner/handler that signals the error
    });


    // --- Socket Connection Management ---

    socket.on('disconnect', (reason) => {
        console.log(`🔌 User disconnected: ${socket.id}. Reason: ${reason}`);
        // emitLog is problematic here as socket is disconnected
        // emitContextLog(socket, 'disconnect', `Disconnected: ${reason}`); // This won't reach client

        // Clean up active session
        if (activeChatSessions.has(socket.id)) {
            activeChatSessions.delete(socket.id);
            console.log(`🧹 Cleared active chat session for disconnected user: ${socket.id}`);
        } else {
            console.log(`ℹ️ No active chat session found to clear for ${socket.id}.`);
        }

        // Abort pending interactions by resolving the promises
        if (feedbackResolverRef.value) {
            console.log(`Sys: User disconnected with pending confirmation for ${socket.id}. Cancelling interaction.`);
             if (typeof feedbackResolverRef.value === 'function') {
                 feedbackResolverRef.value('disconnect'); // Resolve with 'disconnect' status
             }
            feedbackResolverRef.value = null;
        }
        if (questionResolverRef.value) {
             console.log(`Sys: User disconnected with pending question for ${socket.id}. Cancelling interaction.`);
             if (typeof questionResolverRef.value === 'function') {
                 questionResolverRef.value('disconnect'); // Resolve with 'disconnect' status
             }
            questionResolverRef.value = null;
        }

        // Clear connection-specific state refs
        currentChangesLogRef.value = [];
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        confirmAllRef.value = false;
        console.log(`🧹 Cleared connection state refs for ${socket.id}.`);
    });

    // Handle underlying socket errors
    socket.on('error', (err) => {
        console.error(` Socket error for ${socket.id}:`, err);
        emitLog(socket, `Critical socket error: ${err.message}. Please refresh.`, 'error'); // Attempt to log to client
        emitContextLog(socket, 'error', `Socket Error: ${err.message}`); // Attempt context log

        // Abort pending interactions
        if (feedbackResolverRef.value) {
             console.warn(`Sys: Socket error with pending confirmation for ${socket.id}. Cancelling interaction.`);
            if(typeof feedbackResolverRef.value === 'function') {
                feedbackResolverRef.value('error'); // Resolve with 'error' status
            }
            feedbackResolverRef.value = null;
        }
        if (questionResolverRef.value) {
             console.warn(`Sys: Socket error with pending question for ${socket.id}. Cancelling interaction.`);
            if(typeof questionResolverRef.value === 'function') {
                questionResolverRef.value('error'); // Resolve with 'error' status
            }
            questionResolverRef.value = null;
        }

         // Clear connection-specific state refs
         currentChangesLogRef.value = [];
         currentBaseDirRef.value = null;
         currentOriginalPromptRef.value = null;
         confirmAllRef.value = false;
         console.log(`🧹 Cleared connection state refs for ${socket.id} due to socket error.`);

         // Optionally, force disconnect the socket server-side?
         // socket.disconnect(true);
    });

    console.log(`Socket listeners setup for ${socket.id}`);
}

module.exports = { setupSocketListeners };