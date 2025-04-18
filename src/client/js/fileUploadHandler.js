// c:\dev\gemini-coder\src\client\js\fileUploadHandler.js
import {
  preventDefaults,
  highlight,
  unhighlight,
  handleDrop,
  updateUploadTriggerText,
} from "./uiHelpers.js"; // Import specific UI functions
import { addLogMessage } from "./logger.js"; // Import logger

export function setupFileUploadAndDragDrop() {
  // Get necessary DOM elements
  const imageUploadInput = document.getElementById("imageUpload");
  const customUploadTrigger = document.getElementById("customUploadTrigger");
  const promptInput = document.getElementById("prompt"); // Drop target

  // Basic check if elements exist
  if (!imageUploadInput || !customUploadTrigger || !promptInput) {
    console.error(
      "Required elements for file upload/drag-drop not found (imageUpload, customUploadTrigger, prompt).",
    );
    return;
  }

  // --- File Input Setup ---
  // Trigger hidden file input when custom button is clicked
  customUploadTrigger.addEventListener("click", () => {
    imageUploadInput.click();
  });

  // Update button text when files are selected via dialog
  imageUploadInput.addEventListener("change", () => {
    updateUploadTriggerText(); // Update button appearance
    const fileCount = imageUploadInput.files.length;
    if (fileCount > 0) {
      addLogMessage(
        `📎 ${fileCount} file(s) selected via file dialog.`,
        "info",
        true,
      );
    }
  });

  // --- Drag and Drop Setup (on the prompt area) ---
  const dragDropEvents = ["dragenter", "dragover", "dragleave", "drop"];

  // Prevent default browser behavior for drag/drop events
  dragDropEvents.forEach((eventName) => {
    promptInput.addEventListener(eventName, preventDefaults, false);
    // Optional: Prevent drops anywhere else on the body?
    // document.body.addEventListener(eventName, preventDefaults, false);
  });

  // Highlight drop zone on drag enter/over
  ["dragenter", "dragover"].forEach((eventName) => {
    promptInput.addEventListener(eventName, highlight, false);
  });

  // Unhighlight drop zone on drag leave/drop
  ["dragleave", "drop"].forEach((eventName) => {
    promptInput.addEventListener(eventName, unhighlight, false);
  });

  // Handle file drop
  promptInput.addEventListener("drop", handleDrop, false);

  // --- Initial State ---
  // Set initial button text based on whether files are pre-selected (unlikely but possible)
  updateUploadTriggerText();

  console.log("File upload and drag/drop handlers setup.");
}

// No need for module.exports check
