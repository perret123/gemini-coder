/* eslint-disable @typescript-eslint/no-unused-vars */
// c:\dev\gemini-coder\src\client\js\uiHelpers.js
import { addLogMessage } from "./logger.js"; // Import necessary functions

// Module-level state for callbacks and context
let currentFeedbackCallback = null;
let currentQuestionCallback = null;
let currentContextArray = [];
const CONTEXT_STORAGE_KEY = "geminiCoder_activeTaskContext";

// --- Local Storage ---
export function saveContextToLocalStorage() {
  try {
    localStorage.setItem(
      CONTEXT_STORAGE_KEY,
      JSON.stringify(currentContextArray),
    );
  } catch (e) {
    console.error("Error saving context to localStorage:", e);
    // Use addLogMessage if available, otherwise console.warn
    if (typeof addLogMessage === "function") {
      addLogMessage(
        "⚠️ Could not save context changes to local storage.",
        "warn",
        true,
      );
    } else {
      console.warn("⚠️ Could not save context changes to local storage.");
    }
  }
}

export function loadContextFromLocalStorage() {
  const contextList = document.getElementById("contextList");
  if (!contextList) {
    console.error("Element 'contextList' not found during context load.");
    return;
  }
  try {
    const storedContext = localStorage.getItem(CONTEXT_STORAGE_KEY);
    if (storedContext) {
      const parsedContext = JSON.parse(storedContext);
      if (Array.isArray(parsedContext)) {
        console.log(
          `Loading ${parsedContext.length} context items from localStorage.`,
        );
        // Update display and internal array, mark as loading from storage
        updateContextDisplay(parsedContext, true);
      } else {
        console.warn(
          "Invalid context data found in localStorage (not an array), clearing.",
        );
        clearContextAndStorage(); // Reset if data is invalid
      }
    } else {
      // No stored context found, initialize display as empty
      updateContextDisplay([], false); // Explicitly empty, not loading from storage
      console.log("No previous context found in localStorage.");
    }
  } catch (e) {
    console.error("Error loading context from localStorage:", e);
    if (typeof addLogMessage === "function") {
      addLogMessage(
        "⚠️ Could not load context from local storage.",
        "warn",
        true,
      );
    }
    clearContextAndStorage(); // Reset on error
  }
}

export function clearContextAndStorage() {
  updateContextDisplay([], false); // Update UI, mark as not loading from storage
  // currentContextArray is cleared within updateContextDisplay when isLoadingFromStorage is false
  try {
    localStorage.removeItem(CONTEXT_STORAGE_KEY);
    console.log("Cleared context display, in-memory array, and localStorage.");
  } catch (e) {
    console.error("Error removing context from localStorage:", e);
    if (typeof addLogMessage === "function") {
      addLogMessage(
        "⚠️ Failed to clear context from local storage.",
        "warn",
        true,
      );
    }
  }
}

// --- Drag and Drop Helpers ---
export function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

export function highlight() {
  const promptInput = document.getElementById("prompt");
  if (promptInput) {
    promptInput.classList.add("drag-over");
  }
}

export function unhighlight() {
  const promptInput = document.getElementById("prompt");
  if (promptInput) {
    promptInput.classList.remove("drag-over");
  }
}

export function handleDrop(e) {
  const imageUploadInput = document.getElementById("imageUpload");
  if (!imageUploadInput) {
    console.error("Element 'imageUpload' not found for drop handling.");
    return;
  }
  const dt = e.dataTransfer;
  const files = dt.files;

  if (files && files.length > 0) {
    try {
      // Create a new DataTransfer object to ensure the FileList is mutable
      const dataTransfer = new DataTransfer();
      Array.from(files).forEach((file) => dataTransfer.items.add(file));
      imageUploadInput.files = dataTransfer.files;

      // Manually dispatch a \'change" event so event listeners are triggered
      const event = new Event("change", { bubbles: true });
      imageUploadInput.dispatchEvent(event);
    } catch (err) {
      console.error("Error assigning dropped files to input:", err);
      if (typeof addLogMessage === "function") {
        addLogMessage(
          "⚠️ Error processing dropped files. Please use the attach button.",
          "warn",
          true,
        );
      }
      return; // Stop if assigning files failed
    }

    if (typeof addLogMessage === "function") {
      addLogMessage(
        `📁 ${files.length} file(s) dropped onto prompt area.`,
        "info",
        true,
      );
    }
  } else {
    // Log if a drop happened but no files were detected
    if (typeof addLogMessage === "function") {
      addLogMessage(
        "ℹ️ Drop event detected, but no files found.",
        "info",
        true,
      );
    }
  }
}

