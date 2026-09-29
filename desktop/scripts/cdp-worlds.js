// List execution contexts of the app page and eval a probe in each.
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
  const targets = await getJSON('/json');
  const page = targets.find((t) => t.type === 'page' && /48115/.test(t.url));
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  const contexts = [];
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.executionContextCreated') {
      contexts.push(msg.params.context);
    }
  });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 800));
  for (const c of contexts) {
    const r = await send('Runtime.evaluate', { expression: 'typeof state + "|" + location.href', returnByValue: true, contextId: c.id });
    console.log(`ctx ${c.id} origin=${c.origin} name=${c.name || ''} -> ${r && r.result ? JSON.stringify(r.result.value) : JSON.stringify(r)}`);
  }
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });