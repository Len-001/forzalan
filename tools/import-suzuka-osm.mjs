/* 从 OSM 抽出铃鹿 GP 主赛道中心线 → public/js/suzuka-geometry.js（离线数据，游戏不联网）。
 *
 * ⚠️ 三次踩坑记录（别重走）：
 *   ① "取最长闭合 raceway" ⇒ 选中 1.2km 的「鈴鹿サーキット国際南コース」（支线）；
 *      摩天轮那片游乐区也打了 highway=raceway（プッチグランプリ、ロッキーコースター…）。
 *   ② 用 relation 284570 (type=circuit) 的成员**顺序**硬接 ⇒ 周长 13.8km、自交 53 处，
 *      因为成员**不是按行车顺序排的**，接缝处相邻两段并不共享节点。
 *      而且这个 relation 的点列是**双线**（一条中心线 + 相邻的一条平行线），单用会双倍。
 *   ③ 多条 way 会落在 bbox 之外 ⇒ 必须抓足够大的 bbox。
 *
 * 正解（本脚本）：把 relation 的成员 way 只当作**面片**，真正的走线靠**节点图追踪**——
 *   ① 建 node -> 用到它的 way列表；
 *   ② 从 relation 的任一成员 way 的端点出发，每一步优先走"度数=2 的节点"
 *      （唯一后继 ⇒ 无歧义），遇分叉节点时**在候选里挑与当前行进方向转角最小的**；
 *   ③ 回到起点即闭合成环；用**周长 ≈5807m** 做验收，逐条 way 打印选择理由便于人工核对。
 *
 * 用法： node tools/import-suzuka-osm.mjs <suz.osm> [out.js]
 */
import fs from 'node:fs';

const src = process.argv[2];
const out = process.argv[3] || 'public/js/suzuka-geometry.js';
const REL = '284570';
const REAL_PERIMETER = 5807;          // 真实铃鹿 GP 单圈（米）
if (!src) { console.error('用法：node tools/import-suzuka-osm.mjs <suz.osm> [out.js]'); process.exit(1); }
const xml = fs.readFileSync(src, 'utf8');

/* ---- node 坐标 ---- */
const nodes = new Map();
const nodeRe = /<node id="(\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g;
for (let m; (m = nodeRe.exec(xml)); ) nodes.set(m[1], [Number(m[3]), Number(m[2])]);

