let tasks = [];
let selectedTaskId = 'new';
const TASK_STORAGE_KEY = 'gemini-coder-tasks';
const SELECTED_TASK_KEY = 'gemini-coder-selected-task';

function generateTaskTitle(promptText) {
    if (!promptText) return "Untitled Task";
    const maxLength = 40;
    let title = promptText.split('\n')[0];
    if (title.length > maxLength) {
        title = title.substring(0, maxLength).trim() + '...';
    }
    return title.trim() || "Untitled Task";
}

function loadTasks() {
    try {
        const storedTasks = localStorage.getItem(TASK_STORAGE_KEY);
        if (storedTasks) {
            const parsedTasks = JSON.parse(storedTasks);
            if (Array.isArray(parsedTasks)) {
                // Ensure all loaded tasks have necessary properties
                tasks = parsedTasks.map(task => ({
                    id: task.id || String(Date.now() + Math.random()), // Ensure ID
                    title: task.title || generateTaskTitle(task.prompt) || "Untitled Task", // Ensure title
                    baseDir: task.baseDir || '',
                    prompt: task.prompt || '',
                    continueContext: task.continueContext || false,
                    temperature: task.temperature ?? 1, // Default temperature if missing
                }));
            } else {
                console.warn("Invalid task data found in localStorage (not an array), resetting.");
                tasks = [];
            }
        } else {
            tasks = []; // No tasks saved yet
        }

        const lastSelected = localStorage.getItem(SELECTED_TASK_KEY);
        selectedTaskId = lastSelected || 'new'; // Default to 'new' if nothing selected

        // Validate selectedTaskId exists in the loaded tasks
        if (selectedTaskId !== 'new' && !tasks.some(t => String(t.id) === String(selectedTaskId))) {
            console.warn(`Selected task ID '${selectedTaskId}' not found in loaded tasks. Resetting to 'new'.`);
            selectedTaskId = 'new';
            localStorage.setItem(SELECTED_TASK_KEY, selectedTaskId); // Update storage
        }
    } catch (e) {
        console.error("Error loading tasks from localStorage:", e);
        tasks = []; // Reset tasks on error
        selectedTaskId = 'new'; // Reset selection
        if (typeof addLogMessage === 'function') {
            // ADDED isAction flag
            addLogMessage("⚠️ Could not load tasks from local storage. Starting fresh.", 'warn', true);
        } else {
            alert("⚠️ Could not load tasks from local storage.");
        }
    }
    console.log(`Loaded ${tasks.length} tasks. Selected Task ID: ${selectedTaskId}`);
}

function saveTasks() {
    try {
        // Ensure tasks have IDs and titles before saving
        tasks = tasks.map(task => ({
            ...task,
            id: task.id || String(Date.now() + Math.random()),
            title: task.title || generateTaskTitle(task.prompt) || "Untitled Task"
        }));
        localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));
        localStorage.setItem(SELECTED_TASK_KEY, String(selectedTaskId)); // Save selection
        console.log(`Saved ${tasks.length} tasks. Selected: ${selectedTaskId}`);
    } catch (e) {
        console.error("Error saving tasks to localStorage:", e);
        if (typeof addLogMessage === 'function') {
            // ADDED isAction flag
            addLogMessage("⚠️ Could not save task list to local storage. Changes may be lost.", 'warn', true);
        } else {
            alert("⚠️ Could not save task list to local storage. Changes may be lost.");
        }
    }
}

function renderTaskList() {
    const taskList = document.getElementById('taskList');
    if (!taskList) {
        console.error("Element 'taskList' not found for rendering.");
        return;
    }
    taskList.innerHTML = ''; // Clear existing list

    // Add "New Task" item
    const newTaskLi = document.createElement('li');
    newTaskLi.className = 'task-item new-task-item';
    newTaskLi.dataset.taskId = 'new';
    newTaskLi.textContent = '✨ New Task...';
    if (selectedTaskId === 'new') {
        newTaskLi.classList.add('active');
    }
    taskList.appendChild(newTaskLi);

    // Add existing tasks
    tasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'task-item';
        li.dataset.taskId = String(task.id); // Ensure taskId is string
        if (String(task.id) === String(selectedTaskId)) { // Compare as strings
            li.classList.add('active');
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'task-title';
        titleSpan.textContent = task.title || "Untitled Task";
        titleSpan.title = task.prompt || "No prompt"; // Tooltip with full prompt

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-task-btn';
        deleteBtn.innerHTML = '🗑️'; // Use innerHTML for emoji
        deleteBtn.title = 'Delete Task';
        deleteBtn.dataset.taskId = String(task.id); // Store ID for delete action

        li.appendChild(titleSpan);
        li.appendChild(deleteBtn);
        taskList.appendChild(li);
    });

    updateInputsFromSelection(); // Update form fields based on the new selection
}


