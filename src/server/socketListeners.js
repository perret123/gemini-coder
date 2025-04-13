// c:\dev\gemini-coder\src\server\socketListeners.js
import { emitLog, emitContextLogEntry } from "./utils.js"; // Added .js
// Import specific file system function if needed, e.g., for undo (currently not used here)
// import { performUndoOperation } from "./fileSystem/index.js"; // Added .js

// --- State Saving Logic ---
export function saveCurrentTaskState(socket, state) {
    const { taskStates, connectionState } = state;
    // Destructure refs for clarity
    const { currentChangesLogRef, currentBaseDirRef, currentOriginalPromptRef } = connectionState;

    const baseDir = currentBaseDirRef.value;
    const changes = currentChangesLogRef.value; // Get the array from the ref
    const originalPrompt = currentOriginalPromptRef.value;

    // Ensure necessary data is present before saving
    if (!baseDir) {
        emitLog(socket, `ℹ️ Cannot save task state: Base directory not set for this task run.`, "info");
        currentChangesLogRef.value = []; // Clear log even if not saved
        return;
    }
    if (!originalPrompt) {
        // This indicates an internal logic error if a task ran without an original prompt recorded
        emitLog(socket, `⚠️ Cannot save task state for ${baseDir}: Original prompt is missing. State NOT saved.`, "warn", true);
        currentChangesLogRef.value = []; // Clear log
        return;
    }

    const existingState = taskStates.get(baseDir);
    // Check if saved state exists and if it belongs to the same original prompt
    const promptMatches = existingState?.originalPrompt === originalPrompt;

    // Save if:
    // 1. There are new changes in this segment.
    // 2. No state exists for this baseDir yet.
    // 3. State exists, but it"s for a *different* original prompt (replace it).
    if (changes.length > 0 || !existingState || !promptMatches) {
        let stateToSave;
        if (existingState && promptMatches) {
            // Merge new changes with existing changes for the same task
            const mergedChanges = [...existingState.changes, ...changes];
            emitLog(socket, `💾 Merging ${changes.length} new changes with existing state for ${baseDir}. Total changes: ${mergedChanges.length}.`, "info", true);
            if (changes.length > 0) emitLog(socket, ` (Note: Merged change list may contain redundant operations if task was complex)`, "debug");
            stateToSave = {
                originalPrompt: originalPrompt,
                baseDir: baseDir,
                changes: mergedChanges, // Store merged list
                timestamp: Date.now()
            };
        } else {
            // Create new state or replace state for different prompt
            if (existingState && !promptMatches) {
                emitLog(socket, `💾 Replacing previous state for ${baseDir} due to different original prompt.`, "info", true);
            } else { // No existing state
                emitLog(socket, `💾 Saving initial task state for ${baseDir} with ${changes.length} changes.`, "info", true);
            }
            stateToSave = {
                originalPrompt: originalPrompt,
                baseDir: baseDir,
                changes: [...changes], // Save a copy of the current changes
                timestamp: Date.now()
            };
        }
        taskStates.set(baseDir, stateToSave); // Update the global map
        emitLog(socket, ` ✅ State saved for base directory: ${baseDir}.`, "info", true);
        emitContextLogEntry(socket, "info", `Task state saved.`); // Inform user via context log
    } else {
        // No new changes in this segment for the current task
        emitLog(socket, `ℹ️ No file changes detected in this run segment for ${baseDir}. State not updated.`, "info");
    }

    // Always clear the *current* change log ref after attempting save
    currentChangesLogRef.value = [];
    emitLog(socket, `🧹 Cleared current change log for connection ${socket.id}.`, "debug");
}


