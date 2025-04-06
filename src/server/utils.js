// c:\dev\gemini-coder\src\server\utils.js
const fs = require("fs").promises;
const path = require("path");
const diff = require("diff");

// Modify the function signature
function emitLog(socketInstance, message, type = 'info', isAction = false) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const logPrefix = `[${timestamp}] [${type.toUpperCase()}]`;

    // --- Keep existing console logging logic ---
    if (type !== 'debug' || process.env.DEBUG_LOGGING === 'true') {
        const consoleMethod = type === 'error' ? console.error : (type === 'warn' ? console.warn : console.log);
        const lines = String(message).split('\n');
        if (lines.length > 1) {
            consoleMethod(`${logPrefix} ${lines[0]}`);
            for(let i = 1; i < lines.length; i++) {
                consoleMethod(` ${' '.repeat(logPrefix.length-1)} ${lines[i]}`); // Align multi-line logs
            }
        } else {
            consoleMethod(`${logPrefix} ${message}`);
        }
    }

    if (socketInstance && socketInstance.connected) {
        try {
            // Pass the isAction flag in the emitted data
            socketInstance.emit('log', {
                message: message, // Send raw message without timestamp for cleaner bubbles
                type,
                isAction // Include the flag
            });
        } catch (emitError) {
            console.warn(`[${timestamp}] [WARN] Failed to emit log to socket ${socketInstance.id}: ${emitError.message}`);
        }
    } else if (socketInstance && !socketInstance.connected) {
        // Optionally log that the message couldn't be sent if needed
        // console.log(`[${timestamp}] [DEBUG] Socket ${socketInstance.id} disconnected, log not sent: ${message}`);
    }
}

// Function to emit context information to the client
function emitContextLog(socketInstance, contextData) {
    if (socketInstance && socketInstance.connected) {
        socketInstance.emit("context-update", contextData);
    }
}

function emitContextLogEntry(socketInstance, type, text) {
    if (socketInstance && socketInstance.connected) {
        // Ensure text is a string, even if null/undefined is passed
        const entryText = String(text ?? '(No details provided)');
        const payload = { type: type, text: entryText };
        // console.debug(`Emitting context entry:`, payload); // Optional debug log
        socketInstance.emit("context-update", payload);
    }
}

// NEW function for sending the full array
function emitFullContextUpdate(socketInstance, changesArray) {
    if (socketInstance && socketInstance.connected) {
        if (!Array.isArray(changesArray)) {
             console.error("emitFullContextUpdate ERROR: changesArray is not an array!", changesArray);
             // Optionally emit an error or default payload
             emitContextLogEntry(socketInstance, 'error', 'Internal Server Error: Invalid context data format.');
             return;
        }
        const payload = { changes: changesArray };
        // console.debug(`Emitting full context update: ${changesArray.length} items`); // Optional debug log
        socketInstance.emit("context-update", payload);
    }
}

// Function to generate diff
function generateDiff(oldContent, newContent, filename) {
    // Basic check if content is identical
    if (oldContent === newContent) {
        return "(No changes)";
    }

    try {
        const patch = diff.createPatch(filename, oldContent || "", newContent || "", undefined, undefined, {
            context: 3, // Number of context lines around changes
        });

        // Filter out the patch header lines (---, +++, @@) for a cleaner look in the log
        const lines = patch.split("\n");
        const relevantLines = lines.slice(2).filter(line => line.trim() !== "\\ No newline at end of file");

        // Check if, after removing headers, there are any actual change lines left
        if (!relevantLines.some(line => line.startsWith("+") || line.startsWith("-"))) {
            return "(No changes)"; // Content might differ only by whitespace or metadata ignored by diff
        }

        // Add back a simplified header and join lines
        return `--- a/${filename}\n+++ b/${filename}\n${relevantLines.join("\n")}`;
    } catch (error) {
        console.error(`Error generating diff for ${filename}:`, error);
        return "Error generating diff.";
    }
}


/**
 * Requests confirmation from the user via socket event.
 * @param {object} socketInstance - The socket.io socket instance.
 * @param {string} message - The confirmation message.
 * @param {function} setResolverCallback - Callback to set the promise resolver.
 * @param {string|null} [diffData=null] - Optional diff string to display.
 * @returns {Promise<string>} A promise that resolves with the user's decision ('yes', 'no', 'yes/all', 'disconnect', 'error', 'task-end').
 */
function requestUserConfirmation(socketInstance, message, setResolverCallback, diffData = null) {
    return new Promise((resolve) => {
        // Set the resolver function that the 'user-feedback' listener will call
        setResolverCallback(resolve);

        // Prepare payload
        const payload = { message, diff: diffData };

        // Emit the request to the client
        socketInstance.emit('confirmation-request', payload);

        // Log that we are waiting
        emitLog(socketInstance, `⏳ Waiting for user confirmation: ${message}`, 'confirm');
        // Context log for confirmation request is now handled by the caller (e.g., writeFileContent)
        // emitContextLog(socketInstance, 'confirmation_request', `Confirm: ${message}`);
    });
}

/**
 * Checks if a given path is safely within the specified base directory.
 * @param {string} filePath - The path to check (relative or potentially absolute).
 * @param {string} currentBaseDir - The absolute path of the allowed base directory.
 * @returns {boolean} True if the path is safe, false otherwise.
 */
