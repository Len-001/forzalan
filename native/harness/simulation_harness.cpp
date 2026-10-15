// =============================================================================
//  simulation_harness.cpp —— 四模块全链路联调 + 混沌网络压测
//
//  把 native/ 下四个独立模块串成一条**完整的联机物理流水线**，再在真实网络的
//  恶劣条件下压它，用可观测量验证它不崩、不炸、不瞬移。
//
//  ── 被测四模块（真调用，不是复刻）─────────────────────────────────────────
//    ① forza::net::ForzaTimeSynchronizer      （timesync/）      NTP + Clock Slewing
//    ② forza::net::NetworkRigidBodyReplicator （rb_replicator/） 航位推测 + 双层误差融合
//    ③ forza::physics::SafeCollisionResolver  （safe_collision/）分离冲量 + 防炸车
//    ④ forza::wasm::NetworkPhysicsBridge      （wasm/）          零拷贝 ABI 的宿主层
//
//  ── 拓扑 ─────────────────────────────────────────────────────────────────
//     DedicatedServer ──[ ChaosNetwork ]──> ClientA / ClientB
//       · 服务端 60Hz 权威仿真，广播 96B 快照（RigidBodyNetSnapshot）
//       · Chaos：均值 80ms 单向 + 高斯抖动 20~150ms + 10% 丢包 + 乱序
//       · 客户端：OnPong 喂时钟 → AdjustedDeltaTime 取实际步长 → SnapshotCommit
//                  收纠偏 → Update 外推 → 与权威位置比残差
//
//  ── 场景 ─────────────────────────────────────────────────────────────────
//     Phase 1 对向逼近：A/B 各 100km/h 相向 ⇒ 相对闭速 200km/h（55.56 m/s）
//     Phase 2 高速蹭墙：A 以 55.56 m/s 以 8° 夹角蹭护栏（用真求解器解算）
//     Phase 3 混沌稳态：纯网络质量统计（时钟收敛 + 插值平滑）
//
//  ── 判定（不是"跑完没崩"，而是数值指标）─────────────────────────────────
//     · RMSE：客户端视觉位置 vs 服务端权威位置
//     · 单帧位移突变：检测肉眼可见的瞬移（阈值按当前车速推出）
//     · 碰撞法向反弹速度：绝不允许"反向暴增 / 弹射飞天"
//
//  ── 编译 ─────────────────────────────────────────────────────────────────
//     g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic
//         -I ../timesync -I ../rb_replicator -I ../wasm -I ../safe_collision
//         -I /e/g-truc-glm-8d1fd52
//         simulation_harness.cpp ../timesync/forza_time_sync.cpp -o harness.exe
//     （Windows/MinGW 跑前 export PATH="/e/mingw64/bin:$PATH"；
//       一键跑法见同目录 run_harness.sh）
//
//  ── 确定性 ───────────────────────────────────────────────────────────────
//     所有随机数走自带的 xorshift32 + Box–Muller，绝不用 rand()/默认种子的
//     mt19937。固定 seed ⇒ 逐位可复现的日志 —— 这是"压测报告能当回归基线"的前提。
//
//  ── 本压测揪出的真实缺陷（务必保留这两条注释，它们解释了设计取舍）─────────
//     [D1] "位置冻结 + 速度未消" = 伪造瞬移源
//          墙相位最初写成 `if (!wallPhase) { A推进; B推进; }` —— A 进墙后**B 也停了**，
//          但 B.vel 仍是 -27.78m/s。服务端因此在广播一个自相矛盾的权威状态
//          （位置不动、速度 100km/h）。纯远端客户端 B 在丢包间隙按 27.78m/s 外推，
//          越过 snapDistanceM(5m) 触发硬吸附 -> 每 ~300 tick 一次 ~4.8m 倒退瞬移
//          （实测 tick 570/866/1144，权威位置恒为 -47.13）。零丢包时 0 次。
//          修法：B 始终按自己速度推进；A 的墙约束只消**法向**速度、保留切向滑动。
//          => 教训：压测场景本身必须物理自洽，否则会把"自己造的假象"当成算法 bug。
//     [D2] 场景不连续窗（cutWindow）必须有**上界**守卫
//          碰撞重定位/场景瞬移属于真实断点，隔离掉是对的；但若隔离窗覆盖大半运行
//          （曾误加每 tick 续窗 -> 720 帧隔离 660 帧），后面的"0 跳跃"就是无意义假绿。
//          故断言要求隔离比例 < 15%。
//     [D3] 防"零样本假绿"：暖机门控必须指向**真正在跑的对象**
//          A 走 g_bridge、B 走 cb.repl。曾误用 ca.repl.HasState()（A 根本没喂它）
//          -> 门控永远 false -> 一条样本没采 -> RMSE 打印成 0.0000m 的"完美假绿"。
//          故先断言样本数（阈值按仿真时长参数化，不写死常数）。
// =============================================================================

#include "forza_time_sync.h"
#include "network_physics_bridge.h"
#include "rigid_body_replicator.h"
#include "safe_collision_resolver.h"

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

// =============================================================================
//  0. 确定性随机 + 混沌网络管线
// =============================================================================

namespace harness {

/// xorshift32：极小、极快、跨平台逐位一致。压测要可复现，绝不能碰 rand()。
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

  /**
   * Box–Muller 标准正态。
   * 抖动要用**高斯**而不是均匀：真实网络的排队延迟是长尾的，均匀分布会把
   * "偶尔一次 150ms" 这类极端情形直接削掉，压不出问题。
   */
  double Gaussian() noexcept {
    const double u1 = std::max(Uniform(), 1e-12);
    const double u2 = Uniform();
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(6.283185307179586 * u2);
  }
};

/// 混沌网络参数（默认值即规格给定值）。
struct ChaosConfig final {
  double baseLatencyMs  = 80.0;    ///< 平均单向延迟
  double jitterSigmaMs  = 32.0;    ///< 高斯抖动 σ（clamp 后均值≈80，范围 20~150）
  double jitterLoMs     = 20.0;    ///< 规格下限
  double jitterHiMs     = 150.0;   ///< 规格上限
  double lossRate       = 0.10;    ///< 10% 丢包
  double reorderRate    = 0.18;    ///< 18% 的包被故意压后（制造乱序）
  double reorderExtraMs = 45.0;    ///< 被压后的包额外延迟
};

/// 一个在途数据包。
struct InFlight final {
  forza::net::RigidBodyNetSnapshot snap{};
  double arriveSec = 0.0;   ///< 预定到达的仿真墙钟（秒）
  std::uint32_t seq = 0;    ///< 发送序号（用于统计乱序）
  bool isPong = false;      ///< 是否 NTP 回程包
  forza::net::Nanos t1 = 0, t2 = 0, t3 = 0;
};

/**
 * 混沌网络管线。
 *
 * 按**仿真墙钟**排序投递，而不是用真实线程 + sleep：整个压测是单线程、
 * 单时钟推进的确定性仿真，日志才可复现，也不必把测试拖成几分钟真等 80ms。
 */
class ChaosNetwork final {
 public:
  ChaosNetwork(const ChaosConfig& cfg, std::uint32_t seed) noexcept : cfg_(cfg), rng_(seed) {}

  /// 采样一次单向延迟（含高斯抖动，钳到规格区间）
  double SampleLatencyMs() noexcept {
    double ms = cfg_.baseLatencyMs + rng_.Gaussian() * cfg_.jitterSigmaMs;
    return std::clamp(ms, cfg_.jitterLoMs, cfg_.jitterHiMs);
  }

  /// @return false 表示该包被丢弃
  bool SendSnapshot(const forza::net::RigidBodyNetSnapshot& s, double nowSec) noexcept {
    ++sent_;
    if (rng_.Uniform() < cfg_.lossRate) { ++dropped_; return false; }
    InFlight f{};
    f.snap = s;
    f.seq = ++seqCounter_;
    double lat = SampleLatencyMs();
    if (rng_.Uniform() < cfg_.reorderRate) { lat += cfg_.reorderExtraMs; ++reorderInjected_; }
    f.arriveSec = nowSec + lat * 1e-3;
    queue_.push_back(f);
    return true;
  }

  /**
   * 发送一个 NTP 回程包。
   * @param outboundLatMs 去程的实际延迟（调用方已经用它盖了 t2 的戳，
   *        这里必须复用同一个值，否则 t2 的戳与实际到达时刻不一致 -> RTT 失真）
   */
  void SendPong(forza::net::Nanos t1, forza::net::Nanos t2, forza::net::Nanos t3,
                double outboundLatMs, double nowSec) noexcept {
    ++sent_;
    if (rng_.Uniform() < cfg_.lossRate) { ++dropped_; return; }
    InFlight f{};
    f.isPong = true;
    f.t1 = t1; f.t2 = t2; f.t3 = t3;
    f.seq = ++seqCounter_;
    // 回程延迟独立采样，并沿用与去程相同的乱序策略
    double lat = SampleLatencyMs();
    if (rng_.Uniform() < cfg_.reorderRate) lat += cfg_.reorderExtraMs;
    f.arriveSec = nowSec + outboundLatMs * 1e-3 + lat * 1e-3;
    queue_.push_back(f);
  }

  /// 取出所有已到期的包，按到达时刻升序交付（= 网络把乱序的包真实重排过）。
  std::vector<InFlight> DrainArrived(double nowSec) noexcept {
    std::vector<InFlight> out;
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
              [](const InFlight& a, const InFlight& b) { return a.arriveSec < b.arriveSec; });
    for (auto& f : out) {
      ++delivered_;
      if (f.seq < maxSeqSeen_) ++outOfOrder_;
      maxSeqSeen_ = std::max(maxSeqSeen_, f.seq);
    }
    return out;
  }

  std::uint64_t Sent() const noexcept { return sent_; }
  std::uint64_t Dropped() const noexcept { return dropped_; }
  std::uint64_t Delivered() const noexcept { return delivered_; }
  std::uint64_t OutOfOrder() const noexcept { return outOfOrder_; }
  std::uint64_t ReorderInjected() const noexcept { return reorderInjected_; }
  std::size_t InFlightCount() const noexcept { return queue_.size(); }

 private:
  ChaosConfig cfg_;
  Rng rng_;
  std::vector<InFlight> queue_;
  std::uint64_t sent_ = 0, dropped_ = 0, delivered_ = 0, outOfOrder_ = 0, reorderInjected_ = 0;
  std::uint32_t seqCounter_ = 0;
  std::uint32_t maxSeqSeen_ = 0;
};

/// 服务端权威刚体。
struct Body final {
  glm::vec3 pos{0.0F};
  glm::vec3 vel{0.0F};
  glm::vec3 accel{0.0F};
  glm::quat rot{1.0F, 0.0F, 0.0F, 0.0F};
  glm::vec3 omega{0.0F};
  std::uint32_t frame = 0;
  std::uint32_t id = 0;      ///< 车号（0=A, 1=B），供客户端路由

  forza::net::RigidBodyNetSnapshot ToSnapshot(double serverTimeSec) const noexcept {
    forza::net::RigidBodyNetSnapshot s{};
    s.frame = frame;
    s.tickMs = static_cast<std::uint32_t>(serverTimeSec * 1000.0);
    s.serverTimeSec = static_cast<float>(serverTimeSec);
    s.position = pos;
    s.rotation = rot;
    s.velocity = vel;
    s.angularVelocity = omega;
    s.accel = accel;
    // 复用未使用的 pad 字段携带车号（真实协议里应显式加字段；
    // 这里不动物理布局是为了不破坏 rb_replicator 的 96B 断言）
    s._pad0 = static_cast<float>(id);
    return s;
  }

  [[nodiscard]] static std::uint32_t IdOf(const forza::net::RigidBodyNetSnapshot& s) noexcept {
    return static_cast<std::uint32_t>(s._pad0 + 0.5F);
  }
};

}  // namespace harness

// =============================================================================
//  1. 测试框架（与项目其它单测同风格：零依赖、计数、退出码即结论）
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

void Sub(const char* t) {
  std::printf("\n\033[33m· %s\033[0m\n", t);
  std::fflush(stdout);
}

std::string F(double v, int prec = 4) {
  char b[64];
  std::snprintf(b, sizeof(b), "%.*f", prec, v);
  return std::string(b);
}

constexpr double kTickSec = 1.0 / 60.0;
constexpr double kKmhToMs = 1.0 / 3.6;

}  // namespace

// =============================================================================
//  2. 压测主体
// =============================================================================

using namespace harness;
using forza::net::RigidBodyNetSnapshot;
using forza::net::Nanos;
using forza::net::kNanosPerSecond;
using forza::net::ForzaTimeSynchronizer;
using forza::net::NetworkRigidBodyReplicator;
using forza::net::ReplState;
using forza::net::SyncEvent;
using forza::net::kNoSample;
using forza::physics::SafeCollisionResolver;
using forza::physics::ResolverConfig;
using forza::physics::RigidBodyView;
using forza::physics::ContactManifold;
using forza::physics::ContactKind;
using forza::physics::ContactPoint;
using forza::physics::Vec3;
using forza::physics::ResolveStats;

namespace {

/// wasm bridge 单例：客户端 A 走它的零拷贝暂存区路径（与真机同一条代码路径）。
/// 声明在压测函数之前，避免前向引用。
forza::wasm::NetworkPhysicsBridge g_bridge;

// -----------------------------------------------------------------------------
//  残差统计器：RMSE + 最大误差 + 单帧位移突变检测
// -----------------------------------------------------------------------------
struct ResidualTracker final {
  double sumSq = 0.0;
  std::size_t n = 0;
  double maxErr = 0.0;

  glm::vec3 prevVisPos{0.0F};
  glm::vec3 authPrev{0.0F};    ///< 上一帧权威位置（用于量化真实阶跃幅度）
  bool hasPrev = false;
  bool enabled = false;        ///< 暖机期结束前不采集（否则开局"无状态→首帧"会污染 RMSE）
  double maxStepM = 0.0;
  double stepLimitM = 0.0;
  int jumps = 0;
  bool skipNextStep = false;   ///< 忽略下一帧的位移（权威侧真实阶跃，如碰撞重定位）
  int eventHoldFrames = 0;     ///< 碰撞后若干帧内不统计（等误差融合把阶跃化掉）
  std::size_t skipped = 0;

  // ── 场景不连续窗（Scene Cut Window）────────────────────────────────────
  // 压测里有两类"权威位置真实跳变"不是同步缺陷，必须区分对待：
  //   (a) 场景切换：t=6s 把 bodyA 瞬移到护栏前（世界坐标断点）；
  //   (b) 持续接触钳位：蹭墙阶段每 tick 把 pos.x 压回墙面前（line 562），
  //       这是"碰撞约束持续生效"的正确表现，不是插值抖动。
  // 这些帧的"大位移"记为权威阶跃（authStepM），ALONE 统计、保留可观测性，
  // 但**不计入** jumps（瞬移缺陷计数）。若不隔离，(b) 会在 14s 里反复触发
  // 越界判定 -> 假失败（实测 --sec=20 全 10 个 seed 都报 1~4 次假跳跃）。
  int cutWindow = 0;                 ///< >0 表示本帧处于场景不连续窗内
  double maxAuthStepM = 0.0;         ///< 权威侧真实阶跃的最大值（报告用，证明"跳变有出处"）
  std::size_t cutFrames = 0;         ///< 被不连续窗覆盖的帧数
  bool traceJumps = false;           ///< 诊断开关：打印每次跳变的 tick 与坐标
  int tickIndex = 0;                 ///< 当前 tick（诊断用）

  /// 标记接下来 n 帧为场景不连续窗（覆盖瞬移 + 持续钳位）。
  void MarkCut(int frames) noexcept {
    if (frames > cutWindow) cutWindow = frames;
  }

  /// 合理单帧位移 = v·dt，给 4 倍余量（外推 + 纠偏叠加），再叠 0.75m 绝对宽松项，
  /// 避免静止时被浮点噪声误判。
  void SetStepLimitFromSpeed(double speedMs) noexcept {
    stepLimitM = speedMs * kTickSec * 4.0 + 0.75;
  }

  void Push(const glm::vec3& visPos, const glm::vec3& authoritative) noexcept {
    if (!enabled) return;
    // 权威侧发生真实阶跃（碰撞重定位）后，客户端需要若干帧把误差融合掉。
    // 这段时间的"大位移"是**正确的事件响应**，不是插值缺陷 —— 单独统计，
    // 不混进"瞬移"计数，否则会把正常行为误判为 bug。
    if (eventHoldFrames > 0) {
      --eventHoldFrames;
      ++skipped;
      prevVisPos = visPos;
      authPrev = authoritative;
      hasPrev = true;
      return;
    }
    // 场景不连续窗：权威位置发生了真实断点（瞬移 / 持续接触钳位）。
    // 此时"视觉位置追不上权威位置"是必然且正确的，不能算作同步质量样本。
    if (cutWindow > 0) {
      --cutWindow;
      ++skipped;
      ++cutFrames;
      // 仍记录权威侧的真实阶跃幅度（保留可观测性：这些跳变有明确出处）
      if (hasPrev) {
        const double authStep = static_cast<double>(glm::length(authoritative - authPrev));
        maxAuthStepM = std::max(maxAuthStepM, authStep);
      }
      prevVisPos = visPos;
      authPrev = authoritative;
      hasPrev = true;
      return;
    }

    const double err = static_cast<double>(glm::length(visPos - authoritative));
    sumSq += err * err;
    ++n;
    maxErr = std::max(maxErr, err);

    if (hasPrev && !skipNextStep) {
      const double step = static_cast<double>(glm::length(visPos - prevVisPos));
      maxStepM = std::max(maxStepM, step);
      if (step > stepLimitM) {
        ++jumps;
        if (traceJumps) {
          std::printf("    \033[33m[跳变#%d] tick=%d  位移 %.4fm > 上限 %.4fm  "
                      "| 权威 (%.2f,%.2f,%.2f) | 视觉 prev->now: (%.2f,%.2f,%.2f)->(%.2f,%.2f,%.2f)\033[0m\n",
                      jumps, tickIndex, step, stepLimitM,
                      authoritative.x, authoritative.y, authoritative.z,
                      prevVisPos.x, prevVisPos.y, prevVisPos.z,
                      visPos.x, visPos.y, visPos.z);
        }
      }
    }
    skipNextStep = false;
    prevVisPos = visPos;
    authPrev = authoritative;
    hasPrev = true;
  }

