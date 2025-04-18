// c:\dev\gemini-coder\src\server\socketHandler.js
import { emitLog } from "./utils.js"; // Added .js
import { setupAndStartTask } from "./taskSetup.js"; // Added .js
import { setupSocketListeners } from "./socketListeners.js"; // Added .js

// Global state (consider alternatives like per-user state if scaling)
const taskStates = new Map(); // Stores { baseDir: { originalPrompt, changes: [], timestamp } }
const activeChatSessions = new Map(); // Stores { socket.id: chatSession }

// Export the main handler function
export function handleSocketConnection(socket) {
  console.log(`🔌 User connected: ${socket.id}`);
  emitLog(socket, "🔌 User connected and ready for tasks.", "success", true);

  // --- Connection-Specific State ---
  // Use refs (objects with a .value property) to allow modifications
  // to be visible across different function scopes (like handlers and runner)
  // without needing to pass the whole state object everywhere.
  const connectionState = {
    confirmAllRef: { value: false },
    feedbackResolverRef: { value: null }, // Holds the resolve function for pending confirmation
    questionResolverRef: { value: null }, // Holds the resolve function for pending question
    currentChangesLogRef: { value: [] }, // Holds changes *during* a single task run segment
    currentBaseDirRef: { value: null }, // Current base dir for this connection"s task
    currentOriginalPromptRef: { value: null }, // Original prompt for the *current* task run
  };

  // Combine global and connection state for passing down
  const overallState = {
    taskStates, // Global map of saved task states
    activeChatSessions, // Global map of active Gemini sessions
    connectionState, // State specific to this connection
  };

  // Listener for starting a new task
  socket.on("start-task", async (data) => {
    // Pass the socket, task data, and the combined state object
    await setupAndStartTask(socket, data, overallState);
  });

  // Setup other general listeners (confirmation, disconnect, error, etc.)
  setupSocketListeners(socket, overallState);

  // Add other potential one-off listeners here if needed
  // socket.on("some-other-event", (data) => { ... });
}

// No need for module.exports when using ES6 modules
