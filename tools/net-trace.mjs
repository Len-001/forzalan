/* =============================================================================
 * 联机协议时序追踪（真机 CDP）
 *
 * 目的：把"发车之后客户端状态被谁改回去了"钉死。
 * 客户端 `net.on('room')` 里有一句 `if (m.started) return; S.mode = 'room'` ——
 * 只要收到一条 `started:false` 的 room 报文，HUD 就会被换成大厅、`S.mode` 不再是
 * 'race'，于是主循环走 else 分支把 raceClock 归零、`S.rp.racing` 变 false，
 * 本地车**永远拿不到油门**（而服务端与别人的车照跑）—— 症状正是
 * "绿灯亮了但我起不来 / 别人先走几步"。
 *
 * 本工具逐条记录服务端下行报文类型 + 客户端状态跃迁，跑 4 轮抓间歇性复现。
 *
 * 用法： node tools/net-trace.mjs
 *        ROUNDS=6 DIAG_EXE=forzalan.exe node tools/net-trace.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.DIAG_PORT || 8099);
const CDP_PORT = Number(process.env.DIAG_CDP_PORT || 9340);
const ROUNDS = Number(process.env.ROUNDS || 4);
// 观察窗口必须覆盖**完整起跑流程**：整备倒计时 5s + 载入 0.25s + 5×0.7s 红灯 = 8.75s，
// 之后再留出"发车后"的观测余量 ⇒ 至少 13s。旧值 9s 是"一键就发车"时代的窗口，
// 实测只会看到 room→race 而永远等不到 racing=true（假红"从未发车"）。
const WATCH_MS = Number(process.env.WATCH_MS || 22000);
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
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new CDP(ws);
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id); c.waits.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP WS 连接失败')));
    });
    return c;
  }
  send(method, params = {}, timeout = 60000) {
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
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tr-cdp-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,720',
  'about:blank',
], { stdio: 'ignore' });

const HOOK = `(() => {
  window.__trace = window.__trace || [];
  window.__lastMode = null;
  const tick = () => {
    const S = window.__S; if (!S || !S.net) return;
    const ws = S.net.ws;
    if (ws && ws !== window.__hookedWs) {
      window.__hookedWs = ws;
      const prev = ws.onmessage;
      ws.onmessage = (ev) => {
        let t = '?';
        try { t = JSON.parse(ev.data).t; } catch (e) { t = 'BAD'; }
        const st = window.__S;
        window.__trace.push([performance.now() | 0, 'in ' + t, st ? st.mode : '-',
          st ? ((st.rp && st.rp.racing) ? 1 : 0) : -1]);
        window.__hookedWs2 = true;
        return prev.call(ws, ev);
      };
    }
    const m = window.__S.mode;
    if (m !== window.__lastMode) {
      window.__trace.push([performance.now() | 0, 'mode -> ' + m, m,
        window.__S.rp && window.__S.rp.racing ? 1 : 0]);
      window.__lastMode = m;
    }
  };
  if (window.__traceTimer) clearInterval(window.__traceTimer);
  window.__traceTimer = setInterval(tick, 40);
  return true;
})()`;

let cdp;
let bad = 0;
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

  for (let round = 1; round <= ROUNDS; round++) {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(2500);
    let connected = false;
    for (let i = 0; i < 50; i++) {
      try { if (await cdp.eval('!!(window.__S && window.__S.net && window.__S.net.connected)')) { connected = true; break; } } catch (_) { /* wait */ }
      await sleep(300);
    }
    if (!connected) { console.log('第 ' + round + ' 轮：连不上服务端，跳过'); continue; }
    await cdp.eval('(() => { const b = document.getElementById("btnCreate"); if (b) b.click(); return true; })()');
    await sleep(1100);
    await cdp.eval('(() => { const b = document.getElementById("btnReady"); if (b) b.click(); return true; })()');
    const states = [];
    for (let i = 0; i < Math.round(WATCH_MS / 150); i++) {
      await sleep(150);
      try {
        const s = await cdp.eval(`(() => { const S = window.__S; if (!S) return null;
          return { m: S.mode, c: +(S.raceClock || 0).toFixed(2),
            r: (S.rp && S.rp.racing) ? 1 : 0, l: S.controlsLocked ? 1 : 0,
            car: S.localCar ? 1 : 0, kmh: S.localCar ? +S.localCar.speedKmh.toFixed(1) : null }; })()`);
        if (s) states.push(s);
      } catch (_) { /* transient */ }
    }
    const tr = await cdp.eval('(window.__trace || []).slice(0, 200)');
    const last = states[states.length - 1] || {};
    const everRacing = states.some((s) => s.r === 1);
    const modeSet = [...new Set(states.map((s) => s.m))];
    const flipped = everRacing && last.r === 0;
    if (flipped || !everRacing) bad++;
    console.log('第 ' + round + ' 轮：末态 mode=' + last.m + ' clk=' + last.c + ' racing=' + last.r
      + ' lock=' + last.l + ' kmh=' + last.kmh
      + '  |  出现过 racing=' + everRacing + '  模式集合=' + JSON.stringify(modeSet)
      + (flipped ? '   ← ★发车后又掉出 race' : (!everRacing ? '   ← ★从未发车' : '   OK')));
    // 只打印"发车前后"的关键报文
    const idx = tr.findIndex((x) => String(x[1]).includes('race') || String(x[1]).includes('lights'));
    const from = idx > 6 ? idx - 6 : 0;
    for (const x of tr.slice(from, from + 22)) {
      console.log('      +' + x[0] + 'ms  ' + x[1] + '   (mode=' + x[2] + ' racing=' + x[3] + ')');
    }
  }
  console.log('\n服务端日志尾部：');
  for (const l of srvLog.slice(-18)) console.log('  | ' + l.slice(0, 150));
  console.log(bad ? '\n\x1b[31m' + bad + ' 轮出现异常\x1b[0m' : '\n\x1b[32m' + ROUNDS + ' 轮全部正常\x1b[0m');
  writeFileSync('net-trace.log', srvLog.join('\n'));
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.error('追踪失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
