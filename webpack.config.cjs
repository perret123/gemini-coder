// webpack.config.js
const path = require("path");

module.exports = {
  // Mode: "development" for easier debugging, "production" for optimized builds
  mode: process.env.NODE_ENV || "development",

  // Entry point: The main client JavaScript file
  entry: "./src/client/client.js",

  // Output configuration
  output: {
    // Output directory (absolute path) - Changed to be inside src/client
    path: path.resolve(__dirname, "src/client/dist/js"),
    filename: "bundle.js",
    // clean: true, // Consider enabling clean for production
  },

  // Devtool: Generate source maps for debugging
  devtool: "source-map", // Good for development, consider "cheap-module-source-map" or none for production

  // Module resolution (optional, but can be helpful)
  resolve: {
    // Extensions that Webpack will automatically resolve
    extensions: [".js"],
  },

  // Target environment (important for features like __dirname polyfills if needed, but usually fine for browser)
  target: "web",

  // Performance hints (optional)
  performance: {
    hints: process.env.NODE_ENV === "production" ? "warning" : false, // Show hints only in production
  },

  // Watch options (optional, for development)
//   watchOptions: {
//     ignored: /node_modules/,
//   },
};