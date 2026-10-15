/* Remote snapshot integration: the finish flag must reach the KINEMATIC proxy. */
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
window.__events = []; window.__errors = [];
const b = new PhysicsWorkerBridge({ seed: 11, trackType: 'suzuka', localId: 1, laps: 1, roster: [
  {id:1,name:'P1',isLocal:true,ai:false,startIndex:0,lateral:0},
  {id:2,name:'R2',remote:true,startIndex:10,lateral:0},
] });
window.__bridge = b;
b.addCar({id:1,isLocal:true,startIndex:0,lateral:0});
b.addCar({id:2,remote:true,startIndex:10,lateral:0});
b.on('ready', x => window.__events.push({type:'ready',x}));
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
const port = server.address().port, cdpPort = 9464;
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'remote-finish-ghost-')),
  `http://127.0.0.1:${port}/worker-test.html`,
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout ' + method)); }, 15000);
  pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed'); return r.result.value; };
try {
  for (let i = 0; i < 75 && !ws; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const p = pages.find(x => x.type === 'page');
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j) => { ws.addEventListener('open', r, {once:true}); ws.addEventListener('error', j, {once:true}); }); }
    } catch (_) { ws = null; }
    if (!ws) await sleep(200);
  }
  assert.ok(ws, 'Edge CDP is available');
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await send('Runtime.enable');
  for (let i = 0; i < 100; i++) { if (await ev('!!window.__events?.some(x => x.type === "ready")')) break; await sleep(100); }
  assert.equal((await ev('window.__errors')).length, 0, await ev('JSON.stringify(window.__errors)'));
  await ev(`window.__bridge.handleNetworkPacket({kind:'snap',snapT:performance.now(),renderDelay:60,packet:{p:[{id:2,f:1,d:{x:300,y:-100,z:400,q:[0,0,0,1],v:[0,0,0],f:1,u:0,b:0,e:0,h:0,gr:0,go:0}}]}})`);
  await sleep(240);
  const remote = await ev('({finished:window.__bridge.byId.get(2).finished,finishGhost:window.__bridge.byId.get(2).finishGhost,errors:window.__errors})');
  assert.equal(remote.errors.length, 0, JSON.stringify(remote));
  assert.equal(remote.finished, true, JSON.stringify(remote));
  assert.equal(remote.finishGhost, true, JSON.stringify(remote));
  console.log('PASS remote snapshot finish flag sets finished and finishGhost');
} finally { ws?.close(); browser.kill(); await new Promise(r => server.close(r)); }
