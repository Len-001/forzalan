import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchBrowser} from './browser-launcher.mjs';
const root=path.resolve(import.meta.dirname,'..'),port=18111,cdp=19462,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(path.join(root,'forzalan.exe'),['-addr',`127.0.0.1:${port}`,'-quiet'],{cwd:mkdtempSync(path.join(tmpdir(),'phase2-game-')),stdio:'ignore'}),browser=launchBrowser(cdp,'phase2-ui-');
let ws,serial=0;const pending=new Map(),errors=[];
async function until(fn,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch{}await sleep(100);}throw Error('Timeout: '+label);}
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function ev(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
const key=(type,key,code,vk)=>send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
try{
 await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();const p=pages.find(p=>p.type==='page');if(!p)return false;ws=new WebSocket(p.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return true;},'browser');
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 await send('Runtime.enable');await send('Page.navigate',{url:`http://127.0.0.1:${port}/?mode=casual`});
 await until(()=>ev('!!window.__S?.net?.connected'),'game boot');
 assert.equal(await ev('document.getElementById("assist-steering").disabled'),false);
 await ev('document.getElementById("btnGarage").click();const e=document.getElementById("tune-finalDrive");e.value="1.1";e.dispatchEvent(new Event("input"));document.getElementById("closeGarage").click();document.getElementById("startingCompound").value="Soft";document.getElementById("btnSolo").click()');
 await until(()=>ev('!!window.__S?.rp?.racing'),'casual race');await until(()=>ev('window.__S.localCar.rewindSeconds>3'),'rewind history');
 assert.equal(await ev('window.__S.localCar.compound'),'Soft');assert.equal(await ev('window.__S.rp.setup.tuning.finalDrive'),1.1);
 await key('keyDown','w','KeyW',87);await sleep(3000);await key('keyUp','w','KeyW',87);
 const before=await ev('window.__S.rp.time');await key('keyDown','Backspace','Backspace',8);await sleep(1500);
 const rewind=await ev('({time:__S.rp.time,active:__S.localCar.rewinding})');assert.ok(rewind.active&&rewind.time<before-0.5,JSON.stringify({before,rewind}));
 await key('keyUp','Backspace','Backspace',8);await sleep(1200);assert.equal(await ev('__S.localCar.penalty'),0);
 assert.equal(await ev('document.querySelectorAll("#tireMatrix span").length'),4);assert.ok(await ev('document.getElementById("tire-FL").textContent.includes("°")'));
 console.log('PASS live garage setup, tire telemetry, Casual controls and real Worker rewind/resume');
 await send('Page.navigate',{url:`http://127.0.0.1:${port}/?mode=competitive`});await until(()=>ev('!!window.__S?.net?.connected'),'competitive lobby');
 assert.equal(await ev('document.getElementById("assist-steering").disabled'),true);
 await ev('document.getElementById("btnCreate").click()');await until(()=>ev('!!window.__S.lobbyRoom?.room'),'create');await ev('document.getElementById("btnReady").click()');await until(()=>ev('!!window.__S.rp?.racing'),'competitive start');
 await ev('__S.rp.worker.postMessage({type:"rewind",value:true})');await sleep(300);assert.equal(await ev('__S.localCar.rewinding'),false);
 await ev('__S.net.dispatch({t:"RACE_RESULTS",data:[{id:__S.localId,name:"Driver",rank:1,fin:true,totalTime:120,bestLap:40,points:10,skillRating:1012,safetyRating:"A"}]})');await sleep(1800);
 assert.equal(await ev('getComputedStyle(document.getElementById("settlement")).pointerEvents'),'none');assert.equal(await ev('getComputedStyle(document.querySelector(".settle-panel")).pointerEvents'),'auto');
 assert.equal(errors.length,0,errors.join('\n'));console.log('PASS competitive assist/rewind locks, authoritative room start and nonblocking results drawer');
}finally{ws?.close();for(const p of pending.values())clearTimeout(p.timer);browser.kill();server.kill();}
