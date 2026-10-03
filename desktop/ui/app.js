'use strict';

/* global Hls */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// outline SVG icon from the sprite in index.html (colors flow via currentColor)
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

// phone-sized viewport: drives the mobile-only behaviors (popup search,
// collapsible browse filters, sidebar auto-close, no mini player — the
// Android shell handles background playback via picture-in-picture instead)
const IS_MOBILE = window.matchMedia('(max-width: 540px)').matches;
// the Android app's WebView identifies itself with "Android" in the UA
const IS_ANDROID = /Android/i.test(navigator.userAgent);

const state = {
  query: '',
  page: 1,
  slug: null,
  title: null,
  poster: null,
  episodes: [],
  type: 'sub',
  epNum: null,
  sources: null,
  hls: null,
  autoNext: false,
  progressTimer: null,
  introTimer: null,
  view: 'homeView',
  recentLoaded: false,
  detailTab: 'episodes', // active detail tab; reset by openDetail
  audioCounts: null,     // { sub, dub } source counts from /api/detail
  epAuds: null,          // per-episode audio truth { num: { sub, dub } } (small shows)
  relCountsLoaded: false, // SEASONS "N EPS" badges fetched once per visit
  epFilter: '',          // FIND EP input value
};

const PROGRESS_KEY = 'anibrowser_progress';
const PREFS_KEY = 'anibrowser_prefs';
const FAVS_KEY = 'anibrowser_favorites';
const TOMBSTONES_KEY = 'anibrowser_tombstones';
const PREFS_TS_KEY = 'anibrowser_prefs_ts';
const GUEST_KEY = 'anibrowser_guest';
const WN_KEY = 'anibrowser_last_whatsnew'; // version last welcomed — device-local
// last boot's sign-in knowledge ("0" = a session was live / gate must never be
// first-painted, "1" = signed out). Read synchronously in the boot IIFE so the
// login gate can paint over the homepage instead of blinking open one poll
// later. Only read once — everything after defers to the live auth poll.
const GATE_SEEN_SIGNED_IN = 'anibrowser_gate_seen_signed_in';
// last known-good /api/auth/status payload, persisted so an offline cold start
// still shows the signed-in user on the profile page instead of "Not signed in"
const LAST_SYNC_KEY = 'anibrowser_lastSyncStatus';

// guest mode: session-only flag. Deliberately a standalone key, NOT a prefs
// entry — prefs are pushed whole-blob to the cloud and mirrored into the
// durable backup file, so a guest flag there would leak across devices and
// self-resurrect from the backup after being cleared. sessionStorage (not
// localStorage) on purpose: it clears when the app is relaunched, so the
// welcome / sign-in page always comes back on the next launch.
try { localStorage.removeItem(GUEST_KEY); } catch { /* private mode etc. */ }
function isGuest() {
  try { return sessionStorage.getItem(GUEST_KEY) === '1'; } catch { return false; }
}
function setGuest(on) {
  try {
    if (on) sessionStorage.setItem(GUEST_KEY, '1');
    else sessionStorage.removeItem(GUEST_KEY);
  } catch { /* storage unavailable — gate logic degrades to "always ask" */ }
}

// tombstones: { favorites: {slug: ts}, progress: {slug: ts} } — deletes need
// markers so cloud sync can't resurrect them on another device
function getTombstones() {
  try { return JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}'); }
  catch { return {}; }
}
function addTombstone(coll, slug) {
  const t = getTombstones();
  (t[coll] = t[coll] || {})[slug] = Date.now();
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(t));
  scheduleBackup();
}
function prefsTs() {
  return parseInt(localStorage.getItem(PREFS_TS_KEY) || '0', 10) || 0;
}

function getJSON() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); }
  catch { return {}; }
}
function setJSON(obj) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(obj));
  scheduleBackup();
}
function prefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); }
  catch { return {}; }
}
// dark is the default; light swaps the :root neutral tokens (style.css).
// The Android shell's cover/backdrop stays dark-painted natively — it is told
// via a 'theme' message so the boot gap doesn't flash dark during light mode.
function currentTheme() {
  return prefs().theme === 'light' ? 'light' : 'dark';
}
function applyTheme(t) {
  const theme = t || currentTheme();
  document.documentElement.dataset.theme = theme;
  if (IS_ANDROID && window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'theme', light: theme === 'light' }));
  }
}
// profile-page overrides (username / avatar / bg color / hide-email). They live
// inside prefs so they ride the normal prefs sync — the avatar is a resized
// data-URL, small enough for the synced blob. Empty object = untouched identity.
function profileEdit() {
  const p = prefs().profile;
  return p && typeof p === 'object' ? p : {};
}
function setPrefs(p) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  localStorage.setItem(PREFS_TS_KEY, String(Date.now())); // prefs sync as one blob — stamp edits
  scheduleBackup();
}
// the audio track new playback should open with: the user's chosen default
// (settings) wins; lastType only remembers a hot-swap, never the other way
function prefAudioType() {
  return prefs().defaultType || prefs().lastType || 'sub';
}
// the stream server new playback should resolve with: a pref picked in
// settings or by a server switch in the player ('Vidstream-2' out of the
// box — '' means Auto / first-available). An explicit undefined check
// matters: '' is falsy, but it's a real user choice (Auto)
function prefServer() {
  const v = prefs().defaultServer;
  return v === undefined ? 'Vidstream-2' : v;
}
// adult content: the app is family-safe by design — R+ / Rx titles and the
// source's adult catalog (r18 flag) are always hidden, so there is no toggle
// and no filter option for them anywhere. Regular R stays visible (the app's
// "R" is the source's R-17+ maturity rating — violence/profanity, not nudity).
// The source tick-marks ONLY its adult-catalog titles though — shows merely
// rated R+ / Rx look like regular cards. Their rating lives on the detail
// page, so the filter also consults ratings learned by sweepAdultRatings.
const ADULT_RATINGS = ['R+', 'Rx'];
const adultRatings = {};          // slug -> pgRating ('R', 'R+', 'Rx', 'PG-13'…)
const pendingRatings = new Set(); // slugs with a sweep request in flight
function r18Visible(r) {
  if (r.r18) return false;
  return !ADULT_RATINGS.includes(adultRatings[r.slug]);
}

// post-render sweep: fetch content ratings for every card in `container` the
// UI doesn't know yet, then hide the ones that turn out R+ / Rx in place
// (no re-render — the grid keeps its layout). Ratings come from the detail
// pages, server-cached for a week, so repeats are instant.
async function sweepAdultRatings(container) {
  if (!container) return;
  const slugs = [...new Set(
    [...container.querySelectorAll('[data-slug]')]
      .map((c) => c.dataset.slug)
      .filter((s) => s && !(s in adultRatings) && !pendingRatings.has(s))
  )];
  if (!slugs.length) return;
  slugs.forEach((s) => pendingRatings.add(s));
  try {
    const { ratings } = await api('/api/ratings', { slugs });
    Object.assign(adultRatings, ratings || {});
  } catch { return; } // best-effort — untick'd cards just stay visible
  finally { slugs.forEach((s) => pendingRatings.delete(s)); }
  for (const slug of slugs) {
    if (!ADULT_RATINGS.includes(adultRatings[slug])) continue;
    container.querySelectorAll(`[data-slug="${slug}"]`).forEach((c) => { c.hidden = true; });
  }
}

/* ---------------- favorites ---------------- */

function getFavs() {
  try { return JSON.parse(localStorage.getItem(FAVS_KEY) || '{}'); }
  catch { return {}; }
}
function setFavs(f) {
  localStorage.setItem(FAVS_KEY, JSON.stringify(f));
  scheduleBackup();
}

/* ---- durable backup (survives updates/reinstalls) ----
   prefs + favorites + watch history are mirrored to
   Documents/AniBrowser/anibrowser-data.json via the local server. */

let backupTimer = null;
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(saveBackup, 1500);
}

function backupPayload() {
  return JSON.stringify({
    prefs: prefs(),
    prefsTs: prefsTs(),
    favorites: getFavs(),
    progress: getJSON(),
    tombstones: getTombstones(),
  });
}

async function saveBackup() {
  try {
    await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: backupPayload(),
    });
  } catch { /* backup is best-effort */ }
}

// flush immediately on close so a quick quit never loses the last change
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/api/backup', new Blob([backupPayload()], { type: 'application/json' }));
});

// per-key newer-ts-wins merge for the dict-shaped collections (ties: local)
// — used for the file-vs-localStorage restore so a phone and a desktop
// converge instead of one side blindly clobbering the other
function mergeDictNewerWins(local, remote) {
  const out = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const eL = local[k];
    const eR = remote[k];
    if (eL && eR) out[k] = (eR.ts || 0) > (eL.ts || 0) ? eR : eL;
    else if (eR) out[k] = eR;
    else out[k] = eL;
  }
  return out;
}

async function restoreFromBackup() {
  try {
    const { data } = await api('/api/backup');
    if (data) {
      // settings: the file is the durable copy, so it fills in / overrides defaults
      setPrefsSilent({ ...prefs(), ...(data.prefs || {}) });
      if ((data.prefsTs || 0) > prefsTs()) localStorage.setItem(PREFS_TS_KEY, String(data.prefsTs));
      // favorites & history: union, newer entry wins per show (the server has
      // already merged the cloud into the file — this is file vs localStorage).
      // A tombstone newer than an entry keeps it deleted, locally and in the
      // file — otherwise the very restore below resurrects removals.
      const fb = (data.tombstones || {}).favorites || {};
      const pb = (data.tombstones || {}).progress || {};
      const mergedFavs = mergeDictNewerWins(data.favorites || {}, getFavs());
      const mergedProg = mergeDictNewerWins(data.progress || {}, getJSON());
      const tombsF = { ...fb, ...getTombstones().favorites };
      const tombsP = { ...pb, ...getTombstones().progress };
      for (const k of Object.keys(mergedFavs)) {
        if ((tombsF[k] || 0) > (mergedFavs[k].ts || 0)) delete mergedFavs[k];
        else delete tombsF[k]; // entry survived its tombstone — stop tracking it
      }
      for (const k of Object.keys(mergedProg)) {
        if ((tombsP[k] || 0) > (mergedProg[k].ts || 0)) delete mergedProg[k];
        else delete tombsP[k];
      }
      setFavsSilent(mergedFavs);
      setJSONSilent(mergedProg);
      localStorage.setItem(TOMBSTONES_KEY, JSON.stringify({
        favorites: tombsF,
        progress: tombsP,
      }));
    }
  } catch { /* backup is best-effort */ }
  // write once at startup so the file exists from the first run onward
  scheduleBackup();
}

// same as setPrefs/setFavs/setJSON but without triggering another backup write
function setPrefsSilent(p) { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); }
function setFavsSilent(f) { localStorage.setItem(FAVS_KEY, JSON.stringify(f)); }
function setJSONSilent(p) { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); }
function isFav(slug) {
  return !!getFavs()[slug];
}
// r = { slug, title, poster }; returns true if now favorited
function toggleFav(r) {
  const f = getFavs();
  if (f[r.slug]) {
    delete f[r.slug];
    addTombstone('favorites', r.slug); // sync: keep it deleted on other devices
    forgetFavTracking(r.slug); // drop its notification state
    toast('Removed from favorites');
  } else {
    f[r.slug] = { title: r.title, poster: r.poster, ts: Date.now() };
    baselineFavCount(r.slug); // remember current episode count so only *new* releases notify
    toast('Added to favorites ♥');
  }
  setFavs(f);
  return !!f[r.slug];
}

// heart button overlaid on a poster card
function attachFavBtn(card, r) {
  const fav = el('button', 'fav-btn');
  fav.innerHTML = icon('heart');
  fav.title = isFav(r.slug) ? 'Remove from favorites' : 'Add to favorites';
  fav.classList.toggle('active', isFav(r.slug));
  fav.addEventListener('click', (e) => {
    e.stopPropagation(); // don't open the card's detail view
    const on = toggleFav(r);
    fav.classList.toggle('active', on);
    fav.title = on ? 'Remove from favorites' : 'Add to favorites';
    // keep other visible grids in sync with the same show
    document.querySelectorAll('.fav-btn').forEach((b) => {
      if (b._slug === r.slug) b.classList.toggle('active', on);
    });
    // on the profile page the un-favorited card drops out of the grid
    if (!on && !$('profileView').hidden) renderFavorites();
  });
  fav._slug = r.slug;
  card.appendChild(fav);
}

