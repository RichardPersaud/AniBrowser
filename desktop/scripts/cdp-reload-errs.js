// Reload the app page and print any JS exceptions thrown during load.
// Usage: node cdp-reload-errs.js [waitMs]
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
  const waitMs = parseInt(process.argv[2] || '12000', 10);
  const targets = await getJSON('/json');
  const page = targets.find((t) => t.type === 'page' && /48115/.test(t.url));
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const call = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log('EXCEPTION:', d.text, d.exception && d.exception.description ? '\n  ' + d.exception.description.split('\n').slice(0, 6).join('\n  ') : '');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      console.log('CONSOLE ERROR:', JSON.stringify(msg.params.args).slice(0, 400));
    }
  });
  await new Promise((r) => ws.on('open', r));
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.reload');
  await new Promise((r) => setTimeout(r, waitMs));
  console.log('done');
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });