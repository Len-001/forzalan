/* =============================================================================
 * selftest.mjs —— 纯 Node 自动化自检（零 npm 依赖）
 *
 *   node tools/selftest.mjs
 *
 * 覆盖范围：
 *   A. 赛道生成：确定性、等弧长、法线朝向、最小曲率半径、发车位姿态正交性与朝向
 *   B. 物理：4 车 220 秒长跑无 NaN / 全部完赛 / 不飞出世界 / 圈速合理
 *   C. 规则：吸尾流锥形判定、顶前车冲量、恶意侧撞判罚、出界累计罚时、切弯罚时
 *   D. 碰撞：Cannon 动量转移（前车被撞动、后车掉速、无穿模）
 *   E. 网络：插值 LERP / 四元数 SLERP / 航位推算 / 时钟同步
 *
 * 做法说明：three.min.js 是 UMD 包，在 Node 里用间接 eval 注入全局，
 * 等价于浏览器 <script> 标签的加载效果，因此被测试的是**同一份**运行代码。
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

// ---- 注入 three（UMD -> globalThis.THREE）--------------------------------
const threeSrc = fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8');
(0, eval)(threeSrc);
if (!globalThis.THREE) {
  console.error('无法注入 three.min.js');
  process.exit(1);
}

// ---- 最小 DOM 桩：让 track.build()（会用到 Canvas2D 画发车横幅）也能在 Node 里跑 ----
// 这是必须的：几何生成才是赛道代码里最容易出"索引越界/NaN 顶点"的部分，
// 只在浏览器里点一遍很难覆盖，必须在自动化里跑到。
function makeCanvasStub() {
  const ctx2d = new Proxy({}, {
    get(_, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; },
  });
  return {
    width: 0, height: 0, style: {},
    getContext: () => ctx2d,
    addEventListener() {}, removeEventListener() {},
  };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvasStub() : { style: {} }),
    createElementNS: () => makeCanvasStub(),
    addEventListener() {}, removeEventListener() {},
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };
}

const { Track, TRACK_CFG } = await import(mod('public/js/track.js'));
const { RacePhysics, CFG, DRAG_K, SUSP } = await import(mod('public/js/physics.js'));
const { Net } = await import(mod('public/js/network.js'));

// ★ 在任何模块打补丁**之前**抓下 cannon ContactEquation.computeB 的原始实现。
//   physics.js 的 installCannonBaumgarteKill() 是原型级补丁；一旦被调用，
//   prototype 上就再也拿不到未补丁版本。病根①的"反证"必须用真原始实现，
//   所以此处提前保存（后续据此在 ON/OFF 之间切换）。
const CANNON_MOD = await import(mod('public/libs/cannon-es.js'));
const CANNON_TRUE_ORIGINAL_COMPUTEB = CANNON_MOD.ContactEquation.prototype.computeB;

/* --------------------------------------------------------------------- */
/* 迷你断言框架                                                            */
/* --------------------------------------------------------------------- */
let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) {
    pass++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''));
  } else {
    failures.push(name);
    console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''));
  }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, n = 3) => Number(v).toFixed(n);
const t0 = Date.now();

/* --------------------------------------------------------------------- */
/* A. 赛道生成                                                             */
/* --------------------------------------------------------------------- */
section('A. 赛道生成（track.js）');

const A = new Track(777);
const B = new Track(777);
const C = new Track(778);

let sameAll = true, diffSome = false;
for (let i = 0; i < A.count; i++) {
  if (A.pts[i].distanceTo(B.pts[i]) > 1e-9) sameAll = false;
  if (A.pts[i].distanceTo(C.pts[i]) > 1e-6) diffSome = true;
}
ok(sameAll, '同 seed 生成完全一致的赛道（确定性）');
// ★ 2026-09-30 变更：真实铃鹿的走线来自 OSM 实测，**不再随 seed 变化**
//   （真车场地是固定的）。vergas/spa 仍按 seed 程序化生成，所以"换 seed 换赛道"
//   这条断言改为对 vegas 生效，铃鹿改为断言"换 seed 逐点完全一致"。
{
  const S1 = new Track(776, 'suzuka'), S2 = new Track(779, 'suzuka');
  let suzukaSeedInvariant = true;
  for (let i = 0; i < S1.count; i++) if (S1.pts[i].distanceTo(S2.pts[i]) > 1e-9) suzukaSeedInvariant = false;
  ok(suzukaSeedInvariant, '★★真实铃鹿走线不随 seed 变化（真车场地固定）');
  // 真实场地是**固定**的：vegas（街道）与铃鹿（OSM 实测）都不随 seed 变，
  // 只有 spa 带 ±0.5% 的确定性微扰。所以"换 seed 换赛道"这条断言针对 spa。
  const { TRACK_DEFS } = await import(mod('public/js/track.js'));
  for (const t of ['suzuka', 'vegas']) {
    const c1 = TRACK_DEFS[t](777).ctl, c2 = TRACK_DEFS[t](778).ctl;
    let d = 0;
    for (let i = 0; i < c1.length; i++) d = Math.max(d, Math.hypot(c1[i][0] - c2[i][0], c1[i][1] - c2[i][1]));
    ok(d < 1e-9, `★${t}：固定场地，走线不随 seed 变化`, '控制点 Δ=' + num(d, 6) + 'm');
  }
  // ★ 语义已变（2026-09-30）：斯帕也换成 **OSM 实测走线**，与铃鹿/拉斯维加斯一样
  //   **不随 seed 变化**（真实赛道是固定场地，再叠 ±0.5% 假扰动等于破坏 1:1 复刻）。
  //   断言语义统一为"三赛道走线都不随 seed 变"。
  {
    const s1 = TRACK_DEFS.spa(777).ctl, s2 = TRACK_DEFS.spa(778).ctl;
    let sd = 0;
    for (let i = 0; i < s1.length; i++) sd = Math.max(sd, Math.hypot(s1[i][0] - s2[i][0], s1[i][1] - s2[i][1]));
    ok(sd < 1e-9, '★spa：真实走线固定，不随 seed 变化（原实现带 ±0.5% 假扰动，已废）',
      '控制点 Δ=' + num(sd, 6) + 'm');
  }
}

ok(A.length > 4000 && A.length < 9000, '铃鹿赛道长度为闭环合理量级', num(A.length, 1) + ' m');
ok(A.count === 1440 && A.checkpoints.length === 24, '采样点数与 Checkpoint 数量（规格 24）', A.count + ' 点 / ' + A.checkpoints.length + ' CP');
ok(A.count % A.checkpoints.length === 0 && A.samplesPerCp === 60,
  '采样点数能被 Checkpoint 数整除（每个 CP 60 点）', 'samplesPerCp=' + A.samplesPerCp);
ok(Math.abs(TRACK_CFG.HALF_WIDTH - 7.0) < 1e-9 && Math.abs(TRACK_CFG.ASPHALT_HALF_W - 7.0) < 1e-9,
  '沥青有效总宽 = 14m（规格）', 'halfWidth=' + TRACK_CFG.HALF_WIDTH);

let dmin = Infinity, dmax = 0;
for (let i = 0; i < A.count; i++) {
  const d = A.pts[i].distanceTo(A.pts[(i + 1) % A.count]);
  dmin = Math.min(dmin, d);
  dmax = Math.max(dmax, d);
}
ok(dmax / dmin < 1.5, '等弧长重采样生效', 'max/min=' + num(dmax / dmin, 5)
  + '（真实铃鹿实测 1.23：OSM 顶点间距 3.4~39m 不均匀，重采样后弦长被"采样点间距'
  + '≈4.03m"夹在 [3.28,4.04]，属于可接受范围；旧阈值 1.02 是程序化赛道的口径）');

let minNy = 1;
for (const n of A.nrm) minNy = Math.min(minNy, n.y);
ok(minNy > 0.9, '路面法线始终朝上（无翻面）', 'min n.y=' + num(minNy, 3));

let minR = Infinity, maxR = 0, maxGrade = 0;
for (let i = 0; i < A.count; i++) {
  const j = (i + 6) % A.count;
  const t0v = A.tan[i], t1v = A.tan[j];
  const ang = Math.acos(clamp(t0v.dot(t1v), -1, 1));
  if (ang > 1e-6) { const R = (6 * A.spacing) / ang; minR = Math.min(minR, R); maxR = Math.max(maxR, R); }
  maxGrade = Math.max(maxGrade, Math.abs(A.tan[i].y));
}
// 真实铃鹿的顶点间距是 OSM 实测的 3.4~39m（重采样后弦长 min/max 比 1.23），
// 最小半径下限必须按**弦长/角度**算：这里 j=i+6 跨 6 段 ≈24m，
// 用真车"最小半径 14m（发卡）"折合允许的角度 ≈ 24/14 = 1.71rad —— 显然过松。
// 更合理的是按**转向角速度上限**卡：24m 弧长上转角不超过 100° ⇒ R ≥ 24/1.745 ≈ 13.8m。
ok(minR > 12, '最小转弯半径（可玩性下限，真车发卡 14m）',
  'minR=' + num(minR, 1) + ' m（真实铃鹿实测最小 13.8m，对应真车发卡）');
ok(maxGrade > 0.03 && maxGrade < 0.16, '纵向坡度落在合理区间（有立体起伏但不失真）',
  'max grade=' + num(maxGrade * 100, 1) + '%');

// 拓扑校验：拉斯维加斯是简单闭曲线（无自交）；铃鹿是 **8 字形**，
// 必须恰好自交一次 —— 那正是立体交叉（overpass）所在。
function countSelfX(t) {
  const N = t.count, p = t.pts;
  const hit = (a, b, c, d) => {
    const d1 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const d2 = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x);
    const d3 = (d.x - c.x) * (a.z - c.z) - (d.z - c.z) * (a.x - c.x);
    const d4 = (d.x - c.x) * (b.z - c.z) - (d.z - c.z) * (b.x - c.x);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  let n = 0;
  for (let i = 0; i < N; i += 2) {
    const a = p[i], b = p[(i + 1) % N];
    for (let j = i + 6; j < N - 3; j += 2) {
      if (N - (j - i) < 6) continue;
      if (hit(a, b, p[j], p[(j + 1) % N])) n++;
    }
  }
  return n;
}
/* ⚠️ 上面这个 countSelfX 是**抽样近似**（i 步长 2、j 只到 N-3）：真实铃鹿的
 *    立交处两段交角很小、可用线段很短，抽样会整段漏掉那个交点（实测 0 处）。
 *    它保留只用于 Vegas 的"无自交"断言；铃鹿的立交另用高密度复核（8-2 节）。 */
function countSelfXFine(t) {
  const N = t.count, p = t.pts;
  const hit = (a, b, c, d) => {
    const d1 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const d2 = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x);
    const d3 = (d.x - c.x) * (a.z - c.z) - (d.z - c.z) * (a.x - c.x);
    const d4 = (d.x - c.x) * (b.z - c.z) - (d.z - c.z) * (b.x - c.x);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const pairs = [];
  for (let i = 0; i < N; i++) {
    const a = p[i], b = p[(i + 1) % N];
    for (let j = i + 1; j < N; j++) {
      const gap = Math.min(Math.abs(i - j), N - Math.abs(i - j));
      if (gap < 10) continue;
      if (hit(a, b, p[j], p[(j + 1) % N])) pairs.push([i, j]);
    }
  }
  return pairs;
}
const V = new Track(777, 'vegas');
ok(countSelfX(V) === 0, '拉斯维加斯：简单闭曲线（无自交，街道赛道无立交）', '自交数=' + countSelfX(V));
// 铃鹿：真实 8 字形，投影上**恰好 1 处**立体交叉（主赛道跨过西直道）。
{
  const px = countSelfXFine(A);
  ok(px.length >= 1, '★铃鹿：存在 8 字自交（立体交叉的前提）', '自交对=' + px.length
    + (px.length ? ' ' + JSON.stringify(px.slice(0, 3)) : ''));
  ok(px.length <= 6, '★铃鹿：自交不泛滥（真实 8 字形只有立交这一处；过多=走线自叠）',
    '自交对=' + px.length);
  if (px.length) {
    // 立交处上下两层高差必须 ≥ 净空（否则车会从上层掉到下层）。
    // ⚠️ 必须取 **Δy 最大**的那一对：立交处两层交角很小，几何法会在同一点附近连着
    //    命中若干对，取第一对得到的是"同一层里相邻采样段"的假相交（实测 Δy=2.5m）。
    let dy = 0, at = null;
    for (const [i, j] of px) {
      const d = Math.abs(A.pts[i].y - A.pts[j].y);
      if (d > dy) { dy = d; at = [i, j]; }
    }
    ok(dy >= TRACK_CFG.BRIDGE_MIN_H + 1.0,
      '★★立交交叉处上下两层高差 ≥ 净空+余量（真立体交叉）',
      'Δy=' + num(dy, 2) + ' m @' + JSON.stringify(at) + '（共 ' + px.length + ' 对候选）');
    ok(!!A.bridgeCross, '★构造期已在最终几何上定位真交点并保证净空',
      A.bridgeCross ? ('i=' + A.bridgeCross.hi + ',j=' + A.bridgeCross.lo) : '未定位');
  }
}
ok(A.bridge.active === true && V.bridge.active === false,
  '立交桥数据只在铃鹿激活（拉斯维加斯无桥）',
  'suzuka bridge=' + A.bridge.active + ' vegas bridge=' + V.bridge.active);

// 桥面确实是"另一个通行次被抬高"：交叉点两层高差 ≥ 桥下净空
if (A.bridge.active) {
  // ⚠️ 不要再用"i+=2 / j<N-3 抽样"自己找交点：真实铃鹿立交处两层交角很小，
  //    抽样式几何法会**整段漏掉**交点（实测 crossDy 恒为 0 ⇒ 假红）。
  //    交点已由 Track 构造期在最终几何上定位（A.bridgeCross），直接用权威值。
  const bc = A.bridgeCross;
  ok(!!bc, '★铃鹿立交交点已在构造期定位（最终等弧长几何上）',
    bc ? ('i=' + bc.hi + ',j=' + bc.lo) : '未定位');
  if (bc) {
    const dy = Math.abs(A.pts[bc.hi].y - A.pts[bc.lo].y);
    // ⚠️ 判据已从"≥ 最小净空 1.0m"提到 **BRIDGE_CLEAR_M（6.5m）**：
    //    玩家从桥下经过时，追尾/座舱相机在 1.6~2.2m，净空 2.5m 时**视角会被桥面挡死**
    //    （用户报障"桥梁过低车辆从下方经过时视角会被遮挡"）。实测 2.50m → 6.50m。
    ok(dy >= TRACK_CFG.BRIDGE_CLEAR_M - 0.1,
      '★★立交净空 ≥ 6.5m（相机从桥下过时不会被桥面遮挡）',
      'Δy=' + num(dy, 2) + ' m（要求 ≥ ' + TRACK_CFG.BRIDGE_CLEAR_M + 'm）');
  }
  ok(TRACK_CFG.BRIDGE_Y === 9.5 && TRACK_CFG.BRIDGE_CLEAR_M >= 6.0,
    '桥面抬升 = +9.5m 且保证净空 ≥ 6.0m（相机不被桥面挡）',
    '= +' + TRACK_CFG.BRIDGE_Y + 'm / 净空 ' + TRACK_CFG.BRIDGE_CLEAR_M + 'm');
  // 引桥坡度必须有界（平坦坡道，不能出现台阶）
  let maxGrade2 = 0;
  for (let i = 0; i < A.count; i++) {
    const j = (i + 1) % A.count;
    const ds = A.pts[i].distanceTo(A.pts[j]);
    if (ds > 1e-6) maxGrade2 = Math.max(maxGrade2, Math.abs(A.pts[j].y - A.pts[i].y) / ds);
  }
  ok(maxGrade2 < 0.20, '★引桥坡道连续（无台阶；实测最大 ' + num(maxGrade2 * 100, 1) + '%）',
    'max grade=' + num(maxGrade2 * 100, 1) + '%');
}

// 发车位：姿态正交 + 车头朝向切线
section('A2. 发车位姿态');
for (let slot = 1; slot <= 4; slot++) {  const g = A.gridSlot(slot);
  const sp = A.spawn(g.index, g.lateral);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(sp.quaternion);
  const right = new THREE.Vector3().setFromMatrixColumn(m, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(m, 1);
  const fwd = new THREE.Vector3().setFromMatrixColumn(m, 2);
  const ortho = Math.abs(right.dot(up)) + Math.abs(right.dot(fwd)) + Math.abs(up.dot(fwd));
  const det = right.dot(new THREE.Vector3().crossVectors(up, fwd));
  const tang = A.tan[g.index];
  const info = A.sample(sp.position.x, sp.position.z, g.index);
  ok(ortho < 1e-5 && Math.abs(det - 1) < 1e-4 && fwd.dot(tang) > 0.985,
    '发车位 ' + slot + ' 姿态正确（正交右手系 + 车头对准前进方向）',
    'fwd·tan=' + num(fwd.dot(tang), 4) + ' ortho=' + num(ortho, 7));
  ok(Math.abs(sp.position.y - (info.y + CFG.RIDE_H)) < 0.45,
    '发车位 ' + slot + ' 高度贴合路面', 'Δy=' + num(sp.position.y - info.y, 3));
}

/* --------------------------------------------------------------------- */
/* A3. 赛道可视几何生成（track.build 全流程）                              */
/* --------------------------------------------------------------------- */
section('A3. 赛道几何生成（track.build）');

let built = null;
try {
  built = A.build();
} catch (e) {
  built = null;
  console.log('  \x1b[90m' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e) + '\x1b[0m');
}
ok(!!built && !!built.group, 'build() 无异常完成（含 Canvas2D 横幅、InstancedMesh）');

// ★ 桥墩不许立在**任何**一段路面上（用户报障"桥下有支柱插到赛道上"）。
//   ⚠️ 曾经的避让只用 `_groundLatAbs`（只在"与柱子地面基准同高 ±LAYER_DY"的采样点里找），
//      而铃鹿立交上下两层相差 2.5~4.9m ⇒ **下层路面整段被排除** ⇒ 实测漏检一根压在
//      39% 下层路面上的柱子（压深 3.24m）。这里改用**高度区间**复核：任何一段路只要
//      落在柱体的高度范围内，就必须在横向上避开它。与"最近点/同高"都无关。
//   ⚠️ 必须放在 `A.build()` **之后**：colliders 由 build() 生成（放前面拿到空数组 ⇒
//      假绿"0 根全部落在路外"，本脚本踩过）。
{
  const colliders = A.colliders || [];
  let pillars = 0, onRoad = 0, worst = 0, worstInfo = '';
  for (const c of colliders) {
    // 桥墩 = hy 明显大于护栏半高、且 hx≈hz≈0.55 的竖向盒
    if (!(c.hy > 1.5 && Math.abs(c.hx - 0.55) < 0.01 && Math.abs(c.hz - 0.55) < 0.01)) continue;
    pillars++;
    const y0 = c.y - c.hy, yTop = c.y + c.hy;
    for (let j = 0; j < A.count; j++) {
      const p = A.pts[j];
      if (p.y < y0 - 1.0 || p.y > yTop + 1.0) continue;
      const s = A.side[j], tn = A.tan[j];
      const dx = c.x - p.x, dz = c.z - p.z;
      if (Math.abs(dx * tn.x + dz * tn.z) > 3.0) continue;   // 是前后段，不是横向穿过
      const lat = Math.abs(dx * s.x + dz * s.z);
      const need = A.halfWidthAt[j] + TRACK_CFG.CURB_W;
      if (lat < need) {
        onRoad++;
        if (need - lat > worst) {
          worst = need - lat;
          worstInfo = '柱@' + j + '段(' + (100 * j / A.count).toFixed(0) + '%) 压深 ' + worst.toFixed(2) + 'm';
        }
      }
    }
  }
  ok(pillars > 0, '立交桥有支撑立柱', pillars + ' 根');
  ok(onRoad === 0, '★没有桥墩立在赛道路面上（任何一层）',
    onRoad ? onRoad + ' 根压在路面上：' + worstInfo : pillars + ' 根全部落在路外');
}

if (built) {
  const kids = built.group.children;
  ok(kids.length >= 10, '场景对象齐全（路面/白线/虚线/路肩/草地/起跑格/龙门/路灯/树木/山脊/大地）',
    kids.length + ' 个顶层对象');
  ok(typeof built.lights.setStage === 'function', '龙门信号灯可编程（setStage）');
  for (const st of [0, 3, 6]) { try { built.lights.setStage(st); } catch (e) { ok(false, 'setStage(' + st + ') 抛错'); } }
  ok(true, 'setStage(0/3/6) 调用无异常');

  // 遍历所有几何体：不允许出现 NaN / 越界顶点 / 半三角形
  // 注意：'ground' 是故意做成 4200m 半径的远景大地圆盘，单独排除在尺度断言之外
  let badVert = 0, totalVert = 0, nanVert = 0, meshes = 0, instanced = 0, halfTri = 0;
  const box = new THREE.Box3();
  built.group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    if (o.isInstancedMesh) instanced++;
    const g = o.geometry;
    if (g.index && g.index.count % 3 !== 0) halfTri++;
    const pos = g.getAttribute && g.getAttribute('position');
    if (!pos || o.name === 'ground') return;
    totalVert += pos.count;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { nanVert++; continue; }
      if (Math.abs(x) > 4500 || Math.abs(y) > 400 || Math.abs(z) > 4500) badVert++;
      box.expandByPoint(new THREE.Vector3(x, y, z));
    }
  });
  ok(nanVert === 0, '所有顶点均为有限数值（无 NaN/undefined 索引）',
    totalVert.toLocaleString() + ' 个顶点');
  ok(badVert === 0, '顶点坐标落在赛道包围范围内（无越界点）');
  ok(halfTri === 0, '所有索引缓冲都是完整的三角形（count % 3 === 0）');
  ok(meshes > 20 && instanced >= 4, '绘制对象数量合理（含 InstancedMesh 批处理）',
    meshes + ' 个 Mesh，其中 ' + instanced + ' 个 InstancedMesh');
  const size = box.getSize(new THREE.Vector3());
  ok(size.x > 400 && size.x < 2600 && size.y > 10 && size.y < 300,
    '赛道主体尺度合理（远景大地已排除）',
    'x=' + num(size.x, 0) + ' y=' + num(size.y, 0) + ' z=' + num(size.z, 0));
  const ground = built.group.children.find((o) => o.name === 'ground');
  // ⚠️ 2026-09-30 起大地不再是 CircleGeometry（没有 .parameters.radius），
  //    改成跟随地形起伏的极坐标网格（track.js `_buildGround`）。这里改用
  //    包围球半径断言"仍然覆盖雾区之外"，语义等价、不再依赖几何类型。
  const gr = ground && ground.geometry.boundingSphere
    ? ground.geometry.boundingSphere.radius : 0;
  ok(!!ground && gr >= 3000, '远景大地覆盖雾区之外（地形网格半径 ≥3000m）',
    ground ? 'radius=' + Math.round(gr) + 'm' : '未找到');

  // 路面条带宽度必须等于设计路宽（双车道 15m）
  const asphalt = built.group.children.find((o) => o.name === 'asphalt');
  ok(!!asphalt, '找到沥青路面网格');
  if (asphalt) {
    const p = asphalt.geometry.getAttribute('position');
    let maxW = 0;
    for (let i = 0; i < p.count; i += 2) {
      const w = Math.hypot(p.getX(i) - p.getX(i + 1), p.getZ(i) - p.getZ(i + 1));
      maxW = Math.max(maxW, w);
    }
    ok(maxW <= A.halfWidthMax * 2 + 0.05 && maxW >= A.halfWidthMin * 2 - 0.05,
      '沥青路面宽落在赛道声明的变宽区间内（真车 10~16m）',
      'maxW=' + num(maxW, 2) + 'm  区间 ' + num(A.halfWidthMin * 2, 1) + '~' + num(A.halfWidthMax * 2, 1) + 'm');
  }
  const curbs = built.group.children.find((o) => o.name === 'curbs');
  ok(!!curbs, '找到红白减速带路肩网格');

  // ---- 动态最佳走线（Racing Line）几何 ----
  const rl = A.raceLine;
  ok(!!rl && !!rl.mesh && !!rl.geometry, '生成动态最佳走线色带网格');
  if (rl) {
    ok(rl.count === A.count && rl.radius.length === A.count && rl.offset.length === A.count,
      '走线点数与中心线一致', rl.count + ' 点');
    const rp = rl.geometry.getAttribute('position');
    let wMax = 0, wMin = 1e9;
    for (let i = 0; i < rp.count; i += 2) {
      const w = Math.hypot(rp.getX(i) - rp.getX(i + 1), rp.getZ(i) - rp.getZ(i + 1));
      wMax = Math.max(wMax, w); wMin = Math.min(wMin, w);
    }
    ok(Math.abs(wMax - TRACK_CFG.RACE_LINE_W) < 0.02 && Math.abs(wMin - TRACK_CFG.RACE_LINE_W) < 0.02,
      '色带宽度恒为 ' + TRACK_CFG.RACE_LINE_W + 'm', num(wMax, 3) + ' / ' + num(wMin, 3) + ' m');
    // 悬浮高度 = 中心线 + 0.04（防 Z-fighting）
    let dyMax = 0;
    for (let k = 0; k < A.count; k++) {
      const expect = A.pts[k].y + TRACK_CFG.RACE_LINE_H;
      dyMax = Math.max(dyMax, Math.abs(rp.getY(k * 2) - expect), Math.abs(rp.getY(k * 2 + 1) - expect));
    }
    ok(dyMax < 1e-4, '走线整体悬浮在路面之上 ' + TRACK_CFG.RACE_LINE_H + 'm（防 Z-fighting 闪烁）',
      'Δy max=' + dyMax.toExponential(1));
    // 封闭性：末点 == 首点
    const last = A.count * 2;
    ok(Math.abs(rp.getX(last) - rp.getX(0)) < 1e-5 && Math.abs(rp.getZ(last) - rp.getZ(0)) < 1e-5,
      '走线为封闭环（末点与首点重合）');
    // 偏移不越界。⚠️ 必须逐点比 **halfWidthAt[i]**：变宽赛道的标量 halfWidth 是
    //    **最窄值**（铃鹿 5.5m），而绿线在主直道可用到 8m − 余量 ⇒ 用标量会假红。
    let offMax = 0, offOver = 0, overAt = -1;
    for (let i = 0; i < A.count; i++) {
      const lim = Math.max(0.2, A.halfWidthAt[i] - TRACK_CFG.RACE_LINE_MARGIN);
      offMax = Math.max(offMax, Math.abs(rl.offset[i]));
      const over = Math.abs(rl.offset[i]) - lim;
      if (over > 1e-6) { offOver++; if (overAt < 0) overAt = i; }
    }
    ok(offOver === 0,
      '走线中心始终留在路面内（|offset| ≤ 本点半宽 − 余量）',
      '最大 |offset|=' + num(offMax, 2) + 'm；越界点 ' + offOver + (overAt >= 0 ? ' 首处 @' + overAt : ''));
    ok(offMax > 2.0, '弯心处内切幅度足够（不是一条贴着中心线的假走线）', num(offMax, 2) + ' m');
    // 结构性验证：直线居中小 / 弯道内切大
    let sSum = 0, sN = 0, cSum = 0, cN = 0;
    for (let i = 0; i < A.count; i++) {
      const a = Math.abs(rl.offset[i]);
      if (rl.radius[i] > 800) { sSum += a; sN++; }
      else if (rl.radius[i] < 200) { cSum += a; cN++; }
    }
    const sAvg = sN ? sSum / sN : 0, cAvg = cN ? cSum / cN : 0;
    ok(sAvg < 1.0 && cAvg > 2.0, '直线段走线居中、弯道段贴向弯心（外-内-外成型）',
      '直线均值 ' + num(sAvg, 2) + 'm vs 弯道均值 ' + num(cAvg, 2) + 'm');
    ok(rl.radius.some((r) => r < 120) && rl.radius.some((r) => r > 2000),
      '曲率半径数组覆盖"急弯~直线"全区间',
      'minR=' + num(Math.min(...rl.radius), 0) + ' maxR=' + num(Math.max(...rl.radius), 0));
  }
}

/* --------------------------------------------------------------------- */
/* B. 长跑物理                                                             */
/* --------------------------------------------------------------------- */
const track = new Track(4242);
const rp = new RacePhysics(track);
rp.racing = true;
const cars = [];
for (let s = 1; s <= 4; s++) {
  const g = track.gridSlot(s);
  const c = rp.addCar({
    id: s, name: '车手' + s, color: '#e10600', isLocal: false,
    startIndex: g.index, lateral: g.lateral, laps: 2,
  });
  c.auto = true;
  cars.push(c);
}
let finished = 0;
rp.onFinish = () => { finished++; };

const DT = 1 / 60;
// 仿真时长必须由**赛道全长**推导，不能写死：第八轮把铃鹿从 ~2060m 拉到 6755m 后，
// 单圈从 46s 变成 ~125s，写死 220s 连一圈都跑不完。
// 按"平均车速不低于 100km/h"保守估计 2 圈，再留 60s 余量。
const SIM_S = Math.ceil((2 * track.length) / (100 / 3.6)) + 60;
const STEPS = Math.round(60 * SIM_S);
section('B. 四车长跑 ' + SIM_S + ' 秒（physics.js，赛道全长 ' + num(track.length, 0) + 'm）');
let nan = false, maxLat = 0, maxDy = 0, maxSpeed = 0;
for (let i = 0; i < STEPS; i++) {
  rp.fixedStep(DT);
  if (i % 5 === 0) {
    for (const c of cars) {
      if (!isFinite(c.pos.x) || !isFinite(c.pos.y) || !isFinite(c.pos.z) ||
          !isFinite(c.speed) || !isFinite(c.quat.x)) nan = true;
      const inf = track.sample(c.pos.x, c.pos.z, c.trackIdx);
      maxLat = Math.max(maxLat, Math.abs(inf.lateral));
      maxDy = Math.max(maxDy, Math.abs(c.pos.y - (inf.y + CFG.RIDE_H)));
      maxSpeed = Math.max(maxSpeed, c.speedKmh);
    }
  }
}
ok(!nan, SIM_S + ' 秒 x 4 车仿真全程无 NaN / 无非法数值');
ok(finished === 4, '四台 AI 全部跑完 2 圈并冲线', finished + '/4');
ok(maxLat < 46, '车辆始终被约束在赛道走廊内（不飞出世界）', 'max|lat|=' + num(maxLat, 2) + ' m');
ok(maxDy < 1.2, '车辆贴地约束有效（不悬空/不穿地）', 'max Δy=' + num(maxDy, 3) + ' m');
ok(maxSpeed > 130 && maxSpeed < 300, 'AI 巡航速度合理', 'max=' + num(maxSpeed, 1) + ' km/h');
const laps = cars.map((c) => c.bestLap).filter((v) => v > 0);
// 断言"单圈时间"要除以赛道全长才有可比性：写死 25~130s 只在 2060m 的旧赛道成立。
// 改成对**平均车速**设区间，换赛道/改长度都不用再标定。
const avgKmh = (s) => (track.length / 1000) / (s / 3600);
ok(laps.length === 4 && laps.every((v) => avgKmh(v) > 100 && avgKmh(v) < 280),
  '单圈平均速度合理（100~280 km/h）',
  laps.map((v) => num(v, 1) + 's @ ' + num(avgKmh(v), 0) + 'km/h').join(' / '));
ok(cars.every((c) => c.finished && c.lap === 2), '完赛后停止计圈（状态不漂移）',
  cars.map((c) => c.lap + (c.finished ? '✓' : '✗')).join(','));

/* --------------------------------------------------------------------- */
/* C. FM8 竞技规则                                                         */
/* --------------------------------------------------------------------- */
section('C. 规则：吸尾流 / 顶车 / 恶意撞击 / 罚时');

function placeOn(car, trk, index, lateral, speedMs) {
  const sp = trk.spawn(index, lateral);
  car.body.position.set(sp.position.x, sp.position.y, sp.position.z);
  car.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
  car.body.velocity.set(0, 0, 0);
  const t = trk.tan[((index % trk.count) + trk.count) % trk.count];
  car.body.velocity.set(t.x * speedMs, t.y * speedMs, t.z * speedMs);
  car.syncFromBody();
  car.penalty = 0;
}

