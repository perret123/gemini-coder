let currentFeedbackCallback = null;
let currentQuestionCallback = null;
let currentContextArray = [];
const CONTEXT_STORAGE_KEY = "geminiCoder_activeTaskContext";

function saveContextToLocalStorage() {
    try {
        localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(currentContextArray));
    } catch (e) {
        console.error("Error saving context to localStorage:", e);
        if (typeof addLogMessage === "function") {
            addLogMessage("⚠️ Could not save context changes to local storage.", "warn", true);
        }
    }
}

function loadContextFromLocalStorage() {
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
                console.log(`Loading ${parsedContext.length} context items from localStorage.`);
                updateContextDisplay(parsedContext, true); // Pass true to indicate loading
            } else {
                console.warn("Invalid context data found in localStorage (not an array), clearing.");
                clearContextAndStorage();
            }
        } else {
            // No stored context, initialize display with placeholder
            updateContextDisplay([], false); // Pass false or omit
            console.log("No previous context found in localStorage.");
        }
    } catch (e) {
        console.error("Error loading context from localStorage:", e);
        if (typeof addLogMessage === "function") {
            addLogMessage("⚠️ Could not load context from local storage.", "warn", true);
        }
        clearContextAndStorage(); // Clear on error
    }
}

function clearContextAndStorage() {
    updateContextDisplay([], false); // Clear display immediately
    currentContextArray = []; // Clear in-memory array
    try {
        localStorage.removeItem(CONTEXT_STORAGE_KEY);
        console.log("Cleared context display, in-memory array, and localStorage.");
    } catch (e) {
        console.error("Error removing context from localStorage:", e);
        if (typeof addLogMessage === "function") {
            addLogMessage("⚠️ Failed to clear context from local storage.", "warn", true);
        }
    }
}


function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function highlight(e) {
    const promptInput = document.getElementById("prompt");
    if (promptInput) {
        promptInput.classList.add("drag-over");
    }
}

function unhighlight(e) {
    const promptInput = document.getElementById("prompt");
    if (promptInput) {
        promptInput.classList.remove("drag-over");
    }
}

function handleDrop(e) {
    const imageUploadInput = document.getElementById("imageUpload");
    if (!imageUploadInput) {
        console.error("Element 'imageUpload' not found for drop handling.");
        return;
    }
    let dt = e.dataTransfer;
    let files = dt.files;

    if (files && files.length > 0) {
        try {
            // Use DataTransfer constructor to create a new FileList
            const dataTransfer = new DataTransfer();
            Array.from(files).forEach(file => dataTransfer.items.add(file));
            imageUploadInput.files = dataTransfer.files;

            // Dispatch a 'change' event so event listeners are triggered
            const event = new Event("change", { bubbles: true });
            imageUploadInput.dispatchEvent(event);

        } catch (err) {
            console.error("Error assigning dropped files to input:", err);
            if (typeof addLogMessage === "function") {
                addLogMessage("⚠️ Error processing dropped files. Please use the attach button.", "warn", true);
            }
            return; // Stop processing if error occurs
        }
        if (typeof addLogMessage === "function") {
            addLogMessage(`📁 ${files.length} file(s) dropped onto prompt area.`, "info", true);
        }
    } else {
        if (typeof addLogMessage === "function") {
            // ADDED isAction flag here
            addLogMessage("ℹ️ Drop event detected, but no files found.", "info", true);
        }
    }
}