function renderFavorites() {
  const items = Object.entries(getFavs())
    .map(([slug, v]) => ({ slug, ...v }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const grid = $('favGrid');
  grid.innerHTML = '';
  for (const r of items) grid.appendChild(makeCard(r));
  $('favEmpty').hidden = items.length > 0;
}

// the profile page's "Watching" tab — same resume cards as the home row,
// but the full history instead of the latest 12
function renderWatching() {
  const items = Object.entries(getJSON())
    .map(([slug, v]) => ({ slug, ...v }))
    .filter((v) => v.title && v.epNum)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const grid = $('watchGrid');
  grid.innerHTML = '';
  for (const it of items) {
    const card = el('div', 'card');
    const media = el('div', 'card-media');
    const img = el('img');
    loadPoster(img, it.poster);
    img.loading = 'lazy';
    media.appendChild(img);
    card.dataset.slug = it.slug;
    const title = el('div', 'card-title'); // gradient veil + clamped text below
    title.appendChild(el('div', 'card-title-text', it.title));
    media.appendChild(title);
    card.appendChild(media);
    card.title = it.title;
    const bar = el('div', 'resume-bar');
    const fill = el('div');
    fill.style.width = `${Math.min(100, it.pct || 0)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(el('div', 'resume-label', `EP ${it.epNum} · ${fmtTime(it.t)}`));
    card.addEventListener('click', () => {
      openDetail(it.slug, it.title, it.poster, () => {
        state.epNum = it.epNum;
        startPlayback(it.epNum, prefAudioType());
      });
    });
    attachFavBtn(card, it);
    // ✕ to drop this show from the watch history
    const rm = el('button', 'fav-btn remove-btn');
    rm.innerHTML = icon('x');
    rm.title = 'Remove from watch history';
    rm.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the card's detail view
      const all = getJSON();
      delete all[it.slug];
      addTombstone('progress', it.slug); // sync: keep it deleted on other devices
      setJSON(all); // also schedules a backup write
      toast(`Removed "${it.title}" from history`);
      renderWatching();
      renderContinue();
    });
    card.appendChild(rm);
    grid.appendChild(card);
  }
  $('watchEmpty').hidden = items.length > 0;
}

// profile page tabs: Favorites / Watching
function showProfileTab(watch) {
  $('tabFavs').classList.toggle('active', !watch);
  $('tabWatch').classList.toggle('active', watch);
  $('paneFavs').hidden = watch;
  $('paneWatch').hidden = !watch;
  if (watch) renderWatching();
}
$('tabFavs').addEventListener('click', () => showProfileTab(false));
$('tabWatch').addEventListener('click', () => showProfileTab(true));

/* ---------------- new-episode notifications ---------------- */

// favorites are polled on a timer; when a show's episode count grows past the
// last-seen baseline, a notification lands in the bell. Persisted in prefs:
//   favEpSeen  = { slug: lastSeenEpisodeCount }
//   notifActive = [{ slug, title, newCount, count }]   (cleared by "Mark all seen")

let checkingFavs = false;

function favSeen() { return prefs().favEpSeen || {}; }
function notifActive() { return prefs().notifActive || []; }
function setNotifActive(list) { const p = prefs(); p.notifActive = list; setPrefs(p); }

async function epcountsRequest(slugs) {
  const res = await fetch('/api/epcounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slugs }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).counts || {};
}

// remember the current episode count for a just-favorited show (no notification)
async function baselineFavCount(slug) {
  try {
    const counts = await epcountsRequest([slug]);
    if (typeof counts[slug] === 'number') {
      const p = prefs();
      p.favEpSeen = { ...(p.favEpSeen || {}), [slug]: counts[slug] };
      setPrefs(p);
    }
  } catch { /* the periodic poll will baseline it instead */ }
}

// NEW-RELEASE HIGHLIGHTING FOR NON-FAVORITES. The bell panel only tracks
// shows you favorited (its poll knows a release happened even while the app
// runs long-term). For a show that merely got *opened*, remember the episode
// count it had at your last visit; a later visit with a bigger count means
// episodes released in between — those highlight on the episode grid.
// epVisits = { slug: { count, ts, fresh: {lo, hi} | null } }
function trackVisits(slug, count) {
  state.visitNew = null;
  if (getFavs()[slug]) return; // favorited: the bell panel's tracking owns it
  try {
    const p = prefs();
    const visits = p.epVisits || {};
    const prev = visits[slug];
    const now = Date.now();
    if (prev && typeof prev.count === 'number') {
      if (now - prev.ts < 10 * 60 * 1000) {
        // Back-nav round trips (player → detail → player) re-open the same
        // page minutes apart — keep the fresh range alive so tiles don't
        // dim the moment the visit is re-recorded
        state.visitNew = prev.fresh || null;
      } else if (count > prev.count) {
        state.visitNew = { lo: prev.count + 1, hi: count };
      }
    } // first-ever visit: no baseline yet — record it, nothing to highlight
    visits[slug] = { count, ts: now, fresh: state.visitNew };
    // prune stale entries once the map grows big
    const keys = Object.keys(visits);
    if (keys.length > 300) {
      const cutoff = now - 90 * 24 * 60 * 60 * 1000;
      for (const k of keys) if (visits[k].ts < cutoff) delete visits[k];
    }
    p.epVisits = visits;
    setPrefs(p);
  } catch { /* tracking is best-effort; the visit just isn't remembered */ }
}

// drop notification state when a show is un-favorited
function forgetFavTracking(slug) {
  const p = prefs();
  if (p.epVisits) { const v = { ...p.epVisits }; delete v[slug]; p.epVisits = v; }
  if (p.favEpSeen) { const s = { ...p.favEpSeen }; delete s[slug]; p.favEpSeen = s; }
  if ((p.notifActive || []).some((n) => n.slug === slug)) {
    p.notifActive = p.notifActive.filter((n) => n.slug !== slug);
  }
  setPrefs(p);
  renderNotifPanel();
}

async function checkFavEpisodes() {
  if (checkingFavs) return;
  const favs = getFavs();
  const slugs = Object.keys(favs);
  if (!slugs.length) { renderNotifPanel(); return; }
  checkingFavs = true;
  try {
    const counts = await epcountsRequest(slugs);
    const seen = favSeen();
    let active = notifActive().filter((n) => favs[n.slug]); // drop un-favorited shows
    const fresh = [];
    for (const slug of slugs) {
      const count = counts[slug];
      if (typeof count !== 'number') continue;
      const last = seen[slug];
      if (typeof last !== 'number') { seen[slug] = count; continue; } // first sighting = baseline
      if (count > last) {
        seen[slug] = count;
        const idx = active.findIndex((n) => n.slug === slug);
        const carried = idx >= 0 ? active[idx].newCount : 0;
        const entry = { slug, title: favs[slug].title || slug, newCount: count - last + carried, count };
        if (idx >= 0) active[idx] = entry; else active.push(entry);
        if (idx < 0) fresh.push(entry);
      }
    }
    const p = prefs();
    p.favEpSeen = seen;
    p.notifActive = active;
    setPrefs(p);
    renderNotifPanel();
    for (const n of fresh) {
      toast(`${n.title}: ${n.newCount} new episode${n.newCount === 1 ? '' : 's'}!`);
      // Android shell mirrors fresh favorites updates into system notifications
      // (the "Favorite update alerts" settings row turns this off)
      if (IS_ANDROID && prefs().pushNotifs !== false && window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'notify',
          title: n.title,
          body: `${n.newCount} new episode${n.newCount === 1 ? '' : 's'} out (up to EP ${n.count})`,
        }));
      }
    }
  } catch { /* poll is best-effort; the next tick retries */ }
  finally { checkingFavs = false; }
}

// NEW badge poster pill: teal dot-corner marker for "new episode released"
const newBadgeEl = () => el('span', 'new-badge', 'NEW');

// slugs currently sitting on the recently-updated feed. The home grid uses
// this to paint NEW pills; the detail page reuses the same set to animate a
// show's newest tile even for shows never opened or favorited.
const recentSet = new Set();
function rememberRecent(results) {
  for (const r of results) if (r && r.slug) recentSet.add(r.slug);
}

function renderNotifPanel() {
  const items = notifActive();
  const list = $('notifList');
  list.innerHTML = '';
  $('notifEmpty').hidden = items.length > 0;
  $('notifClear').hidden = items.length === 0;
  for (const n of items) {
    const item = el('button', 'notif-item');
    item.appendChild(el('span', 'notif-title', n.title));
    item.appendChild(el('span', 'notif-sub',
      `${n.newCount} new episode${n.newCount === 1 ? '' : 's'} out (up to EP ${n.count})`));
    item.appendChild(el('span', 'notif-hint', 'Click to open the show'));
    item.addEventListener('click', () => {
      $('notifPanel').hidden = true;
      const fav = getFavs()[n.slug];
      openDetail(n.slug, n.title, fav ? fav.poster : undefined);
    });
    list.appendChild(item);
  }
  const badge = $('notifBadge');
  badge.textContent = String(items.length);
  badge.hidden = items.length === 0;
  $('notifBtn').classList.toggle('unread', items.length > 0);
}

$('notifBtn').addEventListener('click', () => {
  const panel = $('notifPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderNotifPanel();
});
$('notifClear').addEventListener('click', () => {
  setNotifActive([]);
  renderNotifPanel();
});
document.addEventListener('click', (e) => {
  const panel = $('notifPanel');
  if (!panel.hidden && !e.target.closest('#bellWrap')) panel.hidden = true;
});

async function api(path, body) {
  let res;
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }
    : { signal: AbortSignal.timeout(60000) };
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error(path.startsWith('/api/sources') ? 'Source lookup timed out or network hiccup — try again.' : e.message);
  }
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.className = isErr ? 'err' : '';
  t.replaceChildren();
  const span = document.createElement('span');
  span.textContent = msg;
  t.innerHTML = `<svg class="icon"><use href="${isErr ? '#i-info' : '#i-check'}"></use></svg>`;
  t.appendChild(span);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ---- themed confirm dialog (replaces window.confirm) ----
   The Android WebView renders confirm() as a bare system popup that clashes
   with the theme; this resolves a promise instead, so call sites stay
   `if (!await confirmDialog(...)) return`. */
let dlgResolve = null;
function confirmDialog(msg, { title = 'Please confirm', okText = 'Confirm', cancelText = 'Cancel', icon = 'i-info', danger = false } = {}) {
  if (dlgResolve) dlgResolve(false); // a superseding dialog cancels the open one
  $('dlgTitle').textContent = title;
  $('dlgMsg').textContent = msg;
  $('dlgOk').textContent = okText;
  $('dlgCancel').textContent = cancelText;
  $('dlgIconUse').setAttribute('href', '#' + icon);
  $('dlgIcon').classList.toggle('danger', danger);
  $('dlgOk').classList.toggle('danger', danger);
  $('confirmDlg').hidden = false;
  $('dlgCancel').focus(); // safe default; also routes Escape to the dialog's key handler
  return new Promise((res) => { dlgResolve = res; });
}
function closeConfirm(ok) {
  if (!dlgResolve) return;
  $('confirmDlg').hidden = true;
  dlgResolve(ok);
  dlgResolve = null;
}
$('dlgCancel').addEventListener('click', () => closeConfirm(false));
$('dlgOk').addEventListener('click', () => closeConfirm(true));
// tap outside the card, or Escape, means cancel
$('confirmDlg').addEventListener('click', (e) => { if (e.target === $('confirmDlg')) closeConfirm(false); });
$('confirmDlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConfirm(false); });

function showView(name) {
  // offline lockdown: only the profile (plus settings, and a show's detail
  // page opened from its profile card) renders without the network — every
  // other page is server-backed and would just spin. Navigation to them
  // folds back to the profile instead.
  if (appOffline && !OFFLINE_OK_VIEWS.has(name)) {
    offlineNotice();
    name = 'profileView';
    renderProfile();
  }
  // remember where the reader is in the accumulating listings — an infinite
  // list has no page numbers to jump back to
  if (state.view) scrollMem[state.view] = $('main').scrollTop;
  for (const v of ['homeView', 'browseView', 'scheduleView', 'detailView', 'playerView', 'collectionView', 'profileView', 'settingsView', 'feedbackView']) {
    $(v).hidden = v !== name;
  }
  state.view = name;
  document.dispatchEvent(new CustomEvent('pv:view', { detail: { view: name } }));
  // coming back home after a playback session: refresh the hero buttons so a
  // show just watched flips from "Watch now" to "Continue EP n"
  if (name === 'homeView' && heroItems.length) renderHero(heroIdx);
  // the profile page swaps the navbar for a round back + settings pair, the
  // settings page for a round back + feedback bubble, the feedback board for
  // a lone round back; everywhere else the standard navbar shows. The back
  // button appears once there's a trail to unwind (topNav always leaves one
  // when leaving a view).
  const bare = name === 'profileView' || name === 'settingsView' || name === 'feedbackView';
  document.body.classList.toggle('on-profile', name === 'profileView');
  document.body.classList.toggle('on-settings', name === 'settingsView');
  document.body.classList.toggle('on-feedback', name === 'feedbackView');
  // sidebar highlight follows the view — Home/Browse are the only items that
  // map to a view; profile/settings/feedback pages highlight neither
  document.querySelectorAll('.side-item[data-nav]').forEach((b) => {
    b.classList.toggle('active',
      (name === 'homeView' && b.dataset.nav === 'home') ||
      (name === 'browseView' && b.dataset.nav === 'browse') ||
      (name === 'scheduleView' && b.dataset.nav === 'schedule'));
  });
  $('backBtn').hidden = !bare || histStack.length === 0;
  // the player page hosts the detail content below the video: mount it on
  // entry, restore it to the detail page on every exit path
  if (name === 'playerView') ensureDetailMounted();
  else restorePlayerDetail();
  // only the paged listings keep their place; everything else still opens at
  // the top (a stale memory would scroll a fresh list somewhere random)
  $('main').scrollTop = name === 'browseView' || name === 'collectionView'
    ? (scrollMem[name] || 0) : 0;
  infCheck(); // a restored scroll may already sit in the next-page trigger zone
}

/* ---- navigation history (the back trail) ----
   Every forward navigation pushes a restore snapshot plus a browser history
   entry, so the UI back buttons and the Android hardware back (webview
   goBack() → popstate) walk the exact same trail. Restore snapshots are
   closures — a detail page reopens itself, other views just re-show. */
const histStack = [];
let restoring = false;
function pushHist(restore) {
  if (restoring) return;
  histStack.push(restore);
  try { history.pushState({ anibrowser: histStack.length }, ''); } catch { /* ignored */ }
}
function goBack() {
  // only unwind via the browser when a pushed entry is actually on top
  if (history.state && history.state.anibrowser) { history.back(); return; }
  restoreHist();
}
function restoreHist() {
  restoring = true;
  try {
    const restore = histStack.pop();
    if (restore) restore();
    else navHome();
  } finally { restoring = false; }
}
window.addEventListener('popstate', () => restoreHist());

// re-show a view-level snapshot without re-pushing history
function restoreView(v) {
  if (appOffline) return showView(OFFLINE_OK_VIEWS.has(v) ? v : 'profileView');
  if (v === 'browseView') showView('browseView');
  else if (v === 'scheduleView') { showView('scheduleView'); loadSchedule(); }
  else if (v === 'profileView') { renderProfile(); showView('profileView'); }
  else if (v === 'detailView') showView('detailView');
  else if (v === 'settingsView' || v === 'collectionView') showView(v);
  else if (v === 'feedbackView') showView('feedbackView');
  else if (v === 'playerView') { stopPlayback(); showView('detailView'); renderEpisodes(); }
  else {
    // home: keep any active search results on screen, else the home sections
    showView('homeView');
    renderContinue();
    if (!$('resultsSection').hidden) {
      $('recentSection').hidden = true;
    } else {
      $('recentSection').hidden = false;
      loadRecent();
    }
  }
}

function fmtTime(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- suggestions ---------------- */

const sugCache = new Map(); // query -> results
const sugState = { open: false, hl: -1, items: [] };
let sugDebounce = null;
let sugSeq = 0;

function hideSuggestions() {
  sugState.open = false;
  sugState.hl = -1;
  $('suggestions').hidden = true;
}

function renderSuggestions(items) {
  const box = $('suggestions');
  box.innerHTML = '';
  if (!items.length) {
    box.hidden = true;
    sugState.open = false;
    return;
  }
  sugState.items = items;
  sugState.open = true;
  sugState.hl = -1;
  for (const r of items) {
    const row = el('div', 'sug-item');
    const img = el('img');
    loadPoster(img, r.poster);
    row.appendChild(img);
    row.appendChild(el('div', 'sug-title', r.title));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep input focus handling predictable
      hideSuggestions();
      if (IS_MOBILE) closeSearchOverlay();
      openDetail(r.slug, r.title, r.poster);
    });
    box.appendChild(row);
  }
  box.hidden = false;
}

async function fetchSuggestions(q) {
  const seq = ++sugSeq;
  const cached = sugCache.get(q);
  if (cached) return renderSuggestions(cached);
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const top = results.slice(0, 8);
    sugCache.set(q, top);
    if (sugCache.size > 40) sugCache.delete(sugCache.keys().next().value);
    if (seq === sugSeq && $('searchInput').value.trim() === q) renderSuggestions(top);
  } catch { /* suggestions are best-effort */ }
}

$('searchInput').addEventListener('input', () => {
  const q = $('searchInput').value.trim();
  clearTimeout(sugDebounce);
  if (q.length < 2) { hideSuggestions(); return; }
  sugDebounce = setTimeout(() => fetchSuggestions(q), 450);
});
$('searchInput').addEventListener('blur', () => setTimeout(hideSuggestions, 150));
$('searchForm').addEventListener('submit', () => hideSuggestions());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sugState.open) hideSuggestions();
});
$('searchInput').addEventListener('keydown', (e) => {
  if (!sugState.open) return;
  const rows = $('suggestions').children;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugState.hl = e.key === 'ArrowDown'
      ? (sugState.hl + 1) % rows.length
      : (sugState.hl - 1 + rows.length) % rows.length;
    [...rows].forEach((r, i) => r.classList.toggle('hl', i === sugState.hl));
  } else if (e.key === 'Enter' && sugState.hl >= 0) {
    e.preventDefault();
    const r = sugState.items[sugState.hl];
    hideSuggestions();
    if (IS_MOBILE) closeSearchOverlay();
    openDetail(r.slug, r.title, r.poster);
  }
});

/* --- mobile popup search ---
   The topbar search input is too cramped on a phone, so the search moves
   behind a magnifying-glass icon: tapping opens a full-width overlay and the
   existing #searchForm is reparented into it (reparenting keeps every input /
   suggestions listener working unchanged). Desktop never opens the overlay. */
function closeSearchOverlay() {
  $('searchOverlay').hidden = true;
  hideSuggestions();
}

if (IS_MOBILE) {
  $('searchBtn').addEventListener('click', () => {
    $('searchMount').appendChild($('searchForm'));
    $('searchOverlay').hidden = false;
    $('searchInput').focus();
  });
  $('searchOverlayClose').addEventListener('click', closeSearchOverlay);
  // tapping the dim backdrop closes it; taps inside the panel don't
  $('searchOverlay').addEventListener('click', (e) => {
    if (e.target === $('searchOverlay')) closeSearchOverlay();
  });
  // submitting a search or picking a suggestion should land on the results
  $('searchForm').addEventListener('submit', closeSearchOverlay);
}

/* ---------------- browse all ---------------- */

/* ---- infinite scroll ----
   Numbered pagination is gone: every big listing now appends the next page as
   the reader nears the bottom of the current one. One engine drives all of
   them — browse, collections, search results — each with a footer that shows
   the spinner while a page is in flight and "That's everything" once the
   server runs out. Scrolling to a detail page and back restores the scroll
   position: with no page numbers left to jump to, losing your place would
   mean scrolling through dozens of pages to find it again. */
const INFINITE_MARGIN = 700; // begin a fetch this many px ahead of the bottom
const mainEl = $('main');
const scrollMem = {}; // view → scrollTop, restored only for the listings that accumulate
const infLoaders = new Set();

class InfList {
  constructor({ footer, grid, view, fetchPage, emptyMsg, endMsg, onReset }) {
    this.footer = footer;
    this.grid = grid;
    this.view = view; // fetches only while this view is on screen
    this.fetchPage = fetchPage; // async (page) → { results, totalPages?, page? }
    this.emptyMsg = emptyMsg;
    this.onReset = onReset; // run at the top of every fresh listing (section flips etc.)
    this.busy = false;
    this.done = false;
    this.page = 1;
    this.totalPages = 1;
    this.seq = 0;
    footer.querySelector('.inf-end').textContent = endMsg || 'That’s everything';
  }

  // position check, run every scroll tick
  maybeFetch() {
    if (this.busy || this.done || state.view !== this.view) return;
    // page 1 must land before appends start — showView's infCheck fires
    // against an empty grid before its reset begins, and appending page 2
    // onto zero cards would chain eagerly (pages of cards with no user scroll)
    if (!this.grid.querySelector('.card')) return;
    const r = this.footer.getBoundingClientRect();
    if (!r.height) return; // footer not in layout — nothing to watch
    if (r.top > mainEl.getBoundingClientRect().bottom + INFINITE_MARGIN) return;
    this.loadPage(false);
  }

  // fresh listing: page 1, skeleton up, any scroll memory discarded
  reset() {
    this.page = 1;
    this.totalPages = 1;
    this.done = false;
    this.busy = false;
    this.seq++;
    if (this.view) scrollMem[this.view] = 0;
    this.loadPage(true);
  }

  async loadPage(reset) {
    this.busy = true;
    this.footer.hidden = false;
    this.footer.classList.add('busy');
    this.footer.classList.remove('end');
    if (reset && this.onReset) this.onReset();
    if (reset) renderSkeletonCards(this.grid, 12);
    const seq = this.seq;
    try {
      // a family-safe listing can have pages that are entirely R+ / Rx — those
      // append nothing, so they must not read as the end: skip ahead (bounded)
      // until real cards land or the server actually runs out
      let appended = 0;
      for (let hops = 0; ; hops++) {
        const p = reset ? 1 : this.page + 1;
        const { results, totalPages = Infinity, page = p } = await this.fetchPage(p);
        if (seq !== this.seq) return; // superseded mid-flight (new filters etc.)
        this.page = page;
        this.totalPages = totalPages;
        if (reset) this.grid.innerHTML = ''; // drop the skeleton placeholders
        const shown = results.filter(r18Visible);
        for (const r of shown) this.grid.appendChild(makeCard(r));
        sweepAdultRatings(this.grid);
        appended += shown.length;
        // search has no page count; an empty page IS the end there
        const last = results.length === 0 || page >= totalPages;
        this.done = last;
        if (shown.length || last || hops >= 4) break;
      }
      if (reset && !appended && this.done && !this.grid.querySelector('.card')) {
        renderGridEmpty(this.grid, this.emptyMsg);
      }
    } catch (e) {
      if (seq === this.seq) { // stale failures stay quiet — a newer load owns the grid
        if (reset) this.grid.innerHTML = ''; // don't leave skeletons up
        this.done = false; // a later scroll retry re-fires this
        this.busy = false;
        toast('Load failed: ' + e.message, true);
      }
      return;
    }
    if (seq !== this.seq) return;
    this.busy = false;
    this.footer.classList.toggle('busy', false);
    this.footer.classList.toggle('end', this.done);
    // short pages never push the footer out of the trigger zone (and no new
    // scroll event fires on us) — keep chaining while cards actually land
    if (!this.done && appended > 0) this.maybeFetch();
  }
}

// every scroll of the content pane offers the live loaders a chance to fetch
mainEl.addEventListener('scroll', () => {
  for (const L of infLoaders) L.maybeFetch();
}, { passive: true });

function infCheck() {
  for (const L of infLoaders) L.maybeFetch();
}

const GENRES = [
  'action', 'action-adventure', 'adventure', 'anthropomorphic', 'avant-garde',
  'award-winning', 'boys-love', 'cars', 'cgdct', 'childcare', 'combat-sports',
  'comedy', 'crossdressing', 'delinquents', 'dementia', 'demons', 'detective',
  'drama', 'ecchi', 'educational', 'erotica', 'fantasy', 'gag-humor', 'game',
  'girls-love', 'gore', 'gourmet', 'harem', 'hentai', 'high-stakes-game',
  'historical', 'horror', 'idols-female', 'idols-male', 'isekai', 'iyashikei',
  'josei', 'kids', 'love-polygon', 'love-status-quo', 'magic', 'magical-sex-shift',
  'mahou-shoujo', 'martial-arts', 'mecha', 'medical', 'military', 'music',
  'mystery', 'mythology', 'organized-crime', 'otaku-culture', 'parody',
  'performing-arts', 'pets', 'police', 'psychological', 'racing', 'reincarnation',
  'reverse-harem', 'romance', 'samurai', 'school', 'sci-fi', 'sci-fi-fantasy',
  'seinen', 'shoujo', 'shoujo-ai', 'shounen', 'shounen-ai', 'showbiz',
  'slice-of-life', 'space', 'sports', 'strategy-game', 'supernatural',
  'super-power', 'survival', 'suspense', 'team-sports', 'thriller', 'time-travel',
  'unknown', 'urban-fantasy', 'vampire', 'video-game', 'villainess', 'visual-arts',
  'workplace',
];

// rating filter: family-safe — R+ / Rx are never offered (they'd yield empty
// results anyway)
function ratingOptions() {
  return [['g', 'G'], ['pg', 'PG'], ['pg_13', 'PG-13'], ['r_17', 'R']];
}

const FILTER_OPTIONS = {
  type: [['tv', 'TV'], ['movie', 'Movie'], ['ova', 'OVA'], ['ona', 'ONA'], ['special', 'Special'], ['music', 'Music']],
  status: [['completed', 'Finished airing'], ['releasing', 'Currently airing'], ['not_yet_aired', 'Not yet aired']],
  score: [['10', '(10) Masterpiece'], ['9', '(9) Great'], ['8', '(8) Very good'], ['7', '(7) Good'], ['6', '(6) Fine'], ['5', '(5) Average'], ['4', '(4) Bad'], ['3', '(3) Very bad'], ['2', '(2) Horrible'], ['1', '(1) Appalling']],
  season: [['spring', 'Spring'], ['summer', 'Summer'], ['fall', 'Fall'], ['winter', 'Winter']],
  language: [['sub', 'SUB'], ['dub', 'DUB']],
  sort: [
    ['updated_date', 'Recently updated'], ['added_date', 'Recently added'],
    ['release_date', 'Release date'], ['trending', 'Trending'],
    ['title_az', 'Name A-Z'], ['avg_score', 'Score'], ['mal_score', 'MAL score'],
    ['most_viewed', 'Most watched'], ['most_followed', 'Most followed'],
    ['episode_count', 'Number of episodes'],
  ],
};

const browse = { mode: 'letter', letter: 'all' };
const bfSelects = ['Type', 'Status', 'Genre', 'Rating', 'Score', 'Season', 'Language', 'Sort'];
// select suffix -> query param (the site's filter form uses singular `genre`;
// `genres` used to work but is ignored by the backend today)
const bfParams = {
  Type: 'type', Status: 'status', Genre: 'genre', Rating: 'rating',
  Score: 'score', Season: 'season', Language: 'language', Sort: 'sort',
};

const browseInf = new InfList({
  footer: $('browseLoad'),
  grid: $('browseGrid'),
  view: 'browseView',
  emptyMsg: 'Nothing to show here',
  fetchPage: async (page) => {
    const q = new URLSearchParams();
    if (browse.mode === 'letter') q.set('letter', browse.letter);
    else {
      for (const f of bfSelects) {
        const v = $('bf' + f).value;
        if (v) q.set(bfParams[f], v);
      }
    }
    q.set('page', String(page));
    return await api('/api/browse?' + q.toString());
  },
});
// the loader only ever runs for Browse; add it once, next to the engine
infLoaders.add(browseInf);

// jump from a detail page's genre chips into Browse pre-filtered to that genre
function browseByGenre(slug) {
  if (!slug || !GENRES.includes(slug)) return; // unknown slug — leave Browse alone
  showView('browseView');
  browse.mode = 'filters';
  $('alphaBar').querySelectorAll('.alpha-btn').forEach((x) => x.classList.remove('active'));
  for (const f of bfSelects) $('bf' + f).value = '';
  $('bfGenre').value = slug;
  browseInf.reset();
}

function rebuildRatingFilter() {
  const sel = $('bfRating');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Any</option>';
  for (const [v, label] of ratingOptions()) {
    const opt = el('option', null, label);
    opt.value = v;
    sel.appendChild(opt);
  }
  // keep the choice only while it's still offered (18+ hidden drops R+/Rx)
  sel.value = ratingOptions().some(([v]) => v === cur) ? cur : '';
}

function initBrowseUI() {
  // alphabet bar: All / # / A-Z / ?  (data-letter keeps the site's own
  // '0-9' and 'other' values — only the labels change)
  const bar = $('alphaBar');
  const alphaLabels = { all: 'All', '0-9': '#', other: '?' };
  for (const l of ['all', '0-9', ...'abcdefghijklmnopqrstuvwxyz'.split(''), 'other']) {
    const b = el('button', 'alpha-btn', alphaLabels[l] || l.toUpperCase());
    b.dataset.letter = l;
    if (l === 'all') b.classList.add('active');
    bar.appendChild(b);
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('.alpha-btn');
    if (!b) return;
    browse.mode = 'letter';
    browse.letter = b.dataset.letter;
    bar.querySelectorAll('.alpha-btn').forEach((x) => x.classList.toggle('active', x === b));
    for (const f of bfSelects) $('bf' + f).value = '';
    browseInf.reset();
  });

  // filter selects (rating is filled by rebuildRatingFilter — its options
  // depend on the 18+ setting)
  rebuildRatingFilter();
  for (const f of bfSelects) {
    const sel = $('bf' + f);
    const key = f.toLowerCase();
    for (const [v, label] of FILTER_OPTIONS[key] || []) {
      const opt = el('option', null, label);
      opt.value = v;
      sel.appendChild(opt);
    }
    if (key === 'genre') {
      for (const g of GENRES) {
        const opt = el('option', null, g.replace(/(^|-)(\w)/g, (_, a, c) => (a ? ' ' : '') + c.toUpperCase()));
        opt.value = g;
        sel.appendChild(opt);
      }
    }
    sel.addEventListener('change', () => {
      browse.mode = 'filters';
      $('alphaBar').querySelectorAll('.alpha-btn').forEach((x) => x.classList.remove('active'));
      browseInf.reset();
    });
  }

  $('bfReset').addEventListener('click', () => {
    browse.mode = 'letter';
    browse.letter = 'all';
    $('alphaBar').querySelectorAll('.alpha-btn').forEach((x) =>
      x.classList.toggle('active', x.dataset.letter === 'all'));
    for (const f of bfSelects) $('bf' + f).value = '';
    browseInf.reset();
  });

  // mobile: the filter row lives behind a collapsible panel
  if (IS_MOBILE) {
    $('bfToggle').addEventListener('click', () => {
      const open = document.body.classList.toggle('filters-open');
      $('bfToggle').classList.toggle('open', open);
    });
    // interacting outside the open filter panel minimizes it again
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('filters-open')) return;
      if (e.target.closest('#browseFilters') || e.target.closest('#bfToggle')) return;
      document.body.classList.remove('filters-open');
      $('bfToggle').classList.remove('open');
    });
  }

}

/* ---------------- home / search ---------------- */

/* --- mobile helpers --- */
const mqMobile = window.matchMedia('(max-width: 820px)');

/* --- sidebar ---
   Default closed everywhere (it's an overlay drawer — open at launch it covers
   the left edge of the content and reads as "UI cut off"). Persistence is
   desktop-only: a phone never writes sidebarOpen, so a desktop-set `true`
   can't force the drawer open on a narrow screen. */
let sidebarOpen = mqMobile.matches ? false : prefs().sidebarOpen === true;
function applySidebar(persist = true) {
  document.body.classList.toggle('sidebar-open', sidebarOpen);
  if (!mqMobile.matches && persist) {
    const p = prefs();
    p.sidebarOpen = sidebarOpen;
    setPrefs(p);
  }
}
$('sidebarBtn').addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  applySidebar();
});
$('drawerClose').addEventListener('click', () => { sidebarOpen = false; applySidebar(false); });
$('scrim').addEventListener('click', () => { sidebarOpen = false; applySidebar(false); });
mqMobile.addEventListener?.('change', () => {
  sidebarOpen = mqMobile.matches ? false : prefs().sidebarOpen === true;
  applySidebar(false);
});

function navHome() {
  if (appOffline) return showView('profileView'); // lockdown — home only works online
  state.query = '';
  $('resultsSection').hidden = true;
  $('loadingState').hidden = true;
  showView('homeView');
  renderContinue();
  loadRecent();
  renderUpcoming();
}

/* ---------------- schedule (airing times) ----------------
   AnimeNow-style day picker over the source's schedule widget: a 14-day strip
   with today highlighted, and per-day episode rows (title, local air time,
   next episode) enriched with the show's poster/synopsis server-side. */

const SCHED_DAYS_SHOWN = 14; // 3 days back + today + 10 ahead
let schedReq = 0; // staleness guard: only the newest answered request renders

function schedIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildSchedDays() {
  const strip = $('schedDays');
  strip.innerHTML = '';
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 3); // the strip opens a little behind today
  for (let i = 0; i < SCHED_DAYS_SHOWN; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = schedIso(d);
    const b = el('button', 'sched-day' + (iso === schedIso(today) ? ' today' : ''));
    b.dataset.date = iso;
    b.appendChild(el('span', 'sd-wd', d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()));
    b.appendChild(el('span', 'sd-num', String(d.getDate())));
    b.appendChild(el('span', 'sd-mon', iso === schedIso(today) ? 'TODAY' : d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()));
    b.addEventListener('click', () => loadSchedule(iso));
    strip.appendChild(b);
  }
}

async function loadSchedule(date) {
  if (!date) buildSchedDays();
  date = date || schedIso(new Date());
  document.querySelectorAll('.sched-day').forEach((b) => b.classList.toggle('active', b.dataset.date === date));
  const seq = ++schedReq;
  $('schedLoading').hidden = true; // the placeholder rows carry the load state now
  $('schedEmpty').hidden = true;
  renderSkeletonSched($('schedList'), 6);
  try {
    const { items } = await api(`/api/schedule?date=${date}&tz=${new Date().getTimezoneOffset()}`);
    if (seq !== schedReq) return; // superseded by another day tap
    $('schedLoading').hidden = true;
    const list = $('schedList');
    list.innerHTML = '';
    if (!items.length) $('schedEmpty').hidden = false;
    for (const it of items) {
      const card = el('article', 'sched-card');
      const thumb = el('div', 'sched-thumb');
      const img = el('img');
      loadPoster(img, it.poster);
      img.alt = it.title;
      img.loading = 'lazy';
      thumb.appendChild(img);
      if (it.time) thumb.appendChild(el('span', 'sched-time-chip', it.time));
      card.appendChild(thumb);

      const info = el('div', 'sched-info');
      info.appendChild(el('h3', 'sched-title', it.title));
      info.appendChild(el('div', 'sched-time', `// ${it.time || '--:--'}`));
      info.appendChild(el('div', 'sched-meta',
        ['Anime', it.type, it.year].filter(Boolean).join(' · ')));
      if (it.synopsis) {
        const syn = el('p', 'sched-syn', it.synopsis);
        info.appendChild(syn);
      }
      card.appendChild(info);
      const go = el('span', 'sched-go');
      go.innerHTML = icon('play');
      card.appendChild(go);
      card.addEventListener('click', () => openDetail(it.slug, it.title, it.poster));
      list.appendChild(card);
    }
  } catch (e) {
    if (seq === schedReq) {
      $('schedLoading').hidden = true;
      $('schedList').innerHTML = ''; // don't leave placeholders up
      toast('Schedule failed: ' + e.message, true);
    }
  }
}

/* --- in-window mini player while browsing --- */

// player-controls.js (pv) owns the custom video UI — it subscribes to these
// events to re-sync its control bar, mount subtitle tracks, rebuild its
// settings sheet and strip its chrome. Never awaits a pv handler.
const emitPv = (name, detail) =>
  document.dispatchEvent(new CustomEvent('pv:' + name, { detail }));

function videoActive() {
  const v = $('video');
  return !!(state.hls || v.currentSrc) && v.readyState > 0;
}

// move the live <video> element back into the full player (playback survives
// reparenting; only removing it from the document entirely would reset it)
function restoreVideoToPlayer() {
  $('videoArea').appendChild($('video'));
  $('miniPlayer').hidden = true;
  emitPv('undock');
}

// the shell runs this right before the floating picture-in-picture window
// mirrors the app surface: dock the video back into the full player if needed
// and strip every piece of chrome (body.pip-full) so the mirror is video-only —
// *including* when an episode was already playing full screen (the player page
// itself is app UI: title, tabs, detail slot below the 16:9 band)
window.__pipRestore = function () {
  const v = $('video');
  if (videoActive()) {
    if (state.view !== 'playerView') {
      restoreVideoToPlayer();
      showView('playerView');
    }
    document.body.classList.add('pip-full');
  }
  if (v && !v.paused) v.play().catch(() => {}); // re-kick playback if needed
};

// the activity tells us PiP starts/ends directly (deterministic, unlike AppState
// which re-fires 'active' mid-transition while the window is still changing);
// body.pip-full stays up for the whole floating-window lifetime
window.__setPip = function (on) {
  window.__inPip = !!on;
  if (on) window.__pipRestore && window.__pipRestore();
  else document.body.classList.remove('pip-full');
  // the floating window has no system bars — the shell must drop its
  // status-bar/gesture-bar padding or white bands frame the mirrered video
  try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'pip', on: !!on })); } catch {}
};

