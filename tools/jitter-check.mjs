/* 车辆"一顶一顶"（速度/位置抖动）真机量化。
 *
 * 判据（真机 118fps）：
 *   · 单帧前进距离 ≤ 车速×帧长 + 容差。133ms 卡帧时 @110km/h 单帧会"传送"4m；
 *     现在 8.3ms 帧 ⇒ ≤0.25m。
 *   · 相邻帧速度**倒退**（Δv < −3km/h）的帧数应该是 0 —— 那正是"顶一下"的手感。
 *   · 相邻帧速度突变 |Δv| 的最大值应 << 一个帧长内物理上可能的变化。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 8096, CDP = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = resolve(import.meta.dirname, '..');
const srv = spawn(join(root, 'forzalan.exe'), ['-addr', '127.0.0.1:' + PORT, '-quiet'], {
  cwd: mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'handling-jitter-data-')), windowsHide: true, stdio: 'ignore',
});
await sleep(1500);
const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const child = spawn(browser, ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tc-jit-'))}`,
  '--no-first-run', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const waits = new Map(), exceptions = [];
const cleanup = () => {
  for (const pending of waits.values()) clearTimeout(pending.timer);
  ws?.close();
  try { child.kill(); } catch (_) { /* */ }
  try { srv.kill(); } catch (_) { /* */ }
};
process.once('exit', cleanup);
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); }
  } catch (_) { /* */ }
  if (!ws) await sleep(200);
}
assert.ok(ws, 'Edge CDP is available');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); clearTimeout(w.timer); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id, timer = setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error(method + ' timeout')); } }, 10000); waits.set(i, { res, rej, timer }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };

let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  \x1b[32mPASS\x1b[0m ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + '   ' + d); } };

await send('Runtime.enable');
await send('Page.enable');
// 每帧记录本地车：帧长、轮上速度、**物理速度矢量**、位置、是否在碰撞中
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__jit = [];
    const _raf = window.requestAnimationFrame.bind(window);
    let prev = 0, bridge = null, contactSeen = 0;
    window.requestAnimationFrame = (cb) => _raf((ts) => {
      if (prev && ts - prev > 1) {
        const S = window.__S, c = S && S.localCar;
        if (c && c.body && S.rp && S.rp.racing) {
          if (bridge !== S.rp) {
            bridge = S.rp;
            bridge.on('state', () => { contactSeen |= S.localCar?.contact ? 1 : 0; });
          }
          const p = c.body.position, v = c.body.velocity;
          const vm = Math.hypot(v.x, v.y, v.z);
          // 慢帧内可能先撞墙再离开，不能只读最后一个物理包而丢掉中间接触。
          const contact = contactSeen | (c.contact ? 1 : 0);
          contactSeen = 0;
          const f = window.__jit;
          const q = c.body.quaternion;
          if (f.length < 200000) f.push([+(ts - prev).toFixed(3), +c.speedKmh.toFixed(3),
            +vm.toFixed(4), +p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4), contact,
            // 直接使用 Worker 随状态包回传的真实步数，缺失时验收失败。
            S.rp.physicsStep, c.terrainContact ? 1 : 0, c.surface, c.airborne ? 1 : 0, c.ghostReasonCode, c.rescueGhost ? 1 : 0, c.trackIdx, JSON.stringify(c.contactDetails || []),
            +q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5), +q.w.toFixed(5),
            +(c.roadNormal?.x || 0).toFixed(5), +(c.roadNormal?.y || 0).toFixed(5), +(c.roadNormal?.z || 0).toFixed(5), +Number(c.curbH || 0).toFixed(5)]);
        }
      }
      prev = ts;
      cb(ts);
    });
  })()`,
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&track=suzuka&laps=5` });
let running = false;
for (let i = 0; i < 150; i++) {
  running = await ev('!!(window.__S?.rp?.racing && window.__S.rp.physicsStep >= 0)');
  if (running) break;
  await sleep(100);
}
assert.ok(running, 'Worker race started after lights and prewarm');
await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, text: 'w' });
await sleep(20000);
const jit = await ev('window.__jit.slice(0, 200000)');
writeFileSync('jitter-raw-report.json', JSON.stringify({columns:['frameMs','kmh','velocityMagnitude','x','y','z','carWallContact','physicsStep','terrainContact','surface','airborne','ghostReason','rescueGhost','trackIdx','contactDetails','quatX','quatY','quatZ','quatW','roadNormalX','roadNormalY','roadNormalZ','curbH'],frames:jit}));
if (jit.length < 100 || jit.some(f => !Number.isInteger(f[7]) || f[7] < 0)) throw new Error('缺少真实 Worker 步数或样本不足');
await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

