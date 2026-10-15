/* =============================================================================
 * 起跑时长 / 准备时间验收（真机 CDP）
 *
 * 用户原话："创建房间准备倒开始赛车太快了都没有准备时间。
 *             房间内玩家全员准备后有5秒倒计时放在右侧聊天框里。
 *             进入局内有5秒红灯倒数然后才会绿灯发车。"
 *
 * 本脚本用**真实时间戳**量三件事，不接受"看起来像"：
 *   ① 全员准备 → 右下聊天框里出现 "[赛事指令] … 秒后发车…" 的每一拍时刻
 *   ② 服务端 START_SEQUENCE_BEGIN → RACE_START 的实际间隔（灯序总时长）
 *   ③ 绿灯（forceRaceGo）之前，本地车**确实不能动**（准备时间是真的锁着）
 *
 * 用法： node tools/start-timing-check.mjs
 *        SD_CAM=0 node tools/start-timing-check.mjs        # 用单人房间（默认）
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8099);
const CDP_PORT = Number(process.env.CDP_PORT || 9342);
const EXE = process.env.SD_EXE || (process.platform === 'win32' ? 'forzalan.exe' : './forzalan');
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
        const { res, rej, timer } = c.waits.get(m.id); c.waits.delete(m.id);
        clearTimeout(timer);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method) { if (c.events.length < 2000) c.events.push(m); }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP WS 连接失败')));
    });
    return c;
  }
  send(method, params = {}, timeout = 10000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(method + ' 超时')); } }, timeout);
      this.waits.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
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
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sd-cdp-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,720',
  'about:blank',
], { stdio: 'ignore' });

let cdp, fail = 0;
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

  // ---- 时间线采集器：每 100ms 记一次状态 + 监听聊天行 DOM 变化 ----
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__tl = [];
      window.__rows = [];        // 聊天/浮层里出现过的倒数行
      const seen = new Set();
      setInterval(() => {
        const S = window.__S;
        if (!S) return;
        const c = S.localCar;
        window.__tl.push({
          t: Date.now(),
          mode: S.mode,
          clk: +(S.raceClock || 0).toFixed(3),
          racing: S.rp && S.rp.racing ? 1 : 0,
          lock: S.controlsLocked ? 1 : 0,
          rLock: (c && c.raceLocked) ? 1 : 0,
          goDone: !!window.__goDone,
          kmh: c ? +c.speedKmh.toFixed(1) : null,
          thr: c ? +c.input.throttle.toFixed(2) : null,
          lights: (() => { const b = document.getElementById('startLights');
            if (!b || b.classList.contains('hidden') || b.style.display === 'none') return 'off';
            if (b.classList.contains('go')) return 'GO';
            return 'R' + b.querySelectorAll('.sl.red.on').length; })(),
        });
        // 抓聊天区里所有"[赛事指令]"行（大厅 feed + 局内浮层）
        for (const sel of ['#chatFeed', '#hudChatFeed']) {
          const feed = document.querySelector(sel);
          if (!feed) continue;
          for (const el of feed.children) {
            const txt = (el.textContent || '').trim();
            if (!/赛事指令/.test(txt)) continue;
            const key = sel + '|' + txt;
            if (seen.has(key)) continue;
            seen.add(key);
            // ⚠️ 类名/dataset 挂在**内层**节点上（.chat-sys / .hc-msg），不是外层 row ——
            //    直接读 row.dataset / row.className 会永远拿到空值（第一版就这样假红）。
            const inner = el.firstElementChild || el;
            window.__rows.push({
              sel, txt, t: Date.now(),
              cls: inner.className || '',
              secs: (inner.dataset && inner.dataset.secs) !== undefined
                ? inner.dataset.secs : (el.dataset ? el.dataset.secs : undefined),
              big: !!(el.querySelector && el.querySelector('.hc-cd-num, .chat-cd-num')),
              numText: (el.querySelector && el.querySelector('.hc-cd-num, .chat-cd-num'))
                ? el.querySelector('.hc-cd-num, .chat-cd-num').textContent : null,
            });
          }
        }
      }, 100);
    })()`,
  });

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);
  for (let i = 0; i < 50; i++) {
    try { if (await cdp.eval('!!(window.__S && window.__S.net && window.__S.net.connected)')) break; } catch (_) { /* wait */ }
    await sleep(300);
  }
  console.log('\n\x1b[1m联机单人房间：全员准备后的准备时间\x1b[0m');
  await cdp.eval('(() => { const b = document.getElementById("btnCreate"); if (b) b.click(); return true; })()');
  await sleep(1200);
  const tReady = Date.now();
  await cdp.eval('(() => { const b = document.getElementById("btnReady"); if (b) b.click(); return true; })()');
  console.log('  已点击"准备"（t=0）');

  // 记录 forceRaceGo 被调用的时刻（最权威的"绿灯放行"证据）
  await cdp.eval(`(() => {
    const S = window.__S;
    if (window.__goHooked) return true;
    window.__goHooked = true;
    const t0 = Date.now();
    window.__goAt = null; window.__goReason = null;
    const proto = null;
    // 用 MutationObserver 盯 #startLights 的 class（GO 时会加 .go）
    const box = document.getElementById('startLights');
    if (box) {
      new MutationObserver(() => {
        if (box.classList.contains('go') && window.__goAt === null) window.__goAt = Date.now();
      }).observe(box, { attributes: true, attributeFilter: ['class'] });
    }
    window.__t0 = t0;
    return true;
  })()`);

  // 等放行（最多 25s）
  let goAt = null;
  for (let i = 0; i < 250; i++) {
    await sleep(100);
    const st = await cdp.eval('({ at: window.__goAt, racing: !!(window.__S.rp && window.__S.rp.racing), clk: +(window.__S.raceClock||0).toFixed(2) })');
    if (st.racing) { goAt = st.at || Date.now(); break; }
  }
  const tl = await cdp.eval('window.__tl.slice(0, 4000)');
  const rows = await cdp.eval('window.__rows.slice(0, 100)');
  const t0 = await cdp.eval('window.__t0');
  await sleep(400);
  const rowsAfter = await cdp.eval('window.__rows.slice(0, 100)');

  // ---- ① 聊天框里的整备倒计时 ----
  const cd = rows.filter((r) => /秒后发车/.test(r.txt));
  const secs = cd.map((r) => ({ s: Number(r.secs), at: r.t, big: r.big, sel: r.sel, cls: r.cls, numText: r.numText }));
  secs.sort((a, b) => a.at - b.at);
  console.log('  右侧聊天框捕获到的倒数行：');
  for (const s of secs) console.log('      +' + ((s.at - t0) / 1000).toFixed(2) + 's  ' + s.s + ' 秒后发车  ['
    + (s.big ? '大号数字=' + s.numText : '普通') + ' / ' + s.sel + ' / ' + s.cls + ']');
  ok(secs.length >= 5, '★★全员准备后聊天框发出 5 拍整备倒计时（5→1）', secs.length + ' 拍');
  ok(secs.length > 0 && secs[0].s === 5 && secs[secs.length - 1].s === 1,
    '★★整备倒计时是从 5 数到 1',
    secs.map((x) => x.s).join('→'));
  if (secs.length >= 2) {
    const gaps = [];
    for (let i = 1; i < secs.length; i++) gaps.push((secs[i].at - secs[i - 1].at) / 1000);
    const m = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    ok(gaps.every((g) => g > 0.75 && g < 1.35), '★★每拍间隔 ≈1 秒（真实秒表，不是一次性刷出）',
      gaps.map((g) => g.toFixed(2)).join('/') + 's');
    ok(m > 0.85 && m < 1.15, '★平均节拍 ≈1.00s', m.toFixed(3) + 's');
  }
  ok(secs.every((s) => s.big), '★每一拍都带大号数字节点（.chat-cd-num）',
    secs.filter((s) => s.big).length + '/' + secs.length);
  ok(secs.every((s) => String(s.numText) === String(s.s)),
    '★大号数字显示的秒数与文本一致', secs.map((s) => s.numText).join(','));
  ok(secs.every((s) => /cd-big/.test(s.cls)), '★倒计时行带 .cd-big 类（CSS 才吃得到大号样式）',
    secs[0] ? secs[0].cls : '(无)');

  // ---- ② 准备 → 绿灯的总时长 ----
  const total = (goAt - t0) / 1000;
  // 期望：5s 整备 + 250ms 载入 + 5×700ms 红灯 = 8.75s
  console.log('  「准备」→ 绿灯放行 = ' + total.toFixed(2) + 's（期望 ≈9.0s = 5s 整备 + 0.25s 载入 + 5×0.7s 红灯）');
  ok(total > 7.0 && total < 9.5, '★★准备到发车总时长 ≥7s（原来只有 2.75s，肉眼"一键就发车"）',
    total.toFixed(2) + 's');

  // ---- ③ 灯序是真的逐盏熄灭 ----
  const lightsSeq = [];
  for (const s of tl) {
    const last = lightsSeq[lightsSeq.length - 1];
    if (!last || last.v !== s.lights) lightsSeq.push({ v: s.lights, t: s.t });
  }
  const redSteps = lightsSeq.filter((x) => /^R[0-5]$/.test(x.v));
  console.log('  灯组状态序列：' + lightsSeq.map((x) => x.v + '+' + ((x.t - t0) / 1000).toFixed(1) + 's').join('  '));
  ok(redSteps.length >= 3, '★★红灯逐盏熄灭（观测到多档 R5→R1，不是一帧跳过）', redSteps.length + ' 档');
  const redCounts = redSteps.map(x => Number(x.v.slice(1)));
  ok(redCounts.every((v, i) => i === 0 || v < redCounts[i - 1]),
    '★★两条灯控通道交错时红灯只减少，不重新点亮', redCounts.join('→'));
  await sleep(1100);
  const lateLights = await cdp.eval(`(() => {
    const S = window.__S;
    S.net.emit('lights', {stage: 3});
    S.net.emit('startSeq');
    S.net.emit('lights', {stage: 5});
    const b = document.getElementById('startLights');
    return {red: b.querySelectorAll('.sl.red.on').length, hidden: b.style.display === 'none', locked: S.controlsLocked};
  })()`);
  ok(lateLights.red === 0 && lateLights.hidden && !lateLights.locked,
    '★★绿灯后迟到红灯和重复起跑序列不能重新显示红灯或锁车', JSON.stringify(lateLights));
  const exceptions = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok(exceptions.length === 0, '★完整起跑流程没有浏览器异常', exceptions.length + ' 个');

  // ---- ④ 准备时间里车真的不能动 ----
  const beforeGo = tl.filter((s) => s.t < goAt - 300);
  const moved = beforeGo.filter((s) => (s.kmh || 0) > 1 || (s.thr || 0) > 0);
  ok(moved.length === 0, '★★绿灯之前油门被清零、车不动（准备时间是真锁着的）',
    moved.length ? moved.slice(0, 3).map((s) => 'kmh=' + s.kmh + ' thr=' + s.thr).join(',') : '');
  const lockedSamples = beforeGo.filter((s) => s.lock === 1).length;
  ok(lockedSamples > 0 && lockedSamples >= beforeGo.length * 0.7,
    '★准备期间 controlsLocked 一直为真', lockedSamples + '/' + beforeGo.length + ' 个样本');

  // ---- ⑤ 倒计时行常驻不淡出：绿灯前它应该还在 DOM 里 ----
  const stillThere = rowsAfter.filter((r) => /秒后发车/.test(r.txt)).length;
  ok(cd.length > 0 && stillThere >= 1,
    '★倒计时行在绿灯前仍留在聊天框里（不被 5s 自动淡出吃掉）', stillThere + ' 行在场');

  console.log('\n  服务端日志（房间/起跑相关）：');
  for (const l of srvLog.filter((x) => /room|START|起跑|light/.test(x)).slice(-6)) console.log('    | ' + l.slice(0, 130));

  writeFileSync('start-timing.json', JSON.stringify({ t0, goAt, secs, lightsSeq, tl: tl.slice(0, 600), rows }, null, 2));
  console.log('\n明细 -> start-timing.json');
  console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
} catch (e) {
  console.error('验收失败：' + e.message);
  process.exitCode = 1;
} finally {
  if (cdp) {
    for (const pending of cdp.waits.values()) clearTimeout(pending.timer);
    cdp.ws.close();
  }
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
process.exitCode = process.exitCode || (fail ? 1 : 0);
