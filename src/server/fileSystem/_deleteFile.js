const fs = require("node:fs/promises");
// Adjust the path to utils
const { emitLog } = require("../utils");

async function _deleteFile(fullPath, context, filePathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Deleting file: ${filePathLog}`, "debug");
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) {
            const msg = `Path '${filePathLog}' is not a file. Cannot delete.`;
             emitLog(socket, ` fs: ⚠️ ${msg}`, "warn");
             return { error: msg };
        }
        await fs.unlink(fullPath);

        // Log the change for potential undo and context tracking
        if (changesLog) {
             // Remove any prior create/update logs for this path, then add delete log
             const currentLog = context.changesLog;
             const filteredChanges = currentLog.filter(c => c.filePath !== filePathLog);
             currentLog.length = 0;
             currentLog.push(...filteredChanges);
             currentLog.push({
                 type: "deleteFile",
                 filePath: filePathLog,
                 oldContent: context.oldContent // Include old content if captured
             });
             emitLog(socket, ` fs: [+] Logged change: deleteFile - ${filePathLog}`, "debug");
        }

        return { success: true };
    } catch (error) {
        if (error.code === "ENOENT") {
            // If file is already gone, treat as success but log warning
            emitLog(socket, ` fs: ⚠️ File not found for deletion: '${filePathLog}'. Already deleted?`, "warn");
            // Still log the deletion attempt if needed? Maybe not if it didn't exist.
            // Return success because the desired state (file doesn't exist) is achieved.
            return { success: true, message: `File not found: '${filePathLog}' (already deleted?).` };
            // return { error: `File not found: '${filePathLog}'` }; // Or return error? Let's go with success.
        }
        emitLog(socket, ` fs: ❌ Error deleting file ${filePathLog}: ${error.message} (Code: ${error.code})`, "error");
        return { error: `Failed to delete file '${filePathLog}': ${error.message}` };
    }
}

module.exports = { _deleteFile }; // Export the function
