'use strict';
// In-app auto-update: electron-updater with the GitHub provider (configured in
// package.json build.publish). The app checks on launch and every 6h, tells
// the UI via server.js /api/update routes, and downloads/installs only when
// the user clicks. Inert in dev (unpackaged) builds.
const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

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

  // check right after launch (a short delay keeps the window boot from
  // competing with the network call), then again every 6h
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) { status.error = String(e.message || e); } }, 3000);
  setInterval(() => { try { autoUpdater.checkForUpdates(); } catch { /* next tick retries */ } }, 6 * 60 * 60 * 1000);
}

function updaterStatus() {
  if (!app.isPackaged) return { ...status, disabled: true };
  return status;
}

const GH_LATEST =
  'https://api.github.com/repos/RichardPersaud/AniBrowser/releases/latest';

// electron-updater stages installers in <cache>/AniNinja-updater/pending before
// the restart-and-install step — this is the folder the settings "Open folder"
// button reveals
function downloadDir() {
  return path.join(app.getPath('cache'), 'AniNinja-updater', 'pending');
}

// Dev builds can't self-update (electron-updater needs an installed app), but
// the version check can still run for real: read the latest GitHub release and
// report it. `external: true` tells the UI to link out instead of offering a
// self-download.
async function checkGithub() {
  const res = await fetch(GH_LATEST, {
    headers: { 'User-Agent': 'AniNinja-update-check', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const j = await res.json();
  const latest = String(j.tag_name || '').replace(/^v/i, '');
  if (!latest) throw new Error('Latest release has no version tag');
  if (latest !== app.getVersion()) {
    status = { state: 'available', version: latest, progress: 0, error: null, external: true };
  } else {
    status = { state: 'idle', version: null, progress: 0, error: null };
  }
  return status;
}

async function updaterAction(action) {
  if (!app.isPackaged) {
    if (action === 'check') return checkGithub();
    throw new Error("Dev build can't self-update — get the latest release from GitHub");
  }
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
  if (action === 'openDir') {
    const dir = downloadDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* openPath reports it */ }
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return { ...status, dir };
  }
  throw new Error(`Unknown update action: ${action}`);
}

module.exports = { initUpdater, updaterStatus, updaterAction };