// =============================================================================
//  safe_collision_resolver.h —— 【已废弃 / DEPRECATED】向后兼容转发层
//
//  ⚠ 本文件**不再包含任何实现**。全部算法已迁移至：
//
//        native/safe_physics/safe_physics_solver.h  （SafePhysicsSolver）
//
//  保留本文件与旧类名 `SafeCollisionResolver` 的唯一目的：
//    · `native/harness/simulation_harness.cpp` 以 `-I safe_collision` 引用它；
//    · `native/run_tests.sh` 的 [4/6] 节仍编译旧测试；
//    · 避免在一次改动里同时触碰"算法"与"调用方接线"两件事（回退风险）。
//
//  ── 为什么迁移（旧实现的四个缺陷）─────────────────────────────────────────
//  旧 `SafeCollisionResolver` 已覆盖四点中的三点（法线重定向 / 速度自适应恢复 /
//  分离冲量 / 冲量截断），但存在**四 处**与工业级要求的偏差：
//
//    ① 法线重定向有 `normalYSlop = 0.02` 的**放行门**：
//       倒角误差小于 0.02 时原样放行。而 J = 4e4 N·s 时
//       Δv_y = 4e4 × 0.02/1380 ≈ 0.58 m/s —— "小误差 × 大冲量"完全不可忽略。
//       新实现改为**无条件**抹平。
//    ② 高速恢复系数 `restHigh = 0.02` 而非 0：
//       200km/h 下仍有 0.02 × 55.6 = 1.11 m/s 的回弹。
//       新实现阈值以上**严格为 0**（完全非弹性）。
//    ③ 位置相单步上限 `penMaxStep = 0.25 m`：
//       一帧可瞬移 25cm，视觉上是"闪现"。新实现收到 0.03 m。
//    ④ 冲量上限 5e4 → 4e4 N·s（规格值），并**单独统计垂直冲量增量**
//       （旧版只统计总 Δv，无法发现"被铲飞"：垂直分力不改速率大小）。
//    另：**悬挂解耦保护**为全新能力（旧版完全没有）。
//
//  ── 转发的映射关系 ────────────────────────────────────────────────────────
//    SafeCollisionResolver::RedirectNormal  -> SafePhysicsSolver::FlattenNormal
//    SafeCollisionResolver::RestitutionFor  -> SafePhysicsSolver::PlasticRestitution
//    SafeCollisionResolver::SolveVelocityPhase -> 同名
//    SafeCollisionResolver::ProjectPenetration -> 同名
//    SafeCollisionResolver::ClampImpulse    -> 同名
//    SafeCollisionResolver::ClampLeverArm   -> 同名
//    SafeCollisionResolver::Resolve         -> 同名
//
//  ⚠ 参数语义有差异（见上），因此**旧测试的若干断言必须同步更新**，
//    否则会假失败或假通过。旧测试文件已同步改写为直接测试新求解器。
//
//  建议：新代码一律 `#include "safe_physics_solver.h"` 并直接用
//        `forza::physics::SafePhysicsSolver`，不要再用本头文件。
// =============================================================================
#pragma once

// 转发层只做类型别名与方法转发，实现全部来自新模块。
#include "../safe_physics/safe_physics_solver.h"

namespace forza::physics {

// -----------------------------------------------------------------------------
//  类型别名：旧名 -> 新名（保持 harness 与旧测试的 aggregate-init 语义不变）
// -----------------------------------------------------------------------------

/// 旧配置结构体名。**这是一个独立的 struct，不再继承 `SolverConfig`**
/// （`SolverConfig` 被声明为 `final`，继承会编译失败）。
///
/// 设计取舍 —— 它必须同时满足两件互相拉扯的事：
///   ① **能真正配置新求解器**：harness 以 `ResolverConfig{}` 传入并期望拿到
///      规格行为（无条件抹平 / 阈值以上 e=0 / 3cm 推进 / 4e4 截断），
///      所以前面那组字段就是新规格字段，取值也必须是规格值。
///   ② **旧字段名仍可编译**：下游旧测试会读 `cfg.restLow` / `cfg.penMaxStep`
///      这类**数据成员**，所以这里必须保留为**数据成员**（不能改成函数，
///      否则 `cfg.restLow` 表达式类型变化 → 旧代码编译失败）。
///      它们排在规格字段之后，`ResolverConfig{}` 的 aggregate-init 不受影响。
///
/// ⚠ 关键安全性质：**旧数据成员一律不参与 `ToNew()`**。也就是说，
///   即便调用方手工把 `cfg.restLow = 0.9f`，新求解器也**不会**恢复弹性 ——
///   这正是"用旧参数调不出旧缺陷"的保证。
struct ResolverConfigLegacy final {
  // ── 真正生效的规格字段（= SolverConfig 的对应项，取规格值）───────────────
  bool flattenStaticNormal = true;          ///< §1 无条件平整化
  float plasticThresholdSpeed = 1.5f;       ///< §2 阈值 (m/s)
  float plasticPeakRestitution = 0.05f;     ///< §2 低速峰值恢复系数
  float maxPushPerSubstep = 0.03f;          ///< §3 单子步最大推进 (m)
  float maxNormalImpulse = 40000.0f;        ///< §5 法向冲量硬上限 (N·s)

