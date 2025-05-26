const { app, BrowserWindow } = require('electron');
const path = require('path');
const remoteMain = require('@electron/remote/main');

// Initialize remote module
remoteMain.initialize();

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });

  // Enable remote module for this window
  remoteMain.enable(mainWindow.webContents);

  mainWindow.loadFile('index.html');
  
  // Open DevTools by default for debugging
  mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require('electron').app.isPackaged) {
  // Custom protocol handler for app
  app.setAsDefaultProtocolClient('lua-editor');
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
}); 