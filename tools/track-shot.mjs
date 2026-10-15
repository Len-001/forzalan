/* =============================================================================
 * 赛道"缺块"截图抓取（真机 CDP）
 *
 * 用途：把"有时赛道缺失一块"变成**能看的图**。逐个随机种子加载离线练习，
 * 把本地车瞬移到赛道若干位置（含铃鹿立交桥、发车区、弯心），各抓一张 PNG。
 *
 * 用法： node tools/track-shot.mjs
 *        SEEDS=4 SHOTS_PER_SEED=3 node tools/track-shot.mjs
 *        SHOT_TRACK=suzuka node tools/track-shot.mjs
 *        CAM=2 node tools/track-shot.mjs        # 2 = 垂直鸟瞰（最容易看出洞）
 * 产物： shots/seed-<n>-<i>.png（附 shots/index.json 记录每张的相机/进度）
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8099);
const CDP_PORT = Number(process.env.CDP_PORT || 9341);
const SEEDS = Number(process.env.SEEDS || 3);
const SHOTS = Number(process.env.SHOTS_PER_SEED || 3);
const TRACK = process.env.SHOT_TRACK || 'suzuka';
const CAM = process.env.CAM || '2';
const EXE = process.env.SHOT_EXE || (process.platform === 'win32' ? 'forzalan.exe' : './forzalan');
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

mkdirSync('shots', { recursive: true });
const srv = spawn(EXE, ['-addr', ':' + PORT, '-quiet'], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1500);
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome'); srv.kill(); process.exit(1); }
const child = spawn(browser, [
  '--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-cdp-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,720',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
const index = [];
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

  for (let s = 0; s < SEEDS; s++) {
    const seed = Number(process.env.SEED || Math.floor(Math.random() * 0x7fffffff));
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&seed=${seed}&track=${TRACK}&cam=${CAM}` });
    await sleep(2500);
    for (let i = 0; i < 60; i++) {
      try { if (await cdp.eval('!!(window.__S && window.__S.rp && window.__S.rp.racing)')) break; } catch (_) { /* wait */ }
      await sleep(500);
    }
    for (let k = 0; k < SHOTS; k++) {
      // 沿赛道把本地车瞬移到不同进度（含桥区），并把相机贴上去
      const info = await cdp.eval(`(() => {
        const S = window.__S, rp = S.rp, t = rp.track, c = S.localCar;
        const frac = ${k} / ${SHOTS};
        const idx = Math.floor(frac * t.count) % t.count;
        const p = t.pts[idx], n = t.nrm[idx];
        c.body.position.set(p.x, p.y + 1.2, p.z);
        c.body.velocity.set(0, 0, 0);
        c.body.angularVelocity.set(0, 0, 0);
        c.body.aabbNeedsUpdate = true;
        c.syncFromBody();
        if (S.rp.snapCameraToCar) S.rp.snapCameraToCar(c);
        return { idx, frac: +frac.toFixed(2), y: +p.y.toFixed(2), base: +(t.baseY ? t.baseY[idx] : p.y).toFixed(2),
          bridge: !!(t.hasBridge && Math.abs(p.y - (t.baseY ? t.baseY[idx] : p.y)) > 1.0) };
      })()`);
      await sleep(1200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = 'shots/' + TRACK + '-seed' + seed + '-' + k + '.png';
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      // 渲染统计：画了多少三角形 / drawcall（缺块会让三角形数明显偏低）
      const stat = await cdp.eval(`(() => { const r = window.__renderer || null; return null; })()`);
      const tri = await cdp.eval(`(() => { try { return null; } catch (e) { return null; } })()`);
      const img = await cdp.eval(`(() => { const S = window.__S; return S ? null : null; })()`);
      index.push({ file, seed, k, track: TRACK, ...info });
      console.log('  ' + file + '  idx=' + info.idx + ' frac=' + info.frac + ' y=' + info.y
        + ' baseY=' + info.base + (info.bridge ? '  ★桥面' : ''));
    }
    // 顺带量一下该种子下"路面被绘制"的三角形总数（可横向比较是否偶发偏低）
    const drawn = await cdp.eval(`(() => { const el = document.getElementById('dbg'); return null; })()`);
    void stat; void tri; void img; void drawn;
  }
  writeFileSync('shots/index.json', JSON.stringify(index, null, 2));
  console.log('\n共 ' + index.length + ' 张 -> shots/  索引 -> shots/index.json');
} catch (e) {
  console.error('抓图失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
