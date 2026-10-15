// =============================================================================
//  safe_collision_test.cpp —— 【已废弃模块】兼容层回归测试
//
//  ⚠ 本文件**不再测试旧算法**（旧实现已删除，见 safe_collision_resolver.h）。
//    它现在的唯一职责是验证"废弃转发层"的三条契约：
//
//      ① **可编译性**：旧类名 / 旧类型别名 / 旧配置名仍能被下游代码使用，
//         且 `ResolverConfig{}` 仍支持 aggregate-init（harness 依赖此点）。
//      ② **转发正确性**：旧类名调用的结果与直接调用 `SafePhysicsSolver`
//         **逐位一致**（不是"近似一致"）—— 否则转发层就是第二个实现，
//         会与权威实现悄悄分叉。
//      ③ **缺陷不可复活**：手工把旧参数（`restLow = 0.9f`、`penMaxStep = 0.25f`、
//         `normalYSlop = 1.0f`）设成旧的诱人值，新求解器**行为不变** ——
//         这是"用旧旋钮调不出旧缺陷"的保证。
//
//  新算法的完整验收（117 项，含 200km/h 侧撞/正撞 ≤ 0.5m/s）在
//  `native/safe_physics/safe_physics_test.cpp`。**不要在本文件里重复它。**
//
//  编译：g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic -I ../safe_physics
//            safe_collision_test.cpp
// =============================================================================

#include "safe_collision_resolver.h"

#include <cmath>
#include <cstdio>
#include <string>

using namespace forza::physics;

// -----------------------------------------------------------------------------
//  极简测试框架（与项目其它模块一致：零依赖、失败计数、退出码即结论）
// -----------------------------------------------------------------------------
namespace {

int g_pass = 0;
int g_fail = 0;

void Check(bool cond, const char* what, const std::string& detail = {}) {
  if (cond) {
    ++g_pass;
    std::printf("  PASS %s", what);
  } else {
    ++g_fail;
    std::printf("  FAIL %s", what);
  }
  if (!detail.empty()) std::printf("   %s", detail.c_str());
  std::printf("\n");
}

void Section(const char* title) { std::printf("\n[%s]\n", title); }

bool NearlyEqual(float a, float b, float eps = 1e-5f) { return std::fabs(a - b) <= eps; }

/// 逐位相等。转发层的契约是"同一个函数"，必须是精确相等而非近似。
bool BitEqual(float a, float b) { return a == b; }

float KineticEnergy(const RigidBodyView& b) {
  return 0.5f * (b.invMass > 0.0f ? 1.0f / b.invMass : 0.0f) * b.velocity.LengthSq();
}

RigidBodyView MakeCar(float x, float y, float z) {
  RigidBodyView b;
  b.position = {x, y, z};
  b.invMass = 1.0f / 1380.0f;
  b.invInertia = 1.0f / 1800.0f;
  return b;
}

/// 造一个"200km/h 撞带倒角静态护栏"的流形。返回前车位置供断言。
ContactManifold MakeWallManifold(RigidBodyView& car, float vy) {
  ContactManifold mf;
  mf.a = &car;
  mf.b = nullptr;                              // 静态护栏
  mf.kind = ContactKind::CarToWall;
  mf.normal = Vec3(1.0f, vy, 0.0f).Normalized();   // 刻意带 Y 分量
  mf.pointCount = 1;
  mf.points[0] = ContactPoint{{0.0f, 0.0f, 0.0f}, {}, 0.05f, 0.0f, 0.0f};
  return mf;
}

}  // namespace

