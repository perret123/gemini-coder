// c:\dev\gemini-coder\src\server\utils.js
import fs from "node:fs/promises";
import path from "node:path";
import { createPatch } from "diff"; // Assuming 'diff' package supports ES module import or has type definitions

export function emitLog(socketInstance, message, type = 'info', isAction = false) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const logPrefix = `[${timestamp}] [${type.toUpperCase()}]`;

    // Console logging (respect DEBUG_LOGGING)
    if (type !== 'debug' || process.env.DEBUG_LOGGING === 'true') {
        const consoleMethod = type === 'error' ? console.error : (type === 'warn' ? console.warn : console.log);
        const lines = String(message).split('\n');
        if (lines.length > 1) {
            consoleMethod(`${logPrefix} ${lines[0]}`);
            for(let i = 1; i < lines.length; i++) {
                consoleMethod(`  ${' '.repeat(logPrefix.length -1)} ${lines[i]}`); // Adjusted spacing
            }
        } else {
            consoleMethod(`${logPrefix} ${message}`);
        }
    }

    // Socket emission
    if (socketInstance && socketInstance.connected) {
        try {
            socketInstance.emit('log', { message: message, type, isAction, timestamp: timestamp });
        } catch (emitError) {
            console.warn(`[${new Date().toLocaleTimeString('en-US', { hour12: false })}] [WARN] Failed to emit log to socket ${socketInstance.id}: ${emitError.message}`);
        }
    } else if (socketInstance && !socketInstance.connected) {
        // Optionally log that the socket was disconnected if trying to emit
        // console.debug(`[${timestamp}] [DEBUG] Socket ${socketInstance.id} disconnected, log not sent: ${message.substring(0, 50)}...`);
    }
}

export function emitContextLog(socketInstance, contextData) {
    if (socketInstance && socketInstance.connected) {
        socketInstance.emit("context-update", contextData);
    }
}

export function emitContextLogEntry(socketInstance, type, text) {
    if (socketInstance && socketInstance.connected) {
        const entryText = String(text ?? '(No details provided)');
        const payload = { type: type, text: entryText };
        socketInstance.emit("context-update", payload);
    }
}

export function emitFullContextUpdate(socketInstance, changesArray) {
    if (socketInstance && socketInstance.connected) {
        if (!Array.isArray(changesArray)) {
            // Use emitLog for server-side logging of this internal error
            emitLog(socketInstance, `emitFullContextUpdate ERROR: changesArray is not an array! Data: ${JSON.stringify(changesArray)}`, 'error');
            emitContextLogEntry(socketInstance, 'error', 'Internal Server Error: Invalid context data format.');
            return;
        }
        const payload = { changes: changesArray };
        socketInstance.emit("context-update", payload);
    }
}

export function generateDiff(oldContent, newContent, filename) {
    if (oldContent === newContent) {
        return "(No changes)";
    }
    try {
        // Ensure filename is treated as a string, provide defaults for content
        const patch = createPatch(
            String(filename || 'file'),
            oldContent || "",
            newContent || "",
            undefined, // oldHeader
            undefined, // newHeader
            { context: 3 }
        );

        // Minimal diff format
        const lines = patch.split("\n");
        // Start from line 3 to skip the standard patch headers (---, +++) if present
        // Check if the default headers are present before slicing
        let startIndex = 0;
        if (lines[0]?.startsWith('---') && lines[1]?.startsWith('+++')) {
            startIndex = 2;
        }
        const relevantLines = lines.slice(startIndex)
                                  .filter(line => line.trim() !== "\\ No newline at end of file"); // Remove Git specific line

        // If only context lines remain, consider it no changes
        if (!relevantLines.some(line => line.startsWith("+") || line.startsWith("-"))) {
             // Check if there are *any* lines left besides headers - if not, also no changes.
             if (relevantLines.filter(line => !line.startsWith("@@")).length === 0) {
                return "(No changes)";
             }
        }

        // Reconstruct a minimal diff string for display
        let minimalDiff = '';
        if (startIndex === 2) { // Add back headers if they were sliced
             minimalDiff += lines[0] + '\n' + lines[1] + '\n';
        }
        minimalDiff += relevantLines.join("\n");

        return minimalDiff || "(No changes)"; // Return no changes if filtering leaves nothing

    } catch (error) {
        console.error(`Error generating diff for ${filename}:`, error);
        // Maybe emitLog here?
        return "Error generating diff.";
    }
}

export function requestUserConfirmation(socketInstance, message, setResolverCallback, diffData = null) {
    return new Promise((resolve) => {
        setResolverCallback(resolve); // Store the resolve function
        const payload = { message, diff: diffData };
        socketInstance.emit('confirmation-request', payload);
        emitLog(socketInstance, `⏳ Waiting for user confirmation: ${message}`, 'confirm');
        // Add timeout? Cleanup?
    });
}

