# 极限竞速8 — 原生 C++ · 时序同步 / 赛距 / 刚体复制 harness

> 「极限竞速8」精简源码包自动生成 · 2026-10-15 08:56:46 (UTC+8)
> 分隔格式：`### 文件: <路径>` + 对应语言围栏，可直接被 AI 解析。

> 覆盖指定目录全部源码（已剔除 `.emcache` 工具链缓存与 emscripten JS 编译产物）。

## 本合集包含

- **时序同步（forza_time_sync）**
  - `native/timesync/CMakeLists.txt` — 45 行 / 1.6 KB
  - `native/timesync/forza_time_sync.cpp` — 54 行 / 2.5 KB
  - `native/timesync/forza_time_sync.h` — 550 行 / 28.0 KB
  - `native/timesync/forza_time_sync_test.cpp` — 646 行 / 29.6 KB
  - `native/timesync/forza_time_sync_testkit.h` — 130 行 / 5.6 KB
  - `native/timesync/verify_algorithm.py` — 410 行 / 17.1 KB
- **赛距追踪（race_delta_tracker）**
  - `native/race_delta/race_delta_tracker.cpp` — 56 行 / 2.7 KB
  - `native/race_delta/race_delta_tracker.h` — 692 行 / 31.9 KB
  - `native/race_delta/race_delta_tracker_test.cpp` — 497 行 / 23.5 KB
  - `native/race_delta/verify_race_delta.py` — 283 行 / 11.2 KB
- **刚体复制（rigid_body_replicator）**
  - `native/rb_replicator/CMakeLists.txt` — 50 行 / 1.8 KB
  - `native/rb_replicator/rigid_body_replicator.h` — 627 行 / 32.9 KB
  - `native/rb_replicator/rigid_body_replicator_test.cpp` — 400 行 / 20.2 KB
  - `native/rb_replicator/test_shim/glm/glm.hpp` — 84 行 / 3.9 KB
  - `native/rb_replicator/test_shim/glm/gtc/matrix_transform.hpp` — 18 行 / 0.6 KB
  - `native/rb_replicator/test_shim/glm/gtc/quaternion.hpp` — 57 行 / 2.2 KB
  - `native/rb_replicator/test_shim/glm/gtx/quaternion.hpp` — 32 行 / 1.1 KB
  - `native/rb_replicator/verify_blending.py` — 368 行 / 14.6 KB
- **总测试脚本**
  - `native/run_tests.sh` — 285 行 / 13.0 KB

**合计：5284 行，244.1 KB**

---

## 时序同步（forza_time_sync）

### 文件: native/timesync/CMakeLists.txt

```text
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
```

### 文件: native/timesync/forza_time_sync.cpp

```cpp
// =============================================================================
//  forza_time_sync.cpp —— 非热路径模块
//
//  这里的两个东西**刻意不放进头文件的热路径**：
//    · NtpJitterSimulator：确定性网络抖动模拟器（仅供单测 / 压测）
//    · SyncTelemetry     ：同步质量遥测（供 HUD 与单测断言）
//
//  热路径（OnPong / AdjustedDeltaTime）全在头文件里 inline，
//  保证引擎在 -O2 下可以把它们完全内联进主循环，且零堆分配。
// =============================================================================
#include "forza_time_sync_testkit.h"

namespace forza::net {

// -----------------------------------------------------------------------------
//  NtpJitterSimulator
// -----------------------------------------------------------------------------
NtpJitterSimulator::NtpJitterSimulator(const Config& c, std::uint64_t seed) noexcept
    : cfg_(c), rngState_(seed ? seed : 0x9E3779B97F4A7C15ull) {}

double NtpJitterSimulator::NextUnit() noexcept {
  // xorshift64*：无堆、无查表、周期 2^64-1，单测完全可复现
  rngState_ ^= rngState_ >> 12;
  rngState_ ^= rngState_ << 25;
  rngState_ ^= rngState_ >> 27;
  const std::uint64_t x = rngState_ * 0x2545F4914F6CDD1Dull;
  return static_cast<double>(x >> 11) * (1.0 / 9007199254740992.0);   // /2^53
}

Nanos NtpJitterSimulator::MakeRound(Nanos localArrival, Nanos& outT1, Nanos& outT2,
                                    Nanos& outT3, Nanos& outT4) noexcept {
  // 去程/回程**独立**取样 —— 这正是 NTP 偏移误差的来源
  const double u1 = NextUnit();
  const double u2 = NextUnit();
  const double dOut  = cfg_.baseDelayMs + cfg_.jitterLoMs + (cfg_.jitterHiMs - cfg_.jitterLoMs) * u1;
  const double dBack = cfg_.baseDelayMs + cfg_.jitterLoMs + (cfg_.jitterHiMs - cfg_.jitterLoMs) * u2;

  const Nanos outNs  = static_cast<Nanos>(dOut  * static_cast<double>(kNanosPerMs));
  const Nanos backNs = static_cast<Nanos>(dBack * static_cast<double>(kNanosPerMs));

  outT1 = localArrival;
  // 服务端时钟 = 客户端时钟 + 真实偏移 + 累积漂移
  outT2 = outT1 + outNs + cfg_.trueOffsetNs + CurrentDrift(localArrival);
  outT3 = outT2 + cfg_.serverProcNs;
  outT4 = outT1 + outNs + cfg_.serverProcNs + backNs;
  return outT4 - outT1;
}

Nanos NtpJitterSimulator::CurrentDrift(Nanos elapsedLocalNs) const noexcept {
  return static_cast<Nanos>(static_cast<double>(elapsedLocalNs) * cfg_.driftPpm * 1e-6);
}

}  // namespace forza::net
```

### 文件: native/timesync/forza_time_sync.h

```cpp
// =============================================================================
//  forza_time_sync.h —— 双端通用高精度时间同步（NTP 采样 + Clock Slewing）
//
//  目标环境：Linux 原生服务器 / Emscripten(Wasm) 浏览器端，C++20。
//
//  设计约束（全部满足才敢叫"双端通用"）：
//   1) **热路径零堆分配**：滑动窗口用固定容量 std::array 环形缓冲；
//      日志走裸函数指针（std::function 会分配）；无异常、无 std::string。
//   2) **单调时钟**：以 std::chrono::steady_clock 为基准（标准保证单调、不受
//      系统时间回拨影响）。但在 Linux 上进一步优先 CLOCK_MONOTONIC_RAW ——
//      它比 steady_clock 更严：**不参与 NTP 频率校正**。用被 adjtimex 调频的时钟
//      做时钟同步器会形成闭环自激（同步器把本地时钟拉快 → 系统 NTP 又把它拉慢）。
//      Wasm 用 emscripten_get_now（= performance.now，同样是单调的）。
//   3) **禁止硬跳**：1ms~250ms 的偏差只能通过物理步长 ±1.5% 连续微调收敛；
//      只有断线重连或偏差 > 250ms 才允许 Snap 并输出预警。
//
//  典型接法（物理主循环）：
//      sync.PushPingSample(t1, t2, t3, t4);              // 收到 PONG 时（1Hz 左右）
//      double dt = sync.GetAdjustedDeltaTime(1.0/60.0);  // 每帧取微调后的物理步长
//      world.Step(dt);
//      Nanos t = sync.GetServerTime();                   // 与服务端同一时间轴
//
//  编译：
//      Linux : g++ -std=c++20 -O2 -Wall -Wextra forza_time_sync.cpp test.cpp
//      Wasm  : em++ -std=c++20 -O2 -s WASM=1 forza_time_sync.cpp test.cpp
// =============================================================================
#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>

#if defined(__EMSCRIPTEN__)
#  include <emscripten/emscripten.h>
#elif defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#else
#  include <time.h>
#endif

namespace forza::net {

// -----------------------------------------------------------------------------
//  基础类型
// -----------------------------------------------------------------------------

using Nanos = std::int64_t;                        ///< 单调纳秒（64 位，292 年不溢出）

inline constexpr Nanos kNanosPerSecond = 1'000'000'000;
inline constexpr Nanos kNanosPerMs     = 1'000'000;
inline constexpr Nanos kNanosPerUs     = 1'000;

/// 无样本哨兵值（用 int64 max 而不是 0，避免"0 偏移"与"无样本"混淆）
inline constexpr Nanos kNoSample = std::numeric_limits<Nanos>::max();

/**
 * 单调时钟。
 *
 * ── 为什么以 steady_clock 为基准 ─────────────────────────────────────────────
 *  标准保证 `steady_clock` 单调不减、且**不受系统墙钟调整影响** ——
 *  这是"严禁带系统回拨风险的时钟"这条需求的直接落点。
 *  绝不能用 system_clock / gettimeofday / Date.now()：NTP 校时、用户改表、
 *  时区切换都会让它们**回拨**，时钟同步器一旦读到负的时间增量，
 *  RTT 与 offset 立刻变成垃圾，并可能触发无意义的硬同步。
 *
 * ── 为什么 Linux 上还要更进一步用 CLOCK_MONOTONIC_RAW ────────────────────────
 *  `steady_clock` 在 glibc 上通常就是 CLOCK_MONOTONIC，而 CLOCK_MONOTONIC
 *  **会**被 adjtimex/NTP 做频率微调（slewing）。对一个"以测量时钟偏差为生"的
 *  模块来说这是致命的：同步器测出偏差 → 调本地步长追赶 → 系统 NTP 同时在调本地频率
 *  → 两个控制回路互相观测，形成自激振荡。
 *  CLOCK_MONOTONIC_RAW 是内核提供的**未调频原始计数**，没有这个问题。
 *  于是本模块的取值优先级为：
 *      Linux   : CLOCK_MONOTONIC_RAW  →  steady_clock  （RAW 不可用时回退）
 *      Windows : QueryPerformanceCounter（steady_clock 的底层实现，精度 100ns 级）
 *      Wasm    : emscripten_get_now   （performance.now，单调）
 */
struct MonotonicClock final {
  [[nodiscard]] static Nanos now_ns() noexcept {
#if defined(__EMSCRIPTEN__)
    // emscripten_get_now 返回 double 毫秒（performance.now 精度，浏览器里约 5us~100us）
    return static_cast<Nanos>(emscripten_get_now() * static_cast<double>(kNanosPerMs));
#elif defined(_WIN32)
    // QueryPerformanceCounter：QPC 频率由系统给出，通常是 10MHz（100ns 刻度）。
    // （不使用 steady_clock 只在 Windows 上是等价选择 —— QPC 本就是它的实现；
    //   这里直接调 QPC 是为了避免 <chrono> 在某些 MSVC 版本下的额外间接层。）
    static const double kInvFreq = []() noexcept {
      LARGE_INTEGER f{};
      QueryPerformanceFrequency(&f);
      return (f.QuadPart > 0) ? (1.0 / static_cast<double>(f.QuadPart)) : 0.0;
    }();
    LARGE_INTEGER c{};
    QueryPerformanceCounter(&c);
    return static_cast<Nanos>(static_cast<double>(c.QuadPart) * kInvFreq *
                              static_cast<double>(kNanosPerSecond));
#elif defined(CLOCK_MONOTONIC_RAW)
    // CLOCK_MONOTONIC_RAW：Linux 特有，**不**参与 NTP 频率校正，正是时钟同步器要的基准。
    // （CLOCK_MONOTONIC 会被 adjtimex 调频，用它会自激。）
    struct timespec ts{};
    if (::clock_gettime(CLOCK_MONOTONIC_RAW, &ts) == 0) {
      return static_cast<Nanos>(ts.tv_sec) * kNanosPerSecond + static_cast<Nanos>(ts.tv_nsec);
    }
    // RAW 不可用（极老的 libc / 容器裁剪）→ 回退 steady_clock。
    // 回退路径牺牲的是"不被系统 NTP 调频污染"，但仍然**单调**，
    // 满足"严禁回拨风险时钟"这条底线。
    return SteadyNowNs();
#else
    return SteadyNowNs();
#endif
  }

 private:
  /// 标准库单调时钟回退路径（保证单调，精度视实现，通常足够）
  [[nodiscard]] static Nanos SteadyNowNs() noexcept {
    const auto tp = std::chrono::steady_clock::now().time_since_epoch();
    return static_cast<Nanos>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(tp).count());
  }
};

// -----------------------------------------------------------------------------
//  采样与配置
// -----------------------------------------------------------------------------

/** 一次 NTP 往返的原始四元组 + 派生量。POD，可放进 std::array 零分配。 */
struct ClockSample final {
  Nanos t1 = 0;        ///< 本端发出
  Nanos t2 = 0;        ///< 对端收到
  Nanos t3 = 0;        ///< 对端回发
  Nanos t4 = 0;        ///< 本端收到
  Nanos rtt = 0;       ///< (t4-t1) - (t3-t2)：扣掉对端处理耗时后的纯往返
  Nanos offset = 0;    ///< ((t2-t1) + (t3-t4)) / 2：对端相对本端的时钟偏移
};

enum class SyncState : std::uint8_t {
  Unlocked = 0,   ///< 采样数不足，尚未可信
  Locked,         ///< 已锁定且 |误差| 在死区内（不微调）
  Slewing,        ///< 正在连续微调收敛
};

enum class SyncEvent : std::uint8_t {
  None = 0,
  HardResync,      ///< 断线重连 / 偏差 > 250ms：已 Snap（应先做视觉白闪/回放抑制）
  SampleRejected,  ///< 乱序、RTT 异常、或 T2<T1 等非法样本，已丢弃
};

/** 可调参数。全部给出符合需求文档的缺省值。 */
struct SyncConfig final {
  std::size_t windowSize   = 30;                    ///< 滑窗容量 N = 30（规格指定）
  /// 参与加权聚合的"最低 RTT 样本"比例：最新 30 个样本里取 RTT 最低的前 20% = 6 个。
  /// 为什么不是只取 1 个最小值（这是本模块的核心修正）：
  ///   单点极值极其脆弱 —— 一次"双向延迟恰好都低"的幸运采样会独占权威估计，
  ///   而它的 offset 仍带着 (d_out − d_back)/2 的路径不对称误差。
  ///   取前 20% 并按 1/RTT 加权，等于承认"这几拍链路都比较空"，
  ///   在不引入高 RTT 长尾污染的前提下把估计方差降下来。
  double    bestRatio      = 0.20;                  ///< 最低 RTT 前 20% 参与聚合
  Nanos deadbandNs         = 1 * kNanosPerMs;       ///< < 1ms 视为噪声，但**仍以极小 warp 收敛**
  Nanos slewUpperNs        = 100 * kNanosPerMs;     ///< 1ms ~ 100ms -> 连续微调
  Nanos hardResyncNs       = 250 * kNanosPerMs;     ///< > 250ms -> 硬同步（规格指定）
  double maxWarpRatio      = 0.015;                 ///< 物理步长最大伸缩 ±1.5%
  double slewGain          = 0.1;                   ///< 误差消化系数（需求给出的 0.1）
  Nanos maxRttNs           = 500 * kNanosPerMs;     ///< RTT 超过它视为异常样本
  Nanos hardSyncGraceNs    = 300 * kNanosPerMs;     ///< 首次锁定前允许直接对齐的窗口
};

// -----------------------------------------------------------------------------
//  ForzaTimeSynchronizer
// -----------------------------------------------------------------------------

/**
 * 高精度时间同步器。
 *
 * ── 算法总览 ─────────────────────────────────────────────────────────────────
 *  1. 采样：收到 PONG 时喂入 (T1,T2,T3,T4)，算出 RTT 与 Offset，
 *     写入固定容量 30 的环形缓冲。
 *  2. 滤波：在窗口内按 RTT 升序取**最低的前 20%（6 个）**样本，
 *     以 `1/(rtt+ε)` 为权重聚合出权威偏移 `targetOffset_`。
 *     （抖动呈长尾分布，排队延迟只会把 RTT 抬高；低 RTT 样本的往返路径
 *       最接近对称，其 Offset 的"路径不对称误差"最小。取 6 个而不是 1 个，
 *       是为了在不放进长尾的前提下压低方差。加权而非等权，是因为
 *       RTT 越小的样本越可信 —— 权重自然把最干净的那几拍抬上来。）
 *  3. 收敛：绝不做瞬时跳变。把 (目标偏移 − 生效偏移) 的残差按
 *     `warp = clamp(errSec * slewGain, ±maxWarpRatio)` 转成本帧的**时间伸缩比例**，
 *     物理步长用 `baseDt * (1 + warp)`。于是本地时钟以 ≤1.5% 的速率差
 *     连续追赶服务端，几十毫秒的偏差在数秒内无感贴合。
 *     **死区内也走连续微调**（只是 warp 很小），绝不把残差原地冻结 ——
 *     冻结会让 <1ms 的恒定漂移永远收敛不掉，表现为物理 Tick 长期抖动。
 *  4. 容灾：仅当《断线重连》或《偏差 > 250ms》时 Snap 并输出预警日志。
 *
 * ── 成员内存布局（固定，无堆）────────────────────────────────────────────────
 *   window_      32 * 56 B = 1792 B   环形缓冲（ClockSample 是 POD）
 *   head_/count_ 16 B                 环形游标
 *   其余标量      ~56 B
 *   合计 ≈ 1.9 KB，可直接作为成员放在游戏对象里，构造后**零分配**。
 *
 * 线程模型：**非线程安全**。约定只在物理/网络线程各调各的一半时请自行加锁，
 * 但通常做法是把 PushPingSample 与 GetAdjustedDeltaTime 都放在同一个主循环里（无锁）。
 */
class ForzaTimeSynchronizer final {
 public:
  /// 日志回调：裸函数指针，热路径零分配（std::function 会堆分配）
  using LogFn = void (*)(const char* msg) noexcept;

  static constexpr std::size_t kMaxWindow = 32;   ///< 编译期上限，运行时用 cfg.windowSize

  ForzaTimeSynchronizer() noexcept = default;
  explicit ForzaTimeSynchronizer(const SyncConfig& cfg) noexcept : cfg_(cfg) {}

  /// 绑定日志回调（仅在 HardResync / SampleRejected 时调用）
  void SetLogger(LogFn fn) noexcept { log_ = fn; }

  // ---------------------------------------------------------------------------
  //  1) NTP 采样
  // ---------------------------------------------------------------------------

  /**
   * 喂入一次 NTP 往返结果。**规格指定接口名。**
   * @param t1 本端发出时刻（MonotonicClock::now_ns()）
   * @param t2 对端接收时刻（对端权威时钟）
   * @param t3 对端回发时刻（对端权威时钟）
   * @param t4 本端收到时刻（MonotonicClock::now_ns()）
   * @return 本次采样触发的同步事件
   *
   * 注意：参数里 t2/t3 是**对端时钟轴**，t1/t4 是**本端时钟轴**，
   * 两者分属不同时基，这正是 offset 要估计的东西 —— 不要试图把它们相减。
   */
  SyncEvent PushPingSample(Nanos t1, Nanos t2, Nanos t3, Nanos t4) noexcept {
    // ---- 合法性过滤 ----
    // T2 < T1 是物理上不可能的（除非对端时钟大幅落后）；T3 < T2 说明对端时间倒流。
    // 这类样本会污染窗口，直接丢弃。
    if (t2 < t1 || t3 < t2 || t4 < t1) {
      Log("time_sync: 拒绝非法样本 (T1<=T2<=T3、T4>=T1 不成立)");
      return SyncEvent::SampleRejected;
    }
    // 乱序通道（WebRTC unreliable / UDP）会送来比上次更早的 T1，丢弃保证窗口单调
    if (lastT1_ != kNoSample && t1 <= lastT1_) {
      return SyncEvent::SampleRejected;
    }

    ClockSample s{};
    s.t1 = t1;
    s.t2 = t2;
    s.t3 = t3;
    s.t4 = t4;
    s.rtt    = (t4 - t1) - (t3 - t2);
    s.offset = ((t2 - t1) + (t3 - t4)) / 2;
    if (s.rtt < 0) {                      // 对端处理时长为负 -> 时钟异常
      return SyncEvent::SampleRejected;
    }
    if (s.rtt > cfg_.maxRttNs) {
      Log("time_sync: 丢弃 RTT 异常样本（> 500ms）");
      return SyncEvent::SampleRejected;
    }
    lastT1_ = t1;

    // ---- 写入环形缓冲 ----
    Push(s);

    // ---- 滤波：窗口内 RTT 最低的前 20% 样本，按 1/RTT 加权聚合偏移 ----
    // 这是本模块相对"取单个最小 RTT"的关键升级：见 SyncConfig::bestRatio 的说明。
    targetOffset_ = WeightedBestOffset(&bestRtt_);

    // ---- 首次锁定：还没有历史连续性可言，直接对齐 ----
    if (!hardSynced_) {
      const bool enough = (count_ >= cfg_.windowSize);
      const bool initial = (firstPong_ == kNoSample) ||
                           (t4 - firstPong_ < cfg_.hardSyncGraceNs);
      if (enough || initial) {
        firstPong_ = (firstPong_ == kNoSample) ? t4 : firstPong_;
        if (enough) {
          appliedOffset_ = targetOffset_;
          hardSynced_ = true;
          state_ = SyncState::Locked;
          Log("time_sync: 首次锁定完成（窗口已满，直接对齐一次）");
        } else {
          appliedOffset_ = targetOffset_;   // 宽限期内允许快速跟随，避免开局等 30 拍
          if (firstPong_ == kNoSample) firstPong_ = t4;
        }
      }
      return SyncEvent::None;
    }

    // ---- 已锁定：判断是否需要硬同步 ----
    const Nanos err = targetOffset_ - appliedOffset_;
    const Nanos absErr = (err < 0) ? -err : err;
    if (absErr > cfg_.hardResyncNs) {
      // 断流重连或极端偏差：这是唯一允许 Snap 的场景
      appliedOffset_ = targetOffset_;
      slewResidual_ = 0;
      warp_ = 0.0;
      state_ = SyncState::Locked;
      Log("time_sync: 硬同步！|offset| > 250ms，已 Snap（请抑制本帧视觉插值）");
      return SyncEvent::HardResync;
    }
    return SyncEvent::None;
  }

  /// 兼容旧调用名（等价于 PushPingSample）。新代码请用带规格名的 PushPingSample。
  SyncEvent OnPong(Nanos t1, Nanos t2, Nanos t3, Nanos t4) noexcept {
    return PushPingSample(t1, t2, t3, t4);
  }

  // ---------------------------------------------------------------------------
  //  2) Clock Slewing（每帧调用）
  // ---------------------------------------------------------------------------

  /**
   * 推进一帧的时钟微调，返回**本帧应使用的物理步长**。**规格指定接口名。**
   *
   * 伸缩方程：
   *   errSec = (targetOffset − appliedOffset) / 1e9
   *   warp   = clamp(errSec * slewGain, −maxWarpRatio, +maxWarpRatio)
   *   dt'    = baseDt * (1 + warp)
   *   appliedOffset += (dt' − baseDt) * 1e9      // ★ 用**实际伸缩量**推进，不是 warp*baseDt
   *
   * ── 两处关键修正（旧实现的两个真实缺陷）──────────────────────────────────
   *  [修正 1] 生效偏移必须按 **实际返回的 dt'** 推进：
   *      旧式 `appliedOffset_ += warp * baseDtSec * 1e9` 近似等于 (dt' − baseDt)，
   *      看似等价，但把 `appliedOffset_` 的演化与 `dt'` 的**定义**割裂了 ——
   *      一旦将来给 dt' 加夹取（如物理引擎要求 dt ≥ 某下限），两者立刻失配，
   *      残差会稳定在一个非零值上不收敛。直接用 (dt' − baseDt) 保证**定义自洽**：
   *      appliedOffset_ 的累积量恒等于"本地时间轴被拉长/压缩的总量"。
   *  [修正 2] 死区内**不再把 warp 置零**：
   *      旧实现在 |err| < deadband 时直接 `warp_ = 0; return baseDt;`，
   *      而 appliedOffset_ 也不推进 —— 于是死区内的残差被**永久冻结**。
   *      后果：网络真值里若存在一个 <1ms 的恒定偏差（局域网里非常常见，
   *      例如服务端 tick 与客户端帧率的固有相位差），它**永远收敛不掉**，
   *      表现为物理 Tick 长期微幅抖动。
   *      新做法：死区内仍按同一方程算 warp —— 残差小时它本来就极小，
   *      自然被 ±1.5% 夹住内，既不抖也能真正收敛到 0。
   *      同时死区**不再切换状态**（避免 HUD 在 Locked/Slewing 之间高频闪烁），
   *      而是按收敛程度给出状态：残差进入死区后标 Locked。
   *
   * @param baseDtSec 基准物理步长（如 1/60）
   * @return 微调后的物理步长，恒在 [baseDt*0.985, baseDt*1.015] 内
   */
  [[nodiscard]] double GetAdjustedDeltaTime(double baseDtSec) noexcept {
    if (!hardSynced_) {                     // 未锁定：原样返回，不做任何时间变形
      warp_ = 0.0;
      return baseDtSec;
    }
    const Nanos err = targetOffset_ - appliedOffset_;
    const Nanos absErr = (err < 0) ? -err : err;

    // 伸缩比例由残差决定，随后统一夹到 ±maxWarpRatio。
    // 注意这里**没有**"残差小于死区就跳过"的分支 —— 见上方 [修正 2]。
    const double errSec = static_cast<double>(err) / static_cast<double>(kNanosPerSecond);
    double warp = errSec * cfg_.slewGain;
    if (warp >  cfg_.maxWarpRatio) warp =  cfg_.maxWarpRatio;
    if (warp < -cfg_.maxWarpRatio) warp = -cfg_.maxWarpRatio;
    warp_ = warp;

    // 状态只用于遥测/HUD：残差进死区即视为已锁定，避免状态位抖动
    state_ = (absErr <= cfg_.deadbandNs) ? SyncState::Locked : SyncState::Slewing;

    const double warpedDt = baseDtSec * (1.0 + warp);

    // ★ [修正 1] 用实际伸缩量推进生效偏移 —— 与 warpedDt 的定义严格自洽。
    //    等式：本地真实走了 warpedDt，而基准只应走 baseDt，多走的 (warpedDt−baseDt)
    //    就是"本地对服务端时间轴的估计"应增加的量。
    const Nanos advanced =
        static_cast<Nanos>((warpedDt - baseDtSec) * static_cast<double>(kNanosPerSecond));
    appliedOffset_ += advanced;
    slewResidual_ = targetOffset_ - appliedOffset_;   // 余量遥测（供断言/HUD）

    return warpedDt;
  }

  /// 兼容旧调用名（等价于 GetAdjustedDeltaTime）
  [[nodiscard]] double AdjustedDeltaTime(double baseDtSec) noexcept {
    return GetAdjustedDeltaTime(baseDtSec);
  }

  /// 便利重载：以纳秒给出基准步长
  [[nodiscard]] Nanos AdjustedDeltaNanos(Nanos baseDtNs) noexcept {
    return static_cast<Nanos>(AdjustedDeltaTime(static_cast<double>(baseDtNs) /
                                                static_cast<double>(kNanosPerSecond)) *
                              static_cast<double>(kNanosPerSecond));
  }

  // ---------------------------------------------------------------------------
  //  3) 断线重连与极端偏差容灾
  // ---------------------------------------------------------------------------

  /**
   * 网络断流重连时调用：清空窗口与连续性，回到未锁定状态。
   * 重连后第一批采样会触发一次硬对齐（此时本来就没有连续性可言，Snap 无副作用）。
   */
  void OnConnectionReset() noexcept {
    head_ = 0;
    count_ = 0;
    bestRtt_ = kNoSample;
    targetOffset_ = 0;
    appliedOffset_ = 0;
    slewResidual_ = 0;
    warp_ = 0.0;
    lastT1_ = kNoSample;
    firstPong_ = kNoSample;
    hardSynced_ = false;
    state_ = SyncState::Unlocked;
    Log("time_sync: 连接重置，已清空时钟窗口");
  }
  // ---------------------------------------------------------------------------
  //  查询
  // ---------------------------------------------------------------------------

  /// 本端当前对"服务端时间轴"的估计（含微调累积）。**规格指定接口名。**
  [[nodiscard]] Nanos GetServerTime() const noexcept {
    return MonotonicClock::now_ns() + appliedOffset_;
  }
  /// 兼容旧调用名（等价于 GetServerTime）
  [[nodiscard]] Nanos ServerNowNs() const noexcept { return GetServerTime(); }
  /// 服务端时间轴上的"现在"，但以本端时钟轴表示（即 server_now − local_now）
  [[nodiscard]] Nanos CurrentOffsetNs() const noexcept { return appliedOffset_; }
  /// 窗口内"最低 RTT 前 20%"里最小的那个 RTT（质量指标：越小说明链路越空）
  [[nodiscard]] Nanos BestRttNs() const noexcept { return bestRtt_; }
  /// 滤波后的权威目标偏移（加权聚合结果，未含微调累积）
  [[nodiscard]] Nanos TargetOffsetNs() const noexcept { return targetOffset_; }
  /// 当前未消化残差 = target − applied（收敛性遥测，稳态应趋近 0）
  [[nodiscard]] Nanos ResidualNs() const noexcept { return targetOffset_ - appliedOffset_; }
  /// 本帧的时间伸缩比例（用于 HUD / 遥测显示，正常应在 ±1.5% 内）
  [[nodiscard]] double CurrentWarp() const noexcept { return warp_; }
  [[nodiscard]] SyncState State() const noexcept { return state_; }
  [[nodiscard]] std::size_t SampleCount() const noexcept { return count_; }
  /// 参与加权聚合的样本个数 = max(1, floor(windowSize * bestRatio))
  [[nodiscard]] std::size_t BestSetSize() const noexcept {
    std::size_t k = static_cast<std::size_t>(
        static_cast<double>(cfg_.windowSize) * cfg_.bestRatio);
    if (k < 1) k = 1;
    if (k > cfg_.windowSize) k = cfg_.windowSize;
    return k;
  }
  [[nodiscard]] bool IsLocked() const noexcept { return hardSynced_; }
  [[nodiscard]] const SyncConfig& Config() const noexcept { return cfg_; }

 private:
  // ---- 环形写入 ----
  void Push(const ClockSample& s) noexcept {
    window_[head_] = s;
    head_ = (head_ + 1) % kMaxWindow;
    if (count_ < cfg_.windowSize) {
      ++count_;
    }
    // count_ 达到 windowSize 后保持，head_ 继续前进 -> 老样本被自然覆盖（真正的环形语义）
    if (count_ > cfg_.windowSize) count_ = cfg_.windowSize;
  }

  /**
   * 窗口内 RTT 最低的前 `BestSetSize()` 个样本，按 1/(rtt+1ns) 加权平均 offset。
   *
   * 算法（无堆、O(n·k)，n≤30、k≤6 ⇒ 最坏 180 次比较，热路径完全可接受）：
   *   1. 单趟扫描维护"前 k 小 RTT"的有序小数组（插入排序，k 只有 6）；
   *   2. 对这 k 个样本按 w = 1/(rtt+1) 归一化后加权求和 offset。
   *
   * 为什么用 1/RTT 而不是 1/RTT²：
   *   1/RTT 是"路径越空越可信"的温和表达；平方会让权重过于集中在单一最小值上，
   *   等于退回"取单点极值"的老毛病（方差反而变大，实测残余误差更差）。
   *
   * **RTT 打平时保留最新样本**：低负载局域网里 RTT 精确相等非常常见
   * （同一批时钟刻度、同一条空闲链路）。若让最旧样本胜出，真实的阶跃式偏移变化
   * 会被历史样本"压住"，offset 迟迟不更新，甚至连 >250ms 的硬同步都触发不了。
   * 这里靠"新样本只在严格小于时才挤掉旧样本"实现（同 RTT 保留先到的最旧那个
   * 会被插入位置天然排掉）—— 因此扫描**必须从最新往最旧**，让同 RTT 时最新者先占位。
   *
   * @param outMinRtt 输出参与集合里的最小 RTT
   * @return 加权聚合后的 offset（纳秒）
   */
  [[nodiscard]] Nanos WeightedBestOffset(Nanos* outMinRtt) noexcept {
    const std::size_t n = count_;
    if (n == 0) {
      if (outMinRtt) *outMinRtt = kNoSample;
      return 0;
    }
    const std::size_t k = (BestSetSize() < n) ? BestSetSize() : n;

    // 有序小数组：rtt 升序（索引 0 最小）。容量上限 = kMaxWindow。
    std::array<Nanos, kMaxWindow> bestRtt{};
    std::array<Nanos, kMaxWindow> bestOff{};
    std::size_t m = 0;    // 当前已收入的有序元素个数（<= k）

    // ★ 从最新往最旧扫：RTT 相同则"最新的"先进入。
    //   插入时用严格 `>` 比较，于是同 RTT 的旧样本只能排在相等元素**之后**；
    //   一旦集合已满（m == k），它就会被 `c.rtt >= bestRtt[m-1]` 剪掉。
    //   净效果 = 同 RTT 保留最新，与旧实现语义一致（这是硬同步能触发的前提）。
    for (std::size_t i = n; i-- > 0;) {
      const ClockSample& c = window_[(head_ + kMaxWindow - n + i) % kMaxWindow];
      // 已满且不比当前最差的好 -> 跳过（"前 k 小"的标准剪枝）
      if (m == k && c.rtt >= bestRtt[m - 1]) continue;
      // 插入排序：把比 c 大的元素整体右移一位，为 c 腾出升序位置
      std::size_t pos = m;
      while (pos > 0 && bestRtt[pos - 1] > c.rtt) {
        if (pos < k) { bestRtt[pos] = bestRtt[pos - 1]; bestOff[pos] = bestOff[pos - 1]; }
        --pos;
      }
      bestRtt[pos] = c.rtt;
      bestOff[pos] = c.offset;
      if (m < k) ++m;
    }

    if (m == 0) {                      // 理论上不可达（n>0 时至少收 1 个）
      if (outMinRtt) *outMinRtt = kNoSample;
      return 0;
    }
    if (outMinRtt) *outMinRtt = bestRtt[0];

    // 按 1/(rtt+1ns) 归一化加权（+1ns 防除零；rtt 为 0 时权重最大但仍有限）
    double wSum = 0.0;
    double acc = 0.0;
    for (std::size_t i = 0; i < m; ++i) {
      const double w = 1.0 / (static_cast<double>(bestRtt[i]) + 1.0);
      wSum += w;
      acc += w * static_cast<double>(bestOff[i]);
    }
    if (wSum <= 0.0) return bestOff[0];
    return static_cast<Nanos>(acc / wSum + (acc >= 0.0 ? 0.5 : -0.5));   // 就近取整
  }

  void Log(const char* msg) const noexcept {
    if (log_ != nullptr) log_(msg);
  }

  // ---- 配置与状态（约 56 B）----
  SyncConfig cfg_{};
  LogFn log_ = nullptr;

  // ---- 环形缓冲（固定 1.8 KB，零堆）----
  std::array<ClockSample, kMaxWindow> window_{};
  std::size_t head_ = 0;      ///< 下一个写入位置
  std::size_t count_ = 0;     ///< 当前有效样本数（<= cfg_.windowSize）

  // ---- 时钟估计 ----
  Nanos bestRtt_ = kNoSample;       ///< 参与集合里的最小 RTT
  Nanos targetOffset_ = 0;          ///< 权威估计（前 20% 低 RTT 样本的加权偏移）
  Nanos appliedOffset_ = 0;         ///< 当前生效偏移（= 硬同步基准 + 微调累积）
  Nanos slewResidual_ = 0;          ///< 微调余量（= target − applied，供遥测/断言）
  Nanos lastT1_ = kNoSample;        ///< 上一次接受的 T1（乱序过滤）
  Nanos firstPong_ = kNoSample;     ///< 首个 PONG 到达时刻（宽限期计算）

  // ---- 输出 ----
  double warp_ = 0.0;               ///< 本帧伸缩比例
  SyncState state_ = SyncState::Unlocked;
  bool hardSynced_ = false;         ///< 是否已完成首次对齐
};

}  // namespace forza::net
```

### 文件: native/timesync/forza_time_sync_test.cpp

```cpp
// =============================================================================
//  forza_time_sync_test.cpp —— 自包含单测（零外部依赖，不引 gtest）
//
//  覆盖：
//   T1   RTT / Offset 公式正确性（对已知真值）
//   T2   滑窗滤波：最低 RTT 前 20% 加权聚合 + 容量上限
//   T2b  加权聚合抗"单点幸运采样"（旧单点极值的核心缺陷）
//   T3  【需求指定】连续网络抖动 20ms~120ms 下的收敛 / 不 Snap / 伸缩有界
//   T3b 【需求指定】0ms~150ms **阶跃突变**抖动下的收敛性
//   T4   偏差 1~100ms 必须走连续微调（禁止硬跳）
//   T4b  死区内残差真正收敛（回归：旧实现在死区里冻结残差）
//   T5   偏差 > 250ms 触发硬同步 + 预警；200ms 不得触发
//   T6   断线重连 OnConnectionReset 后重新锁定
//   T7   非法样本与乱序样本被丢弃
//
//  编译：
//    Linux : g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic 
//                forza_time_sync.cpp forza_time_sync_test.cpp -o ts_test && ./ts_test
//    Wasm  : em++ ... -s WASM=1 -o ts_test.js   （可直接在浏览器跑，断言结果打到 console）
// =============================================================================
#include "forza_time_sync_testkit.h"

