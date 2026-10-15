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
