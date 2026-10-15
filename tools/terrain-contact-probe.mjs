/* Replays one raw Suzuka terrain-contact step with the full fixedStep path. */
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
const report = JSON.parse(fs.readFileSync(path.join(root, 'jitter-raw-report.json'), 'utf8'));
const byStep = new Map();
for (const row of report.frames) if (!byStep.has(row[7])) byStep.set(row[7], row);
const replayRow = report.frames.find((row) => row[9] === 0 && row[10] === 0 && Number.isInteger(row[7]) && byStep.has(row[7] - 1) && byStep.has(row[7] + 1));
const step = replayRow?.[7];
if (!Number.isInteger(step)) throw new Error('no raw on-road fixed step found');
const prev = byStep.get(step), next = byStep.get(step + 1), prior = byStep.get(step - 1);
if (!prev || !next || !prior) throw new Error('raw replay step window is incomplete');
const t = new Track(20260922, 'suzuka');
t.build();
const rp = new RacePhysics(t);
rp.racing = true;
const c = rp.addCar({ id: 1, name: 'raw-replay', color: '#fff', isLocal: true, startIndex: prev[13], laps: 5 });
c.body.position.set(prev[3], prev[4], prev[5]);
c.body.quaternion.set(prev[15], prev[16], prev[17], prev[18]);
c.body.velocity.set((prev[3] - prior[3]) * 60, (prev[4] - prior[4]) * 60, (prev[5] - prior[5]) * 60);
c.body.angularVelocity.set(0, 0, 0);
c.body.updateAABB();
c.input.throttle = 1;
c.input.steer = 0;
c.input.brake = 0;
c.syncFromBody();
const before = { v: [c.body.velocity.x, c.body.velocity.y, c.body.velocity.z], pos: [c.body.position.x, c.body.position.y, c.body.position.z] };
const probePairs1 = [], probePairs2 = [];
rp.world.broadphase.collisionPairs(rp.world, probePairs1, probePairs2);
const candidateRoads = probePairs1.map((body, i) => [body, probePairs2[i]]).filter(([a, b]) => a === c.body || b === c.body).map(([, other]) => ({ road: !!other.__roadHeightfield, barrier: other.__barrier, id: other.id }));
const perPatch = [];
for (const patch of t.roadHeightfields) {
  if (patch.body.aabb.upperBound.x < c.body.position.x || patch.body.aabb.lowerBound.x > c.body.position.x || patch.body.aabb.upperBound.z < c.body.position.z || patch.body.aabb.lowerBound.z > c.body.position.z) continue;
  const ray = new CANNON.Ray(new CANNON.Vec3(c.body.position.x, c.body.position.y + 8, c.body.position.z), new CANNON.Vec3(c.body.position.x, c.body.position.y - 8, c.body.position.z));
  ray.mode = CANNON.Ray.CLOSEST;
  ray.checkCollisionResponse = false;
  const result = new CANNON.RaycastResult();
  ray.intersectBody(patch.body, result);
  if (result.hasHit) perPatch.push({ start: patch.startIndex, layer: patch.layer, y: +result.hitPointWorld.y.toFixed(3), nx: +result.hitNormalWorld.x.toFixed(3), ny: +result.hitNormalWorld.y.toFixed(3), nz: +result.hitNormalWorld.z.toFixed(3) });
}
rp.fixedStep(1 / 60);
if (!perPatch.length) throw new Error('road raycast found no intersecting Heightfield patch');
if (!(c.grounded && c.roadRayHits > 0 && Number.isFinite(c.groundY))) {
  throw new Error(`four-wheel road support missing: grounded=${c.grounded} roadRayHits=${c.roadRayHits} groundY=${c.groundY}`);
}
const contacts = rp.world.contacts.filter((e) => e.bi === c.body || e.bj === c.body).map((e) => {
  const other = e.bi === c.body ? e.bj : e.bi;
  return { road: !!other.__roadHeightfield, barrier: other.__barrier, n: [Number(e.ni.x.toFixed(3)), Number(e.ni.y.toFixed(3)), Number(e.ni.z.toFixed(3))] };
});
if (contacts.some((x) => x.road)) throw new Error('query-only road unexpectedly entered Cannon contacts');
console.log(JSON.stringify({ step, nextStep: step + 1, rawIndex: prev[13], before, candidateRoads, perPatch, after: { v: [c.body.velocity.x, c.body.velocity.y, c.body.velocity.z], pos: [c.body.position.x, c.body.position.y, c.body.position.z], roadRayHits: c.roadRayHits, groundY: c.groundY, airborne: c.airborne, surface: c.surface }, contacts, roadContacts: contacts.filter((x) => x.road).length, roadSupport: { grounded: c.grounded, roadRayHits: c.roadRayHits, groundY: c.groundY } }));
