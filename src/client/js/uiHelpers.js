let currentFeedbackCallback = null;
let currentQuestionCallback = null;
let currentContextArray = []; // In-memory store for context entries
const CONTEXT_STORAGE_KEY = 'geminiCoder_activeTaskContext'; // localStorage key

// --- Local Storage Context Management ---

function saveContextToLocalStorage() {
    try {
        localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(currentContextArray));
    } catch (e) {
        console.error("Error saving context to localStorage:", e);
        if (typeof addLogMessage === 'function') {
            addLogMessage("⚠️ Could not save context changes to local storage.", 'warn');
        }
    }
}

function loadContextFromLocalStorage() {
    const contextList = document.getElementById('contextList');
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
                updateContextDisplay(parsedContext, true); // Pass true to indicate loading from storage
            } else {
                console.warn("Invalid context data found in localStorage (not an array), clearing.");
                clearContextAndStorage();
            }
        } else {
            // No stored context, ensure UI is clear (but don't clear array/storage unless needed)
             updateContextDisplay([], false); // Explicitly clear UI without touching storage if empty
            console.log("No previous context found in localStorage.");
        }
    } catch (e) {
        console.error("Error loading context from localStorage:", e);
        if (typeof addLogMessage === 'function') {
            addLogMessage("⚠️ Could not load context from local storage.", 'warn');
        }
        clearContextAndStorage(); // Clear everything if loading fails
    }
}

/**
 * Clears the context display, the in-memory array, and localStorage.
 * Called when switching tasks or resetting.
 */
function clearContextAndStorage() {
    updateContextDisplay([], false); // Clear UI only, don't save empty array over potentially existing storage
    currentContextArray = []; // Clear in-memory array
    try {
        localStorage.removeItem(CONTEXT_STORAGE_KEY); // Remove from storage
        console.log("Cleared context display, in-memory array, and localStorage.");
    } catch (e) {
        console.error("Error removing context from localStorage:", e);
         if (typeof addLogMessage === 'function') {
            addLogMessage("⚠️ Failed to clear context from local storage.", 'warn');
        }
    }
}


// --- Drag/Drop & File Input Helpers ---

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function highlight(e) {
    const promptInput = document.getElementById('prompt');
    if (promptInput) {
        promptInput.classList.add('drag-over');
    }
}

function unhighlight(e) {
    const promptInput = document.getElementById('prompt');
    if (promptInput) {
        promptInput.classList.remove('drag-over');
    }
}

function handleDrop(e) {
    const imageUploadInput = document.getElementById('imageUpload');
    if (!imageUploadInput) {
        console.error("Element 'imageUpload' not found for drop handling.");
        return;
    }
    let dt = e.dataTransfer;
    let files = dt.files;

    if (files && files.length > 0) {
        try {
            // Create a new FileList object (necessary for some browsers/setups)
            const dataTransfer = new DataTransfer();
            Array.from(files).forEach(file => dataTransfer.items.add(file));
            imageUploadInput.files = dataTransfer.files;

            // Trigger change event manually if needed (sometimes doesn't fire automatically on programmatic assignment)
             const event = new Event('change', { bubbles: true });
             imageUploadInput.dispatchEvent(event);

        } catch (err) {
            console.error("Error assigning dropped files to input:", err);
            if (typeof addLogMessage === 'function') {
                addLogMessage("⚠️ Error processing dropped files. Please use the attach button.", 'warn');
            }
            return; // Stop further processing
        }

        if (typeof addLogMessage === 'function') {
            addLogMessage(`📁 ${files.length} file(s) dropped onto prompt area.`, 'info');
        }
        // updateUploadTriggerText should be called by the 'change' event handler now
        // if (typeof updateUploadTriggerText === 'function') {
        //     updateUploadTriggerText();
        // }
    } else {
        if (typeof addLogMessage === 'function') {
            addLogMessage("ℹ️ Drop event detected, but no files found.", 'info');
        }
    }
}


function updateUploadTriggerText() {
    const imageUploadInput = document.getElementById('imageUpload');
    const customUploadTrigger = document.getElementById('customUploadTrigger');
    if (!imageUploadInput || !customUploadTrigger) {
        // console.warn("updateUploadTriggerText: Missing elements.");
        return;
    }
    const numFiles = imageUploadInput.files ? imageUploadInput.files.length : 0;
    if (numFiles > 0) {
        customUploadTrigger.textContent = `📎 ${numFiles}`;
        customUploadTrigger.title = `${numFiles} file(s) attached. Click to change or drop files here.`;
    } else {
        customUploadTrigger.textContent = '📎';
        customUploadTrigger.title = 'Attach Files (or drop here)';
    }
}


