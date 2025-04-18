// c:\dev\gemini-coder\src\client\js\logger.js

/**
 * Adds a log message to the log output area in the UI.
 * @param {string} message The message content.
 * @param {string} [type='info'] Type of message ('info', 'success', 'error', 'warn', 'confirm', 'diff', 'debug', etc.). Controls styling.
 * @param {boolean} [isAction=false] If true, wraps the message in an action bubble with a timestamp.
 */
export function addLogMessage(message, type = "info", isAction = false) {
  const logOutput = document.getElementById("logOutput");
  const logContainer = document.getElementById("logContainer"); // Needed for scrolling

  if (!logOutput || !logContainer) {
    console.error(
      "Log output elements ('logOutput', 'logContainer') not found in the DOM.",
    );
    // Fallback alert might be annoying, consider just console logging
    alert(`Log [${type}]: ${message}`);
    return;
  }

  const logEntry = document.createElement("div");
  logEntry.className = `log-entry log-${type}`; // Base classes

  // Add action bubble styling if requested and not a diff
  if (isAction && type !== "diff") {
    logEntry.classList.add("log-action-bubble");
  }

  // Create content span
  const contentSpan = document.createElement("span");
  contentSpan.className = "log-message-content";

  // Special handling for 'diff' type
  if (type === "diff") {
    logEntry.classList.add("log-diff");
    const pre = document.createElement("pre");
    const lines = message.split(/\r?\n/); // Handle both LF and CRLF
    let hasContent = false; // Track if any meaningful lines were added

    lines.forEach((line) => {
      const span = document.createElement("span");
      const trimmedLine = line.trim();

      if (line.startsWith("+ ")) {
        span.className = "diff-added";
        span.textContent = line;
        hasContent = true;
      } else if (line.startsWith(" - ")) {
        span.className = "diff-removed";
        span.textContent = line;
        hasContent = true;
      } else if (
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("@@")
      ) {
        span.className = "diff-header";
        span.textContent = line;
        hasContent = true;
      } else if (trimmedLine === "" && !hasContent) {
        // Skip leading blank lines in diffs if nothing else added yet
        return;
      } else {
        span.className = "diff-context";
        span.textContent = line;
        hasContent = true; // Mark context lines as content too
      }
      pre.appendChild(span);
    });

    // Only add the <pre> if it actually contains relevant lines
    if (pre.hasChildNodes() && hasContent) {
      contentSpan.appendChild(pre);
    } else {
      // Fallback for non-standard diffs or empty diffs (but not "(No changes)")
      const trimmedMessage = message.trim();
      if (trimmedMessage !== "" && trimmedMessage !== "(No changes)") {
        const preFallback = document.createElement("pre");
        preFallback.textContent = message;
        contentSpan.appendChild(preFallback);
      } else {
        // If the diff is literally empty or "(No changes)", don't add the log entry
        return;
      }
    }
  } else {
    // For non-diff types, just set text content
    contentSpan.textContent = message;
  }

  // Add timestamp for action bubbles
  if (isAction && type !== "diff") {
    const timeSpan = document.createElement("span");
    timeSpan.className = "log-timestamp";
    const now = new Date();
    timeSpan.textContent = now.toLocaleTimeString("en-US", { hour12: false }); // Consistent format
    logEntry.appendChild(timeSpan); // Add timestamp before content for bubble layout
  }

  logEntry.appendChild(contentSpan); // Add the main content

  // Only append if there's actual visible content
  if (
    contentSpan.textContent.trim() !== "" ||
    contentSpan.querySelector("pre > span")
  ) {
    logOutput.appendChild(logEntry);

    // Scroll to bottom using requestAnimationFrame for reliability
    requestAnimationFrame(() => {
      logContainer.scrollTop = logContainer.scrollHeight;
    });
  }
}

// No need for module.exports check
