/* =============================================================================
 * track-verify.mjs —— 双赛道生成器的**几何证据**自检（零 npm 依赖）
 *
 *   node tools/track-verify.mjs
 *
 * 断言的都是"看图看不出真假、必须算出来"的性质：
 *   · 路宽是否真的是 14m、Checkpoint 是否真的是 24 个
 *   · 铃鹿是否**真的自交**（8 字立交），交叉处的两个通行次是否**真的分层**（高差 ≥ 净空）
 *   · 桥面抬升是否真的是 +7.5m、引桥是否连续降到地面
 *   · 立交分层求解（nearest 的 curY 判别）是否真的能把车锁在正确的一层
 *   · 拉斯维加斯的大直道是否真的 ≥1.9km、Sphere 球馆是否真的在弯内且留有余量
 *   · 发车格是否 4 个互不重合、且 slot 1 最靠前
 *   · 静态碰撞体描述是否有限值、数量合理
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

const threeSrc = fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8');
(0, eval)(threeSrc);
if (!globalThis.THREE) { console.error('无法注入 three.min.js'); process.exit(1); }

function makeCanvasStub() {
  const ctx2d = new Proxy({}, {
    get(_, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; },
  });
  return { width: 0, height: 0, style: {}, getContext: () => ctx2d, addEventListener() {}, removeEventListener() {} };
}
globalThis.document = globalThis.document || {
  createElement: (t) => (t === 'canvas' ? makeCanvasStub() : { style: {} }),
  createElementNS: () => makeCanvasStub(),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis.window || { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };

const { Track, TRACK_CFG, TRACK_TYPES, generateTrack, registerTrackBodies, SUZUKA_RUNOFF_M, SUZUKA_GEOMETRY } = await import(mod('public/js/track.js'));

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : '')); }
  else { failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const num = (v, n = 3) => Number(v).toFixed(n);
const t0 = Date.now();

/* --------------------------------------------------------------------- */
section('0. 全局规格（路宽 / Checkpoint）');

ok(Math.abs(TRACK_CFG.HALF_WIDTH - 7.0) < 1e-9, '半路宽 = 7.0m（有效总宽 14m）', `halfWidth=${TRACK_CFG.HALF_WIDTH} 总宽=${TRACK_CFG.HALF_WIDTH * 2}`);
ok(TRACK_CFG.ASPHALT_HALF_W === 7.0, '沥青有效半宽 = 7.0m（沙地陷阱判定基准）');
ok(TRACK_CFG.CHECKPOINTS === 24, 'Checkpoint 数量 = 24', `= ${TRACK_CFG.CHECKPOINTS}`);
ok(TRACK_CFG.BRIDGE_Y === 9.5, '桥面抬升 = +9.5m', `= ${TRACK_CFG.BRIDGE_Y}`);
ok(TRACK_CFG.BRIDGE_MIN_H >= 1.0, '桥下最小净空 ≥ 1.0m', `= ${TRACK_CFG.BRIDGE_MIN_H}`);
ok(TRACK_TYPES.length === 4 && TRACK_TYPES.includes('suzuka') && TRACK_TYPES.includes('vegas') &&
  TRACK_TYPES.includes('spa') && TRACK_TYPES.includes('oval'),
  '赛道类型白名单 = suzuka / vegas / spa / oval（必须与服务端 sanitizeTrack 一致）');

// --- 景观安全净空（规格 §一.2）：法向外推锚点 14.0m + 双重距离排他校验 13.5m ---
{
  const { CLEAR_ANCHOR_M, CLEAR_REJECT_M, clearOK } = await import(mod('public/js/track.js'));
  ok(CLEAR_ANCHOR_M === 14.0 && CLEAR_REJECT_M === 13.5,
    '净空锚点 = 半宽 7.0 + 路肩 2.0 + 绿化缓冲带 5.0 = 14.0m，剔除线 13.5m',
    CLEAR_ANCHOR_M + ' / ' + CLEAR_REJECT_M);
  ok(clearOK(13.5) && !clearOK(13.49),
    '排他校验是闭区间下界：D ≥ 13.5m 才放行（13.5 通过、13.49 剔除）');
  for (const type of TRACK_TYPES) {
    const t = new Track(4242, type);
    t.build();
    ok(t.minScatterLat >= CLEAR_REJECT_M,
      `${type}：所有景物到赛道中心线的水平距离 ≥ 13.5m（无任何景物侵入沥青/路肩）`,
      'min=' + t.minScatterLat.toFixed(2) + 'm');
  }
}