console.log('\n\x1b[1m车辆"一顶一顶"量化（' + jit.length + ' 帧）\x1b[0m');
// 分两类：自由行驶（本帧无接触）vs 碰撞帧（撞墙/蹭车，速度突变是物理应该的）
const free = [], hit = [];
for (let i = 1; i < jit.length; i++) {
  const [dt, kmh, vm, x, y, z, contact, sn] = jit[i];
  const [, pkmh, pvm, px, py, pz, pcontact, psn] = jit[i - 1];
  const rec = { pvm, sn, psn, terrainContact:jit[i][8] | jit[i - 1][8], surface:jit[i][9], airborne:jit[i][10], ghostReason:jit[i][11], rescueGhost:jit[i][12], trackIdx:jit[i][13], contactDetails:jit[i][14], x, y, z,
    i, dt, dv: kmh - pkmh, step: Math.hypot(x - px, y - py, z - pz),
    expect: pvm * (dt / 1000), vm, kmh, contact: contact | pcontact,
  };
  (rec.contact ? hit : free).push(rec);
}
const stat = (arr, key) => { const v = arr.map((r) => r[key]).sort((a, b) => a - b); return { p50: v[v.length >> 1], p99: v[Math.floor(v.length * 0.99)], max: v[v.length - 1] }; };
// ★ 关键前提：渲染是 120Hz，但物理是**固定 60Hz 子步**（raceState.substep=0.016666…）。
//   所以"每帧位移"不能用 rAF 的 dt 去算 —— 累加器会在某些帧跑 1 个子步、某些帧跑 0 个，
//   于是位移天然是 0 / 0.98m 交替（实测 p50=0.0003m、p99=0.991m）。
//   正确的"物理上界"= 车速 × **子步长**（+ 容差），不是车速 × 帧长。
const PHYS_DT = 1 / 60;
// ⚠️ 物理是**累加器**：帧偏短时这帧推 0 个子步（位移 0），攒够一个子步才动一次。
//    所以"单帧位移上界"必须用**这一帧实际推进的子步数**算，而不是用帧长猜。
//    cannon 把子步数放在 `world.stepnumber` 上（每次内部步进 +1），探针已一并采集。
//    旧实现用 `max(单步, v·帧长)` ⇒ 负载高时报出 33 帧假"跳跃"（最大 1.761m ≈ 两帧位移）。
{
  const all = free.concat(hit).sort((a, b) => a.i - b.i);
  for (let k = 0; k < all.length; k++) {
    const r = all[k];
    const steps = r.sn - r.psn;
    if (steps < 0) throw new Error('Worker 物理步数倒退');
    const vmax = Math.max(r.pvm, r.vm);   // 区间端点的保守车速
    const bound = vmax * PHYS_DT * steps * 1.2 + 0.06;
    r.allow = bound;
    r.steps = steps;
    r.over = r.step / Math.max(bound, 0.05);
  }
}
console.log('  自由行驶帧 ' + free.length + '（' + (free.length / (jit.length - 1) * 100).toFixed(1) + '%）'
  + '   碰撞帧 ' + hit.length);
console.log('  速度 km/h：' + jit[0][1].toFixed(1) + ' → 峰值 ' + Math.max(...jit.map((f) => f[1])).toFixed(1)
  + ' → 末帧 ' + jit[jit.length - 1][1].toFixed(1));
