const { app, BrowserWindow, protocol, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const Store = require('electron-store');
const express = require('express'); // Add express for local server

// Configure logging
log.transports.file.resolvePath = () => path.join(app.getPath('userData'), 'logs/main.log');
log.info('App starting...');

// Initialize secure storage
const store = new Store({
    name: 'looper-config',
    defaults: {
        windowBounds: { width: 1400, height: 900 },
        user: null
    }
});

// Keep a global reference of the window object
let mainWindow;
let splash;
let authServer; // Express server for auth callbacks

// Set app user model ID for Windows notifications
if (process.platform === 'win32') {
    app.setAppUserModelId('com.looper.auth0app');
}

// Enable live reload for development
if (process.env.NODE_ENV === 'development') {
    try {
        require('electron-reload')(__dirname, {
            electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
            hardResetMethod: 'exit'
        });
    } catch (err) {
        log.warn('electron-reload not available');
    }
}

function createAuthServer() {
    return new Promise((resolve, reject) => {
        const authApp = express();
        const PORT = 3000;

        // Serve static files
        authApp.use(express.static(__dirname));

        // Handle callback route
        authApp.get('/callback.html', (req, res) => {
            log.info('Auth callback received:', req.url);
            res.sendFile(path.join(__dirname, 'callback.html'));
        });

        // Handle login route
        authApp.get('/login.html', (req, res) => {
            res.sendFile(path.join(__dirname, 'login.html'));
        });

        // Handle app route
        authApp.get('/app.html', (req, res) => {
            res.sendFile(path.join(__dirname, 'app.html'));
        });

        // Default route
        authApp.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });

        authServer = authApp.listen(PORT, 'localhost', (err) => {
            if (err) {
                log.error('Failed to start auth server:', err);
                reject(err);
            } else {
                log.info(`Auth server running on http://localhost:${PORT}`);
                resolve(`http://localhost:${PORT}`);
            }
        });
    });
}

function createSplashWindow() {
    splash = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        alwaysOnTop: true,
        transparent: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Create simple splash screen HTML
    const splashHTML = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body {
                margin: 0;
                padding: 0;
                background: linear-gradient(135deg, #191b22 0%, #23283a 100%);
                color: #22ffe8;
                font-family: 'Segoe UI', sans-serif;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
                text-align: center;
            }
            .logo { font-size: 4em; margin-bottom: 20px; }
            .title { font-size: 1.8em; margin-bottom: 10px; font-weight: bold; }
            .subtitle { font-size: 1em; color: #a0b3c7; }
            .spinner {
                width: 40px;
                height: 40px;
                border: 4px solid rgba(34, 255, 232, 0.2);
                border-top: 4px solid #22ffe8;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 20px auto;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    </head>
    <body>
        <div class="logo">🎛️</div>
        <div class="title">Looper Professional</div>
        <div class="subtitle">Loading...</div>
        <div class="spinner"></div>
    </body>
    </html>`;

    splash.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(splashHTML));

    setTimeout(() => {
        if (splash) {
            splash.close();
            splash = null;
        }
    }, 3000);
}

async function createWindow() {
    // Get stored window bounds
    const { width, height, x, y } = store.get('windowBounds');

    mainWindow = new BrowserWindow({
        width: width || 1400,
        height: height || 900,
        x: x,
        y: y,
        minWidth: 1000,
        minHeight: 700,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            preload: path.join(__dirname, 'preload.js')
        },
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        backgroundColor: '#191b22'
    });

    // Load the app
    try {
        const serverUrl = await createAuthServer();
        await mainWindow.loadURL(serverUrl);

        // Show window after content is loaded
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
            if (splash) {
                splash.close();
                splash = null;
            }
        });

    } catch (error) {
        log.error('Failed to create auth server or load URL:', error);

        // Fallback to file protocol
        await mainWindow.loadFile('index.html');
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
            if (splash) {
                splash.close();
                splash = null;
            }
        });
    }

    // Save window bounds on close
    mainWindow.on('close', () => {
        store.set('windowBounds', mainWindow.getBounds());
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (authServer) {
            authServer.close();
            authServer = null;
        }
    });

    // Development tools
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// App event handlers
app.whenReady().then(() => {
    createSplashWindow();
    setTimeout(createWindow, 1000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (authServer) {
        authServer.close();
        authServer = null;
    }
    if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
ipcMain.handle('store-user-data', async (event, userData) => {
    store.set('user', userData);
    return userData;
});

ipcMain.handle('get-user-data', async (event) => {
    return store.get('user');
});

ipcMain.handle('clear-user-data', async (event) => {
    store.delete('user');
    return true;
});

ipcMain.handle('close-app', async (event) => {
    app.quit();
});

ipcMain.handle('minimize-app', async (event) => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('open-external', async (event, url) => {
    await shell.openExternal(url);
});

ipcMain.handle('get-app-version', async (event) => {
    return app.getVersion();
});

ipcMain.handle('show-error-dialog', async (event, title, content) => {
    return dialog.showErrorBox(title, content);
});

// Auto-updater events
autoUpdater.checkForUpdatesAndNotify();

autoUpdater.on('update-available', () => {
    log.info('Update available');
    if (mainWindow) {
        mainWindow.webContents.send('update-available');
    }
});

autoUpdater.on('update-downloaded', () => {
    log.info('Update downloaded');
    if (mainWindow) {
        mainWindow.webContents.send('update-downloaded');
    }
});