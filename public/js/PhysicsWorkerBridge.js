import { PHYSICS_DT, STATE, STATE_STRIDE, REMOTE_STRIDE, trackForWorker, RENDER_CFG } from './physics-protocol.js';

const V3 = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const nowMono = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const n = (v, d = 0) => Number.isFinite(v) ? v : d;
// 定点量化（用于上行报文，见 _publishNetwork 的说明）。纯算术取整，不产生临时字符串。
const r1 = (v) => Math.round(n(v) * 10) / 10;
const r2 = (v) => Math.round(n(v) * 100) / 100;
const r3 = (v) => Math.round(n(v) * 1000) / 1000;
const r4 = (v) => Math.round(n(v) * 1e4) / 1e4;
// 驾驶规则三态（与 main.go sanitizeGameMode 必须一致）。
const normalizeGameMode = (mode) => (mode === 'horizon' ? 'horizon' : mode === 'bumper' ? 'bumper' : 'fm8');

class CarMirror {
  constructor(opts) {
    Object.assign(this, opts);
    this.id = opts.id;
    this.name = opts.name || ('车手' + opts.id);
    this.color = opts.color || '#e10600';
    this.isLocal = !!opts.isLocal;
    this.remote = !!opts.remote;
    this.ai = !!opts.ai;
    this.auto = !!opts.ai && !this.remote;
    this.engineProfile = opts.engine || opts.engineProfile || 'i6gt';
    this.engine = this.engineProfile;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.pos = V3(); this.prevPos = V3(); this.quat = Q(); this.prevQuat = Q();
    this.vel = V3(); this.fwd = V3(); this.lateralDir = V3(); this.rightSide = V3(); this.up = V3();
    this.body = { position: this.pos, quaternion: this.quat, velocity: this.vel };
    this.wheelGroundY = [0, 0, 0, 0]; this.suspCompression = 0;   // 与 Worker 侧 physics.js 一致：标量（正=压缩）
    this.finished = false; this.retired = false; this.totalTime = 0; this.finishTime = 0; this.rank = 0;
    this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = 0;
    this.lap = 0; this.bestLap = 0; this.bestCleanLap = 0; this.lastLap = 0; this.lapTimeLive = 0; this.lapInvalid = false; this.penalty = 0; this.violations = 0;
    this.speed = 0; this.speedKmh = 0; this.speedKmhMeasured = 0; this.forwardSpeed = 0; this.lateralSpeed = 0;
    this.rpm = RENDER_CFG.IDLE_RPM; this.gear = 1; this.slip = 0; this.slipAngleDeg = 0; this.slipRatio = 0;
    this.wheelspin = 0; this.driftIntensity = 0; this.steerAngle = 0; this.ayPrev = 0; this.wrongWay = false;
    this.tireTemp = [80, 80, 80, 80]; this.tireGrip = 1;
    this.trackIdx = 0; this.lineCross = 0; this.progressScore = 0; this.ghost = 0; this.ghostTimer = 0;
    this.rescueGhost = false; this.finishGhost = false; this.zoneGhost = false; this.raceLocked = true;
    this.cpIdx = -1; this.axMeasured = 0; this.surface = 0; this.airborne = false; this._inputSeq = 0;
  }
  addPenalty(sec, reason) { this.penalty += Math.max(0, n(sec)); this.lastPenaltyReason = reason || ''; }
  rearContactPoint(side, out = V3()) { return out.copy(this.pos).addScaledVector(this.fwd, -1.35).addScaledVector(this.lateralDir, side * 0.8); }
}