// --- UI Update Helpers ---
export function updateUploadTriggerText() {
  const imageUploadInput = document.getElementById("imageUpload");
  const customUploadTrigger = document.getElementById("customUploadTrigger");
  if (!imageUploadInput || !customUploadTrigger) {
    // Don"t log error here, might be called before DOM ready sometimes
    return;
  }
  const numFiles = imageUploadInput.files ? imageUploadInput.files.length : 0;
  if (numFiles > 0) {
    customUploadTrigger.textContent = `📎 ${numFiles}`;
    customUploadTrigger.title = `${numFiles} file(s) attached. Click to change or drop files here.`;
  } else {
    customUploadTrigger.textContent = "📎";
    customUploadTrigger.title = "Attach Files (or drop here)";
  }
}

// Renders a single context entry list item
function renderSingleContextEntry(type, text, contextListElement) {
  const li = document.createElement("li");
  li.classList.add("context-entry", `context-entry-${type}`); // Add type-specific class

  let prefix = "";
  // Assign prefixes based on type for visual cues
  switch (type) {
    case "initial_prompt":
      prefix = "📝";
      break; // Task start/prompt
    case "resume_prompt":
      prefix = "▶️";
      break; // Task resume
    case "question":
      prefix = "❓";
      break; // Question asked by AI
    case "answer":
      prefix = "🗣️";
      break; // Answer provided by user
    case "confirmation_request":
      prefix = "⚠️";
      break; // Confirmation needed
    case "confirmation_response":
      prefix = "👍";
      break; // User confirmation action
    case "createFile":
    case "updateFile":
    case "writeFileContent":
      prefix = "💾";
      break; // File write/update
    case "deleteFile":
      prefix = "🗑️";
      break; // File deletion
    case "createDirectory":
      prefix = "📁+";
      break; // Directory creation
    case "deleteDirectory":
      prefix = "📁-";
      break; // Directory deletion
    case "moveItem":
      prefix = "🚚";
      break; // File/Dir move
    case "readFileContent":
      prefix = "📄";
      break; // File read
    case "listFiles":
      prefix = " Ls ";
      break; // Directory listing
    case "searchFiles":
    case "searchFilesByRegex":
      prefix = "🔎";
      break; // Search operation
    case "info":
      prefix = "ℹ️";
      break; // General info from AI/System
    case "task_finished":
      prefix = "✅";
      break; // Task success
    case "task_error":
    case "error":
      prefix = "❌";
      break; // Task/System error
    case "initial_state":
      prefix = "🔄";
      break; // Initial state load/clear
    case "api_retry":
      prefix = "⏳";
      break; // API retry attempt
    case "user_wait":
      prefix = "👤";
      break; // Waiting for user input
    case "disconnect":
      prefix = "🔌";
      break; // Connection status
    case "warning":
      prefix = "⚠️";
      break; // General warning
    default:
      prefix = "⚙️"; // Default for unknown types
  }

  li.textContent = `${prefix} ${text}`; // Combine prefix and text
  contextListElement.appendChild(li);
}

export function updateContextDisplay(
  changes = [],
  isLoadingFromStorage = false,
) {
  const contextList = document.getElementById("contextList");
  if (!contextList) {
    console.error("Element 'contextList' not found for context display.");
    return;
  }

  contextList.innerHTML = ""; // Clear existing entries

  if (!changes || changes.length === 0) {
    // Display placeholder if context is empty
    const li = document.createElement("li");
    li.textContent = "(Context will appear here as the task progresses)";
    li.style.fontStyle = "italic";
    li.style.opacity = "0.7";
    li.classList.add("context-entry-info"); // Generic info style
    contextList.appendChild(li);
    // If this update isn"t from storage load, reset the array and save
    if (!isLoadingFromStorage) {
      currentContextArray = [];
      saveContextToLocalStorage();
    }
  } else {
    // Update the internal array
    // If loading from storage, replace the array entirely
    // Otherwise, it means a full update came from the server, so also replace
    currentContextArray = [...changes]; // Always replace with the new full list

    // Render each entry
    currentContextArray.forEach((entry) => {
      // Defensive check for entry structure
      if (entry && entry.type && typeof entry.text !== "undefined") {
        renderSingleContextEntry(entry.type, entry.text, contextList);
      } else {
        console.warn("Skipping invalid context entry:", entry);
      }
    });

    // Save the updated full context if this wasn"t just a load from storage
    if (!isLoadingFromStorage) {
      saveContextToLocalStorage();
    }
  }

  // Scroll to bottom
  requestAnimationFrame(() => {
    contextList.scrollTop = contextList.scrollHeight;
  });
}

