/* =============================================================================
 * physics.js —— 仿《极限竞速8》核心竞技物理
 *
 * 【架构：Cannon 车体与分层 Heightfield 路面】
 *   路面使用 track.js 生成的高分辨率、分层静态 Cannon Heightfield；四轮悬挂
 *   通过 track.raycastRoad() 对实际碰撞形状做射线查询，桥面与桥下地面按当前高度
 *   选择，解析 sample() 只负责赛道索引/横向位置等 bookkeeping。
 *   四台车各是一个 Box 刚体（4.0 x 1.8 x 1.2m / 1300kg），由 Cannon 求解
 *   撞车动量转移、推挤、并排摩擦和路面接触；悬挂弹簧只把四轮物理命中转换为
 *   车身支撑力，不再把解析路面当作唯一碰撞面。
 *
 * 【坐标系约定 —— 上一版"转向反向"的根因就在这里，务必先读】
 *   车体局部轴：+Z = 车头，+Y = 车顶，+X = 车身【左侧】。
 *   为什么 +X 是左侧？右手系下观察者的右手满足 right = forward × up，
 *   代入 forward=(0,0,1)、up=(0,1,0) 得 right = (0,0,1)×(0,1,0) = (-1,0,0)。
 *   即：一个 +Z 朝前的模型，它的局部 +X 在司机视角里是【左手边】。
 *   上一版把 +X 当成"右侧"去映射键盘 -> 按 D/→ 实际向左转，这就是转向相反的真因
 *   （AI 用同一套向量，所以自洽，测试没暴露 —— 单测必须显式断言"往哪边转"）。
 *
 *   本版统一显式命名，杜绝歧义：
 *     c.lateralDir —— 局部 +X，即车身左侧轴
 *     c.rightSide  —— 车身真正的右侧（= -lateralDir）
 *   对外输入约定：
 *     input.steer > 0   车手想【向右】转
 *     steerAngle  > 0   前轮绕 +Y 正向偏转 = 指向左侧（视觉与物理一致）
 *     yaw(绕 +Y)  > 0   车头转向左侧
 *   因此 driveLocal 中 steerAngle = -steerInput * maxSteer 的那个负号是必需的，不是笔误。
 *
 * 【实现的核心规则】
 *   1. 吸尾流 Slipstream：前车尾锥 ±12° / 3~25m / 前车 > 50km/h -> 风阻 -35%、
 *      极速 +15%。只取最近的一台有效前车，避免多车叠加。
 *   2. 顶前车 Bump Drafting：后车车头与前车车尾接触，相对夹角 < 20° 且相对时速 < 25km/h
 *      -> 给前车沿其前进方向的加速冲量，后车施加阻尼缓冲（保持稳定不弹开）。
 *   3. 罚时 Forza Race Regulations：四轮出沥青（进入草地）后每累计 0.5s 罚 0.5s；
 *      跳过 Checkpoint 切弯每个罚 0.5s；>40° 高速侧撞判恶意撞击，+2.0s。
 *   4. 完赛成绩 = 净用时 + 累计罚时（净用时由服务端时钟给定，见 network.js）。
 * ========================================================================== */

import * as CANNON from '../libs/cannon-es.js';
import { registerTrackBodies, ROAD_COLLISION_GROUP } from './track.js';

const DEG = Math.PI / 180;

/** 车辆与赛道物理常量（全部为 SI 单位）
 *
 *  ── 坐标系提醒（见文件头）──────────────────────────────────────────────
 *  +Z 车头 / +Y 车顶 / +X 车身左侧；rightSide = -X。input.steer>0 = 向右。
 * ────────────────────────────────────────────────────────────────────── */
export const CFG = {
  // ---------------- 车体 ----------------
  // FM8 GT 组别房车基准（SI 单位：kg / m / s / N）
  MASS: 1380,                          // 整备质量（含车手与燃油）
  CG_H: 0.45,                          // 质心高度 h —— 决定载荷转移强度
  TRACK_W: 1.6,                        // 轮距 W
  WEIGHT_FRONT: 0.52,                  // 前轴静态配重 52:48
  HALF: { x: 0.9, y: 0.6, z: 2.0 },   // Box 半尺寸：宽1.8 / 高1.2 / 长4.0
  RIDE_H: 0.62,                        // 底盘中心离地高度
  CHASSIS_CLEARANCE: 0.04,              // 车壳底部与物理路面留出的防穿透余量
  RAYCAST_SUSPENSION_LENGTH: 2.4,      // 四轮 Heightfield 射线有效长度
  WHEEL: [                              // 四轮接地点（局部 X=左轴方向, Z=前正）
    [-0.80, 1.35], [0.80, 1.35],        // 前右 / 前左
    [-0.80, -1.35], [0.80, -1.35],      // 后右 / 后左
  ],
  WHEELBASE: 2.70,                     // 轴距 L

  // ---------------- 动力总成：6 档扭矩曲线 + 主减速比 ----------------
  // 扭矩曲线：低转段线性上爬，4500rpm 达峰 450N·m，红线 7500rpm 断油。
  ENGINE_TORQUE_PEAK: 450,     // N·m @ TORQUE_PEAK_RPM
  TORQUE_PEAK_RPM: 4500,
  REDLINE_RPM: 7500,
  IDLE_RPM: 1100,
  TORQUE_LOW_FACTOR: 0.62,     // 低转扭矩系数（相对峰值）
  GEAR_RATIOS: [3.36, 2.19, 1.60, 1.24, 1.00, 0.83],  // 6 档
  FINAL_DRIVE: 3.55,           // 主减速比
  DRIVELINE_EFF: 0.90,         // 传动效率
  WHEEL_RADIUS: 0.34,          // 驱动轮滚动半径 (m)
  SHIFT_TIME: 0.12,            // 换档动力切断时间 (s)
  SHIFT_UP_RPM: 7350,          // 升档转速
  SHIFT_DOWN_RPM: 3200,        // 降档转速
  BRAKE_TORQUE: 4200,          // 单轮制动扭矩 (N·m) -> 四轮制动力约 49kN
  MAX_FORCE: 15600,            // 轮胎纵向力上限（≈1.15g 弹射；仍低于后轴附着极限 21kN）
  REVERSE_FORCE: 3600,
  VMAX: 265 / 3.6,             // 73.61 m/s —— 平路极限最高时速 265km/h

  // ---------------- 空气动力学：平方级物理公式 ----------------
  // F_drag   = 0.5·ρ·Cd·A·v²     沿速度反方向
  // F_down   = 0.5·ρ·Cl·A·v²     垂直压向底盘 -> 动态增加轮胎正压力
  AIR_RHO: 1.225,         // ρ 空气密度 kg/m³
  CD: 0.34,               // 风阻系数
  CL: 0.85,               // 下压力系数
  AERO_BALANCE_FRONT: 0.42, // 气动前后平衡（42% 前轴 / 58% 后轴）
  FRONTAL_AREA: 2.1,      // 迎风面积 m²
  ROLL_K: 0.013,          // 滚动阻力系数 F = k·m·g
  VMAX_REV: 11,           // 倒车上限 m/s
  CRUISE_KMH: 60,         // 完赛后自动巡航速度**上界**（规格 §三：60km/h 慢游，不挡终点线）
  CRUISE_MIN_KMH: 50,     // 完赛后自动巡航速度**下界**（规格 §三：锁 50~60km/h 区间）
  // Pure Pursuit 完赛循迹的基准前视距离（m）（规格 §三：前视 15m 处的目标点）。
  // 实际前视随车速略微拉长（见 purePursuit），保证高速循迹稳定、低速不画龙。
  PURE_PURSUIT_LOOKAHEAD: 15,

  // ---- 起步让线（AI 车手）----
  // 发车瞬间四台车各自瞄"弯心偏移"，会同时插向同一条走线而并线互撞，
  // 被顶飞的会一路滚进沙地（实测 max|lateral| 冲到 49.5m、罚时累加 11s）。
  // 真实比赛起步也不会有人一放绿灯就横切抢线，因此让 AI 在起步阶段
  // **保持自己的发车横向位置**，走完 START_LANE_M 米后再平滑并入最佳走线。
  START_LANE_M: 200,      // 保持发车道的里程 (m)

  // ---------------- 转向（速度敏感限幅 + 指数滤波 + 低速非线性）----------------
  STEER_MAX_LOW: 0.55,    // <30km/h 最大前轮转角 (rad) ≈31.5°
  STEER_MAX_HIGH: 0.15,   // >120km/h 收紧到 (rad) ≈8.6°
  STEER_LOW_KMH: 30,
  STEER_HIGH_KMH: 120,
  // 转向滤波：currentSteer = damp(currentSteer, target, λ, dt)
  // 取代上一版的"线性限速"——线性限速在轻点时仍会匀速冲到目标，手感是"啪一下打满"；
  // 指数滤波前期快后期缓，模拟手打方向盘的机械行程。
  STEER_DAMP_LAMBDA: 14.0,  // 反打及时回正，仍保留连续转向滤波。
  // 低速非线性：车速低于 STEER_LOWSPEED_KMH 时把打盘量映射为 |input|^1.6
  STEER_LOWSPEED_KMH: 40,
  STEER_CURVE_EXP: 1.6,     // 规格值
  STEER_CURVE_FADE_KMH: 15, // 40km/h 附近线性淡出，避免手感在阈值处断层
  YAW_ACCEL: 12,          // 横摆角加速度上限 (rad/s²)
  // ★ 低速横摆阻尼系数 (1/s)：抵消"车尾甩来甩去"。见 driveLocal 的说明。
  YAW_DAMP_K: 5.5,
  YAW_MAX: 2.6,           // 常规横摆角速度上限 (rad/s)
  YAW_MAX_ABSOLUTE: 4.5,  // 含手刹甩尾/碰撞在内的绝对上限
  // 碰撞扰动窗口：撞车瞬间横摆角速度会很大，若立刻被控制器纠回就"撞了没反应"。
  // 该窗口内大幅降低横摆修正权限，让刚体真正按力矩失控打转，再由玩家反打救车。
  YAW_DISTURB_T: 0.35,      // 窗口时长 (s)
  YAW_DISTURB_AUTH: 0.20,   // 窗口内横摆修正权限系数

  // ---------------- 碰撞（低反弹 + 分离偏置）----------------
  // 车身接触保留 0.05 的低速回弹；Baumgarte/split-impulse 仍负责消除穿透，
  // 因此接触不会靠把 restitution 锁成 0 来隐藏几何错误。
  // friction 0.55 是钣金侧向刮蹭的动摩擦，配合下面的 90% 法向冲量衰减，
  // 两车贴身挤压时表现为并排滑动而不是乒乓球式反复弹开。
  RESTITUTION: 0.05,        // 规格：5% 低反弹接触
  CONTACT_FRICTION: 0.55,   // 规格：侧向刮蹭动摩擦
  // ---- 碰碰车模式（bumper）专用：把"贴身肉搏"换成"撞开" ----
  // 只在 gameMode === 'bumper' 时生效（见 _applyCarContactMode），拟真模式一律
  // 沿用上面的 5% / 0.55，所以既有的"剐蹭不弹皮球"红线完全不受影响。
  // restitution 0.62 取"明显弹开但仍可缠斗"；摩擦压到 0.06 防侧向钩挂后黏成一团。
  BUMPER_RESTITUTION: 0.62,
  BUMPER_CONTACT_FRICTION: 0.06,
  CONTACT_STIFFNESS: 5e5,   // 规格：contactEquationStiffness（软化接触，抑制数值抖动）
  CONTACT_RELAXATION: 16,    // 规格：contactEquationRelaxation
  // 切向剐蹭冲量截断：法向相对速度低于该阈值判为"并行挤压/轻微别车/侧翼刮蹭"，
  // 强制削减法向弹开冲量，仅保留侧向滑动阻尼与轻微偏航力矩 -> 贴身肉搏滑行。
  SOFT_CONTACT_MS: 3.5,     // 阈值 (m/s)（规格 §三.2）
  SOFT_CONTACT_CUT: 0.90,   // 法向弹开冲量削减 90%（规格值）
  TANGENTIAL_FRICTION: 0.65, // 并排刮蹭切向动摩擦（规格 §三.2）：把乒乓弹开变成钣金黏滞滑行
  SOFT_CONTACT_TTL: 8,      // 软接触对的生命周期（物理步），持续吸收接触后的刚度弹开

  // ---------------- Split Impulse 分离位置投影（方案 A）----------------
  // 位置修正在**独立通道**用伪速度推出，绝不写回 velocity —— 从根本上消除
  // "穿透越深、车获得的动能越大" -> 撞墙撞车不再弹飞。
  PEN_BETA: 0.8,            // 位置通道系数（不注入能量，可以比速度通道激进）
  PEN_SLOP: 0.005,          // 5mm 容差：容差内不修，避免静止接触每帧微调抖动

  // ---------------- 速度依赖自适应塑性恢复系数（方案 B，规格 §2 修订）----------------
  // 【本轮规格变更】旧版 REST_LO=0.35 / REST_HI=0.02 + smoothstep 过渡已**废弃**。
  // 新规格是严格的两段式：
  //   |v_rel| <  1.5 m/s : e = 0.05·(1 − |v_rel|/1.5)   ← 线性，低速轻碰有质感
  //   |v_rel| >= 1.5 m/s : e = 0.0f                      ← **严格零**，钣金完全塑性
  // 为什么必须"阈值以上严格 0"而不再是 0.02：
  //   0.02 看似无害，但 200km/h 下 0.02×55.6 = 1.11 m/s 的回弹速度，
  //   对 1380kg 车 = 851 J 回弹动能 —— 高刷屏下肉眼可见"撞墙弹一下"。
  PLASTIC_E_PEAK: 0.05,     // 规格 §2：低速峰值恢复系数
  PLASTIC_V_THRESH: 1.5,    // 规格 §2：塑性阈值 (m/s)，以上严格 e=0

  // ---------------- 防跳板法线平整化（方案 C，规格 §1 修订）----------------
  // 【本轮规格变更】旧的 NORMAL_Y_SLOP 放行门（"小于 0.02 不处理"）已**废弃**：
  //   小误差 × 大冲量同样致命 —— J=4e4 N·s 时 Δv_y = 4e4×0.02/1380 ≈ 0.58 m/s，
  //   足以让车在撞墙瞬间"抬头"。规格改为**无条件**平整化（只保留"纯垂直法线
  //   无法平整 -> 放弃"这一条退化保护）。
  NORMAL_FLAT_EPS: 1e-6,    // 规格 §1：水平分量模长低于此 = 纯垂直法线 -> 放弃解算

  // ---------------- Split Impulse 位置相（方案 A，规格 §3 修订）----------------
  // 【本轮规格变更】旧的 PEN_MAX_MS=8.0（名义推出速度）已**废弃**。
  // 规格直接约束**位移**：单个物理子步最大推开 0.03m，多余穿透在随后 5~10 帧
  // 内柔和推出。用位移而非速度的好处：不再依赖 dt，且一帧最多挪 3cm，
  // 视觉上永远不会有"闪现"。
  PUSH_MAX_M: 0.03,         // 规格 §3：单子步最大推开位移 (m)

  // ---------------- 冲量硬截断（规格 §5 修订）----------------
  // 【本轮规格变更】BAUMGARTE_IMPULSE 50000 -> 40000 N·s（规格值）。
  // 折算 1380kg 车单次 Δv 上限 = 4e4/1380 ≈ 28.99 m/s（104 km/h）。
  CAR_CONTACT_FRICTION: 0.35,  // 车-车切向摩擦（库仑锥系数）：金属刮擦量级
  HIT_GRACE_T: 2.5,        // 被撞后的免罚宽限 (s)：这期间出界只算事故
  IMPULSE_MAX_NS: 40000,    // 规格 §5：单个 Contact 最大法向冲量 (N·s)

  // ---------------- 悬挂解耦保护（规格 §4 新增）----------------
  // 外壳碰擦期间冻结悬挂行程上限，切断"冲量 -> 压死弹簧 -> 爆发回弹"的正反馈。
  SUSP_LOCK_SLACK: 0.15,    // 锁定后的行程上限 = SLACK × SUSP_MAX_TRAVEL（规格值 0.15）
  SUSP_LOCK_T: 0.25,        // 碰撞后解耦窗口时长 (s)：覆盖一次撞击的典型回弹周期

  // ---------------- 悬挂解耦（方案 D）----------------
  // 真实赛车撞墙时轮毂+轮胎先吸能，传到车架的力要经过悬挂弹簧-阻尼过滤。
  // 把冲量全额给整车刚体 = 瞬间获得角速度 -> 凌空翻滚。
  FLIP_W_CAP: 2.5,          // 俯仰/侧倾角速度硬上限 (rad/s)：翻车的直接防线
  UNSPRUNG_RATIO: 0.12,     // 簧下质量占比（轮圈+轮胎+制动）
  KICK_GAIN: 0.35,          // 被悬挂吸收的剩余能量 -> 车身抖动比例

  // ---------------- 碰撞反冲硬限幅（规格 §任务5）----------------
  // 被追尾/侧蹭车尾：接触点离质心远 => 力臂大 => 横摆角速度与竖直反冲双重超调。
  // 求解器已做粘性软接触，但仍需一层的**后置硬截断**兜底（防止极端车对出现暴烈弹飞）。
  COLLISION_YAW_CAP: 8.0,   // 碰撞后 |ωy| 硬上限 (rad/s)，超过即截断
  COLLISION_VY_SOFT: 1.5,   // 竖直速度软阈值 (m/s)：超过即压回
  COLLISION_VY_REST: 0.2,   // 超过阈值后重置到的竖直速度 (m/s)

  // ---------------- Baumgarte 速度通道：**已彻底移除**（规格 §1 病根）----------------
  // 旧常量 BAUMGARTE_BETA / BAUMGARTE_BIAS_V 已删除。它们曾经表达的是
  //   biasVel = min((β/dt)·pen, 2.5)   ->  写进 Δv
  // 的"速度型穿透补偿"。物理上这是**凭空注入动能**：β=0.2、dt=1/60、pen=0.5m 时
  // biasVel 直接顶到 2.5 m/s 上限，对 1380kg 车 = 4312 J，且法线带 +Y 分量时
  // 就是"把车抬起来"的直接来源。位置修复现在**只**走 projectPenetration()。
  //
  // ⚠ 真正的元凶不在本文件，而在 vendored 的 cannon-es：
  //   ContactEquation.computeB() 里 `B = -g*a - GW*b - h*GiMf` 的 `-g*a` 项，
  //   g 就是穿透深度、a = 4/(h(1+4d))。本文件底部 installCannonBaumgarteKill()
  //   会在原型层面把这一项对"涉及车的接触"清零 —— 否则我们在 JS 侧做的一切
  //   位置修复都会被 cannon 上游的同一步能量注入抵消。

  // ---------------- ForzaTech Clock Slewing（规格 §一.2）----------------
  MAX_TIME_WARP: 0.015,     // 物理步长最大微调比例 ±1.5%（禁止硬跳时间戳）

  // ---------------- 护栏 / 桥栏 / 桥墩（静态刚体）----------------
  // 规格：护栏接触 restitution 0.0、friction 0.45；车贴护栏只产生火花与滑动阻尼，
  // 绝不穿透飞出地图。
  BARRIER_RESTITUTION: 0.0,
  // ★ 方案 A（2026-09-30 用户选定）：护栏按**接触角分档**处理，不再用高摩擦"吃"切向动量。
  //   旧值 0.8 的后果：cannon 的摩擦求解器在接触点上吃掉几乎全部切向速度，并且因为摩擦
  //   冲量作用在**接触点**（离质心很远）而产生自转 —— 表现就是"剐一下就被拽停、还被拉着转"。
  //   现在 cannon 只保留很小的一点摩擦（0.15），切向动量的处置全部交给下面的导流层，
  //   按接触角一次性扣减（浅角 6~12%、深角 18~45%），持续刮擦几乎不掉速。
  BARRIER_FRICTION: 0.15,
  // 规格 §任务2：护栏接触 relaxation 收紧到 3.0（默认 16 的穿透惩罚太软，
  // 深穿透时会蓄出巨大的 Baumgarte 反冲速度 -> 撞墙被弹飞）。
  // 注意：只用在车↔护栏这一组，**不动**车↔车（那边另有软接触吸收层，改它会连锁回归）。
  BARRIER_RELAXATION: 3.0,
  BARRIER_HEIGHT: 1.4,      // 护栏物理高度 (m)（规格值）

  // ---------------- 护栏接触**导流偏转**（规格 §一，消灭吸墙卡死）----------------
  // 目标：浅角刮擦时把车头顺畅"别"向护栏切线前方，形成紧贴护栏高速擦撞滑行，
  // 严禁直接撞停、弹回或整车垂直被墙面吸住拔不出来。
  //
  // 角度分界：入射角 theta = velocity 与 tangent 的夹角。
  //   theta <  DEFLECT_SHALLOW_DEG(45°) -> 浅角：沿切线投影重构速度 + 正向偏摆力矩
  //   theta >= DEFLECT_SHALLOW_DEG       -> 深角：吃掉 85% 法向冲量 + 反扭矩甩尾
  DEFLECT_SHALLOW_DEG: 45,
  // 浅角时切向速度的保留率：v_t_new = v_t * (1 - fric*dt)（规格 §一.1）。
  // 用 dt 相乘而非固定折扣，保证与步长解耦；实测 1/60 步长下每帧掉约 1.3%。
  DEFLECT_TANGENT_FRICTION: 0.8,
  // 偏摆力矩：角加速度 = 车速 * 增益 / 轴距，再按 maxSteer 归一。
  // 手感标定：40m/s(144km/h) 贴墙时约 0.9 rad/s² -> 0.15s 内可把车头摆正 ~0.07rad，
  // 不足以瞬移车头，但足以"顺着护栏滑出去"，符合"顺畅别向切线前方"的规格描述。
  DEFLECT_YAW_GAIN: 0.055,
  // 偏摆角速度硬上限（rad/s）：防止高速贴墙时车头被甩到失控自旋
  DEFLECT_YAW_CAP: 1.6,
  // 深角撞墙：法向冲量被吸收的比例（规格 §一.1：吸收 85%）
  DEFLECT_DEEP_ABSORB: 0.85,
  // 深角反扭矩：让车尾甩动、杜绝整车被墙面吸住。按接近速度与力臂缩放。
  DEFLECT_DEEP_TORQUE: 0.16,
  // 防吸入几何投影的额外外推量（规格 §一.2：pen + 0.03m）
  ANTI_SUCTION_EPS: 0.03,

  // ---------------- 规格 §四：FM8 级护栏接触导向 + 偏摆力矩 + 几何防吸入 ----------------
  // 规格原文给出的 FM8 精确公式（与上面的 DEFLECT_* 通用导流层**叠加**）：
  //   · 切向保留率 90%（restitution = 0）
  //   · theta<60° 施加偏摆冲量 yawImpulse = sign(forward×tangent).y·min(theta,0.8)·|v|·m·0.15
  //   · 几何防吸入：pen>0.005m 时沿法线向内平移 (pen + 0.03m)
  GUIDANCE_TANGENT_KEEP: 0.9,        // 规格：保留 90% 切向速度（**首次接触一次性**施加）
  // ★ 持续接触期的切向摩擦率（1/s）。规格的 "90% 切向保留" 是**每次接触事件**的量，
  //   若每物理子步都 ×0.9，60Hz 下 0.9^120 ≈ 3e-6 ⇒ 贴墙 2 秒切向速度归零（"贴墙即死"）。
  //   故持续接触改用与 dt 解耦的温和摩擦 0.35/s（远弱于 0.9/帧），既保留"切向占主导"
  //   的规格意图，又不会瞬间吃掉动量。实测 verify_sec3 的"脱离过程车速"判据靠它保住。
  GUIDANCE_TANGENT_FRICTION: 0.35,
  GUIDANCE_THETA_MAX: 60 * Math.PI / 180, // 规格：theta<60° 才施加偏摆力矩 (rad)
  GUIDANCE_THETA_CAP: 0.8,           // 规格：min(theta, 0.8)（rad，约 45.8°）
  GUIDANCE_YAW_GAIN: 0.15,           // 规格：yawImpulse = ... · m · 0.15
  GUIDANCE_OUT_EPS: 0.03,            // 规格：几何外推 pen + 0.03m
  GUIDANCE_MIN_SPEED: 0.35,          // m/s：低于此速度只做几何外推，不导流动量

  // ---------------- 规格 §三.1：**根治低速吸墙** ----------------
  // 现象：车速很低（<40km/h）或几乎与护栏平行时，车头"贴"在墙上不动 ——
  // 玩家给油只能原地蹭，方向打死也拔不出来。根因是低速时：
  //   · 接触法向力 / 摩擦锥仍按"静止接触"满负荷求解 -> 切向动量被判为摩擦耗散，
  //     restitution 的微小正值也会把车"粘"回墙面；
  //   · cannon 的接触只有一次求解，没有"主动把车推离墙面"的通道。
  // 处置（三条正交手段）：
  //   ① 低速/小夹角 -> 恢复系数强制为 0（彻底消除粘性回弹）；
  //   ② 每步沿法向额外外推 `ANTI_SUCTION_LOW_PUSH_M`（主动脱离，与穿透深度无关）；
  //   ③ 切向动量导流保留 92%（`DEFLECT_TANGENT_KEEP`），配合切线角加速度把车"别"出来。
  ANTI_SUCTION_KMH: 40,          // 认定"低速"的车速阈值 (km/h)
  ANTI_SUCTION_ANGLE_DEG: 40,    // 认定"小夹角"的入射角阈值 (°)（与 45° 分界独立，更早介入）
  ANTI_SUCTION_LOW_PUSH_M: 0.02, // 低速防吸入的每步法向外推量 (m)（规格：pen+0.02m 的 0.02）
  // 浅角切向**保留率**（规格 §三.1：切向动量导流保留 92%）。
  // 与 DEFLECT_TANGENT_FRICTION(0.8) 是两套口径：后者是"每秒摩擦衰减率"，
  // 这里是"低速脱离窗口内的硬保留率"——二者取大，保证低速刮墙不被摩擦吃掉。
  DEFLECT_TANGENT_KEEP: 0.92,
  // ---- 方案 A：护栏接触角分档（浅角剐蹭滑走 / 深角才算撞击）----
  WALL_SHALLOW_DEG: 25,          // 入射角 < 此值 = 浅角剐蹭（贴着墙滑）
  WALL_SCRAPE_LOSS_MIN: 0.06,    // 浅角首次接触的切向速度损失（角度最小侧）
  WALL_SCRAPE_LOSS_MAX: 0.12,    // 浅角首次接触的切向速度损失（接近 25° 侧）
  WALL_HIT_LOSS_MIN: 0.18,       // 深角首次接触的切向速度损失（刚过 25°）
  WALL_HIT_LOSS_MAX: 0.45,       // 深角首次接触的切向速度损失（≈90° 正面撞）
  WALL_SCRAPE_DRAG: 0.015,       // 持续剐蹭每秒衰减（≈1.5%/s：几乎不掉速，顺畅滑走）
  WALL_HIT_DRAG: 0.30,           // 持续顶墙每秒衰减
  WALL_CONTACT_GAP_T: 0.20,      // 接缝短暂丢接触时仍视作同一次擦墙
  WALL_PENALTY_COOLDOWN_T: 1.25, // FM8 模式连续贴墙不重复刷罚时
  WALL_PENALTY_MIN: 0.50,
  WALL_PENALTY_MAX: 1.50,
  WALL_STRAIGHTEN_MAX: 1.8,      // 车头回正横摆上限 (rad/s)：够快看得见，但仍不甩尾自转

  // ---------------- 规格 §三.2：弯道动态拥挤幽灵化（Congestion Zones）----------------
  // 三大赛道的**发卡弯 / 减速弯 / 连续小半径弯**（曲率半径 < CONGEST_R_M）被划为
  // 拥挤区。区内若出现"局部半径 CONGEST_RADIUS_M 内 > CONGEST_MIN_CARS 台车"且
  // 存在碰撞风险（TTC 预判），则区内**所有**车进入拥挤幽灵模式：车车不解算 +
  // 半透明；间距拉开到 CONGEST_RELEASE_M 以上后平滑恢复。
  //
  // 与"预测性前向幽灵化"（updatePredictiveGhosting）的区别：后者是**逐对**、
  // 高速直道追尾场景；本机制是**区域级**、低速弯道多车拥堵场景。两者可叠加，
  // 掩码按位与，互不覆盖（_refreshMasks 统一汇总）。
  CONGEST_R_M: 130,          // 【已废弃：改走分位判据，见 track.js】曲率半径阈值 (m)
  CONGEST_ZONE_SPAN_M: 60,   // 连续弯道合并成区的最小跨度 (m)（短于此不单独成区）
  CONGEST_RADIUS_M: 10,      // 拥挤判定半径 (m)（规格：局部 10m）
  CONGEST_MIN_CARS: 2,       // 局部半径内最少车数（>2 即 ≥3 台，规格："超过 2 辆"）
  // 区内碰撞风险 TTC 阈值 (s)。⚠ 标定说明：弯道内多车低速蠕动时，3 m/s 接近速度配
  // 5m 间距的 TTC 就是 1.67s —— 若取 0.6s 则真实"弯道堵车"永远达不到阈值（假阴性）。
  // 取 2.0s：既能在"即将贴上来"时提前幽灵化，又不会把 10m 内正常排队错判成拥堵。
  CONGEST_TTC: 2.0,
  CONGEST_RELEASE_M: 6,      // 间距拉开到该值以上解除拥挤幽灵 (m)（规格：>6m 平滑恢复）

  // ---------------- 碰撞分组（cannon-es collisionFilter）----------------
  // 幽灵模式把这些组合并规则当开关用：车掩码里剔掉 GROUP_CAR -> 车车不接触。
  // ---------------- 碰撞分组（cannon-es collisionFilter）----------------
  GROUP_CAR_BASE: 3,   // 车辆碰撞组从该位起，每车一位（车 1~12 -> 位 3..14）
  GROUP_CAR_MASK: 0x7FF8, // 12 车总位域（位 3..14），全员幽灵时从掩码里整体剔掉
  GROUP_BARRIER: 4,    // 护栏组（与车组位互不重叠，幽灵/预测隔离都不影响拦车）

  // ---------------- 预测性前向幽灵化（Predictive Ghosting，规格 §二.2）----------------
  PRED_GHOST_MS: 22.2, // 法向接近速度阈值 (m/s)（规格：80 km/h）
  PRED_GHOST_TTC: 0.15, // 预计接触时间阈值 (s)
  PRED_GHOST_SEP: 3.5, // 解除距离（预测对的历史阈值，保留作诊断）
  PRED_GHOST_CLEARANCE_M: 4.8, // 车体包络完全脱离后才恢复实体碰撞
  PRED_GHOST_REJOIN_V: 3, // 解除时的法向接近速度上限 (m/s)

  // ---------------- 赛道外（草地/沙地） ----------------
  // ★ 2026-09-30 按 FM8 手感重调（用户报障："压到赛道外的处理不好，不符合物理，
  //   而且撞停后想回到赛道很困难，仿照 fm8 的设计处理"）。
  //
  //   FM8 的赛道外是什么样：
  //     · 抓地**两个方向都掉**（纵向打滑、横向滑出去/推头），而不是只有纵向掉；
  //     · **没有限速陷阱**：能带着速度横穿草地，只是慢、只是滑 —— 代价是时间，不是撞墙；
  //     · **随时能开回来**：不需要复位，低速下打方向就能把车头调回赛道。
  //
  //   旧实现在这两点上都不合物理：
  //     ① 出界侧向抓地下限被抬到 **1.55μ**（比路面还高）⇒ 草地上像在轨道上，一点不滑；
  //     ② 60km/h 软上限 + 0.42 阻力 ⇒ 超过就开始约 1g 的减速，压草像撞墙；
  //     ③ 滚阻 0.18 偏高 ⇒ 低速脱困吃力（用户"撞停后很难回到赛道"）。
  OFFROAD_MIN_WHEELS: 3,    // 超过 2 个车轮脱离沥青即进入低抓地状态（规格："超过 2 个"）
  // 底盘线性阻尼在**两端都恒为 0**：本底盘的路面/沙地阻力已由
  // 显式气动 F=0.5ρCdAv² + 滚阻（含 ROLL_SAND_K·出界轮数）完整建模，
  // 再叠一层 cannon 全局阻尼等于重复计阻力。
  // 上一版沙地叠了 0.16，实测把沙地全油门速度压到 0.8km/h（车陷死出不来）。
  OFFROAD_DAMP_ROAD: 0.0,
  OFFROAD_DAMP_SAND: 0.0,
  // 规格：**废除**任何脚本式的"出界即刹 / 强行限速"。出界只靠纯物理阻滞动能：
  //   ① 抓地骤降：纵横抓地系数一起掉到 0.62 左右（猛给油只会空转、猛打方向就滑）
  //   ② 滚阻随**出界轮数**自然爬升（ROLL_SAND_K），保留动量向前滑行、平滑衰减
  // 原来那两个脚本常量 OFFROAD_VMAX_KMH（硬钳速）与 OFFROAD_THRUST_CUT（硬削力）已删除。
  OFFROAD_FRICTION_SLIP: 0.62, // 出界纵向抓地系数（驱动力上限）
  // ⚠️ 侧向抓地**不能**再抬到比路面还高（旧值 1.55μ）——那会让草地上的车"像在轨道上"，
  //    与 FM8 完全相反。现在侧向同样掉到 0.62μ：会推头、会甩尾，但低速打方向仍能把
  //    车头调回赛道（0.62μ 在 40~60km/h 下足够产生转向所需的横向力）。
  OFFROAD_LAT_GRIP_MIN: 0.62,   // 出界侧向抓地（与纵向同一个量级）
  // 出界侧向抓地相对 MU_SLIP_FLOOR 的倍数：0.62 / 0.45 ≈ 1.38。
  // 必须用倍数而非独立绝对值，否则 MU_SLIP_FLOOR 会被旁路（见 driveLocal 的说明）。
  OFFROAD_LAT_GRIP_K: 1.38,
  // 规格 §四.1：出界后保留 80% 发动机推力（不是硬削到 0），配合滚阻形成"慢但开得动"。
  OFFROAD_TORQUE_KEEP: 0.8,
  // 出界软上限提到 90km/h（旧 60km/h 太低，压草像撞墙）：
  // 用**渐进式空气阻力**实现（不是硬钳速），车速越接近上限附加阻力越大，自然收敛。
  OFFROAD_SOFT_VMAX: 25.0,
  OFFROAD_DRAG_K: 0.20,         // 渐进阻力系数（在软上限处产生约 0.5g 的等效减速）
  // 出界滚阻增量：F_roll = (ROLL_K + ROLL_SAND_K·k)·正压力。
  // 从 0.18 降到 0.10：让"撞停后重新起步回赛道"有净推力（旧值下净推力仅约 1.6kN，
  // 约 0.12g，起步很吃力 —— 用户报"撞停后想回到赛道很困难"）。
  ROLL_SAND_K: 0.10,
  // 规格：动摩擦下限。mu 再怎么崩塌（手刹抱死后轴 0.45 / 出界 / 打转载荷转移），
  // 侧向滑动摩擦也不得低于该值，否则车会在草地上像在零摩擦冰面上无限平移。
  MU_SLIP_FLOOR: 0.45,
  OFFROAD_RECOVER_T: 1.0,   // 重新全轮回到沥青后，1.0 秒内平滑恢复（规格值）

  // ---------------- 救援复位（R 键）----------------
  // ★ #9 自动幽灵（用户要求：横在赛道上不要挡人；被连续撞击也要自动幽灵）
  AUTO_GHOST_SIDEWAYS_T: 2.5,   // 横在赛道上时幽灵时长 (s)
  AUTO_GHOST_HIT_T: 2.0,        // 连续被撞触发的幽灵时长 (s)
  AUTO_GHOST_HIT_WINDOW: 4.0,   // 连续被撞的统计窗口 (s)
  // ★ #10 复位罚时：前 N 次免费（复位本身已经用掉了救车时间），之后才象征性加罚
  RESCUE_FREE_COUNT: 3,
  RESCUE_PENALTY_AFTER: 2.0,
  RESCUE_PENALTY: 0.0,       // 单次复位的基础罚时（0 = 不额外罚；见 RESCUE_FREE_COUNT）
  RESCUE_HEIGHT: 0.4,       // 瞬移到 Checkpoint 中心上方 0.4m（规格值）
  // R 键复位锚点：false = 上一个合法通过的 Checkpoint（默认）；
  // true = 赛道起点（起终点线）。见 rescueToCheckpoint 的说明。
  // 规格 §四.2：R 键**绝对复位至起点网格**（第 0 号发车点 / 起终点线正上方 0.4m），
  // 本圈计时作废 + 3.0s 罚时。改回"就近复位到上一个 Checkpoint"只需把这里改 false。
  // 规格 §一.2：R 键优先回**驶出锚点**（四轮都在沥青上的最后一帧位姿），就近脱困；
  // 没有锚点（从未上过赛道）时才退到起点 / 上一个 Checkpoint 的旧逻辑。
  RESCUE_TO_DEPART: true,
  RESCUE_DEPART_LIFT: 0.3,   // 驶出锚点复位时的抬高量 (m)（规格值）
  // 规格 §二.2：复位时继承初速度，避免"复位后原地熄火"。
  //   v_new = clamp(v_exit * INHERIT_RATIO, MIN, MAX)
  // 取 0.6 —— 保留大部分动量（开得越快、回来后越快），但有明显损失以体现"罚"。
  RESCUE_INHERIT_RATIO: 0.6,
  RESCUE_SPEED_MIN: 8.0,     // 下限 8 m/s ≈ 29km/h：无论冲出去时多慢都有前进动力
  RESCUE_SPEED_MAX: 28.0,    // 上限 28 m/s ≈ 101km/h：复位不该变成"免费弹射"
  RESCUE_TO_START: false,
  // 幽灵化保护：复位后 3.5s 内关闭碰撞响应 + 车身半透明，
  // 避免"刚回到赛道就被撞"以及别车卡位（规格值）
  GHOST_TIME: 3.5,
  GHOST_OPACITY: 0.35,
  // 全员幽灵车模式：远端车半透明 0.65（规格值），保留 depthWrite 防渲染撕裂
  GHOST_MODE_OPACITY: 0.65,
  GHOST_FADE_T: 0.35,       // 幽灵结束时透明度/碰撞的平滑恢复时间
  WRONG_WAY_GHOST_DELAY: 0.5, // 逆行持续多久才进入幽灵，避免瞬时调头误触发
  LAPPED_GHOST_TIME: 3.5,   // 被套圈期间按真实周回进度持续续期

  // ---------------- 碰撞力矩（Off-Center Impact / PIT 美式截停）----------------
  IMPACT_TORQUE_GAIN: 1.0,   // 一般偏心碰撞的力矩增益
  PIT_TORQUE_GAIN: 1.5,      // 车头撞对方车尾侧翼（PIT）时的增益（规格值）
  PIT_MIN_CLOSING: 1.5,      // 触发 PIT 判定的最低接近速度 (m/s)
  YAW_IMPULSE_CAP: 1.2,      // 单个物理步内由碰撞注入的横摆角速度上限 (rad/s)

  // ---------------- 临界阻尼悬挂（对策：物理抖动抽搐）----------------
  // 规格给的 4 个参数是 cannon RaycastVehicle 的归一化口径。本项目底盘是 Box 刚体 +
  // 解析路面约束（没有 RaycastVehicle），因此按等效物理意义映射为 SI 弹簧-阻尼：
  //   k = m·g / (MAX_TRAVEL × 0.20)     —— 静态下沉取最大冲程的 20%（0.06m）
  //   c = 2·ζ·√(k·m)
  // ζ 的取值：规格数字 4.5 / (2√30) ≈ 0.41（欠阻尼，压缩后会回弹一次）；
  // 但规格**文字**明确要求"压缩后单次归位、杜绝高频上下震颤"，故取 ζ = 1.0 临界阻尼。
  // 文字要求优先于数字。
  SUSP_STIFFNESS: 30.0,     // 归一化弹簧刚度（保留以便与规格对照）
  SUSP_DAMPING: 4.5,        // 归一化阻尼（保留以便与规格对照）
  SUSP_COMPRESSION: 2.5,    // 压缩行程系数 -> 缓冲块（bump stop）刚度倍数
  SUSP_MAX_TRAVEL: 0.30,    // 最大悬挂冲程 (m)，防止车轮陷入地面或飞天
  SUSP_ZETA: 1.0,           // 阻尼比：1.0 = 临界阻尼（单次归位无过冲）
  SUSP_SAG_RATIO: 0.20,     // 静态下沉占最大冲程的比例
  SUSP_DROOP: 0.10,         // 最大下探量 (m)，超出即视为离地

  // ---------------- 轮胎抓地（按轴分配，前后配比不同）----------------
  GRIP_ROAD: 2.4,         // 沥青基准
  GRIP_FRONT_NORMAL: 2.6, // 前轮常规 frictionSlip（规格值）
  GRIP_REAR_NORMAL: 2.4,  // 后轮常规 frictionSlip（规格值）
  GRIP_CURB: 1.30,        // 红白减速带
  GRIP_GRASS: 0.42,       // 草地
  // 硬胎热窗：冷胎先少量损失抓地，约 85°C 达到峰值，过热后逐步衰减。
  // 这是本地可解释的近似模型，不宣称是 FM8 内部标定值。
  TIRE_AMBIENT_C: 25,
  TIRE_START_C: 62,
  TIRE_OPT_C: 85,
  TIRE_HOT_C: 112,
  TIRE_MAX_C: 155,
  TIRE_HEAT_RATE: 0.95,       // 稳定高负荷约 1°C/s
  TIRE_COOL_RATE: 0.022,      // 松开负荷后向环境温度恢复
  TIRE_COLD_GRIP: 0.76,
  TIRE_HOT_GRIP: 0.72,
  GRIP_FRONT_HANDBRAKE: 3.2, // 手刹：前轮死死咬住沥青（规格值）——严禁前轮抱死
  GRIP_REAR_HANDBRAKE: 0.45, // 手刹：后轴完全失去侧向抗滑（规格值）
  BASE_MU_AIR: 0.35,      // 四轮离地残余抓地
  LOAD_TRANSFER_GAIN: 1.0,// 载荷转移增益（1.0 = 完全按 h/L 几何关系）

  // ---------------- VitaVehicle 风格滑移率抓地曲线（2026-10-11 引入）----------------
  // 真实轮胎抓地随滑移先升后降（Pacejka 峰值形态），旧"硬钳位"是一条不连续的阶跃：
  // 容量以内全额消除侧向速度、超容量全额保留。曲线化之后入弯"咬住"、漂移"滑而不甩崖"。
  // 参考实现：VitaVehicle（Jreo, g-rcp 系列）的 slip 控抓地思路；公式为本项目自研近似。
  SLIP_PEAK_DEG: 8,        // 峰值抓地对应的侧偏角（度）
  SLIP_PEAK_GAIN: 0.92,    // 0° 侧偏时的抓地保留比例（直线行驶基线，留 8% 给峰值增益）
  SLIP_FALLOFF_KEEP: 0.74, // 大滑移侧的抓地收敛下限（漂移中保留 74% 容量，救得回来）
  // 摩擦椭圆耦合强度：纵向用力占额定容量的份额，按 sqrt(1-µ·share²) 折算侧向剩余容量
  // —— 重刹进弯转向变钝、油门过开出弯推头，都由这一条推出。
  FRICTION_ELLIPSE: 0.55,

  // ---------------- 手刹（后轮锁死 + 横摆角冲量）----------------
  HANDBRAKE_FORCE: 5000,     // 后轮制动力 (N)。规格写 brake=120 是 cannon 归一化单位，
                             // 按本项目 SI 口径等价于 ~5000N（1380kg 上约 3.6 m/s² 减速）
  HANDBRAKE_BITE_T: 0.05,    // 咬合时间 (s)
  HANDBRAKE_RELEASE_T: 0.20, // 释放后摩擦恢复时间 (s)，规格要求 0.2s 防 Snap Oversteer
  // 横摆角冲量：规格式子 mass×1.8 若直接当角加速度是 2484 rad/s²（比物理量级大 3 个数量级，
  // 会瞬间打转）。按可玩性标定为角加速度，配合 YAW_ACCEL 上限，约 0.25s 建立起 ~1.2rad/s 横摆。
  HANDBRAKE_YAW_ACCEL: 5.0,  // rad/s²
  HANDBRAKE_YAW_SIGN: -1,    // 与转向输入反号（steer>0 向右 -> 需要负向 yaw）

  // ---------------- 漂移判定（供烟雾/胎痕 FX 使用）----------------
  DRIFT_SLIP_DEG: 18,     // 侧偏角阈值
  DRIFT_MIN_KMH: 25,      // 手刹漂移的最低车速
  DRIFT_FADE_DEG: 12,     // FX 强度起算角（低于此不冒烟）

  // ---------------- 吸尾流 / 脏气流（Draft & Dirty Air，FM8 规格）----------------
  SLIP_CONE: 12,         // 尾流锥角 (deg)，前车后方 ±12°
  SLIP_MIN: 3,           // 最近有效距离 (m)
  SLIP_MAX: 25,          // 最远有效距离（纵向间距 < 25m，规格值）
  SLIP_MIN_KMH: 50,      // 前车最低车速
  SLIP_DRAG_CUT: 0.35,   // 正面风阻降低 35%（规格值）
  // 极速增益：与上面的 40% 风阻削减叠加，实测把平路极速从 265 抬到 ~280km/h（规格：+15~20）
  SLIP_GAIN: 0.065,
  SLIP_DOWNFORCE_CUT: 0.30, // 脏气流：下压力削减 30% -> 高速弯抓地明显变差
  DRAFT_FOV_KICK: 1.5,   // 进入尾流时 FOV 瞬时微收 (deg)
  TURBULENCE_HZ: 24,     // 镜头湍流频率（规格：24Hz）
  TURBULENCE_AMP: 0.012, // 镜头湍流振幅 (m)（规格：0.012）

  RAM_ANGLE: 40,         // 恶意撞击判定夹角 (deg)
  RAM_MIN_KMH: 40,       // 撞击者最低车速
  RAM_CLOSING_KMH: 12,   // 最低接近速度

  PEN_CUT: 0.5,          // 每个被跳过的 Checkpoint

  // ---------------- FRR 赛道裁决（Forza Race Regulations，规格 §四）----------------
  // 核心是**不再一刀切**：出界本身不罚，"出界并获利"才罚。
  // 之前是"每累计 0.5s 出界罚 0.5s"，跑宽冲出赛道（失控、掉速）也照罚，不合理。
  FRR_MIN_OFF_T: 0.45,   // 出界短于该时长视为蹭路肩，不裁决 (s)
  FRR_PACE_TAU: 3.0,     // 基准巡航速度的 EWMA 时间常数 (s)
  FRR_PACE_FLOOR: 25,    // 基准速度下限 (m/s)：防止发车低速期把正常提速误判成"获利"
  FRR_GAIN_THR: 0.55,    // 出界期间油门时间占比 ≥ 该值才算"全油门开火"
  FRR_GAIN_SPEED: 0.95,  // 出界期间均速 ≥ 基准×该值才算"没吃亏"
  FRR_BRAKE_SAFE: 0.12,  // 刹车时间占比 ≥ 该值直接判"无获利"
  FRR_PEN_MIN: 1.0,      // 获利阶梯罚时下限 (s)
  FRR_PEN_MAX: 3.0,      // 获利阶梯罚时上限 (s)
  // ★ 只有短于这个时长的出界才算"抄近道获利"（跑宽冲出去/滑出去救车只算事故，不罚）。
  //   没有这条时，长距离出界（用油门救车）也会被判罚 ⇒ 实测一局能攒到 +33s 罚时，
  //   并且每圈都被标脏（最佳圈速永远为空）。
  FRR_MAX_CUT_T: 2.5,
  PEN_RAM: 2.0,
  PEN_LAP_SHORTCUT: 2.0, // 未集齐 Checkpoint 就冲线
};

