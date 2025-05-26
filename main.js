const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const remote = require('@electron/remote/main');

// Initialize remote module
remote.initialize();

let mainWindow;
let outputWindows = []; // Keep track of all output windows
let currentOutputWindow = null;

function createWindow() {
    // Create the main window
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    remote.enable(mainWindow.webContents);
    mainWindow.loadFile('index.html');
}

function createOutputWindow() {
    // Create a new output window
    const outputWindow = new BrowserWindow({
        width: 600,
        height: 400,
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    // Add to array of windows
    outputWindows.push(outputWindow);

    remote.enable(outputWindow.webContents);
    outputWindow.loadFile('output-window.html');
    
    // Calculate position for cascading windows
    const offset = 30 * (outputWindows.length - 1);
    const [x, y] = outputWindow.getPosition();
    outputWindow.setPosition(x + offset, y + offset);
    
    // Handle window controls
    const windowId = outputWindow.id;
    ipcMain.on(`window-control-${windowId}`, (event, command) => {
        if (!outputWindow || outputWindow.isDestroyed()) return;
        
        switch (command) {
            case 'minimize':
                outputWindow.minimize();
                break;
            case 'maximize':
                if (outputWindow.isMaximized()) {
                    outputWindow.unmaximize();
                } else {
                    outputWindow.maximize();
                }
                break;
            case 'close':
                outputWindow.destroy();
                break;
        }
    });
    
    // Handle Lua control commands
    ipcMain.on(`lua-control-${windowId}`, (event, { command }) => {
        mainWindow.webContents.send('lua-control', command);
    });

    // Handle window close
    outputWindow.on('closed', () => {
        // Remove window from array and clean up IPC listeners
        const index = outputWindows.indexOf(outputWindow);
        if (index > -1) {
            outputWindows.splice(index, 1);
        }
        ipcMain.removeAllListeners(`window-control-${windowId}`);
        ipcMain.removeAllListeners(`lua-control-${windowId}`);
    });
    
    return outputWindow;
}

// Handle Lua output from the main window
ipcMain.on('lua-output', (event, data) => {
    if (data.type === 'start') {
        // Create a new window only when execution starts
        currentOutputWindow = createOutputWindow();
        event.reply('window-created', currentOutputWindow.id);
    }
    
    // Send output to current window if it exists
    if (currentOutputWindow && !currentOutputWindow.isDestroyed()) {
        currentOutputWindow.webContents.send('lua-output', {
            ...data,
            windowId: currentOutputWindow.id
        });
    }
    
    // Clear the reference when execution stops
    if (data.type === 'stop' || data.type === 'error') {
        currentOutputWindow = null;
    }
});

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