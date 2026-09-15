'use strict';
// Android self-update: the app is a sideloaded APK, so updates arrive as raw
// APKs from GitHub releases (same repo as the Electron updater's provider).
// This checks the releases API, downloads the APK to <home>/AniBrowser/updates/,
// and reports the path to the UI — which opens an anibrowser-install://apk?path=…
// link that the Expo shell intercepts and routes to the system installer via
// FileProvider. Same export shape as the Electron updater.js so server.js's
// lazy require('./updater') resolves unchanged.
// NOTE: the releases API is queried unauthenticated, so it only sees *published*
// releases — draft releases on GitHub are invisible to this check.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { version: APP_VERSION } = require('./package.json');

const API_LATEST = 'https://api.github.com/repos/RichardPersaud/AniBrowser/releases/latest';
const API_LIST = 'https://api.github.com/repos/RichardPersaud/AniBrowser/releases?per_page=10';

let status = { state: 'idle', version: null, progress: 0, error: null, apkUrl: null, apkPath: null };
let inited = false;

function setState(next) { status = { ...status, ...next }; }

// numeric x.y.z compare; prerelease suffixes are ignored
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'AniBrowser', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub API ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// find the newest published release that ships an .apk asset
async function findApkRelease() {
  try {
    const rel = await fetchJson(API_LATEST);
    const asset = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith('.apk'));
    if (asset) return { version: rel.tag_name, apkUrl: asset.browser_download_url };
  } catch { /* fall through to the list */ }
  const rels = await fetchJson(API_LIST);
  for (const rel of rels) {
    const asset = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith('.apk'));
    if (asset) return { version: rel.tag_name, apkUrl: asset.browser_download_url };
  }
  throw new Error('No release with an APK asset found');
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (${res.statusCode})`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest + '.part');
      res.on('data', (c) => {
        got += c.length;
        if (total) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(dest + '.part', dest);
        resolve(dest);
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function initUpdater() {
  if (inited) return;
  inited = true;
  // first check shortly after launch, then every 6h (mirrors the Electron cadence)
  setTimeout(() => { check().catch(() => { /* status already carries the error */ }); }, 30000);
  setInterval(() => { check().catch(() => { /* next tick retries */ }); }, 6 * 60 * 60 * 1000);
}

async function check() {
  try {
    const { version, apkUrl } = await findApkRelease();
    if (cmpVer(version, APP_VERSION) > 0) {
      setState({ state: 'available', version, apkUrl, error: null });
    } else {
      setState({ state: 'idle', version: null, apkUrl: null, error: null });
    }
  } catch (e) {
    setState({ state: 'idle', error: String(e.message || e) });
  }
  return status;
}

function updaterStatus() {
  return status;
}

async function updaterAction(action) {
  if (action === 'check') return check();
  if (action === 'download') {
    if (status.state !== 'available') throw new Error('No update available to download');
    const dest = path.join(os.homedir(), 'AniBrowser', 'updates', `AniBrowser-${String(status.version).replace(/^v/, '')}.apk`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    setState({ state: 'downloading', progress: 0, apkPath: dest });
    try {
      await download(status.apkUrl, dest, (p) => { status.progress = p; });
      setState({ state: 'ready', progress: 100 });
    } catch (e) {
      setState({ state: 'available', progress: 0, error: String(e.message || e) });
      throw e;
    }
    return status;
  }
  if (action === 'install') {
    // nothing to do server-side: the UI opens the anibrowser-install:// link
    // itself and the Expo shell hands the APK to the system installer
    if (status.state !== 'ready') throw new Error('Update not downloaded yet');
    return status;
  }
  throw new Error(`Unknown update action: ${action}`);
}

module.exports = { initUpdater, updaterStatus, updaterAction };