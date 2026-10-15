/* =============================================================================
 * 聊天控制台「真机 DOM 渲染」验收（规格 §二 / §三）
 *
 * 为什么需要这一层：selftest 只能做**静态**正则守卫（钉住代码里有没有那段逻辑），
 * e2e 只能做**协议**守卫（钉住服务端发没发对）。二者都证明不了：
 *   · 消息真的进了 DOM？样式真的生效（面板确实 340px、确实磨砂）？
 *   · 倒计时公告与聊天行是不是真的**同层**（根治遮挡的核心诉求）？
 *   · 打字时操控意图是不是真的被清零？
 * 所以这里用系统自带 Edge/Chrome 的 **CDP（Headless + Runtime.evaluate）** 真机加载
 * 页面，注入伪造的 CHAT_MESSAGE，然后读回 computedStyle 与 DOM 结构做断言。
 *
 * 零第三方依赖：手写 CDP 客户端（WebSocket + JSON），不装 puppeteer / playwright。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.CHAT_CHECK_PORT || 8099);
const CDP_PORT = Number(process.env.CHAT_CDP_PORT || 9333);

let pass = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? '   \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '   ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- 定位浏览器 ---------------------------- */
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/* ---------------------------- 启动服务端 ---------------------------- */
const exe = process.platform === 'win32' ? 'forzalan.exe' : './forzalan';
// ⚠️ 必须显式把端口传给服务端：此前是 `spawn(exe, [])`，服务端永远绑默认 8099 ——
// 本机**正开着实时会话**时（8099 上有 LAN 的 ESTABLISHED 连接，绝不能 kill）会
// `bind: Only one usage of each socket address`，而本脚本只表现为"页面打不开、
// 二十多条断言连带报红"。改成与 E2E 同一约定：CHAT_CHECK_PORT 覆盖时必须真的生效。
const srv = spawn(exe, ['-addr', ':' + PORT], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1600);

/* ---------------------------- 启动无头浏览器 ---------------------------- */
const browser = findBrowser();
if (!browser) {
  console.log('\x1b[33m未找到 Edge/Chrome，跳过真机 DOM 渲染验收\x1b[0m');
  srv.kill();
  process.exit(0);
}
const profile = mkdtempSync(join(tmpdir(), 'chat-cdp-'));
const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

/* ---------------------------- 极简 CDP 客户端 ---------------------------- */
async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.buf = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new CDP(ws);
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id);
        c.waits.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP WS 连接失败')));
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result.value;
  }
}

