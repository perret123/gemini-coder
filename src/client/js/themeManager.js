const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
const THEME_KEY = 'app-theme';
const LIGHT_ICON = '☀️';
const DARK_ICON = '🌙';

function applyTheme(theme) {
    const bodyElement = document.body;
    const themeSwitcherButton = document.getElementById('themeSwitcher');

    if (!bodyElement) {
        console.error("Document body element not found. Cannot apply theme.");
        return;
    }

    // More robust class removal/addition
    bodyElement.classList.remove('theme-light', 'theme-dark'); // Remove both possibilities
    bodyElement.dataset.theme = theme; // Use data attribute for easier selection

    if (theme === LIGHT_THEME) {
        bodyElement.classList.add('theme-light');
        if (themeSwitcherButton) {
            themeSwitcherButton.textContent = DARK_ICON;
            themeSwitcherButton.title = 'Switch to Dark Theme';
        }
    } else { // Default to dark theme
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
    }
}

function toggleTheme() {
    const bodyElement = document.body;
    if (!bodyElement) {
        console.error("Document body element not found. Cannot toggle theme.");
        return;
    }
    // Determine current theme based on class or data attribute
    const currentTheme = bodyElement.classList.contains('theme-light') ? LIGHT_THEME : DARK_THEME;
    const newTheme = currentTheme === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;

    applyTheme(newTheme);

    // Log the theme switch
    if (typeof addLogMessage === 'function') {
        // ADDED isAction flag
        addLogMessage(`🎨 Switched to ${newTheme} theme.`, 'info', true);
    } else {
        console.log(`Switched to ${newTheme} theme.`);
    }
}

function loadTheme() {
    let preferredTheme = DARK_THEME; // Default to dark
    try {
        const savedTheme = localStorage.getItem(THEME_KEY);
        // Check if saved theme is valid
        if (savedTheme && (savedTheme === LIGHT_THEME || savedTheme === DARK_THEME)) {
            preferredTheme = savedTheme;
        }
        // Add system preference check (optional, but good practice)
        else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
             preferredTheme = LIGHT_THEME;
        }
    } catch (e) {
        console.warn('Could not load theme preference from localStorage:', e);
    }
    applyTheme(preferredTheme);
    console.log(`Applied initial theme: ${preferredTheme}`);
}

// Initialize Theme Manager on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    const themeSwitcherButton = document.getElementById('themeSwitcher');
    if (themeSwitcherButton) {
        themeSwitcherButton.addEventListener('click', toggleTheme);
    } else {
        console.warn("Theme switcher button ('themeSwitcher') not found.");
    }
    loadTheme(); // Load the theme when the DOM is ready
    console.log("Theme Manager initialized.");
});

// ... (existing code) ...

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { applyTheme, toggleTheme, loadTheme };
  }