import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
(0, eval)(fs.readFileSync(path.join(root, 'public/libs/three.min.js'), 'utf8'));
class FakeWorker { messages = []; postMessage(message) { this.messages.push(message); } terminate() {} }
globalThis.Worker = FakeWorker;
const { PhysicsWorkerBridge } = await import('../public/js/PhysicsWorkerBridge.js');
const { buildStateArray } = await import('../public/js/physics-protocol.js');
const mainSource = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'public/js/physics.worker.js'), 'utf8');
const track = { seed: 42, trackType: 'suzuka', colliders: [], gridSlot: slot => ({ index: 100 - slot, lateral: slot }),
  spawn: (index, lateral) => ({ position: new THREE.Vector3(index, 0, lateral), quaternion: new THREE.Quaternion() }) };
const roster = [{ id: 1, name: 'Host', ai: false }, { id: 2, name: 'Guest', ai: false }, { id: 3, name: 'AI', ai: true }];
const b = new PhysicsWorkerBridge({ track, localId: 2, hostId: 1, grid: { 1: 3, 2: 1, 3: 2 }, roster, laps: 3 });
const init = b.worker.messages[0];
const spawnSource = mainSource.slice(mainSource.indexOf('function spawnCar('), mainSource.indexOf('\nfunction beginRace('));
const spawnCar = vm.runInNewContext('(' + spawnSource + ')', {
  S: { rp: b, laps: 3, localId: 2, hostId: 1, offline: false }, track, THREE, scene: { add() {} }, carVisuals: new Map(),
  buildCarVisual: () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }),
});
spawnCar(roster[0], false, false, 3); spawnCar(roster[1], true, false, 1); spawnCar(roster[2], false, true, 2);
b._message({ type: 'ready' });
await Promise.resolve();
assert.equal(b.worker.messages.filter(m => m.type === 'addCar').length, 0, 'initial roster creates each car once');
assert.equal(init.roster[0].remote, true, 'other human is network-owned');
assert.equal(init.roster[1].isLocal, true, 'local human is marked in Worker');
assert.equal(init.roster[1].startIndex, track.gridSlot(1).index, 'server grid overrides seat ID');
assert.equal(init.roster[2].remote, true, 'guest AI is network-owned');
assert.equal(b.byId.get(3).remote, true, 'guest mirror agrees with Worker');
assert.equal(b.byId.get(3).auto, false, 'guest does not drive AI');
console.log('PASS actual spawn path: single initialization, local/remote flags, server grid, host-owned AI');

const packets = [];
b.onNetwork = p => packets.push(p);
b._publishNetwork(100);
assert.deepEqual(packets.map(p => p.id), [2], 'guest publishes its own human only');
b.setHost(2); await Promise.resolve();
assert.equal(b.byId.get(3).remote, false);
assert.equal(b.worker.messages.findLast(m => m.type === 'aiHost').local, true);
b._publishNetwork(150);
assert.deepEqual(packets.slice(1).map(p => p.id), [2, 3], 'new host publishes AI too');
b.setHost(1); await Promise.resolve();
assert.equal(b.byId.get(3).remote, true);
console.log('PASS host handoff changes AI publication without changing human ownership');

globalThis.document = { createElement: () => ({ style: {}, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }), toDataURL: () => 'data:,' }),
  getElementById: () => null, querySelector: () => null, body: { appendChild() {} } };
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
const { Track } = await import('../public/js/track.js');
const { RacePhysics, CFG } = await import('../public/js/physics.js');
const rp = new RacePhysics(new Track(42, 'suzuka')); rp.racing = true; rp.time = 200;
const physicalCar = rp.addCar({ id: 2, isLocal: true, startIndex: 0, lateral: 0, laps: 3 });
const bot = rp.addCar({ id: 3, ai: true, remote: true, startIndex: 20, lateral: 0, laps: 3 });
Object.assign(bot, { lap: 1, cpIdx: 7, progress: 7, crossedStart: true, lapTimeLive: 12, bestLap: 90, penalty: 1, lapInvalid: true });
const botPos = bot.pos.clone();
rp.setAIAuthority(true);
assert.equal(bot.remote, false); assert.equal(bot.auto, true); assert.equal(bot.body.mass, CFG.MASS);
assert.equal(bot.lapStart, 188); assert.equal(bot.cpIdx, 7); assert.equal(bot.progress, 7); assert.equal(bot.lapInvalid, true);
assert.ok(bot.pos.equals(botPos));
rp.setAIAuthority(false);
assert.equal(bot.remote, true); assert.equal(bot.auto, false); assert.equal(bot.body.mass, 0);
console.log('PASS physical AI handoff preserves pose, lap timer, checkpoints and penalties');

