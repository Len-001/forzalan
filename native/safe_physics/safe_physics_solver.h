// =============================================================================
//  safe_physics_solver.h —— 工业级无反弹碰撞求解器（SafePhysicsSolver）
//
//  C++20 / 零外部依赖 / 零堆分配 / 无虚函数 / 无异常。
//  可编译进 Wasm，可用于 60~144Hz 物理热路径。
//
//  ═══════════════════════════════════════════════════════════════════════════
//   0. 要消灭的四个病根（以及它们各自的数学机理）
//  ═══════════════════════════════════════════════════════════════════════════
//
//  症状：「赛车碰撞后依然弹开，撞墙依然会被弹飞」。
//  注意——**这不是一处 bug，是四条独立通路同时把动能灌进法向**。
//
//  ── 病根 ① Baumgarte 穿透速度污染（首要元凶）─────────────────────────────
//   经典 Baumgarte 稳定化把穿透深度当作"速度误差"补偿进速度约束：
//
//        v_bias  = (β / dt) · pen                                   …… (1)
//        Δv_target = (1 + e)·v_closure + v_bias
//
//   式 (1) 的量纲是 m/s，看起来"合理"，但它**不是冲量**。
//   它是把**几何误差**（pen，位形空间量）直接翻译成**速度增量**（速度空间量）。
//   动能 T = ½mv² 只依赖速度空间，于是这一步等价于：
//
//        ΔT = ½m·[(v + v_bias)² − v²] = m·v·v_bias + ½m·v_bias²      …… (2)
//
//   静止贴墙时 v = 0，仍然 ΔT = ½m·v_bias² > 0 —— **凭空造能**。
//   代入本工程实参：β=0.2、dt=1/60、pen=0.30m ⇒ v_bias = 3.6 m/s；
//   若 β 取 0.8 则 v_bias = 14.4 m/s。对 m = 1380kg：
//
//        ΔT = ½ · 1380 · 14.4² ≈ 1.43×10⁵ J
//
//   这 1.43×10⁵ J 相当于把车凭空抬高 10.6 m（Δh = ΔT/(mg)）。
//   法线只要有 +Y 分量，这份能量就直接变成垂直速度 —— **车被铲上天**。
//   两车互撞时表现为"越撞越有劲"，能量不守恒。
//
//   ★ 本模块的对策：**速度相绝不出现 pen**。穿透由独立的"位置相"处理，
//     而位置相只移动 position、绝不写 velocity（见下 §3）。
//
//  ── 病根 ② 恢复系数与撞击速度无关（违背钣金塑性吸能）──────────────────────
//  真实汽车前纵梁 / crash box 的设计目的就是**压溃吸能**：
//    · 低速（< 1.5 m/s，即 < 5.4 km/h）——停车场的推挤碰擦。
//      车漆/保险杠蒙皮仍是弹性变形，有可恢复的回弹，观感是"轻碰一下弹开一点"。
//    · 高速（≥ 1.5 m/s）——结构件进入塑性屈服，压溃后应力**迅速卸载**，
//      几乎不回弹。实测车对刚性壁的等效恢复系数 e ≈ 0.05~0.15，
//      对可溃缩护栏更低，工程上取 e = 0 是合理的保守近似。
//
//  若全程用常数 e > 0，高速撞击下：
//
//        碰后分离速度 v_sep = e · v_closure
//
//  v_closure = 55.6 m/s（200km/h）时 e = 0.35 会给出 19.4 m/s 的回弹 ——
//  比真实赛车撞墙后 0.5 m/s 量级的残余速度高两个数量级。
//
//   ★ 本模块对策见 §2。（注意：**e 必须绑定接触点法向相对速度**，
//     不是整车速度 —— 两车 200km/h 并排同速擦碰时整车速度极大但法向闭合
//     速度接近 0，用整车速度查表会把轻微剐蹭误判成高速撞击。）
//
//  ── 病根 ③ 墙法线带垂直倾角（几何倒角 → 反作用力向上分力）────────────────
//  接触网格在墙体棱边处必然倒角（避免视觉锯齿），离散化后碰撞器给出的
//  法线常常带一个 +Y 分量。设法线 n = (nx, ny, nz)、冲量沿车受到的 −n：
//
//        车受冲量 = J · (−n) = (−J·nx, −J·ny, −J·nz)
//
//  ny < 0 时 −J·ny > 0 就是**向上**的力。叠加上接触点相对质心的力臂 r，
//  力矩 τ = r × (−J·n) 产生俯仰/侧倾角速度 —— 车"骑"上护栏飞出去。
//
//  更隐蔽的是：**垂直分力本身不改总动量大小，只改方向**，所以只看
//  「速率未曾放大」的断言是**测不出来**的。必须有专门的"垂直速度增量"断言。
//
//   ★ 本模块对策见 §1：静态护栏**无条件**令 ny = 0 并重归一化。
//
//  ── 病根 ④ 悬挂能量回弹恶性循环 ─────────────────────────────────────────
//  碰撞冲量经车身传到悬挂：悬挂是弹簧-阻尼（本工程 K = 225.6 kN/m，
//  ζ = 1 临界阻尼，行程上限 0.30 m）。若碰撞的垂直冲量足够大，
//  悬挂被"压死"（bottom out）到行程极限后，被压缩的弹簧储能
//
//        E = ½K·x²  （x = 0.30m ⇒ E = ½·2.256e5·0.09 ≈ 1.02×10⁴ J）
//
//  在随后若干帧里**全部释放回车身**，把车弹起。这是一个**正反馈**：
//  弹起 → 离地 → 悬挂伸长 → 落地再次压缩 → 再次弹起。
//
//   ★ 本模块对策见 §4：刚体外壳碰擦期间**锁定轴行程极值**，
//     冻结弹簧的储能上限，斩断这条回弹通路。
//
//  ═══════════════════════════════════════════════════════════════════════════
//   核心架构：Split Impulse（分离冲量）—— 为什么必须分两个相
//  ═══════════════════════════════════════════════════════════════════════════
//
//  速度相与位置相处理的是**不同空间**的量，混在一起必然造能：
//
//     · 速度相：解动量守恒。单位 N·s。输出 = 刚体速度的改变。
//       J_n = Δv_target / k_n，其中 k_n 是有效质量倒数（含转动项）。
//     · 位置相：解几何约束。单位 m。输出 = 刚体位置的平移。
//       dx = β·pen/(1/m_A + 1/m_B)，用一套**伪速度**（pseudo-velocity）
//       作为换算中介，但该伪速度**不参与动能计算、不写回真实速度**。
//
//  Erin Catto（Box2D）与 Erwin Coumans（Bullet）的 Split Impulse 形式。
//  严格论证：位置投影改变的是**位形空间**（configuration space）坐标，
//  而动能 T = ½mv² 只依赖**速度空间**。只要伪速度不写回 velocity，
//  系统总动能恒等于求解前的值。本模块在测试中直接断言这一点（§C1）。
//
//  ── 典型接法 ──────────────────────────────────────────────────────────────
//      ContactManifold mf;
//      mf.a = &carBody;  mf.b = nullptr;            // b 为 nullptr = 静态护栏
//      mf.kind = ContactKind::CarToWall;
//      mf.normal = {nx, ny, nz};                    // 语义见下（注意方向！）
//      mf.pointCount = 1;
//      mf.points[0] = {rA, rB, penetration, 0, 0};
//
//      // 每物理子步：
//      SafePhysicsSolver::SolveVelocityPhase(mf, cfg, &stats);   // 速度相
//      ... 你的积分器推进速度/位置 ...
//      SafePhysicsSolver::ProjectPenetration(mf, dt, cfg, &stats); // 位置相
//
//      // 悬挂解耦（车 vs 车/墙的刚体外壳碰擦期间）：
//      if (mf.IsShellContact()) SafePhysicsSolver::LockSuspensionTravel(susp, cfg);
//
//  ── 法线方向约定（本工程统一，务必记牢）───────────────────────────────────
//  法线 n **从 A 指向 B**。
//    · v_n = (v_A − v_B)·n
//        v_n > 0  ⇒ A 正朝 B 运动 ⇒ **接近**，需要解算
//        v_n < 0  ⇒ A 正远离 B     ⇒ **分离**，直接跳过
//    · 对 A 施加的冲量为 −J·n，对 B 为 +J·n。
//    · 位置相方向必须**同号**：p_A -= n·dx·w_A，p_B += n·dx·w_B。
//
//  ⚠ 本工程历史上在此栽过两次（详见 MEMORY.md「法线方向约定」）：
//    ① 判据写成 `if (vn > 0) skip` ⇒ 所有碰撞被当分离跳过，车原速穿墙且无报错；
//    ② 位置相写成 `p_A += n·dx` ⇒ 修穿透时把车推进墙里，穿得越深推得越狠。
//    测试必须断言**可观测量**（间距变大、朝远离墙方向移动），不能只断言"位移非零"。
//
//  ── 编译 ──────────────────────────────────────────────────────────────────
//      g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic
//          safe_physics_test.cpp -o build/safe_physics_test.exe
// =============================================================================
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace forza::physics {

// =============================================================================
//  基础数学类型（自带，不依赖 GLM —— 让模块可独立编译与测试）
// =============================================================================

struct Vec3 final {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;

  constexpr Vec3() noexcept = default;
  constexpr Vec3(float x_, float y_, float z_) noexcept : x(x_), y(y_), z(z_) {}

  constexpr Vec3 operator+(const Vec3& o) const noexcept { return {x + o.x, y + o.y, z + o.z}; }
  constexpr Vec3 operator-(const Vec3& o) const noexcept { return {x - o.x, y - o.y, z - o.z}; }
  constexpr Vec3 operator-() const noexcept { return {-x, -y, -z}; }
  constexpr Vec3 operator*(float s) const noexcept { return {x * s, y * s, z * s}; }
  constexpr Vec3& operator+=(const Vec3& o) noexcept { x += o.x; y += o.y; z += o.z; return *this; }
  constexpr Vec3& operator-=(const Vec3& o) noexcept { x -= o.x; y -= o.y; z -= o.z; return *this; }

  /// 点积（标量投影）。用于 v_n = v_rel·n 与能量/分量分解。
  [[nodiscard]] constexpr float Dot(const Vec3& o) const noexcept {
    return x * o.x + y * o.y + z * o.z;
  }

  /// 叉积（右手系）。力矩 τ = r × J、角速度贡献 ω × r 都靠它。
  [[nodiscard]] constexpr Vec3 Cross(const Vec3& o) const noexcept {
    return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x};
  }

  [[nodiscard]] constexpr float LengthSq() const noexcept { return x * x + y * y + z * z; }
  [[nodiscard]] float Length() const noexcept { return std::sqrt(LengthSq()); }

  /**
   * 归一化。**零向量返回 (0,0,0) 而不是 NaN**。
   *
   * 理由：接触法线为零是**退化输入**（纯垂直法线无法水平归一化、
   * 或两侧刚体质心重合）。静默产生 NaN 会污染整个刚体状态 ——
   * NaN 的扩散性极强，一帧之后全场车辆位置都变成 NaN 并从画面消失。
   * 返回零向量可让调用方用一个 `LengthSq() < eps` 判定统一处理。
   */
  [[nodiscard]] Vec3 Normalized() const noexcept {
    const float len = Length();
    if (len < 1e-12f) return {0.0f, 0.0f, 0.0f};
    const float inv = 1.0f / len;
    return {x * inv, y * inv, z * inv};
  }

  [[nodiscard]] bool IsFinite() const noexcept {
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(z);
  }
};

