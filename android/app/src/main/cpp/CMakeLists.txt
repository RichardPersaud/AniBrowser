cmake_minimum_required(VERSION 3.22)
project(anibrowser CXX)

add_library(anibrowser SHARED ${CMAKE_SOURCE_DIR}/native-lib.cpp)

include_directories(${CMAKE_SOURCE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(anibrowser libnode ${log-lib})