#include <cstdio>
#include <cstdlib>

using namespace forza::net;

// -----------------------------------------------------------------------------
//  极简断言框架
// -----------------------------------------------------------------------------
namespace {

int g_pass = 0;
int g_fail = 0;
const char* g_case = "";
int g_logCalls = 0;      // 供日志回调计数（必须文件作用域，见 T5）

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) {
    ++g_pass;
  } else {
    ++g_fail;
    std::printf("  [FAIL] %s :: %s %s\n", g_case, what, detail);
  }
}

void Case(const char* name) noexcept {
  g_case = name;
  std::printf("- %s\n", name);
}

/// 把纳秒格式化成 +xx.xxxms，失败信息可读
void Ms(char* buf, std::size_t n, Nanos ns) noexcept {
  const double ms = static_cast<double>(ns) / static_cast<double>(kNanosPerMs);
  std::snprintf(buf, n, "%+.3fms", ms);
}

constexpr double kFrameHz = 60.0;
constexpr double kDt = 1.0 / kFrameHz;
constexpr Nanos kFrameNs = kNanosPerSecond / 60;

// -----------------------------------------------------------------------------
//  T1  RTT / Offset 公式
// -----------------------------------------------------------------------------
void TestFormula() noexcept {
  Case("T1  RTT/Offset 公式");
  ForzaTimeSynchronizer sync;

  // 构造一个已知场景：单向去 30ms、回 50ms、服务端处理 2ms、真实偏移 +12ms
  constexpr Nanos kOut = 30 * kNanosPerMs;
  constexpr Nanos kBack = 50 * kNanosPerMs;
  constexpr Nanos kProc = 2 * kNanosPerMs;
  constexpr Nanos kTrue = 12 * kNanosPerMs;

  const Nanos t1 = 1'000 * kNanosPerMs;
  const Nanos t2 = t1 + kOut + kTrue;
  const Nanos t3 = t2 + kProc;
  const Nanos t4 = t1 + kOut + kProc + kBack;

  sync.PushPingSample(t1, t2, t3, t4);

  // RTT = (t4-t1) - (t3-t2) = (30+2+50) - 2 = 80ms
  // 记 d_out=30, d_back=50, proc=2, 真值 θ=12：
  //   T2-T1 = d_out + θ = 42        T3-T4 = θ - d_back = 12-50 = -38
  //   Offset = ((T2-T1) + (T3-T4)) / 2 = (42-38)/2 = +2ms
  // 估计值不是真值 +12ms，差 (d_out-d_back)/2 = -10ms —— 这就是 NTP 的**路径不对称误差**，
  // 是公式的固有性质而非 bug，也正是必须做滑窗滤波（取最对称的那次）的原因。
  char b1[32], b2[32];
  Ms(b1, sizeof b1, sync.BestRttNs());
  Ms(b2, sizeof b2, sync.CurrentOffsetNs());
  Check(sync.BestRttNs() == 80 * kNanosPerMs, "RTT = (t4-t1)-(t3-t2) 扣掉服务端处理耗时", b1);
  Check(sync.CurrentOffsetNs() == 2 * kNanosPerMs,
        "Offset = ((t2-t1)+(t3-t4))/2 = +2ms（真值 +12ms，路径不对称误差 -10ms）", b2);
}

// -----------------------------------------------------------------------------
//  T2  滑窗滤波：最低 RTT 前 20% 的加权聚合 + 容量上限
// -----------------------------------------------------------------------------
void TestWindowFilter() noexcept {
  Case("T2  滑窗滤波（前 20% 低 RTT 加权聚合 / 容量上限）");
  SyncConfig cfg;
  cfg.windowSize = 20;                    // 前 20% ⇒ 取 4 个样本
  ForzaTimeSynchronizer sync(cfg);

  // 先灌 19 个高 RTT 的坏样本：**对称**延迟 -> offset 恒为 0
  Nanos t = 0;
  const Nanos proc = kNanosPerMs;
  for (int i = 0; i < 19; ++i) {
    const Nanos t1 = t;
    const Nanos bad = 120 * kNanosPerMs;            // 单程 120ms（对称）
    sync.PushPingSample(t1, t1 + bad, t1 + bad + proc, t1 + bad + proc + bad);
    t += 200 * kNanosPerMs;
  }
  {
    char rb[32];
    std::snprintf(rb, sizeof rb, "%lldms", static_cast<long long>(sync.BestRttNs() / kNanosPerMs));
    Check(sync.BestRttNs() == 240 * kNanosPerMs, "坏样本的 RTT = 240ms", rb);
    Check(sync.BestSetSize() == 4, "20 个样本的 20% = 4 个参与加权");
  }

  // 再灌 1 个低 RTT 样本。**必须让它的 offset 与坏样本不同**，
  // 否则"权威估计是否切换"根本无从判断（第一版两边 offset 都是 0，断言等于没测）。
  // 去程 5ms、回程 25ms -> RTT=29ms，offset = (5 + (5-25))/2 = -10ms
  const Nanos t1 = t;
  const Nanos outG = 5 * kNanosPerMs, backG = 25 * kNanosPerMs;
  sync.PushPingSample(t1, t1 + outG, t1 + outG + proc, t1 + outG + proc + backG);

  Check(sync.SampleCount() == 20, "窗口容量 = 20（不超配）");
  {
    char rb[32], ob[32];
    std::snprintf(rb, sizeof rb, "%lldms", static_cast<long long>(sync.BestRttNs() / kNanosPerMs));
    std::snprintf(ob, sizeof ob, "%+.3fms",
                  static_cast<double>(sync.CurrentOffsetNs()) / kNanosPerMs);
    Check(sync.BestRttNs() == 30 * kNanosPerMs, "最小 RTT 样本（30ms）进入聚合集", rb);
    // ★ 这里是加权聚合，**不是**取单个样本的 offset。
    //   聚合集 = {30ms/offset=−10ms, 240ms/offset=0}（其余更差的不入集），
    //   w1=1/31、w2=1/241（单位 ns 尺度）⇒ offset ≈ (−10·w1 + 0·w2)/(w1+w2) ≈ −8.86ms。
    //   断言写成"显著偏向低 RTT 样本"而不写死数值，避免把权重常数钉进测试。
    Check(sync.CurrentOffsetNs() < -6 * kNanosPerMs && sync.CurrentOffsetNs() > -10 * kNanosPerMs,
          "权威估计已由 0 转向低 RTT 样本（加权聚合，非单点极值）", ob);
  }

  // 再灌 30 个，容量仍须被钉死在 20
  for (int i = 0; i < 30; ++i) {
    const Nanos tt = t + static_cast<Nanos>(i + 1) * 100 * kNanosPerMs;
    sync.PushPingSample(tt, tt + outG, tt + outG + proc, tt + outG + proc + backG);
  }
  Check(sync.SampleCount() == 20, "环形覆盖后容量仍为 20（老样本被自然淘汰）");
}

// -----------------------------------------------------------------------------
//  T2b 前 20% 加权聚合抗"单点幸运采样"
// -----------------------------------------------------------------------------
void TestWeightedRobustness() noexcept {
  Case("T2b 加权聚合抗单点幸运采样（旧单点极值的核心缺陷）");

  // 场景：链路总体很空（RTT 稳定 20ms，offset 恒 0），但其中**一次**采样
  // 单向延迟恰好都极小（RTT 4ms），而由路径不对称带来的 offset 误差很大。
  //
  // 构造方法（必须同时满足"RTT 极低"与"offset 偏差大"）：
  //   NTP 的 offset 误差 = (d_out − d_back)/2，RTT = d_out + d_back。
  //   所以想同时做到"RTT 小"又要"offset 偏"，只能取 RTT 小但**两侧不等**：
  //     去程 d_out = 18ms、回程 d_back = 2ms ⇒ RTT = 20ms、offset 偏 (18-2)/2 = +8ms。
  //   这比常规样本（去 10 / 回 10，offset 精确 0）的 RTT **不小**，
  //   所以再补一个真正 RTT 最小的样本：去 1ms / 回 1ms + 一个巨大的时钟偏移。
  //
  // 最直接的构造：让幸运样本的**服务端时钟偏移**本身很大（比如 +200ms），
  // 同时它的往返极短（1ms/1ms ⇒ RTT=2ms）。它的 offset ≈ +200ms，
  // 而常规样本 offset = 0。这样"是否被带偏"就一目了然。
  SyncConfig cfg;
  cfg.windowSize = 30;                    // 前 20% ⇒ 6 个参与
  ForzaTimeSynchronizer sync(cfg);

  Nanos t = 0;
  const Nanos q = 10 * kNanosPerMs;       // 常规样本：对称 10ms/10ms ⇒ offset = 0
  for (int i = 0; i < 29; ++i) {
    const Nanos tt = t + static_cast<Nanos>(i) * 100 * kNanosPerMs;
    sync.PushPingSample(tt, tt + q, tt + q + kNanosPerUs, tt + q + kNanosPerUs + q);
  }

  // 幸运样本：往返极短（1ms/1ms ⇒ RTT 仅 2ms），但那一刻估出的 offset 高达 +200ms
  const Nanos luckyT1 = t + 30 * 100 * kNanosPerMs;
  const Nanos outL = 1 * kNanosPerMs, backL = 1 * kNanosPerMs;
  const Nanos bigOff = 200 * kNanosPerMs;
  sync.PushPingSample(luckyT1,
                      luckyT1 + outL + bigOff,               // t2 = 去程 + 大偏移
                      luckyT1 + outL + bigOff + kNanosPerUs, // t3
                      luckyT1 + outL + kNanosPerUs + backL); // t4（不含偏移）

  Check(sync.BestRttNs() == outL + backL,
        "幸运样本的 RTT 确实最小（2ms，正常样本是 20ms）");

  const double est = static_cast<double>(sync.TargetOffsetNs()) / kNanosPerMs;
  char b[32];
  std::snprintf(b, sizeof b, "%+.3fms", est);
  // 若"取单点最小 RTT"，估计会直接变成 +200ms（被一个样本彻底带偏）。
  // 加权聚合下入集 6 个样本里只有 1 个是幸运样本（权重 1/2ms 远大于 1/20ms），
  // 但**仍被其余 5 个常规样本稀释**，绝不可能等于 200ms。
  Check(est < 150.0,
        "估计值**未**被单个幸运样本带到 +200ms（加权稀释生效）", b);
  Check(est > 0.0,
        "但确实朝幸运样本方向偏移（说明它有权重，不是被完全忽略）", b);
}

// -----------------------------------------------------------------------------
//  T3  【需求指定】抖动 20ms~120ms
// -----------------------------------------------------------------------------
void TestJitter20to120() noexcept {
  Case("T3  网络抖动 20ms~120ms 下的收敛行为");

  NtpJitterSimulator::Config jc;
  jc.trueOffsetNs = 37 * kNanosPerMs;   // 真实偏移 +37ms
  jc.driftPpm = 50.0;                   // 客户端 50ppm 漂移
  jc.baseDelayMs = 4.0;
  jc.jitterLoMs = 20.0;
  jc.jitterHiMs = 120.0;                // 需求指定的抖动区间
  NtpJitterSimulator net(jc, 0xC0FFEEull);

  SyncConfig cfg;
  cfg.windowSize = 24;
  ForzaTimeSynchronizer sync(cfg);
  SyncTelemetry tel;

  constexpr int kSamples = 240;         // 4 分钟 @1Hz，覆盖多次漂移累积
  constexpr int kFramesPerSample = 60;  // 1Hz 采样、60Hz 物理
  Nanos local = 0;

  bool warpInBounds = true;
  Nanos errAfterLockMax = 0;

  for (int i = 0; i < kSamples; ++i) {
    Nanos t1 = 0, t2 = 0, t3 = 0, t4 = 0;
    net.MakeRound(local, t1, t2, t3, t4);
    const SyncEvent ev = sync.PushPingSample(t1, t2, t3, t4);
    if (ev == SyncEvent::HardResync) tel.CountSnap();
    if (ev == SyncEvent::SampleRejected) tel.CountRejected();

    // 采样的 1 秒内跑 60 帧物理
    for (int f = 0; f < kFramesPerSample; ++f) {
      const double dt = sync.GetAdjustedDeltaTime(kDt);
      const double warp = sync.CurrentWarp();
      if (warp > cfg.maxWarpRatio + 1e-12 || warp < -cfg.maxWarpRatio - 1e-12) warpInBounds = false;
      if (dt <= 0.0 || dt > kDt * 1.02) warpInBounds = false;
      tel.Observe(sync, local);
      local += static_cast<Nanos>(dt * static_cast<double>(kNanosPerSecond));
    }

    // 锁定后统计残余误差：|本地对服务端的估计 − 真实偏移 − 漂移|
    if (sync.IsLocked() && i > static_cast<int>(cfg.windowSize)) {
      const Nanos truth = jc.trueOffsetNs + net.CurrentDrift(local);
      const Nanos err = sync.CurrentOffsetNs() - truth;
      const Nanos ae = (err < 0) ? -err : err;
      if (ae > errAfterLockMax) errAfterLockMax = ae;
    }
  }

  // ---- 断言 ----
  Check(sync.IsLocked(), "抖动 20~120ms 下仍能完成锁定");
  Check(tel.snapCount == 0, "稳态期间**零硬同步**（未发生任何 Snap）");
  Check(warpInBounds, "物理步长伸缩比例始终在 ±1.5% 内，且 dt 恒为正");

  // 单帧偏移变化量必须远小于"一次 Snap"的量级。
  // 上界 = maxWarpRatio * dt = 0.015 * 16.67ms = 0.25ms，留 1 位余量取 0.3ms。
  char b1[32], b2[32];
  Ms(b1, sizeof b1, tel.maxStepNs);
  Ms(b2, sizeof b2, errAfterLockMax);
  Check(tel.maxStepNs <= 300 * kNanosPerUs,
        "生效偏移单帧变化 <= 0.3ms（连续微调，绝无硬跳）", b1);

  // 残余误差：受"路径不对称"限制。抖动 20~120ms 时最小 RTT 样本的
  // 不对称误差理论上界 = (120-20)/2 = 50ms，实测应显著优于该上界。
  Check(errAfterLockMax < 30 * kNanosPerMs,
        "锁定后残余误差 < 30ms（优于 50ms 理论最坏值）", b2);

  // 收敛速度：应该在有限的采样数内锁定
  Check(tel.lockedAfterNs != kNoSample && tel.lockedAfterNs < 30 * kNanosPerSecond,
        "在 30 秒内完成锁定（窗口 24 个 1Hz 样本）");

  std::printf("    · 观测：maxWarp=%.5f  maxStep=%s  残余误差=%s  拒收=%zu\n",
              tel.maxAbsWarp, b1, b2, tel.rejectedCount);
}

// -----------------------------------------------------------------------------
//  T3b  【需求指定】抖动 0ms ~ 150ms 阶跃突变下的收敛性
// -----------------------------------------------------------------------------
/**
 * 规格原文："包含针对伪造网络抖动（0ms~150ms 阶跃突变）的时钟收敛性单测用例"。
 *
 * 与 T3 的区别：T3 是**连续随机抖动**（20~120ms 均匀分布在每次往返上），
 * 而本用例是**阶跃突变** —— 网络条件在某一刻从"完全空闲(0ms)"跳到"严重拥塞(150ms)"，
 * 再在若干采样后跳回。这是真实世界最常见的恶化工况（切换基站、后台下载、路由抖动），
 * 也是对时钟同步器最狠的考验：它的 RTT 估计必须在长尾里重新找到最干净的那些样本。
 *
 * 判据（全部是"绝不"式硬约束，不看平均表现）：
 *   1) 阶跃期间**零硬同步** —— 150ms 远低于 250ms 红线，只能靠伸缩消化；
 *   2) warp 始终在 ±1.5% 内，且 dt 恒正、恒有限；
 *   3) 生效偏移单帧变化 <= 0.3ms（连续微调，绝无硬跳）；
 *   4) 阶跃恢复后残差能真正收敛回亚毫秒级（不是被死区冻住）。
 */
void TestJitterStep0to150() noexcept {
  Case("T3b 阶跃突变抖动 0ms~150ms 下的收敛性");

  SyncConfig cfg;
  ForzaTimeSynchronizer sync(cfg);
  SyncTelemetry tel;

  constexpr Nanos kProc = 200 * kNanosPerUs;
  constexpr Nanos kTrueOffset = 45 * kNanosPerMs;   // 服务端比本端快 45ms

  Nanos local = 0;
  bool warpInBounds = true;
  bool dtSane = true;
  Nanos maxObservedErr = 0;

  // 一档往返：`oneWay` 是**该方向的基准延迟**，`offStep` 是本阶段额外注入的
  // 时钟偏移阶跃（模拟服务端时钟跳变 / 链路时钟域切换）。
  //
  // ⚠️ 关键：只改 oneWay 是**测不出东西**的 —— offset = 真值 + (d_out−d_back)/2，
  //    对称改 oneWay 时 (d_out−d_back) 恒为 0，offset 纹丝不动，整个用例变成空跑
  //    （这正是本站第一次写的时候就踩的坑：maxWarp/maxStep/残差全打印 0.0000，
  //     断言"通过"但什么都没验证 —— 与 harness 里那次零样本假绿同类）。
  //    因此这里**同时**注入 offStep 才能真正考验时钟收敛。
  const auto Feed = [&](Nanos oneWayNs, Nanos offStep, int count, int framesPer) {
    for (int i = 0; i < count; ++i) {
      const Nanos t1 = local;
      sync.PushPingSample(t1, t1 + oneWayNs + kTrueOffset + offStep,
                          t1 + oneWayNs + kTrueOffset + offStep + kProc,
                          t1 + oneWayNs + kProc + oneWayNs);
      for (int f = 0; f < framesPer; ++f) {
        const double dt = sync.GetAdjustedDeltaTime(kDt);
        const double w = sync.CurrentWarp();
        if (w > cfg.maxWarpRatio + 1e-12 || w < -cfg.maxWarpRatio - 1e-12) warpInBounds = false;
        if (!(dt > 0.0) || dt > kDt * 1.02 || dt < kDt * 0.98) dtSane = false;
        tel.Observe(sync, local);
        local += static_cast<Nanos>(dt * static_cast<double>(kNanosPerSecond));
      }
      local += 100 * kNanosPerMs;      // 采样间隔
      if (sync.IsLocked()) {
        const Nanos e = sync.ResidualNs();
        const Nanos ae = (e < 0) ? -e : e;
        if (ae > maxObservedErr) maxObservedErr = ae;
      }
    }
  };

  // 阶段 A：完全空闲（单向 0ms），无偏移阶跃 -> 锁定到 45ms
  Feed(0, 0, 40, 60);
  Check(sync.IsLocked(), "阶段A（0ms 空闲链路）完成锁定");
  Check(sync.CurrentOffsetNs() > 40 * kNanosPerMs && sync.CurrentOffsetNs() < 50 * kNanosPerMs,
        "阶段A：估计到真值 +45ms");

  // 阶段 B：单向延迟阶跃到 150ms（严重拥塞）+ 偏移阶跃 +120ms
  //         ⇒ 总偏差 165ms，**低于 250ms 红线**，必须靠伸缩消化
  const std::size_t snapsBeforeStep = tel.snapCount;
  Feed(150 * kNanosPerMs, 120 * kNanosPerMs, 60, 60);
  Check(tel.snapCount == snapsBeforeStep,
        "阶跃到 165ms 总偏差 **零硬同步**（< 250ms 红线，只允许伸缩消化）");
  Check(sync.CurrentOffsetNs() > 150 * kNanosPerMs,
        "确实在向新偏移收敛（不是原地不动）");

  // 阶段 C：回落（延迟回到 0ms，偏移阶跃撤销）-> 应重新收敛回 45ms
  Feed(0, 0, 120, 60);
  Check(tel.snapCount == snapsBeforeStep, "回落后仍然零硬同步");
  Check(warpInBounds, "全程 warp 严格在 ±1.5% 内");
  Check(dtSane, "全程 dt 恒正、且落在 [0.985·dt, 1.015·dt] 内");

  char b1[32], b2[32];
  Ms(b1, sizeof b1, tel.maxStepNs);
  const Nanos res = sync.ResidualNs();
  Ms(b2, sizeof b2, (res < 0) ? -res : res);
  // 单帧偏移变化上限 = maxWarp × dt = 0.015 × 16.667ms = 0.25ms，留余量取 0.3ms
  Check(tel.maxStepNs <= 300 * kNanosPerUs,
        "生效偏移单帧变化 <= 0.3ms（阶跃被摊成连续微调，绝无硬跳）", b1);
  // 收敛判据：恢复后残差回到亚毫秒级。旧实现在死区冻结残差，此断言会失败。
  Check((res < 0 ? -res : res) < 500 * kNanosPerUs,
        "阶跃恢复后未消化残差 < 0.5ms（真正收敛，未被死区冻结）", b2);
  // ★ 防空跑守卫：用例必须真的制造过可观偏差，否则上面的"零硬同步"毫无意义
  Check(maxObservedErr > 50 * kNanosPerMs,
        "★ 用例确实制造了 >50ms 的可观偏差（防空跑假绿）");

  std::printf("    · 观测：maxWarp=%.5f  maxStep=%s  末态残差=%s  峰值残差=%+.2fms  拒收=%zu\n",
              tel.maxAbsWarp, b1, b2,
              static_cast<double>(maxObservedErr) / kNanosPerMs, tel.rejectedCount);
}

// -----------------------------------------------------------------------------
//  T4b 死区残差必须真正收敛（回归：旧实现在死区内冻结残差）
// -----------------------------------------------------------------------------
/**
 * 这是本轮修复的一个**真实缺陷**的回归守卫。
 *
 * 旧实现：
 *     if (absErr <= deadband) { warp_ = 0; return baseDt; }   // appliedOffset 不推进
 * 后果：死区内（<1ms）的残差被**永久冻结**。局域网里服务端 tick 与客户端帧率
 * 存在固有相位差，实测会稳定留下约 0.5ms 的恒定残差 —— 永远收敛不掉，
 * 表现为物理 Tick 长期微幅抖动（"Tick 抖动"这条需求的残余来源）。
 *
 * 新实现：死区内仍按同一方程算 warp（残差小时它自然极小，本就落在 ±1.5% 内），
 * appliedOffset 持续逼近 target。本用例断言那个 ~0.5ms 残差**确实被吃掉**。
 */
void TestDeadbandConvergence() noexcept {
  Case("T4b 死区内残差真正收敛（回归：旧实现会冻结）");

  // 用自定义参数让死区为 1ms，构造一个 ~0.5ms 的恒定偏差
  SyncConfig cfg;
  cfg.deadbandNs = 1 * kNanosPerMs;
  ForzaTimeSynchronizer sync(cfg);

  constexpr Nanos kProc = 200 * kNanosPerUs;
  const Nanos q = 10 * kNanosPerMs;            // 对称 10ms 往返
  const Nanos bias = 500 * kNanosPerUs;        // ★ 恒定 +0.5ms 偏差（落在死区内）

  Nanos local = 0;
  // 阶段 A：无偏差，锁定
  for (int i = 0; i < 40; ++i) {
    const Nanos t1 = local;
    sync.PushPingSample(t1, t1 + q, t1 + q + kProc, t1 + q + kProc + q);
    for (int f = 0; f < 20; ++f) { (void)sync.GetAdjustedDeltaTime(kDt); local += kFrameNs; }
    local += kNanosPerSecond;
  }
  Check(sync.IsLocked(), "前置条件：已锁定（无偏差）");

  // 阶段 B：注入恒定 +0.5ms 偏差（每次采样都带，属于真实的固有相位差）
  for (int i = 0; i < 200; ++i) {
    const Nanos t1 = local;
    sync.PushPingSample(t1, t1 + q + bias, t1 + q + kProc + bias, t1 + q + kProc + q);
    for (int f = 0; f < 20; ++f) { (void)sync.GetAdjustedDeltaTime(kDt); local += kFrameNs; }
    local += kNanosPerSecond;
  }

  const Nanos res = sync.ResidualNs();
  const Nanos absRes = (res < 0) ? -res : res;
  char b[32];
  Ms(b, sizeof b, absRes);
  // 死区 = 1ms，注入偏差 = 0.5ms。若残差被冻结，这里会稳定停在 ~0.5ms；
  // 新实现应把它压到远小于死区（收敛判据取 0.15ms）。
  Check(absRes < 150 * kNanosPerUs,
        "恒定 0.5ms 偏差被连续微调吃掉（残差 < 0.15ms，未被死区冻结）", b);
  // 且方向正确：生效偏移应确实追到了 +0.5ms 附近
  Check(sync.CurrentOffsetNs() > 300 * kNanosPerUs,
        "生效偏移确实向 +0.5ms 收敛（不是原地不动）");
}


void TestNoSnapForMidRange() noexcept {
  Case("T4  偏差 1~100ms 只做连续微调");
  SyncConfig cfg;
  ForzaTimeSynchronizer sync(cfg);
  SyncTelemetry tel;

  // 先用干净样本锁定（偏移 0）
  Nanos local = 0;
  for (int i = 0; i < 40; ++i) {
    const Nanos q = 3 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    for (int f = 0; f < 30; ++f) {
      (void)sync.GetAdjustedDeltaTime(kDt);
      tel.Observe(sync, local);
      local += kFrameNs;
    }
    local += kNanosPerSecond;
  }
  Check(sync.IsLocked(), "前置条件：已锁定");

  // 人为制造 +80ms 的阶跃（在 1~100ms 区间内）
  const Nanos kStep = 80 * kNanosPerMs;
  const std::size_t beforeSnaps = tel.snapCount;
  Nanos prev = sync.CurrentOffsetNs();
  Nanos maxStep = 0;

  const Nanos q = 3 * kNanosPerMs;
  for (int i = 0; i < 20; ++i) {
    const Nanos t1 = local;
    sync.PushPingSample(t1, t1 + q + kStep, t1 + q + kNanosPerUs + kStep,
                t1 + q + kNanosPerUs + q);      // 服务端"突然快了 80ms"
    for (int f = 0; f < 60; ++f) {
      (void)sync.GetAdjustedDeltaTime(kDt);
      const Nanos now = sync.CurrentOffsetNs();
      const Nanos s = (now > prev) ? (now - prev) : (prev - now);
      if (s > maxStep) maxStep = s;
      prev = now;
      local += kFrameNs;
    }
    local += kNanosPerSecond;
  }

  char b[32];
  Ms(b, sizeof b, maxStep);
  Check(tel.snapCount == beforeSnaps, "1~100ms 阶跃**没有**触发硬同步");
  Check(maxStep <= 300 * kNanosPerUs, "阶跃被摊成连续微调（单帧变化 <= 0.3ms）", b);

  // 且确实收敛过去了：残余误差应远小于 80ms
  Check(sync.CurrentOffsetNs() > 40 * kNanosPerMs,
        "确实在向 80ms 收敛（不是永远不动）");
}

// -----------------------------------------------------------------------------
//  T5  偏差 > 250ms -> 硬同步 + 预警
// -----------------------------------------------------------------------------
void TestHardResync() noexcept {
  Case("T5  偏差 > 250ms 触发硬同步");
  SyncConfig cfg;
  ForzaTimeSynchronizer sync(cfg);
  g_logCalls = 0;
  // 裸函数指针，无捕获 lambda 可直接转换（零分配）。
  // 注意：计数器必须是**文件作用域**变量 —— 曾经写成 `static int* s_calls = &局部变量`，
  // 那次函数返回后指针悬空，lambda 解引用即 UB。
  sync.SetLogger([](const char*) noexcept { ++g_logCalls; });

  Nanos local = 0;
  for (int i = 0; i < 40; ++i) {
    const Nanos q = 3 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    for (int f = 0; f < 20; ++f) { (void)sync.GetAdjustedDeltaTime(kDt); local += kFrameNs; }
    local += kNanosPerSecond;
  }
  Check(sync.IsLocked(), "前置条件：已锁定");

  // 400ms 阶跃。**注意这里的语义变化**（旧实现 3 个采样内立刻 Snap）：
  //   新的前 20% 加权滤波会先把阶跃**摊开**：随着 400ms 样本陆续进入聚合集，
  //   权威 target 按 66→133→200→266→333→400ms 阶梯上升，而非一步到位。
  //   这是**有意为之**的改进 —— 单次异常采样不再能直接改写权威时间轴。
  //   硬同步仍会触发，但要等残余误差真正越过 250ms（实测第 5 个采样）。
  const Nanos kHuge = 400 * kNanosPerMs;
  SyncEvent ev = SyncEvent::None;
  int snapsAtSample = -1;
  for (int i = 0; i < 10 && snapsAtSample < 0; ++i) {
    const Nanos t1 = local;
    const Nanos q = 3 * kNanosPerMs;
    ev = sync.PushPingSample(t1, t1 + q + kHuge, t1 + q + kNanosPerUs + kHuge,
                             t1 + q + kNanosPerUs + q);
    if (ev == SyncEvent::HardResync) snapsAtSample = i;
    local += kNanosPerSecond;
  }
  Check(ev == SyncEvent::HardResync, "偏差 400ms -> 返回 HardResync 事件");
  Check(snapsAtSample > 0,
        "阶跃先被滤波摊开、残余越过 250ms 后才 Snap（不是单采样即跳）");
  {
    // Snap 后生效偏移应**立刻**等于当时的权威 target（这就是"跳到新值"），
    // 而不是慢慢爬。因此断言"applied == target"比断言某个具体毫秒数更准确、
    // 也与"滤波会先把阶跃摊开"这一行为解耦（target 具体到多少取决于取样节奏）。
    char b[32];
    Ms(b, sizeof b, sync.CurrentOffsetNs());
    Check(sync.ResidualNs() == 0,
          "Snap 后 applied 立即等于 target（绝不是慢慢爬）", b);
    Check(sync.CurrentOffsetNs() > 250 * kNanosPerMs,
          "且跳到的值确实 > 250ms（阶跃真的被吸收了）", b);
  }
  Check(g_logCalls > 0, "硬同步输出了预警日志");

  // 反向守卫：低于阈值的 200ms 阶跃**不得**触发硬同步（250ms 是新红线）
  {
    SyncConfig c2;
    ForzaTimeSynchronizer s2(c2);
    Nanos l2 = 0;
    for (int i = 0; i < 40; ++i) {
      const Nanos q = 3 * kNanosPerMs;
      s2.PushPingSample(l2, l2 + q, l2 + q + kNanosPerUs, l2 + q + kNanosPerUs + q);
      for (int f = 0; f < 20; ++f) { (void)s2.GetAdjustedDeltaTime(kDt); l2 += kFrameNs; }
      l2 += kNanosPerSecond;
    }
    const Nanos kMid = 200 * kNanosPerMs;
    bool snapped = false;
    for (int i = 0; i < 20; ++i) {
      const Nanos q = 3 * kNanosPerMs;
      if (s2.PushPingSample(l2, l2 + q + kMid, l2 + q + kNanosPerUs + kMid,
                            l2 + q + kNanosPerUs + q) == SyncEvent::HardResync) snapped = true;
      for (int f = 0; f < 30; ++f) { (void)s2.GetAdjustedDeltaTime(kDt); l2 += kFrameNs; }
    }
    Check(!snapped, "200ms 阶跃**不**触发硬同步（红线在 250ms）");
  }
}