/** 气动阻力系数合成项：F = DRAG_K · v² */
export const DRAG_K = 0.5 * CFG.AIR_RHO * CFG.CD * CFG.FRONTAL_AREA;

/**
 * 悬挂 SI 参数（由规格的归一化参数换算而来，派生量集中在此便于单测）
 *   K  = m·g / (MAX_TRAVEL·SAG_RATIO)          弹簧刚度 N/m
 *   C  = 2·ζ·√(K·m)                            阻尼 N·s/m（ζ=1 即临界阻尼）
 *   BUMP_STOP = K · COMPRESSION                超出冲程后的缓冲块刚度
 * 实测：K≈225.6 kN/m、C≈35.3 kN·s/m、固有频率≈2.03Hz、静态下沉 0.06m（占冲程 20%）
 */
export const SUSP = {
  K: (CFG.MASS * 9.81) / (CFG.SUSP_MAX_TRAVEL * CFG.SUSP_SAG_RATIO),
  C: 0,
  BUMP_STOP: 0,
  MAX_TRAVEL: CFG.SUSP_MAX_TRAVEL,
  DROOP: CFG.SUSP_DROOP,
  FREQ_HZ: 0,
  SAG: 0,
};
SUSP.C = 2 * CFG.SUSP_ZETA * Math.sqrt(SUSP.K * CFG.MASS);
SUSP.BUMP_STOP = SUSP.K * CFG.SUSP_COMPRESSION;
SUSP.FREQ_HZ = Math.sqrt(SUSP.K / CFG.MASS) / (2 * Math.PI);
SUSP.SAG = (CFG.MASS * 9.81) / SUSP.K;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 复用向量：避免每个物理步产生垃圾对象（每步 x 每车都会用到）
const _fv = new CANNON.Vec3();
const ZERO_POINT = new CANNON.Vec3(0, 0, 0);

/* -------------------------------------------------------------------------- */
/*  Car                                                                        */
/* -------------------------------------------------------------------------- */

export class Car {
  constructor(rp, opts) {
    this.rp = rp;
    this.track = rp.track;
    this.id = opts.id;
    this.name = opts.name || ('车手' + opts.id);
    this.color = opts.color || '#e10600';
    this.isLocal = !!opts.isLocal;
    this.remote = !!opts.remote;
    this.auto = false;              // 完赛后的自动巡航 / AI 车手
    this.ai = !!opts.ai;

    const spawn = this.track.spawn(opts.startIndex, opts.lateral || 0);
    const body = new CANNON.Body({
      mass: this.remote ? 0 : CFG.MASS,
      type: this.remote ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC,
      shape: new CANNON.Box(new CANNON.Vec3(CFG.HALF.x, CFG.HALF.y, CFG.HALF.z)),
      position: new CANNON.Vec3(spawn.position.x, spawn.position.y, spawn.position.z),
      quaternion: new CANNON.Quaternion(spawn.quaternion.x, spawn.quaternion.y, spawn.quaternion.z, spawn.quaternion.w),
      material: rp.carMaterial,
      // 角阻尼 0.35：解锁绕 Y 轴的横摆旋转自由度。
      // （上一版是 0.0，但横摆由自定义控制器强管，等于变相"抹杀旋转"——
      //   撞车后 0.1s 就被纠回，表现为"撞了没反应"。现在配合扰动窗口一起放开。）
      linearDamping: 0.0,
      angularDamping: 0.35,
    });
    body.allowSleep = false;
    body.updateMassProperties();
    body.__carId = opts.id;                       // 供碰撞事件反查车辆
    // 碰撞分组：每车一个**独立位**（预测性幽灵按位隔离单个车对）。
    // 全员幽灵模式下把"车组总位域"从掩码里整体剔掉 -> 车与车完全不解算，
    // 但仍与护栏/桥栏/桥墩（GROUP_BARRIER，不与车位重叠）碰撞。
    this.groupBit = 1 << (CFG.GROUP_CAR_BASE + (opts.id - 1));
    body.collisionFilterGroup = this.groupBit;
    body.collisionFilterMask = rp.ghostMode ? ~CFG.GROUP_CAR_MASK : -1;
    // 监听偏心碰撞，产生绕 Y 轴的角冲量（PIT / 别车）
    body.addEventListener('collide', (e) => { rp.onCarCollide(this, e); });
    // 护栏 / 桥栏 / 桥墩（静态体，无 __carId）走独立入口：它们不做 PIT 力矩，
    // 但**必须**触发规格 §4 的悬挂解耦 —— 撞墙同样是"冲量压死弹簧"的最强工况。
    body.addEventListener('collide', (e) => { rp.onBarrierCollide(this, e); });
    // 绕 Y 轴的转动惯量（均匀长方体）I_yy = m/12·(w² + l²)
    // 碰撞力矩必须除以它才是角速度增量；除以 mass 是量纲错误（会偏弱 ~1.6 倍）。
    this.inertiaY = CFG.MASS / 12 * (Math.pow(CFG.HALF.x * 2, 2) + Math.pow(CFG.HALF.z * 2, 2));
    this.body = body;
    rp.world.addBody(body);

    // 三.js 侧的数学镜像，避免每帧从 Cannon 反复取
    this.pos = new THREE.Vector3(spawn.position.x, spawn.position.y, spawn.position.z);
    this.quat = spawn.quaternion.clone();
    this.fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    this.lateralDir = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);  // 局部 +X（车身左侧轴）
    this.rightSide = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.quat);  // 车身真正右侧
    this.up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.vel = new THREE.Vector3();

    // 输入
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    // 转向状态：steerInput 是带"攻击/回正"双速率的状态量（-1..1，>0 表示向右）
    this.steerInput = 0;
    this.steerAngle = 0;        // 实际前轮转角 (rad)，>0 = 指向左侧
    this.maxSteerNow = CFG.STEER_MAX_LOW;
    this.handbrake = 0;         // 手刹咬合程度 0..1（带释放缓释）

    // 路面状态
    this.trackIdx = opts.startIndex;
    this.lateral = opts.lateral || 0;
    this.gridLateral = opts.lateral || 0;   // 发车横向位置：起步让线的目标车道
    this.odo = 0;                           // 起跑后累计里程 (m)，用于让线淡出
    this.onAsphalt = 4;
    this.surface = 0;          // 0 沥青 1 路肩 2 草地
    this.airborne = false;
    this.slip = 0;             // 尾流强度 0..1
    this.slipFrom = 0;         // 尾流来源车号
    this.speed = 0;            // 水平速度 m/s
    this.speedKmh = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;     // 沿车身左轴的横向速度（符号无意义，数值用于抓地/漂移）
    this.muSurface = CFG.GRIP_ROAD;
    this.muEffective = 0;
    this.tireTemp = [CFG.TIRE_START_C, CFG.TIRE_START_C, CFG.TIRE_START_C, CFG.TIRE_START_C];
    this.tireGrip = 1;
    this.tireSlipHeat = 0;
    this.slipRatio = 0;        // 横向滑移强度 0..1（胎响用）
    this.slipAngleDeg = 0;     // 侧偏角：车头朝向与实际速度方向的夹角（绝对值）
    this.driftIntensity = 0;   // 漂移强度 0..1（供烟雾/胎痕 FX 使用）
    this.drifting = false;     // 是否处于漂移状态

    // 动力总成状态（6 档自动变速）
    this.gear = 0;             // 当前档位索引 0..5
    this.rpm = CFG.IDLE_RPM;
    this.shiftTimer = 0;

    // 载荷转移 / 气动状态（每步由 axleState 与下压力解算刷新）
    this.FzFront = 0; this.FzRear = 0;     // 两轴正压力 (N)
    this.muFront = 0; this.muRear = 0;     // 两轴摩擦系数
    this.aLatFront = 0; this.aLatRear = 0; // 两轴饱和对应的整车侧向加速度
    this.aLatCap = 0;                      // 整车横向极限 m/s²
    this.downforce = 0;                    // 当前下压力 (N)
    this.prevForwardSpeed = 0;
    this.axMeasured = 0;
    this.ayPrev = 0;

    // 悬挂状态（临界阻尼弹簧-阻尼，取代"位置瞬移"贴地 —— 抖动修复核心）
    this.suspCompression = 0;   // 相对静态位置的压缩量 (m)，正=压缩
    this.suspVel = 0;           // 悬挂压缩速度 (m/s)
    this.grounded = true;

    // 子步插值：渲染时在上一固定步与本步之间插值，消除高刷屏下的视觉撕裂
    this.prevPos = this.pos.clone();
    this.prevQuat = this.quat.clone();

    // 碰撞扰动（Off-Center Impact / PIT）
    this.yawDisturb = 0;        // >0 表示处于"被撞失控"窗口，横摆修正权限被压低
    this.impactTorque = 0;      // 上一步被注入的横摆力矩（调试/断言用）
    this.pitHits = 0;           // 被 PIT 次数
    this.collideHits = 0;       // 碰撞事件计数
    this.lastCollideStep = -1;

    // 规格 §4 悬挂解耦：外壳碰擦期间冻结行程上限，防"压死弹簧 -> 爆发回弹"
    this.suspLockT = 0;         // 解耦窗口剩余时长 (s)
    this.suspLimit = undefined; // 当前行程上限，首帧由 groundConstraint 初始化

    // 赛道外沙地陷阱 / 救援冻结
    this.offRoad = 0;                              // 0..1 平滑系数
    this.offRoadMu = CFG.GRIP_ROAD;
    this.ghostTimer = 0;                           // 幽灵化剩余时间 (s)
    this.ghostFade = 0;                            // 幽灵结束后的平滑恢复计时
    this.ghost = 0;                                // 0..1 幽灵强度（main.js 用来调透明度）
    this.ghostReasonCode = 0;                      // 1套圈 2逆行 3失控回正 4复位保护 5完赛
    this._ghostReason = 0;                         // 当前计时幽灵的来源（内部状态）
    this.rescueGhost = false;                      // 规格 §二.3：救援幽灵期掩码隔离标记
    this.zoneGhost = 0;                            // 规格 §三.2：弯道拥挤幽灵标记（0/1）
    this.slideOnBarrier = false;                   // 规格 §一：本步是否在贴护栏滑行（供特效）
    this.rescueCount = 0;
    this.finishDist = 0;                           // 完赛后累计巡航距离（m）

    // FRR 出界裁决状态（规格 §四）
    // 行驶途中按过 R（驶出锚点复位）-> 本圈成绩作废（规格 §一.2）
    this.lapInvalid = false;
    // 驶出锚点缓存：四轮都在沥青上的最后一帧位姿（规格 §一.1）
    this.lastLegalAnchor = null;
    this.offActive = false;      // 是否正处于"四轮出界"状态段
    this.offEnterT = 0;          // 本次出界的进入时刻
    this.offDist = 0;            // 出界期间行驶距离 (m)
    this.offThrottleT = 0;       // 出界期间油门积分 (s)
    this.offBrakeT = 0;          // 出界期间刹车积分 (s)
    this.paceRef = CFG.FRR_PACE_FLOOR;   // 基准巡航速度 EWMA（判"是否获利"的标尺）
    this.violations = 0;         // 获利违规次数（计时塔"处罚"列显示）
    this.incidents = 0;          // 无获利的赛车事故次数（仅记录，不罚）

    // 比赛状态
    this.lap = 0;
    this.laps = opts.laps || 3;
    this.cpIdx = -1;
    this.progress = 0;
    this.progressScore = 0;                        // 真实周回进度：圈数 + 赛道弧长索引
    this.wrongWay = false;
    this.wrongWayT = 0;
    this.wrongWayGhost = false;
    this.lappedGhost = false;
    this.lappedBy = 0;
    this._progressTrackIdx = undefined;
    this.lapStart = 0;
    this.lapTime = 0;
    this.lapTimeLive = 0;
    this.bestLap = 0;
    // 干净最佳圈（不含出界/复位/切弯罚时的圈）—— 用于赛季记录与"房间最佳"上报；
    // HUD 的"最佳"永远显示 bestLap（脏圈只打 ⚠ 标记），见 updateProgress 的说明。
    this.bestCleanLap = 0;
    this.lastLap = 0;
    this.penalty = 0;
    this.offTime = 0;
    this.alert = null;         // {text, kind, t}
    this.finished = false;
    this.finishTime = 0;
    this.totalTime = 0;
    this.rank = 0;
    this.retired = false;
    this.cutBuffer = [];       // 被跳过的 Checkpoint 序号
    this.bumpCooldown = 0;
    this.ramCooldown = 0;
    this.resetCooldown = 0;
    this.contactCount = 0;

    // 网络代理目标（remote 专用）
    this.netTarget = null;
    this.netLastVel = new THREE.Vector3();
  }

  /** 更新 three.js 镜像向量 */
  syncFromBody() {
    const p = this.body.position, q = this.body.quaternion;
    this.pos.set(p.x, p.y, p.z);
    this.quat.set(q.x, q.y, q.z, q.w);
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.lateralDir.set(1, 0, 0).applyQuaternion(this.quat);    // 局部 +X = 车身左侧
    this.rightSide.set(-1, 0, 0).applyQuaternion(this.quat);    // 车身右侧
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.vel.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
    // HUD 用：底盘中心线速度模长（规格要求，严禁用车轮转速/加速度推算）
    this.speedMS = this.body.velocity.length();
    this.speedKmhMeasured = this.speedMS * 3.6;
    // 物理用：水平速度（尾流锥、AI 目标速度、计时判定等都基于水平面）
    const hv = Math.hypot(this.vel.x, this.vel.z);
    this.speed = hv;
    this.speedKmh = hv * 3.6;
    this.forwardSpeed = this.vel.dot(this.fwd);
    this.lateralSpeed = this.vel.dot(this.lateralDir);
  }

  /** 后轮接地点（side: -1 = 车右后轮, +1 = 车左后轮）——供烟雾/胎痕定位 */
  rearContactPoint(side, out) {
    const lx = side * CFG.WHEEL[3][0];      // WHEEL[2]/[3] 的 X 分量 ±0.86
    const lz = CFG.WHEEL[3][1];             // -1.35（车尾）
    out.copy(this.pos)
      .addScaledVector(this.lateralDir, lx)
      .addScaledVector(this.fwd, lz);
    out.y = this.pos.y - CFG.RIDE_H;        // 路面高度（车底平面）
    return out;
  }

  setAlert(text, kind, dur = 2.6) {
    this.alert = { text, kind, t: this.rp.time, dur };
    if (this.rp.onAlert && this.isLocal) this.rp.onAlert(this, text, kind, dur);
  }

  /**
   * 施加罚时（本地车会同步给服务端，见 main.js）。
   *
   * ★ 碰碰车模式关闭**碰撞类**罚时（wall / ram）：该模式的卖点就是刻意对撞。
   *   走线类罚时（切弯 / 抄近道 / 出界获利 / 复位）**照常保留** —— 否则该模式会变成
   *   免费的刷圈速通道，圈速与赛季成绩就不可信了。
   *   这里是全工程唯一罚时漏斗（7 处调用点全汇于此），因此只需在这一处设闸。
   */
  addPenalty(sec, reason) {
    if (this.rp && this.rp.gameMode === 'bumper' && (reason === 'wall' || reason === 'ram')) return;
    this.penalty += sec;
    if (sec > 0) this.lapInvalid = true;
    if (this.rp.onPenalty) this.rp.onPenalty(this, sec, reason);
  }

  /** 世界坐标 -> 车体局部 */
  toLocal(v, out) {
    out.copy(v).sub(this.pos);
    out.applyQuaternion(this.quat.clone().invert());
    return out;
  }

  /** 把车重新摆回赛道（脱困用） */
  respawn(onTrack = true) {
    const info = this.track.sample(this.pos.x, this.pos.z, this.trackIdx);
    const idx = onTrack ? info.i : info.i;
    const lat = onTrack ? clamp(info.lateral, -this.track.halfWidth * 0.6, this.track.halfWidth * 0.6) : info.lateral;
    const sp = this.track.spawn(idx, lat);
    this.body.position.set(sp.position.x, sp.position.y, sp.position.z);
    this.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.trackIdx = idx;
    // 复位时清空转向/手刹残留状态，避免复活瞬间带着满舵或锁死后轮
    this.steerInput = 0;
    this.steerAngle = 0;
    this.handbrake = 0;
    this.driftIntensity = 0;
    this.drifting = false;
    this.syncFromBody();
  }
}


