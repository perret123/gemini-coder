let socket = null;
let currentConfirmationCallback = null;
let currentQuestionResponseCallback = null;

/**
 * Initializes the Socket.IO connection and sets up event listeners.
 * @returns {SocketIOClient.Socket} The initialized socket instance.
 */
function initializeSocket() {
  // Disconnect previous socket if exists and connected
  if (socket && socket.connected) {
    console.log("Disconnecting existing socket before reconnecting.");
    socket.disconnect();
  }

  console.log("Initializing new socket connection...");
  socket = io({ path: "/socket.io" }); // Use default path

  // --- Connection Lifecycle Events ---

  socket.on("connect", () => {
    console.log("Socket connected to server:", socket.id);
    if (typeof addLogMessage === "function") {
      addLogMessage("🔌 Connected to server.", "success", true);
    }
    // Hide disconnect notice
    const disconnectNotice = document.getElementById("disconnectNotice");
    if (disconnectNotice) {
      disconnectNotice.style.display = "none";
    }
    // Enable controls (optional, might depend on app logic)
    const taskControls = document.getElementById("taskControls");
    if (taskControls && typeof setControlsEnabled === 'function') {
      // Assuming controls should be enabled on connect if not mid-task
      // setControlsEnabled(true); // Be cautious if tasks can resume automatically
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected from server. Reason:", reason);
    if (typeof addLogMessage === "function") {
      addLogMessage(
        `🔌 Disconnected from server (${reason}). Please refresh or check connection.`,
        "error",
        true
      );
    }
    // Show disconnect notice
    const disconnectNotice = document.getElementById("disconnectNotice");
    if (disconnectNotice) {
      disconnectNotice.textContent = `Disconnected: ${reason}. Attempting to reconnect...`;
      disconnectNotice.style.display = "block";
    }
    // Disable controls on disconnect
    if (typeof setControlsEnabled === 'function') {
        setControlsEnabled(false); // Disable controls when disconnected
    }
     // Clear any pending callbacks on disconnect
    if (currentConfirmationCallback) {
        console.warn("Disconnecting with pending confirmation. Resolving as 'disconnect'.");
        currentConfirmationCallback("disconnect");
        currentConfirmationCallback = null;
    }
    if (currentQuestionResponseCallback) {
        console.warn("Disconnecting with pending question. Resolving as 'disconnect'.");
        currentQuestionResponseCallback("disconnect");
        currentQuestionResponseCallback = null;
    }
  });

  socket.on("connect_error", (error) => {
    console.error("Socket connection error:", error);
    if (typeof addLogMessage === "function") {
      addLogMessage(
        `🔌 Connection Error: ${error.message}. Server might be down.`,
        "error",
        true
      );
    }
    // Show detailed error in disconnect notice
    const disconnectNotice = document.getElementById("disconnectNotice");
    if (disconnectNotice) {
      disconnectNotice.textContent = `Connection Error: ${error.message}. Retrying...`;
      disconnectNotice.style.display = "block";
    }
     // Disable controls on connection error
     if (typeof setControlsEnabled === 'function') {
        setControlsEnabled(false);
    }
  });

  // --- Custom Application Events ---

  socket.on("log", (data) => {
    if (data && data.message) {
      if (typeof addLogMessage === "function") {
        const isAction = data.isAction || false; // Default isAction to false
        addLogMessage(data.message, data.type || "info", isAction);
      } else {
        // Fallback if addLogMessage isn't available
        console.log(`Server Log [${data.type || "info"}]: ${data.message}`);
      }
    } else {
      console.warn("Received incomplete log data:", data);
    }
  });

  // *** !!! THIS IS THE CORRECTED LISTENER !!! ***
  socket.on("context-update", (data) => {
    console.log("Received context update:", data);

    // Ensure the necessary UI update functions exist
    const canUpdateFull = typeof updateContextDisplay === 'function';
    const canAddEntry = typeof addContextLogEntry === 'function';

    if (!canUpdateFull && !canAddEntry) {
        console.warn("Neither updateContextDisplay nor addContextLogEntry function available for context update.");
        return;
    }

    // Check if it's a full update (contains the 'changes' array)
    if (data && data.changes && Array.isArray(data.changes)) {
        if (canUpdateFull) {
            console.log(`Processing full context update with ${data.changes.length} items.`);
            // The 'false' here indicates it's not the initial load *from localStorage*,
            // but rather a full update from the server. updateContextDisplay handles saving.
            updateContextDisplay(data.changes, false);
        } else {
            console.warn("Received full context update, but updateContextDisplay function is missing.");
            // Maybe try to add entries one by one if addContextLogEntry exists? (Less ideal)
            if (canAddEntry) {
                 console.warn("Attempting to add entries individually (less efficient).");
                 data.changes.forEach(entry => {
                     if(entry && entry.type && typeof entry.text !== 'undefined') {
                         addContextLogEntry(entry.type, entry.text);
                     }
                 });
            }
        }
    }
    // Check if it's a single entry update (contains 'type' and 'text')
    else if (data && typeof data === 'object' && data.type && typeof data.text !== 'undefined') {
        if (canAddEntry) {
            console.log(`Adding single context entry: ${data.type} - ${String(data.text).substring(0, 50)}...`);
            addContextLogEntry(data.type, data.text);
        } else {
            console.warn("Received single context entry, but addContextLogEntry function is missing.");
            // If only full update is possible, this single entry might get lost unless
            // we fetch the current state, add to it, and call updateContextDisplay (complex).
        }
    }
    // Handle unexpected data structures
    else {
        console.warn("Received context update with unexpected data structure:", data);
        if(typeof addLogMessage === 'function') {
            addLogMessage(`[WARN] Received invalid context data structure from server: ${JSON.stringify(data)}`, 'warn');
        }
    }
});


  socket.on("confirmation-request", (data) => {
    if (data && data.message) {
      // Log the request first
      if (typeof addLogMessage === "function") {
        addLogMessage(`⚠️ CONFIRMATION REQUIRED: ${data.message}`, "confirm", true);
      }
      // Log the diff if present
      if (data.diff && typeof data.diff === "string" && data.diff.trim() !== "" && data.diff !== "(No changes)") {
        if (typeof addLogMessage === "function") {
            addLogMessage(data.diff, "diff");
        } else {
            console.log("Diff:\n", data.diff);
        }
      } else if (data.diff === "(No changes)") {
         if (typeof addLogMessage === "function") {
            addLogMessage("(No file content changes)", "info");
         }
      }

      // Show the feedback UI
      if (typeof showFeedback === "function") {
        // Clear any existing callback first (safety)
        if (currentConfirmationCallback) {
            console.warn("New confirmation request received while another was pending. Overwriting old callback.");
            // Optionally, auto-reject the previous one or log an error
            // currentConfirmationCallback('error');
        }

        currentConfirmationCallback = (userResponse) => {
          const confirmed = userResponse === 'yes' || userResponse === 'yes/all';
          console.log(`Sending confirmation response: Confirmed=${confirmed}, Decision='${userResponse}'`);
          socket.emit("confirmation-response", { confirmed: confirmed, decision: userResponse });
          currentConfirmationCallback = null; // Clear callback after use

          // Re-enable controls AFTER responding (server might disable again)
          // Consider if re-enabling should wait for task state update
          // if (typeof setControlsEnabled === 'function') {
          //   setControlsEnabled(true);
          // }
          if (typeof hideFeedback === 'function') {
             hideFeedback();
          }
        };

        // Pass the message and the newly created callback to the UI function
        showFeedback(data.message, currentConfirmationCallback);
        // Controls should have been disabled by showFeedback

      } else {
        console.error("showFeedback function not found. Cannot ask user for confirmation.");
        // Automatically reject if UI is unavailable
        socket.emit("confirmation-response", { confirmed: false, decision: 'error', error: 'UI component (showFeedback) not available' });
        if (typeof addLogMessage === "function") {
            addLogMessage("❌ UI Error: Could not display confirmation dialog. Action automatically rejected.", "error", true);
        }
        // Ensure controls are re-enabled if UI fails
        if (typeof setControlsEnabled === 'function') {
            setControlsEnabled(true);
        }
      }
    } else {
      console.error("Received invalid confirmation request data:", data);
      if (typeof addLogMessage === "function") {
            addLogMessage(`❌ Received invalid confirmation request from server.`, "error", true);
      }
       // Ensure controls are enabled if request is bad
       if (typeof setControlsEnabled === 'function') {
            setControlsEnabled(true);
        }
    }
  });

  socket.on("ask-question-request", (data) => {
    if (data && data.question) {
      if (typeof addLogMessage === "function") {
        addLogMessage(`❓ QUESTION FOR YOU: ${data.question}`, "confirm", true);
      }

      if (typeof showQuestionInput === "function") {
         // Clear any existing callback first (safety)
        if (currentQuestionResponseCallback) {
            console.warn("New question request received while another was pending. Overwriting old callback.");
            // currentQuestionResponseCallback('error');
        }

        currentQuestionResponseCallback = (userResponse) => {
          console.log(`Sending question response: ${JSON.stringify(userResponse)}`);
          socket.emit("question-response", { answer: userResponse });
          currentQuestionResponseCallback = null; // Clear callback after use

          // Re-enable controls AFTER responding
          // if (typeof setControlsEnabled === 'function') {
          //   setControlsEnabled(true);
          // }
           if (typeof hideQuestionInput === 'function') {
             hideQuestionInput();
          }
        };

        showQuestionInput(data.question, currentQuestionResponseCallback);
        // Controls should have been disabled by showQuestionInput

      } else {
        console.error("showQuestionInput function not found. Cannot ask user.");
        // Send error response if UI is unavailable
        socket.emit("question-response", { answer: { type: 'error', value: 'UI component (showQuestionInput) not available' } });
         if (typeof addLogMessage === "function") {
            addLogMessage("❌ UI Error: Could not display question dialog. Unable to answer.", "error", true);
        }
        // Ensure controls are re-enabled if UI fails
        if (typeof setControlsEnabled === 'function') {
            setControlsEnabled(true);
        }
      }
    } else {
      console.error("Received invalid question request data:", data);
       if (typeof addLogMessage === "function") {
            addLogMessage(`❌ Received invalid question request from server.`, "error", true);
        }
        // Ensure controls are enabled if request is bad
       if (typeof setControlsEnabled === 'function') {
            setControlsEnabled(true);
        }
    }
  });


  // --- Task Status Events ---

  socket.on("task-running", () => {
    console.log("Server signaled task is running.");
    if (typeof addLogMessage === "function") {
      addLogMessage("⏳ Task is running...", "info", true);
    }
    // Update button state visually (e.g., disable start, show "Running...")
    if (typeof updateTaskControlButtonState === "function") {
      updateTaskControlButtonState(true); // true = running
    } else if (typeof setControlsEnabled === 'function') {
        setControlsEnabled(false); // General disable as fallback
    }
  });

  socket.on("task-complete", (data) => {
    const message = data?.message || "Task finished successfully.";
    console.log("Server signaled task complete:", message);
    if (typeof addLogMessage === "function") {
      addLogMessage(`✅ Task Finished: ${message}`, "success", true);
    }
    // Update button state (e.g., re-enable start button)
    if (typeof updateTaskControlButtonState === "function") {
      updateTaskControlButtonState(false); // false = not running
    } else if (typeof setControlsEnabled === 'function') {
        setControlsEnabled(true); // General enable as fallback
    }
     // Emit internal event to potentially save state (listened for in socketListeners.js on server)
     socket.emit("task-complete", data);
  });

  socket.on("task-error", (data) => {
    const message = data?.message || "An unknown error occurred.";
    console.error("Server signaled task error:", message);
    if (typeof addLogMessage === "function") {
      addLogMessage(`❌ Task Error: ${message}`, "error", true);
    }
    // Update button state (e.g., re-enable start button)
    if (typeof updateTaskControlButtonState === "function") {
      updateTaskControlButtonState(false); // false = not running
    } else if (typeof setControlsEnabled === 'function') {
        setControlsEnabled(true); // General enable as fallback
    }
    // Emit internal event to potentially clear state (listened for in socketListeners.js on server)
    socket.emit("task-error", data);
  });

  // --- Other Events ---

  socket.on("display-image", (data) => {
    if (data && data.imageUrl && data.prompt) {
      console.log(`Received image to display for prompt: ${data.prompt}`);
      if (typeof addLogMessage === "function") {
        addLogMessage(`🖼️ Received image for prompt: \"${data.prompt}\"`, "info", true);
      }
      if (typeof displayImageResult === "function") {
        displayImageResult(data.imageUrl, data.prompt);
      } else {
        console.warn("displayImageResult function not available to show image.");
      }
    } else {
      console.warn("Received invalid display-image data:", data);
    }
  });


  console.log("Socket initialization complete. Event listeners attached.");
  return socket;
}

/**
 * Sends task details to the server to initiate processing.
 * @param {object} taskDetails - The details of the task (baseDir, prompt, etc.).
 */
function sendTaskToServer(taskDetails) {
  if (socket && socket.connected) {
    socket.emit("start-task", taskDetails);
    console.log("Task details sent to server:", taskDetails);
    // Optionally disable controls immediately after sending
    if (typeof setControlsEnabled === 'function') {
       // setControlsEnabled(false); // Server's "task-running" might be preferred
    }
  } else {
    console.error("Socket not connected. Cannot send task.");
    if (typeof addLogMessage === "function") {
      addLogMessage("❌ Error: Not connected to server. Cannot start task.", "error", true);
    }
    // Ensure controls are visually consistent if sending fails
    if (typeof updateTaskControlButtonState === "function") {
      updateTaskControlButtonState(false); // Ensure button shows "Start Task"
    } else if(typeof setControlsEnabled === 'function') {
        setControlsEnabled(true); // Ensure controls enabled if start fails
    }
  }
}

/**
 * Sends a generic message to the server.
 * @param {string} type - The event type/name.
 * @param {any} data - The data payload.
 */
function sendMessage(type, data) {
    if (socket && socket.connected) {
        socket.emit(type, data);
    } else {
        console.error(`Socket not connected. Cannot send message type: ${type}`);
         if (typeof addLogMessage === "function") {
             // Avoid logging for very frequent messages if needed
             // addLogMessage(`❌ Error: Not connected. Cannot send '${type}'.`, "error");
         }
    }
}

// --- Optional Helper ---
/**
 * Updates the visual state of the main task control button.
 * @param {boolean} isRunning - True if the task is running, false otherwise.
 */
function updateTaskControlButtonState(isRunning) {
    const startButton = document.getElementById('startButton');
    const controlsToDisable = [
        "baseDir", "prompt", "continueContext", "temperatureSlider",
        "imageUpload", "customUploadTrigger", "taskList"
    ];

    if (typeof setControlsEnabled === 'function') {
        setControlsEnabled(!isRunning); // Enable controls if not running, disable if running
    } else {
        // Fallback: manually disable/enable known controls
        console.warn("setControlsEnabled function not available, using manual fallback.");
        controlsToDisable.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                if (id === "taskList") {
                    element.style.pointerEvents = isRunning ? "none" : "auto";
                    element.style.opacity = isRunning ? "0.7" : "1";
                } else {
                    element.disabled = isRunning;
                }
            }
        });
        if (startButton) startButton.disabled = isRunning;
    }

    // Update button text/appearance specifically
    if (startButton) {
        startButton.textContent = isRunning ? "⏳ Running..." : "Start Task";
        // Maybe add/remove a CSS class for styling
        // startButton.classList.toggle('running', isRunning);
    }
}


// --- Module Exports ---
// Ensure this runs only in environments that support modules (like Node.js tests, not browser)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializeSocket,
    sendTaskToServer,
    sendMessage,
    updateTaskControlButtonState // Export helper if needed elsewhere
  };
}