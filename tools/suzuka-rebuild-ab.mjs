/* 铃鹿重建后的几何 A/B：在几组平滑参数下量「全长 / 最小半径 / 自交数 / 发卡半径」，
 * 用来挑出既不磨圆发卡、又不在路面留下可见折角的那组。
 *
 * 用法： node tools/suzuka-rebuild-ab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

(0, eval)(fs.readFileSync(path.join(root, 'public/libs/three.min.js'), 'utf8'));
const ctx2d = new Proxy({}, { get: (_, k) => ((k === 'createLinearGradient' || k === 'createRadialGradient') ? () => ({ addColorStop() {} }) : k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
globalThis.document = globalThis.document || { createElement: (t) => (t === 'canvas' ? { width: 0, height: 0, style: {}, getContext: () => ctx2d } : { style: {} }), createElementNS: () => ({ getContext: () => ctx2d, style: {} }), addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis.window || { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };

const { Track, TRACK_CFG } = await import(mod('public/js/track.js'));
const N = TRACK_CFG.N;

function analyse(trk) {
  const P = trk.pts;
  let len = 0;
  for (let i = 0; i < N; i++) { const q = P[(i + 1) % N]; len += Math.hypot(q.x - P[i].x, q.z - P[i].z); }
  // 自交（XZ 投影）
  let cross = 0, crossAt = [];
  for (let i = 0; i < N; i++) {
    const a = P[i], b = P[(i + 1) % N];
    for (let j = i + 1; j < N; j++) {
      const gap = Math.min(Math.abs(i - j), N - Math.abs(i - j));
      if (gap < 10) continue;
      const c = P[j], d = P[(j + 1) % N];
      const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
      const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { cross++; if (crossAt.length < 4) crossAt.push([i, j]); }
    }
  }
  // 曲率半径
  const R = [];
  for (let i = 0; i < N; i++) {
    const a = P[(i - 2 + N) % N], b = P[i], c = P[(i + 2) % N];
    const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
    const cr = abx * bcz - abz * bcx;
    const la = Math.hypot(abx, abz), lc = Math.hypot(bcx, bcz);
    const ang = Math.abs(Math.atan2(cr, abx * bcx + abz * bcz));
    R.push(ang < 1e-6 ? 1e6 : ((la + lc) / 2) / ang);
  }
  const Rs = R.slice().sort((x, y) => x - y);
  // 桥层：pts.y - baseY > 1 的段数
  let onBridge = 0, maxLift = 0;
  for (let i = 0; i < N; i++) { const d = P[i].y - trk.baseY[i]; if (d > 1) onBridge++; if (d > maxLift) maxLift = d; }
  // 折角：相邻段方向变化的**最大单点转折**
  let maxKink = 0, kinkAt = -1;
  for (let i = 1; i < N; i++) {
    const a0 = Math.atan2(P[i].z - P[i - 1].z, P[i].x - P[i - 1].x);
    const j = (i + 1) % N;
    const a1 = Math.atan2(P[j].z - P[i].z, P[j].x - P[i].x);
    let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > maxKink) { maxKink = d; kinkAt = i; }
  }
  return { len, cross, crossAt, r05: Rs[Math.floor(N * 0.05)], rMin: Rs[0], onBridge, maxLift,
    maxKinkDeg: maxKink * 180 / Math.PI, kinkAt, hwMin: trk.halfWidthMin, hwMax: trk.halfWidthMax };
}

/* 基准：真实数据的要求 */
console.log('真实铃鹿基准：单圈 5807m；发卡半径约 14m；立体交叉 1 处；路宽 10~16m\n');

/* 用几组平滑参数重建（直接改平滑常量后重建，避免复制代码） */
const combos = JSON.parse(process.env.COMBOS || '[[0,0.42],[1,0.25],[1,0.42],[2,0.30],[3,0.42]]');
for (const [passes, k] of combos) {
  TRACK_CFG.SMOOTH_PASSES = passes;
  TRACK_CFG.SMOOTH_K = k;
  const trk = new Track(20260922, 'suzuka');
  const d = analyse(trk);
  console.log('passes=' + passes + ' k=' + k
    + '  全长 ' + d.len.toFixed(0) + 'm (偏差 ' + ((d.len / 5807 - 1) * 100).toFixed(2) + '%)'
    + '  自交 ' + d.cross
    + '  最小半径 ' + d.rMin.toFixed(1) + 'm'
    + '  p05 ' + d.r05.toFixed(0) + 'm'
    + '  最大单点转折 ' + d.maxKinkDeg.toFixed(1) + '° @' + d.kinkAt
    + '  桥上段 ' + d.onBridge + ' (抬升 ' + d.maxLift.toFixed(1) + 'm)');
  if (d.cross > 1) console.log('      ⚠️ 自交 ' + d.cross + ' 处 ' + JSON.stringify(d.crossAt));
}
