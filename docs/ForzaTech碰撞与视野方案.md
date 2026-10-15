# ForzaTech 式碰撞解算与视野遮挡治理方案

> 面向本仓库（Go + Three.js + cannon-es，局域网 4 人赛车）。
> 文中所有"现状"数字均取自本工程当前代码，不是通用建议。
> 涉及文件：`public/js/physics.js`、`public/js/main.js`、`public/js/track.js`。

---

## 0. 结论速览

| 目标行为 | 传统引擎表现 | 本方案机制 | 关键参数 |
|---|---|---|---|
| 高速撞墙 | 弹开、可能翻车/腾空 | **分离冲量位置投影** + 速度依赖塑性恢复 | `e_hi = 0.02`、`β_pos` 独立通道 |
| 高速蹭墙 | 反弹失速、车身跳开 | 法线**垂直分量重定向** + 切向库仑摩擦 | `μ_k = 0.5`、`n_y ← 0` |
| 两车擦碰 | 乒乓球式反复弹开 | 低速软约束（法向削减 90%）+ 切向黏滞 | `v_soft = 3.5 m/s`、`μ_t = 0.65` |
| 被铲飞 / 凌空翻滚 | 冲量全额进簧上质量 | **悬挂解耦**：接触冲量只进簧下 | `m_unsprung / m_total = 0.12` |
| 高速穿透护栏 | 离散碰撞漏检（隧道效应） | 2.0 m 厚刚体 + 累加器固定步长（已实装） | `1.39 m < 2.0 m` |

---

## 1. 问题定位：本工程为什么会被"弹飞 / 弹开"

### 1.0 先分清两条解算路径（**这条搞错，后面的诊断全错**）

本工程实际上有**两套互不相干**的接触解算：

| 碰撞类型 | 走哪条路 | 谁在解算 |
|---|---|---|
| **车 vs 车** | `onCarCollide` 自定义冲量 | 本工程代码 + cannon 兜底 |
| **车 vs 静态体**（护栏/桥栏/桥墩） | **不走自定义代码** | **cannon 默认解算器** |

依据：`physics.js` 第 1394 行

```js
onCarCollide(car, e) {
  const other = e.body;
  if (!other || !other.__carId) return;      // ← 静态护栏没有 __carId -> 直接返回
```

**结论：撞墙/蹭墙的力学行为完全由 cannon 的默认接触解算决定**
（`ContactMaterial(carMaterial, barrierMaterial)`：`contactEquationStiffness = 5e5`、
`contactEquationRelaxation = 6`、`restitution = 0.0`、`friction = 0.5`）。
本工程代码对撞墙**一行都没参与**，也**没有任何后置的速度钳制**。

这解释了为什么"撞墙被弹飞"和"撞车被弹开"是**两个不同的根因**，需要分别处理（见 1.1 / 1.2）。

### 1.1 根因 A —— Baumgarte 补偿被注入速度通道（最致命）

两个地方犯了同一个错：

**(a) 撞墙：cannon 内部的 Baumgarte bias。**
cannon-es 的 `ContactEquation` 把穿透深度折算成一个**偏置项 `b`**，
直接加进**速度约束的求解**里（`stiffness = 5e5` / `relaxation = 6`）。
穿透越深 → `b` 越大 → 解出的冲量越大 → **这份冲量变成了真实动能**。
`relaxation = 6` 意味着它会在约 6 步内持续注入 —— 撞得越深，"奖励"的速度越多。

**(b) 撞车：本工程 `onCarCollide` 里显式写了同样的东西：

```js
const biasVel = Math.min((CFG.BAUMGARTE_BETA / dtStep) * pen, CFG.BAUMGARTE_BIAS_V);
const deltaV  = (1 + CFG.RESTITUTION) * closing + biasVel;   // ← 问题在这
let   J       = Math.min(deltaV / invSum, CFG.BAUMGARTE_IMPULSE);
```

