// c:\dev\gemini-coder\src\server\fileSystem\loadGitignore.js
import path from "node:path";
import fs from "node:fs/promises";
import ignore from "ignore"; // Make sure 'ignore' supports default import or adjust as needed
import { emitLog } from "../utils.js"; // Added .js extension

export async function loadGitignore(baseDir, socket) {
  const gitignorePath = path.join(baseDir || "", ".gitignore");
  const ig = ignore(); // Create an ignore instance

  // Always ignore .git directory
  ig.add(".git/");

  try {
    const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
    if (gitignoreContent) {
      ig.add(gitignoreContent);
      // Use relative path for logging clarity if baseDir is deep
      const logPath =
        path.relative(process.cwd(), gitignorePath) || ".gitignore";
      emitLog(socket, ` fs: Loaded .gitignore rules from ${logPath}`, "debug");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      // It's fine if .gitignore doesn't exist
      emitLog(
        socket,
        ` fs: No .gitignore file found at ${gitignorePath}.`,
        "debug",
      );
    } else {
      // Log other errors like permission issues
      emitLog(
        socket,
        ` fs: ⚠️ Error reading .gitignore file at ${gitignorePath}: ${error.message}`,
        "warn",
      );
    }
  }

  return ig; // Return the ignore instance
}
