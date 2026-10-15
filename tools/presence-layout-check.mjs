/* 真实浏览器验收：首页大厅人数、房间详情收起、布局与引擎选择器。 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root=(await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT=8098, CDP=9378, sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const scratch=process.env.TMPDIR||tmpdir();
const srv=spawn(path.join(root,'forzalan.exe'),['-addr',':'+PORT,'-quiet'],{cwd:root,stdio:'ignore'});
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
  '--headless=new','--ignore-gpu-blocklist','--use-angle=d3d11','--remote-debugging-port='+CDP,
  '--user-data-dir='+mkdtempSync(path.join(scratch,'presence-ui-')),'--no-first-run','--window-size=1280,800',
  'about:blank'],{stdio:'ignore'});
let ws,id=0;const waits=new Map();const exceptions=[];
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id,t=setTimeout(()=>{waits.delete(i);rej(new Error('t/o '+method));},15000);waits.set(i,{res,rej,t});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
const ok=(v,s)=>{if(!v)throw new Error('FAIL '+s);console.log('PASS '+s);};
try{
 for(let i=0;i<80&&!ws;i++){try{const l=await(await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p){ws=new WebSocket(p.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});}}catch(_){ }if(!ws)await sleep(200);}
 if(!ws)throw new Error('CDP 未就绪');
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails||{};exceptions.push(d.exception?.description||d.description||d.text||'exception');}if(m.id&&waits.has(m.id)){const w=waits.get(m.id);waits.delete(m.id);clearTimeout(w.t);m.error?w.rej(new Error(m.error.message)):w.res(m.result);}});
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});await sleep(2600);
 for(let i=0;i<60;i++){if(await ev('!!(window.__S&&window.__S.net&&window.__S.net.connected)'))break;await sleep(250);}
 const home=await ev(`(()=>{const p=document.getElementById('presencePanel'),d=document.getElementById('presenceDetails'),e=document.getElementById('engineSound'),j=document.getElementById('stageJoin'),r=document.querySelector('.lobby-panel').getBoundingClientRect();return {open:d.open,count:document.getElementById('presenceCount').textContent,engineClass:e.className,engineStyle:getComputedStyle(e).appearance,joinHidden:j.classList.contains('hidden'),panel:{x:r.x,y:r.y,w:r.width,h:r.height},presence:p.getBoundingClientRect().toJSON(),engine:e.getBoundingClientRect().toJSON()};})()`);
 ok(home.open,'首页大厅详情默认展开');ok(!/\/12/.test(home.count)&&!/尚未进入房间/.test(home.count),'首页人数文案无上限和废话');ok(home.engineClass.includes('inp')&&home.engineClass.includes('sel'),'引擎选择器使用统一样式');ok(home.joinHidden===false,'创建房间页面可见');
 await ev(`(()=>{const n=document.getElementById('name');n.value='布局验收';document.getElementById('btnCreate').click();})()`);await sleep(1000);
 const room=await ev(`(()=>{const d=document.getElementById('presenceDetails'),j=document.getElementById('stageJoin'),r=document.getElementById('stageRoom'),p=document.querySelector('.lobby-panel').getBoundingClientRect(),q=document.getElementById('presencePanel').getBoundingClientRect(),c=document.getElementById('chatPanel').getBoundingClientRect();return {closed:!d.open,joinHidden:j.classList.contains('hidden'),roomVisible:!r.classList.contains('hidden'),panel:p.toJSON(),presence:q.toJSON(),chat:c.toJSON(),count:document.getElementById('presenceCount').textContent};})()`);
 ok(room.closed,'进入房间后玩家详情默认收起');ok(room.joinHidden&&room.roomVisible,'创建房间页切换为房间页且无重叠切换');ok(!/12/.test(room.count)&&!/尚未进入房间/.test(room.count),'房间人数文案无上限和废话');
 const overlap=await ev(`(()=>{const a=document.querySelector('.lobby-panel').getBoundingClientRect(),p=document.getElementById('presencePanel').getBoundingClientRect(),c=document.getElementById('chatPanel').getBoundingClientRect();const hit=(x,y)=>x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top;return {main:a.toJSON(),presence:p.toJSON(),chat:c.toJSON(),presenceHit:hit(a,p),chatHit:hit(a,c)};})()`);
 console.log('  bounds='+JSON.stringify(overlap));
 ok(!overlap.presenceHit&&!overlap.chatHit,'主卡与大厅/聊天面板无矩形重叠');ok(exceptions.length===0,'浏览器 Runtime.exceptionThrown 为零');
}catch(e){console.error(e.stack||e);process.exitCode=1;}finally{if(ws)ws.close();browser.kill();srv.kill();}
