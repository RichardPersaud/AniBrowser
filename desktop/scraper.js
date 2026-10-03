'use strict';
// Scraper mirroring ani-cli's current hianime provider flow:
//   search HTML -> episode list API -> servers API -> ZokoAnime embed
//   embed page `window.__P` (base64 JSON XOR "otaku-embed-v1") -> master.m3u8

const BASE = 'https://hianime.at';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const XOR_KEY = 'otaku-embed-v1';

const httpMod = require('http');
const httpsMod = require('https');
const zlib = require('zlib');
// Site fetches avoid undici's pooled fetch: on mobile/emulator its connect
// stage sometimes ETIMEDOUTs trying every address of the host while a plain
// IPv4 socket works. family: 4 pins it; keep-alive off keeps the flaky CDN
// reuse behavior identical to the streaming proxy.
const siteAgents = {
  'http:': new httpMod.Agent({ keepAlive: false, family: 4 }),
  'https:': new httpsMod.Agent({ keepAlive: false, family: 4 }),
};

// fetch-shaped shim over a raw https/http response: resolves redirects (up to
// 5) and attaches text()/json()/ok the way the fetch Response does, so every
// caller keeps working unchanged. Sends the headers a browser would (the node
// fetch ones kept Cloudflare happy; without them the connection gets dropped)
// and decodes gzip/deflate/br bodies.
function rawGet(url, extraHeaders, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error(`Too many redirects for ${url}`));
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`Bad URL: ${url}`));
    }
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      ...extraHeaders,
    };
    const mod = u.protocol === 'http:' ? httpMod : httpsMod;
    const req = mod.request(u, {
      agent: siteAgents[u.protocol],
      method: 'GET',
      headers,
    });
    req.setTimeout(20000, () => req.destroy(new Error(`upstream timeout for ${url}`)));
    // http.request() (unlike http.get()) never flushes until end() is called
    req.end();
    req.on('response', (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume(); // discard the redirect body
        resolve(rawGet(new URL(r.headers.location, u).href, extraHeaders, depth + 1));
        return;
      }
      r.ok = r.statusCode < 400;
      const enc = String(r.headers['content-encoding'] || '').toLowerCase();
      const decode = enc.includes('br') ? zlib.brotliDecompressSync
        : enc.includes('deflate') ? zlib.inflateSync
        : enc.includes('gzip') ? zlib.gunzipSync
        : null;
      const text = () =>
        new Promise((res2, rej2) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            const raw = Buffer.concat(chunks);
            if (decode && raw.length) {
              try {
                res2(decode(raw).toString('utf8'));
                return;
              } catch (e) {
                rej2(new Error(`Body decode failed (${enc}) for ${u.href}: ${e.message}`));
                return;
              }
            }
            res2(raw.toString('utf8'));
          });
          r.on('error', rej2);
        });
      r.text = text;
      r.json = async () => JSON.parse(await text());
      // body stays paused until text()/json() consume it — an unread body
      // just means its fresh socket (keepAlive off) closes when done
      resolve(r);
    });
    req.on('error', reject);
  });
}

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
  // the site flakes at connect time (same URL dead once, fine on a retry —
  // mirrors the stream CDNs the proxy retries). One quick retry helps page
  // loads survive it; a retry after a genuine slow timeout would only double
  // the wait, so fast failures only.
  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    try {
      const res = await rawGet(url, headers);
      if (!res.ok) {
        res.resume(); // drain the error body so the socket frees up
        throw new Error(`HTTP ${res.statusCode} for ${url}`);
      }
      return res;
    } catch (e) {
      // retry only the first attempt, and only on a quick network stumble —
      // the shim rejects with real Errors (timeout/connect), not a TypeError
      if (i === 0 && Date.now() - started < 8000 && !/HTTP \d+/.test(e.message || '')) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      throw e;
    }
  }
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

