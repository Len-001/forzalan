// =============================================================================
//  wasm_bindings_test.cpp —— 32B 线格式 + 多车注册表 + HUD 文本的原生断言
//
//  两种运行模式：
//    ./bridge_test.exe               跑全部断言（默认）
//    ./bridge_test.exe --dump-wire   把位表 + 一批"输入/32字节输出"写到
//                                    wire_dump.json，供 verify_engine_wire.mjs
//                                    做 TS↔C++ 的逐字节交叉校验
//
//  为什么要有 dump 模式：
//    前端 NetworkEngine.ts 里有一份**独立的 JS 位打包实现**（为了省掉发包时
//    的 Wasm 往返）。两个实现只要有一位不一致，症状就是"某些车的位置偶尔
//    乱飘"，而且**只在对端是本机 C++ 时出现** —— JS↔JS 自测永远发现不了。
//    所以必须把 C++ 真值 dump 出来，让 TS 侧对同一批输入打包后逐字节比。
// =============================================================================

#include <cmath>
#include <cstdio>
#include <cstring>

#include "snapshot_wire.h"
#include "vehicle_net_registry.h"

using namespace forza::wasm;
using forza::net::RigidBodyNetSnapshot;
using forza::race::DeltaCarState;
using forza::race::DeltaMethod;

namespace {

int g_pass = 0;
int g_fail = 0;

void Check(bool cond, const char* what) {
  if (cond) {
    ++g_pass;
  } else {
    ++g_fail;
    std::printf("  [FAIL] %s\n", what);
  }
}

bool Near(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

// -----------------------------------------------------------------------------
//  W1. 线格式尺寸与位表自洽
// -----------------------------------------------------------------------------
void TestWireLayout() {
  std::printf("W1 线格式尺寸与位表\n");
  Check(kWireBytes == 32U, "线格式 32 字节（规格上限 48）");
  Check(kWireWords == 8U, "8 个 32 位字");
  Check(kWirePayloadBits == 242, "净载荷 242 位");
  // 8 字 = 256 位 ≥ 242 位，且有 6 个保留位 + 8 位对齐空隙
  Check(kWirePayloadBits <= 256, "载荷必须装进 256 位");
  // 字段不重叠：相邻字段的起始位 >= 前一个字段的结束位
  Check(wire_bit::kFrame + kBitsFrame <= wire_bit::kTickMs, "frame/tickMs 不重叠");
  Check(wire_bit::kPosX + kBitsPos <= wire_bit::kPosY, "posX/posY 不重叠");
  Check(wire_bit::kOmegaZ + kBitsOmega <= 256,
        "最后一个字段（omegaZ）不越界");
}

// -----------------------------------------------------------------------------
//  W2. 定点量化：饱和而非回绕
// -----------------------------------------------------------------------------
void TestQuantizeSaturation() {
  std::printf("W2 定点量化饱和\n");
  const int max16 = (1 << 15) - 1;
  // 远超量程 -> 饱和到上限，**不是**回绕成负数
  Check(QuantizeSat(1e6F, kWirePosScale, 16) == max16, "超大正数饱和到 +32767");
  Check(QuantizeSat(-1e6F, kWirePosScale, 16) == -max16, "超大负数饱和到 -32767");
  // 量程内正常取整
  Check(QuantizeSat(1.0F, kWirePosScale, 16) == 8, "1.0m -> 8（1/8m 定点）");
  // ★ 取整方式必须与 JS 的 `Math.round` 逐值一致：floor(x+0.5)（半个值朝 +∞）。
  //   ⚠️ 负数半值**不是**远离零 —— 这是最容易写错的一处：
  //        JS: Math.round(-0.5) = -0（不是 -1）, Math.round(-2.5) = -2
  //        nearbyint(取偶):  0.5 -> 0
  //        away-from-zero:  -0.5 -> -1
  //      位置倍率 8 → 0.0625/0.1875/0.3125 全命中 0.5，所以这不是理论边角。
  Check(QuantizeSat(0.0625F, kWirePosScale, 16) == 1, " 0.5 步长 ->  1（近零半值朝 +∞）");
  Check(QuantizeSat(-0.0625F, kWirePosScale, 16) == 0, "-0.5 步长 ->  0（**不是** -1，与 JS Math.round 一致）");
  Check(QuantizeSat(0.3125F, kWirePosScale, 16) == 3, " 2.5 步长 ->  3");
  Check(QuantizeSat(-0.1875F, kWirePosScale, 16) == -1, "-1.5 步长 -> -1");
  Check(QuantizeSat(-0.3125F, kWirePosScale, 16) == -2, "-2.5 步长 -> -2（取偶会给 -2，两者同值）");
  Check(QuantizeSat(0.1875F, kWirePosScale, 16) == 2, " 1.5 步长 ->  2");
  // ★ 就近取整（不是截断）
  Check(QuantizeSat(0.07F, kWirePosScale, 16) == 1, "0.07m 就近取整为 1 而非截断为 0");
  // -0.07 × 8 = -0.56 -> floor(-0.56+0.5)=floor(-0.06) = -1（与 Math.round(-0.56) 一致）
  Check(QuantizeSat(-0.07F, kWirePosScale, 16) == -1, "-0.07m 就近取整为 -1（与 JS 一致）");
  // NaN/Inf 归零（绝不把垃圾散上网）
  Check(QuantizeSat(std::nanf(""), kWirePosScale, 16) == 0, "NaN -> 0");
  Check(QuantizeSat(INFINITY, kWirePosScale, 16) == 0, "Inf -> 0");
}

// -----------------------------------------------------------------------------
//  W3. 位读写器跨字正确性
// -----------------------------------------------------------------------------
void TestBitIO() {
  std::printf("W3 位读写器（跨字）\n");
  std::uint32_t w[kWireWords];
  std::memset(w, 0, sizeof(w));

  // 不跨字写读
  PutBits(w, 0, 16, 1234);
  Check(GetBits(w, 0, 16) == 1234, "16 位不跨字往返");
  PutBits(w, 16, 16, 5678);
  Check(GetBits(w, 16, 16) == 5678, "第二个 16 位字段");
  Check(GetBits(w, 0, 16) == 1234, "写第二个字段不影响第一个");

  // 跨字写读（velY @ bit 94，14 位，跨 word2/3）
  // ⚠️ 14 位**有符号**量程是 [-8192, 8191] —— 写 12345 会溢出（这正是
  //    QuantizeSat 存在的理由）。这里测的是位读写器本身，所以要给合法值。
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kVelY, kBitsVel, 8191);
  Check(GetBits(w, wire_bit::kVelY, kBitsVel) == 8191, "14 位跨字往返（正上限 8191）");
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kVelY, kBitsVel, static_cast<std::uint32_t>(-8192));
  Check(GetBits(w, wire_bit::kVelY, kBitsVel) == -8192, "14 位跨字往返（负下限 -8192）");
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kVelY, kBitsVel, 4096);
  Check(GetBits(w, wire_bit::kVelY, kBitsVel) == 4096, "14 位跨字往返（中间值）");

  // 符号扩展边界：-1 在 12 位里
  std::memset(w, 0, sizeof(w));
  PutBits(w, wire_bit::kAccY, kBitsAccel, static_cast<std::uint32_t>(-1));
  Check(GetBits(w, wire_bit::kAccY, kBitsAccel) == -1, "12 位跨字 -1 符号扩展正确");
}