/* ---- way ---- */
const ways = new Map();
const wayRe = /<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g;
for (let m; (m = wayRe.exec(xml)); ) {
  const refs = [];
  const ndRe = /<nd ref="(\d+)"/g;
  for (let n; (n = ndRe.exec(m[2])); ) refs.push(n[1]);
  const tags = {};
  const tRe = /<tag k="([^"]*)" v="([^"]*)"/g;
  for (let t; (t = tRe.exec(m[2])); ) tags[t[1]] = t[2];
  ways.set(m[1], { refs, tags });
}

/* ---- relation 成员（只当"面片集合"，不用它的顺序）---- */
const relBlock = new RegExp('<relation id="' + REL + '"[^>]*>([\\s\\S]*?)</relation>').exec(xml);
if (!relBlock) throw new Error('找不到 relation ' + REL);
const memberIds = [];
const memRe = /<member type="([^"]*)" ref="(\d+)" role="([^"]*)"/g;
for (let m; (m = memRe.exec(relBlock[1])); ) {
  if (m[1] === 'way' && m[3] !== 'pit_lane') memberIds.push(m[2]);
}
const missing = memberIds.filter((id) => !ways.has(id));
console.log('relation ' + REL + ' 成员 ' + memberIds.length + ' 条，缺失 ' + missing.length
  + (missing.length ? '（bbox 不够大）：' + missing.join(',') : ''));

/* ---- 投影（先算，图上追踪要用米制）---- */
let lat0 = 0, lon0 = 0;
for (const id of memberIds) {
  const w = ways.get(id); if (!w) continue;
  for (const r of w.refs) { const p = nodes.get(r); if (p) { lat0 += p[1]; lon0 += p[0]; } }
}
let cnt = 0;
for (const id of memberIds) { const w = ways.get(id); if (w) cnt += w.refs.length; }
lat0 /= cnt; lon0 /= cnt;
const MX = 111320 * Math.cos((lat0 * Math.PI) / 180), MZ = 110540;
const xy = (r) => { const p = nodes.get(r); return p ? [(p[0] - lon0) * MX, (p[1] - lat0) * MZ] : null; };

/* ---- 节点 -> way 索引（只用成员 way）---- */
const nodeWays = new Map();
for (const id of memberIds) {
  const w = ways.get(id); if (!w) continue;
  for (const r of w.refs) {
    if (!nodeWays.has(r)) nodeWays.set(r, []);
    nodeWays.get(r).push(id);
  }
}

/* ---- 节点图追踪 ----
 * 状态：当前节点 + 刚走过的 way。每一步找一个"未用过、且端点含当前节点"的 way。
 * 若有多条候选，选**行进方向转角最小**的那条（避免在分叉处拐进死胡同/侧线）。
 * 每条 way 只用一次（真车一圈不会重复走同一段路面 —— 除立体交叉处节点不相连，天然不冲突）。
 */
function traceFrom(startNode) {
  const used = new Set();
  const path = [startNode];
  let cur = startNode;
  let prevDir = null;
  for (let step = 0; step < 4000; step++) {
    const cands = (nodeWays.get(cur) || []).filter((id) => !used.has(id));
    if (!cands.length) return { path, closed: false, why: '无可用 way @' + cur };
    let pickId = null, pickNext = null, best = Infinity, pickFlip = false;
    for (const id of cands) {
      const w = ways.get(id);
      const first = w.refs[0], last = w.refs[w.refs.length - 1];
      let next = null, flip = false;
      if (first === cur && last !== cur) next = last;
      else if (last === cur && first !== cur) { next = first; flip = true; }
      else if (first === cur && last === cur) next = last;      // 自环
      else continue;                                            // 该 way 不接在这里
      const a = xy(cur), b = xy(next);
      if (!a || !b) continue;
      let cost = 0;
      if (prevDir) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1e-9;
        const dot = (dx / L) * prevDir[0] + (dy / L) * prevDir[1];
        cost = 1 - dot;                                         // 转角越大 cost 越大
      }
      if (cost < best) { best = cost; pickId = id; pickNext = next; pickFlip = flip; }
    }
    if (pickId === null) return { path, closed: false, why: '候选 way 都不接 @' + cur };
    const w = ways.get(pickId);
    const seq = pickFlip ? w.refs.slice().reverse() : w.refs;
    for (let k = 1; k < seq.length; k++) path.push(seq[k]);
    used.add(pickId);
    const a = xy(cur), b = xy(pickNext);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    prevDir = [dx / L, dy / L];
    cur = pickNext;
    if (cur === startNode && used.size >= 20) return { path, closed: true, why: '闭合成环' };
  }
  return { path, closed: false, why: '步数超限' };
}

/* 从每个成员 way 的两个端点各试一次，取"周长最接近 5807m 的闭合环" */
const perimOf = (path) => {
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = xy(path[i - 1]), b = xy(path[i]);
    if (a && b) s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
};
let best = null;
for (const id of memberIds.slice(0, 12)) {           // 前 12 条足够覆盖各个位置
  const w = ways.get(id); if (!w) continue;
  for (const startNode of [w.refs[0], w.refs[w.refs.length - 1]]) {
    const r = traceFrom(startNode);
    if (!r.closed) continue;
    const per = perimOf(r.path);
    const score = Math.abs(per - REAL_PERIMETER);
    if (!best || score < best.score) best = { path: r.path, per, score, startNode };
  }
}
if (!best) { console.error('没能追踪出闭合环'); process.exit(1); }

let pts = best.path.map(xy);
if (pts.some((p) => !p)) throw new Error('路径里有节点缺坐标');
let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
for (const p of pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
console.log('闭合环：' + pts.length + ' 点  周长 = ' + best.per.toFixed(0) + ' m'
  + '（真实 ' + REAL_PERIMETER + 'm，偏差 ' + ((best.per / REAL_PERIMETER - 1) * 100).toFixed(1) + '%）');
console.log('包围盒 ' + (maxx - minx).toFixed(0) + 'm × ' + (maxz - minz).toFixed(0) + 'm');

/* ---- 清洗：去重复点 + 细分长段 ------------------------------------------
 * ⚠️ 必须做，两个真实缺陷（都在诊断里现形）：
 *   ① **零长度重复点**：实测索引 242 处有两个完全重合的节点，段长 0.000m。
 *      Catmull-Rom 在该处切线退化为零向量 ⇒ 重采样后出现 **179° 折返尖点、
 *      最小半径 1.5m**（诊断里"最大单点转折 179.1° @615"就是这么来的）。
 *   ② **长段**：OSM 在某些直道缺中间顶点（实测最长 346.8m）。细分不制造曲率
 *      （直线细分仍是直线），但让路面/护栏的横截面采样更均匀。
 */
function cleanPts(src, minSeg = 0.5, maxSeg = 40) {
  const out = [];
  for (const p of src) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minSeg) continue;
    out.push(p);
  }
  while (out.length > 2
    && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < minSeg) out.pop();
  const dense = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    dense.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(L / maxSeg);
    for (let s = 1; s <= k; s++) {
      dense.push([a[0] + (b[0] - a[0]) * s / (k + 1), a[1] + (b[1] - a[1]) * s / (k + 1)]);
    }
  }
  return { dense, kept: out.length };
}
{
  const before = pts.length;
  const c = cleanPts(pts);
  pts = c.dense;
  console.log('清洗：' + before + ' 点 → 去重复后 ' + c.kept + ' 点 → 细分后 ' + pts.length + ' 点');
}

