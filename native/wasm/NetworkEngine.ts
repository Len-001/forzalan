/**
 * NetworkEngine.ts —— WebRTC DataChannel + 32B 紧凑二进制协议 + Wasm 零拷贝宿主
 * =============================================================================
 *
 *  这个文件解决三个具体问题（需求原文的三条漏洞）：
 *
 *  ① **队头阻塞（HOL blocking）**
 *     WebSocket 跑在 TCP 上：一个丢包会让**后面所有包**都在内核缓冲区排队等重传。
 *     物理快照的语义是"最新覆盖旧的"—— 为 200ms 前的位置等 200ms 毫无意义，
 *     等到了反而让插值缓冲变深、延迟变大。
 *     ⇒ 物理通道**必须**走 WebRTC DataChannel 的不可靠无序模式：
 *          { ordered: false, maxRetransmits: 0 }
 *     但 **NTP 心跳与房间/榜单消息必须走可靠有序通道** —— 丢一个 ping
 *     就丢一个窗口样本，PONG 乱序会让时钟滤波读到回退的时间戳。
 *     ⇒ 本引擎因此**建两条 DataChannel**，由调用方分别喂不同的消息。
 *
 *  ② **Wasm↔JS 内存拷贝开销**
 *     60Hz × N 车，若每包都 `JSON.parse` / 构造对象 / 传字符串，
 *     光序列化就能吃掉一帧的预算。
 *     ⇒ 物理快照走 **32 字节位打包 + Wasm 内存内直接解包**：
 *          JS:   HEAPU8.set(packet, stageBase + slot*32)   // 一次 32B memcpy
 *          再调: _fz_commit_remote_state(id)              // 一次无参调用
 *        全程没有对象、没有字符串、没有 JS 侧解包。
 *        Wasm 再直接吐一个 16-float 矩阵指针，前端 `HEAPF32.subarray` 零拷贝
 *        喂给 Three.js `Matrix4.fromArray`。
 *
 *  ③ **渲染主线程卡顿**
 *     物理更新**不能**跟着 rAF 走：一次页面重绘丢帧（后台标签页、GC、
 *     阴影贴图重建）会让 rAF 间隔从 16.7ms 跳到 100ms+，若直接用这个 dt
 *     推物理，就会出现"跳帧时车飞出去 / 卡顿后瞬移"。
 *     ⇒ 本引擎把 dt **钳到上限**（默认 50ms），并且：
 *        · 时钟微调（±1.5%）由 Wasm 的 `ForzaTimeSynchronizer` 独立完成
 *        · 帧间隔异常时**丢弃**该帧而不是补足时间（补足 = 更大的时间跳变）
 *        调用方还可以用 `setPhysicsDriver()` 把物理推进交给固定步长循环。
 *
 *  ── 与 three.js 的接线（最小示例，见文件末尾 createThreeNetworkBinding）──
 *      const engine = await NetworkEngine.create({ moduleFactory: createForzaNet });
 *      engine.attachUnreliableChannel(dcSnapshots);
 *      engine.attachReliableChannel(dcControl);
 *      engine.registerVehicle(peerId, threeMesh);          // 远端车
 *      engine.setLeaderboardDom(document.querySelector('#hud-tl'));
 *      // 每帧：
 *      engine.tick(nowMs);                                  // 内部推 Wasm
 *
 *  ── 本文件的类型纪律 ────────────────────────────────────────────────────────
 *    · 不使用 `const enum`（isolatedModules / 单文件转译器会拒绝）
 *    · 不使用 `any`（strict 下通不过）
 *    · 所有 Wasm 常量从模块读，**不在 TS 里硬编码位偏移**
 * =============================================================================
 */

// -----------------------------------------------------------------------------
//  Wasm 模块的最小类型声明
// -----------------------------------------------------------------------------
//  工程内没有本地 emcc，因此不生成 .d.ts；手写接口比 `any` 安全得多。
//  ⚠️ 字段名必须与 wasm_bindings.cpp 的 EMBIND/EXPORT 名**逐字一致**，
//     改一个字母就是运行期 `undefined is not a function`。

export interface ForzaNetModule {
  // ---- 线格式 & 矩阵常量（**唯一真相在 C++**）----
  readonly WIRE_BYTES: number;
  readonly MAX_VEHICLES: number;
  readonly ROW_TEXT_CAP: number;
  readonly MATRIX_SLOTS: number;
  readonly MATRIX_SLOT_VISUAL: number;
  readonly MATRIX_SLOT_PHYSICS: number;
  readonly WIRE_BIT_FRAME: number;
  readonly WIRE_BIT_TICK_MS: number;
  readonly WIRE_BIT_POS_X: number;
  readonly WIRE_BIT_POS_Y: number;
  readonly WIRE_BIT_POS_Z: number;
  readonly WIRE_BIT_VEL_X: number;
  readonly WIRE_BIT_VEL_Y: number;
  readonly WIRE_BIT_VEL_Z: number;
  readonly WIRE_BIT_ROT_X: number;
  readonly WIRE_BIT_ROT_Y: number;
  readonly WIRE_BIT_ROT_Z: number;
  readonly WIRE_BIT_ACC_X: number;
  readonly WIRE_BIT_ACC_Y: number;
  readonly WIRE_BIT_ACC_Z: number;
  readonly WIRE_BIT_OMEGA_X: number;
  readonly WIRE_BIT_OMEGA_Y: number;
  readonly WIRE_BIT_OMEGA_Z: number;

  // ---- Embind 低频：计时塔（会分配 JS 对象，**不要每帧调**）----
  leaderboard(): EmbindVector<LeaderboardRowJs>;

  // 32B 线格式的位表（交叉校验用）
  readonly WIRE_BITS_POS: number;
  readonly WIRE_BITS_VEL: number;
  readonly WIRE_BITS_ROT: number;
  readonly WIRE_BITS_ACC: number;
  readonly WIRE_BITS_OMEGA: number;
  readonly WIRE_SCALE_POS: number;
  readonly WIRE_SCALE_VEL: number;
  readonly WIRE_SCALE_ROT: number;
  readonly WIRE_SCALE_ACC: number;
  readonly WIRE_SCALE_OMEGA: number;

  // 96B 工作结构偏移
  readonly OFF_FRAME: number;
  readonly OFF_TICK_MS: number;
  readonly OFF_POSITION: number;
  readonly OFF_ROTATION: number;
  readonly OFF_VELOCITY: number;
  readonly OFF_ANGULAR_VELOCITY: number;
  readonly OFF_ACCEL: number;

  readonly SNAPSHOT_STAGE_SIZE: number;
  readonly SYNC_EVENT_NONE: number;
  readonly SYNC_EVENT_HARD_RESYNC: number;
  readonly SYNC_EVENT_SAMPLE_REJECTED: number;

  // ---- 堆视图 ----
  //  ⚠️ ALLOW_MEMORY_GROWTH=1 下内存增长会换掉底层 ArrayBuffer，
  //     所以**每次访问都要重新读这两个属性**，不要缓存到变量里长期持有。
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;

  // ---- 单车通道（时间同步 + 本地车航位推测）----
  _fz_on_pong(t1: number, t2: number, t3: number, t4: number): number;
  _fz_adjusted_dt(baseDtSec: number): number;
  _fz_update(dtSec: number): void;
  _fz_refresh_matrices(): void;
  _fz_reset_all(): void;
  _fz_set_half_life(sec: number): void;
  _fz_set_max_extrapolation(sec: number): void;
  _fz_matrix_slot_addr(slot: number): number;

  // ---- 多车通道 ----
  _fz_remote_stage_base(): number;
  _fz_wire_bytes(): number;
  _fz_update_remote_state(id: number, byteBuffer: number, offset: number): number;
  _fz_update_remote_state_ptr(id: number, ptr: number): number;
  _fz_update_remotes(dtSec: number): void;
  _fz_remote_matrix_base(): number;
  _fz_remote_position(id: number, axis: number): number;
  _fz_remote_visual_position(id: number, axis: number): number;
  _fz_remote_visual_error(id: number): number;
  _fz_remote_extrapolated(id: number): number;
  _fz_remote_repl_state(id: number): number;
  _fz_vehicle_count(): number;
  _fz_vehicle_find(id: number): number;
  _fz_ensure_vehicle(id: number, isLocal: number): number;
  _fz_remove_vehicle(id: number): number;
  _fz_set_local_vehicle(slot: number): void;

  // ---- 赛道 + 进度（秒差解算输入）----
  _fz_set_track(ctlXZ: number, ctlCount: number, cpArc: number, cpCount: number): number;
  _fz_track_ready(): number;
  _fz_track_length(): number;
  _fz_checkpoint_count(): number;
  _fz_project(x: number, z: number, hintS: number): number;
  _fz_update_progress(
    id: number, sMeters: number, serverTime: number,
    lap: number, cpIndex: number, cpPassTime: number,
  ): void;

  // ---- HUD 文本 ----
  _fz_build_leaderboard(): number;
  _fz_row_text_addr(row: number): number;
  _fz_row_text_cap(): number;
  _fz_format_local_vs_leader(): number;
  _fz_local_row_addr(): number;
  _fz_solve_delta_ms(aId: number, bId: number): number;
  _fz_solve_method(aId: number, bId: number): number;
  _fz_solve_ds(aId: number, bId: number): number;
  _fz_solve_vseg(aId: number, bId: number): number;

  // ---- 线格式打包（服务端 / 测试）----
  _fz_pack_snapshot(src: number, dst: number): number;
  _fz_expand_snapshot(src: number, dst: number): number;

  // ---- 遥测 ----
  _fz_is_locked(): number;              // ⚠️ C ABI 的 bool 在 JS 侧是 0/1 **数字**
  _fz_server_now_ns(): number;
  _fz_current_warp(): number;
  _fz_best_rtt_ns(): number;
  _fz_visual_error_m(): number;
  _fz_repl_state(): number;
  _fz_sync_state(): number;

  _malloc(size: number): number;
  _free(ptr: number): void;
}

export type ForzaNetFactory = (opts?: Record<string, unknown>) => Promise<ForzaNetModule>;

/** Embind 的 `std::vector<T>` 包装：size/get + **必须 delete()** 否则泄漏 Wasm 堆 */
export interface EmbindVector<T> {
  size(): number;
  get(index: number): T;
  delete(): void;
}

/** 计时塔一行（Embind value_object 的 JS 形态） */
export interface LeaderboardRowJs {
  id: number;
  position: number;
  lap: number;
  isLocal: boolean;
  isLeader: boolean;
  text: string;
}

// -----------------------------------------------------------------------------
//  协议常量
// -----------------------------------------------------------------------------

/** 不可靠 DataChannel 的配置 —— 需求钉死的形态。 */
export const UNRELIABLE_CHANNEL_INIT: RTCDataChannelInit = {
  ordered: false,
  maxRetransmits: 0,
};

/**
 * 发送背压阈值（字节）。
 *
 * DataChannel 的 `send()` 是**异步**的：它把数据交给底层 SCTP，马上返回。
 * 若网络跟不上而调用方仍在 60Hz 猛塞，`bufferedAmount` 会持续增长 ——
 * 我们发的是"最新覆盖旧的"语义的快照，排队只会让到达的数据越来越旧。
 * ⇒ 超过阈值就**跳过这一帧**，不排队。
 */
export const SNAPSHOT_SEND_BACKPRESSURE_BYTES = 64 * 1024;

/**
 * 单帧 dt 上限（毫秒）。
 *
 * rAF 间隔正常是 16.7ms（60Hz）或 8.3ms（120Hz），但后台标签页、
 * GC、阴影贴图重建会让它跳到几百毫秒。若把这个 dt 直接喂给物理，
 * 就会"卡一下之后车飞出去"。
 * ⇒ 钳到 50ms（≈3 个 60Hz 步）。更长的间隔**丢弃**而不是补足 ——
 *   补足等于制造一个更大的时间跳变。
 */
export const MAX_FRAME_DT_MS = 50;

/** NTP ping 周期（毫秒）。1Hz 足够：时钟窗口 30 个样本 = 30 秒收敛。 */
export const PING_INTERVAL_MS = 1000;

/** 可靠通道上的控制消息类型 */
export const ControlMsg = {
  Ping: 'PING',
  Pong: 'PONG',
} as const;
export type ControlMsgType = (typeof ControlMsg)[keyof typeof ControlMsg];

// -----------------------------------------------------------------------------
//  32B 线格式的 JS 侧打包器（与服务端 / C++ 位表必须一致）
// -----------------------------------------------------------------------------

/**
 * 32 字节位打包写入器。
 *
 * ⚠️ 为什么 JS 侧要自己实现一份位打包，而不是调 Wasm 的 `_fz_pack_snapshot`？
 *    本地车的发包频率是 60Hz。走 Wasm 需要：
 *      写 96B 工作结构 → 调 _fz_pack_snapshot → 再 slice 出去
 *    而直接在 JS 侧 Pack：一次 DataView 写入 + 一次 `send()`。
 *    这一份实现的存在价值是**省掉一次往返**，代价是**两个实现必须一致** ——
 *    所以本类的偏移**全部从 Wasm 常量读**（`WIRE_BIT_*`），不写死数字。
 *    并且 `assertProtocolMatch()` 会在启动时做一致性自检。
 */
