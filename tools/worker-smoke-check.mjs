/* 真实 Edge Worker 门禁：验证 Worker 可加载、初始化、独立固定步长和可转移状态包。 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const publicRoot = join(root, 'public');
const html = `<!doctype html><meta charset="utf-8"><script src="/libs/three.min.js"></script><script type="module">
import { PhysicsWorkerBridge } from '/js/PhysicsWorkerBridge.js';
window.__events = []; window.__states = 0; window.__errors = []; window.__diagnostics = null;
try {
  const b = new PhysicsWorkerBridge({ seed: 11, trackType: 'suzuka', localId: 1, laps: 1, roster: [{id:1,name:'P1',color:'#fff',isLocal:true,ai:false,startIndex:0,lateral:0}] });
  window.__bridge = b;
  b.addCar({id:1,isLocal:true,startIndex:0,lateral:0,laps:1});
  b.addCar({id:2,remote:true,startIndex:10,lateral:0,laps:1});
  b.on('ready', x => window.__events.push({type:'ready',x}));
  b.on('state', x => window.__states++);
  b.on('error', e => window.__errors.push(String(e && e.message || e)));
  b.prewarm().then(() => { b.start(); b.setRunning(true); b.sendInput({id:1,input:{throttle:1,brake:0,steer:0,handbrake:0}}, performance.now()); b.requestDiagnostics(180).then(x => window.__diagnostics = x, e => window.__errors.push(String(e && e.message || e))); });
} catch (e) { window.__errors.push(String(e && e.stack || e)); }
</script>`;
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://worker.test').pathname;
    if (url === '/worker-test.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    const file = resolve(publicRoot, '.' + url);
    if (!file.startsWith(publicRoot)) { res.writeHead(403); res.end(); return; }
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch (_) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, cdpPort = 9462;
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'worker-check-')),
  `http://127.0.0.1:${port}/worker-test.html`,
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout ' + method)); }, 15000);
  pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed'); return r.result.value; };
const pass = text => console.log('PASS ' + text);
try {
  for (let i = 0; i < 75 && !ws; i++) {
    try { const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); const p = pages.find(x => x.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j) => { ws.addEventListener('open', r, {once:true}); ws.addEventListener('error', j, {once:true}); }); } } catch (_) { ws = null; }
    if (!ws) await sleep(200);
  }
  assert.ok(ws, 'Edge CDP is available');
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 100; i++) { ready = await ev('!!window.__events?.some(x => x.type === "ready")'); if (ready) break; await sleep(100); }
  assert.ok(ready, await ev('JSON.stringify(window.__errors)'));
  pass('Worker module loads and initializes RacePhysics');
  await sleep(800);
  const sample = await ev('({states:window.__states,errors:window.__errors,ready:window.__events[0]?.x,car:{speed:window.__bridge?.cars[0]?.speedKmh,locked:window.__bridge?.cars[0]?.raceLocked}})');
  assert.equal(sample.errors.length, 0, JSON.stringify(sample.errors));
  assert.ok(sample.states >= 40, `state packets=${sample.states}`);
  assert.equal(sample.car.locked,false,'RACE_START unlocks Worker-owned input');
  assert.ok(sample.car.speed>1,`throttle moves car: ${sample.car.speed}km/h`);
  pass('Worker starts its race clock, unlocks controls and accelerates');
  pass(`Worker emitted ${sample.states} transferable state packets`);
  assert.ok(sample.ready && sample.ready.colliders >= 0, 'ready payload includes collider count');
  pass('Worker ready payload reports collider metadata');
  const diagnostics = await ev('window.__diagnostics');
  assert.ok(diagnostics && diagnostics.fixedSteps >= 1 && diagnostics.fixedDt > 0, JSON.stringify(diagnostics));
  pass('Worker diagnostics roundtrip returns fixed-step telemetry');
  await ev(`window.__bridge.handleNetworkPacket({kind:'snap',snapT:performance.now(),renderDelay:80,packet:{p:[{id:2,d:{x:300,y:window.__bridge.cars[0].pos.y,z:400,q:[0,0,0,1],v:[10,0,0],u:0.7,b:0.2,e:0.3,h:0,gr:2,go:1}}]}})`);
  await sleep(220);
  const remote = await ev('({x:window.__bridge.byId.get(2).pos.x,z:window.__bridge.byId.get(2).pos.z,throttle:window.__bridge.byId.get(2).throttle,reason:window.__bridge.byId.get(2).ghostReasonCode})');
  assert.ok(remote.x>=300 && remote.x<306 && Math.abs(remote.z-400)<2,JSON.stringify(remote));
  assert.ok(Math.abs(remote.throttle-0.7)<0.01,JSON.stringify(remote));
  assert.equal(remote.reason,2,'remote ghost cause crosses typed transport');
  pass('Remote typed snapshots drive the kinematic proxy and input/ghost telemetry');
  await ev(`window.__stallBefore={time:window.__bridge.time,states:window.__states}; const end=performance.now()+300; while(performance.now()<end) {}`);
  await sleep(40);
  const independent = await ev('({delta:window.__bridge.time-window.__stallBefore.time,states:window.__states-window.__stallBefore.states,errors:window.__errors})');
  assert.ok(independent.delta>0.25 && independent.states>=12,JSON.stringify(independent));
  assert.equal(independent.errors.length,0,JSON.stringify(independent));
  pass('Physics continues at fixed steps during a 300ms main-thread stall');
} finally { ws?.close(); browser.kill(); await new Promise(r => server.close(r)); }