/* --------------------------------------------------------------------------
 * 碰撞解算安全层（ForzaTech 式：方案 B / C 的纯函数部分）
 * ------------------------------------------------------------------------ */

/**
 * 规格 §2：速度阶跃塑性衰减模型（Velocity-Dependent Plastic Restitution）。
 *
 *   |v| <  V_THRESH :  e = E_PEAK · (1 − |v|/V_THRESH)   ← 线性，低速轻碰有质感
 *   |v| >= V_THRESH :  e = 0                              ← **严格零**（完全非弹性）
 *
 * 入参必须是**接触点沿法线的相对接近速度**（|v_rel|），不是整车速度。
 * 为什么阈值以上必须严格 0：汽车钣金是塑性吸能结构，真实碰撞 e ≈ 0.05~0.15，
 * 而 200km/h 尺度的撞击 e 实际已趋近 0。留任何正数都会产生 $e·v_rel$ 的回弹速度，
 * 在 55.6 m/s 下即便 e=0.02 也回弹 1.11 m/s = 851 J —— 肉眼可见的"弹一下"。
 *
 * 边界处理：NaN / 负入参 / 退化阈值一律返回 0（**保守取向**：宁可判为完全非弹性）。
 */
export function restitutionFor(speed) {
  const v = Math.abs(speed);
  if (!Number.isFinite(v)) return 0;
  const thresh = CFG.PLASTIC_V_THRESH;
  if (!(thresh > 0)) return 0;                 // 退化阈值：不敢算，直接全塑性
  if (v >= thresh) return 0;                   // 规格：阈值以上**严格 0**
  return CFG.PLASTIC_E_PEAK * (1 - v / thresh);
}

/**
 * 规格 §1：Anti-Ramp / Anti-Wedge 法线平整化。
 *
 * 护栏/护墙在几何上是垂直面。接触网格的**倒角**（为了视觉与法线平滑而做的
 * 小斜面）会让 cannon 报出一个带 +Y 分量的法线，此时法向冲量 J 就产生
 * 垂直分力 Δv_y = J·n_y/m —— 配合接触点的力臂力矩，车被"铲"向空中。
 *
 * 本函数把法线投到水平面并**重新归一化**。归一化这一步不可省：
 *   v_n = v_rel·n 与 Δv = J/m·n 都要求 ‖n‖=1，否则投影与冲量幅值被同比例缩小
 *   （表现成"撞墙发软"），且缩小比例随护栏倾斜度变化，无法用常数补偿。
 *
 * 【规格修订】旧版有一个 `|ny| < 0.02 就原样放行` 的门。该门已**废弃**：
 * 小误差 × 大冲量同样致命（J=4e4 时 Δv_y ≈ 0.58 m/s），规格要求**无条件**平整化。
 * 现在唯一的提前返回是"法线**纯垂直**（水平分量模长 ~0）"这一种退化情形 ——
 * 那说明这压根不是护栏而是地面/台阶，交给解析地面约束处理才正确。
 */
export function redirectNormal(nx, ny, nz) {
  const l = Math.hypot(nx, nz);
  if (l < CFG.NORMAL_FLAT_EPS) return null;    // 纯垂直：不是"墙"，交给地面约束
  return { x: nx / l, y: 0, z: nz / l };       // 无条件抹平 + 重归一化
}

/* --------------------------------------------------------------------------
 *  ★ 杀掉 cannon-es 内置的 Baumgarte 速度污染（规格 §1 病根的真正位置）
 * ------------------------------------------------------------------------ */

/**
 * 给 vendored 的 `CANNON.ContactEquation.prototype.computeB` 打补丁：
 * 对**涉及车辆的接触**，把 `-g*a`（穿透深度 × SPOOK 刚度）这一项清零。
 *
 * ── 为什么必须在这里动手 ────────────────────────────────────────────────
 * cannon-es 的接触方程（`cannon-es.js` 约 6035 行）是：
 *
 *     const g = n.dot(penetrationVec);              // g < 0 表示重叠，|g| = 穿透深度
 *     const B = -g * a - GW * b - h * GiMf;
 *
 * 其中 `a = 4/(h(1+4·relaxation))`（`setSpookParams`，约 5821 行）。GS 求解器
 * 会把 B 驱动到 0，也就是把 `-g*a` 变成一个**速度目标**并直接累加进
 * `body.velocity`。代入本工程参数 h=1/60、relaxation=16：
 *
 *     a = 4 / ((1/60)·(1+64)) = 240/65 ≈ 3.692
 *     pen = 0.30m  ->  -g·a = +0.30×3.692 ≈ **+1.108 m/s** 白送速度
 *     对 1380kg 车 ≈ 847 J；法线带 +Y 时就是"被铲飞"的垂直冲量。
 *
 * 这就是"穿透越深、车飞得越高"这条正反馈的**唯一数学来源**。本文件其它位置
 * （projectPenetration / absorbSoftContacts）都只能"事后补救"，因为 cannon
 * 在同一步的上游已经把这部分速度写进 velocity 了。
 *
 * ── 补丁做了什么、没做什么 ──────────────────────────────────────────────
 *   · 保留 `-GW*b`（速度约束，这是真正阻止互相穿透的项）与 `-h*GiMf`（外力）。
 *   · 只清零穿透偏置项。位置修复改由 `projectPenetration()` 独占负责 ——
 *     这正是规格 §3 叫 "Split Impulse" 的含义：**速度相与位置相彻底分离**。
 *   · 只对"至少一方是车"的接触生效；车对地面的接触本来也不走 cannon（走解析约束），
 *     这里的 `__carId` 判定覆盖车-车 与 车-护栏 两条路径。
 *
 * 幂等：以 **prototype 上的实际实现**为准判断（不是模块级布尔值）——
 *   这样即便有人把 `prototype.computeB` 换回原版，再次调用也能重新装上，
 *   测试也能在 ON/OFF 之间切换而不会卡在早返回。
 * 返回 true 表示补丁已就位（供启动自检断言）。
 */
export function installCannonBaumgarteKill() {
  const CE = CANNON.ContactEquation;
  if (!CE || !CE.prototype) return false;
  // ★ 幂等判据看"当前实现本身是不是补丁版"（函数名 + 标记），
  //   而不是看某个模块级布尔 —— 否则测试/热重载换回原版后就再也装不上了。
  const cur = CE.prototype.computeB;
  if (typeof cur === 'function' && cur.__isBaumgarteKill === true) return true;
  const original = cur;
  if (typeof original !== 'function') return false;

  const patched = function computeB_noBaumgarte(h) {
    const bi = this.bi, bj = this.bj;
    // 只处理"涉及车辆"的接触；其余（车-地面在 cannon 里不存在，纯静态-静态等）
    // 保持 cannon 原行为，避免影响任何非车辆路径。
    const touchesCar = (bi && bi.__carId !== undefined) || (bj && bj.__carId !== undefined);
    if (!touchesCar) return original.call(this, h);

    // 记录本次调用的穿透量（供遥测/断言），再按"零穿透"重算。
    // 做法：临时把两个刚体的位置沿法线方向补偿 g（等价于令 g=0），
    // 这样无需复制 cannon 的整段 B 公式就得到 `B = -GW*b - h*GiMf`。
    // 之所以不直接重写公式：cannon 各版本 B 的项与临时向量名可能不同，
    // 位置补偿在数值上等价（g 只通过 penetrationVec 影响 B）且更抗版本漂移。
    const n = this.ni;
    const pi = bi.position, pj = bj.position;
    // 当前 g（< 0 = 重叠）。用与 cannon 相同的算法重算一遍。
    const rx = pj.x + this.rj.x - pi.x - this.ri.x;
    const ry = pj.y + this.rj.y - pi.y - this.ri.y;
    const rz = pj.z + this.rj.z - pi.z - this.ri.z;
    const g = rx * n.x + ry * n.y + rz * n.z;
    if (!(g < 0)) return original.call(this, h);   // 无重叠：无需补偿，原样放行

    // 把 b 沿 +n 平移 |g|（b 在 n 的正侧），使重算出的 g' = 0。
    const d = -g;   // > 0
    pj.x += n.x * d; pj.y += n.y * d; pj.z += n.z * d;
    const B = original.call(this, h);
    pj.x -= n.x * d; pj.y -= n.y * d; pj.z -= n.z * d;   // **必须还原**位置

    this.__lastPenetration = -g;   // 遥测：本接触的穿透深度
    return B;
  };
  patched.__isBaumgarteKill = true;      // 幂等判据（看实现本身，不看模块布尔）
  CE.prototype.computeB = patched;
  CE.prototype.__baumgarteKilled = true;
  CE.prototype.__patched = patched;       // 便于测试/调试取回补丁版
  return true;
}

/**
 * ★★ 干掉 cannon `ArrayCollisionMatrix` 的 O(N²) 稠密矩阵。
 *
 * `World` 用**两个** `ArrayCollisionMatrix`（collisionMatrix / collisionMatrixPrevious）
 * 记录"上一步哪些刚体对在接触"，用途只有一个：`world.step` 里
 * `if (!collisionMatrixPrevious.get(bi,bj)) body.dispatchEvent(collideEvent)`
 * —— 即"只在**新发生**的碰撞上派发 collide 事件"（本工程的护栏解耦、车车顶撞
 * 都挂在这个事件上）。
 *
 * 问题是它的存储是**按刚体总数平方预分配的稠密数组**：
 *     setNumObjects(n) { this.matrix.length = n*(n-1)>>1 }
 *     reset()          { for (i=0; i!==this.matrix.length; i++) this.matrix[i]=0 }
 * 本工程静态护栏 2963 段 + 4 车 = 2967 刚体 ⇒ `matrix.length = 4,397,093`，
 * 而 `collisionMatrixTick()` **每个物理子步**都要把这两个 4.4M 元素数组清零一次。
 *
 * 真机实测（修好宽相之后，掉帧窗口内直接计时，见 tools/hotspot-diag.mjs）：
 *     matrixOwnKeys = 4,397,093     cm.reset() 单次 = 46.9ms
 *     world.collisionMatrixTick()  单次 = 52.4ms   ← 占单步物理 98ms 的 53%
 * 于是绿灯后跑到某个时刻（JIT 状态/元素种类一变）会**持续**从 8.3ms/帧掉到
 * 110ms/帧 —— 用户看到的"越跑越卡、车一顶一顶"。
 *
 * 关键事实：**实际会发生接触的对永远是"车 × (车|护栏)"**，数量是 O(车数×邻近护栏数)，
 * 只有几十个；4.4M 里 99.999% 的位置从生到死都是 0。所以换成稀疏 Map：
 *   · `reset()` = `Map.clear()`（O(存活条目)，不是 O(N²)）
 *   · `get/set` 只在实际接触对上记账，内存从 ~35MB 降到几 KB
 *   · 语义完全等价（get 返回真/假，原本是 1/0 —— `if (!get(...))` 用法不变）
 * 幂等判据看实现本身（与 installCannonBaumgarteKill 同一套约定）。
 */
export function installSparseCollisionMatrix() {
  const M = CANNON.ArrayCollisionMatrix;
  if (!M || !M.prototype) return false;
  if (M.prototype.__isSparseMatrix === true) return true;
  if (typeof M.prototype.reset !== 'function' || typeof M.prototype.get !== 'function') return false;

  // 键用 "小index-大index" 字符串：只有真正接触的对才会建键，每子步几十个，
  // 分配量可忽略；且不像位运算版本那样对刚体数上限有隐含假设。
  M.prototype.reset = function resetSparse() {
    if (this._m === undefined) this._m = new Map();
    else this._m.clear();
  };
  M.prototype.setNumObjects = function setNumObjectsSparse(_n) {
    // 稀疏实现不需要按刚体数预分配（这正是原实现爆内存 + 每步 O(N²) 清零的根源）
    if (this._m === undefined) this._m = new Map();
  };
  M.prototype.get = function getSparse(bi, bj) {
    const m = this._m;
    if (m === undefined || m.size === 0) return false;
    let i = bi.index, j = bj.index;
    if (j > i) { const t = i; i = j; j = t; }
    return m.has(i + '-' + j);
  };
  M.prototype.set = function setSparse(bi, bj, value) {
    if (this._m === undefined) this._m = new Map();
    let i = bi.index, j = bj.index;
    if (j > i) { const t = i; i = j; j = t; }
    const k = i + '-' + j;
    if (value) this._m.set(k, 1); else this._m.delete(k);
  };
  M.prototype.__isSparseMatrix = true;
  return true;
}

/**
 * ★★ 修掉 vendored cannon-es `Broadphase.makePairsUnique()` 的实现缺陷。
 *
 * 原实现（`public/libs/cannon-es.js` 约 4076 行）：
 *
 *     for (let i = 0; i !== N; i++) { t[key] = i; t.keys.push(key); }
 *     for (let i = 0; i !== t.keys.length; i++) {        // ← i 递增、length 递减
 *       const key = t.keys.pop();
 *       const pairIndex = t[key];
 *       pairs1.push(p1[pairIndex]);                      // ← 可能是 undefined
 *       delete t[key];
 *     }
 *
 * 三个后果：
 *   ① **只保留约一半的候选对**（两个游标相向而行，i 与 length 在中点相遇就退出）
 *      —— 静默丢碰撞，护栏/车车接触会随机漏掉。
 *   ② `t.keys` 是**模块级持久数组**，每轮残留一半没 pop 的键；下一轮开头再 push
 *      新键，游标很快就撞在一起 ⇒ 残留的旧键被 pop 出来时 `t[key]` 已被
 *      `delete` ⇒ `pairIndex === undefined` ⇒ `p1[undefined]` ⇒ **把 undefined
 *      塞进 pairs1** ⇒ 窄相 `Narrowphase.getContacts()` 读 `bi.material` 直接
 *      `TypeError`，异常从 `world.step` 冒出，**整帧中断**。
 *   ③ 同一对刚体出现两次（Grid 宽相下极常见：两个刚体共享 ≥2 个 bin）⇒
 *      `t[key]` 被覆盖 + `keys` 重复 push ⇒ 同样产出 undefined。
 *
 * 为什么以前没炸：`NaiveBroadphase.collisionPairs` **不调用**本函数，而它恰好是
 * 出厂版唯一的宽相 —— 于是这颗雷一直埋着，直到有人把宽相换成 Grid/SAP 才引爆。
 *
 * 补丁：用 Set 做一次真正的去重（保留全部唯一对，不再丢一半），并且**显式丢弃
 * 空槽**（`!a || !b` 直接跳过），让"上游给了脏数据"最多变成少一对，而不是崩整帧。
 * 幂等判据看实现本身（与 installCannonBaumgarteKill 同一套约定）。
 */
let _pairsSeen = null;
const _pairsOut1 = [];
const _pairsOut2 = [];

export function installMakePairsUniqueFix() {
  const B = CANNON.Broadphase;
  if (!B || !B.prototype) return false;
  const cur = B.prototype.makePairsUnique;
  if (typeof cur === 'function' && cur.__isPairsUniqueFix === true) return true;
  if (typeof cur !== 'function') return false;

  const patched = function makePairsUnique_fixed(pairs1, pairs2) {
    const N = pairs1.length;
    if (N === 0) { pairs2.length = 0; return; }
    if (_pairsSeen === null || _pairsSeen.size > 1 << 16) _pairsSeen = new Set();
    else _pairsSeen.clear();
    const seen = _pairsSeen;
    const o1 = _pairsOut1, o2 = _pairsOut2;
    let m = 0;
    for (let i = 0; i < N; i++) {
      const a = pairs1[i], b = pairs2[i];
      if (!a || !b) continue;                    // 空槽：丢弃，绝不让它流进窄相
      const key = a.id < b.id ? (a.id + ',' + b.id) : (b.id + ',' + a.id);
      if (seen.has(key)) continue;
      seen.add(key);
      o1[m] = a; o2[m] = b; m++;
    }
    pairs1.length = 0;
    pairs2.length = 0;
    for (let i = 0; i < m; i++) { pairs1.push(o1[i]); pairs2.push(o2[i]); }
    // 内存卫生：临时数组不长持刚体引用
    for (let i = m; i < o1.length; i++) { o1[i] = null; o2[i] = null; }
    o1.length = m; o2.length = m;
  };
  patched.__isPairsUniqueFix = true;
  B.prototype.makePairsUnique = patched;
  B.prototype.__pairsUniqueFixed = true;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  宽相（broadphase）装配 —— ★ 2026-09-29 帧率事故的唯一根因与修复             */
/* -------------------------------------------------------------------------- */
/*
 * ── 事故回放 ──────────────────────────────────────────────────────────────
 * 出厂 `forzalan.exe` 用的是 `world.broadphase = new CANNON.NaiveBroadphase()`，
 * 而赛道注册了 **2963 个静态护栏刚体**。Naive 是 O(n²)：每物理子步 ~440 万对
 * 检测，其中静态-静态对虽然被 needBroadphaseCollision 立刻否掉，但**函数调用
 * 本身**要跑。真机实测（Intel Iris Xe / Edge 无头 / 1600×900）：
 *
 *     帧间隔 p50 = 133.3ms（7.5fps）   主线程 JS 131.3ms/帧（占墙钟 98.5%）
 *     V8 采样 89.5% 落在 cannon-es collisionPairs（NaiveBroadphase 实现）
 *
 * 于是：倒计时还没跑完就已经在掉帧 → 起步瞬间"人机先走几步"、车"一顶一顶"、
 * HUD 秒差乱跳 —— 全部是**掉帧的下游症状**，不是网络或规则问题。
 *
 * ── 但"换成 Grid"这一步本身踩了第二颗雷 ──────────────────────────────────
 * cannon-es 的 GridBroadphase 在**构造函数里**就按 nx*ny*nz 一次性分配
 * `bins` / `binLengths`，之后改 nx/ny/nz 只改索引算术、**不扩容数组**：
 *
 *     const bp = new CANNON.GridBroadphase();   // bins.length = 10*10*10 = 1000
 *     bp.nx = 50; bp.ny = 3; bp.nz = 50;        // 索引算到 7499
 *
 * ⇒ 任何落在 idx ≥ 1000 的刚体都让 `binLengths[idx]++` 去读 undefined，
 *   抛 `Cannot set properties of undefined (setting 'NaN')`；异常从 world.step
 *   里冒出来，**把整帧打断**（物理 + 视觉同步 + 相机 + HUD + render 全跳过）。
 *   症状是"绿灯亮着但车一动不动、画面冻住"，比原来更糟。
 *
 * ── 修复 ──────────────────────────────────────────────────────────────────
 * ① nx/ny/nz **只走构造参数**；② 网格边界按**实测场景包围盒**切（±1000m 这种
 * 拍脑袋常量连铃鹿都装不下：实测 x∈[-1013, 887]、z∈[-696, 758]，越界的刚体
 * 会被夹到边缘 bin，把边缘 bin 塞爆）；③ 构造后立即断言 `bins.length` 与网格
 * 几何一致；④ installGridBroadphaseGuard() 再加一道运行期自愈，杜绝"以后又有
 * 人在构造后改 nx"复现同一颗雷。
 *
 * 真机 A/B（同一段赛道上逐相位实测，见 tools/broadphase-ab.mjs）：
 *     NaiveBroadphase          p50 116.6ms   8.7fps
 *     Grid 10×10×10（默认）     p50  16.9ms  51.3fps
 *     Grid 50×3×50（修好后）    p50   8.3ms 120.0fps   ← 一阶段修复
 *     SAPBroadphase            p50  58.3ms  17.5fps
 *
 * 一阶段修好之后，宽相里仍然有**约 30 万条"静态×静态"候选对**被枚举出来又被
 * needBroadphaseCollision 立刻否掉（静态护栏 2963 段两两配对）—— 实测占单核
 * CPU 的 ~28%，是修好之后最大的单项开销。候选对总数 ∝ 格边长的平方，所以二阶段
 * 直接把格子切细（tools/broadphase-ab.mjs 的格子尺寸 A/B，宽相单次耗时）：
 *     40m 格  4.02ms/次     30m 格  2.72ms/次
 *     20m 格  2.30ms/次  ←  采用       15m 格  1.79ms/次（bins 涨到 25k，收益递减）
 *     10m 格  1.79ms/次（bins 56k，纯浪费）
 * 20m 在铃鹿上约 14k 个 bin（≈0.7MB 空数组），每子步的清零循环仍然可忽略。
 * ⚠️ 格边长不是越大越好也不是越小越好：太小会让 bin 数量与"每步清零"线性成本反超。
 */
const GRID_CELL_XZ_M = 20;      // x/z 目标格边长（m）—— 见下方 A/B 实测
const GRID_CELL_Y_M = 25;       // y 目标格边长（m）
const GRID_PAD_M = 150;         // 车辆冲出赛道走廊的余量（m）
const GRID_MAX_BINS = 120000;   // 内存上限（每个 bin 是一个数组）

/** 场景包围盒（赛道可行驶区域 ∪ 静态碰撞体）＋车辆越界余量。 */
function worldBoundsFor(track, staticBodies) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  let y0 = Infinity, y1 = -Infinity;
  const mm = track && track.minimap;
  if (mm && isFinite(mm.minX)) {
    x0 = Math.min(x0, mm.minX); x1 = Math.max(x1, mm.maxX);
    z0 = Math.min(z0, mm.minZ); z1 = Math.max(z1, mm.maxZ);
  }
  for (const b of (staticBodies || [])) {
    // 静态体是 Box：位置 ± 半厚即可（aabb 此刻可能还没算过）
    const s = b.shapes && b.shapes[0];
    const hx = s && s.halfExtents ? s.halfExtents.x : 0;
    const hy = s && s.halfExtents ? s.halfExtents.y : 0;
    const hz = s && s.halfExtents ? s.halfExtents.z : 0;
    // 护栏盒是**绕 yaw 摆放的细长盒**（局部 z 轴 = 沿路切向）。取"两个半轴里较大的
    // 那个"作为保守上界：盒体绕 y 转任意角度时，它在世界 x/z 上的投影都不会超过它。
    // ⚠️ 不要用 ±1000m 之类的硬编码常量：真实铃鹿换成 OSM 数据后护栏包围盒是
    //    x[-1189,1075] z[-752,590]，比旧的 ±1000m 常量还大。
    const rr = Math.max(hx, hz);
    x0 = Math.min(x0, b.position.x - rr); x1 = Math.max(x1, b.position.x + rr);
    y0 = Math.min(y0, b.position.y - hy); y1 = Math.max(y1, b.position.y + hy);
    z0 = Math.min(z0, b.position.z - rr); z1 = Math.max(z1, b.position.z + rr);
  }
  // 测试桩 / 空赛道：退化为一个够用的方盒，绝不让包围盒是 Infinity
  if (!isFinite(x0)) { x0 = -600; x1 = 600; z0 = -600; z1 = 600; }
  if (!isFinite(y0)) { y0 = 0; y1 = 20; }
  const pad = GRID_PAD_M;
  // y 方向：赛道最低点往下、最高点往上各留余量（跳台/立交桥）
  return {
    x0: x0 - pad, x1: x1 + pad,
    y0: Math.min(y0, 0) - GRID_CELL_Y_M * 2, y1: y1 + GRID_CELL_Y_M * 4,
    z0: z0 - pad, z1: z1 + pad,
  };
}

/**
 * 运行期自愈：`bins`/`binLengths` 的长度与当前网格几何不符时按 nx*ny*nz 重分配。
 * 每物理子步只多一次整数比较，代价可忽略；换来的是"构造后改 nx"再也不致命。
 * 幂等判据看**当前实现本身**（与 installCannonBaumgarteKill 同一套约定）。
 */
export function installGridBroadphaseGuard() {
  const GB = CANNON.GridBroadphase;
  if (!GB || !GB.prototype) return false;
  const cur = GB.prototype.collisionPairs;
  if (typeof cur === 'function' && cur.__isBinRearmGuard === true) return true;
  const original = cur;
  if (typeof original !== 'function') return false;

  const patched = function collisionPairs_rearmBins(world, pairs1, pairs2) {
    const nb = this.nx * this.ny * this.nz;
    if (!this.bins || this.bins.length !== nb) {
      // bins 是每步都会被清零的纯暂存区，重分配不丢任何状态
      const bins = new Array(nb), lens = new Array(nb);
      for (let i = 0; i < nb; i++) { bins[i] = []; lens[i] = 0; }
      this.bins = bins;
      this.binLengths = lens;
      this.__binsRearmed = (this.__binsRearmed || 0) + 1;
    }
    return original.call(this, world, pairs1, pairs2);
  };
  patched.__isBinRearmGuard = true;
  GB.prototype.collisionPairs = patched;
  GB.prototype.__binsRearmGuard = true;
  return true;
}

/**
 * 按场景实际包围盒装配 GridBroadphase（**必须在静态赛道刚体注册之后调用**）。
 * 返回装配好的宽相实例（供自检断言）。
 */
export function makeGridBroadphase(world, track, staticBodies) {
  installGridBroadphaseGuard();
  const b = worldBoundsFor(track, staticBodies);
  let nx = Math.max(8, Math.round((b.x1 - b.x0) / GRID_CELL_XZ_M));
  let nz = Math.max(8, Math.round((b.z1 - b.z0) / GRID_CELL_XZ_M));
  let ny = Math.max(2, Math.round((b.y1 - b.y0) / GRID_CELL_Y_M));
  // 总 bin 数上限：超了就等比放宽格边长（宁可格子大一点，也不要几万个空数组）
  while (nx * ny * nz > GRID_MAX_BINS) { nx = Math.ceil(nx * 0.85); ny = Math.ceil(ny * 0.85); nz = Math.ceil(nz * 0.85); }

  const min = new CANNON.Vec3(b.x0, b.y0, b.z0);
  const max = new CANNON.Vec3(b.x1, b.y1, b.z1);
  // ★ nx/ny/nz 只能走构造参数 —— 构造后再改会让 bins 长度对不上（见上方事故回放）
  const bp = new CANNON.GridBroadphase(min, max, nx, ny, nz);
  const nb = nx * ny * nz;
  if (bp.bins.length !== nb) {
    // 不该发生：cannon 结构变了。留住证据，靠守卫自愈继续跑。
    console.error('[broadphase] GridBroadphase 网格与 bins 长度不一致：'
      + 'bins=' + bp.bins.length + ' nx*ny*nz=' + nb);
  }
  world.broadphase = bp;
  // Cannon Heightfield 的 calculateWorldAABB() 按设计返回无限 AABB。
  // 赛道 Heightfield 只用于四轮射线查询，collisionResponse=false 且过滤组也不参与
  // 刚体碰撞；若让 GridBroadphase 处理它们，每个 patch 会被放入全部网格，形成
  // 数百万个无效引用并拖慢首个物理步。保留 body 在 world 中供 raycast，宽相只跳过它。
  const rawCollisionPairs = bp.collisionPairs;
  const bodiesWithoutQueryRoad = [];
  bp.collisionPairs = function collisionPairsWithoutQueryRoad(worldArg, pairs1, pairs2) {
    const worldBodies = worldArg.bodies;
    let count = 0;
    for (let i = 0; i < worldBodies.length; i++) {
      const body = worldBodies[i];
      if (body.__roadHeightfield) continue;
      bodiesWithoutQueryRoad[count++] = body;
    }
    bodiesWithoutQueryRoad.length = count;
    worldArg.bodies = bodiesWithoutQueryRoad;
    try {
      return rawCollisionPairs.call(this, worldArg, pairs1, pairs2);
    } finally {
      worldArg.bodies = worldBodies;
    }
  };
  bp.__skipsQueryOnlyRoad = true;
  bp.__gridConfig = { nx: nx, ny: ny, nz: nz, min: b, bins: bp.bins.length };
  bp.__isTrackGrid = true;
  return bp;
}

/* -------------------------------------------------------------------------- */
/*  RacePhysics                                                                */
/* -------------------------------------------------------------------------- */