  // ── 其余字段沿用 SolverConfig 的规格默认值（显式写出，便于审计对照）──────
  float normalFlatEps = 1e-6f;
  float positionBeta = 0.8f;
  float penetrationSlop = 0.005f;
  float maxTangentImpulse = 20000.0f;
  float friction = 0.55f;
  float suspensionLockSlack = 0.15f;
  float suspensionMaxTravel = 0.30f;
  float shellContactMinSpeed = 1.0f;

  // ── 旧字段名（**只读兼容占位，不参与 ToNew()**）──────────────────────────
  // 仅用于让旧测试/旧调用方源码继续编译，以及回答"旧参数现在映射到哪"。
  // 改它们**不会**改变新求解器行为（见结构体说明）。
  float normalYSlop = 0.02f;
  float normalYAbort = 0.5f;
  float restLow = 0.35f;
  float restHigh = 0.02f;
  float restLowSpeed = 2.0f;
  float restHighSpeed = 15.0f;
  float penBeta = 0.8f;
  float penMaxSpeed = 8.0f;
  float penSlop = 0.005f;
  float penMaxStep = 0.25f;
  float maxLeverArm = 3.0f;

  /// 隐式转换为新求解器的配置视图 —— 让 `ResolverConfig{}` 能直接喂给
  /// `SafePhysicsSolver::Resolve(mf, dt, cfg, stats)`。
  [[nodiscard]] SolverConfig ToNew() const noexcept {
    SolverConfig c;
    c.flattenStaticNormal = flattenStaticNormal;
    c.normalFlatEps = normalFlatEps;
    c.plasticThresholdSpeed = plasticThresholdSpeed;
    c.plasticPeakRestitution = plasticPeakRestitution;
    c.maxPushPerSubstep = maxPushPerSubstep;
    c.positionBeta = positionBeta;
    c.penetrationSlop = penetrationSlop;
    c.maxNormalImpulse = maxNormalImpulse;
    c.maxTangentImpulse = maxTangentImpulse;
    c.friction = friction;
    c.suspensionLockSlack = suspensionLockSlack;
    c.suspensionMaxTravel = suspensionMaxTravel;
    c.shellContactMinSpeed = shellContactMinSpeed;
    return c;
  }
};

/// 旧配置名直接指向旧结构体（harness 用 `ResolverConfig{}` 构造）。
using ResolverConfig = ResolverConfigLegacy;

// 其余类型名完全复用新模块（布局一致，aggregate init 仍可用）
using Vec3 = forza::physics::Vec3;
using RigidBodyView = forza::physics::RigidBodyView;
using ContactPoint = forza::physics::ContactPoint;
using ContactManifold = forza::physics::ContactManifold;
using ContactKind = forza::physics::ContactKind;
using ResolveStats = forza::physics::SolveStats;

// -----------------------------------------------------------------------------
//  SafeCollisionResolver —— 静态转发壳
// -----------------------------------------------------------------------------
/**
 * 全部方法 inline 转发到 `SafePhysicsSolver`。
 *
 * ⚠ 注意：转发时**只读取新旧同名的字段**（friction / maxNormalImpulse /
 *   maxTangentImpulse），其余参数一律用新实现的默认值 ——
 *   因为旧字段（normalYSlop / restLow / penMaxStep …）在新算法里没有对应概念，
 *   强行映射会重新引入被删掉的缺陷。
 *
 *   这意味着一件事必须讲清楚：**用旧类名调用得到的是新行为**。
 *   这是有意的 —— 这个模块存在的意义就是"零反弹"，而不是"保持旧参数可调"。
 */
class SafeCollisionResolver final {
 public:
  SafeCollisionResolver() = delete;

