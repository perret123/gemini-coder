const path = require('node:path');
const fs = require('node:fs/promises');
const { glob } = require("glob");
const ignore = require("ignore");
const { emitLog, requestUserConfirmation, checkSafety, generateDiff, emitContextLog } = require('./utils'); // Added emitContextLog

// --- Gitignore Loading ---
async function loadGitignore(baseDir, socket) {
    const gitignorePath = path.join(baseDir || '', '.gitignore');
    const ig = ignore();
    ig.add('.git/'); // Always ignore .git
    // Consider adding other common ignores by default? e.g., node_modules?
    // ig.add('node_modules/');

    try {
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        if (gitignoreContent) {
            ig.add(gitignoreContent);
            emitLog(socket, ` fs: Loaded .gitignore rules from ${path.relative(process.cwd(), gitignorePath) || '.gitignore'}`, 'debug');
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             emitLog(socket, ` fs: No .gitignore file found at ${gitignorePath}.`, 'debug');
        } else {
            emitLog(socket, ` fs: ⚠️ Error reading .gitignore file at ${gitignorePath}: ${error.message}`, 'warn');
        }
    }
    return ig;
}


// --- Internal FS Operations (called by handlers) ---

async function _writeFile(fullPath, content, context, filePathLog, fileExisted) {
    const { socket, changesLog, BASE_DIR } = context;
    try {
        emitLog(socket, ` fs: Writing file: ${filePathLog} (${content.length} bytes)`, 'debug');
        const dir = path.dirname(fullPath);
        // Ensure parent directories exist
        if (dir !== '.' && dir !== path.resolve(BASE_DIR || '')) {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(fullPath, content, "utf-8");

        // Log the change for potential undo and context tracking
        if (changesLog) {
            const changeType = fileExisted ? 'updateFile' : 'createFile';
            const existingIndex = changesLog.findIndex(c => c.filePath === filePathLog);

            if (existingIndex !== -1) {
                // If updating an existing log entry (e.g., multiple writes to the same file)
                 // Update the type if it was previously a create, but keep original oldContent if present
                 changesLog[existingIndex].type = changeType;
                 // If oldContent was already captured, don't overwrite it. If not, capture it now (though might be intermediate state)
                 if (changesLog[existingIndex].oldContent === undefined && context.oldContent !== undefined) {
                     changesLog[existingIndex].oldContent = context.oldContent;
                     emitLog(socket, ` fs: [+] Updated existing log for ${filePathLog}, captured oldContent.`, 'debug');
                 } else {
                    emitLog(socket, ` fs: [+] Updated existing '${changesLog[existingIndex].type}' log for ${filePathLog}.`, 'debug');
                 }
            } else {
                // Add new entry
                changesLog.push({
                    type: changeType,
                    filePath: filePathLog,
                    oldContent: fileExisted ? context.oldContent : undefined // Only store old content if it existed
                });
                emitLog(socket, ` fs: [+] Logged change: ${changeType} - ${filePathLog}`, 'debug');
            }
        }
         return { success: true };
    } catch (error) {
        emitLog(socket, ` fs: ❌ Error writing file ${filePathLog}: ${error.message} (Code: ${error.code})`, 'error');
        return { error: `Failed to write file '${filePathLog}': ${error.message}` };
    }
}

async function _deleteFile(fullPath, context, filePathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Deleting file: ${filePathLog}`, 'debug');
        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) {
            const msg = `Path '${filePathLog}' is not a file. Cannot delete.`;
             emitLog(socket, ` fs: ⚠️ ${msg}`, 'warn');
             return { error: msg };
        }
        await fs.unlink(fullPath);

        // Log the change for potential undo and context tracking
        if (changesLog) {
             // Remove any prior create/update logs for this path, then add delete log
             const currentLog = context.changesLog;
             const filteredChanges = currentLog.filter(c => c.filePath !== filePathLog);
             currentLog.length = 0;
             currentLog.push(...filteredChanges);
             currentLog.push({
                 type: 'deleteFile',
                 filePath: filePathLog,
                 oldContent: context.oldContent // Include old content if captured
             });
             emitLog(socket, ` fs: [+] Logged change: deleteFile - ${filePathLog}`, 'debug');
        }

        return { success: true };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // If file is already gone, treat as success but log warning
            emitLog(socket, ` fs: ⚠️ File not found for deletion: '${filePathLog}'. Already deleted?`, 'warn');
            // Still log the deletion attempt if needed? Maybe not if it didn't exist.
            // Return success because the desired state (file doesn't exist) is achieved.
            return { success: true, message: `File not found: '${filePathLog}' (already deleted).` };
            // return { error: `File not found: '${filePathLog}'` }; // Or return error? Let's go with success.
        }
        emitLog(socket, ` fs: ❌ Error deleting file ${filePathLog}: ${error.message} (Code: ${error.code})`, 'error');
        return { error: `Failed to delete file '${filePathLog}': ${error.message}` };
    }
}

async function _moveItem(fullSourcePath, fullDestPath, context, sourcePathLog, destPathLog) {
    const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Moving item from: ${sourcePathLog} To: ${destPathLog}`, 'debug');
        // Ensure destination directory exists
        await fs.mkdir(path.dirname(fullDestPath), { recursive: true });
        await fs.rename(fullSourcePath, fullDestPath);

        if (changesLog) {
            changesLog.push({
                type: 'moveItem',
                sourcePath: sourcePathLog,
                destinationPath: destPathLog
            });
             emitLog(socket, ` fs: [+] Logged change: moveItem - ${sourcePathLog} -> ${destPathLog}`, 'debug');
        }
        return { success: true };
    } catch (error) {
        const errorMsgBase = `Failed to move item from '${sourcePathLog}' to '${destPathLog}':`;
        if (error.code === 'ENOENT') {
            // Check if source or destination issue
            try {
                await fs.access(fullSourcePath);
                // Source exists, must be destination issue
                const msg = `${errorMsgBase} Destination path issue or file system error.`;
                emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code}) Details: ${error.message}`, 'error');
                return { error: `${msg}` };
            } catch (accessError) {
                // Source doesn't exist
                 const msg = `${errorMsgBase} Source path not found.`;
                 emitLog(socket, ` fs: ❌ ${msg}`, 'error');
                 return { error: msg };
            }
        } else if (error.code === 'EPERM' || error.code === 'EBUSY') {
            const msg = `${errorMsgBase} Permission denied or resource busy.`;
            emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, 'error');
            return { error: msg };
        } else if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
             const msg = `${errorMsgBase} Destination path already exists and cannot be overwritten directly by rename.`;
             emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, 'error');
             return { error: msg };
        }
        // Default error
        const msg = `${errorMsgBase} ${error.message} (Code: ${error.code})`;
        emitLog(socket, ` fs: ❌ Error moving item: ${msg}`, 'error');
        return { error: msg };
    }
}

async function _createDir(fullPath, context, dirPathLog) {
     const { socket, changesLog } = context;
    try {
        emitLog(socket, ` fs: Creating directory (recursive): ${dirPathLog}`, 'debug');
        // Check if it already exists
         try {
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) {
                emitLog(socket, ` fs: ℹ️ Directory already exists: ${dirPathLog}. No action needed.`, 'info');
                // Don't log change if it already existed
                return { success: true, message: `Directory '${dirPathLog}' already exists.` };
            } else {
                // Path exists but is not a directory - this is an error
                const msg = `Path '${dirPathLog}' already exists but is not a directory. Cannot create directory.`;
                emitLog(socket, ` fs: ❌ ${msg}`, 'error');
                 return { error: msg };
            }
        } catch (statError) {
            // ENOENT means it doesn't exist, which is expected. Throw other errors.
            if (statError.code !== 'ENOENT') {
                throw statError;
            }
            // Path doesn't exist, proceed to create
        }

        await fs.mkdir(fullPath, { recursive: true });

        if (changesLog) {
            changesLog.push({
                type: 'createDirectory',
                directoryPath: dirPathLog
            });
             emitLog(socket, ` fs: [+] Logged change: createDirectory - ${dirPathLog}`, 'debug');
        }

        return { success: true };
    } catch (error) {
        emitLog(socket, ` fs: ❌ Error creating directory ${dirPathLog}: ${error.message} (Code: ${error.code})`, 'error');
        return { error: `Failed to create directory '${dirPathLog}': ${error.message}` };
    }
}

async function _deleteDirRecursive(fullPath, context, dirPathLog) {
     const { socket, changesLog } = context;
     try {
        emitLog(socket, ` fs: Deleting directory (recursive): ${dirPathLog}`, 'debug');
        const stats = await fs.stat(fullPath);
         if (!stats.isDirectory()) {
             const msg = `Path '${dirPathLog}' is not a directory. Cannot delete recursively.`;
             emitLog(socket, ` fs: ⚠️ ${msg}`, 'warn');
             return { error: msg };
         }

        await fs.rm(fullPath, { recursive: true, force: true }); // Use force? Be careful.

        if (changesLog) {
            // TODO: How to handle undo for recursive delete? Complex.
            // For now, just log the top-level deletion.
            changesLog.push({
                type: 'deleteDirectory',
                directoryPath: dirPathLog
            });
             emitLog(socket, ` fs: [+] Logged change: deleteDirectory - ${dirPathLog}`, 'debug');
             emitLog(socket, ` fs: ⚠️ Undo logging for 'deleteDirectory' contents is complex and likely incomplete for ${dirPathLog}.`, 'warn');
        }
        return { success: true };
    } catch (error) {
        if (error.code === 'ENOENT') {
             emitLog(socket, ` fs: ⚠️ Directory not found for deletion: '${dirPathLog}'. Already deleted?`, 'warn');
             // Return success as the desired state is achieved
             return { success: true, message: `Directory not found: '${dirPathLog}' (already deleted).` };
        } else if (error.code === 'EPERM' || error.code === 'EBUSY') {
             const msg = `Failed to delete directory '${dirPathLog}': Permission denied or resource busy.`;
             emitLog(socket, ` fs: ❌ ${msg} (Code: ${error.code})`, 'error');
             return { error: msg };
        }
         emitLog(socket, ` fs: ❌ Error deleting directory ${dirPathLog}: ${error.message} (Code: ${error.code})`, 'error');
         return { error: `Failed to delete directory '${dirPathLog}': ${error.message}` };
    }
}


// --- Function Handlers Exposed to Gemini ---

function createFileSystemHandlers(context, changesLog) {
    const { socket, BASE_DIR, confirmAllRef, feedbackResolverRef, questionResolverRef } = context;

    if (!BASE_DIR) {
        const errorMsg = "FATAL: Base directory (BASE_DIR) is not set in context. Cannot create file system handlers.";
        console.error(errorMsg);
        // Return dummy functions that always fail
        const alwaysFail = async (args) => ({ error: errorMsg });
        return {
            readFileContent: alwaysFail,
            writeFileContent: alwaysFail,
            listFiles: alwaysFail,
            searchFiles: alwaysFail,
            searchFilesByRegex: alwaysFail,
            createDirectory: alwaysFail,
            deleteFile: alwaysFail,
            moveItem: alwaysFail,
            deleteDirectory: alwaysFail,
            askUserQuestion: alwaysFail,
            showInformationTextToUser: alwaysFail,
            task_finished: alwaysFail, // Include the new function
        };
    }

    // Create a context object specific to these handlers, including the changesLog
    const handlerContext = { ...context, changesLog };

    // --- Read Operations ---

    async function readFileContent(args) {
        const { filePath } = args;
        if (!filePath) return { error: "Missing required argument: filePath" };

        const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, filePath);

        try {
            emitLog(socket, `📄 Reading file: ${filePath}`, 'info');
            // No context log for reads? Or maybe? Let's skip for now to avoid clutter.
            // emitContextLog(socket, 'readFileContent', `Read: ${filePath}`);
            const content = await fs.readFile(fullPath, "utf-8");
            emitLog(socket, ` ✅ Read success: ${filePath} (${content.length} chars)`, 'info');
            return { success: true, content: content };
        } catch (error) {
            if (error.code === 'ENOENT') {
                emitLog(socket, ` ⚠️ File not found: ${filePath}`, 'warn');
                 return { error: `File not found: '${filePath}'` };
            }
            emitLog(socket, `❌ Error reading file ${filePath}: ${error.message}`, 'error');
            return { error: `Failed to read file '${filePath}': ${error.message}` };
        }
    }

    async function listFiles(args) {
        // Default to '.' if directoryPath is missing or empty
        const directoryPath = args?.directoryPath || ".";
        const relativeDirectoryPath = directoryPath === '.' ? '.' : path.normalize(directoryPath);

        const safetyCheck = checkSafety([relativeDirectoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, relativeDirectoryPath);

        try {
             emitLog(socket, ` Ls Listing files in: ${relativeDirectoryPath} (respecting .gitignore)`, 'info');
             // emitContextLog(socket, 'listFiles', `List: ${relativeDirectoryPath || '.'}`);
             const ig = await loadGitignore(BASE_DIR, socket); // Load gitignore relative to BASE_DIR
             const entries = await fs.readdir(fullPath, { withFileTypes: true });

            // Filter based on .gitignore
            const filteredEntries = entries.filter(entry => {
                const entryRelativePath = path.relative(BASE_DIR, path.join(fullPath, entry.name));
                // Convert to POSIX style slashes for ignore matching
                const posixPath = entryRelativePath.split(path.sep).join(path.posix.sep);
                // Append '/' for directories to match common .gitignore patterns
                const pathToFilter = entry.isDirectory() ? `${posixPath}/` : posixPath;
                return !ig.ignores(pathToFilter);
            });

             const files = filteredEntries
                 .map((entry) => ({
                     name: entry.name,
                     isDirectory: entry.isDirectory(),
                     isFile: entry.isFile() // Include isFile for clarity
                 }))
                 .sort((a, b) => { // Sort directories first, then alphabetically
                     if (a.isDirectory && !b.isDirectory) return -1;
                     if (!a.isDirectory && b.isDirectory) return 1;
                     return a.name.localeCompare(b.name);
                 });

             emitLog(socket, ` ✅ Found ${files.length} entries (after filtering) in ${relativeDirectoryPath}`, 'info');
            return { success: true, files };
        } catch (error) {
            if (error.code === 'ENOENT') {
                emitLog(socket, ` ⚠️ Directory not found: ${relativeDirectoryPath}`, 'warn');
                return { error: `Directory not found: '${relativeDirectoryPath}'` };
            }
             emitLog(socket, `❌ Error listing files in ${relativeDirectoryPath}: ${error.message}`, 'error');
            return { error: `Failed to list files in '${relativeDirectoryPath}': ${error.message}` };
        }
    }

     async function searchFiles(args) {
        const { pattern } = args;
        if (!pattern) return { error: "Missing required argument: pattern" };
        if (!BASE_DIR) return { error: "Base directory not set."}; // Should be caught earlier

        // Security check: Prevent escaping the base directory
         if (pattern.includes("..")) {
             const msg = `Access denied: Search pattern contains invalid path traversal ('..'). Pattern: ${pattern}`;
             emitLog(socket, `⚠️ Security Warning: ${msg}`, 'warn');
             return { error: msg };
         }
         // Security check: Ensure pattern is relative
         if (path.isAbsolute(pattern)) {
             const msg = `Access denied: Search pattern must be relative to the base directory. Pattern: ${pattern}`;
             emitLog(socket, `⚠️ Security Warning: ${msg}`, 'warn');
             return { error: msg };
         }


        try {
             emitLog(socket, `🔎 Searching files with glob pattern: '${pattern}' in ${BASE_DIR} (respecting .gitignore)`, 'info');
             // emitContextLog(socket, 'searchFiles', `Search Files: ${pattern}`);

             // Load .gitignore for filtering results
             // const ig = await loadGitignore(BASE_DIR, socket); // Already loaded in listFiles? Maybe cache it? For now, load again.

            // Use glob to find files
            const results = await glob(pattern, {
                cwd: BASE_DIR,
                nodir: true, // Only match files, not directories
                dot: true, // Include dotfiles
                absolute: false, // Return paths relative to cwd (BASE_DIR)
                follow: false, // Don't follow symlinks
                ignore: ['.git/**'] // Basic ignore, could enhance with full .gitignore parsing if needed frequently here
                // ignore: ig.ignores // Does glob support ignore instance directly? Check docs. Assume simple array for now.
            });

             emitLog(socket, ` ✅ Glob search found ${results.length} file(s) matching '${pattern}'`, 'info');
             // Note: This basic glob ignore might not fully respect nested .gitignore files.
             // For full compliance, would need to filter results post-glob using the 'ignore' package again.

             return { success: true, filePaths: results };
        } catch (error) {
             emitLog(socket, `❌ Error searching files with pattern '${pattern}': ${error.message}`, 'error');
             return { error: `Failed to search files: ${error.message}` };
        }
    }

     async function searchFilesByRegex(args) {
         const { regexString, directoryPath = "." } = args;
         if (!regexString) return { error: "Missing required argument: regexString" };

        // Basic Regex validation
        let regex;
        try {
            // Attempt to create RegExp from string. Handles /pattern/flags format.
            const match = regexString.match(/^\/(.+)\/([gimyus]*)$/);
            if (match) {
                regex = new RegExp(match[1], match[2]);
            } else {
                regex = new RegExp(regexString); // Treat as simple pattern if no slashes/flags
            }
        } catch (e) {
            emitLog(socket, `❌ Invalid regex provided: "${regexString}". Error: ${e.message}`, 'error');
            return { error: `Invalid regular expression provided: ${e.message}` };
        }

         const relativeSearchDir = directoryPath === '.' ? '.' : path.normalize(directoryPath);
         const safetyCheck = checkSafety([relativeSearchDir], BASE_DIR, socket);
         if (!safetyCheck.safe) return { error: safetyCheck.error };

         const fullSearchPath = path.resolve(BASE_DIR, relativeSearchDir);

         try {
             emitLog(socket, `🔎 Searching file content with regex: ${regex} in ${relativeSearchDir} (respecting .gitignore)`, 'info');
             // emitContextLog(socket, 'searchFilesByRegex', `Search Content: ${regex} in ${relativeSearchDir || '.'}`);
             const ig = await loadGitignore(BASE_DIR, socket);
             const matchingFiles = [];
             let filesScanned = 0;
             let filesIgnored = 0;

             async function scanDir(currentDir) {
                 try {
                     const entries = await fs.readdir(currentDir, { withFileTypes: true });
                     for (const entry of entries) {
                         const entryFullPath = path.join(currentDir, entry.name);
                         const entryRelativePath = path.relative(BASE_DIR, entryFullPath);
                         const posixPath = entryRelativePath.split(path.sep).join(path.posix.sep);
                         const filterPath = entry.isDirectory() ? `${posixPath}/` : posixPath;

                         if (ig.ignores(filterPath)) {
                             filesIgnored++;
                             continue;
                         }

                         if (entry.isFile()) {
                             filesScanned++;
                             try {
                                 const content = await fs.readFile(entryFullPath, 'utf-8');
                                 const matches = content.match(regex); // Find all matches using the regex
                                 if (matches && matches.length > 0) {
                                     matchingFiles.push({
                                         filePath: entryRelativePath, // Return relative path
                                         matchCount: matches.length
                                     });
                                 }
                             } catch (readError) {
                                 if (readError.code !== 'ENOENT') { // Ignore files that disappear during scan
                                      emitLog(socket, `⚠️ Error reading file during regex search: ${entryRelativePath} - ${readError.message}`, 'warn');
                                 }
                             }
                         } else if (entry.isDirectory()) {
                             await scanDir(entryFullPath); // Recurse into subdirectories
                         }
                     }
                 } catch (dirError) {
                     if (dirError.code !== 'ENOENT') {
                         emitLog(socket, `⚠️ Error scanning directory during regex search: ${currentDir} - ${dirError.message}`, 'warn');
                     }
                 }
             }

             await scanDir(fullSearchPath);

             emitLog(socket, ` ✅ Regex search complete. Found ${matchingFiles.length} file(s) with matches. Scanned: ${filesScanned}, Ignored: ${filesIgnored}.`, 'info');
             return { success: true, matchingFiles };

         } catch (error) {
              emitLog(socket, `❌ Error searching file content with regex '${regexString}': ${error.message}`, 'error');
              return { error: `Failed to search file content: ${error.message}` };
         }
     }

    // --- Write/Modify Operations ---

    async function writeFileContent(args) {
        const { filePath, content } = args;
        if (!filePath || content === undefined) {
            return { error: "Missing required arguments: filePath and/or content" };
        }

        const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, filePath);
        let oldContent = null;
        let fileExisted = true;

        // Try reading existing content for diff and undo logging
        try {
            oldContent = await fs.readFile(fullPath, 'utf-8');
             emitLog(socket, ` ℹ️ Read existing content of '${filePath}' for diff/log.`, 'debug');
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                fileExisted = false;
                oldContent = null; // Ensure oldContent is null if file didn't exist
                emitLog(socket, ` ℹ️ File '${filePath}' does not exist, will create new file.`, 'info');
            } else {
                // Log warning but proceed, just won't have accurate diff/undo
                 emitLog(socket, `⚠️ Error reading existing file content for diff/log (${filePath}): ${readError.message}. Proceeding without diff/undo data.`, 'warn');
                 fileExisted = false; // Treat as non-existent for safety if read fails
                 oldContent = null;
            }
        }

        // Request user confirmation if not bypassed by 'yes/all'
        if (!confirmAllRef.value) {
            let diffString = '(Diff generation failed or not applicable)';
            if (oldContent !== null) { // Only generate diff if old content was read successfully
                try {
                    diffString = generateDiff(oldContent ?? '', content); // Use empty string if oldContent is somehow nullish despite existing
                } catch (diffError) {
                    emitLog(socket, `⚠️ Error generating diff for ${filePath}: ${diffError.message}`, 'warn');
                    diffString = '(Error generating diff)';
                }
            } else if (!fileExisted) {
                 diffString = '(Creating new file)';
            }

            // Emit context log *before* waiting for confirmation
            emitContextLog(socket, 'confirmation_request', `${fileExisted ? 'Confirm Overwrite' : 'Confirm Create'}: ${filePath}`);

            const userDecision = await requestUserConfirmation(
                socket,
                `${fileExisted ? 'Overwrite' : 'Create'} file: '${filePath}'?`,
                (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; },
                diffString // Pass the generated diff string
            );
            if (feedbackResolverRef) feedbackResolverRef.value = null; // Clear resolver immediately

            if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                emitLog(socket, ` 🚫 Operation cancelled by user/system: writeFileContent(${filePath}) - Reason: ${reason}`, 'warn');
                emitContextLog(socket, 'confirmation_response', `Write ${filePath} - ${reason}`);
                return { error: `User or system ${reason} writing to file '${filePath}'.` };
            } else if (userDecision === 'yes/all') {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to 'Yes to All' for this task.`, 'info');
                 emitContextLog(socket, 'confirmation_response', `Write ${filePath} - Confirmed (Yes to All)`);
            } else {
                // User selected 'yes'
                emitContextLog(socket, 'confirmation_response', `Write ${filePath} - Confirmed (Yes)`);
            }
        } else {
            emitLog(socket, ` 👍 Skipping confirmation for '${filePath}' due to 'Yes to All'.`, 'info');
            emitContextLog(socket, 'writeFileContent', `Write: ${filePath} (Auto-confirmed)`);
        }


        emitLog(socket, `💾 Executing write for: ${filePath}`, 'info');
        // Pass oldContent to _writeFile context
        // *** FIXED LINE: Pass 'filePath' as the fourth argument (filePathLog) ***
        const writeResult = await _writeFile(fullPath, content, { ...handlerContext, oldContent }, filePath, fileExisted);

        if (writeResult.success) {
            const successMsg = `File ${fileExisted ? 'updated' : 'created'} successfully: ${filePath}`;
            emitLog(socket, ` ✅ ${successMsg}`, 'success');
            // Don't add context log here, it was added before confirmation or via _writeFile
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed write for ${filePath}. Error: ${writeResult.error}`, 'error');
            emitContextLog(socket, 'error', `Write Failed: ${filePath} - ${writeResult.error}`);
            return writeResult;
        }
    }

    async function deleteFile(args) {
        const { filePath } = args;
        if (!filePath) return { error: "Missing required argument: filePath" };

        const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, filePath);
        let oldContent = null;
        let fileExists = false;

        // Check if file exists and read content for logging/undo
        try {
             const stats = await fs.stat(fullPath);
             if (!stats.isFile()) {
                  emitLog(socket, ` ⚠️ Path is not a file, cannot delete: '${filePath}'.`, 'warn');
                  return { error: `Cannot delete: Path '${filePath}' is not a file.` };
             }
             fileExists = true;
             oldContent = await fs.readFile(fullPath, 'utf-8');
             emitLog(socket, ` ℹ️ Read content of '${filePath}' before deletion for log/undo.`, 'debug');
        } catch (readError) {
             if (readError.code === 'ENOENT') {
                 // File already doesn't exist, consider it a success?
                 emitLog(socket, ` ⚠️ File not found for deletion: '${filePath}'. Assuming already deleted.`, 'warn');
                 emitContextLog(socket, 'deleteFile', `Delete Skipped (Not Found): ${filePath}`);
                 return { success: true, message: `File '${filePath}' not found (already deleted?).` };
             } else {
                 // Other error reading file - log warning, proceed without old content
                 emitLog(socket, ` ⚠️ Error reading file content before deletion (${filePath}): ${readError.message}. Cannot guarantee undo.`, 'warn');
                 oldContent = null; // Ensure oldContent is null
                 fileExists = true; // Assume it exists if stat didn't throw ENOENT but read did
             }
        }

        // Request confirmation if file exists
        if (!confirmAllRef.value && fileExists) {
            // Emit context log *before* waiting for confirmation
            emitContextLog(socket, 'confirmation_request', `Confirm Delete: ${filePath}`);
            const userDecision = await requestUserConfirmation(
                socket,
                `Delete file: '${filePath}'? (Cannot be easily undone)`,
                (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; }
                // No diff needed for delete
            );
            if (feedbackResolverRef) feedbackResolverRef.value = null; // Clear resolver

             if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                emitLog(socket, ` 🚫 Operation cancelled by user/system: deleteFile(${filePath}) - Reason: ${reason}`, 'warn');
                emitContextLog(socket, 'confirmation_response', `Delete ${filePath} - ${reason}`);
                return { error: `User or system ${reason} deleting file '${filePath}'.` };
            } else if (userDecision === 'yes/all') {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to 'Yes to All' for this task.`, 'info');
                 emitContextLog(socket, 'confirmation_response', `Delete ${filePath} - Confirmed (Yes to All)`);
            } else {
                 emitContextLog(socket, 'confirmation_response', `Delete ${filePath} - Confirmed (Yes)`);
            }
        } else if (fileExists) {
             emitLog(socket, ` 👍 Skipping confirmation for deleting '${filePath}' due to 'Yes to All'.`, 'info');
             emitContextLog(socket, 'deleteFile', `Delete: ${filePath} (Auto-confirmed)`);
        }
        // If file didn't exist, we already returned success earlier.

        // Log change *before* deleting (capture old content) - moved to _deleteFile
        // if (changesLog && fileExists) { ... }

        emitLog(socket, `🗑️ Executing delete for: ${filePath}`, 'info');
        // Pass old content to _deleteFile context
        const deleteResult = await _deleteFile(fullPath, { ...handlerContext, oldContent }, filePath);

        if (deleteResult.success) {
             const successMsg = deleteResult.message || `File deleted successfully: '${filePath}'`;
             emitLog(socket, ` ✅ ${successMsg}`, 'success');
             // Context log added before confirmation or if auto-confirmed
             return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed delete for ${filePath}. Error: ${deleteResult.error}`, 'error');
            emitContextLog(socket, 'error', `Delete Failed: ${filePath} - ${deleteResult.error}`);
             // Attempt to remove the change log entry if deletion failed?
             // Handled by _deleteFile now implicitly (it only adds log on success)
            return deleteResult;
        }
    }

    async function moveItem(args) {
        const { sourcePath, destinationPath } = args;
        if (!sourcePath || !destinationPath) {
             return { error: "Missing required arguments: sourcePath and/or destinationPath" };
        }

        if (sourcePath === destinationPath) {
            emitLog(socket, ` ⚠️ Source and destination paths are identical: '${sourcePath}'. No move needed.`, 'warn');
            return { success: true, message: "Source and destination paths are the same. No action taken." };
        }

        const safetyCheck = checkSafety([sourcePath, destinationPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullSourcePath = path.resolve(BASE_DIR, sourcePath);
        const fullDestPath = path.resolve(BASE_DIR, destinationPath);

        // Check if source exists before proceeding
         try {
             await fs.access(fullSourcePath);
         } catch (accessError) {
             emitLog(socket, ` ⚠️ Source path not found for move: '${sourcePath}'. Cannot proceed.`, 'warn');
             return { error: `Source path not found: '${sourcePath}'` };
         }

        // Check if destination already exists (rename fails if it does)
        try {
            await fs.access(fullDestPath);
            // If access succeeds, destination exists - this is an error for rename/move
            const msg = `Destination path '${destinationPath}' already exists. Cannot move/rename: Overwriting is not directly supported by 'moveItem'. Delete the destination first if overwriting is intended.`;
            emitLog(socket, ` ⚠️ ${msg}`, 'warn');
            return { error: msg };
        } catch (destAccessError) {
             // ENOENT is expected (destination should *not* exist). Other errors are problems.
            if (destAccessError.code !== 'ENOENT') {
                 emitLog(socket, ` ⚠️ Error checking destination path '${destinationPath}': ${destAccessError.message}`, 'warn');
                 return { error: `Failed to check destination path '${destinationPath}': ${destAccessError.message}` };
            }
            // Destination does not exist, OK to proceed.
        }

        // Request confirmation
        if (!confirmAllRef.value) {
            emitContextLog(socket, 'confirmation_request', `Confirm Move: ${sourcePath} -> ${destinationPath}`);
            const userDecision = await requestUserConfirmation(
                socket,
                `Move/rename '${sourcePath}' to '${destinationPath}'?`,
                (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; }
            );
             if (feedbackResolverRef) feedbackResolverRef.value = null;

            if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                emitLog(socket, ` 🚫 Operation cancelled by user/system: moveItem(${sourcePath}, ${destinationPath}) - Reason: ${reason}`, 'warn');
                emitContextLog(socket, 'confirmation_response', `Move ${sourcePath} -> ${destinationPath} - ${reason}`);
                return { error: `User or system ${reason} moving item '${sourcePath}'.` };
            } else if (userDecision === 'yes/all') {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to 'Yes to All' for this task.`, 'info');
                 emitContextLog(socket, 'confirmation_response', `Move ${sourcePath} -> ${destinationPath} - Confirmed (Yes to All)`);
            } else {
                 emitContextLog(socket, 'confirmation_response', `Move ${sourcePath} -> ${destinationPath} - Confirmed (Yes)`);
            }
        } else {
             emitLog(socket, ` 👍 Skipping confirmation for moving '${sourcePath}' due to 'Yes to All'.`, 'info');
             emitContextLog(socket, 'moveItem', `Move: ${sourcePath} -> ${destinationPath} (Auto-confirmed)`);
        }

        emitLog(socket, `🚚 Executing move from: ${sourcePath} To: ${destinationPath}`, 'info');
        const moveResult = await _moveItem(fullSourcePath, fullDestPath, handlerContext, sourcePath, destinationPath);

        if (moveResult.success) {
            const successMsg = `Item moved/renamed successfully from '${sourcePath}' to '${destinationPath}'`;
            emitLog(socket, ` ✅ ${successMsg}`, 'success');
            // Context log added before confirmation or if auto-confirmed
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed move for ${sourcePath} -> ${destinationPath}. Error: ${moveResult.error}`, 'error');
            emitContextLog(socket, 'error', `Move Failed: ${sourcePath} -> ${destinationPath} - ${moveResult.error}`);
             // Remove change log? _moveItem handles adding log only on success.
            return moveResult;
        }
    }

    async function createDirectory(args) {
        const { directoryPath } = args;
        if (!directoryPath) return { error: "Missing required argument: directoryPath" };

        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, directoryPath);

        // No confirmation needed for creating directory (generally safe)
        emitLog(socket, `📁 Executing create directory: ${directoryPath}`, 'info');
        emitContextLog(socket, 'createDirectory', `Create Folder: ${directoryPath}`);
        const createResult = await _createDir(fullPath, handlerContext, directoryPath);

        if (createResult.success) {
            const successMsg = createResult.message || `Directory created successfully at '${directoryPath}'`;
            emitLog(socket, ` ✅ ${successMsg}`, 'success');
            // Context log added above
             // If message indicates it already existed, maybe change context log type?
             if (createResult.message && createResult.message.includes('already exists')) {
                // Overwrite previous context log? Or add a new one? Let's just log info.
                emitContextLog(socket, 'info', `Folder already exists: ${directoryPath}`);
             }
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed create directory for ${directoryPath}. Error: ${createResult.error}`, 'error');
            emitContextLog(socket, 'error', `Create Folder Failed: ${directoryPath} - ${createResult.error}`);
            // Remove change log? _createDir only adds on success.
            return createResult;
        }
    }

    async function deleteDirectory(args) {
        const { directoryPath } = args;
        if (!directoryPath) return { error: "Missing required argument: directoryPath" };

        // Prevent deleting '.' or '/' relative to base
        if (directoryPath === '.' || directoryPath === '/' || directoryPath === '') {
             emitLog(socket, ` ⚠️ Attempted to delete base directory or invalid path: '${directoryPath}'. Denied.`, 'error');
             return { error: `Deleting the base directory or invalid path ('${directoryPath}') is not allowed.` };
        }

        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, directoryPath);

        // Check if directory exists before asking confirmation
         try {
             const stats = await fs.stat(fullPath);
             if (!stats.isDirectory()) {
                 const msg = `Path '${directoryPath}' is not a directory. Cannot delete. Use deleteFile instead?`;
                 emitLog(socket, ` ⚠️ ${msg}`, 'warn');
                 return { error: msg };
             }
         } catch (statError) {
             if (statError.code === 'ENOENT') {
                 // Directory doesn't exist, consider success
                 emitLog(socket, ` ⚠️ Directory not found for deletion: '${directoryPath}'. Assuming already deleted.`, 'warn');
                 emitContextLog(socket, 'deleteDirectory', `Delete Folder Skipped (Not Found): ${directoryPath}`);
                 return { success: true, message: `Directory '${directoryPath}' not found (already deleted?).` };
             }
             // Other stat error
             emitLog(socket, `❌ Error accessing directory ${directoryPath}: ${statError.message}`, 'error');
             return { error: `Failed to access directory '${directoryPath}': ${statError.message}` };
         }

        // Directory exists, ask for confirmation
        if (!confirmAllRef.value) {
            emitContextLog(socket, 'confirmation_request', `Confirm Delete Folder (Recursive): ${directoryPath}`);
            const userDecision = await requestUserConfirmation(
                 socket,
                 `DELETE directory '${directoryPath}' and ALL ITS CONTENTS recursively? This is IRREVERSIBLE.`,
                 (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; }
             );
             if (feedbackResolverRef) feedbackResolverRef.value = null;

             if (userDecision === 'no' || userDecision === 'disconnect' || userDecision === 'error' || userDecision === 'task-end') {
                 const reason = userDecision === 'no' ? 'rejected' : `cancelled (${userDecision})`;
                 emitLog(socket, ` 🚫 Operation cancelled by user/system: deleteDirectory(${directoryPath}) - Reason: ${reason}`, 'warn');
                 emitContextLog(socket, 'confirmation_response', `Delete Folder ${directoryPath} - ${reason}`);
                 return { error: `User or system ${reason} deleting directory '${directoryPath}'.` };
             } else if (userDecision === 'yes/all') {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to 'Yes to All' for this task (including recursive delete).`, 'info');
                 emitContextLog(socket, 'confirmation_response', `Delete Folder ${directoryPath} - Confirmed (Yes to All)`);
             } else {
                emitContextLog(socket, 'confirmation_response', `Delete Folder ${directoryPath} - Confirmed (Yes)`);
             }
        } else {
             emitLog(socket, ` 👍 Skipping confirmation for deleting directory '${directoryPath}' due to 'Yes to All'.`, 'info');
             emitContextLog(socket, 'deleteDirectory', `Delete Folder: ${directoryPath} (Auto-confirmed)`);
        }

        emitLog(socket, `🗑️🔥 Executing delete directory (recursive): ${directoryPath}`, 'info');
        const deleteResult = await _deleteDirRecursive(fullPath, handlerContext, directoryPath);

        if (deleteResult.success) {
            const successMsg = deleteResult.message || `Directory deleted successfully: '${directoryPath}'`;
            emitLog(socket, ` ✅ ${successMsg}`, 'success');
            // Context log added before confirmation or if auto-confirmed
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed delete directory for ${directoryPath}. Error: ${deleteResult.error}`, 'error');
            emitContextLog(socket, 'error', `Delete Folder Failed: ${directoryPath} - ${deleteResult.error}`);
             // Remove change log? _deleteDirRecursive adds log only on success.
            return deleteResult;
        }
    }

    // --- Interaction Functions ---

    async function askUserQuestion(args) {
        const { question } = args;
        if (!question) return { error: "Missing required argument: question" };

        emitLog(socket, `❓ Asking user: ${question}`, 'info');
        emitContextLog(socket, 'question', `Question: ${question}`); // Add to context log

        return new Promise((resolve) => {
            // Set the resolver for the 'user-question-response' event
            if (questionResolverRef) questionResolverRef.value = resolve;

            // Send the question to the client
            socket.emit('ask-question-request', { question });
        }).then(answer => {
            // Clear the resolver once the answer is received
            if (questionResolverRef) questionResolverRef.value = null;
            emitLog(socket, `🗣️ Received answer: ${JSON.stringify(answer)}`, 'info');
            emitContextLog(socket, 'answer', `Answer: ${JSON.stringify(answer)}`); // Log answer to context

            // Check for disconnect/error during wait
             if (answer === 'disconnect' || answer === 'error' || answer === 'task-end') {
                return { error: `Question cancelled due to ${answer}.` };
             }
            // Return the answer structure expected by Gemini
            return { success: true, answer: answer };
        }).catch(error => {
             // Should not happen with promise structure unless setup fails
             emitLog(socket, `❌ Error in askUserQuestion promise: ${error}`, 'error');
             if (questionResolverRef) questionResolverRef.value = null;
             emitContextLog(socket, 'error', `Question Error: ${error.message || error}`);
             return { error: `Failed to get user answer: ${error.message}` };
        });
    }

     async function showInformationTextToUser(args) {
         const { messageToDisplay } = args;
         if (!messageToDisplay) return { error: "Missing required argument: messageToDisplay" };

         emitLog(socket, `ℹ️ Info for user: ${messageToDisplay}`, 'info');
         // Also add this important info to the context log
         emitContextLog(socket, 'info', `Info: ${messageToDisplay}`);

         // This function just displays info, it doesn't block or return data to Gemini beyond success.
         return { success: true, message: "Information displayed to user." };
     }

     // --- Task Completion Function ---
     async function task_finished(args) {
        const { finalMessage } = args;
        if (!finalMessage) return { error: "Missing required argument: finalMessage" };

        emitLog(socket, `✅ Task Finished signal received from Gemini: ${finalMessage}`, 'success');
        // Context log is added by the runner when it processes this signal
        // emitContextLog(socket, 'task_finished', `Finished: ${finalMessage}`); // Or add here? Let runner do it.

        // This handler returns a special structure that the runner will detect.
        // It does NOT emit task-complete itself.
        return { finished: true, message: finalMessage };
     }


    return {
        readFileContent,
        listFiles,
        searchFiles,
        searchFilesByRegex,
        writeFileContent,
        createDirectory,
        deleteFile,
        moveItem,
        deleteDirectory,
        askUserQuestion,
        showInformationTextToUser,
        task_finished, // Expose the new function
    };
}


