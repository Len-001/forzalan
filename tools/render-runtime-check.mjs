/* Actual rendered car/camera motion and input delivery without the next render frame. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
const root = path.resolve(import.meta.dirname,'..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const s = createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
const port = await freePort(), hostPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const scratch = process.env.TMPDIR || tmpdir();
const server = spawn(path.join(root, 'forzalan.exe'), ['-addr', `127.0.0.1:${port}`], {
  cwd: mkdtempSync(path.join(scratch, 'lan-sync-data-')), windowsHide:true, stdio: ['ignore', 'ignore', 'pipe'],
});
let serverLog = ''; server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
const browsers = [hostPort].map(cdpPort => spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + mkdtempSync(path.join(scratch, 'lan-sync-browser-')), 'about:blank',
], { windowsHide:true, stdio: 'ignore' }));
const pages = [];
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch { /* startup */ }
    await sleep(100);
  }
  throw new Error('Timeout: ' + label + '\n' + serverLog);
}
async function page(cdpPort) {
  const info = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(p=>p.type==='page');
  const ws = new WebSocket(info.webSocketDebuggerUrl), pending = new Map(), errors = [];
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (!pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')); }, 15000);
    pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  };
  const p = { ws, send, ev, errors }; pages.push(p);
  await send('Runtime.enable');
  await send('Page.navigate', { url: base + '/?solo=1&ghost=1&track=suzuka' });
  await until(() => ev('!!window.__S?.net?.connected'), 'game boot');
  return p;
}
try {
  await until(async () => (await fetch(base+'/healthz')).ok,'server');
  await until(async () => (await fetch(`http://127.0.0.1:${hostPort}/json/list`)).ok,'Edge');
  const host=await page(hostPort);
  await until(()=>host.ev('window.__S?.rp?.racing && window.__S.localCar'),'race',40000);
  await host.ev(`(() => {
    const r=window.__renderer,b=__S.rp, original=r.render.bind(r),alpha=b.renderAlpha.bind(b);
    window.__frames=[];window.__states=[];window.__alpha=0;
    b.renderAlpha=function(t){window.__alpha=alpha(t);window.__renderNow=t;return window.__alpha;};
    b.on('state',()=>{const c=__S.localCar;__states.push([performance.now(),b._stateNow,b.physicsStep,c.pos.x,c.pos.y,c.pos.z,c.steerAngle,c.speedKmh]);});
    r.render=function(...args){const before=performance.now(); const result=original(...args),now=performance.now(),c=__S.localCar,v=__carVisuals.get(c.id),cam=__camera;
      if(c&&v&&__frames.length<100000){const screen=v.position.clone().project(cam);__frames.push([now,now-before,__renderNow,__alpha,b.physicsStep,c.speedKmh,c.contact?1:0,c.pos.x,c.pos.y,c.pos.z,v.position.x,v.position.y,v.position.z,cam.position.x,cam.position.y,cam.position.z,screen.x,screen.y,c.steerAngle,c.input.steer,c.surface,c.gear,c.axMeasured]);}return result;};
  })()`);
  await host.send('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
  await sleep(6500);
  await host.send('Input.dispatchKeyEvent',{type:'keyDown',key:'d',code:'KeyD',windowsVirtualKeyCode:68});await sleep(250);
  await host.send('Input.dispatchKeyEvent',{type:'keyUp',key:'d',code:'KeyD',windowsVirtualKeyCode:68});
  await host.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65});await sleep(250);
  await host.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65});
  await host.send('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
  const immediate=await host.ev("(() => {const b=__S.rp,seq=b._inputSeq,frames=__frames.length;window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD'}));const pressed=b._inputSeq;window.dispatchEvent(new KeyboardEvent('keyup',{key:'d',code:'KeyD'}));return {seq,pressed,released:b._inputSeq,frames,afterFrames:__frames.length};})()");
  assert.equal(immediate.pressed,immediate.seq+1,'keydown posts an input before any render frame');
  assert.equal(immediate.released,immediate.seq+2,'keyup posts an input before any render frame');
  assert.equal(immediate.frames,immediate.afterFrames,'test runs without a render callback');
  const data=await host.ev('({frames:__frames,states:__states,offset:__S.rp._workerToMainMonoOffset,diag:null})');
  data.diag=await host.ev('__S.rp.requestDiagnostics(1500)');data.errors=host.errors;
  writeFileSync(path.join(import.meta.dirname,'render-runtime-report.json'),JSON.stringify(data));
  const frames=data.frames, stats=[],smooth=[];
  for(let i=1;i<frames.length;i++){const a=frames[i-1],b=frames[i],dt=(b[0]-a[0])/1000;
    const moved=Math.hypot(b[10]-a[10],b[11]-a[11],b[12]-a[12]);
    stats.push({dt:dt*1000,render:b[1],age:b[0]-data.states.findLast(s=>s[0]<=b[0])?.[1]});
    if(b[5]>30&&b[19]===0&&!a[6]&&!b[6]&&dt>0&&dt<.05)smooth.push({ratio:moved/(b[5]/3.6*dt),alpha:b[3],screenDY:b[17]-a[17],dt:dt*1000});
  }
  const stat=(rows,k)=>{const a=rows.map(r=>r[k]).filter(Number.isFinite).sort((a,b)=>a-b);return {min:a[0],p50:a[a.length>>1],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
  assert.ok(smooth.length>100,'sufficient actual display samples');
  assert.ok(smooth.filter(s=>s.ratio<.1).length/smooth.length<.02,'straight display cannot repeatedly freeze between Worker samples');
  assert.ok(stat(smooth,'ratio').p95<1.5,'straight display cannot jump forward to catch up');
  assert.ok(Math.abs(stat(smooth,'screenDY').p95)<.003,'car stays stable relative to the chase camera');
  assert.equal(data.errors.length,0,'browser exceptions');
  console.log('PASS actual rendered motion, camera stability and input delivery without a render frame');
  console.log(JSON.stringify({frames:frames.length,states:data.states.length,dt:stat(stats,'dt'),render:stat(stats,'render'),age:stat(stats,'age'),movementRatio:stat(smooth,'ratio'),screenDY:stat(smooth,'screenDY'),frozen:smooth.filter(s=>s.ratio<.1).length,clamped:smooth.filter(s=>s.alpha===1).length,samples:smooth.length,diag:data.diag,errors:data.errors},null,2));
} finally {for(const p of pages)p.ws.close();for(const browser of browsers)browser.kill();server.kill();}
