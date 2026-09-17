// Emulate a desktop viewport (1280x800, no touch) via CDP, then run a probe
// expression and take a full-viewport screenshot.
// Usage: node cdp-desktop.js "<expression>" <out.png>
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
  const [expr, out] = process.argv.slice(2);
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
  if (expr === '--reset') {
    await call('Emulation.clearDeviceMetricsOverride', {});
    await call('Emulation.setTouchEmulationEnabled', { enabled: true });
    console.log('reset');
    ws.close();
    process.exit(0);
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await call('Emulation.setEmitTouchEventsForMouse', { enabled: false, configuration: 'mobile' });
  await new Promise((r) => setTimeout(r, 800));
  let value = null;
  if (expr) {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    value = r.result.value;
  }
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify(value));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });