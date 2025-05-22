// c:\dev\gemini-coder\src\server\fileSystem\_deleteDirRecursive.js
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

/**
 * @typedef {import('../utils.js').ContextEntry} ContextEntry
 */

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

/**
 * @typedef {object} OperationResult
 * @property {boolean} [success] - Indicates if the operation was successful (even if the directory didn't exist).
 * @property {string} [error] - Error message if the operation failed.
 * @property {string} [message] - Optional informational message (e.g., if the directory didn't exist).
 */

/**
 * Recursively deletes a directory and its contents.
 * If the directory does not exist, it considers the operation successful.
 * Logs the operation and adds it to the changesLog if successful and logging is enabled.
 * Note: Undo for this operation is complex and currently not fully supported.
 *
 * @param {string} fullPath - The absolute path of the directory to delete.
 * @param {FileSystemHandlerContext} context - The context object containing the socket, base directory, and changes log.
 * @param {string} dirPathLog - The relative path of the directory (from BASE_DIR) used for logging.
 * @returns {Promise<OperationResult>} A promise that resolves with the operation result.
 */
export async function _deleteDirRecursive(fullPath, context, dirPathLog) {
  const { socket, changesLog } = context;
  try {
    emitLog(
      socket,
      ` fs: Deleting directory (recursive): ${dirPathLog}`,
      "debug",
    );

    // Check if path exists and is a directory before attempting delete
    let stats;
    try {
      stats = await fs.stat(fullPath);
    } catch (statError) {
      if (statError?.code === "ENOENT") {
        // If it doesn't exist, the goal of deletion is achieved.
        emitLog(
          socket,
          ` fs: ������ Directory not found for deletion: '${dirPathLog}'. Already deleted?`,
          "warn",
        );
        return {
          success: true,
          message: `Directory not found: '${dirPathLog}' (already deleted?).`,
        };
      }
      // Re-throw other stat errors (like permission issues)
      throw statError;
    }

    if (!stats.isDirectory()) {
      const msg = `Path '${dirPathLog}' is not a directory. Cannot delete recursively.`;
      emitLog(socket, ` fs: ⚠️ ${msg}`, "warn");
      // This isn't really an error if the goal is deletion, but it's unexpected.
      return { error: msg };
    }

    // Perform the recursive deletion
    await fs.rm(fullPath, { recursive: true, force: true }); // force helps with permissions sometimes
    emitLog(
      socket,
      ` fs: Directory deleted successfully: ${dirPathLog}`,
      "debug",
    );

    // Log the change if enabled
    if (changesLog) {
      /** @type {ContextEntry} */
      const changeEntry = {
        type: "deleteDirectory",
        text: `Deleted folder: ${dirPathLog}`,
        directoryPath: dirPathLog,
      }; // Add text for context display
      changesLog.push(changeEntry);
      emitLog(
        socket,
        ` fs: [+] Logged change: deleteDirectory - ${dirPathLog}`,
        "debug",
      );
      // Add a warning about the complexity of undoing this
      emitLog(
        socket,
        ` fs: ⚠️ Undo logging for 'deleteDirectory' contents is complex and likely incomplete for ${dirPathLog}.`,
        "warn",
      );
    }
    return { success: true };
  } catch (error) {
    const errorCode = error?.code ?? "UNKNOWN";
    const errorMessage = error?.message ?? String(error);

    // Handle specific common errors
    if (errorCode === "EPERM" || errorCode === "EBUSY") {
      const msg = `Failed to delete directory '${dirPathLog}': Permission denied or resource busy.`;
      emitLog(socket, ` fs: ❌ ${msg} (Code: ${errorCode})`, "error");
      return { error: msg };
    }

    // Generic error for other cases
    emitLog(
      socket,
      ` fs: ❌ Error deleting directory ${dirPathLog}: ${errorMessage} (Code: ${errorCode})`,
      "error",
    );
    return {
      error: `Failed to delete directory '${dirPathLog}': ${errorMessage}`,
    };
  }
}
