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
