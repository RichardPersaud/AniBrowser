'use strict';

/* ================= custom player controls (pv) =================
   Own the whole on-video control surface: play/pause, seek bar, times,
   playback speed, subtitle picker + styling, audio tracks, quality/server
   mirrors, auto-next/SUB↔DUB, touch gestures and the rotate-to-fullscreen
   handshake with the Android shell (which replaces the HTML Fullscreen API —
   requestFullscreen() never worked inside react-native-webview).

   Loads AFTER app.js and reads its global scope (state / prefs / fmtTime /
   videoActive / $). app.js notifies via pv:* CustomEvents:
     source — new stream resolved: (re)mount subtitle tracks, reset overlays
     sync   — quality/server menus changed: mirror them in the sheet
     view   — view changed: close the sheet, leave rotated fullscreen if
              playback was left
     stop   — playback ended: strip chrome, release the brightness override
     dock / undock — the video moved to/from the mini player (native
              controls take over there; the pv bar is meaningless)
   See the hook call sites in app.js (emitPv / the pv:view dispatch).
================================================================= */

/* global $ el state prefs setPrefs fmtTime videoActive IS_ANDROID */

(function () {
  const video = $('video');
  const area = $('videoArea');
  if (!video || !area) return;

  const ui = $('pvUi');
  const top = $('pvTop');
  const bottom = $('pvBottom');
  const sheet = $('pvSheet');
  const hintEl = $('pvHint');
  const fill = $('pvFill');
  const buf = $('pvBuf');
  const head = $('pvHead');

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const CUE_SIZES = { S: '0.9em', M: '1.15em', L: '1.6em', XL: '2.2em' };
  const CUE_COLORS = { white: '#ffffff', yellow: '#ffe08a', cyan: '#8ce4fa' };

  // the SUB-DUB / server / quality / auto-next controls MOVE into the top
  // strip of the player (#pvChips sits inside #pvTop) — the page used to
  // mount them under the video band and, rotated, they lived in a hidden
  // detail slot. Relocate once at load; every app.js reference
  // ($('#swapToggle')…) keeps working.
  const right = $('playerRight');
  if (right && $('pvChips')) {
    $('pvChips').appendChild(right);
    $('pvChips').hidden = false; // visible whenever #pvUi is (opacity fades it)
  }

  // SUB↔DUB renders as a slide switch: app.js keeps toggling .active on its
  // buttons (syncSwapToggle) — mirror that into a data-knob attribute the CSS
  // knob rides on, so it stays in sync no matter who flips the type
  const seg = $('swapToggle');
  function syncSwapKnob() {
    if (!seg) return;
    const a = seg.querySelector('button.active');
    seg.dataset.knob = a ? a.dataset.type : 'sub';
    seg.dataset.solo = seg.querySelectorAll('button:not([hidden])').length < 2 ? '1' : '0';
  }
  syncSwapKnob();
  if (seg) {
    setTimeout(syncSwapKnob, 0); // app.js may toggle .active after us
    new MutationObserver(syncSwapKnob).observe(seg, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
  }

  // centre overlay: buffering spinner + big play/pause icon. Lives directly
  // in #videoArea (a sibling under #pvUi) so the spinner shows even while
  // the control bar is hidden; pointer-events:none keeps gestures working.
  const center = el('div', 'pv-center');
  center.innerHTML =
    '<div id="pvSpin"><div class="spinner"></div></div>' +
    '<svg id="pvPulse" class="icon"><use id="pvPulseIcon" href="#i-play"/></svg>';
  area.insertBefore(center, ui);
  const spinEl = center.querySelector('#pvSpin');
  const pulse = center.querySelector('#pvPulse');
  let pulseT = null;
  function pulseIcon(iconRef, stick) {
    if (!area.contains(video)) { pulse.style.opacity = 0; return; }
    pulse.querySelector('use').setAttribute('href', iconRef);
    pulse.style.opacity = 1;
    clearTimeout(pulseT);
    if (!stick) pulseT = setTimeout(() => { pulse.style.opacity = 0; }, 600);
  }
  function showSpin(on) {
    spinEl.classList.toggle('on', !!on && state.view === 'playerView' && area.contains(video));
  }
  video.addEventListener('waiting', () => { pulse.style.opacity = 0; showSpin(true); });
  video.addEventListener('stalled', () => { showSpin(true); });
  video.addEventListener('seeking', () => { showSpin(true); });
  video.addEventListener('playing', () => { showSpin(false); });
  video.addEventListener('canplay', () => { showSpin(false); });
  video.addEventListener('seeked', () => { showSpin(false); });
  video.addEventListener('pause', () => { showSpin(false); pulseIcon('#i-play', true); });
  video.addEventListener('play', () => { pulseIcon('#i-pause', false); });
  video.addEventListener('emptied', () => { showSpin(false); });

  // fine pointer = desktop mouse: single-tap toggles the bar immediately and
  // dblclick handles the seek zones; coarse (touch) needs the delay dance
  const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
  // the WebView reports IS_ANDROID for the shell side; the desktop app doesn't
  const ANDROID = typeof IS_ANDROID !== 'undefined' && IS_ANDROID;

  // ---------- bridge ----------
  function post(msg) {
    try { window.ReactNativeWebView?.postMessage(JSON.stringify(msg)); } catch { /* desktop */ }
  }

  // ---------- prefs ----------
  function pvPref(name, fallback) {
    const v = prefs()[name];
    return v === undefined || v === null ? fallback : v;
  }
  function savePvPref(name, value) {
    const p = prefs();
    p[name] = value;
    setPrefs(p);
  }

  // ================================================================
  // control-bar visibility
  // ================================================================
  let shown = false;
  let hideT = null;
  let scrubbing = false;

  // any of these keep the bar pinned regardless of the inactivity timer
  function pinned() {
    return !video.paused ||
      scrubbing ||
      !sheet.hidden ||
      !$('playerLoading').hidden ||
      !$('watchUpOverlay').hidden ||
      document.body.classList.contains('pip-full');
  }

  function show() {
    if (!ui.hidden && shown) { scheduleHide(); return; }
    shown = true;
    ui.hidden = false;
    ui.classList.add('show');
    scheduleHide();
  }
  function hide() {
    if (!sheet.hidden) return; // a menu up: keep the bar so the gear stays reachable
    shown = false;
    ui.classList.remove('show');
    // let the fade-out run, then drop the overlay from hit-testing entirely
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (!shown) ui.hidden = true; }, 230);
  }
  function toggleControls() {
    if (shown) hide(); else show();
  }
  function scheduleHide() {
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (shown && !pinned()) hide(); }, 3200);
  }

  // ================================================================
  // play/pause button + time labels
  // ================================================================
  function syncPlayIcon() {
    $('pvPlayIcon').setAttribute('href', video.paused ? '#i-play' : '#i-pause');
    $('pvPlay').title = video.paused ? 'Play' : 'Pause';
  }
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    show();
  }

  $('pvPlay').addEventListener('click', togglePlay);

  video.addEventListener('play', () => { syncPlayIcon(); show(); });
  video.addEventListener('pause', () => { syncPlayIcon(); show(); });
  video.addEventListener('ended', () => { show(); });
  video.addEventListener('waiting', () => { scheduleHide(); });
  video.addEventListener('timeupdate', () => { drawTimes(); });
  video.addEventListener('durationchange', () => { drawTimes(); });
  video.addEventListener('progress', () => { drawBuffer(); });

  function drawTimes() {
    if (!isFinite(video.duration)) return;
    const t = video.currentTime;
    $('pvTime').textContent = fmtTime(t);
    $('pvDur').textContent = fmtTime(video.duration);
    const pct = (t / video.duration) * 100;
    fill.style.width = pct + '%';
    head.style.left = pct + '%';
  }
  function drawBuffer() {
    if (!isFinite(video.duration) || !video.buffered.length) return;
    // paint the buffered range that contains the playhead (the common case);
    // later ranges would need segmented styling — skip them
    for (let i = video.buffered.length - 1; i >= 0; i--) {
      if (video.currentTime < video.buffered.end(i)) {
        buf.style.width = (video.buffered.end(i) / video.duration) * 100 + '%';
        return;
      }
    }
  }

  // ================================================================
  // seek bar (pointer-driven; pointer events so mouse + touch behave identically)
  // ================================================================
  function commitTime(t) {
    const d = video.duration;
    if (!isFinite(d)) return;
    video.currentTime = Math.max(0, Math.min(d, t));
  }

  let seekDrag = false;
  $('pvSeek').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    seekDrag = true;
    scrubbing = true;
    try { $('pvSeek').setPointerCapture(e.pointerId); } catch { /* fine */ }
    show();
    e.preventDefault();
  });
  $('pvSeek').addEventListener('pointermove', (e) => {
    if (!seekDrag) return;
    applySeekPointer(e);
    e.preventDefault();
  });
  $('pvSeek').addEventListener('pointerup', (e) => {
    if (!seekDrag) return;
    seekDrag = false;
    scrubbing = false;
    applySeekPointer(e);
    scheduleHide();
  });
  $('pvSeek').addEventListener('pointercancel', () => {
    seekDrag = false;
    scrubbing = false;
    scheduleHide();
  });
  function applySeekPointer(e) {
    const r = $('pvSeek').getBoundingClientRect();
    if (!r.width || !isFinite(video.duration)) return;
    commitTime(((e.clientX - r.left) / r.width) * video.duration);
    drawTimes();
  }

  // ================================================================
  // gesture engine — taps, double-taps, swipe seek / volume / brightness
  // ================================================================
  let g = null; // active gesture { id, x0, y0, mode, start, targetTime }
  let singleT = null;
  let lastTapT = 0;
  let lastTapZone = '';

  // gestures only exist on the video surface itself
  function gestureBlocked(t) {
    if (state.view !== 'playerView') return true; // mini player / other page
    if (document.body.classList.contains('pip-full')) return true; // mirror only
    if (t.closest('#pvSheet, #pvTop, #pvBottom, .overlay-btn, button, select')) return true;
    if (!$('playerLoading').hidden || !$('watchUpOverlay').hidden) return true;
    if (!area.contains(video) || !videoActive()) return true; // nothing playing
    return false;
  }
  function tapZone(e) {
    const r = area.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (y < 0.2) return 'top'; // title/back row — taps there toggle too
    if (x < 0.34) return 'left';
    if (x > 0.66) return 'right';
    return 'center';
  }
  function seekBy(s) {
    commitTime(video.currentTime + s);
    hint((s > 0 ? '+10s' : '−10s'));
    show();
  }

  area.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (gestureBlocked(e.target)) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: null, targetTime: null };
    try { area.setPointerCapture(e.pointerId); } catch { /* fine */ }
  }, true);

  area.addEventListener('pointermove', (e) => {
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    const r = area.getBoundingClientRect();
    if (!g.mode) {
      if (Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy) + 4 && isFinite(video.duration)) {
        g.mode = 'seek';
        g.start = video.currentTime;
        show();
      } else if (Math.abs(dy) > 26 && Math.abs(dy) > Math.abs(dx) + 4) {
        if ((e.clientX - r.left) > r.width / 2) g.mode = 'vol';
        else if (ANDROID) g.mode = 'bright';
        if (g.mode) { g.start = g.mode === 'vol' ? video.volume : 1; show(); showGestureHint(g.mode, g.start); }
      }
    }
    if (!g.mode) return;
    e.preventDefault();
    if (g.mode === 'seek') {
      // horizontal drag: scrub-preview at 120s max across the area width; the
      // playhead COMMITS on release (no hls seek storms while dragging)
      const span = Math.min(120, video.duration);
      g.targetTime = Math.max(0, Math.min(video.duration, g.start + (dx / r.width) * span));
      hint(`${fmtTime(g.targetTime)} / ${fmtTime(video.duration)}`, true);
    } else if (g.mode === 'vol') {
      video.muted = false;
      const v = Math.max(0, Math.min(1, g.start - dy / (r.height * 0.6)));
      video.volume = v;
      showGestureHint('vol', v);
    } else if (g.mode === 'bright') {
      const v = Math.max(0.02, Math.min(1, g.start - dy / (r.height * 0.6)));
      post({ type: 'brightness', v });
      showGestureHint('bright', v);
    }
  }, true);

  const gestureEnd = (e) => {
    if (!g || g.id !== e.pointerId) return;
    const cur = g;
    g = null;
    if (cur.mode === 'seek') {
      if (cur.targetTime != null) commitTime(cur.targetTime);
      scheduleHide();
      if (hintEl.hidden === false) hintT = setTimeout(() => { hintEl.hidden = true; }, 400);
    } else if (cur.mode) {
      gestureEndedReleaseBrightnessHold();
      scheduleHide();
    } else {
      // never moved: a tap
      handleTap(e);
    }
  };
  area.addEventListener('pointerup', gestureEnd, true);
  area.addEventListener('pointercancel', (e) => { if (g && g.id === e.pointerId) g = null; }, true);

  function handleTap(e) {
    // the settings sheet always closes when the video surface is tapped —
    // the gear then needs a second tap to reopen (standard player behaviour)
    if (!sheet.hidden) { closeSheet(); return; }
    // centre tap = play/pause on BOTH pointer types (instant): a quick double
    // centre tap just toggles twice (net zero) instead of needing the 280ms
    // double-tap disambiguation delay. Left/right thirds keep the delay.
    const zone = tapZone(e);
    if (zone === 'center') { togglePlay(); return; } // togglePlay() shows the bar
    if (FINE) return; // desktop mouse: dblclick does the zones (below)
    const now = performance.now();
    if (now - lastTapT < 320 && zone === lastTapZone) {
      lastTapT = 0;
      if (singleT) { clearTimeout(singleT); singleT = null; }
      if (zone === 'left') seekBy(-10);
      else seekBy(10);
    } else {
      lastTapT = now;
      lastTapZone = zone;
      if (singleT) clearTimeout(singleT);
      singleT = setTimeout(() => {
        singleT = null;
        if (now === lastTapT) toggleControls();
      }, 280);
    }
  }

  // desktop: second click in left/right third = seek, centre = fullscreen
  area.addEventListener('dblclick', (e) => {
    if (!FINE || gestureBlocked(e.target) || !video || !area.contains(video)) return;
    const zone = tapZone(e);
    if (zone === 'left') commitTime(video.currentTime - 10);
    else if (zone === 'right') commitTime(video.currentTime + 10);
    else if (state.view === 'playerView') togglePvFull();
    show();
  });

  function showGestureHint(kind, v) {
    if (kind === 'vol') hint(`Volume ${Math.round(v * 100)}%`);
    else if (kind === 'bright') hint(`Brightness ${Math.round(v * 100)}%`);
  }
  // vertical drags on Android hold the brightness override — nothing needs
  // releasing while in the player; the pv:stop/exit paths put it back

  // ---------- hint HUD ----------
  let hintT = null;
  function hint(text, hold) {
    hintEl.textContent = text;
    hintEl.hidden = false;
    clearTimeout(hintT);
    if (!hold) hintT = setTimeout(() => { hintEl.hidden = true; }, 700);
  }

  // brightness release on exits (see post({type:'brightness', v:1}) contracts)
  function gestureEndedReleaseBrightnessHold() {
    post({ type: 'brightness', v: 1 });
  }

  // ================================================================
  // settings sheet
  // ================================================================
  function chipRow(label, chips, onPick) {
    const row = el('div', 'pv-row');
    const headRow = el('div', 'pv-row-label', label);
    const box = el('div', 'pv-chips');
    for (const c of chips) {
      const b = el('button', 'pv-chip', c.label);
      if (c.on) b.classList.add('on');
      b.addEventListener('click', () => { onPick(c.value); buildSheet(); });
      box.appendChild(b);
    }
    row.appendChild(headRow);
    row.appendChild(box);
    sheet.appendChild(row);
    return row;
  }

  function buildSheet() {
    sheet.replaceChildren();
    const hls = state.hls;

    // speed
    chipRow('Playback speed',
      SPEEDS.map((s) => ({ label: s === 1 ? '1×' : s + '×', value: s, on: Math.abs(video.playbackRate - s) < 0.01 })),
      (v) => setRate(v));

    // subtitles
    if (state.sources && (state.sources.subtitles || []).length) {
      const cur = activeSubIndex();
      chipRow('Subtitles', [
        { label: 'Off', value: -1, on: cur === -1 },
        ...state.sources.subtitles.map((s, i) => ({
          label: s.label || 'Track ' + (i + 1),
          value: i,
          on: cur === i,
        })),
      ], (i) => selectSub(i, true));

      const cue = prefs().pvCue || {};
      chipRow('Caption size',
        Object.keys(CUE_SIZES).map((k) => ({ label: k, value: k, on: (cue.size || 'M') === k })),
        (v) => setCue({ ...cue, size: v }));
      chipRow('Caption color',
        Object.keys(CUE_COLORS).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: k, on: (cue.color || 'white') === k })),
        (v) => setCue({ ...cue, color: v }));
      chipRow('Caption background',
        [
          { label: 'None', value: 'none', on: (cue.bg || 'dim') === 'none' },
          { label: 'Dim', value: 'dim', on: (cue.bg || 'dim') === 'dim' },
          { label: 'High', value: 'high', on: cue.bg === 'high' },
        ],
        (v) => setCue({ ...cue, bg: v }));
    }

    // audio tracks (hls.js streams with >1 audio rendition)
    if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
      chipRow('Audio track', hls.audioTracks.map((t, i) => ({
        label: t.name || t.lang || 'Track ' + (i + 1),
        value: i,
        on: hls.audioTrack === i,
      })), (i) => { hls.audioTrack = i; buildSheet(); });
    }

    // quality / server / auto-next / SUB-DUB are NOT sheet rows anymore: the
    // real controls sit in #pvChips above the control bar (relocated at init)
  }

  function setRate(v) {
    video.playbackRate = v;
    video.defaultPlaybackRate = v; // source switches / reloads keep the rate
    savePvPref('pvSpeed', v);
    $('pvSpeed').textContent = (v === 1 ? '1' : v) + '×';
  }
  function applySavedRate() {
    const saved = Number(pvPref('pvSpeed', 1));
    if (saved > 0 && Math.abs(saved - 1) > 0.01) {
      video.playbackRate = saved;
      video.defaultPlaybackRate = saved;
    }
    $('pvSpeed').textContent = (video.playbackRate === 1 ? '1' : video.playbackRate) + '×';
  }

  $('pvSpeed').addEventListener('click', openSheet);
  $('pvGear').addEventListener('click', openSheet);

  function openSheet() {
    if (sheet.hidden) {
      buildSheet();
      sheet.hidden = false;
    } else {
      sheet.hidden = true;
    }
    show();
  }
  function closeSheet() { sheet.hidden = true; }
  // the unclipped sheet covers most of the video on phones: ANY tap on it
  // (blank padding, labels) closes it — only chips keep doing their thing
  sheet.addEventListener('click', (e) => {
    if (!e.target.closest('.pv-chip')) closeSheet();
  });

  // ================================================================
  // subtitles: multi-track mounting + ::cue styling
  // ================================================================
  let subBlobs = [];
  let subTracks = [];

  function activeSubIndex() {
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].mode === 'showing') return subOrder.indexOf(i);
    }
    return -1;
  }
  // textTracks order == order of <track> elements == sources order; keep the
  // mapping explicit so track removals can't confuse the index
  let subOrder = [];

  // `save` is false on automatic mounts/auto-defaults so a fresh episode load
  // can't overwrite the user's remembered pick with an "Off"/track-0 default
  function selectSub(idx, save) {
    if (save) savePvPref('pvSub', idx);
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = subOrder.indexOf(i) === idx ? 'showing' : 'disabled';
    }
  }

  async function mountSubtitles() {
    const subs = (state.sources && state.sources.subtitles) || [];
    // clear previous tracks + their blob URLs
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    for (const b of subBlobs) URL.revokeObjectURL(b);
    subBlobs = [];
    subOrder = [];

    const fetched = await Promise.all(subs.map(async (s) => {
      if (!s.proxiedSrc) return null;
      try {
        const vtt = await (await fetch(s.proxiedSrc)).text();
        return new Blob([vtt], { type: 'text/vtt' });
      } catch { return null; } // subtitles optional
    }));

    fetched.forEach((blob, i) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      subBlobs.push(url);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = subs[i].label || 'English';
      track.srclang = 'en';
      track.src = url;
      video.appendChild(track);
      subOrder.push(subOrder.length); // index into textTracks == track count
      subTracks.push(track);
    });

    // remembered pick in-range wins; else track 0 (the stream's default);
    // -1 = captions off. Auto-default is NOT persisted (selectSub(…, false))
    // so an episode with no valid saved pick can't erase the user's choice.
    const saved = prefs().pvSub;
    const idx = saved === -1 ? -1
      : Number.isInteger(saved) && saved >= 0 && saved < subOrder.length ? saved : 0;
    selectSub(subOrder.length ? idx : -1, false);
    applyCueStyle();
  }

  // ::cue styling — literal values only (CSS variables are unreliable in a
  // WebView's ::cue); #pvCude appended to <head>, re-written per change
  const pvCue = document.createElement('style');
  pvCue.id = 'pvCue';
  document.head.appendChild(pvCue);
  function setCue(c) {
    savePvPref('pvCue', c);
    applyCueStyle();
  }
  function applyCueStyle() {
    const c = prefs().pvCue || {};
    const size = CUE_SIZES[c.size || 'M'] || CUE_SIZES.M;
    const color = CUE_COLORS[c.color || 'white'] || CUE_COLORS.white;
    const bg = c.bg === 'none' ? 'transparent' : c.bg === 'high'
      ? 'rgba(0,0,0,.85)' : 'rgba(0,0,0,.45)';
    pvCue.textContent =
      `#video::cue { font-size:${size}; color:${color}; background:${bg}; ` +
      'text-shadow: 0 1px 3px rgba(0,0,0,.9); }\n' +
      '#video::cue { font-family: inherit; }';
  }
  applyCueStyle();

  // ================================================================
  // rotate fullscreen (Android) / HTML5 fullscreen (desktop)
  // ================================================================
  let rotated = false;
  const badge = () => $('watchBadge');
  let badgeHome = badge() ? badge().parentNode : null;

  function moveBadge(toPv) {
    const b = badge();
    if (!b) return;
    if (toPv) $('pvBadgeSlot').appendChild(b);
    else $('playerBottom').appendChild(b); // original slot is the last child there
  }

  async function setPvFull(on) {
    if (rotated === on) return;
    rotated = on;
    window.__pvRotated = on;
    document.body.classList.toggle('pv-full', on);
    moveBadge(on);
    if (on) show(); else { closeSheet(); scheduleHide(); }
    if (ANDROID) {
      if (window.__inPip) return; // never rotate while the mirror is up
      post({ type: 'fullscreen', on });
      if (!on) post({ type: 'brightness', v: 1 }); // release any override
    }
  }

  function togglePvFull() {
    if (ANDROID) setPvFull(!rotated);
    else if (document.fullscreenElement) document.exitFullscreen();
    else $('playerWrap').requestFullscreen().catch(() => {});
  }
  $('pvFull').addEventListener('click', togglePvFull);
  // desktop: the HTML Fullscreen API still owns the state; keep the class in
  // step (pv-top overlay row / badge relocation)
  document.addEventListener('fullscreenchange', () => {
    setPvFull(!!document.fullscreenElement);
  });

  // native back-press inside rotated playback (MainActivity) — strip the
  // chrome locally; the native side already re-locked portrait + shown bars
  window.__pvRotateOff = function () {
    rotated = false;
    window.__pvRotated = false;
    document.body.classList.remove('pv-full');
    moveBadge(false);
    closeSheet();
    show();
  };

  // the PAGE owns the fullscreen decision; native only applies it. A page
  // boots (reload after an update swap / server hiccup) with rotation reset
  // to false while native may still hold a stale landscape lock — which
  // strands the whole app sideways outside the player. So: the shell can re-
  // ask us at any moment (__pvSync), and a fresh Android page always reports
  // its state once. In PiP the page is mid-transition — stay silent.
  window.__pvSync = function () {
    if (window.__inPip) return;
    post({ type: 'syncfull', on: rotated });
  };
  if (ANDROID) setTimeout(() => post({ type: 'syncfull', on: false }), 0);

  // ================================================================
  // pv:* hooks (fired by app.js)
  // ================================================================
  document.addEventListener('pv:source', () => {
    $('pvTitle').textContent = state.title || '';
    $('pvEp').textContent = state.epNum ? `EP ${state.epNum} (${String(state.type).toUpperCase()})` : '';
    $('pvSpeed').textContent = (video.playbackRate === 1 ? '1' : video.playbackRate) + '×';
    applySavedRate();
    mountSubtitles(); // async
    closeSheet();
    show();
  });

  document.addEventListener('pv:sync', () => { if (!sheet.hidden) buildSheet(); });

  document.addEventListener('pv:view', (e) => {
    const view = e.detail && e.detail.view;
    closeSheet();
    if (view !== 'playerView') {
      if (rotated) setPvFull(false); // any exit path unwinds the rotation
      hide();
    } else {
      show();
    }
  });

  document.addEventListener('pv:dock', () => {
    // native controls come back while the video lives in the mini bar
    video.controls = true;
    ui.hidden = true;
    shown = false;
    showSpin(false);
    pulse.style.opacity = 0; // the centre overlay is meaningless in the mini bar
    if (rotated) setPvFull(false);
  });
  document.addEventListener('pv:undock', () => { video.controls = false; });

  document.addEventListener('pv:stop', (e) => {
    closeSheet();
    ui.hidden = true;
    shown = false;
    showSpin(false);
    pulse.style.opacity = 0;
    // a real exit unwinds the rotation + releases any brightness override —
    // but a seamless swap (server change, SUB↔DUB, auto-next) marks itself
    // restarting and must keep rotated fullscreen exactly as it is
    if (!(e.detail && e.detail.restarting)) {
      if (rotated) setPvFull(false);
      post({ type: 'brightness', v: 1 });
    }
    for (const b of subBlobs) URL.revokeObjectURL(b);
    subBlobs = [];
  });
})();