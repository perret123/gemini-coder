const path = require("node:path");

// Adjust the path to utils and import required functions
const { emitLog, checkSafety } = require("../utils");

// Import the internal helper functions from their new files
const { _writeFile } = require("./_writeFile");
const { _deleteFile } = require("./_deleteFile");
const { _moveItem } = require("./_moveItem");
const { _createDir } = require("./_createDir");
const { _deleteDirRecursive } = require("./_deleteDirRecursive");

// --- Undo Operation ---
// This function is called internally by the server, not directly by Gemini
async function performUndoOperation(operation, context) {
    const { socket, BASE_DIR } = context;
    emitLog(socket, `⏪ Attempting to undo operation: ${operation.type} (${operation.filePath || operation.directoryPath || operation.sourcePath})`, "info");
    let result = { error: "Unknown undo operation type" };
    // Undo operations don\"t need confirmation or change logging
    const undoContext = { socket, BASE_DIR, changesLog: null }; // No changesLog for undo itself

    try {
        let safetyCheck;
        switch (operation.type) {
            case "createFile":
                 safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Deleting originally created file: ${operation.filePath}`, "info");
                 // Use imported _deleteFile
                 result = await _deleteFile(path.resolve(BASE_DIR, operation.filePath), { ...undoContext, oldContent: null }, operation.filePath);
                break;

            case "updateFile":
                 safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 if (operation.oldContent === undefined || operation.oldContent === null) {
                     emitLog(socket, ` ⚠️ Cannot undo update for ${operation.filePath}: Original content not recorded.`, "warn");
                     return { error: `Undo failed: Original content for ${operation.filePath} unavailable.` };
                 }
                 emitLog(socket, ` Undo: Restoring original content of ${operation.filePath}`, "info");
                 // Use imported _writeFile
                 result = await _writeFile(path.resolve(BASE_DIR, operation.filePath), operation.oldContent, undoContext, operation.filePath, true);
                break;

            case "deleteFile":
                 safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Restoring originally deleted file: ${operation.filePath}`, "info");
                 // Use imported _writeFile
                 result = await _writeFile(path.resolve(BASE_DIR, operation.filePath), operation.oldContent ?? "", undoContext, operation.filePath, false);
                break;

             case "createDirectory":
                 safetyCheck = checkSafety([operation.directoryPath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Deleting originally created directory: ${operation.directoryPath}`, "info");
                 // Use imported _deleteDirRecursive
                 result = await _deleteDirRecursive(path.resolve(BASE_DIR, operation.directoryPath), undoContext, operation.directoryPath);
                break;

             case "moveItem":
                 safetyCheck = checkSafety([operation.sourcePath, operation.destinationPath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Moving item back from ${operation.destinationPath} to ${operation.sourcePath}`, "info");
                 // Use imported _moveItem
                 result = await _moveItem(
                     path.resolve(BASE_DIR, operation.destinationPath),
                     path.resolve(BASE_DIR, operation.sourcePath),
                     undoContext,
                     operation.destinationPath,
                     operation.sourcePath
                 );
                 break;

            case "deleteDirectory":
                 emitLog(socket, ` ⚠️ Undo for \"deleteDirectory\" (${operation.directoryPath}) is not supported.`, "warn");
                 result = { error: `Undo for recursive directory deletion (\"${operation.directoryPath}\") is not implemented.` };
                break;

            default:
                 emitLog(socket, ` ⚠️ Unknown undo operation type: ${operation.type}`, "warn");
                 result = { error: `Unknown undo operation type: ${operation.type}` };
        }
    } catch (undoError) {
        emitLog(socket, ` ❌ CRITICAL ERROR during undo operation ${operation.type} for ${operation.filePath || operation.directoryPath}: ${undoError.message}`, "error");
        console.error("Undo execution error:", undoError);
        result = { error: `Failed to execute undo for ${operation.type}: ${undoError.message}` };
    }

    if (result.error) {
        emitLog(socket, ` ❌ Undo failed for ${operation.type}: ${result.error}`, "error");
    } else {
        emitLog(socket, ` ✅ Undo successful for ${operation.type}`, "success");
    }
    return result;
}

module.exports = { performUndoOperation }; // Export the function
