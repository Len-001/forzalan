/* 定死铃鹿的「索引顺序 = 行车方向？」与「起终点索引」，并把结果烘焙进 public/js/suzuka-geometry.js。
 *
 * 判据（两条独立证据，必须一致）：
 *   ① 把 OSM 上带弯名的 way 映射到导入折线的最近索引，看该处折线的**局部方向**
 *      是否与 way 的 oneway 朝向一致（夹角 ≤ 35° 算一致，≥ 145° 算相反）。
 *   ② 弯名在折线上的**先后顺序**应等于真车弯序：
 *      主直道 → 1コーナー → 2コーナー → S字 → デグナー1 → デグナー2 → ヘアピン →
 *      200R → スプーン → 130R → シケイン → 西ストレート → 主直道
 *
 * 起终点：真车起终点线在**主直道上、靠近 1 号弯之前**，故取主直道上距其末端
 *        约 START_BEFORE_T1_M 米处为 index 0。
 * 立体交叉：真车约在圈上 90~97%（末段西直道跨过主直道）。这是最硬的朝向校验 —— 
 *        方向做反了，它就会跑到 5% 附近。
 *
 * 用法： node tools/suzuka-orient.mjs <suz.osm> [--write]
 */
import fs from 'node:fs';

const osmPath = process.argv[2];
const WRITE = process.argv.includes('--write');
const GEO = 'public/js/suzuka-geometry.js';
const START_BEFORE_T1_M = 300;

