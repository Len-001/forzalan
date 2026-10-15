/* =============================================================================
 * 通用赛道导入器：OSM relation(type=circuit) → public/js/<track>-geometry.js
 *
 * 由 tools/import-suzuka-osm.mjs 泛化而来（铃鹿那套链路已验证过）：
 *   节点图追踪拼环 → 清洗（去零长度重复点 + 细分长段）→ 自交/最小半径诊断
 *   → 烘焙离线几何（游戏运行期**不联网**）。
 *
 * 与铃鹿版的差异（斯帕的数据更好，所以能做更硬的事）：
 *   ① 起终点与**行车方向**直接取自 OSM 中带 `raceway=start-finish` 的 way，
 *      不再需要外部的"定向分析"猜方向；
 *   ② 顺带把**真实弯名**（way 的 name 标签）映射到圈上比例，供 track.js 摆地标/命名。
 *
 * 用法：
 *   node tools/import-track-osm.mjs --osm tools/_spa.osm --relation 284560 \
 *        --key spa --export SPA_GEOMETRY --perimeter 7004 --out public/js/spa-geometry.js
 * ========================================================================== */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const src = arg('osm');
const REL = String(arg('relation'));
const KEY = arg('key', 'track');
const EXPORT = arg('export', KEY.toUpperCase() + '_GEOMETRY');
const REAL_PERIMETER = Number(arg('perimeter', 0));
const out = arg('out', 'public/js/' + KEY + '-geometry.js');
const REAL_NAME = arg('name', KEY);
if (!src || !REL) { console.error('用法见文件头'); process.exit(1); }

const xml = fs.readFileSync(src, 'utf8');

/* ---- 节点 / way 解析 ---- */
const nodes = new Map();
const nodeRe = /<node id="(\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g;
let m;
// ★ 存 [lon, lat]（与下面的投影、与 import-suzuka-osm.mjs 保持一致）。
//   曾误存成 [lat, lon]，注释却仍写 [lon, lat] ⇒ 投影里 lat0/lon0 语义交叉：
//   MX = 111320·cos(平均经度 5.97°)=110716 而不是 cos(平均纬度 50.43°)=70907，
//   且经度分量整个丢掉了 cos 因子 ⇒ 斯帕被东西向拉伸 1/cos(50.43°)=1.569 倍，
//   7004m 的真实赛道被算成 8465m（+20.9%）。修这一行即修正全盘。
while ((m = nodeRe.exec(xml))) nodes.set(m[1], [+m[3], +m[2]]);   // [lon, lat]
const ways = new Map();
const wayRe = /<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g;
while ((m = wayRe.exec(xml))) {
  const body = m[2];
  const refs = [...body.matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]);
  const name = (body.match(/<tag k="name" v="([^"]+)"/) || [])[1] || '';
  const sf = /<tag k="raceway" v="start-finish"/.test(body);
  // oneway：赛道 way 普遍带 oneway=yes，**way 自身的节点顺序就是行车方向**（方向投票要用）。
  const ow = (body.match(/<tag k="oneway" v="([^"]*)"/) || [])[1] || '';
  const oneway = /^(yes|true|1)$/.test(ow) ? 1 : (/^(-1|reverse)$/.test(ow) ? -1 : 0);
  ways.set(m[1], { refs, name, sf, oneway });

}

