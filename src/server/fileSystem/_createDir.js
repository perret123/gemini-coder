// c:\dev\gemini-coder\src\server\fileSystem\_createDir.js
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

/**
 * @typedef {import('../utils.js').ContextEntry} ContextEntry
 * @typedef {import('./index.js').FileSystemHandlerContext} FileSystemHandlerContext
 * @typedef {import('./index.js').OperationResult} OperationResult
 */

/**
 * @typedef {object} OperationResult
 * @property {boolean} [success] - Indicates if the operation was successful (even if the directory already existed).
 * @property {string} [error] - Error message if the operation failed.
 * @property {string} [message] - Optional informational message (e.g., if the directory already existed).
 */

/**
 * Creates a directory recursively at the specified path.
 * If the directory already exists, it considers the operation successful.
 * Logs the operation and adds it to the changesLog if successful and logging is enabled.
 *
 * @param {string} fullPath - The absolute path where the directory should be created.
 * @param {FileSystemHandlerContext} context - The context object containing the socket, base directory, and changes log.
 * @param {string} dirPathLog - The relative path of the directory (from BASE_DIR) used for logging.
 * @returns {Promise<OperationResult>} A promise that resolves with the operation result.
 */
export async function _createDir(fullPath, context, dirPathLog) {
  const { socket, changesLog } = context;
  try {
    emitLog(
      socket,
      ` fs: Creating directory (recursive): ${dirPathLog}`,
      "debug",
    );
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        emitLog(
          socket,
          ` fs: ������ Directory already exists: ${dirPathLog}. No action needed.`,
          "info",
        );
        return {
          success: true,
          message: `Directory '${dirPathLog}' already exists.`,
        };
      } else {
        // Path exists but is not a directory (e.g., a file)
        const msg = `Path '${dirPathLog}' already exists but is not a directory. Cannot create directory.`;
        emitLog(socket, ` fs: ��� ${msg}`, "error");
        return { error: msg };
      }
    } catch (statError) {
      // Only proceed if the error is ENOENT (path doesn't exist)
      if (statError?.code !== "ENOENT") {
        throw statError; // Re-throw other errors (like permission issues)
      }
      // If ENOENT, it means the path doesn't exist, which is the expected case for creation.
      emitLog(
        socket,
        ` fs: Path ${dirPathLog} does not exist, proceeding with creation.`,
        "debug",
      );
    }

    // If we got here, the path either doesn't exist or we are sure it's safe to create
    await fs.mkdir(fullPath, { recursive: true });
    emitLog(
      socket,
      ` fs: Directory created successfully: ${dirPathLog}`,
      "debug",
    );

    // Add to changesLog *only if* the operation was successful and didn't just confirm existence
    if (changesLog) {
      /** @type {ContextEntry} */
      const changeEntry = {
        type: "createDirectory",
        text: `Created folder: ${dirPathLog}`,
        directoryPath: dirPathLog,
      }; // Add text for context display
      changesLog.push(changeEntry);
      emitLog(
        socket,
        ` fs: [+] Logged change: createDirectory - ${dirPathLog}`,
        "debug",
      );
    }
    return { success: true }; // Return success
  } catch (error) {
    const errorCode = error?.code ?? "UNKNOWN";
    const errorMessage = error?.message ?? String(error);
    emitLog(
      socket,
      ` fs: ❌ Error creating directory ${dirPathLog}: ${errorMessage} (Code: ${errorCode})`,
      "error",
    );
    return {
      error: `Failed to create directory '${dirPathLog}': ${errorMessage}`,
    };
  }
}
