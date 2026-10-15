/* =============================================================================
 * 圈数/完赛判定康复检查（用户报障："出现到达终点却没完赛"）
 *
 * 背景：铃鹿换真实走线后是**8 字立体交叉**。判定圈数用的是
 *   cpNow = floor(trackIdx / samplesPerCp) % checkpointCount
 * 即完全由"最近赛道索引"推导。立交处上下两层在 XZ 上重叠，只靠高度分层；
 * 一旦某帧分层判错，trackIdx 会整段跳变 ⇒ cpNow 乱跳 ⇒ progress 累计不满
 * checkpointCount-1 ⇒ 冲线时判为"抄近道"而不是完赛（圈数不涨、还吃罚时）。
 *
 * 本脚本不做任何假设，直接跑完一圈并**逐帧**监视：
 *   ① 单帧 |ΔtrackIdx| 是否出现异常跳变（正常前进每帧只跨几个采样点）；
 *   ② cpNow 是否按序推进（是否出现"倒序/跳号"）；
 *   ③ 冲线后 lap 是否真的 +1、是否被记成 shortcut。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Track } from '../public/js/track.js';
import { RacePhysics, CFG } from '../public/js/physics.js';

// three 以 UMD 注入成 globalThis.THREE（物理层要用 Vector3/Quaternion）
// ⚠️ 必须用 fileURLToPath：本仓库路径含中文，手写 import.meta.url 解码会留下 %E6.. 转义。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8'));
if (!globalThis.THREE) { console.error('无法注入 three.min.js'); process.exit(1); }
// 最小 DOM 桩：track.build() 会画发车横幅
globalThis.document = globalThis.document || {
  createElement: () => ({
    width: 0, height: 0, style: {},
    getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }),
    toDataURL: () => 'data:,',
  }),
  getElementById: () => null, querySelector: () => null, body: { appendChild() {} },
};
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {} };

let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  PASS ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  FAIL ' + n + '   ' + d); } };

const track = new Track(4242);
const rp = new RacePhysics(track);
rp.racing = true;
const g = track.gridSlot(1);
const car = rp.addCar({ id: 1, name: 'AI', color: '#e10600', isLocal: false, startIndex: g.index, lateral: g.lateral, laps: 2 });
car.auto = true;

const N = track.pts.length;
const DT = 1 / 60;
const SIM_S = Math.ceil((3 * track.length) / (80 / 3.6)) + 40;
const STEPS = Math.round(60 * SIM_S);

let prevIdx = car.trackIdx;
let maxJump = 0, jumpAtPct = 0, jumpCount = 0;
const jumpPcts = [];
const cpSeq = [];
let prevCp = -1, backSteps = 0, skipSteps = 0;
let lapCount = 0, finishCount = 0, shortcutLaps = 0;
const origCross = rp.onCrossLine;
rp.onFinish = () => { finishCount++; };
rp.onLap = () => { lapCount++; };

const half = (track.checkpointCount || 24) / 2;
for (let s = 0; s < STEPS; s++) {
  rp.step(DT);
  const idx = car.trackIdx;
  let d = idx - prevIdx;
  if (d < -N / 2) d += N;          // 跨圈回绕
  if (d > N / 2) d -= N;
  if (Math.abs(d) > maxJump) { maxJump = Math.abs(d); jumpAtPct = 100 * idx / N; }
  // 正常一帧位移：60Hz 下最快约 300km/h ⇒ 83m/s ⇒ 3 个采样点（spacing≈4m）
  if (Math.abs(d) > 40) { jumpCount++; if (jumpPcts.length < 8) jumpPcts.push({ pct: +(100 * idx / N).toFixed(2), d }); }
  const cpNow = Math.floor(idx / track.samplesPerCp) % track.checkpointCount;
  if (cpNow !== prevCp) {
    if (prevCp >= 0) {
      let dd = cpNow - prevCp;
      if (dd < -half) dd += track.checkpointCount;
      if (dd > half) dd -= track.checkpointCount;
      if (dd <= 0) backSteps++; else if (dd > 1) skipSteps++;
      if (cpSeq.length < 12) cpSeq.push(prevCp + '->' + cpNow + '(+' + dd + ')');
    }
    prevCp = cpNow;
  }
  prevIdx = idx;
  if (finishCount) break;
}

console.log('  赛道: 采样点 ' + N + ' / 每 CP ' + track.samplesPerCp + ' 点 / CP 数 ' + track.checkpointCount);
console.log('  单帧 trackIdx 最大推进 ' + maxJump + ' 点（发生在 ' + jumpAtPct.toFixed(2) + '% 处）');
console.log('  异常跳变帧数(>40点): ' + jumpCount + '  ' + JSON.stringify(jumpPcts));
console.log('  CP 前 12 次变化: ' + cpSeq.join(' '));
console.log('  CP 倒退次数 ' + backSteps + ' / 跳号次数 ' + skipSteps);
console.log('  圈数事件 lap=' + lapCount + ' finish=' + finishCount + ' / 车 lap=' + car.lap + ' 罚时=' + car.penalty.toFixed(1));

ok(maxJump < 40, '单帧赛道索引无异常跳变（立交处分层未判错）', 'max=' + maxJump + ' 点 @' + jumpAtPct.toFixed(2) + '%');
ok(backSteps === 0, 'CP 索引从不倒退', '倒退 ' + backSteps + ' 次');
ok(car.lap >= 2, 'AI 能正常累加圈数（到终点真完赛）', 'lap=' + car.lap);
ok(finishCount >= 1, '触发了完赛事件', 'finish=' + finishCount);

/* ---------------------------------------------------------------------------
 * ② 不同发车位置下"1 圈赛"必须恰好跑 1 圈就完赛
 *    （用户报障："出现到达终点却没完赛" —— 跑完一圈冲线却毫无反应）
 * ------------------------------------------------------------------------- */
