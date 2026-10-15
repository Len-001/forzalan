// =============================================================================
//  rigid_body_replicator_test.cpp —— 自包含单测（零外部依赖）
//
//  断言与 verify_blending.py 一一对应，便于两边交叉核对：
//   T1  半衰期语义（exp(-dt/T½) 是错的，会得到 36.79% 而不是 50%）
//   T2  帧率无关性（28/61/144/239Hz 相同墙钟时间衰减必须完全一致）
//   T3  纠偏当帧视觉位置零跳变 + 后续平滑收敛
//   T4  旋转误差 slerp 与位置同节奏 + 传送保护
//   T5  外推时长硬截断 **150ms** + 触顶后阻尼滑行（不再匀速飞出去）
//   T6  过期帧丢弃 / 快照布局 / seqlock 邮箱
//   T7  强制短弧（dot<0 反转）：钝角误差不得报成 358° / 不得翻滚一整圈
//   T8  滑行期速度按半衰期衰减（"维持当前速度阻尼滑行"的量化证据）
//
//  编译：
//    g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic rigid_body_replicator_test.cpp -o rb_test && ./rb_test
// =============================================================================
#include "rigid_body_replicator.h"

#include <algorithm>    // std::max
#include <cmath>        // std::fabs / expf / powf
#include <cstdio>
#include <thread>

using namespace forza::net;

namespace {

int g_pass = 0;
int g_fail = 0;
const char* g_case = "";

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) { ++g_pass; }
  else { ++g_fail; std::printf("  [FAIL] %s :: %s %s\n", g_case, what, detail); }
}
void Case(const char* n) noexcept { g_case = n; std::printf("- %s\n", n); }

RigidBodyNetSnapshot MakeSnap(std::uint32_t frame, const glm::vec3& pos,
                              const glm::vec3& vel = glm::vec3(0.0F),
                              const glm::vec3& omega = glm::vec3(0.0F),
                              const glm::vec3& accel = glm::vec3(0.0F),
                              const glm::quat& rot = glm::quat(1.0F, 0.0F, 0.0F, 0.0F)) noexcept {
  RigidBodyNetSnapshot s{};
  s.frame = frame;
  s.position = pos;
  s.rotation = rot;
  s.velocity = vel;
  s.angularVelocity = omega;
  s.accel = accel;
  return s;
}

/// 半衰期固定为 90ms 跑格式断言（与 ReplicatorConfig 默认 80ms 解耦，
/// 避免"调默认值把测试调崩"这种耦合）。
constexpr float kHL = 0.090F;

/// 规格外推上限 150ms
constexpr float kMaxExtrap = 0.150F;
/// 构造一个用规格上限的复制器（默认配置已改成 150ms，这里显式再钉一次）
NetworkRigidBodyReplicator MakeRepl() noexcept {
  ReplicatorConfig c{};
  c.maxExtrapolationSec = kMaxExtrap;
  return NetworkRigidBodyReplicator(c);
}

// -----------------------------------------------------------------------------
void TestHalfLife() noexcept {
  Case("T1  半衰期语义（ln2 不能漏）");
  // 直接验纯函数，避免受外推/清扫逻辑干扰
  const float k1 = NetworkRigidBodyReplicator::DecayFactor(kHL, kHL);
  char b[64];
  std::snprintf(b, sizeof b, "k(T½)=%.6f", static_cast<double>(k1));
  Check(std::fabs(k1 - 0.5F) < 1e-6F, "经过 T½ 保留系数恰为 0.5", b);

  const float kWrong = expf(-1.0F);
  std::snprintf(b, sizeof b, "错写成 exp(-dt/T½) 会得 %.4f", static_cast<double>(kWrong));
  Check(std::fabs(kWrong - 0.367879F) < 1e-4F, "对照：时间常数写法得到 1/e 而非 1/2", b);

  const float k3 = powf(NetworkRigidBodyReplicator::DecayFactor(kHL, kHL), 3.0F);
  std::snprintf(b, sizeof b, "%.6f", static_cast<double>(k3));
  Check(std::fabs(k3 - 0.125F) < 1e-6F, "经过 3·T½ 剩 12.5%", b);

  const float rate = NetworkRigidBodyReplicator::DecayRatePerSec(kHL);
  std::snprintf(b, sizeof b, "λ=%.3f /s", static_cast<double>(rate));
  Check(std::fabs(rate - 7.7011F) < 1e-3F, "衰减率 λ = ln2/T½ ≈ 7.70 /s @ T½=90ms", b);
}

