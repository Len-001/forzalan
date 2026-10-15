import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
class WorkerStub { postMessage() {} terminate() {} }
globalThis.Worker=WorkerStub;
const {PhysicsWorkerBridge}=await import('../public/js/PhysicsWorkerBridge.js');
const {PHYSICS_DT}=await import('../public/js/physics-protocol.js');
const {RacePhysics}=await import('../public/js/physics.js');
const source=fs.readFileSync(new URL('../public/js/physics.worker.js',import.meta.url),'utf8');
let failed=0;
function check(name,fn) { try {fn();console.log('PASS '+name);} catch(e) {failed++;console.error('FAIL '+name+': '+e.message);} }
check('Worker render phase counts residual time once, including catch-up',()=>{
  for(const elapsed of [25,42,91]) {
    const bridge=new PhysicsWorkerBridge({localId:1,roster:[]}); bridge._message({type:'ready'});
    const rp={cars:[],world:{contacts:[],stepnumber:0},time:0,fixedStep(dt){this.time+=dt;this.world.stepnumber++;}};
    const context={rp,disposed:false,lastNow:1000,running:true,acc:0,MAX_FIXED_STEPS:6,PHYSICS_DT,diagnosticProbe:null,
      performance:{now:()=>1000+elapsed},updateRemoteTargets(){},setTimeout(){},post(m){throw new Error(m.message);},stateContactDetails:[],
      snapshot(now){bridge._message({type:'state',now,time:rp.time,alpha:Math.min(1,rp.acc/PHYSICS_DT),step:rp.world.stepnumber,count:0,buffer:new ArrayBuffer(0)});}};
    const tick=vm.runInNewContext('('+source.slice(source.indexOf('function tick('),source.indexOf('\nself.addEventListener(\'error\''))+')',context);
    tick(1000+elapsed);
    const expected=context.acc/PHYSICS_DT, actual=bridge.renderAlpha(1000+elapsed);
    assert.ok(Math.abs(actual-expected)<1e-6,`elapsed ${elapsed}ms: expected phase ${expected.toFixed(3)}, got ${actual.toFixed(3)}`);
    assert.ok(Math.abs(bridge.renderAlpha(1002+elapsed)-Math.min(1,expected+0.002/PHYSICS_DT))<1e-6);
    bridge.dispose();
  }
});
const rp=Object.create(RacePhysics.prototype);
const car=()=>({input:{steer:1,handbrake:0},speedKmh:80,steerInput:0,handbrake:0,yawDisturb:0});
check('steering builds smoothly within 250ms without overshoot',()=>{
  const c=car(); let t95=0;
  while(c.steerInput<0.95 && t95<1) {rp.updateSteer(c,PHYSICS_DT);t95+=PHYSICS_DT;assert.ok(c.steerInput<=1);}
  assert.ok(t95<=0.25,`95% input takes ${Math.round(t95*1000)}ms`);
  console.log(`  steering 95%: ${Math.round(t95*1000)}ms`);
});
check('countersteer changes direction within 67ms and reaches 80% within 200ms',()=>{
  const c=car(); c.steerInput=1;c.input.steer=-1;
  let t=0,changed=0;
  while(c.steerInput>-0.8 && t<1) {rp.updateSteer(c,PHYSICS_DT);t+=PHYSICS_DT;if(!changed&&c.steerInput<=0)changed=t;}
  assert.ok(changed<=0.067,`still steering the old way for ${Math.round(changed*1000)}ms`);
  assert.ok(t<=0.20,`opposite 80% input takes ${Math.round(t*1000)}ms`);
  console.log(`  reversal sign: ${Math.round(changed*1000)}ms; opposite 80%: ${Math.round(t*1000)}ms`);
  c.input.steer=0; for(let i=0;i<15;i++)rp.updateSteer(c,PHYSICS_DT);assert.ok(Math.abs(c.steerInput)<0.05);
  assert.ok(rp.maxSteerAt(160)<=0.15+1e-9,'high-speed steering cap stays active');
});
if(failed)process.exitCode=1;
