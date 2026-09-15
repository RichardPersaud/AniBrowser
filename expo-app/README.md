# AniBrowser for Android (Expo)

React Native shell for the same app as the desktop build. The Node.js server
(`server.js` + `scraper.js`) runs embedded via **nodejs-mobile** and the
existing vanilla-JS `ui/` is loaded in a `WebView` — the shared source files
are unchanged. This replaces the older hand-rolled Kotlin shell in `../android/`
(same `applicationId`, so it installs over it and keeps watch progress).

```
desktop (Electron)                    Expo / Android
----------------                      ---------------------------------
main.js                               App.tsx (shell) + modules/anibrowser-node
  electron BrowserWindow                react-native-webview -> http://127.0.0.1:port
updater.js (electron-updater)         stub/updater.js -> {disabled:true}
```

## Why prebuilt native libs

The JNI shim (`libanibrowser.so`, source: `../android/app/src/main/cpp/native-lib.cpp`)
and nodejs-mobile's `libnode.so` ship **prebuilt**, extracted from the released
APK — no NDK/CMake needed on the build machine. Re-run extraction only when the
shim itself changes.

## Dev loop (no APK reinstalls)

```
bash scripts/sync-node.sh       # shared code -> assets/nodejs-project.zip
bash scripts/fetch-libs.sh      # APK -> jniLibs (only when native libs change)
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleDebug   # first build only / native changes
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

After that, iteration needs **no reinstall**:

- **ui/ edits**: run `bash scripts/sync-node.sh`, then reload the app JS
  (dev menu / `r` in `npx expo start` if using Metro) — the zip re-extracts and
  the running server serves the new files. Node itself keeps running.
- **server.js / scraper.js edits**: sync the zip, kill + relaunch the app —
  node restarts from the freshly extracted files.
- **native/Kotlin changes**: the only case that needs a rebuild.

Metro serves the zip from the dev machine, so even the `sync` step is picked
up by a simple JS reload — nothing touches the installed APK.

## OTA updates (optional, later)

The node runtime rides inside the Metro bundle as one zip asset, so
**expo-updates** can push new server/ui code over the air once configured:

```
npm install expo-updates
eas init        # free Expo account; writes the updates URL into app.json
eas update      # publishes the new bundle+zip; the app picks it up on next launch
```

Native/Kotlin changes always require a new APK.

## Known limitations (carried over from the old shell)

- No foreground service: Android may kill backgrounded playback after a few
  minutes.
- `libnode.so` is 4 KB-aligned: devices with 16 KB page sizes can't load it
  until nodejs-mobile rebuilds.
- Auto-update disabled: the Electron updater is stubbed; sideload APKs (or
  enable expo-updates as above).