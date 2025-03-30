// Establish connection with the server
const socket = io();

// Get UI elements
const baseDirInput = document.getElementById('baseDir');
const promptInput = document.getElementById('prompt'); // Textarea, now also drop zone
const continueContextCheckbox = document.getElementById('continueContext');
const temperatureSlider = document.getElementById('temperatureSlider'); // <<< NEW
const temperatureValueSpan = document.getElementById('temperatureValue'); // <<< NEW
const startButton = document.getElementById('startButton');
const logOutput = document.getElementById('logOutput');
const logContainer = document.getElementById('logContainer');
const feedbackContainer = document.getElementById('feedbackContainer');
const feedbackMessage = document.getElementById('feedbackMessage');
const confirmYesButton = document.getElementById('confirmYes');
const confirmNoButton = document.getElementById('confirmNo');
const confirmYesAllButton = document.getElementById('confirmYesAll');
const imageUploadInput = document.getElementById('imageUpload'); // Original file input (now hidden)
const customUploadTrigger = document.getElementById('customUploadTrigger'); // New custom button
const themeSwitcherButton = document.getElementById('themeSwitcher');
const bodyElement = document.body;

// --- NEW: Question Input Elements ---
const questionContainer = document.getElementById('questionContainer');
const questionText = document.getElementById('questionText');
const questionInput = document.getElementById('questionInput');
const submitAnswerButton = document.getElementById('submitAnswer');
const questionYesButton = document.getElementById('questionYes');
const questionNoButton = document.getElementById('questionNo');
// --- END NEW --

let currentFeedbackCallback = null;
let currentQuestionCallback = null; // Callback for question responses

// --- Theme Constants ---
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
const THEME_KEY = 'app-theme';
const LIGHT_ICON = '☀️';
const DARK_ICON = '🌙';
// --- Theme Constants ---

// --- Event Listeners ---

// Start Task Button
startButton.addEventListener('click', async () => {
    const baseDir = baseDirInput.value.trim();
    const prompt = promptInput.value.trim();
    const continueContext = continueContextCheckbox.checked;
    const temperature = parseFloat(temperatureSlider.value); // <<< NEW: Get temperature value
    const files = imageUploadInput.files;

    if (!baseDir || !prompt) {
        addLogMessage('Please enter both a base directory and instructions.', 'error');
        return;
    }

    if (!continueContext) {
        logOutput.textContent = '';
    }
    addLogMessage('Preparing task...', 'info');

    setControlsEnabled(false); // Disables all controls
    hideFeedback();
    hideQuestionInput(); // Hide question input if it was somehow open

    // --- File Upload Logic ---
    let uploadedFileNames = [];
    if (files.length > 0) {
        addLogMessage(`Attempting to upload ${files.length} file(s)...`, 'info');
        const formData = new FormData();
        for (const file of files) {
            formData.append('images', file);
        }

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData,
            });
            const result = await response.json();
            if (response.ok) {
                addLogMessage(`✅ ${result.message}`, 'success');
                uploadedFileNames = result.files || [];
                if (uploadedFileNames.length > 0) {
                   addLogMessage(`Uploaded file references: ${uploadedFileNames.join(', ')}`, 'info');
                }
            } else {
                addLogMessage(`❌ Upload failed: ${result.message || response.statusText}`, 'error');
            }
        } catch (error) {
            addLogMessage(`❌ Network or server error during upload: ${error.message}`, 'error');
        }
    } else {
        addLogMessage('No files attached for upload.', 'info');
    }
    // --- End File Upload Logic ---

    addLogMessage('Starting main task via WebSocket...', 'info');
    if (continueContext) {
        addLogMessage('Attempting to continue previous context...', 'info');
    }

    socket.emit('start-task', {
        baseDir,
        prompt,
        continueContext,
        temperature, // <<< NEW: Send temperature
        uploadedFiles: uploadedFileNames
    });

    imageUploadInput.value = '';
    updateUploadTriggerText();
});


// --- Custom Upload Trigger ---
customUploadTrigger.addEventListener('click', () => {
    imageUploadInput.click();
});

