'use strict';
// cloud.js — Supabase sync: Google sign-in (PKCE) + prefs/favorites/progress
// mirror, with the local file staying the offline source of truth.
//
// Hand-rolled on node core only (https/crypto/fs) because the Android zip has
// no node_modules mechanism (see scripts/sync-node.sh) — no supabase-js.
// Every network call follows the house style for nodejs-mobile (sockets stall
// silently there): 30s request watchdog, keep-alive off, small retry budget.
// Nothing in here is ever allowed to reject into the server's request path or
// delay boot/playback — all failures surface in status() and a retry timer.

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---- configuration ---------------------------------------------------------
// Paste from Supabase dashboard → Project Settings → API. The anon key is
// public by design; row-level security (auth.uid() = user_id) protects data.
const SUPABASE_URL = 'https://qsyquiaqfxhokjwlxwtg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzeXF1aWFxZnhob2tqd2x4d3RnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzkxMzcsImV4cCI6MjEwNTMxNTEzN30.ZOpujhhCsIYlUxgsEuxPj2gWr2K6yfl7RH27I3OwDwY';
const AUTH_PORT = 48115;      // must equal the redirect URL registered in the dashboard
const TABLE = 'user_data';
const CALLBACK_PATH = '/auth/callback';
const AUTH_FILE = 'anibrowser-auth.json'; // tokens live here, NOT in the exportable data file
const PENDING_TTL = 10 * 60 * 1000;       // sign-in attempt expires
const PUSH_DEBOUNCE = 3000;               // coalesce the 5s progress saves + 1.5s UI debounce
const BACKOFFS = [60e3, 5 * 60e3, 30 * 60 * 1000]; // network failure backoff ladder
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000; // deletes forget after 30 days

const configured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const apiBase = () => SUPABASE_URL.replace(/\/+$/, '');

// ---- module state ----
let dataDir = null;
let portIsFixed = false;
let session = null;      // { access_token, refresh_token, expires_at, user }
let pending = null;      // { state, code_verifier, redirect_to, createdAt }
let pushTimer = null;
let retryTimer = null;
let syncing = false;
let pullAgain = false;   // a sync was requested while one ran
let lastSync = null;     // Date.now() of last successful round trip
let lastError = null;
let backoffStep = 0;
let dataRev = 0;         // bumps on every sync (UI re-pull trigger)
let hooks = null;        // { readBackup, queueBackupWrite } — set by init(), avoids a circular require

// ---- small helpers ---------------------------------------------------------

const authFile = () => (dataDir ? path.join(dataDir, AUTH_FILE) : null);

async function saveAuthState(extra) {
  const file = authFile();
  if (!file) return;
  const payload = {
    access_token: session?.access_token || null,
    refresh_token: session?.refresh_token || null,
    expires_at: session?.expires_at || 0,
    user: session?.user || null,
    ...extra,
  };
  // write-then-rename so a crash mid-write can't leave a truncated file
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fsp.rename(tmp, file);
}

async function loadAuthState() {
  try {
    const raw = JSON.parse(await fsp.readFile(authFile(), 'utf8'));
    if (raw && raw.refresh_token) {
      session = {
        access_token: raw.access_token || null,
        refresh_token: raw.refresh_token,
        expires_at: raw.expires_at || 0,
        user: raw.user || null,
      };
    }
    if (raw && raw.pending && Date.now() - raw.pending.createdAt < PENDING_TTL) {
      pending = raw.pending;
    }
  } catch { /* missing or unreadable = signed out */ }
}

// One https JSON request. Resolves {status, json} for ANY status (callers
// branch on 401); rejects only on network-level failure. 30s watchdog.
const noKeepAlive = new https.Agent({ keepAlive: false });
function reqJson(method, url, { headers = {}, body } = {}, timeoutMs = 30000, attempt = 0) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(url, {
      method,
      agent: noKeepAlive,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('response', (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error page */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (e) => {
      // nodejs-mobile sockets die silently mid-body: a few linear retries
      // rescue the flaky ones (same policy as node-stub/updater.js)
      if (attempt < 3) {
        setTimeout(() => reqJson(method, url, { headers, body }, timeoutMs, attempt + 1).then(resolve, reject), attempt * 2000);
      } else reject(e);
    });
    if (data) req.write(data);
    req.end();
  });
}

// ---- auth ------------------------------------------------------------------

