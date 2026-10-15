import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Track } from '../public/js/track.js';
(0, eval)(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
globalThis.document = {
  createElement: (tag) => tag === 'canvas'
    ? { getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) }
    : { style: {} },
};

const types = (process.env.TRACKS || 'suzuka,vegas,spa').split(',').map((s) => s.trim()).filter(Boolean);
let total = 0;
for (const type of types) {
  const track = new Track(4242, type);
  track.build();
  const walls = (track.colliders || []).filter((c) => c.barrierMain);
  assert(walls.length > 0, type + ' must have main barrier colliders');
  let slopeCount = 0;
  let maxAxisError = 0;
  let maxYawError = 0;
  for (const c of walls) {
    const q = new THREE.Quaternion(c.qx, c.qy, c.qz, c.qw).normalize();
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const expectedY = c.barrierExpectedAxisY;
    maxAxisError = Math.max(maxAxisError, Math.abs(z.y - expectedY));
    const yaw = Math.atan2(z.x, z.z);
    const yawExpected = c.barrierExpectedYaw;
    let dyaw = Math.abs(yaw - yawExpected) % (Math.PI * 2);
    if (dyaw > Math.PI) dyaw = Math.PI * 2 - dyaw;
    maxYawError = Math.max(maxYawError, dyaw);
    if (Math.abs(expectedY) > 1e-4) slopeCount++;
  }
  assert(maxAxisError < 1e-6, type + ' barrier pitch must match its 3D endpoints');
  assert(maxYawError < 1e-6, type + ' barrier yaw must match its tangent');
  console.log(JSON.stringify({ type, walls: walls.length, slopeCount, maxAxisError, maxYawError }));
  total += walls.length;
}
console.log('PASS barrier slope continuity: ' + total + ' main colliders');