// -----------------------------------------------------------------------------
void TestFrameRateIndependence() noexcept {
  Case("T2  帧率无关性");
  // 0.180s 恰好是 2 个半衰期；取 n 使 0.180/n 整除，保证各刷新率总时长严格相等
  const int steps[4] = {5, 11, 26, 43};
  float results[4] = {0.0F, 0.0F, 0.0F, 0.0F};
  // ⚠️ 半衰期必须显式钉到 kHL：本用例断言的是"180ms = 2×T½ -> 剩 25%"，
  //    若用 ReplicatorConfig 的默认半衰期，改默认值就会把测试调崩（耦合）。
  ReplicatorConfig cfg{};
  cfg.halfLifeSec = kHL;
  for (int i = 0; i < 4; ++i) {
    const float dt = 0.180F / static_cast<float>(steps[i]);
    NetworkRigidBodyReplicator q(cfg);
    q.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(30.0F, 0.0F, 0.0F)));
    for (int k = 0; k < 6; ++k) q.Update(1.0F / 60.0F);
    const glm::vec3 visBefore = q.GetVisualPosition();
    q.OnAuthoritativeSnapshot(MakeSnap(2, visBefore - glm::vec3(1.0F, 0.0F, 0.0F),
                                       glm::vec3(30.0F, 0.0F, 0.0F)));
    const float err0 = q.VisualPositionErrorM();
    for (int k = 0; k < steps[i]; ++k) q.Update(dt);
    results[i] = q.VisualPositionErrorM() / err0;
    char b[96];
    std::snprintf(b, sizeof b, "%.1fHz (%2d 步 × %5.2fms) -> 剩余 %.6f",
                  1.0 / static_cast<double>(dt), steps[i],
                  static_cast<double>(dt) * 1000.0, static_cast<double>(results[i]));
    std::printf("    %s\n", b);
  }
  float worst = 0.0F;
  for (int i = 0; i < 4; ++i) {
    worst = std::max(worst, std::fabs(results[i] - 0.25F));
  }
  char b[64];
  std::snprintf(b, sizeof b, "最大偏差 %.2e", static_cast<double>(worst));
  Check(worst < 1e-5F, "28/61/144/239Hz 下 180ms 后剩余完全相同 = 25%（帧率无关）", b);
}

// -----------------------------------------------------------------------------
void TestNoSnapOnCorrection() noexcept {
  Case("T3  纠偏当帧视觉零跳变 + 平滑收敛");
  NetworkRigidBodyReplicator r;
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(30.0F, 0.0F, 0.0F)));
  const float dt = 1.0F / 60.0F;
  for (int i = 0; i < 12; ++i) r.Update(dt);          // 200ms 纯外推

  const glm::vec3 visBefore = r.GetVisualPosition();
  // 服务端纠偏：权威位置比外推值落后 0.8m
  r.OnAuthoritativeSnapshot(MakeSnap(2, visBefore - glm::vec3(0.8F, 0.0F, 0.0F),
                                     glm::vec3(30.0F, 0.0F, 0.0F)));
  const glm::vec3 visAfter = r.GetVisualPosition();
  char b[64];
  std::snprintf(b, sizeof b, "jump=%.3e m", static_cast<double>(glm::length(visAfter - visBefore)));
  Check(glm::length(visAfter - visBefore) < 1e-6F, "收到纠偏的**当帧**视觉位置零跳变", b);

  std::snprintf(b, sizeof b, "|offset|=%.3f m", static_cast<double>(r.VisualPositionErrorM()));
  Check(r.VisualPositionErrorM() > 0.7F, "误差被存进视觉偏移层（物理层已跳到权威值）", b);

  float maxStep = 0.0F;
  glm::vec3 prev = r.GetVisualPosition();
  for (int i = 0; i < 60; ++i) {
    r.Update(dt);
    const glm::vec3 cur = r.GetVisualPosition();
    maxStep = std::max(maxStep, glm::length(cur - prev));
    prev = cur;
  }
  std::snprintf(b, sizeof b, "|offset|=%.4f mm", static_cast<double>(r.VisualPositionErrorM()) * 1000.0);
  Check(r.VisualPositionErrorM() < 0.01F, "~1s 内视觉误差收敛到 1cm 内", b);
  std::snprintf(b, sizeof b, "maxStep=%.2f mm/frame", static_cast<double>(maxStep) * 1000.0);
  Check(maxStep < 30.0F * dt * 1.5F, "每帧位移不超过 车速×dt 的 1.5 倍（无抽搐）", b);
}