function updateInputsFromSelection() {
    const baseDirInput = document.getElementById('baseDir');
    const promptInput = document.getElementById('prompt');
    const continueContextCheckbox = document.getElementById('continueContext');
    const temperatureSlider = document.getElementById('temperatureSlider');
    const temperatureValueSpan = document.getElementById('temperatureValue');
    const logOutput = document.getElementById('logOutput');
    const imageUploadInput = document.getElementById('imageUpload');

    // Check if all elements exist
    if (!baseDirInput || !promptInput || !continueContextCheckbox || !temperatureSlider || !temperatureValueSpan || !logOutput || !imageUploadInput ) {
        console.error("One or more input/output elements are missing from the DOM.");
        return;
    }

    // Clear context and logs when switching tasks
    if (typeof clearContextAndStorage === 'function') {
        clearContextAndStorage();
    } else {
        console.error("clearContextAndStorage function not found! Cannot clear context properly.");
        // Fallback: try to clear visually if possible
        if (typeof updateContextDisplay === 'function') updateContextDisplay([]);
    }
    logOutput.innerHTML = '';
    imageUploadInput.value = ''; // Clear file input
    if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText(); // Update file button text
    if (typeof hideFeedback === 'function') hideFeedback(); // Hide modals
    if (typeof hideQuestionInput === 'function') hideQuestionInput();
    if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Ensure controls are enabled

    if (selectedTaskId === 'new') {
        // Reset form for a new task
        baseDirInput.value = '';
        promptInput.value = '';
        continueContextCheckbox.checked = false;
        temperatureSlider.value = 1; // Default temperature
        temperatureValueSpan.textContent = parseFloat(temperatureSlider.value).toFixed(1);
        if (typeof addLogMessage === 'function') {
            // ADDED isAction flag
            addLogMessage("Selected 'New Task'. Enter details and click Start.", "info", true);
        }
    } else {
        // Find the selected task and populate the form
        const task = tasks.find(t => String(t.id) === String(selectedTaskId));
        if (task) {
            baseDirInput.value = task.baseDir;
            promptInput.value = task.prompt;
            continueContextCheckbox.checked = task.continueContext;
            temperatureSlider.value = task.temperature;
            temperatureValueSpan.textContent = parseFloat(task.temperature).toFixed(1);
            if (typeof addLogMessage === 'function') {
                // ADDED isAction flag
                addLogMessage(`Selected task: "${task.title}". Ready.`, "info", true);
            }
        } else {
            // If task not found (shouldn't happen with loadTasks validation, but just in case)
            console.error(`Selected task ID ${selectedTaskId} not found! Resetting to 'new'.`);
            selectedTaskId = 'new';
            saveTasks(); // Save the reset selection
            renderTaskList(); // Re-render to show 'new' as active
        }
    }
}

function handleTaskClick(event) {
    const target = event.target;
    const taskItem = target.closest('.task-item'); // Find the parent task item
    if (!taskItem) return; // Clicked outside a task item

    const taskId = taskItem.dataset.taskId;

    // Handle delete button click
    if (target.classList.contains('delete-task-btn')) {
        const taskIdToDelete = target.dataset.taskId;
        handleDeleteClick(taskIdToDelete);
        return; // Stop further processing
    }

    // Handle task selection click (on the li itself or title)
    if (taskId && taskId !== selectedTaskId) {
        selectedTaskId = taskId;
        saveTasks(); // Save the new selection
        renderTaskList(); // Re-render the list with the new active item
    }
}

function handleDeleteClick(taskIdToDelete) {
    if (!taskIdToDelete || taskIdToDelete === 'new') return; // Cannot delete "New Task"

    const taskToDelete = tasks.find(t => String(t.id) === String(taskIdToDelete));
    if (!taskToDelete) {
        console.error(`Task to delete with ID ${taskIdToDelete} not found.`);
        return;
    }

    // Confirmation dialog
    if (!confirm(`Are you sure you want to delete the task "${taskToDelete.title}"? This cannot be undone.`)) {
        return;
    }

    // Filter out the task to delete
    tasks = tasks.filter(task => String(task.id) !== String(taskIdToDelete));

    // If the deleted task was the selected one, switch to "New Task"
    if (selectedTaskId === taskIdToDelete) {
        selectedTaskId = 'new';
    }

    saveTasks(); // Save the updated task list and selection
    renderTaskList(); // Re-render the list

    if (typeof addLogMessage === 'function') {
        // ADDED isAction flag
        addLogMessage(`Task "${taskToDelete.title}" deleted.`, 'info', true);
    } else {
        console.log(`Task "${taskToDelete.title}" deleted.`);
    }
}


// Initialize Task Manager on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    loadTasks();      // Load tasks from storage
    renderTaskList(); // Render the initial list

    const taskListElement = document.getElementById('taskList');
    if (taskListElement) {
        // Use event delegation for handling clicks within the task list
        taskListElement.addEventListener('click', handleTaskClick);
    } else {
        console.error("Element 'taskList' not found, cannot attach click listener.");
    }
    console.log("Task Manager initialized.");
});

// ... (existing code) ...

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generateTaskTitle,
        loadTasks,
        saveTasks,
        renderTaskList,
        updateInputsFromSelection,
        handleTaskClick,
        handleDeleteClick,
        // Export state variables if tests *need* direct access, but prefer testing via functions
        // tasks,
        // selectedTaskId
    };
  }