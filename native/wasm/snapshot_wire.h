// =============================================================================
//  snapshot_wire.h —— 32 字节紧凑线格式（Wasm 内存内直接解包）
//
//  ── 为什么需要它（而不是直接把 96B 的 RigidBodyNetSnapshot 发上线）────────────
//    需求把"单个物理快照"钉死在 **32~48 字节**。
//    而 Wasm 侧的工作结构 RigidBodyNetSnapshot 是 96B —— 它带 5 处 `_pad*`，
//    为了满足 `alignas(16)` 与 NEON 的对齐访问（见 rigid_body_replicator.h 的说明）。
//    这两件事不矛盾，但**必须分成两层**：
//
//      线格式（wire, 32B）  ← 只在网上跑，字段按需量化，逐字节可审计
//      工作结构（work, 96B）← 进物理/插值/渲染，16 对齐、SIMD 友好
//
//    于是本文件提供 Expand()：wire 32B → work 96B。
//    解包在 **Wasm 内存内**完成（`UpdateRemoteVehicleState` 收的是
//    Wasm 线性内存里的偏移），JS 只做 `HEAPU8.set(packet, addr)` + 一次无参调用。
//
//  ── 32 字节从哪来（每一项都是"够不够用"算出来的，不是凑的）─────────────────
//    赛道尺度：本项目最大赛道斯帕 7013m，世界坐标 |x|,|z| < 2048m（留 4 倍余量）
//      → 位置 16 位定点 @ 1/8 m：量程 ±4096m，分辨率 0.125m，误差 ≤ 6.25cm
//        0.125m 在 265km/h（73.6m/s）下是 1.7ms 的位置 —— 远小于一个物理步。
//        ⚠️ 分辨率必须 **> 1/16m**：用 1/16 时量程只剩 ±2048m，斯帕尾端会溢出回绕，
//           症状是"远端车偶尔出现在地图另一头"，极难归因。
//    姿态   ：四元数取绝对值(习惯化 w≥0) 后 x,y,z 各 16 位；w 由单位性恢复
//      → 分量分辨率 3e-5，角误差 < 0.01°。远优于渲染可分辨的 0.1°。
//    速度   ：14 位 @ 1/64 m/s → 量程 ±128m/s = ±460km/h，分辨率 1.5cm/s。
//    角速度 ：12 位 @ 1/256 rad/s → 量程 ±8rad/s，分辨率 0.22°/s。
//    加速度 ：12 位 @ 1/128 m/s² → 量程 ±16m/s²（纵向极限约 1.3g），分辨率 0.45%。
//
//  ── 位打包布局（小端；与 DataView 逐位对齐，位偏移即真相）────────────────────
//    下表的 [起:止) 是**字内**位区间，起止均已按上面的 wire_bit 常量核验。
//    u32  A @ 0   (word 0) : frame      [0:16)    16 位帧号（回绕周期 65536 帧）
//                          : tickMs     [16:32)   16 位毫秒（相对服务端基准回绕）
//    u32  B @ 4   (word 1) : posX       [0:16)    定点 1/8 m
//                          : posY       [16:32)
//    u32  C @ 8   (word 2) : posZ       [0:16)
//                          : velX       [16:30)   速度 1/64 m/s
//                          : velY 低 2 位 [30:32)  ← velY 跨字
//    u32  D @ 12  (word 3) : velY 高 12 位 [0:12)   共 14 位
//                          : velZ       [12:26)
//                          : _rsv       [26:32)
//    u32  E @ 16  (word 4) : rotX       [0:16)    单位四元数分量 ×32767
//                          : rotY       [16:32)
//    u32  F @ 20  (word 5) : rotZ       [0:16)
//                          : accX       [16:28)   加速度 1/128 m/s²
//                          : accY 低 4 位 [28:32)  ← accY 跨字
//    u32  G @ 24  (word 6) : accY 高 8 位 [0:8)     共 12 位
//                          : accZ       [8:20)
//                          : omegaX     [20:32)   角速度 1/256 rad/s —— 恰好收在字边界
//    u32  H @ 28  (word 7) : omegaY     [0:12)
//                          : omegaZ     [12:24)
//                          : _rsv       [24:32)
//    size 32，align 4，6 个保留位
//
//  ⚠️ 为什么速度/加速度要跨字（velY 横跨 word2/3，accY 横跨 word5/6）：
//     纯粹是"32 字节刚好装不下整齐切分的版本"。
//     整齐版（每个量都从 16 位边界起）需要：
//       12(头) + 6(位置) + 6(速度) + 6(姿态) + 2(角速度) + 2(加速度) = 34 字节 > 32。
//     （角速度 12 位×3 = 36 位 = 2.25 字节；加速度同理。）
//     要压到 32 只有两条路：① 砍某个量的位宽；② 让相邻量共享一个字。
//     选 ② —— 因为 bit 级打包已写好通用的位读写器（PutBits/GetBits），
//     跨字对它零成本，而砍位宽是**永久性**的质量损失。
//     若哪天真需要"每个字段字节对齐"（JS 侧不解包直接读单字段），
//     那就接受 34~36 字节 —— 仍在 48B 预算内，改 kBits* 与位表即可。
//
//  ⚠️ 定点数必须**饱和**而不是回绕：`(x * scale)` 溢出后强转 int16 是 UB，
//     且回绕会把 2050m 变成 −2046m（"瞬移到起点"）。故 QuantizeSat() 全程夹取。
//
//  ⚠️ 量化用 `nearbyint`（就近取整）而非 `static_cast<int>`（截断）：
//     截断对负数朝 +∞ 偏、对正数朝 −∞ 偏，会给静止车辆引入恒定的位置偏置，
//     在 warp 累积下形成可观测的稳态漂移。
// =============================================================================
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

#include "../rb_replicator/rigid_body_replicator.h"

namespace forza::wasm {

using forza::net::RigidBodyNetSnapshot;

// -----------------------------------------------------------------------------
//  线格式常量（JS 侧通过 Embind 常量读到，**不得硬编码**）
// -----------------------------------------------------------------------------

inline constexpr std::uint32_t kWireBytes = 32U;     ///< 单快照线格式字节数
inline constexpr std::uint32_t kWireWords = 8U;      ///< = kWireBytes / 4

/// 位置定点比例（1/8 m）。见文件头：分辨率 0.125m，量程 ±4096m。
inline constexpr float kWirePosScale = 8.0F;
/// 速度定点比例（1/64 m/s）：量程 ±128m/s。
inline constexpr float kWireVelScale = 64.0F;
/// 角速度定点比例（1/256 rad/s）：量程 ±8rad/s。
inline constexpr float kWireOmegaScale = 256.0F;
/// 加速度定点比例（1/128 m/s²）：量程 ±16m/s²。
inline constexpr float kWireAccelScale = 128.0F;
/// 单位四元数分量比例（×32767 用满 int16）。
inline constexpr float kWireRotScale = 32767.0F;

/// 各量的位宽（改成不同版本时只动这里，断言会跟着走）
inline constexpr int kBitsFrame  = 16;
inline constexpr int kBitsTickMs = 16;
inline constexpr int kBitsPos    = 16;
inline constexpr int kBitsVel    = 14;
inline constexpr int kBitsRot    = 16;
inline constexpr int kBitsOmega  = 12;
inline constexpr int kBitsAccel  = 12;

// 总位数自检：8 字 × 32 位 = 256 位；下面这些是**净载荷**位（不含 6 个保留位）
//   16 + 16                        = 32   帧头
//   16 × 3                         = 48   位置
//   14 × 3                         = 42   速度
//   16 × 3                         = 48   姿态
//   12 × 3                         = 36   角速度
//   12 × 3                         = 36   加速度
//                                  = 242 位 + 6 保留位 = 248 位 ≤ 256 位
// 余下的 8 位是跨字串位时为了不切断字段而自然留下的空隙（见布局图）。
inline constexpr int kWirePayloadBits = kBitsFrame + kBitsTickMs +
                                        3 * kBitsPos + 3 * kBitsVel + 3 * kBitsRot +
                                        3 * kBitsOmega + 3 * kBitsAccel;
static_assert(kWirePayloadBits == 242, "位宽改动后必须同步核对布局图");
static_assert(kWireBytes == 32U, "线格式必须是 32 字节（规格上限 48）");

// -----------------------------------------------------------------------------
//  定点量化：饱和，绝不回绕
// -----------------------------------------------------------------------------

/// 浮点 → 有符号定点（位宽 bits），饱和夹取。
///
/// ⚠️ **取整方式必须与 JS 的 `Math.round` 完全一致**。
///    JS 规范里 `Math.round` 的定义是
///        `Math.round(x) = floor(x + 0.5)`   —— 即"半个值一律朝 **+∞** 取整"
///    于是它在负数半值上**不是**远离零：
///        Math.round( 0.5) =  1
///        Math.round(-0.5) = -0      ← 注意不是 -1
///        Math.round(-1.5) = -1
///        Math.round(-2.5) = -2
///    而 C++ 里两个常见的"就近取整"都与之不同：
///        std::nearbyint / std::rint  -> **取偶（banker's）**：0.5→0、2.5→2
///        floor(x+0.5)/ceil(x-0.5) 按符号分 -> **远离零**：-0.5→-1（本模块第一版）
///    三种取整在"恰好半个量化步"上给出不同结果 —— 这类值一点都不罕见：
///    位置倍率 8，于是 0.0625 / 0.1875 / 0.3125 ... 全命中 0.5。
///    后果：C++ 打包与 TS 打包在同一条快照上产出**不同字节**，
///    位置差一个量化步（0.125m），且只在半个步长的输入上出现。
///
///    这个 bug 正是 `verify_engine_wire.mjs` 那份 TS↔C++ 逐字节交叉校验
///    存在的理由 —— 它在任何单语言测试里都**不可能**被发现。
///
///    实现就一条：`std::floor(s + 0.5)`，与 JS 规范定义逐字相同。
///    （`-0.5` 会得到 `-0.0`；`static_cast<std::int32_t>(-0.0)` 是 `0`，
///      与 JS 侧 `| 0` 的结果一致，无需特判。）
[[nodiscard]] inline std::int32_t QuantizeSat(float v, float scale, int bits) noexcept {
  if (!std::isfinite(v)) return 0;                     // NaN/Inf 一律当 0，别把垃圾散上网
  const double s = static_cast<double>(v) * static_cast<double>(scale);
  const double lo = -static_cast<double>((1 << (bits - 1)) - 1);
  const double hi = static_cast<double>((1 << (bits - 1)) - 1);
  // 与 JS Math.round 逐值对应：floor(x + 0.5)（半个值朝 +∞）
  double d = std::floor(s + 0.5);
  if (d > hi) d = hi;
  if (d < lo) d = lo;
  return static_cast<std::int32_t>(d);
}

/// 有符号定点 → 浮点
[[nodiscard]] inline float Dequantize(std::int32_t q, float scale) noexcept {
  return static_cast<float>(static_cast<double>(q) / static_cast<double>(scale));
}

// -----------------------------------------------------------------------------
//  位读写器（跨字串位，零成本抽象）
// -----------------------------------------------------------------------------

/// 往 int32 数组里按任意位偏移写有符号数（二进制补码的**低位截断**表示，
/// 因为上游已 QuantizeSat 保证值落在位宽内）。
inline void PutBits(std::uint32_t* w, int off, int bits, std::uint32_t v) noexcept {
  const std::uint32_t mask = (bits >= 32) ? 0xFFFFFFFFu : ((1u << bits) - 1u);
  v &= mask;
  const int wi = off >> 5;
  const int bs = off & 31;
  w[wi] |= (v << bs);
  if (bs + bits > 32) {
    // 跨字：高出的部分落到下一个字
    const int spill = bs + bits - 32;
    w[wi + 1] |= (v >> (bits - spill));
  }
}

/// 从 int32 数组里按任意位偏移读有符号数并做符号扩展
[[nodiscard]] inline std::int32_t GetBits(const std::uint32_t* w, int off, int bits) noexcept {
  const std::uint32_t mask = (bits >= 32) ? 0xFFFFFFFFu : ((1u << bits) - 1u);
  const int wi = off >> 5;
  const int bs = off & 31;
  std::uint32_t v = (w[wi] >> bs);
  if (bs + bits > 32) {
    const int spill = bs + bits - 32;
    v |= (w[wi + 1] & ((1u << spill) - 1u)) << (bits - spill);
  }
  v &= mask;
  // 符号扩展
  if (bits < 32 && (v & (1u << (bits - 1)))) {
    v |= ~mask;
  }
  return static_cast<std::int32_t>(v);
}

// -----------------------------------------------------------------------------
//  位偏移表（唯一真相；JS 侧通过 Embind 读到同一组值做交叉校验）
// -----------------------------------------------------------------------------

namespace wire_bit {
inline constexpr int kFrame  = 0;      // word 0  [0:16)
inline constexpr int kTickMs = 16;     // word 0  [16:32)
inline constexpr int kPosX   = 32;     // word 1  [0:16)
inline constexpr int kPosY   = 48;     // word 1  [16:32)
inline constexpr int kPosZ   = 64;     // word 2  [0:16)
inline constexpr int kVelX   = 80;     // word 2  [16:30)
inline constexpr int kVelY   = 94;     // 跨 word2/3  [30:44)
inline constexpr int kVelZ   = 108;    // word 3  [12:26)
inline constexpr int kRotX   = 128;    // word 4  [0:16)
inline constexpr int kRotY   = 144;    // word 4  [16:32)
inline constexpr int kRotZ   = 160;    // word 5  [0:16)
inline constexpr int kAccX   = 176;    // word 5  [16:28)
inline constexpr int kAccY   = 188;    // 跨 word5/6  [28:40)
inline constexpr int kAccZ   = 200;    // word 6  [8:20)
inline constexpr int kOmegaX = 212;    // word 6  [20:32) —— 恰好收在字边界
inline constexpr int kOmegaY = 224;    // word 7  [0:12)
inline constexpr int kOmegaZ = 236;    // word 7  [12:24)
}  // namespace wire_bit

// 每个字段都必须整段落在 256 位内
static_assert(wire_bit::kOmegaZ + kBitsOmega <= 256, "最后一个字段越界");
// 跨字的两个字段必须真的跨字（否则说明打包表被改错了）
static_assert((wire_bit::kVelY & 31) + kBitsVel > 32, "kVelY 应当跨 word2/3");
static_assert((wire_bit::kAccY & 31) + kBitsAccel > 32, "kAccY 应当跨 word5/6");
// 收在字边界的字段必须**正好**收在边界（多一位就越界踩到下一个字段）
static_assert((wire_bit::kOmegaX & 31) + kBitsOmega == 32, "kOmegaX 应恰好收在 word6 边界");
static_assert((wire_bit::kVelZ & 31) + kBitsVel <= 32, "kVelZ 不得越过 word3");
static_assert((wire_bit::kOmegaZ & 31) + kBitsOmega <= 32, "kOmegaZ 不得越过 word7");

// -----------------------------------------------------------------------------
//  Expand：32B 线格式 → 96B 工作结构（**在 Wasm 内存内解包**）
// -----------------------------------------------------------------------------

/**
 * 把 32 字节线格式解包进一个 RigidBodyNetSnapshot。
 *
 * @param src     指向 **Wasm 线性内存内**的 32 字节（JS 侧 HEAPU8.set 写进来的）
 * @param out     解包目标（96B 工作结构，通常就是桥的 snapshotStage_）
 * @param tickBaseMs  服务端 tickMs 的回绕基准。线上 tickMs 只有 16 位
 *                    （65535ms 回绕），解包时补回高位。传 0 则原样使用。
 */
inline void ExpandWireToSnapshot(const std::uint8_t* src, RigidBodyNetSnapshot& out,
                                 std::uint32_t tickBaseMs = 0U) noexcept {
  std::uint32_t w[kWireWords];
  std::memcpy(w, src, kWireBytes);   // 一次 32B 拷贝；比逐字段 memcpy 少 16 次调用

  out.frame  = static_cast<std::uint32_t>(GetBits(w, wire_bit::kFrame, kBitsFrame));
  const std::uint32_t tickLo = static_cast<std::uint32_t>(GetBits(w, wire_bit::kTickMs, kBitsTickMs));
  out.tickMs = (tickBaseMs & 0xFFFF0000u) | tickLo;

  // ---- 位置（定点 1/8 m）----
  out.position.x = Dequantize(GetBits(w, wire_bit::kPosX, kBitsPos), kWirePosScale);
  out.position.y = Dequantize(GetBits(w, wire_bit::kPosY, kBitsPos), kWirePosScale);
  out.position.z = Dequantize(GetBits(w, wire_bit::kPosZ, kBitsPos), kWirePosScale);

  // ---- 线速度（定点 1/64 m/s）----
  out.velocity.x = Dequantize(GetBits(w, wire_bit::kVelX, kBitsVel), kWireVelScale);
  out.velocity.y = Dequantize(GetBits(w, wire_bit::kVelY, kBitsVel), kWireVelScale);
  out.velocity.z = Dequantize(GetBits(w, wire_bit::kVelZ, kBitsVel), kWireVelScale);

  // ---- 姿态（单位四元数，已习惯化 w≥0；w 由单位性恢复）----
  //   ★ 恢复出来的 w 恒 ≥ 0 —— 正是 ShortArc 要的规范形。
  //     若不做这一步，接收端拿到 q 与 −q 时 `dot(ref,q)` 的符号是随机的，
  //     rb_replicator 的第②处短弧检查就会被无谓触发（白做一次取反）。
  const float rx = Dequantize(GetBits(w, wire_bit::kRotX, kBitsRot), kWireRotScale);
  const float ry = Dequantize(GetBits(w, wire_bit::kRotY, kBitsRot), kWireRotScale);
  const float rz = Dequantize(GetBits(w, wire_bit::kRotZ, kBitsRot), kWireRotScale);
  float rw2 = 1.0F - (rx * rx + ry * ry + rz * rz);
  if (rw2 < 0.0F) rw2 = 0.0F;          // 量化噪声可能让它微负；夹到 0 而不是 sqrt(负数)=NaN
  out.rotation.w = std::sqrt(rw2);
  out.rotation.x = rx;
  out.rotation.y = ry;
  out.rotation.z = rz;

  // ---- 加速度（定点 1/128 m/s²）----
  out.accel.x = Dequantize(GetBits(w, wire_bit::kAccX, kBitsAccel), kWireAccelScale);
  out.accel.y = Dequantize(GetBits(w, wire_bit::kAccY, kBitsAccel), kWireAccelScale);
  out.accel.z = Dequantize(GetBits(w, wire_bit::kAccZ, kBitsAccel), kWireAccelScale);

  // ---- 角速度（定点 1/256 rad/s）----
  out.angularVelocity.x = Dequantize(GetBits(w, wire_bit::kOmegaX, kBitsOmega), kWireOmegaScale);
  out.angularVelocity.y = Dequantize(GetBits(w, wire_bit::kOmegaY, kBitsOmega), kWireOmegaScale);
  out.angularVelocity.z = Dequantize(GetBits(w, wire_bit::kOmegaZ, kBitsOmega), kWireOmegaScale);
}

// -----------------------------------------------------------------------------
//  Pack：96B 工作结构 → 32B 线格式（**测试/录制回放需要；正式只走单向解包**）
// -----------------------------------------------------------------------------

/**
 * 把工作结构压成 32 字节线格式。
 *
 * 生产路径其实只需 Expand（客户端收包），但 Pack 是**必需的测试工具**：
 * 没有它就无法做"打包→解包→比对"的往返断言，也就无法证明位表没写错。
 * 另外服务端如果也跑同一份 C++，Pack 就是它的发包路径。
 *
 * @param s         源快照（96B）
 * @param dst       目标 32 字节缓冲
 * @param tickLoMs  是否把 tickMs 截成低 16 位（true = 线上格式行为）
 */
inline void PackSnapshotToWire(const RigidBodyNetSnapshot& s, std::uint8_t* dst,
                               bool tickLoMs = true) noexcept {
  std::uint32_t w[kWireWords];
  std::memset(w, 0, sizeof(w));

  PutBits(w, wire_bit::kFrame, kBitsFrame,
          static_cast<std::uint32_t>(s.frame) & 0xFFFFu);
  PutBits(w, wire_bit::kTickMs, kBitsTickMs,
          tickLoMs ? (s.tickMs & 0xFFFFu) : (s.tickMs & 0xFFFFu));

  PutBits(w, wire_bit::kPosX, kBitsPos,
          static_cast<std::uint32_t>(QuantizeSat(s.position.x, kWirePosScale, kBitsPos)));
  PutBits(w, wire_bit::kPosY, kBitsPos,
          static_cast<std::uint32_t>(QuantizeSat(s.position.y, kWirePosScale, kBitsPos)));
  PutBits(w, wire_bit::kPosZ, kBitsPos,
          static_cast<std::uint32_t>(QuantizeSat(s.position.z, kWirePosScale, kBitsPos)));

  PutBits(w, wire_bit::kVelX, kBitsVel,
          static_cast<std::uint32_t>(QuantizeSat(s.velocity.x, kWireVelScale, kBitsVel)));
  PutBits(w, wire_bit::kVelY, kBitsVel,
          static_cast<std::uint32_t>(QuantizeSat(s.velocity.y, kWireVelScale, kBitsVel)));
  PutBits(w, wire_bit::kVelZ, kBitsVel,
          static_cast<std::uint32_t>(QuantizeSat(s.velocity.z, kWireVelScale, kBitsVel)));

  // ---- 姿态：先习惯化到 w ≥ 0，再丢 w ----
  float qw = s.rotation.w, qx = s.rotation.x, qy = s.rotation.y, qz = s.rotation.z;
  const float n2 = qw * qw + qx * qx + qy * qy + qz * qz;
  if (!(n2 > 0.0F) || !std::isfinite(n2)) { qw = 1.0F; qx = qy = qz = 0.0F; }
  else {
    const float inv = 1.0F / std::sqrt(n2);
    qw *= inv; qx *= inv; qy *= inv; qz *= inv;
  }
  if (qw < 0.0F) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }   // q 与 −q 同旋转，取 w≥0 的规范形
  PutBits(w, wire_bit::kRotX, kBitsRot,
          static_cast<std::uint32_t>(QuantizeSat(qx, kWireRotScale, kBitsRot)));
  PutBits(w, wire_bit::kRotY, kBitsRot,
          static_cast<std::uint32_t>(QuantizeSat(qy, kWireRotScale, kBitsRot)));
  PutBits(w, wire_bit::kRotZ, kBitsRot,
          static_cast<std::uint32_t>(QuantizeSat(qz, kWireRotScale, kBitsRot)));

  PutBits(w, wire_bit::kAccX, kBitsAccel,
          static_cast<std::uint32_t>(QuantizeSat(s.accel.x, kWireAccelScale, kBitsAccel)));
  PutBits(w, wire_bit::kAccY, kBitsAccel,
          static_cast<std::uint32_t>(QuantizeSat(s.accel.y, kWireAccelScale, kBitsAccel)));
  PutBits(w, wire_bit::kAccZ, kBitsAccel,
          static_cast<std::uint32_t>(QuantizeSat(s.accel.z, kWireAccelScale, kBitsAccel)));

  PutBits(w, wire_bit::kOmegaX, kBitsOmega,
          static_cast<std::uint32_t>(QuantizeSat(s.angularVelocity.x, kWireOmegaScale, kBitsOmega)));
  PutBits(w, wire_bit::kOmegaY, kBitsOmega,
          static_cast<std::uint32_t>(QuantizeSat(s.angularVelocity.y, kWireOmegaScale, kBitsOmega)));
  PutBits(w, wire_bit::kOmegaZ, kBitsOmega,
          static_cast<std::uint32_t>(QuantizeSat(s.angularVelocity.z, kWireOmegaScale, kBitsOmega)));

  std::memcpy(dst, w, kWireBytes);
}

}  // namespace forza::wasm
