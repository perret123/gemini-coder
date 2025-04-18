// c:\dev\gemini-coder\src\client\js\taskManager.js
import { addLogMessage } from "./logger.js";
import {
  clearContextAndStorage,
  updateUploadTriggerText,
  hideFeedback,
  hideQuestionInput,
  setControlsEnabled,
} from "./uiHelpers.js"; // Import needed UI functions

// Module-level state for tasks
let tasks = [];
let selectedTaskId = "new"; // Represents the ID of the currently selected task ("new" for a new task)

const TASK_STORAGE_KEY = "gemini-coder-tasks";
const SELECTED_TASK_KEY = "gemini-coder-selected-task";

// --- Task Utility Functions ---

export function generateTaskTitle(promptText) {
  if (!promptText) return "Untitled Task";
  const maxLength = 40;
  let title = promptText.split("\n")[0]; // Use first line
  if (title.length > maxLength) {
    title = title.substring(0, maxLength).trim() + "...";
  }
  return title.trim() || "Untitled Task"; // Fallback if first line is whitespace
}

// --- Persistence ---

export function loadTasks() {
  try {
    const storedTasks = localStorage.getItem(TASK_STORAGE_KEY);
    if (storedTasks) {
      const parsedTasks = JSON.parse(storedTasks);
      // Basic validation: ensure it"s an array
      if (Array.isArray(parsedTasks)) {
        // Map stored data to task objects, providing defaults
        tasks = parsedTasks.map((task) => ({
          id: task.id || String(Date.now() + Math.random()), // Ensure ID exists
          title:
            task.title || generateTaskTitle(task.prompt) || "Untitled Task",
          baseDir: task.baseDir || "",
          prompt: task.prompt || "",
          continueContext: task.continueContext || false,
          temperature: task.temperature ?? 1, // Default temp if missing
        }));
      } else {
        console.warn(
          "Invalid task data found in localStorage (not an array), resetting.",
        );
        tasks = [];
      }
    } else {
      tasks = []; // No tasks stored
    }

    // Load last selected task ID
    const lastSelected = localStorage.getItem(SELECTED_TASK_KEY);
    selectedTaskId = lastSelected || "new"; // Default to "new"

    // Validate selectedTaskId: if it"s not "new" and doesn"t exist in loaded tasks, reset to "new"
    if (
      selectedTaskId !== "new" &&
      !tasks.some((t) => String(t.id) === String(selectedTaskId))
    ) {
      console.warn(
        `Selected task ID "${selectedTaskId}" not found in loaded tasks. Resetting to "new".`,
      );
      selectedTaskId = "new";
      localStorage.setItem(SELECTED_TASK_KEY, selectedTaskId); // Persist reset
    }
  } catch (e) {
    console.error("Error loading tasks from localStorage:", e);
    tasks = []; // Reset on error
    selectedTaskId = "new";
    addLogMessage(
      "⚠️ Could not load tasks from local storage. Starting fresh.",
      "warn",
      true,
    );
  }
  console.log(
    `Loaded ${tasks.length} tasks. Selected Task ID: ${selectedTaskId}`,
  );
}

export function saveTasks() {
  try {
    // Ensure all tasks have IDs and titles before saving
    tasks = tasks.map((task) => ({
      ...task,
      id: task.id || String(Date.now() + Math.random()), // Assign ID if missing
      title: task.title || generateTaskTitle(task.prompt) || "Untitled Task",
    }));
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));
    localStorage.setItem(SELECTED_TASK_KEY, String(selectedTaskId)); // Save selected ID
    console.log(`Saved ${tasks.length} tasks. Selected: ${selectedTaskId}`);
  } catch (e) {
    console.error("Error saving tasks to localStorage:", e);
    addLogMessage(
      "⚠️ Could not save task list to local storage. Changes may be lost.",
      "warn",
      true,
    );
  }
}

// --- State Accessors/Mutators ---
export function getTasks() {
  // Return a copy to prevent direct external modification? Or return ref?
  // Returning reference for now, assuming internal use is careful.
  return tasks;
}

export function getSelectedTaskId() {
  return selectedTaskId;
}

