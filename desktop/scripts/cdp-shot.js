// Screenshot a specific DOM element (or selector index) via CDP clip.
// Usage: node cdp-shot.js "<selector>" <out.png> [index]
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
  const [sel, out, idx] = process.argv.slice(2);
  const index = parseInt(idx || '0', 10) || 0;
  const targets = await getJSON('/json');
  const page = targets.find((t) => t.type === 'page');
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
  const rect = await call('Runtime.evaluate', {
    expression: `(function(){const el=document.querySelectorAll(${JSON.stringify(sel)})[${index}]; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,dpr:window.devicePixelRatio};})()`,
    returnByValue: true,
  }).then((r) => r.result.value);
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
    captureBeyondViewport: false,
  });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, JSON.stringify(rect));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });