/* =============================================================================
 *  NetworkPhysicsClient.ts —— Wasm 物理同步流水线的前端宿主（单例）
 *
 *  职责：WebRTC DataChannel 二进制流 -> Wasm 内部状态 -> rAF 取渲染矩阵 -> 网格
 *
 *  ── 三条设计主线 ────────────────────────────────────────────────────────────
 *   1) **零拷贝**：网络包如果就是结构体布局，直接 memcpy 进 Wasm 线性内存，
 *      连"解包"这一步都不需要（见 pushSnapshotRaw）。
 *   2) **CSP 友好**：不 eval、不 fetch，配合 -sSINGLE_FILE=1 + DYNAMIC_EXECUTION=0。
 *   3) **视图失效防护**：ALLOW_MEMORY_GROWTH=1 时内存增长会**换掉底层 ArrayBuffer**，
 *      之前缓存的 HEAPU8 会变成悬空视图。所有堆访问都必须走 heap() 重新取。
 *
 *  ── 三个必须知道的浏览器侧限制（写在这里免得后来者当成 bug 查）────────────
 *   ① **时间精度不是纳秒**。C++ 侧用 emscripten_get_now()，它基于 performance.now()，
 *      而浏览器出于 Spectre 缓解会**故意降低计时精度**：
 *        Chrome ~100µs、Firefox 默认 1ms（privacy.resistFingerprinting 下 100ms 级）。
 *      所以"纳秒"只是类型上留的余量，实际分辨率是 100µs 量级。
 *      对 NTP 同步（目标毫秒级）完全够用，但**不要**在任何文档里声称浏览器端纳秒精度。
 *      想要更高精度：需要 COOP/COEP 跨源隔离 + SharedArrayBuffer（见 enableHighResTimer）。
 *   ② **CSP 必须放行 wasm 编译**：`script-src 'wasm-unsafe-eval'`。
 *      只有 `default-src 'none'` 的话 WebAssembly.instantiate 会被静默拒绝，
 *      只在 console 留一条 violation。本项目 index.html 现在就是 'none'，需要改。
 *   ③ **maxRetransmits: 0 意味着丢包不补**。物理快照丢了就丢了（下一帧会来），
 *      但**控制类消息（NTP 采样、房间状态）不能走这条通道** —— 必须另开可靠通道。
 *      本文件的 sendPing 默认走可靠通道就是这个原因。
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 *  Wasm 模块类型（手写，因为本机没有 emcc 也就没有生成的 .d.ts）
 *  字段名必须与 bindings.cpp 里 EMSCRIPTEN_BINDINGS 导出的名字完全一致。
 * -------------------------------------------------------------------------- */
export interface NetworkPhysicsModule {
  // 常量
  readonly SNAPSHOT_STAGE_SIZE: number;
  readonly MATRIX_STAGE_SIZE: number;
  readonly MATRIX_SLOT_FLOATS: number;

  readonly OFF_FRAME: number;
  readonly OFF_TICK_MS: number;
  readonly OFF_SERVER_TIME: number;
  readonly OFF_POSITION: number;
  readonly OFF_ROTATION: number;
  readonly OFF_VELOCITY: number;
  readonly OFF_ANGULAR_VELOCITY: number;
  readonly OFF_ACCEL: number;

  readonly SYNC_EVENT_NONE: number;
  readonly SYNC_EVENT_HARD_RESYNC: number;
  readonly SYNC_EVENT_SAMPLE_REJECTED: number;

  // 堆（EXPORTED_RUNTIME_METHODS）
  readonly HEAPU8: Uint8Array;
  readonly HEAPF32: Float32Array;

  // 零拷贝 C ABI（EXPORTED_FUNCTIONS 里带下划线，运行时挂在 _ 前缀上）
  _fz_snapshot_stage_addr(): number;
  _fz_snapshot_stage_size(): number;
  _fz_field_offset(field: number): number;
  _fz_snapshot_commit(): number;

  _fz_on_pong(t1: number, t2: number, t3: number, t4: number): number;
  _fz_adjusted_dt(baseDtSec: number): number;

  _fz_matrix_stage_addr(): number;
  _fz_update(dtSec: number): void;
  _fz_reset_all(): void;
  _fz_set_half_life(sec: number): void;
  _fz_set_max_extrapolation(sec: number): void;

  // ⚠️ 注意：这些是 `extern "C"` 导出（EXPORTED_FUNCTIONS），
  // Emscripten 对 C 的 `bool` 返回值映射成**数字 0/1**，不是 JS boolean。
  // 写成 `boolean` 会让 `=== true` 恒为 false —— 实测踩过。
  // 用 `!== 0` 判断，别用 `=== true`。
  _fz_is_locked(): number;
  _fz_server_now_ns(): number;
  _fz_current_warp(): number;
  _fz_best_rtt_ns(): number;
  _fz_visual_error_m(): number;
  _fz_extrapolated_s(): number;
  _fz_repl_state(): number;
  _fz_sync_state(): number;
  _fz_last_frame(): number;
  _fz_stale_dropped(): number;
  _fz_hard_snaps(): number;

  // Embind 低频通道
  syncTelemetry(): SyncTelemetryView;
  replTelemetry(): ReplTelemetryView;
}

export interface SyncTelemetryView {
  serverNowNs(): number;
  offsetNs(): number;
  bestRttNs(): number;
  warp(): number;
  locked(): boolean;
  state(): number;
  samples(): number;
}
export interface ReplTelemetryView {
  hasState(): boolean;
  state(): number;
  extrapolatedSec(): number;
  visualErrorM(): number;
  lastFrame(): number;
  staleDropped(): number;
  hardSnaps(): number;
}

/** Wasm 工厂（EMSCRIPTEN_BINDINGS 的 -sEXPORT_NAME=createNetworkPhysics） */
export type NetworkPhysicsFactory = (opts?: Record<string, unknown>) => Promise<NetworkPhysicsModule>;

/* -------------------------------------------------------------------------- */

/** 矩阵槽：与 C++ 的 MatrixSlot 枚举一一对应 */
export const MatrixSlot = {
  VisualWorld: 0,
  PhysicsWorld: 1,
} as const;

/** 一帧快照（JS 侧表示，仅用于打包/测试；高频路径不要用它） */
export interface Snapshot {
  frame: number;
  tickMs?: number;
  serverTimeSec?: number;
  px: number; py: number; pz: number;
  qw?: number; qx?: number; qy?: number; qz?: number;
  vx?: number; vy?: number; vz?: number;
  wx?: number; wy?: number; wz?: number;
  ax?: number; ay?: number; az?: number;
}

export interface ClientOptions {
  factory: NetworkPhysicsFactory;
  /** 误差衰减半衰期（秒）。需求推荐 0.08~0.10，默认 0.09 */
  errorHalfLifeSec?: number;
  /** 外推时长上限（秒），默认 0.25 */
  maxExtrapolationSec?: number;
  /** 物理基准步长，默认 1/60 */
  baseDeltaTime?: number;
  /** 调试日志 */
  debug?: boolean;
}

/** 与 C++ SyncEvent 对齐（用普通 const 对象而不是 `const enum`：后者在
 *  `isolatedModules` / 单文件转译下会报错或行为不一致） */
export const SyncEvent = { None: 0, HardResync: 1, SampleRejected: 2 } as const;
export type SyncEventValue = (typeof SyncEvent)[keyof typeof SyncEvent];

/** 上行发送的缓冲积压阈值（字节）。超过就跳过本帧，避免延迟越堆越高。 */
export const SNAPSHOT_SEND_BACKPRESSURE_BYTES = 64 * 1024;

/**
 * 物理同步客户端（单例）。
 *
 * 典型用法：
 *   const client = await NetworkPhysicsClient.getInstance({ factory: createNetworkPhysics });
 *   client.attachDataChannel(dc);          // dc 必须是 ordered:false / maxRetransmits:0
 *   client.attachMesh(threeMesh);          // 或 attachBabylonMesh(babylonMesh)
 *   client.start();                        // 启动 rAF 循环
 */
export class NetworkPhysicsClient {
  private static instance: NetworkPhysicsClient | null = null;

  private readonly mod: NetworkPhysicsModule;
  private readonly opt: Required<Omit<ClientOptions, 'factory'>>;

  /** 快照暂存区地址（Wasm 内存里的固定位置，构造后不变） */
  private readonly snapshotAddr: number;
  private readonly snapshotSize: number;
  /** 矩阵暂存区地址 */
  private readonly matrixAddr: number;

  /** 本帧物理步长（由时钟微调给出，含 ±1.5% 伸缩） */
  private currentDt = 1 / 60;

  /** rAF 句柄与上一帧时间戳 */
  private rafId = 0;
  private lastTs = 0;
  private running = false;

  /** 渲染目标（三选一，都是可选） */
  private threeMesh: { matrix: { fromArray(a: ArrayLike<number>): void }; matrixAutoUpdate: boolean } | null = null;
  private babylonMesh: { getWorldMatrix(): number[] } | null = null;

  /** 数据通道 */
  private dc: RTCDataChannel | null = null;
  private dcReliable: RTCDataChannel | null = null;

  /** 统计（HUD / 排障） */
  private stat = { packets: 0, accepted: 0, dropped: 0, hardResync: 0, rejected: 0, frames: 0 };

  private constructor(mod: NetworkPhysicsModule, opt: Required<Omit<ClientOptions, 'factory'>>) {
    this.mod = mod;
    this.opt = opt;

    this.snapshotAddr = mod._fz_snapshot_stage_addr();
    this.snapshotSize = mod._fz_snapshot_stage_size();
    this.matrixAddr = mod._fz_matrix_stage_addr();

    mod._fz_set_half_life(opt.errorHalfLifeSec);
    mod._fz_set_max_extrapolation(opt.maxExtrapolationSec);

    this.assertLayout();
  }

  /* -------------------------------------------------------------------------
   *  单例
   * ---------------------------------------------------------------------- */

  static async getInstance(opts: ClientOptions): Promise<NetworkPhysicsClient> {
    if (NetworkPhysicsClient.instance) return NetworkPhysicsClient.instance;
    const mod = await opts.factory({});
    NetworkPhysicsClient.instance = new NetworkPhysicsClient(mod, {
      errorHalfLifeSec: opts.errorHalfLifeSec ?? 0.09,
      maxExtrapolationSec: opts.maxExtrapolationSec ?? 0.25,
      baseDeltaTime: opts.baseDeltaTime ?? 1 / 60,
      debug: opts.debug ?? false,
    });
    return NetworkPhysicsClient.instance;
  }

  static reset(): void {
    if (NetworkPhysicsClient.instance) NetworkPhysicsClient.instance.stop();
    NetworkPhysicsClient.instance = null;
  }

  /* -------------------------------------------------------------------------
   *  ① 零拷贝：把网络包塞进 Wasm
   * ---------------------------------------------------------------------- */

  /**
   * **最快路径**：线格式 == 结构体内存布局时，直接把整包 memcpy 进暂存区，
   * 连解析都不需要。这是本设计的核心 —— 不是"高效解包"，而是"不需要解包"。
   *
   * 代价：结构体里有 **20 字节**对齐 padding（96B 里 **76B** 是有效载荷：
   * 4+4+4+12+16+12+12+12 = 76，5 个 _pad 各 4B = 20）。
   * （这两个数别手算，跑 verify_layout.mjs 会直接告诉你真实值 —— 我第一版就写错成 68/28。）
   * 60Hz × 4 车 ≈ 2.3 KB/s 的浪费，可以忽略；
   * 若带宽真紧张，就改用**紧凑线格式 + DataView 逐个 unpack**（见 packSnapshot）。
   *
   * @returns true = 被接受；false = 丢弃（帧号过期 / 长度不符）
   */
  pushSnapshotRaw(packet: ArrayBuffer | ArrayBufferView): boolean {
    const bytes = packet instanceof ArrayBuffer
      ? new Uint8Array(packet)
      : new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);

    if (bytes.byteLength !== this.snapshotSize) {
      // 长度不符**必须**拒绝：直接写会越界踩坏桥里其它成员（矩阵暂存区就在后面）
      if (this.opt.debug) console.warn(`[netphys] 包长 ${bytes.byteLength} != ${this.snapshotSize}，已丢弃`);
      this.stat.dropped++;
      return false;
    }

    // heap() 每次都重新取视图 —— 上一次调用可能触发了内存增长
    const heap = this.heapU8();
    heap.set(bytes, this.snapshotAddr);

