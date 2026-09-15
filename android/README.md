# AniBrowser for Android

The same app as the desktop build, running on Android: an embedded Node.js
runtime (`nodejs-mobile` v18.20.4) executes the unmodified `server.js` +
`scraper.js`, and a `WebView` loads the unmodified `ui/` from that server at
`http://127.0.0.1:<port>/`. No shared source file is changed for Android —
the only Android-specific code lives in this directory.

```
desktop (Electron)                      Android
--------------                          ---------------------------------
main.js                                 stub/index.js (crash suppressors +
  app.getPath(...) dataDir              registerNodeDataDirPath -> filesDir/AniBrowser)
  electron BrowserWindow                MainActivity.kt (WebView -> http://127.0.0.1:port)
updater.js (electron-updater)           stub/updater.js -> {disabled:true}
```

## Build

Requirements (all user-local on the build machine, see `~/toolchain/env.sh`):
JDK 17, Android SDK platform 34 + build-tools 34.0.0 + NDK 27.1.12297006 +
CMake 3.22.1, Gradle 8.9.

```
./sync-node.sh                 # copy server.js/scraper.js/ui/ + stubs -> assets/nodejs-project
./fetch-node.sh                # download libnode.so per ABI + node headers (gitignored)
./gradlew assembleDebug        # fastest first build
./gradlew assembleRelease      # signed APK -> app/build/outputs/apk/release/
```

Signing: `app/keystore.properties` (gitignored) points at a keystore created
once with `keytool -genkeypair`. Install the release APK by copying it to the
device and tapping it (allow unknown sources).

## Layout

- `stub/` — Android-only node modules: entry point (`index.js`), updater stub,
  `package.json` (server.js reads its `version`).
- `app/src/main/cpp/native-lib.cpp` — JNI shim booting the vendored `libnode.so`
  (original code; redirects node stdout/stderr to logcat).
- `MainActivity.kt` — asset extraction, node thread, port-file handshake
  (`files/anibrowser-port.json`, atomic rename), WebView config, fullscreen
  video via `WebChromeClient` custom views, back-button handling.
- `sync-node.sh` / `fetch-node.sh` — bundle + runtime fetch scripts.

## Testing on a machine

`./test-bundle.sh` runs the exact `nodejs-project` bundle on the host with a
temp HOME and checks the port handoff, `/api/version`, `/api/update`,
the static UI and a live search.

## Known limitations

- No foreground service: Android may kill backgrounded playback after a few
  minutes (audio keeps playing short-term; foregrounding restores the UI).
- `127.0.0.1` on Android is shared between apps (any app could connect to the
  local server). Acceptable for personal use; a shared-secret header check
  would need a small server.js change.
- `libnode.so` is 4 KB-aligned: devices shipping with 16 KB page sizes
  (newest Android 15/16 hardware) cannot load it until nodejs-mobile rebuilds.
- Auto-update is disabled on Android — sideload a new APK manually.
- The desktop keyboard shortcuts (space/arrows/F/N) don't apply; fullscreen is
  available via the native video controls or a double-tap on the player.