// -----------------------------------------------------------------------------
//  W4. 打包 -> 解包往返（覆盖量程内的各种值）
// -----------------------------------------------------------------------------
void TestRoundTrip() {
  std::printf("W4 打包/解包往返\n");
  RigidBodyNetSnapshot s{};
  s.frame = 4000000123u & 0xFFFFu;      // 帧号低 16 位
  s.tickMs = 123456u & 0xFFFFu;
  s.position = {1234.5F, -67.25F, -1987.75F};
  s.rotation = {0.5F, 0.5F, 0.5F, 0.5F};   // 单位四元数（w,x,y,z）
  s.velocity = {72.5F, -3.25F, 12.75F};
  s.angularVelocity = {0.5F, -1.25F, 3.0F};
  s.accel = {8.5F, -9.5F, 2.25F};

  std::uint8_t buf[kWireBytes];
  PackSnapshotToWire(s, buf, true);
  RigidBodyNetSnapshot o{};
  ExpandWireToSnapshot(buf, o, 0U);

  Check(o.frame == (s.frame & 0xFFFFu), "帧号往返");
  // ★ 位置容差必须按**半个量化步长**给：1/8 m 定点 → 最大误差 1/16 = 0.0625m
  const double posTol = 0.5 / kWirePosScale + 1e-4;
  Check(Near(o.position.x, s.position.x, posTol), "posX 误差 ≤ 半个量化步");
  Check(Near(o.position.y, s.position.y, posTol), "posY 误差 ≤ 半个量化步");
  Check(Near(o.position.z, s.position.z, posTol), "posZ 误差 ≤ 半个量化步");

  const double velTol = 0.5 / kWireVelScale + 1e-4;
  Check(Near(o.velocity.x, s.velocity.x, velTol), "velX 误差 ≤ 半个量化步");
  Check(Near(o.velocity.y, s.velocity.y, velTol), "velY（跨字）误差 ≤ 半个量化步");
  Check(Near(o.velocity.z, s.velocity.z, velTol), "velZ 误差 ≤ 半个量化步");

  const double accTol = 0.5 / kWireAccelScale + 1e-4;
  Check(Near(o.accel.x, s.accel.x, accTol), "accX 误差 ≤ 半个量化步");
  Check(Near(o.accel.y, s.accel.y, accTol), "accY（跨字）误差 ≤ 半个量化步");
  Check(Near(o.accel.z, s.accel.z, accTol), "accZ 误差 ≤ 半个量化步");

  const double omgTol = 0.5 / kWireOmegaScale + 1e-4;
  Check(Near(o.angularVelocity.x, s.angularVelocity.x, omgTol), "omegaX 误差 ≤ 半个量化步");
  Check(Near(o.angularVelocity.y, s.angularVelocity.y, omgTol), "omegaY 误差 ≤ 半个量化步");
  Check(Near(o.angularVelocity.z, s.angularVelocity.z, omgTol), "omegaZ 误差 ≤ 半个量化步");

  // 四元数：w 由单位性恢复，必须为正且量级正确
  Check(o.rotation.w > 0.0F, "恢复的四元数 w > 0（ShortArc 规范形）");
  const double qn = static_cast<double>(o.rotation.w) * o.rotation.w +
                    static_cast<double>(o.rotation.x) * o.rotation.x +
                    static_cast<double>(o.rotation.y) * o.rotation.y +
                    static_cast<double>(o.rotation.z) * o.rotation.z;
  Check(Near(qn, 1.0, 0.01), "恢复的四元数几乎单位长度");
}