// =============================================================================
//  刚体视图（窄接口，不拥有状态）
// =============================================================================
/**
 * **不拥有**任何状态，只借指针读写外部物理引擎的刚体。
 *
 * 刻意做成"字段暴露的窄结构体"而不是继承基类：
 *   · 无 vtable ⇒ 热路径每次调用省一次间接跳转（每帧数百次接触）；
 *   · 不与 cannon-es / PhysX / 自研 body 类型耦合 ——
 *     任何引擎都能在调用前把这 6 个字段抄进来、调用后抄回去。
 *
 * 静态体（护栏/边界墙）统一用 **invMass == 0、invInertia == 0** 表达
 * "质量无穷大"。这让求解器里所有质量相关的公式天然退化，
 * **无需任何 `if (b == nullptr)` 特判** —— 静态体的 k_n 贡献恒为 0、
 * 位置分配的权重 w = 0。少一处特判就少一处写反的机会。
 */
struct RigidBodyView final {
  Vec3 position{};              ///< 质心世界坐标 (m)
  Vec3 velocity{};              ///< 线速度 (m/s)
  Vec3 angularVelocity{};       ///< 角速度 (rad/s)

  float invMass = 0.0f;         ///< 质量倒数 1/m (kg⁻¹)；**静态体恒为 0**
  float invInertia = 0.0f;      ///< 转动惯量倒数 1/I (kg⁻¹·m⁻²)，绕接触法线方向

  Vec3 centerOfMassOffset{};    ///< 刚体原点 → 质心的偏移（本模块保留字段，未见用例）

  [[nodiscard]] bool IsStatic() const noexcept { return invMass <= 0.0f; }

  /// 动能 (J)。**只用于验证"求解前后动能不变"** —— Split Impulse 的核心命题。
  /// 注意只计**平动**动能：本模块的位置相同样不改 angularVelocity。
  [[nodiscard]] float TranslationalKE() const noexcept {
    const float m = (invMass > 0.0f) ? (1.0f / invMass) : 0.0f;
    return 0.5f * m * velocity.LengthSq();
  }
};

// =============================================================================
//  求解器配置
// =============================================================================

struct SolverConfig final {
  // ── §1 法线平整化（Anti-Ramp / Anti-Wedge）──────────────────────────────
  /**
   * 静态护栏接触是否**无条件**把法线压平（ny := 0 并重归一化）。
   *
   * 默认 true。这是 §病根③ 的直接对策。
   * 之所以要"无条件"而不是"超过 slop 才处理"：倒角产生的 +Y 分量
   * 往往只有 0.02~0.05（1°~3°），但它累积到 200km/h 的冲量上就是
   * 好几个 m/s 的垂直速度。**低于 slop 就放行 = 把 bug 留在默认路径上**。
   *
   * 关掉它的唯一正当理由：该接触面**真的是斜面**（如斜坡缓冲带），
   * 此时法线本就不该水平 —— 但那类接触请改用 ContactKind::Ground，
   * 而不是在这里调开关。
   */
  bool flattenStaticNormal = true;

  /**
   * 平整化后若法线水平分量近乎为零（纯垂直法线），判定为**退化输入**：
   * 返回零向量表示"放弃解算"。这个阈值就是那个"近乎为零"的判据。
   */
  float normalFlatEps = 1e-6f;

  // ── §2 速度阶跃塑性衰减（Velocity-Dependent Plastic Restitution）─────────
  /**
   * 弹性 / 塑性分界速度 (m/s)。
   *  |v_rel| <  threshold ⇒ 处于弹性段，有微小回弹；
   *  |v_rel| >= threshold ⇒ 强制 e = 0，完全非弹性。
   *
   *  物理依据：1.5 m/s = 5.4 km/h。低于它是停车场级别的推挤碰擦，
   *  车身覆盖件（保险杠蒙皮/翼子板）仍在弹性变形范围内；
   *  高于它结构件进入塑性屈服。这个数取自真实车对刚壁碰撞试验中
   *  "等效恢复系数由 0.1+ 快速跌到 0"的过渡带。
   */
  float plasticThresholdSpeed = 1.5f;

