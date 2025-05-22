/* eslint-disable @typescript-eslint/no-unused-vars */
// src/server/codeIndexer.js
import { spawn } from "child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { emitLog } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_SCRIPT_PATH = path.resolve(
  __dirname,
  "../../scripts/prompt-builder.py",
);
// This DB_PARENT_DIR is relative to gemini-coder root, where vector_stores will live
const DB_PARENT_DIR = path.resolve(__dirname, "../../vector_stores");
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE || "python3.11"; // Or "python"

async function checkPythonScriptExists() {
  try {
    await fs.access(PYTHON_SCRIPT_PATH);
    return true;
  } catch {
    console.error(`FATAL: Python script not found at ${PYTHON_SCRIPT_PATH}`);
    return false;
  }
}

export async function triggerIndexing(socket, projectDir, mode = "update") {
  if (!(await checkPythonScriptExists())) {
    emitLog(
      socket,
      "Error: Python script for indexing not found on server.",
      "error",
      true,
    );
    socket.emit("indexing-status", {
      type: "error",
      message: "Python script not found.",
    });
    return;
  }
  if (!projectDir) {
    emitLog(
      socket,
      "Error: Project directory is required for indexing.",
      "error",
      true,
    );
    socket.emit("indexing-status", {
      type: "error",
      message: "Project directory not provided.",
    });
    return;
  }

  emitLog(
    socket,
    `Starting indexing for ${projectDir} (mode: ${mode})...`,
    "info",
    true,
  );
  socket.emit("indexing-status", {
    type: "progress",
    message: "Initializing indexing...",
    percentage: 0,
  });

  const pythonProcess = spawn(PYTHON_EXECUTABLE, [
    PYTHON_SCRIPT_PATH,
    "--project-dir",
    projectDir,
    "--db-parent-dir",
    DB_PARENT_DIR,
    "--action",
    "index",
    "--mode",
    mode,
  ]);

  let lastError = "";

  pythonProcess.stdout.on("data", (data) => {
    const output = data.toString().trim();
    output.split("\n").forEach((line) => {
      try {
        const jsonData = JSON.parse(line);
        // emitLog(socket, `[Indexer STDOUT]: ${jsonData.message}`, jsonData.type || "debug");
        if (
          jsonData.type === "progress" ||
          jsonData.type === "info" ||
          jsonData.type === "warning" ||
          jsonData.type === "completed" ||
          jsonData.type === "error"
        ) {
          socket.emit("indexing-status", jsonData);
        }
        if (jsonData.type === "error") lastError = jsonData.message;
      } catch (e) {
        // emitLog(socket, `[Indexer Raw STDOUT]: ${line}`, "debug");
        // Send non-JSON lines as general progress too
        socket.emit("indexing-status", {
          type: "progress_text",
          message: line,
        });
      }
    });
  });

  pythonProcess.stderr.on("data", (data) => {
    const errorMsg = data.toString();
    emitLog(socket, `[Indexer STDERR]: ${errorMsg}`, "error");
    lastError = errorMsg;
    // Consider sending critical stderr as an error status
    socket.emit("indexing-status", {
      type: "progress_text",
      message: `STDERR: ${errorMsg.substring(0, 100)}...`,
    });
  });

  pythonProcess.on("close", (code) => {
    if (code === 0) {
      emitLog(
        socket,
        `Indexing process completed successfully for ${projectDir}.`,
        "success",
        true,
      );
      // Final status might have been sent by script itself, or send a generic one.
      // socket.emit("indexing-status", { type: "completed", message: "Indexing finished." });
    } else {
      emitLog(
        socket,
        `Indexing process for ${projectDir} exited with code ${code}. Last error: ${lastError}`,
        "error",
        true,
      );
      socket.emit("indexing-status", {
        type: "error",
        message: `Indexing failed (code ${code}). ${lastError}`.trim(),
      });
    }
  });

  pythonProcess.on("error", (err) => {
    emitLog(
      socket,
      `Failed to start indexing process for ${projectDir}: ${err.message}`,
      "error",
      true,
    );
    socket.emit("indexing-status", {
      type: "error",
      message: `Failed to start python script: ${err.message}`,
    });
  });
}