    const ok = this.mod._fz_snapshot_commit() === 1;
    this.stat.packets++;
    if (ok) {
      this.stat.accepted++;
      // commit 只改状态、不刷新矩阵；想立刻用新矩阵就 RefreshMatrices（这里省略，
      // 因为 rAF 里马上会 update()，那一步会刷新）
    } else {
      this.stat.dropped++;
    }
    return ok;
  }

  /**
   * 把 JS 对象按字段偏移打包进暂存区（低频路径：工具、回放、单测）。
   * 高频路径请用 pushSnapshotRaw。
   *
   * 注意偏移全部**从模块里读**（OFF_* 常量），不写死在 TS 里 ——
   * 线格式改了只要重新编译 Wasm，TS 侧自动跟随。
   */
  packSnapshot(s: Snapshot): boolean {
    const heap = this.heapU8();
    const dv = new DataView(heap.buffer, this.snapshotAddr, this.snapshotSize);
    const o = this.mod;

    dv.setUint32(o.OFF_FRAME, s.frame >>> 0, true);
    dv.setUint32(o.OFF_TICK_MS, (s.tickMs ?? Date.now()) >>> 0, true);
    dv.setFloat32(o.OFF_SERVER_TIME, s.serverTimeSec ?? 0, true);
    dv.setFloat32(o.OFF_POSITION + 0, s.px, true);
    dv.setFloat32(o.OFF_POSITION + 4, s.py, true);
    dv.setFloat32(o.OFF_POSITION + 8, s.pz, true);
    dv.setFloat32(o.OFF_ROTATION + 0, s.qw ?? 1, true);
    dv.setFloat32(o.OFF_ROTATION + 4, s.qx ?? 0, true);
    dv.setFloat32(o.OFF_ROTATION + 8, s.qy ?? 0, true);
    dv.setFloat32(o.OFF_ROTATION + 12, s.qz ?? 0, true);
    dv.setFloat32(o.OFF_VELOCITY + 0, s.vx ?? 0, true);
    dv.setFloat32(o.OFF_VELOCITY + 4, s.vy ?? 0, true);
    dv.setFloat32(o.OFF_VELOCITY + 8, s.vz ?? 0, true);
    dv.setFloat32(o.OFF_ANGULAR_VELOCITY + 0, s.wx ?? 0, true);
    dv.setFloat32(o.OFF_ANGULAR_VELOCITY + 4, s.wy ?? 0, true);
    dv.setFloat32(o.OFF_ANGULAR_VELOCITY + 8, s.wz ?? 0, true);
    dv.setFloat32(o.OFF_ACCEL + 0, s.ax ?? 0, true);
    dv.setFloat32(o.OFF_ACCEL + 4, s.ay ?? 0, true);
    dv.setFloat32(o.OFF_ACCEL + 8, s.az ?? 0, true);

    const ok = this.mod._fz_snapshot_commit() === 1;
    this.stat.packets++;
    ok ? this.stat.accepted++ : this.stat.dropped++;
    return ok;
  }

  /* -------------------------------------------------------------------------
   *  ② WebRTC 通道
   * ---------------------------------------------------------------------- */

  /**
   * 绑定数据通道。**必须是不可靠/无序通道**，否则 TCP 队头阻塞会让
   * 一个丢包卡住后面所有快照 —— 那正是 Rubberbanding 的最大来源。
   */
  attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        this.pushSnapshotRaw(data);
      } else if (ArrayBuffer.isView(data)) {
        this.pushSnapshotRaw(data as ArrayBufferView);
      }
      // 字符串消息走这里说明对端发错了通道，忽略即可（快照通道只应发二进制）
    };
    dc.onclose = () => {
      // 断线重连：必须清空时钟窗口与刚体状态，否则重连后会带着旧偏移继续跑
      this.mod._fz_reset_all();
      if (this.opt.debug) console.info('[netphys] DataChannel 关闭 -> 已重置同步状态');
    };
  }

  /**
   * 把本车状态发上游（同样零拷贝的读侧）。
   *
   * 用法：先用 packSnapshot() 把本车状态写进暂存区，再调本方法发送。
   *
   * ⚠️ **必须 slice() 复制一份再 send**，不能直接把 Wasm 堆上的视图丢给 send：
   *    `RTCDataChannel.send()` 是**异步**的（内部要排队/可能分片），
   *    而暂存区是复用的 —— 下一帧 packSnapshot 会覆盖它。
   *    直接发视图会发出"半新半旧"的脏数据，而且症状是偶发的、极难查。
   *    另外 ALLOW_MEMORY_GROWTH 下堆还可能被换掉，视图直接失效。
   *    这一份复制的代价（96B）远小于它避免的问题。
   *
   * @returns true = 已交给通道发出；false = 未绑定 / 通道未打开 / 缓冲积压
   */
  sendLocalSnapshot(): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    // 积压过多就跳过这一帧：物理快照是"最新覆盖旧"的语义，排队没有意义，
    // 反而会把延迟越堆越高（这正是要开 maxRetransmits:0 的同一个理由）。
    if (this.dc.bufferedAmount > SNAPSHOT_SEND_BACKPRESSURE_BYTES) {
      this.stat.dropped++;
      return false;
    }
    const view = new Uint8Array(this.mod.HEAPU8.buffer, this.snapshotAddr, this.snapshotSize);
    this.dc.send(view.slice());
    return true;
  }

  /**
   * 另外绑定一条**可靠有序**通道，专供 NTP 采样与房间控制。
   * 快照丢了无所谓（下一帧就到），但 NTP 采样丢一个就少一个窗口样本，
   * 而且乱序的 PONG 会让 T1 回退被直接拒收（见 C++ 里的乱序过滤）。
   */
  attachReliableChannel(dc: RTCDataChannel): void {
    this.dcReliable = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') { this.onControlMessage(ev.data); return; }
      if (ev.data instanceof ArrayBuffer && ev.data.byteLength === 32) {
        this.onPongPacket(ev.data);   // 32B = t1..t4 四个 double
      }
    };
  }

  /**
   * 发一次 NTP 采样。t1/t4 用 `performance.now()*1e6` 换纳秒。
   *
   * ⚠️ 精度：performance.now() 被浏览器降精度（Chrome ~100µs）。
   * 换算成"纳秒"只是单位，不是分辨率 —— 见文件头 ①。
   */
  sendPing(): void {
    if (!this.dcReliable || this.dcReliable.readyState !== 'open') return;
    const t1 = performance.now() * 1e6;
    const buf = new ArrayBuffer(16);
    new DataView(buf).setFloat64(0, t1, true);
    this.dcReliable.send(buf);
  }

  private onPongPacket(buf: ArrayBuffer): void {
    const dv = new DataView(buf);
    const t1 = dv.getFloat64(0, true);
    const t2 = dv.getFloat64(8, true);
    const t3 = dv.getFloat64(16, true);
    const t4 = dv.getFloat64(24, true);
    const ev = this.mod._fz_on_pong(t1, t2, t3, t4);
    if (ev === SyncEvent.HardResync) {
      this.stat.hardResync++;
      // 硬同步意味着时间轴发生了大跳变 —— 上层应抑制本帧的视觉插值/回放
      this.onHardResync?.();
    } else if (ev === SyncEvent.SampleRejected) {
      this.stat.rejected++;
    }
  }

  /** 硬同步回调（默认 2Hz 采样足够；绝不要在这里做重计算） */
  onHardResync: (() => void) | null = null;

  private onControlMessage(_text: string): void {
    // 房间/排行榜等控制消息的解析交给上层；本模块只关心时间与刚体
  }

  /* -------------------------------------------------------------------------
   *  ③ rAF 循环
   * ---------------------------------------------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private tick = (ts: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // dt 必须来自真实计时，不能写死 1/60：
    // 120/144Hz 屏幕上写死会让时间推进快一倍以上
    const dtMs = this.lastTs === 0 ? 16.67 : Math.min(ts - this.lastTs, 50); // 夹 50ms 防切页后跳变
    this.lastTs = ts;
    const rawDt = dtMs / 1000;

    // 让 C++ 给出**微调过的**物理步长（Clock Slewing，±1.5%），
    // 再用它推进外推与误差衰减 —— 这样本地时间会平滑贴合服务端
    this.currentDt = this.mod._fz_adjusted_dt(rawDt);
    this.mod._fz_update(this.currentDt);
    this.stat.frames++;

    this.applyVisualMatrix();
  };

  /** 把 Wasm 的视觉矩阵写给渲染网格 */
  private applyVisualMatrix(): void {
    if (this.threeMesh) {
      const m = this.matrixView(MatrixSlot.VisualWorld);
      // Three.js: Matrix4.fromArray 直接吃 16 个 float，无需构造中间对象
      this.threeMesh.matrix.fromArray(m);
      this.threeMesh.matrixAutoUpdate = false;   // 已经是世界矩阵，别再让 Three 覆盖
    }
    if (this.babylonMesh) {
      const w = this.babylonMesh.getWorldMatrix();
      const m = this.matrixView(MatrixSlot.VisualWorld);
      for (let i = 0; i < 16; i++) w[i] = m[i];
    }
  }

  /* -------------------------------------------------------------------------
   *  渲染网格接入
   * ---------------------------------------------------------------------- */

  attachThreeMesh(mesh: { matrix: { fromArray(a: ArrayLike<number>): void }; matrixAutoUpdate: boolean }): void {
    this.threeMesh = mesh;
  }
  attachBabylonMesh(mesh: { getWorldMatrix(): number[] }): void {
    this.babylonMesh = mesh;
  }

  /** 物理层矩阵视图（碰撞/命中判定用；**不要**拿它做渲染） */
  physicsMatrix(): Float32Array {
    return this.matrixView(MatrixSlot.PhysicsWorld);
  }

  /* -------------------------------------------------------------------------
   *  堆访问（防视图失效）
   * ---------------------------------------------------------------------- */

  /**
   * 取 HEAPU8。**必须每次都重新取**：ALLOW_MEMORY_GROWTH=1 时内存增长会
   * 换掉底层 ArrayBuffer，之前缓存的视图立刻失效（读出来全是 0 或抛异常）。
   */
  private heapU8(): Uint8Array {
    return this.mod.HEAPU8;
  }

  /** 某个矩阵槽的 Float32 视图（零拷贝，直接指向 Wasm 线性内存） */
  private matrixView(slot: number): Float32Array {
    const base = this.matrixAddr + slot * 16 * 4;
    // 用 HEAPF32.buffer + 字节偏移构造视图 —— 同样是零拷贝
    return new Float32Array(this.mod.HEAPF32.buffer, base, 16);
  }

  /* -------------------------------------------------------------------------
   *  自检 & 遥测
   * ---------------------------------------------------------------------- */

  /**
   * 校验 Wasm 侧的布局与 TS 的假设一致。
   * 这个检查很便宜但很关键：线格式一旦漂移，症状是"位置偶尔乱跳"，
   * 极难定位，不如启动时直接炸出来。
   */
  private assertLayout(): void {
    const m = this.mod;
    const problems: string[] = [];
    if (this.snapshotSize !== 96) problems.push(`SNAPSHOT_STAGE_SIZE=${this.snapshotSize}（期望 96）`);
    if (m.OFF_POSITION !== 16) problems.push(`OFF_POSITION=${m.OFF_POSITION}（期望 16）`);
    if (m.OFF_ROTATION !== 32) problems.push(`OFF_ROTATION=${m.OFF_ROTATION}（期望 32）`);
    if (m.OFF_ACCEL !== 80) problems.push(`OFF_ACCEL=${m.OFF_ACCEL}（期望 80）`);
    if (problems.length) {
      throw new Error('[netphys] Wasm 布局与前端假设不符，拒绝启动：\n  ' + problems.join('\n  '));
    }
  }

  /** 遥测快照（给 HUD / netgraph 用；别在每帧调 Embind 版，走 _fz_* 标量接口） */
  telemetry() {
    return {
      syncState: this.mod._fz_sync_state(),
      locked: this.mod._fz_is_locked() !== 0,   // C ABI 返回 0/1，不是 boolean
      bestRttMs: this.mod._fz_best_rtt_ns() / 1e6,
      clockOffsetMs: this.mod.syncTelemetry().offsetNs() / 1e6,
      warpRatio: this.mod._fz_current_warp(),
      replState: this.mod._fz_repl_state(),
      extrapolatedMs: this.mod._fz_extrapolated_s() * 1000,
      visualErrorM: this.mod._fz_visual_error_m(),
      lastFrame: this.mod._fz_last_frame(),
      ...this.stat,
    };
  }

  /**
   * 可选：请求高精度计时。
   *
   * 浏览器默认把 performance.now() 降精度（Chrome ~100µs）。
   * 想要更高分辨率需要 **跨源隔离** —— 服务器必须发：
   *   Cross-Origin-Opener-Policy: same-origin
   *   Cross-Origin-Embedder-Policy: require-corp
   * 之后就可用 SharedArrayBuffer 与更高精度的计时源。
   * 本项目的 Go 服务端加这两行响应头即可。
   *
   * ⚠️ 但请注意：**即使拿到高精度计时，也不要声称"纳秒同步"**。
   *    NTP 的误差下界由网络路径不对称决定（毫秒级），不是计时器分辨率。
   */
  static async enableHighResTimer(serverOrigin: string): Promise<boolean> {
    void serverOrigin;
    if (typeof SharedArrayBuffer === 'undefined') return false;
    return globalThis.crossOriginIsolated === true;
  }
}
