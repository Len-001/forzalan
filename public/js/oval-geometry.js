/*
 * 新手 · 极简高速环道（Stadium Oval Circuit）
 *
 * 【定位】给新手与"高速跟车/尾流对抗"准备的入门赛道：
 *   · 两条大直道 + 两个宽半径平缓弯（R = 180m，远大于任何车型的极限弯速）
 *   · 无立交、无急弯、无街道窄口，路宽沿用全局 14m（半宽 7.0m）
 *   · 平面投影**零自交**（封闭凸环），因此不触碰立交分层/桥面净空那套逻辑
 *
 * 【为什么是程序化几何、而不是 OSM】
 *   铃鹿 / 斯帕 / 拉斯维加斯是**真实场地**，必须逐点复刻（见 suzuka/spa/vegas-geometry）。
 *   本赛道是刻意设计的合成入门环道，没有对应的真实赛场，所以由解析式给出：
 *   直道严格平行于 Z 轴、弯道严格是半径 180m 的半圆 —— 端点连续、切向连续、
 *   曲率只有两个离散取值，任何"最小转弯半径/坡度"审计都能给出确定答案。
 *
 * 【坐标系与行车方向】
 *   与 track.js 全局约定一致：控制点是 (x, z)，顺序 = 行车顺序。
 *   发车线位于 p[0] = (R, 0)，即右侧主直道的中点，车头朝 +Z。
 *   全圈几何：右侧直道 → 北半圆 → 左侧直道 → 南半圆 → 回到发车线。
 *
 * 【尺寸】
 *   straightHalf = 200m（单侧直道半长）  radius = 180m
 *   周长 = 2 × 400m（两条直道）+ 2 × π × 180m（两个半圆）= 800 + 1130.97 ≈ 1931m
 */

const OVAL_RADIUS = 180;   // 半圆弯半径 (m)
const OVAL_HALF = 200;     // 直道沿 Z 的半长 (m)

/** 生成闭合控制点列（(x, z) 数组，顺序 = 行车顺序，首点 = 发车线）。 */
function buildOvalPts(radius = OVAL_RADIUS, straightHalf = OVAL_HALF) {
  const pts = [];
  const straightSteps = 24;   // 直道分段（等长，保证 Catmull-Rom 切线严格沿 Z）
  const curveSteps = 32;      // 半圆分段（每段 5.625°，矢高 < 0.22m）
  const r2 = (v) => Number(v.toFixed(4));

  // ① 右侧主直道：从发车线 (r, 0) 向 +Z 走到弯前
  for (let i = 0; i < straightSteps; i++) {
    pts.push([radius, r2((i / straightSteps) * straightHalf)]);
  }
  // ② 北侧半圆：a ∈ [0, π]，从 (r, +half) 经 (0, +half+r) 到 (-r, +half)
  for (let i = 0; i < curveSteps; i++) {
    const a = (i / curveSteps) * Math.PI;
    pts.push([r2(Math.cos(a) * radius), r2(straightHalf + Math.sin(a) * radius)]);
  }
  // ③ 左侧副直道：从 (-r, +half) 向 -Z 走到 (-r, -half)
  for (let i = 0; i < straightSteps * 2; i++) {
    pts.push([-radius, r2(straightHalf - (i / (straightSteps * 2)) * (straightHalf * 2))]);
  }
  // ④ 南侧半圆：a ∈ [π, 2π]，从 (-r, -half) 经 (0, -half-r) 到 (+r, -half)
  for (let i = 0; i < curveSteps; i++) {
    const a = Math.PI + (i / curveSteps) * Math.PI;
    pts.push([r2(Math.cos(a) * radius), r2(-straightHalf + Math.sin(a) * radius)]);
  }
  // ⑤ 回到发车线：右侧主直道下半段 (r, -half) → (r, 0)
  for (let i = 0; i < straightSteps; i++) {
    pts.push([radius, r2(-straightHalf + (i / straightSteps) * straightHalf)]);
  }
  return pts;
}

/**
 * 导出几何。字段与其它 *-geometry.js 保持同一形状，便于 track.js 用同一条路径消费：
 *   pts                 控制点列 (x, z)，顺序 = 行车顺序
 *   perimeter           解析周长 (m)，供审计比对（真值 = 2·L + 2πR）
 *   bbox                [xmin, xmax, zmin, zmax]
 *   selfIntersections   平面自交对数（本赛道恒为 0）
 *   startFinishFraction 发车线在圈上的比例（首点即发车线 ⇒ 0）
 *   corners             弯位标注（比例 + 名称），供 HUD/调试使用
 */
export const OVAL_GEOMETRY = {
  source: 'Procedural rookie high-speed oval (no real-world counterpart)',
  center: [0, 0],
  radius: OVAL_RADIUS,
  straightHalf: OVAL_HALF,
  // 解析周长：2 条 400m 直道 + 2 个半径 180m 的半圆
  realPerimeter: 2 * (2 * OVAL_HALF) + 2 * Math.PI * OVAL_RADIUS,
  osmPerimeter: 2 * (2 * OVAL_HALF) + 2 * Math.PI * OVAL_RADIUS,
  bbox: [-OVAL_RADIUS, OVAL_RADIUS, -(OVAL_HALF + OVAL_RADIUS), OVAL_HALF + OVAL_RADIUS],
  selfIntersections: 0,
  startFinishFraction: 0,
  startFinishDist: 0,
  // 圈上比例按**等弧长**解析给出：
  //   ① 右直道 0 → 200m（0 → 0.1036）
  //   ② 北半圆 200 → 765.5m（0.1036 → 0.3965），中点 0.250
  //   ③ 左直道 765.5 → 1165.5m（0.3965 → 0.6036），中点 0.500
  //   ④ 南半圆 1165.5 → 1731.0m，中点 0.750
  //   ⑤ 右直道下半段 1731.0 → 1931.0m，回到 p[0] = 发车线
  corners: [
    { name: '1 号北弯', fraction: 0.250, dist: 0 },
    { name: '西侧全油门直道', fraction: 0.500, dist: 0 },
    { name: '2 号南弯', fraction: 0.750, dist: 0 },
  ],
  pts: buildOvalPts(),
};

export default OVAL_GEOMETRY;
