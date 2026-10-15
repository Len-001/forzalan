/* Ghost reason regression: lap/progress causes plus physical wall/ground contact. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8'));
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0, style: {},
    getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }),
    toDataURL: () => 'data:',
  }),
  getElementById: () => null,
  querySelector: () => null,
  body: { appendChild() {} },
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };

const { Track } = await import('../public/js/track.js');
const { RacePhysics, CFG } = await import('../public/js/physics.js');
let fail = 0;
const ok = (value, name, detail = '') => {
  if (value) console.log('  PASS ' + name + (detail ? '   ' + detail : ''));
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

function setup(count = 1) {
  const track = new Track(4242, 'suzuka');
  const rp = new RacePhysics(track);
  rp.racing = true;
  const cars = [];
  for (let i = 0; i < count; i++) {
    cars.push(rp.addCar({ id: i + 1, name: 'c' + (i + 1), startIndex: 100, lateral: i * 3, laps: 3 }));
  }
  return { track, rp, cars };
}

// A full completed lap ahead of a car at the same real track index is a lap gap.
{
  const { rp, cars } = setup(2);
  const [lead, back] = cars;
  lead.lap = 1;
  lead.trackIdx = back.trackIdx = 100;
  rp.updateRaceGhosting();
  ok(back.lappedGhost === true && back.lappedBy === lead.id && back.ghostReasonCode === 1,
    '真实圈数/赛道索引触发被套圈原因 1',
    `gap=${(back.progressScore - lead.progressScore).toFixed(0)} reason=${back.ghostReasonCode}`);
  ok((back.body.collisionFilterMask & CFG.GROUP_CAR_MASK) === 0,
    '被套圈幽灵只剔除车组碰撞');
  ok((back.body.collisionFilterMask & CFG.GROUP_BARRIER) !== 0 && back.body.collisionResponse === true,
    '被套圈幽灵仍保留护栏/地面物理响应');
}

// A car must have an initialized checkpoint/progress record before reverse speed counts.
{
  const { track, rp, cars } = setup();
  const car = cars[0];
  car.trackIdx = 0;
  car.cpIdx = track.checkpointIndexAt(car.trackIdx);
  car.crossedStart = true;
  const tan = track.tan[car.trackIdx];
  car.vel.set(-tan.x * 10, 0, -tan.z * 10);
  car.speed = 10;
  car.speedKmh = 36;
  rp.updateProgress(car, 1.0);
  rp.updateRaceGhosting();
  ok(car.wrongWay === true && car.wrongWayGhost === true && car.ghostReasonCode === 2,
    '真实计圈簿已建立后触发逆行原因 2',
    `wrongWayT=${car.wrongWayT.toFixed(2)} reason=${car.ghostReasonCode}`);
}

// Existing collision-triggered automatic recovery keeps reason 3.
{
  const { rp, cars } = setup();
  const car = cars[0];
  car.recentHits = 2;
  car.recentHitsT = 0;
  rp.updateAutoGhost(car, 1 / 60);
  ok(car.ghostReasonCode === 3 && car.ghostTimer > 0,
    '多次碰撞自动回正触发失控原因 3',
    `timer=${car.ghostTimer.toFixed(2)} reason=${car.ghostReasonCode}`);
}

// Rescue and finish are explicit state transitions with stable protocol reasons.
{
  const { rp, cars } = setup();
  const car = cars[0];
  rp.rescueToCheckpoint(car, true);
  ok(car.ghostReasonCode === 4 && car.ghostTimer > 0,
    '复位保护触发原因 4',
    `timer=${car.ghostTimer.toFixed(2)} reason=${car.ghostReasonCode}`);
  rp.finishCar(car);
  ok(car.ghostReasonCode === 5 && car.finishGhost === true,
    '完赛幽灵触发原因 5', `reason=${car.ghostReasonCode}`);
}

// All 12 allocated car bits must be covered by every car-only ghost path.
{
  const { rp, cars } = setup(12);
  const carMask = CFG.GROUP_CAR_MASK;
  const expectedMask = ((1 << 12) - 1) << CFG.GROUP_CAR_BASE;
  ok(carMask === expectedMask && carMask === 0x7FF8,
    '车组总位域覆盖 12 车（bit 3..14）', `mask=0x${carMask.toString(16)}`);
  ok(new Set(cars.map((c) => c.groupBit)).size === 12 &&
    cars.every((c, i) => c.groupBit === (1 << (CFG.GROUP_CAR_BASE + i))),
    '12 车各自拿到唯一碰撞位');

  rp.setGhostMode(true);
  ok(cars.every((c) => (c.body.collisionFilterMask & carMask) === 0 &&
      (c.body.collisionFilterMask & CFG.GROUP_BARRIER) !== 0 && c.body.collisionResponse === true),
    '全员幽灵 12 车均剔除车组且保留护栏/地面响应');

  rp.setGhostMode(false);
  rp.finishCar(cars[11]);
  ok((cars[11].body.collisionFilterMask & carMask) === 0 &&
      (cars[11].body.collisionFilterMask & CFG.GROUP_BARRIER) !== 0,
    '12 号完赛车剔除完整车组位域');

  rp.zoneGhost.add(cars[10]);
  rp._refreshMasks();
  ok((cars[10].body.collisionFilterMask & carMask) === 0 &&
      (cars[10].body.collisionFilterMask & CFG.GROUP_BARRIER) !== 0,
    '11 号拥挤幽灵剔除完整车组位域');

  rp._setGhostPair(cars[0], cars[11], '1:12', true);
  ok((cars[0].body.collisionFilterMask & cars[11].groupBit) === 0 &&
      (cars[11].body.collisionFilterMask & cars[0].groupBit) === 0 &&
      (cars[11].body.collisionFilterMask & CFG.GROUP_BARRIER) !== 0,
    '预测性幽灵正确隔离 1 号/12 号且不影响护栏');
}

console.log(fail ? `\nFAIL ${fail}` : '\nALL PASS');
process.exitCode = fail ? 1 : 0;
