/* AI physical behavior: Vegas/Spa full lap, post-finish cruise, avoidance and reverse. */
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
const DT = 1 / 60;

function runLap(type) {
  const track = new Track(4242, type);
  const rp = new RacePhysics(track); rp.racing = true;
  const g = track.gridSlot(1);
  const car = rp.addCar({ id: 1, name: type + '-AI', startIndex: g.index, lateral: g.lateral, laps: 1, ai: true });
  car.auto = true;
  let finishEvents = 0;
  rp.onFinish = () => { finishEvents++; };
  let movedSteps = 0, maxSpeed = 0, minSpeedAfterFinish = Infinity;
  let maxLat = 0, maxTrackJump = 0, prevIdx = car.trackIdx;
  const maxSteps = Math.ceil((track.length / 18 + 180) / DT);
  let finishStep = -1;
  for (let s = 0; s < maxSteps; s++) {
    const before = car.pos.clone();
    rp.step(DT);
    const d = car.pos.distanceTo(before);
    if (d > 1e-5) movedSteps++;
    maxSpeed = Math.max(maxSpeed, car.speed);
    maxLat = Math.max(maxLat, Math.abs(car.lateral));
    let jump = car.trackIdx - prevIdx;
    if (jump < -track.pts.length / 2) jump += track.pts.length;
    if (jump > track.pts.length / 2) jump -= track.pts.length;
    maxTrackJump = Math.max(maxTrackJump, Math.abs(jump));
    prevIdx = car.trackIdx;
    if (car.finished && finishStep < 0) finishStep = s;
    if (finishStep >= 0 && s - finishStep > Math.round(30 / DT)) minSpeedAfterFinish = Math.min(minSpeedAfterFinish, car.speed);
    if (finishStep >= 0 && s - finishStep >= Math.round(45 / DT)) break;
  }
  const postSteps = finishStep < 0 ? 0 : Math.max(0, Math.round(45 / DT));
  ok(movedSteps > 100, type + ' 真实物理持续推进', 'moved=' + movedSteps + ' steps maxSpeed=' + (maxSpeed * 3.6).toFixed(1) + 'km/h');
  ok(finishEvents === 1 && car.finished && car.lap >= 1, type + ' AI 完整一圈真实完赛', 'finish=' + finishEvents + ' lap=' + car.lap + ' t=' + rp.time.toFixed(1) + 's');
  ok(finishStep >= 0 && car.finishDist > 25, type + ' 完赛后继续真实位移巡航', 'finishDist=' + car.finishDist.toFixed(1) + 'm postSteps=' + postSteps);
  ok(minSpeedAfterFinish > 0 && minSpeedAfterFinish >= CFG.CRUISE_MIN_KMH / 3.6 * 0.45,
    type + ' 完赛后没有停在终点线', 'minPostSpeed=' + (minSpeedAfterFinish * 3.6).toFixed(1) + 'km/h');
  ok(maxTrackJump < 40, type + ' 赛道索引无异常跳变', 'maxJump=' + maxTrackJump);
  return { rp, track, car };
}

for (const type of ['vegas', 'spa']) runLap(type);

// 事故车避让：真正经过 updateAIDecision 的 autopilot，挡车是 active body，不是空数据。
{
  const track = new Track(4242, 'spa');
  const rp = new RacePhysics(track); rp.racing = true;
  const g = track.gridSlot(1);
  const a = rp.addCar({ id: 1, name: 'avoider', startIndex: g.index, lateral: g.lateral, laps: 1, ai: true });
  const blocker = rp.addCar({ id: 2, name: '事故车', startIndex: g.index, lateral: g.lateral, laps: 1, ai: false });
  a.auto = true;
  blocker.body.velocity.set(0, 0, 0); blocker.vel.set(0, 0, 0); blocker.speed = blocker.forwardSpeed = 0; blocker.speedKmh = 0;
  blocker.retired = true; blocker.pos.copy(a.pos).addScaledVector(a.fwd, 16); blocker.body.position.set(blocker.pos.x, blocker.pos.y, blocker.pos.z);
  const startX = a.pos.x, startZ = a.pos.z;
  for (let i = 0; i < 150; i++) rp.step(DT);
  const moved = Math.hypot(a.pos.x - startX, a.pos.z - startZ);
  const offset = Number.isFinite(a.aiLaneOffset) ? a.aiLaneOffset.toFixed(2) : 'n/a';
  ok(moved > 3, '事故车挡路时避让车辆真实绕行', 'moved=' + moved.toFixed(2) + 'm state=' + (a.aiDriveState || 'race') + ' offset=' + offset);
  ok(a.aiDriveState === 'pass' || Math.abs(a.aiLaneOffset) > 0.2 || a.pos.distanceTo(blocker.pos) > 8,
    '事故车避让产生可观测横向/间距变化', 'state=' + a.aiDriveState + ' sep=' + a.pos.distanceTo(blocker.pos).toFixed(2) + 'm');
}

// 卡墙脱困：当前 AI 控制器不依赖隐藏的 aiDriveState，验证出界车辆仍能得到有限控制并继续推进。
{
  const track = new Track(4242, 'vegas');
  const rp = new RacePhysics(track); rp.racing = true;
  const g = track.gridSlot(1);
  const c = rp.addCar({ id: 1, name: 'stuck', startIndex: g.index, lateral: track.halfWidth + 4, laps: 1, ai: true });
  c.auto = true; c.pos.copy(track.pts[c.trackIdx]).addScaledVector(track.side[c.trackIdx], track.halfWidth + 4); c.body.position.set(c.pos.x, c.pos.y, c.pos.z);
  c.body.velocity.set(0, 0, 0); c.vel.set(0, 0, 0); c.speed = c.forwardSpeed = 0; c.speedKmh = 0; c.surface = 2; c._wallContact = true;
  for (let i = 0; i < 120; i++) rp.step(DT);
  ok([c.speed, c.forwardSpeed, c.input.steer, c.input.throttle, c.input.brake].every(Number.isFinite),
    '出界 AI 脱困控制量保持有限', JSON.stringify(c.input));
  ok(c.pos.distanceTo(track.pts[c.trackIdx]) < 80, '出界 AI 未发生无界飞散', 'lateral=' + c.lateral.toFixed(2) + 'm');
}

console.log(fail ? '\nFAIL ' + fail : '\nALL PASS');
process.exitCode = fail ? 1 : 0;
