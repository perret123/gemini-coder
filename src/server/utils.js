const path = require('node:path');
const fs = require('node:fs/promises');
const ignore = require('ignore');
const diff = require('diff');

/**
 * Emits a log message to the console and sends it over the socket.
 * @param {object|null} socketInstance - The socket.io socket instance, or null.
 * @param {string} message - The log message.
 * @param {string} [type='info'] - The log type ('info', 'error', 'warn', 'success', 'debug', 'confirm', 'gemini-req', 'gemini-resp', 'func-call', 'func-result').
 */
function emitLog(socketInstance, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const logPrefix = `[${timestamp}] [${type.toUpperCase()}]`;

    // Console logging (respect DEBUG_LOGGING for debug type)
    if (type !== 'debug' || process.env.DEBUG_LOGGING === 'true') {
        const consoleMethod = type === 'error' ? console.error : (type === 'warn' ? console.warn : console.log);
        // Handle potential multi-line messages for console
        const lines = String(message).split('\n');
        if (lines.length > 1) {
            consoleMethod(`${logPrefix} ${lines[0]}`);
            for(let i = 1; i < lines.length; i++) {
                consoleMethod(`  ${lines[i]}`); // Indent subsequent lines
            }
        } else {
             consoleMethod(`${logPrefix} ${message}`);
        }
    }

    // Socket emission
    if (socketInstance && socketInstance.connected) {
        try {
            // Send single message string over socket
            socketInstance.emit('log', { message: `[${timestamp}] ${message}`, type });
        } catch (emitError) {
             console.warn(`[${timestamp}] [WARN] Failed to emit log to socket ${socketInstance.id}: ${emitError.message}`);
        }
    } else if (socketInstance && !socketInstance.connected) {
        // Optionally log that emission failed due to disconnect?
        // console.log(`[${timestamp}] [DEBUG] Socket ${socketInstance.id} disconnected, log not sent: ${message}`);
    }
}


/**
 * Emits a context log entry over the socket for display in the context panel.
 * @param {object|null} socketInstance - The socket.io socket instance.
 * @param {string} type - A short identifier for the type of context entry (e.g., 'initial_prompt', 'file_write', 'question').
 * @param {string} text - The descriptive text for the context entry.
 */
function emitContextLog(socketInstance, type, text) {
     if (socketInstance && socketInstance.connected) {
         try {
             socketInstance.emit('context-log-entry', { type, text });
             // Also log context entries as debug messages to server console
             emitLog(socketInstance, `Context [${type}]: ${text}`, 'debug');
         } catch (emitError) {
              console.warn(`[${new Date().toLocaleTimeString('en-US', { hour12: false })}] [WARN] Failed to emit context log to socket ${socketInstance.id}: ${emitError.message}`);
         }
     } else {
          // Log context locally if socket isn't available/connected
          emitLog(null, `Context [${type}] (socket unavailable): ${text}`, 'debug');
     }
}



/**
 * Generates a diff string between old and new content.
 * @param {string} oldContent - The original content.
 * @param {string} newContent - The modified content.
 * @returns {string} A formatted diff string or '(No changes)'.
 */
function generateDiff(oldContent = '', newContent = '') {
    // Trim trailing whitespace for comparison, but use original for diff
    const trimmedOld = oldContent.trimEnd();
    const trimmedNew = newContent.trimEnd();

    if (trimmedOld === trimmedNew && oldContent.length === newContent.length) {
         return '(No changes)'; // More robust check
    }

    // Normalize line endings for diffing
    const normalizedOld = oldContent.replace(/\r\n/g, '\n');
    const normalizedNew = newContent.replace(/\r\n/g, '\n');

    const changes = diff.diffLines(normalizedOld, normalizedNew, { newlineIsToken: true });

    let addedLines = 0;
    let removedLines = 0;
    let diffString = '';
    const MAX_DIFF_DISPLAY_LINES = 200; // Limit displayed lines for performance/readability
    let linesShown = 0;
    let truncated = false;

    changes.forEach(part => {
        if (truncated) return; // Stop processing if already truncated

        const count = part.count || 0;
        // Split lines, keeping the trailing newline character attached if present
        // This helps preserve blank lines in the diff output correctly.
        const lines = part.value.split(/(\n)/).filter(Boolean); // Split by newline, keep newline, filter empty strings

        if (part.added) {
            addedLines += count;
            lines.forEach(line => {
                if (linesShown < MAX_DIFF_DISPLAY_LINES) {
                    diffString += `+${line.startsWith('\n') ? '' : ' '}${line.trimEnd()}${line.endsWith('\n') ? '\n' : ''}`; // Add +, space, trim, re-add newline if exists
                    linesShown++;
                } else { truncated = true; }
            });
        } else if (part.removed) {
            removedLines += count;
            lines.forEach(line => {
                if (linesShown < MAX_DIFF_DISPLAY_LINES) {
                     diffString += `-${line.startsWith('\n') ? '' : ' '}${line.trimEnd()}${line.endsWith('\n') ? '\n' : ''}`;
                    linesShown++;
                } else { truncated = true; }
            });
        } else {
            // Context lines
            const maxContext = 3; // Show max 3 context lines before/after change
            const contextLines = lines.map(line => ` ${line.startsWith('\n') ? '' : ' '}${line.trimEnd()}${line.endsWith('\n') ? '\n' : ''}`); // Add space prefix

             if (contextLines.length <= maxContext * 2) {
                // Show all context if it's short
                contextLines.forEach(line => {
                     if (linesShown < MAX_DIFF_DISPLAY_LINES) { diffString += line; linesShown++; } else { truncated = true; }
                 });
            } else {
                // Show beginning and end context
                 contextLines.slice(0, maxContext).forEach(line => {
                    if (linesShown < MAX_DIFF_DISPLAY_LINES) { diffString += line; linesShown++; } else { truncated = true; }
                 });
                 if (!truncated) {
                     diffString += `  ...\n`;
                     linesShown++;
                 }
                 contextLines.slice(-maxContext).forEach(line => {
                     if (linesShown < MAX_DIFF_DISPLAY_LINES) { diffString += line; linesShown++; } else { truncated = true; }
                 });
             }
        }
         if (truncated && !diffString.endsWith('...\n')) {
            diffString += '... (diff output truncated)\n';
         }
    });

    // Ensure final newline if content exists
    if (diffString && !diffString.endsWith('\n')) {
        diffString += '\n';
    }


    const summary = `(Summary: +${addedLines} added, -${removedLines} removed)`;
    return summary + (diffString ? '\n---\n' + diffString.trimEnd() : ''); // TrimEnd final result
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
    requestUserConfirmation,
    isPathSafe,
    checkSafety,
    getDirectoryStructure,
    generateDiff,
};