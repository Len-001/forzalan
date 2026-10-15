// =============================================================================
//  rigid_body_replicator.h —— 高速刚体的状态外推 + 视觉/物理双层解耦平滑
//
//  适用：200km/h+ 的赛车刚体，在 UDP / WebRTC DataChannel 上以 20~60Hz 同步。
//
//  ── 为什么不能"收到快照就 Snap" ─────────────────────────────────────────────
//  直接令 physPos = snap.pos 会让渲染位置瞬间跳变（Rubberbanding）。
//  本模块把物理权威层与渲染层**彻底解耦**：
//
//     · 物理层（phys*）：时刻等于服务端权威状态，碰撞/命中判定只用它。
//     · 视觉层（visual*Offset）：承接每帧被物理层"甩掉"的空间误差，
//       用指数衰减（半衰期 80~100ms）平滑归零。
//     · 渲染层 = 物理层 + 视觉偏移。它在空间上**连续**，绝不跳变。
//
//  ── 三大机制 ────────────────────────────────────────────────────────────────
//   1) 高阶航位推测：p += v·dt + ½a·dt²，v += a·dt，q 用指数映射积分角速度；
//      外推时长硬截断 **150ms**（规格值），超时**不再沿旧速度飞出去**，
//      而是转成"阻尼滑行"（速度按半衰期缓慢衰减）—— 见 Update 的 A-2 段。
//   2) 双层误差融合：纠偏瞬间算误差向量 → 塞进视觉偏移层 → 指数衰减。
//      四元数误差走 **误差四元数 + slerp**，且**强制短弧**（dot(q1,q2)<0 时反转）。
//   3) 渲染变换输出 GetVisualWorldTransform()。
//
//  ── 为什么必须强制短弧（dot < 0 反转）─────────────────────────────────────────
//  四元数 q 与 −q 表示**同一个旋转**，但 slerp 走的是球面测地线：
//  若 dot(q_a, q_b) < 0，glm::slerp 会沿"长弧"插值 —— 视觉上就是姿态
//  **反转翻滚一大圈**（例如从 179° 转到 −179°，本该只走 2°，
//  却绕了 358° 转一整圈回来）。
//  本模块在**三个**位置都必须重置半球：
//    ① 快照旋转进入 physRot_ 前（否则物理层自身可能翻到另一半；
//       虽然物理旋转本身不插值，但它是 visOffRot_ 的基准）；
//    ② 计算 visOffRot_ 时（相对 physRot_ 的误差四元数，取短弧）；
//    ③ 每帧 slerp 衰减前（identity 与 visOffRot_ 之间）。
//  ③ 尤其关键：即便 ② 给出了短弧误差，指数衰减过程中
//  （slerp(identity, q, k) 的 t 在 (0,1)）也不会自行跳半球，
//  但**归一化与乘法**可能把 w 推到负侧，所以每帧仍要显式兜一次。
//
//  ── 衰减公式（位置 / 旋转共用一个半衰期）────────────────────────────────────
//      半衰期 T½ → 衰减率 λ = ln2 / T½
//      每帧保留系数 k = exp(−dt / T½)   ≡ exp(−λ·dt)
//      k = exp(−dt · ln2 / T½)          ← 注意 ln2，写成 exp(−dt/T½) 是错的
//      visualPosOffset *= k
//      visualRotOffset  = slerp(identity, visualRotOffset, k)
//
//    用 exp(−dt/T½) 而不是"每帧乘固定系数"是**必须**的：
//    后者在 144Hz 显示器上衰减会快 2.4 倍，同一份逻辑在不同刷新率下表现不一致。
//    exp 形式天然帧率无关（可自行用 verify_blending.py 复现该结论）。
//
//  ── 线程模型（无锁）────────────────────────────────────────────────────────
//  核心类**非线程安全**，约定只在渲染线程内使用；
//  网络线程到渲染线程的快照投递走 SnapshotMailbox（seqlock 单生产者单消费者），
//  全程无锁、无堆分配。
// =============================================================================
#pragma once

#include <atomic>
#include <cmath>          // expf（DecayFactor 用；**必须显式包含**）
#include <cstddef>
#include <cstdint>
#include <type_traits>

// GLM 1.0.x：gtx/* 是**实验性扩展**，不定义这个宏会直接 #error 编不过。
// 而且必须在**任何 glm 头之前**定义 —— 放在 include 之后就失效了。
// 用到 gtx/quaternion.hpp（glm::angle / glm::slerp）就必须开。
#ifndef GLM_ENABLE_EXPERIMENTAL
#  define GLM_ENABLE_EXPERIMENTAL
#endif

