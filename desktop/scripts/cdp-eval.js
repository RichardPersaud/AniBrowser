// Evaluate a JS expression in the AniBrowser WebView via CDP and print the result.
// Usage: node cdp-eval.js "<expression>"   (USER_GESTURE=1 → run as user gesture)
const http = require('http');

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
  const expr = process.argv[2];
  if (!expr) {
    console.error('usage: node cdp-eval.js "<expression>"');
    process.exit(1);
  }
  const targets = await getJSON('/json');
  // the app page lives on the loopback node server; AdMob webviews load
  // doubleclick pages that also show up as type "page"
  const page = targets.find((t) => t.type === 'page' && /48115/.test(t.url));
  if (!page) {
    console.error('no app page target');
    process.exit(1);
  }
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  let mainCtx = null;
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    // pick the main-world context: same origin as the page itself (isolated
    // worlds carry a different origin/name and can't see the app's globals)
    if (msg.method === 'Runtime.executionContextCreated') {
      const c = msg.params.context;
      if (c.origin === new URL(page.url).origin && !mainCtx) mainCtx = c.id;
    }
  });
  const done = (s) => {
    try { ws.close(); } catch { /* ignore */ }
    console.log(s);
    process.exit(0);
  };
  ws.on('open', async () => {
    try {
      await send('Runtime.enable');
      await new Promise((r) => setTimeout(r, 600));
      const r = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        userGesture: process.env.USER_GESTURE === '1',
        ...(mainCtx ? { contextId: mainCtx } : {}),
      });
      const v = r && r.result;
      if (r && r.exceptionDetails) {
        done('EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception));
      }
      done(v && 'value' in v ? JSON.stringify(v.value) : JSON.stringify(v));
    } catch (e) {
      done('ERROR: ' + e.message);
    }
  });
  ws.on('error', (e) => done('WS-ERROR: ' + e.message));
  setTimeout(() => done('TIMEOUT'), 20000);
}

main().catch((e) => { console.error(e.message); process.exit(1); });