// --- Drag and Drop Logic ---
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    promptInput.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    promptInput.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    promptInput.addEventListener(eventName, unhighlight, false);
});

function highlight(e) {
    promptInput.classList.add('drag-over');
}

function unhighlight(e) {
    promptInput.classList.remove('drag-over');
}

promptInput.addEventListener('drop', handleDrop, false);

function handleDrop(e) {
    let dt = e.dataTransfer;
    let files = dt.files;
    imageUploadInput.files = files;
    addLogMessage(`📁 ${files.length} file(s) dropped onto prompt area.`, 'info');
    updateUploadTriggerText();
}

imageUploadInput.addEventListener('change', () => {
    updateUploadTriggerText();
     if (imageUploadInput.files.length > 0) {
        addLogMessage(`📎 ${imageUploadInput.files.length} file(s) selected via file dialog.`, 'info');
    }
});

function updateUploadTriggerText() {
    const numFiles = imageUploadInput.files.length;
    if (numFiles > 0) {
        customUploadTrigger.textContent = `📎 ${numFiles}`;
        customUploadTrigger.title = `${numFiles} file(s) attached. Click to change.`;
    } else {
        customUploadTrigger.textContent = '📎';
        customUploadTrigger.title = 'Attach Files';
    }
}


// --- Feedback Buttons ---
confirmYesButton.addEventListener('click', () => {
    if (currentFeedbackCallback) {
        currentFeedbackCallback('yes');
        currentFeedbackCallback = null;
        hideFeedback();
    }
});

confirmNoButton.addEventListener('click', () => {
    if (currentFeedbackCallback) {
        currentFeedbackCallback('no');
        currentFeedbackCallback = null;
        hideFeedback();
    }
});

confirmYesAllButton.addEventListener('click', () => {
    if (currentFeedbackCallback) {
        currentFeedbackCallback('yes/all');
        currentFeedbackCallback = null;
        hideFeedback();
    }
});

// --- NEW: Question Input Buttons/Actions ---
submitAnswerButton.addEventListener('click', () => {
    const answer = questionInput.value.trim();
    if (currentQuestionCallback) {
        currentQuestionCallback({ type: 'text', value: answer }); // Send structured response
        currentQuestionCallback = null;
        hideQuestionInput();
        setControlsEnabled(true); // Re-enable controls after answering
    }
});

questionYesButton.addEventListener('click', () => {
    if (currentQuestionCallback) {
        currentQuestionCallback({ type: 'button', value: 'yes' }); // Send structured response
        currentQuestionCallback = null;
        hideQuestionInput();
        setControlsEnabled(true); // Re-enable controls after answering
    }
});

questionNoButton.addEventListener('click', () => {
    if (currentQuestionCallback) {
        currentQuestionCallback({ type: 'button', value: 'no' }); // Send structured response
        currentQuestionCallback = null;
        hideQuestionInput();
        setControlsEnabled(true); // Re-enable controls after answering
    }
});
// --- END NEW --

// --- Theme Switcher Button Listener ---
if (themeSwitcherButton) {
    themeSwitcherButton.addEventListener('click', toggleTheme);
}

// --- Temperature Slider Listener --- <<< NEW
if (temperatureSlider && temperatureValueSpan) {
    temperatureSlider.addEventListener('input', () => {
        temperatureValueSpan.textContent = parseFloat(temperatureSlider.value).toFixed(1); // Format to one decimal place
    });
    // Initialize display
    temperatureValueSpan.textContent = parseFloat(temperatureSlider.value).toFixed(1);
}
// --- END Temperature Slider Listener --- <<< NEW


// --- Socket Event Handlers ---
socket.on('connect', () => {
    console.log('Connected to server');
    addLogMessage('Connected to server.', 'success');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    addLogMessage('Disconnected from server. Please refresh.', 'error');
    setControlsEnabled(false);
    hideFeedback(); // Hide feedback on disconnect
    hideQuestionInput(); // Hide question on disconnect
});

socket.on('log', (data) => {
    addLogMessage(data.message, data.type || 'info');
});

socket.on('confirmation-request', (data) => {
    addLogMessage(`CONFIRMATION REQUIRED: ${data.message}`, 'confirm');
    if (data.diff && typeof data.diff === 'string') {
        addLogMessage(data.diff, 'diff');
    }
    showFeedback(data.message, (decision) => {
        socket.emit('user-feedback', { decision });
    });
});

// --- NEW: Listener for Question Request ---
socket.on('ask-question-request', (data) => {
    addLogMessage(`QUESTION FOR YOU: ${data.question}`, 'confirm'); // Using 'confirm' style for visibility
    showQuestionInput(data.question, (answer) => { // answer is now {type, value}
        socket.emit('user-question-response', { answer });
    });
});
// --- END NEW ---

socket.on('task-complete', (data) => {
    addLogMessage(`✅ Task finished: ${data.message}`, 'success');
    setControlsEnabled(true); // Enable controls
    hideFeedback();
    hideQuestionInput(); // Ensure question input is hidden
});

socket.on('task-error', (data) => {
    addLogMessage(`❌ Error: ${data.message}`, 'error');
    setControlsEnabled(true); // Enable controls
    hideFeedback();
    hideQuestionInput(); // Ensure question input is hidden
});

// --- Helper Functions ---


// addLogMessage (MODIFIED FOR DIFF HIGHLIGHTING)
function addLogMessage(message, type = 'info') {
    const logEntry = document.createElement('div');
    logEntry.className = `log-${type}`;

    if (type === 'diff') {
        const pre = document.createElement('pre');
        // Handle potential Windows line endings robustly
        const lines = message.split(/\r?\n/);

        lines.forEach(line => {
            if (line.trim() === '' && lines.length === 1) return; // Skip if diff is just whitespace

            const span = document.createElement('span');
            if (line.startsWith('+')) {
                span.className = 'diff-added';
                span.textContent = line;
            } else if (line.startsWith('-')) {
                span.className = 'diff-removed';
                span.textContent = line;
            } else {
                 // Keep context lines styled normally within the pre block
                span.className = 'diff-context'; // Add a class for potential future styling
                span.textContent = line;
            }
            pre.appendChild(span);
            // Note: Relying on display: block in CSS for line separation now.
        });

        // If the pre element is empty (e.g., diff was only whitespace), don't append it.
        if (pre.hasChildNodes()) {
           logEntry.appendChild(pre);
        } else {
            // Optionally log that the diff was empty or only whitespace
            console.log("Received empty or whitespace-only diff.");
        }

    } else {
        // Handle non-diff messages (keep existing behavior)
        logEntry.textContent = message;
    }

    if (logEntry.textContent || logEntry.querySelector('pre')) {
        logOutput.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight; // Scroll to bottom
    }
}


// setControlsEnabled (MODIFIED FOR SLIDER)
function setControlsEnabled(enabled) {
    baseDirInput.disabled = !enabled;
    promptInput.disabled = !enabled;
    continueContextCheckbox.disabled = !enabled;
    temperatureSlider.disabled = !enabled; // <<< NEW
    startButton.disabled = !enabled;
    imageUploadInput.disabled = !enabled;
    customUploadTrigger.disabled = !enabled;

    // Feedback buttons are handled by show/hideFeedback
    const feedbackHidden = feedbackContainer.classList.contains('hidden');
    confirmYesButton.disabled = feedbackHidden;
    confirmNoButton.disabled = feedbackHidden;
    confirmYesAllButton.disabled = feedbackHidden;

    // Question elements are handled by show/hideQuestionInput (mostly)
    const questionHidden = questionContainer.classList.contains('hidden');
    questionInput.disabled = questionHidden || !enabled;
    submitAnswerButton.disabled = questionHidden || !enabled;
    questionYesButton.disabled = questionHidden || !enabled;
    questionNoButton.disabled = questionHidden || !enabled;
}

// showFeedback
function showFeedback(message, callback) {
    feedbackMessage.textContent = `Confirmation Required: ${message}`;
    feedbackContainer.classList.remove('hidden');
    currentFeedbackCallback = callback;
    setControlsEnabled(false); // Disable main controls while feedback is shown
    hideQuestionInput(); // Hide question if shown
    // Enable only feedback buttons
    confirmYesButton.disabled = false;
    confirmNoButton.disabled = false;
    confirmYesAllButton.disabled = false;
}

// hideFeedback
function hideFeedback() {
    feedbackContainer.classList.add('hidden');
    currentFeedbackCallback = null;
    // Disable feedback buttons when hidden
    confirmYesButton.disabled = true;
    confirmNoButton.disabled = true;
    confirmYesAllButton.disabled = true;
     if (questionContainer.classList.contains('hidden')) {
        // No automatic re-enabling here, handled by response/task completion
    }
}

// --- NEW: Show/Hide Question Input ---
function showQuestionInput(question, callback) {
    questionText.textContent = question;
    questionInput.value = ''; // Clear previous answer
    questionContainer.classList.remove('hidden');
    currentQuestionCallback = callback;
    setControlsEnabled(false); // Disable main controls while question is shown
    hideFeedback(); // Hide feedback if shown
    // Enable only question elements
    questionInput.disabled = false;
    submitAnswerButton.disabled = false;
    questionYesButton.disabled = false;
    questionNoButton.disabled = false;
    questionInput.focus(); // Focus the input field
}

function hideQuestionInput() {
    questionContainer.classList.add('hidden');
    currentQuestionCallback = null;
    // Disable question elements when hidden
    questionInput.disabled = true;
    submitAnswerButton.disabled = true;
    questionYesButton.disabled = true;
    questionNoButton.disabled = true;
    // No automatic re-enabling here, handled by response/task completion
}
// --- END NEW --

// --- Theme Switching Functions ---
/**
 * Applies the specified theme to the body and updates the button icon.
 * @param {string} theme - The theme to apply ('light' or 'dark').
 */
function applyTheme(theme) {
    bodyElement.classList.remove('theme-light', 'theme-dark'); // Remove existing theme classes
    if (theme === LIGHT_THEME) {
        bodyElement.classList.add('theme-light');
        themeSwitcherButton.textContent = DARK_ICON; // Show moon when light
        themeSwitcherButton.title = 'Switch to Dark Theme';
    } else {
        bodyElement.classList.add('theme-dark'); // Default to dark if theme is not 'light'
        themeSwitcherButton.textContent = LIGHT_ICON; // Show sun when dark
        themeSwitcherButton.title = 'Switch to Light Theme';
    }
    // Save the preference
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
        console.warn('Could not save theme preference to localStorage:', e);
    }
}

/**
 * Toggles between light and dark themes.
 */
function toggleTheme() {
    const currentTheme = bodyElement.classList.contains('theme-light') ? LIGHT_THEME : DARK_THEME;
    const newTheme = currentTheme === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;
    applyTheme(newTheme);
    addLogMessage(`Switched to ${newTheme} theme.`, 'info');
}

/**
 * Loads the saved theme from localStorage or defaults to dark theme.
 */
function loadTheme() {
    let preferredTheme = DARK_THEME; // Default to dark
    try {
        const savedTheme = localStorage.getItem(THEME_KEY);
        if (savedTheme && (savedTheme === LIGHT_THEME || savedTheme === DARK_THEME)) {
            preferredTheme = savedTheme;
        }
    } catch (e) {
        console.warn('Could not load theme preference from localStorage:', e);
    }
    applyTheme(preferredTheme);
    console.log(`Applied initial theme: ${preferredTheme}`);
}
// --- Theme Switching Functions ---


// Initial state (MODIFIED TO LOAD THEME)
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded.');
    loadTheme(); // <<< Apply theme on load
    setControlsEnabled(true); // Enable general controls
    hideFeedback();
    hideQuestionInput(); // Ensure question input is hidden initially
    updateUploadTriggerText();

    // Initialize slider value display if elements exist
    if (temperatureSlider && temperatureValueSpan) {
         temperatureValueSpan.textContent = parseFloat(temperatureSlider.value).toFixed(1);
    }
});
