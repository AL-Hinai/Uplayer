cmake_minimum_required(VERSION 3.22.1)
project("uplayer")

# nodejs-mobile release headers — unpack the release's `include/node` here:
#   app/src/main/cpp/nodejs-mobile/include/node/{node.h, ...}
# (See BUILD.md, step "nodejs-mobile runtime".)
set(NODEJS_MOBILE_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/nodejs-mobile/include/node")

# Prebuilt libnode.so for this ABI, packaged from app/src/main/jniLibs/<abi>/libnode.so
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
        "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(native-lib SHARED native-lib.cpp)

target_include_directories(native-lib PRIVATE ${NODEJS_MOBILE_INCLUDE})

find_library(log-lib log)
target_link_libraries(native-lib node android ${log-lib})
