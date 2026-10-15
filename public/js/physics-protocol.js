/* Worker transport contract. Keep this file free of Cannon/DOM imports. */
export const PHYSICS_DT = 1 / 60;
export const PHYSICS_STATE_HZ = 60;
export const INPUT_HZ = 60;
export const MAX_EXTRAP_MS = 250;

// Main-thread rendering/audio constants mirrored from physics.js. Loading physics.js
// in main would pull Cannon into the renderer, so this is deliberately a small copy.
export const RENDER_CFG = Object.freeze({
  IDLE_RPM: 1100,
  REDLINE_RPM: 7500,
  RIDE_H: 0.62,
  WHEEL: [[-0.80, 1.35], [0.80, 1.35], [-0.80, -1.35], [0.80, -1.35]],
  GHOST_OPACITY: 0.38,
  GHOST_MODE_OPACITY: 0.28,
  TURBULENCE_HZ: 24,
  TURBULENCE_AMP: 0.012,
  DRAFT_FOV_KICK: 1.5,
  GRIP_ROAD: 2.4,
  MAX_TIME_WARP: 0.015,
});

// One Float32Array record per car. The first value is the integer id; all values
// are transport data, never object references. Adding fields requires appending
// before STATE_STRIDE is consumed by both sides.
export const STATE = Object.freeze({
  ID: 0,
  PX: 1, PY: 2, PZ: 3,
  QX: 4, QY: 5, QZ: 6, QW: 7,
  VX: 8, VY: 9, VZ: 10,
  PPX: 11, PPY: 12, PPZ: 13,
  PQX: 14, PQY: 15, PQZ: 16, PQW: 17,
  SPEED: 18, SPEED_KMH: 19, SPEED_KMH_MEASURED: 20,
  FORWARD_SPEED: 21, LATERAL_SPEED: 22,
  RPM: 23, GEAR: 24,
  LAP: 25, BEST_LAP: 26, LAP_TIME: 27, LAST_LAP: 28,
  PENALTY: 29, VIOLATIONS: 30,
  SLIP: 31, SLIP_ANGLE: 32, SLIP_RATIO: 33, WHEELSPIN: 34,
  DRIFT: 35, STEER_ANGLE: 36, AY_PREV: 37,
  WRONG_WAY: 38, TRACK_IDX: 39, LINE_CROSS: 40, PROGRESS: 41,
  GHOST: 42, GHOST_TIMER: 43,
  RESCUE_GHOST: 44, FINISH_GHOST: 45, ZONE_GHOST: 46,
  FINISHED: 47, RETIRED: 48, TOTAL_TIME: 49, FINISH_TIME: 50, RANK: 51,
  RACE_LOCKED: 52, CP_IDX: 53,
  WGY0: 54, WGY1: 55, WGY2: 56, WGY3: 57,
  SUSP0: 58, SUSP1: 59, SUSP2: 60, SUSP3: 61,
  AX: 62, SURFACE: 63, AIRBORNE: 64,
  THROTTLE: 65, BRAKE: 66, STEER: 67, HANDBRAKE: 68,
  INPUT_SEQ: 69,
  TIRE_TEMP0: 70, TIRE_TEMP1: 71, TIRE_TEMP2: 72, TIRE_TEMP3: 73,
  TIRE_GRIP: 74,
  GHOST_REASON: 75, YAW_SPEED: 76, GROUND_Y: 77, SUSPENSION: 78, PG_GHOST: 79,
  ROAD_NX: 80, ROAD_NY: 81, ROAD_NZ: 82, CURB_H: 83,
  LAP_INVALID: 84, BEST_CLEAN_LAP: 85, CHECKPOINT_PROGRESS: 86, CROSSED_START: 87,
});
export const STATE_STRIDE = 88;
export const REMOTE_STRIDE = 35;

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

export function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function trackForWorker(track) {
  if (!track) return null;
  // Track math is deterministic from seed/type. Only the generated static boxes
  // cross the boundary; this avoids cloning Three/Cannon instances.
  const colliders = Array.isArray(track.colliders) ? track.colliders.map((c) => ({
    x: finite(c.x), y: finite(c.y), z: finite(c.z),
    qx: finite(c.qx), qy: finite(c.qy), qz: finite(c.qz), qw: finite(c.qw, 1),
    hx: Math.max(0.01, finite(c.hx)), hy: Math.max(0.01, finite(c.hy)), hz: Math.max(0.01, finite(c.hz)),
    barrierMain: !!c.barrierMain,
    barrierExpectedYaw: finite(c.barrierExpectedYaw),
    barrierExpectedAxisY: finite(c.barrierExpectedAxisY),
  })) : [];
  return { seed: track.seed >>> 0, trackType: track.trackType || 'suzuka', colliders };
}