/* ---- relation 成员 ---- */
const relBlock = new RegExp('<relation id="' + REL + '"[^>]*>([\\s\\S]*?)</relation>').exec(xml);
if (!relBlock) { console.error('找不到 relation ' + REL); process.exit(1); }
const memberIds = [];
const memberRole = new Map();
const startNodeIds = [];        // relation 里 role=start 的**节点**成员 = 起终点线锚点
const memRe = /<member type="([^"]*)" ref="(\d+)" role="([^"]*)"/g;
while ((m = memRe.exec(relBlock[1]))) {
  if (m[1] === 'node') {
    // 斯帕这种赛道：relation 用 role=start 的**节点**标起终点，没有 raceway=start-finish 的 way
    if (m[3] === 'start' || m[3] === 'start_finish') startNodeIds.push(m[2]);
    continue;
  }
  if (m[1] !== 'way') continue;
  // ★ 必须排除 `role=pit_lane`（维修区）：它不是赛道，串进来会让周长多出整整 1461m
  //   （实测 8465m vs 真车 7004m，差值恰好等于维修区长度）。
  if (m[3] === 'pit_lane') continue;
  memberIds.push(m[2]);
  memberRole.set(m[2], m[3]);
}
const missing = memberIds.filter((id) => !ways.has(id));
console.log('relation ' + REL + ' 成员 way ' + memberIds.length + ' 条'
  + (missing.length ? '（其中 ' + missing.length + ' 条不在本 bbox 内）' : ''));

/* ---- 局部切平面投影 ---- */
let lat0 = 0, lon0 = 0, cnt = 0;
for (const id of memberIds) { const w = ways.get(id); if (!w) continue;
  for (const r of w.refs) { const p = nodes.get(r); if (p) { lat0 += p[1]; lon0 += p[0]; cnt++; } } }
lat0 /= cnt; lon0 /= cnt;
const MX = 111320 * Math.cos((lat0 * Math.PI) / 180), MZ = 110540;
const xy = (r) => { const p = nodes.get(r); return p ? [(p[0] - lon0) * MX, (p[1] - lat0) * MZ] : null; };

/* ---- 节点 → way 索引（只用成员 way）---- */
const nodeWays = new Map();
for (const id of memberIds) {
  const w = ways.get(id); if (!w) continue;
  for (const r of w.refs) {
    if (!nodeWays.has(r)) nodeWays.set(r, []);
    nodeWays.get(r).push(id);
  }
}

/* ---- 节点图追踪（分叉处选"转角最小"，每条 way 只用一次）---- */
function traceFrom(startNode) {
  const used = new Set();
  const path = [startNode];
  let cur = startNode, prevDir = null;
  const order = [];
  for (let step = 0; step < 6000; step++) {
    const cands = (nodeWays.get(cur) || []).filter((id) => !used.has(id));
    if (!cands.length) return { path, order, closed: false, why: '无可用 way @' + cur };
    let pickId = null, pickNext = null, best = Infinity, pickFlip = false;
    for (const id of cands) {
      const w = ways.get(id);
      const first = w.refs[0], last = w.refs[w.refs.length - 1];
      let next = null, flip = false;
      if (first === cur && last !== cur) next = last;
      else if (last === cur && first !== cur) { next = first; flip = true; }
      else if (first === cur && last === cur) next = last;
      else continue;
      const a = xy(cur), b = xy(next);
      if (!a || !b) continue;
      let cost = 0;
      if (prevDir) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1e-9;
        cost = 1 - ((dx / L) * prevDir[0] + (dy / L) * prevDir[1]);
      }
      if (cost < best) { best = cost; pickId = id; pickNext = next; pickFlip = flip; }
    }
    if (pickId === null) return { path, order, closed: false, why: '候选 way 都不接 @' + cur };
    const w = ways.get(pickId);
    const seq = pickFlip ? w.refs.slice().reverse() : w.refs;
    for (let k = 1; k < seq.length; k++) path.push(seq[k]);
    used.add(pickId);
    order.push({ id: pickId, flip: pickFlip, name: w.name, sf: w.sf || memberRole.get(pickId) === 'start' });
    const a = xy(cur), b = xy(pickNext);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    prevDir = [dx / L, dy / L];
    cur = pickNext;
    if (cur === startNode && used.size >= memberIds.length - 6) return { path, order, closed: true, why: '闭合成环' };
  }
  return { path, order, closed: false, why: '步数超限' };
}
const perimOf = (path) => {
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = xy(path[i - 1]), b = xy(path[i]);
    if (a && b) s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
};
// ★ 若成员端点构成一条链（每个端点度数 ≤2、无岔口），就直接按**唯一链**拼接：
//   这比"最小转角贪心"更硬 —— 实测斯帕的 relation 正是无岔口链，而贪心版会
//   在个别 way 上折返，得到 8465m（比所有成员长度之和 7598m 还长，显然不可能）。
let chain = null;
{
  const deg = new Map();
  for (const id of memberIds) {
    const w = ways.get(id); if (!w) continue;
    for (const r of w.refs) deg.set(r, (deg.get(r) || 0) + 1);
  }
  const junc = [...deg.values()].filter((d) => d > 2).length;
  if (junc === 0) {
    const used = new Set();
    const w0 = ways.get(memberIds[0]);
    let cur = w0.refs[0];
    const path = [cur];
    const order = [];
    let ok = true;
    for (let step = 0; step < memberIds.length; step++) {
      const cands = memberIds.filter((id) => !used.has(id));
      let pickId = null, flip = false, next = null;
      for (const id of cands) {
        const w = ways.get(id);
        const a = w.refs[0], b = w.refs[w.refs.length - 1];
        if (a === cur) { pickId = id; flip = false; next = b; break; }
        if (b === cur) { pickId = id; flip = true; next = a; break; }
      }
      if (pickId === null) { ok = false; break; }
      const w = ways.get(pickId);
      const seq = flip ? w.refs.slice().reverse() : w.refs;
      for (let k = 1; k < seq.length; k++) path.push(seq[k]);
      used.add(pickId);
      order.push({ id: pickId, flip, name: w.name, sf: w.sf || memberRole.get(pickId) === 'start' });
      cur = next;
    }
    if (ok && used.size === memberIds.length && (path[path.length - 1] === path[0])) {
      // 收尾：链回起点才算闭合
      chain = { path, order, closed: true };
      console.log('成员端点构成**无岔口链** ⇒ 直接按唯一链拼接（最可靠）');
    }
  } else {
    console.log('成员端点有 ' + junc + ' 个岔口 ⇒ 退回"最小转角贪心"追踪');
  }
}

let best = chain ? { path: chain.path, order: chain.order, per: perimOf(chain.path), score: 0, startNode: chain.path[0] } : null;
if (best) console.log('链式拼接：' + best.path.length + ' 点  长度 = ' + best.per.toFixed(0) + ' m');
for (const id of (chain ? [] : memberIds.slice(0, 16))) {
  const w = ways.get(id); if (!w) continue;
  for (const startNode of [w.refs[0], w.refs[w.refs.length - 1]]) {
    const r = traceFrom(startNode);
    if (!r.closed) continue;
    const per = perimOf(r.path);
    const score = REAL_PERIMETER ? Math.abs(per - REAL_PERIMETER) : -per;
    if (!best || score < best.score) best = { path: r.path, order: r.order, per, score, startNode };
  }
}
if (!best) { console.error('没能追踪出闭合环'); process.exit(1); }
let pts = best.path.map(xy);
if (pts.some((p) => !p)) throw new Error('路径里有节点缺坐标');
let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
for (const p of pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
console.log('闭合环：' + pts.length + ' 点  周长 = ' + best.per.toFixed(0) + ' m'
  + (REAL_PERIMETER ? '（真实 ' + REAL_PERIMETER + 'm，偏差 ' + ((best.per / REAL_PERIMETER - 1) * 100).toFixed(1) + '%）' : ''));
console.log('包围盒 ' + (maxx - minx).toFixed(0) + 'm × ' + (maxz - minz).toFixed(0) + 'm');

/* ---- 行车方向：member way 的 oneway 朝向投票 ------------------------------
 * 赛道 way 普遍带 oneway=yes，**way 自身的节点顺序就是行车方向**。
 * 拼接时每条 way 记了 flip（追踪顺序是否与其 OSM 节点顺序相反），按**长度加权投票**
 * 即可判定折线走向是否即行车方向；多数长度被反向使用 ⇒ 折线整体反向一次。
 * ------------------------------------------------------------------------ */
let travelDir = 1;
{
  let withDir = 0, against = 0;
  for (const o of best.order) {
    const w = ways.get(o.id);
    if (!w || !w.oneway) continue;
    let L = 0;
    for (let k2 = 1; k2 < w.refs.length; k2++) {
      const q1 = xy(w.refs[k2 - 1]), q2 = xy(w.refs[k2]);
      if (q1 && q2) L += Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
    }
    if (o.flip) against += L; else withDir += L;
  }
  travelDir = against > withDir ? -1 : 1;
  console.log('oneway 朝向投票（按 way 长度加权）：正向 ' + withDir.toFixed(0) + 'm / 反向 '
    + against.toFixed(0) + 'm ⇒ 行车方向系数 ' + travelDir);
}

/* ---- 起终点锚点（决定 index 0）：① raceway=start-finish way ② relation role=start 节点 ---- */
let anchorPt = null, anchorSrc = '', anchorNodeId = '';
{
  const sfWay = best.order.find((o) => o.sf);
  if (sfWay) {
    anchorPt = xy(ways.get(sfWay.id).refs[0]);
    anchorSrc = 'raceway=start-finish way ' + sfWay.id + ' 首节点';
  } else if (startNodeIds.length) {
    anchorNodeId = startNodeIds[0];
    anchorPt = xy(anchorNodeId);
    anchorSrc = 'relation role=start 节点 ' + anchorNodeId;
  } else {
    console.log('⚠️ OSM 既无 raceway=start-finish 也无 role=start ⇒ 不旋转（index 0 = 拼接起点，仅近似）');
  }
  if (anchorPt) console.log('起终点锚点：' + anchorSrc + ' = [' + anchorPt[0].toFixed(1) + ', ' + anchorPt[1].toFixed(1) + ']');
}

/* ---- 方向与起终点对齐：反向（按需）+ 旋转到起终点线 ----------------------
 * 目的：**index 0 = 起终点线、索引序 = 行车序**（与 public/js/suzuka-geometry.js 同口径）。
 * 游戏端 Track 构造把 def.ctl 当闭环做等弧长重采样，index 0 就是计圈线。
 * ------------------------------------------------------------------------ */
let startIndexInOsm = -1, anchorDist = Infinity;
if (travelDir === -1) {
  pts = pts.slice().reverse();
  console.log('按 oneway 投票：折线整体反向一次（索引序 = 行车序）');
}
if (anchorPt) {
  for (let i = 0; i < pts.length; i++) {
    const d2 = Math.hypot(pts[i][0] - anchorPt[0], pts[i][1] - anchorPt[1]);
    if (d2 < anchorDist) { anchorDist = d2; startIndexInOsm = i; }
  }
  pts = pts.slice(startIndexInOsm).concat(pts.slice(0, startIndexInOsm));
  console.log('起终点对齐：链上 idx=' + startIndexInOsm + '/' + pts.length + ' 旋到 index 0（偏差 '
    + anchorDist.toFixed(1) + 'm）⇒ index 0 = 起终点线');
}
/* ---- 清洗：去重复点 + 细分长段（与铃鹿同口径，两个真实缺陷都踩过）---- */
function cleanPts(list, minSeg = 0.5, maxSeg = 40) {
  const keep = [];
  for (const p of list) {
    const last = keep[keep.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minSeg) continue;
    keep.push(p);
  }
  while (keep.length > 2
    && Math.hypot(keep[0][0] - keep[keep.length - 1][0], keep[0][1] - keep[keep.length - 1][1]) < minSeg) keep.pop();
  const dense = [];
  for (let i = 0; i < keep.length; i++) {
    const a = keep[i], b = keep[(i + 1) % keep.length];
    dense.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(L / maxSeg);
    for (let s = 1; s <= k; s++) dense.push([a[0] + (b[0] - a[0]) * s / (k + 1), a[1] + (b[1] - a[1]) * s / (k + 1)]);
  }
  return { dense, kept: keep.length, removed: list.length - keep.length };
}
{
  const before = pts.length;
  const c = cleanPts(pts);
  pts = c.dense;
  console.log('清洗：' + before + ' 点 → 去重复点 -' + c.removed + ' → 细分后 ' + pts.length + ' 点');
}

/* ---- 诊断：自交 / 段长 / 最小半径 ---- */
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
let minR = Infinity, maxTurn = 0;
for (let i = 0; i < N; i++) {
  const a = pts[(i - 1 + N) % N], b = pts[i], c = pts[(i + 1) % N];
  const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(v1[0], v1[1]) || 1e-9, l2 = Math.hypot(v2[0], v2[1]) || 1e-9;
  const cosT = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
  const ang = Math.acos(cosT) * 180 / Math.PI;
  if (ang > maxTurn) maxTurn = ang;
  const cr = Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) / (l1 * l2);
  if (cr > 1e-9) minR = Math.min(minR, (l1 + l2) / 2 / cr);
}
console.log('最大单点转折 ' + maxTurn.toFixed(1) + '°   最小曲率半径 ' + minR.toFixed(1) + 'm');
const segs = [];
for (let i = 0; i < N; i++) { const q = pts[(i + 1) % N]; segs.push(Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])); }
segs.sort((a, b) => a - b);
console.log('段长 p50=' + segs[N >> 1].toFixed(1) + 'm max=' + segs[N - 1].toFixed(1) + 'm');

