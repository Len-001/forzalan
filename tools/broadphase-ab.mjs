/* =============================================================================
 * 宽相（broadphase）A/B 实测台
 *
 * 背景：出厂 forzalan.exe 用的是 NaiveBroadphase + 2963 个静态护栏刚体，
 * 每物理步 ~440 万对 AABB 检测 —— 实测帧间隔 p50 = 133ms（7.5fps），
 * CPU 采样 89.5% 落在 cannon-es 的 collisionPairs。
 *
 * 本工具在**真机浏览器**里把 world.broadphase 依次换成不同实现，逐相位测同一
 * 段赛道上的帧间隔与物理步耗时，用数字挑出该用哪个，而不是靠猜。
 *
 * 用法： node tools/broadphase-ab.mjs            # 对 forzalan.exe（出厂版）跑
 *        DIAG_EXE=forzalan.exe node tools/broadphase-ab.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.AB_PORT || 8099);
const CDP_PORT = Number(process.env.AB_CDP_PORT || 9337);
const PHASE_MS = Number(process.env.AB_PHASE_MS || 2500);
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
}

const srv = spawn(EXE, ['-addr', ':' + PORT, '-quiet'], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1500);
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome'); srv.kill(); process.exit(1); }
const child = spawn(browser, [
  '--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ab-cdp-'))}`,
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__frames=[];const _r=window.requestAnimationFrame.bind(window);let _p=0;
      window.requestAnimationFrame=(cb)=>_r((ts)=>{const t0=performance.now();try{cb(ts);}finally{
      const f=window.__frames;if(f.length<200000)f.push([+(ts-_p).toFixed(2),+(performance.now()-t0).toFixed(2)]);_p=ts;}});`,
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1` });
  await sleep(2500);

  for (let i = 0; i < 120; i++) {
    try { if (await cdp.eval('!!(window.__S && window.__S.rp && window.__S.rp.racing)')) break; } catch (_) { /* wait */ }
    await sleep(500);
  }

  // 取 cannon 模块（动态 import：CSP 允许 'self'，模块已在缓存）
  await cdp.eval(`(async () => { window.__M = await import('/libs/cannon-es.js'); return true; })()`);
  // 物理步耗时探针
  await cdp.eval(`(() => {
    const proto = Object.getPrototypeOf(window.__S.rp);
    if (!proto.__abPatched) { proto.__abPatched = true;
      const s = proto.step;
      proto.step = function (dt) { const t0 = performance.now(); s.call(this, dt); this.__ms = performance.now() - t0; };
    }
    return true;
  })()`);

  const extent = await cdp.eval(`(() => {
    const bs = window.__S.rp.world.bodies;
    let x0=1e9,y0=1e9,z0=1e9,x1=-1e9,y1=-1e9,z1=-1e9;
    for (const b of bs) { const a=b.aabb; b.updateAABB && (b.updateAABB(), 0);
      const lo=a.lowerBound, up=a.upperBound;
      x0=Math.min(x0,lo.x); y0=Math.min(y0,lo.y); z0=Math.min(z0,lo.z);
      x1=Math.max(x1,up.x); y1=Math.max(y1,up.y); z1=Math.max(z1,up.z); }
    return { x0:+x0.toFixed(1), y0:+y0.toFixed(1), z0:+z0.toFixed(1), x1:+x1.toFixed(1), y1:+y1.toFixed(1), z1:+z1.toFixed(1), n: bs.length,
             cur: window.__S.rp.world.broadphase.constructor.name };
  })()`);
  console.log('世界 AABB 范围 / 刚体数 / 当前宽相:');
  console.log('  ' + JSON.stringify(extent));

  const pad = 20;
  const M = { x0: extent.x0 - pad, x1: extent.x1 + pad, y0: extent.y0 - pad, y1: extent.y1 + pad, z0: extent.z0 - pad, z1: extent.z1 + pad };
  const spanX = M.x1 - M.x0, spanZ = M.z1 - M.z0, spanY = M.y1 - M.y0;
  // 与 physics.js 的 makeGridBroadphase 同口径：格子边长 → nx/ny/nz
  const cells = (cxz, cy) => [
    Math.max(8, Math.round(spanX / cxz)),
    Math.max(2, Math.round(spanY / cy)),
    Math.max(8, Math.round(spanZ / cxz)),
  ];
  const grid = (cxz, cy) => {
    const [nx, ny, nz] = cells(cxz, cy);
    return `new M.GridBroadphase(new M.Vec3(${M.x0},${M.y0},${M.z0}), new M.Vec3(${M.x1},${M.y1},${M.z1}), ${nx}, ${ny}, ${nz})`;
  };
  console.log('  包围盒 ' + spanX.toFixed(0) + '×' + spanY.toFixed(0) + '×' + spanZ.toFixed(0) + 'm');

  const phases = [
    ['grid 40m 格（当前默认）', grid(40, 25)],
    ['grid 30m 格', grid(30, 25)],
    ['grid 20m 格', grid(20, 25)],
    ['grid 15m 格', grid(15, 25)],
    ['grid 10m 格', grid(10, 40)],
    ['grid 20m 格 / y=40m', grid(20, 40)],
    ['SAP（对照）', 'new M.SAPBroadphase(w)'],
  ];

  const results = [];
  for (const [name, ctor] of phases) {
    try {
      const swap = await cdp.eval(`(() => {
        const M = window.__M, w = window.__S.rp.world;
        const bp = ${ctor};
        if (bp instanceof M.SAPBroadphase) bp.axisIndex = 0;
        w.broadphase = bp;
        return bp.constructor.name + ' bins=' + (bp.bins ? bp.bins.length : '-') + ' nx=' + bp.nx;
      })()`);
      await sleep(400);
      await cdp.eval('window.__frames.length = 0; true');
      const t0 = Date.now();
      await sleep(PHASE_MS);
      const st = await cdp.eval(`(() => {
        const f = window.__frames || [];
        const iv = f.map(x => x[0]).filter(x => x > 0.5 && x < 5000).sort((a,b)=>a-b);
        const js = f.map(x => x[1]).sort((a,b)=>a-b);
        const q = (arr,p) => arr.length ? arr[Math.min(arr.length-1, Math.floor(p*arr.length))] : null;
        const S = window.__S, w = S.rp.world;
        // 宽相直接计时（不受帧率噪声影响）：平均一次 collisionPairs 的耗时与候选对数
        const pA = [], pB = [];
        const t0 = performance.now();
        for (let k = 0; k < 10; k++) { pA.length = 0; pB.length = 0; w.broadphase.collisionPairs(w, pA, pB); }
        const bpMs = (performance.now() - t0) / 10;
        return {
          n: iv.length, p50: q(iv,0.5), p90: q(iv,0.9), max: iv[iv.length-1],
          fps: iv.length ? +(1000/(iv.reduce((a,b)=>a+b,0)/iv.length)).toFixed(1) : null,
          js50: q(js,0.5),
          stepMs: +(S.rp.__ms || 0).toFixed(2),
          bpMs: +bpMs.toFixed(2), pairs: pA.length,
          contacts: w.contacts.length, pairs_name: w.broadphase.constructor.name,
          ai: S.rp.cars.filter(c=>c.ai).map(c=>+c.speedKmh.toFixed(0)).join('/'),
          lap0: S.rp.cars.filter(c=>c.ai).map(c=>c.cpIdx).join('/'),
        };
      })()`);
      st.name = name; st.ctor = swap; st.wallMs = Date.now() - t0;
      results.push(st);
      console.log('  ' + name.padEnd(24) + ' | ' + String(st.ctor).padEnd(30) +
        ' | p50 ' + String(st.p50).padStart(7) + 'ms fps ' + String(st.fps).padStart(5) +
        ' | 宽相 ' + String(st.bpMs).padStart(6) + 'ms/次  候选对 ' + String(st.pairs).padStart(6) +
        ' | 真实重叠对 ' + st.contacts + ' | ai ' + st.ai);
    } catch (e) {
      console.log('  ' + name + ' 失败：' + e.message);
      results.push({ name, error: e.message });
    }
  }

  const exc = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const uniqExc = [...new Map(exc.map((e) => {
    const d = e.params.exceptionDetails;
    const txt = (d.exception && d.exception.description) || d.text || '';
    return [txt, { txt, url: d.url, line: d.lineNumber }];
  })).values()];
  console.log('\n运行期异常数: ' + exc.length + '（去重 ' + uniqExc.length + ' 种）');
  for (const e of uniqExc.slice(0, 6)) console.log('  * ' + e.txt.replace(/\n/g, '\n    ').slice(0, 400));

  writeFileSync('broadphase-ab.json', JSON.stringify({ extent, results }, null, 2));
  console.log('结果 -> broadphase-ab.json');
} catch (e) {
  console.error('A/B 失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
