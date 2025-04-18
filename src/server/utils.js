/**
 * @fileoverview Utility functions for the Gemini Coder server, including logging,
 * context updates, diff generation, user interaction prompts, and path safety checks.
 * @module src/server/utils
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createPatch } from "diff"; // Assuming 'diff' package supports ES module import or has type definitions

/**
 * @typedef {object} LogPayload
 * @property {string} message - The log message content.
 * @property {string} type - The type of log message (e.g., 'info', 'error', 'warn', 'debug', 'confirm', 'diff').
 * @property {boolean} isAction - Whether the log represents a distinct action (for UI styling).
 * @property {string} timestamp - ISO timestamp string.
 */

/**
 * @typedef {object} ContextEntry
 * @property {string} type - The type of context entry (e.g., 'initial_prompt', 'writeFileContent', 'error').
 * @property {string} text - The textual description of the context entry.
 */

/**
 * @typedef {object} FullContextPayload
 * @property {ContextEntry[]} changes - An array of all current context entries.
 */

/**
 * @typedef {object} ConfirmationRequestPayload
 * @property {string} message - The confirmation message to display to the user.
 * @property {string|null} [diff] - Optional diff string to display alongside the confirmation.
 */

/**
 * @typedef {'yes' | 'no' | 'yes/all' | 'disconnect' | 'error' | 'task-end'} UserConfirmationDecision
 * The possible decisions a user can make in response to a confirmation request,
 * or system-generated signals like disconnect/error.
 */

/**
 * @typedef {object} SafetyCheckResult
 * @property {boolean} safe - Whether all checked paths are safe (within the base directory).
 * @property {string} [error] - An error message if any path is unsafe.
 */

/**
 * Emits a log message to both the server console and the connected client socket.
 * Console logs respect the DEBUG_LOGGING environment variable.
 *
 * @param {Socket | null} socketInstance - The Socket.IO client instance. Can be null if logging only to console.
 * @param {string} message - The message to log.
 * @param {string} [type='info'] - The type of log message (e.g., 'info', 'error', 'warn', 'debug').
 * @param {boolean} [isAction=false] - Whether the log represents a distinct action (for UI styling).
 */
export function emitLog(
  socketInstance,
  message,
  type = "info",
  isAction = false,
) {
  const timestamp = new Date().toISOString(); // Use ISO format for consistency
  const logPrefix = `[${new Date(timestamp).toLocaleTimeString("en-US", { hour12: false })}] [${type.toUpperCase()}]`;

  // Console logging (respect DEBUG_LOGGING)
  if (type !== "debug" || process.env.DEBUG_LOGGING === "true") {
    const consoleMethod =
      type === "error"
        ? console.error
        : type === "warn"
          ? console.warn
          : console.log;
    const lines = String(message).split("\n");
    if (lines.length > 1) {
      consoleMethod(`${logPrefix} ${lines[0]}`);
      for (let i = 1; i < lines.length; i++) {
        // Ensure consistent spacing for multi-line logs
        consoleMethod(`  ${" ".repeat(logPrefix.length - 2)} ${lines[i]}`);
      }
    } else {
      consoleMethod(`${logPrefix} ${message}`);
    }
  }

  // Socket emission
  if (socketInstance && socketInstance.connected) {
    try {
      /** @type {LogPayload} */
      const payload = { message: String(message), type, isAction, timestamp };
      socketInstance.emit("log", payload);
    } catch (emitError) {
      // Log emission errors cautiously to avoid loops
      console.warn(
        `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] [WARN] Failed to emit log to socket ${socketInstance.id}: ${emitError.message}`,
      );
    }
  } else if (socketInstance && !socketInstance.connected) {
    // Optionally log that the socket was disconnected if trying to emit
    // console.debug(`[${timestamp}] [DEBUG] Socket ${socketInstance.id} disconnected, log not sent: ${String(message).substring(0, 50)}...`);
  }
}

/**
 * Emits a context update payload to the client. Used for sending either
 * a single entry or the full context state.
 *
 * @deprecated Use emitContextLogEntry or emitFullContextUpdate instead for clarity.
 * @param {Socket} socketInstance - The Socket.IO client instance.
 * @param {ContextEntry | FullContextPayload} contextData - The context data payload.
 */
export function emitContextLog(socketInstance, contextData) {
  if (socketInstance && socketInstance.connected) {
    socketInstance.emit("context-update", contextData);
  }
}

/**
 * Emits a single context log entry to the client.
 *
 * @param {Socket} socketInstance - The Socket.IO client instance.
 * @param {string} type - The type of context entry (e.g., 'writeFileContent', 'error').
 * @param {string | any} text - The textual description of the context entry. Non-string values will be converted.
 */
export function emitContextLogEntry(socketInstance, type, text) {
  if (socketInstance && socketInstance.connected) {
    const entryText = String(text ?? "(No details provided)");
    /** @type {ContextEntry} */
    const payload = { type: String(type), text: entryText };
    socketInstance.emit("context-update", payload);
  }
}