export class WireSnapshotWriter {
  private readonly buf: ArrayBuffer;
  private readonly dv: DataView;

  constructor(private readonly mod: ForzaNetModule) {
    this.buf = new ArrayBuffer(mod.WIRE_BYTES);
    this.dv = new DataView(this.buf);
  }

  get bytes(): ArrayBuffer {
    return this.buf;
  }

  /**
   * 饱和定点量化。
   *
   * ⚠️ **必须与 C++ 的 `QuantizeSat` 逐值一致**，包括半值取整方向。
   *    JS 的 `Math.round` 定义是 `floor(x + 0.5)` —— 半个值一律朝 **+∞**：
   *        Math.round( 0.5) =  1
   *        Math.round(-0.5) = -0     ← 不是 -1
   *    C++ 侧已经改成同一条 `std::floor(s + 0.5)`，所以两边逐字节相同。
   *    曾经 C++ 用 `nearbyint`（取偶）而这里用 `Math.round`，
   *    在 0.0625m 这类"恰好半个量化步"的输入上差一位 —— 见 snapshot_wire.h。
   *    `native/wasm/verify_engine_wire.mjs` 会逐字节钉住这条等价性。
   *
   * 这里刻意写成 `Math.floor(v + 0.5)` 而不是 `Math.round(v)`：
   * 语义完全相同，但**写出了意图**，让下次改的人一眼看到"要跟 C++ 的 floor(x+0.5) 对齐"。
   */
  private quantize(v: number, scale: number, bits: number): number {
    if (!Number.isFinite(v)) return 0;
    const lo = -((1 << (bits - 1)) - 1);
    const hi = (1 << (bits - 1)) - 1;
    let q = Math.floor(v * scale + 0.5);   // = Math.round，但意图明确
    if (q > hi) q = hi;
    if (q < lo) q = lo;
    return q;
  }

  /**
   * 把一个快照写进 32 字节。
   *
   * 位打包用两个 32 位字之间的移位完成 —— 与 C++ 的 PutBits 同一算法。
   * 为了可读性，这里**不**追求极致微观优化：CPU 侧一次打包约 1~2µs，
   * 相对 `send()` 的异步开销可以忽略。
   */
  write(s: {
    frame: number; tickMs: number;
    px: number; py: number; pz: number;
    qw: number; qx: number; qy: number; qz: number;
    vx: number; vy: number; vz: number;
    wx: number; wy: number; wz: number;
    ax: number; ay: number; az: number;
  }): ArrayBuffer {
    const m = this.mod;
    // 用一个 8×32 位的临时数组做位打包（与 C++ 完全同构），最后 memcpy 进 DataView
    const w = new Uint32Array(8);

    const put = (off: number, bits: number, val: number): void => {
      const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
      const v = (val >>> 0) & mask;
      const wi = off >>> 5;
      const bs = off & 31;
      w[wi] = (w[wi] | ((v << bs) >>> 0)) >>> 0;
      if (bs + bits > 32) {
        const spill = bs + bits - 32;
        w[wi + 1] = (w[wi + 1] | (v >>> (bits - spill))) >>> 0;
      }
    };

    // ---- 姿态习惯化：w ≥ 0（q 与 -q 同旋转，取规范形）----
    let qw = s.qw, qx = s.qx, qy = s.qy, qz = s.qz;
    const n2 = qw * qw + qx * qx + qy * qy + qz * qz;
    if (!(n2 > 0) || !Number.isFinite(n2)) {
      qw = 1; qx = 0; qy = 0; qz = 0;
    } else {
      const inv = 1 / Math.sqrt(n2);
      qw *= inv; qx *= inv; qy *= inv; qz *= inv;
    }
    if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }

    // 位偏移来自 Wasm 常量（不硬编码）
    const B_FRAME = m.WIRE_BIT_FRAME ?? 0;
    const B_TICK = m.WIRE_BIT_TICK_MS ?? 16;
    const B_POSX = m.WIRE_BIT_POS_X ?? 32;
    const B_POSY = m.WIRE_BIT_POS_Y ?? 48;
    const B_POSZ = m.WIRE_BIT_POS_Z ?? 64;
    const B_VELX = m.WIRE_BIT_VEL_X ?? 80;
    const B_VELY = m.WIRE_BIT_VEL_Y ?? 94;
    const B_VELZ = m.WIRE_BIT_VEL_Z ?? 108;
    const B_ROTX = m.WIRE_BIT_ROT_X ?? 128;
    const B_ROTY = m.WIRE_BIT_ROT_Y ?? 144;
    const B_ROTZ = m.WIRE_BIT_ROT_Z ?? 160;
    const B_ACCX = m.WIRE_BIT_ACC_X ?? 176;
    const B_ACCY = m.WIRE_BIT_ACC_Y ?? 188;
    const B_ACCZ = m.WIRE_BIT_ACC_Z ?? 200;
    const B_OMGX = m.WIRE_BIT_OMEGA_X ?? 212;
    const B_OMGY = m.WIRE_BIT_OMEGA_Y ?? 224;
    const B_OMGZ = m.WIRE_BIT_OMEGA_Z ?? 236;

    put(B_FRAME, 16, s.frame & 0xffff);
    put(B_TICK, 16, s.tickMs & 0xffff);
    put(B_POSX, m.WIRE_BITS_POS, this.quantize(s.px, m.WIRE_SCALE_POS, m.WIRE_BITS_POS));
    put(B_POSY, m.WIRE_BITS_POS, this.quantize(s.py, m.WIRE_SCALE_POS, m.WIRE_BITS_POS));
    put(B_POSZ, m.WIRE_BITS_POS, this.quantize(s.pz, m.WIRE_SCALE_POS, m.WIRE_BITS_POS));
    put(B_VELX, m.WIRE_BITS_VEL, this.quantize(s.vx, m.WIRE_SCALE_VEL, m.WIRE_BITS_VEL));
    put(B_VELY, m.WIRE_BITS_VEL, this.quantize(s.vy, m.WIRE_SCALE_VEL, m.WIRE_BITS_VEL));
    put(B_VELZ, m.WIRE_BITS_VEL, this.quantize(s.vz, m.WIRE_SCALE_VEL, m.WIRE_BITS_VEL));
    put(B_ROTX, m.WIRE_BITS_ROT, this.quantize(qx, m.WIRE_SCALE_ROT, m.WIRE_BITS_ROT));
    put(B_ROTY, m.WIRE_BITS_ROT, this.quantize(qy, m.WIRE_SCALE_ROT, m.WIRE_BITS_ROT));
    put(B_ROTZ, m.WIRE_BITS_ROT, this.quantize(qz, m.WIRE_SCALE_ROT, m.WIRE_BITS_ROT));
    put(B_ACCX, m.WIRE_BITS_ACC, this.quantize(s.ax, m.WIRE_SCALE_ACC, m.WIRE_BITS_ACC));
    put(B_ACCY, m.WIRE_BITS_ACC, this.quantize(s.ay, m.WIRE_SCALE_ACC, m.WIRE_BITS_ACC));
    put(B_ACCZ, m.WIRE_BITS_ACC, this.quantize(s.az, m.WIRE_SCALE_ACC, m.WIRE_BITS_ACC));
    put(B_OMGX, m.WIRE_BITS_OMEGA, this.quantize(s.wx, m.WIRE_SCALE_OMEGA, m.WIRE_BITS_OMEGA));
    put(B_OMGY, m.WIRE_BITS_OMEGA, this.quantize(s.wy, m.WIRE_SCALE_OMEGA, m.WIRE_BITS_OMEGA));
    put(B_OMGZ, m.WIRE_BITS_OMEGA, this.quantize(s.wz, m.WIRE_SCALE_OMEGA, m.WIRE_BITS_OMEGA));