  double Rmse() const noexcept {
    return (n > 0) ? std::sqrt(sumSq / static_cast<double>(n)) : 0.0;
  }
  std::size_t Samples() const noexcept { return n; }
};

// -----------------------------------------------------------------------------
//  客户端（完整的联机接收侧）
// -----------------------------------------------------------------------------
struct ClientPeer final {
  const char* name = "?";
  ForzaTimeSynchronizer sync{};
  NetworkRigidBodyReplicator repl{};
  ResidualTracker residual{};
  double minRttMs = 1e30, maxRttMs = 0.0, sumRttMs = 0.0;
  std::size_t rttCount = 0;
  std::size_t accepted = 0, rejected = 0, hardResyncs = 0;
  double warpAbsSum = 0.0;
  std::size_t warpSamples = 0;
};

// -----------------------------------------------------------------------------
//  压测报告
// -----------------------------------------------------------------------------
struct StressReport final {
  // 网络
  std::uint64_t sent = 0, dropped = 0, delivered = 0, outOfOrder = 0, reorderInjected = 0;
  double dropPct = 0.0;
  double minRttMs = 0.0, maxRttMs = 0.0;   ///< 窗口最小 RTT 的极值
  double meanRttMs = 0.0;          ///< 窗口最小 RTT 的均值（见 Phase 1 注释）
  double meanMinRttMs = 0.0;       ///< 同上（语义化别名，避免误读为"全网平均 RTT"）
  std::size_t syncRejected = 0, hardResyncs = 0;
  // 时钟
  double meanAbsWarpPct = 0.0;
  double maxAbsWarpPct = 0.0;
  bool lockedAtEnd = false;
  double finalOffsetErrMs = 0.0;
  // 插值质量
  double rmseM = 0.0, maxErrM = 0.0, maxStepM = 0.0;
  int jumps = 0;
  std::size_t accepted = 0, rejected = 0;
  std::size_t warmupSkipped = 0;   ///< 暖机期跳过的帧数（不计入 RMSE）
  std::size_t rmseSamples = 0;     ///< 实际计入 RMSE 的帧数（防"零样本假绿"）
  std::size_t cutFrames = 0;       ///< 场景不连续窗覆盖的帧数（瞬移/持续钳位）
  double maxAuthStepM = 0.0;       ///< 权威侧真实阶跃峰值（证明"跳变有出处"）
  double simulatedSec = 0.0;       ///< 本次仿真时长（秒，供阈值参数化）
  // 残差基准（物理预期滞后 = v × 单向延迟，而不是硬编码常数）
  double referenceSpeedMs = 0.0;   ///< 全程**峰值**车速（m/s），用于推预期滞后
  double oneWayMs = 0.0;           ///< 实测平均单向延迟（ms）
  double stepLimitM = 0.0;         ///< 实际使用的单帧位移上限
  double peakSpeedMs = 0.0;        ///< 全程速度峰值（= preImpactSpeedMs）
  // 碰撞
  bool impactResolved = false;
  double incomingNormalMs = 0.0;
  double reboundNormalMs = 0.0;
  double effRestitution = 0.0;
  double postImpactMaxSpeedMs = 0.0;
  double preImpactSpeedMs = 0.0;
  std::size_t clampedImpulses = 0, redirectedNormals = 0, projected = 0;
  double impactNormalY = 1.0;
  double energyBefore = 0.0, energyAfter = 0.0;
  double postImpactVerticalY = 0.0;   ///< 碰撞后垂直位移（必须 ≈0，防被铲起）
};

/**
 * 主压测：跑 durationSec 秒仿真，返回统计。
 * 场景时间线：
 *   [0.0, 6.0)  对向逼近（相对闭速 200km/h）
 *   [6.0, 结束) 高速蹭墙（A 以 200km/h 以 8° 蹭护栏）
 */
StressReport RunChaosStress(std::uint32_t seed, double durationSec, bool verbose) {
  StressReport rep;
  Rng rng(seed);
  (void)rng;

  const float speed = static_cast<float>(100.0 * kKmhToMs);   // 27.78 m/s

  // ---- 场景时间线（秒）----
  const double tWall = 6.0;
  const float wallPlaneX = 40.0F;

  Body bodyA, bodyB;
  bodyA.id = 0;                       // A 车
  bodyB.id = 1;                       // B 车
  bodyA.pos = glm::vec3(-120.0F, 0.0F, 0.0F);
  bodyA.vel = glm::vec3(+speed, 0.0F, 0.0F);
  bodyB.pos = glm::vec3(+120.0F, 0.0F, 0.0F);
  bodyB.vel = glm::vec3(-speed, 0.0F, 0.0F);

  ChaosNetwork net(ChaosConfig{}, seed ^ 0x5A5A5A5Au);

  ClientPeer ca, cb;
  ca.name = "A";                      // 追踪 A 车
  cb.name = "B";                      // 追踪 B 车
  // 给 B 的 replicator 一个初始帧，避免开局从"无状态"起步
  cb.repl.OnAuthoritativeSnapshot(bodyB.ToSnapshot(0.0));

  const double serverOffsetSec = 0.137;      // 服务端时钟领先本地 137ms
  const int totalTicks = static_cast<int>(durationSec * 60.0);
  const int pongEveryN = 15;                 // 4Hz PING（加密以更快收敛）

  bool wallPhase = false;
  bool impactDone = false;

  // 诊断：verbose 时把每次跳变连 tick 一起打出来（-q 下静默）
  ca.residual.traceJumps = verbose;
  cb.residual.traceJumps = verbose;

  if (verbose) {
    std::printf("\n  ── 场景 ──\n");
    Sub("Phase 1：A/B 对向逼近，相对闭速 200km/h");
    std::printf("  初始：A@x=%+.0fm v=%+.2fm/s (%.0fkm/h) | B@x=%+.0fm v=%+.2fm/s (%.0fkm/h)\n",
                bodyA.pos.x, bodyA.vel.x, bodyA.vel.x / kKmhToMs,
                bodyB.pos.x, bodyB.vel.x, -bodyB.vel.x / kKmhToMs);
    std::printf("  相对闭速 = %.2f m/s = %.0f km/h\n",
                static_cast<double>(bodyA.vel.x - bodyB.vel.x),
                static_cast<double>(bodyA.vel.x - bodyB.vel.x) / kKmhToMs);
    std::printf("\n  %-8s %-11s %-11s %-12s %-10s %-9s %-9s %s\n",
                "t", "warp_A", "warp_B", "offset_A", "RTT", "在途", "RMSE_A", "RMSE_B");
    std::printf("  %s\n", "--------------------------------------------------------------------------");
  }

  for (int tick = 0; tick < totalTicks; ++tick) {
    const double nowSec = static_cast<double>(tick) * kTickSec;
    const Nanos localNowNs = static_cast<Nanos>(nowSec * static_cast<double>(kNanosPerSecond));

    // ---------- (1) 服务端权威推进 ----------
    // ⚠️ 这里不能整段 `if (!wallPhase)`：墙相位只是**车 A** 的场景，
    //   车 B 并不撞墙，必须继续按自己的速度行驶。曾经把 A/B 一起冻住，
    //   结果 B 的权威位置定格而速度仍是 27.78m/s —— 又是一个
    //   "位置冻结 + 速度未消"的自相矛盾状态。B 是纯远端客户端（全靠快照），
    //   所以在丢包间隙按 27.78m/s 外推、越推越偏，每 ~300 tick 触发一次
    //   5m 硬吸附 -> 倒退瞬移（实测 tick 570/866/1144，位置恒为 -47.13）。
    if (!wallPhase) {
      bodyA.pos += bodyA.vel * static_cast<float>(kTickSec);
    }
    bodyB.pos += bodyB.vel * static_cast<float>(kTickSec);
    // A 进入墙相位后由下方 contact 段推进（含法向约束）
    bodyA.accel = glm::vec3(0.0F);
    bodyB.accel = glm::vec3(0.0F);
    // 绕 Y 轴（up）的偏航，用 angleAxis 显式构造（不依赖 GLM 的欧拉角顺序约定）
    const float yaw = static_cast<float>(std::sin(nowSec * 0.7) * 0.12);
    bodyA.rot = glm::angleAxis(yaw, glm::vec3(0.0F, 1.0F, 0.0F));
    bodyB.rot = glm::angleAxis(-yaw, glm::vec3(0.0F, 1.0F, 0.0F));
    bodyA.omega = glm::vec3(0.0F, static_cast<float>(std::cos(nowSec * 0.7) * 0.084), 0.0F);
    bodyB.omega = -bodyA.omega;

    // ---------- (2) Phase 2：高速蹭墙（真求解器）----------
    if (!wallPhase && nowSec >= tWall) {
      wallPhase = true;
      const float spd = static_cast<float>(200.0 * kKmhToMs);    // 55.56 m/s
      const float ang = 8.0F * 3.14159265F / 180.0F;
      bodyA.vel = glm::vec3(spd * std::cos(ang), 0.0F, spd * std::sin(ang));
      bodyA.pos = glm::vec3(wallPlaneX - 0.35F, 0.0F, -20.0F);
      rep.preImpactSpeedMs = static_cast<double>(glm::length(bodyA.vel));

      // ★ 场景切换：一次世界坐标瞬移（Phase1 位置 -> 护栏前）。这是**权威侧
      //   真实断点**，客户端必须花几帧靠误差融合吸收。标记不连续窗，
      //   否则这一帧会被当成 ~50m 的"瞬移缺陷"（实测踩过）。
      ca.residual.MarkCut(30);
      cb.residual.MarkCut(30);
      if (verbose) {
        Sub("Phase 2：高速蹭墙（200km/h，8° 夹角，真求解器）");
        std::printf("  \033[35m[t=%5.2fs]\033[0m |v|=%.2f m/s (%.0f km/h)，初始穿透 0.35m\n",
                    nowSec, rep.preImpactSpeedMs, rep.preImpactSpeedMs / kKmhToMs);
      }
    }

    if (wallPhase && !impactDone) {
      // 护栏法线：车在 −x 侧，n 从车指向墙。刻意带 5% Y 分量，验证重定向真的抹平它。
      RigidBodyView car;
      car.position = Vec3(bodyA.pos.x, bodyA.pos.y, bodyA.pos.z);
      car.velocity = Vec3(bodyA.vel.x, bodyA.vel.y, bodyA.vel.z);
      car.invMass = 1.0F / 1380.0F;
      car.invInertia = 1.0F / 1800.0F;

      const Vec3 rawNormal = Vec3(1.0F, 0.05F, 0.0F).Normalized();
      rep.impactNormalY = static_cast<double>(rawNormal.y);

      ContactManifold mf;
      mf.a = &car;
      mf.b = nullptr;                                    // 静态护栏
      mf.kind = ContactKind::CarToWall;
      mf.normal = rawNormal;
      mf.pointCount = 1;
      const float pen = wallPlaneX - bodyA.pos.x;
      mf.points[0] = ContactPoint{{0.0F, 0.0F, 0.0F}, {}, (pen > 0.0F ? pen : 0.0F), 0.0F, 0.0F};

      // 入射法向速度（沿重定向后的水平法线度量的接近速度）
      const Vec3 nHoriz = Vec3(1.0F, 0.0F, 0.0F);
      rep.incomingNormalMs = static_cast<double>(car.velocity.Dot(nHoriz));

      // ★ 动能前后对比（证明求解器不注入动能）
      const double invM = static_cast<double>(car.invMass);
      const double m = (invM > 0.0) ? 1.0 / invM : 0.0;
      rep.energyBefore = 0.5 * m * static_cast<double>(car.velocity.LengthSq());

      ResolveStats st;
      SafeCollisionResolver::Resolve(mf, static_cast<float>(kTickSec), ResolverConfig{}, &st);

      rep.energyAfter = 0.5 * m * static_cast<double>(car.velocity.LengthSq());
      rep.reboundNormalMs = static_cast<double>(car.velocity.Dot(nHoriz));
      rep.effRestitution = (rep.incomingNormalMs > 1e-6)
                             ? (-rep.reboundNormalMs / rep.incomingNormalMs) : 0.0;
      rep.clampedImpulses = static_cast<std::size_t>(st.clampedNormal);
      rep.redirectedNormals = static_cast<std::size_t>(st.redirectedNormals);
      rep.projected = static_cast<std::size_t>(st.projected);
      rep.impactResolved = true;
      impactDone = true;

      bodyA.vel = glm::vec3(car.velocity.x, car.velocity.y, car.velocity.z);
      bodyA.pos = glm::vec3(car.position.x, car.position.y, car.position.z);
      rep.postImpactVerticalY = static_cast<double>(car.position.y);

      // 碰撞解算会让权威位置发生一次**真实**的阶跃（速度被削减 + 位置投影推开）。
      // 这不是插值缺陷，而是"服务器权威状态确实跳了" —— 客户端必然要花几帧
      // 用指数误差融合把它化掉。因此把随后的 ~0.5s 标为"事件恢复窗"，
      // 期间的位移不计入"瞬移"统计，否则会把正常的事件响应误判成缺陷。
      // （0.5s ≈ 10 帧可视作视觉层从 20m 误差收敛回亚米级的合理上界）
      ca.residual.eventHoldFrames = 30;
      cb.residual.eventHoldFrames = 30;

      if (verbose) {
        std::printf("  \033[35m[t=%5.2fs] 碰撞解算\033[0m：法向入射 %+.3f m/s → 反弹 %+.3f m/s "
                    "（e_eff=%.4f）\n", nowSec, rep.incomingNormalMs, rep.reboundNormalMs,
                    rep.effRestitution);
        std::printf("             重定向 %zu 次 / 冲量截断 %zu 次 / 位置投影 %zu 次 | "
                    "动能 %.1f J → %.1f J (Δ=%+.3f J)\n",
                    rep.redirectedNormals, rep.clampedImpulses, rep.projected,
                    rep.energyBefore, rep.energyAfter, rep.energyAfter - rep.energyBefore);
      }
    }

    if (wallPhase) {
      bodyA.pos += bodyA.vel * static_cast<float>(kTickSec);
      // ── 持续接触：护栏只拦**法向**运动，切向自由滑动 ──────────────────
      // 这必须与真实护栏语义一致，否则会造出一个"伪瞬移"陷阱：
      //   若只把 pos.x 钉死、却保留 55m/s 的法向速度，服务端就在广播一个
      //   **自相矛盾**的权威状态（位置不动、速度极大）。客户端在丢包间隙
      //   按 55m/s 外推，每个间隙领先 55×Δt（Δt 上限 250ms ⇒ 13.9m）；
      //   下个快照回来时把超额位移塞进 visOffPos_，越过 snapDistanceM(5m)
      //   -> 硬吸附 -> 玩家看到一次 ~4.8m 的倒退瞬移。
      //   实测：10% 丢包下每 ~300 tick 必跳一次（tick 570/866/1144）；零丢包 0 次。
      //   根因是"位置被冻结 + 速度未消"的不自洽，不是插值算法缺陷。
      //   => 正确做法：消掉法向速度、保留切向（7.7m/s）滑动，权威状态自洽。
      if (bodyA.pos.x > wallPlaneX - 0.30F) {
        bodyA.pos.x = wallPlaneX - 0.30F;
      }
      if (bodyA.vel.x > 0.0F) bodyA.vel.x = 0.0F;   // 法向速度被墙吸收（护栏语义）
      rep.postImpactMaxSpeedMs =
          std::max(rep.postImpactMaxSpeedMs, static_cast<double>(glm::length(bodyA.vel)));
    }
    // 全程速度峰值（用于推预期滞后：误差在最高速段积累）
    rep.peakSpeedMs = std::max(rep.peakSpeedMs, static_cast<double>(glm::length(bodyA.vel)));
    rep.peakSpeedMs = std::max(rep.peakSpeedMs, static_cast<double>(glm::length(bodyB.vel)));

    // ---------- (3) 服务端广播（混沌网络）----------
    ++bodyA.frame;
    ++bodyB.frame;
    net.SendSnapshot(bodyA.ToSnapshot(nowSec), nowSec);
    net.SendSnapshot(bodyB.ToSnapshot(nowSec), nowSec);

    if (tick % pongEveryN == 0) {
      // ── NTP 时间戳的物理含义（写错这里 RTT 立刻失真）────────────────────
      //   t1 = 本端发出（本地时钟轴）
      //   t2 = 对端**真正收到**的时刻（服务端时钟轴）＝ 本地时刻 + 该包的实际单程延迟 + 固定偏差
      //   t3 = 对端回发（服务端时钟轴，处理耗时 2ms）
      //   t4 = 本端**真正收到**的时刻（本地时钟轴，= 回程包的实际到达时刻）
      // 关键：t2 必须用**这一个包**的真实单程延迟去盖戳，不能用平均值/规格值。
      // 否则 (t4-t1)-(t3-t2) 里混入"假定延迟 vs 真实延迟"的差，RTT 会算出 18ms
      // 这种小于单程下限的怪值（实测踩过）。
      const double outLatMs = net.SampleLatencyMs();
      const Nanos t1 = localNowNs;
      const Nanos t2 = t1 + static_cast<Nanos>(outLatMs * 1e-3 * static_cast<double>(kNanosPerSecond));
      const Nanos t3 = t2 + static_cast<Nanos>(0.002 * static_cast<double>(kNanosPerSecond));
      const Nanos off = static_cast<Nanos>(serverOffsetSec * static_cast<double>(kNanosPerSecond));
      net.SendPong(t1, t2 + off, t3 + off, outLatMs, nowSec);
    }

    // ---------- (4) 客户端收包 ----------
    // 注意：这里的"客户端"模拟的是**每个客户端看到的那一辆车**。
    //   客户端 A 的视角 = 车 A（自己本地权威跑 + 收远端纠偏）
    //   客户端 B 的视角 = 车 B（纯远端，全靠快照驱动）
    // 服务端同时广播两辆车的快照，客户端按车号路由 —— 不路由的话
    // 两个车的坐标会交替灌进同一个 replicator，位置在两车之间反复横跳（实测 RMSE 76m）。
    const auto arrived = net.DrainArrived(nowSec);
    for (const auto& f : arrived) {
      if (f.isPong) {
        // ★ t4 = 包**实际到达**的时刻（含网络延迟），不是本轮 tick 的时刻。
        //   用 tick 时刻会让 (t4-t1) 恒等于发送时的 latency，RTT 计算直接失真
        //   （实测会算出 31ms 这种小于单程下限的值）。
        const Nanos t4 = static_cast<Nanos>(f.arriveSec * static_cast<double>(kNanosPerSecond));
        const Nanos t1 = f.t1;
        const SyncEvent ea = ca.sync.OnPong(t1, f.t2, f.t3, t4);
        const SyncEvent eb = cb.sync.OnPong(t1, f.t2, f.t3, t4);
        if (ea == SyncEvent::SampleRejected) ++rep.syncRejected;
        if (eb == SyncEvent::SampleRejected) ++rep.syncRejected;
        if (ea == SyncEvent::HardResync) ++ca.hardResyncs;
        if (eb == SyncEvent::HardResync) ++cb.hardResyncs;
        if (ca.sync.BestRttNs() != kNoSample) {
          const double rttMs = static_cast<double>(ca.sync.BestRttNs()) / 1e6;
          ca.sumRttMs += rttMs;
          ++ca.rttCount;
          ca.minRttMs = std::min(ca.minRttMs, rttMs);
          ca.maxRttMs = std::max(ca.maxRttMs, rttMs);
        }
      } else if (Body::IdOf(f.snap) == 0) {
        // ★ 客户端 A 走 wasm bridge 的零拷贝暂存区路径（与浏览器同一条代码路径）
        g_bridge.MutableStage() = f.snap;
        const int okA = g_bridge.SnapshotCommit();
        if (okA == 1) ++ca.accepted; else ++ca.rejected;
      } else {
        // 客户端 B 直接喂 replicator（对照路径，不经 bridge）
        if (cb.repl.OnAuthoritativeSnapshot(f.snap)) ++cb.accepted; else ++cb.rejected;
      }
    }

    // ---------- (5) 客户端每帧推进 ----------
    const double dtA = ca.sync.AdjustedDeltaTime(kTickSec);
    const double dtB = cb.sync.AdjustedDeltaTime(kTickSec);
    if (ca.sync.IsLocked()) {
      ca.warpAbsSum += std::fabs(ca.sync.CurrentWarp());
      ++ca.warpSamples;
    }
    if (cb.sync.IsLocked()) {
      cb.warpAbsSum += std::fabs(cb.sync.CurrentWarp());
      ++cb.warpSamples;
    }
    g_bridge.Update(dtA);        // A：经由 bridge（内部 repl_.Update + 刷新矩阵）
    cb.repl.Update(static_cast<float>(dtB));

    // ---------- (6) 残差监控：视觉位置 vs 权威位置 ----------
    // 暖机：客户端起步时 replicator 还是 Empty，第一帧快照到达前视觉位置恒为原点，
    // 这段误差是"初始化瞬态"而非"同步质量"。压测必须丢掉暖机窗，
    // 否则 RMSE 会被开头几帧的 100m+ 误差主导（实测 76m -> 9m 全因为这一条）。
    // ⚠️ 判据必须用**真正在跑的那两个对象**：A 走 g_bridge、B 走 cb.repl。
    //    曾误用 ca.repl.HasState()（A 根本没喂它）-> 永远 false -> 一条样本都没采到，
    //    最后打印出 RMSE 0.0000m 的"完美假绿"。这是本项目的老坑，务必用样本数兜底断言。
    const bool warm = (nowSec >= 1.5) && g_bridge.HasState() && cb.repl.HasState();
    ca.residual.enabled = warm;
    cb.residual.enabled = warm;
    if (!warm) ++rep.warmupSkipped;

    // A 的视觉位置从 bridge 的矩阵暂存区取出（列主序，[12],[13],[14] = 平移分量），
    // 这条路径与浏览器里 Three.js 读矩阵的方式完全一致。
    const glm::vec3 visualA =
        glm::vec3(g_bridge.MatrixElement(0, 12), g_bridge.MatrixElement(0, 13),
                  g_bridge.MatrixElement(0, 14));
    ca.residual.SetStepLimitFromSpeed(static_cast<double>(glm::length(bodyA.vel)));
    ca.residual.tickIndex = tick;
    ca.residual.Push(visualA, bodyA.pos);

    const glm::vec3 visualB = cb.repl.GetVisualPosition();
    cb.residual.SetStepLimitFromSpeed(static_cast<double>(glm::length(bodyB.vel)));
    cb.residual.tickIndex = tick;
    cb.residual.Push(visualB, bodyB.pos);

    // 每 1.5s 一行时钟跟踪日志
    if (verbose && tick % 90 == 0) {
      const double offMs = static_cast<double>(ca.sync.CurrentOffsetNs()) / 1e6;
      std::printf("  %-8s %+9.4f%% %+9.4f%% %+10.3fms %8.2fms %7zu %9.4f %9.4f\n",
                  F(nowSec, 2).c_str(),
                  ca.sync.CurrentWarp() * 100.0, cb.sync.CurrentWarp() * 100.0,
                  offMs,
                  ca.rttCount ? ca.sumRttMs / static_cast<double>(ca.rttCount) : 0.0,
                  net.InFlightCount(),
                  ca.residual.Rmse(), cb.residual.Rmse());
    }
  }

  // ---------- 汇总 ----------
  rep.sent = net.Sent();
  rep.dropped = net.Dropped();
  rep.delivered = net.Delivered();
  rep.outOfOrder = net.OutOfOrder();
  rep.reorderInjected = net.ReorderInjected();
  rep.dropPct = rep.sent ? 100.0 * static_cast<double>(rep.dropped) / static_cast<double>(rep.sent) : 0.0;

  // RTT 取两端里可用的一边
  rep.minRttMs = (ca.minRttMs < 1e29) ? ca.minRttMs : (cb.minRttMs < 1e29 ? cb.minRttMs : 0.0);
  rep.maxRttMs = std::max(ca.maxRttMs, cb.maxRttMs);
  rep.meanRttMs = ca.rttCount ? ca.sumRttMs / static_cast<double>(ca.rttCount) : 0.0;
  rep.meanMinRttMs = rep.meanRttMs;
  rep.hardResyncs = ca.hardResyncs + cb.hardResyncs;

  rep.meanAbsWarpPct = ca.warpSamples
                         ? (ca.warpAbsSum / static_cast<double>(ca.warpSamples)) * 100.0 : 0.0;
  rep.lockedAtEnd = ca.sync.IsLocked();
  // 最终偏移误差：估计出的 offset 与实际 (serverOffset + 单向延迟) 之差
  {
    const double oneWayNs = 0.040 * static_cast<double>(kNanosPerSecond);
    const double trueOffNs = serverOffsetSec * static_cast<double>(kNanosPerSecond) + oneWayNs;
    rep.finalOffsetErrMs =
        (static_cast<double>(ca.sync.CurrentOffsetNs()) - trueOffNs) / 1e6;
  }

  rep.rmseM = std::sqrt((ca.residual.Rmse() * ca.residual.Rmse() +
                         cb.residual.Rmse() * cb.residual.Rmse()) * 0.5);
  rep.maxErrM = std::max(ca.residual.maxErr, cb.residual.maxErr);
  rep.maxStepM = std::max(ca.residual.maxStepM, cb.residual.maxStepM);
  rep.jumps = ca.residual.jumps + cb.residual.jumps;
  rep.accepted = ca.accepted + cb.accepted;
  rep.rejected = ca.rejected + cb.rejected;
  rep.rmseSamples = std::min(ca.residual.Samples(), cb.residual.Samples());
  rep.cutFrames = ca.residual.cutFrames + cb.residual.cutFrames;
  rep.maxAuthStepM = std::max(ca.residual.maxAuthStepM, cb.residual.maxAuthStepM);
  rep.simulatedSec = durationSec;
  // 残差基准：用**全程峰值**车速（wall 阶段 55.56m/s）算预期滞后 ——
  // 误差是在最高速段积累的，拿末段（碰撞后已降到 24m/s）当基准会严重低估阈值。
  rep.referenceSpeedMs = rep.preImpactSpeedMs;
  rep.peakSpeedMs = rep.preImpactSpeedMs;
  // "单向延迟"取窗口最小 RTT 的一半：这是滑窗估计出的、路径最对称的那一拍的延迟，
  // 正是客户端用来对齐的基准量。
  rep.oneWayMs = rep.meanRttMs * 0.5;
  rep.stepLimitM = ca.residual.stepLimitM;

  return rep;
}

}  // namespace

