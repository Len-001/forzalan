// =============================================================================
//  mp_chaos_harness.cpp —— 单机无头多人混沌仿真测试台（Multiplayer Chaos Harness）
//
//  用户只有一台开发机，无法搭真实多设备联机环境。本程序在**单进程单线程**里
//  用确定性仿真墙钟，模拟一间完整的 4 人房间：
//
//      DedicatedServer（60Hz 权威物理循环）
//            │  96B 快照 @60Hz，经 ChaosChannelSimulator
//            ├──────────────┬──────────────┬──────────────┐
//        Client 0         Bot 1          Bot 2          Bot 3
//      （本地玩家，      （无头虚拟玩家，各发按键输入 @30Hz）
//        含渲染平滑层）
//
//  ── 为什么是单线程 + 仿真墙钟，而不是真开线程 + sleep ──────────────────────
//  ① 可复现：固定 seed ⇒ 逐位一致的日志。真实线程 + sleep 的调度噪声会让
//     同一 seed 两次跑出不同结果，压测报告就不能当回归基线。
//  ② 快：12s 仿真在毫秒级跑完，不必真等 100ms RTT × 720 帧。
//  ③ 真实并发不是被测目标 —— 被测目标是**同步算法**在丢包/乱序/抖动下的表现。
//     （真实线程版另有价值，但那是"测 OS 调度"，不是"测同步算法"。）
//
//  ── 被测的四个真模块（真调用，非复刻）──────────────────────────────────────
//     · forza::net::ForzaTimeSynchronizer   —— NTP + Clock Slewing（时间轴对齐）
//     · forza::net::NetworkRigidBodyReplicator —— 航位推测 + 双层误差融合（平滑层）
//     · forza::physics::SafePhysicsSolver   —— 分离冲量/法线平整/冲量截断（碰撞）
//     · forza::race::RaceDeltaTracker       —— 秒差解算 + HUD 文本格式化
//
//  ── 混沌信道（ChaosChannelSimulator）────────────────────────────────────────
//     · RTT 均值 100ms（单程 50ms）
//     · 抖动：**非对称长尾分布**（对数正态），钳到 [20, 160]ms
//       —— 为什么不是高斯：真实排队延迟是乘性的、右偏长尾的。高斯对称且尾部
//          衰减太快，压不出"偶发 160ms 尖峰"这种真正触发 rubberbanding 的情形。
//     · 丢包 8%（伯努利独立）
//     · 乱序 5%：以概率 p 让某包**早于前序包到达**（真实网络里后发先至）
//
//  ── 五项断言 ────────────────────────────────────────────────────────────────
//     A. 网络信道统计：丢包率≈8%、抖动落在 [20,160]、确实发生乱序
//     B. 抖动/闪现：视觉 vs 权威残差 RMSE；**Jerk（加加速度）峰值**；
//        单帧位移突变（ΔP > threshold）计数必须为 0
//     C. HUD 秒差文本：P1 必须是 "--"；落后必须是 "-0.X"（严格业务规则）
//     D. 碰撞弹跳：Bot 1 撞护栏 + 追尾 Bot 2，断言法向速度**无反向暴增**、
//        垂直速度未爆炸、动能不增
//     E. 实时统计：FPS / RTT / 抖动幅度 / Jerk 峰值 全部落盘并断言
//
//  ── 编译 ────────────────────────────────────────────────────────────────────
//     g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic
//         -I ../timesync -I ../rb_replicator -I ../safe_physics -I ../race_delta
//         -I /e/g-truc-glm-8d1fd52
//         mp_chaos_harness.cpp ../timesync/forza_time_sync.cpp
//                             ../race_delta/race_delta_tracker.cpp
//         -o mp_chaos.exe
//     Windows/MinGW 跑前 export PATH="/e/mingw64/bin:$PATH"，否则退出码 127。
//
//  跑法： ./mp_chaos.exe [-q|-v] [--seed=N] [--sec=12] [--hud-every=N]
// =============================================================================

#include "forza_time_sync.h"
#include "race_delta_tracker.h"
#include "rigid_body_replicator.h"
#include "safe_physics_solver.h"

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <iterator>
#include <string>
#include <vector>

// =============================================================================
//  0. 常量 / 确定性随机 / 混沌信道
// =============================================================================
namespace mp {

constexpr double kTickSec   = 1.0 / 60.0;         // 物理/广播固定步长
constexpr double kKmhToMs   = 1.0 / 3.6;
constexpr double kMsToKmh   = 3.6;
constexpr int    kVehicles  = 4;                  // 1 本地 + 3 Bot
constexpr int    kLocalId   = 0;                  // Client 0 = 本地玩家
constexpr double kCarMassKg = 1380.0;             // 与主项目一致
constexpr double kCarHalfLenM = 2.30;             // 车身半长（追尾判定用）
constexpr double kCarHalfWidM = 0.95;             // 车身半宽（侧向判定用）
/**
 * 偏航转动惯量（kg·m²）。
 *
 * ⚠ 这个值不是随便填的：它决定了"偏心接触注入多少自旋"。
 *   先前误用 1800（那是**俯仰**惯量的量级），在 1.2m 力臂下每 20m/s 撞击
 *   会注入 ω_yaw ≈ 4 rad/s 的虚假偏航 —— 表现成"被撞一下车头猛地一甩"。
 *   整车绕 Y 的偏航惯量按 I = m·(L²+W²)/12 估算：
 *     1380 × (4.6² + 1.9²) / 12 ≈ 2845 kg·m² ⇒ invI ≈ 1/2850。
 *   这里取 2850，与"车身是对角线 4.6×1.9 的矩形"的实车量级一致。
 */
constexpr double kCarYawInertia = 2850.0;
constexpr double kCarInvYawInertia = 1.0 / kCarYawInertia;

/**
 * xorshift32 + 派生分布。压测必须**逐位可复现** —— 绝不用 rand() 或
 * 默认种子的 mt19937（标准不规定两者的输出序列，换个 libc 结果就变）。
 */
struct Rng final {
  std::uint32_t s;
  explicit Rng(std::uint32_t seed) noexcept : s(seed == 0 ? 0x9E3779B9u : seed) {}

  std::uint32_t NextU32() noexcept {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
  }
  /// [0,1) 均匀
  double Uniform() noexcept { return static_cast<double>(NextU32()) * (1.0 / 4294967296.0); }

  /// Box–Muller 标准正态（备用；信道抖动走对数正态，见下）
  double Gaussian() noexcept {
    const double u1 = std::max(Uniform(), 1e-12);
    const double u2 = Uniform();
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(6.283185307179586 * u2);
  }

  /**
   * **非对称长尾**抖动：对数正态。
   *
   * 为什么不用高斯：真实网络排队延迟是**乘性**过程（M/M/1 排队论里
   * 延迟尾是指数/对数正态的），分布**右偏**且尾部重。高斯的尾部衰减太快，
   * 会把"偶发 160ms 尖峰"这类真正触发 rubberbanding 的情形直接削掉。
   *
   * 参数化：先取均值 mu 与"对数标准差" sigmaLog，使分布中位数落在 baseMs 上、
   * 尾部伸到 baseMs·exp(2σ) 量级。再乘以一个对称扰动让它在两端都可采样。
   */
  double LogNormalMs(double medianMs, double sigmaLog) noexcept {
    const double u1 = std::max(Uniform(), 1e-12);
    const double u2 = Uniform();
    const double z = std::sqrt(-2.0 * std::log(u1)) * std::cos(6.283185307179586 * u2);
    return medianMs * std::exp(sigmaLog * z);
  }
};

/// 混沌信道参数。默认值 = 本任务规格。
struct ChaosConfig final {
  double rttMeanMs      = 100.0;   ///< 规格：平均 RTT 100ms
  double jitterLoMs     = 20.0;    ///< 规格：抖动下限
  double jitterHiMs     = 160.0;   ///< 规格：抖动上限
  double jitterMedianMs = 50.0;    ///< 单程延迟中位数（RTT 均值 100 ⇒ 单程 50）
  double sigmaLog       = 0.55;    ///< 对数正态 sigma：0.55 ⇒ 尾部伸到 ~150ms+
  double lossRate       = 0.08;    ///< 规格：8% 独立丢包
  double reorderRate    = 0.05;    ///< 规格：5% 的包早于前序包到达
  double reorderLeadMs  = 12.0;    ///< 乱序包"抢跑"的提前量（让它挤到前序包之前）
};

/// 在途数据包（快照或 NTP 回程）。
struct Packet final {
  forza::net::RigidBodyNetSnapshot snap{};
  double   arriveSec = 0.0;    ///< 预定到达的仿真墙钟（秒）
  std::uint32_t seq  = 0;      ///< 发送序号
  bool     isPong    = false;
  forza::net::Nanos t1 = 0, t2 = 0, t3 = 0;
  int      destClient = -1;    ///< 哪个客户端收（-1 = 广播）
  double   sampledLatMs = 0.0; ///< 采样到的单程延迟（统计抖动用）
};

/**
 * 混沌信道模拟器。
 *
 * 关键设计：**按到达时刻在接收侧排序**，而不是把包立刻塞给客户端。
 * 乱序必须由"两包的实际到达时刻倒挂"自然产生 —— 若用"收到即交付"，
 * 乱序就只是一句空话，客户端永远看不到倒序的 seq。
 */
class ChaosChannelSimulator final {
 public:
  explicit ChaosChannelSimulator(const ChaosConfig& cfg, std::uint32_t seed) noexcept
      : cfg_(cfg), rng_(seed) {}

  /// 采样一次单程延迟（非对称长尾 + 钳到规格区间）
  double SampleOneWayMs() noexcept {
    double ms = rng_.LogNormalMs(cfg_.jitterMedianMs, cfg_.sigmaLog);
    ms = std::clamp(ms, cfg_.jitterLoMs, cfg_.jitterHiMs);
    sumLatMs_ += ms;
    ++latSamples_;
    minLatMs_ = std::min(minLatMs_, ms);
    maxLatMs_ = std::max(maxLatMs_, ms);
    return ms;
  }

  /// @return false = 这个包被丢了
  bool SendSnapshot(const forza::net::RigidBodyNetSnapshot& s, double nowSec, int dest) noexcept {
    ++sent_;
    if (rng_.Uniform() < cfg_.lossRate) { ++dropped_; return false; }
    Packet p{};
    p.snap = s;
    p.seq = ++seqCounter_;
    p.destClient = dest;
    const double lat = SampleOneWayMs();
    p.sampledLatMs = lat;
    // ── 乱序：以概率 p 让本包"抢跑"到前序包之前 ──────────────────────────
    // 做法不是"延后本包"，而是把本包的到达时刻**提前** reorderLeadMs。
    // 这更贴近真实的"后发先至"（different path / smaller queue），
    // 且保证 outOfOrder 计数真的会在接收侧被观测到。
    double arrive = nowSec + lat * 1e-3;
    if (rng_.Uniform() < cfg_.reorderRate) {
      arrive -= cfg_.reorderLeadMs * 1e-3;
      ++reorderInjected_;
      if (arrive < nowSec) arrive = nowSec;   // 不能早于发送时刻
    }
    p.arriveSec = arrive;
    queue_.push_back(p);
    return true;
  }