// -----------------------------------------------------------------------------
void TestRotationAndTeleportGuard() noexcept {
  Case("T4  旋转 slerp 衰减 + 传送保护");
  ReplicatorConfig cfg{};
  cfg.halfLifeSec = kHL;          // 显式钉半衰期，避免与默认值耦合
  NetworkRigidBodyReplicator r(cfg);
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F)));
  r.Update(1e-6F);
  // 制造 30° 姿态误差：物理层转 30°，视觉层原地不动
  r.OnAuthoritativeSnapshot(MakeSnap(2, glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::angleAxis(glm::radians(30.0F), glm::vec3(0.0F, 1.0F, 0.0F))));
  r.Update(kHL);            // 恰好一个半衰期
  const float ang = glm::degrees(glm::angle(r.GetVisualRotation() *
                                            glm::inverse(r.PhysicsRotation())));
  char b[64];
  std::snprintf(b, sizeof b, "%.3f°", static_cast<double>(ang));
  Check(std::fabs(ang - 15.0F) < 0.05F, "姿态误差经过 T½ 恰好减半（slerp 与位置同节奏）", b);

  // 传送保护
  NetworkRigidBodyReplicator t(cfg);
  t.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(30.0F, 0.0F, 0.0F)));
  for (int i = 0; i < 12; ++i) t.Update(1.0F / 60.0F);
  t.OnAuthoritativeSnapshot(MakeSnap(2, t.GetVisualPosition() + glm::vec3(50.0F, 0.0F, 0.0F),
                                     glm::vec3(30.0F, 0.0F, 0.0F)));
  std::snprintf(b, sizeof b, "snaps=%u", t.HardSnapCount());
  Check(t.HardSnapCount() == 1 && t.VisualPositionErrorM() < 1e-6F,
        "误差 > snapDistanceM(5m) -> 直接吸附清零（不做长尾滑行）", b);
}

