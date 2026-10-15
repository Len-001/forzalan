/* =============================================================================
 * 赛道几何完整性审计（离线，Node 内跑真 track.js + 真 three）
 *
 * 目标：回答"有时赛道缺失一块，有时正常"到底是什么缺了。
 * 逐项检查（对每个随机种子）：
 *   ① ribbon 类网格：**每个四边形段是否都在**（缺段 = 肉眼一个洞）
 *   ② ribbon 段宽（沥青必须恒为 2×halfWidth；退化段宽≈0）
 *   ③ 顶点里有无 NaN / Infinity（越界读取的典型产物）
 *   ④ 护栏碰撞体：沿路相邻段的**连续空缺**（缺一段 = 墙塌了）
 *
 * ⚠️ 第一版审计自己写错了索引回推（把顶点号直接当段号），于是
 *    "1409/1440 缺段 + 1409 NaN" 全是假警报。正确回推：ribbon 每段占
 *    **2 个顶点**，顶点号 v 的段号 = v >> 1；四边形 k 的索引用到 v = 2k..2k+3。
 *
 * 用法： node tools/track-geometry-audit.mjs
 *        SEEDS=40 TRACKS=suzuka,vegas,spa node tools/track-geometry-audit.mjs
 *        VERBOSE=1 SEEDS=3 node tools/track-geometry-audit.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

(0, eval)(fs.readFileSync(path.join(root, 'public/libs/three.min.js'), 'utf8'));
if (!globalThis.THREE) { console.error('无法注入 three.min.js'); process.exit(1); }

const ctx2d = new Proxy({}, {
  get(_, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set() { return true; },
});
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas'
      ? { width: 0, height: 0, style: {}, getContext: () => ctx2d, addEventListener() {}, removeEventListener() {} }
      : { style: {} }),
    createElementNS: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }),
    addEventListener() {}, removeEventListener() {},
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };
}

const { Track, TRACK_CFG, TERRAIN_FLOOR_Y, TERRAIN_LIP } = await import(mod('public/js/track.js'));

const SEEDS = Number(process.env.SEEDS || 20);
const TRACKS = (process.env.TRACKS || 'suzuka,vegas,spa').split(',').map((s) => s.trim()).filter(Boolean);
const VERBOSE = process.env.VERBOSE === '1';
const NO_GRASS_CLIP = process.env.NO_GRASS_CLIP === '1';  // 反证用：还原 42m 全宽草皮（不做逐点收缩）
const NO_SKIRT = process.env.NO_SKIRT || '';             // 反证用：1=完全无裙边 2=内侧列被拉下（接反）

let bad = 0;

/** ribbon 审计。segTotal = 该几何覆盖的段总数（合并几何是 2N）。 */
function auditRibbon(name, geo, segTotal, halfWidth) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const P = pos.array;
  const I = idx.array;
  const segSeen = new Uint8Array(segTotal + 2);
  let nan = 0, widMin = Infinity, widMax = 0, deg = 0;
  for (let t = 0; t + 2 < I.length; t += 3) {
    for (const v of [I[t], I[t + 1], I[t + 2]]) segSeen[v >> 1] = 1;
  }
  for (let k = 0; k <= segTotal; k++) {
    const o = k * 6;
    if (o + 5 >= P.length) break;
    const x0 = P[o], y0 = P[o + 1], z0 = P[o + 2], x1 = P[o + 3], y1 = P[o + 4], z1 = P[o + 5];
    if (![x0, y0, z0, x1, y1, z1].every((v) => typeof v === 'number' && isFinite(v))) { nan++; continue; }
    const w = Math.hypot(x1 - x0, z1 - z0);
    if (w < widMin) widMin = w;
    if (w > widMax) widMax = w;
    if (w < 1e-3) deg++;
  }
  let missing = 0;
  const gaps = [];
  for (let k = 1; k < segTotal; k++) if (!segSeen[k]) { missing++; if (gaps.length < 6) gaps.push(k); }
  return { name, segTotal, missing, nan, deg, widMin, widMax, gaps, verts: pos.count, refW: 2 * halfWidth };
}

/**
 * 护栏：相邻碰撞盒之间的**真实几何空隙**（缺一段 = 墙塌了，车能穿出去）。
 *
 * ⚠️ 三版才做对，前两版的错都在"把采样点当中介"：
 *   ① 按"碰撞体中心最近的采样索引"打点 ⇒ 盒体中心落在两采样点**中点**，最近索引
 *      在 i/i+1 间来回跳 ⇒ 每隔一段空一格（假报 5 段，真缺 0 段）。
 *   ② 沿盒撒点后看"采样点横向 6m 内有没有盒" ⇒ 护栏在**离中心线 9.93m** 处
 *      （hw+cw+护栏厚），6m 半径根本够不着 ⇒ 假报 1440 段全缺。
 *   ③ 采样间距 5.10m 而盒只有 2.60m 半长，天然会有 2 个盒对应同一个采样点，
 *      "采样点覆盖"这个中介指标本身就不可靠。
 * 正解：**直接量盒与盒之间的空档** —— 对每个盒，找它两个端点在切向方向上
 * 最近的另一个盒，算端点间的空隙；对沿路连续的墙线，空隙应 < 1m。
 */
function auditBarriers(track) {
  const all = track.colliders || [];
  // 只取"墙线盒"：局部 z 轴是沿路方向的细长盒（hx 是横向半厚）
  const boxes = [];
  for (const c of all) {
    // ⚠️ 判据必须按 **hx（横向半厚）** 区分，不能按 hz：
    //   护栏 hx=1.0、盖梁 0.9、桥墩 0.55。旧代码用 `hz < 1.2` 想排掉桥墩，
    //   却把**合法的短护栏盒**（补洞盒、退化段邻接段）一起排除了 ——
    //   实测因此在铃鹿 46% 处假报 60.4m「未覆盖」，而独立探针（不设此过滤）是 0 未覆盖。
    if (track.trackType !== 'vegas' && c.hx < 0.8) continue;     // 只留下护栏/盖梁这类"墙线盒"
    const yaw = 2 * Math.atan2(c.qy || 0, c.qw || 1);
    boxes.push({
      x: c.x, z: c.z, hx: c.hx, hz: c.hz,
      ax: Math.sin(yaw), az: Math.cos(yaw),   // 沿路单位切向
      nx: Math.cos(yaw), nz: -Math.sin(yaw),  // 横向单位法向
    });
  }
  // 用网格加速"找邻居"（边数 5k+，朴素 O(n²) 也够，但别在 20 个种子上做）
  const cell = 12;
  const grid = new Map();
  const key = (cx, cz) => cx + ',' + cz;
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    const cx = Math.floor(b.x / cell), cz = Math.floor(b.z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const kk = key(cx + dx, cz + dz);
      if (!grid.has(kk)) grid.set(kk, []);
      grid.get(kk).push(k);
    }
  }
  // ★ 判据升级（2026-09-30 护栏盒合并成长段后，旧的"相邻盒端点空隙"会假报）：
  //   改为**逐米覆盖**：沿真实护栏线每 1m 取样（两侧都取），必须落在某个盒内；
  //   返回最长**连续**未覆盖长度（米）。这个判据与"盒是长是短"完全无关。
  const latFn = track.barrierLatArr ? ((i) => track.barrierLatArr[i])
    : ((i) => track.barrierLat || (track.halfWidth + track.curbWidth + 0.75));
  let runM = 0, worst = 0, worstAt = -1, nChecked = 0, uncovered = 0;
  const enabled = (i, d) => !track.barrierSideAt || track.barrierSideAt[i * 2 + (d > 0 ? 1 : 0)];
  for (let i = 0; i < track.count; i++) {
    // ⚠️ 必须按**段中点 + 两端平均横向**采样：护栏盒正是按这个口径摆的
    //    （box 中心 = 弦中点、横向 = (latAt(i)+latAt(j))/2）。拿单点 latAt(i) 去比，
    //    在 barrierLatArr 的跳变处会差出 >1m 而误报"未覆盖"（实测铃鹿 34.9% 那 4m）。
    const j = (i + 1) % track.count;
    const pp = { x: (track.pts[i].x + track.pts[j].x) * 0.5, z: (track.pts[i].z + track.pts[j].z) * 0.5 };
    const ss = { x: (track.side[i].x + track.side[j].x) * 0.5, z: (track.side[i].z + track.side[j].z) * 0.5 };
    const sl2 = Math.hypot(ss.x, ss.z) || 1; ss.x /= sl2; ss.z /= sl2;
    const lat = (latFn(i) + latFn(j)) * 0.5;
    let missing = false;
    const anyEnabled = enabled(i, 1) || enabled(i, -1);
    if (!anyEnabled) continue;
    for (const d of [1, -1]) {
      if (!enabled(i, d)) continue;
      const px = pp.x + ss.x * d * lat, pz = pp.z + ss.z * d * lat;
      let inside = false;
      for (const b of boxes) {
        const dx = px - b.x, dz = pz - b.z;
        const lx = dx * b.nx + dz * b.nz;      // 横向（盒法向）
        const lz = dx * b.ax + dz * b.az;      // 沿路（盒切向）
        if (Math.abs(lx) <= b.hx + 0.06 && Math.abs(lz) <= b.hz + 0.06) { inside = true; break; }
      }
      if (!inside) { missing = true; uncovered++; }
    }
    nChecked += 2;
    if (missing) { runM += track.spacing; if (runM > worst) { worst = runM; worstAt = i; } }
    else runM = 0;
  }
  void worstAt;
  return { total: all.length, boxes: boxes.length, checked: nChecked, worst: +worst.toFixed(3), enabled: !!track.barriers, worstAt };
}

for (const type of TRACKS) {
  console.log('\n=== ' + type + ' · ' + SEEDS + ' 个随机种子 ===');
  let badHere = 0;
  for (let s = 0; s < SEEDS; s++) {
    const seed = Number(process.env.SEED || 0) || ((Math.random() * 0x7fffffff) >>> 0);
    let trk, built;
    try { trk = new Track(seed, type); built = trk.build(); if (trk.barriers && (!trk.colliders || trk.colliders.length === 0)) trk._buildBarriers(new THREE.Group()); if (NO_SKIRT) trk._noSkirtForProof = true; }
    catch (e) { console.log('  seed ' + seed + ' build() 抛异常: ' + e.message); badHere++; bad++; continue; }
    const N = trk.count, hw = trk.halfWidth;
    const reports = [];
    built.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const p = o.geometry.getAttribute('position');
      if (!p) return;
      const nm = o.name || '(unnamed)';
      const segs = p.count / 2 - 1;
      // ribbon 判定：单条 = N；mergeSimple 合并两条 = 2N+1（每条第 N+1 个顶点）
      if (p.count % 2 === 0 && (segs === N || segs === 2 * N || segs === 2 * N + 1)) {
        reports.push(auditRibbon(nm, o.geometry, segs, hw));
      } else {
        const arr = p.array;
        let nan = 0;
        for (let i = 0; i < arr.length; i++) if (!isFinite(arr[i])) nan++;
        if (nan) reports.push({ name: nm, segTotal: 0, missing: 0, nan, deg: 0, widMin: 0, widMax: 0, gaps: [], verts: p.count, refW: 0 });
      }
    });
    const bar = auditBarriers(trk);
    const probs = [];
    for (const r of reports) {
      if (r.nan) probs.push(r.name + ' NaN=' + r.nan);
      if (r.missing) probs.push(r.name + ' 缺段=' + r.missing + ' @' + r.gaps.join(','));
      if (r.deg) probs.push(r.name + ' 退化段=' + r.deg);
      // 沥青宽度必须与赛道自己声明的区间一致。
      // ⚠️ 不能假设定宽：真实铃鹿是**变宽**的（真车 10~16m，主直道最宽、
      //    发卡/减速弯最窄），`Track.halfWidthMin/Max` 就是权威区间。
      if (r.name === 'asphalt' && r.segTotal) {
        const lo = trk.halfWidthMin * 2 - 0.5, hi = trk.halfWidthMax * 2 + 0.5;
        if (r.widMin < lo || r.widMax > hi) {
          probs.push('asphalt 段宽超出声明区间 [' + lo.toFixed(2) + ',' + hi.toFixed(2) + ']：实测 '
            + r.widMin.toFixed(2) + '~' + r.widMax.toFixed(2));
        }
        // 变宽赛道还必须**真的变宽**（否则 widthAt 没接上）
        if (trk.halfWidthMax - trk.halfWidthMin > 0.2 && r.widMax - r.widMin < 0.3) {
          probs.push('声明了变宽（' + trk.halfWidthMin + '~' + trk.halfWidthMax + '）但沥青是定宽 '
            + r.widMax.toFixed(2));
        }
      }
    }
    // ★★ 地形裙边（2026-09-30 重新定义口径）
    //
    // 旧口径：把草地**外侧**顶点一律拉到固定高度 TERRAIN_FLOOR_Y（-26 的大地圆盘）。
    //   那套虽然补上了"缺一块"，但制造出 18~30m 的垂直悬崖 + 外围深坑，
    //   用户新报障"赛道外的路段塌陷"就是它。
    //
    // 新口径：外侧顶点下沉到**本地地面层 − TERRAIN_LIP**（逐采样点），
    //   由 `_buildGround()` 的地形网格在同一高度接住。所以这里验三件事：
    //     ① 外侧列确实被下沉了（≥98% 落在 baseY[i] − LIP，允许 ±2cm）；
    //     ② **内侧列不许被下沉**（左右两条 buffer 的顶点顺序是相反的，
    //        曾经把左草皮的内侧列拉下去 ⇒ 贴路肩劈出深沟）；
    //     ③ 下沉量是浅唇（< 3m），不是悬崖。
    {
      let buf = null;
      built.group.traverse((o) => { if (o.isMesh && o.name === 'buffer') buf = o; });
      // 反证开关（仅测试用）：
      //   NO_SKIRT=1 → 两侧都不下沉（还原"完全没裙边"的旧行为）⇒ 必须报"裙边缺失"
      //   NO_SKIRT=2 → 把**内侧**列拉下去 25m（还原 2026-09-30 修掉的"左右接反" bug）
      //                ⇒ 必须报"裙边接反"
      if (buf && NO_SKIRT) {
        const P0 = buf.geometry.getAttribute('position');
        const A = P0.array;
        for (let k = 0; k + 5 < A.length; k += 6) {
          if (NO_SKIRT === '2') {
            // 内侧 = 较高的那一列，把它拉到 25m 深
            const hi = A[k + 1] >= A[k + 4] ? k + 1 : k + 4;
            A[hi] -= 25;
          } else {
            const g = trk.baseY[(k / 6) % N];
            A[k + 1] = Math.max(A[k + 1], g - 1.1);
            A[k + 4] = Math.max(A[k + 4], g - 1.1);
          }
        }
        P0.needsUpdate = true;
      }
      if (!buf) probs.push('找不到 buffer 网格（草地/缓冲区）');
      else {
        const P = buf.geometry.getAttribute('position').array;
        // ★ 新语义（2026-09-30 锥形包络）：裙边唇口 = **该处地形锥面高度**
        //   （`Track.terrainConeY`，与地形网格同一个函数）。所以要守的不变量是：
        //     ① 唇口**落在地形上**（|唇口 − 地形锥面| 小）⇒ 不会悬空露出缝隙；
        //     ② **内列**仍在草皮内沿高度（本地地面层 − 0.10）⇒ 抓"左右接反"那个老 bug
        //        （曾经把左草皮贴路肩的内侧列拉到地面，在路边劈出深沟）。
        //   旧判据"外侧必须落到本地地面层 − LIP"已废：现在外侧跟随地形，落差取决于地形。
        let segs = 0, okOuter = 0, okInner = 0, innerMoved = 0, maxDrop = 0;
        const cw2 = TRACK_CFG.CURB_W;
        for (let k = 0; k + 5 < P.length; k += 6) {
          const i2 = Math.floor(k / 6) % N;             // 段号（两半各 SEGS 段，偏差 ≤1 段）
          const yA = P[k + 1], yB = P[k + 4];
          // ⚠️ "哪一列是外侧"必须按**横向距离**判定，不能按高度：地形平坦处两列高差可能
          //    只有 1cm，按"更低者"会随机选到内列 ⇒ 断言与位置错配（vegas 上假红 2.4%）。
          const si = trk.side[i2], pi2 = trk.pts[i2];
          const latA = Math.abs((P[k] - pi2.x) * si.x + (P[k + 2] - pi2.z) * si.z);
          const latB = Math.abs((P[k + 3] - pi2.x) * si.x + (P[k + 5] - pi2.z) * si.z);
          const outerIsA = latA >= latB;
          const ox = outerIsA ? P[k] : P[k + 3], oz = outerIsA ? P[k + 2] : P[k + 5];
          const lower = outerIsA ? yA : yB;
          const iy = outerIsA ? yB : yA;
          const higher = Math.max(yA, yB);
          segs++;
          // ① 唇口**不许悬空在地形之上**（否则能看穿见底）。
          //    注意是**单边**判据：地形比唇口高（天然小土丘）不算问题 —— 地形网格在
          //    离中心线 51m 处高出草皮是无害的，真正有害的只有"唇口悬在半空"。
          if (lower <= trk.terrainConeY(ox, oz) + 0.6) okOuter++;
          // ② 内列仍接近草皮内沿（本地地面层 − 0.10），允许 ±0.35m 的采样偏差
          if (trk.baseY[i2] !== undefined && Math.abs(iy - (trk.baseY[i2] - 0.10)) < 0.35) okInner++;
          const drop = higher - lower;
          if (drop > maxDrop) maxDrop = drop;
          if (drop > 12.0) innerMoved++;
        }
        const ratio = segs ? okOuter / segs : 0;
        const ratioIn = segs ? okInner / segs : 0;
        if (ratio < 0.98) {
          probs.push('裙边唇口没有落在地形上：只有 ' + (ratio * 100).toFixed(1)
            + '% 的段外侧顶点等于该处地形锥面高度（会悬空露出缝隙）');
        }
        if (ratioIn < 0.98) {
          probs.push('裙边接反：只有 ' + (ratioIn * 100).toFixed(1)
            + '% 的段内侧列仍在草皮内沿高度（内侧列被误下沉 ⇒ 路边深沟）');
        }
        if (innerMoved > 0) {
          probs.push('裙边落差过大：' + innerMoved + ' 段 >12m（疑似悬空断崖）');
        }
      }
    }
    if (bar.enabled && bar.worst > 1.0) probs.push('护栏相邻盒空隙 ' + bar.worst.toFixed(2) + 'm（>1m 就能钻出去）');

    // ★ 走线（raceLine）必须留在**自己这条路**的路面内
    //   （用户报障"赛道外的处理不好、不符合物理"：绿线把玩家带出赛道）。
    //   ⚠️ 判据只能是"相对本点路面的横向余量"，**不能**写成"不许靠近别段路面"：
    //      发卡/减速弯处同一段路折返后的另一截也是沥青，绿线压上去是**正常行车线**；
    //      立交处另一层高 6.5m，绿线从桥下穿过也正常。那种判据会假报 3000+ 处（踩过）。
    {
      const rl = trk.raceLine;
      if (rl && rl.active) {
        const MARGIN = TRACK_CFG.RACE_LINE_MARGIN;
        let bad2 = 0, worst2 = 0, at2 = -1;
        for (let i = 0; i < N; i++) {
          const lim = Math.max(0.2, trk.halfWidthAt[i] - MARGIN);
          const over = Math.abs(rl.offset[i]) - lim;
          if (over > 0.02) { bad2++; if (over > worst2) { worst2 = over; at2 = i; } }
        }
        if (bad2 > 0) {
          probs.push('走线跑出本段路面：' + bad2 + ' 点，最外 ' + worst2.toFixed(2)
            + 'm @' + (100 * at2 / N).toFixed(1) + '%（绿线会把玩家带出赛道）');
        }
      }
    }
    // ★★ 缓冲区（草地）不得侵入赛道的**其他路段**（用户报障："铃鹿后段有草地入侵到赛道"）
    //
    // 成因：草皮带横向铺 42m（`GRASS_W`），而赛道在发卡/减速弯/立交处会**折返**，
    //   两段中心线只隔十几到几十米 ⇒ 甲段的草皮直接盖到乙段的沥青上。
    // 判据（与几何布局无关，直接量顶点）：对每个草皮顶点，找**非邻近**（沿赛道
    //   相差 > MIN_SEP 个采样点）的最近中心线采样点 j，则该顶点到 j 的横向距离
    //   必须 ≥ j 处的"路肩外沿"（halfWidthAt[j] + CURB_W），否则就是压在了乙段路上。
    {
      let bufMesh = null;
      built.group.traverse((o) => { if (o.isMesh && o.name === 'buffer') bufMesh = o; });
      // 反证开关（仅测试用）：把草地外沿还原成"恒为 hw+cw+42"的**旧行为**
      // （即不做逐点收缩）⇒ 本断言必须报红，否则断言是死的。
      if (bufMesh && NO_GRASS_CLIP) {
        const G = bufMesh.geometry.getAttribute('position');
        const A = G.array;
        let seg2 = -1;
        for (let k = 0; k + 5 < A.length; k += 6) {
          seg2++;
          const i = seg2 % N;
          const outer = A[k + 1] < A[k + 4] ? k : k + 3;   // 更低的那列 = 外侧
          const inner = outer === k ? k + 3 : k;
          // 恢复到旧横向：把外侧顶点推到 hw+cw+42（沿内→外方向延长）
          const dx = A[outer] - A[inner], dz = A[outer + 2] - A[inner + 2];
          const cur = Math.hypot(dx, dz) || 1;
          const want = trk.halfWidthAt[i] + TRACK_CFG.CURB_W + TRACK_CFG.GRASS_W;
          const f = want / cur;
          A[outer] = A[inner] + dx * f;
          A[outer + 2] = A[inner + 2] + dz * f;
          A[outer + 1] = trk.baseY[i] - 1.6;
        }
        G.needsUpdate = true;
      }
      if (bufMesh) {
        const MIN_SEP = 24;                   // ≈96m 弧长之外才算"另一段路"
        const cw = TRACK_CFG.CURB_W;
        const P = bufMesh.geometry.getAttribute('position').array;
        let worst = 0, worstAt = -1, hits = 0;
        for (let k = 0; k + 2 < P.length; k += 3) {
          const x = P[k], z = P[k + 2];
          // 最近的非邻近采样点
          let bd = Infinity, bj = -1;
          // 顶点下标 → 段号：每段 2 个顶点 ⇒ 段号 = floor(顶点号/2) = floor(k/3/2)
          // ⚠️ 曾写成 k/6/2（多除了一次 2），排除区只有应有的一半。
          const seg = Math.floor(k / 3 / 2);
          for (let j = 0; j < N; j++) {
            const dj = Math.abs(j - seg) % N;
            const sep = Math.min(dj, N - dj);
            if (sep < MIN_SEP) continue;
            const dx = trk.pts[j].x - x, dz = trk.pts[j].z - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bd) { bd = d2; bj = j; }
          }
          if (bj < 0) continue;
          // ⚠️ 必须做**三维**判定：铃鹿 39%↔80% 是 8 字立交，两层在 XZ 上重叠但
          //    相距 4~7m —— 桥下那片草皮本来就该在桥面**下方**，不是"入侵"。
          //    只有"高度也贴到那段路面"（|Δy| < 1.5m）才是真的压在路上。
          const otherY = trk.pts[bj].y;
          if (Math.abs(P[k + 1] - otherY) > 1.5) continue;
          const need = trk.halfWidthAt[bj] + cw - 0.05;   // 容差 5cm（正好贴到路肩外沿不算入侵）
          const d = Math.sqrt(bd);
          if (d < need) { hits++; if (need - d > worst) { worst = need - d; worstAt = bj; } }
        }
        if (hits > 0) {
          probs.push('草地侵入赛道路面：' + hits + ' 个顶点压在别段路上，最深 '
            + worst.toFixed(2) + 'm @采样' + worstAt + '（' + (100 * worstAt / N).toFixed(1) + '%）');
        }
      }
    }
    if (VERBOSE || probs.length) {
      console.log((probs.length ? '  ✗ ' : '  ✓ ') + 'seed ' + seed + ' N=' + N + ' 半宽=' + hw.toFixed(2)
        + '  护栏盒 ' + bar.boxes + ' 个  最大相邻空隙 ' + bar.worst.toFixed(2) + 'm');
      for (const r of reports) {
        if (!VERBOSE && !r.segTotal) continue;
        console.log('      ' + r.name.padEnd(11) + ' verts=' + String(r.verts).padStart(5)
          + ' 段=' + r.segTotal + ' 缺=' + r.missing + ' NaN=' + r.nan + ' 退化=' + r.deg
          + ' 段宽 ' + (r.segTotal ? r.widMin.toFixed(2) + '~' + r.widMax.toFixed(2) : '-')
          + (r.gaps.length ? ' 首个缺段 #' + r.gaps.join(',') : ''));
      }
      for (const m of probs) console.log('      ⚠ ' + m);
    }
    if (probs.length) { badHere++; bad++; }
  }
  console.log('  问题种子 ' + badHere + '/' + SEEDS);
}

console.log(bad ? '\n\x1b[31m发现 ' + bad + ' 处几何问题\x1b[0m'
  : '\n\x1b[32m所有种子：赛道几何完整（无缺段 / 无 NaN / 无退化 / 护栏无空缺）\x1b[0m');
process.exitCode = bad ? 1 : 0;
