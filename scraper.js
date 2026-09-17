'use strict';
// Scraper mirroring ani-cli's current hianime provider flow:
//   search HTML -> episode list API -> servers API -> ZokoAnime embed
//   embed page `window.__P` (base64 JSON XOR "otaku-embed-v1") -> master.m3u8

const BASE = 'https://hianime.at';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const XOR_KEY = 'otaku-embed-v1';

const epListCache = new Map(); // numId -> { t, eps }
const CACHE_TTL = 5 * 60 * 1000;

// epIds where every embed was unresolvable — the source site no longer hosts
// that episode. Lets the UI mark them in the episode list instead of making
// the user click into a certain failure again.
const deadEps = new Map(); // epId -> t
const DEAD_TTL = 30 * 60 * 1000;

function noteDeadEp(epId) {
  deadEps.set(epId, Date.now());
}

function isDeadEp(epId) {
  const t = deadEps.get(epId);
  if (!t) return false;
  if (Date.now() - t > DEAD_TTL) {
    deadEps.delete(epId);
    return false;
  }
  return true;
}

async function get(url, opts = {}) {
  const headers = { 'User-Agent': UA };
  if (opts.referer) headers.Referer = opts.referer;
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

function unescapeBackslashes(s) {
  // the site double-escapes inside its JSON html payloads
  return s.replace(/\\(.)/g, '$1');
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ---- browse pages (search / recently updated share the same card markup) ----

function parseFilmList(html) {
  const main = html.split('id="main-sidebar"')[0];
  const blocks = main.split('<div class="film-poster"').slice(1);
  const results = [];
  for (const b of blocks) {
    const m = b.match(
      /<h3 class="film-name">\s*<a href="[^"]*\/([^"?\/]+)"\s+title="([^"]*)"/
    );
    if (!m) continue;
    const img = b.match(/<img src="([^"]+)"\s+class="film-poster-img"/);
    results.push({
      slug: m[1],
      title: decodeEntities(m[2]),
      poster: img ? img[1] : null,
      // adult shows carry an 18+ tick on their card — feeds the R-content toggle
      r18: !!b.match(/tick tick-rate">18\+</),
      // top-upcoming cards put the premiere date in the duration slot
      // (regular cards hold a runtime like "23m" there — harmless extra field)
      date: (() => {
        const d = b.match(/fdi-duration">([^<]+)</);
        const v = d ? decodeEntities(d[1].trim()) : null;
        return v && v !== '...' ? v : null; // '...' = no date announced yet
      })(),
    });
  }
  return results;
}

// studio / producer listing pages, e.g. /studios/dle or /producers/shin-ei-animation
async function browsePath(pathname, page = 1) {
  if (!/^\/(studios|producers)\/[a-z0-9-]+$/i.test(pathname)) throw new Error('Bad path');
  const url = `${BASE}${pathname}${page > 1 ? `?page=${page}` : ''}`;
  const html = await (await get(url)).text();
  return { results: parseFilmList(html), totalPages: parseTotalPages(html) || 1, page };
}

// top-upcoming: not-yet-aired shows, newest premiere date first; the cards
// carry the date in the fdi-duration slot (captured as `date` above)
async function upcoming(page = 1) {
  const url = `${BASE}/top-upcoming${page > 1 ? `?page=${page}` : ''}`;
  return parseFilmList(await (await get(url)).text());
}

async function search(query, page = 1) {
  const url = `${BASE}/search?keyword=${encodeURIComponent(query)}&page=${page}`;
  return parseFilmList(await (await get(url)).text());
}

async function recentlyUpdated(page = 1) {
  const url = `${BASE}/recently-updated?page=${page}`;
  return parseFilmList(await (await get(url)).text());
}

// ---- browse (az-list / filter pages) ----------------------------------------

function parseTotalPages(html) {
  const nums = [...html.matchAll(/[?&;]page=(\d+)/g)].map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) : 1;
}

// opts.letter: 'all' | '0-9' | 'other' | 'a'..'z'  ->  /az-list/<letter>
// otherwise opts.{type,status,rating,score,season,language,sort,genre} -> /filter
// returns { results, totalPages, page }
async function browse(opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  let url;
  if (opts.letter) {
    url = `${BASE}/az-list/${encodeURIComponent(String(opts.letter).toLowerCase())}`;
    if (page > 1) url += `?page=${page}`;
  } else {
    const p = new URLSearchParams();
    // the site's filter form uses singular `genre` now (verified against the
    // live form + results); `genres` used to be plural and is ignored today
    for (const k of ['type', 'status', 'rating', 'score', 'season', 'language', 'sort', 'genre']) {
      if (opts[k]) p.set(k, opts[k]);
    }
    p.set('page', String(page));
    url = `${BASE}/filter?` + p.toString();
  }
  const html = await (await get(url)).text();
  return { results: parseFilmList(html), totalPages: parseTotalPages(html), page };
}

// ---- show details (synopsis / stats) ---------------------------------------

const detailCache = new Map(); // slug -> { t, data }
const DETAIL_TTL = 10 * 60 * 1000;

// value after `<span class="item-head">LABEL:</span>` — either linked (genres)
// or plain text (name spans); returns array for link lists, string otherwise
function metaSection(html, label) {
  const m = html.match(
    new RegExp(`item-head">${label}:</span>([\\s\\S]{0,3000}?)(?=<\\/div>|<div class="item)`)
  );
  if (!m) return null;
  const links = [...m[1].matchAll(/<a[^>]*title="([^"]*)"/g)].map((x) => decodeEntities(x[1]));
  if (links.length) return links;
  const text = m[1].replace(/<[^>]*>/g, ' ').trim();
  return text ? decodeEntities(text) : null;
}

// genre links on detail pages are /genres/<slug> — slugs feed the browse filter
function genreSlugs(html) {
  const m = html.match(/item-head">Genres:<\/span>([\s\S]{0,3000}?)(?=<\/div>|<div class="item)/);
  if (!m) return [];
  return [...m[1].matchAll(/\/genres\/([a-z0-9-]+)/g)].map((x) => x[1]);
}