function minimizeToMini() {
  if (!videoActive()) return false;
  $('miniTitle').textContent = `${state.title} — EP ${state.epNum} (${state.type.toUpperCase()})`;
  emitPv('dock'); // pv hides itself + hands controls back to the native bar
  $('miniSlot').appendChild($('video'));
  $('miniPlayer').hidden = false;
  toast('Video continues in the mini player');
  return true;
}

$('miniExpand').addEventListener('click', () => {
  restoreVideoToPlayer();
  showView('playerView');
});
$('miniClose').addEventListener('click', () => stopPlayback());

/* --- detail-in-player reparenting ---
   The player page shows the show's info + episode picker under the video by
   MOVING the live detail nodes into #playerDetailSlot while an episode plays
   (same trick as the <video> ↔ #miniSlot move above). Reparenting keeps every
   listener and ID lookup alive — nothing re-renders. */
const DETAIL_NODE_IDS = ['detailMeta', 'detailTabs', 'panelEpisodes', 'panelSeasons', 'panelRelated', 'panelCast', 'panelDetails'];
let detailMounted = false;

function ensureDetailMounted() {
  if (detailMounted) return;
  const slot = $('playerDetailSlot');
  for (const id of DETAIL_NODE_IDS) slot.appendChild($(id));
  // the info card (synopsis/genres/studio…) moves under the player's
  // //DETAILS tab; back on the detail page it returns into #detailMeta
  $('panelDetails').appendChild($('detailInfo'));
  // #playerRight (SUB-DUB / server / quality / auto-next) is not parked here
  // anymore — player-controls.js relocates it onto the video overlay (#pvChips)
  // loading veil + skip-intro position against #playerWrap today; inside
  // #videoArea they track the video band exactly (incl. fullscreen)
  $('videoArea').append($('skipIntroBtn'), $('playerLoading'));
  $('playerView').classList.add('in-player');
  detailMounted = true;
}

function restorePlayerDetail() {
  if (!detailMounted) return;
  $('detailGrid').appendChild($('detailMeta')); // after the poster, original order
  $('detailMeta').appendChild($('detailInfo')); // back inside the meta block
  // #playerRight stays in the pv overlay (see ensureDetailMounted)
  const view = $('detailView'); // tabs + panels are its last 6 children
  for (const id of DETAIL_NODE_IDS.slice(1)) view.appendChild($(id));
  const wrap = $('playerWrap');
  wrap.insertBefore($('skipIntroBtn'), $('playerTop')); // original DOM order
  wrap.insertBefore($('playerLoading'), $('playerTop'));
  $('playerView').classList.remove('in-player');
  detailMounted = false;
  // //DETAILS exists only in the player — landing back on the detail page
  // with it active would leave every panel hidden
  if (state.detailTab === 'details') setDetailTab('episodes');
  syncDetailTabs();
}

// the detail content is live while it is on the detail page OR mounted under
// the player — async fills must keep rendering into the player slot
const detailAlive = () => state.view === 'detailView' || detailMounted;

/* --- touch: (removed) custom fullscreen / show-bars handling — the video
       keeps its native controls only --- */

// drag the mini player anywhere by its title bar (mouse + touch via pointer
// events), clamped to the viewport
(() => {
  const el = $('miniPlayer');
  const bar = $('miniBar');
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

  const clamp = (x, y) => {
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(Math.max(4, x), window.innerWidth - w - 4) + 'px';
    el.style.top = Math.min(Math.max(4, y), window.innerHeight - h - 4) + 'px';
  };

  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // expand/close stay clickable
    dragging = true;
    try { bar.setPointerCapture(e.pointerId); } catch {}
    const r = el.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragging) clamp(ox + e.clientX - sx, oy + e.clientY - sy);
  });
  const end = () => { dragging = false; };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
})();

/* top-level page hop, shared by the sidebar and the settings-page links:
   docks a playing episode into the mini player and leaves a history-trail
   entry so the back button / hardware back return to where you were */
async function topNav(target) {
  // offline lockdown: menu entries that need the network fold onto the
  // profile instead of loading a page that would just error out
  if (appOffline && target !== 'profile' && target !== 'settings') {
    offlineNotice();
    renderProfile();
    pollSync();
    showView('profileView');
    return;
  }
  if (state.view === 'playerView') {
    // dock the video into the in-window mini player — playback survives the
    // reparent, so browsing around never interrupts an episode
    if (!minimizeToMini()) {
      state.playId = (state.playId || 0) + 1; // cancel in-flight source resolution
      stopPlayback();
    }
  }
  // forward navigation leaves a trail entry — except re-tapping the view
  // you're already on (that would just stack a no-op "back to same place")
  const targetView = target === 'home' ? 'homeView'
    : target === 'browse' ? 'browseView'
    : target === 'schedule' ? 'scheduleView'
    : target === 'settings' ? 'settingsView'
    : target === 'feedback' ? 'feedbackView' : 'profileView';
  const fromView = state.view; // capture now — state.view moves on
  if (fromView !== targetView) pushHist(() => restoreView(fromView));
  if (target === 'home') navHome();
  else if (target === 'schedule') {
    showView('scheduleView');
    loadSchedule(); // defaults to today; re-tap just re-selects the same day
  } else if (target === 'browse') {
    showView('browseView'); // showView restores the accumulated list's scroll
    // nothing to reload while the infinite list is on screen — refetch only
    // when it's empty (first visit) or nothing but skeletons landed in it
    if (!$('browseGrid').querySelector('.card')) browseInf.reset();
  } else if (target === 'feedback') {
    showView('feedbackView');
    loadFeedback();
  } else if (target === 'profile') {
    renderProfile(); // fills from the last known status before the fetch lands
    pollSync(); // fresh status the moment the page opens
    showView('profileView');
  } else if (target === 'settings') {
    showView('settingsView');
    syncSettingsToggles.forEach((f) => f()); // toggles mirror the current prefs
    pollSync(); pollUpdate(); // sync + update rows refresh the moment the page opens
  } else {
    renderProfile(); // fills from the last known status before the fetch lands
    pollSync(); // fresh status the moment the page opens
    showView('profileView');
  }
}

document.querySelectorAll('.side-item').forEach((b) => {
  b.addEventListener('click', () => {
    // buttons like the drawer's ✕ carry .side-item styling but no nav target —
    // they must not fall through to the nav branch
    if (!b.dataset.nav) return;
    // the drawer always closes on nav — the user picked a destination, the
    // menu's job is done (on phones it would otherwise cover the content)
    sidebarOpen = false;
    applySidebar();
    topNav(b.dataset.nav);
  });
});

/* clicking anywhere outside the open drawer closes it (phones get the same
   result from the scrim; this covers desktop, where there is no scrim) */
document.addEventListener('click', (e) => {
  if (!sidebarOpen) return;
  // the ☰ button and the drawer itself own their clicks — the ☰ must still
  // be able to toggle the drawer open
  if (e.target.closest('#sidebar') || e.target.closest('#sidebarBtn')) return;
  sidebarOpen = false;
  applySidebar();
});

// search results: the same infinite engine, one loader over the query string
const searchInf = new InfList({
  footer: $('moreRow'),
  grid: $('resultsGrid'),
  view: 'homeView',
  emptyMsg: 'No results found',
  endMsg: 'End of results',
  onReset: () => {
    $('resultsSection').hidden = false;
    $('recentSection').hidden = true; // search results take over the home view
    $('continueSection').hidden = true; // ...and so do the continue-watching cards
    $('emptyState').hidden = true;
  },
  fetchPage: async (page) => {
    const { results } = await api(
      `/api/search?q=${encodeURIComponent(state.query)}&page=${page}`
    );
    return { results, totalPages: Infinity }; // no page count — an empty page is the end
  },
});
infLoaders.add(searchInf);

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  // revealing results over the home sections is a forward hop — back undoes it
  if ($('resultsSection').hidden) pushHist(() => restoreView('homeView'));
  state.query = q;
  $('resultsTitle').textContent = `Results for “${q}”`;
  showView('homeView');
  $('emptyState').hidden = true;
  searchInf.reset();
});

// placeholder shimmer cards shown in grids while network content loads
function renderSkeletonCards(grid, count) {
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const sk = el('div', 'card sk-card');
    sk.appendChild(el('div', 'sk-img sk'));
    sk.appendChild(el('div', 'sk-line sk'));
    sk.appendChild(el('div', 'sk-line short sk'));
    grid.appendChild(sk);
  }
}

// empty-grid state: shown wherever content filtering (or a fresh search)
// leaves a grid with nothing in it (local copy, background stripped)
const EMPTY_IMG = 'empty.png';

/* remote artwork loader, shared by every grid / row / hero image: every poster
   goes through the server's /img endpoint, which serves an already-cached copy
   from disk (so viewed art keeps working with the network down) or fetches the
   CDN once and saves it. The bundled placeholder art covers a dead URL — a
   broken-image glyph can never surface. A missing URL gets the placeholder outright. */
function posterLocal(url) {
  return url ? `/img?u=${btoaUrl(url)}` : null;
}
function loadPoster(img, url) {
  if (!url) {
    img.src = EMPTY_IMG;
    return;
  }
  img.onerror = () => { img.onerror = null; img.src = EMPTY_IMG; };
  img.src = posterLocal(url);
}
function renderGridEmpty(grid, message) {
  grid.innerHTML = '';
  const box = el('div', 'empty-rated');
  const img = el('img');
  img.src = EMPTY_IMG;
  img.alt = '';
  box.appendChild(img);
  box.appendChild(el('p', 'empty-rated-text', message || 'Nothing to show here'));
  grid.appendChild(box);
}

// small placeholder boxes for the episode-number grid
function renderSkeletonEps(grid, count) {
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) grid.appendChild(el('div', 'sk-ep sk'));
}

// placeholder rows shaped like the schedule's airing list
function renderSkeletonSched(grid, count) {
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = el('div', 'sk-sched');
    row.appendChild(el('div', 'sk-sched-thumb sk'));
    const info = el('div', 'sk-sched-info');
    info.appendChild(el('div', 'sk-line sk'));
    info.appendChild(el('div', 'sk-line short sk'));
    info.appendChild(el('div', 'sk-line sk'));
    row.appendChild(info);
    grid.appendChild(row);
  }
}

// placeholder cards shaped like the feedback board's entries
function renderSkeletonFeedback(list, count) {
  list.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = el('div', 'sk-fb');
    row.appendChild(el('div', 'sk-line short sk'));
    row.appendChild(el('div', 'sk-line sk'));
    row.appendChild(el('div', 'sk-line sk'));
    list.appendChild(row);
  }
}

function makeCard(r) {
  const card = el('div', 'card');
  card.dataset.slug = r.slug; // sweepAdultRatings finds/hides cards by slug
  card.title = r.title; // native tooltip shows the full name over the clamped title
  const media = el('div', 'card-media'); // anchors the date badge to the art, not the title
  const img = el('img');
  loadPoster(img, r.poster);
  img.loading = 'lazy';
  media.appendChild(img);
  const title = el('div', 'card-title'); // gradient veil + clamped text below
  title.appendChild(el('div', 'card-title-text', r.title));
  media.appendChild(title);
  card.appendChild(media);
  card.addEventListener('click', () => openDetail(r.slug, r.title, r.poster));
  attachFavBtn(card, r);
  return card;
}

/* ---------------- recently updated / Popular / Top Rated (home tabs) ---------------- */

// one grid under a tab strip: the recently-updated feed, the site's
// most-popular list and its highest-scored shows. Tab state is session-only.
let homeTab = 'recent';
const HOME_TABS = {
  recent: '/api/recent',
  popular: '/api/homelist?tab=popular',
  toprated: '/api/homelist?tab=toprated',
};
// short client-side cache so tab flips are instant (the server adds its own
// longer TTL cache, so a refresh here still reuses warmed lists)
const homeTabCache = new Map(); // tab -> [ { slugs: Set, results } ]
let loadingTab = false;

async function loadRecent(tab = homeTab, force = false) {
  const section = $('recentSection');
  section.hidden = false;
  loadingTab = true;
  try {
    const cached = homeTabCache.get(tab);
    if (cached && !force) {
      renderHomeTab(tab, cached, false);
      return;
    }
    renderSkeletonCards($('recentGrid'), 12);
    const { results } = await api(HOME_TABS[tab]);
    if (state.view !== 'homeView' || !$('resultsSection').hidden) return; // user moved on
    homeTabCache.set(tab, results);
    renderHomeTab(tab, results, true);
  } catch {
    // tab fetch failed (hiccups happen): keep the section and the tab strip,
    // drop in a tappable hint — tapping the tab again refetches
    if (state.view !== 'homeView') return;
    $('recentLoading').hidden = true;
    const grid = $('recentGrid');
    grid.innerHTML = '';
    renderGridEmpty(grid, "Can't load this tab — tap the tab to retry");
  } finally {
    loadingTab = false;
  }
}
// paint a settled result set: cards (+ NEW pills on the update feed)
function renderHomeTab(tab, results, spin) {
  const section = $('recentSection');
  section.hidden = false;
  $('recentLoading').hidden = true;
  const grid = $('recentGrid');
  grid.innerHTML = '';
  const shown = results.filter(r18Visible).slice(0, 30);
  if (!shown.length) renderGridEmpty(grid, 'Nothing to show right now');
  else for (const r of shown) grid.appendChild(makeCard(r));
  // every show on the recently-updated feed just released an episode
  if (tab === 'recent') {
    rememberRecent(results);
    for (const media of grid.querySelectorAll('.card .card-media')) {
      if (!media.querySelector('.new-badge')) media.appendChild(newBadgeEl());
    }
  }
  sweepAdultRatings(grid);
  state.recentLoaded = true;
}
// tab strip wiring
$('homeTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('#homeTabs button'); // clicks on the gaps do nothing
  if (!btn) return;
  const tab = btn.dataset.tab;
  if (!tab || tab === homeTab || loadingTab) return;
  homeTab = tab;
  for (const b of $('homeTabs').querySelectorAll('button')) b.classList.toggle('active', b === btn);
  loadRecent(tab);
});

/* ---------------- hero spotlight carousel ---------------- */

// featured shows from the source homepage (max 5): banner art, stat chips,
// 2-line synopsis, Watch now / Details. Best-effort like the other home rows —
// a failed fetch just leaves the hero hidden.
let heroItems = [];
let heroIdx = 0;
let heroTimer = null;
const HERO_ADVANCE_MS = 7000;

async function loadHero() {
  $('heroSkeleton').hidden = false; // shimmer until spotlight returns (or fails)
  try {
    const { results } = await api('/api/spotlight');
    heroItems = results.filter(r18Visible).slice(0, 5);
    if (heroItems.length) renderHero();
  } catch { /* hero stays hidden */ }
  $('heroSkeleton').hidden = true; // success or fail — never leave it blinking
}

function heroSlideHtml(r, i, active) {
  const slide = el('div', 'hero-slide');
  if (active) slide.classList.add('active');
  const img = el('img', 'hero-bg');
  loadPoster(img, r.banner);
  img.alt = '';
  slide.appendChild(img);
  slide.appendChild(el('div', 'hero-veil'));

  const content = el('div', 'hero-content');
  const chips = el('div', 'hero-chips');
  for (const c of [r.type, r.duration, r.date].filter(Boolean)) {
    chips.appendChild(el('span', 'hero-chip', c));
  }
  if (chips.children.length) content.appendChild(chips);
  content.appendChild(el('h2', 'hero-title', r.title));
  if (r.synopsis) content.appendChild(el('p', 'hero-desc', r.synopsis));

  const actions = el('div', 'hero-actions');
  // watched this show before? the primary button becomes "Continue" and picks up
  // at the saved episode/position instead of restarting at episode 1
  const progress = getJSON()[r.slug];
  const resume = progress && progress.epNum && (progress.pct || 0) < 100;
  const watch = el('button', 'pill-btn hero-watch');
  if (resume) {
    watch.innerHTML = `${icon('play')} Continue EP ${progress.epNum}`;
    watch.addEventListener('click', () => {
      openDetail(r.slug, r.title, r.poster, () => {
        state.epNum = progress.epNum;
        startPlayback(progress.epNum, prefAudioType());
      });
    });
  } else {
    watch.innerHTML = `${icon('play')} Watch now`;
    // straight into episode 1 — same onReady flow the continue-watching cards
    // use (openDetail loads the episodes, then playback starts)
    watch.addEventListener('click', () => {
      openDetail(r.slug, r.title, r.poster, () => {
        state.epNum = '1';
        startPlayback('1', prefAudioType());
      });
    });
  }
  const details = el('button', 'pill-btn hero-details');
  details.innerHTML = `${icon('info')} Details`;
  details.addEventListener('click', () => {
    // poster may be null (spotlight slides don't carry one) — openDetail
    // backfills it from the detail page data
    openDetail(r.slug, r.title, r.poster);
  });
  actions.appendChild(watch);
  actions.appendChild(details);
  content.appendChild(actions);
  slide.appendChild(content);
  return slide;
}

function renderHero(keepIdx) {
  const wrap = $('heroSlides');
  const dots = $('heroDots');
  wrap.innerHTML = '';
  dots.innerHTML = '';
  // a re-render (returning home) keeps the slide the user was looking at;
  // only the first paint starts from the beginning
  heroIdx = Number.isInteger(keepIdx) && keepIdx >= 0 && keepIdx < heroItems.length ? keepIdx : 0;
  heroItems.forEach((r, i) => {
    wrap.appendChild(heroSlideHtml(r, i, i === heroIdx));
    const dot = el('button', 'hero-dot');
    if (i === heroIdx) dot.classList.add('active');
    dot.title = r.title;
    dot.addEventListener('click', () => heroGo(i));
    dots.appendChild(dot);
  });
  $('heroCarousel').hidden = false;
  restartHeroTimer();
}

function heroGo(i) {
  heroIdx = i;
  [...$('heroSlides').children].forEach((s, j) => s.classList.toggle('active', j === i));
  [...$('heroDots').children].forEach((d, j) => d.classList.toggle('active', j === i));
  restartHeroTimer(); // a manual switch buys a fresh full interval
}

function restartHeroTimer() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    // idle rotation only while Home is actually on screen
    if ($('homeView').hidden || document.hidden) return;
    heroGo((heroIdx + 1) % heroItems.length);
  }, HERO_ADVANCE_MS);
}

/* ---------------- upcoming (Coming soon) ---------------- */

let upcomingData = null; // cached /api/upcoming results

