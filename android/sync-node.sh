#!/usr/bin/env bash
# Copy the shared app (server.js / scraper.js / ui/) plus Android stubs into the
# APK's node assets. Run after every change to shared code, before gradle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/android/app/src/main/assets/nodejs-project"
STUB="$ROOT/android/stub"

rm -rf "$DEST"
mkdir -p "$DEST/ui"
cp "$ROOT/server.js" "$ROOT/scraper.js" "$DEST/"
cp "$STUB/index.js" "$STUB/updater.js" "$STUB/package.json" "$DEST/"
cp "$ROOT"/ui/index.html "$ROOT"/ui/style.css "$ROOT"/ui/app.js "$ROOT"/ui/hls.min.js "$DEST/ui/"

# keep the bundled version identical to the Electron app's
VER="$(grep -o '"version": *"[^"]*"' "$ROOT/package.json" | head -1 | sed 's/.*"\(.*\)"/\1/')"
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$VER\"/" "$DEST/package.json"

echo "synced $(du -sh "$DEST" | cut -f1) -> ${DEST#$ROOT/}"