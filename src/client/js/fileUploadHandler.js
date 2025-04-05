/**
 * Sets up file upload functionality via click and drag-and-drop.
 */
function setupFileUploadAndDragDrop() {
    const imageUploadInput = document.getElementById('imageUpload');
    const customUploadTrigger = document.getElementById('customUploadTrigger');
    const promptInput = document.getElementById('prompt'); // Target for drag/drop

    if (!imageUploadInput || !customUploadTrigger || !promptInput) {
        console.error("Required elements for file upload/drag-drop not found (imageUpload, customUploadTrigger, prompt).");
        return;
    }

    // Trigger hidden file input when custom button is clicked
    customUploadTrigger.addEventListener('click', () => {
        imageUploadInput.click();
    });

    // --- Drag & Drop Event Listeners on the Prompt Textarea ---

    // Prevent default behaviors for drag/drop events
    if (typeof preventDefaults === 'function') {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            promptInput.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false); // Prevent browser opening file
        });
    } else {
        console.warn("Function 'preventDefaults' not found. Drag/drop might not work correctly.");
    }

    // Highlight drop zone when item is dragged over it
    if (typeof highlight === 'function') {
        ['dragenter', 'dragover'].forEach(eventName => {
            promptInput.addEventListener(eventName, highlight, false);
        });
    } else {
        console.warn("Function 'highlight' not found. Drop zone highlighting disabled.");
    }

    // Unhighlight drop zone when item leaves or is dropped
    if (typeof unhighlight === 'function') {
        ['dragleave', 'drop'].forEach(eventName => {
            promptInput.addEventListener(eventName, unhighlight, false);
        });
    } else {
        console.warn("Function 'unhighlight' not found. Drop zone highlighting might persist.");
    }

    // Handle dropped files
    if (typeof handleDrop === 'function') {
        promptInput.addEventListener('drop', handleDrop, false);
    } else {
        console.error("Function 'handleDrop' not found. File dropping will not work.");
    }

    // --- File Input Change Listener ---
    imageUploadInput.addEventListener('change', () => {
        if (typeof updateUploadTriggerText === 'function') {
            updateUploadTriggerText();
        }
        const fileCount = imageUploadInput.files.length;
        if (fileCount > 0) {
            if (typeof addLogMessage === 'function') {
                addLogMessage(`📎 ${fileCount} file(s) selected via file dialog.`, 'info');
            }
        }
    });

    // Initial update of the trigger text/icon
    if (typeof updateUploadTriggerText === 'function') {
        updateUploadTriggerText();
    } else {
         console.warn("Function 'updateUploadTriggerText' not found. Upload trigger UI may not update.");
    }

    console.log("File upload and drag/drop handlers setup.");
}