function isPathSafe(filePath, currentBaseDir) {
    if (!currentBaseDir || !filePath) {
        console.warn(`isPathSafe check failed: Missing baseDir ('${currentBaseDir}') or filePath ('${filePath}')`);
        return false;
    }
    try {
        const resolvedPath = path.resolve(currentBaseDir, filePath);
        // Check if the resolved path starts with the base directory path followed by a separator,
        // or if it *is* the base directory path itself.
        return resolvedPath.startsWith(currentBaseDir + path.sep) || resolvedPath === currentBaseDir;
    } catch (error) {
        // Path resolution might fail for invalid characters etc.
        console.error(`Error resolving path safety for "${filePath}" against "${currentBaseDir}":`, error);
        return false;
    }
}

/**
 * Checks if all provided paths are safe relative to the base directory.
 * @param {string[]} paths - An array of relative paths to check.
 * @param {string} currentBaseDir - The absolute path of the allowed base directory.
 * @param {object|null} socket - The socket instance for logging.
 * @returns {{safe: boolean, error?: string}} An object indicating safety and an optional error message.
 */
function checkSafety(paths, currentBaseDir, socket) {
    if (!currentBaseDir) {
        const message = "Operation cannot proceed: Base directory is not defined.";
        emitLog(socket, `🔒 SECURITY ERROR: ${message}`, 'error');
        emitContextLog(socket, 'error', `Security Error: Base directory not set.`);
        return { safe: false, error: message };
    }

    const unsafePaths = paths.filter(p => !isPathSafe(p, currentBaseDir));

    if (unsafePaths.length > 0) {
        const message = `Access denied: Path(s) are outside the allowed base directory ('${path.basename(currentBaseDir)}'). Unsafe paths: ${unsafePaths.join(', ')}`;
         emitLog(socket, `🔒 SECURITY WARNING: ${message}`, 'warn');
         emitContextLog(socket, 'error', `Security Error: Path outside base directory (${unsafePaths.join(', ')})`);
        return { safe: false, error: message };
    }

    return { safe: true };
}


/**
 * Recursively gets the directory structure, respecting .gitignore and max depth.
 * @param {string} dirPath - The current directory path being scanned.
 * @param {string} baseDir - The root base directory for relative path calculation.
 * @param {object} ig - An 'ignore' instance preloaded with rules.
 * @param {number} [maxDepth=2] - The maximum depth to scan.
 * @param {number} [currentDepth=0] - The current recursion depth.
 * @param {string} [indent=''] - The indentation string for formatting.
 * @returns {Promise<string[]>} A promise resolving to an array of strings representing the structure.
 */
async function getDirectoryStructure(dirPath, baseDir, ig, maxDepth = 2, currentDepth = 0, indent = '') {
    if (currentDepth > maxDepth) {
        // Indicate truncation only if there might be more content
        // Check if the directory actually has non-ignored children before adding [...]
        try {
            const entries = await fs.readdir(dirPath);
             const hasVisibleChildren = entries.some(entryName => {
                 const entryPath = path.join(dirPath, entryName);
                 const relativePath = path.relative(baseDir, entryPath);
                 const posixRelativePath = relativePath.split(path.sep).join(path.posix.sep);
                 return !ig.ignores(posixRelativePath) && !ig.ignores(posixRelativePath + '/');
             });
             if (hasVisibleChildren) {
                 return [`${indent}[...]`]; // Use simple [...] indicator
             } else {
                 return []; // No visible children, return empty
             }
        } catch {
            return []; // Error reading directory, assume empty for structure
        }
    }

    let structure = [];
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        // Sort entries: directories first, then alphabetically
         const sortedEntries = entries.sort((a, b) => {
            const aIsDir = a.isDirectory();
            const bIsDir = b.isDirectory();
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.name.localeCompare(b.name);
        });


        for (const entry of sortedEntries) {
            const entryPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(baseDir, entryPath);
            // Use POSIX separators for consistency in display and ignore matching
            const posixRelativePath = relativePath.split(path.sep).join(path.posix.sep);

            // Determine path to check against ignore rules (append '/' for dirs)
            const pathToFilter = entry.isDirectory() ? `${posixRelativePath}/` : posixRelativePath;

            if (ig.ignores(pathToFilter)) {
                continue; // Skip ignored entries
            }

            // Use the POSIX path for display
            const displayPath = posixRelativePath;

            if (entry.isDirectory()) {
                structure.push(`${indent}📁 ${displayPath}/`);
                // Recurse only if not exceeding max depth
                 // No need to check currentDepth < maxDepth again, handled at function start
                const subStructure = await getDirectoryStructure(
                    entryPath,
                    baseDir,
                    ig,
                    maxDepth,
                    currentDepth + 1, // Increment depth
                    indent + '  ' // Increase indent
                );
                 // Add substructure only if it's not empty or just the truncation indicator
                 if (subStructure.length > 0) {
                      structure = structure.concat(subStructure);
                 }
                 // If substructure is empty, we don't add anything further for this dir

            } else if (entry.isFile()) {
                 structure.push(`${indent}📄 ${displayPath}`);
            }
            // Ignore other entry types (symlinks, etc.) for simplicity
        }
    } catch (error) {
         // Log error but don't crash the structure generation
         console.error(`Error reading directory ${dirPath}: ${error.message}`);
         const relativeDirPath = path.relative(baseDir, dirPath) || '.';
         structure.push(`${indent}[Error reading content of ${relativeDirPath.split(path.sep).join(path.posix.sep)}]`);
    }

    // Filter out empty lines just in case, and remove trailing truncation markers if they are the only thing left
     return structure.filter(line => line.trim() !== '');
     // Don't filter [...], it indicates truncation. Filtering was done inside the depth check.
}


module.exports = {
    emitLog,
    emitContextLog, // Export the new context logger
    emitContextLogEntry,
    emitFullContextUpdate,
    requestUserConfirmation,
    isPathSafe,
    checkSafety,
    getDirectoryStructure,
    generateDiff,
};