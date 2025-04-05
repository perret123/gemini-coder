// This file re-exports the key functions from the fileSystem module

const { loadGitignore } = require("./loadGitignore");
const { createFileSystemHandlers } = require("./createFileSystemHandlers");
const { performUndoOperation } = require("./performUndoOperation");

// Export the functions intended for public use within the server
module.exports = {
    loadGitignore,
    createFileSystemHandlers,
    performUndoOperation
};