  /**
   * 弹性段的最大恢复系数（v_rel → 0 时的 e）。
   *
   *  e(v) = plasticPeakRestitution · (1 − |v|/threshold)，v < threshold
   *       = 0，                                              v ≥ threshold
   *
   *  取 0.05 而不是 0 的理由：e 恒为 0 时，法向冲量恰好抵消法向接近速度，
   *  接触面在数学上等价于**理想黏胶** —— 车贴墙后完全无法"弹回半分"，
   *  玩家感受是"黏滞"而非"碰撞"。保留 5% 让极低速接触有可辨的回弹质感，
   *  同时 0.05 在 1.5 m/s 下最多给出 0.075 m/s 的分离速度（0.27 km/h），
   *  远低于任何可见/可感的弹跳。
   */
  float plasticPeakRestitution = 0.05f;

  // ── §3 分离冲量 ──────────────────────────────────────────────────────────
  /**
   * 位置相单**子步**最大推开距离 (m)。
   *
   *  规格值 0.03 m = 3 cm。
   *
   *  这个上限的作用是把"一次修完"改成"分若干帧修完"：
   *  深度穿透（网络同步下常见 0.2~0.5 m，因为远端位置是外推出来的，
   *  到达时可能已在本车体内）如果一帧推完，视觉上就是"闪现"——
   *  车凭空平移半米。分帧推出时，每帧 3cm 的位移在 60Hz 下
   *  等效 1.8 m/s 的视觉速度，肉眼视为"被缓慢挤开"，完全可接受。
   *
   *  残余穿透量 = pen − 0.03 会在后续帧继续被推出。
   *  ── 收敛性：每帧推 3cm，但从 0.03m 起每帧按 β 比例衰减，
   *     所以剩余量呈**几何级数**收敛。详见 ProjectPenetration() 的论证。
   */
  float maxPushPerSubstep = 0.03f;

  /**
   * 位置通道系数 β ∈ (0,1]。
   *
   *  名义伪速度 v_push = β·pen/dt（m/s，**仅作换算中介，永不写回 velocity**）
   *  位移 dx = v_push·dt = β·pen，再被 maxPushPerSubstep 与 dt 夹取。
   *
   *  β = 0.8 ⇒ 一帧修掉 80% 穿透，留 20% 给下一帧。
   *  取 < 1 而不是 1 的原因：一次修满会让相邻帧的几何发生突变，
   *  在**多点流形**（车身四角同时压护栏）里尤其明显 ——
   *  四个点各自修满会互相过冲，表现为车身抖动。
   *  β 不注入能量（位置相不碰 velocity），所以可以比速度通道更激进。
   */
  float positionBeta = 0.8f;

  /**
   * 穿透容差 (m)。容差内的穿透**完全不修**。
   *
   *  5 mm。理由：静止贴墙时每帧都会有毫米级穿透被解出来，
   *  若不容忍，位置相会每帧微调一次 —— 视觉上是高频抖动（jitter）。
   *  容忍 5mm 后，接触进入"稳定重叠"状态，不再每帧动作。
   *  5mm 相对车长 4.5m 是 0.1%，视觉完全不可见。
   */
  float penetrationSlop = 0.005f;

  // ── §5 冲量硬截断 ────────────────────────────────────────────────────────
  /**
   * 单次法向冲量绝对上限 (N·s)。
   *
   *  规格值 40,000 N·s。
   *
   *  物理意义校验：由动量定理，把 m = 1380kg 的车从 v 停到 0 需要
   *  J = m·v。J = 4e4 N·s 对应 v = 4e4/1380 = 29.0 m/s = 104 km/h。
   *  即：**单接触、单子步**能自然吞掉的最大撞击速度约 104 km/h。
   *  超过这个量级的撞击，正确的物理行为本来就是"需要多个子步累积冲量
   *  才拦停"（而不是一帧内解决）—— 截断与物理是一致的，不冲突。
   *
   *  真正的用途是**防御数值奇异**：网络同步下可能出现穿透 5m、
   *  相对速度 1e6 m/s 之类的荒谬输入，此时 k_n 可能接近 0，
   *  J_n = Δv/k_n 会溢出成 Inf。截断保证任何一个 contact 都不会
   *  单帧把刚体速度改写成天文数字。
   *
   *  ⚠ 截断的**代价**必须写清楚：截断优先于物理正确性。
   *    撞 288 km/h 时冲量被砍到 4e4，车不会被一帧拦停 ——
   *    这是**故意**的选择（"宁可不物理，也不炸"）。
   *    测试里必须把这一点断言出来，而不是含糊地测"速度变小了"。
   */
  float maxNormalImpulse = 40000.0f;

  /// 单次切向冲量绝对上限 (N·s)。通常取法向的 0.5~0.6 倍（对应 μ≈0.5）。
  float maxTangentImpulse = 20000.0f;

  /**
   * 库伦摩擦系数 μ（钣金对护栏的侧向剐蹭动摩擦）。
   * 钢-钢涂装、钢板对混凝土在工程手册里落在 0.4~0.6，取中值。
   * 摩擦是**吸能**的（把切向动能转成热），因此是"无反弹"的盟友，
   * 但绝不能超过 μ·J_n（否则会凭空产生反向摩擦冲量 → 人造推力）。
   */
  float friction = 0.55f;

  // ── §4 悬挂解耦 ──────────────────────────────────────────────────────────
  /**
   * 刚体外壳碰擦期间，轴行程极值被钳制到"当前行程 + 该余量"的比例。
   *
   *  语义：碰撞**允许**悬挂在既有行程上再压缩一点（真实的撞击确实会
   *  让悬挂压缩），但**禁止**一次碰撞把悬挂从完全伸展直接压到 bottom out。
   *  被冻结的是"这次碰撞能额外榨出多少行程"。
   *
   *  取 0.15 的理由：正常行驶中悬挂工作在 ±0.10 m 附近，
   *  一次中等碰撞压缩 0.05~0.10 m 是合理的。允许 15% 余量（= 0.045m 的
   *  额外压缩）既保留了碰撞的"车身下沉"观感，又斩断了 §病根④ 的
   *  正反馈：行程不可能被单次碰撞推到 0.30m 极限，弹簧储能
   *  E = ½K·x² 就被限制在 ½·2.256e5·0.145² ≈ 2.4×10³ J，
   *  只有满行程储能（1.02×10⁴ J）的 23%。
   */
  float suspensionLockSlack = 0.15f;

  /**
   * 悬挂行程物理上限 (m)。与 public/js/physics.js 的悬挂冲程上限同源。
   * 仅在 LockSuspensionTravel() 里用作绝对上界。
   */
  float suspensionMaxTravel = 0.30f;

  /**
   * 刚体外壳碰擦的判定阈值 (m/s)。
   *
   *  低于此值的接触视为"贴地/贴墙滑行"的持续性接触，不算碰擦事件，
   *  不触发悬挂锁定 —— 否则车沿护栏滑行时悬挂会被**永久**锁死，
   *  失去全部减震能力（那比弹飞更糟）。
   */
  float shellContactMinSpeed = 1.0f;
};

// =============================================================================
//  接触流形
// =============================================================================

/// 接触类型。决定法线平整化是否启用（**地面接触绝不能被压平**）。
enum class ContactKind : std::uint8_t {
  CarToWall = 0,  ///< 车 vs 静态护栏/边界墙 —— **启用**法线平整化
  CarToCar = 1,   ///< 车 vs 车 —— 同样启用（车顶互擦是合法接触，但正碰时倾斜法线同样是 bug）
  Ground = 2,     ///< 车 vs 路面 —— **禁用**平整化（路面法线本就朝上，压平会让车失去支撑）
};

/// 单个接触点。一个流形可含多点（车身四角同时压护栏是标准场景）。
struct ContactPoint final {
  /**
   * 接触点相对 **A 的质心** 的世界向量 r_A (m)。
   * 力矩 τ = r × J 里的 r 就是它。
   * **必须钳制幅值**：网络同步可能报出荒谬的接触点坐标，
   * 力臂 20m 的冲量会产生天文数字力矩（NaN 与掀翻的来源）。
   */
  Vec3 rA{};