export function isPathSafe(filePath, currentBaseDir) {
    if (!currentBaseDir || !filePath) {
        console.warn(`isPathSafe check failed: Missing baseDir ('${currentBaseDir}') or filePath ('${filePath}')`);
        return false;
    }
    try {
        const resolvedPath = path.resolve(currentBaseDir, filePath);
        // Ensure the resolved path starts with the base directory + separator OR is exactly the base dir
        return resolvedPath.startsWith(currentBaseDir + path.sep) || resolvedPath === currentBaseDir;
    } catch (error) {
        // Handle potential errors during path resolution (e.g., invalid characters)
        console.error(`Error resolving path safety for "${filePath}" against "${currentBaseDir}":`, error);
        return false;
    }
}

// Utility to check safety for multiple paths
export function checkSafety(paths, currentBaseDir, socket) {
    if (!currentBaseDir) {
        const message = "Operation cannot proceed: Base directory is not defined.";
        emitLog(socket, `🔒 SECURITY ERROR: ${message}`, 'error');
        // Use emitContextLogEntry instead of emitContextLog for single error messages
        emitContextLogEntry(socket, 'error', `Security Error: Base directory not set.`);
        return { safe: false, error: message };
    }

    const unsafePaths = paths.filter(p => !isPathSafe(p, currentBaseDir));

    if (unsafePaths.length > 0) {
        const message = `Access denied: Path(s) are outside the allowed base directory ('${path.basename(currentBaseDir)}'). Unsafe paths: ${unsafePaths.join(', ')}`;
        emitLog(socket, `🔒 SECURITY WARNING: ${message}`, 'warn');
        emitContextLogEntry(socket, 'error', `Security Error: Path outside base directory (${unsafePaths.join(', ')})`);
        return { safe: false, error: message };
    }

    return { safe: true };
}


export async function getDirectoryStructure(dirPath, baseDir, ig, maxDepth = 2, currentDepth = 0, indent = '') {
    // Prevent infinite loops for excessive depth
    if (currentDepth > maxDepth) {
        // Check if the directory has any non-ignored children before adding [...]
        try {
            const entries = await fs.readdir(dirPath);
            const hasVisibleChildren = entries.some(entryName => {
                const entryPath = path.join(dirPath, entryName);
                const relativePath = path.relative(baseDir, entryPath);
                // Convert to POSIX separators for ignore checking
                const posixRelativePath = relativePath.split(path.sep).join(path.posix.sep);
                // Check both file and potential directory paths
                return !ig.ignores(posixRelativePath) && !ig.ignores(posixRelativePath + '/');
            });
            if (hasVisibleChildren) {
                 return [`${indent}[...]`]; // Indicate truncated structure
            } else {
                 return []; // No visible children, return empty
            }
        } catch (err) {
             // If readdir fails (e.g., permissions), return empty or indicate error?
            // console.warn(`Could not check children of ${dirPath} at max depth: ${err.message}`);
            return []; // Keep it simple, return empty
        }
    }

    let structure = [];
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        // Sort entries: directories first, then files, alphabetically within each group
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
            // Convert to POSIX separators for ignore checking consistency
            const posixRelativePath = relativePath.split(path.sep).join(path.posix.sep);

            // Determine path to check against .gitignore (add trailing slash for dirs)
            const pathToFilter = entry.isDirectory() ? `${posixRelativePath}/` : posixRelativePath;

            if (ig.ignores(pathToFilter)) {
                continue; // Skip ignored files/directories
            }

            // Use POSIX path for display consistency
            const displayPath = posixRelativePath;

            if (entry.isDirectory()) {
                structure.push(`${indent}📁 ${displayPath}/`);
                const subStructure = await getDirectoryStructure(
                    entryPath,
                    baseDir,
                    ig,
                    maxDepth,
                    currentDepth + 1,
                    indent + '  ' // Use two spaces for clearer indentation
                );
                 // Only add substructure if it contains something
                 if (subStructure.length > 0) {
                    structure = structure.concat(subStructure);
                 }
            } else if (entry.isFile()) {
                structure.push(`${indent}📄 ${displayPath}`);
            }
            // Ignore other types like symlinks for simplicity unless needed
        }
    } catch (error) {
        // Log specific error but provide a generic message in the structure
        console.error(`Error reading directory ${dirPath}: ${error.message}`);
        const relativeDirPath = path.relative(baseDir, dirPath) || '.'; // Handle base dir itself
        structure.push(`${indent}[Error reading content of ${relativeDirPath.split(path.sep).join(path.posix.sep)}]`);
    }
    // Filter out empty lines which might occur if a directory read fails silently
    return structure.filter(line => line.trim() !== '');
}
