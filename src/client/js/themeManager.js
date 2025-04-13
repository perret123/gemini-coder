// c:\dev\gemini-coder\src\client\js\themeManager.js
import { addLogMessage } from "./logger.js";

const LIGHT_THEME = "light";
const DARK_THEME = "dark";
const THEME_KEY = "app-theme"; // Key for localStorage
const LIGHT_ICON = "☀️";
const DARK_ICON = "🌙";

// Applies the theme to the body and updates the button
export function applyTheme(theme) {
    const bodyElement = document.body;
    const themeSwitcherButton = document.getElementById("themeSwitcher");

    if (!bodyElement) {
        console.error("Document body element not found. Cannot apply theme.");
        return;
    }

    // Remove existing theme classes and set data attribute
    bodyElement.classList.remove("theme-light", "theme-dark");
    bodyElement.dataset.theme = theme; // Use data attribute for potential CSS targeting

    // Add the new theme class and update button
    if (theme === LIGHT_THEME) {
        bodyElement.classList.add("theme-light");
        if (themeSwitcherButton) {
            themeSwitcherButton.textContent = DARK_ICON;
            themeSwitcherButton.title = "Switch to Dark Theme";
        }
    } else { // Default to dark theme
        bodyElement.classList.add("theme-dark");
        if (themeSwitcherButton) {
            themeSwitcherButton.textContent = LIGHT_ICON;
            themeSwitcherButton.title = "Switch to Light Theme";
        }
    }

    // Save preference to localStorage
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
        console.warn("Could not save theme preference to localStorage:", e);
    }
}

// Toggles between light and dark themes
export function toggleTheme() {
    const bodyElement = document.body;
    if (!bodyElement) {
        console.error("Document body element not found. Cannot toggle theme.");
        return;
    }

    // Determine current theme based on class
    const currentTheme = bodyElement.classList.contains("theme-light") ? LIGHT_THEME : DARK_THEME;
    const newTheme = currentTheme === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;

    applyTheme(newTheme); // Apply the new theme

    // Log the change
    addLogMessage(`🎨 Switched to ${newTheme} theme.`, "info", true);
}

// Loads the theme from localStorage or system preference
export function loadTheme() {
    let preferredTheme = DARK_THEME; // Default theme

    try {
        // Check localStorage first
        const savedTheme = localStorage.getItem(THEME_KEY);
        if (savedTheme && (savedTheme === LIGHT_THEME || savedTheme === DARK_THEME)) {
            preferredTheme = savedTheme;
        } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
            // Check system preference if no localStorage setting
            preferredTheme = LIGHT_THEME;
        }
    } catch (e) {
        console.warn("Could not load theme preference from localStorage:", e);
    }

    applyTheme(preferredTheme); // Apply the determined theme
    console.log(`Applied initial theme: ${preferredTheme}`);
}

// Initialization logic (attaching event listener)
export function initializeThemeManager() {
     const themeSwitcherButton = document.getElementById("themeSwitcher");
     if (themeSwitcherButton) {
         themeSwitcherButton.addEventListener("click", toggleTheme);
     } else {
         console.warn("Theme switcher button ('themeSwitcher') not found.");
     }
     loadTheme(); // Load theme immediately on initialization
     console.log("Theme Manager initialized.");
}

// No need for module.exports check