export function buildStateArray(cars, out) {
  const need = Math.max(1, cars.length) * STATE_STRIDE;
  const a = out && out.length >= need ? out : new Float32Array(need);
  const put = (o, c, i) => {
    const n = (v, d = 0) => finite(v, d);
    const p = c.pos || { x: 0, y: 0, z: 0 };
    const q = c.quat || { x: 0, y: 0, z: 0, w: 1 };
    const v = c.vel || { x: 0, y: 0, z: 0 };
    const pp = c.prevPos || p, pq = c.prevQuat || q;
    o.fill(0, i, i + STATE_STRIDE);
    o[i + STATE.ID] = n(c.id);
    o[i + STATE.PX] = n(p.x); o[i + STATE.PY] = n(p.y); o[i + STATE.PZ] = n(p.z);
    o[i + STATE.QX] = n(q.x); o[i + STATE.QY] = n(q.y); o[i + STATE.QZ] = n(q.z); o[i + STATE.QW] = n(q.w, 1);
    o[i + STATE.VX] = n(v.x); o[i + STATE.VY] = n(v.y); o[i + STATE.VZ] = n(v.z);
    o[i + STATE.PPX] = n(pp.x); o[i + STATE.PPY] = n(pp.y); o[i + STATE.PPZ] = n(pp.z);
    o[i + STATE.PQX] = n(pq.x); o[i + STATE.PQY] = n(pq.y); o[i + STATE.PQZ] = n(pq.z); o[i + STATE.PQW] = n(pq.w, 1);
    o[i + STATE.SPEED] = n(c.speed); o[i + STATE.SPEED_KMH] = n(c.speedKmh);
    o[i + STATE.SPEED_KMH_MEASURED] = n(c.speedKmhMeasured);
    o[i + STATE.FORWARD_SPEED] = n(c.forwardSpeed); o[i + STATE.LATERAL_SPEED] = n(c.lateralSpeed);
    o[i + STATE.RPM] = n(c.rpm, RENDER_CFG.IDLE_RPM); o[i + STATE.GEAR] = n(c.gear, 1);
    o[i + STATE.LAP] = n(c.lap); o[i + STATE.BEST_LAP] = n(c.bestLap);
    o[i + STATE.LAP_TIME] = n(c.lapTimeLive); o[i + STATE.LAST_LAP] = n(c.lastLap);
    o[i + STATE.PENALTY] = n(c.penalty); o[i + STATE.VIOLATIONS] = n(c.violations);
    o[i + STATE.SLIP] = n(c.slip); o[i + STATE.SLIP_ANGLE] = n(c.slipAngleDeg);
    o[i + STATE.SLIP_RATIO] = n(c.slipRatio); o[i + STATE.WHEELSPIN] = n(c.wheelspin);
    o[i + STATE.DRIFT] = n(c.driftIntensity); o[i + STATE.STEER_ANGLE] = n(c.steerAngle);
    o[i + STATE.AY_PREV] = n(c.ayPrev); o[i + STATE.WRONG_WAY] = c.wrongWay ? 1 : 0;
    o[i + STATE.TRACK_IDX] = n(c.trackIdx); o[i + STATE.LINE_CROSS] = n(c.lineCross);
    o[i + STATE.PROGRESS] = n(c.progressScore || c.progress);
    o[i + STATE.GHOST] = n(c.ghost); o[i + STATE.GHOST_TIMER] = n(c.ghostTimer);
    o[i + STATE.RESCUE_GHOST] = c.rescueGhost ? 1 : 0; o[i + STATE.FINISH_GHOST] = c.finishGhost ? 1 : 0;
    o[i + STATE.ZONE_GHOST] = c.zoneGhost ? 1 : 0; o[i + STATE.FINISHED] = c.finished ? 1 : 0;
    o[i + STATE.RETIRED] = c.retired ? 1 : 0; o[i + STATE.TOTAL_TIME] = n(c.totalTime);
    o[i + STATE.FINISH_TIME] = n(c.finishTime); o[i + STATE.RANK] = n(c.rank);
    o[i + STATE.RACE_LOCKED] = c.raceLocked ? 1 : 0; o[i + STATE.CP_IDX] = n(c.cpIdx);
    // suspCompression 在 Worker（physics.js Car）与主线程镜像里都是**标量**；
    // 这里对逐轮槽位做一次兼容读取，避免任何一端误把它当数组时写入 NaN。
    const wg = c.wheelGroundY || [], sc = Array.isArray(c.suspCompression) ? c.suspCompression : null;
    for (let k = 0; k < 4; k++) { o[i + STATE.WGY0 + k] = n(wg[k]); o[i + STATE.SUSP0 + k] = n(sc ? sc[k] : 0); }
    o[i + STATE.AX] = n(c.axMeasured); o[i + STATE.SURFACE] = n(c.surface); o[i + STATE.AIRBORNE] = c.airborne ? 1 : 0;
    const inp = c.remote ? c : c.input || {};
    o[i + STATE.THROTTLE] = n(inp.throttle); o[i + STATE.BRAKE] = n(inp.brake);
    o[i + STATE.STEER] = n(inp.steer); o[i + STATE.HANDBRAKE] = n(inp.handbrake);
    o[i + STATE.INPUT_SEQ] = n(c._inputSeq);
    const tireTemp = c.tireTemp || [];
    for (let k = 0; k < 4; k++) o[i + STATE.TIRE_TEMP0 + k] = n(tireTemp[k], 80);
    o[i + STATE.TIRE_GRIP] = n(c.tireGrip, 1);
    o[i + STATE.GHOST_REASON] = n(c.ghostReasonCode);
    o[i + STATE.YAW_SPEED] = n(c.body?.angularVelocity?.y);
    o[i + STATE.GROUND_Y] = n(c.groundY);
    o[i + STATE.SUSPENSION] = n(c.suspCompression);
    o[i + STATE.PG_GHOST] = c.pgGhost ? 1 : 0;
    const rn = c.roadNormal || c.up || {};
    o[i + STATE.ROAD_NX] = n(rn.x); o[i + STATE.ROAD_NY] = n(rn.y, 1); o[i + STATE.ROAD_NZ] = n(rn.z);
    o[i + STATE.CURB_H] = n(c.curbH);
    o[i + STATE.LAP_INVALID] = c.lapInvalid ? 1 : 0;
    o[i + STATE.BEST_CLEAN_LAP] = n(c.bestCleanLap);
    o[i + STATE.CHECKPOINT_PROGRESS] = n(c.progress);
    o[i + STATE.CROSSED_START] = c.crossedStart ? 1 : 0;
  };
  for (let k = 0; k < cars.length; k++) put(a, cars[k], k * STATE_STRIDE);
  return a;
}