// --- Context Display ---

/**
 * Updates the context list UI based on provided changes.
 * Can be used for initial load, clearing, or loading from storage.
 * @param {Array} changes - Array of context entry objects ({type, text}).
 * @param {boolean} [isLoadingFromStorage=false] - If true, populates the internal array and skips saving.
 */
function updateContextDisplay(changes = [], isLoadingFromStorage = false) {
    const contextList = document.getElementById('contextList');
    if (!contextList) {
        console.error("Element 'contextList' not found for context display.");
        return;
    }
    contextList.innerHTML = ''; // Clear existing UI entries

    if (!changes || changes.length === 0) {
        const li = document.createElement('li');
        li.textContent = '(Context will appear here as the task progresses)';
        li.style.fontStyle = 'italic';
        li.style.opacity = '0.7';
        li.classList.add('context-entry-info'); // Add class for potential styling
        contextList.appendChild(li);

        if (!isLoadingFromStorage) {
            // If we are clearing the display (not during load), clear the array and save
            currentContextArray = [];
            saveContextToLocalStorage();
        }

    } else {
        // If loading from storage, replace the in-memory array directly
        if (isLoadingFromStorage) {
            currentContextArray = [...changes]; // Make a copy
        } else {
             // Otherwise, assume 'changes' represents a new set (like from context-update event)
             currentContextArray = [...changes]; // Reset the array with the new changes
             saveContextToLocalStorage(); // Save the new state
        }

        // Render the entries to the UI
        currentContextArray.forEach(entry => {
            renderSingleContextEntry(entry.type, entry.text, contextList);
        });
    }

    // Scroll to the bottom
    requestAnimationFrame(() => {
        contextList.scrollTop = contextList.scrollHeight;
    });
}

/**
 * Appends a new entry to the context list UI AND the in-memory array.
 * Saves the updated array to localStorage.
 * @param {string} type - A type identifier (e.g., 'initial_prompt', 'question', 'file_write').
 * @param {string} text - The text content for the context entry.
 */
function addContextLogEntry(type, text) {
    const contextList = document.getElementById('contextList');
    if (!contextList) {
        console.error("Element 'contextList' not found for adding context entry.");
        return;
    }

    // Remove the initial placeholder if it exists
    const placeholder = contextList.querySelector('li[style*="italic"]');
    if (placeholder && placeholder.textContent.includes('(Context will appear here')) {
        contextList.removeChild(placeholder);
    }

    // Add to the in-memory array
    const newEntry = { type, text };
    currentContextArray.push(newEntry);

    // Render the new entry to the UI
    renderSingleContextEntry(type, text, contextList);

    // Save the updated array
    saveContextToLocalStorage();

    // Scroll to the bottom to show the latest entry
    requestAnimationFrame(() => {
        contextList.scrollTop = contextList.scrollHeight;
    });
}

/**
 * Renders a single context entry LI element to the provided list element.
 * This is a helper for updateContextDisplay and addContextLogEntry.
 * @param {string} type
 * @param {string} text
 * @param {HTMLElement} contextListElement
 */
function renderSingleContextEntry(type, text, contextListElement) {
    const li = document.createElement('li');
    li.classList.add('context-entry', `context-entry-${type}`); // Add classes for styling

    // Simple prefix based on type for clarity
    let prefix = '';
    switch (type) {
        case 'initial_prompt': prefix = '📝'; break;
        case 'resume_prompt': prefix = '▶️'; break;
        case 'question': prefix = '❓'; break;
        case 'answer': prefix = '🗣️'; break;
        case 'confirmation_request': prefix = '⚠️'; break;
        case 'confirmation_response': prefix = '👍'; break; // Could differentiate yes/no later
        case 'createFile':
        case 'updateFile':
        case 'writeFileContent': prefix = '💾'; break;
        case 'deleteFile': prefix = '🗑️'; break;
        case 'createDirectory': prefix = '📁+'; break;
        case 'deleteDirectory': prefix = '📁-'; break;
        case 'moveItem': prefix = '🚚'; break;
        case 'readFileContent': prefix = '📄'; break;
        case 'listFiles': prefix = ' Ls '; break;
        case 'searchFiles':
        case 'searchFilesByRegex': prefix = '🔎'; break;
        case 'info': prefix = 'ℹ️'; break;
        case 'task_finished': prefix = '✅'; break;
        case 'task_error': prefix = '❌'; break;
        case 'initial_state': prefix = '🔄'; break;
        default: prefix = '⚙️'; // Generic for other function calls/results
    }

    li.textContent = `${prefix} ${text}`;
    contextListElement.appendChild(li);
}


