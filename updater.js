'use strict';
// In-app auto-update: electron-updater with the GitHub provider (configured in
// package.json build.publish). The app checks on launch and every 6h, tells
// the UI via server.js /api/update routes, and downloads/installs only when
// the user clicks. Inert in dev (unpackaged) builds.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let status = { state: 'idle', version: null, progress: 0, error: null };
let inited = false;

function initUpdater() {
  if (!app.isPackaged) return; // never auto-update a dev checkout
  if (inited) return;
  inited = true;

  autoUpdater.autoDownload = false; // user-driven download
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console; // updater diagnostics land in the app log

  autoUpdater.on('update-available', (info) => {
    status = { state: 'available', version: info.version, progress: 0, error: null };
  });
  autoUpdater.on('update-not-available', () => {
    status = { state: 'idle', version: null, progress: 0, error: null };
  });
  autoUpdater.on('download-progress', (p) => {
    if (status.state === 'downloading') status.progress = Math.round(p.percent);
  });
  autoUpdater.on('update-downloaded', (info) => {
    status = { state: 'ready', version: info.version, progress: 100, error: null };
  });
  autoUpdater.on('error', (e) => {
    // keep the UI honest but don't nag: an update failure reverts to idle
    status = { state: 'idle', version: status.version, progress: 0, error: String(e && e.message || e) };
  });

  // first check shortly after launch so the window isn't busy at startup
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) { status.error = String(e.message || e); } }, 30000);
  setInterval(() => { try { autoUpdater.checkForUpdates(); } catch { /* next tick retries */ } }, 6 * 60 * 60 * 1000);
}

function updaterStatus() {
  if (!app.isPackaged) return { ...status, disabled: true };
  return status;
}

async function updaterAction(action) {
  if (!app.isPackaged) throw new Error('Auto-update is disabled in dev mode');
  if (action === 'check') {
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.update && r.update.version;
    if (v && v !== app.getVersion()) status = { state: 'available', version: v, progress: 0, error: null };
    return status;
  }
  if (action === 'download') {
    if (status.state !== 'available') throw new Error('No update available to download');
    status = { ...status, state: 'downloading', progress: 0 };
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      status = { state: 'idle', version: status.version, progress: 0, error: String(e.message || e) };
      throw e;
    }
    return status;
  }
  if (action === 'install') {
    if (status.state !== 'ready') throw new Error('Update not downloaded yet');
    // window-all-closed would quit before the installer takes over
    app.removeAllListeners('window-all-closed');
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ...status, state: 'installing' };
  }
  throw new Error(`Unknown update action: ${action}`);
}

module.exports = { initUpdater, updaterStatus, updaterAction };