`biasVel` 本意是"把几何穿透推出去"，但它被加进了 **Δv（速度增量）**。
物理含义：**穿透 1 m 深，车就被奖励一份凭空出现的动能**。

设 `β = 0.2`、`dt = 1/60`、`pen = 0.5 m`：

```
biasVel = min(0.2 × 60 × 0.5, 2.5) = 2.5 m/s   （被硬锁在上限）
Δv = (1+0.05)·closing + 2.5
```

对 1380 kg 的车，`2.5 m/s` 的垂直分量就意味着**被抬高 0.32 m**（`h = v²/2g`）。
如果是侧向撞击后法线带正 Y 分量，这份速度直接把车**掀翻**。

> 这正是"高速撞墙/撞车被弹飞"的数学来源 —— 不是恢复系数太大，而是**位置修正走了速度通道**。
>
> **(a) 与 (b) 是同一个病，但修法不同**：(a) 要**绕过 cannon 的 bias**（把
> `contactEquationRelaxation` 调大、或把解算量转移到外部位置投影）；
> (b) 只需把那一行 `+ biasVel` 删掉。方案 A（分离位置投影）对两者都成立，
> 因为它把"位置修正"整体从速度通道剥离到独立通道。

### 1.2 根因 B —— 恢复系数与速度无关

`CFG.RESTITUTION = 0.05` 是**常数**。真实钣金塑形是**速度依赖**的：

- 低速轻蹭（< 2 m/s）：车身弹性形变可恢复 → 应该有恢复系数（约 0.3~0.5），
  否则车会"粘"在墙上。
- 高速重撞（> 15 m/s）：钣金永久塑性变形、吸能盒溃缩 → 恢复系数应趋近 0。

用常数 `0.05` 同时服务两端：低速显得太"黏"（无回弹、没有轻微弹开的真实感），
高速又不够塑性（0.05 在 200 km/h 下仍会产生可观的分离速度）。

### 1.3 根因 C —— 法线没有重定向，路肩/护栏成了跳板

当前直接用 cannon 给的 `contact.ni`。护栏是 Box 箱体，与车轮/底盘接触时，
法线可能带显著的 **+Y 分量**（尤其斜向撞击箱体棱边、或路肩红白带）。

结果是经典的**斜坡弹射**：水平动能被重定向成垂直动能，车"骑"上护栏腾空。

### 1.4 根因 D —— 冲量全额作用到簧上质量

现在`applyImpulse` 直接把冲量给 `chassisBody`（整车刚体）。
真实赛车撞墙时，**轮毂+轮胎先吸能**，传递到车架的力要经过悬挂弹簧-阻尼过滤。

直接把冲量给整车 = 车身瞬间获得角速度 → **凌空翻滚**。

---

## 2. 方案 A：分离冲量位置投影（Split Impulse / Position Projection）

### 2.1 原理

Erin Catto 提出的经典解耦：**速度解算**与**位置修正**走两条互不注入能量的通道。

- **速度通道**：只负责消除接近速度 + 恢复系数。恢复系数为 0 时，撞后法向相对速度为 0（完全非弹性）→ **贴墙滑行**。
- **位置通道**：只负责把几何穿透推出去，用**伪速度（pseudo-velocity）**，解完直接写入位置，**不写回真实速度**。

数学形式：

```
速度通道：Δv_n = -(1 + e)·v_n           （e = 0 时 Δv_n = -v_n，撞后法向速度归零）
位置通道：Δx_n = β_pos · pen / dt · dt  （伪速度 → 位置，不产生动能）
                        ↑ 伪速度，与真实速度隔离
```

### 2.2 在本工程落地

cannon-es 的 `Solver` 不支持 split impulse，因此采用**外部位置投影**（与本工程
已有的"解析地面约束"同源思路）：

```js
/**
 * 分离位置投影（Split Impulse）。
 * 在 world.step() 之后、groundConstraint() 之前调用。
 * 与旧做法（把 biasVel 加进 Δv）的区别：
 *   旧 -> 位置修正变成真实动能 -> 撞深了就弹飞
 *   新 -> 位置修正只改 position，绝不改 velocity -> 撞深了只是"被慢慢推开"
 */
projectPenetration(dt) {
  const res = this.world.contacts;                  // cannon 本步生成的接触方程
  for (let k = 0; k < res.length; k++) {
    const eq = res[k];
    const bi = eq.bi, bj = eq.bj;
    if (!bi || !bj) continue;
    if (!(bi.__carId || bj.__carId)) continue;      // 只处理含车的接触

    const n = eq.ni;                                // 法线
    // 穿透深度：cannon 的 penetrationVec 沿法线的分量
    const pen = eq.penetrationVec
      ? Math.abs(eq.penetrationVec.x * n.x + eq.penetrationVec.y * n.y + eq.penetrationVec.z * n.z)
      : 0;
    if (pen < CFG.PEN_SLOP) continue;               // 容差内不修（防抖动）

    // 伪速度：与真实速度完全隔离，硬锁上限
    const bias = Math.min(CFG.PEN_BETA * pen / dt, CFG.PEN_MAX_MS);   // m/s 的"名义"速度
    const invSum = (bi.invMass || 0) + (bj.invMass || 0);
    if (invSum < 1e-6) continue;

    // 各自按逆质量分担位移 —— 注意是 position，不是 velocity
    const ratioI = (bi.invMass || 0) / invSum;
    const dx = bias * dt;
    bi.position.x += n.x * dx * ratioI;
    bi.position.y += n.y * dx * ratioI;
    bi.position.z += n.z * dx * ratioI;
    bj.position.x -= n.x * dx * (1 - ratioI);
    bj.position.y -= n.y * dx * (1 - ratioI);
    bj.position.z -= n.z * dx * (1 - ratioI);
  }
}
```

**参数取值**

| 参数 | 值 | 依据 |
|---|---|---|
| `PEN_BETA` | 0.8 | 位置通道可以比速度通道激进（不注入能量），但过高会在叠压时抖动 |
| `PEN_MAX_MS` | 8.0 | 位置投影允许的"名义推出速度"上限；比旧的 2.5 高，因为**它不再是动能** |
| `PEN_SLOP` | 0.005 m | 5 mm 容差，避免静止接触每帧微调造成抖动 |

**同时必须把 `onCarCollide` 里的 `biasVel` 删掉**，否则两处都在推，会过冲：

```js
// 改后：速度通道只负责非弹性化
const deltaV = (1 + CFG.RESTITUTION_EFFECTIVE(closing)) * closing;
```

---

## 3. 方案 B：速度依赖的自适应塑性恢复系数

```js
/**
 * 速度依赖恢复系数：低速偏弹性（有轻微回弹，手感真实），
 * 高速趋近绝对塑性（钣金溃缩吸能，不弹开）。
 * 用平滑过渡（smoothstep）而不是分段常数，避免临界速度处手感突变。
 */
function restitutionFor(speed) {
  const LO = CFG.REST_LO_SPEED;    // 2.0 m/s：以下完全弹性
  const HI = CFG.REST_HI_SPEED;    // 15.0 m/s：以上完全塑性
  const t = Math.min(1, Math.max(0, (speed - LO) / (HI - LO)));
  const s = t * t * (3 - 2 * t);           // smoothstep
  return CFG.REST_LO + (CFG.REST_HI - CFG.REST_LO) * (1 - s);
}
```

| 参数 | 值 | 说明 |
|---|---|---|
| `REST_LO_SPEED` | 2.0 m/s | 泊车/起步轻碰 |
| `REST_HI_SPEED` | 15.0 m/s (54 km/h) | 以上视为结构性撞击 |
| `REST_LO` | 0.35 | 低速回弹，避免"粘墙" |
| `REST_HI` | 0.02 | 高速近乎绝对塑性（规格 §3 的 0.05 是折中值，分段后可以更极端） |

