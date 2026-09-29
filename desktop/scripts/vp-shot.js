// Capture the raw visual viewport via CDP (no clip). Usage: node vp-shot.js <out.png>
const http = require('http');
const fs = require('fs');
function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
async function main() {
  const out = process.argv[2] || 'viewport.png';
  const targets = await getJSON('/json');
  // the app page lives on the loopback node server; AdMob webviews load
  // doubleclick pages that also show up as type "page"
  const page = targets.find((t) => t.type === 'page' && /48115/.test(t.url));
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const call = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      const h = (m) => {
        const msg = JSON.parse(m);
        if (msg.id === mid) { ws.off('message', h); res(msg.result); }
      };
      ws.on('message', h);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await new Promise((r) => ws.on('open', r));
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });