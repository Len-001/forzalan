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
