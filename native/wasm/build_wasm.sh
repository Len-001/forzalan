#!/usr/bin/env bash
# =============================================================================
#  build_wasm.sh —— 一键构建 Wasm 网络宿主模块（C++20 / Emscripten）
#
#  ── 本机环境（都已就位，直接跑即可）────────────────────────────────────────
#    em++   : E:/emsdk/upstream/emscripten/em++.py        (6.0.10-git)
#             ⚠️ **必须 em++ 而不是 emcc**：本项目是 C++，emcc 只链 libc，
#                报一堆 undefined symbol（libc++ 的 operator new / std::sqrt 等）。
#    node   : E:/emsdk/node/24.19.0_64bit/node.exe
#    GLM    : E:/g-truc-glm-8d1fd52   （-I 指向**含 glm/ 的父目录**）
#    config : E:/emsdk/.emscripten    （手工写的；emsdk activate 中途失败）
#
#  用法：./build_wasm.sh
#  产物：
#    dist/network_physics.js        网页版（含内联 base64 wasm，单文件，SINGLE_FILE=1）
#    dist/network_physics_node.mjs  node 版（给 smoke_test.mjs 真机例化用）
#
#  ── 三个"不加就出诡异 bug"的标志（都踩过）──────────────────────────────────
#  1) -s NO_EXIT_RUNTIME=1
#      不加它：`main()` 返回后 Emscripten 会**拆掉运行时** —— 注销所有
#      atexit 回调、关闭 stdio、把 `runtimeExited` 置真。
#      对本模块的后果：宿主是"长驻模块"（没有 main，靠 JS 反复调导出函数），
#      但若哪天误加了 `emscripten_force_exit()` 或模块被判断为已退出，
#      后续所有 WASM 调用会静默变成 no-op —— **不报错、不抛异常，就是不动**。
#      这是最难查的一类失效，必须从一开始就禁掉退出行为。
#  2) -s ALLOW_MEMORY_GROWTH=1
#      允许堆增长（拖车内存/大网格需要）。代价：**增长会换掉 HEAPU8 的底层
#      ArrayBuffer**，之前缓存的 TypedArray 视图立刻失效（读到全 0）。
#      前端唯一对策：**每次访问堆都重新取视图**（见 NetworkEngine.ts 的 heapU8()
#      与 matrixView()，那里每帧都 new Float32Array —— 这是轻量视图构造，不拷贝）。
#  3) -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32
#      零拷贝路径的前提：JS 必须能直接读写 Wasm 线性内存的两个视图。
#      不导出 → `Module.HEAPU8` 是 undefined → 所有 HEAPU8.set 静默不执行。
#
#  ── 与"关闭动态调用"相关的 CSP ──────────────────────────────────────────────
#    -s DYNAMIC_EXECUTION=0 禁用 eval / new Function，产物可过严格 CSP。
#    但 **WebAssembly.instantiate 本身**还需要 CSP 放行 wasm 编译：
#        script-src 'wasm-unsafe-eval'
#    本项目的 index.html 是 `default-src 'none'`，**必须**加这一条，
#    否则整个模块加载静默失败（只在 console 报一条 CSP violation）。
#    `'wasm-unsafe-eval'` 比 `'unsafe-eval'` 窄：不放开 eval()，只放开 wasm 编译。
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
EMSDK=/e/emsdk
PY="C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe"
GLM=/e/g-truc-glm-8d1fd52
EMXX="$EMSDK/upstream/emscripten/em++.py"

export EM_CONFIG="$EMSDK/.emscripten"
# ⚠️ EM_FROZEN_CACHE=1 是本机能否构建成功的关键：
#    emcc 每轮会写/删缓存（sysroot 库、symbol_lists、*.lock），
#    而本机的批量删除保护会拦掉这些删除并把整次构建判为失败。
#    缓存已预热（sysroot 库都编好了）后冻结缓存 → emcc 只读不写 → 通过。
export EM_FROZEN_CACHE=1
export PATH="$EMSDK/node/24.19.0_64bit:$PATH"

cd "$HERE" || exit 1
mkdir -p dist

# 源文件清单（新增模块时只改这一处，避免两条 emcc 命令漏同步）
SOURCES=(
  wasm_bindings.cpp
  ../timesync/forza_time_sync.cpp
  ../race_delta/race_delta_tracker.cpp
)

