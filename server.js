'use strict';
// Local HTTP server: serves the UI, JSON API, and proxies HLS traffic so the
// player can add the required Referer (browsers forbid setting that header).

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable, pipeline } = require('stream');
const scraper = require('./scraper');
// lazy: updater.js imports electron, so a plain `node server` (tests/probes)
// must not load it until an /api/update call actually needs it
let updater = null;
function updaterMod() {
  if (!updater) updater = require('./updater');
  return updater;
}
const VERSION = require('./package.json').version;

const UI_DIR = path.join(__dirname, 'ui');
let dataDir = null; // Documents/AniBrowser — set by start(); null in plain-node tests
const BACKUP_FILE = 'anibrowser-data.json';
const RECENT_TTL = 5 * 60 * 1000;
let recent = null; // { t, results }
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

  // abort the upstream fetch when the client goes away early (hls.js does this a lot)
  const ctrl = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return; // normal completion — nothing to cancel
    try {
      ctrl.abort();
    } catch {
      // abort() can throw while undici tears down the body stream; never let it crash us
    }
  });

  let up;
  try {
    up = await fetch(target, {
      headers,
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return; // client vanished mid-request
    throw e;
  }
  const ctype = (up.headers.get('content-type') || '').toLowerCase();
  const pathNoQuery = target.split('?')[0];
  const isPlaylist = ctype.includes('mpegurl') || pathNoQuery.endsWith('.m3u8');

  if (isPlaylist) {
    const text = await up.text();
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
    const v = up.headers.get(k);
    if (v) h[k] = v;
  }
  h['Access-Control-Allow-Origin'] = '*';
  res.writeHead(up.status, h);
  if (up.body) {
    // pipeline cleans up both sides on error/destroy; errors here are routine
    // (client seek/abort mid-segment) and must never surface as uncaught exceptions
    pipeline(Readable.fromWeb(up.body), res, () => {});
  } else {
    res.end();
  }
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port })
    );
  });
}

module.exports = { start };