async function loadUpcoming() {
  const skeleton = $('upSkeleton');
  if (!upcomingData) { // first load: shimmer bar before the strip knows its shape
    skeleton.hidden = false;
    skeleton.innerHTML = '';
    for (let i = 0; i < 6; i++) skeleton.appendChild(el('div', 'sk-up-item sk'));
  }
  try {
    const { results } = await api('/api/upcoming');
    upcomingData = results;
    checkStaleUpcoming(results); // async — render now, drop stale cards when known
    renderUpcoming();
  } catch { /* best-effort: the sections simply stay hidden */ }
  skeleton.hidden = true; // success or fail — no placeholder left behind
}

// The source keeps shows listed as upcoming after their premiere date has
// passed — when zero episodes have aired (the date is simply never removed),
// the card sits in "Coming soon" forever. One batched episode-count call
// flags those as stale; every slug is only verified once per session.
const staleUpcomingChecked = new Set();
function checkStaleUpcoming(items) {
  const due = items.filter((r) => {
    if (staleUpcomingChecked.has(r.slug)) return false;
    // a full "Sep 7, 2026" date only — year-less dates can't prove staleness
    return /^[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}$/.test(r.date || '') &&
      Date.now() - Date.parse(r.date) > 36 * 3600 * 1000; // grace: airing day
  });
  for (const r of due) staleUpcomingChecked.add(r.slug);
  if (!due.length) return;
  api('/api/epcounts', { slugs: due.map((r) => r.slug) })
    .then(({ counts }) => {
      let changed = false;
      for (const r of due) {
        if (counts[r.slug] === 0) { r.stale = true; changed = true; }
      }
      if (changed) renderUpcoming(); // re-render without the stale cards
    })
    .catch(() => {});
}

// re-render both the marquee and the Coming soon grid (also called when the
// 18+ setting changes)
function renderUpcoming() {
  renderUpcomingMarquee();
  renderUpcomingSection();
}

// premiere date passed but zero episodes aired — the source just never removes
// the date, so these are dropped everywhere "Coming soon" is shown
function notStale(r) { return !r.stale; }

function renderUpcomingSection() {
  const section = $('upcomingSection');
  const items = (upcomingData || []).filter(r18Visible).filter(notStale);
  if (!items.length) { section.hidden = true; return; }
  // group by release year — only the current one and the next are shown
  const yNow = new Date().getFullYear();
  const byYear = new Map();
  for (const r of items) {
    const m = /(\d{4})/.exec(r.date || '');
    const y = m ? +m[1] : yNow;
    if (y < yNow || y > yNow + 1) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (!years.length) { section.hidden = true; return; }
  const wrap = $('upcomingYears');
  wrap.innerHTML = '';
  for (const y of years) {
    const head = el('div', 'year-head');
    head.appendChild(el('h3', null, String(y)));
    const slider = el('div', 'slider');
    for (const r of byYear.get(y)) {
      const card = makeCard(r);
      if (r.date) card.querySelector('.card-media').appendChild(el('span', 'date-badge', r.date));
      slider.appendChild(card);
    }
    wrap.appendChild(head);
    wrap.appendChild(slider);
  }
  // "View all" opens the full list, not just the two-year window
  const all = items.filter((r) => {
    const m = /(\d{4})/.exec(r.date || '');
    return !m || +m[1] >= yNow;
  });
  const btn = $('upAll');
  btn.hidden = all.length <= 12;
  btn.onclick = () => openCollection({ kind: 'list', items: all, title: 'Coming soon' });
  sweepAdultRatings(wrap);
  section.hidden = false;
}

// top strip on Home: the same shows auto-scrolling; the sequence is built
// twice so the CSS translateX(-50%) loop is seamless. Favoriting one of these
// notifies on release day via the regular favorites checker.
function renderUpcomingMarquee() {
  const wrap = $('upMarquee');
  const track = $('upTrack');
  const items = (upcomingData || []).filter(r18Visible).filter(notStale).slice(0, 14);
  if (!items.length) { wrap.hidden = true; return; }
  track.innerHTML = '';
  const build = () => {
    for (const r of items) {
      const b = el('button', 'up-item');
      const img = el('img');
      loadPoster(img, r.poster);
      img.loading = 'lazy';
      img.alt = '';
      b.appendChild(img);
      const meta = el('span', 'up-meta');
      meta.appendChild(el('span', 'up-name', r.title));
      meta.appendChild(el('span', 'up-date', r.date || 'Coming soon'));
      b.appendChild(meta);
      b.title = r.title;
      b.dataset.slug = r.slug; // sweepAdultRatings finds/hides cards by slug
      b.addEventListener('click', () => openDetail(r.slug, r.title, r.poster));
      track.appendChild(b);
    }
  };
  build();
  build();
  sweepAdultRatings(track); // covers both copies of the seamless loop
  wrap.hidden = false;
}

function btoaUrl(s) {
  return encodeURIComponent(btoa(unescape(encodeURIComponent(s))));
}

/* ---- login gate collage (hardcoded local posters under ui/covers) ----
   Four rows of bundled posters panning in alternating directions behind the
   sign-in screen, tilted 40° as one plane (#loginCollage .collage-tilt);
   the rows are blurred/dimmed in CSS. Each half of a row repeats the list
   twice so the shared translateX(-50%) marquee loop stays seamless AND wide
   enough for the rotated diagonal extent (super-ultrawide needs ~4.6k px) —
   same trick as #upTrack above. */
const LOGIN_COVERS = [
  'frieren-beyond-journey-s-end', 'jujutsu-kaisen', 'one-piece',
  'demon-slayer-kimetsu-no-yaiba', 'attack-on-titan', 'solo-leveling',
  'death-note', 'fullmetal-alchemist-brotherhood', 'steins-gate',
  'code-geass-lelouch-of-the-rebellion', 'monster', 'spy-x-family',
  'chainsaw-man', 'vinland-saga', 'dandadan', 'violet-evergarden',
];

function buildLoginCollage() {
  const wrap = $('loginCollage');
  if (!wrap || wrap.childElementCount) return;
  const tilt = el('div', 'collage-tilt');
  const tiles = () => {
    const frag = document.createDocumentFragment();
    for (const f of [...LOGIN_COVERS, ...LOGIN_COVERS]) {
      const img = el('img');
      img.src = `covers/${f}.jpg`; // same-origin under the local server
      img.alt = '';
      img.decoding = 'async';
      img.onerror = () => { img.style.visibility = 'hidden'; }; // keep width → loop stays seamless
      frag.appendChild(img);
    }
    return frag;
  };
  for (const cls of ['collage-row r1', 'collage-row r2', 'collage-row r3', 'collage-row r4']) {
    const row = el('div', cls);
    row.appendChild(tiles());
    row.appendChild(tiles());
    tilt.appendChild(row);
  }
  wrap.appendChild(tilt);
}

/* ---------------- continue watching ---------------- */

function renderContinue() {
  const items = Object.entries(getJSON())
    .map(([slug, v]) => ({ slug, ...v }))
    .filter((v) => v.title && v.epNum)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 12);
  const section = $('continueSection');
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  $('clearHistoryBtn').hidden = false;
  const grid = $('continueGrid');
  grid.innerHTML = '';
  for (const it of items) {
    const card = el('div', 'card');
    const media = el('div', 'card-media');
    const img = el('img');
    loadPoster(img, it.poster);
    img.loading = 'lazy';
    media.appendChild(img);
    card.dataset.slug = it.slug;
    const title = el('div', 'card-title'); // gradient veil + clamped text below
    title.appendChild(el('div', 'card-title-text', it.title));
    media.appendChild(title);
    card.appendChild(media);
    card.title = it.title; // native tooltip shows the full name over the clamped title
    const bar = el('div', 'resume-bar');
    const fill = el('div');
    fill.style.width = `${Math.min(100, it.pct || 0)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(el('div', 'resume-label', `EP ${it.epNum} · ${fmtTime(it.t)}`));
    card.addEventListener('click', () => {
      openDetail(it.slug, it.title, it.poster, () => {
        state.epNum = it.epNum;
        startPlayback(it.epNum, prefAudioType());
      });
    });
    attachFavBtn(card, it);
    // ✕ to drop this show from the watch history
    const rm = el('button', 'fav-btn remove-btn');
    rm.innerHTML = icon('x');
    rm.title = 'Remove from watch history';
    rm.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the card's detail view
      const all = getJSON();
      delete all[it.slug];
      addTombstone('progress', it.slug); // sync: keep it deleted on other devices
      setJSON(all); // also schedules a backup write
      toast(`Removed "${it.title}" from history`);
      renderContinue();
    });
    card.appendChild(rm);
    grid.appendChild(card);
  }
}

$('clearHistoryBtn').addEventListener('click', async () => {
  if (!(await confirmDialog('Remove every show from your watch history?', { title: 'Clear watch history', okText: 'Clear all', icon: 'i-trash', danger: true }))) return;
  for (const slug of Object.keys(getJSON())) addTombstone('progress', slug);
  setJSON({});
  toast('Watch history cleared');
  renderContinue();
});

/* ---------------- detail ---------------- */

// meta line under the title: "EP 12 | TV | 24m | ★8.7" — the EP segment only
// appears once an episode has actually been picked (state.epNum), never on a
// cold open; d omitted re-renders from the cached /api/detail payload
function renderMetaLine(d) {
  if (d) state.detailData = d;
  const line = $('detailMetaLine');
  const det = d || state.detailData;
  const parts = [
    state.epNum ? `EP ${state.epNum}` : null,
    det && det.type,
    det && det.duration,
    det && det.malScore ? `★ ${det.malScore}` : null,
  ].filter(Boolean);
  line.textContent = parts.join('  |  ');
  line.hidden = !parts.length;
}

// inline switches (auto-next / hot swap / server change) skip renderEpisodes,
// so the "EP n" line and the grid's .current tile need an explicit sync
function syncCurrentEp() {
  renderMetaLine();
  for (const b of document.querySelectorAll('#epGrid .ep-btn'))
    b.classList.toggle('current', b.dataset.num === String(state.epNum));
}

function renderDetailInfo(d) {
  if (!d) {
    // loading state: skeleton lines where the info will land
    $('detailInfo').hidden = false;
    $('detailMetaLine').hidden = true; // no stale meta line during load
    $('detailInfoLoading').hidden = true;
    for (const id of ['detailSynopsis', 'detailChips', 'detailGenres', 'detailMetaRows']) $(id).hidden = true;
    const box = $('detailSkeleton');
    box.innerHTML = '';
    box.hidden = false;
    const chipRow = el('div', 'sk-chips');
    for (let i = 0; i < 4; i++) chipRow.appendChild(el('div', 'sk-chip sk'));
    box.appendChild(chipRow);
    for (const w of ['w80', '', '', 'w60']) box.appendChild(el('div', `sk-syn sk ${w}`.trim()));
    return;
  }
  $('detailInfoLoading').hidden = true;
  $('detailSkeleton').hidden = true;
  $('detailSynopsis').textContent = d.synopsis || '';
  $('detailSynopsis').hidden = !d.synopsis;
  renderMetaLine(d); // type/duration/score moved here + live "EP n" segment

  // chips: age rating · aired date (the rest lives in the meta line)
  const chips = $('detailChips');
  chips.hidden = false;
  $('detailMetaRows').hidden = false;
  chips.innerHTML = '';
  const chipVals = [
    d.pgRating,
    d.aired ? `Aired ${d.aired}` : null,
  ].filter(Boolean);
  for (const c of chipVals) chips.appendChild(el('span', 'chip', c));

  const genres = $('detailGenres');
  genres.innerHTML = '';
  genres.hidden = !d.genres.length;
  if (d.genres.length) {
    genres.appendChild(el('span', 'chip-label', 'Genres:'));
    d.genres.forEach((g, i) => {
      const chip = el('button', 'chip chip-btn', g);
      chip.title = `Browse ${g} anime`;
      chip.addEventListener('click', () => browseByGenre(d.genreSlugs[i]));
      genres.appendChild(chip);
    });
  } else {
    genres.hidden = true;
  }

  const rows = $('detailMetaRows');
  rows.innerHTML = '';
  // studios / producers render as buttons when the detail page linked them —
  // each opens a collection page listing every anime from that company
  const linkedRow = (label, links) => {
    const row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-key', label));
    const val = el('span', 'meta-val');
    links.forEach((l, i) => {
      if (i) val.appendChild(document.createTextNode(', '));
      const b = el('button', 'link-btn', l.name);
      b.title = `All anime by ${l.name}`;
      b.addEventListener('click', () => openCollection({
        kind: 'path', path: l.path, title: l.name,
      }));
      val.appendChild(b);
    });
    row.appendChild(val);
    return row;
  };
  const rowsData = [
    ['Japanese', (d.japanese || '').length ? d.japanese : null],
    ['Studio', d.studioLinks && d.studioLinks.length
      ? linkedRow('Studio', d.studioLinks)
      : d.studios.length ? d.studios.join(', ') : null],
    ['Producers', d.producerLinks && d.producerLinks.length
      ? linkedRow('Producers', d.producerLinks)
      : d.producers.length ? d.producers.join(', ') : null],
    ['Status', d.status],
  ];
  for (const [k, v] of rowsData) {
    if (!v) continue;
    const row = typeof v === 'object' ? v : (() => {
      const r = el('div', 'meta-row');
      r.appendChild(el('span', 'meta-key', k));
      r.appendChild(el('span', 'meta-val', v));
      return r;
    })();
    rows.appendChild(row);
  }
  $('detailInfo').hidden = !chipVals.length && !d.synopsis && $('detailMetaLine').hidden;

  // keep the favorite record current with the show's genres — they feed the
  // favourites-based recommendations
  if (isFav(state.slug) && (d.genreSlugs || []).length) {
    const f = getFavs();
    if (f[state.slug] && String(f[state.slug].genres) !== String(d.genreSlugs)) {
      f[state.slug].genres = d.genreSlugs;
      setFavs(f);
    }
  }

  // mobile: synopsis clamps to 3 lines behind a View more toggle — offer the
  // toggle only when the text actually overflows the clamp. Measured more than
  // once: a single rAF can run before the view/fonts have settled, and a
  // 0-height layout reads as "no overflow", hiding the toggle for good.
  const syn = $('detailSynopsis');
  const st = $('synopsisToggle');
  syn.classList.add('clamped');
  st.textContent = 'View more';
  requestAnimationFrame(syncSynopsisToggle);
  setTimeout(syncSynopsisToggle, 300);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncSynopsisToggle);
}

// show the toggle when the clamped synopsis overflows; keep it while expanded
// ("View less"), and hide it when there's nothing to expand
function syncSynopsisToggle() {
  const syn = $('detailSynopsis');
  const st = $('synopsisToggle');
  if (syn.hidden) { st.hidden = true; return; }
  const expanded = !syn.classList.contains('clamped');
  st.hidden = !expanded && syn.scrollHeight <= syn.clientHeight + 2;
}

/* true when the detail page on screen was served from the offline disk cache
   (/api/detail adds cached:true) — the info card gets a small "Saved copy" chip */
let detailStale = false;

async function loadDetailInfo() {
  const slug = state.slug;
  let d = null;
  try {
    d = await api(`/api/detail?slug=${encodeURIComponent(slug)}`);
  } catch { /* nothing cached and the source unreachable — handled below */ }
  if (state.slug !== slug) return; // user hopped shows mid-fetch
  detailStale = !!(d && d.cached);
  if (d) {
    // entry points that only know the slug (hero spotlight) open with no
    // poster — the detail page's own art backfills the card and the backdrop
    if (d.poster && !state.poster) {
      state.poster = d.poster;
      setDetailPoster(d.poster);
      $('detailHero').style.setProperty('--detail-bg', `url("${posterLocal(d.poster)}")`);
    }
    state.audioCounts = { sub: d.subCount || null, dub: d.dubCount || null };
    applyAudioAvail(d);
    renderDetailInfo(d);
    if (detailStale) $('detailChips').appendChild(el('span', 'chip chip-faint', 'Saved copy'));
    renderRelated(d);
    renderRecommendations(d);
  } else {
    // offline with nothing saved: kill the skeleton and say what happened,
    // instead of leaving the info card loading forever. renderDetailInfo hides
    // #detailInfo when it has nothing to render — the note lives in there, so
    // re-show just the note.
    renderDetailInfo({ genres: [], studios: [], producers: [] });
    $('detailChips').hidden = true;
    $('detailMetaRows').hidden = true;
    $('detailInfo').hidden = false;
    $('detailNoData').hidden = false;
  }
}

/* ---- audio availability ----
   The detail page tags SUB/DUB episode counts — but the source ships non-zero
   counts even on sub-only shows, so they only ever *hide* a track when the
   count is an explicit 0. The real ground truth is the episode list's per-
   episode server list (d.audio from /api/episodes), which wins whenever we
   have it. A missing half of the SUB/DUB toggles is hidden, and state.type is
   pinned to a track that exists (syncSwapToggle applies both toggles). */
function applyAudioAvail(d) {
  if (d.audio) state.audioProbed = true; // probe data beats the counts
  else if (state.audioProbed) return; // ...and survives a slower detail reply
  state.audioAvail = d.audio
    ? { ...d.audio }
    : (() => {
        const sub = d.subCount && d.subCount !== '0';
        const dub = d.dubCount && d.dubCount !== '0';
        return { sub: sub || (!sub && !dub), dub };
      })();
  if (!state.audioAvail[state.type]) {
    state.type = state.audioAvail.sub ? 'sub' : 'dub';
  }
  syncSwapToggle();
  sweepTrackAuds(); // best-effort: narrows the grid to real per-ep audio
}

// per-episode audio sweep for shows small enough that probing each episode
// (1 request/ep) is sane. Only worth it when the show HAS dub — a sub-only
// show serves every listed ep in its only track. Re-renders when it lands.
async function sweepTrackAuds() {
  const slug = state.slug;
  if (!state.audioAvail || !state.audioAvail.dub || state.episodes.length > 60) return;
  if (state.epAuds) return; // already narrowed by the probe (or probing done)
  try {
    const j = await fetch(`/api/auds?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(120000) });
    if (!j.ok) return;
    const { auds } = await j.json();
    if (state.slug !== slug) return; // another show opened meanwhile
    state.epAuds = auds || null;
    if (state.epAuds) renderEpisodes();
  } catch { /* narrowing is best-effort; the tagged counts stay */ }
}

/* ---- seasons & movies (the source's "Related Anime" block) ---- */

function renderRelated(d) {
  const section = $('relSection');
  const items = (d.related || [])
    .filter((r) => r.slug !== state.slug)
    .filter(r18Visible);
  state.related = items;
  if (!items.length) { section.hidden = true; syncDetailTabs(); return; }
  // horizontal slider — every related entry fits without a "view all" hop
  const slider = $('relSlider');
  slider.innerHTML = '';
  for (const r of items) {
    const card = makeCard(r);
    card.classList.add('season-card'); // SEASONS-tab styling + "N EPS" badge hook
    slider.appendChild(card);
  }
  sweepAdultRatings(slider);
  section.hidden = false;
  syncDetailTabs();
}

// "N EPS" badges for the seasons cards: one episodes lookup per slug, so this
// only runs when the SEASONS tab is actually opened (once per detail visit)
let relCountSeq = 0;
async function loadRelCounts() {
  const seq = ++relCountSeq;
  const items = (state.related || []).slice(0, 100); // /api/epcounts caps at 100 slugs
  if (!items.length) return;
  try {
    const counts = await epcountsRequest(items.map((r) => r.slug));
    if (seq !== relCountSeq || !detailAlive()) return; // user moved on
    const slider = $('relSlider');
    for (const r of items) {
      const c = counts[r.slug];
      if (typeof c !== 'number') continue;
      const card = slider.querySelector(`[data-slug="${CSS.escape(r.slug)}"]`);
      if (!card || card.querySelector('.season-badge')) continue;
      card.querySelector('.card-media').appendChild(el('span', 'season-badge', `${c} EPS`));
    }
    state.relCountsLoaded = true;
  } catch { /* fetch failed → cards stay unbadged */ }
}

/* ---- detail tabs (//EPISODE / //SEASONS / //RELATED) ----
   Pure in-page state — never pushed to the nav trail. */

const DETAIL_PANELS = {
  episodes: 'panelEpisodes',
  seasons: 'panelSeasons',
  related: 'panelRelated',
  cast: 'panelCast',
  details: 'panelDetails', // player screen only (tab hidden on the detail page)
};

function setDetailTab(name) {
  if (!DETAIL_PANELS[name]) return;
  state.detailTab = name;
  document.querySelectorAll('#detailTabs .detail-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name));
  for (const [tab, id] of Object.entries(DETAIL_PANELS)) $(id).hidden = tab !== name;
  if (name === 'seasons' && !state.relCountsLoaded && (state.related || []).length) {
    loadRelCounts();
  }
  if (name === 'cast') loadCast(); // lazily fetched, once per show
}

$('detailTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.detail-tab');
  if (b && !b.hidden) setDetailTab(b.dataset.tab);
});

// tabs mirror what actually rendered: no related entries → no SEASONS tab,
// no recommendations → no RELATED tab, neither → no tab row at all. Under the
// player the row stays up regardless — //DETAILS is always available there.
function syncDetailTabs() {
  if (appOffline) { applyOfflineDetail(); return; } // row folds — see applyOfflineDetail
  const hasRel = !$('relSection').hidden;
  const hasRec = !$('recSection').hidden;
  const tabs = $('detailTabs');
  tabs.querySelector('[data-tab="seasons"]').hidden = !hasRel;
  tabs.querySelector('[data-tab="related"]').hidden = !hasRec;
  // //CAST is always there (lazy-fetched on first open) — with it in the row,
  // the row is live on every detail page, even section-less ones
  tabs.hidden = false;
  if ((state.detailTab === 'seasons' && !hasRel) ||
      (state.detailTab === 'related' && !hasRec)) setDetailTab('episodes');
}

/* ---- //CAST tab (characters + Japanese voice actors) ----
   Fill is lazy (first open of the tab) and memoized per show: hopping
   tab → show → tab doesn't re-hit the network. A fetch racing a show
   hop is dropped by the slug check. */
async function loadCast() {
  if (!state.slug || state.detailTab !== 'cast') return; // tab closed mid-fetch
  if (state.castSlug === state.slug && state.castDone) return; // already filled
  const wasFailed = state.castSlug === state.slug && state.castFailed;
  state.castSlug = state.slug;
  state.castDone = false;
  state.castFailed = false;
  if (!wasFailed) $('castGrid').innerHTML = '';
  $('castEmpty').hidden = true;
  $('castLoad').hidden = false;
  try {
    const { cast } = await api(`/api/cast?slug=${encodeURIComponent(state.slug)}`);
    if (state.castSlug !== state.slug) return; // user hopped shows mid-fetch
    $('castLoad').hidden = true;
    state.castDone = true;
    if (!cast || !cast.length) {
      $('castEmpty').textContent = 'No cast information found';
      $('castEmpty').hidden = false;
      return;
    }
    const img0 = $('castGrid').querySelector('img'); // keep retry cards' art
    if (!img0) $('castGrid').innerHTML = '';
    for (const c of cast) {
      const card = el('div', `cast-card${c.main ? ' lead' : ''}`);
      const img = el('img');
      loadPoster(img, c.image);
      card.appendChild(img);
      const txt = el('div', 'cast-txt');
      txt.appendChild(el('div', 'cast-name', c.name || '?'));
      txt.appendChild(el('div', 'cast-va', c.va ? `${c.va.name} (Japanese)` : 'No VA listed'));
      card.appendChild(txt);
      $('castGrid').appendChild(card);
    }
  } catch (e) {
    if (state.castSlug !== state.slug) return;
    $('castLoad').hidden = true;
    state.castFailed = true;
    $('castEmpty').textContent = `Cast unavailable — tap CAST to retry (${e.message || e})`;
    $('castEmpty').hidden = false;
  }
}

