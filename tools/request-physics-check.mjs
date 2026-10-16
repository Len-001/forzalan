import assert from 'node:assert/strict';
import fs from 'node:fs';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
const {Track}=await import('../public/js/track.js');
const {RacePhysics,CFG,SUSP}=await import('../public/js/physics.js');
const dt=1/60;
for(const type of ['suzuka','vegas','spa','oval']) {
  const track=new Track(777,type),rp=new RacePhysics(track);
  const c=rp.addCar({id:1,isLocal:true,startIndex:0,lateral:0});
  c.raceLocked=false;
  let minRide=Infinity,maxRide=-Infinity,maxNormalSpeed=0;
  // Prescribe horizontal travel, leaving suspension/vertical momentum to the
  // actual Cannon integration. This covers every ascent, crest and descent.
  const speed=50,steps=Math.ceil(track.length/speed/dt);
  for(let k=0;k<steps;k++) {
    const at=k*speed*dt/track.spacing,i=Math.floor(at)%track.count,j=(i+1)%track.count,f=at-Math.floor(at);
    const a=track.pts[i],b=track.pts[j],tan=track.tan[i];
    c.body.position.x=a.x+(b.x-a.x)*f;c.body.position.z=a.z+(b.z-a.z)*f;
    c.body.velocity.x=tan.x*speed;c.body.velocity.z=tan.z*speed;
    c.trackIdx=i;c.syncFromBody();rp.groundConstraint(c,dt);rp.world.step(dt);c.syncFromBody();rp.groundConstraint(c,dt,true);
    const ride=c.body.position.y-c.groundY,n=c.roadNormal;
    minRide=Math.min(minRide,ride);maxRide=Math.max(maxRide,ride);
    maxNormalSpeed=Math.max(maxNormalSpeed,Math.abs(c.body.velocity.x*n.x+c.body.velocity.y*n.y+c.body.velocity.z*n.z));
    assert.ok(Number.isFinite(ride),`${type} NaN suspension`);
  }
  console.log(JSON.stringify({type,minRide,maxRide,maxNormalSpeed}));
  assert.ok(minRide>0.35,`${type} chassis penetrates road`);
  assert.ok(maxRide<1.5,`${type} artificial crest launch`);
  // Deep missed contact is repaired in the post-step path before rendering.
  c.body.position.copy(track.pts[100]);c.body.position.y-=2;c.trackIdx=100;c.syncFromBody();
  rp.groundConstraint(c,dt,true);
  assert.ok(c.body.position.y-c.groundY>0.35,`${type} uphill post-step penetration`);
  rp.clear();
}
// Grass drag must not directly erase high-speed forward momentum on entry.
const t=new Track(777,'oval'),rp=new RacePhysics(t);
const c=rp.addCar({id:1,isLocal:true,startIndex:100,lateral:t.halfWidth+5});c.raceLocked=false;
c.body.velocity.set(c.fwd.x*50,c.fwd.y*50,c.fwd.z*50);c.syncFromBody();
const before=c.body.velocity.length();rp.driveLocal(c,dt);
assert.ok(Math.abs(c.body.velocity.length()-before)<.05,'grass instantly removes speed before force integration');
rp.world.step(dt);c.syncFromBody();
assert.ok(before-c.body.velocity.length()<.3,'grass entry deceleration is excessive');
console.log(`PASS grass entry: ${before.toFixed(3)} -> ${c.body.velocity.length().toFixed(3)} m/s over one step`);
rp.clear();
