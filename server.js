'use strict';
// Local HTTP server: serves the UI, JSON API, and proxies HLS traffic so the
// player can add the required Referer (browsers forbid setting that header).

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');
const scraper = require('./scraper');
// lazy: updater.js imports electron, so a plain `node server` (tests/probes)
// must not load it until an /api/update call actually needs it
let updater = null;
function updaterMod() {
  if (!updater) updater = require('./updater');
  return updater;
}
// lazy for the same reason: plain-node tests/probes must not load the cloud
// module (which reads the auth file and can touch the network)
let cloud = null;
function cloudMod() {
  if (!cloud) cloud = require('./cloud');
  return cloud;
}
const VERSION = require('./package.json').version;

const UI_DIR = path.join(__dirname, 'ui');
let dataDir = null; // Documents/AniBrowser — set by start(); null in plain-node tests
const BACKUP_FILE = 'anibrowser-data.json';
const RECENT_TTL = 5 * 60 * 1000;
let recent = null; // { t, results }
const UPCOMING_TTL = 30 * 60 * 1000;
let upcoming = null; // { t, page, results }
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function b64enc(s) {
  return Buffer.from(s).toString('base64url');
}
function b64dec(s) {
  return Buffer.from(s, 'base64url').toString();
}

// Wrap an absolute URL so requests go through our /stream proxy.
function proxied(absUrl, referer) {
  const p = new URLSearchParams();
  p.set('u', b64enc(absUrl));
  if (referer) p.set('r', b64enc(referer));
  return '/stream?' + p.toString();
}

function rewritePlaylist(text, baseUrl, referer) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // rewrite URIs inside tags like #EXT-X-KEY / #EXT-X-MAP
        return line.replace(/URI="([^"]*)"/g, (m, u) => {
          const abs = new URL(u, baseUrl).href;
          return `URI="${proxied(abs, referer)}"`;
        });
      }
      return proxied(new URL(t, baseUrl).href, referer);
    })
    .join('\n');
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

/* ---- durable backup (settings / favorites / watch history) ----
   Written to <Documents>/AniBrowser/anibrowser-data.json so updates and
   reinstalls can't wipe what localStorage in the app's own data dir holds.
   Documents can sit behind OneDrive, whose sync filter can stall file ops
   for a long time — so the dir is resolved once at startup (with a timeout
   and a fallback to the user profile) and every write is async + queued,
   never blocking the request or the main process. */

let backupDir = null; // resolved async at startup
let backupReady = null; // promise
let writeQueue = Promise.resolve(); // serialize writes

async function resolveBackupDir(requested) {
  if (requested) {
    try {
      await Promise.race([
        fsp.mkdir(requested, { recursive: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out (cloud sync stall?)')), 10000)),
      ]);
      // prove it is actually writable before trusting it
      const probe = path.join(requested, '.write-test');
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe);
      return requested;
    } catch (e) {
      console.warn('[backup] cannot use', requested, '-', e.message);
      console.warn('[backup] falling back to', os.homedir());
    }
  }
  const fallback = path.join(os.homedir(), 'AniBrowser');
  try {
    await fsp.mkdir(fallback, { recursive: true });
    return fallback;
  } catch (e) {
    console.error('[backup] fallback dir also failed:', e.message);
    return null;
  }
}

function initBackup(requestedDir) {
  backupReady = resolveBackupDir(requestedDir).then((d) => {
    backupDir = d;
    if (d) console.log('[backup] data dir:', d);
    return d;
  });
}

function backupPath() {
  return backupDir ? path.join(backupDir, BACKUP_FILE) : null;
}

async function readBackup() {
  if (!backupDir) return null;
  try {
    return JSON.parse(await fsp.readFile(backupPath(), 'utf8'));
  } catch {
    return null; // missing or unreadable = no backup yet
  }
}

async function writeBackup(data) {
  const file = backupPath();
  if (!file) return;
  // write-then-rename so a crash mid-write can't leave a truncated file
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

function queueBackupWrite(data) {
  writeQueue = writeQueue
    .then(async () => {
      await backupReady; // dir resolution (bounded by its own timeout)
      await writeBackup(data);
      console.log(`[backup] saved ${backupPath()}`);
      // cloud sync mirrors the file — fire-and-forget, debounced inside cloud.js
      try { cloudMod().onLocalDataChanged(); } catch { /* never block the write */ }
    })
    .catch((e) => console.error('[backup] write failed:', e.message));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('Body too large')); // 3 small blobs, way under
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; " +
        "style-src 'self' 'unsafe-inline'",
    });
    res.end(data);
  });
}

