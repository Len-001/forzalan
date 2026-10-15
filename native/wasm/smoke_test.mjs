#!/usr/bin/env node
/* =============================================================================
 *  smoke_test.mjs —— 真 Wasm 冒烟测试（node 变体）
 *
 *  这是整条链上**最后也是最强**的一层验证：前面的原生断言测的是 C++ 源码，
 *  这里测的是**编译产物** —— Wasm 实例、零拷贝内存布局、Embind 绑定是否真能用。
 *
 *  跑法：
 *      1) bash native/wasm/build_wasm.sh      （产出 dist/network_physics_node.mjs）
 *      2) node native/wasm/smoke_test.mjs
 *    或直接 bash native/run_tests.sh（它会自动带上，若产物存在）
 *
 *  ⚠️ 本文件的期望值**全部来自 C++ 真值**（常量从模块读），
 *     只对少数"协议级"数字做字面断言（96 / 32 / 16 / 150ms），
 *     因为这些是需求钉死的规格值，改了就是改需求，应该红。
 * ==========================================================================*/

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${what} ${detail}`); }
};

// 用 new URL(...).href —— 不要手工拼路径再 import：
// Windows 下 import.meta.url 的 pathname 是 /C:/... 且**不带 scheme**，
// 直接 import 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'c:'）。
// -sEXPORT_ES6=1 + -sEXPORT_NAME=createForzaNet 下工厂是 **default 导出**
// （不是具名导出），所以取 .default。
const wasmPath = new URL('dist/network_physics_node.mjs', import.meta.url);
if (!existsSync(fileURLToPath(wasmPath))) {
  console.log('找不到 dist/network_physics_node.mjs —— 先跑 bash native/wasm/build_wasm.sh');
  process.exit(2);
}
const factory = (await import(wasmPath.href)).default;
const mod = await factory();

console.log('=== 真 Wasm 冒烟测试 ===\n');

// ---------------------------------------------------------------- 1) 布局常量
console.log('[1] Embind 导出的布局常量');
check(mod.SNAPSHOT_STAGE_SIZE === 96, 'SNAPSHOT_STAGE_SIZE = 96（96B 工作结构）',
  String(mod.SNAPSHOT_STAGE_SIZE));
check(mod.OFF_FRAME === 0 && mod.OFF_TICK_MS === 4 && mod.OFF_SERVER_TIME === 8,
  '前三个字段偏移 0 / 4 / 8');
check(mod.OFF_POSITION === 16, 'OFF_POSITION = 16', String(mod.OFF_POSITION));
check(mod.OFF_ROTATION === 32, 'OFF_ROTATION = 32', String(mod.OFF_ROTATION));
check(mod.OFF_VELOCITY === 48, 'OFF_VELOCITY = 48', String(mod.OFF_VELOCITY));
check(mod.OFF_ANGULAR_VELOCITY === 64, 'OFF_ANGULAR_VELOCITY = 64');
check(mod.OFF_ACCEL === 80, 'OFF_ACCEL = 80', String(mod.OFF_ACCEL));

// --------------------------------------------- 1b) 32B 线格式（需求核心约束）
console.log('\n[1b] 32 字节线格式（规格上限 48）');
check(mod.WIRE_BYTES === 32, 'WIRE_BYTES = 32', String(mod.WIRE_BYTES));
check(mod._fz_wire_bytes() === 32, '_fz_wire_bytes() = 32');
check(mod.WIRE_PAYLOAD_BITS === 242, '净载荷 242 位（装进 8×32=256 位）',
  String(mod.WIRE_PAYLOAD_BITS));
check(mod.WIRE_BITS_POS === 16 && mod.WIRE_BITS_VEL === 14 &&
      mod.WIRE_BITS_ROT === 16 && mod.WIRE_BITS_ACC === 12 && mod.WIRE_BITS_OMEGA === 12,
  '位宽 16/14/16/12/12');
check(mod.WIRE_BIT_FRAME === 0 && mod.WIRE_BIT_TICK_MS === 16, '帧头位偏移 0 / 16');
check(mod.WIRE_BIT_POS_X === 32, 'WIRE_BIT_POS_X = 32', String(mod.WIRE_BIT_POS_X));
check(mod.WIRE_BIT_ROT_X === 128, 'WIRE_BIT_ROT_X = 128', String(mod.WIRE_BIT_ROT_X));
check(mod.WIRE_BIT_OMEGA_Z === 236, 'WIRE_BIT_OMEGA_Z = 236', String(mod.WIRE_BIT_OMEGA_Z));
// 倍率（用于确认量程：8 → ±4096m；64 → ±128m/s）
check(mod.WIRE_SCALE_POS === 8 && mod.WIRE_SCALE_VEL === 64 &&
      mod.WIRE_SCALE_ROT === 32767 && mod.WIRE_SCALE_ACC === 128 && mod.WIRE_SCALE_OMEGA === 256,
  '定点倍率 8 / 64 / 32767 / 128 / 256');

// ------------------------------------------------- 2) 零拷贝：HEAPU8 直写 + commit
console.log('\n[2] 零拷贝快照路径（模拟浏览器 HEAPU8.set + commit）');
{
  const addr = mod._fz_snapshot_stage_addr();
  check(addr > 0, '拿到暂存区地址', '0x' + addr.toString(16));
  check(mod._fz_snapshot_stage_size() === 96, '暂存区 96 字节');

  // 完全模拟 JS 侧：把网络包按字节写进 Wasm 线性内存，不调用任何 setter
  const buf = new ArrayBuffer(96);
  const dv = new DataView(buf);
  dv.setUint32(mod.OFF_FRAME, 4242, true);
  dv.setFloat32(mod.OFF_POSITION + 0, 10.0, true);
  dv.setFloat32(mod.OFF_POSITION + 4, 1.5, true);
  dv.setFloat32(mod.OFF_POSITION + 8, -20.0, true);
  dv.setFloat32(mod.OFF_ROTATION + 0, 1.0, true);  // w=1 单位四元数
  dv.setFloat32(mod.OFF_VELOCITY + 0, 55.0, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);

  check(mod._fz_snapshot_commit() === 1, 'commit 接受首个快照（1）');
  check(Math.abs(mod.replTelemetry().lastFrame() - 4242) < 0.5,
    'Embind 读到 frame = 4242', String(mod.replTelemetry().lastFrame()));

  // 帧号回退 -> 丢弃
  dv.setUint32(mod.OFF_FRAME, 4241, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  check(mod._fz_snapshot_commit() === 0, '帧号回退被丢弃（0）');
  check(mod._fz_stale_dropped() === 1, '丢弃计数 = 1', String(mod._fz_stale_dropped()));

  // 新帧 -> 外推应把位置往前推，但被 150ms 上限截断，之后转阻尼滑行
  dv.setUint32(mod.OFF_FRAME, 4243, true);
  mod.HEAPU8.set(new Uint8Array(buf), addr);
  mod._fz_snapshot_commit();
  const CAP = 0.150;   // ★ 规格值：外推上限 150ms（旧版是 250ms）
  for (let i = 0; i < 60; i++) mod._fz_update(1 / 60);
  const maddr = mod._fz_matrix_stage_addr();
  const vis = new Float32Array(mod.HEAPF32.buffer, maddr, 16);
  // 跑满 1 秒：前 150ms 沿 55m/s 直线外推 -> 10 + 55*0.15 = 18.25；
  // 超时后**不再沿旧速度飞出去**，而是"阻尼滑行"（速度按 coastHalfLifeSec 衰减）。
  // 所以 x 落在 [18.25, 10 + 55*0.15 + 55*0.6] 之间的某个值 ——
  // 关键断言是"**远小于** 10 + 55*1.0 = 65"，即外推确实被截断了。
  check(vis[12] > 18.2, '外推起步正确（≥ 10 + 55*0.15）', `x=${vis[12].toFixed(4)}`);
  check(vis[12] < 10 + 55 * 1.0, '外推未被允许跑满 1 秒（未被截断就会到 65）',
    `x=${vis[12].toFixed(4)}`);
  check(Math.abs(vis[14] + 20.0) < 1e-4, 'z 分量保持 -20（无横向漂移）',
    `z=${vis[14].toFixed(4)}`);
  check(Math.abs(mod._fz_extrapolated_s() - CAP) < 1e-3,
    `外推时长钉死在上限 ${CAP}s（旧版的 0.25 是过期值）`,
    mod._fz_extrapolated_s().toFixed(4) + 's');
}

// ------------------------------------------ 2b) 多车通道（UpdateRemoteVehicleState）
console.log('\n[2b] 多车通道：32B 线格式直接解包');
{
  mod._fz_reset_all();
  const wire = mod._fz_remote_stage_base();
  check(wire > 0, '远端暂存区基址可用', '0x' + wire.toString(16));

  // 手工按位组装一个 32B 包（模拟 TS 侧 WireSnapshotWriter 的输出）
  // 位置 100.5 / -3.25 / 2047.875，姿态 w=1，速度 72.5 / 0 / 0
  const w = new Uint32Array(8);
  const put = (off, bits, val) => {
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
    const v = val & mask;
    const wi = off >>> 5, bs = off & 31;
    w[wi] = (w[wi] | (v << bs)) >>> 0;
    if (bs + bits > 32) w[wi + 1] = (w[wi + 1] | (v >>> (bits - (bs + bits - 32)))) >>> 0;
  };
  put(mod.WIRE_BIT_FRAME, 16, 77);
  put(mod.WIRE_BIT_TICK_MS, 16, 1234);
  put(mod.WIRE_BIT_POS_X, mod.WIRE_BITS_POS, Math.floor(100.5 * mod.WIRE_SCALE_POS + 0.5));
  put(mod.WIRE_BIT_POS_Y, mod.WIRE_BITS_POS, Math.floor(-3.25 * mod.WIRE_SCALE_POS + 0.5));
  put(mod.WIRE_BIT_POS_Z, mod.WIRE_BITS_POS, Math.floor(2047.875 * mod.WIRE_SCALE_POS + 0.5));
  put(mod.WIRE_BIT_VEL_X, mod.WIRE_BITS_VEL, Math.floor(72.5 * mod.WIRE_SCALE_VEL + 0.5));
  // 姿态：w=1 -> x=y=z=0

  const bytes = new Uint8Array(32);
  const bdv = new DataView(bytes.buffer);
  for (let i = 0; i < 8; i++) bdv.setUint32(i * 4, w[i], true);

  // 写进 Wasm 内存 → 调需求指定的接口
  const remoteId = 0xA1B2C3;
  let slot = mod._fz_ensure_vehicle(remoteId, 0);
  check(slot >= 0, '登记远端车成功', 'slot=' + slot);
  mod.HEAPU8.set(bytes, wire + slot * 32);
  const accepted = mod._fz_update_remote_state(remoteId, wire, slot * 32);
  check(accepted === 1, 'UpdateRemoteVehicleState 接受（1）', String(accepted));

  // 位置回读（定点 1/8m，误差 ≤ 6.25cm）
  const px = mod._fz_remote_position(remoteId, 0);
  const pz = mod._fz_remote_position(remoteId, 2);
  check(Math.abs(px - 100.5) <= 0.07, 'posX 解包 = 100.5 ± 1/16m', px.toFixed(4));
  check(Math.abs(pz - 2047.875) <= 0.07, 'posZ 解包 = 2047.875 ± 1/16m', pz.toFixed(4));

  // 重复帧 -> 拒绝
  const again = mod._fz_update_remote_state(remoteId, wire, slot * 32);
  check(again === 0, '重复帧号被拒绝（0）', String(again));

  // 矩阵零拷贝读 —— 断言**双层解耦的结构性质**。
  // 三层关系（写清楚，这是本测试最容易想歪的地方）：
  //   ① 物理层 physPos_ 收到包后 = 包内值（第 2 步直接采信，不掺平滑）；
  //      但 A-1 航位推测会按 physVel_ 继续推进它 —— **下一帧起它就会变**。
  //   ② 视觉层 = physPos_ + visOffPos_。⚠️ **首个快照走"直接对齐"分支**
  //      （replicator `state_ == Empty` 特例）：没有历史连续性可言，
  //      visOffPos_ 被显式清零 —— 所以接收瞬间**视觉 == 物理**，这是对的。
  //      只有「已有前置状态时收到纠偏」才会把差值塞进 visOffPos_
  //      （零跳变语义在那种场景才成立，见第 2 步）。
  //   ③ visOffPos_ 按 80ms 半衰期衰减；2s ≈ 25 个半衰期 ⇒ 必收敛到 ~0。
  const mbase = mod._fz_remote_matrix_base();
  const readMat = () => new Float32Array(mod.HEAPF32.buffer, mbase + slot * 64, 16);

  mod._fz_refresh_remote_matrices();
  const rmat0 = readMat();
  check(Math.abs(rmat0[12] - px) < 1e-3 && Math.abs(rmat0[14] - 2047.875) < 1e-3,
    '首个快照直接对齐：接收瞬间视觉矩阵 == 包内位置（无历史故不产生偏移）',
    `mx=${rmat0[12].toFixed(3)} mz=${rmat0[14].toFixed(3)}`);
  check(Math.abs(mod._fz_remote_visual_error(remoteId)) < 1e-4,
    '首个快照的视觉偏移为 0（Empty -> Corrected 的直接对齐分支）',
    mod._fz_remote_visual_error(remoteId).toFixed(6));
  check(Math.abs(mod._fz_remote_position(remoteId, 0) - px) < 1e-3,
    '接收帧物理位置精确等于包内值（物理层不掺平滑）',
    mod._fz_remote_position(remoteId, 0).toFixed(4));

  // ---- 第二个快照：此时已有历史状态，纠偏必须走"视觉零跳变"分支 ----
  // 把位置挪 +40m（超过 snapDistanceM=5.0 会硬吸附，故取 4m 以内），
  // 断言接收瞬间**视觉位置原地不动**，而物理层已跳到新值。
  {
    const w2 = new Uint32Array(8);
    const putB = (off, bits, val) => {
      const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
      const v = val & mask, wi = off >>> 5, bs = off & 31;
      w2[wi] = (w2[wi] | (v << bs)) >>> 0;
      if (bs + bits > 32) w2[wi + 1] = (w2[wi + 1] | (v >>> (bits - (bs + bits - 32)))) >>> 0;
    };
    putB(mod.WIRE_BIT_FRAME, 16, 78);
    putB(mod.WIRE_BIT_POS_X, mod.WIRE_BITS_POS, Math.floor((px + 3.0) * mod.WIRE_SCALE_POS + 0.5));
    putB(mod.WIRE_BIT_POS_Y, mod.WIRE_BITS_POS, Math.floor(-3.25 * mod.WIRE_SCALE_POS + 0.5));
    putB(mod.WIRE_BIT_POS_Z, mod.WIRE_BITS_POS, Math.floor(2047.875 * mod.WIRE_SCALE_POS + 0.5));
    putB(mod.WIRE_BIT_VEL_X, mod.WIRE_BITS_VEL, Math.floor(72.5 * mod.WIRE_SCALE_VEL + 0.5));
    const b2 = new Uint8Array(32);
    const dv2 = new DataView(b2.buffer);
    for (let i = 0; i < 8; i++) dv2.setUint32(i * 4, w2[i], true);

    mod._fz_refresh_remote_matrices();
    const visBefore = readMat()[12];
    mod.HEAPU8.set(b2, wire + slot * 32);
    const acc2 = mod._fz_update_remote_state(remoteId, wire, slot * 32);
    check(acc2 === 1, '第二个快照被接受', String(acc2));
    mod._fz_refresh_remote_matrices();
    const visAfter = readMat()[12];
    const physAfter = mod._fz_remote_position(remoteId, 0);
    check(Math.abs(visAfter - visBefore) < 1e-4,
      '纠偏时视觉位置**原地不动**（零跳变：差值被塞进视觉偏移层）',
      `before=${visBefore.toFixed(4)} after=${visAfter.toFixed(4)}`);
    check(Math.abs(physAfter - (px + 3.0)) < 1e-3,
      '同一时刻物理层已直接跳到权威新值（碰撞判定立刻生效）',
      `phys=${physAfter.toFixed(3)} 期望 ${(px + 3.0).toFixed(3)}`);
  }

  // 推进 2s（> 20 个半衰期）：视觉偏移衰减殆尽，视觉矩阵贴合物理层
  for (let i = 0; i < 120; i++) mod._fz_update_remotes(1 / 60);
  const rmat2 = readMat();
  const physX = mod._fz_remote_position(remoteId, 0);
  check(Math.abs(rmat2[12] - physX) < 0.05,
    '2s 后视觉矩阵收敛贴合物理层（视觉偏移已衰减归零）',
    `mx=${rmat2[12].toFixed(3)} physX=${physX.toFixed(3)}`);
  check(Math.abs(rmat2[14] - 2047.875) < 1.0,
    '视觉矩阵 z 收敛在包内 z 附近（沿 +x 直线外推，无横向漂移）',
    `mz=${rmat2[14].toFixed(3)}`);
  check(physX > px,
    '物理层沿包内速度 72.5m/s 继续外推（航位推测在跑）',
    `physX=${physX.toFixed(1)} > 包内 ${px}`);

  // 多车独立性
  const id2 = 0xD4E5F6;
  const slot2 = mod._fz_ensure_vehicle(id2, 0);
  check(slot2 >= 0 && slot2 !== slot, '第二辆车拿到不同槽位', `${slot} / ${slot2}`);
  check(mod._fz_vehicle_count() === 2, '车辆计数 = 2', String(mod._fz_vehicle_count()));

  // 摘除
  mod._fz_remove_vehicle(remoteId);
  check(mod._fz_vehicle_count() === 1, '摘除后计数 = 1', String(mod._fz_vehicle_count()));
  check(mod._fz_vehicle_find(remoteId) === -1, '已摘除的车查找失败');
}

// ----------------------------------------------- 2c) 赛道 + HUD 秒差文本
console.log('\n[2c] 赛道装配 + 计时塔文本（RaceDeltaTracker 导出）');
{
  mod._fz_reset_all();
  // 方形赛道控制点（世界 x/z 交织）——与 C++ 测试同一份
  const ctl = new Float64Array([-50, -50, 50, -50, 50, 50, -50, 50]);
  const cp = new Float64Array([0, 100, 200, 300]);
  const pCtl = mod._malloc(ctl.byteLength);
  const pCp = mod._malloc(cp.byteLength);
  mod.HEAPU8.set(new Uint8Array(ctl.buffer), pCtl);
  mod.HEAPU8.set(new Uint8Array(cp.buffer), pCp);
  check(mod._fz_set_track(pCtl, 4, pCp, 4) === 1, '装入方形赛道');
  mod._free(pCtl);
  mod._free(pCp);

  check(mod._fz_track_ready() === 1, '赛道就绪');
  check(mod._fz_checkpoint_count() === 4, 'Checkpoint 数 = 4', String(mod._fz_checkpoint_count()));
  const L = mod._fz_track_length();
  // 闭合 Catmull-Rom 弧长（不是多边形周长 400）：实测约 420.38
  check(L > 400 && L < 440, '闭合样条弧长在 (400, 440)', L.toFixed(3));

  // 三辆车：本地在 s=100（落后），P1 在 s=200
  const LOCAL = 1, LEAD = 2, LAST = 3;
  mod._fz_ensure_vehicle(LOCAL, 1);
  mod._fz_set_local_vehicle(mod._fz_vehicle_find(LOCAL));
  mod._fz_ensure_vehicle(LEAD, 0);
  mod._fz_ensure_vehicle(LAST, 0);
  const T0 = 20.0;
  mod._fz_update_progress(LEAD, 200.0, T0, 0, 1, 8.0);
  mod._fz_update_progress(LOCAL, 100.0, T0, 0, 0, 6.0);
  mod._fz_update_progress(LAST, 50.0, T0, 0, -1, 0.0);

  const rows = mod._fz_build_leaderboard();
  check(rows === 3, '计时塔 3 行', String(rows));

  // 读第 0 行文本（零拷贝：文本暂存区 + HEAPU8）
  const readRow = (i) => {
    const a = mod._fz_row_text_addr(i);
    const v = mod.HEAPU8.subarray(a, a + mod.ROW_TEXT_CAP);
    let s = '';
    for (let k = 0; k < v.length && v[k] !== 0; k++) s += String.fromCharCode(v[k]);
    return s;
  };
  check(readRow(0) === '--', 'P1 行文本为 "--"', JSON.stringify(readRow(0)));
  check(readRow(1).startsWith('-'), 'P2 行以负号开头', JSON.stringify(readRow(1)));
  check(readRow(2).startsWith('-'), 'P3 行以负号开头', JSON.stringify(readRow(2)));

  // 本地落后 -> 本地行也是负号
  const n = mod._fz_format_local_vs_leader();
  check(n > 0, '本地行文本写入成功', String(n));
  const la = mod._fz_local_row_addr();
  const lv = mod.HEAPU8.subarray(la, la + mod.ROW_TEXT_CAP);
  let localText = '';
  for (let k = 0; k < lv.length && lv[k] !== 0; k++) localText += String.fromCharCode(lv[k]);
  check(localText.startsWith('-'), '本地落后时文本以负号开头', JSON.stringify(localText));
  check(localText !== '--', '本地落后时不显示 "--"');

  // 带符号时差 + 反对称
  const msAB = mod._fz_solve_delta_ms(LOCAL, LEAD);
  const msBA = mod._fz_solve_delta_ms(LEAD, LOCAL);
  check(msAB < 0, 'Solve(本地, P1) < 0（本地落后）', msAB.toFixed(2));
  check(Math.abs(msAB + msBA) < 1e-6, 'Solve(a,b) == -Solve(b,a)', `${msAB.toFixed(3)} / ${msBA.toFixed(3)}`);

  // Embind 低频路径（会分配 JS 对象，但正确性必须保证）
  const table = mod.leaderboard();
  check(table.size() === 3, 'Embind leaderboard().size() = 3', String(table.size()));
  check(table.get(0).isLeader === true, 'Embind 第 0 行 isLeader = true');
  check(table.get(0).text === '--', 'Embind 第 0 行文本 "--"');
  table.delete();   // ⚠️ 必须 delete，否则 Wasm 堆泄漏
}

// ------------------------------------------------------- 3) NTP 时钟同步
console.log('\n[3] NTP 采样 + Clock Slewing');
{
  mod._fz_reset_all();
  const MS = 1e6;
  let t = 0;
  // 单程 5ms、服务端处理 1ms、真实偏移 +37ms
  const out = 5 * MS, proc = 1 * MS, TRUE = 37 * MS;
  // ⚠️ 锁定判据是 `count_ >= cfg.windowSize`（默认 30），**不是固定 24 个样本**。
  //    C++ 单测里那条"锁定"前置条件用的是 `i > cfg.windowSize`；本测试原先写死 24
  //    是按"0.2×窗口参与聚合"误推出来的 —— 参与聚合的样本数（6 个）与
  //    "窗口装满才允许首次对齐"（30 个）是两件事。按窗口大小驱动循环。
  const WINDOW = 30;
  const feed = (n, step) => {
    for (let i = 0; i < n; i++) {
      const t1 = t;
      const t2 = t1 + out + TRUE;
      const t3 = t2 + proc;
      const t4 = t1 + out + proc + out;
      mod._fz_on_pong(t1, t2, t3, t4);
      t += step;
    }
  };
  feed(WINDOW - 1, 100 * MS);
  check(mod._fz_is_locked() === 0,
    `装 ${WINDOW - 1} 个样本时仍未锁定（窗口未满，不硬对齐）`,
    String(mod._fz_is_locked()));
  feed(1, 100 * MS);
  check(mod._fz_is_locked() !== 0,
    `装 ${WINDOW} 个样本后完成锁定（C ABI 返回 0/1 数字）`,
    String(mod._fz_is_locked()));
  check(Math.abs(mod._fz_best_rtt_ns() - 10 * MS) < 1e-6,
    '最小 RTT = 10ms', (mod._fz_best_rtt_ns() / MS).toFixed(3) + 'ms');
  // 量纲要一致：offsetNs() 是**纳秒**，TRUE 也是纳秒，直接比。
  // （第一版左边除了 1e6 换成毫秒、右边还是纳秒，差 6 个数量级 —— 我的错。）
  check(Math.abs(mod.syncTelemetry().offsetNs() - TRUE) < 1,
    'offset = 真实偏移 +37ms（对称路径）',
    (mod.syncTelemetry().offsetNs() / MS).toFixed(3) + 'ms');

  // 制造 80ms 阶跃 -> 必须走连续微调（warp 有界、dt 有界），不许硬跳
  const STEP = 80 * MS;
  let maxWarp = 0, dtOk = true, snapped = false;
  for (let i = 0; i < 200; i++) {
    const t1 = 1e12 + i * 1e7;
    const ev = mod._fz_on_pong(t1, t1 + out + STEP, t1 + out + proc + STEP, t1 + out + proc + out);
    if (ev === mod.SYNC_EVENT_HARD_RESYNC) snapped = true;
    const dt = mod._fz_adjusted_dt(1 / 60);
    if (!(dt > 0) || dt > (1 / 60) * 1.02) dtOk = false;
    maxWarp = Math.max(maxWarp, Math.abs(mod._fz_current_warp()));
  }
  check(!snapped, '80ms 阶跃**没有**触发硬同步（只走连续微调）');
  check(maxWarp <= 0.015 + 1e-9, '伸缩比例始终 <= ±1.5%', maxWarp.toFixed(6));
  check(dtOk, '输出步长恒为正且不超过基准的 1.02 倍');
}

// -------------------------------------------- 3b) 矩阵槽（前端 subarray 用）
console.log('\n[3b] 矩阵槽地址');
{
  const base = mod._fz_matrix_stage_addr();
  const s0 = mod._fz_matrix_slot_addr(0);
  const s1 = mod._fz_matrix_slot_addr(1);
  check(base === mod._fz_matrix_slot_addr(mod.MATRIX_SLOT_VISUAL),
    'slot 0 = 视觉矩阵（与 MATRIX_SLOT_VISUAL 一致）');
  check(s1 - s0 === 64, '相邻槽相差 64 字节（16 float）', String(s1 - s0));
  check(mod._fz_matrix_slot_addr(99) === 0, '越界槽返回 0');
  check(mod.MATRIX_SLOTS === 4, '矩阵槽数 = 4', String(mod.MATRIX_SLOTS));
}

// ---------------------------------------------------- 4) 模拟断线重连
console.log('\n[4] 断线重连');
{
  mod._fz_reset_all();
  check(mod._fz_is_locked() === 0, 'reset 后回到未锁定', String(mod._fz_is_locked()));
  check(mod.replTelemetry().hasState() === false, 'reset 后刚体状态已清空');
  check(mod._fz_vehicle_count() === 0, 'reset 后多车注册表已清空', String(mod._fz_vehicle_count()));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
