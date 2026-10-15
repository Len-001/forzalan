/* AI behavior contract checks: decisions are tested before full browser races. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8'));
globalThis.document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }), toDataURL: () => 'data:,' }), getElementById: () => null, querySelector: () => null, body: { appendChild() {} } };
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
const { Track } = await import('../public/js/track.js');
const { RacePhysics, CFG } = await import('../public/js/physics.js');
let fail = 0;
const ok = (v, name, detail = '') => { if (v) console.log('  PASS ' + name + (detail ? '   ' + detail : '')); else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); } };

function setup(type) {
  const track = new Track(4242, type);
  const rp = new RacePhysics(track); rp.racing = true;
  const a = rp.addCar({ id: 1, name: 'attacker', startIndex: 100, lateral: 0, laps: 1 });
  const b = rp.addCar({ id: 2, name: 'other', startIndex: 100, lateral: 0, laps: 1 });
  for (const c of [a, b]) {
    c.pos.set(0, 0, c === a ? 0 : 20); c.fwd.set(0, 0, 1); c.lateralDir.set(1, 0, 0); c.rightSide.set(-1, 0, 0);
    c.vel.set(0, 0, c === a ? 30 : 10); c.speed = Math.abs(c.forwardSpeed = c === a ? 30 : 10); c.speedKmh = c.speed * 3.6;
  }
  return { rp, a, b };
}

for (const type of ['suzuka', 'vegas', 'spa']) {
  const { rp, a, b } = setup(type); a.auto = true; b.auto = true;
  a.input.throttle = 1; a.input.brake = 0;
  rp.autopilot(a, 1 / 60);
  const offset = Number.isFinite(a.aiLaneOffset) ? a.aiLaneOffset.toFixed(2) : 'n/a';
  ok(a.pos.distanceTo(b.pos) > 8 || Math.abs(a.lateral - b.lateral) > 0.2,
    type + ' 前车处置后保持可观测间距', 'state=' + (a.aiDriveState || 'race') + ' offset=' + offset + ' sep=' + a.pos.distanceTo(b.pos).toFixed(2));

  b.pos.set(0, 0, -12); b.vel.set(0, 0, 35); b.speed = 35; b.speedKmh = 126; b.forwardSpeed = 35;
  a.vel.set(0, 0, 20); a.speed = 20; a.speedKmh = 72; a.forwardSpeed = 20;
  rp.autopilot(a, 1 / 60);
  ok([a.input.steer, a.input.throttle, a.input.brake].every(Number.isFinite),
    type + ' 后车接近时控制量保持有限', JSON.stringify(a.input));
}

{
  const { rp, a, b } = setup('suzuka'); b.retired = true; a.auto = true;
  a.speed = a.speedKmh = a.forwardSpeed = 0; a.vel.set(0, 0, 0); a.surface = 0; a.input.throttle = 0;
  rp.autopilot(a, 1 / 60);
  ok([a.input.steer, a.input.throttle, a.input.brake].every(Number.isFinite),
    '静止 AI 的控制量保持有限', JSON.stringify(a.input));
}

{
  const { rp, a, b } = setup('spa');
  rp.finishCar(a);
  ok(a.finishGhost === true, '完赛设置永久幽灵标记');
  ok((a.body.collisionFilterMask & CFG.GROUP_CAR_MASK) === 0, '完赛车剔除车组碰撞位域');
  ok((a.body.collisionFilterMask & CFG.GROUP_BARRIER) !== 0 && a.body.collisionResponse === true, '完赛车仍保留墙碰撞与总响应');
  ok((b.body.collisionFilterMask & CFG.GROUP_CAR_MASK) !== 0, '未完赛车仍保留车车碰撞');
}

console.log(fail ? `\nFAIL ${fail}` : '\nALL PASS');
process.exitCode = fail ? 1 : 0;
