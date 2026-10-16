import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { deadzone, gamepadInput, tiltSteer } from '../public/js/DrivingControls.js';
import { routeProgress } from '../public/js/race-position.js';
import { PenaltyController } from '../public/js/PenaltyController.js';
import { RemoteSnapshotBuffer } from '../public/js/RemoteSnapshotBuffer.js';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
const { Track } = await import('../public/js/track.js');
const { RacePhysics, CFG } = await import('../public/js/physics.js');
globalThis.Worker = class { constructor(){this.messages=[];} postMessage(m){this.messages.push(m);} terminate(){} };
const { PhysicsWorkerBridge } = await import('../public/js/PhysicsWorkerBridge.js');
const bridge = new PhysicsWorkerBridge();
const timestamp = performance.now();
bridge.handleNetworkPacket({kind:'snap',snapT:timestamp,packet:{p:[{id:2,seq:2,d:{x:1,y:2,z:3,q:[0,0,0,1]}}]}});
assert.equal(bridge.worker.messages.some(m=>m.type==='remoteSamples'),false);
bridge._message({type:'ready',clockNow:-120000});
await Promise.resolve();
const sample = bridge.worker.messages.find(m=>m.type==='remoteSamples');
assert.ok(sample);
assert.ok(Math.abs(new Float32Array(sample.buffer)[1]-(timestamp-bridge._workerToMainMonoOffset))<0.02);
bridge.clear();
console.log('PASS pre-ready snapshots use the calibrated Worker clock even after a long lobby wait');

const buffer = new RemoteSnapshotBuffer();
const snap = (seq,t,x) => ({seq,t,p:{x,y:0,z:0},q:{x:0,y:0,z:0,w:1},v:{x:0,y:0,z:0},u:[0,0,0,0]});
buffer.push(snap(20,2000,20),2000);
assert.equal(buffer.push(snap(19,1900,19),2010),false);
assert.equal(buffer.samples.at(-1).seq,20);
console.log('PASS delayed server fallback cannot rewind a newer P2P snapshot');

for (const mode of ['fm8','horizon','bumper']) {
  const controller = new PenaltyController();
  assert.equal(controller.show('wall',3,'wall',mode),false);
  if(mode==='bumper') for(const reason of ['cut','ram','rescue','frr_gain']) assert.equal(controller.show(reason,3,reason,mode),false);
  controller.clear();
}
const controller = new PenaltyController();
controller.show('unknown_english_reason',1,'unknown');
assert.equal(controller.active.label,'赛事规则');controller.clear();
console.log('PASS bumper/wall silence and Chinese fallback labels');

assert.equal(deadzone(0.05),0);
assert.ok(Math.abs(deadzone(1)-1)<1e-9);
const buttons=Array.from({length:8},()=>({value:0}));buttons[7].value=.7;buttons[6].value=.2;buttons[0].value=1;
assert.deepEqual(gamepadInput({buttons,axes:[1]}),{throttle:.7,brake:.2,steer:1,handbrake:1});
assert.equal(gamepadInput(null).throttle,0);
assert.ok(tiltSteer(30,0,90).steer>.99 && tiltSteer(30,0,270).steer<-.99);
assert.equal(tiltSteer(12,0,90,12).steer,0);
console.log('PASS analog triggers, stick deadzone, disconnected input and both landscape gyro orientations');

for (const type of ['suzuka','vegas','spa','oval']) {
  const track=new Track(777,type), rp=new RacePhysics(track);
  const car=rp.addCar({id:1,isLocal:true,startIndex:100,lateral:0,laps:3});
  car.lineCross=1;car.trackIdx=100;car.pos.copy(track.pts[100]);
  const before=routeProgress(car,track);
  car.pos.addScaledVector(track.side[100],track.halfWidthAt[100]+3);
  assert.ok(Math.abs(routeProgress(car,track)-before)<1e-8,`${type}: lateral grass excursion changes rank`);
  car.trackIdx=track.count-1;car.pos.copy(track.pts[car.trackIdx]);const nearLine=routeProgress(car,track);
  car.trackIdx=0;car.lineCross=2;car.pos.copy(track.pts[0]);
  assert.ok(routeProgress(car,track)-nearLine<.002,`${type}: finish-line jump`);
  car.grassWheels=4;car.offRoad=0;car.muEffective=CFG.GRIP_ROAD;
  car.body.velocity.set(0,0,50);
  rp.updateOffRoad(car,1/60);assert.ok(car.offRoad<.06);
  assert.equal(car.body.velocity.z,50,'surface transition cannot overwrite inertia');
  rp.setGameMode('bumper');
  for(const reason of ['wall','ram','cut','shortcut','rescue','frr_gain'])car.addPenalty(3,reason);
  assert.equal(car.penalty,0);
  const line=track.raceLine;
  for(let i=0;i<track.count;i++) {
    assert.ok(Math.abs(line.offset[i])<=track.halfWidthAt[i]-1.3);
    assert.ok(Number.isFinite(line.vTarget[i]) && line.vTarget[i]>0);
  }
  rp.clear();console.log(`PASS ${type}: grass/line-cross position continuity, penalty policy and bounded racing line`);
}

const source=fs.readFileSync(new URL('../public/js/main.js',import.meta.url),'utf8');
const start=source.indexOf('function updateRacingLine(dt)'),end=source.indexOf('\n/* ===',start);
const line={active:true,count:16,spacing:5,radius:new Float32Array(16).fill(20),vTarget:new Float32Array(16).fill(15),brakeIntensity:new Float32Array(16).fill(1),colorAttr:{array:new Float32Array(96)}};
let speed=2;
const context={track:{raceLine:line,nearest:()=>0},S:{localCar:{body:{velocity:{length:()=>speed}},pos:{x:0,z:0},trackIdx:0},rp:{}},lineTick:0,CFG,LINE_SAFE:[0,1,0],LINE_WARN:[1,1,0],LINE_OVER:[1,0,0],LINE_IDLE:[.3,.3,.3]};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
context.updateRacingLine(.04);assert.equal(line.colorAttr.array[1],1);
speed=40;context.updateRacingLine(.04);assert.equal(line.colorAttr.array[0],1);assert.equal(line.colorAttr.array[1],0);
console.log('PASS the same corner changes from green to red with actual car speed');
