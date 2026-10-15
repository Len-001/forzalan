/*
 * FM8-style chase camera.
 *
 * The application currently loads three.min.js before its module graph and exposes
 * THREE globally. Keeping the lookup lazy makes this controller usable from that
 * loader while leaving the public module import-free and easy to test.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function dampAlpha(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= TAU;
  while (angle < -Math.PI) angle += TAU;
  return angle;
}

function dampAngle(value, target, rate, dt) {
  return wrapAngle(value + wrapAngle(target - value) * dampAlpha(rate, dt));
}

function rotateVectorAroundAxis(vector, axis, angle) {
  if (Math.abs(angle) < 1e-7) return;
  const x = vector.x;
  const y = vector.y;
  const z = vector.z;
  const ax = axis.x;
  const ay = axis.y;
  const az = axis.z;
  const dot = x * ax + y * ay + z * az;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  vector.set(
    x * c + (ay * z - az * y) * s + ax * dot * k,
    y * c + (az * x - ax * z) * s + ay * dot * k,
    z * c + (ax * y - ay * x) * s + az * dot * k,
  );
}

function readVelocitySpeed(car) {
  if (!car) return 0;
  if (Number.isFinite(car.speed)) return Math.abs(car.speed);
  if (Number.isFinite(car.speedMps)) return Math.abs(car.speedMps);
  if (Number.isFinite(car.speedKmh)) return Math.abs(car.speedKmh) / 3.6;
  const body = car.body;
  const velocity = car.velocity || car.vel || (body && (body.velocity || body.vel));
  if (velocity) return Math.hypot(finite(velocity.x), finite(velocity.z));
  return 0;
}

function readAcceleration(car) {
  if (!car) return 0;
  if (Number.isFinite(car.axMeasured)) return car.axMeasured;
  if (Number.isFinite(car.acceleration)) return car.acceleration;
  if (Number.isFinite(car.longitudinalAcceleration)) return car.longitudinalAcceleration;
  if (Number.isFinite(car.accel)) return car.accel;
  return 0;
}

function readYawRate(car) {
  if (!car) return NaN;
  if (Number.isFinite(car.yawRate)) return car.yawRate;
  if (Number.isFinite(car.yawVelocity)) return car.yawVelocity;

  const body = car.body;
  const mirror = car.mirror;
  const mirrorBody = mirror && mirror.body;
  const angularVelocity = car.angularVelocity || car.angularVel ||
    (body && (body.angularVelocity || body.angularVel)) ||
    (mirror && (mirror.angularVelocity || mirror.angularVel)) ||
    (mirrorBody && (mirrorBody.angularVelocity || mirrorBody.angularVel));
  if (angularVelocity && Number.isFinite(angularVelocity.y)) return angularVelocity.y;
  return NaN;
}

function readLateralSign(car, yawRate) {
  if (Math.abs(yawRate) > 1e-5) return Math.sign(yawRate);
  // steerAngle > 0 points left; input.steer > 0 requests right. These
  // fields recover a side only, never masquerade as angular velocity.
  if (Number.isFinite(car.steerAngle) && Math.abs(car.steerAngle) > 1e-5) {
    return Math.sign(car.steerAngle);
  }
  const input = car.input;
  if (input && Number.isFinite(input.steer) && Math.abs(input.steer) > 1e-5) {
    return -Math.sign(input.steer);
  }
  if (Number.isFinite(car.steerInput) && Math.abs(car.steerInput) > 1e-5) {
    return -Math.sign(car.steerInput);
  }
  if (Number.isFinite(car.lateralSpeed) && Math.abs(car.lateralSpeed) > 1e-5) {
    // Lateral grip accelerates against the velocity along local +X.
    return -Math.sign(car.lateralSpeed);
  }
  return 0;
}

function readLateralAcceleration(car, yawRate) {
  if (!car) return 0;
  // Production physics exports ayPrev as Math.abs(...), so recover its side
  // from the signed yaw/steer telemetry. Preserve a negative value and an
  // explicitly signed producer for forward compatibility.
  if (Number.isFinite(car.ayPrev)) {
    if (car.ayPrevSigned === true || car.ayPrev < 0) return car.ayPrev;
    return Math.abs(car.ayPrev) * readLateralSign(car, yawRate);
  }
  if (Number.isFinite(car.lateralAcceleration)) return car.lateralAcceleration;
  if (Number.isFinite(car.lateralAccel)) return car.lateralAccel;
  if (Number.isFinite(car.lateralG)) return car.lateralG * 9.81;
  if (Number.isFinite(car.accelX)) return car.accelX;
  return 0;
}

/**
 * Camera controller for an interpolated vehicle mesh.
 *
 * @param {THREE.PerspectiveCamera} camera camera mutated by update()
 */
