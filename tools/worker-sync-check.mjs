/* Worker 同步契约：逐渲染帧插值、单调时间轴、类型化网络包和遥测镜像。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
(0, eval)(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
class FakeWorker {
  messages = [];
  transfers = [];
  postMessage(message, transfer = []) { this.messages.push(message); this.transfers.push(transfer); }
  terminate() {}
}
globalThis.Worker = FakeWorker;
const { PhysicsWorkerBridge } = await import('../public/js/PhysicsWorkerBridge.js');
const { buildStateArray, STATE, STATE_STRIDE, REMOTE_STRIDE } = await import('../public/js/physics-protocol.js');
const { Net } = await import('../public/js/network.js');
const b = new PhysicsWorkerBridge({localId:1,roster:[]});
const car = b.addCar({id:1,isLocal:true});
const remote = b.addCar({id:2,remote:true});
assert.equal(STATE_STRIDE, Math.max(...Object.values(STATE)) + 1, 'state stride covers every state slot');
assert.equal(REMOTE_STRIDE, 35, 'remote typed sample includes AI handoff progress and pose sequence');
b.setRemoteInput(2, 0.5, 0.25, -0.4, 1);
assert.equal(remote.throttle, 0.5, 'remote input mirror exposes throttle telemetry');
assert.equal(remote.brake, 0.25, 'remote input mirror exposes brake telemetry');
assert.equal(remote.steer, -0.4, 'remote input mirror exposes steer telemetry');
assert.equal(remote.handbrake, 1, 'remote input mirror exposes handbrake telemetry');
b._message({type:'ready'});
const local = {id:1,pos:{x:1,y:2,z:3},prevPos:{x:0,y:2,z:3},quat:{x:0,y:Math.SQRT1_2,z:0,w:Math.SQRT1_2},vel:{x:60,y:0,z:0},input:{throttle:1},trackIdx:120};
const arr = buildStateArray([local]);
const stamp = performance.now();
const detail = {road:true, barrier:false, normal:[0,1,0], penetration:0.01};
b._message({type:'state',now:stamp,time:1,alpha:0.1,step:60,contactMask:1,terrainContactMask:1,count:1,stride:STATE_STRIDE,contactDetails:[[detail]],buffer:arr.buffer});
assert.equal(b.physicsStep, 60, 'Worker step counter crosses the bridge without estimation');
assert.equal(car.contact, true, 'Worker contact flag crosses the bridge');
assert.equal(car.terrainContact, true, 'physical road contacts are reported separately');
assert.deepEqual(car.contactDetails, [detail], 'per-car contact details cross the bridge');
assert.deepEqual(b.lastContactDetails, [[detail]], 'contact detail diagnostics are retained');
assert.equal(b.worker.transfers.at(-1)?.[0] instanceof ArrayBuffer, true, 'state buffer is returned through the transferable path');
assert.equal(typeof b.renderAlpha, 'function', 'bridge provides a render-time accumulator');
assert.ok(b.renderAlpha(stamp + 5) > b.renderAlpha(stamp), 'alpha advances between Worker messages');
assert.ok(b.renderAlpha(stamp + 5) > 0.39 && b.renderAlpha(stamp + 5) < 0.41, 'alpha is continuous at 120/144Hz');
assert.equal(b.renderAlpha(stamp + 100), 2, 'display prediction clamps at one extra step without changing local physics');
assert.ok(Math.abs(car.fwd.x - 1) < 1e-5 && Math.abs(car.fwd.z) < 1e-5, 'mirror forward follows quaternion');
assert.equal(car.throttle, 1, 'mirror input telemetry drives audio/HUD');
console.log('PASS continuous render alpha and vehicle telemetry');
const published = [];
b.track = {count:1440,checkpoints:[{pos:{x:0,z:0}},{pos:{x:4,z:7}}]};
car.cpIdx = 0;
b.onNetwork = packet => published.push(packet);
b._publishNetwork(stamp);
assert.equal(published.length, 1, 'only the locally simulated vehicle is published');
assert.equal(published[0].id, car.id, 'packet belongs to the local vehicle');
assert.equal(published[0].d.n, 5, 'next checkpoint distance uses actual track geometry');
// ★ 上行报文按**语义精度**定点量化（见 _publishNetwork 的说明）：样条 p 用 1e-4 圈，
//   比服务端"通过时刻表"的 1/1024 圈(≈6.6m) 分辨率细 30 倍 ⇒ 不改变任何切片判定，
//   而单包 JSON 体积降约 1/3（30Hz × 12 车在服务端就是每秒数千次解析）。
assert.ok(Math.abs(published[0].d.p - 120/1440) < 1e-4 + 1e-12,
  'spline progress follows Worker track index within the 1e-4 wire quantum');
const q = published[0].d;
const quantizedOK =
  [q.x, q.y, q.z].every((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-9) &&
  q.q.every((v) => Math.abs(v * 1e4 - Math.round(v * 1e4)) < 1e-9) &&
  q.v.every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9);
assert.ok(quantizedOK, 'uplink floats are fixed-point quantized (r3 / r4 / r1)');
assert.ok(JSON.stringify(q).length < 260,
  `quantized uplink packet stays compact (${JSON.stringify(q).length} bytes)`);
b._publishNetwork(stamp + 10);
assert.equal(published.length, 1, 'network output is limited to 30Hz');
b._publishNetwork(stamp + 40);
assert.equal(published.length, 2, 'a later Worker state publishes without a render step');
console.log('PASS Worker-owned checkpoint distance, progress and 30Hz publication');
b.sendInput(car, 123);
await Promise.resolve();
const inputRequest = b.worker.messages.find(m => m.type === 'input');
assert.ok(inputRequest && inputRequest.values instanceof Float32Array && inputRequest.values.length === 4, 'input uses a four-value Float32Array');
const inputIndex = b.worker.messages.indexOf(inputRequest);
assert.equal(b.worker.transfers[inputIndex]?.[0], inputRequest.buffer, 'input ArrayBuffer is marked transferable');
console.log('PASS transferable input Float32Array');
b.handleNetworkPacket({kind:'snap',snapT:stamp,renderDelay:80,packet:{p:[{id:2,d:{x:7,y:8,z:9,q:[0,0,0,1],v:[1,2,3],u:0.1,b:0.2,e:0.3,h:1,f:1,l:2,gr:3,go:1}}]}});
await Promise.resolve();
const remoteRequest = b.worker.messages.find(m => m.type === 'remoteSamples');
assert.ok(remoteRequest && remoteRequest.count === 1 && remoteRequest.stride === REMOTE_STRIDE, 'remote packet declares the shared stride');
const remoteArray = new Float32Array(remoteRequest.buffer);
assert.equal(remoteArray.length, REMOTE_STRIDE, 'remote packet has one complete typed record');
assert.deepEqual(Array.from(remoteArray.slice(2, 5)), [7, 8, 9], 'remote position fields keep their offsets');
assert.equal(remoteArray[15], 1, 'remote handbrake field keeps its offset');
console.log('PASS transferable remote Float32Array and REMOTE_STRIDE layout');
const net = new Net();
let inbound;
net._workerInbound = p => { inbound = p; };
net.monoOffset = 1000 - Date.now();
net.dispatch({t:'snap',mts:1000,p:[]});
assert.ok(Math.abs(inbound.snapT - performance.now()) < 100, 'Worker snapshots use page monotonic time instead of epoch');
console.log('PASS network snapshot time uses the Worker clock domain');
assert.equal(typeof b.requestDiagnostics, 'function', 'Worker diagnostics has a request/reply path');
const diagnosticPromise = b.requestDiagnostics(250);
await Promise.resolve();
const request = b.worker.messages.find(m => m.type === 'diagnostics');
assert.ok(request && Number.isInteger(request.id), 'diagnostics request has a correlation ID');
b._message({type:'diagnostics',id:request.id,data:{fixedSteps:15}});
assert.equal((await diagnosticPromise).fixedSteps, 15, 'diagnostics resolves the exact reply');
console.log('PASS on-demand Worker diagnostics roundtrip');
const pendingBridge = new PhysicsWorkerBridge({localId:1,roster:[]});
const pendingReady = pendingBridge.prewarm().then(() => 'resolved', e => e.message);
pendingBridge.clear();
assert.equal(await pendingReady, 'physics worker disposed', 'disposing before ready rejects prewarm');
console.log('PASS prewarm rejects when the bridge is disposed before ready');
b.dispose();
console.log('worker-sync-check: PASS');
