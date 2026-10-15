# 参考手册 · 极限竞速 · LAN

> MEMORY.md 的**细节展开**。只在需要具体数值/坐标/命令时读本文件；
> 结论与红线在 MEMORY.md。日志在 `YYYY-MM-DD.md`。
>
> 本手册包含早期程序化赛道与主线程物理的历史参数；当前 Worker 架构、道路分层、救援与验收结果以源码、`2026-10-05.md` 和部署指南 §6.9 为准。下文旧几何值不能作为当前 1:1 复刻证据。

## 赛道几何（实测数值）
- **铃鹿**：Gerono 双纽线 8 字立体交叉 + 径向调制。6755m，1440 采样点，spacing 4.691m，
  24 CP，最小半径 49.4m，桥面 +7.5m（RAMP 235m / FLAT 72m），交叉处净空 7.96m。发车格 idx≈1432~1434。
- **拉斯维加斯**：1.99km 全油门大直道 + 4 个 90° 直角弯 + 绕 Sphere 球馆（圆心 560,470 / r=178）；
  固定场地，布局不随 seed 变；无立交。
- **斯帕**：细长三角形，7013m，落差 14.6m（欧鲁日 +14.5m），最小半径 31.7m @i=76，0 自交，
  28 CP，`smooth: 2`，`SPA_SCALE = 1.42`。`SPA_WP[0]` 必须是发车线且在直道上。
- 净空安全：`CLEAR_ANCHOR_M = 14.0`（半宽 7 + 路肩 2 + 缓冲 5）、`CLEAR_REJECT_M = 13.5`、
  `clearOK(lat)`。三赛道 `minScatterLat` 均 14.20m。旧口径 `半宽+4.5=11.5m` 没算路肩，会放行 13.4m 路灯。
- 护栏 per-track 开关：vegas/spa 全线 720 段；铃鹿刻意不布防（靠 42m 草地脱困）。

## 物理参数全集
- 质量 1380kg / 质心高 0.45m / 轴距 2.70m / 轮距 1.6m / 配重 52:48
- 峰值 450N·m@4500rpm，红线 7500rpm，6 档 + 主减 3.55，换档切断 0.12s
- Cd=0.34 / A=2.1 / Cl=0.85；极速 265km/h、0-100 3.87s
- 悬挂：K=225.6kN/m、C=35.3kN·s/m（ζ=1），冲程上限 0.30m
- 抓地基准：常规前 2.6 / 后 2.4；手刹前 3.2（严禁抱死）/ 后 0.45
- 沙地：`OFFROAD_FRICTION_SLIP = 0.65`、`ROLL_SAND_K = 0.18`、`driveCap = offRoadMu * FzRear`
- `MU_SLIP_FLOOR = 0.45`、`CFG.START_LANE_M = 200`
- 相机：车后 5.5m/1.8m、注视点车前 8m、FOV 60→72@200km/h、`1-exp(-12·dt)`

## 碰撞参数（cannon 材质层）
- `contactEquationStiffness = 5e5` + `contactEquationRelaxation = 6`
  （别写进另一组 `frictionEquation*`，那是 1e7/3）
- 车车/护栏 restitution `0.02`（`CFG.RESTITUTION`/`CFG.BARRIER_RESTITUTION`）/ friction 0.55
  —— **只影响弹性项，不影响 Baumgarte 偏置**（后者必须另行剥离）
- 低速剐蹭粘性软接触：阈值 4.0m/s、法向弹开冲量削 90%；撞击步登记带 TTL 的接触对，
  随后每步把"正在分离"的法向速度削 75%
- 静态赛道刚体必须在 `RacePhysics` 构造里注册：`registerTrackBodies(world, track, barrierMaterial)`
  + 静态体 `GROUP_BARRIER`。护栏物理高 1.4m（hy 0.7），restitution 0.0 / friction 0.45
- 桥墩避让：柱子按地面层（`Track._groundLatAbs`）外推到 `±(半宽+3.5)`，桥下净空 ≥16m

## JS 碰撞求解规格（`public/js/physics.js`）—— 游戏实际跑的路径
**核心补丁**：`installCannonBaumgarteKill()` monkey-patch `CANNON.ContactEquation.prototype.computeB`，
对车相关接触**临时把 `bj.position` 沿 `n` 平移 `−g`** → 调原始实现 → **立即还原**，
从而让 `-g*a` 项恒为 0（穿透深度不再变速度）。幂等键是**实现自身**（`patched.__isBaumgarteKill`），
不是模块布尔（否则测试无法 ON/OFF 切换）。构造函数赋 `this.baumgarteKilled = installCannonBaumgarteKill()`。

`CFG` 新字段（旧 `REST_LO/REST_HI/REST_*_SPEED`、`NORMAL_Y_SLOP/NORMAL_Y_ABORT`、`PEN_MAX_MS`、
`BAUMGARTE_*` 全部**已删**）：
| 字段 | 值 | 规格 |
|---|---|---|
| `PLASTIC_E_PEAK` | 0.05 | §2 低速峰值恢复系数 |
| `PLASTIC_V_THRESH` | 1.5 | §2 塑性阈值（m/s），以上**严格 e=0** |
| `NORMAL_FLAT_EPS` | 1e-6 | §1 水平分量低于此 = 纯垂直 → 放弃解算 |
| `PUSH_MAX_M` | 0.03 | §3 单子步最大推开位移（m） |
| `IMPULSE_MAX_NS` | 40000 | §5 单 Contact 最大法向冲量（N·s） |
| `SUSP_LOCK_SLACK` | 0.15 | §4 锁定后行程上限 = SLACK × `SUSP.MAX_TRAVEL` |
| `SUSP_LOCK_T` | 0.25 | §4 碰撞后解耦窗口（s） |
| `PEN_BETA` / `PEN_SLOP` | 0.8 / 0.005 | 位置相（保留） |

- `restitutionFor(speed)`：严格两段线性（非有限值 → 0；`thresh<=0` → 0；`v>=thresh` → **0**；
  否则 `PEAK·(1 − v/thresh)`）。
- `redirectNormal(nx,ny,nz)`：**无条件**抹平（水平模长 < EPS → `null`；否则 `{x/l, 0, z/l}`）。
- `projectPenetration(dt)`：用补丁存下的 `eq.__lastPenetration`（回退 `penetrationVec`）；
  `want = min(PEN_BETA·pen, PUSH_MAX_M)`；**每对接触体只推一次**（`_pushQuota` Set，4 点流形不推 4×3cm）；
  记录 `this.lastPushMax`。
- `onCarCollide`：法线无条件抹平；触发 `car.suspLockT = max(car.suspLockT, SUSP_LOCK_T)`（对方 ×1.4）；
  `J = min(Δv/invSum, IMPULSE_MAX_NS)`；`car.shellHits++`。
- **`onBarrierCollide(car, e)`**：静态护栏碰擦（静态体无 `__carId`，`onCarCollide` 会早退）→ 触发 §4 锁。
  经第二个 `body.addEventListener('collide', ...)` 接线。
- `groundConstraint(c, dt, post)` §4：锁的是**行程上限**（不是行程值），
  指数恢复 `k = engaged ? 1−exp(−18dt) : 1−exp(−6dt)`；超出上限的部分走 `SUSP.BUMP_STOP`。
- `Car` 新增 `this.suspLockT = 0; this.suspLimit = undefined`。

**实测证据**（`tools/selftest.mjs` 内嵌 headless cannon 世界，200km/h 撞 5° 倒角墙）：
| | 反弹速度 | 反弹动能 |
|---|---|---|
| 原版 cannon（patch OFF） | **1.1458 m/s** | **905.9 J** |
| 打补丁（patch ON） | **0.0071 m/s** | **0.0 J** |
| 削减 | **99.4%** | — |
> 905.9 J = ½·1380·1.1458² —— 纯粹由 `-g*a` 白送的动能。
> ⚠️ selftest 必须在**任何模块可打补丁之前**捕获 `CANNON_TRUE_ORIGINAL_COMPUTEB`，否则"反证"拿到的是补丁版。

独立闸门：`node tools/verify_baumgarte.mjs`（exit 0/1），判据 `on.rebound ≤ 0.1 m/s` **且** `cut ≥ 90%`。

## `native/safe_physics/` 参数与基线 —— 现行权威实现
**`SafePhysicsSolver`**（纯 C++20 / 零依赖自带 `Vec3` / 零堆分配 / 无虚函数 / 无异常）。
头文件 `safe_physics/safe_physics_solver.h`，测试 `safe_physics/safe_physics_test.cpp`。

`SolverConfig` 字段（规格 §1~§5）：
- `flattenStaticNormal = true`、`normalFlatEps = 1e-6f`（水平分量模长低于此 = 纯垂直 → 放弃解算）
- `plasticThresholdSpeed = 1.5f`、`plasticPeakRestitution = 0.05f`
  → `|v_rel| < 1.5 : e = 0.05·(1 − |v_rel|/1.5)`；`|v_rel| ≥ 1.5 : e = 0.0f`（**严格**）
- `maxPushPerSubstep = 0.03f`（m，**位移**上限，不是速度）、`positionBeta = 0.8f`、`penetrationSlop = 0.005f`
- `maxNormalImpulse = 40000.0f`（N·s，单 Contact 硬上限）
- `friction = 0.55f`、`maxTangentImpulse = 20000.0f`
- `suspensionLockSlack = 0.15f`、`suspensionMaxTravel = 0.30f`、`shellContactMinSpeed = 1.0f`

关键推导（写进代码注释，也在此备查）：
- **Baumgarte 偏置 `a` 的来源**：cannon `setSpookParams` → `a = 4/(h·(1+4d))`。
  本工程 `h = 1/60`、`d = CONTACT_RELAXATION = 16` ⇒ `a = 4/((1/60)·65) = 240/65 = 3.6923`。
  对 pen=0.20m：`-g·a = 0.20 × 3.6923 = +0.7465 m/s` 直接注入 `body.velocity`（实测 ΔB 与该值**精确相等**）。
- **摩擦符号**：`t_dir` = 切向相对速度方向；冲量按 `v −= J/m` 施加 ⇒ 会取反 `J`。
  正解 `jtVec = tDir · limit`，`limit = min(μ·J_n, maxTangentImpulse, jtStop)`，`jtStop = vTanLen / kTangent`。
  反例（bug）：`jtVec = tDir · (−jtStop)` ⇒ 顺滑动方向加速（实测 `vt 40 → 48.25 m/s`，动能 +27.6%）。
- **空过陷阱**：`fabs(min(v_n, 0))` 在 `v_n > 0` 时恒返 0 → 假绿。用 `SeparationSpeed(vn) = (vn<0)?−vn:0`。
- **0.03m/子步帧数**：`frames ≈ ceil((pen − slop)/0.03)` ⇒ 0.12→5、0.15→6、0.20→7、0.25→9、**0.30→10**。
  规格"5~10 帧"对应穿透 0.12~0.30m（算术结论，断言钉式子不钉魔法数）。