曲线：

```
e(v)
0.35 ┤●●●●╮
     │     ╰─╮
0.15 │       ╰─╮
0.02 ┤         ╰────●●●●●●
     └────┬────┬──────────── v
          2   15
```

---

## 4. 方案 C：法线重定向（防跳板几何）

### 4.1 原理

护栏/护墙是**垂直面**。任何带正 Y 分量的接触法线都意味着"几何把车往上顶"。
做法：把法线投影到水平面并归一化，同时保留一个**上限保护**：
如果原始法线的垂直分量过大（> 0.5），说明是车轮压上了台阶/路肩，
这时宁可**放弃这次碰撞解算**（让解析地面约束去处理），也不要弹射。

```js
/**
 * 防跳板法线重定向。返回 null 表示"这次接触应当放弃速度解算"。
 */
function redirectNormal(n, car) {
  const y = n.y;
  if (Math.abs(y) < CFG.NORMAL_Y_SLOP) return n;          // 已经是垂直面，直接用
  if (y > CFG.NORMAL_Y_ABORT) return null;                // 太陡 -> 是台阶，交给地面约束
  // 归零 Y 分量并归一化 -> 纯水平法线，撞击不会产生垂直速度
  const hx = n.x, hz = n.z;
  const l = Math.hypot(hx, hz) || 1e-6;
  return { x: hx / l, y: 0, z: hz / l };
}
```

| 参数 | 值 | 说明 |
|---|---|---|
| `NORMAL_Y_SLOP` | 0.02 | 小于此视为已垂直 |
| `NORMAL_Y_ABORT` | 0.5 | 约 30° 以上坡度视为台阶，放弃解算 |

**额外收益**：法线纯水平后，车身受到的冲量不含 Y 分量 → 不可能被铲飞。

---

## 5. 方案 D：悬挂解耦（避免凌空翻滚）

### 5.1 原理

把接触冲量拆成两份：
- `m_unsprung`（轮毂+轮胎，约 12%）→ 直接给轮子/底盘，产生位移与轮胎形变
- `m_sprung`（车身，88%）→ 只通过**悬挂力**间接传递，并被弹簧-阻尼过滤

本工程已有完整的悬挂模型（`F = K·x − C·vn`，K=225.6 kN/m、C=35.3 kN·s/m，ζ=1）。
所以只需让碰撞冲量**不直接给整车刚体**，而是注入一个"碰撞扰动"，
由悬挂每步吸收：

```js
/**
 * 悬挂解耦的碰撞冲量。不直接把 J 写进 chassisBody.velocity，
 * 而是按簧下质量比先卸掉一部分，剩下的通过阻尼分配。
 */
applySuspensionCoupledImpulse(car, J, n, dt) {
  const r = CFG.UNSPRUNG_RATIO;                    // 0.12
  // 簧下部分：立即生效（轮子撞墙的真实感）
  const jU = J * r;
  // 簧上部分：除以 (1 + C/K/dt) 近似二阶低通 -> 等效一个时间常数
  const tau = CFG.SUSP.K / CFG.SUSP.C;             // ≈ 6.4 ms
  const jS = (J * (1 - r)) * (tau / (tau + dt));   // 高频分量被悬挂吸收
  const jEff = jU + jS;

  car.body.applyImpulse(
    new CANNON.Vec3(n.x * jEff, n.y * jEff, n.z * jEff),
    new CANNON.Vec3(car.body.position.x, car.body.position.y, car.body.position.z)
  );
  // 被悬挂吸收的那部分能量 -> 转成车身俯仰/侧倾的阻尼振荡（视觉上"咯噔一下"）
  car.suspensionKick = (car.suspensionKick || 0) + (J - jEff) / CFG.MASS * CFG.KICK_GAIN;
}
```