// =============================================================================
//  §1 契约①：旧名字仍可编译 + aggregate-init 仍成立
// =============================================================================
void TestSourceCompatibility() {
  Section("§1 源码兼容性（旧类名 / 旧别名 / aggregate-init）");

  // 旧配置名必须能默认构造（harness 传的是 `ResolverConfig{}`）
  ResolverConfig cfg;
  Check(cfg.flattenStaticNormal, "ResolverConfig{} 默认开启 §1 无条件平整化");
  Check(NearlyEqual(cfg.maxPushPerSubstep, 0.03f), "ResolverConfig{} 默认 §3 单子步上限 = 0.03m",
        "v=" + std::to_string(cfg.maxPushPerSubstep));
  Check(NearlyEqual(cfg.maxNormalImpulse, 40000.0f), "ResolverConfig{} 默认 §5 冲量上限 = 4e4 N·s",
        "v=" + std::to_string(cfg.maxNormalImpulse));

  // ★ aggregate-init 必须仍可用（不能有用户提供的构造函数 / 虚基类）
  //   这里用指定初始化器逐一写入，能通过即证明仍是聚合类型。
  const ResolverConfig agg{
      /*flattenStaticNormal*/ true,
      /*plasticThresholdSpeed*/ 1.5f,
      /*plasticPeakRestitution*/ 0.05f,
      /*maxPushPerSubstep*/ 0.03f,
      /*maxNormalImpulse*/ 40000.0f,
  };
  Check(agg.flattenStaticNormal && NearlyEqual(agg.maxNormalImpulse, 40000.0f),
        "ResolverConfig 仍是聚合类型（支持 {} 指定/位置初始化）");

  // 旧类型别名必须可用（旧代码写的是 SafeCollisionResolver::ContactManifold 等）
  static_assert(std::is_same_v<Vec3, forza::physics::Vec3>);
  static_assert(std::is_same_v<RigidBodyView, forza::physics::RigidBodyView>);
  static_assert(std::is_same_v<ContactPoint, forza::physics::ContactPoint>);
  static_assert(std::is_same_v<ContactManifold, forza::physics::ContactManifold>);
  static_assert(std::is_same_v<ContactKind, forza::physics::ContactKind>);
  static_assert(std::is_same_v<ResolveStats, forza::physics::SolveStats>);
  Check(true, "旧类型别名全部指向新类型（static_assert 编译期证明）");

  // 旧配置里的旧字段名仍是**数据成员**（旧测试会写 cfg.restLow）
  cfg.restLow = 0.35f;
  cfg.restHigh = 0.02f;
  cfg.penMaxStep = 0.25f;
  cfg.normalYSlop = 0.02f;
  cfg.normalYAbort = 0.5f;
  cfg.penBeta = 0.8f;
  cfg.penSlop = 0.005f;
  cfg.maxLeverArm = 3.0f;
  cfg.restLowSpeed = 2.0f;
  cfg.restHighSpeed = 15.0f;
  cfg.penMaxSpeed = 8.0f;
  Check(true, "旧配置字段名（restLow/penMaxStep/normalYSlop…）仍可读写");

  // 废弃统计名 redirectedNormals 必须还在（旧调用方读它）
  ResolveStats st;
  st.redirectedNormals = 0;
  Check(st.redirectedNormals == st.flattenedNormals,
        "废弃统计名 redirectedNormals 与新名 flattenedNormals 初值一致");
}

