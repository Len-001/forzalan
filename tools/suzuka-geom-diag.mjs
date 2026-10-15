/* 诊断导入的铃鹿折线：找长段（OSM 缺顶点）与近重复点（会造成 179° 折返尖点）。
 * 用法： node tools/suzuka-geom-diag.mjs
 */
import fs from 'node:fs';
const { SUZUKA_GEOMETRY: G } = await import(new URL('../public/js/suzuka-geometry.js', import.meta.url));
const P = G.pts, N = P.length;
const segs = [];
for (let i = 0; i < N; i++) {
  const q = P[(i + 1) % N];
  segs.push({ i, len: Math.hypot(q[0] - P[i][0], q[1] - P[i][1]) });
}
const lens = segs.map((s) => s.len).sort((a, b) => a - b);
console.log('点数 ' + N + '  段长: min=' + lens[0].toFixed(3) + 'm p50=' + lens[N >> 1].toFixed(1)
  + 'm p90=' + lens[Math.floor(N * 0.9)].toFixed(1) + 'm p99=' + lens[Math.floor(N * 0.99)].toFixed(1)
  + 'm max=' + lens[N - 1].toFixed(1) + 'm');
console.log('\n超过 40m 的长段（OSM 在这些地方缺顶点）：');
for (const s of segs.filter((x) => x.len > 40).sort((a, b) => b.len - a.len)) {
  console.log('  段 ' + String(s.i).padStart(3) + '  长 ' + s.len.toFixed(1).padStart(6) + 'm  '
    + '从 (' + P[s.i][0].toFixed(0) + ',' + P[s.i][1].toFixed(0) + ') 到 ('
    + P[(s.i + 1) % N][0].toFixed(0) + ',' + P[(s.i + 1) % N][1].toFixed(0) + ')');
}
console.log('\n小于 0.5m 的近重复点（会造成 179° 尖点）：');
let dup = 0;
for (const s of segs) if (s.len < 0.5) { dup++; if (dup <= 12) console.log('  段 ' + String(s.i).padStart(3) + '  长 ' + s.len.toFixed(3) + 'm  (' + P[s.i][0].toFixed(2) + ',' + P[s.i][1].toFixed(2) + ')'); }
console.log('  共 ' + dup + ' 处');

/* 转折角：相邻段方向变化 > 60° 的地方 */
console.log('\n转折 > 60° 的点（真车弯道没那么尖）：');
let kinks = 0;
for (let i = 1; i < N; i++) {
  const a0 = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]);
  const j = (i + 1) % N;
  const a1 = Math.atan2(P[j][1] - P[i][1], P[j][0] - P[i][0]);
  let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d;
  if (d > 60 * Math.PI / 180) {
    kinks++;
    if (kinks <= 12) {
      console.log('  点 ' + String(i).padStart(3) + '  转折 ' + (d * 180 / Math.PI).toFixed(1).padStart(6) + '°  '
        + '段长 ' + segs[i - 1].len.toFixed(2) + 'm → ' + segs[i].len.toFixed(2) + 'm  ('
        + P[i][0].toFixed(1) + ',' + P[i][1].toFixed(1) + ')');
    }
  }
}
console.log('  共 ' + kinks + ' 处');
