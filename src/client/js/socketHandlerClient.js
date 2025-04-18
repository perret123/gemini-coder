// c:\dev\gemini-coder\src\client\js\socketHandlerClient.js
import { io } from "socket.io-client";
import { addLogMessage } from "./logger.js";
import {
  setControlsEnabled,
  updateContextDisplay,
  addContextLogEntry,
  showFeedback,
  hideFeedback,
  showQuestionInput,
  hideQuestionInput,
  displayImageResult, // Assuming this is now in uiHelpers
} from "./uiHelpers.js";

// Module-level state
let socket = null;
let currentConfirmationCallback = null; // Stores resolve function for confirmation promise
let currentQuestionResponseCallback = null; // Stores resolve function for question promise

// Function to initialize the socket connection and set up listeners
export function initializeSocket() {
  // Disconnect existing socket if trying to re-initialize (e.g., on manual refresh)
  if (socket && socket.connected) {
    console.log("Disconnecting existing socket before reconnecting.");
    socket.disconnect();
  }

  console.log("Initializing new socket connection...");
  // Connect to the server (path is important if server uses a specific path)
  // Use relative path if served from same origin, otherwise full URL
  socket = io({ path: "/socket.io" }); // Matches default server path

  // --- Socket Event Listeners ---

  socket.on("connect", () => {
    console.log("Socket connected to server:", socket.id);
    addLogMessage("🔌 Connected to server.", "success", true);

    // Hide disconnect notice if shown
    const disconnectNotice = document.getElementById("disconnectNotice");
    if (disconnectNotice) {
      disconnectNotice.style.display = "none";
    }
    // Enable controls on connect (initial state or reconnect)
    setControlsEnabled(true); // Now uses imported function
    // Update button state might be needed if connection drops mid-task
    updateTaskControlButtonState(false); // Set button to "Start Task"
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected from server. Reason:", reason);
    addLogMessage(
      `🔌 Disconnected from server (${reason}). Please refresh or check connection.`,
      "error",
      true,
    );

    // Show disconnect notice
    const disconnectNotice = document.getElementById("disconnectNotice");
    if (disconnectNotice) {
      disconnectNotice.textContent = `Disconnected: ${reason}. Attempting to reconnect...`;
      disconnectNotice.style.display = "block";
    }
    // Disable controls on disconnect
    setControlsEnabled(false);
    updateTaskControlButtonState(false); // Ensure button reflects disconnected state

    // Handle pending interactions on disconnect
    if (currentConfirmationCallback) {
      console.warn(
        `Disconnecting with pending confirmation. Resolving as "disconnect"`,
      );
      currentConfirmationCallback("disconnect"); // Resolve promise with "disconnect"
      currentConfirmationCallback = null; // Clear callback
    }
    if (currentQuestionResponseCallback) {
      console.warn(
        `Disconnecting with pending question. Resolving as "disconnect"`,
      );
      currentQuestionResponseCallback("disconnect"); // Resolve promise with "disconnect"
      currentQuestionResponseCallback = null; // Clear callback
    }
  });

  socket.on("connect_error", (error) => {
    console.error("Socket connection error:", error);
    addLogMessage(
      `🔌 Connection Error: ${error.message}. Server might be down.`,
      "error",
      true,
    );

    // Show detailed error notice
    const disconnectNotice = document.getElementById("disconnectNotice");
    if (disconnectNotice) {
      disconnectNotice.textContent = `Connection Error: ${error.message}. Retrying...`;
      disconnectNotice.style.display = "block";
    }
    setControlsEnabled(false); // Disable controls on connection error
    updateTaskControlButtonState(false); // Ensure button reflects error state
  });

  // Listener for server logs
  socket.on("log", (data) => {
    if (data && data.message) {
      const isAction = data.isAction || false;
      addLogMessage(data.message, data.type || "info", isAction);
    } else {
      console.warn("Received incomplete log data:", data);
    }
  });

  // Listener for context updates (full or partial)
  socket.on("context-update", (data) => {
    console.log("Received context update:", data);

    // Check if it"s a full update (contains "changes" array)
    if (data && data.changes && Array.isArray(data.changes)) {
      console.log(
        `Processing full context update with ${data.changes.length} items.`,
      );
      updateContextDisplay(data.changes, false); // Update the entire display
    }
    // Check if it"s a single entry update
    else if (
      data &&
      typeof data === "object" &&
      data.type &&
      typeof data.text !== "undefined"
    ) {
      console.log(
        `Adding single context entry: ${data.type} - ${String(data.text).substring(0, 50)}...`,
      );
      addContextLogEntry(data.type, data.text); // Add single entry
    } else {
      console.warn(
        "Received context update with unexpected data structure:",
        data,
      );
      addLogMessage(
        `[WARN] Received invalid context data structure from server: ${JSON.stringify(data)}`,
        "warn",
      );
    }
  });

  // Listener for confirmation requests from the server
  socket.on("confirmation-request", (data) => {
    if (data && data.message) {
      addLogMessage(
        `⚠️ CONFIRMATION REQUIRED: ${data.message}`,
        "confirm",
        true,
      );

      // Display diff if provided and not empty/no changes
      if (
        data.diff &&
        typeof data.diff === "string" &&
        data.diff.trim() !== "" &&
        data.diff !== "(No changes)"
      ) {
        addLogMessage(data.diff, "diff");
      } else if (data.diff === "(No changes)") {
        addLogMessage("(No file content changes)", "info");
      }

      // Show feedback modal and set up callback
      if (currentConfirmationCallback) {
        console.warn(
          "New confirmation request received while another was pending. Overwriting old callback.",
        );
        // Optionally resolve the old one as "cancelled"?
        // currentConfirmationCallback("cancelled_by_new_request");
      }
      // Create the callback function that will be called by the modal button listeners
      currentConfirmationCallback = (userResponse) => {
        // userResponse = "yes", "no", "yes/all", "disconnect", "error", "task-end"
        const confirmed = userResponse === "yes" || userResponse === "yes/all";
        console.log(
          `Sending confirmation response: Confirmed=${confirmed}, Decision="${userResponse}"`,
        );
        socket.emit("confirmation-response", {
          confirmed: confirmed,
          decision: userResponse,
        });
        currentConfirmationCallback = null; // Clear callback after use
        hideFeedback(); // Hide modal after response sent
        // Controls are typically re-enabled by task-complete/task-error, not here
      };
      showFeedback(data.message, currentConfirmationCallback); // Show the modal
    } else {
      console.error("Received invalid confirmation request data:", data);
      addLogMessage(
        `❌ Received invalid confirmation request from server.`,
        "error",
        true,
      );
      setControlsEnabled(true); // Re-enable controls if request was bad
      updateTaskControlButtonState(false);
    }
  });

  // Listener for questions from the server
  socket.on("ask-question-request", (data) => {
    if (data && data.question) {
      addLogMessage(`❓ QUESTION FOR YOU: ${data.question}`, "confirm", true);

      if (currentQuestionResponseCallback) {
        console.warn(
          "New question request received while another was pending. Overwriting old callback.",
        );
      }

      // Setup callback for when user responds via modal
      currentQuestionResponseCallback = (userResponse) => {
        // userResponse = {type:"text"/"button", value:"..."} or "disconnect"/"error"/"task-end"
        console.log(
          `Sending question response: ${JSON.stringify(userResponse)}`,
        );
        socket.emit("question-response", { answer: userResponse }); // Send answer object
        currentQuestionResponseCallback = null; // Clear callback
        hideQuestionInput(); // Hide modal after response
        // Controls re-enabled by task-complete/task-error
      };
      showQuestionInput(data.question, currentQuestionResponseCallback); // Show modal
    } else {
      console.error("Received invalid question request data:", data);
      addLogMessage(
        `❌ Received invalid question request from server.`,
        "error",
        true,
      );
      setControlsEnabled(true); // Re-enable controls if request was bad
      updateTaskControlButtonState(false);
    }
  });

  // Listener for task status updates
  socket.on("task-running", () => {
    console.log("Server signaled task is running.");
    addLogMessage("⏳ Task is running...", "info", true);
    updateTaskControlButtonState(true); // Update button to "Running..." state
  });

  socket.on("task-complete", (data) => {
    const message = data?.message || "Task finished successfully.";
    console.log("Server signaled task complete:", message);
    addLogMessage(`✅ Task Finished: ${message}`, "success", true);
    updateTaskControlButtonState(false); // Update button to "Start Task"
    setControlsEnabled(true); // Re-enable all controls
    // Server side handles state saving, client just updates UI
    // Client might need to signal back receipt? Server `task-complete` listener handles this.
    // socket.emit("task-complete-ack", { messageId: data?.id }); // Example ack
  });

  socket.on("task-error", (data) => {
    const message = data?.message || "An unknown error occurred.";
    console.error("Server signaled task error:", message);
    addLogMessage(`❌ Task Error: ${message}`, "error", true);
    updateTaskControlButtonState(false); // Update button to "Start Task"
    setControlsEnabled(true); // Re-enable all controls
    // Server side handles state clearing, client just updates UI
    // socket.emit("task-error-ack", { messageId: data?.id }); // Example ack
  });

  // Listener to display images (e.g., generated by AI)
  socket.on("display-image", (data) => {
    if (data && data.imageUrl && data.prompt) {
      console.log(`Received image to display for prompt: ${data.prompt}`);
      addLogMessage(
        `🖼️ Received image for prompt: "${data.prompt}"`,
        "info",
        true,
      );
      displayImageResult(data.imageUrl, data.prompt); // Call the UI helper
    } else {
      console.warn("Received invalid display-image data:", data);
    }
  });

  console.log("Socket initialization complete. Event listeners attached.");
  return socket; // Return the initialized socket instance
}

