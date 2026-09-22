// Evaluate a JS expression in the AniBrowser WebView via CDP and print the result.
// Usage: node cdp-eval.js "<expression>"
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
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.error('no page target');
    process.exit(1);
  }
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  const done = (s) => {
    try { ws.close(); } catch { /* ignore */ }
    console.log(s);
    process.exit(0);
  };
  ws.on('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id === 1) {
      const r = msg.result && msg.result.result;
      if (msg.result && msg.result.exceptionDetails) {
        done('EXCEPTION: ' + JSON.stringify(msg.result.exceptionDetails.exception));
      }
      done(r && 'value' in r ? JSON.stringify(r.value) : JSON.stringify(r));
    }
  });
  ws.on('error', (e) => done('WS-ERROR: ' + e.message));
  setTimeout(() => done('TIMEOUT'), 20000);
}

main().catch((e) => { console.error(e.message); process.exit(1); });