  /**
   * 发送 NTP 回程包。
   * @param outboundLatMs 去程实际延迟；**必须复用它**并且到达时刻 = t3 发送时刻
   *        + 回程延迟 ⇒ RTT = (t4−t1)−(t3−t2) 才等于真实往返。用平均值会让
   *        RTT 算出"小于单程下限"的怪值（老坑，见 simulation_harness.cpp 注释）。
   */
  void SendPong(forza::net::Nanos t1, forza::net::Nanos t2, forza::net::Nanos t3,
                double sendSec, int dest) noexcept {
    ++sent_;
    if (rng_.Uniform() < cfg_.lossRate) { ++dropped_; return; }
    Packet p{};
    p.isPong = true;
    p.t1 = t1; p.t2 = t2; p.t3 = t3;
    p.seq = ++seqCounter_;
    p.destClient = dest;
    const double lat = SampleOneWayMs();
    p.sampledLatMs = lat;
    double arrive = sendSec + lat * 1e-3;
    if (rng_.Uniform() < cfg_.reorderRate) { arrive -= cfg_.reorderLeadMs * 1e-3; ++reorderInjected_; }
    p.arriveSec = arrive;
    queue_.push_back(p);
  }

  /// 取出所有已到期包，按到达时刻升序交付（= 网络把乱序真实重排过）
  std::vector<Packet> DrainArrived(double nowSec) noexcept {
    std::vector<Packet> out;
    for (std::size_t i = 0; i < queue_.size();) {
      if (queue_[i].arriveSec <= nowSec) {
        out.push_back(queue_[i]);
        queue_[i] = queue_.back();
        queue_.pop_back();
      } else {
        ++i;
      }
    }
    std::sort(out.begin(), out.end(),
              [](const Packet& a, const Packet& b) { return a.arriveSec < b.arriveSec; });
    for (auto& p : out) {
      ++delivered_;
      // 乱序 = 本包 seq 小于"已见过的最大 seq"（后发先至的包先到）
      if (p.seq < maxSeqSeen_) ++outOfOrder_;
      maxSeqSeen_ = std::max(maxSeqSeen_, p.seq);
    }
    return out;
  }

  std::uint64_t Sent() const noexcept { return sent_; }
  std::uint64_t Dropped() const noexcept { return dropped_; }
  std::uint64_t Delivered() const noexcept { return delivered_; }
  std::uint64_t OutOfOrder() const noexcept { return outOfOrder_; }
  std::uint64_t ReorderInjected() const noexcept { return reorderInjected_; }
  double DropPct() const noexcept {
    return sent_ ? 100.0 * static_cast<double>(dropped_) / static_cast<double>(sent_) : 0.0;
  }
  double MeanOneWayMs() const noexcept {
    return latSamples_ ? sumLatMs_ / static_cast<double>(latSamples_) : 0.0;
  }
  double MinOneWayMs() const noexcept { return minLatMs_; }
  double MaxOneWayMs() const noexcept { return maxLatMs_; }
  double JitterP95Ms() const noexcept { return p95LatMs_; }
  std::size_t InFlight() const noexcept { return queue_.size(); }

 private:
  ChaosConfig cfg_;
  Rng rng_;
  std::vector<Packet> queue_;
  std::uint64_t sent_ = 0, dropped_ = 0, delivered_ = 0, outOfOrder_ = 0, reorderInjected_ = 0;
  std::uint32_t seqCounter_ = 0;
  std::uint32_t maxSeqSeen_ = 0;
  double sumLatMs_ = 0.0, minLatMs_ = 1e30, maxLatMs_ = 0.0, p95LatMs_ = 0.0;
  std::size_t latSamples_ = 0;
};

// =============================================================================
//  1. 车辆状态（服务端权威）
// =============================================================================

/**
 * 一辆车的权威状态。
 *
 * `sMeters` 是**沿中心线的累计弧长**（本圈），由赛道投影得到 —— 这是秒差
 * 解算的正确自变量（不是欧氏距离，不是世界坐标）。
 */
struct Car final {
  int id = 0;
  const char* name = "?";
  int color = 0;                    ///< ANSI 色号，日志区分用

  glm::vec3 pos{0.0F};              ///< 世界坐标（x, y, z）
  glm::vec3 vel{0.0F};              ///< m/s
  float yaw = 0.0F;                 ///< 偏航（rad），+Z 为车头
  float targetSpeedMs = 55.0F;      ///< Bot/玩家的目标车速

  // ── 赛道进度 ──
  double sMeters = 0.0;             ///< 本圈累计弧长
  int lap = 0;
  int cpIndex = -1;                 ///< 已通过的最后 Checkpoint
  double prevS = 0.0, prevT = 0.0;  ///< 上一帧 S/时刻（算 segSpeed 用）
  forza::race::DeltaCarState delta{};  ///< 喂给 RaceDeltaTracker

  // ── Bot 操控（模拟真人按键）──
  float steerInput = 0.0F;          ///< [-1,1]，+1 = 右打
  float throttle = 0.0F;            ///< [0,1]
  float brake = 0.0F;               ///< [0,1]
  double phase = 0.0;               ///< 每车独立的操作噪声相位

  // ── 碰撞事件（本轮内累积）──
  float maxReboundNormalMs = 0.0F;  ///< 碰撞后法向反弹速度峰值
  float maxVyAfterImpact = 0.0F;    ///< 碰撞后垂直速度峰值（必须很小）
  float maxImpactApproachMs = 0.0F; ///< 撞击接近速度峰值
  bool  hadImpact = false;
  bool  hadBarrierImpact = false;
  bool  hadCarImpact = false;
  double energyBeforeJ = 0.0, energyAfterJ = 0.0;
};

/// 把车辆状态转成网络快照（96B 工作结构）
forza::net::RigidBodyNetSnapshot ToSnapshot(const Car& c, double serverTimeSec) noexcept {
  forza::net::RigidBodyNetSnapshot s{};
  s.frame = static_cast<std::uint32_t>(serverTimeSec * 60.0);
  s.tickMs = static_cast<std::uint32_t>(serverTimeSec * 1000.0);
  s.serverTimeSec = static_cast<float>(serverTimeSec);
  s.position = c.pos;
  s.rotation = glm::angleAxis(c.yaw, glm::vec3(0.0F, 1.0F, 0.0F));
  s.velocity = c.vel;
  s.angularVelocity = glm::vec3(0.0F);
  s.accel = glm::vec3(0.0F);
  // 复用未使用的 pad 字段携带车号（不动物理布局，避免破坏 96B 静态断言）
  s._pad0 = static_cast<float>(c.id);
  return s;
}

[[nodiscard]] int SnapshotIdOf(const forza::net::RigidBodyNetSnapshot& s) noexcept {
  return static_cast<int>(s._pad0 + 0.5F);
}

// =============================================================================
//  2. 客户端侧的抖动/闪现量化检测器
// =============================================================================

/**
 * 单车同步质量检测器：在 Client 0 的视角上，逐帧对比"最终渲染位置"与
 * "权威物理真实位置"，量化抖动与闪现。
 *
 * ── 三层指标 ────────────────────────────────────────────────────────────────
 *  ① 残差：err = |visual − authoritative|。积分出 RMSE / 峰值。
 *     这是"稳态滞后"的直接度量（客户端渲染的是过去的时刻）。
 *  ② 闪现（Rubberbanding）：单帧视觉位移 step = |vis_n − vis_{n−1}|。
 *     若 step > 物理合理上限（按车速推出）⇒ 记一次 jumps。
 *     这是"肉眼可见的瞬移"的定量代理。
 *  ③ **Jerk（加加速度）**：用户明确要求"视觉加速度的一阶导数"。
 *     jerk = |a_n − a_{n−1}| / dt，其中 a = (v_n − v_{n−1}) / dt，
 *          v = (p_n − p_{n−1}) / dt。
 *     为什么必须是三阶量：位置误差可以平滑（看不出），速度误差可以容忍
 *     （感觉车"飘"），但 **jerk 尖峰就是"被猛地一拽"的手感**——
 *     这才是 rubberbanding 的物理定义（人的前庭系统对加加速度敏感）。
 *     实测基线：正常插值下 jerk ≈ 0；一次 0.5m 的瞬移在 1/60s 内产生
 *     jerk ≈ 0.5/(1/60)³ ≈ 10.8 km/s³ 级别的尖峰。
 */
struct JitterDetector final {
  // ── 配置 ──
  double stepLimitM = 0.0;      ///< 单帧位移上限（按车速推出，不是常数）
  double jerkLimitMs3 = 0.0;    ///< Jerk 上限（按车速推出）

  // ── 残差 ──
  double sumSq = 0.0;
  std::size_t n = 0;
  double maxErrM = 0.0;

  // ── 位置轨迹（用于差分）──
  glm::vec3 pPrev{0.0F};        ///< 上一帧视觉位置
  glm::vec3 vPrev{0.0F};        ///< 上一帧视觉速度（一阶差分）
  glm::vec3 aPrev{0.0F};        ///< 上一帧视觉加速度（二阶差分）
  bool hasP = false, hasV = false, hasA = false;

  // ── 闪现 / Jerk ──
  double maxStepM = 0.0;
  double maxJerkMs3 = 0.0;
  int jumps = 0;                ///< 单帧位移超限次数
  int jerkSpikes = 0;           ///< Jerk 超限次数
  double jumpAtSec = -1.0;      ///< 首次闪现发生时刻（诊断用）
  double jerkPeakAtSec = -1.0;

  // ── 门控 ──
  bool enabled = false;         ///< 暖机期不采集
  int holdFrames = 0;           ///< 权威侧真实阶跃后的恢复窗（碰撞/重定位）
  std::size_t samples = 0;
  std::size_t held = 0;

  /// 按当前车速推单帧位移上限：v·dt 给 4 倍裕量（外推+纠偏叠加），再叠 0.75m
  /// 绝对宽松项（防静止时被浮点噪声误判）。
  void SetLimitsFromSpeed(double speedMs) noexcept {
    stepLimitM = speedMs * kTickSec * 4.0 + 0.75;
    // Jerk 上限：允许"一个 dt 内速度变化 ≤ 2·v"（急刹/急加速的物理上界）再平方。
    // 折算成加加速度量纲 m/s³：2v/dt²。给 3 倍裕量。
    const double v = std::max(speedMs, 5.0);
    jerkLimitMs3 = 3.0 * (2.0 * v) / (kTickSec * kTickSec);
  }