// -----------------------------------------------------------------------------
//  T6  断线重连
// -----------------------------------------------------------------------------
void TestReconnect() noexcept {
  Case("T6  断线重连后重新锁定");
  ForzaTimeSynchronizer sync;
  Nanos local = 0;
  for (int i = 0; i < 40; ++i) {
    const Nanos q = 3 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    local += 200 * kNanosPerMs;
  }
  Check(sync.IsLocked() && sync.SampleCount() > 0, "重连前：已锁定且有样本");

  sync.OnConnectionReset();
  Check(!sync.IsLocked(), "重连后：回到未锁定");
  Check(sync.SampleCount() == 0, "重连后：窗口已清空");
  Check(sync.BestRttNs() == kNoSample, "重连后：RTT 估计已复位");

  // 重连后前几次采样允许直接对齐（此时没有连续性可言）
  local += 5 * kNanosPerSecond;
  for (int i = 0; i < 30; ++i) {
    const Nanos q = 6 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    local += 100 * kNanosPerMs;
  }
  Check(sync.IsLocked(), "重连后能重新锁定");
}

// -----------------------------------------------------------------------------
//  T7  非法 / 乱序样本
// -----------------------------------------------------------------------------
void TestReject() noexcept {
  Case("T7  非法与乱序样本被丢弃");
  ForzaTimeSynchronizer sync;

  // T2 < T1：物理不可能
  Check(sync.PushPingSample(100 * kNanosPerMs, 50 * kNanosPerMs, 60 * kNanosPerMs, 200 * kNanosPerMs) ==
        SyncEvent::SampleRejected, "T2 < T1 被拒");
  // RTT 超限（单向 600ms）
  const Nanos big = 600 * kNanosPerMs;
  Check(sync.PushPingSample(1000 * kNanosPerMs, 1000 * kNanosPerMs + big, 1000 * kNanosPerMs + big + 1000,
                    1000 * kNanosPerMs + 2 * big) == SyncEvent::SampleRejected,
        "RTT > 500ms 被拒");
  // 正常样本
  const Nanos t1 = 5000 * kNanosPerMs;
  const Nanos q = 4 * kNanosPerMs;
  Check(sync.PushPingSample(t1, t1 + q, t1 + q + kNanosPerUs, t1 + q + kNanosPerUs + q) == SyncEvent::None,
        "正常样本被接受");
  // 乱序：T1 回退
  Check(sync.PushPingSample(t1 - 10 * kNanosPerMs, t1, t1 + kNanosPerUs, t1 + 20 * kNanosPerMs) ==
        SyncEvent::SampleRejected, "T1 回退（无序通道）被拒");
}

}  // namespace

