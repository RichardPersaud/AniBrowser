'use strict';

/* global Hls */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

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
  prevView: 'homeView',
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
  const fav = el('button', 'fav-btn', '♥');
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
    for (const n of fresh) toast(`🔔 ${n.title}: ${n.newCount} new episode${n.newCount === 1 ? '' : 's'}!`);
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

async function api(path) {
  let res;
  try {
    res = await fetch(path, { signal: AbortSignal.timeout(60000) });
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
  // remember where the user came from, for the detail "Back" button
  if ((name === 'detailView' || name === 'playerView') && state.view !== 'detailView') {
    state.prevView = state.view;
  }
  for (const v of ['homeView', 'browseView', 'favView', 'detailView', 'playerView']) {
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
    openDetail(r.slug, r.title, r.poster);
  }
});

/* ---------------- browse all ---------------- */

// clickable page list with ellipsis, e.g. 1 … 4 5 [6] 7 8 … 340
function pageList(page, total) {
  const win = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(total, page + 2); p++) win.push(p);
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

const FILTER_OPTIONS = {
  type: [['tv', 'TV'], ['movie', 'Movie'], ['ova', 'OVA'], ['ona', 'ONA'], ['special', 'Special'], ['music', 'Music']],
  status: [['completed', 'Finished airing'], ['releasing', 'Currently airing'], ['not_yet_aired', 'Not yet aired']],
  rating: [['g', 'G'], ['pg', 'PG'], ['pg_13', 'PG-13'], ['r_17', 'R'], ['r_plus', 'R+'], ['rx', 'Rx']],
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
// select suffix -> query param (site filter page uses `genres`, not `genre`)
const bfParams = {
  Type: 'type', Status: 'status', Genre: 'genres', Rating: 'rating',
  Score: 'score', Season: 'season', Language: 'language', Sort: 'sort',
};

function initBrowseUI() {
  // alphabet bar: All / 0-9 / A-Z / Other
  const bar = $('alphaBar');
  for (const l of ['all', '0-9', ...'abcdefghijklmnopqrstuvwxyz'.split(''), 'other']) {
    const b = el('button', 'alpha-btn', l === 'all' ? 'All' : l === '0-9' ? '0-9' : l === 'other' ? 'Other' : l.toUpperCase());
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

  // filter selects
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

  $('browsePrev').addEventListener('click', () => {
    if (browse.page > 1) { browse.page -= 1; loadBrowse(); }
  });
  $('browseNext').addEventListener('click', () => {
    if (browse.page < browse.totalPages) { browse.page += 1; loadBrowse(); }
  });
  $('browsePages').addEventListener('click', (e) => {
    const b = e.target.closest('.page-btn');
    if (!b || Number(b.textContent) === browse.page) return;
    browse.page = Number(b.textContent);
    loadBrowse();
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
    for (const r of results) grid.appendChild(makeCard(r));
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

/* --- sidebar --- */
let sidebarOpen = prefs().sidebarOpen !== false;
function applySidebar() {
  document.body.classList.toggle('sidebar-open', sidebarOpen);
  const p = prefs();
  p.sidebarOpen = sidebarOpen;
  setPrefs(p);
}
$('sidebarBtn').addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  applySidebar();
});

function navHome() {
  state.query = '';
  state.page = 1;
  $('resultsSection').hidden = true;
  $('loadingState').hidden = true;
  showView('homeView');
  renderContinue();
  loadRecent();
}

/* --- in-window mini player while browsing --- */

function videoActive() {
  const v = $('video');
  return !!(state.hls || v.currentSrc) && v.readyState > 0;
}

// move the live <video> element back into the full player (playback survives
// reparenting; only removing it from the document entirely would reset it)
function restoreVideoToPlayer() {
  $('playerWrap').prepend($('video'));
  $('miniPlayer').hidden = true;
}

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

async function sidebarNav(target) {
  if (state.view === 'playerView') {
    // keep the video running in the docked mini player while browsing
    if (!minimizeToMini()) {
      state.playId = (state.playId || 0) + 1; // cancel in-flight source resolution
      stopPlayback();
    }
  }
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
  b.addEventListener('click', () => sidebarNav(b.dataset.nav));
});

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
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
  $('emptyState').hidden = true;
  $('moreBtn').hidden = true;
  if (!append) renderSkeletonCards($('resultsGrid'), 12);
  try {
    const { results } = await api(
      `/api/search?q=${encodeURIComponent(state.query)}&page=${state.page}`
    );
    if (!append) $('resultsGrid').innerHTML = '';
    for (const r of results) $('resultsGrid').appendChild(makeCard(r));
    $('moreBtn').hidden = results.length === 0;
    if (!append && results.length === 0) {
      $('resultsTitle').textContent = 'No results found';
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

// small placeholder boxes for the episode-number grid
function renderSkeletonEps(grid, count) {
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) grid.appendChild(el('div', 'sk-ep sk'));
}

function makeCard(r) {
  const card = el('div', 'card');
  const img = el('img');
  if (r.poster) {
    img.src = r.poster;
    img.onerror = () => { img.src = `/stream?u=${btoaUrl(r.poster)}`; img.onerror = null; };
  }
  img.loading = 'lazy';
  card.appendChild(img);
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
    for (const r of results.slice(0, 30)) grid.appendChild(makeCard(r));
    state.recentLoaded = true;
  } catch {
    section.hidden = true; // best-effort: hide rather than break the home view
  }
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
    const rm = el('button', 'fav-btn remove-btn', '✕');
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
  const rowsData = [
    ['Japanese', (d.japanese || '').length ? d.japanese : null],
    ['Studio', d.studios.length ? d.studios.join(', ') : null],
    ['Producers', d.producers.length ? d.producers.join(', ') : null],
    ['Status', d.status],
  ];
  for (const [k, v] of rowsData) {
    if (!v) continue;
    const row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-key', k));
    row.appendChild(el('span', 'meta-val', v));
    rows.appendChild(row);
  }
  $('detailInfo').hidden = !chipVals.length && !d.synopsis;
}

async function loadDetailInfo() {
  const slug = state.slug;
  try {
    const d = await api(`/api/detail?slug=${encodeURIComponent(slug)}`);
    if (state.slug === slug) renderDetailInfo(d);
  } catch { /* details are best-effort */ }
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
  state.slug = slug;
  state.title = title;
  state.poster = poster;
  state.epNum = null;
  state.type = prefs().defaultType || prefs().lastType || 'sub';
  for (const b of document.querySelectorAll('#typeToggle button')) {
    b.classList.toggle('active', b.dataset.type === state.type);
  }
  $('detailTitle').textContent = title;
  $('detailPoster').src = poster || '';
  updateDetailFav();
  renderDetailInfo(null); // hide stale info while loading
  loadDetailInfo();
  $('epCount').textContent = '';
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
  for (const ep of state.episodes) {
    const btn = el('button', 'ep-btn', ep.num);
    if (ep.num === String(state.epNum)) {
      btn.classList.add('current');
    } else if (Number(ep.num) < Number(prog.epNum)) {
      // already watched (before the resume point): check mark + dimmed style
      btn.classList.add('watched');
      btn.textContent = `✓ ${ep.num}`;
    }
    btn.addEventListener('click', () => startPlayback(ep.num, state.type));
    grid.appendChild(btn);
  }
}

document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.back === 'detail') {
      stopPlayback();
      showView('detailView');
      renderEpisodes();
      return;
    }
    // detail "Back" returns to wherever the show was opened from
    const target = state.prevView;
    if (target === 'favView') {
      renderFavorites();
      showView('favView');
    } else if (target === 'browseView') {
      // keep the browse results exactly as they were
      showView('browseView');
    } else {
      // keep any active search results on screen, restore the home sections
      showView('homeView');
      renderContinue();
      if (!$('resultsSection').hidden) {
        $('recentSection').hidden = true;
      } else {
        $('recentSection').hidden = false;
        loadRecent();
      }
    }
  });
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

