// c:\dev\gemini-coder\src\client\js\logger.js
// Modify the function signature to accept isAction (timestamp parameter is no longer needed)
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

    // Create content container
    const contentSpan = document.createElement('span');
    contentSpan.className = 'log-message-content';

    if (type === 'diff') {
        // --- Keep the existing diff handling logic, but place inside contentSpan ---
        logEntry.classList.add('log-diff'); // Add specific class for easier targeting if needed
        const pre = document.createElement('pre');
        const lines = message.split(/\r?\n/);
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
                span.className = 'diff-header';
                span.textContent = line;
                hasContent = true;
            } else if (trimmedLine === '' && !hasContent) {
                return;
            } else {
                span.className = 'diff-context';
                span.textContent = line;
                hasContent = true;
            }
            pre.appendChild(span);
        });

        if (pre.hasChildNodes() && hasContent) {
            contentSpan.appendChild(pre);
        } else {
            const trimmedMessage = message.trim();
            if (trimmedMessage !== '' && trimmedMessage !== '(No changes)') {
                const preFallback = document.createElement('pre');
                preFallback.textContent = message;
                contentSpan.appendChild(preFallback);
            } else {
                return; // Don't add empty or "(No changes)" diff logs
            }
        }
    } else {
        // For non-diff types, set text content of the contentSpan
        contentSpan.textContent = message;
    }


    // Add timestamp span if it's an action bubble
    if (isAction && type !== 'diff') {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-timestamp';
        // Generate client-side timestamp
        const now = new Date();
        timeSpan.textContent = now.toLocaleTimeString('en-US', { hour12: false });
        logEntry.appendChild(timeSpan); // Append timestamp after the content
    }

    
    // Append contentSpan to logEntry
    logEntry.appendChild(contentSpan);

    // Append the complete logEntry only if there's content
    if (contentSpan.textContent.trim() !== '' || contentSpan.querySelector('pre > span')) {
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