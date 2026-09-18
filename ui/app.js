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
};

const PROGRESS_KEY = 'anibrowser_progress';
const PREFS_KEY = 'anibrowser_prefs';
const FAVS_KEY = 'anibrowser_favorites';

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
function setPrefs(p) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  scheduleBackup();
}
// 18+ shows carry an r18 flag from the source's card markup; the settings
// toggle (default: hide) filters them out of Home, Search and Browse
function r18Visible(r) {
  return !!prefs().showR18 || !r.r18;
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
    favorites: getFavs(),
    progress: getJSON(),
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

async function restoreFromBackup() {
  try {
    const { data } = await api('/api/backup');
    if (data) {
      // settings: the file is the durable copy, so it fills in / overrides defaults
      setPrefsSilent({ ...prefs(), ...(data.prefs || {}) });
      // favorites & history: union of both sides
      setFavsSilent({ ...(data.favorites || {}), ...getFavs() });
      setJSONSilent({ ...(data.progress || {}), ...getJSON() });
      updateFavCount();
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
    forgetFavTracking(r.slug); // drop its notification state
    toast('Removed from favorites');
  } else {
    f[r.slug] = { title: r.title, poster: r.poster, ts: Date.now() };
    baselineFavCount(r.slug); // remember current episode count so only *new* releases notify
    toast('Added to favorites ♥');
  }
  setFavs(f);
  updateFavCount();
  return !!f[r.slug];
}

function updateFavCount() {
  const n = Object.keys(getFavs()).length;
  const badge = $('favCount');
  badge.textContent = String(n);
  badge.hidden = n === 0;
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
    // in the favorites view the un-favorited card drops out of the grid
    if (!on && state.view === 'favView') renderFavorites();
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
  updateFavCount();
}

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

// drop notification state when a show is un-favorited
function forgetFavTracking(slug) {
  const p = prefs();
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
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function showView(name) {
  for (const v of ['homeView', 'browseView', 'favView', 'detailView', 'playerView', 'collectionView']) {
    $(v).hidden = v !== name;
  }
  const navKey = name === 'favView' ? 'favorites'
    : name === 'browseView' ? 'browse'
    : name === 'homeView' ? 'home' : null;
  document.querySelectorAll('.side-item').forEach((b) =>
    b.classList.toggle('active', !!navKey && b.dataset.nav === navKey)
  );
  state.view = name;
  $('main').scrollTop = 0;
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
  if (v === 'browseView') showView('browseView');
  else if (v === 'favView') { renderFavorites(); showView('favView'); }
  else if (v === 'detailView') showView('detailView');
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
    if (r.poster) img.src = r.poster;
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

// clickable page list with ellipsis, e.g. 1 … 4 5 [6] 7 8 … 340
// (phones get a ±1 window so the row always fits without wrapping)
function pageList(page, total) {
  const span = IS_MOBILE ? 1 : 2;
  const win = [];
  for (let p = Math.max(1, page - span); p <= Math.min(total, page + span); p++) win.push(p);
  const set = [...new Set([1, ...win, total])].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of set) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

function renderBrowsePages(page, total) {
  const box = $('browsePages');
  box.innerHTML = '';
  if (total <= 1) return;
  for (const p of pageList(page, total)) {
    if (p === '…') {
      box.appendChild(el('span', 'page-gap', '…'));
    } else {
      const b = el('button', 'page-btn', String(p));
      b.classList.toggle('active', p === page);
      box.appendChild(b);
    }
  }
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

// rating filter: R+ / Rx only exist while 18+ content is allowed to show —
// under "Hide" those listings would be filtered out anyway (empty results)
function ratingOptions() {
  const base = [['g', 'G'], ['pg', 'PG'], ['pg_13', 'PG-13'], ['r_17', 'R']];
  if (prefs().showR18) base.push(['r_plus', 'R+'], ['rx', 'Rx']);
  return base;
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

const browse = { mode: 'letter', letter: 'all', page: 1, totalPages: 1, seq: 0 };
const bfSelects = ['Type', 'Status', 'Genre', 'Rating', 'Score', 'Season', 'Language', 'Sort'];
// select suffix -> query param (the site's filter form uses singular `genre`;
// `genres` used to work but is ignored by the backend today)
const bfParams = {
  Type: 'type', Status: 'status', Genre: 'genre', Rating: 'rating',
  Score: 'score', Season: 'season', Language: 'language', Sort: 'sort',
};

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
    browse.page = 1;
    bar.querySelectorAll('.alpha-btn').forEach((x) => x.classList.toggle('active', x === b));
    for (const f of bfSelects) $('bf' + f).value = '';
    loadBrowse();
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
      browse.page = 1;
      $('alphaBar').querySelectorAll('.alpha-btn').forEach((x) => x.classList.remove('active'));
      loadBrowse();
    });
  }

  $('bfReset').addEventListener('click', () => {
    browse.mode = 'letter';
    browse.letter = 'all';
    browse.page = 1;
    $('alphaBar').querySelectorAll('.alpha-btn').forEach((x) =>
      x.classList.toggle('active', x.dataset.letter === 'all'));
    for (const f of bfSelects) $('bf' + f).value = '';
    loadBrowse();
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

  const browseTop = () => { $('main').scrollTop = 0; }; // new page starts at the top of the content
  $('browsePrev').addEventListener('click', () => {
    if (browse.page > 1) { browse.page -= 1; loadBrowse(); browseTop(); }
  });
  $('browseNext').addEventListener('click', () => {
    if (browse.page < browse.totalPages) { browse.page += 1; loadBrowse(); browseTop(); }
  });
  $('browsePages').addEventListener('click', (e) => {
    const b = e.target.closest('.page-btn');
    if (!b || Number(b.textContent) === browse.page) return;
    browse.page = Number(b.textContent);
    loadBrowse();
    browseTop();
  });
}

async function loadBrowse() {
  // seq-based staleness: never drop a new request, only stale *responses*
  const seq = ++browse.seq;
  $('browseLoading').hidden = true;
  renderSkeletonCards($('browseGrid'), 12);
  const q = new URLSearchParams();
  if (browse.mode === 'letter') q.set('letter', browse.letter);
  else {
    for (const f of bfSelects) {
      const v = $('bf' + f).value;
      if (v) q.set(bfParams[f], v);
    }
  }
  q.set('page', String(browse.page));
  try {
    const { results, totalPages, page } = await api('/api/browse?' + q.toString());
    if (seq !== browse.seq || state.view !== 'browseView') return; // superseded / user moved on
    browse.page = page;
    browse.totalPages = totalPages;
    const grid = $('browseGrid');
    grid.innerHTML = ''; // drop the skeleton placeholders
    const shown = results.filter(r18Visible);
    if (!shown.length) renderGridEmpty(grid, 'Nothing to show here');
    else for (const r of shown) grid.appendChild(makeCard(r));
    $('browsePageLabel').textContent = totalPages > 1
      ? `Page ${page} of ${totalPages}`
      : 'Page 1';
    $('browsePrev').disabled = page <= 1;
    $('browseNext').disabled = page >= totalPages;
    renderBrowsePages(page, totalPages);
  } catch (e) {
    if (seq === browse.seq) {
      $('browseGrid').innerHTML = ''; // don't leave skeletons up
      toast('Browse failed: ' + e.message, true);
    }
  } finally {
    if (seq === browse.seq) $('browseLoading').hidden = true;
  }
}

// jump from a detail page's genre chips into Browse pre-filtered to that genre
function browseByGenre(slug) {
  if (!slug || !GENRES.includes(slug)) return; // unknown slug — leave Browse alone
  showView('browseView');
  browse.mode = 'filters';
  browse.page = 1;
  $('alphaBar').querySelectorAll('.alpha-btn').forEach((x) => x.classList.remove('active'));
  for (const f of bfSelects) $('bf' + f).value = '';
  $('bfGenre').value = slug;
  loadBrowse();
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
  state.query = '';
  state.page = 1;
  $('resultsSection').hidden = true;
  $('loadingState').hidden = true;
  showView('homeView');
  renderContinue();
  loadRecent();
  renderUpcoming();
}

/* --- in-window mini player while browsing --- */

function videoActive() {
  const v = $('video');
  return !!(state.hls || v.currentSrc) && v.readyState > 0;
}

// move the live <video> element back into the full player (playback survives
// reparenting; only removing it from the document entirely would reset it)
function restoreVideoToPlayer() {
  $('videoArea').appendChild($('video'));
  $('miniPlayer').hidden = true;
}

// the shell injects this right before the app is backgrounded — the system
// picture-in-picture window mirrors the activity surface, so restore the full
// player with all chrome stripped (body.pip-full) to make PiP video-only
window.__pipRestore = function () {
  const v = $('video');
  if (state.view !== 'playerView' && videoActive()) {
    restoreVideoToPlayer();
    showView('playerView');
    document.body.classList.add('pip-full');
  }
  if (v && !v.paused) v.play().catch(() => {}); // re-kick playback if needed
};

function minimizeToMini() {
  if (!videoActive()) return false;
  $('miniTitle').textContent = `${state.title} — EP ${state.epNum} (${state.type.toUpperCase()})`;
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

async function sidebarNav(target) {
  // the drawer always closes on nav — the user picked a destination, the menu's
  // job is done (on phones it would otherwise cover the content they navigated to)
  sidebarOpen = false;
  applySidebar();
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
    : target === 'browse' ? 'browseView' : 'favView';
  const fromView = state.view; // capture now — state.view moves on
  if (fromView !== targetView) pushHist(() => restoreView(fromView));
  if (target === 'home') navHome();
  else if (target === 'browse') {
    showView('browseView');
    loadBrowse();
  } else {
    renderFavorites();
    showView('favView');
  }
}

document.querySelectorAll('.side-item').forEach((b) => {
  b.addEventListener('click', () => {
    // buttons like the drawer's ✕ carry .side-item styling but no nav target —
    // they must not fall through to the favorites branch
    if (!b.dataset.nav) return;
    sidebarNav(b.dataset.nav); // sidebarNav closes the drawer
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

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  // revealing results over the home sections is a forward hop — back undoes it
  if ($('resultsSection').hidden) pushHist(() => restoreView('homeView'));
  state.query = q;
  state.page = 1;
  $('resultsGrid').innerHTML = '';
  $('resultsTitle').textContent = `Results for “${q}”`;
  showView('homeView');
  loadResults();
});

$('moreBtn').addEventListener('click', () => {
  state.page += 1;
  loadResults(true);
});

async function loadResults(append) {
  $('loadingState').hidden = true;
  $('resultsSection').hidden = false;
  $('recentSection').hidden = true; // search results take over the home view
  $('continueSection').hidden = true; // ...and so do the continue-watching cards
  $('emptyState').hidden = true;
  $('moreBtn').hidden = true;
  if (!append) renderSkeletonCards($('resultsGrid'), 12);
  try {
    const { results } = await api(
      `/api/search?q=${encodeURIComponent(state.query)}&page=${state.page}`
    );
    if (!append) $('resultsGrid').innerHTML = '';
    const shown = results.filter(r18Visible);
    for (const r of shown) $('resultsGrid').appendChild(makeCard(r));
    $('moreBtn').hidden = results.length === 0;
    if (!append && !shown.length) {
      $('resultsTitle').textContent = 'No results found';
      renderGridEmpty($('resultsGrid'), 'No results found');
    }
  } catch (e) {
    if (!append) $('resultsGrid').innerHTML = ''; // don't leave skeletons up
    toast('Search failed: ' + e.message, true);
  } finally {
    $('loadingState').hidden = true;
  }
}

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

function makeCard(r) {
  const card = el('div', 'card');
  card.title = r.title; // native tooltip shows the full name over the clamped title
  const media = el('div', 'card-media'); // anchors the date badge to the art, not the title
  const img = el('img');
  if (r.poster) {
    img.src = r.poster;
    img.onerror = () => { img.src = `/stream?u=${btoaUrl(r.poster)}`; img.onerror = null; };
  }
  img.loading = 'lazy';
  media.appendChild(img);
  card.appendChild(media);
  card.appendChild(el('div', 'card-title', r.title));
  card.addEventListener('click', () => openDetail(r.slug, r.title, r.poster));
  attachFavBtn(card, r);
  return card;
}

/* ---------------- recently updated ---------------- */

async function loadRecent() {
  const section = $('recentSection');
  section.hidden = false;
  $('recentLoading').hidden = true;
  renderSkeletonCards($('recentGrid'), 12);
  try {
    const { results } = await api('/api/recent');
    if (state.view !== 'homeView' || !$('resultsSection').hidden) return; // user moved on
    $('recentLoading').hidden = true;
    const grid = $('recentGrid');
    grid.innerHTML = '';
    const shown = results.filter(r18Visible).slice(0, 30);
    if (!shown.length) renderGridEmpty(grid, 'Nothing to show right now');
    else for (const r of shown) grid.appendChild(makeCard(r));
    state.recentLoaded = true;
  } catch {
    section.hidden = true; // best-effort: hide rather than break the home view
  }
}

/* ---------------- upcoming (Coming soon) ---------------- */

let upcomingData = null; // cached /api/upcoming results

async function loadUpcoming() {
  try {
    const { results } = await api('/api/upcoming');
    upcomingData = results;
    renderUpcoming();
  } catch { /* best-effort: the sections simply stay hidden */ }
}

// re-render both the marquee and the Coming soon grid (also called when the
// 18+ setting changes)
function renderUpcoming() {
  renderUpcomingMarquee();
  renderUpcomingSection();
}

function renderUpcomingSection() {
  const section = $('upcomingSection');
  const items = (upcomingData || []).filter(r18Visible);
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
  section.hidden = false;
}

// top strip on Home: the same shows auto-scrolling; the sequence is built
// twice so the CSS translateX(-50%) loop is seamless. Favoriting one of these
// notifies on release day via the regular favorites checker.
function renderUpcomingMarquee() {
  const wrap = $('upMarquee');
  const track = $('upTrack');
  const items = (upcomingData || []).filter(r18Visible).slice(0, 14);
  if (!items.length) { wrap.hidden = true; return; }
  track.innerHTML = '';
  const build = () => {
    for (const r of items) {
      const b = el('button', 'up-item');
      const img = el('img');
      if (r.poster) {
        img.src = r.poster;
        img.onerror = () => { img.src = `/stream?u=${btoaUrl(r.poster)}`; img.onerror = null; };
      }
      img.loading = 'lazy';
      img.alt = '';
      b.appendChild(img);
      const meta = el('span', 'up-meta');
      meta.appendChild(el('span', 'up-name', r.title));
      meta.appendChild(el('span', 'up-date', r.date || 'Coming soon'));
      b.appendChild(meta);
      b.title = r.title;
      b.addEventListener('click', () => openDetail(r.slug, r.title, r.poster));
      track.appendChild(b);
    }
  };
  build();
  build();
  wrap.hidden = false;
}

function btoaUrl(s) {
  return encodeURIComponent(btoa(unescape(encodeURIComponent(s))));
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
    const img = el('img');
    if (it.poster) img.src = it.poster;
    img.loading = 'lazy';
    card.appendChild(img);
    card.appendChild(el('div', 'card-title', it.title));
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
        startPlayback(it.epNum, prefs().lastType || 'sub');
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
      setJSON(all); // also schedules a backup write
      toast(`Removed "${it.title}" from history`);
      renderContinue();
    });
    card.appendChild(rm);
    grid.appendChild(card);
  }
}

$('clearHistoryBtn').addEventListener('click', () => {
  if (!confirm('Remove every show from your watch history?')) return;
  setJSON({});
  toast('Watch history cleared');
  renderContinue();
});

/* ---------------- detail ---------------- */

function renderDetailInfo(d) {
  if (!d) {
    // loading state: skeleton lines where the info will land
    $('detailInfo').hidden = false;
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

  // chips: type · duration · rating · mal score · sub/dub counts
  const chips = $('detailChips');
  chips.hidden = false;
  $('detailMetaRows').hidden = false;
  chips.innerHTML = '';
  const chipVals = [
    d.type, d.duration, d.pgRating,
    d.malScore ? `MAL ${d.malScore}` : null,
    d.aired ? `Aired ${d.aired}` : null,
    d.subCount ? `SUB ${d.subCount}` : null,
    d.dubCount ? `DUB ${d.dubCount}` : null,
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
  $('detailInfo').hidden = !chipVals.length && !d.synopsis;

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

async function loadDetailInfo() {
  const slug = state.slug;
  try {
    const d = await api(`/api/detail?slug=${encodeURIComponent(slug)}`);
    if (state.slug === slug) {
      renderDetailInfo(d);
      renderRelated(d);
      renderRecommendations(d);
    }
  } catch { /* details are best-effort */ }
}

/* ---- seasons & movies (the source's "Related Anime" block) ---- */

function renderRelated(d) {
  const section = $('relSection');
  const items = (d.related || [])
    .filter((r) => r.slug !== state.slug)
    .filter(r18Visible);
  state.related = items;
  if (!items.length) { section.hidden = true; return; }
  // horizontal slider — every related entry fits without a "view all" hop
  const slider = $('relSlider');
  slider.innerHTML = '';
  for (const r of items) slider.appendChild(makeCard(r));
  section.hidden = false;
}

/* ---- collection pages ----
   One generic grid page for two kinds of listing: a studio / producer path
   (paginated, served by /api/collection) or a static list (a show's full
   seasons & movies from the "View all" button). */

const collection = { seq: 0, path: null, page: 1, totalPages: 1, title: '' };

async function openCollection(opts) {
  const fromView = state.view; // capture before the view changes
  pushHist(() => restoreView(fromView)); // trail: back returns to where we came from
  collection.seq++;
  if (opts.kind === 'list') {
    collection.path = null;
    $('collectionTitle').textContent = opts.title;
    const grid = $('collectionGrid');
    grid.innerHTML = '';
    const items = opts.items.filter(r18Visible);
    if (!items.length) renderGridEmpty(grid, 'Nothing to show here');
    else for (const r of items) grid.appendChild(makeCard(r));
    $('collectionPager').hidden = true;
    showView('collectionView');
  } else {
    collection.path = opts.path;
    collection.title = opts.title;
    collection.page = 1;
    showView('collectionView');
    await loadCollection();
  }
}

async function loadCollection() {
  const seq = ++collection.seq;
  renderSkeletonCards($('collectionGrid'), 12);
  try {
    const { results, totalPages, page } = await api(
      `/api/collection?path=${encodeURIComponent(collection.path)}&page=${collection.page}`
    );
    if (seq !== collection.seq) return;
    collection.page = page;
    collection.totalPages = totalPages;
    const grid = $('collectionGrid');
    grid.innerHTML = '';
    const shown = results.filter(r18Visible);
    if (!shown.length) renderGridEmpty(grid, 'Nothing to show here');
    else for (const r of shown) grid.appendChild(makeCard(r));
    $('collectionTitle').textContent = `${collection.title} anime`;
    $('colPageLabel').textContent = totalPages > 1 ? `Page ${page} of ${totalPages}` : '';
    $('colPrev').disabled = page <= 1;
    $('colNext').disabled = page >= totalPages;
    $('collectionPager').hidden = totalPages <= 1;
  } catch (e) {
    if (seq === collection.seq) toast('Could not load this page: ' + e.message, true);
  }
}

$('colPrev').addEventListener('click', () => {
  if (collection.page > 1) { collection.page -= 1; loadCollection(); }
});
$('colNext').addEventListener('click', () => {
  if (collection.page < collection.totalPages) { collection.page += 1; loadCollection(); }
});

/* ---- recommendations ----
   Six picks always on screen, driven by a genre profile: the current show's
   genres plus (weighted 2×) the genres of the user's favorites. Anything
   already favorited never shows up. Legacy favorite records carry no genres —
   the most recent few are backfilled from /api/detail (server-cached). */
let recSeq = 0;
async function renderRecommendations(d) {
  const seq = ++recSeq;
  const section = $('recSection');
  section.hidden = true;
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
  if (seq !== recSeq || state.view !== 'detailView') return;

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
      if (seq !== recSeq || state.view !== 'detailView') return; // user moved on
      take(results);
    } catch { /* best-effort */ }
  }
  if (seq !== recSeq || state.view !== 'detailView' || !picked.length) return;
  const grid = $('recGrid');
  grid.innerHTML = '';
  for (const r of picked) grid.appendChild(makeCard(r));
  section.hidden = false;
}

function updateDetailFav() {
  const on = state.slug && isFav(state.slug);
  $('favBtn').textContent = on ? '♥ Favorited' : '♡ Favorite';
  $('favBtn').classList.toggle('active', !!on);
}

$('favBtn').addEventListener('click', () => {
  toggleFav({ slug: state.slug, title: state.title, poster: state.poster });
  updateDetailFav();
  if (!$('favView').hidden) renderFavorites();
});

async function openDetail(slug, title, poster, onReady) {
  // trail: hopping to a show from anywhere (or from another detail page via
  // recommendations) is a forward hop — back returns to what was on screen
  const from = { view: state.view, slug: state.slug, title: state.title, poster: state.poster };
  if (from.view === 'detailView' && from.slug && from.slug !== slug) {
    pushHist(() => openDetail(from.slug, from.title, from.poster));
  } else if (from.view !== 'detailView') {
    pushHist(() => restoreView(from.view));
  }
  state.slug = slug;
  state.title = title;
  state.poster = poster;
  state.epNum = null;
  state.type = prefs().defaultType || prefs().lastType || 'sub';
  for (const b of document.querySelectorAll('#typeToggle button')) {
    b.classList.toggle('active', b.dataset.type === state.type);
  }
  $('detailTitle').textContent = title;
  $('detailTitle').title = title; // desktop hover shows a long clamped title in full
  $('detailPoster').src = poster || '';
  // hero backdrop: same art, blurred behind the header (CSS reads --detail-bg)
  $('detailHero').style.setProperty(
    '--detail-bg',
    poster ? `url("${poster.replace(/"/g, '%22')}")` : 'none'
  );
  updateDetailFav();
  renderDetailInfo(null); // hide stale info while loading
  $('recSection').hidden = true; // ...and stale recommendations
  $('relSection').hidden = true; // ...and stale seasons & movies
  loadDetailInfo();
  $('epCount').textContent = '';
  // the back trail (pushHist above) now owns the "Back" button's destination
  showView('detailView');
  $('epLoading').hidden = true;
  renderSkeletonEps($('epGrid'), 12);
  try {
    const { episodes } = await api(`/api/episodes?slug=${encodeURIComponent(slug)}`);
    state.episodes = episodes;
    $('epCount').textContent = `${episodes.length} episodes`;
    renderEpisodes();
    if (onReady) onReady();
  } catch (e) {
    $('epGrid').innerHTML = ''; // don't leave skeletons up
    toast('Could not load episodes: ' + e.message, true);
  } finally {
    $('epLoading').hidden = true;
  }
}

document.querySelectorAll('#typeToggle button').forEach((b) => {
  b.addEventListener('click', () => {
    state.type = b.dataset.type;
    document.querySelectorAll('#typeToggle button').forEach((x) =>
      x.classList.toggle('active', x === b)
    );
    const p = prefs(); p.lastType = state.type; setPrefs(p);
    renderEpisodes();
  });
});

function renderEpisodes() {
  const grid = $('epGrid');
  grid.innerHTML = '';
  const prog = getJSON()[state.slug] || {};
  const watched = prog.watched || [];
  for (const ep of state.episodes) {
    const btn = el('button', 'ep-btn', ep.num);
    if (ep.num === String(state.epNum)) btn.classList.add('current');
    // the check is independent of "current" — the episode you just played is
    // both, and hiding its check made it look unwatched
    if (watched.includes(String(ep.num))) {
      btn.classList.add('watched');
      btn.textContent = `✓ ${ep.num}`;
    }
    if (ep.dead) {
      // every embed for this episode was dead — warn before the click, not after
      btn.classList.add('dead');
      btn.title = 'This episode is unavailable at the source (all embeds dead). Click to retry anyway.';
    }
    btn.addEventListener('click', () => startPlayback(ep.num, state.type));
    grid.appendChild(btn);
  }
}

// every back button (detail, player, collection) unwinds the same trail the
// Android hardware back walks
document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => goBack());
});

/* ---------------- player ---------------- */

function stopPlayback() {
  restoreVideoToPlayer();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  clearInterval(state.progressTimer);
  clearInterval(state.introTimer);
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
async function startPlayback(epNum, type, opts = {}) {
  stopPlayback();
  state.epNum = String(epNum);
  state.type = type;
  syncSwapToggle();
  if (opts.push !== false) {
    pushHist(() => { stopPlayback(); showView('detailView'); renderEpisodes(); });
  }
  const playId = (state.playId = (state.playId || 0) + 1);
  showView('playerView');
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
  $('playerStatus').textContent = 'Resolving sources…';

  let src;
  try {
    src = await api(
      `/api/sources?slug=${encodeURIComponent(state.slug)}&ep=${encodeURIComponent(epNum)}&type=${type}`
    );
  } catch (e) {
    if (state.playId !== playId) return;
    // auto-fallback to the other audio type
    const fb = e.fallbackType || (type === 'sub' ? 'dub' : 'sub');
    try {
      src = await api(
        `/api/sources?slug=${encodeURIComponent(state.slug)}&ep=${encodeURIComponent(epNum)}&type=${fb}`
      );
      toast(`No ${type} source — playing ${fb.toUpperCase()} instead`);
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
  clearInterval(tick);
  if (state.playId !== playId) return;
  state.sources = src;
  $('providerLabel').textContent = `via ${src.provider || 'hianime'}`;
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
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      buildQualityMenu(hls);
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        $('playerStatus').textContent = 'Playback error — try another episode or quality.';
        toast('Playback error: ' + data.details, true);
      }
    });
    hls.loadSource(src.proxiedUrl);
    hls.attachMedia(video);
  }

  // subtitles
  const def = (src.subtitles || []).find((s) => s.default) || src.subtitles[0];
  if (def && def.proxiedSrc) {
    try {
      const vtt = await (await fetch(def.proxiedSrc)).text();
      const blob = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = def.label || 'English';
      track.srclang = 'en';
      track.src = blob;
      track.default = true;
      $('video').appendChild(track);
    } catch { /* subtitles optional */ }
  }

  // resume position
  const saved = getJSON()[state.slug];
  if (saved && String(saved.epNum) === String(epNum) && saved.t > 30 && saved.pct < 95) {
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = saved.t;
      toast(`Resumed at ${fmtTime(saved.t)}`);
    }, { once: true });
  }

  setupWatchers(src);
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
}

