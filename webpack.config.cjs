/* eslint-disable @typescript-eslint/no-require-imports */
// webpack.config.cjs
// Use require for CommonJS modules
const path = require("path");
// const { fileURLToPath } = require("url"); // Still need this for __dirname if used, but require it
const webpack = require("webpack"); // <-- Require webpack

// Replicate __dirname behavior if needed (less common in CJS config unless you specifically need the file's dir)
// const __filename = fileURLToPath(import.meta.url); // This won't work in CJS
// const __dirname = path.dirname(__filename);
// Instead, Node provides __dirname directly in CJS modules:
// const __dirname = __dirname; // It's already available!

// Use module.exports for CommonJS
module.exports = {
  // Mode: "development" for easier debugging, "production" for optimized builds
  mode: process.env.NODE_ENV || "development",

  // Entry point: The main client JavaScript file
  entry: "./src/client/client.js",

  // Output configuration
  output: {
    // Output directory (absolute path) - Changed to be inside src/client
    // Use the built-in __dirname for CommonJS
    path: path.resolve(__dirname, "src/client/dist/js"),
    filename: "bundle.js",
    // clean: true, // Consider enabling clean for production
  },

  // Devtool: Generate source maps for debugging
  devtool: "source-map", // Good for development, consider "cheap-module-source-map" or none for production

  // Target environment
  target: "web",

  // Module resolution
  resolve: {
    // Extensions that Webpack will automatically resolve
    extensions: [".js"],
    // ***** FALLBACK SECTION (require.resolve is correct here in CJS) *****
    fallback: {
      // Provide fallbacks for Node.js core modules
      path: require.resolve("path-browserify"),
      crypto: require.resolve("crypto-browserify"),
      http: require.resolve("stream-http"),
      https: require.resolve("https-browserify"), // Add https as it's often needed with http
      querystring: require.resolve("querystring-es3"),
      url: require.resolve("url/"), // Note the trailing slash for the 'url' package
      timers: require.resolve("timers-browserify"),
      zlib: require.resolve("browserify-zlib"),
      stream: require.resolve("stream-browserify"),
      fs: false, // Cannot polyfill 'fs' for the browser, use false
      os: require.resolve("os-browserify/browser"), // Often needed indirectly
      assert: require.resolve("assert/"), // Often needed indirectly
      util: require.resolve("util/"), // Often needed indirectly
    },
    // ************************************
  },

  // ***** PLUGINS SECTION (webpack instance is required) *****
  plugins: [
    // Polyfill 'process' and 'Buffer' which some libraries expect
    new webpack.ProvidePlugin({
      process: "process/browser",
    }),
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
    }),
  ],
  // ***********************************

  // Performance hints (optional)
  performance: {
    hints: process.env.NODE_ENV === "production" ? "warning" : false, // Show hints only in production
  },

  // Watch options (optional, for development)
  //   watchOptions: {
  //     ignored: /node_modules/,
  //   },
};