/* ---- collection pages ----
   One generic grid page for two kinds of listing: a studio / producer path
   (paginated, served by /api/collection) or a static list (a show's full
   seasons & movies from the "View all" button). */

const collection = { path: null, title: '' };

// studio / producer listings: the same infinite engine, scrolled over the path
const collInf = new InfList({
  footer: $('collectionLoad'),
  grid: $('collectionGrid'),
  view: 'collectionView',
  emptyMsg: 'Nothing to show here',
  fetchPage: async (page) =>
    await api(`/api/collection?path=${encodeURIComponent(collection.path)}&page=${page}`),
});
infLoaders.add(collInf);

async function openCollection(opts) {
  const fromView = state.view; // capture before the view changes
  pushHist(() => restoreView(fromView)); // trail: back returns to where we came from
  scrollMem.collectionView = 0; // each collection opens at the top
  if (opts.kind === 'list') {
    // static list: everything on screen at once, no loader needed
    collection.path = null;
    $('collectionTitle').textContent = opts.title;
    const grid = $('collectionGrid');
    grid.innerHTML = '';
    const items = opts.items.filter(r18Visible);
    if (!items.length) renderGridEmpty(grid, 'Nothing to show here');
    else for (const r of items) grid.appendChild(makeCard(r));
    sweepAdultRatings(grid);
    $('collectionLoad').hidden = true;
    showView('collectionView');
  } else {
    collection.path = opts.path;
    collection.title = opts.title;
    $('collectionTitle').textContent = `${collection.title} anime`;
    showView('collectionView');
    await collInf.reset();
  }
}

/* ---- recommendations ----
   Six picks always on screen, driven by a genre profile: the current show's
   genres plus (weighted 2×) the genres of the user's favorites. Anything
   already favorited never shows up. Legacy favorite records carry no genres —
   the most recent few are backfilled from /api/detail (server-cached). */
let recSeq = 0;
async function renderRecommendations(d) {
  const seq = ++recSeq;
  const section = $('recSection');
  section.hidden = false; // skeleton up while the genre picks resolve
  renderSkeletonCards($('recGrid'), 6);
  syncDetailTabs();
  const seen = new Set([state.slug]);
  for (const s of Object.keys(getFavs())) seen.add(s);

  const genreWeight = new Map();
  const addGenre = (g, w) => {
    if (GENRES.includes(g)) genreWeight.set(g, (genreWeight.get(g) || 0) + w);
  };
  (d.genreSlugs || []).forEach((g) => addGenre(g, 1));

  const favs = Object.entries(getFavs())
    .map(([slug, v]) => ({ slug, ...v }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const missing = favs.filter((f) => !(f.genres || []).length).slice(0, 4);
  await Promise.all(missing.map(async (f) => {
    try {
      const det = await api(`/api/detail?slug=${encodeURIComponent(f.slug)}`);
      const gs = det.genreSlugs || [];
      if (gs.length) {
        const all = getFavs();
        if (all[f.slug]) { all[f.slug].genres = gs; setFavs(all); }
        gs.forEach((g) => addGenre(g, 2));
      }
    } catch { /* one favorite failing must not sink the section */ }
  }));
  favs.forEach((f) => (f.genres || []).forEach((g) => addGenre(g, 2)));
  if (seq !== recSeq || !detailAlive()) return;

  const genres = [...genreWeight.entries()]
    .sort((a, b) => b[1] - a[1])
    .map((e) => e[0])
    .slice(0, 4);
  const picked = [];
  const take = (results) => {
    for (const r of results.filter(r18Visible)) {
      if (picked.length >= 6) break;
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      picked.push(r);
    }
  };
  for (const g of genres) {
    if (picked.length >= 6) break;
    try {
      const { results } = await api(`/api/browse?genre=${encodeURIComponent(g)}&sort=most_viewed&page=1`);
      if (seq !== recSeq || !detailAlive()) return; // user moved on
      take(results);
    } catch { /* best-effort */ }
  }
  if (seq !== recSeq || !detailAlive() || !picked.length) {
    // nothing surfaced (or the user moved on): drop the placeholders
    if (seq === recSeq && detailAlive()) {
      section.hidden = true;
      $('recGrid').innerHTML = '';
      syncDetailTabs();
    }
    return;
  }
  const grid = $('recGrid');
  grid.innerHTML = '';
  for (const r of picked) grid.appendChild(makeCard(r));
  sweepAdultRatings(grid);
  section.hidden = false;
  syncDetailTabs();
}

function updateDetailFav() {
  // icon-only bookmark button — state lives in .active + the tooltip
  const on = state.slug && isFav(state.slug);
  $('favBtn').classList.toggle('active', !!on);
  $('favBtn').title = on ? 'Remove from favorites' : 'Add to favorites';
}

$('favBtn').addEventListener('click', () => {
  toggleFav({ slug: state.slug, title: state.title, poster: state.poster });
  updateDetailFav();
  if (!$('profileView').hidden) renderFavorites();
});

/* detail poster loader: through the server's /img cache (same path the grid
   covers use). The img keeps opacity 0 (#detailPoster:not(.ok)) until a load
   succeeds, so a broken first fetch never flashes the browser's broken-image
   glyph in the empty card. */
function setDetailPoster(url) {
  const img = $('detailPoster');
  img.classList.remove('ok');
  if (!url) { img.removeAttribute('src'); img.onload = null; img.onerror = null; return; }
  img.onload = () => img.classList.add('ok');
  // dead URL or an offline no-cache miss → the placeholder art instead of an empty card
  img.onerror = () => {
    img.onerror = null;
    img.onload = () => img.classList.add('ok');
    img.src = EMPTY_IMG;
  };
  img.src = posterLocal(url);
}

async function openDetail(slug, title, poster, onReady) {
  // trail: hopping to a show from anywhere (or from another detail page via
  // recommendations) is a forward hop — back returns to what was on screen
  const from = { view: state.view, slug: state.slug, title: state.title, poster: state.poster };
  const fromView = state.view;
  if (from.view === 'detailView' && from.slug && from.slug !== slug) {
    pushHist(() => openDetail(from.slug, from.title, from.poster));
  } else if (fromView === 'playerView') {
    // leaving the player for a rec/related card: dock playback, and back
    // returns to the live player (restoreView('playerView') would kill it)
    pushHist(() => { restoreVideoToPlayer(); showView('playerView'); });
    if (!minimizeToMini()) {
      state.playId = (state.playId || 0) + 1; // kill any in-flight resolve
      stopPlayback();
    }
  } else if (from.view !== 'detailView') {
    pushHist(() => restoreView(from.view));
  }
  state.slug = slug;
  state.title = title;
  state.poster = poster;
  state.epNum = null;
  state.audioAvail = null; // unknown until the detail/episodes data lands
  state.audioProbed = false; // set once the server-list probe answers
  state.audioCounts = null;
  state.epAuds = null; // fresh sweep per show
  state.relCountsLoaded = false;
  state.epFilter = '';
  $('epFindInput').value = '';
  $('epFindClear').hidden = true;
  $('epNoMatch').hidden = true; // may be left up by the previous show
  $('epFind').hidden = false; // re-hidden per show once the count is known (< 25 eps)
  $('epNoMatch').hidden = true;
  if (appOffline) {
    // offline lockdown: hero info card only — no episodes/seasons/related/cast
    applyOfflineDetail();
  } else {
    setDetailTab('episodes');
  }
  state.type = prefAudioType();
  syncSwapToggle();
  $('detailTitle').textContent = title;
  $('detailTitle').title = title; // desktop hover shows a long clamped title in full
  setDetailPoster(poster);
  // hero backdrop: same art, blurred behind the header (CSS reads --detail-bg);
  // the local /img URL has no quotes so no escaping is needed
  $('detailHero').style.setProperty(
    '--detail-bg',
    poster ? `url("${posterLocal(poster)}")` : 'none'
  );
  updateDetailFav();
  detailStale = false; // per-show marker; loadDetailInfo re-decides it
  $('detailNoData').hidden = true; // ...and the nothing-saved note
  renderDetailInfo(null); // hide stale info while loading
  $('recSection').hidden = true; // ...and stale recommendations
  $('relSection').hidden = true; // ...and stale seasons & movies
  $('castGrid').innerHTML = '';
  $('castEmpty').hidden = true;
  $('castLoad').hidden = true; // //CAST refills on first open (per-show memo)
  state.castSlug = null;
  state.castDone = false;
  state.castFailed = false;
  syncDetailTabs(); // tab row matches the (still empty) sections
  loadDetailInfo();
  $('epCount').textContent = '';
  // the back trail (pushHist above) now owns the "Back" button's destination
  showView('detailView');
  $('epLoading').hidden = true;
  if (appOffline) {
    // offline lockdown: the tab row is folded (applyOfflineDetail above), the
    // episode grid stays empty (its fetch needs the network anyway), and the
    // resume handoff is never delivered — the detail page is the destination
    return;
  }
  renderSkeletonEps($('epGrid'), 12);
  try {
    const { episodes, audio } = await api(`/api/episodes?slug=${encodeURIComponent(slug)}`);
    state.episodes = episodes;
    trackVisits(slug, episodes.length); // visit baseline: new releases for non-favorites too
    if (audio) applyAudioAvail({ audio }); // hide toggles the show doesn't have
    $('epCount').textContent = episodes.length; // the h2 supplies the word EPISODES
    renderEpisodes();
    if (onReady) onReady();
  } catch (e) {
    $('epGrid').innerHTML = ''; // don't leave skeletons up
    const off = typeof navigator !== 'undefined' && navigator.onLine === false;
    toast(off
      ? 'Episodes need internet - the grid fills back in when you are online.'
      : 'Could not load episodes: ' + e.message, !off);
  } finally {
    $('epLoading').hidden = true;
  }
}

document.querySelectorAll('#typeToggle button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.hidden) return; // track the show doesn't have (hidden by applyAudioAvail)
    state.type = b.dataset.type;
    syncSwapToggle();
    const p = prefs(); p.lastType = state.type; setPrefs(p);
    renderEpisodes();
  });
});

function renderEpisodes() {
  const grid = $('epGrid');
  grid.innerHTML = '';
  const prog = getJSON()[state.slug] || {};
  const watched = prog.watched || [];
  // per-episode audio narrowing (small shows, see probeTrack): the episode
  // list can hold eps the selected track doesn't have (source tags go stale)
  const auds = state.epAuds || null;
  // "new release" tiles, freshest N at the end of the grid (works for shows
  // whose episode numbers don't run 1..N — specials, renumbered seasons):
  //   favorited shows  → the bell panel's tracking count
  //   opened before    → the visit baseline's growth since the last visit
  //   never touched it → on the recently-updated feed right now = last tile
  const track = notifActive().find((n) => n.slug === state.slug);
  let freshCount = track
    ? Number(track.newCount) || 0
    : (state.visitNew ? state.visitNew.hi - state.visitNew.lo + 1 : 0);
  if (recentSet.has(state.slug)) freshCount = Math.max(freshCount, 1);
  freshCount = Math.min(freshCount, state.episodes.length);
  const firstFreshIdx = state.episodes.length - freshCount;
  let ei = 0;
  for (const ep of state.episodes) {
    if (auds && auds[ep.num] && auds[ep.num][state.type] === false) continue; // no audio here
    const btn = el('button', 'ep-btn');
    btn.dataset.num = ep.num; // FIND EP filter matches on this
    const num = el('span', 'ep-num', ep.num);
    btn.appendChild(num);
    btn.appendChild(el('span', 'ep-type', state.type.toUpperCase()));
    if (ep.num === String(state.epNum)) btn.classList.add('current');
    // the check is independent of "current" — the episode you just played is
    // both, and hiding its check made it look unwatched
    if (watched.includes(String(ep.num))) {
      btn.classList.add('watched');
      num.textContent = `✓ ${ep.num}`;
    }
    if (ep.dead) {
      // every embed for this episode was dead — warn before the click, not after
      btn.classList.add('dead');
      btn.title = 'This episode is unavailable at the source (all embeds dead). Click to retry anyway.';
    }
    // the freshest tiles carry the same comet rim the NEW pill (bell rows) wear
    if (ei >= firstFreshIdx) btn.classList.add('ep-new');
    btn.addEventListener('click', () =>
      startPlayback(ep.num, state.type, { push: state.view !== 'playerView' }));
    grid.appendChild(btn);
    ei++;
  }
  renderMetaLine(); // refresh the "EP n" segment after a playback round trip
  // header + pills follow what the grid shows (the sweep may have narrowed it
  // to the eps the selected track actually has); the FIND box only earns its
  // keep on shows long enough to need hunting
  $('epCount').textContent = grid.children.length;
  $('epFind').hidden = state.episodes.length < 25;
  renderAudioPills();
  applyEpFilter();
}

/* ---- FIND EP search: digits only, prefix/contains match, leading zeros
   ignored on both sides. Hides non-matching tiles in place so watched /
   current / dead classes and tooltips are never rebuilt. Skeleton tiles
   (.sk-ep) don't carry .ep-btn and are never filtered. */
function normalizeEpNum(s) {
  return String(s).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

function applyEpFilter() {
  const q = normalizeEpNum(state.epFilter || '');
  const grid = $('epGrid');
  const filtering = q !== '' && !!grid.querySelector('.ep-btn');
  let visible = 0;
  for (const btn of grid.children) {
    if (!btn.classList.contains('ep-btn')) continue;
    const hit = !filtering || normalizeEpNum(btn.dataset.num).includes(q);
    btn.hidden = !hit;
    if (hit) visible++;
  }
  $('epNoMatch').hidden = !(filtering && visible === 0);
  $('epFindClear').hidden = !state.epFilter;
}

$('epFindInput').addEventListener('input', () => {
  state.epFilter = $('epFindInput').value;
  applyEpFilter();
});

$('epFindClear').addEventListener('click', () => {
  $('epFindInput').value = '';
  state.epFilter = '';
  applyEpFilter();
  $('epFindInput').focus();
});

// every back button (detail, player, collection) unwinds the same trail the
// Android hardware back walks
document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => goBack());
});

/* ---------------- player ---------------- */

function stopPlayback(restarting) {
  // pv: sheet closed, chrome stripped, brightness released — a seamless
  // stream swap (server/SUB↔DUB switch) passes restarting so pv KEEPS
  // rotated fullscreen instead of unwinding it mid-swap
  emitPv('stop', { restarting: !!restarting });
  restoreVideoToPlayer();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  clearInterval(state.progressTimer);
  clearInterval(state.introTimer);
  clearInterval(state.watchTimer);
  state.watchPersistNow = true;
  persistWatch();
  state.watchUsed = null; // ends the session — badge hides until the next episode
  $('watchBadge').hidden = true;
  $('watchUpOverlay').hidden = true;
  for (const t of [...video.querySelectorAll('track')]) t.remove();
}

// any playthrough marks the episode watched — recorded the moment playback
// actually starts, so a few seconds of watching still counts
function markWatched() {
  if (!state.slug || !state.epNum) return;
  const all = getJSON();
  const prev = all[state.slug] || {};
  const watched = new Set(prev.watched || []);
  watched.add(String(state.epNum));
  all[state.slug] = {
    ...prev,
    watched: [...watched].sort((a, b) => Number(a) - Number(b)),
  };
  setJSON(all);
}

function saveProgress(final = false) {
  if (!state.slug || !state.epNum) return;
  const video = $('video');
  if (!video.duration || isNaN(video.duration)) return;
  const all = getJSON();
  const prev = all[state.slug] || {};
  const pct = Math.round((video.currentTime / video.duration) * 100);
  // any playthrough marks the episode as watched — finished or not
  const watched = new Set(prev.watched || []);
  watched.add(String(state.epNum));
  all[state.slug] = {
    title: state.title,
    poster: state.poster,
    epNum: state.epNum,
    t: video.currentTime,
    dur: video.duration,
    pct,
    ts: Date.now(),
    watched: [...watched].sort((a, b) => Number(a) - Number(b)),
  };
  setJSON(all);
  if (final) {
    // drop fully-watched entries from "continue watching" only if near end
    const v = all[state.slug];
    if (v.pct > 95) v.t = 0;
    setJSON(all);
  }
}

// opts.push: false for in-player hops (auto-next/hot swap) — those
// must not stack trail entries

// the episode grid + info block living under the player video: filled here
// when playback starts without a detail visit. slotFillSlug stops a re-entry
// (failover / auto-next / swap) from re-fetching the same show.
let slotFillSlug = null;
async function fillPlayerDetail() {
  if (detailMounted && state.episodes.length) return; // came from the detail page
  if (slotFillSlug === state.slug) return; // already fetched / in flight
  const slug = state.slug;
  slotFillSlug = slug;
  $('detailTitle').textContent = state.title || ''; // openDetail isn't in this path
  try {
    const { episodes, audio } = await api(`/api/episodes?slug=${encodeURIComponent(slug)}`);
    if (state.slug !== slug) return;
    state.episodes = episodes;
    if (audio) applyAudioAvail({ audio });
    $('epCount').textContent = episodes.length;
    renderEpisodes();
    loadDetailInfo(); // info block + related + recs into the slot
  } catch { /* slot stays empty; playback itself is unaffected */ }
}

async function startPlayback(epNum, type, opts = {}) {
  if (appOffline) {
    offlineNotice();
    return; // lockdown: streaming needs the network — profile cards never enter the player offline
  }
  stopPlayback(true); // pv stays rotated fullscreen across the swap
  state.epNum = String(epNum);
  state.type = type;
  syncSwapToggle();
  syncCurrentEp(); // "EP n" line + .current tile track inline switches too
  if (opts.push !== false) {
    pushHist(() => { stopPlayback(); showView('detailView'); renderEpisodes(); });
  }
  const playId = (state.playId = (state.playId || 0) + 1);
  // servers already tried for THIS playback — the hls error handler walks
  // state.sources.servers to fail over without revisiting a dead one
  state.triedServers = opts.tried || (opts.server ? [opts.server] : []);
  state.stallLog = [];
  showView('playerView');
  // entered without a detail visit (defensive — every entry currently goes
  // through openDetail's onReady): fill the slot's grid/info in the background
  if (!state.audioAvail || !state.episodes.length) fillPlayerDetail();
  $('playerTitle').textContent = state.title;
  $('playerEp').textContent = `EP ${epNum} (${type.toUpperCase()})`;
  $('playerLoading').hidden = false;
  $('skipIntroBtn').hidden = true;
  $('providerLabel').textContent = '';
  const video = $('video');
  video.poster = state.poster || '';

  // live elapsed counter so the wait is never a silent hang
  const t0 = Date.now();
  const tick = setInterval(() => {
    if (state.playId === playId && !$('playerLoading').hidden) {
      $('playerStatus').textContent = `Resolving sources… ${Math.round((Date.now() - t0) / 1000)}s`;
    }
  }, 500);
  $('playerStatus').textContent = opts.src ? 'Switching server…' : 'Resolving sources…';

  let src;
  if (opts.src) {
    // pre-resolved by the server-dropdown switch — skip the lookup entirely
    src = opts.src;
  } else {
    // resolve with the user's preferred server first (an explicit failover
    // hop's server wins, else the settings default / last manual pick).
    // A failure here is not the dead-episode flow below — it just means
    // this episode doesn't offer that server or its stream is dead, so
    // rerun the standard first-available resolve without pinning one.
    const want = opts.server || prefServer();
    const sourceUrl = (server) =>
      `/api/sources?slug=${encodeURIComponent(state.slug)}&ep=${encodeURIComponent(epNum)}&type=${type}` +
      (server ? `&server=${encodeURIComponent(server)}` : '');
    try {
      try {
        src = await api(sourceUrl(want));
      } catch {
        if (state.playId !== playId) return;
        src = await api(sourceUrl(''));
      }
    } catch (e) {
      if (state.playId !== playId) return;
      // auto-fallback to the other audio type; adopt fb as the requested type so
      // the post-resolve audioType check below doesn't toast about it a second time
      const fb = e.fallbackType || (type === 'sub' ? 'dub' : 'sub');
      try {
        src = await api(
          `/api/sources?slug=${encodeURIComponent(state.slug)}&ep=${encodeURIComponent(epNum)}&type=${fb}`
        );
        toast(`No ${type.toUpperCase()} source — playing ${fb.toUpperCase()} instead`);
        type = fb;
        state.type = fb;
        syncSwapToggle(); // toggle + ep label now show the track actually playing
        $('playerEp').textContent = `EP ${epNum} (${fb.toUpperCase()})`;
      } catch (e2) {
        if (state.playId !== playId) return;
        clearInterval(tick);
        // the scraper's message already says sub+dub were tried and that the
        // embeds are dead/removed — show it plainly instead of stacking text
        $('playerStatus').textContent = e2.message;
        $('playerStatus').textContent += ' — pick another episode or a different show.';
        toast(e2.message, true);
        return;
      }
    }
  }
  clearInterval(tick);
  if (state.playId !== playId) return;
  state.sources = src;
  // the scraper silently resolved the other track when the requested one has
  // no embeds for this episode — say so, and make the toggle + label reflect
  // the audio actually playing
  if (src.audioType && src.audioType !== type) {
    state.type = src.audioType;
    syncSwapToggle();
    $('playerEp').textContent = `EP ${epNum} (${src.audioType.toUpperCase()})`;
    toast(`No ${type.toUpperCase()} source for this episode — playing ${src.audioType.toUpperCase()}`);
  }
  $('providerLabel').textContent = `via ${src.provider || 'hianime'}`;
  updateServerSel(src);
  $('playerLoading').hidden = true;

  if (src.hls === false || !Hls.isSupported()) {
    // native stream (e.g. mp4): no hls quality menu — play directly
    video.src = src.proxiedUrl;
    video.play().catch(() => {});
  } else {
    const hls = new Hls({
      maxBufferLength: 60,
      fragLoadingTimeOut: 30000,
    });
    state.hls = hls;
    let recovers = 0; // in-place recovery budget before a server hop
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      buildQualityMenu(hls);
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) {
        if (/stalled/i.test(data.details)) recordStall(hls);
        return;
      }
      // Transient upstream failures (proxy 500s, dropped sockets) used to hop
      // servers immediately — the re-resolve + re-buffering between hops read
      // as an endless "buffer loop". hls.js can recover both error classes in
      // place; only fail over once recovery is genuinely exhausted.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovers < 2) {
        recovers++;
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovers < 2) {
        recovers++;
        hls.recoverMediaError();
        return;
      }
      // failover: this server's stream is dead — hand playback to the next
      // provider the episode offers instead of leaving a stuck player
      const names = (state.sources && state.sources.servers) || [];
      const cur = state.sources && state.sources.provider;
      const tried = state.triedServers || [];
      const next = names.find((n) => n !== cur && !tried.includes(n));
      if (next && state.playId === playId) {
        saveProgress(); // resume at the same spot on the new server
        toast(`Server ${cur || 'stream'} failed — trying ${next}`);
        startPlayback(state.epNum, state.type, {
          push: false,
          server: next,
          tried: [...tried, cur].filter(Boolean),
        });
        return;
      }
      $('playerStatus').textContent = 'Playback error — try another episode or quality.';
      toast('Playback error: ' + data.details, true);
    });
    hls.loadSource(src.proxiedUrl);
    hls.attachMedia(video);
  }

  // subtitles: mounted by player-controls.js on the pv:source event below —
  // it fetches EVERY offered .vtt (the default one is just first), builds the
  // <track> list and drives the in-player subtitle picker (app.js only wants
  // to know the default track exists; the picker owns switching)

  // resume position
  const saved = getJSON()[state.slug];
  if (saved && String(saved.epNum) === String(epNum) && saved.t > 30 && saved.pct < 95) {
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = saved.t;
      toast(`Resumed at ${fmtTime(saved.t)}`);
    }, { once: true });
  }

  setupWatchers(src);
  emitPv('source'); // pv: subtitle tracks, sheet, speed/quality mirrors
}

// repeated stalling while a quality is LOCKED means the stream is too heavy
// for the connection — step down one rung. In Auto mode this is a no-op:
// hls.js's adaptive bitrate already picks the level the bandwidth supports.
function recordStall(hls) {
  const now = Date.now();
  state.stallLog = (state.stallLog || []).filter((t) => now - t < 25000);
  state.stallLog.push(now);
  if (state.stallLog.length < 3) return; // 3 stalls inside 25s = suffering
  state.stallLog = [];
  if (hls.autoLevelEnabled) return;
  const levels = hls.levels
    .map((l, i) => ({ h: l.height, i }))
    .sort((a, b) => b.h - a.h);
  const lower = levels[levels.findIndex((l) => l.i === hls.currentLevel) + 1];
  if (lower && lower.h) {
    hls.currentLevel = lower.i;
    $('qualitySel').value = String(lower.i);
    toast(`Buffering — lowered quality to ${lower.h}p`);
  }
}

function buildQualityMenu(hls) {
  const sel = $('qualitySel');
  sel.innerHTML = '<option value="-1">Auto</option>';
  const levels = [...hls.levels]
    .map((l, i) => ({ h: l.height, i }))
    .sort((a, b) => b.h - a.h);
  for (const { h, i } of levels) {
    const opt = el('option', null, `${h}p`);
    opt.value = String(i);
    sel.appendChild(opt);
  }
  // apply saved default quality (exact match, else nearest lower, else auto)
  const def = String(prefs().quality || 'auto');
  if (def !== 'auto') {
    const wantH = parseInt(def, 10);
    const pick =
      levels.find((l) => l.h === wantH) ||
      levels.filter((l) => l.h <= wantH).sort((a, b) => b.h - a.h)[0] ||
      levels[0];
    sel.value = String(pick.i);
    hls.currentLevel = pick.i;
    toast(`Quality locked to ${pick.h}p (change in Settings)`);
  }
  emitPv('sync'); // pv: quality rows in the settings sheet match the new levels
}

$('qualitySel').addEventListener('change', (e) => {
  if (state.hls) state.hls.currentLevel = parseInt(e.target.value, 10);
  state.stallLog = []; // fresh buffering allowance for the quality just chosen
});

function setupWatchers(src) {
  const video = $('video');
  clearInterval(state.progressTimer);
  clearInterval(state.introTimer);
  clearInterval(state.watchTimer);

  state.progressTimer = setInterval(() => {
    if (!video.paused) saveProgress();
  }, 5000);

  // daily watch budget: snapshot today's remaining time, then tick per second.
  // The same tick also feeds the lifetime counter (profile page's watch time).
  state.watchUsed = storedWatchUsed();
  state.watchTotal = Math.round(prefs().totalWatch || 0);
  state.watchDate = todayKey();
  state.watchTimer = setInterval(watchTick, 1000);
  updateWatchBadge();
  video.addEventListener('play', markWatched, { once: true });
  video.addEventListener('ended', () => {
    saveProgress(true);
    if ($('autoNextBtn').classList.contains('on')) {
      const next = state.episodes.find(
        (e) => parseFloat(e.num) > parseFloat(state.epNum)
      );
      if (next) startPlayback(next.num, state.type, { push: false });
    }
  }, { once: true });

  // skip intro
  const skip = src.skip && src.skip.intro;
  if (skip && skip.end > skip.start) {
    state.introTimer = setInterval(() => {
      const t = video.currentTime;
      $('skipIntroBtn').hidden = !(t >= skip.start && t < skip.end - 1);
    }, 500);
  }
}

$('skipIntroBtn').addEventListener('click', () => {
  const skip = state.sources && state.sources.skip && state.sources.skip.intro;
  if (skip) $('video').currentTime = skip.end;
});

$('playerCancelBtn').addEventListener('click', () => {
  stopPlayback();
  showView('detailView');
  renderEpisodes();
});

/* ---- daily watch-time limit ----
   45 minutes of real playback per calendar day. Paused and buffering video
   don't tick (readyState < 3 = still fetching data). The budget lives in
   prefs so it survives restarts and syncs with the backup; the badge sits in
   the bottom player bar — outside the video and pointer-transparent — and
   the timeout popup is absolute inside #playerWrap, so fullscreen shows it. */
const DAILY_LIMIT = 45 * 60; // seconds

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// the stored budget only counts for its own calendar day — a new day starts full
function storedWatchUsed() {
  const w = prefs().watchLimit;
  return w && w.date === todayKey() ? (w.used || 0) : 0;
}

// ticks write locally only; real moments (pause / stop / reset / unload) also
// schedule a backup so the synced blob doesn't churn every second
function persistWatch() {
  if (state.watchUsed == null) return;
  const p = prefs();
  p.watchLimit = { date: todayKey(), used: state.watchUsed };
  if (state.watchTotal != null) p.totalWatch = state.watchTotal;
  if (state.watchPersistNow) {
    state.watchPersistNow = false;
    setPrefs(p);
  } else {
    setPrefsSilent(p);
  }
}

function updateWatchBadge() {
  const badge = $('watchBadge');
  badge.hidden = state.watchUsed == null;
  const rem = Math.max(0, DAILY_LIMIT - (state.watchUsed || 0));
  $('watchTime').textContent = fmtTime(rem);
  badge.classList.toggle('low', rem > 0 && rem < 5 * 60);
}

function showWatchUp() {
  if (!$('watchUpOverlay').hidden) return;
  $('watchUpOverlay').hidden = false;
}

function watchTick() {
  const video = $('video');
  // midnight rollover mid-session: a new day means a fresh budget
  if (state.watchDate !== todayKey()) {
    state.watchDate = todayKey();
    state.watchUsed = 0;
  }
  // readyState < HAVE_FUTURE_DATA (3) = buffering/stalled — that time is free
  if (!video.paused && !video.ended && video.readyState >= 3 && video.currentTime > 0) {
    state.watchUsed += 1;
    state.watchTotal += 1;
    if (state.watchUsed % 15 === 0) persistWatch();
    if (state.watchUsed >= DAILY_LIMIT) {
      video.pause(); // the 'pause' handler below persists the spent budget
      showWatchUp();
    }
  }
  updateWatchBadge();
}

// refill the daily budget in place — used by the free reset (desktop) and the
// rewarded-ad path (Android); unlimited refills, each one restores 45:00
function resetWatchBudget() {
  state.watchUsed = 0;
  state.watchDate = todayKey();
  state.watchPersistNow = true;
  persistWatch();
  $('watchUpOverlay').hidden = true;
  updateWatchBadge();
  const video = $('video');
  if (videoActive()) video.play().catch(() => {});
}

// rewarded-ad failure streak (per day): when AdMob has no inventory the tester
// would be hard-stuck at the wall, so after every 3rd failed attempt the
// budget hands back a grace chunk instead (see the adReward handler below)
const AD_FAIL_GRACE_EVERY = 3;
const AD_GRACE_MIN = 15;

// a partial refill that keeps the rest of today's spend — unlike
// resetWatchBudget (full refill for ads / free desktop reset)
function graceRefill(secs) {
  state.watchUsed = Math.max(0, (state.watchUsed || 0) - secs);
  state.watchDate = todayKey();
  state.watchPersistNow = true;
  persistWatch();
  $('watchUpOverlay').hidden = true;
  updateWatchBadge();
  const video = $('video');
  if (videoActive()) video.play().catch(() => {});
}

function storedAdFail() {
  const f = prefs().adFail;
  return f && f.date === todayKey() ? f.count || 0 : 0;
}

function bumpAdFail() {
  const n = storedAdFail() + 1;
  const p = prefs();
  p.adFail = { date: todayKey(), count: n };
  setPrefsSilent(p);
  return n;
}

function clearAdFail() {
  const p = prefs();
  if (p.adFail) { delete p.adFail; setPrefsSilent(p); }
}

// desktop has no AdMob SDK — the reset stays free; Android earns it by
// watching a rewarded ad (see the watchAdBtn handler below)
if (!IS_ANDROID) {
  $('watchResetBtn').addEventListener('click', () => {
    resetWatchBudget();
    toast('Timer reset — 45:00 of watch time back');
  });
  $('watchResetBtn').hidden = false;
} else {
  $('watchAdBtn').hidden = false;
  $('watchUpText').textContent =
    "You've used all 45 minutes of watch time for today. Watch a short ad to refill them, or exit the player — tomorrow brings a fresh 45 minutes. If an ad can't load, a few retries are rewarded with grace time.";
}

// rewarded ad refill: hand off to the Expo shell, which loads/shows a Google
// rewarded ad and answers with an 'adReward' message (handled in the shell
// message listener at the bottom of this file)
let adRequestSeq = 0; // ignores stale replies after a retry
let adRequestTimer = null; // safety net if the shell never answers
$('watchAdBtn').addEventListener('click', () => {
  if (IS_ANDROID && window.ReactNativeWebView) {
    const btn = $('watchAdBtn');
    const seq = ++adRequestSeq;
    btn.disabled = true;
    btn.textContent = 'Loading ad…';
    // if the shell never answers (dropped request, killed process), restore
    // the button after 45s — a late reply is dropped by the seq check
    clearTimeout(adRequestTimer);
    adRequestTimer = setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Watch ad — +45 min';
    }, 45000);
    // adminHint: the shell prefers its own /api/auth/status check, but keeps
    // this as a fallback so the admin still gets the test ad if that fetch
    // ever fails (see showRewardedAd in App.tsx)
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'showAd',
      seq,
      adminHint: !!(lastSyncStatus && lastSyncStatus.isAdmin),
    }));
  }
});

// "Exit" leaves the player for the show's detail page — same trail the
// player's Back button unwinds
$('watchExitBtn').addEventListener('click', () => {
  stopPlayback();
  showView('detailView');
  renderEpisodes();
});

// video lives for the whole app session, so these wire up once — not per episode
$('video').addEventListener('pause', () => {
  state.watchPersistNow = true;
  persistWatch();
});
// pressing play with a spent budget just brings the popup back
$('video').addEventListener('play', () => {
  if (state.watchUsed != null && state.watchUsed >= DAILY_LIMIT) {
    $('video').pause();
    showWatchUp();
  }
});
window.addEventListener('beforeunload', () => {
  state.watchPersistNow = true;
  persistWatch();
});

/* ---- sub/dub hot swap ----
   Re-resolves the current episode in the other audio track; saveProgress ran
   just before, so startPlayback resumes at the position we left. */
function syncSwapToggle() {
  // both segmented toggles (detail view + player) mirror state.type; buttons
  // for a track the show doesn't have are hidden, not just inactive
  for (const sel of ['#typeToggle', '#swapToggle']) {
    document.querySelectorAll(`${sel} button`).forEach((x) => {
      const t = x.dataset.type;
      x.classList.toggle('active', t === state.type);
      x.hidden = !!(state.audioAvail && !state.audioAvail[t]);
    });
  }
  renderAudioPills(); // detail-page pills carry episode counts
}

/* detail-page audio pills read "SUB 1180 EP": source counts when /api/detail
   answered, else the episode-list length when that track is available, else
   the bare label while nothing is known yet */
function renderAudioPills() {
  const c = state.audioCounts || {};
  const auds = state.epAuds || null; // probed per-episode truth beats tags
  document.querySelectorAll('#typeToggle button').forEach((b) => {
    const t = b.dataset.type;
    let n = c[t] || (state.audioAvail && state.audioAvail[t] && state.episodes.length
      ? state.episodes.length : null);
    if (auds && Object.keys(auds).length) {
      const probed = auds.filter
        ? 0
        : Object.values(auds).reduce((acc, a) => acc + (a && a[t] === true ? 1 : 0), 0);
      n = probed || null; // probe answered; the tagged count goes stale
    }
    b.textContent = n ? `${t.toUpperCase()} ${n} EP` : t.toUpperCase();
  });
}
document.querySelectorAll('#swapToggle button').forEach((b) => {
  b.addEventListener('click', () => {
    const type = b.dataset.type;
    if (!state.epNum || type === state.type || state.view !== 'playerView') return;
    saveProgress(); // remember the position in the outgoing track
    state.type = type;
    syncSwapToggle();
    const p = prefs(); p.lastType = type; setPrefs(p);
    startPlayback(state.epNum, type, { push: false });
  });
});

/* ---------------- server dropdown (stream providers) ---------------- */

// populate from the resolution result — every new source resolution refreshes
// it (audio fallback re-queries included); hidden when there's no choice
function updateServerSel(src) {
  const sel = $('serverSel');
  const names = src.servers || [];
  sel.innerHTML = '';
  for (const n of names) {
    const opt = el('option', null, n);
    opt.value = n;
    sel.appendChild(opt);
  }
  if (src.provider && names.includes(src.provider)) sel.value = src.provider;
  sel.hidden = names.length < 2;
  emitPv('sync'); // pv: server rows in the settings sheet match the new providers
}

$('serverSel').addEventListener('change', async (e) => {
  const want = e.target.value;
  const cur = state.sources && state.sources.provider;
  if (!state.epNum || state.view !== 'playerView' || !want || want === cur) return;
  const epNum = state.epNum;
  const type = state.type;
  const playId = state.playId; // a newer playback wins; drop this switch then
  toast(`Loading ${want}…`);
  try {
    // resolve the new server WITHOUT touching the playing stream — only
    // commit the switch once the replacement stream is in hand
    const src = await api(
      `/api/sources?slug=${encodeURIComponent(state.slug)}&ep=${encodeURIComponent(epNum)}` +
        `&type=${type}&server=${encodeURIComponent(want)}`
    );
    if (state.playId !== playId || state.view !== 'playerView') return;
    saveProgress(); // remember the position in the outgoing server's stream
    // the user's pick becomes the default for future playbacks (syncs via prefs)
    const p = prefs();
    p.defaultServer = want;
    setPrefs(p);
    startPlayback(epNum, type, { push: false, src });
  } catch (err) {
    toast(`${want}: ${err.message || err}`, true);
    e.target.value = cur || ''; // stay on the working stream
  }
});

$('autoNextBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const on = !btn.classList.contains('on');
  btn.classList.toggle('on', on);
  btn.textContent = `Auto ${on ? 'ON' : 'OFF'}`; // the .on class also colors the border
  const p = prefs(); p.autoNext = on; setPrefs(p);
});
if (prefs().autoNext) {
  $('autoNextBtn').classList.add('on');
  $('autoNextBtn').textContent = 'Auto ON';
}

/* ---------------- navbar avatar / profile gear ---------------- */

// the navbar's avatar button and the profile page's round gear open their
// pages through topNav (player docking + history trail)
$('accountBtn').addEventListener('click', () => topNav('profile'));
$('profileGearBtn').addEventListener('click', () => topNav('settings'));
$('feedbackNavBtn').addEventListener('click', () => topNav('feedback'));

/* ---------------- cloud sync (Google via Supabase) ---------------- */

// The sign-in URL must open in the SYSTEM browser (the loopback callback can't
// navigate the app's own WebView): on Android the Expo shell hands it to
// Linking.openURL, on desktop window.open goes through the main-process
// window-open handler which calls shell.openExternal.
function openExternal(url) {
  if (IS_ANDROID && window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'openExternal', url }));
  } else {
    window.open(url, '_blank');
  }
}

let lastSyncRender = ''; // serialized status — re-render the row only on change
let lastSyncStatus = null; // last /api/auth/status payload (profile page reads it)
let lastDataRev = -1;
let signInPollTimer = null;

function fmtSyncWhen(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function renderSyncUI(s) {
  lastSyncStatus = s;
  // persist the payload so an offline cold start keeps the signed-in identity
  // (and the avatar) on the profile page; a signed-out poll clears the copy so
  // a stale session can never resurrect after sign-out
  try {
    if (s.signedIn) localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(s));
    else localStorage.removeItem(LAST_SYNC_KEY);
  } catch { /* private mode etc. */ }
  // the navbar avatar mirrors the signed-in identity: the locally cached photo
  // (pictureLocal → /avatar) when we have it — it survives offline — falling
  // back to a generic user glyph. Kept above the render-state early return:
  // the avatar must refresh whenever the session itself changes.
  const navAvatar = $('accountAvatar');
  if (s && s.signedIn && avatarSrc(s)) {
    navAvatar.src = avatarSrc(s);
    navAvatar.hidden = false;
    $('accountFallback').hidden = true;
  } else {
    navAvatar.hidden = true;
    navAvatar.removeAttribute('src');
    $('accountFallback').hidden = false;
  }
  // auth gate: the app requires a Google account. Shown when signed out (and
  // sign-in is actually possible); signing out anywhere lands back here, and
  // the gate drops the moment the session appears. If the build has no cloud
  // config or the callback port couldn't bind, gating would brick the app —
  // those run unlocked, offline.
  const gate = $('loginGate');
  const wasLocked = !gate.hidden;
  const guest = isGuest();
  document.body.classList.toggle('guest', guest);
  if (s.configured && s.portAvailable !== false && !s.signedIn && !guest && !appOffline) {
    gate.hidden = false;
    document.body.classList.add('auth-locked');
  } else {
    gate.hidden = true;
    document.body.classList.remove('auth-locked');
    $('loginStatus').textContent = '';
    if (s.signedIn) setGuest(false); // any session ends guest mode (idempotent)
    if (wasLocked && s.signedIn) {
      // fresh sign-in from the gate — land on the home screen instead of
      // whatever stale view was sitting behind it
      showView('homeView');
    }
  }
  // the gate is a full-screen brand-dark page: tell the Android shell so its
  // system-bar strips match it even in the light theme
  const gateUp = !gate.hidden;
  if (gateUp !== lastGateChrome && window.ReactNativeWebView) {
    lastGateChrome = gateUp;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'gate', up: gateUp }));
  }
  // remember for the next boot whether a sign-in could be live. Guest mode is
  // deliberately NOT counted here: its sessionStorage flag clears on relaunch,
  // and the welcome / sign-in page must come back on every launch.
  try {
    localStorage.setItem(GATE_SEEN_SIGNED_IN,
      (s.signedIn || !s.configured || s.portAvailable === false) ? '0' : '1');
  } catch { /* private mode etc. */ }
  const state = JSON.stringify([s.configured, s.signedIn, s.email, s.lastSync, s.lastError, s.syncing, s.portAvailable]);
  if (state === lastSyncRender) return;
  lastSyncRender = state;
  const statusText = $('syncStatusText');
  const hint = $('syncHint');
  if (!s.configured) {
    statusText.textContent = 'Off';
    hint.textContent = 'Cloud sync is not enabled in this build. Everything keeps working offline.';
  } else if (s.signedIn) {
    statusText.textContent = s.syncing ? 'Syncing…' : s.lastSync ? `On — synced ${fmtSyncWhen(s.lastSync)}` : 'On';
    hint.textContent = s.lastError
      ? `Signed in as ${s.email} — retrying (${s.lastError})`
      : `Signed in as ${s.email}. Favorites, history and settings sync automatically; offline changes catch up when you're back online.`;
  } else if (guest) {
    statusText.textContent = 'Off';
    hint.textContent = 'Guest mode — everything stays on this device. Sign in with Google any time to sync.';
  } else {
    statusText.textContent = 'Off';
    hint.textContent = s.lastError || 'Sign in with Google to keep favorites, history and settings in sync across your devices. Everything keeps working offline without an account.';
  }
  $('signInBtn').hidden = !s.configured || s.signedIn;
  $('syncNowBtn').hidden = !(s.configured && s.signedIn);
  $('signOutBtn').hidden = !(s.configured && s.signedIn);
}

let lastGateChrome = null; // last gate visibility reported to the Android shell

/* offline lockdown (see the showView/topNav guards): the header pill flips on
   connectivity changes and the app folds back to the profile. Profile, its
   settings page and a show's detail page are the only places that work
   without the network. */
let appOffline = false; // kept true by setOfflineChrome
const OFFLINE_OK_VIEWS = new Set(['profileView', 'detailView', 'settingsView']);
let offlineNoticeShown = false; // once per session — don't spam on every blocked tap

function offlineNotice() {
  if (offlineNoticeShown) return;
  offlineNoticeShown = true;
  toast('Internet is off — your profile holds your saved shows.');
}

// offline a detail page shows the hero's info card only — the tab row and its
// panels (EPISODE / SEASONS / RELATED / CAST) are all network-backed
function applyOfflineDetail() {
  $('detailTabs').hidden = true;
  for (const id of Object.values(DETAIL_PANELS)) $(id).hidden = true;
}

function setOfflineChrome() {
  const off = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (off === appOffline) { if (off) applyOfflineDetail(); return; }
  appOffline = off;
  const el0 = $('offlinePill');
  if (el0) el0.hidden = !off;
  if (!off) {
    // back online: any current view is suddenly fine again; a detail page that
    // stayed open re-opens itself — the full fetch restores the episode grid
    // and the tab row (offline it showed the hero card only)
    offlineNoticeShown = false; // the next offline stretch earns a fresh notice
    if (state.view === 'detailView' && state.slug) {
      openDetail(state.slug, state.title, state.poster);
    }
    return;
  }
  // going offline: if the welcome gate is up, dismiss it — it can't be
  // answered anyway (Google sign-in needs the network). The session runs as
  // an implicit guest and lands on the profile like offline boots do.
  const gate = $('loginGate');
  if (gate && !gate.hidden) {
    gate.hidden = true;
    document.body.classList.remove('auth-locked');
    lastGateChrome = false;
    try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'gate', up: false })); } catch {}
    try {
      const cached = JSON.parse(localStorage.getItem(LAST_SYNC_KEY));
      if (!(cached && cached.signedIn)) setGuest(true);
    } catch { setGuest(true); }
    renderProfile();
    showView('profileView'); // (offline-allowed view)
    offlineNotice();
    return;
  }
  // going offline: if we're sitting on a network-backed page it would just
  // error out — fold onto the profile right away
  if (state.view && !OFFLINE_OK_VIEWS.has(state.view)) {
    renderProfile(); // fills from the last known status + card lists
    showView('profileView'); // (offline-allowed view)
    offlineNotice();
  } else if (state.view === 'detailView') {
    applyOfflineDetail();
  } else {
    offlineNotice();
  }
}
window.addEventListener('online', setOfflineChrome);
window.addEventListener('offline', setOfflineChrome);
setOfflineChrome(); // listeners only fire on a change — paint the current state

async function pollSync() {
  try {
    const s = await api('/api/auth/status');
    renderSyncUI(s);
    // dataRev bumps when a sync merged cloud data into the local file —
    // re-read the file so new favorites/history show up without a restart
    if (typeof s.dataRev === 'number' && s.dataRev !== lastDataRev) {
      const boot = lastDataRev === -1; // the startup restore already covers rev 0..n
      lastDataRev = s.dataRev;
      if (!boot) {
        await restoreFromBackup();
        applyTheme(); // cloud sync can change it on another device
        renderFavorites();
        if (!$('profileView').hidden) renderWatching();
        renderContinue();
        renderProfile(); // profile stats count local favorites/history
      }
    }
    if (!$('profileView').hidden) renderProfile(s);
  } catch { /* server hiccup; next poll retries */ }
}

/* native Google sign-in (Android): the Expo shell opens the Credential Manager
   account picker and answers with a 'googleIdToken' message (handled in the
   shell listener at the bottom of this file). No browser tab is involved. */
let googleSignInSeq = 0; // ignores stale replies after a retry
let signInReplyWaiter = null; // settles the in-flight request's promise
let signInReplyTimer = null; // safety net if the shell never answers

function nativeGoogleSignIn(timeoutMs = 120000) {
  return new Promise((resolve) => {
    const seq = ++googleSignInSeq;
    signInReplyWaiter = (reply) => {
      clearTimeout(signInReplyTimer);
      signInReplyWaiter = null;
      resolve(reply);
    };
    // if the shell never answers (dropped request, killed process) give up
    // quietly — a late reply is dropped by the seq check, and no browser tab
    // is stacked behind an open account sheet
    signInReplyTimer = setTimeout(() => {
      signInReplyWaiter = null;
      resolve({ ok: false, timeout: true });
    }, timeoutMs);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'googleSignIn', seq }));
  });
}

/* zero Google accounts on the device → open the system "add account" screen.
   It slides over the app (same task), so nothing is closed; the shell answers
   with an 'addAccountReply' message. Returning to the app re-opens the picker
   via the visibilitychange listener below. */
let googleAddSeq = 0;
let addReplyWaiter = null;
let addAccountPending = false; // setup screen is up — retry sign-in on return

function nativeAddGoogleAccount(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const seq = ++googleAddSeq;
    let timer = null;
    addReplyWaiter = (reply) => {
      clearTimeout(timer);
      addReplyWaiter = null;
      resolve(reply);
    };
    timer = setTimeout(() => {
      addReplyWaiter = null;
      resolve({ ok: false, error: 'account setup did not open' });
    }, timeoutMs);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'addGoogleAccount', seq }));
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !addAccountPending) return;
  addAccountPending = false; // one auto-retry per opened setup screen
  if ($('loginGate').hidden) return; // gate already gone — nothing to sign into
  startSignInFlow($('loginBtn'), { auto: true });
});

/* shared sync actions — the settings row and the profile page both use these */

async function startSignInFlow(btn, opts = {}) {
  btn.disabled = true;
  try {
    // Android: sign-in is ONLY the native Google account picker — no browser
    // surface. A picker failure (dismissed, no accounts, no Play services)
    // surfaces as a toast; tapping again re-opens the picker.
    if (IS_ANDROID && window.ReactNativeWebView) {
      const reply = await nativeGoogleSignIn();
      if (reply.ok && reply.token) {
        await api('/api/auth/google', { idToken: reply.token });
        $('loginStatus').textContent = 'Signed in!';
        toast('Signed in — sync started');
        pollSync(); // drop the gate now — don't wait for the first poll tick
        return;
      }
      if (reply.timeout) return; // sheet open / shell unresponsive — just stop
      const why = reply.error || 'account picker was dismissed';
      if (reply.code === 'NO_CREDENTIAL') {
        // the device has zero Google accounts — the picker can never open.
        // Send the user to the system "add account" screen (it slides OVER the
        // app); when they come back, visibilitychange re-runs this flow and
        // the picker opens with the fresh account.
        if (opts.auto) {
          // the post-setup auto-retry found no account either (user backed
          // out) — stop here so the setup screen can't reopen in a loop; the
          // next manual tap gets it again
          $('loginStatus').textContent = 'No Google account yet — add one and tap Sign in.';
          toast('No Google account on this device', true);
          pollSync();
          return;
        }
        $('loginStatus').textContent = 'No Google account on this device — opening account setup…';
        const started = await nativeAddGoogleAccount();
        if (started.ok) {
          addAccountPending = true;
        } else {
          $('loginStatus').textContent = 'Sign-in failed: ' + (started.error || 'account setup could not open');
          toast('Sign-in failed: ' + (started.error || 'account setup could not open'), true);
        }
        pollSync();
        return;
      }
      // persistent feedback on the gate itself — a 2s toast reads as "dead button"
      $('loginStatus').textContent = 'Sign-in failed: ' + why;
      toast('Sign-in failed: ' + why, true);
      pollSync();
      return;
    }
    // Desktop: the OAuth URL opens in the app's own browser window (a popup
    // where Google lists the accounts) and the loopback closes it.
    const r = await api('/api/auth/start', {});
    if (!r.ok) throw new Error(r.error || 'Sign-in could not start');
    // the UI owns opening the auth page: desktop routes window.open into the
    // in-app browser window, Android into Custom Tabs (Google blocks OAuth in
    // embedded WebViews, so never load it in the app's own WebView)
    if (r.url) openExternal(r.url);
    $('syncHint').textContent = 'Finish signing in in your browser…';
    $('profileSyncDetail').textContent = 'Finish signing in in your browser…';
    $('loginStatus').textContent = 'Finish signing in in your browser…';
    // the callback lands on the local server; poll until the session shows up
    clearTimeout(signInPollTimer);
    const deadline = Date.now() + 60000;
    const tick = async () => {
      signInPollTimer = null;
      try {
        const s = await api('/api/auth/status');
        renderSyncUI(s);
        if (!$('profileView').hidden) renderProfile(s);
        if (s.signedIn) {
          toast('Signed in — sync started');
          return;
        }
      } catch { /* keep polling through hiccups */ }
      if (Date.now() < deadline) signInPollTimer = setTimeout(tick, 2000);
      else pollSync(); // hand back to the slow cadence
    };
    signInPollTimer = setTimeout(tick, 2000);
  } catch (e) {
    toast('Sign-in failed: ' + e.message, true);
    pollSync();
  } finally {
    btn.disabled = false;
  }
}

async function syncNowFlow(btn) {
  if (btn) btn.disabled = true;
  try {
    $('syncStatusText').textContent = 'Syncing…';
    const s = await api('/api/sync', {});
    renderSyncUI(s);
    if (!$('profileView').hidden) renderProfile(s);
  } catch (e) {
    toast('Sync failed: ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function signOutFlow(btn) {
  if (btn) btn.disabled = true;
  try {
    const s = await api('/api/auth/logout', {});
    setGuest(false); // sign-out returns to the gate — the guest choice is re-picked there
    renderSyncUI(s);
    renderProfile(s);
    toast('Signed out — your data stays on this device');
  } catch (e) {
    toast('Sign-out failed: ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('signInBtn').addEventListener('click', (e) => startSignInFlow(e.currentTarget));
$('syncNowBtn').addEventListener('click', (e) => syncNowFlow(e.currentTarget));
$('signOutBtn').addEventListener('click', (e) => signOutFlow(e.currentTarget));
$('profileSignIn').addEventListener('click', (e) => startSignInFlow(e.currentTarget));
$('loginBtn').addEventListener('click', (e) => startSignInFlow(e.currentTarget));
$('profileSignOut').addEventListener('click', (e) => signOutFlow(e.currentTarget));

$('loginGuestBtn').addEventListener('click', () => {
  setGuest(true);
  // renderSyncUI's change-guard (stringified server status) would early-return
  // here — the gate block sits ABOVE the guard, so reset the guard, then
  // re-render to hide the gate and refresh the settings row immediately.
  lastSyncRender = '';
  if (lastSyncStatus) renderSyncUI(lastSyncStatus);
  showView('homeView');
  toast('Guest mode — your data stays on this device');
});

/* ---- edit profile ----
   Everything edits prefs.profile: name/avatar/bg color/hide-email. Saving goes
   through setPrefs, so backup + cloud sync follow automatically; the navbar
   avatar and profile card re-render from the same prefs. */
const BG_SWATCHES = [
  { v: '', label: 'Default' },
  { v: '#243b55', label: 'Steel blue' },
  { v: '#33245c', label: 'Violet' },
  { v: '#0f3d2e', label: 'Forest' },
  { v: '#5c2430', label: 'Wine' },
  { v: '#4a3b19', label: 'Amber' },
  { v: '#1d4a4a', label: 'Teal' },
  { v: '#4a4a4a', label: 'Slate' },
];
let draftBg = '';    // swatch selection in the open editor ('' = theme default)
let draftAvatar = null; // data-URL chosen in the open editor (null = identity photo)

const swatchBox = $('editBgSwatches');
BG_SWATCHES.forEach(({ v, label }) => {
  const b = el('button');
  b.type = 'button';
  b.title = label;
  b.style.background = v || 'var(--bg2)';
  b.addEventListener('click', () => {
    draftBg = v;
    syncBgSwatches();
  });
  swatchBox.appendChild(b);
});
function syncBgSwatches() {
  [...swatchBox.children].forEach((b, i) =>
    b.classList.toggle('active', BG_SWATCHES[i].v === draftBg));
}

// editor preview: the draft photo wins, then the signed-in identity photo,
// then the first letter of the (custom or Google) name
function refreshEditorPreview() {
  const s = lastSyncStatus || {};
  const src = draftAvatar || (s.pictureLocal || s.picture) || null;
  const img = $('editAvatarPreview');
  const fallback = $('editAvatarFallback');
  if (src) {
    img.src = src;
    img.hidden = false;
    fallback.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    fallback.textContent = (profileEdit().name || s.name || s.email || '?').trim().charAt(0).toUpperCase();
    fallback.hidden = false;
  }
  $('editAvatarReset').hidden = !draftAvatar;
}

function openProfileEditor() {
  const p = profileEdit();
  $('editName').value = p.name || '';
  $('editHideEmail').checked = !!p.hideEmail;
  draftBg = p.bg || '';
  draftAvatar = p.avatar || null;
  syncBgSwatches();
  refreshEditorPreview();
  $('profileEditor').hidden = false;
  $('editName').focus();
}
$('editProfileBtn').addEventListener('click', openProfileEditor);
$('editProfileCancel').addEventListener('click', () => { $('profileEditor').hidden = true; });

$('editAvatarBtn').addEventListener('click', () => $('editAvatarInput').click());
$('editAvatarReset').addEventListener('click', () => {
  draftAvatar = null;
  refreshEditorPreview();
});

// chosen image → centered-crop square, downscaled to a 256px JPEG data-URL so
// the synced prefs blob stays small (~20-40KB instead of multi-MB raw files)
$('editAvatarInput').addEventListener('change', () => {
  const file = $('editAvatarInput').files[0];
  $('editAvatarInput').value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('That file is not an image', true); return; }
  if (file.size > 8 * 1024 * 1024) { toast('Image too large (max 8MB)', true); return; }
  const img = new Image();
  img.onload = () => {
    try {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, 256, 256
      );
      draftAvatar = c.toDataURL('image/jpeg', 0.85);
      refreshEditorPreview();
    } catch {
      toast('Could not read that image', true);
    }
  };
  img.onerror = () => toast('Could not read that image', true);
  img.src = URL.createObjectURL(file);
});

$('editProfileSave').addEventListener('click', () => {
  const p = prefs();
  p.profile = {
    ...profileEdit(),
    name: $('editName').value.trim() || null,
    bg: draftBg || null,
    hideEmail: $('editHideEmail').checked,
    avatar: draftAvatar || null,
  };
  setPrefs(p); // schedules the backup write + cloud sync like every pref edit
  $('profileEditor').hidden = true;
  renderProfile(); // card (name/email/bg) re-renders from the new prefs
  if (lastSyncStatus) renderSyncUI(lastSyncStatus); // navbar avatar too
  toast('Profile updated');
});

/* profile page */

/* the profile avatar mirrors the signed-in identity: a custom photo chosen in
   "Edit profile" wins, then the locally cached Google photo (pictureLocal →
   /avatar) when we have it — it survives offline — falling back to the remote
   Google URL, then a generic user glyph */
function avatarSrc(s) {
  return profileEdit().avatar || (s && (s.pictureLocal || s.picture)) || null;
}

// lifetime playback seconds → "3h 12m" / "12m" / "40s"
function fmtWatchTotal(sec) {
  sec = Math.floor(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderProfile(s) {
  s = s || lastSyncStatus || (() => {
    // cold-start fallback: the live status is only in memory, so offline after
    // a restart reads the last persisted copy instead of showing "Not signed in"
    try { return JSON.parse(localStorage.getItem(LAST_SYNC_KEY)) || null; } catch { return null; }
  })();
  const signedIn = !!(s && s.signedIn);
  const avatar = $('profileAvatar');
  const fallback = $('profileAvatarFallback');
  if (signedIn && avatarSrc(s)) {
    avatar.src = avatarSrc(s);
    avatar.hidden = false;
    fallback.hidden = true;
  } else if (signedIn) {
    avatar.hidden = true;
    avatar.removeAttribute('src');
    fallback.textContent = (profileEdit().name || s.name || s.email || '?').trim().charAt(0).toUpperCase();
    fallback.hidden = false;
  } else {
    avatar.hidden = true;
    avatar.removeAttribute('src');
    fallback.innerHTML = icon('user'); // generic glyph when signed out
    fallback.hidden = false;
  }
  const prof = profileEdit();
  $('profileName').textContent = signedIn ? (prof.name || s.name || s.email) : (isGuest() ? 'Guest' : 'Not signed in');
  $('profileEmail').textContent = signedIn && !prof.hideEmail && s.name ? s.email : '';
  $('profileVerified').hidden = !signedIn;
  // the card's background color is a profile edit (null = theme default)
  $('profileCard').style.background = prof.bg || '';

  $('statFavs').textContent = String(Object.keys(getFavs()).length);
  $('statWatched').textContent = String(Object.keys(getJSON()).length);
  $('statWatchTime').textContent = fmtWatchTotal(prefs().totalWatch || 0);

  // one sync line — the state and the explanation merged
  const detail = $('profileSyncDetail');
  if (!s || !s.configured) {
    detail.textContent = 'Cloud sync is off — sign in with Google to mirror your favorites, history and settings across your devices.';
  } else if (signedIn) {
    detail.textContent = s.syncing ? 'Syncing…'
      : s.lastError
      ? `Will retry — ${s.lastError}`
      : s.lastSync
      ? `Last synced ${fmtSyncWhen(s.lastSync)}`
      : 'Your data mirrors to your account whenever this device is online.';
  } else {
    detail.textContent = s.lastError
      ? `Last attempt failed — ${s.lastError}`
      : isGuest()
      ? 'You’re browsing as a guest — favorites, history and settings stay on this device. Sign in to mirror them across devices.'
      : 'Sign in to keep everything in sync across your devices.';
  }
  $('profileSignIn').hidden = !s || !s.configured || signedIn;
  $('editProfileBtn').hidden = !signedIn;
  $('profileSignOut').hidden = !signedIn;
  renderFavorites(); // the favorites list lives on this page — keep it current
  if (!$('paneWatch').hidden) renderWatching();
}

const defQualitySel = $('defQualitySel');
defQualitySel.value = String(prefs().quality || 'auto');
defQualitySel.addEventListener('change', () => {
  const p = prefs();
  p.quality = defQualitySel.value;
  setPrefs(p);
  toast(`Default quality: ${defQualitySel.value === 'auto' ? 'Auto' : defQualitySel.value + 'p'}`);
});

/* settings as segmented toggles — click a side and it commits immediately.
   The active side always mirrors the live pref: the returned sync function is
   re-run every time the settings page opens (prefs can arrive via cloud sync). */
const syncSettingsToggles = [];
function settingsToggle(id, get, onChange) {
  const box = $(id);
  const sync = () => box.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.value === get()));
  box.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.classList.contains('active')) return;
      onChange(b.dataset.value);
      sync();
    }));
  sync();
  syncSettingsToggles.push(sync);
}

settingsToggle('defTypeToggle', () => prefs().defaultType || 'sub', (v) => {
  const p = prefs();
  p.defaultType = v;
  p.lastType = v;
  setPrefs(p);
  state.type = v;
  syncSwapToggle(); // the detail + player toggles mirror the new default too
  toast(`Default audio: ${v.toUpperCase()}`);
});

// default stream server: a plain select like video quality, but also pushed
// through the settings re-sync so a cloud-synced pref shows on page open
const defServerSel = $('defServerSel');
const syncDefServer = () => {
  defServerSel.value = prefServer();
  if (defServerSel.selectedIndex < 0) defServerSel.value = ''; // unknown pref (synced from another device) — show Auto
};
defServerSel.addEventListener('change', () => {
  const p = prefs();
  p.defaultServer = defServerSel.value;
  setPrefs(p);
  toast(`Default server: ${defServerSel.value || 'Auto'}`);
});
syncDefServer();
syncSettingsToggles.push(syncDefServer);

settingsToggle('pushNotifToggle', () => (prefs().pushNotifs === false ? 'off' : 'on'), (v) => {
  const p = prefs();
  p.pushNotifs = v === 'on';
  setPrefs(p);
  toast(p.pushNotifs ? 'Favorite update alerts on' : 'Favorite update alerts off');
});

settingsToggle('themeToggle', () => (prefs().theme === 'light' ? 'light' : 'dark'), (v) => {
  const p = prefs();
  p.theme = v;
  setPrefs(p);
  applyTheme(v);
  toast(v === 'light' ? 'Light theme on' : 'Dark theme on');
});

/* keyboard */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ($('playerView').hidden) return;
  const video = $('video');
  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.code === 'ArrowRight') video.currentTime += 10;
  else if (e.code === 'ArrowLeft') video.currentTime -= 10;
  else if (e.code === 'KeyF') document.fullscreenElement ? document.exitFullscreen() : $('playerWrap').requestFullscreen();
});

/* ---- drag-to-scroll on card sliders (desktop mouse) ----
   One delegated pointer handler so every .slider — including ones built later
   (upcoming years, continue watching, related) — is draggable. Touch already
   pans natively, so this only arms on mouse pointers. */
(() => {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const DRAG_PX = 6; // movement before it counts as a drag, not a click
  let drag = null;   // { el, startX, startLeft, moved, pid }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const slider = e.target.closest?.('.slider');
    if (!slider || slider.scrollWidth <= slider.clientWidth) return;
    drag = { el: slider, startX: e.clientX, startLeft: slider.scrollLeft, moved: false, pid: e.pointerId };
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.el.classList.add('dragging');
      // scroll-snap would yank the row back while we drive scrollLeft
      drag.el.style.scrollSnapType = 'none';
      document.body.classList.add('dragging-slider');
    }
    drag.el.scrollLeft = drag.startLeft - dx;
  });

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.pid)) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('dragging');
    d.el.style.scrollSnapType = '';
    document.body.classList.remove('dragging-slider');
    // a drag must not land as a click on the card underneath
    if (d.moved) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      d.el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => d.el.removeEventListener('click', swallow, { capture: true }), 120);
    }
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
})();

/* ---------------- version + in-app updates ---------------- */

let bootVersion = null; // /api/version result — drives the "What's new" gate
async function loadVersion() {
  try {
    const { version, backupDir } = await api('/api/version');
    $('appVersion').textContent = `AniNinja v${version}`;
    $('sideVersion').textContent = `v${version}`;
    if (backupDir) {
      $('backupHint').textContent =
        `Settings, favorites and history are backed up to ${backupDir} — they survive updates and reinstalls.`;
    }
    if (version) {
      bootVersion = version;
      maybeShowWhatsNew();
    }
  } catch { /* cosmetic only */ }
}

/* update banner + settings row; state comes from GET /api/update, actions via POST */
let updateDismissed = false;
let updateState = 'idle';
let lastUpdate = null; // full status object (carries apkPath on Android)

function renderUpdateUI(u) {
  updateState = u.disabled ? 'idle' : u.state;
  // Play-distributed build: Google Play policy forbids in-app update flows, so
  // the server reports the updater disabled there — drop the whole section.
  // (disabled without Android = desktop dev build, which keeps the row.)
  // Android runs on the Play Store channel only — no APK self-update UI
  // (Play installers update via Play; the launch shell checks Play itself).
  const updatesGone = IS_ANDROID;
  $('updatesRow').hidden = updatesGone;
  $('updatesSep').hidden = updatesGone;
  const banner = $('updateBanner');
  const visible = !updateDismissed && ['available', 'downloading', 'ready'].includes(u.state);
  banner.hidden = !visible;
  // "Open folder" shows wherever an update file exists or is arriving —
  // desktop reveals the updater's pending dir, Android copies the APK into
  // public Downloads (dev builds never download anything)
  const showDir = ['downloading', 'ready'].includes(u.state) && !u.disabled && !u.external;
  $('openUpdateDirBtn').hidden = !showDir;
  $('openUpdateDirSettingsBtn').hidden = !showDir;
  if (visible) {
    const btn = $('updateAction');
    btn.hidden = false;
    if (u.state === 'available') {
      $('updateText').textContent = `AniNinja v${u.version} is available.`;
      // dev builds can't self-update — send the user to the releases page instead
      btn.textContent = u.external ? 'Open releases page' : 'Download update';
      btn.disabled = false;
    } else if (u.state === 'downloading') {
      $('updateText').innerHTML =
        `Downloading v${u.version || ''}… <div class="u-progress"><div style="width:${u.progress || 0}%"></div></div>`;
      btn.hidden = true;
    } else if (u.state === 'ready') {
      $('updateText').textContent = `AniNinja v${u.version} is ready to install.`;
      btn.textContent = IS_ANDROID ? 'Install update' : 'Restart to install';
      btn.disabled = false;
    }
  }
  // settings row mirrors the state — one button that walks
  // Check now → Download now → Install update
  const cbtn = $('checkUpdateBtn');
  cbtn.disabled = u.state === 'downloading';
  if (u.state === 'downloading') cbtn.textContent = `Downloading… ${u.progress || 0}%`;
  else if (u.state === 'ready') cbtn.textContent = IS_ANDROID ? 'Install update' : 'Restart to install';
  else if (u.state === 'available') cbtn.textContent = u.external ? 'Open releases page' : 'Download now';
  else cbtn.innerHTML = '<svg class="icon"><use href="#i-refresh"></use></svg> Check now';
  // status text
  const st = $('updateStatusText');
  if (u.error) st.textContent = `Update check failed — will retry`;
  else if (u.state === 'idle') st.textContent = u.disabled ? 'Up to date (dev — no self-update)' : 'Up to date';
  else if (u.state === 'available') st.textContent = u.external ? `v${u.version} available on GitHub` : `v${u.version} available`;
  else if (u.state === 'downloading') st.textContent = `Downloading… ${u.progress || 0}%`;
  else if (u.state === 'ready') st.textContent = IS_ANDROID
    ? `v${u.version} downloaded — tap to install`
    : `v${u.version} downloaded — restart to install`;
}

