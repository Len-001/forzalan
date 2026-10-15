/* =============================================================================
 * network.js —— 局域网 WebSocket 同步 + 60Hz 快照插值（Snapshot Interpolation）
 *
 * 【为什么不能用"收到最新包就直接移动过去"】
 *   服务端 60Hz 广播，客户端渲染 60~144Hz，网络还会抖动。若把最新包的位置直接
 *   贴到车上，一旦丢包/抖动，远端车就会"瞬移向前闪现"，随后又"卡顿断层"。
 *
 * 【本实现：Jitter Buffer + 快照插值】
 *   · 每个远端车维护长度 64 的历史快照环形缓冲（时间戳 / 位置 / 四元数 / 线速度）
 *   · 自适应渲染延迟 RenderDelay = clamp(3σ, 60, 120)ms（σ = 近 1s 快照到达时差的标准差），
 *     永远回放"过去"的状态，于是任何抖动都发生在缓冲里，而不是发生在画面上
 *   · renderTime = 本地时钟 − RenderDelay，在缓冲里定位前后两个快照 SnapA / SnapB
 *   · 位置：Hermite 三次样条插值（用线速度作为端点切线，比线性 LERP 无折角）
 *   · 旋转：四元数 SLERP 球面插值
 *   · 缓冲里没有未来快照时：按最后快照的位置 + 速度做直线外推（Dead Reckoning），
 *     绝不停止也绝不瞬移
 *   · 新快照到达后：渲染位置以指数衰减向真实轨迹收敛（误差融合），杜绝生硬闪现
 *
 * 【时钟】
 *   比赛计时与快照时间戳都用服务端时钟。开局 6 次 ping/pong 取 RTT 最小样本估
 *   算 offset，使 serverNow() = Date.now() + offset；快照时间统一换算到本地时间轴。
 * ========================================================================== */

/* 渲染延迟：规格要求**弹性自适应** —— dynamicDelay = clamp(3σ, 60, 120)，
 * σ = 近 RENDER_WIN_MS 内快照到达时差的标准差。丢包/抖动大就自动加长缓冲，
 * 网络好就收紧以减少视觉滞后。冷启动（样本不足）先用 80ms 兜底，
 * 否则 σ=0 会直接把延迟压到下限 60ms，一上来就缓冲区击穿。 */
const RENDER_DELAY_DEFAULT = 80;  // 样本不足时的兜底渲染延迟 (ms)
const RENDER_DELAY_MIN = 60;      // 规格：3σ 下限 (ms)
const RENDER_DELAY_MAX = 120;     // 规格：3σ 上限 (ms)
const RENDER_WIN_MS = 1000;       // σ 统计窗口：近 1 秒
const RENDER_MIN_N = 8;           // 至少这么多次到达间隔才开始自适应
const CLOCK_WIN = 20;         // 规格：时钟样本滑窗长度 20（保留 RTT 最小的优质样本）
const BUF_LEN = 64;           // 环形缓冲槽数（约 1.07s @60Hz；时间跨度另限 2s）
const MAX_BUFFER_SPAN_MS = 2000;
const MAX_EXTRAP_MS = 250;    // 航位推测上限（超过就停住，避免"飞出去"）
const ERR_BLEND = 20;         // Dual-Layer 误差融合的衰减系数（1/s，规格：20.0）
const STATE_HZ = 60;          // 位姿上报频率（与 60Hz 广播同频，保证插值源足够密）

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const monoNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Hermite 三次样条：p(s) = h00·p0 + h10·m0·dt + h01·p1 + h11·m1·dt
 * 用端点线速度当切线 -> 速度连续，过弯时没有折角（线性 LERP 会有）。
 * @param {number} s 归一化时间比例 0..1
 * @param {number} dt 两快照的时间差（秒）
 */
function hermite(p0, m0, p1, m1, s, dt) {
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * p0 + h10 * m0 * dt + h01 * p1 + h11 * m1 * dt;
}

