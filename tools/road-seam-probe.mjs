/* Scan car-box contacts at the reported Suzuka Heightfield edge. */
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
const rp = new RacePhysics(t);
const c = rp.addCar({ id: 1, startIndex: 97, lateral: 0 });
const p = t.pts[97], side = t.side[97], tan = t.tan[97];
const yaw0 = Math.atan2(tan.x, tan.z);
const rows = [];
for (const yLevel of [0.58, 0.7, 1.0]) {
  for (const lateral of [6, 6.5, 7]) {
    for (const yawOffset of [0.3, 0.6, 1.0]) {
    c.body.position.set(p.x + side.x * lateral, t.baseY[97] + yLevel, p.z + side.z * lateral);
    c.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw0 + yawOffset);
    c.body.velocity.set(0, 0, 0);
    c.body.angularVelocity.set(0, 0, 0);
    c.body.force.set(0, 0, 0);
    c.body.torque.set(0, 0, 0);
    c.body.updateAABB();
    c.syncFromBody();
    rp.groundConstraint(c, 1 / 60);
    rp.world.step(1 / 60);
    const terrain = rp.world.contacts.filter((e) => e.bi === c.body || e.bj === c.body).map((e) => {
      const other = e.bi === c.body ? e.bj : e.bi;
      const carRel = e.bi === c.body ? e.ri : e.rj;
      const roadBody = e.bi === c.body ? e.bj : e.bi;
      const roadRel = e.bi === c.body ? e.rj : e.ri;
      const contactWorld = { x: c.body.position.x + carRel.x, y: c.body.position.y + carRel.y, z: c.body.position.z + carRel.z };
      const roadWorld = { x: roadBody.position.x + roadRel.x, y: roadBody.position.y + roadRel.y, z: roadBody.position.z + roadRel.z };
      const dx = contactWorld.x - p.x, dz = contactWorld.z - p.z;
      const rdx = roadWorld.x - p.x, rdz = roadWorld.z - p.z;
      return { road: !!other.__roadHeightfield, barrier: other.__barrier, start: other.__roadHeightfield ? t.roadHeightfields.find((q) => q.body === other)?.startIndex : undefined, nx: +e.ni.x.toFixed(3), ny: +e.ni.y.toFixed(3), nz: +e.ni.z.toFixed(3), clat: +(dx * side.x + dz * side.z).toFixed(3), calong: +(dx * tan.x + dz * tan.z).toFixed(3), rlat: +(rdx * side.x + rdz * side.z).toFixed(3), ralong: +(rdx * tan.x + rdz * tan.z).toFixed(3) };
    });
    rows.push({ yLevel, lateral, yawOffset, contacts: terrain });
    }
  }
}
const edgeCases = rows.filter((r) => r.contacts.some((x) => x.road && Math.hypot(x.nx, x.nz) > 0.2)).map((r) => ({
  yLevel: r.yLevel,
  lateral: r.lateral,
  yawOffset: r.yawOffset,
  contacts: r.contacts.length,
  nonVertical: r.contacts.filter((x) => x.road && Math.hypot(x.nx, x.nz) > 0.2).length,
  normals: [...new Set(r.contacts.filter((x) => x.road && Math.hypot(x.nx, x.nz) > 0.2).map((x) => `${x.nx},${x.ny},${x.nz}`))],
  points: r.contacts.filter((x) => x.road && Math.hypot(x.nx, x.nz) > 0.2).slice(0, 3).map((x) => [x.clat, x.calong, x.rlat, x.ralong]),
}));
console.log(JSON.stringify({
  lateralWidth: t.roadHeightfields[0].lateralWidth,
  trackHalfWidth: t.halfWidth,
  trackHalfWidthMax: t.halfWidthMax,
  curbWidth: t.curbWidth,
  index97: { halfWidth: t.halfWidthAt?.[97], curbMask: t.curbMask?.[97], offsets: [5.5, 6, 6.5, 7].map((x) => [x, +t.groundOffset(x, 97).toFixed(3)]) },
  roadContacts: rows.reduce((n, r) => n + r.contacts.filter((x) => x.road).length, 0),
  nonVerticalCases: edgeCases.length,
  edgeCases,
  contactCases: rows.filter((r) => r.contacts.length).length,
  cases: rows.length,
}));