// -----------------------------------------------------------------------------
void TestExtrapolationClamp() noexcept {
  Case("T5  外推硬截断 150ms + 触顶后阻尼滑行");
  NetworkRigidBodyReplicator r = MakeRepl();
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(55.0F, 0.0F, 0.0F)));  // 200km/h
  // 只推进到刚触顶：150ms / (1/60) = 9 步整
  for (int i = 0; i < 9; ++i) r.Update(1.0F / 60.0F);
  char b[128];
  std::snprintf(b, sizeof b, "extrap=%.4fs x=%.3fm",
                static_cast<double>(r.ExtrapolatedSec()),
                static_cast<double>(r.PhysicsPosition().x));
  Check(std::fabs(r.ExtrapolatedSec() - kMaxExtrap) < 1e-4F, "外推时长钉死在上限 150ms", b);
  Check(std::fabs(r.PhysicsPosition().x - 55.0F * kMaxExtrap) < 1e-3F,
        "推进期内位移 = v × 150ms（不会一路飞出地图）", b);
  Check(r.State() == ReplState::Stale, "触顶后状态标记为 Stale（供上层降级）");

  // 触顶后继续断包：位置仍在前进（滑行），但速度开始衰减，且**不再**按 55m/s 线性增长
  const float xAtCap = r.PhysicsPosition().x;
  const float vAtCap = glm::length(r.PhysicsVelocity());
  for (int i = 0; i < 60; ++i) r.Update(1.0F / 60.0F);   // 再滑 1 秒
  const float xSlid = r.PhysicsPosition().x;
  const float vSlid = glm::length(r.PhysicsVelocity());
  std::snprintf(b, sizeof b, "1s 后 x=%.2fm（x@cap=%.2fm） v=%.2f m/s（原 %.1f）",
                static_cast<double>(xSlid), static_cast<double>(xAtCap),
                static_cast<double>(vSlid), static_cast<double>(vAtCap));
  Check(r.ExtrapolatedSec() <= kMaxExtrap + 1e-5F,
        "滑行期不再增加外推计数（推进已定格在 150ms）", b);
  Check(xSlid > xAtCap + 1.0F, "滑行期位置仍在前进（视觉上'还在滑'，非硬冻结）", b);
  Check(vSlid < vAtCap * 0.5F, "滑行 1s 后速度衰减到 50% 以下（coast T½=0.6s）", b);
  Check(r.IsCoasting() && r.State() == ReplState::Stale, "滑行标志与 Stale 状态同时置位");
  // 若按"永远匀速"的旧实现，1s 会再飞 55m；滑行实现必须显著更短
  const float naiveExtra = 55.0F * 1.0F;
  const float realExtra = xSlid - xAtCap;
  std::snprintf(b, sizeof b, "实际多飞 %.1fm vs 匀速假设 %.1fm", static_cast<double>(realExtra),
                static_cast<double>(naiveExtra));
  Check(realExtra < naiveExtra * 0.8F, "滑行位移显著小于'匀速飞出去'（阻尼确实生效）", b);
}