export class ForzaChaseCamera {
  constructor(camera) {
    const THREE = globalThis.THREE;
    if (!THREE) throw new Error('ForzaChaseCamera requires global THREE');
    if (!camera || !camera.position || !camera.quaternion) {
      throw new TypeError('ForzaChaseCamera requires a Three.js camera');
    }

    this.camera = camera;

    // All reusable frame state lives here. update() does not create vectors,
    // quaternions, arrays, or objects.
    this._meshPosition = new THREE.Vector3();
    this._meshQuaternion = new THREE.Quaternion();
    // 去掉车身侧倾（Roll）的朝向基：保留航向 + 俯仰，只把绕车头的自转抹掉。
    this._noRollQuaternion = new THREE.Quaternion();
    this._basisMatrix = new THREE.Matrix4();
    this._basisRight = new THREE.Vector3(1, 0, 0);
    this._basisUp = new THREE.Vector3(0, 1, 0);
    this._meshUp = new THREE.Vector3(0, 1, 0);
    this._meshVelocity = new THREE.Vector3();
    this._lastMeshPosition = new THREE.Vector3();
    this._hasLastMeshPosition = false;
    this._forward = new THREE.Vector3(0, 0, 1);
    this._worldForward = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._localPosition = new THREE.Vector3();
    this._localLook = new THREE.Vector3();
    this._worldOffset = new THREE.Vector3();
    this._desiredPosition = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._currentPosition = new THREE.Vector3();
    this._currentLook = new THREE.Vector3();
    this._viewDirection = new THREE.Vector3();
    this._desiredUp = new THREE.Vector3(0, 1, 0);
    this._desiredQuaternion = new THREE.Quaternion();
    this._orientation = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

    this._freeLookYaw = 0;
    this._freeLookYawTarget = 0;
    this._pullback = 0;
    this._pullbackTarget = 0;
    this._roll = 0;
    this._rollTarget = 0;
    this._fov = finite(camera.fov, 60);
    this._lastMeshYaw = null;
    this._noiseX = 0;
    this._noiseY = 0;
    this._noiseZ = 0;
    this._clock = 0;
    this._hasClock = false;
    this._initialized = false;

  }

  /**
   * Snap the initial chase framing to the already interpolated mesh.
   * Later calls to update() always use inertial smoothing.
   *
   * @param {THREE.Object3D} mesh interpolated vehicle mesh
   * @returns {THREE.Camera} the controlled camera
   */
  reset(mesh) {
    this._requireMesh(mesh);
    this._meshPosition.copy(mesh.position);
    this._meshQuaternion.copy(mesh.quaternion).normalize();
    this._freeLookYaw = 0;
    this._freeLookYawTarget = 0;
    this._pullback = 0;
    this._pullbackTarget = 0;
    this._roll = 0;
    this._rollTarget = 0;
    this._noiseX = 0;
    this._noiseY = 0;
    this._noiseZ = 0;
    this._clock = 0;
    this._hasClock = false;
    this._meshVelocity.set(0, 0, 0);
    this._hasLastMeshPosition = false;   // reset 是硬吸附，下一帧不该算出巨大的位移速度
    this._fov = 60;
    this._cameraTarget(mesh, 0, 0, 0, 0, 0, 0);
    this._lastMeshYaw = Math.atan2(this._worldForward.x, this._worldForward.z);
    this._currentPosition.copy(this._desiredPosition);
    this._currentLook.copy(this._desiredLook);
    this.camera.position.copy(this._currentPosition);
    this.camera.fov = this._fov;
    if (typeof this.camera.updateProjectionMatrix === 'function') {
      this.camera.updateProjectionMatrix();
    }
    this._setOrientation(1);
    this._initialized = true;
    return this.camera;
  }

