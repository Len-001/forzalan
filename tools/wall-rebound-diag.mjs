import fs from 'node:fs';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
globalThis.document={createElement:()=>({style:{},getContext:()=>new Proxy({},{get:()=>()=>({addColorStop(){}})})})};
globalThis.window={devicePixelRatio:1,addEventListener(){}};
const {Track}=await import('../public/js/track.js');
const {RacePhysics}=await import('../public/js/physics.js');
const trk=new Track(4242,'spa');trk.build();const q=new RacePhysics(trk);q.racing=true;
const c=q.addCar({id:1,name:'D',color:'#fff',isLocal:true,startIndex:300,lateral:0,laps:99});
const hard=process.argv.includes('--hard');
const t=trk.tan[300],s=trk.side[300];c.body.velocity.set(s.x*(hard?30:4)+t.x*(hard?35:40),0,s.z*(hard?30:4)+t.z*(hard?35:40));
let hits=0, max=0, actualMax=0;
for(let i=0;i<(hard?150:120);i++){c.input.throttle=hard?.4:.5;q.fixedStep(1/60);const cross=c.vel.x*s.x+c.vel.z*s.z;let equations=0,normal=0;for(const eq of q.world.contacts){const hit=q.barrierContactNormal(eq);if(hit&&hit.carBody===c.body){equations++;normal=Math.max(normal,c.vel.x*hit.nx+c.vel.z*hit.nz);}}
actualMax=Math.max(actualMax,normal);
if(equations)hits++;max=Math.max(max,-cross);if(i%20===0||equations)console.log(JSON.stringify({i,index:c.trackIdx,wallEquations:equations,barrierHits:c.barrierHits,cross,normal,pos:[c.pos.x,c.pos.z]}));}
console.log(JSON.stringify({hard,contactFrames:hits,apparentRebound:max,actualContactRebound:actualMax}));