| 参数 | 值 | 说明 |
|---|---|---|
| `UNSPRUNG_RATIO` | 0.12 | 轮圈+轮胎+制动，约占整车 12% |
| `KICK_GAIN` | 0.35 | 剩余能量转成车身抖动的比例 |
| 效果 | — | 撞墙时车身是"顿一下 + 轻微抖动"，不是"整台车被弹飞" |

---

## 6. 方案 E：CCD / TOI 连续碰撞检测（以及本工程的取舍）

### 6.1 通用做法

```
TOI = (|p_b − p_a| − r_a − r_b) / max(0, (v_a − v_b)·n̂)
若 TOI < dt 且 v_closing > 阈值 -> 把物理步长细分到 TOI 时刻再解算
```

### 6.2 本工程的取舍：**不需要 TOI，已有算术保证**

本工程是"累加器 + 固定 1/60 步长"（`world.step` 每次严格收到 1/60）。
护栏碰撞体已加厚到 **2.0 m**（`BARRIER_HULL_HX = 1.0`）。单步最大位移：

```
v_max = 300 km/h = 83.3 m/s
Δx = 83.3 × (1/60) = 1.39 m  <  2.0 m（护栏厚度）
```

**1.39 m 的位移不可能跨过一个 2.0 m 厚的箱体而不产生接触** —— 离散碰撞已足够。

**真要做 TOI 的场景**（当前不存在，留作扩展）：
- 薄壁（< 0.5 m）动态障碍
- 未来若引入可变步长（例如为了 Clock Slewing 直接改 `adjustedDt`）

> ⚠️ **重要提醒**：如果将来把 `adjustedDt`（±1.5% 时间伸缩）真的写进物理步长，
> 步长变大 → 单步位移变大 → 上面的算术保证失效，那时**必须**同步上 TOI。

### 6.3 若必须实现 TOI 的最小版本

```js
/** 扫掠球近似 TOI：只对"车 vs 静态护栏"用，成本可控 */
sweptTOI(car, dt) {
  const p0 = car.prevPos, p1 = car.pos;               // 本步首末位置
  const d = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-4) return 1;
  const R = CFG.CAR_BODY_RADIUS;                      // 2.1 m 包围半径
  // 对每个静态体做"线段 vs AABB"的 slab 测试，取最早命中参数 t
  let tMin = 1;
  for (const b of this.staticBodies) {
    const t = raySlabVsAABB(p0, d, b.aabbLowerBound, b.aabbUpperBound, R);
    if (t >= 0 && t < tMin) tMin = t;
  }
  return tMin;
}
// 命中则：把本步拆成 [0, tMin] 与 [tMin, 1] 两段分别推进
```

---

## 7. 方案 F：赛道建筑遮挡视野的治理

### 7.1 现状问题（实测数据）

`track.js` 的 `_buildCity`：

```js
const h = 24 + rng() * 150 * (rng() < 0.25 ? 2.2 : 1);   // 最高 ≈ 370 m
```

建筑落位横向偏移仅 **≈ 45.5 m**（`hw + cw + 16` 起，且排他校验只看 `lat − 34 ≥ 13.5`）。

**几何后果**：相机在车后 5.5 m、高 1.8 m，FOV 60°。
一栋 370 m 高的楼在 45 m 外，**水平视角被占据 arcsin(...) 极大** ——
在弯道出口，整块右侧视野会被完全堵死，玩家看不到出弯点。

### 7.2 治理：三条规则（按优先级）

#### 规则 1 —— 高度按距离分级（Height-by-Distance Grade）

**原理**：阻挡视野的是**仰角**，不是高度。要求 `atan(h / d) ≤ θ_max`。