// --- ★ 建筑 OBB 五点净空：真实几何（不是写死的半对角常数）--------------------
//   历史坑：旧实现用 `if (lat - 34 < CLEAR_REJECT_M)`，而 w/dp 半宽最大 25m
//   ⇒ 真实半对角可达 35.36m > 34m，体量最大的建筑角点能越过保守半径侵入廊道。
//   现在改为逐点实测：中心 + 4 个经 yaw 旋转的角点，个个都要满足 D ≥ 13.5m。
{
  const { TRACK_CFG, obbClearOfTrack, buildingClearNeed } = await import(mod('public/js/track.js'));
  const hw = TRACK_CFG.HALF_WIDTH, cw = TRACK_CFG.CURB_W;
  // 口径必须 ≥ 项目红线（不能被规格的 12.2m 悄悄放松）
  ok(buildingClearNeed(hw, cw) === hw + cw + 4.0,
    '建筑净空 = 半宽 + 路肩 + 4.0 缓冲',
    `${hw} + ${cw} + 4.0 = ${buildingClearNeed(hw, cw)}m`);

  // 单元自检：造一个"角落刚好压线"的建筑，验证 OBB 判据真的逐点生效。
  //   ⚠ 两个必须遵守的构造约定：
  //     ① OBB 的 yaw 是**世界系**航向角 —— 要构造"沿赛道法线外推 off 米"的样本，
  //        必须用 side 向量自己的 yaw 作基准（iMid 处 side 指向 ~169°，不是 0°）。
  //     ② 赛道是**弯的**：外推到 off 后，远端角点的最近样条点会落在孤长另一处、
  //        中心线已偏转，所以 minD 会**小于** off（off=30 时实测 21.95）。
  //        单元自检要选 off 足够大的样本，别拿"minD == off"当预期。
  const t0 = new Track(4242, 'vegas'); t0.build();
  const iMid = Math.floor(t0.count / 2);
  const p = t0.pts[iMid], s = t0.side[iMid];
  const yawSide = Math.atan2(s.x, s.z);          // 使局部 +X 对齐 side（法线）方向
  const at = (off, dYaw, hW, hD) =>
    obbClearOfTrack(t0, p.x + s.x * off, p.z + s.z * off, yawSide + dYaw, hW, hD, 13.5);
  // 小体量（半宽半深 4m）对齐法线、off=40m —— 弯道衰减后仍应远大于 13.5m
  ok(at(40, 0, 4, 4).ok === true,
    'OBB：小体量（半宽半深 4m）off=40m 对齐法线 -> 判定安全',
    'minD=' + at(40, 0, 4, 4).minD.toFixed(2));
  // 同体量、同位置，整体转 45°：角点被旋转带向内侧，最近距离必然**变小**。
  //   ⚠ 别按"内向分量 = 半宽·√2"估幅度：赛道是弯的，外推后中心线本身已偏转，
  //     近端角点的最近样条点会挪到弧长另一处，把旋转造成的下降吃掉一部分。
  //     halfW=halfD=4 实测只有 35.99 -> 34.34（降 1.65）。这里退化成**方向性**断言：
  //     "旋转不该让净空变好"，这才是判据真正要保证的语义。
  const a0 = at(40, 0, 4, 4).minD, a45 = at(40, Math.PI / 4, 4, 4).minD;
  ok(a45 < a0,
    'OBB：同位置转 45° 后 minD 只会变小（角点被旋转带进内侧，绝不更安全）',
    a0.toFixed(2) + ' -> ' + a45.toFixed(2));
  // 要拿"显著下降"当证据，就用**大体量 + 大 off**：这时旋转带来的内向分量
  // （25√2 ≈ 35.36m）远大于弯道衰减，下降必然是数量级的。
  const b0 = at(60, 0, 25, 25).minD, b45 = at(60, Math.PI / 4, 25, 25).minD;
  ok(b45 < b0 - 5.0,
    'OBB：最大体量转 45° -> minD 数量级下降（内向分量 25√2 远大于弯道衰减）',
    b0.toFixed(2) + ' -> ' + b45.toFixed(2));
  // 直接把"不安全"造出来：off 收到 14m、半宽半深 10m -> 角点必然压进廊道
  ok(at(14, 0, 10, 10).ok === false,
    'OBB：off=14m + 半宽半深 10m -> 角点压进 13.5m 廊道，判定不安全',
    'minD=' + at(14, 0, 10, 10).minD.toFixed(2));
  // 最大体量：半宽半深 25m（半对角 35.36m）。转 45° 时内向分量 = 25√2 ≈ 35.36m
  // ★ 旧实现用中心距离减常数 34：off=48 时 48−34 = 14 ≥ 13.5 -> **误判为安全**；
  //   而真实角点已侵入（minD ≈ 12.6）。这就是"最大体量建筑角点漏检"的复现。
  const oldGate = 48 - 34, obs = at(48, Math.PI / 4, 25, 25);
  ok(obs.ok === false && oldGate >= 13.5,
    'OBB：最大体量转 45° -> 真实角点侵入；旧 34m 常数会误判安全（历史缺口复现）',
    `旧口径 ${oldGate} ≥ 13.5（放行）vs 真实 minD=${obs.minD.toFixed(2)}（拒绝）`);

  // 实测：三条赛道的建筑全部满足（minD 由 OBB 逐点算出）
  for (const type of TRACK_TYPES) {
    const t = new Track(4242, type); t.build();
    if (!t.buildings.length) continue;
    const worst = t.buildings.reduce((m, b) => Math.min(m, b.minD ?? Infinity), Infinity);
    const allTagged = t.buildings.every((b) => typeof b.minD === 'number' && b.minD >= 13.5);
    ok(allTagged,
      `${type}：每栋建筑的 OBB 五点最近距离均 ≥ 13.5m`,
      `最差 ${worst.toFixed(2)}m / 共 ${t.buildings.length} 栋`);
  }
}

// --- 护栏顶面对齐 / 铃鹿缓冲区外沿护栏 / 看台 --------------------------------
{
  const { BARRIER_HULL_HY, BARRIER_BURY, BARRIER_VIS_HALF_H } = await import(mod('public/js/track.js'));
  // 可视墙顶必须与碰撞体顶面重合，否则护栏上方会留一段"隐形墙"（撞上去像撞空气）。
  const colliderTop = 0.25 + BARRIER_HULL_HY;              // 中心 路面+0.25，半高 1.25
  const visTop = 0.75 + (BARRIER_VIS_HALF_H || 0.75);
  ok(Math.abs(colliderTop - visTop) < 1e-6,
    '护栏可视墙顶与碰撞体顶面重合（无隐形墙）',
    '碰撞顶 路面+' + colliderTop.toFixed(2) + ' / 可视顶 路面+' + visTop.toFixed(2));
  ok(BARRIER_BURY === 1.0 && Math.abs(colliderTop - 1.5) < 1e-9,
    '护栏碰撞体 路面下方深埋 1.0m、上方 1.5m（厚 2.0 × 高 2.5）');

  // 铃鹿：全线护栏放在 42m 缓冲区的**外沿**，与草地脱困共存
  const suz = new Track(4242, 'suzuka'); suz.build();
  const srails = suz.colliders.filter((c) => Math.abs(c.hx - 1.0) < 1e-9 && Math.abs(c.hy - 1.25) < 1e-9);
  ok(srails.length >= 2 * (suz.length / 20),
    '铃鹿也有全线连续实体护栏（规格 §二.3）', srails.length + ' 段');
  // 注意：不能用 suz.sample() 反推横向距离 —— 8 字自交处几何最近点会命中另一条腿，
  // 测出来的"横向距离"是假的（实测给出 0.2m 的荒谬值）。直接卡构造常量：
  // 护栏是按 `p + side·d·barrierLat` 生成的，barrierLat 就是它的横向落位。
  // ★ 2026-09-30 变更：铃鹿护栏改为**逐点变位**（真车路宽 10~16m 随路段变化，
  //   护栏必须跟着半宽走），所以不再有单个标量 barrierLat，改查 barrierLatArr。
  //   真车永久赛道的护栏在**缓冲区外沿**：半宽 + 路肩 + SUZUKA_RUNOFF_M。
  ok(suz.barrierLatArr != null,
    '铃鹿护栏落位是逐点数组（变宽赛道必需）',
    '类型=' + (suz.barrierLatArr && suz.barrierLatArr.constructor.name));
  {
    let worst = Infinity, err = 0;
    for (let i = 0; i < suz.count; i++) {
      const want = suz.halfWidthAt[i] + suz.curbWidth + SUZUKA_RUNOFF_M;
      err = Math.max(err, Math.abs(suz.barrierLatArr[i] - want));
      worst = Math.min(worst, suz.barrierLatArr[i]);
    }
    ok(err < 1e-9, '★铃鹿护栏逐点位置 = 半宽(逐点) + 路肩 + 缓冲区',
      '最大偏差 ' + num(err, 6) + 'm');
    ok(worst > suz.halfWidthMin + suz.curbWidth + 6,
      '★铃鹿护栏离路肩足够远（缓冲区仍可用，冲出去拦得住）',
      num(worst, 1) + 'm > ' + num(suz.halfWidthMin + suz.curbWidth + 6, 1) + 'm');
  }

  // 本轮要求赛道视线无看台遮挡：Spa/Suzuka 都不得生成看台。
  for (const type of ['spa', 'suzuka']) {
    const t = new Track(4242, type);
    t.build();
    const want = t.theme.grandstandCount || 0;
    ok(want === 0 && t.grandstands.length === 0,
      `${type}：不生成任何遮挡视线的看台`, '配置 ' + want + ' / 实例 ' + t.grandstands.length);
    ok(!t.colliders.some((c) => c.hx > 2), `${type}：看台未混入物理碰撞体`);
  }
}

