// src/server/fileSystem.js
const path = require('node:path');
const fs = require('node:fs/promises'); // Use promise-based fs
const { glob } = require("glob");
const ignore = require("ignore"); // For .gitignore handling
const { emitLog, requestUserConfirmation, checkSafety, generateDiff } = require('./utils');

// --- loadGitignore (unchanged) ---
/**
 * Loads .gitignore rules from the base directory.
 */
async function loadGitignore(baseDir, socket) {
    const gitignorePath = path.join(baseDir, '.gitignore');
    const ig = ignore();
    ig.add('.git/'); // Add default ignores

    try {
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        if (gitignoreContent) {
            ig.add(gitignoreContent);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            emitLog(socket, `⚠️ Error reading .gitignore file: ${error.message}`, 'warn');
        }
    }
    return ig;
}


// ==================================================================
// Internal Core File System Operations (No confirmation/undo logging)
// ==================================================================
// --- _writeFile, _deleteFile, _moveItem, _createDir, _deleteDirRecursive (unchanged) ---
async function _writeFile(fullPath, content, socket, filePathLog) {
    try {
        emitLog(socket, `   fs: Writing file: ${filePathLog}`, 'debug');
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, content, "utf-8");
        return { success: true };
    } catch (error) {
         emitLog(socket, `   fs: ❌ Error writing file ${filePathLog}: ${error.message}`, 'error');
        return { error: `Failed to write file '${filePathLog}': ${error.message}` };
    }
}

async function _deleteFile(fullPath, socket, filePathLog) {
    try {
        emitLog(socket, `   fs: Deleting file: ${filePathLog}`, 'debug');
        // Ensure it's actually a file before deleting
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) {
             const msg = `Path '${filePathLog}' is not a file. Cannot delete.`;
             emitLog(socket, `   fs: ⚠️ ${msg}`, 'warn');
             return { error: msg };
        }
        await fs.unlink(fullPath);
        return { success: true };
    } catch (error) {
        if (error.code === 'ENOENT') {
            emitLog(socket, `   fs: ⚠️ File not found for deletion: '${filePathLog}'`, 'warn');
            return { error: `File not found: '${filePathLog}'` }; // Return specific error
        }
         emitLog(socket, `   fs: ❌ Error deleting file ${filePathLog}: ${error.message}`, 'error');
        return { error: `Failed to delete file '${filePathLog}': ${error.message}` };
    }
}

async function _moveItem(fullSourcePath, fullDestPath, socket, sourcePathLog, destPathLog) {
     try {
        emitLog(socket, `   fs: Moving item from: ${sourcePathLog} To: ${destPathLog}`, 'debug');
        await fs.mkdir(path.dirname(fullDestPath), { recursive: true });
        await fs.rename(fullSourcePath, fullDestPath);
        return { success: true };
    } catch (error) {
        const errorMsgBase = `Failed to move item from '${sourcePathLog}' to '${destPathLog}':`;
        if (error.code === 'ENOENT') {
            // Check if source or destination parent doesn't exist
            try {
               await fs.access(fullSourcePath);
               const msg = `${errorMsgBase} Destination path issue or file system error.`;
               emitLog(socket, `   fs: ❌ ${msg} (Code: ${error.code})`, 'error');
                return { error: `${msg} Details: ${error.message}` };
            } catch (accessError) {
                 const msg = `${errorMsgBase} Source path not found.`;
                 emitLog(socket, `   fs: ❌ ${msg}`, 'error');
                 return { error: msg };
            }
       } else if (error.code === 'EPERM' || error.code === 'EBUSY') {
            const msg = `${errorMsgBase} Permission denied or resource busy.`;
            emitLog(socket, `   fs: ❌ ${msg} (Code: ${error.code})`, 'error');
            return { error: msg };
        } else if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
             const msg = `${errorMsgBase} Destination path already exists and is not empty (if directory) or cannot be overwritten.`;
             emitLog(socket, `   fs: ❌ ${msg} (Code: ${error.code})`, 'error');
             return { error: msg };
        }
       const msg = `${errorMsgBase} ${error.message} (Code: ${error.code})`;
       emitLog(socket, `   fs: ❌ Error moving item: ${msg}`, 'error');
       return { error: msg };
    }
}

