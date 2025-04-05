const path = require("node:path");
const fs = require("node:fs/promises");
// Adjust the path to utils
const { emitLog } = require("../utils");

// --- Internal FS Operations (called by handlers) ---

async function _writeFile(fullPath, content, context, filePathLog, fileExisted) {
    const { socket, changesLog, BASE_DIR } = context;
    try {
        emitLog(socket, ` fs: Writing file: ${filePathLog} (${content.length} bytes)`, "debug");
        const dir = path.dirname(fullPath);
        // Ensure parent directories exist
        if (dir !== "." && dir !== path.resolve(BASE_DIR || "")) {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(fullPath, content, "utf-8");

        // Log the change for potential undo and context tracking
        if (changesLog) {
            const changeType = fileExisted ? "updateFile" : "createFile";
            const existingIndex = changesLog.findIndex(c => c.filePath === filePathLog);

            if (existingIndex !== -1) {
                // If updating an existing log entry (e.g., multiple writes to the same file)
                 // Update the type if it was previously a create, but keep original oldContent if present
                 changesLog[existingIndex].type = changeType;
                 // If oldContent was already captured, don't overwrite it. If not, capture it now (though might be intermediate state)
                 if (changesLog[existingIndex].oldContent === undefined && context.oldContent !== undefined) {
                     changesLog[existingIndex].oldContent = context.oldContent;
                     emitLog(socket, ` fs: [+] Updated existing log for ${filePathLog}, captured oldContent.`, "debug");
                 } else {
                    emitLog(socket, ` fs: [+] Updated existing '${changesLog[existingIndex].type}' log for ${filePathLog}.`, "debug");
                 }
            } else {
                // Add new entry
                changesLog.push({
                    type: changeType,
                    filePath: filePathLog,
                    oldContent: fileExisted ? context.oldContent : undefined // Only store old content if it existed
                });
                emitLog(socket, ` fs: [+] Logged change: ${changeType} - ${filePathLog}`, "debug");
            }
        }
         return { success: true };
    } catch (error) {
        emitLog(socket, ` fs: ❌ Error writing file ${filePathLog}: ${error.message} (Code: ${error.code})`, "error");
        return { error: `Failed to write file '${filePathLog}': ${error.message}` };
    }
}

module.exports = { _writeFile }; // Export the function
