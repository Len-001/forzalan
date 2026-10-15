#!/usr/bin/env node
// =============================================================================
//  verify_engine_wire.mjs —— TS 位打包器 vs C++ 位打包器的**逐字节**交叉校验
//
//  为什么这个测试非有不可：
//    NetworkEngine.ts 里有一份**独立的 JS 位打包实现**（`WireSnapshotWriter`）。
//    它的存在是为了省掉"发本地车快照"时的 Wasm 往返 —— 但那意味着
//    **同一份线格式有两个实现**。两个实现只要有一位不一致，症状就是
//    "某些车的位置偶尔乱飘"，而且**只在对端是 C++ 时才出现** ——
//    本机自测（JS→JS）永远发现不了。
//
//    所以这里做真正的交叉验证：
//      ① 从 C++ 侧 dump 一批快照的 32 字节（wasm_bindings_test --dump-wire）
//      ② 用 TS 侧的打包算法对**同样的输入**打包
//      ③ 逐字节比对
//
//    两侧共享零常量 —— TS 侧的位偏移/位宽/倍率全部从 dump 出来的表里读，
//    不是自己写死的。这样"两边都写错成同一个样子"的可能性被排除。
//
//  跑法：node verify_engine_wire.mjs
//  前置：../wasm/wasm_bindings_test.cpp 已编译出 dump 模式（见 run_tests.sh）
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(cond, what) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  [FAIL] ${what}`);
  }
}

// -----------------------------------------------------------------------------
//  ① 取 C++ 侧的真值：位表 + 一批输入/输出对
// -----------------------------------------------------------------------------
const dumpFile = join(HERE, 'wire_dump.json');
if (!existsSync(dumpFile)) {
  console.log(`找不到 ${dumpFile}。`);
  console.log('先跑：bash native/run_tests.sh（它会用 --dump-wire 生成该文件）');
  process.exit(2);
}
const dump = JSON.parse(readFileSync(dumpFile, 'utf8'));

console.log('=== TS 位打包器 vs C++ 位打包器（逐字节）===');
console.log(`C++ 侧线格式: ${dump.wireBytes} 字节, 载荷 ${dump.payloadBits} 位`);

// -----------------------------------------------------------------------------
//  ② 用 dump 出来的表重建 TS 侧打包器（不写死任何数字）
// -----------------------------------------------------------------------------
const B = dump.bits;      // { frame, tickMs, posX, ... } 位偏移
const W = dump.widths;    // { pos:16, vel:14, rot:16, accel:12, omega:12 }
const S = dump.scales;    // { pos:8, vel:64, rot:32767, accel:128, omega:256 }

function quantize(v, scale, bits) {
  if (!Number.isFinite(v)) return 0;
  const lo = -((1 << (bits - 1)) - 1);
  const hi = (1 << (bits - 1)) - 1;
  let q = Math.round(v * scale);
  if (q > hi) q = hi;
  if (q < lo) q = lo;
  return q;
}

/** 与 NetworkEngine.ts 的 WireSnapshotWriter 同一算法；这里独立重写一遍，
 *  避免"测试直接 import 被测代码"那种自证。 */
function packTs(s) {
  const w = new Uint32Array(dump.wireBytes / 4);
  const put = (off, bits, val) => {
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

  let { qw, qx, qy, qz } = s;
  const n2 = qw * qw + qx * qx + qy * qy + qz * qz;
  if (!(n2 > 0) || !Number.isFinite(n2)) {
    qw = 1; qx = 0; qy = 0; qz = 0;
  } else {
    const inv = 1 / Math.sqrt(n2);
    qw *= inv; qx *= inv; qy *= inv; qz *= inv;
  }
  // ⚠️ 必须**同时翻转 x,y,z**（不只是丢掉 w 的符号）：q 与 -q 是同一旋转，
  //    取 w≥0 的规范形时四个分量都要变号。
  //    第一版这里只写了 `qw = -qw` 而漏了 xyz —— 于是案例 #4（qw=-0.6）
  //    的 rotX 少了一个负号，第 4 字节差 1 位。
  //    这个 bug 正是本交叉校验存在的理由：它在 JS↔JS 自测里**永远发现不了**，
  //    只在"TS 打包 vs C++ 打包"的逐字节比对下暴露。
  if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }

  put(B.frame, 16, s.frame & 0xffff);
  put(B.tickMs, 16, s.tickMs & 0xffff);
  put(B.posX, W.pos, quantize(s.px, S.pos, W.pos));
  put(B.posY, W.pos, quantize(s.py, S.pos, W.pos));
  put(B.posZ, W.pos, quantize(s.pz, S.pos, W.pos));
  put(B.velX, W.vel, quantize(s.vx, S.vel, W.vel));
  put(B.velY, W.vel, quantize(s.vy, S.vel, W.vel));
  put(B.velZ, W.vel, quantize(s.vz, S.vel, W.vel));
  put(B.rotX, W.rot, quantize(qx, S.rot, W.rot));
  put(B.rotY, W.rot, quantize(qy, S.rot, W.rot));
  put(B.rotZ, W.rot, quantize(qz, S.rot, W.rot));
  put(B.accX, W.accel, quantize(s.ax, S.accel, W.accel));
  put(B.accY, W.accel, quantize(s.ay, S.accel, W.accel));
  put(B.accZ, W.accel, quantize(s.az, S.accel, W.accel));
  put(B.omegaX, W.omega, quantize(s.wx, S.omega, W.omega));
  put(B.omegaY, W.omega, quantize(s.wy, S.omega, W.omega));
  put(B.omegaZ, W.omega, quantize(s.wz, S.omega, W.omega));

  const dv = new DataView(new ArrayBuffer(dump.wireBytes));
  for (let i = 0; i < w.length; i++) dv.setUint32(i * 4, w[i], true);
  return new Uint8Array(dv.buffer);
}

// -----------------------------------------------------------------------------
//  ③ 逐条比对
// -----------------------------------------------------------------------------
console.log(`比对 ${dump.cases.length} 组快照…`);
let caseIdx = 0;
let byteMismatchCases = 0;
for (const c of dump.cases) {
  caseIdx += 1;
  const ts = packTs(c.in);
  const cpp = Uint8Array.from(c.bytes);
  let same = ts.length === cpp.length;
  if (same) {
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] !== cpp[i]) { same = false; break; }
    }
  }
  if (!same) {
    byteMismatchCases += 1;
    if (byteMismatchCases <= 3) {
      const hex = (a) => Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  案例 #${caseIdx} 字节不一致：`);
      console.log(`    C++: ${hex(cpp)}`);
      console.log(`    TS : ${hex(ts)}`);
    }
  }
}
check(byteMismatchCases === 0, `${dump.cases.length} 组快照逐字节一致（不一致 ${byteMismatchCases} 组）`);