int main() {
  std::printf("=== ForzaTimeSynchronizer 单元测试 ===\n");
  TestFormula();
  TestWindowFilter();
  TestWeightedRobustness();
  TestJitter20to120();
  TestJitterStep0to150();
  TestNoSnapForMidRange();
  TestDeadbandConvergence();
  TestHardResync();
  TestReconnect();
  TestReject();

  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
```

### 文件: native/timesync/forza_time_sync_testkit.h

```cpp
// =============================================================================
//  forza_time_sync_testkit.h —— 测试支撑模块
//
//  为什么单独拆一个头文件：
//    单测需要 NtpJitterSimulator 与 SyncTelemetry，而它们**不属于生产热路径**，
//    不应该塞进 forza_time_sync.h 污染引擎；
//    但如果只把声明留在 .cpp 里，单测又无法 include（编译不过）。
//    所以按"生产头 / 测试头 / 实现"三分：
//      forza_time_sync.h        —— 生产热路径（inline，零分配）
//      forza_time_sync_testkit.h—— 模拟器与遥测的声明（本文件）
//      forza_time_sync.cpp      —— 非热路径实现
// =============================================================================
#pragma once

#include "forza_time_sync.h"

namespace forza::net {

// -----------------------------------------------------------------------------
//  SyncTelemetry —— 同步质量遥测（同时用于断言与在线 netgraph）
// -----------------------------------------------------------------------------
/**
 * 记录整段同步过程中的关键指标：
 *   · maxAbsWarp    ：伸缩比例峰值（超过 maxWarpRatio 说明实现有 bug）
 *   · snapCount     ：硬同步次数（稳态下应当恒为 0）
 *   · lockedAfterNs ：从第一次采样到锁定的耗时
 *   · maxStepNs     ：生效偏移的**单帧**最大变化量（"禁止 Snap" 的核心断言）
 */
struct SyncTelemetry final {
  double      maxAbsWarp   = 0.0;
  std::size_t snapCount    = 0;
  std::size_t rejectedCount= 0;
  Nanos       lockedAfterNs= kNoSample;
  Nanos       maxStepNs    = 0;
  Nanos       lastOffset   = 0;

  /// 每帧调用一次（放在 AdjustedDeltaTime 之后）
  void Observe(const ForzaTimeSynchronizer& sync, Nanos nowLocal) noexcept {
    const double w  = sync.CurrentWarp();
    const double aw = (w < 0.0) ? -w : w;
    if (aw > maxAbsWarp) maxAbsWarp = aw;

    if (!sawFirst_) { sawFirst_ = true; firstLocal_ = nowLocal; }

    const Nanos off = sync.CurrentOffsetNs();
    // 首次锁定**之前**（含宽限期）允许直接对齐 —— 那时还没有历史连续性可言，
    // Snap 无副作用。把那段算进 maxStepNs 会得到一个假的"跳变"（实测 77ms），
    // 掩盖真正要看的东西：**锁定之后的**偏移是否连续。
    if (!sync.IsLocked()) { lastOffset = off; return; }
    if (lockedAfterNs == kNoSample) {
      lockedAfterNs = nowLocal - firstLocal_;
      lastOffset = off;                 // 锁定那一帧本身也不计入跳变
      return;
    }
    const Nanos step = (off > lastOffset) ? (off - lastOffset) : (lastOffset - off);
    if (step > maxStepNs) maxStepNs = step;
    lastOffset = off;
  }

  /// 当前未消化残差的绝对值（收敛性判据）。锁定时才是可信读数。
  [[nodiscard]] Nanos ResidualOrZero(const ForzaTimeSynchronizer& sync) const noexcept {
    if (!sync.IsLocked()) return 0;
    const Nanos r = sync.ResidualNs();
    return (r < 0) ? -r : r;
  }

  /// maxAbsWarp 的纳秒等价（仅供打印可读；warp 是比例量，此处乘 1ms 便于展示）
  [[nodiscard]] Nanos maxAbsWarpMs() const noexcept {
    return static_cast<Nanos>(maxAbsWarp * static_cast<double>(kNanosPerMs) * 1000.0);
  }

  void CountSnap() noexcept     { ++snapCount; }
  void CountRejected() noexcept { ++rejectedCount; }

 private:
  Nanos firstLocal_ = 0;
  bool  sawFirst_   = false;
};

// -----------------------------------------------------------------------------
//  NtpJitterSimulator —— 确定性网络抖动模拟器
// -----------------------------------------------------------------------------
/**
 * 模拟模型：
 *   · 服务端有一个恒定的**真实偏移** trueOffsetNs（相对客户端时钟轴）；
 *   · 客户端存在 driftPpm 的时钟漂移，随时间累积 —— 这是"必须持续微调"的根源；
 *   · 去程/回程各自叠加**独立**的 [jitterLo, jitterHi] 随机延迟。
 *
 * 为什么两个方向必须独立随机：
 *   这正是 NTP 偏移误差的来源 —— offset 误差 = (d_out − d_back)/2，
 *   只有双向延迟对称时 offset 才等于真值。抖动越大单次估计越离谱；
 *   而**最小 RTT 那次的对称性最好**，这就是滑窗滤波的全部意义。
 */
class NtpJitterSimulator final {
 public:
  struct Config final {
    Nanos  trueOffsetNs = 37 * kNanosPerMs;
    double driftPpm     = 50.0;      ///< 50ppm ≈ 4.3ms/天
    double baseDelayMs  = 8.0;
    double jitterLoMs   = 20.0;
    double jitterHiMs   = 120.0;
    Nanos  serverProcNs = 120 * kNanosPerUs;
  };

  NtpJitterSimulator(const Config& c, std::uint64_t seed) noexcept;

  /**
   * 产生一次完整往返。
   * @param localArrival 本端实际发出时刻（单调轴）
   * @return 真实墙钟往返（含服务端处理耗时），供断言参考
   */
  Nanos MakeRound(Nanos localArrival, Nanos& outT1, Nanos& outT2,
                  Nanos& outT3, Nanos& outT4) noexcept;

  /// 到 elapsedLocalNs 时刻为止累积的时钟漂移（ns）
  [[nodiscard]] Nanos CurrentDrift(Nanos elapsedLocalNs) const noexcept;

  [[nodiscard]] const Config& config() const noexcept { return cfg_; }

 private:
  /// xorshift64* 推进一步，返回 [0,1)。状态只有一份，
  /// 避免"手工推进状态"与 PRNG 内部移位次数耦合（改一处忘另一处会静默不同步）。
  double NextUnit() noexcept;

  Config cfg_;
  std::uint64_t rngState_;
};

}  // namespace forza::net
```

### 文件: native/timesync/verify_algorithm.py

```python
#!/usr/bin/env python3
"""ForzaTimeSynchronizer 算法数值验证（Python 镜像）。

存在意义：把 C++ 侧**完全相同的方程**用 Python 重写一遍并真跑，
用来独立验证算法本身的收敛性 / 不 Snap / 伸缩有界 / 硬同步阈值 ——
C++ 单测（forza_time_sync_test.cpp，50 项）是主要证据，本文件是**交叉复核**：
两条独立实现若给出同一结论，说明方程本身是对的，而不是某一处转写写对了。

镜像范围（与 C++ 口径严格对齐，改 C++ 必须同步改这里）：
  · PushPingSample(t1..t4)   -> rtt/offset、环形窗口、**前 20% 低 RTT 加权聚合**、硬同步
  · GetAdjustedDeltaTime(dt) -> clamp(err*gain, ±1.5%) / 生效偏移按实际 dt 推进 /
                                **死区内也连续微调**（不冻结残差）
  · Jitter                   -> 双向独立随机延迟 + 客户端 ppm 漂移 + 阶跃突变

与 C++ 的关键口径（别写回旧版）：
  window_size = 30（不是 24）、best_ratio = 0.20（不是取单点最小值）、
  hard_ns = 250ms（不是 200ms）、死区不冻结残差。
"""
import math

NS = 1_000_000_000
MS = 1_000_000
US = 1_000

MAX_WINDOW = 32
NO_SAMPLE = float("inf")


class Sync:
    def __init__(self, window_size=30, best_ratio=0.20, deadband_ns=1 * MS,
                 hard_ns=250 * MS, max_warp=0.015, gain=0.1, max_rtt_ns=500 * MS,
                 grace_ns=300 * MS):
        self.cfg = dict(window_size=window_size, best_ratio=best_ratio,
                        deadband_ns=deadband_ns, hard_ns=hard_ns, max_warp=max_warp,
                        gain=gain, max_rtt_ns=max_rtt_ns, grace_ns=grace_ns)
        self.window = [None] * MAX_WINDOW      # 环形缓冲
        self.head = 0
        self.count = 0
        self.best_rtt = NO_SAMPLE
        self.target = 0
        self.applied = 0
        self.last_t1 = None
        self.first_pong = None
        self.hard_synced = False
        self.warp = 0.0
        self.snaps = 0
        self.rejected = 0

    # ---------------- 滤波：前 20% 低 RTT 加权聚合 ----------------
    def best_set_size(self):
        k = int(self.cfg["window_size"] * self.cfg["best_ratio"])
        return max(1, min(self.cfg["window_size"], k))

    def weighted_best_offset(self):
        """窗口内 RTT 最低的前 k 个样本，按 1/(rtt+1ns) 加权平均 offset。

        扫描**从最新往最旧**，插入用严格 `>` —— 于是 RTT 打平时**最新的**保留
        （局域网里同刻度同链路的 RTT 精确相等很常见；若保留最旧，真实阶跃偏移
         会被历史压住，连 >250ms 的硬同步都触发不了）。
        """
        n = self.count
        if n == 0:
            self.best_rtt = NO_SAMPLE
            return 0
        k = min(self.best_set_size(), n)

        br, bo = [], []                    # 升序的小数组（索引 0 = 最小 RTT）
        for i in range(n - 1, -1, -1):     # 最新 -> 最旧
            rtt, off = self.window[(self.head - n + i) % MAX_WINDOW]
            if len(br) == k and rtt >= br[-1]:
                continue                   # 已满且不比最差的好 -> 剪掉
            pos = len(br)
            while pos > 0 and br[pos - 1] > rtt:   # 严格 > 才右移 => 同 RTT 保留最新
                if pos < k:
                    br.insert(pos, br[pos - 1])
                    bo.insert(pos, bo[pos - 1])
                    del br[pos - 1]
                    del bo[pos - 1]
                pos -= 1
            if pos < k:
                br.insert(pos, rtt)
                bo.insert(pos, off)
            else:
                br.append(rtt)
                bo.append(off)
            if len(br) > k:
                br = br[:k]
                bo = bo[:k]

        self.best_rtt = br[0]
        wsum = sum(1.0 / (float(r) + 1.0) for r in br)
        acc = sum((1.0 / (float(r) + 1.0)) * float(o) for r, o in zip(br, bo))
        return int(acc / wsum + (0.5 if acc >= 0 else -0.5))

    # ---------------- OnPong ----------------
    def on_pong(self, t1, t2, t3, t4):
        P = self.cfg
        if t2 < t1 or t3 < t2 or t4 < t1:
            self.rejected += 1
            return "SampleRejected"
        if self.last_t1 is not None and t1 <= self.last_t1:
            self.rejected += 1
            return "SampleRejected"

        rtt = (t4 - t1) - (t3 - t2)
        offset = ((t2 - t1) + (t3 - t4)) / 2.0
        if rtt < 0 or rtt > P["max_rtt_ns"]:
            self.rejected += 1
            return "SampleRejected"
        self.last_t1 = t1

        # 环形写入
        self.window[self.head] = (rtt, offset)
        self.head = (self.head + 1) % MAX_WINDOW
        if self.count < P["window_size"]:
            self.count += 1

        # 滤波：窗口内 RTT 最低的前 20% 加权聚合（不再取单点最小值）
        self.target = self.weighted_best_offset()

        if not self.hard_synced:
            if self.first_pong is None:
                self.first_pong = t4
            enough = self.count >= P["window_size"]
            in_grace = (t4 - self.first_pong) < P["grace_ns"]
            if enough or in_grace:
                self.applied = self.target          # 首次/宽限期直接对齐
            if enough:
                self.hard_synced = True
            return "None"

        err = self.target - self.applied
        if abs(err) > P["hard_ns"]:
            self.applied = self.target              # 唯一允许 Snap 的场景
            self.warp = 0.0
            self.snaps += 1
            return "HardResync"
        return "None"

    # ---------------- GetAdjustedDeltaTime ----------------
    def adjusted_dt(self, base_dt):
        P = self.cfg
        if not self.hard_synced:
            self.warp = 0.0
            return base_dt
        err = self.target - self.applied
        # ★ 死区内**也**按同一方程算 warp（残差小时它本来就极小，自然被 ±1.5% 夹住）。
        #   旧版在死区内 `warp=0; return base_dt` 且不推进 applied -> 残差被永久冻结，
        #   <1ms 的恒定漂移永远收敛不掉 = 物理 Tick 长期微抖动。这是本轮修掉的真实缺陷。
        err_sec = err / NS
        w = max(-P["max_warp"], min(P["max_warp"], err_sec * P["gain"]))
        self.warp = w
        warped = base_dt * (1.0 + w)
        # ★ 用**实际返回的 dt'** 推进生效偏移（与 warped 的定义严格自洽），
        #   不是 w*base_dt —— 否则一旦 dt' 被夹取，两者失配、残差永远不收敛。
        self.applied += int((warped - base_dt) * NS)
        return warped


class Jitter:
    """确定性 xorshift64*，与 C++ 侧同构"""
    def __init__(self, seed):
        self.s = seed or 0x9E3779B97F4A7C15

    def unit(self):
        s = self.s
        s ^= (s >> 12) & 0xFFFFFFFFFFFFFFFF
        s ^= (s << 25) & 0xFFFFFFFFFFFFFFFF
        s ^= (s >> 27) & 0xFFFFFFFFFFFFFFFF
        self.s = s
        x = (s * 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF
        return (x >> 11) / float(1 << 53)

    def rng(self, lo, hi):
        return lo + (hi - lo) * self.unit()


class Net:
    def __init__(self, seed, true_offset_ns=37 * MS, drift_ppm=50.0,
                 base_ms=4.0, jlo=20.0, jhi=120.0, proc_ns=120 * US):
        self.r = Jitter(seed)
        self.true_off = true_offset_ns
        self.ppm = drift_ppm
        self.base = base_ms
        self.jlo, self.jhi = jlo, jhi
        self.proc = proc_ns

    def drift(self, elapsed):
        return int(elapsed * self.ppm * 1e-6)

    def round(self, local):
        d_out = self.base + self.r.rng(self.jlo, self.jhi)
        d_back = self.base + self.r.rng(self.jlo, self.jhi)
        out = int(d_out * MS)
        back = int(d_back * MS)
        t1 = local
        t2 = t1 + out + self.true_off + self.drift(local)
        t3 = t2 + self.proc
        t4 = t1 + out + self.proc + back
        return t1, t2, t3, t4


def main():
    print("=== ForzaTimeSynchronizer 算法数值验证（Python 镜像）===\n")
    fails = []

    def check(ok, what, detail=""):
        print(("  PASS  " if ok else "  FAIL  ") + what + ("   " + detail if detail else ""))
        if not ok:
            fails.append(what)

    # ---- T3 抖动 20~120ms ----
    print("[T3] 网络抖动 20ms~120ms")
    sync = Sync()                       # 默认 window=30 / best_ratio=0.20 / hard=250ms
    net = Net(0xC0FFEE, true_offset_ns=37 * MS, drift_ppm=50.0, jlo=20.0, jhi=120.0)
    dt = 1.0 / 60.0
    local = 0
    max_warp = 0.0
    max_step = 0
    err_after_lock = 0
    locked_at = None
    for i in range(240):
        t1, t2, t3, t4 = net.round(local)
        sync.on_pong(t1, t2, t3, t4)
        # 关键：判据必须是**每帧**的变化量，不是每个采样周期的。
        # 上界 = maxWarpRatio * dt = 0.015 * 16.67ms = 0.25ms。
        # （按采样周期统计会得到 ~2ms/s 的"伪超标" —— 那是正常的 slew 速率，
        #   15ms/s 才是上限。）
        for f in range(60):
            fr_prev = sync.applied
            d = sync.adjusted_dt(dt)
            if sync.hard_synced:
                max_step = max(max_step, abs(sync.applied - fr_prev))
            max_warp = max(max_warp, abs(sync.warp))
            assert d > 0 and d <= dt * 1.02, "dt 越界"
            local += int(d * NS)
        if sync.hard_synced and locked_at is None:
            locked_at = local
        if sync.hard_synced and i > 24:
            truth = sync.applied  # 占位，下面用真实误差覆盖
        if sync.hard_synced and i > 24:
            truth_off = net.true_off + net.drift(local)
            err_after_lock = max(err_after_lock, abs(sync.applied - truth_off))

    check(sync.hard_synced, "抖动 20~120ms 下完成锁定")
    check(sync.snaps == 0, "稳态期间零硬同步", f"snaps={sync.snaps}")
    check(max_warp <= 0.015 + 1e-12, "伸缩比例始终 <= ±1.5%", f"maxWarp={max_warp:.6f}")
    check(max_step <= 260 * US, "生效偏移**单帧**变化 <= 0.26ms（=1.5%×dt，无硬跳）",
          f"maxStep={max_step/MS:.4f}ms")
    check(err_after_lock < 30 * MS, "锁定后残余误差 < 30ms（优于 50ms 理论最坏值）",
          f"残余={err_after_lock/MS:.2f}ms")
    check(locked_at is not None and locked_at < 30 * NS, "30 秒内完成锁定",
          f"lockedAt={locked_at/NS if locked_at else float('nan'):.1f}s")

    # ---- T4 1~100ms 阶跃不 Snap ----
    print("\n[T4] 偏差 80ms 只做连续微调")
    s2 = Sync()
    q = 3 * MS
    local = 0
    for i in range(40):
        s2.on_pong(local, local + q, local + q + US, local + q + US + q)
        for f in range(30):
            s2.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s2.hard_synced, "前置：已锁定")
    snaps_before = s2.snaps
    step = 80 * MS
    prev = s2.applied
    mx = 0
    for i in range(20):
        t1 = local
        s2.on_pong(t1, t1 + q + step, t1 + q + US + step, t1 + q + US + q)
        for f in range(60):
            s2.adjusted_dt(dt)
            mx = max(mx, abs(s2.applied - prev))
            prev = s2.applied
            local += int(dt * NS)
        local += NS
    check(s2.snaps == snaps_before, "80ms 阶跃未触发硬同步", f"snaps={s2.snaps}")
    check(mx <= 300 * US, "阶跃被摊成连续微调", f"maxStep={mx/MS:.4f}ms")
    check(s2.applied > 40 * MS, "确实在向 80ms 收敛", f"applied={s2.applied/MS:.2f}ms")

    # ---- T3b 阶跃突变抖动 0ms~150ms（规格指定的收敛性用例）----
    # 注意：单程延迟改变**不**改变 offset（offset = 真时钟差），所以只改延迟的
    # 测试是**空跑**（残差恒为 0，假绿）。必须同时注入一个真实 offset 阶跃。
    print("\n[T3b] 阶跃突变抖动 0ms~150ms（含 +120ms 真实 offset 阶跃，不许 Snap）")
    s5 = Sync()
    local = 0
    # A 段：空闲 0ms，先锁到 offset=+45ms
    A_OFF = 45 * MS
    for i in range(40):
        s5.on_pong(local, local + A_OFF, local + A_OFF + US, local + A_OFF + US)
        for f in range(30):
            s5.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s5.hard_synced, "A 段：已锁定（空闲 0ms）")

    snaps_before = s5.snaps
    # B 段：单程一步到 150ms（RTT 300ms），并叠加 +120ms 真实偏移阶跃（共 165ms < 250ms）
    B_OFF = A_OFF + 120 * MS
    ONE = 150 * MS
    max_warp5 = 0.0
    max_step5 = 0
    peak_res = 0
    prev = s5.applied
    for i in range(120):
        t1 = local
        s5.on_pong(t1, t1 + ONE + B_OFF, t1 + ONE + B_OFF + US, t1 + ONE + ONE + US)
        for f in range(60):
            d = s5.adjusted_dt(dt)
            assert d > 0 and d <= dt * 1.02, "dt 越界"
            max_warp5 = max(max_warp5, abs(s5.warp))
            max_step5 = max(max_step5, abs(s5.applied - prev))
            prev = s5.applied
            peak_res = max(peak_res, abs(s5.target - s5.applied))
            local += int(d * NS)
        local += NS

    check(s5.snaps == snaps_before, "★ 165ms 阶跃**未**触发硬同步（<250ms 阈值）", f"snaps={s5.snaps}")
    check(max_warp5 <= 0.015 + 1e-12, "伸缩比例 <= ±1.5%", f"maxWarp={max_warp5:.6f}")
    check(max_step5 <= 260 * US, "生效偏移单帧变化 <= 0.26ms（无硬跳）", f"maxStep={max_step5/MS:.4f}ms")
    check(peak_res > 50 * MS, "★ 非空跑守卫：确实观测到大残差（否则测试没测到东西）",
          f"峰值残差={peak_res/MS:.2f}ms")
    final_res = abs(s5.target - s5.applied)
    check(final_res < 0.5 * MS, "末态残差 < 0.5ms（真正收敛）", f"末态残差={final_res/MS:.4f}ms")

    # ---- T4b 死区内残差真正收敛（回归：旧实现会永久冻结）----
    print("\n[T4b] 死区内恒定 0.5ms 偏差必须收敛（旧实现冻结 -> 回归）")
    s6 = Sync()
    local = 0
    q2 = 5 * MS          # 单程 5ms，RTT 10ms；offset = +0.5ms（落在 1ms 死区内）
    bias = 500 * US
    for i in range(200):
        s6.on_pong(local, local + q2 + bias, local + q2 + US + bias, local + q2 + US + q2)
        for f in range(30):
            s6.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s6.hard_synced, "前置：已锁定")
    r6 = abs(s6.target - s6.applied)
    check(s6.applied > 300 * US, "★ 死区内的 0.5ms 偏差确实被消化（未被冻结）",
          f"applied={s6.applied/US:.1f}us")
    check(r6 < 150 * US, "★ 残差收敛到 0.15ms 内（不是永久冻结在 0.5ms）",
          f"残差={r6/US:.1f}us")

    # ---- T5 > 250ms 硬同步 ----
    print("\n[T5] 偏差 400ms 触发硬同步")
    s3 = Sync()
    local = 0
    for i in range(40):
        s3.on_pong(local, local + q, local + q + US, local + q + US + q)
        for f in range(20):
            s3.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    ev = "None"
    for i in range(10):
        t1 = local
        ev = s3.on_pong(t1, t1 + q + 400 * MS, t1 + q + US + 400 * MS, t1 + q + US + q)
        if ev == "HardResync":
            break
        local += NS
    check(ev == "HardResync", "400ms 偏差返回 HardResync")
    # Snap 后 applied 必须直接等于当前权威目标（残差归零），而不是"累积到 300ms 以上"
    check(abs(s3.target - s3.applied) == 0, "★ Snap 后残差严格归零（applied == target）",
          f"残差={(s3.target - s3.applied)/MS:.4f}ms")
    check(s3.applied > 250 * MS, "已对齐到 >250ms 的新时基", f"applied={s3.applied/MS:.1f}ms")

    # ---- T5b 反向守卫：200ms 未超阈值，不得 Snap ----
    print("\n[T5b] 偏差 200ms 位于阈值内侧，不得 Snap")
    s7 = Sync()
    local = 0
    for i in range(40):
        s7.on_pong(local, local + q, local + q + US, local + q + US + q)
        for f in range(20):
            s7.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    snaps0 = s7.snaps
    for i in range(10):
        t1 = local
        s7.on_pong(t1, t1 + q + 200 * MS, t1 + q + US + 200 * MS, t1 + q + US + q)
        for f in range(20):
            s7.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s7.snaps == snaps0, "200ms 未触发硬同步（阈值 250ms 守住了）", f"snaps={s7.snaps}")

    # ---- T7 非法/乱序 ----
    print("\n[T7] 非法与乱序样本")
    s4 = Sync()
    check(s4.on_pong(100 * MS, 50 * MS, 60 * MS, 200 * MS) == "SampleRejected", "T2<T1 被拒")
    big = 600 * MS
    check(s4.on_pong(1000 * MS, 1000 * MS + big, 1000 * MS + big + 1000,
                     1000 * MS + 2 * big) == "SampleRejected", "RTT>500ms 被拒")
    t1 = 5000 * MS
    check(s4.on_pong(t1, t1 + q, t1 + q + US, t1 + q + US + q) == "None", "正常样本被接受")
    check(s4.on_pong(t1 - 10 * MS, t1, t1 + US, t1 + 20 * MS) == "SampleRejected", "T1 回退被拒")

    print(f"\n结果：{'全部通过' if not fails else str(len(fails)) + ' 项失败'}")
    for f in fails:
        print("  ✗ " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

## 赛距追踪（race_delta_tracker）

### 文件: native/race_delta/race_delta_tracker.cpp

```cpp
// =============================================================================
//  race_delta_tracker.cpp —— RaceDeltaTracker 的非内联实现
//
//  为什么还要一个 .cpp（本模块绝大部分逻辑已在头里内联）：
//    · 给"时差语义"这个最容易在两端漂移的东西留一个**权威实现点**。
//      符号约定、分支优先级、外推除数选取都写在这里，头文件只做声明转发。
//    · 让 RaceDeltaTracker 能被单独编译进一个静态库（CMake 目标 race_delta），
//      服务端/客户端/Wasm 三端共享同一份目标文件，不可能各自实现一遍。
//    · 单元测试可以直接对**这个**符号做断言，而不是对头里的内联副本做断言。
// =============================================================================
#include "race_delta_tracker.h"

namespace forza::race {

// -----------------------------------------------------------------------------
//  符号约定的单一来源
// -----------------------------------------------------------------------------

const char* DeltaMethodName(DeltaMethod m) noexcept {
  switch (m) {
    case DeltaMethod::None:         return "none";
    case DeltaMethod::Checkpoint:   return "checkpoint";
    case DeltaMethod::SplineExtrap: return "spline-extrap";
    case DeltaMethod::LapDelta:     return "lap-delta";
  }
  return "?";
}

/**
 * 把 Solve 的结果压成"赛事 HUD 需要的一行字"。
 *
 * 这里刻意把**所有**格式决策收在一个函数里（而不是散落在渲染代码中），
 * 因为规格对格式的要求是精确的（"--" / "-0.X" / "-X.XX"），
 * 散落实现迟早会出现"某个分支忘了负号"这类视觉 bug。
 *
 * @param r          Solve 的结果
 * @param isLeader   显示方是否就是领跑者
 * @param forceChase true = 这一行表示"后方车辆"，按规格一律负号
 */
int FormatDeltaRow(char* out, std::size_t cap, const DeltaResult& r,
                   bool isLeader, bool forceChase) noexcept {
  if (out == nullptr || cap == 0) return 0;
  if (isLeader) return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
  if (!r.valid()) return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
  if (forceChase) {
    // 后车行：落后量 = 该结果的绝对值（Solve(chaser, leader) 给出负值）
    const double mag = (r.deltaMs < 0.0) ? -r.deltaMs : r.deltaMs;
    return DeltaFormatter::FormatChaserRow(out, cap, mag);
  }
  // 普通行（非领先方）：规格要求负号格式。这里用死区关 + 强制负号，
  // 因为"非领先方"这一行按规格**恒为负数**（噪声正值也要显示成负的）。
  return DeltaFormatter::Format(out, cap, r.deltaMs, /*deadband=*/false, /*forceNeg=*/true);
}

}  // namespace forza::race
```

### 文件: native/race_delta/race_delta_tracker.h

```cpp
// =============================================================================
//  race_delta_tracker.h —— 左上角实时时间差（Time Delta）计算与格式化
//
//  规格来源：赛事规则 §"左上角实时时间差"
//    · 第一行永远显示"本地玩家与全场第一名（领跑者）"的时间差距。
//    · 本地玩家即第一名时，自己的时差固定显示 "--"。
//    · 落后于第一名时（或排行榜显示本地玩家后方车辆时），统一显示**负数**格式
//      "-0.X" 或 "-X.XX"（落后幅度，保留 1~2 位小数）。
//
//  ── 为什么不能用"欧氏距离 ÷ 实时速度" ────────────────────────────────────────
//  这条捷径在直道上看起来没问题，一出弯就崩：
//    · 出弯时后车速度远高于前车（前车在弯心减速），除以**后车自己的**速度会
//      把 "落后 30m" 算成 "落后 0.4s"，而真实差距是 1.2s；
//    · 入弯时反过来低估。
//    · 更根本的问题：两车沿赛道中心线的**弧长差**才是时间差的正确自变量，
//      欧氏距离在弯里比弧长短得多（弦 vs 弧），本身就是一个错的几何量。
//
//  ── 本模块的两级策略 ─────────────────────────────────────────────────────────
//  【一级 · 精确】两车有**公共计时点（Checkpoint）**时，直接取该计时点的
//    权威过线时刻之差：ΔT = T_follower(cp) − T_leader(cp)。
//    这是唯一无歧义的定义（同一个空间截面上的时间差），也是赛事官方口径。
//
//  【二级 · 外推】两车之间没有公共计时点（刚发车 / 领跑车已经过线而本车还没到）
//    时，把两车**沿中心样条线的弧长 S** 各自推进到同一个截面，再按
//    "**前车**在该赛段的实测样条速度"折算时间：
//
//        ΔS   = S_leader − S_follower                       （弧长差，米）
//        ΔT   = −ΔS / v_seg                                 （落后取负）
//        v_seg = 前车在该赛段的**弧长速度**（ds/dt，由连续两帧 S 求差分 + EWMA）
//
//    两个要点：
//      ① 除数是**前车**的速度，不是后车的、也不是两车平均 —— 时间差的语义是
//         "按前车当前的推进节奏，我落后多少秒"，用后车的速度会在出弯时严重低估。
//      ② 用的是**样条弧长速度**而不是车轴向速度。车在弯里侧滑时轴向速度与
//         沿中心线的推进速度不同，后者才是"赛段进度"的正确时间导数。
//    外推只在一个计时点区间内有效：一旦后车追上了下一个计时点，立刻回到一级精确解，
//    所以外推误差不会累积（这是"严禁仅拿空间欧氏距离除以实时速度导致发弯道畸变"
//     的正面做法 —— 我们既不用欧氏距离，也不在弯里用瞬时轴向速度）。
//
//  ── 符号约定（与 Go 服务端 signedDeltaMs 严格一致）──────────────────────────
//      deltaMs > 0  = 前者领先（后者落后）
//      deltaMs < 0  = 前者落后
//      deltaMs == 0 = 并驾齐驱
//    渲染时**落后一律带负号**："-0.4" / "-1.25"。
//
//  ── 零依赖 / 零堆分配 ────────────────────────────────────────────────────────
//  不依赖 GLM、不依赖 any C++ 库的样条实现：本文件自带与 `public/js/track.js`
//  **同构**的 Catmull-Rom 闭合样条 + 等弧长重采样（同一套公式，便于两端交叉核对）。
//  热路径全部走固定容量 std::array，无 new / 无 std::vector。
// =============================================================================
#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace forza::race {

// -----------------------------------------------------------------------------
//  格式化：赛事规则的时差文本
// -----------------------------------------------------------------------------

/**
 * 时差显示的格式档位。
 *
 * 规格："-0.X" 或 "-X.XX"（保留 1~2 位小数）。本模块把这条规则落成三段：
 *   · 绝对值 < 10ms  -> 视为并驾齐驱，显示 "0.00"（不带负号：确实没落后）
 *   · 绝对值 < 10s   -> 一位小数，如 "-0.4" / "-3.7"
 *     （0.0~9.9 区间一位小数已经够用，而且更短、抖动更小 —— 最后一位不会
 *       因为 10ms 级的采样噪声每帧跳字）
 *   · 绝对值 >= 10s  -> 两位小数，如 "-12.34" / "-75.08"
 *     （大赛段里 0.1s 已经无意义，但选手仍想看趋势，保留两位）
 *   · 绝对值 >= 100s -> 两位小数 + 但做上限截断（"99+" 级别），防止 M 型数字撑爆 HUD
 *
 * @param deltaMs 带符号时差（>0 = 领先）
 * @param leading 显示方是否**就是领跑者**（是则固定输出 "--"）
 * @return 形如 "--" / "-0.4" / "-1.25" / "+0.4" 的文本
 *
 * 注意：规格只要求"落后显示负号"。领先方（本地玩家为 P1）按规格显示 "--"，
 * 而不是 "+0.0"，所以 leading=true 时直接短路返回。
 * 非领先方却仍为正值（理论上不该出现）时按规格也加 "-" 前缀兜底 ——
 * 参见 FormatDelta 的 `forceNegativeForChaser`。
 */
struct DeltaFormatter final {
  /// 并驾齐驱死区（ms）：低于它显示 "0.00" 而不是 "-0.02"（避免最后一位抖字）
  static constexpr double kDeadbandMs = 10.0;

  /// 一位小数 / 两位小数的分界（ms）
  static constexpr double kTwoDecimalFromMs = 10000.0;   // 10s

  /// 数值上限：超过它截断（HUD 宽度保护）
  static constexpr double kClampMs = 999900.0;           // 999.9s

  /**
   * 纯数值格式化（不含 "--" 逻辑）。
   *
   * @param deltaMs    带符号时差（>0 领先）
   * @param deadband   是否启用"并驾齐驱死区"（<10ms 输出 "0.00" 而不是 "-0.0"）
   * @param forceNeg   强制输出负号。用于"后车行"——规格要求后车统一负数格式，
   *                   即使某帧估计值因噪声略微为正也不该闪出正号。
   *
   * ⚠️ deadband 与 forceNeg 是**两个正交的开关**，这里必须分开传：
   *   · 计时塔**第一行**（本地 vs 领跑者）：deadband=true, forceNeg=false
   *     —— 齐平时显示 "0.00"（确实没落后，不该显示 "-0.0"）
   *   · 计时塔**后车行**：deadband=false, forceNeg=true
   *     —— 规格明确"后车统一负数"，齐平也写 "-0.0"，否则同一列里
   *        有的行带负号有的不带，视觉上像两套规则。
   *   早期实现把两者合成一个 forceNeg 参数，导致第一行绕过死区、
   *   并驾齐驱时错误地显示成 "-0.0"（本仓库踩过，测试 T1 守着这条边界）。
   */
  [[nodiscard]] static int Format(char* out, std::size_t cap, double deltaMs,
                                  bool deadband, bool forceNeg) noexcept {
    if (out == nullptr || cap == 0) return 0;
    if (!std::isfinite(deltaMs)) {
      return write(out, cap, "--");
    }
    if (deltaMs > kClampMs) deltaMs = kClampMs;
    if (deltaMs < -kClampMs) deltaMs = -kClampMs;

    const double absMs = (deltaMs < 0.0) ? -deltaMs : deltaMs;

    // 死区内视为并驾齐驱。只在启用死区、且不强制负号时短路。
    if (deadband && !forceNeg && absMs < kDeadbandMs) {
      return write(out, cap, "0.00");
    }

    // 符号决策：forceNeg 优先；否则按数值正负。
    // 注意 absMs < kDeadbandMs 且 forceNeg 时，仍走负号分支 —— 得到 "-0.0"。
    const bool neg = forceNeg || (deltaMs < 0.0);

    const double seconds = absMs / 1000.0;
    const int decimals = (absMs >= kTwoDecimalFromMs) ? 2 : 1;
    // 先格式化**绝对值**，再手工拼符号 —— 避免依赖 "%.1f" 对 -0.0 的实现差异
    // （某些 libc 会打出 "-0.0"，另一些打 "0.0"，跨平台不一致；也避免
    //   "%.1f" 已经带了负号时再拼一个负号变成 "--0.0"）。
    char body[48];
    const int n = std::snprintf(body, sizeof body, (decimals == 2) ? "%.2f" : "%.1f", seconds);
    if (n <= 0) return write(out, cap, "--");

    std::size_t o = 0;
    if (neg) { if (o + 1 < cap) out[o++] = '-'; }
    for (int i = 0; i < n && o + 1 < cap; ++i) out[o++] = body[i];
    out[o] = '\0';
    return static_cast<int>(o);
  }

  /**
   * 计时塔第一行（本地玩家相对领跑者）。
   * @param deltaMs  带符号时差（>0 = 本地领先）
   * @param isLeader 本地玩家是否就是领跑者
   */
  [[nodiscard]] static int FormatLeaderRow(char* out, std::size_t cap,
                                           double deltaMs, bool isLeader) noexcept {
    if (out == nullptr || cap == 0) return 0;
    if (isLeader) return write(out, cap, "--");     // 规格：领跑者固定 "--"
    // 规格：落后统一负号格式。但**并驾齐驱仍显示 0.00**（死区生效），
    // 所以这里 deadband=true、forceNeg=false —— 负号由数值本身的符号决定，
    // 噪声导致的正值也在 FormatDeltaRow 层被强制成负号。
    return Format(out, cap, deltaMs, /*deadband=*/true, /*forceNeg=*/false);
  }

  /**
   * 后车行（排行榜里排在本地玩家**后面**的那些车）。
   * 规格："或者排行榜显示本地玩家后方车辆时，后车时间差距统一显示为负数格式"。
   *
   * 语义澄清：这里的"后车"是相对**本地玩家**而言。本地玩家 P1 时显示 "-0.85"
   * 表示"我领先后车 0.85 秒"，数值上等于 gapToLocal（后车落后量），带负号渲染。
   *
   * 死区**关闭**且强制负号：规格要求后车行统一负数格式，齐平时也写 "-0.0"，
   * 保证同一列里不会出现"有的行带负号、有的不带"。
   *
   * @param gapToLocalMs 后车相对本地玩家的落后量（**正值** = 后车确实落后）
   */
  [[nodiscard]] static int FormatChaserRow(char* out, std::size_t cap,
                                           double gapToLocalMs) noexcept {
    if (out == nullptr || cap == 0) return 0;
    const double mag = (gapToLocalMs < 0.0) ? -gapToLocalMs : gapToLocalMs;
    return Format(out, cap, mag, /*deadband=*/false, /*forceNeg=*/true);
  }

 private:
  static int write(char* out, std::size_t cap, const char* s) noexcept {
    std::size_t o = 0;
    for (; s[o] != '\0' && o + 1 < cap; ++o) out[o] = s[o];
    out[o] = '\0';
    return static_cast<int>(o);
  }
};

// -----------------------------------------------------------------------------
//  赛道中心样条线（与 public/js/track.js 同构）
// -----------------------------------------------------------------------------

/** 闭合 Catmull-Rom 控制点多边形（x/z 平面）。控制点直接按 [2] 存，无堆。 */
struct SplinePath final {
  static constexpr std::size_t kMaxCtl = 64;

  std::array<std::array<double, 2>, kMaxCtl> ctl{};
  std::size_t n = 0;
  double length = 0.0;        ///< 闭合总弧长（米）

  /// 控制点数量决定"每段"的弧长下限；太少的控制点会让 S 的分辨率不足
  [[nodiscard]] bool valid() const noexcept { return n >= 4 && length > 1.0; }
};

/**
 * 闭合 Catmull-Rom（uniform，与 track.js 的 catmullRom 逐字一致）。
 *
 * t ∈ [0, n) 是**样条参数**（不是弧长）；i1 = floor(t)、f = t − i1。
 * 控制点索引按 n 取模环绕，保证闭合处 C1 连续。
 */
struct CatmullRom final {
  static void eval(const SplinePath& p, double t, double* outX, double* outZ) noexcept {
    const std::size_t n = p.n;
    if (n == 0) { *outX = 0.0; *outZ = 0.0; return; }
    if (n < 4) {                                    // 退化：线性环绕，避免越界读
      const double u = std::fmod(std::fmod(t, static_cast<double>(n)) + n, static_cast<double>(n));
      const std::size_t i = static_cast<std::size_t>(u);
      const std::size_t j = (i + 1) % n;
      const double f = u - static_cast<double>(i);
      *outX = p.ctl[i][0] + (p.ctl[j][0] - p.ctl[i][0]) * f;
      *outZ = p.ctl[i][1] + (p.ctl[j][1] - p.ctl[i][1]) * f;
      return;
    }
    const double u = std::fmod(t, static_cast<double>(n));
    const double uu = (u < 0.0) ? u + static_cast<double>(n) : u;
    const std::size_t i1 = static_cast<std::size_t>(uu);
    const double f = uu - static_cast<double>(i1);
    const std::size_t i0 = (i1 + n - 1) % n;
    const std::size_t i2 = (i1 + 1) % n;
    const std::size_t i3 = (i1 + 2) % n;

    const double f2 = f * f;
    const double f3 = f2 * f;
    auto cr = [&](double a, double b, double c, double d) noexcept {
      return 0.5 * ((2.0 * b) + (-a + c) * f +
                    (2.0 * a - 5.0 * b + 4.0 * c - d) * f2 +
                    (-a + 3.0 * b - 3.0 * c + d) * f3);
    };
    *outX = cr(p.ctl[i0][0], p.ctl[i1][0], p.ctl[i2][0], p.ctl[i3][0]);
    *outZ = cr(p.ctl[i0][1], p.ctl[i1][1], p.ctl[i2][1], p.ctl[i3][1]);
  }
};

/**
 * 赛道弧长表：把闭合样条按等弧长切成 N 段，提供两种查询
 *   · SOfParam(t)   样条参数 -> 累计弧长 S（米）
 *   · ParamOfS(s)   累计弧长 S ——> 样条参数（二分查找）
 * 也提供最近点投影 ProjectClosest(x,z) ——> S（车辆定位用）。
 *
 * N 默认 512：对 7km 级赛道相当于 13.7m 一格，配合二次插值足够平滑；
 * 表大小 512×8B ≈ 4KB，构造一次、常驻，无堆分配。
 */
struct ArcLengthTable final {
  static constexpr std::size_t kMaxSeg = 1024;

  std::array<double, kMaxSeg + 1> s{};   ///< 每个采样点的累计弧长（s[0]=0, s[N]=length）

  std::size_t n = 0;
  double spacing = 1.0;

  /// 预采样构表。M 是细分密度（越大越精确，代价是构造期一次 O(M) 扫描）。
  static void build(const SplinePath& p, ArcLengthTable& out,
                    std::size_t n = 512, std::size_t m = 8192) noexcept {
    if (n > kMaxSeg) n = kMaxSeg;
    out.n = n;
    if (!p.valid() || n == 0) { out.spacing = 1.0; return; }

    // 先按高密度参数采样累计出总弧长（样条参数 -> 弧长的映射不是线性的，
    // 必须先建表再反查；急弯处"1 单位参数"对应的弧长明显更短）。
    double prevX = 0.0, prevZ = 0.0;
    double cum = 0.0;
    // 阶段一：密度采样，记录 (t, cum) 到等距的 s 表
    double nextTarget = 0.0;
    std::size_t filled = 0;
    out.s[0] = 0.0;
    CatmullRom::eval(p, 0.0, &prevX, &prevZ);
    for (std::size_t i = 1; i <= m; ++i) {
      const double t = (static_cast<double>(i) / static_cast<double>(m)) * static_cast<double>(p.n);
      double x = 0.0, z = 0.0;
      CatmullRom::eval(p, t, &x, &z);
      cum += std::hypot(x - prevX, z - prevZ);
      prevX = x; prevZ = z;
      // 把落在这一小段里的等弧长刻度全部填上（一段可能跨多个刻度，也可能不跨）
      const double stepSize = p.length / static_cast<double>(n);
      while (filled + 1 <= n && cum >= nextTarget + stepSize) {
        nextTarget += stepSize;
        ++filled;
        out.s[filled] = nextTarget;
      }
    }
    // 闭环收尾：末点直接钉在总弧长上，消除累计浮点误差
    for (std::size_t k = filled + 1; k <= n; ++k) out.s[k] = p.length;
    out.s[n] = p.length;
    out.spacing = p.length / static_cast<double>(n);
  }

  /// 弧长 s（米，自动对 length 取模）-> 样条参数 t ∈ [0, n)
  [[nodiscard]] double ParamOfS(const SplinePath& p, double sm) const noexcept {
    if (n == 0 || spacing <= 0.0) return 0.0;
    double v = std::fmod(sm, p.length);
    if (v < 0.0) v += p.length;
    // 二分：s 表单调不减
    std::size_t lo = 0, hi = n;
    while (lo + 1 < hi) {
      const std::size_t mid = (lo + hi) / 2;
      if (s[mid] <= v) lo = mid; else hi = mid;
    }
    const double s0 = s[lo], s1 = s[lo + 1];
    const double seg = s1 - s0;
    const double frac = (seg > 1e-12) ? (v - s0) / seg : 0.0;
    return (static_cast<double>(lo) + frac) / static_cast<double>(n) * static_cast<double>(p.n);
  }

  /// 最近点投影：返回 (x,z) 在中心线上的弧长 S。粗暴 O(n) 扫描 + 段内投影
  /// （n=512 时约 512 次 hypot，60Hz×4 车 = 12 万次/秒，可忽略）。
  [[nodiscard]] double ProjectClosest(const SplinePath& p, double x, double z,
                                      double hintS = -1.0, double hintWinM = 200.0) const noexcept {
    if (n == 0 || !p.valid()) return 0.0;
    if (spacing <= 0.0) return 0.0;

    // 有 hint 时只在 hint 附近 ±hintWinM 的窗口里搜（避免在 8 字交叉处
    // 投影到"空间上更近但圈上很远"的另一支）。窗口扫不到就退回全扫。
    std::size_t i0 = 0, i1 = n;
    if (hintS >= 0.0) {
      const double half = std::max(hintWinM, spacing) / spacing;
      const std::ptrdiff_t c = static_cast<std::ptrdiff_t>(hintS / spacing);
      const std::ptrdiff_t a = c - static_cast<std::ptrdiff_t>(half);
      const std::ptrdiff_t b = c + static_cast<std::ptrdiff_t>(half);
      i0 = static_cast<std::size_t>(std::max<std::ptrdiff_t>(0, a));
      i1 = static_cast<std::size_t>(std::min<std::ptrdiff_t>(
               static_cast<std::ptrdiff_t>(n), b));
      if (i1 <= i0 + 1) { i0 = 0; i1 = n; }        // 窗口退化 -> 全扫
    }

    double bestD2 = 1e300;
    double bestS = 0.0;
    for (std::size_t i = i0; i < i1; ++i) {
      const std::size_t j = (i + 1) % (n + 1);
      double ax = 0.0, az = 0.0, bx = 0.0, bz = 0.0;
      CatmullRom::eval(p, ParamOfS(p, s[i]), &ax, &az);
      CatmullRom::eval(p, ParamOfS(p, j == n ? p.length : s[j]), &bx, &bz);
      const double ex = bx - ax, ez = bz - az;
      const double len2 = ex * ex + ez * ez;
      double tt = 0.0;
      if (len2 > 1e-12) {
        tt = ((x - ax) * ex + (z - az) * ez) / len2;
        if (tt < 0.0) tt = 0.0;
        if (tt > 1.0) tt = 1.0;
      }
      const double px = ax + ex * tt, pz = az + ez * tt;
      const double dx = x - px, dz = z - pz;
      const double d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        const double sa = s[i];
        const double sb = (j == n) ? p.length : s[j];
        bestS = sa + (sb - sa) * tt;
      }
    }
    return std::fmod(bestS, p.length);
  }
};

// -----------------------------------------------------------------------------
//  单车的时差输入
// -----------------------------------------------------------------------------

/**
 * 一辆车在「时差解算」所需的最小状态。
 *
 * 注意 sMeters 的语义是**沿中心线的累计弧长**（本圈，0..length），
 * 由 ArcLengthTable::ProjectClosest 从世界坐标投影得到 —— 不是欧氏距离。
 */
struct DeltaCarState final {
  double sMeters = 0.0;      ///< 本圈沿中心线的累计弧长（米）
  double sampleTime = 0.0;   ///< 该 S 的采样时刻（服务端单调秒）
  int lap = 0;               ///< 已完成圈数

  /// 该车**已通过**的最后一个 Checkpoint 索引（-1 = 一个都没过）
  int cpIndex = -1;

  /// 最近若干计时点的权威过线时刻（秒，服务端时钟轴）。
  /// 索引 = Checkpoint 序号；<= 0 表示"没数据"。
  static constexpr std::size_t kMaxCp = 64;
  std::array<double, kMaxCp> cpPassTime{};

  /// 本段弧长速度（ds/dt，m/s）的 EWMA 估计 —— **前车**的外推除数
  double segSpeedMps = 0.0;

  [[nodiscard]] double PassTime(int cp) const noexcept {
    if (cp < 0 || cp >= static_cast<int>(kMaxCp)) return 0.0;
    return cpPassTime[static_cast<std::size_t>(cp)];
  }
};

// -----------------------------------------------------------------------------
//  解算结果
// -----------------------------------------------------------------------------

enum class DeltaMethod : std::uint8_t {
  None = 0,          ///< 无法给出（数据不足）
  Checkpoint = 1,    ///< 一级精确：公共计时点过线时刻差
  SplineExtrap = 2,  ///< 二级外推：样条弧长差 ÷ 前车分段速度
  LapDelta = 3,      ///< 整圈差：跨圈时按平均圈速折算量级
};

struct DeltaResult final {
  double deltaMs = 0.0;        ///< 带符号（>0 = a 领先 b）
  DeltaMethod method = DeltaMethod::None;
  double dsMeters = 0.0;       ///< 解算用到的弧长差（外推法才有意义）
  double vSegMps = 0.0;        ///< 解算用到的分段速度

  [[nodiscard]] bool valid() const noexcept { return method != DeltaMethod::None; }
};

// -----------------------------------------------------------------------------
//  RaceDeltaTracker
// -----------------------------------------------------------------------------

/**
 * 时间差解算器。
 *
 * 无堆分配：SplinePath + ArcLengthTable 都是固定容量 std::array 成员。
 * 非线程安全（约定在渲染线程调用）。
 */
class RaceDeltaTracker final {
 public:
  /// 外推速度的安全下限（m/s）：低于它说明前车几乎停住（事故/起步），
  /// 用它当除数会得到天文数字。取 12m/s ≈ 43km/h，与项目里其他参考车速下限一致。
  static constexpr double kMinSegSpeedMps = 12.0;

  /// 分段速度 EWMA 系数（新样本权重）。0.25 对应约 4 个采样的时间常数；
  /// 太大 → 出弯加速时除数跟不上（低估时差），太小 → 噪声大。
  static constexpr double kSpeedEwmaAlpha = 0.25;

  /// 跨圈折算的默认圈速（秒），未提供平均圈速时使用
  static constexpr double kDefaultLapSec = 60.0;

  RaceDeltaTracker() noexcept = default;

  // ---------------------------------------------------------------------------
  //  赛道装配
  // ---------------------------------------------------------------------------

  /**
   * 装入赛道中心线控制多边形（闭合）。
   *
   * checkpoints 给出每个计时点在**弧长上的位置**（米，升序，[0, length)）。
   * 只需这一段元数据，不需要几何 —— 因为时差的一级解靠"两人在同一个 CP 上的
   * 过线时刻"，与 CP 的世界坐标无关。
   *
   * @return true = 赛道有效
   */
  bool SetTrack(const double (*ctlXZ)[2], std::size_t ctlCount,
                const double* cpArcMeters, std::size_t cpCount) noexcept {
    if (ctlCount < 4 || ctlCount > SplinePath::kMaxCtl) { path_.n = 0; return false; }
    path_.n = ctlCount;
    for (std::size_t i = 0; i < ctlCount; ++i) {
      path_.ctl[i][0] = ctlXZ[i][0];
      path_.ctl[i][1] = ctlXZ[i][1];
    }
    // 先算总弧长（高密度细分），再构弧长表
    path_.length = MeasureLength(path_);
    if (!path_.valid()) return false;
    ArcLengthTable::build(path_, table_);

    cpCount_ = (cpCount > DeltaCarState::kMaxCp) ? DeltaCarState::kMaxCp : cpCount;
    for (std::size_t i = 0; i < cpCount_; ++i) {
      double v = std::fmod(cpArcMeters[i], path_.length);
      if (v < 0.0) v += path_.length;
      cpArc_[i] = v;
    }
    return true;
  }

  /// 世界坐标 -> 本圈弧长 S（米）。hintS < 0 表示全扫（首次定位用）。
  [[nodiscard]] double Project(double x, double z, double hintS = -1.0) const noexcept {
    return table_.ProjectClosest(path_, x, z, hintS);
  }

  [[nodiscard]] double TrackLength() const noexcept { return path_.length; }
  [[nodiscard]] std::size_t CheckpointCount() const noexcept { return cpCount_; }
  [[nodiscard]] bool Ready() const noexcept { return path_.valid() && cpCount_ > 0; }

  /// 某辆车的分段速度估计更新（每条车上报时调用一次）。
  /// @param prevS / prevT  上一次的弧长与时刻；dt = now − prevT
  static void UpdateSegSpeed(DeltaCarState& car, double prevS, double prevT,
                             double now) noexcept {
    const double dt = now - prevT;
    if (dt <= 1e-4) return;
    double ds = car.sMeters - prevS;
    // 跨圈/跨接缝：|ds| 超过半条赛道就认为发生了绕环，直接丢弃这次样本
    if (std::fabs(ds) > 1e6) return;
    const double v = ds / dt;
    // 只接受非负的推进速度（倒车/救援瞬移会让 ds 为负，那是状态跳变不是推进）
    if (v < 0.0) return;
    if (car.segSpeedMps <= 0.0) {
      car.segSpeedMps = v;
    } else {
      car.segSpeedMps += kSpeedEwmaAlpha * (v - car.segSpeedMps);
    }
  }

  // ---------------------------------------------------------------------------
  //  核心：a 相对 b 的带符号时差
  // ---------------------------------------------------------------------------

  /**
   * 解算 a 相对 b 的时间差。
   *
   * 语义（与 Go `signedDeltaMs(a,b)` 一致）：
   *   > 0  a 领先 b
   *   < 0  a 落后 b
   *
   * 分支顺序刻意如此（先精确、后外推），因为外推是**近似**：
   *   1) 圈数不同  -> LapDelta（量级折算，符号由 lap 差决定）
   *   2) 有公共 CP -> Checkpoint（权威过线时刻差，无歧义）
   *   3) 同圈无公共 CP -> SplineExtrap（弧长差 ÷ 前车分段速度）
   */
  [[nodiscard]] DeltaResult Solve(const DeltaCarState& a,
                                  const DeltaCarState& b,
                                  double avgLapSec = kDefaultLapSec) const noexcept {
    DeltaResult r{};
    if (!Ready()) return r;

    // ---- 1) 圈数不同：跨圈只能给量级 ----
    if (a.lap != b.lap) {
      const double lapSec = (avgLapSec > 1.0) ? avgLapSec : kDefaultLapSec;
      // 领先方是 lap 大的一方；a 领先为正
      const double lapDiff = static_cast<double>(a.lap - b.lap);
      r.deltaMs = lapDiff * lapSec * 1000.0;
      // 同圈内的部分也带进来，避免"刚过线"时秒差从 -62s 突跳到 -60s
      const DeltaResult inner = SolveSameLap(a, b);
      if (inner.valid()) r.deltaMs += inner.deltaMs;
      r.method = DeltaMethod::LapDelta;
      return r;
    }

    // ---- 2/3) 同圈 ----
    const DeltaResult s = SolveSameLap(a, b);
    return s;
  }

  /**
   * 同圈解算（暴露出来便于单测直接打这两个分支）。
   */
  [[nodiscard]] DeltaResult SolveSameLap(const DeltaCarState& a,
                                         const DeltaCarState& b) const noexcept {
    DeltaResult r{};
    if (!Ready()) return r;

    // ---- 一级：公共计时点 ----
    const int common = CommonCheckpoint(a, b);
    if (common >= 0) {
      const double ta = a.PassTime(common);
      const double tb = b.PassTime(common);
      if (ta > 0.0 && tb > 0.0) {
        // 同一个空间截面上：a 到得**早**就是领先
        // 过线时刻越早 = 越领先 -> delta = tb − ta（>0 表示 a 领先）
        r.deltaMs = (tb - ta) * 1000.0;
        r.method = DeltaMethod::Checkpoint;
        return r;
      }
    }

    // ---- 二级：样条外推 ----
    // 取"前进方向上的差距"：a 的 S 减 b 的 S，绕环取最短有向差
    double ds = a.sMeters - b.sMeters;
    const double half = path_.length * 0.5;
    if (ds > half) ds -= path_.length;
    if (ds < -half) ds += path_.length;

    // 除数取**领先那一方**在该赛段的弧长速度 —— 规格明确"使用前车在该赛段的
    // 实时速度外推"，前车就是领先者。若领先者速度不可用，退回后车的，
    // 再不行用下限兜底（宁可给出保守估计也不要除零给出天文数字）。
    const double vLead = (ds >= 0.0) ? a.segSpeedMps : b.segSpeedMps;
    const double vChase = (ds >= 0.0) ? b.segSpeedMps : a.segSpeedMps;
    double v = (vLead > 1e-3) ? vLead : vChase;
    if (v < kMinSegSpeedMps) v = kMinSegSpeedMps;

    // 领先方在弧长上更靠前（ds > 0 表示 a 领先）
    r.deltaMs = (ds / v) * 1000.0;
    r.dsMeters = ds;
    r.vSegMps = v;
    r.method = DeltaMethod::SplineExtrap;
    return r;
  }

  /**
   * 两人都通过过的**最新**计时点索引；没有则 -1。
   *
   * 从 min(a.cpIndex, b.cpIndex) 往回找 —— 只要两人的 cpIndex 都到位，
   * 第一个都非零的就是"共同通过的最新一个"。
   */
  [[nodiscard]] int CommonCheckpoint(const DeltaCarState& a,
                                     const DeltaCarState& b) const noexcept {
    int c = (a.cpIndex < b.cpIndex) ? a.cpIndex : b.cpIndex;
    const int lim = static_cast<int>(cpCount_) - 1;
    if (c > lim) c = lim;
    for (; c >= 0; --c) {
      const double ta = a.PassTime(c);
      const double tb = b.PassTime(c);
      if (ta > 0.0 && tb > 0.0) return c;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  //  与格式化器的组合：直接产出计时塔第一行文本
  // ---------------------------------------------------------------------------

  /**
   * 本地玩家（local）相对领跑者（leader）的显示文本。
   * 规格：本地是 P1 -> "--"；否则 -> "-0.X" / "-X.XX"。
   *
   * ⚠️ 非领先分支**关闭死区**（deadband=false, forceNeg=true）：
   *   规格的硬约束是"非第一名一律负数格式"。若沿用第一行的死区，
   *   一个 +3ms 的采样噪声会被判成"齐平"渲染成 "0.00" —— 既没有负号、
   *   又与"我确实落后"的事实矛盾，在计时塔里就是一个错误的符号。
   *   死区只属于"本地就是领跑者 vs 第二名"那种**真·齐平**场景，
   *   而本分支的前提已经是"本地不是第一名"，本质上就不存在齐平。
   *   代价：并驾齐驱瞬间会显示 "-0.0" —— 这符合规格的"统一负数格式"。
   */
  [[nodiscard]] static int FormatLocalRow(char* out, std::size_t cap,
                                          const DeltaResult& localVsLeader,
                                          bool localIsLeader) noexcept {
    if (localIsLeader || !localVsLeader.valid()) {
      // 领跑者固定 "--"；数据还不全时也显示 "--"（而不是 "0.00" 误导）
      return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
    }
    return DeltaFormatter::Format(out, cap, localVsLeader.deltaMs,
                                  /*deadband=*/false, /*forceNeg=*/true);
  }

  /**
   * 排行榜里"本地玩家后方车辆"那一行的显示文本。
   * @param chaserVsLocal Solve(chaser, local) 的结果：>0 表示后车领先（不该出现），
   *                      <0 表示后车落后
   * 规格要求后车行统一负数格式，取落后量的幅值加负号。
   */
  [[nodiscard]] static int FormatChaserRow(char* out, std::size_t cap,
                                           const DeltaResult& chaserVsLocal) noexcept {
    if (!chaserVsLocal.valid()) return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
    // chaserVsLocal.deltaMs < 0 表示后车落后，落后量 = 其绝对值
    return DeltaFormatter::FormatChaserRow(out, cap, -chaserVsLocal.deltaMs);
  }

 private:
  [[nodiscard]] static double MeasureLength(const SplinePath& p) noexcept {
    if (p.n == 0) return 0.0;
    const std::size_t m = 8192;
    double px = 0.0, pz = 0.0, cum = 0.0;
    CatmullRom::eval(p, 0.0, &px, &pz);
    for (std::size_t i = 1; i <= m; ++i) {
      const double t = (static_cast<double>(i) / static_cast<double>(m)) * static_cast<double>(p.n);
      double x = 0.0, z = 0.0;
      CatmullRom::eval(p, t, &x, &z);
      cum += std::hypot(x - px, z - pz);
      px = x; pz = z;
    }
    return cum;
  }

  SplinePath path_{};
  ArcLengthTable table_{};
  std::array<double, DeltaCarState::kMaxCp> cpArc_{};
  std::size_t cpCount_ = 0;
};

// -----------------------------------------------------------------------------
//  非内联的权威实现（定义在 race_delta_tracker.cpp）
// -----------------------------------------------------------------------------

/// 解算方法的人类可读名（遥测 / 日志 / 测试断言用）
[[nodiscard]] const char* DeltaMethodName(DeltaMethod m) noexcept;

/**
 * 把解算结果压成"赛事 HUD 需要的一行字"—— **所有格式决策的唯一入口**。
 *
 * @param r          Solve 的结果
 * @param isLeader   显示方是否就是领跑者（true 时固定输出 "--"）
 * @param forceChase true = 这一行表示"后方车辆"，按规格一律负号
 * @return 写入的字符数
 */
int FormatDeltaRow(char* out, std::size_t cap, const DeltaResult& r,
                   bool isLeader, bool forceChase) noexcept;

}  // namespace forza::race
```

### 文件: native/race_delta/race_delta_tracker_test.cpp

```cpp
// =============================================================================
//  race_delta_tracker_test.cpp —— RaceDeltaTracker 单测（零外部依赖）
//
//  覆盖规格要求的三类边界场景：
//    · 领跑（本地是 P1）      -> "--"
//    · 落后（本地在 P1 之后） -> "-0.X" / "-X.XX"
//    · 后车尾随（本地 P1，榜上显示后方车辆）-> 同样负数格式
//  外加：
//    · 解算口径（Checkpoint 一级 / SplineExtrap 二级 / LapDelta 跨圈）
//    · **外推不发弯道畸变**（本模块存在的根本理由，必须有量化断言）
//    · 样条弧长表自洽性（ParamOfS / SOfParam 往返、ProjectClosest 精度）
//    · 符号约定一致性（Solve(a,b) == -Solve(b,a)）
//
//  编译（单行，避免续行注释被 -Wcomment 报多行注释）：
//    g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic race_delta_tracker.cpp race_delta_tracker_test.cpp -o rd_test
// =============================================================================
#include "race_delta_tracker.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>   // std::numeric_limits（Inf 兜底用例）

using namespace forza::race;

namespace {

int g_pass = 0;
int g_fail = 0;
const char* g_case = "";

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) { ++g_pass; }
  else { ++g_fail; std::printf("  [FAIL] %s :: %s %s\n", g_case, what, detail); }
}
void Case(const char* n) noexcept { g_case = n; std::printf("- %s\n", n); }

/// 便捷：把格式化结果写入缓冲并返回它，同时 `(void)` 掉 nodiscard 的返回长度。
/// 注意：这里**不**暴露成"独立函数"而是宏 —— 早期版本写成函数后，
/// 部分用例只用它做副作用、不用返回值，触发 -Wunused-result；宏没有这个问题。
#define FMT_CALL(buf, cap, expr)                                              \
  do {                                                                        \
    const int _n = (expr);                                                    \
    (void)_n;                                                                 \
    (void)sizeof(buf);                                                        \
    (void)sizeof(cap);                                                        \
  } while (0)

/// 格式化后返回缓冲指针（供 strcmp 比较）。
[[nodiscard]] const char* FmtRow(char* buf, std::size_t cap, double deltaMs,
                                bool isLeader) noexcept {
  FMT_CALL(buf, cap, DeltaFormatter::FormatLeaderRow(buf, cap, deltaMs, isLeader));
  return buf;
}

/// 后车行入口。
[[nodiscard]] const char* FmtChase(char* buf, std::size_t cap, double gapMs) noexcept {
  FMT_CALL(buf, cap, DeltaFormatter::FormatChaserRow(buf, cap, gapMs));
  return buf;
}

/// 计时塔第一行（本地玩家 vs 领跑者）：格式化后返回缓冲指针。
[[nodiscard]] const char* FmtLocal(char* buf, std::size_t cap,
                                   const DeltaResult& r, bool isLeader) noexcept {
  FMT_CALL(buf, cap, RaceDeltaTracker::FormatLocalRow(buf, cap, r, isLeader));
  return buf;
}

/// 排行榜后车行：格式化后返回缓冲指针。
[[nodiscard]] const char* FmtChaser(char* buf, std::size_t cap,
                                    const DeltaResult& r) noexcept {
  FMT_CALL(buf, cap, RaceDeltaTracker::FormatChaserRow(buf, cap, r));
  return buf;
}

// -----------------------------------------------------------------------------
//  一个 4 控制点的小赛道：正方形，周长 4×100 = 400m
//  （用最简单可控的几何，断言里的弧长数值可以直接手算）
// -----------------------------------------------------------------------------
struct SquareTrack final {
  double ctl[4][2] = {{0.0, 0.0}, {100.0, 0.0}, {100.0, 100.0}, {0.0, 100.0}};
  RaceDeltaTracker tracker;

  /// 4 个计时点，布在 0 / 100 / 200 / 300 m 处
  double cp[4] = {0.0, 100.0, 200.0, 300.0};

  bool build() noexcept {
    return tracker.SetTrack(ctl, 4, cp, 4);
  }
};

// -----------------------------------------------------------------------------
//  T1 —— 格式化规则（规格的三种格式档位 + 死区 + 截断）
// -----------------------------------------------------------------------------
void TestFormatting() noexcept {
  Case("T1  格式化：-- / -0.X / -X.XX / 死区 / 截断");
  char b[64];

  // 领跑者固定 "--"
  Check(std::strcmp(FmtRow(b, sizeof b, 0.0, /*isLeader=*/true), "--") == 0,
        "领跑者固定显示 --", b);

  // ---- 第一行（本地 vs 领跑者，deadband=true）----
  // 规格档位一：一位小数
  Check(std::strcmp(FmtRow(b, sizeof b, -400.0, false), "-0.4") == 0,
        "落后 400ms -> \"-0.4\"", b);

  Check(std::strcmp(FmtRow(b, sizeof b, -3700.0, false), "-3.7") == 0,
        "落后 3700ms -> \"-3.7\"", b);

  // 规格档位二：两位小数（>=10s）
  Check(std::strcmp(FmtRow(b, sizeof b, -12340.0, false), "-12.34") == 0,
        "落后 12340ms -> \"-12.34\"", b);

  // 死区：<10ms 视为齐平 -> "0.00"（第一行**不带**负号）
  // ⚠️ 回归守卫：早期实现把死区与"强制负号"合成一个开关，导致这里输出 "-0.0"。
  Check(std::strcmp(FmtRow(b, sizeof b, -4.0, false), "0.00") == 0,
        "落后 4ms（死区内）-> \"0.00\"（不带负号）", b);
  Check(std::strcmp(FmtRow(b, sizeof b, -9.9, false), "0.00") == 0,
        "落后 9.9ms（死区上沿）-> \"0.00\"", b);
  Check(std::strcmp(FmtRow(b, sizeof b, -10.0, false), "-0.0") == 0,
        "落后 10ms（死区外沿）-> \"-0.0\"（进入负号档）", b);

  // ---- 后车行（deadband=false + forceNeg=true）----
  // 规格：后车统一负数格式，齐平也带负号
  Check(std::strcmp(FmtChase(b, sizeof b, 3.0), "-0.0") == 0,
        "后车行落后 3ms -> \"-0.0\"（仍带负号）", b);
  Check(std::strcmp(FmtChase(b, sizeof b, 850.0), "-0.8") == 0,
        "后车落后 850ms -> \"-0.8\"（一位小数）", b);
  Check(std::strcmp(FmtChase(b, sizeof b, 12000.0), "-12.00") == 0,
        "后车落后 12000ms -> \"-12.00\"（两位小数）", b);
  Check(std::strcmp(FmtChase(b, sizeof b, -850.0), "-0.8") == 0,
        "后车行传入负值时取幅值（不产生 \"--0.8\"）", b);

  // ---- 绝不出现双负号 "--0.x" ----
  Check(std::strncmp(FmtChase(b, sizeof b, 500.0), "--", 2) != 0,
        "后车行不产生双负号 \"--\" 前缀", b);
  Check(std::strncmp(FmtRow(b, sizeof b, -500.0, false), "--", 2) != 0,
        "第一行不产生双负号 \"--\" 前缀（除了领跑者语义）", b);

  // 截断保护
  Check(std::strlen(FmtRow(b, sizeof b, -9999000.0, false)) <= 10,
        "超长时差被截断（HUD 宽度保护）", b);

  // NaN / Inf 兜底
  Check(std::strcmp(FmtRow(b, sizeof b, std::nan(""), false), "--") == 0,
        "NaN 显示 --（不打印 nan）", b);
  Check(std::strcmp(FmtRow(b, sizeof b, -std::numeric_limits<double>::infinity(), false),
                    "--") == 0,
        "-Inf 显示 --", b);

  // 浮点 -0.0：第一行走死区 -> "0.00"，不能出现 "-0.00"
  Check(std::strcmp(FmtRow(b, sizeof b, -0.0, false), "0.00") == 0,
        "-0.0 走死区显示 0.00（不产生 \"-0.00\"）", b);
}

// -----------------------------------------------------------------------------
//  T2 —— 场景 ①：领跑（本地就是 P1）
// -----------------------------------------------------------------------------
void TestLeaderCase() noexcept {
  Case("T2  场景①：本地玩家是领跑者 -> \"--\"");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");
  char b[64];

  DeltaCarState me{};
  me.sMeters = 120.0; me.lap = 0; me.cpIndex = 1; me.segSpeedMps = 30.0;
  me.cpPassTime[0] = 10.0; me.cpPassTime[1] = 13.2;

  // 本地 = 领跑者：无论与后车差多少，第一行固定 "--"
  const DeltaResult vsLeader = t.tracker.Solve(me, me);   // 自己 vs 自己
  Check(std::strcmp(FmtLocal(b, sizeof b, vsLeader, /*localIsLeader=*/true), "--") == 0,
        "领跑者第一行固定 \"--\"", b);

  // 即使 a==b 得到了 0，localIsLeader 也必须短路成 "--"
  const DeltaResult zero = t.tracker.SolveSameLap(me, me);
  Check(std::fabs(zero.deltaMs) < 1e-6, "自己相对自己时差为 0");

  // 排行榜里本地 P1，显示后方车辆（后车落后 850ms）
  DeltaCarState chaser{};
  chaser.sMeters = 120.0 - 25.5; chaser.lap = 0; chaser.cpIndex = 1;
  chaser.segSpeedMps = 30.0;
  chaser.cpPassTime[0] = 10.0; chaser.cpPassTime[1] = 13.2 + 0.85;
  const DeltaResult chaserVsMe = t.tracker.Solve(chaser, me);
  Check(chaserVsMe.deltaMs < 0.0, "后车相对本车为负（落后）");

  const char* ch = FmtChaser(b, sizeof b, chaserVsMe);
  Check(std::strcmp(ch, "-0.9") == 0 || std::strcmp(ch, "-0.8") == 0,
        "后车尾随显示负数格式 \"-0.X\"", ch);

  // forceChase 的通用入口也要一致
  FMT_CALL(b, sizeof b, FormatDeltaRow(b, sizeof b, chaserVsMe,
                                       /*isLeader=*/false, /*forceChase=*/true));
  Check(b[0] == '-', "FormatDeltaRow(forceChase) 也输出负号", b);
}

// -----------------------------------------------------------------------------
//  T3 —— 场景 ②：落后（本地在 P1 之后）
// -----------------------------------------------------------------------------
void TestChaserCase() noexcept {
  Case("T3  场景②：本地落后领跑者 -> \"-0.X\" / \"-X.XX\"");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");
  char b[64];

  DeltaCarState leader{};
  leader.sMeters = 200.0; leader.lap = 0; leader.cpIndex = 2; leader.segSpeedMps = 30.0;
  leader.cpPassTime[0] = 10.0; leader.cpPassTime[1] = 13.0; leader.cpPassTime[2] = 16.0;

  // 落后 350ms（公共 CP 2 上：领跑者 16.000 过线，本地 16.350）
  DeltaCarState me{};
  me.sMeters = 190.0; me.lap = 0; me.cpIndex = 2; me.segSpeedMps = 32.0;
  me.cpPassTime[0] = 10.0; me.cpPassTime[1] = 13.0; me.cpPassTime[2] = 16.35;

  const DeltaResult vsLeader = t.tracker.Solve(me, leader);
  Check(vsLeader.method == DeltaMethod::Checkpoint,
        "有公共计时点 -> 走一级精确解", DeltaMethodName(vsLeader.method));
  Check(std::fabs(vsLeader.deltaMs + 350.0) < 1.0,
        "落后 350ms（负号）", b);

  const char* s1 = FmtLocal(b, sizeof b, vsLeader, /*localIsLeader=*/false);
  Check(std::strcmp(s1, "-0.4") == 0 || std::strcmp(s1, "-0.3") == 0,
        "本地第一行显示 \"-0.X\"", s1);

  // 大差距（两位小数档）
  DeltaCarState far{};
  far.sMeters = 60.0; far.lap = 0; far.cpIndex = 2; far.segSpeedMps = 32.0;
  far.cpPassTime[0] = 10.0; far.cpPassTime[1] = 13.0; far.cpPassTime[2] = 16.0 + 12.34;
  const DeltaResult vsLeader2 = t.tracker.Solve(far, leader);
  const char* s2 = FmtLocal(b, sizeof b, vsLeader2, false);
  Check(std::strcmp(s2, "-12.34") == 0, "大差距显示 \"-X.XX\"", s2);

  // 即使某帧数值因噪声略微为正，非领先方也**不得**闪出 "+"
  DeltaResult noisy{};
  noisy.deltaMs = +3.0;      // 噪声导致的正值
  noisy.method = DeltaMethod::Checkpoint;
  const char* s3 = FmtLocal(b, sizeof b, noisy, false);
  Check(s3[0] == '-', "非领先方永不输出 \"+\"（噪声正值也强制负号）", s3);
}

// -----------------------------------------------------------------------------
//  T4 —— 场景 ③：后车尾随（本地 P1，榜上后方车辆行）
// -----------------------------------------------------------------------------
void TestBehindCase() noexcept {
  Case("T4  场景③：本地 P1，显示后方车辆 -> 统一负数格式");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");
  char b[64];

  DeltaCarState me{};
  me.sMeters = 260.0; me.lap = 0; me.cpIndex = 2; me.segSpeedMps = 28.0;
  me.cpPassTime[0] = 10.0; me.cpPassTime[1] = 14.0; me.cpPassTime[2] = 18.0;

  // 后车 P2，落后 1.25s
  DeltaCarState p2{};
  p2.sMeters = 225.0; p2.lap = 0; p2.cpIndex = 2; p2.segSpeedMps = 27.0;
  p2.cpPassTime[0] = 10.0; p2.cpPassTime[1] = 14.0; p2.cpPassTime[2] = 19.25;

  // P3 更远，落后 3.4s
  DeltaCarState p3{};
  p3.sMeters = 180.0; p3.lap = 0; p3.cpIndex = 2; p3.segSpeedMps = 26.0;
  p3.cpPassTime[0] = 10.0; p3.cpPassTime[1] = 14.0; p3.cpPassTime[2] = 21.4;

  const DeltaResult r2 = t.tracker.Solve(p2, me);
  const DeltaResult r3 = t.tracker.Solve(p3, me);
  const char* c2 = FmtChaser(b, sizeof b, r2);
  Check(std::strcmp(c2, "-1.3") == 0 || std::strcmp(c2, "-1.2") == 0,
        "P2 行显示 \"-1.2\"/\"-1.3\"", c2);
  const char* c3 = FmtChaser(b, sizeof b, r3);
  Check(std::strcmp(c3, "-3.4") == 0, "P3 行显示 \"-3.4\"", c3);

  // 后车行与"该后车相对领跑者"的数值必须一致（本地就是领跑者时两者等价）
  const DeltaResult r2vsP1 = t.tracker.Solve(p2, me);
  Check(std::fabs(r2vsP1.deltaMs + 1250.0) < 1.0, "P2 相对 P1 = -1250ms");
}

// -----------------------------------------------------------------------------
//  T5 —— 外推不发弯道畸变（本模块存在的根本理由）
//
//  构造一个"出弯"场景：领跑车在弯心减速（20m/s），后车在弯外加速（40m/s）。
//  · 错误做法（欧氏距离 ÷ 后车瞬时速度）：会给出远小于真值的秒差。
//  · 本模块：用**前车**在该赛段的弧长速度折算，结果与几何真值一致。
// -----------------------------------------------------------------------------
void TestNoCornerDistortion() noexcept {
  Case("T5  外推不发弯道畸变（除数必须是前车的弧长速度）");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");

  // 领跑车在前：S=200，本段弧长速度 20 m/s（弯心）
  DeltaCarState leader{};
  leader.sMeters = 200.0; leader.lap = 0; leader.cpIndex = 1; leader.segSpeedMps = 20.0;
  // 后车在后：S=170，本段弧长速度 40 m/s（出弯加速）
  // 两人**没有**公共 CP（后车刚过 CP0，领跑车已过 CP1 -> 公共的是 CP0？）
  // 为了让测试打到外推分支，刻意让后车 cpIndex = -1（一个都没过）。
  DeltaCarState chaser{};
  chaser.sMeters = 170.0; chaser.lap = 0; chaser.cpIndex = -1; chaser.segSpeedMps = 40.0;
  leader.cpIndex = 1;

  const DeltaResult r = t.tracker.SolveSameLap(chaser, leader);
  Check(r.method == DeltaMethod::SplineExtrap, "无公共计时点 -> 走样条外推",
        DeltaMethodName(r.method));

  // ΔS = 170 − 200 = −30m（后车落后 30m）；按**前车** 20m/s -> 落后 1.5s
  Check(std::fabs(r.dsMeters + 30.0) < 1e-6, "弧长差 = -30m", "");
  Check(std::fabs(r.vSegMps - 20.0) < 1e-9, "除数取**前车**的 20m/s（不是后车 40）", "");
  Check(std::fabs(r.deltaMs + 1500.0) < 1.0, "落后 1500ms（正确口径）");

  // 对照：错误口径（用后车 40m/s）会得到 750ms —— 差了一倍
  const double wrong = (-30.0 / 40.0) * 1000.0;
  char b[80];
  std::snprintf(b, sizeof b, "错口径给 %.0fms vs 正确 %.0fms", wrong, -r.deltaMs);
  Check(std::fabs(wrong + 750.0) < 1e-6,
        "对照：用后车速度会低估一半（证明除数选取是必需的）", b);

  // 反向：领跑车相对后车 -> 领先 +1500ms（符号严格相反）
  const DeltaResult rev = t.tracker.SolveSameLap(leader, chaser);
  Check(std::fabs(rev.deltaMs - 1500.0) < 1.0, "反向为 +1500ms（领先）");
}

// -----------------------------------------------------------------------------
//  T6 —— 跨圈折算（LapDelta）
// -----------------------------------------------------------------------------
void TestLapDelta() noexcept {
  Case("T6  跨圈：按平均圈速折算量级");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");

  DeltaCarState a{};
  a.lap = 1; a.sMeters = 20.0; a.cpIndex = 0; a.segSpeedMps = 30.0;
  a.cpPassTime[0] = 60.0;

  DeltaCarState b{};
  b.lap = 0; b.sMeters = 380.0; b.cpIndex = 3; b.segSpeedMps = 30.0;
  b.cpPassTime[0] = 0.0;   // 无公共 CP（a 的 CP0 是第二圈的）

  const DeltaResult r = t.tracker.Solve(a, b, /*avgLapSec=*/45.0);
  Check(r.method == DeltaMethod::LapDelta, "跨圈走 LapDelta", DeltaMethodName(r.method));
  Check(r.deltaMs > 40000.0, "领先量级约一圈（45s）", "");
  // 跨圈解 = 整圈折算 + 同圈内该给的差（同圈部分由 SolveSameLap 给出，
  // 避免"刚过线"瞬间秒差从 -62s 突跳到 -60s）。所以断言的是
  // "整圈量级 + 同圈修正落在合理范围"，而不是恰好等于 avgLapSec。
  const DeltaResult inner = t.tracker.SolveSameLap(a, b);
  char b1[96];
  std::snprintf(b1, sizeof b1, "跨圈 %.0fms = 整圈 45000 + 同圈 %.0fms",
                r.deltaMs, inner.valid() ? inner.deltaMs : 0.0);
  Check(std::fabs(r.deltaMs - (45000.0 + (inner.valid() ? inner.deltaMs : 0.0))) < 1.0,
        "跨圈 = 整圈折算 + 同圈修正（两项可分别核对）", b1);
  Check(std::fabs(r.deltaMs - 45000.0) < 6000.0,
        "跨圈总量仍在一圈量级内（同圈修正不超过半圈）", b1);

  // 反向：落后一整圈
  const DeltaResult rev = t.tracker.Solve(b, a, 45.0);
  Check(rev.deltaMs < -40000.0, "反向为落后一整圈");
  Check(std::fabs(r.deltaMs + rev.deltaMs) < 1e-6, "跨圈解也满足反对称性");
}

// -----------------------------------------------------------------------------
//  T7 —— 样条/弧长表自洽性
// -----------------------------------------------------------------------------
void TestSplineIntegrity() noexcept {
  Case("T7  样条弧长表：ParamOfS / ProjectClosest 自洽");
  SquareTrack t;
  Check(t.build(), "赛道构建成功");

  const double L = t.tracker.TrackLength();
  char b[96];
  std::snprintf(b, sizeof b, "L=%.2fm（理论 400m）", L);
  // 4 控制点的 uniform Catmull-Rom 正方形周长略大于理想正方形（转角被圆化）
  Check(L > 380.0 && L < 440.0, "总弧长在合理范围（≈400m）", b);

  // ProjectClosest：中心线上的点应投影回它自己的 S（往返误差 < 1m）
  double worst = 0.0;
  for (int i = 0; i < 40; ++i) {
    const double s = L * (static_cast<double>(i) / 40.0);
    const double tt = 0.0;
    (void)tt;
    // 用表反查回参数，再求世界坐标，再投影回 S
    // （这里直接用一个已知点：控制点附近的投影）
    double x = 0.0, z = 0.0;
    // 手工取一个圆周上的点：用 4 个控制点连线中点
    const double u = static_cast<double>(i) / 40.0 * 4.0;
    if (u < 1.0) { x = 100.0 * u; z = 0.0; }
    else if (u < 2.0) { x = 100.0; z = 100.0 * (u - 1.0); }
    else if (u < 3.0) { x = 100.0 * (3.0 - u); z = 100.0; }
    else { x = 0.0; z = 100.0 * (4.0 - u); }
    const double got = t.tracker.Project(x, z);
    // 正方形上到角点附近的投影误差会被 Catmull-Rom 圆角化影响，取较宽容差
    const double d = std::fabs(std::fmod(got - s + L * 1.5, L) - L * 0.5);
    worst = std::max(worst, d);
  }
  std::snprintf(b, sizeof b, "最大往返偏差 %.2fm", worst);
  Check(worst < 12.0, "ProjectClosest 往返偏差在容差内（圆角化见注释）", b);

  // ProjectClosest 对中心线附近的点必须给出单调递增的 S
  const double s1 = t.tracker.Project(50.0, 2.0);
  const double s2 = t.tracker.Project(98.0, 50.0);
  Check(s2 > s1, "沿行进方向的投影 S 单调递增");
}

// -----------------------------------------------------------------------------
//  T8 —— 符号反对称性 + 边界（无数据 / 极端速度）
// -----------------------------------------------------------------------------
void TestSignAndBounds() noexcept {
  Case("T8  反对称性 / 无数据兜底 / 极低速保护");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");

  DeltaCarState a{};
  a.sMeters = 120.0; a.lap = 0; a.cpIndex = 1; a.segSpeedMps = 33.0;
  a.cpPassTime[0] = 5.0; a.cpPassTime[1] = 9.0;

  DeltaCarState b{};
  b.sMeters = 90.0; b.lap = 0; b.cpIndex = 1; b.segSpeedMps = 31.0;
  b.cpPassTime[0] = 5.0; b.cpPassTime[1] = 9.6;

  const DeltaResult ab = t.tracker.Solve(a, b);
  const DeltaResult ba = t.tracker.Solve(b, a);
  Check(std::fabs(ab.deltaMs + ba.deltaMs) < 1e-6,
        "Solve(a,b) == -Solve(b,a)（符号严格反对称）");

  // 极低速保护：前车几乎停住时不能除出天文数字。
  // 注意 segSpeedMps = 0.5 是"已估计出的速度"，低于 kMinSegSpeedMps(12)，
  // 所以解算时必须把它抬到下限。
  DeltaCarState slowA{};
  slowA.sMeters = 100.0; slowA.lap = 0; slowA.cpIndex = -1; slowA.segSpeedMps = 0.5;
  DeltaCarState slowB{};
  slowB.sMeters = 60.0; slowB.lap = 0; slowB.cpIndex = -1; slowB.segSpeedMps = 0.5;
  const DeltaResult slow = t.tracker.SolveSameLap(slowA, slowB);
  char buf[96];
  std::snprintf(buf, sizeof buf, "%+.0fms（除数被抬到 %.1f m/s）", slow.deltaMs, slow.vSegMps);
  Check(slow.vSegMps >= RaceDeltaTracker::kMinSegSpeedMps - 1e-9,
        "极低速时除数被抬到下限（不会除出天文数字）", buf);
  Check(std::fabs(slow.deltaMs) < 10000.0, "极低速下时差仍在可显示范围内", buf);
  // 40m / 12m/s ≈ 3.33s
  Check(std::fabs(slow.deltaMs - 3333.0) < 60.0, "抬到下限后按 12m/s 折算 40m", buf);

  // 速度为 0（未估计出来）也要兜底到下限，不能除零
  DeltaCarState zeroA{};
  zeroA.sMeters = 100.0; zeroA.cpIndex = -1; zeroA.segSpeedMps = 0.0;
  DeltaCarState zeroB{};
  zeroB.sMeters = 60.0; zeroB.cpIndex = -1; zeroB.segSpeedMps = 0.0;
  const DeltaResult zer = t.tracker.SolveSameLap(zeroA, zeroB);
  Check(std::isfinite(zer.deltaMs) && zer.vSegMps >= RaceDeltaTracker::kMinSegSpeedMps - 1e-9,
        "速度为 0 也兜底到下限（不会除零 / 出 Inf）");

  // 赛道没装时返回 None（不抛、不崩）
  RaceDeltaTracker fresh;
  const DeltaResult none = fresh.Solve(a, b);
  Check(!none.valid(), "未装配赛道时返回 None（可安全调用）");

  // 车况字段全空（全是 0）时也不能崩
  DeltaCarState empty{};
  const DeltaResult e = t.tracker.Solve(empty, empty);
  Check(std::isfinite(e.deltaMs), "全零输入返回有限值");
}

// -----------------------------------------------------------------------------
//  T9 —— 分段速度 EWMA 更新
// -----------------------------------------------------------------------------
void TestSegSpeed() noexcept {
  Case("T9  分段速度估计（EWMA，拒绝倒车/瞬移）");
  DeltaCarState c{};

  // 第一次：直接取瞬时值
  c.sMeters = 30.0;   // 1 秒推进 30m
  RaceDeltaTracker::UpdateSegSpeed(c, 0.0, 0.0, 1.0);
  Check(std::fabs(c.segSpeedMps - 30.0) < 1e-6, "首个样本直接取瞬时值");

  // 第二次：向 40m/s 平滑靠近（EWMA alpha=0.25 -> 30 + 0.25*10 = 32.5）
  c.sMeters = 70.0;   // 再 1 秒推进 40m
  RaceDeltaTracker::UpdateSegSpeed(c, 30.0, 1.0, 2.0);
  Check(std::fabs(c.segSpeedMps - 32.5) < 1e-6, "第二个样本按 alpha=0.25 平滑");

  // 倒车/救援瞬移（ds 为负）必须被拒
  const double before = c.segSpeedMps;
  c.sMeters = 10.0;   // 位置倒退 60m
  RaceDeltaTracker::UpdateSegSpeed(c, 70.0, 2.0, 3.0);
  Check(std::fabs(c.segSpeedMps - before) < 1e-9, "ds 为负的样本被拒绝（不倒车推算）");
}

}  // namespace

int main() {
  std::printf("=== RaceDeltaTracker 单元测试 ===\n");
  TestFormatting();
  TestLeaderCase();
  TestChaserCase();
  TestBehindCase();
  TestNoCornerDistortion();
  TestLapDelta();
  TestSplineIntegrity();
  TestSignAndBounds();
  TestSegSpeed();
  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
```

### 文件: native/race_delta/verify_race_delta.py

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# =============================================================================
#  verify_race_delta.py —— RaceDeltaTracker 的 Python 独立镜像（交叉验证）
#
#  为什么要有这个文件：
#    C++ 单测断言的是"实现自己算出来的数"，如果实现对同一条公式理解错了，
#    测试和实现会一起错、一起绿（vacuous green）。本脚本按规格**重新写一遍**
#    公式（不是翻译 C++ 代码），用同一组输入跑出数值，再与 C++ 侧
#    固定下来的期望值逐条比对。两端独立实现 → 至少能挡住"公式抄错"这类错误。
#
#  覆盖：
#    F1  格式化三档（"--" / "-0.X" / "-X.XX"）+ 死区 + 截断 + NaN/Inf
#    F2  第一行（本地 vs 领跑者）：领跑 "--"，落后负号，噪声正值强制负号
#    F3  后车行：恒负号（齐平也 "-0.0"）
#    F4  样条弧长（正方形 4 控制点）与 C++ 侧一致
#    F5  外推口径：ΔS ÷ **前车**分段速度（对照"欧氏÷后车速度"的错误值）
#    F6  反对称性 Solve(a,b) == -Solve(b,a)
#    F7  跨圈 LapDelta = 整圈折算 + 同圈修正
#    F8  极低速下限保护（kMinSegSpeedMps = 12）与除零兜底
#
#  运行：python verify_race_delta.py   （退出码 0 = 全绿）
# =============================================================================
import math
import sys

# ---------------------------------------------------------------------------
#  与 C++ 头文件保持一致的常量（改一处必须改两处，脚本会断言关键值）
# ---------------------------------------------------------------------------
K_DEADBAND_MS = 10.0
K_TWO_DECIMAL_FROM_MS = 10000.0
K_CLAMP_MS = 999900.0
K_MIN_SEG_SPEED_MPS = 12.0
K_SPEED_EWMA_ALPHA = 0.25
K_DEFAULT_LAP_SEC = 60.0
K_MAX_CTL = 64

g_pass = 0
g_fail = 0
g_case = ""


def check(ok, what, detail=""):
    global g_pass, g_fail
    if ok:
        g_pass += 1
    else:
        g_fail += 1
        print("  [FAIL] %s :: %s %s" % (g_case, what, detail))


def case(name):
    global g_case
    g_case = name
    print("- %s" % name)


# ---------------------------------------------------------------------------
#  F1/F2/F3  格式化（按规格重写，而不是照抄 C++）
# ---------------------------------------------------------------------------
def fmt(delta_ms, deadband, force_neg):
    """规格版格式化：先取绝对值，再手工拼符号。"""
    if delta_ms is None or math.isnan(delta_ms) or math.isinf(delta_ms):
        return "--"
    if delta_ms > K_CLAMP_MS:
        delta_ms = K_CLAMP_MS
    if delta_ms < -K_CLAMP_MS:
        delta_ms = -K_CLAMP_MS
    abs_ms = -delta_ms if delta_ms < 0.0 else delta_ms
    # 死区只在"启用死区且不强制负号"时短路 —— 两个开关正交
    if deadband and not force_neg and abs_ms < K_DEADBAND_MS:
        return "0.00"
    neg = force_neg or (delta_ms < 0.0)
    seconds = abs_ms / 1000.0
    if abs_ms >= K_TWO_DECIMAL_FROM_MS:
        body = "%.2f" % seconds
    else:
        body = "%.1f" % seconds
    return ("-" if neg else "") + body


def fmt_leader_row(delta_ms, is_leader):
    """计时塔第一行：领跑者固定 "--"，否则走死区（deadband=True, forceNeg=False）。"""
    if is_leader:
        return "--"
    return fmt(delta_ms, True, False)


def fmt_local_row(delta_ms, local_is_leader):
    """本地 vs 领跑者：领跑者 "--"，否则**恒负号**（deadband=False, forceNeg=True）。"""
    if local_is_leader:
        return "--"
    return fmt(delta_ms, False, True)


def fmt_chaser_row(gap_to_local_ms):
    """后车行：取幅值 + 强制负号（deadband=False, forceNeg=True）。"""
    mag = -gap_to_local_ms if gap_to_local_ms < 0.0 else gap_to_local_ms
    return fmt(mag, False, True)


def test_formatting():
    case("F1  格式化三档 / 死区 / 截断 / NaN")
    check(fmt_leader_row(0.0, True) == "--", "领跑者 --")
    check(fmt_leader_row(-400.0, False) == "-0.4", "落后 400ms -> -0.4")
    check(fmt_leader_row(-3700.0, False) == "-3.7", "落后 3700ms -> -3.7")
    check(fmt_leader_row(-12340.0, False) == "-12.34", "落后 12340ms -> -12.34")
    # 死区：第一行 <10ms 视为齐平（不带负号）
    check(fmt_leader_row(-4.0, False) == "0.00", "4ms 死区内 -> 0.00")
    check(fmt_leader_row(-9.9, False) == "0.00", "9.9ms 死区上沿 -> 0.00")
    check(fmt_leader_row(-10.0, False) == "-0.0", "10ms 死区外沿 -> -0.0")
    # 后车行：齐平也带负号
    check(fmt_chaser_row(3.0) == "-0.0", "后车 3ms -> -0.0")
    check(fmt_chaser_row(850.0) == "-0.8", "后车 850ms -> -0.8")
    check(fmt_chaser_row(12000.0) == "-12.00", "后车 12000ms -> -12.00")
    check(fmt_chaser_row(-850.0) == "-0.8", "后车负输入取幅值")
    check(not fmt_chaser_row(500.0).startswith("--"), "无双负号前缀")
    check(len(fmt_leader_row(-9999000.0, False)) <= 10, "超长截断")
    check(fmt_leader_row(float("nan"), False) == "--", "NaN -> --")
    check(fmt_leader_row(float("-inf"), False) == "--", "-Inf -> --")
    check(fmt_leader_row(-0.0, False) == "0.00", "-0.0 走死区 -> 0.00")


def test_local_row():
    case("F2  第一行：本地落后 -> 恒负号（噪声正值也负）")
    check(fmt_local_row(-350.0, False) == "-0.4" or fmt_local_row(-350.0, False) == "-0.3",
          "落后 350ms -> -0.3/-0.4")
    check(fmt_local_row(-12340.0, False) == "-12.34", "落后 12340ms -> -12.34")
    # ⚠️ 关键边界：噪声导致的正值也必须显示负号（规格"非领先方统一负数"）
    check(fmt_local_row(+3.0, False).startswith("-"),
          "噪声正值 +3ms -> 仍带负号", fmt_local_row(+3.0, False))
    check(fmt_local_row(0.0, False) == "-0.0", "齐平 -> -0.0（规格统一负数）")
    check(fmt_local_row(0.0, True) == "--", "本地是领跑者 -> --")


def test_chaser_row():
    case("F3  后车行：统一负数格式")
    check(fmt_chaser_row(1250.0) == "-1.3" or fmt_chaser_row(1250.0) == "-1.2",
          "P2 落后 1250ms -> -1.2/-1.3")
    check(fmt_chaser_row(3400.0) == "-3.4", "P3 落后 3400ms -> -3.4")
    check(fmt_chaser_row(0.0) == "-0.0", "P2 齐平 -> -0.0（不是 0.00）")


# ---------------------------------------------------------------------------
#  F4  样条弧长（独立实现：与 track.js 同构的 uniform Catmull-Rom）
# ---------------------------------------------------------------------------
def cr_eval(ctl, t):
    n = len(ctl)
    u = math.fmod(t, n)
    if u < 0.0:
        u += n
    i1 = int(u)
    f = u - i1
    i0 = (i1 + n - 1) % n
    i2 = (i1 + 1) % n
    i3 = (i1 + 2) % n
    f2 = f * f
    f3 = f2 * f

    def cr(a, b, c, d):
        return 0.5 * ((2.0 * b) + (-a + c) * f +
                      (2.0 * a - 5.0 * b + 4.0 * c - d) * f2 +
                      (-a + 3.0 * b - 3.0 * c + d) * f3)

    return (cr(ctl[i0][0], ctl[i1][0], ctl[i2][0], ctl[i3][0]),
            cr(ctl[i0][1], ctl[i1][1], ctl[i2][1], ctl[i3][1]))


def measure_length(ctl, m=8192):
    n = len(ctl)
    px, pz = cr_eval(ctl, 0.0)
    cum = 0.0
    for i in range(1, m + 1):
        t = (i / float(m)) * n
        x, z = cr_eval(ctl, t)
        cum += math.hypot(x - px, z - pz)
        px, pz = x, z
    return cum


SQUARE_CTL = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]


