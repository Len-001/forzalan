/* =============================================================================
 * 掉帧热点定位（真机 CDP）—— 早窗口 vs 晚窗口双份 CPU Profile
 *
 * 背景：修好宽相后中位帧降到 8.3ms（120fps），但跑到某一刻起会**持续**掉到
 * ~110ms/帧，本工具就是把"那一瞬间到底在算什么"挖出来：
 *   · 逐帧记录 rAF 自耗时 / rp.step 耗时 / 累计子步数
 *   · 早窗口（起步后 1~3.5s）与晚窗口（掉帧发生后 2.5s）各采一份 V8 Profile
 *   · 顺带抓：world.contacts、Grid 各 bin 长度分布、车辆状态、?dbg 面板读数
 *
 * 用法： node tools/hotspot-diag.mjs
 *        DIAG_EXE=forzalan.exe node tools/hotspot-diag.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.DIAG_PORT || 8099);
const CDP_PORT = Number(process.env.DIAG_CDP_PORT || 9338);
const EXE = process.env.DIAG_EXE || (process.platform === 'win32' ? 'forzalan.exe' : './forzalan');
const WAIT_SLOW_MS = Number(process.env.DIAG_WAIT_SLOW || 25000);
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
      } else if (m.method) { if (c.events.length < 3000) c.events.push(m); }
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
}

function aggregate(profile) {
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
  return { totalMs: total / 1000, rows };
}

const srv = spawn(EXE, ['-addr', ':' + PORT, '-quiet'], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1500);
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome'); srv.kill(); process.exit(1); }
const child = spawn(browser, [
  '--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'hs-cdp-'))}`,
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
  await cdp.send('Profiler.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__fr=[];const _r=window.requestAnimationFrame.bind(window);let _p=0;
      window.requestAnimationFrame=(cb)=>_r((ts)=>{const t0=performance.now();try{cb(ts);}finally{
      const f=window.__fr;if(f.length<200000)f.push([+(ts-_p).toFixed(2),+(performance.now()-t0).toFixed(2),window.__steps||0]);_p=ts;}});`,
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&dbg=1` });
  await sleep(2500);
  for (let i = 0; i < 120; i++) {
    try { if (await cdp.eval('!!(window.__S && window.__S.rp && window.__S.rp.racing)')) break; } catch (_) { /* wait */ }
    await sleep(500);
  }
  // 每帧记录物理子步数（子步数是"要跑几个 1/60”的直接观测）
  await cdp.eval(`(() => {
    const proto = Object.getPrototypeOf(window.__S.rp);
    if (!proto.__hsPatched) { proto.__hsPatched = true;
      const s = proto.step;
      proto.step = function (dt) { const t0=performance.now(); s.call(this, dt); this.__ms = performance.now()-t0;
        window.__steps = this.stepCount || 0; };
    }
    window.__fr.length = 0;
    return true;
  })()`);

  const snap = async () => cdp.eval(`(() => {
    const S = window.__S, rp = S.rp, w = rp.world;
    const bp = w.broadphase;
    let maxBin = 0, used = 0, total = 0, prod = 0;
    if (bp.binLengths) { for (let i=0;i<bp.binLengths.length;i++){ const L=bp.binLengths[i];
      if (L>0){ used++; total+=L; prod += L*(L-1)/2; if (L>maxBin) maxBin=L; } } }
    const A = rp.cars.filter(c=>c.ai);
    return {
      clk: +S.raceClock.toFixed(2), steps: rp.stepCount, stepMs: +(rp.__ms||0).toFixed(1),
      acc: +(rp.acc||0).toFixed(4), contacts: w.contacts.length, bodies: w.bodies.length,
      maxBin: maxBin, binsUsed: used, bodiesInBins: total, binPairs: prod,
      ai: A.map(c=>+c.speedKmh.toFixed(0)).join('/'),
      aicp: A.map(c=>c.cpIdx).join('/'),
      aioff: A.map(c=>(c.offRoad||0).toFixed(2)).join('/'),
      ainear: A.map(c=>{ // 每台 AI 周围 20m 内的静态刚体数（护栏密度）
        let n=0; for (const b of rp.staticBodies){ const dx=b.position.x-c.pos.x, dz=b.position.z-c.pos.z;
          if (dx*dx+dz*dz < 400) n++; } return n; }).join('/'),
      drawCalls: (document.getElementById('dbg')||{textContent:''}).textContent.match(/drawCalls=(\\d+)/)?.[1] || '-',
      tris: (document.getElementById('dbg')||{textContent:''}).textContent.match(/tris=(\\d+)/)?.[1] || '-',
      fog: rp.cars.filter(c=>c.remote).length,
    };
  })()`);

  const grab = async (label, secs) => {
    await cdp.send('Profiler.setSamplingInterval', { interval: 150 });
    await cdp.send('Profiler.start');
    await sleep(secs * 1000);
    const { profile } = await cdp.send('Profiler.stop');
    const agg = aggregate(profile);
    console.log('\n===== ' + label + ' 窗口（' + secs + 's, 采样总时长 ' + agg.totalMs.toFixed(0) + 'ms）=====');
    for (const r of agg.rows.slice(0, 14)) {
      console.log('  ' + r.ms.toFixed(0).padStart(6) + 'ms ' + r.pct.toFixed(1).padStart(5) + '%  ' + r.fn + '  @' + r.where);
    }
    return agg;
  };

  console.log('\n--- 起步后即刻 ---');
  const early = await cdp.eval('(window.__fr.length=0, window.__steps=0, 0)');
  await grab('早', 3);

  // 等掉帧（连续 3 帧 >33ms）
  console.log('\n等掉帧发生（最多 ' + (WAIT_SLOW_MS / 1000) + 's）…');
  let sawSlow = false;
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_SLOW_MS) {
    await sleep(400);
    const st = await cdp.eval('(() => { const f=window.__fr; if (f.length<8) return null; const t=f.slice(-6); return t.filter(x=>x[0]>33).length; })()');
    if (st >= 3) { sawSlow = true; break; }
  }
  console.log(sawSlow ? '已进入掉帧状态' : '（等待期内没触发，照样采样）');
  const before = await snap();
  console.log('掉帧时快照: ' + JSON.stringify(before));
  await grab('晚（掉帧中）', 3);
  await cdp.eval('window.__fr.length = 0; true');
  await sleep(1500);
  const after = await snap();
  console.log('采样后再拍: ' + JSON.stringify(after));

  const fr = await cdp.eval('window.__fr.slice(0,5000)');
  const iv = fr.map((x) => x[0]).filter((x) => x > 0.5 && x < 5000).sort((a, b) => a - b);
  const q = (p) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] : null);
  console.log('\n掉帧窗口帧间隔 p50/p90/max = ' + q(0.5) + ' / ' + q(0.9) + ' / ' + iv[iv.length - 1] + ' ms');

  // ---- cannon 各层直接计时（把"到底哪一层在烧 CPU"钉成数字）-----------------
  const bench = await cdp.eval(`(() => {
    const S = window.__S, w = S.rp.world;
    const cm = w.collisionMatrix, cmPrev = w.collisionMatrixPrevious;
    const rep = (n, fn) => { const t = performance.now(); for (let k = 0; k < n; k++) fn(); return +((performance.now() - t) / n).toFixed(3); };
    const out = {
      bodies: w.bodies.length,
      matrixIsArray: Array.isArray(cm.matrix),
      matrixLen: cm.matrix.length,
      matrixPrevLen: cmPrev.matrix.length,
      matrixOwnKeys: (cm.matrix && typeof cm.matrix === 'object') ? Object.keys(cm.matrix).length : -1,
    };
    out.resetMs = rep(20, () => cm.reset());
    out.tickMs = rep(20, () => w.collisionMatrixTick());
    const p1 = [], p2 = [];
    out.broadphaseMs = rep(10, () => { p1.length = 0; p2.length = 0; w.broadphase.collisionPairs(w, p1, p2); });
    out.pairCount = p1.length;
    out.pairCountAfterDedupe = p1.length;
    // 单步 physics 全链
    out.oneStepMs = rep(5, () => S.rp.fixedStep(1 / 60));
    return out;
  })()`);
  console.log('cannon 分层计时: ' + JSON.stringify(bench));

  const exc = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const uniq = [...new Set(exc.map((e) => String((e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text).split('\n')[0]))];
  console.log('运行期异常: ' + exc.length + ' 次 / ' + uniq.length + ' 种');
  uniq.slice(0, 5).forEach((u) => console.log('  * ' + u.slice(0, 180)));
  console.log('dbg 面板:\n' + await cdp.eval('(document.getElementById("dbg")||{textContent:"(无)"}).textContent'));
  writeFileSync('hotspot-report.json', JSON.stringify({ early, before, after, fr: fr.slice(0, 800) }, null, 2));
} catch (e) {
  console.error('定位失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
