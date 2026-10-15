/* 在真实浏览器中延迟 GPU 预热，验证计时到点也不能越过准备门槛。 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const port = 8098, cdpPort = 9468;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(join(root, 'forzalan.exe'), ['-addr', ':' + port, '-quiet'], { cwd: root, stdio: 'ignore' });
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + cdpPort,
  '--user-data-dir=' + mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'prewarm-check-')),
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });
let ws, id = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout: ' + method)); }, 15000);
  pending.set(n, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (expression, tries = 200) => {
  for (let i = 0; i < tries; i++) { if (await ev(expression)) return; await sleep(100); }
  throw new Error('Timed out: ' + expression);
};
try {
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = pages.find(p => p.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
      }
    } catch (_) { ws = null; }
    if (!ws) await sleep(100);
  }
  assert.ok(ws);
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    let renderer;
    Object.defineProperty(window, '__renderer', {
      configurable: true,
      get: () => renderer,
      set: value => {
        renderer = value;
        value.compileAsync = async (scene, camera) => {
          window.__prewarmStarted = performance.now();
          await new Promise(resolve => setTimeout(resolve, 5000));
          value.compile(scene, camera);
          window.__gpuPrepared = performance.now();
        };
      }
    });
  ` });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?solo=1&dbg=1&track=suzuka&laps=1` });
  await until('!!window.__prewarmStarted');
  await sleep(4050);
  const pendingState = await ev(`({ready:__S.rp.ready,warm:__S._racePrewarmDone,racing:__S.rp.racing,locked:__S.controlsLocked,clock:__S.raceClock})`);
  assert.ok(pendingState.ready && !pendingState.warm && !pendingState.racing && pendingState.locked && pendingState.clock >= 0, JSON.stringify(pendingState));
  console.log('PASS 物理 Worker 已就绪且发车时钟到点，GPU 预热未完成时仍锁定输入');
  await until('!!window.__gpuPrepared && window.__S?._racePrewarmDone');
  const red = await ev(`({racing:__S.rp.racing,locked:__S.controlsLocked,red:document.querySelectorAll('#startLights .sl.red.on').length,clock:__S.raceClock})`);
  assert.ok(!red.racing && red.locked && red.red === 5 && red.clock < -3, JSON.stringify(red));
  console.log('PASS 预热完成后从五盏红灯重新开始完整倒计时');
  await until('!!window.__S?.rp?.racing');
  const go = await ev(`({elapsed:performance.now()-window.__gpuPrepared,locked:__S.controlsLocked,errors:[]})`);
  assert.ok(go.elapsed >= 3700 && !go.locked, JSON.stringify(go));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS 完整红灯结束后解锁，真实浏览器未捕获异常为零');
  console.log(JSON.stringify({pendingState,red,go,errors}));
} finally { ws?.close(); browser.kill(); server.kill(); }
