const { app, BrowserWindow } = require('electron');
const path = require('path');
const remote = require('@electron/remote/main');

// Initialize remote module
remote.initialize();

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    // Enable remote module for this window
    remote.enable(win.webContents);
    
    win.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require('electron').app.isPackaged) {
  // Custom protocol handler for app
  app.setAsDefaultProtocolClient('lua-editor');
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
}); 