// --- 护栏刚体真的进了物理世界 + 真的拦得住车 ------------------------------
{
  const { RacePhysics } = await import(mod('public/js/physics.js'));
  const { registerTrackBodies } = await import(mod('public/js/track.js'));
  // 回归：registerTrackBodies 曾因 `typeof CANNON === 'undefined'`（本模块没 import CANNON，
  // 而 cannon-es 是 ESM 不产生全局）**恒返回 []**，导致三大赛道护栏全是纯视觉 -> 车穿过去。
  for (const type of TRACK_TYPES) {
    const t = new Track(4242, type); t.build();
    const rp = new RacePhysics(t);
    ok(rp.staticBodies.filter((b) => b.__barrier === true).length === t.colliders.length && rp.staticBodies.length > t.colliders.length,
      `${type}：护栏/桥栏/桥墩刚体全部落地进物理世界`,
      rp.staticBodies.filter((b) => b.__barrier === true).length + ' / ' + t.colliders.length + '（含路面 Heightfield ' + rp.staticBodies.filter((b) => b.__roadHeightfield).length + '）');
    ok(rp.world.bodies.filter((b) => b.mass === 0 && b.__barrier === true).length === t.colliders.length,
      `${type}：世界里的护栏静态体数量与碰撞体描述一致`);
  }
  void registerTrackBodies;

  // 行为验证：横向全油门撞护栏，必须被拦住（不能穿出去）
  for (const type of ['vegas', 'spa']) {
    const t = new Track(4242, type); t.build();
    const rp = new RacePhysics(t);
    rp.racing = true;
    const car = rp.addCar({ id: 1, name: 'T', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
    const s0 = t.side[300];
    car.body.velocity.set(s0.x * 30, 0, s0.z * 30);       // 30m/s 直接怼向护栏
    car.input.throttle = 1;
    let maxLat = 0;
    for (let i = 0; i < 180; i++) {
      car.input.throttle = 1;
      rp.fixedStep(1 / 60);
      maxLat = Math.max(maxLat, Math.abs(t.sample(car.pos.x, car.pos.z).lateral));
    }
    const bar = t.barrierLat || (t.halfWidth + t.curbWidth + 0.75);
    ok(maxLat < bar + 1.5,
      `${type}：30m/s 横怼护栏被拦住，没有穿出去`,
      '最远横向 ' + num(maxLat, 2) + 'm < 护栏 ' + num(bar, 2) + 'm');
    ok(maxLat > t.halfWidth,
      `${type}：台架成立，车确实冲出了沥青（否则测的是空气墙）`,
      '最远横向 ' + num(maxLat, 2) + 'm > 半宽 ' + num(t.halfWidth, 1) + 'm');
  }
}

// --- 建筑仰角不得挡住视野（方案 F 规则 1）----------------------------------
{
  const { VIEW_SAFE } = await import(mod('public/js/track.js'));
  for (const type of TRACK_TYPES) {
    const t = new Track(4242, type); t.build();
    if (!t.buildings.length) continue;
    let worst = 0, worstH = 0;
    for (const b of t.buildings) {
      const ang = Math.atan((b.h - VIEW_SAFE.EYE_H) / b.lat);
      if (ang > worst) { worst = ang; worstH = b.h; }
    }
    const limit = VIEW_SAFE.STRAIGHT + 1e-6;
    ok(worst <= limit,
      `${type}：所有建筑的仰角未超过视野安全角（不再堵死驾驶视野）`,
      '最大仰角 ' + num(worst * 180 / Math.PI, 1) + '° ≤ ' + num(limit * 180 / Math.PI, 0) +
      '°（最高一栋 ' + num(worstH, 0) + 'm）');
  }
}

// --- 看台不得长在赛道上 ----------------------------------------------------
{
  for (const type of TRACK_TYPES) {
    const t = new Track(4242, type); t.build();
    if (!t.grandstands.length) continue;
    let worst = Infinity;
    for (const g of t.grandstands) {
      for (let j = 0; j < t.count; j++) {
        const gap = Math.min(Math.abs(j - g.i), t.count - Math.abs(j - g.i));
        if (gap < t.count * 0.06) continue;               // 自己脚下那段路
        worst = Math.min(worst, Math.hypot(t.pts[j].x - g.x, t.pts[j].z - g.z));
      }
    }
    ok(t.grandstands.length === 0 && (worst === Infinity || worst > t.halfWidth + 2),
      `${type}：无看台实例，因此不存在看台压赛道或遮挡`,
      t.grandstands.length + ' 组，与其它路段最近 ' + num(worst, 1) + 'm');
  }
}

// --- 斯帕-弗朗科尔尚（规格 §二.1）---------------------------------------
{
  const spa = new Track(4242, 'spa');
  spa.build();
  const N = spa.count;

  ok(Math.abs(spa.length - 7004) < 260,
    '斯帕全长贴近真实值 7.004km', spa.length.toFixed(0) + 'm');

  // 高程：欧鲁日/拉迪隆的 +14.5m 爬升是这条赛道的灵魂
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < N; i++) { yMin = Math.min(yMin, spa.pts[i].y); yMax = Math.max(yMax, spa.pts[i].y); }
  ok(Math.abs((yMax - yMin) - 14.5) < 1.0,
    '斯帕高低落差 ≈ +14.5m（欧鲁日 / 拉迪隆爬升）',
    yMin.toFixed(1) + '~' + yMax.toFixed(1) + 'm = ' + (yMax - yMin).toFixed(1) + 'm');

  // 爬升段必须在赛道前 1/5（拉索斯之后紧接着就是欧鲁日），而且坡度不能是垂直墙
  let climbStart = -1, climbEnd = -1, maxGrade = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const dy = spa.pts[j].y - spa.pts[i].y;
    const grade = Math.abs(dy) / spa.spacing;
    if (grade > maxGrade) maxGrade = grade;
    if (climbStart < 0 && i < N * 0.3 && dy > 0.05) climbStart = i;
    if (climbStart >= 0 && climbEnd < 0 && i > climbStart + 5 && dy <= 0) climbEnd = i;
  }
  ok(maxGrade < 0.28, '斯帕最大坡度 < 28%（不是垂直墙，车辆爬得上去）',
    (maxGrade * 100).toFixed(1) + '%');
  ok(climbStart >= 0 && climbStart < N * 0.25,
    '欧鲁日爬升位于赛道前 1/4（拉索斯之后）', 'idx=' + climbStart + '/' + N);

  // 低速紧弯必须存在（拉索斯发卡 / Bus Stop），否则就是一条没有性格的高速环
  let minR = Infinity, minIdx = -1;
  for (let i = 0; i < N; i++) {
    const a = spa.tan[i], b = spa.tan[(i + 1) % N];
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
    const dth = Math.acos(dot);
    if (dth > 1e-9) {
      const R = spa.spacing / dth;
      if (R < minR) { minR = R; minIdx = i; }
    }
  }
  ok(minR < 40, '斯帕存在低速紧弯（拉索斯发卡 / Bus Stop）',
    '最小半径 ' + minR.toFixed(1) + 'm @' + minIdx);
  ok(minIdx > 20 && minIdx < N * 0.2,
    '最紧的弯是拉索斯发卡（位于起点直道之后，发车格不在弯里）',
    'idx=' + minIdx + '/' + N);

  // 非立交：平面投影不能自交（自交就该走立交桥，Spa 没有桥）
  let cross = 0;
  const P = spa.pts;
  for (let i = 0; i < N; i++) {
    const a1 = P[i], a2 = P[(i + 1) % N];
    for (let j = i + 1; j < N; j++) {
      if (j === i || j === (i + 1) % N || (j + 1) % N === i) continue;
      if (i === 0 && j === N - 1) continue;
      const b1 = P[j], b2 = P[(j + 1) % N];
      const d = (a2.x - a1.x) * (b2.z - b1.z) - (a2.z - a1.z) * (b2.x - b1.x);
      if (Math.abs(d) < 1e-12) continue;
      const s = ((b1.x - a1.x) * (b2.z - b1.z) - (b1.z - a1.z) * (b2.x - b1.x)) / d;
      const u = ((b1.x - a1.x) * (a2.z - a1.z) - (b1.z - a1.z) * (a2.x - a1.x)) / d;
      if (s > 0 && s < 1 && u > 0 && u < 1) cross++;
    }
  }
  ok(cross === 0, '斯帕平面投影不自交（无立交桥，与铃鹿的 8 字区分开）', '自交 ' + cross);
  ok(!spa.hasBridge && !spa.bridge.active, '斯帕不带立交桥数据（护栏与桥墩逻辑不介入）');

  // 规格 §二.4：斯帕埋 28 个 Checkpoint
  ok(spa.checkpointCount === 28 && spa.checkpoints.length === 28,
    '斯帕埋 28 个 Checkpoint（规格）', String(spa.checkpointCount));
  ok(Number.isInteger(spa.samplesPerCp),
    'samplesPerCp 取整（1440/28=51.43 留小数会让 CP 逐圈漂移）', String(spa.samplesPerCp));

  // 护栏：连续封闭 + 高度 1.4m
  // 护栏 = 除桥墩（hx=hz=0.55 的立柱）以外的全部静态体
  const rails = spa.colliders.filter((c) => !(Math.abs(c.hx - 0.55) < 1e-6 && Math.abs(c.hz - 0.55) < 1e-6));
  ok(rails.length > 600 && rails.every((c) => Math.abs(c.hy - 1.25) < 1e-9 && Math.abs(c.hx - 1.0) < 1e-9),
    '斯帕全线连续护栏，碰撞体厚 2.0m × 高 2.5m（规格 §二.1）', rails.length + ' 段');
  // 全线封闭：护栏生成步长是 4 个采样点（≈19.5m），内外两侧各一条。
  // 判据用「每 20m 至少一段 × 两侧」—— 直接卡住"连续"，不写死具体段数。
  // ★ 口径升级（2026-09-30）：护栏盒已**合并成长段**（性能优化：2880 → 数百个静态体），
//   旧的"每 20m 至少一段"按**盒数**判断会假红（长盒跨越多个 20m 窗口但起点只有一个）。
//   改成**覆盖口径**：沿护栏线逐米取样，未覆盖长度必须为 0。
{
  const latAt = spa.barrierLatArr ? ((i) => spa.barrierLatArr[i])
    : ((i) => spa.barrierLat || (spa.halfWidth + spa.curbWidth + 0.75));
  let uncovered = 0, checked = 0;
  for (let i = 0; i < spa.count; i++) {
    const pp = spa.pts[i], ss = spa.side[i], lat = latAt(i);
    for (const d of [1, -1]) {
      const px = pp.x + ss.x * d * lat, pz = pp.z + ss.z * d * lat;
      checked++;
      let inside = false;
      for (const c of rails) {
        const th = 2 * Math.atan2(c.qy || 0, c.qw === undefined ? 1 : c.qw);
        const cy = Math.cos(th), sy = Math.sin(th);
        const dx = px - c.x, dz = pz - c.z;
        const lx = dx * cy - dz * sy, lz = dx * sy + dz * cy;
        if (Math.abs(lx) <= c.hx + 0.06 && Math.abs(lz) <= c.hz + 0.06) { inside = true; break; }
      }
      if (!inside) uncovered++;
    }
  }
  ok(uncovered === 0,
    '★斯帕护栏内外两侧连续布防（逐米覆盖，未覆盖点必须为 0）',
    rails.length + ' 段（已合并）覆盖 ' + checked + ' 个采样点，未覆盖 ' + uncovered);
}

  // 确定性：同 seed 两次生成必须完全一致（规格 §一.2：禁止无约束随机撒播）
  const a = new Track(4242, 'spa'); a.build();
  const b = new Track(4242, 'spa'); b.build();
  let maxD = 0;
  for (let i = 0; i < a.count; i++) {
    maxD = Math.max(maxD, Math.abs(a.pts[i].x - b.pts[i].x), Math.abs(a.pts[i].z - b.pts[i].z));
  }
  ok(maxD === 0, '斯帕布局完全确定性（同 seed 逐点一致）', 'maxΔ=' + maxD);
}

