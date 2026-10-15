/* =============================================================================
 *  snapshotLayout.ts —— 网络快照的线格式常量
 *
 *  ⚠️ **本文件由 C++ 真值生成，不要手改。**
 *
 *  生成链：
 *      wasm/tools/layout_probe.cpp      （C++ 侧 sizeof / offsetof 真值）
 *        -> g++ 编译执行 -> wasm/layout.json
 *        -> node wasm/tools/gen_layout.mjs -> 本文件
 *
 *  校验链：
 *      node web/tools/verify_wire.mjs   （用 C++ 吐出的参考字节块解码，逐字段比对）
 *
 *  为什么非要生成不可：TS 与 C++ 的偏移一旦漂移，症状是"位置偶尔错乱/姿态抽一下"，
 *  既不像崩溃也不像网络问题，极难定位。手抄的常量没有守卫，生成 + 交叉校验才有。
 * ========================================================================== */

/** 线格式版本。C++ 侧 sizeof/offsetof 变动时必须 +1，并在网络握手时比对。 */
export const LAYOUT_VERSION = 1;

/** 单个快照的字节数 = sizeof(RigidBodyNetSnapshot) */
export const SNAPSHOT_STRIDE = 96;

/** 快照要求的对齐（WASM 堆缓冲区必须按它对齐） */
export const SNAPSHOT_ALIGN = 16;

/** 构建/目标平台的字节序。所有现代浏览器平台都是 little。 */
export const WIRE_BYTE_ORDER: 'little' | 'big' = 'little';

/** 字段偏移（字节）—— 与 offsetof(RigidBodyNetSnapshot, X) 一致 */
export const OFF = {
  frame: 0,
  tickMs: 4,
  serverTimeSec: 8,
  /** glm::vec3 position —— 3 × float32 */
  position: 16,
  /** glm::quat rotation —— (w, x, y, z) 连续 4 × float32，注意 **w 在前** */
  rotation: 32,
  /** glm::vec3 velocity */
  velocity: 48,
  /** glm::vec3 angularVelocity —— rad/s */
  angularVelocity: 64,
  /** glm::vec3 accel —— m/s² */
  accel: 80,
} as const;

/* -----------------------------------------------------------------------------
 *  枚举：刻意**不用 `const enum`**
 *
 *  `const enum` 在 `isolatedModules`（Vite / esbuild / Babel 的默认前提）下是
 *  已知的麻烦来源：单文件转译器看不到跨文件的常量，要么报错要么退化成普通 enum。
 *  而 Node 的 strip-only TS 模式更是直接拒绝（它只删类型、不做代码生成）。
 *
 *  统一用「`as const` 对象 + 同名类型别名」：既是值也是类型，零运行时代码生成，
 *  在任意打包器/单文件转译器下都表现一致。
 * -------------------------------------------------------------------------- */

/** 快照被 C++ 接受/丢弃的结果 */
export const PushResult = { Rejected: 0, Accepted: 1 } as const;
export type PushResult = (typeof PushResult)[keyof typeof PushResult];

/** 与 C++ `ReplState` 一一对应 */
export const ReplState = {
  Empty: 0,
  Extrapolating: 1,
  Corrected: 2,
  Stale: 3,
} as const;
export type ReplState = (typeof ReplState)[keyof typeof ReplState];

/** 与 C++ `SyncEvent` 一一对应 */
export const SyncEvent = {
  None: 0,
  HardResync: 1,
  SampleRejected: 2,
} as const;
export type SyncEvent = (typeof SyncEvent)[keyof typeof SyncEvent];

/**
 * 编译期/运行期自检：本文件里写死的数字，必须与 WASM 模块自报的一致。
 * 在 `NetworkPhysicsClient.init()` 里调用一次；不一致就直接抛错，
 * **绝不允许带着漂移的偏移继续跑** —— 那样只会得到"偶尔错乱"的玄学 bug。
 */
export function assertLayoutMatchesWasm(
  stride: number,
  offsetOf: (field: number) => number,
): void {
  const fail = (what: string, want: number, got: number): never => {
    throw new Error(
      `[forza_net] 线格式不一致：${what} 期望 ${want}，WASM 报 ${got}。` +
        `请重新生成 snapshotLayout.ts（node wasm/tools/gen_layout.mjs）。`,
    );
  };
  if (stride !== SNAPSHOT_STRIDE) fail('stride', SNAPSHOT_STRIDE, stride);

  // 字段序号与 bindings.cpp 里 forzaSnapshotOffset 的 switch 一一对应
  const order: ReadonlyArray<readonly [number, number]> = [
    [0, OFF.frame],
    [1, OFF.tickMs],
    [2, OFF.serverTimeSec],
    [3, OFF.position],
    [4, OFF.rotation],
    [5, OFF.velocity],
    [6, OFF.angularVelocity],
    [7, OFF.accel],
  ];
  for (const [idx, want] of order) {
    const got = offsetOf(idx);
    if (got !== want) fail(`offset[${idx}]`, want, got);
  }
}