#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>   // glm::translate —— glm.hpp **不会**带进来
#include <glm/gtc/quaternion.hpp>         // mat4_cast / normalize / inverse(quat)
#include <glm/gtx/quaternion.hpp>         // angle / slerp / dot(quat)

// ── 关于 include 的说明（写给后来者，都是真实踩过的坑）───────────────────────
//  · glm.hpp **不包含** gtc/* 全集。`glm::translate` 属 gtc/matrix_transform.hpp，
//    漏了它只会在**使用处**报 "no member named 'translate'"，很难一眼定位。
//  · `glm::angle` / `glm::slerp` / `glm::dot(quat,quat)` 属 gtx/quaternion.hpp，
//    同样不在 glm.hpp 里。
//  · expf 是 <cmath> 的东西；glm.hpp 不保证把它带进来。

namespace forza::net {

// =============================================================================
//  1. 网络快照（紧凑、内存布局确定）
// =============================================================================

/**
 * 刚体网络快照。
 *
 * 布局刻意手工补 pad 到 16 字节对齐，而不是 #pragma pack(1)：
 *   · 未对齐的 vec3 在 ARM/NEON 上会触发非对齐访存惩罚甚至 trap；
 *   · 显式 pad 让**任何编译器**下 size/offset 都一致，可直接 memcpy 上线。
 *
 * 实测布局（static_assert 会在编译期钉住）：
 *   off  0  frame            uint32   权威物理帧号（单调递增，用于丢弃过期包）
 *   off  4  tickMs           uint32   服务端单调时钟毫秒
 *   off  8  serverTimeSec    float    服务端时间轴秒（用于外推插值）
 *   off 12  _pad0
 *   off 16  position         vec3
 *   off 28  _pad1
 *   off 32  rotation         quat     (w,x,y,z)
 *   off 48  velocity         vec3
 *   off 60  _pad2
 *   off 64  angularVelocity  vec3     rad/s
 *   off 76  _pad3
 *   off 80  accel            vec3     线加速度（高阶外推用）
 *   off 92  _pad4
 *   size 96，align 16
 */
struct alignas(16) RigidBodyNetSnapshot final {
  std::uint32_t frame          = 0;
  std::uint32_t tickMs         = 0;
  float         serverTimeSec  = 0.0F;
  float         _pad0          = 0.0F;

  glm::vec3     position{0.0F};        ///< 世界坐标 (m)
  float         _pad1          = 0.0F;

  glm::quat     rotation{1.0F, 0.0F, 0.0F, 0.0F};   ///< (w,x,y,z)
  // glm::quat 本身 16 字节，不需要额外 pad

  glm::vec3     velocity{0.0F};        ///< 线速度 (m/s)
  float         _pad2          = 0.0F;

  glm::vec3     angularVelocity{0.0F}; ///< 角速度 (rad/s)
  float         _pad3          = 0.0F;

  glm::vec3     accel{0.0F};           ///< 线加速度 (m/s²)，用于 ½a·dt² 项
  float         _pad4          = 0.0F;
};

// 先把 vec3 的尺寸钉死：若工程定义了 GLM_FORCE_ALIGNED_GENTYPES（SIMD 构建常见），
// glm::vec3 会变成 16 字节，下面那些偏移断言会全部失败 ——
// 那种报错信息很容易被误读成"结构体写错了"，所以这里先给一条**指向真因**的提示。
static_assert(sizeof(glm::vec3) == 12,
              "本快照的线格式假定 glm::vec3 为 12 字节（GLM 默认）。若工程开了 "
              "GLM_FORCE_ALIGNED_GENTYPES，请重新推导字段偏移并同步协议版本号，"
              "不要直接改本 static_assert 的期望值。");

static_assert(std::is_trivially_copyable_v<RigidBodyNetSnapshot>,
              "快照必须可平凡复制（要能直接 memcpy 上线）");
static_assert(alignof(RigidBodyNetSnapshot) == 16, "快照必须 16 字节对齐");
static_assert(sizeof(RigidBodyNetSnapshot) == 96, "快照布局被改动，需同步更新网络协议");

// 逐字段偏移也钉死（防止有人调换成员顺序而悄悄破坏协议）
static_assert(offsetof(RigidBodyNetSnapshot, position) == 16, "position 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, rotation) == 32, "rotation 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, velocity) == 48, "velocity 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, angularVelocity) == 64, "angularVelocity 偏移变了");
static_assert(offsetof(RigidBodyNetSnapshot, accel) == 80, "accel 偏移变了");

// =============================================================================
//  2. 配置
// =============================================================================

enum class ReplState : std::uint8_t {
  Empty = 0,        ///< 还没收到过任何快照
  Extrapolating,    ///< 正常：在两次快照之间做航位推测
  Corrected,        ///< 本帧刚收到纠偏（视觉偏移层非零）
  Stale,            ///< 外推已超过上限（丢包），状态可信度低
};

struct ReplicatorConfig final {
  /// 误差衰减半衰期 (s)。规格推荐 80~100ms：太短会看到抖动，太长会"拖尾"。
  float halfLifeSec        = 0.080F;