const dvF = stat(free, 'dv');
const stF = stat(free, 'step');
const exF = free.map((r) => r.over);
exF.sort((a, b) => a - b);
console.log('  【自由行驶】Δv(km/h) p50=' + dvF.p50.toFixed(3) + ' p99=' + dvF.p99.toFixed(3) + ' max=' + dvF.max.toFixed(3));
console.log('  【自由行驶】单帧位移 p50=' + stF.p50.toFixed(4) + 'm p99=' + stF.p99.toFixed(3) + 'm max=' + stF.max.toFixed(3) + 'm');
console.log('  【自由行驶】位移/物理上界 比值 p50=' + exF[exF.length >> 1].toFixed(2) + ' p99=' + exF[Math.floor(exF.length * 0.99)].toFixed(2) + ' max=' + exF[exF.length - 1].toFixed(2));
console.log('  （本探针检查 Worker 的物理状态；视觉插值由单独的渲染探针验收）');
if (hit.length) {
  const dvH = stat(hit, 'dv');
  console.log('  【碰撞帧】Δv 最大 ' + Math.max(...hit.map((r) => Math.abs(r.dv))).toFixed(2) + ' km/h（撞墙减速，物理应有）');
  const worstHit = [...hit].sort((a, b) => a.dv - b.dv)[0];
  console.log('           最大减速帧：帧' + worstHit.i + ' Δv=' + worstHit.dv.toFixed(2)
    + ' 车速 ' + worstHit.kmh.toFixed(0) + 'km/h');
}
const backFree = free.filter((r) => r.dv < -3).length;
// 所有自由行驶帧均按真实步数验算，不剔除慢帧，也不猜测步数。
const jumpFree = free.filter((r) => r.over > 1.0).length;
console.log('  【自由行驶】速度倒退帧 ' + backFree + '   超出物理上界的"跳跃"帧 ' + jumpFree);
// 打印最差的几帧，便于人工判断到底是不是"顶"
console.log('  自由行驶中最差的 5 帧（按 |Δv|）：');
for (const r of [...free].sort((a, b) => Math.abs(b.dv) - Math.abs(a.dv)).slice(0, 5)) {
  console.log('      帧' + r.i + '  dt=' + r.dt.toFixed(1) + 'ms  Δv=' + r.dv.toFixed(3)
    + 'km/h  位移=' + r.step.toFixed(3) + 'm  上界=' + r.allow.toFixed(3) + 'm  车速=' + r.kmh.toFixed(1));
}

ok(dvF.max < 2.0, '★★自由行驶单帧速度突变 < 2km/h（不再"一顶一顶"）', dvF.max.toFixed(3) + ' km/h');
ok(dvF.p99 < 1.0, '★★自由行驶 99% 的帧速度变化 < 1km/h', dvF.p99.toFixed(3));
ok(backFree === 0, '★★自由行驶全程没有"速度倒退"帧（车不会往回顶）', backFree + ' 帧');
ok(jumpFree === 0, '★★自由行驶没有超物理上界的位置跳跃帧', jumpFree + ' 帧');
// 上界按**该帧实际推的子步数**算（见上面的说明）：位移本身允许随补步增长，
// 判据是"没有超过 v·子步·子步数"。
ok(free.length > 100, '★自由行驶样本充足且每帧具有 Worker 步数', free.length + ' 帧');
ok(exceptions.length === 0, '★浏览器无运行时异常', exceptions.join('\n'));
writeFileSync('jitter-report.json', JSON.stringify({ n: jit.length, free: free.length, hit: hit.length,
  dvFreeMax: dvF.max, dvFreeP99: dvF.p99, backFree, jumpFree, maxStepFree: stF.max,
  peakKmh: Math.max(...jit.map((f) => f[1])),
  worst: [...free].sort((a, b) => Math.abs(b.dv) - Math.abs(a.dv)).slice(0, 10) }, null, 2));
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
cleanup();
process.exitCode = fail ? 1 : 0;