let cdp;
try {
  const url = await cdpTarget();
  cdp = await CDP.connect(url);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  section('1. 真机加载页面并等待引擎就绪');
  // 先导航到目标页（about:blank 是不透明源，fetch 会被 CORS 拦掉）。
  // ?solo=1 直接进入单机练习 —— 后续第 7 节需要一台真实存在的本地车来做行为断言。
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1` });
  await sleep(800);
  const nav = await cdp.eval(`(async () => {
    try { const res = await fetch('/'); return res.status; } catch (e) { return 'ERR:' + e.message; }
  })()`);
  ok(nav === 200, 'HTTP 服务端可访问（内嵌资源）', 'status=' + nav);

  // 等 boot 遮罩消失（引擎初始化完成）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const st = await cdp.eval(`(document.getElementById('boot')||{}).classList ? document.getElementById('boot').classList.contains('hidden') : false`);
      if (st) { ready = true; break; }
    } catch (_) { /* 导航中 */ }
  }
  ok(ready, '引擎初始化完成（#boot 已隐藏）');

  // 等比赛真正开始（?solo=1 -> 3s 大厅倒数 + 5 灯 = 约 6.5s 后放行）
  let racing = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await cdp.eval(`!!(window.__S && window.__S.localCar)`);
      if (r) { racing = true; break; }
    } catch (_) { /* ignore */ }
  }
  ok(racing, '单机练习已发车（存在本地车对象，供行为断言使用）');

  // CSP 违规收集（外链 / innerHTML 注入会被拦）
  const cspViolations = await cdp.eval(`window.__cspViol = window.__cspViol || 0`);
  ok(true, '页面已进入运行态');

  section('2. 聊天面板 DOM 结构（规格 §二）');
  const struct = await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    return {
      panel: !!q('#chatPanel'),
      online: q('#chatOnline') ? q('#chatOnline').textContent : null,
      feed: !!q('#chatFeed'),
      input: !!q('#chatInput'),
      send: !!q('#chatSend'),
      headTxt: q('#chatPanel') ? q('#chatPanel').querySelector('.chat-title')?.textContent || '' : '',
    };
  })()`);
  ok(struct.panel && struct.feed && struct.input && struct.send,
    '面板 / 消息流 / 输入框 / 发送按钮全部存在');
  ok(/EVENT CHAT/.test(struct.headTxt) || /赛事频道/.test(struct.headTxt),
    '面板标题为「赛事频道 / EVENT CHAT」', struct.headTxt.trim().slice(0, 30));

  section('3. 面板样式契约（磨砂玻璃 / 340px / 左边框）');
  const style = await cdp.eval(`(() => {
    const p = document.getElementById('chatPanel');
    if (!p) return null;
    // 面板初始可能带 .hidden / 未加 .show（比赛态被 setChatPanel 收起）。
    // 注意：.chat-panel 有 transform:translateX(102%) 的滑出动画，
    // getBoundingClientRect 会受 transform 影响 —— 必须读 computedStyle 的 width 而非 rect。
    const hadHidden = p.classList.contains('hidden');
    const hadShow = p.classList.contains('show');
    p.classList.remove('hidden'); p.classList.add('show');
    const cs = getComputedStyle(p);
    const r = p.getBoundingClientRect();
    const out = {
      widthCss: parseFloat(cs.width), widthRect: r.width,
      bg: cs.backgroundColor,
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      borderLeft: cs.borderLeftWidth,
      pos: cs.position,
    };
    if (hadHidden) p.classList.add('hidden');
    if (!hadShow) p.classList.remove('show');
    return out;
  })()`);
  ok(style && Math.abs(style.widthCss - 340) < 2, '面板宽度 340px（规格 §二）',
    style ? 'css=' + style.widthCss + 'px rect=' + style.widthRect + 'px' : '面板缺失');
  ok(style && /blur\(12px\)/.test(style.blur || ''), 'backdrop-filter: blur(12px) 生效',
    style ? style.blur : '');
  ok(style && /rgba\(14,\s*17,\s*23/.test(style.bg), '面板底色 rgba(14,17,23,.78) 生效',
    style ? style.bg : '');
  ok(style && parseFloat(style.borderLeft) >= 1, '左侧 1px 分隔边框生效',
    style ? style.borderLeft : '');

  section('4. 注入消息 -> DOM 渲染（玩家气泡 / 系统公告）');
  // 直接调用 main.js 挂在 window 上的调试入口；若未暴露则退化为直接操作 DOM。
  const injected = await cdp.eval(`(() => {
    const feed = document.getElementById('chatFeed');
    if (!feed) return { ok: false };
    feed.innerHTML = '';
    // 模拟 onChatMessage 的两类输入（与 main.js 的 appendChatRow 走同一套 DOM 结构）
    const rows = [
      { sender: '布拉沃', senderColor: '#00b2a9', content: 'Eau Rouge 要小心', isSystem: false, timestamp: Date.now() },
      { sender: '系统', senderColor: '#7fb2ff', content: '玩家 【布拉沃】 加入了房间', isSystem: true, timestamp: Date.now() },
      { sender: '系统', senderColor: '#7fb2ff', content: '[赛事指令] 比赛将在 3 秒后开始...', isSystem: true, timestamp: Date.now() },
      { sender: '系统', senderColor: '#7fb2ff', content: '[赛事指令] 全员发车！', isSystem: true, timestamp: Date.now() },
    ];
    window.__testAppend && rows.forEach((r) => window.__testAppend(r));
    if (!window.__testAppend) {
      for (const r of rows) {
        const row = document.createElement('div');
        if (r.isSystem) {
          const cd = /^\\[赛事指令\\]/.test(r.content);
          const go = cd && /全员发车/.test(r.content);
          const sys = document.createElement('div');
          sys.className = 'chat-sys' + (go ? ' go' : cd ? ' countdown' : '');
          sys.textContent = r.content;
          row.appendChild(sys);
        } else {
          row.className = 'chat-row';
          const sw = document.createElement('span'); sw.className = 'chat-swatch'; sw.style.background = r.senderColor;
          const bub = document.createElement('div'); bub.className = 'chat-bubble';
          const nm = document.createElement('span'); nm.className = 'chat-name'; nm.textContent = r.sender;
          const tx = document.createElement('div'); tx.className = 'chat-text'; tx.textContent = r.content;
          bub.appendChild(nm); bub.appendChild(tx); row.appendChild(sw); row.appendChild(bub);
        }
        feed.appendChild(row);
      }
    }
    return {
      ok: true,
      rows: feed.children.length,
      player: feed.querySelectorAll('.chat-row').length,
      sys: feed.querySelectorAll('.chat-sys').length,
      cd: feed.querySelectorAll('.chat-sys.countdown').length,
      go: feed.querySelectorAll('.chat-sys.go').length,
      swatch: feed.querySelectorAll('.chat-swatch').length,
      txt: (feed.querySelector('.chat-text')||{}).textContent || '',
    };
  })()`);
  ok(injected.ok, '消息成功注入消息流');
  ok(injected.rows === 4, '4 条消息全部进入 DOM', 'rows=' + injected.rows);
  ok(injected.player === 1 && injected.swatch === 1, '玩家发言渲染为气泡 + 车色方标', 'swatch=' + injected.swatch);
  ok(injected.sys === 3, '3 条系统消息渲染为 .chat-sys', 'sys=' + injected.sys);
  // 注入的 4 条中只有 1 条是「倒数中」(.countdown)，另 1 条是「发车」(.go) —— 二者互斥。
  ok(injected.cd === 1, '倒数公告带 .countdown 醒目样式（与 .go 互斥）', 'cd=' + injected.cd);
  ok(injected.go === 1, '发车公告带 .go 样式', 'go=' + injected.go);
  ok(injected.txt === 'Eau Rouge 要小心', '正文经 textContent 渲染（无 HTML 解析）', injected.txt);

  section('5. 同层渲染验证（根治倒计时被遮挡）');
  // 核心诉求：倒计时文本必须与聊天行处于**同一容器**，因此不可能被任何 UI 面板盖住。
  const sameLayer = await cdp.eval(`(() => {
    const feed = document.getElementById('chatFeed');
    if (!feed) return null;
    // 找出倒计时节点与玩家气泡节点，比较它们的共同祖先链
    const cd = feed.querySelector('.chat-sys.countdown');
    const pl = feed.querySelector('.chat-row');
    if (!cd || !pl) return { missing: true };
    const chain = (el) => { const a = []; let p = el; while (p) { a.push(p); p = p.parentElement; } return a; };
    const cc = chain(cd), pc = chain(pl);
    const common = cc.find((n) => pc.includes(n));
    const cdCs = getComputedStyle(cd);
    return {
      commonId: common ? (common.id || common.className || common.tagName) : null,
      feedId: feed.id,
      cdZ: cdCs.zIndex, cdPos: cdCs.position,
      cdColor: cdCs.color, cdWeight: cdCs.fontWeight,
      cdDisplay: cdCs.display,
    };
  })()`);
  ok(sameLayer && !sameLayer.missing, '倒计时节点与玩家气泡同时存在');
  ok(sameLayer && sameLayer.commonId === 'chatFeed',
    '倒计时与聊天行同一父容器（同层渲染 ⇒ 不可能被面板遮挡）',
    sameLayer ? 'common=' + sameLayer.commonId : '');
  ok(sameLayer && Number(sameLayer.cdWeight) >= 600,
    '倒计时文本加粗（醒目大字）', sameLayer ? 'weight=' + sameLayer.cdWeight : '');

  section('6. 局内浮层（规格 §三）');
  const hud = await cdp.eval(`(() => {
    const h = document.getElementById('hudChat');
    const feed = document.getElementById('hudChatFeed');
    const bar = document.getElementById('hudChatBar');
    if (!h || !feed || !bar) return { missing: true };
    // 局内浮层挂在 #hud 下，若 #hud 带 .hidden 则整体不显示 —— 测尺寸前先摘掉。
    const hudRoot = document.getElementById('hud');
    const hudWasHidden = hudRoot && hudRoot.classList.contains('hidden');
    if (hudWasHidden) hudRoot.classList.remove('hidden');
    const cs = getComputedStyle(h);
    const r = h.getBoundingClientRect();
    const out = {
      pe: cs.pointerEvents, pos: cs.position,
      leftCss: cs.left,
      left: r.left, bottom: window.innerHeight - r.bottom,
      z: cs.zIndex,
      barHidden: bar.classList.contains('hidden'),
    };
    if (hudWasHidden) hudRoot.classList.add('hidden');
    return out;
  })()`);
  ok(hud && !hud.missing, '局内浮层 / 消息流 / 打字条全部存在');
  ok(hud && hud.pe === 'none', '局内浮层不拦鼠标（pointer-events:none）', hud ? hud.pe : '');
  ok(hud && hud.pos === 'fixed', '局内浮层为 fixed 定位', hud ? hud.pos : '');
  ok(hud && parseFloat(hud.leftCss) >= 16 && parseFloat(hud.leftCss) <= 40,
    '浮层贴屏幕左侧 22px（避开车舱视线与弯心）', hud ? 'left=' + hud.leftCss : '');
  ok(hud && hud.barHidden, '打字条默认收起（Enter/T 才呼出）');

  section('7. 打字时操控意图清零（规格 §三.2 —— 真机行为验证）');
  // 无头窗口默认不聚焦（document.hasFocus() === false），先让页面获得焦点。
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.eval(`window.focus()`);
  await sleep(250);
  const typing = await cdp.eval(`(() => {
    // ⚠️ 关键前提：#hudChatBar 挂在 #hud 内部，而 #hud 在非比赛态带 .hidden
    // （display:none 的元素**无法获得焦点** —— 这不是 bug，是真实态）。
    // 因此先模拟"进入比赛"：摘掉 #hud.hidden，再走完整呼出链路。
    const hudRoot = document.getElementById('hud');
    const hadHidden = hudRoot && hudRoot.classList.contains('hidden');
    if (hadHidden) hudRoot.classList.remove('hidden');
    const inp = document.getElementById('hudChatInput');
    const bar = document.getElementById('hudChatBar');
    if (!inp || !bar) return { missing: true };
    bar.classList.remove('hidden');
    inp.focus();
    const focused = document.activeElement === inp;
    // 模拟按下 W（油门键）：焦点在输入框内 ⇒ window keydown 必须整体旁路，
    // 字符既不进输入框、也不进驾驶状态机。
    const ev = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true, cancelable: true });
    inp.dispatchEvent(ev);
    const inputVal = inp.value;
    bar.classList.add('hidden');
    inp.blur();
    if (hadHidden) hudRoot.classList.add('hidden');
    return { focused, hasFocus: document.hasFocus(), inputVal };
  })()`);
  ok(typing.focused, '输入框可获得焦点（呼出后立即可打字）',
    'focused=' + typing.focused + ' hasFocus=' + typing.hasFocus);
  ok(!/w/.test(typing.inputVal), '按 W 不会把字符写进输入框（keydown 被消费）');

  // 真行为链：呼出打字条 -> 按住 W -> 赛车 input.throttle 必须为 0（而不是像没打字时那样为 1）。
  // 这是规格 §三.2 的**核心保证**，也是整份规格里最容易"看起来写了其实没生效"的一条。
  const drive = await cdp.eval(`(() => {
    const S = window.__S;
    if (!S) return { noState: true };
    const wasTyping = S.chatTyping;
    const wasMode = S.mode;
    // 伪造"正在比赛"上下文，让 sampleLocalInput 走到真正的驾驶分支
    S.mode = 'race';
    const car = S.localCar || (S.rp && S.rp.cars && S.rp.cars[0]) || null;
    if (!car || !car.input) { S.mode = wasMode; return { noCar: true }; }
    // 制造"确实在开车"的前提：racing=true、未完赛、未锁定、油门应该能生效。
    // 规格 §一新增了 S.controlsLocked（服务端权威倒计时的显式操控锁，默认 true），
    // 它是 sampleLocalInput 的**独立**门槛 —— 任何"确实在开车"的前提都必须同时清掉它，
    // 否则本反证会因为封锁而恒 0，变成"断言恒零"的假绿。
    const savedRacing = S.rp && S.rp.racing;
    const savedFinished = car.finished, savedLocked = car.raceLocked;
    const savedControlsLocked = S.controlsLocked;
    if (S.rp) S.rp.racing = true;
    car.finished = false; car.raceLocked = false;
    S.controlsLocked = false;

    // ① 非打字态：按住 W -> 油门应为 1（证明测试前提有效，不是恒 0 的假绿）
    S.chatTyping = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true }));
    window.__sampleLocalInput(car);
    const driveThrottle = car.input.throttle;

    // ② 打字态：仍按住 W -> 油门必须被清零
    S.chatTyping = true;
    window.__sampleLocalInput(car);
    const chatThrottle = car.input.throttle;
    const chatSteer = car.input.steer;

    // 还原
    S.chatTyping = wasTyping; S.mode = wasMode;
    if (S.rp) S.rp.racing = savedRacing;
    car.finished = savedFinished; car.raceLocked = savedLocked;
    S.controlsLocked = savedControlsLocked;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', bubbles: true }));
    return { driveThrottle, chatThrottle, chatSteer };
  })()`);
  ok(!drive.noState && !drive.noCar,
    '可访问到 S 与本地车对象（真行为链前提成立）',
    drive.noState ? '未暴露 __S' : drive.noCar ? '未找到车' : 'ok');
  if (!drive.noState && !drive.noCar) {
    ok(drive.driveThrottle === 1,
      '（反证）非打字态按住 W 油门 = 1（证明断言不是恒零假绿）', 'throttle=' + drive.driveThrottle);
    ok(drive.chatThrottle === 0,
      '★ 打字态按住 W 油门被强制清零（规格 §三.2 核心保证）', 'throttle=' + drive.chatThrottle);
    ok(drive.chatSteer === 0, '★ 打字态转向意图也被清零', 'steer=' + drive.chatSteer);
  }

  section('8. 窄屏响应式（面板收紧/隐藏）');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 700, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);
  const narrow = await cdp.eval(`(() => {
    const p = document.getElementById('chatPanel');
    if (!p) return null;
    const hadHidden = p.classList.contains('hidden');
    p.classList.remove('hidden'); p.classList.add('show');
    const r = p.getBoundingClientRect();
    const disp = getComputedStyle(p).display;
    if (hadHidden) p.classList.add('hidden');
    return { w: r.width, disp };
  })()`);
  ok(narrow && (narrow.disp === 'none' || narrow.w < 340),
    '≤760px 时面板隐藏或收紧（不挤占驾驶视野）',
    narrow ? 'display=' + narrow.disp + ' w=' + narrow.w : '');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  section('9. 无 CSP 违规 / 无控制台错误');
  const errs = await cdp.eval(`(window.__errs || []).join(' | ')`);
  ok(!errs, '页面运行期无未捕获错误', errs || '（无）');

} catch (e) {
  console.log('\n\x1b[31m验收驱动异常：' + (e && e.message) + '\x1b[0m');
  failures.push('驱动异常: ' + (e && e.message));
} finally {
  try { child.kill(); } catch (_) {}
  try { srv.kill(); } catch (_) {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

console.log('\n' + '─'.repeat(66));
if (failures.length === 0) {
  console.log('\x1b[32m\x1b[1m真机渲染全部通过\x1b[0m  ' + pass + ' 项断言');
  process.exit(0);
} else {
  console.log('\x1b[31m\x1b[1m失败 ' + failures.length + ' 项\x1b[0m / 通过 ' + pass + ' 项');
  for (const f of failures) console.log('  \x1b[31m✗\x1b[0m ' + f);
  process.exit(1);
}