// Function to update selected task ID and re-render
export function selectTask(taskId) {
  if (taskId !== selectedTaskId) {
    selectedTaskId = taskId;
    saveTasks(); // Persist the selection change
    renderTaskList(); // Re-render the list and update inputs
  }
}

// Function to add a new task
export function addTask(taskData) {
  const newTask = {
    id: String(Date.now() + Math.random()), // Generate ID
    title: generateTaskTitle(taskData.prompt) || "Untitled Task",
    ...taskData, // Spread the rest of the data (baseDir, prompt, etc.)
  };
  tasks.unshift(newTask); // Add to the beginning of the list
  selectedTaskId = newTask.id; // Select the newly added task
  saveTasks();
  renderTaskList();
  addLogMessage(
    `✨ Created and selected new task: "${newTask.title}"`,
    "info",
    true,
  );
  return newTask; // Return the created task object
}

// Function to update an existing task
export function updateTask(taskId, updates) {
  const taskIndex = tasks.findIndex((t) => String(t.id) === String(taskId));
  if (taskIndex > -1) {
    // Generate title if prompt changed and title wasn"t explicitly provided
    if (updates.prompt && !updates.title) {
      updates.title = generateTaskTitle(updates.prompt);
    }
    tasks[taskIndex] = { ...tasks[taskIndex], ...updates };
    saveTasks();
    // Re-render might be needed if title changed
    renderTaskList(); // Simple approach: always re-render on update
    addLogMessage(
      `🔄 Updated task "${tasks[taskIndex].title}" with current settings.`,
      "info",
      true,
    );
    return true;
  }
  console.error(`Task with ID ${taskId} not found for update.`);
  return false;
}

// --- UI Rendering ---

export function renderTaskList() {
  const taskList = document.getElementById("taskList");
  if (!taskList) {
    console.error("Element " + taskList + " not found for rendering.");
    return;
  }

  taskList.innerHTML = ""; // Clear existing list

  // Add "New Task" item
  const newTaskLi = document.createElement("li");
  newTaskLi.className = "task-item new-task-item";
  newTaskLi.dataset.taskId = "new";
  newTaskLi.textContent = "✨ New Task...";
  if (selectedTaskId === "new") {
    newTaskLi.classList.add("active");
  }
  taskList.appendChild(newTaskLi);

  // Add existing tasks
  tasks.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item";
    li.dataset.taskId = String(task.id);
    if (String(task.id) === String(selectedTaskId)) {
      li.classList.add("active"); // Highlight selected task
    }

    // Task Title Span
    const titleSpan = document.createElement("span");
    titleSpan.className = "task-title";
    titleSpan.textContent = task.title || "Untitled Task";
    titleSpan.title = task.prompt || "No prompt"; // Tooltip with full prompt

    // Delete Button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-task-btn";
    deleteBtn.innerHTML = "🗑️"; // Use innerHTML for emoji
    deleteBtn.title = "Delete Task";
    deleteBtn.dataset.taskId = String(task.id); // Store ID for delete handler

    li.appendChild(titleSpan);
    li.appendChild(deleteBtn);
    taskList.appendChild(li);
  });

  // Update form inputs based on the new selection (or "new")
  updateInputsFromSelection();
}