/**
 * Emits the full current context state (array of changes) to the client.
 *
 * @param {Socket} socketInstance - The Socket.IO client instance.
 * @param {ContextEntry[]} changesArray - The complete array of context entries.
 */
export function emitFullContextUpdate(socketInstance, changesArray) {
  if (socketInstance && socketInstance.connected) {
    if (!Array.isArray(changesArray)) {
      // Use emitLog for server-side logging of this internal error
      emitLog(
        socketInstance,
        `emitFullContextUpdate ERROR: changesArray is not an array! Data: ${JSON.stringify(changesArray)}`,
        "error",
      );
      emitContextLogEntry(
        socketInstance,
        "error",
        "Internal Server Error: Invalid context data format.",
      );
      return;
    }
    /** @type {FullContextPayload} */
    const payload = { changes: changesArray };
    socketInstance.emit("context-update", payload);
  }
}

/**
 * Generates a unified diff patch string between old and new content.
 * Returns "(No changes)" if contents are identical or the diff is effectively empty.
 *
 * @param {string | null | undefined} oldContent - The original content.
 * @param {string | null | undefined} newContent - The modified content.
 * @param {string | undefined} filename - The filename to include in the diff header.
 * @returns {string} The generated diff string or "(No changes)" or "Error generating diff.".
 */
export function generateDiff(oldContent, newContent, filename) {
  const oldStr = oldContent || "";
  const newStr = newContent || "";

  if (oldStr === newStr) {
    return "(No changes)";
  }
  try {
    // Ensure filename is treated as a string
    const patch = createPatch(
      String(filename || "file"),
      oldStr,
      newStr,
      undefined, // oldHeader
      undefined, // newHeader
      { context: 3 }, // Number of context lines around changes
    );

    // Minimal diff format processing
    const lines = patch.split("\n");
    // Start from line 3 to skip the standard patch headers (---, +++) if present
    let startIndex = 0;
    if (lines[0]?.startsWith("---") && lines[1]?.startsWith("+++")) {
      startIndex = 2;
    }
    const relevantLines = lines
      .slice(startIndex)
      .filter((line) => line.trim() !== "\\ No newline at end of file"); // Remove Git specific line

    // If only context lines (starting with @@ or space) remain after filtering headers, consider it no changes
    if (
      !relevantLines.some(
        (line) => line.startsWith("+") || line.startsWith("-"),
      )
    ) {
      // Check if there are *any* lines left besides hunk headers (@@)
      if (relevantLines.filter((line) => !line.startsWith("@@")).length === 0) {
        return "(No changes)";
      }
    }

    // Reconstruct a minimal diff string for display
    let minimalDiff = "";
    if (startIndex === 2) {
      // Add back headers if they were sliced
      minimalDiff += lines[0] + "\n" + lines[1] + "\n";
    }
    minimalDiff += relevantLines.join("\n");

    // Return "(No changes)" if the filtering resulted in an empty string (unlikely but possible)
    return minimalDiff.trim() === "" ? "(No changes)" : minimalDiff;
  } catch (error) {
    console.error(`Error generating diff for ${filename}:`, error);
    emitLog(
      null,
      `Error generating diff for ${filename}: ${error.message}`,
      "error",
    ); // Log error to console
    return "Error generating diff.";
  }
}

/**
 * Sends a confirmation request to the client and returns a Promise that resolves
 * with the user's decision.
 *
 * @param {Socket} socketInstance - The Socket.IO client instance.
 * @param {string} message - The confirmation message.
 * @param {(resolve: (decision: UserConfirmationDecision) => void) => void} setResolverCallback - A function that takes the Promise's resolve function and stores it (e.g., in a ref) so it can be called later when the client responds.
 * @param {string | null} [diffData=null] - Optional diff string to display.
 * @returns {Promise<UserConfirmationDecision>} A Promise resolving with the user's decision.
 */
export function requestUserConfirmation(
  socketInstance,
  message,
  setResolverCallback,
  diffData = null,
) {
  return new Promise((resolve) => {
    // Store the resolve function using the provided callback mechanism
    setResolverCallback(resolve);

    /** @type {ConfirmationRequestPayload} */
    const payload = { message: String(message), diff: diffData };
    socketInstance.emit("confirmation-request", payload);
    emitLog(
      socketInstance,
      `⏳ Waiting for user confirmation: ${message}`,
      "confirm",
    );
    // Note: Timeout handling might be needed in the caller (e.g., geminiTaskRunner)
  });
}

/**
 * Checks if a given file path is safely within the specified base directory.
 * Prevents path traversal attacks (e.g., using "..").
 *
 * @param {string} filePath - The file path to check (can be relative or absolute).
 * @param {string} currentBaseDir - The absolute path of the allowed base directory.
 * @returns {boolean} True if the path is safe, false otherwise.
 */