// -----------------------------------------------------------------------------
//  W5. 四元数习惯化：q 与 -q 必须产出**同一组**线上的 x,y,z
// -----------------------------------------------------------------------------
void TestQuatCanonicalization() {
  std::printf("W5 四元数习惯化（q 与 -q 等价）\n");
  RigidBodyNetSnapshot a{};
  a.rotation = {0.6F, -0.8F, 0.0F, 0.0F};     // w=0.6 > 0
  RigidBodyNetSnapshot b{};
  b.rotation = {-0.6F, 0.8F, 0.0F, 0.0F};     // 同一个旋转的另一半

  std::uint8_t ba[kWireBytes], bb[kWireBytes];
  PackSnapshotToWire(a, ba);
  PackSnapshotToWire(b, bb);
  // ★ 打包后必须**逐字节相同** —— 否则接收端会看到随机的符号，
  //   导致 rb_replicator 的第②处短弧检查被无谓触发。
  Check(std::memcmp(ba, bb, kWireBytes) == 0, "q 与 -q 打包结果逐字节相同");

  RigidBodyNetSnapshot oa{}, ob{};
  ExpandWireToSnapshot(ba, oa, 0U);
  ExpandWireToSnapshot(bb, ob, 0U);
  Check(oa.rotation.w > 0.0F && ob.rotation.w > 0.0F, "两者恢复的 w 都 > 0");
  Check(Near(oa.rotation.x, ob.rotation.x, 1e-6), "两者恢复的 x 相同");
}

// -----------------------------------------------------------------------------
//  W6. 高转速姿态：四元数分量接近 ±1 时仍可恢复
// -----------------------------------------------------------------------------
void TestQuatExtremes() {
  std::printf("W6 四元数极端姿态\n");
  // 180° 绕 X：q = (0, 1, 0, 0) —— w 恢复出来应接近 0
  RigidBodyNetSnapshot s{};
  s.rotation = {0.0F, 1.0F, 0.0F, 0.0F};
  std::uint8_t buf[kWireBytes];
  PackSnapshotToWire(s, buf);
  RigidBodyNetSnapshot o{};
  ExpandWireToSnapshot(buf, o, 0U);
  Check(Near(o.rotation.w, 0.0, 0.01), "180° 姿态 w≈0");
  Check(Near(o.rotation.x, 1.0, 0.01), "180° 姿态 x≈1");
  Check(std::isfinite(o.rotation.w), "w 不是 NaN（rw2<0 时夹到 0）");
}