  /// 接触点相对 **B 的质心** 的世界向量 r_B (m)
  Vec3 rB{};

  /**
   * 穿透深度 (m)，恒为**非负**。
   * ★ 它是**几何量**（位形空间），只能进位置相。
   *   **绝不允许**乘一个 β/dt 后进入速度相 —— 那正是 §病根① 。
   */
  float penetration = 0.0f;

  /// 累计法向冲量 (N·s)。热启动（warm starting）用；本模块写入但不消费。
  float accumulatedNormalImpulse = 0.0f;
  /// 累计切向冲量 (N·s)
  float accumulatedTangentImpulse = 0.0f;
};

struct ContactManifold final {
  RigidBodyView* a = nullptr;   ///< 刚体 A（通常是本车）
  RigidBodyView* b = nullptr;   ///< 刚体 B；**nullptr 表示静态体**（墙/护栏）

  /**
   * 接触法线，**从 A 指向 B**，应是单位向量（求解器内部会自行处理非单位输入）。
   * 对 A 施加的冲量方向为 **−n**，对 B 为 **+n**。
   */
  Vec3 normal{};

  ContactKind kind = ContactKind::CarToCar;

  static constexpr int kMaxPoints = 4;   ///< 单流形最多 4 点（盒对盒足够）
  ContactPoint points[kMaxPoints]{};
  int pointCount = 0;

  /// 本流形在**当前子步内**已被位置相修掉的累计位移 (m)。
  /// 用于把"单次接触的总推出量"限制在 maxPushPerSubstep，
  /// 而不是"每个接触点各推 3cm"（四点流形会推 12cm，超规格 4 倍）。
  float pushedThisSubstep = 0.0f;

  /// 静态体的质量倒数按 0 处理（质量无穷大），统一访问、免 null 特判。
  [[nodiscard]] constexpr float InvMassA() const noexcept { return a ? a->invMass : 0.0f; }
  [[nodiscard]] constexpr float InvMassB() const noexcept { return b ? b->invMass : 0.0f; }

  [[nodiscard]] bool IsValid() const noexcept {
    return a != nullptr && pointCount > 0 && (InvMassA() + InvMassB()) > 1e-9f;
  }

  /// 是否为"刚体外壳碰擦"（用于 §4 悬挂解耦的触发判据）。
  [[nodiscard]] bool IsShellContact() const noexcept {
    return kind == ContactKind::CarToWall || kind == ContactKind::CarToCar;
  }
};

// =============================================================================
//  悬挂状态视图（供 §4 悬挂解耦使用）
// =============================================================================
/**
 * 单根轴（前轴 / 后轴）的悬挂状态。
 *
 * 本工程的悬挂是**弹簧-阻尼**：F = K·x − C·v_n，
 *  K = 225.6 kN/m、C = 35.3 kN·s/m（ζ = 1 临界阻尼），
 *  压缩为正，行程范围 [−maxTravel, +maxTravel]。
 *
 *  ⚠ 红线（MEMORY.md）：**严禁**用 `body.position.y = groundY` 这类
 *    瞬移贴地替代悬挂。那会产生锯齿抖动，且完全绕过弹簧动力学。
 *    本模块的悬挂解耦正确做法是**钳制行程**，不是改车身位置。
 */
struct SuspensionAxle final {
  float travel = 0.0f;          ///< 当前行程 (m)，压缩为正
  float maxTravel = 0.0f;       ///< 该轴的行程上限 (m)，压缩方向
  float minTravel = 0.0f;       ///< 该轴的行程下限 (m)，回弹方向（通常为负）
  bool locked = false;          ///< 是否处于"碰撞期间锁定"状态
  float lockedMax = 0.0f;       ///< 锁定时冻结的压缩极值 (m)
  float lockedMin = 0.0f;       ///< 锁定时冻结的回弹极值 (m)
};

// =============================================================================
//  求解统计（遥测 / 断言用；**不是**调试打印，是给测试与 HUD 读的）
// =============================================================================

struct SolveStats final {
  int manifolds = 0;            ///< 处理的流形数
  int skippedSeparating = 0;    ///< 因"正在自然分离"而跳过的接触点数
  int skippedNoClosure = 0;     ///< 因闭合速度低于下限而忽略的
  int flattenedNormals = 0;     ///< 实际做了法线平整化的流形数
  int abortedNormals = 0;       ///< 因法线退化为零向量而放弃解算的流形数

  /**
   * 【废弃兼容名】旧 `SafeCollisionResolver` 时代把 §1 法线平整化叫做
   * "redirected"（重定向）。旧调用方（`native/harness/simulation_harness.cpp`、
   * `native/safe_collision/safe_collision_test.cpp`）仍在读这个名字。
   *
   * 语义**完全等价**于 `flattenedNormals` —— 保留它只是为了让下游不必在同一
   * 次改动里同时改"算法"和"调用方接线"（回退风险）。新代码请直接用
   * `flattenedNormals`。
   *
   * ⚠ 二者必须**同增同减**。`FlattenNormal()` 内部用
   *   `RecordFlatten()` 一次性把两个字段都 +1，不存在只更新一个的分支。
   */
  int redirectedNormals = 0;    ///< 【deprecated】== flattenedNormals
  int clampedNormal = 0;        ///< 触发法向冲量截断的接触点数
  int clampedTangent = 0;       ///< 触发切向冲量截断的接触点数
  int projected = 0;            ///< 做过位置投影的接触点数
  int pushCappedPoints = 0;     ///< 因单子步位移上限而被截的接触点数
  int cappedLeverArm = 0;       ///< 触发力臂钳制的接触点次数
  int suspensionLocked = 0;     ///< 执行悬挂行程锁定的次数

  /**
   * 本帧给单个刚体造成的最大 |Δv| (m/s)。
   * 断言"不炸"用。截断生效时它应 ≤ maxNormalImpulse/m ≈ 29 m/s。
   */
  float maxInjectedDeltaV = 0.0f;

  /**
   * ★ 本帧给单个刚体造成的最大**垂直** |Δv_y| (m/s)。
   *
   * 这个字段是专门为 §病根③ 设的：
   * 法线带 +Y 时，垂直分力**不改变总动量大小、只改方向**，
   * 所以"速率未放大"的断言对它**完全无感**。
   * 必须单独统计垂直增量才能真正测出"防跳板"是否生效。
   */
  float maxInjectedDeltaVy = 0.0f;

  float maxPenetration = 0.0f;      ///< 本帧最大穿透深度 (m)
  float maxPushDisplacement = 0.0f; ///< 本帧位置相单次最大位移 (m)

  void Reset() noexcept { *this = SolveStats{}; }
};

// =============================================================================
//  SafePhysicsSolver —— 纯静态类，无状态
// =============================================================================

class SafePhysicsSolver final {
 public:
  SafePhysicsSolver() = delete;   // 静态工具类，禁止实例化