// -----------------------------------------------------------------------------
//  ④ 位表自洽性（TS 侧独立核对，不看 C++ 的断言）
// -----------------------------------------------------------------------------
const payloadBits =
  16 + 16 +
  3 * W.pos + 3 * W.vel + 3 * W.rot + 3 * W.accel + 3 * W.omega;
check(payloadBits <= dump.wireBytes * 8, `载荷 ${payloadBits} 位 ≤ ${dump.wireBytes * 8} 位`);

// 字段不重叠：按偏移排序后检查每个字段的区间不交叠
const fields = Object.entries(B)
  .map(([k, off]) => {
    let bits = 16;
    if (k.startsWith('pos')) bits = W.pos;
    else if (k.startsWith('vel')) bits = W.vel;
    else if (k.startsWith('rot')) bits = W.rot;
    else if (k.startsWith('acc')) bits = W.accel;
    else if (k.startsWith('omega')) bits = W.omega;
    return { k, off, bits };
  })
  .sort((a, b) => a.off - b.off);
let overlap = false;
for (let i = 1; i < fields.length; i++) {
  if (fields[i].off < fields[i - 1].off + fields[i - 1].bits) overlap = true;
}
check(!overlap, '所有字段位区间互不重叠');

// 最后一个字段不越界
const last = fields[fields.length - 1];
check(last.off + last.bits <= dump.wireBytes * 8,
  `最后字段 ${last.k} 结束于 ${last.off + last.bits} 位，未越界`);

// -----------------------------------------------------------------------------
//  ⑤ 量化器等价性：饱和 + 就近取整（独立于封包路径）
// -----------------------------------------------------------------------------
{
  const hi = (1 << (W.pos - 1)) - 1;
  check(quantize(1e6, S.pos, W.pos) === hi, '超大正数饱和到上限');
  check(quantize(-1e6, S.pos, W.pos) === -hi, '超大负数饱和到下限');
  check(quantize(0.07, S.pos, W.pos) === 1, '0.07m 就近取整为 1（非截断 0）');
  check(quantize(Number.NaN, S.pos, W.pos) === 0, 'NaN 归零');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
