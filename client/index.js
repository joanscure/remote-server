const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false, // Stealth mode
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')); 
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Salir', click: () => { app.quit(); } }
    ]);
    tray.setToolTip('SimpleRemote Agent');
    tray.setContextMenu(contextMenu);
}

// IPC Handler for Screen Sources
ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts) => {
    try {
        const sources = await desktopCapturer.getSources(opts);
        return sources;
    } catch (e) {
        console.error("Error getting screen sources:", e);
        return [];
    }
});

// IPC Handler for Logging
ipcMain.on('LOG_MESSAGE', (event, message) => {
    console.log(message); // Print to terminal
    try {
        fs.appendFileSync(path.join(__dirname, 'debug.log'), message + '\n');
    } catch (e) {
        console.error("Failed to write to log file:", e);
    }
});

app.on('ready', () => {
    createWindow();
    createTray();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});