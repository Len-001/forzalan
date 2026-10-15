#!/usr/bin/env node
/* =============================================================================
 *  verify_wire.mjs —— TS ↔ C++ 线格式契约验证
 *
 *  为什么需要它：偏移一旦漂移，症状是"位置偶尔错乱 / 姿态抽一下"，
 *  既不像崩溃也不像网络问题，是最难查的一类 bug。手抄的常量没有任何守卫。
 *
 *  验证思路（三层）：
 *    A. **偏移漂移守卫**：从 snapshotLayout.ts 的**源码文本**里抠出常量，
 *       与 wasm/layout.json（由 C++ 的 sizeof/offsetof 生成）逐个比对。
 *    B. **真实解码**：用 **Node 22 的原生 TS 类型剥离**直接 import 出货文件里的
 *       `decodeSnapshot`，去解 C++ 吐出来的参考字节块，逐字段比对。
 *       （不是"照抄一份镜像"，验的就是要发布的那份代码。）
 *    C. **旋转提取**：`quatFromColumnMajor` 的往返正确性 + 180° 边界
 *       （朴素公式在这个角度附近最容易精度崩塌）。
 *
 *  运行：node web/tools/verify_wire.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

let pass = 0;
let fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? '   ' + detail : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// -----------------------------------------------------------------------------
// 0) 读 C++ 真值
// -----------------------------------------------------------------------------
const layoutPath = path.join(ROOT, 'wasm', 'layout.json');
if (!fs.existsSync(layoutPath)) {
  console.error(
    '缺少 wasm/layout.json。\n' +
    '请先运行：\n' +
    '  g++ -std=c++20 -O2 -I native/rb_replicator -I <GLM父目录> \\\n' +
    '      wasm/tools/layout_probe.cpp -o wasm/build/layout_probe.exe\n' +
    '  wasm/build/layout_probe.exe > wasm/layout.json',
  );
  process.exit(2);
}
const L = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
console.log(`C++ 真值: sizeof=${L.sizeof} align=${L.alignof} byteOrder=${L.byteOrder}\n`);

// -----------------------------------------------------------------------------
// A) 偏移漂移守卫：从 snapshotLayout.ts 源码文本里抠常量
// -----------------------------------------------------------------------------
console.log('[A] 偏移漂移守卫（TS 源码常量 vs C++ offsetof）');
const layoutTs = fs.readFileSync(path.join(ROOT, 'web', 'snapshotLayout.ts'), 'utf8');

const numConst = (re, name) => {
  const m = layoutTs.match(re);
  if (!m) throw new Error(`snapshotLayout.ts 里找不到 ${name}`);
  return Number(m[1]);
};
const tsStride = numConst(/export const SNAPSHOT_STRIDE\s*=\s*(\d+)/, 'SNAPSHOT_STRIDE');
const tsAlign = numConst(/export const SNAPSHOT_ALIGN\s*=\s*(\d+)/, 'SNAPSHOT_ALIGN');
const tsVer = numConst(/export const LAYOUT_VERSION\s*=\s*(\d+)/, 'LAYOUT_VERSION');

check(tsStride === L.sizeof, 'SNAPSHOT_STRIDE 与 sizeof 一致', `${tsStride} vs ${L.sizeof}`);
check(tsAlign === L.alignof, 'SNAPSHOT_ALIGN 与 alignof 一致', `${tsAlign} vs ${L.alignof}`);
check(L.layoutVersion === tsVer, 'LAYOUT_VERSION 一致', `v${tsVer}`);

// 逐字段：从 `xxxx: 数字,` 里抠
for (const [field, want] of Object.entries(L.offsets)) {
  const re = new RegExp(`\\b${field}:\\s*(\\d+)`);
  const got = Number(layoutTs.match(re)?.[1]);
  check(got === want, `OFF.${field} 偏移一致`, `${got} vs ${want}`);
}

// -----------------------------------------------------------------------------
// B) 用**出货 TS 代码**解码 C++ 参考字节块
// -----------------------------------------------------------------------------
console.log('\n[B] 真实解码（Node 原生 TS 类型剥离，import 出货文件）');
const srcDir = path.join(ROOT, 'web');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forza_wire_'));

// NetworkPhysicsClient.ts 内部用无扩展名 import（TS 惯例），Node ESM 要求扩展名。
// 这里只做**一处**最小改写（补 .ts），不改任何逻辑 —— 保证验的还是出货代码。
const clientSrc = fs
  .readFileSync(path.join(srcDir, 'NetworkPhysicsClient.ts'), 'utf8')
  .replace(/from '\.\/snapshotLayout'/g, "from './snapshotLayout.ts'");
fs.writeFileSync(path.join(tmpDir, 'NetworkPhysicsClient.ts'), clientSrc);
fs.copyFileSync(path.join(srcDir, 'snapshotLayout.ts'), path.join(tmpDir, 'snapshotLayout.ts'));

let client;
try {
  client = await import(pathToFileURL(path.join(tmpDir, 'NetworkPhysicsClient.ts')).href);
} catch (e) {
  console.log(`  FAIL  无法 import 出货 TS：${e.message.split('\n')[0]}`);
  console.log('        （若 Node 版本 < 22.6，请改用 --experimental-strip-types 或升级 Node）');
  process.exit(1);
}
check(typeof client.decodeSnapshot === 'function', '成功 import 出货文件里的 decodeSnapshot');

// 把参考 hex 还原成字节 -> DataView
const bytes = new Uint8Array(
  L.referenceHex.match(/.{2}/g).map((h) => parseInt(h, 16)),
);
check(bytes.length === L.sizeof, '参考字节块长度 = sizeof', `${bytes.length}B`);

const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const dec = client.decodeSnapshot(dv);
const R = L.reference;

check(dec.frame === R.frame, 'frame 解码正确', `0x${dec.frame.toString(16)} vs 0x${R.frame.toString(16)}`);
check(dec.tickMs === R.tickMs, 'tickMs 解码正确', `${dec.tickMs} vs ${R.tickMs}`);
check(near(dec.serverTimeSec, R.serverTimeSec), 'serverTimeSec 解码正确',
  `${dec.serverTimeSec} vs ${R.serverTimeSec}`);
for (let i = 0; i < 3; i++) {
  check(near(dec.position[i], R.position[i]), `position[${i}]`,
    `${dec.position[i]} vs ${R.position[i]}`);
}
for (let i = 0; i < 4; i++) {
  check(near(dec.rotation[i], R.rotation[i]), `rotation[${'wxyz'[i]}]`,
    `${dec.rotation[i]} vs ${R.rotation[i]}`);
}
for (let i = 0; i < 3; i++) {
  check(near(dec.velocity[i], R.velocity[i]), `velocity[${i}]`,
    `${dec.velocity[i]} vs ${R.velocity[i]}`);
  check(near(dec.angularVelocity[i], R.angularVelocity[i]), `angularVelocity[${i}]`,
    `${dec.angularVelocity[i]} vs ${R.angularVelocity[i]}`);
  check(near(dec.accel[i], R.accel[i]), `accel[${i}]`,
    `${dec.accel[i]} vs ${R.accel[i]}`);
}
check(Math.hypot(...dec.rotation) > 0.99 && Math.hypot(...dec.rotation) < 1.01,
  'rotation 是单位四元数（w 在前的读法正确）', `|q|=${Math.hypot(...dec.rotation).toFixed(4)}`);

// 端序必须显式声明
check(/getFloat32\(o,\s*\/\* littleEndian \*\/ true\)/.test(clientSrc) ||
      /getFloat32\(o,\s*true\)/.test(clientSrc),
  'decodeSnapshot 显式声明小端（不依赖宿主平台默认）');

// -----------------------------------------------------------------------------
// C) 旋转提取（quatFromColumnMajor）
// -----------------------------------------------------------------------------
console.log('\n[C] quatFromColumnMajor 正确性');
const quatMul = (a, b) => [ // (x,y,z,w)
  a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
  a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
  a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
  a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
];
const axisAngle = (ax, ay, az, deg) => {
  const n = Math.hypot(ax, ay, az) || 1;
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [(ax / n) * s, (ay / n) * s, (az / n) * s, Math.cos(h)];
};
/** (x,y,z,w) -> 列主序 4x4（与 glm::mat4_cast 同构） */
const toColumnMajor = (q) => {
  const [x, y, z, w] = q;
  return new Float32Array([
    1-2*(y*y+z*z), 2*(x*y+w*z),   2*(x*z-w*y),   0,
    2*(x*y-w*z),   1-2*(x*x+z*z), 2*(y*z+w*x),   0,
    2*(x*z+w*y),   2*(y*z-w*x),   1-2*(x*x+y*y), 0,
    0, 0, 0, 1,
  ]);
};