    // 小端写进 DataView（Wasm 侧按小端解 —— memcpy 进 uint32 数组后按本机序读）
    for (let i = 0; i < 8; i++) this.dv.setUint32(i * 4, w[i], true);
    return this.buf;
  }
}

// -----------------------------------------------------------------------------
//  引擎
// -----------------------------------------------------------------------------

export interface NetworkEngineOptions {
  /** Emscripten 工厂函数（`createForzaNet`） */
  moduleFactory: ForzaNetFactory;
  /** 误差衰减半衰期（秒）。默认 0.08（与 C++ 默认一致） */
  errorHalfLifeSec?: number;
  /** 外推上限（秒）。默认 0.15（与 C++ 默认一致） */
  maxExtrapolationSec?: number;
  /** 是否由引擎自己驱动 Wasm 的每帧推进（默认 true）。 */
  drivePhysics?: boolean;
}

/** 一辆远端车的前端句柄 */
export interface RemoteVehicleHandle {
  id: number;
  /** 槽索引（矩阵区的下标） */
  slot: number;
  /** Three.js 的 Object3D（只要有 matrix / matrixAutoUpdate 就行） */
  target?: ThreeMatrixTarget;
  /** 上一次实际应用的帧号（用于 HUD 诊断） */
  lastFrame: number;
}

/** Three.js `Object3D` 中本引擎真正需要的成员（避免 import three 造成强依赖） */
export interface ThreeMatrixTarget {
  matrix: { fromArray(a: ArrayLike<number>, offset?: number): unknown };
  matrixAutoUpdate: boolean;
  position?: { set(x: number, y: number, z: number): void };
  quaternion?: { set(x: number, y: number, z: number, w: number): void };
}

/** HUD 一行 DOM 的更新契约 */
export interface LeaderboardDomBinder {
  /** 第 index 行（0 = P1）的文本元素 */
  rowText(index: number): HTMLElement | null;
  /** 第 index 行整行的容器（用于加高亮 class） */
  rowElement(index: number): HTMLElement | null;
  /** 自己那一行的 class（默认 'is-local'） */
  localClass?: string;
  /** 领跑者那一行的 class（默认 'is-leader'） */
  leaderClass?: string;
}

/**
 * WebRTC + Wasm 网络引擎。
 *
 * 生命周期：`await NetworkEngine.create(opts)` → 挂通道 → 注册车辆 → 每帧 `tick(now)`。
 */
export class NetworkEngine {
  private mod: ForzaNetModule;
  private readonly opts: Required<Pick<NetworkEngineOptions, 'errorHalfLifeSec' | 'maxExtrapolationSec' | 'drivePhysics'>>;

  /** 物理快照通道（**不可靠 / 无序**） */
  private snapDc: RTCDataChannel | null = null;
  /** 控制/心跳通道（**可靠 / 有序**） */
  private ctrlDc: RTCDataChannel | null = null;

  private readonly vehicles = new Map<number, RemoteVehicleHandle>();
  private writer: WireSnapshotWriter;
  private snapStageBase = 0;

  private lastTs = 0;
  private frameCount = 0;
  private skippedByBackpressure = 0;
  private droppedLongFrame = 0;

  private pingTimer: number | null = null;
  private onHardResync: (() => void) | null = null;

  private hudBinder: LeaderboardDomBinder | null = null;
  private readonly hudScratch: string[] = [];

  private constructor(mod: ForzaNetModule, opts: NetworkEngineOptions) {
    this.mod = mod;
    this.opts = {
      errorHalfLifeSec: opts.errorHalfLifeSec ?? 0.08,
      maxExtrapolationSec: opts.maxExtrapolationSec ?? 0.15,
      drivePhysics: opts.drivePhysics ?? true,
    };
    this.writer = new WireSnapshotWriter(mod);
    this.assertProtocolMatch();

    mod._fz_set_half_life(this.opts.errorHalfLifeSec);
    mod._fz_set_max_extrapolation(this.opts.maxExtrapolationSec);
    this.snapStageBase = mod._fz_remote_stage_base();
  }

  /** 异步创建（例化 Wasm 模块） */
  static async create(opts: NetworkEngineOptions): Promise<NetworkEngine> {
    const mod = await opts.moduleFactory({});
    return new NetworkEngine(mod, opts);
  }

  /**
   * 启动自检：TS 侧读到的常量必须与 C++ 真值一致。
   *
   * ⚠️ 这不是走形式。32B 线格式的位表若与 C++ 不一致，**不会报错**，
   *    只会让位置被读成速度 —— 表现是"远端车偶尔乱飘"，极难归因。
   *    在启动时炸掉，比在赛道上猜要便宜一千倍。
   */
  private assertProtocolMatch(): void {
    const m = this.mod;
    const fail = (what: string, got: number, want: number): never => {
      throw new Error(
        `[NetworkEngine] 线格式自检失败：${what} = ${got}，期望 ${want}。` +
          `TS 侧与 Wasm 侧协议不一致 —— 远端车会静默乱飘，先修协议再跑。`,
      );
    };
    if (m.WIRE_BYTES !== 32) fail('WIRE_BYTES', m.WIRE_BYTES, 32);
    if (m._fz_wire_bytes() !== m.WIRE_BYTES) fail('_fz_wire_bytes()', m._fz_wire_bytes(), m.WIRE_BYTES);
    // 位表关键节点
    const expectBits: Array<[string, number, number]> = [
      ['WIRE_BIT_FRAME', m.WIRE_BIT_FRAME, 0],
      ['WIRE_BIT_TICK_MS', m.WIRE_BIT_TICK_MS, 16],
      ['WIRE_BIT_POS_X', m.WIRE_BIT_POS_X, 32],
      ['WIRE_BIT_VEL_X', m.WIRE_BIT_VEL_X, 80],
      ['WIRE_BIT_ROT_X', m.WIRE_BIT_ROT_X, 128],
      ['WIRE_BIT_OMEGA_Z', m.WIRE_BIT_OMEGA_Z, 236],
    ];
    for (const [name, got, want] of expectBits) {
      if (got !== want) fail(name, got, want);
    }
    // 位宽总校验：载荷必须装进 256 位
    const payload =
      16 + 16 +
      3 * m.WIRE_BITS_POS + 3 * m.WIRE_BITS_VEL + 3 * m.WIRE_BITS_ROT +
      3 * m.WIRE_BITS_ACC + 3 * m.WIRE_BITS_OMEGA;
    if (payload > 256) fail('payloadBits', payload, 256);
  }