function newPending() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return {
    state: crypto.randomBytes(16).toString('base64url'),
    code_verifier: verifier,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    redirect_to: `http://127.0.0.1:${AUTH_PORT}${CALLBACK_PATH}`,
    createdAt: Date.now(),
  };
}

// Returns {ok, url} or {ok:false, error}. Never opens the browser itself on
// Android — the UI hands the URL to the shell. Desktop: Electron is opened
// here via the same lazy-require pattern server.js uses for the updater.
async function startSignIn() {
  if (!configured) return { ok: false, error: 'Supabase is not configured in cloud.js' };
  if (!portIsFixed) return { ok: false, error: 'Sign-in port in use — restart the app and try again' };
  pending = newPending();
  await saveAuthState({ pending }).catch(() => {});
  const url = `${apiBase()}/auth/v1/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(pending.redirect_to)}` +
    `&code_challenge=${pending.code_challenge}&code_challenge_method=s256&state=${pending.state}`;
  let opened = false;
  try {
    const electron = require('electron');
    if (electron && electron.shell && electron.shell.openExternal) {
      electron.shell.openExternal(url);
      opened = true;
    }
  } catch { /* not running under Electron (probe scripts / Android) */ }
  return { ok: true, url, opened };
}

async function dropSession() {
  session = null;
  pending = null;
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  pushTimer = retryTimer = null;
  try { await fsp.unlink(authFile()); } catch { /* already gone */ }
}

async function signOut() {
  try {
    if (session?.access_token) {
      await reqJson('POST', `${apiBase()}/auth/v1/logout?scope=global`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      }, 10000);
    }
  } catch { /* best-effort — we discard the session either way */ }
  await dropSession();
  lastError = null;
}

async function refreshSession() {
  const r = await reqJson('POST', `${apiBase()}/auth/v1/token?grant_type=refresh_token`, {
    headers: { apikey: SUPABASE_ANON_KEY },
    body: { refresh_token: session.refresh_token },
  });
  if (r.status === 200 && r.json?.access_token) {
    session = {
      access_token: r.json.access_token,
      refresh_token: r.json.refresh_token || session.refresh_token,
      expires_at: Date.now() + (r.json.expires_in || 3600) * 1000,
      user: r.json.user || session.user,
    };
    await saveAuthState().catch(() => {});
    return true;
  }
  if (r.status === 400 || r.status === 403) {
    // refresh token rotated or revoked elsewhere — network errors land here too
    // only when Supabase rejects the grant, which is the correct signal
    lastError = 'Session expired — sign in again';
    await dropSession();
  }
  return false;
}

let refreshInFlight = null; // single-flight: concurrent 401s share one refresh
async function getAccessToken() {
  if (!session) return null;
  if (session.expires_at - Date.now() > 60000) return session.access_token;
  if (!refreshInFlight) {
    refreshInFlight = refreshSession().finally(() => { refreshInFlight = null; });
  }
  const ok = await refreshInFlight;
  return ok ? session.access_token : null;
}

// Exchange the OAuth code from the loopback callback for a session.
async function exchangeCode(code, state) {
  if (!configured) return { ok: false, error: 'Supabase is not configured' };
  if (!pending) return { ok: false, error: 'No sign-in in progress (or it expired)' };
  // Supabase does NOT echo the caller's state back on the final redirect (it
  // binds the code to its own browser session instead) — so state is only
  // rejected when it IS present and wrong. PKCE protects the exchange itself.
  if (state && state !== pending.state) {
    return { ok: false, error: 'Sign-in state mismatch — was another window involved?' };
  }
  const r = await reqJson('POST', `${apiBase()}/auth/v1/token?grant_type=pkce`, {
    headers: { apikey: SUPABASE_ANON_KEY },
    body: { auth_code: code, code_verifier: pending.code_verifier },
  });
  pending = null;
  if (r.status !== 200 || !r.json?.access_token) {
    lastError = `Sign-in failed (${r.status})`;
    return { ok: false, error: lastError };
  }
  session = {
    access_token: r.json.access_token,
    refresh_token: r.json.refresh_token,
    expires_at: Date.now() + (r.json.expires_in || 3600) * 1000,
    user: {
      id: r.json.user?.id,
      email: r.json.user?.email,
      name: r.json.user?.user_metadata?.name || r.json.user?.email,
      picture: r.json.user?.user_metadata?.avatar_url || r.json.user?.user_metadata?.picture || null,
    },
  };
  await saveAuthState().catch(() => {});
  lastError = null;
  backoffStep = 0;
  syncNow(); // first pull+push with the new account
  return { ok: true, email: session.user.email, name: session.user.name };
}

