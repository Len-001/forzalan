/* 音效选择器验收：① 下拉存在且有 4 个档位；② 切到电动方程式后音频图层真的重建
 * （振荡器波形/进气噪声系数/lp 系数随档案变化）；③ 选择写进 localStorage。 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8083, CDP = 9363;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1500);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=' + CDP,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-au-'))}`, '--no-first-run',
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
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); clearTimeout(w.timer); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
});
const send = (me, p = {}) => new Promise((res, rej) => {
  const i = ++id;
  const timer = setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error('t/o ' + me)); } }, 10000);
  waits.set(i, { res, rej, timer });
  ws.send(JSON.stringify({ id: i, method: me, params: p }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(3000);
let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  PASS ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  FAIL ' + n + '   ' + d); } };

const sel = await ev(`(() => {
  const s = document.getElementById('engineSound');
  if (!s) return null;
  return { n: s.options.length, vals: Array.from(s.options).map((o) => o.value), cur: s.value };
})()`);
ok(!!sel, '音效选择器存在于页面', sel ? '' : '未找到 #engineSound');
if (sel) {
  ok(sel.n === 4, '★有 4 个音效档位（直六 GT / V8 / V12 / 电动方程式）', JSON.stringify(sel.vals));
  ok(sel.vals.includes('i6gt') && sel.vals.includes('fe'), '档位含直六 GT 与电动方程式', JSON.stringify(sel.vals));
}

// 初始化音频（用户手势无关：已加 autoplay 策略）
await ev(`(() => { try { const a = window.__audio; if (a) { a.init(); a.resume(); } } catch (e) {} return true; })()`);
const def = await ev(`(() => { const a = window.__audio; return a ? { prof: a.profile, fire: a._prof && a._prof.fire, type: a._prof && a._prof.type, air: a._prof && a._prof.air } : null; })()`);
ok(!!def, '音频对象可访问（window.__audio）', JSON.stringify(def));
if (def) ok(def.prof === 'i6gt' && def.type === 'piston', '★默认档位 = 直六 GT（用户指定）',
  JSON.stringify(def));

// 切到电动方程式
const switched = await ev(`(() => {
  const s = document.getElementById('engineSound');
  s.value = 'fe';
  s.dispatchEvent(new Event('change'));
  const a = window.__audio;
  return { prof: a.profile, fire: a._prof.fire, type: a._prof.type, air: a._prof.air,
    ls: localStorage.getItem('forza_lan_engine'),
    oscTypes: a.ok ? a.n.oscs.map((h) => h.o.type) : null,
    harm: a.n.oscs.map((h) => h.mul) };
})()`);
ok(switched.prof === 'fe' && switched.type === 'electric', '★切到电动方程式后档案真的变了',
  JSON.stringify({ prof: switched.prof, type: switched.type, fire: switched.fire }));
ok(Array.isArray(switched.oscTypes) && switched.oscTypes[0] === 'sine',
  '★电驱用正弦/三角波（不再是锯齿/方波）', JSON.stringify(switched.oscTypes));
ok(switched.air < 0.1, '★电驱几乎关掉进气/排气噪声（没有排气声）', 'air=' + switched.air);
ok(switched.ls === 'fe', '选择写入 localStorage（下次进游戏沿用）', String(switched.ls));
ok(switched.harm && switched.harm[0] === 1 && switched.harm.length === 3, '电驱谐波组 = 基频+2+4 次',
  JSON.stringify(switched.harm));

try { ws.close(); } catch (_) { /* ignore */ }
try { child.kill(); } catch (_) { /* ignore */ }
try { srv.kill(); } catch (_) { /* ignore */ }
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
