#!/usr/bin/env node

// --- Basic Setup ---
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('node:path');
const multer = require('multer'); // <-- Added multer
require("dotenv").config(); // Load .env file early for PORT etc.

const { handleSocketConnection } = require('./socketHandler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Multer Configuration --- // <-- Added section
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Save files to the 'uploads' directory at the project root
        cb(null, path.resolve(__dirname, '../../uploads'));
    },
    filename: function (req, file, cb) {
        // Use a timestamp prefix to avoid name collisions
        const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniquePrefix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Example: Limit file size to 10MB
}).array('images'); // Expect files under the 'images' field name, allow multiple

// Serve static files from the 'client' directory (relative to this file's directory)
app.use(express.static(path.resolve(__dirname, '../client')));

// --- File Upload Endpoint --- // <-- Added section
app.post('/upload', (req, res) => {
    upload(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred (e.g., file size limit)
            console.error('Multer error during upload:', err);
            return res.status(400).json({ message: `Upload error: ${err.message}` });
        } else if (err) {
            // An unknown error occurred
            console.error('Unknown error during upload:', err);
            return res.status(500).json({ message: 'Upload failed due to an unknown server error.' });
        }

        // Everything went fine
        console.log('Received files:', req.files ? req.files.map(f => f.filename) : 'No files received');
        res.status(200).json({
            message: 'Files uploaded successfully!',
            files: req.files ? req.files.map(f => f.filename) : []
        });
    });
});


// --- Socket.IO Connection Handling ---
// Delegate connection handling to the dedicated module
io.on('connection', (socket) => {
    handleSocketConnection(socket, io); // Pass io if needed by the handler
});

// --- Global Error Handling (Optional but Recommended) ---
process.on('uncaughtException', (error) => {
  console.error('FATAL Uncaught Exception:', error);
  // Perform cleanup if necessary
  process.exit(1); // Exit gracefully
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL Unhandled Rejection at:', promise, 'reason:', reason);
  // Perform cleanup if necessary
  process.exit(1); // Exit gracefully
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
    console.log(`Serving static files from: ${path.resolve(__dirname, '../client')}`);
    console.log(`Uploads will be saved to: ${path.resolve(__dirname, '../../uploads')}`); // Added log for upload dir
});
