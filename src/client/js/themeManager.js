const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
const THEME_KEY = 'app-theme'; // Key for localStorage
const LIGHT_ICON = '☀️';
const DARK_ICON = '🌙';

/**
 * Applies the specified theme (light or dark) to the body element and updates the switcher icon.
 * @param {string} theme The theme to apply ('light' or 'dark').
 */
function applyTheme(theme) {
    const bodyElement = document.body;
    const themeSwitcherButton = document.getElementById('themeSwitcher');

    if (!bodyElement) {
        console.error("Document body element not found. Cannot apply theme.");
        return;
    }

    // Remove existing theme classes
    bodyElement.classList.remove('theme-light', 'theme-dark');

    // Add the new theme class and update the button
    if (theme === LIGHT_THEME) {
        bodyElement.classList.add('theme-light');
        if (themeSwitcherButton) {
            themeSwitcherButton.textContent = DARK_ICON;
            themeSwitcherButton.title = 'Switch to Dark Theme';
        }
    } else { // Default to dark theme if invalid theme is passed
        bodyElement.classList.add('theme-dark');
        if (themeSwitcherButton) {
            themeSwitcherButton.textContent = LIGHT_ICON;
            themeSwitcherButton.title = 'Switch to Light Theme';
        }
    }

    // Save preference to localStorage
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
        console.warn('Could not save theme preference to localStorage:', e);
        // Optionally inform user if storage is unavailable
        // if (typeof addLogMessage === 'function') {
        //     addLogMessage("⚠️ Could not save theme preference.", 'warn');
        // }
    }
}

/**
 * Toggles the theme between light and dark.
 */
function toggleTheme() {
    const bodyElement = document.body;
    if (!bodyElement) {
        console.error("Document body element not found. Cannot toggle theme.");
        return;
    }

    // Determine current theme based on class
    const currentTheme = bodyElement.classList.contains('theme-light') ? LIGHT_THEME : DARK_THEME;
    // Switch to the other theme
    const newTheme = currentTheme === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;

    applyTheme(newTheme);

    // Log the theme switch (optional)
    if (typeof addLogMessage === 'function') {
        addLogMessage(`🎨 Switched to ${newTheme} theme.`, 'info');
    } else {
        console.log(`Switched to ${newTheme} theme.`);
    }
}

/**
 * Loads the saved theme from localStorage or defaults to dark theme.
 */
function loadTheme() {
    let preferredTheme = DARK_THEME; // Default theme

    try {
        const savedTheme = localStorage.getItem(THEME_KEY);
        if (savedTheme && (savedTheme === LIGHT_THEME || savedTheme === DARK_THEME)) {
            preferredTheme = savedTheme;
        }
    } catch (e) {
        console.warn('Could not load theme preference from localStorage:', e);
    }

    applyTheme(preferredTheme);
    console.log(`Applied initial theme: ${preferredTheme}`);
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    const themeSwitcherButton = document.getElementById('themeSwitcher');
    if (themeSwitcherButton) {
        themeSwitcherButton.addEventListener('click', toggleTheme);
    } else {
        console.warn("Theme switcher button ('themeSwitcher') not found.");
    }
    // Load the theme immediately after DOM is ready
    loadTheme();
    console.log("Theme Manager initialized.");
});