// c:\dev\gemini-coder\src\server\fileSystem\_writeFile.js
import path from "node:path";
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

export async function _writeFile(fullPath, content, context, filePathLog, fileExisted) {
    const { socket, changesLog, BASE_DIR } = context;
    try {
        emitLog(socket, ` fs: Writing file: ${filePathLog} (${content?.length ?? 0} bytes)`, "debug");

        // Ensure parent directory exists
        const dir = path.dirname(fullPath);
        // Avoid trying to create the base directory itself if filePath is in root
        if (dir !== "." && dir !== path.resolve(BASE_DIR || "")) {
             await fs.mkdir(dir, { recursive: true });
        }

        // Write the file content
        await fs.writeFile(fullPath, content, "utf-8");

        // Log the change
        if (changesLog) {
            const changeType = fileExisted ? "updateFile" : "createFile";
            // Find if we already logged an operation for this file in this session
            const existingIndex = changesLog.findIndex(c => c.filePath === filePathLog);

            if (existingIndex !== -1) {
                // If we previously logged 'createFile' or 'updateFile', update it.
                // Keep the 'oldContent' from the *first* operation if this is an update.
                if (changesLog[existingIndex].type === 'createFile' || changesLog[existingIndex].type === 'updateFile') {
                     // Update type if needed (e.g. create then update -> update)
                     changesLog[existingIndex].type = changeType;
                     // Only store oldContent if it wasn't captured before AND it's available now
                     if (changesLog[existingIndex].oldContent === undefined && context.oldContent !== undefined) {
                        changesLog[existingIndex].oldContent = context.oldContent;
                        emitLog(socket, ` fs: [+] Updated existing log for ${filePathLog}, captured oldContent.`, "debug");
                     } else {
                        emitLog(socket, ` fs: [+] Updated existing '${changesLog[existingIndex].type}' log for ${filePathLog}.`, "debug");
                     }
                } else {
                    // If previous log was 'deleteFile' or 'moveItem', this write overrides it.
                    // Replace the old log entry with the new write entry.
                    changesLog[existingIndex] = {
                        type: changeType,
                        filePath: filePathLog,
                        oldContent: fileExisted ? context.oldContent : undefined
                    };
                     emitLog(socket, ` fs: [+] Replaced previous log entry for ${filePathLog} with ${changeType}.`, "debug");
                }

            } else {
                // No previous log entry for this file, add a new one
                changesLog.push({
                    type: changeType,
                    filePath: filePathLog,
                    // Store oldContent if it existed, otherwise undefined
                    oldContent: fileExisted ? context.oldContent : undefined
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