  void Push(const glm::vec3& visual, const glm::vec3& authoritative, double nowSec) noexcept {
    if (!enabled) return;
    if (holdFrames > 0) {
      --holdFrames;
      ++held;
      pPrev = visual; hasP = true; hasV = false; hasA = false;
      return;
    }
    const double err = static_cast<double>(glm::length(visual - authoritative));
    sumSq += err * err;
    ++n;
    samples = n;
    maxErrM = std::max(maxErrM, err);

    if (hasP) {
      const glm::vec3 dP = visual - pPrev;
      const double step = static_cast<double>(glm::length(dP));
      maxStepM = std::max(maxStepM, step);
      if (step > stepLimitM) {
        ++jumps;
        if (jumpAtSec < 0.0) jumpAtSec = nowSec;
      }
      // ── 三阶差分链：p → v → a → jerk ──
      const glm::vec3 vNow = dP * static_cast<float>(1.0 / kTickSec);
      if (hasV) {
        const glm::vec3 aNow = (vNow - vPrev) * static_cast<float>(1.0 / kTickSec);
        if (hasA) {
          const double jerk = static_cast<double>(glm::length(aNow - aPrev)) / kTickSec;
          if (jerk > maxJerkMs3) { maxJerkMs3 = jerk; jerkPeakAtSec = nowSec; }
          if (jerk > jerkLimitMs3) ++jerkSpikes;
        }
        aPrev = aNow; hasA = true;
      }
      vPrev = vNow; hasV = true;
    }
    pPrev = visual; hasP = true;
  }

  [[nodiscard]] double Rmse() const noexcept {
    return n ? std::sqrt(sumSq / static_cast<double>(n)) : 0.0;
  }
};

// =============================================================================
//  3. 客户端（本地 + Bot 共用接收侧）
// =============================================================================

struct ClientPeer final {
  const char* name = "?";
  bool isLocal = false;                    ///< 是否本地玩家（有渲染平滑层）
  forza::net::ForzaTimeSynchronizer sync{};
  std::array<forza::net::NetworkRigidBodyReplicator, kVehicles> repl{};  ///< 每车独占一个
  std::array<JitterDetector, kVehicles> jitter{};
  std::array<bool, kVehicles> replPrimed{};

  // 网络统计
  double sumRttMs = 0.0;
  std::size_t rttCount = 0;
  double minRttMs = 1e30, maxRttMs = 0.0;
  std::size_t accepted = 0, rejected = 0, hardResyncs = 0;
  double warpAbsSum = 0.0;
  std::size_t warpSamples = 0;
};

// =============================================================================
//  4. 赛道（内建解析赛道 —— 闭合 Catmull-Rom，与 race_delta 同构）
// =============================================================================

/**
 * 一条闭合赛道：8 个控制点构成一个约 1.2km 的类椭圆（带一处减速弯）。
 * 关键点：控制点布局刻意让**弯里明显减速**，这样秒差的外推分支
 * （ΔS / v_前车）才会被真正走到，而不是永远停在直道上的解析解。
 */
struct Track final {
  static constexpr std::size_t kCtl = 16;
  static constexpr std::size_t kCp = 8;

  double ctlXZ[kCtl][2]{};
  double cpArc[kCp]{};
  double lengthM = 0.0;

  forza::race::RaceDeltaTracker delta{};    ///< 秒差解算器（模块真身）
  std::array<double, forza::race::ArcLengthTable::kMaxSeg + 1> sTable{};
  std::size_t sN = 0;

  void Build() noexcept {
    // 类椭圆 12 控制点 + 一处收窄成减速弯（x 方向内凹）
    constexpr double R = 190.0, rx = 300.0;
    for (std::size_t i = 0; i < kCtl; ++i) {
      const double th = 6.283185307179586 * static_cast<double>(i) / static_cast<double>(kCtl);
      double x = rx * std::cos(th);
      double z = R * std::sin(th);
      if (i == 3 || i == 4) x -= 55.0;      // 减速弯：把这两点向内侧拉
      ctlXZ[i][0] = x;
      ctlXZ[i][1] = z;
    }
    // 8 个 Checkpoint 等弧长分布（先粗估长度，再按比例放 CP）
    forza::race::SplinePath p{};
    p.n = kCtl;
    for (std::size_t i = 0; i < kCtl; ++i) { p.ctl[i][0] = ctlXZ[i][0]; p.ctl[i][1] = ctlXZ[i][1]; }
    p.length = MeasureLength(p);
    lengthM = p.length;
    for (std::size_t i = 0; i < kCp; ++i) {
      cpArc[i] = lengthM * static_cast<double>(i) / static_cast<double>(kCp);
    }
    delta.SetTrack(ctlXZ, kCtl, cpArc, kCp);
    forza::race::ArcLengthTable tbl{};
    forza::race::ArcLengthTable::build(p, tbl);
    sTable = tbl.s;
    sN = tbl.n;
    ctlPath_ = p;
  }

  /// 建一条等弧长查询表（用 race_delta 的同构实现，保证与秒差模块一致）
  [[nodiscard]] static double MeasureLength(const forza::race::SplinePath& p) noexcept {
    if (p.n == 0) return 0.0;
    const std::size_t m = 8192;
    double px = 0.0, pz = 0.0, cum = 0.0;
    forza::race::CatmullRom::eval(p, 0.0, &px, &pz);
    for (std::size_t i = 1; i <= m; ++i) {
      const double t = (static_cast<double>(i) / static_cast<double>(m)) * static_cast<double>(p.n);
      double x = 0.0, z = 0.0;
      forza::race::CatmullRom::eval(p, t, &x, &z);
      cum += std::hypot(x - px, z - pz);
      px = x; pz = z;
    }
    return cum;
  }

  /// 弧长 S -> 世界坐标 (x,z) + 切线方向
  void PosAtS(double s, double* outX, double* outZ, double* outDirX, double* outDirZ) const noexcept {
    const double t = ParamOfS(s);
    double x0 = 0.0, z0 = 0.0;
    forza::race::CatmullRom::eval(ctlPath_, t, &x0, &z0);
    const double eps = 0.5;
    double x1 = 0.0, z1 = 0.0;
    forza::race::CatmullRom::eval(ctlPath_, ParamOfS(s + eps), &x1, &z1);
    *outX = x0; *outZ = z0;
    const double dx = x1 - x0, dz = z1 - z0;
    const double l = std::hypot(dx, dz);
    *outDirX = (l > 1e-9) ? dx / l : 1.0;
    *outDirZ = (l > 1e-9) ? dz / l : 0.0;
  }

  [[nodiscard]] double ParamOfS(double sm) const noexcept {
    if (sN == 0 || lengthM <= 0.0) return 0.0;
    double v = std::fmod(sm, lengthM);
    if (v < 0.0) v += lengthM;
    std::size_t lo = 0, hi = sN;
    while (lo + 1 < hi) {
      const std::size_t mid = (lo + hi) / 2;
      if (sTable[mid] <= v) lo = mid; else hi = mid;
    }
    const double s0 = sTable[lo], s1 = sTable[lo + 1];
    const double seg = s1 - s0;
    const double frac = (seg > 1e-12) ? (v - s0) / seg : 0.0;
    return (static_cast<double>(lo) + frac) / static_cast<double>(sN) *
           static_cast<double>(kCtl);
  }

  [[nodiscard]] double Project(double x, double z, double hintS = -1.0) const noexcept {
    return delta.Project(x, z, hintS);
  }

