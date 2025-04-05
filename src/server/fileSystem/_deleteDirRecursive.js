const fs = require("node:fs/promises");
// Adjust the path to utils
const { emitLog } = require("../utils");

async function _deleteDirRecursive(fullPath, context, dirPathLog) {
     const { socket, changesLog } = context;
     try {
        emitLog(socket, ` fs: Deleting directory (recursive): ${dirPathLog}`, "debug");
        const stats = await fs.stat(fullPath);
         if (!stats.isDirectory()) {
             const msg = `Path \'${dirPathLog}\' is not a directory. Cannot delete recursively.`;
             emitLog(socket, ` fs: ⚠️ ${msg}`, "warn");
             return { error: msg };
         }

        await fs.rm(fullPath, { recursive: true, force: true }); // Use force? Be careful.

        if (changesLog) {
            // TODO: How to handle undo for recursive delete? Complex.
            // For now, just log the top-level deletion.
            changesLog.push({
                type: "deleteDirectory",
                directoryPath: dirPathLog
            });
             emitLog(socket, ` fs: [+] Logged change: deleteDirectory - ${dirPathLog}`, "debug");
             emitLog(socket, ` fs: ⚠️ Undo logging for \'deleteDirectory\' contents is complex and likely incomplete for ${dirPathLog}.`, "warn");
        }
        return { success: true };
    } catch (error) {
        if (error.code === "ENOENT") {
             emitLog(socket, ` fs: ⚠️ Directory not found for deletion: \'${dirPathLog}\'. Already deleted?`, "warn");
             // Return success as the desired state is achieved
             return { success: true, message: `Directory not found: \'${dirPathLog}\' (already deleted?).` };
        } else if (error.code === "EPERM" || error.code === "EBUSY") {
             const msg = `Failed to delete directory \'${dirPathLog}\': Permission denied or resource busy.`;
             emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, "error");
             return { error: msg };
        }
         emitLog(socket, ` fs: ❌ Error deleting directory ${dirPathLog}: ${error.message} (Code: ${error.code})`, "error");
         return { error: `Failed to delete directory \'${dirPathLog}\': ${error.message}` };
    }
}

module.exports = { _deleteDirRecursive }; // Export the function