// Updates the main form inputs based on the selected task
export function updateInputsFromSelection() {
  // Get references to all relevant UI elements
  const baseDirInput = document.getElementById("baseDir");
  const promptInput = document.getElementById("prompt");
  const continueContextCheckbox = document.getElementById("continueContext");
  const temperatureSlider = document.getElementById("temperatureSlider");
  const temperatureValueSpan = document.getElementById("temperatureValue");
  const logOutput = document.getElementById("logOutput"); // Clear logs on task switch
  const imageUploadInput = document.getElementById("imageUpload"); // Clear file input

  // Check if all elements are found
  if (
    !baseDirInput ||
    !promptInput ||
    !continueContextCheckbox ||
    !temperatureSlider ||
    !temperatureValueSpan ||
    !logOutput ||
    !imageUploadInput
  ) {
    console.error(
      "One or more input/output elements are missing from the DOM during input update.",
    );
    return;
  }

  // --- Reset State ---
  // Clear context display and storage (as context is per-task run)
  clearContextAndStorage(); // From uiHelpers
  // Clear log output
  logOutput.innerHTML = "";
  // Clear file input
  imageUploadInput.value = "";
  updateUploadTriggerText(); // Update file button text
  // Hide any pending confirmation/question modals
  hideFeedback();
  hideQuestionInput();
  // Ensure controls are enabled initially when switching tasks
  setControlsEnabled(true);

  // --- Populate Inputs ---
  if (selectedTaskId === "new") {
    // Reset form for a new task
    baseDirInput.value = "";
    promptInput.value = "";
    continueContextCheckbox.checked = false;
    temperatureSlider.value = 1; // Default temperature
    temperatureValueSpan.textContent = parseFloat(
      temperatureSlider.value,
    ).toFixed(1);
    addLogMessage(
      "Selected 'New Task'. Enter details and click Start.",
      "info",
      true,
    );
  } else {
    // Find the selected task
    const task = tasks.find((t) => String(t.id) === String(selectedTaskId));
    if (task) {
      // Populate form with task data
      baseDirInput.value = task.baseDir;
      promptInput.value = task.prompt;
      continueContextCheckbox.checked = task.continueContext;
      temperatureSlider.value = task.temperature;
      temperatureValueSpan.textContent = parseFloat(task.temperature).toFixed(
        1,
      );
      addLogMessage(`Selected task: "${task.title}". Ready.`, "info", true);
    } else {
      // Should not happen if loadTasks validation works, but handle defensively
      console.error(
        `Selected task ID ${selectedTaskId} not found! Resetting to "new".`,
      );
      selectTask("new"); // Use the selectTask function to handle reset and re-render
    }
  }
}

// --- Event Handlers ---

// Handles clicks within the task list (selection or delete)
export function handleTaskClick(event) {
  const target = event.target;
  const taskItem = target.closest(".task-item"); // Find the parent task item LI

  if (!taskItem) return; // Clicked outside a task item

  const taskId = taskItem.dataset.taskId;

  // Check if the delete button was clicked
  if (target.classList.contains("delete-task-btn")) {
    const taskIdToDelete = target.dataset.taskId; // Get ID from button"s dataset
    handleDeleteClick(taskIdToDelete);
    return; // Stop further processing
  }

  // If a task item itself (not delete button) was clicked, select it
  if (taskId) {
    // Ensure taskId is valid
    selectTask(taskId); // Use the selection function
  }
}

// Handles the delete button click confirmation and action
function handleDeleteClick(taskIdToDelete) {
  if (!taskIdToDelete || taskIdToDelete === "new") return; // Cannot delete "new" task placeholder

  const taskToDelete = tasks.find(
    (t) => String(t.id) === String(taskIdToDelete),
  );
  if (!taskToDelete) {
    console.error(`Task to delete with ID ${taskIdToDelete} not found.`);
    return;
  }

  // Confirm deletion with the user
  if (
    !confirm(
      `Are you sure you want to delete the task "${taskToDelete.title}"? This cannot be undone.`,
    )
  ) {
    return; // User cancelled
  }

  // Filter out the task to delete
  tasks = tasks.filter((task) => String(task.id) !== String(taskIdToDelete));

  // If the deleted task was selected, switch to "new" task view
  if (selectedTaskId === taskIdToDelete) {
    selectTask("new"); // Use selection function to handle UI update
  } else {
    // Otherwise, just save the updated task list (selection remains the same)
    saveTasks();
    renderTaskList(); // Re-render list without deleted item
  }

  addLogMessage(`Task "${taskToDelete.title}" deleted.`, "info", true);
}

// --- Initialization ---
export function initializeTaskManager() {
  loadTasks(); // Load tasks from storage on init
  renderTaskList(); // Render the initial list and inputs

  // Attach event listener to the task list container (event delegation)
  const taskListElement = document.getElementById("taskList");
  if (taskListElement) {
    taskListElement.addEventListener("click", handleTaskClick);
  } else {
    console.error(
      "Element 'taskList' not found, cannot attach click listener.",
    );
  }
  console.log("Task Manager initialized.");
}

// No need for module.exports check
