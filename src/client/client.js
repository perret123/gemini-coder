let baseDirInput, promptInput, continueContextCheckbox, temperatureSlider, temperatureValueSpan, startButton, logOutput, imageUploadInput;
let currentSocket = null; // Holds the active socket connection

async function handleStartTaskClick() {
    // Ensure all required elements are available
    if (!baseDirInput || !promptInput || !continueContextCheckbox || !temperatureSlider || !startButton || !imageUploadInput || !logOutput) {
        console.error("Core UI elements not found. Cannot start task.");
        if (typeof addLogMessage === 'function') addLogMessage('Error: Critical UI elements missing.', 'error');
        return;
    }

    // Get values from inputs
    const baseDir = baseDirInput.value.trim();
    const prompt = promptInput.value.trim();
    const continueContext = continueContextCheckbox.checked;
    const temperature = parseFloat(temperatureSlider.value);
    const files = imageUploadInput.files; // Get the FileList

    // --- Input Validation ---
    if (!baseDir) {
        if (typeof addLogMessage === 'function') addLogMessage('Please enter a Base Directory.', 'error');
        baseDirInput.focus();
        return;
    }
    if (!prompt) {
        if (typeof addLogMessage === 'function') addLogMessage('Please enter Your Instructions.', 'error');
        promptInput.focus();
        return;
    }

    // Check socket connection
    if (!currentSocket || !currentSocket.connected) {
        if (typeof addLogMessage === 'function') addLogMessage('Error: Not connected to server. Cannot start task.', 'error');
        // Maybe attempt to reconnect or prompt user? For now, just error out.
        return;
    }

    // --- Task Management (Save/Update Task State) ---
    let currentTask = null;
    let taskTitle = "Untitled Task";
    // Check if task management functions are available
    const taskManagerAvailable = typeof selectedTaskId !== 'undefined' &&
                                 typeof tasks !== 'undefined' &&
                                 typeof generateTaskTitle === 'function' &&
                                 typeof saveTasks === 'function' &&
                                 typeof renderTaskList === 'function';

    if (!taskManagerAvailable) {
         if (typeof addLogMessage === 'function') addLogMessage('Warning: Task management features unavailable. Task will not be saved.', 'warn');
    } else {
        taskTitle = generateTaskTitle(prompt);

        if (selectedTaskId === 'new') {
            // Create a new task object
            const newTaskId = String(Date.now()); // Simple unique ID
            currentTask = {
                id: newTaskId,
                title: taskTitle,
                baseDir,
                prompt,
                continueContext,
                temperature
            };
            tasks.unshift(currentTask); // Add to the beginning of the list
            selectedTaskId = newTaskId; // Select the newly created task
            saveTasks();
            renderTaskList(); // Update UI list
            if (typeof addLogMessage === 'function') addLogMessage(`✨ Created and selected new task: "${taskTitle}"`, "info");
        } else {
            // Find the existing selected task
            currentTask = tasks.find(t => String(t.id) === String(selectedTaskId));
            if (currentTask) {
                // Check if any relevant fields have changed
                 const needsUpdate = currentTask.baseDir !== baseDir ||
                                    currentTask.prompt !== prompt ||
                                    currentTask.continueContext !== continueContext ||
                                    currentTask.temperature !== temperature ||
                                    currentTask.title !== taskTitle; // Also update title if prompt changed

                 if (needsUpdate) {
                    currentTask.baseDir = baseDir;
                    currentTask.prompt = prompt;
                    currentTask.continueContext = continueContext;
                    currentTask.temperature = temperature;
                    currentTask.title = taskTitle; // Update title based on potentially new prompt
                    saveTasks();
                    renderTaskList(); // Update UI list (especially title might change)
                    if (typeof addLogMessage === 'function') addLogMessage(`🔄 Updated task "${taskTitle}" with current settings.`, "info");
                 }
            } else {
                // This case should be rare if UI is synced, but handle it
                if (typeof addLogMessage === 'function') addLogMessage(`Error: Could not find selected task ${selectedTaskId} to update/run. Starting as new task.`, 'error');
                selectedTaskId = 'new'; // Reset to new task state
                if(typeof saveTasks === 'function') saveTasks(); // Save the reset selection
                if(typeof renderTaskList === 'function') renderTaskList();
                 // Don't proceed with running the non-existent task ID
                return;
            }
        }
    }
    // --- End Task Management ---


    // --- Prepare UI for Task Start ---
    // Clear logs *only* if not continuing context. Context is managed by its own system now.
    if (!continueContext) {
        if (logOutput) logOutput.innerHTML = ''; // Clear logs
        // Note: We DON'T clear context display here anymore. It's either loaded from storage or managed by task selection.
        // if (typeof updateContextDisplay === 'function') updateContextDisplay([]); // OLD - REMOVED
    } else {
         if (typeof addLogMessage === 'function') addLogMessage('ℹ️ Continue Context is enabled. Previous context (if any) should be visible.', 'info');
         // Context should already be loaded from localStorage or will be updated by server
    }

    if (typeof addLogMessage === 'function') addLogMessage('🚀 Preparing task...', 'info');
    if (typeof setControlsEnabled === 'function') setControlsEnabled(false); // Disable UI
    if (typeof hideFeedback === 'function') hideFeedback(); // Hide any open modals
    if (typeof hideQuestionInput === 'function') hideQuestionInput();

    // --- File Upload (if files selected) ---
    let uploadedFileNames = []; // Will store names of successfully uploaded files server-side
    if (files && files.length > 0) {
        if (typeof addLogMessage === 'function') addLogMessage(`⏳ Uploading ${files.length} file(s)...`, 'info');
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append('images', files[i]); // Use 'images' as the field name expected by server
        }

        try {
            const response = await fetch('/upload', { // POST to the /upload endpoint
                method: 'POST',
                body: formData
            });
            const result = await response.json(); // Assume server responds with JSON

            if (response.ok) {
                if (typeof addLogMessage === 'function') addLogMessage(`✅ ${result.message || 'Files uploaded.'}`, 'success');
                uploadedFileNames = result.files || []; // Get the list of server-side filenames
                 if (uploadedFileNames.length > 0 && typeof addLogMessage === 'function') {
                    addLogMessage(` Uploaded file references: ${uploadedFileNames.join(', ')}`, 'debug');
                 }
            } else {
                // Handle upload failure
                 if (typeof addLogMessage === 'function') addLogMessage(`❌ Upload failed: ${result.message || response.statusText}`, 'error');
                 if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Re-enable UI
                 return; // Stop task start process
            }
        } catch (error) {
            // Handle network or other fetch errors
            console.error("Network or fetch error during upload:", error);
            if (typeof addLogMessage === 'function') addLogMessage(`❌ Network error during upload: ${error.message}. Check server connection.`, 'error');
            if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Re-enable UI
            return; // Stop task start process
        }
    }

    // --- Emit Start Task Event to Server ---
    if (typeof addLogMessage === 'function') addLogMessage('📡 Sending task details to server...', 'info');
    const taskData = {
        baseDir,
        prompt,
        continueContext,
        temperature,
        uploadedFiles: uploadedFileNames // Send the list of server filenames
    };
    currentSocket.emit('start-task', taskData);

    // --- Final UI Cleanup for this action ---
    // Clear file input *after* successful upload and task start emit
    if (imageUploadInput) imageUploadInput.value = '';
    // Update the file attachment button text/title
    if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText();
}


