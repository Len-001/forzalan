import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RemoteSnapshotBuffer } from '../public/js/RemoteSnapshotBuffer.js';
eval(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
const { Net } = await import('../public/js/network.js');
const frame = (t,x,v,q={x:0,y:0,z:0,w:1}) => ({t,p:{x,y:0,z:0},v:{x:v,y:0,z:0},q,u:[1,0,0,0]});
const h = new RemoteSnapshotBuffer();
h.push(frame(1000,0,0),1000);
h.push(frame(2000,10,20,{x:0,y:1,z:0,w:0}),2000);
const p = h.sample(1500);
assert.ok(Math.abs(p.p.x-2.5)<1e-8, 'Hermite includes measured endpoint velocities (linear would be 5m)');
assert.ok(Math.abs(p.q.y-Math.SQRT1_2)<1e-8 && Math.abs(p.q.w-Math.SQRT1_2)<1e-8, 'quaternion SLERP yields 90 degrees');
assert.equal(h.push(frame(1200,99,0),2001),false,'old packets cannot rewind history');
assert.equal(h.push(frame(NaN,99,0),2002),false,'non-finite timestamps cannot poison history');
assert.equal(h.sample(1600).u[0],1,'input telemetry follows target');
console.log('PASS Hermite, shortest-path SLERP and out-of-order rejection');
const e = new RemoteSnapshotBuffer();
e.push(frame(1000,10,20),1000);
assert.equal(e.sample(1400).p.x,15,'extrapolation caps at 250ms');
assert.equal(e.sample(2000).p.x,15,'long gaps freeze at bounded projection');
e.push(frame(2200,34,20),2200);
const recovered = e.sample(2200).p.x;
assert.ok(recovered>15 && recovered<19,`recovery blends instead of teleporting: ${recovered}`);
let x = recovered;
for(let i=1;i<90;i++) { const t=2200+i*1000/60; e.push(frame(t,34+(t-2200)*0.02,20),t); const y=e.sample(t).p.x; assert.ok(y>=x,'resume never reverses a forward-moving vehicle'); x=y; }
assert.ok(Math.abs(x-(34+89/60*20))<0.05,'recovery converges to current route');
console.log('PASS bounded prediction and weak-network recovery convergence');

const net = new Net();
let inbound;
net._workerInbound = packet => { inbound = packet; };
const wall = Date.now();
net.monoOffset = 0;
net.dispatch({t:'snap',mts:wall+5000,ts:wall,p:[]});
assert.ok(Math.abs(inbound.snapT - (performance.now()+5000)) < 100,
  'zero is a valid monotonic clock offset, not an unsynchronized sentinel');
console.log('PASS monotonic timestamp conversion keeps zero offset valid');

const fallback = new Net();
const data = (x, finished = 0) => ({x,y:0,z:0,q:[0,0,0,1],v:[10,0,0],s:0,t:0,l:0,k:0,f:finished});
for (let i=0;i<80;i++) fallback.pushState(7,data(i),1000+i*30,false,1000+i*30);
const player = fallback.players.get(7);
assert.equal(player.count,64,'fallback history keeps the 64-frame budget');
assert.ok(player.T[fallback.slot(player,0)] >= player.lastT-2000,
  'fallback history stays within the two-second time window');
const sameT = player.lastT;
fallback.pushState(7,data(999,1),sameT,true,sameT);
assert.equal(player.finished,true,'same-timestamp replacement can carry finishGhost state');
console.log('PASS 64-frame fallback history and same-timestamp finish state');

const renderNet = new Net();
renderNet.renderDelay = 0;
const poseData = (x, q, vx = 0) => ({x,y:0,z:0,q,v:[vx,0,0],s:0,t:0,l:0,k:0,f:0});
renderNet.pushState(8,poseData(0,[0,0,0,1]),0,false,0);
renderNet.pushState(8,poseData(10,[0,0,1,0]),0,false,1000);
renderNet.beginFrame(500);
const mid = renderNet.renderState(8,500);
assert.ok(Math.abs(mid.pos.x-5) < 0.01,'fallback Hermite interpolation reaches the midpoint');
assert.ok(Math.abs(Math.abs(mid.quat.z)-Math.SQRT1_2) < 0.01,'fallback SLERP takes the shortest midpoint');
const extrapNet = new Net();
extrapNet.renderDelay = 0;
extrapNet.pushState(9,poseData(0,[0,0,0,1],20),0,false,0);
extrapNet.beginFrame(1000);
const extrap = extrapNet.renderState(9,1000);
assert.ok(Math.abs(extrap.pos.x-5) < 0.01,'fallback extrapolation is capped at 250ms');
console.log('PASS fallback Hermite, shortest-path SLERP and 250ms extrapolation');
console.log('remote-snapshot-check: PASS');