  /**
   * Advance the camera from an interpolated mesh snapshot.
   *
   * lookX is positive to the right and lookY is positive downward. The stick
   * direction maps through atan2(-lookX, -lookY): down=180°, left=+90°,
   * right=-90°, down-left=+135°, down-right=-135°.
   *
   * @param {object} state
   * @param {THREE.Object3D} state.mesh interpolated visual mesh
   * @param {object} [state.car] physical telemetry; its position is ignored
   * @param {number} state.dt seconds since the previous render
   * @param {number} [state.now] monotonic timestamp, milliseconds or seconds
   * @param {number} [state.lookX] gamepad/keyboard horizontal look input
   * @param {number} [state.lookY] gamepad/keyboard vertical look input
   * @param {0|1|2} [state.mode] chase, hood, or bird view
   * @param {number} [state.ghostAmplitude] legacy field, ignored by the camera
   * @returns {THREE.Camera} the controlled camera
   */
  update({ mesh, car = null, dt = 0, now = 0, lookX = 0, lookY = 0, mode = 0, ghostAmplitude = 0 }) {
    this._requireMesh(mesh);
    let frameDt = finite(dt, 0);
    if (frameDt < 0) frameDt = 0;
    if (frameDt > 0.1) frameDt = 0.1;

    if (!this._initialized) this.reset(mesh);
    this._updateClock(now, frameDt);

    const x = finite(lookX);
    const y = finite(lookY);
    if (x * x + y * y > 0.0004) {
      this._freeLookYawTarget = Math.abs(x) < 1e-7 && y > 0 ? Math.PI : Math.atan2(-x, -y);
    } else {
      this._freeLookYawTarget = 0;
    }
    this._freeLookYaw = dampAngle(this._freeLookYaw, this._freeLookYawTarget, 8, frameDt);

    const speed = readVelocitySpeed(car);
    const speedKmh = speed * 3.6;
    const speedFactor = clamp(speedKmh / 240, 0, 1);
    const acceleration = readAcceleration(car);
    const accelFactor = clamp(Math.max(0, acceleration) / 8, 0, 1);
    this._pullbackTarget = clamp(1.15 * speedFactor + 0.35 * accelFactor, 0, 1.5);
    this._pullback += (this._pullbackTarget - this._pullback) * dampAlpha(5, frameDt);

    // 网格真实位移速度（有限差分）。_cameraTarget 里会写 _meshPosition，
    // 所以必须在调用它之前采样，否则拿到的是本帧已更新的值、差分为 0。
    if (frameDt > 0 && this._hasLastMeshPosition) {
      this._meshVelocity.copy(mesh.position).sub(this._lastMeshPosition).multiplyScalar(1 / frameDt);
    } else {
      this._meshVelocity.set(0, 0, 0);
    }
    this._lastMeshPosition.copy(mesh.position);
    this._hasLastMeshPosition = true;

    // 转弯视角偏转（roll）已按用户要求**彻底移除**：绕视线的滚转会让左右打方向时
    // 整个画面跟着倾斜。这里保留 `_roll`/`_rollTarget` 字段与 getter（恒为 0），
    // 以免外部探针/调试面板读取时报错，但不再产生任何镜头滚转，
    // 也不再为此读取 yawRate / lateralAcceleration。
    this._rollTarget = 0;
    this._roll = 0;

    // Ghosting changes collision/opacity state. It must never add camera
    // motion, especially while two ghost cars overlap.
    void ghostAmplitude;
    this._cameraTarget(mesh, speedKmh, mode, speedFactor, this._freeLookYaw, frameDt, this._roll);

    // 高速"越跑越远"的真因是一阶低通的稳态滞后：相机始终落后车尾 v/k 处
    // （k=7.5 ⇒ 192km/h 时被甩后 6.7m；实测后距 12.7m 而期望机位只有 6.0m）。
    // 给期望位置/注视点加**速度前馈**：把期望点按真实世界速度前移 v/k，
    // 稳态误差被精确抵消，而阻尼本身的频率响应完全不变 —— 不引入新的抖动源，
    // 也不改基础机位（4.8m 后 / 1.65m 高）。用真实速度向量（含漂移与坡度），
    // 而不是车头方向，保证上/下坡与甩尾时前馈方向依然正确。
    if (speed > 0.5) {
      const vx = this._meshVelocity.x, vy = this._meshVelocity.y, vz = this._meshVelocity.z;
      const vLenSq = vx * vx + vy * vy + vz * vz;
      if (vLenSq > 1e-6) {
        this._meshVelocity.multiplyScalar(1 / Math.sqrt(vLenSq));
        this._desiredPosition.addScaledVector(this._meshVelocity, speed / 7.5);
        this._desiredLook.addScaledVector(this._meshVelocity, speed / 9.5);
      } else {
        this._desiredPosition.addScaledVector(this._worldForward, speed / 7.5);
        this._desiredLook.addScaledVector(this._worldForward, speed / 9.5);
      }
    }

    if (frameDt > 0) {
      this._currentPosition.lerp(this._desiredPosition, dampAlpha(7.5, frameDt));
      this._currentLook.lerp(this._desiredLook, dampAlpha(9.5, frameDt));
    }

    this._fov += (60 + 20 * speedFactor - this._fov) * dampAlpha(5, frameDt);
    this.camera.position.copy(this._currentPosition);
    this.camera.fov = this._fov;
    if (typeof this.camera.updateProjectionMatrix === 'function') {
      this.camera.updateProjectionMatrix();
    }
    this._setOrientation(dampAlpha(12, frameDt));
    this._initialized = true;
    return this.camera;
  }