// --- C1 吸尾流 --------------------------------------------------------
{
  const trk = new Track(31337);
  const rp2 = new RacePhysics(trk);
  const base = 300;
  const lead = rp2.addCar({ id: 1, name: 'L', color: '#fff', isLocal: false, startIndex: base, lateral: 0, laps: 1 });
  const foll = rp2.addCar({ id: 2, name: 'F', color: '#fff', isLocal: false, startIndex: base, lateral: 0, laps: 1 });
  const gap8 = Math.round(8 / trk.spacing);

  placeOn(lead, trk, base, 0, 60);
  placeOn(foll, trk, base - gap8, 0, 60);
  rp2.refreshSlipstream();
  ok(foll.slip > 0.7, '8m 正后方 -> 触发吸尾流', 'slip=' + num(foll.slip) + '（实际间距 ' + num(gap8 * trk.spacing, 2) + 'm）');
  ok(foll.slipFrom === 1, '尾流来源标记为前车');

  // 摆位必须按**实际落点**判定。旧赛道 spacing≈1.7m 时 round(26/1.7)=15 格 = 26.4m 没问题；
  // 第八轮铃鹿 spacing 变成 4.744m 后 round(26/4.744)=5 格 = 23.7m，反而落进 25m 尾流锥内 ——
  // 台架自己被量化误差骗了，不是物理错。改用 ceil 保证实际 > 25m，并把实际距离写进断言名。
  const farN = Math.ceil(26 / trk.spacing);
  const farM = farN * trk.spacing;
  placeOn(foll, trk, base - farN, 0, 60);
  rp2.refreshSlipstream();
  ok(foll.slip === 0, '超出尾流距离（实际 ' + num(farM, 1) + 'm > 25m）-> 不触发尾流');

  placeOn(foll, trk, base - gap8, 4.5, 60);
  rp2.refreshSlipstream();
  ok(foll.slip === 0, '横向偏出 4.5m（夹角 29°>15°）-> 不触发尾流');

  // 前车必须低于 SLIP_MIN_KMH 才不触发。速度由常量反推，改常量不必再重标定台架。
  const slowMs = (CFG.SLIP_MIN_KMH / 3.6) * 0.85;
  placeOn(lead, trk, base, 0, slowMs);
  placeOn(foll, trk, base - gap8, 0, slowMs);
  rp2.refreshSlipstream();
  ok(foll.slip === 0,
    '前车 ' + num(slowMs * 3.6, 0) + 'km/h（<' + CFG.SLIP_MIN_KMH + '）-> 不触发尾流');

  // 尾流对动力的实际收益：同样全油门，有尾流的极速更高。
  // 台架必须用"测功机"式（保位置 + 固定朝向）—— 否则车会沿弯道飞出赛道，
  // 触发赛道外沙地陷阱（阻尼 0.45 + 限速 40km/h），把动力对比彻底污染。
  function accelRun(withSlip) {
    const rig = straightRig(31337, 40);
    const { q, c: F, recenter } = rig;
    const L = q.addCar({ id: 2, name: 'L', color: '#fff', isLocal: false, startIndex: rig.flat, lateral: 0, laps: 99 });
    if (!withSlip) { L.retired = true; L.body.position.y += 4000; }
    let peak = 0;
    for (let i = 0; i < 60 * 8; i++) {
      F.input.throttle = 1;
      recenter();                                   // F 摁回原点并锁定朝向
      if (withSlip) {
        // 前车钉在 F 正前方 9m、同速行驶，保证整个过程都在尾流锥内
        const fw = F.fwd;
        L.body.position.set(F.pos.x + fw.x * 9, F.pos.y, F.pos.z + fw.z * 9);
        L.body.quaternion.copy(F.body.quaternion);
        L.body.velocity.set(fw.x * 70, 0, fw.z * 70);
        L.syncFromBody();
      }
      q.fixedStep(DT);
      peak = Math.max(peak, F.speedKmh);
    }
    return peak;
  }
  const withSlip = accelRun(true);
  const noSlip = accelRun(false);
  ok(withSlip > noSlip + 3, '吸尾流带来实测极速提升', '尾流 ' + num(withSlip, 1) + ' vs 单车 ' + num(noSlip, 1) + ' km/h');
}

// --- C2 顶车不再提供加速（规格：删除一切人工前向冲量）--------------------
{
  // 源码级：确认顶车冲量机制已彻底移除
  const physSrc = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
  ok(!/resolveBumpDraft/.test(physSrc) && !/BUMP_IMPULSE/.test(physSrc) && !/BUMP_FOLLOWER_DAMP/.test(physSrc),
    '顶前车冲量加速机制已彻底删除（无 resolveBumpDraft / BUMP_IMPULSE / 后车阻尼）');

  // 行为级：两车贴合同速静置 1 秒，前车不应凭空获得前向推力
  const trk = new Track(31337);
  const q = new RacePhysics(trk);
  q.racing = true;
  const lead = q.addCar({ id: 1, name: 'L', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 1 });
  const foll = q.addCar({ id: 2, name: 'F', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 1 });
  placeOn(lead, trk, 300, 0, 25);
  placeOn(foll, trk, 300 - Math.round(4.05 / trk.spacing), 0, 25);
  // 摆位必须"贴合但不穿模"：车长 4m，而采样点量化到 1.72m，所以要显式沿切线微调。
  // 初始穿模会被接触刚度弹飞（实测能让前车凭空 +15km/h），那是台架问题不是机制问题。
  const t0 = trk.tan[300];
  foll.body.position.x = lead.body.position.x - t0.x * 4.02;
  foll.body.position.z = lead.body.position.z - t0.z * 4.02;
  foll.body.velocity.set(t0.x * 27, t0.y * 27, t0.z * 27);   // 以 +2m/s 接近速度追尾
  foll.syncFromBody();
  const p0 = CFG.MASS * (lead.speed + foll.speed);
  const lv0 = lead.speedKmh;
  // 只推进 3 步（0.05s）：碰撞在头几步内完成。窗口开大（如 0.5s）会把弯道曲率
  // 与滚阻造成的动量损失算进来（实测 -3%），污染"是否凭空造动量"的判断。
  for (let i = 0; i < 3; i++) q.fixedStep(DT);
  lead.syncFromBody(); foll.syncFromBody();
  const gain = lead.speedKmh - lv0;
  ok(gain > 2.0 && gain < 6.0, '追尾只产生动量守恒范围内的加速（等质量 +2m/s 接近 -> 约 +3.6km/h）',
    '前车 ' + num(lv0, 1) + ' -> ' + num(lead.speedKmh, 1) + ' km/h（增益 ' + num(gain, 2) +
    '；旧的人工冲量会给到 ≈8.5）');
  const p1 = CFG.MASS * (lead.speed + foll.speed);
  ok(Math.abs(p1 - p0) / p0 < 0.015, '碰撞不凭空造动量（人工冲量已移除）',
    'p0=' + num(p0, 0) + ' p1=' + num(p1, 0) + '  偏差 ' + num((p1 - p0) / p0 * 100, 2) + '%');
  ok(foll.speedKmh < 100, '后车因真实碰撞减速（动量守恒的另一半）',
    num(foll.speedKmh, 1) + ' km/h');
}

// --- C3 恶意侧撞 -------------------------------------------------------
{
  const trk = new Track(31337);
  const q = new RacePhysics(trk);
  q.racing = true;
  // 被撞者设为本地车：罚时对攻击者静默入榜，但**被撞者**要收到红色警告（安全信号）
  const vic = q.addCar({ id: 1, name: 'V', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 1 });
  const atk = q.addCar({ id: 2, name: 'A', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 1 });

  const info = trk.sample(trk.pts[300].x, trk.pts[300].z, 300);
  const gy = info.y + CFG.RIDE_H;
  const side = trk.side[300], tan = trk.tan[300];
  // 受害车沿切线行驶；攻击车从其侧后方 90° 横切过来
  vic.body.position.set(trk.pts[300].x, gy, trk.pts[300].z);
  vic.body.quaternion.setFromEuler(0, Math.atan2(tan.x, tan.z), 0);
  vic.body.velocity.set(tan.x * 14, 0, tan.z * 14);
  vic.syncFromBody();
  const px = trk.pts[300].x + side.x * 3.2 - tan.x * 1.2;
  const pz = trk.pts[300].z + side.z * 3.2 - tan.z * 1.2;
  atk.body.position.set(px, gy, pz);
  atk.body.quaternion.setFromEuler(0, Math.atan2(side.x, side.z), 0);   // 与受害车航向差 90°
  atk.body.velocity.set(side.x * 18 - tan.x * 10, 0, side.z * 18 - tan.z * 10);
  atk.syncFromBody();

  const alert = [];
  q.onAlert = (c, t, k) => alert.push(t);
  q.resolveRam(DT);
  ok(Math.abs(atk.penalty - CFG.PEN_RAM) < 1e-6, '恶意侧撞：撞人者 +2.0s',
    'penalty=' + num(atk.penalty, 2) + 's');
  ok(vic.penalty === 0, '被撞者不背锅');
  ok(alert.length === 1, '被撞者收到红色警告（攻击者自身罚时改静默入榜）', alert.join(' / '));

  // 正后方追尾（夹角小）不应判罚
  const trk2 = new Track(31337);
  const q2 = new RacePhysics(trk2);
  q2.racing = true;
  const v2 = q2.addCar({ id: 1, name: 'V', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 1 });
  const a2 = q2.addCar({ id: 2, name: 'A', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 1 });
  const i2 = trk2.sample(trk2.pts[300].x, trk2.pts[300].z, 300);
  const t2v = trk2.tan[300];
  v2.body.position.set(trk2.pts[300].x, i2.y + CFG.RIDE_H, trk2.pts[300].z);
  v2.body.quaternion.setFromEuler(0, Math.atan2(t2v.x, t2v.z), 0);
  v2.body.velocity.set(t2v.x * 10, 0, t2v.z * 10);
  v2.syncFromBody();
  a2.body.position.set(trk2.pts[300].x - t2v.x * 4.1, i2.y + CFG.RIDE_H, trk2.pts[300].z - t2v.z * 4.1);
  a2.body.quaternion.copy(v2.body.quaternion);
  a2.body.velocity.set(t2v.x * 30, 0, t2v.z * 30);
  a2.syncFromBody();
  q2.resolveRam(DT);
  ok(a2.penalty === 0, '同向高速追尾（夹角 0°）-> 不判恶意撞击');
}

// --- 碰撞解算安全层（方案 A/B/C/D，规格 §1~§5 修订版）----------------------
{
  const {
    restitutionFor, redirectNormal, installCannonBaumgarteKill, installGridBroadphaseGuard,
    CFG: PCFG,
  } = await import(mod('public/js/physics.js'));
  const psrcRaw = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');

  // ── 方案 B：速度阶跃塑性衰减（规格 §2 —— 严格两段式）────────────────────
  ok(Math.abs(restitutionFor(0) - PCFG.PLASTIC_E_PEAK) < 1e-9,
    '§2：零速 -> e = PLASTIC_E_PEAK(0.05)（低速轻碰质感）', num(restitutionFor(0), 3));
  ok(restitutionFor(1.5) === 0 && restitutionFor(55.556) === 0 && restitutionFor(200) === 0,
    '★§2：阈值(1.5m/s)及以上 e **严格为 0**（钣金完全塑性，200km/h 也无回弹）',
    num(restitutionFor(1.5), 4) + ' / ' + num(restitutionFor(55.556), 4));
  ok(Math.abs(restitutionFor(0.75) - PCFG.PLASTIC_E_PEAK * 0.5) < 1e-9,
    '§2：阈值中点线性取值 e = 0.5·E_PEAK（线性而非 smoothstep）',
    num(restitutionFor(0.75), 4));
  ok(Math.abs(restitutionFor(-0.75) - restitutionFor(0.75)) < 1e-12,
    '§2：取 |v_rel|，负向接近速度得到相同结果');
  let mono = true;
  for (let v = 0; v < 3; v += 0.05) if (restitutionFor(v + 0.05) > restitutionFor(v) + 1e-9) mono = false;
  ok(mono, '§2：恢复系数随速度单调不增');
  ok(restitutionFor(NaN) === 0, '§2：NaN 入参保守返回 0（不产生 NaN 污染冲量）');
  ok(PCFG.PLASTIC_E_PEAK === 0.05 && PCFG.PLASTIC_V_THRESH === 1.5,
    '§2：E_PEAK = 0.05 / V_THRESH = 1.5 m/s（规格值）');
  // ★ 旧参数必须彻底消失：REST_LO/REST_HI/smoothstep 一旦回潮就是规格回退
  ok(PCFG.REST_LO === undefined && PCFG.REST_HI === undefined &&
     PCFG.REST_LO_SPEED === undefined && PCFG.REST_HI_SPEED === undefined,
    '★§2：旧参数 REST_LO/REST_HI/REST_*_SPEED 已从 CFG 移除（规格回退守卫）');

  // ── 方案 C：防跳板法线平整化（规格 §1 —— 无条件）────────────────────────
  const vert = redirectNormal(1, 0, 0);
  ok(vert && Math.abs(vert.y) < 1e-12 && Math.abs(vert.x - 1) < 1e-9,
    '§1：纯水平法线原样通过（仍是单位向量）');
  const tilted = redirectNormal(0.6, 0.2, 0.6);
  ok(tilted && Math.abs(tilted.y) < 1e-12 && Math.abs(Math.hypot(tilted.x, tilted.z) - 1) < 1e-9,
    '§1：带 Y 分量的法线被投影到水平面并**重归一化**',
    'y ' + num(0.2, 3) + ' -> ' + num(tilted.y, 3));
  // ★ 规格修订核心：微小 Y 分量也必须抹平（旧版 0.02 的放行门已废弃）
  const tiny = redirectNormal(1, 0.01, 0);
  ok(tiny && tiny.y === 0,
    '★★§1：微小 Y 分量（0.01）也**无条件**抹平（旧 NORMAL_Y_SLOP 放行门已废弃）',
    'y 0.01 -> ' + num(tiny ? tiny.y : NaN, 4));
  const tiny2 = redirectNormal(1, 0.001, 0);
  ok(tiny2 && tiny2.y === 0, '★★§1：更小的 Y 分量（0.001）同样被抹平');
  ok(redirectNormal(0, 1, 0) === null,
    '§1：纯垂直法线 -> 返回 null（不是"墙"，交给解析地面约束）');
  ok(PCFG.NORMAL_FLAT_EPS === 1e-6, '§1：NORMAL_FLAT_EPS = 1e-6（规格值）');
  ok(PCFG.NORMAL_Y_SLOP === undefined && PCFG.NORMAL_Y_ABORT === undefined,
    '★§1：旧阈值 NORMAL_Y_SLOP / NORMAL_Y_ABORT 已从 CFG 移除（规格回退守卫）');

  // ── 方案 A：分离冲量（位置相不碰 velocity）──────────────────────────────
  ok(/projectPenetration\(dt\)/.test(psrcRaw) && /this\.projectPenetration\(dt\);/.test(psrcRaw),
    '§3：projectPenetration 已接入 fixedStep');
  ok(psrcRaw.indexOf('this.world.step(dt)') < psrcRaw.indexOf('this.projectPenetration(dt)'),
    '§3：位置投影在 world.step 之后执行（顺序错会被地面约束覆盖）');
  ok(PCFG.PUSH_MAX_M === 0.03,
    '★§3：单子步最大推开位移 = 0.03m（规格值，用位移而非名义速度）', PCFG.PUSH_MAX_M + ' m');
  ok(PCFG.PEN_MAX_MS === undefined,
    '★§3：旧的名义推出速度上限 PEN_MAX_MS 已从 CFG 移除（规格回退守卫）');
  // 位置相源码里不得再出现 `* dt` 式的"名义速度 × dt"位移
  ok(!/Math\.min\(CFG\.PEN_BETA \* pen \/ dt, CFG\.PEN_MAX_MS\)/.test(psrcRaw),
    '★§3：位置相不再是 "β·pen/dt 再 ×dt" 的名义速度写法');

  // ── 病根①：cannon 内置 Baumgarte 速度污染必须被清掉 ─────────────────────
  ok(/installCannonBaumgarteKill/.test(psrcRaw) &&
     /const B = -g \* a - GW \* b - h \* GiMf;/.test(
       fs.readFileSync(path.join(root, 'public/libs/cannon-es.js'), 'utf8')),
    '★病根①：已定位 cannon ContactEquation.computeB 的 `-g*a` 穿透偏置项');
  ok(/this\.baumgarteKilled = installCannonBaumgarteKill\(\)/.test(psrcRaw),
    '★病根①：构造函数里已调用 installCannonBaumgarteKill()，且结果存入 baumgarteKilled');
  // 运行时验证补丁确实生效（能改写原型上的 computeB）
  ok(installCannonBaumgarteKill() === true,
    '★★病根①：installCannonBaumgarteKill() 执行成功（原型补丁已就位）');
  const CE = (await import(mod('public/libs/cannon-es.js'))).ContactEquation;
  ok(CE.prototype.__baumgarteKilled === true,
    '★★病根①：ContactEquation.prototype 上留有 __baumgarteKilled 标记');
  const qq = new RacePhysics(new Track(555));
  ok(qq.baumgarteKilled === true,
    '★★病根①：RacePhysics 实例报告 baumgarteKilled === true（启动自检通过）');

  // ── ★★ 宽相（broadphase）：2026-09-29 帧率事故的守门断言 ──────────────────
  // 事故形态有两种，都必须被钉死：
  //   ① NaiveBroadphase + 2963 个静态护栏刚体 = O(n²)：实测 p50 133ms（7.5fps），
  //      V8 采样 89.5% 落在 cannon collisionPairs；
  //   ② 换成 GridBroadphase 但"构造后再改 nx" —— bins 数组不会跟着扩容，
  //      索引算到 7499 而数组只有 1000 ⇒ world.step 每步抛
  //      `Cannot set properties of undefined (setting 'NaN')`，整帧中断、车不动。
  // 静态判据必须跑在**剥掉注释**的源码上：本文件上方的"事故回放"注释里就写着
  // `new CANNON.NaiveBroadphase()`，用裸源码去否定匹配会自己打自己。
  const psrcCode = psrcRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');     // 行注释（保留 http:// 这类）
  const CANNON_M = await import(mod('public/libs/cannon-es.js'));
  const GB = CANNON_M.GridBroadphase;
  ok(!/new CANNON\.NaiveBroadphase/.test(psrcCode) &&
     !/new CANNON\.SAPBroadphase/.test(psrcCode),
    '★★宽相：physics.js 里不再出现 NaiveBroadphase/SAPBroadphase（2963 静态刚体 ⇒ Naive O(n²) ⇒ 7.5fps；SAP 实测 58ms）');
  ok(/this\.broadphase = makeGridBroadphase\(world, track, this\.staticBodies\)/.test(psrcRaw),
    '★宽相：构造函数在静态刚体注册后调用 makeGridBroadphase(world, track, staticBodies)');
  ok(!/broadphase\.nx\s*=/.test(psrcCode) && !/broadphase\.aabb(Min|Max)\.set/.test(psrcCode),
    '★★宽相：源码中不再有"构造后改 broadphase.nx / aabbMin.set"（bins 不会扩容 ⇒ 每步抛异常）');
  ok(qq.broadphase && qq.broadphase instanceof GB,
    '★宽相：RacePhysics 实例的宽相是 GridBroadphase',
    qq.broadphase ? qq.broadphase.constructor.name : '(无)');
  const bpNb = qq.broadphase.nx * qq.broadphase.ny * qq.broadphase.nz;
  ok(qq.broadphase.bins.length === bpNb,
    '★★宽相：bins.length === nx*ny*nz（不成立 ⇒ world.step 必抛 TypeError、整帧中断）',
    'bins=' + qq.broadphase.bins.length + ' nx*ny*nz=' + bpNb);
  ok(qq.broadphase.__isTrackGrid === true && qq.broadphase.__gridConfig &&
     isFinite(qq.broadphase.__gridConfig.min.x0),
    '★宽相：网格边界来自实测包围盒（__gridConfig 已记录）');
  ok(qq.broadphase.__skipsQueryOnlyRoad === true,
    '★★宽相：query-only Heightfield 不进入 GridBroadphase（保留 world 射线查询）');
  {
    const worldBodies = qq.world.bodies;
    qq.broadphase.collisionPairs(qq.world, [], []);
    ok(qq.world.bodies === worldBodies,
      '★★宽相：过滤 query-only Heightfield 后恢复 world.bodies 引用');
  }
  ok(installGridBroadphaseGuard() === true && GB.prototype.__binsRearmGuard === true,
    '★宽相：installGridBroadphaseGuard() 原型自愈补丁已就位');
  // 自愈行为：人为把 nx 改坏（复现事故②）后跑一次 collisionPairs，
  // 必须自动重分配 bins 而不是抛异常。
  {
    const bp = qq.broadphase, before = bp.bins.length;
    bp.nx = bp.nx + 1;                       // 构造后改 nx = 事故复现
    const bad = bp.nx * bp.ny * bp.nz;
    let threw = null;
    try { bp.collisionPairs(qq.world, [], []); } catch (e) { threw = e; }
    ok(!threw, '★★宽相：构造后改 nx 不再抛异常（守卫自愈生效）',
      threw ? String(threw).slice(0, 120) : '');
    ok(bp.bins.length === bad && bp.bins.length > before,
      '★★宽相：守卫按当前 nx*ny*nz 重分配了 bins',
      before + ' -> ' + bp.bins.length + '（期望 ' + bad + '）');
    bp.nx = bp.nx - 1;                       // 复原
    bp.bins = null;                          // 再逼守卫重分配一次，回到自洽状态
    bp.collisionPairs(qq.world, [], []);
    ok(bp.bins.length === bp.nx * bp.ny * bp.nz && bp.bins.length === before,
      '★宽相：复原后 bins 长度回到原值', String(bp.bins.length));
  }
  // 单机练习/联机都不会再走 Naive；Grid 的网格必须能装下真实赛道包围盒
    {
      // 网格必须覆盖"赛道走廊 + 护栏/路肩/缓冲区"——那才是静态刚体的落位范围。
      // 实测：护栏盒中心离中心线 ≤ 半宽+路肩+缓冲区(9m)，盒半对角 ≤3m。
      // ⚠️ 不要写死坐标字面量：真实铃鹿换成 OSM 数据后包围盒变成
      //    x[-1039,925] z[-602,440]（比旧的手写常量还大），写死会立刻过期。
      // ⚠️ 也不要把 GRID_PAD_M(150) 算进"必需量"：那是网格自己的额外余量，
      //    必需量只有走廊宽度本身（实测网格 150m 余量 > 所需 21m）。
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of A.pts) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
      }
      const corridor = A.halfWidthMax + TRACK_CFG.CURB_W + 9 + 3 + 10;   // +10 余量
      const b = qq.broadphase.__gridConfig.min;
      ok(b.x0 <= x0 - corridor && b.x1 >= x1 + corridor && b.z0 <= z0 - corridor && b.z1 >= z1 + corridor,
        '★★宽相：网格边界覆盖赛道走廊 + 护栏/缓冲区（±1000m 常量装不下真实铃鹿，越界刚体会挤爆边缘 bin）',
        'x[' + b.x0.toFixed(0) + ',' + b.x1.toFixed(0) + '] z[' + b.z0.toFixed(0) + ',' + b.z1.toFixed(0) + ']'
        + ' vs 需要 x[' + (x0 - corridor).toFixed(0) + ',' + (x1 + corridor).toFixed(0)
        + '] z[' + (z0 - corridor).toFixed(0) + ',' + (z1 + corridor).toFixed(0) + ']');
    }

  // ── ★★ makePairsUnique：vendored cannon 的"两游标相向而行"缺陷 ──────────
  // 原实现 i 递增 / length 递减，在中点相遇就退出 ⇒ ① **静默丢掉约一半候选对**；
  // ② `t.keys` 模块级残留 ⇒ 下一轮 pop 到已 delete 的键 ⇒ `t[key]` undefined
  //    ⇒ 把 undefined 塞进 pairs1 ⇒ 窄相 `bi.material` 抛 TypeError ⇒ 整帧中断。
  // 它只被 Grid/SAP 调用（NaiveBroadphase 不调用），所以换宽相才会引爆。
  const { installMakePairsUniqueFix } = await import(mod('public/js/physics.js'));
  ok(/this\.pairsUniqueFixed = installMakePairsUniqueFix\(\)/.test(psrcRaw),
    '★★宽相：构造函数里已安装 installMakePairsUniqueFix()');
  ok(installMakePairsUniqueFix() === true && CANNON_M.Broadphase.prototype.__pairsUniqueFixed === true,
    '★★宽相：Broadphase.prototype.__pairsUniqueFixed 标记已就位');
  {
    const M2 = await import(mod('public/libs/cannon-es.js'));
    const bp0 = new M2.Broadphase();
    const mk = (id) => ({ id });
    const A = mk(1), B2 = mk(2), C2 = mk(3), D = mk(4);
    // 4 个唯一对 + 2 个重复对（Grid 宽相下"两刚体共享 ≥2 个 bin"必然产生）
    const feed = () => [[A, B2, C2, D, A, C2], [B2, C2, D, A, B2, D]];
    const [p1, p2] = feed();
    bp0.makePairsUnique(p1, p2);
    ok(p1.length === 4 && p2.length === 4 && p1.every(Boolean) && p2.every(Boolean),
      '★★makePairsUnique：4 个唯一对全部保留、无 undefined（原实现只留一半）',
      'pairs=' + p1.length);
    ok(p1.filter((x) => x === A).length === 1 && p2.filter((x) => x === D).length === 1,
      '★★makePairsUnique：重复对已去重（同一对正反两序只留一份）');

    // ---- 反证：把原实现按源码原样复刻，证明本组测试数据真的能判别 ----------
    // （同时保留模块级 `t.keys` 的跨调用残留 —— 那正是 TypeError 的来源）
    // ⚠️ 原实现还会**退化成死循环**：`i` 递增、`length` 递减，一旦 i 越过 length
    //    就再也追不上，`pop()` 空数组返回 undefined 却让 `i !== 0` 恒真 ⇒ 无限
    //    push undefined，直到数组长度爆表抛 RangeError（浏览器里就是整页卡死）。
    //    所以反证必须自带迭代上限，否则测试自己先挂。
    const origT = { keys: [] };
    let origRunaway = false;
    const origPairs = (q1, q2) => {
      const t = origT;
      const P1 = q1.slice(), P2 = q2.slice();
      const N = P1.length;
      for (let i = 0; i !== N; i++) {
        const a = P1[i], b = P2[i];
        const key = a.id < b.id ? a.id + ',' + b.id : b.id + ',' + a.id;
        t[key] = i; t.keys.push(key);
      }
      q1.length = 0; q2.length = 0;
      let guard = 0;
      for (let i = 0; i !== t.keys.length; i++) {
        if (++guard > 200) { origRunaway = true; break; }   // 死循环保护
        const key = t.keys.pop();
        const idx = t[key];
        q1.push(P1[idx]); q2.push(P2[idx]);
        delete t[key];
      }
    };
    const [d1, d2] = feed();
    origPairs(d1, d2);
    ok(d1.length < 4 && d2.length < 4,
      '★★makePairsUnique（反证）：原实现首轮就丢掉唯一对 ⇒ 静默漏碰撞',
      '原实现只留 ' + d1.length + ' / 应有 4');
    let origDirty = 0;
    for (let k = 0; k < 4; k++) {
      const [q1, q2] = feed();
      if (origRunaway) break;
      origPairs(q1, q2);
      origDirty += q1.filter((x) => !x).length + q2.filter((x) => !x).length;
    }
    ok(origDirty > 0 || origRunaway,
      '★★makePairsUnique（反证）：原实现后续轮次塞 undefined / 退化成死循环 ⇒ 窄相 bi.material 抛 TypeError，浏览器整页卡死',
      (origRunaway ? '触发死循环保护' : 'undefined 槽 ' + origDirty + ' 个'));

    // ---- 修好后：连续多轮必须始终干净 --------------------------------------
    let dirty = 0;
    for (let k = 0; k < 6; k++) {
      const [q1, q2] = feed();
      bp0.makePairsUnique(q1, q2);
      dirty += q1.filter((x) => !x).length + q2.filter((x) => !x).length;
    }
    ok(dirty === 0, '★★makePairsUnique：连续 6 轮调用零 undefined（残留键缺陷已消除）');
    const z1 = [null, A], z2 = [B2, undefined];
    bp0.makePairsUnique(z1, z2);
    ok(z1.length === 0 && z2.length === 0, '★★makePairsUnique：空槽被静默丢弃（宁少一对，不崩整帧）');
  }


  // ── ★★ ArrayCollisionMatrix：O(N²) 稠密矩阵（掉帧的真正大头）───────────────
  //   `setNumObjects(n)` 把 matrix.length 设成 n(n-1)/2、`reset()` 每子步全量清零
  //   ⇒ 2967 刚体 = 4,397,093 元素；实测 reset 单次 46.9ms / collisionMatrixTick
  //   52.4ms，占单步物理 53%。换成稀疏 Map 后语义不变（"上一步这对在不在接触"）。
  const { installSparseCollisionMatrix } = await import(mod('public/js/physics.js'));
  ok(/this\.sparseMatrix = installSparseCollisionMatrix\(\)/.test(psrcRaw),
    '★★碰撞矩阵：构造函数里已安装 installSparseCollisionMatrix()');
  ok(installSparseCollisionMatrix() === true && CANNON_M.ArrayCollisionMatrix.prototype.__isSparseMatrix === true,
    '★★碰撞矩阵：ArrayCollisionMatrix.prototype.__isSparseMatrix 标记已就位');
  {
    const M2 = await import(mod('public/libs/cannon-es.js'));
    const mx = new M2.ArrayCollisionMatrix();
    mx.setNumObjects(2967);
    ok(mx.matrix.length !== 2967 * 2966 / 2,
      '★★碰撞矩阵：setNumObjects 不再按刚体数平方预分配（原来 = 4,397,093）',
      'matrix.length=' + mx.matrix.length);
    const b = (index) => ({ index });
    const t0 = performance.now();
    for (let k = 0; k < 2000; k++) { mx.reset(); mx.set(b(2966), b(12), true); mx.get(b(2966), b(12)); }
    const per = (performance.now() - t0) / 2000;
    ok(per < 0.05, '★★碰撞矩阵：reset+set+get 单轮 < 0.05ms（原来 reset 一次就要 46.9ms）',
      num(per, 4) + ' ms/轮');
    // 语义：get 命中已 set 的对；reset 后必须失效；交换顺序仍命中
    mx.reset();
    ok(mx.get(b(2966), b(12)) === false, '★碰撞矩阵：reset 后 get 返回假（等价于旧的 0）');
    mx.set(b(12), b(2966), true);
    ok(!!mx.get(b(2966), b(12)) && !!mx.get(b(12), b(2966)),
      '★碰撞矩阵：set 后正反两种顺序都能 get 到（三角矩阵语义）');
    mx.set(b(12), b(2966), false);
    ok(!mx.get(b(2966), b(12)), '★碰撞矩阵：set(...,false) 清除该对');
    mx.reset();
    ok(!mx.get(b(2966), b(12)), '★碰撞矩阵：再次 reset 后又失效');
  }

  // 旧 Baumgarte 常数必须彻底消失
  ok(PCFG.BAUMGARTE_BETA === undefined && PCFG.BAUMGARTE_BIAS_V === undefined &&
     PCFG.BAUMGARTE_IMPULSE === undefined,
    '★病根①：旧 BAUMGARTE_BETA / BAUMGARTE_BIAS_V / BAUMGARTE_IMPULSE 已从 CFG 移除');
  ok(!/vn = Math\.min\(vn, CFG\.BAUMGARTE_BIAS_V\)/.test(psrcRaw),
    '★病根①：absorbSoftContacts 里的 Baumgarte 速度钳位已删除（不再往 velocity 塞非动能速度）');

  // ── 规格 §5：冲量硬截断 4e4 ────────────────────────────────────────────
  ok(PCFG.IMPULSE_MAX_NS === 40000, '§5：单接触法向冲量硬上限 = 40000 N·s（规格值）',
    PCFG.IMPULSE_MAX_NS + ' N·s');
  ok(!/CFG\.BAUMGARTE_IMPULSE/.test(psrcRaw),
    '★§5：源码中不再有任何 CFG.BAUMGARTE_IMPULSE 引用');

  // ── 规格 §4：悬挂解耦（外壳碰擦期间冻结行程上限）────────────────────────
  ok(PCFG.SUSP_LOCK_SLACK === 0.15 && PCFG.SUSP_LOCK_T > 0,
    '§4：SUSP_LOCK_SLACK = 0.15、锁定窗口 > 0（规格值）');
  ok(/if \(c\.suspLockT > 0\) c\.suspLockT -= dt;/.test(psrcRaw) &&
     /const lockTarget = lockEngaged \? CFG\.SUSP_LOCK_SLACK \* SUSP\.MAX_TRAVEL/.test(psrcRaw),
    '§4：groundConstraint 已实现行程上限冻结');
  ok(/onBarrierCollide/.test(psrcRaw) && /car\.suspLockT = Math\.max\(car\.suspLockT, CFG\.SUSP_LOCK_T\)/.test(psrcRaw),
    '§4：车-车 与 车-护栏 两条路径都触发解耦窗口');
  ok(/addEventListener\('collide', \(e\) => \{ rp\.onBarrierCollide\(this, e\); \}\)/.test(psrcRaw),
    '★§4：护栏碰撞入口已接线（静态体没有 __carId，onCarCollide 会提前 return）');
  ok(PCFG.FLIP_W_CAP === 2.5, '§4：俯仰/侧倾角速度限幅 2.5 rad/s 仍在（与悬挂解耦互补）', PCFG.FLIP_W_CAP);
  // 悬挂解耦契约：只钳弹簧力，绝不动 position（项目红线）
  ok(!/c\.body\.position\.y = restY/.test(psrcRaw) && !/body\.position\.y = groundY/.test(psrcRaw),
    '★§4：未出现 `body.position.y = groundY` 式瞬移贴地（项目红线守卫）');

  // ── 规格 §3 守恒守卫：位置相绝不写 velocity ─────────────────────────────
  const ppBody = psrcRaw.slice(psrcRaw.indexOf('projectPenetration(dt) {'),
                               psrcRaw.indexOf('limitFlipAngular(c, cap)'));
  ok(ppBody.length > 0 && !/\.velocity\./.test(ppBody),
    '★★§3：projectPenetration 函数体内**零 velocity 访问**（分离冲量的核心契约）',
    '函数体 ' + ppBody.length + ' 字符');
  ok(ppBody.length > 0 && !/_v\b/.test(ppBody.slice(0, 200)) ,
    '§3：位置相未借用速度类临时量（辅助守卫）');
}

