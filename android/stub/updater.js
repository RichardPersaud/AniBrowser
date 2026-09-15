'use strict';
// Android: in-app self-update is not applicable to a sideloaded APK.
// Same export shape as the Electron updater.js so server.js's lazy
// require('./updater') resolves, and /api/update returns {disabled:true} —
// which ui/app.js already renders as nothing.
const status = { state: 'idle', version: null, progress: 0, error: null };
function initUpdater() {}
function updaterStatus() { return { ...status, disabled: true }; }
async function updaterAction() {
  throw new Error('Auto-update is not available on Android');
}
module.exports = { initUpdater, updaterStatus, updaterAction };