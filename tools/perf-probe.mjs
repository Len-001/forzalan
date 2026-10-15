/* =============================================================================
 * 运行期性能探针（真机 CDP + V8 CPU Profile）
 *
 * 用途：把"卡"从主观体感变成可复算的数字 ——
 *   ① rAF 帧间隔分布（p50 / p90 / p99 / max）与主循环 JS 自耗时
 *   ② V8 采样 CPU Profile → 按**自身耗时**排序的函数热点榜
 *   ③ three.js 渲染统计（draw calls / 三角形 / 几何体）
 *   ④ 起跑序列时间线（raceClock / racing / controlsLocked / 各车速度）
 *
 * 零第三方依赖：手写 CDP 客户端（WebSocket + JSON），与 chat-ui-check.mjs 同源。
 *
 * 用法：
 *   node tools/perf-probe.mjs                 # 单机练习（3 台 AI），铃鹿
 *   PERF_SECS=12 node tools/perf-probe.mjs    # 采样时长
 *   PERF_TRACK=vegas PERF_LAPS=3 node tools/perf-probe.mjs
 *   PERF_HEADLESS=0 node tools/perf-probe.mjs # 有窗口跑（本机 GPU，最贴近实机）
 *   PERF_GPU=0 node tools/perf-probe.mjs      # 强制软件渲染（区分 GPU/CPU 瓶颈）
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PERF_PORT || 8099);
const CDP_PORT = Number(process.env.PERF_CDP_PORT || 9335);
const SECS = Number(process.env.PERF_SECS || 10);
const WARMUP = Number(process.env.PERF_WARMUP || 3);
const TRACK = process.env.PERF_TRACK || 'suzuka';
const LAPS = process.env.PERF_LAPS || '3';
const HEADLESS = process.env.PERF_HEADLESS !== '0';
const USE_GPU = process.env.PERF_GPU !== '0';
const EXE = process.env.PERF_EXE || (process.platform === 'win32' ? 'forzalan.exe' : './forzalan');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ---------------------------- 极简 CDP 客户端 ---------------------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new CDP(ws);
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id);
        c.waits.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method) c.events.push(m);
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
      this.waits.set(id, { res: value => { clearTimeout(timer); res(value); }, rej: error => { clearTimeout(timer); rej(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
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

const args = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'perf-cdp-'))}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1600,900',
  '--autoplay-policy=no-user-gesture-required',
];
if (HEADLESS) args.unshift('--headless=new');
if (USE_GPU) args.push('--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11');
else args.push('--disable-gpu', '--enable-unsafe-swiftshader');
args.push('about:blank');

const child = spawn(browser, args, { stdio: 'ignore' });

async function cdpTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}

let cdp;
const out = { config: { PORT, SECS, WARMUP, TRACK, LAPS, HEADLESS, USE_GPU, EXE } };
try {
  cdp = await CDP.connect(await cdpTarget());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Profiler.enable');

  // 在页面脚本执行**之前**埋 rAF 计时钩子 —— 否则捕捉不到主循环的真实耗时
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__frames = [];
      const _raf = window.requestAnimationFrame.bind(window);
      let _prev = 0;
      window.requestAnimationFrame = (cb) => _raf((ts) => {
        const t0 = performance.now();
        try { cb(ts); } finally {
          const t1 = performance.now();
          const f = window.__frames;
          if (f.length < 400000) f.push([+(ts - _prev).toFixed(3), +(t1 - t0).toFixed(3)]);
          _prev = ts;
        }
      });`,
  });

  const url = `http://127.0.0.1:${PORT}/?solo=1&dbg=1&track=${TRACK}&laps=${LAPS}`;
  await cdp.send('Page.navigate', { url });
  await sleep(2500);

  // 等引擎就绪（S.rp 存在）并等起跑序列走完
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const st = await cdp.eval('typeof window.__S === "object" && !!window.__S.rp && window.__S.rp.racing === true');
      if (st) { ready = true; break; }
    } catch (_) { /* 还在装载 */ }
    await sleep(500);
  }
  if (!ready) throw new Error('引擎未就绪或未进入 racing（可能是 WebGL 初始化失败，见 dbg 面板）');

  out.webgl = await cdp.eval(`(() => {
    const gl = document.getElementById('gl').getContext('webgl2') || document.getElementById('gl').getContext('webgl');
    if (!gl) return 'no-context';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })()`);

  // 记录起跑序列时间线（每次 beginRace 后重新指向新实例）
  await cdp.eval(`(() => {
    const S = window.__S;
    window.__timeline = [];
    if (!Number.isInteger(S.rp.physicsStep) || S.rp.physicsStep < 0) throw new Error("Worker 步数缺失");
    window.__workerErrors = [];
    S.rp.on("error", error => window.__workerErrors.push(String(error)));
    if (!window.__tlTimer) {
      window.__tlTimer = setInterval(() => {
        const P = window.__S;
        const c = P.localCar;
        window.__timeline.push([
          +(P.raceClock || 0).toFixed(3),
          P.rp && P.rp.racing ? 1 : 0,
          P.controlsLocked ? 1 : 0,
          P.rp ? P.rp.physicsStep : null,
          c ? +c.speedKmh.toFixed(1) : null,
          P.rp ? P.rp.cars.map((x) => +x.speedKmh.toFixed(1)).join('/') : '',
        ]);
      }, 100);
    }
    return true;
  })()`);

  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
  await sleep(WARMUP * 1000);
  out.workerEarly = await cdp.eval("window.__S.rp.requestDiagnostics(2000)");
  // 清空帧与时间线，进入纯采样窗口
  await cdp.eval('window.__frames.length = 0; window.__timeline.length = 0; true');

  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await sleep(SECS * 1000);
  const { profile } = await cdp.send('Profiler.stop');

  out.timeline = await cdp.eval('window.__timeline.slice(0, 400)');
  out.frames = await cdp.eval('window.__frames.slice(0, 200000)');
  out.dbg = await cdp.eval('(document.getElementById("dbg")||{}).textContent || ""');
  out.workerLate = await cdp.eval("window.__S.rp.requestDiagnostics(2000)");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
  out.exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
  out.workerErrors = await cdp.eval("window.__workerErrors");
  if (out.exceptions.length || out.workerErrors.length) throw new Error(JSON.stringify({ exceptions: out.exceptions, workerErrors: out.workerErrors }));
  out.raceState = await cdp.eval(`(() => {
    const S = window.__S;
    return {
      owner: "physics.worker.js",
      mainThreadHasWorld: !!S.rp.world,
      physicsStep: S.rp.physicsStep,
      substep: S.rp.substep,
      cars: S.rp.cars.map((c) => ({ id: c.id, ai: !!c.ai, remote: !!c.remote, auto: !!c.auto,
        kmh: +c.speedKmh.toFixed(1), lap: c.lap, cp: c.cpIdx, finished: !!c.finished, retired: !!c.retired })),
      lb: S.lb ? S.lb.length : 0,
      mode: S.mode, laps: S.laps,
    };
  })()`);

  if (out.raceState.mainThreadHasWorld || out.raceState.cars.length !== 12 || out.frames.length < 100) throw new Error("Worker/12车/帧样本契约不满足");
  for (const data of [out.workerEarly, out.workerLate]) {
    if (data.fixedDt !== 1 / 60 || data.fixedSteps < 90 || data.fixedStepMs.count !== data.fixedSteps) throw new Error("真实固定步长采样不足");
  }

  // ---- 帧间隔统计 ----
  const iv = out.frames.map((f) => f[0]).filter((x) => x > 0.5 && x < 2000).sort((a, b) => a - b);
  const q = (p) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] : null);
  const js = out.frames.map((f) => f[1]).sort((a, b) => a - b);
  const qjs = (p) => (js.length ? js[Math.min(js.length - 1, Math.floor(p * js.length))] : null);
  out.frameStats = {
    n: iv.length,
    fps_mean: iv.length ? +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1) : null,
    interval_p50: q(0.5), interval_p90: q(0.9), interval_p99: q(0.99), interval_max: iv[iv.length - 1],
    over33ms: iv.filter((x) => x > 33).length,
    over100ms: iv.filter((x) => x > 100).length,
    js_p50: qjs(0.5), js_p90: qjs(0.9), js_p99: qjs(0.99), js_max: js[js.length - 1],
  };

  // ---- CPU Profile 热点榜（按自身耗时） ----
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] || 0;
    total += dt;
    self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + dt);
  }
  const rows = [];
  for (const [id, us] of self) {
    const n = byId.get(id); if (!n) continue;
    const cf = n.callFrame;
    rows.push({
      ms: us / 1000, pct: (us / total) * 100,
      fn: cf.functionName || '(anonymous)',
      where: (cf.url || '').replace(/^https?:\/\/127\.0\.0\.1:\d+/, '') + ':' + (cf.lineNumber + 1),
    });
  }
  rows.sort((a, b) => b.ms - a.ms);
  out.profileTotalMs = total / 1000;
  out.hot = rows.slice(0, 40).map((r) => ({ ...r, ms: +r.ms.toFixed(1), pct: +r.pct.toFixed(1) }));

  // 按文件归并（一眼看出"是渲染还是物理还是 HUD"）
  const byUrl = new Map();
  for (const r of rows) {
    const u = r.where.split(':').slice(0, -1).join(':') || '(native)';
    byUrl.set(u, (byUrl.get(u) || 0) + r.ms);
  }
  out.byFile = [...byUrl].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([f, ms]) => ({ f, ms: +ms.toFixed(1), pct: +(ms / (total / 1000) * 100).toFixed(1) }));

  console.log(JSON.stringify({
    config: out.config, webgl: out.webgl, frameStats: out.frameStats,
    profileTotalMs: +out.profileTotalMs.toFixed(1), raceState: out.raceState,
    byFile: out.byFile, hot: out.hot,
    workerEarly: out.workerEarly, workerLate: out.workerLate, exceptions: out.exceptions, workerErrors: out.workerErrors,
  }, null, 2));

  writeFileSync('perf-report.json', JSON.stringify(out, null, 2));
  console.log('\n完整结果（含起跑时间线 / 全部帧样本）已写入 perf-report.json');
} catch (e) {
  console.error('探针失败：' + e.message);
  try { console.error('dbg 面板：\n' + await cdp.eval('(document.getElementById("dbg")||{}).textContent || "(无)"')); } catch (_) { /* ignore */ }
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch (_) { /* ignore */ }
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