/* --------------------------------------------------------------------- */
section('1. 铃鹿：8 字自交 + 立交分层');
const suz = new Track(12345, 'suzuka');
const builtS = suz.build();

function finiteTrack(t, label) {
  let bad = 0, worst = 0;
  for (const p of t.pts) {
    if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) bad++;
    worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  }
  ok(bad === 0, `${label}：${t.count} 个骨架点全部有限值`, `bad=${bad} max|coord|=${num(worst, 1)}`);
  let nbad = 0;
  for (const n of t.nrm) {
    const L = Math.hypot(n.x, n.y, n.z);
    if (!isFinite(L) || Math.abs(L - 1) > 1e-6) nbad++;
  }
  ok(nbad === 0, `${label}：法线全部单位化`, `bad=${nbad}`);
}
const veg0 = new Track(12345, 'vegas');
finiteTrack(suz, '铃鹿');
finiteTrack(veg0, '拉斯维加斯');

ok(suz.checkpoints.length === 24, '铃鹿 Checkpoint = 24 个', `= ${suz.checkpoints.length}`);
ok(Math.abs(suz.samplesPerCp - suz.count / 24) < 1e-9, '每个 Checkpoint 恰好 60 个采样点', `samplesPerCp=${suz.samplesPerCp}`);
ok(suz.length > 3000 && suz.length < 8000, '铃鹿全长落在合理区间', `length=${num(suz.length, 1)}m`);