export class RacePhysics {
  constructor(track) {
    this.track = track;
    // 规格 §三.2：弯道拥挤区的采样索引区间（来自 Track.buildCongestionZones）。
    // 赛道对象缺该字段（旧构造路径/测试桩）时降级为空数组，退化为"全局按聚集度判定"。
    this.congestionZones = (track && track.congestionZones) ? track.congestionZones : [];
    this.cars = [];
    this.byId = new Map();
    this.time = 0;
    this.substep = 1 / 60;
    this.acc = 0;
    this.racing = false;
    this.paused = false;
    this.timeAligned = false;

    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    // ★ 宽相（broadphase）不在这里装配：网格边界必须按**实际场景包围盒**切，
    //   而静态护栏刚体要到下面 registerTrackBodies() 之后才存在。
    //   见 RacePhysics 构造末尾的 makeGridBroadphase() 调用，以及该函数上方的
    //   "帧率事故回放"长注释（NaiveBroadphase → 7.5fps 的唯一根因）。
    // solver 迭代 8：赛车只靠地面弹簧 + 少量车-车/车-护栏接触，8 次已经足够收敛，
    // 10/14 次属于安全冗余，对性能损耗大于视觉收益。
    // ⚠️ 求解器迭代只影响窄相；它**救不了**宽相的 O(n²)。
    world.solver.iterations = 8;
    world.solver.tolerance = 0.005;
    world.allowSleep = false;
    this.world = world;

    // ★ 规格 §1 病根清除：杀掉 cannon ContactEquation 内置的 Baumgarte 速度污染。
    //   必须在任何 world.step 之前完成（原型级补丁，全局一次）。若返回 false
    //   说明 vendored cannon 结构变了 —— 那是硬失败，宁可显式记错也不要静默退化成
    //   "旧行为"。selfCheck 会断言 baumgarteKilled。
    this.baumgarteKilled = installCannonBaumgarteKill();
    // ★★ 同一族病根：vendored cannon 的 `Broadphase.makePairsUnique` 只保留约一半
    //   候选对，且会把 undefined 塞进 pairs1（窄相 TypeError ⇒ 整帧中断）。
    //   它**只被 Grid/SAP 宽相调用**，而 NaiveBroadphase 不调用 —— 所以这颗雷
    //   在出厂版里一直没响，一换宽相就炸。宽相装配前必须已装好。
    this.pairsUniqueFixed = installMakePairsUniqueFix();
    // ★★ 第三颗雷（掉帧的真正大头，52ms/子步）：cannon 的碰撞矩阵是按刚体数
    //   平方预分配的稠密数组，2967 刚体 ⇒ 4,397,093 元素，每个物理子步都要
    //   清零两次。换成稀疏 Map，语义不变（"上一步这对在不在接触"）。
    this.sparseMatrix = installSparseCollisionMatrix();

    this.carMaterial = new CANNON.Material('car');
    const cm = new CANNON.ContactMaterial(this.carMaterial, this.carMaterial, {
      // 规格：近乎绝对塑性（车身吸能形变），消除剐蹭时的皮球弹开
      friction: CFG.CONTACT_FRICTION,
      restitution: CFG.RESTITUTION,
      contactEquationStiffness: CFG.CONTACT_STIFFNESS,
      contactEquationRelaxation: CFG.CONTACT_RELAXATION,
      frictionEquationStiffness: 1e7,
      frictionEquationRelaxation: 3,
    });
    world.addContactMaterial(cm);
    // 保留引用：碰碰车模式需要就地改这一对材质的弹/摩擦（见 _applyCarContactMode）。
    this._carContactMaterial = cm;
    world.defaultContactMaterial.friction = CFG.CONTACT_FRICTION;
    world.defaultContactMaterial.restitution = CFG.RESTITUTION;

    // ---- 静态赛道碰撞体（护栏 / 桥栏 / 桥墩）真的加入物理世界 ----
    // 这是"穿模飞出赛道"的根因：此前 registerTrackBodies 只被 track-verify 里的
    // generateTrack() 调过，而浏览器走的是 track.build() —— 碰撞体描述生成了一堆，
    // 却从来没有 addBody 进世界，护栏和桥墩全是纯视觉装饰，车直接穿过去。
    // （三层测试都测不出来：它们测的是"那个没人调用的入口"。）
    this.barrierMaterial = new CANNON.Material('barrier');
    world.addContactMaterial(new CANNON.ContactMaterial(this.carMaterial, this.barrierMaterial, {
      friction: CFG.BARRIER_FRICTION,
      restitution: CFG.BARRIER_RESTITUTION,
      contactEquationStiffness: CFG.CONTACT_STIFFNESS,
      contactEquationRelaxation: CFG.BARRIER_RELAXATION,   // 规格 §任务2 = 3.0（收紧，抑制深穿透反冲）
      frictionEquationStiffness: 1e7,
      frictionEquationRelaxation: 3,
    }));
    this.staticBodies = registerTrackBodies(world, track, this.barrierMaterial);
    for (const b of this.staticBodies) {
      if (b.__roadHeightfield) {
        // Real road Heightfields are query-only: keep them raycastable for
        // suspension while excluding them from vehicle/barrier solver pairs.
        b.collisionFilterGroup = ROAD_COLLISION_GROUP;
        b.collisionFilterMask = ROAD_COLLISION_GROUP;
      } else {
        b.collisionFilterGroup = CFG.GROUP_BARRIER;
        b.collisionFilterMask = -1;
      }
    }
    // ★ 宽相在这里装配（静态刚体已就位）：网格边界按实测包围盒切，
    //   nx/ny/nz 走构造参数。这一步是"2963 个静态刚体 × NaiveBroadphase
    //   = 7.5fps"的唯一解药，改错一格就会退化成"整帧抛异常、车不动"。
    this.broadphase = makeGridBroadphase(world, track, this.staticBodies);
    // 幽灵车模式（可选，默认关）。必须在任何 addCar 之前初始化 —— 车刚体建立时
    // 就要按它决定 collisionFilterMask。setGhostMode() 会同步刷新已存在的车。
    this.ghostMode = false;
    this.gameMode = 'fm8';
    // 规格 §三.2：弯道拥挤幽灵化（Congestion Zones）运行时状态。
    // zoneGhost = 因"弯道拥挤区"整体进入幽灵模式的车辆集合（每帧由
    // updateCongestionGhosting() 重算）；congestionZones 已在构造函数开头
    // 从 Track 注入（小半径弯道区间）。
    this.zoneGhost = new Set();

    // 外部回调（由 main.js 挂钩）
    this.onAlert = null;
    this.onPenalty = null;
    this.onLap = null;
    this.onCheckpoint = null;
    this.onFinish = null;
    this.onIncident = null;      // FRR：出界但无获利（仅记录，供控制台/调试）
    this.softPairs = new Map();  // 粘性软接触对：撞击步登记，随后若干步持续吸收法向弹开速度
    this.ghostPairs = new Map(); // 预测性幽灵对：TTC 预判出的高速接近车对（按位隔离碰撞）

    // 复用对象，避免每步 GC
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }

  /**
   * 切换驾驶规则（每场实例独立档案，绝不改全局 CFG）。
   *
   *   fm8    —— 拟真规则：幽灵化保护全开、碰撞类罚时生效
   *   horizon—— 轻松驾驶：免罚时、幽灵化静默
   *   bumper —— 碰碰车模式：**全程实体对抗**
   *
   * 碰碰车模式的三条硬规则（只在本模式下生效，fm8/horizon 路径逐字节不变）：
   *   ① 禁用一切幽灵化（发车区/预测性/复位/完赛/拥挤区）——由 `_refreshMasks`
   *      这一"掩码唯一来源"集中归一化，保证碰撞与视觉**同时**看到"无幽灵"；
   *   ② 关闭**碰撞类**罚时（wall / ram）；走线类罚时（切弯/抄近道/出界获利/复位）
   *      照常保留 —— 否则该模式会变成刷圈速的免费通道，成绩不可信；
   *   ③ 车↔车接触材质改为高弹性低摩擦（撞开而不是黏住），由 `_applyCarContactMode` 落地。
   */
  setGameMode(mode) {
    this.gameMode = mode === 'horizon' ? 'horizon' : mode === 'bumper' ? 'bumper' : 'fm8';
    if (this.gameMode === 'bumper') this.ghostMode = false;
    this._applyCarContactMode();
    this._refreshMasks();
  }

  /** 碰碰车模式的车↔车接触材质：高弹性 + 低摩擦（避免侧向钩挂后黏成一团）。 */
  _applyCarContactMode() {
    const cm = this._carContactMaterial;
    if (!cm) return;
    if (this.gameMode === 'bumper') {
      cm.restitution = CFG.BUMPER_RESTITUTION;
      cm.friction = CFG.BUMPER_CONTACT_FRICTION;
    } else {
      cm.restitution = CFG.RESTITUTION;
      cm.friction = CFG.CONTACT_FRICTION;
    }
  }

  /**
   * 全员幽灵模式开关（规格 §二）。
   * 用 collisionFilterGroup/Mask 让**车与车完全不解算**：车只与解析地面约束、
   * 以及护栏/桥栏/桥墩（GROUP_BARRIER 静态刚体）碰撞。
   * 尾流（吸尾流）走的是世界坐标锥形判定，与刚体接触无关，因此幽灵模式下照常生效 ——
   * 这正是"能穿透前车、又能在车尾吃尾流抽头超车"的规格意图。
   * 关闭时恢复成上一轮的贴身肉搏碰撞（非弹性 + 90% 剐蹭吸收 + PIT 角冲量）。
   */
  setGhostMode(on) {
    this.ghostMode = !!on;
    this._refreshMasks();
    if (this.ghostMode) this.softPairs.clear();
  }

  /**
   * 按全局幽灵状态 + 预测性幽灵对，统一重算所有车的碰撞掩码。
   * 这是唯一的掩码来源（setGhostMode / addCar / 预测对开关都走这里），避免多处散改漏改。
   */
  _refreshMasks() {
    const bumper = this.gameMode === 'bumper';
    for (const c of this.cars) {
      // ★ 碰碰车模式：全程实体。掩码唯一来源就是这里，因此**把所有幽灵标记归一化清零**
      //   也放在这里 —— 碰撞解算与视觉（主线程按 c.ghost / rescueGhost / finishGhost /
      //   zoneGhost 决定透明度）同时看到"无幽灵"，不可能出现"半透明却是实体"或
      //   "看着实体却能穿透"的不一致。
      if (bumper) {
        c.ghost = 0; c.ghostTimer = 0; c.pgGhost = false;
        c.rescueGhost = false; c.finishGhost = false; c.zoneGhost = false;
        c.ghostReasonCode = 0;
      }
      let mask = this.ghostMode ? ~CFG.GROUP_CAR_MASK : -1;
      if (!bumper) {
        // 预测性幽灵对：在标准模式下按对隔离（全员幽灵时整体已不碰撞，无需再剔）
        for (const [, pr] of this.ghostPairs) {
          if (pr.a === c) mask &= ~pr.b.groupBit;
          else if (pr.b === c) mask &= ~pr.a.groupBit;
        }
        // 完赛车只保留地面和护栏碰撞，避免在终点线继续阻挡未完赛车。
        if (c.finishGhost) mask &= ~CFG.GROUP_CAR_MASK;
        // 规格 §二.3：R 键救援幽灵期**只剔车车**，严格保留护栏与地面。
        if (c.rescueGhost || c.ghost > 0) mask &= ~CFG.GROUP_CAR_MASK;
        // 规格 §三.2：弯道拥挤幽灵化的车辆同样只剔车车位域（护栏/地面全保留）。
        // 用位掩码逐位剔，天然与 rescueGhost / 预测对可叠加，不需要第三套开关。
        if (this.zoneGhost && this.zoneGhost.has(c)) mask &= ~CFG.GROUP_CAR_MASK;
      }
      c.body.collisionFilterGroup = c.groupBit;
      c.body.collisionFilterMask = mask;
      // 兜底保险：任何路径都不该把总闸关掉（关掉会连护栏一起失效）
      c.body.collisionResponse = true;
    }
  }

  /** 预测性幽灵对开关：isolation 用掩码按位隔离，同时给两车打半透明标记 */
  _setGhostPair(a, b, key, on) {
    if (on) {
      if (this.ghostPairs.has(key)) return;
      this.ghostPairs.set(key, { a, b });
      a.pgGhost = 1; b.pgGhost = 1;
    } else {
      if (!this.ghostPairs.has(key)) return;
      this.ghostPairs.delete(key);
      a.pgGhost = 0; b.pgGhost = 0;
    }
    this._refreshMasks();
  }

