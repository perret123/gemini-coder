// c:\dev\gemini-coder\src\server\fileSystem\index.js

// Import named exports from the modules
import { loadGitignore } from "./loadGitignore.js";
import { createFileSystemHandlers } from "./createFileSystemHandlers.js";
import { performUndoOperation } from "./performUndoOperation.js";

// Export them as named exports
export { loadGitignore, createFileSystemHandlers, performUndoOperation };

/**
 * @typedef {object} FileSystemHandlerContext
 * @property {Socket} socket - The Socket.IO client instance.
 * @property {string} BASE_DIR - The absolute base directory path for operations.
 * @property {ContextEntry[] | null} changesLog - Array to log file system changes for potential undo, or null if logging is disabled.
 * @property {boolean} [confirmAllRef] - Reference object indicating if all confirmations should be skipped.
 * @property {object} [feedbackResolverRef] - Reference object holding the resolve function for pending feedback.
 * @property {object} [questionResolverRef] - Reference object holding the resolve function for pending questions.
 * @property {string | null} [oldContent] - Optional old content of a file, used for logging/undo.
 */
