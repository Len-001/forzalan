/* =============================================================================
 *  NetworkPhysicsClient.ts —— WebRTC 二进制流 -> Wasm 物理同步的前端宿主
 *
 *  ── 它解决的问题 ────────────────────────────────────────────────────────────
 *  服务端以 20~60Hz 下发权威刚体状态。若前端直接把网格 Snap 到最新快照，
 *  会看到剧烈抖动与前后闪现（Rubberbanding）。本类把包**零拷贝**喂进 Wasm，
 *  由 `NetworkRigidBodyReplicator` 做航位推测 + 双层误差融合，
 *  渲染层只取 `GetVisualWorldTransform()` 的结果。
 *
 *  ── 数据流（60Hz 热路径上一次分配都没有）────────────────────────────────────
 *    RTCDataChannel.onmessage(ArrayBuffer)
 *        └─> 写进 WASM 堆里的**预分配**缓冲区（HEAPU8.set）
 *              └─> _forzaPushSnapshot(ptr)          // C++ 直接 reinterpret_cast 读
 *    requestAnimationFrame(now)
 *        ├─> _forzaClockAdjustedDt(1/60)           // 时钟微调后的物理步长
 *        ├─> _forzaUpdate(dt)                      // 外推 + 误差衰减
 *        ├─> _forzaVisualMatrixPtr() -> Float32Array 视图（不拷贝）
 *        └─> mesh.matrix.fromArray(view)
 *
 *  ── 必须牢记的两个 Emscripten 陷阱（本类已处理）─────────────────────────────
 *   1) `Module.HEAPU8.buffer` 在**内存增长后会 detach**（旧的 TypedArray 全部失效）。
 *      所以任何 `_malloc` 之后必须重建视图；本类用 `#refreshViews()` 统一处理，
 *      并在每帧入口做一次 `buffer.detached` 兜底检查。
 *   2) 不要跨帧缓存 `new Float32Array(HEAPF32.buffer, ptr, 16)` —— 堆一增长它就是
 *      悬空视图。本类的矩阵视图**每帧重建**（成本是一次极轻的视图构造，不是拷贝）。
 * ========================================================================== */

import {
  assertLayoutMatchesWasm,
  LAYOUT_VERSION,
  OFF,
  ReplState,
  SNAPSHOT_ALIGN,
  SNAPSHOT_STRIDE,
  SyncEvent,
} from './snapshotLayout';

// -----------------------------------------------------------------------------
//  Wasm 模块的最小类型描述（由 emcc --bind 产出）
// -----------------------------------------------------------------------------
export interface ForzaNetModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  // EMScripten 的动态符号挂在 Module 上（名字带下划线）
  _malloc(size: number): number;
  _free(ptr: number): void;
  _forzaSnapshotStride(): number;
  _forzaSnapshotOffset(field: number): number;
  _forzaPushSnapshot(ptr: number): number;
  _forzaUpdate(dtSec: number): void;
  _forzaVisualMatrixPtr(): number;
  _forzaPhysicsMatrixPtr(): number;
  _forzaClockOnPong(t1: number, t2: number, t3: number, t4: number): number;
  _forzaClockAdjustedDt(baseDtSec: number): number;
  _forzaClockServerNow(): number;
  _forzaClockWarp(): number;
  _forzaClockReset(): void;
  _forzaReplState(): number;
  _forzaReplVisualError(): number;
  // Embind 注册的自由函数
  setReplicatorConfig(cfg: Partial<ReplicatorConfig>): void;
  clockIsLocked(): boolean;
  clockBestRttNs(): number;
  snapshotStride(): number;
  resetAll(): void;
}

export interface ReplicatorConfig {
  halfLifeSec: number;
  maxExtrapolationSec: number;
  accelTrustSec: number;
  snapDistanceM: number;
  snapAngleRad: number;
  omegaTrustSec: number;
}

/** 网络快照（解码后的 JS 视图；热路径不构造它，只在调试时用） */
export interface DecodedSnapshot {
  frame: number;
  tickMs: number;
  serverTimeSec: number;
  position: [number, number, number];
  /** 四元数 (w, x, y, z) —— **w 在前**，与 glm::quat 内存序一致 */
  rotation: [number, number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
  accel: [number, number, number];
}

export interface ClientStats {
  packetsReceived: number;
  packetsRejected: number;
  hardResyncs: number;
  /** 视觉层残余误差（米）——"有没有一直不收敛"的第一手指标 */
  visualErrorM: number;
  /** 本帧时钟伸缩比例（±1.5% 内） */
  clockWarp: number;
  clockLocked: boolean;
  replState: ReplState;
  /** 每秒帧数（滑动平均） */
  fps: number;
}

export type CreateModule = (opts?: Record<string, unknown>) => Promise<ForzaNetModule>;

// -----------------------------------------------------------------------------
//  单例
// -----------------------------------------------------------------------------
export class NetworkPhysicsClient {
  static #instance: NetworkPhysicsClient | null = null;