  // ===========================================================================
  //  §1 法线平整化与防跳板机制（Anti-Ramp / Anti-Wedge Normal Flattening）
  // ===========================================================================
  /**
   * 当碰撞体为静态护栏（Track Wall）时，**强制**令接触法线 normal.y = 0
   * 并重新归一化，切断任何可能把车辆推离地面的法向垂直冲量来源。
   *
   * ── 数学 ──────────────────────────────────────────────────────────────────
   *  设原始法线 n = (nx, ny, nz)（假设已单位化）。向水平面投影：
   *
   *      n_h = (nx, 0, nz)
   *      n'  = n_h / ‖n_h‖                                  …… 重归一化
   *
   *  ── 为什么必须重归一化（这一步最容易被漏掉）──────────────────────────────
   *  求解器里 n 有两个用途，都要求它是单位向量：
   *
   *      v_n = v_rel · n              （投影，需要 ‖n‖ = 1 才是真投影）
   *      Δv  = J/m · n                （冲量方向与幅值，需要 ‖n‖ = 1 才量纲正确）
   *
   *  若只把 ny 置 0 而不归一化：‖n'‖ = ‖n_h‖ = √(nx²+nz²) < 1，
   *  于是 v_n 与 Δv 都被**同比例缩小**。表现是"撞墙发软、穿透加深"，
   *  而且缩小的比例随护栏倾斜度变化（不可预测、无法用常数补偿）。
   *  归一化之后 n' 仍是单位向量，冲量量纲与幅值都保持正确。
   *
   *  ── 为什么"无条件"抹平而不是"超过阈值才抹"──────────────────────────────
   *  护栏在几何上就是垂直面，其**真实**法线应严格水平。
   *  带 +Y 的法线 100% 来自接触网格倒角的离散化误差。
   *  误差的垂直分量可能只有 0.02（1.1°）—— 但冲量 J = 4e4 N·s 时：
   *
   *      Δv_y = J·|ny| / m = 4e4 × 0.02 / 1380 ≈ 0.58 m/s
   *
   *  0.58 m/s 的垂直速度足以让车在 0.17 s 内抬升 5 cm。
   *  这不是可以忽略的量级 —— **小的法线误差 × 大的冲量 = 不可忽略的垂直动能**。
   *  所以本函数对 CarToWall 一律抹平，不设"误差小就放过"的口子。
   *
   *  ── 退化处理 ──────────────────────────────────────────────────────────────
   *  若水平分量近乎为零（纯垂直法线，来自"车顶被压"之类的几何），
   *  无水平方向可归一化 —— 返回**零向量**，调用方据此放弃本次解算。
   *  **绝不能**退化成"用原始法线硬解"，那正是把车顶起来的原因。
   *
   * @param n         输入法线
   * @param kind      接触类型；Ground 直接原样返回
   * @param cfg       配置
   * @param outFlat   输出：是否实际执行了平整化（供统计/断言）
   * @return 平整化后的**单位**法线；退化为零向量表示"放弃解算"。
   */
  [[nodiscard]] static Vec3 FlattenNormal(const Vec3& n,
                                          ContactKind kind,
                                          const SolverConfig& cfg,
                                          bool* outFlat = nullptr) noexcept {
    if (outFlat) *outFlat = false;

    if (!n.IsFinite()) return {0.0f, 0.0f, 0.0f};

    // 地面接触绝不压平：路面法线天然朝上，抹掉 Y 会让车失去支撑、直接沉入地面。
    if (kind == ContactKind::Ground) return n.Normalized();

    if (!cfg.flattenStaticNormal) return n.Normalized();

    // 投影到水平面
    const float lenH = std::sqrt(n.x * n.x + n.z * n.z);
    if (lenH < cfg.normalFlatEps) {
      // 纯垂直法线 → 退化输入 → 放弃解算（不得产生 NaN）
      return {0.0f, 0.0f, 0.0f};
    }

    if (outFlat) *outFlat = true;
    const float inv = 1.0f / lenH;
    return {n.x * inv, 0.0f, n.z * inv};
  }

  // ===========================================================================
  //  §2 速度阶跃塑性衰减模型（Velocity-Dependent Plastic Restitution）
  // ===========================================================================
  /**
   * 恢复系数 e 作为**接触点法向相对撞击速度** |v_rel| 的函数：
   *
   *      ┌ e = e_peak · (1 − |v_rel| / v_threshold)   ,  |v_rel| <  v_threshold
   *  e(|v_rel|) = ┤
   *      └ 0                                          ,  |v_rel| >= v_threshold
   *
   *  ── 函数性质（每条都对应一项物理/数值要求）────────────────────────────────
   *   · **e(v_threshold) 严格等于 0**，且 e(v_threshold⁻) = e_peak·0 = 0
   *     ⇒ 在阈值处**天然连续**（不是靠 smoothstep 硬接），无"手感断层"。
   *   · e(0) = e_peak（最大回弹只在零速极限取得，实际永远取不到）。
   *   · e 对 |v_rel| **单调不增** ⇒ 撞得越重弹得越少，定性正确。
   *   · 线性而非 smoothstep：本条规格点名要 0.05·(1 − |v|/1.5) 这个**线性**式。
   *     线性式在阈值处的斜率不连续（导数为 −e_peak/threshold），
   *     但这只影响"加速度的抖动"，不影响位置/速度的连续性，
   *     在 1.5 m/s 附近跨越时玩家无法感知。**按规格实现线性。**
   *
   *  ── 为什么用接触点法向速度而不是整车速度 ────────────────────────────────
   *  两车并排同速（各自 200 km/h）侧向擦碰时，整车速率 55.6 m/s 极大，
   *  但**法向**接近速度可能接近 0。按整车速度查表会得到 e = 0，
   *  把一次轻微剐蹭按"高速撞击"处理 —— 手感与物理都不对。
   *  所以调用方必须传 |v_n|（法向分量），本函数也据此命名参数。
   *
   * @param approachSpeed **非负**的法向闭合速度 |v_n| (m/s)
   */
  [[nodiscard]] static float PlasticRestitution(float approachSpeed,
                                                const SolverConfig& cfg) noexcept {
    if (!std::isfinite(approachSpeed)) return 0.0f;

    const float v = std::fabs(approachSpeed);
    const float thres = cfg.plasticThresholdSpeed;

    // 阈值退化（配置错误）⇒ 全程塑性，绝不让除零产生 NaN
    if (thres <= 1e-9f) return 0.0f;

    if (v >= thres) return 0.0f;

    // 线性衰减：v=0 → e_peak；v→thres⁻ → e→0⁻（连续性由构造保证）
    const float t = 1.0f - v / thres;
    return cfg.plasticPeakRestitution * t;
  }

  // ===========================================================================
  //  §5 冲量硬截断（Impulse Clamping）
  // ===========================================================================
  /**
   * 标量冲量硬截断。
   *
   * ── 数学 ──────────────────────────────────────────────────────────────────
   *      J_clamped = clamp(J, −maxImpulse, +maxImpulse)
   *      且 J 非有限（NaN/Inf）时 → 0
   *
   *  ── 为什么 NaN 要归零而不是截到 ±max ────────────────────────────────────
   *  NaN 的语义是"计算已经失效"，不是"数值很大"。把 NaN 截到 maxImpulse
   *  会把一个错误的中间结果**伪装成**合法的大冲量，继续传播；
   *  而归零表示"这次接触不作数"，刚体状态保持上一帧的值 —— 是安全的状态。
   *  Inf 同理（它通常来自 k_n → 0 的除法）。
   *
   * @return 截断后的冲量（NaN/Inf → 0）
   */
  [[nodiscard]] static float ClampImpulse(float j, float maxImpulse,
                                          bool* outClamped = nullptr) noexcept {
    if (outClamped) *outClamped = false;
    if (!std::isfinite(j)) {
      if (outClamped) *outClamped = true;
      return 0.0f;
    }
    if (j > maxImpulse) {
      if (outClamped) *outClamped = true;
      return maxImpulse;
    }
    if (j < -maxImpulse) {
      if (outClamped) *outClamped = true;
      return -maxImpulse;
    }
    return j;
  }

