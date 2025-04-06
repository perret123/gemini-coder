let baseDirInput, promptInput, continueContextCheckbox, temperatureSlider, temperatureValueSpan, startButton, logOutput, imageUploadInput;
let currentSocket = null;

async function handleStartTaskClick() {
    // Ensure all required elements are available
    if (!baseDirInput || !promptInput || !continueContextCheckbox || !temperatureSlider || !startButton || !imageUploadInput || !logOutput) {
        console.error("Core UI elements not found. Cannot start task.");
        if (typeof addLogMessage === 'function') addLogMessage('Error: Critical UI elements missing.', 'error', true); // Bubble
        return;
    }

    const baseDir = baseDirInput.value.trim();
    const prompt = promptInput.value.trim();
    const continueContext = continueContextCheckbox.checked;
    const temperature = parseFloat(temperatureSlider.value);
    const files = imageUploadInput.files;

    // --- Input Validation ---
    if (!baseDir) {
        if (typeof addLogMessage === 'function') addLogMessage('Please enter a Base Directory.', 'error', true); // Bubble
        baseDirInput.focus();
        return;
    }
    if (!prompt) {
        if (typeof addLogMessage === 'function') addLogMessage('Please enter Your Instructions.', 'error', true); // Bubble
        promptInput.focus();
        return;
    }
    if (!currentSocket || !currentSocket.connected) {
        if (typeof addLogMessage === 'function') addLogMessage('Error: Not connected to server. Cannot start task.', 'error', true); // Bubble
        return;
    }
    // --- End Validation ---

    let currentTask = null;
    let taskTitle = "Untitled Task";
    const taskManagerAvailable = typeof selectedTaskId !== 'undefined' && typeof tasks !== 'undefined' &&
                                typeof generateTaskTitle === 'function' && typeof saveTasks === 'function' &&
                                typeof renderTaskList === 'function';

    if (!taskManagerAvailable) {
        if (typeof addLogMessage === 'function') addLogMessage('Warning: Task management features unavailable. Task will not be saved.', 'warn', true); // Bubble
    } else {
        taskTitle = generateTaskTitle(prompt);
        if (selectedTaskId === 'new') {
            // Create new task
            const newTaskId = String(Date.now()); // Simple unique ID
            currentTask = { id: newTaskId, title: taskTitle, baseDir, prompt, continueContext, temperature };
            tasks.unshift(currentTask); // Add to the beginning of the array
            selectedTaskId = newTaskId; // Select the new task
            saveTasks();
            renderTaskList();
            if (typeof addLogMessage === 'function') addLogMessage(`✨ Created and selected new task: "${taskTitle}"`, "info", true); // Bubble
        } else {
            // Update existing selected task if necessary
            currentTask = tasks.find(t => String(t.id) === String(selectedTaskId));
            if (currentTask) {
                const needsUpdate = currentTask.baseDir !== baseDir ||
                                    currentTask.prompt !== prompt ||
                                    currentTask.continueContext !== continueContext ||
                                    currentTask.temperature !== temperature ||
                                    currentTask.title !== taskTitle; // Update title if prompt changed enough
                if (needsUpdate) {
                    currentTask.baseDir = baseDir;
                    currentTask.prompt = prompt;
                    currentTask.continueContext = continueContext;
                    currentTask.temperature = temperature;
                    currentTask.title = taskTitle; // Update title based on current prompt
                    saveTasks();
                    renderTaskList(); // Re-render to reflect potential title change
                    if (typeof addLogMessage === 'function') addLogMessage(`🔄 Updated task "${taskTitle}" with current settings.`, "info", true); // Bubble
                }
            } else {
                // Should not happen if UI is synced, but handle gracefully
                if (typeof addLogMessage === 'function') addLogMessage(`Error: Could not find selected task ${selectedTaskId} to update/run. Starting as new task.`, 'error', true); // Bubble
                selectedTaskId = 'new';
                if(typeof saveTasks === 'function') saveTasks();
                if(typeof renderTaskList === 'function') renderTaskList();
                return; // Don't proceed with task start
            }
        }
    }

    // Clear logs if not continuing context
    if (!continueContext) {
        if (logOutput) logOutput.innerHTML = '';
        // Also clear stored context if applicable
        if (typeof clearContextAndStorage === 'function') clearContextAndStorage();
    } else {
        if (typeof addLogMessage === 'function') addLogMessage('ℹ️ Continue Context is enabled. Previous context (if any) should be visible.', 'info', true); // Bubble
    }

    if (typeof addLogMessage === 'function') addLogMessage('🚀 Preparing task...', 'info', true); // Bubble
    if (typeof setControlsEnabled === 'function') setControlsEnabled(false); // Disable controls
    if (typeof hideFeedback === 'function') hideFeedback(); // Hide any open modals
    if (typeof hideQuestionInput === 'function') hideQuestionInput();

    // --- File Upload (if necessary) ---
    let uploadedFileNames = [];
    if (files && files.length > 0) {
        if (typeof addLogMessage === 'function') addLogMessage(`⏳ Uploading ${files.length} file(s)...`, 'info', true); // Bubble
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append('images', files[i]); // Use 'images' as the field name expected by server
        }

        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            const result = await response.json();

            if (response.ok) {
                if (typeof addLogMessage === 'function') addLogMessage(`✅ ${result.message || 'Files uploaded.'}`, 'success', true); // Bubble
                uploadedFileNames = result.files || [];
                if (uploadedFileNames.length > 0 && typeof addLogMessage === 'function') {
                     // Keep debug logs plain
                    addLogMessage(`Uploaded file references: ${uploadedFileNames.join(', ')}`, 'debug');
                }
            } else {
                if (typeof addLogMessage === 'function') addLogMessage(`❌ Upload failed: ${result.message || response.statusText}`, 'error', true); // Bubble
                if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Re-enable controls on failure
                return; // Stop task start
            }
        } catch (error) {
            console.error("Network or fetch error during upload:", error);
            if (typeof addLogMessage === 'function') addLogMessage(`❌ Network error during upload: ${error.message}. Check server connection.`, 'error', true); // Bubble
            if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Re-enable controls on failure
            return; // Stop task start
        }
    }
    // --- End File Upload ---

    if (typeof addLogMessage === 'function') addLogMessage('📡 Sending task details to server...', 'info', true); // Bubble

    const taskData = {
        baseDir,
        prompt,
        continueContext,
        temperature,
        uploadedFiles: uploadedFileNames // Send the list of uploaded filenames
    };

    // Emit the task start event to the server
    currentSocket.emit('start-task', taskData);

    // Clear the file input visually after upload/task start
    if (imageUploadInput) imageUploadInput.value = '';
    if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText();
}