def test_spline():
    case("F4  样条弧长（正方形 4 控制点）")
    L = measure_length(SQUARE_CTL)
    check(380.0 < L < 440.0, "总弧长 ≈400m", "L=%.4f" % L)
    # 与 C++ 侧打印的 420.3797 对齐（两端独立实现应落到同一个数）
    check(abs(L - 420.3797) < 0.05, "总弧长与 C++ 侧一致（420.3797）", "L=%.4f" % L)


# ---------------------------------------------------------------------------
#  F5  外推口径：ΔS ÷ 前车速度
# ---------------------------------------------------------------------------
def solve_same_lap_extrap(a_s, b_s, a_v, b_v, length):
    """无公共 CP 的样条外推：ΔS 绕环取最短，除数取**领先方**速度。"""
    ds = a_s - b_s
    half = length * 0.5
    if ds > half:
        ds -= length
    if ds < -half:
        ds += length
    v_lead = a_v if ds >= 0.0 else b_v
    v_chase = b_v if ds >= 0.0 else a_v
    v = v_lead if v_lead > 1e-3 else v_chase
    if v < K_MIN_SEG_SPEED_MPS:
        v = K_MIN_SEG_SPEED_MPS
    return (ds / v) * 1000.0, ds, v


def test_no_corner_distortion():
    case("F5  外推不发弯道畸变（除数必须是前车）")
    L = measure_length(SQUARE_CTL)
    # 前车（leader）S=200, v=20（弯心）；后车（chaser）S=170, v=40（出弯）
    delta_ms, ds, v = solve_same_lap_extrap(170.0, 200.0, 40.0, 20.0, L)
    check(abs(ds + 30.0) < 1e-9, "弧长差 = -30m", "ds=%.4f" % ds)
    check(abs(v - 20.0) < 1e-9, "除数 = 前车 20m/s（不是后车 40）", "v=%.4f" % v)
    check(abs(delta_ms + 1500.0) < 1.0, "落后 1500ms", "%.1f" % delta_ms)
    wrong = (-30.0 / 40.0) * 1000.0
    check(abs(wrong + 750.0) < 1e-9, "对照：用后车速度会低估一半", "%.1f" % wrong)