export class PhysicsWorkerBridge {
  constructor({ track, seed, trackType, localId = 0, hostId = localId, grid = null, roster = [], laps = 3, ghost = false, gameMode = 'fm8', workerUrl } = {}) {
    this.track = track || null;
    this.seed = (seed >>> 0) || (track && track.seed) || 0;
    this.trackType = trackType || (track && track.trackType) || 'suzuka';
    this.localId = localId;
    this.hostId = hostId;
    this.laps = laps;
    // 服务端权威发车格（id -> slot）。必须存成实例字段：_normalizeCarOpts 与
    // addCar 都要读它，此前只作为构造参数被 roster 闭包捕获。
    this.grid = grid || null;
    this.cars = [];
    this.byId = new Map();
    this.time = 0;
    this.physicsStep = -1;
    this.lastContactDetails = [];
    this.alpha = 0;
    this._racing = false;
    this.timeAligned = false;
    this.gameMode = normalizeGameMode(gameMode);
    // 碰碰车模式要求全程实体对抗 ⇒ 忽略 ghost 参数（服务端也会强制，这里是客户端侧冗余）。
    this.ghostMode = this.gameMode === 'bumper' ? false : !!ghost;
    this.ready = false;
    this.disposed = false;
    this._inputSeq = 0;
    this._inputPool = [];
    this._remotePool = [];
    this._networkSeq = 0; this._lastNetworkNow = -Infinity;
    this._stateNow = null;
    // Worker performance.now() has its own monotonic epoch.  Keep one explicit
    // conversion into the page epoch instead of inferring it from timeOrigin.
    this._workerToMainMonoOffset = 0;
    this._events = new Map();
    this._diagnosticId = 0;
    this._diagnostics = new Map();
    this.onNetwork = null;
    const url = workerUrl || new URL('./physics.worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module', name: 'fm8-physics' });
    this.readyPromise = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
    this.worker.onmessage = (ev) => this._message(ev.data || {});
    this.worker.onerror = (ev) => { const e = new Error(ev.message || 'physics worker error'); this._rejectReady(e); this._emit('error', e); };
    // 与 addCar 共用同一套归一化（见 _normalizeCarOpts），避免两条路径行为漂移。
    const workerRoster = roster.map((x, index) => {
      const opts = this._normalizeCarOpts(x, index);
      const car = new CarMirror(opts);
      this.cars.push(car); this.byId.set(car.id, car);
      return opts;
    });
    this.worker.postMessage({
      type: 'init', localId: this.localId, laps: this.laps, ghost: this.ghostMode, gameMode: this.gameMode,
      track: trackForWorker(this.track) || { seed: this.seed, trackType: this.trackType, colliders: [] },
      roster: workerRoster,
    });
  }
  on(type, fn) { if (!this._events.has(type)) this._events.set(type, []); this._events.get(type).push(fn); return this; }
  get racing() { return this._racing; }
  set racing(value) { this.setRunning(value); }
  _emit(type, data) { for (const fn of this._events.get(type) || []) { try { fn(data); } catch (e) { console.error('[physics bridge]', type, e); } } }
  prewarm() { return this.readyPromise; }
  async requestDiagnostics(durationMs = 2000) {
    await this.readyPromise;
    if (this.disposed) throw new Error('physics worker disposed');
    const duration = Math.max(250, Math.min(5000, n(durationMs, 2000)));
    const id = ++this._diagnosticId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._diagnostics.delete(id);
        reject(new Error('physics diagnostics timeout'));
      }, duration + 5000);
      this._diagnostics.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'diagnostics', id, duration });
    });
  }
  renderAlpha(now = nowMono()) {
    if (this._stateNow === null) return 0;
    // Worker 包晚到时只预测一物理步的显示位置，避免每次等包都硬停。
    return Math.max(0, Math.min(2, this.alpha + Math.max(0, now - this._stateNow) / (PHYSICS_DT * 1000)));
  }
  _postWhenReady(message, transfer = []) { this.readyPromise.then(() => { if (!this.disposed) this.worker.postMessage(message, transfer); }).catch(() => {}); }
  /**
   * 追加一台车（中途加入 / 补席位）。
   *
   * ⚠️ 必须与构造函数的 roster 路径**走同一套归一化**：`isLocal` / `remote` /
   * `startIndex` / `lateral` 与发车格位姿都要在这里补齐。否则中途加入的车
   * `isLocal=false, remote=false` —— 既不会被 `_publishNetwork` 上报（它的车永远
   * 停在对端起点），本地镜像又停在 (0,0,0)。构造函数里那段逻辑此前只对 roster
   * 生效，`addCar` 走的是裸 `{...opts}`，两条路径的行为不一致。
   */
  addCar(opts) {
    const existing = this.byId.get(opts.id);
    if (existing) return existing;
    const normalized = this._normalizeCarOpts(opts, this.cars.length);
    const c = new CarMirror(normalized);
    this.cars.push(c);
    this.byId.set(c.id, c);
    this._postWhenReady({ type: 'addCar', car: normalized });
    return c;
  }
  /**
   * 把外部传入的车辆描述归一化成 Worker 与本地镜像**共用的一份定义**：
   * 由发车格（服务端 grid 或 track.gridSlot）推出 startIndex/lateral，
   * 并按本机视角补齐 isLocal / remote。构造函数与 addCar 必须共用它。
   */
  _normalizeCarOpts(x, index = this.cars.length) {
    const slot = Math.max(1, Number(this.grid?.[String(x.id)] || x.gridSlot || x.slot || x.id || index + 1) | 0);
    const pose = this.track && typeof this.track.gridSlot === 'function' ? this.track.gridSlot(slot) : null;
    const isLocal = x.isLocal ?? (x.id === this.localId);
    return {
      ...x,
      isLocal,
      remote: x.remote ?? (!isLocal && (!x.ai || this.hostId !== this.localId)),
      startIndex: Number.isFinite(x.startIndex) ? x.startIndex : (pose ? pose.index : 0),
      lateral: Number.isFinite(x.lateral) ? x.lateral : (pose ? pose.lateral : 0),
      laps: x.laps || this.laps,
      raceLocked: true,
    };
  }
  removeCar(id) { this._postWhenReady({ type: 'removeCar', id }); const c = this.byId.get(id); if (c) { this.byId.delete(id); const i = this.cars.indexOf(c); if (i >= 0) this.cars.splice(i, 1); } }
  clear() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ready) this._rejectReady(new Error('physics worker disposed'));
    for (const pending of this._diagnostics.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('physics worker disposed'));
    }
    this._diagnostics.clear();
    try { this.worker.postMessage({ type: 'dispose' }); } catch (e) { /* worker already gone */ }
    this.worker.terminate(); this.cars.length = 0; this.byId.clear(); this._racing = false;
  }
  dispose() { this.clear(); }
  start() { this._postWhenReady({ type: 'start' }); }
  setRunning(value) {
    const next = !!value;
    if (next === this._racing) return;
    this._racing = next;
    this._postWhenReady({ type: 'running', value: next });
  }
  setGhostMode(value) {
    // 碰碰车模式与幽灵车互斥：该模式下任何开启请求都被压低为 false。
    this.ghostMode = this.gameMode === 'bumper' ? false : !!value;
    this._postWhenReady({ type: 'setGhost', value: this.ghostMode });
  }
  setGameMode(value) {
    this.gameMode = normalizeGameMode(value);
    if (this.gameMode === 'bumper') this.ghostMode = false;
    this._postWhenReady({ type: 'setGameMode', value: this.gameMode });
  }
  setHost(hostId) {
    if (hostId === this.hostId) return;
    this.hostId = hostId;
    for (const c of this.cars) if (c.ai) { c.remote = hostId !== this.localId; c.auto = !c.remote; }
    this._postWhenReady({ type: 'aiHost', local: hostId === this.localId });
  }
  setRemoteInput(id, thr, brk, steer, hand) {
    const c = this.byId.get(id);
    if (!c) return;
    c.input.throttle = n(thr); c.input.brake = n(brk); c.input.steer = n(steer); c.input.handbrake = hand ? 1 : 0;
    c.throttle = c.input.throttle; c.brake = c.input.brake; c.steer = c.input.steer; c.handbrake = c.input.handbrake;
  }
  applyRemoteTarget() { /* remote history and kinematic proxies live in the worker */ }
  sendInput(car, timestamp = nowMono()) {
    if (!car || this.disposed) return;
    let a = this._inputPool.pop();
    if (!a || a.length !== 4) a = new Float32Array(4);
    a[0] = n(car.input && car.input.throttle); a[1] = n(car.input && car.input.brake);
    a[2] = n(car.input && car.input.steer); a[3] = n(car.input && car.input.handbrake);
    const seq = ++this._inputSeq;
    this._postWhenReady({ type: 'input', id: car.id || this.localId, seq, timestamp: n(timestamp), values: a, buffer: a.buffer }, [a.buffer]);
  }
  rescueToCheckpoint(car) { this._postWhenReady({ type: 'rescue', id: car && car.id ? car.id : this.localId }); }
  // 兼容旧版 RacePhysics 的外部回调入口；正式比赛事件由 Worker 转发。
  onLap(car, lap, time, dirty = false) { if (car) this._emit('lap', { car, lap, time, dirty }); }
  onIncident(car, info = {}) { if (car) this._emit('incident', { car, info }); }
  finishCar(car) {
    if (!car) return;
    car.finished = true;
    if (car.ai) car.finishGhost = true;
    this._postWhenReady({ type: 'finish', id: car.id });
  }
  /**
   * 取一块远端样本缓冲。优先复用 Worker 归还的缓冲，避免 60Hz × N 车每包
   * `new Float32Array(...)` 造成的持续分配（GC 抖动会直接表现为远端车"顿一下"）。
   */
  _acquireRemoteBuffer(size) {
    for (let i = this._remotePool.length - 1; i >= 0; i--) {
      const b = this._remotePool[i];
      if (b.byteLength >= size * 4) {
        this._remotePool.splice(i, 1);
        return new Float32Array(b, 0, size);
      }
    }
    return new Float32Array(Math.max(REMOTE_STRIDE, size));
  }
  handleNetworkPacket(packet) {
    const rawList = packet.kind === 'snap' ? packet.packet?.p || [] : packet.kind === 'state' ? [packet.packet] : [];
    // 先计可用条目；不用 Array.prototype.filter —— 那会为每个 60Hz 网络包
    // 分配一个中间数组，正是本次要消除的垃圾来源。
    let count = 0;
    for (let i = 0; i < rawList.length; i++) {
      const e = rawList[i];
      if (e && e.d) count++;
    }
    if (!count) return;
    const a = this._acquireRemoteBuffer(count * REMOTE_STRIDE);
    let k = 0;
    for (let idx = 0; idx < rawList.length && k < count; idx++) {
      const e = rawList[idx];
      if (!e || !e.d) continue;
      const d = e.d, i = k * REMOTE_STRIDE, q = d.q || [], v = d.v || [];
      // Network supplies timestamps in the page's monotonic epoch.  The Worker
      // history is keyed by its own performance.now() epoch, so convert exactly
      // once at this boundary.
      a[i] = e.id; a[i+1] = n(packet.snapT, nowMono()) - Math.max(0, n(e.age)) - this._workerToMainMonoOffset;
      a[i+2] = n(d.x); a[i+3] = n(d.y); a[i+4] = n(d.z);
      for (let j=0;j<4;j++) a[i+5+j] = n(q[j], j===3 ? 1 : 0);
      for (let j=0;j<3;j++) a[i+9+j] = n(v[j]);
      a[i+12] = n(d.u); a[i+13] = n(d.b); a[i+14] = n(d.e); a[i+15] = n(d.h);
      a[i+16] = e.f || d.f ? 1 : 0; a[i+17] = n(d.l); a[i+18] = n(d.s);
      a[i+19] = n(d.gr); a[i+20] = n(d.go);
      a[i+21] = n(d.c, -1); a[i+22] = n(d.lt); a[i+23] = n(d.bl); a[i+24] = n(d.bc);
      a[i+25] = n(d.pen); a[i+26] = n(d.vio); a[i+27] = d.li ? 1 : 0; a[i+28] = n(d.pr);
      a[i+29] = d.cs ? 1 : 0; a[i+30] = n(d.lc); a[i+31] = n(d.ll); a[i+32] = n(d.ft); a[i+33] = n(d.tt);
      a[i+34] = n(e.seq);
      k++;
    }
    this._postWhenReady({ type:'remoteSamples', count, stride:REMOTE_STRIDE, renderDelay:n(packet.renderDelay,80), buffer:a.buffer }, [a.buffer]);
  }
  /**
   * 位姿上报（30Hz，Worker 拥有真实物理状态后由它驱动）。
   *
   * ★ 定点量化（问题 5：降低网络体积与序列化开销）
   *   此前 `JSON.stringify` 会把每个 double 写成 17~18 位十进制（"12.345678901234567"），
   *   一包 state 里 x/y/z + q(4) + v(3) + t 共 11 个浮点 ⇒ 光小数位就吃掉 ~150 字节，
   *   30Hz × 12 车在服务端就是每秒数千个 JSON 解析的对象更替。按**语义精度**量化后
   *   单包体积降约 1/3，而分辨率远细于任何下游判据：
   *     · 位置/姿态 r3 (1e-3)  —— 亚毫米级，远细于渲染插值与 0.03m 穿透容差
   *     · 四元数 r4 (1e-4)     —— 约 0.01°，SLERP 前还会归一化
   *     · 速度 r1 (0.1 m/s)、油门/刹车/转向 r2
   *     · 样条 p 用 r4 (1e-4 圈) —— 服务端通过时刻表分辨率是 1/1024 圈(约 6.6m)，
   *       1e-4 圈(约 0.19m) 比它细 30 倍 ⇒ 不改变任何切片判定
   */
  _publishNetwork(now) {
    if (!this.onNetwork || now - this._lastNetworkNow < 1000 / 30) return;
    this._lastNetworkNow = now;
    for (const c of this.cars) {
      if (c.remote) continue;
      const p = c.pos, q = c.quat, v = c.vel, cp = this.track?.checkpoints || [];
      const next = cp.length ? cp[((c.cpIdx + 1) % cp.length + cp.length) % cp.length] : null;
      const distNext = next?.pos ? Math.hypot(p.x-next.pos.x,p.z-next.pos.z) : 0;
      const count = this.track?.count || 1;
      // ⚠️ 发车格在起终点线**之前** ⇒ trackIdx ≈ count-k，原始归一化样条 p ≈ 0.98~0.99。
      //    原样上报会让服务端把"还没起步的车"当成已跑完 99% 圈来记录样条通过时刻，
      //    起步后头几秒的秒差列会按一个并不存在的 0.99 截面解算。
      //    未压过起终点线（crossedStart=false）时的这一整段统一钳为 0：
      //    语义 = "第 0 圈尚未开始"，与服务端 case "state" 里的同口径钳位互为冗余。
      const rawSpline = ((c.trackIdx % count) + count) % count / count;
      const spline = (!c.crossedStart && c.lap === 0 && rawSpline > 0.8) ? 0 : rawSpline;
      this.onNetwork({t:'state',id:c.id,seq:++this._networkSeq,d:{
        x:r3(p.x),y:r3(p.y),z:r3(p.z),
        q:[r4(q.x),r4(q.y),r4(q.z),r4(q.w)],
        v:[r1(v.x),r1(v.y),r1(v.z)],
        s:Math.round(c.speedKmh),t:r2(c.steerAngle),
        l:c.lap,c:c.cpIdx,n:r1(distNext),p:r4(spline),
        k:c.slip>0.5?1:0,f:c.finished?1:0,
        u:r2(c.throttle),b:r2(c.brake),e:r2(c.steer),h:c.handbrake?1:0,
        gr:c.ghostReasonCode,go:c.ghost,
        lt:r3(c.lapTimeLive),bl:r3(c.bestLap),bc:r3(c.bestCleanLap),
        pen:r2(c.penalty),vio:c.violations,li:c.lapInvalid?1:0,
        pr:r1(c.progress),cs:c.crossedStart?1:0,lc:c.lineCross,ll:r3(c.lastLap),
        ft:r3(c.finishTime),tt:r3(c.totalTime),
      }});
    }
  }
  _message(m) {
    if (m.type === 'ready') {
      this.ready = true;
      const workerNow = Number.isFinite(m.clockNow) ? m.clockNow : null;
      this._workerToMainMonoOffset = workerNow === null ? 0 : nowMono() - workerNow;
      this._resolveReady(m); this._emit('ready', m); return;
    }
    if (m.type === 'recycleInput' && m.buffer) { this._inputPool.push(new Float32Array(m.buffer)); return; }
    if (m.type === 'recycleRemote' && m.buffer) { this._remotePool.push(m.buffer); return; }
    if (m.type === 'network') { if (this.onNetwork) this.onNetwork(m.packet); this._emit('network', m.packet); return; }
    if (m.type === 'error') { const e = new Error(m.message || 'physics worker failure'); this._emit('error', e); if (!this.ready) this._rejectReady(e); return; }
    if (m.type === 'event') { this._applyEvent(m.name, m.payload || {}); return; }
    if (m.type === 'diagnostics') {
      const pending = this._diagnostics.get(m.id);
      if (pending) {
        this._diagnostics.delete(m.id); clearTimeout(pending.timer);
        m.error ? pending.reject(new Error(m.error)) : pending.resolve(m.data);
      }
      return;
    }
    if (m.type !== 'state' || !m.buffer) return;
    const a = new Float32Array(m.buffer);
    this.time = n(m.time); this.alpha = Math.max(0, Math.min(1, n(m.alpha)));
    this._stateNow = n(m.now, nowMono()) + this._workerToMainMonoOffset;
    const count = Math.min(m.count | 0, Math.floor(a.length / (m.stride || STATE_STRIDE)));
    const stride = m.stride || STATE_STRIDE;
    this.physicsStep = n(m.step, -1);
    this.lastContactDetails = Array.isArray(m.contactDetails) ? m.contactDetails : [];
    for (let k = 0; k < count; k++) {
      this._applyRecord(a, k * stride);
      const car = this.byId.get(Math.round(a[k * stride + STATE.ID]));
      if (car) {
        car.contact = !!((m.contactMask | 0) & (1 << k));
        car.terrainContact = !!((m.terrainContactMask | 0) & (1 << k));
        car.contactDetails = Array.isArray(m.contactDetails?.[k]) ? m.contactDetails[k] : [];
      }
    }
    this._publishNetwork(this._stateNow);
    this._emit('state', { seq: m.seq, now: m.now, count });
    this.worker.postMessage({ type: 'recycleState', buffer: m.buffer }, [m.buffer]);
  }
  _applyRecord(a, i) {
    const id = Math.round(a[i + STATE.ID]);
    const c = this.byId.get(id); if (!c) return;
    c.prevPos.set(a[i + STATE.PPX], a[i + STATE.PPY], a[i + STATE.PPZ]);
    c.prevQuat.set(a[i + STATE.PQX], a[i + STATE.PQY], a[i + STATE.PQZ], a[i + STATE.PQW]);
    c.pos.set(a[i + STATE.PX], a[i + STATE.PY], a[i + STATE.PZ]); c.quat.set(a[i + STATE.QX], a[i + STATE.QY], a[i + STATE.QZ], a[i + STATE.QW]);
    c.vel.set(a[i + STATE.VX], a[i + STATE.VY], a[i + STATE.VZ]); c.body.position = c.pos; c.body.quaternion = c.quat; c.body.velocity = c.vel;
    c.fwd.set(0, 0, 1).applyQuaternion(c.quat);
    c.up.set(0, 1, 0).applyQuaternion(c.quat);
    c.lateralDir.set(1, 0, 0).applyQuaternion(c.quat); c.rightSide.copy(c.lateralDir).multiplyScalar(-1);
    c.speed = a[i + STATE.SPEED]; c.speedKmh = a[i + STATE.SPEED_KMH]; c.speedKmhMeasured = a[i + STATE.SPEED_KMH_MEASURED];
    c.forwardSpeed = a[i + STATE.FORWARD_SPEED]; c.lateralSpeed = a[i + STATE.LATERAL_SPEED]; c.rpm = a[i + STATE.RPM]; c.gear = a[i + STATE.GEAR];
    c.lap = a[i + STATE.LAP]; c.bestLap = a[i + STATE.BEST_LAP]; c.lapTimeLive = a[i + STATE.LAP_TIME]; c.lastLap = a[i + STATE.LAST_LAP]; c.penalty = a[i + STATE.PENALTY]; c.violations = a[i + STATE.VIOLATIONS];
    c.slip = a[i + STATE.SLIP]; c.slipAngleDeg = a[i + STATE.SLIP_ANGLE]; c.slipRatio = a[i + STATE.SLIP_RATIO]; c.wheelspin = a[i + STATE.WHEELSPIN]; c.driftIntensity = a[i + STATE.DRIFT]; c.steerAngle = a[i + STATE.STEER_ANGLE]; c.ayPrev = a[i + STATE.AY_PREV];
    c.wrongWay = a[i + STATE.WRONG_WAY] > 0.5; c.trackIdx = a[i + STATE.TRACK_IDX]; c.lineCross = a[i + STATE.LINE_CROSS]; c.progressScore = a[i + STATE.PROGRESS]; c.ghost = a[i + STATE.GHOST]; c.ghostTimer = a[i + STATE.GHOST_TIMER];
    c.rescueGhost = a[i + STATE.RESCUE_GHOST] > 0.5; c.finishGhost = a[i + STATE.FINISH_GHOST] > 0.5; c.zoneGhost = a[i + STATE.ZONE_GHOST] > 0.5; c.finished = a[i + STATE.FINISHED] > 0.5; c.retired = a[i + STATE.RETIRED] > 0.5;
    c.totalTime = a[i + STATE.TOTAL_TIME]; c.finishTime = a[i + STATE.FINISH_TIME]; c.rank = a[i + STATE.RANK]; c.raceLocked = a[i + STATE.RACE_LOCKED] > 0.5; c.cpIdx = a[i + STATE.CP_IDX];
    for (let k = 0; k < 4; k++) c.wheelGroundY[k] = a[i + STATE.WGY0 + k];
    c.axMeasured = a[i + STATE.AX]; c.surface = a[i + STATE.SURFACE]; c.airborne = a[i + STATE.AIRBORNE] > 0.5;
    for (let k = 0; k < 4; k++) c.tireTemp[k] = a[i + STATE.TIRE_TEMP0 + k];
    c.tireGrip = a[i + STATE.TIRE_GRIP];
    c.ghostReasonCode = a[i + STATE.GHOST_REASON]; c.yawSpeed = a[i + STATE.YAW_SPEED];
    c.groundY = a[i + STATE.GROUND_Y]; c.suspCompression = a[i + STATE.SUSPENSION];
    c.pgGhost = a[i + STATE.PG_GHOST] > 0.5; c.curbH = a[i + STATE.CURB_H];
    c.lapInvalid = a[i + STATE.LAP_INVALID] > 0.5; c.bestCleanLap = a[i + STATE.BEST_CLEAN_LAP];
    c.progress = a[i + STATE.CHECKPOINT_PROGRESS]; c.crossedStart = a[i + STATE.CROSSED_START] > 0.5;
    if (!c.roadNormal) c.roadNormal = V3();
    c.roadNormal.set(a[i + STATE.ROAD_NX], a[i + STATE.ROAD_NY], a[i + STATE.ROAD_NZ]);
    c.throttle = a[i + STATE.THROTTLE]; c.brake = a[i + STATE.BRAKE]; c.steer = a[i + STATE.STEER]; c.handbrake = a[i + STATE.HANDBRAKE];
    // 本车输入意图归主线程所有，旧快照不可覆盖刚按下的按键。
    if (!c.isLocal) { c.input.throttle = c.throttle; c.input.brake = c.brake; c.input.steer = c.steer; c.input.handbrake = c.handbrake; }
    c._inputSeq = a[i + STATE.INPUT_SEQ];
  }
  _applyEvent(name, p) {
    const c = p.car && this.byId.get(p.car.id);
    if (c && p.car) Object.assign(c, p.car);
    if (name === 'penalty' && c) { c.lastPenaltyReason = p.reason || ''; if (!Number.isFinite(p.car?.penalty)) c.addPenalty(p.seconds, p.reason); }
    if (name === 'finish' && c) c.finished = true;
    this._emit(name, { ...p, car: c || (p.car ? this.byId.get(p.car.id) : null) });
  }
}

export { CarMirror };