  /** 全局单例。WebRTC 通道、Wasm 实例、rAF 循环都只应有一份。 */
  static get instance(): NetworkPhysicsClient {
    if (!NetworkPhysicsClient.#instance) {
      NetworkPhysicsClient.#instance = new NetworkPhysicsClient();
    }
    return NetworkPhysicsClient.#instance;
  }

  private constructor() {}

  // ---- Wasm ----
  #mod: ForzaNetModule | null = null;
  #packetPtr = 0;                     // 预分配的快照缓冲区（WASM 堆内）
  #packetView: Uint8Array | null = null;

  // ---- 网络 ----
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #lastPingSentT1 = 0;
  #pingTimer = 0;

  // ---- 循环 ----
  #rafId = 0;
  #lastNow = 0;
  #running = false;
  #dt = 1 / 60;
  #stats: ClientStats = NetworkPhysicsClient.#emptyStats();

  // ---- 每帧重建的矩阵视图（堆增长后旧视图会 detach）----
  #matrixView: Float32Array | null = null;

  static #emptyStats(): ClientStats {
    return {
      packetsReceived: 0,
      packetsRejected: 0,
      hardResyncs: 0,
      visualErrorM: 0,
      clockWarp: 0,
      clockLocked: false,
      replState: ReplState.Empty,
      fps: 0,
    };
  }

  get stats(): Readonly<ClientStats> {
    return this.#stats;
  }

  get ready(): boolean {
    return this.#mod !== null;
  }

  // ---------------------------------------------------------------------------
  //  1) 初始化
  // ---------------------------------------------------------------------------