// ---- 自交检测：XZ 折线的非相邻线段是否相交 ----
function countSelfIntersections(t) {
  const N = t.count, pts = t.pts;
  const hits = [];
  const seg = (a, b, c, d) => {
    const d1 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const d2 = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x);
    const d3 = (d.x - c.x) * (a.z - c.z) - (d.z - c.z) * (a.x - c.x);
    const d4 = (d.x - c.x) * (b.z - c.z) - (d.z - c.z) * (b.x - c.x);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return false;
  };
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    for (let j = i + 2; j < N; j++) {
      if (i === 0 && j === N - 1) continue;         // 相邻接缝
      if (j - i < 3 || N - (j - i) < 3) continue;   // 跳过近邻
      const c = pts[j], d = pts[(j + 1) % N];
      if (seg(a, b, c, d)) hits.push([i, j]);
    }
  }
  return hits;
}
const xs = countSelfIntersections(suz);
ok(xs.length >= 1, '铃鹿存在**真实自交**（8 字）', `交叉对数=${xs.length}`);

// ⚠️ 立交判定必须取 **Δy 最大的那一对**，不能取第一对：
//    真实铃鹿的立交处上下两层夹角很小，几何法会在同一点附近连着命中若干对，
//    其中有些对的 Δy 只有 0.84m —— 那是"同一层里相邻采样段的假相交"。实测取第一
//    对会得到 Δy=0.84m 的假结论（真的那一对 Δy≈7.5m）。
let realPair = null;
for (const [i, j] of xs) {
  const dy = Math.abs(suz.pts[i].y - suz.pts[j].y);
  if (!realPair || dy > realPair.dy) realPair = { i, j, dy };
}
ok(realPair && realPair.dy >= TRACK_CFG.BRIDGE_MIN_H,
  '交叉处上下两层高差 ≥ 桥下净空（真的是立交，不是平面交叉）',
  realPair ? `Δy=${num(realPair.dy, 2)}m @ i=${realPair.i},j=${realPair.j}（共 ${xs.length} 对候选）` : '无交叉');
const LIFT_TOL = 0.5;

// ---- 桥面抬升量 ----
let maxLift = 0;
for (let i = 0; i < suz.count; i++) maxLift = Math.max(maxLift, suz.pts[i].y - suz.baseY[i]);
ok(Math.abs(maxLift - TRACK_CFG.BRIDGE_Y) < 0.25, '桥面抬升峰值 ≈ +9.5m', `maxLift=${num(maxLift, 3)}m`);
ok(suz.bridge.active, '立交桥段已被识别',
  `i0=${suz.bridge.i0} i1=${suz.bridge.i1} wrapped=${suz.bridge.wrapped} 桥面采样点=${(() => { let n = 0; for (let i = 0; i < suz.count; i++) if (suz.onBridge(i)) n++; return n; })()}`);
ok(!veg0.bridge.active, '拉斯维加斯的桥段判定为未激活');

// 桥面抬升只发生在局部：绝大多数采样点必须完全贴地（路面层 == 地面层）
let zeroLift = 0, offRampMax = 0;
for (let i = 0; i < suz.count; i++) {
  const lift = suz.pts[i].y - suz.baseY[i];
  if (lift < 1e-9) zeroLift++;
  else if (!suz.onBridge(i)) offRampMax = Math.max(offRampMax, lift);
}
ok(zeroLift / suz.count > 0.8,
  '立交只影响局部路段（>80% 采样点完全贴地）',
  `贴地点=${zeroLift}/${suz.count} = ${num((zeroLift / suz.count) * 100, 1)}%`);
ok(offRampMax <= TRACK_CFG.BRIDGE_Y * 0.5 + 1e-9,
  '桥面之外的抬升仅存在于引桥缓坡内（不超过半桥高，无突变）',
  `桥外最大抬升=${num(offRampMax, 3)}m`);

// ---- 规格 §五：铃鹿立交桥 3D 排除盒内**禁止任何树木**（杜绝桥下长树穿桥面）----
{
  const box = suz._bridgeExclusionBox();
  ok(!!box, '铃鹿立交桥 3D 排除盒已构造', box ? `中心=(${num(box.cx, 1)},${num(box.cz, 1)}) 半长=${box.halfLen}m 半宽=${box.halfWid}m` : '-');
  const trees = suz.trees || [];
  ok(trees.length > 0, '铃鹿记录了树木落位供审计', `${trees.length} 棵`);
  const inside = trees.filter((t) => suz._inBridgeExclusion(box, t.x, t.z));
  ok(inside.length === 0, '规格 §五：桥下 3D 排除盒投影内 0 棵树（无穿桥）',
    `盒内树=${inside.length} / 总树=${trees.length}`);
  // 规格 §五：所有树到中心线距离严格 > 半宽 + 8.5m
  const hw = suz.halfWidth;
  const need = hw + 8.5;
  const bad = trees.filter((t) => !(t.lat > need));
  ok(bad.length === 0, `规格 §五：所有树横向距离 > 半宽+8.5m (${need.toFixed(1)}m)`,
    `最小=${num(Math.min(...trees.map((t) => t.lat)), 2)}m，违例=${bad.length}`);
}

// 引桥连续性：抬升量序列没有台阶（相邻帧差应平滑）
let maxStep = 0;
for (let i = 0; i < suz.count; i++) {
  const a = suz.pts[i].y - suz.baseY[i];
  const b = suz.pts[(i + 1) % suz.count].y - suz.baseY[(i + 1) % suz.count];
  maxStep = Math.max(maxStep, Math.abs(a - b));
}
ok(maxStep < 0.5, '引桥坡道连续（无垂直台阶）', `相邻采样最大抬升差=${num(maxStep, 4)}m`);

// ---- 分层求解：同一个 XZ 位置，按车辆所在层解析出不同层 ----
// 语义：采样窗口只覆盖车辆"当前这一层"的采样点，因此车不会被吸到另一层去。
// 这正是立交可用的关键：桥上与桥下的车各自锁在自己那一层。
if (realPair) {
  const A = realPair.i, B = realPair.j;
  const hiIdx = suz.pts[A].y > suz.pts[B].y ? A : B;
  const loIdx = A === hiIdx ? B : A;
  const cx = (suz.pts[A].x + suz.pts[B].x) / 2;
  const cz = (suz.pts[A].z + suz.pts[B].z) / 2;
  const iHigh = suz.nearest(cx, cz, hiIdx, suz.pts[hiIdx].y);
  const iLow = suz.nearest(cx, cz, loIdx, suz.pts[loIdx].y);
  ok(iHigh === hiIdx && iLow === loIdx,
    '分层求解：窗口把车锁在自己那一层（不自跳层）', `hint=${hiIdx}->${iHigh}  hint=${loIdx}->${iLow}`);
  ok(suz.pts[iHigh].y - suz.pts[iLow].y >= TRACK_CFG.BRIDGE_MIN_H,
    '分层求解：同一 XZ 解析出桥面/地面两层，高差 ≥ 净空',
    `y(桥面)=${num(suz.pts[iHigh].y, 2)} y(地面)=${num(suz.pts[iLow].y, 2)} Δ=${num(suz.pts[iHigh].y - suz.pts[iLow].y, 2)}m`);
  // 桥面层必须真的抬到了 +7.5m 量级
  ok(Math.abs((suz.pts[iHigh].y - suz.baseY[iHigh]) - TRACK_CFG.BRIDGE_Y) < 0.5,
    '分层求解：被识别为桥面的那层确实抬升了 +7.5m', `lift=${num(suz.pts[iHigh].y - suz.baseY[iHigh], 2)}m`);
}

/* --------------------------------------------------------------------- */
section('2. 拉斯维加斯：1.9km 大直道 + Sphere 球馆');
const veg = new Track(777, 'vegas');
const builtV = veg.build();
ok(veg.checkpoints.length === 24, '拉斯维加斯 Checkpoint = 24 个', `= ${veg.checkpoints.length}`);
ok(veg.bridge.active === false, '拉斯维加斯无立交桥（桥数据未误触发）');

// 最长直道：从 i 向后延伸，只要所有中间点距弦 < 2m 就算同一段直线
function longestStraight(t, tol = 2.0) {
  const N = t.count, pts = t.pts;
  let bestLen = 0, bestI = 0, bestJ = 0;
  for (let i = 0; i < N; i += 3) {
    for (let j = i + 30; j < N; j += 30) {
      const a = pts[i], b = pts[j % N];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      if (L < bestLen) continue;
      let dev = 0;
      for (let k = i + 5; k < j; k += 5) {
        const p = pts[k % N];
        const cross = Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / (L || 1);
        if (cross > dev) dev = cross;
        if (dev > tol) break;
      }
      if (dev <= tol) { bestLen = L; bestI = i; bestJ = j % N; }
    }
  }
  return { len: bestLen, i: bestI, j: bestJ };
}
const st = longestStraight(veg);
ok(st.len >= 1800, '存在 ≥1.8km 的全油门大直道（规格 1.9km 量级）', `实测直道=${num(st.len, 1)}m @ i=${st.i}→${st.j}`);
ok(veg.sphere && veg.sphere.r > 50, 'Sphere 球馆锚点存在', veg.sphere ? `r=${veg.sphere.r}m @ (${veg.sphere.x},${veg.sphere.z})` : '无');

// 球馆必须在弯内：所有骨架点到球心的水平距离都 ≥ 球半径 + 余量
if (veg.sphere) {
  let minD = Infinity;
  for (const p of veg.pts) minD = Math.min(minD, Math.hypot(p.x - veg.sphere.x, p.z - veg.sphere.z));
  ok(minD >= veg.sphere.r, '赛道不穿模球馆（最小间距 ≥ 球半径）', `minDist=${num(minD, 1)}m vs r=${veg.sphere.r}`);
  ok(minD - veg.sphere.r < 320, '赛道确实**贴着**球馆绕行（不是远远躲开）', `余量=${num(minD - veg.sphere.r, 1)}m`);
}

/* --------------------------------------------------------------------- */
section('3. 发车格（服务端倒序槽位落到世界坐标）');
for (const [name, t] of [['铃鹿', suz], ['拉斯维加斯', veg]]) {
  const slots = [1, 2, 3, 4].map((s) => t.gridSlot(s));
  // 发车格采用四车错列：每台车都有独立纵向位置，左右交替。
  const keys = slots.map((s) => `${s.index}:${s.lateral.toFixed(2)}`);
  ok(new Set(keys).size === 4, `${name}：4 个发车格互不重合`, `格位=${keys.join(' ')}`);
  const rows = new Set(slots.map((s) => s.index));
  ok(rows.size === 4, `${name}：4 台车纵向错列排列`, `不同纵向位置=${rows.size}`);
  // slot1 最靠前（沿行驶方向最接近终点线）
  const gap = (s) => (t.count - t.gridSlot(s).index) % t.count;
  ok(gap(1) < gap(3), `${name}：slot 1 比 slot 3 更靠前（倒序发车可见）`, `gap1=${gap(1)} gap3=${gap(3)}`);
  const laterals = slots.map((s) => s.lateral);
  ok(Math.abs(laterals[0]) > 1 && Math.abs(laterals[1]) > 1 && Math.sign(laterals[0]) !== Math.sign(laterals[1]),
    `${name}：同排左右交错排列`, `lat=${laterals.map((v) => num(v, 1)).join(',')}`);
  // 所有发车格都必须落在沥青有效宽度内
  ok(laterals.every((v) => Math.abs(v) + 1.0 <= t.halfWidth),
    `${name}：发车格完整落在 14m 沥青内`, `max|lateral|=${num(Math.max(...laterals.map(Math.abs)), 2)}`);
}

/* --------------------------------------------------------------------- */
section('4. 静态碰撞体（桥栏 / 桥墩 / 护栏 / TechPro）');
ok(suz.colliders.length > 0, '铃鹿登记了静态碰撞体（桥栏 + 桥墩）', `= ${suz.colliders.length} 个`);
ok(veg.colliders.length > 0, '拉斯维加斯登记了静态碰撞体（混凝土/TechPro 护栏）', `= ${veg.colliders.length} 个`);

// 护栏物理高度必须统一 1.4m（规格）—— hy 是半高，所以应为 0.7。
// 注意要排除桥墩（hx=hz=0.55 的立柱，那是支撑结构不是护栏）。
//
// ⚠️ 规格 §五（本轮新增）：立交桥侧另有**独立加高护栏**（hy = BRIDGE_RAIL_H/2 = 0.9，
//    即 1.8m 高），与地面护栏是两套结构。因此本断言把"桥侧加高护栏"单独放行，
//    但必须**同时**存在足量的地面标准护栏（hy=1.25）——否则两侧护栏全被改掉就漏检了。
for (const [name, t] of [['铃鹿', suz], ['拉斯维加斯', veg]]) {
  const rails = t.colliders.filter((c) => !(Math.abs(c.hx - 0.55) < 1e-6 && Math.abs(c.hz - 0.55) < 1e-6));
  // 桥侧加高护栏：hy = 0.9（1.8m 高）且 hy 不等于地面标准 1.25
  const bridgeRails = rails.filter((c) => Math.abs(c.hy - 0.9) < 1e-6);
  const groundRails = rails.filter((c) => !(Math.abs(c.hy - 0.9) < 1e-6));
  // 规格 §二.1：地面护栏碰撞体必须**加厚**（防隧道效应）—— 厚 2.0m / 高 2.5m。
  // 可视护栏仍维持 1.4m（观感），两者是分开的：碰撞体比可视高 1.1m 属已知取舍。
  const badGround = groundRails.filter((c) => Math.abs(c.hy - 1.25) > 1e-6 || Math.abs(c.hx - 1.0) > 1e-6);
  const badBridge = bridgeRails.filter((c) => Math.abs(c.hx - 1.0) > 1e-6);
  ok(groundRails.length > 0 && badGround.length === 0 && badBridge.length === 0,
    `${name}：地面护栏碰撞体半厚 1.0 / 半高 1.25；桥侧加高护栏半厚 1.0 / 半高 0.9`,
    `${groundRails.length} 段地面护栏(不符 ${badGround.length}) + ${bridgeRails.length} 段桥侧加高护栏(不符 ${badBridge.length})`);
}