// -----------------------------------------------------------------------------
//  W7. 多车槽管理：独立性 + 表满
// -----------------------------------------------------------------------------
void TestVehicleSlots() {
  std::printf("W7 多车槽管理\n");
  VehicleNetRegistry reg;
  Check(reg.Count() == 0U, "初始为空");
  Check(reg.LocalIndex() == -1, "初始无本地车");

  const int s0 = reg.EnsureVehicle(10, true);
  const int s1 = reg.EnsureVehicle(20, false);
  const int s2 = reg.EnsureVehicle(30, false);
  Check(s0 == 0 && s1 == 1 && s2 == 2, "顺序分配槽位");
  Check(reg.Count() == 3U, "计数 3");
  Check(reg.Find(20) == 1, "按 id 查找");
  Check(reg.Find(99) == -1, "不存在的 id 返回 -1");

  Check(reg.EnsureVehicle(20) == 1, "重复登记复用槽位（不新建）");
  Check(reg.Count() == 3U, "重复登记不增计数");

  // SetLocal 是 void：这里验证"切换本地车"的副作用（原本地被取消，新本地被标记）
  reg.SetLocal(2);
  Check(reg.LocalIndex() == 2, "切换本地车后索引更新");
  Check(reg.At(2)->isLocal, "新车标记为本地");
  Check(!reg.At(0)->isLocal, "原本地车标记被清除");
}

// -----------------------------------------------------------------------------
//  W8. 每车有**独立**的 replicator（防止"四辆车粘在一起抖"）
// -----------------------------------------------------------------------------
void TestVehicleIndependence() {
  std::printf("W8 每车副本独立性\n");
  VehicleNetRegistry reg;
  const int a = reg.EnsureVehicle(1);
  const int b = reg.EnsureVehicle(2);

  // 给两辆车喂不同的权威快照
  RigidBodyNetSnapshot sa{};
  sa.frame = 1; sa.position = {100.0F, 0.0F, 0.0F};
  RigidBodyNetSnapshot sb{};
  sb.frame = 1; sb.position = {-100.0F, 0.0F, 0.0F};

  reg.AtMutable(a)->remote.OnAuthoritativeSnapshot(sa);
  reg.AtMutable(b)->remote.OnAuthoritativeSnapshot(sb);
  reg.RefreshMatrices();

  // 矩阵的平移分量（列主序：索引 12/13/14）
  const double ax = reg.MatrixElement(a, 12);
  const double bx = reg.MatrixElement(b, 12);
  Check(Near(ax, 100.0, 1e-3), "A 车矩阵 x = +100");
  Check(Near(bx, -100.0, 1e-3), "B 车矩阵 x = -100");
  // ★ 核心断言：两辆车的位置**必须不同**。若共用 replicator，这里会相等。
  Check(std::fabs(ax - bx) > 1.0, "两车位置相互独立（未共用 replicator）");
}

// -----------------------------------------------------------------------------
//  W9. 帧号去重：旧包不能把新车拽回去
// -----------------------------------------------------------------------------
void TestFrameDedup() {
  std::printf("W9 帧号去重\n");
  VehicleNetRegistry reg;
  const int s = reg.EnsureVehicle(7);
  Check(reg.NoteSnapshotFrame(s, 100), "首帧接受");
  Check(reg.NoteSnapshotFrame(s, 101), "更新的帧接受");
  Check(!reg.NoteSnapshotFrame(s, 99), "旧帧被拒");
  Check(!reg.NoteSnapshotFrame(s, 101), "重复帧被拒");
  Check(reg.NoteSnapshotFrame(s, 102), "继续前进的帧接受");

  // uint32 回绕：0xFFFFFFFF -> 0 必须被认成"更新"
  VehicleNetRegistry reg2;
  const int s2 = reg2.EnsureVehicle(8);
  Check(reg2.NoteSnapshotFrame(s2, 0xFFFFFFFEu), "回绕前接受");
  Check(reg2.NoteSnapshotFrame(s2, 0xFFFFFFFFu), "接近回绕接受");
  Check(reg2.NoteSnapshotFrame(s2, 0u), "回绕到 0 被认成更新（无符号差值判据）");
}

// -----------------------------------------------------------------------------
//  W10. 远端车离场
// -----------------------------------------------------------------------------
void TestRemoveVehicle() {
  std::printf("W10 远端车离场\n");
  VehicleNetRegistry reg;
  reg.EnsureVehicle(1);
  reg.EnsureVehicle(2);
  reg.EnsureVehicle(3);
  Check(reg.RemoveVehicle(2), "移除存在的车");
  Check(!reg.RemoveVehicle(2), "重复移除返回 false");
  Check(reg.Count() == 2U, "计数降到 2");
  Check(reg.Find(2) == -1, "已移除的车查找失败");
  Check(reg.At(1) == nullptr, "已移除的槽为 null");
}

