// 诊断：用现有 SafeCollisionResolver 复现用户报告的"撞墙被弹飞"现象。
// 只做诊断，不作为交付物。
#include "safe_collision_resolver.h"

#include <cmath>
#include <cstdio>

using namespace forza::physics;

static RigidBodyView MakeCar(float x, float z, float vx, float vz) {
  RigidBodyView b;
  b.position = {x, 0.45f, z};
  b.velocity = {vx, 0.0f, vz};
  b.invMass = 1.0f / 1380.0f;
  b.invInertia = 1.0f / 1800.0f;
  return b;
}

static void Report(const char* tag, float vnBefore, float vnAfter, float vy) {
  std::printf("%-34s  v_rel(before)=%+8.3f  v_rel(after)=%+8.3f  Δ=%+8.3f  vy_out=%+7.3f\n",
              tag, vnBefore, vnAfter, vnAfter - vnBefore, vy);
}

int main() {
  ResolverConfig cfg;
  const float kmh = 1.0f / 3.6f;
  const float v200 = 200.0f * kmh;   // 55.556 m/s
  std::printf("== 现状探针：SafeCollisionResolver 出厂配置 ==\n");
  std::printf("   restLow=%.2f  restHigh=%.2f  loSpeed=%.0f  hiSpeed=%.0f  maxJ=%.0f  NySlop=%.2f\n\n",
              cfg.restLow, cfg.restHigh, cfg.restLowSpeed, cfg.restHighSpeed,
              cfg.maxNormalImpulse, cfg.normalYSlop);

  // ---- 1) 200km/h 正撞静态墙（法线严格水平，无倒角）----
  {
    RigidBodyView car = MakeCar(0.0f, 0.0f, -v200, 0.0f);
    RigidBodyView wall;
    ContactManifold mf;
    mf.a = &car; mf.b = &wall; mf.kind = ContactKind::CarToWall;
    mf.normal = {0.0f, 0.0f, 1.0f};           // A(车) -> B(墙) = +z
    mf.pointCount = 1;
    mf.points[0] = {{0.0f, 0.0f, 0.0f}, {}, 0.05f, 0.0f, 0.0f};
    const float vnBefore = car.velocity.Dot(mf.normal);
    SafeCollisionResolver::SolveVelocityPhase(mf, cfg, nullptr);
    const float vnAfter = car.velocity.Dot(mf.normal);
    Report("200km/h 正撞墙 (n 水平)", vnBefore, vnAfter, car.velocity.y);
  }

  // ---- 2) 200km/h 正撞墙 + 真实倒角 8°（法线带 +Y）----
  {
    RigidBodyView car = MakeCar(0.0f, 0.0f, -v200, 0.0f);
    RigidBodyView wall;
    ContactManifold mf;
    mf.a = &car; mf.b = &wall; mf.kind = ContactKind::CarToWall;
    const float a = 8.0f * 3.14159265f / 180.0f;
    mf.normal = Vec3(0.0f, std::sin(a), std::cos(a)).Normalized();
    mf.pointCount = 1;
    mf.points[0] = {{0.5f, 0.0f, 0.0f}, {}, 0.05f, 0.0f, 0.0f};   // 力臂 0.5m
    const float vnBefore = car.velocity.Dot(Vec3(0.0f, 0.0f, 1.0f));
    SafeCollisionResolver::SolveVelocityPhase(mf, cfg, nullptr);
    const float vnAfter = car.velocity.Dot(Vec3(0.0f, 0.0f, 1.0f));
    Report("200km/h 正撞墙 (倒角 8°)", vnBefore, vnAfter, car.velocity.y);
  }

  // ---- 3) 四角同时接触（一点带 +Y、三点水平）—— 真实护栏的多点流形 ----
  {
    RigidBodyView car = MakeCar(0.0f, 0.0f, -v200, 0.0f);
    RigidBodyView wall;
    ContactManifold mf;
    mf.a = &car; mf.b = &wall; mf.kind = ContactKind::CarToWall;
    mf.normal = {0.0f, 0.0f, 1.0f};
    mf.pointCount = 4;
    mf.points[0] = {{0.5f, 0.0f,  -1.2f}, {}, 0.05f, 0.0f, 0.0f};
    mf.points[1] = {{-0.5f, 0.0f, -1.2f}, {}, 0.05f, 0.0f, 0.0f};
    mf.points[2] = {{0.5f, 0.0f,   1.2f}, {}, 0.05f, 0.0f, 0.0f};
    mf.points[3] = {{-0.5f, 0.0f,  1.2f}, {}, 0.05f, 0.0f, 0.0f};
    const float vnBefore = car.velocity.Dot(mf.normal);
    SafeCollisionResolver::SolveVelocityPhase(mf, cfg, nullptr);
    const float vnAfter = car.velocity.Dot(mf.normal);
    Report("200km/h 正撞墙 (4 点流形)", vnBefore, vnAfter, car.velocity.y);
    std::printf("%-34s  ω=(%+.3f, %+.3f, %+.3f) rad/s  |v|=%.2f m/s (入射 %.2f)\n",
                "  -> 角速度 / 速率", car.angularVelocity.x, car.angularVelocity.y,
                car.angularVelocity.z, car.velocity.Length(), v200);
  }

  // ---- 4) 200km/h 侧撞：两车等质量、法向横向 ----
  {
    RigidBodyView a = MakeCar(-1.0f, 0.0f, 0.0f, -30.0f);
    RigidBodyView b = MakeCar(1.0f, 0.0f, 0.0f, -30.0f);
    a.velocity = {v200, 0.0f, -30.0f};      // A 以 200km/h 横向撞向 B
    b.velocity = {0.0f, 0.0f, -30.0f};
    ContactManifold mf;
    mf.a = &a; mf.b = &b; mf.kind = ContactKind::CarToCar;
    mf.normal = {1.0f, 0.0f, 0.0f};
    mf.pointCount = 1;
    mf.points[0] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, 0.05f, 0.0f, 0.0f};
    const float vnBefore = (a.velocity - b.velocity).Dot(mf.normal);
    SafeCollisionResolver::SolveVelocityPhase(mf, cfg, nullptr);
    const float vnAfter = (a.velocity - b.velocity).Dot(mf.normal);
    Report("200km/h 侧撞 (等质量)", vnBefore, vnAfter, a.velocity.y);
  }

  // ---- 5) 头部对撞：两车各 100km/h 相向 ----
  {
    const float v100 = 100.0f * kmh;
    RigidBodyView a = MakeCar(-2.0f, 0.0f, v100, 0.0f);
    RigidBodyView b = MakeCar(2.0f, 0.0f, -v100, 0.0f);
    ContactManifold mf;
    mf.a = &a; mf.b = &b; mf.kind = ContactKind::CarToCar;
    mf.normal = {1.0f, 0.0f, 0.0f};
    mf.pointCount = 1;
    mf.points[0] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, 0.05f, 0.0f, 0.0f};
    const float vnBefore = (a.velocity - b.velocity).Dot(mf.normal);
    SafeCollisionResolver::SolveVelocityPhase(mf, cfg, nullptr);
    const float vnAfter = (a.velocity - b.velocity).Dot(mf.normal);
    Report("头部对撞 (各 100km/h)", vnBefore, vnAfter, a.velocity.y);
    std::printf("%-34s  va=(%+.2f,%+.2f,%+.2f) vb=(%+.2f,%+.2f,%+.2f)\n", "  -> 碰后速度",
                a.velocity.x, a.velocity.y, a.velocity.z,
                b.velocity.x, b.velocity.y, b.velocity.z);
  }

  // ---- 6) 深穿透 0.30m + 多帧位置相：观察单步位移 ----
  {
    RigidBodyView car = MakeCar(0.0f, 0.0f, -v200, 0.0f);
    RigidBodyView wall;
    ContactManifold mf;
    mf.a = &car; mf.b = &wall; mf.kind = ContactKind::CarToWall;
    mf.normal = {0.0f, 0.0f, 1.0f};
    mf.pointCount = 1;
    mf.points[0] = {{0.0f, 0.0f, 0.0f}, {}, 0.30f, 0.0f, 0.0f};
    std::printf("\n-- 位置相单步位移（pen=0.30m, dt=1/60）--\n");
    float pen = 0.30f;
    for (int frame = 0; frame < 6; ++frame) {
      mf.points[0].penetration = pen;
      const float z0 = car.position.z;
      SafeCollisionResolver::ProjectPenetration(mf, 1.0f / 60.0f, cfg, nullptr);
      const float moved = std::fabs(car.position.z - z0);
      pen -= moved;                       // 简化：位移即消除的穿透
      std::printf("   frame %d: moved=%.4f m, 残余 pen=%.4f m\n", frame, moved, pen);
    }
  }

  return 0;
}