  /**
   * 预测性前向幽灵化（规格 §二.2）。
   * 每个物理步前向扫描车对：
   *   预计 0.15s 内接触（TTC）且 法向接近速度 > 22.2 m/s（恶意鱼雷追尾 / 严重失控打转）
   *   -> 该车对立即**临时隔离碰撞**（按位剔掩码）+ 两车半透明 0.35；
   * 分离 > 3.5m 且法向接近速度恢复正常后平滑恢复。
   * 注意：只作用于**标准碰撞模式**；全员幽灵模式下本来就没有车车碰撞。
   */
  updatePredictiveGhosting() {
    // 碰碰车模式要求"全程实体"：整套预测性幽灵化直接不运行（与 ghostMode 同一道闸）。
    if (this.ghostMode || this.gameMode === 'bumper') return;
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (a.retired || b.retired) continue;
        const key = a.id + ':' + b.id;
        const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y, dz = a.pos.z - b.pos.z;
        const d = Math.hypot(dx, dy, dz) || 1e-3;
        const rx = a.vel.x - b.vel.x, ry = a.vel.y - b.vel.y, rz = a.vel.z - b.vel.z;
        // 相对速度沿两车连线的投影：>0 表示正在接近
        const closing = -(dx * rx + dy * ry + dz * rz) / d;
        if (this.ghostPairs.has(key)) {
          // 已幽灵：分离够远且不再接近 -> 平滑恢复
          if (d > CFG.PRED_GHOST_CLEARANCE_M && closing < CFG.PRED_GHOST_REJOIN_V) {
            this._setGhostPair(a, b, key, false);
          }
        } else {
          // 碰撞时间 TTC = 距离 / 法向接近速度
          const ttc = closing > 0.1 ? d / closing : Infinity;
          if (ttc < CFG.PRED_GHOST_TTC && closing > CFG.PRED_GHOST_MS) {
            this._setGhostPair(a, b, key, true);
          }
        }
      }
    }
  }

  /**
   * 规格 §三.2：弯道动态拥挤幽灵化（Congestion Zones）。
   *
   * 场景：三大赛道的发卡弯 / 减速弯 / 连续小半径弯里，多台车挤在一起互相顶撞，
   * 低速下碰撞解算既没有动量可换、又把彼此卡死（"弯道堵车"）。规格要求：
   * 区内局部 10m 半径内出现 >2 台车且存在碰撞风险时，**区内所有车**进入
   * "拥挤幽灵模式"——车与车之间不解算穿透 + 半透明；间距拉开到 >6m 后平滑恢复。
   *
   * 实现要点：
   *   · 拥挤区来自 Track（`congestionZones`，小半径弯的采样索引区间）。缺省时本函数
   *     退化为"全局按车辆聚集度判定"，不依赖任何赛道数据（离线/AI 场景也可用）。
   *   · 只在**都未完赛、非远端、正常碰撞模式**的车之间判定（幽灵全局模式下无需叠加）。
   *   · 单帧稳定：命中即加入 `zoneGhost`，随后每帧重新评估；未命中直接移除 ->
   *     `_refreshMasks()` 幂等刷新 + main.js 侧 `_pgAmt` 指数缓动完成"平滑恢复"。
   */
  updateCongestionGhosting() {
    // 碰碰车模式：弯道拥挤幽灵化同样整体停用（实体对抗优先于防堵死）。
    if (this.ghostMode || this.gameMode === 'bumper') {
      if (this.zoneGhost.size) { this.zoneGhost.clear(); this._refreshMasks(); }
      return;
    }
    const cars = this.cars;
    // 至少需要 CONGEST_MIN_CARS+1 台车同时在场才可能凑出"区内 >CONGEST_MIN_CARS 台"
    if (cars.length <= CFG.CONGEST_MIN_CARS) {
      if (this.zoneGhost.size) { this.zoneGhost.clear(); this._refreshMasks(); }
      return;
    }
    const R2 = CFG.CONGEST_RADIUS_M * CFG.CONGEST_RADIUS_M;
    const active = new Set();

    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.retired || a.remote) continue;
      // ① 拥挤区判定：本车是否处在赛道指定的小半径弯区间内
      if (!this._inCongestionZone(a)) continue;

      // ② 聚集度判定：局部 CONGEST_RADIUS_M 内的**总车数**（含本车）
      //    必须 > CONGEST_MIN_CARS。规格原文"局部 10m 内 >2 辆"= 含本车共 3 台起。
      //    ⚠ 曾写成 `near > MIN_CARS`（near 不含本车）=> 3 台车聚在一起时 near=2，
      //    `2 > 2` 为假 -> 真实弯道堵车永远不触发。判据必须是 `near + 1 > MIN_CARS`。
      let near = 1;                 // 含本车
      let risk = false;
      for (let j = 0; j < cars.length; j++) {
        if (j === i) continue;
        const b = cars[j];
        if (b.retired) continue;
        const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y, dz = a.pos.z - b.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R2) continue;
        near++;
        // ③ 碰撞风险：TTC 预判（接近中且 CONGEST_TTC 秒内接触）
        const d = Math.sqrt(d2) || 1e-3;
        const rx = a.vel.x - b.vel.x, ry = a.vel.y - b.vel.y, rz = a.vel.z - b.vel.z;
        const closing = -(dx * rx + dy * ry + dz * rz) / d;
        if (closing > 0.1 && d / closing < CFG.CONGEST_TTC) risk = true;
      }
      if (near > CFG.CONGEST_MIN_CARS && risk) active.add(a);
    }

    // ④ 恢复迟滞：已在幽灵集中的车，只要仍在该拥挤区内且与其他车相距
    //    < CONGEST_RELEASE_M，就继续保持幽灵，避免在临界点反复闪烁。
    for (const c of this.zoneGhost) {
      if (active.has(c)) continue;
      if (!this._inCongestionZone(c)) continue;
      let still = false;
      for (const o of cars) {
        if (o === c || o.retired) continue;
        const dx = c.pos.x - o.pos.x, dy = c.pos.y - o.pos.y, dz = c.pos.z - o.pos.z;
        if (dx * dx + dy * dy + dz * dz < CFG.CONGEST_RELEASE_M * CFG.CONGEST_RELEASE_M) {
          still = true; break;
        }
      }
      if (still) active.add(c);
    }

    // ⑤ 差量更新：只有集合真的变化时才重刷掩码（_refreshMasks 是 O(n²) 但 n<=12）
    let changed = active.size !== this.zoneGhost.size;
    if (!changed) {
      for (const c of active) if (!this.zoneGhost.has(c)) { changed = true; break; }
    }
    if (!changed) return;
    this.zoneGhost = active;
    for (const c of cars) {
      // 半透明标记（驾驶本地车不透明由 main.js 的 restoreOwn 处理）
      c.zoneGhost = active.has(c) ? 1 : 0;
    }
    this._refreshMasks();
  }

  /**
   * 判定车辆是否处在赛道的小半径弯拥挤区。
   * `congestionZones` 为 `[{i0, i1, wrapped}]`（采样索引闭区间，可能跨 0 点环绕）。
   * 未注入时返回 true（退化为"全局按聚集度判定"）。
   */
  _inCongestionZone(car) {
    const zs = this.congestionZones;
    if (!zs || !zs.length) return true;
    const i = car.trackIdx | 0;
    for (let k = 0; k < zs.length; k++) {
      const z = zs[k];
      if (z.wrapped) {
        if (i >= z.i0 || i <= z.i1) return true;
      } else if (i >= z.i0 && i <= z.i1) {
        return true;
      }
    }
    return false;
  }

  addCar(opts) {
    const c = new Car(this, opts);
    this.cars.push(c);
    this.byId.set(c.id, c);
    this._refreshMasks();
    this.refreshSlipstream(true);
    return c;
  }

  removeCar(id) {
    const c = this.byId.get(id);
    if (!c) return;
    this.world.removeBody(c.body);
    this.byId.delete(id);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
  }

  setAIAuthority(local) {
    for (const c of this.cars) {
      if (!c.ai || c.remote === !local) continue;
      c.remote = !local;
      c.auto = !!local;
      c.netTarget = null;
      c.body.type = local ? CANNON.Body.DYNAMIC : CANNON.Body.KINEMATIC;
      c.body.mass = local ? CFG.MASS : 0;
      c.body.updateMassProperties();
      c.body.wakeUp();
      c.lapStart = this.time - (c.lapTimeLive || 0);
      c.raceLocked = !this.racing;
    }
    this._refreshMasks();
  }

  clear() {
    for (const c of this.cars.slice()) this.removeCar(c.id);
    this.time = 0;
    this.acc = 0;
  }

  /**
   * 由网络层写入远端车辆的插值位姿（作为运动学伺服目标）。
   * 复用 c._nt 缓冲，避免每帧产生垃圾对象（30Hz x 4 车）。
   */
  applyRemoteTarget(id, pos, quat, vel) {
    const c = this.byId.get(id);
    if (!c || !c.remote) return;
    let t = c._nt;
    if (!t) {
      t = c._nt = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0 };
    }
    t.x = pos.x; t.y = pos.y; t.z = pos.z;
    t.qx = quat.x; t.qy = quat.y; t.qz = quat.z; t.qw = quat.w;
    t.vx = vel ? vel.x : 0;
    t.vy = vel ? vel.y : 0;
    t.vz = vel ? vel.z : 0;
    c.netTarget = t;
  }

  /**
   * 写入远端车辆的**入力遥测**（规格 §四.2 观战入力回显）。
   * 服务端 60Hz 位姿包携带 u(throttle)/b(brake)/e(steer)/h(handbrake)，
   * 这里落到车辆对象上，供 HUD 在被观战时展示键盘指示器与踏板条。
   * 注意与 physics 的 `input` 分离：remote 车的 `input` 由运动学伺服驱动、
   * 不参与本地物理，这里只更新给 HUD 读的遥测镜像。
   */
  setRemoteInput(id, thr, brk, steer, hand) {
    const c = this.byId.get(id);
    if (!c || !c.remote) return;
    c.throttle = clamp(thr, 0, 1);
    c.brake = clamp(brk, 0, 1);
    c.steer = clamp(steer, -1, 1);
    c.handbrake = hand ? 1 : 0;
  }

  /* ---------------------------------------------------------------------- */
  /*  主步进                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * 固定时间步长 + 累加器（规格第一条）。
   * 物理永远以 1/60 的固定步长推进 —— world.step() 收到的也是固定 dt，
   * 绝不把可变帧间隔直接喂给积分器（否则刷新率波动/丢帧会造成数值发散与抖动）。
   * 帧间隔只用来决定"这一帧要跑几个固定步"。
   * 渲染端用 acc/substep 作为插值系数（见 main.js 的视觉同步），消除子步撕裂。
   * @param {number} dt 真实帧间隔
   */
  step(dt) {
    if (this.paused) return;
    this.acc += Math.min(dt, 0.1);          // 规格：Math.min(dt, 0.1)
    let n = 0;
    while (this.acc >= this.substep && n < 6) {   // 规格：maxSubSteps = 3；这里给到 6 以吸收卡顿
      this.fixedStep(this.substep);
      this.acc -= this.substep;
      n++;
    }
    if (n === 6) this.acc = 0;              // 掉帧保护：丢弃积压，避免"追帧爆炸"
    // 供渲染插值：0..1
    this.alpha = clamp(this.acc / this.substep, 0, 1);
  }

  fixedStep(dt) {
    this.time += dt;
    this.stepCount = (this.stepCount || 0) + 1;
    const cars = this.cars;

    for (const c of cars) {
      // 记录本步之前的位姿，供渲染端做子步插值
      c.prevPos.copy(c.pos);
      c.prevQuat.copy(c.quat);
      c.syncFromBody();
      c.bumpCooldown = Math.max(0, c.bumpCooldown - dt);
      c.ramCooldown = Math.max(0, c.ramCooldown - dt);
      c.resetCooldown = Math.max(0, c.resetCooldown - dt);
    }

    this.refreshSlipstream();
    // 预测性前向幽灵化（规格 §二.2）：TTC + 相对速度扫描，比碰撞求解更早一步隔离高速车对
    this.updatePredictiveGhosting();
    // 弯道动态拥挤幽灵化（规格 §三.2）：小半径弯内多车拥挤时整体幽灵化，防弯道堵死
    this.updateCongestionGhosting();

    for (const c of cars) {
      if (c.remote) {
        this.steerRemote(c, dt);
      } else {
        this.updateSteer(c, dt);      // 先更新转向状态（含回正插值），再算力
        this.driveLocal(c, dt);
      }
      this.groundConstraint(c, dt);
    }
    // Cannon has already removed the normal component by the time contacts are
    // observable, so using post-step velocity here makes every wall hit look
    // like a dead stop and destroys the tangential momentum we need to guide.
    for (const c of cars) {
      if (c.remote) continue;
      c.preBarrierVx = c.body.velocity.x;
      c.preBarrierVz = c.body.velocity.z;
    }

    this.world.step(dt);

    // 规格 §一：护栏接触导流偏转。必须在 world.step 之后（拿到本步接触流形）、
    // 且 projectPenetration 之前（先导流动量，再修几何位置）。
    this.applyBarrierDeflection(dt);

    // 规格 §四：FM8 级护栏接触导向 + 偏摆力矩 + 几何防吸入外推。
    // 与上面的 applyBarrierDeflection 是**叠加**关系（后者是本工程既有的通用导流层，
    // 本层是规格 §四 明确给出的 FM8 公式：切向 90% 保留 + theta<60° 偏摆冲量 + pen+0.03 外推）。
    this.applyBarrierGuidance(dt);

    // 方案 A：分离位置投影。必须紧跟 world.step，且在地面约束之前。
    this.projectPenetration(dt);

    // 碰撞角冲量在求解器迭代结束后再施加，避免中途改动角速度干扰求解
    this.applyPendingYawImpulses();
    this.absorbSoftContacts();      // 低速剐蹭：吸收 75% 法向弹开速度
    // 碰撞后硬限幅（规格 §任务5）：被追尾/侧蹭车尾时，接触点离质心远 => 力臂大
    // => 横摆角速度与 Y 向反冲双重超调。这里在**每个物理子步求解结束后**做硬截断
    // （等价于规格里的 postStep —— 本工程没有 world 级 postStep 回调，所有碰撞后处理
    //   都收在 fixedStep 内，位置就在这里）。
    this.clampCollisionImpulse(cars);

    for (const c of cars) {
      c.syncFromBody();
      if (!c.remote) {
        // 方案 D：正滚翻/侧翻角速度限幅（撞车与撞墙两条路径都覆盖）
        this.limitFlipAngular(c, CFG.FLIP_W_CAP);
        this.groundConstraint(c, dt, true);
        c.syncFromBody();
        this.groundOrientation(c, dt);
        this.limitAngular(c, dt);
        this.updateDriftState(c, dt);  // 侧偏角 / 漂移标记（供烟雾与胎痕）+ 被撞宽限递减
      }
    }

    if (this.racing) {
      // 幽灵模式下车与车根本不接触，恶意撞击判定没有意义（也拿不到接触点）
      if (!this.ghostMode) this.resolveRam(dt);
      for (const c of cars) if (!c.remote) this.updateProgress(c, dt);
      // 套圈/逆行幽灵必须在本步所有真实进度更新后统一判定，不能只看空间距离。
      this.updateRaceGhosting();
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  地面约束（实际 Heightfield 射线悬挂）                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Four wheel suspension raycasts the layer-aware Cannon Heightfields. The
   * sample() lookup remains for lap/lateral bookkeeping, while support height
   * and normal come from the physical road patches whenever a wheel is over
   * asphalt/curb. This keeps bridge layers separated without teleporting the
   * chassis through the road.
   */
  groundConstraint(c, dt, post = false) {
    const t = this.track;
    // 先做一次不带层偏好的几何采样，用于跨过桥面起点那一个采样格。
    // c.trackIdx 仍可能停在桥区前一格；只看旧索引会把上行段继续判成地面。
    const geometricInfo = t.sample(c.pos.x, c.pos.z, c.trackIdx, c.body.position.y);
    const routeLayer = (geometricInfo.onBridge ||
      (typeof c.trackIdx === 'number' && c.trackIdx >= 0 && t.onBridge(c.trackIdx)))
      ? 'bridge' : 'ground';
    const info = t.sample(c.pos.x, c.pos.z, c.trackIdx, c.body.position.y, routeLayer);
    // ★★ 连续弧长坐标的"压线次数"（2026-09-29）──────────────────────────────
    const prevIdx = c.trackIdx;
    c.trackIdx = info.i;
    if (typeof prevIdx === 'number' && prevIdx === prevIdx) {
      const halfCount = (t.count || 1440) * 0.5;
      const dIdx = c.trackIdx - prevIdx;
      if (dIdx < -halfCount) c.lineCross = (c.lineCross || 0) + 1;
      else if (dIdx > halfCount) c.lineCross = Math.max(0, (c.lineCross || 0) - 1);
    }
    c.lateral = info.lateral;
    c.roadNormal = info.normal;
    c.roadTangent = info.tangent;
    c.roadSide = info.side;

    const wheelLocal = [
      new CANNON.Vec3(-CFG.HALF.x * 0.78, -CFG.HALF.y * 0.72, -CFG.HALF.z * 0.68),
      new CANNON.Vec3( CFG.HALF.x * 0.78, -CFG.HALF.y * 0.72, -CFG.HALF.z * 0.68),
      new CANNON.Vec3(-CFG.HALF.x * 0.78, -CFG.HALF.y * 0.72,  CFG.HALF.z * 0.68),
      new CANNON.Vec3( CFG.HALF.x * 0.78, -CFG.HALF.y * 0.72,  CFG.HALF.z * 0.68),
    ];
    const wheelHits = [];
    let hitY = 0, hitNx = 0, hitNy = 0, hitNz = 0;
    for (const local of wheelLocal) {
      const wheel = c.body.pointToWorldFrame(local, new CANNON.Vec3());
      const wheelInfo = t.sample(wheel.x, wheel.z, info.i, c.body.position.y, routeLayer);
      const n0 = wheelInfo.normal;
      const rayFrom = new CANNON.Vec3(
        wheel.x + n0.x * 0.75,
        wheel.y + n0.y * 0.75,
        wheel.z + n0.z * 0.75,
      );
      const hit = t.raycastRoad(
        rayFrom,
        { x: -n0.x, y: -n0.y, z: -n0.z },
        CFG.RAYCAST_SUSPENSION_LENGTH,
        c.body.position.y,
        info.onBridge ? 'bridge' : 'ground',
      );
      // Heightfield 的 patch 边界带有竖直侧壁。车身掉到路面下方时，
      // 射线可能从侧壁返回一个“命中”，但它既不是当前线路层，也不在
      // 当前横断面的合理高程上；把它当作支撑会把车继续吸进地面。
      const hx = hit ? hit.normal.x : n0.x;
      const hy = hit ? hit.normal.y : n0.y;
      const hz = hit ? hit.normal.z : n0.z;
      const agreement = hx * n0.x + hy * n0.y + hz * n0.z;
      const validHit = hit && hit.layer === (info.onBridge ? 'bridge' : 'ground') &&
        Math.abs(hit.point.y - wheelInfo.y) <= 1.75 && Math.abs(agreement) > 0.5;
      if (validHit) {
        wheelHits.push(hit);
        hitY += hit.point.y;
        // 悬挂沿道路基准法线伸缩。Heightfield 在路肩边缘的三角
        // 法线只用于确认顶面；让减震器沿该三角侧向斜坡施力会把
        // 高速横滑误当成悬挂压缩/伸长速度，注入额外竖直动量。
        hitNx += n0.x; hitNy += n0.y; hitNz += n0.z;
      } else {
        // 离开有限宽度查询网格的轮子仍由该轮的解析草地/路肩支撑。
        // 只平均剩余的两条射线会把路肩斜面当作整车法线，产生虚假跳跃。
        hitY += wheelInfo.y;
        hitNx += n0.x; hitNy += n0.y; hitNz += n0.z;
      }
    }
    const supportY = hitY / wheelLocal.length;
    const nl = Math.hypot(hitNx, hitNy, hitNz) || 1;
    const n = { x: hitNx / nl, y: hitNy / nl, z: hitNz / nl };
    c.roadRayHits = wheelHits.length;
    c.roadLayer = info.onBridge ? 'bridge' : 'ground';
    c.roadNormal = n;
    c.groundY = supportY;

    // 查询面的碰撞响应已关闭，支撑只能由弹簧和阻尼承担。
    // 按车壳最低角点反复抬高位置会使 x < -DROOP，而下落速度仍继续
    // 积累：悬挂被错误关掉，碰撞数十帧后出现数 m/s 的竖直速度。

    // 弹簧自由长度位置 = 静态行驶高度 + 静态下沉量（保证静止时正好落在 RIDE_H）
    const restY = supportY + (CFG.RIDE_H + SUSP.SAG) * Math.max(0.5, n.y);
    let x = restY - c.body.position.y;          // >0 = 压缩

    // 路肩颠簸与悬挂高频起伏
    const curHw = this.track.halfWidthAt ? this.track.halfWidthAt[c.trackIdx] : this.track.halfWidth;
    const latAbs = Math.abs(c.lateral);
    const curbW = this.track.curbWidth || 1.2;
    if (latAbs >= curHw - 0.2 && latAbs <= curHw + curbW + 0.3) {
      const bumpPhase = (this.track.arcLen ? this.track.arcLen[c.trackIdx] : c.trackIdx * 4) * 2.5;
      const curbVibration = Math.sin(bumpPhase) * 0.035;
      x += curbVibration;
      c.onCurb = true;
    } else {
      c.onCurb = false;
    }
    const vn = c.body.velocity.x * n.x + c.body.velocity.y * n.y + c.body.velocity.z * n.z;
    c.suspCompression = x;
    c.suspVel = -vn;

    if (x < -SUSP.DROOP) {
      c.airborne = true;
      c.grounded = false;
      return;
    }
    c.airborne = false;
    c.grounded = true;
    if (post) return;

    // 悬挂解耦保护：碰撞窗口内冻结行程上限，防止冲量把弹簧压到底。
    if (c.suspLockT > 0) c.suspLockT -= dt;
    const lockEngaged = c.suspLockT > 0;
    const lockTarget = lockEngaged ? CFG.SUSP_LOCK_SLACK * SUSP.MAX_TRAVEL : SUSP.MAX_TRAVEL;
    if (c.suspLimit === undefined) c.suspLimit = SUSP.MAX_TRAVEL;
    const kRec = lockEngaged ? 1 - Math.exp(-18 * dt) : 1 - Math.exp(-6 * dt);
    c.suspLimit += (lockTarget - c.suspLimit) * kRec;

    const xc = Math.max(x, 0);
    let spring = SUSP.K * Math.min(xc, c.suspLimit);
    if (xc > c.suspLimit) spring += SUSP.BUMP_STOP * (xc - c.suspLimit);
    if (x < 0) spring = SUSP.K * x;
    const damper = -SUSP.C * vn;
    const fN = spring + damper;
    _fv.set(n.x * fN, n.y * fN, n.z * fN);
    c.body.applyForce(_fv, ZERO_POINT);

    // Last-resort vertical guard for an extreme missed contact; normal road
    // support is supplied by the Heightfield ray hits above.
    const limitY = restY - SUSP.MAX_TRAVEL * 1.5;
    if (c.body.position.y < limitY) {
      c.body.position.y = limitY;
      if (vn < 0) {
        c.body.velocity.x -= n.x * vn;
        c.body.velocity.y -= n.y * vn;
        c.body.velocity.z -= n.z * vn;
      }
    }
  }

  /**
   * ★ 自动幽灵（2026-09-30，用户报障：① 撞击后横在赛道上会挡住后方车流；
   *   ② 被连续撞击时应自动幽灵，避免被反复追尾）。
   *
   * 两条触发条件（都复用既有的 ghostTimer 通道 —— 视觉半透明 + 只剔除车车碰撞，
   * **护栏与地面照旧生效**，绝不会穿墙）：
   *   A. **横在赛道上打转/停住**：车速 < 12km/h 且车头与赛道切线夹角 > 60°，持续 0.2s
   *      ⇒ 幽灵 2.5s（条件持续则续期）。给后方车流一个"能穿过去"的窗口。
   *   B. **短时间被多次撞击**：4 秒内被撞 ≥2 次 ⇒ 幽灵 2.0s（防被反复顶）。
   * 每帧调用，成本可忽略（只做两次比较与一次计时）。
   */
  updateAutoGhost(c, dt) {
    // A. 横在赛道上
    const tanI = this.track.tan[c.trackIdx];
    const hx = c.fwd.x, hz = c.fwd.z;
    const along = hx * tanI.x + hz * tanI.z;              // |along| 小时 = 横着
    const sideways = Math.abs(along) < 0.5 && c.speedKmh < 12;
    if (sideways) {
      c.sidewaysT = (c.sidewaysT || 0) + dt;
      if (c.sidewaysT > 0.2) this._activateGhost(c, 3, CFG.AUTO_GHOST_SIDEWAYS_T);
    } else {
      c.sidewaysT = 0;
    }
    // B. 连续被撞
    if (c.recentHits > 0) {
      c.recentHitsT = (c.recentHitsT || 0) + dt;
      if (c.recentHitsT > CFG.AUTO_GHOST_HIT_WINDOW) { c.recentHits = 0; c.recentHitsT = 0; }
    }
    if ((c.recentHits || 0) >= 2) {
      this._activateGhost(c, 3, CFG.AUTO_GHOST_HIT_T);
      c.recentHits = 0; c.recentHitsT = 0;
    }
    void along;
  }

  /** 把车身姿态对齐到路面法线（保留当前航向，只修正俯仰/侧倾） */
  groundOrientation(c, dt) {
    const n = c.roadNormal || this.track.nrm[c.trackIdx];
    if (!n) return;
    const fwd = c.fwd;
    const dot = fwd.dot(n);
    const planar = this._v.copy(fwd).addScaledVector(n, -dot);
    if (planar.lengthSq() < 1e-6) planar.copy(this.track.tan[c.trackIdx]);
    planar.normalize();
    const right = this._v2.crossVectors(n, planar).normalize();

    this._m.makeBasis(right, n, planar);
    this._q.setFromRotationMatrix(this._m);
    const k = c.airborne ? 0.9 : 12.0;
    const a = 1 - Math.exp(-k * dt);
    c.body.quaternion.slerp(this._q, a, c.body.quaternion);
    c.body.quaternion.normalize();
  }

  /** 抑制俯仰/侧倾角速度，只保留横摆分量，防止翻车与自发旋转 */
  limitAngular(c, dt) {
    const n = c.roadNormal || this.track.nrm[c.trackIdx];
    const av = this._v3.set(c.body.angularVelocity.x, c.body.angularVelocity.y, c.body.angularVelocity.z);
    const yaw = av.dot(n);
    const rest = av.addScaledVector(n, -yaw).multiplyScalar(0.80);
    // 上限放宽到 4.5rad/s，给手刹甩尾与碰撞留出旋转空间
    const y = clamp(yaw, -CFG.YAW_MAX_ABSOLUTE, CFG.YAW_MAX_ABSOLUTE);
    c.body.angularVelocity.set(rest.x + n.x * y, rest.y + n.y * y, rest.z + n.z * y);
  }

  /* ---------------------------------------------------------------------- */
  /*  转向状态机（速度敏感限幅 + 攻击/回正双速率）                            */
  /* ---------------------------------------------------------------------- */

  /**
   * 速度敏感的最大前轮转角：
   *   <30km/h  → 0.55 rad（约 31.5°，低速掉头够用）
   *   >120km/h → 0.15 rad（约 8.6°，高速不会一打方向就翻/甩）
   *   中间用 smoothstep 平滑过渡，避免分段跳变导致的手感断层。
   */
  maxSteerAt(kmh) {
    const t = clamp((kmh - CFG.STEER_LOW_KMH) / (CFG.STEER_HIGH_KMH - CFG.STEER_LOW_KMH), 0, 1);
    const s = t * t * (3 - 2 * t);          // smoothstep
    return CFG.STEER_MAX_LOW + (CFG.STEER_MAX_HIGH - CFG.STEER_MAX_LOW) * s;
  }

  /**
   * 转向输入积分（规格：转向滤波 + 低速非线性）
   *   1) 低速非线性：车速 < 40km/h 时 有效打盘量 = sign(input)·|input|^1.6
   *      小幅微调更柔顺，只有长按打满才进入极限转角。
   *      40km/h 附近按 STEER_CURVE_FADE_KMH 线性淡出，避免手感在阈值处断层。
   *   2) 指数滤波：currentSteer = damp(currentSteer, target, 14.0, dt)
   *      废除"瞬时打死"——指数形式前期快后期缓，等价手打方向盘的机械行程。
   * 同时维护手刹咬合程度（咬合快 0.05s / 释放慢 0.20s）。
   */
  updateSteer(c, dt) {
    const raw = clamp(c.input.steer, -1, 1);
    // ---- 低速非线性曲线（平滑淡出）----
    const fade = clamp((CFG.STEER_LOWSPEED_KMH - c.speedKmh) / CFG.STEER_CURVE_FADE_KMH, 0, 1);
    const curved = Math.sign(raw) * Math.pow(Math.abs(raw), CFG.STEER_CURVE_EXP);
    const target = raw + (curved - raw) * fade;
    c.steerTarget = target;                       // 供调试/断言
    // ---- 指数滤波（规格公式）----
    c.steerInput = THREE.MathUtils.damp(c.steerInput, target, CFG.STEER_DAMP_LAMBDA, dt);

    // 手刹状态：按下立刻咬合，松开 0.2s 内缓释（规格：防 Snap Oversteer）
    const hbTarget = c.input.handbrake > 0.5 ? 1 : 0;
    if (hbTarget > c.handbrake) {
      c.handbrake = Math.min(1, c.handbrake + dt / CFG.HANDBRAKE_BITE_T);
    } else if (hbTarget < c.handbrake) {
      c.handbrake = Math.max(0, c.handbrake - dt / CFG.HANDBRAKE_RELEASE_T);
    }
    // 碰撞扰动窗口倒计时
    c.yawDisturb = Math.max(0, c.yawDisturb - dt);
  }

  /* ---------------------------------------------------------------------- */
  /*  动力总成：扭矩曲线 + 6 档变速 + 换档切断                                */
  /* ---------------------------------------------------------------------- */

  /** 引擎扭矩曲线 T(rpm)：怠速->4500rpm 线性上爬至峰值，之后缓降到红线断油 */
  torqueAt(rpm) {
    const T = CFG.ENGINE_TORQUE_PEAK, lo = CFG.IDLE_RPM;
    const pk = CFG.TORQUE_PEAK_RPM, red = CFG.REDLINE_RPM;
    if (rpm >= red) return 0;
    if (rpm <= lo) return T * CFG.TORQUE_LOW_FACTOR;
    if (rpm <= pk) {
      return T * (CFG.TORQUE_LOW_FACTOR + (1 - CFG.TORQUE_LOW_FACTOR) * (rpm - lo) / (pk - lo));
    }
    return T * (1 - 0.22 * (rpm - pk) / (red - pk));
  }

  totalRatio(gear) { return CFG.GEAR_RATIOS[gear] * CFG.FINAL_DRIVE; }

  /** 由车速反推指定档位下的发动机转速 */
  rpmFor(c, gear) {
    const wheelOmega = Math.max(Math.abs(c.forwardSpeed), 0) / CFG.WHEEL_RADIUS;
    const rpm = wheelOmega * this.totalRatio(gear) * 60 / (2 * Math.PI);
    return clamp(rpm, CFG.IDLE_RPM, CFG.REDLINE_RPM + 100);
  }

  /** 自动变速：到升档转速升档、掉到降档转速降档，换档期间动力切断 */
  updateGearbox(c, dt) {
    if (c.shiftTimer > 0) { c.shiftTimer -= dt; c.rpm = this.rpmFor(c, c.gear); return; }
    const rpm = this.rpmFor(c, c.gear);
    c.rpm = rpm;
    if (rpm > CFG.SHIFT_UP_RPM && c.gear < CFG.GEAR_RATIOS.length - 1) {
      c.gear++; c.shiftTimer = CFG.SHIFT_TIME;
    } else if (rpm < CFG.SHIFT_DOWN_RPM && c.gear > 0) {
      c.gear--; c.shiftTimer = CFG.SHIFT_TIME;
    }
  }

  /** 驱动轮可用推力 (N)：F = T(rpm)·总传动比·效率 / 滚动半径 */
  driveForce(c, throttle) {
    if (c.shiftTimer > 0) return 0;                       // 换档动力切断
    const rpm = this.rpmFor(c, c.gear);
    if (rpm >= CFG.REDLINE_RPM) return 0;                 // 断油
    const T = this.torqueAt(rpm);
    const F = (T * this.totalRatio(c.gear) * CFG.DRIVELINE_EFF) / CFG.WHEEL_RADIUS;
    return Math.min(F, CFG.MAX_FORCE) * throttle;
  }

  /* ---------------------------------------------------------------------- */
  /*  动态载荷转移（Weight Transfer）—— 消除推头的核心                        */
  /* ---------------------------------------------------------------------- */

  tireGripFactor(temp) {
    const t = Number.isFinite(temp) ? temp : CFG.TIRE_START_C;
    if (t <= CFG.TIRE_OPT_C) {
      const u = clamp((t - CFG.TIRE_AMBIENT_C) / (CFG.TIRE_OPT_C - CFG.TIRE_AMBIENT_C), 0, 1);
      return CFG.TIRE_COLD_GRIP + (1 - CFG.TIRE_COLD_GRIP) * u;
    }
    const over = Math.max(0, t - CFG.TIRE_OPT_C);
    return clamp(1 - over * (1 - CFG.TIRE_HOT_GRIP) / Math.max(CFG.TIRE_MAX_C - CFG.TIRE_OPT_C, 1), CFG.TIRE_HOT_GRIP, 1);
  }

  /**
   * VitaVehicle 风格滑移率抓地曲线：侧偏角 -> 抓地保留率。
   *
   *   · 上升段（0 -> SLIP_PEAK_DEG）：smoothstep 从 SLIP_PEAK_GAIN 升到 1.0。
   *     小侧偏时轮胎"咬住"路面，入弯中段达到峰值 —— 这是抓地最充足的窗口。
   *   · 衰减段（> 峰值）：指数收敛到 SLIP_FALLOFF_KEEP（不是坠到 0）。
   *     漂移中车尾是"滑"而不是"甩崖"，反打方向+收油能救回来。
   *
   * 连续性：衰减段在 d = SLIP_PEAK_DEG 处恰好等于 1.0（KEEP + (1-KEEP)·e⁰），
   * 与上升段终点无缝衔接，无折角。
   *
   * 返回值乘到 aLatCap 上（见 driveLocal 的横向抓地段）；规格 §四 的动摩擦
   * 下限（latFloorMu）仍是最外层兜底 —— 完全侧滑时侧向 mu 不会低于 0.45 量级。
   */
  slipGripFactor(deg) {
    const d = Math.abs(Number.isFinite(deg) ? deg : 0);
    const peak = CFG.SLIP_PEAK_DEG;
    if (d <= peak) {
      const u = d / peak;
      const s = u * u * (3 - 2 * u); // smoothstep：0 阶导数两端为零，无折角
      return CFG.SLIP_PEAK_GAIN + (1 - CFG.SLIP_PEAK_GAIN) * s;
    }
    const decay = 1 - CFG.SLIP_FALLOFF_KEEP;
    return CFG.SLIP_FALLOFF_KEEP + decay * Math.exp(-(d - peak) / 10);
  }

  updateTireThermals(c, dt, ax, ay) {
    if (!c.tireTemp || c.tireTemp.length !== 4) {
      c.tireTemp = [CFG.TIRE_START_C, CFG.TIRE_START_C, CFG.TIRE_START_C, CFG.TIRE_START_C];
    }
    const speed = Math.max(Math.abs(c.speed || 0), 1);
    const lateralSlip = clamp(Math.abs(c.lateralSpeed || 0) / speed, 0, 1);
    const longitudinalSlip = clamp(Math.abs(c.wheelspin || 0), 0, 1);
    const brakeLoad = c.input && c.input.brake > 0 ? c.input.brake : 0;
    const load = clamp(Math.abs(ay) / 9.81, 0, 1.4);
    const work = clamp(0.10 + load * 0.34 + lateralSlip * lateralSlip * 1.35 + longitudinalSlip * 0.85 + brakeLoad * 0.22, 0, 2.8);
    const rise = CFG.TIRE_HEAT_RATE * work;
    const cool = (temp) => (temp - CFG.TIRE_AMBIENT_C) * CFG.TIRE_COOL_RATE;
    for (let i = 0; i < 4; i++) {
      c.tireTemp[i] = clamp(c.tireTemp[i] + (rise - cool(c.tireTemp[i])) * dt, CFG.TIRE_AMBIENT_C, CFG.TIRE_MAX_C);
    }
    const front = (c.tireTemp[0] + c.tireTemp[1]) * 0.5;
    const rear = (c.tireTemp[2] + c.tireTemp[3]) * 0.5;
    c.tireGripFront = this.tireGripFactor(front);
    c.tireGripRear = this.tireGripFactor(rear);
    c.tireGrip = (c.tireGripFront + c.tireGripRear) * 0.5;
    c.tireSlipHeat = work;
  }

  /**
   * 按"静态配重 + 纵向载荷转移 + 侧向转移惩罚"计算两轴的正压力与可用摩擦。
   *   delta_Fz = m·a_x·h / L              （加速 -> 后轴增压；制动 -> 前轴增压）
   *   轮胎载荷敏感性：容量 ∝ Fz^0.85       （正压力越大，单位摩擦越低但总容量更高）
   *   a_F_lim = muF·FzF / (m·LR/L)        前轴饱和对应的整车侧向加速度
   *   a_R_lim = muR·FzR / (m·LF/L)        后轴饱和对应的整车侧向加速度
   * 整车横向极限 = min(两轴)；横摆权限由前轴决定（前轮是转向力矩来源）。
   *
   * @param {number} ax 纵向加速度 m/s²（踩油门为正）
   * @param {number} ay 侧向加速度 m/s²（用上一步估计值）
   */
  axleState(c, ax, ay) {
    const m = CFG.MASS, g = 9.81, L = CFG.WHEELBASE, h = CFG.CG_H;
    const muSurf = this.surfaceMu(c);
    const hb = c.handbrake;

    const FzStatF = m * g * CFG.WEIGHT_FRONT;
    const FzStatR = m * g * (1 - CFG.WEIGHT_FRONT);
    // 气动下压力按前后平衡分配后叠加到轴荷上：
    // 这是"高速弯抓地暴涨"的物理来源，也是脏气流里抓地变差的原因。
    const down = c.downforce || 0;
    const FzAeroF = down * CFG.AERO_BALANCE_FRONT;
    const FzAeroR = down * (1 - CFG.AERO_BALANCE_FRONT);
    // 纵向转移量（限幅，避免极端工况把轴荷算成负数）
    const dFz = clamp((m * ax * h) / L * CFG.LOAD_TRANSFER_GAIN, -FzStatF * 0.55, FzStatR * 0.55);
    let FzF = Math.max(FzStatF * 0.25, FzStatF + FzAeroF - dFz);
    let FzR = Math.max(FzStatR * 0.25, FzStatR + FzAeroR + dFz);

    // 侧向转移惩罚：内侧轮先失去附着，整轴容量下降（非线性，故平方）
    const latRef = muSurf * g;
    const pen = 1 - 0.12 * clamp(Math.abs(ay) / Math.max(latRef, 1), 0, 1) ** 2;

    // 轮胎载荷敏感性（指数 0.85）
    const sens = (Fz, Fz0) => Math.pow(Fz / Fz0, 0.15);   // 容量 ∝ Fz^0.85 -> 等效系数
    const surfScale = muSurf / CFG.GRIP_ROAD;             // 草地等低附着路面同比缩放
    // 常规前后配比：前 2.6 / 后 2.4（规格值）
    const tireF = Number.isFinite(c.tireGripFront) ? c.tireGripFront : 1;
    const tireR = Number.isFinite(c.tireGripRear) ? c.tireGripRear : 1;
    const muF0 = CFG.GRIP_FRONT_NORMAL * surfScale * sens(FzF, FzStatF) * pen * tireF;
    const muR0 = CFG.GRIP_REAR_NORMAL * surfScale * sens(FzR, FzStatR) * pen * tireR;
    let muF = muF0;
    let muR = muR0;
    // 手刹动态突变：前轮 3.2（死死咬住沥青、严禁抱死）／后轮 0.45（完全失去侧向抗滑）
    if (hb > 0.001) {
      const muFHB = CFG.GRIP_FRONT_HANDBRAKE * surfScale * sens(FzF, FzStatF) * pen;
      const muRHB = CFG.GRIP_REAR_HANDBRAKE * surfScale * sens(FzR, FzStatR) * pen;
      muF = muF0 + (muFHB - muF0) * hb;
      muR = muR0 + (muRHB - muR0) * hb;
    }

    const LR = L * CFG.WEIGHT_FRONT;          // 质心到后轴
    const LF = L * (1 - CFG.WEIGHT_FRONT);    // 质心到前轴
    const aFlim = (muF * FzF) / (m * (LR / L));
    const aRlim = (muR * FzR) / (m * (LF / L));
    const aLatCap = Math.min(aFlim, aRlim);   // 先饱和的轴决定整车横向极限

    c.FzFront = FzF; c.FzRear = FzR;
    c.muFront = muF; c.muRear = muR;
    c.aLatFront = aFlim; c.aLatRear = aRlim;
    c.aLatCap = aLatCap;
    return aLatCap;
  }

  /* ---------------------------------------------------------------------- */
  /*  车辆驱动                                                               */
  /* ---------------------------------------------------------------------- */

  driveLocal(c, dt) {
    if (!this.racing) {
      // 发车前 / 结算后：冻结所有输入，车辆只能被重力与碰撞影响
      c.input.throttle = 0;
      c.input.brake = 0;
      c.input.handbrake = 0;
      c.input.steer = 0;
    } else if (c.finished) {
      // 规格 §三：任何车（玩家或 AI）冲线后**立即剥离手动输入**，改由内置
      // Pure Pursuit 循迹巡航接管：沿最优行车线以 50~60km/h 慢游，
      // 绝不急刹停在终点线上挡后车。玩家/AI 一视同仁（都走这条）。
      this.purePursuit(c, dt);
    } else if (c.auto) {
      this.autopilot(c, dt);
    }
    // #9 自动幽灵（横在赛道上 / 被连续撞击）—— 必须在 updateGhost 之前算，
    // 这样自动触发的幽灵时长当帧就能生效。
    this.updateAutoGhost(c, dt);
    // 幽灵化推进：复位后 3.5s 内关闭碰撞响应（规格：秒级复位，无冻结）
    this.updateGhost(c, dt);
    const n = c.roadNormal || this.track.nrm[c.trackIdx];
    const fwd = c.fwd;
    const left = c.lateralDir;      // 局部 +X（车身左侧轴）
    const hb = c.handbrake;

    // ---- 上一步的纵向加速度（用于载荷转移与档位）--------------------------
    const vF = c.vel.dot(fwd);
    const vS = c.vel.dot(left);
    const absV = Math.abs(vF);
    const axPrev = c.prevForwardSpeed !== undefined ? (vF - c.prevForwardSpeed) / dt : 0;
    c.axMeasured = axPrev;
    c.prevForwardSpeed = vF;

    // ---- 载荷转移 -> 两轴摩擦与整车横向极限 -------------------------------
    // 手刹/重刹时 delta_Fz = m·a_x·h/L 把重量压到前轴：前轮抓地暴涨、后轴暴降，
    // 于是车尾自然甩出（不再靠"魔法降摩擦"来制造漂移）。
    const muSurface = this.surfaceMu(c);
    this.updateTireThermals(c, dt, axPrev, c.ayPrev || 0);
    const aLatCap = this.axleState(c, axPrev, c.ayPrev || 0);
    const muF = c.muFront, muR = c.muRear;
    c.muSurface = muSurface;
    c.muEffective = aLatCap / 9.81;   // 整车等效摩擦（对外可观测）
    // 赛道外沙地陷阱：阻尼激增 / 推力衰减 / 限速 / 抓地崩溃（1s 平滑恢复）
    const offRoad = this.updateOffRoad(c, dt);

    // 取消赛道外 100 km/h 硬性锁速：改为温和滚阻 + 回轨牵引辅助（按提示词落地）
    if (offRoad > 0.001) {
      // 判断车头是否正在朝赛道中心线回归（lateral 与 roadSide 方向相反即朝向赛道内）
      // ⚠️ roadSide 由 groundConstraint 写入；构造后第一拍/未采样时可能未定义，必须先判空。
      const headingBackToTrack = !!c.roadSide && (
        (c.lateral > 0 && c.fwd.dot(c.roadSide) < -0.05) ||
        (c.lateral < 0 && c.fwd.dot(c.roadSide) > 0.05));
      // 抓地力保持在 0.78~0.90（回轨时提升至 0.90），绝不打滑空转陷车
      c.surfaceGripMul = headingBackToTrack ? 0.90 : 0.78;
      // 温和滚阻替代 100 km/h 锁速：仅施加与超速平方成正比的自然草地阻力
      const extraDrag = headingBackToTrack ? 0.35 : 0.65;
      c.body.velocity.x *= Math.exp(-extraDrag * dt);
      c.body.velocity.z *= Math.exp(-extraDrag * dt);
      // 辅助回轨横向牵引，消除路肩边缘卡车现象
      if (headingBackToTrack && c.roadSide) {
        const pullSign = c.lateral > 0 ? -1 : 1;
        c.body.velocity.x += c.roadSide.x * pullSign * 3.2 * dt;
        c.body.velocity.z += c.roadSide.z * pullSign * 3.2 * dt;
      }
    }

    // ---- 横向抓地（用载荷转移后的整车极限做速度消除）----------------------
    // 沙地时整车横向极限被压到 0.65（规格），入弯极易失控打转。
    //
    // 但这里原来**只有上限、没有下限**：aLatCap 一旦因载荷转移/打转崩塌到接近 0，
    // 侧向速度就几乎不被消耗 —— 这正是"冲出赛道或在草地上横移时会像在零摩擦力
    // 冰面上无休止朝一个方向平移"的根因（不是没做摩擦，是摩擦被算成了 0）。
    // 规格要求实装动摩擦下限：mu_slip 即便在草地/完全侧滑时也不得低于 0.45。
    //
    // ⚠ 规格 §四（本轮修正）：出界时**侧向**下限抬到 1.55，与纵向 0.65 解耦。
    // 纵向崩（驱动力上不去）但侧向够（能转向调头）—— 这才是"能开回赛道"的物理。
    //
    // 实现要点：出界侧向下限 = `MU_SLIP_FLOOR * OFFROAD_LAT_GRIP_K`。
    // **必须写成 MU_SLIP_FLOOR 的倍数**，不能用独立的绝对值常量 —— 否则调高
    // MU_SLIP_FLOOR（自检用来证明"下限真的接在钳位上"的方向性断言）会被这条
    // 绝对值上限吃掉，下限就变成一段没人读的死代码。倍数 3.45 = 1.55/0.45。
    const latFloorMu = CFG.MU_SLIP_FLOOR * (1 + (CFG.OFFROAD_LAT_GRIP_K - 1) * offRoad);
    // ---- VitaVehicle 风格滑移率抓地曲线 + 摩擦椭圆（2026-10-11 引入）----
    // 旧模型是"硬钳位"：容量以内的侧向速度全额消除、超容量全额保留 —— 抓地-滑移
    // 关系是一条不连续的阶跃。现在按轮胎物理曲线化：
    //   · slipGripFactor(slipDeg)：抓地随侧偏先升后降（峰值 ~8°），漂移滑而不甩崖；
    //   · 摩擦椭圆：驱动空转 / 重刹 / 手刹占用纵向摩擦容量，按 sqrt(1-µ·share²)
    //     削减侧向可用抓地 —— 重刹进弯转向变钝、大油门出弯推头，同一条物理定律。
    // 两者都作用在容量上；规格 §四 的动摩擦下限（latFloorMu）保持最外层兜底，
    // 完全侧滑时侧向 mu 依旧不低于 0.45 量级，"冰面平移"的回归路径不变。
    const slipDegNow = Math.atan2(Math.abs(vS), Math.max(Math.abs(vF), 0.6)) / DEG;
    const longUse = clamp(
      (c.wheelspin || 0) * 0.8 +
      (c.input && c.input.brake > 0 ? c.input.brake * 0.55 : 0) +
      (hb > 0.01 ? 0.35 : 0), 0, 1);
    const ellipseK = Math.sqrt(Math.max(0.05, 1 - CFG.FRICTION_ELLIPSE * longUse * longUse));
    const slipGripK = this.slipGripFactor(slipDegNow);
    c.slipGripK = slipGripK;     // 遥测：当前滑移曲线保留率
    c.fricEllipseK = ellipseK;   // 遥测：摩擦椭圆剩余份额
    const latCapEff = Math.max(
      Math.min(aLatCap * slipGripK * ellipseK, c.offRoadMu * 9.81),
      latFloorMu * 9.81);
    const maxLatDV = Math.max(latCapEff, 0.5) * dt;
    const dS = clamp(-vS, -maxLatDV, maxLatDV);
    if (dS !== 0) {
      c.body.velocity.x += left.x * dS;
      c.body.velocity.y += left.y * dS;
      c.body.velocity.z += left.z * dS;
    }
    c.slipRatio = Math.min(1, Math.abs(vS) / 9.0);
    c.ayPrev = Math.abs(vS) / Math.max(dt, 1e-3) * 0.02 + (c.ayPrev || 0) * 0.98;  // 平滑侧向加速度估计

    if (c.airborne) {
      c.steerAngle *= 0.98;
      return;
    }

    // ---- 动力 / 制动 / 阻力 ----------------------------------------------
    const inp = c.input;
    let force = 0;
    const slipDragCut = CFG.SLIP_DRAG_CUT * c.slip;
    // 极速上限只由"齿比/红线 + 尾流增益"决定。
    // 规格：废除出界硬钳速（原 OFFROAD_VMAX_KMH）—— 沙地靠物理阻滞，不靠脚本限速。
    const vmax = CFG.VMAX * (1 + CFG.SLIP_GAIN * c.slip);

    this.updateGearbox(c, dt);

    // 引擎：扭矩曲线 × 总传动比（换档切断、红线断油都在 driveForce 内处理）
    if (inp.throttle > 0) {
      // 规格 §四.1：出界后保留 80% 发动机推力（路面上 offRoad=0，系数恒为 1）。
      const torqueKeep = 1 - (1 - CFG.OFFROAD_TORQUE_KEEP) * offRoad;
      const want = this.driveForce(c, inp.throttle) * (1 - hb) * torqueKeep;
      // 牵引力上限：驱动力受**驱动轴纵向抓地**限制 —— 轮子抓不住就空转。
      // 沥青：2.4 × 后轴荷 ≈ 15.6kN > 引擎 11kN ⇒ 无影响。
      // 沙地：0.65 × 后轴荷 ≈ 4.2kN ⇒ 猛给油只打滑空转，动力上不去。
      // 这取代了原来"沙地硬削 40% 推力"的脚本逻辑：同一件事，但由摩擦推出来。
      const driveCap = c.offRoadMu * (c.FzRear || CFG.MASS * 9.81 * 0.48);
      c.wheelspin = want > driveCap ? clamp((want - driveCap) / Math.max(driveCap, 1), 0, 1) : 0;
      force += Math.min(want, driveCap);
    } else {
      c.wheelspin = 0;
    }
    // 脚刹 / 倒车（F = 制动扭矩 / 滚动半径，四轮）
    if (inp.brake > 0) {
      const brakeN = (CFG.BRAKE_TORQUE * 4) / CFG.WHEEL_RADIUS * inp.brake;
      if (vF > 0.4) force -= Math.min(brakeN, CFG.MASS * (vF / dt) * 0.9);
      else if (vF > -CFG.VMAX_REV) force -= CFG.REVERSE_FORCE * inp.brake;
    }
    // 手刹：后轮 5000N 制动力（不越过零点的钳位，避免静止顿挫）
    if (hb > 0.01 && absV > 0.05) {
      const rearBrake = CFG.HANDBRAKE_FORCE * hb;
      force -= Math.sign(vF) * Math.min(rearBrake, CFG.MASS * (absV / dt) * 0.9);
    }
    // 空气阻力  F_drag = 0.5·ρ·Cd·A·v²  （尾流区降 35% —— 写实数值，不是街机的 70%）
    force -= DRAG_K * (1 - slipDragCut) * vF * absV;
    // 滚动阻力（随实际轴荷增长：滚阻 ∝ 正压力，含气动压紧）
    // 规格：驶出沥青后滚阻**随出界轮数自然爬升**（offRoad 已按 0..1 渐进），
    // 保留原有动量向前滑行、平滑衰减 —— 而不是"一出界就踩刹车"。
    force -= (CFG.ROLL_K + CFG.ROLL_SAND_K * offRoad) *
      (CFG.MASS * 9.81 + (c.downforce || 0)) * Math.sign(vF);
    // 规格 §四.1：沙地软上限 60km/h —— 用**渐进式附加阻力**（不是硬钳速）。
    // 公式 F = k·m·max(0, v − vsoft)：车速低于软上限时阻力为 0（不影响起步与调头），
    // 超过后阻力线性增长，自然收敛在软上限附近。这样玩家大油门 + 打方向能迅速开回沥青。
    if (offRoad > 0.001 && vF > CFG.OFFROAD_SOFT_VMAX) {
      const over = vF - CFG.OFFROAD_SOFT_VMAX;
      force -= CFG.OFFROAD_DRAG_K * offRoad * CFG.MASS * over;
    }
    // 坡度重力分量
    force -= CFG.MASS * 9.81 * fwd.y;

    // 注意：cannon-es 的 applyForce(force, relativePoint) 第二参是**相对质心**作用点，
    // 传世界坐标会注入巨大扭矩（车会自己转圈）。这里只施加过质心的纯推力。
    _fv.set(fwd.x * force, fwd.y * force, fwd.z * force);
    c.body.applyForce(_fv, ZERO_POINT);

    // ---- 气动下压力 F_down = 0.5·ρ·Cl·A·v²（脏气流区削减 30%）-------------
    // 垂直压在底盘上 -> 通过 axleState 的载荷转移项动态提升轮胎正压力与过弯极限
    const downCut = 1 - CFG.SLIP_DOWNFORCE_CUT * c.slip;
    c.downforce = 0.5 * CFG.AIR_RHO * CFG.CL * CFG.FRONTAL_AREA * c.body.velocity.lengthSquared() * downCut;
    _fv.set(-n.x * c.downforce, -n.y * c.downforce, -n.z * c.downforce);
    c.body.applyForce(_fv, ZERO_POINT);

    // 极速硬限（吸尾流时按比例放宽）：等价于齿比/红线封顶
    if (vF > vmax) {
      const over = vF - vmax;
      c.body.velocity.x -= fwd.x * over;
      c.body.velocity.y -= fwd.y * over;
      c.body.velocity.z -= fwd.z * over;
    }

    // ---- 转向 ------------------------------------------------------------
    // 唯一的符号校准点：input.steer>0 = 车手想向右，
    // 而 steerAngle>0 = 前轮指向左侧（绕 +Y 正向）⇒ 目标角必须取负。
    //
    // 低速（< 100 km/h）转向渐进衰减：抑制低速急打方向时的车头猛甩。
    // 代码按提示词给定公式落地；`CFG.MAX_STEER` 在本工程即 `CFG.STEER_MAX_LOW`
    // （低速满幅前轮转角基准），符号沿用本工程已固化的 `-steerInput` 校准。
    const speedKmh = Math.abs(c.speed) * 3.6;
    const lowSpeedFactor = speedKmh < 100
      ? (0.42 + 0.58 * Math.pow(clamp(speedKmh / 100, 0, 1), 0.85))
      : 1.0;
    const highSpeedAtten = 1.0 / (1.0 + Math.max(0, speedKmh - 100) * 0.0085);
    const maxSteerRad = CFG.STEER_MAX_LOW * lowSpeedFactor * highSpeedAtten;

    // 转向角平滑速率：低于 100 km/h 时放缓转向速率，回正依然迅速
    const steerRate = (Math.abs(c.steerInput) > Math.abs(c.steerAngle / Math.max(maxSteerRad, 1e-3)))
      ? (speedKmh < 100 ? (5.2 + (8.5 - 5.2) * (speedKmh / 100)) : 8.5)
      : 12.0;
    c.steerAngle += (-c.steerInput * maxSteerRad - c.steerAngle) * (1 - Math.exp(-steerRate * dt));
    c.maxSteerNow = maxSteerRad;

    // 横摆权限由**前轴**决定（前轮才是转向力矩来源）：前轴载荷越大、摩擦越高，
    // 车头转得越多 -> 重刹/手刹时前轮咬地，车尾线性甩出，彻底消除入弯推头。
    // 横摆权限必须只看**前轴**：前轮才是转向力矩来源。
    // 上一版用了前后加权平均 μ，等于把已经崩塌的后轴 μ 也算进"能转多快"里，
    // 结果手刹时横摆被锁死 -> 车头转不动 = 玩家感知的"入弯严重推头"。
    let yawTarget = (vF * Math.tan(c.steerAngle)) / CFG.WHEELBASE;
    // 规格 §四：出界时前轴 μ 会崩到路面值以下，横摆权限随之锁死 ⇒ "方向盘打死也拐不回来"。
    // 这里给前轴 μ 一个与出界程度联动的下限（路面段不受影响，仍用真实 muF）。
    const muFYaw = offRoad > 0.001
      ? Math.max(muF, CFG.MU_SLIP_FLOOR * (1 + (CFG.OFFROAD_LAT_GRIP_K - 1) * offRoad))
      : muF;
    const yawGrip = (Math.max(muFYaw, 0.3) * 9.81 * 1.06) / Math.max(absV, 6);
    // ★ 低速横摆稳定性（用户报障："低速时车身过于灵活，像以车头为基准旋转，车尾甩来甩去"）
    // 根因：横摆完全由**运动学目标**驱动（前轮自行车模型），而侧向速度是在**质心**统一
    //      抵消的 —— 后轴不产生任何横摆力矩 ⇒ 横摆通道没有阻尼；低速时轮胎侧向力又小，
    //      于是车头像支点、车尾来回甩。
    // 做法①：目标横摆率还要受**后轴能否跟上**约束（后轴 μ·g / v），低速尤其明显。
    //   ⚠️ 但**手刹甩尾 / 大舵角**时不能压：那是玩家主动要旋转，后轴 μ 本来就被手刹
    //      压得很低，再按"后轴能否跟上"收窄会把漂移彻底锁死（实测把 C 段的漂移断言打红）。
    const wantRotate = hb > 0.1 || Math.abs(c.steerInput) > 0.6;
    const yawGripRear = (Math.max(muR, 0.3) * 9.81) / Math.max(absV, 3.5);
    const yawCap = wantRotate ? yawGrip : Math.min(yawGrip, yawGripRear);
    yawTarget = clamp(yawTarget, -yawCap, yawCap);

    // 手刹甩尾：对底盘施加与转向方向一致的**横摆角冲量**。
    // 前轮咬地充当旋转支点，车尾受惯性与横摆力矩直接甩出 -> 车头切入弯心。
    // 注意符号：steer>0 = 向右，而绕 +Y 正向 yaw = 向左，故取反号。
    const av0 = c.body.angularVelocity;
    if (hb > 0.01 && c.speedKmh > 20 && Math.abs(c.steerInput) > 0.05) {
      const dir = -Math.sign(c.steerInput) * hb;          // 与转向方向一致的旋转方向
      const yawImpulse = CFG.HANDBRAKE_YAW_ACCEL * dir * dt;
      // 只在横摆角速度尚未建立时施加（避免持续叠加导致打转失控）
      const curYawAlongN = av0.x * n.x + av0.y * n.y + av0.z * n.z;
      const room = clamp(CFG.YAW_MAX_ABSOLUTE - Math.abs(curYawAlongN), 0, CFG.YAW_MAX_ABSOLUTE);
      const add = clamp(yawImpulse, -room * 0.25, room * 0.25);
      av0.x += n.x * add; av0.y += n.y * add; av0.z += n.z * add;
    }
    yawTarget = clamp(yawTarget, -CFG.YAW_MAX_ABSOLUTE, CFG.YAW_MAX_ABSOLUTE);

    const av = this._v3.set(av0.x, av0.y, av0.z);
    const curYaw = av.dot(n);
    // 做法②：显式补一条**后轴横摆阻尼力矩**（∝ 横摆角速度），把车尾"按住"。
    //   低速系数大（轮胎本身给不出阻尼），高速时轮胎侧偏已提供阻尼，只做微调。
    const lowSpeedDamp = clamp(1.6 - absV / 22, 0, 1);          // v=0 → 1.0；v≥35m/s → 0
    //   手刹/大舵角时把阻尼几乎关掉（玩家要甩尾），只保留 15% 防止彻底失控打转。
    const dampScale = wantRotate ? 0.15 : 1;
    const yawDampAcc = -curYaw * CFG.YAW_DAMP_K * lowSpeedDamp * dampScale;
    const err = (yawTarget - curYaw) + yawDampAcc * dt;
    // 被撞扰动窗口内把横摆修正权限压到 20%：让刚体真正按碰撞力矩失控打转，
    // 由玩家反打救车（这才是 PIT 该有的结果）。窗口外恢复正常转向控制。
    const auth = c.yawDisturb > 0 ? CFG.YAW_DISTURB_AUTH : 1;
    const maxD = CFG.YAW_ACCEL * auth * (c.surface === 2 ? 0.42 : 1) * dt;
    const apply = clamp(err, -maxD, maxD);
    c.body.angularVelocity.x += n.x * apply;
    c.body.angularVelocity.y += n.y * apply;
    c.body.angularVelocity.z += n.z * apply;
  }

  /**
   * 侧偏角与漂移标记：
   *   Slip Angle = 车头朝向(纵向) 与实际速度方向的夹角 = atan2(|横向|, |纵向|)
   *   触发条件（规格）：> 18°  或  (按住手刹 且 车速 > 25km/h)
   * driftIntensity 0..1 供烟雾/胎痕强度使用。
   */
  updateDriftState(c, dt = 1 / 60) {   // dt 用于 #10 的被撞免罚宽限递减（默认值兼容旧调用）
    const vF = c.vel.dot(c.fwd);
    const vS = c.vel.dot(c.lateralDir);
    c.slipAngleDeg = Math.atan2(Math.abs(vS), Math.max(Math.abs(vF), 0.6)) / DEG;
    c.slipRatio = Math.max(c.slipRatio, Math.min(1, c.slipAngleDeg / 30));

    const bySlip = c.speedKmh > 15 ? clamp((c.slipAngleDeg - CFG.DRIFT_FADE_DEG) / 20, 0, 1) : 0;
    const byHand = (c.handbrake > 0.5 && c.speedKmh > CFG.DRIFT_MIN_KMH)
      ? clamp((c.speedKmh - CFG.DRIFT_MIN_KMH) / 45, 0, 1) * clamp(c.handbrake, 0, 1)
      : 0;
    c.driftIntensity = Math.max(bySlip, byHand);
    c.drifting = c.slipAngleDeg > CFG.DRIFT_SLIP_DEG || byHand > 0.02;
    // #10 被撞宽限递减
    if (c.hitGraceT > 0) c.hitGraceT = Math.max(0, c.hitGraceT - dt);
  }

  /** 四轮路面 -> 等效摩擦系数 + 出界判定 */
  surfaceMu(c) {
    const t = this.track;
    // ⚠️ 必须用**逐点**半宽：变宽赛道的标量 halfWidth 是最窄值（铃鹿 5.5m），
    //    用它判断"轮子在不在沥青上"会在主直道（实际 8m）把正常行驶判成压路肩。
    const hw = t.halfWidthAt ? t.halfWidthAt[c.trackIdx] : t.halfWidth;
    const cw = t.curbWidth;
    let sum = 0, asphalt = 0, grass = 0;
    const W = CFG.WHEEL;
    // ★ 逐轮数据（2026-09-30 新增）：轮位处的地面高度、是否压路肩。悬挂视觉与音效都靠它。
    //   之前这里只统计"轮子属于沥青/路肩/草地"用于算 μ，没有任何**高度**信息 ⇒
    //   视觉层无法让车轮跟着路肩起伏、车身也无法因压路肩而侧倾
    //   （用户报障："悬挂未与车辆成为一个整体…碾压路肩车身不会倾斜"）。
    if (!c.wheelGroundY) { c.wheelGroundY = [0, 0, 0, 0]; c.wheelCurb = [0, 0, 0, 0]; }
    let curbWheels = 0, curbHSum = 0;
    for (let i = 0; i < 4; i++) {
      const lx = W[i][0], lz = W[i][1];
      const wx = c.pos.x + c.lateralDir.x * lx + c.fwd.x * lz;
      const wz = c.pos.z + c.lateralDir.z * lx + c.fwd.z * lz;
      const wheelInfo = t.sample(wx, wz, c.trackIdx, c.pos.y, c.roadLayer);
      const lat = wheelInfo.lateral;
      const a = Math.abs(lat);
      const gi = wheelInfo.i;
      const wheelHw = t.halfWidthAt ? t.halfWidthAt[gi] : hw;
      const onCurb = (a > wheelHw && a <= wheelHw + cw);
      const curbH = onCurb ? Math.max(0, t.groundOffset(lat, gi)) : 0;
      // 前后轮分别取沿坡高程，不能把车中心高度复制给全部车轮。
      c.wheelGroundY[i] = wheelInfo.y;
      c.wheelCurb[i] = curbH;
      if (onCurb) { curbWheels++; curbHSum += curbH; }
      if (a <= wheelHw) { sum += CFG.GRIP_ROAD; asphalt++; }
      else if (a <= wheelHw + cw) { sum += CFG.GRIP_CURB; }
      else { sum += CFG.GRIP_GRASS; grass++; }
    }
    c.onAsphalt = asphalt;
    c.grassWheels = grass;
    c.curbWheels = curbWheels;
    // 压路肩的平均抬升量（供车身侧倾与音效使用；0 = 四轮都在平整路面）
    c.curbH = curbWheels ? curbHSum / curbWheels : 0;
    const mu = (sum / 4) / CFG.GRIP_ROAD;   // 归一化到 0..1 的抓地比例
    c.surface = asphalt === 4 ? 0 : (grass === 4 ? 2 : 1);
    return mu <= 0 ? CFG.BASE_MU_AIR : mu * CFG.GRIP_ROAD;
  }

  /**
   * 赛道外沙地/草地减速陷阱 —— **纯物理**版本（无脚本限速、无脚本削力）。
   * 规格：超过 2 个车轮脱离沥青后，只靠两件事阻滞动能：
   *   ① 抓地骤降：offRoadMu 由路面值平滑落到 0.65（侧向 + 纵向同一条）
   *   ② 滚阻爬升：driveLocal 里按 CFG.ROLL_SAND_K·offRoad 增加滚动阻力
   * 全轮回到沥青后 1.0 秒内平滑恢复。
   * offRoad 是 0..1 的平滑系数，所有惩罚量都按它插值，避免进出草地时手感跳变。
   *
   * 注意：**底盘线性阻尼恒为 0**。上一版在沙地叠了 0.16 的线性阻尼，它会与
   * 滚阻重复计阻力，实测把沙地全油门速度压到 0.8km/h —— 车直接陷死开不出来。
   * 现在只保留"滚阻 + 抓地崩溃"，沙地仍可深踩油门慢慢爬回赛道。
   */
  updateOffRoad(c, dt) {
    const inTrap = c.grassWheels >= CFG.OFFROAD_MIN_WHEELS;
    if (inTrap) {
      c.offRoad = Math.min(1, c.offRoad + dt / 0.15);        // 陷入很快
    } else {
      c.offRoad = Math.max(0, c.offRoad - dt / CFG.OFFROAD_RECOVER_T);  // 1.0s 平滑恢复
    }
    const k = c.offRoad;
    c.body.linearDamping = 0;                                // 阻力全部显式建模，不叠全局阻尼
    // 沙地抓地崩溃（0.65）；路面端就是当前载荷转移解出的等效摩擦
    c.offRoadMu = k > 0.001
      ? (c.muEffective + (CFG.OFFROAD_FRICTION_SLIP - c.muEffective) * k)
      : c.muEffective;
    return k;
  }

  /* ---------------------------------------------------------------------- */
  /*  远端车辆：网络位姿驱动的真正 KINEMATIC 代理                           */
  /* ---------------------------------------------------------------------- */

  /**
   * A remote car is a Cannon kinematic body: the network owns its pose and
   * velocity, while dynamic local cars still see its Box in the contact
   * solver. There is no proportional velocity servo or distance threshold;
   * the reported target is the pose presented to the next solver step.
   */
  steerRemote(c, dt) {
    const tgt = c.netTarget;
    if (!tgt) {
      c.body.velocity.set(0, 0, 0);
      c.body.angularVelocity.set(0, 0, 0);
      return;
    }
    const b = c.body;
    if (tgt.rst) {
      b.velocity.set(0, 0, 0);
      b.angularVelocity.set(0, 0, 0);
      return;
    }
    b.position.set(tgt.x, tgt.y, tgt.z);
    b.quaternion.set(tgt.qx, tgt.qy, tgt.qz, tgt.qw);
    b.quaternion.normalize();
    b.velocity.set(tgt.vx || 0, tgt.vy || 0, tgt.vz || 0);
    b.angularVelocity.set(0, 0, 0);
    b.aabbNeedsUpdate = true;
    b.updateAABB();
  }

  /* ---------------------------------------------------------------------- */
  /*  偏心碰撞力矩（Off-Center Impact / PIT 美式截停）                        */
  /* ---------------------------------------------------------------------- */

  /**
   * 监听 chassisBody 的 'collide' 事件，按接触点的**杠杆臂**产生绕 Y 轴的角冲量。
   *
   * cannon 的 collide 事件只给接触方程、没有解算后的冲量，因此这里按一维弹性碰撞
   * 冲量公式现算：      J = (1+e)·|vn| / (1/m₁ + 1/m₂)
   * 冲量方向沿接触法线（用相对速度定向，避免依赖 ni 的朝向约定）。
   * 力矩只需 Y 分量：    (r × J)_y = r.z·J.x − r.x·J.z
   * —— 规格里写的是 (r.x·J.z − r.z·J.x)，那是 (r×J)_y 的反号。这里用数学正确的形式，
   *    并用"右后角被横向推 → 车头应向右甩"验算过符号。
   *
   * PIT 判定：接触点落在对方**车尾侧翼**（质心后方且横向偏出），且对方在我方前方、
   * 接近速度足够 —— 此时用 PIT_TORQUE_GAIN(1.5) 加成，造成剧烈横摆失控。
   *
   * 冲量先累加、在 world.step 之后再施加：避免在求解器迭代中途改动角速度。
   */
  onCarCollide(car, e) {
    const other = e.body;
    if (!other || !other.__carId) return;
    const oc = this.byId.get(other.__carId);
    if (!oc || oc === car) return;
    if (car.lastCollideStep === this.stepCount) return;   // 每物理步每车只处理一次
    car.collideHits++;
    if (car._impactNoticeStep !== this.stepCount) {
      car._impactNoticeStep = this.stepCount;
      if (this.onIncident) this.onIncident(car, { cause: '撞击', kind: 'car', other: oc.name });
    }
    car.lastCollideStep = this.stepCount;

    const contact = e.contact;
    if (!contact || !contact.ri) return;
    const A = car.body, B = other;
    // 接触点世界坐标（ri 是相对 A 质心的接触点）
    const cpX = A.position.x + contact.ri.x;
    const cpY = A.position.y + contact.ri.y;
    const cpZ = A.position.z + contact.ri.z;
    // 杠杆臂
    const raX = cpX - A.position.x, raY = cpY - A.position.y, raZ = cpZ - A.position.z;
    const rbX = cpX - B.position.x, rbY = cpY - B.position.y, rbZ = cpZ - B.position.z;
    // 接触点处相对速度（含转动贡献）
    const wa = A.angularVelocity, wb = B.angularVelocity;
    const va = A.velocity, vb = B.velocity;
    const vax = va.x + (wa.y * raZ - wa.z * raY);
    const vay = va.y + (wa.z * raX - wa.x * raZ);
    const vaz = va.z + (wa.x * raY - wa.y * raX);
    const vbx = vb.x + (wb.y * rbZ - wb.z * rbY);
    const vby = vb.y + (wb.z * rbX - wb.x * rbZ);
    const vbz = vb.z + (wb.x * rbY - wb.y * rbX);
    const rvx = vax - vbx, rvy = vay - vby, rvz = vaz - vbz;

    let nx = contact.ni ? contact.ni.x : 0;
    let ny = contact.ni ? contact.ni.y : 1;
    let nz = contact.ni ? contact.ni.z : 0;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // 接触法线由 cannon 给出，指"把 A 推离 B"的方向；两者接近时 rv·n < 0。
    const rvn = rvx * nx + rvy * ny + rvz * nz;
    // 规格（ForzaPhysicsNetSafety::ResolveNetworkContact 第一条）：
    // **正在自然分离的接触对不做任何排斥解算**，直接返回。
    // 原代码与此相反 —— 它把法线翻转后再按"接近"处理，等价于给正在分离的两车
    // 施加一个吸引力，表现为车贴在一起"粘住"、反复小弹跳。
    if (rvn > 0) return;
    const closing = Math.abs(rvn);
    if (closing < 0.15) return;                       // 几乎无相对速度，忽略
    const approach = closing;                          // 法向相对速度（撞击强度）

    // ---- 方案 C：防跳板法线平整化（规格 §1：无条件，不含"小误差放行门"）----
    // 护栏/护墙是垂直面；法线一旦带 +Y 分量，水平动能就被重定向成垂直动能 -> 骑上护栏腾空。
    const rn = redirectNormal(nx, ny, nz);
    if (!rn) return;                                  // 纯垂直：不是"墙"，交给地面约束
    nx = rn.x; ny = rn.y; nz = rn.z;

    // ---- 规格 §4：外壳碰擦 -> 触发悬挂解耦窗口 ----
    // 在冲量真正施加**之前**登记，这样本步随后的 groundConstraint 就会用锁定后的
    // 行程上限算弹簧力，冲量来不及把弹簧压到底。
    car.suspLockT = Math.max(car.suspLockT, CFG.SUSP_LOCK_T);
    oc.suspLockT = Math.max(oc.suspLockT, CFG.SUSP_LOCK_T * 1.4);   // 被撞方多锁一会
    car.shellHits = (car.shellHits || 0) + 1;

    const invMa = A.invMass, invMb = B.invMass;
    const invIa = car.remote ? 0 : 1 / (car.inertiaY || 1), invIb = oc.remote ? 0 : 1 / (oc.inertiaY || 1);
    const eRest = restitutionFor(closing);

    // ★ 严谨刚体冲量解算（2026-09-30 重写）
    //   用户报障："车辆侧面碰撞会被弹开完全不符合物理；要按碰撞角度、力度与分力做严谨计算"。
    //   旧实现的两处不严谨：
    //     ① 有效质量只算 1/ma + 1/mb —— **漏掉转动项**。侧面/角落碰撞时接触点离质心很远，
    //        真实的广义质量远小于车重，旧公式算出的冲量偏大 ⇒ 车被"弹开"，而且横摆还要再乘
    //        一个凭经验拍的系数（IMPACT_TORQUE_GAIN / PIT_TORQUE_GAIN），完全不是物理。
    //     ② 只算法向、没有**切向摩擦冲量** ⇒ 斜碰撞不会产生"擦着走"的分力。
    //   现在按刚体动力学求解（本项目惯量模型是绕 Y 的横摆标量，故在水平面内解）：
    //     jn = -(1+e)·vn / denom_n ，denom_n = 1/ma + 1/mb + (rA×n)²/Ia + (rB×n)²/Ib
    //     jt = clamp(-vt / denom_t, ±μ·jn)            （库仑摩擦锥）
    //     v += j/m ；ωy += (r×j)/I                    （力矩来自冲量本身，无魔法系数）
    //   与 cannon 的分工：cannon 的速度求解器仍负责"不许穿模"，这里改为**目标速度修正** ——
    //   只削掉"超出物理应有的分离速度"那部分（e≈0 时目标就是"不再分离"），因此不会像
    //   旧实现那样与 cannon 叠加成两倍冲量把人弹飞。
    const applyImp = (body, invM, invI, jx, jy, jz, rx, ry, rz) => {
      body.velocity.x += invM * jx;
      body.velocity.y += invM * jy;
      body.velocity.z += invM * jz;
      body.angularVelocity.y += (rz * jx - rx * jz) * invI;
    };

    // 接触点处当前相对速度（cannon 解算之后实测）
    const curVax = va.x + (wa.y * raZ - wa.z * raY);
    const curVay = va.y + (wa.z * raX - wa.x * raZ);
    const curVaz = va.z + (wa.x * raY - wa.y * raX);
    const curVbx = vb.x + (wb.y * rbZ - wb.z * rbY);
    const curVby = vb.y + (wb.z * rbX - wb.x * rbZ);
    const curVbz = vb.z + (wb.x * rbY - wb.y * rbX);
    const curRv = (curVax - curVbx) * nx + (curVay - curVby) * ny + (curVaz - curVbz) * nz;
    const targetRv = eRest * closing;              // 物理应有的分离速度（塑性 e=0 → 0）
    const excess = curRv - targetRv;
    let jn = 0;
    if (excess > 0.01) {
      // r×n 的横摆分量（与力矩口径一致：tq = r_z·j_x − r_x·j_z）
      const raCn = raZ * nx - raX * nz;
      const rbCn = rbZ * nx - rbX * nz;
      const denomN = invMa + invMb + raCn * raCn * invIa + rbCn * rbCn * invIb;
      jn = Math.min(excess / denomN, CFG.IMPULSE_MAX_NS);
      // 削掉多余的分离速度：A 受 −n·jn，B 受 +n·jn
      applyImp(A, invMa, invIa, -jn * nx, -jn * ny, -jn * nz, raX, raY, raZ);
      applyImp(B, invMb, invIb, jn * nx, jn * ny, jn * nz, rbX, rbY, rbZ);
    }
    // ---- 切向摩擦冲量（库仑锥）：斜碰撞产生真实的"擦着走"分力与自转
    if (jn > 1) {
      const vtx = (curVax - curVbx) - curRv * nx;
      const vtz = (curVaz - curVbz) - curRv * nz;
      const vtLen = Math.hypot(vtx, vtz);
      if (vtLen > 0.05) {
        const tx = -vtx / vtLen, tz = -vtz / vtLen;
        const raCt = raZ * tx - raX * tz;
        const rbCt = rbZ * tx - rbX * tz;
        const denomT = invMa + invMb + raCt * raCt * invIa + rbCt * rbCt * invIb;
        const maxJt = CFG.CAR_CONTACT_FRICTION * jn;
        const jt = Math.min(vtLen / denomT, maxJt);
        applyImp(A, invMa, invIa, jt * tx, 0, jt * tz, raX, raY, raZ);
        applyImp(B, invMb, invIb, -jt * tx, 0, -jt * tz, rbX, rbY, rbZ);
        car.contactFriction = jt;
      }
    }
    // 记录本次碰撞的物理量（供 HUD 诊断/测试断言使用）
    car.lastImpact = { closing, jn, e: eRest, nx, ny, nz };
    oc.lastImpact = { closing, jn, e: eRest, nx: -nx, ny: -ny, nz: -nz };
    // 冲击强度 → 悬挂解耦窗口（本条保留：过大冲量会穿模）
    car.suspLockT = Math.max(car.suspLockT, CFG.SUSP_LOCK_T);
    oc.suspLockT = Math.max(oc.suspLockT, CFG.SUSP_LOCK_T * 1.4);

    // PIT 判定**仅**用于提示与处罚，不再用它放大冲量（力矩已由 r×j 给出）。
    {
      const bFwd = oc.fwd;
      const relABx = A.position.x - B.position.x;
      const relABz = A.position.z - B.position.z;
      const aheadOnB = (relABx * bFwd.x + relABz * bFwd.z);
      const latBetween = Math.abs(relABx * oc.lateralDir.x + relABz * oc.lateralDir.z);
      const rearOnB = (rbX * bFwd.x + rbZ * bFwd.z);
      const isPit = rearOnB < -0.5 && latBetween > 0.7 && aheadOnB < 0 && closing > CFG.PIT_MIN_CLOSING;
      if (isPit) {
        oc.pitHits++;
        oc.setAlert('被别车 · PIT', 'warn', 2.0);
        oc.pendingYaw = (oc.pendingYaw || 0) + clamp(CFG.PIT_YAW_BONUS, 0, CFG.YAW_IMPULSE_CAP);
      }
    }
    car.yawDisturb = Math.max(car.yawDisturb, CFG.YAW_DISTURB_T * 0.5);
    oc.yawDisturb = Math.max(oc.yawDisturb, CFG.YAW_DISTURB_T);
    // ★ #10：碰撞双方都登记"被撞宽限"（这期间各自的出界裁决按事故免罚），
    //   并累计"被撞次数"（供 #9 的自动幽灵使用）。撞击方保留 ram 处罚判定。
    const grace = closing > 2.0 ? CFG.HIT_GRACE_T : CFG.HIT_GRACE_T * 0.5;
    car.hitGraceT = Math.max(car.hitGraceT || 0, grace);
    oc.hitGraceT = Math.max(oc.hitGraceT || 0, grace);
    oc.recentHits = (oc.recentHits || 0) + 1;
    oc.recentHitsT = 0;

    // ---- 切向剐蹭：法向相对速度低于阈值时，登记为"粘性软接触" ----
    // 关键：cannon 的 collide 事件**只在接触建立的那一步**派发，持续性接触不再触发；
    // 而"剐蹭弹开"恰恰发生在接触后的第 1 步（重叠量被接触刚度弹出）。
    // 因此这里登记一个带生命周期的软接触对，随后若干步持续吸收法向弹开速度。
    if (approach > 0.05 && approach < CFG.SOFT_CONTACT_MS) {
      const key = Math.min(car.id, oc.id) + '-' + Math.max(car.id, oc.id);
      this.softPairs.set(key, {
        a: car, b: oc, nx, ny, nz,
        ttl: CFG.SOFT_CONTACT_TTL,
      });
      car.softHit = true;
      this._stepTouched = 1;   // 供养 clampCollisionImpulse：本步确有碰撞
    }
  }

  /**
   * 护栏 / 桥栏 / 桥墩（静态刚体）碰撞入口 —— 规格 §4 悬挂解耦的第二条触发路径。
   *
   * 为什么车-墙必须有独立入口：静态体没有 `__carId`，`onCarCollide` 在开头就 return 了。
   * 但"撞墙被弹飞"恰恰是最强的那个工况 —— 200km/h 撞墙所需冲量 ≈ 7.7e4 N·s，
   * 是撞车（≈3.6e4）的两倍多，弹簧被压到底的风险最高。
   *
   * 这里**不做**位置/速度修正（那两条由 cannon 速度相 + projectPenetration 位置相
   * 负责），只做一件事：按下悬挂解耦窗口。职责单一，便于静态守卫断言。
   */
  onBarrierCollide(car, e) {
    const other = e.body;
    if (!other || other.__carId !== undefined) return;   // 有 __carId = 是车，走 onCarCollide
    if (other.__roadHeightfield || other.__barrier === false) return; // Heightfield/地面不是护栏
    if (e.target && e.target !== car.body) return;        // 事件冒泡去重：只处理以本车为主体的
    car.suspLockT = Math.max(car.suspLockT, CFG.SUSP_LOCK_T);
    car.shellHits = (car.shellHits || 0) + 1;
    car.barrierHits = (car.barrierHits || 0) + 1;
    if (car._impactNoticeStep !== this.stepCount) {
      car._impactNoticeStep = this.stepCount;
      if (this.onIncident) this.onIncident(car, { cause: '撞击', kind: 'wall' });
    }
    this._stepTouched = 1;   // 供养 clampCollisionImpulse：本步确有撞墙接触
  }

  /**
   * 护栏接触**导流偏转**（规格 §一：消灭吸墙卡死）。
   *
   * 为什么需要它：`projectPenetration()` 只负责"把车挪出来"，但挪出来之后
   * 车头仍朝墙 —— 玩家持续给油就永远在撞墙、撞完被推回、再撞，表现为"吸在墙上"。
   * 本函数在**速度通道**上把动量导流到护栏切线方向，并施加绕 Y 的偏摆力矩把车头
   * 逐渐摆正到行驶方向，于是贴着护栏也能顺畅滑走。
   *
   * 两条分支（theta = velocity 与 tangent 的夹角）：
   *   · theta <  45°（浅角刮擦）：消除法向弹性分量 + 切向投影重构 + 正向偏摆力矩
   *   · theta >= 45°（深角撞墙）：吸收 85% 法向冲量 + 反扭矩甩尾（绝不被墙吸住）
   *
   * 在 `world.step()` 之后、`projectPenetration()` 之前调用：
   * 先改速度（决定后续动量走向），再修几何位置。顺序反了会被几何修正覆盖观感。
   */
  barrierContactNormal(eq) {
    const bi = eq && eq.bi, bj = eq && eq.bj, n = eq && eq.ni;
    if (!bi || !bj || !n) return null;
    const biIsCar = bi.__carId !== undefined;
    const bjIsCar = bj.__carId !== undefined;
    if (biIsCar === bjIsCar) return null;            // 车-车或双静态不归护栏层处理
    const carBody = biIsCar ? bi : bj;
    const barrierBody = biIsCar ? bj : bi;
    if ((barrierBody.invMass || 0) !== 0) return null;
    if (barrierBody.__barrier === false) return null;

    // cannon-es 的 ni 从 bi 指向 bj。车辆在 bi 端时必须反向，
    // 统一得到“护栏 -> 车”的水平外法线，后续推离/切向/偏摆才有一致符号。
    let nx = biIsCar ? -n.x : n.x;
    let nz = biIsCar ? -n.z : n.z;
    const nl = Math.hypot(nx, nz);
    if (nl < CFG.NORMAL_FLAT_EPS) return null;       // 纯垂直接触交给地面约束
    nx /= nl; nz /= nl;
    return { carBody, barrierBody, nx, nz };
  }

  applyBarrierDeflection(dt) {
    const cs = this.world.contacts;
    const stepId = this.stepCount || 0;
    if (!cs || !cs.length) {
      for (const c of this.cars) c._wallContact = false;
      return;
    }

    for (const c of this.cars) {
      if (c._suctionDone && c._suctionDone.size) c._suctionDone.clear();
    }

    for (let k = 0; k < cs.length; k++) {
      const eq = cs[k];
      const bi = eq.bi, bj = eq.bj;
      if (!bi || !bj) continue;

      const contact = this.barrierContactNormal(eq);
      if (!contact) continue;
      const { carBody, nx, nz } = contact;
      const car = this.byId ? this.byId.get(carBody.__carId) : null;
      if (!car || car.remote) continue;

      // 低速主动脱离只在低速窗口生效，高速接触交给正常导流和位置投影。
      const speedKmh = Math.hypot(carBody.velocity.x, carBody.velocity.z) * 3.6;
      const barrierBody = bi.__carId !== undefined ? bj : bi;
      if (speedKmh < CFG.ANTI_SUCTION_KMH) {
        if (!car._suctionDone) car._suctionDone = new Set();
        const sKey = (carBody.id | 0) + ':' + (barrierBody.id | 0);
        if (!car._suctionDone.has(sKey)) {
          car._suctionDone.add(sKey);
          carBody.position.x += nx * CFG.ANTI_SUCTION_LOW_PUSH_M;
          carBody.position.z += nz * CFG.ANTI_SUCTION_LOW_PUSH_M;
          carBody.aabbNeedsUpdate = true;
        }
      }

      // Multiple contact equations share one manifold. Resolve the velocity
      // response once per car per physics step.
      if (car._barrierDeflectStep === stepId) continue;
      car._barrierDeflectStep = stepId;
      car._wallContactStep = stepId;

      const v = carBody.velocity;
      const preVx = Number.isFinite(car.preBarrierVx) ? car.preBarrierVx : v.x;
      const preVz = Number.isFinite(car.preBarrierVz) ? car.preBarrierVz : v.z;
      const speed = Math.hypot(preVx, preVz);
      if (speed < CFG.GUIDANCE_MIN_SPEED) continue;

      let tx = -nz, tz = nx;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      if (tx * preVx + tz * preVz < 0) { tx = -tx; tz = -tz; }

      const wall = this.gameMode === 'horizon'
        ? {
          shallowDeg: CFG.WALL_SHALLOW_DEG,
          scrapeMin: 0.025, scrapeMax: 0.055,
          hitMin: 0.08, hitMax: 0.22,
          scrapeDrag: 0.006, hitDrag: 0.12,
        }
        : {
          shallowDeg: CFG.WALL_SHALLOW_DEG,
          scrapeMin: CFG.WALL_SCRAPE_LOSS_MIN, scrapeMax: CFG.WALL_SCRAPE_LOSS_MAX,
          hitMin: CFG.WALL_HIT_LOSS_MIN, hitMax: CFG.WALL_HIT_LOSS_MAX,
          scrapeDrag: CFG.WALL_SCRAPE_DRAG, hitDrag: CFG.WALL_HIT_DRAG,
        };
      const fresh = stepId - (car._wallLastContactStep ?? -Infinity) >
        Math.ceil(CFG.WALL_CONTACT_GAP_T / Math.max(dt, 1e-4));
      car._wallLastContactStep = stepId;
      car._wallContact = true;

      // ★ 方案 A：按**入射角**分档处置切向动量（恢复系数恒为 0：法向分量一律丢弃）
      //   theta = 速度与墙面的夹角（0° = 完全贴着墙走，90° = 正面撞墙）
      const normalShare = clamp(Math.abs(preVx * nx + preVz * nz) / speed, 0, 1);
      const thetaDeg = Math.asin(normalShare) * 180 / Math.PI;
      const shallow = thetaDeg < wall.shallowDeg;
      if (fresh && this.gameMode === 'fm8' && car.isLocal && speedKmh >= 35 && !shallow) {
        const cooldownSteps = Math.ceil(CFG.WALL_PENALTY_COOLDOWN_T / Math.max(dt, 1e-4));
        const lastPenaltyStep = car._wallPenaltyStep ?? -Infinity;
        if (stepId - lastPenaltyStep >= cooldownSteps) {
          const angleK = clamp((thetaDeg - wall.shallowDeg) / (90 - wall.shallowDeg), 0, 1);
          const speedK = clamp((speedKmh - 35) / 120, 0, 1);
          const severity = clamp(angleK * 0.7 + speedK * 0.3, 0, 1);
          const sec = CFG.WALL_PENALTY_MIN +
            (CFG.WALL_PENALTY_MAX - CFG.WALL_PENALTY_MIN) * severity;
          car._wallPenaltyStep = stepId;
          car.addPenalty(sec, 'wall');
        }
      }
      let keep;
      const lowSpeedKeep = speedKmh < CFG.ANTI_SUCTION_KMH
        ? Math.max(CFG.GUIDANCE_TANGENT_KEEP, CFG.DEFLECT_TANGENT_KEEP) : 0;
      if (fresh) {
        // 首次接触：一次性扣（浅角 6~12% / 深角 18~45%，随角度线性）
        if (shallow) {
          const k = thetaDeg / wall.shallowDeg;
          keep = 1 - (wall.scrapeMin + (wall.scrapeMax - wall.scrapeMin) * k);
        } else {
          const k = clamp((thetaDeg - wall.shallowDeg) / (90 - wall.shallowDeg), 0, 1);
          keep = 1 - (wall.hitMin + (wall.hitMax - wall.hitMin) * k);
        }
      } else {
        // 持续接触：按 dt 缩放的粘滞衰减（浅角几乎不掉速，能一路顺墙滑走）
        const drag = shallow ? wall.scrapeDrag : wall.hitDrag;
        keep = clamp(1 - drag * dt, 0, 1);
      }
      keep = Math.max(keep, lowSpeedKeep);
      const tangentSpeed = Math.max(0, preVx * tx + preVz * tz) * keep;
      v.x = tx * tangentSpeed;
      v.z = tz * tangentSpeed;

      // 车头修正不能按“法线方向”硬扭，否则擦墙时车头会被推向墙内。以
      // 碰撞前切向速度为目标航向，按入射法向分量做分力衰减：浅角刮擦时
      // 快速把车头拉回速度方向；大角度撞击只保留一部分修正，避免车头
      // 被瞬间甩向护栏，同时仍会沿切向平滑带出碰撞点。
      if (car.forwardSpeed > 0.4 && car._barrierYawStep !== stepId) {
        car._barrierYawStep = stepId;
        const q = carBody.quaternion;
        const fwdX = 2 * (q.x * q.z + q.w * q.y);
        const fwdZ = 1 - 2 * (q.x * q.x + q.y * q.y);
        const fwdLen = Math.hypot(fwdX, fwdZ) || 1;
        const fx = fwdX / fwdLen, fz = fwdZ / fwdLen;
        const headDot = clamp(fx * tx + fz * tz, -1, 1);
        const headCross = clamp(fz * tx - fx * tz, -1, 1);
        const headingError = Math.atan2(headCross, headDot);
        const shallowCut = Math.sin(CFG.WALL_SHALLOW_DEG * Math.PI / 180);
        const shallowY = normalShare < shallowCut;
        // ⚠️ 必须**覆盖**横摆角速度，而不是"缓动逼近"：护栏接触期间 cannon 的接触冲量
        //    会持续给车体注入自转力矩（接触点在角落、力臂很长），缓动逼近根本压不住 ——
        //    实测车头夹角从 12° 一路涨到 66°，就是用户看到的"被摩擦力拉住产生车身旋转"。
        //    覆盖成"顺墙所需"的横摆后：车头只会平滑地顺着墙走，且**永不**超过上限。
        const responseT = shallowY ? 0.10 : 0.30;   // 时间常数越小、回正越快（用户：修正太小看不见）
        const targetYaw = clamp(headingError / responseT,
          -CFG.WALL_STRAIGHTEN_MAX, CFG.WALL_STRAIGHTEN_MAX);
        carBody.angularVelocity.y = targetYaw;
      }

      car.deflectT = CFG.YAW_DISTURB_T;
      car.suspLockT = Math.max(car.suspLockT, CFG.SUSP_LOCK_T);
      car.slideOnBarrier = true;
      car.barrierHits = (car.barrierHits || 0) + 1;
      this._stepTouched = 1;
    }

    for (const c of this.cars) {
      if (c._wallContactStep !== stepId) c._wallContact = false;
    }
  }

  /**
   * 规格 §四：护栏接触的**几何防吸入**收尾。
   *
   * 速度投影与车头修正统一由 applyBarrierDeflection 完成；本函数只负责
   * 每个子步末的几何防吸入：penetrationDepth > 0.005m 时沿外法线平移
   * (penetrationDepth + 0.03m)。速度与角速度在这里一律不改写，避免两个
   * 后处理层互相覆盖导致反向旋转或把车吸回墙里。
   */
  applyBarrierGuidance(dt) {
    const cs = this.world.contacts;
    if (!cs || !cs.length) return;

    for (let k = 0; k < cs.length; k++) {
      const eq = cs[k];
      const bi = eq.bi, bj = eq.bj;
      if (!bi || !bj) continue;

      const contact = this.barrierContactNormal(eq);
      if (!contact) continue;
      const { carBody, nx, nz } = contact;
      const car = this.byId ? this.byId.get(carBody.__carId) : null;
      if (!car || car.remote) continue;

      const pen = (typeof eq.__lastPenetration === 'number') ? eq.__lastPenetration : 0;
      if (pen <= 0.005) continue;

      if (!car._guidanceDone) car._guidanceDone = new Set();
      const gKey = (bi.id | 0) + ':' + (bj.id | 0);
      if (car._guidanceDone.has(gKey)) continue;
      car._guidanceDone.add(gKey);

      const push = pen + CFG.GUIDANCE_OUT_EPS;
      carBody.position.x += nx * push;
      carBody.position.z += nz * push;
      carBody.aabbNeedsUpdate = true;
    }

    for (const c of this.cars) {
      if (c._guidanceDone && c._guidanceDone.size) c._guidanceDone.clear();
    }
  }

  /**
   * 软接触的速度吸收（world.step 之后调用，每步都对存活的对做一次）。
   * 只削减"正在分离"的法向速度分量（不碰接近分量，否则会互相穿透），
   * 用动量守恒的冲量形式施加：   J = k·v_rel / (1/mA + 1/mB)
   */
  /**
   * 方案 A：Split Impulse 分离位置投影。
   * 必须插在 `world.step()` 之后、地面约束之前（顺序颠倒会被地面约束覆盖掉）。
   *
   * 与旧做法的本质区别：位置修正用**伪速度**推出，**只改 position，绝不写回 velocity**。
   * 旧做法把 biasVel 加进 Δv，物理含义是"穿透越深、白送给车的动能越多" -> 撞深了必被弹飞。
   *
   * 这条通道同时覆盖**车 vs 车**与**车 vs 静态体（护栏）**两条路径：
   * 静态体 invMass === 0，天然只推车、不推它。
   */
  projectPenetration(dt) {
    const cs = this.world.contacts;
    if (!cs || !cs.length) return;
    let maxPush = 0;                       // 本步最大实际位移（遥测）
    for (let k = 0; k < cs.length; k++) {
      const eq = cs[k];
      const bi = eq.bi, bj = eq.bj;
      if (!bi || !bj) continue;
      if (bi.__carId === undefined && bj.__carId === undefined) continue;   // 与车无关
      const n = eq.ni;
      if (!n) continue;

      // 穿透深度：优先用补丁实时记录的 `__lastPenetration`（它来自 g = n·Δ，
      // 与 cannon 内部同源、更可靠）；退化时回落到 penetrationVec 投影。
      let pen = (typeof eq.__lastPenetration === 'number') ? eq.__lastPenetration
        : (eq.penetrationVec
            ? Math.abs(eq.penetrationVec.x * n.x + eq.penetrationVec.y * n.y + eq.penetrationVec.z * n.z)
            : 0);
      if (pen < CFG.PEN_SLOP) continue;                    // 容差内不动，防抖

      const invI = bi.invMass || 0, invJ = bj.invMass || 0;
      const invSum = invI + invJ;
      if (invSum < 1e-6) continue;                         // 两个静态体，跳过

      // 法线同样做防跳板平整化：位置修正也不该有垂直分量
      const rn = redirectNormal(n.x, n.y, n.z);
      if (!rn) continue;                                   // 纯垂直 -> 交给地面约束

      // ── 规格 §3：单子步最大推开 **位移** 0.03m（不再是"名义速度×dt"）──
      // 用位移而非速度的好处：与 dt 解耦，且无论穿透多深，一帧最多挪 3cm，
      // 视觉上永远不会有"闪现"。剩余穿透在后续帧内按 β 比例几何收敛（每帧 ×0.2）。
      // 优先取 β·pen（常规几何收敛路径），再用 0.03m 硬上限截断。
      const want = Math.min(CFG.PEN_BETA * pen, CFG.PUSH_MAX_M);
      if (want <= 0) continue;

      // 每步每对接触只修一次（cannon 的 contacts 数组里同一对流形可能有多条
      // 接触方程，各自都推 3cm 会累加成 12cm —— 超规格）。用接触对 key 去重。
      const kA = bi.__carId !== undefined ? bi.__carId : -1;
      const kB = bj.__carId !== undefined ? bj.__carId : -1;
      const pairKey = kA < kB ? (kA + ':' + kB + ':' + (bi.id | 0) + ':' + (bj.id | 0))
                              : (kB + ':' + kA + ':' + (bj.id | 0) + ':' + (bi.id | 0));
      if (!this._pushQuota) this._pushQuota = new Set();
      if (this._pushQuota.has(pairKey)) continue;
      this._pushQuota.add(pairKey);

      const ri = invI / invSum;
      const mx = rn.x * want, my = rn.y * want, mz = rn.z * want;
      // ★★ 法线方向约定（已用最小两体实验钉死，勿改）：
      //   cannon-es 的 `eq.ni` **从 `bi` 指向 `bj`**（实验：A 在 x=0、静态 B 在 x=+0.9，
      //   重叠 0.1m -> ni = (+1,0,0)，且 cannon 自己把 A 推到 x=−0.0308，即沿 −n 远离 B）。
      //   因此"分离"要求：**bi 沿 −n 移动、bj 沿 +n 移动**。
      //
      // ⚠ 工程血泪（同一类符号错误已栽过一次，见 memory「位置相写成 p_A += n·dx」）：
      //   本函数原写作 `bi += rn*want*ri` / `bj -= rn*want*(1-ri)` —— 与约定**完全相反**，
      //   等于"穿得越深、越往对方身体里推"。车↔护栏场景下表现为：车被护栏法线
      //   **持续往墙体深处推**（实测横向偏移每步 +0.019m 稳定漂入墙内 1.1m/s，
      //   直至卡死在护栏体内、速度归零），这正是规格 §三.1 要根治的"吸墙"现象之一。
      bi.position.x -= mx * ri;
      bi.position.y -= my * ri;
      bi.position.z -= mz * ri;
      bj.position.x += mx * (1 - ri);
      bj.position.y += my * (1 - ri);
      bj.position.z += mz * (1 - ri);
      bi.aabbNeedsUpdate = true;
      bj.aabbNeedsUpdate = true;
      if (want > maxPush) maxPush = want;
    }
    this._pushQuota && this._pushQuota.clear();
    this.lastPushMax = maxPush;            // 供自检/HUD 遥测
  }

  /**
   * 方案 D：悬挂解耦的落地形式 —— 限制"会让车翻掉"的角速度。
   *
   * 这里刻意**不做"冲量打折"**：把 J 乘一个悬挂透过率会破坏动量守恒、让碰撞发软。
   * 真实赛车是轮毂/轮胎先吸能、悬挂再过滤高频，最终**线性动量照样传递**，
   * 但车身不会因为一次撞击就获得巨大的俯仰/侧倾角速度 —— 所以正确的做法是
   * 保持线性冲量，只夹住产生翻滚的那两个角速度分量。
   *
   * 把刚体角速度沿车身局部轴分解：绕 up（偏航）**不限**（那是正常的被撞旋转），
   * 绕 forward / lateral（俯仰 / 侧倾）限幅 —— 这两个轴才是凌空翻滚的来源。
   */
  limitFlipAngular(c, cap) {
    const av = c.body.angularVelocity;
    const up = c.up;
    const yawC = av.x * up.x + av.y * up.y + av.z * up.z;         // 偏航分量
    const rx = av.x - up.x * yawC, ry = av.y - up.y * yawC, rz = av.z - up.z * yawC;
    const mag = Math.hypot(rx, ry, rz);
    if (mag <= cap || mag < 1e-6) return;
    const k = cap / mag;
    av.set(up.x * yawC + rx * k, up.y * yawC + ry * k, up.z * yawC + rz * k);
  }

  absorbSoftContacts() {
    if (!this.softPairs.size) return;
    const dead = [];
    for (const [key, sc] of this.softPairs) {
      const A = sc.a.body, B = sc.b.body;
      const vrx = A.velocity.x - B.velocity.x;
      const vry = A.velocity.y - B.velocity.y;
      const vrz = A.velocity.z - B.velocity.z;
      let vn = vrx * sc.nx + vry * sc.ny + vrz * sc.nz;
      // 【规格修订】旧的 `vn = min(vn, BAUMGARTE_BIAS_V)` 速度钳位已**删除**。
      // 它名义上是"限制推出速度"，实际是在速度通道里**制造**一个 2.5 m/s 的
      // 目标速度 —— 与病根①同类，属于"往 velocity 里塞非动能速度"。
      // 现在只做一件事：把"正在分离"的法向速度按 90% 吸收掉（粘性软接触）。
      // 分离分量本身不含能量注入，削减它只会耗散动能，方向永远安全。
      if (vn > 0) {                       // 正在分离 -> 压制 90%
        const invA = A.invMass, invB = B.invMass;
        if (invA + invB === 0) { dead.push(key); continue; }
        let J = CFG.SOFT_CONTACT_CUT * vn / (invA + invB);
        // 规格 §5：单接触法向冲量硬上限 4e4 N·s（防数值奇异）
        J = Math.min(J, CFG.IMPULSE_MAX_NS);
        const jx = sc.nx * J, jy = sc.ny * J, jz = sc.nz * J;
        A.velocity.x -= jx * invA;
        A.velocity.y -= jy * invA;
        A.velocity.z -= jz * invA;
        B.velocity.x += jx * invB;
        B.velocity.y += jy * invB;
        B.velocity.z += jz * invB;
        sc.hits = (sc.hits || 0) + 1;
      }
      if (--sc.ttl <= 0) dead.push(key);
    }
    for (const k of dead) this.softPairs.delete(k);
  }

  /**
   * 碰撞反冲硬限幅（规格 §任务5）。
   *
   * 病根：车尾被追尾/侧蹭时接触点离质心远，力臂大 => 角冲量与竖直反冲同时超调，
   * 表现为"被撞飞"。求解器侧已有粘性软接触（吸收 90% 分离速度），但极端车对、
   * 高相对速度下仍可能残留一次暴烈弹射。这里做**后置硬截断**兜底：
   *   · |ωy| 截断到 ±COLLISION_YAW_CAP（默认 8.0 rad/s）
   *   · 若 |vy| 超过 COLLISION_VY_SOFT（默认 1.5 m/s）=> 压回 COLLISION_VY_REST（0.2）
   * 只在**确实是碰撞**（本步有接触登记）时才动手，避免干扰正常起伏路面的悬挂行程。
   */
  clampCollisionImpulse(cars) {
    // 本步没有车辆接触 -> 不干预（悬挂弹簧需要自由地产生 vy）
    if (!this.softPairs.size && !(this._stepTouched || 0)) return;
    for (const c of cars) {
      const b = c.body;
      if (!b || c.remote) continue;
      // ① 横摆角速度硬截断
      const av = b.angularVelocity;
      const cap = CFG.COLLISION_YAW_CAP;
      if (av.y > cap) av.y = cap; else if (av.y < -cap) av.y = -cap;
      // ② 竖直反冲软处理：超过阈值说明是被"铲飞"，压回一个安全的小值
      const v = b.velocity;
      if (v.y > CFG.COLLISION_VY_SOFT || v.y < -CFG.COLLISION_VY_SOFT) {
        v.y = CFG.COLLISION_VY_REST;
      }
    }
    this._stepTouched = 0;
  }

  /** 把本步累计的碰撞角冲量施加到刚体上（world.step 之后调用） */
  applyPendingYawImpulses() {
    for (const c of this.cars) {
      if (!c.pendingYaw) continue;
      if (c.remote) { c.pendingYaw = 0; continue; }
      const n = c.roadNormal || this.track.nrm[c.trackIdx];
      const d = clamp(c.pendingYaw, -CFG.YAW_IMPULSE_CAP * 2, CFG.YAW_IMPULSE_CAP * 2);
      c.body.angularVelocity.x += n.x * d;
      c.body.angularVelocity.y += n.y * d;
      c.body.angularVelocity.z += n.z * d;
      c.pendingYaw = 0;
    }
  }

  /**
   * 复位/瞬移后把 Checkpoint 簿记同步到落点。
   *
   * 为什么必须做：`updateProgress` 判定切弯与计圈全靠在 trackIdx 上按
   * `bucket = floor(trackIdx / samplesPerCp) % checkpointCount` 取的桶号变化量。
   * 复位是**瞬移**（落点可能离当前位置几百米），若不同步：
   *  ① 下一帧 delta = 落点桶 - 旧桶 = 沿途跳过的 CP 数 ⇒ 误判"切弯"并累加
   *     PEN_CUT × skipped 的巨额罚时（实测复位到起终点 = 11 次切弯）；
   *  ② 若落点桶正好是 0，还会走"冲线"分支：progress < 23 时判**抄近道**并把
   *     progress 清零 ⇒ 本圈再也集不齐 Checkpoint ⇒ 冲线不计圈、不完赛。
   *
   * 语义：落点所在桶即"本圈已通过到的位置"，progress 与之对齐；
   * crossedStart 置真 —— 车已经在赛道上跑，不需要再"上膛"。
   */
  _syncCpAfterRescue(car) {
    const t = this.track;
    const bucket = Math.floor(car.trackIdx / t.samplesPerCp) % t.checkpointCount;
    car.cpIdx = bucket;
    car.progress = bucket;
    car.crossedStart = true;
  }

  /**
   * R 键救援复位（规格）：
   *   瞬移到**上一个已合法通过的 Checkpoint** 中心上方 0.5m -> 朝向对齐该点切线
   *   -> 清空线速度与角速度 -> 罚时 +3.0s -> 冻结 3 秒（维修区倒计时）
   * "上一个合法通过的 Checkpoint"取当前所在 CP 区间的入口点：进入该区间即已合法通过。
   *
   * @param {boolean} [toStart] true = 复位到**赛道起点（起终点线）**；
   *   默认 false = 回上一个合法通过的 Checkpoint。
   *   为什么默认不是起点：罚时固定 +3.0s，而跑到第 3 圈按一下 R 会被扔回起点、
   *   直接损失两圈 —— 那不是"脱困"而是"重开"。所以默认保留上个 Checkpoint，
   *   起点模式用 `CFG.RESCUE_TO_START = true` 或 URL `?rescueAnchor=start` 打开。
   */
  rescueToCheckpoint(car, toStart = CFG.RESCUE_TO_START) {
    const t = this.track;
    const cps = t.checkpoints;

    // ---- 驶出锚点优先（规格 §一.2）---------------------------------------
    // 回到"驶出赛道前最后一个四轮都在沥青上的位姿"，就近脱困。
    // 用纯 yaw 四元数重建朝向 -> 倾斜角与滚转角必然归零（不会带着翻车姿态复位）。
    const anchor = car.lastLegalAnchor;
    if (CFG.RESCUE_TO_DEPART && anchor) {
      car.body.position.set(anchor.x, anchor.y + CFG.RESCUE_DEPART_LIFT, anchor.z);
      const hy = anchor.yaw * 0.5;
      car.body.quaternion.set(0, Math.sin(hy), 0, Math.cos(hy));
      // 规格 §二.2：继承驶出瞬间的初速度 —— 沿赛道前进方向给一个 clamp 过的速度，
      // 让车"顺畅沿赛道继续行驶"而不是原地熄火。方向取锚点切线（= 车头朝向）。
      const vExit = (typeof anchor.vExit === 'number') ? anchor.vExit : 0;
      const vNew = clamp(vExit * CFG.RESCUE_INHERIT_RATIO,
        CFG.RESCUE_SPEED_MIN, CFG.RESCUE_SPEED_MAX);
      const fx = Math.sin(anchor.yaw), fz = Math.cos(anchor.yaw);   // 前进方向
      car.body.velocity.set(fx * vNew, 0, fz * vNew);
      car.body.angularVelocity.set(0, 0, 0);
      car.pendingYaw = 0;
      car.steerInput = 0; car.steerAngle = 0; car.handbrake = 0; car.yawDisturb = 0;
      car.prevForwardSpeed = 0; car.axMeasured = 0; car.offRoad = 0;
      car.trackIdx = t.nearest(anchor.x, anchor.z, car.trackIdx);
      // ★ 复位是**瞬移**：必须把 CP 簿记同步到落点（见下方 rescueToCheckpoint 尾部注释）。
      this._syncCpAfterRescue(car)
      car.rescueCount++
      // ★ #10：复位不再无脑罚 3 秒。复位本身已经让玩家**实打实损失了救车时间**，
      //   前 RESCUE_FREE_COUNT 次完全免罚（只标脏圈、不计干净最佳圈）；
      //   超出后才象征性加罚，避免有人把复位当"快速传送"刷近道。
      if (car.rescueCount > CFG.RESCUE_FREE_COUNT) {
        car.addPenalty(CFG.RESCUE_PENALTY_AFTER, 'rescue');
      }
      // 本圈成绩作废（规格 §一.2）：本圈不计入**干净最佳圈**。
      // ⚠️ 但**绝不能重置本圈计时**（用户报障："按复位键会重置圈速"）。
      //    lapStart 是"压过起终点线那一刻"记下的，复位不改变这个事实；
      //    把 lapStart 改成 this.time / 把 lapTimeLive 清零，会让 HUD 上的
      //    当前圈时间当场归零 —— 那是**假的**，玩家明明已经跑了半圈。
      //    正确做法：只标记脏圈（lapInvalid），计时照走。
      car.lapInvalid = true
      this._activateGhost(car, 4, CFG.GHOST_TIME);
      // 规格 §二.3：使用掩码隔离（只剔车车），**不**用 collisionResponse=false
      car.rescueGhost = true;
      this._refreshMasks();
      for (const [k, v] of this.softPairs) if (v.a === car || v.b === car) this.softPairs.delete(k);
      car.syncFromBody();
      car.prevPos.copy(car.pos);
      car.prevQuat.copy(car.quat);
      return true;
    }
    let idx = car.trackIdx;
    if (toStart && cps.length) {
      idx = cps[0].sample;                        // 起点 = 第 0 个 Checkpoint（起终点线）
    } else if (car.cpIdx >= 0 && car.cpIdx < cps.length) {
      idx = cps[car.cpIdx].sample;
    }
    const sp = t.spawn(idx, 0);
    // 高度以**该索引处的路面**为准（桥上/桥下分层正确），不用 Checkpoint 的 pos.y，
    // 因为起点模式下 idx 与 cpIdx 不是同一个点。
    const py = t.pts[idx].y + CFG.RESCUE_HEIGHT;
    car.body.position.set(sp.position.x, py, sp.position.z);
    car.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
    car.body.velocity.set(0, 0, 0);
    car.body.angularVelocity.set(0, 0, 0);
    car.pendingYaw = 0;
    car.steerInput = 0; car.steerAngle = 0; car.handbrake = 0; car.yawDisturb = 0;
    car.prevForwardSpeed = 0; car.axMeasured = 0; car.offRoad = 0;
    car.trackIdx = idx;
    // ★ 复位是**瞬移**：必须把 CP 簿记同步到落点。否则下一帧 updateProgress 会按
    //   "旧 cpIdx → 落点 bucket" 算出一个巨大的 delta，沿途所有 CP 都被当成"跳过"：
    //   实测（复位到起终点）会一次性判 11 次切弯罚时并把 progress 清零，而进度一旦
    //   归零，本圈终点就再也集不齐 Checkpoint ⇒ 冲线不计圈。
    //   用户报障成对出现："按复位键会重置圈速" + "出现到达终点却没完赛" 就是这条。
    this._syncCpAfterRescue(car);
    car.rescueCount++;
    if (car.rescueCount > CFG.RESCUE_FREE_COUNT) {
      car.addPenalty(CFG.RESCUE_PENALTY_AFTER, 'rescue');
    }
    // 幽灵化保护（无 3s 冻结：复位后可立刻踩油门发车）
    this._activateGhost(car, 4, CFG.GHOST_TIME);
    // 规格 §二.3：掩码隔离（只剔车车），严禁关 collisionResponse
    car.rescueGhost = true;
    this._refreshMasks();
    // 清掉涉及本车的软接触对，避免复位后仍被旧的吸收状态影响
    for (const [k, v] of this.softPairs) if (v.a === car || v.b === car) this.softPairs.delete(k);
    car.syncFromBody();
    // 同步插值基准，避免复位瞬间渲染端从旧位置"拉丝"横穿赛道
    car.prevPos.copy(car.pos);
    car.prevQuat.copy(car.quat);
    return true;
  }

  /**
   * 幽灵化状态推进：3.5s 内关闭**车车**碰撞（别人可直接穿过本车）。
   * 结束后用 GHOST_FADE_T 平滑恢复碰撞响应与车身透明度。
   *
   * ⚠ 规格 §二.3（本轮修正的真 Bug）：**绝对不能用 `collisionResponse = false`**。
   * cannon 的 `body.collisionResponse` 是"全局总闸"，关掉它连护栏和地面一起失效 ——
   * 实测表现就是"R 键复位后半透明车直接穿过护栏飞出赛道"。
   * 正确做法：只把**车组位域**从 collisionFilterMask 里剔掉（`_setRescueGhost`），
   * GROUP_BARRIER / 地面 全部保留 -> 车可以穿透别的**车**，但绝穿不过**护栏**。
   */
  updateGhost(c, dt) {
    const wantGhost = c.ghostTimer > 0;
    if (c.ghostTimer > 0) {
      c.ghostTimer = Math.max(0, c.ghostTimer - dt);
      c.ghost = 1;
      if (c.ghostTimer === 0) c.ghostFade = CFG.GHOST_FADE_T;
    } else if (c.ghostFade > 0) {
      c.ghostFade = Math.max(0, c.ghostFade - dt);
      c.ghost = c.ghostFade / CFG.GHOST_FADE_T;
    } else if (c.ghost !== 0) {
      c.ghost = 0;
    }
    // 掩码按"是否仍处于幽灵期"幂等刷新（含淡出期：淡出期间也是幽灵，仍不可被撞）
    const inGhost = wantGhost || c.ghostFade > 0 || c.ghost > 0;
    if (!!c.rescueGhost !== inGhost) {
      c.rescueGhost = inGhost;
      this._refreshMasks();
    }
    if (inGhost) {
      c.ghostReasonCode = c.finishGhost ? 5 : (c._ghostReason || c.ghostReasonCode || 0);
    } else if (!c.finishGhost) {
      c._ghostReason = 0;
      c.ghostReasonCode = 0;
    }
  }

  /**
   * 开启一个只剔除车车碰撞的计时幽灵。
   * `collisionResponse` 永远保持 true，因此 Heightfield 地面与护栏仍然有效。
   */
  _activateGhost(c, reason, duration) {
    if (c.finished && reason !== 5) return;
    c.ghostTimer = Math.max(c.ghostTimer || 0, duration);
    c.ghostFade = 0;
    c.ghost = 1;
    c._ghostReason = reason;
    c.ghostReasonCode = reason;
    if (!c.rescueGhost) {
      c.rescueGhost = true;
      this._refreshMasks();
    }
  }

  /** 将当前车位写成可比较的真实周回进度（不是欧氏距离）。 */
  _setProgressScore(c) {
    const n = this.track.count || 1;
    let i = Number.isFinite(c.trackIdx) ? c.trackIdx % n : 0;
    if (i < 0) i += n;
    c.progressScore = (c.lap || 0) * n + i;
    return c.progressScore;
  }

  /**
   * 依据真实圈数 + 赛道弧长索引判定套圈，依据已建立的计圈簿与逆向速度判定逆行。
   * 套圈/逆行期间每步续期；条件消失后让既有淡出计时自然结束。
   */
  updateRaceGhosting() {
    const cars = this.cars;
    const n = this.track.count || 1;
    for (const c of cars) this._setProgressScore(c);

    for (const c of cars) {
      if (c.finished || c.retired || c.remote) {
        c.lappedGhost = false;
        c.lappedBy = 0;
      } else {
        let lead = null;
        let leadScore = -Infinity;
        for (const o of cars) {
          if (o === c || o.retired || o.remote) continue;
          const score = Number.isFinite(o.progressScore) ? o.progressScore : this._setProgressScore(o);
          if (score > leadScore) { leadScore = score; lead = o; }
        }
        const gap = lead ? leadScore - c.progressScore : 0;
        c.lappedGhost = gap >= n;
        c.lappedBy = c.lappedGhost ? lead.id : 0;
      }

      c.wrongWayGhost = !c.finished && !c.retired && c.wrongWayT >= CFG.WRONG_WAY_GHOST_DELAY;
      // 逆行优先于套圈，避免同时发生时把更直接的危险原因隐藏掉。
      if (c.wrongWayGhost) this._activateGhost(c, 2, CFG.GHOST_TIME);
      else if (c.lappedGhost) this._activateGhost(c, 1, CFG.LAPPED_GHOST_TIME);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  规则 1：吸尾流                                                          */
  /* ---------------------------------------------------------------------- */

  refreshSlipstream() {
    // 只保留最近的一台有效前车，避免多车尾流叠加；n<=4，O(n²) 开销可忽略
    const cosCone = Math.cos(CFG.SLIP_CONE * DEG);
    for (const a of this.cars) {
      a.slip = 0;
      a.slipFrom = 0;
    }
    for (const f of this.cars) {              // f = 后车
      let best = null, bestD = Infinity;
      for (const l of this.cars) {            // l = 前车
        if (l === f || l.retired) continue;
        if (l.speedKmh < CFG.SLIP_MIN_KMH) continue;
        const dx = l.pos.x - f.pos.x;
        const dz = l.pos.z - f.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < CFG.SLIP_MIN || d > CFG.SLIP_MAX) continue;
        // 夹角 < 12°：后车必须落进"前车车尾锥"。
        // rel = 前车位置 - 后车位置，后车在正后方时 rel 与前车【前进方向】同向，
        // 等价于"后车位于前车尾锥内"（把锥轴取 -fwd 再反转 rel 符号，结果一致）。
        const len = Math.hypot(l.fwd.x, l.fwd.z) || 1e-3;
        const cos = (dx * l.fwd.x + dz * l.fwd.z) / (d * len);
        if (cos < cosCone) continue;
        // 两车航向还需大致同向，避免正面对冲被误判为尾流
        const head = f.fwd.x * l.fwd.x + f.fwd.z * l.fwd.z;
        if (head < 0.5) continue;
        if (d < bestD) { bestD = d; best = l; }
      }
      if (best) {
        // 尾流强度：区内近距（<=12m）给满效；越接近 25m 边界逐步衰减到 55%。
        // 规格要求"尾流区内风阻降低 35%"，因此不能在区内就大幅打折。
        f.slip = 0.55 + 0.45 * clamp((CFG.SLIP_MAX - bestD) / 13, 0, 1);
        f.slipFrom = best.id;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  规则 3：恶意侧撞判定                                                    */
  /* ---------------------------------------------------------------------- */

  resolveRam(dt) {
    for (const atk of this.cars) {
      if (atk.ramCooldown > 0 || atk.retired || atk.finished) continue;
      for (const vic of this.cars) {
        if (vic === atk || vic.retired) continue;
        const rel = this._v.set(atk.pos.x - vic.pos.x, 0, atk.pos.z - vic.pos.z);
        const d = rel.length();
        if (d > 4.6) continue;
        // 撞击者必须位于受害车侧后方
        const aheadOnVic = rel.dot(vic.fwd);            // <0 表示攻击者在受害车后方
        const latOnVic = rel.dot(vic.lateralDir);
        if (aheadOnVic > 0.6) continue;
        if (Math.abs(latOnVic) < 1.25) continue;        // 正后追尾不算侧撞
        // 航向夹角 > 40°
        const hd = clamp(atk.fwd.dot(vic.fwd), -1, 1);
        const ang = Math.acos(hd) / DEG;
        if (ang < CFG.RAM_ANGLE) continue;
        // 接近速度
        const relV = this._v2.set(atk.vel.x - vic.vel.x, 0, atk.vel.z - vic.vel.z);
        const closingKmh = relV.length() * 3.6;
        if (closingKmh < CFG.RAM_CLOSING_KMH) continue;
        if (atk.speedKmh < CFG.RAM_MIN_KMH) continue;

        atk.ramCooldown = 2.5;
        atk.addPenalty(CFG.PEN_RAM, 'ram');
        if (vic.isLocal) vic.setAlert('被恶意撞击（对方已判罚）', 'warn', 2.4);
        break;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  规则 4：Checkpoint / 圈数 / 出界罚时                                    */
  /* ---------------------------------------------------------------------- */

  updateProgress(c, dt) {
    const t = this.track;
    const cpNow = typeof t.checkpointIndexAt === 'function'
      ? t.checkpointIndexAt(c.trackIdx)
      : Math.floor(c.trackIdx / t.samplesPerCp) % t.checkpointCount;
    c.lapTimeLive = Math.max(0, this.time - c.lapStart);   // 供 HUD 显示"当前圈"
    this._setProgressScore(c);

    if (c.finished) {
      // 冲线后进入自动巡航：不再计圈、不再判切弯、不再累加出界罚时
      c.finishDist = (c.finishDist || 0) + c.speed * dt;   // 累计巡游里程（规格：至少 300m）
      const tan0 = t.tan[c.trackIdx];
      c.wrongWay = (c.vel.x * tan0.x + c.vel.z * tan0.z) < -4 && c.speedKmh > 25;
      return;
    }

    if (c.cpIdx < 0) {
      c.cpIdx = cpNow;
      // ★ 发车位置决定要不要"上膛"（用户报障："出现到达终点却没完赛"）。
      //   发车格在起终点线**之前**（铃鹿的真实发车格在 CP23 内，线前 ~25m）：
      //   本圈尚未开始，第一次压线只是"开表" ⇒ crossedStart=false，让第一次压线上膛。
      //   但如果车恰好落在 CP0 内（压线/线后，含"复位到起终点"、自定义起跑点等），
      //   本圈从绿灯起就已经在跑计时了 ⇒ 必须 crossedStart=true，
      //   否则这一整圈会在终点被当成"上膛"丢掉 —— 表现就是跑完一圈冲线却毫无反应。
      // ⚠️ 判据是 `cpNow === 0`（**落在 CP0 内**才置真），不是 `!== 0`。
      //    写反的后果实测两处：
      //      · 发车格在 CP23（正常）⇒ 起步后第一次压线（progress≈1）掉进
      //        "未集齐检查点"分支 ⇒ **起步就被罚 2 秒**（用户报障）；
      //      · 落在 CP0 内 ⇒ 第一整圈被当"上膛"丢掉（我本想修的那个 bug 没修上）。
      c.crossedStart = cpNow === 0;
      c.prevPos = new THREE.Vector3(c.pos.x, c.pos.y, c.pos.z);
      c.lapStart = this.time;
      return;
    }

    if (cpNow !== c.cpIdx) {
      const delta = (cpNow - c.cpIdx + t.checkpointCount) % t.checkpointCount;
      if (delta > 0 && delta <= t.checkpointCount / 2) {
        // 前向通过：中间被跳过的 Checkpoint 即"切弯"
        const skipped = delta - 1;
        if (skipped > 0) {
          c.addPenalty(CFG.PEN_CUT * skipped, 'cut');
          // 罚时改由 main.js 静默展示在右侧排行榜（规格：不再弹居中罚时横幅）
        }
        c.progress += delta;
        c.cpIdx = cpNow;

        if (cpNow === 0) {
          // 冲过起终点线：必须集齐本圈全部 Checkpoint 才计圈
          if (!c.crossedStart) {
            // 发车瞬间的第一次压线：只"上膛"，不计圈也不判切弯
            c.crossedStart = true;
            c.progress = 0;
          } else if (c.progress >= t.checkpointCount - 1) {
            c.lap++
            // ★ 脏圈只影响"**干净**最佳圈"与 ⚠ 标记，**不影响最佳圈速本身**
            //   （用户报障："跑完一圈后最佳圈速不更新"）。
            //   旧实现把"脏圈"整段跳过 ⇒ 只要本圈吃过任何罚时（出界/复位/切弯），
            //   累计圈速就永远停在 --:--.---。实测罚 33s 的一局里三圈全被标脏、
            //   最佳圈速全程为空。
            const dirty = !!c.lapInvalid;
            c.lapInvalid = false;
            c.lastLap = this.time - c.lapStart;
            c.lapTime = c.lastLap;
            c.lapStart = this.time;
            if (c.bestLap === 0 || c.lastLap < c.bestLap) c.bestLap = c.lastLap;
            if (!dirty && (c.bestCleanLap === 0 || c.lastLap < c.bestCleanLap)) {
              c.bestCleanLap = c.lastLap;      // 干净最佳圈（赛季/记录用）
            }
            // 所有圈都上报进度；服务端仅用干净圈更新最佳圈。
            if (this.onLap) this.onLap(c, c.lap, c.lastLap, dirty);
            if (c.lap >= c.laps) this.finishCar(c);
            c.progress = 0;
            this._setProgressScore(c);
          } else {
            c.addPenalty(CFG.PEN_LAP_SHORTCUT, 'shortcut');
            c.progress = 0;
          }
        }
      } else {
        // 反向通过（掉头/倒车），不计圈也不罚，但记录位置避免误判
        c.cpIdx = cpNow;
      }
    }

    // ---- FRR 赛道裁决（规格 §四.1）---------------------------------------
    // 出界本身不罚，"出界并获利"才罚：
    //   全油门 + 高速 + 不刹车 -> 抄近道获利 -> 阶梯罚 1.0~3.0s
    //   松油 / 刹车 / 掉速     -> 失控脱轨无获利 -> Racing Incident，仅记录、免罚
    if (c.grassWheels >= 4 && !c.finished) {
      if (!c.offActive) {
        c.offActive = true;
        c.offEnterT = this.time;
        c.offDist = 0;
        c.offThrottleT = 0;
        c.offBrakeT = 0;
        c.offNotified = false;
      }
      c.offAlertT = (c.offAlertT || 0) + dt;
      c.offThrottleT += clamp(c.input.throttle, 0, 1) * dt;
      c.offBrakeT += clamp(c.input.brake, 0, 1) * dt;
      c.offDist += Math.abs(c.forwardSpeed) * dt;
    } else {
      // 全轮回到沥青 -> 结算这一段出界
      if (c.offActive) this.settleOffTrack(c);
      c.offActive = false;
      if (c.grassWheels < 4) c.offNotified = false;
    }
    // 在沥青上的巡航速度参考（EWMA）：只在四轮都在沥青上时更新，
    // 免得把草地上的低速也学进基准里，导致下一次误判"获利"。
    if (c.onAsphalt === 4 && !c.finished) {
      const k = 1 - Math.exp(-dt / CFG.FRR_PACE_TAU);
      c.paceRef += (Math.abs(c.forwardSpeed) - c.paceRef) * k;
      if (c.paceRef < CFG.FRR_PACE_FLOOR) c.paceRef = CFG.FRR_PACE_FLOOR;
    }

    // ---- 驶出锚点缓存（规格 §一.1）--------------------------------------
    // 记录四轮都在沥青上的**最后一帧**位姿。压 R 就近回这里，不用回起点重跑整圈。
    // 只在四轮都贴沥青时更新 —— 否则会把空中/草地上的位姿存成锚点。
    if (c.onAsphalt === 4 && c.grounded && !c.airborne && !c.finished) {
      const a = c.lastLegalAnchor || (c.lastLegalAnchor = { x: 0, y: 0, z: 0, yaw: 0, speed: 0 });
      a.x = c.pos.x; a.y = c.pos.y; a.z = c.pos.z;
      const at = t.tan[c.trackIdx];
      a.yaw = Math.atan2(at.x, at.z);
      a.speed = c.speed;
      // 规格 §二.1：记录**驶出赛道瞬间**的速度（用于复位时继承初速度，
      // 代替"复位后原地熄火"）。它只在四轮都在沥青上时刷新，
      // 因此天然等于"最后一个在轨帧的速度" ≈ 冲出时的车速。
      a.vExit = Math.abs(c.forwardSpeed);
    }

    // ---- 逆行提示 ---------------------------------------------------------
    const tan = t.tan[c.trackIdx];
    const along = c.vel.x * tan.x + c.vel.z * tan.z;
    const reverseMotion = along < -4 && c.speedKmh > 25 && c.cpIdx >= 0;
    if (reverseMotion) c.wrongWayT = (c.wrongWayT || 0) + dt;
    else c.wrongWayT = Math.max(0, (c.wrongWayT || 0) - dt * 2);
    c.wrongWay = reverseMotion;
    this._setProgressScore(c);
  }

  /**
   * 结算一段出界（FRR 智能裁决，规格 §四.1）。
   *
   * 判据 —— 出界期间：
   *   平均车速 avg = 里程/时长，基准 ref = 沥青上的巡航速度 EWMA（有下限兜底）
   *   油门时间占比 thrRatio、刹车时间占比 brakeRatio
   *   · 获利：thrRatio ≥ 0.55（全油门开火）且几乎没刹车 且 avg ≥ ref×0.95
   *     -> 阶梯罚：1.0s（刚好吃到一点）~ 3.0s（比正常走线还快 20% 以上）
   *   · 无获利：松油 / 刹车 / 明显掉速 -> 裁定 Racing Incident，仅记录、免罚
   *
   * 这样"跑宽冲出赛道减速救车"不再被罚，而"抄草地抄近道"会被重罚 —— 与 FM8 一致。
   */
  settleOffTrack(c) {
    const dtOff = this.time - c.offEnterT;
    if (dtOff < CFG.FRR_MIN_OFF_T) return;
    // ★ #10：刚被别人撞过 ⇒ 这次出界按"赛车事故"处理，**不判获利罚时**
    //   （用户报障："有时被撞车辆也会被罚时"）。被顶出去的人不该再被罚一次。
    if ((c.hitGraceT || 0) > 0) {
      c.incidents++;
      if (this.onIncident) this.onIncident(c, { dtOff, cause: '被撞后出界（免罚）' });
      return;
    }
    const avg = c.offDist / dtOff;
    const ref = Math.max(c.paceRef, CFG.FRR_PACE_FLOOR);
    const thrRatio = c.offThrottleT / dtOff;
    const brakeRatio = c.offBrakeT / dtOff;
    // ★ 只有**短促**的出界才算"抄近道获利"（用户报障：罚时一路涨到 +33s，最佳圈速全被标脏）。
    //   旧的判据只有"油门占比高 + 没刹车 + 均速不低"，于是**滑出去再加油救车**也会被判罚：
    //   那种出界走的距离更长、时间更久，玩家其实是**亏了时间**的，不该再罚。
    //   FM8 也是这个口径：切弯（短）罚，跑宽冲出去（长）只算事故。
    const shortCut = dtOff <= CFG.FRR_MAX_CUT_T;
    const gained = shortCut &&
      thrRatio >= CFG.FRR_GAIN_THR &&
      brakeRatio < CFG.FRR_BRAKE_SAFE &&
      avg >= ref * CFG.FRR_GAIN_SPEED;
    if (!gained) {
      c.incidents++;
      if (this.onIncident) this.onIncident(c, { dtOff, avg, ref, thrRatio, brakeRatio });
      return;
    }
    const k = clamp((avg / ref - CFG.FRR_GAIN_SPEED) / 0.25, 0, 1);
    const pen = CFG.FRR_PEN_MIN + (CFG.FRR_PEN_MAX - CFG.FRR_PEN_MIN) * k;
    c.violations++;
    c.addPenalty(pen, 'frr_gain');
  }

  finishCar(c) {
    if (c.finished) return;
    c.finished = true;
    c.finishGhost = true;
    c._ghostReason = 5;
    c.ghostReasonCode = 5;
    this._refreshMasks();
    // ★ 冲线即**非退赛**：DNF 宽限只针对"结算那一刻仍未冲线"的车。若不撤掉这个标记，
    //   被宽限判退赛、随后又真的冲线的车，结算里会一直显示"未完赛/DNF"
    //   （用户报障："全员已冲线但显示未完赛"）。
    c.retired = false;
    c.auto = true;                      // 交给自动巡航（driveLocal 会路由到 purePursuit）
    c.purePursuit = true;               // 规格 §三：完赛循迹标志（供测试/HUD 断言）
    c.finishTime = this.time;
    c.totalTime = c.finishTime + c.penalty;
    if (this.onFinish) this.onFinish(c);
  }

  /**
   * 规格 §三：完赛自动巡航 —— Pure Pursuit 循迹控制器。
   *
   * 任意车（玩家或 AI）冲过终点线后立即调用。语义：
   *   1. **剥离手动输入**：完全不读键盘/AI 意图，油门/刹车/转向全部由本函数接管；
   *   2. **纯追迹**：在**最优行车线**（track.raceLine）样条上取车前视点
   *      `LOOKAHEAD_M`（15m）处的目标点；
   *   3. **横向偏差 -> 平滑转向**：按 Pure Pursuit 曲率公式
   *      `κ = 2·sin(α) / Ld`（α = 目标点相对车头方向的方位角）转成前轮转角；
   *   4. **巡航油门锁 50~60km/h**：低于下界补油、高于上界轻收，**绝不满舵刹车**，
   *      更不准把车停住（避免成为终点线上的路障）。
   *
   * 前视距离随车速缩放（低速收短、高速放长），保证循迹稳定不画龙。
   */
  purePursuit(c, dt) {
    const t = this.track;
    if (!t || !t.raceLine) return;
    const N = t.count, sp = t.spacing;
    const rl = t.raceLine;

    // ---- 巡航目标速度：50~60km/h 之间（规格 §三：锁 50~60km/h 慢游）----
    const vLo = CFG.CRUISE_MIN_KMH / 3.6;        // 50km/h -> 13.89 m/s 下界
    const vHi = CFG.CRUISE_KMH / 3.6;            // 60km/h -> 16.67 m/s 上界

    // ---- Pure Pursuit 前视点：最优行车线上的目标点（前视 15m）----
    const look = clamp(CFG.PURE_PURSUIT_LOOKAHEAD + c.speed * 0.25,
      CFG.PURE_PURSUIT_LOOKAHEAD, 26);
    const li = (c.trackIdx + Math.round(look / sp)) % N;
    // 最优线横向偏移（raceLine.offset）叠加到中心线，得到目标点
    const lp = t.pts[li], ls = t.side[li];
    const off = rl.offset ? clamp(rl.offset[li], -(t.halfWidth - 2.4), t.halfWidth - 2.4) : 0;
    const tx = lp.x + ls.x * off, tz = lp.z + ls.z * off;

    const dx = tx - c.pos.x, dz = tz - c.pos.z;
    const Ld = Math.max(1e-3, Math.hypot(dx, dz));    // 实际前视距离
    const rf = c.rightSide;      // 车身真正右侧（-X 真右的约定见工程 memory）
    const ff = c.fwd;
    const rlen = Math.hypot(rf.x, rf.z) || 1e-3;
    const flen = Math.hypot(ff.x, ff.z) || 1e-3;
    // α = 目标点相对车头方向的方位角（>0 表示目标在右侧 -> 向右打舵）
    const alpha = Math.atan2((dx * rf.x + dz * rf.z) / rlen, (dx * ff.x + dz * ff.z) / flen);
    // Pure Pursuit 曲率 κ = 2·sin(α)/Ld；这里直接转成归一化转向意图。
    // 增益 1.8 与 AI autopilot 一致（工程既有标定），保证平滑不画龙。
    c.input.steer = clamp(alpha * 1.8, -1, 1);

    // ---- 纵向：只在 50~60km/h 区间内做柔和调节，绝不满舵刹车 ----
    if (c.speed < vHi) {
      c.input.throttle = 0.55;        // 轻补油回到巡航区间
      c.input.brake = 0;
    } else if (c.speed > vLo) {
      c.input.throttle = 0;
      // 上限只给 0.25 的轻刹（绝不 hard-brake 停住），多余速度自然滚阻衰减
      c.input.brake = clamp((c.speed - vLo) / 8, 0, 0.25);
    } else {
      c.input.throttle = 0.35;
      c.input.brake = 0;
    }
    c.input.handbrake = 0;
  }

  /**
   * Longitudinal AI controller shared by autopilot and focused dynamics tests.
   * The target/current comparison is in km/h so the ±2 km/h coast band is
   * explicit. Outside the band, throttle and brake approach their request at
   * a bounded rate instead of toggling on every speed sample.
   */
  computeAISpeedControl(currentKmh, targetKmh, dt, previous = {}) {
    const current = Number.isFinite(currentKmh) ? currentKmh : 0;
    const target = Number.isFinite(targetKmh) ? targetKmh : current;
    const error = target - current;
    const prevThrottle = clamp(Number(previous.throttle) || 0, 0, 1);
    const prevBrake = clamp(Number(previous.brake) || 0, 0, 1);
    if (Math.abs(error) <= 2) return { throttle: 0, brake: 0 };

    const desiredThrottle = error > 0 ? clamp(0.25 + error / 30, 0, 1) : 0;
    const desiredBrake = error < 0 ? clamp((-error - 2) / 18, 0, 1) : 0;
    const slew = clamp((Number.isFinite(dt) ? dt : 1 / 60) * 4.5, 0.02, 0.12);
    const approach = (from, to) => from + clamp(to - from, -slew, slew);
    return {
      throttle: approach(prevThrottle, desiredThrottle),
      brake: approach(prevBrake, desiredBrake),
    };
  }

  /**
   * AI / 自动巡航：跟随赛道走线。
   * 关键点是**刹车距离前视**——只看前方 40m 的曲率毫无意义：
   * 260km/h(72m/s) 的刹车距离约 130m，必须扫描前方 240m 每处的"过弯极限速度"，
   * 再用 v² = v_corner² + 2·a·d 反推当前位置允许的最高速度，否则必然冲出发夹弯。
   */
  autopilot(c, dt) {
    const t = this.track;
    const N = t.count, sp = t.spacing;
    const spd = Math.max(c.speed, 4);

    // ---- 1. 目标速度：扫描 240m 曲率 + 刹车距离反推 ----
    const decel = Math.max(c.aLatCap || 0, 6) * 0.70;
    const K = Math.max(6, Math.round(240 / sp));
    let vTarget = 1e6;
    for (let k = 2; k <= K; k += 3) {
      const i0 = (c.trackIdx + k) % N;
      const i1 = (i0 + 3) % N;
      const a0 = t.tan[i0], a1 = t.tan[i1];
      const turn = Math.abs(Math.atan2(a0.x * a1.z - a0.z * a1.x, a0.x * a1.x + a0.z * a1.z));
      const R = turn > 1e-5 ? (3 * sp) / turn : 1e6;
      // 用车辆**当前真实**横向极限（含气动下压力与载荷转移）评估过弯速度：
      // 高速下压力带来的抓地提升会被利用，脏气流中的抓地损失也会被自动补偿。
      const gripNow = Math.max(c.aLatCap || 0, 5);
      const vCorner = Math.sqrt(gripNow * R * 0.62);
      const vAllowed = Math.sqrt(vCorner * vCorner + 2 * decel * (k * sp));
      if (vAllowed < vTarget) vTarget = vAllowed;
    }
    vTarget = Math.min(vTarget, CFG.VMAX * 0.94);
    // 完赛后自动巡航（规格）：维持 60km/h 顺着最佳走线慢游，绝不停在终点线挡路
    if (c.finished) vTarget = CFG.CRUISE_KMH / 3.6;
    if (c.airborne) vTarget *= 0.9;

    // ---- 1b. 出界自救：被撞飞/冲出路面后优先回中，否则会在草坪林子里越跑越远 ----
    const offTrack = Math.abs(c.lateral) - t.halfWidth;
    if (offTrack > 3) {
      vTarget = Math.min(vTarget, 20);        // ~72km/h，先稳住再回赛道
    }

    // ---- 2. 转向：前视点 + 粗略走线（向弯心偏移）----
    const look = clamp(7 + spd * 0.85, 12, 58) * (offTrack > 3 ? 0.45 : 1);
    const li = (c.trackIdx + Math.round(look / sp)) % N;
    const a0 = t.tan[c.trackIdx];
    const aB = t.tan[(c.trackIdx + Math.round(28 / sp)) % N];
    const curv = Math.atan2(aB.x * a0.z - aB.z * a0.x, aB.x * a0.x + aB.z * a0.z);
    // 出界时不走"偏向弯心"的走线，直接瞄中心线，回中更快
    // 完赛后（自动巡航）则改为**严格跟随最佳走线**，慢速顺滑巡游
    const raceOff = (c.finished && t.raceLine)
      ? t.raceLine.offset[li]
      : -clamp(curv * 9, -1, 1) * (t.halfWidth * 0.42);

    // ---- 2b. 起步让线 ----
    // 发车时四台车各自瞄弯心，会在 5~7 秒内同时插向同一条走线而并线互撞，
    // 被顶飞的滚进沙地（实测 max|lateral| 49.5m、罚时累加 11s）。
    // 真实起步也不会一放绿灯就横切抢线，所以让 AI 先跑自己的发车道，
    // 走满 START_LANE_M 米后再 smoothstep 平滑并入最佳走线（无折角，不会突然横甩）。
    // odo 只在"未完赛"时累加：完赛后巡航与复位救援都不再进入让线逻辑。
    if (!c.finished) c.odo += spd * dt;
    let laneBlend = 0;
    if (!c.finished && c.odo < CFG.START_LANE_M) {
      const u = clamp(1 - c.odo / CFG.START_LANE_M, 0, 1);
      laneBlend = u * u * (3 - 2 * u);                  // smoothstep
    }
    const laneOff = clamp(c.gridLateral, -(t.halfWidth - 2.6), t.halfWidth - 2.6);
    const offset = offTrack > 3 ? 0 : raceOff * (1 - laneBlend) + laneOff * laneBlend;
    const lp = t.pts[li], ls = t.side[li];
    const tx = lp.x + ls.x * offset, tz = lp.z + ls.z * offset;

    const dx = tx - c.pos.x, dz = tz - c.pos.z;
    const rf = c.rightSide;              // 车身真正右侧（不是局部 +X！）
    const ff = c.fwd;
    const rlen = Math.hypot(rf.x, rf.z) || 1e-3;
    const flen = Math.hypot(ff.x, ff.z) || 1e-3;
    // angRight > 0 表示目标点在本车右侧；input.steer>0 也是"向右"，符号天然一致
    const angRight = Math.atan2((dx * rf.x + dz * rf.z) / rlen, (dx * ff.x + dz * ff.z) / flen);
    c.input.steer = clamp(angRight * 1.8, -1, 1);

    // ---- 3. 纵向：±2km/h 内收油滑行，带有限速率的油门/制动 ----
    const speedControl = this.computeAISpeedControl(
      c.speed * 3.6,
      vTarget * 3.6,
      dt,
      c.aiSpeedControl || c.input,
    );
    c.aiSpeedControl = speedControl;
    c.input.throttle = speedControl.throttle;
    c.input.brake = speedControl.brake;

    // ---- 4. 前车避让：正前方（随车速缩放的前视距离）内横向重叠且正在接近 -> 收油轻刹 ----
    // 没有这一层，四台 265km/h 的车在第 1 弯必然堆叠，被撞飞的会一路冲出赛道走廊。
    // 前视距离必须随速度缩放：固定 15m 在 60m/s 时只有 0.25s 反应时间，等于没有。
    const avoidLook = 10 + c.speed * 0.38;
    for (const o of this.cars) {
      if (o === c) continue; // 退赛车的碰撞体仍在赛道上，也必须避让。
      const rx = o.pos.x - c.pos.x, rz = o.pos.z - c.pos.z;
      const d = Math.hypot(rx, rz);
      if (d > avoidLook || d < 0.1) continue;
      const ahead = (rx * c.fwd.x + rz * c.fwd.z) / d;
      if (ahead < 0.72) continue;                       // 不在正前方（含并排）
      const lat = Math.abs(rx * c.lateralDir.x + rz * c.lateralDir.z);
      if (lat > 2.8) continue;                          // 横向已错开
      if (c.forwardSpeed <= o.forwardSpeed + 0.5) continue;  // 没在接近
      c.input.throttle *= 0.2;
      c.input.brake = Math.max(c.input.brake, 0.25);
      break;
    }
    return c.input;
  }
}
