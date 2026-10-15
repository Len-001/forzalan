// 房间延迟/圈数验收：每个玩家延迟毫秒 + 房间内改圈数（服务端权威）
import path from 'node:path'; import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os';
const root=(await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT=8096, CDP=9351; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const srv=spawn(path.join(root,'forzalan.exe'),['-addr',':'+PORT,'-quiet'],{cwd:root,stdio:'ignore'});
// ★ 看门狗：本脚本此前可能在某个**无超时的等待**上永久挂起（门禁永远不给结论 =
//   比报错更糟）。这里显式限时并打印停在哪一阶段，便于定位。
const STAGE={s:'boot'};
const WATCHDOG_MS=Number(process.env.ROOM_PING_TIMEOUT_MS||150000);
const watchdog=setTimeout(()=>{
  console.log('  [31mFAIL 门禁超时（'+WATCHDOG_MS+'ms），停在阶段: '+STAGE.s+'[0m');
  try{srv.kill()}catch(_){}
  process.exit(1);
},WATCHDOG_MS);
watchdog.unref?.();
await sleep(1500);
STAGE.s='server-started';
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
 ['--headless=new','--ignore-gpu-blocklist','--use-angle=d3d11',`--remote-debugging-port=${CDP}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(),'tc-pg-'))}`,'--no-first-run','--window-size=1280,800','about:blank'],{stdio:'ignore'});
let ws,id=0; const waits=new Map();
for(let i=0;i<80&&!ws;i++){try{const l=await(await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
 const pg=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(pg){ws=new WebSocket(pg.webSocketDebuggerUrl);
 await Promise.race([new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}),
    new Promise((_,j)=>setTimeout(()=>j(new Error('CDP WS open 超时')),5000))]);}}catch(_){ws=null;} if(!ws)await sleep(200);}
if(!ws){console.log('  [31mFAIL 无法连接 Edge CDP[0m'); try{srv.kill()}catch(_){} process.exit(1);}
STAGE.s='cdp-connected';
ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);
 if(m.id&&waits.has(m.id)){const w=waits.get(m.id);waits.delete(m.id);m.error?w.rej(new Error(m.error.message)):w.res(m.result);}});
const send=(me,p={})=>new Promise((res,rej)=>{const i=++id;waits.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:me,params:p}));setTimeout(()=>{if(waits.has(i)){waits.delete(i);rej(new Error('t/o '+me))}},60000)});
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result.value;
await send('Runtime.enable'); await send('Page.enable'); STAGE.s='runtime-enabled';
await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});
await sleep(2600); STAGE.s='page-loaded';
for(let i=0;i<60;i++){ if(await ev('!!(window.__S&&window.__S.net&&window.__S.net.connected)')) break; await sleep(300); }
await ev('(()=>{const b=document.getElementById("btnCreate"); if(b)b.click(); return true})()');
await sleep(1200); STAGE.s='room-created';
let fail=0;
const ok=(c,n,d='')=>{ if(c) console.log('  PASS '+n+(d?'   '+d:'')); else {fail++; console.log('  FAIL '+n+'   '+d);} };
// 等延迟探测量到值
let room=null;
for(let i=0;i<40;i++){ await sleep(500);
  room=await ev('window.__S.lobbyRoom ? JSON.parse(JSON.stringify(window.__S.lobbyRoom)) : null');
  if(room && room.players && room.players.some(p=>Number.isFinite(p.ms)&&p.ms>=0)) break; }
const me=room&&room.players&&room.players[0];
console.log('  room='+JSON.stringify({laps:room&&room.laps, ms:me&&me.ms}));
ok(!!me && Number.isFinite(me.ms) && me.ms >= 0 && me.ms < 2000, '服务端下发了玩家延迟 ms', 'ms='+(me&&me.ms));
ok(me && me.ms >= 0, '延迟值有效（-1 表示未测得，不应出现在已连接玩家上）', 'ms='+(me&&me.ms));
const tags=await ev('Array.from(document.querySelectorAll("#playerList .ptag.ping")).map(e=>e.textContent.trim())');
console.log('  延迟徽标 DOM: '+JSON.stringify(tags));
ok(Array.isArray(tags)&&tags.length>=1&&/^\d+ ms$/.test(tags[0]), '房间玩家卡片渲染了 "N ms" 徽标', JSON.stringify(tags));
// 圈数
const lapsTxt0=await ev('(document.getElementById("roomLaps")||{}).textContent');
const btnVisible=await ev('(()=>{const b=document.getElementById("btnLaps"); return !!b && !b.classList.contains("hidden");})()');
ok(/圈/.test(lapsTxt0||''), '房间内显示当前圈数', lapsTxt0);
ok(btnVisible, '房主可见"修改圈数"按钮');
await ev('(()=>{const b=document.getElementById("btnLaps"); if(b)b.click(); return true})()');
await sleep(900);
const lapsTxt1=await ev('(document.getElementById("roomLaps")||{}).textContent');
ok(lapsTxt0!==lapsTxt1, '点击后圈数真的变了（服务端权威回包）', lapsTxt0+' -> '+lapsTxt1);
const room2=await ev('window.__S.lobbyRoom ? window.__S.lobbyRoom.laps : null');
console.log('  服务端 laps='+room2);
ok(room2===4, '服务端 laps 已更新为 4', String(room2));
console.log(fail?('\x1b[31m失败 '+fail+' 项\x1b[0m'):'\x1b[32m全部通过\x1b[0m');
try{child.kill()}catch(_){}; try{srv.kill()}catch(_){}
clearTimeout(watchdog);
// 显式退出：CDP 的 send() 里为每次调用挂了 60s 兜底定时器（成功时不清理），
// 会让事件循环空转到 60s，表现为"验收已全部通过却迟迟不退出"。
process.exit(fail?1:0);