export class Net {
  constructor() {
    this.ws = null;
    this.url = '';
    this.myId = 0;
    this.handlers = new Map();
    this.players = new Map();      // id -> { id, buf:[], last:null, render:{} }
    this.roomCode = '';
    this.laps = 3;
    this.seed = 0;
    this.lobby = [];               // 服务端下发的玩家列表快照
    this.countdown = -1;
    this.connected = false;
    this.clockOffset = 0;
    this.bestRtt = Infinity;
    this.monoOffset = null;   // 服务端单调时钟 -> 本地时间轴的偏移；null 表示尚未同步
    this.clockWindow = [];    // 长度 10 的时钟样本滑窗 [{rtt, offset, mono}]，取最小 RTT 者
    this.renderDelay = RENDER_DELAY_DEFAULT;  // 自适应渲染延迟 (ms)
    this.jitterSigma = 0;     // 近 1s 快照到达时差的标准差 (ms)
    this._arrivals = [];      // 近 1s 的快照到达时刻（只保留窗口内）
    this._pingTimer = null;
    this._lastSend = 0;
    this._seq = 0;
    this._reconnect = 0;
    this._manualClose = false;
    this._rr = new Float32Array(3);
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._target = new THREE.Vector3();   // 本帧插值/外推得到的目标位置
    this._vtmp = new THREE.Vector3();     // 双层融合：矫正前的视觉位置
    this._qtmp = new THREE.Quaternion();  // 双层融合：矫正前的视觉姿态
    this._qid = new THREE.Quaternion();   // 恒等四元数
    this._interpDt = 1 / 60;              // 逐帧 dt（误差融合用）
    this._frameStamp = 0;
    this._workerInbound = null;
    this._worker = null;
  }