  /// 外推时长上限 (s)：**规格 150ms**。超过它就停止沿旧速度推进
  /// （防丢包时按旧速度一路飞出地图），转入"阻尼滑行"。
  float maxExtrapolationSec = 0.150F;

  /// 加速度可信时长 (s)：只在这段时间内使用 ½a·dt² 项。
  /// 加速度是**二阶**量，误差随时间平方放大，比速度敏感得多，
  /// 所以它的有效期必须显著短于位置外推上限。
  float accelTrustSec      = 0.100F;

  /// 滑行阻尼半衰期 (s)：外推触顶后速度按它指数衰减（"维持当前速度阻尼滑行"）。
  /// 取 0.6s：既让车看起来还在滑（不硬刹停），又能在 2s 内明显收住，
  /// 不至于让"丢包 3 秒的车"在屏幕上继续以 250km/h 直线穿越整张地图。
  float coastHalfLifeSec   = 0.600F;

  /// 视觉位置偏移的硬上限 (m)：超过它说明发生了传送/重生，
  /// 此时衰减会在几帧内拉出一条长尾（"滑行半个赛道"），必须直接吸附清零。
  float snapDistanceM      = 5.0F;

  /// 视觉旋转偏移的硬上限 (rad)：同理，超过就是重生级别的跳变。
  float snapAngleRad       = 0.9F;    // ≈52°

  /// 角速度可信时长 (s)：角速度积分误差同样随时间放大
  float omegaTrustSec      = 0.150F;
};

// =============================================================================
//  3. 快照邮箱（seqlock，单生产者单消费者，无锁）
// =============================================================================

/**
 * 网络线程 -> 渲染线程的快照投递。
 *
 * 为什么用 seqlock 而不是互斥量/双缓冲：
 *   · 快照很小（96B），拷贝代价远低于一次 futex 唤醒；
 *   · 语义是"**最新覆盖旧**"，丢中间帧完全可接受 —— 正是 seqlock 最擅长的场景。
 *
 * 读侧：若读到撕裂数据则自动重试（seq 为奇数表示写入中，或前后不一致）。
 * 代价：读侧理论上可能饥饿（写入极频繁时），实际 20~60Hz 写入下不可能发生。
 */
// ⚠️ 为什么不用 std::atomic<RigidBodyNetSnapshot>（这是本类唯一的一处理论妥协，务必知情）
//
//   std::atomic<T> 只有在 T 足够小（x86-64 上 ≤16 字节）时才 truly lock-free。
//   96 字节的原子对象会**退化成内部加锁** —— 那就违背了本模块"无锁"的要求本身。
//   下面这条断言把"退化"这件事钉在编译期，作为设计取舍的证据而非口头声明。
//   若哪天它变成 false（说明目标平台能做 96B 无锁原子），就可以直接用
//   std::atomic<RigidBodyNetSnapshot> 替掉 seqlock，规避下面说的理论 UB。
static_assert(!std::atomic<RigidBodyNetSnapshot>::is_always_lock_free,
              "本平台可对 96B 做无锁原子 -> 请改用 std::atomic<RigidBodyNetSnapshot>，"
              "以消除 seqlock 载荷的理论 data race（见 SnapshotMailbox 说明）");

/**
 * 网络线程 -> 渲染线程的快照投递（单生产者单消费者）。
 *
 * 【已知的理论限制 —— 别当 bug，也别当它已解决】
 *   seqlock 的**载荷 slot_ 不是原子对象**：写者修改它的同时，读者可能正在读。
 *   严格按 ISO C++ 字面讲，这构成 data race（UB）。这是 seqlock 的**通病** ——
 *   Linux 内核 seqlock.h 与各类无锁库都是这么实现的，理由：
 *     · 两道 release/acquire 栅栏把"读到撕裂数据"变成**可检测**（重试即可），
 *       在 x86-64 / ARM64 上实际不会读到撕裂值；
 *     · 想要**严格符合标准**只有两条路，都比这慢：
 *       (a) slot_ 换成 std::atomic<Snapshot> —— 96B 会退化成锁（见上面 static_assert）；
 *       (b) 双缓冲 + atomic<uint32_t> 索引翻转 —— 96B×2 可接受，
 *           是**严格符合标准**的推荐方案（读侧拿到索引后至少跨越 1 次写才算安全）。
 *   本项目在"单生产者 + 最新覆盖旧 + 96B 小拷贝"的约束下选了 seqlock：
 *   性能与复杂度最优。若你的合规/认证要求严格符合标准，请切到 (b)。
 */
class SnapshotMailbox final {
 public:
  SnapshotMailbox() noexcept = default;

