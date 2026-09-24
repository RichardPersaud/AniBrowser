import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Image,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as WebBrowser from 'expo-web-browser';
import * as ScreenOrientation from 'expo-screen-orientation';
import { File, Paths } from 'expo-file-system';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AdEventType,
  MobileAds,
  RewardedAd,
  RewardedAdEventType,
} from 'react-native-google-mobile-ads';
import { REWARDED_AD_UNIT_ID, TEST_REWARDED_AD_UNIT_ID } from './ads';
import AniBrowserNode from './modules/anibrowser-node';

// single zip asset containing the whole node runtime (server + scraper + ui)
const PROJECT_ZIP = require('./assets/nodejs-project.zip');

type Phase = 'boot' | 'ready' | 'error';

// tells the shell whether a <video> is actively playing — the shell forwards
// it to the native side so leaving the app docks into picture-in-picture
const VIDEO_WATCHER_JS = `
(function() {
  var v = document.getElementById('video');
  if (!v) return;
  var last = false;
  function tick() {
    var a = !!(v.src || v.currentSrc) && !v.paused && !v.ended && v.readyState >= 2;
    if (a !== last) {
      last = a;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'videoActive', active: a }));
    }
  }
  ['play', 'pause', 'ended', 'emptied', 'waiting', 'playing'].forEach(function(ev) {
    v.addEventListener(ev, tick);
  });
  setInterval(tick, 1000);
  // Chromium briefly reports the page hidden during the background/PiP
  // transition, which pauses the video without resuming it afterwards —
  // remember what was playing and restart it when the page is visible again
  var resumeOnVisible = false;
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      resumeOnVisible = !v.paused && !v.ended;
    } else if (resumeOnVisible) {
      resumeOnVisible = false;
      v.play().catch(function() {});
    }
  });
})();
true;
`;

// the node updater hands APK installs over as anibrowser-install://apk?path=…
// links; the WebView can't open them, so intercept and call the native installer
const INSTALL_SCHEME = 'anibrowser-install://';

// shell → web messaging: the WebView ref's postMessage() dispatches on
// `document` (Android legacy channel) which the page's
// `window.addEventListener('message')` never sees — inject a real MessageEvent
// on `window` instead. The payload must arrive as a JSON STRING: the page's
// handler string-parses it like every other bridge message.
function webPostMessage(web: WebView | null, payload: object) {
  const json = JSON.stringify(JSON.stringify(payload));
  web?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message', {data: ${json}})); true;`);
}

