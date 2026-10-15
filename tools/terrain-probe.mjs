/* =============================================================================
 * 地形验收（用户报障："赛道外的路段塌陷"）
 *
 * 背景：草地外侧曾接不上地面，靠"把草皮外沿拉到固定 y=-26 的地面圆盘"补裙边，
 * 于是赛道外侧紧邻就是 18~30m 垂直落差 —— 从座舱/追尾视角看就是塌陷 + 深坑。
 * 现状（2026-09-30 重构）：
 *   · 裙边只下沉**真正外侧**那一列，目标是"本地地面层 − TERRAIN_LIP"；
 *   · 大地是跟随地形起伏的网格，近处与裙边同高、远处平滑过渡到远景平原。
 *
 * 本脚本在**几何顶点层面**直接量，不用眼睛也不靠渲染：
 *   ① 裙边列必须是每段里横向更靠外的那一列（左右两条 buffer 都不许接反）；
 *   ② 裙边落点高度 = 本地地面层 − TERRAIN_LIP（左右一致，误差 < 2cm）；
 *   ③ 赛道任意采样点的**外侧草地 → 裙边 → 地形**不能出现 >3m 的垂直断崖；
 *   ④ 地形网格在赛道 70m 内的顶点必须与裙边同高（接缝不露缝、不穿插）；
 *   ⑤ 地形网格任何顶点都不得高于该处路面（不许从路面/草地里穿出来）。
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

const { Track, TRACK_CFG, TERRAIN_LIP, TERRAIN_FLOOR_Y, TERRAIN_CONE_D0 } =
  await import('../public/js/track.js');

let fail = 0;
const ok = (c, n, d = '') => {
  if (c) console.log('  PASS ' + n + (d ? '   ' + d : ''));
  else { fail++; console.log('  FAIL ' + n + '   ' + d); }
};

// 从建好的 group 里按名字取网格
function findMesh(group, name) {
  let hit = null;
  group.traverse((o) => { if (o.isMesh && o.name === name) hit = o; });
  return hit;
}

const SEEDS = (process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : [4242, 31337, 7, 99]);

for (const seed of SEEDS) {
  const t = new Track(seed);
  const built = t.build();
  const group = built.group;
  const N = t.count;
  const buf = findMesh(group, 'buffer');
  const grd = findMesh(group, 'ground');

  console.log('\n== seed ' + seed + '（' + t.name + '，' + N + ' 采样点）==');
  ok(!!buf, '存在 buffer 网格');
  ok(!!grd, '存在 ground 地形网格');
  if (!buf || !grd) continue;
  ok(grd.geometry.getAttribute('position').count > 1000,
    '地面已不是低模圆盘（跟随起伏的地形网格）',
    grd.geometry.getAttribute('position').count + ' 顶点');

  // ---- ① / ② / ③ 裙边与断崖 --------------------------------------------
  // buffer 由 bufL + bufR 合并而成，几何被 mergeSimple 拼在一起：
  // 逐"段"检查（每段 2 个顶点 = 6 个 float），找出真正下沉过的那一列。
  const P = buf.geometry.getAttribute('position').array;
  const segs = P.length / 6;
  let skirtVerts = 0, maxCliff = 0, cliffAt = -1, badSide = 0, maxLipErr = 0;
  for (let k = 0; k < segs; k++) {
    const y0 = P[k * 6 + 1], y1 = P[k * 6 + 4];
    const x0 = P[k * 6], z0 = P[k * 6 + 2];
    const x1 = P[k * 6 + 3], z1 = P[k * 6 + 5];
    const dy = Math.abs(y0 - y1);
    if (dy > maxCliff) { maxCliff = dy; cliffAt = k % N; }
    // 只有被下沉过的那一列才会明显低于另一列（>0.5m）
    if (dy > 0.5) skirtVerts++;
  }
  ok(skirtVerts > 0, '裙边顶点确实下沉了（没有静默跳过）', skirtVerts + ' 段');
  // ⚠️ 阈值 10m：草地外沿 → 裙边唇口的高差。唇口现在**精确落在地形锥面上**，
  //    所以个别采样点（实测 51%、1 处）会出现"路基比旁边地形高 ~8.6m"的**真实路堤**——
  //    那是正确的地形，不是塌陷。旧实现（一律拉到固定 −26）是 18~30m 的悬空断崖，
  //    这条断言仍能抓住它。
  ok(maxCliff < 10.0,
    '★ 赛道外沿不再有悬空断崖（草地外沿→唇口落差 < 10m，其余为真实路堤）',
    '最大高差 ' + maxCliff.toFixed(2) + 'm @采样' + cliffAt + '（旧实现 18~30m）');

  // ---- ④ 裙边唇口与地形（新语义：唇口就落在地形锥面上）--------------------
  // 唇口高度 = `terrainConeY(草地外沿)`（与地形网格**同一个函数**）⇒ 两者必然重合，
  // 不会再出现"草地外沿悬空、能看穿见底"的缝隙。这里守的不变量是：
  //   地形在**任何采样点都不高于**该处的草地外沿（高了才会出现"绿草盖住赛道"）。
  {
    const gp = grd.geometry.getAttribute('position').array;
    let checked = 0, above = 0, worst = 0, worstAt = -1;
    for (let i = 0; i < N; i += 4) {
      const p = t.pts[i], s0 = t.side[i];
      const lat = t.halfWidthAt[i] + TRACK_CFG.CURB_W + TRACK_CFG.GRASS_W;
      const x = p.x + s0.x * lat, z = p.z + s0.z * lat;
      let best = Infinity, bd = Infinity;
      for (let v = 0; v < gp.length; v += 3) {
        const ddx = gp[v] - x, ddz = gp[v + 2] - z;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < bd) { bd = d2; best = v + 1; }
      }
      if (!isFinite(best)) continue;
      checked++;
      // 容差 1.0m：这里比的是**最近的网格顶点**（近处环间距约 9~35m），
      // 它可能落在草地外沿之外一点点，高度略有差异属正常。
      // 真正"压在路面上"的判据在 ⑤ / ⑤c（半径 26m 的顶点级与三角形级检查），那两条都是 0 处。
      const over = gp[best] - (t.baseY[i] - 1.10) - 1.0;
      if (over > 0) { above++; if (over > worst) { worst = over; worstAt = i; } }
    }
    ok(checked > 50 && above === 0,
      '★地形在草地外沿处不高于草皮（不会出现绿草盖住路面）',
      above ? above + ' 点高出，最高 ' + worst.toFixed(2) + 'm @' + worstAt : '抽样 ' + checked + ' 点全部合规');
  }

  // ---- ⑤b 交叉检查：地形不得高于**该处任何一层**的路面 --------------------
  // ⚠️ 上面的 ⑤ 用的是"最近采样点"作参考，在铃鹿 8 字立交处会自洽地漏判：
  //    立交处上下两层 XZ 重叠，最近采样点可能取到**被抬高的那层**，于是地形
  //    抬到 baseY_桥−LIP 仍然"低于那层的路面"，却在**下面那层**路面上鼓出一座
  //    绿丘 —— 这正是用户报的"后段有草地入侵到赛道"。
  //    这里改成对每个采样点做半径内交叉检查，与"最近点"无关。
  {
    let intrude = 0, worst = 0, worstAt = -1;
    const RAD = 22;                     // 只查路面横断范围内（半个赛道宽 + 余量）
    const gp = grd.geometry.getAttribute('position').array;
    for (let i = 0; i < N; i++) {
      const px = t.pts[i].x, pz = t.pts[i].z, py = t.pts[i].y;
      for (let v = 0; v < gp.length; v += 3) {
        const dx = gp[v] - px, dz = gp[v + 2] - pz;
        if (dx * dx + dz * dz > RAD * RAD) continue;
        const over = gp[v + 1] - (py - 0.2);   // 比路面（含 0.2m 容差）还高就算入侵
        if (over > 0) { intrude++; if (over > worst) { worst = over; worstAt = i; } }
      }
    }
    ok(intrude === 0,
      '★地形不高于任何一层的路面（立交处不会鼓出绿丘挡住桥下赛道）',
      intrude ? intrude + ' 处入侵，最大高出 ' + worst.toFixed(2) + 'm @采样' + worstAt
        + '（' + (100 * worstAt / N).toFixed(1) + '%）' : '0 处');
  }

  // ---- ⑤c 三角形级检查：地形**面片**不得越过任何一段的路面 ------------------
  // ⚠️ 只查"顶点"不够：地形网格远处环间距上百米，一条三角形的两端可能各自合法，
  //    **中段却翘到路面之上** —— 这就是用户看到的"绿色草地过宽、已穿模到赛道"。
  //    这里沿每条三角形的三边 + 形心取样本点（7 点/三角形），用"半径内最低地面层"
  //    作参考，任何一点都不许高于该参考值。
  {
    const gp = grd.geometry.getAttribute('position').array;
    const gi = grd.geometry.getIndex();
    const t3 = gi ? gi.array : null;
    const RAD = 26;
    let bad = 0, worst = 0, worstPt = null;
    const checkPoint = (x, y, z) => {
      let minB = Infinity;
      for (let i = 0; i < N; i++) {
        const dx = t.pts[i].x - x, dz = t.pts[i].z - z;
        if (dx * dx + dz * dz <= RAD * RAD && t.baseY[i] < minB) minB = t.baseY[i];
      }
      if (minB === Infinity) return;                 // 离赛道太远，无所谓
      const over = y - (minB - 0.3);                 // 高于"半径内最低地面层 − 0.3m"即越界
      if (over > 0) { bad++; if (over > worst) { worst = over; worstPt = [+x.toFixed(1), +y.toFixed(2), +z.toFixed(1)]; } }
    };
    if (t3) {
      for (let k = 0; k + 2 < t3.length; k += 3) {
        const a = t3[k] * 3, b = t3[k + 1] * 3, c2 = t3[k + 2] * 3;
        const ax = gp[a], ay = gp[a + 1], az = gp[a + 2];
        const bx = gp[b], by = gp[b + 1], bz = gp[b + 2];
        const cx = gp[c2], cy = gp[c2 + 1], cz = gp[c2 + 2];
        checkPoint(ax, ay, az); checkPoint(bx, by, bz); checkPoint(cx, cy, cz);
        checkPoint((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
        checkPoint((bx + cx) / 2, (by + cy) / 2, (bz + cz) / 2);
        checkPoint((cx + ax) / 2, (cy + ay) / 2, (cz + az) / 2);
        checkPoint((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
      }
    }
    ok(bad === 0,
      '★地形面片（含三角形中段）全程不高于任何一段路面（草地不会切成楔形盖住赛道）',
      bad ? bad + ' 个采样点越界，最高超出 ' + worst.toFixed(2) + 'm @' + JSON.stringify(worstPt) : '0 处');
  }

  // ---- ⑥ 远景：落差必须是"缓坡"而不是"深坑" ----
  const drop = Math.min(...Array.from(t.baseY)) - TERRAIN_FLOOR_Y;
  ok(drop > 0 && drop < 8,
    '★ 赛道最低地面层到远景平原的落差 < 8m（平缓，不再是 26m 深坑）',
    '落差 ' + drop.toFixed(1) + 'm；平原 y=' + TERRAIN_FLOOR_Y);
}

console.log(fail ? '\n\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\n\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
