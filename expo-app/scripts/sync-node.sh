#!/usr/bin/env bash
# Bundle the shared app (server.js / scraper.js / ui/ + stubs) into a single
# zip asset for the Expo app. Metro ships this zip inside the JS bundle, so
# OTA updates (expo-updates) can carry new server/ui code without a rebuild.
# Run after every change to shared code, before building the APK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../assets/nodejs-project.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/nodejs-project/ui"
cp "$ROOT/server.js" "$ROOT/scraper.js" "$STAGE/nodejs-project/"
cp "$ROOT/android/stub/index.js" "$ROOT/android/stub/updater.js" "$STAGE/nodejs-project/"
cp "$ROOT"/ui/index.html "$ROOT"/ui/style.css "$ROOT"/ui/app.js "$ROOT"/ui/hls.min.js "$STAGE/nodejs-project/ui/"

# keep the bundled version identical to the Electron app's
VER="$(grep -o '"version": *"[^"]*"' "$ROOT/package.json" | head -1 | sed 's/.*"\(.*\)"/\1/')"
sed "s/\"version\": *\"[^\"]*\"/\"version\": \"$VER\"/" "$ROOT/android/stub/package.json" > "$STAGE/nodejs-project/package.json"

rm -f "$DEST"
# Windows ships bsdtar which can write zip; plain `zip` is missing on Git Bash
TAR="$(command -v zip >/dev/null && echo zip || echo /c/Windows/System32/tar.exe)"
if [ "$TAR" = zip ]; then
  (cd "$STAGE" && zip -q -r "$DEST" nodejs-project)
else
  "$TAR" -cf "$DEST" --format zip -C "$STAGE" nodejs-project
fi
echo "synced v$VER ($(du -sh "$DEST" | cut -f1)) -> expo-app/assets/nodejs-project.zip"