  /* --------------------------- 事件 --------------------------- */

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, data) {
    const arr = this.handlers.get(type);
    if (!arr) return;
    for (const fn of arr) {
      try { fn(data); } catch (e) { console.error('[net] handler error', type, e); }
    }
  }

  /* --------------------------- 连接 --------------------------- */

  connect(url) {
    this.url = url;
    this._manualClose = false;
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.emit('error', { msg: '无法建立 WebSocket 连接：' + e.message });
        resolve(false);
        return;
      }
      this.ws = ws;
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      ws.onopen = () => {
        this.connected = true;
        this._reconnect = 0;
        this.startClockSync();
        this.emit('open');
        done(true);
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.dispatch(m);
      };
      ws.onerror = () => {
        this.emit('error', { msg: '连接异常，请确认服务端仍在运行' });
        done(false);
      };
      ws.onclose = () => {
        this.connected = false;
        this.emit('close');
        done(false);
        if (!this._manualClose && this._reconnect < 6) {
          this._reconnect++;
          const wait = Math.min(4000, 400 * this._reconnect);
          setTimeout(() => { if (!this._manualClose) this.connect(this.url); }, wait);
          this.emit('reconnecting', { attempt: this._reconnect });
        }
      };
      setTimeout(() => done(false), 5000);
    });
  }

  close() {
    this._manualClose = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }

  /* --------------------------- 时钟同步 --------------------------- */

  startClockSync() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this.clockWindow = [];
    this.bestRtt = Infinity;
    // 开局 6 次快速采样（间隔 130ms）尽快收敛 offset，之后按规格以 1Hz 维持
    for (let i = 0; i < 6; i++) setTimeout(() => this.send({ t: 'ping', c: Date.now() }), i * 130);
    this._pingTimer = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 1000);
  }

  serverNow() { return Date.now() + this.clockOffset; }

  /** Connect the network protocol to the physics worker's remote proxy. */
  attachWorker(workerBridge) {
    this._worker = workerBridge || null;
    if (this._worker) {
      this._worker.onNetwork = (packet) => this.sendWorkerState(packet);
      this._workerInbound = (packet) => this._worker.handleNetworkPacket(packet);
    } else {
      this._workerInbound = null;
    }
    return this;
  }

  /** Worker-owned state source. The server keeps the existing `d` protocol. */
  sendWorkerState(packet) {
    if (!packet || packet.t !== 'state' || !packet.d) return false;
    const out = { t: 'state', id: packet.id, seq: packet.seq, d: packet.d };
    return this.send(out);
  }

  /**
   * 自适应抖动缓冲（规格 §3.2）。
   * 记录快照到达时刻，对**近 RENDER_WIN_MS 窗口内**的到达间隔求标准差 σ，
   * 再按 dynamicDelay = clamp(3σ, 60, 120) 伸缩渲染延迟：
   * 网络一抖就自动加长缓冲（防击穿断流），网络好就收紧（减少视觉滞后）。
   * 样本不足时维持兜底值 —— 冷启动 σ=0 会把延迟直接压到下限 60ms，反而更易被击穿。
   */
  _trackJitter(now) {
    const a = this._arrivals;
    a.push(now);
    while (a.length > 2 && now - a[0] > RENDER_WIN_MS) a.shift();
    if (a.length < RENDER_MIN_N) return;
    let sum = 0, n = 0;
    for (let i = 1; i < a.length; i++) { sum += a[i] - a[i - 1]; n++; }
    const mean = sum / n;
    let sq = 0;
    for (let i = 1; i < a.length; i++) { const d = (a[i] - a[i - 1]) - mean; sq += d * d; }
    this.jitterSigma = Math.sqrt(sq / n);
    this.renderDelay = clamp(3 * this.jitterSigma, RENDER_DELAY_MIN, RENDER_DELAY_MAX);
  }

  /* --------------------------- 收发 --------------------------- */

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 位姿上报，内部限频到 30Hz。track 可选：给定时用于解算 (cpIdx, distNext) */
  maybeSendState(car, now, track) {
    if (!car || car.remote) return;
    if (now - this._lastSend < 1000 / STATE_HZ) return;
    this._lastSend = now;
    const q = car.quat, p = car.pos, v = car.body.velocity;
    this._seq++;
    // 进度字段：c/n 是旧 Checkpoint 回退路径，p 是当前圈归一化样条弧长。
    // 权威秒差现在以 p 对应的服务端通过时刻为准；不再使用瞬时速度外推。
    const cpIdx = (typeof car.cpIdx === 'number') ? car.cpIdx : -1;
    let distNext = 0;
    if (track && track.checkpoints && track.checkpoints.length) {
      const n = track.checkpoints.length;
      const next = track.checkpoints[((cpIdx + 1) % n + n) % n];
      if (next && next.pos) distNext = Math.hypot(p.x - next.pos.x, p.z - next.pos.z);
    }
    const count = track && track.count > 0 ? track.count : 1;
    const trackIdx = (typeof car.trackIdx === 'number') ? car.trackIdx : 0;
    const spline = ((trackIdx % count) + count) % count / count;
    // 入力字段（规格 §四.2 观战入力回显）：throttle/brake/steer/handbrake。
    // 让已完赛/退赛的玩家在观战时能看到被观战车手的实时操控（键盘 + 踏板条）。
    // steer 取 [-1,1]（input.steer 已是该区间），油门/刹车 [0,1]。
    const inp = car.input || {};
    this.send({
      t: 'state',
      seq: this._seq,
      d: {
        x: r3(p.x), y: r3(p.y), z: r3(p.z),
        q: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
        v: [r1(v.x), r1(v.y), r1(v.z)],
        s: Math.round(car.speedKmh),
        t: r2(car.steerAngle),
        l: car.lap,
        c: cpIdx,
        n: r1(distNext),
        p: r3(spline),
        k: car.slip > 0.5 ? 1 : 0,
        f: car.finished ? 1 : 0,
        // 入力遥测（供观战回显）
        u: r2(clamp01(inp.throttle)),
        b: r2(clamp01(inp.brake)),
        e: r2(clamp(inp.steer, -1, 1)),
        h: (inp.handbrake ? 1 : 0),
      },
    });
  }

  dispatch(m) {
    switch (m.t) {
      // 服务端发起的延迟探测（用于在房间里显示**每个玩家**的毫秒数）。
      // 客户端只负责原样回显 nonce `c`，RTT 由服务端用"发出→收回"的时间差计算，
      // 因此玩家无法伪造自己的延迟。与时钟同步用的 ping/pong 是两条独立通道。
      case 'sping': {
        this.send({ t: 'spong', c: m.c });
        return;
      }
      case 'pong': {
        const t4 = Date.now();
        const t1 = m.c;
        const hasNtp = typeof m.t2 === 'number' && typeof m.t3 === 'number';
        // NTP 公式（规格）：
        //   RTT    = (t4 - t1) - (t3 - t2)      —— 剔除服务端处理时长
        //   Offset = ((t2 - t1) + (t3 - t4)) * 0.5
        // 没有 t2/t3 的旧服务端退化到 s - 中点（同一结果的特例）。
        const rtt = hasNtp ? Math.max(0, (t4 - t1) - (m.t3 - m.t2)) : (t4 - t1);
        const offset = hasNtp
          ? ((m.t2 - t1) + (m.t3 - t4)) * 0.5
          : (m.s - (t1 + rtt / 2));
        const mid = t1 + (t4 - t1) / 2;
        // 规格：维护长度 20 的滑窗，只认 RTT 最小的优质样本。
        // Wi-Fi 偶发抖动会把个别 RTT 抬高几十毫秒，直接平均会被毛刺污染。
        this.clockWindow.push({
          rtt,
          offset,
          mono: typeof m.m === 'number' ? m.m - mid : null,   // 单调时钟（不受 NTP 校时影响）
        });
        if (this.clockWindow.length > CLOCK_WIN) this.clockWindow.shift();
        let best = this.clockWindow[0];
        for (const s2 of this.clockWindow) if (s2.rtt < best.rtt) best = s2;
        this.bestRtt = best.rtt;
        this.clockOffset = best.offset;
        if (Number.isFinite(best.mono)) this.monoOffset = best.mono;
        this.emit('clock', { rtt, offset: this.clockOffset });
        break;
      }
      case 'hello':
        this.myId = m.id;
        this.clockOffset = m.s - Date.now();
        this.emit('hello', m);
        break;
      case 'room':
        this.roomCode = m.room;
        this.laps = m.laps;
        this.seed = m.seed;
        this.lobby = m.players || [];
        this.emit('room', m);
        break;
      case 'count':
        this.countdown = m.n;
        this.emit('count', m);
        break;
      // ── 规格 §一：服务端权威倒计时状态机（客户端绝不自行计时）──
      // START_SEQUENCE_BEGIN   全员载入 -> 开始下发倒计时序列
      // COUNTDOWN_TICK {val}   严格 1000ms 间隔单发：3 -> 2 -> 1
      // RACE_START             归零 -> 放行（**绝不缺失**）
      // 三条各自独立转发：main.js 侧再做 4.5s 本地兜底，任何一条丢失都能兜住。
      case 'START_SEQUENCE_BEGIN': this.emit('startSeq', m); break;
      case 'COUNTDOWN_TICK': this.emit('tick', m); break;
      case 'lights': this.emit('lights', m); break;
      case 'RACE_START': this.emit('raceStart', m); break;
      case 'start':
        this.countdown = -1;
        this.seed = m.seed;
        this.laps = m.laps;
        this.emit('start', m);
        break;
      case 'snap': {
        const now = Date.now();
        this._trackJitter(now);       // 自适应抖动缓冲：先按到达抖动刷新渲染延迟
        // 快照时间轴优先用**服务端单调时钟**（mts）换算到本地时间轴：
        // 单调时钟不受 NTP 校时/系统改时间影响，也不会因网络接收抖动而失真。
        const snapT = (Number.isFinite(m.mts) && Number.isFinite(this.monoOffset))
          ? (m.mts - this.monoOffset)
          : (Number.isFinite(m.ts) ? (m.ts - this.clockOffset) : now);
        if (this._workerInbound) {
          // snapT/now are both local wall-clock values.  Convert their delta
          // onto the page monotonic epoch before crossing into the Worker.
          const receivedAt = monoNow();
          const localMonoT = receivedAt + (snapT - now);
          this._workerInbound({ kind: 'snap', packet: m, snapT: localMonoT, receivedAt, renderDelay: this.renderDelay });
        }
        // 入力遥测（规格 §四.2）：从位姿包里抽出 u/b/e/h，供观战回显使用。
        // 只在 onInputTelemetry 回调存在时才做，避免无谓的对象分配。
        const tele = this._inputTelemetry;
        for (const entry of m.p) {
          if (!this._workerInbound) this.pushState(entry.id, entry.d, now, entry.f, snapT - Math.max(0, Number(entry.age) || 0));
          if (tele && entry.d) {
            tele(entry.id, entry.d.u, entry.d.b, entry.d.e, entry.d.h);
          }
        }
        this.emit('snap', m);
        break;
      }
      // Some server revisions forward bot/host state as a direct packet instead
      // of wrapping it in a snap. Keep that path worker-owned as well.
      case 'state': {
        if (this._workerInbound && m.id && m.d) {
          // 直传 state 的 ts 属于发送者的进程时间，不是本机时钟。
          const receivedAt = monoNow();
          this._workerInbound({ kind: 'state', packet: m, snapT: receivedAt, receivedAt, renderDelay: this.renderDelay });
        }
        break;
      }
      // 服务端权威榜单（20Hz）。字段：id/name/color/pos/lap/pen/fin/gap/int
      case 'LEADERBOARD_UPDATE': this.emit('leaderboard', m.data || []); break;
      case 'pen': this.emit('pen', m); break;
      case 'lap': this.emit('lap', m); break;
      case 'fin': this.emit('fin', m); break;
      case 'dnf': this.emit('dnf', m); break;
      case 'end': this.emit('end', m); break;
      // ── 规格 §二：全员完赛结算流 ──
      // RACE_RESULTS             全量完赛者（rank/name/bestLap/totalTime/points）
      // SEASON_LEADERBOARD_UPDATE 赛季榜最新快照（首页/大厅右侧实时重渲染）
      case 'RACE_RESULTS': this.emit('raceResults', m); break;
      case 'SEASON_LEADERBOARD_UPDATE': this.emit('seasonUpdate', m); break;
      case 'presence': this.emit('presence', m); break;
      case 'lobby': this.emit('lobby', m); break;
      case 'left': this.emit('left', m); break;
      // 一体化聊天总线（规格 §一.1）：
      // 玩家发言与系统事件/倒计时广播共用同一条 CHAT_MESSAGE 通道，
      // 因此倒计时消息天然与聊天行同层渲染 —— 不可能被任何面板遮挡（根因修复）。
      // 这里只做纯转发，不发任何网络请求；渲染与 XSS 防御全部在 main.js。
      case 'CHAT_MESSAGE': this.emit('chat', m); break;
      case 'err':
        console.warn('[net] 服务端:', m.msg);
        this.emit('serverError', m);
        break;
      default: break;
    }
  }

  /* --------------------------- 快照环形缓冲 --------------------------- */

  /**
   * 为某个远端玩家建立长度 64 的历史快照环形缓冲（规格）。
   * 全部用 TypedArray，零 GC；索引 k（0 = 最旧）-> 实际槽位。
   */
  ensurePlayer(id) {
    let p = this.players.get(id);
    if (!p) {
      p = {
        id,
        T: new Float64Array(BUF_LEN),      // 快照时间（本地时间轴，已扣除 clockOffset）
        P: new Float32Array(BUF_LEN * 3),  // 位置
        Q: new Float32Array(BUF_LEN * 4),  // 四元数
        V: new Float32Array(BUF_LEN * 3),  // 线速度（Hermite 切线 / 航位推测）
        M: new Float32Array(BUF_LEN * 2),  // speed(km/h), steer
        F: new Int32Array(BUF_LEN * 2),    // lap, slip
        head: 0, count: 0, lastT: -1e18,
        render: {
          pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
          // Dual-Layer（ForzaTech，规格 §一.3）：
          //   phys* = 物理层权威状态（直接矫正为网络数据）
          //   visual*Offset = 视觉平滑层偏移量（吸收矫正差值，exp(-20·dt) 衰减）
          physPos: new THREE.Vector3(), physRot: new THREE.Quaternion(),
          visualPosOffset: new THREE.Vector3(), visualRotOffset: new THREE.Quaternion(),
          speed: 0, steer: 0, lap: 0, slip: 0, finished: false,
        },
        has: false,
        extrapolating: false,
      };
      this.players.set(id, p);
    }
    return p;
  }

  /** 取第 k 个最旧快照的实际槽位 */
  slot(p, k) { return ((p.head - p.count + k) % BUF_LEN + BUF_LEN) % BUF_LEN; }

  /**
   * 写入一帧快照。serverTs 为服务端时间戳（毫秒）；换算到本地时间轴后入队。
   * 乱序包（时间戳早于队尾）直接丢弃 —— 单条 WebSocket 本就有序，这里是防御。
   */
  pushState(id, d, recv, finished, snapTimeLocal) {
    const p = this.ensurePlayer(id);
    // snapTimeLocal 已由 dispatch 换算到本地时间轴；缺失时退化到本地接收时间
    const t = (typeof snapTimeLocal === 'number' && isFinite(snapTimeLocal)) ? snapTimeLocal : recv;
    if (!Number.isFinite(t) || t < p.lastT) return;
    // 同一时间戳的广播可能补充完赛标记或输入遥测；按 Worker 缓冲语义
    // 替换队尾，不新增一个重复时间点。
    const replacing = p.count > 0 && t === p.lastT;
    const i = replacing ? (p.head - 1 + BUF_LEN) % BUF_LEN : p.head;
    p.T[i] = t;
    p.P[i * 3] = d.x; p.P[i * 3 + 1] = d.y; p.P[i * 3 + 2] = d.z;
    p.Q[i * 4] = d.q[0]; p.Q[i * 4 + 1] = d.q[1]; p.Q[i * 4 + 2] = d.q[2]; p.Q[i * 4 + 3] = d.q[3];
    p.V[i * 3] = d.v ? d.v[0] : 0; p.V[i * 3 + 1] = d.v ? d.v[1] : 0; p.V[i * 3 + 2] = d.v ? d.v[2] : 0;
    p.M[i * 2] = d.s || 0; p.M[i * 2 + 1] = d.t || 0;
    p.F[i * 2] = d.l || 0; p.F[i * 2 + 1] = d.k || 0;
    if (!replacing) {
      p.head = (p.head + 1) % BUF_LEN;
      if (p.count < BUF_LEN) p.count++;
    }
    p.lastT = t;
    p.finished ||= !!finished || !!d.f;
    while (p.count > 1 && t - p.T[this.slot(p, 0)] > MAX_BUFFER_SPAN_MS) p.count--;
    this.emit('state', { id, sample: { t } });
  }

  /**
   * 取某台远端车在当前渲染时刻的位姿。
   *   renderTime = 本地 now − 50ms
   *   夹在 SnapA/SnapB 之间 -> Hermite 位置插值 + SLERP 旋转插值
   *   超出最新快照 -> 按速度直线外推（Dead Reckoning）
   *   最后统一做指数误差融合，杜绝闪现
   */
  beginFrame(now) {
    const prev = this._frameStamp || (now - 16);
    this._interpDt = clamp((now - prev) / 1000, 0.001, 0.05);
    this._frameStamp = now;
  }

  renderState(id, now) {
    const p = this.players.get(id);
    if (!p || p.count === 0) return null;
    const r = p.render;
    const rt = now - this.renderDelay;      // 自适应延迟（clamp(3σ,60,120)）

    // ---- 定位夹帧：找到最后一个 T <= rt 的快照 ----
    let ka = -1;
    for (let k = p.count - 1; k >= 0; k--) {
      if (p.T[this.slot(p, k)] <= rt) { ka = k; break; }
    }
    const sb = ka + 1 < p.count ? this.slot(p, ka + 1) : -1;
    const sa = ka >= 0 ? this.slot(p, ka) : -1;

    if (sa >= 0 && sb >= 0) {
      // ================= 区间内：Hermite + SLERP =================
      const t0 = p.T[sa], t1 = p.T[sb];
      const span = Math.max(t1 - t0, 1e-4);
      const s = clamp((rt - t0) / span, 0, 1);
      const dtS = span / 1000;                       // 秒
      r.pos.set(
        hermite(p.P[sa * 3], p.V[sa * 3], p.P[sb * 3], p.V[sb * 3], s, dtS),
        hermite(p.P[sa * 3 + 1], p.V[sa * 3 + 1], p.P[sb * 3 + 1], p.V[sb * 3 + 1], s, dtS),
        hermite(p.P[sa * 3 + 2], p.V[sa * 3 + 2], p.P[sb * 3 + 2], p.V[sb * 3 + 2], s, dtS)
      );
      this._qa.set(p.Q[sa * 4], p.Q[sa * 4 + 1], p.Q[sa * 4 + 2], p.Q[sa * 4 + 3]);
      this._qb.set(p.Q[sb * 4], p.Q[sb * 4 + 1], p.Q[sb * 4 + 2], p.Q[sb * 4 + 3]);
      r.quat.copy(this._qa).slerp(this._qb, s);
      r.speed = p.M[sa * 2] + (p.M[sb * 2] - p.M[sa * 2]) * s;
      r.steer = p.M[sa * 2 + 1] + (p.M[sb * 2 + 1] - p.M[sa * 2 + 1]) * s;
      r.lap = p.F[sb * 2]; r.slip = p.F[sb * 2 + 1];
      p.extrapolating = false;
      this._target.set(r.pos.x, r.pos.y, r.pos.z);
    } else if (ka < 0) {
      // rt 早于最旧快照（刚接入/时钟跳变）：直接用最旧一帧，不插值
      const s0 = this.slot(p, 0);
      this._target.set(p.P[s0 * 3], p.P[s0 * 3 + 1], p.P[s0 * 3 + 2]);
      this._qa.set(p.Q[s0 * 4], p.Q[s0 * 4 + 1], p.Q[s0 * 4 + 2], p.Q[s0 * 4 + 3]);
      r.quat.copy(this._qa);
      r.speed = p.M[s0 * 2]; r.steer = p.M[s0 * 2 + 1];
      r.lap = p.F[s0 * 2]; r.slip = p.F[s0 * 2 + 1];
      p.extrapolating = false;
    } else {
      // ================= 超出最新快照：直线航位推测 =================
      const last = this.slot(p, p.count - 1);
      const dtMs = clamp(rt - p.T[last], 0, MAX_EXTRAP_MS);
      const dt = dtMs / 1000;
      this._target.set(
        p.P[last * 3] + p.V[last * 3] * dt,
        p.P[last * 3 + 1] + p.V[last * 3 + 1] * dt,
        p.P[last * 3 + 2] + p.V[last * 3 + 2] * dt
      );
      this._qa.set(p.Q[last * 4], p.Q[last * 4 + 1], p.Q[last * 4 + 2], p.Q[last * 4 + 3]);
      r.quat.copy(this._qa);
      r.speed = p.M[last * 2]; r.steer = p.M[last * 2 + 1];
      r.lap = p.F[last * 2]; r.slip = p.F[last * 2 + 1];
      p.extrapolating = true;
    }
    r.finished = p.finished;

    // ---- ForzaTech Dual-Layer Error Blending（规格 §一.3）----
    // 物理层 = 上面分支算出的插值/外推目标（权威）；视觉层 = 带偏移量的平滑壳。
    // 矫正前后产生的位移/姿态差值**吸收进偏移量**，再用 exp(-20·dt) 衰减消解 ——
    // 网络纠偏时画面是"滑过去"而不是"跳过去"，且**姿态也平滑**
    // （旧版只对位置做指数收敛，姿态是直接瞬甩的）。
    if (!p.has) {
      // 首次出现：物理层直接落位，偏移清零
      r.physPos.copy(this._target);
      r.physRot.copy(r.quat);
      r.visualPosOffset.set(0, 0, 0);
      r.visualRotOffset.identity();
      p.has = true;
    } else {
      // 记录矫正前的视觉空间状态
      const curVisualPos = this._vtmp.copy(r.physPos).add(r.visualPosOffset);
      const curVisualRot = this._qtmp.copy(r.physRot).multiply(r.visualRotOffset);
      // 物理层直接矫正为新数据
      r.physPos.copy(this._target);
      r.physRot.copy(r.quat);
      // 把矫正前后的差值吸收进视觉偏移
      // Always absorb corrections into the visual shell. The worker bounds
      // extrapolation and keeps rescue/teleport semantics explicit in state;
      // the renderer must never produce a hard distance-based visual jump.
      r.visualPosOffset.copy(curVisualPos).sub(r.physPos);
      r.visualRotOffset.copy(r.physRot).invert().multiply(curVisualRot);
    }
    // 每帧衰减消解（规格系数 20.0）
    const bf = Math.exp(-ERR_BLEND * this._interpDt);
    r.visualPosOffset.multiplyScalar(bf);
    r.visualRotOffset.slerp(this._qid, 1 - bf);
    // 最终提交给渲染的变换 = 物理层 + 视觉偏移
    r.pos.copy(r.physPos).add(r.visualPosOffset);
    r.quat.copy(r.physRot).multiply(r.visualRotOffset);
    return r;
  }

  dropPlayer(id) { this.players.delete(id); }
  reset() { this.players.clear(); this.countdown = -1; this.lobby = []; }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
// 入力遥测字段的夹取（防止 NaN 或越界值污染报文的 JSON）。
// 注意：本文件顶部已有通用 clamp(v,a,b)，这里只补一个 [0,1] 版本。
const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);