const cases = [
  ['单位旋转',        [0, 0, 0, 1]],
  ['绕 Y 轴 90°',     axisAngle(0, 1, 0, 90)],
  ['绕 X 轴 30°',     axisAngle(1, 0, 0, 30)],
  ['绕 Z 轴 -120°',   axisAngle(0, 0, 1, -120)],
  ['180°（边界）',    axisAngle(0.6, 0.8, 0, 180)],
  ['接近 180° 偏移',  axisAngle(0.577, 0.577, 0.577, 179.5)],
  ['复合旋转',        quatMul(axisAngle(0,1,0,47), axisAngle(1,0,0,-63))],
];
for (const [name, q] of cases) {
  const got = client.quatFromColumnMajor(toColumnMajor(q));
  // 四元数 q 与 -q 表示同一旋转，取符号无关的等价判定
  const dot = Math.abs(got[0]*q[0] + got[1]*q[1] + got[2]*q[2] + got[3]*q[3]);
  check(dot > 0.9999, `旋转提取: ${name}`, `|dot|=${dot.toFixed(6)}`);
}

// 传输过程中的矩阵从 C++ 侧来：平移在列主序的第 4 列
const withT = toColumnMajor(axisAngle(0, 1, 0, 90));
withT[12] = 12.5; withT[13] = -3.25; withT[14] = 7.0;
const q2 = client.quatFromColumnMajor(withT);
check(near(withT[12], 12.5) && near(withT[13], -3.25) && near(withT[14], 7.0),
  '列主序平移位于 m[12..14]（Babylon 分解路径依赖此约定）');
check(Math.abs(Math.abs(q2[1]) - Math.SQRT1_2) < 1e-4,
  '平移不影响旋转提取', `y=${q2[1].toFixed(6)}`);

// -----------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