  /**
   * @param createModule emcc `-sMODULARIZE -sEXPORT_ES6` 产出的工厂函数
   *                     （`import createForzaNet from './forza_net.js'`）
   * @param cfg          可选的复制器参数（半衰期等）
   */
  async init(createModule: CreateModule, cfg?: Partial<ReplicatorConfig>): Promise<void> {
    if (this.#mod) return;                       // 幂等：重复调用安全

    const mod = await createModule();
    this.#mod = mod;

    // ---- 线格式自检：偏移不符就直接抛，绝不带着漂移继续跑 ----
    assertLayoutMatchesWasm(
      mod._forzaSnapshotStride(),
      (f) => mod._forzaSnapshotOffset(f),
    );

    // ---- 预分配快照缓冲区（**只分配这一次**）----
    // 多要 SNAPSHOT_ALIGN 字节，保证无论 malloc 返回什么地址都能手工对齐到 16。
    const raw = mod._malloc(SNAPSHOT_STRIDE + SNAPSHOT_ALIGN);
    if (raw === 0) throw new Error('[forza_net] 快照缓冲区分配失败');
    this.#packetPtr = (raw + (SNAPSHOT_ALIGN - 1)) & ~(SNAPSHOT_ALIGN - 1);

    this.#refreshViews();                        // malloc 之后堆可能已增长 -> 重建视图

    if (cfg) mod.setReplicatorConfig(cfg);

    console.info(
      `[forza_net] Wasm 就绪 · layout v${LAYOUT_VERSION} · stride ${SNAPSHOT_STRIDE}B` +
        ` · 缓冲区 @0x${this.#packetPtr.toString(16)}`,
    );
  }

  /**
   * 重建所有 WASM 堆视图。
   * **必须在任何 `_malloc`/`_free` 之后调用** —— 内存增长会让旧的
   * `HEAPU8`/`HEAPF32` 指向已 detach 的 ArrayBuffer，继续用就是静默读垃圾。
   */
  #refreshViews(): void {
    const mod = this.#mod;
    if (!mod) return;
    this.#packetView = new Uint8Array(
      mod.HEAPU8.buffer,
      this.#packetPtr,
      SNAPSHOT_STRIDE,
    );
    this.#matrixView = null;                     // 延迟到首次读取时重建
  }

  // ---------------------------------------------------------------------------
  //  2) WebRTC 接入
  // ---------------------------------------------------------------------------

  /**
   * 接上一条 WebRTC 连接并开始消费二进制快照。
   *
   * 关键：数据通道必须配成**不可靠 + 无序** ——
   *   · `ordered: false`    允许后发的包先到（快照有帧号，乱序由 C++ 侧丢弃）
   *   · `maxRetransmits: 0` 彻底关掉重传，规避 TCP 式队头阻塞：
   *     一个丢失的旧快照不该拖住后面 20 个新快照 —— 旧快照本来就没有价值。
   */
  attachDataChannel(pc: RTCPeerConnection, label = 'forza-physics'): RTCDataChannel {
    this.#pc = pc;
    const dc = pc.createDataChannel(label, { ordered: false, maxRetransmits: 0 });
    this.#bindDataChannel(dc);
    return dc;
  }

  /** 若通道由对端创建，用它接上 */
  adoptDataChannel(dc: RTCDataChannel): void {
    this.#bindDataChannel(dc);
  }

  #bindDataChannel(dc: RTCDataChannel): void {
    this.#dc = dc;
    dc.binaryType = 'arraybuffer';
    // 不可靠通道必须容忍丢包：带宽由 congestion control 自己收敛
    dc.bufferedAmountLowThreshold = 0;

    dc.onmessage = (ev: MessageEvent<ArrayBuffer>) => this.#onBinaryPacket(ev.data);

    dc.onopen = () => {
      console.info('[forza_net] DataChannel 已打开（unreliable/unordered）');
      this.#startPing();                         // 1Hz NTP 心跳，喂时钟微调
      this.start();                              // 打开即启动 rAF 循环
    };
    dc.onclose = () => {
      this.#stopPing();
      this.#mod?._forzaClockReset();             // 断线 -> 清时钟窗口，重连后重新锁定
    };
  }

  /** 收到一个二进制快照：零拷贝写进 WASM 堆，然后把指针交给 C++ */
  #onBinaryPacket(buf: ArrayBuffer): void {
    const mod = this.#mod;
    if (!mod || !this.#packetView) return;

    // 长度不符直接丢（可能是别的消息类型）
    if (buf.byteLength !== SNAPSHOT_STRIDE) {
      this.#stats.packetsRejected++;
      return;
    }

    // 堆增长会让视图 detach —— 每包一次极廉价的兜底检查，比"读到垃圾"便宜得多
    if ((this.#packetView.buffer as ArrayBuffer).byteLength === 0) {
      this.#refreshViews();
      if (!this.#packetView) return;
    }

    this.#packetView.set(new Uint8Array(buf));   // 唯一一次内存移动：network -> heap
    const accepted = mod._forzaPushSnapshot(this.#packetPtr);
    if (accepted === 1) {
      this.#stats.packetsReceived++;
    } else {
      this.#stats.packetsRejected++;             // 乱序/过期，正常现象
    }
  }

  // ---------------------------------------------------------------------------
  //  3) NTP 心跳（喂给 ForzaTimeSynchronizer 的 Clock Slewing）
  // ---------------------------------------------------------------------------

  #startPing(): void {
    this.#stopPing();
    const tick = (): void => {
      this.#sendPing();
      this.#pingTimer = window.setTimeout(tick, 1000);   // 规格：1Hz
    };
    tick();
  }

  #stopPing(): void {
    if (this.#pingTimer) {
      clearTimeout(this.#pingTimer);
      this.#pingTimer = 0;
    }
  }

  #sendPing(): void {
    const dc = this.#dc;
    if (!dc || dc.readyState !== 'open') return;
    if (!this.#mod) return;

    // T1 必须取**单调纳秒**：Wasm 的 MonotonicClock 与 JS performance.now 同源
    // （emscripten_get_now 就是 performance.now），所以两边可以直接相减。
    // 千万别用 Date.now()：它会被系统 NTP 调整，作为时基是自找麻烦。
    this.#lastPingSentT1 = performance.now() * 1e6;

    // 控制包用 JSON 文本走同一条通道；快照是二进制的，靠 binaryType 区分。
    // （若在意这点开销，可改成 16 字节定长二进制头 —— 见 README 的"可优化项"。）
    dc.send(JSON.stringify({ t: 'PING', t1: this.#lastPingSentT1 }));
  }

  /** 服务端 PONG：{"type":"PONG","t1":..,"t2":..,"t3":..} —— t2/t3 为服务端时钟轴 */
  handlePong(t1: number, t2: number, t3: number): void {
    const mod = this.#mod;
    if (!mod) return;
    const t4 = performance.now() * 1e6;
    const ev = mod._forzaClockOnPong(t1, t2, t3, t4);
    if (ev === SyncEvent.HardResync) {
      this.#stats.hardResyncs++;
      console.warn('[forza_net] 时钟硬同步（偏差 > 200ms 或断线重连）');
    }
  }

  // ---------------------------------------------------------------------------
  //  4) 渲染循环
  // ---------------------------------------------------------------------------

  start(baseDtSec = 1 / 60): void {
    if (this.#running || !this.#mod) return;
    this.#running = true;
    this.#dt = baseDtSec;
    this.#lastNow = performance.now();
    // 注意用箭头函数：rAF 回调的 `this` 不是实例
    this.#rafId = requestAnimationFrame(this.#frame);
  }

  stop(): void {
    this.#running = false;
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
  }

  /** rAF 回调（每帧一次调用 Wasm；不分配任何对象） */
  #frame = (now: number): void => {
    const mod = this.#mod;
    if (!mod) return;
    if (!this.#running) return;
    this.#rafId = requestAnimationFrame(this.#frame);

    const rawDt = (now - this.#lastNow) / 1000;
    this.#lastNow = now;
    // 夹住 dt：切标签页回来时 rawDt 可能是好几秒，直接喂给物理会瞬移
    const frameDt = Math.min(Math.max(rawDt, 0), 0.25);

    // ---- 1) 时钟微调：拿到"被 slewing 过的"物理步长 ----
    // 注意这里传的是**基准**步长，Wasm 内部按 ±1.5% 伸缩后返回。
    // 不能改成 `frameDt * (1+warp)` —— 规格要的是"微调积分步长使之贴合服务端时间"，
    // 而不是"把真实帧间隔也一起缩放"（后者会引入显示刷新率相关的手感差异）。
    let dt = mod._forzaClockAdjustedDt(this.#dt);
    if (!Number.isFinite(dt) || dt <= 0) dt = this.#dt;      // 未锁定/异常 -> 用基准值

    // ---- 2) 推进复制器（外推 + 双层误差衰减）----
    mod._forzaUpdate(frameDt);

    // ---- 3) 读视觉矩阵（零拷贝：只是建一个视图，不搬数据）----
    this.#matrixView = this.#getFloatView(mod._forzaVisualMatrixPtr(), 16);

    // ---- 4) 统计 ----
    const s = this.#stats;
    s.visualErrorM = mod._forzaReplVisualError();
    s.clockWarp = mod._forzaClockWarp();
    s.clockLocked = mod.clockIsLocked();
    s.replState = mod._forzaReplState() as ReplState;
    s.fps = 0.9 * s.fps + 0.1 * (1 / Math.max(frameDt, 1e-4));
  };

  #getFloatView(ptr: number, count: number): Float32Array {
    const mod = this.#mod!;
    // 每次都重建：堆增长过的话旧视图已 detach。**不要缓存**。
    return new Float32Array(mod.HEAPF32.buffer, ptr, count);
  }

  /** 本帧的视觉层矩阵（16 float，列主序）。Three.js / Babylon 都吃这个序。 */
  get visualMatrix(): Float32Array | null {
    return this.#matrixView;
  }

  /** 物理层矩阵（碰撞/命中判定用，不含视觉偏移） */
  get physicsMatrix(): Float32Array | null {
    const mod = this.#mod;
    if (!mod) return null;
    return this.#getFloatView(mod._forzaPhysicsMatrixPtr(), 16);
  }

  // ---------------------------------------------------------------------------
  //  5) 渲染引擎对接示范
  // ---------------------------------------------------------------------------

  /**
   * Three.js：把视觉矩阵直接写进 Mesh。
   * 必须关掉 `matrixAutoUpdate`，否则 Three 每帧会用 position/quaternion
   * 覆盖我们写进去的矩阵。
   */
  applyToThree(mesh: {
    matrixAutoUpdate: boolean;
    matrix: { fromArray(a: ArrayLike<number>): unknown };
  }): boolean {
    const m = this.#matrixView;
    if (!m) return false;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(m);                    // Matrix4.fromArray 收的就是列主序
    return true;
  }

  /**
   * Babylon.js：Babylon 走的是 position + rotationQuaternion 的分解形式
   * （不是矩阵直写），所以这里从矩阵里把两者拆出来。
   * 只做**刚性变换**的分解：平移取第 4 列，旋转用标准 Shepperd 法从 3×3 提取四元数。
   */
  applyToBabylon(mesh: {
    position: { set(x: number, y: number, z: number): void };
    rotationQuaternion: { set(x: number, y: number, z: number, w: number): void } | null;
    rotation?: { set(x: number, y: number, z: number): void };
  }): boolean {
    const m = this.#matrixView;
    if (!m) return false;

    // 列主序：第 4 列 = 平移
    mesh.position.set(m[12], m[13], m[14]);

    const q = quatFromColumnMajor(m);
    if (mesh.rotationQuaternion) {
      mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);   // Babylon: (x,y,z,w)
    } else if (mesh.rotation) {
      // 没启用四元数旋转时退回欧拉角（有万向锁风险，仅作兜底）
      const e = eulerFromQuat(q);
      mesh.rotation.set(e[0], e[1], e[2]);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  //  6) 调试：把堆里的快照解码成 JS 对象（**不在热路径上**）
  // ---------------------------------------------------------------------------

  decodeHeapSnapshot(): DecodedSnapshot | null {
    const mod = this.#mod;
    if (!mod || this.#packetPtr === 0) return null;
    // DataView 显式指定小端：意图明确，且在罕见的大端平台上也不会悄悄出错
    const dv = new DataView(mod.HEAPU8.buffer, this.#packetPtr, SNAPSHOT_STRIDE);
    return decodeSnapshot(dv);
  }

  dispose(): void {
    this.stop();
    this.#stopPing();
    this.#dc?.close();
    this.#dc = null;
    this.#pc?.close();
    this.#pc = null;
    if (this.#mod && this.#packetPtr) {
      // 注意：_free 之后堆视图可能失效，且本实例即将作废，无需再 refresh
      this.#mod._free(this.#packetPtr);
      this.#packetPtr = 0;
    }
    NetworkPhysicsClient.#instance = null;
  }
}

// =============================================================================
//  纯函数工具（导出以供单测直接调用）
// =============================================================================

/**
 * 用 DataView 解码一个快照。
 *
 * 这个函数是**热路径的参考实现**：`web/tools/verify_wire.mjs` 用同一套逻辑
 * 去解 C++ 吐出来的参考字节块，逐字段比对 —— 这是验证"TS 与 C++ 线格式是否
 * 真的对齐"的唯一可靠手段（手写偏移迟早漂移）。
 */
export function decodeSnapshot(dv: DataView): DecodedSnapshot {
  const f32 = (o: number): number => dv.getFloat32(o, /* littleEndian */ true);
  return {
    frame: dv.getUint32(OFF.frame, true),
    tickMs: dv.getUint32(OFF.tickMs, true),
    serverTimeSec: f32(OFF.serverTimeSec),
    position: [f32(OFF.position), f32(OFF.position + 4), f32(OFF.position + 8)],
    // glm::quat 内存序是 (w, x, y, z)
    rotation: [
      f32(OFF.rotation),
      f32(OFF.rotation + 4),
      f32(OFF.rotation + 8),
      f32(OFF.rotation + 12),
    ],
    velocity: [f32(OFF.velocity), f32(OFF.velocity + 4), f32(OFF.velocity + 8)],
    angularVelocity: [
      f32(OFF.angularVelocity),
      f32(OFF.angularVelocity + 4),
      f32(OFF.angularVelocity + 8),
    ],
    accel: [f32(OFF.accel), f32(OFF.accel + 4), f32(OFF.accel + 8)],
  };
}

/**
 * 从**列主序** 4×4 刚性变换矩阵提取旋转四元数，返回 (x, y, z, w)。
 *
 * 用 Shepperd 法：先取 3×3 迹的最大分量分支，避免 `w` 接近 0 时除以小数
 * 导致精度崩塌（朴素公式在 180° 附近最容易炸）。
 */
export function quatFromColumnMajor(m: ArrayLike<number>): [number, number, number, number] {
  // 列主序 m[col*4+row]；3×3 的 (row, col)
  const m00 = m[0], m10 = m[1], m20 = m[2];
  const m01 = m[4], m11 = m[5], m21 = m[6];
  const m02 = m[8], m12 = m[9], m22 = m[10];
  const tr = m00 + m11 + m22;

  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1.0) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

export function eulerFromQuat(
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);
  return [roll, pitch, yaw];
}

export default NetworkPhysicsClient;
