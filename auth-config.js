// Auth0 Configuration - UPDATED FOR ELECTRON
// Handles both development and production environments

const AUTH_CONFIG = {
    domain: 'dev-gr470ilp853dpksw.us.auth0.com', // Your Auth0 domain
    clientId: 'W6jFin3qibuVqI6wYGQCgecwlC34aSWm',
    audience: 'https://looper-api.example.com', // UPDATE: Use your actual API identifier

    // Enhanced redirect URI handling for Electron
    redirectUri: (() => {
        // Check if running in Electron
        if (typeof window !== 'undefined' && window.electronAPI) {
            // Production Electron app - use localhost
            return 'http://localhost:3000/callback.html';
        }

        // Check protocol for file-based Electron
        if (window.location.protocol === 'file:') {
            // Development Electron or packaged app using file://
            return 'http://localhost:3000/callback.html';
        }

        // Web browser (development server)
        return window.location.origin + '/callback.html';
    })(),

    logoutUri: (() => {
        // Check if running in Electron
        if (typeof window !== 'undefined' && window.electronAPI) {
            return 'http://localhost:3000/login.html';
        }

        // Check protocol for file-based Electron
        if (window.location.protocol === 'file:') {
            return 'http://localhost:3000/login.html';
        }

        // Web browser
        return window.location.origin + '/login.html';
    })(),

    scope: 'openid profile email offline_access'
};

// Debug logging
console.log('Auth0 Config:', {
    domain: AUTH_CONFIG.domain,
    clientId: AUTH_CONFIG.clientId,
    redirectUri: AUTH_CONFIG.redirectUri,
    logoutUri: AUTH_CONFIG.logoutUri,
    protocol: window.location.protocol,
    isElectron: typeof window !== 'undefined' && window.electronAPI
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AUTH_CONFIG;
}