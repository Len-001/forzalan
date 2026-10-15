/* Dedicated physics runtime. This module is loaded only by PhysicsWorkerBridge. */
import {
  PHYSICS_DT, STATE_STRIDE, REMOTE_STRIDE, buildStateArray, clamp,
} from './physics-protocol.js';
import { RemoteSnapshotBuffer } from './RemoteSnapshotBuffer.js';

const root = globalThis;

// physics.js/track.js use a small, well-defined subset of Three math. Keeping the
// shim here makes the worker independent of the renderer and DOM. Cannon remains
// entirely inside this worker module graph.
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(s ? 1 / s : 0); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.crossVectors(this, v); }
  crossVectors(a, b) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; this.x = x; this.y = y; this.z = z; return this; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const n = this.length(); return this.multiplyScalar(n > 1e-12 ? 1 / n : 1); }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
  distanceToSquared(v) { const x = this.x - v.x, y = this.y - v.y, z = this.z - v.z; return x * x + y * y + z * z; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
}
class Q {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Q(this.x, this.y, this.z, this.w); }
  identity() { return this.set(0, 0, 0, 1); }
  normalize() { const n = Math.hypot(this.x, this.y, this.z, this.w) || 1; return this.set(this.x / n, this.y / n, this.z / n, this.w / n); }
  invert() { const n = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w; return this.set(-this.x / n, -this.y / n, -this.z / n, this.w / n); }
  multiply(q) { return this.multiplyQuaternions(this, q); }
  premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) { const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w, qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w; return this.set(qax * qbw + qaw * qbx + qay * qbz - qaz * qby, qay * qbw + qaw * qby + qaz * qbx - qax * qbz, qaz * qbw + qaw * qbz + qax * qby - qay * qbx, qaw * qbw - qax * qbx - qay * qby - qaz * qbz); }
  slerp(qb, t) {
    let x = this.x, y = this.y, z = this.z, w = this.w;
    let cos = x * qb.x + y * qb.y + z * qb.z + w * qb.w;
    if (cos < 0) { cos = -cos; qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w }; }
    if (cos > 0.9995) return this.set(x + t * (qb.x - x), y + t * (qb.y - y), z + t * (qb.z - z), w + t * (qb.w - w)).normalize();
    const ang = Math.acos(clamp(cos, -1, 1)), s = Math.sin(ang), a = Math.sin((1 - t) * ang) / s, b = Math.sin(t * ang) / s;
    return this.set(x * a + qb.x * b, y * a + qb.y * b, z * a + qb.z * b, w * a + qb.w * b);
  }
  setFromRotationMatrix(m) {
    const te = m.elements, m11 = te[0], m12 = te[4], m13 = te[8], m21 = te[1], m22 = te[5], m23 = te[9], m31 = te[2], m32 = te[6], m33 = te[10], trace = m11 + m22 + m33;
    if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s); }
    if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s); }
    if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s); }
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
}
class M4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeBasis(x, y, z) { const e = this.elements; e[0] = x.x; e[1] = x.y; e[2] = x.z; e[4] = y.x; e[5] = y.y; e[6] = y.z; e[8] = z.x; e[9] = z.y; e[10] = z.z; return this; }
}
root.THREE = { Vector3: V3, Quaternion: Q, Matrix4: M4, MathUtils: { damp: (x, y, lambda, dt) => x + (y - x) * (1 - Math.exp(-lambda * dt)) } };