// --- Handle Temperature Slider Change ---
function handleTemperatureChange() {
    if (temperatureSlider && temperatureValueSpan) {
        const tempValue = parseFloat(temperatureSlider.value).toFixed(1);
        temperatureValueSpan.textContent = tempValue;

        // Optional: Update the current task's temperature in memory immediately
         if (typeof selectedTaskId !== 'undefined' && selectedTaskId !== 'new' && typeof tasks !== 'undefined') {
            const task = tasks.find(t => String(t.id) === String(selectedTaskId));
            if (task && task.temperature !== parseFloat(tempValue)) {
                 task.temperature = parseFloat(tempValue);
                 // Maybe add a visual cue or saveTasks() here if desired? For now, just update memory.
                 // saveTasks(); // Persist change immediately? Could be annoying. Better to save on start.
            }
         }
    }
}


// --- DOMContentLoaded Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded. Initializing client...');

    // --- Get Core Element References ---
    baseDirInput = document.getElementById('baseDir');
    promptInput = document.getElementById('prompt');
    continueContextCheckbox = document.getElementById('continueContext');
    temperatureSlider = document.getElementById('temperatureSlider');
    temperatureValueSpan = document.getElementById('temperatureValue');
    startButton = document.getElementById('startButton');
    logOutput = document.getElementById('logOutput');
    imageUploadInput = document.getElementById('imageUpload');

    // --- Fatal Error Check ---
    // Check if essential elements are present
    if (!baseDirInput || !promptInput || !startButton || !logOutput) {
        console.error("FATAL: Core UI elements (baseDir, prompt, startButton, logOutput) not found on page load. Application might not function.");
        // Display a prominent error to the user
        document.body.innerHTML = '<h1 style="color:red; font-family: sans-serif;">Error: Application UI failed to load correctly. Check console.</h1>';
        return; // Stop further initialization
    }

    // --- Initialize Modules ---
    // Order matters for dependencies (e.g., logger used by others)
    if (typeof loadTheme === 'function') loadTheme(); else console.warn("loadTheme function not found."); // Theme first

    // **MODIFICATION START**: Load context BEFORE task manager (which might clear it)
    if (typeof loadContextFromLocalStorage === 'function') {
        loadContextFromLocalStorage(); // Load context from previous session if available
    } else {
        console.warn("loadContextFromLocalStorage function not found. Context persistence disabled.");
    }
    // **MODIFICATION END**

    if (typeof loadTasks === 'function') loadTasks(); else console.warn("loadTasks function not found."); // Load saved tasks (might clear context if task selection changes)
    if (typeof renderTaskList === 'function') renderTaskList(); else console.warn("renderTaskList function not found."); // Render task list (needs loaded tasks)
    if (typeof setupFileUploadAndDragDrop === 'function') setupFileUploadAndDragDrop(); else console.warn("setupFileUploadAndDragDrop function not found."); // Setup file handling
    if (typeof initializeSocket === 'function') { // Initialize WebSocket connection
        currentSocket = initializeSocket();
        if (!currentSocket) {
            console.error("Socket initialization failed. Real-time features disabled.");
            // UI should reflect lack of connection (e.g., disable start button)
             if(typeof addLogMessage === 'function') addLogMessage("Error: Failed to initialize server connection.", 'error');
             if(typeof setControlsEnabled === 'function') setControlsEnabled(false);
        } else {
             // If socket connects later, 'connect' event handler should enable controls
             if(typeof addLogMessage === 'function') { /* Log handled by connect event */ }
        }
    } else {
        console.error("initializeSocket function not found. Cannot connect to server.");
        if(typeof addLogMessage === 'function') addLogMessage("Error: Cannot initialize server connection.", 'error');
        if(typeof setControlsEnabled === 'function') setControlsEnabled(false);
    }

    // --- Initial UI State ---
    if (typeof hideFeedback === 'function') hideFeedback(); // Ensure modals are hidden initially
    if (typeof hideQuestionInput === 'function') hideQuestionInput();
    if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText(); // Set initial state of file button
    // Note: Context display is handled by loadContextFromLocalStorage and taskManager selection now
    // if (typeof updateContextDisplay === 'function') updateContextDisplay([]); // OLD - REMOVED

    // --- Attach Core Event Listeners ---
    if (startButton) {
        startButton.addEventListener('click', handleStartTaskClick);
    }
    if (temperatureSlider) {
        temperatureSlider.addEventListener('input', handleTemperatureChange); // Use 'input' for real-time updates
    }

    console.log('Client-side initialization sequence complete.');

    // Final check: Enable controls only if socket connection is likely established or will be soon
    // The 'connect' event in socketHandlerClient.js is the primary place to enable controls now.
    // We can leave them disabled here initially.
    // if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Let socket connect event handle enabling
});
