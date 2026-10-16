/* Two real game pages: human/AI replication, host handoff and final-lap settlement. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const s = createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
const port = await freePort(), hostPort = await freePort(), guestPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const scratch = process.env.TMPDIR || tmpdir();
const server = spawn(path.join(root, 'forzalan.exe'), ['-addr', `127.0.0.1:${port}`], {
  cwd: mkdtempSync(path.join(scratch, 'lan-sync-data-')), stdio: ['ignore', 'ignore', 'pipe'],
});
let serverLog = ''; server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
const browsers = [hostPort, guestPort].map(cdpPort => spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + mkdtempSync(path.join(scratch, 'lan-sync-browser-')), 'about:blank',
], { stdio: 'ignore' }));
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
  await send('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate', { url: base + '/?dbg=1' });
  await until(() => ev('!!window.__S?.net?.connected'), 'game boot');
  return p;
}
const carState = id => `(() => {const c=window.__S.rp.byId.get(${id});return {id:c.id,remote:c.remote,auto:c.auto,x:c.pos.x,y:c.pos.y,z:c.pos.z,lap:c.lap,cp:c.cpIdx,pen:c.penalty,dirty:c.lapInvalid};})()`;
try {
  await until(async () => (await fetch(base + '/healthz')).ok, 'server');
  for (const cdpPort of [hostPort, guestPort]) await until(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).ok, 'Edge');
  const host = await page(hostPort), guest = await page(guestPort);
  await host.ev(`document.getElementById('name').value='LANHost';document.getElementById('laps').value='1';document.getElementById('ghost').checked=true;document.getElementById('btnCreate').click()`);
  const code = await until(() => host.ev('window.__S.lobbyRoom?.room'), 'create');
  await guest.ev(`document.getElementById('name').value='LANGuest';document.getElementById('code').value='${code}';document.getElementById('btnJoin').click()`);
  await until(() => guest.ev('window.__S.lobbyRoom?.players?.length===2'), 'join');
  if (process.env.P2P === '1') {
    await host.ev('window.__S.net.peers.enable(true)');
    await guest.ev('window.__S.net.peers.enable(true)');
    await until(async () => await host.ev('[...window.__S.net.peers.peers.values()].some(p=>p.channel?.readyState==="open")'), 'WebRTC channel', 30000);
    console.log('PASS two real browsers establish an unordered WebRTC DataChannel');
    await guest.ev('window.__S.net.peers.enable(false)');
    await until(() => host.ev('window.__S.net.peers.peers.size===0'), 'peer disabled');
    await guest.ev('window.__S.net.peers.enable(true)');
    await until(() => host.ev('[...window.__S.net.peers.peers.values()].some(p=>p.channel?.readyState==="open")'), 'peer re-enabled', 30000);
    console.log('PASS P2P can be disabled and re-enabled without rejoining');
  }
  await host.ev(`document.getElementById('btnAddAI').click()`);
  const botId = await until(() => host.ev('window.__S.lobby.find(p=>p.ai)?.id'), 'AI seat');
  const hostId = await host.ev('window.__S.localId'), guestId = await guest.ev('window.__S.localId');
  await host.ev(`document.getElementById('btnReady').click()`);
  await guest.ev(`document.getElementById('btnReady').click()`);
  await until(async () => (await host.ev('window.__S.rp?.racing')) && (await guest.ev('window.__S.rp?.racing')), 'both race starts', 30000);
  assert.equal((await host.ev(carState(guestId))).remote, true);
  assert.equal((await guest.ev(carState(hostId))).remote, true);
  assert.equal((await host.ev(carState(botId))).remote, false);
  assert.equal((await guest.ev(carState(botId))).remote, true);
  console.log('PASS real main.js initializes human opponents and host-owned AI correctly');
  const before = await guest.ev(carState(guestId));
  await guest.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  await sleep(2400);
  await guest.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  const local = await guest.ev(carState(guestId)), remote = await host.ev(carState(guestId));
  assert.ok(Math.hypot(local.x-before.x, local.z-before.z) > 2, JSON.stringify({ before, local }));
  assert.ok(Math.hypot(local.x-remote.x, local.z-remote.z) < 8, JSON.stringify({ local, remote }));
  const aiLocal = await host.ev(carState(botId)), aiRemote = await guest.ev(carState(botId));
  assert.ok(Math.hypot(aiLocal.x-aiRemote.x, aiLocal.z-aiRemote.z) < 12, JSON.stringify({ aiLocal, aiRemote }));
  console.log('PASS actual human driving and AI movement replicate between two game pages');
  if (process.env.P2P === '1') {
    await guest.ev('window.__originalSend=window.__S.net.send;window.__S.net.send=function(p){return p.t==="state"?true:window.__originalSend.call(this,p)}');
    await guest.send('Input.dispatchKeyEvent', {type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
    await sleep(1500);
    const directLocal=await guest.ev(carState(guestId)),directRemote=await host.ev(carState(guestId));
    assert.ok(Math.hypot(directLocal.x-directRemote.x,directLocal.z-directRemote.z)<8,JSON.stringify({directLocal,directRemote}));
    assert.ok(Math.hypot(directRemote.x-remote.x,directRemote.z-remote.z)>2,'P2P-only car must keep moving');
    await guest.ev('window.__S.net.send=window.__originalSend');
    await guest.send('Input.dispatchKeyEvent', {type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
    console.log('PASS human pose keeps moving over P2P with WebSocket state uplink disabled');
  }
  if (process.env.SCREENSHOT) {
    await guest.ev('document.getElementById("dbg").style.display="none"');
    const shot=await guest.send('Page.captureScreenshot',{format:'png'});
    writeFileSync(process.env.SCREENSHOT,Buffer.from(shot.data,'base64'));
  }
  await guest.ev('window.__savedSendState=window.__S.net.sendWorkerState;window.__S.net.sendWorkerState=()=>true');
  await guest.send('Input.dispatchKeyEvent', { type:'keyDown', key:'w', code:'KeyW', windowsVirtualKeyCode:87 });
  await sleep(700);
  const frozen = await host.ev(carState(guestId));
  await sleep(700);
  const still = await host.ev(carState(guestId));
  assert.ok(Math.hypot(still.x-frozen.x,still.y-frozen.y,still.z-frozen.z)<0.15, JSON.stringify({frozen,still}));
  assert.equal(await host.ev(`window.__S.rp.byId.get(${guestId}).vel.length()`),0,'stale proxy loses collision velocity');
  await guest.ev('window.__S.net.sendWorkerState=window.__savedSendState');
  await guest.send('Input.dispatchKeyEvent', { type:'keyUp', key:'w', code:'KeyW', windowsVirtualKeyCode:87 });
  await sleep(1500);
  const recoveredLocal = await guest.ev(carState(guestId)), recoveredRemote = await host.ev(carState(guestId));
  assert.ok(Math.hypot(recoveredLocal.x-recoveredRemote.x,recoveredLocal.z-recoveredRemote.z)<8,JSON.stringify({recoveredLocal,recoveredRemote}));
  console.log('PASS stale rebroadcast freezes within prediction budget and resumes after a 1.4s sender outage');
  await host.ev('window.__S.net.close()');
  await until(() => guest.ev(`window.__S.hostId===${guestId} && !window.__S.rp.byId.get(${botId}).remote`), 'AI ownership transfer');
  const handoff = await guest.ev(carState(botId));
  await sleep(1600);
  const resumed = await guest.ev(carState(botId));
  assert.ok(Math.hypot(resumed.x-handoff.x,resumed.z-handoff.z) > 2, JSON.stringify({ handoff, resumed }));
  const peer = new WebSocket(`ws://127.0.0.1:${port}/ws`), received = [];
  await new Promise((resolve, reject) => { peer.addEventListener('open', resolve, { once: true }); peer.addEventListener('error', reject, { once: true }); });
  peer.addEventListener('message', e => received.push(JSON.parse(e.data)));
  await until(() => received.find(m=>m.t==='presence')?.players.some(p=>p.id===guestId && p.room===code), 'presence after transfer');
  await sleep(200);
  peer.close();
  assert.ok(!serverLog.includes('panic'), serverLog);
  console.log('PASS former guest takes over physical AI and continues without server deadlock');
  await guest.ev(`(() => {const b=window.__S.rp,c=window.__S.localCar;b.onLap(c,window.__S.laps,90,true);b.finishCar(c)})()`);
  await until(() => guest.ev('window.__S.localCar.finished'), 'human finish');
  await guest.ev(`(() => {const b=window.__S.rp,c=b.byId.get(${botId});b.onLap(c,window.__S.laps,91,false);b.finishCar(c)})()`);
  await until(() => guest.ev('!!window.__S.settlement?.length'), 'settlement');
  const results = await guest.ev('window.__S.settlement');
  assert.equal(results.length, 2); assert.ok(results.every(r=>r.fin && r.totalTime>=0), JSON.stringify(results));
  assert.equal(host.errors.length + guest.errors.length, 0, JSON.stringify(pages.map(p=>p.errors)));
  console.log('PASS dirty final lap and AI final lap settle correctly after host handoff');
  console.log('lan-sync-check: PASS');
} catch (error) {
  for (const p of pages) {
    try { console.error(await p.ev(`JSON.stringify({mode:window.__S?.mode,net:window.__S?.net?.connected,ready:window.__S?.rp?.ready,racing:window.__S?.rp?.racing,prewarm:window.__S?._racePrewarmDone,go:window.__S?.goReason,start:window.__S?.raceStartSeen,locked:window.__S?.controlsLocked,body:document.body.innerText.slice(-1500)})`)); } catch { /* closed page */ }
    console.error('Page exceptions:', JSON.stringify(p.errors));
  }
  throw error;
} finally {
  for (const p of pages) p.ws.close();
  for (const browser of browsers) browser.kill();
  server.kill();
}