// --- UI State & Controls ---

function setControlsEnabled(enabled) {
    const controlsToToggle = [
        'baseDir',
        'prompt',
        'continueContext',
        'temperatureSlider',
        'startButton',
        'imageUpload', // The actual file input
        'customUploadTrigger', // The button/trigger
        'taskList' // The task list container
    ];
    const feedbackButtons = ['confirmYes', 'confirmNo', 'confirmYesAll'];
    const questionElements = ['questionInput', 'submitAnswer', 'questionYes', 'questionNo'];

    controlsToToggle.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            if (id === 'taskList') {
                // Disable interactions with task list items
                element.style.pointerEvents = enabled ? 'auto' : 'none';
                element.style.opacity = enabled ? '1' : '0.7';
            } else {
                element.disabled = !enabled;
            }
        } else {
            // Only warn if it's not the taskList (which might not exist if task feature is off)
             if (id !== 'taskList') console.warn(`Element with ID '${id}' not found for enabling/disabling.`);
        }
    });

    // Also handle enabling/disabling of interactive elements within modals
    // but only if the modal itself isn't hidden
    const feedbackContainer = document.getElementById('feedbackContainer');
    const questionContainer = document.getElementById('questionContainer');

    const feedbackVisible = feedbackContainer && !feedbackContainer.classList.contains('hidden');
    feedbackButtons.forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = !enabled || !feedbackVisible;
    });

    const questionVisible = questionContainer && !questionContainer.classList.contains('hidden');
    questionElements.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = !enabled || !questionVisible;
    });

    // Add visual cue to the start button when disabled
    const startButton = document.getElementById('startButton');
    if (startButton) {
        startButton.textContent = enabled ? 'Start Task' : '⏳ Running...';
    }
}

// --- Modal Dialogs (Feedback & Question) ---

function showFeedback(message, callback) {
    const feedbackMessage = document.getElementById('feedbackMessage');
    const feedbackContainer = document.getElementById('feedbackContainer');
    const confirmYesButton = document.getElementById('confirmYes');
    const confirmNoButton = document.getElementById('confirmNo');
    const confirmYesAllButton = document.getElementById('confirmYesAll');

    if (!feedbackMessage || !feedbackContainer || !confirmYesButton || !confirmNoButton || !confirmYesAllButton) {
        console.error("Feedback dialog elements not found (feedbackMessage, feedbackContainer, confirmYes, confirmNo, confirmYesAll).");
        if(callback) callback('error'); // Signal error back if possible
        return;
    }

    feedbackMessage.textContent = message;
    feedbackContainer.classList.remove('hidden');
    currentFeedbackCallback = callback;

    hideQuestionInput(); // Ensure question dialog is hidden
    setControlsEnabled(false); // Disable main controls

    // Ensure feedback buttons themselves are enabled initially
    confirmYesButton.disabled = false;
    confirmNoButton.disabled = false;
    confirmYesAllButton.disabled = false;

    confirmYesButton.focus(); // Focus the primary action
}

function hideFeedback() {
    const feedbackContainer = document.getElementById('feedbackContainer');
    if (feedbackContainer) {
        feedbackContainer.classList.add('hidden');
    }
    currentFeedbackCallback = null; // Clear callback

    // Disable buttons when hidden
    const confirmYesButton = document.getElementById('confirmYes');
    const confirmNoButton = document.getElementById('confirmNo');
    const confirmYesAllButton = document.getElementById('confirmYesAll');
    if (confirmYesButton) confirmYesButton.disabled = true;
    if (confirmNoButton) confirmNoButton.disabled = true;
    if (confirmYesAllButton) confirmYesAllButton.disabled = true;

    // Don't re-enable controls here, wait for server signal (task complete/error)
    // or explicit user action (like clicking "No")
}


function showQuestionInput(question, callback) {
    const questionText = document.getElementById('questionText');
    const questionInput = document.getElementById('questionInput');
    const questionContainer = document.getElementById('questionContainer');
    const submitAnswerButton = document.getElementById('submitAnswer');
    const questionYesButton = document.getElementById('questionYes');
    const questionNoButton = document.getElementById('questionNo');

    if (!questionText || !questionInput || !questionContainer || !submitAnswerButton || !questionYesButton || !questionNoButton) {
        console.error("Question dialog elements not found (questionText, questionInput, questionContainer, submitAnswer, questionYes, questionNo).");
        if(callback) callback({ type: 'error', value: 'UI elements missing' });
        return;
    }

    questionText.textContent = question;
    questionInput.value = ''; // Clear previous answer
    questionContainer.classList.remove('hidden');
    currentQuestionCallback = callback;

    hideFeedback(); // Ensure feedback dialog is hidden
    setControlsEnabled(false); // Disable main controls

    // Ensure question inputs/buttons are enabled initially
    questionInput.disabled = false;
    submitAnswerButton.disabled = false;
    questionYesButton.disabled = false;
    questionNoButton.disabled = false;

    questionInput.focus(); // Focus the text input
}

