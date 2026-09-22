# AniNinja for Android (Expo)

React Native shell for the same app as the desktop build (`../desktop`). The
Node.js server (`server.js` + `scraper.js`) runs embedded via **nodejs-mobile**
and the existing vanilla-JS `ui/` is loaded in a `WebView` — the shared source
files are unchanged. The Expo shell replaces an older hand-rolled Kotlin
WebView shell (same `applicationId`, so it installs over it and keeps watch
progress).

```
desktop (Electron)                    Expo / Android
----------------                      ---------------------------------
main.js                               App.tsx (shell) + modules/anibrowser-node
  electron BrowserWindow                react-native-webview -> http://127.0.0.1:port
updater.js (electron-updater)         stub/updater.js -> {disabled:true}
```

The shared code (`desktop/server.js`, `desktop/scraper.js`, `desktop/cloud.js`,
`desktop/ui/*`) is zipped into `assets/nodejs-project.zip` by
`scripts/sync-node.sh` — run it after every change to the shared code.

## Why prebuilt native libs

The JNI shim (`libanibrowser.so`) and nodejs-mobile's `libnode.so` ship
**prebuilt**, extracted from a released APK by `scripts/fetch-libs.sh` — no
NDK/CMake needed on the build machine (the shim's C++ source predates the
Expo migration and lives only in release history). Re-run extraction only
when the shim itself changes.

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

## Release build

The APK is built from `expo-app/android` (not the repo root):

```
# 1. bump the version in three places:
#      desktop/package.json               -> "version"
#      expo-app/app.json                  -> expo.version + android.versionCode (increment)
#      expo-app/android/app/build.gradle  -> versionCode + versionName (hardcoded)
# 2. re-zip the web assets (ui/, server.js, scraper.js changed? always run):
bash scripts/sync-node.sh
# 3. build (needs local.properties with sdk.dir, and the release keystore
#    configured via android/app/keystore.properties — both gitignored):
cd android && ./gradlew assembleRelease
# 4. verify the embedded zip isn't stale before shipping:
unzip -l app/build/outputs/apk/release/app-release.apk | grep .zip
```

Gradle `splits.abi` produces per-ABI APKs (arm64 ≈73MB vs 210MB universal);
emulators must install the **universal** APK (an arm64-only split "installs"
on x86_64 emulators but crashes at launch). The updater picks the split by
`os.arch()` and falls back to `universal`.

Signing: releases are signed with the keystore in `~/.anibrowser-keys`
(referenced by `android/app/keystore.properties`, gitignored — never commit
or lose it; losing it means every install must uninstall first).

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