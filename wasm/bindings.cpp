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