function updateUploadTriggerText() {
    const imageUploadInput = document.getElementById("imageUpload");
    const customUploadTrigger = document.getElementById("customUploadTrigger");
    if (!imageUploadInput || !customUploadTrigger) {
        // console.warn("Upload trigger elements not found for update.");
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

function updateContextDisplay(changes = [], isLoadingFromStorage = false) {
    const contextList = document.getElementById("contextList");
    if (!contextList) {
        console.error("Element 'contextList' not found for context display.");
        return;
    }
    contextList.innerHTML = ""; // Clear previous entries

    if (!changes || changes.length === 0) {
        // Display placeholder if no changes
        const li = document.createElement("li");
        li.textContent = "(Context will appear here as the task progresses)";
        li.style.fontStyle = "italic";
        li.style.opacity = "0.7";
        li.classList.add("context-entry-info"); // Add a class for potential styling
        contextList.appendChild(li);
        if (!isLoadingFromStorage) {
            // Only clear storage if not currently loading from it
            currentContextArray = [];
            saveContextToLocalStorage();
        }
    } else {
        // If loading, update the in-memory array directly
        if (isLoadingFromStorage) {
            currentContextArray = [...changes];
        } else {
            // Otherwise, assume these are new changes to add/replace
            currentContextArray = [...changes];
            saveContextToLocalStorage(); // Save the updated context
        }

        // Render each entry
        currentContextArray.forEach(entry => {
            renderSingleContextEntry(entry.type, entry.text, contextList);
        });
    }

    // Scroll to bottom after updating
    requestAnimationFrame(() => {
        contextList.scrollTop = contextList.scrollHeight;
    });
}

function addContextLogEntry(type, text) {
    const contextList = document.getElementById("contextList");
    if (!contextList) {
        console.error("Element 'contextList' not found for adding context entry.");
        return;
    }

    // Remove placeholder if it exists
    const placeholder = contextList.querySelector("li[style*='italic']");
    if (placeholder && placeholder.textContent.includes("(Context will appear here")) {
        contextList.removeChild(placeholder);
    }

    // Add new entry to array and render it
    const newEntry = { type, text };
    currentContextArray.push(newEntry);
    renderSingleContextEntry(type, text, contextList);

    saveContextToLocalStorage(); // Save after adding

    // Scroll to bottom
    requestAnimationFrame(() => {
        contextList.scrollTop = contextList.scrollHeight;
    });
}

function renderSingleContextEntry(type, text, contextListElement) {
    const li = document.createElement("li");
    li.classList.add("context-entry", `context-entry-${type}`);

    let prefix = "";
    // Define prefixes based on type
    switch (type) {
        case "initial_prompt": prefix = "📝"; break;
        case "resume_prompt": prefix = "▶️"; break;
        case "question": prefix = "❓"; break;
        case "answer": prefix = "🗣️"; break;
        case "confirmation_request": prefix = "⚠️"; break;
        case "confirmation_response": prefix = "👍"; break; // Could also use decision specific icon
        case "createFile": case "updateFile": case "writeFileContent": prefix = "💾"; break;
        case "deleteFile": prefix = "🗑️"; break;
        case "createDirectory": prefix = "📁+"; break;
        case "deleteDirectory": prefix = "📁-"; break;
        case "moveItem": prefix = "🚚"; break;
        case "readFileContent": prefix = "📄"; break;
        case "listFiles": prefix = " Ls "; break; // Keep space for alignment if needed
        case "searchFiles": case "searchFilesByRegex": prefix = "🔎"; break;
        case "info": prefix = "ℹ️"; break;
        case "task_finished": prefix = "✅"; break;
        case "task_error": case "error": prefix = "❌"; break; // Consolidate error display
        case "initial_state": prefix = "🔄"; break;
        case "api_retry": prefix = "⏳"; break;
        case "user_wait": prefix = "👤"; break;
        case "disconnect": prefix = "🔌"; break;
        case "warning": prefix = "⚠️"; break;
        default: prefix = "⚙️"; // Generic gear for unknown types
    }

    li.textContent = `${prefix} ${text}`; // Combine prefix and text
    contextListElement.appendChild(li);
}


function setControlsEnabled(enabled) {
    const controlsToToggle = [
        "baseDir", "prompt", "continueContext", "temperatureSlider",
        "startButton", "imageUpload", "customUploadTrigger", "taskList"
    ];
    const feedbackButtons = ["confirmYes", "confirmNo", "confirmYesAll"];
    const questionElements = ["questionInput", "submitAnswer", "questionYes", "questionNo"];

    controlsToToggle.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            if (id === "taskList") {
                // Disable interaction with task list visually
                element.style.pointerEvents = enabled ? "auto" : "none";
                element.style.opacity = enabled ? "1" : "0.7";
            } else {
                element.disabled = !enabled;
            }
        } else {
            if (id !== "taskList") console.warn(`Element with ID '${id}' not found for enabling/disabling.`);
        }
    });

    // Also consider disabling modals based on 'enabled' state, though they manage their own buttons
    const feedbackContainer = document.getElementById("feedbackContainer");
    const questionContainer = document.getElementById("questionContainer");

    // Only disable feedback buttons if the feedback container is visible
    const feedbackVisible = feedbackContainer && !feedbackContainer.classList.contains("hidden");
    feedbackButtons.forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = !enabled || !feedbackVisible;
    });

    // Only disable question inputs if the question container is visible
    const questionVisible = questionContainer && !questionContainer.classList.contains("hidden");
    questionElements.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = !enabled || !questionVisible;
    });

    // Update start button text
    const startButton = document.getElementById("startButton");
    if (startButton) {
        startButton.textContent = enabled ? "Start Task" : "⏳ Running...";
    }
}