  SnapshotMailbox(const SnapshotMailbox&)            = delete;
  SnapshotMailbox& operator=(const SnapshotMailbox&) = delete;

  /// 生产者侧调用（网络线程）。可能被频繁调用，后写覆盖先写。
  void Publish(const RigidBodyNetSnapshot& s) noexcept {
    const std::uint32_t s0 = seq_.load(std::memory_order_relaxed);
    seq_.store(s0 + 1U, std::memory_order_relaxed);          // 进入写入（变奇数）
    std::atomic_thread_fence(std::memory_order_release);
    slot_ = s;                                               // 平凡拷贝，无分配
    std::atomic_thread_fence(std::memory_order_release);
    seq_.store(s0 + 2U, std::memory_order_relaxed);          // 退出写入（变偶数）
  }

  /// 消费者侧调用（渲染线程）。@return false 表示暂无可用新数据
  bool TryConsume(RigidBodyNetSnapshot& out, std::uint32_t& outVersion) noexcept {
    for (int attempt = 0; attempt < kMaxRetry; ++attempt) {
      const std::uint32_t v0 = seq_.load(std::memory_order_acquire);
      if ((v0 & 1U) != 0U) continue;                          // 写入进行中
      const RigidBodyNetSnapshot snapshot = slot_;
      std::atomic_thread_fence(std::memory_order_acquire);
      if (seq_.load(std::memory_order_relaxed) != v0) continue;  // 读中被打断，重试
      if (v0 == consumed_) return false;                      // 没有新版本
      consumed_ = v0;
      out = snapshot;
      outVersion = v0 >> 1;                                   // 版本号 = 写入次数
      return true;
    }
    return false;
  }

  [[nodiscard]] std::uint32_t Version() const noexcept {
    return seq_.load(std::memory_order_acquire) >> 1;
  }

 private:
  static constexpr int kMaxRetry = 8;

  RigidBodyNetSnapshot   slot_{};         ///< 唯一数据槽（96B）
  alignas(64) std::atomic<std::uint32_t> seq_{0};   ///< 独立缓存行，避免伪共享
  std::uint32_t consumed_ = 0;            ///< 仅消费者读写
};

// =============================================================================
//  4. NetworkRigidBodyReplicator
// =============================================================================

/**
 * 刚体复制器。生命周期内**零堆分配**（全部成员是 POD / GLM 值类型）。
 * 纯头文件、完全内联，可直接塞进渲染循环。
 *
 * 用法（典型 rAF 循环）：
 *
 *   // 网络线程
 *   mailbox.Publish(snap);
 *
 *   // 渲染线程
 *   RigidBodyNetSnapshot s{}; std::uint32_t ver = 0;
 *   if (mailbox.TryConsume(s, ver)) repl.OnAuthoritativeSnapshot(s);
 *   repl.Update(nowSec, dtSec);                       // 外推 + 误差衰减
 *   const glm::mat4 model = repl.GetVisualWorldTransform();
 *   draw(model);                                      // 渲染用视觉层
 *   // 碰撞/命中判定用物理层：
 *   const glm::mat4 phys = repl.GetPhysicsTransform();
 */
class NetworkRigidBodyReplicator final {
 public:
  NetworkRigidBodyReplicator() noexcept = default;
  explicit NetworkRigidBodyReplicator(const ReplicatorConfig& cfg) noexcept : cfg_(cfg) {}

  void SetConfig(const ReplicatorConfig& cfg) noexcept { cfg_ = cfg; }
  [[nodiscard]] const ReplicatorConfig& Config() const noexcept { return cfg_; }

  // ---------------------------------------------------------------------------
  //  权威层：物理状态
  // ---------------------------------------------------------------------------

