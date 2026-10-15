/* Dynamics acceptance checks for the road, AI, network proxy, and slipstream. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

const threeSrc = fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8');
(0, eval)(threeSrc);
if (!globalThis.THREE) throw new Error('three injection failed');
if (!globalThis.document) {
  const ctx = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 10 }) : () => {}, set: () => true });
  globalThis.document = {
    createElement: (tag) => tag === 'canvas'
      ? { width: 1, height: 1, style: {}, getContext: () => ctx, addEventListener() {}, removeEventListener() {} }
      : { style: {}, addEventListener() {}, removeEventListener() {} },
    createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }),
  };
}
if (!globalThis.window) globalThis.window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };

const CANNON = await import(mod('public/libs/cannon-es.js'));
const { Track, TRACK_CFG } = await import(mod('public/js/track.js'));
const { RacePhysics, CFG } = await import(mod('public/js/physics.js'));

const track = new Track(20260922, 'suzuka');
assert.ok(track.roadHeightfields?.length > 0, 'track exposes physical road heightfield patches');
for (const patch of track.roadHeightfields) {
  assert.ok(patch.shape instanceof CANNON.Heightfield, 'road patch uses Cannon Heightfield');
  assert.ok(patch.shape.data.length >= 5 && patch.shape.data[0].length >= 5, 'road patch is high resolution');
}

assert.equal(CFG.SLIP_CONE, 12, 'slipstream cone is ±12 degrees');
assert.equal(CFG.SLIP_MIN, 3, 'slipstream minimum distance');
assert.equal(CFG.SLIP_MAX, 25, 'slipstream maximum distance');
assert.ok(CFG.SLIP_DOWNFORCE_CUT >= 0.25 && CFG.SLIP_DOWNFORCE_CUT <= 0.35, 'slipstream reduces downforce by 25–35%');
assert.ok(CFG.RESTITUTION >= 0.05 && CFG.RESTITUTION <= 0.1, 'restitution is in the specified range');

const bridgeIndex = track.bridge.active ? Math.floor((track.bridge.i0 + track.bridge.i1) / 2) % track.count : 0;
const bridgePoint = track.pts[bridgeIndex];
const bridgeHit = track.raycastRoad(
  { x: bridgePoint.x, y: bridgePoint.y + 20, z: bridgePoint.z },
  { x: 0, y: -1, z: 0 },
  40,
  bridgePoint.y,
);
assert.ok(bridgeHit && bridgeHit.layer === 'bridge', 'downward ray selects the bridge layer');
assert.ok(Number.isFinite(bridgeHit.distance) && bridgeHit.distance > 0, 'bridge ray has a physical hit distance');
const lowHit = track.raycastRoad(
  { x: bridgePoint.x, y: track.baseY[bridgeIndex] + 20, z: bridgePoint.z },
  { x: 0, y: -1, z: 0 },
  40,
  track.baseY[bridgeIndex],
);
assert.ok(lowHit && lowHit.layer === 'ground', 'downward ray selects the ground layer');
assert.ok(Math.abs(lowHit.point.y - track.baseY[bridgeIndex]) < 2, 'ground ray does not tunnel through the lower layer');
const bridgeUpHit = track.raycastRoad(
  { x: bridgePoint.x, y: bridgePoint.y - 5, z: bridgePoint.z },
  { x: 0, y: 1, z: 0 },
  20,
  bridgePoint.y,
);
assert.ok(bridgeUpHit && bridgeUpHit.layer === 'bridge', 'upward ray also resolves the bridge layer without tunneling');

assert.ok(track.timingLine?.point && track.timingLine?.tangent, 'track exposes timing line metadata');
assert.ok(track.timingLine.officialValid || (track.timingLine.approachDistance >= 80 && track.timingLine.approachDistance <= 120), 'timing line is official when valid or 80–120m from a corner');
assert.equal(track.checkpoints[0].sample, track.timingLine.sample, 'checkpoint zero follows the selected timing line');
assert.equal(track.checkpointIndexAt(track.timingLine.sample), 0, 'timing line starts checkpoint sequence');

const registeredRoads = track.roadHeightfields.filter((patch) => patch.body.__roadHeightfield || !patch.body.__barrier);
assert.ok(registeredRoads.length > 0, 'track retains physical road bodies for world registration');

const rp = new RacePhysics(track);
assert.ok(rp.staticBodies.some((body) => body.__roadHeightfield), 'RacePhysics registers road Heightfields into Cannon');
const remote = rp.addCar({ id: 2, remote: true, startIndex: bridgeIndex, lateral: 0 });
assert.equal(remote.body.type, CANNON.Body.KINEMATIC, 'remote car is a true Cannon kinematic body');
assert.ok((remote.body.collisionFilterMask & CFG.GROUP_CAR_MASK) !== 0, 'remote proxy keeps close-contact car collision mask');
rp.applyRemoteTarget(2, { x: bridgePoint.x, y: bridgePoint.y + 1, z: bridgePoint.z }, { x: 0, y: 0, z: 0, w: 1 }, { x: 12, y: 0, z: 0 });
rp.fixedStep(1 / 60);
assert.ok(Number.isFinite(remote.body.position.x) && Number.isFinite(remote.body.position.y), 'remote kinematic step remains finite');
assert.ok(Math.abs(remote.body.velocity.x - 12) < 0.01, 'remote proxy publishes target velocity for contact solving');

const contactCar = rp.addCar({ id: 1, startIndex: bridgeIndex, lateral: 0 });
rp.applyRemoteTarget(2, { x: contactCar.body.position.x, y: contactCar.body.position.y, z: contactCar.body.position.z }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 });
rp.fixedStep(1 / 60);
assert.ok(remote.collideHits > 0 || contactCar.collideHits > 0, 'kinematic remote has a real close-contact collision');

const stableRp = new RacePhysics(track);
const stable = stableRp.addCar({ id: 1, startIndex: bridgeIndex, lateral: 0 });
for (let i = 0; i < 60; i++) {
  stableRp.fixedStep(1 / 60);
  assert.ok(Number.isFinite(stable.body.position.x) && Number.isFinite(stable.body.position.y) && Number.isFinite(stable.body.position.z), 'dynamic bridge run stays finite');
  assert.ok(Number.isFinite(stable.body.velocity.y), 'dynamic bridge velocity stays finite');
  assert.ok(stable.body.position.y >= stable.groundY - 0.5, 'dynamic car does not tunnel below the selected road layer');
}
assert.ok(stable.roadRayHits >= 3, 'four-wheel suspension receives physical road hits');
assert.ok(Math.abs(stable.body.position.y - stable.groundY) < 3, 'dynamic car remains near the selected road layer');

const lead = remote;
const tail = contactCar;
lead.pos.set(0, 0, 0);
tail.pos.set(0, 0, -10);
lead.fwd.set(0, 0, 1);
tail.fwd.set(0, 0, 1);
lead.speedKmh = 100;
tail.speedKmh = 95;
rp.refreshSlipstream();
assert.ok(tail.slip > 0, 'rear cone grants slipstream inside ±12 degrees and 3–25m');
const inConeSlip = tail.slip;
tail.pos.set(3.1, 0, -10);
rp.refreshSlipstream();
assert.equal(tail.slip, 0, 'rear cone rejects a follower outside ±12 degrees');
tail.pos.set(0, 0, -25.1);
rp.refreshSlipstream();
assert.equal(tail.slip, 0, 'rear cone rejects a follower beyond 25m');
tail.pos.set(0, 0, -10);
tail.body.velocity.set(0, 0, 30);
tail.roadNormal = new THREE.Vector3(0, 1, 0);
tail.airborne = false;
tail.input.throttle = 0;
tail.input.brake = 0;
tail.slip = inConeSlip;
rp.driveLocal(tail, 1 / 60);
const dirtyAirDownforce = tail.downforce;
tail.body.velocity.set(0, 0, 30);
tail.slip = 0;
rp.driveLocal(tail, 1 / 60);
assert.ok(dirtyAirDownforce < tail.downforce, 'dirty air reduces actual downforce on the follower');
assert.ok(dirtyAirDownforce / tail.downforce >= 0.65 && dirtyAirDownforce / tail.downforce <= 0.75, 'dirty air downforce reduction is 25–35% at full strength');

const aiState = { throttle: 0, brake: 0 };
const coasting = rp.computeAISpeedControl(100, 101, 1 / 60, aiState);
assert.equal(coasting.throttle, 0, 'AI ±2km/h deadband coasts throttle');
assert.equal(coasting.brake, 0, 'AI ±2km/h deadband coasts brake');
const firstDrive = rp.computeAISpeedControl(100, 160, 1 / 60, aiState);
const secondDrive = rp.computeAISpeedControl(100, 160, 1 / 60, firstDrive);
assert.ok(firstDrive.throttle > 0 && firstDrive.brake === 0, 'AI accelerates smoothly outside the deadband');
assert.ok(secondDrive.throttle - firstDrive.throttle <= 0.08, 'AI throttle slew is smooth');

console.log('dynamics-spec-check: PASS');