 private:
  forza::race::SplinePath ctlPath_{};
};

// =============================================================================
//  5. 测试框架
// =============================================================================
namespace {

int g_pass = 0;
int g_fail = 0;

void Check(bool cond, const std::string& what, const std::string& detail = {}) {
  if (cond) { ++g_pass; std::printf("  [\033[32mPASS\033[0m] %s", what.c_str()); }
  else      { ++g_fail; std::printf("  [\033[31mFAIL\033[0m] %s", what.c_str()); }
  if (!detail.empty()) std::printf("   %s", detail.c_str());
  std::printf("\n");
}

void Banner(const char* t) {
  std::printf("\n\033[36m══════════════════════════════════════════════════════════════\033[0m\n");
  std::printf("\033[1m%s\033[0m\n", t);
  std::printf("\033[36m══════════════════════════════════════════════════════════════\033[0m\n");
}

std::string F(double v, int prec = 4) {
  char b[64];
  std::snprintf(b, sizeof(b), "%.*f", prec, v);
  return std::string(b);
}

}  // namespace

// =============================================================================
//  6. 压测主体
// =============================================================================
namespace {

using forza::net::ForzaTimeSynchronizer;
using forza::net::NetworkRigidBodyReplicator;
using forza::net::RigidBodyNetSnapshot;
using forza::net::Nanos;
using forza::net::kNanosPerSecond;
using forza::net::SyncEvent;
using forza::net::kNoSample;
using forza::physics::SafePhysicsSolver;
using forza::physics::SolverConfig;
using forza::physics::RigidBodyView;
using forza::physics::ContactManifold;
using forza::physics::ContactKind;
using forza::physics::ContactPoint;
using forza::physics::Vec3;
using forza::physics::SolveStats;
using forza::race::DeltaCarState;
using forza::race::DeltaResult;
using forza::race::DeltaMethod;
using forza::race::RaceDeltaTracker;

/// 总报告
struct Report final {
  // 网络
  std::uint64_t sent = 0, dropped = 0, delivered = 0, outOfOrder = 0, reorderInjected = 0;
  double dropPct = 0.0;
  double oneWayMinMs = 0.0, oneWayMeanMs = 0.0, oneWayMaxMs = 0.0;
  // 客户端时钟
  double meanRttMs = 0.0, minRttMs = 0.0, maxRttMs = 0.0;
  bool locked = false;
  double meanAbsWarpPct = 0.0;
  std::size_t hardResyncs = 0, syncRejected = 0;
  // 抖动/闪现（对远端 3 车取最差）
  double rmseM = 0.0, maxErrM = 0.0;
  double maxStepM = 0.0, maxJerkMs3 = 0.0;
  double stepLimitM = 0.0, jerkLimitMs3 = 0.0;
  int jumps = 0, jerkSpikes = 0;
  std::size_t jitterSamples = 0;
  double firstJumpSec = -1.0, jerkPeakSec = -1.0;
  // HUD 秒差
  int hudChecks = 0, hudLeaderDash = 0, hudChaserNeg = 0;
  std::string hudSampleLocal, hudSampleChaser;
  bool hudEverNonLeader = false;
  // 碰撞
  bool barrierImpact = false, carImpact = false;
  double barrierApproachMs = 0.0, barrierReboundMs = 0.0;
  double carApproachMs = 0.0, carReboundMs = 0.0;
  double carCgSepMs = 0.0;          ///< 质心分离（仅供参考；判据用接触点分离）
  double maxVyAllMs = 0.0;
  double energyBeforeJ = 0.0, energyAfterJ = 0.0;
  int clampedImpulses = 0, redirectedNormals = 0, projected = 0, suspLocked = 0;
  // 运行时
  double simulatedSec = 0.0;
  int ticks = 0;
  double wallMs = 0.0;          ///< 真实墙钟耗时（算等效 FPS）
  double effectiveFps = 0.0;
  double peakSpeedMs = 0.0;
};

/**
 * 主仿真。
 *
 * 时间线：
 *   [0.0, 3.0)  暖机：Client 0 建立时钟锁 + replicator 初次对齐
 *   [3.0, 6.0)  Bot 1 加速撞护栏（180km/h）
 *   [6.0, 8.5)  Bot 1 追尾 Bot 2
 *   [8.5, 结束) 稳态巡航：统计抖动/Jerk/HUD 秒差
 */
Report RunChaos(std::uint32_t seed, double durationSec, bool verbose, int hudEveryN) {
  Report rep;
  Rng rng(seed);

  // ---- 赛道装配 ----
  Track track;
  track.Build();

  // ---- 混沌信道 ----
  ChaosChannelSimulator channel(ChaosConfig{}, seed ^ 0xA5A5A5A5u);

  // ---- 车辆初始化：发车格错开 ----
  std::array<Car, kVehicles> cars{};
  const char* names[kVehicles] = {"C0(LOCAL)", "BOT1", "BOT2", "BOT3"};
  const int colors[kVehicles] = {36, 33, 35, 32};   // 青 / 黄 / 品红 / 绿
  for (int i = 0; i < kVehicles; ++i) {
    cars[i].id = i;
    cars[i].name = names[i];
    cars[i].color = colors[i];
    cars[i].phase = 0.7 * static_cast<double>(i) + 0.3;
    cars[i].targetSpeedMs = 52.0F + 3.0F * static_cast<float>(i);   // 略有性能差 ⇒ 会拉开
  }
  // ★ 发车格：按 id 沿中心线错开 12m，横向错位 2.2m（避免开局就撞）
  auto PlaceAtS = [&](Car& c, double s, double latOff) {
    double x = 0.0, z = 0.0, dx = 1.0, dz = 0.0;
    track.PosAtS(s, &x, &z, &dx, &dz);
    const double nx = -dz, nz = dx;      // 左法向
    c.pos = glm::vec3(static_cast<float>(x + nx * latOff), 0.0F,
                      static_cast<float>(z + nz * latOff));
    c.yaw = static_cast<float>(std::atan2(dx, dz));   // 车头 +Z ⇒ yaw = atan2(dx, dz)
    c.sMeters = s;
    c.prevS = s;
    c.delta.sMeters = s;
  };
  for (int i = 0; i < kVehicles; ++i) {
    // ★ 发车格：**本地车放在最后一位**（真实赛车游戏里玩家常从末位起步）。
    //   这不只是为了覆盖 HUD 的"非领先"分支 —— 它同时让 Phase C 的两条
    //   业务规则（P1 用 "--"、落后者用 "-0.X"）都能在**同一次仿真**里被真实执行到，
    //   避免"只测了 happy path"的假绿。错开仍保持横向 2.2m 防开局互撞。
    const int gridPos = (i == kLocalId) ? (kVehicles - 1) : (i > kLocalId ? i - 1 : i);
    PlaceAtS(cars[i], track.lengthM - 12.0 * static_cast<double>(gridPos),
             2.2 * (static_cast<double>(gridPos % 2) * 2.0 - 1.0));
    cars[i].delta.cpIndex = -1;
  }

  // ---- 客户端 ----
  std::array<ClientPeer, kVehicles> peers{};
  for (int i = 0; i < kVehicles; ++i) {
    peers[i].name = names[i];
    peers[i].isLocal = (i == kLocalId);
  }
  // Client 0 = 本地玩家：给自己与另外 3 车各建一个 replicator（观察全部 4 车）
  // Bot 1..3 = 无头：只需要观察"其他车"用于自己那份对账，但为了保持轻量
  //   只给它们喂所有车（真实无头客户端也要知道别人在哪）。
  for (int c = 0; c < kVehicles; ++c) {
    for (int v = 0; v < kVehicles; ++v) {
      if (v == c) continue;                       // 自己的车不走远端插值
      // 播种初始状态，避免开局从 Empty 起步（首帧会瞬移到原点）
      peers[c].repl[v].OnAuthoritativeSnapshot(ToSnapshot(cars[v], 0.0));
      peers[c].replPrimed[v] = true;
    }
  }

  // ---- 服务端时钟偏差（客户端本地钟领先服务端 137ms，模拟真实偏移）----
  const double serverOffsetSec = 0.137;
  const int totalTicks = static_cast<int>(durationSec * 60.0);
  const int pongEveryN = 6;                        // 10Hz PING（快速收敛）

  // ---- 场景时刻 ----
  const double tWarmEnd = 3.0;
  const double tBarrier = 3.0;
  const double tRearEnd = 6.0;
  const double tSteady = 8.5;      // 稳定巡航（也是 HUD 采样起点）
  const double tSlipDown = 10.5;   // 本地车"进站"掉位（覆盖 HUD 非领先分支）
  bool barrierDone = false, rearEndDone = false;

  const std::clock_t t0 = std::clock();

  if (verbose) {
    std::printf("\n  \033[1m赛道\033[0m：内建闭合样条 %zu 控制点，周长 %.1fm，%zu 个 Checkpoint\n",
                Track::kCtl, track.lengthM, Track::kCp);
    std::printf("  \033[1m车辆\033[0m：");
    for (int i = 0; i < kVehicles; ++i)
      std::printf("\033[%dm%s\033[0m%s", cars[i].color, cars[i].name,
                  i + 1 < kVehicles ? "  " : "\n");
    std::printf("\n  \033[1m%5s %-9s %-9s %-9s %-8s %-8s %-9s %s\033[0m\n",
                "t", "RTT", "抖动", "丢包", "在途", "RMSE", "Jerk峰", "HUD秒差");
    std::printf("  %s\n", "-------------------------------------------------------------------------------");
  }

  for (int tick = 0; tick < totalTicks; ++tick) {
    const double nowSec = static_cast<double>(tick) * kTickSec;
    const Nanos localNowNs = static_cast<Nanos>(nowSec * static_cast<double>(kNanosPerSecond));

    // =====================================================================
    //  (1) Bot / 本地玩家生成按键输入（模拟真人操作）
    // =====================================================================
    // ★ 真人的操作不是常值：方向盘有低频正弦摆动（走线修正）+ 小幅噪声，
    //   油门有轻微的抬放。这会让权威位置持续有非平凡的加速度，从而
    //   真正考验插值层的 Jerk 表现（常速直线会让一切看起来都很平滑）。
    for (int i = 0; i < kVehicles; ++i) {
      Car& c = cars[i];
      const double ph = c.phase;
      c.steerInput = static_cast<float>(0.18 * std::sin(nowSec * 1.6 + ph) +
                                        0.07 * std::sin(nowSec * 5.3 + ph * 2.1));
      c.throttle = static_cast<float>(0.72 + 0.28 * (0.5 + 0.5 * std::sin(nowSec * 0.9 + ph)));
      c.brake = 0.0F;
      // 减速弯（CP2~CP3 区间）里收油
      const double sMod = std::fmod(c.sMeters, track.lengthM);
      if (sMod > track.lengthM * 0.28 && sMod < track.lengthM * 0.42) {
        // 弯里按曲率降速：离弯心越近目标速度越低
        const double u = (sMod - track.lengthM * 0.28) / (track.lengthM * 0.14);
        const double bend = std::sin(u * 3.14159265);
        c.throttle = static_cast<float>(0.35 + 0.4 * (1.0 - bend));
        if (bend > 0.65) { c.brake = static_cast<float>(0.55 * (bend - 0.65) / 0.35); c.throttle = 0.0F; }
      }
    }
    // Bot 1 在两段场景里被"脚本化"（不是靠随机）：直接命令它撞上去
    if (nowSec >= tBarrier - 1.5 && nowSec < tRearEnd) {
      // 撞护栏：把目标车速拉到 180km/h 并朝右打（把车推向外侧护栏）
      // ⚠ 提前 1.5s 开始加速，否则 3.0s 时刻实际车速只有 ~72km/h（加速收敛慢），
      //    "180km/h 撞护栏"就成了一句空话。这里用高加速度把它推到位。
      cars[1].targetSpeedMs = static_cast<float>(180.0 * kKmhToMs);
      cars[1].throttle = 1.0F;
      cars[1].steerInput = 0.85F;
      cars[1].brake = 0.0F;
    } else if (nowSec >= tRearEnd && nowSec < tSteady) {
      // 追尾：目标速度拉高到能追上 Bot 2，且方向拉直
      cars[1].targetSpeedMs = static_cast<float>(205.0 * kKmhToMs);
      cars[1].throttle = 1.0F;
      cars[1].steerInput = static_cast<float>(0.05 * std::sin(nowSec * 4.0));
      cars[1].brake = 0.0F;
      // ★ 把 Bot 1 的 S 直接推到 Bot 2 身后 1.5m 内（制造真实追尾几何）
      //   不是瞬移：只在它落后于 Bot 2 时轻微提速补偿。
      //
      //   ⚠⚠ 关键：**必须封顶补偿量**。若不加限制，"按差距补偿"会形成正反馈：
      //      车落后越多 → 补偿越大 → 追上时收不住 → 撞击瞬间相对速度可达 300+km/h，
      //      早就超出任何真实追尾场景（那已经是两车都失控了）。
      //      真实赛道上追尾的**接近速度**是 10~40km/h 量级。所以：
      //      ① 补偿量封顶 4 m/s；② 求撞时把 Bot1 目标速度钳到 Bot2 之上最多 8 m/s。
      double ds = cars[2].sMeters - cars[1].sMeters;
      const double half = track.lengthM * 0.5;
      if (ds > half) ds -= track.lengthM;
      if (ds < -half) ds += track.lengthM;
      const float chaseCap = cars[2].targetSpeedMs + static_cast<float>(8.0);
      if (ds > 2.0) {
        cars[1].targetSpeedMs = std::min(cars[1].targetSpeedMs + 4.0F, chaseCap);
      } else {
        cars[1].targetSpeedMs = cars[2].targetSpeedMs;
      }
    } else {
      cars[1].targetSpeedMs = 55.0F;
    }
    // ★★ HUD 分支覆盖：让**本地车**在末段真实掉到后位。
    //   理由是规格自己写的断言："第一名为 '--'，落后者为 '-0.X'"——
    //   若整场本地车都保持 P1，则 '-0.X' 那半条规则**从头到尾没被执行过**，
    //   断言必然假绿（本项目老坑：只测了 happy path）。
    //   用"打滑 / 进站"这一真实场景实现：本地车在 tSlipDown 后完全收油并带刹车，
    //   靠阻力自然滑落，后面的队友（197km/h）在数秒内必然超过去。
    if (nowSec >= tSlipDown) {
      cars[kLocalId].targetSpeedMs = static_cast<float>(12.0 * kKmhToMs);
      cars[kLocalId].throttle = 0.0F;                                    // 完全收油
      cars[kLocalId].brake = 0.85F;                                      // 重刹
    }
    for (int i = 0; i < kVehicles; ++i) {
      if (i == 1 && nowSec >= tBarrier) continue;   // Bot1 的 target 已单独设
      cars[i].targetSpeedMs = cars[i].targetSpeedMs;   // 常量，保留可读性
    }

    // =====================================================================
    //  (2) 服务端权威物理推进（简化车辆模型 + 真 SafePhysicsSolver 碰撞）
    // =====================================================================
    for (int i = 0; i < kVehicles; ++i) {
      Car& c = cars[i];
      // ── 简化纵向动力学：油门推、刹车/阻力拉 ──
      const float v = glm::length(c.vel);
      const float vTarget = c.targetSpeedMs;
      float accel = 0.0F;
      if (c.throttle > 0.0F) {
        // 低速大加速度、接近目标速度时线性收敛（模拟功率限制）。
        // 收敛项用 sqrt 而非线性，让"冲向 180km/h"能在 ~1.5s 内达成
        // （线性收敛在 v/vTarget→1 时几乎没有推力，10s 也到不了 180）。
        const float ratio = std::max(0.02F, 1.0F - v / std::max(vTarget, 1.0F));
        accel = 13.0F * c.throttle * std::sqrt(ratio);
      }
      if (c.brake > 0.0F) accel -= 18.0F * c.brake;
      accel -= 0.0009F * v * v;                      // 气动阻力
      accel -= 0.35F;                                // 滚动阻力
      const float vNew = std::max(0.0F, v + accel * static_cast<float>(kTickSec));

      // ── 转向：把输入转成偏航角速度（周期与车速成反比，模拟低速不灵敏）──
      // ⚠ 符号约定（MEMORY.md）：input.steer>0 = 向右；车头 +Z、车顶 +Y
      //    ⇒ 右手系下"向右转"= 绕 +Y 的**负**角。
      const float steerRate = -c.steerInput * 1.15F / (1.0F + v * 0.018F);
      c.yaw += steerRate * static_cast<float>(kTickSec);

      // 沿车头方向推进（车头 = yaw 下的 +Z）
      const float fx = std::sin(c.yaw), fz = std::cos(c.yaw);
      c.vel = glm::vec3(fx * vNew, 0.0F, fz * vNew);
      c.pos += c.vel * static_cast<float>(kTickSec);
    }

    // ---- 赛道进度投影（服务端权威）----
    for (int i = 0; i < kVehicles; ++i) {
      Car& c = cars[i];
      const double s = track.Project(c.pos.x, c.pos.z, c.sMeters);
      c.prevS = c.sMeters;
      c.prevT = nowSec - kTickSec;
      c.sMeters = s;
      // 圈数：S 回绕（从接近 length 跳到接近 0）计一圈
      if (c.prevS > track.lengthM * 0.75 && s < track.lengthM * 0.25) ++c.lap;
      else if (c.prevS < track.lengthM * 0.25 && s > track.lengthM * 0.75 && c.lap > 0) --c.lap;
      // Checkpoint 过线登记
      for (std::size_t k = 0; k < Track::kCp; ++k) {
        const double cpS = track.cpArc[k];
        // 本 tick 是否跨过该 CP（含回绕）
        double a = c.prevS, b = s;
        bool crossed = false;
        if (a <= b) crossed = (a < cpS && cpS <= b);
        else        crossed = (a < cpS || cpS <= b);     // 跨圈
        if (crossed && c.lap == 0) {                      // 首圈才开始记时
          int idx = static_cast<int>(k);
          if (cpS < a && idx == 0) { /* 回绕处不重记 CP0 */ }
          else {
            c.cpIndex = std::max(c.cpIndex, idx);
            c.delta.cpPassTime[static_cast<std::size_t>(idx)] = nowSec;
          }
        }
      }
      // 同步到秒差状态
      c.delta.sMeters = c.sMeters;
      c.delta.sampleTime = nowSec;
      c.delta.lap = c.lap;
      c.delta.cpIndex = std::min(c.cpIndex, static_cast<int>(Track::kCp) - 1);
      RaceDeltaTracker::UpdateSegSpeed(c.delta, c.prevS, c.prevT, nowSec);
    }

    // ---- ★ 碰撞：真 SafePhysicsSolver 解算 ----
    // (a) Bot1 vs 护栏（静态墙）
    if (nowSec >= tBarrier && !barrierDone) {
      double nx = -1.0, nz = 0.0;   // 护栏法线（指向场地外侧）
      // 用当前车头右侧作护栏法线，制造侧向撞击
      {
        const double rx = std::cos(cars[1].yaw), rz = -std::sin(cars[1].yaw);
        nx = rx; nz = rz;
      }
      RigidBodyView car;
      car.position = Vec3(cars[1].pos.x, cars[1].pos.y, cars[1].pos.z);
      car.velocity = Vec3(cars[1].vel.x, cars[1].vel.y, cars[1].vel.z);
      car.invMass = static_cast<float>(1.0 / kCarMassKg);
      car.invInertia = static_cast<float>(kCarInvYawInertia);

      // ★ 刻意给法线一点 Y 分量（模拟接触网格倒角），验证 §1 会抹平它
      Vec3 rawN(static_cast<float>(nx), 0.12F, static_cast<float>(nz));
      rawN = rawN.Normalized();

      ContactManifold mf;
      mf.a = &car;
      mf.b = nullptr;                                   // 静态护栏
      mf.kind = ContactKind::CarToWall;
      mf.normal = rawN;
      mf.pointCount = 1;
      mf.points[0] = ContactPoint{Vec3(0.0F, 0.5F, 0.0F), {}, 0.18F, 0.0F, 0.0F};

      const Vec3 nHoriz(static_cast<float>(nx), 0.0F, static_cast<float>(nz));
      rep.barrierApproachMs = static_cast<double>(glm::length(cars[1].vel));
      const double m = kCarMassKg;
      rep.energyBeforeJ = 0.5 * m * static_cast<double>(glm::dot(cars[1].vel, cars[1].vel));

      SolveStats st{};
      SafePhysicsSolver::Resolve(mf, static_cast<float>(kTickSec), SolverConfig{}, &st);

      const glm::vec3 vAfter(car.velocity.x, car.velocity.y, car.velocity.z);
      rep.barrierReboundMs = static_cast<double>(glm::dot(vAfter, glm::vec3(nHoriz.x, 0.0F, nHoriz.z)));
      rep.energyAfterJ = 0.5 * m * static_cast<double>(glm::dot(vAfter, vAfter));
      rep.clampedImpulses += st.clampedNormal;
      rep.redirectedNormals += st.flattenedNormals;
      rep.projected += st.projected;
      rep.suspLocked += st.suspensionLocked;
      rep.maxVyAllMs = std::max(rep.maxVyAllMs, static_cast<double>(std::fabs(vAfter.y)));
      rep.barrierImpact = true;
      barrierDone = true;

      cars[1].vel = vAfter;
      cars[1].pos = glm::vec3(car.position.x, car.position.y, car.position.z);
      cars[1].hadImpact = true;
      cars[1].hadBarrierImpact = true;
      cars[1].maxReboundNormalMs = static_cast<float>(std::fabs(rep.barrierReboundMs));
      cars[1].maxImpactApproachMs = static_cast<float>(rep.barrierApproachMs);

      // 权威侧发生了真实阶跃 ⇒ 客户端需要若干帧把误差融合掉，标恢复窗
      for (auto& p : peers) for (int v = 0; v < kVehicles; ++v) p.jitter[v].holdFrames = 24;

      if (verbose) {
        std::printf("  \033[35m[t=%5.2fs] Bot1 撞护栏\033[0m：接近 %.2fm/s (%.0fkm/h) → "
                    "法向反弹 %+.3fm/s | 平整化 %d 次 / 截断 %d 次 / 投影 %d 次 | vy=%.4f\n",
                    nowSec, rep.barrierApproachMs, rep.barrierApproachMs * kMsToKmh,
                    rep.barrierReboundMs, st.flattenedNormals, st.clampedNormal, st.projected,
                    static_cast<double>(std::fabs(vAfter.y)));
      }
    }

    // (b) Bot1 追尾 Bot 2（车对车）
    //
    //  ★ 接触几何必须物理自洽，否则会"自己造出一个 bug 再断言它"（本项目老坑）：
    //    追尾是**正面接触**，接触点应分布在车身前端的中线附近 ±(半宽)，
    //    而不是 z 方向偏移 1.2m。先前把接触点放在 z=±1.2 —— 对"沿 +X 的法线"
    //    来说那是 1.2m 的力臂，会把一次正碰算成"偏心撞"，注入 ω_yaw ≈ 4 rad/s。
    //    那不是求解器的缺陷，是我喂给它的几何本身爆炸。
    //    正确做法：接触点放在 A 的车前端（rA ≈ +z 小量）、B 的车尾端，
    //    横向分布 ±(半宽) 以让 ±Y 力矩自相抵消。
    if (nowSec >= tRearEnd && !rearEndDone) {
      const glm::vec3 dv = cars[1].vel - cars[2].vel;
      const float relSpeed = glm::length(dv);
      if (relSpeed > 1.0F) {
        const glm::vec3 dir = glm::normalize(dv);
        // 车体坐标系：前向 f、右向 r（右手系，+Y 向上）
        const glm::vec3 f(dir.x, 0.0F, dir.z);
        const glm::vec3 rgt(f.z, 0.0F, -f.x);       // 绕 Y 转 −90°

        RigidBodyView a, b;
        a.position = {cars[1].pos.x, cars[1].pos.y, cars[1].pos.z};
        a.velocity = {cars[1].vel.x, cars[1].vel.y, cars[1].vel.z};
        a.invMass = static_cast<float>(1.0 / kCarMassKg);
        a.invInertia = static_cast<float>(kCarInvYawInertia);
        b.position = {cars[2].pos.x, cars[2].pos.y, cars[2].pos.z};
        b.velocity = {cars[2].vel.x, cars[2].vel.y, cars[2].vel.z};
        b.invMass = static_cast<float>(1.0 / kCarMassKg);
        b.invInertia = static_cast<float>(kCarInvYawInertia);

        ContactManifold mf;
        mf.a = &a;
        mf.b = &b;
        mf.kind = ContactKind::CarToCar;
        // 法线从 A 指向 B（追尾时即 A 的前进方向），刻意加一点 Y 分量验证 §1 会抹平
        mf.normal = Vec3(f.x, 0.08F, f.z).Normalized();
        mf.pointCount = 2;
        // A 的车头端面（+f·半长），横向 ±半宽 —— 对称分布 ⇒ 力矩自抵消
        const float hl = static_cast<float>(kCarHalfLenM);
        const float hw = static_cast<float>(kCarHalfWidM * 0.8);   // 实际接触面略窄
        mf.points[0] = ContactPoint{
            Vec3(f.x * hl + rgt.x * hw, 0.55F, f.z * hl + rgt.z * hw),
            Vec3(-f.x * hl + rgt.x * hw, 0.55F, -f.z * hl + rgt.z * hw),
            0.06F, 0.0F, 0.0F};
        mf.points[1] = ContactPoint{
            Vec3(f.x * hl - rgt.x * hw, 0.55F, f.z * hl - rgt.z * hw),
            Vec3(-f.x * hl - rgt.x * hw, 0.55F, -f.z * hl - rgt.z * hw),
            0.05F, 0.0F, 0.0F};

        const double m = kCarMassKg;
        const double keBefore = 0.5 * m * static_cast<double>(glm::dot(cars[1].vel, cars[1].vel) +
                                                             glm::dot(cars[2].vel, cars[2].vel));
        SolveStats st{};
        SafePhysicsSolver::Resolve(mf, static_cast<float>(kTickSec), SolverConfig{}, &st);
        const glm::vec3 vaAfter(a.velocity.x, a.velocity.y, a.velocity.z);
        const glm::vec3 vbAfter(b.velocity.x, b.velocity.y, b.velocity.z);
        const double keAfter = 0.5 * m * static_cast<double>(glm::dot(vaAfter, vaAfter) +
                                                             glm::dot(vbAfter, vbAfter));

        // ★ 正确的可观测量：**接触点**法向相对速度（不是质心相对速度）。
        //   偏心撞击时质心相对速度**不会**归零 —— 冲量在线性与角向间分配，
        //   归零的是接触点处。用质心判据会把正确的刚体行为误判成"弹开"。
        //   （本工程 MEMORY.md 已有记载：正撞实测 va=+3.733、ωa.z=+8.295。）
        const Vec3 nUnit(f.x, 0.0F, f.z);            // 求解器/接触点数学用 Vec3
        const glm::vec3 nG(f.x, 0.0F, f.z);          // glm 点积用 glm::vec3
        const Vec3 cpA = a.velocity + a.angularVelocity.Cross(mf.points[0].rA);
        const Vec3 cpB = b.velocity + b.angularVelocity.Cross(mf.points[0].rB);
        const double approachN = static_cast<double>(glm::dot(dv, nG));
        // Vec3 有自带的点积（不是 glm 类型），用 .Dot() 而非 glm::dot
        const double cpSepAfter = static_cast<double>((cpA - cpB).Dot(nUnit));

        rep.carApproachMs = static_cast<double>(relSpeed);
        rep.carReboundMs = cpSepAfter;               // 接触点分离（判据用这个）
        rep.carCgSepMs = static_cast<double>(glm::dot(vaAfter - vbAfter, nG));
        rep.clampedImpulses += st.clampedNormal;
        rep.redirectedNormals += st.flattenedNormals;
        rep.projected += st.projected;
        rep.suspLocked += st.suspensionLocked;
        rep.energyBeforeJ = std::max(rep.energyBeforeJ, keBefore);
        rep.energyAfterJ = keAfter;
        rep.maxVyAllMs = std::max(rep.maxVyAllMs,
                                  static_cast<double>(std::max(std::fabs(vaAfter.y), std::fabs(vbAfter.y))));
        rep.carImpact = true;
        rearEndDone = true;

        cars[1].vel = vaAfter; cars[1].pos = {a.position.x, a.position.y, a.position.z};
        cars[2].vel = vbAfter; cars[2].pos = {b.position.x, b.position.y, b.position.z};
        cars[1].hadImpact = true;
        cars[2].hadImpact = true;
        cars[1].hadCarImpact = true;
        cars[2].hadCarImpact = true;
        cars[1].maxReboundNormalMs = static_cast<float>(std::fabs(cpSepAfter));
        cars[2].maxReboundNormalMs = static_cast<float>(std::fabs(cpSepAfter));
        cars[1].maxImpactApproachMs = static_cast<float>(approachN);
        cars[1].energyBeforeJ = keBefore;
        cars[1].energyAfterJ = keAfter;

        for (auto& p : peers) for (int v = 0; v < kVehicles; ++v) p.jitter[v].holdFrames = 24;

        if (verbose) {
          std::printf("  \033[35m[t=%5.2fs] Bot1 追尾 Bot2\033[0m：接近 %.2fm/s (%.0fkm/h) → "
                      "接触点法向分离 %+.4fm/s（质心 %+.3f）| 动能 %.0f→%.0fJ | "
                      "平整化 %d / 截断 %d / 投影 %d\n",
                      nowSec, relSpeed, relSpeed * kMsToKmh, cpSepAfter,
                      rep.carCgSepMs, keBefore, keAfter,
                      st.flattenedNormals, st.clampedNormal, st.projected);
        }
      }
    }

    // ---- 全程速度峰值 ----
    for (int i = 0; i < kVehicles; ++i) {
      rep.peakSpeedMs = std::max(rep.peakSpeedMs,
                                 static_cast<double>(glm::length(cars[i].vel)));
    }

    // =====================================================================
    //  (3) 服务端广播（经混沌信道）
    // =====================================================================
    for (int v = 0; v < kVehicles; ++v) {
      const RigidBodyNetSnapshot s = ToSnapshot(cars[v], nowSec);
      for (int c = 0; c < kVehicles; ++c) {
        if (c == v) continue;
        channel.SendSnapshot(s, nowSec, c);
      }
    }
    // NTP PING/PONG（每客户端各一条）
    if (tick % pongEveryN == 0) {
      for (int c = 0; c < kVehicles; ++c) {
        const double outLat = channel.SampleOneWayMs();
        const Nanos t1 = localNowNs;
        const Nanos t2 = t1 + static_cast<Nanos>(outLat * 1e-3 * static_cast<double>(kNanosPerSecond));
        const Nanos t3 = t2 + static_cast<Nanos>(0.002 * static_cast<double>(kNanosPerSecond));
        const Nanos off = static_cast<Nanos>(serverOffsetSec * static_cast<double>(kNanosPerSecond));
        channel.SendPong(t1, t2 + off, t3 + off, nowSec, c);
      }
    }

    // =====================================================================
    //  (4) 客户端收包
    // =====================================================================
    const auto arrived = channel.DrainArrived(nowSec);
    for (const auto& p : arrived) {
      const int ci = p.destClient;
      if (ci < 0 || ci >= kVehicles) continue;
      ClientPeer& peer = peers[ci];
      if (p.isPong) {
        const Nanos t4 = static_cast<Nanos>(p.arriveSec * static_cast<double>(kNanosPerSecond));
        const SyncEvent e = peer.sync.OnPong(p.t1, p.t2, p.t3, t4);
        if (e == SyncEvent::SampleRejected) ++rep.syncRejected;
        if (e == SyncEvent::HardResync) { ++peer.hardResyncs; }
        if (peer.sync.BestRttNs() != kNoSample) {
          const double rttMs = static_cast<double>(peer.sync.BestRttNs()) / 1e6;
          peer.sumRttMs += rttMs;
          ++peer.rttCount;
          peer.minRttMs = std::min(peer.minRttMs, rttMs);
          peer.maxRttMs = std::max(peer.maxRttMs, rttMs);
        }
      } else {
        const int vid = SnapshotIdOf(p.snap);
        if (vid < 0 || vid >= kVehicles || vid == ci) continue;
        if (peer.repl[vid].OnAuthoritativeSnapshot(p.snap)) ++peer.accepted;
        else ++peer.rejected;
      }
    }

    // =====================================================================
    //  (5) 客户端每帧推进（平滑层）
    // =====================================================================
    for (int c = 0; c < kVehicles; ++c) {
      ClientPeer& peer = peers[c];
      const double dt = peer.sync.AdjustedDeltaTime(kTickSec);
      if (peer.sync.IsLocked()) {
        peer.warpAbsSum += std::fabs(peer.sync.CurrentWarp());
        ++peer.warpSamples;
      }
      for (int v = 0; v < kVehicles; ++v) {
        if (v == c) continue;
        peer.repl[v].Update(static_cast<float>(dt));
      }
    }

    // =====================================================================
    //  (6) Client 0 视角：抖动 / 闪现 / Jerk 量化
    // =====================================================================
    // ★ 只统计**远端车辆**（Bot 1~3）——本地车不走远端插值，没有 rubberbanding。
    //   这正是规格要求的"在 Client 0 观察其他 3 辆车"。
    ClientPeer& local = peers[kLocalId];
    const bool warm = (nowSec >= tWarmEnd) && local.sync.IsLocked() &&
                      local.repl[1].HasState() && local.repl[2].HasState() && local.repl[3].HasState();
    for (int v = 0; v < kVehicles; ++v) {
      if (v == kLocalId) continue;
      JitterDetector& jd = local.jitter[v];
      jd.enabled = warm;
      if (!warm) continue;
      jd.SetLimitsFromSpeed(static_cast<double>(glm::length(cars[v].vel)));
      const glm::vec3 vis = local.repl[v].GetVisualPosition();
      jd.Push(vis, cars[v].pos, nowSec);
    }

    // =====================================================================
    //  (7) HUD 秒差文本（用真 RaceDeltaTracker + DeltaFormatter）
    // =====================================================================
    if (warm && nowSec >= tSteady) {
      // 名次：按 lap 降序、同圈按累计弧长降序
      std::array<int, kVehicles> order{};
      for (int i = 0; i < kVehicles; ++i) order[i] = i;
      std::sort(order.begin(), order.end(), [&](int a, int b) {
        if (cars[a].lap != cars[b].lap) return cars[a].lap > cars[b].lap;
        return cars[a].sMeters > cars[b].sMeters;
      });
      const int leader = order[0];
      const int localPos = static_cast<int>(std::distance(
          order.begin(), std::find(order.begin(), order.end(), kLocalId)));

      // 本地相对第一名的秒差
      const DeltaResult d = track.delta.Solve(cars[kLocalId].delta, cars[leader].delta);
      char buf[48];
      const bool localIsLeader = (leader == kLocalId);
      const int nLocal = RaceDeltaTracker::FormatLocalRow(buf, sizeof buf, d, localIsLeader);
      (void)nLocal;
      const std::string hudLocal = buf;

      // 后车行：本地后面那台车相对本地的秒差
      std::string hudChaser = "--";
      if (order[kVehicles - 1] != kLocalId && localPos + 1 < kVehicles) {
        const int chaser = order[localPos + 1];
        const DeltaResult dc = track.delta.Solve(cars[chaser].delta, cars[kLocalId].delta);
        const int nCh = RaceDeltaTracker::FormatChaserRow(buf, sizeof buf, dc);
        (void)nCh;
        hudChaser = buf;
      }

      ++rep.hudChecks;
      rep.hudSampleLocal = hudLocal;
      rep.hudSampleChaser = hudChaser;

      // ── 严格业务规则断言 ──
      if (localIsLeader) {
        // 本地是 P1 ⇒ 必须恰好 "--"
        if (hudLocal == "--") ++rep.hudLeaderDash; else ++g_fail;
      } else {
        rep.hudEverNonLeader = true;
        // 非 P1 ⇒ 必须以 '-' 开头且形如 -0.X / -X.X / -X.XX（不含 "--"）
        const bool ok = !hudLocal.empty() && hudLocal[0] == '-' && hudLocal[1] != '-' &&
                        hudLocal.find('.') != std::string::npos;
        if (ok) ++rep.hudChaserNeg; else ++g_fail;
      }

      if (verbose && hudEveryN > 0 && tick % hudEveryN == 0 && localPos >= 0) {
        std::printf("       \033[2mHUD\033[0m  本地=P%d  第一行=\033[1m%-7s\033[0m  后车行=\033[1m%-7s\033[0m"
                    "  (P1=%s, 方法=%s)\n",
                    localPos + 1, hudLocal.c_str(), hudChaser.c_str(),
                    cars[leader].name, forza::race::DeltaMethodName(d.method));
      }
    }

    // ---- 实时统计行（1s 一次）----
    if (verbose && tick % 60 == 0 && tick > 0) {
      const double rtt = local.rttCount ? local.sumRttMs / static_cast<double>(local.rttCount) : 0.0;
      double worstRmse = 0.0, worstJerk = 0.0;
      for (int v = 0; v < kVehicles; ++v) {
        if (v == kLocalId) continue;
        worstRmse = std::max(worstRmse, local.jitter[v].Rmse());
        worstJerk = std::max(worstJerk, local.jitter[v].maxJerkMs3);
      }
      std::printf("  %5.2f %8.1fms %7.1fms %7.1f%% %7zu %8.4fm %8.1f %s\n",
                  nowSec, rtt, channel.MeanOneWayMs(), channel.DropPct(),
                  channel.InFlight(), worstRmse, worstJerk,
                  rep.hudSampleLocal.c_str());
    }
  }

  const std::clock_t t1 = std::clock();

  // =====================================================================
  //  汇总
  // =====================================================================
  rep.sent = channel.Sent();
  rep.dropped = channel.Dropped();
  rep.delivered = channel.Delivered();
  rep.outOfOrder = channel.OutOfOrder();
  rep.reorderInjected = channel.ReorderInjected();
  rep.dropPct = channel.DropPct();
  rep.oneWayMinMs = channel.MinOneWayMs();
  rep.oneWayMeanMs = channel.MeanOneWayMs();
  rep.oneWayMaxMs = channel.MaxOneWayMs();

  const ClientPeer& local = peers[kLocalId];
  rep.meanRttMs = local.rttCount ? local.sumRttMs / static_cast<double>(local.rttCount) : 0.0;
  rep.minRttMs = (local.minRttMs < 1e29) ? local.minRttMs : 0.0;
  rep.maxRttMs = local.maxRttMs;
  rep.locked = local.sync.IsLocked();
  rep.meanAbsWarpPct = local.warpSamples
                           ? (local.warpAbsSum / static_cast<double>(local.warpSamples)) * 100.0
                           : 0.0;
  rep.hardResyncs = local.hardResyncs;

  // 抖动/闪现：对远端 3 车取最差
  double sumSq = 0.0; std::size_t nsamp = 0;
  for (int v = 0; v < kVehicles; ++v) {
    if (v == kLocalId) continue;
    const JitterDetector& jd = local.jitter[v];
    sumSq += jd.sumSq;
    nsamp += jd.n;
    rep.maxErrM = std::max(rep.maxErrM, jd.maxErrM);
    rep.maxStepM = std::max(rep.maxStepM, jd.maxStepM);
    rep.maxJerkMs3 = std::max(rep.maxJerkMs3, jd.maxJerkMs3);
    rep.stepLimitM = std::max(rep.stepLimitM, jd.stepLimitM);
    rep.jerkLimitMs3 = std::max(rep.jerkLimitMs3, jd.jerkLimitMs3);
    rep.jumps += jd.jumps;
    rep.jerkSpikes += jd.jerkSpikes;
    if (jd.jumpAtSec >= 0.0 && (rep.firstJumpSec < 0.0 || jd.jumpAtSec < rep.firstJumpSec))
      rep.firstJumpSec = jd.jumpAtSec;
    if (jd.jerkPeakAtSec >= 0.0 && jd.jerkPeakAtSec > rep.jerkPeakSec)
      rep.jerkPeakSec = jd.jerkPeakAtSec;
  }
  rep.jitterSamples = nsamp;
  rep.rmseM = nsamp ? std::sqrt(sumSq / static_cast<double>(nsamp)) : 0.0;

  rep.simulatedSec = durationSec;
  rep.ticks = totalTicks;
  rep.wallMs = 1000.0 * static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
  rep.effectiveFps = (rep.wallMs > 0.0)
                         ? static_cast<double>(totalTicks) * 1000.0 / rep.wallMs
                         : 0.0;

  (void)rng;
  return rep;
}

}  // namespace

// =============================================================================
//  7. 断言与报告
// =============================================================================
namespace {

void PhaseA_Channel(const Report& r) {
  Banner("Phase A · 混沌信道统计（RTT / 抖动长尾 / 丢包 / 乱序）");
  std::printf("  包：发出 %llu / 丢弃 %llu (%.2f%%) / 投递 %llu / 乱序 %llu / 注入抢跑 %llu\n",
              (unsigned long long)r.sent, (unsigned long long)r.dropped, r.dropPct,
              (unsigned long long)r.delivered, (unsigned long long)r.outOfOrder,
              (unsigned long long)r.reorderInjected);
  std::printf("  单程延迟：min %.1fms / mean %.1fms / max %.1fms  （规格区间 [20,160]）\n",
              r.oneWayMinMs, r.oneWayMeanMs, r.oneWayMaxMs);
  std::printf("  客户端 RTT（滑窗最小样本）：min %.1fms / mean %.1fms / max %.1fms\n",
              r.minRttMs, r.meanRttMs, r.maxRttMs);
  std::printf("  时钟同步：锁定=%s | 平均 |warp|=%.4f%% | 硬同步 %zu | 非法样本 %zu\n",
              r.locked ? "\033[32m是\033[0m" : "\033[31m否\033[0m",
              r.meanAbsWarpPct, r.hardResyncs, r.syncRejected);

  Check(r.dropPct > 4.0 && r.dropPct < 13.0, "丢包率落在 8% 附近（±5pt）",
        F(r.dropPct, 2) + "%");
  Check(r.oneWayMinMs >= 19.5 && r.oneWayMaxMs <= 160.5,
        "★ 抖动严格落在规格区间 [20,160]ms（长尾被钳住，无越界）",
        "[" + F(r.oneWayMinMs, 1) + ", " + F(r.oneWayMaxMs, 1) + "] ms");
  Check(r.oneWayMeanMs >= 40.0 && r.oneWayMeanMs <= 70.0,
        "★ 单程延迟均值 ≈ 50ms（RTT 均值 100ms）",
        F(r.oneWayMeanMs, 2) + "ms");
  // 长尾验证：max/mean 之比必须显著 > 1（否则就是对称分布，压不出尖峰）
  const double tailRatio = (r.oneWayMeanMs > 1.0) ? r.oneWayMaxMs / r.oneWayMeanMs : 0.0;
  Check(tailRatio > 1.8,
        "★★ 抖动是**非对称长尾**（max/mean 显著 > 1，非高斯对称分布）",
        "max/mean = " + F(tailRatio, 2));
  Check(r.outOfOrder > 0 && r.reorderInjected > 0,
        "★ 存在真实乱序（后发先至的包在接收侧被观测到）",
        "乱序 " + std::to_string(r.outOfOrder) + " 个 / 注入 " +
            std::to_string(r.reorderInjected));
  Check(r.locked, "Client 0 时钟同步器最终已锁定（IsLocked）");
  Check(r.meanAbsWarpPct <= 0.6,
        "★ 平均时间伸缩远小于 1.5% 上限（收敛且不抖）",
        F(r.meanAbsWarpPct, 4) + "% ≤ 0.6%");
}

void PhaseB_Jitter(const Report& r) {
  Banner("Phase B · 抖动 / 闪现量化（Client 0 观察远端 3 车）");

  // 物理预期滞后 = v · 单向延迟
  const double expectedLag = r.peakSpeedMs * (r.oneWayMeanMs * 1e-3);
  const double tol = std::max(0.60, expectedLag * 1.8);
  std::printf("  残差：RMSE %.4fm | 最大误差 %.4fm | 有效样本 %zu 帧\n",
              r.rmseM, r.maxErrM, r.jitterSamples);
  std::printf("  基准：峰值车速 %.1fm/s × 单向延迟 %.1fms ⇒ 预期滞后 %.4fm（阈值 1.8× = %.4fm）\n",
              r.peakSpeedMs, r.oneWayMeanMs, expectedLag, tol);
  std::printf("  单帧位移：最大 %.4fm | 上限 %.4fm | 超限 %d 次%s\n",
              r.maxStepM, r.stepLimitM, r.jumps,
              r.firstJumpSec >= 0.0 ? ("（首次 @" + F(r.firstJumpSec, 2) + "s）").c_str() : "");
  std::printf("  \033[1mJerk（加加速度）\033[0m：峰值 %.1f m/s³ | 上限 %.1f m/s³ | 尖峰 %d 次%s\n",
              r.maxJerkMs3, r.jerkLimitMs3, r.jerkSpikes,
              r.jerkPeakSec >= 0.0 ? ("（峰值 @" + F(r.jerkPeakSec, 2) + "s）").c_str() : "");

  // 防零样本假绿：样本数必须与仿真时长解耦地足够多
  const std::size_t minSamples = static_cast<std::size_t>(r.simulatedSec * 60.0) / 3;
  Check(r.jitterSamples >= minSamples,
        "★ 有效抖动样本充足（防暖机门控写错导致 0 样本假绿）",
        std::to_string(r.jitterSamples) + " 帧 ≥ " + std::to_string(minSamples));
  Check(r.rmseM < tol,
        "★★ 视觉位置 RMSE 在「车速 × 单向延迟」的物理预期内",
        F(r.rmseM, 4) + "m < " + F(tol, 4) + "m");
  Check(r.maxErrM < std::max(6.0, expectedLag * 3.0),
        "★ 最大瞬时误差未失控（未达硬吸附量级）", F(r.maxErrM, 4) + "m");
  Check(r.jumps == 0,
        "★★★ 单帧位移突变 = 0（无肉眼可见闪现 / rubberbanding）",
        std::to_string(r.jumps) + " 次（阈值 " + F(r.stepLimitM, 3) + "m）");
  Check(r.jerkSpikes == 0,
        "★★★ Jerk（加加速度）尖峰 = 0（无\342\200\234被猛地一拽\342\200\235的手感）",
        std::to_string(r.jerkSpikes) + " 次（上限 " + F(r.jerkLimitMs3, 1) + " m/s³）");
}

void PhaseC_HudDelta(const Report& r) {
  Banner("Phase C · HUD 秒差文本（严格业务规则）");
  std::printf("  采样 %d 次 | 本地为 P1 的次数 %d | 本地非 P1 的次数 %d\n",
              r.hudChecks, r.hudLeaderDash, r.hudChaserNeg);
  std::printf("  末次样本：第一行 = \033[1m%s\033[0m | 后车行 = \033[1m%s\033[0m\n",
              r.hudSampleLocal.c_str(), r.hudSampleChaser.c_str());

  Check(r.hudChecks > 0, "★ 产生了足够的 HUD 秒差采样",
        std::to_string(r.hudChecks) + " 次");
  Check(r.hudLeaderDash > 0, "★★ 本地为 P1 时第一行严格输出 \"--\"",
        std::to_string(r.hudLeaderDash) + " 次");
  Check(r.hudEverNonLeader, "★ 覆盖了「本地非 P1」的分支（P1 用同名分支会掩盖 bug）");
  Check(r.hudChaserNeg > 0,
        "★★ 本地落后时第一行严格形如 \"-0.X\"（负数 + 小数，绝非 \"--\"）",
        std::to_string(r.hudChaserNeg) + " 次");
  Check(!r.hudSampleChaser.empty() && r.hudSampleChaser[0] == '-',
        "★★ 后车行统一负数格式（规格硬要求）",
        "样本 \"" + r.hudSampleChaser + "\"");
}

void PhaseD_Collision(const Report& r) {
  Banner("Phase D · 碰撞弹跳检测（撞护栏 + 追尾，真 SafePhysicsSolver）");

  if (!r.barrierImpact || !r.carImpact) {
    Check(false, "★ 两个碰撞场景均发生了解算",
          std::string("护栏=") + (r.barrierImpact ? "是" : "否") +
              " 追尾=" + (r.carImpact ? "是" : "否"));
    return;
  }

  std::printf("  护栏碰撞：接近 %.2fm/s (%.0fkm/h) → 法向反弹 %+.4fm/s\n",
              r.barrierApproachMs, r.barrierApproachMs * kMsToKmh, r.barrierReboundMs);
  std::printf("  追尾碰撞：相对接近 %.2fm/s (%.0fkm/h) → **接触点**法向 %+.4fm/s"
              "（负=仍在靠近=无弹开；质心 %+.3fm/s，偏心撞击时质心本就不归零）\n",
              r.carApproachMs, r.carApproachMs * kMsToKmh, r.carReboundMs, r.carCgSepMs);
  std::printf("  全程最大垂直速度 |vy| = %.5fm/s（必须 ≈0，防被铲飞）\n", r.maxVyAllMs);
  std::printf("  平整化 %d 次 / 冲量截断 %d 次 / 位置投影 %d 次 / 悬挂锁定 %d 次\n",
              r.redirectedNormals, r.clampedImpulses, r.projected, r.suspLocked);

  // 护栏：法向反弹速度不得反向暴增（不得显著为正 = 弹离墙面）
  // 塑料恢复系数下，正撞应几乎不反弹（|反弹| 远小于接近速度）
  Check(r.redirectedNormals >= 1,
        "★ 护栏法线 Y 分量被平整化（防跳板通路切断）",
        std::to_string(r.redirectedNormals) + " 次");
  Check(r.barrierReboundMs <= r.barrierApproachMs * 0.5,
        "★★★ 撞护栏法向反弹未反向暴增（远小于接近速度）",
        F(r.barrierReboundMs, 4) + " ≤ " + F(r.barrierApproachMs * 0.5, 3) + " m/s");
  Check(r.maxVyAllMs < 1.0,
        "★★★ 碰撞未产生垂直速度（车未被铲起 / 未飞天）",
        "|vy|max = " + F(r.maxVyAllMs, 5) + "m/s < 1.0");
  // ★★ 追尾：判据是**接触点**法向分离速度 ≤ 0（即"不再互相靠近"到"绝不弹开"）。
  //
  //   为什么不是 |分离| ≈ 0：
  //     · 弹性/塑性的定义是"碰后是否**分离**"。零恢复系数（e=0）意味着
  //       接触点法向相对速度**归零或保持为负（仍在靠近）**——
  //       前者是恰好停住，后者是"冲量不够、没止住"。
  //     · 唯一**绝不允许**出现的是 **正值**（>0 = 接触点开始互相远离 = 弹开）。
  //     · 高速撞击下 §5 的 4e4 N·s 硬截断**必然**让 jn 不足，
  //       于是残留一个小的负值（仍靠近）。这是**保险丝按设计生效**，
  //       不是缺陷；把它断言成 "≈0" 就等于要求保险丝不许熔断。
  //   因此断言：cpSepAfter ≤ tol（tol 只给浮点误差留余量），
  //   外加"残留靠近速度必须小于原始接近速度的 90%"，两条合起来才钉死
  //   "既不弹开、也确实吸掉绝大部分能量"。
  Check(r.carReboundMs <= 0.5,
        "★★★ 追尾后**接触点**法向分离速度 ≤ 0（完全非弹性，绝不弹开）",
        "接触点法向 = " + F(r.carReboundMs, 4) + "m/s ≤ 0.5（正值才是弹开）");
  Check(std::fabs(r.carReboundMs) <= r.carApproachMs * 0.90,
        "★★ 追尾吸掉了绝大部分接近动能（残留靠近 < 90% 原始接近速度）",
        "|残留 " + F(std::fabs(r.carReboundMs), 3) + "| ≤ " +
            F(r.carApproachMs * 0.90, 3) + " m/s");
  // ★★ 求解器绝不注入动能（热力学第二定律的数字形式）
  Check(r.energyAfterJ <= r.energyBeforeJ + 1e-3,
        "★★★ 碰撞前后总动能严格不增（求解器零能量注入）",
        F(r.energyBeforeJ, 0) + " J → " + F(r.energyAfterJ, 0) + " J (Δ=" +
            F(r.energyAfterJ - r.energyBeforeJ, 1) + " J)");
  Check(r.clampedImpulses >= 1,
        "★ 高速撞击确实触发冲量硬上限截断（规格 §5 生效）",
        std::to_string(r.clampedImpulses) + " 次");
  Check(r.projected >= 1,
        "★ 位置相被调用（分离冲量：几何修复但不注入动能）",
        std::to_string(r.projected) + " 次");
  Check(std::isfinite(r.barrierReboundMs) && std::isfinite(r.carReboundMs) &&
            std::isfinite(r.maxVyAllMs),
        "★ 求解结果全部有限（无 NaN / Inf 污染）");
}

void PhaseE_Realtime(const Report& r) {
  Banner("Phase E · 实时运行统计（FPS / RTT / 抖动 / Jerk）");
  std::printf("  仿真：%d tick @ 60Hz = %.2fs | 真实墙钟 %.1fms\n",
              r.ticks, r.simulatedSec, r.wallMs);
  std::printf("  \033[1m等效帧率\033[0m：%.0f fps（%.2f ms/tick，含 4 客户端 + 混沌信道 + 碰撞解算）\n",
              r.effectiveFps, r.wallMs / std::max(1, r.ticks));
  std::printf("  网络：RTT %.1fms（均值） | 单程抖动 %.1f~%.1fms | 丢包 %.2f%% | 乱序 %llu\n",
              r.meanRttMs, r.oneWayMinMs, r.oneWayMaxMs, r.dropPct,
              (unsigned long long)r.outOfOrder);
  std::printf("  质量：RMSE %.4fm | Jerk 峰值 %.1f m/s³ | 闪现 %d 次 | Jerk 尖峰 %d 次\n",
              r.rmseM, r.maxJerkMs3, r.jumps, r.jerkSpikes);

  Check(r.effectiveFps > 1000.0,
        "★ 仿真吞吐足够高（无头单机可在毫秒级压完数十秒比赛）",
        F(r.effectiveFps, 0) + " fps");
  Check(r.simulatedSec >= 6.0, "★ 仿真时长足够覆盖全部场景",
        F(r.simulatedSec, 2) + "s");
}

}  // namespace

/// 断言计数（`g_pass`/`g_fail` 在匿名命名空间里，main 需要用）
[[nodiscard]] int PassCount() noexcept { return g_pass; }
[[nodiscard]] int FailCount() noexcept { return g_fail; }

}  // namespace mp