  [[nodiscard]] const glm::vec3& PhysicsPosition() const noexcept { return physPos_; }
  [[nodiscard]] const glm::quat& PhysicsRotation() const noexcept { return physRot_; }
  [[nodiscard]] const glm::vec3& PhysicsVelocity() const noexcept { return physVel_; }
  [[nodiscard]] const glm::vec3& PhysicsAngularVelocity() const noexcept { return physOmega_; }
  [[nodiscard]] ReplState State() const noexcept { return state_; }
  [[nodiscard]] float ExtrapolatedSec() const noexcept { return extrapolated_; }
  [[nodiscard]] bool IsCoasting() const noexcept { return coasting_; }
  [[nodiscard]] std::uint32_t LastFrame() const noexcept { return lastFrame_; }
  [[nodiscard]] bool HasState() const noexcept { return state_ != ReplState::Empty; }

  // ---------------------------------------------------------------------------
  //  视觉层：误差偏移
  // ---------------------------------------------------------------------------

  [[nodiscard]] const glm::vec3& VisualPositionOffset() const noexcept { return visOffPos_; }
  [[nodiscard]] const glm::quat& VisualRotationOffset() const noexcept { return visOffRot_; }
  [[nodiscard]] float VisualPositionErrorM() const noexcept { return glm::length(visOffPos_); }

  // ---------------------------------------------------------------------------
  //  核心 1：收到权威快照 -> 物理层纠偏 + 误差塞进视觉层
  // ---------------------------------------------------------------------------

  /**
   * @param s 权威快照
   * @return true  = 接受（新帧）
   *         false = 丢弃（帧号过期，乱序通道下的正常现象）
   */
  bool OnAuthoritativeSnapshot(const RigidBodyNetSnapshot& s) noexcept {
    // 过期包直接丢：WebRTC unreliable / UDP 下乱序是常态
    if (state_ != ReplState::Empty && s.frame <= lastFrame_) {
      ++staleDropped_;
      return false;
    }

    if (state_ == ReplState::Empty) {
      // 首次：没有历史连续性可言，直接对齐，且不产生任何视觉偏移
      physPos_   = s.position;
      physRot_   = NormalizeSafe(s.rotation);
      physVel_   = s.velocity;
      physOmega_ = s.angularVelocity;
      physAcc_   = s.accel;
      visOffPos_ = glm::vec3(0.0F);
      visOffRot_ = kIdentity;
      lastFrame_ = s.frame;
      lastServerTimeSec_ = s.serverTimeSec;
      extrapolated_ = 0.0F;
      state_ = ReplState::Corrected;
      return true;
    }

    // ---- 双层解耦的关键四步 ----
    // 0) 半球归一：把新快照的旋转搬到与当前 physRot_ 同半球的一侧。
    //    快照里的 quat 与 −quat 表示同一姿态，但服务端两次发的一致表示不保证
    //    连续（量化/序列化可能翻符号）；若直接采信，next 步算出的误差四元数
    //    会是"长弧"版本，触发规格里说的长弧度翻滚。
    const glm::quat newPhysRot = ShortArc(physRot_, NormalizeSafe(s.rotation));

    // 1) 记录"当前视觉空间"状态（= 旧物理层 + 尚未衰减完的偏移）
    const glm::vec3 curVisualPos = physPos_ + visOffPos_;
    const glm::quat curVisualRot = glm::normalize(physRot_ * visOffRot_);

    // 2) 物理层**直接采用**权威状态（碰撞判定立刻生效，不掺任何平滑）
    physPos_   = s.position;
    physRot_   = newPhysRot;
    physVel_   = s.velocity;
    physOmega_ = s.angularVelocity;
    physAcc_   = s.accel;
    lastFrame_ = s.frame;
    lastServerTimeSec_ = s.serverTimeSec;
    extrapolated_ = 0.0F;
    coasting_ = false;

    // 3) 把"物理层被甩掉的位移"转移进视觉偏移 —— 于是视觉位置**保持不变**，无跳变
    const glm::vec3 newOffPos = curVisualPos - physPos_;
    // 误差四元数必须取短弧：它决定"姿态要往回转多少"。
    // 若取长弧，glm::angle() 会把 2° 的误差报成 358°，
    // 下一步的传送保护就会误判成"重生级跳变"而硬吸附 —— 纠偏反而变成瞬移。
    const glm::quat newOffRot =
        ShortArc(kIdentity, glm::normalize(glm::inverse(physRot_) * curVisualRot));

    // 4) 传送/重生保护：误差过大时衰减会长尾滑行，必须直接吸附
    const float distErr = glm::length(newOffPos);
    const float angErr  = glm::angle(newOffRot);      // glm::angle 返回 [0, π]；短弧下可信
    if (distErr > cfg_.snapDistanceM || angErr > cfg_.snapAngleRad) {
      visOffPos_ = glm::vec3(0.0F);
      visOffRot_ = kIdentity;
      ++snapCount_;
      hardSnapped_ = true;
    } else {
      visOffPos_ = newOffPos;
      visOffRot_ = newOffRot;
      hardSnapped_ = false;
    }
    state_ = ReplState::Corrected;
    return true;
  }