function showFeedback(message, callback) {
    const feedbackMessage = document.getElementById("feedbackMessage");
    const feedbackContainer = document.getElementById("feedbackContainer");
    const confirmYesButton = document.getElementById("confirmYes");
    const confirmNoButton = document.getElementById("confirmNo");
    const confirmYesAllButton = document.getElementById("confirmYesAll");

    if (!feedbackMessage || !feedbackContainer || !confirmYesButton || !confirmNoButton || !confirmYesAllButton) {
        console.error("Feedback dialog elements not found (feedbackMessage, feedbackContainer, confirmYes, confirmNo, confirmYesAll).");
        if(callback) callback("error"); // Signal error if callback provided
        return;
    }

    feedbackMessage.textContent = message;
    feedbackContainer.classList.remove("hidden"); // Make visible
    currentFeedbackCallback = callback; // Store the callback

    hideQuestionInput(); // Hide question modal if it's open
    setControlsEnabled(false); // Disable main controls, but enable modal buttons

    // Explicitly enable modal buttons
    confirmYesButton.disabled = false;
    confirmNoButton.disabled = false;
    confirmYesAllButton.disabled = false;

    confirmYesButton.focus(); // Focus the primary action
}

function hideFeedback() {
    const feedbackContainer = document.getElementById("feedbackContainer");
    if (feedbackContainer) {
        feedbackContainer.classList.add("hidden");
    }
    currentFeedbackCallback = null; // Clear callback

    // Disable buttons when hiding
    const confirmYesButton = document.getElementById("confirmYes");
    const confirmNoButton = document.getElementById("confirmNo");
    const confirmYesAllButton = document.getElementById("confirmYesAll");
    if (confirmYesButton) confirmYesButton.disabled = true;
    if (confirmNoButton) confirmNoButton.disabled = true;
    if (confirmYesAllButton) confirmYesAllButton.disabled = true;

    // Re-enable controls only if task isn't running (handled elsewhere)
}


function showQuestionInput(question, callback) {
    const questionText = document.getElementById("questionText");
    const questionInput = document.getElementById("questionInput");
    const questionContainer = document.getElementById("questionContainer");
    const submitAnswerButton = document.getElementById("submitAnswer");
    const questionYesButton = document.getElementById("questionYes");
    const questionNoButton = document.getElementById("questionNo");

    if (!questionText || !questionInput || !questionContainer || !submitAnswerButton || !questionYesButton || !questionNoButton) {
        console.error("Question dialog elements not found (questionText, questionInput, questionContainer, submitAnswer, questionYes, questionNo).");
        if(callback) callback({ type: "error", value: "UI elements missing" }); // Signal error
        return;
    }

    questionText.textContent = question;
    questionInput.value = ""; // Clear previous answer
    questionContainer.classList.remove("hidden"); // Make visible
    currentQuestionCallback = callback; // Store callback

    hideFeedback(); // Hide feedback modal if it's open
    setControlsEnabled(false); // Disable main controls, enable modal inputs

    // Explicitly enable modal inputs/buttons
    questionInput.disabled = false;
    submitAnswerButton.disabled = false;
    questionYesButton.disabled = false;
    questionNoButton.disabled = false;

    questionInput.focus(); // Focus the text input
}


