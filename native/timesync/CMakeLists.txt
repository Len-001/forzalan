# =============================================================================
#  ForzaTimeSynchronizer —— 双端构建（Linux 原生 / Emscripten Wasm）
#
#   原生 + 跑单测：
#       cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#       cmake --build build && ./build/ts_test
#
#   Emscripten（浏览器）：
#       emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release
#       cmake --build build-wasm
#       # 然后 node build-wasm/ts_test.js 即可看到断言输出
# =============================================================================
cmake_minimum_required(VERSION 3.16)
project(forza_time_sync CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(forza_time_sync STATIC forza_time_sync.cpp)
target_include_directories(forza_time_sync PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(forza_time_sync PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(ts_test forza_time_sync_test.cpp)
target_link_libraries(ts_test PRIVATE forza_time_sync)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(ts_test PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Linux 需要 -lrt 才能用 CLOCK_MONOTONIC_RAW（glibc < 2.17）
if(NOT EMSCRIPTEN AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_libraries(forza_time_sync PUBLIC rt)
endif()

# Emscripten：让单测直接在 node 里可跑
if(EMSCRIPTEN)
  set_target_properties(ts_test PROPERTIES LINK_FLAGS "-s WASM=1 -s EXIT_RUNTIME=1")
endif()

enable_testing()
add_test(NAME time_sync COMMAND ts_test)