async function _createDir(fullPath, socket, dirPathLog) {
    try {
        emitLog(socket, `   fs: Creating directory (recursive): ${dirPathLog}`, 'debug');
        await fs.mkdir(fullPath, { recursive: true });
        return { success: true };
    } catch (error) {
         emitLog(socket, `   fs: ❌ Error creating directory ${dirPathLog}: ${error.message}`, 'error');
        return { error: `Failed to create directory '${dirPathLog}': ${error.message}` };
    }
}

async function _deleteDirRecursive(fullPath, socket, dirPathLog) {
    try {
        emitLog(socket, `   fs: Deleting directory (recursive): ${dirPathLog}`, 'debug');
        // Ensure it's a directory before deleting
        const stats = await fs.stat(fullPath);
        if (!stats.isDirectory()) {
             const msg = `Path '${dirPathLog}' is not a directory. Cannot delete recursively.`;
             emitLog(socket, `   fs: ⚠️ ${msg}`, 'warn');
             return { error: msg };
        }
        await fs.rm(fullPath, { recursive: true, force: true });
        return { success: true };
    } catch (error) {
        if (error.code === 'ENOENT') {
            emitLog(socket, `   fs: ⚠️ Directory not found for deletion: '${dirPathLog}'`, 'warn');
             return { error: `Directory not found: '${dirPathLog}'` }; // Return specific error
        } else if (error.code === 'EPERM' || error.code === 'EBUSY') {
             const msg = `Failed to delete directory '${dirPathLog}': Permission denied or resource busy.`;
             emitLog(socket, `   fs: ❌ ${msg} (Code: ${error.code})`, 'error');
             return { error: msg };
        }
         emitLog(socket, `   fs: ❌ Error deleting directory ${dirPathLog}: ${error.message}`, 'error');
        return { error: `Failed to delete directory '${dirPathLog}': ${error.message}` };
    }
}

// ==================================================================
// Exported Handlers (Confirmation, Undo Logging, Calling Internal Ops)
// ==================================================================

