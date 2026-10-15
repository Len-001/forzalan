import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.Worker=class {postMessage(){} terminate(){}};
const {PhysicsWorkerBridge}=await import('../public/js/PhysicsWorkerBridge.js');
let failures=0;
function check(name,fn){try{fn();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+': '+e.message);}}
check('display keeps moving during one delayed Worker step and stops after its bound',()=>{
  const bridge=new PhysicsWorkerBridge({localId:1,roster:[]});bridge._message({type:'ready'});
  bridge.alpha=0;bridge._stateNow=1000;
  const phase=bridge.renderAlpha(1020);
  assert.ok(Math.abs(phase-1.2)<1e-9,`20ms old sample must move beyond its end, got ${phase}`);
  assert.equal(bridge.renderAlpha(1100),2,'display prediction cannot run indefinitely');
  bridge.alpha=0;bridge._stateNow=1000+1000/60;
  assert.ok(Math.abs((1+bridge.renderAlpha(1020))-phase)<1e-9,'next sample meets the predicted display position');
  bridge.dispose();
});
check('driving key events reach physics without a render frame; chat and green locks stay enforced',()=>{
  const source=fs.readFileSync(new URL('../public/js/main.js',import.meta.url),'utf8');
  const handlers={},sent=[];
  const car={id:1,input:{throttle:0,brake:0,steer:0,handbrake:0},finished:false,raceLocked:false};
  const S={mode:'race',localCar:car,chatTyping:false,controlsLocked:false,rp:{racing:true,sendInput(c){sent.push({...c.input});}}};
  const context={S,window:{addEventListener(k,f){handlers[k]=f;}},audio:{init(){},resume(){}},performance,console,
    releaseDriveKeys(){},CAM:{CAM_COUNT:3}};
  vm.runInNewContext(source.slice(source.indexOf('const keys = Object.create(null);'),source.indexOf('\nfunction clearRace()')),context);
  const event=key=>({key,code:'Key'+key.toUpperCase(),target:{tagName:'BODY'},preventDefault(){},stopPropagation(){}});
  handlers.keydown(event('d'));assert.equal(sent.at(-1)?.steer,1);
  handlers.keyup(event('d'));assert.equal(sent.at(-1)?.steer,0);
  handlers.keydown(event('a'));assert.equal(sent.at(-1)?.steer,-1);
  handlers.blur();assert.equal(sent.at(-1)?.steer,0);
  S.controlsLocked=true;handlers.keydown(event('w'));assert.equal(sent.at(-1)?.throttle,0);
  S.controlsLocked=false;S.chatTyping=true;const count=sent.length;handlers.keydown(event('d'));assert.equal(sent.length,count);
  S.chatTyping=false;handlers.keydown({...event('d'),target:{tagName:'INPUT'}});assert.equal(sent.length,count);
});
if(failures)process.exitCode=1;
