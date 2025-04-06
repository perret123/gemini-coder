const path = require("node:path");
const fs = require("node:fs/promises");
const { glob } = require("glob");

// Adjust the path to utils and import required functions
const { emitLog, requestUserConfirmation, checkSafety, generateDiff, emitContextLogEntry } = require("../utils");

// Import the internal helper functions from their new files
const { loadGitignore } = require("./loadGitignore");
const { _writeFile } = require("./_writeFile");
const { _deleteFile } = require("./_deleteFile");
const { _moveItem } = require("./_moveItem");
const { _createDir } = require("./_createDir");
const { _deleteDirRecursive } = require("./_deleteDirRecursive");

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
            task_finished: alwaysFail,
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
            emitLog(socket, `📄 Reading file: ${filePath}`, "info");
            const content = await fs.readFile(fullPath, "utf-8");
            emitLog(socket, ` ✅ Read success: ${filePath} (${content.length} chars)`, "info");
            return { success: true, content: content };
        } catch (error) {
            if (error.code === "ENOENT") {
                emitLog(socket, ` ⚠️ File not found: ${filePath}`, "warn");
                 return { error: `File not found: \'${filePath}\"` };
            }
            emitLog(socket, `❌ Error reading file ${filePath}: ${error.message}`, "error");
            return { error: `Failed to read file \'${filePath}\': ${error.message}` };
        }
    }

    async function listFiles(args) {
        const directoryPath = args?.directoryPath || ".";
        const relativeDirectoryPath = directoryPath === "." ? "." : path.normalize(directoryPath);

        const safetyCheck = checkSafety([relativeDirectoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, relativeDirectoryPath);

        try {
             emitLog(socket, ` Ls Listing files in: ${relativeDirectoryPath} (respecting .gitignore)`, "info");
             const ig = await loadGitignore(BASE_DIR, socket); // Use imported loadGitignore
             const entries = await fs.readdir(fullPath, { withFileTypes: true });

            const filteredEntries = entries.filter(entry => {
                const entryRelativePath = path.relative(BASE_DIR, path.join(fullPath, entry.name));
                const posixPath = entryRelativePath.split(path.sep).join(path.posix.sep);
                const pathToFilter = entry.isDirectory() ? `${posixPath}/` : posixPath;
                return !ig.ignores(pathToFilter);
            });

             const files = filteredEntries
                 .map((entry) => ({
                     name: entry.name,
                     isDirectory: entry.isDirectory(),
                     isFile: entry.isFile()
                 }))
                 .sort((a, b) => {
                     if (a.isDirectory && !b.isDirectory) return -1;
                     if (!a.isDirectory && b.isDirectory) return 1;
                     return a.name.localeCompare(b.name);
                 });

             emitLog(socket, ` ✅ Found ${files.length} entries (after filtering) in ${relativeDirectoryPath}`, "info");
            return { success: true, files };
        } catch (error) {
            if (error.code === "ENOENT") {
                emitLog(socket, ` ⚠️ Directory not found: ${relativeDirectoryPath}`, "warn");
                return { error: `Directory not found: \'${relativeDirectoryPath}\"` };
            }
             emitLog(socket, `❌ Error listing files in ${relativeDirectoryPath}: ${error.message}`, "error");
            return { error: `Failed to list files in \'${relativeDirectoryPath}\': ${error.message}` };
        }
    }

     async function searchFiles(args) {
        const { pattern } = args;
        if (!pattern) return { error: "Missing required argument: pattern" };
        if (!BASE_DIR) return { error: "Base directory not set."};

         if (pattern.includes("..")) {
             const msg = `Access denied: Search pattern contains invalid path traversal (\'..\'). Pattern: ${pattern}`;
             emitLog(socket, `⚠️ Security Warning: ${msg}`, "warn");
             return { error: msg };
         }
         if (path.isAbsolute(pattern)) {
             const msg = `Access denied: Search pattern must be relative to the base directory. Pattern: ${pattern}`;
             emitLog(socket, `⚠️ Security Warning: ${msg}`, "warn");
             return { error: msg };
         }

        try {
             emitLog(socket, `🔎 Searching files with glob pattern: \'${pattern}\' in ${BASE_DIR} (respecting .gitignore)`, "info");

            const results = await glob(pattern, {
                cwd: BASE_DIR,
                nodir: true,
                dot: true,
                absolute: false,
                follow: false,
                ignore: [".git/**"]
            });

             emitLog(socket, ` ✅ Glob search found ${results.length} file(s) matching \'${pattern}\'`, "info");
             return { success: true, filePaths: results };
        } catch (error) {
             emitLog(socket, `❌ Error searching files with pattern \'${pattern}\': ${error.message}`, "error");
             return { error: `Failed to search files: ${error.message}` };
        }
    }

     async function searchFilesByRegex(args) {
         const { regexString, directoryPath = "." } = args;
         if (!regexString) return { error: "Missing required argument: regexString" };

        let regex;
        try {
            const match = regexString.match(/^\/(.+)\/([gimyus]*)$/);
            if (match) {
                regex = new RegExp(match[1], match[2]);
            } else {
                regex = new RegExp(regexString);
            }
        } catch (e) {
            emitLog(socket, `❌ Invalid regex provided: \"${regexString}\". Error: ${e.message}`, "error");
            return { error: `Invalid regular expression provided: ${e.message}` };
        }

         const relativeSearchDir = directoryPath === "." ? "." : path.normalize(directoryPath);
         const safetyCheck = checkSafety([relativeSearchDir], BASE_DIR, socket);
         if (!safetyCheck.safe) return { error: safetyCheck.error };

         const fullSearchPath = path.resolve(BASE_DIR, relativeSearchDir);

         try {
             emitLog(socket, `🔎 Searching file content with regex: ${regex} in ${relativeSearchDir} (respecting .gitignore)`, "info");
             const ig = await loadGitignore(BASE_DIR, socket); // Use imported loadGitignore
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
                                 const content = await fs.readFile(entryFullPath, "utf-8");
                                 const matches = content.match(regex);
                                 if (matches && matches.length > 0) {
                                     matchingFiles.push({
                                         filePath: entryRelativePath,
                                         matchCount: matches.length
                                     });
                                 }
                             } catch (readError) {
                                 if (readError.code !== "ENOENT") {
                                      emitLog(socket, `⚠️ Error reading file during regex search: ${entryRelativePath} - ${readError.message}`, "warn");
                                 }
                             }
                         } else if (entry.isDirectory()) {
                             await scanDir(entryFullPath);
                         }
                     }
                 } catch (dirError) {
                     if (dirError.code !== "ENOENT") {
                         emitLog(socket, `⚠️ Error scanning directory during regex search: ${currentDir} - ${dirError.message}`, "warn");
                     }
                 }
             }

             await scanDir(fullSearchPath);

             emitLog(socket, ` ✅ Regex search complete. Found ${matchingFiles.length} file(s) with matches. Scanned: ${filesScanned}, Ignored: ${filesIgnored}.`, "info");
             return { success: true, matchingFiles };

         } catch (error) {
              emitLog(socket, `❌ Error searching file content with regex \'${regexString}\': ${error.message}`, "error");
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

        try {
            oldContent = await fs.readFile(fullPath, "utf-8");
             emitLog(socket, ` ℹ️ Read existing content of \'${filePath}\' for diff/log.`, "debug");
        } catch (readError) {
            if (readError.code === "ENOENT") {
                fileExisted = false;
                oldContent = null;
                emitLog(socket, ` ℹ️ File \'${filePath}\' does not exist, will create new file.`, "info");
            } else {
                 emitLog(socket, `⚠️ Error reading existing file content for diff/log (${filePath}): ${readError.message}. Proceeding without diff/undo data.`, "warn");
                 fileExisted = false;
                 oldContent = null;
            }
        }

        if (!confirmAllRef.value) {
            let diffString = "(Diff generation failed or not applicable)";
            if (oldContent !== null) {
                try {
                    diffString = generateDiff(oldContent ?? "", content);
                } catch (diffError) {
                    emitLog(socket, `⚠️ Error generating diff for ${filePath}: ${diffError.message}`, "warn");
                    diffString = "(Error generating diff)";
                }
            } else if (!fileExisted) {
                 diffString = "(Creating new file)";
            }

            emitContextLogEntry(socket, "confirmation_request", `${fileExisted ? "Confirm Overwrite" : "Confirm Create"}: ${filePath}`, true);

            const userDecision = await requestUserConfirmation(
                socket,
                `${fileExisted ? "Overwrite" : "Create"} file: \'${filePath}\'?`,
                (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; },
                diffString
            );
            if (feedbackResolverRef) feedbackResolverRef.value = null;

            if (userDecision === "no" || userDecision === "disconnect" || userDecision === "error" || userDecision === "task-end") {
                const reason = userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
                emitLog(socket, ` 🚫 Operation cancelled by user/system: writeFileContent(${filePath}) - Reason: ${reason}`, "warn");
                emitContextLogEntry(socket, "confirmation_response", `Write ${filePath} - ${reason}`);
                return { error: `User or system ${reason} writing to file \'${filePath}\'.` };
            } else if (userDecision === "yes/all") {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to \'Yes to All\' for this task.`, "info");
                 emitContextLogEntry(socket, "confirmation_response", `Write ${filePath} - Confirmed (Yes to All)`);
            } else {
                emitContextLogEntry(socket, "confirmation_response", `Write ${filePath} - Confirmed (Yes)`);
            }
        } else {
            emitLog(socket, ` 👍 Skipping confirmation for \'${filePath}\' due to \'Yes to All\'.`, "info");
            emitContextLogEntry(socket, "writeFileContent", `Write: ${filePath} (Auto-confirmed)`);
        }

        emitLog(socket, `💾 Executing write for: ${filePath}`, "info");
        // Use the imported _writeFile
        const writeResult = await _writeFile(fullPath, content, { ...handlerContext, oldContent }, filePath, fileExisted);

        if (writeResult.success) {
            const successMsg = `File ${fileExisted ? "updated" : "created"} successfully: ${filePath}`;
            emitLog(socket, ` ✅ ${successMsg}`, "success");
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed write for ${filePath}. Error: ${writeResult.error}`, "error");
            emitContextLogEntry(socket, "error", `Write Failed: ${filePath} - ${writeResult.error}`);
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

        try {
             const stats = await fs.stat(fullPath);
             if (!stats.isFile()) {
                  emitLog(socket, ` ⚠️ Path is not a file, cannot delete: \'${filePath}\'.`, "warn");
                  return { error: `Cannot delete: Path \'${filePath}\' is not a file.` };
             }
             fileExists = true;
             oldContent = await fs.readFile(fullPath, "utf-8");
             emitLog(socket, ` ℹ️ Read content of \'${filePath}\' before deletion for log/undo.`, "debug");
        } catch (readError) {
             if (readError.code === "ENOENT") {
                 emitLog(socket, ` ⚠️ File not found for deletion: \'${filePath}\'. Assuming already deleted.`, "warn");
                 emitContextLogEntry(socket, "deleteFile", `Delete Skipped (Not Found): ${filePath}`);
                 return { success: true, message: `File \'${filePath}\' not found (already deleted?).` };
             } else {
                 emitLog(socket, ` ⚠️ Error reading file content before deletion (${filePath}): ${readError.message}. Cannot guarantee undo.`, "warn");
                 oldContent = null;
                 fileExists = true;
             }
        }

        if (!confirmAllRef.value && fileExists) {
            emitContextLogEntry(socket, "confirmation_request", `Confirm Delete: ${filePath}`, true);
            const userDecision = await requestUserConfirmation(
                socket,
                `Delete file: \'${filePath}\'? (Cannot be easily undone)`,
                (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; }
            );
            if (feedbackResolverRef) feedbackResolverRef.value = null;

             if (userDecision === "no" || userDecision === "disconnect" || userDecision === "error" || userDecision === "task-end") {
                const reason = userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
                emitLog(socket, ` 🚫 Operation cancelled by user/system: deleteFile(${filePath}) - Reason: ${reason}`, "warn");
                emitContextLogEntry(socket, "confirmation_response", `Delete ${filePath} - ${reason}`);
                return { error: `User or system ${reason} deleting file \'${filePath}\'.` };
            } else if (userDecision === "yes/all") {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to \'Yes to All\' for this task.`, "info");
                 emitContextLogEntry(socket, "confirmation_response", `Delete ${filePath} - Confirmed (Yes to All)`);
            } else {
                 emitContextLogEntry(socket, "confirmation_response", `Delete ${filePath} - Confirmed (Yes)`);
            }
        } else if (fileExists) {
             emitLog(socket, ` 👍 Skipping confirmation for deleting \'${filePath}\' due to \'Yes to All\'.`, "info");
             emitContextLogEntry(socket, "deleteFile", `Delete: ${filePath} (Auto-confirmed)`);
        }

        emitLog(socket, `🗑️ Executing delete for: ${filePath}`, "info");
        // Use imported _deleteFile
        const deleteResult = await _deleteFile(fullPath, { ...handlerContext, oldContent }, filePath);

        if (deleteResult.success) {
             const successMsg = deleteResult.message || `File deleted successfully: \'${filePath}\'`;
             emitLog(socket, ` ✅ ${successMsg}`, "success");
             return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed delete for ${filePath}. Error: ${deleteResult.error}`, "error");
            emitContextLogEntry(socket, "error", `Delete Failed: ${filePath} - ${deleteResult.error}`);
            return deleteResult;
        }
    }

    async function moveItem(args) {
        const { sourcePath, destinationPath } = args;
        if (!sourcePath || !destinationPath) {
             return { error: "Missing required arguments: sourcePath and/or destinationPath" };
        }

        if (sourcePath === destinationPath) {
            emitLog(socket, ` ⚠️ Source and destination paths are identical: \'${sourcePath}\'. No move needed.`, "warn");
            return { success: true, message: "Source and destination paths are the same. No action taken." };
        }

        const safetyCheck = checkSafety([sourcePath, destinationPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullSourcePath = path.resolve(BASE_DIR, sourcePath);
        const fullDestPath = path.resolve(BASE_DIR, destinationPath);

         try {
             await fs.access(fullSourcePath);
         } catch (accessError) {
             emitLog(socket, ` ⚠️ Source path not found for move: \'${sourcePath}\'. Cannot proceed.`, "warn");
             return { error: `Source path not found: \'${sourcePath}\'` };
         }

        try {
            await fs.access(fullDestPath);
            const msg = `Destination path \'${destinationPath}\' already exists. Cannot move/rename: Overwriting is not directly supported by \'moveItem\'. Delete the destination first if overwriting is intended.`;
            emitLog(socket, ` ⚠️ ${msg}`, "warn");
            return { error: msg };
        } catch (destAccessError) {
            if (destAccessError.code !== "ENOENT") {
                 emitLog(socket, ` ⚠️ Error checking destination path \'${destinationPath}\': ${destAccessError.message}`, "warn");
                 return { error: `Failed to check destination path \'${destinationPath}\': ${destAccessError.message}` };
            }
        }

        if (!confirmAllRef.value) {
            emitContextLogEntry(socket, "confirmation_request", `Confirm Move: ${sourcePath} -> ${destinationPath}`, true);
            const userDecision = await requestUserConfirmation(
                socket,
                `Move/rename \'${sourcePath}\' to \'${destinationPath}\'?`,
                (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; }
            );
             if (feedbackResolverRef) feedbackResolverRef.value = null;

            if (userDecision === "no" || userDecision === "disconnect" || userDecision === "error" || userDecision === "task-end") {
                const reason = userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
                emitLog(socket, ` 🚫 Operation cancelled by user/system: moveItem(${sourcePath}, ${destinationPath}) - Reason: ${reason}`, "warn");
                emitContextLogEntry(socket, "confirmation_response", `Move ${sourcePath} -> ${destinationPath} - ${reason}`);
                return { error: `User or system ${reason} moving item \'${sourcePath}\'.` };
            } else if (userDecision === "yes/all") {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to \'Yes to All\' for this task.`, "info");
                 emitContextLogEntry(socket, "confirmation_response", `Move ${sourcePath} -> ${destinationPath} - Confirmed (Yes to All)`);
            } else {
                 emitContextLogEntry(socket, "confirmation_response", `Move ${sourcePath} -> ${destinationPath} - Confirmed (Yes)`);
            }
        } else {
             emitLog(socket, ` 👍 Skipping confirmation for moving \'${sourcePath}\' due to \'Yes to All\'.`, "info");
             emitContextLogEntry(socket, "moveItem", `Move: ${sourcePath} -> ${destinationPath} (Auto-confirmed)`);
        }

        emitLog(socket, `🚚 Executing move from: ${sourcePath} To: ${destinationPath}`, "info");
        // Use imported _moveItem
        const moveResult = await _moveItem(fullSourcePath, fullDestPath, handlerContext, sourcePath, destinationPath);

        if (moveResult.success) {
            const successMsg = `Item moved/renamed successfully from \'${sourcePath}\' to \'${destinationPath}\'`;
            emitLog(socket, ` ✅ ${successMsg}`, "success");
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed move for ${sourcePath} -> ${destinationPath}. Error: ${moveResult.error}`, "error");
            emitContextLogEntry(socket, "error", `Move Failed: ${sourcePath} -> ${destinationPath} - ${moveResult.error}`);
            return moveResult;
        }
    }

    async function createDirectory(args) {
        const { directoryPath } = args;
        if (!directoryPath) return { error: "Missing required argument: directoryPath" };

        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, directoryPath);

        emitLog(socket, `📁 Executing create directory: ${directoryPath}`, "info");
        emitContextLogEntry(socket, "createDirectory", `Create Folder: ${directoryPath}`);
        // Use imported _createDir
        const createResult = await _createDir(fullPath, handlerContext, directoryPath);

        if (createResult.success) {
            const successMsg = createResult.message || `Directory created successfully at \'${directoryPath}\'`;
            emitLog(socket, ` ✅ ${successMsg}`, "success");
             if (createResult.message && createResult.message.includes("already exists")) {
                emitContextLogEntry(socket, "info", `Folder already exists: ${directoryPath}`);
             }
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed create directory for ${directoryPath}. Error: ${createResult.error}`, "error");
            emitContextLogEntry(socket, "error", `Create Folder Failed: ${directoryPath} - ${createResult.error}`);
            return createResult;
        }
    }

    async function deleteDirectory(args) {
        const { directoryPath } = args;
        if (!directoryPath) return { error: "Missing required argument: directoryPath" };

        if (directoryPath === "." || directoryPath === "/" || directoryPath === "") {
             emitLog(socket, ` ⚠️ Attempted to delete base directory or invalid path: \'${directoryPath}\'. Denied.`, "error");
             return { error: `Deleting the base directory or invalid path (\'${directoryPath}\') is not allowed.` };
        }

        const safetyCheck = checkSafety([directoryPath], BASE_DIR, socket);
        if (!safetyCheck.safe) return { error: safetyCheck.error };

        const fullPath = path.resolve(BASE_DIR, directoryPath);

         try {
             const stats = await fs.stat(fullPath);
             if (!stats.isDirectory()) {
                 const msg = `Path \'${directoryPath}\' is not a directory. Cannot delete. Use deleteFile instead?`;
                 emitLog(socket, ` ⚠️ ${msg}`, "warn");
                 return { error: msg };
             }
         } catch (statError) {
             if (statError.code === "ENOENT") {
                 emitLog(socket, ` ⚠️ Directory not found for deletion: \'${directoryPath}\'. Assuming already deleted.`, "warn");
                 emitContextLogEntry(socket, "deleteDirectory", `Delete Folder Skipped (Not Found): ${directoryPath}`);
                 return { success: true, message: `Directory \'${directoryPath}\' not found (already deleted?).` };
             }
             emitLog(socket, `❌ Error accessing directory ${directoryPath}: ${statError.message}`, "error");
             return { error: `Failed to access directory \'${directoryPath}\': ${statError.message}` };
         }

        if (!confirmAllRef.value) {
            emitContextLogEntry(socket, "confirmation_request", `Confirm Delete Folder (Recursive): ${directoryPath}`, true);
            const userDecision = await requestUserConfirmation(
                 socket,
                 `DELETE directory \'${directoryPath}\' and ALL ITS CONTENTS recursively? This is IRREVERSIBLE.`,
                 (resolve) => { if (feedbackResolverRef) feedbackResolverRef.value = resolve; }
             );
             if (feedbackResolverRef) feedbackResolverRef.value = null;

             if (userDecision === "no" || userDecision === "disconnect" || userDecision === "error" || userDecision === "task-end") {
                 const reason = userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
                 emitLog(socket, ` 🚫 Operation cancelled by user/system: deleteDirectory(${directoryPath}) - Reason: ${reason}`, "warn");
                 emitContextLogEntry(socket, "confirmation_response", `Delete Folder ${directoryPath} - ${reason}`);
                 return { error: `User or system ${reason} deleting directory \'${directoryPath}\'.` };
             } else if (userDecision === "yes/all") {
                 if (confirmAllRef) confirmAllRef.value = true;
                 emitLog(socket, ` 👍 Confirmation set to \'Yes to All\' for this task (including recursive delete).`, "info");
                 emitContextLogEntry(socket, "confirmation_response", `Delete Folder ${directoryPath} - Confirmed (Yes to All)`);
             } else {
                emitContextLogEntry(socket, "confirmation_response", `Delete Folder ${directoryPath} - Confirmed (Yes)`);
             }
        } else {
             emitLog(socket, ` 👍 Skipping confirmation for deleting directory \'${directoryPath}\' due to \'Yes to All\'.`, "info");
             emitContextLogEntry(socket, "deleteDirectory", `Delete Folder: ${directoryPath} (Auto-confirmed)`);
        }

        emitLog(socket, `🗑️🔥 Executing delete directory (recursive): ${directoryPath}`, "info");
        // Use imported _deleteDirRecursive
        const deleteResult = await _deleteDirRecursive(fullPath, handlerContext, directoryPath);

        if (deleteResult.success) {
            const successMsg = deleteResult.message || `Directory deleted successfully: \'${directoryPath}\'`;
            emitLog(socket, ` ✅ ${successMsg}`, "success");
            return { success: true, message: successMsg };
        } else {
            emitLog(socket, ` ❌ Failed delete directory for ${directoryPath}. Error: ${deleteResult.error}`, "error");
            emitContextLogEntry(socket, "error", `Delete Folder Failed: ${directoryPath} - ${deleteResult.error}`);
            return deleteResult;
        }
    }

    // --- Interaction Functions ---

    async function askUserQuestion(args) {
        const { question } = args;
        if (!question) return { error: "Missing required argument: question" };

        emitLog(socket, `❓ Asking user: ${question}`, "info");
        emitContextLogEntry(socket, "question", `Question: ${question}`);

        return new Promise((resolve) => {
            if (questionResolverRef) questionResolverRef.value = resolve;
            socket.emit("ask-question-request", { question });
        }).then(answer => {
            if (questionResolverRef) questionResolverRef.value = null;
            emitLog(socket, `🗣️ Received answer: ${JSON.stringify(answer)}`, "info");
            emitContextLogEntry(socket, "answer", `Answer: ${JSON.stringify(answer)}`);

             if (answer === "disconnect" || answer === "error" || answer === "task-end") {
                return { error: `Question cancelled due to ${answer}.` };
             }
            return { success: true, answer: answer };
        }).catch(error => {
             emitLog(socket, `❌ Error in askUserQuestion promise: ${error}`, "error");
             if (questionResolverRef) questionResolverRef.value = null;
             emitContextLogEntry(socket, "error", `Question Error: ${error.message || error}`);
             return { error: `Failed to get user answer: ${error.message}` };
        });
    }

     async function showInformationTextToUser(args) {
         const { messageToDisplay } = args;
         if (!messageToDisplay) return { error: "Missing required argument: messageToDisplay" };

         emitLog(socket, `ℹ️ Info for user: ${messageToDisplay}`, "info");
         emitContextLogEntry(socket, "info", `Info: ${messageToDisplay}`);

         return { success: true, message: "Information displayed to user." };
     }

     // --- Task Completion Function ---
     async function task_finished(args) {
        const { finalMessage } = args;
        if (!finalMessage) return { error: "Missing required argument: finalMessage" };

        emitLog(socket, `✅ Task Finished signal received from Gemini: ${finalMessage}`, "success");
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
        task_finished,
    };
}

module.exports = { createFileSystemHandlers }; // Export the main factory function
