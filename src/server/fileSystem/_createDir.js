const fs = require("node:fs/promises");
// Adjust the path to utils
const { emitLog } = require("../utils");

async function _createDir(fullPath, context, dirPathLog) {
     const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Creating directory (recursive): ${dirPathLog}`, "debug");
        // Check if it already exists
         try {
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) {
                emitLog(socket, ` fs: ℹ️ Directory already exists: ${dirPathLog}. No action needed.`, "info");
                // Don\"t log change if it already existed
                return { success: true, message: `Directory \'${dirPathLog}\' already exists.` };
            } else {
                // Path exists but is not a directory - this is an error
                const msg = `Path \'${dirPathLog}\' already exists but is not a directory. Cannot create directory.`;
                emitLog(socket, ` fs: ❌ ${msg}`, "error");
                 return { error: msg };
            }
        } catch (statError) {
            // ENOENT means it doesn\"t exist, which is expected. Throw other errors.
            if (statError.code !== "ENOENT") {
                throw statError;
            }
            // Path doesn\"t exist, proceed to create
        }

        await fs.mkdir(fullPath, { recursive: true });

        if (changesLog) {
            changesLog.push({
                type: "createDirectory",
                directoryPath: dirPathLog
            });
             emitLog(socket, ` fs: [+] Logged change: createDirectory - ${dirPathLog}`, "debug");
        }

        return { success: true };
    } catch (error) {
        emitLog(socket, ` fs: ❌ Error creating directory ${dirPathLog}: ${error.message} (Code: ${error.code})`, "error");
        return { error: `Failed to create directory \'${dirPathLog}\': ${error.message}` };
    }
}

module.exports = { _createDir }; // Export the function