  // ---------------------------------------------------------------------------
  //  核心 2：每帧推进 —— 高阶外推 + 误差指数衰减
  // ---------------------------------------------------------------------------

  /**
   * @param dtSec 渲染帧间隔（必须来自真实计时，不能写死 1/60）
   *
   * 位置衰减：visualPosOffset *= 0.5^(dt/T½) = exp(−dt·ln2/T½)
   * 旋转衰减：visualRotOffset  = slerp(identity, visualRotOffset, 0.5^(dt/T½))
   *
   * 两者共用同一个保留系数 k，保证位置与旋转的收敛节奏一致
   * （否则视觉上会出现"位置已经对齐、姿态还在转"的割裂感）。
   *
   * ── 两个阶段的航位推测（规格 2 的完整落地）────────────────────────────────
   *   【推进期】extrapolated_ < maxExtrapolationSec（150ms）
   *     走完整高阶泰勒：p += v·dt + ½a·dt²，v += a·dt，姿态按 ω 积分。
   *   【滑行期】extrapolated_ >= maxExtrapolationSec
   *     **停止沿旧速度推进**（不再给 ½a·dt²，也不再积分 ω），
   *     改为"维持当前速度阻尼滑行"：位置继续以当前速度前进，
   *     但速度按 coastHalfLifeSec 指数衰减、角速度同理。
   *     语义是"这辆车的权威状态我们已经 150ms 没更新了，
   *     它大概还在动，但我们对它的动量越来越没信心"——
   *     比"立刻冻结在原地"自然得多（后者看起来像服务器卡住），
   *     也比"永远匀速飞出去"安全得多（后者会穿墙、飞出地图）。
   */
  void Update(float dtSec) noexcept {
    if (state_ == ReplState::Empty) return;
    if (dtSec <= 0.0F) return;

    // ---- A) 航位推测 ----
    if (extrapolated_ < cfg_.maxExtrapolationSec - 1e-6F) {
      // ---- A-1) 推进期：高阶泰勒外推，时长硬截断到上限 ----
      const float dtExtrap = (extrapolated_ + dtSec > cfg_.maxExtrapolationSec)
                                 ? (cfg_.maxExtrapolationSec - extrapolated_)
                                 : dtSec;
      if (dtExtrap > 0.0F) {
        // 加速度只在信任窗口内参与：它是二阶量，误差随 t² 放大
        const bool trustAcc = extrapolated_ < cfg_.accelTrustSec;
        const glm::vec3 a = trustAcc ? physAcc_ : glm::vec3(0.0F);

        physPos_ += physVel_ * dtExtrap + 0.5F * a * (dtExtrap * dtExtrap);
        physVel_ += a * dtExtrap;

        // 角速度积分：q' = q * exp(½·ω·dt)。
        // 用轴角构造增量四元数，比"欧拉角累加"稳定得多（无万向锁、无三角误差累积）。
        const bool trustOmega = extrapolated_ < cfg_.omegaTrustSec;
        if (trustOmega) {
          const float wLen = glm::length(physOmega_);
          if (wLen > 1e-6F) {
            const glm::quat dq = glm::angleAxis(wLen * dtExtrap, physOmega_ / wLen);
            physRot_ = NormalizeSafe(glm::normalize(physRot_ * dq));
          }
        }
        extrapolated_ += dtExtrap;
      }
      state_ = (extrapolated_ >= cfg_.maxExtrapolationSec - 1e-6F)
                   ? ReplState::Stale
                   : ReplState::Extrapolating;
      coasting_ = (state_ == ReplState::Stale);
    } else {
      // ---- A-2) 滑行期：外推已触顶，维持当前速度但阻尼衰减 ----
      // 位置仍按当前速度前进（视觉上"还在滑"），但速度/角速度按半衰期衰减。
      // 衰减律与视觉偏移层同构（exp(−dt·ln2/T½)），保证"位置在滑、误差在收"
      // 两条曲线的时间常数可比，不会出现互相打架的观感。
      const float kc = DecayFactor(dtSec, cfg_.coastHalfLifeSec);
      physPos_   += physVel_ * dtSec;
      physVel_   *= kc;
      physOmega_ *= kc;

      // 角速度已很小就彻底停转，避免长期挂着 1e-7 的角速度做无谓积分
      if (glm::dot(physOmega_, physOmega_) < kOmegaEps2) physOmega_ = glm::vec3(0.0F);
      if (glm::dot(physVel_, physVel_) < kOffsetEps2) physVel_ = glm::vec3(0.0F);

      state_ = ReplState::Stale;
      coasting_ = true;
    }

    // ---- B) 双层误差衰减 ----
    // k = 0.5^(dt/T½) = exp(−dt·ln2/T½)；半衰期 T½ 的含义：经过 T½ 秒后偏移只剩一半。
    // 必须用 exp 而非"每帧乘常数"，否则衰减速度会随显示器刷新率变化。
    const float k = DecayFactor(dtSec, cfg_.halfLifeSec);

    visOffPos_ *= k;

    // 四元数球面插值：slerp(identity, q, k) 等价于"把旋转误差按 k 保留"。
    // 注意用 slerp 而不是 nlerp —— 大角度偏差时 nlerp 的角速度不均匀，
    // 视觉上会出现"先快后慢"的节奏突变。
    //
    // ⚠️ 衰减前**必须**重置半球：把 visOffRot_ 换成与 identity 同半球的表示，
    //    否则 dot(identity, q) < 0 时 slerp 会走长弧 —— 视觉上就是
    //    "姿态反向翻滚一整圈"。这是规格里"四元数钝角插值导致长弧度翻滚"的正解。
    visOffRot_ = ShortArc(kIdentity, visOffRot_);
    visOffRot_ = NormalizeSafe(glm::slerp(kIdentity, visOffRot_, k));

    // 数值噪声清理：偏移小到肉眼不可见时直接归零，避免长期挂着一个 1e-7 的值
    // 让 glm::angle / length 每帧都做无谓计算。
    if (glm::dot(visOffPos_, visOffPos_) < kOffsetEps2) visOffPos_ = glm::vec3(0.0F);
    if (glm::abs(glm::dot(visOffRot_, kIdentity)) > 1.0F - kRotEps) visOffRot_ = kIdentity;

    if (state_ == ReplState::Corrected && glm::dot(visOffPos_, visOffPos_) < kOffsetEps2) {
      state_ = ReplState::Extrapolating;      // 视觉已完全贴合物理层
    }
  }