function saveProgress(final = false) {
  if (!state.slug || !state.epNum) return;
  const video = $('video');
  if (!video.duration || isNaN(video.duration)) return;
  const all = getJSON();
  all[state.slug] = {
    title: state.title,
    poster: state.poster,
    epNum: state.epNum,
    t: video.currentTime,
    dur: video.duration,
    pct: Math.round((video.currentTime / video.duration) * 100),
    ts: Date.now(),
  };
  setJSON(all);
  if (final) {
    // drop fully-watched entries from "continue watching" only if near end
    const v = all[state.slug];
    if (v.pct > 95) v.t = 0;
    setJSON(all);
  }
}

async function startPlayback(epNum, type) {
  stopPlayback();
  state.epNum = String(epNum);
  state.type = type;
  const playId = (state.playId = (state.playId || 0) + 1);
  showView('playerView');
  $('playerTitle').textContent = `${state.title} — EP ${epNum} (${type.toUpperCase()})`;
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
      $('playerStatus').textContent = 'No sources found for this episode. ' + e2.message;
      toast(e2.message, true);
      return;
    }
  }
  clearInterval(tick);
  if (state.playId !== playId) return;
  state.sources = src;
  $('providerLabel').textContent = `via ${src.provider || 'hianime'}`;
  $('playerLoading').hidden = true;

  if (!Hls.isSupported()) {
    video.src = src.proxiedUrl;
    video.play().catch(() => {});
    return;
  }

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
  video.addEventListener('ended', () => {
    saveProgress(true);
    if ($('autoNextBtn').classList.contains('on')) {
      const next = state.episodes.find(
        (e) => parseFloat(e.num) > parseFloat(state.epNum)
      );
      if (next) startPlayback(next.num, state.type);
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

$('nextEpBtn').addEventListener('click', () => {
  const next = state.episodes.find((e) => parseFloat(e.num) > parseFloat(state.epNum));
  if (next) startPlayback(next.num, state.type);
  else toast('No next episode');
});
$('prevEpBtn').addEventListener('click', () => {
  const prev = state.episodes.filter((e) => parseFloat(e.num) < parseFloat(state.epNum)).pop();
  if (prev) startPlayback(prev.num, state.type);
  else toast('No previous episode');
});

$('autoNextBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const on = !btn.classList.contains('on');
  btn.classList.toggle('on', on);
  btn.textContent = `Auto-next: ${on ? 'ON' : 'OFF'}`;
  const p = prefs(); p.autoNext = on; setPrefs(p);
});
if (prefs().autoNext) {
  $('autoNextBtn').classList.add('on');
  $('autoNextBtn').textContent = 'Auto-next: ON';
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

/* keyboard */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ($('playerView').hidden) return;
  const video = $('video');
  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.code === 'ArrowRight') video.currentTime += 10;
  else if (e.code === 'ArrowLeft') video.currentTime -= 10;
  else if (e.code === 'KeyF') document.fullscreenElement ? document.exitFullscreen() : $('playerWrap').requestFullscreen();
  else if (e.code === 'KeyN') $('nextEpBtn').click();
});

/* ---------------- version ---------------- */

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

/* ---------------- init ---------------- */

let splashGone = false;
function hideSplash() {
  if (splashGone) return;
  splashGone = true;
  const s = $('bootSplash');
  s.classList.add('gone');
  setTimeout(() => { s.hidden = true; }, 350);
}

(async () => {
  // failsafe: never trap the user behind the splash
  setTimeout(hideSplash, 15000);
  await restoreFromBackup(); // must run before anything reads prefs/favorites
  applySidebar();
  initBrowseUI();
  updateFavCount();
  renderNotifPanel(); // restore badge/panel state saved before the last close
  renderContinue();
  await loadRecent(); // home is ready once the recently-updated grid lands
  hideSplash();
  loadVersion();
  document.querySelector('.side-item[data-nav="home"]').classList.add('active');
  checkFavEpisodes(); // and every 10 minutes afterwards
  setInterval(checkFavEpisodes, 10 * 60 * 1000);
})();