- **偏心接触**（力臂 `rA = {0,0.45,0}`）：冲量在线性/角向间分配，线性相对速度**不归零**而**接触点**相对速度归零。
  正撞实测 `va=+3.733, vb=−3.733, ωa.z=+8.295, ωb.z=−8.295`。

基线：单测 **117 项 / 0 失败**（A~G 节）。`kSpecMaxSeparationSpeed = 0.5f`、`kRelSpeed200kmh = 55.556f`。
- 200km/h **侧撞** 碰后法向分离速度 = `0.000000`；**正撞** = `0.000000`（**≤0.5 m/s 规格达成**）
- 撞墙 `vRel_after = +26.570`，`clampedNormal == 1`（冲量截断生效）
- G7 摩擦耗能 `E 1259250 → 695563` J

## `native/safe_collision/` —— 【deprecated】兼容转发层
`SafeCollisionResolver` 已改为**薄转发**，全部转调 `SafePhysicsSolver`（旧名保留 inline 别名）。
`ResolverConfigLegacy` 是**独立 `final` struct**（不能继承 `final` 的 `SolverConfig`），
含规格字段 + 旧字段 + `ToNew()`；**旧字段被 `ToNew()` 忽略 ⇒ 惰性**。
- 旧名 ↔ 新名：`RedirectNormal`→§1、`RestitutionFor`→§2、`SolveVelocityPhase`→速度相、
  `ProjectPenetration`→位置相、`Resolve`→全流程、`ResolverConfig`→`ResolverConfigLegacy`
- `SolveStats` 新增**【deprecated 兼容名】`redirectedNormals` ≡ `flattenedNormals`**（二者同增同减），
  供旧调用方（`harness/simulation_harness.cpp`）继续读取。
- **惰性证明**（回归测 **38 项 / 0**）：把 `restLow=0.9` / `penMaxStep=0.25` / `normalYSlop=0` /
  `maxLeverArm=99` 全部改掉，结果**逐位不变**（`BitEqual`）。
- ⚠️ `maxNormalImpulse` **是规格字段**（被 `ToNew()` 拷贝）—— 改它**会**生效，别当旧旋钮。

## `native/timesync/` 参数与基线
`ForzaTimeSynchronizer`（双端通用：Linux 原生 / Emscripten Wasm，C++20，零堆分配）。
- 时钟源优先级：Wasm `emscripten_get_now` / Win `QueryPerformanceCounter` /
  Linux `CLOCK_MONOTONIC_RAW` → 回退 `std::chrono::steady_clock`
- `SyncConfig`：`windowSize=30`、`bestRatio=0.20`（前 20% = 6 个低 RTT 样本加权聚合）、
  `deadbandNs=1ms`、`slewUpperNs=100ms`、`hardResyncNs=250ms`、`maxWarpRatio=0.015`、
  `slewGain=0.1`、`maxRttNs=500ms`、`hardSyncGraceNs=300ms`；`kMaxWindow=32`
- 权重 `w = 1/(rtt+1ns)`（**不是** 1/rtt²，平方会退回单点极值、方差反而变大）
- 接口（规格名）：`PushPingSample(t1..t4)` / `GetAdjustedDeltaTime(baseDt)` / `GetServerTime()`
  旧名 `OnPong` / `AdjustedDeltaTime` / `ServerNowNs` 保留为 inline 别名
- 遥测：`TargetOffsetNs()` / `ResidualNs()` / `BestSetSize()` / `BestRttNs()` /
  `CurrentWarp()` / `CurrentOffsetNs()` / `SampleCount()` / `State()` / `IsLocked()`
- 基线：C++ 单测 **50 项**全绿（T1/T2/T2b/T3/T3b/T4/T4b/T5/T6/T7）；
  Python 镜像 `verify_algorithm.py` 28 项全绿（T3b 峰值残差 131ms → 末态 0.015ms）
- T3b 阶跃用例必须**同时注入 offset 阶跃**（只改单程延迟不改 offset ⇒ 空跑假绿）

## `native/harness/` 参数与基线
- 混沌：单向 80ms 均值 / 高斯抖动 20~150ms / 丢包 10% / 乱序 18%（压后 +45ms）
- 场景：Phase1 对向 100+100km/h（闭速 200km/h）；Phase2 A 以 55.56m/s、8° 蹭墙（真求解器）
- 基线（12s）：**25 断言全绿**；RMSE 1.22m（< 预期滞后 2.10m）、最大误差 2.19m、0 次跳跃；
  动能 **2129629.5 → 467494.9 J**（Δ=−1.66e6）、残速 15.46 ≤ 55.56m/s、**垂直位移 y=0.000000m**、
  `重定向 1 次 / 冲量截断 1 次 / 位置投影 1 次`
- 稳健性：seed 1~10 × 时长 12/20/30/45s = 40/40 全绿
- 跑法：`native/harness/run_harness.sh`，或 `-q/-v --seed=N --sec=N`

## `native/mp_chaos/` 参数与基线 —— 单机无头多人混沌仿真台
- 拓扑：1 权威服务端 + 4 客户端（Client 0 本地带渲染平滑层 + Bot 1~3 无头）。
  **仿真-墙钟替代真线程/sleep**：单线程确定性，同 seed ⇒ 日志逐字一致（可当回归基线）。
- 混沌信道 `ChaosConfig`：`rttMeanMs=100`、`jitterLoMs=20` / `jitterHiMs=160`、
  `jitterMedianMs=50`、`sigmaLog=0.55`（**对数正态**长尾）、`lossRate=0.08`、
  `reorderRate=0.05`、`reorderLeadMs=12`（"抢跑"造成真实 seq 倒挂）。
- 场景时间轴：`[0,3)` 暖机 · `tBarrier=3.0s` Bot1 撞护栏（180km/h 目标） ·
  `tRearEnd=6.0s` Bot1 追尾 Bot2 · `tSteady=8.5s` 稳定巡航 + HUD 采样起点 ·
  `tSlipDown=10.5s` 本地车"进站"重刹（覆盖 HUD 非领先分支）· 默认时长 16s。
- 关键常量：`kCarMassKg=1380`、`kCarHalfLenM`、`kCarHalfWidM`、
  `kCarYawInertia=2850`（= `m(L²+W²)/12`）、`kCarInvYawInertia=1/2850`、`kTickSec=1/60`。
- 抖动检测器 `JitterDetector`：`stepLimitM = speed·kTickSec·4 + 0.75`；
  `jerkLimitMs3 = 3·(2v)/kTickSec²`；三阶差分链 `pPrev/vPrev/aPrev`；`holdFrames` 恢复窗 24 帧。
- 基线（seed 20260925，16s，960 tick，墙钟 32ms ⇒ **30,968 fps**）：
  · Phase A：丢包 **7.80%**、抖动 **[20.0, 160.0]ms**、max/mean **2.77**、
    乱序 **9337**（注入抢跑 532）、滑窗 RTT mean **19.2ms**、锁定=是、`|warp| 0.046%`
  · Phase B：RMSE **1.2195m**（< 1.8×预期滞后 5.836m）、最大误差 2.3935m、
    单帧突变 **0** 次（阈值 4.471m）、**Jerk 峰值 163181 m/s³**（上限 1205697）、Jerk 尖峰 **0** 次
  · Phase C：采样 450 次，**P1 分支 331 次（`--`） / 落后分支 119 次（`-0.6`）**，后车行恒负
  · Phase D：护栏反弹 **+0.0000 m/s**、`|vy|max 0.00000`、
    追尾接触点法向 **−18.29 m/s**（负=无弹开）、动能 **2573890 → 7498 J**、
    平整化 2 / 截断 1 / 投影 2 / 悬挂锁定 0
  · Phase E：**30,968 fps**、RTT 19.2ms、闪现 0、Jerk 尖峰 0
- 稳健性：seed 20260925 / 1 / 12345 / 777777 全部 **28/0**；同 seed 两次输出逐字一致。
- 跑法：`native/mp_chaos/build/mp_chaos.exe [-q|-v] [--seed=N] [--sec=16] [--hud-every=180]`。
  编译须 `-I timesync -I rb_replicator -I safe_physics -I race_delta` + 真 GLM；
  链接 `timesync/forza_time_sync.cpp` + `race_delta/race_delta_tracker.cpp`
  （**`rb_replicator` 是 header-only，不要加它的 .cpp**）。

## `native/run_tests.sh` 八节结构（411 断言 / 0 失败）
`[1/8]` timesync 50 · `[2/8]` rb_replicator 35 · `[3/8]` wasm host 19 · `[4/8]` **safe_physics 117** ·
`[5/8]` safe_collision（deprecated 兼容）38 · `[6/8]` race_delta 62 · `[7/8]` harness 25 ·
`[8/8]` **mp_chaos 28**（+ 确定性回归 1）
（另含 race_delta_python 37、wire 8/8、layout 19）。`[4/8]`/`[7/8]`/`[8/8]` 需真 GLM，不回退 shim。

## 秒差管线（全工程唯一一套符号）

> **`deltaMs > 0` = a 领先 b；`< 0` = a 落后 b。反对称：`Solve(a,b) == -Solve(b,a)`。**
> Go / C++ / JS 三侧同一个约定。历史名 `gapBehindMs`（正 = 落后）已**整条删除**，
> 任何地方再出现「正 = 落后」的口径都是 bug。

- Go `solveDeltaMs(a,b)`（main.go）：
  · 双车已完赛 → `(b.total - a.total)*1000`
  · 圈数不同 → `float64(a.lap-b.lap) * lms`
  · 同一 Checkpoint → `tb - ta`
  · 起步兜底（`cp` 尚为 -1）→ 先按 `progressScore` 判谁在前
    （`aAhead := progressScore(a) > progressScore(b)`，**注意是 `>` 不是 `<`**：
    `cp=-1` 时 score 为负，比较符写反会把领先/落后角色对调），
    再拿**前车**速度 `v`（km/h，`<=0` 取后车，`<20` 夹到 20）折算 `mag = meters/mps*1000`，
    领先方返回 `+mag`、落后方 `-mag`。**禁止用两车平均速度**（会失真）。
- 权威榜单：20Hz 广播 `LEADERBOARD_UPDATE`，字段
  `{id,name,color,pos,lap,pen,fin,gap,int,behind}`：
  · `gap` = 相对 P1 的有符号秒差（P1 恒为 `0`，客户端渲染金色 `LEADER`）
  · `int` = 相对**前一位**的间隔
  · `behind` = 相对**后一位**的秒差（`solveDeltaMs(me, next)`，正 = 我在他前面）；末位为 `null`
- 客户端上报 60Hz：`maybeSendState(car, now, track)` 发 `c: cpIdx` 与 `n: distNext`（米），
  `distNext` 由 `track.checkpoints[(cpIdx+1)%n].pos` 算；**服务端起步兜底吃这两个字段**。