for (const [tag, idx] of [['压线起步 index=0', 0], ['线后起步 index=30', 30], ['正常发车格 index=1434', 1434]]) {
  const tp = new Track(4242);
  const q = new RacePhysics(tp);
  q.racing = true;
  const cc = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: false, startIndex: idx, lateral: 0, laps: 1 });
  cc.auto = true;
  let fin = 0;
  q.onFinish = () => { fin++; };
  // ★ 监视"起步阶段"就被罚（用户报障："起步经过终点线就显示未集齐检查点罚时 2 秒"）。
  //   发车格在线前，起步后第一次压线必须只"上膛"：progress≈1、绝不该进 shortcut 分支。
  //   ⚠️ 上一版这里只断言了 lap/finish，**漏掉了罚时** ⇒ 判据写反（`!== 0`）也没被发现。
  let penAtStart = 0, shortcutEvents = 0;
  const origAdd = cc.addPenalty.bind(cc);
  cc.addPenalty = (v, r) => { if (r === 'cut') shortcutEvents++; return origAdd(v, r); };
  const S2 = Math.round(60 * ((2.2 * tp.length) / (80 / 3.6) + 30));
  let prevLap = 0;
  for (let s2 = 0; s2 < S2; s2++) {
    q.step(DT);
    // 起步阶段 = 第一次压线之后到本圈跑完之前（q.time < 首圈用时的一半）
    if (q.time < 12 && cc.penalty > penAtStart) penAtStart = cc.penalty;
    if (cc.lap !== prevLap) { prevLap = cc.lap; }
    if (fin) break;
  }
  ok(penAtStart === 0 && shortcutEvents === 0,
    '1 圈赛：' + tag + ' 起步压线不被误判"未集齐检查点"（无 2s 罚时）',
    '起步罚时 ' + penAtStart.toFixed(2) + 's / 切弯事件 ' + shortcutEvents + ' 次');
  ok(fin === 1 && cc.lap === 1, '1 圈赛：' + tag + ' 跑满 1 圈即完赛', 'lap=' + cc.lap + ' 完赛=' + fin);
}

/* ---------------------------------------------------------------------------
 * ③ 复位（R 键）不得破坏计圈：复位到起终点后仍要能正常冲线完赛
 * ------------------------------------------------------------------------- */
{
  // 两种复位落点都要验：① 默认（回上一条合法驶出锚点）② 起点模式（瞬移到起终点线，
  // 落点桶 = CP0，是最容易把记圈簿记搞坏的一种）。
  for (const mode of ['anchor', 'start']) {
    const tp = new Track(4242);
    const q = new RacePhysics(tp);
    q.racing = true;
    const cc = q.addCar({ id: 1, name: 'A', color: '#fff', isLocal: false, startIndex: 1434, lateral: 0, laps: 1 });
    cc.auto = true;
    const S3 = Math.round(60 * ((0.35 * tp.length) / (80 / 3.6)));
    for (let s3 = 0; s3 < S3; s3++) q.step(DT);
    const penBefore = cc.penalty;
    const savedDepart = CFG.RESCUE_TO_DEPART;
    if (mode === 'start') CFG.RESCUE_TO_DEPART = false;   // 关掉锚点 -> 走"瞬移到起终点线"
    q.rescueToCheckpoint(cc, true);
    CFG.RESCUE_TO_DEPART = savedDepart;
    const penJump = cc.penalty - penBefore;
    const wantBucket = Math.floor(cc.trackIdx / tp.samplesPerCp) % tp.checkpointCount;
    const tag = mode === 'anchor' ? '复位到锚点' : '复位到起终点线';
    ok(penJump <= CFG.RESCUE_PENALTY + 1e-6,
      tag + '只罚 1 笔复位罚时（不再误判沿途切弯）',
      '+' + penJump.toFixed(2) + 's (RESCUE=' + CFG.RESCUE_PENALTY + 's)');
    ok(cc.progress === wantBucket && cc.cpIdx === wantBucket,
      tag + '后本圈簿记同步到落点桶',
      'progress=' + cc.progress + ' cpIdx=' + cc.cpIdx + ' 落点桶=' + wantBucket);
    let fin2 = 0;
    q.onFinish = () => { fin2++; };
    const S4 = Math.round(60 * ((2.0 * tp.length) / (80 / 3.6) + 30));
    for (let s4 = 0; s4 < S4 && !fin2; s4++) q.step(DT);
    ok(fin2 === 1, tag + '后仍能跑到终点完赛（不再"到终点没完赛"）',
      'lap=' + cc.lap + ' 完赛=' + fin2 + ' 罚时=' + cc.penalty.toFixed(1) + 's');
  }
}

try { rp.destroy && rp.destroy(); } catch (e) { /* ignore */ }
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