# 必须显式导出的 C ABI 符号。EXPORT_ES6 + MODULARIZE 下，未被引用的
# `extern "C"` 函数会被 LTO 裁掉 —— 漏一个的症状是 "Module._fz_xxx is not a function"。
EXPORTS="_malloc,_free"
EXPORTS="$EXPORTS,_fz_snapshot_stage_addr,_fz_snapshot_stage_size,_fz_field_offset"
EXPORTS="$EXPORTS,_fz_snapshot_commit,_fz_on_pong,_fz_adjusted_dt"
EXPORTS="$EXPORTS,_fz_matrix_stage_addr,_fz_matrix_slot_addr,_fz_update,_fz_refresh_matrices"
EXPORTS="$EXPORTS,_fz_reset_all,_fz_set_half_life,_fz_set_max_extrapolation"
EXPORTS="$EXPORTS,_fz_remote_stage_base,_fz_wire_bytes,_fz_update_remote_state,_fz_update_remote_state_ptr"
EXPORTS="$EXPORTS,_fz_update_remotes,_fz_remote_matrix_base,_fz_refresh_remote_matrices"
EXPORTS="$EXPORTS,_fz_remote_position,_fz_remote_visual_position,_fz_remote_visual_error"
EXPORTS="$EXPORTS,_fz_remote_extrapolated,_fz_remote_repl_state"
EXPORTS="$EXPORTS,_fz_vehicle_count,_fz_vehicle_find,_fz_ensure_vehicle,_fz_remove_vehicle,_fz_set_local_vehicle"
EXPORTS="$EXPORTS,_fz_set_track,_fz_track_ready,_fz_track_length,_fz_checkpoint_count,_fz_project,_fz_update_progress"
EXPORTS="$EXPORTS,_fz_build_leaderboard,_fz_row_text_addr,_fz_row_text_cap,_fz_format_local_vs_leader,_fz_local_row_addr"
EXPORTS="$EXPORTS,_fz_solve_delta_ms,_fz_solve_method,_fz_solve_ds,_fz_solve_vseg"
EXPORTS="$EXPORTS,_fz_wire_bit_offset,_fz_wire_bit_width,_fz_wire_scale,_fz_pack_snapshot,_fz_expand_snapshot"
EXPORTS="$EXPORTS,_fz_is_locked,_fz_server_now_ns,_fz_current_warp,_fz_best_rtt_ns,_fz_visual_error_m"
EXPORTS="$EXPORTS,_fz_extrapolated_s,_fz_repl_state,_fz_sync_state,_fz_last_frame,_fz_stale_dropped,_fz_hard_snaps"

# -----------------------------------------------------------------------------
#  ① 网页版：发布优化 + 单文件 + 严格 CSP 友好
# -----------------------------------------------------------------------------
"$PY" "$EMXX" \
  -std=c++20 -O3 -flto -msimd128 \
  -Wall -Wextra -Wpedantic \
  -I . -I .. -I "$GLM" \
  "${SOURCES[@]}" \
  --bind \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createForzaNet \
  -sENVIRONMENT=web \
  -sINITIAL_MEMORY=67108864 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sNO_EXIT_RUNTIME=1 \
  -sSTACK_SIZE=1048576 \
  -sFILESYSTEM=0 \
  -sDYNAMIC_EXECUTION=0 \
  -sASSERTIONS=0 \
  -sSINGLE_FILE=1 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -o dist/network_physics.js

RC=$?
if [ "$RC" -ne 0 ]; then
  echo "=== [web] emcc exit=$RC ===" >&2
  exit $RC
fi
echo "=== [web] ok: dist/network_physics.js ==="

# -----------------------------------------------------------------------------
#  ② node 变体：冒烟测试要**真机例化** Wasm 才能验证（ENVIRONMENT=web 在 node 里跑不了）
#     这里刻意用 -O2 且不带 -msimd128 之外的花活，缩短构建时间；
#     ⚠️ 但 SIMD 必须同样开 —— `-msimd128` **改变 ABI**，
#        两端不一致会在链接/调用时出现难以理解的错位。
# -----------------------------------------------------------------------------
"$PY" "$EMXX" \
  -std=c++20 -O2 -msimd128 \
  -I . -I .. -I "$GLM" \
  "${SOURCES[@]}" \
  --bind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createForzaNet \
  -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sNO_EXIT_RUNTIME=1 \
  -sFILESYSTEM=0 -sSINGLE_FILE=1 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -o dist/network_physics_node.mjs

RC=$?
if [ "$RC" -ne 0 ]; then
  echo "=== [node] emcc exit=$RC ===" >&2
  exit $RC
fi
echo "=== [node] ok: dist/network_physics_node.mjs ==="

ls -lh dist/ 2>/dev/null
exit 0