export function isPathSafe(filePath, currentBaseDir) {
  if (!currentBaseDir || !filePath) {
    console.warn(
      `isPathSafe check failed: Missing baseDir ('${currentBaseDir}') or filePath ('${filePath}')`,
    );
    return false;
  }
  try {
    // Resolve the filePath relative to the baseDir to get an absolute path
    const resolvedPath = path.resolve(currentBaseDir, filePath);

    // Check if the resolved absolute path starts with the base directory path.
    // Add path.sep to ensure it's not just a prefix match (e.g., /base/dir vs /base/directory).
    // Also allow the path to be exactly the base directory itself.
    return (
      resolvedPath.startsWith(currentBaseDir + path.sep) ||
      resolvedPath === currentBaseDir
    );
  } catch (error) {
    // Handle potential errors during path resolution (e.g., invalid characters)
    console.error(
      `Error resolving path safety for "${filePath}" against "${currentBaseDir}":`,
      error,
    );
    return false;
  }
}

/**
 * Checks the safety of multiple file paths against the base directory.
 *
 * @param {string[]} paths - An array of file paths to check.
 * @param {string} currentBaseDir - The absolute path of the allowed base directory.
 * @param {Socket} socket - The client socket instance for logging.
 * @returns {SafetyCheckResult} An object indicating if all paths are safe and an error message if not.
 */
export function checkSafety(paths, currentBaseDir, socket) {
  if (!currentBaseDir) {
    const message = "Operation cannot proceed: Base directory is not defined.";
    emitLog(socket, `🔒 SECURITY ERROR: ${message}`, "error");
    emitContextLogEntry(
      socket,
      "error",
      `Security Error: Base directory not set.`,
    );
    return { safe: false, error: message };
  }

  const unsafePaths = paths.filter((p) => !isPathSafe(p, currentBaseDir));

  if (unsafePaths.length > 0) {
    const message = `Access denied: Path(s) are outside the allowed base directory ('${path.basename(currentBaseDir)}'). Unsafe paths: ${unsafePaths.join(", ")}`;
    emitLog(socket, `🔒 SECURITY WARNING: ${message}`, "warn");
    emitContextLogEntry(
      socket,
      "error",
      `Security Error: Path outside base directory (${unsafePaths.join(", ")})`,
    );
    return { safe: false, error: message };
  }

  return { safe: true };
}

/**
 * Recursively gets the directory structure as an array of strings,
 * respecting .gitignore rules and limiting depth.
 *
 * @param {string} dirPath - The absolute path of the directory to scan.
 * @param {string} baseDir - The absolute path of the root base directory for relative path calculation and ignore rules.
 * @param {import("ignore").Ignore} ig - An initialized 'ignore' instance.
 * @param {number} [maxDepth=2] - The maximum recursion depth.
 * @param {number} [currentDepth=0] - The current recursion depth (internal use).
 * @param {string} [indent=''] - The indentation string for formatting (internal use).
 * @returns {Promise<string[]>} A Promise resolving to an array of strings representing the directory structure.
 */
export async function getDirectoryStructure(
  dirPath,
  baseDir,
  ig,
  maxDepth = 2,
  currentDepth = 0,
  indent = "",
) {
  // Prevent infinite loops for excessive depth
  if (currentDepth > maxDepth) {
    // Check if the directory has any non-ignored children before adding [...]
    try {
      const entries = await fs.readdir(dirPath);
      const hasVisibleChildren = entries.some((entryName) => {
        const entryPath = path.join(dirPath, entryName);
        const relativePath = path.relative(baseDir, entryPath);
        // Convert to POSIX separators for ignore checking
        const posixRelativePath = relativePath
          .split(path.sep)
          .join(path.posix.sep);
        // Check both file and potential directory paths
        return (
          !ig.ignores(posixRelativePath) && !ig.ignores(posixRelativePath + "/")
        );
      });
      if (hasVisibleChildren) {
        return [`${indent}[...]`]; // Indicate truncated structure
      } else {
        return []; // No visible children, return empty
      }
    } catch (err) {
      // If readdir fails (e.g., permissions), return empty or indicate error?
      console.warn(
        `Could not check children of ${dirPath} at max depth: ${err.message}`,
      );
      return []; // Keep it simple, return empty
    }
  }

  /** @type {string[]} */
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
      const posixRelativePath = relativePath
        .split(path.sep)
        .join(path.posix.sep);

      // Determine path to check against .gitignore (add trailing slash for dirs)
      const pathToFilter = entry.isDirectory()
        ? `${posixRelativePath}/`
        : posixRelativePath;

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
          indent + "  ", // Use two spaces for clearer indentation
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
    const relativeDirPath = path.relative(baseDir, dirPath) || "."; // Handle base dir itself
    structure.push(
      `${indent}[Error reading content of ${relativeDirPath.split(path.sep).join(path.posix.sep)}]`,
    );
  }

  // Filter out empty lines which might occur if a directory read fails silently
  return structure.filter((line) => line.trim() !== "");
}