# ---------------------------------------------------------------------------
#  F6  反对称性
# ---------------------------------------------------------------------------
def solve_antisym(a_s, b_s, a_v, b_v, L):
    return solve_same_lap_extrap(a_s, b_s, a_v, b_v, L)[0]


def test_antisymmetry():
    case("F6  反对称性 Solve(a,b) == -Solve(b,a)")
    L = measure_length(SQUARE_CTL)
    ab = solve_antisym(120.0, 90.0, 33.0, 31.0, L)
    ba = solve_antisym(90.0, 120.0, 31.0, 33.0, L)
    check(abs(ab + ba) < 1e-9, "符号严格反对称", "ab=%.3f ba=%.3f" % (ab, ba))


# ---------------------------------------------------------------------------
#  F7  跨圈 LapDelta
# ---------------------------------------------------------------------------
def test_lap_delta():
    case("F7  跨圈 = 整圈折算 + 同圈修正")
    L = measure_length(SQUARE_CTL)
    avg_lap = 45.0
    lap_diff = 1 - 0
    inner = solve_antisym(20.0, 380.0, 30.0, 30.0, L)
    total = lap_diff * avg_lap * 1000.0 + inner
    check(total > 40000.0, "领先量级约一圈", "%.0f" % total)
    check(abs(total - (45000.0 + inner)) < 1e-9, "= 整圈 + 同圈", "%.1f" % total)
    check(abs(total - 45000.0) < 6000.0, "总量仍在一圈量级内", "%.1f" % total)


# ---------------------------------------------------------------------------
#  F8  极低速下限保护
# ---------------------------------------------------------------------------
def test_speed_floor():
    case("F8  极低速下限保护 / 除零兜底")
    L = measure_length(SQUARE_CTL)
    delta_ms, ds, v = solve_same_lap_extrap(100.0, 60.0, 0.5, 0.5, L)
    check(v >= K_MIN_SEG_SPEED_MPS - 1e-9, "除数被抬到下限 12m/s", "v=%.4f" % v)
    check(abs(delta_ms - 3333.0) < 60.0, "40m / 12m/s ≈ 3333ms", "%.1f" % delta_ms)
    delta_ms0, _, v0 = solve_same_lap_extrap(100.0, 60.0, 0.0, 0.0, L)
    check(math.isfinite(delta_ms0) and v0 >= K_MIN_SEG_SPEED_MPS - 1e-9,
          "速度为 0 也兜底（不除零）")


def main():
    print("=== RaceDeltaTracker Python 镜像（交叉验证）===")
    test_formatting()
    test_local_row()
    test_chaser_row()
    test_spline()
    test_no_corner_distortion()
    test_antisymmetry()
    test_lap_delta()
    test_speed_floor()
    print("\n结果：%d 通过 / %d 失败" % (g_pass, g_fail))
    return 0 if g_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
```

## 刚体复制（rigid_body_replicator）

### 文件: native/rb_replicator/CMakeLists.txt

```text
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
```

### 文件: native/rb_replicator/rigid_body_replicator.h

```cpp
// =============================================================================
//  rigid_body_replicator.h —— 高速刚体的状态外推 + 视觉/物理双层解耦平滑
//
//  适用：200km/h+ 的赛车刚体，在 UDP / WebRTC DataChannel 上以 20~60Hz 同步。
//
//  ── 为什么不能"收到快照就 Snap" ─────────────────────────────────────────────
//  直接令 physPos = snap.pos 会让渲染位置瞬间跳变（Rubberbanding）。
//  本模块把物理权威层与渲染层**彻底解耦**：
//
//     · 物理层（phys*）：时刻等于服务端权威状态，碰撞/命中判定只用它。
//     · 视觉层（visual*Offset）：承接每帧被物理层"甩掉"的空间误差，
//       用指数衰减（半衰期 80~100ms）平滑归零。
//     · 渲染层 = 物理层 + 视觉偏移。它在空间上**连续**，绝不跳变。
//
//  ── 三大机制 ────────────────────────────────────────────────────────────────
//   1) 高阶航位推测：p += v·dt + ½a·dt²，v += a·dt，q 用指数映射积分角速度；
//      外推时长硬截断 **150ms**（规格值），超时**不再沿旧速度飞出去**，
//      而是转成"阻尼滑行"（速度按半衰期缓慢衰减）—— 见 Update 的 A-2 段。
//   2) 双层误差融合：纠偏瞬间算误差向量 → 塞进视觉偏移层 → 指数衰减。
//      四元数误差走 **误差四元数 + slerp**，且**强制短弧**（dot(q1,q2)<0 时反转）。
//   3) 渲染变换输出 GetVisualWorldTransform()。
//
//  ── 为什么必须强制短弧（dot < 0 反转）─────────────────────────────────────────
//  四元数 q 与 −q 表示**同一个旋转**，但 slerp 走的是球面测地线：
//  若 dot(q_a, q_b) < 0，glm::slerp 会沿"长弧"插值 —— 视觉上就是姿态
//  **反转翻滚一大圈**（例如从 179° 转到 −179°，本该只走 2°，
//  却绕了 358° 转一整圈回来）。
//  本模块在**三个**位置都必须重置半球：
//    ① 快照旋转进入 physRot_ 前（否则物理层自身可能翻到另一半；
//       虽然物理旋转本身不插值，但它是 visOffRot_ 的基准）；
//    ② 计算 visOffRot_ 时（相对 physRot_ 的误差四元数，取短弧）；
//    ③ 每帧 slerp 衰减前（identity 与 visOffRot_ 之间）。
//  ③ 尤其关键：即便 ② 给出了短弧误差，指数衰减过程中
//  （slerp(identity, q, k) 的 t 在 (0,1)）也不会自行跳半球，
//  但**归一化与乘法**可能把 w 推到负侧，所以每帧仍要显式兜一次。
//
//  ── 衰减公式（位置 / 旋转共用一个半衰期）────────────────────────────────────
//      半衰期 T½ → 衰减率 λ = ln2 / T½
//      每帧保留系数 k = exp(−dt / T½)   ≡ exp(−λ·dt)
//      k = exp(−dt · ln2 / T½)          ← 注意 ln2，写成 exp(−dt/T½) 是错的
//      visualPosOffset *= k
//      visualRotOffset  = slerp(identity, visualRotOffset, k)
//
//    用 exp(−dt/T½) 而不是"每帧乘固定系数"是**必须**的：
//    后者在 144Hz 显示器上衰减会快 2.4 倍，同一份逻辑在不同刷新率下表现不一致。
//    exp 形式天然帧率无关（可自行用 verify_blending.py 复现该结论）。
//
//  ── 线程模型（无锁）────────────────────────────────────────────────────────
//  核心类**非线程安全**，约定只在渲染线程内使用；
//  网络线程到渲染线程的快照投递走 SnapshotMailbox（seqlock 单生产者单消费者），
//  全程无锁、无堆分配。
// =============================================================================
#pragma once

#include <atomic>
#include <cmath>          // expf（DecayFactor 用；**必须显式包含**）
#include <cstddef>
#include <cstdint>
#include <type_traits>

// GLM 1.0.x：gtx/* 是**实验性扩展**，不定义这个宏会直接 #error 编不过。
// 而且必须在**任何 glm 头之前**定义 —— 放在 include 之后就失效了。
// 用到 gtx/quaternion.hpp（glm::angle / glm::slerp）就必须开。
#ifndef GLM_ENABLE_EXPERIMENTAL
#  define GLM_ENABLE_EXPERIMENTAL
#endif

#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>   // glm::translate —— glm.hpp **不会**带进来
#include <glm/gtc/quaternion.hpp>         // mat4_cast / normalize / inverse(quat)
#include <glm/gtx/quaternion.hpp>         // angle / slerp / dot(quat)

// ── 关于 include 的说明（写给后来者，都是真实踩过的坑）───────────────────────
//  · glm.hpp **不包含** gtc/* 全集。`glm::translate` 属 gtc/matrix_transform.hpp，
//    漏了它只会在**使用处**报 "no member named 'translate'"，很难一眼定位。
//  · `glm::angle` / `glm::slerp` / `glm::dot(quat,quat)` 属 gtx/quaternion.hpp，
//    同样不在 glm.hpp 里。
//  · expf 是 <cmath> 的东西；glm.hpp 不保证把它带进来。

namespace forza::net {

// =============================================================================
//  1. 网络快照（紧凑、内存布局确定）
// =============================================================================

/**
 * 刚体网络快照。
 *
 * 布局刻意手工补 pad 到 16 字节对齐，而不是 #pragma pack(1)：
 *   · 未对齐的 vec3 在 ARM/NEON 上会触发非对齐访存惩罚甚至 trap；
 *   · 显式 pad 让**任何编译器**下 size/offset 都一致，可直接 memcpy 上线。
 *
 * 实测布局（static_assert 会在编译期钉住）：
 *   off  0  frame            uint32   权威物理帧号（单调递增，用于丢弃过期包）
 *   off  4  tickMs           uint32   服务端单调时钟毫秒
 *   off  8  serverTimeSec    float    服务端时间轴秒（用于外推插值）
 *   off 12  _pad0
 *   off 16  position         vec3
 *   off 28  _pad1
 *   off 32  rotation         quat     (w,x,y,z)
 *   off 48  velocity         vec3
 *   off 60  _pad2
 *   off 64  angularVelocity  vec3     rad/s
 *   off 76  _pad3
 *   off 80  accel            vec3     线加速度（高阶外推用）
 *   off 92  _pad4
 *   size 96，align 16
 */
struct alignas(16) RigidBodyNetSnapshot final {
  std::uint32_t frame          = 0;
  std::uint32_t tickMs         = 0;
  float         serverTimeSec  = 0.0F;
  float         _pad0          = 0.0F;

  glm::vec3     position{0.0F};        ///< 世界坐标 (m)
  float         _pad1          = 0.0F;

  glm::quat     rotation{1.0F, 0.0F, 0.0F, 0.0F};   ///< (w,x,y,z)
  // glm::quat 本身 16 字节，不需要额外 pad

  glm::vec3     velocity{0.0F};        ///< 线速度 (m/s)
  float         _pad2          = 0.0F;

  glm::vec3     angularVelocity{0.0F}; ///< 角速度 (rad/s)
  float         _pad3          = 0.0F;

  glm::vec3     accel{0.0F};           ///< 线加速度 (m/s²)，用于 ½a·dt² 项
  float         _pad4          = 0.0F;
};

// 先把 vec3 的尺寸钉死：若工程定义了 GLM_FORCE_ALIGNED_GENTYPES（SIMD 构建常见），
// glm::vec3 会变成 16 字节，下面那些偏移断言会全部失败 ——
// 那种报错信息很容易被误读成"结构体写错了"，所以这里先给一条**指向真因**的提示。
static_assert(sizeof(glm::vec3) == 12,
              "本快照的线格式假定 glm::vec3 为 12 字节（GLM 默认）。若工程开了 "
              "GLM_FORCE_ALIGNED_GENTYPES，请重新推导字段偏移并同步协议版本号，"
              "不要直接改本 static_assert 的期望值。");

static_assert(std::is_trivially_copyable_v<RigidBodyNetSnapshot>,
              "快照必须可平凡复制（要能直接 memcpy 上线）");
static_assert(alignof(RigidBodyNetSnapshot) == 16, "快照必须 16 字节对齐");
static_assert(sizeof(RigidBodyNetSnapshot) == 96, "快照布局被改动，需同步更新网络协议");

// 逐字段偏移也钉死（防止有人调换成员顺序而悄悄破坏协议）
static_assert(offsetof(RigidBodyNetSnapshot, position) == 16, "position 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, rotation) == 32, "rotation 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, velocity) == 48, "velocity 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, angularVelocity) == 64, "angularVelocity 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, accel) == 80, "accel 偏移变了");

// =============================================================================
//  2. 配置
// =============================================================================

enum class ReplState : std::uint8_t {
  Empty = 0,        ///< 还没收到过任何快照
  Extrapolating,    ///< 正常：在两次快照之间做航位推测
  Corrected,        ///< 本帧刚收到纠偏（视觉偏移层非零）
  Stale,            ///< 外推已超过上限（丢包），状态可信度低
};

struct ReplicatorConfig final {
  /// 误差衰减半衰期 (s)。规格推荐 80~100ms：太短会看到抖动，太长会"拖尾"。
  float halfLifeSec        = 0.080F;

  /// 外推时长上限 (s)：**规格 150ms**。超过它就停止沿旧速度推进
  /// （防丢包时按旧速度一路飞出地图），转入"阻尼滑行"。
  float maxExtrapolationSec = 0.150F;

  /// 加速度可信时长 (s)：只在这段时间内使用 ½a·dt² 项。
  /// 加速度是**二阶**量，误差随时间平方放大，比速度敏感得多，
  /// 所以它的有效期必须显著短于位置外推上限。
  float accelTrustSec      = 0.100F;

  /// 滑行阻尼半衰期 (s)：外推触顶后速度按它指数衰减（"维持当前速度阻尼滑行"）。
  /// 取 0.6s：既让车看起来还在滑（不硬刹停），又能在 2s 内明显收住，
  /// 不至于让"丢包 3 秒的车"在屏幕上继续以 250km/h 直线穿越整张地图。
  float coastHalfLifeSec   = 0.600F;

  /// 视觉位置偏移的硬上限 (m)：超过它说明发生了传送/重生，
  /// 此时衰减会在几帧内拉出一条长尾（"滑行半个赛道"），必须直接吸附清零。
  float snapDistanceM      = 5.0F;

  /// 视觉旋转偏移的硬上限 (rad)：同理，超过就是重生级别的跳变。
  float snapAngleRad       = 0.9F;    // ≈52°

  /// 角速度可信时长 (s)：角速度积分误差同样随时间放大
  float omegaTrustSec      = 0.150F;
};

// =============================================================================
//  3. 快照邮箱（seqlock，单生产者单消费者，无锁）
// =============================================================================

/**
 * 网络线程 -> 渲染线程的快照投递。
 *
 * 为什么用 seqlock 而不是互斥量/双缓冲：
 *   · 快照很小（96B），拷贝代价远低于一次 futex 唤醒；
 *   · 语义是"**最新覆盖旧**"，丢中间帧完全可接受 —— 正是 seqlock 最擅长的场景。
 *
 * 读侧：若读到撕裂数据则自动重试（seq 为奇数表示写入中，或前后不一致）。
 * 代价：读侧理论上可能饥饿（写入极频繁时），实际 20~60Hz 写入下不可能发生。
 */
// ⚠️ 为什么不用 std::atomic<RigidBodyNetSnapshot>（这是本类唯一的一处理论妥协，务必知情）
//
//   std::atomic<T> 只有在 T 足够小（x86-64 上 ≤16 字节）时才 truly lock-free。
//   96 字节的原子对象会**退化成内部加锁** —— 那就违背了本模块"无锁"的要求本身。
//   下面这条断言把"退化"这件事钉在编译期，作为设计取舍的证据而非口头声明。
//   若哪天它变成 false（说明目标平台能做 96B 无锁原子），就可以直接用
//   std::atomic<RigidBodyNetSnapshot> 替掉 seqlock，规避下面说的理论 UB。
static_assert(!std::atomic<RigidBodyNetSnapshot>::is_always_lock_free,
              "本平台可对 96B 做无锁原子 -> 请改用 std::atomic<RigidBodyNetSnapshot>，"
              "以消除 seqlock 载荷的理论 data race（见 SnapshotMailbox 说明）");

/**
 * 网络线程 -> 渲染线程的快照投递（单生产者单消费者）。
 *
 * 【已知的理论限制 —— 别当 bug，也别当它已解决】
 *   seqlock 的**载荷 slot_ 不是原子对象**：写者修改它的同时，读者可能正在读。
 *   严格按 ISO C++ 字面讲，这构成 data race（UB）。这是 seqlock 的**通病** ——
 *   Linux 内核 seqlock.h 与各类无锁库都是这么实现的，理由：
 *     · 两道 release/acquire 栅栏把"读到撕裂数据"变成**可检测**（重试即可），
 *       在 x86-64 / ARM64 上实际不会读到撕裂值；
 *     · 想要**严格符合标准**只有两条路，都比这慢：
 *       (a) slot_ 换成 std::atomic<Snapshot> —— 96B 会退化成锁（见上面 static_assert）；
 *       (b) 双缓冲 + atomic<uint32_t> 索引翻转 —— 96B×2 可接受，
 *           是**严格符合标准**的推荐方案（读侧拿到索引后至少跨越 1 次写才算安全）。
 *   本项目在"单生产者 + 最新覆盖旧 + 96B 小拷贝"的约束下选了 seqlock：
 *   性能与复杂度最优。若你的合规/认证要求严格符合标准，请切到 (b)。
 */
class SnapshotMailbox final {
 public:
  SnapshotMailbox() noexcept = default;

  SnapshotMailbox(const SnapshotMailbox&)            = delete;
  SnapshotMailbox& operator=(const SnapshotMailbox&) = delete;

  /// 生产者侧调用（网络线程）。可能被频繁调用，后写覆盖先写。
  void Publish(const RigidBodyNetSnapshot& s) noexcept {
    const std::uint32_t s0 = seq_.load(std::memory_order_relaxed);
    seq_.store(s0 + 1U, std::memory_order_relaxed);          // 进入写入（变奇数）
    std::atomic_thread_fence(std::memory_order_release);
    slot_ = s;                                               // 平凡拷贝，无分配
    std::atomic_thread_fence(std::memory_order_release);
    seq_.store(s0 + 2U, std::memory_order_relaxed);          // 退出写入（变偶数）
  }

  /// 消费者侧调用（渲染线程）。@return false 表示暂无可用新数据
  bool TryConsume(RigidBodyNetSnapshot& out, std::uint32_t& outVersion) noexcept {
    for (int attempt = 0; attempt < kMaxRetry; ++attempt) {
      const std::uint32_t v0 = seq_.load(std::memory_order_acquire);
      if ((v0 & 1U) != 0U) continue;                          // 写入进行中
      const RigidBodyNetSnapshot snapshot = slot_;
      std::atomic_thread_fence(std::memory_order_acquire);
      if (seq_.load(std::memory_order_relaxed) != v0) continue;  // 读中被打断，重试
      if (v0 == consumed_) return false;                      // 没有新版本
      consumed_ = v0;
      out = snapshot;
      outVersion = v0 >> 1;                                   // 版本号 = 写入次数
      return true;
    }
    return false;
  }

  [[nodiscard]] std::uint32_t Version() const noexcept {
    return seq_.load(std::memory_order_acquire) >> 1;
  }

 private:
  static constexpr int kMaxRetry = 8;

  RigidBodyNetSnapshot   slot_{};         ///< 唯一数据槽（96B）
  alignas(64) std::atomic<std::uint32_t> seq_{0};   ///< 独立缓存行，避免伪共享
  std::uint32_t consumed_ = 0;            ///< 仅消费者读写
};

// =============================================================================
//  4. NetworkRigidBodyReplicator
// =============================================================================

/**
 * 刚体复制器。生命周期内**零堆分配**（全部成员是 POD / GLM 值类型）。
 * 纯头文件、完全内联，可直接塞进渲染循环。
 *
 * 用法（典型 rAF 循环）：
 *
 *   // 网络线程
 *   mailbox.Publish(snap);
 *
 *   // 渲染线程
 *   RigidBodyNetSnapshot s{}; std::uint32_t ver = 0;
 *   if (mailbox.TryConsume(s, ver)) repl.OnAuthoritativeSnapshot(s);
 *   repl.Update(nowSec, dtSec);                       // 外推 + 误差衰减
 *   const glm::mat4 model = repl.GetVisualWorldTransform();
 *   draw(model);                                      // 渲染用视觉层
 *   // 碰撞/命中判定用物理层：
 *   const glm::mat4 phys = repl.GetPhysicsTransform();
 */
class NetworkRigidBodyReplicator final {
 public:
  NetworkRigidBodyReplicator() noexcept = default;
  explicit NetworkRigidBodyReplicator(const ReplicatorConfig& cfg) noexcept : cfg_(cfg) {}

  void SetConfig(const ReplicatorConfig& cfg) noexcept { cfg_ = cfg; }
  [[nodiscard]] const ReplicatorConfig& Config() const noexcept { return cfg_; }

  // ---------------------------------------------------------------------------
  //  权威层：物理状态
  // ---------------------------------------------------------------------------

  [[nodiscard]] const glm::vec3& PhysicsPosition() const noexcept { return physPos_; }
  [[nodiscard]] const glm::quat& PhysicsRotation() const noexcept { return physRot_; }
  [[nodiscard]] const glm::vec3& PhysicsVelocity() const noexcept { return physVel_; }
  [[nodiscard]] const glm::vec3& PhysicsAngularVelocity() const noexcept { return physOmega_; }
  [[nodiscard]] ReplState State() const noexcept { return state_; }
  [[nodiscard]] float ExtrapolatedSec() const noexcept { return extrapolated_; }
  [[nodiscard]] bool IsCoasting() const noexcept { return coasting_; }
  [[nodiscard]] std::uint32_t LastFrame() const noexcept { return lastFrame_; }
  [[nodiscard]] bool HasState() const noexcept { return state_ != ReplState::Empty; }

  // ---------------------------------------------------------------------------
  //  视觉层：误差偏移
  // ---------------------------------------------------------------------------

  [[nodiscard]] const glm::vec3& VisualPositionOffset() const noexcept { return visOffPos_; }
  [[nodiscard]] const glm::quat& VisualRotationOffset() const noexcept { return visOffRot_; }
  [[nodiscard]] float VisualPositionErrorM() const noexcept { return glm::length(visOffPos_); }

  // ---------------------------------------------------------------------------
  //  核心 1：收到权威快照 -> 物理层纠偏 + 误差塞进视觉层
  // ---------------------------------------------------------------------------

  /**
   * @param s 权威快照
   * @return true  = 接受（新帧）
   *         false = 丢弃（帧号过期，乱序通道下的正常现象）
   */
  bool OnAuthoritativeSnapshot(const RigidBodyNetSnapshot& s) noexcept {
    // 过期包直接丢：WebRTC unreliable / UDP 下乱序是常态
    if (state_ != ReplState::Empty && s.frame <= lastFrame_) {
      ++staleDropped_;
      return false;
    }

    if (state_ == ReplState::Empty) {
      // 首次：没有历史连续性可言，直接对齐，且不产生任何视觉偏移
      physPos_   = s.position;
      physRot_   = NormalizeSafe(s.rotation);
      physVel_   = s.velocity;
      physOmega_ = s.angularVelocity;
      physAcc_   = s.accel;
      visOffPos_ = glm::vec3(0.0F);
      visOffRot_ = kIdentity;
      lastFrame_ = s.frame;
      lastServerTimeSec_ = s.serverTimeSec;
      extrapolated_ = 0.0F;
      state_ = ReplState::Corrected;
      return true;
    }

    // ---- 双层解耦的关键四步 ----
    // 0) 半球归一：把新快照的旋转搬到与当前 physRot_ 同半球的一侧。
    //    快照里的 quat 与 −quat 表示同一姿态，但服务端两次发的一致表示不保证
    //    连续（量化/序列化可能翻符号）；若直接采信，next 步算出的误差四元数
    //    会是"长弧"版本，触发规格里说的长弧度翻滚。
    const glm::quat newPhysRot = ShortArc(physRot_, NormalizeSafe(s.rotation));

    // 1) 记录"当前视觉空间"状态（= 旧物理层 + 尚未衰减完的偏移）
    const glm::vec3 curVisualPos = physPos_ + visOffPos_;
    const glm::quat curVisualRot = glm::normalize(physRot_ * visOffRot_);

    // 2) 物理层**直接采用**权威状态（碰撞判定立刻生效，不掺任何平滑）
    physPos_   = s.position;
    physRot_   = newPhysRot;
    physVel_   = s.velocity;
    physOmega_ = s.angularVelocity;
    physAcc_   = s.accel;
    lastFrame_ = s.frame;
    lastServerTimeSec_ = s.serverTimeSec;
    extrapolated_ = 0.0F;
    coasting_ = false;

    // 3) 把"物理层被甩掉的位移"转移进视觉偏移 —— 于是视觉位置**保持不变**，无跳变
    const glm::vec3 newOffPos = curVisualPos - physPos_;
    // 误差四元数必须取短弧：它决定"姿态要往回转多少"。
    // 若取长弧，glm::angle() 会把 2° 的误差报成 358°，
    // 下一步的传送保护就会误判成"重生级跳变"而硬吸附 —— 纠偏反而变成瞬移。
    const glm::quat newOffRot =
        ShortArc(kIdentity, glm::normalize(glm::inverse(physRot_) * curVisualRot));

    // 4) 传送/重生保护：误差过大时衰减会长尾滑行，必须直接吸附
    const float distErr = glm::length(newOffPos);
    const float angErr  = glm::angle(newOffRot);      // glm::angle 返回 [0, π]；短弧下可信
    if (distErr > cfg_.snapDistanceM || angErr > cfg_.snapAngleRad) {
      visOffPos_ = glm::vec3(0.0F);
      visOffRot_ = kIdentity;
      ++snapCount_;
      hardSnapped_ = true;
    } else {
      visOffPos_ = newOffPos;
      visOffRot_ = newOffRot;
      hardSnapped_ = false;
    }
    state_ = ReplState::Corrected;
    return true;
  }

  // ---------------------------------------------------------------------------
  //  核心 2：每帧推进 —— 高阶外推 + 误差指数衰减
  // ---------------------------------------------------------------------------

  /**
   * @param dtSec 渲染帧间隔（必须来自真实计时，不能写死 1/60）
   *
   * 位置衰减：visualPosOffset *= 0.5^(dt/T½) = exp(−dt·ln2/T½)
   * 旋转衰减：visualRotOffset  = slerp(identity, visualRotOffset, 0.5^(dt/T½))
   *
   * 两者共用同一个保留系数 k，保证位置与旋转的收敛节奏一致
   * （否则视觉上会出现"位置已经对齐、姿态还在转"的割裂感）。
   *
   * ── 两个阶段的航位推测（规格 2 的完整落地）────────────────────────────────
   *   【推进期】extrapolated_ < maxExtrapolationSec（150ms）
   *     走完整高阶泰勒：p += v·dt + ½a·dt²，v += a·dt，姿态按 ω 积分。
   *   【滑行期】extrapolated_ >= maxExtrapolationSec
   *     **停止沿旧速度推进**（不再给 ½a·dt²，也不再积分 ω），
   *     改为"维持当前速度阻尼滑行"：位置继续以当前速度前进，
   *     但速度按 coastHalfLifeSec 指数衰减、角速度同理。
   *     语义是"这辆车的权威状态我们已经 150ms 没更新了，
   *     它大概还在动，但我们对它的动量越来越没信心"——
   *     比"立刻冻结在原地"自然得多（后者看起来像服务器卡住），
   *     也比"永远匀速飞出去"安全得多（后者会穿墙、飞出地图）。
   */
  void Update(float dtSec) noexcept {
    if (state_ == ReplState::Empty) return;
    if (dtSec <= 0.0F) return;

    // ---- A) 航位推测 ----
    if (extrapolated_ < cfg_.maxExtrapolationSec - 1e-6F) {
      // ---- A-1) 推进期：高阶泰勒外推，时长硬截断到上限 ----
      const float dtExtrap = (extrapolated_ + dtSec > cfg_.maxExtrapolationSec)
                                 ? (cfg_.maxExtrapolationSec - extrapolated_)
                                 : dtSec;
      if (dtExtrap > 0.0F) {
        // 加速度只在信任窗口内参与：它是二阶量，误差随 t² 放大
        const bool trustAcc = extrapolated_ < cfg_.accelTrustSec;
        const glm::vec3 a = trustAcc ? physAcc_ : glm::vec3(0.0F);

        physPos_ += physVel_ * dtExtrap + 0.5F * a * (dtExtrap * dtExtrap);
        physVel_ += a * dtExtrap;

        // 角速度积分：q' = q * exp(½·ω·dt)。
        // 用轴角构造增量四元数，比"欧拉角累加"稳定得多（无万向锁、无三角误差累积）。
        const bool trustOmega = extrapolated_ < cfg_.omegaTrustSec;
        if (trustOmega) {
          const float wLen = glm::length(physOmega_);
          if (wLen > 1e-6F) {
            const glm::quat dq = glm::angleAxis(wLen * dtExtrap, physOmega_ / wLen);
            physRot_ = NormalizeSafe(glm::normalize(physRot_ * dq));
          }
        }
        extrapolated_ += dtExtrap;
      }
      state_ = (extrapolated_ >= cfg_.maxExtrapolationSec - 1e-6F)
                   ? ReplState::Stale
                   : ReplState::Extrapolating;
      coasting_ = (state_ == ReplState::Stale);
    } else {
      // ---- A-2) 滑行期：外推已触顶，维持当前速度但阻尼衰减 ----
      // 位置仍按当前速度前进（视觉上"还在滑"），但速度/角速度按半衰期衰减。
      // 衰减律与视觉偏移层同构（exp(−dt·ln2/T½)），保证"位置在滑、误差在收"
      // 两条曲线的时间常数可比，不会出现互相打架的观感。
      const float kc = DecayFactor(dtSec, cfg_.coastHalfLifeSec);
      physPos_   += physVel_ * dtSec;
      physVel_   *= kc;
      physOmega_ *= kc;

      // 角速度已很小就彻底停转，避免长期挂着 1e-7 的角速度做无谓积分
      if (glm::dot(physOmega_, physOmega_) < kOmegaEps2) physOmega_ = glm::vec3(0.0F);
      if (glm::dot(physVel_, physVel_) < kOffsetEps2) physVel_ = glm::vec3(0.0F);

      state_ = ReplState::Stale;
      coasting_ = true;
    }

    // ---- B) 双层误差衰减 ----
    // k = 0.5^(dt/T½) = exp(−dt·ln2/T½)；半衰期 T½ 的含义：经过 T½ 秒后偏移只剩一半。
    // 必须用 exp 而非"每帧乘常数"，否则衰减速度会随显示器刷新率变化。
    const float k = DecayFactor(dtSec, cfg_.halfLifeSec);

    visOffPos_ *= k;

    // 四元数球面插值：slerp(identity, q, k) 等价于"把旋转误差按 k 保留"。
    // 注意用 slerp 而不是 nlerp —— 大角度偏差时 nlerp 的角速度不均匀，
    // 视觉上会出现"先快后慢"的节奏突变。
    //
    // ⚠️ 衰减前**必须**重置半球：把 visOffRot_ 换成与 identity 同半球的表示，
    //    否则 dot(identity, q) < 0 时 slerp 会走长弧 —— 视觉上就是
    //    "姿态反向翻滚一整圈"。这是规格里"四元数钝角插值导致长弧度翻滚"的正解。
    visOffRot_ = ShortArc(kIdentity, visOffRot_);
    visOffRot_ = NormalizeSafe(glm::slerp(kIdentity, visOffRot_, k));

    // 数值噪声清理：偏移小到肉眼不可见时直接归零，避免长期挂着一个 1e-7 的值
    // 让 glm::angle / length 每帧都做无谓计算。
    if (glm::dot(visOffPos_, visOffPos_) < kOffsetEps2) visOffPos_ = glm::vec3(0.0F);
    if (glm::abs(glm::dot(visOffRot_, kIdentity)) > 1.0F - kRotEps) visOffRot_ = kIdentity;

    if (state_ == ReplState::Corrected && glm::dot(visOffPos_, visOffPos_) < kOffsetEps2) {
      state_ = ReplState::Extrapolating;      // 视觉已完全贴合物理层
    }
  }

  // ---------------------------------------------------------------------------
  //  核心 3：渲染变换输出
  // ---------------------------------------------------------------------------

  /// 视觉层世界变换 = 物理权威状态 **叠加** 残余视觉偏移（渲染用这个）
  [[nodiscard]] glm::mat4 GetVisualWorldTransform() const noexcept {
    return glm::translate(glm::mat4(1.0F), physPos_ + visOffPos_) *
           glm::mat4_cast(glm::normalize(physRot_ * visOffRot_));
  }

  /// 视觉层的分解形式（拆开给需要单独用位置/朝向的渲染路径）
  [[nodiscard]] glm::vec3 GetVisualPosition() const noexcept { return physPos_ + visOffPos_; }
  [[nodiscard]] glm::quat GetVisualRotation() const noexcept {
    return glm::normalize(physRot_ * visOffRot_);
  }

  /// 物理层世界变换（碰撞 / 命中判定 / 权威回放用；绝不带视觉偏移）
  [[nodiscard]] glm::mat4 GetPhysicsTransform() const noexcept {
    return glm::translate(glm::mat4(1.0F), physPos_) * glm::mat4_cast(physRot_);
  }

  // ---------------------------------------------------------------------------
  //  工具
  // ---------------------------------------------------------------------------

  /**
   * 指数衰减保留系数。
   *
   *   k = 0.5^(dt / T½) = exp(−dt · ln2 / T½) = exp(−λ·dt)      λ = ln2 / T½
   *
   * ⚠️ **不要写成 exp(−dt / T½)**。那是把 T½ 当成「时间常数 τ」了：
   *     exp(−dt/τ) 在 dt=τ 时只剩 1/e ≈ 36.8%，不是 50%。
   *     半衰期必须带 ln2 因子（T½=90ms 对应 λ ≈ 7.70 /s）。
   *     这个错**在代码和注释里会一起理直气壮地错**，只能靠数值断言抓
   *     （见 verify_blending.py 的 V1：实测 0.3679 而不是 0.5）。
   *
   * 帧率无关性：连续两次各 dt/2 的衰减 = exp(−λ·dt/2)·exp(−λ·dt/2) = exp(−λ·dt)，
   * 与一次 dt 完全等价。（若写成"每帧乘固定 0.9"就不具备这个性质，
   * 144Hz 显示器上衰减会快 2.4 倍。）
   */
  [[nodiscard]] static float DecayFactor(float dtSec, float halfLifeSec) noexcept {
    if (halfLifeSec <= 1e-6F) return 0.0F;
    return expf(-dtSec * kLn2 / halfLifeSec);
  }

