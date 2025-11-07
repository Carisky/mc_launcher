const { BrowserWindow } = require('electron');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const preloadPath = path.join(appRoot, 'preload.js');
const indexHtmlPath = path.join(appRoot, 'renderer', 'index.html');

let mainWindow = null;

const getMainWindow = () => {
  if (mainWindow && mainWindow.isDestroyed()) {
    mainWindow = null;
  }
  return mainWindow;
};

const createWindow = () => {
  const existing = getMainWindow();
  if (existing) {
    return existing;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    resizable: true,
    minWidth: 1024,
    minHeight: 680,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(indexHtmlPath);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
};

module.exports = {
  createWindow,
  getMainWindow
};