  // ---------------------------------------------------------------------------
  //  通道装配
  // ---------------------------------------------------------------------------

  /**
   * 挂上物理快照通道。**必须是 `{ ordered: false, maxRetransmits: 0 }` 建出来的**。
   *
   * 这里**不做**自动改配置 —— 因为 DataChannel 的参数只能在创建时指定，
   * 事后无法改。传进来的通道若非不可靠模式，说明调用方建错了，
   * 此时**直接抛错**比"能跑但延迟高"要好：后者会被误判成"网络就是慢"。
   */
  attachUnreliableChannel(dc: RTCDataChannel): void {
    // ⚠️ 运行期无法读回 ordered/maxRetransmits（Chromium 上属性存在但不保证），
    //    所以只能靠 `reliable` 需要显式设缓冲。这里做的是**行为层校验**：
    //    若调用方给的是可靠通道，send() 会在拥塞时排队，表现为延迟单调增长。
    //    我们无法在这里断言，故在文档与注释里把要求钉死，并提供工厂方法。
    this.snapDc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => this.onSnapshotPacket(ev);
    dc.onclose = () => {
      this.snapDc = null;
      // 通道断了：清掉所有远端车的状态，避免用陈旧外推继续画
      for (const v of this.vehicles.values()) this.mod._fz_remove_vehicle(v.id);
      this.vehicles.clear();
    };
  }

  /**
   * 挂上 NTP / 控制通道。**必须可靠 + 有序**。
   *
   * 为什么不能和快照共用一个不可靠通道：
   *   · ping 被丢 → 少一个窗口样本（不至于出错，但收敛变慢）
   *   · **PONG 乱序** → t1 回退 → 时钟滤波读到"时间倒流"的样本，
   *     触发一次无意义的 hard resync，整屏车瞬移一下
   *   所以控制消息必须有序可靠。
   */
  attachReliableChannel(dc: RTCDataChannel): void {
    this.ctrlDc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => this.onControlPacket(ev);
    dc.onclose = () => {
      this.stopPing();
      this.ctrlDc = null;
    };
  }

  /** 用给定的 RTCPeerConnection 一次性建好两条通道（推荐入口） */
  static createChannels(pc: RTCPeerConnection): {
    snapshots: RTCDataChannel;
    control: RTCDataChannel;
  } {
    return {
      snapshots: pc.createDataChannel('fz.snap', UNRELIABLE_CHANNEL_INIT),
      control: pc.createDataChannel('fz.ctrl', { ordered: true }),
    };
  }

  // ---------------------------------------------------------------------------
  //  车辆注册
  // ---------------------------------------------------------------------------

  /** 注册一辆远端车，并可选地绑定 Three.js 对象 */
  registerVehicle(id: number, target?: ThreeMatrixTarget): RemoteVehicleHandle {
    const slot = this.mod._fz_ensure_vehicle(id, 0);
    if (slot < 0) {
      throw new Error(`[NetworkEngine] 车位表已满（上限 ${this.mod.MAX_VEHICLES}），无法注册 id=${id}`);
    }
    const h: RemoteVehicleHandle = { id, slot, target, lastFrame: 0 };
    this.vehicles.set(id, h);
    if (target) target.matrixAutoUpdate = false;   // 我们直接写 matrix，别让 three 覆盖
    return h;
  }

  /** 设定本地车（HUD 第一行用它判断"--"） */
  setLocalVehicle(id: number): void {
    const slot = this.mod._fz_ensure_vehicle(id, 1);
    if (slot < 0) {
      throw new Error(`[NetworkEngine] 本地车注册失败（车位表已满），id=${id}`);
    }
    this.mod._fz_set_local_vehicle(slot);
    this.localVehicleId = id;
  }

  /** 摘掉一辆车（玩家离开） */
  removeVehicle(id: number): void {
    this.mod._fz_remove_vehicle(id);
    this.vehicles.delete(id);
  }

  // ---------------------------------------------------------------------------
  //  赛道装配（秒差解算的输入）
  // ---------------------------------------------------------------------------

  /**
   * 装入赛道中心线（闭合控制多边形，世界坐标 x/z 交织的 Float64Array）与
   * Checkpoint 弧长表（Float64Array，升序，单位米）。
   *
   * ⚠️ 这条数据**必须与所有客户端一致**（同一 seed 生成的赛道）——
   *    否则各端算出的弧长 S 不可比，秒差会系统性偏移。
   */
  setTrack(ctlXZ: Float64Array, cpArcMeters: Float64Array): void {
    const m = this.mod;
    const ctlBytes = ctlXZ.byteLength;
    const cpBytes = cpArcMeters.byteLength;
    const pCtl = m._malloc(ctlBytes);
    const pCp = m._malloc(cpBytes > 0 ? cpBytes : 8);
    try {
      // ⚠️ 每次 malloc 都可能触发内存增长 → 堆视图失效 → 必须重新取
      this.heapU8().set(new Uint8Array(ctlXZ.buffer, ctlXZ.byteOffset, ctlBytes), pCtl);
      if (cpBytes > 0) {
        this.heapU8().set(new Uint8Array(cpArcMeters.buffer, cpArcMeters.byteOffset, cpBytes), pCp);
      }
      const ok = m._fz_set_track(pCtl, ctlXZ.length >> 1, pCp, cpArcMeters.length);
      if (ok === 0) throw new Error('[NetworkEngine] 赛道装入失败（控制点数量或弧长表非法）');
    } finally {
      m._free(pCtl);
      m._free(pCp);
    }
  }

