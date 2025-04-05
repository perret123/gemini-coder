let socket;

function initializeSocket() {
    try {
        socket = io(); // Assumes server is serving socket.io library at root

        // --- Standard Connection Events ---
        socket.on('connect', () => {
            console.log('Socket connected to server:', socket.id);
            if (typeof addLogMessage === 'function') {
                addLogMessage('🔌 Connected to server.', 'success');
            }
            // Only enable controls if start button isn't already disabled (mid-task)
            const startButton = document.getElementById('startButton');
            if (startButton && startButton.disabled === false) {
                 if (typeof setControlsEnabled === 'function') setControlsEnabled(true);
            }
             // Clear context on fresh connect? Maybe not, let task selection handle it.
             // if (typeof updateContextDisplay === 'function') updateContextDisplay([]);

        });

        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected from server. Reason:', reason);
            if (typeof addLogMessage === 'function') {
                addLogMessage(`🔌 Disconnected from server (${reason}). Please refresh or check connection.`, 'error');
            }
            if (typeof setControlsEnabled === 'function') setControlsEnabled(false); // Disable controls on disconnect
            if (typeof hideFeedback === 'function') hideFeedback();
            if (typeof hideQuestionInput === 'function') hideQuestionInput();
            if (typeof addContextLogEntry === 'function') addContextLogEntry('disconnect', `Disconnected: ${reason}`);

        });

        socket.on('connect_error', (error) => {
            console.error('Socket connection error:', error);
            if (typeof addLogMessage === 'function') {
                addLogMessage(`🔌 Connection Error: ${error.message}. Server might be down.`, 'error');
            }
            if (typeof setControlsEnabled === 'function') setControlsEnabled(false);
             if (typeof hideFeedback === 'function') hideFeedback();
            if (typeof hideQuestionInput === 'function') hideQuestionInput();
            if (typeof addContextLogEntry === 'function') addContextLogEntry('error', `Connection Error: ${error.message}`);
        });

        // --- Application Specific Events ---

        // General Log Messages
        socket.on('log', (data) => {
            if (data && data.message) {
                if (typeof addLogMessage === 'function') {
                    addLogMessage(data.message, data.type || 'info');
                } else {
                    // Fallback if logger isn't loaded
                    console.log(`Server Log [${data.type || 'info'}]: ${data.message}`);
                }
            }
        });

        // Initial Context State (when resuming)
        socket.on('context-update', (data) => {
            console.log("Received initial context state:", data);
            if (data && Array.isArray(data.changes)) {
                 if (typeof updateContextDisplay === 'function') {
                    updateContextDisplay(data.changes); // Use this for the bulk initial load
                 } else {
                     console.warn("Function 'updateContextDisplay' not found. Cannot display initial context.");
                 }
            } else {
                console.warn("Received invalid context-update data:", data);
                 // Clear context if data is bad?
                 if (typeof updateContextDisplay === 'function') updateContextDisplay([]);
            }
        });

        // Individual Context Log Entry (NEW)
        socket.on('context-log-entry', (data) => {
             console.log("Received context log entry:", data);
             if (data && data.type && data.text) {
                 if (typeof addContextLogEntry === 'function') {
                     addContextLogEntry(data.type, data.text);
                 } else {
                     console.warn("Function 'addContextLogEntry' not found. Cannot display context entry.");
                 }
             } else {
                 console.warn("Received invalid context-log-entry data:", data);
             }
        });


        // Confirmation Request from Server
        socket.on('confirmation-request', (data) => {
            if (data && data.message) {
                // Log the request itself
                if (typeof addLogMessage === 'function') {
                    addLogMessage(`⚠️ CONFIRMATION REQUIRED: ${data.message}`, 'confirm');
                }
                // Log the diff if provided
                if (data.diff && typeof data.diff === 'string') {
                    if (typeof addLogMessage === 'function') {
                         addLogMessage(data.diff, 'diff');
                    }
                }
                 // Show the modal dialog
                if (typeof showFeedback === 'function') {
                    showFeedback(data.message, (decision) => {
                        // Send the user's decision back
                        if (socket && socket.connected) {
                            socket.emit('user-feedback', { decision });
                             // Clear the callback immediately after sending
                             if (typeof hideFeedback === 'function') hideFeedback();
                        } else {
                            console.error("Socket not connected, cannot send feedback.");
                            if (typeof addLogMessage === 'function') addLogMessage("Cannot send confirmation: Not connected.", 'error');
                        }
                    });
                } else {
                    console.error("Function 'showFeedback' not found. Cannot ask for confirmation.");
                    // Maybe try to auto-deny? Or just log the failure
                    if (socket && socket.connected) socket.emit('user-feedback', { decision: 'error' });
                }
            } else {
                console.error("Received invalid confirmation request data:", data);
            }
        });

        // Question Request from Server
        socket.on('ask-question-request', (data) => {
            if (data && data.question) {
                 // Log the question
                if (typeof addLogMessage === 'function') {
                    addLogMessage(`❓ QUESTION FOR YOU: ${data.question}`, 'confirm');
                }
                // Show the input dialog
                if (typeof showQuestionInput === 'function') {
                    showQuestionInput(data.question, (answer) => {
                        // Send the user's answer back
                         if (socket && socket.connected) {
                            socket.emit('user-question-response', { answer });
                             // Clear the callback immediately after sending
                             if(typeof hideQuestionInput === 'function') hideQuestionInput();
                        } else {
                            console.error("Socket not connected, cannot send answer.");
                            if (typeof addLogMessage === 'function') addLogMessage("Cannot send answer: Not connected.", 'error');
                        }
                    });
                } else {
                     console.error("Function 'showQuestionInput' not found. Cannot ask question.");
                     if (socket && socket.connected) socket.emit('user-question-response', { answer: { type: 'error', value: 'UI cannot display question' } });
                }
            } else {
                 console.error("Received invalid question request data:", data);
            }
        });

        // Task Completion Signal
        socket.on('task-complete', (data) => {
            const message = data?.message || "Task finished successfully.";
            if (typeof addLogMessage === 'function') {
                addLogMessage(`✅ Task Finished: ${message}`, 'success');
            } else {
                console.log(`Task Complete: ${message}`);
            }
            if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Re-enable controls
            if (typeof hideFeedback === 'function') hideFeedback(); // Ensure modals are hidden
            if (typeof hideQuestionInput === 'function') hideQuestionInput();
            // Context entry for completion is now handled by 'context-log-entry'
            // if (typeof addContextLogEntry === 'function') addContextLogEntry('task_finished', message);
        });

        // Task Error Signal
        socket.on('task-error', (data) => {
            const message = data?.message || "An unknown error occurred.";
             if (typeof addLogMessage === 'function') {
                addLogMessage(`❌ Task Error: ${message}`, 'error');
            } else {
                console.error(`Task Error: ${message}`);
            }
            if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Re-enable controls on error
             if (typeof hideFeedback === 'function') hideFeedback();
            if (typeof hideQuestionInput === 'function') hideQuestionInput();
            // Context entry for error is now handled by 'context-log-entry'
            // if (typeof addContextLogEntry === 'function') addContextLogEntry('task_error', message);
        });

        console.log("Socket event listeners initialized.");
        return socket; // Return the initialized socket instance

    } catch (error) {
        console.error("Failed to initialize Socket.IO:", error);
        if (typeof addLogMessage === 'function') {
            addLogMessage(`Fatal Error: Could not initialize connection. ${error.message}`, 'error');
        } else {
            alert(`Fatal Error: Could not initialize connection. ${error.message}`);
        }
        if (typeof setControlsEnabled === 'function') setControlsEnabled(false); // Ensure controls are disabled
        return null; // Indicate failure
    }
}