// -----------------------------------------------------------------------------
//  T7 —— 强制短弧（dot < 0 反转）
//
//  这是规格里"四元数钝角插值导致长弧度翻滚"的正解。构造一个 -q 等价的
//  姿态：物理上完全一样，但若不做半球重置，误差四元数会变成 358° 而不是 2°，
//  glm::angle() 随即误触发 snapAngleRad、把平滑纠偏变成硬吸附。
// -----------------------------------------------------------------------------
void TestShortArcQuaternion() noexcept {
  Case("T7  强制短弧（dot<0 反转，防长弧翻滚）");
  NetworkRigidBodyReplicator r;
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F)));
  r.Update(1e-6F);

  // 当前姿态：绕 Y 转 1°
  const glm::quat base = glm::angleAxis(glm::radians(1.0F), glm::vec3(0.0F, 1.0F, 0.0F));
  r.OnAuthoritativeSnapshot(MakeSnap(2, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), base));
  r.Update(1e-6F);

  // 服务端发来 -base（同一个旋转，但符号相反）：
  // 正确的实现应视作"误差 ≈ 0"，而不是"误差 ≈ 358°"。
  const glm::quat negBase(-base.w, -base.x, -base.y, -base.z);
  r.OnAuthoritativeSnapshot(MakeSnap(3, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), negBase));

  char b[96];
  const float offAng = glm::degrees(glm::angle(r.VisualRotationOffset()));
  std::snprintf(b, sizeof b, "视角偏移=%.3f°", static_cast<double>(offAng));
  Check(offAng < 1.0F, "-q 输入被判为同姿态（误差 <1°，不是 358°）", b);
  Check(r.HardSnapCount() == 0, "不因 -q 误触发传送吸附（0 次 snap）", b);

  // 更极端：接近 180° 的姿态上做 -q 抖动（服务端量化/序列化翻符号）。
  // ⚠️ 关键设计：**误差**必须是小的，不能拿"从 identity 突然跳到 179°"当用例——
  //    那是一个真实的 179° 大纠偏，本来就该触发传送保护（那是正确行为，不是 bug）。
  //    这里先平滑走到 179°，再发**同一个姿态的 -q 表示**，这才是在考"短弧"。
  NetworkRigidBodyReplicator q;
  q.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F),
                                     glm::angleAxis(glm::radians(178.0F), glm::vec3(0.0F, 1.0F, 0.0F))));
  q.Update(1e-6F);
  const float snapsBefore = static_cast<float>(q.HardSnapCount());

  // 179° 的姿态、以及它的 -q 等价表示（同一个旋转）
  const glm::quat a179 = glm::angleAxis(glm::radians(179.0F), glm::vec3(0.0F, 1.0F, 0.0F));
  q.OnAuthoritativeSnapshot(MakeSnap(2, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), a179));
  q.Update(1e-6F);
  Check(static_cast<float>(q.HardSnapCount()) == snapsBefore,
        "178° -> 179°（1° 误差）不触发吸附（正常平滑纠偏）");

  const float errAfterReal = glm::degrees(glm::angle(q.VisualRotationOffset()));
  const glm::quat negA179(-a179.w, -a179.x, -a179.y, -a179.z);
  q.OnAuthoritativeSnapshot(MakeSnap(3, glm::vec3(0.0F), glm::vec3(0.0F), glm::vec3(0.0F),
                                     glm::vec3(0.0F), negA179));
  const float errAfterNeg = glm::degrees(glm::angle(q.VisualRotationOffset()));
  std::snprintf(b, sizeof b, "发 a179: %.3f° -> 发 -a179: %.3f°",
                static_cast<double>(errAfterReal), static_cast<double>(errAfterNeg));
  Check(errAfterNeg < 2.0F, "-q 等价表示被判为同一姿态（误差 <2°，不是 358°）", b);
  Check(glm::degrees(glm::angle(q.GetVisualRotation())) > 170.0F,
        "视觉姿态仍停在 179° 附近（没有被长弧拽走）", b);
  Check(static_cast<float>(q.HardSnapCount()) == snapsBefore,
        "179° 处的 -q 抖动不误触发 52° 吸附门限", b);
}

// -----------------------------------------------------------------------------
//  T8 —— 滑行期速度半衰期（与视觉偏移层同一套指数律）
// -----------------------------------------------------------------------------
void TestCoastDecay() noexcept {
  Case("T8  滑行期速度按 coast 半衰期衰减");
  NetworkRigidBodyReplicator r = MakeRepl();
  r.OnAuthoritativeSnapshot(MakeSnap(1, glm::vec3(0.0F), glm::vec3(50.0F, 0.0F, 0.0F)));
  // 触顶：150ms
  for (int i = 0; i < 9; ++i) r.Update(1.0F / 60.0F);
  Check(r.IsCoasting(), "已进入滑行期");

  const float v0 = glm::length(r.PhysicsVelocity());
  // 恰好再滑一个 coast 半衰期（0.6s，36 步整）
  for (int i = 0; i < 36; ++i) r.Update(1.0F / 60.0F);
  const float v1 = glm::length(r.PhysicsVelocity());
  char b[96];
  std::snprintf(b, sizeof b, "%.2f -> %.2f m/s（比值 %.4f）", static_cast<double>(v0),
                static_cast<double>(v1), static_cast<double>(v1 / v0));
  Check(std::fabs(v1 / v0 - 0.5F) < 0.02F, "滑行 1 个 coast 半衰期(0.6s) 速度剩 50%", b);

  // 再滑 1.8s（3 个半衰期的一半 -> 共 4 个半衰期）-> 剩 6.25%
  for (int i = 0; i < 108; ++i) r.Update(1.0F / 60.0F);
  const float v2 = glm::length(r.PhysicsVelocity());
  std::snprintf(b, sizeof b, "再滑 1.8s -> %.4f m/s", static_cast<double>(v2));
  Check(v2 < v0 * 0.10F, "长时间断包后速度收敛到接近 0（不会一直高速漂）", b);
}