// Function to send task details to the server
export function sendTaskToServer(taskDetails) {
  if (socket && socket.connected) {
    socket.emit("start-task", taskDetails); // Use "start-task" event
    console.log("Task details sent to server:", taskDetails);
    updateTaskControlButtonState(true); // Set button to running immediately on send
    // setControlsEnabled(false); // Controls are disabled in handleStartTaskClick before calling this
  } else {
    console.error("Socket not connected. Cannot send task.");
    addLogMessage(
      "❌ Error: Not connected to server. Cannot start task.",
      "error",
      true,
    );
    updateTaskControlButtonState(false); // Reset button if send fails
    setControlsEnabled(true); // Re-enable controls if send fails due to connection
  }
}

// Generic message sender (if needed for other events)
export function sendMessage(type, data) {
  if (socket && socket.connected) {
    socket.emit(type, data);
  } else {
    console.error(`Socket not connected. Cannot send message type: ${type}`);
    // Optionally log error to UI
    // addLogMessage(`❌ Error: Not connected. Cannot send message: ${type}`, "error");
  }
}

// --- UI State Update specific to task button ---
// This could potentially be merged into setControlsEnabled, but separated for clarity
export function updateTaskControlButtonState(isRunning) {
  const startButton = document.getElementById("startButton");
  if (!startButton) return;

  startButton.disabled = isRunning;
  startButton.textContent = isRunning ? "⏳ Running..." : "Start Task";

  // We rely on setControlsEnabled to disable other inputs, but ensure start button state is correct.
  // If setControlsEnabled is not available, this function provides a basic fallback.
  if (typeof setControlsEnabled !== "function") {
    console.warn(
      "setControlsEnabled function not available, using manual fallback in updateTaskControlButtonState.",
    );
    const controlsToDisable = [
      "baseDir",
      "prompt",
      "continueContext",
      "temperatureSlider",
      "imageUpload",
      "customUploadTrigger",
      "taskList",
    ];
    controlsToDisable.forEach((id) => {
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
  }
}

// No need for module.exports check
