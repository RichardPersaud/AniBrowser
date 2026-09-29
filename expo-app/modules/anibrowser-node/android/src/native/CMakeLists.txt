# Builds the JNI shim (libanibrowser.so) against the vendored libnode.so.
# Invoked per-ABI by scripts/build-shim.sh — NOT part of the gradle build
# (the module stays prebuilt-only so no NDK/CMake is needed to build the app).
# Output lands in jniLibs/<abi>/libanibrowser.so.
cmake_minimum_required(VERSION 3.22)
project(anibrowser CXX)

# Node 24's public headers (v8 cppgc) use C++20 concepts/requires
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(anibrowser SHARED ${CMAKE_SOURCE_DIR}/native-lib.cpp)

include_directories(${CMAKE_SOURCE_DIR}/include-node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${LIBNODE_PATH})

find_library(log-lib log)
target_link_libraries(anibrowser libnode ${log-lib})

# Belt and braces: NDK r27+ aligns by default, but pin it explicitly so the
# output always satisfies Google Play's 16 KB page-size requirement.
target_link_options(anibrowser PRIVATE "-Wl,-z,max-page-size=16384")