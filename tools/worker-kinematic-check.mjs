/* Worker-only regression: remote KINEMATIC pose must remain network-owned. */
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
window.__events = []; window.__errors = []; window.__contactSeen = []; window.__contactRows = []; window.__stateCount = 0;
const b = new PhysicsWorkerBridge({ seed: 11, trackType: 'suzuka', localId: 1, laps: 1, roster: [
  {id:1,name:'P1',isLocal:true,ai:false,startIndex:0,lateral:0},
  {id:2,name:'R2',remote:true,startIndex:10,lateral:0},
  {id:3,name:'P3',isLocal:false,remote:false,ai:false,startIndex:0,lateral:0},
] });
window.__bridge = b;
 b.addCar({id:1,isLocal:true,startIndex:0,lateral:0});
 b.addCar({id:2,remote:true,startIndex:10,lateral:0});
 b.addCar({id:3,isLocal:false,ai:false,startIndex:0,lateral:0});
b.on('ready', x => window.__events.push({type:'ready',x}));
b.on('state', () => {
  window.__stateCount++;
  for (let k = 0; k < (window.__bridge.lastContactDetails || []).length; k++) { const row = window.__bridge.lastContactDetails[k] || []; window.__contactRows.push({k,otherCars:row.map(detail => detail.otherCar)}); for (const detail of row) window.__contactSeen.push(detail); }
});
b.on('error', e => window.__errors.push(String(e && e.message || e)));
window.__ready = b.prewarm().then(() => { b.start(); b.setRunning(true); });
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
const port = server.address().port, cdpPort = 9463;
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'worker-kinematic-')),
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
  for (let i = 0; i < 100; i++) { if (await ev('!!window.__events?.some(x => x.type === "ready")')) break; await sleep(100); }
  assert.equal((await ev('window.__errors')).length, 0, await ev('JSON.stringify(window.__errors)'));
  await ev(`window.__bridge.handleNetworkPacket({kind:'snap',snapT:performance.now(),renderDelay:60,packet:{p:[{id:2,d:{x:300,y:-100,z:400,q:[0,0,0,1],v:[0,0,0],u:0,b:0,e:0,h:0,gr:0,go:0}}]}})`);
  await sleep(240);
  const remote = await ev('({x:window.__bridge.byId.get(2).pos.x,y:window.__bridge.byId.get(2).pos.y,z:window.__bridge.byId.get(2).pos.z,errors:window.__errors})');
  assert.equal(remote.errors.length, 0, JSON.stringify(remote));
  assert.ok(Math.abs(remote.x - 300) < 0.01 && Math.abs(remote.y + 100) < 0.01 && Math.abs(remote.z - 400) < 0.01, JSON.stringify(remote));
  pass('Remote KINEMATIC pose remains network-owned away from the road');
  await sleep(300);
  const contact = await ev('({seen:window.__contactSeen.filter(d => d.otherCar === 2),rows:window.__contactRows,local:[window.__bridge.byId.get(1).pos.x,window.__bridge.byId.get(1).pos.y,window.__bridge.byId.get(1).pos.z],remote:[window.__bridge.byId.get(2).pos.x,window.__bridge.byId.get(2).pos.y,window.__bridge.byId.get(2).pos.z],velocity:[window.__bridge.byId.get(1).vel.x,window.__bridge.byId.get(1).vel.y,window.__bridge.byId.get(1).vel.z],speed:window.__bridge.byId.get(1).speedKmh,details:window.__contactSeen.slice(-10)})');
  assert.ok(contact.rows.some(row => row.k === 0 && row.otherCars.includes(3)) && contact.rows.some(row => row.k === 2 && row.otherCars.includes(1)), JSON.stringify(contact));
  pass('Contact details identify the other car for both contact participants');
  const cruiseBefore = await ev('window.__stateCount');
  await ev('window.__bridge.finishCar(window.__bridge.byId.get(1))');
  await sleep(400);
  const cruise = await ev('({finished:window.__bridge.byId.get(1).finished,speed:window.__bridge.byId.get(1).speedKmh,throttle:window.__bridge.byId.get(1).throttle,states:window.__stateCount})');
  assert.equal(cruise.finished, true, JSON.stringify(cruise));
  assert.ok(cruise.states > cruiseBefore && cruise.speed > 1 && cruise.throttle > 0, JSON.stringify(cruise));
  pass('Finished cars remain in fixed-step cruise');
  const errorBefore = await ev('window.__errors.length');
  const statesBeforeError = await ev('window.__stateCount');
  await ev(`window.__bridge.worker.postMessage({type:'network',packet:{kind:'snap',packet:{p:[null]}}})`);
  await sleep(160);
  const errorCheck = await ev('({errors:window.__errors.slice(),states:window.__stateCount})');
  assert.ok(errorCheck.errors.length > errorBefore && errorCheck.states > statesBeforeError, JSON.stringify(errorCheck));
  pass('Malformed worker message is reported while the fixed loop continues');
} finally { ws?.close(); browser.kill(); await new Promise(r => server.close(r)); }