// =============================================================================
//  §2 契约②：转发结果与直接调用权威实现**逐位一致**
// =============================================================================
void TestForwardingParity() {
  Section("§2 转发等价性（旧类名 == 直接调用 SafePhysicsSolver）");

  ResolverConfig cfg;
  const SolverConfig spec = cfg.ToNew();

  // A1: 法线平整化 —— 旧名 RedirectNormal 必须与 FlattenNormal 逐位相同
  {
    const Vec3 raw = Vec3(1.0f, 0.05f, 0.0f).Normalized();
    bool r1 = false, r2 = false;
    const Vec3 viaOld = SafeCollisionResolver::RedirectNormal(raw, ContactKind::CarToWall, cfg, &r1);
    const Vec3 viaNew = SafePhysicsSolver::FlattenNormal(raw, ContactKind::CarToWall, spec, &r2);
    Check(r1 == r2, "重定向标志一致");
    Check(BitEqual(viaOld.x, viaNew.x) && BitEqual(viaOld.y, viaNew.y) &&
              BitEqual(viaOld.z, viaNew.z),
          "平整化后的法线逐位一致",
          "old=(" + std::to_string(viaOld.x) + ") new=(" + std::to_string(viaNew.x) + ")");
    Check(BitEqual(viaOld.y, 0.0f), "平整化确实把 y 抹成 0");
  }

  // A2: 塑性恢复 —— 旧名 RestitutionFor 必须与 PlasticRestitution 逐位相同
  {
    bool allSame = true;
    for (float v = 0.0f; v <= 3.0f; v += 0.25f) {
      const float a = SafeCollisionResolver::RestitutionFor(v, cfg);
      const float b = SafePhysicsSolver::PlasticRestitution(v, spec);
      if (!BitEqual(a, b)) allSame = false;
    }
    Check(allSame, "塑性恢复曲线逐位一致（0~3 m/s 全程扫描）");

    // 并验证规格形状：阈值以上严格 0
    Check(BitEqual(SafeCollisionResolver::RestitutionFor(1.5f, cfg), 0.0f),
          "阈值 1.5 m/s 处 e == 0（完全非弹性段起点）");
    Check(BitEqual(SafeCollisionResolver::RestitutionFor(200.0f, cfg), 0.0f),
          "200 m/s 处 e == 0（高速严格无弹性）");
    const float e0 = SafeCollisionResolver::RestitutionFor(0.0f, cfg);
    Check(NearlyEqual(e0, 0.05f), "零速处 e = 0.05（低速轻碰质感）", "e0=" + std::to_string(e0));
  }

  // A3: 完整 Resolve 流程 —— 同初始状态必须导出同终态
  {
    RigidBodyView carA = MakeCar(0.0f, 0.0f, 0.0f);
    RigidBodyView carB = MakeCar(0.0f, 0.0f, 0.0f);
    carA.velocity = {50.0f, 0.0f, 0.0f};
    carB.velocity = {50.0f, 0.0f, 0.0f};

    ContactManifold mfA = MakeWallManifold(carA, 0.05f);
    ContactManifold mfB = MakeWallManifold(carB, 0.05f);
    ResolveStats stA, stB;

    SafeCollisionResolver::Resolve(mfA, 1.0f / 60.0f, cfg, &stA);
    SafePhysicsSolver::Resolve(mfB, 1.0f / 60.0f, spec, &stB);

    Check(BitEqual(carA.velocity.x, carB.velocity.x) &&
              BitEqual(carA.velocity.y, carB.velocity.y) &&
              BitEqual(carA.velocity.z, carB.velocity.z),
          "Resolve 后速度逐位一致（转发层不是第二个实现）",
          "old.vx=" + std::to_string(carA.velocity.x) +
              " new.vx=" + std::to_string(carB.velocity.x));
    Check(BitEqual(carA.position.x, carB.position.x) &&
              BitEqual(carA.position.y, carB.position.y),
          "Resolve 后位置逐位一致",
          "old.px=" + std::to_string(carA.position.x) +
              " new.px=" + std::to_string(carB.position.x));
    Check(stA.clampedNormal == stB.clampedNormal &&
              stA.flattenedNormals == stB.flattenedNormals &&
              stA.projected == stB.projected,
          "统计量一致（截断/平整化/投影计数）");
  }

  // A4: 分流 API 转发 —— SolveVelocityPhase / ProjectPenetration 各自等价
  {
    RigidBodyView a1 = MakeCar(0, 0, 0), a2 = MakeCar(0, 0, 0);
    a1.velocity = {30.0f, 0.0f, 0.0f};
    a2.velocity = {30.0f, 0.0f, 0.0f};
    ContactManifold m1 = MakeWallManifold(a1, 0.03f);
    ContactManifold m2 = MakeWallManifold(a2, 0.03f);
    ResolveStats s1, s2;

    const bool ok1 = SafeCollisionResolver::SolveVelocityPhase(m1, cfg, &s1);
    const bool ok2 = SafePhysicsSolver::SolveVelocityPhase(m2, spec, &s2);
    Check(ok1 == ok2 && BitEqual(a1.velocity.x, a2.velocity.x),
          "SolveVelocityPhase 转发等价", "ok=" + std::to_string(ok1));

    RigidBodyView b1 = MakeCar(0, 0, 0), b2 = MakeCar(0, 0, 0);
    ContactManifold n1 = MakeWallManifold(b1, 0.03f);
    ContactManifold n2 = MakeWallManifold(b2, 0.03f);
    ResolveStats t1, t2;
    SafeCollisionResolver::ProjectPenetration(n1, 1.0f / 60.0f, cfg, &t1);
    SafePhysicsSolver::ProjectPenetration(n2, 1.0f / 60.0f, spec, &t2);
    Check(BitEqual(b1.position.x, b2.position.x) && BitEqual(b1.position.y, b2.position.y),
          "ProjectPenetration 转发等价",
          "old.px=" + std::to_string(b1.position.x) +
              " new.px=" + std::to_string(b2.position.x));
  }

  // A5: ClampImpulse / ClampLeverArm 转发等价
  {
    bool c1 = false, c2 = false;
    const float j1 = SafeCollisionResolver::ClampImpulse(99999.0f, 40000.0f, &c1);
    const float j2 = SafePhysicsSolver::ClampImpulse(99999.0f, 40000.0f, &c2);
    Check(BitEqual(j1, j2) && c1 == c2, "ClampImpulse 转发等价",
          "j=" + std::to_string(j1));

    const Vec3 r = SafeCollisionResolver::ClampLeverArm(Vec3(10.0f, 0.0f, 0.0f), cfg);
    Check(NearlyEqual(r.Length(), 3.0f), "ClampLeverArm 仍把力臂压到 3.0m 上限",
          "|r|=" + std::to_string(r.Length()));
  }
}