// Adds a single new entry to the context log and saves
export function addContextLogEntry(type, text) {
  const contextList = document.getElementById("contextList");
  if (!contextList) {
    console.error("Element 'contextList' not found for adding context entry.");
    return;
  }

  // Remove placeholder if it exists
  const placeholder = contextList.querySelector(`li[style*="italic"]`);
  if (
    placeholder &&
    placeholder.textContent.includes("(Context will appear here")
  ) {
    contextList.removeChild(placeholder);
  }

  // Add to internal array and render
  const newEntry = { type, text };
  currentContextArray.push(newEntry);
  renderSingleContextEntry(type, text, contextList);

  // Save the updated context
  saveContextToLocalStorage();

  // Scroll to bottom
  requestAnimationFrame(() => {
    contextList.scrollTop = contextList.scrollHeight;
  });
}

export function setControlsEnabled(enabled) {
  const controlsToToggle = [
    "baseDir",
    "prompt",
    "continueContext",
    "temperatureSlider",
    "startButton",
    "imageUpload",
    "customUploadTrigger",
    "taskList",
  ];
  const feedbackButtons = ["confirmYes", "confirmNo", "confirmYesAll"];
  const questionElements = [
    "questionInput",
    "submitAnswer",
    "questionYes",
    "questionNo",
  ];

  // Toggle main controls
  controlsToToggle.forEach((id) => {
    const element = document.getElementById(id);
    if (element) {
      if (id === "taskList") {
        // Special handling for task list container (visual cue + interaction)
        element.style.pointerEvents = enabled ? "auto" : "none";
        element.style.opacity = enabled ? "1" : "0.7";
      } else {
        element.disabled = !enabled;
      }
    } else {
      // Don"t log warnings for taskList as it might not be present in all layouts
      if (id !== "taskList")
        console.warn(
          `Element with ID "${id}" not found for enabling/disabling.`,
        );
    }
  });

  // Enable/disable modal buttons only if the respective modal is visible
  const feedbackContainer = document.getElementById("feedbackContainer");
  const questionContainer = document.getElementById("questionContainer");

  const feedbackVisible =
    feedbackContainer && !feedbackContainer.classList.contains("hidden");
  feedbackButtons.forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = !enabled || !feedbackVisible;
  });

  const questionVisible =
    questionContainer && !questionContainer.classList.contains("hidden");
  questionElements.forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = !enabled || !questionVisible;
  });

  // Update start button text
  const startButton = document.getElementById("startButton");
  if (startButton) {
    startButton.textContent = enabled ? "Start Task" : "⏳ Running...";
    // Ensure start button itself is disabled correctly (redundant with above loop but safe)
    startButton.disabled = !enabled;
  }
}

// --- Modal Dialog Helpers ---
export function showFeedback(message, callback) {
  const feedbackMessage = document.getElementById("feedbackMessage");
  const feedbackContainer = document.getElementById("feedbackContainer");
  const confirmYesButton = document.getElementById("confirmYes");
  const confirmNoButton = document.getElementById("confirmNo");
  const confirmYesAllButton = document.getElementById("confirmYesAll");

  if (
    !feedbackMessage ||
    !feedbackContainer ||
    !confirmYesButton ||
    !confirmNoButton ||
    !confirmYesAllButton
  ) {
    console.error(
      "Feedback dialog elements not found (feedbackMessage, feedbackContainer, confirmYes, confirmNo, confirmYesAll).",
    );
    if (callback) callback("error"); // Signal error back if possible
    return;
  }

  feedbackMessage.textContent = message;
  feedbackContainer.classList.remove("hidden"); // Make visible
  currentFeedbackCallback = callback; // Store the callback

  hideQuestionInput(); // Hide the other modal if open
  setControlsEnabled(false); // Disable background controls

  // Ensure buttons are enabled (setControlsEnabled might have disabled them if modal wasn"t visible)
  confirmYesButton.disabled = false;
  confirmNoButton.disabled = false;
  confirmYesAllButton.disabled = false;
  confirmYesButton.focus(); // Focus for accessibility
}

