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

// node os.arch() -> Android ABI tag used in our release asset names
const ARCH_MAP = { arm64: 'arm64-v8a', arm: 'armeabi-v7a', x64: 'x86_64', ia32: 'x86' };

// pick the APK asset matching this device: per-ABI split first (a phone only
// needs its own ~60MB of libs, not the 200MB+ universal set), then universal
function pickApkAsset(assets) {
  const apks = (assets || []).filter((a) => a.name.toLowerCase().endsWith('.apk'));
  const want = ARCH_MAP[os.arch()];
  const byName = (frag) => apks.find((a) => a.name.toLowerCase().includes(frag));
  if (want) {
    const exact = byName(want);
    if (exact) return exact;
  }
  return byName('universal') || apks[0];
}

// find the newest published release that ships an .apk asset
async function findApkRelease() {
  try {
    const rel = await fetchJson(API_LATEST);
    const asset = pickApkAsset(rel.assets);
    if (asset) return { version: rel.tag_name, apkUrl: asset.browser_download_url };
  } catch { /* fall through to the list */ }
  const rels = await fetchJson(API_LIST);
  for (const rel of rels) {
    const asset = pickApkAsset(rel.assets);
    if (asset) return { version: rel.tag_name, apkUrl: asset.browser_download_url };
  }
  throw new Error('No release with an APK asset found');
}

// single attempt; resumes from `have` bytes already in dest.part via Range.
// Errors propagate to download() which retries.
function downloadOnce(url, dest, have, onProgress) {
  return new Promise((resolve, reject) => {
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadOnce(res.headers.location, dest, have, onProgress).then(resolve, reject);
      }
      const canResume = res.statusCode === 206;
      if (!canResume && res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (${res.statusCode})`));
      }
      if (!canResume) have = 0; // server ignored Range — start over
      const cr = String(res.headers['content-range'] || '').split('/')[1];
      const total = Number(cr) || (Number(res.headers['content-length']) || 0) + (canResume ? have : 0);
      let got = canResume ? have : 0;
      const out = fs.createWriteStream(dest + '.part', { flags: canResume ? 'a' : 'w' });
      // nodejs-mobile sockets can die silently mid-body; without a watchdog a
      // stall would hang this promise (and the progress bar) forever
      req.setTimeout(30000, () => req.destroy(new Error('Download stalled (no data for 30s)')));
      req.on('error', (e) => { out.destroy(); reject(e); });
      res.on('error', (e) => { out.destroy(); reject(e); });
      res.on('data', (c) => {
        got += c.length;
        if (total) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => out.close(() => {
        req.destroy(); // disarm the idle watchdog so it can't fire post-rename
        fs.renameSync(dest + '.part', dest);
        resolve(dest);
      }));
    });
    req.on('error', reject);
  });
}

// resilient APK download: resume from the .part file, up to 4 attempts
async function download(url, dest, onProgress) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let have = 0;
    try { if (fs.existsSync(dest + '.part')) have = fs.statSync(dest + '.part').size; } catch { have = 0; }
    try {
      return await downloadOnce(url, dest, have, onProgress);
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

function initUpdater() {
  if (inited) return;
  inited = true;
  // check right after launch (short delay so node boot isn't competing with
  // the WebView handshake), then every 6h (mirrors the Electron cadence)
  setTimeout(() => { check().catch(() => { /* status already carries the error */ }); }, 3000);
  setInterval(() => { check().catch(() => { /* next tick retries */ }); }, 6 * 60 * 60 * 1000);
}

function destFor(version) {
  return path.join(os.homedir(), 'AniBrowser', 'updates', `AniBrowser-${String(version).replace(/^v/, '')}.apk`);
}

async function check() {
  try {
    const { version, apkUrl } = await findApkRelease();
    if (cmpVer(version, APP_VERSION) > 0) {
      const dest = destFor(version);
      if (fs.existsSync(dest)) {
        // downloaded in a previous session — the download state is in-memory
        // only, so don't ask the user to fetch the same APK again
        setState({ state: 'ready', version, apkUrl, apkPath: dest, progress: 100, error: null });
      } else {
        setState({ state: 'available', version, apkUrl, error: null });
      }
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
    // idempotent: a double-tap while a download runs reports status instead of
    // erroring (the UI polls slowly, so the second tap lands mid-download)
    if (status.state === 'downloading') return status;
    if (status.state === 'ready') return status; // already have it
    if (status.state !== 'available') throw new Error('No update available to download');
    const dest = destFor(status.version);
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
    if (!status.apkPath || !fs.existsSync(status.apkPath)) {
      // file vanished (user cleared storage) — force a fresh download
      setState({ state: 'available', progress: 0, apkPath: null, error: null });
      throw new Error('Downloaded APK is missing — download again');
    }
    return status;
  }
  throw new Error(`Unknown update action: ${action}`);
}

module.exports = { initUpdater, updaterStatus, updaterAction };