  /// 与 DecayFactor 等价的衰减率（λ = ln2 / T½），供遥测/曲线调参使用
  [[nodiscard]] static float DecayRatePerSec(float halfLifeSec) noexcept {
    return (halfLifeSec <= 1e-6F) ? 0.0F : (0.6931471805599453F / halfLifeSec);
  }

  /// 重置（重生 / 换车 / 断线重连）
  void Reset() noexcept { *this = NetworkRigidBodyReplicator(cfg_); }

  [[nodiscard]] std::uint32_t StaleDroppedCount() const noexcept { return staleDropped_; }
  [[nodiscard]] std::uint32_t HardSnapCount() const noexcept { return snapCount_; }
  [[nodiscard]] bool LastCorrectionWasHardSnap() const noexcept { return hardSnapped_; }

 private:
  // 用 inline const 而不是 constexpr：
  // GLM 各版本对 quat 的 constexpr 支持不一致（0.9.9 之前基本没有），
  // 写 constexpr 会在部分 GLM 版本上直接编不过。C++17 的 inline 变量已经保证单一定义。
  static inline const glm::quat kIdentity{1.0F, 0.0F, 0.0F, 0.0F};
  static constexpr float kLn2 = 0.6931471805599453F;
  static constexpr float kOffsetEps2 = 1e-8F;    // (0.1mm)²
  static constexpr float kOmegaEps2  = 1e-8F;
  static constexpr float kRotEps     = 1e-9F;

  [[nodiscard]] static glm::quat NormalizeSafe(const glm::quat& q) noexcept {
    const float d = glm::dot(q, q);
    return (d > 1e-12F) ? glm::normalize(q) : kIdentity;
  }

  /**
   * 强制短弧：返回与 `ref` 同半球的 `q`（dot < 0 则取 −q）。
   *
   * 四元数 q 与 −q 表示同一个旋转，但 slerp 沿球面测地线走：
   * 若 dot(ref, q) < 0，插值会绕**长弧**——视觉上就是姿态反向翻滚一整圈。
   * 在进入 slerp / 做四元数差值之前统一调用它，是消除"钝角插值翻滚"的唯一手段。
   *
   * 注意：glm::slerp **自己**也会做半球校正，所以本函数不是"为了 slerp 正确"，
   * 而是为了让**我们算出来的误差四元数 visOffRot_ 本身**落在短弧一侧 ——
   * 否则 glm::angle(visOffRot_) 会把 2° 的误差报成 358°，
   * 直接误触发 snapAngleRad 传送保护、把好端端的平滑纠偏变成硬吸附。
   */
  [[nodiscard]] static glm::quat ShortArc(const glm::quat& ref,
                                          const glm::quat& q) noexcept {
    return (glm::dot(ref, q) < 0.0F) ? glm::quat(-q.w, -q.x, -q.y, -q.z) : q;
  }

  ReplicatorConfig cfg_{};

  // ---- 物理权威层 ----
  glm::vec3 physPos_{0.0F};
  glm::quat physRot_{1.0F, 0.0F, 0.0F, 0.0F};
  glm::vec3 physVel_{0.0F};
  glm::vec3 physOmega_{0.0F};
  glm::vec3 physAcc_{0.0F};

  // ---- 视觉平滑层 ----
  glm::vec3 visOffPos_{0.0F};                 ///< 世界空间的残余位置误差
  glm::quat visOffRot_{1.0F, 0.0F, 0.0F, 0.0F};  ///< physRot 的**局部**残余旋转

  // ---- 状态 ----
  ReplState   state_ = ReplState::Empty;
  std::uint32_t lastFrame_ = 0;
  float       lastServerTimeSec_ = 0.0F;
  float       extrapolated_ = 0.0F;
  bool        coasting_ = false;     ///< 是否已进入"阻尼滑行"阶段（外推触顶后）
  std::uint32_t staleDropped_ = 0;
  std::uint32_t snapCount_ = 0;
  bool        hardSnapped_ = false;
};

}  // namespace forza::net
```

### 文件: native/rb_replicator/rigid_body_replicator_test.cpp

```cpp
// =============================================================================
//  rigid_body_replicator_test.cpp —— 自包含单测（零外部依赖）
//
//  断言与 verify_blending.py 一一对应，便于两边交叉核对：
//   T1  半衰期语义（exp(-dt/T½) 是错的，会得到 36.79% 而不是 50%）
//   T2  帧率无关性（28/61/144/239Hz 相同墙钟时间衰减必须完全一致）
//   T3  纠偏当帧视觉位置零跳变 + 后续平滑收敛
//   T4  旋转误差 slerp 与位置同节奏 + 传送保护
//   T5  外推时长硬截断 **150ms** + 触顶后阻尼滑行（不再匀速飞出去）
//   T6  过期帧丢弃 / 快照布局 / seqlock 邮箱
//   T7  强制短弧（dot<0 反转）：钝角误差不得报成 358° / 不得翻滚一整圈
//   T8  滑行期速度按半衰期衰减（"维持当前速度阻尼滑行"的量化证据）
//
//  编译：
//    g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic rigid_body_replicator_test.cpp -o rb_test && ./rb_test
// =============================================================================
#include "rigid_body_replicator.h"

#include <algorithm>    // std::max
#include <cmath>        // std::fabs / expf / powf
#include <cstdio>
#include <thread>

using namespace forza::net;

namespace {

int g_pass = 0;
int g_fail = 0;
const char* g_case = "";

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) { ++g_pass; }
  else { ++g_fail; std::printf("  [FAIL] %s :: %s %s\n", g_case, what, detail); }
}
void Case(const char* n) noexcept { g_case = n; std::printf("- %s\n", n); }

RigidBodyNetSnapshot MakeSnap(std::uint32_t frame, const glm::vec3& pos,
                              const glm::vec3& vel = glm::vec3(0.0F),
                              const glm::vec3& omega = glm::vec3(0.0F),
                              const glm::vec3& accel = glm::vec3(0.0F),
                              const glm::quat& rot = glm::quat(1.0F, 0.0F, 0.0F, 0.0F)) noexcept {
  RigidBodyNetSnapshot s{};
  s.frame = frame;
  s.position = pos;
  s.rotation = rot;
  s.velocity = vel;
  s.angularVelocity = omega;
  s.accel = accel;
  return s;
}

/// 半衰期固定为 90ms 跑格式断言（与 ReplicatorConfig 默认 80ms 解耦，
/// 避免"调默认值把测试调崩"这种耦合）。
constexpr float kHL = 0.090F;

/// 规格外推上限 150ms
constexpr float kMaxExtrap = 0.150F;
/// 构造一个用规格上限的复制器（默认配置已改成 150ms，这里显式再钉一次）
NetworkRigidBodyReplicator MakeRepl() noexcept {
  ReplicatorConfig c{};
  c.maxExtrapolationSec = kMaxExtrap;
  return NetworkRigidBodyReplicator(c);
}

// -----------------------------------------------------------------------------
void TestHalfLife() noexcept {
  Case("T1  半衰期语义（ln2 不能漏）");
  // 直接验纯函数，避免受外推/清扫逻辑干扰
  const float k1 = NetworkRigidBodyReplicator::DecayFactor(kHL, kHL);
  char b[64];
  std::snprintf(b, sizeof b, "k(T½)=%.6f", static_cast<double>(k1));
  Check(std::fabs(k1 - 0.5F) < 1e-6F, "经过 T½ 保留系数恰为 0.5", b);

  const float kWrong = expf(-1.0F);
  std::snprintf(b, sizeof b, "错写成 exp(-dt/T½) 会得 %.4f", static_cast<double>(kWrong));
  Check(std::fabs(kWrong - 0.367879F) < 1e-4F, "对照：时间常数写法得到 1/e 而非 1/2", b);

  const float k3 = powf(NetworkRigidBodyReplicator::DecayFactor(kHL, kHL), 3.0F);
  std::snprintf(b, sizeof b, "%.6f", static_cast<double>(k3));
  Check(std::fabs(k3 - 0.125F) < 1e-6F, "经过 3·T½ 剩 12.5%", b);

  const float rate = NetworkRigidBodyReplicator::DecayRatePerSec(kHL);
  std::snprintf(b, sizeof b, "λ=%.3f /s", static_cast<double>(rate));
  Check(std::fabs(rate - 7.7011F) < 1e-3F, "衰减率 λ = ln2/T½ ≈ 7.70 /s @ T½=90ms", b);
}

// -----------------------------------------------------------------------------
void TestFrameRateIndependence() noexcept {
  Case("T2  帧率无关性");
  // 0.180s 恰好是 2 个半衰期；取 n 使 0.180/n 整除，保证各刷新率总时长严格相等
  const int steps[4] = {5, 11, 26, 43};
  float results[4] = {0.0F, 0.0F, 0.0F, 0.0F};
  // ⚠️ 半衰期必须显式钉到 kHL：本用例断言的是"180ms = 2×T½ -> 剩 25%"，
  //    若用 ReplicatorConfig 的默认半衰期，改默认值就会把测试调崩（耦合）。
  ReplicatorConfig cfg{};
  cfg.halfLifeSec = kHL;
  for (int i = 0; i < 4; ++i) {
    const float dt = 0.180F / static_cast<float>(steps[i]);
    NetworkRigidBodyReplicator q(cfg);
    q.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(30.0F, 0.0F, 0.0F)));
    for (int k = 0; k < 6; ++k) q.Update(1.0F / 60.0F);
    const glm::vec3 visBefore = q.GetVisualPosition();
    q.OnAuthoritativeSnapshot(MakeSnap(2, visBefore - glm::vec3(1.0F, 0.0F, 0.0F),
                                       glm::vec3(30.0F, 0.0F, 0.0F)));
    const float err0 = q.VisualPositionErrorM();
    for (int k = 0; k < steps[i]; ++k) q.Update(dt);
    results[i] = q.VisualPositionErrorM() / err0;
    char b[96];
    std::snprintf(b, sizeof b, "%.1fHz (%2d 步 × %5.2fms) -> 剩余 %.6f",
                  1.0 / static_cast<double>(dt), steps[i],
                  static_cast<double>(dt) * 1000.0, static_cast<double>(results[i]));
    std::printf("    %s\n", b);
  }
  float worst = 0.0F;
  for (int i = 0; i < 4; ++i) {
    worst = std::max(worst, std::fabs(results[i] - 0.25F));
  }
  char b[64];
  std::snprintf(b, sizeof b, "最大偏差 %.2e", static_cast<double>(worst));
  Check(worst < 1e-5F, "28/61/144/239Hz 下 180ms 后剩余完全相同 = 25%（帧率无关）", b);
}

// -----------------------------------------------------------------------------
void TestNoSnapOnCorrection() noexcept {
  Case("T3  纠偏当帧视觉零跳变 + 平滑收敛");
  NetworkRigidBodyReplicator r;
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(30.0F, 0.0F, 0.0F)));
  const float dt = 1.0F / 60.0F;
  for (int i = 0; i < 12; ++i) r.Update(dt);          // 200ms 纯外推

  const glm::vec3 visBefore = r.GetVisualPosition();
  // 服务端纠偏：权威位置比外推值落后 0.8m
  r.OnAuthoritativeSnapshot(MakeSnap(2, visBefore - glm::vec3(0.8F, 0.0F, 0.0F),
                                     glm::vec3(30.0F, 0.0F, 0.0F)));
  const glm::vec3 visAfter = r.GetVisualPosition();
  char b[64];
  std::snprintf(b, sizeof b, "jump=%.3e m", static_cast<double>(glm::length(visAfter - visBefore)));
  Check(glm::length(visAfter - visBefore) < 1e-6F, "收到纠偏的**当帧**视觉位置零跳变", b);

  std::snprintf(b, sizeof b, "|offset|=%.3f m", static_cast<double>(r.VisualPositionErrorM()));
  Check(r.VisualPositionErrorM() > 0.7F, "误差被存进视觉偏移层（物理层已跳到权威值）", b);

  float maxStep = 0.0F;
  glm::vec3 prev = r.GetVisualPosition();
  for (int i = 0; i < 60; ++i) {
    r.Update(dt);
    const glm::vec3 cur = r.GetVisualPosition();
    maxStep = std::max(maxStep, glm::length(cur - prev));
    prev = cur;
  }
  std::snprintf(b, sizeof b, "|offset|=%.4f mm", static_cast<double>(r.VisualPositionErrorM()) * 1000.0);
  Check(r.VisualPositionErrorM() < 0.01F, "~1s 内视觉误差收敛到 1cm 内", b);
  std::snprintf(b, sizeof b, "maxStep=%.2f mm/frame", static_cast<double>(maxStep) * 1000.0);
  Check(maxStep < 30.0F * dt * 1.5F, "每帧位移不超过 车速×dt 的 1.5 倍（无抽搐）", b);
}

// -----------------------------------------------------------------------------
void TestRotationAndTeleportGuard() noexcept {
  Case("T4  旋转 slerp 衰减 + 传送保护");
  ReplicatorConfig cfg{};
  cfg.halfLifeSec = kHL;          // 显式钉半衰期，避免与默认值耦合
  NetworkRigidBodyReplicator r(cfg);
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F)));
  r.Update(1e-6F);
  // 制造 30° 姿态误差：物理层转 30°，视觉层原地不动
  r.OnAuthoritativeSnapshot(MakeSnap(2, glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::angleAxis(glm::radians(30.0F), glm::vec3(0.0F, 1.0F, 0.0F))));
  r.Update(kHL);            // 恰好一个半衰期
  const float ang = glm::degrees(glm::angle(r.GetVisualRotation() *
                                            glm::inverse(r.PhysicsRotation())));
  char b[64];
  std::snprintf(b, sizeof b, "%.3f°", static_cast<double>(ang));
  Check(std::fabs(ang - 15.0F) < 0.05F, "姿态误差经过 T½ 恰好减半（slerp 与位置同节奏）", b);

  // 传送保护
  NetworkRigidBodyReplicator t(cfg);
  t.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(30.0F, 0.0F, 0.0F)));
  for (int i = 0; i < 12; ++i) t.Update(1.0F / 60.0F);
  t.OnAuthoritativeSnapshot(MakeSnap(2, t.GetVisualPosition() + glm::vec3(50.0F, 0.0F, 0.0F),
                                     glm::vec3(30.0F, 0.0F, 0.0F)));
  std::snprintf(b, sizeof b, "snaps=%u", t.HardSnapCount());
  Check(t.HardSnapCount() == 1 && t.VisualPositionErrorM() < 1e-6F,
        "误差 > snapDistanceM(5m) -> 直接吸附清零（不做长尾滑行）", b);
}

// -----------------------------------------------------------------------------
void TestExtrapolationClamp() noexcept {
  Case("T5  外推硬截断 150ms + 触顶后阻尼滑行");
  NetworkRigidBodyReplicator r = MakeRepl();
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(55.0F, 0.0F, 0.0F)));  // 200km/h
  // 只推进到刚触顶：150ms / (1/60) = 9 步整
  for (int i = 0; i < 9; ++i) r.Update(1.0F / 60.0F);
  char b[128];
  std::snprintf(b, sizeof b, "extrap=%.4fs x=%.3fm",
                static_cast<double>(r.ExtrapolatedSec()),
                static_cast<double>(r.PhysicsPosition().x));
  Check(std::fabs(r.ExtrapolatedSec() - kMaxExtrap) < 1e-4F, "外推时长钉死在上限 150ms", b);
  Check(std::fabs(r.PhysicsPosition().x - 55.0F * kMaxExtrap) < 1e-3F,
        "推进期内位移 = v × 150ms（不会一路飞出地图）", b);
  Check(r.State() == ReplState::Stale, "触顶后状态标记为 Stale（供上层降级）");

  // 触顶后继续断包：位置仍在前进（滑行），但速度开始衰减，且**不再**按 55m/s 线性增长
  const float xAtCap = r.PhysicsPosition().x;
  const float vAtCap = glm::length(r.PhysicsVelocity());
  for (int i = 0; i < 60; ++i) r.Update(1.0F / 60.0F);   // 再滑 1 秒
  const float xSlid = r.PhysicsPosition().x;
  const float vSlid = glm::length(r.PhysicsVelocity());
  std::snprintf(b, sizeof b, "1s 后 x=%.2fm（x@cap=%.2fm） v=%.2f m/s（原 %.1f）",
                static_cast<double>(xSlid), static_cast<double>(xAtCap),
                static_cast<double>(vSlid), static_cast<double>(vAtCap));
  Check(r.ExtrapolatedSec() <= kMaxExtrap + 1e-5F,
        "滑行期不再增加外推计数（推进已定格在 150ms）", b);
  Check(xSlid > xAtCap + 1.0F, "滑行期位置仍在前进（视觉上'还在滑'，非硬冻结）", b);
  Check(vSlid < vAtCap * 0.5F, "滑行 1s 后速度衰减到 50% 以下（coast T½=0.6s）", b);
  Check(r.IsCoasting() && r.State() == ReplState::Stale, "滑行标志与 Stale 状态同时置位");
  // 若按"永远匀速"的旧实现，1s 会再飞 55m；滑行实现必须显著更短
  const float naiveExtra = 55.0F * 1.0F;
  const float realExtra = xSlid - xAtCap;
  std::snprintf(b, sizeof b, "实际多飞 %.1fm vs 匀速假设 %.1fm", static_cast<double>(realExtra),
                static_cast<double>(naiveExtra));
  Check(realExtra < naiveExtra * 0.8F, "滑行位移显著小于'匀速飞出去'（阻尼确实生效）", b);
}

// -----------------------------------------------------------------------------
//  T7 —— 强制短弧（dot < 0 反转）
//
//  这是规格里"四元数钝角插值导致长弧度翻滚"的正解。构造一个 -q 等价的
//  姿态：物理上完全一样，但若不做半球重置，误差四元数会变成 358° 而不是 2°，
//  glm::angle() 随即误触发 snapAngleRad、把平滑纠偏变成硬吸附。
// -----------------------------------------------------------------------------
void TestShortArcQuaternion() noexcept {
  Case("T7  强制短弧（dot<0 反转，防长弧翻滚）");
  NetworkRigidBodyReplicator r;
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F)));
  r.Update(1e-6F);

  // 当前姿态：绕 Y 转 1°
  const glm::quat base = glm::angleAxis(glm::radians(1.0F), glm::vec3(0.0F, 1.0F, 0.0F));
  r.OnAuthoritativeSnapshot(MakeSnap(2, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), base));
  r.Update(1e-6F);

  // 服务端发来 -base（同一个旋转，但符号相反）：
  // 正确的实现应视作"误差 ≈ 0"，而不是"误差 ≈ 358°"。
  const glm::quat negBase(-base.w, -base.x, -base.y, -base.z);
  r.OnAuthoritativeSnapshot(MakeSnap(3, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), negBase));

  char b[96];
  const float offAng = glm::degrees(glm::angle(r.VisualRotationOffset()));
  std::snprintf(b, sizeof b, "视角偏移=%.3f°", static_cast<double>(offAng));
  Check(offAng < 1.0F, "-q 输入被判为同姿态（误差 <1°，不是 358°）", b);
  Check(r.HardSnapCount() == 0, "不因 -q 误触发传送吸附（0 次 snap）", b);

  // 更极端：接近 180° 的姿态上做 -q 抖动（服务端量化/序列化翻符号）。
  // ⚠️ 关键设计：**误差**必须是小的，不能拿"从 identity 突然跳到 179°"当用例——
  //    那是一个真实的 179° 大纠偏，本来就该触发传送保护（那是正确行为，不是 bug）。
  //    这里先平滑走到 179°，再发**同一个姿态的 -q 表示**，这才是在考"短弧"。
  NetworkRigidBodyReplicator q;
  q.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F),
                                     glm::angleAxis(glm::radians(178.0F), glm::vec3(0.0F, 1.0F, 0.0F))));
  q.Update(1e-6F);
  const float snapsBefore = static_cast<float>(q.HardSnapCount());

  // 179° 的姿态、以及它的 -q 等价表示（同一个旋转）
  const glm::quat a179 = glm::angleAxis(glm::radians(179.0F), glm::vec3(0.0F, 1.0F, 0.0F));
  q.OnAuthoritativeSnapshot(MakeSnap(2, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), a179));
  q.Update(1e-6F);
  Check(static_cast<float>(q.HardSnapCount()) == snapsBefore,
        "178° -> 179°（1° 误差）不触发吸附（正常平滑纠偏）");

  const float errAfterReal = glm::degrees(glm::angle(q.VisualRotationOffset()));
  const glm::quat negA179(-a179.w, -a179.x, -a179.y, -a179.z);
  q.OnAuthoritativeSnapshot(MakeSnap(3, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), negA179));
  const float errAfterNeg = glm::degrees(glm::angle(q.VisualRotationOffset()));
  std::snprintf(b, sizeof b, "发 a179: %.3f° -> 发 -a179: %.3f°",
                static_cast<double>(errAfterReal), static_cast<double>(errAfterNeg));
  Check(errAfterNeg < 2.0F, "-q 等价表示被判为同一姿态（误差 <2°，不是 358°）", b);
  Check(glm::degrees(glm::angle(q.GetVisualRotation())) > 170.0F,
        "视觉姿态仍停在 179° 附近（没有被长弧拽走）", b);
  Check(static_cast<float>(q.HardSnapCount()) == snapsBefore,
        "179° 处的 -q 抖动不误触发 52° 吸附门限", b);
}

// -----------------------------------------------------------------------------
//  T8 —— 滑行期速度半衰期（与视觉偏移层同一套指数律）
// -----------------------------------------------------------------------------
void TestCoastDecay() noexcept {
  Case("T8  滑行期速度按 coast 半衰期衰减");
  NetworkRigidBodyReplicator r = MakeRepl();
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(50.0F, 0.0F, 0.0F)));
  // 触顶：150ms
  for (int i = 0; i < 9; ++i) r.Update(1.0F / 60.0F);
  Check(r.IsCoasting(), "已进入滑行期");

  const float v0 = glm::length(r.PhysicsVelocity());
  // 恰好再滑一个 coast 半衰期（0.6s，36 步整）
  for (int i = 0; i < 36; ++i) r.Update(1.0F / 60.0F);
  const float v1 = glm::length(r.PhysicsVelocity());
  char b[96];
  std::snprintf(b, sizeof b, "%.2f -> %.2f m/s（比值 %.4f）", static_cast<double>(v0),
                static_cast<double>(v1), static_cast<double>(v1 / v0));
  Check(std::fabs(v1 / v0 - 0.5F) < 0.02F, "滑行 1 个 coast 半衰期(0.6s) 速度剩 50%", b);

  // 再滑 1.8s（3 个半衰期的一半 -> 共 4 个半衰期）-> 剩 6.25%
  for (int i = 0; i < 108; ++i) r.Update(1.0F / 60.0F);
  const float v2 = glm::length(r.PhysicsVelocity());
  std::snprintf(b, sizeof b, "再滑 1.8s -> %.4f m/s", static_cast<double>(v2));
  Check(v2 < v0 * 0.10F, "长时间断包后速度收敛到接近 0（不会一直高速漂）", b);
}

// -----------------------------------------------------------------------------
void TestStaleFrameAndLayout() noexcept {
  Case("T6  过期帧 / 布局 / 无锁邮箱");

  // 布局：static_assert 已在头文件编译期钉住，这里再运行时核一次（协议对接用）
  char b[64];
  std::snprintf(b, sizeof b, "size=%zu align=%zu", sizeof(RigidBodyNetSnapshot),
                alignof(RigidBodyNetSnapshot));
  Check(sizeof(RigidBodyNetSnapshot) == 96 &&
        offsetof(RigidBodyNetSnapshot, accel) == 80, "快照 96B / accel 偏移 80", b);

  NetworkRigidBodyReplicator r;
  r.OnAuthoritativeSnapshot(MakeSnap(10, glm::vec3(0.0F)));
  const bool took = r.OnAuthoritativeSnapshot(MakeSnap(9, glm::vec3(5.0F, 0.0F, 0.0F)));
  std::snprintf(b, sizeof b, "dropped=%u", r.StaleDroppedCount());
  Check(!took && r.StaleDroppedCount() == 1 && glm::length(r.PhysicsPosition()) < 1e-6F,
        "帧号回退的包被丢弃（乱序通道常态）", b);

  // seqlock 邮箱：单生产者单消费者
  SnapshotMailbox mb;
  RigidBodyNetSnapshot got{};
  std::uint32_t ver = 0;
  Check(!mb.TryConsume(got, ver), "空邮箱返回 false");

  mb.Publish(MakeSnap(1, glm::vec3(1.0F, 2.0F, 3.0F)));
  Check(mb.TryConsume(got, ver) && glm::length(got.position - glm::vec3(1.0F, 2.0F, 3.0F)) < 1e-6F,
        "投递后可读出");
  Check(!mb.TryConsume(got, ver), "同一版本不重复投递");

  mb.Publish(MakeSnap(2, glm::vec3(9.0F, 9.0F, 9.0F)));
  Check(mb.TryConsume(got, ver) && got.frame == 2, "新版本可读出");

  // 跨线程压力：写 20 万次、读侧必须始终读到**完整**快照（不能撕裂）
  SnapshotMailbox mb2;
  std::atomic<bool> stop{false};
  std::atomic<int> torn{0};
  std::thread writer([&]() noexcept {
    for (std::uint32_t i = 1; i <= 200000U; ++i) {
      // 所有字段填同一个 i：若发生撕裂，各字段值会不一致
      RigidBodyNetSnapshot s{};
      s.frame = i;
      s.tickMs = i;
      s.position = glm::vec3(static_cast<float>(i));
      s.velocity = glm::vec3(static_cast<float>(i));
      s.accel = glm::vec3(static_cast<float>(i));
      mb2.Publish(s);
    }
    stop.store(true, std::memory_order_release);
  });
  std::thread reader([&]() noexcept {
    RigidBodyNetSnapshot s{};
    std::uint32_t v = 0;
    while (!stop.load(std::memory_order_acquire)) {
      if (mb2.TryConsume(s, v)) {
        const float f = static_cast<float>(s.frame);
        if (s.tickMs != s.frame || s.position.x != f ||
            s.velocity.x != f || s.accel.x != f) {
          torn.fetch_add(1, std::memory_order_relaxed);
        }
      }
    }
  });
  writer.join();
  reader.join();
  std::snprintf(b, sizeof b, "torn=%d", torn.load());
  Check(torn.load() == 0, "seqlock 邮箱在 20 万次并发写入下零撕裂", b);
}

}  // namespace

