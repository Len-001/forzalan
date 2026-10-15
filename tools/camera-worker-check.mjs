import assert from 'node:assert/strict';
import fs from 'node:fs';

(0, eval)(fs.readFileSync(new URL('../public/libs/three.min.js', import.meta.url), 'utf8'));
const { ForzaChaseCamera } = await import('../public/js/ForzaChaseCamera.js');

const EPS = 1e-3;
const approx = (actual, expected, tolerance = EPS, message = '') => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message} expected ${expected}, got ${actual}`);
};
const vectorDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const makeMesh = (x = 0, y = 0, z = 0, yaw = 0) => {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, z);
  mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return mesh;
};
const makeCamera = () => new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const runFrames = (controller, mesh, car, frames = 120, lookX = 0, lookY = 0, mode = 0) => {
  for (let i = 0; i < frames; i += 1) {
    controller.update({ mesh, car, dt: 1 / 60, now: i * 1000 / 60, lookX, lookY, mode, ghostAmplitude: 0 });
  }
};

{
  const mesh = makeMesh(10, 3, -4, Math.PI / 2);
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  controller.reset(mesh);
  const expectedPosition = new THREE.Vector3(0, 1.65, -4.8)
    .applyQuaternion(mesh.quaternion).add(mesh.position);
  const expectedLook = new THREE.Vector3(0, 0.9, 2.2)
    .applyQuaternion(mesh.quaternion).add(mesh.position);
  approx(camera.position.x, expectedPosition.x, EPS, 'reset uses mesh position and +Z-local chase offset');
  approx(camera.position.y, expectedPosition.y, EPS, 'reset uses mesh local height');
  approx(camera.position.z, expectedPosition.z, EPS, 'reset uses mesh local rear offset');
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).dot(expectedLook.clone().sub(camera.position).normalize()) > 0.999,
    'reset points at the mesh look target');
}

{
  const mesh = makeMesh(0, 0, 0, 0);
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  controller.reset(mesh);
  const before = camera.position.clone();
  mesh.position.set(12, 0, 0);
  const car = { pos: new THREE.Vector3(-800, 0, 500), quat: new THREE.Quaternion(), speed: 0 };
  const desired = new THREE.Vector3(12, 1.65, -4.8);
  controller.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode: 0, ghostAmplitude: 0 });
  assert.ok(camera.position.x > before.x && camera.position.x < desired.x,
    'regular update damps toward interpolated mesh instead of snapping');
  assert.ok(Math.abs(camera.position.x - car.pos.x) > 100,
    'camera ignores non-interpolated physical car position');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = { speed: 0, acceleration: 0 };
  controller.reset(mesh);
  runFrames(controller, mesh, car, 180);
  const stillFov = controller.fov;
  const stillPullback = controller.pullback;
  car.speed = 120 / 3.6;
  runFrames(controller, mesh, car, 180);
  const midFov = controller.fov;
  const midPullback = controller.pullback;
  car.speed = 240 / 3.6;
  car.acceleration = 10;
  runFrames(controller, mesh, car, 240);
  const fastFov = controller.fov;
  const fastPullback = controller.pullback;
  assert.ok(stillFov >= 59.9 && stillFov <= 60.2, `still FOV is ${stillFov}`);
  assert.ok(stillFov < midFov && midFov < fastFov, 'FOV rises monotonically with speed');
  assert.ok(stillPullback < midPullback && midPullback < fastPullback, 'pullback rises with speed and acceleration');
  assert.ok(fastFov <= 80.1 && fastPullback <= 1.501, 'speed responses stay within production limits');
  assert.ok(Math.abs(controller._desiredPosition.y - 1.65) <= 0.03,
    `chase mount keeps the specified 1.65m height at speed (${controller._desiredPosition.y})`);
  assert.ok(Math.abs(controller._desiredLook.y - 0.9) <= EPS,
    'chase lookAt keeps the specified 0.9m height at speed');
  assert.ok(controller.fov >= 60 - EPS && controller.fov <= 80 + EPS,
    `controller FOV remains inside 60-80 degrees (${controller.fov})`);
  assert.ok(controller.pullback <= 1.5 + EPS,
    `controller pullback remains at or below 1.5m (${controller.pullback})`);
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = {
    speed: 0,
    axMeasured: 8,
    ayPrev: 8,
    steerAngle: 0.25,
    body: { angularVelocity: { y: 0.5 } },
  };
  controller.reset(mesh);
  runFrames(controller, mesh, car, 180);
  assert.ok(controller.pullback > 0.25, 'production axMeasured drives acceleration pullback');
  assert.equal(controller.roll, 0, 'camera roll is permanently disabled (no turning tilt)');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = { speed: 20, ayPrev: 8, steerAngle: 0, input: { steer: 0 } };
  const axis = new THREE.Vector3(0, 1, 0);
  controller.reset(mesh);
  for (let i = 1; i <= 120; i += 1) {
    mesh.quaternion.setFromAxisAngle(axis, -i * 0.5 / 60);
    controller.update({ mesh, car, dt: 1 / 60 });
  }
  assert.equal(controller.roll, 0,
    'turning the mesh no longer tilts the camera (roll stays 0)');
  assert.ok(camera.up.y > 0.99,
    'camera up vector stays vertical while cornering (no roll effect)');
}

{
  // ★ 反例回归（用户报障"转弯时视角跟着车身倾斜"）。
  //   上面那段只转了**航向**（无侧倾），因此在修复前也是绿的 —— 它守不住这个 bug。
  //   真正的反例是**车身侧倾**：同一台车（同位置 / 同航向 / 同速度），只差一个绕
  //   车头轴的 Roll。要求：
  //     · 相机的 up 与有侧倾时逐元素一致（水平线不歪）
  //     · 机位完全一致（侧倾不再把追尾机位横向甩出去）
  //   修复前 up 直接取车身完整朝向，侧倾 0.28rad ⇒ up 立刻差出 0.28rad，此处必红。
  const GRID_YAW = 0.4;
  const ROLL_AXIS = new THREE.Vector3(0, 0, 1);
  const bankedRun = (roll) => {
    const mesh = makeMesh(3, 1, -2, GRID_YAW);
    mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(ROLL_AXIS, roll));
    const camera = makeCamera();
    const controller = new ForzaChaseCamera(camera);
    controller.reset(mesh);
    runFrames(controller, mesh, { speed: 180 / 3.6 }, 180);
    return camera;
  };
  const level = bankedRun(0);
  const banked = bankedRun(0.28);
  assert.ok(level.up.distanceTo(banked.up) < 1e-9,
    `body roll must not tilt the camera horizon (up=${JSON.stringify(banked.up)})`);
  assert.ok(level.position.distanceTo(banked.position) < 1e-9,
    'body roll must not swing the chase mount sideways');
  assert.ok(banked.up.y > 0.99,
    `camera up stays near world vertical while the body is banked (up.y=${banked.up.y})`);
  // 反向校验：侧倾确实被消除了，而不是"两台车恰好都一样歪"。
  const rolledMesh = makeMesh(3, 1, -2, GRID_YAW)
    .quaternion.clone()
    .multiply(new THREE.Quaternion().setFromAxisAngle(ROLL_AXIS, 0.28));
  const meshUpUnderRoll = new THREE.Vector3(0, 1, 0).applyQuaternion(rolledMesh);
  assert.ok(meshUpUnderRoll.angleTo(banked.up) > 0.2,
    'camera up must differ from the raw body up while the body is banked');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = { speed: 0 };
  controller.reset(mesh);
  runFrames(controller, mesh, car, 180);
  const before = camera.position.clone();
  controller.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode: 0, ghostAmplitude: 0 });
  assert.ok(vectorDistance(camera.position, before) < 1e-8,
    'stationary camera does not micro-vibrate');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = { speed: 200 / 3.6 };
  controller.reset(mesh);
  runFrames(controller, mesh, car, 180);
  const before = camera.position.clone();
  controller.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode: 0, ghostAmplitude: 0 });
  assert.ok(vectorDistance(camera.position, before) > 1e-4,
    'high speed camera adds bounded micro-vibration');
}

{
  const mesh = makeMesh();
  const car = { speed: 0 };
  const calmCamera = makeCamera();
  const ghostCamera = makeCamera();
  const calm = new ForzaChaseCamera(calmCamera);
  const ghost = new ForzaChaseCamera(ghostCamera);
  calm.reset(mesh);
  ghost.reset(mesh);
  runFrames(calm, mesh, car, 120);
  runFrames(ghost, mesh, car, 120);
  calm.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode: 0, ghostAmplitude: 0 });
  ghost.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode: 0, ghostAmplitude: 0.35 });
  assert.ok(vectorDistance(calmCamera.position, ghostCamera.position) < 1e-8,
    'ghost overlap does not add camera vibration');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = { speed: 0 };
  controller.reset(mesh);
  runFrames(controller, mesh, car, 120, 0, 1);
  approx(controller.freeLookYaw, Math.PI, 0.02, 'down maps to 180 degree rear view');
  runFrames(controller, mesh, car, 120, -1, 0);
  approx(controller.freeLookYaw, Math.PI / 2, 0.02, 'left maps to +90 degree side view');
  runFrames(controller, mesh, car, 120, 1, 0);
  approx(controller.freeLookYaw, -Math.PI / 2, 0.02, 'right maps to -90 degree side view');
  runFrames(controller, mesh, car, 120, -1, 1);
  approx(controller.freeLookYaw, 3 * Math.PI / 4, 0.02, 'down-left maps to +135 degree blind spot');
  runFrames(controller, mesh, car, 120, 1, 1);
  approx(controller.freeLookYaw, -3 * Math.PI / 4, 0.02, 'down-right maps to -135 degree blind spot');
  runFrames(controller, mesh, car, 180, 0, 0);
  assert.ok(Math.abs(controller.freeLookYaw) < 0.02, 'free-look smoothly returns to forward after release');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  controller.reset(mesh);
  runFrames(controller, mesh, { speed: 0 }, 240, 0.6, 0.8);
  approx(controller.freeLookYaw, Math.atan2(-0.6, -0.8), 0.02,
    'analog stick values map continuously to an omnidirectional look angle');
  runFrames(controller, mesh, { speed: 0 }, 240, 0, 0);
  assert.ok(Math.abs(controller.freeLookYaw) < 0.02,
    'analog stick release smoothly recentres the free-look angle');
}

{
  const mesh = makeMesh(0, 0, 0, 0);
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  controller.reset(mesh);
  const car = { speed: 0, lateralAcceleration: 8, yawRate: 0 };
  controller.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode: 0, ghostAmplitude: 0 });
  assert.equal(controller.roll, 0, 'lateral acceleration no longer rolls the camera');
  assert.ok(camera.up.y > 0.99, 'camera up stays vertical under lateral acceleration');
  runFrames(controller, mesh, { speed: 0, lateralAcceleration: -8, yawRate: 0 }, 180);
  assert.equal(controller.roll, 0, 'camera roll stays 0 for opposite lateral acceleration');
  assert.ok(camera.up.y > 0.99, 'camera up stays vertical for opposite lateral acceleration');
}

{
  const mesh = makeMesh(4, 2, 6, Math.PI / 3);
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  const car = { speed: 30 };
  controller.reset(mesh);
  for (const mode of [0, 1, 2]) {
    controller.update({ mesh, car, dt: 1 / 60, now: 0, lookX: 0, lookY: 0, mode, ghostAmplitude: 0 });
    assert.ok(Number.isFinite(camera.position.x) && Number.isFinite(camera.position.y) && Number.isFinite(camera.position.z),
      `mode ${mode} has finite camera position`);
    assert.ok(Number.isFinite(camera.quaternion.w), `mode ${mode} has finite camera orientation`);
  }
}

{
  const mesh = makeMesh();
  const controller = new ForzaChaseCamera(makeCamera());
  controller.reset(mesh);
  runFrames(controller, mesh, { speed: 0 }, 180, 0.008, 0.006);
  approx(controller.freeLookYaw, 0, 1e-8, 'gamepad centre drift stays inside the radial look deadzone');
}

{
  const mesh = makeMesh();
  const camera = makeCamera();
  const controller = new ForzaChaseCamera(camera);
  controller.reset(mesh);
  runFrames(controller, mesh, { speed: 250 / 3.6 }, 240);
  let crossings = 0;
  let previous = camera.position.x;
  for (let i = 0; i < 240; i += 1) {
    controller.update({ mesh, car: { speed: 250 / 3.6 }, dt: 1 / 120 });
    if (previous * camera.position.x < 0) crossings += 1;
    previous = camera.position.x;
  }
  assert.ok(crossings >= 10, `speed texture stays high frequency after chase damping (${crossings} crossings in 2s)`);
}

console.log('PASS ForzaChaseCamera geometry, damping, mesh/body separation, FOV, pullback, free-look, roll, and modes');
