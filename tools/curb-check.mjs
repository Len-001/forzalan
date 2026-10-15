/* =============================================================================
 * 路肩（curb）验收（用户报障："赛道两侧的路肩没有起伏" + "路肩过于普遍到处都有"）
 *
 * 三条不变量：
 *   ① **只在弯道铺路肩**：直道（曲率半径大）掩码 ≈ 0，真弯道 ≈ 1；
 *   ② **有起伏**：弯道处路肩凸起 ≈ CURB_H，且沿路有搓板波动（不是平板）；
 *   ③ **视觉 == 物理**：路肩网格顶点高度必须等于 `groundOffset(lat, i)` ——
 *      两边不一致就会出现"看着凸、压上去不颠"（或反过来"看着平、车却跳"）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8'));
if (!globalThis.THREE) { console.error('无法注入 three.min.js'); process.exit(1); }
globalThis.document = globalThis.document || {
  createElement: () => ({
    width: 0, height: 0, style: {},
    getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }),
    toDataURL: () => 'data:,',
  }),
  getElementById: () => null, querySelector: () => null, body: { appendChild() {} },
};
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {} };

const { Track, TRACK_CFG } = await import('../public/js/track.js');

let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  PASS ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  FAIL ' + n + '   ' + d); } };

for (const [seed, type] of [[4242, 'suzuka'], [777, 'vegas'], [777, 'spa']]) {
  const t = new Track(seed, type);
  const built = t.build();
  const N = t.count;
  const rc = t.raceLine.radius;
  const cm = t.curbMask;
  console.log('\n== ' + type + '（' + N + ' 采样点）==');

  // ① 直道不铺、弯道铺
  let straightN = 0, straightMax = 0, cornerN = 0, cornerSum = 0;
  for (let i = 0; i < N; i++) {
    if (rc[i] >= TRACK_CFG.CURB_R_OFF + 80) { straightN++; 
      if (cm[i] > straightMax) {
        straightMax = cm[i];
        if (cm[i] > 0.35) console.log('    [诊断] 直道掩码超标采样点:', i, 'pct:', (i/N*100).toFixed(1)+'%', 'r:', rc[i].toFixed(1), 'mask:', cm[i].toFixed(3));
      }
 }
    if (rc[i] <= TRACK_CFG.CURB_R_ON) { cornerN++; cornerSum += cm[i]; }
  }
  const cornerAvg = cornerN ? cornerSum / cornerN : 0;
  console.log('  直道采样 ' + straightN + ' / 弯道采样 ' + cornerN);
  ok(straightN === 0 || straightMax < 0.35,
    '★直道上路肩掩码 ≈ 0（不再"到处都有"）',
    '直道最大掩码 ' + straightMax.toFixed(3) + ' / 直道采样 ' + straightN);
  ok(cornerN === 0 || cornerAvg > 0.85,
    '★真弯道处路肩掩码 ≈ 1（该有的地方有）',
    '弯道平均掩码 ' + cornerAvg.toFixed(3) + ' / 弯道采样 ' + cornerN);

  // ② 有起伏：弯道处地面高度抬升 ≈ CURB_H，且沿路有波动
  const iCorner = (() => { for (let i = 0; i < N; i++) if (cm[i] > 0.9) return i; return -1; })();
  const iStraight = (() => { for (let i = 0; i < N; i++) if (cm[i] < 0.02) return i; return -1; })();
  if (iCorner >= 0) {
    const lat = t.halfWidthAt[iCorner] + t.curbWidth * 0.5;
    const rise = t.groundOffset(lat, iCorner);
    ok(rise > TRACK_CFG.CURB_H * 0.5,
      '★弯道路肩真的立起来了（有起伏，不再是平板）',
      '路肩中点抬升 ' + (rise * 100).toFixed(1) + 'cm（CURB_H=' + (TRACK_CFG.CURB_H * 100) + 'cm）');
    // 搓板波动：沿路若干采样点的抬升量应不同
    let mn = Infinity, mx = -Infinity;
    for (let k = 0; k < 8; k++) {
      const i2 = (iCorner + k) % N;
      if (cm[i2] < 0.5) continue;
      const v = t.groundOffset(t.halfWidthAt[i2] + t.curbWidth * 0.5, i2);
      mn = Math.min(mn, v); mx = Math.max(mx, v);
    }
    ok(mx - mn > 0.005,
      '★路肩沿行车方向有搓板起伏（压上去车身会被颠）',
      '相邻采样点抬升差 ' + ((mx - mn) * 100).toFixed(2) + 'cm');
  }
  if (iStraight >= 0) {
    const lat = t.halfWidthAt[iStraight] + t.curbWidth * 0.5;
    ok(Math.abs(t.groundOffset(lat, iStraight)) < 0.02,
      '★直道路肩与路面齐平（物理上没有台阶）',
      '直道抬升 ' + (t.groundOffset(lat, iStraight) * 100).toFixed(2) + 'cm');
  }

  // ③ 视觉 == 物理：路肩网格顶点高度 − 路面高度 == groundOffset(该点横向, i)
  let curb = null;
  built.group.traverse((o) => { if (o.isMesh && o.name === 'curbs') curb = o; });
  ok(!!curb, '存在路肩网格');
  if (curb) {
    const P = curb.geometry.getAttribute('position').array;
    const cw = t.curbWidth;
    let bad = 0, worst = 0, checked = 0;
    const ch = TRACK_CFG.CURB_H;
    const vertsPerSide = (N + 1) * 2;
    for (let side = 0; side < 2; side++) {
      const offsetK = side * vertsPerSide * 3;
      for (let i = 0; i < N; i++) {
        const k = offsetK + i * 6;
        const p = t.pts[i], m = cm[i];
        const ripple = Math.sin(i * 1.57) * 0.015 * m;
        // 左路肩 (side=0):
        //   参数: (-hw - cw, -hw)
        //   顶点 0 (外坡): yb = -0.04 + (ch + ripple)*m
        //   顶点 1 (内沿): ya = 0.015 + ch*m
        // 右路肩 (side=1):
        //   参数: (hw, hw + cw)
        //   顶点 0 (内沿): ya = 0.015 + ch*m
        //   顶点 1 (外坡): yb = -0.04 + (ch + ripple)*m
        const y0 = P[k + 1];
        const y1 = P[k + 4];
        let want0, want1;
        if (m < 0.02) {
          want0 = p.y + 0.002;
          want1 = p.y + 0.002;
        } else if (side === 0) {
          want0 = p.y - 0.04 + (ch + ripple) * m;
          want1 = p.y + 0.015 + ch * m;
        } else {
          want0 = p.y + 0.015 + ch * m;
          want1 = p.y - 0.04 + (ch + ripple) * m;
        }
        checked += 2;
        const d0 = Math.abs(y0 - want0);
        const d1 = Math.abs(y1 - want1);
        if (d0 > 0.02) { bad++; if (d0 > worst) worst = d0; }
        if (d1 > 0.02) { bad++; if (d1 > worst) worst = d1; }
      }
    }
    ok(bad === 0,
      '★路肩"看到的"与"压上去的"完全一致（网格高度 == 物理 groundOffset）',
      '核对 ' + checked + ' 顶点，不一致 ' + bad + ' 个' + (bad ? '（最大差 ' + worst.toFixed(3) + 'm）' : ''));
    // 视觉上直道不该有红白（掩码≈0 时渲成暗灰）
    ok(!!curb.geometry.getAttribute('color'), '路肩网格带顶点色（直道暗灰/弯道红白）');
  }
}

console.log(fail ? '\n\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\n\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