async function handleStream(req, res, q) {
  const target = b64dec(q.get('u'));
  const referer = q.get('r') ? b64dec(q.get('r')) : undefined;
  if (!/^https?:\/\//.test(target)) {
    res.writeHead(400);
    return res.end('Bad target');
  }
  const headers = { 'User-Agent': scraper.UA };
  if (referer) headers.Referer = referer;
  if (req.headers.range) headers.Range = req.headers.range;

  // abort the upstream request when the client goes away early (hls.js does this a lot)
  const ctrl = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return; // normal completion — nothing to cancel
    try {
      ctrl.abort();
    } catch {
      // abort() can throw while the request is being torn down; never crash
    }
  });

  let up;
  try {
    up = await openSegment(target, headers, ctrl);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return; // client vanished mid-request
    throw e;
  }
  const ctype = (up.headers['content-type'] || '').toLowerCase();
  const pathNoQuery = target.split('?')[0];
  const isPlaylist = ctype.includes('mpegurl') || pathNoQuery.endsWith('.m3u8');

  if (isPlaylist) {
    const text = await readBody(up.res);
    const base = (up.url && up.url !== target ? up.url : target).split('?')[0];
    const out = rewritePlaylist(text, base, referer);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(out);
  }

  const h = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers[k];
    if (v) h[k] = v;
  }
  h['Access-Control-Allow-Origin'] = '*';
  res.writeHead(up.status, h);
  if (up.res) {
    // pipeline cleans up both sides on error/destroy; errors here are routine
    // (client seek/abort mid-segment) and must never surface as uncaught exceptions
    pipeline(up.res, res, () => {});
  } else {
    res.end();
  }
}

// Stream CDNs start hanging a keep-alive connection after ~15 segments have
// gone over it (measured 20-40s stalls — the exact "buffers a lot" symptom),
// while a fresh socket per segment has never stalled. So HLS traffic goes out
// over plain http/https with keep-alive off instead of undici's pooled fetch.
const freshAgents = {
  'http:': new http.Agent({ keepAlive: false }),
  'https:': new https.Agent({ keepAlive: false }),
};