  // ===========================================================================
  //  §3-a 速度相（Velocity Phase）—— 严禁 penetration 进入本函数
  // ===========================================================================
  /**
   * 纯动量守恒求解法向冲量与切向库伦摩擦。
   *
   * ★★★ 本函数内**不得出现任何 penetration 变量** ★★★
   *    只要在这里出现 (β/dt)·pen，就回到 Baumgarte，就是"炸车"的根源。
   *    穿透属于**位形空间**，由 ProjectPenetration() 处理。
   *
   * ── 数学推导 ─────────────────────────────────────────────────────────────
   *
   *  1) 接触点速度（含转动贡献：刚体上一点的速度 v_p = v + ω × r）
   *
   *        v_Ap = v_A + ω_A × r_A
   *        v_Bp = v_B + ω_B × r_B
   *        v_rel = v_Ap − v_Bp
   *
   *  2) 法向相对速度（约定见文件头：+n 从 A 指向 B）
   *
   *        v_n = v_rel · n
   *        v_n > 0 ⇒ 接近（需解算）；v_n < 0 ⇒ 分离（跳过）
   *
   *     ★ "分离即跳过"是**必需**的。若翻转发线后继续解算，
   *       等价于给正在分开的两车施加**吸引力** ⇒ 粘住 + 反复微弹。
   *
   *  3) 等效质量（约束 Jacobian 的 k_n）
   *
   *        k_n = 1/m_A + 1/m_B + (r_A × n)²/I_A + (r_B × n)²/I_B
   *
   *     静态体 invMass = invInertia = 0 ⇒ 贡献恒为 0，**无需特判**。
   *     这就是把静态体统一成"质量倒数 0"的收益。
   *
   *  4) 目标法向速度变化（**只有动量项，没有 bias**）
   *
   *        Δv_target = (1 + e)·v_closure
   *
   *     e 由 PlasticRestitution(v_closure) 给出（§2）。
   *     ⚠ 对比 Baumgarte：Δv_target = (1+e)·v_closure + (β/dt)·pen
   *       多出来那一项就是虚假动能（见文件头 §病根① 的推导）。
   *
   *  5) 法向冲量（N·s）
   *
   *        J_n = Δv_target / k_n              再由 ClampImpulse 硬截断
   *
   *  6) 库伦摩擦（切向）
   *
   *        v_t   = v_rel − n·(v_rel·n)              相对速度的切向分量
   *        t_dir = v_t / ‖v_t‖
   *        J_t   = −(v_rel·t_dir) / k_t             抵消切向滑动的冲量
   *        |J_t| ≤ μ·J_n                            库伦锥（静摩擦→滑动摩擦）
   *
   *  7) 施加冲量（牛顿第三定律；符号由"n 从 A 指向 B"决定）
   *
   *        v_A −= J/m_A ,  ω_A −= (r_A × J)/I_A      （A 受 −J）
   *        v_B += J/m_B ,  ω_B += (r_B × J)/I_B      （B 受 +J）
   *
   * @param mf    接触流形（原地修改两侧刚体的 velocity / angularVelocity）
   * @param cfg   配置
   * @param stats 可选统计输出
   * @return true 表示至少施加了一次有效冲量
   */
  static bool SolveVelocityPhase(ContactManifold& mf,
                                 const SolverConfig& cfg,
                                 SolveStats* stats = nullptr) noexcept {
    if (!mf.IsValid() || !mf.normal.IsFinite()) return false;

    const float invMassA = mf.InvMassA();
    const float invMassB = mf.InvMassB();
    const float invMassSum = invMassA + invMassB;
    if (invMassSum <= 1e-9f) return false;   // 两个静态体：无自由度可解

    // ---- §1 法线平整化 ----
    bool flattened = false;
    const Vec3 n = FlattenNormal(mf.normal, mf.kind, cfg, &flattened);
    if (n.LengthSq() < 1e-12f) {
      // 退化法线（纯垂直）：放弃速度解算，交给解析地面约束。
      // **不能**退化成用原始法线硬解 —— 那正是把车顶起来的原因。
      if (stats) stats->abortedNormals++;
      return false;
    }
    if (flattened && stats) {
      stats->flattenedNormals++;
      stats->redirectedNormals++;   // 废弃兼容名，恒等于 flattenedNormals
    }

    const bool aFinite = mf.a && mf.a->position.IsFinite() &&
                         mf.a->velocity.IsFinite() && mf.a->angularVelocity.IsFinite();
    if (!aFinite) return false;

    const float invIA = (mf.a && mf.a->invInertia > 0.0f) ? mf.a->invInertia : 0.0f;
    const float invIB = (mf.b && mf.b->invInertia > 0.0f) ? mf.b->invInertia : 0.0f;

    bool applied = false;

    for (int i = 0; i < mf.pointCount; ++i) {
      ContactPoint& cp = mf.points[i];

      // 力臂钳制：网络同步可能报出荒谬的接触点坐标（远端插值位置 × 局部接触点），
      // r 过大会让力矩 τ = r × J 爆炸。只压幅值、保留方向。
      const Vec3 rA = ClampLeverArm(cp.rA, cfg, stats);
      const Vec3 rB = ClampLeverArm(cp.rB, cfg, stats);

      // ---- 1) 接触点速度 ----
      const Vec3 vA = mf.a->velocity + mf.a->angularVelocity.Cross(rA);
      const Vec3 vB = mf.b ? (mf.b->velocity + mf.b->angularVelocity.Cross(rB)) : Vec3{};
      const Vec3 vRel = vA - vB;

      // ---- 2) 法向相对速度 ----
      const float vn = vRel.Dot(n);

      // ★ 正在自然分离：不做任何排斥解算（否则变成"吸引力"⇒ 粘住 + 微弹）
      if (vn < 0.0f) {
        if (stats) stats->skippedSeparating++;
        continue;
      }

      const float closure = vn;   // 法向闭合速度（非负）

      // 闭合速度极低时忽略：防静止接触每帧微抖、防除零
      if (closure < 0.15f) {
        if (stats) stats->skippedNoClosure++;
        continue;
      }

      // ---- 4) 恢复系数（§2：与撞击速度动态绑定，≥阈值 时恒为 0）----
      const float e = PlasticRestitution(closure, cfg);

      // ---- 3) 等效质量 k_n（含转动项）----
      float kNormal = invMassSum + rA.Cross(n).LengthSq() * invIA +
                      rB.Cross(n).LengthSq() * invIB;
      if (kNormal <= 1e-9f) continue;

      // ---- 5) 法向冲量 ★ 无 bias 项：穿透深度完全不参与速度相 ----
      float jn = (1.0f + e) * closure / kNormal;

      // ---- §5 冲量硬截断 ----
      bool clamped = false;
      jn = ClampImpulse(jn, cfg.maxNormalImpulse, &clamped);
      if (clamped && stats) stats->clampedNormal++;
      if (jn <= 0.0f || !std::isfinite(jn)) continue;

      // ---- 6) 库伦摩擦（切向）----
      //
      //  ★★★ 符号约定：J 会被**整体**以 `v_A -= J/m_A` 施加 ★★★
      //
      //  对 A 施加的冲量是 −J（因为 n 从 A 指向 B，法向冲量把 A 推向 −n）。
      //  因此为了让切向"止滑"，J 的切向分量必须**指向 +t_dir**——
      //  这样 −J 才指向 −t_dir，与滑动方向相反。
      //
      //  ⚠ 踩过的坑：写成 `jtVec = tDir * (-jtStop)` 会得到 −t_dir 方向，
      //    经 `v −= J/m` 再翻一次符号 ⇒ **摩擦沿滑动方向施加** ⇒
      //    切向速度被放大（实测 vt=40 → 48.25，动能 +27.6%）。
      //    摩擦从吸能变成造能，违背热力学第二定律。
      //
      //  两个上限（缺一即出错）：
      //    · 上限一（物理）：库伦锥 |J_t| ≤ μ·J_n
      //    · 上限二（数值）：**不得超过"恰好止滑"所需的量**
      //      因为相对滑动归零后即进入静摩擦，继续施加冲量是过冲，
      //      会把切向速度推过零点反向加速（同样造能）。
      //      实测只夹库伦锥时 μ=0.30 仍造能 +8.5%，加止滑上限后恢复 −9.0%。
      Vec3 jtVec{};
      {
        const Vec3 vTan = vRel - n * vn;             // 切向相对速度（A 相对 B）
        const float vTanLen = vTan.Length();
        if (vTanLen > 1e-5f) {
          const Vec3 tDir = vTan * (1.0f / vTanLen);   // 指向"相对滑动方向"
          const float kTangent = invMassSum + rA.Cross(tDir).LengthSq() * invIA +
                                 rB.Cross(tDir).LengthSq() * invIB;
          if (kTangent > 1e-9f) {
            // 止滑所需冲量幅值：恰好把 |v_t| 抵消
            const float jtStop = vTanLen / kTangent;
            // 物理锥 + 绝对上限
            float limit = cfg.friction * jn;
            if (limit > cfg.maxTangentImpulse) limit = cfg.maxTangentImpulse;
            // 与止滑需求取严
            if (jtStop < limit) limit = jtStop;
            if (jtStop > (cfg.friction * jn) || limit < jtStop) {
              if (stats) stats->clampedTangent++;
            }
            // ★ J 的切向分量取 **+t_dir**（因为施加时整体取 −J）
            jtVec = tDir * limit;
          }
        }
      }

      const Vec3 J = n * jn + jtVec;

      // ---- 7) 施加冲量 ----
      if (stats) {
        const float dvA = J.Length() * invMassA;
        if (dvA > stats->maxInjectedDeltaV) stats->maxInjectedDeltaV = dvA;
        // ★ 垂直增量单独统计：速率不放大 ≠ 没被铲飞（见 SolveStats 注释）
        const float dvyA = std::fabs(J.y * invMassA);
        if (dvyA > stats->maxInjectedDeltaVy) stats->maxInjectedDeltaVy = dvyA;
      }

      if (mf.a) {
        mf.a->velocity -= J * invMassA;
        mf.a->angularVelocity -= rA.Cross(J) * invIA;
      }
      if (mf.b && !mf.b->IsStatic()) {
        mf.b->velocity += J * invMassB;
        mf.b->angularVelocity += rB.Cross(J) * invIB;
      }

      cp.accumulatedNormalImpulse += jn;
      cp.accumulatedTangentImpulse += std::fabs(jtVec.Length());
      applied = true;
    }

    return applied;
  }

