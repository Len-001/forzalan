import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
(0, eval)(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
globalThis.document = { createElement: () => ({ style: {}, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }), toDataURL: () => 'data:,' }), getElementById: () => null };
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
const { Track } = await import('../public/js/track.js');
const { RacePhysics, CFG } = await import('../public/js/physics.js');
const { RemoteSnapshotBuffer } = await import('../public/js/RemoteSnapshotBuffer.js');
const rp = new RacePhysics(new Track(42, 'suzuka'));
const a = rp.addCar({ id: 1, isLocal: true, startIndex:0, lateral:0 }), b = rp.addCar({ id: 2, remote: true, startIndex:10, lateral:0 });
let failed = 0;
function check(name, fn) { try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }
check('high-speed local/remote contact gets predictive protection', () => {
  a.pos.set(0,0,0); b.pos.set(0,0,3); a.vel.set(0,0,40); b.vel.set(0,0,0);
  rp.updatePredictiveGhosting(); assert.ok(rp.ghostPairs.size > 0);
  b.pos.z = 10; a.vel.set(0,0,0); rp.updatePredictiveGhosting(); assert.equal(rp.ghostPairs.size,0);
});
check('soft-contact absorption preserves network-owned velocity', () => {
  a.body.velocity.set(4,0,0); b.body.velocity.set(0,0,0);
  rp.softPairs.set('1:2', { a,b,nx:1,ny:0,nz:0,ttl:2 }); rp.absorbSoftContacts();
  assert.equal(b.body.velocity.x,0); assert.ok(a.body.velocity.x < 4);
});
check('collision caps and yaw impulses preserve network-owned motion', () => {
  b.body.velocity.set(1,4,2); b.body.angularVelocity.set(0,0,0); b.pendingYaw = 2;
  rp.applyPendingYawImpulses(); rp.clampCollisionImpulse([a,b]);
  assert.equal(b.body.velocity.y,4); assert.equal(b.body.angularVelocity.y,0);
});
const source = fs.readFileSync(new URL('../public/js/physics.worker.js', import.meta.url), 'utf8');
const remoteHistory = new Map();
const push = vm.runInNewContext('(' + source.slice(source.indexOf('function pushRemoteSample('), source.indexOf('\nfunction updateRemoteTargets(')) + ')', {
  rp, remoteHistory, RemoteSnapshotBuffer, performance,
  num: (v,d=0) => Number.isFinite(v) ? v : d,
  pos: d => ({x:d.x||0,y:d.y||0,z:d.z||0}), quat: q => ({x:q?.[0]||0,y:q?.[1]||0,z:q?.[2]||0,w:q?.[3]??1}),
  vel: v => ({x:v?.[0]||0,y:v?.[1]||0,z:v?.[2]||0}),
});
check('remote rescue/finish update collision masks immediately', () => {
  rp.softPairs.clear(); b.ghost = 0; b.finishGhost = false; rp._refreshMasks();
  push(2,{gr:4,go:1},1000); assert.equal(b.body.collisionFilterMask & a.groupBit,0);
  push(2,{gr:0,go:0},1033); assert.notEqual(b.body.collisionFilterMask & a.groupBit,0);
  push(2,{f:1},1066); assert.equal(b.body.collisionFilterMask & a.groupBit,0);
});
class WorkerStub { messages=[]; postMessage(m) { this.messages.push(m); } terminate() {} }
globalThis.Worker = WorkerStub;
const { PhysicsWorkerBridge } = await import('../public/js/PhysicsWorkerBridge.js');
const bridge = new PhysicsWorkerBridge({ seed:42, localId:1, roster:[] }); bridge._message({type:'ready'});
bridge.handleNetworkPacket({kind:'snap',snapT:2000,packet:{p:[{id:2,age:700,d:{x:10,q:[0,0,0,1],v:[20,0,0]}}]}});
await Promise.resolve();
check('stale server rebroadcast keeps original pose time', () => {
  const record = new Float32Array(bridge.worker.messages.findLast(m=>m.type==='remoteSamples').buffer);
  assert.equal(record[1],1300);
  const h=new RemoteSnapshotBuffer(); h.push({t:record[1],p:{x:10,y:0,z:0},q:{x:0,y:0,z:0,w:1},v:{x:20,y:0,z:0},u:[0,0,0,0]},2000);
  assert.equal(h.sample(1940).p.x,15,'network gaps stop at the 250ms prediction limit');
  assert.equal(h.sample(1970).v.x,0,'frozen network proxy cannot push cars with stale velocity');
});
check('rebroadcast jitter cannot suppress weak-network recovery', () => {
  const h=new RemoteSnapshotBuffer();
  const sample=(t,x,seq)=>({t,seq,p:{x,y:0,z:0},q:{x:0,y:0,z:0,w:1},v:{x:20,y:0,z:0},u:[0,0,0,0]});
  h.push(sample(1000,0,1),1000); h.sample(1400);
  h.push(sample(1001,0,1),1400); assert.equal(h.lastReceive,1000);
  h.push(sample(1500,10,2),1500); assert.ok(h.recovering);
  const pose=h.sample(1500); assert.ok(pose.p.x > 5 && pose.p.x < 7,'resume blends from the frozen pose');
});
bridge.dispose(); rp.clear();
if (failed) process.exitCode=1;