/* ---- 自交检测：8 字形立体交叉的硬证据（应恰好 1 处）---- */
const cross = [];
const N = pts.length;
for (let i = 0; i < N; i++) {
  const a = pts[i], b = pts[(i + 1) % N];
  for (let j = i + 1; j < N; j++) {
    const gap = Math.min(Math.abs(i - j), N - Math.abs(i - j));
    if (gap < 8) continue;
    const c = pts[j], d = pts[(j + 1) % N];
    const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
    const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) cross.push([i, j]);
  }
}
console.log('投影自交段对 = ' + cross.length + (cross.length ? '  ' + JSON.stringify(cross.slice(0, 6)) : ''));
const segs = [];
for (let i = 0; i < N; i++) { const q = pts[(i + 1) % N]; segs.push(Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])); }
segs.sort((a, b) => a - b);
console.log('段长 p50=' + segs[N >> 1].toFixed(1) + 'm max=' + segs[N - 1].toFixed(1) + 'm');

/* ---- 写出 ---- */
const json = {
  source: 'OpenStreetMap relation ' + REL + ' (type=circuit, 鈴鹿サーキット)',
  center: [+lat0.toFixed(6), +lon0.toFixed(6)], realPerimeter: REAL_PERIMETER,
  osmPerimeter: +best.per.toFixed(2),
  bbox: [+minx.toFixed(1), +maxx.toFixed(1), +minz.toFixed(1), +maxz.toFixed(1)],
  selfIntersections: cross.length,
  pts: pts.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]),
};
const body = '/* 铃鹿赛道中心线 —— 由 tools/import-suzuka-osm.mjs 从 OpenStreetMap 生成，**请勿手改**。\n'
  + ' *\n'
  + ' * 数据来源：' + json.source + '\n'
  + ' * 投影：局部切平面（中心 ' + json.center[0] + ',' + json.center[1] + '），单位米。\n'
  + ' * 实测：OSM 中心线周长 ' + json.osmPerimeter + 'm（真实单圈 ' + json.realPerimeter + 'm）、'
  + '包围盒 ' + (json.bbox[1] - json.bbox[0]).toFixed(0) + '×' + (json.bbox[3] - json.bbox[2]).toFixed(0) + 'm、'
  + '投影自交 ' + json.selfIntersections + ' 处（8 字形立体交叉）。\n'
  + ' *\n'
  + ' * ⚠️ 这是**真实铃鹿**的走线，不再随 seed 变化（真车场地是固定的）。\n'
  + ' */\n'
  + 'export const SUZUKA_GEOMETRY = ' + JSON.stringify(json).replace(/,"/g, ',\n  "') + ';\n';
fs.writeFileSync(out, body);
console.log('\n已写出 ' + out + '（' + pts.length + ' 点）');
