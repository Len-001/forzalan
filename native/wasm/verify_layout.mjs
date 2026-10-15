#!/usr/bin/env node
/* =============================================================================
 *  verify_layout.mjs —— 跨语言布局一致性校验（node 直接跑，不需要 tsc/emcc）
 *
 *  为什么需要它：
 *    `NetworkPhysicsClient.ts` 里 `assertLayout()` 硬写了几个期望值
 *    （96 / 16 / 32 / 80）。这些数字必须与 C++ 的 offsetof 一致，
 *    否则运行时才会炸，而且症状是"位置偶尔乱跳"这种极难定位的表现。
 *    C++ 侧的真实布局由 bridge_test.cpp 跑出来写进 layout.json，
 *    这里把 TS 源码里写的期望值抽出来对一遍 —— **两侧不共享任何常量**，
 *    因此这是真正的交叉校验，不是自证。
 *
 *  另外做一个纯 JS 的打包往返测试：按 layout.json 的偏移用 DataView 写一遍
 *  再读回来，确认线格式（小端、字段宽度、对齐 padding）确实可用。
 *
 *  运行：node verify_layout.mjs
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; }
  else { fail++; console.log(`  [FAIL] ${what} ${detail}`); }
};

// ---------------------------------------------------------------- 读 C++ 布局
const layoutPath = path.join(here, 'layout.json');
if (!fs.existsSync(layoutPath)) {
  console.error('找不到 layout.json —— 请先跑 bridge_test（它会 dump 真实布局）');
  process.exit(2);
}
const L = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
console.log('=== 跨语言布局一致性校验 ===\n');
console.log(`C++ 侧真实布局：size=${L.snapshotSize} align=${L.align} LE=${L.littleEndian}`);
console.log(`  offsets: ${JSON.stringify(L.offsets)}\n`);

check(L.snapshotSize === 96, 'C++ 快照 = 96 字节');
check(L.align === 16, 'C++ 快照 16 字节对齐');
check(L.littleEndian === true, 'C++ 侧小端（与 Wasm 线性内存一致，无需字节序转换）');

// ------------------------------------------------- 抽 TS 源码里硬写的期望值
const ts = fs.readFileSync(path.join(here, 'NetworkPhysicsClient.ts'), 'utf8');
const expect = (re, name) => {
  const m = ts.match(re);
  check(m !== null, `TS 里能找到 ${name} 的期望值`);
  return m ? Number(m[1]) : NaN;
};
const tsSize = expect(/snapshotSize\s*!==\s*(\d+)/, 'snapshotSize');
const tsPos = expect(/OFF_POSITION\s*!==\s*(\d+)/, 'OFF_POSITION');
const tsRot = expect(/OFF_ROTATION\s*!==\s*(\d+)/, 'OFF_ROTATION');
const tsAcc = expect(/OFF_ACCEL\s*!==\s*(\d+)/, 'OFF_ACCEL');

console.log('TS 侧 assertLayout() 里写的期望值：');
console.log(`  snapshotSize=${tsSize} position=${tsPos} rotation=${tsRot} accel=${tsAcc}\n`);

check(tsSize === L.snapshotSize, 'TS 期望的 size 与 C++ 一致',
  `${tsSize} vs ${L.snapshotSize}`);
check(tsPos === L.offsets.position, 'TS 期望的 position 偏移与 C++ 一致',
  `${tsPos} vs ${L.offsets.position}`);
check(tsRot === L.offsets.rotation, 'TS 期望的 rotation 偏移与 C++ 一致',
  `${tsRot} vs ${L.offsets.rotation}`);
check(tsAcc === L.offsets.accel, 'TS 期望的 accel 偏移与 C++ 一致',
  `${tsAcc} vs ${L.offsets.accel}`);

// --------------------------------------------------------- 纯 JS 打包往返测试
console.log('\nJS 侧 DataView 打包往返（模拟 pushSnapshotRaw / packSnapshot）：');
{
  const buf = new ArrayBuffer(L.snapshotSize);
  const dv = new DataView(buf);
  const o = L.offsets;

  const NEG = { frame: 4242, tickMs: 987654, serverTimeSec: 1234.5 };
  const POS = { x: 10.0, y: 1.5, z: -20.0 };
  const ROT = { w: 1.0, x: 0, y: 0, z: 0 };
  const VEL = { x: 55.0, y: 0, z: 0 };
  const ACC = { x: 0, y: 0, z: -3.0 };

  dv.setUint32(o.frame, NEG.frame, true);
  dv.setUint32(o.tickMs, NEG.tickMs, true);
  dv.setFloat32(o.serverTimeSec, NEG.serverTimeSec, true);
  dv.setFloat32(o.position + 0, POS.x, true);
  dv.setFloat32(o.position + 4, POS.y, true);
  dv.setFloat32(o.position + 8, POS.z, true);
  dv.setFloat32(o.rotation + 0, ROT.w, true);
  dv.setFloat32(o.rotation + 4, ROT.x, true);
  dv.setFloat32(o.rotation + 8, ROT.y, true);
  dv.setFloat32(o.rotation + 12, ROT.z, true);
  dv.setFloat32(o.velocity + 0, VEL.x, true);
  dv.setFloat32(o.velocity + 4, VEL.y, true);
  dv.setFloat32(o.velocity + 8, VEL.z, true);
  dv.setFloat32(o.accel + 0, ACC.x, true);
  dv.setFloat32(o.accel + 4, ACC.y, true);
  dv.setFloat32(o.accel + 8, ACC.z, true);

  check(dv.getUint32(o.frame, true) === NEG.frame, 'frame 往返正确');
  check(dv.getUint32(o.tickMs, true) === NEG.tickMs, 'tickMs 往返正确');
  check(Math.abs(dv.getFloat32(o.serverTimeSec, true) - NEG.serverTimeSec) < 1e-3,
    'serverTimeSec 往返正确');
  check(dv.getFloat32(o.position + 0, true) === POS.x &&
    dv.getFloat32(o.position + 4, true) === POS.y &&
    dv.getFloat32(o.position + 8, true) === POS.z, 'position 三轴往返正确');
  check(dv.getFloat32(o.accel + 8, true) === ACC.z, 'accel 第三轴往返正确');

  // 关键：确认"写到最后 4 字节"不会越界 —— accel.z 结束于 offset 92+4 = 96 ✓
  check(o.accel + 12 <= L.snapshotSize, '最后一个字段写入不越界',
    `accel+12=${o.accel + 12} <= ${L.snapshotSize}`);

  // padding 必须真的有洞（否则说明布局和 docs 不一致 —— 也是有用的信息）
  // 有效载荷 = frame4 + tick4 + serverTime4 + pos12 + quat16 + vel12 + angvel12 + accel12 = 76
  const payload = 4 + 4 + 4 + 12 + 16 + 12 + 12 + 12;
  const padBytes = L.snapshotSize - payload;
  check(payload === 76, '有效载荷 = 76 字节');
  check(padBytes === 20, '对齐 padding = 20 字节（5 个 _pad × 4B）', `${padBytes}B`);
  console.log(`  · padding ${padBytes}B / 有效载荷 ${L.snapshotSize - padBytes}B`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