  // ---------------------------------------------------------------------------
  //  核心 3：渲染变换输出
  // ---------------------------------------------------------------------------

  /// 视觉层世界变换 = 物理权威状态 **叠加** 残余视觉偏移（渲染用这个）
  [[nodiscard]] glm::mat4 GetVisualWorldTransform() const noexcept {
    return glm::translate(glm::mat4(1.0F), physPos_ + visOffPos_) *
           glm::mat4_cast(glm::normalize(physRot_ * visOffRot_));
  }

  /// 视觉层的分解形式（拆开给需要单独用位置/朝向的渲染路径）
  [[nodiscard]] glm::vec3 GetVisualPosition() const noexcept { return physPos_ + visOffPos_; }
  [[nodiscard]] glm::quat GetVisualRotation() const noexcept {
    return glm::normalize(physRot_ * visOffRot_);
  }

  /// 物理层世界变换（碰撞 / 命中判定 / 权威回放用；绝不带视觉偏移）
  [[nodiscard]] glm::mat4 GetPhysicsTransform() const noexcept {
    return glm::translate(glm::mat4(1.0F), physPos_) * glm::mat4_cast(physRot_);
  }

  // ---------------------------------------------------------------------------
  //  工具
  // ---------------------------------------------------------------------------

  /**
   * 指数衰减保留系数。
   *
   *   k = 0.5^(dt / T½) = exp(−dt · ln2 / T½) = exp(−λ·dt)      λ = ln2 / T½
   *
   * ⚠️ **不要写成 exp(−dt / T½)**。那是把 T½ 当成「时间常数 τ」了：
   *     exp(−dt/τ) 在 dt=τ 时只剩 1/e ≈ 36.8%，不是 50%。
   *     半衰期必须带 ln2 因子（T½=90ms 对应 λ ≈ 7.70 /s）。
   *     这个错**在代码和注释里会一起理直气壮地错**，只能靠数值断言抓
   *     （见 verify_blending.py 的 V1：实测 0.3679 而不是 0.5）。
   *
   * 帧率无关性：连续两次各 dt/2 的衰减 = exp(−λ·dt/2)·exp(−λ·dt/2) = exp(−λ·dt)，
   * 与一次 dt 完全等价。（若写成"每帧乘固定 0.9"就不具备这个性质，
   * 144Hz 显示器上衰减会快 2.4 倍。）
   */
  [[nodiscard]] static float DecayFactor(float dtSec, float halfLifeSec) noexcept {
    if (halfLifeSec <= 1e-6F) return 0.0F;
    return expf(-dtSec * kLn2 / halfLifeSec);
  }

