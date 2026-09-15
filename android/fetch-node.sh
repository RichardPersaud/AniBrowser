#!/usr/bin/env bash
# Download libnode.so (per ABI) + node headers from the nodejs-mobile release.
# Outputs are gitignored — never commit the ~60MB/ABI shared library.
set -euo pipefail
VER="v18.20.4"
ZIP="nodejs-mobile-${VER}-android.zip"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VER}/${ZIP}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fL --retry 3 -o "$TMP/$ZIP" "$URL"
unzip -q "$TMP/$ZIP" -d "$TMP/x"
for abi in arm64-v8a armeabi-v7a x86_64; do
  mkdir -p "$HERE/app/src/main/jniLibs/$abi"
  cp "$TMP/x/bin/$abi/libnode.so" "$HERE/app/src/main/jniLibs/$abi/libnode.so"
done
rm -rf "$HERE/app/src/main/cpp/include"
mkdir -p "$HERE/app/src/main/cpp/include"
cp -r "$TMP/x/include/node" "$HERE/app/src/main/cpp/include/node"
du -sh "$HERE"/app/src/main/jniLibs/*/*