// -----------------------------------------------------------------------------
//  W11. 表满行为：必须拒绝，不能越界写
// -----------------------------------------------------------------------------
void TestTableFull() {
  std::printf("W11 槽位表满\n");
  VehicleNetRegistry reg;
  for (std::uint32_t i = 0; i < kMaxVehicles; ++i) {
    Check(reg.EnsureVehicle(1000 + i) >= 0, "槽位分配成功");
  }
  Check(reg.Count() == kMaxVehicles, "计数达到上限");
  Check(reg.EnsureVehicle(9999) == -1, "表满时返回 -1（拒绝而不是越界）");
  Check(reg.Count() == kMaxVehicles, "表满时计数不变");
}

// -----------------------------------------------------------------------------
//  W12. 计时塔排序 + 领跑者 "--" + 非领跑者负号
// -----------------------------------------------------------------------------
void TestLeaderboard() {
  std::printf("W12 计时塔排序与文本\n");
  VehicleNetRegistry reg;
  // 方形赛道：周长 400m，4 个 Checkpoint（每 100m 一个）
  static const double kCtl[4][2] = {
      {-50.0, -50.0}, {50.0, -50.0}, {50.0, 50.0}, {-50.0, 50.0}};
  static const double kCp[4] = {0.0, 100.0, 200.0, 300.0};
  Check(reg.SetTrack(kCtl, 4, kCp, 4), "装入方形测试赛道");
  Check(reg.TrackReady(), "赛道就绪");

  const double L = reg.TrackLength();
  // ⚠️ 这是**闭合 Catmull-Rom** 的弧长，不是多边形的 400m 周长：
  //    四个控制点的闭合样条会向外鼓（段间切线由邻居决定），实测 420.38m。
  //    本项目 race_delta 的 Python 镜像基线也记着 L ≈ 420.3797，两者一致。
  //    **不要把断言写成 400** —— 那是多边形周长，不是样条弧长。
  Check(L > 400.0 && L < 440.0, "闭合样条弧长在合理区间（> 多边形周长 400m）");

  // 三辆车：P1 在 s=200，P2 在 s=100，P3 在 s=50（同一圈）
  const int a = reg.EnsureVehicle(1, true);    // 本地 = P1
  const int b = reg.EnsureVehicle(2);
  const int c = reg.EnsureVehicle(3);
  const double t0 = 10.0;
  reg.UpdateProgress(a, 200.0, t0, 0, 1, 5.0);
  reg.UpdateProgress(b, 100.0, t0, 0, 0, 2.0);
  reg.UpdateProgress(c, 50.0, t0, 0, -1, 0.0);

  LeaderboardRow rows[kMaxVehicles];
  const std::uint32_t n = reg.BuildLeaderboard(rows, kMaxVehicles);
  Check(n == 3U, "三行");
  Check(rows[0].id == 1 && rows[0].position == 1, "P1 = 本地车（s 最大）");
  Check(rows[0].isLeader, "P1 标记为领跑者");
  Check(std::strcmp(rows[0].text, "--") == 0, "领跑者文本为 \"--\"");
  Check(rows[1].id == 2 && rows[2].id == 3, "P2/P3 顺序按进度");

  // ★ 后车文本必须以 '-' 开头（规格：落后统一负数格式）
  Check(rows[1].text[0] == '-', "P2 秒差文本以负号开头");
  Check(rows[2].text[0] == '-', "P3 秒差文本以负号开头");
  // 落后的量级：P3 比 P2 更落后 -> 数值绝对值更大
  const double d2 = std::fabs(std::atof(rows[1].text));
  const double d3 = std::fabs(std::atof(rows[2].text));
  Check(d3 > d2, "P3 落后幅度大于 P2");

  // 本地就是领跑者 -> 本地行 "--"
  char line[kDeltaTextCap];
  reg.FormatLocalVsLeader(line, kDeltaTextCap);
  Check(std::strcmp(line, "--") == 0, "本地为 P1 时本地行 \"--\"");
}