// home tabs: Popular = the site's most-popular list; Top Rated = filter
// sorted by avg_score, pinned to score>=8 TV shows (unpinned, the bare
// score sort leads with niche 10/10-from-2-votes noise that reads wrong)
async function mostPopular(page = 1) {
  const url = `${BASE}/most-popular?page=${page}`;
  return parseFilmList(await (await get(url)).text());
}
async function topRated(page = 1) {
  const url = `${BASE}/filter?sort=avg_score&score=8&type=tv&page=${page}`;
  return parseFilmList(await (await get(url)).text());
}

// ---- home spotlight (hero carousel) ----
// The homepage ships everything a hero needs in ONE fetch: a swiper spotlight
// (banner art, type / duration / premiere date, quality, sub-dub counts,
// description, both links) plus a trending list whose posters we join in by
// slug so the detail page can open with its portrait art.
async function spotlight() {
  const html = await (await get(`${BASE}/home`)).text();

  // slug -> poster from every film-poster link on the page (trending list,
  // sidebar top-10 — extras are harmless)
  const posters = new Map();
  for (const m of html.matchAll(
    /<a href="[^"]*\/([a-z0-9-]+)"\s+class="film-poster"[^>]*>\s*<img src="([^"]+)"\s+class="film-poster-img"/g
  )) {
    if (!posters.has(m[1])) posters.set(m[1], m[2]);
  }

  // the spotlight swiper sits between deslide-wrap and the first home section;
  // its swiper-slide blocks would otherwise mix with the trending list's own
  const spot = html.slice(
    html.indexOf('deslide-wrap'),
    html.indexOf('block_area_home')
  );
  const out = [];
  for (const b of spot.split('<div class="swiper-slide">').slice(1)) {
    const img = b.match(/deslide-cover-img">\s*<img class="film-poster-img"\s+src="([^"]+)"/);
    const title = b.match(/desi-head-title[^>]*>\s*([^<]+?)\s*</);
    // the Detail button's href is the show's page: /<slug>
    const detail = b.match(/desi-buttons[\s\S]*?<a href="[^"]*\/([a-z0-9-]+)"\s+class="btn btn-secondary/);
    if (!img || !title || !detail) continue;
    const chip = (iconCls) => {
      const m = b.match(
        new RegExp(`scd-item[^>]*>\\s*<i class="fas fa-${iconCls}[^"]*"[^>]*></i>([^<]*)`)
      );
      return m ? decodeEntities(m[1].trim()) : null;
    };
    const qual = b.match(/<span class="quality">([^<]*)</);
    const tick = (cls) => {
      const m = b.match(new RegExp(`tick-${cls}">\\s*<i[^>]*></i>([^<]*)`));
      return m ? m[1].trim() : null;
    };
    const desc = b.match(/desi-description">\s*([\s\S]*?)\s*<\/div>/);
    out.push({
      slug: detail[1],
      title: decodeEntities(title[1]),
      banner: img[1],
      poster: posters.get(detail[1]) || null,
      type: chip('play-circle'),
      duration: chip('clock'),
      date: chip('calendar'),
      quality: qual ? qual[1].trim() : null,
      subCount: tick('sub'),
      dubCount: tick('dub'),
      synopsis: desc ? decodeEntities(desc[1].replace(/\s+/g, ' ').trim()) : null,
    });
    if (out.length >= 5) break;
  }
  return out;
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
    // the show's own portrait art (first film-poster-img on the page) — lets
    // entry points that only know the slug (hero spotlight) backfill the poster
    poster: (html.match(/<img src="([^"]+)"\s*class="film-poster-img"/) || [])[1] || null,
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
  ratingCache.set(slug, { t: Date.now(), v: data.pgRating }); // seed the cheap path
  return data;
}

// ---- per-title content rating ----------------------------------------------
// The source tags only its adult-catalog entries with the 18+ card tick; shows
// merely rated R / R+ / Rx look like regular cards. Their rating lives on the
// detail page's pg tick, so the UI pulls it per visible card when the R-content
// setting is set to Hide. Ratings never change — cache a full week.

const ratingCache = new Map(); // slug -> { t, v }
const RATING_TTL = 7 * 24 * 60 * 60 * 1000;

async function ratingFor(slug) {
  const c = ratingCache.get(slug);
  if (c && Date.now() - c.t < RATING_TTL) return c.v;
  const d = await details(slug); // seeds ratingCache itself
  return d.pgRating;
}

// batch lookup for the UI's post-render sweep; unknown slugs resolve to null
async function ratings(slugs) {
  const out = {};
  // batched to keep the concurrent request count at the source modest
  for (let i = 0; i < slugs.length; i += 10) {
    await Promise.all(slugs.slice(i, i + 10).map(async (s) => {
      try { out[s] = await ratingFor(s); } catch { /* one miss shouldn't sink the batch */ }
    }));
  }
  return out;
}

// ---- episode list ----------------------------------------------------------

// Per-episode audio truth: the source's watch page only tags one big SUB/DUB
// count pair, which goes stale (Thunder 3 tagged DUB 12 while ep 10 serves sub
// only). The episode's own server list is the real answer — one probe per
// episode, so only reasonable-sized shows get it. Entries the probe couldn't
// answer stay undefined; the UI only hides tiles it positively knows lack.
const audsCache = new Map(); // numId -> { t, auds }
const AUDS_MAX_EPS = 60;
const AUDS_CHUNK = 8;

async function epAuds(slug) {
  const numId = numIdFromSlug(slug);
  const cached = audsCache.get(numId);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.auds;
  let eps;
  try { eps = await episodes(slug); } catch { return null; }
  if (!eps.length || eps.length > AUDS_MAX_EPS) return null; // tag counts only
  const auds = {};
  for (let i = 0; i < eps.length; i += AUDS_CHUNK) {
    await Promise.all(eps.slice(i, i + AUDS_CHUNK).map(async (ep) => {
      try {
        const url = `${BASE}/api/theme/episode/servers?episodeId=${ep.epId}`;
        const j = await (await get(url)).json();
        const html = unescapeBackslashes(String(j.html || ''));
        const types = new Set(
          [...html.matchAll(/data-type="([a-z]+)"/g)].map((m) => m[1])
        );
        auds[ep.num] = { sub: types.has('sub'), dub: types.has('dub') };
      } catch { /* episode stays unprobed — UI keeps its tile */ }
    }));
  }
  audsCache.set(numId, { t: Date.now(), auds });
  return auds;
}

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

// Which audio tracks this show actually has, from the first episode's server
// list — the only ground truth there is. The detail page's SUB/DUB counts are
// non-zero even on shows with no dub at all, so the UI can't rely on them.
// Cached alongside the episode list; null = unknown (no episodes / source error).
const audioCache = new Map(); // numId -> { t, audio }
async function audioTracks(slug) {
  const numId = numIdFromSlug(slug);
  const cached = audioCache.get(numId);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.audio;
  let audio = null;
  try {
    const eps = await episodes(slug);
    if (eps.length) {
      const url = `${BASE}/api/theme/episode/servers?episodeId=${eps[0].epId}`;
      const j = await (await get(url)).json();
      const html = unescapeBackslashes(String(j.html || ''));
      const types = new Set(
        [...html.matchAll(/data-type="([^"]*)"/g)].map((m) => m[1])
      );
      audio = { sub: types.has('sub'), dub: types.has('dub') };
    }
  } catch {
    audio = null; // network hiccup — the UI falls back to the detail counts
  }
  if (audio) audioCache.set(numId, { t: Date.now(), audio });
  return audio;
}

// ---- source resolution -----------------------------------------------------

function decodeBlob(b64) {
  const data = Buffer.from(b64, 'base64');
  const key = Buffer.from(XOR_KEY);
  return Buffer.from(data.map((b, i) => b ^ key[i % key.length])).toString('utf8');
}

// Returns { candidates: [{url, name}], names: [server names in DOM order] }
// for the requested audio type, ZokoAnime first among candidates.
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
  // every server the episode offers for this track, in site order — the UI's
  // server dropdown lists these even before any embed is fetched
  const names = [...new Set(wanted.map((e) => e.name).filter(Boolean))];
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
  return { candidates: out, names };
}

// Try one embed page; resolve to a source object or null if unusable.
// `requireM3u8`: first pass wants HLS (quality menu); second pass accepts any
// playable src (e.g. mp4) — an episode without a subtitle track beats failing.
// Megaplay embeds (HD-1 / Vidstream-2 servers) load their stream through JS
// instead of the __P blob: the embed page carries data-id, and a JSON API at
// stream/getSources?id=<data-id> returns {enc, tracks, intro, outro} where
// enc is a base64url AES-256-CBC blob decrypting to {"file": <playlist url>}.
// Static key/iv pair shipped in megaplay's own newclient.min.js: the 16-char
// key is zero-padded to 32 bytes (AES-256) and reused for the IV.
function megaplayDecrypt(enc) {
  const crypto = require('crypto');
  const key = Buffer.concat([
    Buffer.from('i?LMTAx0Q6,:}50U', 'latin1'),
    Buffer.alloc(16),
  ]);
  const iv = Buffer.from('W0;27ToaUpl_P%\'c', 'latin1');
  const data = Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// Resolve one megaplay embed page to a source object, or null if unusable.
async function tryMegaplay(embed, requireM3u8) {
  try {
    const embedOrigin = new URL(embed.url).origin + '/';
    const page = await (
      await get(embed.url, { referer: BASE + '/', timeout: 25000 })
    ).text();
    // the player div's data-id is the API's key (realid/mediaid are not)
    const dataId = (page.match(/id="megaplay-player"\s+data-id="(\d+)"/) || [])[1];
    if (!dataId) return null;

    const apiUrl = `${embedOrigin}stream/getSources?id=${dataId}`;
    const j = await (await get(apiUrl, { referer: embed.url, timeout: 25000 })).json();
    if (!j.enc) return null;
    const cfg = JSON.parse(megaplayDecrypt(j.enc));
    if (!cfg.file) return null;
    if (requireM3u8 && !cfg.file.includes('.m3u8')) return null;

    const subtitles = (j.tracks || [])
      .filter((t) => t.file)
      .map((t) => ({ label: t.label || t.lang || 'English', src: t.file, default: /english/i.test(t.label || t.lang || '') }));
    // megaplay reports intro/outro windows — keep the shape the UI expects
    const skip = (j.intro && j.intro.end > j.intro.start) || (j.outro && j.outro.end > j.outro.start)
      ? { intro: j.intro || null, outro: j.outro || null }
      : null;

    return {
      url: cfg.file,
      hls: cfg.file.includes('.m3u8'),
      referer: embedOrigin,
      subtitles,
      skip,
      provider: embed.name,
    };
  } catch {
    return null;
  }
}

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
// `server` (optional): resolve only that named provider (HD-1, ZokoAnime, …)
// instead of first-success across all of them — powers the player's server
// dropdown. The response's `servers` array lists what the episode offers.
async function getSources(slug, epNum, type = 'sub', server) {
  const eps = await episodes(slug);
  const ep =
    eps.find((e) => e.num === String(epNum).trim()) ||
    eps.find((e) => parseFloat(e.num) === parseFloat(String(epNum)));
  if (!ep) throw new Error(`Episode ${epNum} not found for ${slug}`);

  const other = type === 'sub' ? 'dub' : 'sub';
  const tryType = async (audioType) => {
    const { candidates, names } = await pickEmbedUrls(ep.epId, audioType);
    if (!candidates.length) return { src: null, names };
    // an explicit server request resolves just that provider — no cross-server
    // failover here; the caller decides what to do when it fails
    const wanted = server ? candidates.filter((c) => c.name === server) : candidates;
    if (server && !wanted.length) return { src: null, names };
    // prefer HLS sources; otherwise accept any playable stream (mp4 etc.)
    for (const mode of [true, false]) {
      for (const embed of wanted) {
        // megaplay embeds (HD-1 / Vidstream-2) need their own resolver — a
        // different CDN from ZokoAnime's, which matters when one is blocked
        const src = embed.url.includes('megaplay')
          ? await tryMegaplay(embed, mode)
          : await tryEmbed(embed, mode);
        // audioType = the track this stream actually is — when the requested
        // type has no embeds we silently resolve the other one, and the UI
        // needs to know so it can say so instead of playing the wrong audio
        if (src) return { src: { ...src, audioType }, names };
      }
    }
    return { src: null, names };
  };

  let names = [];
  let src = null;
  for (const audioType of [type, other]) {
    let r = await tryType(audioType);
    names = r.names.length ? r.names : names;
    // transient resolve failures (embed-API hiccups, rate limits) look
    // identical to genuinely dead embeds — one quiet retry before falling
    // through to the other audio track keeps "dead or removed" honest
    if (!r.src) {
      await new Promise((ok) => setTimeout(ok, 1200));
      r = await tryType(audioType);
      names = r.names.length ? r.names : names;
    }
    if (r.src) { src = r.src; break; }
  }
  if (src) return { ...src, servers: names };
  if (server) {
    // the user picked a server explicitly — say so instead of the generic
    // "episode unavailable" line, and don't poison the dead-episode cache
    // (the other servers may still be fine)
    throw new Error(`Server ${server} is not available for this episode`);
  }

  noteDeadEp(ep.epId);
  const err = new Error(
    `Episode ${epNum} is not available at the source right now ` +
      `(tried ${type} and ${other} — the embeds are dead or removed)`
  );
  err.fallbackType = other;
  throw err;
}

// ---- airing schedule ----
// The day list is an AJAX fragment rendered by the source's schedule widget:
// POST-less GET of /api/theme/schedule/day?tzOffset=&date= returns items whose
// times are already shifted into the client's timezone via tzOffset.
const SCHED_BASE = `${BASE}/api/theme/`;

async function scheduleDay(date, tzOffset = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date');
  const body = await (
    await get(`${SCHED_BASE}schedule/day?tzOffset=${tzOffset}&date=${date}`)
  ).text();
  // the widget answers a JSON envelope ({ html: "<ul..." }) — its escaping
  // collapses to plain HTML once parsed
  const html = (JSON.parse(body).html || '').replace(/\\\//g, '/');

  const items = [];
  for (const li of html.split('<li>').slice(1)) {
    const link = li.match(/<a href="[^"]*\/watch\/([a-z0-9-]+)"/);
    if (!link) continue; // stray wrapper, not a schedule row
    const time = (li.match(/<div class="time">([\d:]+)<\/div>/) || [])[1] || null;
    const name = li.match(/data-jname="([^"]*)"[^>]*>\s*([^<]+)</) ||
      li.match(/data-jname="([^"]*)"/) || [];
    const ep = (li.match(/Episode\s*(\d+)/) || [])[1];
    items.push({
      slug: link[1],
      time,
      title: unescapeBackslashes(decodeEntities((name[2] || name[1] || '').trim())),
      jname: unescapeBackslashes(decodeEntities(name[1] || '')),
      ep: ep ? parseInt(ep, 10) : null,
    });
  }
  return items;
}

// ---- cast (characters + voice actors) ----
// The source site has no cast section, so this resolves the show on AniList
// (matched against the slug's own words, so a bad search match never paints
// the wrong show's cast) and returns each character with their Japanese VA.
// One GraphQL request per opening; results are cached like the detail page.

const CAST_TTL = 24 * 60 * 60 * 1000; // casts don't churn once a show aired
const castCache = new Map();          // slug -> { t, data }
let lastAniListAt = 0;                // polite pacing for the shared quota

const CAST_QUERY = `query ($q: String) {
  Page(perPage: 5) {
    media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
      title { romaji english native }
      characters(sort: [ROLE, RELEVANCE], perPage: 24) {
        edges { role
          node { name { full } image { large } }
          voiceActors(language: JAPANESE) { name { full } image { large } }
        }
      }
    }
  }
}`;

function titleTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}

// a candidate is the right show when their title words overlap — either set
// contained in the other (“demon-slayer-kimetsu-no-yaiba” ⊇ “kimetsu no yaiba”)
function titleMatch(slug, media) {
  const wanted = new Set(titleTokens(slug.replace(/-+/g, ' ')));
  const cand = new Set(
    Object.values(media.title || {}).flatMap(titleTokens)
  );
  if (!wanted.size || !cand.size) return false;
  const [small, big] = wanted.size <= cand.size ? [wanted, cand] : [cand, wanted];
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

async function anilistCast(query) {
  // one shared pacing gate — AniList's anonymous quota (90/min) is per IP
  const wait = 1500 - (Date.now() - lastAniListAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAniListAt = Date.now();

  const req = httpsMod.request('https://graphql.anilist.co', {
    method: 'POST',
    agent: siteAgents['https:'],
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity',
    },
  });
  req.setTimeout(15000, () => req.destroy(new Error('AniList timeout')));
  const payload = JSON.stringify({ query: CAST_QUERY, variables: { q: query } });
  const chunks = [];
  return await new Promise((resolve, reject) => {
    req.on('response', (r) => {
      if (r.statusCode !== 200) r.resume();
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`AniList HTTP ${r.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function cast(slug) {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Bad slug');
  const c = castCache.get(slug);
  if (c && Date.now() - c.t < CAST_TTL) return c.data;

  let data = { cast: [] };
  try {
    // the source's slugs carry season numbers ("one-piece-1"); those words
    // rank the search away from the show, so retry without a trailing
    // numeric run before giving up ('kaiju-no-8' keeps its 8 — only a match
    // failure triggers the retry)
    const base = decodeEntities(slug.replace(/-+/g, ' ')).trim();
    let hit = null;
    let body = await anilistCast(base);
    let media = (body && body.data && body.data.Page && body.data.Page.media) || [];
    hit = media.find((m) => titleMatch(slug, m)) || null;
    if (!hit && /-\d+$/.test(slug)) {
      const base2 = base.replace(/\s+\d+$/, '').trim();
      body = await anilistCast(base2);
      media = (body && body.data && body.data.Page && body.data.Page.media) || [];
      // the wanted words drop the number too ("one piece 1" → match "One Piece")
      hit = media.find((m) => titleMatch(slug.replace(/-\d+$/, ''), m)) || null;
    }
    const edges = (hit && hit.characters && hit.characters.edges) || [];
    data.cast = edges
      .map((e) => ({
        name: e.node && e.node.name && e.node.name.full,
        image: (e.node && e.node.image && e.node.image.large) || null,
        main: e.role === 'MAIN',
        va: e.voiceActors && e.voiceActors[0]
          ? {
              name: e.voiceActors[0].name && e.voiceActors[0].name.full,
              image: (e.voiceActors[0].image && e.voiceActors[0].image.large) || null,
            }
          : null,
      }))
      .filter((x) => x.name);
  } catch (e) {
    // AniList unreachable / throttled: an empty list (tab shows a hint) beats
    // failing the tap — but don't cache failures longer than a few minutes
    castCache.set(slug, { t: Date.now() - (CAST_TTL - 5 * 60 * 1000), data });
    throw e;
  }
  if (!data.cast.length) {
    // an unmatched show isn't proof: cache only briefly so a fixed match can
    // succeed (and a transient AniList hiccup can retry) later that day
    castCache.set(slug, { t: Date.now() - (CAST_TTL - 5 * 60 * 1000), data });
    return data;
  }
  castCache.set(slug, { t: Date.now(), data });
  return data;
}

module.exports = {
  UA, BASE, rawGet, search, recentlyUpdated, mostPopular, topRated, browse, browsePath, upcoming, details, spotlight,
  episodes, epAuds, audioTracks, getSources, isDeadEp, ratings, ratingFor, scheduleDay, cast,
};