- 位姿：服务端 60Hz（`16666µs` Ticker）广播；客户端上报同 60Hz
- 远端插值：30 帧环形缓冲 + `renderDelay = clamp(3σ,60,120)`（样本 <8 兜底 80ms）
  + Hermite 位置 + SLERP 姿态 + 单调时钟（`monoMs`/`mts`）+ 丢包按速度直线外推（250ms 上限）
  + 指数误差融合（`ERR_BLEND = 12`）；时钟同步 = 长度 10 滑窗取最小 RTT，PING 1Hz
  （**Web 前端 JS 侧**仍是这个旧口径；C++ `native/timesync` 侧已是 30 窗 / 前 20% 加权，
   两套并存是既知状态，前端要迁移需单独决策）
- Clock Slewing：`CFG.MAX_TIME_WARP = 0.015`、增益 0.1，走 `S.simOffset`
- ~~Baumgarte 截断：`BAUMGARTE_BIAS_V = 2.5` / `BAUMGARTE_IMPULSE = 50000`~~
  **已删除**（三者连同 `BAUMGARTE_BETA` 一起移除）—— 见下面「JS 碰撞求解规格」。

## `native/rb_replicator/` 参数与基线
航位推测 + 双层解耦平滑（C++20 / GLM / 零堆分配）。
- `ReplicatorConfig`：`halfLifeSec 0.080`（半衰期，衰减 `k = exp(-dt·ln2/T½)`，**ln2 不能漏**）、
  `maxExtrapolationSec 0.150`、`coastHalfLifeSec 0.600`、`accelTrustSec 0.100`、
  `omegaTrustSec 0.150`、`snapDistanceM 5.0`、`snapAngleRad 0.9`
- `Update(dt)` 两相：
  · A-1 外推（`extrapolated_ < maxExtrapolationSec`）：`p += v·dt + ½a·dt²`、`v += a·dt`，
    角速度同步积分
  · A-2 阻尼滑行（超 150ms 后）：位置继续推进 `p += v·dt`，速度/角速度乘
    `kc = DecayFactor(dt, coastHalfLifeSec)`；`coasting_ = true`
  · B 视觉衰减：`visOffRot_ = ShortArc(identity, visOffRot_)` 后
    `slerp(identity, visOffRot_, k)`
- 双层：`render = phys + visualOffset`；收到权威包时 `phys = 权威值`、
  `visualOffset = 当前渲染值 − 新 phys`（只把**修正差值**叠进视觉层，视觉连续）
- **短弧四元数（`dot(q1,q2) < 0` 反转）三处都要**，缺一处就出「长弧翻滚」：
  · ① 入包姿态写进 `physRot_` 前
  · ② 误差四元数 `visOffRot_`
  · ③ 每帧 slerp 衰减前
  · ② 最关键：长弧会让 `glm::angle()` 把 2° 报成 358°，**假触发** `snapAngleRad` 吸附
- 基线：C++ 单测 **35 项**全绿（T1~T8）；Python 镜像 `verify_blending.py` V1~V7 全绿
  （150ms 上限 → `x=8.25m`；滑行 1s 55→17.32m/s、实走 32.9m vs 朴素 55m；
  短弧 `-q` → 0.000° 而非 358°）

## `native/race_delta/` 参数与基线
赛事规则秒差计算与格式化（C++20 / 零依赖 / 零堆分配；Go 与 JS 各有对应实现）。
- **格式化分层（`DeltaFormatter`）**：`kDeadbandMs = 10.0`、`kTwoDecimalFromMs = 10000.0`、
  `kClampMs = 999900.0`。判定序：NaN/Inf → `"--"`；夹取；死区；取绝对值格式化后**手工前置符号**
  （避免 `"--0.0"` 与跨平台 `-0.0`）
  · `<10ms` 死区（仅榜首真平局）→ `"0.00"`
  · `<10s` → 1 位小数（`"-0.0"`/`"±X.Xs"`）
  · `≥10s` → 2 位小数
- **`deadband` 与 `forceNeg` 是两个正交开关**：
  · 榜首行（本地 = 第一，比 P2）→ `deadband=true, forceNeg=false`
  · 后车行 / 本地非领先行 → `deadband=false, forceNeg=true`（**+3ms 噪声也必须带负号**，
    绝不能印成 `"0.00"`）
- **样条距离时间差**：`ΔS = S_leader − S_follower`（wrap 感知取最短有符号），
  `ΔT = −ΔS / v_seg`，`v_seg` 是**前车**在该赛段的弧长速度（ds/dt，EWMA `kSpeedEwmaAlpha=0.25`），
  **不是后车速度**。用后车速度会在出弯畸变（30m：前车 20m/s vs 后车 40m/s → 正解 1500ms、错解 750ms）
- `kMinSegSpeedMps = 12.0`（速度下限兜底）、`kDefaultLapSec = 60.0`（圈差兜底）、
  `kMaxCtl = 64`、`kMaxSeg = 1024`
- 方法枚举 `DeltaMethod{None, Checkpoint, SplineExtrap, LapDelta}`
- 基线：C++ 单测 **62 项**全绿（T1 格式化 / T2 领跑 / T3 落后 / T4 尾随 /
  T5 无出弯畸变 1500 vs 750 / T6 圈差 / T7 样条完整性 / T8 符号与边界 / T9 赛段速度 EWMA）；
  Python 镜像 `verify_race_delta.py` **37 项**全绿（独立复核方形样条 `L ≈ 420.3797` 与 C++ 一致）
- 测试常量必须与默认值解耦：断言里禁写死全长/单圈秒数/采样间距
- Predictive Ghosting：`PRED_GHOST_MS = 22.2` / `PRED_GHOST_TTC = 0.15` / `PRED_GHOST_SEP = 3.5`；
  `GROUP_CAR_BASE = 3`、`GROUP_CAR_MASK = 0xF8`，`_refreshMasks()` 是唯一掩码来源；
  半透明 0.35 走 `c.pgGhost` → `ud._pgAmt` 指数缓动

## `native/wasm/` —— Emscripten 宿主层（唯一交付面）

> `wasm_bindings.cpp` + `NetworkEngine.ts` + `build_wasm.sh` 是权威实现。
> `NetworkPhysicsClient.ts`（旧单车主，`createNetworkPhysics`）、`web/`（`_forza*` 符号）、
> 顶层 `wasm/`（第三份旧副本）都**已过时**；改动只进 `native/wasm/`。

### 两条通道的划分
| 频率 | 通道 | 形式 |
|---|---|---|
| 60~144Hz | 高频（位姿） | 裸 `extern "C"` + 内存指针，`HEAPU8.set` → 零参 `_fz_snapshot_commit()` |
| 低频（UI/遥测/文本） | Embind | 值对象 `syncTelemetry()` / `replTelemetry()` / `leaderboard()` |

Embind 每次调用都要构造 `val` + 堆分配返回对象，热路径上必炸；`memcpy + void call` 近乎免费。

### 零拷贝暂存区
- `snapshotStage_`：1 个 `RigidBodyNetSnapshot`，**96B**，16 对齐
- `matrixStage_`：4 槽 × 16 float = **256B**，`alignas(16)`，`MatrixSlot{Visual=0, Physics=1, Reserved2, Reserved3}`
- 远端多车：`slots_[kMaxVehicles=16]`，每槽 `matrix[16]`，`base + slot*64` 寻址
- 调度统一 `SlotFloats = 64B`；实测 `slot1 − slot0 = 64`

### 96B 工作结构字段偏移（`static_assert` 钉死）
`frame`(u32@0) / `tickMs`(u32@4) / `serverTimeSec`(f32@8) / `position`(vec3@16) /
`rotation`(quat@32，**w 在前**) / `velocity`(vec3@48) / `angularVelocity`(vec3@64) / `accel`(vec3@80)
→ 载荷 76B + 填充 20B（5×4B）。**手工填充而非 `#pragma pack(1)`**：非对齐 vec3 在 ARM/NEON 上会 trap。

### 32B 紧凑线格式（`snapshot_wire.h`，规格 32~48B 约束）
8 × u32 = 256 位，**载荷 242 位** + 6 保留。`kWireBytes = 32`、`kWireWords = 8`。

| 字段 | 位偏移 | 位宽 | 倍率 | 量程 / 分辨率 |
|---|---|---|---|---|
| frame | 0 | 16 | — | 65536 帧（~18min @60Hz） |
| tickMs | 16 | 16 | — | 65.5s 模 |
| posX/Y/Z | 32 / 48 / 64 | 16 各 | 8 | ±4096m / 0.125m |
| velX / velY / velZ | 80 / 94 / 108 | 14 各 | 64 | ±128m/s / 1/64 |
| rotX / rotY / rotZ | 128 / 144 / 160 | 16 各 | 32767 | 单位四元数 xyz |
| accX / accY / accZ | 176 / 188 / 200 | 12 各 | 128 | ±16m/s² / 1/128 |
| omegaX / omegaY / omegaZ | 212 / 224 / 236 | 12 各 | 256 | ±8rad/s / 1/256 |

- **跨字**：`velY`(@94+14=108 越 96)、`accY`(@188+12=200 越 192) 两处跨 u32 边界；
  `omegaX`(@212+12=224) **恰好落在字边界、不跨字**（曾误以为跨字而写错断言）。
- **四元数只传 xyz**，`w = sqrt(max(0, 1−x²−y²−z²))` 恢复 ⇒ **恒 w ≥ 0**，天然是短弧规范形。
  （`q` 与 `−q` 同姿态，只传 xyz 使两者编码同一份字节；测试有专门断言。）
- **量化必须逐值等于 JS `Math.round` = `std::floor(x + 0.5)`**（半值朝 **+∞**）。
  `std::nearbyint` 是银行家舍入、`round()` 是远离零 —— **都错**。
  scale=8 让 `0.0625/0.1875/0.3125` 全是精确半值，**不是边角料**。
  定点测试钉的值：`0.0625→1`、`-0.0625→0`、`0.3125→3`、`-0.1875→-1`、`-0.3125→-2`。
- 越界**饱和**（不环绕）：`QuantizeSat` 夹到 `±(2^(bits-1)−1)`。

### ABI 三件套（缺一即静默失效）
| 旗标 | 缺失后果 |
|---|---|
| `-sNO_EXIT_RUNTIME=1` | `main` 返回后运行时被拆（atexit 注销、stdio 关闭、`runtimeExited` 置位）→ **后续所有 Wasm 调用静默变 no-op** |
| `-sALLOW_MEMORY_GROWTH=1` | 堆增长会**换掉底层 ArrayBuffer** → 缓存的 `HEAPU8`/`HEAPF32` 视图失效。**每次访问都要重取**；矩阵视图每帧重建（轻量视图构造，不是拷贝） |
| `-sEXPORTED_RUNTIME_METHODS=['HEAPF32','HEAPU8']` | 前端拿不到堆视图 |

另：`-O3 -flto -msimd128 -sSINGLE_FILE=1 -sEXPORT_NAME=createForzaNet`（工厂是 **default 导出**）。
**`-msimd128` 会改 ABI** → 所有调用方（含 node 冒烟版）必须同开。
构建必须 `EM_FROZEN_CACHE=1`（本机批量删除保护会把 emcc 缓存清理判为失败）且用 `em++`。