function hideQuestionInput() {
    const questionContainer = document.getElementById('questionContainer');
    if (questionContainer) {
        questionContainer.classList.add('hidden');
    }
    currentQuestionCallback = null; // Clear callback

    // Disable inputs/buttons when hidden
    const questionInput = document.getElementById('questionInput');
    const submitAnswerButton = document.getElementById('submitAnswer');
    const questionYesButton = document.getElementById('questionYes');
    const questionNoButton = document.getElementById('questionNo');
    if (questionInput) questionInput.disabled = true;
    if (submitAnswerButton) submitAnswerButton.disabled = true;
    if (questionYesButton) questionYesButton.disabled = true;
    if (questionNoButton) questionNoButton.disabled = true;

     // Don't re-enable controls here, wait for server signal
}


// --- Event Listeners for Modals ---
document.addEventListener('DOMContentLoaded', () => {
    const confirmYesButton = document.getElementById('confirmYes');
    const confirmNoButton = document.getElementById('confirmNo');
    const confirmYesAllButton = document.getElementById('confirmYesAll');

    const submitAnswerButton = document.getElementById('submitAnswer');
    const questionInput = document.getElementById('questionInput');
    const questionYesButton = document.getElementById('questionYes');
    const questionNoButton = document.getElementById('questionNo');

    // Feedback Buttons
    if (confirmYesButton) {
        confirmYesButton.addEventListener('click', () => {
            if (currentFeedbackCallback) {
                currentFeedbackCallback('yes');
                // currentFeedbackCallback = null; // Clear immediately after calling
                // hideFeedback(); // Hide UI
                // Server will eventually re-enable controls or ask next thing
            }
        });
    } else { console.warn("Button 'confirmYes' not found."); }

    if (confirmNoButton) {
        confirmNoButton.addEventListener('click', () => {
            if (currentFeedbackCallback) {
                currentFeedbackCallback('no');
                // currentFeedbackCallback = null; // Clear immediately
                // hideFeedback(); // Hide UI
                // The 'no' decision might re-enable controls sooner server-side
                // if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Let server decide when controls are enabled
            }
        });
    } else { console.warn("Button 'confirmNo' not found."); }

    if (confirmYesAllButton) {
        confirmYesAllButton.addEventListener('click', () => {
            if (currentFeedbackCallback) {
                currentFeedbackCallback('yes/all');
                // currentFeedbackCallback = null; // Clear immediately
                // hideFeedback(); // Hide UI
            }
        });
    } else { console.warn("Button 'confirmYesAll' not found."); }

    // Question Input/Buttons
    const submitQuestionText = () => {
         if (currentQuestionCallback && questionInput) {
            const answer = questionInput.value.trim();
            currentQuestionCallback({ type: 'text', value: answer });
            // currentQuestionCallback = null; // Clear immediately
            // hideQuestionInput(); // Hide UI
        }
    };

    if (submitAnswerButton) {
        submitAnswerButton.addEventListener('click', submitQuestionText);
    } else { console.warn("Button 'submitAnswer' not found."); }

    if (questionInput) {
        questionInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) { // Submit on Enter unless Shift is pressed
                event.preventDefault(); // Prevent default Enter behavior (like newline)
                submitQuestionText();
            }
        });
    } else { console.warn("Input 'questionInput' not found."); }

     if (questionYesButton) {
        questionYesButton.addEventListener('click', () => {
            if (currentQuestionCallback) {
                 currentQuestionCallback({ type: 'button', value: 'yes' });
                // currentQuestionCallback = null; // Clear immediately
                // hideQuestionInput(); // Hide UI
            }
        });
    } else { console.warn("Button 'questionYes' not found."); }

    if (questionNoButton) {
        questionNoButton.addEventListener('click', () => {
            if (currentQuestionCallback) {
                 currentQuestionCallback({ type: 'button', value: 'no' });
                // currentQuestionCallback = null; // Clear immediately
                // hideQuestionInput(); // Hide UI
            }
        });
    } else { console.warn("Button 'questionNo' not found."); }

    console.log("UI Helper modal event listeners initialized.");
});