const carPayloadSource = workerSource.slice(workerSource.indexOf('function carPayload('), workerSource.indexOf('\nfunction event('));
const carPayload = vm.runInNewContext('(' + carPayloadSource + ')');
const callbacksSource = workerSource.slice(workerSource.indexOf('function configureCallbacks()'), workerSource.indexOf('\n// 仅按需测量'));
const captured = [];
const configure = vm.runInNewContext('(' + callbacksSource + ')', { rp, carPayload, num: v => v, event: (name, payload) => captured.push({ name, payload }) });
configure();
for (const reason of ['frr_gain', 'shortcut']) physicalCar.addPenalty(1, reason);
assert.deepEqual(captured.map(e => e.payload.reason), ['frr_gain', 'shortcut']);
assert.equal(physicalCar.lapInvalid, true);
b._applyEvent(captured[0].name, captured[0].payload);
assert.equal(b.byId.get(2).lapInvalid, true, 'Worker penalty event updates mirror');
physicalCar.lapInvalid = false; physicalCar.lap = 1;
b._applyRecord(buildStateArray([physicalCar]), 0);
assert.equal(b.byId.get(2).lapInvalid, false, 'new lap clears HUD mark from Worker state');
console.log('PASS complete penalty reason IDs and Worker-owned invalid-lap state');

b.handleNetworkPacket({ kind: 'snap', snapT: 300, packet: { p: [{ id: 3, d: { x: 1, q: [0, 0, 0, 1], l: 1, c: 7,
  lt: 12, bl: 90, bc: 90, pen: 1, vio: 1, li: 1, pr: 7, cs: 1, lc: 2, ll: 90, ft: 0, tt: 0 } }] } });
await Promise.resolve();
const a = new Float32Array(b.worker.messages.findLast(m => m.type === 'remoteSamples').buffer);
assert.deepEqual(Array.from(a.slice(21, 32)), [7, 12, 90, 90, 1, 1, 1, 7, 1, 2, 90], 'AI progress survives typed transport');
b.dispose(); rp.clear();
const avoidanceTrack = new Track(4242, 'spa'), avoidance = new RacePhysics(avoidanceTrack);
avoidance.racing = true;
const grid = avoidanceTrack.gridSlot(1);
const driver = avoidance.addCar({ id: 1, ai: true, startIndex: grid.index, lateral: grid.lateral, laps: 1 });
driver.auto = true;
const blocker = avoidance.addCar({ id: 2, startIndex: grid.index, lateral: grid.lateral, laps: 1 });
blocker.retired = true;
blocker.pos.copy(driver.pos).addScaledVector(driver.fwd, 16);
blocker.body.position.set(blocker.pos.x, blocker.pos.y, blocker.pos.z);
const origin = driver.pos.clone();
for (let i = 0; i < 150; i++) avoidance.step(1 / 60);
assert.ok(driver.pos.distanceTo(origin) > 3, 'AI keeps moving before a retired blocker');
assert.ok(driver.pos.distanceTo(blocker.pos) > 8, 'AI brakes before contacting a retired blocker');
avoidance.clear();
console.log('PASS stopped retired cars remain visible to AI avoidance');
console.log('bug-regression-check: PASS');
