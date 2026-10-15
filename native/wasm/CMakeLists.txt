# =============================================================================
#  Wasm 网络宿主模块（Emscripten / C++20）
#
#   构建：
#     emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release \
#                   -DGLM_INCLUDE_DIR=/e/g-truc-glm-8d1fd52
#     cmake --build build-wasm -j
#
#   产物：build-wasm/dist/network_physics.js（含内联 base64 wasm）
#
#   本机（无 emcmake 的备用路径）：直接跑 ./build_wasm.sh
#   ⚠️ 两条路径必须保持**标志一致** —— 否则会出现"用 build_wasm.sh 能跑、
#      用 CMake 编出来的崩"这种最难查的分裂。下面的注释即两处对齐的依据。
# =============================================================================
cmake_minimum_required(VERSION 3.20)
project(forza_net_wasm CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(WARNING
    "未检测到 Emscripten。Wasm 目标会被跳过（其余原生验证仍可用）。\n"
    "  原生可跑：g++ -std=c++20 -I <glm> wasm_bindings_test.cpp && ./a.out\n"
    "  正确的 Wasm 构建：emcmake cmake -S . -B build-wasm")
  return()
endif()

# GLM：本项目用 E 盘源码检出；有系统包时优先系统包。
# -I 必须指向**含 glm/ 子目录的父目录**，不是 glm/ 本身。
set(GLM_INCLUDE_DIR "/e/g-truc-glm-8d1fd52" CACHE PATH "GLM 根目录（含 glm/ 子目录）")

add_executable(network_physics
  wasm_bindings.cpp
  ../timesync/forza_time_sync.cpp
  ../race_delta/race_delta_tracker.cpp
)

target_include_directories(network_physics PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/..      # timesync / rb_replicator / race_delta 的相对包含
  ${GLM_INCLUDE_DIR}
)

# -----------------------------------------------------------------------------
#  编译标志 —— 每个都要能回答"为什么"
#
#    -O3          发布优化
#    -flto        跨 TU 内联。本模块大量逻辑是头文件 inline + 四个 TU 互相调用，
#                 LTO 能把 replicator 的外推循环真正内联进导出函数，收益明显。
#    -msimd128    开 128 位 SIMD。
#                 ⚠️ **会改变 ABI**：所有调用方（以及 node 冒烟变体）必须同样开，
#                    不能一半开一半不开 —— 症状是调用错位、参数读到垃圾。
#    -Wall -Wextra -Wpedantic
#                 零警告纪律（CI 里再叠 -Werror）。本项目所有 C++ 模块都吃这三个。
# -----------------------------------------------------------------------------
target_compile_options(network_physics PRIVATE
  -O3 -flto -msimd128
  -Wall -Wextra -Wpedantic
)

# -----------------------------------------------------------------------------
#  链接标志
#
#   内存
#     -sINITIAL_MEMORY=64MB   初始 64MB，避免启动后立刻 grow（grow 会让视图失效）
#     -sALLOW_MEMORY_GROWTH=1 允许增长。⚠️ 代价：增长会**替换 HEAPU8 的底层
#                             ArrayBuffer** → 之前缓存的 TypedArray 视图全部失效
#                             （读到全 0，不报错）。前端唯一对策是**每次访问堆都
#                             重新取视图** —— 见 NetworkEngine.ts 的 heapU8() /
#                             matrixView()，那里的 new Float32Array 是轻量视图
#                             构造（不拷贝），每帧做一次的开销可以忽略。
#     -sSTACK_SIZE=1MB        物理/GLM 调用栈比默认 64KB 深，留足
#
#   运行时
#     -sNO_EXIT_RUNTIME=1     **不加会出最难查的失效**：`main()` 返回后 Emscripten
#                             会拆掉运行时（注销 atexit、关 stdio、置 runtimeExited），
#                             此后所有 WASM 调用静默变成 no-op —— 不报错、不抛异常，
#                             就是不动。本模块是长驻宿主（无 main，靠 JS 反复调导出
#                             函数），必须从一开始就禁掉退出行为。
#
#   体积与安全
#     -sFILESYSTEM=0          不用虚拟 FS，直接砍掉一大块
#     -sDYNAMIC_EXECUTION=0   禁用 eval / new Function（"关闭动态调用开销"），
#                             同时让产物能过严格 CSP
#     -sASSERTIONS=0          去掉运行时断言（发布）
#     -sENVIRONMENT=web       只出 web 分支，去掉 node/worker 兼容代码
#     -sSINGLE_FILE=1         **本项目必须开**：把 .wasm 以 base64 内联进 .js。
#                             否则浏览器要 fetch 一个 .wasm 文件，而 index.html 的
#                             `default-src 'none'` 会直接拦掉这次请求。
#                             代价：体积 +33%，加载时一次 base64 解码。
#
#   导出
#     -sEXPORT_ES6=1          产出 ESM，方便 TS/Vite 直接 import
#     -sMODULARIZE=1          产出工厂函数而不是全局 Module，避免污染
#     --bind                  启用 Embind（低频通道）
#     -sEXPORTED_RUNTIME_METHODS=['HEAPF32','HEAPU8']
#                             零拷贝路径的前提：JS 必须能直接读写堆视图。
#     -sEXPORTED_FUNCTIONS=... EXTERN "C" 符号在 LTO + MODULARIZE 下会被裁掉，
#                             必须逐个列出。漏一个的症状是
#                             "Module._fz_xxx is not a function"。
#
#   ⚠️ CSP 提醒（本项目踩点，务必与 index.html 同步）
#      WebAssembly.instantiate 需要 `script-src 'wasm-unsafe-eval'`，
#      否则整个模块加载静默失败（只在 console 报一条 CSP violation）。
#      该指令比 'unsafe-eval' 窄：只放开 wasm 编译，不放开 eval()。
# =============================================================================
target_link_options(network_physics PRIVATE
  -O3 -flto
  --bind
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createForzaNet
  -sENVIRONMENT=web
  -sINITIAL_MEMORY=67108864
  -sALLOW_MEMORY_GROWTH=1
  -sNO_EXIT_RUNTIME=1
  -sSTACK_SIZE=1048576
  -sFILESYSTEM=0
  -sDYNAMIC_EXECUTION=0
  -sASSERTIONS=0
  -sSINGLE_FILE=1
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32
  -sEXPORTED_FUNCTIONS=_malloc,_free,_fz_snapshot_stage_addr,_fz_snapshot_stage_size,_fz_field_offset,_fz_snapshot_commit,_fz_on_pong,_fz_adjusted_dt,_fz_matrix_stage_addr,_fz_matrix_slot_addr,_fz_update,_fz_refresh_matrices,_fz_reset_all,_fz_set_half_life,_fz_set_max_extrapolation,_fz_remote_stage_base,_fz_wire_bytes,_fz_update_remote_state,_fz_update_remote_state_ptr,_fz_update_remotes,_fz_refresh_remote_matrices,_fz_remote_matrix_base,_fz_remote_position,_fz_remote_visual_position,_fz_remote_visual_error,_fz_remote_extrapolated,_fz_remote_repl_state,_fz_vehicle_count,_fz_vehicle_find,_fz_ensure_vehicle,_fz_remove_vehicle,_fz_set_local_vehicle,_fz_set_track,_fz_track_ready,_fz_track_length,_fz_checkpoint_count,_fz_project,_fz_update_progress,_fz_build_leaderboard,_fz_row_text_addr,_fz_row_text_cap,_fz_format_local_vs_leader,_fz_local_row_addr,_fz_solve_delta_ms,_fz_solve_method,_fz_solve_ds,_fz_solve_vseg,_fz_wire_bit_offset,_fz_wire_bit_width,_fz_wire_scale,_fz_pack_snapshot,_fz_expand_snapshot,_fz_is_locked,_fz_server_now_ns,_fz_current_warp,_fz_best_rtt_ns,_fz_visual_error_m,_fz_extrapolated_s,_fz_repl_state,_fz_sync_state,_fz_last_frame,_fz_stale_dropped,_fz_hard_snaps
)

set_target_properties(network_physics PROPERTIES
  OUTPUT_NAME "network_physics"
  SUFFIX ".js"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/dist"
)

# -----------------------------------------------------------------------------
#  原生单测（不需要 Emscripten；用系统 g++ 就能跑）
#     cmake --build . --target wasm_bindings_native_test
#   这一层验证的是**字节协议**（32B 线格式往返 / 位表 / 饱和量化）——
#   也就是"错了不会报错、只会静默传垃圾"的那部分。
# -----------------------------------------------------------------------------
add_executable(wasm_bindings_native_test EXCLUDE_FROM_ALL
  wasm_bindings_test.cpp
  ../timesync/forza_time_sync.cpp
  ../race_delta/race_delta_tracker.cpp
)
target_include_directories(wasm_bindings_native_test PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/..
  ${GLM_INCLUDE_DIR}
)
target_compile_options(wasm_bindings_native_test PRIVATE -O2 -Wall -Wextra -Wpedantic)