### 多车注册表（`vehicle_net_registry.h`）
- `kMaxVehicles=16`、`kDeltaTextCap=24`、`kMatrixFloats=16`
- **每车独占一个 `NetworkRigidBodyReplicator`** —— 共用一个会让四车"粘在一起抖"
  （单车测不出来，必须有"两车矩阵 x = ±100 互不影响"的断言）
- `EnsureVehicle` 对新槽施加 `cfg_`；`NoteSnapshotFrame` 做 **u32 回绕感知**去重
- `BuildLeaderboard` 按 `lap*1e7 + sMeters` 降序插入排序；P1 走
  `FormatLocalRow(..., localIsLeader=true)` → `"--"`；其余 `Solve(v.delta, leader)`

### 前端契约（`NetworkEngine.ts`）
- 不可靠通道：`{ ordered: false, maxRetransmits: 0 }`；控制通道（PING/房间/榜单）**必须可靠有序**
  （丢一个样本只是少一窗数据；但 PONG 乱序会让 `t1` 回滚被拒收）
- 背压：`bufferedAmount > 64KB` 跳帧（"最新覆盖旧"，快照不排队）
- **`send()` 是异步的** → 发之前必须 `buf.slice(0)`：暂存区下一帧就被覆写，
  直接发视图会发出半新半旧的垃圾；且堆增长可能换掉 buffer
- **零拷贝收包**：读 offset 0 的 u32 id → `HEAPU8.set(new Uint8Array(data,4,32), stageBase + slot*32)`
  → `_fz_update_remote_state(id, stage, 0)`（在 Wasm 内存里**直接解包**，不过 JS 对象）
- 渲染：`new Float32Array(HEAPF32.buffer, addr, 16)` → `matrix.fromArray(...)`，
  `matrixAutoUpdate = false`
- 浏览器时钟精度：`emscripten_get_now()` 建在 `performance.now()` 上，Chrome ≈100µs / Firefox 1ms
  （Spectre 防护主动降精度）。"纳秒"只是类型上的余量，要更高精度需 COOP/COEP + `SharedArrayBuffer`

### 基线
| 层 | 数 |
|---|---|
| `wasm_bindings_test.cpp`（原生：线格式 + 注册表 + HUD） | **116 / 0** |
| `verify_engine_wire.mjs`（TS 位打包器 vs C++ **逐字节**） | **8 / 8** |
| `verify_layout.mjs`（跨语言布局一致） | **19 / 0** |
| `smoke_test.mjs`（**真 Wasm 产物**，node 变体） | **75 / 0** |
| 产物体积 | web 132K / node 134K（SINGLE_FILE 自带 wasm） |

**跨语言逐字节对拍是唯一能发现量化口径不一致的手段** —— JS↔JS 自测永远看不见。
`verify_engine_wire.mjs` 的 TS 打包器**只从 dump 的位表读取**偏移/位宽，
不硬编码任何常量，以排除"两边同错"。

## HUD / 视觉
- FM8 布局：左上 4 列计时塔（名次/车手/秒差/处罚）+ 圈速框；右上 圈 N/M + 分组；
  左下圆形微缩地图；右下大号环形转速表（`GAUGE.MAX_RPM=7500`，环与指针按转速驱动；
  中心大档位、下方车速）+ 遥测 + 油量条。自己那行蓝色高亮 `rgba(58,140,255,.15)`
- 尾流涡线（`VortexFX`，main.js §10.65）：`AdditiveBlending`、alpha 0.25、`depthTest: true`；
  寿命 0.10~0.20s、流速 `clamp(speed*0.55,14,30)`；宽度 0.16~0.30m；
  发射点：尾翼 `x=±1.00,y=0.50,z=-1.95`、引擎盖 `x=±0.95,y=0.30,z=+1.30`；入口 `?draft=1`
- FRR 裁决：均速/油门占比/刹车占比 → 全油门+高速阶梯罚 1.0~3.0s；松油/刹车/掉速免罚
  （只 `console.info`）。基准 = 沥青上 EWMA（下限 25m/s）。`#frrBanner` 只在裁决类罚时弹

## 性能基线
- 几何：26.6k 顶点 / 29 个顶层 Mesh（7 个 InstancedMesh 批处理树木路灯山脊）
- 仿真：4 车 547s = 32,820 步，Node 约 1s；浏览器 drawCalls ≈65 / tris ≈5.8 万
- 单圈：AI 约 113.5s @ 平均 214km/h（四车一致性 < 0.5s）
- 漂移 FX：烟雾 200 粒子池（Points + 自写 GLSL），胎痕 900 quad 环形复用

## 调试入口
`solo=1` `seed=` `laps=` `track=suzuka|vegas|spa` `drift=1` `rescue=1` `draft=1`
`ghost=1` `cam=0|1|2` `dbg=1`（读数面板 + 捕获 `console.error` 到 `ERR:` 行）

## 阴影
`PCFSoftShadowMap`；正交视锥 ±35m / 0.5 / 120；`bias -0.0005`、`normalBias 0.02`；
车 cast 不收、赛道收不 cast；`sun.target` 每帧绑玩家车。

## Themes
`asphalt/grass/ground/hill/hillCount/night/treeCount/buildingCount` 已接通，
唯独 `sky` 是死字段（main.js 硬编码黄昏天空 ShaderMaterial + `Fog(0x14243a,420,2100)`）。

## 本机工具链坐标
| 工具 | 位置 | 版本 |
|---|---|---|
| g++ | `/e/mingw64/bin/g++.exe` | 16.2.0 |
| GLM | `/e/g-truc-glm-8d1fd52`（`-I` 指向**含 glm/ 的父目录**） | 1.0.3 |
| Emscripten | `/e/emsdk`（`upstream/emscripten/em++.py`） | 6.0.10-git |
| node(emsdk) | `/e/emsdk/node/24.19.0_64bit/node.exe` | 24.19.0 |
| TypeScript | `C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/typescript` | — |
| Edge | `/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` | — |
| **Go**（便携，现行） | `C:/Users/Administrator/.workbuddy/binaries/go/go/bin/go.exe` | **1.27.1** |
| Go（旧，备） | `C:/Users/Administrator/.workbuddy/toolchain/go/bin/go.exe` | 1.21.13 |

- 跑 MinGW 产物前必须 `export PATH="/e/mingw64/bin:$PATH"`，否则退出码 127（找不到 DLL、不报错）。
- `/c/gnu-toolchain` 是空目录（别被名字骗了）。
- **无头截图（Edge）**：`--screenshot` 目标必须**纯 ASCII 绝对路径**（中文目录会写 0 字节）；
  `--dump-dom` **只看 exit code 会假绿**，必须断言结果文本真写进 DOM。
- **Go 用法**：`export PATH="/c/Users/Administrator/.workbuddy/binaries/go/go/bin:$PATH"`（必要时 `export GOROOT=.../go/go`）。
- Wasm 构建：`native/wasm/build_wasm.sh`，必须 `EM_FROZEN_CACHE=1`（本机批量删除保护会把
  emcc 的缓存清理判为失败）；必须用 `em++` 而非 `emcc`（C++ 项目 emcc 只链 libc）。

## 各模块陷阱细节（2026-09-27 从 MEMORY.md 下沉）

### `timesync/`
- **锁定判据 `count_>=windowSize` 与"参与聚合 6 个"是两件事** —— 别混用。
- 滤波 = 30 窗取 RTT 最低前 20% 按 `1/(rtt+1ns)` 加权；**RTT 打平保留最新**。
- 仅断线 / `|err|>250ms` 才 Snap。

### `rb_replicator/`
- 外推上限 **150ms**，超时转**阻尼滑行**。
- **强制短弧三处都要**：① 入包进 `physRot_` 前 / ② 算 `visOffRot_` 误差时（最关键）/ ③ 每帧 slerp 前。

### `safe_physics/`（现行权威实现，纯 C++20 / 零依赖 / 零堆分配）
五条规格：① 静态墙法线无条件 `y=0` 重归一化；② 塑性恢复系数（1.5m/s 阈值严格 `e=0`）；
③ 分离冲量 —— 位置相只推位置、**绝不碰 `velocity`**，单子步 ≤0.03m；
④ 悬挂解耦；⑤ 单接触冲量硬上限 40000 N·s。
- 摩擦**符号陷阱**（已修）：冲量按 `v -= J/m` 施加会**取反** `J`；
  写成 `tDir·(−jtStop)` 会顺着滑动方向**加速**车体（实测 `vt 40→48.25`）。正解 `jtVec = tDir·limit`。
- **空过陷阱**：`fabs(min(v_n,0))` 在 `v_n>0` 时恒返 0（假绿）；一律用 `SeparationSpeed(vn)=(vn<0)?−vn:0`。
- **0.03m/子步是算术不是可调值**：帧数 ≈ `ceil((pen−slop)/cap)`（pen 0.12→5 帧、0.30→10 帧）。
  **断言要钉这条式子，不要钉魔法数**。

### `safe_collision/`
- **【已废弃】薄转发层**，全部转调 `SafePhysicsSolver`。旧名保留为 inline 别名；
  `ResolverConfigLegacy` 是**独立 struct**（不能继承 `final` 的 `SolverConfig`），
  旧字段是真实成员但**被 `ToNew()` 忽略 ⇒ 全部惰性**（回归测已证改旧字段结果逐位不变）。

### `harness/`
**压测场景自身必须物理自洽**（已栽三次）：
- **[D1]** "位置冻结+速度未消" = 伪造瞬移源（墙约束只该消**法向**速度）；
- **[D2]** 不连续窗隔离比例断言 <15%（曾 660/720 假绿）；
- **[D3]** 防零样本假绿。

### `mp_chaos/`（单机无头多人混沌仿真台，28/0，需真 GLM）
一进程起 1 服务端 + 4 客户端（1 本地带平滑层 + 3 无头 Bot），
**仿真-墙钟替代真线程**（同 seed ⇒ 日志逐字一致）。五条硬约束：
- **非对称长尾抖动 = 对数正态** `LogNormalMs`（真排队是乘性右偏；高斯尾部衰减太快会抹掉真正触发
  rubberbanding 的 160ms 尖峰）。
- **乱序须由两包真实到达时刻倒挂产生**（一包"抢跑"），不能"延迟后发包"
  （否则接收侧永不见 seq 倒挂，计数是空的）。
- **HUD 断言必须覆盖 P1 与非 P1 两条分支**（本地车整场 P1 ⇒ `-0.X` 分支从未执行 = 假绿）；
  解法：发车格本地车末位 + 末段"进站"重刹。
- **判据用接触点法向速度，不是质心**（偏心撞击质心本就不归零）；
  **高速撞击断言 `cpSep ≤ +0.5`（正=弹开），不是 `|cpSep|≈0`** —— 4e4 N·s 截断必然残留负值。
- 喂求解器的**几何必须自洽**：横摆惯量用真车值 `m(L²+W²)/12 ≈ 2850`；正面接触点放端面、
  横向 ±半宽，**不是** `z=±1.2`。
- `ForzaTimeSynchronizer` 的 `t2` **必须用本包真实单程延迟**（用均值 ⇒ RTT 算出错误的亚单程值）。

