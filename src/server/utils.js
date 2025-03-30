// src/server/utils.js
const path = require('node:path');
const fs = require('node:fs/promises');
const ignore = require('ignore'); // Import the ignore library
const diff = require('diff'); // <--- Added: Import the diff library

function emitLog(socketInstance, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
    socketInstance.emit('log', { message: `[${timestamp}] ${message}`, type });
}

/**
 * Generates a diff summary using the 'diff' library.
 * @param {string} oldContent - The original file content. Defaults to empty string.
 * @param {string} newContent - The proposed new file content. Defaults to empty string.
 * @returns {string} - A formatted summary string (or message if no changes/error).
 */
function generateDiff(oldContent = '', newContent = '') { // <--- Replaced Implementation
    if (oldContent === newContent) {
        return '(No changes)';
    }

    // Normalize line endings just in case
    const normalizedOld = oldContent.replace(/\r\n/g, '\n');
    const normalizedNew = newContent.replace(/\r\n/g, '\n');

    const changes = diff.diffLines(normalizedOld, normalizedNew);

    let addedLines = 0;
    let removedLines = 0;
    let diffString = '';
    const MAX_DIFF_CONTEXT_LINES = 2000; // Limit how much diff text we show
    let linesShown = 0;

    changes.forEach(part => {
        const count = part.count || 0; // Number of lines in this part
        if (part.added) {
            addedLines += count;
            if (linesShown < MAX_DIFF_CONTEXT_LINES) {
                 const lines = part.value.split('\n').slice(0, -1); // split includes empty string at end
                 lines.forEach(line => {
                     if (linesShown < MAX_DIFF_CONTEXT_LINES) {
                         diffString += `+ ${line}\n`;
                         linesShown++;
                     }
                 });
            }
        } else if (part.removed) {
            removedLines += count;
             if (linesShown < MAX_DIFF_CONTEXT_LINES) {
                 const lines = part.value.split('\n').slice(0, -1);
                 lines.forEach(line => {
                     if (linesShown < MAX_DIFF_CONTEXT_LINES) {
                         diffString += `- ${line}\n`;
                         linesShown++;
                     }
                 });
             }
        } else {
             // Optionally add context lines for unchanged parts
             // if (linesShown < MAX_DIFF_CONTEXT_LINES) {
             //     const lines = part.value.split('\n').slice(0, -1);
             //     lines.slice(0, 3).forEach(line => { // Show few lines of context
             //          if (linesShown < MAX_DIFF_CONTEXT_LINES) {
             //              diffString += `  ${line}\n`;
             //              linesShown++;
             //          }
             //     });
             // }
        }
    });

    if (linesShown >= MAX_DIFF_CONTEXT_LINES) {
         diffString += '... (diff context truncated)\n';
    }

    const summary = `(Summary: ${addedLines} added, ${removedLines} removed)`;
    // Return summary first, then the truncated diff string
    return summary + (diffString ? '\n---\n' + diffString.trim() : '');
}


// Modified to accept diffData
function requestUserConfirmation(socketInstance, message, setResolverCallback, diffData = null) {
    return new Promise((resolve) => {
        setResolverCallback(resolve);
        // Include diffData in the payload
        const payload = { message, diff: diffData }; // Send diff string here
        socketInstance.emit('confirmation-request', payload);
        // Log only the main message, not the potentially large diff
        emitLog(socketInstance, `⏳ Waiting for user confirmation: ${message}`, 'confirm');
         // Client-side will now be responsible for displaying the diff from the payload
    });
}

function isPathSafe(filePath, currentBaseDir) {
    // ... (keep existing function)
    if (!currentBaseDir) return false;
    try {
        const resolvedPath = path.resolve(currentBaseDir, filePath);
        // Allow path equal to base dir OR within base dir
        return resolvedPath.startsWith(currentBaseDir + path.sep) || resolvedPath === currentBaseDir;
    } catch (error) {
        console.error(`Error resolving path safety for "${filePath}" against "${currentBaseDir}":`, error);
        return false;
    }
}