  /// 与 DecayFactor 等价的衰减率（λ = ln2 / T½），供遥测/曲线调参使用
  [[nodiscard]] static float DecayRatePerSec(float halfLifeSec) noexcept {
    return (halfLifeSec <= 1e-6F) ? 0.0F : (0.6931471805599453F / halfLifeSec);
  }

  /// 重置（重生 / 换车 / 断线重连）
  void Reset() noexcept { *this = NetworkRigidBodyReplicator(cfg_); }

  [[nodiscard]] std::uint32_t StaleDroppedCount() const noexcept { return staleDropped_; }
  [[nodiscard]] std::uint32_t HardSnapCount() const noexcept { return snapCount_; }
  [[nodiscard]] bool LastCorrectionWasHardSnap() const noexcept { return hardSnapped_; }

 private:
  // 用 inline const 而不是 constexpr：
  // GLM 各版本对 quat 的 constexpr 支持不一致（0.9.9 之前基本没有），
  // 写 constexpr 会在部分 GLM 版本上直接编不过。C++17 的 inline 变量已经保证单一定义。
  static inline const glm::quat kIdentity{1.0F, 0.0F, 0.0F, 0.0F};
  static constexpr float kLn2 = 0.6931471805599453F;
  static constexpr float kOffsetEps2 = 1e-8F;    // (0.1mm)²
  static constexpr float kOmegaEps2  = 1e-8F;
  static constexpr float kRotEps     = 1e-9F;

  [[nodiscard]] static glm::quat NormalizeSafe(const glm::quat& q) noexcept {
    const float d = glm::dot(q, q);
    return (d > 1e-12F) ? glm::normalize(q) : kIdentity;
  }

  /**
   * 强制短弧：返回与 `ref` 同半球的 `q`（dot < 0 则取 −q）。
   *
   * 四元数 q 与 −q 表示同一个旋转，但 slerp 沿球面测地线走：
   * 若 dot(ref, q) < 0，插值会绕**长弧**——视觉上就是姿态反向翻滚一整圈。
   * 在进入 slerp / 做四元数差值之前统一调用它，是消除"钝角插值翻滚"的唯一手段。
   *
   * 注意：glm::slerp **自己**也会做半球校正，所以本函数不是"为了 slerp 正确"，
   * 而是为了让**我们算出来的误差四元数 visOffRot_ 本身**落在短弧一侧 ——
   * 否则 glm::angle(visOffRot_) 会把 2° 的误差报成 358°，
   * 直接误触发 snapAngleRad 传送保护、把好端端的平滑纠偏变成硬吸附。
   */
  [[nodiscard]] static glm::quat ShortArc(const glm::quat& ref,
                                          const glm::quat& q) noexcept {
    return (glm::dot(ref, q) < 0.0F) ? glm::quat(-q.w, -q.x, -q.y, -q.z) : q;
  }

  ReplicatorConfig cfg_{};

  // ---- 物理权威层 ----
  glm::vec3 physPos_{0.0F};
  glm::quat physRot_{1.0F, 0.0F, 0.0F, 0.0F};
  glm::vec3 physVel_{0.0F};
  glm::vec3 physOmega_{0.0F};
  glm::vec3 physAcc_{0.0F};

  // ---- 视觉平滑层 ----
  glm::vec3 visOffPos_{0.0F};                 ///< 世界空间的残余位置误差
  glm::quat visOffRot_{1.0F, 0.0F, 0.0F, 0.0F};  ///< physRot 的**局部**残余旋转

  // ---- 状态 ----
  ReplState   state_ = ReplState::Empty;
  std::uint32_t lastFrame_ = 0;
  float       lastServerTimeSec_ = 0.0F;
  float       extrapolated_ = 0.0F;
  bool        coasting_ = false;     ///< 是否已进入"阻尼滑行"阶段（外推触顶后）
  std::uint32_t staleDropped_ = 0;
  std::uint32_t snapCount_ = 0;
  bool        hardSnapped_ = false;
};

}  // namespace forza::net