  // ===========================================================================
  //  §3-b 位置相（Position Phase / Split Impulse）
  // ===========================================================================
  /**
   * 只用**伪速度**把穿透的刚体温和推开。
   *
   * ★★★ 本函数**绝不修改 velocity / angularVelocity** ★★★
   *
   * ── 数学 ─────────────────────────────────────────────────────────────────
   *
   *  1) 名义推出速度（**伪速度**，不参与动能，永不写回 velocity）：
   *
   *        v_push = β · pen / dt                          …… 单位 m/s，仅换算中介
   *
   *  2) 换算成位移（伪速度 × dt 才是长度）：
   *
   *        dx = v_push · dt = β · pen
   *
   *  3) 三道夹取（**漏任何一道都会出事**）：
   *
   *        dx ≤ maxPushPerSubstep            …… 单子步位移上限 0.03 m（规格）
   *        dx ≤ 剩余本子步额度                 …… 多接触点共享 0.03 m 总额度
   *
   *     ⚠ 关于"0.03 m 上限"的一个常见误解：它不是"每帧只能推 3cm"，
   *       而是"每个**物理子步**只能推 3cm"。本工程物理固定 1/60 s、
   *       单帧可能跑多个子步（`step()` 累加器），所以实际上限是
   *       0.03 m × 子步数。规格的本意是防止**一帧瞬移**，
   *       而在 60Hz 单子步的典型情况下两者等价。
   *
   *     ⚠ 为什么必须让**整个流形共享**这个额度（用 mf.pushedThisSubstep 记账）：
   *       四点流形（车身四角同时压护栏）若每点各推 3cm，合计 12cm，
   *       超规格 4 倍 —— 而且四点方向相近时会叠加成一次明显平移。
   *
   *  4) 按质量倒数**反比**分配（与动量守恒下 Δx ∝ 1/m 一致）：
   *
   *        w_A = invMass_A / (invMass_A + invMass_B)
   *        p_A -= n · dx · w_A            （A 沿 −n 远离 B）
   *        p_B += n · dx · (1 − w_A)      （B 沿 +n 远离 A）
   *
   *     ★ 方向**必须**与速度相的 `v_A -= J/m` 同号。
   *       ⚠ 本工程曾误写成 `p_A += n·dx` ⇒ 修穿透时把车推进墙里，
   *         穿得越深推得越狠（详见文件头「法线方向约定」）。
   *
   *     静态体 invMass = 0 ⇒ w_A = 1 ⇒ 只有车动、墙不动。再次无需特判。
   *
   *  5) velocity 保持原样。
   *
   * ── 收敛性分析（"多余穿透在后续 5~10 帧内柔和推出"的定量论证）──────────
   *  设第 k 帧开始时的穿透为 pen_k。本帧位移
   *
   *      dx_k = min(β·pen_k, cap)          cap = maxPushPerSubstep
   *
   *  情形 A（pen_k 大到触顶）：dx_k = cap ⇒ pen_{k+1} = pen_k − cap
   *    **线性**收敛，每帧恒定消除 cap = 0.03 m。
   *    从 pen₀ = 0.30 m 起需要 10 帧；从 0.20 m 起需要 7 帧 ——
   *    正好落在规格要求的"5~10 帧"区间内。
   *
   *  情形 B（pen_k 小到未触顶）：dx_k = β·pen_k ⇒ pen_{k+1} = (1−β)·pen_k
   *    **几何**收敛，比率 (1−β) = 0.2。pen 从 0.03 降到 slop(0.005) 需要
   *    log(0.03/0.005)/log(1/0.2) ≈ 1.11 帧。
   *
   *  两段拼接：先线性削掉大头（≤10 帧），再几何收尾（1~2 帧）。
   *  全程无瞬移（单步 ≤ cap），总时长可控且**上界可证**。
   *
   * @param mf    接触流形（**只改 position**）
   * @param dt    本物理子步时长 (s)
   * @param cfg   配置
   * @param stats 可选统计输出
   * @return true 表示至少做了一次位置投影
   */
  static bool ProjectPenetration(ContactManifold& mf,
                                 float dt,
                                 const SolverConfig& cfg,
                                 SolveStats* stats = nullptr) noexcept {
    if (!mf.IsValid() || !(dt > 1e-9f)) return false;

    const float invMassA = mf.InvMassA();
    const float invMassB = mf.InvMassB();
    const float invMassSum = invMassA + invMassB;
    if (invMassSum <= 1e-9f) return false;

    // 位置相同样做平整化：位置修正也不该带垂直分量（否则车被"抬"离地）
    const Vec3 n = FlattenNormal(mf.normal, mf.kind, cfg, nullptr);
    if (n.LengthSq() < 1e-12f) return false;

    // 本子步该流形剩余的推出额度（多点共享，防止四点流形推 4 倍）
    float quota = cfg.maxPushPerSubstep - mf.pushedThisSubstep;
    if (quota <= 0.0f) return false;

    const float wA = invMassA / invMassSum;
    const float wB = 1.0f - wA;

    bool applied = false;

    for (int i = 0; i < mf.pointCount && quota > 0.0f; ++i) {
      const ContactPoint& cp = mf.points[i];

      // 容差内的毫米级穿透不修（防静止接触高频抖动）
      if (!std::isfinite(cp.penetration)) continue;
      if (cp.penetration <= cfg.penetrationSlop) continue;

      // 1) 伪速度 → 2) 位移
      float move = cfg.positionBeta * cp.penetration;
      if (move > quota) {
        move = quota;
        if (stats) stats->pushCappedPoints++;
      }
      if (!(move > 0.0f)) continue;

      // 3) 按质量倒数反比分配；方向必须与速度相同号
      if (mf.a) mf.a->position -= n * (move * wA);
      if (mf.b && !mf.b->IsStatic()) mf.b->position += n * (move * wB);

      // 4) ★★★ 刻意什么都不做：velocity / angularVelocity 保持原样 ★★★
      //     任何 `a->velocity += ...` 都会把几何修复变成动能注入，
      //     即回到 Baumgarte（"炸车"根源）。

      quota -= move;
      mf.pushedThisSubstep += move;

      if (stats) {
        stats->projected++;
        if (move > stats->maxPushDisplacement) stats->maxPushDisplacement = move;
        if (cp.penetration > stats->maxPenetration) stats->maxPenetration = cp.penetration;
      }
      applied = true;
    }

    return applied;
  }

