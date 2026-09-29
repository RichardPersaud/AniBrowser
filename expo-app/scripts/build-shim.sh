#!/usr/bin/env bash
# Build libanibrowser.so (the JNI shim) with the installed NDK — required for
# Google Play's 16 KB page-size rule (NDK r27+ emits 16 KB-aligned ELFs; the
# old prebuilt shim from the v1.2.x APKs is 4 KB-aligned).
#
# Sources: modules/anibrowser-node/android/src/native/{native-lib.cpp,
# CMakeLists.txt, include-node/} (native-lib.cpp restored from git 73a15ce;
# headers vendored from the gmaclennan nodejs-mobile v24.18.0-0 release that
# also supplies the aligned libnode.so — see scripts/fetch-node24.sh).
#
# Run after any change to native-lib.cpp. Gradle is not involved.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../modules/anibrowser-node/android/src/native"
OUT="$HERE/../modules/anibrowser-node/android/src/main/jniLibs"
NDK="${NDK:-$LOCALAPPDATA/Android/Sdk/ndk/27.1.12297006}"
NDK="$(cygpath -u "$NDK" 2>/dev/null || echo "$NDK")"
TOOLCHAIN="$NDK/build/cmake/android.toolchain.cmake"

[ -f "$TOOLCHAIN" ] || { echo "NDK not found at $NDK (set NDK=...)" >&2; exit 1; }
cmake --version >/dev/null 2>&1 || { echo "cmake not on PATH" >&2; exit 1; }

for abi in arm64-v8a armeabi-v7a x86_64; do
  BUILD="$HERE/../modules/anibrowser-node/android/build/shim/$abi"
  cmake -S "$SRC" -B "$BUILD" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-24 \
    -DCMAKE_BUILD_TYPE=Release -DANDROID_STL=c++_shared \
    -DLIBNODE_PATH="$OUT/$abi/libnode.so" \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$BUILD" \
    -DCMAKE_LIBRARY_OUTPUT_DIRECTORY="$BUILD" >/dev/null
  cmake --build "$BUILD" >/dev/null
  mkdir -p "$OUT/$abi"
  cp "$BUILD/libanibrowser.so" "$OUT/$abi/libanibrowser.so"
  echo "built $abi/libanibrowser.so"
done