## 聊天控制台实现细节（2026-09-27）

### main.go
- 常量 `chatMaxRunes = 80` / `chatMaxBytes = 480`。
- `chatPayload(sender,color,content,isSystem)` 手写 JSON：
  `{"t":"CHAT_MESSAGE","type":"CHAT_MESSAGE","sender":..,"senderColor":..,"content":..,"isSystem":..,"timestamp":<UnixMilli>}`
  （`strconv.Quote` 转义，零反射）。
- `systemMsg(content)` = `chatPayload("系统", "#7fb2ff", content, true)`。
- `trackDisplayName(id)`：`spa→"斯帕-弗朗科尔尚赛道"`、`vegas→"拉斯维加斯 · 街道夜赛"`、
  default→`"铃鹿 · 8 字立体交叉"`。
- `broadcastSystemLocked(content)` 调用方持 `room.mu`。
- `sanitizeChat` 实现：`r<0x20 || r==0x7f || (0x80<=r<=0x9f)` → continue；
  `switch r { case 0x200b,0x200c,0x200d,0x200e,0x200f,0xfeff,0x2060: continue }`；
  空白（`' ' / '\t' / '\n' / '\r' / 0x3000`）折叠为单空格且**首字符前不写**；
  `b.Len()>=chatMaxBytes` 软停；末尾 `TrimSpace` + rune 截断到 `chatMaxRunes`。
- 上行 `case "CHAT_MESSAGE"`：`sanitizeChat(m.Content)`，空则 return，
  否则 `chatPayload(c.name, c.color, text, false)` + `broadcastLocked`。

### 前端
- `network.js` `dispatch`：`case 'CHAT_MESSAGE': this.emit('chat', m); break;`
- `main.js` `CHAT` 配置：`MAX_LOBBY:200` / `MAX_HUD:4` / `HUD_HOLD_MS:5000` / `OUT_MS:520`。
- `isCountdownMsg(c)` = `/^\[赛事指令\]/`；`isGoMsg(c)` = `/出发|发车！|全员发车/`。
- `appendChatRow`：系统 → `.chat-sys`（`go` > `countdown` 互斥优先）；玩家 → `.chat-row`
  （`.chat-swatch` + `.chat-bubble` > `.chat-name` + `.chat-text`）；超上限 `removeChild(firstChild)`；
  `feed.scrollTop = feed.scrollHeight`。
- `appendHudChat`：`.hc-msg.in` +（`go` / `cd` / `sys`）；玩家墨边色 `sanitizeHex(senderColor)`。
- `scheduleHudOut(el,delay)`：`el._chatOut` 幂等；`remove('in')`→`add('out')`→`OUT_MS` 后 `removeChild`。
- `setChatPanel(on)`：`wantShow = on && (S.mode==='room'||'menu')`；`toggle('hidden')` + `toggle('show')`。
- 调试钩子：`window.__testAppend(msg)` / `window.__S` / `window.__sampleLocalInput`
  （与生产同源，供 `tools/chat-ui-check.mjs` 真机验收）。

### CSS 关键值
- `.chat-panel`：`position:fixed; top:0; right:0; bottom:0; width:340px`；
  `background:rgba(14,17,23,.78)`；`backdrop-filter:blur(12px) saturate(1.25)`；
  `border-left:1px solid rgba(255,255,255,.08)`；`z-index:36`；
  `transform:translateX(102%)` + `opacity:0`（`.show` 时归零）。
- `.chat-sys` 渐变描边走 `-webkit-mask-composite: xor`。
- `.hud-chat`：`position:fixed; left:22px; bottom:258px; width:min(46vw,460px); z-index:12; pointer-events:none`。
- `.hc-bar`：`position:fixed; left:50%; bottom:74px; transform:translateX(-50%); z-index:22`。
- 媒体查询：`≤980px` 面板 300px；`≤760px` 面板 `display:none`。

## 六大缺陷修复实现细节（2026-09-27 · 规格 §一~§六）

### §一 起跑序列（main.go ↔ main.js/network.js）
- main.go 常量 `countdownTickMs = 1000`。`beginCountdownLocked` 顺序：
  `START_SEQUENCE_BEGIN` → 循环 `n=3,2,1`：`COUNTDOWN_TICK{val:n}` + 旧 `count{n}` + 系统消息
  `[赛事指令] 比赛将在 N 秒后开始...` + `Sleep(countdownTickMs)` → 归零 `RACE_START{"at":<UnixMilli>}`
  + 旧 `lights stage6` + `[赛事指令] 全员发车！`。**阶段切换前 `r.mu.Unlock()`**。
- main.js `S`：`controlsLocked:true` / `startSeqSeen` / `raceStartSeen` / `_goFallback`。
  `forceRaceGo(reason)`（模块级 `_raceGoDone`）：`showStartLights(6)` → `controlsLocked=false` →
  `raceStartSeen=true` → `showGo()` → `setTimeout(1000)` 后 `#countdown`/`#startLights` `display:none`。
  `armGoFallback()`：4500ms `setTimeout(()=>forceRaceGo('4.5s 本地兜底'))`。
  时钟段：`if (running) S.controlsLocked = false;`（**单向或**，不得回拉 true）。
- network.js dispatch 新增：`START_SEQUENCE_BEGIN→startSeq` / `COUNTDOWN_TICK→tick` /
  `RACE_START→raceStart` / `RACE_RESULTS→raceResults` / `SEASON_LEADERBOARD_UPDATE→seasonUpdate`。

### §二 结算 + 赛季榜
- main.go：`pointTable [maxPlayers+1]int64{0,10,6,4,2,0×8}`；`raceResultsJSONLocked(res,pts)` 手写 JSON
  `{"t":"RACE_RESULTS","data":[...]}`。
- 前端：`showSettlement(data)` / `hideSettlement()` 渲染 `#settleBody` 行 + `#settleSub`；
  `renderSeason(data)` 兼容 `[{name,pts}]` 与 `{rankings:[...]}` 两种形态。
- index.html `#settlement`：`.settle-panel` / `.settle-head`+`#settleSub` / `.settle-cols` / `#settleBody` /
  `.settle-actions`（`#settleAgain` / `#settleLobby`）。
- style.css：`.settlement`（`backdrop-filter: blur(18px)` + opacity 过渡）/ `.settlement.show` /
  `.settle-panel`（transform 过渡）/ 5 列网格 `56px 1fr 120px 116px 96px` / `.stl-row.p1|.me` /
  `stlIn` 关键帧（错峰延迟）/ `.stl-pts` 绿色。

### §三/§四 physics.js
- CFG 新增：`CRUISE_MIN_KMH:50` / `PURE_PURSUIT_LOOKAHEAD:15` / `GUIDANCE_TANGENT_KEEP:0.9` /
  `GUIDANCE_TANGENT_FRICTION:0.35` / `GUIDANCE_THETA_MAX:60°` / `GUIDANCE_THETA_CAP:0.8` /
  `GUIDANCE_YAW_GAIN:0.15` / `GUIDANCE_OUT_EPS:0.03` / `GUIDANCE_MIN_SPEED:0.35`。
- `driveLocal`：`else if (c.finished) { this.purePursuit(c, dt); }` 排 `c.auto` 分支**之前**。
- `applyBarrierGuidance(dt)` 在 `applyBarrierDeflection(dt)` 之后调用（`fixedStep` 内）。
  **★ 0.9 切向保留只在首次接触子步生效**（`fresh = !car._wallContact`）；持续接触用
  `clamp(1 - GUIDANCE_TANGENT_FRICTION*dt,0,1)`。⚠️ 每子步都乘 0.9 ⇒ `0.9^120≈3e-6` ⇒ 贴墙即死。

### §五 track.js
- 常量：`BARRIER_OUT_M=8.5` / `BRIDGE_EXCL_LEN=60` / `BRIDGE_EXCL_WID=25` / `BRIDGE_RAIL_H=1.8` /
  `BRIDGE_PILLAR_OUT_M=4.0`。`sceneryClearMin(hw)=hw+BARRIER_OUT_M`；
  `_bridgeExclusionBox()` → `{centroid,dir,perp,halfLen,halfWid,deckY,underY}`；`_inBridgeExclusion(box,x,z)`。

### 测试计数（本轮）
selftest **624**（+L16 六大缺陷守卫 ≈48 项）· track-verify **110** · e2e **127** ·
verify_sec3 **43** · verify_baumgarte ✓ · chat-ui-check **33** · wasm smoke **75** / wire **8** / layout **19** ·
native 八节全绿。
- ⚠️ `chat-ui-check` 反证 premise 必须**同时**清 `S.controlsLocked`（新输入闸门），漏清即"断言恒零"假绿。
- ⚠️ selftest 守卫锚点须钉**真实广播字面量 / 方法定义**，不可钉注释或调用点
  （`goSrc.indexOf('\`{"t":"COUNTDOWN_TICK"')` / `physSrc.indexOf('driveLocal(c, dt) {')`）。

---

# 归档 · 2026-10-14 从 MEMORY.md 下沉（MEMORY 需控制在可注入体量内）

## 交付前必跑（完整顺序，2026-10-14 校准）
```
export PATH="/c/Users/Administrator/.workbuddy/binaries/go/go/bin:$PATH"
gofmt -l . && go vet ./... && go test ./...
go build -trimpath -ldflags "-s -w" -o forzalan.exe .
node tools/selftest.mjs                  # 715
node tools/track-verify.mjs              # 122 通过 / 4 项历史规格失败
node tools/e2e.mjs                       # 128（★ 必须用**重编后**的 exe）
node tools/verify_baumgarte.mjs ; node tools/verify_sec3.mjs   # 47 PASS / 0 FAIL
node tools/chat-ui-check.mjs             # 33（真机 CDP，需 Edge/Chrome）
node tools/ai-runtime-check.mjs          # 12 车/11 AI/FM8；再 AI_CHECK_MODE=horizon 一遍
node tools/audio-profile-check.mjs ; node tools/audio-spatial-check.mjs
node tools/worker-{clock,sync,smoke,kinematic}-check.mjs ; node tools/remote-snapshot-check.mjs
node tools/dynamics-spec-check.mjs ; node tools/camera-worker-check.mjs
node tools/penalty-controller-check.mjs  # 24
node tools/race-prewarm-check.mjs
node tools/lobby-presence-check.mjs      # ★2026-10-14 新增：大厅 sping/presence.ms/未入房 rename/oval 白名单/gridSlot
node tools/roll-camera-negcontrol.mjs    # ★2026-10-14 新增：相机侧倾修复的反证（必须能报红）
node tools/presence-layout-check.mjs
node tools/embedded-assets-check.mjs     # 22/22
node native/wasm/smoke_test.mjs          # 75
node tools/perf-probe.mjs                # 帧间隔 p50 < 20ms；主循环 JS/帧 p50 < 12ms
node tools/hud-gap-probe.mjs             # 秒差列不跳几百秒 + 单人帧率 + room 报文不锁车
node tools/runtime-proof.mjs ; node tools/jitter-check.mjs
node tools/start-timing-check.mjs ; node tools/terrain-and-solo-check.mjs
node tools/terrain-multi-check.mjs
node tools/terrain-probe.mjs             # ⚠️ 当前 12 项红（铃鹿，先于 2026-10-14 存在，未修）
node tools/lap-finish-check.mjs ; node tools/ai-race-finish-check.mjs   # 人机整场约 3~4 分钟
node tools/settle-align-check.mjs ; node tools/room-ping-check.mjs      # room-ping 8 项
SEEDS=4 node tools/track-geometry-audit.mjs
TRACKS=oval SEEDS=4 node tools/track-geometry-audit.mjs   # 新赛道单独审
# 反证必须能报红：NO_SKIRT=1 → 裙边缺失；NO_SKIRT=2 → 裙边接反；NO_GRASS_CLIP=1 → 草地侵入路面
node tools/broadphase-ab.mjs             # 只在改过宽相/赛道规模时跑
```

