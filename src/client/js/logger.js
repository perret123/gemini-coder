// c:\dev\gemini-coder\src\client\js\logger.js
// Modify the function signature to accept isAction (defaulting to false)
function addLogMessage(message, type = 'info', isAction = false) {
    const logOutput = document.getElementById('logOutput');
    const logContainer = document.getElementById('logContainer');
    if (!logOutput || !logContainer) {
        console.error("Log output elements ('logOutput', 'logContainer') not found in the DOM.");
        alert(`Log [${type}]: ${message}`);
        return;
    }

    const logEntry = document.createElement('div');
    // Add the base class and type-specific class
    logEntry.className = `log-entry log-${type}`;

    // Add the action bubble class if applicable
    if (isAction && type !== 'diff') { // Don't make diffs standard bubbles
        logEntry.classList.add('log-action-bubble');
    }

    if (type === 'diff') {
        // --- Keep the existing diff handling logic ---
        logEntry.classList.add('log-diff'); // Add specific class for easier targeting if needed
        const pre = document.createElement('pre');
        const lines = message.split(/\r?\n/);
        // ... (rest of the diff parsing logic remains the same) ...
         let hasContent = false;
        lines.forEach(line => {
            const span = document.createElement('span');
            const trimmedLine = line.trim();
            // Simple heuristic: Check first char for diff type
            if (line.startsWith('+ ')) {
                span.className = 'diff-added';
                span.textContent = line;
                hasContent = true;
            } else if (line.startsWith('- ')) {
                span.className = 'diff-removed';
                span.textContent = line;
                hasContent = true;
            } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
                 // Diff header/context lines - styled subtly or omitted visually
                 // Optionally add a class if specific styling is needed:
                 // span.className = 'diff-header';
                 span.textContent = line; // Still include for completeness
                 // Optionally skip adding header lines to pre if desired:
                 // return;
                 hasContent = true; // Consider header lines as content for display
            } else if (trimmedLine === '' && !hasContent) {
                // Don't start with an empty line if no diff content yet
                return;
            } else {
                // Treat other lines as context
                span.className = 'diff-context';
                span.textContent = line;
                hasContent = true;
            }
            pre.appendChild(span);
        });

        if (pre.hasChildNodes() && hasContent) {
            logEntry.appendChild(pre);
        } else {
             // Handle cases where the diff message might not contain actual changes
             // or isn't formatted as expected (e.g., empty diff, simple message)
             const trimmedMessage = message.trim();
             if (trimmedMessage !== '' && trimmedMessage !== '(No changes)') {
                 // Render non-diff content within a pre for consistency if it wasn't empty
                 const preFallback = document.createElement('pre');
                 preFallback.textContent = message;
                 logEntry.appendChild(preFallback);
             } else {
                 // Don't add empty or "(No changes)" diff logs
                return;
             }
        }
    } else {
        // For non-diff types, just set text content
        logEntry.textContent = message;
    }

    // Append only if there's content (text or diff spans)
    if (logEntry.textContent || logEntry.querySelector('pre > span')) {
        logOutput.appendChild(logEntry);
        // Scroll to bottom
        requestAnimationFrame(() => {
            logContainer.scrollTop = logContainer.scrollHeight;
        });
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { addLogMessage };
  }