#!/usr/bin/env node

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('node:path');
const fs = require('node:fs'); // Use synchronous fs for setup check
const multer = require('multer');
require("dotenv").config(); // Load .env file from project root

const { handleSocketConnection } = require('./socketHandler'); // Manages socket events and state

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const CLIENT_PATH = path.resolve(__dirname, '../client');
const UPLOAD_DIR_NAME = 'uploads';
const UPLOAD_PATH = path.resolve(__dirname, '../../', UPLOAD_DIR_NAME); // Place uploads one level above src/
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB limit per file

// --- Initial Checks ---
// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_PATH)) {
    try {
        fs.mkdirSync(UPLOAD_PATH);
        console.log(`Created upload directory: ${UPLOAD_PATH}`);
    } catch (err) {
        console.error(`FATAL ERROR: Could not create upload directory: ${UPLOAD_PATH}`);
        console.error(err);
        process.exit(1);
    }
} else {
     console.log(`Upload directory found: ${UPLOAD_PATH}`);
}
// Check if client directory exists
if (!fs.existsSync(CLIENT_PATH) || !fs.statSync(CLIENT_PATH).isDirectory()) {
     console.error(`FATAL ERROR: Client directory not found or not a directory: ${CLIENT_PATH}`);
     process.exit(1);
}


// --- Express App Setup ---
const app = express();
const server = http.createServer(app);

// --- Socket.IO Setup ---
const io = new Server(server, {
    // Optional: Configure transports, ping intervals, etc.
     // maxHttpBufferSize: 1e8 // Increase buffer size if large data is sent via sockets (e.g., 100MB) - Usually uploads use HTTP POST
});

// --- Multer Setup for File Uploads ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_PATH); // Save files to the resolved upload path
    },
    filename: function (req, file, cb) {
        // Create a unique filename to avoid collisions
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        const safeOriginalName = file.originalname
            .replace(/[^a-z0-9._-]/gi, '_') // Sanitize original name
            .toLowerCase();
        cb(null, uniqueSuffix + '-' + safeOriginalName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE }, // Apply file size limit
    fileFilter: function (req, file, cb) {
        // Optional: Filter file types (e.g., only allow images)
        // if (!file.mimetype.startsWith('image/')) {
        //     return cb(new Error('Only image files are allowed!'), false);
        // }
        cb(null, true); // Accept all files for now
    }
}).array('images'); // Expect files under the field name 'images'

// --- Middleware ---
// Serve static files from the client directory
app.use(express.static(CLIENT_PATH));
// Basic request logging (optional)
app.use((req, res, next) => {
     console.log(`HTTP Request: ${req.method} ${req.url}`);
     next();
});


// --- Routes ---
// Route for handling file uploads
app.post('/upload', (req, res) => {
    upload(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred (e.g., file size limit exceeded)
            console.error('Multer error during upload:', err);
            return res.status(400).json({ message: `Upload error: ${err.message} (Code: ${err.code})` });
        } else if (err) {
            // An unknown error occurred
            console.error('Unknown error during upload:', err);
            return res.status(500).json({ message: `Upload failed: ${err.message || 'Unknown server error.'}` });
        }

        // Upload successful
        const uploadedFiles = req.files ? req.files.map(f => ({
             originalname: f.originalname,
             filename: f.filename, // The unique name saved on server
             size: f.size,
             mimetype: f.mimetype
         })) : [];

        console.log(`Successfully uploaded ${uploadedFiles.length} file(s):`, uploadedFiles.map(f=>f.filename));
        res.status(200).json({
            message: `${uploadedFiles.length} file(s) uploaded successfully!`,
            files: uploadedFiles.map(f => f.filename) // Send back the unique server filenames
        });
    });
});

// Serve the main HTML file for the root path
app.get('/', (req, res) => {
    res.sendFile(path.resolve(CLIENT_PATH, 'index.html'));
});


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    // Delegate connection handling to socketHandler module
    handleSocketConnection(socket, io);
});

// --- Global Error Handling ---
process.on('uncaughtException', (error, origin) => {
    console.error('<<<<< FATAL UNCAUGHT EXCEPTION >>>>>');
    console.error(`Origin: ${origin}`);
    console.error(error);
    // Perform cleanup if necessary, then exit forcefully
    // Be cautious with async cleanup here
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('<<<<< FATAL UNHANDLED REJECTION >>>>>');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    // Exit forcefully
    process.exit(1);
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`\n🚀 Gemini Coder Server listening on http://localhost:${PORT}`);
    console.log(`Serving static files from: ${CLIENT_PATH}`);
    console.log(`Uploads configured at: ${UPLOAD_PATH}`);
    console.log(`Gemini Model: ${process.env.GEMINI_MODEL_NAME || modelName} (from geminiSetup)`); // Display model being used
    console.log('Waiting for client connections...');
});