/* 真实浏览器验收：幽灵车仅在视觉重合时触发镜头震动。 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root=(await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url))), port=8099, cdp=9379;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)), scratch=process.env.TMPDIR||tmpdir();
const srv=spawn(join(root,'forzalan.exe'),['-addr',':'+port,'-quiet'],{cwd:root,stdio:'ignore'});
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--ignore-gpu-blocklist','--use-angle=d3d11','--remote-debugging-port='+cdp,'--user-data-dir='+mkdtempSync(join(scratch,'ghost-shake-')),'--no-first-run','--window-size=1280,800',`http://127.0.0.1:${port}/?solo=1&dbg=1&track=suzuka&laps=1`],{stdio:'ignore'});
let ws,id=0;const waits=new Map(),exceptions=[];
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id,t=setTimeout(()=>{waits.delete(i);rej(new Error('t/o '+method));},15000);waits.set(i,{res,rej,t});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
const ok=(v,s)=>{if(!v)throw new Error('FAIL '+s);console.log('PASS '+s);};
async function sample(ms){return ev(`(async()=>{const a=[];const end=performance.now()+${ms};while(performance.now()<end){a.push([__camera.position.x,__camera.position.y,__camera.position.z]);await new Promise(r=>requestAnimationFrame(r));}return a;})()`);}
const span=a=>{const r=[0,1,2].map(i=>{const v=a.map(x=>x[i]);return Math.max(...v)-Math.min(...v);});return Math.max(...r);};
try{
 for(let i=0;i<80&&!ws;i++){try{const l=await(await fetch(`http://127.0.0.1:${cdp}/json/list`)).json(),p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p){ws=new WebSocket(p.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});}}catch(_){}if(!ws)await sleep(200);}
 if(!ws)throw new Error('CDP 未就绪');
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails||{};exceptions.push(d.exception?.description||d.description||d.text||'exception');}if(m.id&&waits.has(m.id)){const w=waits.get(m.id);waits.delete(m.id);clearTimeout(w.t);m.error?w.rej(new Error(m.error.message)):w.res(m.result);}});
 await send('Runtime.enable');await send('Page.enable');
 for(let i=0;i<80;i++){if(await ev('!!(window.__S&&window.__S.rp&&window.__S.rp.racing)'))break;await sleep(250);}
 ok(await ev('!!(window.__S&&window.__S.rp&&window.__S.rp.racing)'),'单机进入竞速状态');
 await ev(`(()=>{const s=__S;const other=s.rp.cars.find(c=>c!==s.localCar);const l=__carVisuals.get(s.localCar.id),o=__carVisuals.get(other.id);s.rp.setGhostMode(true);s.localCar.raceLocked=true;s.localCar.vel.set(0,0,0);s.localCar.speed=0;for(const c of s.rp.cars){c.raceLocked=true;c.vel.set(0,0,0);c.speed=0;}window.__ghostOffset=10;window.__holdGhost=()=>{const off=window.__ghostOffset||0;if(other.body&&s.localCar.body){other.body.position.copy(s.localCar.body.position);other.body.position.x+=off;other.body.velocity.set(0,0,0);}other.pos.copy(s.localCar.pos);other.pos.x+=off;o.position.copy(l.position);o.position.x+=off;requestAnimationFrame(window.__holdGhost);};requestAnimationFrame(window.__holdGhost);})()`);
 await sleep(600);const far=await sample(320);
 await ev('window.__ghostOffset=0');await sleep(240);const near=await sample(420);
 const sf=span(far),sn=span(near);console.log('  samples='+far.length+'/'+near.length+' cameraSpanFar='+sf.toFixed(5)+' near='+sn.toFixed(5));
 ok(sn>sf+0.00005,'远距离幽灵车不震动，视觉重合才触发镜头震动');ok(exceptions.length===0,'浏览器 Runtime.exceptionThrown 为零');
}catch(e){console.error(e.stack||e);process.exitCode=1;}finally{if(ws)ws.close();browser.kill();srv.kill();}