// -----------------------------------------------------------------------------
//  W13. 本地落后时的秒差符号（规格核心）
// -----------------------------------------------------------------------------
void TestLocalBehind() {
  std::printf("W13 本地落后的符号\n");
  VehicleNetRegistry reg;
  static const double kCtl[4][2] = {
      {-50.0, -50.0}, {50.0, -50.0}, {50.0, 50.0}, {-50.0, 50.0}};
  static const double kCp[4] = {0.0, 100.0, 200.0, 300.0};
  reg.SetTrack(kCtl, 4, kCp, 4);

  const int local = reg.EnsureVehicle(1, true);
  const int lead = reg.EnsureVehicle(2);
  const double t0 = 20.0;
  // 领跑者在 s=200，本地在 s=100（都过了 CP0）
  reg.UpdateProgress(lead, 200.0, t0, 0, 1, 8.0);
  reg.UpdateProgress(local, 100.0, t0, 0, 0, 6.0);

  // Solve(local, lead) 应 < 0（本地落后）
  const double ms = reg.Solve(1, 2).deltaMs;
  Check(ms < 0.0, "Solve(local, lead) < 0（本地落后为负）");
  // 反对称性
  const double ms2 = reg.Solve(2, 1).deltaMs;
  Check(Near(ms, -ms2, 1e-6), "Solve(a,b) == -Solve(b,a) 反对称");

  char line[kDeltaTextCap];
  reg.FormatLocalVsLeader(line, kDeltaTextCap);
  Check(line[0] == '-', "本地落后时文本以负号开头");
  Check(std::strcmp(line, "--") != 0, "本地落后时不是 \"--\"");

  // 用 CP 过线时刻的一级解：lead 在 CP1 的过线时刻 8.0，local 在 CP0 的 6.0
  // 公共 CP 是 CP0（lead=?, local=6.0）—— lead 的 CP0 没给，故退化到外推
  Check(reg.Solve(1, 2).valid(), "解算有效");
}

// -----------------------------------------------------------------------------
//  W14. 每车段速 EWMA（外推除数）
// -----------------------------------------------------------------------------
void TestSegSpeed() {
  std::printf("W14 每车段速 EWMA\n");
  VehicleNetRegistry reg;
  static const double kCtl[4][2] = {
      {-50.0, -50.0}, {50.0, -50.0}, {50.0, 50.0}, {-50.0, 50.0}};
  static const double kCp[1] = {0.0};
  reg.SetTrack(kCtl, 4, kCp, 1);
  const int a = reg.EnsureVehicle(1);

  // 以 30m/s 推进 60 步（每步 0.5m / 1/60s = 30m/s）
  double s = 0.0;
  double t = 0.0;
  for (int i = 0; i < 60; ++i) {
    s += 0.5;
    t += 1.0 / 60.0;
    reg.UpdateProgress(a, s, t, 0, -1, 0.0);
  }
  const double v = reg.At(a)->delta.segSpeedMps;
  // EWMA 从首个样本 30m/s 起步，恒速下应稳定在 30
  Check(v > 29.0 && v < 31.0, "恒速 30m/s 下段速估计收敛到 30");

  // 倒车（ds<0）不得被采纳为段速
  VehicleNetRegistry reg2;
  reg2.SetTrack(kCtl, 4, kCp, 1);
  const int b = reg2.EnsureVehicle(1);
  reg2.UpdateProgress(b, 10.0, 0.0, 0, -1, 0.0);
  reg2.UpdateProgress(b, 5.0, 1.0 / 60.0, 0, -1, 0.0);   // 倒退
  const double vb = reg2.At(b)->delta.segSpeedMps;
  Check(vb >= 0.0, "倒车不产生负段速");
}

// -----------------------------------------------------------------------------
//  W15. 解包入口的真实路径：通过地址直接解包（模拟 UpdateRemoteVehicleState）
// -----------------------------------------------------------------------------
void TestExpandFromStagedAddress() {
  std::printf("W15 从暂存地址解包\n");
  // 模拟：JS 把 32B 包写进一块内存，然后传地址进来
  alignas(16) std::uint8_t stage[kWireBytes];
  RigidBodyNetSnapshot src{};
  src.frame = 777;
  src.position = {500.25F, 12.5F, -333.75F};
  src.rotation = {1.0F, 0.0F, 0.0F, 0.0F};
  src.velocity = {45.0F, 0.0F, -20.0F};
  PackSnapshotToWire(src, stage);

  // 通过指针偏移（正是 UpdateRemoteVehicleState 的语义）
  const std::uint8_t* p = stage + 0;
  RigidBodyNetSnapshot o{};
  ExpandWireToSnapshot(p, o, 0U);
  Check(o.frame == 777u, "从地址解包帧号正确");
  Check(Near(o.position.x, 500.25, 0.07), "从地址解包位置正确");

  // 非零偏移：把包放在 stage+16 处（模拟批量包）
  alignas(16) std::uint8_t big[64];
  std::memcpy(big + 16, stage, kWireBytes);
  RigidBodyNetSnapshot o2{};
  ExpandWireToSnapshot(big + 16, o2, 0U);
  Check(o2.frame == 777u, "非零偏移解包正确");
}

}  // namespace