// like metaSection, but keeps each link's path so the UI can open the
// studio/producer listing pages (e.g. /studios/dle, /producers/toei-animation)
function metaLinks(html, label) {
  const m = html.match(
    new RegExp(`item-head">${label}:</span>([\\s\\S]{0,3000}?)(?=<\\/div>|<div class="item)`)
  );
  if (!m) return [];
  return [...m[1].matchAll(/<a class="name" href="([^"]+)"\s+title="([^"]*)"/g)]
    .map((x) => ({ name: decodeEntities(x[2]), path: new URL(x[1], BASE).pathname }));
}

// "Related Anime" block on the detail page: the seasons / movies / spin-offs
// of the same franchise. Only some detail pages ship the section — absent → [].
function parseRelated(html) {
  const start = html.indexOf('cat-heading">Related Anime<');
  if (start < 0) return [];
  const end = html.indexOf('<section', start); // next sidebar block ends the section
  const seg = html.slice(start, end > 0 ? end : start + 30000);
  const out = [];
  const seen = new Set();
  for (const b of seg.split('<div class="film-poster').slice(1)) {
    const m = b.match(
      /<h3 class="film-name">\s*<a href="[^"]*\/([^"?\/]+)"\s+title="([^"]*)"/
    );
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const img = b.match(/<img src="([^"]+)"\s+class="film-poster-img"/);
    // the show type (TV / MOVIE / ONA …) trails the tick row in the entry
    const type = (b.match(/<div class="dot"><\/div>\s*([A-Za-z]+)/) || [])[1] || null;
    out.push({
      slug: m[1],
      title: decodeEntities(m[2]),
      poster: img ? img[1] : null,
      type,
      r18: !!b.match(/tick tick-rate">18\+</),
    });
    if (out.length >= 40) break; // defensive cap — some franchises list a lot
  }
  return out;
}

function metaText(html, label) {
  const m = html.match(
    new RegExp(`item-head">${label}:</span>\\s*<span class="name">([^<]*)</span>`)
  );
  return m ? decodeEntities(m[1].trim()) : null;
}

function metaTick(html, cls) {
  const m = html.match(new RegExp(`tick-item tick-${cls}[^>]*>(?:\\s*<i[^>]*></i>)?([^<]*)`));
  return m ? m[1].trim() : null;
}

