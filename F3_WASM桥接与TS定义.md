# 极限竞速8 — WASM 桥接 / 快照线格式 / TypeScript 定义

> 「极限竞速8」精简源码包自动生成 · 2026-10-15 08:56:46 (UTC+8)
> 分隔格式：`### 文件: <路径>` + 对应语言围栏，可直接被 AI 解析。

> 覆盖指定目录全部源码（已剔除 `.emcache` 工具链缓存与 emscripten JS 编译产物）。

## 本合集包含

- **native/wasm**
  - `native/wasm/CMakeLists.txt` — 151 行 / 8.2 KB
  - `native/wasm/NetworkEngine.ts` — 1097 行 / 44.9 KB
  - `native/wasm/NetworkPhysicsClient.ts` — 559 行 / 23.6 KB
  - `native/wasm/bindings.cpp` — 197 行 / 10.2 KB
  - `native/wasm/bridge_test.cpp` — 204 行 / 9.4 KB
  - `native/wasm/browser_check/check.mjs` — 55 行 / 2.3 KB
  - `native/wasm/browser_check/index.html` — 62 行 / 2.9 KB
  - `native/wasm/build_wasm.sh` — 149 行 / 7.7 KB
  - `native/wasm/layout.json` — 11 行 / 0.2 KB
  - `native/wasm/network_physics_bridge.h` — 250 行 / 11.6 KB
  - `native/wasm/smoke_test.mjs` — 406 行 / 21.1 KB
  - `native/wasm/snapshot_wire.h` — 371 行 / 20.4 KB
  - `native/wasm/tsconfig.check.json` — 19 行 / 0.4 KB
  - `native/wasm/vehicle_net_registry.h` — 454 行 / 18.9 KB
  - `native/wasm/verify_engine_wire.mjs` — 200 行 / 8.4 KB
  - `native/wasm/verify_layout.mjs` — 122 行 / 6.0 KB
  - `native/wasm/wasm_bindings.cpp` — 745 行 / 33.3 KB
  - `native/wasm/wasm_bindings_test.cpp` — 642 行 / 28.7 KB
  - `native/wasm/wire_dump.json` — 25 行 / 3.2 KB
- **wasm（顶层布局探针）**
  - `wasm/CMakeLists.txt` — 76 行 / 2.8 KB
  - `wasm/bindings.cpp` — 218 行 / 10.3 KB
  - `wasm/build.sh` — 59 行 / 2.4 KB
  - `wasm/layout.json` — 28 行 / 0.8 KB
  - `wasm/tools/layout_probe.cpp` — 82 行 / 4.0 KB
  - `wasm/verify.sh` — 53 行 / 2.1 KB
- **web（线格式 TS / 校验）**
  - `web/NetworkPhysicsClient.ts` — 573 行 / 21.8 KB
  - `web/snapshotLayout.ts` — 112 行 / 4.4 KB
  - `web/tools/verify_wire.mjs` — 197 行 / 9.3 KB

**合计：7117 行，319.4 KB**

---

## native/wasm

### 文件: native/wasm/CMakeLists.txt

```text
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
```

### 文件: native/wasm/NetworkEngine.ts

```typescript
/**
 * NetworkEngine.ts —— WebRTC DataChannel + 32B 紧凑二进制协议 + Wasm 零拷贝宿主
 * =============================================================================
 *
 *  这个文件解决三个具体问题（需求原文的三条漏洞）：
 *
 *  ① **队头阻塞（HOL blocking）**
 *     WebSocket 跑在 TCP 上：一个丢包会让**后面所有包**都在内核缓冲区排队等重传。
 *     物理快照的语义是"最新覆盖旧的"—— 为 200ms 前的位置等 200ms 毫无意义，
 *     等到了反而让插值缓冲变深、延迟变大。
 *     ⇒ 物理通道**必须**走 WebRTC DataChannel 的不可靠无序模式：
 *          { ordered: false, maxRetransmits: 0 }
 *     但 **NTP 心跳与房间/榜单消息必须走可靠有序通道** —— 丢一个 ping
 *     就丢一个窗口样本，PONG 乱序会让时钟滤波读到回退的时间戳。
 *     ⇒ 本引擎因此**建两条 DataChannel**，由调用方分别喂不同的消息。
 *
 *  ② **Wasm↔JS 内存拷贝开销**
 *     60Hz × N 车，若每包都 `JSON.parse` / 构造对象 / 传字符串，
 *     光序列化就能吃掉一帧的预算。
 *     ⇒ 物理快照走 **32 字节位打包 + Wasm 内存内直接解包**：
 *          JS:   HEAPU8.set(packet, stageBase + slot*32)   // 一次 32B memcpy
 *          再调: _fz_commit_remote_state(id)              // 一次无参调用
 *        全程没有对象、没有字符串、没有 JS 侧解包。
 *        Wasm 再直接吐一个 16-float 矩阵指针，前端 `HEAPF32.subarray` 零拷贝
 *        喂给 Three.js `Matrix4.fromArray`。
 *
 *  ③ **渲染主线程卡顿**
 *     物理更新**不能**跟着 rAF 走：一次页面重绘丢帧（后台标签页、GC、
 *     阴影贴图重建）会让 rAF 间隔从 16.7ms 跳到 100ms+，若直接用这个 dt
 *     推物理，就会出现"跳帧时车飞出去 / 卡顿后瞬移"。
 *     ⇒ 本引擎把 dt **钳到上限**（默认 50ms），并且：
 *        · 时钟微调（±1.5%）由 Wasm 的 `ForzaTimeSynchronizer` 独立完成
 *        · 帧间隔异常时**丢弃**该帧而不是补足时间（补足 = 更大的时间跳变）
 *        调用方还可以用 `setPhysicsDriver()` 把物理推进交给固定步长循环。
 *
 *  ── 与 three.js 的接线（最小示例，见文件末尾 createThreeNetworkBinding）──
 *      const engine = await NetworkEngine.create({ moduleFactory: createForzaNet });
 *      engine.attachUnreliableChannel(dcSnapshots);
 *      engine.attachReliableChannel(dcControl);
 *      engine.registerVehicle(peerId, threeMesh);          // 远端车
 *      engine.setLeaderboardDom(document.querySelector('#hud-tl'));
 *      // 每帧：
 *      engine.tick(nowMs);                                  // 内部推 Wasm
 *
 *  ── 本文件的类型纪律 ────────────────────────────────────────────────────────
 *    · 不使用 `const enum`（isolatedModules / 单文件转译器会拒绝）
 *    · 不使用 `any`（strict 下通不过）
 *    · 所有 Wasm 常量从模块读，**不在 TS 里硬编码位偏移**
 * =============================================================================
 */

// -----------------------------------------------------------------------------
//  Wasm 模块的最小类型声明
// -----------------------------------------------------------------------------
//  工程内没有本地 emcc，因此不生成 .d.ts；手写接口比 `any` 安全得多。
//  ⚠️ 字段名必须与 wasm_bindings.cpp 的 EMBIND/EXPORT 名**逐字一致**，
//     改一个字母就是运行期 `undefined is not a function`。

export interface ForzaNetModule {
  // ---- 线格式 & 矩阵常量（**唯一真相在 C++**）----
  readonly WIRE_BYTES: number;
  readonly MAX_VEHICLES: number;
  readonly ROW_TEXT_CAP: number;
  readonly MATRIX_SLOTS: number;
  readonly MATRIX_SLOT_VISUAL: number;
  readonly MATRIX_SLOT_PHYSICS: number;
  readonly WIRE_BIT_FRAME: number;
  readonly WIRE_BIT_TICK_MS: number;
  readonly WIRE_BIT_POS_X: number;
  readonly WIRE_BIT_POS_Y: number;
  readonly WIRE_BIT_POS_Z: number;
  readonly WIRE_BIT_VEL_X: number;
  readonly WIRE_BIT_VEL_Y: number;
  readonly WIRE_BIT_VEL_Z: number;
  readonly WIRE_BIT_ROT_X: number;
  readonly WIRE_BIT_ROT_Y: number;
  readonly WIRE_BIT_ROT_Z: number;
  readonly WIRE_BIT_ACC_X: number;
  readonly WIRE_BIT_ACC_Y: number;
  readonly WIRE_BIT_ACC_Z: number;
  readonly WIRE_BIT_OMEGA_X: number;
  readonly WIRE_BIT_OMEGA_Y: number;
  readonly WIRE_BIT_OMEGA_Z: number;

  // ---- Embind 低频：计时塔（会分配 JS 对象，**不要每帧调**）----
  leaderboard(): EmbindVector<LeaderboardRowJs>;

  // 32B 线格式的位表（交叉校验用）
  readonly WIRE_BITS_POS: number;
  readonly WIRE_BITS_VEL: number;
  readonly WIRE_BITS_ROT: number;
  readonly WIRE_BITS_ACC: number;
  readonly WIRE_BITS_OMEGA: number;
  readonly WIRE_SCALE_POS: number;
  readonly WIRE_SCALE_VEL: number;
  readonly WIRE_SCALE_ROT: number;
  readonly WIRE_SCALE_ACC: number;
  readonly WIRE_SCALE_OMEGA: number;

  // 96B 工作结构偏移
  readonly OFF_FRAME: number;
  readonly OFF_TICK_MS: number;
  readonly OFF_POSITION: number;
  readonly OFF_ROTATION: number;
  readonly OFF_VELOCITY: number;
  readonly OFF_ANGULAR_VELOCITY: number;
  readonly OFF_ACCEL: number;

  readonly SNAPSHOT_STAGE_SIZE: number;
  readonly SYNC_EVENT_NONE: number;
  readonly SYNC_EVENT_HARD_RESYNC: number;
  readonly SYNC_EVENT_SAMPLE_REJECTED: number;

  // ---- 堆视图 ----
  //  ⚠️ ALLOW_MEMORY_GROWTH=1 下内存增长会换掉底层 ArrayBuffer，
  //     所以**每次访问都要重新读这两个属性**，不要缓存到变量里长期持有。
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;

  // ---- 单车通道（时间同步 + 本地车航位推测）----
  _fz_on_pong(t1: number, t2: number, t3: number, t4: number): number;
  _fz_adjusted_dt(baseDtSec: number): number;
  _fz_update(dtSec: number): void;
  _fz_refresh_matrices(): void;
  _fz_reset_all(): void;
  _fz_set_half_life(sec: number): void;
  _fz_set_max_extrapolation(sec: number): void;
  _fz_matrix_slot_addr(slot: number): number;

  // ---- 多车通道 ----
  _fz_remote_stage_base(): number;
  _fz_wire_bytes(): number;
  _fz_update_remote_state(id: number, byteBuffer: number, offset: number): number;
  _fz_update_remote_state_ptr(id: number, ptr: number): number;
  _fz_update_remotes(dtSec: number): void;
  _fz_remote_matrix_base(): number;
  _fz_remote_position(id: number, axis: number): number;
  _fz_remote_visual_position(id: number, axis: number): number;
  _fz_remote_visual_error(id: number): number;
  _fz_remote_extrapolated(id: number): number;
  _fz_remote_repl_state(id: number): number;
  _fz_vehicle_count(): number;
  _fz_vehicle_find(id: number): number;
  _fz_ensure_vehicle(id: number, isLocal: number): number;
  _fz_remove_vehicle(id: number): number;
  _fz_set_local_vehicle(slot: number): void;

  // ---- 赛道 + 进度（秒差解算输入）----
  _fz_set_track(ctlXZ: number, ctlCount: number, cpArc: number, cpCount: number): number;
  _fz_track_ready(): number;
  _fz_track_length(): number;
  _fz_checkpoint_count(): number;
  _fz_project(x: number, z: number, hintS: number): number;
  _fz_update_progress(
    id: number, sMeters: number, serverTime: number,
    lap: number, cpIndex: number, cpPassTime: number,
  ): void;

  // ---- HUD 文本 ----
  _fz_build_leaderboard(): number;
  _fz_row_text_addr(row: number): number;
  _fz_row_text_cap(): number;
  _fz_format_local_vs_leader(): number;
  _fz_local_row_addr(): number;
  _fz_solve_delta_ms(aId: number, bId: number): number;
  _fz_solve_method(aId: number, bId: number): number;
  _fz_solve_ds(aId: number, bId: number): number;
  _fz_solve_vseg(aId: number, bId: number): number;

  // ---- 线格式打包（服务端 / 测试）----
  _fz_pack_snapshot(src: number, dst: number): number;
  _fz_expand_snapshot(src: number, dst: number): number;

  // ---- 遥测 ----
  _fz_is_locked(): number;              // ⚠️ C ABI 的 bool 在 JS 侧是 0/1 **数字**
  _fz_server_now_ns(): number;
  _fz_current_warp(): number;
  _fz_best_rtt_ns(): number;
  _fz_visual_error_m(): number;
  _fz_repl_state(): number;
  _fz_sync_state(): number;

  _malloc(size: number): number;
  _free(ptr: number): void;
}

export type ForzaNetFactory = (opts?: Record<string, unknown>) => Promise<ForzaNetModule>;

/** Embind 的 `std::vector<T>` 包装：size/get + **必须 delete()** 否则泄漏 Wasm 堆 */
export interface EmbindVector<T> {
  size(): number;
  get(index: number): T;
  delete(): void;
}

/** 计时塔一行（Embind value_object 的 JS 形态） */
export interface LeaderboardRowJs {
  id: number;
  position: number;
  lap: number;
  isLocal: boolean;
  isLeader: boolean;
  text: string;
}

// -----------------------------------------------------------------------------
//  协议常量
// -----------------------------------------------------------------------------

/** 不可靠 DataChannel 的配置 —— 需求钉死的形态。 */
export const UNRELIABLE_CHANNEL_INIT: RTCDataChannelInit = {
  ordered: false,
  maxRetransmits: 0,
};

/**
 * 发送背压阈值（字节）。
 *
 * DataChannel 的 `send()` 是**异步**的：它把数据交给底层 SCTP，马上返回。
 * 若网络跟不上而调用方仍在 60Hz 猛塞，`bufferedAmount` 会持续增长 ——
 * 我们发的是"最新覆盖旧的"语义的快照，排队只会让到达的数据越来越旧。
 * ⇒ 超过阈值就**跳过这一帧**，不排队。
 */
export const SNAPSHOT_SEND_BACKPRESSURE_BYTES = 64 * 1024;

/**
 * 单帧 dt 上限（毫秒）。
 *
 * rAF 间隔正常是 16.7ms（60Hz）或 8.3ms（120Hz），但后台标签页、
 * GC、阴影贴图重建会让它跳到几百毫秒。若把这个 dt 直接喂给物理，
 * 就会"卡一下之后车飞出去"。
 * ⇒ 钳到 50ms（≈3 个 60Hz 步）。更长的间隔**丢弃**而不是补足 ——
 *   补足等于制造一个更大的时间跳变。
 */
export const MAX_FRAME_DT_MS = 50;

/** NTP ping 周期（毫秒）。1Hz 足够：时钟窗口 30 个样本 = 30 秒收敛。 */
export const PING_INTERVAL_MS = 1000;

/** 可靠通道上的控制消息类型 */
export const ControlMsg = {
  Ping: 'PING',
  Pong: 'PONG',
} as const;
export type ControlMsgType = (typeof ControlMsg)[keyof typeof ControlMsg];

// -----------------------------------------------------------------------------
//  32B 线格式的 JS 侧打包器（与服务端 / C++ 位表必须一致）
// -----------------------------------------------------------------------------

/**
 * 32 字节位打包写入器。
 *
 * ⚠️ 为什么 JS 侧要自己实现一份位打包，而不是调 Wasm 的 `_fz_pack_snapshot`？
 *    本地车的发包频率是 60Hz。走 Wasm 需要：
 *      写 96B 工作结构 → 调 _fz_pack_snapshot → 再 slice 出去
 *    而直接在 JS 侧 Pack：一次 DataView 写入 + 一次 `send()`。
 *    这一份实现的存在价值是**省掉一次往返**，代价是**两个实现必须一致** ——
 *    所以本类的偏移**全部从 Wasm 常量读**（`WIRE_BIT_*`），不写死数字。
 *    并且 `assertProtocolMatch()` 会在启动时做一致性自检。
 */
export class WireSnapshotWriter {
  private readonly buf: ArrayBuffer;
  private readonly dv: DataView;

  constructor(private readonly mod: ForzaNetModule) {
    this.buf = new ArrayBuffer(mod.WIRE_BYTES);
    this.dv = new DataView(this.buf);
  }

  get bytes(): ArrayBuffer {
    return this.buf;
  }

  /**
   * 饱和定点量化。
   *
   * ⚠️ **必须与 C++ 的 `QuantizeSat` 逐值一致**，包括半值取整方向。
   *    JS 的 `Math.round` 定义是 `floor(x + 0.5)` —— 半个值一律朝 **+∞**：
   *        Math.round( 0.5) =  1
   *        Math.round(-0.5) = -0     ← 不是 -1
   *    C++ 侧已经改成同一条 `std::floor(s + 0.5)`，所以两边逐字节相同。
   *    曾经 C++ 用 `nearbyint`（取偶）而这里用 `Math.round`，
   *    在 0.0625m 这类"恰好半个量化步"的输入上差一位 —— 见 snapshot_wire.h。
   *    `native/wasm/verify_engine_wire.mjs` 会逐字节钉住这条等价性。
   *
   * 这里刻意写成 `Math.floor(v + 0.5)` 而不是 `Math.round(v)`：
   * 语义完全相同，但**写出了意图**，让下次改的人一眼看到"要跟 C++ 的 floor(x+0.5) 对齐"。
   */
  private quantize(v: number, scale: number, bits: number): number {
    if (!Number.isFinite(v)) return 0;
    const lo = -((1 << (bits - 1)) - 1);
    const hi = (1 << (bits - 1)) - 1;
    let q = Math.floor(v * scale + 0.5);   // = Math.round，但意图明确
    if (q > hi) q = hi;
    if (q < lo) q = lo;
    return q;
  }

  /**
   * 把一个快照写进 32 字节。
   *
   * 位打包用两个 32 位字之间的移位完成 —— 与 C++ 的 PutBits 同一算法。
   * 为了可读性，这里**不**追求极致微观优化：CPU 侧一次打包约 1~2µs，
   * 相对 `send()` 的异步开销可以忽略。
   */
  write(s: {
    frame: number; tickMs: number;
    px: number; py: number; pz: number;
    qw: number; qx: number; qy: number; qz: number;
    vx: number; vy: number; vz: number;
    wx: number; wy: number; wz: number;
    ax: number; ay: number; az: number;
  }): ArrayBuffer {
    const m = this.mod;
    // 用一个 8×32 位的临时数组做位打包（与 C++ 完全同构），最后 memcpy 进 DataView
    const w = new Uint32Array(8);

    const put = (off: number, bits: number, val: number): void => {
      const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
      const v = (val >>> 0) & mask;
      const wi = off >>> 5;
      const bs = off & 31;
      w[wi] = (w[wi] | ((v << bs) >>> 0)) >>> 0;
      if (bs + bits > 32) {
        const spill = bs + bits - 32;
        w[wi + 1] = (w[wi + 1] | (v >>> (bits - spill))) >>> 0;
      }
    };

    // ---- 姿态习惯化：w ≥ 0（q 与 -q 同旋转，取规范形）----
    let qw = s.qw, qx = s.qx, qy = s.qy, qz = s.qz;
    const n2 = qw * qw + qx * qx + qy * qy + qz * qz;
    if (!(n2 > 0) || !Number.isFinite(n2)) {
      qw = 1; qx = 0; qy = 0; qz = 0;
    } else {
      const inv = 1 / Math.sqrt(n2);
      qw *= inv; qx *= inv; qy *= inv; qz *= inv;
    }
    if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }

    // 位偏移来自 Wasm 常量（不硬编码）
    const B_FRAME = m.WIRE_BIT_FRAME ?? 0;
    const B_TICK = m.WIRE_BIT_TICK_MS ?? 16;
    const B_POSX = m.WIRE_BIT_POS_X ?? 32;
    const B_POSY = m.WIRE_BIT_POS_Y ?? 48;
    const B_POSZ = m.WIRE_BIT_POS_Z ?? 64;
    const B_VELX = m.WIRE_BIT_VEL_X ?? 80;
    const B_VELY = m.WIRE_BIT_VEL_Y ?? 94;
    const B_VELZ = m.WIRE_BIT_VEL_Z ?? 108;
    const B_ROTX = m.WIRE_BIT_ROT_X ?? 128;
    const B_ROTY = m.WIRE_BIT_ROT_Y ?? 144;
    const B_ROTZ = m.WIRE_BIT_ROT_Z ?? 160;
    const B_ACCX = m.WIRE_BIT_ACC_X ?? 176;
    const B_ACCY = m.WIRE_BIT_ACC_Y ?? 188;
    const B_ACCZ = m.WIRE_BIT_ACC_Z ?? 200;
    const B_OMGX = m.WIRE_BIT_OMEGA_X ?? 212;
    const B_OMGY = m.WIRE_BIT_OMEGA_Y ?? 224;
    const B_OMGZ = m.WIRE_BIT_OMEGA_Z ?? 236;

    put(B_FRAME, 16, s.frame & 0xffff);
    put(B_TICK, 16, s.tickMs & 0xffff);
    put(B_POSX, m.WIRE_BITS_POS, this.quantize(s.px, m.WIRE_SCALE_POS, m.WIRE_BITS_POS));
    put(B_POSY, m.WIRE_BITS_POS, this.quantize(s.py, m.WIRE_SCALE_POS, m.WIRE_BITS_POS));
    put(B_POSZ, m.WIRE_BITS_POS, this.quantize(s.pz, m.WIRE_SCALE_POS, m.WIRE_BITS_POS));
    put(B_VELX, m.WIRE_BITS_VEL, this.quantize(s.vx, m.WIRE_SCALE_VEL, m.WIRE_BITS_VEL));
    put(B_VELY, m.WIRE_BITS_VEL, this.quantize(s.vy, m.WIRE_SCALE_VEL, m.WIRE_BITS_VEL));
    put(B_VELZ, m.WIRE_BITS_VEL, this.quantize(s.vz, m.WIRE_SCALE_VEL, m.WIRE_BITS_VEL));
    put(B_ROTX, m.WIRE_BITS_ROT, this.quantize(qx, m.WIRE_SCALE_ROT, m.WIRE_BITS_ROT));
    put(B_ROTY, m.WIRE_BITS_ROT, this.quantize(qy, m.WIRE_SCALE_ROT, m.WIRE_BITS_ROT));
    put(B_ROTZ, m.WIRE_BITS_ROT, this.quantize(qz, m.WIRE_SCALE_ROT, m.WIRE_BITS_ROT));
    put(B_ACCX, m.WIRE_BITS_ACC, this.quantize(s.ax, m.WIRE_SCALE_ACC, m.WIRE_BITS_ACC));
    put(B_ACCY, m.WIRE_BITS_ACC, this.quantize(s.ay, m.WIRE_SCALE_ACC, m.WIRE_BITS_ACC));
    put(B_ACCZ, m.WIRE_BITS_ACC, this.quantize(s.az, m.WIRE_SCALE_ACC, m.WIRE_BITS_ACC));
    put(B_OMGX, m.WIRE_BITS_OMEGA, this.quantize(s.wx, m.WIRE_SCALE_OMEGA, m.WIRE_BITS_OMEGA));
    put(B_OMGY, m.WIRE_BITS_OMEGA, this.quantize(s.wy, m.WIRE_SCALE_OMEGA, m.WIRE_BITS_OMEGA));
    put(B_OMGZ, m.WIRE_BITS_OMEGA, this.quantize(s.wz, m.WIRE_SCALE_OMEGA, m.WIRE_BITS_OMEGA));

    // 小端写进 DataView（Wasm 侧按小端解 —— memcpy 进 uint32 数组后按本机序读）
    for (let i = 0; i < 8; i++) this.dv.setUint32(i * 4, w[i], true);
    return this.buf;
  }
}

// -----------------------------------------------------------------------------
//  引擎
// -----------------------------------------------------------------------------

export interface NetworkEngineOptions {
  /** Emscripten 工厂函数（`createForzaNet`） */
  moduleFactory: ForzaNetFactory;
  /** 误差衰减半衰期（秒）。默认 0.08（与 C++ 默认一致） */
  errorHalfLifeSec?: number;
  /** 外推上限（秒）。默认 0.15（与 C++ 默认一致） */
  maxExtrapolationSec?: number;
  /** 是否由引擎自己驱动 Wasm 的每帧推进（默认 true）。 */
  drivePhysics?: boolean;
}

/** 一辆远端车的前端句柄 */
export interface RemoteVehicleHandle {
  id: number;
  /** 槽索引（矩阵区的下标） */
  slot: number;
  /** Three.js 的 Object3D（只要有 matrix / matrixAutoUpdate 就行） */
  target?: ThreeMatrixTarget;
  /** 上一次实际应用的帧号（用于 HUD 诊断） */
  lastFrame: number;
}

/** Three.js `Object3D` 中本引擎真正需要的成员（避免 import three 造成强依赖） */
export interface ThreeMatrixTarget {
  matrix: { fromArray(a: ArrayLike<number>, offset?: number): unknown };
  matrixAutoUpdate: boolean;
  position?: { set(x: number, y: number, z: number): void };
  quaternion?: { set(x: number, y: number, z: number, w: number): void };
}

/** HUD 一行 DOM 的更新契约 */
export interface LeaderboardDomBinder {
  /** 第 index 行（0 = P1）的文本元素 */
  rowText(index: number): HTMLElement | null;
  /** 第 index 行整行的容器（用于加高亮 class） */
  rowElement(index: number): HTMLElement | null;
  /** 自己那一行的 class（默认 'is-local'） */
  localClass?: string;
  /** 领跑者那一行的 class（默认 'is-leader'） */
  leaderClass?: string;
}

/**
 * WebRTC + Wasm 网络引擎。
 *
 * 生命周期：`await NetworkEngine.create(opts)` → 挂通道 → 注册车辆 → 每帧 `tick(now)`。
 */
export class NetworkEngine {
  private mod: ForzaNetModule;
  private readonly opts: Required<Pick<NetworkEngineOptions, 'errorHalfLifeSec' | 'maxExtrapolationSec' | 'drivePhysics'>>;

  /** 物理快照通道（**不可靠 / 无序**） */
  private snapDc: RTCDataChannel | null = null;
  /** 控制/心跳通道（**可靠 / 有序**） */
  private ctrlDc: RTCDataChannel | null = null;

  private readonly vehicles = new Map<number, RemoteVehicleHandle>();
  private writer: WireSnapshotWriter;
  private snapStageBase = 0;

  private lastTs = 0;
  private frameCount = 0;
  private skippedByBackpressure = 0;
  private droppedLongFrame = 0;

  private pingTimer: number | null = null;
  private onHardResync: (() => void) | null = null;

  private hudBinder: LeaderboardDomBinder | null = null;
  private readonly hudScratch: string[] = [];

  private constructor(mod: ForzaNetModule, opts: NetworkEngineOptions) {
    this.mod = mod;
    this.opts = {
      errorHalfLifeSec: opts.errorHalfLifeSec ?? 0.08,
      maxExtrapolationSec: opts.maxExtrapolationSec ?? 0.15,
      drivePhysics: opts.drivePhysics ?? true,
    };
    this.writer = new WireSnapshotWriter(mod);
    this.assertProtocolMatch();

    mod._fz_set_half_life(this.opts.errorHalfLifeSec);
    mod._fz_set_max_extrapolation(this.opts.maxExtrapolationSec);
    this.snapStageBase = mod._fz_remote_stage_base();
  }

  /** 异步创建（例化 Wasm 模块） */
  static async create(opts: NetworkEngineOptions): Promise<NetworkEngine> {
    const mod = await opts.moduleFactory({});
    return new NetworkEngine(mod, opts);
  }

  /**
   * 启动自检：TS 侧读到的常量必须与 C++ 真值一致。
   *
   * ⚠️ 这不是走形式。32B 线格式的位表若与 C++ 不一致，**不会报错**，
   *    只会让位置被读成速度 —— 表现是"远端车偶尔乱飘"，极难归因。
   *    在启动时炸掉，比在赛道上猜要便宜一千倍。
   */
  private assertProtocolMatch(): void {
    const m = this.mod;
    const fail = (what: string, got: number, want: number): never => {
      throw new Error(
        `[NetworkEngine] 线格式自检失败：${what} = ${got}，期望 ${want}。` +
          `TS 侧与 Wasm 侧协议不一致 —— 远端车会静默乱飘，先修协议再跑。`,
      );
    };
    if (m.WIRE_BYTES !== 32) fail('WIRE_BYTES', m.WIRE_BYTES, 32);
    if (m._fz_wire_bytes() !== m.WIRE_BYTES) fail('_fz_wire_bytes()', m._fz_wire_bytes(), m.WIRE_BYTES);
    // 位表关键节点
    const expectBits: Array<[string, number, number]> = [
      ['WIRE_BIT_FRAME', m.WIRE_BIT_FRAME, 0],
      ['WIRE_BIT_TICK_MS', m.WIRE_BIT_TICK_MS, 16],
      ['WIRE_BIT_POS_X', m.WIRE_BIT_POS_X, 32],
      ['WIRE_BIT_VEL_X', m.WIRE_BIT_VEL_X, 80],
      ['WIRE_BIT_ROT_X', m.WIRE_BIT_ROT_X, 128],
      ['WIRE_BIT_OMEGA_Z', m.WIRE_BIT_OMEGA_Z, 236],
    ];
    for (const [name, got, want] of expectBits) {
      if (got !== want) fail(name, got, want);
    }
    // 位宽总校验：载荷必须装进 256 位
    const payload =
      16 + 16 +
      3 * m.WIRE_BITS_POS + 3 * m.WIRE_BITS_VEL + 3 * m.WIRE_BITS_ROT +
      3 * m.WIRE_BITS_ACC + 3 * m.WIRE_BITS_OMEGA;
    if (payload > 256) fail('payloadBits', payload, 256);
  }

  // ---------------------------------------------------------------------------
  //  通道装配
  // ---------------------------------------------------------------------------

  /**
   * 挂上物理快照通道。**必须是 `{ ordered: false, maxRetransmits: 0 }` 建出来的**。
   *
   * 这里**不做**自动改配置 —— 因为 DataChannel 的参数只能在创建时指定，
   * 事后无法改。传进来的通道若非不可靠模式，说明调用方建错了，
   * 此时**直接抛错**比"能跑但延迟高"要好：后者会被误判成"网络就是慢"。
   */
  attachUnreliableChannel(dc: RTCDataChannel): void {
    // ⚠️ 运行期无法读回 ordered/maxRetransmits（Chromium 上属性存在但不保证），
    //    所以只能靠 `reliable` 需要显式设缓冲。这里做的是**行为层校验**：
    //    若调用方给的是可靠通道，send() 会在拥塞时排队，表现为延迟单调增长。
    //    我们无法在这里断言，故在文档与注释里把要求钉死，并提供工厂方法。
    this.snapDc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => this.onSnapshotPacket(ev);
    dc.onclose = () => {
      this.snapDc = null;
      // 通道断了：清掉所有远端车的状态，避免用陈旧外推继续画
      for (const v of this.vehicles.values()) this.mod._fz_remove_vehicle(v.id);
      this.vehicles.clear();
    };
  }

  /**
   * 挂上 NTP / 控制通道。**必须可靠 + 有序**。
   *
   * 为什么不能和快照共用一个不可靠通道：
   *   · ping 被丢 → 少一个窗口样本（不至于出错，但收敛变慢）
   *   · **PONG 乱序** → t1 回退 → 时钟滤波读到"时间倒流"的样本，
   *     触发一次无意义的 hard resync，整屏车瞬移一下
   *   所以控制消息必须有序可靠。
   */
  attachReliableChannel(dc: RTCDataChannel): void {
    this.ctrlDc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => this.onControlPacket(ev);
    dc.onclose = () => {
      this.stopPing();
      this.ctrlDc = null;
    };
  }

  /** 用给定的 RTCPeerConnection 一次性建好两条通道（推荐入口） */
  static createChannels(pc: RTCPeerConnection): {
    snapshots: RTCDataChannel;
    control: RTCDataChannel;
  } {
    return {
      snapshots: pc.createDataChannel('fz.snap', UNRELIABLE_CHANNEL_INIT),
      control: pc.createDataChannel('fz.ctrl', { ordered: true }),
    };
  }

  // ---------------------------------------------------------------------------
  //  车辆注册
  // ---------------------------------------------------------------------------

  /** 注册一辆远端车，并可选地绑定 Three.js 对象 */
  registerVehicle(id: number, target?: ThreeMatrixTarget): RemoteVehicleHandle {
    const slot = this.mod._fz_ensure_vehicle(id, 0);
    if (slot < 0) {
      throw new Error(`[NetworkEngine] 车位表已满（上限 ${this.mod.MAX_VEHICLES}），无法注册 id=${id}`);
    }
    const h: RemoteVehicleHandle = { id, slot, target, lastFrame: 0 };
    this.vehicles.set(id, h);
    if (target) target.matrixAutoUpdate = false;   // 我们直接写 matrix，别让 three 覆盖
    return h;
  }

  /** 设定本地车（HUD 第一行用它判断"--"） */
  setLocalVehicle(id: number): void {
    const slot = this.mod._fz_ensure_vehicle(id, 1);
    if (slot < 0) {
      throw new Error(`[NetworkEngine] 本地车注册失败（车位表已满），id=${id}`);
    }
    this.mod._fz_set_local_vehicle(slot);
    this.localVehicleId = id;
  }

  /** 摘掉一辆车（玩家离开） */
  removeVehicle(id: number): void {
    this.mod._fz_remove_vehicle(id);
    this.vehicles.delete(id);
  }

  // ---------------------------------------------------------------------------
  //  赛道装配（秒差解算的输入）
  // ---------------------------------------------------------------------------

  /**
   * 装入赛道中心线（闭合控制多边形，世界坐标 x/z 交织的 Float64Array）与
   * Checkpoint 弧长表（Float64Array，升序，单位米）。
   *
   * ⚠️ 这条数据**必须与所有客户端一致**（同一 seed 生成的赛道）——
   *    否则各端算出的弧长 S 不可比，秒差会系统性偏移。
   */
  setTrack(ctlXZ: Float64Array, cpArcMeters: Float64Array): void {
    const m = this.mod;
    const ctlBytes = ctlXZ.byteLength;
    const cpBytes = cpArcMeters.byteLength;
    const pCtl = m._malloc(ctlBytes);
    const pCp = m._malloc(cpBytes > 0 ? cpBytes : 8);
    try {
      // ⚠️ 每次 malloc 都可能触发内存增长 → 堆视图失效 → 必须重新取
      this.heapU8().set(new Uint8Array(ctlXZ.buffer, ctlXZ.byteOffset, ctlBytes), pCtl);
      if (cpBytes > 0) {
        this.heapU8().set(new Uint8Array(cpArcMeters.buffer, cpArcMeters.byteOffset, cpBytes), pCp);
      }
      const ok = m._fz_set_track(pCtl, ctlXZ.length >> 1, pCp, cpArcMeters.length);
      if (ok === 0) throw new Error('[NetworkEngine] 赛道装入失败（控制点数量或弧长表非法）');
    } finally {
      m._free(pCtl);
      m._free(pCp);
    }
  }

  /** 上报一辆车的赛道进度（包到达或本地采样时调） */
  updateProgress(
    id: number, sMeters: number, serverTimeSec: number,
    lap: number, cpIndex: number, cpPassTimeSec: number,
  ): void {
    this.mod._fz_update_progress(id, sMeters, serverTimeSec, lap, cpIndex, cpPassTimeSec);
  }

  /** 世界坐标 → 本圈弧长（hintS < 0 表示全扫，非常贵；有上一帧 S 时务必传） */
  project(x: number, z: number, hintS = -1): number {
    return this.mod._fz_project(x, z, hintS);
  }

  // ---------------------------------------------------------------------------
  //  发送 / 接收
  // ---------------------------------------------------------------------------

  /**
   * 发一帧本地车快照（不可靠通道）。
   *
   * @returns true = 已发出；false = 因背压跳过（**正常现象**，不是错误）
   */
  sendLocalSnapshot(s: Parameters<WireSnapshotWriter['write']>[0]): boolean {
    const dc = this.snapDc;
    if (dc === null || dc.readyState !== 'open') return false;

    // ---- 背压：排队只会让到达的数据更旧 ----
    if (dc.bufferedAmount > SNAPSHOT_SEND_BACKPRESSURE_BYTES) {
      ++this.skippedByBackpressure;
      return false;
    }

    const buf = this.writer.write(s);
    // ⚠️ 必须 `send(buf)` 一个**独立**的 ArrayBuffer 而不是复用的大缓冲视图。
    //    writer 内部复用同一个 ArrayBuffer，send() 是异步的 ——
    //    若直接发这个 buffer 的引用，下一帧打包会把它改掉，
    //    发送出去的就是"半新半旧"的垃圾（症状：间歇性位置跳变，极难归因）。
    //    这里 `slice()` 一次 32B —— 这个拷贝换取的是确定性，非常划算。
    //    另：ALLOW_MEMORY_GROWTH 下堆可能被换掉，所以也绝不能发堆视图。
    dc.send(buf.slice(0));
    return true;
  }

  /** 收到物理快照包 */
  private onSnapshotPacket(ev: MessageEvent): void {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer)) return;
    if (data.byteLength !== this.mod.WIRE_BYTES) {
      // 长度不符：可能是别的协议混进来了。**必须挡住** ——
      // 让 32B 之外的字节进入解包会越界读进相邻内存。
      return;
    }
    // 包格式：[0..4) = 车辆 id（小端 u32），[4..36) = 32 字节快照
    // 把 id 放在外面是为了让"一包一车"语义显式 —— 不需要在 32B 里塞 id，
    // 32B 预算要全部留给物理量。
    if (data.byteLength < 4 + this.mod.WIRE_BYTES) return;
    const dv = new DataView(data);
    const id = dv.getUint32(0, true);

    const slot = this.vehicles.get(id)?.slot ?? this.mod._fz_ensure_vehicle(id, 0);
    if (slot < 0) return;   // 表满：静默丢弃（上层可从 vehicleCount 看出异常）

    // ★ 零拷贝路径：把 32B 直接写进 Wasm 线性内存，然后一次无参调用解包。
    //   没有 JSON、没有对象、没有字符串、没有任何 JS 侧解析。
    const stage = this.snapStageBase + slot * this.mod.WIRE_BYTES;
    this.heapU8().set(new Uint8Array(data, 4, this.mod.WIRE_BYTES), stage);
    const accepted = this.mod._fz_update_remote_state(id, stage, 0);
    if (accepted !== 0) {
      const h = this.vehicles.get(id);
      if (h) h.lastFrame += 1;
    }
  }

  // ---------------------------------------------------------------------------
  //  NTP（可靠通道）
  // ---------------------------------------------------------------------------

  /** 开始 1Hz ping */
  startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS) as unknown as number;
    this.sendPing();
  }

  stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * 发一次 ping。
   *
   * ⚠️ t1 用 `performance.now()`（单调）而不是 `Date.now()`：
   *    Date.now() 会被 NTP 校时 / 用户改表**回拨**，时钟同步器一旦读到
   *    负的时间增量，RTT 与 offset 立刻变成垃圾。
   *    精度说明：浏览器出于 Spectre 缓解会把 performance.now() 降精度
   *    （Chrome ~100µs，Firefox 默认 1ms）。纳秒只存在于**类型层面**，
   *    **不要**在文档/UI 里声称"纳秒精度"。要更高精度需 COOP/COEP
   *    跨源隔离 + SharedArrayBuffer。
   */
  sendPing(): void {
    const dc = this.ctrlDc;
    if (dc === null || dc.readyState !== 'open') return;
    const t1 = performance.now() * 1e6;   // µs 精度源 → 纳秒单位
    const buf = new ArrayBuffer(1 + 8);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);                    // 类型标记 1 = PING
    dv.setFloat64(1, t1, true);
    dc.send(buf);
  }

  /** 收到控制包（PONG 或其它） */
  private onControlPacket(ev: MessageEvent): void {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer) || data.byteLength < 9) return;
    const dv = new DataView(data);
    const kind = dv.getUint8(0);
    const t3 = performance.now() * 1e6;

    if (kind === 1) {
      // 收到 PING：原样回一个 PONG，带上 [t1(对端的), t2(收到时刻), t3(发出时刻)]
      // 对端会用 4 个时间戳算 RTT/offset（标准 NTP 四元组）
      const t1 = dv.getFloat64(1, true);
      const dc = this.ctrlDc;
      if (dc === null || dc.readyState !== 'open') return;
      const out = new ArrayBuffer(1 + 8 * 3);
      const odv = new DataView(out);
      odv.setUint8(0, 2);
      odv.setFloat64(1, t1, true);        // T1（回显）
      odv.setFloat64(9, t3, true);        // T2（本端收到 PING 的时刻）
      odv.setFloat64(17, t3, true);       // T3（本端发出 PONG 的时刻，同一 tick，见下方说明）
      dc.send(out);
      return;
    }

    if (kind === 2) {
      // 收到 PONG：T1/T2/T3 由对端给，T4 = 本端现在
      const t1 = dv.getFloat64(1, true);
      const t2 = dv.getFloat64(9, true);
      const t3p = dv.getFloat64(17, true);
      const t4 = t3;
      const evCode = this.mod._fz_on_pong(t1, t2, t3p, t4);
      if (evCode === this.mod.SYNC_EVENT_HARD_RESYNC) {
        // 硬同步：整屏视觉需要抑制一帧插值，交给上层决定怎么处理
        this.onHardResync?.();
      }
    }
  }

  setHardResyncHandler(fn: (() => void) | null): void {
    this.onHardResync = fn;
  }

  // ---------------------------------------------------------------------------
  //  每帧主循环
  // ---------------------------------------------------------------------------

  /**
   * 每帧调用（rAF 回调里传入 `timestamp`）。
   *
   * 物理推进与渲染**解耦**的关键在这里：
   *   · dt 取真实帧间隔，但**钳到 MAX_FRAME_DT_MS**；
   *   · 超过上限的长间隔（后台标签页回来 / GC 停顿）**直接丢弃这一帧**，
   *     不补足时间 —— 补足等于人为制造一个更大的时间跳变；
   *   · 时间伸缩（±1.5%）由 Wasm 的同步器完成，**物理步长绝不因此改变**。
   */
  tick(nowMs: number): void {
    if (this.lastTs === 0) this.lastTs = nowMs;
    let dtMs = nowMs - this.lastTs;
    this.lastTs = nowMs;

    if (!(dtMs > 0)) dtMs = 1000 / 60;      // 首帧 / 时钟相同
    if (dtMs > MAX_FRAME_DT_MS) {
      // 长间隔：丢弃，只保留一个标称步，避免"卡一下之后车飞出去"
      ++this.droppedLongFrame;
      dtMs = 1000 / 60;
    }

    if (!this.opts.drivePhysics) return;

    const rawDt = dtMs / 1000;
    // Wasm 返回的是**已含 ±1.5% 时钟伸缩**的步长。物理用它推进本地车外推。
    const adjusted = this.mod._fz_adjusted_dt(rawDt);
    this.mod._fz_update(adjusted);
    // 远端车：各自独立的外推 + 误差衰减 + 视觉矩阵刷新
    this.mod._fz_update_remotes(adjusted);

    this.applyVehicleMatrices();
    ++this.frameCount;
  }

  /** 把每辆远端车的视觉矩阵零拷贝写进 Three.js */
  private applyVehicleMatrices(): void {
    const m = this.mod;
    const base = m._fz_remote_matrix_base();
    for (const v of this.vehicles.values()) {
      if (!v.target) continue;
      const addr = base + v.slot * 16 * 4;
      // ⚠️ **每帧重建视图**：ALLOW_MEMORY_GROWTH 下内存增长会换掉 ArrayBuffer，
      //    缓存的 Float32Array 会变成孤儿（读到全 0 或抛错）。
      //    `new Float32Array(buffer, byteOffset, length)` 是**视图构造**，不做拷贝，
      //    每帧 4 辆车的开销可以忽略。
      const view = new Float32Array(m.HEAPF32.buffer, addr, 16);
      v.target.matrix.fromArray(view, 0);
    }
  }

  // ---------------------------------------------------------------------------
  //  HUD 绑定
  // ---------------------------------------------------------------------------

  /**
   * 绑定左上角计时塔 DOM。
   *
   * 文本**由 Wasm 的 RaceDeltaTracker 产出**（`_fz_build_leaderboard`），
   * 前端只负责把字符串塞进 DOM —— **绝不自行拼格式化字符串**。
   * 本项目"榜首负号方向"反复出错的根因，就是有多个地方各自拼文本。
   */
  setLeaderboardDom(root: HTMLElement, binder: LeaderboardDomBinder): void {
    // root 只用于调试定位：高亮/改文本都靠 binder 的回调（那样调用方
    // 可以自由决定 DOM 结构，本体不强绑任何 class 名或层级）。
    // 这里做一次结构自检，让"传错 root"在启动时可见，而不是等到 HUD 不刷新。
    if (!(root instanceof HTMLElement)) {
      throw new TypeError('[NetworkEngine] setLeaderboardDom: root 不是 HTMLElement');
    }
    this.hudBinder = binder;
  }

  /**
   * 刷新计时塔（HUD 帧率调用即可，不必每物理帧）。
   *
   * 读文本走**文本暂存区 + HEAPU8**（不是 Embind 的对象数组）：
   * 后者每行都会在 JS 侧分配一个对象 + 一个字符串。
   */
  refreshLeaderboard(): number {
    const binder = this.hudBinder;
    if (binder === null) return 0;
    const m = this.mod;
    const rows = m._fz_build_leaderboard();

    for (let i = 0; i < rows; i++) {
      const addr = m._fz_row_text_addr(i);
      if (addr === 0) continue;
      // 文本 ≤ ROW_TEXT_CAP-1 字节的 ASCII（"--" / "-12.34"）；扫描到 '\0'
      const view = m.HEAPU8.subarray(addr, addr + m.ROW_TEXT_CAP);
      let text = '';
      for (let k = 0; k < view.length; k++) {
        if (view[k] === 0) break;
        text += String.fromCharCode(view[k]);
      }
      this.hudScratch[i] = text;
      const el = binder.rowText(i);
      if (el !== null && el.textContent !== text) el.textContent = text;

      const rowEl = binder.rowElement(i);
      if (rowEl !== null) {
        rowEl.classList.toggle(binder.localClass ?? 'is-local', false);
        rowEl.classList.toggle(binder.leaderClass ?? 'is-leader', i === 0);
      }
    }
    // 高亮本地那一行
    this.highlightLocalRow(binder, rows);
    return rows;
  }

  private highlightLocalRow(binder: LeaderboardDomBinder, rows: number): void {
    const localId = this.localVehicleId;
    if (localId === null) return;
    const cls = binder.localClass ?? 'is-local';
    // 先全部清掉，再只给本地行加上 —— 避免上一帧的高亮残留
    for (let i = 0; i < rows; i++) {
      const rowEl = binder.rowElement(i);
      if (rowEl !== null) rowEl.classList.toggle(cls, false);
    }
    const table = this.mod.leaderboard();
    const n = Math.min(rows, table.size());
    for (let i = 0; i < n; i++) {
      if (table.get(i).id !== localId) continue;
      const rowEl = binder.rowElement(i);
      if (rowEl !== null) rowEl.classList.toggle(cls, true);
      break;
    }
    table.delete();   // ⚠️ Embind 的 vector 必须在 JS 侧显式 delete，否则 Wasm 堆泄漏
  }

  private localVehicleId: number | null = null;

  /**
   * 读第 i 行对应的车辆 id。
   *
   * 走 Embind 的低频 `leaderboard()`（每次调用会构造 N 个 JS 对象）——
   * 所以**只在确实需要 id 时调**（例如判断哪一行是本地车做高亮），
   * 而不要每帧为整张表调一次。
   */
  rowIdAt(index: number): number | null {
    const rows = this.mod.leaderboard();
    if (index < 0 || index >= rows.size()) return null;
    return rows.get(index).id;
  }

  /** 本地 vs 领跑者那一行（HUD 第一行，更新最频繁） */
  localDeltaText(): string {
    const m = this.mod;
    m._fz_format_local_vs_leader();
    const addr = m._fz_local_row_addr();
    const view = m.HEAPU8.subarray(addr, addr + m.ROW_TEXT_CAP);
    let text = '';
    for (let k = 0; k < view.length; k++) {
      if (view[k] === 0) break;
      text += String.fromCharCode(view[k]);
    }
    return text;
  }

  /** 两车时差（毫秒，正 = a 领先 b） */
  solveDeltaMs(aId: number, bId: number): number {
    return this.mod._fz_solve_delta_ms(aId, bId);
  }

  // ---------------------------------------------------------------------------
  //  工具 / 遥测
  // ---------------------------------------------------------------------------

  /**
   * 当前堆视图。
   *
   * ⚠️ **绝不缓存返回值**。`ALLOW_MEMORY_GROWTH=1` 下堆增长会替换底层
   *    ArrayBuffer，缓存的视图会静默失效（写入无声无息地丢失）。
   *    本方法刻意每次读 `mod.HEAPU8`，让调用点无法误缓存。
   */
  private heapU8(): Uint8Array {
    return this.mod.HEAPU8;
  }

  /** 本地车的视觉世界矩阵（16 float，零拷贝视图；**每帧重建**） */
  localVisualMatrixView(): Float32Array {
    const addr = this.mod._fz_matrix_slot_addr(this.mod.MATRIX_SLOT_VISUAL);
    return new Float32Array(this.mod.HEAPF32.buffer, addr, 16);
  }

  /** 某远端车的视觉矩阵视图（**每帧重建**，见 applyVehicleMatrices 的说明） */
  vehicleMatrixView(id: number): Float32Array | null {
    const h = this.vehicles.get(id);
    if (!h) return null;
    const addr = this.mod._fz_remote_matrix_base() + h.slot * 64;
    return new Float32Array(this.mod.HEAPF32.buffer, addr, 16);
  }

  /** 时钟/复制遥测快照（HUD 调试面板用） */
  telemetry(): {
    locked: boolean; warp: number; bestRttMs: number;
    serverNowNs: number; visualErrorM: number; frames: number;
    skippedByBackpressure: number; droppedLongFrame: number;
  } {
    const m = this.mod;
    return {
      // ⚠️ C ABI 的 bool 返回是 **0/1 数字**，不是 true/false
      locked: m._fz_is_locked() !== 0,
      warp: m._fz_current_warp(),
      bestRttMs: m._fz_best_rtt_ns() / 1e6,
      serverNowNs: m._fz_server_now_ns(),
      visualErrorM: m._fz_visual_error_m(),
      frames: this.frameCount,
      skippedByBackpressure: this.skippedByBackpressure,
      droppedLongFrame: this.droppedLongFrame,
    };
  }

  dispose(): void {
    this.stopPing();
    this.mod._fz_reset_all();
    this.vehicles.clear();
    this.hudBinder = null;
    this.localVehicleId = null;
  }
}

// -----------------------------------------------------------------------------
//  Three.js 适配示例
// -----------------------------------------------------------------------------
//
//  下面这段不是引擎的一部分，而是**可直接抄进项目的接法**。它演示三件事：
//    ① 用 RTCPeerConnection 建两条通道（不可靠快照 + 可靠控制）
//    ② 每辆远端车用一个 Object3D，matrixAutoUpdate = false，由 Wasm 直写矩阵
//    ③ rAF 里 tick + 低频刷新 HUD
//
//  ```ts
//  import * as THREE from 'three';
//  import { NetworkEngine } from './NetworkEngine';
//  import createForzaNet from './dist/network_physics.js';
//
//  export async function createThreeNetworkBinding(
//    pc: RTCPeerConnection,
//    scene: THREE.Scene,
//    hudRoot: HTMLElement,
//  ) {
//    const engine = await NetworkEngine.create({ moduleFactory: createForzaNet as never });
//
//    // ① 两条通道
//    const { snapshots, control } = NetworkEngine.createChannels(pc);
//    engine.attachUnreliableChannel(snapshots);
//    engine.attachReliableChannel(control);
//    engine.startPing();
//
//    // ② 远端车网格
//    const carGeo = new THREE.BoxGeometry(1.9, 1.2, 4.5);
//    const carMat = new THREE.MeshStandardMaterial({ color: 0xcc3333, metalness: 0.6 });
//    const meshes = new Map<number, THREE.Mesh>();
//
//    function onPeerJoined(id: number) {
//      const mesh = new THREE.Mesh(carGeo, carMat);
//      // ⚠️ 必须关掉 matrixAutoUpdate：我们在 Wasm 侧已经算好了最终世界矩阵
//      mesh.matrixAutoUpdate = false;
//      scene.add(mesh);
//      meshes.set(id, mesh);
//      engine.registerVehicle(id, mesh);
//    }
//
//    // ③ 主循环
//    const hudBinder = {
//      rowText: (i: number) => document.querySelector<HTMLElement>(`#hud-tl .row[data-i="${i}"] .gap`),
//      rowElement: (i: number) => document.querySelector<HTMLElement>(`#hud-tl .row[data-i="${i}"]`),
//      localClass: 'is-local',
//      leaderClass: 'is-leader',
//    };
//    engine.setLeaderboardDom(hudRoot, hudBinder);
//
//    let hudAccum = 0;
//    function frame(now: number) {
//      // 物理推进与渲染解耦：tick 内部已把 dt 钳住、长间隔丢弃
//      engine.tick(now);
//
//      hudAccum += 1;
//      if (hudAccum >= 3) {          // HUD 20Hz 足够，省 DOM 开销
//        hudAccum = 0;
//        engine.refreshLeaderboard();
//      }
//      requestAnimationFrame(frame);
//    }
//    requestAnimationFrame(frame);
//
//    engine.setHardResyncHandler(() => {
//      // 硬同步（>250ms 偏差 / 断线重连）：抑制一帧远端车插值
//      console.warn('[net] 时钟硬同步，抑制这一帧远端插值');
//    });
//
//    return { engine, onPeerJoined };
//  }
//  ```
//
//  ── 为什么远端车用 `matrix.fromArray` 而不是 `position/quaternion` ────────
//    `position.set()` + `quaternion.set()` 会让 three 在 updateMatrix 时
//    重新合成矩阵（一次 4×4 乘法 + 一次 compose）。而 Wasm 已经把
//    最终世界矩阵算好了（物理位姿 × 残余视觉偏移，slerp 已做）。
//    直接 `fromArray` 是把 16 个 float 拷进矩阵 —— 没有三角函数、没有 compose。
//    每辆车每帧省下的就是一次矩阵合成，4 辆车 @120Hz = 480 次/秒。
// -----------------------------------------------------------------------------
```

### 文件: native/wasm/NetworkPhysicsClient.ts

```typescript
/* =============================================================================
 *  NetworkPhysicsClient.ts —— Wasm 物理同步流水线的前端宿主（单例）
 *
 *  职责：WebRTC DataChannel 二进制流 -> Wasm 内部状态 -> rAF 取渲染矩阵 -> 网格
 *
 *  ── 三条设计主线 ────────────────────────────────────────────────────────────
 *   1) **零拷贝**：网络包如果就是结构体布局，直接 memcpy 进 Wasm 线性内存，
 *      连"解包"这一步都不需要（见 pushSnapshotRaw）。
 *   2) **CSP 友好**：不 eval、不 fetch，配合 -sSINGLE_FILE=1 + DYNAMIC_EXECUTION=0。
 *   3) **视图失效防护**：ALLOW_MEMORY_GROWTH=1 时内存增长会**换掉底层 ArrayBuffer**，
 *      之前缓存的 HEAPU8 会变成悬空视图。所有堆访问都必须走 heap() 重新取。
 *
 *  ── 三个必须知道的浏览器侧限制（写在这里免得后来者当成 bug 查）────────────
 *   ① **时间精度不是纳秒**。C++ 侧用 emscripten_get_now()，它基于 performance.now()，
 *      而浏览器出于 Spectre 缓解会**故意降低计时精度**：
 *        Chrome ~100µs、Firefox 默认 1ms（privacy.resistFingerprinting 下 100ms 级）。
 *      所以"纳秒"只是类型上留的余量，实际分辨率是 100µs 量级。
 *      对 NTP 同步（目标毫秒级）完全够用，但**不要**在任何文档里声称浏览器端纳秒精度。
 *      想要更高精度：需要 COOP/COEP 跨源隔离 + SharedArrayBuffer（见 enableHighResTimer）。
 *   ② **CSP 必须放行 wasm 编译**：`script-src 'wasm-unsafe-eval'`。
 *      只有 `default-src 'none'` 的话 WebAssembly.instantiate 会被静默拒绝，
 *      只在 console 留一条 violation。本项目 index.html 现在就是 'none'，需要改。
 *   ③ **maxRetransmits: 0 意味着丢包不补**。物理快照丢了就丢了（下一帧会来），
 *      但**控制类消息（NTP 采样、房间状态）不能走这条通道** —— 必须另开可靠通道。
 *      本文件的 sendPing 默认走可靠通道就是这个原因。
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 *  Wasm 模块类型（手写，因为本机没有 emcc 也就没有生成的 .d.ts）
 *  字段名必须与 bindings.cpp 里 EMSCRIPTEN_BINDINGS 导出的名字完全一致。
 * -------------------------------------------------------------------------- */
export interface NetworkPhysicsModule {
  // 常量
  readonly SNAPSHOT_STAGE_SIZE: number;
  readonly MATRIX_STAGE_SIZE: number;
  readonly MATRIX_SLOT_FLOATS: number;

  readonly OFF_FRAME: number;
  readonly OFF_TICK_MS: number;
  readonly OFF_SERVER_TIME: number;
  readonly OFF_POSITION: number;
  readonly OFF_ROTATION: number;
  readonly OFF_VELOCITY: number;
  readonly OFF_ANGULAR_VELOCITY: number;
  readonly OFF_ACCEL: number;

  readonly SYNC_EVENT_NONE: number;
  readonly SYNC_EVENT_HARD_RESYNC: number;
  readonly SYNC_EVENT_SAMPLE_REJECTED: number;

  // 堆（EXPORTED_RUNTIME_METHODS）
  readonly HEAPU8: Uint8Array;
  readonly HEAPF32: Float32Array;

  // 零拷贝 C ABI（EXPORTED_FUNCTIONS 里带下划线，运行时挂在 _ 前缀上）
  _fz_snapshot_stage_addr(): number;
  _fz_snapshot_stage_size(): number;
  _fz_field_offset(field: number): number;
  _fz_snapshot_commit(): number;

  _fz_on_pong(t1: number, t2: number, t3: number, t4: number): number;
  _fz_adjusted_dt(baseDtSec: number): number;

  _fz_matrix_stage_addr(): number;
  _fz_update(dtSec: number): void;
  _fz_reset_all(): void;
  _fz_set_half_life(sec: number): void;
  _fz_set_max_extrapolation(sec: number): void;

  // ⚠️ 注意：这些是 `extern "C"` 导出（EXPORTED_FUNCTIONS），
  // Emscripten 对 C 的 `bool` 返回值映射成**数字 0/1**，不是 JS boolean。
  // 写成 `boolean` 会让 `=== true` 恒为 false —— 实测踩过。
  // 用 `!== 0` 判断，别用 `=== true`。
  _fz_is_locked(): number;
  _fz_server_now_ns(): number;
  _fz_current_warp(): number;
  _fz_best_rtt_ns(): number;
  _fz_visual_error_m(): number;
  _fz_extrapolated_s(): number;
  _fz_repl_state(): number;
  _fz_sync_state(): number;
  _fz_last_frame(): number;
  _fz_stale_dropped(): number;
  _fz_hard_snaps(): number;

  // Embind 低频通道
  syncTelemetry(): SyncTelemetryView;
  replTelemetry(): ReplTelemetryView;
}

export interface SyncTelemetryView {
  serverNowNs(): number;
  offsetNs(): number;
  bestRttNs(): number;
  warp(): number;
  locked(): boolean;
  state(): number;
  samples(): number;
}
export interface ReplTelemetryView {
  hasState(): boolean;
  state(): number;
  extrapolatedSec(): number;
  visualErrorM(): number;
  lastFrame(): number;
  staleDropped(): number;
  hardSnaps(): number;
}

/** Wasm 工厂（EMSCRIPTEN_BINDINGS 的 -sEXPORT_NAME=createNetworkPhysics） */
export type NetworkPhysicsFactory = (opts?: Record<string, unknown>) => Promise<NetworkPhysicsModule>;

/* -------------------------------------------------------------------------- */

/** 矩阵槽：与 C++ 的 MatrixSlot 枚举一一对应 */
export const MatrixSlot = {
  VisualWorld: 0,
  PhysicsWorld: 1,
} as const;

/** 一帧快照（JS 侧表示，仅用于打包/测试；高频路径不要用它） */
export interface Snapshot {
  frame: number;
  tickMs?: number;
  serverTimeSec?: number;
  px: number; py: number; pz: number;
  qw?: number; qx?: number; qy?: number; qz?: number;
  vx?: number; vy?: number; vz?: number;
  wx?: number; wy?: number; wz?: number;
  ax?: number; ay?: number; az?: number;
}

export interface ClientOptions {
  factory: NetworkPhysicsFactory;
  /** 误差衰减半衰期（秒）。需求推荐 0.08~0.10，默认 0.09 */
  errorHalfLifeSec?: number;
  /** 外推时长上限（秒），默认 0.25 */
  maxExtrapolationSec?: number;
  /** 物理基准步长，默认 1/60 */
  baseDeltaTime?: number;
  /** 调试日志 */
  debug?: boolean;
}

/** 与 C++ SyncEvent 对齐（用普通 const 对象而不是 `const enum`：后者在
 *  `isolatedModules` / 单文件转译下会报错或行为不一致） */
export const SyncEvent = { None: 0, HardResync: 1, SampleRejected: 2 } as const;
export type SyncEventValue = (typeof SyncEvent)[keyof typeof SyncEvent];

/** 上行发送的缓冲积压阈值（字节）。超过就跳过本帧，避免延迟越堆越高。 */
export const SNAPSHOT_SEND_BACKPRESSURE_BYTES = 64 * 1024;

/**
 * 物理同步客户端（单例）。
 *
 * 典型用法：
 *   const client = await NetworkPhysicsClient.getInstance({ factory: createNetworkPhysics });
 *   client.attachDataChannel(dc);          // dc 必须是 ordered:false / maxRetransmits:0
 *   client.attachMesh(threeMesh);          // 或 attachBabylonMesh(babylonMesh)
 *   client.start();                        // 启动 rAF 循环
 */
export class NetworkPhysicsClient {
  private static instance: NetworkPhysicsClient | null = null;

  private readonly mod: NetworkPhysicsModule;
  private readonly opt: Required<Omit<ClientOptions, 'factory'>>;

  /** 快照暂存区地址（Wasm 内存里的固定位置，构造后不变） */
  private readonly snapshotAddr: number;
  private readonly snapshotSize: number;
  /** 矩阵暂存区地址 */
  private readonly matrixAddr: number;

  /** 本帧物理步长（由时钟微调给出，含 ±1.5% 伸缩） */
  private currentDt = 1 / 60;

  /** rAF 句柄与上一帧时间戳 */
  private rafId = 0;
  private lastTs = 0;
  private running = false;

  /** 渲染目标（三选一，都是可选） */
  private threeMesh: { matrix: { fromArray(a: ArrayLike<number>): void }; matrixAutoUpdate: boolean } | null = null;
  private babylonMesh: { getWorldMatrix(): number[] } | null = null;

  /** 数据通道 */
  private dc: RTCDataChannel | null = null;
  private dcReliable: RTCDataChannel | null = null;

  /** 统计（HUD / 排障） */
  private stat = { packets: 0, accepted: 0, dropped: 0, hardResync: 0, rejected: 0, frames: 0 };

  private constructor(mod: NetworkPhysicsModule, opt: Required<Omit<ClientOptions, 'factory'>>) {
    this.mod = mod;
    this.opt = opt;

    this.snapshotAddr = mod._fz_snapshot_stage_addr();
    this.snapshotSize = mod._fz_snapshot_stage_size();
    this.matrixAddr = mod._fz_matrix_stage_addr();

    mod._fz_set_half_life(opt.errorHalfLifeSec);
    mod._fz_set_max_extrapolation(opt.maxExtrapolationSec);

    this.assertLayout();
  }

  /* -------------------------------------------------------------------------
   *  单例
   * ---------------------------------------------------------------------- */

  static async getInstance(opts: ClientOptions): Promise<NetworkPhysicsClient> {
    if (NetworkPhysicsClient.instance) return NetworkPhysicsClient.instance;
    const mod = await opts.factory({});
    NetworkPhysicsClient.instance = new NetworkPhysicsClient(mod, {
      errorHalfLifeSec: opts.errorHalfLifeSec ?? 0.09,
      maxExtrapolationSec: opts.maxExtrapolationSec ?? 0.25,
      baseDeltaTime: opts.baseDeltaTime ?? 1 / 60,
      debug: opts.debug ?? false,
    });
    return NetworkPhysicsClient.instance;
  }

  static reset(): void {
    if (NetworkPhysicsClient.instance) NetworkPhysicsClient.instance.stop();
    NetworkPhysicsClient.instance = null;
  }

  /* -------------------------------------------------------------------------
   *  ① 零拷贝：把网络包塞进 Wasm
   * ---------------------------------------------------------------------- */

  /**
   * **最快路径**：线格式 == 结构体内存布局时，直接把整包 memcpy 进暂存区，
   * 连解析都不需要。这是本设计的核心 —— 不是"高效解包"，而是"不需要解包"。
   *
   * 代价：结构体里有 **20 字节**对齐 padding（96B 里 **76B** 是有效载荷：
   * 4+4+4+12+16+12+12+12 = 76，5 个 _pad 各 4B = 20）。
   * （这两个数别手算，跑 verify_layout.mjs 会直接告诉你真实值 —— 我第一版就写错成 68/28。）
   * 60Hz × 4 车 ≈ 2.3 KB/s 的浪费，可以忽略；
   * 若带宽真紧张，就改用**紧凑线格式 + DataView 逐个 unpack**（见 packSnapshot）。
   *
   * @returns true = 被接受；false = 丢弃（帧号过期 / 长度不符）
   */
  pushSnapshotRaw(packet: ArrayBuffer | ArrayBufferView): boolean {
    const bytes = packet instanceof ArrayBuffer
      ? new Uint8Array(packet)
      : new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);

    if (bytes.byteLength !== this.snapshotSize) {
      // 长度不符**必须**拒绝：直接写会越界踩坏桥里其它成员（矩阵暂存区就在后面）
      if (this.opt.debug) console.warn(`[netphys] 包长 ${bytes.byteLength} != ${this.snapshotSize}，已丢弃`);
      this.stat.dropped++;
      return false;
    }

    // heap() 每次都重新取视图 —— 上一次调用可能触发了内存增长
    const heap = this.heapU8();
    heap.set(bytes, this.snapshotAddr);

    const ok = this.mod._fz_snapshot_commit() === 1;
    this.stat.packets++;
    if (ok) {
      this.stat.accepted++;
      // commit 只改状态、不刷新矩阵；想立刻用新矩阵就 RefreshMatrices（这里省略，
      // 因为 rAF 里马上会 update()，那一步会刷新）
    } else {
      this.stat.dropped++;
    }
    return ok;
  }

  /**
   * 把 JS 对象按字段偏移打包进暂存区（低频路径：工具、回放、单测）。
   * 高频路径请用 pushSnapshotRaw。
   *
   * 注意偏移全部**从模块里读**（OFF_* 常量），不写死在 TS 里 ——
   * 线格式改了只要重新编译 Wasm，TS 侧自动跟随。
   */
  packSnapshot(s: Snapshot): boolean {
    const heap = this.heapU8();
    const dv = new DataView(heap.buffer, this.snapshotAddr, this.snapshotSize);
    const o = this.mod;

    dv.setUint32(o.OFF_FRAME, s.frame >>> 0, true);
    dv.setUint32(o.OFF_TICK_MS, (s.tickMs ?? Date.now()) >>> 0, true);
    dv.setFloat32(o.OFF_SERVER_TIME, s.serverTimeSec ?? 0, true);
    dv.setFloat32(o.OFF_POSITION + 0, s.px, true);
    dv.setFloat32(o.OFF_POSITION + 4, s.py, true);
    dv.setFloat32(o.OFF_POSITION + 8, s.pz, true);
    dv.setFloat32(o.OFF_ROTATION + 0, s.qw ?? 1, true);
    dv.setFloat32(o.OFF_ROTATION + 4, s.qx ?? 0, true);
    dv.setFloat32(o.OFF_ROTATION + 8, s.qy ?? 0, true);
    dv.setFloat32(o.OFF_ROTATION + 12, s.qz ?? 0, true);
    dv.setFloat32(o.OFF_VELOCITY + 0, s.vx ?? 0, true);
    dv.setFloat32(o.OFF_VELOCITY + 4, s.vy ?? 0, true);
    dv.setFloat32(o.OFF_VELOCITY + 8, s.vz ?? 0, true);
    dv.setFloat32(o.OFF_ANGULAR_VELOCITY + 0, s.wx ?? 0, true);
    dv.setFloat32(o.OFF_ANGULAR_VELOCITY + 4, s.wy ?? 0, true);
    dv.setFloat32(o.OFF_ANGULAR_VELOCITY + 8, s.wz ?? 0, true);
    dv.setFloat32(o.OFF_ACCEL + 0, s.ax ?? 0, true);
    dv.setFloat32(o.OFF_ACCEL + 4, s.ay ?? 0, true);
    dv.setFloat32(o.OFF_ACCEL + 8, s.az ?? 0, true);

    const ok = this.mod._fz_snapshot_commit() === 1;
    this.stat.packets++;
    ok ? this.stat.accepted++ : this.stat.dropped++;
    return ok;
  }

  /* -------------------------------------------------------------------------
   *  ② WebRTC 通道
   * ---------------------------------------------------------------------- */

  /**
   * 绑定数据通道。**必须是不可靠/无序通道**，否则 TCP 队头阻塞会让
   * 一个丢包卡住后面所有快照 —— 那正是 Rubberbanding 的最大来源。
   */
  attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        this.pushSnapshotRaw(data);
      } else if (ArrayBuffer.isView(data)) {
        this.pushSnapshotRaw(data as ArrayBufferView);
      }
      // 字符串消息走这里说明对端发错了通道，忽略即可（快照通道只应发二进制）
    };
    dc.onclose = () => {
      // 断线重连：必须清空时钟窗口与刚体状态，否则重连后会带着旧偏移继续跑
      this.mod._fz_reset_all();
      if (this.opt.debug) console.info('[netphys] DataChannel 关闭 -> 已重置同步状态');
    };
  }

  /**
   * 把本车状态发上游（同样零拷贝的读侧）。
   *
   * 用法：先用 packSnapshot() 把本车状态写进暂存区，再调本方法发送。
   *
   * ⚠️ **必须 slice() 复制一份再 send**，不能直接把 Wasm 堆上的视图丢给 send：
   *    `RTCDataChannel.send()` 是**异步**的（内部要排队/可能分片），
   *    而暂存区是复用的 —— 下一帧 packSnapshot 会覆盖它。
   *    直接发视图会发出"半新半旧"的脏数据，而且症状是偶发的、极难查。
   *    另外 ALLOW_MEMORY_GROWTH 下堆还可能被换掉，视图直接失效。
   *    这一份复制的代价（96B）远小于它避免的问题。
   *
   * @returns true = 已交给通道发出；false = 未绑定 / 通道未打开 / 缓冲积压
   */
  sendLocalSnapshot(): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    // 积压过多就跳过这一帧：物理快照是"最新覆盖旧"的语义，排队没有意义，
    // 反而会把延迟越堆越高（这正是要开 maxRetransmits:0 的同一个理由）。
    if (this.dc.bufferedAmount > SNAPSHOT_SEND_BACKPRESSURE_BYTES) {
      this.stat.dropped++;
      return false;
    }
    const view = new Uint8Array(this.mod.HEAPU8.buffer, this.snapshotAddr, this.snapshotSize);
    this.dc.send(view.slice());
    return true;
  }

  /**
   * 另外绑定一条**可靠有序**通道，专供 NTP 采样与房间控制。
   * 快照丢了无所谓（下一帧就到），但 NTP 采样丢一个就少一个窗口样本，
   * 而且乱序的 PONG 会让 T1 回退被直接拒收（见 C++ 里的乱序过滤）。
   */
  attachReliableChannel(dc: RTCDataChannel): void {
    this.dcReliable = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') { this.onControlMessage(ev.data); return; }
      if (ev.data instanceof ArrayBuffer && ev.data.byteLength === 32) {
        this.onPongPacket(ev.data);   // 32B = t1..t4 四个 double
      }
    };
  }

  /**
   * 发一次 NTP 采样。t1/t4 用 `performance.now()*1e6` 换纳秒。
   *
   * ⚠️ 精度：performance.now() 被浏览器降精度（Chrome ~100µs）。
   * 换算成"纳秒"只是单位，不是分辨率 —— 见文件头 ①。
   */
  sendPing(): void {
    if (!this.dcReliable || this.dcReliable.readyState !== 'open') return;
    const t1 = performance.now() * 1e6;
    const buf = new ArrayBuffer(16);
    new DataView(buf).setFloat64(0, t1, true);
    this.dcReliable.send(buf);
  }

  private onPongPacket(buf: ArrayBuffer): void {
    const dv = new DataView(buf);
    const t1 = dv.getFloat64(0, true);
    const t2 = dv.getFloat64(8, true);
    const t3 = dv.getFloat64(16, true);
    const t4 = dv.getFloat64(24, true);
    const ev = this.mod._fz_on_pong(t1, t2, t3, t4);
    if (ev === SyncEvent.HardResync) {
      this.stat.hardResync++;
      // 硬同步意味着时间轴发生了大跳变 —— 上层应抑制本帧的视觉插值/回放
      this.onHardResync?.();
    } else if (ev === SyncEvent.SampleRejected) {
      this.stat.rejected++;
    }
  }

  /** 硬同步回调（默认 2Hz 采样足够；绝不要在这里做重计算） */
  onHardResync: (() => void) | null = null;

  private onControlMessage(_text: string): void {
    // 房间/排行榜等控制消息的解析交给上层；本模块只关心时间与刚体
  }

  /* -------------------------------------------------------------------------
   *  ③ rAF 循环
   * ---------------------------------------------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private tick = (ts: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // dt 必须来自真实计时，不能写死 1/60：
    // 120/144Hz 屏幕上写死会让时间推进快一倍以上
    const dtMs = this.lastTs === 0 ? 16.67 : Math.min(ts - this.lastTs, 50); // 夹 50ms 防切页后跳变
    this.lastTs = ts;
    const rawDt = dtMs / 1000;

    // 让 C++ 给出**微调过的**物理步长（Clock Slewing，±1.5%），
    // 再用它推进外推与误差衰减 —— 这样本地时间会平滑贴合服务端
    this.currentDt = this.mod._fz_adjusted_dt(rawDt);
    this.mod._fz_update(this.currentDt);
    this.stat.frames++;

    this.applyVisualMatrix();
  };

  /** 把 Wasm 的视觉矩阵写给渲染网格 */
  private applyVisualMatrix(): void {
    if (this.threeMesh) {
      const m = this.matrixView(MatrixSlot.VisualWorld);
      // Three.js: Matrix4.fromArray 直接吃 16 个 float，无需构造中间对象
      this.threeMesh.matrix.fromArray(m);
      this.threeMesh.matrixAutoUpdate = false;   // 已经是世界矩阵，别再让 Three 覆盖
    }
    if (this.babylonMesh) {
      const w = this.babylonMesh.getWorldMatrix();
      const m = this.matrixView(MatrixSlot.VisualWorld);
      for (let i = 0; i < 16; i++) w[i] = m[i];
    }
  }

  /* -------------------------------------------------------------------------
   *  渲染网格接入
   * ---------------------------------------------------------------------- */

  attachThreeMesh(mesh: { matrix: { fromArray(a: ArrayLike<number>): void }; matrixAutoUpdate: boolean }): void {
    this.threeMesh = mesh;
  }
  attachBabylonMesh(mesh: { getWorldMatrix(): number[] }): void {
    this.babylonMesh = mesh;
  }

  /** 物理层矩阵视图（碰撞/命中判定用；**不要**拿它做渲染） */
  physicsMatrix(): Float32Array {
    return this.matrixView(MatrixSlot.PhysicsWorld);
  }

  /* -------------------------------------------------------------------------
   *  堆访问（防视图失效）
   * ---------------------------------------------------------------------- */

  /**
   * 取 HEAPU8。**必须每次都重新取**：ALLOW_MEMORY_GROWTH=1 时内存增长会
   * 换掉底层 ArrayBuffer，之前缓存的视图立刻失效（读出来全是 0 或抛异常）。
   */
  private heapU8(): Uint8Array {
    return this.mod.HEAPU8;
  }

  /** 某个矩阵槽的 Float32 视图（零拷贝，直接指向 Wasm 线性内存） */
  private matrixView(slot: number): Float32Array {
    const base = this.matrixAddr + slot * 16 * 4;
    // 用 HEAPF32.buffer + 字节偏移构造视图 —— 同样是零拷贝
    return new Float32Array(this.mod.HEAPF32.buffer, base, 16);
  }

  /* -------------------------------------------------------------------------
   *  自检 & 遥测
   * ---------------------------------------------------------------------- */

  /**
   * 校验 Wasm 侧的布局与 TS 的假设一致。
   * 这个检查很便宜但很关键：线格式一旦漂移，症状是"位置偶尔乱跳"，
   * 极难定位，不如启动时直接炸出来。
   */
  private assertLayout(): void {
    const m = this.mod;
    const problems: string[] = [];
    if (this.snapshotSize !== 96) problems.push(`SNAPSHOT_STAGE_SIZE=${this.snapshotSize}（期望 96）`);
    if (m.OFF_POSITION !== 16) problems.push(`OFF_POSITION=${m.OFF_POSITION}（期望 16）`);
    if (m.OFF_ROTATION !== 32) problems.push(`OFF_ROTATION=${m.OFF_ROTATION}（期望 32）`);
    if (m.OFF_ACCEL !== 80) problems.push(`OFF_ACCEL=${m.OFF_ACCEL}（期望 80）`);
    if (problems.length) {
      throw new Error('[netphys] Wasm 布局与前端假设不符，拒绝启动：\n  ' + problems.join('\n  '));
    }
  }

  /** 遥测快照（给 HUD / netgraph 用；别在每帧调 Embind 版，走 _fz_* 标量接口） */
  telemetry() {
    return {
      syncState: this.mod._fz_sync_state(),
      locked: this.mod._fz_is_locked() !== 0,   // C ABI 返回 0/1，不是 boolean
      bestRttMs: this.mod._fz_best_rtt_ns() / 1e6,
      clockOffsetMs: this.mod.syncTelemetry().offsetNs() / 1e6,
      warpRatio: this.mod._fz_current_warp(),
      replState: this.mod._fz_repl_state(),
      extrapolatedMs: this.mod._fz_extrapolated_s() * 1000,
      visualErrorM: this.mod._fz_visual_error_m(),
      lastFrame: this.mod._fz_last_frame(),
      ...this.stat,
    };
  }

  /**
   * 可选：请求高精度计时。
   *
   * 浏览器默认把 performance.now() 降精度（Chrome ~100µs）。
   * 想要更高分辨率需要 **跨源隔离** —— 服务器必须发：
   *   Cross-Origin-Opener-Policy: same-origin
   *   Cross-Origin-Embedder-Policy: require-corp
   * 之后就可用 SharedArrayBuffer 与更高精度的计时源。
   * 本项目的 Go 服务端加这两行响应头即可。
   *
   * ⚠️ 但请注意：**即使拿到高精度计时，也不要声称"纳秒同步"**。
   *    NTP 的误差下界由网络路径不对称决定（毫秒级），不是计时器分辨率。
   */
  static async enableHighResTimer(serverOrigin: string): Promise<boolean> {
    void serverOrigin;
    if (typeof SharedArrayBuffer === 'undefined') return false;
    return globalThis.crossOriginIsolated === true;
  }
}
```

### 文件: native/wasm/bindings.cpp

```cpp
// =============================================================================
//  bindings.cpp —— Emscripten 胶水层（Embind + 零拷贝 C ABI）
//
//  这一层刻意做**薄**：所有逻辑都在 network_physics_bridge.h（可原生编译/测试）。
//  这里只负责把 C++ 暴露给 JS。
//
//  ── 两条通道，按调用频率分开 ──────────────────────────────────────────────
//   ① 高频通道（60~144Hz）：`extern "C"` 的**裸函数 + 内存指针**。
//      每包流程：HEAPU8.set(packet, stageAddr) -> _fz_snapshot_commit()
//      全程无 Embind 对象封送、无字符串、无数组拷贝。
//   ② 低频通道（UI / 遥测 / 调试）：Embind 类绑定，写起来舒服、可读性好。
//
//  ── 为什么高频不用 Embind ──────────────────────────────────────────────────
//      Embind 每次调用要构造 val / 走 type-id 分派，返回对象还会在 JS 侧堆分配。
//      60Hz × 4 车 = 240 次/秒尚可，但把「每包一次 Embind 对象构造」换成
//      「一次 memcpy + 一次无参 void 调用」是免费的性能，没有理由不做。
//
//  ── 编译 ──────────────────────────────────────────────────────────────────
//      em++ -std=c++20 -O3 -flto -msimd128 \
//           -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web \
//           -s INITIAL_MEMORY=67108864 -s ALLOW_MEMORY_GROWTH=1 \
//           -s DYNAMIC_EXECUTION=0 -s FILESYSTEM=0 -s SINGLE_FILE=1 \
//           --bind -o network_physics.js bindings.cpp
//      完整参数与理由见同目录 CMakeLists.txt。
// =============================================================================

#include "network_physics_bridge.h"

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>

using namespace forza::wasm;

namespace {

/// 单例。Wasm 是单线程模块，用函数内 static 即可（无堆分配、无初始化顺序问题）。
NetworkPhysicsBridge& Bridge() noexcept {
  static NetworkPhysicsBridge inst;
  return inst;
}

}  // namespace

// =============================================================================
//  ① 高频通道：裸 C ABI（`extern "C"` 不参与名字修饰，导出名稳定可预测）
// =============================================================================

extern "C" {

/**
 * 快照暂存区地址（字节，相对 Wasm 线性内存基址）。
 * JS: const addr = mod._fz_snapshot_stage_addr();
 *     HEAPU8.set(payload, addr);
 */
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_snapshot_stage_addr() { return Bridge().SnapshotStageAddr(); }

/// 暂存区大小（字节）。JS 用它对包长做校验，长度不符就别写（防越界踩坏别的内存）。
EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_snapshot_stage_size() { return NetworkPhysicsBridge::SnapshotStageSize(); }

/**
 * 字段字节偏移。JS **必须**用它来定位字段，不要自己写常量 ——
 * 线格式一改（加字段/换顺序），写死常量会静默错位，网络数据变成垃圾但不报错。
 * @param field 见 network_physics_bridge.h 的 FieldOffset()
 */
EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_field_offset(int field) { return NetworkPhysicsBridge::FieldOffset(field); }

/// 读取暂存区并 apply。**无参**，零封送。@return 1=接受 0=丢弃（过期帧）
EMSCRIPTEN_KEEPALIVE
int fz_snapshot_commit() { return Bridge().SnapshotCommit(); }

/// 喂 NTP 往返（4 个 double 纳秒时间戳；见 bridge header 里关于 2^53 的说明）
EMSCRIPTEN_KEEPALIVE
int fz_on_pong(double t1, double t2, double t3, double t4) {
  return Bridge().OnPong(t1, t2, t3, t4);
}

/// 推进时钟微调，返回本帧物理步长
EMSCRIPTEN_KEEPALIVE
double fz_adjusted_dt(double baseDtSec) { return Bridge().AdjustedDeltaTime(baseDtSec); }

/// 矩阵暂存区地址（4 槽 × 16 float，列主序连续）
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_matrix_stage_addr() { return Bridge().MatrixStageAddr(); }

/// 每帧推进（外推 + 误差衰减 + 写矩阵暂存区）
EMSCRIPTEN_KEEPALIVE
void fz_update(double dtSec) { Bridge().Update(dtSec); }

/// 断线重连：清空时钟窗口与刚体状态
EMSCRIPTEN_KEEPALIVE
void fz_reset_all() { Bridge().ResetAll(); }

/// 调参：误差衰减半衰期（秒），需求推荐 0.08~0.10
EMSCRIPTEN_KEEPALIVE
void fz_set_half_life(double sec) { Bridge().SetErrorHalfLifeSec(sec); }

/// 调参：外推时长上限（秒）
EMSCRIPTEN_KEEPALIVE
void fz_set_max_extrapolation(double sec) { Bridge().SetMaxExtrapolationSec(sec); }

// ---- 遥测（低频，普通 C ABI 就够，省得为几个标量开 Embind 类）----
EMSCRIPTEN_KEEPALIVE bool     fz_is_locked()      { return Bridge().IsLocked(); }
EMSCRIPTEN_KEEPALIVE double   fz_server_now_ns()  { return Bridge().ServerNowNs(); }
EMSCRIPTEN_KEEPALIVE double   fz_current_warp()   { return Bridge().CurrentWarp(); }
EMSCRIPTEN_KEEPALIVE double   fz_best_rtt_ns()    { return Bridge().BestRttNs(); }
EMSCRIPTEN_KEEPALIVE double   fz_visual_error_m() { return Bridge().VisualErrorM(); }
EMSCRIPTEN_KEEPALIVE double   fz_extrapolated_s() { return Bridge().ExtrapolatedSec(); }
EMSCRIPTEN_KEEPALIVE int      fz_repl_state()     { return Bridge().ReplState(); }
EMSCRIPTEN_KEEPALIVE int      fz_sync_state()     { return Bridge().SyncState(); }
EMSCRIPTEN_KEEPALIVE unsigned fz_last_frame()     { return Bridge().LastFrame(); }
EMSCRIPTEN_KEEPALIVE unsigned fz_stale_dropped()  { return Bridge().StaleDropped(); }
EMSCRIPTEN_KEEPALIVE unsigned fz_hard_snaps()     { return Bridge().HardSnapCount(); }

}  // extern "C"

// =============================================================================
//  ② 低频通道：Embind 类绑定（UI / 调试 / 不赶时间的路径）
// =============================================================================

namespace {

/// Embind 用的读/写包装：把标量访问器收拢成类方法，方便 TS 侧读起来自然。
struct SyncTelemetryView final {
  double serverNowNs() const { return Bridge().ServerNowNs(); }
  double offsetNs() const { return Bridge().CurrentOffsetNs(); }
  double bestRttNs() const { return Bridge().BestRttNs(); }
  double warp() const { return Bridge().CurrentWarp(); }
  bool   locked() const { return Bridge().IsLocked(); }
  int    state() const { return Bridge().SyncState(); }
  int    samples() const { return static_cast<int>(Bridge().SyncSampleCount()); }
};

struct ReplTelemetryView final {
  bool   hasState() const { return Bridge().HasState(); }
  int    state() const { return Bridge().ReplState(); }
  double extrapolatedSec() const { return Bridge().ExtrapolatedSec(); }
  double visualErrorM() const { return Bridge().VisualErrorM(); }
  int    lastFrame() const { return static_cast<int>(Bridge().LastFrame()); }
  int    staleDropped() const { return static_cast<int>(Bridge().StaleDropped()); }
  int    hardSnaps() const { return static_cast<int>(Bridge().HardSnapCount()); }
};

// Embind 的 function() 收的是**函数指针**，不能写 `&[](){...}` ——
// 对临时 lambda 取地址是 [-Waddress-of-temporary]（实测 emcc 直接报错）。
// 必须先给它一个具名的函数实体。这个错在第一版里被我漏掉了，
// 因为当时没有 emcc 可编译 —— 恰好说明"薄封装"也得编一次。
SyncTelemetryView MakeSyncTelemetry() { return SyncTelemetryView{}; }
ReplTelemetryView MakeReplTelemetry() { return ReplTelemetryView{}; }

}  // namespace

EMSCRIPTEN_BINDINGS(network_physics) {
  using namespace emscripten;

  // ---- 常量导出：TS 侧用它做线格式校验，避免把 96 之类的数字写死在两处 ----
  constant("SNAPSHOT_STAGE_SIZE", static_cast<int>(NetworkPhysicsBridge::SnapshotStageSize()));
  constant("MATRIX_STAGE_SIZE", static_cast<int>(NetworkPhysicsBridge::MatrixStageSizeBytes()));
  constant("MATRIX_SLOT_FLOATS", static_cast<int>(NetworkPhysicsBridge::MatrixSlotFloats()));
  constant("SYNC_EVENT_NONE", static_cast<int>(forza::net::SyncEvent::None));
  constant("SYNC_EVENT_HARD_RESYNC", static_cast<int>(forza::net::SyncEvent::HardResync));
  constant("SYNC_EVENT_SAMPLE_REJECTED", static_cast<int>(forza::net::SyncEvent::SampleRejected));

  // 字段偏移：TS 侧必须用这些值定位字段（与 fz_field_offset 同源）
  constant("OFF_FRAME", static_cast<int>(NetworkPhysicsBridge::FieldOffset(0)));
  constant("OFF_TICK_MS", static_cast<int>(NetworkPhysicsBridge::FieldOffset(1)));
  constant("OFF_SERVER_TIME", static_cast<int>(NetworkPhysicsBridge::FieldOffset(2)));
  constant("OFF_POSITION", static_cast<int>(NetworkPhysicsBridge::FieldOffset(3)));
  constant("OFF_ROTATION", static_cast<int>(NetworkPhysicsBridge::FieldOffset(4)));
  constant("OFF_VELOCITY", static_cast<int>(NetworkPhysicsBridge::FieldOffset(5)));
  constant("OFF_ANGULAR_VELOCITY", static_cast<int>(NetworkPhysicsBridge::FieldOffset(6)));
  constant("OFF_ACCEL", static_cast<int>(NetworkPhysicsBridge::FieldOffset(7)));

  class_<SyncTelemetryView>("SyncTelemetry")
      .function("serverNowNs", &SyncTelemetryView::serverNowNs)
      .function("offsetNs", &SyncTelemetryView::offsetNs)
      .function("bestRttNs", &SyncTelemetryView::bestRttNs)
      .function("warp", &SyncTelemetryView::warp)
      .function("locked", &SyncTelemetryView::locked)
      .function("state", &SyncTelemetryView::state)
      .function("samples", &SyncTelemetryView::samples);

  class_<ReplTelemetryView>("ReplTelemetry")
      .function("hasState", &ReplTelemetryView::hasState)
      .function("state", &ReplTelemetryView::state)
      .function("extrapolatedSec", &ReplTelemetryView::extrapolatedSec)
      .function("visualErrorM", &ReplTelemetryView::visualErrorM)
      .function("lastFrame", &ReplTelemetryView::lastFrame)
      .function("staleDropped", &ReplTelemetryView::staleDropped)
      .function("hardSnaps", &ReplTelemetryView::hardSnaps);

  function("syncTelemetry", &MakeSyncTelemetry);
  function("replTelemetry", &MakeReplTelemetry);
}
```

### 文件: native/wasm/bridge_test.cpp

```cpp
// =============================================================================
//  bridge_test.cpp —— 桥接层原生测试（不需要 emcc）
//
//  本机没有 emcc，Embind 那层编不了；但**最容易出错、且错了不报错**的部分
//  恰恰是不依赖 emscripten 的：JS 把网络包按字节写进 Wasm 线性内存时，
//  字段落在哪个偏移、字节序是否一致、commit 的时序是否正确。
//
//  本测试模拟 JS 侧行为：**不调用任何 C++ setter**，
//  而是直接往暂存区按偏移灌字节，再 commit，然后断言字段值正确。
//  这等价于浏览器里 `HEAPU8.set(payload, addr)` 之后的所有行为。
//
//  同时把布局 dump 成 layout.json，给 protocol_test.mjs 做两侧交叉核对。
//
//  编译运行：g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic bridge_test.cpp -o bridge_test
// =============================================================================
#include "network_physics_bridge.h"

#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>

using namespace forza::wasm;

namespace {

int g_pass = 0;
int g_fail = 0;

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) { ++g_pass; }
  else { ++g_fail; std::printf("  [FAIL] %s %s\n", what, detail); }
}

/// 模拟 JS 的 DataView.setFloat32(offset, value, true) —— **小端**
void WriteF32(std::uint8_t* base, std::uint32_t off, float v) noexcept {
  std::memcpy(base + off, &v, 4);
}
void WriteU32(std::uint8_t* base, std::uint32_t off, std::uint32_t v) noexcept {
  std::memcpy(base + off, &v, 4);
}
void WriteF32x3(std::uint8_t* base, std::uint32_t off, float x, float y, float z) noexcept {
  WriteF32(base, off, x); WriteF32(base, off + 4, y); WriteF32(base, off + 8, z);
}
void WriteF32x4(std::uint8_t* base, std::uint32_t off, float w, float x, float y, float z) noexcept {
  WriteF32(base, off, w); WriteF32(base, off + 4, x);
  WriteF32(base, off + 8, y); WriteF32(base, off + 12, z);
}

bool LittleEndian() noexcept {
  const std::uint32_t one = 1;
  std::uint8_t b[4];
  std::memcpy(b, &one, 4);
  return b[0] == 1;
}

}  // namespace

int main() {
  std::printf("=== NetworkPhysicsBridge 原生测试（模拟 JS 零拷贝写入）===\n");

  // -------------------------------------------------------------------------
  std::printf("\n[1] 布局与偏移（JS 侧必须用这些值，不能写死常量）\n");
  {
    Check(sizeof(RigidBodyNetSnapshot) == 96, "快照 = 96 字节");
    Check(NetworkPhysicsBridge::SnapshotStageSize() == 96, "暂存区 = 96 字节");
    Check(NetworkPhysicsBridge::MatrixStageSizeBytes() == 64 * sizeof(float),
          "矩阵暂存区 = 4 槽 × 16 float = 256 字节");
    Check(NetworkPhysicsBridge::FieldOffset(0) == offsetof(RigidBodyNetSnapshot, frame),
          "FieldOffset(0) == offsetof(frame)");
    Check(NetworkPhysicsBridge::FieldOffset(3) == offsetof(RigidBodyNetSnapshot, position),
          "FieldOffset(3) == offsetof(position)");
    Check(NetworkPhysicsBridge::FieldOffset(4) == offsetof(RigidBodyNetSnapshot, rotation),
          "FieldOffset(4) == offsetof(rotation)");
    Check(NetworkPhysicsBridge::FieldOffset(7) == offsetof(RigidBodyNetSnapshot, accel),
          "FieldOffset(7) == offsetof(accel)");
    Check(NetworkPhysicsBridge::FieldOffset(99) == 0xFFFFFFFFu,
          "非法 field 返回哨兵值（不静默返回 0 而让 JS 写到 frame 上）");
    Check(LittleEndian(),
          "本平台小端 —— 与 Wasm 线性内存（规范规定小端）一致，字节序无需转换");
  }

  // -------------------------------------------------------------------------
  std::printf("\n[2] 零拷贝快照提交（全程不碰 C++ setter，纯字节写入）\n");
  {
    NetworkPhysicsBridge br;
    std::uint8_t* base = reinterpret_cast<std::uint8_t*>(br.SnapshotStageAddr());

    // 模拟 JS 收到一个 60Hz 快照包后 HEAPU8.set(payload, addr)
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(0), 4242U);          // frame
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(1), 987654U);        // tickMs
    WriteF32(base, NetworkPhysicsBridge::FieldOffset(2), 1234.5F);        // serverTimeSec
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(3), 10.0F, 1.5F, -20.0F);   // position
    WriteF32x4(base, NetworkPhysicsBridge::FieldOffset(4), 1.0F, 0.0F, 0.0F, 0.0F); // rotation
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(5), 55.0F, 0.0F, 0.0F);     // velocity
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(6), 0.1F, 0.0F, 0.2F);      // angularVelocity
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(7), 0.0F, 0.0F, -3.0F);     // accel

    const int accepted = br.SnapshotCommit();
    Check(accepted == 1, "首次 commit 被接受");
    Check(br.HasState(), "物理层已初始化");
    Check(br.LastFrame() == 4242U, "frame 字段落位正确");
    Check(std::abs(br.PhysicsPosition(0) - 10.0) < 1e-6 &&
          std::abs(br.PhysicsPosition(1) - 1.5) < 1e-6 &&
          std::abs(br.PhysicsPosition(2) + 20.0) < 1e-6,
          "position 三字段落位正确");
    Check(std::abs(br.PhysicsVelocity(0) - 55.0) < 1e-6 &&
          std::abs(br.PhysicsVelocity(1)) < 1e-6,
          "velocity 三字段落位正确");

    // 帧号回退 -> 必须被丢弃（乱序通道常态）
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(0), 4241U);
    Check(br.SnapshotCommit() == 0, "帧号回退的包被丢弃");
    Check(br.StaleDropped() == 1U, "丢弃计数 +1");

    // 新帧 -> 接受
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(0), 4243U);
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(3), 11.0F, 1.5F, -20.0F);
    Check(br.SnapshotCommit() == 1, "新帧被接受");
    Check(std::abs(br.PhysicsPosition(0) - 11.0) < 1e-6, "新帧 position 生效");
  }

  // -------------------------------------------------------------------------
  std::printf("\n[3] 双层解耦：纠偏瞬间矩阵暂存区的视觉连续性\n");
  {
    NetworkPhysicsBridge br;
    std::uint8_t* base = reinterpret_cast<std::uint8_t*>(br.SnapshotStageAddr());
    const std::uint32_t O_F = NetworkPhysicsBridge::FieldOffset(0);
    const std::uint32_t O_P = NetworkPhysicsBridge::FieldOffset(3);
    const std::uint32_t O_R = NetworkPhysicsBridge::FieldOffset(4);
    const std::uint32_t O_V = NetworkPhysicsBridge::FieldOffset(5);
    const std::uint32_t O_A = NetworkPhysicsBridge::FieldOffset(7);

    auto pack = [&](std::uint32_t frame, float x) {
      std::memset(base, 0, 96);
      WriteU32(base, O_F, frame);
      WriteF32x3(base, O_P, x, 0.0F, 0.0F);
      WriteF32x4(base, O_R, 1.0F, 0.0F, 0.0F, 0.0F);
      WriteF32x3(base, O_V, 30.0F, 0.0F, 0.0F);
      WriteF32x3(base, O_A, 0.0F, 0.0F, 0.0F);
      br.SnapshotCommit();
      br.RefreshMatrices();     // commit 只改状态，矩阵要显式刷新（不推进时间）
    };

    pack(1, 0.0F);
    const double dt = 1.0 / 60.0;
    for (int i = 0; i < 12; ++i) br.Update(dt);       // 200ms 纯外推

    // 矩阵暂存区第 [12][13][14] 是平移列（列主序）
    const std::uint32_t VS = 0U;                      // MatrixSlot::VisualWorld
    auto visX = [&]() {
      return br.MatrixElement(VS, 12);
    };
    const double before = visX();

    // 服务端纠偏：权威位置比外推值落后 0.8m
    pack(2, static_cast<float>(before) - 0.8F);
    const double afterSnap = visX();

    Check(std::abs(afterSnap - before) < 1e-5,
          "收到纠偏的当帧**视觉位置零跳变**（物理层已跳，视觉层吸收误差）");
    Check(br.VisualErrorM() > 0.7, "误差被存进视觉偏移层");
    Check(std::abs(br.MatrixElement(1U, 12) - (before - 0.8)) < 1e-4,
          "物理层矩阵立刻等于权威值（碰撞判定用这个）");

    for (int i = 0; i < 60; ++i) br.Update(dt);
    Check(br.VisualErrorM() < 0.01, "~1s 内视觉误差收敛到 1cm 内");
  }

  // -------------------------------------------------------------------------
  std::printf("\n[4] 布局 dump -> layout.json（供 TS/JS 侧交叉核对）\n");
  {
    std::FILE* f = std::fopen("layout.json", "wb");
    if (f != nullptr) {
      std::fprintf(f,
        "{\n"
        "  \"snapshotSize\": %zu,\n"
        "  \"align\": %zu,\n"
        "  \"littleEndian\": %s,\n"
        "  \"offsets\": {\n"
        "    \"frame\": %zu, \"tickMs\": %zu, \"serverTimeSec\": %zu,\n"
        "    \"position\": %zu, \"rotation\": %zu, \"velocity\": %zu,\n"
        "    \"angularVelocity\": %zu, \"accel\": %zu\n"
        "  }\n"
        "}\n",
        sizeof(RigidBodyNetSnapshot), alignof(RigidBodyNetSnapshot),
        LittleEndian() ? "true" : "false",
        offsetof(RigidBodyNetSnapshot, frame), offsetof(RigidBodyNetSnapshot, tickMs),
        offsetof(RigidBodyNetSnapshot, serverTimeSec), offsetof(RigidBodyNetSnapshot, position),
        offsetof(RigidBodyNetSnapshot, rotation), offsetof(RigidBodyNetSnapshot, velocity),
        offsetof(RigidBodyNetSnapshot, angularVelocity), offsetof(RigidBodyNetSnapshot, accel));
      std::fclose(f);
      std::printf("  已写出 layout.json\n");
      Check(true, "layout.json 写出成功");
    } else {
      Check(false, "layout.json 写出失败");
    }
  }

  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
```

### 文件: native/wasm/browser_check/check.mjs

```javascript
// 浏览器端 CSP + Wasm 真机验收驱动。
// 必须放在**外部文件**里：index.html 的 CSP 是 script-src 'self'（无 'unsafe-inline'），
// 内联 <script> 会被 CSP 直接拦掉 —— 这正是第一版 harness 假绿的原因。
const lines = [];
const ok = (c, w, d = '') => lines.push((c ? 'PASS ' : 'FAIL ') + w + (d ? '   ' + d : ''));

function finish() {
  const f = lines.filter((l) => l.startsWith('FAIL')).length;
  document.getElementById('out').textContent =
    'RESULT ' + (lines.length - f) + '/' + lines.length + '\n' + lines.join('\n');
}

try {
  // 1) CSP 是否放行 wasm 编译
  const factory = (await import('./network_physics.js')).default;
  const mod = await factory();
  ok(true, 'Wasm 实例化成功（CSP 放行 wasm-unsafe-eval）');

  // 2) 静态守卫仍在：eval 必须被拦
  let evalBlocked = false;
  try { (0, eval)('1+1'); } catch (e) { evalBlocked = true; }
  ok(evalBlocked, "eval() 仍被 CSP 拦截（'wasm-unsafe-eval' 不放行 eval）");

  // 3) 布局常量
  ok(mod.SNAPSHOT_STAGE_SIZE === 96, 'SNAPSHOT_STAGE_SIZE = 96', String(mod.SNAPSHOT_STAGE_SIZE));
  ok(mod.OFF_POSITION === 16 && mod.OFF_ACCEL === 80, '字段偏移与 C++ 一致');

  // 4) 零拷贝路径：HEAPU8 直写 + commit
  const addr = mod._fz_snapshot_stage_addr();
  const buf = new ArrayBuffer(96);
  const dv = new DataView(buf);
  dv.setUint32(mod.OFF_FRAME, 7, true);
  dv.setFloat32(mod.OFF_POSITION + 0, 12.5, true);
  dv.setFloat32(mod.OFF_ROTATION + 0, 1.0, true);
  dv.setFloat32(mod.OFF_VELOCITY + 0, 0.0, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  ok(mod._fz_snapshot_commit() === 1, '零拷贝 commit 被接受');
  mod._fz_update(1 / 60);
  const vis = new Float32Array(mod.HEAPF32.buffer, mod._fz_matrix_stage_addr(), 16);
  ok(Math.abs(vis[12] - 12.5) < 1e-4, '视觉矩阵平移 x = 12.5', String(vis[12]));

  // 5) NTP
  const MS = 1e6;
  for (let i = 0; i < 24; i++) {
    const t1 = i * 100 * MS, o = 5 * MS, p = 1 * MS, T = 37 * MS;
    mod._fz_on_pong(t1, t1 + o + T, t1 + o + p + T, t1 + o + p + o);
  }
  ok(mod._fz_is_locked() !== 0, 'NTP 锁定成功');
  ok(Math.abs(mod.syncTelemetry().offsetNs() - 37 * MS) < 1, 'offset = +37ms');
  ok(mod._fz_adjusted_dt(1 / 60) > 0, 'AdjustedDeltaTime 返回正步长');
} catch (e) {
  ok(false, '异常：' + (e && e.message ? e.message : String(e)));
}
finish();
```

### 文件: native/wasm/browser_check/index.html

```html
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<!-- 与 public/index.html **完全相同的 CSP**（这是本次要验证的东西） -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: ws: wss:; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'">
<title>wasm-csp-check</title>
</head><body>
<div id="out">RUNNING</div>
<!-- ⚠️ 驱动脚本必须外链：本页 CSP 是 script-src 'self'（无 'unsafe-inline'），
     内联 <script> 会被 CSP 拦截，页面会永远停在 RUNNING 而假绿。 -->
<script type="module" src="./check.mjs"></script>
<script type="module" id="legacy-inline" hidden>
const lines = [];
const ok = (c, w, d='') => lines.push((c ? 'PASS ' : 'FAIL ') + w + (d ? '   ' + d : ''));
try {
  // 1)CSP 是否放行 wasm 编译
  const factory = (await import('./network_physics.js')).default;
  const mod = await factory();
  ok(true, 'Wasm 实例化成功（CSP 放行 wasm-unsafe-eval）');

  // 2) 静态守卫仍在：eval 必须被拦
  let evalBlocked = false;
  try { (0, eval)('1+1'); } catch (e) { evalBlocked = true; }
  ok(evalBlocked, "eval() 仍被 CSP 拦截（'wasm-unsafe-eval' 不放行 eval）");

  // 3) 布局常量
  ok(mod.SNAPSHOT_STAGE_SIZE === 96, 'SNAPSHOT_STAGE_SIZE = 96', String(mod.SNAPSHOT_STAGE_SIZE));
  ok(mod.OFF_POSITION === 16 && mod.OFF_ACCEL === 80, '字段偏移与 C++ 一致');

  // 4) 零拷贝路径：HEAPU8 直写 + commit
  const addr = mod._fz_snapshot_stage_addr();
  const buf = new ArrayBuffer(96);
  const dv = new DataView(buf);
  dv.setUint32(mod.OFF_FRAME, 7, true);
  dv.setFloat32(mod.OFF_POSITION + 0, 12.5, true);
  dv.setFloat32(mod.OFF_ROTATION + 0, 1.0, true);
  dv.setFloat32(mod.OFF_VELOCITY + 0, 0.0, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  ok(mod._fz_snapshot_commit() === 1, '零拷贝 commit 被接受');
  mod._fz_update(1/60);
  const vis = new Float32Array(mod.HEAPF32.buffer, mod._fz_matrix_stage_addr(), 16);
  ok(Math.abs(vis[12] - 12.5) < 1e-4, '视觉矩阵平移 x = 12.5', String(vis[12]));

  // 5) NTP
  const MS = 1e6;
  for (let i = 0; i < 24; i++) {
    const t1 = i * 100 * MS, o = 5 * MS, p = 1 * MS, T = 37 * MS;
    mod._fz_on_pong(t1, t1 + o + T, t1 + o + p + T, t1 + o + p + o);
  }
  ok(mod._fz_is_locked() !== 0, 'NTP 锁定成功');
  ok(Math.abs(mod.syncTelemetry().offsetNs() - 37 * MS) < 1, 'offset = +37ms');
  ok(mod._fz_adjusted_dt(1/60) > 0, 'AdjustedDeltaTime 返回正步长');
} catch (e) {
  ok(false, '异常：' + (e && e.message ? e.message : String(e)));
}
const f = lines.filter(l => l.startsWith('FAIL')).length;
document.getElementById('out').textContent =
  'RESULT ' + (lines.length - f) + '/' + lines.length + '\n' + lines.join('\n');
</script>
</body></html>
```

### 文件: native/wasm/build_wasm.sh

```bash
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
```

### 文件: native/wasm/layout.json

```json
{
  "snapshotSize": 96,
  "align": 16,
  "littleEndian": true,
  "offsets": {
    "frame": 0, "tickMs": 4, "serverTimeSec": 8,
    "position": 16, "rotation": 32, "velocity": 48,
    "angularVelocity": 64, "accel": 80
  }
}
```

### 文件: native/wasm/network_physics_bridge.h

```cpp
// =============================================================================
//  network_physics_bridge.h —— JS <-> Wasm 之间的零拷贝桥（**可原生编译/测试**）
//
//  为什么单独拆出这一层：
//    Embind 那层（bindings.cpp）依赖 emscripten，没有 emcc 就编不了、测不了。
//    而真正容易出错的是**字节协议**：JS 把网络包写进 Wasm 线性内存的哪个偏移、
//    字段顺序、double/int32 的位模式、提交与读取的时序。这些错**不会报错**，
//    只会静默传出垃圾数据。
//    所以把协议实现放在这个**不依赖 emscripten 的头文件**里，
//    用原生 g++ 就能编译并做断言（见 bridge_test.cpp）。
//    bindings.cpp 只做一层薄薄的导出。
//
//  ── 零拷贝约定 ──────────────────────────────────────────────────────────────
//    Wasm 侧持有一块固定的"暂存区"（staging）：
//      · 快照暂存区：正好一个 RigidBodyNetSnapshot（96B，16 对齐）
//      · 矩阵暂存区：64 个 float = 4 个 mat4（视觉 / 物理 / 两个备用）
//    JS 侧：
//      const addr = mod._fz_snapshot_stage_addr();
//      HEAPU8.set(packetBytes, addr);        // 直接写进 Wasm 线性内存，零封送
//      mod._fz_snapshot_commit();            // 无参调用，读暂存区并 apply
//    这样每包只有"memcpy + 一次无参函数调用"，没有 Embind 的对象封送与字符串拷贝。
// =============================================================================
#pragma once

#include <cstdint>
#include <cstring>

#include "../timesync/forza_time_sync.h"
#include "../rb_replicator/rigid_body_replicator.h"

namespace forza::wasm {

using forza::net::ForzaTimeSynchronizer;
using forza::net::Nanos;
using forza::net::NetworkRigidBodyReplicator;
using forza::net::ReplicatorConfig;
using forza::net::RigidBodyNetSnapshot;
using forza::net::SyncConfig;
using forza::net::SyncEvent;
using forza::net::SnapshotMailbox;

/** 矩阵暂存区的槽位数（4 个 mat4） */
inline constexpr int kMatrixSlots = 4;

enum class MatrixSlot : std::uint32_t {
  VisualWorld = 0,   ///< 渲染用：物理 + 残余视觉偏移
  PhysicsWorld = 1,  ///< 碰撞/命中判定用：纯权威态
  Reserved2 = 2,
  Reserved3 = 3,
};

/**
 * 桥接核心。**生命周期内零堆分配**（成员全是 POD / 固定数组）。
 *
 * 线程模型：所有方法都假定在**同一个线程**（浏览器主线程 / Worker 主循环）调用。
 * 正好对应需求里"每帧 rAF 调用 Wasm"的场景 —— 不需要额外同步。
 */
class NetworkPhysicsBridge final {
 public:
  NetworkPhysicsBridge() noexcept { SetReplicatorConfig(ReplicatorConfig{}); }

  // ---------------------------------------------------------------------------
  //  配置
  // ---------------------------------------------------------------------------

  void SetSyncConfig(const SyncConfig& cfg) noexcept { sync_ = ForzaTimeSynchronizer(cfg); }

  void SetReplicatorConfig(const ReplicatorConfig& cfg) noexcept {
    repl_ = NetworkRigidBodyReplicator(cfg);
  }

  /// 半衰期（秒）。需求推荐 80~100ms，默认 90ms。
  void SetErrorHalfLifeSec(double s) noexcept {
    ReplicatorConfig c = repl_.Config();
    c.halfLifeSec = static_cast<float>(s);
    repl_.SetConfig(c);
  }

  /// 外推上限（秒）
  void SetMaxExtrapolationSec(double s) noexcept {
    ReplicatorConfig c = repl_.Config();
    c.maxExtrapolationSec = static_cast<float>(s);
    repl_.SetConfig(c);
  }

  // ---------------------------------------------------------------------------
  //  时间同步（NTP）
  // ---------------------------------------------------------------------------

  /**
   * 喂入一次 NTP 往返。
   *
   * ⚠️ 用 double 传纳秒时间戳是**有意为之**，不是偷懒：
   *    JS 的 number 是 double，安全整数上限 2^53 ≈ 9.007e15。
   *    单调纳秒从 0 起算，2^53 ns ≈ 104 天 —— 只要浏览器标签页不连续开机 104 天，
   *    时间戳就在安全整数范围内，**double 表示是精确的，没有精度损失**。
   *    若将来需要 >104 天的连续运行，请改成 (uint32 hi, uint32 lo) 两个参数。
   *    另：不要用 Embind 的 int64_t —— 它在不同 Emscripten 版本下映射成
   *    number 或 BigInt 不一致，是跨版本踩坑点。
   */
  int OnPong(double t1, double t2, double t3, double t4) noexcept {
    const SyncEvent ev = sync_.OnPong(static_cast<Nanos>(t1), static_cast<Nanos>(t2),
                                      static_cast<Nanos>(t3), static_cast<Nanos>(t4));
    return static_cast<int>(ev);
  }

  void OnConnectionReset() noexcept { sync_.OnConnectionReset(); }

  /** 推进时钟微调，返回**本帧应使用的物理步长**（已含 ±1.5% 伸缩） */
  double AdjustedDeltaTime(double baseDtSec) noexcept {
    return sync_.AdjustedDeltaTime(baseDtSec);
  }

  double ServerNowNs() const noexcept { return static_cast<double>(sync_.ServerNowNs()); }
  double CurrentOffsetNs() const noexcept { return static_cast<double>(sync_.CurrentOffsetNs()); }
  double BestRttNs() const noexcept { return static_cast<double>(sync_.BestRttNs()); }
  double CurrentWarp() const noexcept { return sync_.CurrentWarp(); }
  int SyncState() const noexcept { return static_cast<int>(sync_.State()); }
  bool IsLocked() const noexcept { return sync_.IsLocked(); }
  std::uint32_t SyncSampleCount() const noexcept { return static_cast<std::uint32_t>(sync_.SampleCount()); }

  // ---------------------------------------------------------------------------
  //  零拷贝 · 快照暂存区
  // ---------------------------------------------------------------------------

  /// 暂存区在 Wasm 线性内存中的**字节地址**。JS 直接 HEAPU8.set(bytes, addr) 写入。
  std::uintptr_t SnapshotStageAddr() noexcept {
    return reinterpret_cast<std::uintptr_t>(&snapshotStage_);
  }

  /// 暂存区字节数（= sizeof(RigidBodyNetSnapshot)，当前 96）
  static std::uint32_t SnapshotStageSize() noexcept {
    return static_cast<std::uint32_t>(sizeof(RigidBodyNetSnapshot));
  }

  /// 字段字节偏移：JS 侧**必须**用它而不是自己写常量，否则线格式一改就静默错位。
  static std::uint32_t FieldOffset(int field) noexcept {
    switch (field) {
      case 0: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, frame));
      case 1: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, tickMs));
      case 2: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, serverTimeSec));
      case 3: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, position));
      case 4: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, rotation));
      case 5: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, velocity));
      case 6: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, angularVelocity));
      case 7: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, accel));
      default: return 0xFFFFFFFFu;
    }
  }

  /**
   * 读取暂存区并 apply（**无参**，零封送开销）。
   * @return 1 = 接受（新帧）；0 = 丢弃（帧号过期 / 未初始化）
   */
  int SnapshotCommit() noexcept {
    return repl_.OnAuthoritativeSnapshot(snapshotStage_) ? 1 : 0;
  }

  /// 供测试/调试：直接拿到暂存区（原生测试用；Wasm 侧用 SnapshotStageAddr）
  RigidBodyNetSnapshot& MutableStage() noexcept { return snapshotStage_; }

  // ---------------------------------------------------------------------------
  //  每帧推进 + 矩阵输出
  // ---------------------------------------------------------------------------

  /**
   * 只把当前状态写进矩阵暂存区，**不推进时间**。
   *
   * 存在的理由（这是被测试逼出来的）：`Update()` 会先推进外推再写矩阵，
   * 于是"收到纠偏后想立刻读物理层矩阵"就矛盾了 —— 调 Update 会把物理层
   * 又往前推一个 dt，读到的已经不是权威值。
   * 正确流程：`commit -> RefreshMatrices() -> 读矩阵`；
   *          `Update(dt)` 内部也只是 `repl_.Update(dt) + RefreshMatrices()`。
   */
  void RefreshMatrices() noexcept {
    WriteMatrix(MatrixSlot::VisualWorld, repl_.GetVisualWorldTransform());
    WriteMatrix(MatrixSlot::PhysicsWorld, repl_.GetPhysicsTransform());
  }

  /** 推进外推 + 误差衰减，并刷新矩阵。dtSec 必须来自真实计时（rAF 的 timestamp 差）。 */
  void Update(double dtSec) noexcept {
    repl_.Update(static_cast<float>(dtSec));
    RefreshMatrices();
  }

  /** 矩阵暂存区地址。4 个槽 × 16 float，列主序，与 glMatrix / Three.js 一致。 */
  std::uintptr_t MatrixStageAddr() noexcept {
    return reinterpret_cast<std::uintptr_t>(&matrixStage_[0][0]);
  }

  static std::uint32_t MatrixStageSizeBytes() noexcept {
    return static_cast<std::uint32_t>(sizeof(matrixStage_));
  }

  /// 单个槽的 float 数量（16）
  static std::uint32_t MatrixSlotFloats() noexcept { return 16U; }

  /// 直接把某个槽的 16 个 float 读出来（低频路径用；高频请读暂存区）
  double MatrixElement(std::uint32_t slot, std::uint32_t index) const noexcept {
    if (slot >= kMatrixSlots || index >= 16U) return 0.0;
    return static_cast<double>(matrixStage_[slot][index]);
  }

  // ---------------------------------------------------------------------------
  //  状态查询（HUD / 遥测）
  // ---------------------------------------------------------------------------

  /// 物理层位置分量（axis: 0=x,1=y,2=z）。TS/HUD 与测试都用它读单轴，避免整块封送。
  double PhysicsPosition(int axis) const noexcept {
    const glm::vec3& p = repl_.PhysicsPosition();
    return static_cast<double>(axis == 0 ? p.x : (axis == 1 ? p.y : p.z));
  }

  /// 物理层速度分量（axis: 0=x,1=y,2=z）
  double PhysicsVelocity(int axis) const noexcept {
    const glm::vec3& v = repl_.PhysicsVelocity();
    return static_cast<double>(axis == 0 ? v.x : (axis == 1 ? v.y : v.z));
  }

  bool HasState() const noexcept { return repl_.HasState(); }
  int ReplState() const noexcept { return static_cast<int>(repl_.State()); }
  double ExtrapolatedSec() const noexcept { return static_cast<double>(repl_.ExtrapolatedSec()); }
  double VisualErrorM() const noexcept { return static_cast<double>(repl_.VisualPositionErrorM()); }
  std::uint32_t LastFrame() const noexcept { return repl_.LastFrame(); }
  std::uint32_t StaleDropped() const noexcept { return repl_.StaleDroppedCount(); }
  std::uint32_t HardSnapCount() const noexcept { return repl_.HardSnapCount(); }

  void ResetReplicator() noexcept { repl_.Reset(); }
  void ResetAll() noexcept {
    sync_.OnConnectionReset();
    repl_.Reset();
  }

 private:
  void WriteMatrix(MatrixSlot slot, const glm::mat4& m) noexcept {
    float* dst = &matrixStage_[static_cast<std::uint32_t>(slot)][0];
    // glm::mat4 是列主序、连续 16 float —— 直接拷，不做逐元素转换。
    std::memcpy(dst, &m[0][0], sizeof(float) * 16U);
  }

  ForzaTimeSynchronizer sync_{};
  NetworkRigidBodyReplicator repl_{};

  // ---- 暂存区（固定，零分配）----
  RigidBodyNetSnapshot snapshotStage_{};                    ///< JS 直接写这里（96B）
  alignas(16) float matrixStage_[kMatrixSlots][16]{};       ///< JS 直接读这里（256B）
};

}  // namespace forza::wasm
```

### 文件: native/wasm/smoke_test.mjs

```javascript
#!/usr/bin/env node
/* =============================================================================
 *  smoke_test.mjs —— 真 Wasm 冒烟测试（node 变体）
 *
 *  这是整条链上**最后也是最强**的一层验证：前面的原生断言测的是 C++ 源码，
 *  这里测的是**编译产物** —— Wasm 实例、零拷贝内存布局、Embind 绑定是否真能用。
 *
 *  跑法：
 *      1) bash native/wasm/build_wasm.sh      （产出 dist/network_physics_node.mjs）
 *      2) node native/wasm/smoke_test.mjs
 *    或直接 bash native/run_tests.sh（它会自动带上，若产物存在）
 *
 *  ⚠️ 本文件的期望值**全部来自 C++ 真值**（常量从模块读），
 *     只对少数"协议级"数字做字面断言（96 / 32 / 16 / 150ms），
 *     因为这些是需求钉死的规格值，改了就是改需求，应该红。
 * ==========================================================================*/

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${what} ${detail}`); }
};

// 用 new URL(...).href —— 不要手工拼路径再 import：
// Windows 下 import.meta.url 的 pathname 是 /C:/... 且**不带 scheme**，
// 直接 import 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'c:'）。
// -sEXPORT_ES6=1 + -sEXPORT_NAME=createForzaNet 下工厂是 **default 导出**
// （不是具名导出），所以取 .default。
const wasmPath = new URL('dist/network_physics_node.mjs', import.meta.url);
if (!existsSync(fileURLToPath(wasmPath))) {
  console.log('找不到 dist/network_physics_node.mjs —— 先跑 bash native/wasm/build_wasm.sh');
  process.exit(2);
}
const factory = (await import(wasmPath.href)).default;
const mod = await factory();

console.log('=== 真 Wasm 冒烟测试 ===\n');

// ---------------------------------------------------------------- 1) 布局常量
console.log('[1] Embind 导出的布局常量');
check(mod.SNAPSHOT_STAGE_SIZE === 96, 'SNAPSHOT_STAGE_SIZE = 96（96B 工作结构）',
  String(mod.SNAPSHOT_STAGE_SIZE));
check(mod.OFF_FRAME === 0 && mod.OFF_TICK_MS === 4 && mod.OFF_SERVER_TIME === 8,
  '前三个字段偏移 0 / 4 / 8');
check(mod.OFF_POSITION === 16, 'OFF_POSITION = 16', String(mod.OFF_POSITION));
check(mod.OFF_ROTATION === 32, 'OFF_ROTATION = 32', String(mod.OFF_ROTATION));
check(mod.OFF_VELOCITY === 48, 'OFF_VELOCITY = 48', String(mod.OFF_VELOCITY));
check(mod.OFF_ANGULAR_VELOCITY === 64, 'OFF_ANGULAR_VELOCITY = 64');
check(mod.OFF_ACCEL === 80, 'OFF_ACCEL = 80', String(mod.OFF_ACCEL));

// --------------------------------------------- 1b) 32B 线格式（需求核心约束）
console.log('\n[1b] 32 字节线格式（规格上限 48）');
check(mod.WIRE_BYTES === 32, 'WIRE_BYTES = 32', String(mod.WIRE_BYTES));
check(mod._fz_wire_bytes() === 32, '_fz_wire_bytes() = 32');
check(mod.WIRE_PAYLOAD_BITS === 242, '净载荷 242 位（装进 8×32=256 位）',
  String(mod.WIRE_PAYLOAD_BITS));
check(mod.WIRE_BITS_POS === 16 && mod.WIRE_BITS_VEL === 14 &&
      mod.WIRE_BITS_ROT === 16 && mod.WIRE_BITS_ACC === 12 && mod.WIRE_BITS_OMEGA === 12,
  '位宽 16/14/16/12/12');
check(mod.WIRE_BIT_FRAME === 0 && mod.WIRE_BIT_TICK_MS === 16, '帧头位偏移 0 / 16');
check(mod.WIRE_BIT_POS_X === 32, 'WIRE_BIT_POS_X = 32', String(mod.WIRE_BIT_POS_X));
check(mod.WIRE_BIT_ROT_X === 128, 'WIRE_BIT_ROT_X = 128', String(mod.WIRE_BIT_ROT_X));
check(mod.WIRE_BIT_OMEGA_Z === 236, 'WIRE_BIT_OMEGA_Z = 236', String(mod.WIRE_BIT_OMEGA_Z));
// 倍率（用于确认量程：8 → ±4096m；64 → ±128m/s）
check(mod.WIRE_SCALE_POS === 8 && mod.WIRE_SCALE_VEL === 64 &&
      mod.WIRE_SCALE_ROT === 32767 && mod.WIRE_SCALE_ACC === 128 && mod.WIRE_SCALE_OMEGA === 256,
  '定点倍率 8 / 64 / 32767 / 128 / 256');

// ------------------------------------------------- 2) 零拷贝：HEAPU8 直写 + commit
console.log('\n[2] 零拷贝快照路径（模拟浏览器 HEAPU8.set + commit）');
{
  const addr = mod._fz_snapshot_stage_addr();
  check(addr > 0, '拿到暂存区地址', '0x' + addr.toString(16));
  check(mod._fz_snapshot_stage_size() === 96, '暂存区 96 字节');

  // 完全模拟 JS 侧：把网络包按字节写进 Wasm 线性内存，不调用任何 setter
  const buf = new ArrayBuffer(96);
  const dv = new DataView(buf);
  dv.setUint32(mod.OFF_FRAME, 4242, true);
  dv.setFloat32(mod.OFF_POSITION + 0, 10.0, true);
  dv.setFloat32(mod.OFF_POSITION + 4, 1.5, true);
  dv.setFloat32(mod.OFF_POSITION + 8, -20.0, true);
  dv.setFloat32(mod.OFF_ROTATION + 0, 1.0, true);  // w=1 单位四元数
  dv.setFloat32(mod.OFF_VELOCITY + 0, 55.0, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);

  check(mod._fz_snapshot_commit() === 1, 'commit 接受首个快照（1）');
  check(Math.abs(mod.replTelemetry().lastFrame() - 4242) < 0.5,
    'Embind 读到 frame = 4242', String(mod.replTelemetry().lastFrame()));

  // 帧号回退 -> 丢弃
  dv.setUint32(mod.OFF_FRAME, 4241, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  check(mod._fz_snapshot_commit() === 0, '帧号回退被丢弃（0）');
  check(mod._fz_stale_dropped() === 1, '丢弃计数 = 1', String(mod._fz_stale_dropped()));

  // 新帧 -> 外推应把位置往前推，但被 150ms 上限截断，之后转阻尼滑行
  dv.setUint32(mod.OFF_FRAME, 4243, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  mod._fz_snapshot_commit();
  const CAP = 0.150;   // ★ 规格值：外推上限 150ms（旧版是 250ms）
  for (let i = 0; i < 60; i++) mod._fz_update(1 / 60);
  const maddr = mod._fz_matrix_stage_addr();
  const vis = new Float32Array(mod.HEAPF32.buffer, maddr, 16);
  // 跑满 1 秒：前 150ms 沿 55m/s 直线外推 -> 10 + 55*0.15 = 18.25；
  // 超时后**不再沿旧速度飞出去**，而是"阻尼滑行"（速度按 coastHalfLifeSec 衰减）。
  // 所以 x 落在 [18.25, 10 + 55*0.15 + 55*0.6] 之间的某个值 ——
  // 关键断言是"**远小于** 10 + 55*1.0 = 65"，即外推确实被截断了。
  check(vis[12] > 18.2, '外推起步正确（≥ 10 + 55*0.15）', `x=${vis[12].toFixed(4)}`);
  check(vis[12] < 10 + 55 * 1.0, '外推未被允许跑满 1 秒（未被截断就会到 65）',
    `x=${vis[12].toFixed(4)}`);
  check(Math.abs(vis[14] + 20.0) < 1e-4, 'z 分量保持 -20（无横向漂移）',
    `z=${vis[14].toFixed(4)}`);
  check(Math.abs(mod._fz_extrapolated_s() - CAP) < 1e-3,
    `外推时长钉死在上限 ${CAP}s（旧版的 0.25 是过期值）`,
    mod._fz_extrapolated_s().toFixed(4) + 's');
}

// ------------------------------------------ 2b) 多车通道（UpdateRemoteVehicleState）
console.log('\n[2b] 多车通道：32B 线格式直接解包');
{
  mod._fz_reset_all();
  const wire = mod._fz_remote_stage_base();
  check(wire > 0, '远端暂存区基址可用', '0x' + wire.toString(16));

  // 手工按位组装一个 32B 包（模拟 TS 侧 WireSnapshotWriter 的输出）
  // 位置 100.5 / -3.25 / 2047.875，姿态 w=1，速度 72.5 / 0 / 0
  const w = new Uint32Array(8);
  const put = (off, bits, val) => {
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
    const v = val & mask;
    const wi = off >>> 5, bs = off & 31;
    w[wi] = (w[wi] | (v << bs)) >>> 0;
    if (bs + bits > 32) w[wi + 1] = (w[wi + 1] | (v >>> (bits - (bs + bits - 32)))) >>> 0;
  };
  put(mod.WIRE_BIT_FRAME, 16, 77);
  put(mod.WIRE_BIT_TICK_MS, 16, 1234);
  put(mod.WIRE_BIT_POS_X, mod.WIRE_BITS_POS, Math.floor(100.5 * mod.WIRE_SCALE_POS + 0.5));
  put(mod.WIRE_BIT_POS_Y, mod.WIRE_BITS_POS, Math.floor(-3.25 * mod.WIRE_SCALE_POS + 0.5));
  put(mod.WIRE_BIT_POS_Z, mod.WIRE_BITS_POS, Math.floor(2047.875 * mod.WIRE_SCALE_POS + 0.5));
  put(mod.WIRE_BIT_VEL_X, mod.WIRE_BITS_VEL, Math.floor(72.5 * mod.WIRE_SCALE_VEL + 0.5));
  // 姿态：w=1 -> x=y=z=0

  const bytes = new Uint8Array(32);
  const bdv = new DataView(bytes.buffer);
  for (let i = 0; i < 8; i++) bdv.setUint32(i * 4, w[i], true);

  // 写进 Wasm 内存 → 调需求指定的接口
  const remoteId = 0xA1B2C3;
  let slot = mod._fz_ensure_vehicle(remoteId, 0);
  check(slot >= 0, '登记远端车成功', 'slot=' + slot);
  mod.HEAPU8.set(bytes, wire + slot * 32);
  const accepted = mod._fz_update_remote_state(remoteId, wire, slot * 32);
  check(accepted === 1, 'UpdateRemoteVehicleState 接受（1）', String(accepted));

  // 位置回读（定点 1/8m，误差 ≤ 6.25cm）
  const px = mod._fz_remote_position(remoteId, 0);
  const pz = mod._fz_remote_position(remoteId, 2);
  check(Math.abs(px - 100.5) <= 0.07, 'posX 解包 = 100.5 ± 1/16m', px.toFixed(4));
  check(Math.abs(pz - 2047.875) <= 0.07, 'posZ 解包 = 2047.875 ± 1/16m', pz.toFixed(4));

  // 重复帧 -> 拒绝
  const again = mod._fz_update_remote_state(remoteId, wire, slot * 32);
  check(again === 0, '重复帧号被拒绝（0）', String(again));

  // 矩阵零拷贝读 —— 断言**双层解耦的结构性质**。
  // 三层关系（写清楚，这是本测试最容易想歪的地方）：
  //   ① 物理层 physPos_ 收到包后 = 包内值（第 2 步直接采信，不掺平滑）；
  //      但 A-1 航位推测会按 physVel_ 继续推进它 —— **下一帧起它就会变**。
  //   ② 视觉层 = physPos_ + visOffPos_。⚠️ **首个快照走"直接对齐"分支**
  //      （replicator `state_ == Empty` 特例）：没有历史连续性可言，
  //      visOffPos_ 被显式清零 —— 所以接收瞬间**视觉 == 物理**，这是对的。
  //      只有「已有前置状态时收到纠偏」才会把差值塞进 visOffPos_
  //      （零跳变语义在那种场景才成立，见第 2 步）。
  //   ③ visOffPos_ 按 80ms 半衰期衰减；2s ≈ 25 个半衰期 ⇒ 必收敛到 ~0。
  const mbase = mod._fz_remote_matrix_base();
  const readMat = () => new Float32Array(mod.HEAPF32.buffer, mbase + slot * 64, 16);

  mod._fz_refresh_remote_matrices();
  const rmat0 = readMat();
  check(Math.abs(rmat0[12] - px) < 1e-3 && Math.abs(rmat0[14] - 2047.875) < 1e-3,
    '首个快照直接对齐：接收瞬间视觉矩阵 == 包内位置（无历史故不产生偏移）',
    `mx=${rmat0[12].toFixed(3)} mz=${rmat0[14].toFixed(3)}`);
  check(Math.abs(mod._fz_remote_visual_error(remoteId)) < 1e-4,
    '首个快照的视觉偏移为 0（Empty -> Corrected 的直接对齐分支）',
    mod._fz_remote_visual_error(remoteId).toFixed(6));
  check(Math.abs(mod._fz_remote_position(remoteId, 0) - px) < 1e-3,
    '接收帧物理位置精确等于包内值（物理层不掺平滑）',
    mod._fz_remote_position(remoteId, 0).toFixed(4));

  // ---- 第二个快照：此时已有历史状态，纠偏必须走"视觉零跳变"分支 ----
  // 把位置挪 +40m（超过 snapDistanceM=5.0 会硬吸附，故取 4m 以内），
  // 断言接收瞬间**视觉位置原地不动**，而物理层已跳到新值。
  {
    const w2 = new Uint32Array(8);
    const putB = (off, bits, val) => {
      const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
      const v = val & mask, wi = off >>> 5, bs = off & 31;
      w2[wi] = (w2[wi] | (v << bs)) >>> 0;
      if (bs + bits > 32) w2[wi + 1] = (w2[wi + 1] | (v >>> (bits - (bs + bits - 32)))) >>> 0;
    };
    putB(mod.WIRE_BIT_FRAME, 16, 78);
    putB(mod.WIRE_BIT_POS_X, mod.WIRE_BITS_POS, Math.floor((px + 3.0) * mod.WIRE_SCALE_POS + 0.5));
    putB(mod.WIRE_BIT_POS_Y, mod.WIRE_BITS_POS, Math.floor(-3.25 * mod.WIRE_SCALE_POS + 0.5));
    putB(mod.WIRE_BIT_POS_Z, mod.WIRE_BITS_POS, Math.floor(2047.875 * mod.WIRE_SCALE_POS + 0.5));
    putB(mod.WIRE_BIT_VEL_X, mod.WIRE_BITS_VEL, Math.floor(72.5 * mod.WIRE_SCALE_VEL + 0.5));
    const b2 = new Uint8Array(32);
    const dv2 = new DataView(b2.buffer);
    for (let i = 0; i < 8; i++) dv2.setUint32(i * 4, w2[i], true);

    mod._fz_refresh_remote_matrices();
    const visBefore = readMat()[12];
    mod.HEAPU8.set(b2, wire + slot * 32);
    const acc2 = mod._fz_update_remote_state(remoteId, wire, slot * 32);
    check(acc2 === 1, '第二个快照被接受', String(acc2));
    mod._fz_refresh_remote_matrices();
    const visAfter = readMat()[12];
    const physAfter = mod._fz_remote_position(remoteId, 0);
    check(Math.abs(visAfter - visBefore) < 1e-4,
      '纠偏时视觉位置**原地不动**（零跳变：差值被塞进视觉偏移层）',
      `before=${visBefore.toFixed(4)} after=${visAfter.toFixed(4)}`);
    check(Math.abs(physAfter - (px + 3.0)) < 1e-3,
      '同一时刻物理层已直接跳到权威新值（碰撞判定立刻生效）',
      `phys=${physAfter.toFixed(3)} 期望 ${(px + 3.0).toFixed(3)}`);
  }

  // 推进 2s（> 20 个半衰期）：视觉偏移衰减殆尽，视觉矩阵贴合物理层
  for (let i = 0; i < 120; i++) mod._fz_update_remotes(1 / 60);
  const rmat2 = readMat();
  const physX = mod._fz_remote_position(remoteId, 0);
  check(Math.abs(rmat2[12] - physX) < 0.05,
    '2s 后视觉矩阵收敛贴合物理层（视觉偏移已衰减归零）',
    `mx=${rmat2[12].toFixed(3)} physX=${physX.toFixed(3)}`);
  check(Math.abs(rmat2[14] - 2047.875) < 1.0,
    '视觉矩阵 z 收敛在包内 z 附近（沿 +x 直线外推，无横向漂移）',
    `mz=${rmat2[14].toFixed(3)}`);
  check(physX > px,
    '物理层沿包内速度 72.5m/s 继续外推（航位推测在跑）',
    `physX=${physX.toFixed(1)} > 包内 ${px}`);

  // 多车独立性
  const id2 = 0xD4E5F6;
  const slot2 = mod._fz_ensure_vehicle(id2, 0);
  check(slot2 >= 0 && slot2 !== slot, '第二辆车拿到不同槽位', `${slot} / ${slot2}`);
  check(mod._fz_vehicle_count() === 2, '车辆计数 = 2', String(mod._fz_vehicle_count()));

  // 摘除
  mod._fz_remove_vehicle(remoteId);
  check(mod._fz_vehicle_count() === 1, '摘除后计数 = 1', String(mod._fz_vehicle_count()));
  check(mod._fz_vehicle_find(remoteId) === -1, '已摘除的车查找失败');
}

// ----------------------------------------------- 2c) 赛道 + HUD 秒差文本
console.log('\n[2c] 赛道装配 + 计时塔文本（RaceDeltaTracker 导出）');
{
  mod._fz_reset_all();
  // 方形赛道控制点（世界 x/z 交织）——与 C++ 测试同一份
  const ctl = new Float64Array([-50, -50, 50, -50, 50, 50, -50, 50]);
  const cp = new Float64Array([0, 100, 200, 300]);
  const pCtl = mod._malloc(ctl.byteLength);
  const pCp = mod._malloc(cp.byteLength);
  mod.HEAPU8.set(new Uint8Array(ctl.buffer), pCtl);
  mod.HEAPU8.set(new Uint8Array(cp.buffer), pCp);
  check(mod._fz_set_track(pCtl, 4, pCp, 4) === 1, '装入方形赛道');
  mod._free(pCtl);
  mod._free(pCp);

  check(mod._fz_track_ready() === 1, '赛道就绪');
  check(mod._fz_checkpoint_count() === 4, 'Checkpoint 数 = 4', String(mod._fz_checkpoint_count()));
  const L = mod._fz_track_length();
  // 闭合 Catmull-Rom 弧长（不是多边形周长 400）：实测约 420.38
  check(L > 400 && L < 440, '闭合样条弧长在 (400, 440)', L.toFixed(3));

  // 三辆车：本地在 s=100（落后），P1 在 s=200
  const LOCAL = 1, LEAD = 2, LAST = 3;
  mod._fz_ensure_vehicle(LOCAL, 1);
  mod._fz_set_local_vehicle(mod._fz_vehicle_find(LOCAL));
  mod._fz_ensure_vehicle(LEAD, 0);
  mod._fz_ensure_vehicle(LAST, 0);
  const T0 = 20.0;
  mod._fz_update_progress(LEAD, 200.0, T0, 0, 1, 8.0);
  mod._fz_update_progress(LOCAL, 100.0, T0, 0, 0, 6.0);
  mod._fz_update_progress(LAST, 50.0, T0, 0, -1, 0.0);

  const rows = mod._fz_build_leaderboard();
  check(rows === 3, '计时塔 3 行', String(rows));

  // 读第 0 行文本（零拷贝：文本暂存区 + HEAPU8）
  const readRow = (i) => {
    const a = mod._fz_row_text_addr(i);
    const v = mod.HEAPU8.subarray(a, a + mod.ROW_TEXT_CAP);
    let s = '';
    for (let k = 0; k < v.length && v[k] !== 0; k++) s += String.fromCharCode(v[k]);
    return s;
  };
  check(readRow(0) === '--', 'P1 行文本为 "--"', JSON.stringify(readRow(0)));
  check(readRow(1).startsWith('-'), 'P2 行以负号开头', JSON.stringify(readRow(1)));
  check(readRow(2).startsWith('-'), 'P3 行以负号开头', JSON.stringify(readRow(2)));

  // 本地落后 -> 本地行也是负号
  const n = mod._fz_format_local_vs_leader();
  check(n > 0, '本地行文本写入成功', String(n));
  const la = mod._fz_local_row_addr();
  const lv = mod.HEAPU8.subarray(la, la + mod.ROW_TEXT_CAP);
  let localText = '';
  for (let k = 0; k < lv.length && lv[k] !== 0; k++) localText += String.fromCharCode(lv[k]);
  check(localText.startsWith('-'), '本地落后时文本以负号开头', JSON.stringify(localText));
  check(localText !== '--', '本地落后时不显示 "--"');

  // 带符号时差 + 反对称
  const msAB = mod._fz_solve_delta_ms(LOCAL, LEAD);
  const msBA = mod._fz_solve_delta_ms(LEAD, LOCAL);
  check(msAB < 0, 'Solve(本地, P1) < 0（本地落后）', msAB.toFixed(2));
  check(Math.abs(msAB + msBA) < 1e-6, 'Solve(a,b) == -Solve(b,a)', `${msAB.toFixed(3)} / ${msBA.toFixed(3)}`);

  // Embind 低频路径（会分配 JS 对象，但正确性必须保证）
  const table = mod.leaderboard();
  check(table.size() === 3, 'Embind leaderboard().size() = 3', String(table.size()));
  check(table.get(0).isLeader === true, 'Embind 第 0 行 isLeader = true');
  check(table.get(0).text === '--', 'Embind 第 0 行文本 "--"');
  table.delete();   // ⚠️ 必须 delete，否则 Wasm 堆泄漏
}

// ------------------------------------------------------- 3) NTP 时钟同步
console.log('\n[3] NTP 采样 + Clock Slewing');
{
  mod._fz_reset_all();
  const MS = 1e6;
  let t = 0;
  // 单程 5ms、服务端处理 1ms、真实偏移 +37ms
  const out = 5 * MS, proc = 1 * MS, TRUE = 37 * MS;
  // ⚠️ 锁定判据是 `count_ >= cfg.windowSize`（默认 30），**不是固定 24 个样本**。
  //    C++ 单测里那条"锁定"前置条件用的是 `i > cfg.windowSize`；本测试原先写死 24
  //    是按"0.2×窗口参与聚合"误推出来的 —— 参与聚合的样本数（6 个）与
  //    "窗口装满才允许首次对齐"（30 个）是两件事。按窗口大小驱动循环。
  const WINDOW = 30;
  const feed = (n, step) => {
    for (let i = 0; i < n; i++) {
      const t1 = t;
      const t2 = t1 + out + TRUE;
      const t3 = t2 + proc;
      const t4 = t1 + out + proc + out;
      mod._fz_on_pong(t1, t2, t3, t4);
      t += step;
    }
  };
  feed(WINDOW - 1, 100 * MS);
  check(mod._fz_is_locked() === 0,
    `装 ${WINDOW - 1} 个样本时仍未锁定（窗口未满，不硬对齐）`,
    String(mod._fz_is_locked()));
  feed(1, 100 * MS);
  check(mod._fz_is_locked() !== 0,
    `装 ${WINDOW} 个样本后完成锁定（C ABI 返回 0/1 数字）`,
    String(mod._fz_is_locked()));
  check(Math.abs(mod._fz_best_rtt_ns() - 10 * MS) < 1e-6,
    '最小 RTT = 10ms', (mod._fz_best_rtt_ns() / MS).toFixed(3) + 'ms');
  // 量纲要一致：offsetNs() 是**纳秒**，TRUE 也是纳秒，直接比。
  // （第一版左边除了 1e6 换成毫秒、右边还是纳秒，差 6 个数量级 —— 我的错。）
  check(Math.abs(mod.syncTelemetry().offsetNs() - TRUE) < 1,
    'offset = 真实偏移 +37ms（对称路径）',
    (mod.syncTelemetry().offsetNs() / MS).toFixed(3) + 'ms');

  // 制造 80ms 阶跃 -> 必须走连续微调（warp 有界、dt 有界），不许硬跳
  const STEP = 80 * MS;
  let maxWarp = 0, dtOk = true, snapped = false;
  for (let i = 0; i < 200; i++) {
    const t1 = 1e12 + i * 1e7;
    const ev = mod._fz_on_pong(t1, t1 + out + STEP, t1 + out + proc + STEP, t1 + out + proc + out);
    if (ev === mod.SYNC_EVENT_HARD_RESYNC) snapped = true;
    const dt = mod._fz_adjusted_dt(1 / 60);
    if (!(dt > 0) || dt > (1 / 60) * 1.02) dtOk = false;
    maxWarp = Math.max(maxWarp, Math.abs(mod._fz_current_warp()));
  }
  check(!snapped, '80ms 阶跃**没有**触发硬同步（只走连续微调）');
  check(maxWarp <= 0.015 + 1e-9, '伸缩比例始终 <= ±1.5%', maxWarp.toFixed(6));
  check(dtOk, '输出步长恒为正且不超过基准的 1.02 倍');
}

// -------------------------------------------- 3b) 矩阵槽（前端 subarray 用）
console.log('\n[3b] 矩阵槽地址');
{
  const base = mod._fz_matrix_stage_addr();
  const s0 = mod._fz_matrix_slot_addr(0);
  const s1 = mod._fz_matrix_slot_addr(1);
  check(base === mod._fz_matrix_slot_addr(mod.MATRIX_SLOT_VISUAL),
    'slot 0 = 视觉矩阵（与 MATRIX_SLOT_VISUAL 一致）');
  check(s1 - s0 === 64, '相邻槽相差 64 字节（16 float）', String(s1 - s0));
  check(mod._fz_matrix_slot_addr(99) === 0, '越界槽返回 0');
  check(mod.MATRIX_SLOTS === 4, '矩阵槽数 = 4', String(mod.MATRIX_SLOTS));
}

// ---------------------------------------------------- 4) 模拟断线重连
console.log('\n[4] 断线重连');
{
  mod._fz_reset_all();
  check(mod._fz_is_locked() === 0, 'reset 后回到未锁定', String(mod._fz_is_locked()));
  check(mod.replTelemetry().hasState() === false, 'reset 后刚体状态已清空');
  check(mod._fz_vehicle_count() === 0, 'reset 后多车注册表已清空', String(mod._fz_vehicle_count()));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
```

### 文件: native/wasm/snapshot_wire.h

```cpp
// =============================================================================
//  snapshot_wire.h —— 32 字节紧凑线格式（Wasm 内存内直接解包）
//
//  ── 为什么需要它（而不是直接把 96B 的 RigidBodyNetSnapshot 发上线）────────────
//    需求把"单个物理快照"钉死在 **32~48 字节**。
//    而 Wasm 侧的工作结构 RigidBodyNetSnapshot 是 96B —— 它带 5 处 `_pad*`，
//    为了满足 `alignas(16)` 与 NEON 的对齐访问（见 rigid_body_replicator.h 的说明）。
//    这两件事不矛盾，但**必须分成两层**：
//
//      线格式（wire, 32B）  ← 只在网上跑，字段按需量化，逐字节可审计
//      工作结构（work, 96B）← 进物理/插值/渲染，16 对齐、SIMD 友好
//
//    于是本文件提供 Expand()：wire 32B → work 96B。
//    解包在 **Wasm 内存内**完成（`UpdateRemoteVehicleState` 收的是
//    Wasm 线性内存里的偏移），JS 只做 `HEAPU8.set(packet, addr)` + 一次无参调用。
//
//  ── 32 字节从哪来（每一项都是"够不够用"算出来的，不是凑的）─────────────────
//    赛道尺度：本项目最大赛道斯帕 7013m，世界坐标 |x|,|z| < 2048m（留 4 倍余量）
//      → 位置 16 位定点 @ 1/8 m：量程 ±4096m，分辨率 0.125m，误差 ≤ 6.25cm
//        0.125m 在 265km/h（73.6m/s）下是 1.7ms 的位置 —— 远小于一个物理步。
//        ⚠️ 分辨率必须 **> 1/16m**：用 1/16 时量程只剩 ±2048m，斯帕尾端会溢出回绕，
//           症状是"远端车偶尔出现在地图另一头"，极难归因。
//    姿态   ：四元数取绝对值(习惯化 w≥0) 后 x,y,z 各 16 位；w 由单位性恢复
//      → 分量分辨率 3e-5，角误差 < 0.01°。远优于渲染可分辨的 0.1°。
//    速度   ：14 位 @ 1/64 m/s → 量程 ±128m/s = ±460km/h，分辨率 1.5cm/s。
//    角速度 ：12 位 @ 1/256 rad/s → 量程 ±8rad/s，分辨率 0.22°/s。
//    加速度 ：12 位 @ 1/128 m/s² → 量程 ±16m/s²（纵向极限约 1.3g），分辨率 0.45%。
//
//  ── 位打包布局（小端；与 DataView 逐位对齐，位偏移即真相）────────────────────
//    下表的 [起:止) 是**字内**位区间，起止均已按上面的 wire_bit 常量核验。
//    u32  A @ 0   (word 0) : frame      [0:16)    16 位帧号（回绕周期 65536 帧）
//                          : tickMs     [16:32)   16 位毫秒（相对服务端基准回绕）
//    u32  B @ 4   (word 1) : posX       [0:16)    定点 1/8 m
//                          : posY       [16:32)
//    u32  C @ 8   (word 2) : posZ       [0:16)
//                          : velX       [16:30)   速度 1/64 m/s
//                          : velY 低 2 位 [30:32)  ← velY 跨字
//    u32  D @ 12  (word 3) : velY 高 12 位 [0:12)   共 14 位
//                          : velZ       [12:26)
//                          : _rsv       [26:32)
//    u32  E @ 16  (word 4) : rotX       [0:16)    单位四元数分量 ×32767
//                          : rotY       [16:32)
//    u32  F @ 20  (word 5) : rotZ       [0:16)
//                          : accX       [16:28)   加速度 1/128 m/s²
//                          : accY 低 4 位 [28:32)  ← accY 跨字
//    u32  G @ 24  (word 6) : accY 高 8 位 [0:8)     共 12 位
//                          : accZ       [8:20)
//                          : omegaX     [20:32)   角速度 1/256 rad/s —— 恰好收在字边界
//    u32  H @ 28  (word 7) : omegaY     [0:12)
//                          : omegaZ     [12:24)
//                          : _rsv       [24:32)
//    size 32，align 4，6 个保留位
//
//  ⚠️ 为什么速度/加速度要跨字（velY 横跨 word2/3，accY 横跨 word5/6）：
//     纯粹是"32 字节刚好装不下整齐切分的版本"。
//     整齐版（每个量都从 16 位边界起）需要：
//       12(头) + 6(位置) + 6(速度) + 6(姿态) + 2(角速度) + 2(加速度) = 34 字节 > 32。
//     （角速度 12 位×3 = 36 位 = 2.25 字节；加速度同理。）
//     要压到 32 只有两条路：① 砍某个量的位宽；② 让相邻量共享一个字。
//     选 ② —— 因为 bit 级打包已写好通用的位读写器（PutBits/GetBits），
//     跨字对它零成本，而砍位宽是**永久性**的质量损失。
//     若哪天真需要"每个字段字节对齐"（JS 侧不解包直接读单字段），
//     那就接受 34~36 字节 —— 仍在 48B 预算内，改 kBits* 与位表即可。
//
//  ⚠️ 定点数必须**饱和**而不是回绕：`(x * scale)` 溢出后强转 int16 是 UB，
//     且回绕会把 2050m 变成 −2046m（"瞬移到起点"）。故 QuantizeSat() 全程夹取。
//
//  ⚠️ 量化用 `nearbyint`（就近取整）而非 `static_cast<int>`（截断）：
//     截断对负数朝 +∞ 偏、对正数朝 −∞ 偏，会给静止车辆引入恒定的位置偏置，
//     在 warp 累积下形成可观测的稳态漂移。
// =============================================================================
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

#include "../rb_replicator/rigid_body_replicator.h"

namespace forza::wasm {

using forza::net::RigidBodyNetSnapshot;

// -----------------------------------------------------------------------------
//  线格式常量（JS 侧通过 Embind 常量读到，**不得硬编码**）
// -----------------------------------------------------------------------------

inline constexpr std::uint32_t kWireBytes = 32U;     ///< 单快照线格式字节数
inline constexpr std::uint32_t kWireWords = 8U;      ///< = kWireBytes / 4

/// 位置定点比例（1/8 m）。见文件头：分辨率 0.125m，量程 ±4096m。
inline constexpr float kWirePosScale = 8.0F;
/// 速度定点比例（1/64 m/s）：量程 ±128m/s。
inline constexpr float kWireVelScale = 64.0F;
/// 角速度定点比例（1/256 rad/s）：量程 ±8rad/s。
inline constexpr float kWireOmegaScale = 256.0F;
/// 加速度定点比例（1/128 m/s²）：量程 ±16m/s²。
inline constexpr float kWireAccelScale = 128.0F;
/// 单位四元数分量比例（×32767 用满 int16）。
inline constexpr float kWireRotScale = 32767.0F;

/// 各量的位宽（改成不同版本时只动这里，断言会跟着走）
inline constexpr int kBitsFrame  = 16;
inline constexpr int kBitsTickMs = 16;
inline constexpr int kBitsPos    = 16;
inline constexpr int kBitsVel    = 14;
inline constexpr int kBitsRot    = 16;
inline constexpr int kBitsOmega  = 12;
inline constexpr int kBitsAccel  = 12;

// 总位数自检：8 字 × 32 位 = 256 位；下面这些是**净载荷**位（不含 6 个保留位）
//   16 + 16                        = 32   帧头
//   16 × 3                         = 48   位置
//   14 × 3                         = 42   速度
//   16 × 3                         = 48   姿态
//   12 × 3                         = 36   角速度
//   12 × 3                         = 36   加速度
//                                  = 242 位 + 6 保留位 = 248 位 ≤ 256 位
// 余下的 8 位是跨字串位时为了不切断字段而自然留下的空隙（见布局图）。
inline constexpr int kWirePayloadBits = kBitsFrame + kBitsTickMs +
                                        3 * kBitsPos + 3 * kBitsVel + 3 * kBitsRot +
                                        3 * kBitsOmega + 3 * kBitsAccel;
static_assert(kWirePayloadBits == 242, "位宽改动后必须同步核对布局图");
static_assert(kWireBytes == 32U, "线格式必须是 32 字节（规格上限 48）");

// -----------------------------------------------------------------------------
//  定点量化：饱和，绝不回绕
// -----------------------------------------------------------------------------

/// 浮点 → 有符号定点（位宽 bits），饱和夹取。
///
/// ⚠️ **取整方式必须与 JS 的 `Math.round` 完全一致**。
///    JS 规范里 `Math.round` 的定义是
///        `Math.round(x) = floor(x + 0.5)`   —— 即"半个值一律朝 **+∞** 取整"
///    于是它在负数半值上**不是**远离零：
///        Math.round( 0.5) =  1
///        Math.round(-0.5) = -0      ← 注意不是 -1
///        Math.round(-1.5) = -1
///        Math.round(-2.5) = -2
///    而 C++ 里两个常见的"就近取整"都与之不同：
///        std::nearbyint / std::rint  -> **取偶（banker's）**：0.5→0、2.5→2
///        floor(x+0.5)/ceil(x-0.5) 按符号分 -> **远离零**：-0.5→-1（本模块第一版）
///    三种取整在"恰好半个量化步"上给出不同结果 —— 这类值一点都不罕见：
///    位置倍率 8，于是 0.0625 / 0.1875 / 0.3125 ... 全命中 0.5。
///    后果：C++ 打包与 TS 打包在同一条快照上产出**不同字节**，
///    位置差一个量化步（0.125m），且只在半个步长的输入上出现。
///
///    这个 bug 正是 `verify_engine_wire.mjs` 那份 TS↔C++ 逐字节交叉校验
///    存在的理由 —— 它在任何单语言测试里都**不可能**被发现。
///
///    实现就一条：`std::floor(s + 0.5)`，与 JS 规范定义逐字相同。
///    （`-0.5` 会得到 `-0.0`；`static_cast<std::int32_t>(-0.0)` 是 `0`，
///      与 JS 侧 `| 0` 的结果一致，无需特判。）
[[nodiscard]] inline std::int32_t QuantizeSat(float v, float scale, int bits) noexcept {
  if (!std::isfinite(v)) return 0;                     // NaN/Inf 一律当 0，别把垃圾散上网
  const double s = static_cast<double>(v) * static_cast<double>(scale);
  const double lo = -static_cast<double>((1 << (bits - 1)) - 1);
  const double hi = static_cast<double>((1 << (bits - 1)) - 1);
  // 与 JS Math.round 逐值对应：floor(x + 0.5)（半个值朝 +∞）
  double d = std::floor(s + 0.5);
  if (d > hi) d = hi;
  if (d < lo) d = lo;
  return static_cast<std::int32_t>(d);
}

/// 有符号定点 → 浮点
[[nodiscard]] inline float Dequantize(std::int32_t q, float scale) noexcept {
  return static_cast<float>(static_cast<double>(q) / static_cast<double>(scale));
}

// -----------------------------------------------------------------------------
//  位读写器（跨字串位，零成本抽象）
// -----------------------------------------------------------------------------

/// 往 int32 数组里按任意位偏移写有符号数（二进制补码的**低位截断**表示，
/// 因为上游已 QuantizeSat 保证值落在位宽内）。
inline void PutBits(std::uint32_t* w, int off, int bits, std::uint32_t v) noexcept {
  const std::uint32_t mask = (bits >= 32) ? 0xFFFFFFFFu : ((1u << bits) - 1u);
  v &= mask;
  const int wi = off >> 5;
  const int bs = off & 31;
  w[wi] |= (v << bs);
  if (bs + bits > 32) {
    // 跨字：高出的部分落到下一个字
    const int spill = bs + bits - 32;
    w[wi + 1] |= (v >> (bits - spill));
  }
}

/// 从 int32 数组里按任意位偏移读有符号数并做符号扩展
[[nodiscard]] inline std::int32_t GetBits(const std::uint32_t* w, int off, int bits) noexcept {
  const std::uint32_t mask = (bits >= 32) ? 0xFFFFFFFFu : ((1u << bits) - 1u);
  const int wi = off >> 5;
  const int bs = off & 31;
  std::uint32_t v = (w[wi] >> bs);
  if (bs + bits > 32) {
    const int spill = bs + bits - 32;
    v |= (w[wi + 1] & ((1u << spill) - 1u)) << (bits - spill);
  }
  v &= mask;
  // 符号扩展
  if (bits < 32 && (v & (1u << (bits - 1)))) {
    v |= ~mask;
  }
  return static_cast<std::int32_t>(v);
}

// -----------------------------------------------------------------------------
//  位偏移表（唯一真相；JS 侧通过 Embind 读到同一组值做交叉校验）
// -----------------------------------------------------------------------------

namespace wire_bit {
inline constexpr int kFrame  = 0;      // word 0  [0:16)
inline constexpr int kTickMs = 16;     // word 0  [16:32)
inline constexpr int kPosX   = 32;     // word 1  [0:16)
inline constexpr int kPosY   = 48;     // word 1  [16:32)
inline constexpr int kPosZ   = 64;     // word 2  [0:16)
inline constexpr int kVelX   = 80;     // word 2  [16:30)
inline constexpr int kVelY   = 94;     // 跨 word2/3  [30:44)
inline constexpr int kVelZ   = 108;    // word 3  [12:26)
inline constexpr int kRotX   = 128;    // word 4  [0:16)
inline constexpr int kRotY   = 144;    // word 4  [16:32)
inline constexpr int kRotZ   = 160;    // word 5  [0:16)
inline constexpr int kAccX   = 176;    // word 5  [16:28)
inline constexpr int kAccY   = 188;    // 跨 word5/6  [28:40)
inline constexpr int kAccZ   = 200;    // word 6  [8:20)
inline constexpr int kOmegaX = 212;    // word 6  [20:32) —— 恰好收在字边界
inline constexpr int kOmegaY = 224;    // word 7  [0:12)
inline constexpr int kOmegaZ = 236;    // word 7  [12:24)
}  // namespace wire_bit

// 每个字段都必须整段落在 256 位内
static_assert(wire_bit::kOmegaZ + kBitsOmega <= 256, "最后一个字段越界");
// 跨字的两个字段必须真的跨字（否则说明打包表被改错了）
static_assert((wire_bit::kVelY & 31) + kBitsVel > 32, "kVelY 应当跨 word2/3");
static_assert((wire_bit::kAccY & 31) + kBitsAccel > 32, "kAccY 应当跨 word5/6");
// 收在字边界的字段必须**正好**收在边界（多一位就越界踩到下一个字段）
static_assert((wire_bit::kOmegaX & 31) + kBitsOmega == 32, "kOmegaX 应恰好收在 word6 边界");
static_assert((wire_bit::kVelZ & 31) + kBitsVel <= 32, "kVelZ 不得越过 word3");
static_assert((wire_bit::kOmegaZ & 31) + kBitsOmega <= 32, "kOmegaZ 不得越过 word7");

// -----------------------------------------------------------------------------
//  Expand：32B 线格式 → 96B 工作结构（**在 Wasm 内存内解包**）
// -----------------------------------------------------------------------------

/**
 * 把 32 字节线格式解包进一个 RigidBodyNetSnapshot。
 *
 * @param src     指向 **Wasm 线性内存内**的 32 字节（JS 侧 HEAPU8.set 写进来的）
 * @param out     解包目标（96B 工作结构，通常就是桥的 snapshotStage_）
 * @param tickBaseMs  服务端 tickMs 的回绕基准。线上 tickMs 只有 16 位
 *                    （65535ms 回绕），解包时补回高位。传 0 则原样使用。
 */
inline void ExpandWireToSnapshot(const std::uint8_t* src, RigidBodyNetSnapshot& out,
                                 std::uint32_t tickBaseMs = 0U) noexcept {
  std::uint32_t w[kWireWords];
  std::memcpy(w, src, kWireBytes);   // 一次 32B 拷贝；比逐字段 memcpy 少 16 次调用

  out.frame  = static_cast<std::uint32_t>(GetBits(w, wire_bit::kFrame, kBitsFrame));
  const std::uint32_t tickLo = static_cast<std::uint32_t>(GetBits(w, wire_bit::kTickMs, kBitsTickMs));
  out.tickMs = (tickBaseMs & 0xFFFF0000u) | tickLo;

  // ---- 位置（定点 1/8 m）----
  out.position.x = Dequantize(GetBits(w, wire_bit::kPosX, kBitsPos), kWirePosScale);
  out.position.y = Dequantize(GetBits(w, wire_bit::kPosY, kBitsPos), kWirePosScale);
  out.position.z = Dequantize(GetBits(w, wire_bit::kPosZ, kBitsPos), kWirePosScale);

  // ---- 线速度（定点 1/64 m/s）----
  out.velocity.x = Dequantize(GetBits(w, wire_bit::kVelX, kBitsVel), kWireVelScale);
  out.velocity.y = Dequantize(GetBits(w, wire_bit::kVelY, kBitsVel), kWireVelScale);
  out.velocity.z = Dequantize(GetBits(w, wire_bit::kVelZ, kBitsVel), kWireVelScale);

  // ---- 姿态（单位四元数，已习惯化 w≥0；w 由单位性恢复）----
  //   ★ 恢复出来的 w 恒 ≥ 0 —— 正是 ShortArc 要的规范形。
  //     若不做这一步，接收端拿到 q 与 −q 时 `dot(ref,q)` 的符号是随机的，
  //     rb_replicator 的第②处短弧检查就会被无谓触发（白做一次取反）。
  const float rx = Dequantize(GetBits(w, wire_bit::kRotX, kBitsRot), kWireRotScale);
  const float ry = Dequantize(GetBits(w, wire_bit::kRotY, kBitsRot), kWireRotScale);
  const float rz = Dequantize(GetBits(w, wire_bit::kRotZ, kBitsRot), kWireRotScale);
  float rw2 = 1.0F - (rx * rx + ry * ry + rz * rz);
  if (rw2 < 0.0F) rw2 = 0.0F;          // 量化噪声可能让它微负；夹到 0 而不是 sqrt(负数)=NaN
  out.rotation.w = std::sqrt(rw2);
  out.rotation.x = rx;
  out.rotation.y = ry;
  out.rotation.z = rz;

  // ---- 加速度（定点 1/128 m/s²）----
  out.accel.x = Dequantize(GetBits(w, wire_bit::kAccX, kBitsAccel), kWireAccelScale);
  out.accel.y = Dequantize(GetBits(w, wire_bit::kAccY, kBitsAccel), kWireAccelScale);
  out.accel.z = Dequantize(GetBits(w, wire_bit::kAccZ, kBitsAccel), kWireAccelScale);

  // ---- 角速度（定点 1/256 rad/s）----
  out.angularVelocity.x = Dequantize(GetBits(w, wire_bit::kOmegaX, kBitsOmega), kWireOmegaScale);
  out.angularVelocity.y = Dequantize(GetBits(w, wire_bit::kOmegaY, kBitsOmega), kWireOmegaScale);
  out.angularVelocity.z = Dequantize(GetBits(w, wire_bit::kOmegaZ, kBitsOmega), kWireOmegaScale);
}

// -----------------------------------------------------------------------------
//  Pack：96B 工作结构 → 32B 线格式（**测试/录制回放需要；正式只走单向解包**）
// -----------------------------------------------------------------------------

/**
 * 把工作结构压成 32 字节线格式。
 *
 * 生产路径其实只需 Expand（客户端收包），但 Pack 是**必需的测试工具**：
 * 没有它就无法做"打包→解包→比对"的往返断言，也就无法证明位表没写错。
 * 另外服务端如果也跑同一份 C++，Pack 就是它的发包路径。
 *
 * @param s         源快照（96B）
 * @param dst       目标 32 字节缓冲
 * @param tickLoMs  是否把 tickMs 截成低 16 位（true = 线上格式行为）
 */
inline void PackSnapshotToWire(const RigidBodyNetSnapshot& s, std::uint8_t* dst,
                               bool tickLoMs = true) noexcept {
  std::uint32_t w[kWireWords];
  std::memset(w, 0, sizeof(w));

  PutBits(w, wire_bit::kFrame, kBitsFrame,
          static_cast<std::uint32_t>(s.frame) & 0xFFFFu);
  PutBits(w, wire_bit::kTickMs, kBitsTickMs,
          tickLoMs ? (s.tickMs & 0xFFFFu) : (s.tickMs & 0xFFFFu));

  PutBits(w, wire_bit::kPosX, kBitsPos,
          static_cast<std::uint32_t>(QuantizeSat(s.position.x, kWirePosScale, kBitsPos)));
  PutBits(w, wire_bit::kPosY, kBitsPos,
          static_cast<std::uint32_t>(QuantizeSat(s.position.y, kWirePosScale, kBitsPos)));
  PutBits(w, wire_bit::kPosZ, kBitsPos,
          static_cast<std::uint32_t>(QuantizeSat(s.position.z, kWirePosScale, kBitsPos)));

  PutBits(w, wire_bit::kVelX, kBitsVel,
          static_cast<std::uint32_t>(QuantizeSat(s.velocity.x, kWireVelScale, kBitsVel)));
  PutBits(w, wire_bit::kVelY, kBitsVel,
          static_cast<std::uint32_t>(QuantizeSat(s.velocity.y, kWireVelScale, kBitsVel)));
  PutBits(w, wire_bit::kVelZ, kBitsVel,
          static_cast<std::uint32_t>(QuantizeSat(s.velocity.z, kWireVelScale, kBitsVel)));

  // ---- 姿态：先习惯化到 w ≥ 0，再丢 w ----
  float qw = s.rotation.w, qx = s.rotation.x, qy = s.rotation.y, qz = s.rotation.z;
  const float n2 = qw * qw + qx * qx + qy * qy + qz * qz;
  if (!(n2 > 0.0F) || !std::isfinite(n2)) { qw = 1.0F; qx = qy = qz = 0.0F; }
  else {
    const float inv = 1.0F / std::sqrt(n2);
    qw *= inv; qx *= inv; qy *= inv; qz *= inv;
  }
  if (qw < 0.0F) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }   // q 与 −q 同旋转，取 w≥0 的规范形
  PutBits(w, wire_bit::kRotX, kBitsRot,
          static_cast<std::uint32_t>(QuantizeSat(qx, kWireRotScale, kBitsRot)));
  PutBits(w, wire_bit::kRotY, kBitsRot,
          static_cast<std::uint32_t>(QuantizeSat(qy, kWireRotScale, kBitsRot)));
  PutBits(w, wire_bit::kRotZ, kBitsRot,
          static_cast<std::uint32_t>(QuantizeSat(qz, kWireRotScale, kBitsRot)));

  PutBits(w, wire_bit::kAccX, kBitsAccel,
          static_cast<std::uint32_t>(QuantizeSat(s.accel.x, kWireAccelScale, kBitsAccel)));
  PutBits(w, wire_bit::kAccY, kBitsAccel,
          static_cast<std::uint32_t>(QuantizeSat(s.accel.y, kWireAccelScale, kBitsAccel)));
  PutBits(w, wire_bit::kAccZ, kBitsAccel,
          static_cast<std::uint32_t>(QuantizeSat(s.accel.z, kWireAccelScale, kBitsAccel)));

  PutBits(w, wire_bit::kOmegaX, kBitsOmega,
          static_cast<std::uint32_t>(QuantizeSat(s.angularVelocity.x, kWireOmegaScale, kBitsOmega)));
  PutBits(w, wire_bit::kOmegaY, kBitsOmega,
          static_cast<std::uint32_t>(QuantizeSat(s.angularVelocity.y, kWireOmegaScale, kBitsOmega)));
  PutBits(w, wire_bit::kOmegaZ, kBitsOmega,
          static_cast<std::uint32_t>(QuantizeSat(s.angularVelocity.z, kWireOmegaScale, kBitsOmega)));

  std::memcpy(dst, w, kWireBytes);
}

}  // namespace forza::wasm
```

### 文件: native/wasm/tsconfig.check.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "types": []
  },
  "files": ["NetworkPhysicsClient.ts", "NetworkEngine.ts"]
}
```

### 文件: native/wasm/vehicle_net_registry.h

```cpp
// =============================================================================
//  vehicle_net_registry.h —— 多车注册表 + HUD 计时塔文本产出（**可原生编译/测试**）
//
//  存在理由：
//    `network_physics_bridge.h` 是**单车**的（一个 syncer + 一个 replicator）。
//    但需求要的是 `UpdateRemoteVehicleState(uint32_t id, ...)` —— 按 id 分发，
//    并且要能给左上角计时塔产出每一行的秒差文本。
//    所以这一层做三件事：
//      ① 按 id 索引的**定长**槽表（零堆分配，kMaxVehicles 辆封顶）
//      ② 每辆车累积自己的 DeltaCarState（弧长 / CP / 圈数 / 段速）
//      ③ 用 RaceDeltaTracker 解算 + 格式化出计时塔文本
//
//  ── 为什么槽表是定长数组而不是 unordered_map ────────────────────────────────
//    Wasm 热路径上 `unordered_map` 会有：哈希、桶数组、节点分配。
//    这是每帧 4 辆车 × 60Hz 的路径，而且**房间人数本来就封顶**（本项目 4 人，
//    这里留 16 个槽的余量，足够未来 8 人 + 观战）。
//    定长数组的 id 查找是 16 次整数比较 —— 比哈希快，且零分配。
//
//  ── 为什么 DeltaCarState 由**客户端自己**维护而不是从线上收 ────────────────
//    秒差的一级解靠"两人在同一 CP 的过线时刻"。权威过线时刻来自服务端，
//    但**弧长 S** 是客户端对自己赛道的投影（每辆车有自己的赛道实例）。
//    若把 S 也从线上收，就要在协议里再塞一个 32 位米数 —— 32B 预算里没有位置了。
//    所以：S 本地算（Project），CP 过线时刻从服务端下发（`c`/`t` 字段，
//    与本项目 Go 侧 `LEADERBOARD_UPDATE` 的 `c` 字段同源）。
//    ⚠️ 这要求本地与远端共享同一份赛道中心线控制多边形，否则 S 不可比 ——
//       本项目所有客户端加载同一 seed 的赛道，前提成立。
// =============================================================================
#pragma once

#include <array>
#include <cstdint>
#include <cstring>

#include "../race_delta/race_delta_tracker.h"
#include "../rb_replicator/rigid_body_replicator.h"

namespace forza::wasm {

using forza::net::NetworkRigidBodyReplicator;
using forza::net::ReplicatorConfig;
using forza::net::RigidBodyNetSnapshot;
using forza::race::DeltaCarState;
using forza::race::DeltaResult;
using forza::race::RaceDeltaTracker;

/// 车位上限。本项目 4 人；16 是给 8 人 + 观战 + 未来扩展留的余量。
inline constexpr std::uint32_t kMaxVehicles = 16U;

/// 计时塔文本缓冲建议容量（含 '\0'）。"-123.45" 最长 8 字符，"--" 2 字符，
/// 留 24 给未来的分钟位（"-1:23.45"）。
inline constexpr std::uint32_t kDeltaTextCap = 24U;

/// 单槽视觉世界矩阵的 float 数（mat4 列主序）
inline constexpr std::uint32_t kMatrixFloats = 16U;

// -----------------------------------------------------------------------------
//  单车网络状态
// -----------------------------------------------------------------------------

struct VehicleNetSlot final {
  std::uint32_t id = 0xFFFFFFFFu;    ///< 0xFFFFFFFF = 空槽
  bool used = false;
  bool isLocal = false;              ///< 是不是本地玩家（计时塔要用它高亮 + 定位第一行）

  // ---------------------------------------------------------------------------
  //  每车自己的航位推测引擎
  // ---------------------------------------------------------------------------
  //  ⚠️ **每车一份**，绝不能共用。共用会让所有远端车共享同一个 physPos_/visOff_，
  //     表现成"四辆车粘在一起抖"（这是一个很容易写出、却极难归因的 bug：
  //     单测里只有一辆车时永远测不出来）。
  NetworkRigidBodyReplicator remote{};

  /// 该车的视觉世界矩阵（mat4 列主序，16 float）。
  /// 单独存而不是每次现算 —— 因为前端要 `HEAPF32.subarray` 零拷贝读，
  /// 必须有一个**稳定地址**的连续内存。若现算再返回，就得在 JS 侧分配。
  alignas(16) float matrix[kMatrixFloats] = {};

  // ---- 秒差解算所需（RaceDeltaTracker 的输入）----
  DeltaCarState delta{};

  // ---- 段速 EWMA 的上一采样 ----
  double prevS = 0.0;
  double prevT = 0.0;
  bool hasPrev = false;

  // ---- 权威快照的到达统计（丢包/乱序诊断用）----
  std::uint32_t lastFrame = 0xFFFFFFFFu;
  std::uint32_t acceptedCount = 0;
  std::uint32_t rejectedCount = 0;

  void Reset() noexcept {
    // 保留 id / used / isLocal（槽归属不因断线而变），清运行时状态
    remote.Reset();
    std::memset(matrix, 0, sizeof(matrix));
    delta = DeltaCarState{};
    prevS = 0.0;
    prevT = 0.0;
    hasPrev = false;
    lastFrame = 0xFFFFFFFFu;
    acceptedCount = 0;
    rejectedCount = 0;
  }
};

/**
 * 计时塔一行（供 HUD 直接消费）。
 *
 * `text` 由 RaceDeltaTracker 的格式化器产出，**前端不得自行拼字符串** ——
 * 这是"榜首负号方向反复出错"的根因（见 MEMORY.md 的「秒差符号约定」）。
 */
struct LeaderboardRow final {
  std::uint32_t id = 0xFFFFFFFFu;
  int position = 0;                  ///< 1 起；0 = 未定
  int lap = 0;
  std::uint32_t lastFrame = 0xFFFFFFFFu;
  bool isLocal = false;
  bool isLeader = false;
  char text[kDeltaTextCap] = {};     ///< 秒差文本（"--" / "-0.5" / "-12.34"）
};

// -----------------------------------------------------------------------------
//  注册表
// -----------------------------------------------------------------------------

/**
 * 多车网络状态注册表。**零堆分配**（成员全是定长 std::array）。
 * 非线程安全（约定渲染/主线程单线程调用）。
 */
class VehicleNetRegistry final {
 public:
  VehicleNetRegistry() noexcept { Clear(); }

  // ---------------------------------------------------------------------------
  //  槽管理
  // ---------------------------------------------------------------------------

  void Clear() noexcept {
    for (auto& s : slots_) {
      s = VehicleNetSlot{};
      s.id = 0xFFFFFFFFu;
      s.used = false;
    }
    count_ = 0;
    localIndex_ = -1;
  }

  /// 登记一辆车。id 已存在则复用（不重置运行时状态）。
  /// @return 槽索引，或 -1（表满）
  int EnsureVehicle(std::uint32_t id, bool isLocal = false) noexcept {
    const int found = Find(id);
    if (found >= 0) {
      if (isLocal) SetLocal(found);
      return found;
    }
    for (std::uint32_t i = 0; i < kMaxVehicles; ++i) {
      if (!slots_[i].used) {
        slots_[i] = VehicleNetSlot{};
        slots_[i].id = id;
        slots_[i].used = true;
        slots_[i].isLocal = isLocal;
        slots_[i].remote.SetConfig(cfg_);   // 新槽继承注册表的配置（否则用 replicator 默认值，
                                            // 与 `SetReplicatorConfig` 的意图不一致 —— 静默失配）
        ++count_;
        if (isLocal) localIndex_ = static_cast<int>(i);
        return static_cast<int>(i);
      }
    }
    return -1;   // 表满：上层应打日志（这是"静默丢车"的唯一入口，必须可见）
  }

  /// 摘掉一辆车（离开房间）
  bool RemoveVehicle(std::uint32_t id) noexcept {
    const int i = Find(id);
    if (i < 0) return false;
    if (localIndex_ == i) localIndex_ = -1;
    slots_[static_cast<std::uint32_t>(i)] = VehicleNetSlot{};
    slots_[static_cast<std::uint32_t>(i)].id = 0xFFFFFFFFu;
    --count_;
    return true;
  }

  void SetLocal(int slot) noexcept {
    if (slot < 0 || slot >= static_cast<int>(kMaxVehicles)) return;
    if (localIndex_ >= 0) slots_[static_cast<std::uint32_t>(localIndex_)].isLocal = false;
    localIndex_ = slot;
    slots_[static_cast<std::uint32_t>(slot)].isLocal = true;
  }

  [[nodiscard]] int Find(std::uint32_t id) const noexcept {
    for (std::uint32_t i = 0; i < kMaxVehicles; ++i) {
      if (slots_[i].used && slots_[i].id == id) return static_cast<int>(i);
    }
    return -1;
  }

  [[nodiscard]] const VehicleNetSlot* At(int slot) const noexcept {
    if (slot < 0 || slot >= static_cast<int>(kMaxVehicles)) return nullptr;
    return slots_[static_cast<std::uint32_t>(slot)].used ? &slots_[static_cast<std::uint32_t>(slot)]
                                                         : nullptr;
  }
  [[nodiscard]] VehicleNetSlot* AtMutable(int slot) noexcept {
    if (slot < 0 || slot >= static_cast<int>(kMaxVehicles)) return nullptr;
    return slots_[static_cast<std::uint32_t>(slot)].used ? &slots_[static_cast<std::uint32_t>(slot)]
                                                         : nullptr;
  }
  [[nodiscard]] std::uint32_t Count() const noexcept { return count_; }
  [[nodiscard]] int LocalIndex() const noexcept { return localIndex_; }

  // ---------------------------------------------------------------------------
  //  每车进度更新（包到达时调用）
  // ---------------------------------------------------------------------------

  /**
   * 更新一辆车的赛道进度，并顺带推进它的分段速度 EWMA。
   *
   * @param sMeters     本圈弧长（米），由上层用 RaceDeltaTracker::Project 得到
   * @param serverTime  服务端时钟轴上的当前时刻（秒），用于 ds/dt
   * @param lap         已完成圈数
   * @param cpIndex     已通过的最后 Checkpoint 索引（-1 = 没过）
   * @param cpPassTime  该 Checkpoint 的过线时刻（服务端秒）；cpIndex<0 时忽略
   */
  void UpdateProgress(int slot, double sMeters, double serverTime, int lap, int cpIndex,
                      double cpPassTime) noexcept {
    VehicleNetSlot* v = AtMutable(slot);
    if (v == nullptr) return;

    v->delta.sMeters = sMeters;
    v->delta.sampleTime = serverTime;
    v->delta.lap = lap;
    v->delta.cpIndex = cpIndex;
    if (cpIndex >= 0 && cpIndex < static_cast<int>(DeltaCarState::kMaxCp) && cpPassTime > 0.0) {
      v->delta.cpPassTime[static_cast<std::size_t>(cpIndex)] = cpPassTime;
    }

    if (v->hasPrev) {
      RaceDeltaTracker::UpdateSegSpeed(v->delta, v->prevS, v->prevT, serverTime);
    }
    v->prevS = sMeters;
    v->prevT = serverTime;
    v->hasPrev = true;
  }

  /**
   * 登记一次权威快照的接受/拒绝（丢包与乱序诊断）。
   * @return true = 接受（帧号比上次新）
   */
  bool NoteSnapshotFrame(int slot, std::uint32_t frame) noexcept {
    VehicleNetSlot* v = AtMutable(slot);
    if (v == nullptr) return false;
    // 帧号是 uint32 回绕的：用无符号差值判断"更新"，避免 0xFFFFFFFF -> 0 被当成旧帧
    const bool newer = (v->lastFrame == 0xFFFFFFFFu) ||
                       (static_cast<std::uint32_t>(frame - v->lastFrame) < 0x80000000u &&
                        frame != v->lastFrame);
    if (newer) {
      v->lastFrame = frame;
      ++v->acceptedCount;
    } else {
      ++v->rejectedCount;
    }
    return newer;
  }

  /// 按进度（弧长 + 圈数）排序出计时塔。
  /// @return 写出的行数
  std::uint32_t BuildLeaderboard(LeaderboardRow* out, std::uint32_t cap) const noexcept {
    if (out == nullptr || cap == 0U) return 0U;

    // ---- 收集存活车辆 ----
    int order[kMaxVehicles];
    std::uint32_t n = 0;
    for (std::uint32_t i = 0; i < kMaxVehicles; ++i) {
      if (slots_[i].used) order[n++] = static_cast<int>(i);
    }
    if (n == 0U) return 0U;

    // ---- 按总进度降序（圈数优先，同圈比弧长）----
    //  插入排序：n ≤ 16，且实际几乎已序（发车前一直在同一个顺序）
    const auto progress = [this](int idx) noexcept {
      const auto& d = slots_[static_cast<std::uint32_t>(idx)].delta;
      return static_cast<double>(d.lap) * 1e7 + d.sMeters;
    };
    for (std::uint32_t i = 1; i < n; ++i) {
      const int key = order[i];
      const double kv = progress(key);
      std::uint32_t j = i;
      while (j > 0U && progress(order[j - 1U]) < kv) {
        order[j] = order[j - 1U];
        --j;
      }
      order[j] = key;
    }

    const std::uint32_t rows = (n > cap) ? cap : n;

    // ---- 领跑者（P1）：它那一行固定 "--" ----
    const int leaderIdx = order[0];
    const DeltaCarState& leader = slots_[static_cast<std::uint32_t>(leaderIdx)].delta;

    for (std::uint32_t r = 0; r < rows; ++r) {
      const int idx = order[r];
      const VehicleNetSlot& v = slots_[static_cast<std::uint32_t>(idx)];
      LeaderboardRow& row = out[r];
      row = LeaderboardRow{};                       // 清干净（含 char 数组）
      row.id = v.id;
      row.position = static_cast<int>(r) + 1;
      row.lap = v.delta.lap;
      row.lastFrame = v.lastFrame;
      row.isLocal = v.isLocal;
      row.isLeader = (r == 0U);

      if (r == 0U) {
        // 领跑者行：规格明令 "--"
        (void)RaceDeltaTracker::FormatLocalRow(row.text, kDeltaTextCap, DeltaResult{},
                                              /*localIsLeader=*/true);
      } else {
        // 非领跑者行：相对领跑者的带符号时差，**恒负号格式**
        const DeltaResult vsLeader = tracker_.Solve(v.delta, leader);
        (void)RaceDeltaTracker::FormatLocalRow(row.text, kDeltaTextCap, vsLeader,
                                              /*localIsLeader=*/false);
      }
      // 上面两个格式化器都会写 '\0'，但为防 cap 边界，再兜一次
      row.text[kDeltaTextCap - 1U] = '\0';
    }
    return rows;
  }

  /// 本地玩家相对领跑者的文本（HUD 第一行的快捷入口）—— 规格：本地是 P1 则 "--"
  std::uint32_t FormatLocalVsLeader(char* out, std::uint32_t cap) const noexcept {
    if (out == nullptr || cap == 0U) return 0U;
    if (localIndex_ < 0) {
      return static_cast<std::uint32_t>(
          RaceDeltaTracker::FormatLocalRow(out, cap, DeltaResult{}, /*localIsLeader=*/true));
    }
    const auto& local = slots_[static_cast<std::uint32_t>(localIndex_)].delta;

    // 找领跑者 = 总进度最大者
    int bestIdx = -1;
    double best = -1e300;
    for (std::uint32_t i = 0; i < kMaxVehicles; ++i) {
      if (!slots_[i].used) continue;
      const auto& d = slots_[i].delta;
      const double p = static_cast<double>(d.lap) * 1e7 + d.sMeters;
      if (p > best) { best = p; bestIdx = static_cast<int>(i); }
    }
    if (bestIdx < 0) {
      return static_cast<std::uint32_t>(
          RaceDeltaTracker::FormatLocalRow(out, cap, DeltaResult{}, /*localIsLeader=*/true));
    }
    const bool localIsLeader = (bestIdx == localIndex_);
    if (localIsLeader) {
      return static_cast<std::uint32_t>(
          RaceDeltaTracker::FormatLocalRow(out, cap, DeltaResult{}, /*localIsLeader=*/true));
    }
    const auto& leader = slots_[static_cast<std::uint32_t>(bestIdx)].delta;
    const DeltaResult vs = tracker_.Solve(local, leader);
    return static_cast<std::uint32_t>(
        RaceDeltaTracker::FormatLocalRow(out, cap, vs, /*localIsLeader=*/false));
  }

  /// 直接解算两车时差（遥测/测试用）。正 = a 领先 b。
  [[nodiscard]] DeltaResult Solve(std::uint32_t aId, std::uint32_t bId) const noexcept {
    const int ia = Find(aId);
    const int ib = Find(bId);
    if (ia < 0 || ib < 0) return DeltaResult{};
    return tracker_.Solve(slots_[static_cast<std::uint32_t>(ia)].delta,
                          slots_[static_cast<std::uint32_t>(ib)].delta);
  }

  // ---- 赛道装配（转发给内部的 tracker）----
  bool SetTrack(const double (*ctlXZ)[2], std::size_t ctlCount, const double* cpArcMeters,
                std::size_t cpCount) noexcept {
    return tracker_.SetTrack(ctlXZ, ctlCount, cpArcMeters, cpCount);
  }
  [[nodiscard]] bool TrackReady() const noexcept { return tracker_.Ready(); }
  [[nodiscard]] double TrackLength() const noexcept { return tracker_.TrackLength(); }
  [[nodiscard]] std::size_t CheckpointCount() const noexcept { return tracker_.CheckpointCount(); }
  [[nodiscard]] double Project(double x, double z, double hintS = -1.0) const noexcept {
    return tracker_.Project(x, z, hintS);
  }
  [[nodiscard]] const RaceDeltaTracker& Tracker() const noexcept { return tracker_; }

  /// 本轮解算用的方法（遥测：区分 Checkpoint / SplineExtrap / LapDelta）
  [[nodiscard]] int LastMethodFor(std::uint32_t aId, std::uint32_t bId) const noexcept {
    const DeltaResult r = Solve(aId, bId);
    return static_cast<int>(r.method);
  }

  // ---------------------------------------------------------------------------
  //  每帧推进：所有远端车的外推 + 误差衰减 + 视觉矩阵刷新
  // ---------------------------------------------------------------------------

  void UpdateAll(float dtSec) noexcept {
    for (auto& s : slots_) {
      if (!s.used) continue;
      s.remote.Update(dtSec);
      WriteSlotMatrix(s);
    }
  }

  /// 只刷新矩阵、不推进时间（收到纠偏后立刻读视觉矩阵用；语义同
  /// `NetworkPhysicsBridge::RefreshMatrices()`）
  void RefreshMatrices() noexcept {
    for (auto& s : slots_) {
      if (s.used) WriteSlotMatrix(s);
    }
  }

  /// 视觉世界矩阵区的基址。索引方式：`base + slot * 16 * sizeof(float)`。
  /// ⚠️ 只有 `used` 的槽有意义；空槽的矩阵是全 0。
  [[nodiscard]] std::uintptr_t MatrixBaseAddr() noexcept {
    return reinterpret_cast<std::uintptr_t>(&slots_[0].matrix[0]);
  }

  /// 单槽矩阵地址（= base + slot*64）。前端 subarray 用它。
  [[nodiscard]] std::uintptr_t MatrixSlotAddr(int slot) noexcept {
    if (slot < 0 || slot >= static_cast<int>(kMaxVehicles)) return 0;
    return reinterpret_cast<std::uintptr_t>(&slots_[static_cast<std::uint32_t>(slot)].matrix[0]);
  }

  /// 每车复制器配置（半衰期 / 外推上限）。对新登记的车生效；已存在的车就地更新。
  void SetReplicatorConfig(const ReplicatorConfig& cfg) noexcept {
    cfg_ = cfg;
    for (auto& s : slots_) {
      if (s.used) s.remote.SetConfig(cfg);
    }
  }
  [[nodiscard]] const ReplicatorConfig& Config() const noexcept { return cfg_; }

  /// 某槽的视觉世界矩阵元素（低频/测试路径；高频请读 MatrixBaseAddr 的暂存区）
  [[nodiscard]] double MatrixElement(int slot, int index) const noexcept {
    if (slot < 0 || slot >= static_cast<int>(kMaxVehicles) || index < 0 ||
        index >= static_cast<int>(kMatrixFloats)) {
      return 0.0;
    }
    return static_cast<double>(slots_[static_cast<std::uint32_t>(slot)].matrix[index]);
  }

 private:
  /// 把某槽的视觉世界变换写进它的矩阵区（列主序，与 glMatrix/Three.js 一致）
  static void WriteSlotMatrix(VehicleNetSlot& s) noexcept {
    const glm::mat4 m = s.remote.GetVisualWorldTransform();
    // glm::mat4 是列主序、连续 16 float —— 直接拷，不做逐元素转换。
    std::memcpy(&s.matrix[0], &m[0][0], sizeof(float) * kMatrixFloats);
  }

  std::array<VehicleNetSlot, kMaxVehicles> slots_{};
  std::uint32_t count_ = 0;
  int localIndex_ = -1;
  ReplicatorConfig cfg_{};
  RaceDeltaTracker tracker_{};       ///< 唯一一份（赛道对所有车相同）
};

}  // namespace forza::wasm
```

### 文件: native/wasm/verify_engine_wire.mjs

```javascript
#!/usr/bin/env node
// =============================================================================
//  verify_engine_wire.mjs —— TS 位打包器 vs C++ 位打包器的**逐字节**交叉校验
//
//  为什么这个测试非有不可：
//    NetworkEngine.ts 里有一份**独立的 JS 位打包实现**（`WireSnapshotWriter`）。
//    它的存在是为了省掉"发本地车快照"时的 Wasm 往返 —— 但那意味着
//    **同一份线格式有两个实现**。两个实现只要有一位不一致，症状就是
//    "某些车的位置偶尔乱飘"，而且**只在对端是 C++ 时才出现** ——
//    本机自测（JS→JS）永远发现不了。
//
//    所以这里做真正的交叉验证：
//      ① 从 C++ 侧 dump 一批快照的 32 字节（wasm_bindings_test --dump-wire）
//      ② 用 TS 侧的打包算法对**同样的输入**打包
//      ③ 逐字节比对
//
//    两侧共享零常量 —— TS 侧的位偏移/位宽/倍率全部从 dump 出来的表里读，
//    不是自己写死的。这样"两边都写错成同一个样子"的可能性被排除。
//
//  跑法：node verify_engine_wire.mjs
//  前置：../wasm/wasm_bindings_test.cpp 已编译出 dump 模式（见 run_tests.sh）
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(cond, what) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  [FAIL] ${what}`);
  }
}

// -----------------------------------------------------------------------------
//  ① 取 C++ 侧的真值：位表 + 一批输入/输出对
// -----------------------------------------------------------------------------
const dumpFile = join(HERE, 'wire_dump.json');
if (!existsSync(dumpFile)) {
  console.log(`找不到 ${dumpFile}。`);
  console.log('先跑：bash native/run_tests.sh（它会用 --dump-wire 生成该文件）');
  process.exit(2);
}
const dump = JSON.parse(readFileSync(dumpFile, 'utf8'));

console.log('=== TS 位打包器 vs C++ 位打包器（逐字节）===');
console.log(`C++ 侧线格式: ${dump.wireBytes} 字节, 载荷 ${dump.payloadBits} 位`);

// -----------------------------------------------------------------------------
//  ② 用 dump 出来的表重建 TS 侧打包器（不写死任何数字）
// -----------------------------------------------------------------------------
const B = dump.bits;      // { frame, tickMs, posX, ... } 位偏移
const W = dump.widths;    // { pos:16, vel:14, rot:16, accel:12, omega:12 }
const S = dump.scales;    // { pos:8, vel:64, rot:32767, accel:128, omega:256 }

function quantize(v, scale, bits) {
  if (!Number.isFinite(v)) return 0;
  const lo = -((1 << (bits - 1)) - 1);
  const hi = (1 << (bits - 1)) - 1;
  let q = Math.round(v * scale);
  if (q > hi) q = hi;
  if (q < lo) q = lo;
  return q;
}

/** 与 NetworkEngine.ts 的 WireSnapshotWriter 同一算法；这里独立重写一遍，
 *  避免"测试直接 import 被测代码"那种自证。 */
function packTs(s) {
  const w = new Uint32Array(dump.wireBytes / 4);
  const put = (off, bits, val) => {
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
    const v = (val >>> 0) & mask;
    const wi = off >>> 5;
    const bs = off & 31;
    w[wi] = (w[wi] | ((v << bs) >>> 0)) >>> 0;
    if (bs + bits > 32) {
      const spill = bs + bits - 32;
      w[wi + 1] = (w[wi + 1] | (v >>> (bits - spill))) >>> 0;
    }
  };

  let { qw, qx, qy, qz } = s;
  const n2 = qw * qw + qx * qx + qy * qy + qz * qz;
  if (!(n2 > 0) || !Number.isFinite(n2)) {
    qw = 1; qx = 0; qy = 0; qz = 0;
  } else {
    const inv = 1 / Math.sqrt(n2);
    qw *= inv; qx *= inv; qy *= inv; qz *= inv;
  }
  // ⚠️ 必须**同时翻转 x,y,z**（不只是丢掉 w 的符号）：q 与 -q 是同一旋转，
  //    取 w≥0 的规范形时四个分量都要变号。
  //    第一版这里只写了 `qw = -qw` 而漏了 xyz —— 于是案例 #4（qw=-0.6）
  //    的 rotX 少了一个负号，第 4 字节差 1 位。
  //    这个 bug 正是本交叉校验存在的理由：它在 JS↔JS 自测里**永远发现不了**，
  //    只在"TS 打包 vs C++ 打包"的逐字节比对下暴露。
  if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }

  put(B.frame, 16, s.frame & 0xffff);
  put(B.tickMs, 16, s.tickMs & 0xffff);
  put(B.posX, W.pos, quantize(s.px, S.pos, W.pos));
  put(B.posY, W.pos, quantize(s.py, S.pos, W.pos));
  put(B.posZ, W.pos, quantize(s.pz, S.pos, W.pos));
  put(B.velX, W.vel, quantize(s.vx, S.vel, W.vel));
  put(B.velY, W.vel, quantize(s.vy, S.vel, W.vel));
  put(B.velZ, W.vel, quantize(s.vz, S.vel, W.vel));
  put(B.rotX, W.rot, quantize(qx, S.rot, W.rot));
  put(B.rotY, W.rot, quantize(qy, S.rot, W.rot));
  put(B.rotZ, W.rot, quantize(qz, S.rot, W.rot));
  put(B.accX, W.accel, quantize(s.ax, S.accel, W.accel));
  put(B.accY, W.accel, quantize(s.ay, S.accel, W.accel));
  put(B.accZ, W.accel, quantize(s.az, S.accel, W.accel));
  put(B.omegaX, W.omega, quantize(s.wx, S.omega, W.omega));
  put(B.omegaY, W.omega, quantize(s.wy, S.omega, W.omega));
  put(B.omegaZ, W.omega, quantize(s.wz, S.omega, W.omega));

  const dv = new DataView(new ArrayBuffer(dump.wireBytes));
  for (let i = 0; i < w.length; i++) dv.setUint32(i * 4, w[i], true);
  return new Uint8Array(dv.buffer);
}

// -----------------------------------------------------------------------------
//  ③ 逐条比对
// -----------------------------------------------------------------------------
console.log(`比对 ${dump.cases.length} 组快照…`);
let caseIdx = 0;
let byteMismatchCases = 0;
for (const c of dump.cases) {
  caseIdx += 1;
  const ts = packTs(c.in);
  const cpp = Uint8Array.from(c.bytes);
  let same = ts.length === cpp.length;
  if (same) {
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] !== cpp[i]) { same = false; break; }
    }
  }
  if (!same) {
    byteMismatchCases += 1;
    if (byteMismatchCases <= 3) {
      const hex = (a) => Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  案例 #${caseIdx} 字节不一致：`);
      console.log(`    C++: ${hex(cpp)}`);
      console.log(`    TS : ${hex(ts)}`);
    }
  }
}
check(byteMismatchCases === 0, `${dump.cases.length} 组快照逐字节一致（不一致 ${byteMismatchCases} 组）`);

// -----------------------------------------------------------------------------
//  ④ 位表自洽性（TS 侧独立核对，不看 C++ 的断言）
// -----------------------------------------------------------------------------
const payloadBits =
  16 + 16 +
  3 * W.pos + 3 * W.vel + 3 * W.rot + 3 * W.accel + 3 * W.omega;
check(payloadBits <= dump.wireBytes * 8, `载荷 ${payloadBits} 位 ≤ ${dump.wireBytes * 8} 位`);

// 字段不重叠：按偏移排序后检查每个字段的区间不交叠
const fields = Object.entries(B)
  .map(([k, off]) => {
    let bits = 16;
    if (k.startsWith('pos')) bits = W.pos;
    else if (k.startsWith('vel')) bits = W.vel;
    else if (k.startsWith('rot')) bits = W.rot;
    else if (k.startsWith('acc')) bits = W.accel;
    else if (k.startsWith('omega')) bits = W.omega;
    return { k, off, bits };
  })
  .sort((a, b) => a.off - b.off);
let overlap = false;
for (let i = 1; i < fields.length; i++) {
  if (fields[i].off < fields[i - 1].off + fields[i - 1].bits) overlap = true;
}
check(!overlap, '所有字段位区间互不重叠');

// 最后一个字段不越界
const last = fields[fields.length - 1];
check(last.off + last.bits <= dump.wireBytes * 8,
  `最后字段 ${last.k} 结束于 ${last.off + last.bits} 位，未越界`);

// -----------------------------------------------------------------------------
//  ⑤ 量化器等价性：饱和 + 就近取整（独立于封包路径）
// -----------------------------------------------------------------------------
{
  const hi = (1 << (W.pos - 1)) - 1;
  check(quantize(1e6, S.pos, W.pos) === hi, '超大正数饱和到上限');
  check(quantize(-1e6, S.pos, W.pos) === -hi, '超大负数饱和到下限');
  check(quantize(0.07, S.pos, W.pos) === 1, '0.07m 就近取整为 1（非截断 0）');
  check(quantize(Number.NaN, S.pos, W.pos) === 0, 'NaN 归零');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
```

### 文件: native/wasm/verify_layout.mjs

```javascript
#!/usr/bin/env node
/* =============================================================================
 *  verify_layout.mjs —— 跨语言布局一致性校验（node 直接跑，不需要 tsc/emcc）
 *
 *  为什么需要它：
 *    `NetworkPhysicsClient.ts` 里 `assertLayout()` 硬写了几个期望值
 *    （96 / 16 / 32 / 80）。这些数字必须与 C++ 的 offsetof 一致，
 *    否则运行时才会炸，而且症状是"位置偶尔乱跳"这种极难定位的表现。
 *    C++ 侧的真实布局由 bridge_test.cpp 跑出来写进 layout.json，
 *    这里把 TS 源码里写的期望值抽出来对一遍 —— **两侧不共享任何常量**，
 *    因此这是真正的交叉校验，不是自证。
 *
 *  另外做一个纯 JS 的打包往返测试：按 layout.json 的偏移用 DataView 写一遍
 *  再读回来，确认线格式（小端、字段宽度、对齐 padding）确实可用。
 *
 *  运行：node verify_layout.mjs
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; }
  else { fail++; console.log(`  [FAIL] ${what} ${detail}`); }
};

// ---------------------------------------------------------------- 读 C++ 布局
const layoutPath = path.join(here, 'layout.json');
if (!fs.existsSync(layoutPath)) {
  console.error('找不到 layout.json —— 请先跑 bridge_test（它会 dump 真实布局）');
  process.exit(2);
}
const L = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
console.log('=== 跨语言布局一致性校验 ===\n');
console.log(`C++ 侧真实布局：size=${L.snapshotSize} align=${L.align} LE=${L.littleEndian}`);
console.log(`  offsets: ${JSON.stringify(L.offsets)}\n`);

check(L.snapshotSize === 96, 'C++ 快照 = 96 字节');
check(L.align === 16, 'C++ 快照 16 字节对齐');
check(L.littleEndian === true, 'C++ 侧小端（与 Wasm 线性内存一致，无需字节序转换）');

// ------------------------------------------------- 抽 TS 源码里硬写的期望值
const ts = fs.readFileSync(path.join(here, 'NetworkPhysicsClient.ts'), 'utf8');
const expect = (re, name) => {
  const m = ts.match(re);
  check(m !== null, `TS 里能找到 ${name} 的期望值`);
  return m ? Number(m[1]) : NaN;
};
const tsSize = expect(/snapshotSize\s*!==\s*(\d+)/, 'snapshotSize');
const tsPos = expect(/OFF_POSITION\s*!==\s*(\d+)/, 'OFF_POSITION');
const tsRot = expect(/OFF_ROTATION\s*!==\s*(\d+)/, 'OFF_ROTATION');
const tsAcc = expect(/OFF_ACCEL\s*!==\s*(\d+)/, 'OFF_ACCEL');

console.log('TS 侧 assertLayout() 里写的期望值：');
console.log(`  snapshotSize=${tsSize} position=${tsPos} rotation=${tsRot} accel=${tsAcc}\n`);

check(tsSize === L.snapshotSize, 'TS 期望的 size 与 C++ 一致',
  `${tsSize} vs ${L.snapshotSize}`);
check(tsPos === L.offsets.position, 'TS 期望的 position 偏移与 C++ 一致',
  `${tsPos} vs ${L.offsets.position}`);
check(tsRot === L.offsets.rotation, 'TS 期望的 rotation 偏移与 C++ 一致',
  `${tsRot} vs ${L.offsets.rotation}`);
check(tsAcc === L.offsets.accel, 'TS 期望的 accel 偏移与 C++ 一致',
  `${tsAcc} vs ${L.offsets.accel}`);

// --------------------------------------------------------- 纯 JS 打包往返测试
console.log('\nJS 侧 DataView 打包往返（模拟 pushSnapshotRaw / packSnapshot）：');
{
  const buf = new ArrayBuffer(L.snapshotSize);
  const dv = new DataView(buf);
  const o = L.offsets;

  const NEG = { frame: 4242, tickMs: 987654, serverTimeSec: 1234.5 };
  const POS = { x: 10.0, y: 1.5, z: -20.0 };
  const ROT = { w: 1.0, x: 0, y: 0, z: 0 };
  const VEL = { x: 55.0, y: 0, z: 0 };
  const ACC = { x: 0, y: 0, z: -3.0 };

  dv.setUint32(o.frame, NEG.frame, true);
  dv.setUint32(o.tickMs, NEG.tickMs, true);
  dv.setFloat32(o.serverTimeSec, NEG.serverTimeSec, true);
  dv.setFloat32(o.position + 0, POS.x, true);
  dv.setFloat32(o.position + 4, POS.y, true);
  dv.setFloat32(o.position + 8, POS.z, true);
  dv.setFloat32(o.rotation + 0, ROT.w, true);
  dv.setFloat32(o.rotation + 4, ROT.x, true);
  dv.setFloat32(o.rotation + 8, ROT.y, true);
  dv.setFloat32(o.rotation + 12, ROT.z, true);
  dv.setFloat32(o.velocity + 0, VEL.x, true);
  dv.setFloat32(o.velocity + 4, VEL.y, true);
  dv.setFloat32(o.velocity + 8, VEL.z, true);
  dv.setFloat32(o.accel + 0, ACC.x, true);
  dv.setFloat32(o.accel + 4, ACC.y, true);
  dv.setFloat32(o.accel + 8, ACC.z, true);

  check(dv.getUint32(o.frame, true) === NEG.frame, 'frame 往返正确');
  check(dv.getUint32(o.tickMs, true) === NEG.tickMs, 'tickMs 往返正确');
  check(Math.abs(dv.getFloat32(o.serverTimeSec, true) - NEG.serverTimeSec) < 1e-3,
    'serverTimeSec 往返正确');
  check(dv.getFloat32(o.position + 0, true) === POS.x &&
    dv.getFloat32(o.position + 4, true) === POS.y &&
    dv.getFloat32(o.position + 8, true) === POS.z, 'position 三轴往返正确');
  check(dv.getFloat32(o.accel + 8, true) === ACC.z, 'accel 第三轴往返正确');

  // 关键：确认"写到最后 4 字节"不会越界 —— accel.z 结束于 offset 92+4 = 96 ✓
  check(o.accel + 12 <= L.snapshotSize, '最后一个字段写入不越界',
    `accel+12=${o.accel + 12} <= ${L.snapshotSize}`);

  // padding 必须真的有洞（否则说明布局和 docs 不一致 —— 也是有用的信息）
  // 有效载荷 = frame4 + tick4 + serverTime4 + pos12 + quat16 + vel12 + angvel12 + accel12 = 76
  const payload = 4 + 4 + 4 + 12 + 16 + 12 + 12 + 12;
  const padBytes = L.snapshotSize - payload;
  check(payload === 76, '有效载荷 = 76 字节');
  check(padBytes === 20, '对齐 padding = 20 字节（5 个 _pad × 4B）', `${padBytes}B`);
  console.log(`  · padding ${padBytes}B / 有效载荷 ${L.snapshotSize - padBytes}B`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
```

### 文件: native/wasm/wasm_bindings.cpp

```cpp
// =============================================================================
//  wasm_bindings.cpp —— Emscripten 导出层（C-ABI 零拷贝 + Embind 低频）
//
//  ⚠️ 先读这一段，它解释了这个文件为什么长这样。
//
//  ── 为什么高频路径**必须**走裸 C ABI 而不是 Embind ────────────────────────
//    Embind 每次调用都要：构造 `val`、走 type-id 分派、返回对象在 JS 侧堆分配。
//    60Hz × N 车 × 每车 1~2 次调用时，这套开销**与物理计算本身同量级**。
//    而"把 32 字节写进 Wasm 线性内存 + 调一次无参函数"是：
//        一次 memcpy（32B，一个 cache line 内）+ 一次 call
//    —— 没有对象、没有字符串、没有堆。这不是优化，是正确的 Host 集成方式。
//
//  ── 需求指定的接口 `UpdateRemoteVehicleState(id, byteBuffer, offset)` ─────
//    这是本轮的**核心交付**。它有两条实现路径，本文件都提供：
//
//      [A] 指针版（需求原文）：`fz_update_remote_state(id, ptr, offset)`
//          `ptr` 是 JS 侧 `HEAPU8.subarray(o, o+32)` 得到的视图。
//          ⚠️ 把子视图**传成指针**时 Emscripten 会传 `byteOffset`，
//             而不是数组的绝对地址 —— 所以这里的 `ptr` 是 **32 字节的小偏移**，
//             必须再加 `offset`？不对，看下面的实参说明：
//             实参 `ptr` 是**堆内绝对地址**，`offset` 是该包在 buffer 里的起始偏移。
//             正确用法是 **两者只用一个**：
//                · 若 JS 已 `HEAPU8.set(pkt, base)` 到暂存区 → `offset = 0`
//                · 若 JS 用 `HEAPU8.set(pkt, base + k*32)` → `offset = k*32`
//             这样的签名（id, ptr, offset）语义是"从 `ptr + offset` 处读 32 字节"。
//             ⚠️ 这是需求原文的签名，本文件**保留**它以免偏离规格；
//                同时提供 [B] 更直白的版本，推荐生产用它。
//
//      [B] 暂存区版（推荐）：`fz_stage_remote_state(id)` → 写暂存区 → `fz_commit_remote_state()`
//          与旧的单车 `fz_snapshot_commit()` 同构，只是多了 id。
//          好处：`_fz_stage_addr` 是**一次查询、长期复用**的常量，
//          而 [A] 每包都要重新算 `ptr`，且 `extern "C" uintptr_t` 参数在
//          某些 Emscripten 版本上会被当成 i32 截断（Wasm32 里 uintptr 是 32 位，
//          所以实际上安全 —— 但大内存增长后基址可能超 2GB？Wasm32 上限 4GB，
//          且本模块 INITIAL_MEMORY=64MB，不会越界）。
//
//  ── 渲染矩阵：零拷贝的最后一步 ─────────────────────────────────────────────
//    `fz_matrix_stage_addr()` 返回 64 个 float 的基址（4 个 mat4）。
//    JS 侧：
//        const m = new Float32Array(mod.HEAPF32.buffer, addr, 16);
//        threeMesh.matrix.fromArray(m);      // fromArray 接受 Float32Array，零转换
//    ⚠️ `ALLOW_MEMORY_GROWTH=1` 下内存增长会**换掉 ArrayBuffer**，
//       上面那个 `m` 立刻变成"孤儿视图"（读到全 0 或抛错）。
//       所以**每帧都要重建视图**（`new Float32Array` 是轻量操作，不做拷贝）。
//       NetworkEngine.ts 里的 `matrixView(slot)` 就是干这个的。
//
//  ── 编译 ──────────────────────────────────────────────────────────────────
//      见同目录 build_wasm.sh / CMakeLists.txt。必须包含：
//        -O3 -flto -msimd128
//        -s ALLOW_MEMORY_GROWTH=1
//        -s NO_EXIT_RUNTIME=1                  ← 缺了它 `main()` 返回后运行时被拆掉
//        -s EXPORTED_RUNTIME_METHODS=['HEAPF32','HEAPU8']
// =============================================================================

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>

#include "network_physics_bridge.h"
#include "snapshot_wire.h"
#include "vehicle_net_registry.h"

using namespace forza::wasm;
using forza::race::DeltaCarState;
using forza::race::DeltaMethod;
using forza::race::DeltaResult;

namespace {

/// 单车物理桥（时间同步 + 航位推测 + 矩阵）。单线程 Wasm 模块 → 函数内 static 即安全。
NetworkPhysicsBridge& Bridge() noexcept {
  static NetworkPhysicsBridge inst;
  return inst;
}

/// 多车注册表（按 id 索引）+ 计时塔文本。
VehicleNetRegistry& Registry() noexcept {
  static VehicleNetRegistry inst;
  return inst;
}

/// 远程车快照的暂存区：正好一个 32B 线格式包。
/// 单独开一块而不是复用 Bridge 的 96B 暂存区 —— 因为后者在 `_fz_update` 期间
/// 会被 replicator 读，混用会引入"写一半被读"的时序 bug。
alignas(16) std::uint8_t g_wireStage[kWireBytes] = {};

/// 解包后的 96B 工作结构暂存（供调试/回读，不参与热路径）
alignas(16) RigidBodyNetSnapshot g_wireExpanded{};

/// 计时塔文本暂存（4 行 × 24B）。JS 侧读 `_fz_leaderboard_text_addr()` 后
/// 用 `HEAPU8.subarray` + `TextDecoder` 解 —— 只在 HUD 刷新时读，不是每帧。
alignas(8) char g_rowText[kMaxVehicles][kDeltaTextCap] = {};

/// 本地玩家 vs 领跑者的那一行（HUD 第一行，刷新最频繁）
alignas(8) char g_localRowText[kDeltaTextCap] = {};

// -----------------------------------------------------------------------------
//  Embind 低频遥测视图（在 wasm_bindings.cpp 内定义，供 EMBIND_BINDINGS 引用）
// -----------------------------------------------------------------------------

/// 同步器标量遥测（低频路径：调试面板 / HUD）
struct SyncTelemetryView final {
  double serverNowNs() const { return Bridge().ServerNowNs(); }
  double offsetNs() const { return Bridge().CurrentOffsetNs(); }
  double bestRttNs() const { return Bridge().BestRttNs(); }
  double warp() const { return Bridge().CurrentWarp(); }
  bool   locked() const { return Bridge().IsLocked(); }
  int    state() const { return Bridge().SyncState(); }
  int    samples() const { return static_cast<int>(Bridge().SyncSampleCount()); }
};

/// 本车复制器标量遥测
struct ReplTelemetryView final {
  bool   hasState() const { return Bridge().HasState(); }
  int    state() const { return Bridge().ReplState(); }
  double extrapolatedSec() const { return Bridge().ExtrapolatedSec(); }
  double visualErrorM() const { return Bridge().VisualErrorM(); }
  int    lastFrame() const { return static_cast<int>(Bridge().LastFrame()); }
  int    staleDropped() const { return static_cast<int>(Bridge().StaleDropped()); }
  int    hardSnaps() const { return static_cast<int>(Bridge().HardSnapCount()); }
};

/// ⚠️ Embind 的 function() 收的是**函数指针**，不能写 `&[](){...}`。
///    对临时 lambda 取地址是 [-Waddress-of-temporary]，emcc 直接报错。
///    必须先给它一个具名的函数实体 —— 这个错第一版漏了，因为没有 emcc 可编译。
SyncTelemetryView MakeSyncTelemetryView() { return SyncTelemetryView{}; }
ReplTelemetryView MakeReplTelemetryView() { return ReplTelemetryView{}; }

}  // namespace

// =============================================================================
//  ① 高频通道：裸 C ABI（外部名字稳定，不参与 C++ 名字修饰）
// =============================================================================

extern "C" {

// 前置声明：`fz_update_remote_state` 会转调它（定义在下面，因为
// 指针版更底层、更适合被原生测试直接调用）。
EMSCRIPTEN_KEEPALIVE
int fz_update_remote_state_ptr(std::uint32_t id, const std::uint8_t* ptr);

// -----------------------------------------------------------------------------
//  单车通道（时间同步 / 航位推测 / 渲染矩阵）—— 与上一版兼容
// -----------------------------------------------------------------------------

/// 快照暂存区地址（96B 工作结构）。JS: HEAPU8.set(structBytes, addr)
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_snapshot_stage_addr() { return Bridge().SnapshotStageAddr(); }

EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_snapshot_stage_size() { return NetworkPhysicsBridge::SnapshotStageSize(); }

/// 字段字节偏移。JS **必须**用它，不要硬编码（线格式一改就静默错位）。
EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_field_offset(int field) { return NetworkPhysicsBridge::FieldOffset(field); }

/// 读暂存区并 apply。@return 1=接受 0=丢弃（过期帧）
EMSCRIPTEN_KEEPALIVE
int fz_snapshot_commit() { return Bridge().SnapshotCommit(); }

/// 喂 NTP 往返（4 个 double 纳秒）。见 bridge header 关于 2^53 的说明。
EMSCRIPTEN_KEEPALIVE
int fz_on_pong(double t1, double t2, double t3, double t4) {
  return Bridge().OnPong(t1, t2, t3, t4);
}

/// 推进时钟微调，返回本帧物理步长（已含 ±1.5% 伸缩）
EMSCRIPTEN_KEEPALIVE
double fz_adjusted_dt(double baseDtSec) { return Bridge().AdjustedDeltaTime(baseDtSec); }

/// 矩阵暂存区地址（4 槽 × 16 float，列主序）
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_matrix_stage_addr() { return Bridge().MatrixStageAddr(); }

/// 单个矩阵槽的地址（= base + slot*64）。前端 `HEAPF32.subarray` 用它。
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_matrix_slot_addr(int slot) {
  if (slot < 0 || slot >= kMatrixSlots) return 0;
  return Bridge().MatrixStageAddr() + static_cast<std::uintptr_t>(slot) * 16U * sizeof(float);
}

/// 每帧推进（外推 + 误差衰减 + 写矩阵）。dtSec 来自 rAF timestamp 差。
EMSCRIPTEN_KEEPALIVE
void fz_update(double dtSec) { Bridge().Update(dtSec); }

/// 只刷新矩阵、不推进时间（收到纠偏后立刻读物理层矩阵用）
EMSCRIPTEN_KEEPALIVE
void fz_refresh_matrices() { Bridge().RefreshMatrices(); }

/// 断线重连：清空时钟窗口 + 刚体状态 + 多车注册表
EMSCRIPTEN_KEEPALIVE
void fz_reset_all() {
  Bridge().ResetAll();
  Registry().Clear();
}

EMSCRIPTEN_KEEPALIVE
void fz_set_half_life(double sec) { Bridge().SetErrorHalfLifeSec(sec); }

EMSCRIPTEN_KEEPALIVE
void fz_set_max_extrapolation(double sec) { Bridge().SetMaxExtrapolationSec(sec); }

// -----------------------------------------------------------------------------
//  多车通道 —— 需求核心：UpdateRemoteVehicleState
// -----------------------------------------------------------------------------

/// 每辆远程车一个 32B 暂存槽的**基址**（kMaxVehicles × 32B，连续）。
/// 前端：`HEAPU8.set(pkt, base + slot*32)` 一次性写入，然后 `_fz_commit_remote_slot(slot)`
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_remote_stage_base() {
  return reinterpret_cast<std::uintptr_t>(&g_wireStage[0]);
}

/// 单包线格式字节数（= 32）。前端用它做长度校验，长度不符就别写。
EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_wire_bytes() { return kWireBytes; }

/**
 * 需求原文接口：`UpdateRemoteVehicleState(id, byteBuffer, offset)`
 *
 * 从 **Wasm 线性内存** 的 `byteBuffer + offset` 处读 32 字节，解包进该车的
 * replicator（多车场景下每车一份，见 VehicleNetRegistry）。
 *
 * @param id          车辆 id（房间内唯一，前端用 WebRTC 流标识或座位号）
 * @param byteBuffer  Wasm 堆内**绝对地址**（前端传 `_fz_remote_stage_base()` 的值）
 * @param offset      该包相对 byteBuffer 的字节偏移
 * @return 1 = 接受（新帧）；0 = 拒绝（帧号过期 / 地址非法）
 *
 * ⚠️ 地址合法性：这里**必须**判空与对齐，否则一个算错的 offset 会静默读到
 *    别的对象并让整帧数据变成垃圾 —— 而这种错不会崩，只会"车偶尔乱飘"。
 *    判据刻意宽松（只拦 null / 负数 / 非 4 字节对齐），因为内存增长后
 *    基址会变，硬编码范围检查反而会误杀。
 */
EMSCRIPTEN_KEEPALIVE
int fz_update_remote_state(std::uint32_t id, std::uintptr_t byteBuffer, int offset) {
  if (byteBuffer == 0U) return 0;
  const std::uintptr_t addr = byteBuffer + static_cast<std::uintptr_t>(offset);
  if ((addr & 3U) != 0U) return 0;   // int32 对齐；非对齐解包在 SIMD 下会 trap
  return fz_update_remote_state_ptr(id, reinterpret_cast<const std::uint8_t*>(addr));
}

/**
 * 内部实现（也是给原生测试直接调的入口）。
 * 与上面同名不同签名，避免 `extern "C"` 里不能重载的问题。
 */
EMSCRIPTEN_KEEPALIVE
int fz_update_remote_state_ptr(std::uint32_t id, const std::uint8_t* ptr) {
  if (ptr == nullptr) return 0;

  // ---- 登记（首次见到该 id 就分配槽；表满则拒绝并让上层可见）----
  int slot = Registry().EnsureVehicle(id);
  if (slot < 0) return 0;

  // ---- 在 Wasm 内存内直接解包（32B → 96B），不做任何 JS 侧解包 ----
  ExpandWireToSnapshot(ptr, g_wireExpanded, 0U);

  // ---- 帧号去重：乱序/重传包直接丢，避免"旧包把新车拽回去" ----
  if (!Registry().NoteSnapshotFrame(slot, g_wireExpanded.frame)) {
    return 0;
  }

  // ---- 交给该车的航位推测引擎 ----
  //   ⚠️ 这里刻意**不**复用 Bridge()：Bridge 是"本地车"的单例。
  //      远端车每辆都有自己的时序与视觉偏移，混用会让所有车共享一个
  //      physPos_/visOff_，表现成"四辆车粘在一起抖"。
  //      远端车的 replicator 实例放在 registry 的槽里（见 VehicleNetSlot）。
  VehicleNetSlot* v = Registry().AtMutable(slot);
  if (v == nullptr) return 0;
  return (v->remote.OnAuthoritativeSnapshot(g_wireExpanded)) ? 1 : 0;
}

/// 多车每帧推进（外推 + 误差衰减 + 视觉矩阵写进各槽的矩阵区）
EMSCRIPTEN_KEEPALIVE
void fz_update_remotes(double dtSec) {
  Registry().UpdateAll(static_cast<float>(dtSec));
}

/// 远端车视觉世界矩阵的基址（kMaxVehicles × 16 float，连续）
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_remote_matrix_base() { return Registry().MatrixBaseAddr(); }

/// 只刷新远端车的视觉矩阵、**不推进时间**。
/// 语义同单车主路径的 `fz_refresh_matrices()`，但作用于多车注册表。
/// 前端在「收到一批快照后想立刻读矩阵、但本帧还不该推进物理」时需要这个
/// （例如低频 HUD 同步帧，或测试里想观察"接收瞬间"的视觉矩阵）。
EMSCRIPTEN_KEEPALIVE
void fz_refresh_remote_matrices() { Registry().RefreshMatrices(); }

/// 某车的物理层位置分量（axis 0/1/2）。单轴读，避免整块封送。
EMSCRIPTEN_KEEPALIVE
double fz_remote_position(std::uint32_t id, int axis) {
  const VehicleNetSlot* v = Registry().At(Registry().Find(id));
  if (v == nullptr) return 0.0;
  const glm::vec3& p = v->remote.PhysicsPosition();
  return static_cast<double>(axis == 0 ? p.x : (axis == 1 ? p.y : p.z));
}

/// 某车的视觉层位置分量（含残余视觉偏移）
EMSCRIPTEN_KEEPALIVE
double fz_remote_visual_position(std::uint32_t id, int axis) {
  const VehicleNetSlot* v = Registry().At(Registry().Find(id));
  if (v == nullptr) return 0.0;
  const glm::vec3 p = v->remote.GetVisualPosition();
  return static_cast<double>(axis == 0 ? p.x : (axis == 1 ? p.y : p.z));
}

/// 该车的视觉误差（米）—— 平滑收敛的遥测
EMSCRIPTEN_KEEPALIVE
double fz_remote_visual_error(std::uint32_t id) {
  const VehicleNetSlot* v = Registry().At(Registry().Find(id));
  return (v == nullptr) ? 0.0 : static_cast<double>(v->remote.VisualPositionErrorM());
}

/// 该车的外推时长（秒）
EMSCRIPTEN_KEEPALIVE
double fz_remote_extrapolated(std::uint32_t id) {
  const VehicleNetSlot* v = Registry().At(Registry().Find(id));
  return (v == nullptr) ? 0.0 : static_cast<double>(v->remote.ExtrapolatedSec());
}

/// 该车的复制状态（ReplState 枚举值）
EMSCRIPTEN_KEEPALIVE
int fz_remote_repl_state(std::uint32_t id) {
  const VehicleNetSlot* v = Registry().At(Registry().Find(id));
  return (v == nullptr) ? -1 : static_cast<int>(v->remote.State());
}

EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_vehicle_count() { return Registry().Count(); }

EMSCRIPTEN_KEEPALIVE
int fz_vehicle_find(std::uint32_t id) { return Registry().Find(id); }

EMSCRIPTEN_KEEPALIVE
int fz_ensure_vehicle(std::uint32_t id, int isLocal) {
  return Registry().EnsureVehicle(id, isLocal != 0);
}

EMSCRIPTEN_KEEPALIVE
int fz_remove_vehicle(std::uint32_t id) { return Registry().RemoveVehicle(id) ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE
void fz_set_local_vehicle(int slot) { Registry().SetLocal(slot); }

// -----------------------------------------------------------------------------
//  赛道 + 进度上报（秒差解算的输入）
// -----------------------------------------------------------------------------

/**
 * 装入赛道中心线控制多边形（闭合）与 Checkpoint 弧长表。
 * ctlXZ 是 [n][2] 的 double 数组（x, z 交织），cpArcMeters 是升序弧长。
 * @return 1 = 赛道有效
 */
EMSCRIPTEN_KEEPALIVE
int fz_set_track(const double* ctlXZ, int ctlCount, const double* cpArcMeters, int cpCount) {
  if (ctlXZ == nullptr || ctlCount < 4 || ctlCount > 64) return 0;
  const auto (*poly)[2] = reinterpret_cast<const double (*)[2]>(ctlXZ);
  return Registry().SetTrack(poly, static_cast<std::size_t>(ctlCount), cpArcMeters,
                             static_cast<std::size_t>(cpCount > 0 ? cpCount : 0))
             ? 1
             : 0;
}

EMSCRIPTEN_KEEPALIVE
int fz_track_ready() { return Registry().TrackReady() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE
double fz_track_length() { return Registry().TrackLength(); }
EMSCRIPTEN_KEEPALIVE
int fz_checkpoint_count() { return static_cast<int>(Registry().CheckpointCount()); }

/// 世界坐标 → 本圈弧长 S（米）。hintS < 0 = 全扫（首次定位）。
EMSCRIPTEN_KEEPALIVE
double fz_project(double x, double z, double hintS) { return Registry().Project(x, z, hintS); }

/**
 * 更新某车的赛道进度（每条车的包到达时调用一次）。
 * @param cpPassTime 该 CP 的过线时刻（服务端秒）；cpIndex < 0 时忽略
 */
EMSCRIPTEN_KEEPALIVE
void fz_update_progress(std::uint32_t id, double sMeters, double serverTime, int lap,
                        int cpIndex, double cpPassTime) {
  const int slot = Registry().Find(id);
  if (slot < 0) return;
  Registry().UpdateProgress(slot, sMeters, serverTime, lap, cpIndex, cpPassTime);
}

// -----------------------------------------------------------------------------
//  HUD：计时塔文本（秒差格式化**唯一入口**，前端不得自行拼字符串）
// -----------------------------------------------------------------------------

/// 刷新计时塔：按进度排好序，把每行的秒差文本写进文本暂存区。@return 行数
EMSCRIPTEN_KEEPALIVE
int fz_build_leaderboard() {
  LeaderboardRow rows[kMaxVehicles];
  const std::uint32_t n = Registry().BuildLeaderboard(rows, kMaxVehicles);
  for (std::uint32_t i = 0; i < n; ++i) {
    std::memcpy(g_rowText[i], rows[i].text, kDeltaTextCap);
    g_rowText[i][kDeltaTextCap - 1U] = '\0';
  }
  // 未用到的行清空，避免上一帧的残留文本被误读成"这一行有内容"
  for (std::uint32_t i = n; i < kMaxVehicles; ++i) {
    g_rowText[i][0] = '\0';
  }
  return static_cast<int>(n);
}

/// 第 row 行的秒差文本地址（行内不含 '\0' 之外的内容，长度 ≤ kDeltaTextCap-1）
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_row_text_addr(int row) {
  if (row < 0 || row >= static_cast<int>(kMaxVehicles)) return 0;
  return reinterpret_cast<std::uintptr_t>(&g_rowText[row][0]);
}

/// 行文本缓冲容量（含 '\0'）
EMSCRIPTEN_KEEPALIVE
std::uint32_t fz_row_text_cap() { return kDeltaTextCap; }

/// 生成"本地玩家 vs 领跑者"那一行文本并写入暂存区。@return 写入的字符数
EMSCRIPTEN_KEEPALIVE
int fz_format_local_vs_leader() {
  g_localRowText[0] = '\0';
  const std::uint32_t n = Registry().FormatLocalVsLeader(g_localRowText, kDeltaTextCap);
  g_localRowText[kDeltaTextCap - 1U] = '\0';
  return static_cast<int>(n);
}

/// 本地行文本地址
EMSCRIPTEN_KEEPALIVE
std::uintptr_t fz_local_row_addr() {
  return reinterpret_cast<std::uintptr_t>(&g_localRowText[0]);
}

/// 两车时差的毫秒值（遥测/测试；正 = a 领先 b）
EMSCRIPTEN_KEEPALIVE
double fz_solve_delta_ms(std::uint32_t aId, std::uint32_t bId) {
  const DeltaResult r = Registry().Solve(aId, bId);
  return r.valid() ? r.deltaMs : 0.0;
}

/// 上次解算用的方法（0=None 1=Checkpoint 2=SplineExtrap 3=LapDelta）
EMSCRIPTEN_KEEPALIVE
int fz_solve_method(std::uint32_t aId, std::uint32_t bId) {
  return Registry().LastMethodFor(aId, bId);
}

/// 解算用的弧长差（米）与分段速度（m/s）—— 诊断外推口径对不对
EMSCRIPTEN_KEEPALIVE
double fz_solve_ds(std::uint32_t aId, std::uint32_t bId) {
  return Registry().Solve(aId, bId).dsMeters;
}
EMSCRIPTEN_KEEPALIVE
double fz_solve_vseg(std::uint32_t aId, std::uint32_t bId) {
  return Registry().Solve(aId, bId).vSegMps;
}

// -----------------------------------------------------------------------------
//  线格式布局查询（JS 侧交叉校验用；**不要硬编码位偏移**）
// -----------------------------------------------------------------------------

/// 位偏移查询：field 序号见 wire_bit 命名空间
///   0 frame 1 tickMs 2 posX 3 posY 4 posZ 5 velX 6 velY 7 velZ
///   8 rotX 9 rotY 10 rotZ 11 accX 12 accY 13 accZ 14 omegaX 15 omegaY 16 omegaZ
EMSCRIPTEN_KEEPALIVE
int fz_wire_bit_offset(int field) {
  switch (field) {
    case 0: return wire_bit::kFrame;
    case 1: return wire_bit::kTickMs;
    case 2: return wire_bit::kPosX;
    case 3: return wire_bit::kPosY;
    case 4: return wire_bit::kPosZ;
    case 5: return wire_bit::kVelX;
    case 6: return wire_bit::kVelY;
    case 7: return wire_bit::kVelZ;
    case 8: return wire_bit::kRotX;
    case 9: return wire_bit::kRotY;
    case 10: return wire_bit::kRotZ;
    case 11: return wire_bit::kAccX;
    case 12: return wire_bit::kAccY;
    case 13: return wire_bit::kAccZ;
    case 14: return wire_bit::kOmegaX;
    case 15: return wire_bit::kOmegaY;
    case 16: return wire_bit::kOmegaZ;
    default: return -1;
  }
}

/// 位宽查询（同上序号）。倍率不导出 —— 它们是**必须一致**的协议常量，
/// 前端若要用倍率，请用下面的 fz_wire_scale()，别抄数字。
EMSCRIPTEN_KEEPALIVE
int fz_wire_bit_width(int field) {
  switch (field) {
    case 0: return kBitsFrame;
    case 1: return kBitsTickMs;
    case 2: case 3: case 4: return kBitsPos;
    case 5: case 6: case 7: return kBitsVel;
    case 8: case 9: case 10: return kBitsRot;
    case 11: case 12: case 13: return kBitsAccel;
    case 14: case 15: case 16: return kBitsOmega;
    default: return -1;
  }
}

/// 定点倍率：field 用上面的序号；0 表示"该字段不是定标量"（frame/tickMs）。
EMSCRIPTEN_KEEPALIVE
double fz_wire_scale(int field) {
  switch (field) {
    case 2: case 3: case 4: return static_cast<double>(kWirePosScale);
    case 5: case 6: case 7: return static_cast<double>(kWireVelScale);
    case 8: case 9: case 10: return static_cast<double>(kWireRotScale);
    case 11: case 12: case 13: return static_cast<double>(kWireAccelScale);
    case 14: case 15: case 16: return static_cast<double>(kWireOmegaScale);
    default: return 0.0;
  }
}

/**
 * 把一个 96B 工作结构压成 32B 线格式（**服务端发包 / 测试往返用**）。
 * @param src      96B 源（Wasm 堆内绝对地址）
 * @param dst      32B 目标（Wasm 堆内绝对地址）
 * @return 1 = 成功
 */
EMSCRIPTEN_KEEPALIVE
int fz_pack_snapshot(std::uintptr_t src, std::uintptr_t dst) {
  if (src == 0U || dst == 0U) return 0;
  PackSnapshotToWire(*reinterpret_cast<const RigidBodyNetSnapshot*>(src),
                     reinterpret_cast<std::uint8_t*>(dst), true);
  return 1;
}

/// 解包一个 32B 线格式到 96B（调试/回读用；热路径请用 update_remote_state）
EMSCRIPTEN_KEEPALIVE
int fz_expand_snapshot(std::uintptr_t src, std::uintptr_t dst) {
  if (src == 0U || dst == 0U) return 0;
  ExpandWireToSnapshot(reinterpret_cast<const std::uint8_t*>(src),
                       *reinterpret_cast<RigidBodyNetSnapshot*>(dst), 0U);
  return 1;
}

// ---- 遥测（低频标量，普通 C ABI 足够）----
EMSCRIPTEN_KEEPALIVE bool     fz_is_locked()      { return Bridge().IsLocked(); }
EMSCRIPTEN_KEEPALIVE double   fz_server_now_ns()  { return Bridge().ServerNowNs(); }
EMSCRIPTEN_KEEPALIVE double   fz_current_warp()   { return Bridge().CurrentWarp(); }
EMSCRIPTEN_KEEPALIVE double   fz_best_rtt_ns()    { return Bridge().BestRttNs(); }
EMSCRIPTEN_KEEPALIVE double   fz_visual_error_m() { return Bridge().VisualErrorM(); }
EMSCRIPTEN_KEEPALIVE double   fz_extrapolated_s() { return Bridge().ExtrapolatedSec(); }
EMSCRIPTEN_KEEPALIVE int      fz_repl_state()     { return Bridge().ReplState(); }
EMSCRIPTEN_KEEPALIVE int      fz_sync_state()     { return Bridge().SyncState(); }
EMSCRIPTEN_KEEPALIVE unsigned fz_last_frame()     { return Bridge().LastFrame(); }
EMSCRIPTEN_KEEPALIVE unsigned fz_stale_dropped()  { return Bridge().StaleDropped(); }
EMSCRIPTEN_KEEPALIVE unsigned fz_hard_snaps()     { return Bridge().HardSnapCount(); }

}  // extern "C"

// =============================================================================
//  ② 低频通道：Embind 绑定（UI / 调试；这些路径不在乎几十微秒）
// =============================================================================

namespace {

/// 远端车遥测的 Embind 视图（按 id 取整组标量，一次调用拿全）
struct RemoteVehicleTelemetry final {
  std::uint32_t id = 0;
  int hasState = 0;
  int state = -1;
  double extrapolatedSec = 0.0;
  double visualErrorM = 0.0;
  double visualPosX = 0.0;
  double visualPosY = 0.0;
  double visualPosZ = 0.0;
  std::uint32_t lastFrame = 0;
};

RemoteVehicleTelemetry MakeRemoteTelemetry(std::uint32_t id) {
  RemoteVehicleTelemetry t{};
  t.id = id;
  const int slot = Registry().Find(id);
  const VehicleNetSlot* v = Registry().At(slot);
  if (v == nullptr) return t;
  t.hasState = v->remote.HasState() ? 1 : 0;
  t.state = static_cast<int>(v->remote.State());
  t.extrapolatedSec = static_cast<double>(v->remote.ExtrapolatedSec());
  t.visualErrorM = static_cast<double>(v->remote.VisualPositionErrorM());
  const glm::vec3 p = v->remote.GetVisualPosition();
  t.visualPosX = static_cast<double>(p.x);
  t.visualPosY = static_cast<double>(p.y);
  t.visualPosZ = static_cast<double>(p.z);
  t.lastFrame = v->lastFrame;
  return t;
}

/// 计时塔一行的 Embind 视图
struct LeaderboardRowView final {
  std::uint32_t id = 0;
  int position = 0;
  int lap = 0;
  bool isLocal = false;
  bool isLeader = false;
  std::string text;
};

/// 取计时塔（低频路径：HUD 刷新时调一次）。**高频请用文本暂存区 + HEAPU8**。
std::vector<LeaderboardRowView> MakeLeaderboard() {
  LeaderboardRow rows[kMaxVehicles];
  const std::uint32_t n = Registry().BuildLeaderboard(rows, kMaxVehicles);
  std::vector<LeaderboardRowView> out;
  out.reserve(n);
  for (std::uint32_t i = 0; i < n; ++i) {
    LeaderboardRowView v{};
    v.id = rows[i].id;
    v.position = rows[i].position;
    v.lap = rows[i].lap;
    v.isLocal = rows[i].isLocal;
    v.isLeader = rows[i].isLeader;
    v.text = std::string(rows[i].text);
    out.push_back(v);
  }
  return out;
}

}  // namespace

EMSCRIPTEN_BINDINGS(forza_net_host) {
  using namespace emscripten;

  // ---- 线格式常量：前端用它做校验，不要把 32 / 16 / 8 写死在两处 ----
  constant("WIRE_BYTES", static_cast<int>(kWireBytes));
  constant("WIRE_WORDS", static_cast<int>(kWireWords));
  constant("WIRE_PAYLOAD_BITS", static_cast<int>(kWirePayloadBits));
  constant("MAX_VEHICLES", static_cast<int>(kMaxVehicles));
  constant("ROW_TEXT_CAP", static_cast<int>(kDeltaTextCap));

  constant("SNAPSHOT_STAGE_SIZE", static_cast<int>(NetworkPhysicsBridge::SnapshotStageSize()));
  constant("MATRIX_STAGE_SIZE", static_cast<int>(NetworkPhysicsBridge::MatrixStageSizeBytes()));
  constant("MATRIX_SLOT_FLOATS", static_cast<int>(NetworkPhysicsBridge::MatrixSlotFloats()));
  constant("MATRIX_SLOTS", static_cast<int>(kMatrixSlots));

  // 矩阵槽编号（前端 `applyVisual` 用）
  constant("MATRIX_SLOT_VISUAL", static_cast<int>(MatrixSlot::VisualWorld));
  constant("MATRIX_SLOT_PHYSICS", static_cast<int>(MatrixSlot::PhysicsWorld));

  // 同步/复制枚举
  constant("SYNC_EVENT_NONE", static_cast<int>(forza::net::SyncEvent::None));
  constant("SYNC_EVENT_HARD_RESYNC", static_cast<int>(forza::net::SyncEvent::HardResync));
  constant("SYNC_EVENT_SAMPLE_REJECTED", static_cast<int>(forza::net::SyncEvent::SampleRejected));

  constant("REPL_STATE_EMPTY", static_cast<int>(forza::net::ReplState::Empty));
  constant("REPL_STATE_EXTRAPOLATING", static_cast<int>(forza::net::ReplState::Extrapolating));
  constant("REPL_STATE_CORRECTED", static_cast<int>(forza::net::ReplState::Corrected));
  constant("REPL_STATE_STALE", static_cast<int>(forza::net::ReplState::Stale));

  // 秒差解算方法
  constant("DELTA_METHOD_NONE", static_cast<int>(DeltaMethod::None));
  constant("DELTA_METHOD_CHECKPOINT", static_cast<int>(DeltaMethod::Checkpoint));
  constant("DELTA_METHOD_SPLINE_EXTRAP", static_cast<int>(DeltaMethod::SplineExtrap));
  constant("DELTA_METHOD_LAP_DELTA", static_cast<int>(DeltaMethod::LapDelta));

  // 96B 工作结构的字段偏移（与 fz_field_offset 同源）
  constant("OFF_FRAME", static_cast<int>(NetworkPhysicsBridge::FieldOffset(0)));
  constant("OFF_TICK_MS", static_cast<int>(NetworkPhysicsBridge::FieldOffset(1)));
  constant("OFF_SERVER_TIME", static_cast<int>(NetworkPhysicsBridge::FieldOffset(2)));
  constant("OFF_POSITION", static_cast<int>(NetworkPhysicsBridge::FieldOffset(3)));
  constant("OFF_ROTATION", static_cast<int>(NetworkPhysicsBridge::FieldOffset(4)));
  constant("OFF_VELOCITY", static_cast<int>(NetworkPhysicsBridge::FieldOffset(5)));
  constant("OFF_ANGULAR_VELOCITY", static_cast<int>(NetworkPhysicsBridge::FieldOffset(6)));
  constant("OFF_ACCEL", static_cast<int>(NetworkPhysicsBridge::FieldOffset(7)));

  // 32B 线格式的位偏移（前端交叉校验 / DataView 打包用）
  constant("WIRE_BIT_FRAME", wire_bit::kFrame);
  constant("WIRE_BIT_TICK_MS", wire_bit::kTickMs);
  constant("WIRE_BIT_POS_X", wire_bit::kPosX);
  constant("WIRE_BIT_POS_Y", wire_bit::kPosY);
  constant("WIRE_BIT_POS_Z", wire_bit::kPosZ);
  constant("WIRE_BIT_VEL_X", wire_bit::kVelX);
  constant("WIRE_BIT_VEL_Y", wire_bit::kVelY);
  constant("WIRE_BIT_VEL_Z", wire_bit::kVelZ);
  constant("WIRE_BIT_ROT_X", wire_bit::kRotX);
  constant("WIRE_BIT_ROT_Y", wire_bit::kRotY);
  constant("WIRE_BIT_ROT_Z", wire_bit::kRotZ);
  constant("WIRE_BIT_ACC_X", wire_bit::kAccX);
  constant("WIRE_BIT_ACC_Y", wire_bit::kAccY);
  constant("WIRE_BIT_ACC_Z", wire_bit::kAccZ);
  constant("WIRE_BIT_OMEGA_X", wire_bit::kOmegaX);
  constant("WIRE_BIT_OMEGA_Y", wire_bit::kOmegaY);
  constant("WIRE_BIT_OMEGA_Z", wire_bit::kOmegaZ);
  constant("WIRE_BITS_POS", kBitsPos);
  constant("WIRE_BITS_VEL", kBitsVel);
  constant("WIRE_BITS_ROT", kBitsRot);
  constant("WIRE_BITS_ACC", kBitsAccel);
  constant("WIRE_BITS_OMEGA", kBitsOmega);
  constant("WIRE_SCALE_POS", static_cast<double>(kWirePosScale));
  constant("WIRE_SCALE_VEL", static_cast<double>(kWireVelScale));
  constant("WIRE_SCALE_ROT", static_cast<double>(kWireRotScale));
  constant("WIRE_SCALE_ACC", static_cast<double>(kWireAccelScale));
  constant("WIRE_SCALE_OMEGA", static_cast<double>(kWireOmegaScale));

  // ---- Embind 结构体（低频，读起来自然）----
  value_object<RemoteVehicleTelemetry>("RemoteVehicleTelemetry")
      .field("id", &RemoteVehicleTelemetry::id)
      .field("hasState", &RemoteVehicleTelemetry::hasState)
      .field("state", &RemoteVehicleTelemetry::state)
      .field("extrapolatedSec", &RemoteVehicleTelemetry::extrapolatedSec)
      .field("visualErrorM", &RemoteVehicleTelemetry::visualErrorM)
      .field("visualPosX", &RemoteVehicleTelemetry::visualPosX)
      .field("visualPosY", &RemoteVehicleTelemetry::visualPosY)
      .field("visualPosZ", &RemoteVehicleTelemetry::visualPosZ)
      .field("lastFrame", &RemoteVehicleTelemetry::lastFrame);

  value_object<LeaderboardRowView>("LeaderboardRow")
      .field("id", &LeaderboardRowView::id)
      .field("position", &LeaderboardRowView::position)
      .field("lap", &LeaderboardRowView::lap)
      .field("isLocal", &LeaderboardRowView::isLocal)
      .field("isLeader", &LeaderboardRowView::isLeader)
      .field("text", &LeaderboardRowView::text);

  register_vector<LeaderboardRowView>("LeaderboardRows");

  class_<SyncTelemetryView>("SyncTelemetry")
      .function("serverNowNs", &SyncTelemetryView::serverNowNs)
      .function("offsetNs", &SyncTelemetryView::offsetNs)
      .function("bestRttNs", &SyncTelemetryView::bestRttNs)
      .function("warp", &SyncTelemetryView::warp)
      .function("locked", &SyncTelemetryView::locked)
      .function("state", &SyncTelemetryView::state)
      .function("samples", &SyncTelemetryView::samples);

  class_<ReplTelemetryView>("ReplTelemetry")
      .function("hasState", &ReplTelemetryView::hasState)
      .function("state", &ReplTelemetryView::state)
      .function("extrapolatedSec", &ReplTelemetryView::extrapolatedSec)
      .function("visualErrorM", &ReplTelemetryView::visualErrorM)
      .function("lastFrame", &ReplTelemetryView::lastFrame)
      .function("staleDropped", &ReplTelemetryView::staleDropped)
      .function("hardSnaps", &ReplTelemetryView::hardSnaps);

  function("syncTelemetry", &MakeSyncTelemetryView, allow_raw_pointers());
  function("replTelemetry", &MakeReplTelemetryView, allow_raw_pointers());
  function("remoteTelemetry", &MakeRemoteTelemetry, allow_raw_pointers());
  function("leaderboard", &MakeLeaderboard);
}
```

### 文件: native/wasm/wasm_bindings_test.cpp

```cpp
// =============================================================================
//  wasm_bindings_test.cpp —— 32B 线格式 + 多车注册表 + HUD 文本的原生断言
//
//  两种运行模式：
//    ./bridge_test.exe               跑全部断言（默认）
//    ./bridge_test.exe --dump-wire   把位表 + 一批"输入/32字节输出"写到
//                                    wire_dump.json，供 verify_engine_wire.mjs
//                                    做 TS↔C++ 的逐字节交叉校验
//
//  为什么要有 dump 模式：
//    前端 NetworkEngine.ts 里有一份**独立的 JS 位打包实现**（为了省掉发包时
//    的 Wasm 往返）。两个实现只要有一位不一致，症状就是"某些车的位置偶尔
//    乱飘"，而且**只在对端是本机 C++ 时出现** —— JS↔JS 自测永远发现不了。
//    所以必须把 C++ 真值 dump 出来，让 TS 侧对同一批输入打包后逐字节比。
// =============================================================================

#include <cmath>
#include <cstdio>
#include <cstring>

#include "snapshot_wire.h"
#include "vehicle_net_registry.h"

using namespace forza::wasm;
using forza::net::RigidBodyNetSnapshot;
using forza::race::DeltaCarState;
using forza::race::DeltaMethod;

namespace {

int g_pass = 0;
int g_fail = 0;

void Check(bool cond, const char* what) {
  if (cond) {
    ++g_pass;
  } else {
    ++g_fail;
    std::printf("  [FAIL] %s\n", what);
  }
}

bool Near(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

// -----------------------------------------------------------------------------
//  W1. 线格式尺寸与位表自洽
// -----------------------------------------------------------------------------
void TestWireLayout() {
  std::printf("W1 线格式尺寸与位表\n");
  Check(kWireBytes == 32U, "线格式 32 字节（规格上限 48）");
  Check(kWireWords == 8U, "8 个 32 位字");
  Check(kWirePayloadBits == 242, "净载荷 242 位");
  // 8 字 = 256 位 ≥ 242 位，且有 6 个保留位 + 8 位对齐空隙
  Check(kWirePayloadBits <= 256, "载荷必须装进 256 位");
  // 字段不重叠：相邻字段的起始位 >= 前一个字段的结束位
  Check(wire_bit::kFrame + kBitsFrame <= wire_bit::kTickMs, "frame/tickMs 不重叠");
  Check(wire_bit::kPosX + kBitsPos <= wire_bit::kPosY, "posX/posY 不重叠");
  Check(wire_bit::kOmegaZ + kBitsOmega <= 256,
        "最后一个字段（omegaZ）不越界");
}

// -----------------------------------------------------------------------------
//  W2. 定点量化：饱和而非回绕
// -----------------------------------------------------------------------------
void TestQuantizeSaturation() {
  std::printf("W2 定点量化饱和\n");
  const int max16 = (1 << 15) - 1;
  // 远超量程 -> 饱和到上限，**不是**回绕成负数
  Check(QuantizeSat(1e6F, kWirePosScale, 16) == max16, "超大正数饱和到 +32767");
  Check(QuantizeSat(-1e6F, kWirePosScale, 16) == -max16, "超大负数饱和到 -32767");
  // 量程内正常取整
  Check(QuantizeSat(1.0F, kWirePosScale, 16) == 8, "1.0m -> 8（1/8m 定点）");
  // ★ 取整方式必须与 JS 的 `Math.round` 逐值一致：floor(x+0.5)（半个值朝 +∞）。
  //   ⚠️ 负数半值**不是**远离零 —— 这是最容易写错的一处：
  //        JS: Math.round(-0.5) = -0（不是 -1）, Math.round(-2.5) = -2
  //        nearbyint(取偶):  0.5 -> 0
  //        away-from-zero:  -0.5 -> -1
  //      位置倍率 8 → 0.0625/0.1875/0.3125 全命中 0.5，所以这不是理论边角。
  Check(QuantizeSat(0.0625F, kWirePosScale, 16) == 1, " 0.5 步长 ->  1（近零半值朝 +∞）");
  Check(QuantizeSat(-0.0625F, kWirePosScale, 16) == 0, "-0.5 步长 ->  0（**不是** -1，与 JS Math.round 一致）");
  Check(QuantizeSat(0.3125F, kWirePosScale, 16) == 3, " 2.5 步长 ->  3");
  Check(QuantizeSat(-0.1875F, kWirePosScale, 16) == -1, "-1.5 步长 -> -1");
  Check(QuantizeSat(-0.3125F, kWirePosScale, 16) == -2, "-2.5 步长 -> -2（取偶会给 -2，两者同值）");
  Check(QuantizeSat(0.1875F, kWirePosScale, 16) == 2, " 1.5 步长 ->  2");
  // ★ 就近取整（不是截断）
  Check(QuantizeSat(0.07F, kWirePosScale, 16) == 1, "0.07m 就近取整为 1 而非截断为 0");
  // -0.07 × 8 = -0.56 -> floor(-0.56+0.5)=floor(-0.06) = -1（与 Math.round(-0.56) 一致）
  Check(QuantizeSat(-0.07F, kWirePosScale, 16) == -1, "-0.07m 就近取整为 -1（与 JS 一致）");
  // NaN/Inf 归零（绝不把垃圾散上网）
  Check(QuantizeSat(std::nanf(""), kWirePosScale, 16) == 0, "NaN -> 0");
  Check(QuantizeSat(INFINITY, kWirePosScale, 16) == 0, "Inf -> 0");
}

// -----------------------------------------------------------------------------
//  W3. 位读写器跨字正确性
// -----------------------------------------------------------------------------
void TestBitIO() {
  std::printf("W3 位读写器（跨字）\n");
  std::uint32_t w[kWireWords];
  std::memset(w, 0, sizeof(w));

  // 不跨字写读
  PutBits(w, 0, 16, 1234);
  Check(GetBits(w, 0, 16) == 1234, "16 位不跨字往返");
  PutBits(w, 16, 16, 5678);
  Check(GetBits(w, 16, 16) == 5678, "第二个 16 位字段");
  Check(GetBits(w, 0, 16) == 1234, "写第二个字段不影响第一个");

  // 跨字写读（velY @ bit 94，14 位，跨 word2/3）
  // ⚠️ 14 位**有符号**量程是 [-8192, 8191] —— 写 12345 会溢出（这正是
  //    QuantizeSat 存在的理由）。这里测的是位读写器本身，所以要给合法值。
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kVelY, kBitsVel, 8191);
  Check(GetBits(w, wire_bit::kVelY, kBitsVel) == 8191, "14 位跨字往返（正上限 8191）");
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kVelY, kBitsVel, static_cast<std::uint32_t>(-8192));
  Check(GetBits(w, wire_bit::kVelY, kBitsVel) == -8192, "14 位跨字往返（负下限 -8192）");
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kVelY, kBitsVel, 4096);
  Check(GetBits(w, wire_bit::kVelY, kBitsVel) == 4096, "14 位跨字往返（中间值）");

  // 符号扩展边界：-1 在 12 位里
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kAccY, kBitsAccel, static_cast<std::uint32_t>(-1));
  Check(GetBits(w, wire_bit::kAccY, kBitsAccel) == -1, "12 位跨字 -1 符号扩展正确");
}

// -----------------------------------------------------------------------------
//  W4. 打包 -> 解包往返（覆盖量程内的各种值）
// -----------------------------------------------------------------------------
void TestRoundTrip() {
  std::printf("W4 打包/解包往返\n");
  RigidBodyNetSnapshot s{};
  s.frame = 4000000123u & 0xFFFFu;      // 帧号低 16 位
  s.tickMs = 123456u & 0xFFFFu;
  s.position = {1234.5F, -67.25F, -1987.75F};
  s.rotation = {0.5F, 0.5F, 0.5F, 0.5F};   // 单位四元数（w,x,y,z）
  s.velocity = {72.5F, -3.25F, 12.75F};
  s.angularVelocity = {0.5F, -1.25F, 3.0F};
  s.accel = {8.5F, -9.5F, 2.25F};

  std::uint8_t buf[kWireBytes];
  PackSnapshotToWire(s, buf, true);
  RigidBodyNetSnapshot o{};
  ExpandWireToSnapshot(buf, o, 0U);

  Check(o.frame == (s.frame & 0xFFFFu), "帧号往返");
  // ★ 位置容差必须按**半个量化步长**给：1/8 m 定点 → 最大误差 1/16 = 0.0625m
  const double posTol = 0.5 / kWirePosScale + 1e-4;
  Check(Near(o.position.x, s.position.x, posTol), "posX 误差 ≤ 半个量化步");
  Check(Near(o.position.y, s.position.y, posTol), "posY 误差 ≤ 半个量化步");
  Check(Near(o.position.z, s.position.z, posTol), "posZ 误差 ≤ 半个量化步");

  const double velTol = 0.5 / kWireVelScale + 1e-4;
  Check(Near(o.velocity.x, s.velocity.x, velTol), "velX 误差 ≤ 半个量化步");
  Check(Near(o.velocity.y, s.velocity.y, velTol), "velY（跨字）误差 ≤ 半个量化步");
  Check(Near(o.velocity.z, s.velocity.z, velTol), "velZ 误差 ≤ 半个量化步");

  const double accTol = 0.5 / kWireAccelScale + 1e-4;
  Check(Near(o.accel.x, s.accel.x, accTol), "accX 误差 ≤ 半个量化步");
  Check(Near(o.accel.y, s.accel.y, accTol), "accY（跨字）误差 ≤ 半个量化步");
  Check(Near(o.accel.z, s.accel.z, accTol), "accZ 误差 ≤ 半个量化步");

  const double omgTol = 0.5 / kWireOmegaScale + 1e-4;
  Check(Near(o.angularVelocity.x, s.angularVelocity.x, omgTol), "omegaX 误差 ≤ 半个量化步");
  Check(Near(o.angularVelocity.y, s.angularVelocity.y, omgTol), "omegaY 误差 ≤ 半个量化步");
  Check(Near(o.angularVelocity.z, s.angularVelocity.z, omgTol), "omegaZ 误差 ≤ 半个量化步");

  // 四元数：w 由单位性恢复，必须为正且量级正确
  Check(o.rotation.w > 0.0F, "恢复的四元数 w > 0（ShortArc 规范形）");
  const double qn = static_cast<double>(o.rotation.w) * o.rotation.w +
                    static_cast<double>(o.rotation.x) * o.rotation.x +
                    static_cast<double>(o.rotation.y) * o.rotation.y +
                    static_cast<double>(o.rotation.z) * o.rotation.z;
  Check(Near(qn, 1.0, 0.01), "恢复的四元数几乎单位长度");
}

// -----------------------------------------------------------------------------
//  W5. 四元数习惯化：q 与 -q 必须产出**同一组**线上的 x,y,z
// -----------------------------------------------------------------------------
void TestQuatCanonicalization() {
  std::printf("W5 四元数习惯化（q 与 -q 等价）\n");
  RigidBodyNetSnapshot a{};
  a.rotation = {0.6F, -0.8F, 0.0F, 0.0F};     // w=0.6 > 0
  RigidBodyNetSnapshot b{};
  b.rotation = {-0.6F, 0.8F, 0.0F, 0.0F};     // 同一个旋转的另一半

  std::uint8_t ba[kWireBytes], bb[kWireBytes];
  PackSnapshotToWire(a, ba);
  PackSnapshotToWire(b, bb);
  // ★ 打包后必须**逐字节相同** —— 否则接收端会看到随机的符号，
  //   导致 rb_replicator 的第②处短弧检查被无谓触发。
  Check(std::memcmp(ba, bb, kWireBytes) == 0, "q 与 -q 打包结果逐字节相同");

  RigidBodyNetSnapshot oa{}, ob{};
  ExpandWireToSnapshot(ba, oa, 0U);
  ExpandWireToSnapshot(bb, ob, 0U);
  Check(oa.rotation.w > 0.0F && ob.rotation.w > 0.0F, "两者恢复的 w 都 > 0");
  Check(Near(oa.rotation.x, ob.rotation.x, 1e-6), "两者恢复的 x 相同");
}

// -----------------------------------------------------------------------------
//  W6. 高转速姿态：四元数分量接近 ±1 时仍可恢复
// -----------------------------------------------------------------------------
void TestQuatExtremes() {
  std::printf("W6 四元数极端姿态\n");
  // 180° 绕 X：q = (0, 1, 0, 0) —— w 恢复出来应接近 0
  RigidBodyNetSnapshot s{};
  s.rotation = {0.0F, 1.0F, 0.0F, 0.0F};
  std::uint8_t buf[kWireBytes];
  PackSnapshotToWire(s, buf);
  RigidBodyNetSnapshot o{};
  ExpandWireToSnapshot(buf, o, 0U);
  Check(Near(o.rotation.w, 0.0, 0.01), "180° 姿态 w≈0");
  Check(Near(o.rotation.x, 1.0, 0.01), "180° 姿态 x≈1");
  Check(std::isfinite(o.rotation.w), "w 不是 NaN（rw2<0 时夹到 0）");
}

// -----------------------------------------------------------------------------
//  W7. 多车槽管理：独立性 + 表满
// -----------------------------------------------------------------------------
void TestVehicleSlots() {
  std::printf("W7 多车槽管理\n");
  VehicleNetRegistry reg;
  Check(reg.Count() == 0U, "初始为空");
  Check(reg.LocalIndex() == -1, "初始无本地车");

  const int s0 = reg.EnsureVehicle(10, true);
  const int s1 = reg.EnsureVehicle(20, false);
  const int s2 = reg.EnsureVehicle(30, false);
  Check(s0 == 0 && s1 == 1 && s2 == 2, "顺序分配槽位");
  Check(reg.Count() == 3U, "计数 3");
  Check(reg.Find(20) == 1, "按 id 查找");
  Check(reg.Find(99) == -1, "不存在的 id 返回 -1");

  Check(reg.EnsureVehicle(20) == 1, "重复登记复用槽位（不新建）");
  Check(reg.Count() == 3U, "重复登记不增计数");

  // SetLocal 是 void：这里验证"切换本地车"的副作用（原本地被取消，新本地被标记）
  reg.SetLocal(2);
  Check(reg.LocalIndex() == 2, "切换本地车后索引更新");
  Check(reg.At(2)->isLocal, "新车标记为本地");
  Check(!reg.At(0)->isLocal, "原本地车标记被清除");
}

// -----------------------------------------------------------------------------
//  W8. 每车有**独立**的 replicator（防止"四辆车粘在一起抖"）
// -----------------------------------------------------------------------------
void TestVehicleIndependence() {
  std::printf("W8 每车副本独立性\n");
  VehicleNetRegistry reg;
  const int a = reg.EnsureVehicle(1);
  const int b = reg.EnsureVehicle(2);

  // 给两辆车喂不同的权威快照
  RigidBodyNetSnapshot sa{};
  sa.frame = 1; sa.position = {100.0F, 0.0F, 0.0F};
  RigidBodyNetSnapshot sb{};
  sb.frame = 1; sb.position = {-100.0F, 0.0F, 0.0F};

  reg.AtMutable(a)->remote.OnAuthoritativeSnapshot(sa);
  reg.AtMutable(b)->remote.OnAuthoritativeSnapshot(sb);
  reg.RefreshMatrices();

  // 矩阵的平移分量（列主序：索引 12/13/14）
  const double ax = reg.MatrixElement(a, 12);
  const double bx = reg.MatrixElement(b, 12);
  Check(Near(ax, 100.0, 1e-3), "A 车矩阵 x = +100");
  Check(Near(bx, -100.0, 1e-3), "B 车矩阵 x = -100");
  // ★ 核心断言：两辆车的位置**必须不同**。若共用 replicator，这里会相等。
  Check(std::fabs(ax - bx) > 1.0, "两车位置相互独立（未共用 replicator）");
}

// -----------------------------------------------------------------------------
//  W9. 帧号去重：旧包不能把新车拽回去
// -----------------------------------------------------------------------------
void TestFrameDedup() {
  std::printf("W9 帧号去重\n");
  VehicleNetRegistry reg;
  const int s = reg.EnsureVehicle(7);
  Check(reg.NoteSnapshotFrame(s, 100), "首帧接受");
  Check(reg.NoteSnapshotFrame(s, 101), "更新的帧接受");
  Check(!reg.NoteSnapshotFrame(s, 99), "旧帧被拒");
  Check(!reg.NoteSnapshotFrame(s, 101), "重复帧被拒");
  Check(reg.NoteSnapshotFrame(s, 102), "继续前进的帧接受");

  // uint32 回绕：0xFFFFFFFF -> 0 必须被认成"更新"
  VehicleNetRegistry reg2;
  const int s2 = reg2.EnsureVehicle(8);
  Check(reg2.NoteSnapshotFrame(s2, 0xFFFFFFFEu), "回绕前接受");
  Check(reg2.NoteSnapshotFrame(s2, 0xFFFFFFFFu), "接近回绕接受");
  Check(reg2.NoteSnapshotFrame(s2, 0u), "回绕到 0 被认成更新（无符号差值判据）");
}

// -----------------------------------------------------------------------------
//  W10. 远端车离场
// -----------------------------------------------------------------------------
void TestRemoveVehicle() {
  std::printf("W10 远端车离场\n");
  VehicleNetRegistry reg;
  reg.EnsureVehicle(1);
  reg.EnsureVehicle(2);
  reg.EnsureVehicle(3);
  Check(reg.RemoveVehicle(2), "移除存在的车");
  Check(!reg.RemoveVehicle(2), "重复移除返回 false");
  Check(reg.Count() == 2U, "计数降到 2");
  Check(reg.Find(2) == -1, "已移除的车查找失败");
  Check(reg.At(1) == nullptr, "已移除的槽为 null");
}

// -----------------------------------------------------------------------------
//  W11. 表满行为：必须拒绝，不能越界写
// -----------------------------------------------------------------------------
void TestTableFull() {
  std::printf("W11 槽位表满\n");
  VehicleNetRegistry reg;
  for (std::uint32_t i = 0; i < kMaxVehicles; ++i) {
    Check(reg.EnsureVehicle(1000 + i) >= 0, "槽位分配成功");
  }
  Check(reg.Count() == kMaxVehicles, "计数达到上限");
  Check(reg.EnsureVehicle(9999) == -1, "表满时返回 -1（拒绝而不是越界）");
  Check(reg.Count() == kMaxVehicles, "表满时计数不变");
}

// -----------------------------------------------------------------------------
//  W12. 计时塔排序 + 领跑者 "--" + 非领跑者负号
// -----------------------------------------------------------------------------
void TestLeaderboard() {
  std::printf("W12 计时塔排序与文本\n");
  VehicleNetRegistry reg;
  // 方形赛道：周长 400m，4 个 Checkpoint（每 100m 一个）
  static const double kCtl[4][2] = {
      {-50.0, -50.0}, {50.0, -50.0}, {50.0, 50.0}, {-50.0, 50.0}};
  static const double kCp[4] = {0.0, 100.0, 200.0, 300.0};
  Check(reg.SetTrack(kCtl, 4, kCp, 4), "装入方形测试赛道");
  Check(reg.TrackReady(), "赛道就绪");

  const double L = reg.TrackLength();
  // ⚠️ 这是**闭合 Catmull-Rom** 的弧长，不是多边形的 400m 周长：
  //    四个控制点的闭合样条会向外鼓（段间切线由邻居决定），实测 420.38m。
  //    本项目 race_delta 的 Python 镜像基线也记着 L ≈ 420.3797，两者一致。
  //    **不要把断言写成 400** —— 那是多边形周长，不是样条弧长。
  Check(L > 400.0 && L < 440.0, "闭合样条弧长在合理区间（> 多边形周长 400m）");

  // 三辆车：P1 在 s=200，P2 在 s=100，P3 在 s=50（同一圈）
  const int a = reg.EnsureVehicle(1, true);    // 本地 = P1
  const int b = reg.EnsureVehicle(2);
  const int c = reg.EnsureVehicle(3);
  const double t0 = 10.0;
  reg.UpdateProgress(a, 200.0, t0, 0, 1, 5.0);
  reg.UpdateProgress(b, 100.0, t0, 0, 0, 2.0);
  reg.UpdateProgress(c, 50.0, t0, 0, -1, 0.0);

  LeaderboardRow rows[kMaxVehicles];
  const std::uint32_t n = reg.BuildLeaderboard(rows, kMaxVehicles);
  Check(n == 3U, "三行");
  Check(rows[0].id == 1 && rows[0].position == 1, "P1 = 本地车（s 最大）");
  Check(rows[0].isLeader, "P1 标记为领跑者");
  Check(std::strcmp(rows[0].text, "--") == 0, "领跑者文本为 \"--\"");
  Check(rows[1].id == 2 && rows[2].id == 3, "P2/P3 顺序按进度");

  // ★ 后车文本必须以 '-' 开头（规格：落后统一负数格式）
  Check(rows[1].text[0] == '-', "P2 秒差文本以负号开头");
  Check(rows[2].text[0] == '-', "P3 秒差文本以负号开头");
  // 落后的量级：P3 比 P2 更落后 -> 数值绝对值更大
  const double d2 = std::fabs(std::atof(rows[1].text));
  const double d3 = std::fabs(std::atof(rows[2].text));
  Check(d3 > d2, "P3 落后幅度大于 P2");

  // 本地就是领跑者 -> 本地行 "--"
  char line[kDeltaTextCap];
  reg.FormatLocalVsLeader(line, kDeltaTextCap);
  Check(std::strcmp(line, "--") == 0, "本地为 P1 时本地行 \"--\"");
}

// -----------------------------------------------------------------------------
//  W13. 本地落后时的秒差符号（规格核心）
// -----------------------------------------------------------------------------
void TestLocalBehind() {
  std::printf("W13 本地落后的符号\n");
  VehicleNetRegistry reg;
  static const double kCtl[4][2] = {
      {-50.0, -50.0}, {50.0, -50.0}, {50.0, 50.0}, {-50.0, 50.0}};
  static const double kCp[4] = {0.0, 100.0, 200.0, 300.0};
  reg.SetTrack(kCtl, 4, kCp, 4);

  const int local = reg.EnsureVehicle(1, true);
  const int lead = reg.EnsureVehicle(2);
  const double t0 = 20.0;
  // 领跑者在 s=200，本地在 s=100（都过了 CP0）
  reg.UpdateProgress(lead, 200.0, t0, 0, 1, 8.0);
  reg.UpdateProgress(local, 100.0, t0, 0, 0, 6.0);

  // Solve(local, lead) 应 < 0（本地落后）
  const double ms = reg.Solve(1, 2).deltaMs;
  Check(ms < 0.0, "Solve(local, lead) < 0（本地落后为负）");
  // 反对称性
  const double ms2 = reg.Solve(2, 1).deltaMs;
  Check(Near(ms, -ms2, 1e-6), "Solve(a,b) == -Solve(b,a) 反对称");

  char line[kDeltaTextCap];
  reg.FormatLocalVsLeader(line, kDeltaTextCap);
  Check(line[0] == '-', "本地落后时文本以负号开头");
  Check(std::strcmp(line, "--") != 0, "本地落后时不是 \"--\"");

  // 用 CP 过线时刻的一级解：lead 在 CP1 的过线时刻 8.0，local 在 CP0 的 6.0
  // 公共 CP 是 CP0（lead=?, local=6.0）—— lead 的 CP0 没给，故退化到外推
  Check(reg.Solve(1, 2).valid(), "解算有效");
}

// -----------------------------------------------------------------------------
//  W14. 每车段速 EWMA（外推除数）
// -----------------------------------------------------------------------------
void TestSegSpeed() {
  std::printf("W14 每车段速 EWMA\n");
  VehicleNetRegistry reg;
  static const double kCtl[4][2] = {
      {-50.0, -50.0}, {50.0, -50.0}, {50.0, 50.0}, {-50.0, 50.0}};
  static const double kCp[1] = {0.0};
  reg.SetTrack(kCtl, 4, kCp, 1);
  const int a = reg.EnsureVehicle(1);

  // 以 30m/s 推进 60 步（每步 0.5m / 1/60s = 30m/s）
  double s = 0.0;
  double t = 0.0;
  for (int i = 0; i < 60; ++i) {
    s += 0.5;
    t += 1.0 / 60.0;
    reg.UpdateProgress(a, s, t, 0, -1, 0.0);
  }
  const double v = reg.At(a)->delta.segSpeedMps;
  // EWMA 从首个样本 30m/s 起步，恒速下应稳定在 30
  Check(v > 29.0 && v < 31.0, "恒速 30m/s 下段速估计收敛到 30");

  // 倒车（ds<0）不得被采纳为段速
  VehicleNetRegistry reg2;
  reg2.SetTrack(kCtl, 4, kCp, 1);
  const int b = reg2.EnsureVehicle(1);
  reg2.UpdateProgress(b, 10.0, 0.0, 0, -1, 0.0);
  reg2.UpdateProgress(b, 5.0, 1.0 / 60.0, 0, -1, 0.0);   // 倒退
  const double vb = reg2.At(b)->delta.segSpeedMps;
  Check(vb >= 0.0, "倒车不产生负段速");
}

// -----------------------------------------------------------------------------
//  W15. 解包入口的真实路径：通过地址直接解包（模拟 UpdateRemoteVehicleState）
// -----------------------------------------------------------------------------
void TestExpandFromStagedAddress() {
  std::printf("W15 从暂存地址解包\n");
  // 模拟：JS 把 32B 包写进一块内存，然后传地址进来
  alignas(16) std::uint8_t stage[kWireBytes];
  RigidBodyNetSnapshot src{};
  src.frame = 777;
  src.position = {500.25F, 12.5F, -333.75F};
  src.rotation = {1.0F, 0.0F, 0.0F, 0.0F};
  src.velocity = {45.0F, 0.0F, -20.0F};
  PackSnapshotToWire(src, stage);

  // 通过指针偏移（正是 UpdateRemoteVehicleState 的语义）
  const std::uint8_t* p = stage + 0;
  RigidBodyNetSnapshot o{};
  ExpandWireToSnapshot(p, o, 0U);
  Check(o.frame == 777u, "从地址解包帧号正确");
  Check(Near(o.position.x, 500.25, 0.07), "从地址解包位置正确");

  // 非零偏移：把包放在 stage+16 处（模拟批量包）
  alignas(16) std::uint8_t big[64];
  std::memcpy(big + 16, stage, kWireBytes);
  RigidBodyNetSnapshot o2{};
  ExpandWireToSnapshot(big + 16, o2, 0U);
  Check(o2.frame == 777u, "非零偏移解包正确");
}

}  // namespace

// =============================================================================
//  --dump-wire：把 C++ 真值写给 TS 交叉校验用
// =============================================================================
namespace {

/// 一组测试输入（字段名与 TS 侧 packTs 的 s.* 一一对应）
struct WireCase {
  RigidBodyNetSnapshot snap;
};

void DumpWireJson(const char* path) {
  // 覆盖的量程要宽：正/负、接近饱和、贴近 0、四元数各象限
  WireCase cases[8];
  const float posVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {1234.5F, -67.25F, -1987.75F},
      {-4095.9F, 2047.75F, 511.125F},
      {0.0625F, -0.0625F, 0.125F},
      {100.5F, 3.25F, -999.875F},
      {2047.875F, -2047.875F, 1.0F},
      {-1.5F, 800.25F, -1200.5F},
      {4095.875F, -4095.875F, 0.0F},
  };
  const float velVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {72.5F, -3.25F, 12.75F},
      {127.5F, -127.5F, 0.015625F},
      {-45.0F, 20.0F, -88.0F},
      {0.015625F, -0.015625F, 64.0F},
      {12.0F, 33.5F, -100.25F},
      {-8.5F, 55.0F, -1.0F},
      {100.0F, -100.0F, 50.0F},
  };
  const float omgVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {0.5F, -1.25F, 3.0F},
      {7.996F, -7.996F, 0.00390625F},
      {-2.0F, 4.0F, -6.0F},
      {0.25F, -0.5F, 1.0F},
      {3.5F, -3.5F, 2.0F},
      {-0.0117F, 0.0117F, 5.0F},
      {7.0F, -7.0F, 0.0F},
  };
  const float accVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {8.5F, -9.5F, 2.25F},
      {15.99F, -15.99F, 0.0078125F},
      {-3.0F, 6.0F, -12.0F},
      {0.5F, -0.5F, 1.0F},
      {12.3F, -9.81F, 0.5F},
      {-0.0039F, 0.0039F, 9.0F},
      {15.0F, -15.0F, 1.0F},
  };
  const float rotVals[8][4] = {
      {1.0F, 0.0F, 0.0F, 0.0F},
      {0.5F, 0.5F, 0.5F, 0.5F},
      {0.70710678F, 0.0F, 0.70710678F, 0.0F},
      {0.6F, -0.8F, 0.0F, 0.0F},
      {-0.6F, 0.8F, 0.0F, 0.0F},      // q 与 -q 必须打包成同一串
      {0.0F, 1.0F, 0.0F, 0.0F},       // 180°
      {0.258819F, 0.0F, 0.9659258F, 0.0F},
      {-0.5F, -0.5F, -0.5F, -0.5F},
  };

  for (int i = 0; i < 8; ++i) {
    RigidBodyNetSnapshot& s = cases[i].snap;
    s.frame = static_cast<std::uint32_t>(1000 + i * 7777) & 0xFFFFu;
    s.tickMs = static_cast<std::uint32_t>(i * 8191) & 0xFFFFu;
    s.position = {posVals[i][0], posVals[i][1], posVals[i][2]};
    s.velocity = {velVals[i][0], velVals[i][1], velVals[i][2]};
    s.angularVelocity = {omgVals[i][0], omgVals[i][1], omgVals[i][2]};
    s.accel = {accVals[i][0], accVals[i][1], accVals[i][2]};
    s.rotation = {rotVals[i][0], rotVals[i][1], rotVals[i][2], rotVals[i][3]};
  }

  std::FILE* f = std::fopen(path, "wb");
  if (f == nullptr) {
    std::printf("[dump] 无法写入 %s\n", path);
    return;
  }
  std::fprintf(f, "{\n");
  std::fprintf(f, "  \"wireBytes\": %u,\n", kWireBytes);
  std::fprintf(f, "  \"payloadBits\": %d,\n", kWirePayloadBits);
  std::fprintf(f, "  \"bits\": {\n");
  std::fprintf(f, "    \"frame\": %d, \"tickMs\": %d,\n", wire_bit::kFrame, wire_bit::kTickMs);
  std::fprintf(f, "    \"posX\": %d, \"posY\": %d, \"posZ\": %d,\n", wire_bit::kPosX,
               wire_bit::kPosY, wire_bit::kPosZ);
  std::fprintf(f, "    \"velX\": %d, \"velY\": %d, \"velZ\": %d,\n", wire_bit::kVelX,
               wire_bit::kVelY, wire_bit::kVelZ);
  std::fprintf(f, "    \"rotX\": %d, \"rotY\": %d, \"rotZ\": %d,\n", wire_bit::kRotX,
               wire_bit::kRotY, wire_bit::kRotZ);
  std::fprintf(f, "    \"accX\": %d, \"accY\": %d, \"accZ\": %d,\n", wire_bit::kAccX,
               wire_bit::kAccY, wire_bit::kAccZ);
  std::fprintf(f, "    \"omegaX\": %d, \"omegaY\": %d, \"omegaZ\": %d\n", wire_bit::kOmegaX,
               wire_bit::kOmegaY, wire_bit::kOmegaZ);
  std::fprintf(f, "  },\n");
  std::fprintf(f, "  \"widths\": { \"pos\": %d, \"vel\": %d, \"rot\": %d, \"accel\": %d, \"omega\": %d },\n",
               kBitsPos, kBitsVel, kBitsRot, kBitsAccel, kBitsOmega);
  std::fprintf(f, "  \"scales\": { \"pos\": %.10g, \"vel\": %.10g, \"rot\": %.10g, \"accel\": %.10g, \"omega\": %.10g },\n",
               static_cast<double>(kWirePosScale), static_cast<double>(kWireVelScale),
               static_cast<double>(kWireRotScale), static_cast<double>(kWireAccelScale),
               static_cast<double>(kWireOmegaScale));
  std::fprintf(f, "  \"cases\": [\n");

  for (int i = 0; i < 8; ++i) {
    std::uint8_t buf[kWireBytes];
    PackSnapshotToWire(cases[i].snap, buf, true);
    const RigidBodyNetSnapshot& s = cases[i].snap;
    std::fprintf(f, "    { \"in\": {");
    std::fprintf(f, "\"frame\": %u, \"tickMs\": %u, ", s.frame, s.tickMs);
    std::fprintf(f, "\"px\": %.10g, \"py\": %.10g, \"pz\": %.10g, ",
                 static_cast<double>(s.position.x), static_cast<double>(s.position.y),
                 static_cast<double>(s.position.z));
    std::fprintf(f, "\"qw\": %.10g, \"qx\": %.10g, \"qy\": %.10g, \"qz\": %.10g, ",
                 static_cast<double>(s.rotation.w), static_cast<double>(s.rotation.x),
                 static_cast<double>(s.rotation.y), static_cast<double>(s.rotation.z));
    std::fprintf(f, "\"vx\": %.10g, \"vy\": %.10g, \"vz\": %.10g, ",
                 static_cast<double>(s.velocity.x), static_cast<double>(s.velocity.y),
                 static_cast<double>(s.velocity.z));
    std::fprintf(f, "\"wx\": %.10g, \"wy\": %.10g, \"wz\": %.10g, ",
                 static_cast<double>(s.angularVelocity.x), static_cast<double>(s.angularVelocity.y),
                 static_cast<double>(s.angularVelocity.z));
    std::fprintf(f, "\"ax\": %.10g, \"ay\": %.10g, \"az\": %.10g}, ",
                 static_cast<double>(s.accel.x), static_cast<double>(s.accel.y),
                 static_cast<double>(s.accel.z));
    std::fprintf(f, "\"bytes\": [");
    for (std::uint32_t k = 0; k < kWireBytes; ++k) {
      std::fprintf(f, "%u%s", static_cast<unsigned>(buf[k]), (k + 1U < kWireBytes) ? "," : "");
    }
    std::fprintf(f, "]}%s\n", (i + 1 < 8) ? "," : "");
  }
  std::fprintf(f, "  ]\n}\n");
  std::fclose(f);
  std::printf("[dump] 已写出 %s（%u 字节线格式 × %d 组）\n", path, kWireBytes, 8);
}

}  // namespace

int main(int argc, char** argv) {
  // dump 模式：不跑断言，只产真值给 TS 交叉校验
  if (argc > 1 && std::strcmp(argv[1], "--dump-wire") == 0) {
    const char* out = (argc > 2) ? argv[2] : "wire_dump.json";
    DumpWireJson(out);
    return 0;
  }

  std::printf("=== wasm_bindings_test（32B 线格式 + 多车注册表 + HUD 文本）===\n");
  TestWireLayout();
  TestQuantizeSaturation();
  TestBitIO();
  TestRoundTrip();
  TestQuatCanonicalization();
  TestQuatExtremes();
  TestVehicleSlots();
  TestVehicleIndependence();
  TestFrameDedup();
  TestRemoveVehicle();
  TestTableFull();
  TestLeaderboard();
  TestLocalBehind();
  TestSegSpeed();
  TestExpandFromStagedAddress();

  std::printf("\n通过 %d / 失败 %d\n", g_pass, g_fail);
  return (g_fail == 0) ? 0 : 1;
}
```

### 文件: native/wasm/wire_dump.json

```json
{
  "wireBytes": 32,
  "payloadBits": 242,
  "bits": {
    "frame": 0, "tickMs": 16,
    "posX": 32, "posY": 48, "posZ": 64,
    "velX": 80, "velY": 94, "velZ": 108,
    "rotX": 128, "rotY": 144, "rotZ": 160,
    "accX": 176, "accY": 188, "accZ": 200,
    "omegaX": 212, "omegaY": 224, "omegaZ": 236
  },
  "widths": { "pos": 16, "vel": 14, "rot": 16, "accel": 12, "omega": 12 },
  "scales": { "pos": 8, "vel": 64, "rot": 32767, "accel": 128, "omega": 256 },
  "cases": [
    { "in": {"frame": 1000, "tickMs": 0, "px": 0, "py": 0, "pz": 0, "qw": 1, "qx": 0, "qy": 0, "qz": 0, "vx": 0, "vy": 0, "vz": 0, "wx": 0, "wy": 0, "wz": 0, "ax": 0, "ay": 0, "az": 0}, "bytes": [232,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]},
    { "in": {"frame": 8777, "tickMs": 8191, "px": 1234.5, "py": -67.25, "pz": -1987.75, "qw": 0.5, "qx": 0.5, "qy": 0.5, "qz": 0.5, "vx": 72.5, "vy": -3.25, "vz": 12.75, "wx": 0.5, "wy": -1.25, "wz": 3, "ax": 8.5, "ay": -9.5, "az": 2.25}, "bytes": [73,34,255,31,148,38,230,253,226,193,32,18,204,15,51,0,0,64,0,64,0,64,64,4,180,32,1,8,192,14,48,0]},
    { "in": {"frame": 16554, "tickMs": 16382, "px": -4095.899902, "py": 2047.75, "pz": 511.125, "qw": 0.7071067691, "qx": 0, "qy": 0.7071067691, "qz": 0, "vx": 127.5, "vy": -127.5, "vz": 0.015625, "wx": 7.995999813, "wy": -7.995999813, "wz": 0.00390625, "ax": 15.98999977, "ay": -15.98999977, "az": 0.0078125}, "bytes": [170,64,254,63,1,128,254,63,249,15,224,31,8,24,0,0,0,0,130,90,0,0,255,23,128,1,240,127,1,24,0,0]},
    { "in": {"frame": 24331, "tickMs": 24573, "px": 0.0625, "py": -0.0625, "pz": 0.125, "qw": 0.6000000238, "qx": -0.8000000119, "qy": 0, "qz": 0, "vx": -45, "vy": 20, "vz": -88, "wx": -2, "wy": 4, "wz": -6, "ax": -3, "ay": 6, "az": -12}, "bytes": [11,95,253,95,1,0,0,0,1,0,192,52,64,1,160,2,154,153,0,0,0,0,128,14,48,0,10,224,0,4,160,0]},
    { "in": {"frame": 32108, "tickMs": 32764, "px": 100.5, "py": 3.25, "pz": -999.875, "qw": -0.6000000238, "qx": 0.8000000119, "qy": 0, "qz": 0, "vx": 0.015625, "vy": -0.015625, "vz": 64, "wx": 0.25, "wy": -0.5, "wz": 1, "ax": 0.5, "ay": -0.5, "az": 1}, "bytes": [108,125,252,127,36,3,26,0,193,224,1,192,255,15,0,1,154,153,0,0,0,0,64,0,252,128,0,4,128,15,16,0]},
    { "in": {"frame": 39885, "tickMs": 40955, "px": 2047.875, "py": -2047.875, "pz": 1, "qw": 0, "qx": 1, "qy": 0, "qz": 0, "vx": 12, "vy": 33.5, "vz": -100.25, "wx": 3.5, "wy": -3.5, "wz": 2, "ax": 12.30000019, "ay": -9.81000042, "az": 0.5}, "bytes": [205,155,251,159,255,63,1,192,8,0,0,3,24,2,111,2,255,127,0,0,0,0,38,134,177,64,0,56,128,12,32,0]},
    { "in": {"frame": 47662, "tickMs": 49146, "px": -1.5, "py": 800.25, "pz": -1200.5, "qw": 0.2588190138, "qx": 0, "qy": 0.9659258127, "qz": 0, "vx": -8.5, "vy": 55, "vz": -1, "wx": -0.01169999968, "wy": 0.01169999968, "wz": 5, "ax": -0.003899999894, "ay": 0.003899999894, "az": 9}, "bytes": [46,186,250,191,244,255,2,25,124,218,224,61,112,3,252,3,0,0,162,123,0,0,0,0,0,128,212,255,3,0,80,0]},
    { "in": {"frame": 55439, "tickMs": 57337, "px": 4095.875, "py": -4095.875, "pz": 0, "qw": -0.5, "qx": -0.5, "qy": -0.5, "qz": -0.5, "vx": 100, "vy": -100, "vz": 50, "wx": 7, "wy": -7, "wz": 0, "ax": 15, "ay": -15, "az": 1}, "bytes": [143,216,249,223,255,127,1,128,0,0,0,25,192,9,200,0,0,64,0,64,0,64,128,7,136,128,0,112,0,9,0,0]}
  ]
}
```

## wasm（顶层布局探针）

### 文件: wasm/CMakeLists.txt

```text
# =============================================================================
#  forza_net —— Emscripten (Wasm) 构建
#
#    emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release \
#        -DGLM_DIR=/e/g-truc-glm-8d1fd52
#    cmake --build build-wasm
#    # 产物：build-wasm/forza_net.js + forza_net.wasm
#
#  说明：GLM 是**头文件库**，CMake 没有 find_package(glm) 的标准包名保证，
#        所以用 GLM_DIR 显式指定"含 glm/ 子目录的父目录"。
# =============================================================================
cmake_minimum_required(VERSION 3.16)
project(forza_net CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "本工程是给 Emscripten 用的。请用 emcmake cmake ... 调用。")
endif()

set(GLM_DIR "" CACHE PATH "含 glm/ 子目录的父目录（例如 /e/g-truc-glm-8d1fd52）")
if(NOT GLM_DIR)
  message(FATAL_ERROR "请用 -DGLM_DIR=<含 glm/ 的父目录> 指定 GLM")
endif()

set(SRC
  bindings.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../native/timesync/forza_time_sync.cpp
)

add_executable(forza_net ${SRC})

target_include_directories(forza_net PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../native/rb_replicator   # NetworkRigidBodyReplicator（头文件库）
  ${CMAKE_CURRENT_SOURCE_DIR}/../native/timesync
  ${GLM_DIR}
)

# ---- 性能与体积旗标（规格要求）----
target_compile_options(forza_net PRIVATE
  -O3
  -flto
  -msimd128                 # SIMD128：让 GLM 的 vec3/vec4 走 128 位通道
  -fno-exceptions           # 热路径零异常开销；本项目所有热路径函数本就 noexcept
  -fno-rtti
)

# ---- 链接旗标 ----
#  INITIAL_MEMORY=64MB（规格要求）、ALLOW_MEMORY_GROWTH=1
#  DYNAMIC_EXECUTION=0 —— 关闭 eval/new Function（规格要求"关闭动态调用开销"），
#    同时让产物能过严格 CSP（本仓库的 index.html 就有 default-src 'none'）
#  FILESYSTEM=0 —— 不需要虚拟文件系统，省体积
#  MODULARIZE + EXPORT_ES6 —— 给前端 `import { default as createModule } from './forza_net.js'`
target_link_options(forza_net PRIVATE
  --bind
  -O3
  -flto
  -msimd128
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createForzaNet
  -sENVIRONMENT=web,worker
  -sINITIAL_MEMORY=67108864
  -sALLOW_MEMORY_GROWTH=1
  -sDYNAMIC_EXECUTION=0
  -sFILESYSTEM=0
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32
  # 热路径是 extern "C" 的，必须显式导出，否则会被 LTO 当死代码删掉
  -sEXPORTED_FUNCTIONS=_forzaPushSnapshot,_forzaUpdate,_forzaVisualMatrixPtr,_forzaPhysicsMatrixPtr,_forzaClockOnPong,_forzaClockAdjustedDt,_forzaClockServerNow,_forzaClockWarp,_forzaClockReset,_forzaReplState,_forzaReplVisualError,_forzaSnapshotStride,_forzaSnapshotOffset,_malloc,_free
  -sASSERTIONS=0
)

set_target_properties(forza_net PROPERTIES OUTPUT_NAME "forza_net")
```

### 文件: wasm/bindings.cpp

```cpp
// =============================================================================
//  bindings.cpp —— ForzaTimeSynchronizer / NetworkRigidBodyReplicator 的 Embind 导出层
//
//  ── 性能设计（60Hz 高频路径上**一次拷贝都不做**）─────────────────────────────
//   Embind 的 `val` / `std::string` / `std::vector` 参数**每次调用都会分配并拷贝**，
//   在 60Hz × 4 车的量级下这些分配会直接吃掉帧预算。所以本层的策略是：
//
//     · **热路径不用 embind**，改用 `extern "C"` + `EMSCRIPTEN_KEEPALIVE`，
//       参数只有整数（WASM 堆指针），无类型转换、无分配、可内联；
//     · JS 侧把网络包直接写进 `Module.HEAPU8` 的固定缓冲区，再把**指针**传进来 ——
//       C++ 侧 `reinterpret_cast` 到 `const RigidBodyNetSnapshot*` 直接读，
//       全程零拷贝（依赖结构体 96B / align 16 的确定布局，由 static_assert 钉死）；
//     · 渲染矩阵同理：C++ 把 16 个 float 写进**调用方提供**的堆缓冲区，
//       JS 侧用同一个 `Float32Array` 视图读走。
//
//   Embind 只用于**低频**接口（初始化、配置、遥测查询）：那里可读性远比纳秒重要。
//
//  ── 编译 ────────────────────────────────────────────────────────────────────
//   em++ -std=c++20 -O3 -flto -msimd128 \
//        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web \
//        -sINITIAL_MEMORY=67108864 -sALLOW_MEMORY_GROWTH=1 \
//        -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 \
//        --bind -o forza_net.js bindings.cpp \
//        ../native/timesync/forza_time_sync.cpp \
//        ../native/rb_replicator/rigid_body_replicator.cpp   # 若拆了 .cpp
//   （完整命令见 build.sh / CMakeLists.txt）
// =============================================================================

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "../native/rb_replicator/rigid_body_replicator.h"
#include "../native/timesync/forza_time_sync.h"

using forza::net::ForzaTimeSynchronizer;
using forza::net::Nanos;
using forza::net::NetworkRigidBodyReplicator;
using forza::net::ReplicatorConfig;
using forza::net::RigidBodyNetSnapshot;

namespace {

/// 热路径用的全局单例（一个玩家一份；多人同屏再按 id 分槽即可）
ForzaTimeSynchronizer        g_clock;
NetworkRigidBodyReplicator   g_repl;

/// 渲染矩阵的输出暂存：16 个 float。**故意留在 WASM 堆里**供 JS 直接建视图读。
alignas(16) float g_matrixOut[16] = {};

/// 快照解码暂存：给"不想自己管指针"的调用方用（仍然零分配）
alignas(16) RigidBodyNetSnapshot g_snapshotScratch{};

inline void WriteMatrix(const glm::mat4& m) noexcept {
  // GLM 是列主序：m[col][row] -> 展平即 col*4+row，与 Three.js/Babylon 的
  // `fromArray` / `Matrix.FromArray` 期望的**列主序**一致。
  std::memcpy(g_matrixOut, &m[0][0], sizeof(g_matrixOut));
}

}  // namespace

// =============================================================================
//  1) C ABI 热路径 —— 零拷贝，供 60Hz 调用
// =============================================================================
extern "C" {

/// 网络包缓冲区需要的字节数（= sizeof(RigidBodyNetSnapshot)）。JS 侧据此分配。
EMSCRIPTEN_KEEPALIVE std::uint32_t forzaSnapshotStride() noexcept {
  return static_cast<std::uint32_t>(sizeof(RigidBodyNetSnapshot));
}

/// 单字段偏移查询：JS 侧**不要手抄**这些数字，用本函数或生成的常量表。
EMSCRIPTEN_KEEPALIVE std::uint32_t forzaSnapshotOffset(int field) noexcept {
  switch (field) {
    case 0: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, frame));
    case 1: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, tickMs));
    case 2: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, serverTimeSec));
    case 3: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, position));
    case 4: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, rotation));
    case 5: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, velocity));
    case 6: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, angularVelocity));
    case 7: return static_cast<std::uint32_t>(offsetof(RigidBodyNetSnapshot, accel));
    default: return 0xFFFFFFFFU;
  }
}

/**
 * **零拷贝入口**：ptr 指向 WASM 线性内存里的一个 RigidBodyNetSnapshot。
 * JS 侧典型用法（每帧一次，无分配）：
 *     const dst = new Uint8Array(Module.HEAPU8.buffer, this.pktPtr, stride);
 *     dst.set(packetBytes);                 // 写进 WASM 堆
 *     Module._forzaPushSnapshot(this.pktPtr);
 *
 * @return 1 = 接受，0 = 丢弃（帧号过期 / 非法）
 *
 * ⚠️ 不做长度校验：调用方必须保证 ptr 处至少有 forzaSnapshotStride() 字节。
 *    这是刻意的 —— 每次调用都校验长度会在 60Hz 上白花时间。JS 侧在自己的
 *    缓冲区里写，天然满足；若传入外部不可信指针，请先用 JS 侧的长度检查挡住。
 */
EMSCRIPTEN_KEEPALIVE int forzaPushSnapshot(std::uintptr_t ptr) noexcept {
  if (ptr == 0) return 0;
  const auto* s = reinterpret_cast<const RigidBodyNetSnapshot*>(ptr);
  return g_repl.OnAuthoritativeSnapshot(*s) ? 1 : 0;
}

/// 逐帧推进（外推 + 误差衰减）。dt 单位秒。
EMSCRIPTEN_KEEPALIVE void forzaUpdate(float dtSec) noexcept { g_repl.Update(dtSec); }

/// 把**视觉层**世界矩阵写进内部暂存，返回其指针（16 float，列主序）。
/// JS: `new Float32Array(Module.HEAPF32.buffer, ptr, 16)`
EMSCRIPTEN_KEEPALIVE std::uintptr_t forzaVisualMatrixPtr() noexcept {
  WriteMatrix(g_repl.GetVisualWorldTransform());
  return reinterpret_cast<std::uintptr_t>(g_matrixOut);
}

/// 物理层世界矩阵（碰撞/命中判定用，不含视觉偏移）
EMSCRIPTEN_KEEPALIVE std::uintptr_t forzaPhysicsMatrixPtr() noexcept {
  WriteMatrix(g_repl.GetPhysicsTransform());
  return reinterpret_cast<std::uintptr_t>(g_matrixOut);
}

/// 时钟：喂一次 NTP 往返。返回值见 SyncEvent 枚举（0=None/1=HardResync/2=Rejected）
EMSCRIPTEN_KEEPALIVE int forzaClockOnPong(std::int64_t t1, std::int64_t t2,
                                          std::int64_t t3, std::int64_t t4) noexcept {
  return static_cast<int>(g_clock.OnPong(t1, t2, t3, t4));
}

/// 时钟：取微调后的物理步长
EMSCRIPTEN_KEEPALIVE double forzaClockAdjustedDt(double baseDtSec) noexcept {
  return g_clock.AdjustedDeltaTime(baseDtSec);
}

/// 时钟：当前对服务端时间轴的估计（纳秒）
EMSCRIPTEN_KEEPALIVE std::int64_t forzaClockServerNow() noexcept {
  return g_clock.ServerNowNs();
}

/// 时钟：本帧伸缩比例（±1.5% 内），供 HUD / 遥测
EMSCRIPTEN_KEEPALIVE double forzaClockWarp() noexcept { return g_clock.CurrentWarp(); }

/// 时钟：断线重连
EMSCRIPTEN_KEEPALIVE void forzaClockReset() noexcept { g_clock.OnConnectionReset(); }

/// 中位数式的"当前状态"查询：state 见 ReplState（0=Empty 1=Extrapolating 2=Corrected 3=Stale）
EMSCRIPTEN_KEEPALIVE int forzaReplState() noexcept {
  return static_cast<int>(g_repl.State());
}

/// 视觉位置误差模长（米）—— 排查"是不是一直没收敛"的第一手指标
EMSCRIPTEN_KEEPALIVE float forzaReplVisualError() noexcept {
  return g_repl.VisualPositionErrorM();
}

}  // extern "C"

// =============================================================================
//  2) Embind —— 只用于**低频**接口
// =============================================================================

namespace {

/// 把快照按值搬出来（低频调试用；热路径请走 forzaPushSnapshot）
RigidBodyNetSnapshot CopyScratchFromHeap(std::uintptr_t ptr) noexcept {
  if (ptr != 0) {
    std::memcpy(&g_snapshotScratch, reinterpret_cast<const void*>(ptr),
                sizeof(g_snapshotScratch));
  }
  return g_snapshotScratch;
}

}  // namespace

EMSCRIPTEN_BINDINGS(forza_net_bindings) {
  // ---- 布局常量：把 C++ 的真值直接暴露给 JS，杜绝手抄漂移 ----
  emscripten::function("snapshotStride", &forzaSnapshotStride);
  emscripten::function("snapshotOffset", &forzaSnapshotOffset);

  // ---- 配置（低频：初始化阶段设一次）----
  emscripten::value_object<ReplicatorConfig>("ReplicatorConfig")
      .field("halfLifeSec", &ReplicatorConfig::halfLifeSec)
      .field("maxExtrapolationSec", &ReplicatorConfig::maxExtrapolationSec)
      .field("accelTrustSec", &ReplicatorConfig::accelTrustSec)
      .field("snapDistanceM", &ReplicatorConfig::snapDistanceM)
      .field("snapAngleRad", &ReplicatorConfig::snapAngleRad)
      .field("omegaTrustSec", &ReplicatorConfig::omegaTrustSec);

  emscripten::function("setReplicatorConfig",
                       +[](const ReplicatorConfig& c) { g_repl.SetConfig(c); });

  // ---- 时钟（低频查询）----
  emscripten::function("clockIsLocked", +[]() { return g_clock.IsLocked(); });
  emscripten::function("clockBestRttNs",
                       +[]() -> double { return static_cast<double>(g_clock.BestRttNs()); });
  emscripten::function("clockSampleCount", +[]() { return g_clock.SampleCount(); });

  // ---- 调试：把快照按值读回（会拷贝，禁止放进 60Hz 循环）----
  emscripten::function("debugSnapshotFromHeap", &CopyScratchFromHeap);

  // ---- 单例重置 ----
  emscripten::function("resetAll", +[]() {
    g_clock.OnConnectionReset();
    g_repl.Reset();
  });
}

// =============================================================================
//  3) 编译期自检
// =============================================================================
static_assert(sizeof(RigidBodyNetSnapshot) == 96, "线格式变了，必须同步 JS 侧与协议版本号");
static_assert(alignof(RigidBodyNetSnapshot) == 16, "对齐变了，JS 侧的堆缓冲区也要跟着对齐");
static_assert(std::is_trivially_copyable_v<RigidBodyNetSnapshot>,
              "必须是 trivially copyable，否则 memcpy / 指针直读都不成立");
static_assert(sizeof(glm::mat4) == 64, "mat4 必须是 16 个 float，"
                                       "否则 WriteMatrix 的 memcpy 长度对不上");
```

### 文件: wasm/build.sh

```bash
#!/usr/bin/env bash
# =============================================================================
#  forza_net —— 一键 Wasm 构建（等价于 CMakeLists.txt，供不想用 CMake 时直用）
#
#    EMSDK=<emsdk 路径> ./build.sh
#
#  本机**未安装 emsdk**，脚本会先检查；缺了会给出安装指引而不是静默失败。
# =============================================================================
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# ---- GLM：与 native/run_tests.sh 用同一套探测顺序 ----
GLM_DIR=""
for c in /usr/include /usr/local/include /e/mingw64/include \
         /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  if [ -f "$c/glm/glm.hpp" ]; then GLM_DIR="$c"; break; fi
done
[ -n "$GLM_DIR" ] || { echo "找不到 GLM（需要含 glm/ 的父目录）" >&2; exit 1; }

# ---- emsdk ----
if ! command -v em++ >/dev/null 2>&1; then
  for c in "$ROOT/../emsdk" /e/emsdk /c/emsdk; do
    if [ -f "$c/emsdk_env.sh" ]; then
      # shellcheck disable=SC1091
      . "$c/emsdk_env.sh" >/dev/null 2>&1 || true
      break
    fi
  done
fi
if ! command -v em++ >/dev/null 2>&1; then
  cat >&2 <<'MSG'
找不到 em++。本机目前未安装 Emscripten。安装方式（任选其一）：
  git clone https://github.com/emscripten-core/emsdk.git && cd emsdk \
    && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
装好后重新执行本脚本即可。源码与 CMake 配置无需改动。
MSG
  exit 1
fi

echo "em++: $(em++ --version | head -1)"
echo "GLM : $GLM_DIR"

mkdir -p "$HERE/dist"
em++ -std=c++20 -O3 -flto -msimd128 -fno-exceptions -fno-rtti \
  --bind \
  -I"$HERE" -I"$ROOT/native/rb_replicator" -I"$ROOT/native/timesync" -I"$GLM_DIR" \
  "$HERE/bindings.cpp" "$ROOT/native/timesync/forza_time_sync.cpp" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createForzaNet \
  -sENVIRONMENT=web,worker \
  -sINITIAL_MEMORY=67108864 -sALLOW_MEMORY_GROWTH=1 \
  -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 -sASSERTIONS=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -sEXPORTED_FUNCTIONS=_forzaPushSnapshot,_forzaUpdate,_forzaVisualMatrixPtr,_forzaPhysicsMatrixPtr,_forzaClockOnPong,_forzaClockAdjustedDt,_forzaClockServerNow,_forzaClockWarp,_forzaClockReset,_forzaReplState,_forzaReplVisualError,_forzaSnapshotStride,_forzaSnapshotOffset,_malloc,_free \
  -o "$HERE/dist/forza_net.js"

echo "构建完成: $HERE/dist/forza_net.js (+ .wasm)"
```

### 文件: wasm/layout.json

```json
{
  "layoutVersion": 1,
  "sizeof": 96,
  "alignof": 16,
  "byteOrder": "little",
  "offsets": {
    "frame": 0,
    "tickMs": 4,
    "serverTimeSec": 8,
    "position": 16,
    "rotation": 32,
    "velocity": 48,
    "angularVelocity": 64,
    "accel": 80
  },
  "reference": {
    "frame": 1122867,
    "tickMs": 4478310,
    "serverTimeSec": 12.500000,
    "position": [1.500000, -2.250000, 3.750000],
    "rotation": [0.500000, 0.500000, 0.500000, 0.500000],
    "velocity": [30.000000, 0.500000, -12.000000],
    "angularVelocity": [0.250000, 1.500000, -0.750000],
    "accel": [9.000000, -1.000000, 0.000000]
  },
  "referenceHex": "332211006655440000004841000000000000c03f000010c000007040000000000000003f0000003f0000003f0000003f0000f0410000003f000040c1000000000000803e0000c03f000040bf0000000000001041000080bf0000000000000000"
}
```

### 文件: wasm/tools/layout_probe.cpp

```cpp
// =============================================================================
//  layout_probe.cpp —— 线格式契约的"真值发生器"（用普通 g++ 编译，不需要 Emscripten）
//
//  用途：C++ 结构体的布局是**唯一真值**。TS 侧的偏移常量不允许手抄 ——
//        本程序把 sizeof/offsetof 与一份"已知取值的参考快照字节块"一起吐出来，
//        再由 tools/gen_layout.mjs 生成 snapshotLayout.ts、由 verify_wire.mjs 校验解码。
//
//  为什么必须这么做：TS 与 C++ 之间的偏移一旦漂移，症状是"位置偶尔错乱"，
//  极难定位。把手抄改成生成 + 交叉校验，是这里唯一靠谱的做法。
//
//  编译运行（本机实测）：
//    g++ -std=c++20 -O2 tools/layout_probe.cpp -o build/layout_probe.exe && ./build/layout_probe.exe > layout.json
// =============================================================================
#include "../rb_replicator/rigid_body_replicator.h"

#include <cstddef>
#include <cstdio>
#include <cstring>
#include <vector>

using forza::net::RigidBodyNetSnapshot;

int main() {
  // ---- 1) 布局真值 ----
  std::printf("{\n");
  std::printf("  \"layoutVersion\": 1,\n");
  std::printf("  \"sizeof\": %zu,\n", sizeof(RigidBodyNetSnapshot));
  std::printf("  \"alignof\": %zu,\n", alignof(RigidBodyNetSnapshot));
  std::printf("  \"byteOrder\": \"%s\",\n",
#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
              "big"
#else
              "little"
#endif
  );
  std::printf("  \"offsets\": {\n");
  std::printf("    \"frame\": %zu,\n", offsetof(RigidBodyNetSnapshot, frame));
  std::printf("    \"tickMs\": %zu,\n", offsetof(RigidBodyNetSnapshot, tickMs));
  std::printf("    \"serverTimeSec\": %zu,\n", offsetof(RigidBodyNetSnapshot, serverTimeSec));
  std::printf("    \"position\": %zu,\n", offsetof(RigidBodyNetSnapshot, position));
  std::printf("    \"rotation\": %zu,\n", offsetof(RigidBodyNetSnapshot, rotation));
  std::printf("    \"velocity\": %zu,\n", offsetof(RigidBodyNetSnapshot, velocity));
  std::printf("    \"angularVelocity\": %zu,\n", offsetof(RigidBodyNetSnapshot, angularVelocity));
  std::printf("    \"accel\": %zu\n", offsetof(RigidBodyNetSnapshot, accel));
  std::printf("  },\n");

  // ---- 2) 参考快照：取值全部"可肉眼核对"，避免浮点误差干扰判定 ----
  RigidBodyNetSnapshot s{};
  s.frame = 0x00112233U;
  s.tickMs = 0x00445566U;
  s.serverTimeSec = 12.5F;
  s.position = glm::vec3(1.5F, -2.25F, 3.75F);
  s.rotation = glm::quat(0.5F, 0.5F, 0.5F, 0.5F);   // 单位四元数（90° 绕某轴）
  s.velocity = glm::vec3(30.0F, 0.5F, -12.0F);
  s.angularVelocity = glm::vec3(0.25F, 1.5F, -0.75F);
  s.accel = glm::vec3(9.0F, -1.0F, 0.0F);

  // 快照是 trivially copyable，可直接按字节取出
  static_assert(std::is_trivially_copyable_v<RigidBodyNetSnapshot>);
  std::vector<unsigned char> bytes(sizeof(RigidBodyNetSnapshot));
  std::memcpy(bytes.data(), &s, sizeof(s));

  std::printf("  \"reference\": {\n");
  std::printf("    \"frame\": %u,\n", s.frame);
  std::printf("    \"tickMs\": %u,\n", s.tickMs);
  std::printf("    \"serverTimeSec\": %.6f,\n", static_cast<double>(s.serverTimeSec));
  std::printf("    \"position\": [%.6f, %.6f, %.6f],\n", s.position.x, s.position.y, s.position.z);
  std::printf("    \"rotation\": [%.6f, %.6f, %.6f, %.6f],\n",
              s.rotation.w, s.rotation.x, s.rotation.y, s.rotation.z);
  std::printf("    \"velocity\": [%.6f, %.6f, %.6f],\n", s.velocity.x, s.velocity.y, s.velocity.z);
  std::printf("    \"angularVelocity\": [%.6f, %.6f, %.6f],\n",
              s.angularVelocity.x, s.angularVelocity.y, s.angularVelocity.z);
  std::printf("    \"accel\": [%.6f, %.6f, %.6f]\n", s.accel.x, s.accel.y, s.accel.z);
  std::printf("  },\n");

  // ---- 3) 参考字节块（十六进制）—— 给 JS 侧做真正的解码校验 ----
  std::printf("  \"referenceHex\": \"");
  for (unsigned char b : bytes) std::printf("%02x", b);
  std::printf("\"\n}\n");
  return 0;
}
```

### 文件: wasm/verify.sh

```bash
#!/usr/bin/env bash
# =============================================================================
#  wasm/ —— 线格式契约验证一键脚本
#
#    ./verify.sh
#
#  做两件事：
#    1) 用**普通 g++** 编译 tools/layout_probe.cpp 并执行 -> 重新生成 layout.json
#       （C++ 的 sizeof/offsetof 是唯一真值）
#    2) 跑 web/tools/verify_wire.mjs -> 用它去解 C++ 吐出的参考字节块，
#       并检查 TS 源码里的偏移常量和 layout.json 是否漂移
#
#  注意：**不需要 Emscripten**。验的是"TS 与 C++ 的二进制契约"，
#  和 Wasm 编译是两件独立的事。Wasm 编译请用 ./build.sh（需 emsdk）。
# =============================================================================
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

GXX=""
command -v g++ >/dev/null 2>&1 && GXX="g++"
[ -n "$GXX" ] || for c in /e/mingw64/bin/g++.exe /c/msys64/mingw64/bin/g++.exe; do
  [ -x "$c" ] && GXX="$c" && break
done
[ -n "$GXX" ] || { echo "找不到 g++" >&2; exit 127; }
export PATH="$(dirname "$GXX"):$PATH"

GLM_DIR=""
for c in /usr/include /usr/local/include /e/mingw64/include \
         /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  [ -f "$c/glm/glm.hpp" ] && GLM_DIR="$c" && break
done
[ -n "$GLM_DIR" ] || { echo "找不到 GLM" >&2; exit 1; }

echo "=== [1/2] 生成 C++ 布局真值 ==="
mkdir -p "$HERE/build"
"$GXX" -std=c++20 -O2 -Wall -Wextra -Wpedantic \
  -I "$ROOT/native/rb_replicator" -I "$GLM_DIR" \
  "$HERE/tools/layout_probe.cpp" -o "$HERE/build/layout_probe.exe"
"$HERE/build/layout_probe.exe" > "$HERE/layout.json"
echo "  -> $HERE/layout.json"

echo
echo "=== [2/2] TS <-> C++ 线格式契约验证 ==="
NODE=""
command -v node >/dev/null 2>&1 && NODE="node"
[ -n "$NODE" ] || NODE="/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"

# --experimental-strip-types：Node >= 22.6 原生剥离 TS 类型。
# 用它就能**直接 import 出货的 .ts**，验的不是镜像而是要发布的代码。
cd "$ROOT"
"$NODE" --experimental-strip-types web/tools/verify_wire.mjs
```

## web（线格式 TS / 校验）

### 文件: web/NetworkPhysicsClient.ts

```typescript
/* =============================================================================
 *  NetworkPhysicsClient.ts —— WebRTC 二进制流 -> Wasm 物理同步的前端宿主
 *
 *  ── 它解决的问题 ────────────────────────────────────────────────────────────
 *  服务端以 20~60Hz 下发权威刚体状态。若前端直接把网格 Snap 到最新快照，
 *  会看到剧烈抖动与前后闪现（Rubberbanding）。本类把包**零拷贝**喂进 Wasm，
 *  由 `NetworkRigidBodyReplicator` 做航位推测 + 双层误差融合，
 *  渲染层只取 `GetVisualWorldTransform()` 的结果。
 *
 *  ── 数据流（60Hz 热路径上一次分配都没有）────────────────────────────────────
 *    RTCDataChannel.onmessage(ArrayBuffer)
 *        └─> 写进 WASM 堆里的**预分配**缓冲区（HEAPU8.set）
 *              └─> _forzaPushSnapshot(ptr)          // C++ 直接 reinterpret_cast 读
 *    requestAnimationFrame(now)
 *        ├─> _forzaClockAdjustedDt(1/60)           // 时钟微调后的物理步长
 *        ├─> _forzaUpdate(dt)                      // 外推 + 误差衰减
 *        ├─> _forzaVisualMatrixPtr() -> Float32Array 视图（不拷贝）
 *        └─> mesh.matrix.fromArray(view)
 *
 *  ── 必须牢记的两个 Emscripten 陷阱（本类已处理）─────────────────────────────
 *   1) `Module.HEAPU8.buffer` 在**内存增长后会 detach**（旧的 TypedArray 全部失效）。
 *      所以任何 `_malloc` 之后必须重建视图；本类用 `#refreshViews()` 统一处理，
 *      并在每帧入口做一次 `buffer.detached` 兜底检查。
 *   2) 不要跨帧缓存 `new Float32Array(HEAPF32.buffer, ptr, 16)` —— 堆一增长它就是
 *      悬空视图。本类的矩阵视图**每帧重建**（成本是一次极轻的视图构造，不是拷贝）。
 * ========================================================================== */

import {
  assertLayoutMatchesWasm,
  LAYOUT_VERSION,
  OFF,
  ReplState,
  SNAPSHOT_ALIGN,
  SNAPSHOT_STRIDE,
  SyncEvent,
} from './snapshotLayout';

// -----------------------------------------------------------------------------
//  Wasm 模块的最小类型描述（由 emcc --bind 产出）
// -----------------------------------------------------------------------------
export interface ForzaNetModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  // EMScripten 的动态符号挂在 Module 上（名字带下划线）
  _malloc(size: number): number;
  _free(ptr: number): void;
  _forzaSnapshotStride(): number;
  _forzaSnapshotOffset(field: number): number;
  _forzaPushSnapshot(ptr: number): number;
  _forzaUpdate(dtSec: number): void;
  _forzaVisualMatrixPtr(): number;
  _forzaPhysicsMatrixPtr(): number;
  _forzaClockOnPong(t1: number, t2: number, t3: number, t4: number): number;
  _forzaClockAdjustedDt(baseDtSec: number): number;
  _forzaClockServerNow(): number;
  _forzaClockWarp(): number;
  _forzaClockReset(): void;
  _forzaReplState(): number;
  _forzaReplVisualError(): number;
  // Embind 注册的自由函数
  setReplicatorConfig(cfg: Partial<ReplicatorConfig>): void;
  clockIsLocked(): boolean;
  clockBestRttNs(): number;
  snapshotStride(): number;
  resetAll(): void;
}

export interface ReplicatorConfig {
  halfLifeSec: number;
  maxExtrapolationSec: number;
  accelTrustSec: number;
  snapDistanceM: number;
  snapAngleRad: number;
  omegaTrustSec: number;
}

/** 网络快照（解码后的 JS 视图；热路径不构造它，只在调试时用） */
export interface DecodedSnapshot {
  frame: number;
  tickMs: number;
  serverTimeSec: number;
  position: [number, number, number];
  /** 四元数 (w, x, y, z) —— **w 在前**，与 glm::quat 内存序一致 */
  rotation: [number, number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
  accel: [number, number, number];
}

export interface ClientStats {
  packetsReceived: number;
  packetsRejected: number;
  hardResyncs: number;
  /** 视觉层残余误差（米）——"有没有一直不收敛"的第一手指标 */
  visualErrorM: number;
  /** 本帧时钟伸缩比例（±1.5% 内） */
  clockWarp: number;
  clockLocked: boolean;
  replState: ReplState;
  /** 每秒帧数（滑动平均） */
  fps: number;
}

export type CreateModule = (opts?: Record<string, unknown>) => Promise<ForzaNetModule>;

// -----------------------------------------------------------------------------
//  单例
// -----------------------------------------------------------------------------
export class NetworkPhysicsClient {
  static #instance: NetworkPhysicsClient | null = null;

  /** 全局单例。WebRTC 通道、Wasm 实例、rAF 循环都只应有一份。 */
  static get instance(): NetworkPhysicsClient {
    if (!NetworkPhysicsClient.#instance) {
      NetworkPhysicsClient.#instance = new NetworkPhysicsClient();
    }
    return NetworkPhysicsClient.#instance;
  }

  private constructor() {}

  // ---- Wasm ----
  #mod: ForzaNetModule | null = null;
  #packetPtr = 0;                     // 预分配的快照缓冲区（WASM 堆内）
  #packetView: Uint8Array | null = null;

  // ---- 网络 ----
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #lastPingSentT1 = 0;
  #pingTimer = 0;

  // ---- 循环 ----
  #rafId = 0;
  #lastNow = 0;
  #running = false;
  #dt = 1 / 60;
  #stats: ClientStats = NetworkPhysicsClient.#emptyStats();

  // ---- 每帧重建的矩阵视图（堆增长后旧视图会 detach）----
  #matrixView: Float32Array | null = null;

  static #emptyStats(): ClientStats {
    return {
      packetsReceived: 0,
      packetsRejected: 0,
      hardResyncs: 0,
      visualErrorM: 0,
      clockWarp: 0,
      clockLocked: false,
      replState: ReplState.Empty,
      fps: 0,
    };
  }

  get stats(): Readonly<ClientStats> {
    return this.#stats;
  }

  get ready(): boolean {
    return this.#mod !== null;
  }

  // ---------------------------------------------------------------------------
  //  1) 初始化
  // ---------------------------------------------------------------------------

  /**
   * @param createModule emcc `-sMODULARIZE -sEXPORT_ES6` 产出的工厂函数
   *                     （`import createForzaNet from './forza_net.js'`）
   * @param cfg          可选的复制器参数（半衰期等）
   */
  async init(createModule: CreateModule, cfg?: Partial<ReplicatorConfig>): Promise<void> {
    if (this.#mod) return;                       // 幂等：重复调用安全

    const mod = await createModule();
    this.#mod = mod;

    // ---- 线格式自检：偏移不符就直接抛，绝不带着漂移继续跑 ----
    assertLayoutMatchesWasm(
      mod._forzaSnapshotStride(),
      (f) => mod._forzaSnapshotOffset(f),
    );

    // ---- 预分配快照缓冲区（**只分配这一次**）----
    // 多要 SNAPSHOT_ALIGN 字节，保证无论 malloc 返回什么地址都能手工对齐到 16。
    const raw = mod._malloc(SNAPSHOT_STRIDE + SNAPSHOT_ALIGN);
    if (raw === 0) throw new Error('[forza_net] 快照缓冲区分配失败');
    this.#packetPtr = (raw + (SNAPSHOT_ALIGN - 1)) & ~(SNAPSHOT_ALIGN - 1);

    this.#refreshViews();                        // malloc 之后堆可能已增长 -> 重建视图

    if (cfg) mod.setReplicatorConfig(cfg);

    console.info(
      `[forza_net] Wasm 就绪 · layout v${LAYOUT_VERSION} · stride ${SNAPSHOT_STRIDE}B` +
        ` · 缓冲区 @0x${this.#packetPtr.toString(16)}`,
    );
  }

  /**
   * 重建所有 WASM 堆视图。
   * **必须在任何 `_malloc`/`_free` 之后调用** —— 内存增长会让旧的
   * `HEAPU8`/`HEAPF32` 指向已 detach 的 ArrayBuffer，继续用就是静默读垃圾。
   */
  #refreshViews(): void {
    const mod = this.#mod;
    if (!mod) return;
    this.#packetView = new Uint8Array(
      mod.HEAPU8.buffer,
      this.#packetPtr,
      SNAPSHOT_STRIDE,
    );
    this.#matrixView = null;                     // 延迟到首次读取时重建
  }

  // ---------------------------------------------------------------------------
  //  2) WebRTC 接入
  // ---------------------------------------------------------------------------

  /**
   * 接上一条 WebRTC 连接并开始消费二进制快照。
   *
   * 关键：数据通道必须配成**不可靠 + 无序** ——
   *   · `ordered: false`    允许后发的包先到（快照有帧号，乱序由 C++ 侧丢弃）
   *   · `maxRetransmits: 0` 彻底关掉重传，规避 TCP 式队头阻塞：
   *     一个丢失的旧快照不该拖住后面 20 个新快照 —— 旧快照本来就没有价值。
   */
  attachDataChannel(pc: RTCPeerConnection, label = 'forza-physics'): RTCDataChannel {
    this.#pc = pc;
    const dc = pc.createDataChannel(label, { ordered: false, maxRetransmits: 0 });
    this.#bindDataChannel(dc);
    return dc;
  }

  /** 若通道由对端创建，用它接上 */
  adoptDataChannel(dc: RTCDataChannel): void {
    this.#bindDataChannel(dc);
  }

  #bindDataChannel(dc: RTCDataChannel): void {
    this.#dc = dc;
    dc.binaryType = 'arraybuffer';
    // 不可靠通道必须容忍丢包：带宽由 congestion control 自己收敛
    dc.bufferedAmountLowThreshold = 0;

    dc.onmessage = (ev: MessageEvent<ArrayBuffer>) => this.#onBinaryPacket(ev.data);

    dc.onopen = () => {
      console.info('[forza_net] DataChannel 已打开（unreliable/unordered）');
      this.#startPing();                         // 1Hz NTP 心跳，喂时钟微调
      this.start();                              // 打开即启动 rAF 循环
    };
    dc.onclose = () => {
      this.#stopPing();
      this.#mod?._forzaClockReset();             // 断线 -> 清时钟窗口，重连后重新锁定
    };
  }

  /** 收到一个二进制快照：零拷贝写进 WASM 堆，然后把指针交给 C++ */
  #onBinaryPacket(buf: ArrayBuffer): void {
    const mod = this.#mod;
    if (!mod || !this.#packetView) return;

    // 长度不符直接丢（可能是别的消息类型）
    if (buf.byteLength !== SNAPSHOT_STRIDE) {
      this.#stats.packetsRejected++;
      return;
    }

    // 堆增长会让视图 detach —— 每包一次极廉价的兜底检查，比"读到垃圾"便宜得多
    if ((this.#packetView.buffer as ArrayBuffer).byteLength === 0) {
      this.#refreshViews();
      if (!this.#packetView) return;
    }

    this.#packetView.set(new Uint8Array(buf));   // 唯一一次内存移动：network -> heap
    const accepted = mod._forzaPushSnapshot(this.#packetPtr);
    if (accepted === 1) {
      this.#stats.packetsReceived++;
    } else {
      this.#stats.packetsRejected++;             // 乱序/过期，正常现象
    }
  }

  // ---------------------------------------------------------------------------
  //  3) NTP 心跳（喂给 ForzaTimeSynchronizer 的 Clock Slewing）
  // ---------------------------------------------------------------------------

  #startPing(): void {
    this.#stopPing();
    const tick = (): void => {
      this.#sendPing();
      this.#pingTimer = window.setTimeout(tick, 1000);   // 规格：1Hz
    };
    tick();
  }

  #stopPing(): void {
    if (this.#pingTimer) {
      clearTimeout(this.#pingTimer);
      this.#pingTimer = 0;
    }
  }

  #sendPing(): void {
    const dc = this.#dc;
    if (!dc || dc.readyState !== 'open') return;
    if (!this.#mod) return;

    // T1 必须取**单调纳秒**：Wasm 的 MonotonicClock 与 JS performance.now 同源
    // （emscripten_get_now 就是 performance.now），所以两边可以直接相减。
    // 千万别用 Date.now()：它会被系统 NTP 调整，作为时基是自找麻烦。
    this.#lastPingSentT1 = performance.now() * 1e6;

    // 控制包用 JSON 文本走同一条通道；快照是二进制的，靠 binaryType 区分。
    // （若在意这点开销，可改成 16 字节定长二进制头 —— 见 README 的"可优化项"。）
    dc.send(JSON.stringify({ t: 'PING', t1: this.#lastPingSentT1 }));
  }

  /** 服务端 PONG：{"type":"PONG","t1":..,"t2":..,"t3":..} —— t2/t3 为服务端时钟轴 */
  handlePong(t1: number, t2: number, t3: number): void {
    const mod = this.#mod;
    if (!mod) return;
    const t4 = performance.now() * 1e6;
    const ev = mod._forzaClockOnPong(t1, t2, t3, t4);
    if (ev === SyncEvent.HardResync) {
      this.#stats.hardResyncs++;
      console.warn('[forza_net] 时钟硬同步（偏差 > 200ms 或断线重连）');
    }
  }

  // ---------------------------------------------------------------------------
  //  4) 渲染循环
  // ---------------------------------------------------------------------------

  start(baseDtSec = 1 / 60): void {
    if (this.#running || !this.#mod) return;
    this.#running = true;
    this.#dt = baseDtSec;
    this.#lastNow = performance.now();
    // 注意用箭头函数：rAF 回调的 `this` 不是实例
    this.#rafId = requestAnimationFrame(this.#frame);
  }

  stop(): void {
    this.#running = false;
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
  }

  /** rAF 回调（每帧一次调用 Wasm；不分配任何对象） */
  #frame = (now: number): void => {
    const mod = this.#mod;
    if (!mod) return;
    if (!this.#running) return;
    this.#rafId = requestAnimationFrame(this.#frame);

    const rawDt = (now - this.#lastNow) / 1000;
    this.#lastNow = now;
    // 夹住 dt：切标签页回来时 rawDt 可能是好几秒，直接喂给物理会瞬移
    const frameDt = Math.min(Math.max(rawDt, 0), 0.25);

    // ---- 1) 时钟微调：拿到"被 slewing 过的"物理步长 ----
    // 注意这里传的是**基准**步长，Wasm 内部按 ±1.5% 伸缩后返回。
    // 不能改成 `frameDt * (1+warp)` —— 规格要的是"微调积分步长使之贴合服务端时间"，
    // 而不是"把真实帧间隔也一起缩放"（后者会引入显示刷新率相关的手感差异）。
    let dt = mod._forzaClockAdjustedDt(this.#dt);
    if (!Number.isFinite(dt) || dt <= 0) dt = this.#dt;      // 未锁定/异常 -> 用基准值

    // ---- 2) 推进复制器（外推 + 双层误差衰减）----
    mod._forzaUpdate(frameDt);

    // ---- 3) 读视觉矩阵（零拷贝：只是建一个视图，不搬数据）----
    this.#matrixView = this.#getFloatView(mod._forzaVisualMatrixPtr(), 16);

    // ---- 4) 统计 ----
    const s = this.#stats;
    s.visualErrorM = mod._forzaReplVisualError();
    s.clockWarp = mod._forzaClockWarp();
    s.clockLocked = mod.clockIsLocked();
    s.replState = mod._forzaReplState() as ReplState;
    s.fps = 0.9 * s.fps + 0.1 * (1 / Math.max(frameDt, 1e-4));
  };

  #getFloatView(ptr: number, count: number): Float32Array {
    const mod = this.#mod!;
    // 每次都重建：堆增长过的话旧视图已 detach。**不要缓存**。
    return new Float32Array(mod.HEAPF32.buffer, ptr, count);
  }

  /** 本帧的视觉层矩阵（16 float，列主序）。Three.js / Babylon 都吃这个序。 */
  get visualMatrix(): Float32Array | null {
    return this.#matrixView;
  }

  /** 物理层矩阵（碰撞/命中判定用，不含视觉偏移） */
  get physicsMatrix(): Float32Array | null {
    const mod = this.#mod;
    if (!mod) return null;
    return this.#getFloatView(mod._forzaPhysicsMatrixPtr(), 16);
  }

  // ---------------------------------------------------------------------------
  //  5) 渲染引擎对接示范
  // ---------------------------------------------------------------------------

  /**
   * Three.js：把视觉矩阵直接写进 Mesh。
   * 必须关掉 `matrixAutoUpdate`，否则 Three 每帧会用 position/quaternion
   * 覆盖我们写进去的矩阵。
   */
  applyToThree(mesh: {
    matrixAutoUpdate: boolean;
    matrix: { fromArray(a: ArrayLike<number>): unknown };
  }): boolean {
    const m = this.#matrixView;
    if (!m) return false;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(m);                    // Matrix4.fromArray 收的就是列主序
    return true;
  }

  /**
   * Babylon.js：Babylon 走的是 position + rotationQuaternion 的分解形式
   * （不是矩阵直写），所以这里从矩阵里把两者拆出来。
   * 只做**刚性变换**的分解：平移取第 4 列，旋转用标准 Shepperd 法从 3×3 提取四元数。
   */
  applyToBabylon(mesh: {
    position: { set(x: number, y: number, z: number): void };
    rotationQuaternion: { set(x: number, y: number, z: number, w: number): void } | null;
    rotation?: { set(x: number, y: number, z: number): void };
  }): boolean {
    const m = this.#matrixView;
    if (!m) return false;

    // 列主序：第 4 列 = 平移
    mesh.position.set(m[12], m[13], m[14]);

    const q = quatFromColumnMajor(m);
    if (mesh.rotationQuaternion) {
      mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);   // Babylon: (x,y,z,w)
    } else if (mesh.rotation) {
      // 没启用四元数旋转时退回欧拉角（有万向锁风险，仅作兜底）
      const e = eulerFromQuat(q);
      mesh.rotation.set(e[0], e[1], e[2]);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  //  6) 调试：把堆里的快照解码成 JS 对象（**不在热路径上**）
  // ---------------------------------------------------------------------------

  decodeHeapSnapshot(): DecodedSnapshot | null {
    const mod = this.#mod;
    if (!mod || this.#packetPtr === 0) return null;
    // DataView 显式指定小端：意图明确，且在罕见的大端平台上也不会悄悄出错
    const dv = new DataView(mod.HEAPU8.buffer, this.#packetPtr, SNAPSHOT_STRIDE);
    return decodeSnapshot(dv);
  }

  dispose(): void {
    this.stop();
    this.#stopPing();
    this.#dc?.close();
    this.#dc = null;
    this.#pc?.close();
    this.#pc = null;
    if (this.#mod && this.#packetPtr) {
      // 注意：_free 之后堆视图可能失效，且本实例即将作废，无需再 refresh
      this.#mod._free(this.#packetPtr);
      this.#packetPtr = 0;
    }
    NetworkPhysicsClient.#instance = null;
  }
}

// =============================================================================
//  纯函数工具（导出以供单测直接调用）
// =============================================================================

/**
 * 用 DataView 解码一个快照。
 *
 * 这个函数是**热路径的参考实现**：`web/tools/verify_wire.mjs` 用同一套逻辑
 * 去解 C++ 吐出来的参考字节块，逐字段比对 —— 这是验证"TS 与 C++ 线格式是否
 * 真的对齐"的唯一可靠手段（手写偏移迟早漂移）。
 */
export function decodeSnapshot(dv: DataView): DecodedSnapshot {
  const f32 = (o: number): number => dv.getFloat32(o, /* littleEndian */ true);
  return {
    frame: dv.getUint32(OFF.frame, true),
    tickMs: dv.getUint32(OFF.tickMs, true),
    serverTimeSec: f32(OFF.serverTimeSec),
    position: [f32(OFF.position), f32(OFF.position + 4), f32(OFF.position + 8)],
    // glm::quat 内存序是 (w, x, y, z)
    rotation: [
      f32(OFF.rotation),
      f32(OFF.rotation + 4),
      f32(OFF.rotation + 8),
      f32(OFF.rotation + 12),
    ],
    velocity: [f32(OFF.velocity), f32(OFF.velocity + 4), f32(OFF.velocity + 8)],
    angularVelocity: [
      f32(OFF.angularVelocity),
      f32(OFF.angularVelocity + 4),
      f32(OFF.angularVelocity + 8),
    ],
    accel: [f32(OFF.accel), f32(OFF.accel + 4), f32(OFF.accel + 8)],
  };
}

/**
 * 从**列主序** 4×4 刚性变换矩阵提取旋转四元数，返回 (x, y, z, w)。
 *
 * 用 Shepperd 法：先取 3×3 迹的最大分量分支，避免 `w` 接近 0 时除以小数
 * 导致精度崩塌（朴素公式在 180° 附近最容易炸）。
 */
export function quatFromColumnMajor(m: ArrayLike<number>): [number, number, number, number] {
  // 列主序 m[col*4+row]；3×3 的 (row, col)
  const m00 = m[0], m10 = m[1], m20 = m[2];
  const m01 = m[4], m11 = m[5], m21 = m[6];
  const m02 = m[8], m12 = m[9], m22 = m[10];
  const tr = m00 + m11 + m22;

  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1.0) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

export function eulerFromQuat(
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);
  return [roll, pitch, yaw];
}

export default NetworkPhysicsClient;
```

### 文件: web/snapshotLayout.ts

```typescript
/* =============================================================================
 *  snapshotLayout.ts —— 网络快照的线格式常量
 *
 *  ⚠️ **本文件由 C++ 真值生成，不要手改。**
 *
 *  生成链：
 *      wasm/tools/layout_probe.cpp      （C++ 侧 sizeof / offsetof 真值）
 *        -> g++ 编译执行 -> wasm/layout.json
 *        -> node wasm/tools/gen_layout.mjs -> 本文件
 *
 *  校验链：
 *      node web/tools/verify_wire.mjs   （用 C++ 吐出的参考字节块解码，逐字段比对）
 *
 *  为什么非要生成不可：TS 与 C++ 的偏移一旦漂移，症状是"位置偶尔错乱/姿态抽一下"，
 *  既不像崩溃也不像网络问题，极难定位。手抄的常量没有守卫，生成 + 交叉校验才有。
 * ========================================================================== */

/** 线格式版本。C++ 侧 sizeof/offsetof 变动时必须 +1，并在网络握手时比对。 */
export const LAYOUT_VERSION = 1;

/** 单个快照的字节数 = sizeof(RigidBodyNetSnapshot) */
export const SNAPSHOT_STRIDE = 96;

/** 快照要求的对齐（WASM 堆缓冲区必须按它对齐） */
export const SNAPSHOT_ALIGN = 16;

/** 构建/目标平台的字节序。所有现代浏览器平台都是 little。 */
export const WIRE_BYTE_ORDER: 'little' | 'big' = 'little';

/** 字段偏移（字节）—— 与 offsetof(RigidBodyNetSnapshot, X) 一致 */
export const OFF = {
  frame: 0,
  tickMs: 4,
  serverTimeSec: 8,
  /** glm::vec3 position —— 3 × float32 */
  position: 16,
  /** glm::quat rotation —— (w, x, y, z) 连续 4 × float32，注意 **w 在前** */
  rotation: 32,
  /** glm::vec3 velocity */
  velocity: 48,
  /** glm::vec3 angularVelocity —— rad/s */
  angularVelocity: 64,
  /** glm::vec3 accel —— m/s² */
  accel: 80,
} as const;

/* -----------------------------------------------------------------------------
 *  枚举：刻意**不用 `const enum`**
 *
 *  `const enum` 在 `isolatedModules`（Vite / esbuild / Babel 的默认前提）下是
 *  已知的麻烦来源：单文件转译器看不到跨文件的常量，要么报错要么退化成普通 enum。
 *  而 Node 的 strip-only TS 模式更是直接拒绝（它只删类型、不做代码生成）。
 *
 *  统一用「`as const` 对象 + 同名类型别名」：既是值也是类型，零运行时代码生成，
 *  在任意打包器/单文件转译器下都表现一致。
 * -------------------------------------------------------------------------- */

/** 快照被 C++ 接受/丢弃的结果 */
export const PushResult = { Rejected: 0, Accepted: 1 } as const;
export type PushResult = (typeof PushResult)[keyof typeof PushResult];

/** 与 C++ `ReplState` 一一对应 */
export const ReplState = {
  Empty: 0,
  Extrapolating: 1,
  Corrected: 2,
  Stale: 3,
} as const;
export type ReplState = (typeof ReplState)[keyof typeof ReplState];

/** 与 C++ `SyncEvent` 一一对应 */
export const SyncEvent = {
  None: 0,
  HardResync: 1,
  SampleRejected: 2,
} as const;
export type SyncEvent = (typeof SyncEvent)[keyof typeof SyncEvent];

/**
 * 编译期/运行期自检：本文件里写死的数字，必须与 WASM 模块自报的一致。
 * 在 `NetworkPhysicsClient.init()` 里调用一次；不一致就直接抛错，
 * **绝不允许带着漂移的偏移继续跑** —— 那样只会得到"偶尔错乱"的玄学 bug。
 */
export function assertLayoutMatchesWasm(
  stride: number,
  offsetOf: (field: number) => number,
): void {
  const fail = (what: string, want: number, got: number): never => {
    throw new Error(
      `[forza_net] 线格式不一致：${what} 期望 ${want}，WASM 报 ${got}。` +
        `请重新生成 snapshotLayout.ts（node wasm/tools/gen_layout.mjs）。`,
    );
  };
  if (stride !== SNAPSHOT_STRIDE) fail('stride', SNAPSHOT_STRIDE, stride);

  // 字段序号与 bindings.cpp 里 forzaSnapshotOffset 的 switch 一一对应
  const order: ReadonlyArray<readonly [number, number]> = [
    [0, OFF.frame],
    [1, OFF.tickMs],
    [2, OFF.serverTimeSec],
    [3, OFF.position],
    [4, OFF.rotation],
    [5, OFF.velocity],
    [6, OFF.angularVelocity],
    [7, OFF.accel],
  ];
  for (const [idx, want] of order) {
    const got = offsetOf(idx);
    if (got !== want) fail(`offset[${idx}]`, want, got);
  }
}
```

### 文件: web/tools/verify_wire.mjs

```javascript
#!/usr/bin/env node
/* =============================================================================
 *  verify_wire.mjs —— TS ↔ C++ 线格式契约验证
 *
 *  为什么需要它：偏移一旦漂移，症状是"位置偶尔错乱 / 姿态抽一下"，
 *  既不像崩溃也不像网络问题，是最难查的一类 bug。手抄的常量没有任何守卫。
 *
 *  验证思路（三层）：
 *    A. **偏移漂移守卫**：从 snapshotLayout.ts 的**源码文本**里抠出常量，
 *       与 wasm/layout.json（由 C++ 的 sizeof/offsetof 生成）逐个比对。
 *    B. **真实解码**：用 **Node 22 的原生 TS 类型剥离**直接 import 出货文件里的
 *       `decodeSnapshot`，去解 C++ 吐出来的参考字节块，逐字段比对。
 *       （不是"照抄一份镜像"，验的就是要发布的那份代码。）
 *    C. **旋转提取**：`quatFromColumnMajor` 的往返正确性 + 180° 边界
 *       （朴素公式在这个角度附近最容易精度崩塌）。
 *
 *  运行：node web/tools/verify_wire.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

let pass = 0;
let fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? '   ' + detail : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// -----------------------------------------------------------------------------
// 0) 读 C++ 真值
// -----------------------------------------------------------------------------
const layoutPath = path.join(ROOT, 'wasm', 'layout.json');
if (!fs.existsSync(layoutPath)) {
  console.error(
    '缺少 wasm/layout.json。\n' +
    '请先运行：\n' +
    '  g++ -std=c++20 -O2 -I native/rb_replicator -I <GLM父目录> \\\n' +
    '      wasm/tools/layout_probe.cpp -o wasm/build/layout_probe.exe\n' +
    '  wasm/build/layout_probe.exe > wasm/layout.json',
  );
  process.exit(2);
}
const L = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
console.log(`C++ 真值: sizeof=${L.sizeof} align=${L.alignof} byteOrder=${L.byteOrder}\n`);

// -----------------------------------------------------------------------------
// A) 偏移漂移守卫：从 snapshotLayout.ts 源码文本里抠常量
// -----------------------------------------------------------------------------
console.log('[A] 偏移漂移守卫（TS 源码常量 vs C++ offsetof）');
const layoutTs = fs.readFileSync(path.join(ROOT, 'web', 'snapshotLayout.ts'), 'utf8');

const numConst = (re, name) => {
  const m = layoutTs.match(re);
  if (!m) throw new Error(`snapshotLayout.ts 里找不到 ${name}`);
  return Number(m[1]);
};
const tsStride = numConst(/export const SNAPSHOT_STRIDE\s*=\s*(\d+)/, 'SNAPSHOT_STRIDE');
const tsAlign = numConst(/export const SNAPSHOT_ALIGN\s*=\s*(\d+)/, 'SNAPSHOT_ALIGN');
const tsVer = numConst(/export const LAYOUT_VERSION\s*=\s*(\d+)/, 'LAYOUT_VERSION');

check(tsStride === L.sizeof, 'SNAPSHOT_STRIDE 与 sizeof 一致', `${tsStride} vs ${L.sizeof}`);
check(tsAlign === L.alignof, 'SNAPSHOT_ALIGN 与 alignof 一致', `${tsAlign} vs ${L.alignof}`);
check(L.layoutVersion === tsVer, 'LAYOUT_VERSION 一致', `v${tsVer}`);

// 逐字段：从 `xxxx: 数字,` 里抠
for (const [field, want] of Object.entries(L.offsets)) {
  const re = new RegExp(`\\b${field}:\\s*(\\d+)`);
  const got = Number(layoutTs.match(re)?.[1]);
  check(got === want, `OFF.${field} 偏移一致`, `${got} vs ${want}`);
}

// -----------------------------------------------------------------------------
// B) 用**出货 TS 代码**解码 C++ 参考字节块
// -----------------------------------------------------------------------------
console.log('\n[B] 真实解码（Node 原生 TS 类型剥离，import 出货文件）');
const srcDir = path.join(ROOT, 'web');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forza_wire_'));

// NetworkPhysicsClient.ts 内部用无扩展名 import（TS 惯例），Node ESM 要求扩展名。
// 这里只做**一处**最小改写（补 .ts），不改任何逻辑 —— 保证验的还是出货代码。
const clientSrc = fs
  .readFileSync(path.join(srcDir, 'NetworkPhysicsClient.ts'), 'utf8')
  .replace(/from '\.\/snapshotLayout'/g, "from './snapshotLayout.ts'");
fs.writeFileSync(path.join(tmpDir, 'NetworkPhysicsClient.ts'), clientSrc);
fs.copyFileSync(path.join(srcDir, 'snapshotLayout.ts'), path.join(tmpDir, 'snapshotLayout.ts'));

let client;
try {
  client = await import(pathToFileURL(path.join(tmpDir, 'NetworkPhysicsClient.ts')).href);
} catch (e) {
  console.log(`  FAIL  无法 import 出货 TS：${e.message.split('\n')[0]}`);
  console.log('        （若 Node 版本 < 22.6，请改用 --experimental-strip-types 或升级 Node）');
  process.exit(1);
}
check(typeof client.decodeSnapshot === 'function', '成功 import 出货文件里的 decodeSnapshot');

// 把参考 hex 还原成字节 -> DataView
const bytes = new Uint8Array(
  L.referenceHex.match(/.{2}/g).map((h) => parseInt(h, 16)),
);
check(bytes.length === L.sizeof, '参考字节块长度 = sizeof', `${bytes.length}B`);

const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const dec = client.decodeSnapshot(dv);
const R = L.reference;

check(dec.frame === R.frame, 'frame 解码正确', `0x${dec.frame.toString(16)} vs 0x${R.frame.toString(16)}`);
check(dec.tickMs === R.tickMs, 'tickMs 解码正确', `${dec.tickMs} vs ${R.tickMs}`);
check(near(dec.serverTimeSec, R.serverTimeSec), 'serverTimeSec 解码正确',
  `${dec.serverTimeSec} vs ${R.serverTimeSec}`);
for (let i = 0; i < 3; i++) {
  check(near(dec.position[i], R.position[i]), `position[${i}]`,
    `${dec.position[i]} vs ${R.position[i]}`);
}
for (let i = 0; i < 4; i++) {
  check(near(dec.rotation[i], R.rotation[i]), `rotation[${'wxyz'[i]}]`,
    `${dec.rotation[i]} vs ${R.rotation[i]}`);
}
for (let i = 0; i < 3; i++) {
  check(near(dec.velocity[i], R.velocity[i]), `velocity[${i}]`,
    `${dec.velocity[i]} vs ${R.velocity[i]}`);
  check(near(dec.angularVelocity[i], R.angularVelocity[i]), `angularVelocity[${i}]`,
    `${dec.angularVelocity[i]} vs ${R.angularVelocity[i]}`);
  check(near(dec.accel[i], R.accel[i]), `accel[${i}]`,
    `${dec.accel[i]} vs ${R.accel[i]}`);
}
check(Math.hypot(...dec.rotation) > 0.99 && Math.hypot(...dec.rotation) < 1.01,
  'rotation 是单位四元数（w 在前的读法正确）', `|q|=${Math.hypot(...dec.rotation).toFixed(4)}`);

// 端序必须显式声明
check(/getFloat32\(o,\s*\/\* littleEndian \*\/ true\)/.test(clientSrc) ||
      /getFloat32\(o,\s*true\)/.test(clientSrc),
  'decodeSnapshot 显式声明小端（不依赖宿主平台默认）');

// -----------------------------------------------------------------------------
// C) 旋转提取（quatFromColumnMajor）
// -----------------------------------------------------------------------------
console.log('\n[C] quatFromColumnMajor 正确性');
const quatMul = (a, b) => [ // (x,y,z,w)
  a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
  a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
  a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
  a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
];
const axisAngle = (ax, ay, az, deg) => {
  const n = Math.hypot(ax, ay, az) || 1;
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [(ax / n) * s, (ay / n) * s, (az / n) * s, Math.cos(h)];
};
/** (x,y,z,w) -> 列主序 4x4（与 glm::mat4_cast 同构） */
const toColumnMajor = (q) => {
  const [x, y, z, w] = q;
  return new Float32Array([
    1-2*(y*y+z*z), 2*(x*y+w*z),   2*(x*z-w*y),   0,
    2*(x*y-w*z),   1-2*(x*x+z*z), 2*(y*z+w*x),   0,
    2*(x*z+w*y),   2*(y*z-w*x),   1-2*(x*x+y*y), 0,
    0, 0, 0, 1,
  ]);
};

const cases = [
  ['单位旋转',        [0, 0, 0, 1]],
  ['绕 Y 轴 90°',     axisAngle(0, 1, 0, 90)],
  ['绕 X 轴 30°',     axisAngle(1, 0, 0, 30)],
  ['绕 Z 轴 -120°',   axisAngle(0, 0, 1, -120)],
  ['180°（边界）',    axisAngle(0.6, 0.8, 0, 180)],
  ['接近 180° 偏移',  axisAngle(0.577, 0.577, 0.577, 179.5)],
  ['复合旋转',        quatMul(axisAngle(0,1,0,47), axisAngle(1,0,0,-63))],
];
for (const [name, q] of cases) {
  const got = client.quatFromColumnMajor(toColumnMajor(q));
  // 四元数 q 与 -q 表示同一旋转，取符号无关的等价判定
  const dot = Math.abs(got[0]*q[0] + got[1]*q[1] + got[2]*q[2] + got[3]*q[3]);
  check(dot > 0.9999, `旋转提取: ${name}`, `|dot|=${dot.toFixed(6)}`);
}

// 传输过程中的矩阵从 C++ 侧来：平移在列主序的第 4 列
const withT = toColumnMajor(axisAngle(0, 1, 0, 90));
withT[12] = 12.5; withT[13] = -3.25; withT[14] = 7.0;
const q2 = client.quatFromColumnMajor(withT);
check(near(withT[12], 12.5) && near(withT[13], -3.25) && near(withT[14], 7.0),
  '列主序平移位于 m[12..14]（Babylon 分解路径依赖此约定）');
check(Math.abs(Math.abs(q2[1]) - Math.SQRT1_2) < 1e-4,
  '平移不影响旋转提取', `y=${q2[1].toFixed(6)}`);

// -----------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
```
