// 浏览器端 CSP + Wasm 真机验收驱动。
// 必须放在**外部文件**里：index.html 的 CSP 是 script-src 'self'（无 'unsafe-inline'），
// 内联 <script> 会被 CSP 直接拦掉 —— 这正是第一版 harness 假绿的原因。
const lines = [];
const ok = (c, w, d = '') => lines.push((c ? 'PASS ' : 'FAIL ') + w + (d ? '   ' + d : ''));

function finish() {
  const f = lines.filter((l) => l.startsWith('FAIL')).length;
  document.getElementById('out').textContent =
    'RESULT ' + (lines.length - f) + '/' + lines.length + '\n' + lines.join('\n');
}

try {
  // 1) CSP 是否放行 wasm 编译
  const factory = (await import('./network_physics.js')).default;
  const mod = await factory();
  ok(true, 'Wasm 实例化成功（CSP 放行 wasm-unsafe-eval）');

  // 2) 静态守卫仍在：eval 必须被拦
  let evalBlocked = false;
  try { (0, eval)('1+1'); } catch (e) { evalBlocked = true; }
  ok(evalBlocked, "eval() 仍被 CSP 拦截（'wasm-unsafe-eval' 不放行 eval）");

  // 3) 布局常量
  ok(mod.SNAPSHOT_STAGE_SIZE === 96, 'SNAPSHOT_STAGE_SIZE = 96', String(mod.SNAPSHOT_STAGE_SIZE));
  ok(mod.OFF_POSITION === 16 && mod.OFF_ACCEL === 80, '字段偏移与 C++ 一致');

  // 4) 零拷贝路径：HEAPU8 直写 + commit
  const addr = mod._fz_snapshot_stage_addr();
  const buf = new ArrayBuffer(96);
  const dv = new DataView(buf);
  dv.setUint32(mod.OFF_FRAME, 7, true);
  dv.setFloat32(mod.OFF_POSITION + 0, 12.5, true);
  dv.setFloat32(mod.OFF_ROTATION + 0, 1.0, true);
  dv.setFloat32(mod.OFF_VELOCITY + 0, 0.0, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  ok(mod._fz_snapshot_commit() === 1, '零拷贝 commit 被接受');
  mod._fz_update(1 / 60);
  const vis = new Float32Array(mod.HEAPF32.buffer, mod._fz_matrix_stage_addr(), 16);
  ok(Math.abs(vis[12] - 12.5) < 1e-4, '视觉矩阵平移 x = 12.5', String(vis[12]));

  // 5) NTP
  const MS = 1e6;
  for (let i = 0; i < 24; i++) {
    const t1 = i * 100 * MS, o = 5 * MS, p = 1 * MS, T = 37 * MS;
    mod._fz_on_pong(t1, t1 + o + T, t1 + o + p + T, t1 + o + p + o);
  }
  ok(mod._fz_is_locked() !== 0, 'NTP 锁定成功');
  ok(Math.abs(mod.syncTelemetry().offsetNs() - 37 * MS) < 1, 'offset = +37ms');
  ok(mod._fz_adjusted_dt(1 / 60) > 0, 'AdjustedDeltaTime 返回正步长');
} catch (e) {
  ok(false, '异常：' + (e && e.message ? e.message : String(e)));
}
finish();
