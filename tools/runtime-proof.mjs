/* 交付 exe 的 Worker 热路径验收：真实固定步长、32m 静态网格、稀疏矩阵。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 8097, CDP = 9345;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pending = new Map(), exceptions = [];
let server, browser, ws, id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timeout')); }, 10000);
  pending.set(n, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
try {
  server = spawn(resolve(import.meta.dirname, '../forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { stdio: 'ignore' });
  await sleep(1000);
  assert.equal(server.exitCode, null, 'probe server is running');
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  assert.ok(edge, 'Edge is installed');
  browser = spawn(edge, ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'worker-rt-')),
    '--no-first-run', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
      const page = list.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
      }
    } catch (_) { ws = null; }
    if (!ws) await sleep(200);
  }
  assert.ok(ws, 'Edge CDP is available');
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?solo=1&seed=99&track=vegas' });
  let running = false;
  for (let i = 0; i < 150; i++) {
    running = await evaluate('!!(window.__S?.rp?.ready && window.__S.rp.racing && window.__S.rp.physicsStep >= 0)');
    if (running) break;
    await sleep(100);
  }
  assert.ok(running, 'Worker initialized and lights unlocked the race');
  const data = await evaluate('window.__S.rp.requestDiagnostics(2000)');
  console.log(JSON.stringify(data, null, 2));
  assert.equal(data.broadphase.algorithm, 'static-bucket-xz', 'active broadphase is the Worker static-bucket algorithm');
  assert.equal(data.broadphase.cellXZ, 32);
  assert.equal(data.matrixIsMapBacked, true, 'collision matrix uses sparse Map storage');
  assert.equal(data.fixedDt, 1 / 60);
  assert.ok(data.fixedSteps >= 90, 'independent Worker advanced at least 90 steps in 2s: ' + data.fixedSteps);
  assert.equal(data.fixedStepMs.count, data.fixedSteps, 'each real fixed step was measured once');
  assert.equal(data.collisionMatrixTickMs.count, data.fixedSteps, 'each real matrix tick was measured once');
  assert.ok(data.fixedStepMs.mean >= 0 && data.fixedStepMs.mean < 1000 / 60, 'average fixed step fits the 60Hz budget');
  assert.equal(await evaluate('!!window.__S.rp.world'), false, 'physics world is absent from the rendering thread');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS Worker fixed steps / active 32m grid / sparse matrix / real timings / no main-thread world / browser exceptions=0');
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  ws?.close(); browser?.kill(); server?.kill();
}

