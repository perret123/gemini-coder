const path = require("node:path");
const fs = require("node:fs/promises");
// Adjust the path to utils
const { emitLog } = require("../utils");

async function _moveItem(fullSourcePath, fullDestPath, context, sourcePathLog, destPathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Moving item from: ${sourcePathLog} To: ${destPathLog}`, "debug");
        // Ensure destination directory exists
        await fs.mkdir(path.dirname(fullDestPath), { recursive: true });
        await fs.rename(fullSourcePath, fullDestPath);

        if (changesLog) {
            changesLog.push({
                type: "moveItem",
                sourcePath: sourcePathLog,
                destinationPath: destPathLog
            });
             emitLog(socket, ` fs: [+] Logged change: moveItem - ${sourcePathLog} -> ${destPathLog}`, "debug");
        }
        return { success: true };
    } catch (error) {
        const errorMsgBase = `Failed to move item from \'${sourcePathLog}\' to \'${destPathLog}\':`;
        if (error.code === "ENOENT") {
            // Check if source or destination issue
            try {
                await fs.access(fullSourcePath);
                // Source exists, must be destination issue
                const msg = `${errorMsgBase} Destination path issue or file system error.`;
                emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code}) Details: ${error.message}`, "error");
                return { error: `${msg}` };
            } catch (accessError) {
                // Source doesn\'t exist
                 const msg = `${errorMsgBase} Source path not found.`;
                 emitLog(socket, ` fs: ❌ ${msg}`, "error");
                 return { error: msg };
            }
        } else if (error.code === "EPERM" || error.code === "EBUSY") {
            const msg = `${errorMsgBase} Permission denied or resource busy.`;
            emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, "error");
            return { error: msg };
        } else if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
             const msg = `${errorMsgBase} Destination path already exists and cannot be overwritten directly by rename.`;
             emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, "error");
             return { error: msg };
        }
        // Default error
        const msg = `${errorMsgBase} ${error.message} (Code: ${error.code})`;
        emitLog(socket, ` fs: ❌ Error moving item: ${msg}`, "error");
        return { error: msg };
    }
}

module.exports = { _moveItem }; // Export the function
