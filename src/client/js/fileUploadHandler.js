function setupFileUploadAndDragDrop() {
    const imageUploadInput = document.getElementById('imageUpload');
    const customUploadTrigger = document.getElementById('customUploadTrigger');
    const promptInput = document.getElementById('prompt');

    if (!imageUploadInput || !customUploadTrigger || !promptInput) {
        console.error("Required elements for file upload/drag-drop not found (imageUpload, customUploadTrigger, prompt).");
        return;
    }

    customUploadTrigger.addEventListener('click', () => {
        imageUploadInput.click();
    });

    // --- Drag and Drop Event Listeners ---
    if (typeof preventDefaults === 'function') {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            promptInput.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false); // Prevent default for body too
        });
    } else {
        console.warn("Function 'preventDefaults' not found. Drag/drop might not work correctly.");
    }

    if (typeof highlight === 'function') {
        ['dragenter', 'dragover'].forEach(eventName => {
            promptInput.addEventListener(eventName, highlight, false);
        });
    } else {
        console.warn("Function 'highlight' not found. Drop zone highlighting disabled.");
    }

    if (typeof unhighlight === 'function') {
        ['dragleave', 'drop'].forEach(eventName => {
            promptInput.addEventListener(eventName, unhighlight, false);
        });
    } else {
        console.warn("Function 'unhighlight' not found. Drop zone highlighting might persist.");
    }

    if (typeof handleDrop === 'function') {
        promptInput.addEventListener('drop', handleDrop, false);
    } else {
        console.error("Function 'handleDrop' not found. File dropping will not work.");
    }
    // --- End Drag and Drop ---

    imageUploadInput.addEventListener('change', () => {
        if (typeof updateUploadTriggerText === 'function') {
            updateUploadTriggerText();
        }
        const fileCount = imageUploadInput.files.length;
        if (fileCount > 0) {
            if (typeof addLogMessage === 'function') {
                // ADDED isAction flag here
                addLogMessage(`📎 ${fileCount} file(s) selected via file dialog.`, 'info', true);
            }
        }
    });

    // Initial update in case files are pre-selected (e.g., page refresh with cache)
    if (typeof updateUploadTriggerText === 'function') {
        updateUploadTriggerText();
    } else {
        console.warn("Function 'updateUploadTriggerText' not found. Upload trigger UI may not update.");
    }

    console.log("File upload and drag/drop handlers setup.");
}

// ... (existing code) ...

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { setupFileUploadAndDragDrop };
  }