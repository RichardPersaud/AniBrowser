'use strict';
// Android entry point (replaces Electron's main.js): same crash suppressors,
// then start the server with a data dir inside the app's private storage, then
// hand the bound port to the Kotlin shell through a marker file.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.on('uncaughtException', (e) => {
  console.error('[suppressed uncaughtException]', e && (e.stack || e.message || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[suppressed unhandledRejection]', e && (e.stack || e.message || e));
});

const { start } = require('./server');

(async () => {
  // os.homedir() == the app's filesDir — set natively via registerNodeDataDirPath()
  const dataDir = path.join(os.homedir(), 'AniBrowser');
  const { port } = await start({ dataDir });
  const marker = path.join(os.homedir(), 'anibrowser-port.json');
  const tmp = marker + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }));
  fs.renameSync(tmp, marker); // atomic handoff to the Kotlin shell
  console.log('[anibrowser] listening on http://127.0.0.1:' + port, 'data:', dataDir);
})().catch((e) => {
  console.error('[anibrowser] fatal:', e && (e.stack || e.message || e));
  process.exit(1);
});