function handleTemperatureChange() {
    if (temperatureSlider && temperatureValueSpan) {
        const tempValue = parseFloat(temperatureSlider.value).toFixed(1);
        temperatureValueSpan.textContent = tempValue;

        // Update the temperature in the selected task object if task manager is available
        const taskManagerAvailable = typeof selectedTaskId !== 'undefined' && typeof tasks !== 'undefined';
         if (taskManagerAvailable && selectedTaskId !== 'new') {
             const task = tasks.find(t => String(t.id) === String(selectedTaskId));
             if (task && task.temperature !== parseFloat(tempValue)) {
                 task.temperature = parseFloat(tempValue);
                 // Optionally save tasks immediately on temp change, or wait until task start
                 // if(typeof saveTasks === 'function') saveTasks();
             }
         }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded. Initializing client...');

    // --- Get Core UI Element References ---
    baseDirInput = document.getElementById('baseDir');
    promptInput = document.getElementById('prompt');
    continueContextCheckbox = document.getElementById('continueContext');
    temperatureSlider = document.getElementById('temperatureSlider');
    temperatureValueSpan = document.getElementById('temperatureValue');
    startButton = document.getElementById('startButton');
    logOutput = document.getElementById('logOutput');
    imageUploadInput = document.getElementById('imageUpload');
    // --- End Element References ---

    // Fatal error check if core elements are missing
    if (!baseDirInput || !promptInput || !startButton || !logOutput) {
        console.error("FATAL: Core UI elements (baseDir, prompt, startButton, logOutput) not found on page load. Application might not function.");
        document.body.innerHTML = '<h1 style="color:red; font-family: sans-serif;">Error: Application UI failed to load correctly. Check console.</h1>';
        return;
    }

    // --- Initialize Modules & UI ---
    if (typeof loadTheme === 'function') loadTheme(); else console.warn("loadTheme function not found.");
    if (typeof loadContextFromLocalStorage === 'function') loadContextFromLocalStorage(); else console.warn("loadContextFromLocalStorage function not found. Context persistence disabled.");
    if (typeof loadTasks === 'function') loadTasks(); else console.warn("loadTasks function not found.");
    if (typeof renderTaskList === 'function') renderTaskList(); else console.warn("renderTaskList function not found."); // loadTasks calls renderTaskList internally now
    if (typeof setupFileUploadAndDragDrop === 'function') setupFileUploadAndDragDrop(); else console.warn("setupFileUploadAndDragDrop function not found.");

    // Initialize Socket.IO connection
    if (typeof initializeSocket === 'function') {
        currentSocket = initializeSocket(); // Assuming initializeSocket returns the socket instance
        if (!currentSocket) {
            console.error("Socket initialization failed. Real-time features disabled.");
            if(typeof addLogMessage === 'function') addLogMessage("Error: Failed to initialize server connection.", 'error', true); // Bubble
            if(typeof setControlsEnabled === 'function') setControlsEnabled(false);
        }
        // No else needed for success message, handled by socket 'connect' event
    } else {
        console.error("initializeSocket function not found. Cannot connect to server.");
        if(typeof addLogMessage === 'function') addLogMessage("Error: Cannot initialize server connection.", 'error', true); // Bubble
        if(typeof setControlsEnabled === 'function') setControlsEnabled(false);
    }

    // Initial UI state setup
    if (typeof hideFeedback === 'function') hideFeedback();
    if (typeof hideQuestionInput === 'function') hideQuestionInput();
    if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText();
    // Ensure controls are enabled initially (unless socket connection failed)
    if (currentSocket && typeof setControlsEnabled === 'function') setControlsEnabled(true);


    // --- Add Event Listeners ---
    if (startButton) {
        startButton.addEventListener('click', handleStartTaskClick);
    }
    if (temperatureSlider) {
        temperatureSlider.addEventListener('input', handleTemperatureChange);
        // Initial display update for temperature
        handleTemperatureChange();
    }
    // Other module-specific listeners (like modals) are set up within their respective files
    // --- End Event Listeners ---

    console.log('Client-side initialization sequence complete.');
});

// ... (existing code for handleStartTaskClick, handleTemperatureChange, etc.)...

// Add exports for the functions the test needs
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        handleStartTaskClick,
        handleTemperatureChange
        // Export others if your tests evolve to need them
    };
}

// Keep the DOMContentLoaded listener as it is for browser execution
document.addEventListener('DOMContentLoaded', () => {
   // ... (existing DOMContentLoaded code) ...
});