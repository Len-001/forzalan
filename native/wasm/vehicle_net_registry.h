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