// =============================================================================
//  §3 契约③：旧参数**无法**复活旧缺陷
// =============================================================================
void TestLegacyKnobsAreInert() {
  Section("§3 旧旋钮失效（用旧参数调不出旧缺陷）");

  // 造一个"把每个**旧**旋钮都设回旧诱人值"的配置。
  // ⚠ 只碰旧字段。maxNormalImpulse / maxPushPerSubstep / flattenStaticNormal /
  //    plasticThresholdSpeed / plasticPeakRestitution 是**规格字段**，
  //    改它们等同于配置新求解器（合理），不属于"旧旋钮复活"的测试范畴。
  ResolverConfig tempting;
  tempting.restLow = 0.90f;         // 旧版低速弹性（高得离谱）
  tempting.restHigh = 0.60f;        // 旧版高速弹性（正是"弹飞"元凶）
  tempting.restLowSpeed = 0.0f;     // 让高速段从 0 就生效
  tempting.restHighSpeed = 0.0f;
  tempting.penMaxStep = 0.25f;      // 旧版单帧瞬移 25cm
  tempting.penBeta = 1.0f;
  tempting.penMaxSpeed = 999.0f;
  tempting.normalYSlop = 0.0f;      // 关掉旧版的"小误差放行门"
  tempting.normalYAbort = 0.0f;
  tempting.maxLeverArm = 99.0f;     // 旧版力臂上限更松

  ResolverConfig clean;             // 全部规格默认值

  // B1: 高速撞击的恢复系数**不受** restHigh 影响
  {
    const float eTempting = SafeCollisionResolver::RestitutionFor(55.556f, tempting);
    const float eClean = SafeCollisionResolver::RestitutionFor(55.556f, clean);
    Check(BitEqual(eTempting, 0.0f), "把 restHigh 调到 0.6，200km/h 处 e 仍严格为 0",
          "e=" + std::to_string(eTempting));
    Check(BitEqual(eTempting, eClean), "被篡改的旧参数与规格参数结果一致（旧旋钮完全失效）");
  }

  // B2: 单子步推进上限**不受** penMaxStep / penBeta 影响
  {
    RigidBodyView c1 = MakeCar(0, 0, 0), c2 = MakeCar(0, 0, 0);
    ContactManifold m1 = MakeWallManifold(c1, 0.0f);
    ContactManifold m2 = MakeWallManifold(c2, 0.0f);
    m1.points[0].penetration = 0.30f;   // 深穿透
    m2.points[0].penetration = 0.30f;
    ResolveStats s1, s2;
    SafeCollisionResolver::ProjectPenetration(m1, 1.0f / 60.0f, tempting, &s1);
    SafeCollisionResolver::ProjectPenetration(m2, 1.0f / 60.0f, clean, &s2);

    const float d1 = std::fabs(c1.position.x);
    Check(d1 <= 0.03f + 1e-6f, "penMaxStep=0.25 被忽略，单子步推进仍 ≤ 3cm",
          "d=" + std::to_string(d1) + "m");
    Check(BitEqual(c1.position.x, c2.position.x),
          "篡改 penMaxStep/penBeta 后位移与规格参数逐位一致");
  }

  // B3: 法线平整化**不受** normalYSlop 影响（规格是"无条件"，没有门）
  {
    RigidBodyView c1 = MakeCar(0, 0, 0), c2 = MakeCar(0, 0, 0);
    // 极小 Y 分量：旧版 `normalYSlop` 门会放行
    ContactManifold m1 = MakeWallManifold(c1, 0.01f);
    ContactManifold m2 = MakeWallManifold(c2, 0.01f);
    ResolveStats s1, s2;
    SafeCollisionResolver::SolveVelocityPhase(m1, tempting, &s1);
    SafeCollisionResolver::SolveVelocityPhase(m2, clean, &s2);
    Check(BitEqual(s1.flattenedNormals, s2.flattenedNormals) && s1.flattenedNormals == 1,
          "y=0.01 的微小倒角也被无条件抹平（旧 normalYSlop 门失效）",
          "flat=" + std::to_string(s1.flattenedNormals));
  }

  // B4: 冲量上限取规格 4e4 —— 篡改**旧**字段（maxLeverArm / restHigh 等）
  //     不得改变截断阈值；只有规格字段 maxNormalImpulse 生效。
  {
    RigidBodyView ca = MakeCar(0, 0, 0), cb = MakeCar(0, 0, 0);
    // 200km/h 正撞静态墙 —— 所需冲量 ≈ 7.7e4 > 4e4，必然截断
    ca.velocity = {55.556f, 0.0f, 0.0f};
    cb.velocity = {55.556f, 0.0f, 0.0f};
    ContactManifold ma = MakeWallManifold(ca, 0.0f);
    ContactManifold mb = MakeWallManifold(cb, 0.0f);
    ResolveStats sa, sb;
    // 注意：tempting 里的 maxNormalImpulse 是**规格字段**（会生效），
    // 所以这里显式把它设回规格值，只保留旧字段被篡改。
    tempting.maxNormalImpulse = 40000.0f;
    SafeCollisionResolver::Resolve(ma, 1.0f / 60.0f, tempting, &sa);
    SafeCollisionResolver::Resolve(mb, 1.0f / 60.0f, clean, &sb);

    const float dva = 55.556f - ca.velocity.x;
    Check(sa.clampedNormal >= 1, "200km/h 撞墙触发 §5 硬截断");
    Check(dva <= 40000.0f / 1380.0f + 1e-3f,
          "单次 Δv ≤ maxNormalImpulse/m ≈ 28.99 m/s（4e4 硬上限生效）",
          "Δv=" + std::to_string(dva));
    Check(BitEqual(ca.velocity.x, cb.velocity.x),
          "篡改旧字段（maxLeverArm/penMaxStep/restHigh…）后终速与规格参数逐位一致");
    Check(sa.clampedNormal == sb.clampedNormal,
          "截断计数与规格参数一致（旧字段不影响阈值）");
  }

  // B5: 整体安全性质 —— 任何旧参数下都不得出现"速度放大 / 动能增长 / 被铲飞"
  {
    RigidBodyView car = MakeCar(0, 0, 0);
    car.velocity = {55.556f, 0.0f, 0.0f};   // 200km/h
    ContactManifold mf = MakeWallManifold(car, 0.20f);   // 11° 倒角
    ResolveStats st;
    const float e0 = KineticEnergy(car);
    SafeCollisionResolver::Resolve(mf, 1.0f / 60.0f, tempting, &st);
    const float e1 = KineticEnergy(car);

    Check(e1 <= e0 + 1e-3f, "动能严格不增（旧参数下同样零能量注入）",
          "ΔE=" + std::to_string(e1 - e0) + " J");
    Check(car.velocity.Length() <= 55.556f + 1e-3f, "速率未放大（无弹射）",
          "|v|=" + std::to_string(car.velocity.Length()));
    Check(BitEqual(car.velocity.y, 0.0f), "零垂直速度注入（车未被铲起）",
          "vy=" + std::to_string(car.velocity.y));
    Check(st.maxInjectedDeltaVy < 1e-5f, "★ 垂直 Δv 遥测为 0（防跳板生效）",
          "Δvy_max=" + std::to_string(st.maxInjectedDeltaVy));
  }
}

