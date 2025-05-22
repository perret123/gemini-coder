/**
 * @fileoverview Internal helper function to write content to a file, ensuring parent directories exist and logging the operation.
 * c:\dev\gemini-coder\src\server\fileSystem\_writeFile.js
 */
import path from "node:path";
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

/**
 * @typedef {import('../utils.js').ContextEntry} ContextEntry
 * @typedef {import('./index.js').FileSystemHandlerContext} FileSystemHandlerContext
 * @typedef {import('./index.js').OperationResult} OperationResult
 */

/**
 * Internal function to write content to a file.
 * Creates parent directories if they don't exist.
 * Logs the operation ('createFile' or 'updateFile') to the changesLog if provided.
 * Handles merging/replacing existing log entries for the same file within the current session.
 *
 * @param {string} fullPath - The absolute path where the file should be written.
 * @param {string} content - The string content to write to the file.
 * @param {FileSystemHandlerContext} context - The context object containing the socket, base directory, changes log, and potentially the old content (if updating).
 * @param {string} filePathLog - The relative path of the file (from BASE_DIR) used for logging.
 * @param {boolean} fileExisted - Indicates whether the file existed before this write operation (used to determine log type and store oldContent).
 * @returns {Promise<OperationResult>} A promise that resolves with the operation result (success or error).
 */
export async function _writeFile(
  fullPath,
  content,
  context,
  filePathLog,
  fileExisted,
) {
  const { socket, changesLog, BASE_DIR, oldContent } = context; // Destructure oldContent from context as well
  try {
    emitLog(
      socket,
      ` fs: Writing file: ${filePathLog} (${content?.length ?? 0} bytes)`,
      "debug",
    );

    // Ensure parent directory exists
    const dir = path.dirname(fullPath);
    // Avoid trying to create the base directory itself if filePath is in root
    // Also check if BASE_DIR is defined before resolving
    const resolvedBaseDir = BASE_DIR ? path.resolve(BASE_DIR) : null;
    if (dir !== "." && resolvedBaseDir && dir !== resolvedBaseDir) {
      await fs.mkdir(dir, { recursive: true });
    }

    // Write the file content
    await fs.writeFile(fullPath, content, "utf-8");

    // Log the change if changesLog is enabled
    if (changesLog) {
      const changeType = fileExisted ? "updateFile" : "createFile";
      // Find if we already logged an operation for this file in this session
      const existingIndex = changesLog.findIndex(
        (c) => c.filePath === filePathLog,
      );

      if (existingIndex !== -1) {
        // If we previously logged 'createFile' or 'updateFile', update it.
        // Keep the 'oldContent' from the *first* operation if this is an update.
        const existingLogEntry = changesLog[existingIndex];
        if (
          existingLogEntry.type === "createFile" ||
          existingLogEntry.type === "updateFile"
        ) {
          // Update type if needed (e.g. create then update -> update)
          existingLogEntry.type = changeType;
          // Only store oldContent if it wasn't captured before AND it's available now (and file existed)
          if (
            existingLogEntry.oldContent === undefined &&
            fileExisted &&
            oldContent !== undefined
          ) {
            existingLogEntry.oldContent = oldContent;
            emitLog(
              socket,
              ` fs: [+] Updated existing log for ${filePathLog}, captured oldContent.`,
              "debug",
            );
          } else {
            emitLog(
              socket,
              ` fs: [+] Updated existing '${existingLogEntry.type}' log for ${filePathLog}.`,
              "debug",
            );
          }
        } else {
          // If previous log was 'deleteFile' or 'moveItem', this write overrides it.
          // Replace the old log entry with the new write entry.
          /** @type {ContextEntry} */
          const newLogEntry = {
            type: changeType,
            filePath: filePathLog,
            oldContent: fileExisted ? oldContent : undefined, // Store oldContent if it existed
          };
          changesLog[existingIndex] = newLogEntry;
          emitLog(
            socket,
            ` fs: [+] Replaced previous log entry for ${filePathLog} with ${changeType}.`,
            "debug",
          );
        }
      } else {
        // No previous log entry for this file, add a new one
        /** @type {ContextEntry} */
        const newLogEntry = {
          type: changeType,
          filePath: filePathLog,
          // Store oldContent if it existed, otherwise undefined
          oldContent: fileExisted ? oldContent : undefined,
        };
        changesLog.push(newLogEntry);
        emitLog(
          socket,
          ` fs: [+] Logged change: ${changeType} - ${filePathLog}`,
          "debug",
        );
      }
    }

    return { success: true };
  } catch (error) {
    const errorCode = error?.code ?? "UNKNOWN";
    const errorMessage = error?.message ?? String(error);
    emitLog(
      socket,
      ` fs: ��� Error writing file ${filePathLog}: ${errorMessage} (Code: ${errorCode})`,
      "error",
    );
    return { error: `Failed to write file '${filePathLog}': ${errorMessage}` };
  }
}