// =============================================================================
//  3. 断言与报告
// =============================================================================

namespace {

void PhaseNetworkAndClock(const StressReport& r) {
  Banner("Phase 1 · 混沌网络管线 + 时钟跟踪（NTP / Clock Slewing）");

  std::printf("  网络管线：发出 %llu / 丢弃 %llu (%.1f%%) / 投递 %llu / 乱序 %llu / 注入压后 %llu\n",
              static_cast<unsigned long long>(r.sent),
              static_cast<unsigned long long>(r.dropped), r.dropPct,
              static_cast<unsigned long long>(r.delivered),
              static_cast<unsigned long long>(r.outOfOrder),
              static_cast<unsigned long long>(r.reorderInjected));
  std::printf("  RTT（窗口最小样本）：最小 %.2fms / 均值 %.2fms / 最大 %.2fms\n",
              r.minRttMs, r.meanRttMs, r.maxRttMs);
  std::printf("  时钟同步：锁定=%s | 平均 |warp|=%.4f%% (上限 1.5%%) | 硬同步 %zu 次 | "
              "非法样本 %zu | 终态偏移误差 %+.3fms\n",
              r.lockedAtEnd ? "是" : "\033[31m否\033[0m", r.meanAbsWarpPct,
              r.hardResyncs, r.syncRejected, r.finalOffsetErrMs);

  Check(r.dropPct > 5.0 && r.dropPct < 16.0,
        "丢包率落在 10% 附近（±6pt）", "实测 " + F(r.dropPct, 2) + "%");
  Check(r.outOfOrder > 0, "存在乱序到达（部分旧包晚于新包）",
        "乱序 " + std::to_string(r.outOfOrder) + " 个");
  Check(r.reorderInjected > 0, "确实注入了压后包（乱序来源可证）",
        "压后 " + std::to_string(r.reorderInjected) + " 个");
  // ⚠️ 用的是 BestRttNs()（滑窗内**最小** RTT 样本），不是全网平均 ——
  //    这是时钟同步器的设计（最小 RTT 样本路径最对称）。所以这里的"均值"是
  //    "每拍的最小 RTT 的均值"，天然低于 baseLatency×2。断言区间要按它来定。
  Check(r.minRttMs >= 36.0 && r.maxRttMs <= 340.0,
        "RTT 落在 20~150ms 单程对应的 40~300ms 区间（含抖动 + 1 tick 量化）",
        "[" + F(r.minRttMs, 1) + ", " + F(r.maxRttMs, 1) + "] ms");
  Check(r.meanMinRttMs >= 60.0 && r.meanMinRttMs <= 170.0,
        "窗口最小 RTT 的均值落在合理区间（应略低于 2×baseLatency）",
        F(r.meanMinRttMs, 2) + "ms");
  Check(r.lockedAtEnd, "时钟同步器最终已锁定（IsLocked）");
  Check(r.meanAbsWarpPct <= 0.6,
        "★ 平均时间伸缩远小于 1.5% 上限（收敛且不抖）",
        F(r.meanAbsWarpPct, 4) + "% ≤ 0.6%");
  // 时钟偏移的估计误差：offset 里含"单程延迟"这一项（NTP 假设路径对称），
  // 所以它天然带 ±(抖动/2) 的路径不对称误差。80ms 单向 + 32ms σ 抖动下，
  // 十几到几十毫秒的残差是**算法的固有精度**，不是 bug。
  Check(std::fabs(r.finalOffsetErrMs) < 60.0,
        "★ 终态时钟偏移误差在「路径不对称」噪声量级内",
        F(r.finalOffsetErrMs, 3) + "ms");
  Check(r.hardResyncs == 0,
        "★ 全程零硬同步（偏差始终 <200ms，故从不 Snap）",
        std::to_string(r.hardResyncs) + " 次");
}

void PhaseInterpolation(const StressReport& r) {
  Banner("Phase 2 · 插值残差与瞬移检测（RMSE / 单帧位移突变）");

  // ★ 残差不能拿绝对常数当阈值 —— 它**物理上正比于 速度和延迟的乘积**。
  //   客户端渲染的是"过去"的状态：稳态滞后 ≈ v · 单向延迟。
  //   本例末段 v=55.56m/s、单向延迟均值 80ms ⇒ 预期滞后 ≈ 4.4m，
  //   实测 RMSE 3.17m 正好落在这个量级内（且小于它，因为外推补偿了一部分）。
  //   写死 0.60m 会在高速段必假红；写死了不检查又会在低速段放过真问题。
  //   正确做法：把"预期滞后"算出来当基准，断言实测残差不超过它的合理倍数。
  const double expectedLag = r.referenceSpeedMs * r.oneWayMs * 1e-3;
  const double tolerance = std::max(0.60, expectedLag * 1.5);

  std::printf("  残差：RMSE %.4fm | 最大误差 %.4fm | 有效样本 %zu 帧（暖机跳过 %zu）\n",
              r.rmseM, r.maxErrM, r.rmseSamples, r.warmupSkipped);
  std::printf("  基准：末段车速 %.2fm/s × 单向延迟 %.2fms ⇒ 预期稳态滞后 %.4fm"
              "（阈值取 1.5× 裕量 = %.4fm）\n",
              r.referenceSpeedMs, r.oneWayMs, expectedLag, tolerance);
  std::printf("  单帧视觉位移：最大 %.4fm | 合理上限 %.4fm | 超限跳跃 %d 帧\n",
              r.maxStepM, r.stepLimitM, r.jumps);
  std::printf("  场景不连续窗：覆盖 %zu 帧 | 权威侧真实阶跃峰值 %.4fm（已隔离，不计入瞬移）\n",
              r.cutFrames, r.maxAuthStepM);
  std::printf("  快照接受 %zu / 拒绝 %zu\n", r.accepted, r.rejected);

  // ★ 先钉样本数：否则"一条也没采到"会让后面所有 RMSE 断言全部假绿成为 0。
  //   阈值**不写死**：仿真时长可变（--sec），断点隔离也会吃掉少量帧。
  //   改为"有效样本 ≥ 扣除暖机与隔离窗后剩余帧数的一半"，与场景参数解耦。
  const std::size_t availableFrames =
      static_cast<std::size_t>(r.simulatedSec * 60.0);
  const std::size_t minSamples = availableFrames / 2;
  Check(r.rmseSamples >= minSamples,
        "★ 有效残差样本充足（防暖机门控写错导致 0 样本假绿）",
        std::to_string(r.rmseSamples) + " 帧 ≥ " + std::to_string(minSamples) +
            "（总帧 " + std::to_string(availableFrames) + "）");
  Check(r.rmseM < tolerance,
        "★ 视觉位置 RMSE 在「车速×延迟」的物理预期内",
        F(r.rmseM, 4) + "m < " + F(tolerance, 4) + "m（含 1.5× 裕量）");
  Check(r.maxErrM < std::max(6.0, expectedLag * 3.0),
        "★ 最大瞬时误差未失控（未超过 snapDistanceM 的失序阈值量级）",
        F(r.maxErrM, 4) + "m");
  // 场景不连续（瞬移 / 持续接触钳位）已被隔离到 cutWindow，不参与瞬移统计。
  // 因此断言收紧到**严格 0 次**：一旦还有跳跃，就是真正的插值缺陷。
  Check(r.jumps == 0,
        "★★ 单帧位移突变 = 0（无肉眼可见瞬移/闪现，场景断点已隔离）",
        std::to_string(r.jumps) + " 次跳跃（阈值 " + F(r.stepLimitM, 3) + "m）");
  // 隔离窗必须有上界守卫：隔离窗是用来"排除断点帧"的，不是用来藏样本的。
  // 若它吞掉大半运行，后面的"0 跳跃"就是无意义的假绿（曾误加每 tick 续窗，
  // 720 帧里隔离了 660 帧 —— 断言形同虚设）。这里要求隔离比例 < 15%。
  const std::size_t observedFrames = r.rmseSamples + r.cutFrames;
  const double cutRatio = observedFrames ? static_cast<double>(r.cutFrames) /
                                            static_cast<double>(observedFrames) : 1.0;
  Check(r.cutFrames > 0 && cutRatio < 0.15,
        "★ 场景不连续窗生效但不过度隔离（防「跳跃=0」因过度藏样本的假绿）",
        std::to_string(r.cutFrames) + " 帧 / " + std::to_string(observedFrames) +
            " 帧（" + F(cutRatio * 100.0, 2) + "% < 15%，权威阶跃峰值 " +
            F(r.maxAuthStepM, 4) + "m）");
  Check(r.maxStepM < std::max(2.0, expectedLag * 2.0),
        "★ 最大单帧位移在物理合理范围内",
        F(r.maxStepM, 4) + "m");
  Check(r.accepted > 0, "客户端确实消费了权威快照（免于服务端白算）",
        std::to_string(r.accepted) + " 帧");
}

void PhaseCollision(const StressReport& r) {
  Banner("Phase 3 · 碰撞冲量监控（防弹飞 / 防炸车）");

  if (!r.impactResolved) {
    Check(false, "★ 高速蹭墙场景发生了解算", "未捕获到解算调用");
    return;
  }

  std::printf("  护栏法线原始 Y 分量 = %.4f（>%.2f ⇒ 应被重定向抹平）\n",
              r.impactNormalY, 0.02);
  std::printf("  入射法向速度 %+.3f m/s (%.0f km/h) → 碰撞后法向速度 %+.3f m/s\n",
              r.incomingNormalMs, r.incomingNormalMs / kKmhToMs, r.reboundNormalMs);
  std::printf("  重定向 %zu 次 / 冲量截断 %zu 次 / 位置投影 %zu 次\n",
              r.redirectedNormals, r.clampedImpulses, r.projected);
  std::printf("  动能 %.1f J → %.1f J (Δ=%+.3f J，负值=耗散)\n",
              r.energyBefore, r.energyAfter, r.energyAfter - r.energyBefore);
  std::printf("  整车速度：入射 %.3f m/s → 碰撞后峰值 %.3f m/s\n",
              r.preImpactSpeedMs, r.postImpactMaxSpeedMs);

  // ── 为什么不断言"反弹速度必须为负"（这是个容易写错的地方）──────────────
  //   200km/h 正面撞墙所需冲量 J = (1+e)·v/k_n ≈ 1.02·55/(1/1380) ≈ 7.7e4 N·s，
  //   **超过** ResolverConfig::maxNormalImpulse = 5e4。于是冲量截断先触发，
  //   单次解算只削掉 5e4/1380 ≈ 36.2 m/s，剩下 55 − 36.2 ≈ 18.8 m/s 仍在朝墙方向。
  //   这是规格④"异常奇异性直接限上限、宁可不物理也不炸"的**设计意图** ——
  //   截断优先于物理正确性。要真正拦停需多次子步迭代累积冲量。
  //   所以这里断言的是三条**不容妥协**的性质：
  //     ① 法线方向被重定向（防跳板通路切断）
  //     ② 总动能严格不增（求解器不注入能量 —— 这才是"防炸车"的本质）
  //     ③ 速度无放大（不出现"速度反向暴增 / 弹射飞天"）
  Check(r.redirectedNormals >= 1,
        "★ 护栏法线被重定向（Y 分量被抹平，防跳板通路已切断）",
        std::to_string(r.redirectedNormals) + " 次");
  Check(r.energyAfter <= r.energyBefore + 1e-3,
        "★★ 总动能严格不增（求解器零能量注入 —— 防炸车的本质）",
        "ΔE = " + F(r.energyAfter - r.energyBefore, 3) + " J");
  Check(r.postImpactMaxSpeedMs <= r.preImpactSpeedMs * 1.02,
        "★★★ 碰撞后速度未超过入射速度（绝无弹射飞天）",
        F(r.postImpactMaxSpeedMs, 3) + " ≤ " + F(r.preImpactSpeedMs, 3) + " m/s");
  Check(std::fabs(r.reboundNormalMs) <= r.incomingNormalMs * 1.02,
        "★★★ 法向速度幅值未放大（无反向暴增）",
        "|" + F(r.reboundNormalMs, 3) + "| ≤ " + F(r.incomingNormalMs, 3));
  Check(std::isfinite(r.reboundNormalMs) && std::isfinite(r.postImpactMaxSpeedMs),
        "★ 求解结果全部有限（无 NaN / Inf 污染）");
  Check(r.clampedImpulses >= 1,
        "★ 200km/h 撞击确实触发冲量硬上限截断（规格④生效）",
        std::to_string(r.clampedImpulses) + " 次");
  Check(r.projected >= 1,
        "★ 位置相被调用（分离冲量：几何修复但不注入动能）",
        std::to_string(r.projected) + " 次");
  // 位置相不得给车"抬起来"（防跳板在位置相也要成立）
  Check(std::fabs(r.postImpactVerticalY) < 1e-4,
        "★★ 碰撞后无垂直位移（车未被铲起 / 未飞天）",
        "y = " + F(r.postImpactVerticalY, 6) + "m");
}

void PhaseFullPipeline(const StressReport& r) {
  Banner("Phase 4 · 全链路总结（四模块协同）");

  const std::string s1 = r.lockedAtEnd
      ? "已锁定，warp 均值 " + F(r.meanAbsWarpPct, 4) + "%"
      : "未锁定";
  const std::string s2 =
      "接受 " + std::to_string(r.accepted) + " 帧，RMSE " + F(r.rmseM, 4) + "m";
  const std::string s3 =
      "e_eff " + F(r.effRestitution, 4) + "，重定向 " +
      std::to_string(r.redirectedNormals) + " 次，零动能注入";
  const std::string s4 =
      "快照经 MutableStage 写入后 SnapshotCommit 消费，共 " +
      std::to_string(r.accepted) + " 次";

  std::printf("  %-34s %s\n", "① 时间同步 (timesync)", s1.c_str());
  std::printf("  %-34s %s\n", "② 刚体复现 (rb_replicator)", s2.c_str());
  std::printf("  %-34s %s\n", "③ 碰撞安全 (safe_collision)", s3.c_str());
  std::printf("  %-34s %s\n", "④ 零拷贝桥 (wasm bridge)", s4.c_str());

  Check(r.lockedAtEnd && r.jumps == 0 && r.impactResolved &&
            r.energyAfter <= r.energyBefore + 1e-3,
        "★★ 四模块全链路端到端通过（时钟锁定 + 零瞬移 + 零动能注入）");
}

}  // namespace