// --- Undo Operation ---
// This function is called internally by the server, not directly by Gemini
async function performUndoOperation(operation, context) {
    const { socket, BASE_DIR } = context;
    emitLog(socket, `⏪ Attempting to undo operation: ${operation.type} (${operation.filePath || operation.directoryPath || operation.sourcePath})`, 'info');
    let result = { error: "Unknown undo operation type" };
    // Undo operations don't need confirmation or change logging
    const undoContext = { socket, BASE_DIR, changesLog: null }; // No changesLog for undo itself

    try {
        let safetyCheck;
        switch (operation.type) {
            case 'createFile':
                 safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Deleting originally created file: ${operation.filePath}`, 'info');
                 // Pass dummy oldContent as it's not needed for delete undo logic
                 result = await _deleteFile(path.resolve(BASE_DIR, operation.filePath), { ...undoContext, oldContent: null }, operation.filePath);
                break;

            case 'updateFile':
                 safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 if (operation.oldContent === undefined || operation.oldContent === null) {
                     emitLog(socket, ` ⚠️ Cannot undo update for ${operation.filePath}: Original content not recorded.`, 'warn');
                     return { error: `Undo failed: Original content for ${operation.filePath} unavailable.` };
                 }
                 emitLog(socket, ` Undo: Restoring original content of ${operation.filePath}`, 'info');
                 // Use _writeFile to restore old content. Treat as 'update' since file must have existed.
                 result = await _writeFile(path.resolve(BASE_DIR, operation.filePath), operation.oldContent, undoContext, operation.filePath, true);
                break;

            case 'deleteFile':
                 safetyCheck = checkSafety([operation.filePath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Restoring originally deleted file: ${operation.filePath}`, 'info');
                 // Use _writeFile to restore. Treat as 'create' since file didn't exist after delete.
                 // Use oldContent if available, otherwise empty string.
                 result = await _writeFile(path.resolve(BASE_DIR, operation.filePath), operation.oldContent ?? '', undoContext, operation.filePath, false);
                break;

             case 'createDirectory':
                 safetyCheck = checkSafety([operation.directoryPath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Deleting originally created directory: ${operation.directoryPath}`, 'info');
                 result = await _deleteDirRecursive(path.resolve(BASE_DIR, operation.directoryPath), undoContext, operation.directoryPath);
                break;

             case 'moveItem':
                 // Need to move it back
                 safetyCheck = checkSafety([operation.sourcePath, operation.destinationPath], BASE_DIR, socket);
                 if (!safetyCheck.safe) return { error: safetyCheck.error };
                 emitLog(socket, ` Undo: Moving item back from ${operation.destinationPath} to ${operation.sourcePath}`, 'info');
                 result = await _moveItem(
                     path.resolve(BASE_DIR, operation.destinationPath), // New source is old destination
                     path.resolve(BASE_DIR, operation.sourcePath),      // New destination is old source
                     undoContext,
                     operation.destinationPath, // Log source
                     operation.sourcePath       // Log destination
                 );
                 break;

            case 'deleteDirectory':
                // As noted, proper undo is very hard. Log warning.
                 emitLog(socket, ` ⚠️ Undo for 'deleteDirectory' (${operation.directoryPath}) is not supported.`, 'warn');
                 result = { error: `Undo for recursive directory deletion ('${operation.directoryPath}') is not implemented.` };
                break;

            default:
                 emitLog(socket, ` ⚠️ Unknown undo operation type: ${operation.type}`, 'warn');
                 result = { error: `Unknown undo operation type: ${operation.type}` };
        }
    } catch (undoError) {
        emitLog(socket, ` ❌ CRITICAL ERROR during undo operation ${operation.type} for ${operation.filePath || operation.directoryPath}: ${undoError.message}`, 'error');
        console.error("Undo execution error:", undoError);
        result = { error: `Failed to execute undo for ${operation.type}: ${undoError.message}` };
    }

    if (result.error) {
        emitLog(socket, ` ❌ Undo failed for ${operation.type}: ${result.error}`, 'error');
    } else {
        emitLog(socket, ` ✅ Undo successful for ${operation.type}`, 'success');
    }
    return result; // Return success/error status of the undo attempt
}


module.exports = {
    createFileSystemHandlers,
    performUndoOperation,
    loadGitignore // Export if needed elsewhere, maybe taskSetup? Yes.
};