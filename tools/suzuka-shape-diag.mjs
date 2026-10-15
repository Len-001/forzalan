/* 形状诊断：把导入的铃鹿中心线画成 ASCII 图 + 统计曲率/直道，用来肉眼核对"像不像铃鹿"。
 * 用法： node tools/suzuka-shape-diag.mjs [geometry.js]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = process.argv[2] || path.join(root, 'public/js/suzuka-geometry.js');
const { SUZUKA_GEOMETRY: G } = await import(pathToFileURL(path.resolve(p)).href);
const P = G.pts;
console.log('点数 ' + P.length + '  周长 ' + G.osmPerimeter + 'm  自交 ' + G.selfIntersections
  + '  bbox ' + JSON.stringify(G.bbox) + '  中心 ' + JSON.stringify(G.center));

/* ---- ASCII 图 ---- */
const W = 108, H = 40;
let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
for (const [x, z] of P) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
const sx = (maxx - minx) / (W - 1), sz = (maxz - minz) / (H - 1);
const s = Math.max(sx, sz);
const grid = Array.from({ length: H }, () => new Array(W).fill(' '));
// 先画方向箭头（每 8% 周长标一个：0-9 表示圈上位置），再补线
const toPix = ([x, z]) => [Math.round((x - minx) / s), H - 1 - Math.round((z - minz) / s)];
let cum = 0;
const marks = [];
const per = G.osmPerimeter;
for (let i = 0; i < P.length; i++) {
  const a = toPix(P[i]), b = toPix(P[(i + 1) % P.length]);
  const seg = Math.hypot(P[(i + 1) % P.length][0] - P[i][0], P[(i + 1) % P.length][1] - P[i][1]);
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))));
  for (let t = 0; t <= steps; t++) {
    const gx = Math.round(a[0] + (b[0] - a[0]) * t / steps);
    const gy = Math.round(a[1] + (b[1] - a[1]) * t / steps);
    if (gx >= 0 && gx < W && gy >= 0 && gy < H && grid[gy][gx] === ' ') grid[gy][gx] = '.';
  }
  cum += seg;
  const pct = cum / per;
  if (!marks.length || pct - marks[marks.length - 1].pct >= 0.05) {
    marks.push({ pct, gx: a[0], gy: a[1] });
  }
}
for (const m of marks) {
  const d = String(Math.min(9, Math.floor(m.pct * 10)));
  if (m.gx >= 0 && m.gx < W && m.gy >= 0 && m.gy < H) grid[m.gy][m.gx] = d;
}
// 起点/终点参考
const [g0x, g0y] = toPix(P[0]);
grid[g0y][g0x] = 'S';
console.log('\n俯视图（x 向右为东，z 向上为北；数字 = 圈上 5% 一档，S = 起终点）：');
console.log('  +' + '-'.repeat(W) + '+');
for (const row of grid) console.log('  |' + row.join('') + '|');
console.log('  +' + '-'.repeat(W) + '+');

/* ---- 曲率统计：找直道与急弯 ---- */
const N = P.length;
const radius = [];
for (let i = 0; i < N; i++) {
  const a = P[(i - 2 + N) % N], b = P[i], c = P[(i + 2) % N];
  const abx = b[0] - a[0], abz = b[1] - a[1], bcx = c[0] - b[0], bcz = c[1] - b[1];
  const cross = abx * bcz - abz * bcx;
  const la = Math.hypot(abx, abz), lc = Math.hypot(bcx, bcz);
  const ang = Math.abs(Math.atan2(cross, abx * bcx + abz * bcz));
  const ds = (la + lc) / 2;
  radius.push(ang < 1e-6 ? 1e6 : ds / ang);
}
const rs = radius.slice().sort((x, y) => x - y);
console.log('\n弯道半径：p05=' + rs[Math.floor(N * 0.05)].toFixed(0) + 'm p50=' + rs[N >> 1].toFixed(0)
  + 'm p95=' + rs[Math.floor(N * 0.95)].toFixed(0) + 'm  max=' + rs[N - 1].toFixed(0) + 'm');
const straights = radius.filter((r) => r > 900).length;
console.log('近直道占比 ' + (straights / N * 100).toFixed(1) + '%（半径 > 900m）');

/* ---- 最长连续近直道 + 最急弯位置 ---- */
function longestRun(pred) {
  let bl = 0, s0 = 0, cur = 0, cs = 0;
  for (let i = 0; i < N * 2; i++) {
    if (pred(radius[i % N])) { if (cur === 0) cs = i; cur++; if (cur > bl) { bl = cur; s0 = cs; } }
    else cur = 0;
    if (bl >= N) break;
  }
  return { len: Math.min(bl, N), start: s0 % N };
}
const lr = longestRun((r) => r > 900);
let meters = 0;
for (let k = 0; k < lr.len; k++) {
  const i = (lr.start + k) % N, j = (i + 1) % N;
  meters += Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]);
}
console.log('最长连续近直道 = ' + meters.toFixed(0) + 'm（真车主直道 1200m）  起点段索引 ' + lr.start);
let tightest = 0;
for (let i = 0; i < N; i++) if (radius[i] < radius[tightest]) tightest = i;
console.log('最急弯 半径=' + radius[tightest].toFixed(0) + 'm @点' + tightest
  + '（真车发卡/减速弯半径约 15~25m）');

/* ---- 自交点位置 ---- */
console.log('投影自交 ' + G.selfIntersections + ' 处（立体交叉：主赛道与西直道在投影上相交、高程不同）');
