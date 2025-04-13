// c:\dev\gemini-coder\src\client\client.js

// Import necessary functions from modules
import { addLogMessage } from "./js/logger.js";
import { initializeThemeManager } from "./js/themeManager.js";
import {
    loadContextFromLocalStorage,
    clearContextAndStorage,
    setControlsEnabled,
    hideFeedback,
    hideQuestionInput,
    updateUploadTriggerText,
    initializeModalListeners // Add this import
} from "./js/uiHelpers.js";
import { setupFileUploadAndDragDrop } from "./js/fileUploadHandler.js";
import {
    initializeTaskManager,
    generateTaskTitle,
    saveTasks,
    getTasks, // Use getter
    getSelectedTaskId, // Use getter
    addTask, // Use function to add
    updateTask // Use function to update
} from "./js/taskManager.js";
import { initializeSocket, sendTaskToServer } from "./js/socketHandlerClient.js";

// Module-level variables (initialized in DOMContentLoaded)
let baseDirInput, promptInput, continueContextCheckbox, temperatureSlider,
    temperatureValueSpan, startButton, logOutput, imageUploadInput;
let currentSocket = null; // Hold the socket instance

// --- Event Handlers ---

async function handleStartTaskClick() {
    // Ensure elements are available (should be, as this is called after DOMContentLoaded)
    if (!baseDirInput || !promptInput || !continueContextCheckbox || !temperatureSlider || !startButton || !imageUploadInput || !logOutput) {
        console.error("Core UI elements not found when trying to start task.");
        addLogMessage("Error: Critical UI elements missing.", "error", true);
        return;
    }

    const baseDir = baseDirInput.value.trim();
    const prompt = promptInput.value.trim();
    const continueContext = continueContextCheckbox.checked;
    const temperature = parseFloat(temperatureSlider.value);
    const files = imageUploadInput.files; // FileList object

    // --- Input Validation ---
    if (!baseDir) {
        addLogMessage("Please enter a Base Directory.", "error", true);
        baseDirInput.focus();
        return;
    }
    if (!prompt && (!files || files.length === 0)) { // Require prompt OR files
        addLogMessage("Please enter Your Instructions or provide files.", "error", true);
        promptInput.focus();
        return;
    }
    if (!currentSocket || !currentSocket.connected) {
        addLogMessage("Error: Not connected to server. Cannot start task.", "error", true);
        // Attempt to reconnect or notify user?
        return;
    }

    // --- Task Management ---
    const currentSelectedTaskId = getSelectedTaskId();
    let taskToRun = null;
    let taskTitle = generateTaskTitle(prompt);

    // Update or create task entry in the task manager
    if (currentSelectedTaskId === "new") {
        // Create a new task object
        const newTaskData = { baseDir, prompt, continueContext, temperature, title: taskTitle };
        taskToRun = addTask(newTaskData); // addTask handles adding to list, selecting, saving, rendering
    } else {
        // Find the existing task
        const tasks = getTasks(); // Get the current list
        const existingTask = tasks.find(t => String(t.id) === String(currentSelectedTaskId));

        if (existingTask) {
            // Check if task details have changed
            const needsUpdate =
                existingTask.baseDir !== baseDir ||
                existingTask.prompt !== prompt ||
                existingTask.continueContext !== continueContext ||
                existingTask.temperature !== temperature ||
                existingTask.title !== taskTitle;

            if (needsUpdate) {
                // Update the task in the manager
                updateTask(currentSelectedTaskId, { baseDir, prompt, continueContext, temperature, title: taskTitle });
                taskToRun = { ...existingTask, baseDir, prompt, continueContext, temperature, title: taskTitle }; // Reflect update locally for this run
            } else {
                taskToRun = existingTask; // Run with existing details
            }
        } else {
            // Error: Selected task ID not found (shouldn"t happen ideally)
            addLogMessage(`Error: Could not find selected task ${currentSelectedTaskId}. Please select "New Task" or an existing task.`, "error", true);
             // selectTask("new"); // Optionally reset UI
            return;
        }
    }

    if (!taskToRun) {
        addLogMessage(`Error: Failed to prepare task details.`, "error", true);
        return;
    }

    // --- Prepare for Task Start ---
    addLogMessage("🚀 Preparing task...", "info", true);
    setControlsEnabled(false); // Disable UI
    hideFeedback(); // Hide modals
    hideQuestionInput();

    // Clear logs and context ONLY if not continuing context
    if (!continueContext) {
        if (logOutput) logOutput.innerHTML = "";
        clearContextAndStorage(); // Clear context UI and storage
    } else {
        addLogMessage("ℹ️ Continue Context is enabled. Previous context (if any) should be visible.", "info", true);
    }

    // --- Handle File Upload (if any) ---
    let uploadedFileNames = [];
    if (files && files.length > 0) {
        addLogMessage(`⏳ Uploading ${files.length} file(s)...`, "info", true);
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append("images", files[i]); // Use "images" key to match server multer setup
        }

        try {
            const response = await fetch("/upload", { method: "POST", body: formData });
            const result = await response.json();

            if (response.ok) {
                addLogMessage(`✅ ${result.message || "Files uploaded."}`, "success", true);
                uploadedFileNames = result.files || []; // Get filenames from server response
                if (uploadedFileNames.length > 0) {
                     addLogMessage(`Uploaded file references: ${uploadedFileNames.join(", ")}`, "debug");
                }
            } else {
                addLogMessage(`❌ Upload failed: ${result.message || response.statusText}`, "error", true);
                setControlsEnabled(true); // Re-enable controls on upload failure
                return; // Stop task start
            }
        } catch (error) {
            console.error("Network or fetch error during upload:", error);
            addLogMessage(`❌ Network error during upload: ${error.message}. Check server connection.`, "error", true);
            setControlsEnabled(true); // Re-enable controls on network error
            return; // Stop task start
        }
    }

    // --- Send Task to Server ---
    addLogMessage("📡 Sending task details to server...", "info", true);
    const taskData = {
        baseDir: taskToRun.baseDir,
        prompt: taskToRun.prompt,
        continueContext: taskToRun.continueContext,
        temperature: taskToRun.temperature,
        uploadedFiles: uploadedFileNames // Send generated filenames
    };
    sendTaskToServer(taskData); // Send via socket handler

    // Clear file input after successful upload and task start signal
    if (imageUploadInput) imageUploadInput.value = "";
    updateUploadTriggerText(); // Reset upload button text
}

