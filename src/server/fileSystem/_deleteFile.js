// c:\dev\gemini-coder\src\server\fileSystem\_deleteFile.js
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

/**
 * @typedef {import('../utils.js').ContextEntry} ContextEntry
 * @typedef {import('./index.js').FileSystemHandlerContext} FileSystemHandlerContext
 * @typedef {import('./index.js').OperationResult} OperationResult
 */

/**
 * Deletes a file at the specified path.
 * If the file does not exist, it considers the operation successful.
 * Logs the operation and adds it to the changesLog if successful and logging is enabled.
 * Requires the caller to have read the file's content beforehand and passed it in the context
 * if undo functionality is desired.
 *
 * @param {string} fullPath - The absolute path of the file to delete.
 * @param {FileSystemHandlerContext} context - The context object containing the socket, base directory, changes log, and potentially the old content.
 * @param {string} filePathLog - The relative path of the file (from BASE_DIR) used for logging.
 * @returns {Promise<OperationResult>} A promise that resolves with the operation result.
 */
export async function _deleteFile(fullPath, context, filePathLog) {
  const { socket, changesLog } = context;
  try {
    emitLog(socket, ` fs: Deleting file: ${filePathLog}`, "debug");

    // Check if it's a file before attempting delete
    let stats;
    try {
      stats = await fs.stat(fullPath);
    } catch (statError) {
      if (statError?.code === "ENOENT") {
        // If the file doesn't exist, the goal of deletion is achieved.
        emitLog(
          socket,
          ` fs: ������ File not found for deletion: '${filePathLog}'. Already deleted?`,
          "warn",
        );
        return {
          success: true,
          message: `File not found: '${filePathLog}' (already deleted?).`,
        };
      }
      // Re-throw other stat errors (like permission issues)
      throw statError;
    }

    if (!stats.isFile()) {
      const msg = `Path '${filePathLog}' is not a file. Cannot delete.`;
      emitLog(socket, ` fs: ⚠️ ${msg}`, "warn");
      return { error: msg };
    }

    // oldContent should be passed in the context *before* calling this internal function
    // It's read by the caller (e.g., the main deleteFile handler)
    const oldContent = context.oldContent; // Assume it was read by the caller

    // Perform the deletion
    await fs.unlink(fullPath);
    emitLog(socket, ` fs: File deleted successfully: ${filePathLog}`, "debug");

    // Log the change if enabled
    if (changesLog) {
      // Remove any previous create/update logs for the same file before adding delete log
      // This prevents redundant logs like create -> delete in the same session
      const currentLog = changesLog; // Use the passed changesLog directly
      const filteredChanges = currentLog.filter(
        (c) =>
          !(
            c.filePath === filePathLog &&
            (c.type === "createFile" || c.type === "updateFile")
          ),
      );

      // Clear the original array and push back filtered items
      currentLog.length = 0;
      currentLog.push(...filteredChanges);

      // Add the delete operation with old content (if available)
      /** @type {ContextEntry} */
      const changeEntry = {
        type: "deleteFile",
        text: `Deleted file: ${filePathLog}`, // Add text for context display
        filePath: filePathLog,
        oldContent: oldContent, // Store the content fetched *before* deletion
      };
      currentLog.push(changeEntry);
      emitLog(
        socket,
        ` fs: [+] Logged change: deleteFile - ${filePathLog}`,
        "debug",
      );
    }

    return { success: true };
  } catch (error) {
    const errorCode = error?.code ?? "UNKNOWN";
    const errorMessage = error?.message ?? String(error);

    // Handle specific common errors
    if (errorCode === "EPERM" || errorCode === "EBUSY") {
      const msg = `Failed to delete file '${filePathLog}': Permission denied or resource busy.`;
      emitLog(socket, ` fs: ❌ ${msg} (Code: ${errorCode})`, "error");
      return { error: msg };
    }

    // Generic error for other cases
    emitLog(
      socket,
      ` fs: ❌ Error deleting file ${filePathLog}: ${errorMessage} (Code: ${errorCode})`,
      "error",
    );
    return { error: `Failed to delete file '${filePathLog}': ${errorMessage}` };
  }
}
