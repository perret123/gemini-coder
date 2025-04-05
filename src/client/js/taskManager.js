let tasks = [];
let selectedTaskId = 'new'; // Default to 'new task' view

const TASK_STORAGE_KEY = 'gemini-coder-tasks';
const SELECTED_TASK_KEY = 'gemini-coder-selected-task';

function generateTaskTitle(promptText) {
    if (!promptText) return "Untitled Task";
    const maxLength = 40; // Max length for the title in the list
    let title = promptText.split('\n')[0]; // Use the first line
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
            // Basic validation
            if (Array.isArray(parsedTasks)) {
                // Ensure each task has necessary properties and defaults
                 tasks = parsedTasks.map(task => ({
                    id: task.id || String(Date.now() + Math.random()), // Assign ID if missing
                    title: task.title || generateTaskTitle(task.prompt) || "Untitled Task",
                    baseDir: task.baseDir || '',
                    prompt: task.prompt || '',
                    continueContext: task.continueContext || false, // Default to false
                    temperature: task.temperature ?? 0.7, // Default temp if missing
                    // Add other fields if needed in the future
                }));
            } else {
                console.warn("Invalid task data found in localStorage (not an array), resetting.");
                tasks = [];
            }
        } else {
            tasks = []; // No tasks saved previously
        }

        // Load last selected task ID, default to 'new'
        const lastSelected = localStorage.getItem(SELECTED_TASK_KEY);
        selectedTaskId = lastSelected || 'new';

        // Validate that the selected task ID actually exists, otherwise reset to 'new'
        if (selectedTaskId !== 'new' && !tasks.some(t => String(t.id) === String(selectedTaskId))) {
             console.warn(`Selected task ID '${selectedTaskId}' not found in loaded tasks. Resetting to 'new'.`);
             selectedTaskId = 'new';
             localStorage.setItem(SELECTED_TASK_KEY, selectedTaskId); // Save the reset state
        }

    } catch (e) {
        console.error("Error loading tasks from localStorage:", e);
        tasks = []; // Reset tasks on error
        selectedTaskId = 'new'; // Reset selection
        if (typeof addLogMessage === 'function') {
            addLogMessage("⚠️ Could not load tasks from local storage. Starting fresh.", 'warn');
        } else {
            alert("⚠️ Could not load tasks from local storage.");
        }
    }
    console.log(`Loaded ${tasks.length} tasks. Selected Task ID: ${selectedTaskId}`);
}

function saveTasks() {
    try {
        // Ensure tasks have valid IDs and titles before saving
         tasks = tasks.map(task => ({
             ...task,
             id: task.id || String(Date.now() + Math.random()),
             title: task.title || generateTaskTitle(task.prompt) || "Untitled Task"
         }));

        localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));
        localStorage.setItem(SELECTED_TASK_KEY, String(selectedTaskId)); // Save current selection
        console.log(`Saved ${tasks.length} tasks. Selected: ${selectedTaskId}`);
    } catch (e) {
        console.error("Error saving tasks to localStorage:", e);
         if (typeof addLogMessage === 'function') {
            addLogMessage("⚠️ Could not save task list to local storage. Changes may be lost.", 'warn');
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

    // Add the "New Task" item first
    const newTaskLi = document.createElement('li');
    newTaskLi.className = 'task-item new-task-item';
    newTaskLi.dataset.taskId = 'new';
    newTaskLi.textContent = '✨ New Task...';
    if (selectedTaskId === 'new') {
        newTaskLi.classList.add('active');
    }
    taskList.appendChild(newTaskLi);

    // Add saved tasks
    tasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'task-item';
        li.dataset.taskId = String(task.id); // Ensure ID is a string for comparison
        if (String(task.id) === String(selectedTaskId)) {
            li.classList.add('active');
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'task-title';
        titleSpan.textContent = task.title || "Untitled Task"; // Fallback title
        titleSpan.title = task.prompt || "No prompt"; // Tooltip with full prompt

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-task-btn';
        deleteBtn.innerHTML = '🗑️'; // Use an icon or text
        deleteBtn.title = 'Delete Task';
        deleteBtn.dataset.taskId = String(task.id); // Associate delete button with task ID

        li.appendChild(titleSpan);
        li.appendChild(deleteBtn);
        taskList.appendChild(li);
    });

    updateInputsFromSelection(); // Update form fields based on the new selection
}