  /** Smoothed yaw in radians; forward is 0, left is positive. */
  get freeLookYaw() {
    return this._freeLookYaw;
  }

  /** Smoothed camera field of view in degrees. */
  get fov() {
    return this._fov;
  }

  /** Smoothed additional rearward distance in metres. */
  get pullback() {
    return this._pullback;
  }

  /** Smoothed camera roll in radians; negative is the production left-load response. */
  get roll() {
    return this._roll;
  }

  /** Upper-case alias retained for debug probes that mirror camera.fov. */
  get FOV() {
    return this._fov;
  }

  _requireMesh(mesh) {
    if (!mesh || !mesh.position || !mesh.quaternion) {
      throw new TypeError('ForzaChaseCamera requires a mesh with position and quaternion');
    }
  }

  _updateClock(now, dt) {
    if (!this._hasClock && Number.isFinite(now)) {
      this._clock = Math.abs(now) > 100 ? now * 0.001 : now;
      this._hasClock = true;
    } else {
      this._clock += dt;
    }
  }

  _sampleMeshYawRate(mesh, dt) {
    this._meshQuaternion.copy(mesh.quaternion).normalize();
    this._worldForward.copy(this._forward).applyQuaternion(this._meshQuaternion);
    if (this._worldForward.x * this._worldForward.x + this._worldForward.z * this._worldForward.z < 1e-6) {
      this._lastMeshYaw = null;
      return 0;
    }
    const yaw = Math.atan2(this._worldForward.x, this._worldForward.z);
    const rate = dt > 0 && this._lastMeshYaw !== null ? wrapAngle(yaw - this._lastMeshYaw) / dt : 0;
    this._lastMeshYaw = yaw;
    return clamp(rate, -4.5, 4.5);
  }

