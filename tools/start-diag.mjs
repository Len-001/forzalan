/* =============================================================================
 * 起跑 / 物理活性诊断（真机 CDP）
 *
 * 回答三个具体问题：
 *   ① 绿灯之后各车到底动没动？加速度多少？（人机 vs 本地）
 *   ② 本地车从"能踩油门"到"真的动起来"中间隔了多久、卡在哪一道闸？
 *   ③ 主循环 / 物理步是否真的在推进（acc / stepCount / time / alpha）
 * 顺带抓 Runtime.exceptionThrown —— 页面级报错会触发 fatal() 覆盖层并拖慢帧。
 *
 * 用法： node tools/start-diag.mjs           # 单机练习
 *        DIAG_SECS=20 node tools/start-diag.mjs
 *        DIAG_TRACK=vegas node tools/start-diag.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.DIAG_PORT || 8099);
const CDP_PORT = Number(process.env.DIAG_CDP_PORT || 9336);
const SECS = Number(process.env.DIAG_SECS || 16);
const TRACK = process.env.DIAG_TRACK || 'suzuka';
const PRESS_KEY = process.env.DIAG_KEY !== '0';     // 默认按 W 验证本地车能否加速
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
      } else if (m.method) { if (c.events.length < 500) c.events.push(m); }
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
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(method + ' 超时')); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result.value;
  }
}

const srv = spawn(EXE, ['-addr', ':' + PORT, '-quiet'], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1500);
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome'); srv.kill(); process.exit(1); }
const child = spawn(browser, [
  '--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'diag-cdp-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,900',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
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

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&track=${TRACK}` });
  await sleep(2000);

  // 页面身份指纹：任何 location.reload / 重新 beginRace 都能被识别出来
  await cdp.eval(`(() => {
    window.__nonce = Math.random().toString(36).slice(2);
    window.__tl = [];
    if (!window.__tlTimer) {
      window.__tlTimer = setInterval(() => {
        const S = window.__S;
        if (!S || !S.rp) return;
        const c = S.localCar, rp = S.rp;
        window.__tl.push({
          ms: performance.now() | 0,
          nonce: window.__nonce,
          mode: S.mode, clk: +(S.raceClock || 0).toFixed(3),
          racing: rp.racing ? 1 : 0, lock: S.controlsLocked ? 1 : 0,
          rLock: c ? (c.raceLocked ? 1 : 0) : -1,
          acc: +(rp.acc || 0).toFixed(4), steps: rp.stepCount || 0,
          ptime: +(rp.time || 0).toFixed(3), alpha: +(rp.alpha || 0).toFixed(3),
          loc: c ? +c.speedKmh.toFixed(1) : null,
          lthr: c ? +c.input.throttle.toFixed(2) : null,
          lz: c ? +c.pos.z.toFixed(2) : null,
          off: c ? +c.offRoad.toFixed(2) : null,
          air: c ? (c.airborne ? 1 : 0) : -1,
          ph: c ? (c.body.sleepState || 0) : -1,
          ai: rp.cars.filter((x) => x.ai).map((x) => +x.speedKmh.toFixed(1)).join('/'),
          aiz: rp.cars.filter((x) => x.ai).map((x) => +x.pos.z.toFixed(1)).join('/'),
          frames: window.__frames ? window.__frames.length : -1,
        });
      }, 250);
    }
    return window.__nonce;
  })()`);

  // 页面级异常（会触发 fatal() 覆盖层）
  const seen = new Set();
  let pressed = false;
  const rows = [];
  for (let i = 0; i < SECS * 4; i++) {
    await sleep(250);
    const tl = await cdp.eval('(window.__tl||[]).slice(-1)[0] || null');
    if (tl) rows.push(tl);
    // 绿灯放行后 1s 按下 W，验证本地车能否真的加速
    if (PRESS_KEY && !pressed && tl && tl.racing === 1 && tl.clk > 1.0) {
      pressed = true;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, text: 'w' });
      console.log('>>> 已在 raceClock=' + tl.clk + 's 按下 W');
    }
    for (const e of cdp.events.splice(0)) {
      if (e.method === 'Runtime.exceptionThrown') {
        const t = e.params.exceptionDetails;
        const key = (t.text || '') + (t.exception && t.exception.description || '');
        if (!seen.has(key)) { seen.add(key); console.log('!! 页面异常: ' + key.slice(0, 300)); }
      }
    }
  }

  console.log('\ncols: ms nonce clk racing lock rLock acc steps ptime alpha loc lthr lz ai aiz frames');
  const head = rows.slice(0, 6);
  const tail = rows.slice(-6);
  for (const r of [...head, { SEP: 1 }, ...tail]) {
    if (r.SEP) { console.log('  ...'); continue; }
    console.log('  ' + [r.ms, r.nonce, r.clk, r.racing, r.lock, r.rLock, r.acc, r.steps,
      r.ptime, r.alpha, r.loc, r.lthr, r.lz, r.ai, r.aiz, r.frames].join(' | '));
  }
  // 汇总
  const uniq = [...new Set(rows.map((r) => r.nonce))];
  console.log('\n页面指纹变化次数（>1 = 页面被重载/重开）: ' + uniq.length + '  ' + uniq.join(','));
  const first = rows[0], last = rows[rows.length - 1];
  console.log('步数增量 stepCount: ' + (last.steps - first.steps) + '（物理子步，按 250ms 采样）');
  console.log('物理时间增量 rp.time: ' + (last.ptime - first.ptime).toFixed(2) + 's');
  console.log('本地车 z 位移: ' + (last.lz - first.lz).toFixed(2) + 'm   速度: ' + first.loc + ' -> ' + last.loc + ' km/h');
  console.log('人机末速: ' + first.ai + '  ->  ' + last.ai);
  console.log('racing/lock 首样本: ' + first.racing + '/' + first.lock + '  末样本: ' + last.racing + '/' + last.lock);
  writeFileSync('diag-report.json', JSON.stringify({ rows, events: cdp.events.slice(0, 100) }, null, 2));
  console.log('完整逐样本时间线 -> diag-report.json');
} catch (e) {
  console.error('诊断失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