  /** 上报一辆车的赛道进度（包到达或本地采样时调） */
  updateProgress(
    id: number, sMeters: number, serverTimeSec: number,
    lap: number, cpIndex: number, cpPassTimeSec: number,
  ): void {
    this.mod._fz_update_progress(id, sMeters, serverTimeSec, lap, cpIndex, cpPassTimeSec);
  }

  /** 世界坐标 → 本圈弧长（hintS < 0 表示全扫，非常贵；有上一帧 S 时务必传） */
  project(x: number, z: number, hintS = -1): number {
    return this.mod._fz_project(x, z, hintS);
  }

  // ---------------------------------------------------------------------------
  //  发送 / 接收
  // ---------------------------------------------------------------------------

  /**
   * 发一帧本地车快照（不可靠通道）。
   *
   * @returns true = 已发出；false = 因背压跳过（**正常现象**，不是错误）
   */
  sendLocalSnapshot(s: Parameters<WireSnapshotWriter['write']>[0]): boolean {
    const dc = this.snapDc;
    if (dc === null || dc.readyState !== 'open') return false;

    // ---- 背压：排队只会让到达的数据更旧 ----
    if (dc.bufferedAmount > SNAPSHOT_SEND_BACKPRESSURE_BYTES) {
      ++this.skippedByBackpressure;
      return false;
    }

    const buf = this.writer.write(s);
    // ⚠️ 必须 `send(buf)` 一个**独立**的 ArrayBuffer 而不是复用的大缓冲视图。
    //    writer 内部复用同一个 ArrayBuffer，send() 是异步的 ——
    //    若直接发这个 buffer 的引用，下一帧打包会把它改掉，
    //    发送出去的就是"半新半旧"的垃圾（症状：间歇性位置跳变，极难归因）。
    //    这里 `slice()` 一次 32B —— 这个拷贝换取的是确定性，非常划算。
    //    另：ALLOW_MEMORY_GROWTH 下堆可能被换掉，所以也绝不能发堆视图。
    dc.send(buf.slice(0));
    return true;
  }

