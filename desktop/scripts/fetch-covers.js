// One-off dev-time fetcher: downloads the hardcoded popular-title posters
// used by the login gate's collage backdrop into ui/covers/<slug>.jpg.
// Lives in scripts/ on purpose — sync-node.sh never ships this directory.
// Posters come from the app's own scraper (same CDN the app hotlinks at
// runtime), searched by title; saved locally so the app never needs the
// network for them again.
const fs = require('fs');
const path = require('path');
const https = require('https');
const scraper = require('../scraper');

const COVERS = [
  'Frieren: Beyond Journey\'s End',
  'Jujutsu Kaisen',
  'One Piece',
  'Demon Slayer: Kimetsu no Yaiba',
  'Attack on Titan',
  'Solo Leveling',
  'Death Note',
  'Fullmetal Alchemist: Brotherhood',
  'Steins;Gate',
  'Code Geass: Lelouch of the Rebellion',
  'Monster',
  'Spy x Family',
  'Chainsaw Man',
  'Vinland Saga',
  'Dandadan',
  'Violet Evergarden',
];

const OUT = path.join(__dirname, '..', 'ui', 'covers');

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': scraper.UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const title of COVERS) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const file = path.join(OUT, `${slug}.jpg`);
    if (fs.existsSync(file)) { console.log(`skip  ${slug} (exists)`); continue; }
    try {
      const results = await scraper.search(title);
      const poster = results.find((r) => r.poster)?.poster;
      if (!poster) throw new Error('no poster in search results');
      const buf = await get(poster);
      if (buf.length > 200 * 1024) console.warn(`warn  ${slug} ${(buf.length / 1024) | 0}KB — large`);
      fs.writeFileSync(file, buf);
      console.log(`ok    ${slug}  ${(buf.length / 1024) | 0}KB  <- ${poster}`);
    } catch (e) {
      console.error(`FAIL  ${title}: ${e.message}`);
    }
  }
  console.log('done:', fs.readdirSync(OUT).length, 'files in', OUT);
})();