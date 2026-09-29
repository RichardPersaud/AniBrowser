#!/usr/bin/env bash
# Replace jniLibs/libnode.so with the 16 KB-aligned Node build from the
# gmaclennan/nodejs-mobile fork (Node v24.18.0, NDK r27d, 16 KB page-size
# support, verified on 16 KB arm64 hardware). Needed for Google Play's 16 KB
# rule: the official nodejs-mobile v18.20.4 release (what we used before) is
# still 4 KB-aligned and has no fixed release yet (nodejs-mobile#161).
#
# The shim's single import is `node::Start(int, char**)` — exported unchanged
# by v24, so libanibrowser.so is drop-in compatible (rebuild it afterwards
# with scripts/build-shim.sh for its own 16 KB alignment).
#
# libc++_shared.so is refreshed from the installed NDK (r27+) — newer than
# anything that links against it, and 16 KB-aligned for the 64-bit ABIs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../modules/anibrowser-node/android/src/main/jniLibs"
NDK="${NDK:-$LOCALAPPDATA/Android/Sdk/ndk/27.1.12297006}"
VER="24.18.0-0"
URL="https://github.com/gmaclennan/nodejs-mobile/releases/download/v${VER}/nodejs-mobile-android-${VER}.zip"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/node.zip" "$URL"
unzip -q "$TMP/node.zip" -d "$TMP/x"

for abi in arm64-v8a armeabi-v7a x86_64; do
  case $abi in
    arm64-v8a) dir=aarch64-linux-android;;
    x86_64) dir=x86_64-linux-android;;
    armeabi-v7a) dir=arm-linux-androideabi;;
  esac
  mkdir -p "$DEST/$abi"
  cp "$TMP/x/bin/$abi/libnode.so" "$DEST/$abi/libnode.so"
  cp "$NDK/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib/$dir/libc++_shared.so" \
     "$DEST/$abi/libc++_shared.so"
  du -sh "$DEST/$abi/libnode.so"
done