### 门禁工具的已知陷阱（踩过，别再踩）
- ⚠️ `ArrayCollisionMatrix` 上不存在 `tick()`（那是 `World.collisionMatrixTick()`）：探针误调会抛异常 ⇒
  计时变 −1，看着像产品坏了（实际是探针的错）。
- ⚠️ 物理固定 60Hz、渲染 120Hz（`raceState.substep = 0.016666…`）：累加器让"每帧位移"天然 0 / ≈0.98m 交替。
  判"位置跳跃"必须用 **车速 × 物理子步长**做上界，别用 rAF 的 dt。
- ⚠️ CDP 探针：`Page.addScriptToEvaluateOnNewDocument` 的 source 是模板字面量 ⇒ 里面的注释**不能出现反引号**
  （会提前闭合 ⇒ 整个 .mjs 语法错误）。读 DOM 类名要读**内层**节点（`cd-big`/`dataset.secs` 挂在内层 `.chat-sys`；
  倒计时大号数字是 `.chat-cd-num`）。单机探针要自己派 `KeyW`。`getBoundingClientRect().width` 对
  `transform: translateX(102%)` 返回 0 ⇒ 测宽度用 `getComputedStyle(el).width`；`display:none` 无法 `focus()`；
  无头窗口默认 `document.hasFocus()===false`（需 `Page.bringToFront`）。
- ⚠️ `node tools/*.mjs` 不要放在"循环 + 输出重定向"里跑（尤其 background）：报 `stdin is not a tty` 且
  **测试根本没执行**（全绿/全红都是假的，实测踩 5 次）。正确：一条命令一个脚本 + 管道 `2>&1 | tail -1`。
- ⚠️ 跑 e2e 前确认 8099 没被占用：残留 exe 占端口 ⇒ 服务端**绑定失败但不报错** ⇒ 只有房间生命周期日志一条失败。
- ⚠️ 用户可能正开着实时会话（8099 有 ESTABLISHED）—— 先 `netstat`，有活跃连接就别 kill，改 `E2E_PORT=8098`。
- ⚠️ `bash native/run_tests.sh` 在本机跑不了：脚本把 MSYS 路径（`/c/Users/…`）喂给原生 g++，而本机 MSYS
  路径转换关闭 + 目录名含中文 ⇒ 一律 `No such file or directory`。是环境问题不是源码问题，别当门禁；
  要跑就 `cd native/<mod> && g++ <相对名>.cpp`。
- ⚠️ 门禁脚本自身不许无超时等待：`room-ping-check.mjs` 曾因 CDP `open` 事件无超时 + `send()` 的 60s 兜底
  定时器不清理而**永久挂起**（"验收已通过却永不退出"）。修法 = 看门狗 + `Promise.race` 超时 + 末尾 `process.exit()`。

## 本环境硬约束（2026-10-14 归档）
1. node 无法派生 node 子进程（EBUSY）；校验 JS 语法用进程内 `vm.Script`（或复制成 `.mjs` 后 `node --check`）。
   spawn Go 二进制没问题。
2. 后台进程活不过一次 Bash 调用：起服务 + 跑 curl/浏览器必须在同一次 Bash 调用里。
3. bash 的 `/tmp` ≠ Node 的 `/tmp`：统一用项目内相对路径。
4. grep 查标识符用短词根（曾用 `turbul` 漏 `turb`，误判"未实现"）。
5. bash 里 `mkdir/sed/grep/tail/dirname` 可用性不稳定；绝不用 PowerShell 做 UTF-8 往返（GBK 乱码）；
   同一文件别并发发多个 Edit。无头截图 / MinGW 见上文。

## 性能证据边界（2026-10-03，2026-10-14 复核未重测）
- Iris Xe / 铃鹿 / 12 车单机真实浏览器：平均 **96.8 FPS**，帧间隔 p50 **8.4ms**、p99 **16.8ms**、最大 **220.9ms**；
  1 帧 >33ms、1 帧 >100ms。不能声称稳定 120 FPS，也不能把单机结果当成 12 个真实网络客户端。
- 真实浏览器 FM8/Horizon 回归均验 12 车（11 AI）、计时塔最多 4 行、最近 4 名牌、灰色圆形地图、轮胎状态、
  `Runtime.exceptionThrown=0`。

## 2026-10-04 九项体验修复 · 回归细节
- `terrain-multi-check.mjs` 必须同时检查三地图外围连续性、路面层台阶和铃鹿立交低层拉穿；
  当前通过值 Suzuka 1.347m/0.171m/0、Vegas 1.082m/0.056m、Spa 0.491m/0.198m。
- 护栏必须同时验逐段覆盖、道路不侵入和三维坡度/偏航连续性。`barrier-geometry-check.mjs` 三图均 0 缺口/0 侵入；
  `barrier-slope-check.mjs` 共检查 5084 个主碰撞体（Vegas 旧 7/43 属旧审计口径）。
- `room-ui-check.mjs` 不是有效验收：硬编码查找不存在的 `#btnAddAI`，第 53 行抛 TypeError；
  大厅/房间需求以 `presence-layout-check.mjs`、`room-ping-check.mjs`、`lobby-presence-check.mjs` 为准。

## 地形 / 铃鹿草地 / 桥 · 详细口径（字段与数值）
- 裙边下沉目标 = 逐采样点 `baseY[i] − TERRAIN_LIP(1.6)`；`_ribbon` 的 `SEGS` 必须显式 `N + 1`。
- 大地是 `_buildGround()` 地形网格（不是 `CircleGeometry` 圆盘）：近处贴合本地地面层、
  70→900m 平滑过渡到 `TERRAIN_FLOOR_Y(-12)`；圆锥包络 `TERRAIN_CONE_D0/L/R = 60/450/90`。
  断言不能用 `geometry.parameters.radius`（BufferGeometry 没有），用包围球半径；高度一律取 `baseY`。
- 验收判据：同一段里外侧恒低于内侧 `TERRAIN_LIP − 0.10`（几何自洽，与分层/合并布局无关）。
  两条反证开关 `NO_SKIRT=1`（裙边缺失）/`NO_SKIRT=2`（内侧列被拉下）；`NO_SKIRT` 不能提前归一成布尔。
- 草地外沿逐点收缩 `grassLimit[i]`（草皮带横向 `GRASS_W=42`）；判据用**切向点积**（|cos|>0.72 = 自己前后段）。
  验收 `NO_GRASS_CLIP=1`；断言必须三维（|Δy|<1.5m）。
- 终点线横向用逐点半宽 `halfWidthAt[i0]/[i1]`；桥面 `BRIDGE_Y=9.5` + 净空 `BRIDGE_CLEAR_M=6.5`，
  引桥半宽 300m（最大纵坡 10.8%）。
- 桥墩避让按**高度区间** `_pillarBlocked`（`_groundLatAbs` 会漏检）；验收在 `A.build()` 之后跑。
- raceLine 横向幅度逐点 = `halfWidthAt[i] − RACE_LINE_MARGIN(1.0)`；不变量 `|offset[i]| ≤ halfWidthAt[i] − MARGIN`。
- 景观隔离：`BARRIER_OUT_M = 8.5`、`sceneryClearMin(hw)=hw+8.5`、剔除线 `CLEAR_REJECT_M = 13.5`
  （锚点 `CLEAR_ANCHOR_M = 14.0`）；铃鹿立交 3D 排除盒 XZ ±60/±25 内零树；桥侧高架护栏 `hy=0.9`、
  地面栏 `hy=1.25`；桥下立柱外推 4.0m。

---

# 归档 · 2026-10-14 三次压缩 · 自 MEMORY.md 再下沉

> MEMORY.md 注入预算告急（34KB 被截断）。以下为**细节展开**，红线摘要仍在 MEMORY.md。
> 需要具体症状/代码路径/参数时读本区。

## ★★★ 帧率红线（出厂版 7.5fps 事故）—— 四条必须同时成立
少一条就是"卡 / 车不动 / 越跑越卡"。
1. **宽相只能是静态桶/网格实现**：Worker 内 `broadphase.collisionPairs` = static-bucket-XZ、格 **32m**；
   `__workerConfig` 里可自证。`NaiveBroadphase` + 2963 静态护栏 = O(n²)：实测 **p50 133ms / 7.5fps**
   （`collisionPairs` 占 89.5% CPU）；SAP 实测 11.79ms/次更差，**别换**。
2. **网格维度只能走构造参数**：构造后改 `bp.nx/ny/nz` 只改索引算术、**不扩容 bins**（按 10×10×10 分配）
   ⇒ idx ≥ bins 抛错 ⇒ **异常从 `world.step` 冒出、整帧中断、绿灯亮着车一动不动**。
3. **`installMakePairsUniqueFix()` 必须装**：vendored cannon 的 `Broadphase.makePairsUnique` 两游标相向而行
   ⇒ 只留约一半候选对 + 跨轮残留键 ⇒ `undefined` 塞进 `pairs1` ⇒ 窄相 TypeError/死循环。
   ⚠️ `NaiveBroadphase.collisionPairs` 不调用它 ⇒ 旧版不炸，**换宽相才引爆**。
4. **`installSparseCollisionMatrix()` 必须装**：`ArrayCollisionMatrix` 按刚体数**平方**预分配
   （2967 刚体 ⇒ 4.39M 格），`collisionMatrixTick()` **每子步**清零两次 —— 实测 `reset()` 46.9ms、
   `tick()` 52.4ms（占单步物理 53%）。症状"起步还行、**某一刻起持续 110ms/帧**到终场"⇒ 换稀疏 Map，语义等价。

## 强度量纲 / 跨圈坐标（"刚起步跳几百秒"）
- **离线 `progressScore(c)` 单位必须是米**：`lap*track.length + trackIdx*track.spacing`
  （采样**等弧长** ⇒ 弧长 = 序号 × spacing）；秒差 = `米差 ÷ 参考车速(≥12m/s)`，量纲必须一致。
- ⚠️ 旧的 `lap*100000 + cpIdx*1000 − 距离` 跨 CP 边界凭空多 **1000**（真实 ≈281m）⇒ ÷12 = **+83 秒**；
  `cpIdx`/`100000` 已**结构性移除**（缺几何返回 0 + 告警，**不许**回落序号加权）。
