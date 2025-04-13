// c:\dev\gemini-coder\src\server\fileSystem\_createDir.js
import fs from "node:fs/promises";
import { emitLog } from "../utils.js"; // Added .js extension

export async function _createDir(fullPath, context, dirPathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Creating directory (recursive): ${dirPathLog}`, "debug");
        try {
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) {
                emitLog(socket, ` fs: ℹ️ Directory already exists: ${dirPathLog}. No action needed.`, "info");
                return { success: true, message: `Directory '${dirPathLog}' already exists.` };
            } else {
                // Path exists but is not a directory (e.g., a file)
                const msg = `Path '${dirPathLog}' already exists but is not a directory. Cannot create directory.`;
                emitLog(socket, ` fs: ❌ ${msg}`, "error");
                return { error: msg };
            }
        } catch (statError) {
            // Only proceed if the error is ENOENT (path doesn't exist)
            if (statError.code !== "ENOENT") {
                throw statError; // Re-throw other errors (like permission issues)
            }
        }

        // If we got here, the path either doesn't exist or we are sure it's safe to create
        await fs.mkdir(fullPath, { recursive: true });

        // Add to changesLog *only if* the operation was successful and didn't just confirm existence
        if (changesLog) {
            changesLog.push({ type: "createDirectory", directoryPath: dirPathLog });
            emitLog(socket, ` fs: [+] Logged change: createDirectory - ${dirPathLog}`, "debug");
        }
        return { success: true }; // Return success even if it already existed

    } catch (error) {
        emitLog(socket, ` fs: ❌ Error creating directory ${dirPathLog}: ${error.message} (Code: ${error.code})`, "error");
        return { error: `Failed to create directory '${dirPathLog}': ${error.message}` };
    }
}