// ---- merge rules (pure functions) ------------------------------------------
// favorites/progress are dicts keyed by slug, every entry carries `ts`.
// Newer ts wins per key; a tombstone newer than an entry keeps it deleted.

function mergeDicts(local, remote, localTomb = {}, remoteTomb = {}) {
  const out = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    const tomb = Math.max(localTomb[k] || 0, remoteTomb[k] || 0);
    const eL = local[k];
    const eR = remote[k];
    let win = null;
    if (eL && eR) win = (eR.ts || 0) > (eL.ts || 0) ? eR : eL;
    else win = eR || eL || null;
    if (win && (win.ts || 0) >= tomb) out[k] = win;
  }
  const tombs = {};
  for (const k of new Set([...Object.keys(localTomb), ...Object.keys(remoteTomb)])) {
    const t = Math.max(localTomb[k] || 0, remoteTomb[k] || 0);
    if (Date.now() - t < TOMBSTONE_TTL) tombs[k] = t;
  }
  return { dict: out, tombstones: tombs };
}

function mergePrefs(local, localTs, remote, remoteTs) {
  // whole-blob LWW; tie → cloud (the file is the durable copy otherwise)
  return (remoteTs || 0) > (localTs || 0)
    ? { prefs: remote, ts: remoteTs }
    : { prefs: local, ts: localTs || 0 };
}

function pruneTombstones(t) {
  const out = {};
  for (const [k, ts] of Object.entries(t || {})) {
    if (Date.now() - ts < TOMBSTONE_TTL) out[k] = ts;
  }
  return out;
}

// ---- sync engine -----------------------------------------------------------

