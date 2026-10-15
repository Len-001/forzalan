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
