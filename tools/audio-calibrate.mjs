/* 引擎声校准探针：测 worklet 波导路径的输出 RMS，用于标定 outletG 增益 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8086, CDP = 9366;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1200);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-cal-'))}`,
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const waits = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const pg = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); }
  } catch (_) { }
  if (!ws) await sleep(200);
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  console.log('[ev]', x.slice(0, 48).replace(/\s+/g, ' '), '=>', JSON.stringify(r).slice(0, 240));
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.result?.value;
};
const send = (me, p = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: p })); });

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(4000);

console.log('worklet 支持:', await ev(`(()=>{const a=window.__audio;a.init();a.resume();return !!a.ctx?.audioWorklet})()`));
for (let i = 0; i < 40; i++) { const ready = await ev(`!!window.__audio._workletReady`); if (ready) break; await sleep(300); }
console.log('workletReady:', await ev(`!!window.__audio._workletReady`));

const rms = await ev(`(async () => {
  const a = window.__audio, ctx = a.ctx;
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  a.n.engLP.connect(an);
  const buf = new Float32Array(an.fftSize);
  const stub = { rpm: 6000, speedKmh: 0, speedKmhMeasured: 0, input: { throttle: 1 }, slipAngleDeg: 0, finished: false };
  const t0 = performance.now();
  while (performance.now() - t0 < 2500) { a.update(stub); await new Promise(r => setTimeout(r, 30)); }
  an.getFloatTimeDomainData(buf);
  let sum = 0, peak = 0;
  for (const v of buf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  return JSON.stringify({ rms: Math.sqrt(sum / buf.length), peak,
    gain: (a._workletOutletG && a._workletOutletG.gain) ? a._workletOutletG.gain.value : null,
    ok: a.ok, wr: a._workletReady });
})()`);
console.log('WORKLET(6000rpm WOT):', JSON.stringify(rms), typeof rms);

// fe 档振荡器路径做参照
await ev(`window.__audio.setProfile('fe')`);
await sleep(1200);
const rmsFe = await ev(`(async () => {
  const a = window.__audio, ctx = a.ctx;
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  a.n.engLP.connect(an);
  const buf = new Float32Array(an.fftSize);
  const stub = { rpm: 6000, speedKmh: 0, speedKmhMeasured: 0, input: { throttle: 1 }, slipAngleDeg: 0, finished: false };
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) { a.update(stub); await new Promise(r => setTimeout(r, 30)); }
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return JSON.stringify({ rms: Math.sqrt(sum / buf.length), ok: a.ok });
})()`);
console.log('FE-OSC(6000rpm WOT):', rmsFe);

try { ws.close(); } catch { }
child.kill(); srv.kill();
process.exit(0);
