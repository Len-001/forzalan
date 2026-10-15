/* 房间真实浏览器验收：AI名册、踢人送达、在线详情、起跑快照与成绩归属。
 * 成绩阶段主动触发完赛回调，完整驾驶行为另由 ai-long-race-check 验证。 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8084, CDP = 9364;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = process.env.TMPDIR || tmpdir();
const sandbox = mkdtempSync(path.join(scratch, 'room-ui-'));
const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: sandbox, stdio: 'ignore' });
await sleep(1500);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=' + CDP,
    `--user-data-dir=${mkdtempSync(path.join(scratch, 'tc-room-'))}`, '--no-first-run',
    '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
let ws, peer, id = 0; const waits = new Map(); const exceptions = [];
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
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); clearTimeout(w.timer); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
});
const send = (me, p = {}) => new Promise((res, rej) => {
  const i = ++id;
  const timer = setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error('t/o ' + me)); } }, 15000);
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
for (let i=0; i<200; i++) { if (await ev('!!window.__S?.net?.connected')) break; await sleep(100); }

const assert = (value, text) => { if (!value) throw new Error('FAIL ' + text); console.log('PASS ' + text); };
try {
  const initial = await ev(`({ open: document.getElementById('presenceDetails').open, ready: !!window.__S.net.connected })`);
  assert(initial.open && initial.ready, '首页大厅在线详情展开，连接成功');
  await ev(`(() => { const n = document.getElementById('name'); n.value = '房间验收'; document.getElementById('laps').value='1'; document.getElementById('btnCreate').click(); })()`);
  await sleep(700);
  const created = await ev(`({ code: window.__S.lobbyRoom.room, laps: window.__S.lobbyRoom.laps, host: window.__S.localId, add: !document.getElementById('btnAddAI').classList.contains('hidden') })`);
  assert(created.add, '房主显示添加人机按钮');
  await ev(`(() => { window.__rankNode = document.getElementById('seasonBody').firstChild; document.getElementById('btnAddAI').click(); })()`);
  await sleep(700);
  const bot = await ev(`(() => { const room = window.__S.lobbyRoom; return { bots: room.bots.length, roster: room.roster.length, text: document.getElementById('playerList').textContent, same: window.__rankNode === document.getElementById('seasonBody').firstChild }; })()`);
  assert(bot.bots === 1 && bot.roster === 2 && bot.text.includes('移除人机'), '服务器人机名册真实回包，房间展示移除人机');
  assert(bot.same, '房间报文刷新保持排行榜原DOM，未重播入场动画');
  const stable = await ev(`(() => { const s=window.__S, board=[{name:'榜单夹具',pts:10}]; s.net.emit('seasonUpdate',{rankings:board}); const row=document.getElementById('seasonBody').firstChild; s.net.emit('seasonUpdate',{rankings:board}); const same=!!row && row===document.getElementById('seasonBody').firstChild; s.net.emit('seasonUpdate',{rankings:[{name:'榜单夹具',pts:11}]}); return {same,changed:row!==document.getElementById('seasonBody').firstChild}; })()`);
  assert(stable.same && stable.changed, '非空榜单相同推送保留节点，积分变化才更新');
  await ev(`document.querySelector('.player-kick').click()`); await sleep(600);
  assert(await ev(`window.__S.lobbyRoom.bots.length === 0`), '移除人机后服务端名册已清除');
  peer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const peerMsgs = [];
  await new Promise((res, rej) => { peer.addEventListener('open',res); peer.addEventListener('error',rej); });
  peer.addEventListener('message', e => peerMsgs.push(JSON.parse(e.data)));
  peer.send(JSON.stringify({t:'join',room:created.code,name:'被踢验收',color:'#00aaff',engine:'v12'})); await sleep(600);
  const playerId = await ev(`window.__S.lobbyRoom.players.find(p => p.name === '被踢验收').id`);
  await ev(`window.__S.net.send({t:'kick',id:${playerId}})`); await sleep(600);
  assert(peerMsgs.some(m => m.t === 'kicked'), '被踢玩家收到真实kicked报文');
  assert(await ev(`window.__S.lobbyRoom.players.length === 1`), '踢人后房间服务端回包只有房主');

  await ev(`document.getElementById('presenceDetails').open = true`); await sleep(500);
  assert(await ev(`document.getElementById('presenceBody').textContent.includes('房间验收')`), '展开人数面板按需加载真实在线玩家');
  assert(await ev(`document.getElementById('finishBar').classList.contains('hidden') && document.getElementById('spectate').classList.contains('hidden')`), '顶部观战栏默认隐藏');
  peer.close();
  peer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { peer.addEventListener('open',res); peer.addEventListener('error',rej); });
  peer.addEventListener('message', e => peerMsgs.push(JSON.parse(e.data)));
  peer.send(JSON.stringify({t:'join',room:created.code,name:'远端验收',color:'#00aaff',engine:'v12'}));
  await ev(`document.getElementById('btnAddAI').click()`); await sleep(700);
  const roster = await ev(`window.__S.lobbyRoom.roster`);
  const aiId = roster.find(p => p.ai).id, remoteId = roster.find(p => p.name === '远端验收').id;
  assert(roster.length === 3 && roster.find(p => p.id === remoteId).engine === 'v12', '被踢连接可重新加入，AI与玩家音效名册独立');
  peer.send(JSON.stringify({t:'ready',v:true})); await ev(`document.getElementById('btnReady').click()`);
  let started = false;
  for (let i=0; i<80 && !started; i++) { await sleep(200); started = await ev(`!!(window.__S.rp && window.__S.rp.racing)`); }
  assert(started, '真实房间完整倒计时后进入竞速');
  await sleep(1800);
  const snapshots = peerMsgs.filter(m => m.t === 'snap').map(m => m.p.find(p => p.id === aiId && p.ai)).filter(Boolean);
  assert(snapshots.length >= 2 && snapshots.some(p => Math.hypot(p.d.x-snapshots[0].d.x,p.d.z-snapshots[0].d.z)>1), '房主真实模拟AI位移并中继至远端快照');
  const online = await (await fetch(`http://127.0.0.1:${PORT}/api/online`)).json();
  assert(online.racing === 2 && online.lobby === 0 && !('players' in online), '比赛人数只统计两名真人，默认响应不含玩家详情');
  await ev(`(() => { const s=window.__S,b=s.rp.byId.get(${aiId}); s.rp.onLap(b,1,8,false); s.rp.finishCar(b); })()`);
  await sleep(600);
  assert(peerMsgs.some(m => m.t === 'lap' && m.id === aiId && m.best === 8) && peerMsgs.some(m => m.t === 'fin' && m.id === aiId), 'AI圈速和完赛报文归属AI席位');
  assert(await ev(`(() => {const s=window.__S,b=s.rp.byId.get(${aiId}); return b.finishGhost && !s.localCar.finished && document.getElementById('finishBar').classList.contains('hidden');})()`), 'AI完赛永久幽灵，房主仍未完赛且顶部栏隐藏');
  await ev(`window.__S.rp.onLap(window.__S.localCar,window.__S.laps,9,true); window.__S.rp.finishCar(window.__S.localCar)`);
  peer.send(JSON.stringify({t:'lap',n:created.laps,time:10,dirty:true}));
  peer.send(JSON.stringify({t:'finish',id:remoteId})); await sleep(700);
  const result = peerMsgs.findLast(m => m.t === 'end');
  assert(result && result.results.length === 3 && result.results.find(r => r.id === aiId).best === 8 && result.results.find(r => r.id === created.host).best === 0, '真实服务端结算含AI且不污染房主最佳圈');
  for (let i=0; i<20 && await ev(`document.getElementById('settlement').classList.contains('hidden')`); i++) await sleep(100);
  assert(await ev(`!document.getElementById('settlement').classList.contains('hidden') && document.getElementById('finishBar').classList.contains('hidden') && document.getElementById('spectate').classList.contains('hidden')`), '结算展示后顶部完赛与观战栏保持隐藏');
  assert(exceptions.length === 0, '浏览器未捕获异常为零');
} catch (e) { console.error(e); process.exitCode = 1; }
finally { if (peer) peer.close(); ws.close(); child.kill(); srv.kill(); }
