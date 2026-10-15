# =============================================================================
#  NetworkRigidBodyReplicator —— 头文件库 + 单测
#
#   原生：cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#         cmake --build build && ./build/rb_test
#   Wasm：emcmake cmake -S . -B build-wasm && cmake --build build-wasm
#
#   GLM 依赖：仅头文件库。三选一：
#     · 系统包   apt install libglm-dev        （多数 Linux 发行版）
#     · vcpkg    vcpkg install glm
#     · 直接克隆 https://github.com/g-truc/glm 并把根目录塞进 GLM_INCLUDE_DIR
# =============================================================================
cmake_minimum_required(VERSION 3.16)
project(rb_replicator CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(GLM_INCLUDE_DIR "" CACHE PATH "GLM 根目录（留空则由 find_package 查找）")

add_executable(rb_test rigid_body_replicator_test.cpp)
target_include_directories(rb_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

if(GLM_INCLUDE_DIR)
  target_include_directories(rb_test PRIVATE ${GLM_INCLUDE_DIR})
else()
  find_package(glm QUIET)
  if(TARGET glm::glm)
    target_link_libraries(rb_test PRIVATE glm::glm)
  endif()
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(rb_test PRIVATE -Wall -Wextra -Wpedantic)
endif()

# 跨线程 seqlock 压测需要 pthread
find_package(Threads REQUIRED)
target_link_libraries(rb_test PRIVATE Threads::Threads)

if(EMSCRIPTEN)
  # Wasm 下 std::thread 需要 pthread 支持；不带 -pthread 时该测试会被跳过，
  # 其余断言照常运行。
  set_target_properties(rb_test PROPERTIES LINK_FLAGS "-s WASM=1 -s EXIT_RUNTIME=1 -pthread")
endif()

enable_testing()
add_test(NAME rigid_body_replicator COMMAND rb_test)