async function pollUpdate() {
  try {
    const u = await api('/api/update');
    lastUpdate = u;
    renderUpdateUI(u);
  } catch { /* server hiccup; next poll retries */ }
}

// dev build + newer release exists: self-update is impossible, open GitHub
function openReleasesPage() {
  window.open('https://github.com/RichardPersaud/AniBrowser/releases/latest', '_blank');
}

// Android only: hand the downloaded APK to the system installer via the shell
function installAndroidApk() {
  if (!lastUpdate || !lastUpdate.apkPath) return toast('Update file missing — re-download', true);
  window.location.href = `anibrowser-install://apk?path=${encodeURIComponent(lastUpdate.apkPath)}`;
}

// download/install via the server; the download POST only returns once the
// download itself is done, so show the progress bar first — that flips
// updateState, which starts the 1s poll streaming real progress in
async function runUpdate(action) {
  if (action === 'download') {
    renderUpdateUI({ ...(lastUpdate || {}), state: 'downloading', progress: 0 });
  }
  try {
    await api('/api/update', { action });
    pollUpdate(); // pick up the final state (ready / error)
  } catch (e) {
    toast('Update failed: ' + e.message, true);
    pollUpdate(); // pull the real state back in (failure reverts to available)
  }
}

$('updateAction').addEventListener('click', () => {
  if (lastUpdate && lastUpdate.external) return openReleasesPage();
  if (updateState === 'ready' && IS_ANDROID) return installAndroidApk();
  return runUpdate(updateState === 'ready' ? 'install' : 'download');
});
$('updateDismiss').addEventListener('click', () => {
  updateDismissed = true;
  renderUpdateUI({ ...(lastUpdate || {}), state: updateState });
});
$('checkUpdateBtn').addEventListener('click', () => {
  if (updateState === 'downloading') return; // progress streams in via the 1s poll
  if (updateState === 'ready' && IS_ANDROID) return installAndroidApk();
  if (updateState === 'ready') return runUpdate('install');
  if (lastUpdate && lastUpdate.external) return openReleasesPage();
  if (updateState === 'available') return runUpdate('download');
  // idle → fresh check
  $('updateStatusText').textContent = 'Checking…';
  api('/api/update', { action: 'check' })
    .then(() => pollUpdate())
    .catch((e) => {
      toast('Update check failed: ' + e.message, true);
      pollUpdate();
    });
});
// reveal the update files: desktop opens the updater's pending dir, Android
// copies the APK into public Downloads and opens the system Downloads list
// (two buttons — banner + settings row — share this handler)
['openUpdateDirBtn', 'openUpdateDirSettingsBtn'].forEach((id) => $(id).addEventListener('click', async () => {
  if (IS_ANDROID) {
    const path = lastUpdate && lastUpdate.apkPath;
    if (!path) return toast('No update downloaded yet', true);
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'openUpdatesDir', path }));
    return;
  }
  try {
    await api('/api/update', { action: 'openDir' });
  } catch (e) {
    toast('Could not open folder: ' + e.message, true);
  }
}));

/* ---- first-launch terms & conditions ----
   Nothing in the app is usable until these are accepted once; acceptance is
   persisted in prefs (and mirrored to the backup file), so it never asks again. */

// messages FROM the Expo shell (install failures etc.) — react-native-webview
// delivers them as window 'message' events with a JSON string payload
window.addEventListener('message', (ev) => {
  try {
    const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    if (msg && msg.type === 'installError') {
      toast('Install failed: ' + (msg.error || 'unknown error'), true);
    } else if (msg && msg.type === 'shellToast') {
      toast(String(msg.text || ''), !!msg.error);
    } else if (msg && msg.type === 'googleIdToken') {
      // the shell's answer to a native sign-in request; stale replies (an
      // older request that settled after a retry) are dropped — a newer
      // request owns the waiter now
      if (msg.seq && msg.seq !== googleSignInSeq) return;
      if (signInReplyWaiter) signInReplyWaiter(msg);
    } else if (msg && msg.type === 'addAccountReply') {
      // the shell's answer to an "open account setup" request; stale replies
      // dropped by seq, like googleIdToken above
      if (msg.seq && msg.seq !== googleAddSeq) return;
      if (addReplyWaiter) addReplyWaiter(msg);
    } else if (msg && msg.type === 'adReward') {
      // the shell's answer to a rewarded-ad request (watch-up overlay refill);
      // stale replies (an older request that settled after a retry) are
      // dropped BEFORE touching the button — a newer request owns it now
      if (msg.seq && msg.seq !== adRequestSeq) return;
      clearTimeout(adRequestTimer);
      const btn = $('watchAdBtn');
      btn.disabled = false;
      btn.textContent = 'Watch ad — +45 min';
      if (msg.ok) {
        resetWatchBudget();
        clearAdFail();
        toast('Ad reward — 45:00 of watch time back');
      } else if (!$('watchUpOverlay').hidden) {
        if (msg.error) {
          // a real load failure (no-fill / timeout / no inventory) — the raw
          // AdMob wording ("[googleMobileAds/no-fill] No fill.") becomes plain
          // speech, and repeated failures hand back grace time in small chunks
          const raw = String(msg.error);
          const fails = bumpAdFail();
          if (fails >= AD_FAIL_GRACE_EVERY) {
            clearAdFail();
            graceRefill(AD_GRACE_MIN * 60);
            toast('No ad available right now — ' + AD_GRACE_MIN + ' min of grace watch time added');
          } else {
            const left = AD_FAIL_GRACE_EVERY - fails;
            toast(/no.?fill/i.test(raw)
              ? 'No ad available right now — try again in a moment (' + left +
                ' more ' + (left === 1 ? 'try' : 'tries') + ' until grace time kicks in)'
              : "Ad didn't load — try again in a moment", true);
          }
        } else {
          // user closed the ad before the reward unlocked — their choice, so
          // it doesn't count toward the grace streak
          toast('Ad closed early — no reward', true);
        }
      }
    }
  } catch { /* non-JSON — ignore */ }
});

let tosDeclined = false;
$('tosAccept').addEventListener('click', () => {
  const p = prefs();
  p.tosAccepted = true;
  setPrefs(p);
  $('tosOverlay').hidden = true;
  toast('Welcome to AniNinja');
  maybeShowWhatsNew(); // a fresh update that still owed the T&C shows both, in order
});
$('tosDecline').addEventListener('click', () => {
  if (tosDeclined) return;
  tosDeclined = true;
  const m = el('p', 'hint', 'AniNinja can only be used after accepting these terms. Close the app, or come back and tap “I agree” when you are ready.');
  m.style.marginTop = '10px';
  m.style.textAlign = 'center';
  $('tosPanel').appendChild(m);
  $('tosDecline').disabled = true;
});
function showTosGate() {
  if (prefs().tosAccepted) return;
  $('tosOverlay').hidden = false;
}

/* ---- "What's new" welcome screen ----
   Shown ONCE per installed version — and only after an UPDATE: prefs()
   .lastWhatsNew only exists on devices that already ran some earlier version,
   so a first install (nothing to update from) never sees it. The version
   compared is /api/version, which on Android is the zip-stamped desktop
   version — so a sync-node.sh-only update (no new APK) still counts. */
const WHATS_NEW = {
  '1.2.6': {
    features: [
      'Native Google sign-in — pick your account right in the app, no browser tab',
      'No Google account on the device yet? The app opens account setup for you, then signs you in when you return',
      'Google "G" and guest icons on the sign-in buttons',
    ],
    fixes: [
      'Google sign-in failures now explain what actually went wrong instead of a bare "400"',
    ],
  },
};

function maybeShowWhatsNew() {
  if (!prefs().tosAccepted || !bootVersion) return; // T&C and version must land first
  // device-local (never synced): the welcome belongs to THIS device's update —
  // a synced prefs blob would mark the user's other devices as already-welcomed
  const seen = localStorage.getItem(WN_KEY);
  if (seen === bootVersion) return; // already welcomed for this version
  localStorage.setItem(WN_KEY, bootVersion);
  if (!seen) return; // fresh install — no previous version to update from
  // render: features + fixes for this version, falling back to a generic note
  const notes = WHATS_NEW[bootVersion];
  const list = $('wnList');
  list.textContent = '';
  const group = (heading, iconName, cls, items) => {
    if (!items || !items.length) return;
    const g = el('div', 'wn-group');
    g.appendChild(el('div', 'wn-heading', heading));
    for (const text of items) {
      const item = el('div', 'wn-item ' + cls);
      item.innerHTML = icon(iconName);
      item.appendChild(el('span', '', text));
      g.appendChild(item);
    }
    list.appendChild(g);
  };
  group('New', 'plus', '', notes?.features);
  group('Fixed', 'wrench', 'fix', notes?.fixes);
  if (!list.children.length) {
    list.appendChild(el('div', 'wn-item', 'This update brings stability and playback improvements.'));
  }
  $('wnVersion').textContent = `You've updated to v${bootVersion}`;
  $('whatsNewOverlay').hidden = false;
}

$('wnClose').addEventListener('click', () => {
  $('whatsNewOverlay').hidden = true;
});

/* ---- settings: download my data ---- */

$('exportBtn').addEventListener('click', async () => {
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    await saveBackup(); // flush the latest state into the backup first
    const { path } = await api('/api/export');
    toast(`Data saved to ${path}`);
  } catch (e) {
    toast('Export failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---- settings: legal pages (hosted on GitHub Pages) ----
   openExternal routes to a Custom Tab on Android and the OS browser on
   desktop — the WebView/Electron window itself must never navigate away */
$('privacyLinkBtn').addEventListener('click', () =>
  openExternal('https://richardpersaud.github.io/AniBrowser/privacy.html'));
$('termsLinkBtn').addEventListener('click', () =>
  openExternal('https://richardpersaud.github.io/AniBrowser/terms.html'));

/* ---- synopsis clamp toggle ---- */
$('synopsisToggle').addEventListener('click', () => {
  const clamped = $('detailSynopsis').classList.toggle('clamped');
  $('synopsisToggle').textContent = clamped ? 'View more' : 'View less';
});
// a resize changes how many lines the synopsis needs — re-decide the toggle
window.addEventListener('resize', () => {
  if (!$('detailView').hidden || detailMounted) syncSynopsisToggle();
});

/* ---------------- feedback board ---------------- */

// requires sign-in: votes and posts are attributed to the Google account
// (the login gate guarantees one), one vote per user per item, changeable.
let feedbackItems = null; // the raw list from the server
let feedbackSort = 'top';

function relDate(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function sortFeedback(items) {
  return items.slice().sort((a, b) => feedbackSort === 'top'
    ? (b.score - a.score) || (new Date(b.createdAt) - new Date(a.createdAt))
    : (new Date(b.createdAt) - new Date(a.createdAt)));
}

function renderFeedback() {
  const list = $('feedbackList');
  list.innerHTML = '';
  const items = sortFeedback(feedbackItems || []);
  $('feedbackEmpty').hidden = items.length > 0;
  document.querySelectorAll('#feedbackSort .sort-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === feedbackSort);
  });
  for (const item of items) {
    const card = el('div', 'fb-card');
    const votes = el('div', 'fb-votes');
    const up = el('button', 'fb-vote' + (item.myVote === 1 ? ' on-up' : ''));
    up.title = 'Upvote — you want this dealt with';
    up.innerHTML = '<svg class="icon"><use href="#i-chev-up"></use></svg>';
    up.addEventListener('click', () => voteFeedback(item, item.myVote === 1 ? 0 : 1));
    const score = el('div', 'fb-score', String(item.score));
    const down = el('button', 'fb-vote' + (item.myVote === -1 ? ' on-down' : ''));
    down.innerHTML = '<svg class="icon"><use href="#i-chev-down"></use></svg>';
    down.addEventListener('click', () => voteFeedback(item, item.myVote === -1 ? 0 : -1));
    votes.append(up, score, down);
    const content = el('div', 'fb-content');
    content.appendChild(el('div', 'fb-title', item.title));
    content.appendChild(el('div', 'fb-body', item.body));
    const meta = el('div', 'fb-meta',
      `${item.author}${item.mine ? ' (you)' : ''} · ${relDate(item.createdAt)}`);
    content.appendChild(meta);
    // authors can remove their own post; the first click arms the button so a
    // stray tap can't take the post down
    if (item.mine) {
      const del = el('button', 'fb-del', 'Delete');
      del.title = 'Remove your feedback post';
      del.addEventListener('click', () => {
        if (del.textContent !== 'Delete') return removeFeedback(item);
        del.textContent = 'Confirm?';
        del.classList.add('armed');
        setTimeout(() => {
          if (del.isConnected && del.textContent === 'Confirm?') {
            del.textContent = 'Delete';
            del.classList.remove('armed');
          }
        }, 3000);
      });
      meta.appendChild(del);
    }
    card.append(votes, content);
    list.appendChild(card);
  }
}

async function loadFeedback() {
  // feedback posts/votes are attributed to the Google account server-side —
  // guests have no token, so every call would 401. Guard instead of erroring.
  if (isGuest()) {
    $('feedbackList').innerHTML = '';
    $('feedbackComposer').hidden = true;
    $('newFeedbackBtn').hidden = true;
    $('feedbackEmpty').hidden = false;
    $('feedbackEmpty').textContent = 'Sign in with Google to browse and post feedback.';
    return;
  }
  const list = $('feedbackList');
  renderSkeletonFeedback(list, 3);
  try {
    const { items } = await api('/api/feedback');
    feedbackItems = items;
    $('feedbackComposer').hidden = true;
    renderFeedback();
  } catch (e) {
    list.innerHTML = ''; // don't leave placeholders up
    $('feedbackEmpty').hidden = true;
    list.appendChild(el('p', 'hint', 'Could not load feedback: ' + e.message));
  }
}

// optimistic flip, then re-fetch — the server is the source of truth on score
async function removeFeedback(item) {
  try {
    await api('/api/feedback/delete', { id: item.id });
    feedbackItems = (feedbackItems || []).filter((x) => x.id !== item.id);
    renderFeedback();
    toast('Feedback deleted');
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

async function voteFeedback(item, value) {
  const prev = item.myVote;
  try {
    await api('/api/feedback/vote', { id: item.id, value });
    item.myVote = value;
    item.score += value - prev;
    renderFeedback();
    loadFeedback(); // silent refresh — the row's true score replaces the guess
  } catch (e) {
    toast('Vote failed: ' + e.message, true);
  }
}

$('newFeedbackBtn').addEventListener('click', () => {
  const f = $('feedbackComposer');
  f.hidden = false;
  $('feedbackTitle').value = '';
  $('feedbackBody').value = '';
  $('feedbackTitle').focus();
});
$('feedbackCancelBtn').addEventListener('click', () => { $('feedbackComposer').hidden = true; });
$('feedbackComposer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('feedbackTitle').value.trim();
  const body = $('feedbackBody').value.trim();
  if (!title || !body) { toast('Add a title and a description first', true); return; }
  const btn = $('feedbackSubmitBtn');
  btn.disabled = true;
  try {
    const { item } = await api('/api/feedback', { title, body });
    if (feedbackItems) feedbackItems.unshift(item);
    $('feedbackComposer').hidden = true;
    renderFeedback();
    toast('Feedback posted');
  } catch (err) {
    toast('Could not post: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});
document.querySelectorAll('#feedbackSort .sort-btn').forEach((b) => {
  b.addEventListener('click', () => { feedbackSort = b.dataset.sort; renderFeedback(); });
});

/* ---------------- init ---------------- */

/* ---------------- custom dropdown menus ---------------- */

// Android's native <select> menus render as a system dialog — own dark theme,
// radio glyphs, mismatched typography — nothing like the rest of the app.
// Every select is upgraded: the real control stays in the DOM (hidden, kept in
// sync) so the change handlers and dynamic option rebuilds keep working, and
// a themed trigger button opens a themed popup instead. All colors flow from
// the tokens, so dark/light both follow.
function makeDropdown(sel) {
  const trig = el('button', 'dd-trigger');
  trig.type = 'button';
  trig.appendChild(el('span', 'dd-label'));
  trig.insertAdjacentHTML('beforeend', icon('chev-down'));
  const pop = el('div', 'dd-pop');
  const labelText = () => {
    const o = sel.selectedOptions[0];
    return o ? o.textContent : '';
  };
  const close = () => {
    pop.remove();
    document.removeEventListener('click', outside, true);
    document.removeEventListener('scroll', scrollAway, true);
    window.removeEventListener('resize', close);
  };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  const scrollAway = (e) => { if (!pop.contains(e.target)) close(); }; // capture: also inner scroll containers
  const open = () => {
    // rebuild from the live option list — browse filters / player selects
    // repopulate their selects at any time
    pop.innerHTML = '';
    for (const o of sel.options) {
      const it = el('button', 'dd-item' + (o.selected ? ' sel' : ''));
      it.type = 'button';
      it.appendChild(el('span', null, o.textContent));
      it.insertAdjacentHTML('beforeend', icon('check'));
      it.addEventListener('click', () => {
        close();
        if (o.selected) return;
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
      });
      pop.appendChild(it);
    }
    document.body.appendChild(pop);
    // anchor off the trigger, clamped inside the viewport (flip up at the
    // screen edge, shift sideways when the trigger sits too far right)
    const r = trig.getBoundingClientRect();
    pop.style.left = pop.style.right = pop.style.top = '';
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.minWidth = `${Math.round(r.width)}px`;
    if (r.bottom + pop.offsetHeight + 8 > innerHeight) {
      pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
    }
    if (r.left + pop.offsetWidth + 8 > innerWidth) {
      pop.style.left = `${Math.max(8, Math.round(innerWidth - pop.offsetWidth - 8))}px`;
    } else {
      pop.style.left = `${Math.round(r.left)}px`;
    }
    document.addEventListener('click', outside, true);
    document.addEventListener('scroll', scrollAway, true);
    window.addEventListener('resize', close);
    // long lists (genres) should present the current choice, not always the top
    const s = pop.querySelector('.dd-item.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  };
  trig.addEventListener('click', () => (pop.isConnected ? close() : open()));
  const sync = () => {
    trig.querySelector('.dd-label').textContent = labelText();
    trig.hidden = sel.hidden;
  };
  // options and `hidden` flip from anywhere (player dropdown rebuilds on every
  // resolve) — watch the select instead of hoping for change events
  new MutationObserver(sync).observe(sel, { childList: true, attributes: true });
  sel.addEventListener('change', sync);
  // .value is also assigned bare (genre-chip navigation, filter resets) with
  // no change event — interpose the setter so the trigger text follows along
  const valDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', {
    get() { return valDesc.get.call(sel); },
    set(v) { valDesc.set.call(sel, v); sync(); },
  });
  sync();
  sel.style.display = 'none'; // keep it: value + change events stay authoritative
  sel.insertAdjacentElement('afterend', trig);
}
document.querySelectorAll('select').forEach(makeDropdown);

let splashGone = false;
function hideSplash() {
  if (splashGone) return;
  splashGone = true;
  const s = $('bootSplash');
  s.classList.add('gone');
  // tell the RN shell its cover (logo + wheel) can drop now — the shell keeps
  // it up until this message so the app doesn't appear to boot twice
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'bootDone' }));
  } catch {}
  // remove the element entirely: `hidden` can't override #bootSplash's ID-level
  // display:flex, and on Android's WebView the leftover full-screen layer froze
  // mid-fade as a permanent dim veil that blocked repaints until a scroll
  setTimeout(() => s.remove(), 400);
}

(async () => {
  // failsafe: never trap the user behind the splash
  setTimeout(hideSplash, 15000);
  // first-paint the login gate when last boot ended signed out (or we don't
  // know better): the gate used to open one auth-status poll later and the
  // homepage could flash through the frame between hideSplash() and that poll.
  // Signed-in boots stored '0' (set by renderSyncUI) and skip straight to home.
  // Offline skips it too: a gate can't be answered without the network.
  let seenSignedIn = null;
  try { seenSignedIn = localStorage.getItem(GATE_SEEN_SIGNED_IN); } catch { /* private mode */ }
  if (seenSignedIn !== '0' && !appOffline) {
    $('loginGate').hidden = false;
    lastGateChrome = true;
    try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'gate', up: true })); } catch {}
  }
  await restoreFromBackup(); // must run before anything reads prefs/favorites
  applyTheme(); // theme is a pref too — flip the shell + tokens before paint
  showTosGate(); // first launch only — overlays the boot splash until accepted
  applySidebar();
  initBrowseUI();
  buildLoginCollage(); // gate backdrop posters (shown/hidden by pollSync)
  renderNotifPanel(); // restore badge/panel state saved before the last close
  // offline boot: no welcome/sign-in page — the network is down, so the app
  // lands straight on the profile (the only page that renders offline) as an
  // implicit guest session; every home load below would just fail anyway
  if (appOffline) {
    try {
      const cached = JSON.parse(localStorage.getItem(LAST_SYNC_KEY));
      if (!(cached && cached.signedIn)) setGuest(true);
    } catch { setGuest(true); }
    renderProfile(); // fills from the last known status + card lists
    showView('profileView');
    offlineNotice();
    hideSplash();
  } else {
    renderContinue();
    await loadRecent(); // home is ready once the recently-updated grid lands
    loadHero(); // hero spotlight carousel (best-effort, server-cached 30 min)
    loadUpcoming(); // marquee + Coming soon grid (best-effort, cached 30 min)
    hideSplash();
  }
  loadVersion();
  document.querySelector('.side-item[data-nav="home"]').classList.add('active');
  checkFavEpisodes(); // and every 10 minutes afterwards
  setInterval(checkFavEpisodes, 10 * 60 * 1000);
  pollUpdate(); // in-app update banner; the main process checks for releases itself
  setInterval(pollUpdate, 30 * 1000);
  pollSync(); // cloud sync status row (same slow cadence as the update poll)
  setInterval(pollSync, 30 * 1000);
  // 1s polling while a download runs so the progress bar actually moves
  setInterval(() => { if (updateState === 'downloading') pollUpdate(); }, 1000);
})();