function createFileSystemHandlers(context) {
    // *** MODIFIED: Added questionResolverRef ***
    const { socket, BASE_DIR, confirmAllRef, feedbackResolverRef, questionResolverRef } = context;

    // --- readFileContent (unchanged) ---
    async function readFileContent(args) {
        const { filePath } = args;
        if (!filePath) return { error: "Missing required argument: filePath" };
        const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullPath = path.join(BASE_DIR, filePath);
        try {
            emitLog(socket, `📄 Reading file: ${filePath}`, 'info');
            const content = await fs.readFile(fullPath, "utf-8");
            emitLog(socket, `   ✅ Read success: ${filePath}`, 'info');
            return { content };
        } catch (error) {
            if (error.code === 'ENOENT') {
                 emitLog(socket, `   ⚠️ File not found: ${filePath}`, 'warn');
                 return { error: `File not found: '${filePath}'` };
            }
             emitLog(socket, `❌ Error reading file ${filePath}: ${error.message}`, 'error');
            return { error: `Failed to read file '${filePath}': ${error.message}` };
        }
    }

    // --- writeFileContent (unchanged) ---
    async function writeFileContent(args) {
        const { filePath, content } = args;
        if (!filePath || content === undefined) return { error: "Missing required arguments: filePath and/or content" };
        const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullPath = path.join(BASE_DIR, filePath);

        let oldContent = null;
        let fileExisted = true;
        // Read existing content for diff and undo
        try {
            oldContent = await fs.readFile(fullPath, 'utf-8');
            emitLog(socket, `   ℹ️ Read existing content of '${filePath}' for diff/undo.`, 'info');
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                fileExisted = false;
                oldContent = null;
                emitLog(socket, `   ℹ️ File '${filePath}' does not exist, will create new file.`, 'info');
            } else {
                emitLog(socket, `⚠️ Error reading existing file content for diff/undo (${filePath}): ${readError.message}. Diff/Undo might be incomplete.`, 'warn');
            }
        }

        // Confirmation Logic
        if (!confirmAllRef.value) {
            let diffString = '(Diff generation failed)';
             try { diffString = generateDiff(oldContent ?? '', content); } catch (diffError) { emitLog(socket, `⚠️ Error generating diff for ${filePath}: ${diffError.message}`, 'warn');}
            const userDecision = await requestUserConfirmation(socket, `Write/overwrite file: '${filePath}'?`, (resolve) => { feedbackResolverRef.value = resolve; }, diffString);
            if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                 const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                 emitLog(socket, `   🚫 Operation cancelled by user/system: writeFileContent(${filePath}) - Reason: ${reason}`, 'warn');
                 // FIX: Nullify resolver value only if the ref object itself exists
                 if (feedbackResolverRef) feedbackResolverRef.value = null;
                 return { error: `User or system ${reason} writing to file '${filePath}'.` };
             }
             if (userDecision === 'yes/all') { confirmAllRef.value = true; emitLog(socket, `   👍 Confirmation set to 'Yes to All' for this task.`, 'info'); }
             // FIX: Nullify resolver value only if the ref object itself exists
             if (feedbackResolverRef) {
                 feedbackResolverRef.value = null;
             }
        }

        // Execute internal write
        emitLog(socket, `💾 Executing write for: ${filePath}`, 'info');
        const writeResult = await _writeFile(fullPath, content, socket, filePath);

        if (writeResult.success) {
            const successMsg = `File written successfully to ${filePath}`;
            emitLog(socket, `   ✅ ${successMsg}`, 'success');
            return { success: true, message: successMsg };
        } else {
            // Return error from internal write
             emitLog(socket, `   ❌ Failed write for ${filePath}.`, 'error');
            return writeResult; // Contains the error message
        }
    }

    // --- deleteFile (unchanged) ---
    async function deleteFile(args) {
        const { filePath } = args;
        if (!filePath) return { error: "Missing required argument: filePath" };
        const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullPath = path.join(BASE_DIR, filePath);

        let oldContent = null;
        // Read file content *before* confirmation/deletion for undo
        try {
            oldContent = await fs.readFile(fullPath, 'utf-8');
            emitLog(socket, `   ℹ️ Read content of '${filePath}' before deletion for undo.`, 'info');
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                 emitLog(socket, `   ⚠️ File not found for deletion: '${filePath}'. Cannot proceed.`, 'warn');
                 return { error: `File not found: '${filePath}'` };
            } else {
                emitLog(socket, `   ⚠️ Error reading file content before deletion (${filePath}): ${readError.message}. Cannot guarantee undo.`, 'warn');
                oldContent = null; // Mark as null, deletion might proceed, but undo won't restore content
            }
        }

        // Confirmation Logic
        if (!confirmAllRef.value) {
             const userDecision = await requestUserConfirmation(socket, `Delete file: '${filePath}'? This cannot be undone (except via task undo).`, (resolve) => { feedbackResolverRef.value = resolve; });
            if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                 const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                 emitLog(socket, `   🚫 Operation cancelled by user/system: deleteFile(${filePath}) - Reason: ${reason}`, 'warn');
                 if (feedbackResolverRef) feedbackResolverRef.value = null; // Check ref before nulling
                 return { error: `User or system ${reason} deleting file '${filePath}'.` };
             }
             if (userDecision === 'yes/all') { confirmAllRef.value = true; emitLog(socket, `   👍 Confirmation set to 'Yes to All' for this task.`, 'info'); }
             if (feedbackResolverRef) feedbackResolverRef.value = null; // Check ref before nulling
        }

        // Execute internal delete
        emitLog(socket, ` rm Executing delete for: ${filePath}`, 'info');
        const deleteResult = await _deleteFile(fullPath, socket, filePath);

        if (deleteResult.success) {
            const successMsg = `File deleted successfully: '${filePath}'`;
            emitLog(socket, `   ✅ ${successMsg}`, 'success');
            return { success: true, message: successMsg };
        } else {
            // Return error from internal delete
             emitLog(socket, `   ❌ Failed delete for ${filePath}.`, 'error');
            return deleteResult; // Contains the error message
        }
    }

    // --- moveItem (unchanged) ---
    async function moveItem(args) {
        const { sourcePath, destinationPath } = args;
        if (!sourcePath || !destinationPath) return { error: "Missing required arguments: sourcePath and/or destinationPath" };
        const safetyCheck = checkSafety([sourcePath, destinationPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullSourcePath = path.join(BASE_DIR, sourcePath);
        const fullDestPath = path.join(BASE_DIR, destinationPath);

        // Check source exists before confirmation
        try { await fs.access(fullSourcePath); } catch (accessError) {
            emitLog(socket, `   ⚠️ Source path not found for move: '${sourcePath}'. Cannot proceed.`, 'warn');
            return { error: `Source path not found: '${sourcePath}'` };
        }

        // Confirmation Logic
         if (!confirmAllRef.value) {
             const userDecision = await requestUserConfirmation(socket, `Move/rename '${sourcePath}' to '${destinationPath}'?`, (resolve) => { feedbackResolverRef.value = resolve; });
             if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                  const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                  emitLog(socket, `   🚫 Operation cancelled by user/system: moveItem(${sourcePath}, ${destinationPath}) - Reason: ${reason}`, 'warn');
                  if (feedbackResolverRef) feedbackResolverRef.value = null; // Check ref before nulling
                  return { error: `User or system ${reason} moving item '${sourcePath}'.` };
              }
              if (userDecision === 'yes/all') { confirmAllRef.value = true; emitLog(socket, `   👍 Confirmation set to 'Yes to All' for this task.`, 'info'); }
              if (feedbackResolverRef) feedbackResolverRef.value = null; // Check ref before nulling
         }

        // Execute internal move
        emitLog(socket, ` mv Executing move from: ${sourcePath} To: ${destinationPath}`, 'info');
        const moveResult = await _moveItem(fullSourcePath, fullDestPath, socket, sourcePath, destinationPath);

        if (moveResult.success) {
            emitLog(socket, `   💾 Added 'moveItem' to undo log for ${sourcePath} -> ${destinationPath}.`, 'debug');
            const successMsg = `Item moved/renamed successfully from '${sourcePath}' to '${destinationPath}'`;
            emitLog(socket, `   ✅ ${successMsg}`, 'success');
            return { success: true, message: successMsg };
        } else {
            // Return error from internal move
             emitLog(socket, `   ❌ Failed move for ${sourcePath} -> ${destinationPath}.`, 'error');
            return moveResult; // Contains the error message
        }
    }

     // --- createDirectory (unchanged) ---
     async function createDirectory(args) {
        const { directoryPath } = args;
        if (!directoryPath) return { error: "Missing required argument: directoryPath" };
        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullPath = path.join(BASE_DIR, directoryPath);

        let directoryExisted = true;
        try {
            await fs.access(fullPath);
            emitLog(socket, `   ℹ️ Directory already exists: ${directoryPath}. No action needed.`, 'info');
        } catch (accessError) {
            directoryExisted = false; // Doesn't exist, needs creation
            emitLog(socket, `   ℹ️ Directory does not exist: ${directoryPath}. Will create.`, 'info');
        }

        // No confirmation needed for directory creation by default

        if (directoryExisted) {
             // If it already existed, report success without doing anything or logging undo
             const successMsg = `Directory already exists at '${directoryPath}'`;
             emitLog(socket, `   ✅ ${successMsg}`, 'success');
             return { success: true, message: successMsg };
        }

        // Execute internal create directory
        emitLog(socket, ` mkdir Executing create directory: ${directoryPath}`, 'info');
        const createResult = await _createDir(fullPath, socket, directoryPath);

        if (createResult.success) {
            const successMsg = `Directory created successfully at '${directoryPath}'`;
            emitLog(socket, `   ✅ ${successMsg}`, 'success');
            return { success: true, message: successMsg };
        } else {
            // Return error from internal create
             emitLog(socket, `   ❌ Failed create directory for ${directoryPath}.`, 'error');
            return createResult; // Contains the error message
        }
    }

    // --- deleteDirectory (unchanged) ---
    async function deleteDirectory(args) {
        const { directoryPath } = args;
        if (!directoryPath) return { error: "Missing required argument: directoryPath" };
        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullPath = path.join(BASE_DIR, directoryPath);

        // Check if directory exists before confirmation
        try {
            const stats = await fs.stat(fullPath);
            if (!stats.isDirectory()) {
                 const msg = `Path '${directoryPath}' is not a directory. Cannot delete.`;
                 emitLog(socket, `   ⚠️ ${msg}`, 'warn'); return { error: msg };
            }
        } catch (statError) {
             if (statError.code === 'ENOENT') {
                 emitLog(socket, `   ⚠️ Directory not found for deletion: '${directoryPath}'`, 'warn');
                 return { error: `Directory not found: '${directoryPath}'` };
             }
             emitLog(socket, `❌ Error accessing directory ${directoryPath}: ${statError.message}`, 'error');
             return { error: `Failed to access directory '${directoryPath}': ${statError.message}` };
        }

        // Confirmation Logic
        if (!confirmAllRef.value) {
             const userDecision = await requestUserConfirmation(socket, `Delete directory: '${directoryPath}' and ALL ITS CONTENTS? This cannot be undone (except via task undo).`, (resolve) => { feedbackResolverRef.value = resolve; });
            if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                 const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                 emitLog(socket, `   🚫 Operation cancelled by user/system: deleteDirectory(${directoryPath}) - Reason: ${reason}`, 'warn');
                 if (feedbackResolverRef) feedbackResolverRef.value = null; // Check ref before nulling
                 return { error: `User or system ${reason} deleting directory '${directoryPath}'.` };
             }
             if (userDecision === 'yes/all') { confirmAllRef.value = true; emitLog(socket, `   👍 Confirmation set to 'Yes to All' for this task.`, 'info'); }
             if (feedbackResolverRef) feedbackResolverRef.value = null; // Check ref before nulling
        }

        // Execute internal delete directory (recursive)
        emitLog(socket, ` rmdir Executing delete directory (recursive): ${directoryPath}`, 'info');
        const deleteResult = await _deleteDirRecursive(fullPath, socket, directoryPath);

        if (deleteResult.success) {
            // !!! UNDO LOGGING FOR DELETED DIRECTORIES IS NOT IMPLEMENTED !!!
            // This is complex as it requires storing the entire deleted structure/content.
             emitLog(socket, `   ⚠️ Undo logging for 'deleteDirectory' is not implemented for ${directoryPath}.`, 'warn');
            const successMsg = `Directory deleted successfully: '${directoryPath}'`;
            emitLog(socket, `   ✅ ${successMsg}`, 'success');
            return { success: true, message: successMsg };
        } else {
             emitLog(socket, `   ❌ Failed delete directory for ${directoryPath}.`, 'error');
            return deleteResult; // Contains the error message
        }
    }

    // --- listFiles (unchanged) ---
    async function listFiles(args) {
        const directoryPath = args?.directoryPath || ".";
        const relativeDirectoryPath = directoryPath === '.' ? '.' : directoryPath;
        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };
        const fullPath = path.join(BASE_DIR, directoryPath);
        try {
            emitLog(socket, ` Ls Listing files in: ${relativeDirectoryPath} (respecting .gitignore)`, 'info');
            const ig = await loadGitignore(BASE_DIR, socket);
            const entries = await fs.readdir(fullPath, { withFileTypes: true });
            const filteredEntries = entries.filter(entry => {
                const entryRelativePath = path.relative(BASE_DIR, path.join(fullPath, entry.name));
                const posixPath = entryRelativePath.split(path.sep).join(path.posix.sep);
                const pathToFilter = entry.isDirectory() ? `${posixPath}/` : posixPath;
                return !ig.ignores(pathToFilter);
            });
            const files = filteredEntries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
                           .sort((a, b) => { if (a.isDirectory && !b.isDirectory) return -1; if (!a.isDirectory && b.isDirectory) return 1; return a.name.localeCompare(b.name); });
            emitLog(socket, `   ✅ Found ${files.length} entries (after filtering) in ${relativeDirectoryPath}`, 'info');
            return { files };
        } catch (error) {
            if (error.code === 'ENOENT') { emitLog(socket, `   ⚠️ Directory not found: ${relativeDirectoryPath}`, 'warn'); return { error: `Directory not found: '${relativeDirectoryPath}'` }; }
             emitLog(socket, `❌ Error listing files in ${relativeDirectoryPath}: ${error.message}`, 'error'); return { error: `Failed to list files in '${relativeDirectoryPath}': ${error.message}` };
        }
    }

    // --- searchFiles (unchanged) ---
    async function searchFiles(args) {
        const { pattern } = args;
        if (!pattern) return { error: "Missing required argument: pattern" };
        if (!BASE_DIR) return { error: "Base directory not set." };
        if (pattern.includes("..")) { const msg = `Access denied: Search pattern contains invalid path traversal ('..'). Pattern: ${pattern}`; emitLog(socket, `⚠️ Security Warning: ${msg}`, 'warn'); return { error: msg }; }
        try {
            emitLog(socket, `🔎 Searching files with pattern: ${pattern} in ${BASE_DIR} (respecting .gitignore)`, 'info');
            const results = await glob(pattern, { cwd: BASE_DIR, nodir: true, dot: true, absolute: false });
            const ig = await loadGitignore(BASE_DIR, socket);
            const filteredResults = results.filter(relativePath => { const posixPath = relativePath.split(path.sep).join(path.posix.sep); return !ig.ignores(posixPath); }).sort();
            emitLog(socket, `   ✅ Found ${filteredResults.length} files matching '${pattern}' (after filtering).`, 'info');
            return { files: filteredResults };
        } catch (error) { emitLog(socket, `❌ Error searching files with pattern ${pattern}: ${error.message}`, 'error'); return { error: `Failed to search files: ${error.message}` }; }
    }

    // --- *** NEW: searchFilesByRegex *** ---
    async function searchFilesByRegex(args) {
        const { regexString, directoryPath } = args;
        const searchDir = directoryPath || ".";

        if (!regexString) return { error: "Missing required argument: regexString" };

        const safetyCheck = checkSafety([searchDir], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullBasePath = path.resolve(BASE_DIR); // Ensure BASE_DIR is absolute for relative path calculations
        const fullSearchPath = path.join(fullBasePath, searchDir);

        let compiledRegex;
        try {
            // Attempt to parse regex string like /pattern/flags
            let pattern = regexString;
            let flags = 'g'; // Default to global flag
            const regexParts = regexString.match(/^\/(.+)\/([gimyus]*)$/);
            if (regexParts) {
                pattern = regexParts[1];
                flags = regexParts[2] || '';
            }
             // Ensure the global flag is present
             if (!flags.includes('g')) {
                 flags += 'g';
             }
             compiledRegex = new RegExp(pattern, flags);
            emitLog(socket, `   ℹ️ Compiled regex: /${compiledRegex.source}/${compiledRegex.flags}`, 'debug');
        } catch (e) {
             emitLog(socket, `❌ Invalid regex provided: ${regexString} - ${e.message}`, 'error');
            return { error: `Invalid regular expression: ${e.message}` };
        }

        emitLog(socket, `🔍 Searching files via regex /${compiledRegex.source}/${compiledRegex.flags} in '${searchDir}' (respecting .gitignore)`, 'info');
        const results = [];
        const ig = await loadGitignore(fullBasePath, socket); // Load gitignore relative to BASE_DIR

        async function walkDir(currentFullPath) {
            try {
                const entries = await fs.readdir(currentFullPath, { withFileTypes: true });
                for (const entry of entries) {
                    const entryFullPath = path.join(currentFullPath, entry.name);
                    // Get path relative to BASE_DIR for gitignore check
                    const relativePath = path.relative(fullBasePath, entryFullPath);
                    const posixPath = relativePath.split(path.sep).join(path.posix.sep); // Use POSIX separators for ignore check
                    const ignoreCheckPath = entry.isDirectory() ? `${posixPath}/` : posixPath;

                    // Check if the path is ignored
                    if (ig.ignores(ignoreCheckPath)) {
                        emitLog(socket, `   🙈 Ignoring path: ${relativePath}`, 'debug');
                        continue;
                    }

                    if (entry.isDirectory()) {
                        // Recursively search subdirectories
                        await walkDir(entryFullPath);
                    } else if (entry.isFile()) {
                        // Process file
                         let content;
                         try {
                             content = await fs.readFile(entryFullPath, 'utf-8');
                         } catch (readError) {
                             emitLog(socket, `   ⚠️ Error reading file '${relativePath}': ${readError.message}. Skipping file.`, 'warn');
                             continue; // Skip this file
                         }

                        try {
                             // Reset regex lastIndex if it's stateful (global flag) before matching
                             compiledRegex.lastIndex = 0;
                             const matches = content.match(compiledRegex);
                            if (matches) {
                                const occurrences = matches.length;
                                emitLog(socket, `   🎯 Found ${occurrences} match(es) in: ${relativePath}`, 'debug');
                                results.push({
                                    filePath: relativePath, // Return relative path from BASE_DIR
                                    content: content,
                                    occurrences: occurrences,
                                });
                            }
                        } catch (matchError) {
                             // Should be rare if regex compilation succeeded, but catch just in case
                             emitLog(socket, `   ⚠️ Error matching regex in file '${relativePath}': ${matchError.message}. Skipping file.`, 'warn');
                             continue;
                        }
                    }
                }
            } catch (err) {
                 // Log error reading directory and stop searching down this path
                 const relativeCurrentPath = path.relative(fullBasePath, currentFullPath);
                 // Ignore ENOENT errors for the top-level search path if it doesn't exist
                 if (err.code === 'ENOENT' && currentFullPath === fullSearchPath) {
                      emitLog(socket, `   ⚠️ Search directory not found: ${searchDir}`, 'warn');
                 } else if (err.code !== 'ENOENT') { // Log other errors
                    emitLog(socket, `❌ Error reading directory '${relativeCurrentPath}': ${err.message}`, 'error');
                 }
            }
        }

        try {
             // Ensure the starting directory exists before walking
             try {
                 await fs.access(fullSearchPath);
                 await walkDir(fullSearchPath);
             } catch (accessError) {
                 if (accessError.code === 'ENOENT') {
                     emitLog(socket, `   ⚠️ Search directory not found: ${searchDir}`, 'warn');
                     // Return empty results if start dir doesn't exist
                 } else {
                     throw accessError; // Re-throw other access errors
                 }
             }
            emitLog(socket, `   ✅ Regex search completed. Found ${results.length} matching file(s).`, 'success');
            return { results };
        } catch (error) {
             emitLog(socket, `❌ An unexpected error occurred during regex search: ${error.message}`, 'error');
             return { error: `Regex search failed: ${error.message}` };
        }
    }
    // --- *** END NEW *** ---

    // --- askUserQuestion (unchanged) ---
    async function askUserQuestion(args) {
        const { question } = args;
        if (!question) return { error: "Missing required argument: question" };

        // Check if another question or confirmation is already pending
        if (feedbackResolverRef?.value || questionResolverRef?.value) {
            const pendingType = feedbackResolverRef?.value ? 'confirmation' : 'question';
            const errorMsg = `Cannot ask question: Another user interaction (${pendingType}) is already pending.`;
            emitLog(socket, `⚠️ ${errorMsg}`, 'warn');
            return { error: errorMsg };
        }

        try {
            emitLog(socket, `❓ Asking user question: \"${question}\"`, 'info');
            socket.emit('ask-question-request', { question });

            const userAnswer = await new Promise((resolve) => {
                questionResolverRef.value = resolve;
            });

            // Check if the task was cancelled while waiting
            if (userAnswer === 'disconnect' || userAnswer === 'error' || userAnswer === 'task-end') {
                const reason = `cancelled (${userAnswer})`;
                emitLog(socket, `   🚫 Question cancelled by system: askUserQuestion(\"${question}\") - Reason: ${reason}`, 'warn');
                // Ensure resolver is cleared by the handler that resolved it
                return { error: `User or system ${reason} while asking question.` };
            }

            // We expect an object like { type: 'button'/'text', value: '...' }
            if (typeof userAnswer === 'object' && userAnswer !== null && userAnswer.value !== undefined) {
                emitLog(socket, `   🗣️ User answered via ${userAnswer.type}: \"${userAnswer.value}\"`, 'info');
                return { answer: userAnswer }; // Return the structured answer
            } else {
                 // This case might occur if cancellation logic resolves differently
                 emitLog(socket, `   ⚠️ Received unexpected answer format for question: ${JSON.stringify(userAnswer)}. Returning as error.`, 'warn');
                 return { error: `Received unexpected answer format: ${JSON.stringify(userAnswer)}` };
            }

        } catch (error) {
            // This catch block might be less likely to trigger due to promise structure
             emitLog(socket, `❌ Error during askUserQuestion process: ${error.message}`, 'error');
             return { error: `Internal error while asking question: ${error.message}` };
        } finally {
             // Ensure the resolver is cleared *if it wasn't cleared by the event handler*
             // This acts as a safety net but should ideally be cleared by the handler
             if (questionResolverRef && questionResolverRef.value) {
                  emitLog(socket, `   🧹 Cleaning up question resolver in finally block (might indicate prior issue).`, 'warn');
                  questionResolverRef.value = null;
             }
        }
    }

    // *** NEW FUNCTION: showInformationTextToUser ***
 	async function showInformationTextToUser(args) {
 		const { messageToDisplay } = args;
 		if (!messageToDisplay) {
 			return { error: "Missing required argument: messageToDisplay" };
 		}
 		// Use 'gemini-resp' type for now, as it's text output from Gemini.
 		// Could potentially add a new 'gemini-info' type if distinct styling is needed.
 		emitLog(socket, `ℹ️ Gemini says: ${messageToDisplay}`, 'gemini-resp');
 		// Return success to indicate the message was handled and Gemini should continue.
 		return { success: true, message: "Information displayed to user." };
 	}


    // *** MODIFIED: Added showInformationTextToUser to returned object ***
    // Return all the user-facing handlers
    return {
        readFileContent,
        writeFileContent,
        listFiles,
        searchFiles,
        searchFilesByRegex, // Add the new function handler
        createDirectory,
        deleteFile,
        moveItem,
        deleteDirectory,
        askUserQuestion,
        showInformationTextToUser // Add the new function handler
    };
}

