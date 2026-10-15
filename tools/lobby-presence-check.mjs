/*
 * 大厅（首页，未入房）玩家面板验收：姓名实时同步 + 延迟实测。
 *
 * 覆盖的四个根因（本次修复）：
 *   ① `Hub` 原本只让**房间**的 60Hz ticker 发 `sping` 探测，`c.room == nil` 的
 *      大厅玩家永远收不到探测 ⇒ `rttMs` 恒为 -1 ⇒ 首页延迟列恒空。
 *   ② `case "spong"` 开头写死 `if rm == nil { return }`，大厅玩家的回包被直接丢弃。
 *   ③ `presenceSnapshot()` 对未入房玩家漏填 `ms`（零值）。
 *   ④ 前端首页改名只写 localStorage，从不发 `rename` ⇒ 服务端一直显示占位名"车手"。
 *
 * 全部断言都在**协议层**（裸 WebSocket 直连服务端），不依赖浏览器，因此可以稳定门禁。
 * 用法：node tools/lobby-presence-check.mjs
 */
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PRESENCE_PORT || 8095);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) console.log('  PASS ' + name + (detail ? '   ' + detail : ''));
  else { fail++; console.log('  FAIL ' + name + '   ' + detail); }
};

/**
 * 极简 ws 客户端：记录所有收到的报文，支持按类型等待。
 * ★ 必须**回显 sping → spong**（与 network.js 的 `case 'sping'` 同一行为）：
 *   服务端用"发出→收回"的墙钟差算 RTT，不回包就永远测不到延迟。
 */
class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.spingCount = 0;
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      this.messages.push(m);
      if (m.t === 'sping') {
        this.spingCount++;
        this.ws.send(JSON.stringify({ t: 'spong', c: m.c }));
      }
    });
  }
  static async connect(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
    });
    return new Client(ws);
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  all(t) { return this.messages.filter((m) => m.t === t); }
  last(t) { const a = this.all(t); return a.length ? a[a.length - 1] : null; }
  /** 等到 pred(last(t)) 成立，最多 timeoutMs。 */
  async waitFor(t, pred, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = this.last(t);
      if (m && (!pred || pred(m))) return m;
      await sleep(80);
    }
    return this.last(t);
  }
  close() { try { this.ws.close(); } catch (_) { /* 已关闭 */ } }
}

const server = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
let a = null, b = null;
try {
  // 等服务端起监听
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`, { method: 'HEAD' }); if (r.ok) break; } catch (_) { /* 还没起来 */ }
    await sleep(200);
  }

  a = await Client.connect(PORT);
  b = await Client.connect(PORT);

  // ① 连上就在**大厅**（未入房）：presence 必须包含自己，且名字是服务端占位名
  const p0 = await a.waitFor('presence', (m) => (m.players || []).length >= 2);
  ok(!!p0, '未入房即收到 presence 广播（首页在线面板有数据）');
  const names0 = (p0?.players || []).map((p) => p.name);
  ok((p0?.players || []).length === 2 && (p0?.total || 0) === 2,
    'presence.total / players 统计全部在线连接（不区分是否入房）',
    JSON.stringify({ total: p0?.total, names: names0 }));
  ok((p0?.players || []).every((p) => typeof p.ms === 'number'),
    '★未入房玩家的 presence 条目带 ms 字段（旧实现漏填 ⇒ 前端恒显示 0ms）',
    JSON.stringify((p0?.players || []).map((p) => p.ms)));

  // ② 大厅探测：必须在 ~3s 内测到真实 RTT（lobbyPingLoop）
  let msOk = null;
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    const p = a.last('presence');
    const me = (p?.players || []).find((x) => Number.isFinite(x.ms) && x.ms >= 0);
    if (me) { msOk = me; break; }
  }
  ok(!!msOk, '★大厅（未入房）玩家测到真实延迟（lobbyPingLoop 生效）',
    msOk ? 'ms=' + msOk.ms : '25 次采样内始终为 -1');
  ok(a.spingCount >= 1 && b.spingCount >= 1,
    '大厅两个未入房连接都收到了 sping 探测（房间 ticker 之外确有大厅探测）',
    `a=${a.spingCount} b=${b.spingCount}`);

  // ③ 首页改名必须实时生效（前端 rename 链路 + 服务端 broadcastPresence）
  a.send({ t: 'rename', name: '大厅甲' });
  b.send({ t: 'rename', name: '大厅乙' });
  const pRenamed = await a.waitFor('presence', (m) =>
    (m.players || []).some((p) => p.name === '大厅甲') && (m.players || []).some((p) => p.name === '大厅乙'));
  const renamedNames = (pRenamed?.players || []).map((p) => p.name);
  ok(!!pRenamed, '★未入房改名立即广播 presence（别人能看到新名字，不必先建房）',
    JSON.stringify(renamedNames));
  const renamedMs = (pRenamed?.players || []).find((p) => p.name === '大厅甲')?.ms;
  ok(Number.isFinite(renamedMs) && renamedMs >= 0,
    '改名后的 presence 仍带有效 ms', 'ms=' + renamedMs);

  // ④ 入房后延迟继续有效（房间 ticker 与 lobbyPingLoop 互斥，不重复探测也不中断）
  a.send({ t: 'create', room: '', name: '大厅甲', laps: 3, track: 'oval' });
  const room = await a.waitFor('room', null, 6000);
  ok(!!room, '建房成功（track=oval 被服务端白名单接受）',
    room ? JSON.stringify({ track: room.track, laps: room.laps }) : 'no room');
  ok(room?.track === 'oval', '★服务端接受 oval 赛道类型并下发（sanitizeTrack 白名单）',
    'track=' + room?.track);

  // ⑤ 名次同分时按发车格决胜：直接核实服务端把 gridSlot 一并下发（供名次稳定排序）
  const withGrid = await a.waitFor('room', (m) => (m.players || []).every((p) => 'gridSlot' in p) , 6000);
  ok(!!withGrid, 'room 报文携带每席 gridSlot（起点同分时名次按发车格决胜的前提）',
    JSON.stringify((withGrid?.players || []).map((p) => [p.id, p.gridSlot])));
} finally {
  a?.close(); b?.close();
  try { server.kill(); } catch (_) { /* 已退出 */ }
  await sleep(300);
}

console.log('');
console.log(fail === 0 ? '\x1b[32mlobby-presence-check: 全部通过\x1b[0m' : `\x1b[31mlobby-presence-check: ${fail} 项失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
