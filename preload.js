const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Store management
    storeUserData: (userData) => ipcRenderer.invoke('store-user-data', userData),
    getUserData: () => ipcRenderer.invoke('get-user-data'),
    clearUserData: () => ipcRenderer.invoke('clear-user-data'),

    // App controls
    closeApp: () => ipcRenderer.invoke('close-app'),
    minimizeApp: () => ipcRenderer.invoke('minimize-app'),

    // Security and external links
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // App info
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getPlatform: () => process.platform,

    // Error handling
    showErrorDialog: (title, content) => ipcRenderer.invoke('show-error-dialog', title, content),

    // Development helpers
    isDevelopment: () => process.env.NODE_ENV === 'development',

    // Event listeners
    onAppReady: (callback) => ipcRenderer.on('app-ready', callback),
    onAuthCallback: (callback) => ipcRenderer.on('auth-callback', callback),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),

    // Remove listeners
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

    // Audio context helpers (for Electron compatibility)
    resumeAudioContext: async () => {
        // This helps with AudioContext resumption in Electron
        if (typeof window !== 'undefined' && window.AudioContext) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (ctx.state === 'suspended') {
                    await ctx.resume();
                }
                return ctx.state;
            } catch (error) {
                console.warn('AudioContext not available:', error);
                return 'unavailable';
            }
        }
        return 'unavailable';
    }
});

// Security: Remove access to Node.js APIs from the renderer process
delete window.require;
delete window.exports;
delete window.module;

// Enhanced security measures
window.addEventListener('DOMContentLoaded', () => {
    // Prevent right-click context menu in production
    if (process.env.NODE_ENV !== 'development') {
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        // Prevent common developer shortcuts in production
        document.addEventListener('keydown', (e) => {
            // Disable F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U, Ctrl+Shift+C
            if (e.key === 'F12' ||
                (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key)) ||
                (e.ctrlKey && e.key === 'U')) {
                e.preventDefault();
            }
        });
    }

    // Enhanced CSP via meta tag injection
    meta.content = `
      default-src 'self' data: blob: https://cdn.auth0.com;
      script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.auth0.com https://*.auth0.com;
      style-src 'self' 'unsafe-inline' https://cdn.auth0.com https://*.auth0.com;
      font-src 'self' https://cdn.auth0.com https://*.auth0.com data:;
      img-src 'self' data: blob: https: http:;
      connect-src 'self' https://*.auth0.com wss: ws:;
      media-src 'self' blob: data:;
      frame-src 'none';
      object-src 'none';
      base-uri 'self';
      form-action 'self';
    `.replace(/\s+/g, ' ').trim();

    document.head.appendChild(meta);

    // Inject app metadata
    const appMeta = document.createElement('meta');
    appMeta.name = 'app-platform';
    appMeta.content = 'electron';
    document.head.appendChild(appMeta);
});

// Audio context enhancement for Electron
window.addEventListener('load', () => {
    // Enhance AudioContext for better Electron compatibility
    if (typeof window.AudioContext !== 'undefined') {
        const OriginalAudioContext = window.AudioContext;

        window.AudioContext = class extends OriginalAudioContext {
            constructor(contextOptions = {}) {
                // Provide better defaults for Electron
                const enhancedOptions = {
                    latencyHint: 'interactive',
                    sampleRate: 44100,
                    ...contextOptions
                };

                super(enhancedOptions);

                // Auto-resume on user interaction
                const autoResume = () => {
                    if (this.state === 'suspended') {
                        this.resume().catch(console.warn);
                    }
                };

                document.addEventListener('click', autoResume, { once: true });
                document.addEventListener('keydown', autoResume, { once: true });
                document.addEventListener('touchstart', autoResume, { once: true });
            }
        };
    }
});

// Expose version info for debugging
console.log('Preload script loaded');
console.log(`Electron: ${process.versions.electron}`);
console.log(`Chrome: ${process.versions.chrome}`);
console.log(`Node: ${process.versions.node}`);
console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);

// Error handling enhancement
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    if (window.electronAPI && window.electronAPI.isDevelopment && !window.electronAPI.isDevelopment()) {
        // In production, could send error reports
        console.log('Error logged for production debugging');
    }
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    event.preventDefault(); // Prevent the default browser behavior
});