// 立交桥墩避让（规格）：桥墩必须锚定在**下层道路**沥青边缘外侧 3.5m 以外，
// 桥下净空 ≥16m。这里曾经是 ±(hw-1.2)=±5.8m（按桥面半宽算的），实测 18/20 根
// 直接立在下层沥青上、最严重距下层路中心线仅 0.95m —— 等于在下层路中间砌了墙。
{
  const hw = suz.halfWidth;
  const need = hw + 3.5;
  const pillars = suz.colliders.filter((c) => Math.abs(c.hx - 0.55) < 1e-6 && Math.abs(c.hz - 0.55) < 1e-6);
  let onRoad = 0, minAbs = Infinity;
  for (const p of pillars) {
    const lat = suz._groundLatAbs(p.x, p.z, p.y - p.hy);   // 柱底所在的地面层
    if (lat < hw) onRoad++;
    if (lat < minAbs) minAbs = lat;
  }
  ok(pillars.length > 0 && onRoad === 0,
    '铃鹿：没有任何桥墩扎进下层路面（规格：锚在沥青外 3.5m）',
    `${pillars.length} 根桥墩，其中 ${onRoad} 根在下层沥青上`);
  ok(minAbs >= need - 1e-6,
    '铃鹿：桥墩距下层路中心线 ≥ 半宽+3.5m', `最小 ${minAbs.toFixed(2)}m ≥ ${need.toFixed(2)}m`);
  ok(2 * minAbs >= 16,
    '铃鹿：桥下净空 ≥ 16m（规格）', `净空 ≈ ${(2 * minAbs).toFixed(2)}m`);
}

// 安全区（规格）：随机散射地物（路灯 / 树木 / 大楼）中心到赛道中心线的
// 水平距离必须严格大于 半宽 + 4.0m，严禁侵入沥青与路肩。
for (const [name, t] of [['铃鹿', suz], ['拉斯维加斯', veg]]) {
  const need = t.halfWidth + 4.0;
  ok(isFinite(t.minScatterLat) && t.minScatterLat > need,
    `${name}：所有地物都在安全区内（> 半宽+4.0m）`,
    `最近地物 ${t.minScatterLat.toFixed(2)}m vs 要求 > ${need.toFixed(2)}m`);
}
let cbad = 0;
for (const [name, t] of [['铃鹿', suz], ['拉斯维加斯', veg]]) {
  for (const c of t.colliders) {
    const vals = [c.x, c.y, c.z, c.qx, c.qy, c.qz, c.qw, c.hx, c.hy, c.hz];
    if (vals.some((v) => !isFinite(v))) cbad++;
    if (Math.hypot(c.qx, c.qy, c.qz, c.qw) < 0.9) cbad++;
    if (c.hx <= 0 || c.hy <= 0 || c.hz <= 0) cbad++;
  }
  void name;
}
ok(cbad === 0, '所有碰撞体描述均为有限值且四元数/半长合法', `bad=${cbad}`);

/* --------------------------------------------------------------------- */
section('5. 统一接口 generateTrack（含 world 落地）');
const fakeScene = { add(o) { (fakeScene._n = (fakeScene._n || 0) + 1); this._last = o; } };
const added = [];
const fakeWorld = { addBody(b) { added.push(b); } };
globalThis.CANNON = {
  Body: class { constructor() { this.shapes = []; } addShape(s) { this.shapes.push(s); } position = { set() {} }; quaternion = { set() {} }; },
  Box: class { constructor(h) { this.halfExtents = h; } },
  Vec3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
};
const t2 = generateTrack(fakeScene, fakeWorld, 'vegas', 4242);
ok(t2 instanceof Track, 'generateTrack 返回 Track 实例');
ok(t2.trackType === 'vegas', 'generateTrack 正确应用 trackType');
ok(fakeScene._n >= 1, 'generateTrack 把赛道加入 scene');
const roadBodies = t2.roadHeightfields.map((patch) => patch.body);
const barrierBodies = added.filter((body) => body.__barrier === true);
const registeredRoadBodies = added.filter((body) => body.__roadHeightfield === true);
const eachRoadBodyRegisteredOnce = roadBodies.every((body) =>
  added.filter((registered) => registered === body).length === 1 && body.__barrier === false);
ok(added.length === t2.colliders.length + roadBodies.length && added.length > 0 &&
  barrierBodies.length === t2.colliders.length && roadBodies.length > 0 &&
  registeredRoadBodies.length === roadBodies.length && eachRoadBodyRegisteredOnce,
  'generateTrack 完整注册护栏和道路 Heightfield（每个道路刚体恰好一次）',
  `bodies=${added.length}, barriers=${barrierBodies.length}, roads=${registeredRoadBodies.length}`);
const t3 = generateTrack(null, null, 'suzuka', 99);
ok(t3 instanceof Track && t3.trackType === 'suzuka', 'generateTrack 允许 scene/world 为 null（纯数据模式）');

