/* =============================================================================
 * 起步/秒差 + 联机单人房间 验收探针（真机 CDP）
 *
 * 回答两件事：
 *   A. 左上角计时塔的秒差列，在起步阶段是否还会"跳几百秒"？
 *      → 每 200ms 读一次真实 DOM 的 gap 文本，同时算**真实弧长差**与
 *        "米差 ÷ 参考车速"的应有值，再顺手算一遍**旧公式**会显示出什么
 *        （旧公式是"Checkpoint 序号×1000 当米用"，用来做反证）。
 *   B. 建一个**只有自己**的房间（点 #btnCreate → #btnReady 真按钮），
 *        房间内帧率到底如何？—— 这是用户说的"创建房间只有自己的时候卡"。
 *
 * 用法： node tools/hud-gap-probe.mjs
 *        DIAG_EXE=forzalan.exe node tools/hud-gap-probe.mjs      # 出厂版对照
 *        GAP_SECS=25 node tools/hud-gap-probe.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.DIAG_PORT || 8099);
const CDP_PORT = Number(process.env.DIAG_CDP_PORT || 9339);
const GAP_SECS = Number(process.env.GAP_SECS || 20);
const ROOM_SECS = Number(process.env.ROOM_SECS || 12);
const EXE = process.env.DIAG_EXE || (process.platform === 'win32' ? 'forzalan.exe' : './forzalan');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c;
  return null;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new CDP(ws);
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id); c.waits.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method) { if (c.events.length < 2000) c.events.push(m); }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP WS 连接失败')));
    });
    return c;
  }
  send(method, params = {}, timeout = 120000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(method + ' 超时')); } }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result.value;
  }
  async key(type, code, key, vk) {
    await this.send('Input.dispatchKeyEvent', {
      type, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      text: type === 'keyDown' ? key : undefined,
    });
  }
}

const srvLog = [];
const srv = spawn(EXE, ['-addr', ':' + PORT], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
for (const st of [srv.stdout, srv.stderr]) {
  st.setEncoding('utf8');
  st.on('data', (d) => { for (const ln of String(d).split('\n')) if (ln.trim()) srvLog.push(ln.trim()); });
}
await sleep(1500);
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome'); srv.kill(); process.exit(1); }
const child = spawn(browser, [
  '--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gap-cdp-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,900',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? '   ' + detail : ''));
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + '   ' + detail); }
};

try {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { cdp = await CDP.connect(page.webSocketDebuggerUrl); break; }
    } catch (_) { /* not up */ }
    await sleep(200);
  }
  if (!cdp) throw new Error('CDP 未就绪');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__frames=[];const _r=window.requestAnimationFrame.bind(window);let _p=0;
      window.requestAnimationFrame=(cb)=>_r((ts)=>{const t0=performance.now();try{cb(ts);}finally{
      const f=window.__frames;if(f.length<200000)f.push([+(ts-_p).toFixed(2),+(performance.now()-t0).toFixed(2)]);_p=ts;}});`,
  });

  /* ---------------- A. 单机练习：起步阶段秒差 ---------------- */
  console.log('\n\x1b[1mA. 单机练习起步阶段：左上角秒差列\x1b[0m');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1` });
  await sleep(2500);
  for (let i = 0; i < 120; i++) {
    try { if (await cdp.eval('!!(window.__S && window.__S.rp && window.__S.rp.racing)')) break; } catch (_) { /* wait */ }
    await sleep(500);
  }
  // 按 W 起步（真实按键路径），松开后让 AI 拉开距离
  await cdp.key('keyDown', 'KeyW', 'w', 87);
  await sleep(4000);
  await cdp.key('keyUp', 'KeyW', 'w', 87);

  const rows = [];
  for (let i = 0; i < Math.round(GAP_SECS * 5); i++) {
    await sleep(200);
    const s = await cdp.eval(`(() => {
      const S = window.__S;
      if (!S || !S.rp) return null;
      const t = S.rp.track;
      // 真实 DOM：计时塔每一行的 gap 文本
      const dom = [...document.querySelectorAll('#standList .st-row')].map((r) => ({
        nm: (r.querySelector('.nm') || {}).textContent || '',
        gap: (r.querySelector('.gap') || {}).textContent || '',
      }));
      // 真实弧长坐标（米）：等弧长采样 => arc = trackIdx * spacing
      const arc = S.rp.cars.map((c) => ({ id: c.id, nm: c.name, lap: c.lap, idx: c.trackIdx,
        arc: c.lap * t.length + Math.max(0, c.trackIdx) * t.spacing, kmh: c.speedKmh, cp: c.cpIdx }));
      const me = arc.find((x) => x.id === S.localId);
      const spread = Math.max(...arc.map((x) => x.arc)) - me.arc;
      const ref = Math.max(Math.abs(S.rp.cars[0].forwardSpeed || 0), 12);
      // 旧公式（反证）：把 Checkpoint 序号 ×1000 当米用
      const oldScore = (c) => c.lap * 100000 + Math.max(0, c.cpIdx) * 1000;
      const oldSpread = Math.max(...S.rp.cars.map((c) => oldScore(c) - oldScore(S.localCar))) / ref;
      return { clk: +S.raceClock.toFixed(2), dom, arc, spreadM: +spread.toFixed(1),
        ref: +ref.toFixed(1), dueS: +(spread / ref).toFixed(2), oldS: +oldSpread.toFixed(1),
        maxCpSpread: Math.max(...S.rp.cars.map((c) => c.cpIdx)) - Math.min(...S.rp.cars.map((c) => c.cpIdx)) };
    })()`);
    if (s) rows.push(s);
  }
  const maxGapText = rows.flatMap((r) => r.dom.map((d) => d.gap))
    .map((g) => Math.abs(parseFloat(g) || 0));
  const maxDue = Math.max(...rows.map((r) => Math.abs(r.dueS)));
  const maxOld = Math.max(...rows.map((r) => Math.abs(r.oldS)));
  const maxDom = Math.max(...maxGapText, 0);
  const maxSpread = Math.max(...rows.map((r) => r.spreadM));

  // ---- ★★ 逐车"同一行相邻采样之间的跳变"——这才是"乱跳几百秒"的直接判据 ----
  // 按车手名归并（名次会换位，行号不可靠），跳过 '--'/'LEADER' 这类非数值样本。
  const series = new Map();
  for (const r of rows) {
    for (const d of r.dom) {
      const v = parseFloat(d.gap);
      if (!isFinite(v)) continue;
      const key = d.nm.trim();
      if (!series.has(key)) series.set(key, []);
      series.get(key).push(v);
    }
  }
  let maxJump = 0, jumpWho = '';
  for (const [name, arr] of series) {
    for (let i = 1; i < arr.length; i++) {
      const j = Math.abs(arr[i] - arr[i - 1]);
      if (j > maxJump) { maxJump = j; jumpWho = name; }
    }
  }
  console.log('  样本 ' + rows.length + ' 条；车辆间最大真实弧长差 ' + maxSpread.toFixed(1) + 'm'
    + '；最大 CP 序号差 ' + Math.max(...rows.map((r) => r.maxCpSpread)));
  console.log('  DOM 秒差列最大值 = ' + maxDom.toFixed(1) + 's'
    + '   应有值（米差/参考车速）最大值 = ' + maxDue.toFixed(1) + 's'
    + '   旧公式本会显示 = ' + maxOld.toFixed(1) + 's');
  console.log('  同一行相邻采样最大跳变 = ' + maxJump.toFixed(1) + 's（' + jumpWho + '）'
    + '  [采样间隔 200ms ⇒ 真实增长应 ≈0.2s 量级]');
  ok(maxJump < 5, '★★秒差列不"乱跳"：同一行相邻采样跳变 < 5s（跑一圈的回绕会让它跳几百秒）',
    maxJump.toFixed(1) + 's @' + jumpWho);
  ok(maxDom < Math.max(5 * maxDue, 20),
    '★★起步阶段秒差列不出现"跳几百秒"（DOM 峰值与"米差/参考车速"同量级）',
    'DOM ' + maxDom.toFixed(1) + 's vs 应有 ' + maxDue.toFixed(1) + 's');
  // 反证：旧公式在同一段数据上必须**明显**错。判据用"比正确值大 3 倍以上"这种
  // 相对口径，而不是写死 60s —— 旧公式的绝对峰值取决于采样窗口内两车跨了几个 CP
  // 序号（换了真实铃鹿走线后实测是 54.9s，仍是应有值 13s 的 4 倍多，足以暴露 bug）。
  ok(maxOld > 3 * Math.max(maxDue, 1),
    '★★反证：旧公式（Checkpoint 序号×1000 当米）在同一段数据上会给出数倍于正确值的秒差',
    '旧公式峰值 ' + maxOld.toFixed(1) + 's vs 应有 ' + maxDue.toFixed(1) + 's');
  ok(rows.every((r) => r.dom.length === 4), '计时塔始终渲染 4 行（4 台车）');
  // 起步公平性：绿灯后 0.5~1.5s 时本地车与 AI 的速度差
  const early = rows.find((r) => r.clk > 1.0 && r.clk < 1.6);
  if (early) {
    const mine = early.arc.find((x) => x.id === 1);
    const ai = early.arc.filter((x) => x.id !== 1).map((x) => x.kmh);
    console.log('  raceClock≈' + early.clk + 's：本地 ' + mine.kmh.toFixed(1) + ' km/h，AI '
      + ai.map((v) => v.toFixed(1)).join('/') + ' km/h；落后弧长 '
      + (Math.max(...early.arc.map((x) => x.arc)) - mine.arc).toFixed(1) + 'm');
  }

  /* ---------------- B. 只有自己的联机房间 ---------------- */
  console.log('\n\x1b[1mB. 联机 · 只有自己的房间（#btnCreate → #btnReady）\x1b[0m');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);
  let connected = false;
  for (let i = 0; i < 40; i++) {
    try { if (await cdp.eval('!!(window.__S && window.__S.net && window.__S.net.connected)')) { connected = true; break; } } catch (_) { /* wait */ }
    await sleep(400);
  }
  ok(connected, '客户端已连上服务端 WebSocket');
  await cdp.eval('(() => { const b = document.getElementById("btnCreate"); if (b) b.click(); return true; })()');
  await sleep(1200);
  const room = await cdp.eval('(window.__S.lobbyRoom && window.__S.lobbyRoom.room) || ""');
  ok(!!room, '已创建房间', '房间号 ' + room);
  await cdp.eval('(() => { const b = document.getElementById("btnReady"); if (b) b.click(); return true; })()');
  // 等发车：逐样本记录状态机，任何一环卡住都能看出来
  const tl = [];
  let started = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    let s = null;
    try {
      s = await cdp.eval(`(() => {
        const S = window.__S;
        if (!S) return null;
        const rp = S.rp;
        return {
          ms: performance.now() | 0,
          mode: S.mode, off: S.offline ? 1 : 0,
          clk: rp ? +S.raceClock.toFixed(3) : null,
          racing: rp && rp.racing ? 1 : 0,
          lock: S.controlsLocked ? 1 : 0,
          rLock: S.localCar ? (S.localCar.raceLocked ? 1 : 0) : -1,
          cars: rp ? rp.cars.length : -1,
          ready: S.ready ? 1 : 0,
          seq: S.startSeqSeen ? 1 : 0, rs: S.raceStartSeen ? 1 : 0,
          at: S.raceStartAt, srv: Date.now(),
          off: undefined,
          offN: S.net ? +(S.net.clockOffset || 0).toFixed(1) : null,
          sim: S.simOffset === undefined ? null : +S.simOffset.toFixed(1),
          warn: S._clockAxisWarned ? 1 : 0,
          offl: S.offline ? 1 : 0,
          kmh: S.localCar ? +S.localCar.speedKmh.toFixed(1) : null,
        };
      })()`);
    } catch (_) { /* transient */ }
    if (s) tl.push(s);
    if (s && s.racing === 1) { started = true; break; }
  }
  console.log('  状态机样本（每隔 250ms，最多 30s）：');
  for (const s of tl.slice(0, 26)) {
    console.log('    mode=' + s.mode + ' clk=' + s.clk + ' racing=' + s.racing + ' lock=' + s.lock
      + ' rLock=' + s.rLock + ' cars=' + s.cars + ' ready=' + s.ready + ' seq=' + s.seq + ' rs=' + s.rs
      + ' at=' + s.at + ' now=' + s.srv + ' offN=' + s.offN + ' sim=' + s.sim
      + ' 轴告警=' + s.warn + ' kmh=' + s.kmh);
  }
  ok(started, '全员准备后自动发车（单人房间）',
    started ? 'raceClock=' + tl[tl.length - 1].clk : '30s 内未放行');
  if (!started) {
    console.log('  服务端日志尾部：');
    for (const l of srvLog.slice(-14)) console.log('    | ' + l.slice(0, 160));
  }
  await cdp.key('keyDown', 'KeyW', 'w', 87);
  await cdp.eval('window.__frames.length = 0; true');
  await sleep(ROOM_SECS * 1000);
  const fr = await cdp.eval('window.__frames.slice(0,200000)');
  const iv = fr.map((x) => x[0]).filter((x) => x > 0.5 && x < 5000).sort((a, b) => a - b);
  const js = fr.map((x) => x[1]).sort((a, b) => a - b);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  const fps = iv.length ? +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1) : null;
  const st = await cdp.eval('(() => { const S = window.__S; return { cars: S.rp.cars.length, remote: S.rp.cars.filter(c=>c.remote).length, lb: S.lb ? S.lb.length : 0, clk: +S.raceClock.toFixed(1) }; })()');
  console.log('  房间内 ' + ROOM_SECS + 's：帧间隔 p50 ' + q(iv, 0.5) + 'ms / p90 ' + q(iv, 0.9)
    + 'ms / max ' + iv[iv.length - 1] + 'ms   fps ' + fps
    + '   JS p50 ' + q(js, 0.5) + 'ms / p99 ' + q(js, 0.99) + 'ms   ' + JSON.stringify(st));
  ok(q(iv, 0.5) < 20, '★单人房间内帧间隔中位数 < 20ms（不再"非常卡"）', q(iv, 0.5) + 'ms');
  ok(q(js, 0.5) < 12, '★单人房间内主循环 JS 中位耗时 < 12ms', q(js, 0.5) + 'ms');

  // ---- ★★ 行为断言：比赛进行中收到 started:false 的 room 报文，不许把车锁死 ----
  // 直接走 network.js 的公开分发入口注入（与真实下行报文同一条代码路径）。
  const inject = await cdp.eval(`(() => {
    const S = window.__S;
    if (!S.net || typeof S.net.emit !== 'function') return { err: 'net.emit 不存在' };
    const before = { mode: S.mode, racing: !!S.rp.racing, clk: +S.raceClock.toFixed(2) };
    S.net.emit('room', { started: false, players: [{ id: S.localId, name: '我', ready: true }],
      laps: 3, track: 'suzuka', ghost: false, room: S.net.roomCode || 'TEST' });
    return { before: before, after: { mode: S.mode, racing: !!S.rp.racing, clk: +S.raceClock.toFixed(2) },
      hudHidden: document.getElementById('hud').classList.contains('hidden'),
      lobbyShown: !document.getElementById('lobby').classList.contains('hidden') };
  })()`);
  await sleep(600);
  const after = await cdp.eval(`(() => { const S = window.__S;
    return { mode: S.mode, racing: !!S.rp.racing, clk: +S.raceClock.toFixed(2),
      lock: S.controlsLocked ? 1 : 0, kmh: S.localCar ? +S.localCar.speedKmh.toFixed(1) : null }; })()`);
  console.log('  注入 started:false 的 room 报文：' + JSON.stringify(inject) + ' → ' + JSON.stringify(after));
  ok(after.mode === 'race' && after.racing === true && after.clk > 0,
    '★★比赛中收到 started:false 的 room 报文不会被踢回大厅（车不会被永久锁死）',
    'mode=' + after.mode + ' racing=' + after.racing + ' clk=' + after.clk);
  ok(after.kmh > 5, '★注入后本地车仍在加速（油门通路没被切断）', after.kmh + ' km/h');

  const exc = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  ok(exc.length === 0, '整轮无未捕获异常', exc.length + ' 次');
  writeFileSync('hud-gap-report.json', JSON.stringify({ rows, frames: fr.slice(0, 500) }, null, 2));
  console.log('\n明细 -> hud-gap-report.json');
  console.log(fail ? '\x1b[31m失败 ' + fail + " 项\x1b[0m" : '\x1b[32m全部通过\x1b[0m');
} catch (e) {
  console.error('探针失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
process.exitCode = process.exitCode || (fail ? 1 : 0);