```js
/**
 * 视野安全角：从车眼高度(1.2m)看向建筑顶端的仰角不得超过 θ_max。
 * 弯道外侧要求更严（玩家最需要看到出弯点）。
 */
const VIEW_SAFE_ANGLE = 0.30;        // rad ≈ 17°（直道）
const VIEW_SAFE_ANGLE_CORNER = 0.18; // rad ≈ 10°（弯道外侧）
const EYE_H = 1.2;

const thetaMax = isOutsideOfCorner ? VIEW_SAFE_ANGLE_CORNER : VIEW_SAFE_ANGLE;
const hMax = Math.tan(thetaMax) * lat - EYE_H;
h = Math.min(h, Math.max(12, hMax));
```

沿 Vegas 的应用示例（`θ = 0.30`）：

| 距中心线 `lat` | 允许最大高度 `h` |
|---|---|
| 45 m | 0.30×45 − 1.2 ≈ **12.3 m** |
| 80 m | ≈ 23 m |
| 150 m | ≈ 45 m |
| 300 m | ≈ 91 m |

→ 高层楼群自然被推到远处，近处只留低矮商业体，**天际线反而更真**。

#### 规则 2 —— 弯道内侧留出"视线扇区"

对每个采样点，计算其前方 120 m 至 300 m 的赛道包围盒；
若建筑落在这个**扇区**内，直接剔除或压到 8 m 以下。

```js
// 视野扇区 = 以车为顶点、朝向赛道前方 ±FOV/2 的锥体在水平面的投影
function inViewSector(px, pz, i) {
  const p = this.pts[i], t = this.tan[i];
  const dx = px - p.x, dz = pz - p.z;
  const fwd = dx * t.x + dz * t.z;
  if (fwd < 0 || fwd > CFG.SECTOR_LEN) return false;      // 只在车前方
  const lat = Math.abs(dx * -t.z + dz * t.x);
  return lat < fwd * Math.tan(CFG.CAM.FOV_STILL * Math.PI / 360) + CFG.SECTOR_PAD;
}
```

#### 规则 3 —— 相机侧：遮挡淡出 + 前瞻增强

即使布局变好，仍会有偶然遮挡。相机侧做两件事：

1. **遮挡淡出**：每帧用射线从相机打向车，命中场景物体则把该物体
   `material.opacity` 在 0.25 s 内降到 0.15，离开后恢复。
2. **弯道前瞻动态加强**：`CAM.LOOK_AHEAD` 从 8 m 在入弯时提到 18 m，
   让相机"提前看到弯心"，同时 FOV 微增 3° 扩大周边视野。

```js
// 相机侧遮挡淡出（只对标记为 occluder 的网格生效，避免遍历全场景）
const hits = raycaster.intersectObjects(occluders, false);
for (const o of occluders) {
  const hit = hits.find((h) => h.object === o);
  o.userData.fade = damp(o.userData.fade || 1, hit ? CFG.OCCL_ALPHA : 1, 2.5, dt);
  o.material.transparent = true;
  o.material.opacity = o.userData.fade;
}
```

| 参数 | 值 |
|---|---|
| `OCCL_ALPHA` | 0.15 |
| 淡出/恢复时间常数 | 2.5 /s（≈0.4 s 完成） |
| `CAM.LOOK_AHEAD` | 8 m → 18 m（入弯插值） |

> **本工程的额外风险点**：上一轮新增的**看台**落位在 21.1 m（`CLEAR_ANCHOR_M + depth/2 + 2`），
> 高约 5.2 m。按 `θ = atan((5.2−1.2)/21.1) = 10.7°`，**刚好在弯道安全角 10° 的边缘**。
> 建议把看台横向偏移从 `+2.0` 提到 `+5.0`（→24 m，θ 降到 9.5°），或在弯道段跳过看台。

---

## 8. 对比：传统做法 vs 本方案

### 场景 1 —— 200 km/h 撞墙

