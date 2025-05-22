// c:\dev\gemini-coder\src\server\fileSystem\performUndoOperation.js
import path from "node:path";
import { emitLog, checkSafety } from "../utils.js"; // Added .js extension
import { _writeFile } from "./_writeFile.js"; // Added .js extension
import { _deleteFile } from "./_deleteFile.js"; // Added .js extension
import { _moveItem } from "./_moveItem.js"; // Added .js extension
import { _createDir } from "./_createDir.js"; // Added .js extension
import { _deleteDirRecursive } from "./_deleteDirRecursive.js"; // Added .js extension

export async function performUndoOperation(operation, context) {
  const { socket, BASE_DIR } = context;

  // Log the attempt
  const operationTarget =
    operation.filePath ||
    operation.directoryPath ||
    `${operation.sourcePath} -> ${operation.destinationPath}`;
  emitLog(
    socket,
    `⏪ Attempting to undo operation: ${operation.type} (${operationTarget})`,
    "info",
  );

  let result = { error: "Unknown undo operation type" };
  // Create a minimal context for the internal file operations, ensuring no changesLog recursion
  const undoContext = { socket, BASE_DIR, changesLog: null }; // Explicitly null changesLog

  try {
    let safetyCheck;

    switch (operation.type) {
      case "createFile":
        safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        emitLog(
          socket,
          ` Undo: Deleting originally created file: ${operation.filePath}`,
          "info",
        );
        // We need to pass the file path log representation too
        result = await _deleteFile(
          path.resolve(BASE_DIR, operation.filePath),
          { ...undoContext, oldContent: null }, // No old content needed for delete undo
          operation.filePath, // Pass the relative path for logging within _deleteFile if needed
        );
        break;

      case "updateFile":
        safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        if (
          operation.oldContent === undefined ||
          operation.oldContent === null
        ) {
          emitLog(
            socket,
            ` ⚠️ Cannot undo update for ${operation.filePath}: Original content not recorded.`,
            "warn",
          );
          return {
            error: `Undo failed: Original content for ${operation.filePath} unavailable.`,
          };
        }
        emitLog(
          socket,
          ` Undo: Restoring original content of ${operation.filePath}`,
          "info",
        );
        result = await _writeFile(
          path.resolve(BASE_DIR, operation.filePath),
          operation.oldContent,
          undoContext, // Pass the minimal context
          operation.filePath, // Pass the relative path log
          true, // Indicate the file existed before this undo write
        );
        break;

      case "deleteFile":
        safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        emitLog(
          socket,
          ` Undo: Restoring originally deleted file: ${operation.filePath}`,
          "info",
        );
        // Restore with oldContent if available, otherwise empty string
        result = await _writeFile(
          path.resolve(BASE_DIR, operation.filePath),
          operation.oldContent ?? "",
          undoContext,
          operation.filePath,
          false, // Indicate the file did *not* exist before this undo write
        );
        break;

      case "createDirectory":
        safetyCheck = checkSafety([operation.directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        emitLog(
          socket,
          ` Undo: Deleting originally created directory: ${operation.directoryPath}`,
          "info",
        );
        result = await _createDir(
          path.resolve(BASE_DIR, operation.directoryPath),
          undoContext,
          operation.directoryPath,
        );
        break;

      case "moveItem":
        // Undo involves moving from destination back to source
        safetyCheck = checkSafety(
          [operation.sourcePath, operation.destinationPath],
          BASE_DIR,
          socket,
        );
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        emitLog(
          socket,
          ` Undo: Moving item back from ${operation.destinationPath} to ${operation.sourcePath}`,
          "info",
        );
        result = await _moveItem(
          path.resolve(BASE_DIR, operation.destinationPath), // Source for undo is the original destination
          path.resolve(BASE_DIR, operation.sourcePath), // Destination for undo is the original source
          undoContext,
          operation.destinationPath, // Log source for undo
          operation.sourcePath, // Log destination for undo
        );
        break;

      case "deleteDirectory":
        safetyCheck = checkSafety([operation.directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        emitLog(
          socket,
          ` Undo: Restoring originally deleted directory: ${operation.directoryPath}`,
          "info",
        );
        result = await _deleteDirRecursive(
          path.resolve(BASE_DIR, operation.directoryPath),
          undoContext,
          operation.directoryPath,
        );
        break;
      default:
        emitLog(
          socket,
          ` ⚠️ Unknown undo operation type: ${operation.type}`,
          "warn",
        );
        result = { error: `Unknown undo operation type: ${operation.type}` };
    }
  } catch (undoError) {
    emitLog(
      socket,
      ` ❌ CRITICAL ERROR during undo operation ${operation.type} for ${operationTarget}: ${undoError.message}`,
      "error",
    );
    console.error("Undo execution error:", undoError);
    result = {
      error: `Failed to execute undo for ${operation.type}: ${undoError.message}`,
    };
  }

  // Log final result
  if (result.error) {
    emitLog(
      socket,
      ` ❌ Undo failed for ${operation.type}: ${result.error}`,
      "error",
    );
  } else {
    emitLog(socket, ` ✅ Undo successful for ${operation.type}`, "success");
  }
  return result;
}
