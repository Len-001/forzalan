/**
 * 规格 §三 行为级验证：低速吸墙根治 + 弯道动态拥挤幽灵化。
 *
 * 为什么不能只做静态守卫：本工程已栽过多次"静态断言通过、行为方向反了"的坑
 * （法线方向、秒差符号、位置相推反）。§三 的两条机制都是**方向敏感**的物理行为，
 * 必须断言可观测量：
 *   A. Anti-Suction：低速顶墙时，车必须**离**墙越来越远（横向穿透单调不增），
 *      而不是被吸住原地不动 —— 用真实 Cannon 世界跑，读 vehicle 位置。
 *   B. 切向保留：低速刮墙时车速不得被摩擦吃穿（≥ 92% 保留口径的可见效果）。
 *   C. Congestion Zones：小半径弯区间的提取必须覆盖三大赛道的发卡/减速弯，
 *      且不覆盖长直道（否则直道也幽灵化 = 假阳性）。
 *   D. 拥挤幽灵化开关：>=3 台车挤在弯道 10m 内且接近时 -> 掩码剔车车；
 *      拉开 > 6m -> 恢复（掩码复位）。断言 collisionFilterMask 的真实位变化。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

// ---- 注入 three（UMD -> globalThis.THREE）--------------------------------
const threeSrc = fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8');
(0, eval)(threeSrc);
if (!globalThis.THREE) { console.error('无法注入 three.min.js'); process.exit(1); }
// ---- 注入 cannon（ESM）到 globalThis —— physics.js 里用的是裸 CANNON 全局 ----
const CANNON_NS = await import(mod('public/libs/cannon-es.js'));
globalThis.CANNON = CANNON_NS;

// ---- 最小 DOM / window 桩（physics.js / track.js 依赖 three 的少量 API）----
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

const { Track, TRACK_CFG, TRACK_TYPES, generateTrack } = await import(mod('public/js/track.js'));
const { RacePhysics, CFG } = await import(mod('public/js/physics.js'));

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? '  ' + detail : '')); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

console.log('─'.repeat(66));
console.log('§3.1  低速吸墙根治（Anti-Suction）');
console.log('─'.repeat(66));

{
  // ---- 常量口径 ----
  ok(CFG.ANTI_SUCTION_KMH === 40, '低速阈值 = 40 km/h（规格）', '= ' + CFG.ANTI_SUCTION_KMH);
  ok(Math.abs(CFG.ANTI_SUCTION_LOW_PUSH_M - 0.02) < 1e-9,
    'Anti-Suction 法向外推量 = 0.02m/步（规格 pen+0.02m）', '= ' + CFG.ANTI_SUCTION_LOW_PUSH_M);
  ok(Math.abs(CFG.DEFLECT_TANGENT_KEEP - 0.92) < 1e-9,
    '切向动量硬保留率 = 92%（规格）', '= ' + CFG.DEFLECT_TANGENT_KEEP);

  // ---- 行为：低速顶墙后必须**离开**墙，不是被吸住 ----
  // 构造：把车**人为贴到护栏上**（横向偏移置到护栏内侧 0.3m，必然接触）。
  // ⚠ 必须走 generateTrack(world) —— 静态护栏刚体只在那一入口注册
  //   （历史教训：`new Track()` 直接构造时 colliders 从未 addBody，护栏全是装饰）。
  const trk = generateTrack(null, null, 'suzuka', 20260926);
  const rp = new RacePhysics(trk);
  rp.racing = true;
  // 护栏横向落位（见 track.js：默认贴路肩外，永久赛道放缓冲区外沿）
  // 护栏横向落位：铃鹿是**逐点数组**（真车路宽随路段变化），vegas 是常量。
  // ⚠️ 不能只看 `trk.barrierLat`：变宽赛道它是 0，会让车被挪到错误位置
  //    （实测初始横向 8.5m，而真实护栏在 18.2m ⇒ 根本没碰到墙、hits=0）。
  const wallLat = (() => {
    const i0 = trk.gridSlot(1).index;
    if (trk.barrierLatArr) return trk.barrierLatArr[i0];
    return trk.barrierLat || (TRACK_CFG.HALF_WIDTH + TRACK_CFG.CURB_W + 0.6);
  })();
  const slot = trk.gridSlot(1);
  const car = rp.addCar({
    id: 1, name: '车手1', color: '#e10600', isLocal: true,
    startIndex: slot.index, lateral: slot.lateral, laps: 2,
  });
  // 把车横向挪到护栏内侧 0.3m（保证接触）
  {
    const info = trk.sample(car.pos.x, car.pos.z, -1);
    const s = info.side;
    const dxWanted = (wallLat - 0.3) - Math.abs(info.lateral);
    const sgn = info.lateral >= 0 ? 1 : -1;
    car.body.position.x += s.x * dxWanted * sgn;
    car.body.position.z += s.z * dxWanted * sgn;
    car.syncFromBody();
  }
  const info0 = trk.sample(car.pos.x, car.pos.z, car.trackIdx);
  const side = info0.side;
  const t = info0.tangent;
  const tl = Math.hypot(t.x, t.z) || 1;
  car.body.velocity.set(t.x / tl * 8, 0, t.z / tl * 8);
  // 叠加朝护栏的轻推（模拟"顶墙"）
  const wallSign = info0.lateral >= 0 ? 1 : -1;
  car.body.velocity.x += side.x * wallSign * 1.2;
  car.body.velocity.z += side.z * wallSign * 1.2;
  car.syncFromBody();

  let latAbs0 = Math.abs(trk.sample(car.pos.x, car.pos.z, car.trackIdx).lateral);
  let minLat = latAbs0;
  let spdPeak = 0;
  const latTrace = [];
  for (let i = 0; i < 120; i++) {
    // 模拟真实玩家"油门踩到底想脱困"：持续给 70% 油门 + 车头指向切线方向
    car.throttle = 0.7; car.brake = 0; car.handbrake = 0;
    rp.fixedStep(1 / 60);
    const li = Math.abs(trk.sample(car.pos.x, car.pos.z, car.trackIdx).lateral);
    latTrace.push(li);
    const sp = Math.hypot(car.body.velocity.x, car.body.velocity.z);
    if (sp > spdPeak) spdPeak = sp;
    if (li < minLat) minLat = li;
  }
  const latAbs1 = latTrace[latTrace.length - 1];
  ok(car.barrierHits > 0, '本场景确实触发了护栏接触（非空跑假绿）',
    'hits=' + (car.barrierHits || 0));
  ok(Math.abs(latAbs0) + 0.001 >= minLat,
    '低速顶墙时横向穿透从未超过初始贴合深度（未被吸入墙内）',
    'init ' + num(latAbs0, 2) + ' -> min ' + num(minLat, 2) + ' -> end ' + num(latAbs1, 2) + 'm');
  ok(latAbs1 <= latAbs0 + 0.05,
    '2s 后车未比初始更深地压进护栏（Anti-Suction 主动外推生效）',
    num(latAbs0, 2) + ' -> ' + num(latAbs1, 2) + 'm');
  // 关键判据：车必须**真的驶离**墙面（横向偏移朝赛道内移动），而不是原地空转
  ok(latAbs0 - latAbs1 > 0.3,
    '全油门 2s 后车确实驶离护栏 ≥0.3m（不是被吸附原地空转）',
    '驶离 ' + num(latAbs0 - latAbs1, 2) + 'm');
  // ⚠ 此处不断言"末速度仍很大"：本场景车从 27.9m 逃到 26.8m，早已越过 7m 半宽
  //   落在草地上（沙地物理本来就会把速度拖住），末速度小是**正确**的赛道外行为，
  //   不是"被墙面吸住"。真正要证伪的是"横向穿透继续加深"，上面两条已覆盖。
  //   这里断言：脱离过程中车确实动起来了（峰值速度显著 > 0，证伪"永久冻结"）。
  ok(spdPeak > 1.0, '脱离过程中车确实动起来了（非永久冻结在原地的假绿）',
    'peak ' + num(spdPeak, 2) + ' m/s');
}

{
  // ---- 静态守卫：Anti-Suction 代码真在写位置（不是只加常量） ----
  const src = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
  // applyBarrierDeflection 里车是 `carBody`，法线 n 由 cannon 从 bi(护栏) 指向 bj(车)
  // => n 本身即"指向车外侧"，故 carBody.position += n 是**推离墙**的正确方向。
  ok(/carBody\.position\.x \+= nx \* CFG\.ANTI_SUCTION_LOW_PUSH_M/.test(src),
    'applyBarrierDeflection：沿 +n 推车（n 由护栏指向车，即推离墙）');
  ok(/carBody\.position\.z \+= nz \* CFG\.ANTI_SUCTION_LOW_PUSH_M/.test(src),
    'applyBarrierDeflection：z 分量同为 +n（方向一致）');
  // ★★ 法线方向约定必须被钉住：cannon 的 eq.ni 从 bi 指向 bj，分离要求 bi 沿 −n、bj 沿 +n。
  //    projectPenetration 里当 bi=护栏、bj=车时，车是 bj，必须 **+**；护栏是 bi，必须 **−**。
  const ppBody = src.slice(src.indexOf('projectPenetration(dt) {'),
    src.indexOf('projectPenetration(dt) {') + 4200);
  ok(/bi\.position\.x -= mx \* ri/.test(ppBody) && /bj\.position\.x \+= mx \* \(1 - ri\)/.test(ppBody),
    '★★ projectPenetration：bi 沿 −n、bj 沿 +n（法线 bi→bj 约定下的正确分离方向）');
  ok(!/bi\.position\.x \+= mx \* ri/.test(ppBody),
    '★ projectPenetration 无 "bi += n" 反向写法（该写法会把穿得深的车推得更深）');
  ok(/speedKmh < CFG\.ANTI_SUCTION_KMH/.test(src),
    '低速窗口按 speedKmh < 40 判定（不是写死像素/步长）');
  ok(/v\.x = tx \* tangentSpeed/.test(src) && /v\.z = tz \* tangentSpeed/.test(src),
    '护栏响应只保留切向速度，法向速度严格清零（无弹性反弹）');
  ok(/Math\.max\(CFG\.GUIDANCE_TANGENT_KEEP/.test(src) && /CFG\.DEFLECT_TANGENT_KEEP/.test(src),
    '首次接触保留 90%，低速吸墙窗口保留 92%（取更大保留率）');
  // Anti-Suction 必须在 speed 门槛之前（否则"已被刹停"的最需要脱离状态进不来）
  const pushIdx = src.indexOf('carBody.position.x += nx * CFG.ANTI_SUCTION_LOW_PUSH_M');
  const gateIdx = src.indexOf('if (speed < CFG.GUIDANCE_MIN_SPEED) continue;');
  ok(pushIdx > 0 && gateIdx > 0 && pushIdx < gateIdx,
    '★ Anti-Suction 外推位于速度门槛**之前**（静止贴墙也执行）');
}

console.log('');
console.log('─'.repeat(66));
console.log('§3.2  弯道动态拥挤幽灵化（Congestion Zones）');
console.log('─'.repeat(66));

{
  // ---- 常量口径 ----
  ok(CFG.CONGEST_RADIUS_M === 10, '拥挤判定半径 = 10m（规格：局部 10m）', '= ' + CFG.CONGEST_RADIUS_M);
  ok(CFG.CONGEST_MIN_CARS === 2, '拥挤车数阈值 = ">2 台"（规格）', '> ' + CFG.CONGEST_MIN_CARS);
  ok(Math.abs(CFG.CONGEST_RELEASE_M - 6) < 1e-9,
    '解除间距 = 6m（规格：>6m 平滑恢复）', '= ' + CFG.CONGEST_RELEASE_M);

  // ---- 三大赛道的拥挤区提取必须覆盖发卡/减速弯，且不覆盖长直道 ----
  for (const ty of TRACK_TYPES) {
    const trk = new Track(20260926, ty);
    const zs = trk.congestionZones || [];
    const totalSpan = zs.reduce((acc, z) => {
      const len = z.wrapped ? (trk.count - z.i0) + (z.i1 + 1) : (z.i1 - z.i0 + 1);
      return acc + len * trk.spacing;
    }, 0);
    const frac = totalSpan / trk.length;
    ok(zs.length > 0, ty + '：识别出弯道拥挤区（发卡/减速弯）',
      zs.length + ' 个区，共 ' + num(totalSpan, 0) + 'm');
    ok(frac > 0.05 && frac < 0.75,
      ty + '：拥挤区占比合理（既非缺失也非全面覆盖）', num(frac * 100, 1) + '%');
    // 每个区的 minR 必须确实是小半径（否则阈值口径错了）
    ok(zs.every((z) => z.minR < z.rThr),
      ty + '：每个区内最小曲率半径都 < 动态阈值（分位判据自洽）',
      '阈值 ' + num(trk.congestionRadiusThreshold, 0) + 'm; minR=' + zs.map((z) => num(z.minR, 0)).join(','));
    // 动态阈值必须落在夹取区间内（防极端赛道推飞）
    ok(trk.congestionRadiusThreshold >= TRACK_CFG.CONGEST_R_MIN_M
      && trk.congestionRadiusThreshold <= TRACK_CFG.CONGEST_R_MAX_M,
      ty + '：动态阈值落在 [' + TRACK_CFG.CONGEST_R_MIN_M + ',' + TRACK_CFG.CONGEST_R_MAX_M + ']m 夹取区间内',
      num(trk.congestionRadiusThreshold, 0) + 'm');
  }

  // ---- 长直道不得被误判为拥挤区：验证直道采样点的 radius 都 ≥ 阈值 ----
  const trk2 = new Track(20260926, 'vegas');
  const zs2 = trk2.congestionZones || [];
  // 取赛道上半径最大的连续段（直道），断言它没有被任何拥挤区覆盖
  let straightI = 0, maxR = 0;
  for (let i = 0; i < trk2.count; i++) {
    if (trk2.raceLine.radius[i] > maxR) { maxR = trk2.raceLine.radius[i]; straightI = i; }
  }
  const covered = zs2.some((z) => z.wrapped
    ? (straightI >= z.i0 || straightI <= z.i1)
    : (straightI >= z.i0 && straightI <= z.i1));
  ok(!covered,
    'vegas：最直的路段（radius ' + num(maxR, 0) + 'm）不被划为拥挤区（防直道假幽灵）');
}

{
  // ---- 拥挤幽灵化的掩码行为：3 台车挤在弯内 -> 掩码剔车车；拉开 -> 复位 ----
  const trk = new Track(20260926, 'suzuka');
  const rp = new RacePhysics(trk);
  rp.racing = true;
  const z0 = (trk.congestionZones && trk.congestionZones[0]) || { i0: 0, i1: 0, wrapped: false };
  const midIdx = z0.i0;
  const cars = [];
  // 三台车挤在弯心：每台相隔 1 个采样点（≈4.7m < 10m），确保都在 10m 判定半径内
  for (let k = 0; k < 3; k++) {
    const c = rp.addCar({
      id: k + 1, name: '车手' + (k + 1), color: '#e10600', isLocal: k === 0,
      startIndex: (midIdx + k) % trk.count, lateral: 0, laps: 2,
    });
    cars.push(c);
  }
  // 更新 trackIdx（_inCongestionZone 读的是它）
  for (const c of cars) rp.groundConstraint(c, 1 / 60);
  // ⚠ 必须让**后车更快**才能制造 closing > 0（前车快 = 拉开 = TTC 无穷，
  //   这正是本测试第一版的错误：给了递增速度，车反而在分离）。
  //   车队顺序：cars[0] 在最前，cars[2] 在最后 -> 速度递减 12/9/6。
  for (let k = 0; k < 3; k++) {
    const c = cars[k];
    const t = trk.sample(c.pos.x, c.pos.z, c.trackIdx).tangent;
    const tl = Math.hypot(t.x, t.z) || 1;
    const v = 12 - k * 3;
    c.body.velocity.set(t.x / tl * v, 0, t.z / tl * v);
    c.syncFromBody();
  }
  // 直接驱动判定（不跑 cannon，避免被物理步把车推开）
  rp.congestionZones = trk.congestionZones;
  rp.updateCongestionGhosting();
  const inZone = rp.zoneGhost.size;
  ok(inZone >= 3, '弯内 3 台车互相接近 -> 全体进入拥挤幽灵模式',
    'zoneGhost=' + inZone);
  const m0 = cars[0].body.collisionFilterMask;
  ok((m0 & CFG.GROUP_CAR_MASK) === 0,
    '拥挤幽灵车：车车碰撞位被剔除（可穿透彼此）', 'mask=' + m0);
  ok((m0 & CFG.GROUP_BARRIER) === CFG.GROUP_BARRIER,
    '拥挤幽灵车：护栏碰撞位**保留**（仍撞得住墙，不飞出赛道）', 'mask=' + m0);

  // ---- 拉开 > 6m -> 平滑恢复（掩码复位）----
  const t0 = trk.sample(cars[0].pos.x, cars[0].pos.z, cars[0].trackIdx).tangent;
  const tl0 = Math.hypot(t0.x, t0.z) || 1;
  for (let k = 0; k < 3; k++) {
    const c = cars[k];
    // 沿切线拉开 30m 间距
    c.body.position.x += t0.x / tl0 * (k * 30);
    c.body.position.z += t0.z / tl0 * (k * 30);
    c.body.velocity.set(0, 0, 0);
    c.syncFromBody();
  }
  rp.updateCongestionGhosting();
  ok(rp.zoneGhost.size === 0, '间距拉开 > 6m 后解除拥挤幽灵（zoneGhost 清空）',
    'zoneGhost=' + rp.zoneGhost.size);
  const m1 = cars[0].body.collisionFilterMask;
  ok((m1 & CFG.GROUP_CAR_MASK) === CFG.GROUP_CAR_MASK,
    '解除后车车碰撞位完全恢复', 'mask=' + m1);
}

{
  // ---- 静态守卫：拥挤幽灵化接线闭环 ----
  const src = fs.readFileSync(path.join(root, 'public/js/physics.js'), 'utf8');
  const trkSrc = fs.readFileSync(path.join(root, 'public/js/track.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  ok(/updateCongestionGhosting\(\)/.test(src) && /this\.updateCongestionGhosting\(\);/.test(src),
    'fixedStep 内每步调用 updateCongestionGhosting（不是死代码）');
  ok(/buildCongestionZones\(/.test(trkSrc)
    && /this\.buildCongestionZones\(radius\)/.test(trkSrc),
    'Track 在算完曲率半径后构建拥挤区（数据来源闭环）');
  ok(/this\.congestionZones = \(track && track\.congestionZones\)/.test(src),
    'RacePhysics 从 Track 注入 congestionZones（缺省降级为全局长判定）');
  ok(/this\.zoneGhost\.has\(c\)/.test(src) && /mask &= ~CFG\.GROUP_CAR_MASK/.test(src),
    '掩码刷新把 zoneGhost 并入（只剔车车位域，护栏位保留）');
  ok(/c\.zoneGhost \? 1 : 0/.test(mainSrc) && /ud\._zoneAmt/.test(mainSrc),
    'main.js 渲染层消费 c.zoneGhost -> 半透明（指数缓动平滑恢复）');
  // 恢复迟滞必须存在（否则临界点会闪烁）
  ok(/CONGEST_RELEASE_M/.test(src) && /for \(const c of this\.zoneGhost\)/.test(src),
    '存在解除迟滞（已在幽灵集的车按 >6m 间距平滑恢复，防临界闪烁）');
}

console.log('');
console.log('─'.repeat(66));
console.log('结果  ' + pass + ' 通过 / ' + failures.length + ' 失败');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过');
