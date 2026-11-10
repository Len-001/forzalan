import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
class WorkerStub { postMessage() {} terminate() {} }
globalThis.Worker=WorkerStub;
const {PhysicsWorkerBridge}=await import('../public/js/PhysicsWorkerBridge.js');
const protocol=await import('../public/js/physics-protocol.js');
const {PHYSICS_DT}=protocol;
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
check('local visual reconciliation preserves physics and decays 99% over 15 frames',()=>{
  const bridge=new PhysicsWorkerBridge({localId:1,roster:[{id:1,isLocal:true}]});
  bridge._message({type:'ready'});
  const c=bridge.byId.get(1), p=new THREE.Vector3(), q=new THREE.Quaternion();
  c._hasState=true; bridge.alpha=0; bridge._stateNow=1000;
  bridge._previousStateNow=1000; bridge._previousAlpha=0;
  const {STATE,STATE_STRIDE}=protocol;
  const a=new Float32Array(STATE_STRIDE);a[STATE.ID]=1;
  a[STATE.PX]=a[STATE.PPX]=10; a[STATE.QW]=a[STATE.PQW]=1;
  bridge._applyRecord(a,0);
  assert.equal(c.body.position.x,10,'physics must update immediately');
  bridge.renderPose(c,p,q,1000,0);assert.ok(Math.abs(p.x)<1e-6,'correction must not snap the mesh');
  let last=p.x;
  for(let i=0;i<15;i++){bridge.renderPose(c,p,q,1000,1/60);assert.ok(p.x>=last && p.x<10);last=p.x;}
  assert.ok(Math.abs(10-p.x-0.1)<1e-6,'99% convergence at 250ms');
  assert.equal(c.body.position.x,10);bridge.dispose();
});
const {Track}=await import('../public/js/track.js');
check('spatial index matches brute-force nearest queries on all four tracks',()=>{
  for(const type of ['suzuka','vegas','spa','oval']) {
    const track=new Track(777,type);
    for(let k=0;k<80;k++) {
      const seed=track.pts[(k*37)%track.count], x=seed.x+Math.sin(k)*70,z=seed.z+Math.cos(k)*70;
      const index=track.nearest(x,z);
      const d=p=>(p.x-x)**2+(p.z-z)**2;
      let best=Infinity;for(const p of track.pts)best=Math.min(best,d(p));
      assert.ok(Math.abs(d(track.pts[index])-best)<1e-7,`${type}: spatial query differs from full search`);
    }
  }
});
check('combined tire force stays inside its friction circle under throttle and braking',()=>{
  const track=new Track(777,'oval'), physics=new RacePhysics(track);
  const c=physics.addCar({id:1,isLocal:true,name:'grip',startIndex:100,lateral:0,laps:3});
  physics.racing=true;c.raceLocked=false;
  const tangent=track.tan[c.trackIdx];c.body.velocity.set(tangent.x*25,0,tangent.z*25);c.syncFromBody();
  for(let k=0;k<60;k++) {
    c.input.throttle=k<30?1:0;c.input.brake=k<30?0:1;c.input.steer=0.5;
    physics.fixedStep(PHYSICS_DT);
    assert.ok(Math.hypot(c.tireForceLongitudinal,c.tireForceLateral)<=c.tireForceCapacity+1e-6);
    assert.ok(c.FzFront>0 && c.FzRear>0);
  }
});
check('rear shell impacts flatten normals and cannot inject vertical launch speed',()=>{
  const track=new Track(777,'oval'), physics=new RacePhysics(track);physics.setGameMode('bumper');physics.racing=true;
  const a=physics.addCar({id:1,isLocal:true,startIndex:100,lateral:0,laps:3});
  const b=physics.addCar({id:2,isLocal:false,startIndex:100,lateral:0,laps:3});
  a.raceLocked=b.raceLocked=false;
  const t=track.tan[100];a.body.position.x-=t.x*4.2;a.body.position.z-=t.z*4.2;
  a.body.velocity.set(t.x*15,0,t.z*15);b.body.velocity.set(t.x*5,0,t.z*5);
  let contacts=0,maxY=0;
  for(let k=0;k<90;k++) {
    physics.fixedStep(PHYSICS_DT);
    for(const eq of physics.world.contacts) if(eq.bi.__carId!==undefined && eq.bj.__carId!==undefined) {
      contacts++;assert.equal(eq.ni.y,0);assert.equal(eq.ri.y,0);assert.equal(eq.rj.y,0);
      assert.ok(eq.maxForce*PHYSICS_DT<=40000+1e-6);
      maxY=Math.max(maxY,Math.abs(a.body.velocity.y),Math.abs(b.body.velocity.y));
    }
  }
  assert.ok(contacts>0,'the rear impact must actually occur');assert.ok(maxY<0.5,`vertical impact speed ${maxY}`);
});
if(failed)process.exitCode=1;
