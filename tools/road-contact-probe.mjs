/* Probe raw Cannon road contacts at the reported patch seam. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)); const root=path.resolve(here,'..'); const mod=p=>pathToFileURL(path.join(root,p)).href;
const src=fs.readFileSync(path.join(root,'public/libs/three.min.js'),'utf8'); (0,eval)(src);
const ctx=new Proxy({}, {get:(_,k)=>(k==='measureText'?()=>({width:10}):(k==='createLinearGradient'||k==='createRadialGradient')?()=>({addColorStop(){}}):()=>{}),set:()=>true});
globalThis.document={createElement:t=>t==='canvas'?{width:1,height:1,style:{},getContext:()=>ctx,addEventListener(){},removeEventListener(){}}:{style:{},addEventListener(){},removeEventListener(){}},createElementNS:()=>({style:{}})};
globalThis.window={addEventListener(){},innerWidth:1600,innerHeight:900,devicePixelRatio:1};
const {Track}=await import(mod('public/js/track.js')); const {RacePhysics}=await import(mod('public/js/physics.js'));
const t=new Track(20260922,'suzuka'); t.build(); const rp=new RacePhysics(t); const c=rp.addCar({id:1,startIndex:97,lateral:0});
const frames=[[918.0208,4.6994,-446.8456,34.5,0,-41.7],[918.2521,4.7753,-447.1481,13.9,0,-18.2],[918.3425,4.9191,-447.5311,5.4,0,-8.4]];
for(const [x,y,z,vx,vy,vz] of frames){
 c.body.position.set(x,y,z); c.body.velocity.set(vx,vy,vz); c.body.angularVelocity.set(0,0,0); c.body.updateAABB(); c.body.aabbNeedsUpdate=false; rp.world.contacts.length=0;
 rp.world.step(1/60);
 console.log(JSON.stringify({at:[x,y,z],after:{x:c.body.position.x,y:c.body.position.y,z:c.body.position.z,vx:c.body.velocity.x,vy:c.body.velocity.y,vz:c.body.velocity.z},contacts:rp.world.contacts.map(e=>({a:e.bi.__carId??(e.bi.__roadHeightfield?'road':e.bi.__barrier?'barrier':'static'),b:e.bj.__carId??(e.bj.__roadHeightfield?'road':e.bj.__barrier?'barrier':'static'),nx:e.ni.x,ny:e.ni.y,nz:e.ni.z,pen:e.penetrationVec&&{x:e.penetrationVec.x,y:e.penetrationVec.y,z:e.penetrationVec.z},last:e.__lastPenetration,shapeA:e.bi.shapes?.[0]?.type,shapeB:e.bj.shapes?.[0]?.type}))}));
}