| | 传统（Baumgarte-in-velocity） | 本方案 |
|---|---|---|
| 位置修正 | 加进 Δv → 变成动能 | 独立位置通道（伪速度） |
| 恢复系数 | 常数 0.05 | `e(55 m/s) → 0.02` |
| 法线 | 原样使用（含 Y 分量） | 重定向为纯水平 |
| 冲量去向 | 100% 给整车 | 12% 簧下 + 88% 经悬挂过滤 |
| **结果** | **弹开 + 可能腾空翻滚** | **贴墙滑行，车身顿一下** |

### 场景 2 —— 高速蹭墙（法向 2 m/s，切向 40 m/s）

| | 传统 | 本方案 |
|---|---|---|
| 法向 | `(1+0.05)×2 = 2.1 m/s` 弹开 | 软约束削减 90% → **0.21 m/s** |
| 切向 | 默认摩擦（弱） | 库仑摩擦 `μ_k = 0.5`，`Δv_t = μ·Δv_n` |
| **结果** | **弹开 + 减速** | **划擦：只失速、方向不变** |

### 场景 3 —— 两车并排擦碰

| | 传统 | 本方案 |
|---|---|---|
| 法向 | 反复弹开 | `< 3.5 m/s` 时法向削 90% |
| 切向 | 各自滑动 | `μ_t = 0.65` 黏滞，两车被"拉"在一起 |
| **结果** | **乒乓球效应** | **钣金摩擦、并排推搡滑行** |

### 场景 4 —— 后车鱼雷追尾

| | 传统 | 本方案 |
|---|---|---|
| 检测 | 等碰撞发生 | TTC 前向扫描（已有） |
| 阈值 | — | `TTC < 0.15 s` 且 `闭合速度 > 22.2 m/s` |
| 处置 | 深穿透 → 冲量爆炸 | **提前幽灵化**：掩码隔离 + 透明度 0.35 |
| **结果** | **前车被顶飞** | **无伤穿透，分离 3.5 m 后恢复** |

---

## 9. 参数总表

| 类别 | 参数 | 值 | 备注 |
|---|---|---|---|
| 位置投影 | `PEN_BETA` | 0.8 | 位置通道，可激进 |
| | `PEN_MAX_MS` | 8.0 | 名义推出速度（非动能） |
| | `PEN_SLOP` | 0.005 m | 防抖容差 |
| 恢复系数 | `REST_LO / REST_HI` | 0.35 / 0.02 | 速度依赖 |
| | `REST_LO_SPEED / HI` | 2.0 / 15.0 m/s | smoothstep 过渡 |
| 软约束 | `SOFT_CONTACT_MS` | 3.5 m/s | **已实装** |
| | `SOFT_CONTACT_CUT` | 0.90 | **已实装** |
| | `TANGENTIAL_FRICTION` | 0.65 | **已实装** |
| 法线 | `NORMAL_Y_SLOP` | 0.02 | |
| | `NORMAL_Y_ABORT` | 0.5 | 超过则放弃解算 |
| 悬挂解耦 | `UNSPRUNG_RATIO` | 0.12 | |
| | `KICK_GAIN` | 0.35 | |
| 护栏 | `BARRIER_HULL_HX/HY` | 1.0 / 1.25 | **已实装**（厚 2.0 × 高 2.5） |
| | `BARRIER_FRICTION` | 0.5 | **已实装** |
| 视野 | `VIEW_SAFE_ANGLE` | 0.30 rad | 直道 |
| | `VIEW_SAFE_ANGLE_CORNER` | 0.18 rad | 弯道外侧 |
| | `SECTOR_LEN` | 300 m | 视线扇区长度 |
| | `OCCL_ALPHA` | 0.15 | 遮挡淡出 |

---

## 10. 工程落地注意事项

1. **撞墙与撞车是两条路径，必须分别改**（见 §1.0）：
   - 撞车：改 `onCarCollide`（把 `+ biasVel` 删掉）；
   - 撞墙：本工程代码**不参与**，要降低 cannon 的 bias 影响
     —— 把 `contactEquationRelaxation` 从 6 提到 **12~20**（bias 摊到更多步、单步注入更小），
     深度穿透交给外部位置投影处理。
   **两处的位置投影只能有一份**（`projectPenetration` 里显式跳过 `mass === 0` 的静态体
   会漏掉撞墙），正确写法是：允许静态体参与位置投影，但**只推车、不推静态体**
   （`invMass === 0` 天然满足）。
