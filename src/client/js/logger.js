/**
 * Adds a message to the log output area on the UI.
 * @param {string} message The message content.
 * @param {string} type The type of message ('info', 'success', 'error', 'warn', 'confirm', 'diff', 'gemini-req', 'gemini-resp', 'func-call', 'func-result', 'debug').
 */
function addLogMessage(message, type = 'info') {
    const logOutput = document.getElementById('logOutput');
    const logContainer = document.getElementById('logContainer'); // The scrollable container

    if (!logOutput || !logContainer) {
        console.error("Log output elements ('logOutput', 'logContainer') not found in the DOM.");
        // Fallback alert if logging UI isn't available
        alert(`Log [${type}]: ${message}`);
        return;
    }

    const logEntry = document.createElement('div');
    logEntry.className = `log-entry log-${type}`; // Add base class and type-specific class

    if (type === 'diff') {
        // Special handling for diff messages to preserve formatting and apply line styles
        const pre = document.createElement('pre');
        const lines = message.split(/\\r?\\n/); // Split message into lines

        lines.forEach(line => {
            // Skip adding empty lines if the message is just whitespace
            if (line.trim() === '' && lines.length === 1) return;

            const span = document.createElement('span');
            if (line.startsWith('+')) {
                span.className = 'diff-added';
                span.textContent = line;
            } else if (line.startsWith('-')) {
                span.className = 'diff-removed';
                span.textContent = line;
            } else {
                // Context lines, summaries, or other non-diff parts
                span.className = 'diff-context';
                span.textContent = line;
            }
            pre.appendChild(span);
            pre.appendChild(document.createTextNode('\\n')); // Add newline after each span
        });

        // Remove the trailing newline text node if it exists
        if (pre.lastChild && pre.lastChild.nodeType === Node.TEXT_NODE && pre.lastChild.textContent === '\\n') {
            pre.removeChild(pre.lastChild);
        }

        // Only append the <pre> block if it contains actual diff spans
        if (pre.hasChildNodes()) {
             logEntry.appendChild(pre);
        } else {
            // If diff resulted in empty <pre> (e.g., only '(No changes)' summary)
            // display the original message directly if it's not just whitespace.
            const trimmedMessage = message.trim();
            if (trimmedMessage !== '') {
                 // Avoid logging just '(No changes)' in a non-diff format if that's the whole message
                if (trimmedMessage !== '(No changes)') {
                    logEntry.textContent = message; // Show summary or truncated notice directly
                } else {
                    // Optionally explicitly log 'No changes' differently or skip
                    // logEntry.textContent = '(No changes detected)';
                    // logEntry.style.fontStyle = 'italic';
                    // For now, let's just skip adding the entry if it's only '(No changes)'
                     return; // Don't add empty or "no changes" diffs
                }
            } else {
                // Don't add an entry if the original message was effectively empty
                return;
            }
        }
    } else {
        // For non-diff messages, just set the text content
        logEntry.textContent = message;
    }

    // Only append if the entry has content (either text or the diff <pre>)
    if (logEntry.textContent || logEntry.querySelector('pre > span')) {
        logOutput.appendChild(logEntry);

        // Scroll to the bottom using requestAnimationFrame for better performance
        requestAnimationFrame(() => {
            // Scroll the container, not the pre itself
             logContainer.scrollTop = logContainer.scrollHeight;
        });
    }
}