// Returns { synopsis, japanese, aired, duration, status, malScore, pgRating,
//           type, subCount, dubCount, genres, studios, producers }
async function details(slug) {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Bad slug');
  const cached = detailCache.get(slug);
  if (cached && Date.now() - cached.t < DETAIL_TTL) return cached.data;

  const html = await (await get(`${BASE}/${slug}`, { timeout: 25000 })).text();

  const overview = (() => {
    const m = html.match(/item-head">Overview:<\/span>\s*<div class="text">([\s\S]*?)<\/div>/);
    if (!m) return null;
    return decodeEntities(m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  })();

  // <span class="item">TV</span> / <span class="item">24m</span> in film-stats
  const stats = html.match(/class="film-stats">([\s\S]{0,2000}?)(?:<div class="film-buttons|<\/div>\s*<\/div>)/);
  const type = stats ? (stats[1].match(/<span class="item">([^<]+)<\/span>/) || [])[1] || null : null;

  const data = {
    slug,
    synopsis: overview,
    japanese: metaText(html, 'Japanese'),
    aired: metaText(html, 'Aired'),
    duration: metaText(html, 'Duration'),
    status: metaText(html, 'Status'),
    malScore: metaText(html, 'MAL Score'),
    pgRating: metaTick(html, 'pg'),
    type,
    subCount: metaTick(html, 'sub'),
    dubCount: metaTick(html, 'dub'),
    genres: metaSection(html, 'Genres') || [],
    genreSlugs: genreSlugs(html),
    studios: metaSection(html, 'Studios') || [],
    producers: metaSection(html, 'Producers') || [],
    // linked forms carry the listing-page path for click-through navigation
    studioLinks: metaLinks(html, 'Studios'),
    producerLinks: metaLinks(html, 'Producers'),
    related: parseRelated(html),
  };
  detailCache.set(slug, { t: Date.now(), data });
  return data;
}

// ---- episode list ----------------------------------------------------------

function numIdFromSlug(slug) {
  return slug.split('-').pop();
}

async function episodes(slug) {
  const numId = numIdFromSlug(slug);
  const cached = epListCache.get(numId);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.eps;

  const url = `${BASE}/api/theme/episode/list/${numId}`;
  const j = await (await get(url)).json();
  const html = unescapeBackslashes(String(j.html || ''));
  const anchors = html.matchAll(/<a\b[^>]*class="[^"]*ep-item[^"]*"[^>]*>/gs);
  const eps = [];
  for (const a of anchors) {
    const num = (a[0].match(/data-number="([^"]*)"/) || [])[1];
    const epId = (a[0].match(/data-id="(\d+)"/) || [])[1];
    if (num && epId) eps.push({ num: String(num).trim(), epId });
  }
  eps.sort((a, b) => parseFloat(a.num) - parseFloat(b.num));
  epListCache.set(numId, { t: Date.now(), eps });
  return eps;
}

// ---- source resolution -----------------------------------------------------

function decodeBlob(b64) {
  const data = Buffer.from(b64, 'base64');
  const key = Buffer.from(XOR_KEY);
  return Buffer.from(data.map((b, i) => b ^ key[i % key.length])).toString('utf8');
}

// Returns a deduped list of candidate embeds for the requested type, ZokoAnime first.
async function pickEmbedUrls(epId, type, cap = 3) {
  const url = `${BASE}/api/theme/episode/servers?episodeId=${epId}`;
  const j = await (await get(url)).json();
  const html = unescapeBackslashes(String(j.html || ''));
  const entries = [];
  for (const chunk of html.split('server-item').slice(1)) {
    const dtype = (chunk.match(/data-type="([^"]*)"/) || [])[1];
    const name = (chunk.match(/data-server-name="([^"]*)"/) || [])[1];
    const hash = (chunk.match(/data-hash="([^"]*)"/) || [])[1];
    if (dtype && hash) entries.push({ type: dtype, name: name || '', hash });
  }
  const wanted = entries.filter((e) => e.type === type);
  const zoko = wanted.find((e) => e.name === 'ZokoAnime');
  const rest = wanted.filter((e) => e !== zoko);
  const ordered = [...(zoko ? [zoko] : []), ...rest];

  const seen = new Set();
  const out = [];
  for (const e of ordered) {
    let url;
    try {
      url = Buffer.from(e.hash, 'base64').toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, name: e.name });
    if (out.length >= cap) break;
  }
  return out;
}

// Try one embed page; resolve to a source object or null if unusable.
// `requireM3u8`: first pass wants HLS (quality menu); second pass accepts any
// playable src (e.g. mp4) — an episode without a subtitle track beats failing.
async function tryEmbed(embed, requireM3u8) {
  try {
    const embedOrigin = new URL(embed.url).origin + '/';
    const page = await (
      await get(embed.url, { referer: BASE + '/', timeout: 25000 })
    ).text();
    const blobMatch = page.match(/window\.__P="([^"]*)"/);
    if (!blobMatch) return null; // dead embed (in-page 404 etc.) — no config blob

    let cfg;
    try {
      cfg = JSON.parse(decodeBlob(blobMatch[1]));
    } catch {
      return null;
    }
    if (!cfg.src) return null;
    if (requireM3u8 && !cfg.src.includes('.m3u8')) return null;

    return {
      url: cfg.src,
      hls: cfg.src.includes('.m3u8'),
      referer: embedOrigin,
      subtitles: cfg.subtitles || [],
      skip: cfg.skip || null,
      provider: embed.name,
    };
  } catch {
    return null; // network error / timeout — try the next candidate
  }
}

// Returns { url, hls, subtitles: [{label, src, default}], skip, referer, provider }
async function getSources(slug, epNum, type = 'sub') {
  const eps = await episodes(slug);
  const ep =
    eps.find((e) => e.num === String(epNum).trim()) ||
    eps.find((e) => parseFloat(e.num) === parseFloat(String(epNum)));
  if (!ep) throw new Error(`Episode ${epNum} not found for ${slug}`);

  const other = type === 'sub' ? 'dub' : 'sub';
  const tryType = async (audioType) => {
    const candidates = await pickEmbedUrls(ep.epId, audioType);
    if (!candidates.length) return null;
    // prefer HLS sources; otherwise accept any playable stream (mp4 etc.)
    for (const mode of [true, false]) {
      for (const embed of candidates) {
        const src = await tryEmbed(embed, mode);
        if (src) return src;
      }
    }
    return null;
  };

  const src = (await tryType(type)) || (await tryType(other));
  if (src) return src;

  noteDeadEp(ep.epId);
  const err = new Error(
    `Episode ${epNum} is not available at the source right now ` +
      `(tried ${type} and ${other} — the embeds are dead or removed)`
  );
  err.fallbackType = other;
  throw err;
}

module.exports = {
  UA, BASE, search, recentlyUpdated, browse, browsePath, upcoming, details,
  episodes, getSources, isDeadEp,
};