let RacePhysics;
let Track;
let rp = null;
let ready = false;
let running = false;
let disposed = false;
let localId = 0;
let lastNow = 0;
let acc = 0;
let statePool = [];
let stateSeq = 0;
let stateHits = 0;
let stateTerrainHits = 0;
let stateContactDetails = [];
let diagnosticProbe = null;
let renderDelayMs = 80;
const MAX_FIXED_STEPS = 15;
const remoteHistory = new Map();
// 复用型 scratch：接触详情与"步前运动学"每个固定步都要用，但不需要每步重新分配。
const preKinematics = [];        // [{ v:[x,y,z], p:[x,y,z] }]，下标 = 车序
const stepDetails = [];          // [detail[]]，下标 = 车序；每步先清空再填充
const ZERO_NORMAL = { x: 0, y: 1, z: 0 };
// 纯算术取整，语义等价于 Number(x.toFixed(n))，但不产生临时字符串。
const rnd3 = (v) => Math.round(num(v) * 1e3) / 1e3;
const rnd4 = (v) => Math.round(num(v) * 1e4) / 1e4;
const rnd5 = (v) => Math.round(num(v) * 1e5) / 1e5;

const post = (message, transfer = []) => { if (!disposed) self.postMessage(message, transfer); };
const otherBarrier = (a, b) => (a.__barrier === true || b.__barrier === true) && !(a.__roadHeightfield || b.__roadHeightfield);
const num = (v, d = 0) => Number.isFinite(v) ? v : d;
const pos = (d) => ({ x: num(d && d.x), y: num(d && d.y), z: num(d && d.z) });
const quat = (d) => ({ x: num(d && d[0]), y: num(d && d[1]), z: num(d && d[2]), w: num(d && d[3], 1) });
const vel = (d) => ({ x: num(d && d[0]), y: num(d && d[1]), z: num(d && d[2]) });

function carPayload(c) { return c ? { id:c.id,name:c.name,lap:c.lap,bestLap:c.bestLap,lastLap:c.lastLap,lapInvalid:!!c.lapInvalid,finished:!!c.finished,finishGhost:!!c.finishGhost,totalTime:c.totalTime,finishTime:c.finishTime,rank:c.rank,penalty:c.penalty,violations:c.violations } : null; }
function event(name, payload) { post({ type: 'event', name, payload }); }
function configureCallbacks() {
  rp.onPenalty = (c, sec, reason) => event('penalty', { car: carPayload(c), seconds: num(sec), reason: String(reason || '') });
  rp.onIncident = (c, info) => event('incident', { car: carPayload(c), info: info || {} });
  rp.onLap = (c, lap, time, dirty) => event('lap', { car: carPayload(c), lap, time, dirty: !!dirty });
  rp.onFinish = (c) => event('finish', { car: carPayload(c) });
  rp.onAlert = (c, text, kind) => event('alert', { car: carPayload(c), text: String(text || ''), kind: String(kind || '') });
  rp.onBump = (c) => event('bump', { car: carPayload(c) });
}

// 仅按需测量真实固定步长，不额外推进世界，也不在高频状态包中复制诊断对象。
function collectDiagnostics(m) {
  if (!rp || diagnosticProbe) {
    post({ type: 'diagnostics', id: m.id, error: !rp ? 'physics not ready' : 'diagnostics busy' });
    return;
  }
  const w = rp.world, originalTick = w.collisionMatrixTick;
  const probe = diagnosticProbe = { start: performance.now(), step: w.stepnumber, fixed: [], matrix: [] };
  w.collisionMatrixTick = function(...args) {
    const started = performance.now();
    const result = originalTick.apply(this, args);
    probe.matrix.push(performance.now() - started);
    return result;
  };
  const statistics = values => {
    if (!values.length) return { count: 0, mean: null, p50: null, p99: null, max: null };
    const sorted = values.slice().sort((a, b) => a - b);
    return { count: sorted.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: sorted[Math.floor(sorted.length * 0.5)], p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted[sorted.length - 1] };
  };
  probe.timer = setTimeout(() => {
    w.collisionMatrixTick = originalTick;
    diagnosticProbe = null;
    const mapBacked = w.collisionMatrix._m instanceof Map;
    post({ type: 'diagnostics', id: m.id, data: {
      elapsedMs: performance.now() - probe.start, fixedDt: PHYSICS_DT,
      fixedSteps: w.stepnumber - probe.step, stateSeq, carCount: rp.cars.length, bodies: w.bodies.length,
      broadphase: w.broadphase.__workerConfig, matrixIsMapBacked: mapBacked,
      livePairs: mapBacked ? w.collisionMatrix._m.size : null,
      heightfields: w.bodies.reduce((sum, b) => sum + b.shapes.filter(s => s.type === 32).length, 0),
      fixedStepMs: statistics(probe.fixed), collisionMatrixTickMs: statistics(probe.matrix),
    }});
  }, clamp(num(m.duration, 2000), 250, 5000));
}

