/* 视觉抖动定位：逐帧记录"车体网格"的世界位置（不是物理位置），
 * 并统计"前进方向上的方向反转次数"（前后抖动的定义）。
 * 同时记录 alpha、本帧推了几个子步，用于区分"插值不对"还是"物理本身在抖"。 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8084, CDP = 9362;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1500);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11', `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-jd-'))}`, '--no-first-run',
    '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const waits = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const pg = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); }
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
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__jd = [];
    const _raf = window.requestAnimationFrame.bind(window);
    let prev = 0;
    window.requestAnimationFrame = (cb) => _raf((ts) => {
      const S = window.__S;
      if (prev && ts - prev > 1 && S && S.rp && S.rp.racing && window.__carVisuals) {
        const row = { t: +ts.toFixed(2), dt: +(ts - prev).toFixed(3), a: +(S.rp.alpha || 0).toFixed(3), sn: S.rp.stepCount || 0, cars: {} };
        for (const [cid, vis] of window.__carVisuals) {
          row.cars[cid] = [+vis.position.x.toFixed(4), +vis.position.y.toFixed(4), +vis.position.z.toFixed(4)];
        }
        // 名牌（第一个可见标签）的屏幕位置：用户报"标签也抖"，这里直接量它
        const box = document.getElementById('nameplates');
        if (box && box.firstElementChild && box.firstElementChild.style.display !== 'none') {
          const el = box.firstElementChild;
          row.np = [parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0];
        }
        const f = window.__jd; if (f.length < 40000) f.push(row);
      }
      prev = ts; cb(ts);
    });
  })()`,
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&track=suzuka&laps=5` });
await sleep(9500);
await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, text: 'w' });
await sleep(9000);
const data = await ev('window.__jd.slice(0, 40000)');
await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

console.log('\n帧数 ' + data.length);
for (const cid of ['1', '2', '3']) {
  let n = 0, rev = 0, zero = 0, mx = 0; const steps = [];
  let prevDx = 0, prevDz = 0;
  let prevD = null, prevStep = 0;
  for (let i = 1; i < data.length; i++) {
    const A = data[i - 1].cars[cid], B = data[i].cars[cid];
    if (!A || !B) continue;
    const dx = B[0] - A[0], dz = B[2] - A[2];
    const d = Math.hypot(dx, dz);
    const ds = Math.max(0, (data[i].sn || 0) - (data[i - 1].sn || 0));
    if (ds > 0 && steps.length < 40) steps.push(ds);
    n++;
    if (d < 1e-4) zero++; else mx = Math.max(mx, d);
    if (prevD !== null && d > 1e-4 && prevD > 1e-4 && (dx * prevDx + dz * prevDz) < 0) rev++;
    if (d > 1e-4) { prevDx = dx; prevDz = dz; prevD = d; }
    prevStep = ds;
    void prevStep;
  }
  console.log('  车 ' + cid + '：帧 ' + n + '  零位移帧 ' + zero + '（' + (100 * zero / n).toFixed(1) + '%）  最大单帧位移 ' + mx.toFixed(3)
    + 'm  方向反转帧 ' + rev + '  (' + (100 * rev / n).toFixed(1) + '%)  子步/帧样本 ' + JSON.stringify(steps.slice(0, 12)));
}
let a = 0, ai = 0, sn = 0;
for (let i = 1; i < data.length; i++) { if (data[i].a === 0) a++; if (data[i].a > 0.9) ai++; sn += Math.max(0, (data[i].sn || 0) - (data[i - 1].sn || 0)); }
{
  let n = 0, rev = 0, zero = 0, mx = 0, prevDx = 0, prevDz = 0, prevD = null;
  for (let i = 1; i < data.length; i++) {
    const A = data[i-1].np, B = data[i].np;
    if (!A || !B) continue;
    const dx = B[0] - A[0], dz = B[1] - A[1];
    const d = Math.hypot(dx, dz);
    n++;
    if (d < 0.05) zero++; else mx = Math.max(mx, d);
    if (prevD !== null && d > 0.05 && prevD > 0.05 && (dx * prevDx + dz * prevDz) < 0) rev++;
    if (d > 0.05) { prevDx = dx; prevDz = dz; prevD = d; }
  }
  console.log('  名牌：帧 ' + n + '  零位移帧 ' + zero + '（' + (n ? (100*zero/n).toFixed(1) : 0) + '%）  最大位移 ' + mx.toFixed(2) + 'px  方向反转 ' + rev + ' 帧');
}
console.log('  alpha==0 帧 ' + a + '  alpha>0.9 帧 ' + ai + '  平均每帧子步 ' + (sn / data.length).toFixed(3));
let dtMin = 1e9, dtMax = 0, dtSum = 0;
for (const r of data) { dtSum += r.dt; dtMin = Math.min(dtMin, r.dt); dtMax = Math.max(dtMax, r.dt); }
console.log('  帧间隔 min/avg/max = ' + dtMin.toFixed(2) + ' / ' + (dtSum / data.length).toFixed(2) + ' / ' + dtMax.toFixed(2) + ' ms');
try { child.kill(); } catch (_) { /* ignore */ }
try { srv.kill(); } catch (_) { /* ignore */ }
