// c:\dev\gemini-coder\src\client\js\taskManager.js
import { addLogMessage } from "./logger.js";
import {
  clearContextAndStorage,
  updateUploadTriggerText,
  hideFeedback,
  hideQuestionInput,
  setControlsEnabled,
} from "./uiHelpers.js";
import { fetchLastIndexedTime } from "./socketHandlerClient.js"; // Corrected import

// Module-level state for tasks
let tasks = [];
let selectedTaskId = "new"; // Represents the ID of the currently selected task ("new" for a new task)
let baseDirHistory = []; // For storing recent base directories

const TASK_STORAGE_KEY = "gemini-coder-tasks";
const SELECTED_TASK_KEY = "gemini-coder-selected-task";
const BASE_DIR_HISTORY_KEY = "gemini-coder-base-dir-history"; // New key for base directory history
const MAX_BASE_DIR_HISTORY = 10; // Max number of base directories to store

// --- Base Directory History Functions ---
function loadBaseDirHistory() {
  try {
    const storedHistory = localStorage.getItem(BASE_DIR_HISTORY_KEY);
    if (storedHistory) {
      const parsedHistory = JSON.parse(storedHistory);
      if (Array.isArray(parsedHistory)) {
        baseDirHistory = parsedHistory;
      }
    }
  } catch (e) {
    console.error("Error loading base directory history from localStorage:", e);
    baseDirHistory = [];
  }
}

function saveBaseDirHistory() {
  try {
    localStorage.setItem(BASE_DIR_HISTORY_KEY, JSON.stringify(baseDirHistory));
  } catch (e) {
    console.error("Error saving base directory history to localStorage:", e);
  }
}

function addBaseDirToHistory(baseDir) {
  if (!baseDir || typeof baseDir !== "string" || !baseDir.trim()) {
    return; // Do not add empty or invalid base directories
  }
  const trimmedBaseDir = baseDir.trim();
  // Remove existing entry if it exists to move it to the top (most recent)
  baseDirHistory = baseDirHistory.filter((dir) => dir !== trimmedBaseDir);
  baseDirHistory.unshift(trimmedBaseDir); // Add to the beginning
  // Limit history size
  if (baseDirHistory.length > MAX_BASE_DIR_HISTORY) {
    baseDirHistory = baseDirHistory.slice(0, MAX_BASE_DIR_HISTORY);
  }
  saveBaseDirHistory();
  populateBaseDirDatalist(); // Update datalist after adding
}

function populateBaseDirDatalist() {
  const datalist = document.getElementById("baseDirHistory");
  if (datalist) {
    datalist.innerHTML = ""; // Clear existing options
    baseDirHistory.forEach((dir) => {
      const option = document.createElement("option");
      option.value = dir;
      datalist.appendChild(option);
    });
  }
}

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
      if (Array.isArray(parsedTasks)) {
        tasks = parsedTasks.map((task) => ({
          id: task.id || String(Date.now() + Math.random()),
          title:
            task.title || generateTaskTitle(task.prompt) || "Untitled Task",
          baseDir: task.baseDir || "",
          prompt: task.prompt || "",
          continueContext: task.continueContext || false,
          temperature: task.temperature ?? 1,
        }));
      } else {
        console.warn(
          "Invalid task data found in localStorage (not an array), resetting.",
        );
        tasks = [];
      }
    } else {
      tasks = [];
    }

    const lastSelected = localStorage.getItem(SELECTED_TASK_KEY);
    selectedTaskId = lastSelected || "new";

    if (
      selectedTaskId !== "new" &&
      !tasks.some((t) => String(t.id) === String(selectedTaskId))
    ) {
      console.warn(
        `Selected task ID "${selectedTaskId}" not found in loaded tasks. Resetting to "new".`,
      );
      selectedTaskId = "new";
      localStorage.setItem(SELECTED_TASK_KEY, selectedTaskId);
    }
  } catch (e) {
    console.error("Error loading tasks from localStorage:", e);
    tasks = [];
    selectedTaskId = "new";
    addLogMessage(
      "⚠️ Could not load tasks from local storage. Starting fresh.",
      "warn",
      true,
    );
  }
  loadBaseDirHistory(); // Load base directory history
  console.log(
    `Loaded ${tasks.length} tasks. Selected Task ID: ${selectedTaskId}`,
  );
}

export function saveTasks() {
  try {
    tasks = tasks.map((task) => {
      // Add current task"s baseDir to history if it exists
      if (task.baseDir) {
        addBaseDirToHistory(task.baseDir);
      }
      return {
        ...task,
        id: task.id || String(Date.now() + Math.random()),
        title: task.title || generateTaskTitle(task.prompt) || "Untitled Task",
      };
    });
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));
    localStorage.setItem(SELECTED_TASK_KEY, String(selectedTaskId));
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
  return tasks;
}

export function getSelectedTaskId() {
  return selectedTaskId;
}

export function selectTask(taskId) {
  if (taskId !== selectedTaskId) {
    selectedTaskId = taskId;
    saveTasks(); // Persist the selection change (this will also update baseDirHistory via saveTasks -> addBaseDirToHistory)
    renderTaskList();
  }
}

export function addTask(taskData) {
  const newTask = {
    id: String(Date.now() + Math.random()),
    title: generateTaskTitle(taskData.prompt) || "Untitled Task",
    ...taskData,
  };
  tasks.unshift(newTask);
  selectedTaskId = newTask.id;
  if (newTask.baseDir) {
    // Add new task"s baseDir to history
    addBaseDirToHistory(newTask.baseDir);
  }
  saveTasks();
  renderTaskList();
  addLogMessage(
    `✨ Created and selected new task: "${newTask.title}"`,
    "info",
    true,
  );
  return newTask;
}