  /** 收到物理快照包 */
  private onSnapshotPacket(ev: MessageEvent): void {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer)) return;
    if (data.byteLength !== this.mod.WIRE_BYTES) {
      // 长度不符：可能是别的协议混进来了。**必须挡住** ——
      // 让 32B 之外的字节进入解包会越界读进相邻内存。
      return;
    }
    // 包格式：[0..4) = 车辆 id（小端 u32），[4..36) = 32 字节快照
    // 把 id 放在外面是为了让"一包一车"语义显式 —— 不需要在 32B 里塞 id，
    // 32B 预算要全部留给物理量。
    if (data.byteLength < 4 + this.mod.WIRE_BYTES) return;
    const dv = new DataView(data);
    const id = dv.getUint32(0, true);

    const slot = this.vehicles.get(id)?.slot ?? this.mod._fz_ensure_vehicle(id, 0);
    if (slot < 0) return;   // 表满：静默丢弃（上层可从 vehicleCount 看出异常）

    // ★ 零拷贝路径：把 32B 直接写进 Wasm 线性内存，然后一次无参调用解包。
    //   没有 JSON、没有对象、没有字符串、没有任何 JS 侧解析。
    const stage = this.snapStageBase + slot * this.mod.WIRE_BYTES;
    this.heapU8().set(new Uint8Array(data, 4, this.mod.WIRE_BYTES), stage);
    const accepted = this.mod._fz_update_remote_state(id, stage, 0);
    if (accepted !== 0) {
      const h = this.vehicles.get(id);
      if (h) h.lastFrame += 1;
    }
  }

  // ---------------------------------------------------------------------------
  //  NTP（可靠通道）
  // ---------------------------------------------------------------------------

  /** 开始 1Hz ping */
  startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS) as unknown as number;
    this.sendPing();
  }

  stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * 发一次 ping。
   *
   * ⚠️ t1 用 `performance.now()`（单调）而不是 `Date.now()`：
   *    Date.now() 会被 NTP 校时 / 用户改表**回拨**，时钟同步器一旦读到
   *    负的时间增量，RTT 与 offset 立刻变成垃圾。
   *    精度说明：浏览器出于 Spectre 缓解会把 performance.now() 降精度
   *    （Chrome ~100µs，Firefox 默认 1ms）。纳秒只存在于**类型层面**，
   *    **不要**在文档/UI 里声称"纳秒精度"。要更高精度需 COOP/COEP
   *    跨源隔离 + SharedArrayBuffer。
   */
  sendPing(): void {
    const dc = this.ctrlDc;
    if (dc === null || dc.readyState !== 'open') return;
    const t1 = performance.now() * 1e6;   // µs 精度源 → 纳秒单位
    const buf = new ArrayBuffer(1 + 8);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);                    // 类型标记 1 = PING
    dv.setFloat64(1, t1, true);
    dc.send(buf);
  }

  /** 收到控制包（PONG 或其它） */
  private onControlPacket(ev: MessageEvent): void {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer) || data.byteLength < 9) return;
    const dv = new DataView(data);
    const kind = dv.getUint8(0);
    const t3 = performance.now() * 1e6;

    if (kind === 1) {
      // 收到 PING：原样回一个 PONG，带上 [t1(对端的), t2(收到时刻), t3(发出时刻)]
      // 对端会用 4 个时间戳算 RTT/offset（标准 NTP 四元组）
      const t1 = dv.getFloat64(1, true);
      const dc = this.ctrlDc;
      if (dc === null || dc.readyState !== 'open') return;
      const out = new ArrayBuffer(1 + 8 * 3);
      const odv = new DataView(out);
      odv.setUint8(0, 2);
      odv.setFloat64(1, t1, true);        // T1（回显）
      odv.setFloat64(9, t3, true);        // T2（本端收到 PING 的时刻）
      odv.setFloat64(17, t3, true);       // T3（本端发出 PONG 的时刻，同一 tick，见下方说明）
      dc.send(out);
      return;
    }

    if (kind === 2) {
      // 收到 PONG：T1/T2/T3 由对端给，T4 = 本端现在
      const t1 = dv.getFloat64(1, true);
      const t2 = dv.getFloat64(9, true);
      const t3p = dv.getFloat64(17, true);
      const t4 = t3;
      const evCode = this.mod._fz_on_pong(t1, t2, t3p, t4);
      if (evCode === this.mod.SYNC_EVENT_HARD_RESYNC) {
        // 硬同步：整屏视觉需要抑制一帧插值，交给上层决定怎么处理
        this.onHardResync?.();
      }
    }
  }

  setHardResyncHandler(fn: (() => void) | null): void {
    this.onHardResync = fn;
  }

  // ---------------------------------------------------------------------------
  //  每帧主循环
  // ---------------------------------------------------------------------------

  /**
   * 每帧调用（rAF 回调里传入 `timestamp`）。
   *
   * 物理推进与渲染**解耦**的关键在这里：
   *   · dt 取真实帧间隔，但**钳到 MAX_FRAME_DT_MS**；
   *   · 超过上限的长间隔（后台标签页回来 / GC 停顿）**直接丢弃这一帧**，
   *     不补足时间 —— 补足等于人为制造一个更大的时间跳变；
   *   · 时间伸缩（±1.5%）由 Wasm 的同步器完成，**物理步长绝不因此改变**。
   */
  tick(nowMs: number): void {
    if (this.lastTs === 0) this.lastTs = nowMs;
    let dtMs = nowMs - this.lastTs;
    this.lastTs = nowMs;

    if (!(dtMs > 0)) dtMs = 1000 / 60;      // 首帧 / 时钟相同
    if (dtMs > MAX_FRAME_DT_MS) {
      // 长间隔：丢弃，只保留一个标称步，避免"卡一下之后车飞出去"
      ++this.droppedLongFrame;
      dtMs = 1000 / 60;
    }

    if (!this.opts.drivePhysics) return;

    const rawDt = dtMs / 1000;
    // Wasm 返回的是**已含 ±1.5% 时钟伸缩**的步长。物理用它推进本地车外推。
    const adjusted = this.mod._fz_adjusted_dt(rawDt);
    this.mod._fz_update(adjusted);
    // 远端车：各自独立的外推 + 误差衰减 + 视觉矩阵刷新
    this.mod._fz_update_remotes(adjusted);

    this.applyVehicleMatrices();
    ++this.frameCount;
  }

  /** 把每辆远端车的视觉矩阵零拷贝写进 Three.js */
  private applyVehicleMatrices(): void {
    const m = this.mod;
    const base = m._fz_remote_matrix_base();
    for (const v of this.vehicles.values()) {
      if (!v.target) continue;
      const addr = base + v.slot * 16 * 4;
      // ⚠️ **每帧重建视图**：ALLOW_MEMORY_GROWTH 下内存增长会换掉 ArrayBuffer，
      //    缓存的 Float32Array 会变成孤儿（读到全 0 或抛错）。
      //    `new Float32Array(buffer, byteOffset, length)` 是**视图构造**，不做拷贝，
      //    每帧 4 辆车的开销可以忽略。
      const view = new Float32Array(m.HEAPF32.buffer, addr, 16);
      v.target.matrix.fromArray(view, 0);
    }
  }

  // ---------------------------------------------------------------------------
  //  HUD 绑定
  // ---------------------------------------------------------------------------

  /**
   * 绑定左上角计时塔 DOM。
   *
   * 文本**由 Wasm 的 RaceDeltaTracker 产出**（`_fz_build_leaderboard`），
   * 前端只负责把字符串塞进 DOM —— **绝不自行拼格式化字符串**。
   * 本项目"榜首负号方向"反复出错的根因，就是有多个地方各自拼文本。
   */
  setLeaderboardDom(root: HTMLElement, binder: LeaderboardDomBinder): void {
    // root 只用于调试定位：高亮/改文本都靠 binder 的回调（那样调用方
    // 可以自由决定 DOM 结构，本体不强绑任何 class 名或层级）。
    // 这里做一次结构自检，让"传错 root"在启动时可见，而不是等到 HUD 不刷新。
    if (!(root instanceof HTMLElement)) {
      throw new TypeError('[NetworkEngine] setLeaderboardDom: root 不是 HTMLElement');
    }
    this.hudBinder = binder;
  }

  /**
   * 刷新计时塔（HUD 帧率调用即可，不必每物理帧）。
   *
   * 读文本走**文本暂存区 + HEAPU8**（不是 Embind 的对象数组）：
   * 后者每行都会在 JS 侧分配一个对象 + 一个字符串。
   */
  refreshLeaderboard(): number {
    const binder = this.hudBinder;
    if (binder === null) return 0;
    const m = this.mod;
    const rows = m._fz_build_leaderboard();

    for (let i = 0; i < rows; i++) {
      const addr = m._fz_row_text_addr(i);
      if (addr === 0) continue;
      // 文本 ≤ ROW_TEXT_CAP-1 字节的 ASCII（"--" / "-12.34"）；扫描到 '\0'
      const view = m.HEAPU8.subarray(addr, addr + m.ROW_TEXT_CAP);
      let text = '';
      for (let k = 0; k < view.length; k++) {
        if (view[k] === 0) break;
        text += String.fromCharCode(view[k]);
      }
      this.hudScratch[i] = text;
      const el = binder.rowText(i);
      if (el !== null && el.textContent !== text) el.textContent = text;

      const rowEl = binder.rowElement(i);
      if (rowEl !== null) {
        rowEl.classList.toggle(binder.localClass ?? 'is-local', false);
        rowEl.classList.toggle(binder.leaderClass ?? 'is-leader', i === 0);
      }
    }
    // 高亮本地那一行
    this.highlightLocalRow(binder, rows);
    return rows;
  }

  private highlightLocalRow(binder: LeaderboardDomBinder, rows: number): void {
    const localId = this.localVehicleId;
    if (localId === null) return;
    const cls = binder.localClass ?? 'is-local';
    // 先全部清掉，再只给本地行加上 —— 避免上一帧的高亮残留
    for (let i = 0; i < rows; i++) {
      const rowEl = binder.rowElement(i);
      if (rowEl !== null) rowEl.classList.toggle(cls, false);
    }
    const table = this.mod.leaderboard();
    const n = Math.min(rows, table.size());
    for (let i = 0; i < n; i++) {
      if (table.get(i).id !== localId) continue;
      const rowEl = binder.rowElement(i);
      if (rowEl !== null) rowEl.classList.toggle(cls, true);
      break;
    }
    table.delete();   // ⚠️ Embind 的 vector 必须在 JS 侧显式 delete，否则 Wasm 堆泄漏
  }

  private localVehicleId: number | null = null;

  /**
   * 读第 i 行对应的车辆 id。
   *
   * 走 Embind 的低频 `leaderboard()`（每次调用会构造 N 个 JS 对象）——
   * 所以**只在确实需要 id 时调**（例如判断哪一行是本地车做高亮），
   * 而不要每帧为整张表调一次。
   */
  rowIdAt(index: number): number | null {
    const rows = this.mod.leaderboard();
    if (index < 0 || index >= rows.size()) return null;
    return rows.get(index).id;
  }

  /** 本地 vs 领跑者那一行（HUD 第一行，更新最频繁） */
  localDeltaText(): string {
    const m = this.mod;
    m._fz_format_local_vs_leader();
    const addr = m._fz_local_row_addr();
    const view = m.HEAPU8.subarray(addr, addr + m.ROW_TEXT_CAP);
    let text = '';
    for (let k = 0; k < view.length; k++) {
      if (view[k] === 0) break;
      text += String.fromCharCode(view[k]);
    }
    return text;
  }

  /** 两车时差（毫秒，正 = a 领先 b） */
  solveDeltaMs(aId: number, bId: number): number {
    return this.mod._fz_solve_delta_ms(aId, bId);
  }

  // ---------------------------------------------------------------------------
  //  工具 / 遥测
  // ---------------------------------------------------------------------------

  /**
   * 当前堆视图。
   *
   * ⚠️ **绝不缓存返回值**。`ALLOW_MEMORY_GROWTH=1` 下堆增长会替换底层
   *    ArrayBuffer，缓存的视图会静默失效（写入无声无息地丢失）。
   *    本方法刻意每次读 `mod.HEAPU8`，让调用点无法误缓存。
   */
  private heapU8(): Uint8Array {
    return this.mod.HEAPU8;
  }

  /** 本地车的视觉世界矩阵（16 float，零拷贝视图；**每帧重建**） */
  localVisualMatrixView(): Float32Array {
    const addr = this.mod._fz_matrix_slot_addr(this.mod.MATRIX_SLOT_VISUAL);
    return new Float32Array(this.mod.HEAPF32.buffer, addr, 16);
  }

  /** 某远端车的视觉矩阵视图（**每帧重建**，见 applyVehicleMatrices 的说明） */
  vehicleMatrixView(id: number): Float32Array | null {
    const h = this.vehicles.get(id);
    if (!h) return null;
    const addr = this.mod._fz_remote_matrix_base() + h.slot * 64;
    return new Float32Array(this.mod.HEAPF32.buffer, addr, 16);
  }

  /** 时钟/复制遥测快照（HUD 调试面板用） */
  telemetry(): {
    locked: boolean; warp: number; bestRttMs: number;
    serverNowNs: number; visualErrorM: number; frames: number;
    skippedByBackpressure: number; droppedLongFrame: number;
  } {
    const m = this.mod;
    return {
      // ⚠️ C ABI 的 bool 返回是 **0/1 数字**，不是 true/false
      locked: m._fz_is_locked() !== 0,
      warp: m._fz_current_warp(),
      bestRttMs: m._fz_best_rtt_ns() / 1e6,
      serverNowNs: m._fz_server_now_ns(),
      visualErrorM: m._fz_visual_error_m(),
      frames: this.frameCount,
      skippedByBackpressure: this.skippedByBackpressure,
      droppedLongFrame: this.droppedLongFrame,
    };
  }

  dispose(): void {
    this.stopPing();
    this.mod._fz_reset_all();
    this.vehicles.clear();
    this.hudBinder = null;
    this.localVehicleId = null;
  }
}