// --- Socket Event Listener Setup ---
export function setupSocketListeners(socket, state) {
    const { taskStates, activeChatSessions, connectionState } = state;
    const {
        feedbackResolverRef,
        questionResolverRef,
        currentChangesLogRef,
        currentBaseDirRef,
        currentOriginalPromptRef,
        confirmAllRef // Destructure refs
    } = connectionState;

    // Handle user confirmation response
    socket.on("confirmation-response", (data) => {
        const decision = data?.decision; // e.g., "yes", "no", "yes/all"
        const confirmed = data?.confirmed; // Boolean derived on client
        emitLog(socket, `Received confirmation response: Decision="${decision}", Confirmed=${confirmed}`, "info");

        // Check if a resolver function exists in the ref
        if (feedbackResolverRef.value && typeof feedbackResolverRef.value === "function") {
            feedbackResolverRef.value(decision); // Resolve the promise in the handler
            feedbackResolverRef.value = null; // Clear the resolver ref
        } else {
            // Log warning if response received unexpectedly
            emitLog(socket, `⚠️ Warning: Received confirmation response "${decision}" but no confirmation was actively pending for ${socket.id}. Ignoring.`, "warn");
        }
    });

    // Handle user question response
    socket.on("question-response", (data) => {
        const answer = data?.answer; // Can be { type: "text", value: "..." } or { type: "button", value: "yes"/"no" }
        emitLog(socket, `Received user question response: ${JSON.stringify(answer)}`, "info");

        if (questionResolverRef.value && typeof questionResolverRef.value === "function") {
            questionResolverRef.value(answer); // Resolve the promise
            questionResolverRef.value = null; // Clear the ref
        } else {
            emitLog(socket, `⚠️ Warning: Received user question response "${JSON.stringify(answer)}" but no question was actively pending for ${socket.id}. Ignoring.`, "warn");
        }
    });

    // Handle signal from client that task is considered complete from its perspective
    // (This primarily triggers state saving on the server)
    socket.on("task-complete", (data) => {
        const message = data?.message || "Completed.";
        // Use prompt from data if available, otherwise use current ref value
        const promptForState = data?.originalPromptForState || currentOriginalPromptRef.value;

        emitLog(socket, `Internal: task-complete signal received for ${socket.id}. Saving state. Message: ${message}`, "debug");

        // Ensure the original prompt ref is correctly set for state saving
        if (promptForState && promptForState !== currentOriginalPromptRef.value) {
            emitLog(socket, `Using original prompt from event data ("${promptForState.substring(0,30)}..."). instead of ref ("${currentOriginalPromptRef.value?.substring(0,30)}..."). for state saving.`, "debug");
            currentOriginalPromptRef.value = promptForState;
        } else if (!currentOriginalPromptRef.value && promptForState) {
            // If ref was null, set it from data
            currentOriginalPromptRef.value = promptForState;
        }

        // Save the state accumulated during the task run
        saveCurrentTaskState(socket, state);
        confirmAllRef.value = false; // Reset confirm all flag
    });

    // Handle signal from client about task error
    socket.on("task-error", (data) => {
        const message = data?.message || "Unknown error.";
        emitLog(socket, `Internal: task-error signal received for ${socket.id}. Discarding current changes. Message: ${message}`, "debug");
        // Discard any unsaved changes for this segment upon error
        currentChangesLogRef.value = [];
        emitLog(socket, `🧹 Discarded unsaved changes for connection ${socket.id} due to error.`, "warn", true);
        confirmAllRef.value = false; // Reset confirm all flag
    });

    // Handle user disconnection
    socket.on("disconnect", (reason) => {
        console.log(`🔌 User disconnected: ${socket.id}. Reason: ${reason}`);

        // Clean up active session if exists
        if (activeChatSessions.has(socket.id)) {
            activeChatSessions.delete(socket.id);
            console.log(`🧹 Cleared active chat session for disconnected user: ${socket.id}`);
        }

        // Cancel any pending interactions by resolving their promises
        if (feedbackResolverRef.value) {
            console.log(`Sys: User disconnected with pending confirmation for ${socket.id}. Cancelling interaction.`);
            if (typeof feedbackResolverRef.value === "function") {
                feedbackResolverRef.value("disconnect"); // Resolve with "disconnect" signal
            }
            feedbackResolverRef.value = null; // Clear ref
        }
        if (questionResolverRef.value) {
            console.log(`Sys: User disconnected with pending question for ${socket.id}. Cancelling interaction.`);
            if (typeof questionResolverRef.value === "function") {
                questionResolverRef.value("disconnect"); // Resolve with "disconnect" signal
            }
            questionResolverRef.value = null; // Clear ref
        }

        // Clear connection state refs
        currentChangesLogRef.value = [];
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        confirmAllRef.value = false;
        console.log(`🧹 Cleared connection state refs for ${socket.id}.`);
    });

    // Handle underlying socket errors
    socket.on("error", (err) => {
        console.error(` Socket error for ${socket.id}:`, err);
        emitLog(socket, `Critical socket error: ${err.message}. Please refresh.`, "error", true);
        emitContextLogEntry(socket, "error", `Socket Error: ${err.message}`);

        // Cancel pending interactions on socket error
        if (feedbackResolverRef.value) {
            console.warn(`Sys: Socket error with pending confirmation for ${socket.id}. Cancelling interaction.`);
            if(typeof feedbackResolverRef.value === "function") {
                feedbackResolverRef.value("error"); // Resolve with "error" signal
            }
            feedbackResolverRef.value = null;
        }
        if (questionResolverRef.value) {
             console.warn(`Sys: Socket error with pending question for ${socket.id}. Cancelling interaction.`);
            if(typeof questionResolverRef.value === "function") {
                questionResolverRef.value("error"); // Resolve with "error" signal
            }
            questionResolverRef.value = null;
        }

        // Clear connection state refs
        currentChangesLogRef.value = [];
        currentBaseDirRef.value = null;
        currentOriginalPromptRef.value = null;
        confirmAllRef.value = false;
        console.log(`🧹 Cleared connection state refs for ${socket.id} due to socket error.`);
    });

    console.log(`Socket listeners setup for ${socket.id}`);
}