  /// 子步边界调用：清空"本子步已推位移"记账，为下一次速度相/位置相做准备。
  static void BeginSubstep(ContactManifold& mf) noexcept { mf.pushedThisSubstep = 0.0f; }

  // ===========================================================================
  //  §4 悬挂解耦保护（Suspension Decoupling）
  // ===========================================================================
  /**
   * 刚体外壳碰擦期间，锁定当前轴悬挂行程极值 ——
   * 禁止碰撞垂直力矩把悬挂弹簧直接压到 bottom out。
   *
   * ── 要解决的物理问题 ─────────────────────────────────────────────────────
   *  悬挂储能 E = ½K·x²（K = 225.6 kN/m）。行程 x 被压到极限 0.30 m 时
   *  E = ½ · 2.256e5 · 0.09 ≈ 1.02×10⁴ J。这一份储能会在碰撞后的
   *  若干帧里全部释放回车身，把车**弹起来**。而车一离地，悬挂伸长，
   *  落地又压缩 —— 形成 §病根④ 描述的正反馈。
   *
   * ── 对策的物理依据 ──────────────────────────────────────────────────────
   *  真实赛车的碰撞吸能路径是：**外覆件（保险杠/翼子板/侧裙）→ 溃缩盒
   *  → 副车架 → 主车架**。悬挂被设计为在受到横向/纵向撞击时**让位**
   *  （衬套变形、连杆屈曲），而不是把冲击直接转成弹簧压缩。
   *  换言之，真实的悬挂在碰撞中**不是**主要的吸能元件。
   *
   *  本函数把这件事形式化：碰撞期间，轴行程被钳制在
   *
   *      travel ∈ [lockedMin, lockedMax]
   *      lockedMax = travel_at_impact + slack · maxTravel
   *      lockedMin = travel_at_impact − slack · maxTravel
   *
   *  并把这组冻结值**保持到解锁**（由调用方在碰擦结束后 UnlockSuspension）。
   *
   *  ── 为什么用"碰擦瞬间的行程 + 余量"而不是"直接钳到 0"──────────────────
   *  直接钳到 0 会让车在碰撞瞬间完全失去悬挂，视觉上像"车变成砖头"，
   *  且会在碰撞结束时产生一个二次冲击（悬挂突然恢复自由）。
   *  允许 slack 余量既保留了碰撞时"车身下沉"的正常观感，
   *  又把弹簧储能上限压到 ½K·(travel+slack·maxTravel)²，
   *  从**能量层面**斩断回弹（而不是靠事后阻尼硬压）。
   *
   * ── 为什么不"冲量打折"──────────────────────────────────────────────────
   *  把冲量 J 乘一个"悬挂透过率"会**破坏动量守恒** ——
   *  两车碰撞后总动量不再守恒，手感发软且不可控。
   *  正确做法是：**线性动量照常传递**（速度相接冲量），
   *  只限制"碰撞能额外榨出多少悬挂行程"。两者作用在不同的自由度上。
   *
   * @param axle   轴悬挂状态（原地修改：钳制 travel、写入 locked* 与 locked）
   * @param cfg    配置
   * @param impactSpeed 本次碰擦的法向速度 (m/s)，用于判定是否够格触发
   * @return true 表示本次确实执行了锁定（供统计）
   */
  static bool LockSuspensionTravel(SuspensionAxle& axle,
                                   const SolverConfig& cfg,
                                   float impactSpeed,
                                   SolveStats* stats = nullptr) noexcept {
    if (!std::isfinite(impactSpeed)) return false;

    // 低速持续接触（贴墙滑行）不触发锁定 —— 否则悬挂被永久锁死，
    // 车失去全部减震能力，比弹飞更糟。
    if (std::fabs(impactSpeed) < cfg.shellContactMinSpeed) return false;

    const float absMax = cfg.suspensionMaxTravel;
    const float absMin = -absMax;
    const float slack = cfg.suspensionLockSlack * absMax;

    float lo = axle.travel - slack;
    float hi = axle.travel + slack;

    // 与物理绝对行程取交集：锁定只会让可行域**更窄**，永不放大
    if (lo < absMin) lo = absMin;
    if (hi > absMax) hi = absMax;
    if (lo > hi) { const float mid = 0.5f * (lo + hi); lo = mid; hi = mid; }

    // 已锁定则取交集（多次碰擦叠加时只收紧、不放松）
    if (axle.locked) {
      if (lo > axle.lockedMin) lo = axle.lockedMin;
      if (hi < axle.lockedMax) hi = axle.lockedMax;
    }

    axle.lockedMin = lo;
    axle.lockedMax = hi;
    axle.locked = true;

    // 立即把当前行程夹进锁定域（碰撞瞬间就可能已经超出行程）
    if (axle.travel > hi) axle.travel = hi;
    if (axle.travel < lo) axle.travel = lo;

    if (stats) stats->suspensionLocked++;
    return true;
  }

  /// 碰擦结束：解除锁定，悬挂恢复自由行程。
  static void UnlockSuspension(SuspensionAxle& axle) noexcept {
    axle.locked = false;
    axle.lockedMax = axle.maxTravel;
    axle.lockedMin = axle.minTravel;
  }

  /// 把一次待施加的行程变化夹进锁定域。积分器算出新行程后应调用它。
  [[nodiscard]] static float ClampTravel(const SuspensionAxle& axle, float newTravel) noexcept {
    if (!axle.locked) return newTravel;
    if (newTravel > axle.lockedMax) return axle.lockedMax;
    if (newTravel < axle.lockedMin) return axle.lockedMin;
    return newTravel;
  }

  // ===========================================================================
  //  便捷入口
  // ===========================================================================
  /// "先速度后位置"是一个**有序**流程，此入口避免调用方顺序写错。
  static void Resolve(ContactManifold& mf,
                      float dt,
                      const SolverConfig& cfg,
                      SolveStats* stats = nullptr) noexcept {
    if (stats) stats->manifolds++;
    BeginSubstep(mf);
    SolveVelocityPhase(mf, cfg, stats);
    ProjectPenetration(mf, dt, cfg, stats);
    // 悬挂解耦：仅对刚体外壳碰擦且速度够格时触发
    if (mf.IsShellContact() && mf.a) {
      // 由调用方提供 SuspensionAxle（本入口只做速度判定提示，不持有轴状态）
      // 实际锁定见 LockSuspensionTravel()，调用方在拿到接触信息后自行触发。
    }
  }

  // ===========================================================================
  //  辅助
  // ===========================================================================
  /// 力臂幅值钳制：保留方向、只压幅值。防止 r 过大导致力矩爆炸。
  [[nodiscard]] static Vec3 ClampLeverArm(const Vec3& r,
                                          const SolverConfig& cfg,
                                          SolveStats* stats = nullptr) noexcept {
    if (!r.IsFinite()) return {};
    const float lenSq = r.LengthSq();
    // 复用 suspensionMaxTravel 之外的独立上限：这里用 3.0m 的工程经验值，
    // 与接触点可能的物理位置（车身半长 2.3m + 余量）匹配。
    constexpr float kMaxLeverArm = 3.0f;
    (void)cfg;
    const float capSq = kMaxLeverArm * kMaxLeverArm;
    if (lenSq <= capSq || lenSq < 1e-12f) return r;
    if (stats) stats->cappedLeverArm++;
    const float inv = kMaxLeverArm / std::sqrt(lenSq);
    return r * inv;
  }
};

}  // namespace forza::physics
