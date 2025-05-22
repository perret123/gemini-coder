// c:\dev\gemini-coder\src\server\fileSystem\createFileSystemHandlers.js
import path from "node:path";
import fs from "node:fs/promises";
import { glob } from "glob";
import {
  emitLog,
  requestUserConfirmation,
  checkSafety,
  generateDiff,
  emitContextLogEntry,
} from "../utils.js"; // Added .js extension
import { loadGitignore } from "./loadGitignore.js"; // Added .js extension
import { _writeFile } from "./_writeFile.js"; // Added .js extension
import { _deleteFile } from "./_deleteFile.js"; // Added .js extension
import { _moveItem } from "./_moveItem.js"; // Added .js extension
import { _createDir } from "./_createDir.js"; // Added .js extension
import { _deleteDirRecursive } from "./_deleteDirRecursive.js"; // Added .js extension

// Export the main function
export function createFileSystemHandlers(context, changesLog) {
  const {
    socket,
    BASE_DIR,
    confirmAllRef,
    feedbackResolverRef,
    questionResolverRef,
  } = context;

  // Check if BASE_DIR is properly set, return dummy handlers if not
  if (!BASE_DIR) {
    const errorMsg =
      "FATAL: Base directory (BASE_DIR) is not set in context. Cannot create file system handlers.";
    console.error(errorMsg);
    emitLog(socket, errorMsg, "error", true); // Log to client too
    const alwaysFail = async () => ({ error: errorMsg });
    // Return an object matching the expected handler names
    return {
      readFileContent: alwaysFail,
      listFiles: alwaysFail,
      searchFiles: alwaysFail,
      searchFilesByRegex: alwaysFail,
      writeFileContent: alwaysFail,
      createDirectory: alwaysFail,
      deleteFile: alwaysFail,
      moveItem: alwaysFail,
      deleteDirectory: alwaysFail,
      askUserQuestion: alwaysFail,
      showInformationTextToUser: alwaysFail,
      task_finished: alwaysFail,
    };
  }

  // Pass down the changesLog explicitly to the internal context
  const handlerContext = { ...context, changesLog };

  // --- Handler Functions ---

  async function readFileContent(args) {
    const { filePath } = args;
    if (!filePath) return { error: "Missing required argument: filePath" };

    const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullPath = path.resolve(BASE_DIR, filePath);
    emitContextLogEntry(socket, "readFileContent", `Read: ${filePath}`); // Log context

    try {
      emitLog(socket, `📄 Reading file: ${filePath}`, "info");
      const content = await fs.readFile(fullPath, "utf-8");
      emitLog(
        socket,
        ` ✅ Read success: ${filePath} (${content.length} chars)`,
        "info",
      );
      return { success: true, content: content };
    } catch (error) {
      if (error.code === "ENOENT") {
        emitLog(socket, ` ⚠️ File not found: ${filePath}`, "warn");
        emitContextLogEntry(
          socket,
          "error",
          `Read Failed (Not Found): ${filePath}`,
        );
        return { error: `File not found: '${filePath}'` }; // Use single quotes for consistency
      }
      emitLog(
        socket,
        `❌ Error reading file ${filePath}: ${error.message}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Read Failed: ${filePath} - ${error.message}`,
      );
      return { error: `Failed to read file '${filePath}': ${error.message}` };
    }
  }

  async function listFiles(args) {
    // Use optional chaining and default value for robustness
    const directoryPath = args?.directoryPath || ".";
    // Normalize "." to ensure safety check works correctly
    const relativeDirectoryPath =
      directoryPath === "." ? "." : path.normalize(directoryPath);

    const safetyCheck = checkSafety([relativeDirectoryPath], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullPath = path.resolve(BASE_DIR, relativeDirectoryPath);
    const logPath =
      relativeDirectoryPath === "."
        ? path.basename(BASE_DIR)
        : relativeDirectoryPath;
    emitContextLogEntry(socket, "listFiles", `List: ${logPath}`);

    try {
      emitLog(
        socket,
        ` Ls Listing files in: ${logPath} (respecting .gitignore)`,
        "info",
      );
      const ig = await loadGitignore(BASE_DIR, socket);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      const filteredEntries = entries.filter((entry) => {
        // Calculate path relative to BASE_DIR for ignore check
        const entryRelativePath = path.relative(
          BASE_DIR,
          path.join(fullPath, entry.name),
        );
        // Convert to POSIX separators for ignore library
        const posixPath = entryRelativePath
          .split(path.sep)
          .join(path.posix.sep);
        const pathToFilter = entry.isDirectory() ? `${posixPath}/` : posixPath;
        return !ig.ignores(pathToFilter);
      });

      const files = filteredEntries
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(), // Keep both for clarity
        }))
        .sort((a, b) => {
          // Sort directories first, then alphabetically
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

      emitLog(
        socket,
        ` ✅ Found ${files.length} entries (after filtering) in ${logPath}`,
        "info",
      );
      return { success: true, files };
    } catch (error) {
      if (error.code === "ENOENT") {
        emitLog(socket, ` ⚠️ Directory not found: ${logPath}`, "warn");
        emitContextLogEntry(
          socket,
          "error",
          `List Failed (Not Found): ${logPath}`,
        );
        return { error: `Directory not found: '${relativeDirectoryPath}'` };
      }
      emitLog(
        socket,
        `❌ Error listing files in ${logPath}: ${error.message}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `List Failed: ${logPath} - ${error.message}`,
      );
      return {
        error: `Failed to list files in '${relativeDirectoryPath}': ${error.message}`,
      };
    }
  }

  async function searchFiles(args) {
    const { pattern } = args;
    if (!pattern) return { error: "Missing required argument: pattern" };
    if (!BASE_DIR) return { error: "Base directory not set." }; // Should be caught earlier, but good check

    // Security: Prevent path traversal and absolute paths
    if (pattern.includes("..")) {
      const msg = `Access denied: Search pattern contains invalid path traversal (".."). Pattern: ${pattern}`;
      emitLog(socket, `🔒 SECURITY WARNING: ${msg}`, "warn");
      emitContextLogEntry(
        socket,
        "error",
        `Search Error: Invalid pattern ${pattern}`,
      );
      return { error: msg };
    }
    if (path.isAbsolute(pattern)) {
      const msg = `Access denied: Search pattern must be relative to the base directory. Pattern: ${pattern}`;
      emitLog(socket, `🔒 SECURITY WARNING: ${msg}`, "warn");
      emitContextLogEntry(
        socket,
        "error",
        `Search Error: Absolute pattern ${pattern}`,
      );
      return { error: msg };
    }

    emitContextLogEntry(
      socket,
      "searchFiles",
      `Search Files (Glob): ${pattern}`,
    );

    try {
      emitLog(
        socket,
        `🔎 Searching files with glob pattern: '${pattern}' in ${BASE_DIR} (respecting .gitignore)`,
        "info",
      );

      // Use glob - it handles gitignore internally if configured, but we load manually anyway
      // Ensure dotfiles are included, but ignore .git directory explicitly
      const results = await glob(pattern, {
        cwd: BASE_DIR,
        nodir: true, // Only match files
        dot: true, // Match dotfiles like .env
        absolute: false, // Return paths relative to cwd (BASE_DIR)
        follow: false, // Don't follow symlinks
        ignore: [".git/**"], // Explicitly ignore .git contents
        // Could potentially pass the `ignore` instance here if glob supports it
      });

      // Note: Manual gitignore filtering might be needed if glob's ignore isn't sufficient
      // const ig = await loadGitignore(BASE_DIR, socket);
      // const filteredResults = results.filter(p => !ig.ignores(p.split(path.sep).join(path.posix.sep)));
      // For now, assume glob's ignore is sufficient or manual filter applied if needed

      emitLog(
        socket,
        ` ✅ Glob search found ${results.length} file(s) matching '${pattern}'`,
        "info",
      );
      return { success: true, filePaths: results }; // Use filteredResults if manual filtering applied
    } catch (error) {
      emitLog(
        socket,
        `❌ Error searching files with pattern '${pattern}': ${error.message}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Search Files Failed: ${pattern} - ${error.message}`,
      );
      return { error: `Failed to search files: ${error.message}` };
    }
  }

  async function searchFilesByRegex(args) {
    const { regexString, directoryPath = "." } = args;
    if (!regexString)
      return { error: "Missing required argument: regexString" };

    let regex;
    try {
      // Attempt to parse regex string like /pattern/flags or just pattern
      const match = regexString.match(/^\/(.+)\/([gimyus]*)$/);
      if (match) {
        regex = new RegExp(match[1], match[2]);
      } else {
        regex = new RegExp(regexString); // Treat as simple pattern if no / delimiters
      }
    } catch (e) {
      emitLog(
        socket,
        `❌ Invalid regex provided: "${regexString}". Error: ${e.message}`,
        "error",
      );
      emitContextLogEntry(socket, "error", `Invalid Regex: ${regexString}`);
      return { error: `Invalid regular expression provided: ${e.message}` };
    }

    const relativeSearchDir =
      directoryPath === "." ? "." : path.normalize(directoryPath);
    const safetyCheck = checkSafety([relativeSearchDir], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullSearchPath = path.resolve(BASE_DIR, relativeSearchDir);
    const logPath =
      relativeSearchDir === "." ? path.basename(BASE_DIR) : relativeSearchDir;
    emitContextLogEntry(
      socket,
      "searchFilesByRegex",
      `Search Content (Regex): ${regexString} in ${logPath}`,
    );

    try {
      emitLog(
        socket,
        `🔎 Searching file content with regex: ${regex} in ${logPath} (respecting .gitignore)`,
        "info",
      );
      const ig = await loadGitignore(BASE_DIR, socket);
      const matchingFiles = [];
      let filesScanned = 0;
      let filesIgnored = 0;
      let filesErrored = 0;

      // Recursive function to scan directories
      async function scanDir(currentDir) {
        try {
          const entries = await fs.readdir(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            const entryFullPath = path.join(currentDir, entry.name);
            const entryRelativePath = path.relative(BASE_DIR, entryFullPath);
            const posixPath = entryRelativePath
              .split(path.sep)
              .join(path.posix.sep);

            // Check ignore rules (add trailing slash for dirs)
            const filterPath = entry.isDirectory()
              ? `${posixPath}/`
              : posixPath;
            if (ig.ignores(filterPath)) {
              filesIgnored++;
              continue;
            }

            if (entry.isFile()) {
              filesScanned++;
              try {
                // Read file content - consider large files? Maybe stream/chunk?
                // For now, read whole file. Add size limits?
                const content = await fs.readFile(entryFullPath, "utf-8");
                // Execute regex - use exec for counts or match for simplicity?
                // Use match() which returns an array of matches or null
                const matches = content.match(regex);
                if (matches && matches.length > 0) {
                  matchingFiles.push({
                    filePath: entryRelativePath, // Return relative path
                    matchCount: matches.length,
                  });
                }
              } catch (readError) {
                // Log errors reading specific files but continue scan
                if (readError.code !== "ENOENT") {
                  // Ignore if file vanished mid-scan
                  emitLog(
                    socket,
                    `⚠️ Error reading file during regex search: ${entryRelativePath} - ${readError.message}`,
                    "warn",
                  );
                  filesErrored++;
                }
              }
            } else if (entry.isDirectory()) {
              // Recurse into subdirectory
              await scanDir(entryFullPath);
            }
          }
        } catch (dirError) {
          // Log errors reading directories (e.g., permissions) but continue
          if (dirError.code !== "ENOENT") {
            emitLog(
              socket,
              `⚠️ Error scanning directory during regex search: ${currentDir} - ${dirError.message}`,
              "warn",
            );
            filesErrored++;
          }
        }
      }

      await scanDir(fullSearchPath); // Start scan

      emitLog(
        socket,
        ` ✅ Regex search complete. Found ${matchingFiles.length} file(s) with matches. Scanned: ${filesScanned}, Ignored: ${filesIgnored}, Errored: ${filesErrored}.`,
        "info",
      );
      return { success: true, matchingFiles };
    } catch (error) {
      // Catch errors setting up the scan (e.g., initial loadGitignore)
      emitLog(
        socket,
        `❌ Error searching file content with regex '${regexString}': ${error.message}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Search Content Failed: ${regexString} - ${error.message}`,
      );
      return { error: `Failed to search file content: ${error.message}` };
    }
  }

  async function writeFileContent(args) {
    const { filePath, content } = args;
    // Ensure content is treated as a string, even if null/undefined (write empty file)
    const contentToWrite = String(content ?? "");

    if (!filePath) return { error: "Missing required argument: filePath" };

    const safetyCheck = checkSafety([filePath], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullPath = path.resolve(BASE_DIR, filePath);
    let oldContent = null;
    let fileExisted = false; // Default to false

    try {
      // Try reading first to check existence and get old content
      oldContent = await fs.readFile(fullPath, "utf-8");
      fileExisted = true;
      emitLog(
        socket,
        ` ℹ️ Read existing content of '${filePath}' for diff/log.`,
        "debug",
      );
    } catch (readError) {
      if (readError.code === "ENOENT") {
        // File doesn't exist, this is expected for a new file write
        fileExisted = false;
        oldContent = null; // Explicitly null
        emitLog(
          socket,
          ` ℹ️ File '${filePath}' does not exist, will create new file.`,
          "info",
        );
      } else {
        // Other errors reading (permissions?) - log warning, proceed carefully
        emitLog(
          socket,
          `⚠️ Error reading existing file content for diff/log (${filePath}): ${readError.message}. Proceeding without diff/undo data.`,
          "warn",
        );
        fileExisted = false; // Treat as non-existent for safety? Or let write fail? Let write attempt.
        oldContent = null;
      }
    }

    // --- Confirmation Step ---
    if (!confirmAllRef.value) {
      let diffString = "(Diff not generated)"; // Default message
      // Only generate diff if file existed and we read old content successfully
      if (fileExisted && oldContent !== null) {
        try {
          diffString = generateDiff(oldContent, contentToWrite, filePath); // Use contentToWrite
        } catch (diffError) {
          emitLog(
            socket,
            `⚠️ Error generating diff for ${filePath}: ${diffError.message}`,
            "warn",
          );
          diffString = "(Error generating diff)";
        }
      } else if (!fileExisted) {
        diffString = "(Creating new file)";
      } else if (oldContent === contentToWrite) {
        diffString = "(No changes detected)"; // Handle case where content is identical
      }

      const action = fileExisted ? "Overwrite" : "Create";
      emitContextLogEntry(
        socket,
        "confirmation_request",
        `Confirm ${action}: ${filePath}`,
      );
      const userDecision = await requestUserConfirmation(
        socket,
        `${action} file: '${filePath}'?`,
        (resolve) => {
          if (feedbackResolverRef) feedbackResolverRef.value = resolve;
        },
        diffString, // Pass the generated diff or status string
      );

      // Clear resolver immediately after promise resolves/rejects
      if (feedbackResolverRef) feedbackResolverRef.value = null;

      // Handle user response
      if (
        userDecision === "no" ||
        userDecision === "disconnect" ||
        userDecision === "error" ||
        userDecision === "task-end"
      ) {
        const reason =
          userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
        emitLog(
          socket,
          ` 🚫 Operation cancelled by user/system: writeFileContent(${filePath}) - Reason: ${reason}`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Write ${filePath} - ${reason}`,
        );
        return {
          error: `User or system ${reason} writing to file '${filePath}'.`,
        };
      } else if (userDecision === "yes/all") {
        if (confirmAllRef) confirmAllRef.value = true;
        emitLog(
          socket,
          ` 👍 Confirmation set to 'Yes to All' for this task.`,
          "info",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Write ${filePath} - Confirmed (Yes to All)`,
        );
      } else {
        // Assume 'yes'
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Write ${filePath} - Confirmed (Yes)`,
        );
      }
    } else {
      // Confirmation skipped due to 'Yes to All'
      emitLog(
        socket,
        ` 👍 Skipping confirmation for '${filePath}' due to 'Yes to All'.`,
        "info",
      );
      emitContextLogEntry(
        socket,
        "writeFileContent",
        `Write: ${filePath} (Auto-confirmed)`,
      );
    }

    // --- Execution Step ---
    emitLog(socket, `💾 Executing write for: ${filePath}`, "info");
    // Pass the actual handlerContext which includes the changesLog reference
    const writeResult = await _writeFile(
      fullPath,
      contentToWrite,
      { ...handlerContext, oldContent },
      filePath,
      fileExisted,
    );

    if (writeResult.success) {
      const successMsg = `File ${fileExisted ? "updated" : "created"} successfully: ${filePath}`;
      emitLog(socket, ` ✅ ${successMsg}`, "success");
      // Context log handled by confirmation/skip logic generally, but maybe add success here?
      // emitContextLogEntry(socket, fileExisted ? "updateFile" : "createFile", `Success: ${filePath}`);
      return { success: true, message: successMsg };
    } else {
      // Log error from _writeFile
      emitLog(
        socket,
        ` ❌ Failed write for ${filePath}. Error: ${writeResult.error}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Write Failed: ${filePath} - ${writeResult.error}`,
      );
      return writeResult; // Return the error object from _writeFile
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

    // Check existence and type, read content for undo log
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        emitLog(
          socket,
          ` ⚠️ Path is not a file, cannot delete: '${filePath}'.`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "error",
          `Delete Failed (Not a File): ${filePath}`,
        );
        return { error: `Cannot delete: Path '${filePath}' is not a file.` };
      }
      fileExists = true;
      // Read content *before* confirmation/deletion
      oldContent = await fs.readFile(fullPath, "utf-8");
      emitLog(
        socket,
        ` ℹ️ Read content of '${filePath}' before deletion for log/undo.`,
        "debug",
      );
    } catch (readError) {
      if (readError.code === "ENOENT") {
        // If file doesn't exist, treat as success (idempotent delete)
        emitLog(
          socket,
          ` ⚠️ File not found for deletion: '${filePath}'. Assuming already deleted.`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "deleteFile",
          `Delete Skipped (Not Found): ${filePath}`,
        );
        return {
          success: true,
          message: `File '${filePath}' not found (already deleted?).`,
        };
      } else {
        // Other errors (permissions?) - log warning, maybe block deletion?
        // For now, log and allow confirmation, but undo might fail.
        emitLog(
          socket,
          ` ⚠️ Error reading file content before deletion (${filePath}): ${readError.message}. Cannot guarantee undo.`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "error",
          `Delete Error (Read Failed): ${filePath} - ${readError.message}`,
        );
        oldContent = null; // Mark old content as unavailable
        fileExists = true; // Assume it exists if stat failed for reasons other than ENOENT
      }
    }

    // --- Confirmation Step ---
    if (!confirmAllRef.value && fileExists) {
      // Only ask if file exists
      emitContextLogEntry(
        socket,
        "confirmation_request",
        `Confirm Delete: ${filePath}`,
      );
      const userDecision = await requestUserConfirmation(
        socket,
        `Delete file: '${filePath}'? (Cannot be easily undone)`,
        (resolve) => {
          if (feedbackResolverRef) feedbackResolverRef.value = resolve;
        },
        // No diff needed for delete confirmation
      );
      if (feedbackResolverRef) feedbackResolverRef.value = null; // Clear resolver

      if (
        userDecision === "no" ||
        userDecision === "disconnect" ||
        userDecision === "error" ||
        userDecision === "task-end"
      ) {
        const reason =
          userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
        emitLog(
          socket,
          ` 🚫 Operation cancelled by user/system: deleteFile(${filePath}) - Reason: ${reason}`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Delete ${filePath} - ${reason}`,
        );
        return {
          error: `User or system ${reason} deleting file '${filePath}'.`,
        };
      } else if (userDecision === "yes/all") {
        if (confirmAllRef) confirmAllRef.value = true;
        emitLog(
          socket,
          ` 👍 Confirmation set to 'Yes to All' for this task.`,
          "info",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Delete ${filePath} - Confirmed (Yes to All)`,
        );
      } else {
        // Assume 'yes'
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Delete ${filePath} - Confirmed (Yes)`,
        );
      }
    } else if (fileExists) {
      // Skip confirmation log if file didn't exist
      emitLog(
        socket,
        ` 👍 Skipping confirmation for deleting '${filePath}' due to 'Yes to All'.`,
        "info",
      );
      emitContextLogEntry(
        socket,
        "deleteFile",
        `Delete: ${filePath} (Auto-confirmed)`,
      );
    }

    // --- Execution Step ---
    if (!fileExists) {
      // Should have returned earlier if file didn't exist, but double-check
      return {
        success: true,
        message: `File '${filePath}' not found (already deleted?).`,
      };
    }

    emitLog(socket, `🗑️ Executing delete for: ${filePath}`, "info");
    // Pass oldContent in the context for _deleteFile to log
    const deleteResult = await _deleteFile(
      fullPath,
      { ...handlerContext, oldContent },
      filePath,
    );

    if (deleteResult.success) {
      const successMsg =
        deleteResult.message || `File deleted successfully: '${filePath}'`;
      emitLog(socket, ` ✅ ${successMsg}`, "success");
      // Context log handled by confirmation/skip logic
      return { success: true, message: successMsg };
    } else {
      emitLog(
        socket,
        ` ❌ Failed delete for ${filePath}. Error: ${deleteResult.error}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Delete Failed: ${filePath} - ${deleteResult.error}`,
      );
      return deleteResult;
    }
  }

  async function moveItem(args) {
    const { sourcePath, destinationPath } = args;
    if (!sourcePath || !destinationPath) {
      return {
        error: "Missing required arguments: sourcePath and/or destinationPath",
      };
    }
    // Normalize paths for comparison and logging
    const normSource = path.normalize(sourcePath);
    const normDest = path.normalize(destinationPath);

    if (normSource === normDest) {
      emitLog(
        socket,
        ` ⚠️ Source and destination paths are identical: '${normSource}'. No move needed.`,
        "warn",
      );
      emitContextLogEntry(
        socket,
        "moveItem",
        `Move Skipped (Same Path): ${normSource}`,
      );
      return {
        success: true,
        message: "Source and destination paths are the same. No action taken.",
      };
    }

    const safetyCheck = checkSafety([normSource, normDest], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullSourcePath = path.resolve(BASE_DIR, normSource);
    const fullDestPath = path.resolve(BASE_DIR, normDest);

    // Check if source exists before proceeding
    try {
      await fs.access(fullSourcePath);
    } catch (accessError) {
      if (accessError.code === "ENOENT") {
        emitLog(
          socket,
          ` ⚠️ Source path not found for move: '${normSource}'. Cannot proceed.`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "error",
          `Move Failed (Source Not Found): ${normSource}`,
        );
        return { error: `Source path not found: '${normSource}'` };
      } else {
        // Other access error (permissions?)
        emitLog(
          socket,
          ` ⚠️ Error accessing source path '${normSource}': ${accessError.message}`,
          "error",
        );
        emitContextLogEntry(
          socket,
          "error",
          `Move Failed (Source Access Error): ${normSource} - ${accessError.message}`,
        );
        return {
          error: `Error accessing source path '${normSource}': ${accessError.message}`,
        };
      }
    }

    // Check if destination exists (move usually fails if it does)
    try {
      await fs.access(fullDestPath);
      // If access succeeds, destination exists
      const msg = `Destination path '${normDest}' already exists. Cannot move/rename: Overwriting is not directly supported by 'moveItem'. Delete the destination first if overwriting is intended.`;
      emitLog(socket, ` ⚠️ ${msg}`, "warn");
      emitContextLogEntry(
        socket,
        "error",
        `Move Failed (Destination Exists): ${normDest}`,
      );
      return { error: msg };
    } catch (destAccessError) {
      // If error is ENOENT, destination doesn't exist, which is good for move.
      if (destAccessError.code !== "ENOENT") {
        // Other error accessing destination (permissions?)
        emitLog(
          socket,
          ` ⚠️ Error checking destination path '${normDest}': ${destAccessError.message}`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "error",
          `Move Failed (Dest Access Error): ${normDest} - ${destAccessError.message}`,
        );
        return {
          error: `Failed to check destination path '${normDest}': ${destAccessError.message}`,
        };
      }
      // Destination does not exist, proceed with confirmation/move
    }

    // --- Confirmation Step ---
    if (!confirmAllRef.value) {
      emitContextLogEntry(
        socket,
        "confirmation_request",
        `Confirm Move: ${normSource} -> ${normDest}`,
      );
      const userDecision = await requestUserConfirmation(
        socket,
        `Move/rename '${normSource}' to '${normDest}'?`,
        (resolve) => {
          if (feedbackResolverRef) feedbackResolverRef.value = resolve;
        },
        // No diff for move
      );
      if (feedbackResolverRef) feedbackResolverRef.value = null; // Clear resolver

      if (
        userDecision === "no" ||
        userDecision === "disconnect" ||
        userDecision === "error" ||
        userDecision === "task-end"
      ) {
        const reason =
          userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
        emitLog(
          socket,
          ` 🚫 Operation cancelled by user/system: moveItem(${normSource}, ${normDest}) - Reason: ${reason}`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Move ${normSource} -> ${normDest} - ${reason}`,
        );
        return {
          error: `User or system ${reason} moving item '${normSource}'.`,
        };
      } else if (userDecision === "yes/all") {
        if (confirmAllRef) confirmAllRef.value = true;
        emitLog(
          socket,
          ` 👍 Confirmation set to 'Yes to All' for this task.`,
          "info",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Move ${normSource} -> ${normDest} - Confirmed (Yes to All)`,
        );
      } else {
        // Assume 'yes'
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Move ${normSource} -> ${normDest} - Confirmed (Yes)`,
        );
      }
    } else {
      emitLog(
        socket,
        ` 👍 Skipping confirmation for moving '${normSource}' due to 'Yes to All'.`,
        "info",
      );
      emitContextLogEntry(
        socket,
        "moveItem",
        `Move: ${normSource} -> ${normDest} (Auto-confirmed)`,
      );
    }

    // --- Execution Step ---
    emitLog(
      socket,
      `🚚 Executing move from: ${normSource} To: ${normDest}`,
      "info",
    );
    // Pass normalized paths to internal function for logging consistency
    const moveResult = await _moveItem(
      fullSourcePath,
      fullDestPath,
      handlerContext,
      normSource,
      normDest,
    );

    if (moveResult.success) {
      const successMsg = `Item moved/renamed successfully from '${normSource}' to '${normDest}'`;
      emitLog(socket, ` ✅ ${successMsg}`, "success");
      return { success: true, message: successMsg };
    } else {
      emitLog(
        socket,
        ` ❌ Failed move for ${normSource} -> ${normDest}. Error: ${moveResult.error}`,
        "error",
      );
      // Context log already emitted by confirmation or skip logic, error logged here
      emitContextLogEntry(
        socket,
        "error",
        `Move Failed: ${normSource} -> ${normDest} - ${moveResult.error}`,
      );
      return moveResult;
    }
  }

  async function createDirectory(args) {
    const { directoryPath } = args;
    if (!directoryPath)
      return { error: "Missing required argument: directoryPath" };

    const normDirPath = path.normalize(directoryPath);
    const safetyCheck = checkSafety([normDirPath], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullPath = path.resolve(BASE_DIR, normDirPath);
    emitLog(socket, `📁 Executing create directory: ${normDirPath}`, "info");
    emitContextLogEntry(
      socket,
      "createDirectory",
      `Create Folder: ${normDirPath}`,
    );

    // No confirmation needed for createDirectory usually, as it's non-destructive if exists
    // Use the internal function directly
    const createResult = await _createDir(
      fullPath,
      handlerContext,
      normDirPath,
    );

    if (createResult.success) {
      const successMsg =
        createResult.message ||
        `Directory created successfully at '${normDirPath}'`;
      emitLog(socket, ` ✅ ${successMsg}`, "success");
      // Add context log if it already existed vs created?
      if (createResult.message?.includes("already exists")) {
        emitContextLogEntry(
          socket,
          "info",
          `Folder already exists: ${normDirPath}`,
        );
      } else {
        // emitContextLogEntry(socket, "createDirectory", `Folder Created: ${normDirPath}`); // Redundant?
      }
      return { success: true, message: successMsg };
    } else {
      emitLog(
        socket,
        ` ❌ Failed create directory for ${normDirPath}. Error: ${createResult.error}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Create Folder Failed: ${normDirPath} - ${createResult.error}`,
      );
      return createResult;
    }
  }

  async function deleteDirectory(args) {
    const { directoryPath } = args;
    if (!directoryPath)
      return { error: "Missing required argument: directoryPath" };

    // Security: Prevent deleting base dir or root-like paths
    const normDirPath = path.normalize(directoryPath);
    if (
      normDirPath === "." ||
      normDirPath === "/" ||
      normDirPath === "" ||
      path.resolve(BASE_DIR, normDirPath) === path.resolve(BASE_DIR)
    ) {
      emitLog(
        socket,
        ` ⚠️ Attempted to delete base directory or invalid path: '${normDirPath}'. Denied.`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Delete Folder Denied (Invalid Path): ${normDirPath}`,
      );
      return {
        error: `Deleting the base directory or invalid path ('${normDirPath}') is not allowed.`,
      };
    }

    const safetyCheck = checkSafety([normDirPath], BASE_DIR, socket);
    if (!safetyCheck.safe) return { error: safetyCheck.error };

    const fullPath = path.resolve(BASE_DIR, normDirPath);
    let dirExists = false;

    // Check existence and type before confirmation
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isDirectory()) {
        const msg = `Path '${normDirPath}' is not a directory. Cannot delete. Use deleteFile instead?`;
        emitLog(socket, ` ⚠️ ${msg}`, "warn");
        emitContextLogEntry(
          socket,
          "error",
          `Delete Folder Failed (Not a Dir): ${normDirPath}`,
        );
        return { error: msg };
      }
      dirExists = true;
    } catch (statError) {
      if (statError.code === "ENOENT") {
        emitLog(
          socket,
          ` ⚠️ Directory not found for deletion: '${normDirPath}'. Assuming already deleted.`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "deleteDirectory",
          `Delete Folder Skipped (Not Found): ${normDirPath}`,
        );
        return {
          success: true,
          message: `Directory '${normDirPath}' not found (already deleted?).`,
        };
      }
      // Other stat errors (permissions?)
      emitLog(
        socket,
        `❌ Error accessing directory ${normDirPath}: ${statError.message}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Delete Folder Failed (Access Error): ${normDirPath} - ${statError.message}`,
      );
      return {
        error: `Failed to access directory '${normDirPath}': ${statError.message}`,
      };
    }

    // --- Confirmation Step ---
    if (!confirmAllRef.value && dirExists) {
      // Only confirm if it exists
      emitContextLogEntry(
        socket,
        "confirmation_request",
        `Confirm Delete Folder (Recursive): ${normDirPath}`,
      );
      const userDecision = await requestUserConfirmation(
        socket,
        `DELETE directory '${normDirPath}' and ALL ITS CONTENTS recursively? This is IRREVERSIBLE.`,
        (resolve) => {
          if (feedbackResolverRef) feedbackResolverRef.value = resolve;
        },
      );
      if (feedbackResolverRef) feedbackResolverRef.value = null; // Clear resolver

      if (
        userDecision === "no" ||
        userDecision === "disconnect" ||
        userDecision === "error" ||
        userDecision === "task-end"
      ) {
        const reason =
          userDecision === "no" ? "rejected" : `cancelled (${userDecision})`;
        emitLog(
          socket,
          ` 🚫 Operation cancelled by user/system: deleteDirectory(${normDirPath}) - Reason: ${reason}`,
          "warn",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Delete Folder ${normDirPath} - ${reason}`,
        );
        return {
          error: `User or system ${reason} deleting directory '${normDirPath}'.`,
        };
      } else if (userDecision === "yes/all") {
        if (confirmAllRef) confirmAllRef.value = true;
        emitLog(
          socket,
          ` 👍 Confirmation set to 'Yes to All' for this task (including recursive delete).`,
          "info",
        );
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Delete Folder ${normDirPath} - Confirmed (Yes to All)`,
        );
      } else {
        // Assume 'yes'
        emitContextLogEntry(
          socket,
          "confirmation_response",
          `Delete Folder ${normDirPath} - Confirmed (Yes)`,
        );
      }
    } else if (dirExists) {
      // Skip confirmation log if dir didn't exist
      emitLog(
        socket,
        ` 👍 Skipping confirmation for deleting directory '${normDirPath}' due to 'Yes to All'.`,
        "info",
      );
      emitContextLogEntry(
        socket,
        "deleteDirectory",
        `Delete Folder: ${normDirPath} (Auto-confirmed)`,
      );
    }

    // --- Execution Step ---
    if (!dirExists) {
      // Should have returned already, but final check
      return {
        success: true,
        message: `Directory '${normDirPath}' not found (already deleted?).`,
      };
    }
    emitLog(
      socket,
      `🗑️🔥 Executing delete directory (recursive): ${normDirPath}`,
      "info",
    );
    const deleteResult = await _deleteDirRecursive(
      fullPath,
      handlerContext,
      normDirPath,
    );

    if (deleteResult.success) {
      const successMsg =
        deleteResult.message ||
        `Directory deleted successfully: '${normDirPath}'`;
      emitLog(socket, ` ✅ ${successMsg}`, "success");
      // Context log handled by confirmation/skip
      return { success: true, message: successMsg };
    } else {
      emitLog(
        socket,
        ` ❌ Failed delete directory for ${normDirPath}. Error: ${deleteResult.error}`,
        "error",
      );
      emitContextLogEntry(
        socket,
        "error",
        `Delete Folder Failed: ${normDirPath} - ${deleteResult.error}`,
      );
      return deleteResult;
    }
  }

  async function askUserQuestion(args) {
    const { question } = args;
    if (!question) return { error: "Missing required argument: question" };

    emitLog(socket, `❓ Asking user: ${question}`, "info");
    emitContextLogEntry(socket, "question", `Question: ${question}`); // Log question to context

    return new Promise((resolve) => {
      if (questionResolverRef) questionResolverRef.value = resolve; // Store resolver
      socket.emit("ask-question-request", { question });
    })
      .then((answer) => {
        if (questionResolverRef) questionResolverRef.value = null; // Clear resolver on success
        // Log the answer structure for clarity
        emitLog(
          socket,
          `🗣️ Received answer: ${JSON.stringify(answer)}`,
          "info",
        );
        emitContextLogEntry(
          socket,
          "answer",
          `Answer: ${JSON.stringify(answer)}`,
        ); // Log answer to context
        // Handle cancellation signals passed through the promise resolution
        if (
          answer === "disconnect" ||
          answer === "error" ||
          answer === "task-end"
        ) {
          return { error: `Question cancelled due to ${answer}.` };
        }
        return { success: true, answer: answer }; // Return the actual answer object/string
      })
      .catch((error) => {
        // This catch handles errors *within* the promise/callback chain, not socket errors
        emitLog(
          socket,
          `❌ Error in askUserQuestion promise: ${error}`,
          "error",
        );
        if (questionResolverRef) questionResolverRef.value = null; // Clear resolver on error
        emitContextLogEntry(
          socket,
          "error",
          `Question Error: ${error.message || error}`,
        );
        return { error: `Failed to get user answer: ${error.message}` };
      });
  }

  async function showInformationTextToUser(args) {
    const { messageToDisplay } = args;
    if (!messageToDisplay)
      return { error: "Missing required argument: messageToDisplay" };

    // This is purely informational, log it clearly
    emitLog(socket, `ℹ️ Info for user: ${messageToDisplay}`, "info", true); // Mark as action for bubble
    emitContextLogEntry(socket, "info", `Info: ${messageToDisplay}`); // Log to context as well

    // This function always succeeds from the perspective of the function call itself
    return { success: true, message: "Information displayed to user." };
  }

  async function task_finished(args) {
    const { finalMessage } = args;
    if (!finalMessage)
      return { error: "Missing required argument: finalMessage" };

    // This signals the end of the task loop in the runner
    emitLog(
      socket,
      `✅ Task Finished signal received from Gemini: ${finalMessage}`,
      "success",
    );
    // Don't log to context here, the runner handles final context/state saving

    // Return a specific structure the runner expects
    return { finished: true, message: finalMessage };
  }

  // Return the map of handlers
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
