/* 最小探针：无头 Edge 打开首页，收集 console/异常 + 页面状态，判断 boot 是否失败 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8095, CDP = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1200);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-probe-'))}`,
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const pg = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); }
  } catch (_) { }
  if (!ws) await sleep(200);
}
const logs = [];
let id = 0; const waits = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[console.${m.params.type}] ${txt.slice(0, 300)}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${d.text} ${d.exception?.description?.slice(0, 400) || ''}`);
  }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(15000); // 等 boot + worker init

const state = await evalJS(`(() => {
  const s = window.__S || window.S || {};
  return JSON.stringify({
    hasState: !!window.__S, mode: s.mode || null,
    hasRp: !!s.rp, rpReady: !!(s.rp && s.rp.ready),
    localCar: !!s.localCar,
    hudHidden: document.getElementById('hud')?.classList.contains('hidden'),
    lobbyHidden: document.getElementById('lobby')?.classList.contains('hidden'),
    fatalText: document.querySelector('.fatal, #fatal, [class*=fatal]')?.textContent?.slice(0, 200) || null,
    bootText: (document.getElementById('boot')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 150),
  });
})()`);
console.log('STATE:', state);
// 与验收脚本同流程：点开单机，看 __S 是否出现、worker 是否 ready
await evalJS(`(() => { const l = document.getElementById('laps'); if (l) l.value = '1';
  const t = document.getElementById('track'); if (t) t.value = 'suzuka';
  document.getElementById('btnSolo').click(); return true; })()`);
await sleep(6000);
const state2 = await evalJS(`(() => {
  const s = window.__S || {};
  return JSON.stringify({
    hasState: !!window.__S, mode: s.mode, hasRp: !!s.rp, rpReady: !!(s.rp && s.rp.ready),
    localCar: !!s.localCar, racing: !!(s.rp && s.rp.racing),
    cars: s.rp ? s.rp.cars.length : 0,
  });
})()`);
console.log('AFTER-SOLO:', state2);
console.log('---- 页面日志（最近 30 条）----');
for (const l of logs.slice(-30)) console.log(l);
try { ws.close(); } catch { }
child.kill(); srv.kill();
process.exit(0);
