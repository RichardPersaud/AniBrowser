'use strict';
const path = require('path');
const os = require('os');
const { app, BrowserWindow, Menu, shell } = require('electron');
const { start } = require('./server');
const { initUpdater } = require('./updater');

app.setAppUserModelId('io.local.anibrowser');
Menu.setApplicationMenu(null);

// last-resort safety net: a streaming app sees constant aborted/failed I/O;
// log it instead of dying with the "JavaScript error in the main process" dialog
process.on('uncaughtException', (e) => {
  console.error('[suppressed uncaughtException]', e && (e.stack || e.message || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[suppressed unhandledRejection]', e && (e.stack || e.message || e));
});

async function createWindow(port) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    title: 'AniBrowser',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(async () => {
  // durable backup lives outside the app's own data dir so updates/reinstalls can't wipe it
  let dataDir;
  if (process.platform === 'win32') {
    dataDir = path.join(app.getPath('documents'), 'AniBrowser');
  } else {
    // Linux/macOS: XDG data dir (~/.local/share/AniBrowser) instead of Documents
    dataDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'AniBrowser');
  }
  const { port } = await start({ dataDir });
  initUpdater();
  await createWindow(port);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});