// =============================================================================
//  §4 下游依赖的两个"必须还能用"的点
// =============================================================================
void TestDownstreamContract() {
  Section("§4 下游契约（harness / 旧调用方依赖）");

  // C1: 旧统计名 redirectedNormals 必须与新名同步增长（harness 读旧名）
  {
    RigidBodyView car = MakeCar(0, 0, 0);
    car.velocity = {40.0f, 0.0f, 0.0f};
    ContactManifold mf = MakeWallManifold(car, 0.05f);
    ResolveStats st;
    SafeCollisionResolver::Resolve(mf, 1.0f / 60.0f, ResolverConfig{}, &st);
    Check(st.redirectedNormals == 1 && st.flattenedNormals == 1,
          "★ redirectedNormals 与 flattenedNormals 同步 +1（旧名不会静默失真）",
          "redirected=" + std::to_string(st.redirectedNormals) +
              " flattened=" + std::to_string(st.flattenedNormals));
  }

  // C2: 无泄漏 —— 转发层不得引入额外堆分配 / 虚调用（纯静态、零开销）
  {
    // 编译期性质：类不可实例化（= delete），且所有方法都是 static
    static_assert(!std::is_default_constructible_v<SafeCollisionResolver>,
                  "SafeCollisionResolver 不可实例化（纯静态转发壳）");
    Check(true, "SafeCollisionResolver 保持纯静态（不可构造，零状态）");
  }

  // C3: 规格量级自洽 —— 供 harness 断言引用的两条常数
  {
    const float vCap = 40000.0f / 1380.0f;
    Check(vCap > 20.0f && vCap < 40.0f,
          "4e4 N·s 折算 1380kg 车单次 Δv 上限落在 20~40 m/s（量级合理，可拦停 200km/h）",
          "vCap=" + std::to_string(vCap) + " m/s");
    // 深穿透收敛窗口：帧数 ≈ ceil((pen − slop)/cap)，0.30m 需 10 帧，
    // 落在规格"5~10 帧"窗口上沿。这里断言的是**算术规律**，不是魔法数。
    const float cap = 0.03f, slop = 0.005f, pen = 0.30f;
    const float frames = std::ceil((pen - slop) / cap);
    Check(frames >= 5.0f && frames <= 10.0f,
          "0.30m 深穿透按 0.03m/子步上限在 5~10 帧窗口内推完（规格 §3 自洽）",
          "frames=" + std::to_string(frames));
  }
}

// =============================================================================
//  main
// =============================================================================
int main() {
  std::printf("=============================================================\n");
  std::printf(" SafeCollisionResolver —— 【已废弃】转发层回归测试\n");
  std::printf(" 权威实现与完整验收见 native/safe_physics/safe_physics_test.cpp\n");
  std::printf("=============================================================\n");

  TestSourceCompatibility();
  TestForwardingParity();
  TestLegacyKnobsAreInert();
  TestDownstreamContract();

  std::printf("\n-----------------------------------------------------------------\n");
  std::printf("结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  if (g_fail == 0) {
    std::printf("全部通过（转发层契约成立，旧缺陷不可复活）\n");
  } else {
    std::printf("存在失败项 —— 转发层未满足契约\n");
  }
  return g_fail == 0 ? 0 : 1;
}