$('qualitySel').addEventListener('change', (e) => {
  if (state.hls) state.hls.currentLevel = parseInt(e.target.value, 10);
});

function setupWatchers(src) {
  const video = $('video');
  clearInterval(state.progressTimer);
  clearInterval(state.introTimer);

  state.progressTimer = setInterval(() => {
    if (!video.paused) saveProgress();
  }, 5000);
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

/* ---- sub/dub hot swap ----
   Re-resolves the current episode in the other audio track; saveProgress ran
   just before, so startPlayback resumes at the position we left. */
function syncSwapToggle() {
  document.querySelectorAll('#swapToggle button').forEach((x) =>
    x.classList.toggle('active', x.dataset.type === state.type));
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

/* ---------------- settings ---------------- */

$('settingsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('settingsPanel').hidden = !$('settingsPanel').hidden;
});
document.addEventListener('click', (e) => {
  if ($('settingsPanel').hidden) return;
  if (!$('settingsPanel').contains(e.target) && e.target !== $('settingsBtn')) {
    $('settingsPanel').hidden = true;
  }
});

const defQualitySel = $('defQualitySel');
defQualitySel.value = String(prefs().quality || 'auto');
defQualitySel.addEventListener('change', () => {
  const p = prefs();
  p.quality = defQualitySel.value;
  setPrefs(p);
  toast(`Default quality: ${defQualitySel.value === 'auto' ? 'Auto' : defQualitySel.value + 'p'}`);
});

const defTypeSel = $('defTypeSel');
defTypeSel.value = prefs().defaultType || 'sub';
defTypeSel.addEventListener('change', () => {
  const p = prefs();
  p.defaultType = defTypeSel.value;
  p.lastType = defTypeSel.value;
  setPrefs(p);
  state.type = defTypeSel.value;
  toast(`Default audio: ${defTypeSel.value.toUpperCase()}`);
});

r18Sel.addEventListener('change', () => {
  const p = prefs();
  p.showR18 = r18Sel.value === 'show';
  setPrefs(p);
  rebuildRatingFilter(); // R+/Rx options exist only while 18+ is shown
  const hidden = p.showR18 ? 'now shown' : 'now hidden';
  toast(`18+ content ${hidden} — refreshing this view`);
  // re-apply to whatever is on screen right now
  if (state.view === 'browseView') loadBrowse();
  else if (state.view === 'favView') { /* favorites keep showing what you saved */ }
  else {
    // home view: redo the current content (search results or recent cards)
    if (!$('resultsSection').hidden && state.query) loadResults(false);
    else loadRecent();
  }
  renderUpcoming(); // the Coming soon section + marquee re-filter too
});

const pushNotifSel = $('pushNotifSel');
pushNotifSel.value = prefs().pushNotifs === false ? 'off' : 'on';
pushNotifSel.addEventListener('change', () => {
  const p = prefs();
  p.pushNotifs = pushNotifSel.value === 'on';
  setPrefs(p);
  toast(p.pushNotifs ? 'Favorite update alerts on' : 'Favorite update alerts off');
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

/* ---------------- version + in-app updates ---------------- */

async function loadVersion() {
  try {
    const { version, backupDir } = await api('/api/version');
    $('appVersion').textContent = `AniBrowser v${version}`;
    $('sideVersion').textContent = `v${version}`;
    if (backupDir) {
      $('backupHint').textContent =
        `Settings, favorites and history are backed up to ${backupDir} — they survive updates and reinstalls.`;
    }
  } catch { /* cosmetic only */ }
}

/* update banner + settings row; state comes from GET /api/update, actions via POST */
let updateDismissed = false;
let updateState = 'idle';
let lastUpdate = null; // full status object (carries apkPath on Android)

function renderUpdateUI(u) {
  updateState = u.disabled ? 'idle' : u.state;
  const banner = $('updateBanner');
  const visible = !updateDismissed && ['available', 'downloading', 'ready'].includes(u.state);
  banner.hidden = !visible;
  if (visible) {
    const btn = $('updateAction');
    btn.hidden = false;
    if (u.state === 'available') {
      $('updateText').textContent = `AniBrowser v${u.version} is available.`;
      // dev builds can't self-update — send the user to the releases page instead
      btn.textContent = u.external ? 'Open releases page' : 'Download update';
      btn.disabled = false;
    } else if (u.state === 'downloading') {
      $('updateText').innerHTML =
        `Downloading v${u.version || ''}… <div class="u-progress"><div style="width:${u.progress || 0}%"></div></div>`;
      btn.hidden = true;
    } else if (u.state === 'ready') {
      $('updateText').textContent = `AniBrowser v${u.version} is ready to install.`;
      btn.textContent = IS_ANDROID ? 'Install update' : 'Restart to install';
      btn.disabled = false;
    }
  }
  // settings row mirrors the state
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

$('updateAction').addEventListener('click', async () => {
  if (lastUpdate && lastUpdate.external) {
    // dev build + newer release exists: self-update is impossible, open GitHub
    window.open('https://github.com/RichardPersaud/AniBrowser/releases/latest', '_blank');
    return;
  }
  if (updateState === 'ready' && IS_ANDROID) {
    // hand the downloaded APK to the system installer via the Expo shell
    if (!lastUpdate || !lastUpdate.apkPath) return toast('Update file missing — re-download', true);
    window.location.href = `anibrowser-install://apk?path=${encodeURIComponent(lastUpdate.apkPath)}`;
    return;
  }
  const action = updateState === 'ready' ? 'install' : 'download';
  try {
    await api('/api/update', { action });
  } catch (e) {
    toast('Update failed: ' + e.message, true);
  }
});
$('updateDismiss').addEventListener('click', () => {
  updateDismissed = true;
  renderUpdateUI({ state: updateState });
});
$('checkUpdateBtn').addEventListener('click', async () => {
  $('updateStatusText').textContent = 'Checking…';
  try {
    await api('/api/update', { action: 'check' });
  } catch (e) {
    toast('Update check failed: ' + e.message, true);
  }
  pollUpdate();
});

/* ---- first-launch terms & conditions ----
   Nothing in the app is usable until these are accepted once; acceptance is
   persisted in prefs (and mirrored to the backup file), so it never asks again. */

let tosDeclined = false;
$('tosAccept').addEventListener('click', () => {
  const p = prefs();
  p.tosAccepted = true;
  setPrefs(p);
  $('tosOverlay').hidden = true;
  toast('Welcome to AniBrowser');
});
$('tosDecline').addEventListener('click', () => {
  if (tosDeclined) return;
  tosDeclined = true;
  const m = el('p', 'hint', 'AniBrowser can only be used after accepting these terms. Close the app, or come back and tap “I agree” when you are ready.');
  m.style.marginTop = '10px';
  m.style.textAlign = 'center';
  $('tosPanel').appendChild(m);
  $('tosDecline').disabled = true;
});
function showTosGate() {
  if (prefs().tosAccepted) return;
  $('tosOverlay').hidden = false;
}

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

/* ---- synopsis clamp toggle ---- */
$('synopsisToggle').addEventListener('click', () => {
  const clamped = $('detailSynopsis').classList.toggle('clamped');
  $('synopsisToggle').textContent = clamped ? 'View more' : 'View less';
});
// a resize changes how many lines the synopsis needs — re-decide the toggle
window.addEventListener('resize', () => {
  if (!$('detailView').hidden) syncSynopsisToggle();
});

/* ---------------- init ---------------- */

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
  await restoreFromBackup(); // must run before anything reads prefs/favorites
  showTosGate(); // first launch only — overlays the boot splash until accepted
  applySidebar();
  initBrowseUI();
  updateFavCount();
  renderNotifPanel(); // restore badge/panel state saved before the last close
  renderContinue();
  await loadRecent(); // home is ready once the recently-updated grid lands
  loadUpcoming(); // marquee + Coming soon grid (best-effort, cached 30 min)
  hideSplash();
  loadVersion();
  document.querySelector('.side-item[data-nav="home"]').classList.add('active');
  checkFavEpisodes(); // and every 10 minutes afterwards
  setInterval(checkFavEpisodes, 10 * 60 * 1000);
  pollUpdate(); // in-app update banner; the main process checks for releases itself
  setInterval(pollUpdate, 30 * 1000);
})();