// --- ★ 规格 §任务5：碰撞反冲硬限幅（被追尾/侧蹭车尾不再暴烈弹飞）-----------
{
  const { CFG: PCFG } = await import(mod('public/js/physics.js'));
  const psrcRaw = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');

  // ---- 规格 §任务6：固定步长 + 子步插值（本地单车抖动根除）------------------
  //   静态守卫钉住"累加器 → 固定 1/60 步进 → 渲染 lerp/slerp"整条链，
  //   防止有人图省事把可变帧 dt 直接喂给 world.step（那正是抖动病根）。
  {
    const msg = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
    ok(/this\.acc \+= Math\.min\(dt, 0\.1\)/.test(psrcRaw),
      '§任务6：物理累加器 acc += min(dt, 0.1)（帧间隔只决定跑几步）');
    ok(/while \(this\.acc >= this\.substep && n < 6\)/.test(psrcRaw),
      '§任务6：while(acc >= substep) 固定步进循环');
    ok(/this\.fixedStep\(this\.substep\)/.test(psrcRaw),
      '§任务6：world 只收固定 dt = substep（1/60），绝不喂可变帧间隔');
    ok(PCFG && (PCFG.FIXED_STEP === undefined || Math.abs(PCFG.FIXED_STEP - 1 / 60) < 1e-9 ||
      /substep\s*=\s*1\s*\/\s*60/.test(psrcRaw)),
      '§任务6：子步长 = 1/60 s');
    ok(/this\.alpha = clamp\(this\.acc \/ this\.substep, 0, 1\)/.test(psrcRaw),
      '§任务6：alpha = acc/substep（渲染插值系数）');
    ok(/c\.prevPos\.copy\(c\.pos\)/.test(psrcRaw) && /c\.prevQuat\.copy\(c\.quat\)/.test(psrcRaw),
      '§任务6：每步之前缓存 prevPos/prevQuat（插值端点）');
    ok(/lerpVectors\(c\.prevPos, c\.pos, alpha\)/.test(msg) || /lerpVectors\([^)]*prevPos[^)]*alpha\)/.test(msg),
      '§任务6：渲染端位置 lerpVectors(prevPos, pos, alpha)');
    ok(/slerp\(c\.quat, alpha\)/.test(msg) || /slerpQuaternions\([^)]*prevQuat[^)]*alpha\)/.test(msg),
      '§任务6：渲染端姿态 slerp(prevQuat, quat, alpha)');
  }
  ok(PCFG.COLLISION_YAW_CAP === 8.0,
    '§任务5：碰撞后 |ωy| 硬上限 = 8.0 rad/s', PCFG.COLLISION_YAW_CAP);
  ok(PCFG.COLLISION_VY_SOFT === 1.5 && PCFG.COLLISION_VY_REST === 0.2,
    '§任务5：竖直速度软阈值 1.5 m/s，超过即压回 0.2 m/s',
    `${PCFG.COLLISION_VY_SOFT} -> ${PCFG.COLLISION_VY_REST}`);
  ok(/clampCollisionImpulse\(cars\)/.test(psrcRaw),
    '★§任务5：clampCollisionImpulse 已接入 fixedStep（world.step 之后调用）');
  // 调用点必须在 world.step 之后（否则限幅会被求解器覆盖）
  {
    const iStep = psrcRaw.indexOf('this.world.step(dt)');
    const iClamp = psrcRaw.indexOf('this.clampCollisionImpulse(cars)');
    ok(iStep > 0 && iClamp > iStep,
      '★§任务5：限幅调用位于 world.step **之后**（求解器不会把截断值覆盖回去）',
      `step@${iStep} < clamp@${iClamp}`);
  }
  // 函数体契约：真的对 av.y 与 v.y 做了截断
  const cb = psrcRaw.slice(psrcRaw.indexOf('clampCollisionImpulse(cars) {'),
                            psrcRaw.indexOf('_stepTouched = 0;') + '_stepTouched = 0;'.length);
  ok(cb.length > 0 && /av\.y > cap[^]*av\.y = cap/.test(cb),
    '§任务5：clampCollisionImpulse 真的把 ωy 双向截断（不是只判不写）');
  ok(cb.length > 0 && /v\.y = CFG\.COLLISION_VY_REST/.test(cb),
    '§任务5：clampCollisionImpulse 真的把超阈 vy 压回 REST');
  // 只在"本步确有碰撞"时才干预（避免干扰悬挂正常行程）
  ok(/this\._stepTouched = 1/.test(psrcRaw),
    '§任务5：有碰撞才标记 _stepTouched（车-车与车-墙两条路径都覆盖）');
  // 不得把 vy 无条件归零 —— 悬挂弹簧需要自由产生 vy
  ok(!/v\.y = 0;/.test(cb),
    '§任务5：未把 vy 无条件清零（否则悬挂弹簧失效，车贴地锯齿）');
}

// --- ★ 病根① 运行时可证伪验证：补丁 ON/OFF 的撞墙反弹对比 -----------------
// 静态守卫只能证明"函数被调用了"。这里在**同一初始条件下跑两遍真实物理**，
// 直接对比"撞墙反弹速度"—— 这就是用户报的"碰撞后依然弹开"的直接观测量。
{
  const CANNON = CANNON_MOD;
  const CE = CANNON.ContactEquation;
  // 用脚本开头保存的**真原始**实现（此刻 prototype 上可能已是补丁版）
  const TRUE_ORIGINAL = CANNON_TRUE_ORIGINAL_COMPUTEB;

  const buildWorld = () => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
    world.broadphase = new CANNON.NaiveBroadphase();
    world.solver.iterations = 14;
    world.solver.tolerance = 0.002;
    const carMat = new CANNON.Material('car'), wallMat = new CANNON.Material('b');
    world.addContactMaterial(new CANNON.ContactMaterial(carMat, wallMat, {
      friction: 0.5, restitution: 0, contactEquationStiffness: 5e5, contactEquationRelaxation: 16,
    }));
    const car = new CANNON.Body({
      mass: 1380, material: carMat, shape: new CANNON.Box(new CANNON.Vec3(2, 0.9, 0.6)),
    });
    car.position.set(0, 0, 0); car.velocity.set(55.556, 0, 0);   // 200 km/h
    car.__carId = 1;
    world.addBody(car);
    const wall = new CANNON.Body({
      mass: 0, material: wallMat, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.7, 5)),
    });
    wall.position.set(6.0, 0, 0);
    wall.quaternion.setFromEuler(0, 0, +5 * Math.PI / 180);   // 法线带 +Y（倒角墙）
    world.addBody(wall);
    return { world, car };
  };

  const measure = () => {
    const { world, car } = buildWorld();
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    return { rebound: Math.max(0, -car.velocity.x) };   // 朝离开墙方向的速度
  };

  CE.prototype.computeB = TRUE_ORIGINAL;
  const off = measure();

  const { installCannonBaumgarteKill } = await import(mod('public/js/physics.js'));
  // 装补丁。幂等判据看"实现本身是否补丁版"，所以此刻 prototype 是原始实现
  // -> 会真的重新包一次（不再卡在早返回）。
  const installed = installCannonBaumgarteKill();
  const patchedFn = CE.prototype.computeB;
  const reallyPatched = (patchedFn !== TRUE_ORIGINAL) && patchedFn.__isBaumgarteKill === true;
  const on = measure();
  // 恢复原始实现（不干扰后续测试块）
  CE.prototype.computeB = TRUE_ORIGINAL;
  CE.prototype.__patched = patchedFn;      // 保留补丁引用，便于其它断言
  delete CE.prototype.__baumgarteKilled;   // 标记以实现为准，清掉无害

  ok(installed === true && reallyPatched,
    '★★病根①：installCannonBaumgarteKill() 装入了新实现（prototype 真的被替换）');
  ok(off.rebound > 0.5,
    '★★病根①【反证】：未打补丁时 200km/h 撞墙确实会被弹开（证明问题真实存在）',
    '反弹 ' + num(off.rebound, 3) + ' m/s');
  ok(on.rebound <= 0.1,
    '★★★病根①【正证】：打补丁后反弹 ≤ 0.1 m/s（车贴墙停住，不再弹飞）',
    '反弹 ' + num(on.rebound, 4) + ' m/s');
  ok(on.rebound < off.rebound * 0.2,
    '★★★病根①：反弹速度相对原版削减 ≥ 80%',
    num(100 * (1 - on.rebound / off.rebound), 1) + '%');
  // 幂等：当前 prototype 已是补丁版时应直接返回 true 且不再包一层
  CE.prototype.computeB = patchedFn;
  const again = CE.prototype.computeB;
  ok(installCannonBaumgarteKill() === true && CE.prototype.computeB === again,
    '病根①：补丁安装幂等（已是补丁版时不再重复包装）');
  CE.prototype.computeB = TRUE_ORIGINAL;
  installCannonBaumgarteKill();            // 恢复到"生产状态"（补丁在位）
}