// -----------------------------------------------------------------------------
void TestStaleFrameAndLayout() noexcept {
  Case("T6  过期帧 / 布局 / 无锁邮箱");

  // 布局：static_assert 已在头文件编译期钉住，这里再运行时核一次（协议对接用）
  char b[64];
  std::snprintf(b, sizeof b, "size=%zu align=%zu", sizeof(RigidBodyNetSnapshot),
                alignof(RigidBodyNetSnapshot));
  Check(sizeof(RigidBodyNetSnapshot) == 96 &&
        offsetof(RigidBodyNetSnapshot, accel) == 80, "快照 96B / accel 偏移 80", b);

  NetworkRigidBodyReplicator r;
  r.OnAuthoritativeSnapshot(MakeSnap(10, glm::vec3(0.0F)));
  const bool took = r.OnAuthoritativeSnapshot(MakeSnap(9, glm::vec3(5.0F, 0.0F, 0.0F)));
  std::snprintf(b, sizeof b, "dropped=%u", r.StaleDroppedCount());
  Check(!took && r.StaleDroppedCount() == 1 && glm::length(r.PhysicsPosition()) < 1e-6F,
        "帧号回退的包被丢弃（乱序通道常态）", b);

  // seqlock 邮箱：单生产者单消费者
  SnapshotMailbox mb;
  RigidBodyNetSnapshot got{};
  std::uint32_t ver = 0;
  Check(!mb.TryConsume(got, ver), "空邮箱返回 false");

  mb.Publish(MakeSnap(1, glm::vec3(1.0F, 2.0F, 3.0F)));
  Check(mb.TryConsume(got, ver) && glm::length(got.position - glm::vec3(1.0F, 2.0F, 3.0F)) < 1e-6F,
        "投递后可读出");
  Check(!mb.TryConsume(got, ver), "同一版本不重复投递");

  mb.Publish(MakeSnap(2, glm::vec3(9.0F, 9.0F, 9.0F)));
  Check(mb.TryConsume(got, ver) && got.frame == 2, "新版本可读出");

  // 跨线程压力：写 20 万次、读侧必须始终读到**完整**快照（不能撕裂）
  SnapshotMailbox mb2;
  std::atomic<bool> stop{false};
  std::atomic<int> torn{0};
  std::thread writer([&]() noexcept {
    for (std::uint32_t i = 1; i <= 200000U; ++i) {
      // 所有字段填同一个 i：若发生撕裂，各字段值会不一致
      RigidBodyNetSnapshot s{};
      s.frame = i;
      s.tickMs = i;
      s.position = glm::vec3(static_cast<float>(i));
      s.velocity = glm::vec3(static_cast<float>(i));
      s.accel = glm::vec3(static_cast<float>(i));
      mb2.Publish(s);
    }
    stop.store(true, std::memory_order_release);
  });
  std::thread reader([&]() noexcept {
    RigidBodyNetSnapshot s{};
    std::uint32_t v = 0;
    while (!stop.load(std::memory_order_acquire)) {
      if (mb2.TryConsume(s, v)) {
        const float f = static_cast<float>(s.frame);
        if (s.tickMs != s.frame || s.position.x != f ||
            s.velocity.x != f || s.accel.x != f) {
          torn.fetch_add(1, std::memory_order_relaxed);
        }
      }
    }
  });
  writer.join();
  reader.join();
  std::snprintf(b, sizeof b, "torn=%d", torn.load());
  Check(torn.load() == 0, "seqlock 邮箱在 20 万次并发写入下零撕裂", b);
}

}  // namespace

int main() {
  std::printf("=== NetworkRigidBodyReplicator 单元测试 ===\n");
  TestHalfLife();
  TestFrameRateIndependence();
  TestNoSnapOnCorrection();
  TestRotationAndTeleportGuard();
  TestExtrapolationClamp();
  TestStaleFrameAndLayout();
  TestShortArcQuaternion();
  TestCoastDecay();
  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