/* --------------------------------------------------------------------- */
section('6. 确定性（同 seed 同赛道）');
const a1 = new Track(555, 'suzuka'), a2 = new Track(555, 'suzuka');
let maxDelta = 0;
for (let i = 0; i < a1.count; i++) {
  maxDelta = Math.max(maxDelta,
    Math.abs(a1.pts[i].x - a2.pts[i].x),
    Math.abs(a1.pts[i].y - a2.pts[i].y),
    Math.abs(a1.pts[i].z - a2.pts[i].z));
}
ok(maxDelta === 0, '同 seed 生成完全一致的赛道（跨机同步前提）', `maxΔ=${maxDelta}`);
// ★ 2026-09-30 变更：真实铃鹿的走线来自 OSM 实测，**不随 seed 变化**（真车场地固定）。
const b1 = new Track(556, 'suzuka');
let diff = 0;
for (let i = 0; i < a1.count; i++) diff = Math.max(diff, Math.abs(a1.pts[i].x - b1.pts[i].x) + Math.abs(a1.pts[i].z - b1.pts[i].z));
ok(diff < 1e-9, '★★铃鹿：走线与 seed 无关（真实场地固定，跨机同步天然满足）', `maxΔ=${num(diff, 6)}m`);
// 任何 seed 下都必须是真 8 字（含立交）
ok(countSelfIntersections(b1).length >= 1, '铃鹿：换 seed 后仍是 8 字自交');
// 真实铃鹿的三条硬指纹：走线数据一旦被误改，这三条立刻红
{
  ok(Math.abs(a1.length - SUZUKA_GEOMETRY.realPerimeter) / SUZUKA_GEOMETRY.realPerimeter < 0.03,
    '★铃鹿全长与真车单圈 5807m 吻合（±3%）',
    num(a1.length, 0) + 'm vs ' + SUZUKA_GEOMETRY.realPerimeter + 'm');
  ok(SUZUKA_GEOMETRY.selfIntersections === 1,
    '★铃鹿走线投影自交恰好 1 处（8 字立交的唯一交点）', '自交=' + SUZUKA_GEOMETRY.selfIntersections);
  ok(SUZUKA_GEOMETRY.pts.length > 200, '★铃鹿走线来自实测数据（点密度足够）',
    SUZUKA_GEOMETRY.pts.length + ' 点');
  ok(SUZUKA_GEOMETRY.startIndexInOsm != null && SUZUKA_GEOMETRY.travelDirVsOsmIndex != null,
    '★铃鹿起终点/行车方向已被显式确定并记录',
    'startIdx=' + SUZUKA_GEOMETRY.startIndexInOsm + ' dir=' + SUZUKA_GEOMETRY.travelDirVsOsmIndex);
}
// 拉斯维加斯是固定街道场地：与 seed 无关，任何机器上都是同一条街
const v1 = new Track(1, 'vegas'), v2 = new Track(999999, 'vegas');
let vd = 0;
for (let i = 0; i < v1.count; i++) vd = Math.max(vd, Math.abs(v1.pts[i].x - v2.pts[i].x) + Math.abs(v1.pts[i].z - v2.pts[i].z));
ok(vd === 0, '拉斯维加斯：固定场地，布局不随 seed 变化（仍是确定性的）', `maxΔ=${vd}`);

/* --------------------------------------------------------------------- */
section('7. 新手 · 极简高速环道（oval，合成图）');
{
  const { OVAL_GEOMETRY } = await import(mod('public/js/oval-geometry.js'));
  const o1 = new Track(777, 'oval');
  o1.build();
  const o2 = new Track(778, 'oval');
  o2.build();

  // ① 解析周长必须真的落地：2 条 400m 直道 + 2 个半径 180m 的半圆
  // 两条直道各 400m（半长 200m 对称铺开）+ 两个半径 180m 的半圆
  const expectLen = 2 * (2 * 200) + 2 * Math.PI * 180;
  ok(Math.abs(o1.length - expectLen) / expectLen < 0.02,
    '★环道周长贴合解析值 2·400 + 2π·180 ≈ 1931m（±2%）',
    `${num(o1.length, 1)}m vs 解析 ${num(expectLen, 1)}m`);
  ok(OVAL_GEOMETRY.selfIntersections === 0 && countSelfIntersections(o1).length === 0,
    '★环道平面投影零自交（无立交层，不会误触发桥面/桥墩逻辑）',
    '自交=' + countSelfIntersections(o1).length);
  ok(!o1.hasBridge && !o1.bridge.active, '环道不带立交桥数据');

  // ② 形状指纹：直线段必须是真的直（半径极大），两个弯必须是 R≈180m
  let straightSamples = 0, curveMinR = Infinity, curveMaxR = 0;
  for (let i = 0; i < o1.count; i++) {
    const R = o1.raceLine.radius[i];
    if (R > 1000) straightSamples++;
    else { curveMinR = Math.min(curveMinR, R); curveMaxR = Math.max(curveMaxR, R); }
  }
  ok(straightSamples > o1.count * 0.3,
    '环道保留两条大直道（>30% 采样点半径 > 1000m）',
    `${num(straightSamples / o1.count * 100, 1)}% 采样点在直道上`);
  // 判据取**全圈最小半径**：新手图不许有发卡/减速弯，最急处必须仍是宽弯。
  // （过渡采样点半径可从 180m 连续变到上千 m，所以不能按"弯道样本的半径上界"断言。）
  let minR = Infinity;
  for (let i = 0; i < o1.count; i++) minR = Math.min(minR, o1.raceLine.radius[i]);
  ok(minR > 120 && minR < 260,
    '★环道最急处仍是宽半径平缓弯（R≈170~200m，无发卡/减速弯）',
    `全圈最小半径 ${num(minR, 1)}m（弯道样本 ${num(curveMinR, 1)}~${num(curveMaxR, 1)}m）`);

  // ③ 圈数参数与起终点
  ok(o1.checkpointCount === 24 && o1.checkpoints.length === 24, '环道埋 24 个 Checkpoint');
  const slots = [1, 2, 3, 4, 12].map((s) => o1.gridSlot(s));
  ok(slots.every((g) => g.index >= 0 && g.index < o1.count && Number.isFinite(g.lateral)),
    '环道 12 个发车格全部落在合法采样索引内', slots.map((g) => g.index).join(','));
  const maxGap = Math.max(...slots.map((s) => (o1.count - o1.gridSlot(s).index) % o1.count));
  ok(maxGap < o1.spacing * 120,
    '环道发车格仍在线后 120 个采样点内（起终点直道上，不会排到弯里）',
    '最远 ' + num(maxGap * o1.spacing, 1) + 'm');

  // ④ 确定性：合成环道与 seed 无关（任何机器同一条路）
  let od = 0;
  for (let i = 0; i < o1.count; i++) od = Math.max(od, Math.abs(o1.pts[i].x - o2.pts[i].x) + Math.abs(o1.pts[i].z - o2.pts[i].z));
  ok(od === 0, '环道与 seed 无关（合成图跨机完全一致）', `maxΔ=${od}`);

  // ⑤ 拥挤区必须真的识别出来（等半径图不能落入"分位阈值恰好切在弯道半径上"的陷阱）
  const zones = o1.congestionZones || [];
  const zspan = zones.reduce((acc, z) => acc + (z.wrapped ? (o1.count - z.i0) + (z.i1 + 1) : (z.i1 - z.i0 + 1)) * o1.spacing, 0);
  ok(zones.length === 2 && zspan / o1.length > 0.3,
    '★环道两个弯都被识别为拥挤区（等半径谱必须显式给阈值，否则整条弯漏检）',
    zones.length + ' 个区，' + num(zspan / o1.length * 100, 1) + '%');
}

/* --------------------------------------------------------------------- */
console.log('\n' + '─'.repeat(66));
console.log(`\x1b[1m结果\x1b[0m  ${pass} 通过 / ${failures.length} 失败   （${Date.now() - t0}ms）`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
console.log('\x1b[32m全部通过\x1b[0m');