- 服务端 `progressScore` 是 **ordinal 排序积分**（int64），折算里程只经 `nominalCpMeters`；
  权威秒差走 spline 弧长 + 整圈时长。**两套口径不混用**。
- ★★ **跨圈项必须是几何压线次数 `c.lineCross`，不能是 `c.lap`**：`lap` 要集齐全部 CP 才 +1，
  过线瞬间 `trackIdx` 从 ~N−1 跳到 ~0 ⇒ 坐标瞬间后退整圈 ≈ 几百秒，排位也倒置。
  `lineCross` 必须在 `groundConstraint` 里按索引回绕计数（前向 +1 / 倒车 −1，下限 0）——
  `updateProgress` 只对 `!remote` 调用，而观战/名次需要每台车都有连续坐标。实测修好后相邻采样最大跳变 **1.3s**。

## ★ 名次 / 进度三条守卫（"左上角名次错乱"）
- **起步同分按 `gridSlot` 决胜**（`leaderboardLocked` 第三键），无发车格才退回 `id`。
- **跨圈旧 CP 污染守卫**：`advanceLapLocked` 归 cp=−1 后，同一包若仍带上一圈的 `C`
  （`P<0.25 && C>maxCP/2`）⇒ 判 `staleRolloverCP` 跳过，否则 progressScore 瞬间 +24000 分、名次跳第 1。
- **发车格在起终点线之前**：`lap==0 && cp<0 && pj.C<0 && p>0.8` ⇒ 样条钳 0 且**不写通过时刻表**
  （客户端 `_publishNetwork` 同口径，两处互为冗余）。守门 `progress_regression_test.go`（6 条，反证已验）。

## ★ 赛道类型与 oval 入门图
- **白名单五处必须一致**：`track.js: TRACK_TYPES`、`main.go: sanitizeTrack`、`main.go: trackDisplayName`、
  `index.html #track`、`main.js: TRACK_NAME`+`btnTrack` 循环。当前 = `suzuka / vegas / spa / oval`。
- `oval` 是**合成图**（无真实场地）：`oval-geometry.js` 160 控制点、2×400m 直道 + 2×R180m 半圆、
  解析周长 **1930.97m**、平面**零自交**。`smooth: 0`、`barrierLat: 14.0`、`cp: 24`。
- ★★ **`buildCongestionZones` 的 14% 分位判据只对连续半径谱成立**：oval 半径只有 {∞, 180} 两个取值，
  分位值落在**弯↔直过渡带**（179.97 < 弯道本体 180.00）⇒ 严格 `<` 只圈出几段 <60m 的过渡点、被 minSpan
  过滤 ⇒ **整条弯被判非拥挤区**，该图弯道幽灵化完全失效。正解：赛道定义可给 `congestionRadiusM`（oval=200），
  优先序 **调用方 opts > 赛道定义 > 分位判据**；三条真实赛道不设该字段、行为不变。
- ⚠️ 加/换赛道后必须重跑：`track-verify`、`verify_sec3`（按 TRACK_TYPES 循环 ⇒ 断言数会变）、
  `TRACKS=oval SEEDS=4 track-geometry-audit.mjs`、`terrain-multi-check`。

## ★ OSM 取数唯一正确方式
- **一律用 `https://www.openstreetmap.org/api/0.6/relation/{id}/full`**。**绝不要 `map?bbox=...`**：
  ① 密集城区（拉斯维加斯）直接 http 400；② 实测**同一 relation** bbox 抽取算 8465m、`/full` 是 6971m
  （官方 7004m）—— 曾据此误判"OSM 比真车长 21%"，白查一轮。
- Overpass 大查询常 504；只有"按名字找 relation id"才用它。
- 导入器 `tools/import-track-osm.mjs`：无岔口走**唯一链**拼接，有岔口才退最小转角贪心；起终点优先
  `role=start`/`raceway=start-finish`；**必须排除 `role=pit_lane`**。
- **已烘焙真实几何**：铃鹿 5797m（真车 5807，−0.17%）；斯帕 6971m（7004，−0.5%）；拉斯维加斯 6191m（6201，−0.2%）。
  （注：上文「赛道几何（实测数值）」的 6755m / 7013m 是**早期程序化几何的旧值**，不能作为当前 1:1 证据。）
- **换真实赛道后必须同步**：`smooth: 0`、地标按真实坐标经同一套切平面投影换算（Sphere 场馆半径取真尺度 56m）、
  curve/宽度/护栏外沿重新标定。

## ★★★ 铃鹿赛道红线
- **走线是 OSM 实测数据**（relation 284570），**不许改回按 seed 生成**。指纹：周长 5797m、
  投影自交**恰好 1 处**、最小弯半径 13.8m —— 已在 selftest / track-verify 守着。
- **宽度逐点**（真车 10~16m）：`Track.halfWidthAt[i]` + `def.widthAt(v)`；标量 `Track.halfWidth` 取**最窄值**；
  几何断言必须用 `halfWidthMin/Max` 区间。
- **护栏逐点变位**：`barrierLatArr[i]` = 半宽(逐点) + 路肩 + 缓冲 9m；铃鹿 `barrierLat` 标量是 0，
  **读标量会把车摆到错误位置**。
- **立交三条硬规则**：① 交点必须在**最终等弧长几何**上定位（`track.bridgeCross`），不能靠重采样前索引
  （实测偏 29m）；② 桥面 = **max(base(本层), base(被跨层)+净空+余量)**，不能固定 +7.5m（会只剩 0.84m 高差）；
  ③ 额外抬高按 bump 包络**全程加权**，只加区内会产生 ~1.7m 台阶。
- 导入脚本两条清洗必需：去零长度重复点 + 细分长段。`suzuka-orient.mjs --write` 之后**不许**再跑定向分析。

## Worker 架构与验收契约（细节）
- `physics.worker.js` 独立累加并固定 `fixedStep(1/60)`；主线程经 Transferable 状态数组 + `PhysicsWorkerBridge`
  渲染，**不拥有 Cannon world**，也不从 rAF 推进物理。`renderAlpha(now)` 在两包之间连续推进。
- 远端用 64 槽 / 2 秒运动学快照缓冲、Hermite / 最短路径 SLERP + 断流恢复融合。
  **探针必须读真实 Worker 步数**，不能用镜像或猜测补样本。
- `MAX_TIME_WARP=0.015` 只限制主线程比赛时钟漂移的收敛速率；物理 dt 保持 1/60。
  **墙钟报文只在网络边界转换**；校准偏移 0 是合法值。
- 道路 Heightfield 用固定平面格逐点采样，桥面与下层分开，四轮各自查询地形；射线拒绝错误层与竖直侧壁；
  悬挂用道路法线，未命中轮用该轮解析地形支撑。
- **不能每步抬车壳位置却保留下落速度**（弹簧失去承重、重力速度积累）。驶出锚点只在四轮沥青且
  grounded / 非 airborne 时缓存；旧索引不能把车锁到 30m 外的局部窗口。
- 顶部调查 2.5 秒、裁决 3 秒；Horizon 静默、静态护栏免罚。幽灵重合不额外震动相机；尾流屏边提示按规格保留。
- **`contactDetails` 是常驻遥测，不是诊断专用**：`jitter-check` / `worker-kinematic-check` 直接消费它 ⇒
  **不许**改成"仅探针期构造"。性能优化只能**消除分配**（模块级 scratch 复用、
  `Number(x.toFixed(n))` → `Math.round(x*10^n)/10^n`）。
- **`remoteHistory` 生命周期**：`start`/`clear`/`removeCar` 必须清空（残留旧 seq 会让新包被
  `RemoteSnapshotBuffer` 永久判乱序 ⇒ 远端车卡在起点）；主线程缓冲池 ↔ Worker `recycleRemote` 成对。
- **上行报文定点量化**（`_publishNetwork`）：位置/姿态 r3、四元数 r4、速度 r1、油门/转向 r2、
  样条 r4（1e-4 圈 ≪ 服务端 1/1024 圈分辨率 ⇒ 不改任何切片判定）。单包 JSON 体积降约 1/3。
  **不要**顺手把上行提到 60Hz（上行与服务端 JSON 解析双翻倍，而渲染延迟 60~120ms 才是主项）。
  守门 `worker-sync-check` 的量化网格 + 体积断言。

## 物理模型要点（细节）
- **抓地不能单一 mu**：`axleState()` 载荷转移 + 下压力叠轴荷，前后轴分别算极限取 min。
  **`yawGrip` 只看前轴 μ**；用前后加权平均 ⇒ 手刹推头。
- 主线程顺序 `视觉同步→updateCamera→更新名牌→render`。
- **悬挂是弹簧-阻尼非位置钳位**；**严禁 `body.position.y=groundY` 瞬移贴地**。
- **出界纯物理**：抓地降 + 滚阻爬升 + 牵引上限。侧向抓地下限必须**倍数形式**
  `MU_SLIP_FLOOR*(1+(OFFROAD_LAT_GRIP_K−1)*offRoad)`（K=3.45）—— ⚠️ 绝对值常量会旁路成死代码。
  横向摩擦兜底 `max(min(aLatCap, offRoadMu·g), latFloorMu·g)`（只写 `min()` ⇒ 草地无限平移）。
  侧向出界抓地 0.62μ（`OFFROAD_LAT_GRIP_MIN`，K=1.38）**必须低于**路面 2.4μ；草地软上限 90km/h、
  渐进阻力 0.20、`ROLL_SAND_K` 0.10（判据：停着的车全油门 **8s 内回到沥青**）。
- **R 键救援**：优先最后合法驶出锚点上方 0.3m，无锚点才回 CP。继承速度 `clamp(vExit×0.6,8,28)` m/s；
  前 3 次免费，之后每次 +2s；只标脏圈、**不重置圈速**。3.5s 幽灵保护只剔车车掩码，仍与护栏碰撞；
  **严禁 `collisionResponse=false`**。
- **护栏导流** `applyBarrierDeflection(dt)`：`world.step` 后、`projectPenetration` 前；判据 `crossY=fwdZ*tx−fwdX*tz`。
- **AI 起步让线** `CFG.START_LANE_M=200`（否则四车 5~7s 内并线互撞）。
- **建筑净空走 OBB 五点判定**，口径 **13.5m**。⚠️ 限高式 `Math.max(下限,·)` 是陷阱（lat 小时反调高）
  → 正解 `if(cap<8) continue; h=min(h,cap);` + 显式 `ang>theta` 校验。

## 碰撞要点（细节）
- **★ 非物理弹跳的主要来源 = cannon Baumgarte 穿透偏置**（`computeB` 的 `-g*a`，`a=3.6923`）。
  `BARRIER_RESTITUTION=0` 杀不掉 → monkey-patch（实际名 `installCannonBaumgarteKill`）。
  实测 200km/h 反弹 **1.1458→0.0071（−99.4%）**。守卫 `tools/verify_baumgarte.mjs`。
