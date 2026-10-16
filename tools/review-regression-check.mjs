import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PeerTransport } from '../public/js/PeerTransport.js';
import { routeProgress } from '../public/js/race-position.js';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
const {Track}=await import('../public/js/track.js');
const {RacePhysics}=await import('../public/js/physics.js');
let failed=0;
async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}}
await check('rescue across the finish seam restores anchor route position',()=>{
  const track=new Track(777,'oval'),rp=new RacePhysics(track);
  const i=track.count-2, car=rp.addCar({id:1,isLocal:true,startIndex:i,lateral:0});
  car.lineCross=0;car.onAsphalt=4;car.grounded=true;car.airborne=false;
  rp.updateProgress(car,1/60);rp.updateProgress(car,1/60);
  assert.equal(car.lastLegalAnchor.lineCross,0,'legal anchor must retain route cycle');
  car.lineCross=1;car.trackIdx=2;car.body.position.copy(track.spawn(2,0).position);car.syncFromBody();
  rp.rescueToCheckpoint(car);
  assert.ok(routeProgress(car,track)<1,'rescue awarded a phantom lap');
  rp.clear();
});
await check('reverse seam crossing cannot award a lap',()=>{
  const track=new Track(777,'oval'),rp=new RacePhysics(track);
  const car=rp.addCar({id:1,isLocal:true,startIndex:0,lateral:0});
  car.lineCross=0;car.body.position.copy(track.spawn(track.count-1,0).position);car.syncFromBody();
  rp.groundConstraint(car,1/60);
  assert.ok(routeProgress(car,track)<0,'reverse crossing jumped forward almost a lap');
  rp.clear();
});
await check('P2P waits for ICE configuration before accepting an offer',async()=>{
  const handlers=new Map(),sent=[],configs=[];
  const net={url:'ws://localhost/ws',myId:1,on:(t,f)=>handlers.set(t,f),send:m=>sent.push(m),emit(){}};
  const peer=new PeerTransport(net);peer.sync({room:'1234',host:1,players:[{id:1},{id:2}]});
  let release;globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
  globalThis.RTCPeerConnection=class{
    constructor(c){configs.push(c);} createDataChannel(){return {};}
    async createOffer(){return {type:'offer',sdp:'test'};} async setLocalDescription(d){this.localDescription=d;} close(){}
  };
  const enabling=peer.enable(true);
  await peer.signal({from:2,signal:{ready:true}});
  assert.equal(configs.length,0,'peer was created with empty ICE servers during config fetch');
  release({ok:true,json:async()=>({iceServers:[{urls:'stun:example.invalid'}]})});await enabling;
  await peer.signal({from:2,signal:{ready:true}});
  assert.equal(configs[0].iceServers[0].urls,'stun:example.invalid');peer.clear();
});
await check('late negotiation failure cannot close a replacement peer',async()=>{
  const handlers=new Map();
  const net={myId:1,on:(t,f)=>handlers.set(t,f),send(){},emit(){}};
  let rejectOld;
  globalThis.RTCPeerConnection=class{
    setRemoteDescription(){return new Promise((_,reject)=>{rejectOld=reject;});}
    close(){this.closed=true;}
  };
  const peer=new PeerTransport(net);peer.enabled=true;peer.configReady=true;peer.roster=[{id:2}];
  handlers.get('rtc')({from:2,signal:{description:{type:'offer',sdp:'old'}}});
  peer.drop(2);const replacement=peer.peer(2);
  rejectOld(new Error('old negotiation aborted'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(peer.peers.get(2),replacement,'old async error deleted the new peer');peer.clear();
});
if(failed)process.exitCode=1;