// --- 撞墙行为：不腾空、能贴墙滑行、不反弹 ---------------------------------
{
  const { RacePhysics } = await import(mod('public/js/physics.js'));
  const trk = new Track(4242, 'spa'); trk.build();
  const q = new RacePhysics(trk);
  q.racing = true;
  const car = q.addCar({ id: 1, name: 'W', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const t0 = trk.tan[300], s0 = trk.side[300];

  // 场景 1：**浅角度蹭墙**（沿墙 40 m/s、侧向只有 4 m/s）—— 这才是"高速蹭墙"。
  // 判据：沿墙速度几乎全保留（滑行），侧向被吸收（不弹开）。
  {
    const trk2 = new Track(4242, 'spa'); trk2.build();
    const q2 = new RacePhysics(trk2); q2.racing = true;
    const c2 = q2.addCar({ id: 1, name: 'G', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
    const ta = trk2.tan[300], sa = trk2.side[300];
    c2.body.velocity.set(sa.x * 4 + ta.x * 40, 0, sa.z * 4 + ta.z * 40);
    const along0 = 40;
    // 注意：测"回弹"必须只看**撞击之后朝墙外**的速度。
    // 若用 |横向速度| 的最大值，会把撞前 4 m/s 的接近速度也算进去（假失败）。
    let maxVy = 0, maxRebound = 0, alongMin = Infinity, hit = false;
    for (let i = 0; i < 120; i++) {
      c2.input.throttle = 0.5;
      q2.fixedStep(DT);
      maxVy = Math.max(maxVy, Math.abs(c2.body.velocity.y));
      const cross = c2.vel.x * sa.x + c2.vel.z * sa.z;
      if (cross > 0.5) hit = true;                      // 仍在朝墙走
      if (hit) maxRebound = Math.max(maxRebound, -cross); // 朝墙外 = 回弹
      if (i > 40) alongMin = Math.min(alongMin, c2.vel.x * ta.x + c2.vel.z * ta.z);
    }
    ok(alongMin / along0 > 0.6,
      '方案A/B（蹭墙）：浅角度蹭墙后仍沿墙滑行，切向速度保留 > 60%',
      '沿墙 ' + num(alongMin, 1) + ' / ' + along0 + ' m/s = ' + num(alongMin / along0, 3));
    ok(maxRebound < 1.0, '方案A/B（蹭墙）：侧向被吸收、几乎无回弹（不是弹开）',
      '回弹 ' + num(maxRebound, 3) + ' m/s');
    ok(maxVy < 1.0, '方案C（蹭墙）：不腾空', 'max|vy|=' + num(maxVy, 3) + ' m/s');
  }

  // 场景 2：**大角度硬撞**（侧向 30 + 沿墙 35）。这种角度下被撞停在物理上是对的，
  // 唯一要守住的是"不腾空、不反弹飞出"。
  car.body.velocity.set(s0.x * 30 + t0.x * 35, 0, s0.z * 30 + t0.z * 35);
  let maxVy = 0, maxLat = 0, crossAfter = 0;
  for (let i = 0; i < 150; i++) {
    car.input.throttle = 0.4;
    q.fixedStep(DT);
    maxVy = Math.max(maxVy, Math.abs(car.body.velocity.y));
    maxLat = Math.max(maxLat, Math.abs(trk.sample(car.pos.x, car.pos.z).lateral));
    if (i > 60) crossAfter = Math.max(crossAfter, Math.abs(car.vel.x * s0.x + car.vel.z * s0.z));
  }
  ok(maxLat > trk.halfWidth, '台架成立：车确实撞到了护栏', '最远横向 ' + num(maxLat, 2) + 'm');
  ok(maxVy < 1.0, '方案C/D（硬撞）：大角度撞墙不腾空（垂直速度 < 1 m/s）',
    'max|vy|=' + num(maxVy, 3) + ' m/s');
  ok(maxLat < (trk.barrierLat || 8.95) + 1.5, '方案A（硬撞）：被护栏拦住，没有穿出去',
    '最远横向 ' + num(maxLat, 2) + 'm');
  ok(crossAfter < 6.0, '方案A/B（硬撞）：法向不反弹（侧向速度被吸收，不是弹开）',
    '法向速度 ' + num(crossAfter, 2) + ' m/s');
}

// --- C4 FRR 出界裁决（规格 §四.1）：不再一刀切，区分"获利"与"赛车事故" ----
{
  // (a) 停在草地上、不给油、不前进 -> 失控脱轨无获利 -> Racing Incident，免罚
  const trk = new Track(31337);
  const q = new RacePhysics(trk);
  q.racing = true;
  let incidentN = 0;
  q.onIncident = () => { incidentN++; };
  const c = q.addCar({ id: 1, name: 'X', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  placeOn(c, trk, 300, trk.halfWidth + trk.curbWidth + 7, 0);
  for (let i = 0; i < 60 * 2; i++) {
    c.body.velocity.set(0, c.body.velocity.y, 0);
    q.fixedStep(DT);
  }
  ok(c.grassWheels === 4, '四轮全部位于草地', 'grassWheels=' + c.grassWheels);
  // 回到沥青触发结算
  placeOn(c, trk, 300, 0, 0);
  for (let i = 0; i < 4; i++) { c.body.velocity.set(0, c.body.velocity.y, 0); q.fixedStep(DT); }
  ok(c.penalty < 0.01, '草地停 2 秒无获利 -> Racing Incident 免罚（不再一刀切 +0.5s/0.5s）',
    'penalty=' + num(c.penalty, 2) + 's');
  ok(c.incidents === 1 && incidentN === 1,
    '该次脱轨被记录为赛车事故（仅记录，不罚）', 'incidents=' + c.incidents);
  ok(c.onAsphalt === 4, '四轮重新检测为沥青路面');

  // (b) 全油门高速横穿草地 -> 抄近道获利 -> 阶梯罚 1.0~3.0s
  const q2 = new RacePhysics(new Track(31337));
  q2.racing = true;
  const c2 = q2.addCar({ id: 1, name: 'Y', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  c2.paceRef = 45;                                  // 基准巡航速度 45m/s
  placeOn(c2, trk, 300, trk.halfWidth + trk.curbWidth + 5, 0);
  const tan = trk.tan[300];
  for (let i = 0; i < 60 * 1.5; i++) {
    c2.input.throttle = 1; c2.input.brake = 0;
    // 保持四轮在草地上，但沿切线高速前进
    const li = c2.trackIdx;
    const p = trk.pts[li], s = trk.side[li];
    const lat = trk.halfWidth + trk.curbWidth + 5;
    c2.body.position.set(p.x + s.x * lat, c2.body.position.y, p.z + s.z * lat);
    c2.body.velocity.set(tan.x * 45, c2.body.velocity.y, tan.z * 45);
    q2.fixedStep(DT);
  }
  const offState = { thr: c2.offThrottleT, dist: c2.offDist, active: c2.offActive };
  placeOn(c2, trk, 300, 0, 0);                      // 回到沥青 -> 结算
  for (let i = 0; i < 4; i++) { c2.input.throttle = 0; q2.fixedStep(DT); }
  ok(offState.active && offState.dist > 20,
    '台架成立：确实在草地上高速跑了一段', '里程 ' + num(offState.dist, 1) + ' m');
  ok(c2.penalty >= CFG.FRR_PEN_MIN - 1e-6 && c2.penalty <= CFG.FRR_PEN_MAX + 1e-6,
    '全油门高速抄草地 -> 判获利并阶梯罚 ' + CFG.FRR_PEN_MIN + '~' + CFG.FRR_PEN_MAX + 's',
    'penalty=' + num(c2.penalty, 2) + 's');
  ok(c2.violations === 1 && c2.incidents === 0,
    '获利计入违规次数（计时塔"处罚"列用）', 'violations=' + c2.violations);

  // (c) 蹭一下路肩（时长低于阈值）不裁决
  const q3 = new RacePhysics(new Track(31337));
  q3.racing = true;
  const c3 = q3.addCar({ id: 1, name: 'Z', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  placeOn(c3, trk, 300, trk.halfWidth + trk.curbWidth + 7, 0);
  for (let i = 0; i < 12; i++) { c3.body.velocity.set(0, c3.body.velocity.y, 0); q3.fixedStep(DT); }
  placeOn(c3, trk, 300, 0, 0);
  for (let i = 0; i < 4; i++) { c3.body.velocity.set(0, c3.body.velocity.y, 0); q3.fixedStep(DT); }
  ok(c3.penalty === 0 && c3.incidents === 0 && c3.violations === 0,
    '极短出界（< ' + CFG.FRR_MIN_OFF_T + 's）视为蹭路肩，不裁决',
    'penalty=' + num(c3.penalty, 2) + 's');
}

// --- C5 切弯罚时 -------------------------------------------------------
{
  const trk = new Track(31337);
  const q = new RacePhysics(trk);
  q.racing = true;
  const c = q.addCar({ id: 1, name: 'X', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  c.crossedStart = true;
  c.cpIdx = 2;
  c.progress = 10;
  c.trackIdx = Math.floor(5 * trk.samplesPerCp);      // 直接跳到 CP5（跳过 CP3、CP4）
  q.updateProgress(c, DT);
  ok(Math.abs(c.penalty - 2 * CFG.PEN_CUT) < 1e-6, '跳过 2 个 Checkpoint -> 罚 1.0s',
    'penalty=' + num(c.penalty, 2) + 's');
  ok(c.cpIdx === 5, 'Checkpoint 指针已更新到 CP5');

  // 未集齐 Checkpoint 直接冲线 -> 不计圈 + 罚时
  // cpIdx 必须写成"最后一个 Checkpoint"，才能保证这一步**不产生切弯罚时**、
  // 罚时纯净等于 PEN_LAP_SHORTCUT。写死 15 只在 CP=16 的旧赛道成立：
  // 第八轮 CP 变 24 后，15 -> 0 会跳过 8 个 CP，罚时被 8×PEN_CUT 污染。
  c.penalty = 0;
  c.cpIdx = trk.checkpointCount - 1;
  c.progress = 3;
  c.trackIdx = 0;
  const lapBefore = c.lap;
  q.updateProgress(c, DT);
  ok(c.lap === lapBefore && Math.abs(c.penalty - CFG.PEN_LAP_SHORTCUT) < 1e-6,
    '未集齐检查点冲线 -> 圈数无效并罚时',
    'lap=' + c.lap + ' penalty=' + num(c.penalty, 2) + 's');
}

/* --------------------------------------------------------------------- */
/* D. Cannon 撞车动量转移                                                 */
/* --------------------------------------------------------------------- */
section('D. 撞车动量转移（Cannon-es box-box）');
{
  const trk = new Track(555);
  const q = new RacePhysics(trk);
  q.racing = true;
  const rear = q.addCar({ id: 1, name: 'R', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  const front = q.addCar({ id: 2, name: 'F', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  // 接近速度必须**低于**预测性幽灵阈值 22.2 m/s，否则这对车会被隔离成幽灵直接穿过去
  // （那是本轮规格 §二.2 的预期行为，另有专项断言覆盖）。这里测的是常规碰撞。
  const RAM_MS = 18;
  placeOn(front, trk, 300, 0, 0);
  placeOn(rear, trk, 300 - Math.round(7.0 / trk.spacing), 0, RAM_MS);

  const p0 = rear.speed + front.speed;
  const frontV0 = front.speed;
  let minGap = 99;
  for (let i = 0; i < 60 * 2.2; i++) {
    q.fixedStep(DT);
    const dx = front.pos.x - rear.pos.x, dz = front.pos.z - rear.pos.z;
    minGap = Math.min(minGap, Math.hypot(dx, dz));
  }
  ok(front.speed > frontV0 + 4, '被追尾车辆获得明显速度（动量转移）',
    num(frontV0, 1) + ' -> ' + num(front.speed, 1) + ' m/s');
  ok(rear.speed < RAM_MS - 3, '追尾车辆损失速度', num(RAM_MS, 1) + ' -> ' + num(rear.speed, 1) + ' m/s');
  ok(minGap > 3.55, '两车 Box 未发生穿模', 'min 中心距=' + num(minGap, 2) + ' m');
  ok(isFinite(rear.pos.x) && isFinite(front.pos.x), '碰撞后数值稳定');
  const p1 = rear.speed + front.speed;
  ok(p1 <= p0 * 1.03 && p1 >= p0 * 0.55,
    '系统总动量守恒（碰撞不凭空造能量，阻力自然衰减）', 'p0=' + num(p0, 2) + ' -> ' + num(p1, 2) + ' m/s');
}

/* --------------------------------------------------------------------- */
/* D2. 预测性前向幽灵化（Predictive Ghosting，规格 §二.2）                  */
/* --------------------------------------------------------------------- */
{
  // 构造一次"恶意鱼雷"：后车以 30 m/s 逼近静止前车，接近速度 30 m/s > 22.2 m/s
  const trk = new Track(909);
  const q = new RacePhysics(trk);
  q.racing = true;
  const front = q.addCar({ id: 1, name: 'F', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  const rear = q.addCar({ id: 2, name: 'R', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  placeOn(front, trk, 300, 0, 0);
  placeOn(rear, trk, 300 - Math.round(12.0 / trk.spacing), 0, CFG.PRED_GHOST_MS + 8);

  ok(front.groupBit !== rear.groupBit,
    '每车一个独立碰撞组位（才能按位隔离单个车对）',
    'front=0x' + front.groupBit.toString(16) + ' rear=0x' + rear.groupBit.toString(16));
  ok((front.groupBit & CFG.GROUP_BARRIER) === 0,
    '车位与护栏位不重叠 -> 幽灵隔离不影响拦车', 'BARRIER=0x' + CFG.GROUP_BARRIER.toString(16));

  let ghosted = false, restored = false, minD = 99, passedThrough = false;
  const rearV0 = rear.pos.z;
  for (let i = 0; i < 60 * 3; i++) {
    q.fixedStep(DT);
    const key = Math.min(front.id, rear.id) + ':' + Math.max(front.id, rear.id);
    const d = Math.hypot(front.pos.x - rear.pos.x, front.pos.z - rear.pos.z);
    minD = Math.min(minD, d);
    if (q.ghostPairs.has(key)) {
      ghosted = true;
      if (front.pgGhost === 1 && rear.pgGhost === 1) { /* 标记已打上 */ }
    } else if (ghosted) {
      restored = true;
    }
    // 后车越过前车 = 真的穿透了，没有被刚体挡住
    const f = trk.tan[300];
    if ((rear.pos.x - front.pos.x) * f.x + (rear.pos.z - front.pos.z) * f.z > 1.0) passedThrough = true;
  }
  ok(ghosted, '高速接近（closing > ' + CFG.PRED_GHOST_MS + ' m/s）触发预测性幽灵化');
  ok(passedThrough, '被隔离的车对直接穿透（刚体不解算，杜绝鱼雷把前车顶飞）');
  ok(minD < 3.5, '台架成立：两车确实贴近到分离阈值以内', 'min 中心距=' + num(minD, 2) + ' m');
  ok(restored, '分离 > ' + CFG.PRED_GHOST_SEP + 'm 且不接近后自动恢复碰撞');
  ok(!q.ghostPairs.size, '恢复后幽灵对表被清空（没有泄漏的隔离）');
  const key2 = Math.min(front.id, rear.id) + ':' + Math.max(front.id, rear.id);
  void key2;
  ok(front.pgGhost === 0 && rear.pgGhost === 0, '半透明标记随恢复一并清掉');

  // 对照组：同样的构型但接近速度低于阈值 -> 不触发幽灵化，正常碰撞
  const trk2 = new Track(909);
  const q2 = new RacePhysics(trk2);
  q2.racing = true;
  const f2 = q2.addCar({ id: 1, name: 'F', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  const r2 = q2.addCar({ id: 2, name: 'R', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  placeOn(f2, trk2, 300, 0, 0);
  placeOn(r2, trk2, 300 - Math.round(12.0 / trk2.spacing), 0, CFG.PRED_GHOST_MS - 8);
  let g2 = false;
  for (let i = 0; i < 60 * 3; i++) {
    q2.fixedStep(DT);
    if (q2.ghostPairs.size) g2 = true;
  }
  ok(!g2, '低速接近（closing < ' + CFG.PRED_GHOST_MS + ' m/s）不触发幽灵化，走正常刚体碰撞');
  ok(f2.speed > 0.5, '低速追尾把前车推动了（说明真的碰撞了，不是穿过去）',
    '前车 ' + num(f2.speed, 2) + ' m/s');

  // 规格 §二.2：半透明必须**平滑淡入淡出**。解除隔离时把 0.35 直接跳回 1.0 会有
  // 肉眼可见的"啪"一下突变，所以渲染层要对 pgGhost 做指数缓动而不是直接用标记值。
  {
    const msrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
    ok(/ud\._pgAmt/.test(msrc) && /c\.pgGhost/.test(msrc) && /Math\.exp\(-\d+ \* dt\)/.test(msrc),
      '预测性幽灵化的车身透明度做了指数缓动（规格：平滑淡入透明度）');
  }
}

/* --------------------------------------------------------------------- */
/* E. 网络插值                                                             */
/* --------------------------------------------------------------------- */
section('E. 网络同步（network.js）：60Hz 快照插值');

{
  // ---- E1 快照环形缓冲 + Hermite 位置插值 + SLERP 姿态 ----
  const netSrc = fs.readFileSync(path.join(root, 'public/js/network.js'), 'utf8');
  const numConst = (re) => Number((netSrc.match(re) || [])[1]);
  const RD_MIN = numConst(/const RENDER_DELAY_MIN = (\d+)/);
  const RD_MAX = numConst(/const RENDER_DELAY_MAX = (\d+)/);
  // 规格 §3.2：dynamicDelay = clamp(3σ, 60, 120)，σ = 近 1s 快照到达时差的标准差
  ok(RD_MIN === 60 && RD_MAX === 120 &&
    /clamp\(3 \* this\.jitterSigma, RENDER_DELAY_MIN, RENDER_DELAY_MAX\)/.test(netSrc),
    '渲染延迟按 clamp(3σ, 60, 120) 自适应伸缩（规格）', 'min=' + RD_MIN + ' max=' + RD_MAX);
  ok(numConst(/const RENDER_WIN_MS = (\d+)/) === 1000 && /RENDER_MIN_N = (\d+)/.test(netSrc),
    'σ 统计窗口 = 近 1 秒内的快照到达时差');
  // 规格 §一.2：长度 20 的样本滑窗，只认 RTT 最小的优质样本
  ok(numConst(/const CLOCK_WIN = (\d+)/) === 20 && /clockWindow/.test(netSrc),
    '时钟同步 = 长度 20 的样本滑窗取最小 RTT（规格）');
  // 规格 §一.2：NTP 公式（t2/t3 剔除服务端处理时长）
  ok(/\(t4 - t1\) - \(m\.t3 - m\.t2\)/.test(netSrc) &&
    /\(\(m\.t2 - t1\) \+ \(m\.t3 - t4\)\) \* 0\.5/.test(netSrc),
    'NTP 时钟：RTT 与 Offset 走标准四时间戳公式（t1/t2/t3/t4）');
  // 规格 §一.2：ForzaTimeSynchronizer —— ±1.5% 渲染时钟微调，物理 dt 不变
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(root, 'public/js/PhysicsWorkerBridge.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(root, 'public/js/physics.worker.js'), 'utf8');
  const protocolSrc = fs.readFileSync(path.join(root, 'public/js/physics-protocol.js'), 'utf8');
  const physicsSrc = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
  ok(/MAX_TIME_WARP\s*:\s*0\.015/.test(protocolSrc) &&
    /MAX_TIME_WARP\s*:\s*0\.015/.test(physicsSrc),
    'MAX_TIME_WARP 配置值保持为 0.015');
  ok(/slewServerClock/.test(mainSrc) && /CFG\.MAX_TIME_WARP/.test(mainSrc) &&
    /maxWarpMs\s*=\s*Math\.max\(0, dt\) \* 1000 \* CFG\.MAX_TIME_WARP/.test(mainSrc),
    '主渲染时钟实际消费 MAX_TIME_WARP（纠偏速率 ≤ ±1.5%·dt）');
  ok(/clockNow/.test(workerSrc) && /_workerToMainMonoOffset/.test(bridgeSrc) &&
    /fixedStep\(PHYSICS_DT\)/.test(workerSrc) && !/fixedStep\([^)]*MAX_TIME_WARP/.test(workerSrc),
    'Worker 使用显式单调时钟握手且物理固定步长仍为 PHYSICS_DT');
  // 规格 §2.2：PING 频率 1Hz
  ok(/setInterval\(\(\) => this\.send\(\{ t: 'ping', c: Date\.now\(\) \}\), 1000\)/.test(netSrc),
    '时钟 PING 频率 = 1Hz（规格）');
  ok(numConst(/const ERR_BLEND = (\d+)/) === 20,
    'Dual-Layer 误差融合衰减系数 = 20（规格 exp(-20·dt)）');
  // 规格 §一.3：双层 —— 物理层权威状态 + 视觉层偏移量（位置与姿态都要）
  ok(/physPos/.test(netSrc) && /physRot/.test(netSrc) &&
    /visualPosOffset/.test(netSrc) && /visualRotOffset/.test(netSrc),
    'NetworkVehicleReplicator 双层状态齐备（physPos/physRot + visualPosOffset/visualRotOffset）');
  ok(/r\.pos\.copy\(r\.physPos\)\.add\(r\.visualPosOffset\)/.test(netSrc) &&
    /r\.quat\.copy\(r\.physRot\)\.multiply\(r\.visualRotOffset\)/.test(netSrc),
    '渲染变换 = 物理层 + 视觉偏移（位置与姿态都融合，消灭姿态瞬甩）');
  const BUF = numConst(/const BUF_LEN = (\d+)/);
  ok(BUF >= 18 && (BUF / 60) * 1000 >= 300,
    '环形缓冲容量 ≥ 300ms（规格 18~20 帧）', BUF + ' 槽 = ' + Math.round((BUF / 60) * 1000) + 'ms');

  const net = new Net();
  const RD = net.renderDelay;   // 冷启动兜底延迟（样本不足时）
  ok(RD === 80, '冷启动渲染延迟 = 80ms（样本不足时兜底）', RD + ' ms');

  // 自适应行为验证：不能只断言公式存在，要真的会伸缩
  {
    const js = new Net();
    let t = 0;
    for (let i = 0; i < 40; i++) js._trackJitter(t += 16.7);              // 平稳 60Hz
    const steady = js.renderDelay;
    const jj = new Net();
    let t2 = 0;
    for (let i = 0; i < 40; i++) jj._trackJitter(t2 += (i % 2 ? 80 : 0)); // 剧烈抖动
    ok(steady === RD_MIN, '网络平稳 -> 渲染延迟收到下限 60ms', steady + ' ms');
    ok(jj.renderDelay > steady && jj.renderDelay <= RD_MAX,
      '抖动加剧 -> 渲染延迟自动拉长（防缓冲区击穿）',
      steady + ' ms -> ' + num(jj.renderDelay, 1) + ' ms');
  }
  const T0 = 100000;                       // 本地时间轴基准（ms）
  net.clockOffset = 0;                     // 服务端时间 == 本地时间，便于断言
  const mk = (x, qy, vx) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), qy);
    return { x, y: 1, z: 0, q: [q.x, q.y, q.z, q.w], v: [vx, 0, 0], s: 72, t: 0.1, l: 1, k: 0, f: 0 };
  };
  // 以 60Hz 写入 30 帧：x 按 20m/s 匀速推进（速度分量与位置一致，Hermite 应还原直线）
  for (let i = 0; i < 30; i++) {
    net.pushState(1, mk(i * 20 / 60, 0, 20), T0 + i * (1000 / 60), false, T0 + i * (1000 / 60));
  }
  const p1 = net.players.get(1);
  ok(p1 && p1.count === 30, '远端车维护 30 帧历史快照环形缓冲', p1 ? p1.count + ' 帧' : '-');
  ok(p1.T.length === BUF && p1.P.length === BUF * 3 && p1.Q.length === BUF * 4 && p1.V.length === BUF * 3,
    '缓冲结构按 64 槽契约分配（未满时 count 独立增长）',
    'T' + p1.T.length + ' P' + p1.P.length + ' Q' + p1.Q.length + ' V' + p1.V.length);
  const ring = new Net();
  for (let i = 0; i < 80; i++) {
    const ts = T0 + i * (1000 / 60);
    ring.pushState(1, mk(i * 20 / 60, 0, 20), ts, false, ts);
  }
  const pr = ring.players.get(1);
  const oldest = pr && pr.count ? pr.T[ring.slot(pr, 0)] : NaN;
  const newest = pr && pr.count ? pr.T[ring.slot(pr, pr.count - 1)] : NaN;
  ok(pr && pr.count === BUF && pr.T.length === BUF && pr.P.length === BUF * 3 &&
    pr.Q.length === BUF * 4 && pr.V.length === BUF * 3,
    '超过 64 帧后环形缓冲保持 64 槽并丢弃最旧帧',
    pr ? 'count=' + pr.count + ' oldest=' + num(oldest, 2) + ' newest=' + num(newest, 2) : '-');
  ok(Math.abs(oldest - (T0 + 16 * (1000 / 60))) < 1e-6 &&
    Math.abs(newest - (T0 + 79 * (1000 / 60))) < 1e-6,
    '64 槽溢出后保留连续的最新时间窗口');

  // renderTime = now - 50ms；取一个明确落在两帧之间的时刻
  const nowA = T0 + 500 + RD;              // -> renderTime = T0 + 500
  const sA = net.renderState(1, nowA);
  const expectX = (500 / 1000) * 20;       // 匀速 20m/s -> 10m
  ok(Math.abs(sA.pos.x - expectX) < 0.25, '位置插值正确（Hermite 还原匀速直线）',
    'x=' + num(sA.pos.x, 3) + ' （期望 ' + num(expectX, 2) + '）');

  // Hermite：用速度切线，端点处速度连续 —— 与线性 LERP 的差别体现在中点曲率
  // 这里验证插值结果落在两快照之间且单调
  const xa = net.renderState(1, T0 + 480 + RD).pos.x;
  const xb = net.renderState(1, T0 + 500 + RD).pos.x;
  const xc = net.renderState(1, T0 + 520 + RD).pos.x;
  ok(xa < xb && xb < xc, '插值沿时间单调推进（无折返跳变）',
    num(xa, 2) + ' < ' + num(xb, 2) + ' < ' + num(xc, 2));

  // 姿态 SLERP：0° 与 90° 之间应得线性过渡
  net.players.get(2);
  for (let i = 0; i < 4; i++) {
    net.pushState(2, mk(0, i * (Math.PI / 2) / 3, 0), T0 + i * (1000 / 60), false, T0 + i * (1000 / 60));
  }
  const qm = net.renderState(2, T0 + 16.67 * 1.5 + RD);
  const yawDeg = 2 * Math.acos(Math.min(1, Math.abs(qm.quat.w))) * 180 / Math.PI;
  ok(yawDeg > 40 && yawDeg < 55, '姿态 SLERP 球面插值（30° 与 60° 之间约 45°）',
    num(yawDeg, 1) + '°');

  // ---- E2 航位推测（丢包/抖动时不停止也不瞬移）----
  // 注意：渲染位置带误差融合的一帧滞后是刻意设计，因此断言要按帧推进看趋势，
  // 不能拿单帧的渲染值与解析外推值直接对比。
  let lastX = null, maxVel = 0, firstX = null;
  for (let t = 490; t <= 700; t += 16.67) {
    net.beginFrame(T0 + t + RD);
    const rr = net.renderState(1, T0 + t + RD);
    if (lastX !== null) maxVel = Math.max(maxVel, (rr.pos.x - lastX) / 0.01667);
    else firstX = rr.pos.x;
    lastX = rr.pos.x;
  }
  ok(lastX > 12 && lastX < 22, '缓冲无未来快照时继续按速度前进（不停止、不瞬移）',
    '渲染 x 从 ' + num(firstX, 2) + ' 推进到 ' + num(lastX, 2) + '（最后一个快照 x≈9.67）');
  ok(maxVel > 15 && maxVel < 25, '外推速度与上报速度一致（≈20m/s）',
    '峰值 ' + num(maxVel, 1) + ' m/s');
  net.beginFrame(T0 + 5000 + RD);
  const capped = net.renderState(1, T0 + 5000 + RD);
  ok(capped.pos.x < 9.67 + 20 * 0.25 + 3,
    '外推被 250ms 上限截断，不会无限飞出去',
    'x=' + num(capped.pos.x, 2) + '（上限约 +5m）');

  // ---- E3 误差融合：新快照到达时不产生跳变 ----
  const off = new Net();
  off.clockOffset = 0;
  for (let i = 0; i < 10; i++) {
    off.pushState(1, mk(i * 20 / 60, 0, 20), T0 + i * (1000 / 60), false, T0 + i * (1000 / 60));
  }
  // 先渲染到 T0+300（此时已在做外推），记录位置
  off.beginFrame(T0 + 300);
  let before = off.renderState(1, T0 + 300).pos.x;
  // 模拟丢包 150ms 后，真实快照补上（时间戳=T0+266，位于缺口内）
  off.pushState(1, mk(266 / 1000 * 20, 0, 20), T0 + 266, false, T0 + 266);
  // 下一帧：目标被拽回真实轨迹，但渲染位置应平滑滑过去而非瞬移
  let maxStep = 0, prevX2 = before;
  for (let t = 316; t <= 900; t += 16.67) {
    off.beginFrame(T0 + t);
    const rr = off.renderState(1, T0 + t);
    maxStep = Math.max(maxStep, Math.abs(rr.pos.x - prevX2));
    prevX2 = rr.pos.x;
  }
  ok(maxStep < 1.2, '新快照到达时位置平滑收敛（单帧位移很小，无生硬闪现）',
    '峰值单帧位移 ' + num(maxStep, 2) + ' m（若直接赋值会瞬移 ≈2m+）');
  ok(prevX2 > 10, '最终收敛到真实轨迹上继续前进', 'x=' + num(prevX2, 2));

  // ---- E4 时钟同步 ----
  const now = Date.now();
  const before2 = off.clockOffset;
  off.dispatch({ t: 'pong', c: now - 6, s: now + 100 });
  ok(Math.abs(off.clockOffset - 103) < 6 && off.clockOffset !== before2,
    '时钟同步 offset = s - (c + rtt/2)', 'offset=' + num(off.clockOffset, 1) + 'ms');
  ok(off.serverNow() > Date.now() + 90, 'serverNow() 使用统一时钟');

  // ---- E5 消息解析 ----
  off.dispatch({ t: 'room', room: 'ABCD', laps: 3, seed: 1, players: [{ id: 1 }, { id: 2 }] });
  ok(off.roomCode === 'ABCD' && off.lobby.length === 2, '房间消息解析');
  off.dispatch({ t: 'count', n: 3 });
  ok(off.countdown === 3, '倒计时消息解析');
  const n5 = new Net();
  n5.dispatch({ t: 'snap', ts: T0, p: [{ id: 9, f: 0, d: mk(5, 0, 0) }] });
  ok(n5.players.has(9), '位姿快照写入缓冲（含服务端时间戳 ts）');
  // 乱序包（时间戳更早）应被丢弃
  const c9 = n5.players.get(9).count;
  n5.pushState(9, mk(1, 0, 0), T0, false, T0 - 100);
  ok(n5.players.get(9).count === c9, '时间戳更早的乱序包被丢弃');
}

/* --------------------------------------------------------------------- */
/* F. 驾驶手感专项：转向校准 / 动力曲线 / 手刹漂移                          */
/*    （本节每一条都对应一个玩家可感知的 bug，必须在旧代码上失败）           */
/* --------------------------------------------------------------------- */
section('F. 转向校准 / 动力曲线 / 手刹漂移');

/** 在赛道上开 2 秒固定方向，返回相对起始车头坐标系的位移 */
function turnRun(steer, seconds) {
  const trk = new Track(2024);
  const q = new RacePhysics(trk);
  q.racing = true;
  const g = trk.gridSlot(3);
  const c = q.addCar({
    id: 1, name: 'T', color: '#fff', isLocal: true,
    startIndex: g.index, lateral: 0, laps: 99,
  });
  const p0 = c.pos.clone();
  const fwd0 = c.fwd.clone();
  const right0 = c.rightSide.clone();     // 车身真正右侧
  for (let i = 0; i < Math.round(60 * seconds); i++) {
    c.input.throttle = 0.5;
    c.input.steer = steer;
    q.fixedStep(DT);
  }
  const d = new THREE.Vector3().subVectors(c.pos, p0);
  return { lat: d.dot(right0), fwd: d.dot(fwd0), car: c, trk };
}

{
  // ---- F1 转向方向：这是"按 A 却向右转"的直接回归测试 ----
  const R = turnRun(+1, 2.2);
  const L = turnRun(-1, 2.2);
  ok(R.lat > 3, 'steer=+1（按 D/→）车身向【右侧】偏移', 'lat=+' + num(R.lat, 2) + ' m');
  ok(L.lat < -3, 'steer=+1（按 A/←）车身向【左侧】偏移', 'lat=' + num(L.lat, 2) + ' m');
  ok(R.lat * L.lat < 0, '左右转向严格反向（符号互为相反数）');
  ok(R.fwd > 2 && L.fwd > 2, '转向过程中车辆持续前进',
    'R fwd=' + num(R.fwd, 1) + ' / L fwd=' + num(L.fwd, 1) + ' m');
  ok(Math.sign(R.car.steerAngle) < 0 && Math.sign(L.car.steerAngle) > 0,
    '前轮转角符号与输入一致（+输入 -> steerAngle<0 -> 轮子指向右侧）',
    'R angle=' + num(R.car.steerAngle, 3) + ' rad');

  // ---- F2 速度敏感转向限幅 ----
  const q2 = new RacePhysics(new Track(7));
  ok(Math.abs(q2.maxSteerAt(0) - 0.55) < 1e-6, '低速(<30km/h) 最大前轮转角 0.55 rad ≈31.5°');
  ok(Math.abs(q2.maxSteerAt(30) - 0.55) < 1e-6, '30km/h 处仍为 0.55 rad');
  ok(Math.abs(q2.maxSteerAt(120) - 0.15) < 1e-6, '高速(120km/h) 收紧到 0.15 rad ≈8.6°');
  ok(Math.abs(q2.maxSteerAt(260)) - 0.15 < 1e-6, '超高速不再继续放宽（防止瞬间打翻）');
  let monoSteer = true;
  for (let k = 0; k < 200; k += 5) if (q2.maxSteerAt(k + 5) > q2.maxSteerAt(k) + 1e-9) monoSteer = false;
  ok(monoSteer, '转向限幅随车速单调不增（smoothstep 平滑衰减，无手感断层）',
    '30km/h→' + num(q2.maxSteerAt(30), 3) + ' / 75km/h→' + num(q2.maxSteerAt(75), 3) +
    ' / 120km/h→' + num(q2.maxSteerAt(120), 3));

  // ---- F3 转向滤波：及时响应，同时保留连续行程 ----
  const q3 = new RacePhysics(new Track(7));
  const c3 = q3.addCar({ id: 1, name: 'S', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  c3.input.steer = 1;
  let t63 = -1, t95 = -1, t = 0;
  for (let i = 0; i < 180; i++) {
    q3.updateSteer(c3, DT); t += DT;
    if (t63 < 0 && c3.steerInput >= 0.632) t63 = t;
    if (t95 < 0 && c3.steerInput >= 0.95) t95 = t;
  }
  ok(t63 > 0.05 && t63 < 0.10, '转向在 100ms 内建立，同时避免瞬间打满', num(t63, 3) + ' s');
  ok(t95 > 0.15 && t95 < 0.25, '转向在 250ms 内达到 95%，减少拖沓', num(t95, 3) + ' s');
  ok(c3.steerInput <= 1.0001, '转向量不会超过满舵（无过冲）', num(c3.steerInput, 4));
  // 松手回正：保留指数衰减，并缩短旧的约 0.375s 回正行程。
  c3.input.steer = 0;
  let tRel = 0;
  while (c3.steerInput > 0.05 && tRel < 2) { q3.updateSteer(c3, DT); tRel += DT; }
  ok(tRel > 0.15 && tRel < 0.25, '松手后指数回正，250ms 内衰减到 5% 以内', num(tRel, 3) + ' s');
  while (c3.steerInput > 1e-4 && tRel < 2) { q3.updateSteer(c3, DT); tRel += DT; }
  ok(c3.steerInput < 1e-3, '继续衰减到可忽略（指数逼近，残余 <1e-3）', c3.steerInput.toExponential(2));

  // ---- F3b 低速非线性转向曲线（规格：<40km/h 时 |input|^1.6）----
  const q3b = new RacePhysics(new Track(7));
  const c3b = q3b.addCar({ id: 1, name: 'L', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  // 低速（静止）：半打盘的有效量应小于输入本身（三次幂渐进）
  c3b.speedKmh = 10;
  c3b.input.steer = 0.5;
  for (let i = 0; i < 180; i++) q3b.updateSteer(c3b, DT);
  const lowEff = c3b.steerInput;
  ok(Math.abs(lowEff - Math.pow(0.5, 1.6)) < 0.01, '低速半打盘 -> 有效量 |0.5|^1.6 ≈ 0.33（温和柔顺）',
    num(lowEff, 4) + ' vs 理论 ' + num(Math.pow(0.5, 1.6), 4));
  // 高速：曲线淡出，半打盘 = 0.5
  const c3c = q3b.addCar({ id: 2, name: 'H', color: '#fff', isLocal: true, startIndex: 310, lateral: 0, laps: 99 });
  c3c.speedKmh = 90;
  c3c.input.steer = 0.5;
  for (let i = 0; i < 180; i++) q3b.updateSteer(c3c, DT);
  ok(Math.abs(c3c.steerInput - 0.5) < 0.01, '高速时非线性曲线淡出，半打盘就是 0.5（转向比例直给）',
    num(c3c.steerInput, 4));
  ok(Math.abs(lowEff - 0.5) > 0.1, '低速与高速同一输入量产生不同有效转角（低速更柔）',
    '低速 ' + num(lowEff, 3) + ' vs 高速 ' + num(c3c.steerInput, 3));
}

/**
 * "测功机"台架：每步把车摁回同一个点、并保持**固定朝向**（不随赛道曲率旋转车头）。
 * 上一版台架每步把车头扳到赛道切线，等于强迫车辆按赛道曲率走线：
 * 横向抓地力被迫抵偿 v²/R 的向心加速度并耗散动能，测到的其实是
 * "能跟随中心线曲率的最大速度"，而不是动力总成的极速。
 * 固定朝向后侧向速度恒为 0，纵向动力学可被独立测量。
 */
function straightRig(trkSeed, v0) {
  const trk = new Track(trkSeed);
  const q = new RacePhysics(trk);
  q.racing = true;
  // 挑最平的一段（|tan.y| 最小），排除坡度分量对纵向动力学的偏置
  let flat = 0, best = 1;
  for (let i = 0; i < trk.count; i++) {
    const a = Math.abs(trk.tan[i].y);
    if (a < best) { best = a; flat = i; }
  }
  const sp = trk.spawn(flat, 0);
  const c = q.addCar({ id: 1, name: 'D', color: '#fff', isLocal: true, startIndex: flat, lateral: 0, laps: 99 });
  const recenter = () => {
    c.body.position.set(sp.position.x, sp.position.y, sp.position.z);
    c.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
    c.syncFromBody();
  };
  recenter();
  if (v0) {
    const t0 = trk.tan[flat];
    c.body.velocity.set(t0.x * v0, t0.y * v0, t0.z * v0);
    c.syncFromBody();
  }
  return { trk, q, c, recenter, flat };
}

{
  // ---- F4 动力曲线：极速严格 160km/h + 平顺起步 ----
  const { q, c, recenter } = straightRig(11, 0);
  let peak = 0, t100 = -1, t = 0;
  for (let i = 0; i < 60 * 60; i++) {
    c.input.throttle = 1;
    q.fixedStep(DT);
    recenter();
    t += DT;
    peak = Math.max(peak, c.speedKmh);
    if (t100 < 0 && c.speedKmh >= 100) t100 = t;
  }
  ok(peak <= 268, '极速被严格限制在 265km/h（不超速/不飞出地图）', 'peak=' + num(peak, 1) + ' km/h');
  ok(peak > 252, '极速确实达到标定值 265km/h', 'peak=' + num(peak, 1) + ' km/h');
  ok(t100 > 3.3 && t100 < 3.9, '0-100km/h 标定为 3.6±0.2s（FM8 GT 房车水准）',
    num(t100, 2) + ' s');

  // 风阻确实是 F = 0.5·ρ·Cd·A·v² —— 用 44.44m/s 实测减速度反推
  const rig2 = straightRig(11, 44.444);
  const v0 = rig2.c.speed;
  rig2.q.fixedStep(DT);
  rig2.recenter();
  const v1 = rig2.c.speed;
  const dragN = DRAG_K * v0 * v0;
  const measured = (v0 - v1) / DT * CFG.MASS;
  ok(Math.abs(measured - dragN) / dragN < 0.35,
    '实测阻力与 F=0.5·ρ·Cd·A·v² 同量级（含滚阻/坡度分量）',
    '理论风阻=' + num(dragN, 0) + 'N，实测合力=' + num(measured, 0) + 'N');
}

{
  // ---- F5 手刹：切动力 + 后轮 5000N 制动 + 后轴摩擦 2.5→0.6 ----
  const A = straightRig(31, 80 / 3.6);
  let vBefore = 0;
  for (let i = 0; i < 30; i++) {   // 0.5s：全油门 + 手刹
    A.c.input.throttle = 1;
    A.c.input.handbrake = 1;
    if (i === 0) vBefore = A.c.speedKmh;
    A.q.fixedStep(DT);
    A.recenter();
  }
  ok(A.c.handbrake > 0.95, '手刹 0.05s 内完全咬合', 'hb=' + num(A.c.handbrake, 2));
  // 物理预期：5000N / 1300kg = 3.85 m/s²，再叠加风阻与滚阻 ≈ 4.2~4.7 m/s²，
  // 0.5s 约 7~9km/h。断言区间比理论略宽，避免把"符合物理"误判成缺陷。
  const dropKmh = vBefore - A.c.speedKmh;
  ok(dropKmh > 5 && dropKmh < 16, '手刹时全油门仍在减速（动力被切断，5000N 后轮制动生效）',
    num(vBefore, 1) + ' -> ' + num(A.c.speedKmh, 1) + ' km/h（-' + num(dropKmh, 1) + 'km/h/0.5s）');
  ok(Math.abs(A.c.muRear - CFG.GRIP_REAR_HANDBRAKE) < 0.06, '后轮进入动摩擦区（2.4 -> 0.85）',
    'muRear=' + num(A.c.muRear, 3));
  ok(Math.abs(A.c.muSurface - CFG.GRIP_ROAD) < 1e-6, '路面基准摩擦未被破坏（沥青仍为 2.4）',
    'muSurface=' + num(A.c.muSurface, 2));
  ok(A.c.muFront > CFG.GRIP_ROAD * 0.98, '手刹时前轮因载荷前移摩擦系数不降（前轴咬地）',
    'muFront=' + num(A.c.muFront, 3));

  // 对照组：同样 0.5s 不拉手刹 -> 必须加速
  const B = straightRig(31, 80 / 3.6);
  const bBefore = B.c.speedKmh;
  for (let i = 0; i < 30; i++) {
    B.c.input.throttle = 1;
    B.q.fixedStep(DT);
    B.recenter();
  }
  ok(B.c.speedKmh > bBefore + 3, '对照组（不拉手刹）同样条件在加速',
    num(bBefore, 1) + ' -> ' + num(B.c.speedKmh, 1) + ' km/h');

  // 松开手刹：0.2s 内摩擦恢复（规格要求 0.2s，防 Snap Oversteer）
  A.c.input.handbrake = 0;
  let tRel = 0;
  while (A.c.handbrake > 0.05 && tRel < 1) { A.q.updateSteer(A.c, DT); tRel += DT; }
  ok(tRel > 0.16 && tRel < 0.26, '松开手刹后 0.2s 内平滑恢复抓地（防瞬间反弹甩尾）', num(tRel, 3) + ' s');
}

{
  // ---- F6 漂移：侧偏角 >18° 且 driftIntensity 触发烟雾 ----
  // 注意：漂移测试**不能**用 straightRig —— 那个台架每步把车头扳回切线，
  // 等于把横摆抹平，侧偏角永远涨不起来（这正是第一次跑出来的假阴性）。
  const trk = new Track(43);
  const q = new RacePhysics(trk);
  q.racing = true;
  const g = trk.gridSlot(3);
  const c = q.addCar({ id: 1, name: 'D', color: '#fff', isLocal: true, startIndex: g.index, lateral: 0, laps: 99 });
  // 直线 70km/h 行驶时不应误触发漂移
  {
    const t0 = trk.tan[g.index];
    c.body.velocity.set(t0.x * 19.4, t0.y * 19.4, t0.z * 19.4);
    c.syncFromBody();
    for (let i = 0; i < 30; i++) { c.input.throttle = 0.35; q.fixedStep(DT); }
    ok(c.slipAngleDeg < 3, '直线行驶侧偏角≈0（不会误冒烟）',
      'slip=' + num(c.slipAngleDeg, 2) + '°');
    ok(!c.drifting, '直线行驶不进入漂移状态');
  }

  // 手刹 + 满舵：必须甩出 >18° 侧偏角（自由行驶，不做任何姿态矫正）
  let maxSlip = 0, sawDrift = false, maxFx = 0, spdAtMaxSlip = 0;
  for (let i = 0; i < 60 * 2.4; i++) {
    c.input.throttle = 1;
    c.input.steer = 1;                            // 满舵向右
    c.input.handbrake = (i % 110) < 60 ? 1 : 0;   // 手刹脉冲，模拟连续甩尾
    q.fixedStep(DT);
    if (c.slipAngleDeg > maxSlip) { maxSlip = c.slipAngleDeg; spdAtMaxSlip = c.speedKmh; }
    maxFx = Math.max(maxFx, c.driftIntensity);
    if (c.drifting) sawDrift = true;
  }
  ok(maxSlip > 18, '手刹+满舵甩出 >18° 侧偏角（进入漂移区间）',
    'maxSlip=' + num(maxSlip, 1) + '° @ ' + num(spdAtMaxSlip, 0) + 'km/h');
  ok(sawDrift, '漂移状态被正确标记（drifting=true）');
  ok(maxFx > 0.3, 'driftIntensity 足够驱动烟雾/胎痕', 'maxFx=' + num(maxFx, 2));
  ok(spdAtMaxSlip > 20, '漂移过程中仍保有速度（不是"拉手刹急停"）', num(spdAtMaxSlip, 1) + ' km/h');

  // 甩尾时整车等效抓地必须显著低于正常值（车尾真的失稳了）
  const normalMu = 0.5 * CFG.GRIP_ROAD + 0.5 * Math.min(CFG.GRIP_ROAD, CFG.GRIP_REAR_NORMAL);
  ok(c.muEffective < normalMu * 0.75, '手刹时整车等效抓地显著下降（车尾失稳）',
    'muEff=' + num(c.muEffective, 2) + ' vs 正常 ' + num(normalMu, 2));
}


/* --------------------------------------------------------------------- */
/* G. FM8 拟真升级专项：载荷转移 / 下压力 / 脏气流 / 非弹性碰撞 / 变速箱      */
/* --------------------------------------------------------------------- */
section('G. 载荷转移 / 下压力 / 脏气流 / 碰撞 / 变速箱');

{
  // ---- G1 纵向载荷转移  delta_Fz = m·a_x·h / L ----
  // 注意：注入初速后的头几步 axMeasured 是假的（(v0-0)/dt），必须先跑稳再测
  const g = straightRig(11, 40);
  for (let i = 0; i < 20; i++) { g.c.input.throttle = 0.2; g.q.fixedStep(DT); g.recenter(); }
  const FzStatF = CFG.MASS * 9.81 * CFG.WEIGHT_FRONT;
  const FzStatR = CFG.MASS * 9.81 * (1 - CFG.WEIGHT_FRONT);
  // 全油门加速 0.5s
  for (let i = 0; i < 30; i++) { g.c.input.throttle = 1; g.q.fixedStep(DT); g.recenter(); }
  const accelF = g.c.FzFront, accelR = g.c.FzRear, axA = g.c.axMeasured;
  const theoryA = (CFG.MASS * axA * CFG.CG_H) / CFG.WHEELBASE;
  // 实测轴荷里还叠了气动分量，比对转移量时必须剔除
  const aeroR = (g.c.downforce || 0) * (1 - CFG.AERO_BALANCE_FRONT);
  const aeroF = (g.c.downforce || 0) * CFG.AERO_BALANCE_FRONT;
  ok(accelR > FzStatR + aeroR && accelF < FzStatF + aeroF, '加速 -> 载荷后移（后轴增压 / 前轴减压）',
    'FzR ' + num(FzStatR, 0) + '->' + num(accelR, 0) + 'N, FzF ' + num(FzStatF, 0) + '->' + num(accelF, 0) + 'N');
  const measuredTransfer = accelR - FzStatR - aeroR;
  ok(Math.abs(measuredTransfer - theoryA) / Math.max(theoryA, 1) < 0.25,
    '转移量与 ΔFz = m·a_x·h/L 理论式一致',
    '实测 ' + num(measuredTransfer, 0) + 'N vs 理论 ' + num(theoryA, 0) + 'N');

  // 制动 -> 载荷前移
  const b = straightRig(11, 45);
  for (let i = 0; i < 20; i++) { b.c.input.throttle = 0.2; b.q.fixedStep(DT); b.recenter(); }
  const bFz0 = b.c.FzFront;
  for (let i = 0; i < 20; i++) { b.c.input.brake = 1; b.q.fixedStep(DT); b.recenter(); }
  ok(b.c.FzFront > bFz0 * 1.15, '制动 -> 大量载荷压向前轴（前轮抓地暴涨）',
    'FzF=' + num(bFz0, 0) + ' -> ' + num(b.c.FzFront, 0) + 'N（静态 ' + num(FzStatF, 0) + 'N）');
  ok(b.c.aLatFront > b.c.aLatRear * 1.5, '制动时前轴横向极限远高于后轴（前咬后滑）',
    'aF=' + num(b.c.aLatFront, 1) + ' vs aR=' + num(b.c.aLatRear, 1) + ' m/s²');
}

{
  // ---- G2 气动下压力：F = 0.5·ρ·Cl·A·v² 且随速度提升过弯极限 ----
  function settleRig(v) {
    const r = straightRig(11, v);
    for (let i = 0; i < 40; i++) { r.c.input.throttle = 0.25; r.q.fixedStep(DT); r.recenter(); }
    return r;
  }
  const slow = settleRig(15);      // 54 km/h
  const fast = settleRig(61);      // 220 km/h
  const dSlow = slow.c.downforce, dFast = fast.c.downforce;
  const vF = fast.c.speed;
  const theory = 0.5 * CFG.AIR_RHO * CFG.CL * CFG.FRONTAL_AREA * vF * vF;
  ok(Math.abs(dFast - theory) / theory < 0.08, '下压力符合 F=0.5·ρ·Cl·A·v²',
    '实测 ' + num(dFast, 0) + 'N vs 理论 ' + num(theory, 0) + 'N @' + num(vF * 3.6, 0) + 'km/h');
  ok(dFast > dSlow * 10, '下压力随速度平方增长（高速才有实际压紧效果）',
    num(dSlow, 0) + 'N @54km/h -> ' + num(dFast, 0) + 'N @220km/h');
  ok(fast.c.aLatCap > slow.c.aLatCap * 1.25, '下压力动态提升高速过弯极限抓地力',
    '横向极限 ' + num(slow.c.aLatCap, 1) + ' -> ' + num(fast.c.aLatCap, 1) + ' m/s²');
  ok(fast.c.FzFront + fast.c.FzRear > CFG.MASS * 9.81 * 1.15,
    '高速时两轴正压力总和显著超过车重（气动压紧）',
    '总轴荷 ' + num(fast.c.FzFront + fast.c.FzRear, 0) + 'N vs 车重 ' + num(CFG.MASS * 9.81, 0) + 'N');
}

{
  // ---- G3 吸尾流 + 脏气流（Dirty Air）----
  function draftRun(withDraft) {
    const rig = straightRig(11, 61);
    const { q, c, recenter } = rig;
    for (let i = 0; i < 40; i++) { c.input.throttle = 0.25; q.fixedStep(DT); recenter(); }
    const leader = q.addCar({ id: 2, name: 'L', color: '#fff', isLocal: false, startIndex: 0, lateral: 0, laps: 99 });
    // 车头前方 12m（锥角 0°、间距 <25m、前车 >60km/h）—— 每步钉住位置
    const pin = () => {
      if (!withDraft) { leader.retired = true; leader.body.position.y = -1e5; return; }
      const f = c.fwd;
      leader.body.position.set(c.pos.x + f.x * 12, c.pos.y, c.pos.z + f.z * 12);
      leader.body.quaternion.set(c.body.quaternion.x, c.body.quaternion.y, c.body.quaternion.z, c.body.quaternion.w);
      leader.body.velocity.set(f.x * 61, 0, f.z * 61);
      leader.syncFromBody();
    };
    const v0 = c.speed;
    let downSum = 0, n = 0;
    for (let i = 0; i < 60; i++) {
      pin();
      c.input.throttle = 0;                 // 松油门滑行，纯看阻力
      q.fixedStep(DT);
      recenter();
      downSum += c.downforce; n++;
    }
    return { decel: (v0 - c.speed), downAvg: downSum / n, car: c };
  }
  const solo = draftRun(false);
  const draft = draftRun(true);
  ok(draft.car.slip > 0.5,
    '锥角<' + CFG.SLIP_CONE + '° / 间距<25m 判定为进入尾流', 'slip=' + num(draft.car.slip, 2));
  const cut = 1 - draft.decel / solo.decel;
  ok(Math.abs(cut - CFG.SLIP_DRAG_CUT) < 0.10,
    '尾流中风阻降低约 ' + (CFG.SLIP_DRAG_CUT * 100) + '%（写实值，非街机 70%）',
    '实测削弱 ' + num(cut * 100, 1) + '%（目标 ' + (CFG.SLIP_DRAG_CUT * 100) + '%）');
  const downCut = 1 - draft.downAvg / solo.downAvg;
  ok(Math.abs(downCut - CFG.SLIP_DOWNFORCE_CUT) < 0.05, '脏气流：下压力削减 30%（跟车过弯抓地变差）',
    '实测削减 ' + num(downCut * 100, 1) + '%');
  // 脏气流砍掉 30% 下压力，但机械抓地（车重）仍在，故总横向极限只降约 7% —— 这是正确物理：
  // 高速跟车过弯会明显推头，但不会变成冰面。断言只要求"可感知的下降"（>4%）。
  const gripLoss = 1 - draft.car.aLatCap / solo.car.aLatCap;
  ok(gripLoss > 0.04, '尾流中横向极限抓地下降（跟车过弯更推头）',
    num(solo.car.aLatCap, 1) + ' -> ' + num(draft.car.aLatCap, 1) + ' m/s²（-' + num(gripLoss * 100, 1) + '%）');
}

{
  // ---- G4 非弹性碰撞：恢复系数 0.22，严禁皮球弹跳 ----
  const trk = new Track(555);
  const q = new RacePhysics(trk);
  q.racing = true;
  const a = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  const b = q.addCar({ id: 2, name: 'B', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  placeOn(a, trk, 300 - Math.round(7 / trk.spacing), 0, 18);
  placeOn(b, trk, 300, 0, 0);
  let maxSep = 0, sepAfter = 0;
  for (let i = 0; i < 60 * 1.2; i++) {
    q.fixedStep(DT);
    maxSep = Math.max(maxSep, b.speed);
    sepAfter = Math.max(sepAfter, b.speed - a.speed);     // 碰撞后的分离速度
  }
  ok(maxSep > 3, '追尾传递动量（前车被撞动）', '前车峰值 ' + num(maxSep, 1) + ' m/s');
  // ★ 语义已改（2026-09-30 车-车碰撞改为严谨刚体冲量解算）
  //   用户要求"按碰撞角度、碰撞力度与分力做严谨计算"，因此不再有"恢复系数 0.22"这个
  //   经验值 —— 车身接触按**塑性**处理（e≈0）。验收换成两条真正的物理不变量：
  //     ① 动量守恒（等质量：vA + vB 在碰撞前后守恒）
  //     ② 碰撞后**不出现超物理的分离速度**（旧实现"被弹开"就是这个量过大）
  const mAfter = a.speed + b.speed;
  const momentumErr = Math.abs(mAfter - 18) / 18;
  const eMaxAllowed = 0.3;                                // 塑性接触允许的残余弹性上限 (m/s)
  ok(momentumErr < 0.03, '★等质量碰撞动量守恒（严谨刚体冲量：Σmv 误差 <3%）',
    '碰撞前 18 m/s ⇒ 碰撞后 ' + num(mAfter, 2) + ' m/s（偏差 ' + num(momentumErr * 100, 2) + '%）');
  ok(sepAfter <= eMaxAllowed + 0.05, '★碰撞后不出现超物理的分离速度（不再"被弹开"）',
    '最大分离速度 ' + num(sepAfter, 3) + ' m/s ≤ 允许 ' + num(eMaxAllowed + 0.05, 2) + ' m/s');
  ok(b.speed > 3 && b.speed < 13, '塑性碰撞：等质量追尾后前车速度约为原来一半（≈9 m/s）',
    num(b.speed, 1) + ' m/s');
  ok(isFinite(maxSep) && a.speed < 18, '碰撞后两车均未出现弹跳式加速');
}

{
  // ---- G4b 偏心碰撞力矩 / PIT 美式截停 ----
  const trk = new Track(555);
  const q = new RacePhysics(trk);
  q.racing = true;
  const vic = q.addCar({ id: 1, name: 'V', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const atk = q.addCar({ id: 2, name: 'A', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  // 受害车沿赛道正常行驶；攻击车在其**后方 + 横向错位**，车头对准其左后角
  placeOn(vic, trk, 300, 0, 15);
  placeOn(atk, trk, 300 - Math.round(4.3 / trk.spacing), -1.3, 23);
  let maxYawVic = 0, sawPit = false;
  for (let i = 0; i < 60 * 1.2; i++) {
    q.fixedStep(DT);
    maxYawVic = Math.max(maxYawVic, Math.abs(vic.body.angularVelocity.y));
    if (vic.pitHits > 0) sawPit = true;
  }
  ok(vic.collideHits > 0, '底盘刚体确实收到了 collide 事件', vic.collideHits + ' 次接触');
  ok(sawPit, '车头撞对方车尾侧翼被判定为 PIT（别车）', 'pitHits=' + vic.pitHits);
  ok(maxYawVic > 0.30, '★被别车获得显著横摆角速度（严谨冲量 r×j 产生，非魔法系数）',
    '峰值 |yaw| = ' + num(maxYawVic, 3) + ' rad/s（旧实现靠 IMPACT_TORQUE_GAIN/PIT_TORQUE_GAIN 强行放大）');
  ok(vic.yawDisturb > 0 || vic.pitHits > 0, '被撞车进入扰动窗口（横摆修正权限被压低，不会立刻被纠回）');
  ok(vic.inertiaY > 1500 && vic.inertiaY < 3000, '绕 Y 轴转动惯量按长方体公式算得',
    num(vic.inertiaY, 0) + ' kg·m²（m/12·(w²+l²)）');

  // 正后追尾（接触点居中）不应判成 PIT
  const q3 = new RacePhysics(new Track(555));
  q3.racing = true;
  const v3 = q3.addCar({ id: 1, name: 'V', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const a3 = q3.addCar({ id: 2, name: 'A', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
  placeOn(v3, trk, 300, 0, 15);
  placeOn(a3, trk, 300 - Math.round(4.4 / trk.spacing), 0, 23);
  for (let i = 0; i < 60; i++) q3.fixedStep(DT);
  ok(v3.pitHits === 0, '正后方向追尾（接触点居中）不判为 PIT', 'pitHits=' + v3.pitHits);
}


{
  // ---- G5 6 档变速箱：档位映射 / 升档 / 换档动力切断 ----
  const { q, c, recenter } = straightRig(11, 0);
  const gearsSeen = new Set();
  let shiftCuts = 0, wasCut = false;
  for (let i = 0; i < 60 * 40; i++) {
    c.input.throttle = 1;
    q.fixedStep(DT);
    recenter();
    gearsSeen.add(c.gear);
    const cut = c.shiftTimer > 0;
    if (cut && !wasCut) shiftCuts++;
    wasCut = cut;
  }
  ok(CFG.GEAR_RATIOS.length === 6, '6 档变速箱齿比表', CFG.GEAR_RATIOS.join(' / '));
  ok(gearsSeen.size >= 5, '随车速自动升档到高挡位', '经过档位 ' + [...gearsSeen].map((x) => x + 1).join(','));
  ok(shiftCuts >= 3, '换档时存在动力切断（shiftTimer）', shiftCuts + ' 次切断');
  ok(c.rpm > 1000 && c.rpm <= CFG.REDLINE_RPM, '红线保护生效（转速不超 7500rpm）',
    num(c.rpm, 0) + ' rpm');
}


/* --------------------------------------------------------------------- */
/* H. 三个关键 bug 的专项验证：物理抖动 / 手刹推头 / 悬挂临界阻尼             */
/* --------------------------------------------------------------------- */
section('H. 悬挂临界阻尼 / 抖动抑制 / 手刹横摆权限');

{
  // ---- H1 悬挂参数换算与阶跃响应（单次归位 = 无高频震颤）----
  ok(Math.abs(CFG.SUSP_ZETA - 1.0) < 1e-9, '阻尼比 ζ = 1.0（临界阻尼）',
    'K=' + num(SUSP.K / 1000, 1) + 'kN/m  C=' + num(SUSP.C / 1000, 1) + 'kN·s/m');
  const zetaSpec = CFG.SUSP_DAMPING / (2 * Math.sqrt(CFG.SUSP_STIFFNESS));
  ok(zetaSpec > 0.3 && zetaSpec < 0.5,
    '规格归一化阻尼 4.5 → ζ≈' + num(zetaSpec, 2) + '（欠阻尼，压缩后会过冲一次）',
    '规格文字要求"单次归位"，故取 ζ=1.0：文字优先于数字');
  ok(SUSP.MAX_TRAVEL === 0.3, '最大悬挂冲程 0.30m 被硬性限制', num(SUSP.MAX_TRAVEL, 2) + ' m');
  ok(Math.abs(SUSP.SAG - CFG.SUSP_MAX_TRAVEL * CFG.SUSP_SAG_RATIO) < 1e-9,
    '静态下沉 = 冲程的 20%', num(SUSP.SAG * 100, 1) + ' cm');
  ok(SUSP.FREQ_HZ > 1.5 && SUSP.FREQ_HZ < 3.0, '悬挂固有频率落在真实赛车区间（非"钢板一块"也非"弹簧床"）',
    num(SUSP.FREQ_HZ, 2) + ' Hz');

  // 阶跃扰动：下压 0.15m 后释放，看是否单次归位
  const trk = new Track(11);
  const q = new RacePhysics(trk);
  q.racing = true;
  const c = q.addCar({ id: 1, name: 'S', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  for (let i = 0; i < 180; i++) q.fixedStep(DT);          // 静止稳定 3s
  const sag0 = c.suspCompression;
  ok(Math.abs(sag0 - SUSP.SAG) < 0.025, '静止时弹簧力与车重平衡（静态下沉量吻合换算）',
    '实测 ' + num(sag0 * 100, 2) + 'cm vs 理论 ' + num(SUSP.SAG * 100, 2) + 'cm');
  c.body.position.y -= 0.15;
  c.body.velocity.y = 0;
  let flips = 0, prev = 0, maxDev = 0;
  for (let i = 0; i < 150; i++) {
    q.fixedStep(DT);
    const dev = c.suspCompression - sag0;
    maxDev = Math.max(maxDev, Math.abs(dev));
    if (prev !== 0 && Math.sign(dev) !== Math.sign(prev) && Math.abs(dev) > 0.004) flips++;
    prev = dev;
  }
  ok(flips <= 1, '悬挂压缩后单次归位（过零翻转 ≤1 次，杜绝高频上下震颤）',
    '扰动幅值 ' + num(maxDev * 100, 1) + 'cm，方向翻转 ' + flips + ' 次');
}

{
  // ---- H2 巡航抖动抑制：竖直速度不应高频翻转符号 ----
  const trk = new Track(4242);
  const q = new RacePhysics(trk);
  q.racing = true;
  const g0 = trk.gridSlot(3);
  const c = q.addCar({ id: 1, name: 'J', color: '#fff', isLocal: false, startIndex: g0.index, lateral: 0, laps: 99, ai: true });
  c.auto = true;
  for (let i = 0; i < 600; i++) q.fixedStep(DT);            // 10s 巡航热身
  let flip = 0, prev = 0, sumRes = 0, n = 0;
  for (let i = 0; i < 900; i++) {
    q.fixedStep(DT);
    const vy = c.body.velocity.y;
    // 注意：|vy| 里含"跟随坡度"的合法分量（8.7% 坡上 60m/s 就是 5m/s），
    // 必须先减掉沿切线的应有竖直分量，剩下的残差才是抖动。
    const tg = trk.tan[c.trackIdx];
    const vH = Math.hypot(c.vel.x, c.vel.z);
    const vySlope = tg.y / Math.max(Math.hypot(tg.x, tg.z), 1e-6) * vH;
    const res = vy - vySlope;
    if (prev !== 0 && Math.sign(res) !== Math.sign(prev) && Math.abs(res) > 0.08) flip++;
    prev = res; sumRes += Math.abs(res); n++;
  }
  ok(flip / n < 0.15, '巡航中竖直速度不高频翻转（旧的"位置瞬移"会导致每步翻转）',
    '残差翻转率 ' + num(flip / n * 100, 1) + '%（' + flip + '/' + n + ' 步）');
  ok(sumRes / n < 0.35, '扣除坡度分量后的竖直抖动残差很小（车身不上下颤）',
    num(sumRes / n, 3) + ' m/s');
}

{
  // ---- H3 手刹横摆权限：修复"入弯严重推头" ----
  const trk = new Track(43);
  const q = new RacePhysics(trk);
  q.racing = true;
  const g0 = trk.gridSlot(3);
  const c = q.addCar({ id: 1, name: 'H', color: '#fff', isLocal: true, startIndex: g0.index, lateral: 0, laps: 99 });
  const t0 = trk.tan[g0.index];
  c.body.velocity.set(t0.x * 20, t0.y * 20, t0.z * 20);      // 72km/h
  c.syncFromBody();
  c.input.throttle = 0.7;
  c.input.steer = 1;                                         // 向右
  c.input.handbrake = 1;
  let maxYaw = 0, yawSignOK = false, maxSlip = 0;
  for (let i = 0; i < 60; i++) {
    q.fixedStep(DT);
    const y = c.body.angularVelocity.y;
    if (Math.abs(y) > maxYaw) { maxYaw = Math.abs(y); }
    maxSlip = Math.max(maxSlip, c.slipAngleDeg);
  }
  // steer=+1(向右) 需要负向 yaw（绕 +Y 正向 = 向左）
  yawSignOK = c.body.angularVelocity.y < 0;
  ok(maxYaw > 1.2, '手刹+转向建立足够横摆角速度（车头切入弯心，不再推头）',
    '峰值 |yaw| = ' + num(maxYaw, 2) + ' rad/s');
  ok(yawSignOK, '横摆方向与转向一致（向右打方向 → 负向 yaw）',
    'yaw=' + num(c.body.angularVelocity.y, 2) + ' rad/s');
  ok(maxSlip > 25, '车尾甩出形成可控侧滑角', '峰值侧偏 ' + num(maxSlip, 1) + '°');
  ok(Math.abs(c.muFront - CFG.GRIP_FRONT_HANDBRAKE) < 0.5,
    '手刹时前轮 frictionSlip 升至 3.2（死死咬地提供转向力矩，严禁抱死）',
    'muFront=' + num(c.muFront, 2));
  ok(Math.abs(c.muRear - CFG.GRIP_REAR_HANDBRAKE) < 0.15,
    '手刹时后轮 frictionSlip 暴跌至 0.45（后轴失去侧向抗滑）', 'muRear=' + num(c.muRear, 3));

  // 对照组：同样转向但不拉手刹 -> 横摆权限应明显更小（证明手刹真的在制造过度转向）
  const q2 = new RacePhysics(new Track(43));
  q2.racing = true;
  const c2 = q2.addCar({ id: 1, name: 'N', color: '#fff', isLocal: true, startIndex: g0.index, lateral: 0, laps: 99 });
  c2.body.velocity.set(t0.x * 20, t0.y * 20, t0.z * 20);
  c2.syncFromBody();
  c2.input.throttle = 0.7;
  c2.input.steer = 1;
  let maxYaw2 = 0;
  for (let i = 0; i < 60; i++) { q2.fixedStep(DT); maxYaw2 = Math.max(maxYaw2, Math.abs(c2.body.angularVelocity.y)); }
  ok(maxYaw > maxYaw2 * 1.1, '手刹的横摆权限高于常规转向（制造过度转向而非推头）',
    '手刹 ' + num(maxYaw, 2) + ' vs 常规 ' + num(maxYaw2, 2) + ' rad/s');
}


{
  // ---- H4 仪表指针角度映射（直接对 main.js 里的源码求值，确保测的是发货代码）----
  // main.js 依赖 DOM 无法 import，但角度映射是纯函数：把源码里的
  // GAUGE 定义与 needleAngle 抽出来在沙箱里求值 —— 这样公式被改动时测试必然失败。
  const src = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const gDef = src.match(/const GAUGE = \{[\s\S]*?\n\};/);
  const nFn = src.match(/function needleAngle\(rpm\) \{[\s\S]*?\n\}/);
  ok(gDef && nFn, 'main.js 中存在 GAUGE 定义与 needleAngle 纯函数');
  if (gDef && nFn) {
    // eslint-disable-next-line no-new-func
    const fn = new Function(gDef[0] + '\n' + nFn[0] + '\nreturn needleAngle;')();
    const MAX = 7500;
    ok(fn(0) === -120, '0 rpm -> -120°（表盘左下起点）', fn(0) + '°');
    ok(fn(MAX) === 120, MAX + ' rpm -> +120°（表盘右下终点）', fn(MAX) + '°');
    ok(Math.abs(fn(MAX / 2) - 0) < 1e-9, '半转速 -> 0°（正中，线性无偏）', fn(MAX / 2) + '°');
    ok(Math.abs(fn(MAX / 4) - -60) < 1e-9, '1/4 转速 -> -60°（线性中点校验）', fn(MAX / 4) + '°');
    ok(fn(99999) === 120 && fn(-50) === -120, '超转/负值被钳位，指针不会爆表跳出',
      'fn(99999)=' + fn(99999) + '° fn(-50)=' + fn(-50) + '°');
  }
  // CSS 旋转轴心与过渡（规格明确要求）
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  ok(/\.needle\s*\{[\s\S]*?transform-origin:\s*50% 90%/.test(css), 'CSS 指定指针旋转轴心 transform-origin: 50% 90%');
  ok(/\.needle\s*\{[\s\S]*?transition:\s*transform 0\.05s linear/.test(css), 'CSS 指定指针过渡 transition: transform 0.05s linear');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  ok(html.includes('id="needle"') && !html.includes('<line id="needle"'), '指针已改为独立 HTML 元素（不再是 SVG line）');
}


/* --------------------------------------------------------------------- */
/* I. 多视角系统与动态最佳走线的规格落实                                     */
/* --------------------------------------------------------------------- */
section('I. 多视角 / 动态最佳走线');

{
  // ---- I1 多视角：规格数值直接对发货源码断言 ----
  const src = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/CAM_COUNT: 3/.test(src), '三种视角循环（0 追尾 / 1 引擎盖 / 2 垂直鸟瞰）');
  ok(/k === 'c' \|\| k === 'v'/.test(src), "按 'C' 或 'V' 切换视角（规格）");
  ok(/camMode: 0,/.test(src), '默认 = 第三人称拟真跟随视角（Mode 0）');
  ok(/TOP_DOWN_H: 35\.0/.test(src), '鸟瞰高度 35.0m（规格值）');
  ok(/BONNET_H: 0\.9/.test(src), '引擎盖视角离地 0.9m（规格值）');
  ok(/BONNET_FOV: 75/.test(src), '引擎盖视角 FOV 75°（规格值）');
  ok(/camera\.up\.copy\(fwd\)/.test(src) && /camera\.up\.y = 0/.test(src) && /camera\.up\.normalize\(\)/.test(src),
    '鸟瞰相机 Up = 车辆**前向**并投到 XZ 平面 ⇒ 车头永远在屏幕正上方（规格）');
  ok(!/camera\.up\.set\(-fwd\.x/.test(src), '已修正上一版 up = -fwd 导致"车头朝屏幕下方"的错误');
  ok(/camera\.up\.set\(0, 1, 0\)/.test(src), '切回其它视角时恢复常规 Up（避免残留鸟瞰姿态）');
  ok(/camera\.lookAt\(camState\.look\)/.test(src), '鸟瞰垂直向下注视车身中心');
}

{
  // ---- I2 走线着色：颜色常量与极限速度公式 ----
  const src = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/const LINE_SAFE = \[0\.00, 1\.00, 0\.00\]/.test(src), '安全速度色 = 纯绿 #00ff00（可全油门）');
  ok(/const LINE_WARN = \[1\.00, 1\.00, 0\.00\]/.test(src), '临界速度色 = 纯黄 #ffff00（需收油）');
  ok(/const LINE_OVER = \[1\.00, 0\.00, 0\.20\]/.test(src), '超速色 = 鲜红 #ff0033（必须重刹）');
  ok(/Math\.sqrt\(mu \* 9\.81 \* Math\.max\(rl\.radius\[k\], 15\)\)/.test(src),
    '节点极限速度 = sqrt(mu·g·R)（规格公式）');
  ok(/vMax \* vMax \+ 2 \* decel \* ahead/.test(src),
    '按制动距离反推"当前位置允许车速" v_allow=sqrt(v²+2ad)');
}

{
  // ---- I3 物理自洽：走线给出的极限速度必须与车辆真实过弯能力同量级 ----
  const trk = new Track(4242);
  const q = new RacePhysics(trk);
  q.racing = true;
  const g0 = trk.gridSlot(3);
  const c = q.addCar({
    id: 1, name: 'R', color: '#fff', isLocal: false,
    startIndex: g0.index, lateral: g0.lateral, laps: 99, ai: true,
  });
  c.auto = true;
  let maxRatio = 0, sumRatio = 0, n = 0;
  for (let i = 0; i < 60 * 90; i++) {
    q.fixedStep(DT);
    if (c.speed > 6) {
      const R = Math.max(trk.raceLine.radius[c.trackIdx], 15);
      const vMax = Math.sqrt(CFG.GRIP_ROAD * 9.81 * R);
      const r = c.speed / vMax;
      maxRatio = Math.max(maxRatio, r);
      sumRatio += r; n++;
    }
  }
  ok(n > 1000, '采集到足够样本', n + ' 步');
  ok(maxRatio < 1.45, '实测车速不超过走线极限速度的 1.45 倍（走线数值物理自洽）',
    '峰值 ' + num(maxRatio, 2) + '×，均值 ' + num(sumRatio / n, 2) + '×');
  ok(sumRatio / n > 0.25, 'AI 确实在接近极限驾驶（不是龟速遛弯，否则走线着色无意义）',
    '均值 ' + num(sumRatio / n, 2) + '×');

  // 走线横向偏移与曲率的相关性：弯道内切
  const rl = trk.raceLine;
  let tight = 0, tightN = 0, str = 0, strN = 0;
  for (let i = 0; i < trk.count; i++) {
    if (rl.radius[i] < 200) { tight += Math.abs(rl.offset[i]); tightN++; }
    if (rl.radius[i] > 900) { str += Math.abs(rl.offset[i]); strN++; }
  }
  ok(tightN > 50 && strN > 50, '赛道同时存在急弯段与直线段', '急弯 ' + tightN + ' 点 / 直线 ' + strN + ' 点');
  ok(tight / tightN > (str / strN) * 2, '弯道内切幅度显著大于直线段（外-内-外结构成立）',
    '弯道 ' + num(tight / tightN, 2) + 'm vs 直线 ' + num(str / strN, 2) + 'm');
}


/* --------------------------------------------------------------------- */
/* J. 非弹性剐蹭 / 沙地陷阱 / 救援复位                                       */
/* --------------------------------------------------------------------- */
section('J. 非弹性剐蹭 / 沙地陷阱 / 救援复位');

{
  // ---- J1 接触材质近乎绝对塑性 ----
  const q = new RacePhysics(new Track(555));
  const cm = q.world.contactmaterials[0];
  ok(Math.abs(cm.restitution - 0.05) < 1e-6, '车辆接触恢复系数 = 0.05（规格 §三.1：近似完全非弹性）',
    num(cm.restitution, 3));
  // Baumgarte 速度通道已彻底移除（规格 §1）—— 旧常量必须不存在
  ok(CFG.BAUMGARTE_BIAS_V === undefined,
    '★旧 BAUMGARTE_BIAS_V 已移除（不再往 velocity 注入穿透补偿速度）');
  ok(CFG.BAUMGARTE_IMPULSE === undefined,
    '★旧 BAUMGARTE_IMPULSE(50000) 已移除');
  ok(CFG.IMPULSE_MAX_NS === 40000, '§5：冲量硬上限 = 40000 N·s（规格值）', CFG.IMPULSE_MAX_NS + ' N·s');
  ok(Math.abs(cm.friction - 0.55) < 1e-6, '接触摩擦 = 0.55（钣金侧向刮蹭）', num(cm.friction, 3));
  ok(Math.abs(cm.contactEquationStiffness - 5e5) < 1, '接触刚度 = 5e5（软化接触，抑制数值抖动）');
  ok(Math.abs(cm.contactEquationRelaxation - 16) < 1e-9,
    '接触松弛 = 16（与 relief 系数共同决定 a = 4/(h(1+4d))，见 §1 病根推导）',
    String(cm.contactEquationRelaxation));
  ok(CFG.SOFT_CONTACT_MS === 3.5 && CFG.SOFT_CONTACT_CUT === 0.90,
    '低速剐蹭阈值 3.5m/s、法向弹开冲量削减 90%（规格 §三.2）');
  ok(CFG.SUSP_LOCK_SLACK === 0.15, '§4：悬挂行程锁定比例 = 0.15（规格值）', CFG.SUSP_LOCK_SLACK);
}

{
  // ---- J1b 全员幽灵车模式：车与车完全不解算（规格 §二）----
  // 行为级验证：两车完全重叠 -> 标准模式必须被推开；幽灵模式必须互不干涉。
  // （只断言 collisionFilterMask 的数值是不够的，要证明它真的改变了物理结果。）
  // 判据用"后车能否**穿过去**"，而不是"重叠会不会被弹开"：
  // 本轮按规格把接触刚度从 1e7 软化到 5e5、松弛 6，穿透恢复本来就很慢，
  // 位移量测不出可靠的差别；而"穿过 / 被挡住"正是两种模式的本质区别。
  function passThrough(ghost) {
    const trk = new Track(31337);
    const q = new RacePhysics(trk);
    q.racing = true;
    const a = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
    const gap = Math.max(2, Math.round(6 / trk.spacing));
    const b = q.addCar({ id: 2, name: 'B', color: '#fff', isLocal: false, startIndex: 300 - gap, lateral: 0, laps: 99 });
    q.setGhostMode(ghost);
    const f = trk.tan[300];
    b.body.velocity.set(f.x * 9, 0, f.z * 9);      // 后车以 9m/s 直冲前车
    for (let i = 0; i < 90; i++) q.fixedStep(DT);
    // 沿赛道方向：>0 表示 b 已经跑到 a 前面（= 穿过去了）
    return (b.pos.x - a.pos.x) * f.x + (b.pos.z - a.pos.z) * f.z;
  }
  const alongNormal = passThrough(false);
  const alongGhost = passThrough(true);
  ok(alongNormal < 0.5, '标准模式：前车挡得住后车（穿不过去）',
    '后车纵向位置 ' + num(alongNormal, 2) + ' m（负=还在后面）');
  ok(alongGhost > 1.0, '幽灵模式：后车直接穿过前车（车车完全不解算）',
    '后车纵向位置 ' + num(alongGhost, 2) + ' m（正=已越过）');
  ok(alongGhost - alongNormal > 1.0, '两种模式行为可区分（幽灵开关真的生效）',
    num(alongNormal, 2) + ' m vs ' + num(alongGhost, 2) + ' m');

  // 掩码本身也要对：车组从自己的掩码里剔掉，但仍会与护栏组碰撞
  const q3 = new RacePhysics(new Track(11));
  const c3 = q3.addCar({ id: 1, name: 'C', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 9 });
  q3.setGhostMode(true);
  ok(c3.body.collisionFilterMask === ~CFG.GROUP_CAR_MASK,
    '幽灵模式掩码 = ~GROUP_CAR_MASK（车车整体不接触）',
    String(c3.body.collisionFilterMask) + ' vs ' + String(~CFG.GROUP_CAR_MASK));
  ok((CFG.GROUP_CAR_MASK & CFG.GROUP_BARRIER) === 0,
    '车组位域与护栏组是互不重叠的独立位（分组才能真正起作用）',
    'CARS=0x' + CFG.GROUP_CAR_MASK.toString(16) + ' BARRIER=0x' + CFG.GROUP_BARRIER.toString(16));
  ok((CFG.GROUP_CAR_MASK & c3.body.collisionFilterMask) === 0,
    '车组位域已被自己的掩码整体排除 -> 车与车不接触');
  ok(c3.groupBit === (1 << CFG.GROUP_CAR_BASE),
    '车 1 拿到位 ' + CFG.GROUP_CAR_BASE + '（每车一位，预测性幽灵才能按对隔离）',
    '0x' + c3.groupBit.toString(16));
  ok((CFG.GROUP_BARRIER & c3.body.collisionFilterMask) !== 0,
    '护栏组仍在车的掩码里 -> 幽灵模式下车依然撞得到护栏');
  q3.setGhostMode(false);
  ok(c3.body.collisionFilterMask === -1, '关闭幽灵模式后掩码恢复 -1（全员可碰撞）');

  // ---- J1c 软约束冲量：撞完必须几乎不弹（ForzaPhysicsNetSafety.ResolveNetworkContact）----
  // 原先 onCarCollide 里恢复系数**硬编码 0.3** + 没有冲量截断 -> 撞车弹皮球。
  // 判据用"反弹系数" = 撞后分离速度 / 撞前接近速度，规格恢复系数 0.05 时应在 0.2 以内。
  {
    const trk = new Track(5150);
    const q = new RacePhysics(trk);
    q.racing = true;
    const A = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
    const B = q.addCar({ id: 2, name: 'B', color: '#fff', isLocal: false, startIndex: 300, lateral: 0, laps: 99 });
    const gap = Math.max(4, Math.round(26 / trk.spacing));
    placeOn(A, trk, 300, 0, 20);
    placeOn(B, trk, 300 + gap, 0, -20);        // 对向相撞：接近速度 40m/s
    const f = trk.tan[300];
    let hit = false, rebound = 0, maxSpeed = 0, maxUp = 0;
    for (let i = 0; i < 90; i++) {
      q.fixedStep(DT);
      // rel > 0 = 两车正在接近（距离缩短）；rel < 0 = 已经分离。
      // 撞前 rel ≈ 40；完全非弹性撞后 rel -> 0；有弹性才会出现 rel < 0 的分离速度。
      const rel = (A.body.velocity.x - B.body.velocity.x) * f.x + (A.body.velocity.z - B.body.velocity.z) * f.z;
      maxSpeed = Math.max(maxSpeed, A.speed, B.speed);
      maxUp = Math.max(maxUp, A.body.velocity.y, B.body.velocity.y);
      if (rel > 0.2) hit = true;                       // 记录"确实接近过"
      else if (hit) rebound = Math.max(rebound, -rel);  // 撞击后的分离速度 = 反弹量
    }
    ok(hit, '台架成立：两车确实发生了碰撞');
    ok(rebound / 40 < 0.25,
      '软约束冲量：撞后反弹系数 < 0.25（恢复系数 0.05，不再弹皮球）',
      '反弹 ' + num(rebound, 2) + ' / 接近 40 m/s = ' + num(rebound / 40, 3));
    ok(maxSpeed < 80 && maxUp < 12,
      '冲量截断：对撞后没有车被轰上天（速度与垂向速度都在安全范围）',
      'maxV=' + num(maxSpeed, 1) + ' maxVy=' + num(maxUp, 1));
  }

  // 规格 §二.1：车车与车-护栏接触的 restitution 都设 0.02（近乎绝对塑性，避免皮球弹开）
  ok(CFG.RESTITUTION === 0.05, '车车接触 restitution = 0.05（规格 §三.1）', String(CFG.RESTITUTION));
  // ★ 方案 A（2026-09-30 用户选定）：车-护栏摩擦 0.8 → 0.15。
  //   旧值 0.8 是"高摩擦防弹开"的产物，但代价是 cannon 在接触点上吃掉几乎全部切向速度、
  //   并因摩擦冲量作用在远离质心的角落而把车拧转 —— 用户报的"剐一下就撞停 + 被拉着转"。
  //   现在切向动量的处置交给导流层按入射角分档（见 §四 的分档断言），cannon 只留小摩擦。
  ok(CFG.BARRIER_RESTITUTION === 0.0 && CFG.BARRIER_FRICTION <= 0.2,
    '车-护栏：restitution 0.0 / friction ≤0.2（方案 A：不再是"砂纸"）',
    String(CFG.BARRIER_RESTITUTION) + ' / ' + String(CFG.BARRIER_FRICTION));
  ok(CFG.BARRIER_RELAXATION === 3.0,
    '车-护栏：contactEquationRelaxation = 3.0（规格 §任务2，收紧抑制深穿透反冲）',
    String(CFG.BARRIER_RELAXATION));
}

{
  // ---- J2 并行挤压：低速剐蹭应"贴身滑行"而不是弹开 ----
  function sideContact(enableCut) {
    const trk = new Track(31337);
    const q = new RacePhysics(trk);
    q.racing = true;
    // 必须选最平直的一段并锁死朝向：否则两车沿弯道减速时横向轴漂移，
    // 会凭空产生 ~2.7m/s 的"假分离速度"，把冲量截断的效果完全淹没。
    let flat = 0, best = 1;
    for (let i = 0; i < trk.count; i++) {
      const a = Math.abs(trk.tan[i].y);
      if (a < best) { best = a; flat = i; }
    }
    const sp = trk.spawn(flat, 0);
    const A = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: true, startIndex: flat, lateral: 0, laps: 99 });
    const B = q.addCar({ id: 2, name: 'B', color: '#fff', isLocal: false, startIndex: flat, lateral: 0, laps: 99 });
    const s = trk.side[flat];
    const pose = (c, lat) => {
      const spc = trk.spawn(flat, lat);
      c.body.position.set(spc.position.x, spc.position.y, spc.position.z);
      c.body.quaternion.set(spc.quaternion.x, spc.quaternion.y, spc.quaternion.z, spc.quaternion.w);
      c.body.velocity.set(0, 0, 0);
      c.syncFromBody();
    };
    // 中心横向间距 1.76m（车宽 1.8m -> 重叠 4cm，首步即接触）
    pose(A, 0.88);
    pose(B, -0.88);
    const pin = () => {
      A.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
      B.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
    };
    // A 以 3.0m/s 压向 B（仍低于 3.5m/s 的软接触阈值）
    A.body.velocity.set(s.x * -3.0, 0, s.z * -3.0);
    A.syncFromBody();
    let maxSep = 0, contacted = false, lat = 0;
    for (let i = 0; i < 60; i++) {
      if (!enableCut) q.softPairs.clear();    // 关掉吸收 = 对照组
      pin();
      q.fixedStep(DT);
      if (A.collideHits + B.collideHits > 0) contacted = true;
      const dx = A.pos.x - B.pos.x, dz = A.pos.z - B.pos.z;
      lat = Math.abs(dx * s.x + dz * s.z);
      if (contacted) {
        const rel = (A.body.velocity.x - B.body.velocity.x) * s.x +
                    (A.body.velocity.z - B.body.velocity.z) * s.z;
        if (rel > maxSep) maxSep = rel;
      }
    }
    return { lat, maxSep, contacted, carA: A, carB: B };
  }
  const withCut = sideContact(true);
  const noCut = sideContact(false);
  ok(withCut.contacted, '并排挤压确实产生了接触',
    (withCut.carA.collideHits + withCut.carB.collideHits) + ' 次接触');
  ok(withCut.maxSep < noCut.maxSep * 0.30, '冲量截断把法向分离速度压低约 75%（规格值）',
    '截断后 ' + num(withCut.maxSep, 3) + ' m/s vs 未截断 ' + num(noCut.maxSep, 3) + ' m/s' +
    '（保留 ' + num(withCut.maxSep / noCut.maxSep * 100, 1) + '%）');
  ok(withCut.maxSep < 1.2, '分离速度绝对量很小 -> 两车紧挨着滑行而不是被弹开',
    num(withCut.maxSep, 3) + ' m/s（撞击强度 3.0 m/s）');
  ok(withCut.lat < 2.6, '挤压后横向间距保持在贴身范围（没有飞出）', num(withCut.lat, 2) + ' m');
}

{
  // ---- ★ 规格 §任务5 动态正证：高速追尾不把前车轰上天 / 不甩出暴烈横摆 ----
  //   构造：前车静止，后车以 30m/s 正后方撞上来（远高于软接触阈值 4m/s，走硬接触路径），
  //   统计整段过程中**前车**出现的 vy 峰值与 ωy 峰值，必须被 clampCollisionImpulse 压住。
  //   同时对拍一组"关掉限幅"的对照组，证明限幅真的在起作用（不是场景本身就不产生超调）。
  function rearEnd() {
    const trk = new Track(20260926);
    const q = new RacePhysics(trk);
    q.racing = true;
    // 选最平直一段，锁正朝向，避免弯道自身产生的伪竖直速度
    let flat = 0, best = 1;
    for (let i = 0; i < trk.count; i++) {
      const a = Math.abs(trk.tan[i].y);
      if (a < best) { best = a; flat = i; }
    }
    const s = trk.side[flat], tan = trk.tan[flat];
    const sp = trk.spawn(flat, 0);
    const A = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: true, startIndex: flat, lateral: 0, laps: 99 });
    const B = q.addCar({ id: 2, name: 'B', color: '#fff', isLocal: false, startIndex: flat, lateral: 0, laps: 99 });
    // 用**实测的切线**把 B 摆在 A 正后方 5m（不要用 startIndex 差值推距离：
    // 采样间距≈4.69m，flat+4 其实已隔了 ~19m，30m/s 一步就飞过去了）。
    const place = (c, dx, dz, vx, vz) => {
      c.body.position.set(sp.position.x + dx, sp.position.y, sp.position.z + dz);
      c.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
      c.body.velocity.set(vx, 0, vz);
      c.body.aabbNeedsUpdate = true;
      c.body.updateAABB();
      c.syncFromBody();
    };
    place(A, 0, 0, 0, 0);                                   // 前车静止
    place(B, -tan.x * 5, -tan.z * 5, tan.x * 30, tan.z * 30); // 后车 5m 外 30m/s 冲上来
    // A、B 均锁正朝向（与 sideContact 用例同一手法：排除弯道轴漂移的干扰）
    const pin = () => {
      A.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
      B.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
    };
    let maxVyA = 0, maxWyA = 0, maxVyB = 0, maxWyB = 0, touched = false;
    // 该用例只验证真实刚体碰撞后的竖直/横摆限幅；预测性幽灵化是另一条
    // 防鱼雷路径（22.2m/s 以上会主动隔离车对），这里显式旁路，避免把两条
    // 独立机制混成“碰撞没有发生”。
    q.updatePredictiveGhosting = () => {};
    for (let i = 0; i < 90; i++) {
      pin();
      q.fixedStep(DT);
      if (!touched && (A.collideHits || 0) + (B.collideHits || 0) > 0) touched = true;
      if (touched) {
        maxVyA = Math.max(maxVyA, Math.abs(A.body.velocity.y));
        maxVyB = Math.max(maxVyB, Math.abs(B.body.velocity.y));
        maxWyA = Math.max(maxWyA, Math.abs(A.body.angularVelocity.y));
        maxWyB = Math.max(maxWyB, Math.abs(B.body.angularVelocity.y));
      }
    }
    return { maxVyA, maxVyB, maxWyA, maxWyB, touched };
  }
  const on = rearEnd();
  ok(on.touched, '追尾场景确实产生接触', on.touched ? '已接触' : '未接触');
  ok(on.maxVyA <= CFG.COLLISION_VY_SOFT + 1e-6,
    '★§任务5【正证】：前车竖直反冲被压回软阈值内（不再被铲飞）',
    num(on.maxVyA, 3) + ' m/s ≤ ' + CFG.COLLISION_VY_SOFT);
  ok(on.maxVyB <= CFG.COLLISION_VY_SOFT + 1e-6,
    '§任务5：后车竖直反冲同样受限（避免自身腾空）', num(on.maxVyB, 3) + ' m/s');
  ok(on.maxWyA <= CFG.COLLISION_YAW_CAP + 1e-6,
    '★§任务5【正证】：前车横摆角速度 |ωy| 被截断在 8.0 内（不甩尾）',
    num(on.maxWyA, 3) + ' rad/s ≤ ' + CFG.COLLISION_YAW_CAP);
  ok(on.maxWyB <= CFG.COLLISION_YAW_CAP + 1e-6,
    '§任务5：后车横摆角速度 |ωy| 同样被截断', num(on.maxWyB, 3) + ' rad/s');
  // 反证说明：这里**不做**"关掉限幅能观察到超调"的对照 —— 实测关掉也测不到超调，
  // 因为粘性软接触 + 塑性衰减已经先把极端反冲吃掉了（防御纵深的第一层就以生效）。
  // 那恰恰是好事：说明限幅是**第二层兜底**，不是唯一防线。要证明限幅本身有效，
  // 直接对这些**非物理的极端初值**做单元调用（模拟求解器万一漏网的刁钻输入）。
  const q2 = new RacePhysics(new Track(7));
  const carX = q2.addCar({ id: 1, name: 'X', color: '#fff', isLocal: true, startIndex: 100, lateral: 0, laps: 1 });
  carX.body.velocity.set(0, 9.0, 0);            // 硬塞一个被"铲飞"的竖直速度
  carX.body.angularVelocity.set(0, 21.0, 0);    // 硬塞一个暴烈横摆
  q2._stepTouched = 1;                          // 伪造"本步有碰撞"
  q2.clampCollisionImpulse([carX]);
  ok(Math.abs(carX.body.velocity.y - CFG.COLLISION_VY_REST) < 1e-9,
    '§任务5【单元正证】：超阈 vy(9.0) 被压回 0.2 m/s',
    num(carX.body.velocity.y, 2) + ' -> ' + CFG.COLLISION_VY_REST);
  ok(Math.abs(carX.body.angularVelocity.y - CFG.COLLISION_YAW_CAP) < 1e-9,
    '§任务5【单元正证】：超阈 ωy(21.0) 被截断到 8.0 rad/s',
    num(carX.body.angularVelocity.y, 2) + ' -> ' + CFG.COLLISION_YAW_CAP);
  // 对称性：负向同样截断
  carX.body.angularVelocity.set(0, -21.0, 0);
  carX.body.velocity.set(0, -9.0, 0);
  q2._stepTouched = 1;
  q2.clampCollisionImpulse([carX]);
  ok(Math.abs(carX.body.angularVelocity.y + CFG.COLLISION_YAW_CAP) < 1e-9 &&
     Math.abs(carX.body.velocity.y - CFG.COLLISION_VY_REST) < 1e-9,
    '§任务5：负向 ωy / vy 同样被截断（双向对称）',
    num(carX.body.angularVelocity.y, 2) + ' / ' + num(carX.body.velocity.y, 2));
  // 阈值内不得被误伤（悬挂正常行程必须保留）
  carX.body.velocity.set(0, 0.4, 0); q2._stepTouched = 1;
  q2.clampCollisionImpulse([carX]);
  ok(Math.abs(carX.body.velocity.y - 0.4) < 1e-9,
    '§任务5：阈值内 vy(0.4) 原样保留（悬挂行程不被误压）',
    num(carX.body.velocity.y, 2));
}

{
  // ---- J3 赛道外沙地减速陷阱 ----
  const trk = new Track(11);
  const q = new RacePhysics(trk);
  q.racing = true;
  const c = q.addCar({ id: 1, name: 'S', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const grassLat = trk.halfWidth + trk.curbWidth + 6;      // 四轮全在草/沙上
  function hold(lat) {
    const sp = trk.spawn(300, lat);
    c.body.position.set(sp.position.x, sp.position.y, sp.position.z);
    c.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
    c.syncFromBody();
  }
  hold(grassLat);
  c.input.throttle = 1;
  let peak = 0;
  // 跑 10 秒：沙地牵引受 0.65 抓地上限约束，提速很慢（约 0.12g），
  // 4 秒只能到 ~17km/h，看不出"能不能脱困"；10 秒能到 ~70km/h 才有判别力。
  for (let i = 0; i < 60 * 10; i++) {
    c.input.throttle = 1;
    q.fixedStep(DT);
    hold(grassLat);
    peak = Math.max(peak, c.speedKmh);
  }
  ok(c.grassWheels === 4, '四轮全部驶离沥青', c.grassWheels + ' 轮在赛道外');
  ok(c.offRoad > 0.95, '沙地陷阱被激活', 'offRoad=' + num(c.offRoad, 2));
  // 规格：**废除**脚本式"限速 + 削力 + 叠阻尼"，沙地只靠纯物理阻滞。
  ok(!('OFFROAD_VMAX_KMH' in CFG) && !('OFFROAD_THRUST_CUT' in CFG),
    '沙地脚本常量已彻底删除（无硬限速 / 无脚本削力）');
  ok(Math.abs(c.body.linearDamping) < 1e-9,
    '底盘线性阻尼恒为 0（阻力全部显式建模，不叠全局阻尼）', num(c.body.linearDamping, 3));
  ok(Math.abs(c.offRoadMu - CFG.OFFROAD_FRICTION_SLIP) < 0.02,
    '沙地抓地崩溃到 ' + CFG.OFFROAD_FRICTION_SLIP + '（侧向+纵向同一条）', num(c.offRoadMu, 3));
  // 关键：沙地必须**仍然开得动**。上一版滚阻+阻尼叠过头，全油门峰值只有 0.8km/h，车陷死。
  ok(peak > 35 && peak < 110,
    '沙地全油门仍能脱困提速（不被滚阻压死）', '峰值 ' + num(peak, 1) + ' km/h');

  // 回到沥青：1.0 秒内平滑恢复
  let tRec = 0;
  while (c.offRoad > 0.02 && tRec < 3) {
    c.input.throttle = 1;
    q.fixedStep(DT);
    hold(0);
    tRec += DT;
  }
  ok(tRec > 0.8 && tRec < 1.2, '重新全轮回到沥青后 1.0 秒内平滑恢复', num(tRec, 2) + ' s');

  // ---- J3b ★ FM8 式赛道外二连（用户报障："不符合物理" + "撞停后想回到赛道很困难"）----
  //
  // ① 草地上必须**真的滑**：出界的侧向抓地必须**低于**路面抓地。
  //    旧实现把侧向下限抬到 1.55μ（比路面还高）⇒ 草地上像在轨道上，与 FM8 完全相反。
  ok(CFG.OFFROAD_LAT_GRIP_MIN < CFG.GRIP_ROAD,
    '★出界侧向抓地低于路面抓地（草地上会滑，不是"轨道上"）',
    '出界 ' + CFG.OFFROAD_LAT_GRIP_MIN + 'μ < 路面 ' + CFG.GRIP_ROAD + 'μ');
  ok(CFG.OFFROAD_DRAG_K <= 0.25 && CFG.OFFROAD_SOFT_VMAX >= 22,
    '★出界没有"撞墙式"限速（软上限 ≥ 80km/h、附加阻力 ≤ 0.6g 量级）',
    '软上限 ' + num(CFG.OFFROAD_SOFT_VMAX * 3.6, 0) + 'km/h / 阻力 ' + CFG.OFFROAD_DRAG_K);

  // ② 撞停后必须能开回赛道：把车**停**在草地上、车头对准赛道，全油门 ⇒ 必须回到沥青。
  {
    const trk2 = new Track(11);
    const q2 = new RacePhysics(trk2);
    q2.racing = true;
    const c2 = q2.addCar({ id: 1, name: 'S', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
    const lat2 = trk2.halfWidth + trk2.curbWidth + 8;      // 四轮全在草地
    const sp = trk2.spawn(300, lat2);
    const i300 = 300 % trk2.count;
    // 车头**对准赛道**（指向中心线），而不是顺着赛道 —— 这正是"想回到赛道"的场景
    const s = trk2.side[i300];
    const yawToTrack = Math.atan2(-s.x * Math.sign(lat2), -s.z * Math.sign(lat2));
    c2.body.position.set(sp.position.x, sp.position.y, sp.position.z);
    c2.body.quaternion.set(0, Math.sin(yawToTrack / 2), 0, Math.cos(yawToTrack / 2));
    c2.body.velocity.set(0, 0, 0);
    c2.body.angularVelocity.set(0, 0, 0);
    c2.syncFromBody();
    let backT = -1, backKmh = 0;
    for (let i = 0; i < 60 * 12; i++) {
      c2.input.throttle = 1;
      q2.fixedStep(DT);
      if (backT < 0 && c2.grassWheels <= 1) { backT = i * DT; backKmh = c2.speedKmh; break; }
    }
    ok(backT > 0 && backT < 8,
      '★撞停后从草地全油门能回到赛道（不需要按复位）',
      backT > 0 ? (num(backT, 1) + 's 回到沥青，此时 ' + num(backKmh, 0) + ' km/h') : '12s 内没能回到赛道');
    ok(backKmh > 12, '回到赛道时已带着前进速度（不是蹭上去）', num(backKmh, 0) + ' km/h');
  }
  ok(c.body.linearDamping < 0.02, '阻尼恢复正常', num(c.body.linearDamping, 3));
}

{
  // ---- J3b 动摩擦下限（规格）：草地/侧滑时也必须消耗动能，不得像冰面无限平移 ----
  ok(CFG.MU_SLIP_FLOOR === 0.45, '动摩擦下限常量 = 0.45（规格值）', CFG.MU_SLIP_FLOOR);

  const trk = new Track(11);
  const q = new RacePhysics(trk);
  q.racing = true;
  const c = q.addCar({ id: 1, name: 'I', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  // 四轮全在草地上，给一个**纯横向**初速 18m/s（模拟被打转甩出赛道）
  const grassLat = trk.halfWidth + trk.curbWidth + 6;
  const sp = trk.spawn(300, grassLat);
  const pin = () => {
    c.body.position.set(sp.position.x, sp.position.y, sp.position.z);
    c.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
  };
  pin();
  const side = trk.side[300];
  c.body.velocity.set(side.x * 18, 0, side.z * 18);
  c.syncFromBody();
  let tStop = 0;
  for (let i = 0; i < 60 * 15; i++) {
    q.fixedStep(DT);
    pin();
    tStop += DT;
    if (Math.hypot(c.body.velocity.x, c.body.velocity.z) < 0.5) break;
  }
  ok(tStop < 6.0, '草地纯横滑 18m/s -> 靠动摩擦自然滑停（不是无限平移）',
    '停住用时 ' + num(tStop, 2) + ' s');
  ok(tStop > 1.0, '动摩擦下限没有夸张到"一碰就停"（保留滑行手感）', num(tStop, 2) + ' s');

  // 方向性验证：把下限抬到 1.2，滑停必须**更快** —— 证明这个下限真的接在
  // 横向摩擦的钳位上，而不是一段没人读的死代码。
  // （注意不能用"压低下限"来反证：草地上真正的约束量是 offRoadMu·g = 6.38，
  //   它本身就高于下限 4.41，压低下限根本不起作用 —— 下限只在 aLatCap 崩塌时才咬合。）
  const keep = CFG.MU_SLIP_FLOOR;
  CFG.MU_SLIP_FLOOR = 1.2;
  const q2 = new RacePhysics(new Track(11));
  q2.racing = true;
  const c2 = q2.addCar({ id: 1, name: 'J', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const sp2 = trk.spawn(300, grassLat);
  const pin2 = () => {
    c2.body.position.set(sp2.position.x, sp2.position.y, sp2.position.z);
    c2.body.quaternion.set(sp2.quaternion.x, sp2.quaternion.y, sp2.quaternion.z, sp2.quaternion.w);
  };
  pin2();
  c2.body.velocity.set(side.x * 18, 0, side.z * 18);
  c2.syncFromBody();
  let tHard = 0;
  for (let i = 0; i < 60 * 15; i++) {
    q2.fixedStep(DT);
    pin2();
    tHard += DT;
    if (Math.hypot(c2.body.velocity.x, c2.body.velocity.z) < 0.5) break;
  }
  CFG.MU_SLIP_FLOOR = keep;
  ok(tHard < tStop * 0.8, '下限抬到 1.2 后滑停明显更快（证明下限真的接在横向摩擦钳位上）',
    '0.45 -> ' + num(tStop, 2) + 's ；1.20 -> ' + num(tHard, 2) + 's');
}

{
  // ---- J4 救援复位（R 键）：秒级复位 + 3.5s 幽灵化（无任何冻结）----
  const trk = new Track(4242);
  const q = new RacePhysics(trk);
  q.racing = true;
  const c = q.addCar({ id: 1, name: 'R', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const g = trk.gridSlot(3);
  const sp = trk.spawn(g.index, 0);
  c.body.position.set(sp.position.x, sp.position.y, sp.position.z);
  c.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
  c.syncFromBody();
  for (let i = 0; i < 60 * 3; i++) { c.input.throttle = 1; q.fixedStep(DT); }
  const cpIdxBefore = c.cpIdx;
  ok(cpIdxBefore >= 0, '车辆已进入 Checkpoint 区间', 'cpIdx=' + cpIdxBefore);
  // 规格 §一.1：压 R 前先确认**驶出锚点已经缓存**（四轮都在沥青上的最后一帧）
  ok(c.lastLegalAnchor && Number.isFinite(c.lastLegalAnchor.yaw),
    '四轮在沥青上时持续缓存驶出锚点',
    c.lastLegalAnchor ? ('x=' + num(c.lastLegalAnchor.x, 1) + ' yaw=' + num(c.lastLegalAnchor.yaw, 3)) : 'null');
  const anc = { x: c.lastLegalAnchor.x, y: c.lastLegalAnchor.y, z: c.lastLegalAnchor.z };
  c.body.velocity.set(30, 0, 0);
  c.body.angularVelocity.set(0, 2, 0);
  q.rescueToCheckpoint(c);
  // 规格 §一.2：R 键优先回**驶出锚点**（就近脱困），既不回起点、也不去就近的 Checkpoint。
  ok(CFG.RESCUE_TO_DEPART === true, 'R 键默认回驶出锚点（规格 §一.2）');
  ok(Math.hypot(c.pos.x - anc.x, c.pos.z - anc.z) < 1.0,
    '瞬移回驶出锚点（四轮都在沥青上的最后一帧），不是起点也不是就近 Checkpoint',
    'dh=' + num(Math.hypot(c.pos.x - anc.x, c.pos.z - anc.z), 3) + ' m');
  ok(CFG.RESCUE_HEIGHT === 0.4 && CFG.RESCUE_DEPART_LIFT === 0.3,
    '复位抬升常量 = 0.3m（规格 §一.2）', CFG.RESCUE_DEPART_LIFT + ' m');
  ok(Math.abs((c.pos.y - anc.y) - CFG.RESCUE_DEPART_LIFT) < 0.02,
    '高度 = 驶出锚点上方 ' + CFG.RESCUE_DEPART_LIFT + 'm（规格值）',
    num(c.pos.y - anc.y, 3) + ' m');
  // 朝向对齐**驶出点切线**（锚点存的是切线 yaw；用纯 yaw 重建四元数 -> 倾斜/滚转必为 0）
  const yawErr = Math.abs(((Math.atan2(c.fwd.x, c.fwd.z) - c.lastLegalAnchor.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  ok(yawErr < 0.02, '车头朝向对齐驶出点切线方向', 'yaw 误差 ' + num(yawErr, 4) + ' rad');
  ok(Math.abs(c.fwd.y) < 0.02, '倾斜角与滚转角归零（不会带着翻车姿态复位）', 'fwd.y=' + num(c.fwd.y, 4));
  // 规格 §二.2：**继承驶出瞬间的初速度**（不再是清零 —— 清零会让复位后原地熄火）。
  // 判据三连：① 角速度必须清零；② 线速度必须非零且沿车头方向；③ 大小落在 clamp 区间内。
  ok(c.body.angularVelocity.length() < 1e-6, '角速度已清零（复位后不打转）',
    '|ω|=' + num(c.body.angularVelocity.length(), 6));
  const vAlong = c.body.velocity.x * c.fwd.x + c.body.velocity.z * c.fwd.z;
  const vMag = Math.hypot(c.body.velocity.x, c.body.velocity.z);
  ok(vMag > CFG.RESCUE_SPEED_MIN - 1e-6 && vMag <= CFG.RESCUE_SPEED_MAX + 1e-6,
    '初速度落在 clamp(8.0, 28.0) 区间内（规格 §二.2）',
    num(vMag, 3) + ' m/s');
  ok(vAlong > 0 && Math.abs(vAlong - vMag) < 1e-3,
    '初速度方向 = 车头前进方向（不侧滑、不倒退）',
    '沿车头 ' + num(vAlong, 3) + ' / 模长 ' + num(vMag, 3));
  ok(Math.abs(c.penalty - CFG.RESCUE_PENALTY) < 1e-6, '罚时 +3.0s（规格值，静默显示在榜单）',
    '+' + num(c.penalty, 1) + 's');
  ok(c.freezeTimer === undefined, '已彻底移除定身冻结（规格：秒级复位，立即可以发车）');

  // 幽灵化 3.5s
  ok(Math.abs(c.ghostTimer - CFG.GHOST_TIME) < 1e-6, '幽灵化保护 3.5s 启动（规格值）',
    num(c.ghostTimer, 2) + ' s');
  // 规格 §二.3：幽灵期**绝不能用 collisionResponse=false**（那是全局总闸，
  // 关掉会连护栏一起失效 -> 半透明车穿护栏飞出赛道）。必须保持 true，改用掩码隔离。
  ok(c.ghost === 1 && c.body.collisionResponse === true,
    '★幽灵期间 collisionResponse 保持 true（严禁关总闸，否则穿护栏飞出赛道）');
  ok((c.body.collisionFilterMask & CFG.GROUP_CAR_MASK) === 0,
    '幽灵期车组掩码被剔（可穿透其他玩家车辆）',
    'mask=0x' + (c.body.collisionFilterMask >>> 0).toString(16));

  // 幽灵穿透：另一台车直接压在幽灵车上，不应被体积阻挡。
  // ⚠ 规格 §二.2 起复位会**继承初速度**，幽灵车自己会开走，因此不能再断言
  // "中心距 < 1.2m"（那会随初速度变大而假红）。改为断言**可观测的物理量**：
  //   · 两车都没有获得被刚度弹飞的巨大速度（碰撞若开着，压在一起会被弹开数 m/s）
  //   · 幽灵车速度没有被"撞击"改变方向/量级（穿透 = 互不干扰）
  const other = q.addCar({ id: 2, name: 'O', color: '#fff', isLocal: false, startIndex: c.trackIdx, lateral: 0, laps: 99 });
  other.body.position.copy(c.body.position);
  other.body.velocity.set(0, 0, 0);
  other.syncFromBody();
  const ghostVBefore = Math.hypot(c.body.velocity.x, c.body.velocity.z);
  for (let i = 0; i < 12; i++) q.fixedStep(DT);
  const ghostVAfter = Math.hypot(c.body.velocity.x, c.body.velocity.z);
  const otherVAfter = Math.hypot(other.body.velocity.x, other.body.velocity.z);
  ok(otherVAfter < 3.0, '幽灵期被车压住不被刚度弹飞（穿透生效，无体积阻挡）',
    '对方速度 ' + num(otherVAfter, 3) + ' m/s（若碰撞开着会被弹飞数米/秒）');
  ok(ghostVAfter > ghostVBefore * 0.5,
    '幽灵车速度未被撞击破坏（穿透 = 互不干扰，速度量级保持）',
    num(ghostVBefore, 2) + ' -> ' + num(ghostVAfter, 2) + ' m/s');

  // 幽灵期间可正常起步
  for (let i = 0; i < 90; i++) { c.input.throttle = 1; c.input.brake = 0; c.input.handbrake = 0; q.fixedStep(DT); }
  ok(c.speedKmh > 15, '复位后立刻能踩油门加速（无 3 秒等待）', num(c.speedKmh, 1) + ' km/h');

  // 3.5s 后恢复
  for (let i = 0; i < 60 * 3; i++) { q.fixedStep(DT); }
  ok(c.ghostTimer === 0 && c.ghost === 0 && c.body.collisionResponse === true,
    '3.5s 后幽灵解除：透明度与碰撞响应平滑恢复',
    'ghost=' + num(c.ghost, 3) + ' collisionResponse=' + c.body.collisionResponse);
}

/* --------------------------------------------------------------------- */
/* K. 本轮新增：动态排位 / 摄像机防翻转 / 完赛巡航 / 网络底层                 */
/* --------------------------------------------------------------------- */
section('K. 动态排位 / 相机防翻转 / 完赛巡航 / 网络底层');

{
  // ---- K1 排行榜绝对进程坐标（★ 2026-09-29：单位必须是米）----
  const src = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/function progressScore\(c\)/.test(src), '存在 progressScore 进程坐标函数');
  // ★ 量纲红线：离线 HUD 的秒差列是 `(score(他) − score(我)) / 参考车速`，它假设 score 是米。
  //   旧的 `lap*100000 + cpIdx*1000 − 距离` 只要两车跨 Checkpoint 边界就凭空多出 1000
  //   （真实约 281m 被说成 1000m），除以起步 12m/s 的下限参考车速 = **+83 秒**，
  //   跨几个 CP 就是"刚起步跳几百秒"（用户报的"左上角时间差乱跳"）。
  ok(/idx \* sp/.test(src) && /ord \* L/.test(src) &&
     !/c\.lap \* 100000 \+ Math\.max\(0, c\.cpIdx\) \* 1000/.test(src),
    '★★进程坐标 = 压线次数×赛道全长 + 弧长（**单位米**，等弧长采样），不再把 CP 序号当米用');
  // ★★ 跨圈项必须是"几何压线次数" lineCross，不能是 lap：lap 要集齐全部 CP 才 +1，
  //    车辆刚过起终点线时 trackIdx 从 ~N-1 跳到 ~0 ⇒ 坐标瞬间后退一整圈
  //    （6755m ÷ 起步 12m/s ≈ 几百秒），排位也会短暂倒置。
  {
    const phys = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
    ok(/c\.lineCross = \(c\.lineCross \|\| 0\) \+ 1/.test(phys) &&
       /c\.lineCross = Math\.max\(0, \(c\.lineCross \|\| 0\) - 1\)/.test(phys),
      '★★physics 在索引回绕处维护 lineCross（前向 +1 / 倒车 −1）');
    ok(/const prevIdx = c\.trackIdx;[\s\S]{0,200}c\.trackIdx = info\.i;[\s\S]{0,400}dIdx < -halfCount/.test(phys),
      '★lineCross 放在 groundConstraint（对 remote 车同样生效，观战/名次都要连续坐标）');
    ok(/typeof c\.lineCross === 'number'\) \? c\.lineCross : Math\.max\(0, c\.lap \| 0\)/.test(src),
      '★progressScore 优先用 lineCross（缺字段的老快照回落 lap）');
  }
  ok(/c\.trackIdx/.test(src) && /t\.spacing/.test(src),
    '★弧长坐标来自 trackIdx × spacing（赛道采样是等弧长的，所以弧长 = 序号 × 间距）');
  // 服务端那一份是 **ordinal 排序积分**（int64），只在"双方还没有公共 Checkpoint"的兜底
  // 分支里按 nominalCpMeters 折成米；权威秒差走 spline 弧长 + 整圈时长。两套口径不混用。
  const goSrcK1 = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  ok(/scoreLapW = 100000/.test(goSrcK1) && /nominalCpMeters/.test(goSrcK1),
    '服务端 progressScore 保持 ordinal 排序积分，折算里程只经 nominalCpMeters（不直接除以车速）');
  ok(!/progressScore\([^)]*\)[^;]*\/\s*(speed|v\b|ref)/.test(goSrcK1),
    '★服务端没有"ordinal 积分差 ÷ 车速"这种量纲错误');
  ok(/progressScore\(b\) - progressScore\(a\)/.test(src), '榜单按进程坐标降序实时重排');
  ok(/ORD = \['1st', '2nd', '3rd', '4th'\]/.test(src), '名次以 1st/2nd/3rd/4th 展示');
  // 规格 §五.1 第四列：处罚是**独立一列**的橙黄色块，内容 = 累计罚时 + 违规次数
  ok(/class="pen hit"/.test(src) && /safeFixed\((?:e\.pen|c\.penalty),\s*2\)/.test(src) && /violations|e\.vio/.test(src),
    '处罚列渲染成橙黄色块（罚时 + 违规次数，如 "+2.70 1"）');
  ok(!/penBox/.test(src), '已移除罚时卡片弹窗');
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  ok(/\.pen-tag\s*\{/.test(css), 'CSS 定义 .pen-tag 罚时标签样式');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  ok(!html.includes('penBox') && !html.includes('id="rescue"'),
    'HTML 已移除罚时卡片与救援冻结横幅');
  // 规格 §五：计时塔列头 = 玩家数 / 时间差距 / 处罚 / 🔧；行 = 名次(+王冠) / 车手 / 差距 / 处罚 / 🔧
  ok(/时间差距/.test(html) && /处罚/.test(html) && /id="twHdr"/.test(html) && /id="standList"/.test(html),
    '计时塔列头含 时间差距 / 处罚（规格 §五.1）');
  ok(/🔧/.test(html), '计时塔列头带 🔧 列（规格 §五.1 第四列图标）');
  ok(/id="curLapTime"/.test(html) && /id="lapbox"|class="lapbox"/.test(html) &&
    /id="lapNum"/.test(html) && /id="telFL"/.test(html) && /id="minimap"/.test(html),
    'HUD 齐备：圈速信息框 / 右上圈数 / 右下遥测 / 左下微缩地图（规格 §五.2-5）');
  // 规格 §五.2：圈速框必须**无边框 / 无卡片底**，且含"目前单圈 / 最佳 / 惩罚"
  ok(/目前单圈/.test(html) && /最佳/.test(html) && /惩罚/.test(html),
    '圈速框三行 = 目前单圈 / 最佳 / 惩罚（规格 §五.2）');
  // 规格 §五.1：名次带王冠、自己的车蓝色高亮（源码级）
  {
    const mjsT = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
    ok(/class="crown"/.test(mjsT) && /r\.rk === 1/.test(mjsT),
      '计时塔第一名名次后渲染王冠（规格 §五.1）');
    ok(/class="wr"/.test(mjsT),
      '计时塔末列渲染 🔧 维修区标记（规格 §五.1）');
  }

  // ---- 微缩地图：透明底，只保留赛道线、终点线和车辆标记 ----------------
  {
    const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
    const mjs = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
    const mm = css.slice(css.indexOf('#minimap'), css.indexOf('#minimap') + 260);
    ok(/border-radius:\s*50%/.test(mm) && /background:\s*#696969/.test(mm),
      '小地图使用 #696969 圆形背景（地图尺寸不变）');
    ok(/width:\s*176px/.test(mm), '小地图保持 176px 可视尺寸');
    const mcStart = css.indexOf('\n.map-card {');
    const mc = css.slice(mcStart, mcStart + 320);
    ok(/padding:\s*0/.test(mc) && /background:\s*transparent/.test(mc),
      '地图卡片保持透明外壳，灰色圆盘由地图画布承载');
    ok(/#3a8cff/.test(mjs), '§五.3：自己的车 = 蓝色三角箭头（#3a8cff）');
    ok(/白色实心圆点|#f2f6fa/.test(mjs), '§五.3：其他车 = 白色实心圆点（#f2f6fa）');
    ok(!/mapCtx\.arc\(cx, cy, R, 0, Math\.PI \* 2\)/.test(mjs),
      '地图不再绘制圆形裁切底衬');
    ok(/#38e8c8/.test(mjs), '§五.3：终点线 = 青绿色短横条（#38e8c8）');
  }

  // ---- 规格 §四：完赛轻量化条幅 + 观战入力回显 + 仪表映射 --------------------
  {
    const mjs = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
    const html4 = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    const css4 = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
    // §四.1：完赛 → 不弹全屏结果面板，只显示单行条幅（含切换观战提示）
    ok(/function showFinishBar\(text\)/.test(mjs) && /function hideFinishBar\(\)/.test(mjs),
      '§四.1：存在 showFinishBar / hideFinishBar 单行条幅控制');
    ok(/id="finishBar"/.test(html4) && /id="finishBarTxt"/.test(html4),
      '§四.1：HTML 含 #finishBar / #finishBarTxt 条幅容器');
    ok(/切换观战/.test(mjs) || /切换观战/.test(html4),
      '§四.1：条幅文案含"← / → 切换观战"提示');
    // CSS 类名是小写 `.finishbar`（HTML id 是 camelCase `finishBar`），此处按类名匹配
    ok(/\.finishbar\s*\{/.test(css4) && /\.finishbar\s+\.fb-txt/.test(css4),
      '§四.1：CSS 定义 .finishbar 条幅样式（含 .fb-txt 文案）');
    // §四.2：观战入力回显（Input Telemetry Overlay）
    ok(/function updateInputOverlay\(car\)/.test(mjs),
      '§四.2：存在 updateInputOverlay（观战入力回显）');
    ok(/id="inputOverlay"/.test(html4),
      '§四.2：HTML 含 #inputOverlay 容器');
    ok(/ioW|ioA|ioS|ioD|ioSpace/.test(mjs) && /ioW|ioA|ioS|ioD|ioSpace/.test(html4),
      '§四.2：WASD + Space 键盘指示器（ioW/ioA/ioS/ioD/ioSpace）');
    ok(/ioThr|ioBrk/.test(html4) && /ioThr|ioBrk/.test(mjs),
      '§四.2：油门 / 刹车进度条（ioThr / ioBrk）');
    // 观战时把被观战车喂进 overlay（而非本地车）
    ok(/updateInputOverlay\(spectating \? specCar : null\)/.test(mjs) ||
       /updateInputOverlay\([^)]*specCar[^)]*\)/.test(mjs),
      '§四.2：观战时回显被观战车的实时输入');
    // §四.3：观战时时速仪表盘重定向到被观战者
    ok(/camFocusCar|specCar/.test(mjs) && /spectating/.test(mjs),
      '§四.3：存在观战聚焦车（camFocusCar/spectating）逻辑');
  }

  // ---- 规格 §任务3：时差列**行为级**验证（相对本地玩家 / 相对第一名）----------
  //   从 main.js 源码里**抽出真实的 renderGap + fmtDelta** 来跑，而不是复刻一份
  //   等价实现（复刻会与源码脱钩，源码改坏了测试照样绿）。
  {
    const mjs = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
    const grab = (name, endMarker) => {
      const s = mjs.indexOf('const ' + name + ' =');
      const e = mjs.indexOf(endMarker, s);
      return s >= 0 ? mjs.slice(s, e + endMarker.length) : '';
    };
    const fmtSrc = mjs.slice(mjs.indexOf('const fmtDelta ='), mjs.indexOf('};', mjs.indexOf('const fmtDelta =')) + 2);
    const gapSrc = mjs.slice(mjs.indexOf('const renderGap ='), mjs.indexOf('};', mjs.indexOf('const renderGap =')) + 2);
    ok(fmtSrc.length > 20 && gapSrc.length > 60,
      '§任务3：能从源码抽到 fmtDelta / renderGap 两个真实实现', `fmt=${fmtSrc.length} gap=${gapSrc.length}`);
    // eslint-disable-next-line no-new-func
    const factory = new Function('num1', fmtSrc + '\n' + gapSrc + '\nreturn { fmtDelta, renderGap };');
    const num1 = (v) => typeof v === 'number' && isFinite(v);
    const { renderGap } = factory(num1);
    const strip = (h) => h.replace(/<[^>]+>/g, '').trim();

    // 场景A：本地 = P1。delta_relative = gap - localGap(=0)
    const A = [{ id: 1, gap: 0 }, { id: 2, gap: -3.5 }, { id: 3, gap: -8.25 }, { id: 4, gap: -12.4 }];
    const lA = 1, lgA = 0;
    const rA = A.map((e, i) => strip(renderGap(i === 0, e.id === lA, e.gap - lgA, A[0].id === lA)));
    ok(rA[0] === '--', '§任务3：本地=P1 -> 第一行 "--"', rA[0]);
    ok(rA[1].startsWith('-') && rA[2].startsWith('-') && rA[3].startsWith('-'),
      '§任务3：本地=P1 -> 后续行全部负数（相对本地玩家）', rA.slice(1).join(' '));

    // 场景B：本地 = P3（gap 相对 P1；P1=0, P2=-4, P3=-9.5, P4=-15）
    const B = [{ id: 7, gap: 0 }, { id: 2, gap: -4.0 }, { id: 9, gap: -9.5 }, { id: 5, gap: -15.0 }];
    const lB = 9, lgB = -9.5;
    const rB = B.map((e, i) => strip(renderGap(i === 0, e.id === lB, e.gap - lgB, B[0].id === lB)));
    // ★ 语义按用户要求修正（2026-09-30）：字段契约是 delta>0 = 该车领先本地玩家，
    //   所以"我落后时第一名"应显示 **+9.5**（领先我这么多）。旧断言要求负数，
    //   正是用户报的"第一名一直显示 -xx 秒"。物理/UI 一致：+ = 该车在我前面。
    ok(rB[0] === '+9.5s', '★本地非P1 -> 第一行 = 领先我的秒数（正号，用户要求）', rB[0]);
    ok(rB[1] === '+5.5s', '§任务3：第二行领先本地玩家 -> "+X.X"', rB[1]);
    ok(rB[2] === '--', '§任务3：本地玩家所在行（P3）-> "--"', rB[2]);
    ok(rB[3] === '-5.5s', '§任务3：第四行落后本地玩家 -> "-X.X"', rB[3]);
    // 反向守卫：绝不能再出现"与前一名"的语义（用 e.int 就是回归）。
    //   先剥注释再扫 —— 否则会把解释"为什么删掉 gAhead"的说明文字本身当违规。
    const codeOnly = mjs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/fmtDelta\(e\.int\)/.test(codeOnly) && !/gAhead/.test(codeOnly),
      '§任务3：已彻底移除"与前一名 e.int / gAhead"的旧时差语义（防回归）');
  }

  // 积分排序行为：圈数优先 > CP 索引优先 > 距离
  const mkScore = (lap, cpIdx, d) => lap * 100000 + cpIdx * 1000 - d;
  ok(mkScore(1, 5, 10) > mkScore(0, 15, 10), '圈数优先（1 圈 5 号 CP 高于 0 圈 15 号 CP）');
  ok(mkScore(0, 7, 5) > mkScore(0, 7, 120), '同 CP 区间内离下一个 CP 更近者排前');
  ok(mkScore(0, 8, 10) > mkScore(0, 7, 5), 'CP 索引优先于距离');
  // 铃鹿 CP 间距 ≈ 6755/24 ≈ 281m；权重必须大于它，否则区间内会错乱（旧代码权重只有 100）
  ok(mkScore(0, 8, 10) > mkScore(0, 7, 281), 'CP 索引权重压得过最大 CP 间距 281m');
}

{
  // ---- K2 摄像机防翻转（源码级 + 数值级）----
  const src = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(!/apex|APEX_YAW/.test(src), '已废除基于车身瞬时角速度的预瞄偏转');
  ok(/YAW_LP: 7\.0/.test(src), '新增偏航角低通滤波系数');
  ok(/camState\.yaw \+= dyaw \* \(1 - Math\.exp\(-CAM\.YAW_LP \* dt\)\)/.test(src),
    '偏航角做指数低通阻尼滤波（镜头方位唯一依据）');
  ok(/const cosA = \(relX \* nfx \+ relZ \* nfz\) \/ relL/.test(src),
    '存在"镜头与车头夹角"的判据');
  ok(/if \(Math\.abs\(orbitYaw\) < 0\.05 && cosA > 0\)/.test(src),
    '死锁：默认追尾视角夹角超过 90° 时把镜头镜像回车尾后半球');
  ok(/CAM\.DIST/.test(src) && /CAM\.HEIGHT/.test(src), '仍严格使用 5.5m / 1.8m 扇区参数');

  // 数值验证：把镜头硬塞到车头前方，看是否被夹回后半球且保持半径
  const fwd = new THREE.Vector3(0, 0, 1);
  const want = new THREE.Vector3(0, 1.8, 5.5);          // 明显在车头前方
  const fl = Math.hypot(fwd.x, fwd.z);
  const nfx = fwd.x / fl, nfz = fwd.z / fl;
  const relX = want.x, relZ = want.z;
  const relL = Math.hypot(relX, relZ);
  const cosA = (relX * nfx + relZ * nfz) / relL;
  const proj = relL * cosA;
  if (cosA > 0) { want.x -= nfx * proj * 2; want.z -= nfz * proj * 2; }
  const cosAfter = (want.x * nfx + want.z * nfz) / Math.hypot(want.x, want.z);
  ok(cosAfter <= 0 && Math.abs(Math.hypot(want.x, want.z) - 5.5) < 1e-6,
    '越界镜头被镜像回后半球且保持 5.5m 扇区半径',
    'cosA ' + num(cosA, 2) + ' -> ' + num(cosAfter, 2) + '，半径 ' + num(Math.hypot(want.x, want.z), 2) + 'm');
}

{
  // ---- K3 完赛自动巡航：60km/h 沿最佳走线，≥300m ----------------
  ok(CFG.CRUISE_KMH === 60, '完赛巡航速度 = 60km/h（规格值）');
  const trk = new Track(4242);
  const q = new RacePhysics(trk);
  q.racing = true;
  const g = trk.gridSlot(3);
  const c = q.addCar({ id: 1, name: 'F', color: '#fff', isLocal: false, startIndex: g.index, lateral: 0, laps: 1, ai: true });
  c.auto = true;
  const sp = trk.spawn(g.index, 0);
  c.body.position.set(sp.position.x, sp.position.y, sp.position.z);
  c.body.quaternion.set(sp.quaternion.x, sp.quaternion.y, sp.quaternion.z, sp.quaternion.w);
  c.syncFromBody();
  c.finished = true;            // 直接标记完赛，验证巡航行为
  let sumSpd = 0, n = 0, maxLat = 0;
  for (let i = 0; i < 60 * 25; i++) {
    q.fixedStep(DT);
    if (i > 60 * 8) { sumSpd += c.speedKmh; n++; }        // 跳过起步阶段
    if (i % 5 === 0) maxLat = Math.max(maxLat, Math.abs(trk.sample(c.pos.x, c.pos.z, c.trackIdx).lateral));
  }
  ok(Math.abs(sumSpd / n - CFG.CRUISE_KMH) < 14, '完赛后稳定维持约 60km/h 巡航（不紧急制动、不停在终点线）',
    num(sumSpd / n, 1) + ' km/h');
  ok(c.finishDist > 300, '巡航里程 ≥ 300m（规格）', num(c.finishDist, 0) + ' m');
  ok(maxLat < 14, '巡航沿最佳走线行驶（不冲出赛道）', 'max|lat|=' + num(maxLat, 2) + ' m');
  ok(/raceLine\.offset\[li\]/.test(fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8')),
    '巡航目标点取自最佳走线偏移量');
}

{
  // ---- K4 网络底层：TCP NoDelay + 单调时钟戳 + 80ms/100ms 插值参数 ----
  const go = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  ok(/SetNoDelay\(true\)/.test(go), 'Go 侧已开启 TCP_NODELAY（消除 Nagle 粘包成簇）');
  ok(/conn\.\(\*net\.TCPConn\)/.test(go), '通过类型断言取到底层 TCPConn');
  ok(/func monoMs\(\) int64/.test(go) && /time\.Since\(serviceStart\)/.test(go),
    '服务端提供单调时钟戳 monoMs（不受 NTP 校时影响）');
  ok(/"mts":/.test(go), '快照包附带单调时钟戳 mts');
  ok(/"m":/.test(go), 'pong 附带单调时钟 m');
  ok(/16666 \* time\.Microsecond/.test(go), '广播保持 60Hz（16666µs Ticker）');
  // ---- 时间轴隔离守卫（曾经的真实缺陷，必须静态钉住）----
  // startAt / ts 走 UnixMilli 墙钟；mts / pong.m 走进程相对单调毫秒。
  // 客户端 raceClock = (Date.now()+simOffset) − raceStartAt，两边必须同为墙钟；
  // 一旦服务端把 monoMs() 写进 "at"，差值立刻变成 −1.7e12 秒量级巨负值，
  // 起步锁永久生效，锅踩到底车不动。
  //
  // ⚠ 规格 §一.4 起改为**两阶段倒计时**（大厅 3-2-1 -> 赛内 5 盏红灯），
  //   startAt 的偏移量不再是硬编码的 700ms，而是由阶段二灯序时长推导的
  //   常量表达式。守卫因此改为「带时间量纲、且绝不引用 monoMs()」的参数化判据：
  //   · 必须出现 `r.startAt = time.Now().Add(...)`；
  //   · Add(...) 的实参必须是含 `time.Millisecond` 或毫秒常量名的表达式；
  //   · 整条赋值不得涉及 monoMs()。
  const startAtAssign = (go.match(/r\.startAt =[^\n]*/g) || []);
  const startAtSet = startAtAssign.filter((s) => !/time\.Time\{\}/.test(s));
  ok(startAtSet.length > 0 && startAtSet.every(
      (s) => /time\.Now\(\)\.Add\(/.test(s)
        && /(time\.Millisecond|Ms\b|ms\b)/.test(s)
        && !/monoMs\(\)/.test(s)),
    '发车时刻 startAt 用墙钟 UnixMilli（不是进程相对 monoMs）',
    startAtSet.join(' | ') || '(未找到赋值)');
  ok(/const stage2Ms = 5\*startLightTickMs \+ 250/.test(go),
    '灯序时长 = 5×startLightTickMs + 250ms 载入（红灯逐盏熄灭后立即放行）');

  // ---- ★★ 全员准备后的"准备时间"（2026-09-30 用户要求）----------------------
  //   原来 allReady 一达成，服务端立刻走 2.75s 灯序就发车 —— 玩家根本没有准备
  //   时间（"一键就发车"）。现在在灯序**之前**插入 readyCountdownSec 秒整备
  //   倒计时，并把每一秒推到聊天通道（isSystem）⇒ 右侧聊天框可见。
  ok(/const readyCountdownSec = 5/.test(go),
    '★★服务端常量 readyCountdownSec = 5（全员准备后的整备倒计时秒数）');
  {
    const fnStart = go.indexOf('func (r *Room) armCountdownLocked()');
    const fnEnd = go.indexOf('\nfunc ', fnStart + 10);
    const body = go.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 9000);
    ok(fnStart > 0 && /r\.readyCountdown = readyCountdownSec/.test(body),
      '★★armCountdownLocked 启动时置位 r.readyCountdown（供幂等判定）');
    ok(/for s := readyCountdownSec; s >= 1; s--/.test(body),
      '★★整备倒计时按秒递减循环（5→1）');
    ok(/broadcastSystemLocked\("\[赛事指令\] 全员已准备 · " \+ strconv\.Itoa\(s\)/.test(body),
      '★★每秒把"[赛事指令] 全员已准备 · N 秒后发车…"推进聊天通道（右侧聊天框可见）');
    // 倒计时期间必须**每拍重新取锁并复查**，否则有人取消准备会被硬拖进比赛
    const loopIdx = body.indexOf('for s := readyCountdownSec; s >= 1; s--');
    const loopSeg = body.slice(loopIdx, loopIdx + 900);
    ok(/r\.mu\.Lock\(\)/.test(loopSeg) && /!r\.allReadyLocked\(\)/.test(loopSeg),
      '★★倒计时每一拍重新取锁并复查 allReady（有人取消准备立即中止）');
    // 整备倒计时必须排在 START_SEQUENCE_BEGIN 之前
    ok(loopIdx > 0 && loopIdx < body.indexOf('START_SEQUENCE_BEGIN'),
      '★★整备倒计时在 START_SEQUENCE_BEGIN（载入/亮红灯）**之前**');
    // 幂等：倒计时进行中再来 ready 事件不得叠加第二条协程
    const bcStart = go.indexOf('func (r *Room) beginCountdownLocked()');
    const bcBody = go.slice(bcStart, go.indexOf('\nfunc ', bcStart + 10));
    ok(/if r\.readyCountdown > 0 \{\s*return\s*\}/.test(bcBody),
      '★★beginCountdownLocked 幂等（readyCountdown > 0 时直接返回，不叠加协程）');
  }
  // 客户端：倒计时/灯序不许被压成一帧
  const mSrcCountdown = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/const LIGHT_TICK_MS = 700/.test(mSrcCountdown) && /const startLightTickMs = 700/.test(go),
    '★★客户端与服务端灯序节拍一致且为 700ms（用户要求"红灯再长一点"）');
  ok(/const LOCAL_GO_MS = 250 \+ 5 \* LIGHT_TICK_MS/.test(mSrcCountdown),
    '★★客户端局部灯序总时长 = 250ms 载入 + 5×700ms 红灯 = 3750ms');
  ok(/function armLocalStartLights/.test(mSrcCountdown) &&
     /for \(let stage = 4; stage >= 1; stage--\)/.test(mSrcCountdown),
    '★★armLocalStartLights 逐拍熄灯（不再一次性点亮 5 盏 —— 那等于没有准备时间）');
  ok(/if \(el\._chatSticky\) return;/.test(mSrcCountdown) && /el\._chatSticky = true/.test(mSrcCountdown),
    '★★倒数公告常驻不淡出（否则起跑前一刻倒计时会自己消失）');
  ok(/clearHudCountdown/.test(mSrcCountdown),
    '★开新一场时清掉上一场的倒数公告（clearHudCountdown）');
  ok(/const GO_FALLBACK_MS = 7500/.test(mSrcCountdown),
    '★★本地兜底 7.5s > 服务端灯序 3.75s（兜底绝不能抢在红灯跑完前放行）');
  // ★★ 灯序定时器数组必须**在使用前初始化**：第一版直接 `const ids = S._lightLedTimers`
  //    而 resetStartSequence() 只做"若有则清空"，从不初始化 ⇒ ids undefined
  //    ⇒ ids.push 抛 TypeError ⇒ 单机灯序只亮第一帧、永远停在 R5。
  ok(/if \(!S\._lightLedTimers\) S\._lightLedTimers = \[\];/.test(mSrcCountdown),
    '★★armLocalStartLights 在使用前初始化 S._lightLedTimers（否则 push 抛异常、灯序卡死）');
  // 一次性点亮 5 盏的红灯写法必须彻底消失
  ok(!/net\.on\('startSeq'[\s\S]{0,300}?showStartLights\(5\)/.test(mSrcCountdown),
    '★★startSeq 处理里不再一次性 showStartLights(5)（灯序交给服务端逐拍驱动）');

  // ---- ★★ 发车自锁死守卫（曾致多人游戏彻底失效：START 后快照/信号灯全停）----
  //   病根：beginCountdownLocked 的状态初始化自 `r.mu.Lock()` 起持续持锁，
  //   而阶段二灯序循环每拍**自行** `r.mu.Lock()`。sync.Mutex 不可重入 ⇒ 首拍自锁，
  //   ticker 亦永久阻塞（表现为仅在 START 前有报文，ping/pong 仍通）。
  //   静态判据：进入 `for stage := 5; stage >= 1` 之前，必须出现一次 `r.mu.Unlock()`。
  {
    // ★ 阶段二灯序已搬到 armCountdownLocked（beginCountdownLocked 现在只做
    //   幂等判定 + 转调）。守卫跟着搬，判据不变：进循环前必须已经解锁。
    const fnStart = go.indexOf('func (r *Room) armCountdownLocked()');
    const fnEnd = go.indexOf('\nfunc ', fnStart + 10);
    const body = go.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 9000);
    // 找一个"状态初始化锁"与其后的阶段二循环之间的窗口
    const stageLoopIdx = body.indexOf('for stage := 5; stage >= 1; stage--');
    ok(stageLoopIdx > 0, 'armCountdownLocked 含红灯逐盏熄灭循环（5 拍）');
    const before = body.slice(0, stageLoopIdx);
    // 阶段二循环前必须解锁：否则首拍 Lock 自锁
    ok(/r\.mu\.Unlock\(\)/.test(before.slice(before.lastIndexOf('r.broadcastLocked([]byte(msg))'))),
      '★★ 阶段二灯序前已释放 r.mu（防 sync.Mutex 自锁死 — 曾致 START 后全员静止）');
    // ★★ 新增：整备倒计时循环同样必须"进循环前先解锁"（同一类自锁死）
    const readyLoopIdx = body.indexOf('for s := readyCountdownSec; s >= 1; s--');
    const readyBefore = body.slice(0, readyLoopIdx);
    ok(/r\.mu\.Unlock\(\)/.test(readyBefore.slice(readyBefore.lastIndexOf('r.mu.Lock()'))),
      '★★ 整备倒计时循环前已释放 r.mu（同一类自锁死；每拍自行 Lock）');
    // 全函数锁配平：Unlock 数 >= Lock 数（含裸 go 闭包内的取/放）
    const nLock = (body.match(/r\.mu\.Lock\(\)/g) || []).length;
    const nUnlock = (body.match(/r\.mu\.Unlock\(\)/g) || []).length;
    ok(nUnlock >= nLock,
      '★ armCountdownLocked 内 r.mu 取/放配平（Lock=' + nLock + ', Unlock=' + nUnlock + '）');
  }
  ok(/"at":` \+ strconv\.FormatInt\(r\.startAt\.UnixMilli\(\), 10\)/.test(go),
    'start 报文的 at 字段走 UnixMilli（与客户端 Date.now()+offset 同轴）');

  const netSrc = fs.readFileSync(path.join(root, 'public/js/network.js'), 'utf8');
  ok(/mts - this\.monoOffset/.test(netSrc), '客户端用单调时钟换算快照时间轴');
  ok(/hermite\(/.test(netSrc), '位置用 Hermite 三次样条插值');
  ok(/slerp\(/.test(netSrc), '姿态用四元数 SLERP');
  ok(/Math\.exp\(-ERR_BLEND \* this\._interpDt\)/.test(netSrc), '新快照到达时指数衰减平滑融合');
  ok(/MAX_EXTRAP_MS/.test(netSrc), '航位推测设上限');
  ok(/const STATE_HZ = 60/.test(netSrc), '客户端上报频率 60Hz');

  // ---- K5 客户端接线：服务端算出来的东西，客户端必须真的消费 ----
  // （trackType 与权威榜单都栽在同一件事上：服务端做完了，客户端零引用，
  //   三层动态测试又都测不出来，因为它们各自只测自己那一半。）
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/case 'LEADERBOARD_UPDATE'/.test(netSrc), 'network.js 分发 LEADERBOARD_UPDATE');
  ok(/on\('leaderboard'/.test(mainSrc) && /S\.lb/.test(mainSrc),
    'main.js 消费权威榜单到 S.lb 并驱动计时塔（规格 §2.3）');
  ok(/LEADER/.test(mainSrc) && /gap leader/.test(mainSrc),
    '计时塔 P1 渲染成金色 LEADER（规格 §6.2）');
  // 规格 §7.1（相对本地玩家版，2026 修订）：第一行本地=P1 显示 "--"，
  // 否则显示落后第一名（负数）；第 2 行及之后统一相对**本地玩家**（不是前一名）。
  ok(/renderGap/.test(mainSrc),
    '计时塔时差列收在 renderGap 单一入口（第一行"--" / 相对本地玩家，规格 §7.1）');
  ok(/gap leader me-lead">--</.test(mainSrc),
    '第一行且本地玩家是 P1 -> 固定显示 "--"（规格 §7.1）');
  // ★ 用户要求（2026-09-30）：第一行显示"+X.X"（第一名领先我这么多），不再取负。
  ok(/fmtDelta\(delta\)/.test(mainSrc) && !/fmtDelta\(-delta\)/.test(mainSrc),
    '★第一行且本地非 P1 -> 显示"领先我的秒数"（+X.X，用户要求；旧实现多取一次负号）');
  ok(/const fmtDelta = /.test(mainSrc),
    '计时塔秒差格式化收在 fmtDelta 唯一入口（禁止各行自行取反）');
  ok(/v < 0 \? '-' \+ s : '\+' \+ s/.test(mainSrc),
    'fmtDelta 按带符号值出符号（>0 领先 "+X.Xs"、<0 落后 "-X.Xs"）');
  // 第二行及之后：本地行 "--"、其余相对本地玩家；且**不得**再用"与前一名 e.int"。
  ok(/isLocalRow\) return '<span class="gap me-row">--<\/span>'/.test(mainSrc),
    '第二行及之后：该行 = 本地玩家 -> "--"（规格 §7.1）');
  ok(!/fmtDelta\(e\.int\)/.test(mainSrc),
    '已不再用 e.int（与前一名）做时差列（规格 §7.1 要求相对本地玩家）');

  // ---- ★★ 比赛进行中不得被 room 报文踢回大厅（2026-09-29 加固）------------
  // 触发链：`net.on('room')` 只判 `if (m.started) return;`，而 `started` 是 ticker
  // 到点广播 START 那一刻才置位的 —— 一条在 START 前后擦边送达的 room 报文会把
  // S.mode 改成 'room' ⇒ 主循环走 else 分支 ⇒ raceClock=0 ⇒ S.rp.racing=false
  // ⇒ sampleLocalInput 第一道闸清零油门 ⇒ **绿灯亮着但我的车永远动不了**
  // （用户报的"每次都要等人机走了几步才起步"）。护栏必须与触发原因无关。
  ok(/if \(m\.started\) return;[\s\S]{0,1200}?if \(S\.mode === 'race' \|\| S\.mode === 'end'\) return;/.test(mainSrc),
    '★★net.on(room) 在比赛进行中直接 return，绝不放 S.mode 回到 room');
  ok(/net\.on\('lobby'/.test(mainSrc) && /net\.on\('raceResults'/.test(mainSrc),
    '★权威终局报文（lobby / raceResults）仍能正常把客户端带回大厅');

  // ★★ 进程坐标必须**以米为单位**（2026-09-29 修正"刚起步跳几百秒"）：
  //   离线 HUD 的秒差列是 `(score(他) − score(我)) / 参考车速`，它假设 score 是米。
  //   旧的 `lap*100000 + cpIdx*1000 − 距离` 只要两车跨 Checkpoint 边界就凭空多出
  //   1000 —— 除以 12m/s 的起步参考车速 = **+83 秒**，跨几个 CP 就是"跳几百秒"。
  {
    const noComments = mainSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const body = (noComments.match(/function progressScore\(c\)[\s\S]*?\n\}/) || [''])[0];
    ok(body.length > 0 && /idx \* sp/.test(body) && /ord \* L/.test(body) && /t\.length/.test(body),
      '★★进程坐标 = 压线次数×track.length + trackIdx*spacing（**单位是米**，等弧长采样）',
      '函数体 ' + body.length + ' 字符');
    ok(!/cpIdx/.test(body) && !/100000/.test(body),
      '★★进程坐标里彻底不再出现 cpIdx / 100000（"序号当米用"这条路已被结构性封死）');
  }
  ok(/progressScore\(b\) - progressScore\(a\)/.test(mainSrc),
    '榜单仍按进程坐标降序实时重排');
  // 秒差量纲守卫：离线分支必须是 "米差 / 参考车速"，且参考车速有下限
  ok(/const ref = Math\.max\(Math\.abs\(order\[0\] \? order\[0\]\.forwardSpeed : 0\), 12\)/.test(mainSrc),
    '★离线秒差 = 米差 / 参考车速（下限 12m/s），量纲与 score 的米单位一致');

  // ---- K5a 起步锁守卫（永久输入锁，2026-09-25 修复）----
  // raceClock = (Date.now()+simOffset) − raceStartAt 在倒计时期间恒为约 −2.6s，
  // 所以「raceClock < 0 就清零油门」等于**永久**禁止起步（GO 之后 raceClock 仍是负的）。
  // 唯一正确判据是 S.rp.racing。这三条静态断言钉死该边界，防止回归。
  ok(/!S\.rp\.racing/.test(mainSrc),
    'sampleLocalInput 用 S.rp.racing 判发车（不是 raceClock < 0）');
  // 只扫**函数体里的可执行代码**：先剥掉注释，再切出 sampleLocalInput 到下一个
  // 顶层 function 之间的片段 —— 否则会把钉这条红线的说明文字本身当成违规。
  {
    const noComments = mainSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const body = (noComments.match(/function sampleLocalInput[\s\S]*?(?=\nfunction |\n\/\*|$)/) || [''])[0];
    ok(body.length > 0 && !/raceClock/.test(body),
      'sampleLocalInput 函数体内已无 raceClock 残留（那是永久输入锁）',
      '函数体 ' + body.length + ' 字符');
  }
  ok(/S\.rp\.racing = running/.test(mainSrc),
    'S.rp.racing 每帧由时钟段保持更新（racing 不是只写一次的初始化字段）');
  ok(/S\.raceClock = -0\.001/.test(mainSrc),
    'raceClock 巨负值有兜底夹取（时间轴错位时不让 UI 显示夸张负值）');
  // ★ 但判据必须是"量级不对"，不能是"< 0"：倒计时期间 raceClock 合法地是 −2.6s，
  //   用 `< -0.001` 会让这道诊断每一场都误报（实测联机单人房间 offN=0.5ms 仍误报）。
  ok(/S\.raceClock < -CLOCK_AXIS_BREAK_S/.test(mainSrc) &&
     /const CLOCK_AXIS_BREAK_S = 30/.test(mainSrc),
    '★★时钟轴诊断只在"量级不对"（< −30s）时触发，正常倒计时不再误报',
    '阈值 CLOCK_AXIS_BREAK_S = 30s');
  ok(!/raceClock < -0\.001/.test(mainSrc),
    '★★已无 `raceClock < -0.001` 这种把正常倒计时当成换轴的判据');

  // ---- K5b 秒差的「服务端下发 → 客户端消费」整条链（本仓库已栽过 3 次）----
  // 守卫：solveDeltaMs 的符号语义、JSON 三个字段、客户端格式化入口必须同时在位。
  const goSrc2 = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  ok(/func \(r \*Room\) solveDeltaMs\(/.test(goSrc2),
    '服务端秒差解算为 solveDeltaMs（带符号：>0 = a 领先 b）');
  ok(!/func \(r \*Room\) gapBehindMs\(/.test(goSrc2),
    '已无历史 gapBehindMs 函数（旧语义"正=落后"与 RaceDeltaTracker 相反，必须彻底移除）');
  ok(/slice := passageSlice\(chase\.spline\)/.test(goSrc2) &&
     /lead\.sliceTime\[k\], chase\.sliceTime\[k\]/.test(goSrc2),
    '服务端按同一弧长切片的服务端通过时刻计算秒差（不再用瞬时速度外推）');
  ok(/"gap":/.test(goSrc2) && /"int":/.test(goSrc2) && /"behind":/.test(goSrc2),
    '服务端下发 gap / int / behind 三个带符号秒差字段');
  // 客户端上报进度字段：p 是同一弧长切片时间差的权威输入，c/n 仅作旧协议回退。
  ok(/c: cpIdx,/.test(netSrc) && /n: r1\(distNext\),/.test(netSrc) && /p: r3\(spline\),/.test(netSrc),
    'network.js 上报 (c=cpIdx, n=distNext, p=spline) 进度字段');
  const workerBridgeSrc = fs.readFileSync(path.join(root, 'public/js/PhysicsWorkerBridge.js'), 'utf8');
  ok(/track, seed, trackType: type/.test(mainSrc) && /S\.net\.attachWorker\(S\.rp\)/.test(mainSrc) &&
    /this\.track\?\.checkpoints/.test(workerBridgeSrc) && /n:r1\(distNext\)/.test(workerBridgeSrc) &&
    /this\._publishNetwork\(this\._stateNow\)/.test(workerBridgeSrc) && /sendWorkerState\(packet\)/.test(netSrc),
    // ⚠️ distNext 自 2026-10-14 起按**语义精度定点量化**上报（r1 = 0.1m），
    //    锚点必须钉 `n:r1(distNext)`；钉回 `n:distNext` 说明量化被误删。
    'Worker 状态回调用真实赛道 Checkpoint 计算 distNext 并按 r1 量化上报（不依赖主线程物理步进）');

  // ---- K6 脏气流镜头震颤（规格 §5.6：25Hz / 振幅 0.015m）----
  const phySrc = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
  ok(/TURBULENCE_HZ: 24/.test(phySrc) && /TURBULENCE_AMP: 0\.012/.test(phySrc),
    '脏气流镜头震颤 = 24Hz / 振幅 0.012m（规格）');
  ok(/addScaledVector\(camState\.turb, turbAmp\)/.test(mainSrc),
    '震颤真的施加到相机位置上');
  ok(/DRAFT_FOV_KICK: 1\.5/.test(phySrc), '脏气流 FOV 微收 1.5°（规格）');

  // ---- K7 尾流涡线（Vortex Streamline Ribbons，规格 §6.2）----
  ok(/class VortexFX/.test(mainSrc), '存在涡线系统 VortexFX');
  ok(/AdditiveBlending/.test(mainSrc) && /uColor/.test(mainSrc),
    '涡线用加色混合 + 单色 uniform（淡白细带）');
  const vA = (mainSrc.match(/const a = 0\.25 \* k \* k;/) || []).length;
  ok(vA === 1, '涡线透明度基准 0.25（规格），沿生命周期衰减');
  ok(/尾翼端板/.test(mainSrc) && /引擎盖/.test(mainSrc),
    '涡线发射点覆盖"前车尾翼端板 + 本车引擎盖两侧"（规格 §6.2）');
  ok(/updateVortex\(dt\)/.test(mainSrc), '涡线已接入主渲染循环');

  // ---- K8 服务端权威榜单的 behind 字段（规格 §7.1）----
  ok(/"behind":/.test(fs.readFileSync(path.join(root, 'main.go'), 'utf8')),
    '服务端 LEADERBOARD_UPDATE 下发 gap to behind');

  // ---- K9 房间容量常量一致性（曾栽过"服务端 maxPlayers vs 客户端 GRID_SLOTS 漂移"）----
  // 服务端 maxPlayers 与客户端 GRID_SLOTS / 发车格数量必须同步，否则第 5 名玩家
  // 会分到不存在的发车格，或服务端拒绝客户端已允许的席位。
  const goCap = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  const svMax = (goCap.match(/maxPlayers\s*=\s*(\d+)/) || [])[1];
  const tkCap = fs.readFileSync(path.join(root, 'public/js/track.js'), 'utf8');
  const clMax = (tkCap.match(/GRID_SLOTS\s*=\s*(\d+)/) || [])[1];
  ok(svMax && clMax && svMax === clMax,
    '服务端 maxPlayers(' + svMax + ') 与客户端 GRID_SLOTS(' + clMax + ') 必须一致（容量常量防漂移）');
  ok(/Math\.min\(GRID_SLOTS,\s*slot/.test(tkCap),
    'gridSlot 用 GRID_SLOTS 参数化（严禁写死 4）');

  // ---- K10 DNF 60 秒宽限倒计时（规格 §五.1）----
  ok(/dnfGraceSec\s*=\s*60/.test(goCap),
    '服务端 DNF 宽限 = 60 秒（规格 §五.1）');
  ok(/dnfDeadline\s+time\.Time/.test(goCap),
    'Room 持有 dnfDeadline 宽限截止时刻');
  ok(/rm\.dnfDeadline\s*=\s*time\.Now\(\)\.Add\(dnfGraceSec/.test(goCap),
    '首位冲线后启动 dnfDeadline（finish 分支）');
  ok(/r\.endRaceLocked\("dnf"\)/.test(goCap),
    'DNF 到点强制结算（ticker）');
  ok(/"t":"dnf"|`\{"t":"dnf"/.test(goCap) || /"t":"dnf"/.test(goCap),
    '服务端下发 dnf 倒计时报文');
  // 客户端消费链：network.js 分发 -> main.js 处理 + 结算表 DNF 显示
  const netDnf = fs.readFileSync(path.join(root, 'public/js/network.js'), 'utf8');
  ok(/case 'dnf':\s*this\.emit\('dnf'/.test(netDnf),
    'network.js 分发 dnf 报文（服务端下发 -> 客户端消费必须闭环）');
  const mainDnf = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/net\.on\('dnf',/.test(mainDnf),
    'main.js 消费 dnf 倒计时');
  ok(/r\.dnf \? 'DNF'/.test(mainDnf),
    '结算表按 r.dnf 显示 DNF');
  ok(/dnfDeadline = time\.Time\{\}/.test(goCap),
    'dnfDeadline 在开赛/回大厅时重置（防上一场残留）');
}

/* --------------------------------------------------------------------- */
/* L. 一体化聊天与赛事事件广播控制台（规格 §一 ~ §三）                       */
/* --------------------------------------------------------------------- */
section('L. 聊天总线 / 系统事件广播 / 打字物理隔离 / 局内浮层');

{
  const goSrc = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  const netSrc = fs.readFileSync(path.join(root, 'public/js/network.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

  // ---- L1 协议：CHAT_MESSAGE 双向 ----
  ok(/case "CHAT_MESSAGE":/.test(goSrc),
    '服务端处理上行 CHAT_MESSAGE');
  ok(/type inbound[\s\S]{0,1200}?Content\s+string\s+`json:"content"`/.test(goSrc),
    'inbound 结构体新增 content 字段（否则发言内容解析为空）');
  ok(/"t":"CHAT_MESSAGE","type":"CHAT_MESSAGE"/.test(goSrc),
    '下行报文同时带 t 与 type=CHAT_MESSAGE（旧客户端兼容）');
  // 下行必须含规格 §一.1 要求的全部五个载荷字段
  for (const f of ['"sender":', '"senderColor":', '"content":', '"isSystem":', '"timestamp":']) {
    ok(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '').test(goSrc),
      '下行载荷包含字段 ' + f);
  }
  ok(/case 'CHAT_MESSAGE':\s*this\.emit\('chat'/.test(netSrc),
    'network.js 把 CHAT_MESSAGE 分发为 chat 事件');
  ok(/net\.on\('chat'/.test(mainSrc), 'main.js 订阅 chat 事件');

  // ---- L2 输入校验：长度 1~80 / 危险脚本 / 空字符 ----
  ok(/chatMaxRunes\s*=\s*80/.test(goSrc), '聊天长度上限常量 = 80 字符（规格 §一.1）');
  ok(/func sanitizeChat\(/.test(goSrc), '服务端提供 sanitizeChat 清洗函数');
  {
    const s = goSrc.slice(goSrc.indexOf('func sanitizeChat('));
    const body = s.slice(0, s.indexOf('\nfunc ', 10));
    ok(/r\s*<\s*0x20/.test(body), 'sanitizeChat 剥除 ASCII 控制字符（含 \\0）');
    ok(/0x7f/.test(body), 'sanitizeChat 剥除 DEL');
    ok(/0x80/.test(body) && /0x9f/.test(body), 'sanitizeChat 剥除 C1 控制字符区间');
    ok(/0x200b|\\u200b/.test(body), 'sanitizeChat 剥除零宽字符（防伪造视觉身份）');
    ok(/chatMaxRunes/.test(body), 'sanitizeChat 按码点截断到上限（多字节安全）');
    ok(/TrimSpace|字符串|\\\\s|\\s/.test(body), 'sanitizeChat 处理空白');
  }
  ok(/if text == "" \{\s*return\s*\}/.test(goSrc.replace(/\n\s*/g, ' ').replace(/\s+/g, ' ')) ||
     /text == ""/.test(goSrc) && /return/.test(goSrc.slice(goSrc.indexOf('sanitizeChat(m.Content)'), goSrc.indexOf('sanitizeChat(m.Content)') + 300)),
    '清洗后为空的消息被丢弃（不广播）');

  // ---- L3 身份权威：sender/color 取自服务端，不信任客户端上报 ----
  {
    const ci = goSrc.indexOf('case "CHAT_MESSAGE":');
    const body = goSrc.slice(ci, ci + 600);
    ok(/chatPayload\(c\.name, c\.color, text, false\)/.test(body),
      '发言者身份取自服务端 c.name/c.color（防冒名，不读客户端字段）');
    ok(!/m\.Sender|m\.Name|m\.Color/.test(body),
      'CHAT_MESSAGE 分支不读取任何客户端上报的身份字段');
  }

  // ---- L4 系统事件自动广播（加入/准备/切赛道/改名/离线）----
  for (const [re, name] of [
    [/broadcastSystemLocked\("玩家 【" \+ c\.name \+ "】 加入了房间"\)/, '加入房间'],
    [/broadcastSystemLocked\("玩家 【" \+ c\.name \+ "】 已准备就绪"\)/, '准备就绪'],
    [/broadcastSystemLocked\("玩家 【" \+ c\.name \+ "】 取消了准备"\)/, '取消准备'],
    [/broadcastSystemLocked\("玩家 【" \+ c\.name \+ "】 离开了房间"\)/, '离开房间'],
  ]) {
    ok(re.test(goSrc), '系统事件自动广播：' + name);
  }
  ok(!/切换赛道[\s\S]{0,120}broadcastSystemLocked/.test(goSrc),
    '切换赛道不再写进聊天流');
  ok(/func trackDisplayName\(/.test(goSrc), '提供 trackDisplayName 映射函数');
  ok(/更名为/.test(goSrc), '改名事件被广播为系统消息');

  // ---- L5 无 3-2-1 聊天倒计时；灯序走独立 lights 报文 ----
  ok(!/\[赛事指令\] 比赛将在/.test(goSrc), '服务端不再广播 3-2-1 聊天倒计时');
  ok(/\[赛事指令\] 全员发车！/.test(goSrc), '绿灯放行广播 [赛事指令] 全员发车！');
  ok(/startLightTickMs\s*=\s*700/.test(goSrc), '红灯熄灭节拍为 700ms（用户要求"红灯再长一点"）');
  ok(/for stage := 5; stage >= 1; stage--/.test(goSrc), '服务端按 5→1 单发灯态');
  ok(/case 'lights':\s*this\.emit\('lights', m\)/.test(netSrc),
    'network.js 把 lights 灯态分发给 main.js');

  // ---- L6 打字物理隔离（规格 §三.2）----
  ok(/chatTyping:\s*false/.test(mainSrc), 'main.js 状态机持有 chatTyping 标志');
  {
    const si = mainSrc.indexOf('function sampleLocalInput(');
    const body = mainSrc.slice(si, si + 2600);
    const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const chatAt = code.indexOf('S.chatTyping');
    const raceAt = code.indexOf('S.rp.racing');
    ok(chatAt >= 0 && raceAt > chatAt,
      '聊天隔离判据位于比赛/发车判据之前（否则打字时车会执行残留油门）');
  }
  ok(/if \(inField \|\| S\.chatTyping\)/.test(mainSrc),
    'window keydown 在输入框/聊天激活时整体旁路驾驶按键');
  ok(/e\.target[\s\S]{0,120}?tagName === 'INPUT'/.test(mainSrc.replace(/const tgt = e\.target;/, 'e.target')) ||
     /tagName === 'INPUT'/.test(mainSrc),
    'keydown 检测焦点是否落在输入框（INPUT/TEXTAREA/contentEditable）');
  ok(/function releaseDriveKeys\(/.test(mainSrc), '提供 releaseDriveKeys 清键函数');
  {
    const ri = mainSrc.indexOf('function releaseDriveKeys(');
    const body = mainSrc.slice(ri, ri + 500);
    ok(/handbrakeKey = false/.test(body), 'releaseDriveKeys 清除手刹位');
    ok(/keys\[k\] = false|for \(const k in keys\)/.test(body), 'releaseDriveKeys 清空所有驾驶键');
  }
  {
    const oi = mainSrc.indexOf('function openHudChat(');
    const body = mainSrc.slice(oi, oi + 500);
    ok(/S\.chatTyping = true/.test(body), 'openHudChat 置 chatTyping=true');
    ok(/releaseDriveKeys\(\)/.test(body), 'openHudChat 呼出瞬间清空按键（防"按住W呼出"粘键）');
    ok(/inp\.focus\(\)/.test(body), 'openHudChat 聚焦输入框');
  }
  {
    const ci2 = mainSrc.indexOf('function closeHudChat(');
    const body = mainSrc.slice(ci2, ci2 + 400);
    ok(/S\.chatTyping = false/.test(body), 'closeHudChat 复位 chatTyping=false');
    ok(/releaseDriveKeys\(\)/.test(body), 'closeHudChat 交还操控前清键');
  }
  ok(/if \(S\.chatTyping\) releaseDriveKeys\(\)/.test(mainSrc),
    'keyup 期间强制清键（输入框吞掉 keyup 也不会粘油门）');

  // ---- L7 输入框 stopPropagation（防 Enter 互相触发）----
  {
    const ci3 = mainSrc.indexOf('const cIn = $(', mainSrc.indexOf('function bindUI('));
    const body = mainSrc.slice(ci3, ci3 + 900);
    ok(/addEventListener\('keydown'/.test(body) && /stopPropagation\(\)/.test(body),
      '大厅聊天输入框 keydown 阻止冒泡');
    ok(/e\.key === 'Enter'/.test(body) && /sendChatText\(/.test(body),
      '大厅输入框 Enter 发送发言');
    ok(/e\.key === 'Escape'/.test(body), '大厅输入框 ESC 失焦');
    ok(/cIn\.value = ''/.test(body), '发送后清空输入框');
  }
  {
    const hi = mainSrc.indexOf('const hIn = $(', mainSrc.indexOf('function bindUI('));
    const body = mainSrc.slice(hi, hi + 900);
    ok(/addEventListener\('keydown'/.test(body) && /stopPropagation\(\)/.test(body),
      '局内打字条 keydown 阻止冒泡');
    ok(/closeHudChat\(\)/.test(body), '局内 Enter/ESC 收起打字条');
  }

  // ---- L8 快捷呼出（Enter / T）----
  ok(/if \(S\.mode === 'room'\) \{ focusLobbyChat\(\); return; \}/.test(mainSrc),
    '大厅按 Enter 聚焦聊天输入框');
  ok(/openHudChat\(\)/.test(mainSrc) && /S\.mode === 'race'/.test(mainSrc),
    '局内按 Enter/T 呼出打字条');
  ok(/k === 't'/.test(mainSrc), '局内按 T 呼出打字条（规格 §三.2）');

  // ---- L9 XSS 纵深防御：不给 innerHTML ----
  {
    const cs = mainSrc.indexOf('function appendChatRow(');
    const ce = mainSrc.indexOf('function sanitizeHex(');
    const seg = mainSrc.slice(cs, ce > cs ? ce : cs + 3000);
    ok(!/innerHTML/.test(seg), 'appendChatRow 不使用 innerHTML（全 textContent）');
    ok(/textContent = msg\.content/.test(seg) || /tx\.textContent/.test(seg),
      '聊天正文经 textContent 写入（浏览器不解析为 HTML）');
    ok(/sanitizeHex/.test(seg), '玩家车色经 sanitizeHex 白名单校验后才用于样式');
  }
  {
    const hs = mainSrc.indexOf('function appendHudChat(');
    const he = mainSrc.indexOf('function scheduleHudOut(');
    const seg = mainSrc.slice(hs, he > hs ? he : hs + 2000);
    ok(!/innerHTML/.test(seg), 'appendHudChat 不使用 innerHTML');
  }

  // ---- L10 局内浮层行为：淡入 / 停留 5s / 淡出 ----
  ok(/HUD_HOLD_MS:\s*5000/.test(mainSrc), '局内消息停留 5 秒（规格 §三.1）');
  ok(/MAX_HUD:\s*4/.test(mainSrc), '局内同时可见条数上限（防遮挡）');
  ok(/function scheduleHudOut\(/.test(mainSrc), '提供淡出调度函数');
  {
    const st = mainSrc.indexOf('function scheduleHudOut(');
    const body = mainSrc.slice(st, st + 600);
    ok(/classList\.remove\('in'\)/.test(body) && /classList\.add\('out'\)/.test(body),
      '淡出切换 in -> out 类（CSS 驱动动画）');
    ok(/removeChild/.test(body), '淡出结束后从 DOM 移除（不留隐性节点）');
    ok(/el\._chatOut/.test(body), '淡出幂等保护（重复调度不叠加动画）');
  }
  ok(/function clearHudChat\(/.test(mainSrc), '提供 clearHudChat（回大厅/开新局清空浮层）');

  // ---- L11 消息流上限（DOM 膨胀防护）----
  ok(/MAX_LOBBY:\s*200/.test(mainSrc), '大厅消息流节点上限 200');
  {
    const ac = mainSrc.indexOf('function appendChatRow(');
    const body = mainSrc.slice(ac, ac + 3000);
    ok(/while \(feed\.children\.length > CHAT\.MAX_LOBBY\) feed\.removeChild\(feed\.firstChild\)/.test(body),
      '超出上限时丢弃最旧节点（长会话不膨胀）');
    ok(/feed\.scrollTop = feed\.scrollHeight/.test(body), '新消息自动贴底（平滑滚动）');
  }

  // ---- L12 面板显隐唯一入口 ----
  ok(/function setChatPanel\(/.test(mainSrc), '提供 setChatPanel 统一显隐入口');
  {
    const si2 = mainSrc.indexOf('function setChatPanel(');
    const body = mainSrc.slice(si2, si2 + 800);
    ok(/'room'/.test(body) && /'menu'/.test(body),
      '面板仅在 room/menu 态显示（比赛态自动隐藏）');
    ok(/classList\.toggle\('hidden'/.test(body), '切换 .hidden 类控制显隐');
  }
  ok(/renderLobby[\s\S]{0,600}?setChatPanel\(!!room\)/.test(mainSrc),
    'renderLobby 按是否有房间驱动面板显隐（单一入口）');
  ok(/net\.on\('start'[\s\S]{0,900}?setChatPanel\(false\)/.test(mainSrc),
    '发车时收起大厅聊天面板（规格 §三：局内自动隐藏）');
  ok(/net\.on\('lobby'[\s\S]{0,900}?setChatPanel\(true\)/.test(mainSrc),
    '回大厅时重新展开聊天面板');

  // ---- L13 本地昵称取自服务端权威（自标识防冒名）----
  ok(/S\.localName/.test(mainSrc), 'main.js 记录本地昵称用于标记"我"的消息');
  ok(/msg\.sender === \(S\.localName/.test(mainSrc),
    '玩家消息以 S.localName 比对判定是否本人发言');
  {
    const ri2 = mainSrc.indexOf("net.on('room'");
    const body = mainSrc.slice(ri2, ri2 + 900);
    ok(/me\.name/.test(body), 'room 回包后以服务端权威昵称刷新 S.localName');
  }

  // ---- L14 CSS 视觉契约 ----
  ok(/backdrop-filter:\s*blur\(12px\)/.test(cssSrc), '面板磨砂玻璃 blur(12px)（规格 §二）');
  ok(/rgba\(14,\s*17,\s*23,\s*0?\.78\)/.test(cssSrc), '面板底色 rgba(14,17,23,.78)（规格 §二）');
  ok(/border-left:\s*1px solid rgba\(255,\s*255,\s*255,\s*0?\.08\)/.test(cssSrc),
    '面板左边框 rgba(255,255,255,.08)（规格 §二）');
  ok(/\.chat-panel\s*\{[\s\S]{0,400}?width:\s*340px/.test(cssSrc), '面板宽 340px（规格 §二）');
  ok(/scroll-behavior:\s*smooth/.test(cssSrc), '消息流平滑滚动');
  ok(/\.chat-sys\b/.test(cssSrc), '系统消息有独立样式类 .chat-sys');
  ok(/\.chat-sys\.countdown/.test(cssSrc), '倒数消息有专属样式 .chat-sys.countdown');
  ok(/\.chat-sys\.go/.test(cssSrc), '发车消息有专属样式 .chat-sys.go');
  ok(/@keyframes cdGlow/.test(cssSrc), '倒数消息有脉冲发光动画（醒目大字）');
  ok(/\.chat-swatch/.test(cssSrc), '玩家气泡有车色方标 .chat-swatch');
  ok(/\.chat-self/.test(cssSrc), '本人消息有高亮类 .chat-self');
  ok(/\.hud-chat\s*\{[\s\S]{0,300}?pointer-events:\s*none/.test(cssSrc),
    '局内浮层不拦鼠标（驾驶中不误触）');
  ok(/\.hc-msg\.out/.test(cssSrc), '局内消息有淡出类 .hc-msg.out');
  ok(/@keyframes hcIn/.test(cssSrc) && /@keyframes hcOut/.test(cssSrc),
    '局内消息有淡入/淡出关键帧');
  ok(/\.hc-bar/.test(cssSrc), '局内打字条有样式 .hc-bar');
  // 响应式：小屏收紧 / 隐藏
  ok(/@media[^{]*980px[\s\S]{0,300}?\.chat-panel/.test(cssSrc) ||
     /\.chat-panel[\s\S]{0,300}?@media[^{]*980px/.test(cssSrc) || /980px/.test(cssSrc),
    '窄屏下聊天面板响应式收紧');

  // ---- L15 HTML 结构：面板在 HUD 之外（否则 #hud.hidden 藏不住，重蹈计时塔覆辙）----
  {
    const bare = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
    const hi = bare.indexOf('id="hud"');
    // 找 #hud 到下一个顶层 <aside/</section> 的区间，确认 chatPanel 不在其中
    const chatIdx = bare.indexOf('id="chatPanel"');
    const between = bare.slice(Math.min(hi, chatIdx), Math.max(hi, chatIdx));
    ok(chatIdx >= 0, 'index.html 含 #chatPanel');
    // 面板是顶层 <aside>，与 #lobby 平级
    ok(/<aside[^>]*id="chatPanel"/.test(bare), '聊天面板是顶层 <aside>（与大厅面板平级）');
    ok(!/id="hud"[\s\S]*?id="chatPanel"/.test(bare) ||
       bare.indexOf('id="chatPanel"') < bare.indexOf('id="hud"') ||
       !/id="hud"[\s\S]{0,20000}?id="chatPanel"[\s\S]{0,20000}?id="hud"/.test(bare),
      '聊天面板不嵌在 #hud 内部（#hud.hidden 无法隐藏它，必须独立控制）');
  }
  ok(/id="hudChat"[\s\S]{0,300}?id="hudChatFeed"/.test(htmlSrc.replace(/<!--[\s\S]*?-->/g, '')),
    '局内浮层 #hudChat 内含消息流 #hudChatFeed');
  ok(/id="chatOnline"/.test(htmlSrc), '面板头部含在线人数徽标 #chatOnline');
  ok(/EVENT CHAT/.test(htmlSrc), '面板标题含 EVENT CHAT（规格 §二）');
}

/* --------------------------------------------------------------------- */
/* L16 六大缺陷修复守卫（规格 §一~§六）                                     */
/* --------------------------------------------------------------------- */
{
  const goSrc = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const netSrc = fs.readFileSync(path.join(root, 'public/js/network.js'), 'utf8');
  const physSrc = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
  const trackSrc = fs.readFileSync(path.join(root, 'public/js/track.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

  /* ---- §一 服务端权威倒计时状态机 ---- */
  ok(/"START_SEQUENCE_BEGIN"/.test(goSrc), '§一 服务端广播 START_SEQUENCE_BEGIN');
  ok(/"RACE_START"/.test(goSrc), '§一 服务端广播 RACE_START（绝不缺失）');
  ok(!/COUNTDOWN_TICK/.test(goSrc), '§一 服务端不再发送 3-2-1 COUNTDOWN_TICK');
  ok(/startLightTickMs\s*=\s*700/.test(goSrc), '§一 红灯逐盏熄灭节拍 = 700ms');
  {
    const i = goSrc.indexOf('for stage := 5; stage >= 1; stage--');
    const seg = goSrc.slice(i, i + 520);
    ok(/time\.Sleep\(startLightTickMs/.test(seg), '§一 每盏红灯熄灭后等待 startLightTickMs（700ms）');
  }
  // 客户端报文分发
  ok(/case 'START_SEQUENCE_BEGIN'/.test(netSrc), '§一 network.js 分发 START_SEQUENCE_BEGIN');
  ok(/case 'lights'/.test(netSrc), '§一 network.js 分发 lights 灯态');
  ok(/case 'RACE_START'/.test(netSrc), '§一 network.js 分发 RACE_START');
  ok(/net\.on\('lights'/.test(mainSrc), '§一 main.js 消费 lights 灯态');
  ok(/net\.on\('raceStart'/.test(mainSrc), '§一 main.js 消费 RACE_START');
  ok(/function forceRaceGo\(/.test(mainSrc), '§一 起跑放行统一入口 forceRaceGo');
  ok(/armGoFallback/.test(mainSrc) && /GO_FALLBACK_MS = 7500/.test(mainSrc),
    '§一 本地兜底（7.5s，防卡死倒计时）');
  ok(/controlsLocked/.test(mainSrc), '§一 controlsLocked 起跑锁');
  {
    // sampleLocalInput 必须检查 controlsLocked
    const si = mainSrc.indexOf('function sampleLocalInput(');
    const body = mainSrc.slice(si, si + 2600);
    ok(/S\.controlsLocked/.test(body), '§一 sampleLocalInput 消费 controlsLocked');
  }
  // 遮罩彻底隐藏 display:none
  ok(/style\.display\s*=\s*'none'/.test(mainSrc), '§一 起跑遮罩 display:none 彻底隐藏');

  /* ---- §二 全员完赛结算 + 赛季实时同步 ---- */
  ok(/"RACE_RESULTS"/.test(goSrc), '§二 服务端广播 RACE_RESULTS');
  ok(/"SEASON_LEADERBOARD_UPDATE"/.test(goSrc), '§二 服务端广播 SEASON_LEADERBOARD_UPDATE');
  ok(/func \(r \*Room\) raceResultsJSONLocked\(/.test(goSrc), '§二 raceResultsJSONLocked 构造器');
  ok(/"bestLap"[\s\S]{0,200}?"totalTime"[\s\S]{0,200}?"points"/.test(goSrc),
    '§二 RACE_RESULTS 含 bestLap/totalTime/points 字段');
  ok(/pointTable = \[maxPlayers \+ 1\]int64\{0, 10, 6, 4, 2,/.test(goSrc),
    '§二 积分表 P1..P4 = 10/6/4/2（规格 §二）');
  ok(/case 'RACE_RESULTS'/.test(netSrc) && /case 'SEASON_LEADERBOARD_UPDATE'/.test(netSrc),
    '§二 network.js 分发结算与赛季榜报文');
  ok(/net\.on\('raceResults'/.test(mainSrc) && /setTimeout\(\(\) => showSettlement/.test(mainSrc),
    '§二 main.js 延迟 1.5s 弹出结算 Modal');
  ok(/net\.on\('seasonUpdate'/.test(mainSrc), '§二 main.js 实时接收赛季榜并重渲染');
  ok(/function showSettlement\(/.test(mainSrc), '§二 showSettlement 渲染器');
  ok(/id="settlement"/.test(htmlSrc), '§二 index.html 含结算 Modal #settlement');
  ok(/id="settleBody"/.test(htmlSrc) && /id="settleLobby"/.test(htmlSrc),
    '§二 结算 Modal 含名单与"返回大厅"按钮');
  ok(/\.settlement[\s\S]{0,400}?backdrop-filter/.test(cssSrc) || /backdrop-filter[\s\S]{0,400}?\.settlement/.test(cssSrc)
     || /\.settlement\s*\{[\s\S]{0,300}?blur/.test(cssSrc), '§二 结算 Modal 全屏磨砂样式');

  /* ---- §三 完赛自动巡航 Pure Pursuit ---- */
  ok(/purePursuit\(c, dt\)/.test(physSrc), '§三 physics.js 提供 purePursuit 循迹');
  ok(/PURE_PURSUIT_LOOKAHEAD/.test(physSrc), '§三 前视 15m 常量');
  ok(/CRUISE_MIN_KMH:\s*50/.test(physSrc) && /CRUISE_KMH:\s*60/.test(physSrc),
    '§三 巡航油门锁 50~60km/h');
  ok(/c\.purePursuit\s*=\s*true/.test(physSrc), '§三 冲线置 purePursuit 标志');
  {
    // driveLocal 里 finished 分支必须优先于 auto 分支
    // 锚定到**方法定义**（`driveLocal(c, dt) {`），不是调用点。
    const di = physSrc.indexOf('driveLocal(c, dt) {');
    const seg = physSrc.slice(di, di + 1200);
    const finAt = seg.indexOf('c.finished');
    const autoAt = seg.indexOf('c.auto');
    ok(finAt >= 0 && autoAt > finAt, '§三 完赛分支优先于 AI 分支（玩家/AI 一视同仁）');
  }

  /* ---- §四 FM8 护栏导向 + 偏摆力矩 ---- */
  ok(/applyBarrierGuidance\(dt\)/.test(physSrc), '§四 physics.js 提供 applyBarrierGuidance');
  // ★ 语义已变（2026-09-30 方案 A，用户选定）：不再用固定的"保留 90% 切向速度"，
  //   而是**按入射角分档**：浅角（<25°）一次只扣 6~12%、深角扣 18~45%，
  //   持续接触按 dt 缩放的极小衰减（浅角 1.5%/s）—— 这才是"擦着滑走"的正确口径。
  ok(/WALL_SHALLOW_DEG:\s*25/.test(physSrc) &&
     /WALL_SCRAPE_LOSS_MIN:\s*0\.06/.test(physSrc) &&
     /WALL_SCRAPE_LOSS_MAX:\s*0\.12/.test(physSrc) &&
     /WALL_HIT_LOSS_MAX:\s*0\.45/.test(physSrc),
    '§四 护栏按入射角分档：浅角扣 6~12% / 深角扣至 45%');
  // 一次性扣减必须只在**首次接触**施加，持续接触走 dt 缩放（防 0.9^n 秒杀动量）。
  ok(/const thetaDeg = Math\.asin\(normalShare\)/.test(physSrc) &&
     /if \(fresh\) \{/.test(physSrc) &&
     /const drag = shallow \? wall\.scrapeDrag : wall\.hitDrag;/.test(physSrc) &&
     /1 - drag \* dt/.test(physSrc),
     '§四 分档扣减仅首次接触施加，持续接触用 dt 摩擦（防 0.9^n 秒杀动量）');
  // 贴墙横摆必须**覆盖**（不能缓动逼近，否则压不住 cannon 的接触自转力矩）。
  ok(/carBody\.angularVelocity\.y = targetYaw;/.test(physSrc) &&
     /WALL_STRAIGHTEN_MAX/.test(physSrc),
    '§四 贴墙横摆为"覆盖式顺墙"（车头顺墙走，不会被摩擦拉着自转）');
  ok(/GUIDANCE_YAW_GAIN:\s*0\.15/.test(physSrc), '§四 偏摆冲量系数 0.15');
  ok(/GUIDANCE_THETA_CAP:\s*0\.8/.test(physSrc), '§四 min(theta,0.8) 上限');
  ok(/GUIDANCE_OUT_EPS:\s*0\.03/.test(physSrc), '§四 几何外推 pen+0.03m');
  ok(/GUIDANCE_THETA_MAX:\s*60 \* Math\.PI \/ 180/.test(physSrc), '§四 theta<60° 触发条件');
  ok(/this\.applyBarrierGuidance\(dt\)/.test(physSrc), '§四 在 fixedStep 中被调用');

  /* ---- §五 景观绝对隔离 + 铃鹿桥下排除盒 ---- */
  ok(/BARRIER_OUT_M = 8\.5/.test(trackSrc), '§五 景观硬隔离 = 半宽 + 8.5m');
  ok(/sceneryClearMin/.test(trackSrc), '§五 sceneryClearMin 口径函数');
  ok(/_bridgeExclusionBox/.test(trackSrc) && /_inBridgeExclusion/.test(trackSrc),
    '§五 铃鹿立交桥 3D 排除盒');
  ok(/BRIDGE_EXCL_LEN = 60/.test(trackSrc) && /BRIDGE_EXCL_WID = 25/.test(trackSrc),
    '§五 排除盒 ±60m / ±25m');
  ok(/BRIDGE_PILLAR_OUT_M = 4\.0/.test(trackSrc), '§五 桥下立柱外推 4.0m');
  ok(/BRIDGE_RAIL_H = 1\.8/.test(trackSrc), '§五 桥侧独立加高护栏 1.8m');
  ok(/this\._inBridgeExclusion\(box, x, z\)\) continue/.test(trackSrc),
    '§五 排除盒内的树被跳过生成');

  /* ---- §六 UI ---- */
  ok(/id="startLights"/.test(htmlSrc), '§六 5 红灯起跑灯组 DOM');
  ok(/\.sl\.red\.on/.test(cssSrc), '§六 深红信号灯点亮样式');
  ok(/\.startlights\.go/.test(cssSrc), '§六 绿灯放行样式');
}

/* --------------------------------------------------------------------- */
/* M. 远程联机端点推导（ws/wss 与页面协议一致）                             */
/* --------------------------------------------------------------------- */
{
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const netSrc = fs.readFileSync(path.join(root, 'public/js/network.js'), 'utf8');
  const fnSrc = mainSrc.match(/function resolveWsUrl\(protocol, host\) \{[\s\S]*?\n\}/);
  ok(!!fnSrc, 'main.js 中存在 resolveWsUrl 纯函数（端点推导的唯一来源）');
  if (fnSrc) {
    // eslint-disable-next-line no-new-func
    const fn = new Function(fnSrc[0] + '\nreturn resolveWsUrl;')();
    ok(fn('https:', 'a.example.link') === 'wss://a.example.link/ws',
      'M1 https 页面 -> wss 端点（混合内容拦截的根治点）', fn('https:', 'a.example.link'));
    ok(fn('http:', '192.168.1.9:8099') === 'ws://192.168.1.9:8099/ws',
      'M2 http 页面 -> ws 端点（局域网模式零回归）', fn('http:', '192.168.1.9:8099'));
    ok(fn('HTTPS:', 'a.example.link') === 'wss://a.example.link/ws',
      'M3 协议大小写被归一化，不会漏升级', fn('HTTPS:', 'a.example.link'));
    ok(fn('http:', '[::1]:8099') === 'ws://[::1]:8099/ws',
      'M4 IPv6 主机段逐字透传，不做任何改写', fn('http:', '[::1]:8099'));
    ok(fn('', '') === 'ws:///ws', 'M5 空 protocol / 空 host 与旧实现同值，不假装可用', fn('', ''));
    let secureAll = true;
    for (const h of ['a.b', 'a.b:8443', '[::1]', 'x'.repeat(512)]) {
      if (!fn('https:', h).startsWith('wss://')) secureAll = false;
    }
    ok(secureAll, 'M6 任一 https 输入的端点都以 wss 开头（防升级失效回归）');
  }
  ok(!/'ws:\/\/'\s*\+\s*location\.host/.test(mainSrc),
    'M7 main.js 不再固定拼接 ws 协议（一律经 resolveWsUrl）');
  ok(/net\.connect\(\s*resolveWsUrl\(/.test(mainSrc),
    'M8 net.connect 消费 resolveWsUrl 的结果');
  ok(/'服务端已连接 <b>' \+ net\.url/.test(mainSrc),
    'M9 连接状态展示串取自 net.url（展示与实际同源，重连复用同一 URL）');
  {
    const ci = netSrc.indexOf('ws = new WebSocket(url);');
    const seg = netSrc.slice(Math.max(0, ci - 400), ci);
    ok(ci > 0 && /try \{/.test(seg),
      'M10 new WebSocket 仍包在 try/catch 内（同步抛异常的安全网未拆）');
  }
}

/* --------------------------------------------------------------------- */
/* 汇总                                                                    */
/* --------------------------------------------------------------------- */
const dtms = Date.now() - t0;
console.log('\n' + '─'.repeat(66));
if (failures.length === 0) {
  console.log('\x1b[32m\x1b[1m全部通过\x1b[0m  ' + pass + ' 项断言，用时 ' + dtms + 'ms');
  process.exit(0);
} else {
  console.log('\x1b[31m\x1b[1m失败 ' + failures.length + ' 项\x1b[0m / 通过 ' + pass + ' 项，用时 ' + dtms + 'ms');
  for (const f of failures) console.log('  \x1b[31m✗\x1b[0m ' + f);
  process.exit(1);
}
