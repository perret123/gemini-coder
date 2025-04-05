const path = require("node:path");
const fs = require("node:fs/promises");
const ignore = require("ignore");
// Adjust the path to utils
const { emitLog } = require("../utils");

// --- Gitignore Loading ---
async function loadGitignore(baseDir, socket) {
    const gitignorePath = path.join(baseDir || "", ".gitignore");
    const ig = ignore();
    ig.add(".git/"); // Always ignore .git
    // Consider adding other common ignores by default? e.g., node_modules?
    // ig.add("node_modules/");

    try {
        const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
        if (gitignoreContent) {
            ig.add(gitignoreContent);
            emitLog(socket, ` fs: Loaded .gitignore rules from ${path.relative(process.cwd(), gitignorePath) || ".gitignore"}`, "debug");
        }
    } catch (error) {
        if (error.code === "ENOENT") {
             emitLog(socket, ` fs: No .gitignore file found at ${gitignorePath}.`, "debug");
        } else {
            emitLog(socket, ` fs: ⚠️ Error reading .gitignore file at ${gitignorePath}: ${error.message}`, "warn");
        }
    }
    return ig;
}

module.exports = { loadGitignore }; // Export the function
