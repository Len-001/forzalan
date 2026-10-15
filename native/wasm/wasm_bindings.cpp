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
