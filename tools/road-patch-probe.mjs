/* Probe physical road patch seams and barrier event classification. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;
const threeSrc = fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8');
(0, eval)(threeSrc);
const ctx = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : (k === 'createLinearGradient' || k === 'createRadialGradient') ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
globalThis.document = { createElement: (tag) => tag === 'canvas' ? { width: 1, height: 1, style: {}, getContext: () => ctx, addEventListener() {}, removeEventListener() {} } : { style: {}, addEventListener() {}, removeEventListener() {} }, createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }) };
globalThis.window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };
const CANNON = await import(mod('public/libs/cannon-es.js'));
const { Track } = await import(mod('public/js/track.js'));
const { RacePhysics } = await import(mod('public/js/physics.js'));
const t = new Track(20260922, 'suzuka');
t.build();
const f = (x) => Number(x.toFixed(4));
console.log(JSON.stringify({ count:t.count, spacing:f(t.spacing), patches:t.roadHeightfields.length }, null, 2));
for (const i of [94,95,96,97,98,99,100]) {
  const p = t.pts[i];
  const y = Math.max(t.baseY[i], p.y) + 12;
  const hit = t.raycastRoad({x:p.x,y,z:p.z},{x:0,y:-1,z:0},30,y);
  console.log(JSON.stringify({ i, x:f(p.x), z:f(p.z), baseY:f(t.baseY[i]), roadY:f(p.y), hit:hit && { y:f(hit.point.y), layer:hit.layer, start:hit.patch.startIndex, distance:f(hit.distance), nx:f(hit.normal.x), ny:f(hit.normal.y), nz:f(hit.normal.z) } }));
}
const actual = [
  [918.2521, 4.7753, -447.1481],
  [918.3425, 4.9191, -447.5311],
  [916.4276, 5.4847, -450.5091],
];
for (const [x,y,z] of actual) {
  const hit = t.raycastRoad({x,y:y+12,z},{x:0,y:-1,z:0},30,y);
  const s = t.sample(x,z,97,y);
  console.log(JSON.stringify({ actual:[f(x),f(y),f(z)], sample:{i:s.i,lateral:f(s.lateral),y:f(s.y),onBridge:s.onBridge}, hit:hit && {y:f(hit.point.y),layer:hit.layer,start:hit.patch.startIndex,distance:f(hit.distance),nx:f(hit.normal.x),ny:f(hit.normal.y),nz:f(hit.normal.z)} }));
}
const rp = new RacePhysics(t);
const car = rp.addCar({id:1,startIndex:97,lateral:0});
const road = t.roadHeightfields[0].body;
const fakeRoadEvent = { body: road, target: car.body };
const before = { shell:car.shellHits||0, barrier:car.barrierHits||0, lock:car.suspLockT||0 };
rp.onBarrierCollide(car, fakeRoadEvent);
console.log(JSON.stringify({ eventProbe:{roadBarrier:road.__barrier, roadHeightfield:road.__roadHeightfield, before, after:{shell:car.shellHits||0,barrier:car.barrierHits||0,lock:car.suspLockT||0} } }));