export function updateTask(taskId, updates) {
  const taskIndex = tasks.findIndex((t) => String(t.id) === String(taskId));
  if (taskIndex > -1) {
    if (updates.prompt && !updates.title) {
      updates.title = generateTaskTitle(updates.prompt);
    }
    tasks[taskIndex] = { ...tasks[taskIndex], ...updates };
    if (updates.baseDir) {
      // If baseDir is updated, add it to history
      addBaseDirToHistory(updates.baseDir);
    }
    saveTasks();
    renderTaskList();
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

  taskList.innerHTML = "";

  const newTaskLi = document.createElement("li");
  newTaskLi.className = "task-item new-task-item";
  newTaskLi.dataset.taskId = "new";
  newTaskLi.textContent = "✨ New Task...";
  if (selectedTaskId === "new") {
    newTaskLi.classList.add("active");
  }
  taskList.appendChild(newTaskLi);

  tasks.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item";
    li.dataset.taskId = String(task.id);
    if (String(task.id) === String(selectedTaskId)) {
      li.classList.add("active");
    }

    const titleSpan = document.createElement("span");
    titleSpan.className = "task-title";
    titleSpan.textContent = task.title || "Untitled Task";
    titleSpan.title = task.prompt || "No prompt";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-task-btn";
    deleteBtn.innerHTML = "🗑️";
    deleteBtn.title = "Delete Task";
    deleteBtn.dataset.taskId = String(task.id);

    li.appendChild(titleSpan);
    li.appendChild(deleteBtn);
    taskList.appendChild(li);
  });

  updateInputsFromSelection();
}

export function updateInputsFromSelection() {
  const baseDirInput = document.getElementById("baseDir");
  const promptInput = document.getElementById("prompt");
  const continueContextCheckbox = document.getElementById("continueContext");
  const temperatureSlider = document.getElementById("temperatureSlider");
  const temperatureValueSpan = document.getElementById("temperatureValue");
  const logOutput = document.getElementById("logOutput");
  const imageUploadInput = document.getElementById("imageUpload");

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

  populateBaseDirDatalist(); // Populate datalist when inputs are updated

  clearContextAndStorage();
  logOutput.innerHTML = "";
  imageUploadInput.value = "";
  updateUploadTriggerText();
  hideFeedback();
  hideQuestionInput();
  setControlsEnabled(true);

  if (selectedTaskId === "new") {
    baseDirInput.value = "";
    promptInput.value = "";
    continueContextCheckbox.checked = false;
    temperatureSlider.value = 1;
    temperatureValueSpan.textContent = parseFloat(
      temperatureSlider.value,
    ).toFixed(1);
    addLogMessage(
      "Selected 'New Task'. Enter details and click Start.",
      "info",
      true,
    );
  } else {
    const task = tasks.find((t) => String(t.id) === String(selectedTaskId));
    if (task) {
      baseDirInput.value = task.baseDir;
      promptInput.value = task.prompt;
      continueContextCheckbox.checked = task.continueContext;
      temperatureSlider.value = task.temperature;
      temperatureValueSpan.textContent = parseFloat(task.temperature).toFixed(
        1,
      );
      addLogMessage(`Selected task: "${task.title}". Ready.`, "info", true);
      // Add the selected task"s baseDir to history if not already prominent
      if (task.baseDir) addBaseDirToHistory(task.baseDir);
    } else {
      console.error(
        `Selected task ID ${selectedTaskId} not found! Resetting to "new".`,
      );
      selectTask("new");
    }
  }

  if (selectedTaskId === "new") {
    if (typeof fetchLastIndexedTime === "function") fetchLastIndexedTime("");
  } else {
    const task = tasks.find((t) => String(t.id) === String(selectedTaskId));
    if (task) {
      if (typeof fetchLastIndexedTime === "function")
        fetchLastIndexedTime(task.baseDir);
    } else {
      if (typeof fetchLastIndexedTime === "function") fetchLastIndexedTime("");
    }
  }
  // Add event listener to baseDir input to update history on change
  if (baseDirInput) {
    baseDirInput.addEventListener("change", (event) => {
      if (event.target.value) {
        addBaseDirToHistory(event.target.value);
      }
    });
  }
}

// --- Event Handlers ---

export function handleTaskClick(event) {
  const target = event.target;
  const taskItem = target.closest(".task-item");

  if (!taskItem) return;

  const taskId = taskItem.dataset.taskId;

  if (target.classList.contains("delete-task-btn")) {
    const taskIdToDelete = target.dataset.taskId;
    handleDeleteClick(taskIdToDelete);
    return;
  }

  if (taskId) {
    selectTask(taskId);
  }
}

function handleDeleteClick(taskIdToDelete) {
  if (!taskIdToDelete || taskIdToDelete === "new") return;

  const taskToDelete = tasks.find(
    (t) => String(t.id) === String(taskIdToDelete),
  );
  if (!taskToDelete) {
    console.error(`Task to delete with ID ${taskIdToDelete} not found.`);
    return;
  }

  if (
    !confirm(
      `Are you sure you want to delete the task "${taskToDelete.title}"? This cannot be undone.`,
    )
  ) {
    return;
  }

  tasks = tasks.filter((task) => String(task.id) !== String(taskIdToDelete));

  if (selectedTaskId === taskIdToDelete) {
    selectTask("new");
  } else {
    saveTasks();
    renderTaskList();
  }

  addLogMessage(`Task "${taskToDelete.title}" deleted.`, "info", true);
}

// --- Initialization ---
export function initializeTaskManager() {
  loadTasks(); // Load tasks and base directory history
  renderTaskList(); // Render the initial list and inputs (which calls updateInputsFromSelection -> populateBaseDirDatalist)

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