function acquireState(size) {
  for (let i = statePool.length - 1; i >= 0; i--) {
    const b = statePool[i];
    if (b.byteLength >= size * 4) { statePool.splice(i, 1); return new Float32Array(b); }
  }
  return new Float32Array(size);
}
function releaseState(buffer) { if (buffer && buffer.byteLength) statePool.push(buffer); }
function snapshot(now) {
  if (!rp) return;
  const arr = acquireState(Math.max(1, rp.cars.length) * STATE_STRIDE);
  const filled = buildStateArray(rp.cars, arr);
  const alpha = clamp(num(rp.acc) / PHYSICS_DT, 0, 1);
  const frame = ++stateSeq;
  post({ type: 'state', seq: frame, now, time: num(rp.time), alpha, step: rp.world.stepnumber, contactMask: stateHits, terrainContactMask: stateTerrainHits, contactDetails: stateContactDetails, count: rp.cars.length, stride: STATE_STRIDE, buffer: filled.buffer }, [filled.buffer]);
  stateHits = 0;
  stateTerrainHits = 0;
  stateContactDetails = [];

}
function pushRemoteSample(id, d, t, seq = 0) {
  const c = rp && rp.byId.get(id);
  if (!c || !c.remote || !d) return;
  let h = remoteHistory.get(id);
  if (!h) { h = new RemoteSnapshotBuffer(); remoteHistory.set(id, h); }
  h.push({t:num(t,performance.now()),seq,p:pos(d),q:quat(d.q),v:vel(d.v),u:[num(d.u),num(d.b),num(d.e),num(d.h)]}, performance.now());
  const wasGhost = c.ghost > 0, wasFinished = c.finishGhost;
  if (d.f) { c.finished = true; c.finishGhost = true; }
  c.lap = num(d.l, c.lap);
  c.ghostReasonCode = num(d.gr); c.ghost = num(d.go);
  if (wasGhost !== (c.ghost > 0) || wasFinished !== c.finishGhost) rp._refreshMasks();
  if (c.ai) {
    c.cpIdx = num(d.c, -1); c.lapTimeLive = num(d.lt); c.bestLap = num(d.bl); c.bestCleanLap = num(d.bc);
    c.penalty = num(d.pen); c.violations = num(d.vio); c.lapInvalid = !!d.li;
    c.progress = num(d.pr); c.crossedStart = !!d.cs; c.lineCross = num(d.lc); c.lastLap = num(d.ll);
    c.finishTime = num(d.ft); c.totalTime = num(d.tt);
  }
}
function updateRemoteTargets(now) {
  if (!rp) return;
  const targetTime = now - renderDelayMs;
  for (const c of rp.cars) {
    if (!c.remote) continue;
    const h = remoteHistory.get(c.id);
    const sample = h && h.sample(targetTime, PHYSICS_DT);
    if (!sample) continue;
    rp.applyRemoteTarget(c.id, sample.p, sample.q, sample.v);
    rp.setRemoteInput(c.id, ...sample.u);
  }
}
function tick(now) {
  if (disposed) return;
  try {
    if (!lastNow) lastNow = now;
    const elapsed = Math.min(0.25, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    if (running && rp) {
      acc += elapsed;
      let steps = 0;
      while (acc >= PHYSICS_DT && steps < MAX_FIXED_STEPS) {
        updateRemoteTargets(now - (acc - PHYSICS_DT) * 1000);
        // ★ 零分配改造。接触详情（contactDetails）是**常驻遥测**：jitter-check 与
        //   worker-kinematic-check 都直接消费它，所以不能"只在探针期构造"。
        //   这里改为消除每步的分配与字符串格式化：
        //     · preKinematics / stepDetails 改为模块级 scratch，按车数增长后复用
        //       （原来每步一次 `rp.cars.map(...)` + 一次 `Array.from(...)`）；
        //     · `Number(x.toFixed(n))` 换成纯算术取整 `rndN(x)`，不再产生临时字符串
        //       —— 12 车 × 每个接触点 3~5 次 toFixed × 60Hz 是此前最稳定的垃圾源。
        const probe = diagnosticProbe;
        const began = probe ? performance.now() : 0;
        const cars = rp.cars;
        for (let k = 0; k < cars.length; k++) {
          const b = cars[k].body;
          const slot = preKinematics[k] || (preKinematics[k] = { v: [0, 0, 0], p: [0, 0, 0] });
          slot.v[0] = b.velocity.x; slot.v[1] = b.velocity.y; slot.v[2] = b.velocity.z;
          slot.p[0] = b.position.x; slot.p[1] = b.position.y; slot.p[2] = b.position.z;
        }
        rp.fixedStep(PHYSICS_DT);
        if (probe) probe.fixed.push(performance.now() - began);
        // 记录最后一个固定步的真实接触详情，供抖动诊断区分路面顶面与侧壁。
        for (let k = 0; k < cars.length; k++) {
          const row = stepDetails[k] || (stepDetails[k] = []);
          row.length = 0;
        }
        for (const contact of rp.world.contacts) {
          const a = contact.bi, b = contact.bj;
          const terrain = a.shapes.some(s => s.type === 32) || b.shapes.some(s => s.type === 32);
          for (let k = 0; k < cars.length; k++) {
            if (cars[k].body !== a && cars[k].body !== b) continue;
            if (terrain) stateTerrainHits |= 1 << k;
            else stateHits |= 1 << k;
            const own = cars[k].body;
            const other = a === own ? b : a;
            stepDetails[k].push({
              road: terrain, barrier: otherBarrier(a, b), otherCar: other.__carId !== undefined ? other.__carId : 0,
              normal: [rnd4(contact.ni.x), rnd4(contact.ni.y), rnd4(contact.ni.z)],
              penetration: rnd5(contact.__lastPenetration || 0),
              ri: [rnd3(contact.ri.x), rnd3(contact.ri.y), rnd3(contact.ri.z)],
              rj: [rnd3(contact.rj.x), rnd3(contact.rj.y), rnd3(contact.rj.z)],
              preVelocity: [rnd3(preKinematics[k].v[0]), rnd3(preKinematics[k].v[1]), rnd3(preKinematics[k].v[2])],
              postVelocity: [rnd3(own.velocity.x), rnd3(own.velocity.y), rnd3(own.velocity.z)],
              prePosition: [rnd3(preKinematics[k].p[0]), rnd3(preKinematics[k].p[1]), rnd3(preKinematics[k].p[2])],
              postPosition: [rnd3(own.position.x), rnd3(own.position.y), rnd3(own.position.z)],
            });
          }
        }
        // 路面 Heightfield 是 query-only，承重来自 groundConstraint 的四轮射线，
        // 因而它不会出现在 Cannon contacts。将这条真实承重路径单独镜像到
        // terrainContactMask/contactDetails，避免把“无刚体碰撞”误报成“未接地”。
        for (let k = 0; k < cars.length; k++) {
          const car = cars[k];
          if (!car.grounded || !(car.roadRayHits > 0)) continue;
          stateTerrainHits |= 1 << k;
          const normal = car.roadNormal || ZERO_NORMAL;
          stepDetails[k].push({
            road: true, barrier: false, otherCar: 0,
            normal: [rnd4(normal.x), rnd4(normal.y), rnd4(normal.z)],
            penetration: 0,
            ri: [0, 0, 0], rj: [0, 0, 0],
            preVelocity: [rnd3(preKinematics[k].v[0]), rnd3(preKinematics[k].v[1]), rnd3(preKinematics[k].v[2])],
            postVelocity: [rnd3(car.body.velocity.x), rnd3(car.body.velocity.y), rnd3(car.body.velocity.z)],
            prePosition: [rnd3(preKinematics[k].p[0]), rnd3(preKinematics[k].p[1]), rnd3(preKinematics[k].p[2])],
            postPosition: [rnd3(car.body.position.x), rnd3(car.body.position.y), rnd3(car.body.position.z)],
          });
        }
        for (let k = 0; k < cars.length; k++) {
          const row = stepDetails[k];
          if (!row.length) continue;
          const prev = stateContactDetails[k];
          stateContactDetails[k] = prev && prev.length ? prev.concat(row).slice(-12) : row.slice(-12);
        }
        acc -= PHYSICS_DT;
        steps++;
        // 每个固定步都发布一次状态。落后补算时若只在 while 结束发布，
        // 主线程会连续看到旧状态后一次跳过多步，造成可见的“顶一下”。
        rp.acc = acc;
        // alpha 已含剩余时间；时间戳再减 acc 会让渲染端重复计时。
        snapshot(now);
      }
      if (steps === MAX_FIXED_STEPS) acc = 0;
      rp.acc = acc;
    }
  } catch (error) {
    running = false;
    post({ type: 'error', message: error && error.stack ? error.stack : String(error) });
    return;
  }
  setTimeout(() => tick(performance.now()), 4);
}
self.addEventListener('error', (event) => {
  post({ type: 'error', message: event && (event.error?.stack || event.message) || 'physics worker uncaught error' });
});
self.addEventListener('unhandledrejection', (event) => {
  post({ type: 'error', message: event && (event.reason?.stack || event.reason) || 'physics worker unhandled rejection' });
});
async function init(m) {
  if (ready) return;
  const pmod = await import('./physics.js');
  const tmod = await import('./track.js');
  RacePhysics = pmod.RacePhysics; Track = tmod.Track;
  const td = m.track || {};
  const t = new Track(td.seed >>> 0, td.trackType || 'suzuka');
  t.colliders = Array.isArray(td.colliders) ? td.colliders : [];
  rp = new RacePhysics(t);
  // Remote cars are network-owned KINEMATIC bodies. RacePhysics also calls
  // groundConstraint() for them, but that routine is a suspension controller
  // and is allowed to move a body vertically. Keep the road as telemetry only
  // for remotes; local cars retain the normal raycast/constraint path.
  const groundConstraint = rp.groundConstraint;
  rp.groundConstraint = function workerGroundConstraint(car, dt, post = false) {
    if (!car || !car.remote) return groundConstraint.call(this, car, dt, post);
    const body = car.body;
    const info = this.track.sample(body.position.x, body.position.z, car.trackIdx, body.position.y);
    if (!info) return;
    car.trackIdx = info.i;
    car.lateral = info.lateral;
    car.roadNormal = info.normal;
    car.roadTangent = info.tangent;
    car.roadSide = info.side;
    car.groundY = info.y;
    car.roadRayHits = 0;
    car.roadLayer = info.onBridge ? 'bridge' : 'ground';
  };
  const broadphase = rp.world.broadphase;
  const needPair = broadphase.needBroadphaseCollision.bind(broadphase);
  const testPair = broadphase.intersectionTest.bind(broadphase);
  const broadphaseCell = 32;
  let indexedBodyCount = -1;
  let dynamicBodies = [];
  let staticBuckets = new Map();
  let largeStaticBodies = [];
  const bucketKey = (x, z) => `${x},${z}`;
  const indexStaticBody = (body) => {
    if (body.aabbNeedsUpdate) body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
    const x0 = Math.floor(lo.x / broadphaseCell), x1 = Math.floor(hi.x / broadphaseCell);
    const z0 = Math.floor(lo.z / broadphaseCell), z1 = Math.floor(hi.z / broadphaseCell);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) { largeStaticBodies.push(body); return; }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const key = bucketKey(x, z);
      let bucket = staticBuckets.get(key);
      if (!bucket) { bucket = []; staticBuckets.set(key, bucket); }
      bucket.push(body);
    }
  };
  const rebuildBroadphaseIndex = (world) => {
    if (indexedBodyCount === world.bodies.length) return;
    indexedBodyCount = world.bodies.length;
    dynamicBodies = [];
    staticBuckets = new Map();
    largeStaticBodies = [];
    for (const body of world.bodies) {
      if (body.mass > 0 || body.type === 4) dynamicBodies.push(body);
      else indexStaticBody(body);
    }
  };
  rp.world.broadphase.collisionPairs = (world, pairs1, pairs2) => {
    rebuildBroadphaseIndex(world);
    for (let i = 0; i < dynamicBodies.length; i++) {
      const a = dynamicBodies[i];
      if (a.aabbNeedsUpdate) a.updateAABB();
      for (let j = 0; j < i; j++) {
        const b = dynamicBodies[j];
        if (needPair(a, b)) testPair(a, b, pairs1, pairs2);
      }
      for (const b of largeStaticBodies) {
        if (needPair(a, b)) testPair(a, b, pairs1, pairs2);
      }
      const lo = a.aabb.lowerBound, hi = a.aabb.upperBound;
      const x0 = Math.floor(lo.x / broadphaseCell), x1 = Math.floor(hi.x / broadphaseCell);
      const z0 = Math.floor(lo.z / broadphaseCell), z1 = Math.floor(hi.z / broadphaseCell);
      const seen = new Set();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const bucket = staticBuckets.get(bucketKey(x, z));
        if (!bucket) continue;
        for (const b of bucket) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          if (needPair(a, b)) testPair(a, b, pairs1, pairs2);
        }
      }
    }
  };
  broadphase.__workerConfig = { algorithm: 'static-bucket-xz', cellXZ: broadphaseCell };
  localId = Number(m.localId) || 0;
  rp.setGhostMode(!!m.ghost); rp.setGameMode(m.gameMode || 'fm8');
  configureCallbacks();
  if (Array.isArray(m.roster)) for (const car of m.roster) addCar(car);
  ready = true;
  // The bridge calibrates this Worker monotonic epoch against the page epoch.
  // Do not make the bridge infer the offset from timeOrigin: those values are
  // not a safe substitute for an explicit clock-domain handshake.
  post({ type: 'ready', clockNow: performance.now(), cars: rp.cars.length, baumgarteKilled: !!rp.baumgarteKilled, colliders: rp.staticBodies ? rp.staticBodies.length : 0 });
  tick(performance.now());
}
function addCar(opts) {
  if (!rp || !opts || rp.byId.has(opts.id)) return;
  const c = rp.addCar(opts); c.auto = !!opts.ai && !c.remote; c.raceLocked = opts.raceLocked !== false;
  c._inputSeq = 0;
}
self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'recycleState') { releaseState(m.buffer); return; }
    if (m.type === 'init') { await init(m); return; }
    if (m.type === 'diagnostics') { collectDiagnostics(m); return; }
    if (m.type === 'addCar') { addCar(m.car); return; }
    // ★ 远端历史必须随车辆/局次生命周期一起清空：残留的旧 seq 会让新一局的包
    //   被 RemoteSnapshotBuffer 永久判为"乱序"，表现为远端车卡在起点不动。
    if (m.type === 'removeCar') { remoteHistory.delete(m.id); if (rp) rp.removeCar(m.id); return; }
    if (m.type === 'clear') { remoteHistory.clear(); if (rp) rp.clear(); return; }
    if (m.type === 'start') { remoteHistory.clear(); if (rp) { running = true; rp.racing = false; rp.timeAligned = false; acc = 0; lastNow = performance.now(); } return; }
    if (m.type === 'running') {
      if (rp) {
        if (m.value && !rp.timeAligned) { rp.time = 0; rp.timeAligned = true; for (const c of rp.cars) { c.lapStart = 0; c.lapTimeLive = 0; } }
        rp.racing = !!m.value;
        for (const c of rp.cars) c.raceLocked = !rp.racing;
      }
      return;
    }
    if (m.type === 'setGhost') { if (rp) rp.setGhostMode(!!m.value); return; }
    if (m.type === 'setGameMode') { if (rp) rp.setGameMode(m.value); return; }
    if (m.type === 'aiHost') { if (rp) { rp.setAIAuthority(!!m.local); for (const c of rp.cars) if (c.ai) remoteHistory.delete(c.id); } return; }
    if (m.type === 'input') {
      const c = rp && rp.byId.get(m.id || localId); const d = m.values || m.data || [];
      if (c) { c.input.throttle = clamp(num(d[0] ?? d.throttle), 0, 1); c.input.brake = clamp(num(d[1] ?? d.brake), 0, 1); c.input.steer = clamp(num(d[2] ?? d.steer), -1, 1); c.input.handbrake = (d[3] ?? d.handbrake) ? 1 : 0; c._inputSeq = num(m.seq); }
      if (m.buffer) post({ type: 'recycleInput', buffer: m.buffer }, [m.buffer]);
      return;
    }
    if (m.type === 'remoteSamples') {
      renderDelayMs = clamp(num(m.renderDelay,80),60,120);
      const a = new Float32Array(m.buffer), stride = m.stride || REMOTE_STRIDE;
      for (let k=0;k<m.count;k++) {
        const i=k*stride;
        pushRemoteSample(a[i],{x:a[i+2],y:a[i+3],z:a[i+4],q:[a[i+5],a[i+6],a[i+7],a[i+8]],v:[a[i+9],a[i+10],a[i+11]],u:a[i+12],b:a[i+13],e:a[i+14],h:a[i+15],f:a[i+16],l:a[i+17],gr:a[i+19],go:a[i+20],c:a[i+21],lt:a[i+22],bl:a[i+23],bc:a[i+24],pen:a[i+25],vio:a[i+26],li:a[i+27],pr:a[i+28],cs:a[i+29],lc:a[i+30],ll:a[i+31],ft:a[i+32],tt:a[i+33]},a[i+1],a[i+34]);
      }
      // 归还缓冲给主线程的复用池：60Hz × N 车不再每包分配一个 Float32Array。
      post({ type: 'recycleRemote', buffer: m.buffer }, [m.buffer]);
      return;
    }
    if (m.type === 'network') {
      const p = m.packet || {};
      if (p.kind === 'snap' && p.packet) {
        const list = Array.isArray(p.packet.p) ? p.packet.p : [];
        for (const e of list) pushRemoteSample(e.id, e.d, p.snapT - Math.max(0, num(e.age)), num(e.seq));
      } else if (p.t === 'snap') {
        for (const e of (p.p || [])) pushRemoteSample(e.id, e.d, (p.ts || performance.now()) - Math.max(0, num(e.age)), num(e.seq));
      } else if (p.id && p.d) pushRemoteSample(p.id, p.d, p.ts || performance.now(), num(p.seq));
      return;
    }
    if (m.type === 'rescue') { if (rp) { const c = rp.byId.get(m.id || localId); if (c && rp.rescueToCheckpoint) rp.rescueToCheckpoint(c); } return; }
    if (m.type === 'finish') { if (rp) { const c = rp.byId.get(m.id); if (c && rp.finishCar) rp.finishCar(c); } return; }
    if (m.type === 'dispose') { disposed = true; running = false; if (rp) rp.clear(); close(); }
  } catch (error) {
    post({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  }
};