  _cameraTarget(mesh, speedKmh, mode, speedFactor, yaw, dt, roll) {
    this._meshPosition.copy(mesh.position);
    this._meshQuaternion.copy(mesh.quaternion).normalize();
    this._worldForward.copy(this._forward).applyQuaternion(this._meshQuaternion);
    // ★ 转弯视角倾斜的根因：这一行原本是
    //       this._worldUp.set(0, 1, 0).applyQuaternion(this._meshQuaternion)
    //   即"相机上方向 = 车身完整朝向"，其中**包含侧倾（Roll）**；机位偏移
    //   （_localPosition / _localLook）也直接乘了完整 `_meshQuaternion`。
    //   于是过弯车身一倾、压路肩一晃，整个画面就跟着车身歪掉。
    //
    //   正解：构造一个**只去掉 Roll** 的正交基 ——
    //       right = normalize(worldUp × forward)     （横向轴严格水平）
    //       up    = forward × right                  （在 forward 的竖直平面内）
    //   该基 = 车身朝向 ∘ R(forward, -roll)，因此航向与俯仰完全保留（上坡下坡、
    //   桥面/路肩起伏的镜头响应不变），只有绕视线的滚转被抹掉。
    //   对纯偏航（无侧倾）的车，该基与 `_meshQuaternion` **逐元素相同**，
    //   所以既有的机位/取景断言全部保持原值。
    this._basisRight.set(0, 1, 0).cross(this._worldForward);
    if (this._basisRight.lengthSq() < 1e-6) this._basisRight.set(1, 0, 0);
    else this._basisRight.normalize();
    this._basisUp.crossVectors(this._worldForward, this._basisRight).normalize();
    this._basisMatrix.makeBasis(this._basisRight, this._basisUp, this._worldForward);
    this._noRollQuaternion.setFromRotationMatrix(this._basisMatrix);
    this._meshUp.copy(this._basisUp);
    this._worldUp.copy(this._basisUp);

    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    let localX;
    let localY;
    let localZ;
    let lookX;
    let lookY;
    let lookZ;

    if (mode === 1) {
      // Hood: a short forward mount, with free-look rotating around the car.
      localX = 0;
      localY = 0.95;
      localZ = 0.75;
      lookX = 0;
      lookY = 0.85;
      lookZ = 24;
    } else if (mode === 2) {
      // Bird: retain a little rearward offset so the mesh remains readable.
      localX = 0;
      localY = 18 + 0.25 * speedFactor;
      localZ = -0.01;
      lookX = 0;
      lookY = 0;
      lookZ = 0;
    } else {
      localX = 0;
      // Keep the base mount fixed at the specified 1.65m. Speed changes the
      // rearward distance through pullback, but must not lower the camera.
      localY = 1.65;
      localZ = -4.8 - this._pullback;
      lookX = 0;
      lookY = 0.9;
      lookZ = 2.2;
    }

    // Rotate the local chase/hood look pair around local +Y for free-look.
    this._localPosition.set(localX * cosYaw + localZ * sinYaw, localY, -localX * sinYaw + localZ * cosYaw);
    this._localLook.set(lookX * cosYaw + lookZ * sinYaw, lookY, -lookX * sinYaw + lookZ * cosYaw);

    // Smooth deterministic noise avoids Math.random() discontinuities and stays
    // bounded while retaining a high-frequency filtered road texture.
    const noiseStrength = 0.028 * clamp((speedKmh - 150) / 100, 0, 1);
    const n = this._clock;
    if (noiseStrength <= 0) {
      this._noiseX = 0;
      this._noiseY = 0;
      this._noiseZ = 0;
    } else {
      const targetNoiseX = noiseStrength * (Math.sin(n * 23.0 + 0.4) * 0.65 + Math.sin(n * 37.0 + 1.9) * 0.35);
      const targetNoiseY = noiseStrength * 0.42 * (Math.sin(n * 19.0 + 2.2) * 0.65 + Math.sin(n * 31.0 + 0.6) * 0.35);
      const targetNoiseZ = noiseStrength * 0.55 * (Math.sin(n * 17.0 + 4.1) * 0.65 + Math.sin(n * 29.0 + 2.7) * 0.35);
      const noiseK = dampAlpha(15, dt);
      this._noiseX += (targetNoiseX - this._noiseX) * noiseK;
      this._noiseY += (targetNoiseY - this._noiseY) * noiseK;
      this._noiseZ += (targetNoiseZ - this._noiseZ) * noiseK;
    }
    this._localPosition.x += this._noiseX;
    this._localPosition.y += this._noiseY;
    this._localPosition.z += this._noiseZ;

    // 机位/注视点用**无 Roll 基**换算：车身侧倾不再把机位横向甩出去。
    this._worldOffset.copy(this._localPosition).applyQuaternion(this._noRollQuaternion);
    this._desiredPosition.copy(this._meshPosition).add(this._worldOffset);
    this._worldOffset.copy(this._localLook).applyQuaternion(this._noRollQuaternion);
    this._desiredLook.copy(this._meshPosition).add(this._worldOffset);

    if (mode === 2) {
      // For a bird view the car's horizontal forward is the screen-up axis.
      this._desiredUp.copy(this._worldForward);
      this._desiredUp.y = 0;
      if (this._desiredUp.lengthSq() < 1e-6) this._desiredUp.set(0, 0, 1);
      else this._desiredUp.normalize();
    } else {
      this._desiredUp.copy(this._worldUp);
    }

    this._viewDirection.copy(this._desiredLook).sub(this._desiredPosition);
    if (this._viewDirection.lengthSq() < 1e-8) this._viewDirection.copy(this._worldForward);
    else this._viewDirection.normalize();
    rotateVectorAroundAxis(this._desiredUp, this._viewDirection, roll);

  }

  _setOrientation(alpha) {
    this._orientation.position.copy(this._currentPosition);
    this._orientation.up.copy(this._desiredUp);
    this._orientation.lookAt(this._currentLook);
    this._desiredQuaternion.copy(this._orientation.quaternion);
    if (alpha >= 1) this.camera.quaternion.copy(this._desiredQuaternion);
    else this.camera.quaternion.slerp(this._desiredQuaternion, alpha);
    this.camera.up.copy(this._desiredUp);
  }
}

export default ForzaChaseCamera;
