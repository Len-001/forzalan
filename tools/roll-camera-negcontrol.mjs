/*
 * 反证（negative control）：证明「转弯视角倾斜」的断言是**活的**。
 *
 * 背景：`ForzaChaseCamera` 的追尾/引擎盖机位与上方向曾经直接吃车身完整朝向
 * （含侧倾 Roll），于是过弯车身一倾、压路肩一晃，整个画面跟着歪掉。
 * 修复后必须满足：**纯侧倾对镜头零影响**（up 与机位逐元素不变）。
 *
 * 本脚本把修复**按源码字符串回退**成旧写法，生成一个"带病"模块，
 * 与真模块在完全相同的输入下对拍，要求：
 *   · 真模块：侧倾 0 → 侧倾 0.28rad，up 变化 < 1e-9（≈0）
 *   · 病模块：同一对比必须出现 > 0.2rad 的变化（否则说明断言根本没在测这件事）
 * 用法：node tools/roll-camera-negcontrol.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
(0, eval)(fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8'));

const source = fs.readFileSync(path.join(root, 'public', 'js', 'ForzaChaseCamera.js'), 'utf8');
const buggy = source
  .replace('this._noRollQuaternion.setFromRotationMatrix(this._basisMatrix);',
    'this._noRollQuaternion.copy(this._meshQuaternion); // NEGATIVE CONTROL (local offsets)')
  .replace('this._noRollQuaternion);\n    this._desiredPosition', 'this._meshQuaternion);\n    this._desiredPosition')
  .replace('this._meshUp.copy(this._basisUp);\n    this._worldUp.copy(this._basisUp);',
    'this._meshUp.set(0, 1, 0).applyQuaternion(this._meshQuaternion).normalize(); // NEGATIVE CONTROL (up)\n    this._worldUp.copy(this._meshUp);');
assert.notEqual(buggy, source, '反证补丁必须真的改到源码（否则三处锚点已漂移，本脚本失去意义）');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-negcontrol-'));
const buggyPath = path.join(tempDir, 'ForzaChaseCamera.buggy.mjs');
fs.writeFileSync(buggyPath, buggy);

const Fixed = (await import(pathToFileURL(path.join(root, 'public', 'js', 'ForzaChaseCamera.js')).href)).ForzaChaseCamera;
const Buggy = (await import(pathToFileURL(buggyPath).href)).ForzaChaseCamera;

const makeMesh = (roll) => {
  const m = new THREE.Object3D();
  m.position.set(3, 1, -2);
  m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  m.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  return m;
};
const run = (Ctor, roll) => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const controller = new Ctor(camera);
  const mesh = makeMesh(roll);
  controller.reset(mesh);
  for (let i = 0; i < 180; i++) controller.update({ mesh, car: { speed: 50 }, dt: 1 / 60, now: i * 1000 / 60 });
  return camera;
};

const fixedDelta = run(Fixed, 0).up.distanceTo(run(Fixed, 0.28).up);
const buggyDelta = run(Buggy, 0).up.distanceTo(run(Buggy, 0.28).up);
const fixedPos = run(Fixed, 0).position.distanceTo(run(Fixed, 0.28).position);
const buggyPos = run(Buggy, 0).position.distanceTo(run(Buggy, 0.28).position);

console.log(`  fixed  up-delta = ${fixedDelta.toExponential(3)}  pos-delta = ${fixedPos.toExponential(3)}`);
console.log(`  buggy  up-delta = ${buggyDelta.toFixed(4)}  pos-delta = ${buggyPos.toFixed(4)}`);
assert.ok(fixedDelta < 1e-9, '修复后：车身侧倾不得改变相机 up');
assert.ok(fixedPos < 1e-9, '修复后：车身侧倾不得移动追尾机位');
assert.ok(buggyDelta > 0.2, '反证：回退成旧写法后 up 必须明显歪掉（断言是活的）');
assert.ok(buggyPos > 0.2, '反证：回退成旧写法后机位必须被甩开（断言是活的）');

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('roll-camera-negcontrol: PASS（修复有效且断言可报红）');