/* ---- 真实弯名 → 圈上比例（**弧长**比例，与游戏端 v=i/N 同口径）---- */
const cum = new Float64Array(N + 1);
for (let i = 0; i < N; i++) { const a2 = pts[i], b2 = pts[(i + 1) % N]; cum[i + 1] = cum[i] + Math.hypot(b2[0] - a2[0], b2[1] - a2[1]); }
const totalLen = cum[N];
/* ---- 真实弯名 → 圈上比例 ---- */
const corners = [];
{
  const seen = new Set();
  const orderNames = best.order.map((o) => o.name).filter(Boolean);
  for (const nm of orderNames) {
    if (seen.has(nm)) continue;
    seen.add(nm);
    // 该 way 的首节点在原始几何上的最近点 → 比例
    const id = best.order.find((o) => o.name === nm);
    const w = ways.get(id.id);
    const p0 = xy(id.flip ? w.refs[w.refs.length - 1] : w.refs[0]);
    if (!p0) continue;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - p0[0], pts[i][1] - p0[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    corners.push({ name: nm, fraction: +(cum[bi] / totalLen).toFixed(4), dist: +bd.toFixed(1) });
  }
  console.log('真实弯名 ' + corners.length + ' 个 → ' + corners.map((c) => c.name + '@' + (c.fraction * 100).toFixed(1) + '%').join(', '));
}

/* ---- 写出 ---- */
const json = {
  source: 'OpenStreetMap relation ' + REL + ' (type=circuit, ' + REAL_NAME + ')',
  center: [+lat0.toFixed(6), +lon0.toFixed(6)],
  realPerimeter: REAL_PERIMETER,
  osmPerimeter: +best.per.toFixed(2),
  bbox: [+minx.toFixed(1), +maxx.toFixed(1), +minz.toFixed(1), +maxz.toFixed(1)],
  selfIntersections: cross.length,
  startIndexInOsm: startIndexInOsm < 0 ? null : startIndexInOsm,
  travelDirVsOsmIndex: travelDir,
  startSource: anchorSrc,
  startFinishFraction: 0,
  startFinishDist: anchorDist === Infinity ? null : +anchorDist.toFixed(1),

  corners,
  pts: pts.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]),
};
const body = '/* ' + REAL_NAME + ' 赛道中心线 —— 由 tools/import-track-osm.mjs 从 OpenStreetMap 生成，**请勿手改**。\n'
  + ' *\n'
  + ' * 数据来源：' + json.source + '\n'
  + ' * 投影：局部切平面（中心 ' + json.center[0] + ',' + json.center[1] + '），单位米。\n'
  + ' * 实测：OSM 中心线周长 ' + json.osmPerimeter + 'm（真实单圈 ' + json.realPerimeter + 'm）、\n'
  + ' * 包围盒 ' + (json.bbox[1] - json.bbox[0]).toFixed(0) + '×' + (json.bbox[3] - json.bbox[2]).toFixed(0) + 'm、\n'
  + ' * 投影自交 ' + json.selfIntersections + ' 处、起终点在 ' + (json.startFinishFraction * 100).toFixed(2) + '% 处'
  + '（取自 OSM raceway=start-finish，距该 way 首节点 ' + json.startFinishDist + 'm）。\n'
  + ' *\n'
  + ' * ⚠️ 这是**真实赛道**的走线，不随 seed 变化（真车场地是固定的）。\n'
  + ' */\n'
  + 'export const ' + EXPORT + ' = ' + JSON.stringify(json).replace(/,"/g, ',\n  "') + ';\n';
fs.writeFileSync(out, body);
console.log('\n已写出 ' + out + '（' + pts.length + ' 点，' + (json.corners.length) + ' 个真实弯名）');
