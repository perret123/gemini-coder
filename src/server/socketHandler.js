const { emitLog } = require("./utils");
const { setupAndStartTask } = require("./taskSetup");
const { setupSocketListeners } = require("./socketListeners");

// --- Server-Side State Management ---

// Store task history/context keyed by base directory path.
// This allows resuming tasks later if the client disconnects or starts a new task
// in the same directory with "Continue Context" checked.
// Structure: Map<string (baseDir), { originalPrompt: string, baseDir: string, changes: Array<object>, timestamp: number }>
const taskStates = new Map();

// Store active chat sessions keyed by socket ID.
// This allows continuing the *same* Gemini conversation if the client refreshes
// or submits a follow-up prompt with "Continue Context" checked *without* disconnecting.
// Structure: Map<string (socketId), GenerativeChatSession>
const activeChatSessions = new Map();

/**
 * Handles a new WebSocket connection.
 * Sets up specific state and listeners for this individual connection.
 * @param {SocketIO.Socket} socket The newly connected socket instance.
 * @param {SocketIO.Server} io The main Socket.IO server instance (for broadcasting, etc.).
 */
function handleSocketConnection(socket, io) {
    console.log(`🔌 User connected: ${socket.id}`);
    emitLog(socket, "🔌 User connected and ready for tasks.", "success", true); // Make it a bubble

    // --- Connection-Specific State ---
    // Use objects with a "value" property (Refs) to allow modules modify these values
    // for the specific connection.
    const connectionState = {
        confirmAllRef: { value: false },          // Has user selected "Yes to All" for this task run?
        feedbackResolverRef: { value: null },     // Stores the resolve function for pending confirmation prompts
        questionResolverRef: { value: null },     // Stores the resolve function for pending questions
        currentChangesLogRef: { value: [] },      // Accumulates file changes for the *current* task run
        currentBaseDirRef: { value: null },       // Stores the base directory for the *current* task run
        currentOriginalPromptRef: { value: null } // Stores the initial prompt for the *current* task run
    };

    // Package all state (shared and connection-specific) for easy passing
    const overallState = {
        taskStates,         // Shared across connections
        activeChatSessions, // Shared across connections
        connectionState     // Specific to this connection
    };

    // --- Event Listeners for this Connection ---

    // Listen for the client initiating a task
    socket.on("start-task", async (data) => {
        // Delegate task setup and execution start
        // This function will handle context loading/creation and call runGeminiTask
        await setupAndStartTask(socket, data, overallState);
    });

    // Setup listeners for user responses (feedback, questions) and lifecycle events (disconnect, error)
    setupSocketListeners(socket, overallState);

    // Optional: Send initial state if needed (e.g., server version)
    // socket.emit("server-info", { version: "1.0.0" });
}

module.exports = { handleSocketConnection };
