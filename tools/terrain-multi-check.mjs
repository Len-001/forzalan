import fs from 'node:fs';
import { Track, TRACK_CFG, TERRAIN_FLOOR_Y } from '../public/js/track.js';
(0, eval)(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
globalThis.document = { createElement: () => ({ style: {}, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) }), getElementById: () => null, body: { appendChild() {} } };
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
const types = (process.env.TRACKS || 'suzuka,vegas,spa').split(',');
let fail = 0;
const ok = (v, text, detail) => { console.log((v ? 'PASS ' : 'FAIL ') + text + (detail ? '  ' + detail : '')); if (!v) fail++; };
for (const type of types) {
  const t = new Track(4242, type); t.build();
  let maxStep = 0, minY = Infinity, maxY = -Infinity, nonFinite = 0, layerDrop = 0, layerAt = -1;
  const ring = [t.halfWidth + t.curbWidth + 1.0, t.halfWidth + t.curbWidth + 4, t.halfWidth + t.curbWidth + 10, t.halfWidth + t.curbWidth + 20, t.halfWidth + t.curbWidth + 35];
  for (const lat of ring) for (const side of [1, -1]) {
    let prev = null;
    for (let i = 0; i < t.count; i++) {
      const p=t.pts[i], s=t.side[i], y=t.terrainConeY(p.x+s.x*side*lat,p.z+s.z*side*lat);
      if (!Number.isFinite(y)) nonFinite++;
      minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      if (prev !== null) { const d=Math.abs(y-prev); if(d>maxStep)maxStep=d; }
      prev=y;
    }
  }
  for(let i=0;i<t.count;i++){const j=(i+1)%t.count;const d=Math.abs(t.baseY[j]-t.baseY[i]);if(d>layerDrop){layerDrop=d;layerAt=i;}}
  ok(nonFinite===0, `${type} 外围地形高度全部有限`, `bad=${nonFinite}`);
  ok(maxStep < 1.5, `${type} 外围地形沿圈连续`, `最大相邻落差=${maxStep.toFixed(3)}m`);
  ok(minY >= TERRAIN_FLOOR_Y - 1e-6, `${type} 地形不低于远景地面`, `min=${minY.toFixed(2)}m`);
  ok(layerDrop < 1.0, `${type} 路面层高程没有台阶`, `最大路面相邻落差=${layerDrop.toFixed(3)}m @${layerAt}`);
  if (type === 'suzuka') {
    let bridgeBad=0;
    for(let i=0;i<t.count;i++) if(t.bridgeMask?.[i] && t.terrainConeY(t.pts[i].x,t.pts[i].z) < t.baseY[i]-3.0) bridgeBad++;
    ok(bridgeBad===0, 'suzuka 立交附近没有被低层地形拉穿', `bad=${bridgeBad}`);
  }
}
console.log(fail ? `失败 ${fail} 项` : '全部通过');
process.exitCode=fail?1:0;