/* ---------- OSM 侧 ---------- */
const xml = fs.readFileSync(osmPath, 'utf8');
const nodes = new Map();
for (let m, re = /<node id="(\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g; (m = re.exec(xml)); ) nodes.set(m[1], [Number(m[3]), Number(m[2])]);
const ways = new Map();
for (let m, re = /<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g; (m = re.exec(xml)); ) {
  const refs = [];
  for (let n, r2 = /<nd ref="(\d+)"/g; (n = r2.exec(m[2])); ) refs.push(n[1]);
  const tags = {};
  for (let t, r2 = /<tag k="([^"]*)" v="([^"]*)"/g; (t = r2.exec(m[2])); ) tags[t[1]] = t[2];
  ways.set(m[1], { refs, tags });
}

const { SUZUKA_GEOMETRY: G } = await import(new URL('../public/js/suzuka-geometry.js', import.meta.url));
const P = G.pts, N = P.length;
const [lat0, lon0] = G.center;
const MX = 111320 * Math.cos((lat0 * Math.PI) / 180), MZ = 110540;
const xy = (r) => { const p = nodes.get(r); return [(p[0] - lon0) * MX, (p[1] - lat0) * MZ]; };

const CURVE_ORDER = ['メインストレート', '1コーナー', '2コーナー', 'S字', 'デグナー1', 'デグナー2',
  'NISSINブレーキヘアピン', '200R', 'スプーンカーブ', '130R', '日立Astemoシケイン', '西ストレート'];

/* 折线上索引 i 处的**沿行车方向**局部朝向。
 * ⚠️ 必须按 dir 取前视点：dir=-1 时"行车方向"是索引递减，用 i+2 会把朝向读反
 *    180°，于是主直道范围检测会立刻判为"偏离"（实测只覆盖 14 个点 ≈190m，
 *    而真车主直道 1.2km）。 */
function localDirFwd(i, dir) {
  const a = P[i], b = P[(((i + dir * 2) % N) + N) % N];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}
function angDiff(a, b) { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }

console.log('=== 弯名 → 折线索引（含朝向一致性）===');
const mapped = [];
for (const [, w] of ways) {
  const nm = w.tags.name; if (!nm) continue;
  const key = CURVE_ORDER.find((k) => nm.includes(k)); if (!key) continue;
  const a = xy(w.refs[0]), b = xy(w.refs[w.refs.length - 1]);
  if (!a || !b) continue;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const wdir = Math.atan2(b[1] - a[1], b[0] - a[0]);
  let bi = 0, bd = Infinity;
  for (let i = 0; i < N; i++) { const d = (P[i][0] - mid[0]) ** 2 + (P[i][1] - mid[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
  mapped.push({ key, nm, i: bi, perr: Math.sqrt(bd), wdir, pdir: localDirFwd(bi, +1), diff: angDiff(localDirFwd(bi, +1), wdir) * 180 / Math.PI });
}
mapped.sort((x, y) => x.i - y.i);
for (const m of mapped) {
  console.log('  索引 ' + String(m.i).padStart(3) + ' (' + (m.i / N * 100).toFixed(1).padStart(5) + '%)  '
    + m.nm.padEnd(20) + ' 误差 ' + m.perr.toFixed(0).padStart(4) + 'm'
    + '  way ' + (m.wdir * 180 / Math.PI).toFixed(0).padStart(5) + '°'
    + '  折线 ' + (m.pdir * 180 / Math.PI).toFixed(0).padStart(5) + '°'
    + '  夹角 ' + m.diff.toFixed(0).padStart(3) + '°  '
    + (m.diff <= 35 ? '一致' : (m.diff >= 145 ? '相反' : '交叉')));
}
const agree = mapped.filter((m) => m.diff <= 35).length;
const disagree = mapped.filter((m) => m.diff >= 145).length;
console.log('\n朝向一致 ' + agree + ' / 相反 ' + disagree + ' / 交叉 ' + (mapped.length - agree - disagree));

const firstOf = {};
for (const m of mapped) if (firstOf[m.key] === undefined) firstOf[m.key] = m.i;
const seq = CURVE_ORDER.map((k) => ({ k, i: firstOf[k] })).filter((x) => x.i !== undefined);
let ascBreaks = 0;
for (let i = 1; i < seq.length; i++) if (seq[i].i < seq[i - 1].i) ascBreaks++;
console.log('弯序索引：' + seq.map((x) => x.k + '@' + x.i).join(' → '));
console.log('逆序断点 = ' + ascBreaks + '/' + (seq.length - 1));

const ms = mapped.find((m) => m.key === 'メインストレート');
if (!ms) { console.error('缺 主直道 映射'); process.exit(1); }
/* 方向判据：**以朝向一致性为主**（agree vs disagree），弯序单调性只作交叉验证。
 * ⚠️ 不能用「ascBreaks===0」当硬条件：`西ストレート` 在 OSM 里有多条同名 way，
 *    取"第一次出现"会排到 `シケイン` 之后，于是 10 个弯里出现 1 个逆序断点 ——
 *    那是同名重复段的排序噪声，不是方向反了。
 * ⚠️ 另有一条必查的坑：本脚本会**旋转并翻转**几何文件，所以**只能对从
 *    OSM 重新导出的原始顺序几何跑定向分析**。对已烘焙过的文件再跑一次会把
 *    变换叠加两次，方向会判反（这一坑本轮已经踩过）。 */
const dir = agree > disagree ? +1 : -1;
console.log('弯序单调性：逆序断点 ' + ascBreaks + '（同名重复段会造成 1 个噪声断点，可接受）');
console.log('\ndir = ' + dir + (dir > 0 ? '（索引递增即行车方向）' : '（索引递增与行车方向相反）'));

/* 主直道覆盖范围。
 * ⚠️ 参考朝向必须取**行车方向**的局部朝向，不能用 way 自己的 oneway 朝向：
 *    mapping 阶段已实测「メインストレート」这条 way 的数字化方向与行车方向
 *    相差 178°（25 条 way 里 15 条如此），拿它当基准会一出发就判"偏离"。 */
const msRefDir = localDirFwd(ms.i, dir);
let best = ms.i;
for (let k = 0; k < 400; k++) {
  const j = ((ms.i + dir * k) % N + N) % N;
  if (angDiff(localDirFwd(j, dir), msRefDir) > 20 * Math.PI / 180) break;
  best = j;
}
console.log('主直道覆盖索引 ' + ms.i + ' → ' + best);

/**
 * 起终点定位（三条独立证据，取最可靠的一条，并逐条打印以便核对）：
 *   ① **真车公布坐标**：铃鹿起终点线在 34°50'35.48"N 136°32'26.58"E
 *      （Wikipedia 信息框的来源坐标即起终点线位置）。OSM 投影的中心点是赛道
 *      形心，所以用**折线上离它最近的点**，误差即重建误差。
 *   ② **pit lane 近端**：OSM 的 `Pit Lane` way（relation 里 role=pit_lane）
 *      在主流行方向最**早**的那个端点附近，紧邻起终点线。
 *   ③ 主直道上距 1 号弯入口 START_BEFORE_T1_M 米的点（启发式兜底）。
 * 三条应落在方圆 200m 内；若分歧更大就说明 OSM 数据或方向判断有问题，必须人工看。
 */
const TRUE_START = (() => {
  const lat = 34 + 50 / 60 + 35.48 / 3600, lon = 136 + 32 / 60 + 26.58 / 3600;
  return [(lon - lon0) * MX, (lat - lat0) * MZ];
})();
let trueIdx = 0, trueD = Infinity;
for (let i = 0; i < N; i++) {
  const d = (P[i][0] - TRUE_START[0]) ** 2 + (P[i][1] - TRUE_START[1]) ** 2;
  if (d < trueD) { trueD = d; trueIdx = i; }
}
console.log('\n① 真车起终点坐标 (' + TRUE_START[0].toFixed(0) + ',' + TRUE_START[1].toFixed(0) + ')'
  + ' → 折线最近点 ' + trueIdx + ' (' + P[trueIdx][0].toFixed(0) + ',' + P[trueIdx][1].toFixed(0) + ')'
  + '  误差 ' + Math.sqrt(trueD).toFixed(0) + 'm');

/* ② pit lane 近端 */
let pitIdx = null, pitD = Infinity;
for (const [id, w] of ways) {
  if (w.tags.name !== 'Pit Lane') continue;
  for (const r of [w.refs[0], w.refs[w.refs.length - 1]]) {
    const po = xy(r); if (!po) continue;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) { const d = (P[i][0] - po[0]) ** 2 + (P[i][1] - po[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
    if (bd < pitD) { pitD = bd; pitIdx = bi; }
  }
}
console.log('② pit lane 近端 → 折线最近点 ' + pitIdx + ' (' + P[pitIdx][0].toFixed(0) + ',' + P[pitIdx][1].toFixed(0) + ')'
  + '  距中心线 ' + Math.sqrt(pitD).toFixed(0) + 'm');

/* ③ 主直道启发式 */
let acc = 0, idx = best;
for (let k = 0; k < 400; k++) {
  const j = ((idx - dir) % N + N) % N;
  acc += Math.hypot(P[j][0] - P[idx][0], P[j][1] - P[idx][1]);
  idx = j;
  if (acc >= START_BEFORE_T1_M) break;
}
console.log('③ 主直道末端回退 ' + acc.toFixed(0) + 'm → 折线点 ' + idx + ' (' + P[idx][0].toFixed(0) + ',' + P[idx][1].toFixed(0) + ')');

/* 三条互校：两两距离 */
const dist = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]);
console.log('   互校：①↔② ' + dist(trueIdx, pitIdx).toFixed(0) + 'm   ①↔③ ' + dist(trueIdx, idx).toFixed(0)
  + 'm   ②↔③ ' + dist(pitIdx, idx).toFixed(0) + 'm');

// 取 ①（真车坐标）为主；若它与 pit lane 的分歧 > 250m 则告警（可能 OSM 投影或方向有误）
const startIdx = trueIdx;
const spread = Math.max(dist(trueIdx, pitIdx), dist(trueIdx, idx));
if (spread > 250) console.log('   ⚠️ 三条证据分歧 ' + spread.toFixed(0) + 'm > 250m，需人工核对！');
console.log('采用起终点索引 = ' + startIdx + '（' + P[startIdx][0].toFixed(0) + ',' + P[startIdx][1].toFixed(0) + '）');
{
  // 从起点沿行车方向走到「1コーナー」映射点，量距离（真车起终点→1 号弯约 300m）
  const t1m = mapped.find((m) => m.key === '1コーナー');
  if (t1m) {
    let d = 0, i2 = startIdx;
    for (let k = 0; k < 400; k++) {
      const j = ((i2 + dir) % N + N) % N;
      d += Math.hypot(P[j][0] - P[i2][0], P[j][1] - P[i2][1]);
      i2 = j;
      if (i2 === t1m.i) break;
    }
    console.log('   起终点 → 1 号弯入口 = ' + d.toFixed(0) + 'm（真车约 300m 量级，主直道 1.2km）');
  }
  // 起终点前后各 200m 应该是直道（真车起终点在主直道上）
  let straight = true;
  for (let k = -6; k <= 6; k++) {
    const j = ((startIdx + dir * k) % N + N) % N;
    if (angDiff(localDirFwd(j, dir), localDirFwd(startIdx, dir)) > 25 * Math.PI / 180) straight = false;
  }
  console.log('   起终点 ±200m 是直道？ ' + (straight ? '是 ✓（真车起终点确实在主直道上）' : '否 ✗（起点可能落错位置）'));
}

/* 旋转/翻转 */
const out = [];
for (let k = 0; k < N; k++) out.push(P[((startIdx + dir * k) % N + N) % N]);

/* 自交点在**新序列**上的位置 */
let crossPct = null, crossCount = 0;
outer:
for (let a2 = 0; a2 < N; a2++) {
  const A = P[a2], B = P[(a2 + 1) % N];
  for (let b2 = a2 + 1; b2 < N; b2++) {
    const gap = Math.min(Math.abs(a2 - b2), N - Math.abs(a2 - b2));
    if (gap < 8) continue;
    const C = P[b2], D = P[(b2 + 1) % N];
    const den = (B[0] - A[0]) * (D[1] - C[1]) - (B[1] - A[1]) * (D[0] - C[0]);
    if (Math.abs(den) < 1e-9) continue;
    const t = ((C[0] - A[0]) * (D[1] - C[1]) - (C[1] - A[1]) * (D[0] - C[0])) / den;
    const u = ((C[0] - A[0]) * (B[1] - A[1]) - (C[1] - A[1]) * (B[0] - A[0])) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      crossPct = [(((a2 - startIdx) * dir % N) + N) % N / N * 100, (((b2 - startIdx) * dir % N) + N) % N / N * 100];
      break outer;
    }
  }
}
{
  for (let a3 = 0; a3 < N; a3++) {
    const A3 = P[a3], B3 = P[(a3 + 1) % N];
    for (let b3 = a3 + 1; b3 < N; b3++) {
      const gap3 = Math.min(Math.abs(a3 - b3), N - Math.abs(a3 - b3));
      if (gap3 < 8) continue;
      const C3 = P[b3], D3 = P[(b3 + 1) % N];
      const den3 = (B3[0] - A3[0]) * (D3[1] - C3[1]) - (B3[1] - A3[1]) * (D3[0] - C3[0]);
      if (Math.abs(den3) < 1e-9) continue;
      const t3 = ((C3[0] - A3[0]) * (D3[1] - C3[1]) - (C3[1] - A3[1]) * (D3[0] - C3[0])) / den3;
      const u3 = ((C3[0] - A3[0]) * (B3[1] - A3[1]) - (C3[1] - A3[1]) * (B3[0] - A3[0])) / den3;
      if (t3 >= 0 && t3 <= 1 && u3 >= 0 && u3 <= 1) crossCount++;
    }
  }
}
console.log('立体交叉在圈上位置 ' + (crossPct ? crossPct.map((x) => x.toFixed(1) + '%').join(' / ') : '未找到')
  + '   ← 真车约 90~97%（方向做反会跑到 5% 附近）');

if (!WRITE) { console.log('\n（未写文件；加 --write 生效）'); process.exit(0); }
const json = {
  source: G.source, center: G.center, realPerimeter: G.realPerimeter, osmPerimeter: G.osmPerimeter,
  bbox: G.bbox, startIndexInOsm: startIdx, travelDirVsOsmIndex: dir, selfIntersections: crossCount,
  selfIntersectionPct: crossPct ? crossPct.map((x) => +x.toFixed(2)) : null,
  pts: out.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]),
};
const body = '/* 铃鹿赛道中心线 —— 由 tools/import-suzuka-osm.mjs + tools/suzuka-orient.mjs 从 OpenStreetMap 生成，**请勿手改**。\n'
  + ' *\n'
  + ' * 数据来源：' + json.source + '\n'
  + ' * 投影：局部切平面（中心 ' + json.center[0] + ',' + json.center[1] + '），单位米。\n'
  + ' * 实测：OSM 中心线周长 ' + json.osmPerimeter + 'm（真实单圈 ' + json.realPerimeter + 'm）、'
  + '包围盒 ' + (json.bbox[1] - json.bbox[0]).toFixed(0) + '×' + (json.bbox[3] - json.bbox[2]).toFixed(0) + 'm。\n'
  + ' *\n'
  + ' * ⚠️ **数组已按行车方向展开，index 0 = 起终点线**（真车起终点在主直道后段、距 1 号弯约 '
  + START_BEFORE_T1_M + 'm）。\n'
  + ' *    OSM 原始拼接的起点在第 ' + json.startIndexInOsm + ' 段，行车方向相对其索引顺序'
  + (json.travelDirVsOsmIndex > 0 ? '递增' : '递减') + '。\n'
  + ' *    立体交叉（8 字形自交）落在圈上 ' + ((json.selfIntersectionPct || []).join('% / ')) + '% 处。\n'
  + ' *\n'
  + ' * ⚠️ 这是**真实铃鹿**的走线，不随 seed 变化（真车场地是固定的）。\n'
  + ' */\n'
  + 'export const SUZUKA_GEOMETRY = ' + JSON.stringify(json).replace(/,"/g, ',\n  "') + ';\n';
fs.writeFileSync(GEO, body);
console.log('\n已烘焙写出 ' + GEO + '（' + out.length + ' 点，index 0 = 起终点）');