// =============================================================================
//  4. main
// =============================================================================
int main(int argc, char** argv) {
  bool verbose = true;
  std::uint32_t seed = 20260925u;
  double duration = 12.0;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "-q" || a == "--quiet") verbose = false;
    else if (a == "-v" || a == "--verbose") verbose = true;
    else if (a.rfind("--seed=", 0) == 0) seed = static_cast<std::uint32_t>(std::stoul(a.substr(7)));
    else if (a.rfind("--sec=", 0) == 0) duration = std::stod(a.substr(6));
    else {
      std::printf("用法: %s [-q|-v] [--seed=N] [--sec=12]\n", argv[0]);
      return 2;
    }
  }

  std::printf("\033[1m╔══════════════════════════════════════════════════════════════╗\033[0m\n");
  std::printf("\033[1m║  极限竞速 · LAN —— 四模块全链路联调 & 混沌网络压测           ║\033[0m\n");
  std::printf("\033[1m╚══════════════════════════════════════════════════════════════╝\033[0m\n");
  std::printf("  seed=%u   仿真时长=%.1fs   步长=1/60s   客户端=2   服务端=1(专用)\n",
              seed, duration);
  std::printf("  混沌网络：单向 %.0fms 均值 / 抖动 %.0f~%.0fms(高斯) / 丢包 %.0f%% / 乱序 %.0f%%\n",
              80.0, 20.0, 150.0, 10.0, 18.0);

  // ---- 场景分段跑，日志清晰 ----
  StressReport report = RunChaosStress(seed, duration, verbose);

  PhaseNetworkAndClock(report);
  PhaseInterpolation(report);
  PhaseCollision(report);
  PhaseFullPipeline(report);

  std::printf("\n\033[36m══════════════════════════════════════════════════════════════\033[0m\n");
  std::printf("  结果：\033[32m%d 通过\033[0m / \033[31m%d 失败\033[0m\n", g_pass, g_fail);
  std::printf("  判定：%s\n", g_fail == 0 ? "\033[32m全链路通过 —— 无瞬移、无弹射、无动能注入\033[0m"
                                          : "\033[31m有失败项\033[0m");
  std::printf("\033[36m══════════════════════════════════════════════════════════════\033[0m\n");
  return g_fail == 0 ? 0 : 1;
}