export function hideFeedback() {
  const feedbackContainer = document.getElementById("feedbackContainer");
  if (feedbackContainer) {
    feedbackContainer.classList.add("hidden");
  }
  currentFeedbackCallback = null; // Clear callback

  // Disable buttons when hidden
  const confirmYesButton = document.getElementById("confirmYes");
  const confirmNoButton = document.getElementById("confirmNo");
  const confirmYesAllButton = document.getElementById("confirmYesAll");
  if (confirmYesButton) confirmYesButton.disabled = true;
  if (confirmNoButton) confirmNoButton.disabled = true;
  if (confirmYesAllButton) confirmYesAllButton.disabled = true;

  // Re-enable general controls *only if* the question modal is also hidden
  const questionContainer = document.getElementById("questionContainer");
  if (!questionContainer || questionContainer.classList.contains("hidden")) {
    // setControlsEnabled(true); // This might be called too early by socket events, let the calling context decide when to re-enable controls.
  }
}

export function showQuestionInput(question, callback) {
  const questionText = document.getElementById("questionText");
  const questionInput = document.getElementById("questionInput");
  const questionContainer = document.getElementById("questionContainer");
  const submitAnswerButton = document.getElementById("submitAnswer");
  const questionYesButton = document.getElementById("questionYes");
  const questionNoButton = document.getElementById("questionNo");

  if (
    !questionText ||
    !questionInput ||
    !questionContainer ||
    !submitAnswerButton ||
    !questionYesButton ||
    !questionNoButton
  ) {
    console.error(
      "Question dialog elements not found (questionText, questionInput, questionContainer, submitAnswer, questionYes, questionNo).",
    );
    if (callback) callback({ type: "error", value: "UI elements missing" });
    return;
  }

  questionText.textContent = question;
  questionInput.value = ""; // Clear previous input
  questionContainer.classList.remove("hidden");
  currentQuestionCallback = callback; // Store callback

  hideFeedback(); // Hide the other modal
  setControlsEnabled(false); // Disable background controls

  // Ensure inputs/buttons are enabled
  questionInput.disabled = false;
  submitAnswerButton.disabled = false;
  questionYesButton.disabled = false;
  questionNoButton.disabled = false;
  questionInput.focus(); // Focus on text input
}

export function hideQuestionInput() {
  const questionContainer = document.getElementById("questionContainer");
  if (questionContainer) {
    questionContainer.classList.add("hidden");
  }
  currentQuestionCallback = null; // Clear callback

  // Disable inputs/buttons when hidden
  const questionInput = document.getElementById("questionInput");
  const submitAnswerButton = document.getElementById("submitAnswer");
  const questionYesButton = document.getElementById("questionYes");
  const questionNoButton = document.getElementById("questionNo");
  if (questionInput) questionInput.disabled = true;
  if (submitAnswerButton) submitAnswerButton.disabled = true;
  if (questionYesButton) questionYesButton.disabled = true;
  if (questionNoButton) questionNoButton.disabled = true;

  // Re-enable general controls *only if* the feedback modal is also hidden
  const feedbackContainer = document.getElementById("feedbackContainer");
  if (!feedbackContainer || feedbackContainer.classList.contains("hidden")) {
    // setControlsEnabled(true); // Let the calling context decide when to re-enable controls.
  }
}

