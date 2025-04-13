// c:\dev\gemini-coder\src\server\fileSystem\_deleteDirRecursive.js
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

export async function _deleteDirRecursive(fullPath, context, dirPathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Deleting directory (recursive): ${dirPathLog}`, "debug");
        // Check if path exists before attempting delete for better logging
        const stats = await fs.stat(fullPath);
        if (!stats.isDirectory()) {
            const msg = `Path '${dirPathLog}' is not a directory. Cannot delete recursively.`;
            emitLog(socket, ` fs: ⚠️ ${msg}`, "warn");
            // This isn't really an error if the goal is deletion, but it's unexpected.
            return { error: msg };
        }

        await fs.rm(fullPath, { recursive: true, force: true }); // force helps with permissions sometimes

        if (changesLog) {
            // TODO: For more robust undo, list contents before deleting? Very complex.
            changesLog.push({ type: "deleteDirectory", directoryPath: dirPathLog });
            emitLog(socket, ` fs: [+] Logged change: deleteDirectory - ${dirPathLog}`, "debug");
            emitLog(socket, ` fs: ⚠️ Undo logging for 'deleteDirectory' contents is complex and likely incomplete for ${dirPathLog}.`, "warn");
        }
        return { success: true };
    } catch (error) {
        if (error.code === "ENOENT") {
            // If it doesn't exist, the goal of deletion is achieved.
            emitLog(socket, ` fs: ⚠️ Directory not found for deletion: '${dirPathLog}'. Already deleted?`, "warn");
            return { success: true, message: `Directory not found: '${dirPathLog}' (already deleted?).` };
        } else if (error.code === "EPERM" || error.code === "EBUSY") {
            // More specific error message for common issues
            const msg = `Failed to delete directory '${dirPathLog}': Permission denied or resource busy.`;
            emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, "error");
            return { error: msg };
        }
        // Generic error for other cases
        emitLog(socket, ` fs: ❌ Error deleting directory ${dirPathLog}: ${error.message} (Code: ${error.code})`, "error");
        return { error: `Failed to delete directory '${dirPathLog}': ${error.message}` };
    }
}
