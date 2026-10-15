import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Track,roundStreetCorners} from '../public/js/track.js';
import {VEGAS_GEOMETRY} from '../public/js/vegas-geometry.js';
import {SPA_GEOMETRY} from '../public/js/spa-geometry.js';
import {SUZUKA_GEOMETRY} from '../public/js/suzuka-geometry.js';
(0,eval)(fs.readFileSync(new URL('../public/libs/three.min.js',import.meta.url),'utf8'));
for(const [type,g,src] of [['vegas',VEGAS_GEOMETRY,'data/vegas-full.osm'],['spa',SPA_GEOMETRY,'data/spa-full.osm'],['suzuka',SUZUKA_GEOMETRY,'suzuka-osm-source.xml']]) {
 const xml=fs.readFileSync(new URL(src,import.meta.url),'utf8'), nodes=new Map();
 for(const m of xml.matchAll(/<node id="(\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g))nodes.set(m[1],[+m[2],+m[3]]);
 const mx=111320*Math.cos(g.center[0]*Math.PI/180),mz=110540;
 const xy=id=>{const v=nodes.get(id);return v?[(v[1]-g.center[1])*mx,(v[0]-g.center[0])*mz]:null};
 const t=new Track(4242,type); assert.ok(Math.hypot(t.pts[0].x-g.pts[0][0],t.pts[0].z-g.pts[0][1])<1e-6);
 let anchorError=null,anchorLatLon=null;
 if(g.startAnchorNodeId){const p=xy(g.startAnchorNodeId);anchorLatLon=nodes.get(g.startAnchorNodeId);anchorError=Math.hypot(t.pts[0].x-p[0],t.pts[0].z-p[1]);assert.ok(anchorError<0.1);assert.match(xml,new RegExp('<member type="node" ref="'+g.startAnchorNodeId+'" role="start"'));}
 else {anchorLatLon=[g.center[0]+g.pts[0][1]/mz,g.center[1]+g.pts[0][0]/mx];}
 let forward=0,reverse=0;
 const rel=xml.match(new RegExp('<relation id="'+({'vegas':'16696508','spa':'284560','suzuka':'284570'}[type])+'"[^>]*>([\\s\\S]*?)</relation>'))?.[1];
 assert.ok(rel,'source relation must exist');
 const members=new Set([...rel.matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"/g)].filter(m=>m[2]!=='pit_lane').map(m=>m[1]));
 for(const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
  if(!members.has(m[1]))continue;const ow=m[2].match(/<tag k="oneway" v="([^"]+)"/)?.[1];const dir=/^(yes|true|1)$/.test(ow)?1:/^(-1|reverse)$/.test(ow)?-1:0;if(!dir)continue;
  const refs=[...m[2].matchAll(/<nd ref="(\d+)"/g)].map(m=>m[1]);
  for(let k=1;k<refs.length;k++) {const a=xy(refs[k-1]),b=xy(refs[k]);if(!a||!b)continue; const l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(l<0.5)continue;
   const x=(a[0]+b[0])/2,z=(a[1]+b[1])/2;let best=Infinity,dot=0;
   for(let i=0;i<t.count;i++){const p=t.pts[i],q=t.pts[(i+1)%t.count],dx=q.x-p.x,dz=q.z-p.z,ll=dx*dx+dz*dz,u=Math.max(0,Math.min(1,((x-p.x)*dx+(z-p.z)*dz)/ll));const d=Math.hypot(x-p.x-u*dx,z-p.z-u*dz);if(d<best){best=d;dot=((b[0]-a[0])*dx+(b[1]-a[1])*dz)*dir/l/Math.sqrt(ll);}}
   if(best<10){if(dot>0.7)forward+=l;else if(dot< -0.7)reverse+=l;}
  }
 }
 console.log(JSON.stringify({type,anchorLatLon,anchorError,forwardMeters:+forward.toFixed(2),reverseMeters:+reverse.toFixed(2),officialFinishVerified:false}));
 assert.ok(forward>reverse*4,type+' must agree with source oneway direction');
}
const rounded=roundStreetCorners([[0,0],[100,0],[100,100],[0,100]],20);
assert.deepEqual(rounded[0],[0,0]);
// A 90-degree fillet must lie on the radius-20 circle, not a diagonal bridge.
assert.ok(rounded.some(([x,z])=>Math.abs(x-(80+20/Math.sqrt(2)))<0.15&&Math.abs(z-(20-20/Math.sqrt(2)))<0.15));
console.log('PASS anchors, source driving directions and circular street corner');
