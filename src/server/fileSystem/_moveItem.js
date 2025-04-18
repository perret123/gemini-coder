// c:\dev\gemini-coder\src\server\fileSystem\_moveItem.js
import path from "node:path";
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

/**
 * @typedef {import('../utils.js').ContextEntry} ContextEntry
 * @typedef {import('./index.js').FileSystemHandlerContext} FileSystemHandlerContext
 * @typedef {import('./index.js').OperationResult} OperationResult
 */

/**
 * Moves or renames a file or directory from a source path to a destination path.
 * Ensures the destination directory exists before moving. Logs the operation
 * and adds it to the changesLog if successful and logging is enabled.
 *
 * @param {string} fullSourcePath - The absolute path of the item to move.
 * @param {string} fullDestPath - The absolute path of the destination.
 * @param {FileSystemHandlerContext} context - The context object containing the socket, base directory, and changes log.
 * @param {string} sourcePathLog - The relative source path (from BASE_DIR) used for logging.
 * @param {string} destPathLog - The relative destination path (from BASE_DIR) used for logging.
 * @returns {Promise<OperationResult>} A promise that resolves with the operation result.
 */
export async function _moveItem(
  fullSourcePath,
  fullDestPath,
  context,
  sourcePathLog,
  destPathLog,
) {
  const { socket, changesLog } = context;
  try {
    emitLog(
      socket,
      ` fs: Moving item from: ${sourcePathLog} To: ${destPathLog}`,
      "debug",
    );

    // Ensure destination directory exists before moving
    // This prevents errors if renaming a file into a non-existent directory
    const destDir = path.dirname(fullDestPath);
    await fs.mkdir(destDir, { recursive: true });
    emitLog(
      socket,
      ` fs: Ensured destination directory exists: ${path.relative(context.BASE_DIR || process.cwd(), destDir) || "."}`,
      "debug",
    );

    // Perform the rename/move operation
    await fs.rename(fullSourcePath, fullDestPath);
    emitLog(
      socket,
      ` fs: Rename/move operation successful: ${sourcePathLog} -> ${destPathLog}`,
      "debug",
    );

    if (changesLog) {
      /** @type {ContextEntry} */
      const changeEntry = {
        type: "moveItem",
        text: `Moved: ${sourcePathLog} -> ${destPathLog}`, // Add text for context display
        sourcePath: sourcePathLog,
        destinationPath: destPathLog,
      };
      changesLog.push(changeEntry);
      emitLog(
        socket,
        ` fs: [+] Logged change: moveItem - ${sourcePathLog} -> ${destPathLog}`,
        "debug",
      );
    }

    return { success: true };
  } catch (error) {
    const errorCode = error?.code ?? "UNKNOWN";
    const errorMessage = error?.message ?? String(error);
    const errorMsgBase = `Failed to move item from '${sourcePathLog}' to '${destPathLog}':`;

    // Provide more specific error feedback based on common codes
    if (errorCode === "ENOENT") {
      // Check if it was the source or destination that caused the issue
      try {
        await fs.access(fullSourcePath);
        // If source exists, it's likely a problem with the destination path structure
        const msg = `${errorMsgBase} Destination path issue or file system error.`;
        emitLog(
          socket,
          ` fs: ��� ${msg} (Code: ${errorCode}) Details: ${errorMessage}`,
          "error",
        );
        return { error: msg };
      } catch (accessError) {
        // If source doesn't exist, report that
        const msg = `${errorMsgBase} Source path not found. ${accessError}`;
        emitLog(socket, ` fs: ❌ ${msg}`, "error");
        return { error: msg };
      }
    } else if (errorCode === "EPERM" || errorCode === "EBUSY") {
      const msg = `${errorMsgBase} Permission denied or resource busy.`;
      emitLog(socket, ` fs: ❌ ${msg} (Code: ${errorCode})`, "error");
      return { error: msg };
    } else if (errorCode === "ENOTEMPTY" || errorCode === "EEXIST") {
      // Directory not empty (usually when moving dir into existing one) or dest file exists
      const msg = `${errorMsgBase} Destination path already exists and cannot be overwritten directly by rename.`;
      emitLog(socket, ` fs: ❌ ${msg} (Code: ${errorCode})`, "error");
      return { error: msg };
    }

    // Generic error for other cases
    const msg = `${errorMsgBase} ${errorMessage} (Code: ${errorCode})`;
    emitLog(socket, ` fs: ❌ Error moving item: ${msg}`, "error");
    return { error: msg };
  }
}
