// c:\dev\gemini-coder\src\server\geminiSetup.js
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config(); // Load .env file

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error(
        "FATAL ERROR: GEMINI_API_KEY not found in environment variables or .env file."
    );
    // Determine project root dynamically if possible, otherwise use static path
    // This requires 'path' and 'url' modules
    // import { fileURLToPath } from 'node:url';
    // import path from 'node:path';
    // const __filename = fileURLToPath(import.meta.url);
    // const __dirname = path.dirname(__filename);
    // const projectRoot = path.resolve(__dirname, '../../'); // Adjust based on file location
    // console.error(`Please create a .env file in the project root (${projectRoot}) with the line:`);
    console.error("Please create a .env file in the project root (e.g., c:\\dev\\gemini-coder\\) with the line:"); // Fallback static path
    console.error("GEMINI_API_KEY=YOUR_ACTUAL_API_KEY");
    process.exit(1);
}

// Initialize the Generative AI client
const genAI = new GoogleGenerativeAI(API_KEY);

// Define model name from environment or default
export const modelName = process.env.GEMINI_MODEL_NAME || "gemini-1.5-pro-latest"; // Export modelName too
console.log(`Using Gemini model: ${modelName}`);

// Configure safety settings if needed (example shown)
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];


// Get the generative model instance
export const model = genAI.getGenerativeModel({
     model: modelName,
     safetySettings: safetySettings, // Apply safety settings if defined
     // Add generationConfig defaults here if desired
     // generationConfig: { temperature: 1.0 } // Example
});

// Define the tool (function declarations) - export this function
export function getToolsDefinition(baseDir) {
    const displayBaseDir = baseDir ? `"${baseDir}"` : ".";

    // Function declarations remain largely the same
    const functionDeclarations = [
         {
            name: "readFileContent",
            description: `Reads the complete content of a single file specified by its path RELATIVE to the base directory (${displayBaseDir}).`,
            parameters: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Path to the file relative to the base directory." }
                },
                required: ["filePath"]
            }
        },
        {
            name: "listFiles",
            description: `Lists files and subdirectories within a specified directory RELATIVE to the base directory (${displayBaseDir}). Defaults to listing the base directory itself if 'directoryPath' is omitted or empty. Respects .gitignore rules.`,
            parameters: {
                type: "object",
                properties: {
                    directoryPath: { type: "string", description: "Optional. Path to the directory relative to the base directory. Defaults to '.' (the base directory)." }
                },
                 // No required parameters
            }
        },
        {
            name: "searchFiles",
            description: `Searches for files (not directories) within the base directory (${displayBaseDir}) using a glob pattern. Paths MUST be relative to the base directory. Respects .gitignore. Do NOT use '..' in the pattern. Examples: 'src/**/*.js', '*.md', 'docs/api_*.txt'.`,
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "The glob pattern (e.g., 'src/**/*.ts', '*.txt'). Must be relative." }
                },
                required: ["pattern"]
            }
        },
        {
            name: "searchFilesByRegex",
            description: `Searches the *content* of files recursively within a specified directory (or the base directory ${displayBaseDir} if omitted) using a JavaScript regular expression. Respects .gitignore. Returns ONLY the relative paths of matching files and the number of matches per file (occurrence count). Does NOT return file content. Use 'readFileContent' afterwards if you need the content of specific matches.`,
            parameters: {
                type: "object",
                properties: {
                    regexString: { type: "string", description: "JavaScript regex pattern string (e.g., '/pattern/flags' or 'pattern'). Must be valid JS syntax." },
                    directoryPath: { type: "string", description: "Optional. Relative path to the directory to start searching from. Defaults to '.' (the base directory)." }
                },
                required: ["regexString"]
            }
        },
        {
            name: "writeFileContent",
            description: `Writes provided content to a file specified by its path RELATIVE to the base directory (${displayBaseDir}). This will OVERWRITE the file if it exists, or create it (and parent directories) if it doesn't. Requires user confirmation before execution unless 'yes/all' was previously selected. Provide the FULL desired file content. Content MUST be raw source code without markdown formatting.`,
            parameters: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Relative path to the file." },
                    content: { type: "string", description: "The complete, raw content to write to the file." }
                },
                required: ["filePath", "content"]
            }
        },
        {
            name: "createDirectory",
            description: `Creates a new directory (including any necessary parent directories) specified by its path RELATIVE to the base directory (${displayBaseDir}). Does nothing if the directory already exists.`,
            parameters: {
                type: "object",
                properties: {
                    directoryPath: { type: "string", description: "Relative path for the new directory to be created." }
                },
                required: ["directoryPath"]
            }
        },
        {
            name: "deleteFile",
            description: `Deletes a single file specified by its path RELATIVE to the base directory (${displayBaseDir}). Does NOT delete directories (use 'deleteDirectory' for that). Requires user confirmation before execution unless 'yes/all' was previously selected.`,
            parameters: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Relative path to the file to delete." }
                },
                required: ["filePath"]
            }
        },
        {
            name: "moveItem",
            description: `Moves or renames a file OR a directory from a source path to a destination path, both RELATIVE to the base directory (${displayBaseDir}). Requires user confirmation before execution unless 'yes/all' was previously selected. Fails if the destination already exists.`,
            parameters: {
                type: "object",
                properties: {
                    sourcePath: { type: "string", description: "Relative source path of the file or directory to move." },
                    destinationPath: { type: "string", description: "Relative destination path." }
                },
                required: ["sourcePath", "destinationPath"]
            }
        },
        {
            name: "deleteDirectory",
            description: `Deletes a directory and ALL its contents recursively, specified by its path RELATIVE to the base directory (${displayBaseDir}). This is DANGEROUS and IRREVERSIBLE. Requires user confirmation before execution unless 'yes/all' was previously selected. Use with extreme caution ONLY when absolutely necessary.`,
            parameters: {
                type: "object",
                properties: {
                    directoryPath: { type: "string", description: "Relative path to the directory to delete recursively." }
                },
                required: ["directoryPath"]
            }
        },
        {
            name: "askUserQuestion",
            description: `Asks the user a clarifying question when the instructions are ambiguous, information is missing, or confirmation beyond a simple yes/no is needed to proceed. The user can respond with text or sometimes 'yes'/'no' buttons.`,
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The clear and specific question to ask the user." }
                },
                required: ["question"]
            }
        },
        {
            name: "showInformationTextToUser",
            description: `Displays an informational message to the user in the log area *without* ending the task or requiring a response. Use this for status updates, explaining your plan, reporting non-blocking errors, or sharing observations before calling another function or finishing the task. CRITICAL: Do NOT return plain text for intermediate updates, as that WILL end the task prematurely because tool mode is 'ANY'.`,
            parameters: {
                type: "object",
                properties: {
                    messageToDisplay: { type: "string", description: "The informational message to show the user." }
                },
                required: ["messageToDisplay"]
            }
        },
        {
            name: "task_finished",
            description: "Call this function ONLY when the entire user request has been successfully completed OR if you have reached an unrecoverable state (e.g., user rejected critical step, unresolvable error). This function signals the end of the task.",
            parameters: {
                type: "object",
                properties: {
                    finalMessage: { type: "string", description: "A concise final message summarizing the outcome (e.g., 'Task completed successfully.', 'File updated as requested.', 'Failed to delete file due to user rejection.')." }
                },
                required: ["finalMessage"]
            }
        },
    ];

    // Return the tools object in the format expected by the SDK
    return { functionDeclarations };
}

// Export genAI if needed elsewhere, otherwise just model and getToolsDefinition might suffice
// export { genAI };
