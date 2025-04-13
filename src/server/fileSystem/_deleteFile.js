// c:\dev\gemini-coder\src\server\fileSystem\_deleteFile.js
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

export async function _deleteFile(fullPath, context, filePathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Deleting file: ${filePathLog}`, "debug");

        // Check if it's a file before attempting delete
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) {
            const msg = `Path '${filePathLog}' is not a file. Cannot delete.`;
            emitLog(socket, ` fs: ⚠️ ${msg}`, "warn");
            return { error: msg };
        }

        // oldContent should be passed in the context *before* calling this internal function
        const oldContent = context.oldContent; // Assume it was read by the caller

        await fs.unlink(fullPath);

        if (changesLog) {
            // Remove any previous create/update logs for the same file before adding delete log
            const currentLog = context.changesLog; // Use the passed changesLog directly
            const filteredChanges = currentLog.filter(c => !(c.filePath === filePathLog && (c.type === 'createFile' || c.type === 'updateFile')));
            currentLog.length = 0; // Clear the original array
            currentLog.push(...filteredChanges); // Add back filtered items

            // Add the delete operation with old content
            currentLog.push({
                type: "deleteFile",
                filePath: filePathLog,
                oldContent: oldContent // Store the content fetched *before* deletion
            });
            emitLog(socket, ` fs: [+] Logged change: deleteFile - ${filePathLog}`, "debug");
        }

        return { success: true };
    } catch (error) {
        if (error.code === "ENOENT") {
            // If the file doesn't exist, the goal of deletion is achieved.
            emitLog(socket, ` fs: ⚠️ File not found for deletion: '${filePathLog}'. Already deleted?`, "warn");
            return { success: true, message: `File not found: '${filePathLog}' (already deleted?).` };
        }
        // Handle other errors like permissions
        emitLog(socket, ` fs: ❌ Error deleting file ${filePathLog}: ${error.message} (Code: ${error.code})`, "error");
        return { error: `Failed to delete file '${filePathLog}': ${error.message}` };
    }
}
