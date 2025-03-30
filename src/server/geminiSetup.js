// src/geminiSetup.js
const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");
require("dotenv").config(); // Ensure API key is loaded

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error(
        "FATAL ERROR: GEMINI_API_KEY not found in environment variables or .env file."
    );
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// Consider making the model name configurable via environment variable as well
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL_NAME || "gemini-2.5-pro-exp-03-25", // Using a known stable model, adjust if needed
});

/**
 * Generates the tools definition (function declarations) for the Gemini API,
 * dynamically including the base directory in descriptions.
 * @param {string} [baseDir] - The base directory for the current context. Optional.
 * @returns {object[]} The tools definition array.
 */
function getToolsDefinition(baseDir) {
    // Ensure baseDir is displayed reasonably in descriptions
    const displayBaseDir = baseDir ? `'${baseDir}'` : '(Not Set)'; // This logic now works correctly for undefined

    return [
        {
            functionDeclarations: [
                { name: "readFileContent", description: `Reads the content of a file relative to the base directory (${displayBaseDir}).`, parameters: { type: "object", properties: { filePath: { type: "string", description: "Relative path to the file." } }, required: ["filePath"] } },
                { name: "writeFileContent", description: `Writes content to a file relative to the base directory (${displayBaseDir}). Creates parent directories if needed. Asks for user confirmation.`, parameters: { type: "object", properties: { filePath: { type: "string", description: "Relative path to the file." }, content: { type: "string", description: "The content to write." } }, required: ["filePath", "content"] } },
                { name: "listFiles", description: `Lists files and subdirectories within a directory relative to the base directory (${displayBaseDir}). Defaults to the base directory. Respects .gitignore.`, parameters: { type: "object", properties: { directoryPath: { type: "string", description: "Relative path to the directory. Defaults to '.'. Nullable." } } } }, // Allow null/undefined for default '.'
                { name: "searchFiles", description: `Searches for files within the base directory (${displayBaseDir}) using a glob pattern (e.g., 'src/**/*.js', '*.md'). Respects .gitignore. Do not use '..'.`, parameters: { type: "object", properties: { pattern: { type: "string", description: "The glob pattern." } }, required: ["pattern"] } },
                // --- NEW: searchFilesByRegex ---
                { name: "searchFilesByRegex", description: `Searches file *content* recursively within a directory relative to the base directory (${displayBaseDir}) using a JavaScript regular expression. Respects .gitignore. Returns matching files' relative path, full content, and occurrence count.`, parameters: { type: "object", properties: { regexString: { type: "string", description: "JavaScript regex pattern (e.g., '/myFunc/gi' or 'error\\slog'). Must be a valid JS regex string." }, directoryPath: { type: "string", description: "Optional relative path to the directory to start searching from. Defaults to the base directory ('.'). Nullable." } }, required: ["regexString"] } },
                // --- END NEW ---
                { name: "createDirectory", description: `Creates a directory (and parents) relative to the base directory (${displayBaseDir}).`, parameters: { type: "object", properties: { directoryPath: { type: "string", description: "Relative path for the new directory." } }, required: ["directoryPath"] } },
                { name: "deleteFile", description: `Deletes a specific file relative to the base directory (${displayBaseDir}). Asks for user confirmation. Does NOT delete directories.`, parameters: { type: "object", properties: { filePath: { type: "string", description: "Relative path to the file to delete." } }, required: ["filePath"] } },
                { name: "moveItem", description: `Moves or renames a file OR directory relative to the base directory (${displayBaseDir}). Asks for user confirmation.`, parameters: { type: "object", properties: { sourcePath: { type: "string", description: "Relative source path." }, destinationPath: { type: "string", description: "Relative destination path." } }, required: ["sourcePath", "destinationPath"] } },
                { name: "askUserQuestion", description: `Asks the user a question. The user can respond with 'yes', 'no', or a free-form text answer. Use this when you need user input to proceed.`, parameters: { type: "object", properties: { question: { type: "string", description: "The question to ask the user." } }, required: ["question"] } },
 				{ name: "deleteDirectory", description: `Deletes a directory and its contents recursively relative to the base directory (${displayBaseDir}). Asks for user confirmation. This is irreversible via undo. Use with extreme caution.`, parameters: { type: "object", properties: { directoryPath: { type: "string", description: "Relative path to the directory to delete." } }, required: ["directoryPath"] } },
 				{ name: "showInformationTextToUser",
 					description: `Displays an informational message to the user without ending the task. Use this to provide status updates, explain your plan, or share observations if you are not yet calling another function or finishing the task. Do NOT return plain text for intermediate updates, as that will end the task.`,
 					parameters: { type: "object", properties: { messageToDisplay: { type: "string", description: "The informational message to show the user." } }, required: ["messageToDisplay"] }
 				},

            ],
        },
    ];
}


module.exports = {
    genAI,
    model,
    getToolsDefinition,
};