// Placeholder for image display logic used by socket handler
export function displayImageResult(imageUrl, promptText) {
  // TODO: Implement the actual logic to display the image
  // This might involve creating an <img> element, setting its src,
  // and appending it somewhere in the DOM, possibly the log or a dedicated area.
  console.log(
    `UI Helper: Would display image ${imageUrl} for prompt "${promptText}"`,
  );
  if (typeof addLogMessage === "function") {
    addLogMessage(`🖼️ Displaying image (placeholder): ${imageUrl}`, "info");
    // Example: Add image to log output
    const logOutput = document.getElementById("logOutput");
    if (logOutput) {
      const imgEntry = document.createElement("div");
      imgEntry.className = "log-entry log-image";
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = promptText;
      img.style.maxWidth = "90%"; // Basic styling
      img.style.maxHeight = "300px";
      img.style.marginTop = "5px";
      img.style.border = "1px solid var(--border-color)";
      img.style.borderRadius = "var(--border-radius)";
      imgEntry.appendChild(img);
      const caption = document.createElement("p");
      caption.textContent = `Image for: "${promptText}"`;
      caption.style.fontSize = "0.85em";
      caption.style.textAlign = "center";
      caption.style.color = "var(--text-secondary)";
      imgEntry.appendChild(caption);

      logOutput.appendChild(imgEntry);
      const logContainer = document.getElementById("logContainer");
      if (logContainer) {
        requestAnimationFrame(() => {
          logContainer.scrollTop = logContainer.scrollHeight;
        });
      }
    }
  }
}

// --- Initialize Modal Event Listeners ---
// This function should be called once the DOM is ready
export function initializeModalListeners() {
  const confirmYesButton = document.getElementById("confirmYes");
  const confirmNoButton = document.getElementById("confirmNo");
  const confirmYesAllButton = document.getElementById("confirmYesAll");
  const submitAnswerButton = document.getElementById("submitAnswer");
  const questionInput = document.getElementById("questionInput");
  const questionYesButton = document.getElementById("questionYes");
  const questionNoButton = document.getElementById("questionNo");

  // Feedback Button Listeners
  if (confirmYesButton) {
    confirmYesButton.addEventListener("click", () => {
      if (currentFeedbackCallback) {
        currentFeedbackCallback("yes");
      }
      // hideFeedback(); // Callback should handle hiding in socketHandlerClient
    });
  } else {
    console.warn("Button 'confirmYes' not found.");
  }

  if (confirmNoButton) {
    confirmNoButton.addEventListener("click", () => {
      if (currentFeedbackCallback) {
        currentFeedbackCallback("no");
      }
      // hideFeedback();
    });
  } else {
    console.warn("Button 'confirmNo' not found.");
  }

  if (confirmYesAllButton) {
    confirmYesAllButton.addEventListener("click", () => {
      if (currentFeedbackCallback) {
        currentFeedbackCallback("yes/all");
      }
      // hideFeedback();
    });
  } else {
    console.warn("Button 'confirmYesAll' not found.");
  }

  // Question Button/Input Listeners
  const submitQuestionText = () => {
    if (currentQuestionCallback && questionInput) {
      const answer = questionInput.value.trim();
      // Send answer back as structured object
      currentQuestionCallback({ type: "text", value: answer });
      // hideQuestionInput(); // Callback should handle hiding
    }
  };

  if (submitAnswerButton) {
    submitAnswerButton.addEventListener("click", submitQuestionText);
  } else {
    console.warn("Button 'submitAnswer' not found.");
  }

  if (questionInput) {
    // Submit on Enter key press (but not Shift+Enter)
    questionInput.addEventListener("keypress", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault(); // Prevent default newline behavior
        submitQuestionText();
      }
    });
  } else {
    console.warn("Input 'questionInput' not found.");
  }

  if (questionYesButton) {
    questionYesButton.addEventListener("click", () => {
      if (currentQuestionCallback) {
        currentQuestionCallback({ type: "button", value: "yes" });
        // hideQuestionInput();
      }
    });
  } else {
    console.warn("Button 'questionYes' not found.");
  }

  if (questionNoButton) {
    questionNoButton.addEventListener("click", () => {
      if (currentQuestionCallback) {
        currentQuestionCallback({ type: "button", value: "no" });
        // hideQuestionInput();
      }
    });
  } else {
    console.warn("Button 'questionNo' not found.");
  }

  console.log("UI Helper modal event listeners initialized.");
}