export async function getLastIndexedTime(projectDir) {
  if (!(await checkPythonScriptExists())) {
    return {
      timestamp: 0,
      message: "Python script not found.",
      project_path: projectDir,
    };
  }
  if (!projectDir) {
    return {
      timestamp: 0,
      message: "Project directory not provided.",
      project_path: projectDir,
    };
  }

  return new Promise((resolve, reject) => {
    const pythonProcess = spawn(PYTHON_EXECUTABLE, [
      PYTHON_SCRIPT_PATH,
      "--project-dir",
      projectDir,
      "--db-parent-dir",
      DB_PARENT_DIR,
      "--action",
      "get_last_indexed_time",
    ]);

    let outputData = "";
    let errorData = "";

    pythonProcess.stdout.on("data", (data) => (outputData += data.toString()));
    pythonProcess.stderr.on("data", (data) => (errorData += data.toString()));

    pythonProcess.on("close", (code) => {
      if (code === 0) {
        try {
          const jsonData = JSON.parse(outputData.trim().split("\n").pop()); // Get last JSON line
          resolve({
            timestamp: jsonData.timestamp || 0,
            message: jsonData.message || "Never",
            project_path: jsonData.project_path || projectDir,
          });
        } catch (e) {
          resolve({
            timestamp: 0,
            message: "Error parsing indexer output.",
            project_path: projectDir,
          });
        }
      } else {
        console.error(`Python (get_last_indexed_time) stderr: ${errorData}`);
        resolve({
          timestamp: 0,
          message: "Failed to get last indexed time.",
          error: errorData,
          project_path: projectDir,
        });
      }
    });
    pythonProcess.on("error", (err) => {
      console.error(
        `Python (get_last_indexed_time) execution error: ${err.message}`,
      );
      resolve({
        timestamp: 0,
        message: "Failed to execute python script.",
        error: err.message,
        project_path: projectDir,
      });
    });
  });
}

export async function queryContext(projectDir, queryText) {
  if (!(await checkPythonScriptExists())) {
    console.error("queryContext: Python script not found.");
    return []; // Return empty array on error, as expected by caller
  }
  if (!projectDir || !queryText) {
    console.error("queryContext: Missing projectDir or queryText.");
    return [];
  }

  return new Promise((resolve, reject) => {
    const pythonProcess = spawn(PYTHON_EXECUTABLE, [
      PYTHON_SCRIPT_PATH,
      "--project-dir",
      projectDir,
      "--db-parent-dir",
      DB_PARENT_DIR,
      "--action",
      "query",
      "--query-text",
      queryText,
    ]);

    let stdoutJsonString = "";
    let stderrOutput = "";

    pythonProcess.stdout.on("data", (data) => {
      stdoutJsonString += data.toString();
    });
    pythonProcess.stderr.on("data", (data) => {
      stderrOutput += data.toString();
      // You might want to log these errors or handle them
      // console.error(`QueryContext STDERR: ${data.toString()}`);
    });

    pythonProcess.on("close", (code) => {
      if (stderrOutput.trim()) {
        console.warn(
          `QueryContext process STDERR for ${projectDir} (query: "${queryText.substring(0, 20)}..."): ${stderrOutput.trim()}`,
        );
      }
      if (code === 0) {
        try {
          // The python script prints multiple JSON lines for progress, then one final JSON array for results
          const lines = stdoutJsonString.trim().split("\n");
          const lastLine = lines.pop(); // Get the last line which should be the query_result
          const result = JSON.parse(lastLine);
          if (result.type === "query_result") {
            resolve(result.files || []);
          } else if (result.type === "error") {
            console.error(`QueryContext returned error: ${result.message}`);
            resolve([]);
          } else {
            console.error(
              "QueryContext: Unexpected JSON output from Python script.",
              result,
            );
            resolve([]);
          }
        } catch (e) {
          console.error(
            `QueryContext: Error parsing JSON from Python script (query: "${queryText.substring(0, 20)}..."). Error: ${e}. Output: ${stdoutJsonString}`,
          );
          resolve([]);
        }
      } else {
        console.error(
          `QueryContext: Python script exited with code ${code} for ${projectDir}. Query: "${queryText.substring(0, 20)}..."`,
        );
        resolve([]);
      }
    });
    pythonProcess.on("error", (err) => {
      console.error(
        `QueryContext: Failed to start Python script for ${projectDir}. Error: ${err.message}`,
      );
      resolve([]);
    });
  });
}
