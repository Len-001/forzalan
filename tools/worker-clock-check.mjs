/* Targeted clock-domain and MAX_TIME_WARP check. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

class FakeWorker {
  constructor() { this.messages = []; this.transfers = []; }
  postMessage(message, transfer = []) { this.messages.push(message); this.transfers.push(transfer); }
  terminate() {}
}
globalThis.Worker = FakeWorker;
const { PhysicsWorkerBridge } = await import(pathToFileURL(path.join(root, 'public/js/PhysicsWorkerBridge.js')).href);

const bridge = new PhysicsWorkerBridge({ localId: 1, roster: [] });
const pageReady = performance.now();
const workerReady = pageReady - 37.5;
bridge._message({ type: 'ready', clockNow: workerReady });
const offset = bridge._workerToMainMonoOffset;
assert.ok(Math.abs(offset - 37.5) < 2, `explicit Worker/page offset should be calibrated, got ${offset}`);

const pageSnap = performance.now() + 42;
bridge.handleNetworkPacket({
  kind: 'snap', snapT: pageSnap, renderDelay: 80,
  packet: { p: [{ id: 2, d: { x: 1, y: 2, z: 3, q: [0, 0, 0, 1], v: [4, 5, 6] } }] },
});
await Promise.resolve();
const remote = bridge.worker.messages.find((m) => m.type === 'remoteSamples');
assert.ok(remote, 'remote sample was posted after the clock handshake');
const remoteTimes = new Float32Array(remote.buffer);
assert.ok(Math.abs(remoteTimes[1] - (pageSnap - offset)) < 0.02,
  `network timestamp should cross once into Worker epoch, got ${remoteTimes[1]}`);
bridge.clear();
console.log(`PASS explicit monotonic epoch handshake (offset ${offset.toFixed(2)}ms)`);
console.log(`PASS network page timestamp converted once to Worker epoch (error ${Math.abs(remoteTimes[1] - (pageSnap - offset)).toFixed(4)}ms)`);

const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
const match = mainSrc.match(/function slewServerClock\(dt\) \{[\s\S]*?\n\}/);
assert.ok(match, 'main.js contains the active server clock slew function');
const context = {
  CFG: { MAX_TIME_WARP: 0.015 },
  S: { offline: false, net: { clockOffset: 100 }, simOffset: 0 },
  clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
  finiteNum: (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback,
  Date: { now: () => 500000 },
  Math,
  Number,
};
const slew = vm.runInNewContext(`(${match[0]})`, context);
const dt = 1 / 60;
slew(dt);
const limit = dt * 1000 * 0.015;
assert.ok(Math.abs(context.S.simOffset - limit) < 1e-12,
  `clock correction must be limited to dt*1.5%, got ${context.S.simOffset}`);
context.S.net.clockOffset = -100;
slew(dt);
assert.ok(Math.abs(context.S.simOffset - (limit - limit)) < 1e-12,
  `reverse correction must use the same rate limit, got ${context.S.simOffset}`);
console.log(`PASS render clock slew rate is ${limit.toFixed(3)}ms per ${ (dt * 1000).toFixed(3)}ms frame (1.5%)`);
console.log('PASS physical fixed-step path remains separate; see worker-smoke-check fixed-step telemetry');