function handleTemperatureChange() {
    if (temperatureSlider && temperatureValueSpan) {
        const tempValue = parseFloat(temperatureSlider.value).toFixed(1);
        temperatureValueSpan.textContent = tempValue;

        // Optional: Update the selected task"s temperature in the taskManager *immediately*
        // Note: This saves changes even if the user doesn"t run the task again.
        const currentSelectedTaskId = getSelectedTaskId();
        if (currentSelectedTaskId !== "new") {
            const tasks = getTasks();
            const task = tasks.find(t => String(t.id) === String(currentSelectedTaskId));
             // Avoid unnecessary updates/saves if value hasn"t changed
            if (task && task.temperature !== parseFloat(tempValue)) {
                 // Call updateTask which handles saving and re-rendering if needed
                 updateTask(currentSelectedTaskId, { temperature: parseFloat(tempValue) });
                 // Don"t log here, updateTask handles logging
            }
        }
    }
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", () => {
    console.log("DOM fully loaded. Initializing client modules...");

    // Get core UI element references (assign to module-level vars)
    baseDirInput = document.getElementById("baseDir");
    promptInput = document.getElementById("prompt");
    continueContextCheckbox = document.getElementById("continueContext");
    temperatureSlider = document.getElementById("temperatureSlider");
    temperatureValueSpan = document.getElementById("temperatureValue");
    startButton = document.getElementById("startButton");
    logOutput = document.getElementById("logOutput");
    imageUploadInput = document.getElementById("imageUpload");

    // Check if essential elements are present
    if (!baseDirInput || !promptInput || !startButton || !logOutput) {
        console.error("FATAL: Core UI elements (baseDir, prompt, startButton, logOutput) not found on page load. Application might not function.");
        document.body.innerHTML = `<h1 style="color:red; font-family: sans-serif;">Error: Application UI failed to load correctly. Check console.</h1>`;
        return; // Stop initialization
    }

    // Initialize all modules that require it
    initializeThemeManager(); // Handles loading theme and attaching listener
    loadContextFromLocalStorage(); // Load initial context
    initializeTaskManager(); // Loads tasks, renders list, attaches listener
    initializeModalListeners(); // Attaches listeners for confirm/question buttons
    setupFileUploadAndDragDrop(); // Sets up file input and drag/drop
    currentSocket = initializeSocket(); // Initialize socket connection and listeners

    // Initial UI state setup after modules are ready
    hideFeedback();
    hideQuestionInput();
    updateUploadTriggerText();
    // Set initial control state (should be enabled if socket connects)
    if (currentSocket) { // Socket might fail to init
         // Initial state is enabled, but let socket "connect" event handle it
         // setControlsEnabled(true);
    } else {
         addLogMessage("Error: Failed to initialize server connection.", "error", true);
         setControlsEnabled(false); // Disable controls if socket fails init
    }

    // Attach main event listeners for the page
    if (startButton) {
        startButton.addEventListener("click", handleStartTaskClick);
    }
    if (temperatureSlider) {
        temperatureSlider.addEventListener("input", handleTemperatureChange);
        handleTemperatureChange(); // Set initial display value
    }

    console.log("Client-side initialization sequence complete.");
});

// No need for module.exports check
