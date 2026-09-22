#!/usr/bin/env bash
# Bundle the shared app (server.js / scraper.js / ui/ + stubs) into a single
# zip asset for the Expo app. Metro ships this zip inside the JS bundle, so
# OTA updates (expo-updates) can carry new server/ui code without a rebuild.
# Run after every change to shared code, before building the APK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/desktop"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../assets/nodejs-project.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/nodejs-project/ui"
cp "$APP/server.js" "$APP/cloud.js" "$APP/scraper.js" "$STAGE/nodejs-project/"
cp "$HERE/../node-stub/index.js" "$HERE/../node-stub/updater.js" "$STAGE/nodejs-project/"
cp "$APP"/ui/index.html "$APP"/ui/style.css "$APP"/ui/app.js "$APP"/ui/hls.min.js "$APP"/ui/empty.png "$APP"/ui/logo.png "$APP"/ui/logo-nav.png "$APP"/ui/logo-t.png "$STAGE/nodejs-project/ui/"

# keep the bundled version identical to the Electron app's
VER="$(grep -o '"version": *"[^"]*"' "$APP/package.json" | head -1 | sed 's/.*"\(.*\)"/\1/')"
sed "s/\"version\": *\"[^\"]*\"/\"version\": \"$VER\"/" "$HERE/../node-stub/package.json" > "$STAGE/nodejs-project/package.json"

rm -f "$DEST"
# Windows ships bsdtar which can write zip; plain `zip` is missing on Git Bash
TAR="$(command -v zip >/dev/null && echo zip || echo /c/Windows/System32/tar.exe)"
if [ "$TAR" = zip ]; then
  (cd "$STAGE" && zip -q -r "$DEST" nodejs-project)
else
  "$TAR" -cf "$DEST" --format zip -C "$STAGE" nodejs-project
fi
# release APKs read the zip as a raw android asset (the Kotlin side copies it
# out itself — expo-asset's cache never revalidates across app updates)
mkdir -p "$HERE/../android/app/src/main/assets"
cp "$DEST" "$HERE/../android/app/src/main/assets/nodejs-project.zip"

echo "synced v$VER ($(du -sh "$DEST" | cut -f1)) -> expo-app/assets/nodejs-project.zip"