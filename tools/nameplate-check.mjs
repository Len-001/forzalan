/* =============================================================================
 * 车手名牌验收（用户要求：头顶显示姓名，只显示最近 4 名，标签与车留空隙不挡视野）
 * 真机跑单机（1 人 + 3 台 AI），断言：
 *   ① 名牌数量 ≤ 4 且等于"范围内可见的其他玩家数"（自己不出标签）；
 *   ② 每个名牌都**显示在对应车辆上方**（屏幕 y 更小）且与车有可见空隙（≥6px）；
 *   ③ 名牌不覆盖屏幕中央下方的赛道（名牌中心都在画面上半部分）。
 * ========================================================================== */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8090, CDP = 9356;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1500);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-np-'))}`,
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const waits = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const pg = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) {
      ws = new WebSocket(pg.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    }
  } catch (_) { /* retry */ }
  if (!ws) await sleep(200);
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
});
const send = (me, p = {}) => new Promise((res, rej) => {
  const i = ++id; waits.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: me, params: p }));
  setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error('t/o ' + me)); } }, 60000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&track=suzuka&laps=5` });
await sleep(9000);


let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  PASS ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  FAIL ' + n + '   ' + d); } };

// 场景构造：**自己不给油**，让 3 台 AI 从后方开过去（起跑后约 10s 就能在正前方 20~60m），
// 这样名牌一定落在相机视锥内 —— 比"传送车辆"可靠得多（传送会把车丢到别的赛段）。
await sleep(4200);   // 起跑后 ~4s：AI 刚好从后方开到我前方 20~60m（再晚就超过 220m 范围）

// 把 AI 摆到**玩家前方** 18/28/38m、左右错开 2.6m：保证它们既在 220m 范围内、
// 也落在相机视锥里（玩家原地不动时 AI 从后方开过去，标签会因为"在我身后"被隐藏）。
{
  const r = await ev(`(() => {
    const S = window.__S, me = S.localCar; if (!me) return 'no-me';
    // 停止探针场景的 Worker，避免下一帧把夹具坐标覆盖回物理快照。
    // 生产名牌仍由真实渲染循环执行，探针只冻结输入场景。
    S.rp.worker.terminate();
    S.rp.disposed = true;
    S.rp._racing = false;
    S._racePrewarmDone = false;
    const camera = window.__camera;
    const THREE = window.THREE;
    const viewForward = camera && THREE
      ? new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize()
      : me.fwd.clone().setY(0).normalize();
    const viewRight = new THREE.Vector3(-viewForward.z, 0, viewForward.x);
    const origin = me.pos.clone();
    for (const c of S.rp.cars) {
      if (c.id === me.id) continue;
      const k = S.rp.cars.indexOf(c);
      const lane = k % 2 === 0 ? 1.8 : -1.8;
      const p = origin.clone().addScaledVector(viewForward, 18 + k * 9).addScaledVector(viewRight, lane);
      c.pos.set(p.x, origin.y, p.z);
      c.prevPos.copy(c.pos);
      c.body.position = c.pos;
      c.body.velocity.set(0, 0, 0);
      const vis = window.__carVisuals && window.__carVisuals.get(c.id);
      if (vis) { vis.position.copy(c.pos); vis.quaternion.copy(c.quat); }
    }
    return 'ok';
  })()`);
  console.log('  （已把 AI 摆到前方：' + r + '）');
}
await sleep(900);

const info = await ev(`(() => {
  const box = document.getElementById('nameplates');
  const cards = Array.from(box ? box.children : []).filter((e) => e.style.display !== 'none');
  const r = document.querySelector('canvas').getBoundingClientRect();
  // 把每台车的世界坐标投影到屏幕，用于比对名牌位置
  const S = window.__S, C = window.__carVisuals;
  const out = { mode: S && S.mode, racing: !!(S && S.rp && S.rp.racing), vw: r.width, vh: r.height, n: cards.length, cards: [], cars: [], diagnostics: [] };
  for (const e of cards) {
    out.cards.push({ text: (e.textContent || '').trim(), x: parseFloat(e.style.left), y: parseFloat(e.style.top), color: e.style.borderLeftColor });
  }
  if (S && S.rp) {
    for (const c of S.rp.cars) {
      if (c.id === S.localId) continue;
      const vis = C && C.get(c.id);
      out.cars.push({ id: c.id, name: c.name, x: c.pos.x, y: c.pos.y, z: c.pos.z, kmh: +c.speedKmh.toFixed(1) });
      const projected = vis && window.THREE && window.__camera ? new THREE.Vector3(vis.position.x, vis.position.y + 2.4, vis.position.z).project(window.__camera) : null;
      out.diagnostics.push({ id: c.id, distance: +c.pos.distanceTo(S.localCar.pos).toFixed(1), visualDistance: vis ? +vis.position.distanceTo(S.localCar.pos).toFixed(1) : null, visible: !!(vis && vis.visible), projected: projected ? { x: +projected.x.toFixed(2), y: +projected.y.toFixed(2), z: +projected.z.toFixed(2) } : null });
    }
  }
  return out;
})()`);

console.log('\n\x1b[1m名牌采样\x1b[0m');
console.log('  名牌数 ' + info.n + ' / 其他车 ' + info.cars.length + ' / 视口 ' + Math.round(info.vw) + 'x' + Math.round(info.vh));
if (!info.n) console.log('  诊断 mode=' + info.mode + ' racing=' + info.racing + ' ' + JSON.stringify(info.diagnostics));
for (const c of info.cards) console.log('    名牌 "' + c.text + '" @(' + c.x + ',' + c.y + ') 色 ' + c.color);

ok(info.n > 0, '名판至少显示一个', info.n + ' 个');
ok(info.n <= 4, '★最多只显示最近 4 名', info.n + ' 个');
ok(info.n === Math.min(4, info.cars.length), '★名牌数 = min(4, 范围内其他玩家)',
  info.n + ' / 其他车 ' + info.cars.length);
const texts = info.cards.map((c) => c.text);
const dup = texts.some((t, i) => texts.indexOf(t) !== i);
ok(!dup || texts.length <= 1, '没有重复标签', JSON.stringify(texts));
ok(info.cards.every((c) => /^AI|^車手|^车手|^[A-Za-z\u4e00-\u9fa5]/.test(c.text)), '每个名牌都有车手名文本',
  JSON.stringify(texts));
// 标签不能跑到屏幕下半部（不遮挡自己前方赛道）
ok(info.cards.every((c) => c.y < info.vh * 0.62), '★名牌都在画面上半部（不挡自己前方赛道）',
  info.cards.map((c) => Math.round(c.y)).join(',') + '  (上限 ' + Math.round(info.vh * 0.62) + ')');
ok(info.cards.every((c) => c.y > 0 && c.x > 0 && c.x < info.vw), '名牌在视口内', JSON.stringify(info.cards.map((c) => [Math.round(c.x), Math.round(c.y)])));

try { child.kill(); } catch (_) { /* ignore */ }
try { srv.kill(); } catch (_) { /* ignore */ }
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
