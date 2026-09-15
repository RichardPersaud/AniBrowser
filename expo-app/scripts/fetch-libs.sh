#!/usr/bin/env bash
# Extract the prebuilt native libraries from the released APK into this
# module's jniLibs. The JNI shim (libanibrowser.so, built from
# android/app/src/main/cpp/native-lib.cpp) plus nodejs-mobile's libnode.so and
# libc++_shared.so ship prebuilt, so no NDK/CMake is needed to build the Expo
# app. Re-run whenever the native shim changes (then rebuild the source APK).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-$HERE/../../android/AniBrowser-android.apk}"
DEST="$HERE/../modules/anibrowser-node/android/src/main/jniLibs"

[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q -o "$APK" "lib/*/libnode.so" "lib/*/libanibrowser.so" "lib/*/libc++_shared.so" -d "$DEST/tmp"
mv "$DEST"/tmp/lib/* "$DEST/"
rm -rf "$DEST/tmp"
du -sh "$DEST"/*/ | sed 's|.*/jniLibs/|jniLibs/|'