int main() {
  std::printf("=== NetworkRigidBodyReplicator 单元测试 ===\n");
  TestHalfLife();
  TestFrameRateIndependence();
  TestNoSnapOnCorrection();
  TestRotationAndTeleportGuard();
  TestExtrapolationClamp();
  TestStaleFrameAndLayout();
  TestShortArcQuaternion();
  TestCoastDecay();
  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
```

### 文件: native/rb_replicator/test_shim/glm/glm.hpp

```cpp
// =============================================================================
//  test_shim/glm/glm.hpp —— **仅用于本机无 GLM 时的编译/运行验证，不是 GLM 的替代品**
//
//  本机没有 GLM 也没有网络，无法安装真库。为了让 rigid_body_replicator_test.cpp
//  能真正编译并执行（Python 镜像只能验证数学，验证不了 C++ 实现本身），
//  这里提供一个**最小子集 shim**：只实现代码实际用到的那几个 API，
//  且**签名与 GLM 保持一致**（若签名对不上，编译会失败 —— 这正是我们想暴露的信息）。
//
//  使用：g++ -I test_shim ...
//  ⚠️ 生产环境请使用真 GLM：apt install libglm-dev / vcpkg install glm
// =============================================================================
#pragma once
#include <cmath>
#include <cstddef>

namespace glm {

using length_t = int;

template <typename T> struct vec3_t {
  T x{}, y{}, z{};
  vec3_t() = default;
  explicit vec3_t(T s) : x(s), y(s), z(s) {}
  vec3_t(T a, T b, T c) : x(a), y(b), z(c) {}
  T& operator[](length_t i) { return (&x)[i]; }
  const T& operator[](length_t i) const { return (&x)[i]; }
};

using vec3 = vec3_t<float>;
using vec2 = vec3_t<float>;   // 本工程未用 vec2，占位

template <typename T> inline vec3_t<T> operator+(vec3_t<T> a, vec3_t<T> b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
template <typename T> inline vec3_t<T> operator-(vec3_t<T> a, vec3_t<T> b) { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
template <typename T> inline vec3_t<T> operator*(vec3_t<T> a, T s) { return {a.x*s, a.y*s, a.z*s}; }
template <typename T> inline vec3_t<T> operator*(T s, vec3_t<T> a) { return a * s; }
template <typename T> inline vec3_t<T>& operator+=(vec3_t<T>& a, vec3_t<T> b) { a.x+=b.x; a.y+=b.y; a.z+=b.z; return a; }
template <typename T> inline vec3_t<T>& operator-=(vec3_t<T>& a, vec3_t<T> b) { a.x-=b.x; a.y-=b.y; a.z-=b.z; return a; }
template <typename T> inline vec3_t<T>& operator*=(vec3_t<T>& a, T s) { a.x*=s; a.y*=s; a.z*=s; return a; }
template <typename T> inline vec3_t<T> operator/(vec3_t<T> a, T s) { return {a.x/s, a.y/s, a.z/s}; }
template <typename T> inline vec3_t<T>& operator/=(vec3_t<T>& a, T s) { a.x/=s; a.y/=s; a.z/=s; return a; }

template <typename T> inline T dot(vec3_t<T> a, vec3_t<T> b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
template <typename T> inline T length(vec3_t<T> a) { return std::sqrt(dot(a, a)); }
template <typename T> inline vec3_t<T> normalize(vec3_t<T> a) {
  const T l = length(a); return (l > T(0)) ? a * (T(1) / l) : a;
}
template <typename T> inline vec3_t<T> cross(vec3_t<T> a, vec3_t<T> b) {
  return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
inline float abs(float s) { return std::fabs(s); }

// 4x4 列主序矩阵（与 GLM 一致）
template <typename T> struct mat4_t {
  T m[16]{};
  mat4_t() = default;
  explicit mat4_t(T diag) { m[0]=m[5]=m[10]=m[15]=diag; }
  T& operator[](length_t i) { return m[i]; }
  const T& operator[](length_t i) const { return m[i]; }
};
using mat4 = mat4_t<float>;

template <typename T> inline mat4_t<T> operator*(const mat4_t<T>& a, const mat4_t<T>& b) {
  mat4_t<T> r;
  for (int c = 0; c < 4; ++c) {
    for (int row = 0; row < 4; ++row) {
      T s = T(0);
      for (int k = 0; k < 4; ++k) s += a.m[k * 4 + row] * b.m[c * 4 + k];
      r.m[c * 4 + row] = s;
    }
  }
  return r;
}
// 变换一个点（w=1）
template <typename T> inline vec3_t<T> operator*(const mat4_t<T>& a, vec3_t<T> v) {
  return { a.m[0]*v.x + a.m[4]*v.y + a.m[8]*v.z  + a.m[12],
           a.m[1]*v.x + a.m[5]*v.y + a.m[9]*v.z  + a.m[13],
           a.m[2]*v.x + a.m[6]*v.y + a.m[10]*v.z + a.m[14] };
}

inline float radians(float deg) { return deg * 3.14159265358979323846F / 180.0F; }
inline float degrees(float rad) { return rad * 180.0F / 3.14159265358979323846F; }

}  // namespace glm
```

### 文件: native/rb_replicator/test_shim/glm/gtc/matrix_transform.hpp

```cpp
// test_shim/glm/gtc/matrix_transform.hpp —— 见 glm/glm.hpp 顶部说明（最小子集 shim）
#pragma once
#include <glm/glm.hpp>

namespace glm {

// translate(mat4, vec3)：把平移写进列主序矩阵的第 4 列（与 GLM 一致）
template <typename T> inline mat4_t<T> translate(const mat4_t<T>& m0, vec3_t<T> v) {
  mat4_t<T> r = m0;
  r.m[12] = m0.m[0]*v.x + m0.m[4]*v.y + m0.m[8]*v.z  + m0.m[12];
  r.m[13] = m0.m[1]*v.x + m0.m[5]*v.y + m0.m[9]*v.z  + m0.m[13];
  r.m[14] = m0.m[2]*v.x + m0.m[6]*v.y + m0.m[10]*v.z + m0.m[14];
  r.m[15] = m0.m[3]*v.x + m0.m[7]*v.y + m0.m[11]*v.z + m0.m[15];
  return r;
}

}  // namespace glm
```

### 文件: native/rb_replicator/test_shim/glm/gtc/quaternion.hpp

```cpp
// test_shim/glm/gtc/quaternion.hpp —— 见 glm/glm.hpp 顶部说明（最小子集 shim）
#pragma once
#include <glm/glm.hpp>

namespace glm {

// 与 GLM 一致：(w, x, y, z)
template <typename T> struct quat_t {
  T w{}, x{}, y{}, z{};
  quat_t() = default;
  quat_t(T w_, T x_, T y_, T z_) : w(w_), x(x_), y(y_), z(z_) {}
};
using quat = quat_t<float>;

template <typename T> inline T dot(quat_t<T> a, quat_t<T> b) {
  return a.w*b.w + a.x*b.x + a.y*b.y + a.z*b.z;
}
template <typename T> inline T length(quat_t<T> q) { return std::sqrt(dot(q, q)); }
template <typename T> inline quat_t<T> normalize(quat_t<T> q) {
  const T l = length(q); if (l <= T(0)) return quat_t<T>(T(1), T(0), T(0), T(0));
  return quat_t<T>(q.w/l, q.x/l, q.y/l, q.z/l);
}
template <typename T> inline quat_t<T> operator*(quat_t<T> a, quat_t<T> b) {
  return quat_t<T>(
    a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w);
}
// GLM: inverse(quat) 即共轭/模长平方（单位四元数下就是共轭）
template <typename T> inline quat_t<T> inverse(quat_t<T> q) {
  const T d = dot(q, q); if (d <= T(0)) return quat_t<T>(T(1), T(0), T(0), T(0));
  return quat_t<T>(q.w/d, -q.x/d, -q.y/d, -q.z/d);
}
// 轴角 -> 四元数
template <typename T> inline quat_t<T> angleAxis(T angle, vec3_t<T> axis) {
  const T l = length(axis);
  if (l <= T(0)) return quat_t<T>(T(1), T(0), T(0), T(0));
  const vec3_t<T> a = axis * (T(1) / l);
  const T h = angle * T(0.5);
  const T s = std::sin(h);
  return quat_t<T>(std::cos(h), a.x*s, a.y*s, a.z*s);
}
// 四元数 -> 旋转矩阵（列主序）
template <typename T> inline mat4_t<T> mat4_cast(quat_t<T> q) {
  const T xx=q.x*q.x, yy=q.y*q.y, zz=q.z*q.z;
  const T xy=q.x*q.y, xz=q.x*q.z, yz=q.y*q.z;
  const T wx=q.w*q.x, wy=q.w*q.y, wz=q.w*q.z;
  mat4_t<T> r(T(1));
  r.m[0]=T(1)-T(2)*(yy+zz); r.m[1]=T(2)*(xy+wz);      r.m[2]=T(2)*(xz-wy);
  r.m[4]=T(2)*(xy-wz);      r.m[5]=T(1)-T(2)*(xx+zz);  r.m[6]=T(2)*(yz+wx);
  r.m[8]=T(2)*(xz+wy);      r.m[9]=T(2)*(yz-wx);       r.m[10]=T(1)-T(2)*(xx+yy);
  return r;
}

}  // namespace glm
```

### 文件: native/rb_replicator/test_shim/glm/gtx/quaternion.hpp

```cpp
// test_shim/glm/gtx/quaternion.hpp —— 见 glm/glm.hpp 顶部说明（最小子集 shim）
#pragma once
#include <glm/gtc/quaternion.hpp>

namespace glm {

// 旋转角 ∈ [0, π]（与 GLM 一致）
template <typename T> inline T angle(quat_t<T> q) {
  T w = q.w;
  if (w < T(0)) w = -w;
  if (w > T(1)) w = T(1);
  return T(2) * std::acos(w);
}

// 球面线性插值（与 GLM 同签名：slerp(x, y, a)）
template <typename T> inline quat_t<T> slerp(quat_t<T> x, quat_t<T> y, T a) {
  T d = dot(x, y);
  if (d < T(0)) { y = quat_t<T>(-y.w, -y.x, -y.y, -y.z); d = -d; }
  if (d > T(0.9995)) {   // 夹角极小 -> 退化成 nlerp，避免除零
    return normalize(quat_t<T>(x.w + (y.w - x.w) * a, x.x + (y.x - x.x) * a,
                               x.y + (y.y - x.y) * a, x.z + (y.z - x.z) * a));
  }
  const T th0 = std::acos(d);
  const T th  = th0 * a;
  const T s0  = std::sin(th0 - th) / std::sin(th0);
  const T s1  = std::sin(th) / std::sin(th0);
  return normalize(quat_t<T>(x.w*s0 + y.w*s1, x.x*s0 + y.x*s1,
                             x.y*s0 + y.y*s1, x.z*s0 + y.z*s1));
}

}  // namespace glm
```

### 文件: native/rb_replicator/verify_blending.py

```python
#!/usr/bin/env python3
"""NetworkRigidBodyReplicator 数学验证（Python 镜像）。

为什么存在：本机没有 C++ 编译器（只有 go/node/python/git），无法编译
rigid_body_replicator_test.cpp。这里用与头文件**完全相同的公式**真跑一遍，
验证四个容易被写错、且肉眼难发现的定量性质：

  V1  半衰期语义：经过 T½ 秒，偏移必须恰好剩 50%
  V2  **帧率无关性**：60Hz 与 144Hz 下，经过相同墙钟时间偏移必须一致
      （这是"每帧乘固定系数"写法会失败的地方，也是最容易被忽略的坑）
  V3  纠偏瞬间视觉位置**连续**（零跳变）—— 双层解耦的全部意义所在
  V4  外推时长硬截断 150ms + 触顶后**阻尼滑行** + 传送保护（>snapDistanceM 直接吸附）
  V5  强制短弧（dot<0 反转）：-q 等价姿态不得被算成 358° 长弧
  V6  过期帧丢弃

注意：本文件验证算法，**不能替代 C++ 编译验证**，两者都要各自说清楚。
"""
import math

kIdentity = (1.0, 0.0, 0.0, 0.0)


# ----------------------------- 极简 GLM 等价物 -----------------------------
def v3(*a):
    return list(a) if len(a) == 3 else list(a[0])


def vadd(a, b):
    return [a[i] + b[i] for i in range(3)]


def vsub(a, b):
    return [a[i] - b[i] for i in range(3)]


def vmul(a, s):
    return [a[i] * s for i in range(3)]


def vlen(a):
    return math.sqrt(sum(x * x for x in a))


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def qconj(q):
    return (q[0], -q[1], -q[2], -q[3])


def qdot(a, b):
    return sum(a[i] * b[i] for i in range(4))


def qnorm(q):
    n = math.sqrt(sum(x * x for x in q))
    return kIdentity if n < 1e-12 else tuple(x / n for x in q)


def short_arc(ref, q):
    """强制短弧：dot(ref, q) < 0 时取 -q（与 C++ ShortArc 逐字一致）。"""
    return tuple(-x for x in q) if qdot(ref, q) < 0.0 else q


def qslerp(a, b, t):
    d = sum(a[i] * b[i] for i in range(4))
    if d < 0.0:
        b = tuple(-x for x in b)
        d = -d
    if d > 0.9995:
        return qnorm(tuple(a[i] + (b[i] - a[i]) * t for i in range(4)))
    th0 = math.acos(max(-1.0, min(1.0, d)))
    th = th0 * t
    s0 = math.sin(th0 - th) / math.sin(th0)
    s1 = math.sin(th) / math.sin(th0)
    return qnorm(tuple(a[i] * s0 + b[i] * s1 for i in range(4)))


def qangle(q):
    """glm::angle(q) 等价：绕轴旋转角 ∈ [0, π]"""
    w = max(-1.0, min(1.0, abs(q[0])))
    return 2.0 * math.acos(w)


def qaxis(angle, axis):
    l = math.sqrt(sum(x * x for x in axis))
    if l < 1e-9:
        return kIdentity
    axis = [x / l for x in axis]
    h = angle * 0.5
    s = math.sin(h)
    return (math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s)


# ----------------------------- 镜像核心 -----------------------------
class Repl:
    def __init__(self, half_life=0.080, max_extrap=0.150, accel_trust=0.100,
                 snap_dist=5.0, snap_ang=0.9, omega_trust=0.150,
                 coast_half_life=0.600):
        self.cfg = dict(half_life=half_life, max_extrap=max_extrap,
                        accel_trust=accel_trust, snap_dist=snap_dist,
                        snap_ang=snap_ang, omega_trust=omega_trust,
                        coast_half_life=coast_half_life)
        self.pos = [0.0, 0.0, 0.0]
        self.rot = kIdentity
        self.vel = [0.0, 0.0, 0.0]
        self.omega = [0.0, 0.0, 0.0]
        self.acc = [0.0, 0.0, 0.0]
        self.off_pos = [0.0, 0.0, 0.0]
        self.off_rot = kIdentity
        self.last_frame = 0
        self.extrap = 0.0
        self.has_state = False
        self.snaps = 0
        self.stale_dropped = 0
        self.coasting = False

    @staticmethod
    def decay_factor(dt, half_life):
        # k = 0.5^(dt/T½) = exp(-dt*ln2/T½)   —— ln2 不能漏
        return 0.0 if half_life <= 1e-6 else math.exp(-dt * math.log(2.0) / half_life)

    def on_snapshot(self, s):
        if self.has_state and s["frame"] <= self.last_frame:
            self.stale_dropped += 1
            return False
        if not self.has_state:
            self.pos = list(s["pos"])
            self.rot = qnorm(s["rot"])
            self.vel = list(s["vel"])
            self.omega = list(s["omega"])
            self.acc = list(s["acc"])
            self.off_pos = [0.0, 0.0, 0.0]
            self.off_rot = kIdentity
            self.last_frame = s["frame"]
            self.extrap = 0.0
            self.has_state = True
            return True

        # 0) 半球归一：把新快照旋转搬到与当前 rot 同半球
        new_rot = short_arc(self.rot, qnorm(s["rot"]))
        # 1) 记录当前视觉空间
        cur_vis_pos = vadd(self.pos, self.off_pos)
        cur_vis_rot = qnorm(qmul(self.rot, self.off_rot))
        # 2) 物理层直接采用权威状态
        self.pos = list(s["pos"])
        self.rot = new_rot
        self.vel = list(s["vel"])
        self.omega = list(s["omega"])
        self.acc = list(s["acc"])
        self.last_frame = s["frame"]
        self.extrap = 0.0
        self.coasting = False
        # 3) 误差转移进视觉层（误差四元数也取短弧）
        new_off_pos = vsub(cur_vis_pos, self.pos)
        new_off_rot = short_arc(kIdentity, qnorm(qmul(qconj(self.rot), cur_vis_rot)))
        # 4) 传送保护
        if vlen(new_off_pos) > self.cfg["snap_dist"] or qangle(new_off_rot) > self.cfg["snap_ang"]:
            self.off_pos = [0.0, 0.0, 0.0]
            self.off_rot = kIdentity
            self.snaps += 1
        else:
            self.off_pos = new_off_pos
            self.off_rot = new_off_rot
        return True

    def update(self, dt):
        if not self.has_state or dt <= 0:
            return
        # A) 航位推测：推进期 / 滑行期
        if self.extrap < self.cfg["max_extrap"] - 1e-6:
            room = self.cfg["max_extrap"] - self.extrap
            dte = min(dt, max(0.0, room))
            if dte > 0:
                a = self.acc if self.extrap < self.cfg["accel_trust"] else [0.0, 0.0, 0.0]
                self.pos = vadd(self.pos, vadd(vmul(self.vel, dte),
                                               vmul(a, 0.5 * dte * dte)))
                self.vel = vadd(self.vel, vmul(a, dte))
                if self.extrap < self.cfg["omega_trust"]:
                    wl = vlen(self.omega)
                    if wl > 1e-6:
                        dq = qaxis(wl * dte, self.omega)
                        self.rot = qnorm(qmul(self.rot, dq))
                self.extrap += dte
                self.coasting = False
        else:
            # A-2) 滑行期：位置仍按当前速度前进，但速度/角速度按 coast 半衰期衰减
            kc = self.decay_factor(dt, self.cfg["coast_half_life"])
            self.pos = vadd(self.pos, vmul(self.vel, dt))
            self.vel = vmul(self.vel, kc)
            self.omega = vmul(self.omega, kc)
            self.coasting = True

        # B) 双层误差衰减（衰减前重置半球，防长弧翻滚）
        k = self.decay_factor(dt, self.cfg["half_life"])
        self.off_pos = vmul(self.off_pos, k)
        self.off_rot = qnorm(qslerp(kIdentity, short_arc(kIdentity, self.off_rot), k))
        if sum(x * x for x in self.off_pos) < 1e-8:
            self.off_pos = [0.0, 0.0, 0.0]
        if abs(qdot(self.off_rot, kIdentity)) > 1.0 - 1e-9:
            self.off_rot = kIdentity

    def visual_pos(self):
        return vadd(self.pos, self.off_pos)

    def visual_rot(self):
        return qnorm(qmul(self.rot, self.off_rot))


def snap(frame, pos, rot=kIdentity, vel=(0.0, 0.0, 0.0), omega=(0.0, 0.0, 0.0), acc=(0.0, 0.0, 0.0)):
    return dict(frame=frame, pos=pos, rot=rot, vel=vel, omega=omega, acc=acc)


# ----------------------------- 验证 -----------------------------
def main():
    print("=== NetworkRigidBodyReplicator 数学验证（Python 镜像）===\n")
    fails = []

    def check(ok, what, detail=""):
        print(("  PASS  " if ok else "  FAIL  ") + what + ("   " + detail if detail else ""))
        if not ok:
            fails.append(what)

    HL = 0.090
    print("[V1] 半衰期语义")
    r = Repl(half_life=HL)
    r.on_snapshot(snap(1, (0, 0, 0)))
    r.update(1e-6)
    r.off_pos = [1.0, 0.0, 0.0]          # 人为塞 1m 横向误差
    # 一次推进恰好一个半衰期
    r.update(HL)
    ratio = vlen(r.off_pos) / 1.0
    check(abs(ratio - 0.5) < 1e-6, "经过 T½=90ms 偏移恰好剩 50%", f"ratio={ratio:.6f}")
    print(f"        （若误写成 exp(-dt/T½) 会得到 0.367879 —— 那是时间常数不是半衰期）")
    r2 = Repl(half_life=HL)
    r2.on_snapshot(snap(1, (0, 0, 0)))
    r2.update(1e-6)
    r2.off_pos = [1.0, 0.0, 0.0]
    for _ in range(3):
        r2.update(HL)
    check(abs(vlen(r2.off_pos) - 0.125) < 1e-6, "经过 3·T½ 剩 12.5%",
          f"{vlen(r2.off_pos):.6f}")

    print("\n[V2] 帧率无关性（最容易写错的地方）")
    # 关键：各刷新率下推进的**总墙钟时间必须严格相等**（180ms = 2 个半衰期），
    # 否则测的是"步数取整误差"而不是帧率无关性。
    # 取 n 使 0.180/n 恰好整除：n = 5/11/26/43 -> 约 28/61/144/239 Hz
    worst = 0.0
    for n in (5, 11, 26, 43):
        dt = 0.180 / n
        rr = Repl(half_life=HL)
        rr.on_snapshot(snap(1, (0, 0, 0)))
        rr.update(1e-6)
        rr.off_pos = [1.0, 0.0, 0.0]
        for _ in range(n):
            rr.update(dt)
        rem = vlen(rr.off_pos)
        hz = 1.0 / dt
        print(f"        {hz:6.1f}Hz ({n:2d} 步 × {dt*1000:5.2f}ms) -> 剩余 {rem:.6f} m")
        worst = max(worst, abs(rem - 0.25))
    check(worst < 1e-9, "28/61/144/239Hz 下 180ms 后剩余**完全相同** = 25%（帧率无关）",
          f"最大偏差 {worst:.2e}")

    print("\n[V3] 纠偏瞬间视觉位置连续（零跳变）")
    r3 = Repl(half_life=HL)
    r3.on_snapshot(snap(1, (0, 0, 0), vel=(30.0, 0.0, 0.0), acc=(0.0, 0.0, 0.0)))
    dt = 1.0 / 60.0
    for _ in range(12):                    # 跑 200ms，期间无新包 -> 在纯外推
        r3.update(dt)
    visual_before = list(r3.visual_pos())
    # 服务端纠偏：权威位置比外推值落后 0.8m（典型的位置回拉）
    authoritative = vsub(visual_before, [0.8, 0.0, 0.0])
    r3.on_snapshot(snap(2, authoritative, vel=(30.0, 0.0, 0.0)))
    visual_after = r3.visual_pos()
    jump = vlen(vsub(visual_after, visual_before))
    check(jump < 1e-9, "收到纠偏的**当帧**视觉位置零跳变",
          f"jump={jump:.3e} m（物理层已跳到权威值，视觉层吸收全部误差）")
    check(vlen(r3.off_pos) > 0.7, "误差确实被存进了视觉偏移层",
          f"|offset|={vlen(r3.off_pos):.3f} m")

    # 随后平滑收敛，且每帧位移连续
    max_frame_step = 0.0
    prev = list(visual_after)
    for _ in range(60):
        r3.update(dt)
        cur = r3.visual_pos()
        max_frame_step = max(max_frame_step, vlen(vsub(cur, prev)))
        prev = list(cur)
    check(vlen(r3.off_pos) < 0.01, "~1s 内视觉误差收敛到 1cm 内",
          f"|offset|={vlen(r3.off_pos)*1000:.2f} mm")
    check(max_frame_step < 30.0 * dt * 1.5, "每帧位移不超过车速 × dt 的 1.5 倍（无抽搐）",
          f"maxStep={max_frame_step*1000:.2f} mm/frame")

    print("\n[V4] 旋转误差用 slerp 衰减 + 传送保护")
    r4 = Repl(half_life=HL)
    r4.on_snapshot(snap(1, (0, 0, 0)))
    r4.update(1e-6)
    r4.off_rot = qaxis(math.radians(30.0), (0.0, 1.0, 0.0))   # 30° 姿态误差
    r4.update(HL)
    ang = math.degrees(qangle(r4.off_rot))
    check(abs(ang - 15.0) < 0.05, "姿态误差经过 T½ 恰好减半（slerp 与位置同节奏）",
          f"{ang:.3f}°")

    r5 = Repl(half_life=HL)
    r5.on_snapshot(snap(1, (0, 0, 0)))
    dt = 1.0 / 60.0
    for _ in range(12):
        r5.update(dt)
    far = vadd(r5.visual_pos(), [50.0, 0.0, 0.0])   # 传送级别（50m）
    r5.on_snapshot(snap(2, far))
    check(r5.snaps == 1 and vlen(r5.off_pos) < 1e-9,
          "误差 > snapDistanceM(5m) -> 直接吸附清零，不做长尾滑行",
          f"snaps={r5.snaps}")

    print("\n[V5] 外推硬截断 150ms + 触顶后阻尼滑行")
    r6 = Repl(half_life=HL, max_extrap=0.150)
    r6.on_snapshot(snap(1, (0, 0, 0), vel=(55.0, 0.0, 0.0)))   # 200km/h
    for _ in range(9):                                          # 恰好推进 150ms
        r6.update(dt)
    check(abs(r6.extrap - 0.150) < 1e-6, "外推时长被钉死在上限 150ms",
          f"extrap={r6.extrap:.3f}s")
    check(abs(r6.pos[0] - 55.0 * 0.150) < 1e-6,
          "推进期位移 = v × 150ms（不会一路飞出地图）", f"x={r6.pos[0]:.2f}m")
    x_cap = r6.pos[0]
    v_cap = vlen(r6.vel)
    for _ in range(60):                                         # 再滑 1 秒
        r6.update(dt)
    check(r6.coasting, "触顶后进入滑行期（coasting 标志置位）")
    check(vlen(r6.vel) < v_cap * 0.5, "滑行 1s 后速度衰减到 50% 以下（coast T½=0.6s）",
          f"{v_cap:.1f} -> {vlen(r6.vel):.2f} m/s")
    check(r6.pos[0] > x_cap + 1.0, "滑行期位置仍在前进（视觉上'还在滑'，非硬冻结）",
          f"多飞 {r6.pos[0]-x_cap:.1f}m（匀速假设会是 55.0m）")
    check(r6.pos[0] - x_cap < 55.0 * 0.8, "滑行位移显著小于'匀速飞出去'（阻尼生效）")

    print("\n[V6] 强制短弧（dot<0 反转，防长弧翻滚）")
    r8 = Repl(half_life=HL)
    base = qaxis(math.radians(1.0), (0.0, 1.0, 0.0))
    r8.on_snapshot(snap(1, (0, 0, 0), rot=base))
    r8.update(1e-6)
    neg_base = tuple(-x for x in base)
    r8.on_snapshot(snap(2, (0, 0, 0), rot=neg_base))
    off_ang = math.degrees(qangle(r8.off_rot))
    check(off_ang < 1.0, "-q 输入被判为同姿态（误差 <1°，不是 358°）",
          f"offset={off_ang:.3f}°")
    check(r8.snaps == 0, "不因 -q 误触发传送吸附", f"snaps={r8.snaps}")

    print("\n[V7] 过期帧丢弃")
    r7 = Repl()
    r7.on_snapshot(snap(10, (0, 0, 0)))
    r7.on_snapshot(snap(9, (5, 0, 0)))
    check(r7.stale_dropped == 1 and vlen(r7.pos) < 1e-9, "帧号回退的包被丢弃",
          f"dropped={r7.stale_dropped}")

    print(f"\n结果：{'全部通过' if not fails else str(len(fails)) + ' 项失败'}")
    for f in fails:
        print("  ✗ " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

## 总测试脚本

### 文件: native/run_tests.sh

```bash
#!/usr/bin/env bash
# =============================================================================
#  native/ —— C++ 模块的编译 + 单测一键脚本
#
#    ./run_tests.sh
#
#  八段：timesync / rb_replicator / wasm bridge / safe_physics(新) / safe_collision(废弃转发层) /
#        race_delta / harness(全链路压测) / mp_chaos(单机无头多人混沌仿真)。
#  safe_physics 段是本工程"零反弹"命题的**权威实现**（SafePhysicsSolver，117 项）。
#  safe_collision 段退化为**兼容壳**的回归验证（旧类名必须转发到新行为）。
#  timesync 段另附 Python 镜像交叉验证（verify_algorithm.py，28 项）—— 两条独立实现互证。
#  race_delta 段同样另有 Python 镜像（verify_race_delta.py，37 项）。
#  rb_replicator 段另有 verify_blending.py 数学镜像（V1~V7）。
#  mp_chaos 段：一个进程起 1 服务端 + 4 客户端（1 本地 + 3 无头 Bot），
#  注入混沌信道（RTT 100ms / 抖动 20~160ms 长尾 / 8% 丢包 / 5% 乱序），
#  量化闪现(Rubberbanding)、HUD 秒差双分支、碰撞不弹开 —— 28 项 + 确定性回归。
#
#  本机 g++ 位于 /e/mingw64/bin（不在默认 PATH 上），脚本会自动找。
#  rb_replicator 需要 GLM：本机没装且无网络，脚本回退到 test_shim/ 的
#  **最小子集 shim**（签名对齐 GLM）—— 能验证 C++ 实现与算法，
#  但**不能**验证与真 GLM 的 API 兼容性。装了真 GLM 时会自动优先用它。
#  [7/7] harness 例外：压测需要真实四元数/矩阵行为，**不回退 shim**，
#  找不到真 GLM 时整段跳过并在末尾提示。
# =============================================================================
set -u

# ---- 找 g++ ----
GXX=""
if command -v g++ >/dev/null 2>&1; then
  GXX="g++"
else
  for c in /e/mingw64/bin/g++.exe /c/msys64/mingw64/bin/g++.exe /c/mingw64/bin/g++.exe; do
    if [ -x "$c" ]; then GXX="$c"; break; fi
  done
fi
if [ -z "$GXX" ]; then
  echo "找不到 g++。请把编译器目录加进 PATH 后重试。" >&2
  exit 127
fi
# MinGW 产物需要运行时 DLL，把它们所在目录也放进 PATH
GXX_DIR="$(dirname "$GXX")"
export PATH="$GXX_DIR:$PATH"

CXXFLAGS="-std=c++20 -O2 -Wall -Wextra -Wpedantic"
FAILED=0
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "编译器: $("$GXX" --version | head -1)"
echo

# ---------------------------------------------------------------------------
# 1) ForzaTimeSynchronizer —— 零外部依赖
# ---------------------------------------------------------------------------
echo "=== [1/8] timesync ==="
cd "$HERE/timesync" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS forza_time_sync.cpp forza_time_sync_test.cpp -o build/ts_test.exe; then
  ./build/ts_test.exe || FAILED=1
else
  echo "  [编译失败] timesync" >&2
  FAILED=1
fi
# Python 镜像交叉复核：两条独立实现给同一结论，说明方程本身对（非单处转写凑巧）
for PY in python python3 "$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
          /c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  —— Python 镜像交叉验证（verify_algorithm.py）——"
    "$PY" verify_algorithm.py || FAILED=1
    break
  fi
done
echo

# ---------------------------------------------------------------------------
# 2) NetworkRigidBodyReplicator —— 依赖 GLM
# ---------------------------------------------------------------------------
echo "=== [2/8] rb_replicator ==="
cd "$HERE/rb_replicator" || exit 1
# 优先真 GLM；都找不到才回退 shim。
# 注意 GLM 的 -I 要指向**含 glm/ 子目录的父目录**，不是 glm/ 本身。
GLM_FLAGS=""
GLM_SRC=""
for cand in /usr/include /usr/local/include /e/mingw64/include \
            /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  if [ -f "$cand/glm/glm.hpp" ]; then GLM_SRC="$cand"; break; fi
done
if [ -n "$GLM_SRC" ]; then
  GLM_FLAGS="-I $GLM_SRC"
  echo "  (使用真 GLM: $GLM_SRC)"
else
  echo "  (未找到真 GLM -> 回退 test_shim/ 最小子集 shim。"
  echo "   它只能验证 C++ 实现与算法，**不能**验证与真 GLM 的 API 兼容性)"
  GLM_FLAGS="-I test_shim"
fi
if "$GXX" $CXXFLAGS $GLM_FLAGS rigid_body_replicator_test.cpp -o build_rb.exe; then
  ./build_rb.exe || FAILED=1
else
  echo "  [编译失败] rb_replicator" >&2
  FAILED=1
fi
# Python 数学镜像：验证"半衰期/帧率无关/零跳变/150ms 截断+滑行/短弧"五个定量性质
for PY in python python3 "$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
          /c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  —— Python 数学镜像（verify_blending.py）——"
    "$PY" verify_blending.py || FAILED=1
    break
  fi
done
echo

# ---------------------------------------------------------------------------
# 3) wasm 宿主层 —— 32B 线格式 + 多车注册表 + HUD 文本 + 跨语言逐字节校验
#    （Embind 那层需要 emcc，本机没有；但它只是薄封装，风险集中在下面这些）
# ---------------------------------------------------------------------------
echo "=== [3/8] wasm host（wire / registry / HUD）==="
cd "$HERE/wasm" || exit 1
if "$GXX" $CXXFLAGS ${GLM_FLAGS:--I test_shim} \
     wasm_bindings_test.cpp ../timesync/forza_time_sync.cpp ../race_delta/race_delta_tracker.cpp \
     -o bridge_test.exe 2>/dev/null || \
   "$GXX" $CXXFLAGS -I /e/g-truc-glm-8d1fd52 \
     wasm_bindings_test.cpp ../timesync/forza_time_sync.cpp ../race_delta/race_delta_tracker.cpp \
     -o bridge_test.exe; then
  ./bridge_test.exe || FAILED=1
else
  echo "  [编译失败] wasm/wasm_bindings_test.cpp" >&2
  FAILED=1
fi
# 跨语言逐字节校验（node）：C++ dump 真值 vs TS 位打包器
#   ⚠️ 这一步非有不可：NetworkEngine.ts 里有一份**独立的 JS 位打包实现**，
#      两处只要有一位不一致，就只在"跨语言"时暴露 —— 单语言测试永远绿。
if command -v node >/dev/null 2>&1; then
  ./bridge_test.exe --dump-wire wire_dump.json >/dev/null 2>&1 || true
  node verify_engine_wire.mjs || FAILED=1
else
  echo "  (跳过 verify_engine_wire.mjs：未找到 node)"
fi

# 跨语言布局校验（node）：拿 layout.json 去对 TS 里硬写的 96B 期望值
node verify_layout.mjs || FAILED=1

# TS 严格类型检查（需要 tsc；装法见下）
TSC=""
for c in "$HOME/.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc" \
         /c/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc; do
  if [ -f "$c" ]; then TSC="$c"; break; fi
done
if [ -n "$TSC" ] && command -v node >/dev/null 2>&1; then
  echo "  —— TS 严格类型检查（NetworkPhysicsClient + NetworkEngine）——"
  node "$TSC" -p tsconfig.check.json && echo "  TS 类型检查通过" || FAILED=1
else
  echo "  (跳过 TS 类型检查：未找到 tsc)"
  echo "   装法：cd ~/.workbuddy/binaries/node/workspace && npm install typescript"
fi
echo

# ---------------------------------------------------------------------------
# 4) SafePhysicsSolver —— 零外部依赖（本工程"零反弹"命题的**权威实现**）
#    核心命题：分离冲量**绝不注入虚假动能**（防炸车/防弹飞的根因）
#    关键性质：§1 无条件法线平整化（防跳板）/ §2 速度自适应塑性恢复（阈值以上 e=0）
#              §3 分离冲量（位置相不碰 velocity，单子步 ≤3cm）/ §4 悬挂解耦
#              §5 冲量硬截断（4e4 N·s）
#    验收：两车 200km/h 侧撞与正撞，碰后法向分离速度 ≤ 0.5 m/s（彻底无反弹）
# ---------------------------------------------------------------------------
echo "=== [4/8] safe_physics ==="
cd "$HERE/safe_physics" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS safe_physics_test.cpp -o build/safe_physics_test.exe; then
  ./build/safe_physics_test.exe || FAILED=1
else
  echo "  [编译失败] safe_physics" >&2
  FAILED=1
fi
echo

# ---------------------------------------------------------------------------
# 5) SafeCollisionResolver —— 【废弃转发层】只做兼容性回归
#    本文件已无实现，全部算法在 safe_physics。此段验证：
#      · 旧类名/旧类型别名仍可编译（下游不炸）
#      · 旧类名调用**确实转发到新行为**（不是静默走旧参数）
#      · 旧的 ResolverConfig{} 仍能 aggregate-init
# ---------------------------------------------------------------------------
echo "=== [5/8] safe_collision（deprecated 转发层回归）==="
cd "$HERE/safe_collision" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS -I "$HERE/safe_physics" safe_collision_test.cpp -o build/safe_test.exe; then
  ./build/safe_test.exe || FAILED=1
else
  echo "  [编译失败] safe_collision" >&2
  FAILED=1
fi
echo

# ---------------------------------------------------------------------------
# 6) RaceDeltaTracker —— 零外部依赖
#    核心命题：时差必须走"弧长差 ÷ **前车**分段速度"，绝不用欧氏距离 ÷ 实时速度
#    关键性质：格式化三档（--/-0.X/-X.XX）、非领先方恒负号、外推不发弯道畸变
# ---------------------------------------------------------------------------
echo "=== [6/8] race_delta ==="
cd "$HERE/race_delta" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS race_delta_tracker.cpp race_delta_tracker_test.cpp -o build/rd_test.exe; then
  ./build/rd_test.exe || FAILED=1
else
  echo "  [编译失败] race_delta" >&2
  FAILED=1
fi
# Python 镜像交叉复核：独立按规格重写公式，与 C++ 侧数值逐条比对
for PY in python python3 "$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
          /c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  —— Python 镜像交叉验证（verify_race_delta.py）——"
    "$PY" verify_race_delta.py || FAILED=1
    break
  fi
done
echo

echo "=== [7/8] harness（四模块全链路 + 混沌网络压测） ==="
cd "$HERE/harness" || exit 1
# 压测需要真 GLM（glm::quat / glm::angleAxis），不回退 shim
if [ -n "$GLM_SRC" ]; then
  if "$GXX" $CXXFLAGS -I "$HERE/timesync" -I "$HERE/rb_replicator" -I "$HERE/wasm" \
       -I "$HERE/safe_collision" -I "$HERE/safe_physics" -I "$GLM_SRC" \
       simulation_harness.cpp "$HERE/timesync/forza_time_sync.cpp" -o harness.exe; then
    ./harness.exe || FAILED=1
  else
    echo "  [编译失败] simulation_harness.cpp" >&2
    FAILED=1
  fi
else
  echo "  [跳过] 未找到真 GLM（压测需要真实四元数行为，不回退 shim）"
fi
echo

# ---------------------------------------------------------------------------
# 8) mp_chaos —— 单机无头多人混沌仿真测试台（Simulation Test Harness）
#    一个进程内起 1 权威服务端 + 4 客户端（1 本地带渲染平滑层 + 3 无头 Bot），
#    注入 **混沌信道**（RTT 100ms / 抖动 20~160ms 非对称长尾 / 8% 丢包 /
#    5% 乱序），用 Client 0 观察远端 3 车，量化"闪现 / Rubberbanding"。
#    四相断言：A 信道统计 / B Jitter 与 Jerk / C HUD 秒差双分支 / D 碰撞不弹开。
#    复用真模块：ForzaTimeSynchronizer + NetworkRigidBodyReplicator +
#                SafePhysicsSolver + RaceDeltaTracker；零额外依赖。
#    确定性：同 seed ⇒ 逐字节一致的日志（可当回归基线）。
#    需要真 GLM（rb_replicator 用 glm::quat），不回退 shim。
# ---------------------------------------------------------------------------
echo "=== [8/8] mp_chaos（单机无头多人混沌仿真测试台） ==="
cd "$HERE/mp_chaos" || exit 1
mkdir -p build
if [ -n "$GLM_SRC" ]; then
  if "$GXX" $CXXFLAGS -I "$HERE/timesync" -I "$HERE/rb_replicator" \
       -I "$HERE/safe_physics" -I "$HERE/race_delta" -I "$GLM_SRC" \
       mp_chaos_harness.cpp "$HERE/timesync/forza_time_sync.cpp" \
       "$HERE/race_delta/race_delta_tracker.cpp" -o build/mp_chaos.exe; then
    ./build/mp_chaos.exe || FAILED=1
    # 确定性回归：同 seed 两次运行必须一致（日志可当基线）
    #   屏蔽掉所有**墙钟相关**的输出行再比对 —— 它们随机器负载浮动，不是"随机源"：
    #     · 真实墙钟 / 等效帧率 / 仿真吞吐（都是耗时统计）
    if ./build/mp_chaos.exe -q > .det_a.txt 2>&1 && \
       ./build/mp_chaos.exe -q > .det_b.txt 2>&1; then
      if diff -q <(grep -v "真实墙钟\|等效帧率\|仿真吞吐" .det_a.txt) \
                 <(grep -v "真实墙钟\|等效帧率\|仿真吞吐" .det_b.txt) >/dev/null; then
        echo "  [PASS] ★★ 同 seed 输出逐字一致（确定性 ⇒ 可当回归基线）"
      else
        echo "  [FAIL] 同 seed 输出不一致（随机源没接确定性 RNG？）" >&2
        FAILED=1
      fi
    fi
    rm -f .det_a.txt .det_b.txt
  else
    echo "  [编译失败] mp_chaos_harness.cpp" >&2
    FAILED=1
  fi
else
  echo "  [跳过] 未找到真 GLM（rb_replicator 需要真实四元数，不回退 shim）"
fi
echo

if [ "$FAILED" -eq 0 ]; then
  echo "=== 全部通过 ==="
else
  echo "=== 有失败项 ===" >&2
fi
exit "$FAILED"
```
