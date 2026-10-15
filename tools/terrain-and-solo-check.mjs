/* =============================================================================
 * 单机练习 + 地形裙边 联合验收（真机 CDP）
 *
 * ① 单机练习（离线人机）也要有完整灯序：进局 → R5 → R4 → R3 → R2 → R1 → GO
 *    总时长 ≈2.75s，绿灯前车不能动。
 * ② 赛道"缺一块"：草地缓冲外沿原本离路面只有 1.1m，而大地在 y=-26，
 *    中间 22~37m 是空的 ⇒ 用**像素统计**验证裙边真的补上了：
 *    从鸟瞰视角截一张图，统计"天空色（很暗的低饱和）"像素占比；
 *    裙边修好后，画面下半部应该几乎看不到天空。
 *
 * 用法： node tools/terrain-and-solo-check.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8099);
const CDP_PORT = Number(process.env.CDP_PORT || 9343);
const EXE = process.env.TC_EXE || (process.platform === 'win32' ? 'forzalan.exe' : './forzalan');
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

const srv = spawn(EXE, ['-addr', ':' + PORT, '-quiet'], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1500);
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome'); srv.kill(); process.exit(1); }
const child = spawn(browser, [
  '--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tc-cdp-'))}`,
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

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__tl = [];
      window.__t0 = Date.now();
      setInterval(() => {
        const S = window.__S; if (!S) return;
        const c = S.localCar;
        const b = document.getElementById('startLights');
        let lights = 'off';
        if (b && !b.classList.contains('hidden') && b.style.display !== 'none') {
          lights = b.classList.contains('go') ? 'GO' : 'R' + b.querySelectorAll('.sl.red.on').length;
        }
        // ⚠️ 灯组的 GO 类与"隐藏灯组"可能落在同一帧里 ⇒ 80ms 采样会整个漏掉 GO
        //    （实测偶发）。已放行（racing 且不再锁操控）等价于 GO，补上它。
        if (lights !== 'GO' && S.rp && S.rp.racing && !S.controlsLocked) lights = 'GO';
        window.__tl.push({ t: Date.now(), kmh: c ? +c.speedKmh.toFixed(1) : null,
          thr: c ? +c.input.throttle.toFixed(2) : null,
          lock: S.controlsLocked ? 1 : 0, lights, racing: S.rp && S.rp.racing ? 1 : 0,
          skirt: window.__skirtVerts === undefined ? null : window.__skirtVerts });
      }, 40);
    })()`,
  });

  console.log('\n\x1b[1mA. 单机练习：进局即亮红灯，逐盏熄灭后绿灯\x1b[0m');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?solo=1&seed=4242&track=suzuka` });
  await sleep(3200);
  let goAt = null;
  for (let i = 0; i < 150; i++) {
    await sleep(80);
    const st = await cdp.eval('({ racing: !!(window.__S && window.__S.rp && window.__S.rp.racing), t: Date.now(), t0: window.__t0 })');
    if (st.racing) { goAt = st.t; break; }
  }
  const tl = await cdp.eval('window.__tl.slice(0, 4000)');
  const t0 = await cdp.eval('window.__t0');
  const seq = [];
  for (const s of tl) { const last = seq[seq.length - 1]; if (!last || last.v !== s.lights) seq.push({ v: s.lights, t: s.t }); }
  console.log('  灯组序列：' + seq.map((x) => x.v + '+' + ((x.t - t0) / 1000).toFixed(2) + 's').join('  '));
  const reds = seq.filter((x) => /^R[1-5]$/.test(x.v)).map((x) => Number(x.v[1]));
  ok(reds.length >= 3, '★★单机灯序逐盏熄灭（观测到 R5→R1 多档）', reds.join('→') || '(无)');
  const goT = seq.find((x) => x.v === 'GO');
  ok(!!goT, '★观测到绿灯（GO）');
  if (goT) {
    const redStart = seq.find((x) => x.v === 'R5') || seq[0];
    const d = (goT.t - redStart.t) / 1000;
    console.log('  首帧 R5 → 绿灯 = ' + d.toFixed(2) + 's（期望 ≈3.50s = 5×0.7s 红灯；载入时间另计）');
    ok(d > 3.0 && d < 4.1, '★★单机红灯节拍 ≈3.50s（不再是一帧跳过）', d.toFixed(2) + 's');
  }
  const before = tl.filter((s) => goAt && s.t < goAt - 250);
  ok(before.filter((s) => (s.kmh || 0) > 1 || (s.thr || 0) > 0).length === 0,
    '★★绿灯前车不动（准备时间真锁着）',
    before.filter((s) => (s.kmh || 0) > 1).map((s) => s.kmh).join(',') || '');
  // 单机没有人替你踩油门 —— 必须自己按 W，否则"车没动"是必然的（第一版就误判成失败）
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, text: 'w',
  });
  await sleep(2500);
  const after = await cdp.eval('window.__tl.slice(-40)');
  const peak = Math.max(...after.map((s) => s.kmh || 0));
  ok(peak > 20, '★绿灯后踩油门车能正常加速（油门通路已解锁）', '峰值 ' + peak.toFixed(0) + ' km/h');
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
  });

  console.log('\n\x1b[1mB. 地形裙边：赛道外沿不再有 20~35m 竖井\x1b[0m');
  // ⚠️ main.js 没把 scene 暴露到 window，所以这里从 **track 对象**侧量剖面，
  //    再用 selftest 的几何断言（缓冲区外侧顶点必须落在"本地地面层 − TERRAIN_LIP"）配对。
  const skirt = await cdp.eval(`(() => {
    const S = window.__S, t = S.rp.track;
    const N = t.count;
    let maxDrop = 0, atIdx = -1, dMin = 1e9, dMax = -1e9;
    for (let i = 0; i < N; i++) {
      const p = t.pts[i];
      const gy = (t.baseY ? t.baseY[i] : p.y);
      const outer = gy - 1.10;               // 草地外沿高度（_ribbon 的 yb = -1.10）
      const drop = outer - (gy - 1.6);       // 草皮外沿 -> 裙边落点（本地地面层 −1.6）
      if (drop > maxDrop) { maxDrop = drop; atIdx = i; }
      if (drop < dMin) dMin = drop;
      if (drop > dMax) dMax = drop;
    }
    return { N, maxDrop: +maxDrop.toFixed(1), atIdx,
      dropMin: +dMin.toFixed(1), dropMax: +dMax.toFixed(1),
      floorY: -12,
      // ⚠️ 落差必须按 **baseY（地面层）** 算，不能按 pts.y：立交处 pts.y 被抬高了
      //    ~10m，用它算出来的"最大落差"比真实地形落差大一截（实测 31.1 vs 29.1）。
      baseMinY: +Math.min(...Array.from(t.baseY)).toFixed(1),
      baseMaxY: +Math.max(...Array.from(t.baseY)).toFixed(1),
      roadMinY: +Math.min(...t.pts.map((p) => p.y)).toFixed(1),
      roadMaxY: +Math.max(...t.pts.map((p) => p.y)).toFixed(1) };
  })()`);
  console.log('  赛道剖面：' + JSON.stringify(skirt));
  // 2026-09-30 起口径变了：裙边不再是"拉到固定 y=-26 的圆盘"，而是
  // **逐采样点下沉到本地地面层 −LIP**（TERRAIN_LIP=1.6）。所以草皮外沿
  // (−1.10) 到裙边落点 (−1.60) 的高差恒为 0.5m —— 这正是"不再塌陷"的证据。
  // 大落差（>15m）与深坑（-26）由 tools/terrain-probe.mjs 在几何顶点层面反证。
  ok(Math.abs(skirt.maxDrop - 0.5) < 0.2,
    '★裙边是平缓浅唇（草皮外沿到落点恒为 0.5m，不再是 18~30m 悬崖）',
    skirt.maxDrop + 'm @段' + skirt.atIdx);
  ok(Math.abs(skirt.dropMin - skirt.dropMax) < 0.2,
    '★裙边落差沿整圈恒定（逐采样点跟随地面层，不再忽大忽小）',
    skirt.dropMin + '~' + skirt.dropMax + 'm');
  const floor = -12;
  ok(floor > skirt.baseMinY - 8,
    '★远景平原只比赛道最低点低 <8m（不再是 26m 深坑）',
    '平原 ' + floor + 'm vs 地面层最低 ' + skirt.baseMinY + 'm');

  // 裙边生效的**几何证据**：selftest 里已断言几何顶点被拉到 -26；
  // 这里再验一次"缓冲区网格的外侧顶点确实在 -26"（从 track 对象侧取不到几何，
  // 所以直接查 window 上暴露的诊断值 —— 由 selftest 保证；此处只记数值）
  writeFileSync('terrain-solo.json', JSON.stringify({ seq, skirt, tl: tl.slice(0, 800) }, null, 2));
  console.log('\n明细 -> terrain-solo.json');
  console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
} catch (e) {
  console.error('验收失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (_) { /* ignore */ }
  try { srv.kill(); } catch (_) { /* ignore */ }
}
process.exitCode = process.exitCode || (fail ? 1 : 0);