2. **位置投影必须在 `world.step()` 之后、`groundConstraint()` 之前** ——
   本工程的地面是解析约束，顺序颠倒会让路面把投影结果覆盖掉。
3. **不要对静态体做位置投影**（`mass === 0`，`invMass === 0`）——
   代码里的 `invSum < 1e-6` 守卫已经在挡，但显式跳过更省 CPU。
4. **法线重定向只对"车 vs 静态体/车"生效**，不要用于地面接触 ——
   地面接触依赖带 Y 分量的法线做坡度判断。
5. **速度依赖恢复系数是每对接触各算一次**，不要用整车速度 ——
   应使用接触点处的**法向相对速度**（`closing`）。
6. **高度分级会改变 Vegas 天际线观感**，改完必须重新截图确认
   （远景楼群仍需保留，否则夜赛城市感消失）。
7. **看台落位 21.1 m 处在弯道安全角边缘**（θ≈10.7° vs 阈值 10°），
   建议横向偏移 `+2.0 → +5.0`。
8. **所有阈值改动后必须重跑三层**：
   `selftest`（物理行为）、`track-verify`（几何/护栏）、`e2e`（端到端 + 静态守卫）。

---

## 11. 验证方法（可直接落进现有台架）

```js
// V1 撞墙不腾空：垂直速度必须为 0
placeOn(car, trk, 300, 0, 0);
car.body.velocity.set(side.x * 40, 0, side.z * 40);   // 40 m/s 纯侧向
for (let i = 0; i < 180; i++) rp.fixedStep(1 / 60);
assert(Math.max(...vyTrace) < 1.0, '撞墙不腾空');       // 旧实现会出现 > 5 m/s

// V2 贴墙滑行：撞后沿墙的切向速度保留率
assert(alongSpeedAfter / alongSpeedBefore > 0.8, '撞墙后仍能沿墙滑行');

// V3 蹭墙不反弹：法向分离速度
assert(normalSpeedAfter < 0.5, '高速蹭墙几乎不反弹');   // 旧实现 ≈ 2.1 m/s

// V4 两车擦碰不弹开：撞后相对法向速度
assert(|relVn| < 0.3, '并排擦碰被黏住而不是弹开');

// V5 建筑不挡视野：所有建筑仰角 ≤ 阈值
for (const b of cityBuildings) {
  assert(atan((b.h - 1.2) / b.lat) <= VIEW_SAFE_ANGLE + 1e-6, '建筑仰角未超视野安全角');
}
```

---

## 12. 落地优先级建议

| 优先级 | 项 | 理由 |
|---|---|---|
| **P0** | 方案 A（分离位置投影） | 根治"弹飞"。**要覆盖两条路径**：删 `onCarCollide` 的 `+biasVel` + 提高 `contactEquationRelaxation` + 新增 `projectPenetration` |
| **P0** | 方案 C（法线重定向） | 根治"跳板腾空"，10 行代码 |
| **P1** | 方案 B（速度依赖恢复） | 手感分层，低速不再"粘墙" |
| **P1** | 建筑高度分级（规则 1） | 一行 `Math.min` 解决大部分遮挡 |
| **P2** | 方案 D（悬挂解耦） | 翻滚的最后一道防线 |
| **P2** | 相机遮挡淡出（规则 3） | 兜底，但需要 raycaster |
| **P3** | 看台横向偏移 +2 → +5 | 上一轮新增物的边际调整 |
| **P3** | TOI/CCD | 当前不需要（2.0 m 厚护栏已给算术保证）；仅在改可变步长时才必须 |
