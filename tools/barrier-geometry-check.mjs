import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Track } from '../public/js/track.js';
(0, eval)(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
const types = (process.env.TRACKS || 'suzuka,vegas,spa').split(',');
function local(c, p) {
  const q = new THREE.Quaternion(c.qx || 0, c.qy || 0, c.qz || 0, c.qw ?? 1).invert();
  return new THREE.Vector3(p.x-c.x,p.y-c.y,p.z-c.z).applyQuaternion(q);
}
function inside(c,p,tol=0) { const v=local(c,p); return Math.abs(v.x)<=c.hx+tol && Math.abs(v.y)<=c.hy+tol && Math.abs(v.z)<=c.hz+tol; }
for(const type of types) {
  const t=new Track(4242,type); t.colliders=[]; const group=new THREE.Group(); t._buildBarriers(group);
  const boxes=t.colliders;
  const grid=new Map(), cell=12;
  for(const c of boxes) {
    const r=Math.hypot(c.hx,c.hz);
    for(let x=Math.floor((c.x-r)/cell); x<=Math.floor((c.x+r)/cell);x++) for(let z=Math.floor((c.z-r)/cell);z<=Math.floor((c.z+r)/cell);z++) {
      const k=x+','+z; if(!grid.has(k))grid.set(k,[]);grid.get(k).push(c);
    }
  }
  const candidates=p=>grid.get(Math.floor(p.x/cell)+','+Math.floor(p.z/cell))||[];
  let missing=0,checked=0,invasion=0;const misses=[],hits=[];
  for(let i=0;i<t.count;i++) {
    const j=(i+1)%t.count, a=t.pts[i], b=t.pts[j];
    const li=t.barrierLatArr?.[i] || t.barrierLat || t.halfWidth+t.curbWidth+0.75;
    const lj=t.barrierLatArr?.[j] || t.barrierLat || t.halfWidth+t.curbWidth+0.75;
    for(const d of [1,-1]) {
      if(t.barrierSideAt && !t.barrierSideAt[i*2+(d>0?1:0)]) continue;
      const x0=a.x+t.side[i].x*d*li,z0=a.z+t.side[i].z*d*li;
      const x1=b.x+t.side[j].x*d*lj,z1=b.z+t.side[j].z*d*lj;
      const steps=Math.max(1,Math.ceil(Math.hypot(x1-x0,z1-z0)/0.5));
      for(let k=0;k<=steps;k++) {
        const u=k/steps;
        const sx=t.side[i].x*(1-u)+t.side[j].x*u, sz=t.side[i].z*(1-u)+t.side[j].z*u;
        const sl=Math.hypot(sx,sz)||1, liu=li*(1-u)+lj*u;
        const p={x:a.x+(b.x-a.x)*u+sx/sl*d*liu,y:a.y+(b.y-a.y)*u+0.4,z:a.z+(b.z-a.z)*u+sz/sl*d*liu}; checked++;
        if(!candidates(p).some(c=>inside(c,p,0.06))) { missing++;if(misses.length<5)misses.push({i,d,u}); }
      }
    }
    // Sample the actual asphalt ribbon, including its edges, at <=1m intervals.
    const steps=Math.max(1,Math.ceil(a.distanceTo(b)));
    for(let k=0;k<=steps;k++) for(let lateral=-1;lateral<=1.001;lateral+=0.1) {
      const u=k/steps,wa=t.halfWidthAt[i]-0.05,wb=t.halfWidthAt[j]-0.05;
      const p={x:a.x+(b.x-a.x)*u+lateral*(t.side[i].x*wa*(1-u)+t.side[j].x*wb*u),y:a.y+(b.y-a.y)*u+0.1,z:a.z+(b.z-a.z)*u+lateral*(t.side[i].z*wa*(1-u)+t.side[j].z*wb*u)};
      if(candidates(p).some(c=>inside(c,p))) {invasion++;if(hits.length<5)hits.push({i,u,lateral});}
    }
  }
  console.log(JSON.stringify({type,boxes:boxes.length,checked,missing,invasion,misses,hits}));
  assert.equal(missing,0,type+' real offset segments must be covered');
  assert.equal(invasion,0,type+' barrier must not intrude into asphalt');
}
