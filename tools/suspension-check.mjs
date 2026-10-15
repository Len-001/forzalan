/* =============================================================================
 * 悬挂视觉验收（用户报障："车辆没有悬挂，完全是漂浮在路面上的"）
 *
 * 真机（CDP）跑单机、按住 W 加速，采样：
 *   ① 四轮悬挂行程（`wheels[i].pivot.position.y` 相对静止安装高度的变化）
 *      —— 必须随时间变化（加速后蹲 / 刹车点头 / 压路肩颠簸都会让它动）；
 *   ② 车身姿态里叠加的悬挂俯仰/侧倾（车身四元数与物理四元数之差）
 *      —— 加速/刹车时必须出现倾角，否则就是"直板漂浮"。
 * ========================================================================== */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8091, CDP = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1500);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-sus-'))}`,
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
// 采样钩子：记录四轮悬挂行程与车身动态倾角
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__sus = [];
    const _raf = window.requestAnimationFrame.bind(window);
    let prev = 0;
    window.requestAnimationFrame = (cb) => _raf((ts) => {
      if (prev && ts - prev > 1) {
        const S = window.__S;
        const c = S && S.localCar;
        if (c && S.rp && S.rp.racing) {
          const vis = window.__carVisuals && window.__carVisuals.get(c.id);
          if (vis && vis.userData && vis.userData.wheels) {
            const ys = vis.userData.wheels.map((w) => +w.pivot.position.y.toFixed(4));
            // 车身视觉四元数 vs 物理四元数：夹角（度）
            const q1 = vis.quaternion, q2 = c.quat;
            const dot = Math.min(1, Math.abs(q1.x*q2.x + q1.y*q2.y + q1.z*q2.z + q1.w*q2.w));
            const ang = 2 * Math.acos(dot) * 180 / Math.PI;
            window.__sus.push([+c.speedKmh.toFixed(1), ys[0], ys[1], ys[2], ys[3],
              +ang.toFixed(3), +c.suspCompression.toFixed(4), c.onCurb ? 1 : 0]);
          }
        }
      }
      prev = ts;
      cb(ts);
    });
  })()`,
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&track=suzuka&laps=5` });
await sleep(9500);   // 等起跑流程走完
await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, text: 'w' });
await sleep(14000);
const samples = await ev('window.__sus.slice(0, 20000)');
await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  PASS ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  FAIL ' + n + '   ' + d); } };
console.log('\n\x1b[1m悬挂采样（' + samples.length + ' 帧）\x1b[0m');
ok(samples.length > 100, '采到足够帧（车真的在跑）', samples.length + ' 帧');

if (samples.length > 100) {
  const wheelCols = [1, 2, 3, 4];
  const stats = wheelCols.map((ci) => {
    const v = samples.map((s) => s[ci]);
    return { mn: Math.min(...v), mx: Math.max(...v), amp: Math.max(...v) - Math.min(...v) };
  });
  console.log('  各轮行程（局部 y）区间：' + stats.map((s, i) => '轮' + i + ' ' + s.mn.toFixed(4) + '~' + s.mx.toFixed(4)).join('  '));
  ok(Math.max(...stats.map((s) => s.amp)) > 0.004,
    '★四轮悬挂真的有行程（不再是固定焊死的轮轴）',
    '最大振幅 ' + (Math.max(...stats.map((s) => s.amp)) * 1000).toFixed(1) + 'mm');

  const angs = samples.map((s) => s[5]);
  const angMax = Math.max(...angs);
  console.log('  车身动态倾角 max=' + angMax.toFixed(3) + '°');
  ok(angMax > 0.05,
    '★车身有悬挂俯仰/侧倾动态（加速后蹲、刹车点头）',
    '最大动态倾角 ' + angMax.toFixed(3) + '°');

  const comp = samples.map((s) => s[6]);
  const compAmp = Math.max(...comp) - Math.min(...comp);
  console.log('  物理悬挂压缩量区间 ' + Math.min(...comp).toFixed(4) + ' ~ ' + Math.max(...comp).toFixed(4) + ' m');
  ok(compAmp > 0.002, '★物理悬挂本身在压缩/回弹（视觉与物理同源）', '行程 ' + (compAmp * 1000).toFixed(1) + 'mm');
}

try { child.kill(); } catch (_) { /* ignore */ }
try { srv.kill(); } catch (_) { /* ignore */ }
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