async function bootNode(): Promise<number> {
  const dataDir = Paths.document.uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
  if (!dataDir || !dataDir.startsWith('/')) throw new Error('no document directory');

  const asset = Asset.fromModule(PROJECT_ZIP);
  const local = asset.localUri ?? asset.uri;
  let zipPath: string;
  if (local.startsWith('http')) {
    // dev (Metro): expo-asset's cache never revalidates, so edited UI/server
    // files would never reach the app — download fresh over HTTP instead.
    // Metro occasionally queues the asset request behind a bundle build and
    // the native socket times out, so give it a few chances before failing.
    const dest = new File(Paths.cache, 'nodejs-project.zip');
    // untouched fallback copy — used when Metro's asset endpoint queues the
    // request behind a bundle build and outruns the native socket timeout
    const keep = new File(Paths.cache, 'nodejs-project.last.zip');
    let zipUri: string | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < 4 && !zipUri; i++) {
      try {
        if (dest.exists) dest.delete();
        const out = await File.downloadFileAsync(local, dest);
        zipUri = out.uri;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!zipUri && keep.exists) zipUri = keep.uri;
    if (!zipUri) throw lastErr;
    zipPath = zipUri.replace(/^file:\/\//, '');
  } else {
    // release: the zip ships as a raw android asset (android/app/src/main/assets,
    // kept in sync by scripts/sync-node.sh). expo-asset's on-device cache never
    // revalidates across app updates — after the v1.1.2 upgrade it kept serving
    // the previous release's zip, so the app ran the old server forever — so
    // bypass it: the Kotlin side copies the asset fresh and CRC-stamps it
    zipPath = 'asset:nodejs-project.zip';
  }
  return AniBrowserNode.startNode(zipPath, dataDir);
}

function Shell() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [port, setPort] = useState<number | null>(null);
  const [errMsg, setErrMsg] = useState('');
  // cover the WebView with the boot splash until the web UI says it's ready —
  // otherwise the user sees the logo/wheel twice: shell splash, then the UI's
  const [covered, setCovered] = useState(true);
  const webRef = useRef<WebView>(null);
  const canGoBack = useRef(false);

  const boot = useCallback(() => {
    setPhase('boot');
    setCovered(true);
    bootNode()
      .then((p) => {
        setPort(p);
        setPhase('ready');
      })
      .catch((e) => {
        setErrMsg(String(e?.message ?? e));
        setPhase('error');
      });
  }, []);

  useEffect(() => { boot(); }, [boot]);

  // ---- AdMob rewarded ads ----
  // The web UI's "+45 minutes" button asks via {type:'showAd'}; this loads a
  // rewarded ad, shows it fullscreen, and reports the outcome back:
  //   {type:'adReward', ok:true}  — the reward was earned
  //   {type:'adReward', ok:false} — dismissed early / failed (error field set)
  // The ad object is single-use, so a fresh one is built per request; only
  // one ad round-trip may be in flight at a time.
  const adBusy = useRef(false);
  const showRewardedAd = useCallback((seq?: number) => {
    const web = webRef.current;
    if (!web) return;
    // a round-trip is already in flight — answer immediately so the web UI's
    // button doesn't sit on "Loading ad…" forever waiting for a reply
    if (adBusy.current) {
      webPostMessage(web, { type: 'adReward', ok: false, error: 'busy', seq });
      return;
    }
    adBusy.current = true;
    let earned = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      adBusy.current = false;
      if (timer) clearTimeout(timer);
      webPostMessage(web, { type: 'adReward', ok, error, seq });
    };
    // load() has no timeout of its own and can fail silently (no network,
    // blocked hosts) — without this the UI would sit on "Loading ad…" forever
    timer = setTimeout(
      () => settle(false, 'Timed out waiting for the ad to load'),
      20000
    );
    // the production unit can stay unfilled for a while (brand-new unit /
    // app not yet reviewed by AdMob) — when it can't load, retry once with
    // Google's always-fills test unit so the refill flow keeps working
    const attempt = (unitId: string) => {
      const ad = RewardedAd.createForAdRequest(unitId, {
        requestNonPersonalizedAdsOnly: true,
      });
      ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
        ad.show().catch((e) => settle(false, String(e?.message ?? e)));
      });
      ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
        earned = true;
      });
      ad.addAdEventListener(AdEventType.CLOSED, () => settle(earned));
      const failover = (e: unknown) => {
        const msg = String((e as Error)?.message ?? e);
        if (unitId === TEST_REWARDED_AD_UNIT_ID) settle(false, msg);
        else attempt(TEST_REWARDED_AD_UNIT_ID);
      };
      ad.addAdEventListener(AdEventType.ERROR, failover);
      // load() is fire-and-forget void in this SDK version — a failed load
      // arrives via the ERROR event above, NOT as a rejected promise
      ad.load();
    };
    attempt(REWARDED_AD_UNIT_ID);
  }, []);

  // the Google Mobile Ads SDK needs one init before the first ad request —
  // fire-and-forget at shell boot so the first "+45 minutes" tap is instant
  // (initialize() is typed void but returns a promise at runtime)
  useEffect(() => {
    (MobileAds().initialize() as unknown as Promise<void>).catch(() => {});
  }, []);

  // failsafe: if the UI never reports ready (stuck network, TOS edge case),
  // drop the cover anyway so the user is never trapped behind it
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setTimeout(() => setCovered(false), 15000);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const w = webRef.current;
      if (w && canGoBack.current) {
        w.goBack();
        return true;
      }
      AniBrowserNode.moveTaskToBack(); // keep node + playback alive
      return true;
    });
    return () => sub.remove();
  }, []);

  // the app is always portrait — flipping the phone never rotates the UI
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
      () => {}
    );
  }, []);

  // backgrounding with the video docked in the mini player: move it back into
  // the full player with the chrome stripped (body.pip-full) so the shell's
  // picture-in-picture window (a live mirror of the activity surface) shows
  // only the video — undo the stripping when the app is back in the foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') {
        webRef.current?.injectJavaScript(
          'window.__pipRestore && window.__pipRestore(); true;'
        );
      } else if (s === 'active') {
        webRef.current?.injectJavaScript(
          "document.body.classList.remove('pip-full'); true;"
        );
      }
    });
    return () => sub.remove();
  }, []);

  // edge-to-edge is enforced on Android 15+: StatusBar.currentHeight reads 0,
  // so take the real inset from safe-area-context
  const insets = useSafeAreaInsets();

  if (phase === 'ready' && port != null) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor="#0b0e14" />
        {/* the app draws edge-to-edge; keep the web UI below the status bar */}
        <View style={{ height: insets.top, backgroundColor: '#0b0e14' }} />
        {/* alignSelf:stretch is load-bearing — root centers children, and a bare
            View wrapping the WebView has no intrinsic width, so it (and the
            WebView) would collapse to width 0 = black screen */}
        <View style={{ flex: 1, alignSelf: 'stretch' }}>
        <WebView
          ref={webRef}
          source={{ uri: `http://127.0.0.1:${port}/` }}
          style={styles.web}
          containerStyle={styles.web}
          backgroundColor="#0b0e14"
          javaScriptEnabled
          domStorageEnabled
          // CDP inspection of the web UI (chrome://inspect / adb forward) —
          // no-op outside dev builds where the app isn't debuggable anyway
          webContentsDebuggingEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          setSupportMultipleWindows={false}
          // the default whitelist is http/https only — without the install
          // scheme here, react-native-webview never routes those navigations
          // to onShouldStartLoadWithRequest (it Linking.openURLs them instead,
          // which fails: nothing registers the scheme)
          originWhitelist={['http://*', 'https://*', 'anibrowser-install://*']}
          mixedContentMode="never"
          cacheEnabled={false}
          // without this Chromium lays out at a stale "device width" (485css on a
          // 426.67css screen), zoom-shrinking the whole UI ~12% and clipping the navbar
          useWideViewPort={false}
          onNavigationStateChange={(s) => {
            canGoBack.current = s.canGoBack;
          }}
          injectedJavaScript={VIDEO_WATCHER_JS}
          onMessage={({ nativeEvent }) => {
            try {
              const msg = JSON.parse(nativeEvent.data);
              if (msg.type === 'videoActive') {
                // only forwarded for PiP docking — the sensor never touches the
                // app UI, and the app UI never rotates
                AniBrowserNode.setVideoActive(!!msg.active);
              } else if (msg.type === 'enterPip') {
                // sidebar tap while a video is playing — dock it into
                // picture-in-picture instead of leaving the player
                AniBrowserNode.enterPip();
              } else if (msg.type === 'bootDone') {
                setCovered(false);
              } else if (msg.type === 'notify') {
                // favorites update → system notification (POST_NOTIFICATIONS is
                // requested by the module on the first call)
                AniBrowserNode.notify(String(msg.title ?? ''), String(msg.body ?? ''));
              } else if (msg.type === 'openUpdatesDir') {
                // "Open folder" on the update row — the APK lives in the app's
                // private files dir, so copy it into public Downloads and open
                // the system Downloads list where the user can actually see it
                AniBrowserNode.openUpdatesDir(String(msg.path ?? '')).catch((e) => {
                  console.log('[shell] open updates dir failed', e);
                  webPostMessage(webRef.current, { type: 'shellToast', text: 'Could not open updates folder', error: true });
                });
              } else if (msg.type === 'showAd') {
                // rewarded ad round-trip for the watch-up overlay's refill
                // button — outcome comes back as an 'adReward' message
                showRewardedAd(typeof msg.seq === 'number' ? msg.seq : undefined);
              } else if (msg.type === 'openExternal') {
                // cloud sign-in: Google OAuth (and its loopback callback) must
                // run outside this WebView — Google rejects OAuth in embedded
                // WebViews, so use a Custom Tab: an in-app browser surface
                // with the app's own toolbar, no app switch to Chrome proper
                WebBrowser.openBrowserAsync(String(msg.url ?? ''))
                  .catch(() => {})
                  .then(() => {
                    // the tab was dismissed (sign-in done or abandoned) —
                    // refresh the app's sync state without waiting for the poll
                    webRef.current?.injectJavaScript(
                      'if (typeof pollSync === "function") pollSync(); true;'
                    );
                  });
              }
            } catch {
              // non-JSON bridge message — ignore
            }
          }}
          onShouldStartLoadWithRequest={(req) => {
            if (req.url.startsWith(INSTALL_SCHEME)) {
              // the WebView may normalize the URL (empty authority -> extra
              // slash, re-encoded query), so slice a fixed prefix off — pull
              // the path param out instead
              const m = /[?&]path=([^&]+)/.exec(req.url);
              const apkPath = m ? decodeURIComponent(m[1]) : '';
              AniBrowserNode.installApk(apkPath).catch((e) => {
                console.log('[shell] install failed', e);
                // surface it in the UI — console.log is invisible to the user
                webPostMessage(webRef.current, { type: 'installError', error: String(e?.message ?? e) });
              });
              return false;
            }
            return true;
          }}
          onError={({ nativeEvent }) => {
            console.log('[shell] webview error', nativeEvent.description);
            setErrMsg(nativeEvent.description);
            setPhase('error');
          }}
        />
        {covered && (
          <View style={styles.cover}>
            <Image source={require('./assets/splash-icon.png')} style={styles.bootLogo} />
            <ActivityIndicator color="#25b8a0" style={styles.spinner} />
          </View>
        )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0e14" />
      {phase === 'boot' ? (
        <>
          <Image source={require('./assets/splash-icon.png')} style={styles.bootLogo} />
          <ActivityIndicator color="#25b8a0" style={styles.spinner} />
        </>
      ) : (
        <>
          <Text style={styles.errTitle}>Backend failed to start</Text>
          <Text style={styles.errMsg}>{errMsg}</Text>
          <TouchableOpacity style={styles.retry} onPress={boot}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0e14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // alignSelf:stretch is load-bearing — root centers children (alignItems:'center'),
  // and a WebView has no intrinsic width, so without it it collapses to width 0
  web: { flex: 1, alignSelf: 'stretch', backgroundColor: '#0b0e14' },
  brand: { fontSize: 34, fontWeight: '800', color: '#e8eaf0', letterSpacing: -0.5 },
  brandAccent: { color: '#25b8a0' },
  bootLogo: { width: 220, height: 220, marginBottom: 4 },
  cover: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#0b0e14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: { margin: 16 },
  hint: { fontSize: 12, color: '#5c6470' },
  errTitle: { fontSize: 18, fontWeight: '700', color: '#e8eaf0' },
  errMsg: { fontSize: 13, color: '#8a92a0', margin: 16, textAlign: 'center', paddingHorizontal: 24 },
  retry: {
    borderWidth: 1,
    borderColor: '#25b8a0',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { color: '#25b8a0', fontWeight: '600' },
});