// c:\dev\gemini-coder\src\server\fileSystem\_moveItem.js
import path from "node:path";
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

export async function _moveItem(fullSourcePath, fullDestPath, context, sourcePathLog, destPathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Moving item from: ${sourcePathLog} To: ${destPathLog}`, "debug");

        // Ensure destination directory exists before moving
        await fs.mkdir(path.dirname(fullDestPath), { recursive: true });

        // Perform the rename/move operation
        await fs.rename(fullSourcePath, fullDestPath);

        if (changesLog) {
            // TODO: Consider consolidating moves if an item is moved multiple times?
            changesLog.push({
                type: "moveItem",
                sourcePath: sourcePathLog,
                destinationPath: destPathLog
            });
            emitLog(socket, ` fs: [+] Logged change: moveItem - ${sourcePathLog} -> ${destPathLog}`, "debug");
        }

        return { success: true };
    } catch (error) {
        const errorMsgBase = `Failed to move item from '${sourcePathLog}' to '${destPathLog}':`;

        // Provide more specific error feedback based on common codes
        if (error.code === "ENOENT") {
            // Check if it was the source or destination that caused the issue
            try {
                await fs.access(fullSourcePath);
                // If source exists, it's likely a problem with the destination path structure
                const msg = `${errorMsgBase} Destination path issue or file system error.`;
                emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code}) Details: ${error.message}`, "error");
                return { error: `${msg}` };
            } catch (accessError) {
                // If source doesn't exist, report that
                const msg = `${errorMsgBase} Source path not found.`;
                emitLog(socket, ` fs: ❌ ${msg}`, "error");
                return { error: msg };
            }
        } else if (error.code === "EPERM" || error.code === "EBUSY") {
            const msg = `${errorMsgBase} Permission denied or resource busy.`;
            emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, "error");
            return { error: msg };
        } else if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
            // Directory not empty (usually when moving dir into existing one) or dest file exists
            const msg = `${errorMsgBase} Destination path already exists and cannot be overwritten directly by rename.`;
            emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, "error");
            return { error: msg };
        }

        // Generic error for other cases
        const msg = `${errorMsgBase} ${error.message} (Code: ${error.code})`;
        emitLog(socket, ` fs: ❌ Error moving item: ${msg}`, "error");
        return { error: msg };
    }
}