- 车↔护栏单独一组材质；**车↔车别跟着改**（另走软接触层）。
- **★ 反冲硬限幅 `clampCollisionImpulse(cars)`**：`world.step` 后、`absorbSoftContacts` 后；
  **只在 `_stepTouched` 时动手**，**严禁无条件 `vy=0`**。⚠️ 反证陷阱：关掉也测不出超调 ⇒ 需单元直调证明。
- **恢复系数两段**：`|v|<1.5 → e=0.05(1−v/1.5)`；`≥1.5 → e=0`。
- **静态墙法线无条件 `y=0` 重归一化**；水平分量 < `NORMAL_FLAT_EPS` → 放弃解算。
- **位置相只推位置、绝不碰 `velocity`**：单子步 ≤**0.03m**、每对只推一次。单接触法向冲量上限 **40,000 N·s**。
- **静态赛道刚体必须在 `RacePhysics` 构造里注册**（`registerTrackBodies`+`GROUP_BARRIER`）；
  只在 `track.js generateTrack()` 里调过 ⇒ 护栏/桥栏/桥墩**全是视觉装饰**。
- **全员幽灵车（可选）**：`setGhostMode(on)` 剔车车掩码（仍撞护栏）。默认关；`Room.ghost` 或 `?ghost=1`。

## 起跑 / 状态机 / 房间 / 大厅（细节）
- **两阶段起跑（服务端权威）**：① 聊天框整备倒计时 `readyCountdownSec = 5`（逐秒广播）→ ② 250ms 载入缓冲
  → ③ 局内红灯逐盏熄灭 `startLightTickMs = 700` × 5 → 绿灯。**合计 8.75s**。
- **节拍三处必须一致**：`main.go: startLightTickMs` == `main.js: LIGHT_TICK_MS`；
  `LOCAL_GO_MS = 250 + 5*LIGHT_TICK_MS`；`GO_FALLBACK_MS` **必须 > LOCAL_GO_MS**（selftest 守卫）。
- ⚠️ **整备倒计时 goroutine 每拍必须重新取锁复查** `emptyLocked()/allReadyLocked()`；中途取消准备 ⇒
  `counting=false; readyCountdown=0` + 广播"发车已中止"。**进循环前必须先解锁**。
- ⚠️ **`armLocalStartLights` 用 `S._lightLedTimers` 前必须先初始化**（`resetStartSequence()` 只"若有则清空"
  ⇒ `ids.push` 抛 TypeError ⇒ **单机灯序卡在 R5**）。
- **`net.on('room')` 绝不能让正在进行的比赛回到大厅**：`S.mode='room'` ⇒ `raceClock=0` ⇒ `S.rp.racing=false`
  ⇒ 油门被清零 ⇒ **绿灯亮着车永远动不了**。比赛只能由 `lobby`/`RACE_RESULTS`/`end` 结束；
  **权威昵称刷新要放在所有提前 return 之前**。
- **统一放行入口 `forceRaceGo(reason)`**（`_raceGoDone` 一次性）：权威 RACE_START / 旧 lights stage6 /
  本地兜底三路全汇此；绿灯 1s 后 `#countdown`/`#startLights` `display:none`。
- **延迟是服务端实测**：`sping`/`spong` + nonce 校验（`Client.rttMs`，指数平滑）。
  ★**必须覆盖未入房的大厅玩家**（`Hub.lobbyPingLoop()`，只发 `c.room == nil`，与 room ticker 互斥）；
  ★`case "spong"` **不许**再写 `if rm == nil { return }`；★`presenceSnapshot` 未入房分支必须补 `ms`，
  且 `c.name`/`c.rttMs` 各在自己锁内读。★只在"首测 / 变化 ≥ `pingReportDeltaMs`(2ms)"时重发 room+presence。
- **前端昵称实时同步**：`net.on('open')` 同步一次；首页 `#name` 输入去抖 500ms 发 `rename`。
- **圈数入口两处**（建房页 + 房间内 `btnLaps`），服务端权威（守卫 `!started && !counting && c.id == 1`，clamp 1..8）。
- **聊天**：单通道 `CHAT_MESSAGE`（`isSystem` 区分）；身份只读服务端 `c.name`/`c.color`（防冒名）；
  `S.chatTyping` 判据必须在 `sampleLocalInput` **第一道**；面板是顶层 `<aside>`、**绝不嵌进 `#hud`**。
- **已知未决**：`hud-gap-probe` / `net-trace` 偶报「30s 内未放行 / 从未发车」（约 3 次 1 次，负载高更易现）。
  服务端每轮都正常广播 `START_SEQUENCE_BEGIN` + `start`；客户端表现为 `mode=race` 但 `racing=false`。
  已加幂等守卫，**未根治**。

## 结算 / 完赛 / 观战（细节）
- `endRaceLocked`：`hub.mu` 内累加积分 → `savePoints()` → `rebuildSeasonLocked()` → 广播 `RACE_RESULTS` +
  `SEASON_LEADERBOARD_UPDATE`；前端 `raceResults` → **1500ms 延迟**弹 `#settlement`。
- **完赛即刻脱手巡航**：`finishCar(c)` 设 `c.auto=true`（§三 起另加 `c.purePursuit=true`），
  `vTarget=CRUISE_KMH/3.6` 沿 `t.raceLine.offset` 跟随；`C/V` 键 `cycleSpectate`。
- **60s DNF（服务端权威）**：首位冲线 → `dnfDeadline=now+60s` + 广播 `{"t":"dnf","secs":N}`；到点 ⇒
  未完赛者标 `retired` → `endRaceLocked("dnf")`；`dnfDeadline/dnfLeft` 开赛 + 回大厅两处重置。
  各车 `finished` 判定含人+BOT（**服务端无 BOT 概念**，BOT 是纯客户端）。

## 网络与音频（细节）
- **服务端** = 房间/准备/倒计时/发车时刻/罚时累计/成绩/名次/DNF；**客户端** = 物理与 CP 判定。
- **ForzaTech 管线（已全实装，勿重复造）**：Clock Slewing（物理永远严格 1/60）/ Dual-Layer Error Blending
  （首快照走直接对齐特例）/ Predictive Ghosting（`_refreshMasks()` 是唯一掩码来源）。
- `EngineAudio` 远端声场共用**一个** `AudioContext`，只保留本车 **160m 内最近 8 台**；换档/回大厅必须释放旧
  voice 与 context。音效档 `i6gt`/`v8`/`v12`/`fe`，默认 `i6gt`（**程序合成音，不得声称 FM8 录音级复刻**）。
- FM8/Horizon 必须是每场实例的独立 physics profile（不改全局 `CFG`），网络比赛两端必须同一档案。
- 护栏低速 Anti-Suction 仅 `speedKmh < ANTI_SUCTION_KMH` 时外推；切向保留率取 guidance/deflection 较大值。

## 驾驶规则三态 / 碰碰车（细节）
- 白名单四处必须一致：`main.go: sanitizeGameMode/gameModeDisplayName`、`index.html #gameMode`、
  `main.js` 三处归一化（`beginRace` / `btnGameMode` 三态循环 / `?mode=`）、
  `PhysicsWorkerBridge.normalizeGameMode`、`physics.js: setGameMode`。
- **碰碰车不许关掉碰撞类罚时以外的东西**：罚时漏斗 `Car.addPenalty` 里只拦 `wall`/`ram`，
  **保留** cut/shortcut/frr_gain/rescue —— 否则该模式变成免费刷圈速通道（成绩不可信）。
- **幽灵标记必须在 `_refreshMasks`（掩码唯一来源）里集中清零**：这样碰撞解算与主线程视觉
  （读 `c.ghost/rescueGhost/finishGhost/zoneGhost` 决定透明度）**同时**看到"无幽灵"，不会"半透明却实体"。
  另 `updatePredictiveGhosting`/`updateCongestionGhosting` 在 bumper 下整体短路。
- 车↔车接触材质由 `_applyCarContactMode()` 就地改 `_carContactMaterial`
  （bumper: `BUMPER_RESTITUTION` 0.62 / `BUMPER_CONTACT_FRICTION` 0.06；其余模式仍是 0.05/0.55）。
  **护栏材质绝不跟着改**。守门 `tools/bumper-mode-check.mjs`（含 fm8 负对照组）。

## 罚时 UI（细节）
- **原因键必须归一化**（`frr_gain`/`offtrack`/偏离赛道 → `offtrack`；`cut`/`shortcut` → `cut`）。
- **active 同键在任意阶段都合并**（退场期只续冷却、不重弹）；同键冷却 4.5s(有偿)/6s(无偿)；
  **待播队列上限 = 1**（旧上限 8 × 单条 5.92s ⇒ 最长近 50s 连环弹窗 = 用户报障的"罚时一直弹"）。
- 前端 `net.on('pen')` 对**本地车**的回显必须用**同一个原因键**（旧实现写死 `'server'` ⇒ 去重全失效 ⇒ 每条弹两遍）。

## 2026-10-14 第三轮落地细节（用户指示"提示词让怎么做就怎么做，不要产生自己的思想"）
- 问题 2/3/6/8 **已按原文落地，未自行回退**。门禁：selftest **715 → 711 通过 / 4 失败**，
  4 项均由本轮引入且**方向正确、量不足**：
  ① 走线直线均值 1.34m（阈值 <1.0）；②③ 2.2s 横移 ±2.58m（阈值 >3，指数滤波拖慢打舵）；
  ④ 沙地全油门峰值 18.0km/h（阈值 35~110，`extraDrag 0.65/s` 把极速压死）。
- **问题 2** `physics.js` 转向段改指数滤波：`maxSteerRad = CFG.STEER_MAX_LOW·lowSpeedFactor·highSpeedAtten`，
  `steerRate` 加速 5.2→8.5 / 回正 12。两处必要适配：`CFG.MAX_STEER`→`CFG.STEER_MAX_LOW`；
  目标角**必须**沿用 `−steerInput`（否则左右反相）。
- **问题 3** 出界分支加 `surfaceGripMul`(0.90/0.78) + `exp(−extraDrag·dt)`(0.35/0.65) + 3.2 m/s² `roadSide` 牵引。
  ⚠️ **`c.roadSide` 由 `groundConstraint` 写入，首拍可能 undefined** ⇒ 必须判空，否则 verify_sec3 直接崩。
  ⚠️ `surfaceGripMul` 在本工程**无消费方**（纯写入）⇒ 实际生效的只有衰减与牵引。
- **问题 6** `main.go` 新增 `Room.stepServerBotsLocked(now)`（ticker 内、snapshotBroadcast 前调用；
  房主 120ms 内有新鲜包则让位）。它**只推进进度/名次，不产生位姿** ⇒ 不能据此声称"所有端 AI 位置完全一致"。
- **问题 8** `track.js` 新增导出 `computeOptimalRacingLine()`（80 次弦向拉普拉斯 + 逆向刹车积分），
  `_computeRacingLine` 的 **offset** 取自 `alpha`；`main.js` 着色改由 `rl.brakeIntensity` 驱动。
  `radius` 仍用原平滑中心线曲率（curbMask/拥挤区/景观依赖）。offset 额外按逐点半宽夹一次以守住
  `|offset| ≤ halfWidthAt[i] − MARGIN`。
