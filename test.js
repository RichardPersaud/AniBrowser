'use strict';
// Live end-to-end test of the scraper chain.
const scraper = require('./scraper');

(async () => {
  console.log('1) search "one piece"…');
  const results = await scraper.search('one piece');
  console.log('   results:', results.length, 'first:', results[0]);

  console.log('2) episodes for', results[0].slug, '…');
  const eps = await scraper.episodes(results[0].slug);
  console.log('   episodes:', eps.length, 'first:', eps[0], 'last:', eps[eps.length - 1]);

  console.log('3) sources for ep 1 (sub)…');
  const src = await scraper.getSources(results[0].slug, '1', 'sub');
  console.log('   url:', src.url.slice(0, 80));
  console.log('   referer:', src.referer);
  console.log('   provider:', src.provider);
  console.log('   subtitles:', src.subtitles.map((s) => `${s.label}${s.default ? '*' : ''}`).join(', '));
  console.log('   skip:', JSON.stringify(src.skip).slice(0, 120));

  console.log('4) verify master playlist fetch through proxy rules…');
  const res = await fetch(src.url, {
    headers: { 'User-Agent': scraper.UA, Referer: src.referer },
  });
  const text = await res.text();
  console.log('   HTTP', res.status, '\n' + text.split('\n').slice(0, 4).join('\n'));

  console.log('5) sources for ep 2 (dub)…');
  try {
    const dub = await scraper.getSources(results[0].slug, '2', 'dub');
    console.log('   dub OK:', dub.url.slice(0, 60));
  } catch (e) {
    console.log('   dub failed (tolerated):', e.message);
  }
  console.log('\nALL OK');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});