function updateInputsFromSelection() {
    // Get references to all UI elements that need updating
    const baseDirInput = document.getElementById('baseDir');
    const promptInput = document.getElementById('prompt');
    const continueContextCheckbox = document.getElementById('continueContext');
    const temperatureSlider = document.getElementById('temperatureSlider');
    const temperatureValueSpan = document.getElementById('temperatureValue');
    const logOutput = document.getElementById('logOutput');
    const imageUploadInput = document.getElementById('imageUpload');
    // const contextList = document.getElementById('contextList'); // Context list element

    // Basic check for element existence
    if (!baseDirInput || !promptInput || !continueContextCheckbox || !temperatureSlider || !temperatureValueSpan || !logOutput || !imageUploadInput /*|| !contextList*/) {
        console.error("One or more input/output elements are missing from the DOM.");
        return;
    }

    if (selectedTaskId === 'new') {
        // Reset fields for a new task
        baseDirInput.value = '';
        promptInput.value = '';
        continueContextCheckbox.checked = false; // Default context off for new task
        temperatureSlider.value = 0.7; // Default temperature
        temperatureValueSpan.textContent = parseFloat(temperatureSlider.value).toFixed(1);
        logOutput.innerHTML = ''; // Clear logs
        imageUploadInput.value = ''; // Clear file selection
        if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText();
        if (typeof hideFeedback === 'function') hideFeedback(); // Hide any pending modals
        if (typeof hideQuestionInput === 'function') hideQuestionInput();
        if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Ensure controls are enabled
        if (typeof updateContextDisplay === 'function') updateContextDisplay([]); // Clear context display

        if (typeof addLogMessage === 'function') addLogMessage("Selected 'New Task'. Enter details and click Start.", "info");

    } else {
        // Find the selected task
        const task = tasks.find(t => String(t.id) === String(selectedTaskId));
        if (task) {
            // Populate fields from the selected task
            baseDirInput.value = task.baseDir;
            promptInput.value = task.prompt;
            continueContextCheckbox.checked = task.continueContext;
            temperatureSlider.value = task.temperature;
            temperatureValueSpan.textContent = parseFloat(task.temperature).toFixed(1);
            logOutput.innerHTML = ''; // Clear logs when switching tasks
            imageUploadInput.value = ''; // Clear file selection
            if (typeof updateUploadTriggerText === 'function') updateUploadTriggerText();
            if (typeof hideFeedback === 'function') hideFeedback();
            if (typeof hideQuestionInput === 'function') hideQuestionInput();
            if (typeof setControlsEnabled === 'function') setControlsEnabled(true); // Ensure controls are enabled
            if (typeof updateContextDisplay === 'function') updateContextDisplay([]); // Clear context display (will be repopulated if needed on start)

            if (typeof addLogMessage === 'function') addLogMessage(`Selected task: "${task.title}". Ready.`, "info");
        } else {
            // Should not happen if loadTasks validation works, but handle defensively
            console.error(`Selected task ID ${selectedTaskId} not found! Resetting to 'new'.`);
            selectedTaskId = 'new';
            saveTasks(); // Save the reset selection
            renderTaskList(); // Re-render to reflect the reset
        }
    }
}

function handleTaskClick(event) {
    const target = event.target;
    const taskItem = target.closest('.task-item'); // Find the parent task item li

    if (!taskItem) return; // Click wasn't inside a task item

    const taskId = taskItem.dataset.taskId;

    // Check if the delete button was clicked
    if (target.classList.contains('delete-task-btn')) {
        const taskIdToDelete = target.dataset.taskId;
        handleDeleteClick(taskIdToDelete);
        return; // Stop further processing if delete was clicked
    }

    // If a task item (but not delete button) was clicked, select it
    if (taskId && taskId !== selectedTaskId) {
        selectedTaskId = taskId;
        saveTasks(); // Save the new selection
        renderTaskList(); // Update UI to show active task and potentially load its data
    }
}


function handleDeleteClick(taskIdToDelete) {
    if (!taskIdToDelete || taskIdToDelete === 'new') return; // Cannot delete 'new' task

    const taskToDelete = tasks.find(t => String(t.id) === String(taskIdToDelete));
    if (!taskToDelete) {
        console.error(`Task to delete with ID ${taskIdToDelete} not found.`);
        return;
    }

    // Confirm deletion with the user
    if (!confirm(`Are you sure you want to delete the task "${taskToDelete.title}"? This cannot be undone.`)) {
        return; // User cancelled
    }

    // Filter out the task to delete
    tasks = tasks.filter(task => String(task.id) !== String(taskIdToDelete));

    // If the deleted task was the selected one, switch to 'new' task view
    if (selectedTaskId === taskIdToDelete) {
        selectedTaskId = 'new';
    }

    saveTasks(); // Save the updated task list and selection
    renderTaskList(); // Re-render the list

     if (typeof addLogMessage === 'function') {
         addLogMessage(`Task "${taskToDelete.title}" deleted.`, 'info');
     } else {
         console.log(`Task "${taskToDelete.title}" deleted.`);
     }
}


// Initialize Task Manager on DOM Load
document.addEventListener('DOMContentLoaded', () => {
    loadTasks(); // Load tasks from storage
    renderTaskList(); // Display the tasks

    // Attach event listener to the task list container for delegation
    const taskListElement = document.getElementById('taskList');
    if (taskListElement) {
        taskListElement.addEventListener('click', handleTaskClick);
    } else {
        console.error("Element 'taskList' not found, cannot attach click listener.");
    }
    console.log("Task Manager initialized.");
});