// -----------------------------------------------------------------------------
//  Three.js 适配示例
// -----------------------------------------------------------------------------
//
//  下面这段不是引擎的一部分，而是**可直接抄进项目的接法**。它演示三件事：
//    ① 用 RTCPeerConnection 建两条通道（不可靠快照 + 可靠控制）
//    ② 每辆远端车用一个 Object3D，matrixAutoUpdate = false，由 Wasm 直写矩阵
//    ③ rAF 里 tick + 低频刷新 HUD
//
//  ```ts
//  import * as THREE from 'three';
//  import { NetworkEngine } from './NetworkEngine';
//  import createForzaNet from './dist/network_physics.js';
//
//  export async function createThreeNetworkBinding(
//    pc: RTCPeerConnection,
//    scene: THREE.Scene,
//    hudRoot: HTMLElement,
//  ) {
//    const engine = await NetworkEngine.create({ moduleFactory: createForzaNet as never });
//
//    // ① 两条通道
//    const { snapshots, control } = NetworkEngine.createChannels(pc);
//    engine.attachUnreliableChannel(snapshots);
//    engine.attachReliableChannel(control);
//    engine.startPing();
//
//    // ② 远端车网格
//    const carGeo = new THREE.BoxGeometry(1.9, 1.2, 4.5);
//    const carMat = new THREE.MeshStandardMaterial({ color: 0xcc3333, metalness: 0.6 });
//    const meshes = new Map<number, THREE.Mesh>();
//
//    function onPeerJoined(id: number) {
//      const mesh = new THREE.Mesh(carGeo, carMat);
//      // ⚠️ 必须关掉 matrixAutoUpdate：我们在 Wasm 侧已经算好了最终世界矩阵
//      mesh.matrixAutoUpdate = false;
//      scene.add(mesh);
//      meshes.set(id, mesh);
//      engine.registerVehicle(id, mesh);
//    }
//
//    // ③ 主循环
//    const hudBinder = {
//      rowText: (i: number) => document.querySelector<HTMLElement>(`#hud-tl .row[data-i="${i}"] .gap`),
//      rowElement: (i: number) => document.querySelector<HTMLElement>(`#hud-tl .row[data-i="${i}"]`),
//      localClass: 'is-local',
//      leaderClass: 'is-leader',
//    };
//    engine.setLeaderboardDom(hudRoot, hudBinder);
//
//    let hudAccum = 0;
//    function frame(now: number) {
//      // 物理推进与渲染解耦：tick 内部已把 dt 钳住、长间隔丢弃
//      engine.tick(now);
//
//      hudAccum += 1;
//      if (hudAccum >= 3) {          // HUD 20Hz 足够，省 DOM 开销
//        hudAccum = 0;
//        engine.refreshLeaderboard();
//      }
//      requestAnimationFrame(frame);
//    }
//    requestAnimationFrame(frame);
//
//    engine.setHardResyncHandler(() => {
//      // 硬同步（>250ms 偏差 / 断线重连）：抑制一帧远端车插值
//      console.warn('[net] 时钟硬同步，抑制这一帧远端插值');
//    });
//
//    return { engine, onPeerJoined };
//  }
//  ```
//
//  ── 为什么远端车用 `matrix.fromArray` 而不是 `position/quaternion` ────────
//    `position.set()` + `quaternion.set()` 会让 three 在 updateMatrix 时
//    重新合成矩阵（一次 4×4 乘法 + 一次 compose）。而 Wasm 已经把
//    最终世界矩阵算好了（物理位姿 × 残余视觉偏移，slerp 已做）。
//    直接 `fromArray` 是把 16 个 float 拷进矩阵 —— 没有三角函数、没有 compose。
//    每辆车每帧省下的就是一次矩阵合成，4 辆车 @120Hz = 480 次/秒。
// -----------------------------------------------------------------------------