export function updateIndexingProgress(data) {
  const progressBarContainer = document.getElementById(
    "indexingProgressBarContainer",
  );
  const progressBar = document.getElementById("indexingProgressBar");
  const progressText = document.getElementById("indexingProgressText");
  const logOutput = document.getElementById("logOutput"); // For detailed messages

  if (!progressBarContainer || !progressBar || !progressText) return;

  progressBarContainer.classList.remove("hidden");

  if (data.type === "progress" || data.type === "progress_text") {
    let message = data.message || "Processing...";
    if (data.percentage !== undefined) {
      progressBar.style.width = `${data.percentage}%`;
      message = `(${data.percentage}%) ${message}`;
    }
    progressText.textContent = message;
    if (data.type !== "progress_text") {
      // Don't double-log simple text updates if already in progress bar
      addLogMessage(`[Indexer]: ${data.message}`, "info");
    }
  } else if (data.type === "completed") {
    progressBar.style.width = "100%";
    progressText.textContent = data.message || "Indexing Complete!";
    addLogMessage(
      `[Indexer]: ${data.message || "Indexing Complete!"}`,
      "success",
      true,
    );
    setTimeout(() => progressBarContainer.classList.add("hidden"), 3000);
  } else if (data.type === "error") {
    progressBar.style.width = "100%"; // Or some other indication
    progressBar.style.backgroundColor = "var(--error-color)"; // Indicate error
    progressText.textContent = `Error: ${data.message || "Unknown error"}`;
    addLogMessage(
      `[Indexer ERROR]: ${data.message || "Unknown error"}`,
      "error",
      true,
    );
    // Keep error visible for a bit longer or until user action
    // setTimeout(() => {
    // progressBarContainer.classList.add("hidden");
    // progressBar.style.backgroundColor = "var(--interactive-color)"; // Reset color
    // }, 5000);
  } else if (data.type === "info" || data.type === "warning") {
    addLogMessage(
      `[Indexer ${data.type.toUpperCase()}]: ${data.message}`,
      data.type,
    );
    progressText.textContent = data.message; // Update text display
  }
}

export function setIndexingControlsEnabled(enabled) {
  const indexButton = document.getElementById("indexCodebaseButton");
  const baseDirInput = document.getElementById("baseDir");
  if (indexButton) indexButton.disabled = !enabled;
  if (baseDirInput) baseDirInput.disabled = !enabled; // Also disable baseDir input during indexing
}

// Add at the end of initializeModalListeners or create a new init function for these
export function initializeIndexingControls(onIndexRequest, onBaseDirChange) {
  const indexButton = document.getElementById("indexCodebaseButton");
  const baseDirInput = document.getElementById("baseDir");

  if (indexButton) {
    indexButton.addEventListener("click", () => {
      const baseDir = baseDirInput.value.trim();
      if (!baseDir) {
        addLogMessage("Please enter a Base Directory to index.", "error", true);
        baseDirInput.focus();
        return;
      }
      // Ask user for mode (full or update) - for simplicity, default to 'update'
      // Or add another UI element for this. For now, let's make it 'update' by default.
      // A more advanced version could check the last indexed date and suggest 'full' if never/old.
      let mode = "update";
      const lastIndexedText = document
        .getElementById("lastIndexedStatus")
        .textContent.toLowerCase();
      if (
        lastIndexedText.includes("never") ||
        lastIndexedText.includes("error fetching") ||
        lastIndexedText.includes("not indexed")
      ) {
        if (
          confirm(
            "This directory doesn't seem to be indexed or the last index was long ago. Perform a full re-index? (Cancel for a quicker update scan)",
          )
        ) {
          mode = "full";
        }
      }

      if (typeof onIndexRequest === "function") {
        onIndexRequest(baseDir, mode); // Use the callback
      } else {
        addLogMessage(
          "Error: Indexing request function not provided.",
          "error",
          true,
        );
        console.error(
          "onIndexRequest callback is not a function in initializeIndexingControls",
        );
      }
    });
  }

  if (baseDirInput) {
    baseDirInput.addEventListener("change", () => {
      if (typeof fetchLastIndexedTime === "function") {
        onBaseDirChange(baseDirInput.value.trim());
      }
    });
    baseDirInput.addEventListener("keyup", (_event) => {
      // Update on paste or quick typing
      if (typeof fetchLastIndexedTime === "function") {
        onBaseDirChange(baseDirInput.value.trim());
      }
    });
  }
}
