#!/usr/bin/env node
// c:\dev\gemini-coder\src\server\server.js
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import fs from "node:fs"; // Use synchronous fs methods for initial setup checks only
import { fileURLToPath } from "node:url"; // To get __dirname equivalent
import multer from "multer";
import dotenv from "dotenv";

// Import local modules
import { handleSocketConnection } from "./socketHandler.js"; // Added .js
import { modelName } from "./geminiSetup.js"; // Import modelName for logging

dotenv.config(); // Load environment variables from .env file

// --- Configuration ---
const PORT = process.env.PORT || 3000;

// Get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths relative to the current file"s directory
const CLIENT_PATH = path.resolve(__dirname, "../client");
const UPLOAD_DIR_NAME = "uploads";
const UPLOAD_PATH = path.resolve(__dirname, "../../", UPLOAD_DIR_NAME); // Path relative to project root
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

// --- Initial Setup Checks ---

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_PATH)) {
  try {
    fs.mkdirSync(UPLOAD_PATH, { recursive: true }); // Use recursive option
    console.log(`Created upload directory: ${UPLOAD_PATH}`);
  } catch (err) {
    console.error(
      `FATAL ERROR: Could not create upload directory: ${UPLOAD_PATH}`,
    );
    console.error(err);
    process.exit(1); // Exit if cannot create upload dir
  }
} else {
  console.log(`Upload directory found: ${UPLOAD_PATH}`);
}

// Ensure client directory exists
if (!fs.existsSync(CLIENT_PATH) || !fs.statSync(CLIENT_PATH).isDirectory()) {
  console.error(
    `FATAL ERROR: Client directory not found or not a directory: ${CLIENT_PATH}`,
  );
  process.exit(1); // Exit if client dir is missing
}

// --- Express and Server Setup ---
const app = express();
const server = http.createServer(app);

// --- Socket.IO Setup ---
const io = new Server(server, {
  // Optional Socket.IO configurations can go here
  // e.g., cors: { origin: "http://localhost:8080", methods: ["GET", "POST"] }
});

// --- Multer Setup (for file uploads) ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_PATH); // Save uploads to the resolved UPLOAD_PATH
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    // Sanitize original filename before using it
    const safeOriginalName = file.originalname
      .replace(/[^a-z0-9._-]/gi, "_") // Replace unsafe characters with underscore
      .toLowerCase();
    cb(null, uniqueSuffix + "-" + safeOriginalName + extension);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE }, // Apply file size limit
  fileFilter: function (req, file, cb) {
    // Basic filter (accept all files for now, can be restricted by MIME type)
    // Example: Allow only images
    // if (file.mimetype.startsWith("image/")) {
    //     cb(null, true);
    // } else {
    //     cb(new Error("Only image files are allowed!"), false);
    // }
    cb(null, true); // Accept all files passed
  },
}).array("images"); // Expect files under the field name "images"

// --- Middleware ---
// Serve static files from the client directory
app.use(express.static(CLIENT_PATH));

// Simple HTTP request logger middleware
app.use((req, res, next) => {
  console.log(`HTTP Request: ${req.method} ${req.url}`);
  next();
});

// --- Routes ---
// File upload endpoint
app.post("/upload", (req, res) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading.
      console.error("Multer error during upload:", err);
      return res
        .status(400)
        .json({ message: `Upload error: ${err.message} (Code: ${err.code})` });
    } else if (err) {
      // An unknown error occurred when uploading.
      console.error("Unknown error during upload:", err);
      return res.status(500).json({
        message: `Upload failed: ${err.message || "Unknown server error."}`,
      });
    }

    // Everything went fine.
    const uploadedFiles = req.files
      ? req.files.map((f) => ({
          originalname: f.originalname,
          filename: f.filename, // The generated unique filename
          size: f.size,
          mimetype: f.mimetype,
        }))
      : [];

    console.log(
      `Successfully uploaded ${uploadedFiles.length} file(s):`,
      uploadedFiles.map((f) => f.filename),
    );
    res.status(200).json({
      message: `${uploadedFiles.length} file(s) uploaded successfully!`,
      files: uploadedFiles.map((f) => f.filename), // Return only the generated filenames
    });
  });
});

// Serve the main index.html for the root path
app.get("/", (req, res) => {
  res.sendFile(path.resolve(CLIENT_PATH, "index.html"));
});

// --- Socket.IO Connection Handling ---
io.on("connection", (socket) => {
  // Delegate connection handling to the dedicated module
  handleSocketConnection(socket, io);
});

// --- Process-wide Error Handling ---
process.on("uncaughtException", (error, origin) => {
  console.error("<<<<< FATAL UNCAUGHT EXCEPTION >>>>>");
  console.error(`Origin: ${origin}`);
  console.error(error);
  // It"s generally recommended to exit gracefully after an uncaught exception
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("<<<<< FATAL UNHANDLED REJECTION >>>>>");
  console.error("Reason:", reason);
  console.error("Promise:", promise);
  // Exit gracefully on unhandled promise rejections as well
  process.exit(1);
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`\n🚀 Gemini Coder Server listening on http://localhost:${PORT}`);
  console.log(`Serving static files from: ${CLIENT_PATH}`);
  console.log(`Uploads configured at: ${UPLOAD_PATH}`);
  console.log(`Gemini Model: ${modelName}`); // Log the model name being used
  console.log("Waiting for client connections...");
});