async function supaGet(uid) {
  const token = await getAccessToken();
  if (!token) throw new Error(lastError || 'not signed in');
  const r = await reqJson('GET', `${apiBase()}/rest/v1/${TABLE}?select=*&user_id=eq.${uid}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (r.status >= 400) throw new Error(`supabase pull ${r.status}`);
  return Array.isArray(r.json) ? r.json[0] : null;
}

// pull cloud row → merge into local → write through the existing queue
async function pullAndMerge() {
  const local = (await hooks.readBackup()) || { prefs: {}, favorites: {}, progress: {} };
  const row = await supaGet(session.user.id);
  if (!row) return local; // nothing in the cloud yet — local is the seed state

  const fav = mergeDicts(local.favorites || {}, row.favorites || {},
    (local.tombstones || {}).favorites || {}, row.fav_tombstones || {});
  const prog = mergeDicts(local.progress || {}, row.progress || {},
    (local.tombstones || {}).progress || {}, row.prog_tombstones || {});
  const prefsM = mergePrefs(local.prefs || {}, local.prefsTs || 0, row.prefs || {}, row.prefs_ts || 0);

  hooks.queueBackupWrite({
    ...local,
    prefs: prefsM.prefs,
    prefsTs: prefsM.ts,
    favorites: fav.dict,
    progress: prog.dict,
    tombstones: { favorites: fav.tombstones, progress: prog.tombstones },
  });
  return { ...local, favorites: fav.dict, progress: prog.dict };
}

// push = read-merge-write against the cloud row so a second device's newer
// keys survive (the residual concurrent-writer race is accepted, personal use)
async function push() {
  const local = (await hooks.readBackup()) || { prefs: {}, favorites: {}, progress: {} };
  const row = await supaGet(session.user.id);

  const fav = mergeDicts(local.favorites || {}, row?.favorites || {},
    (local.tombstones || {}).favorites || {}, row?.fav_tombstones || {});
  const prog = mergeDicts(local.progress || {}, row?.progress || {},
    (local.tombstones || {}).progress || {}, row?.prog_tombstones || {});
  const prefsM = mergePrefs(local.prefs || {}, local.prefsTs || 0, row?.prefs || {}, row?.prefs_ts || 0);

  const token = await getAccessToken();
  if (!token) throw new Error(lastError || 'not signed in');
  const up = await reqJson('POST', `${apiBase()}/rest/v1/${TABLE}?on_conflict=user_id`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: {
      user_id: session.user.id,
      prefs: prefsM.prefs,
      prefs_ts: prefsM.ts,
      favorites: fav.dict,
      progress: prog.dict,
      fav_tombstones: pruneTombstones({ ...(row?.fav_tombstones || {}), ...((local.tombstones || {}).favorites || {}) }),
      prog_tombstones: pruneTombstones({ ...(row?.prog_tombstones || {}), ...((local.tombstones || {}).progress || {}) }),
      updated_at: new Date().toISOString(),
    },
  });
  if (up.status >= 400) throw new Error(`supabase push ${up.status}`);
}

// One serialized sync step: pull-merge locally, then push the merged state.
// Backoff ladder on failure; any success resets it.
function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = BACKOFFS[Math.min(backoffStep, BACKOFFS.length - 1)] + Math.random() * 5000;
  backoffStep += 1;
  retryTimer = setTimeout(() => { retryTimer = null; syncNow(); }, delay);
}

async function syncNow() {
  if (!configured || !session) return;
  if (syncing) { pullAgain = true; return; }
  syncing = true;
  try {
    await pullAndMerge();
    await push();
    lastSync = Date.now();
    lastError = null;
    backoffStep = 0;
    dataRev += 1;
  } catch (e) {
    lastError = e.message;
    scheduleRetry();
  } finally {
    syncing = false;
  }
  if (pullAgain) { pullAgain = false; syncNow(); }
}

// Called by server.js after every local backup write. Debounced: the 5s
// progress timer + 1.5s UI debounce funnel into at most one push per 3s.
function onLocalDataChanged() {
  if (!configured || !session) return;
  clearTimeout(pushTimer);
  clearTimeout(retryTimer); // a state change overrides any backoff wait
  retryTimer = null;
  pushTimer = setTimeout(() => { pushTimer = null; syncNow(); }, PUSH_DEBOUNCE);
}

function status() {
  return {
    configured,
    signedIn: !!session,
    email: session?.user?.email || null,
    name: session?.user?.name || null,
    picture: session?.user?.picture || null,
    lastSync,
    lastError,
    syncing,
    dataRev,
    portAvailable: portIsFixed,
  };
}

// ---- loopback callback page ------------------------------------------------
// Served by server.js at GET /auth/callback. This page is loaded by the SYSTEM
// BROWSER (the app's WebView never navigates here), so it may not carry the
// app CSP — server.js sends it with its own headers.
function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{background:#0b0e14;color:#e8eaf0;font-family:system-ui,sans-serif;` +
    `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
    `div{text-align:center;max-width:420px;padding:24px}h1{font-size:18px;font-weight:700}` +
    `p{color:#8a92a0;font-size:14px;line-height:1.5}</style></head>` +
    `<body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

function handleCallback(q) {
  // Always renders a page — never a 500, never a throw into route().
  const err = q.get('error');
  if (err) {
    const desc = q.get('error_description') || err;
    return { status: 200, html: page('Sign-in cancelled', `Google returned: ${desc}. You can close this tab and try again.`) };
  }
  const code = q.get('code');
  const state = q.get('state'); // Supabase doesn't echo state back — optional
  if (!code) {
    // a bare callback (no code) also covers the cancelled/legacy-flow cases
    return { status: 200, html: page('Sign-in incomplete', 'The sign-in link was missing its code. Close this tab and start again from the app.') };
  }
  return exchangeCode(code, state).then((r) => {
    if (r.ok) {
      return {
        status: 200,
        html: page('Signed in', `Signed in as <b>${r.email}</b>. All synced. You can close this tab and return to the app.`),
      };
    }
    return { status: 200, html: page('Sign-in problem', `${r.error}. You can close this tab and try again from the app.`) };
  }).catch((e) => ({
    status: 200,
    html: page('Sign-in problem', `${e.message}. You can close this tab and try again from the app.`),
  }));
}

// ---- lifecycle -------------------------------------------------------------

function init(opts) {
  try {
    dataDir = opts.dataDir;
    hooks = opts.hooks;
    portIsFixed = !!opts.portIsFixed;
    if (!configured) { console.log('[cloud] not configured — sync disabled'); return; }
    (async () => {
      await loadAuthState();
      if (session) syncNow(); // boot pull+push
    })().catch((e) => console.warn('[cloud] init:', e.message));
  } catch { /* never block boot */ }
}

module.exports = {
  init,
  startSignIn,
  exchangeCode,
  signOut,
  status,
  onLocalDataChanged,
  syncNow,
  handleCallback,
  callbackPath: CALLBACK_PATH,
  AUTH_PORT,
  // exposed for tests
  _merge: { mergeDicts, mergePrefs, pruneTombstones },
};