function hideQuestionInput() {
    const questionContainer = document.getElementById("questionContainer");
    if (questionContainer) {
        questionContainer.classList.add("hidden");
    }
    currentQuestionCallback = null; // Clear callback

    // Disable inputs/buttons when hiding
    const questionInput = document.getElementById("questionInput");
    const submitAnswerButton = document.getElementById("submitAnswer");
    const questionYesButton = document.getElementById("questionYes");
    const questionNoButton = document.getElementById("questionNo");
    if (questionInput) questionInput.disabled = true;
    if (submitAnswerButton) submitAnswerButton.disabled = true;
    if (questionYesButton) questionYesButton.disabled = true;
    if (questionNoButton) questionNoButton.disabled = true;

    // Re-enable controls only if task isn't running (handled elsewhere)
}


// Event listeners for Modals setup in DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
    const confirmYesButton = document.getElementById("confirmYes");
    const confirmNoButton = document.getElementById("confirmNo");
    const confirmYesAllButton = document.getElementById("confirmYesAll");

    const submitAnswerButton = document.getElementById("submitAnswer");
    const questionInput = document.getElementById("questionInput");
    const questionYesButton = document.getElementById("questionYes");
    const questionNoButton = document.getElementById("questionNo");

    // Feedback Modal Listeners
    if (confirmYesButton) {
        confirmYesButton.addEventListener("click", () => {
            if (currentFeedbackCallback) {
                currentFeedbackCallback("yes");
                // Optionally hideFeedback() here or let the caller handle it
            }
        });
    } else { console.warn("Button 'confirmYes' not found."); }

    if (confirmNoButton) {
        confirmNoButton.addEventListener("click", () => {
            if (currentFeedbackCallback) {
                currentFeedbackCallback("no");
            }
        });
    } else { console.warn("Button 'confirmNo' not found."); }

    if (confirmYesAllButton) {
        confirmYesAllButton.addEventListener("click", () => {
            if (currentFeedbackCallback) {
                currentFeedbackCallback("yes/all");
            }
        });
    } else { console.warn("Button 'confirmYesAll' not found."); }


    // Question Modal Listeners
    const submitQuestionText = () => {
        if (currentQuestionCallback && questionInput) {
            const answer = questionInput.value.trim();
            currentQuestionCallback({ type: "text", value: answer });
            // Optionally hideQuestionInput() here or let the caller handle it
        }
    };

    if (submitAnswerButton) {
        submitAnswerButton.addEventListener("click", submitQuestionText);
    } else { console.warn("Button 'submitAnswer' not found."); }

    if (questionInput) {
        questionInput.addEventListener("keypress", (event) => {
            // Submit on Enter unless Shift is pressed (for multi-line)
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault(); // Prevent default form submission/newline
                submitQuestionText();
            }
        });
    } else { console.warn("Input 'questionInput' not found."); }

    if (questionYesButton) {
        questionYesButton.addEventListener("click", () => {
            if (currentQuestionCallback) {
                currentQuestionCallback({ type: "button", value: "yes" });
            }
        });
    } else { console.warn("Button 'questionYes' not found."); }

    if (questionNoButton) {
        questionNoButton.addEventListener("click", () => {
            if (currentQuestionCallback) {
                currentQuestionCallback({ type: "button", value: "no" });
            }
        });
    } else { console.warn("Button 'questionNo' not found."); }

    console.log("UI Helper modal event listeners initialized.");
});


if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      saveContextToLocalStorage,
      loadContextFromLocalStorage,
      clearContextAndStorage,
      preventDefaults,
      highlight,
      unhighlight,
      handleDrop,
      updateUploadTriggerText,
      updateContextDisplay,
      addContextLogEntry,
      renderSingleContextEntry,
      setControlsEnabled,
      showFeedback,
      hideFeedback,
      showQuestionInput,
      hideQuestionInput,
      // Also export internal refs if tests might need them, though unlikely
      // currentFeedbackCallback,
      // currentQuestionCallback,
      // currentContextArray
    };
  }