// ==================================================================
// Undo Logic (unchanged)
// ==================================================================

/**
 * Performs the inverse operation described by an undo log entry.
 * Uses internal functions to bypass confirmation and undo logging.
 * @param {object} operation - The undo log entry.
 * @param {object} context - Contains BASE_DIR and socket.
 */
async function performUndoOperation(operation, context) {
    const { BASE_DIR, socket } = context;
    emitLog(socket, `⏪ Undoing operation: ${operation.type}`, 'info');

    let result = { error: "Unknown undo operation type" }; // Default error

    try {
        switch (operation.type) {
            case 'createFile': // Undo: Delete the created file
                const delPathCreate = path.join(BASE_DIR, operation.filePath);
                const safetyCheckDelCreate = checkSafety([operation.filePath], BASE_DIR, socket);
                if (!safetyCheckDelCreate.safe) return { error: safetyCheckDelCreate.error };
                 emitLog(socket, `   Undoing createFile: Deleting ${operation.filePath}`, 'info');
                result = await _deleteFile(delPathCreate, socket, operation.filePath);
                break;

            case 'updateFile': // Undo: Write the old content back
                const updatePath = path.join(BASE_DIR, operation.filePath);
                const safetyCheckUpdate = checkSafety([operation.filePath], BASE_DIR, socket);
                if (!safetyCheckUpdate.safe) return { error: safetyCheckUpdate.error };
                 emitLog(socket, `   Undoing updateFile: Restoring content of ${operation.filePath}`, 'info');
                result = await _writeFile(updatePath, operation.oldContent ?? '', socket, operation.filePath); // Use empty string if oldContent was somehow null
                break;

            case 'deleteFile': // Undo: Write the old content back
                const restorePath = path.join(BASE_DIR, operation.filePath);
                 const safetyCheckRestore = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheckRestore.safe) return { error: safetyCheckRestore.error };
                 emitLog(socket, `   Undoing deleteFile: Restoring ${operation.filePath}`, 'info');
                // Note: We previously checked oldContent was not null before logging 'deleteFile'
                result = await _writeFile(restorePath, operation.oldContent, socket, operation.filePath);
                break;

            case 'createDirectory': // Undo: Delete the created directory
                const delPathDir = path.join(BASE_DIR, operation.directoryPath);
                const safetyCheckDelDir = checkSafety([operation.directoryPath], BASE_DIR, socket);
                if (!safetyCheckDelDir.safe) return { error: safetyCheckDelDir.error };
                 emitLog(socket, `   Undoing createDirectory: Deleting ${operation.directoryPath}`, 'info');
                 // Use recursive delete; assumes an empty dir was created, but safer to use rm
                 result = await _deleteDirRecursive(delPathDir, socket, operation.directoryPath);
                break;

            case 'moveItem': // Undo: Move the item back (source/dest were swapped in the log)
                const undoSourcePath = path.join(BASE_DIR, operation.sourcePath);
                const undoDestPath = path.join(BASE_DIR, operation.destinationPath);
                const safetyCheckMove = checkSafety([operation.sourcePath, operation.destinationPath], BASE_DIR, socket);
                 if (!safetyCheckMove.safe) return { error: safetyCheckMove.error };
                 emitLog(socket, `   Undoing moveItem: Moving ${operation.sourcePath} back to ${operation.destinationPath}`, 'info');
                result = await _moveItem(undoSourcePath, undoDestPath, socket, operation.sourcePath, operation.destinationPath);
                break;

            default:
                 emitLog(socket, `   ⚠️ Unknown undo operation type: ${operation.type}`, 'warn');
                result = { error: `Unknown undo operation type: ${operation.type}` };
        }
    } catch (undoError) {
        emitLog(socket, `   ❌ CRITICAL ERROR during undo operation ${operation.type}: ${undoError.message}`, 'error');
        console.error("Undo execution error:", undoError);
        result = { error: `Failed to execute undo for ${operation.type}: ${undoError.message}` };
    }

     if (result.error) {
         emitLog(socket, `   ❌ Undo failed for ${operation.type}: ${result.error}`, 'error');
     } else {
         emitLog(socket, `   ✅ Undo successful for ${operation.type}`, 'success');
     }
     return result; // Return success or error of the specific undo action
}


module.exports = {
    createFileSystemHandlers,
    performUndoOperation // Export the undo function
};