function openSegment(target, headers, ctrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('too many redirects'));
    let u;
    try {
      u = new URL(target);
    } catch {
      return reject(new Error('Bad target'));
    }
    const agent = freshAgents[u.protocol];
    if (!agent) return reject(new Error('Bad protocol: ' + u.protocol));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { agent, method: 'GET', headers });
    req.setTimeout(30000, () => req.destroy(new Error('upstream timeout')));
    ctrl.signal.addEventListener('abort', () => {
      const err = new Error('client went away');
      err.name = 'AbortError';
      req.destroy(err);
    }, { once: true });
    req.on('response', (r) => {
      const loc = r.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(r.statusCode)) {
        r.resume(); // discard the redirect body
        resolve(openSegment(new URL(loc, u).href, headers, ctrl, depth + 1));
        return;
      }
      resolve({ status: r.statusCode || 502, headers: r.headers, res: r, url: u.href });
    });
    req.on('error', reject);
    req.end();
  });
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const q = url.searchParams;
  const p = url.pathname;

  if (p === '/api/search') {
    const results = await scraper.search(q.get('q') || '', parseInt(q.get('page') || '1', 10));
    return sendJson(res, 200, { results });
  }

  if (p === '/api/recent') {
    // short TTL cache so revisiting Home doesn't hammer the source site
    const now = Date.now();
    if (!recent || now - recent.t > RECENT_TTL) {
      recent = { t: now, results: await scraper.recentlyUpdated(1) };
    }
    return sendJson(res, 200, { results: recent.results });
  }

  if (p === '/api/upcoming') {
    // not-yet-aired shows with their premiere dates (top-upcoming page);
    // longer TTL than /recent since the list changes slowly
    const page = parseInt(q.get('page') || '1', 10) || 1;
    const now = Date.now();
    if (!upcoming || upcoming.page !== page || now - upcoming.t > UPCOMING_TTL) {
      upcoming = { t: now, page, results: await scraper.upcoming(page) };
    }
    return sendJson(res, 200, { results: upcoming.results });
  }

  if (p === '/api/collection') {
    // studio / producer listing pages, e.g. /studios/dle
    const cpath = q.get('path') || '';
    if (!/^\/(studios|producers)\/[a-z0-9-]+$/i.test(cpath)) {
      return sendJson(res, 400, { error: 'Bad path' });
    }
    const page = parseInt(q.get('page') || '1', 10) || 1;
    try {
      return sendJson(res, 200, await scraper.browsePath(cpath, page));
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/export' && req.method === 'GET') {
    // write everything we hold about the user to a dated JSON file they can
    // grab from their AniBrowser data folder (the WebView can't trigger
    // browser downloads, so the server materializes the file instead)
    await backupReady;
    if (!backupDir) return sendJson(res, 500, { error: 'Data folder unavailable' });
    const payload = (await readBackup()) || {
      prefs: {}, favorites: {}, progress: {}, savedAt: null,
    };
    payload.exportedAt = new Date().toISOString();
    const file = path.join(
      backupDir,
      `anibrowser-export-${new Date().toISOString().slice(0, 10)}.json`
    );
    await fsp.writeFile(file, JSON.stringify(payload, null, 2));
    return sendJson(res, 200, { path: file, filename: path.basename(file) });
  }

  if (p === '/api/detail') {
    const slug = q.get('slug') || '';
    if (!/^[a-z0-9-]+$/i.test(slug)) return sendJson(res, 400, { error: 'Bad slug' });
    try {
      return sendJson(res, 200, await scraper.details(slug));
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/browse') {
    const opts = {};
    const letter = (q.get('letter') || '').toLowerCase();
    if (/^(all|0-9|other|[a-z])$/.test(letter)) opts.letter = letter;
    for (const k of ['type', 'status', 'rating', 'score', 'season', 'language', 'sort', 'genre']) {
      const v = q.get(k);
      if (v) opts[k] = v;
    }
    opts.page = parseInt(q.get('page') || '1', 10) || 1;
    const { results, totalPages, page } = await scraper.browse(opts);
    return sendJson(res, 200, { results, totalPages, page });
  }

  if (p === '/api/backup') {
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        // respond immediately; the actual write is queued and async
        queueBackupWrite({
          prefs: body.prefs && typeof body.prefs === 'object' ? body.prefs : {},
          favorites: body.favorites && typeof body.favorites === 'object' ? body.favorites : {},
          progress: body.progress && typeof body.progress === 'object' ? body.progress : {},
          savedAt: new Date().toISOString(),
        });
        return sendJson(res, 200, { ok: true });
      }
      await backupReady; // bounded by resolveBackupDir's timeout
      return sendJson(res, 200, { data: await readBackup(), dir: backupDir });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/version') {
    await backupReady;
    return sendJson(res, 200, { version: VERSION, backupDir });
  }

  if (p === '/api/update') {
    const { updaterStatus, updaterAction } = updaterMod();
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let action = '';
      try { action = JSON.parse(body).action || ''; } catch { /* invalid body */ }
      try {
        return sendJson(res, 200, await updaterAction(action));
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e), status: updaterStatus() });
      }
    }
    return sendJson(res, 200, updaterStatus());
  }

  if (p === '/api/episodes') {
    const eps = await scraper.episodes(q.get('slug') || '');
    // flag episodes known to be unresolvable (all embeds dead) so the UI can
    // mark them in the list instead of a certain failure on click
    for (const ep of eps) {
      if (scraper.isDeadEp(ep.epId)) ep.dead = true;
    }
    return sendJson(res, 200, { episodes: eps });
  }

  if (p === '/api/epcounts' && req.method === 'POST') {
    // batched episode counts for the favorites new-episode checker
    let body = '';
    for await (const chunk of req) body += chunk;
    let slugs = [];
    try { slugs = JSON.parse(body).slugs || []; } catch { /* treated as empty */ }
    slugs = slugs.filter((s) => /^[a-z0-9-]+$/i.test(String(s))).slice(0, 100);
    const out = {};
    await Promise.all(slugs.map(async (s) => {
      try { out[s] = (await scraper.episodes(s)).length; }
      catch { /* leave the slug out on failure */ }
    }));
    return sendJson(res, 200, { counts: out });
  }

  if (p === '/api/sources') {
    const slug = q.get('slug') || '';
    const ep = q.get('ep') || '';
    const type = q.get('type') === 'dub' ? 'dub' : 'sub';
    console.log(`[api] sources slug=${slug} ep=${ep} type=${type}`);
    const t0 = Date.now();
    try {
      // hard bound: never let the renderer wait forever
      let timeoutId;
      const src = await Promise.race([
        scraper.getSources(slug, ep, type),
        new Promise((_, rej) => {
          timeoutId = setTimeout(
            () => rej(new Error('Timed out resolving sources')),
            75000
          );
        }),
      ]);
      clearTimeout(timeoutId);
      console.log(`[api] sources OK in ${Date.now() - t0}ms (${slug} ep ${ep})`);
      src.proxiedUrl = proxied(src.url, src.referer);
      for (const s of src.subtitles) {
        if (s.src) s.proxiedSrc = proxied(s.src, src.referer);
      }
      return sendJson(res, 200, src);
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e), fallbackType: e.fallbackType });
    }
  }

  if (p === '/stream') {
    return handleStream(req, res, q);
  }

  // ---- cloud sync (Google via Supabase) ----
  if (p === '/auth/callback') {
    console.log('[cloud] callback query:', q.toString() || '(empty)');
    const page = await cloudMod().handleCallback(q);
    // the system browser loads this page — plain HTML, no app CSP
    res.writeHead(page.status, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page.html);
  }
  if (p === '/api/auth/start') {
    const r = await cloudMod().startSignIn();
    return sendJson(res, r.ok ? 200 : (r.error && r.error.startsWith('Sign-in port') ? 409 : 400), r);
  }
  if (p === '/api/auth/status') {
    return sendJson(res, 200, cloudMod().status());
  }
  if (p === '/api/auth/logout') {
    await cloudMod().signOut();
    return sendJson(res, 200, { ok: true, ...cloudMod().status() });
  }
  if (p === '/api/sync') {
    cloudMod().syncNow();
    return sendJson(res, 200, cloudMod().status());
  }

  return serveStatic(req, res, p);
}

function start(opts = {}) {
  dataDir = opts.dataDir || null;
  initBackup(dataDir);
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error('Request error:', e);
      if (!res.headersSent) {
        sendJson(res, 500, { error: String((e && e.message) || e) });
      } else {
        res.end();
      }
    });
  });
  // the cloud sign-in redirect lands on a FIXED port (registered in the
  // Supabase dashboard); if it's taken, fall back to random — sign-in then
  // reports itself unavailable for this session, everything else works
  const port = new Promise((resolve) => {
    const fallback = () => {
      server.removeAllListeners('error');
      server.once('error', () => {}); // a random port can also lose the race — never crash
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    };
    server.once('error', fallback);
    server.listen(cloudMod().AUTH_PORT, '127.0.0.1', () => resolve(server.address().port));
  });
  return port.then((p) => {
    const portIsFixed = p === cloudMod().AUTH_PORT;
    try {
      cloudMod().init({
        dataDir,
        portIsFixed,
        hooks: { readBackup, queueBackupWrite },
      });
    } catch (e) {
      console.warn('[cloud] init failed:', e.message);
    }
    return { server, port: p, preferredPortOk: portIsFixed };
  });
}

module.exports = { start, readBackup };