// =============================================================================
//  --dump-wire：把 C++ 真值写给 TS 交叉校验用
// =============================================================================
namespace {

/// 一组测试输入（字段名与 TS 侧 packTs 的 s.* 一一对应）
struct WireCase {
  RigidBodyNetSnapshot snap;
};

void DumpWireJson(const char* path) {
  // 覆盖的量程要宽：正/负、接近饱和、贴近 0、四元数各象限
  WireCase cases[8];
  const float posVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {1234.5F, -67.25F, -1987.75F},
      {-4095.9F, 2047.75F, 511.125F},
      {0.0625F, -0.0625F, 0.125F},
      {100.5F, 3.25F, -999.875F},
      {2047.875F, -2047.875F, 1.0F},
      {-1.5F, 800.25F, -1200.5F},
      {4095.875F, -4095.875F, 0.0F},
  };
  const float velVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {72.5F, -3.25F, 12.75F},
      {127.5F, -127.5F, 0.015625F},
      {-45.0F, 20.0F, -88.0F},
      {0.015625F, -0.015625F, 64.0F},
      {12.0F, 33.5F, -100.25F},
      {-8.5F, 55.0F, -1.0F},
      {100.0F, -100.0F, 50.0F},
  };
  const float omgVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {0.5F, -1.25F, 3.0F},
      {7.996F, -7.996F, 0.00390625F},
      {-2.0F, 4.0F, -6.0F},
      {0.25F, -0.5F, 1.0F},
      {3.5F, -3.5F, 2.0F},
      {-0.0117F, 0.0117F, 5.0F},
      {7.0F, -7.0F, 0.0F},
  };
  const float accVals[8][3] = {
      {0.0F, 0.0F, 0.0F},
      {8.5F, -9.5F, 2.25F},
      {15.99F, -15.99F, 0.0078125F},
      {-3.0F, 6.0F, -12.0F},
      {0.5F, -0.5F, 1.0F},
      {12.3F, -9.81F, 0.5F},
      {-0.0039F, 0.0039F, 9.0F},
      {15.0F, -15.0F, 1.0F},
  };
  const float rotVals[8][4] = {
      {1.0F, 0.0F, 0.0F, 0.0F},
      {0.5F, 0.5F, 0.5F, 0.5F},
      {0.70710678F, 0.0F, 0.70710678F, 0.0F},
      {0.6F, -0.8F, 0.0F, 0.0F},
      {-0.6F, 0.8F, 0.0F, 0.0F},      // q 与 -q 必须打包成同一串
      {0.0F, 1.0F, 0.0F, 0.0F},       // 180°
      {0.258819F, 0.0F, 0.9659258F, 0.0F},
      {-0.5F, -0.5F, -0.5F, -0.5F},
  };

  for (int i = 0; i < 8; ++i) {
    RigidBodyNetSnapshot& s = cases[i].snap;
    s.frame = static_cast<std::uint32_t>(1000 + i * 7777) & 0xFFFFu;
    s.tickMs = static_cast<std::uint32_t>(i * 8191) & 0xFFFFu;
    s.position = {posVals[i][0], posVals[i][1], posVals[i][2]};
    s.velocity = {velVals[i][0], velVals[i][1], velVals[i][2]};
    s.angularVelocity = {omgVals[i][0], omgVals[i][1], omgVals[i][2]};
    s.accel = {accVals[i][0], accVals[i][1], accVals[i][2]};
    s.rotation = {rotVals[i][0], rotVals[i][1], rotVals[i][2], rotVals[i][3]};
  }

  std::FILE* f = std::fopen(path, "wb");
  if (f == nullptr) {
    std::printf("[dump] 无法写入 %s\n", path);
    return;
  }
  std::fprintf(f, "{\n");
  std::fprintf(f, "  \"wireBytes\": %u,\n", kWireBytes);
  std::fprintf(f, "  \"payloadBits\": %d,\n", kWirePayloadBits);
  std::fprintf(f, "  \"bits\": {\n");
  std::fprintf(f, "    \"frame\": %d, \"tickMs\": %d,\n", wire_bit::kFrame, wire_bit::kTickMs);
  std::fprintf(f, "    \"posX\": %d, \"posY\": %d, \"posZ\": %d,\n", wire_bit::kPosX,
               wire_bit::kPosY, wire_bit::kPosZ);
  std::fprintf(f, "    \"velX\": %d, \"velY\": %d, \"velZ\": %d,\n", wire_bit::kVelX,
               wire_bit::kVelY, wire_bit::kVelZ);
  std::fprintf(f, "    \"rotX\": %d, \"rotY\": %d, \"rotZ\": %d,\n", wire_bit::kRotX,
               wire_bit::kRotY, wire_bit::kRotZ);
  std::fprintf(f, "    \"accX\": %d, \"accY\": %d, \"accZ\": %d,\n", wire_bit::kAccX,
               wire_bit::kAccY, wire_bit::kAccZ);
  std::fprintf(f, "    \"omegaX\": %d, \"omegaY\": %d, \"omegaZ\": %d\n", wire_bit::kOmegaX,
               wire_bit::kOmegaY, wire_bit::kOmegaZ);
  std::fprintf(f, "  },\n");
  std::fprintf(f, "  \"widths\": { \"pos\": %d, \"vel\": %d, \"rot\": %d, \"accel\": %d, \"omega\": %d },\n",
               kBitsPos, kBitsVel, kBitsRot, kBitsAccel, kBitsOmega);
  std::fprintf(f, "  \"scales\": { \"pos\": %.10g, \"vel\": %.10g, \"rot\": %.10g, \"accel\": %.10g, \"omega\": %.10g },\n",
               static_cast<double>(kWirePosScale), static_cast<double>(kWireVelScale),
               static_cast<double>(kWireRotScale), static_cast<double>(kWireAccelScale),
               static_cast<double>(kWireOmegaScale));
  std::fprintf(f, "  \"cases\": [\n");

  for (int i = 0; i < 8; ++i) {
    std::uint8_t buf[kWireBytes];
    PackSnapshotToWire(cases[i].snap, buf, true);
    const RigidBodyNetSnapshot& s = cases[i].snap;
    std::fprintf(f, "    { \"in\": {");
    std::fprintf(f, "\"frame\": %u, \"tickMs\": %u, ", s.frame, s.tickMs);
    std::fprintf(f, "\"px\": %.10g, \"py\": %.10g, \"pz\": %.10g, ",
                 static_cast<double>(s.position.x), static_cast<double>(s.position.y),
                 static_cast<double>(s.position.z));
    std::fprintf(f, "\"qw\": %.10g, \"qx\": %.10g, \"qy\": %.10g, \"qz\": %.10g, ",
                 static_cast<double>(s.rotation.w), static_cast<double>(s.rotation.x),
                 static_cast<double>(s.rotation.y), static_cast<double>(s.rotation.z));
    std::fprintf(f, "\"vx\": %.10g, \"vy\": %.10g, \"vz\": %.10g, ",
                 static_cast<double>(s.velocity.x), static_cast<double>(s.velocity.y),
                 static_cast<double>(s.velocity.z));
    std::fprintf(f, "\"wx\": %.10g, \"wy\": %.10g, \"wz\": %.10g, ",
                 static_cast<double>(s.angularVelocity.x), static_cast<double>(s.angularVelocity.y),
                 static_cast<double>(s.angularVelocity.z));
    std::fprintf(f, "\"ax\": %.10g, \"ay\": %.10g, \"az\": %.10g}, ",
                 static_cast<double>(s.accel.x), static_cast<double>(s.accel.y),
                 static_cast<double>(s.accel.z));
    std::fprintf(f, "\"bytes\": [");
    for (std::uint32_t k = 0; k < kWireBytes; ++k) {
      std::fprintf(f, "%u%s", static_cast<unsigned>(buf[k]), (k + 1U < kWireBytes) ? "," : "");
    }
    std::fprintf(f, "]}%s\n", (i + 1 < 8) ? "," : "");
  }
  std::fprintf(f, "  ]\n}\n");
  std::fclose(f);
  std::printf("[dump] 已写出 %s（%u 字节线格式 × %d 组）\n", path, kWireBytes, 8);
}

}  // namespace

int main(int argc, char** argv) {
  // dump 模式：不跑断言，只产真值给 TS 交叉校验
  if (argc > 1 && std::strcmp(argv[1], "--dump-wire") == 0) {
    const char* out = (argc > 2) ? argv[2] : "wire_dump.json";
    DumpWireJson(out);
    return 0;
  }

  std::printf("=== wasm_bindings_test（32B 线格式 + 多车注册表 + HUD 文本）===\n");
  TestWireLayout();
  TestQuantizeSaturation();
  TestBitIO();
  TestRoundTrip();
  TestQuatCanonicalization();
  TestQuatExtremes();
  TestVehicleSlots();
  TestVehicleIndependence();
  TestFrameDedup();
  TestRemoveVehicle();
  TestTableFull();
  TestLeaderboard();
  TestLocalBehind();
  TestSegSpeed();
  TestExpandFromStagedAddress();

  std::printf("\n通过 %d / 失败 %d\n", g_pass, g_fail);
  return (g_fail == 0) ? 0 : 1;
}