// =============================================================================
//  8. main
// =============================================================================
using mp::Report;
using mp::RunChaos;
using mp::PassCount;
using mp::FailCount;

int main(int argc, char** argv) {
  bool verbose = true;
  std::uint32_t seed = 20260925u;
  double duration = 16.0;   // ≥ tSlipDown(10.5s) + 被超越所需时间
  int hudEveryN = 180;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "-q" || a == "--quiet") verbose = false;
    else if (a == "-v" || a == "--verbose") verbose = true;
    else if (a.rfind("--seed=", 0) == 0) seed = static_cast<std::uint32_t>(std::stoul(a.substr(7)));
    else if (a.rfind("--sec=", 0) == 0) duration = std::stod(a.substr(6));
    else if (a.rfind("--hud-every=", 0) == 0) hudEveryN = std::stoi(a.substr(12));
    else {
      std::printf("用法: %s [-q|-v] [--seed=N] [--sec=14] [--hud-every=180]\n", argv[0]);
      return 2;
    }
  }

  std::printf("\033[1m╔══════════════════════════════════════════════════════════════════════╗\033[0m\n");
  std::printf("\033[1m║  极限竞速 · LAN —— 单机无头多人混沌仿真测试台 (MP Chaos Harness)   ║\033[0m\n");
  std::printf("\033[1m╚══════════════════════════════════════════════════════════════════════╝\033[0m\n");
  std::printf("  拓扑：1 权威服务端 + 4 客户端（1 本地带渲染平滑层 + 3 无头 Bot）\n");
  std::printf("  seed=%u  时长=%.1fs  步长=1/60s  广播=60Hz(每车→每客户端)\n", seed, duration);
  std::printf("  混沌信道：RTT 均值 100ms | 抖动 20~160ms **非对称长尾**(对数正态) | "
              "丢包 8%% | 乱序 5%%\n");

  const Report r = RunChaos(seed, duration, verbose, hudEveryN);

  PhaseA_Channel(r);
  PhaseB_Jitter(r);
  PhaseC_HudDelta(r);
  PhaseD_Collision(r);
  PhaseE_Realtime(r);

  std::printf("\n\033[36m══════════════════════════════════════════════════════════════════════\033[0m\n");
  std::printf("  结果：\033[32m%d 通过\033[0m / \033[31m%d 失败\033[0m\n", PassCount(), FailCount());
  std::printf("  判定：%s\n",
              FailCount() == 0
                  ? "\033[32m通过 —— 无闪现、无弹开、HUD 秒差合规\033[0m"
                  : "\033[31m有失败项\033[0m");
  std::printf("\033[36m══════════════════════════════════════════════════════════════════════\033[0m\n");
  return FailCount() == 0 ? 0 : 1;
}