function checkSafety(paths, currentBaseDir, socket) {
    // ... (keep existing function)
    const unsafePaths = paths.filter(p => !isPathSafe(p, currentBaseDir));
    if (unsafePaths.length > 0) {
        const message = `Access denied: Path(s) are outside the allowed base directory (${currentBaseDir}): ${unsafePaths.join(', ')}`;
        if (socket && typeof socket.emit === 'function') {
            emitLog(socket, `⚠️ Security Warning: ${message}`, 'warn');
        } else {
            console.warn(`[Security Warning] ${message} (Socket not available for emit)`);
        }
        return { safe: false, error: message };
    }
    return { safe: true };
}


/**
 * Recursively gets the directory structure, respecting .gitignore rules.
 * @param {string} dirPath - The current directory path being scanned.
 * @param {string} baseDir - The root base directory for calculating relative paths.
 * @param {import('ignore').Ignore} ig - The ignore instance pre-loaded with .gitignore rules.
 * @param {number} [maxDepth=2] - The maximum depth to scan.
 * @param {number} [currentDepth=0] - The current recursion depth.
 * @param {string} [indent=''] - The indentation string for formatting output.
 * @returns {Promise<string[]>} - A promise resolving to an array of formatted strings representing the structure.
 */
async function getDirectoryStructure(dirPath, baseDir, ig, maxDepth = 2, currentDepth = 0, indent = '') {
    // ... (Existing function remains unchanged) ...
    if (currentDepth > maxDepth) {
        return [`${indent}[Max depth reached]`]; // Indicate max depth reached
    }

    let structure = [];
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const sortedEntries = entries.sort((a, b) => {
             // Sort directories first, then files, alphabetically
             if (a.isDirectory() && !b.isDirectory()) return -1;
             if (!a.isDirectory() && b.isDirectory()) return 1;
             return a.name.localeCompare(b.name);
        });

        for (const entry of sortedEntries) {
            const entryPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(baseDir, entryPath);
            // Use POSIX path separators for ignore matching, crucial for cross-platform compatibility
            const posixRelativePath = relativePath.split(path.sep).join(path.posix.sep);

            // Determine the path to check against ignore rules
            // Directories need a trailing slash for matching directory-specific rules
            const pathToFilter = entry.isDirectory() ? `${posixRelativePath}/` : posixRelativePath;

            // Check if the path is ignored
            if (ig.ignores(pathToFilter)) {
                 // console.log(`Ignoring: ${pathToFilter}`); // Optional debug logging
                 continue; // Skip ignored entries
            }

            const displayPath = posixRelativePath; // Use POSIX for display consistency

            if (entry.isDirectory()) {
                structure.push(`${indent}- ${displayPath}/`);
                if (currentDepth < maxDepth) {
                    const subStructure = await getDirectoryStructure(
                        entryPath,
                        baseDir,
                        ig, // Pass the ignore instance down
                        maxDepth,
                        currentDepth + 1,
                        indent + '  ' // Increase indent for subdirectories
                    );
                    structure = structure.concat(subStructure);
                } else {
                    // Add indicator if stopping due to depth at a directory level
                     structure.push(`${indent}  [...]`);
                }
            } else if (entry.isFile()) {
                structure.push(`${indent}- ${displayPath}`);
            }
        }
    } catch (error) {
        console.error(`Error reading directory ${dirPath}: ${error.message}`);
        const relativeDirPath = path.relative(baseDir, dirPath) || '.';
        structure.push(`${indent}[Error reading content of ${relativeDirPath.split(path.sep).join(path.posix.sep)}]`);
    }
    return structure;
}

// Export all functions including the new generateDiff
module.exports = {
    emitLog,
    requestUserConfirmation, // Modified
    isPathSafe,
    checkSafety,
    getDirectoryStructure,
    generateDiff, // Exported
};