  /// 旧名 RedirectNormal -> 新名 FlattenNormal
  [[nodiscard]] static Vec3 RedirectNormal(const Vec3& n,
                                           ContactKind kind,
                                           const SolverConfig& cfg,
                                           bool* outRedirected = nullptr) noexcept {
    return SafePhysicsSolver::FlattenNormal(n, kind, cfg, outRedirected);
  }

  /// 旧配置形态重载（`ResolverConfigLegacy`）
  [[nodiscard]] static Vec3 RedirectNormal(const Vec3& n,
                                           ContactKind kind,
                                           const ResolverConfigLegacy& cfg,
                                           bool* outRedirected = nullptr) noexcept {
    const SolverConfig c = cfg.ToNew();
    return SafePhysicsSolver::FlattenNormal(n, kind, c, outRedirected);
  }

  /// 旧名 RestitutionFor -> 新名 PlasticRestitution
  /// ⚠ 曲线形状不同：旧版 smoothstep（低速 0.35 -> 高速 0.02），
  ///    新版线性（e_peak·(1−v/thres) -> 阈值以上严格 0）。
  [[nodiscard]] static float RestitutionFor(float approachSpeed,
                                            const SolverConfig& cfg) noexcept {
    return SafePhysicsSolver::PlasticRestitution(approachSpeed, cfg);
  }

  /// 旧配置形态重载（`ResolverConfigLegacy`）
  [[nodiscard]] static float RestitutionFor(float approachSpeed,
                                            const ResolverConfigLegacy& cfg) noexcept {
    const SolverConfig c = cfg.ToNew();
    return SafePhysicsSolver::PlasticRestitution(approachSpeed, c);
  }

  // ── 以下重载接受**旧的 `ResolverConfigLegacy`**，内部 `ToNew()` 后转发。
  //    这是 harness / 旧测试仍在用的入口形态（`ResolverConfig{}` 直传）。
  static bool SolveVelocityPhase(ContactManifold& mf,
                                 const ResolverConfigLegacy& cfg,
                                 SolveStats* stats = nullptr) noexcept {
    const SolverConfig c = cfg.ToNew();
    return SafePhysicsSolver::SolveVelocityPhase(mf, c, stats);
  }

  static bool ProjectPenetration(ContactManifold& mf,
                                 float dt,
                                 const ResolverConfigLegacy& cfg,
                                 SolveStats* stats = nullptr) noexcept {
    const SolverConfig c = cfg.ToNew();
    return SafePhysicsSolver::ProjectPenetration(mf, dt, c, stats);
  }

  static void Resolve(ContactManifold& mf,
                      float dt,
                      const ResolverConfigLegacy& cfg,
                      SolveStats* stats = nullptr) noexcept {
    const SolverConfig c = cfg.ToNew();
    SafePhysicsSolver::Resolve(mf, dt, c, stats);
  }

  // ── 新配置形态的重载（新代码可直接传 `SolverConfig`）──────────────────────
  static bool SolveVelocityPhase(ContactManifold& mf,
                                 const SolverConfig& cfg,
                                 SolveStats* stats = nullptr) noexcept {
    return SafePhysicsSolver::SolveVelocityPhase(mf, cfg, stats);
  }

  static bool ProjectPenetration(ContactManifold& mf,
                                 float dt,
                                 const SolverConfig& cfg,
                                 SolveStats* stats = nullptr) noexcept {
    return SafePhysicsSolver::ProjectPenetration(mf, dt, cfg, stats);
  }

  static void Resolve(ContactManifold& mf,
                      float dt,
                      const SolverConfig& cfg,
                      SolveStats* stats = nullptr) noexcept {
    SafePhysicsSolver::Resolve(mf, dt, cfg, stats);
  }

  [[nodiscard]] static float ClampImpulse(float j, float maxImpulse,
                                          bool* outClamped = nullptr) noexcept {
    return SafePhysicsSolver::ClampImpulse(j, maxImpulse, outClamped);
  }

  [[nodiscard]] static Vec3 ClampLeverArm(const Vec3& r,
                                          const SolverConfig& cfg,
                                          SolveStats* stats = nullptr) noexcept {
    return SafePhysicsSolver::ClampLeverArm(r, cfg, stats);
  }

  /// 旧配置形态重载（`ResolverConfigLegacy`）
  [[nodiscard]] static Vec3 ClampLeverArm(const Vec3& r,
                                          const ResolverConfigLegacy& cfg,
                                          SolveStats* stats = nullptr) noexcept {
    const SolverConfig c = cfg.ToNew();
    return SafePhysicsSolver::ClampLeverArm(r, c, stats);
  }
};

}  // namespace forza::physics
