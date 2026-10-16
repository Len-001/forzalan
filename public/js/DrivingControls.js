const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function deadzone(value, zone = 0.12) {
  return Number.isFinite(value) && Math.abs(value) > zone ? Math.sign(value) * clamp((Math.abs(value)-zone)/(1-zone), 0, 1) : 0;
}
export function gamepadInput(pad) {
  const button = i => clamp(Number(pad?.buttons?.[i]?.value) || 0, 0, 1);
  return { throttle:button(7), brake:button(6), steer:deadzone(pad?.axes?.[0]), handbrake:button(0)>0.5 ? 1 : 0 };
}
export function tiltSteer(beta, gamma, angle, center = 0) {
  const radians = angle * Math.PI / 180;
  const tilt = beta * Math.sin(radians) + gamma * Math.cos(radians);
  return { tilt, steer:deadzone(clamp((tilt-center)/30, -1, 1), 0.04) };
}

export class DrivingControls {
  constructor({ changed = () => {}, notify = () => {} } = {}) {
    this.changed = changed; this.notify = notify; this.touch = new Map();
    this.gyro = false; this.center = null; this.tilt = 0; this.steer = 0; this.lastSensor = 0;
    this.mobile = matchMedia('(pointer: coarse)').matches;
    this.root = document.createElement('div'); this.root.id = 'driveControls';
    this.root.innerHTML = '<div class="drive-tools"><button id="gyroToggle">启用体感</button><button id="gyroCenter">回正校准</button><button id="driveFullscreen">全屏</button><span id="driveStatus">手柄：左摇杆转向 · RT 油门 · LT 刹车 · A 手刹</span></div><div class="touch-steer"><button data-drive="left">左</button><button data-drive="right">右</button></div><div class="touch-pedals"><button data-drive="handbrake">手刹</button><button data-drive="brake">刹车</button><button data-drive="throttle">油门</button></div><div class="rotate-hint">请将手机横过来游玩</div>';
    document.body.append(this.root);
    const reset = () => { this.touch.clear(); this.steer = 0; this.changed(); };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    for (const button of this.root.querySelectorAll('[data-drive]')) {
      button.addEventListener('pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); this.touch.set(e.pointerId, button.dataset.drive); this.changed(); });
      for (const name of ['pointerup','pointercancel','lostpointercapture']) button.addEventListener(name, e => { this.touch.delete(e.pointerId); this.changed(); });
    }
    this.root.querySelector('#gyroToggle').onclick = () => this.enableGyro();
    this.root.querySelector('#gyroCenter').onclick = () => { this.center = null; this.steer = 0; this.notify('保持手机自然握姿，下一次传感器采样会完成校准'); };
    this.root.querySelector('#driveFullscreen').onclick = () => this.fullscreen();
    window.addEventListener('deviceorientation', e => {
      if (!this.gyro || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
      const angle = screen.orientation?.angle ?? window.orientation ?? 0;
      const raw = tiltSteer(e.beta, e.gamma, angle).tilt;
      if (this.center === null) this.center = raw;
      this.steer = tiltSteer(e.beta, e.gamma, angle, this.center).steer;
      this.lastSensor = performance.now(); this.changed();
    });
    screen.orientation?.addEventListener('change', () => { this.center = null; this.steer = 0; });
    window.addEventListener('gamepadconnected', e => this.notify('手柄已连接：' + e.gamepad.id));
    window.addEventListener('gamepaddisconnected', () => { this.changed(); this.notify('手柄已断开'); });
    // Fullscreen must be requested during the player's gesture, before async loading.
    document.addEventListener('click', e => {
      if (this.mobile && e.target.closest('#btnSolo, #btnReady, #btnAgain, #settleAgain')) void this.fullscreen();
    }, true);
  }
  async fullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
      if (this.mobile && screen.orientation?.lock) await screen.orientation.lock('landscape');
    } catch { this.notify('浏览器未允许自动横屏，请手动横置手机；可继续使用触控'); }
  }
  async enableGyro() {
    if (this.gyro) { this.gyro = false; this.steer = 0; this.root.querySelector('#gyroToggle').textContent = '启用体感'; return; }
    if (!window.isSecureContext || !window.DeviceOrientationEvent) { this.notify('体感需要 HTTPS 和支持运动传感器的浏览器，当前可使用触控'); return; }
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function' && await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('denied');
      this.gyro = true; this.center = null; this.lastSensor = 0;
      this.root.querySelector('#gyroToggle').textContent = '关闭体感';
      this.notify('体感已启用：左右倾斜转向，屏幕按钮控制油门与刹车');
      setTimeout(() => { if (this.gyro && !this.lastSensor) this.notify('未收到体感数据，请检查浏览器权限；触控仍可用'); }, 3000);
    } catch { this.notify('未获得运动传感器权限，继续使用触控'); }
  }
  sample() {
    let pad;
    try { pad = Array.from(navigator.getGamepads?.() || []).find(p => p?.connected && p.mapping === 'standard'); } catch { /* policy blocked */ }
    const input = gamepadInput(pad), touch = new Set(this.touch.values());
    if (touch.has('throttle')) input.throttle = 1;
    if (touch.has('brake')) input.brake = 1;
    if (touch.has('handbrake')) input.handbrake = 1;
    const steer = (touch.has('right') ? 1 : 0) - (touch.has('left') ? 1 : 0);
    if (steer) input.steer = steer;
    else if (!input.steer && this.gyro && performance.now()-this.lastSensor < 500) input.steer = this.steer;
    if (document.hidden || !document.hasFocus()) return { throttle:0, brake:0, steer:0, handbrake:0 };
    return input;
  }
}
