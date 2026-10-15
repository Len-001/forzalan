/* =============================================================================
 * 单机（人机对战）完整赛程验收（用户报障："与人机对战完赛后全员已冲线但显示未完赛"）
 *
 * 做法：真机跑一整场「1 圈铃鹿 · 3 台 AI」，本地车也交给 AI 开（car.auto=true，
 * 与 main.js 给 AI 车用的是同一开关），等到结算产生，然后把**结算数据源**摊开看：
 *   S.settlement[] 里的 fin / dnf / lap / net，以及 pages 上真正的 DOM 文案。
 * 这样"全员冲线却显示未完赛"到底是 physics 的 finished 没置位、还是结算/展示判据
 * 写错，一眼就能分清。
 * ========================================================================== */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// 项目根 = 本文件所在目录的上一级（此前硬编码了开发者本机绝对路径，换机即 ENOENT）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8092, CDP = 9352;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAPS = Number(process.env.LAPS || 1);
const TRACK = process.env.TRACK || 'suzuka';

const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'], { cwd: root, stdio: 'ignore' });
await sleep(1500);
const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const fsEdge = await import('node:fs');
const edge = edgeCandidates.find((p) => { try { return fsEdge.existsSync(p); } catch { return false; } });
const child = spawn(edge,
  ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-ai-'))}`,
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const waits = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const pg = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pg) {
      ws = new WebSocket(pg.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    }
  } catch (_) { /* retry */ }
  if (!ws) await sleep(200);
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
});
const send = (me, p = {}) => new Promise((res, rej) => {
  const i = ++id; waits.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: me, params: p }));
  setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error('t/o ' + me)); } }, 120000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(3000);

let fail = 0;
const ok = (c, n, d = '') => { if (c) console.log('  PASS ' + n + (d ? '   ' + d : '')); else { fail++; console.log('  FAIL ' + n + '   ' + d); } };

// 设圈数/赛道后开单机。
// ⚠️ 开机与 beginRace 都是异步的：固定等 3s/1.5s 在慢机器（软件渲染无头）上
// 会取不到 btnSolo / __S.rp，整场误判为 t=0。改成轮询等待（各给 20s 上限）。
const waitFor = async (expr, timeoutMs = 20000, everyMs = 300) => {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    try { if (await ev(expr)) return true; } catch (_) { /* retry */ }
    await sleep(everyMs);
  }
  return false;
};
await waitFor(`!!document.getElementById('btnSolo')`);
await ev(`(() => { const l = document.getElementById('laps'); if (l) l.value = '${LAPS}';
  const t = document.getElementById('track'); if (t) t.value = '${TRACK}'; return true; })()`);
await ev(`(() => { const b = document.getElementById('btnSolo'); b.click(); return true; })()`);
console.log('  已开单机：' + TRACK + ' · ' + LAPS + ' 圈 · 3 台 AI');
// 本地车也交给 AI（测试专用），否则无头下没人踩油门
const hooked = (await waitFor(`(() => {
  const S = window.__S; if (!S || !S.rp || !S.localCar) return false;
  S.localCar.auto = true; return true;
})()`)) ? 'ok' : 'no-state';
console.log('  本地车交 AI 驾驶：' + hooked);
ok(hooked === 'ok', '拿到页面状态并接管本地车');

// 等结算（1 圈 ≈ 3 分钟 + 起跑 8.75s，给足余量）
const t0 = Date.now();
let settled = false, snap = null;
const DEADLINE = Number(process.env.WAIT_MS || 420000);
while (Date.now() - t0 < DEADLINE) {
  await sleep(4000);
  snap = await ev(`(() => {
    const S = window.__S; if (!S) return null;
    const cars = S.rp ? Array.from(S.rp.byId.values()).map((c) => ({
      id: c.id, name: c.name, ai: !!c.ai, auto: !!c.auto, finished: !!c.finished,
      retired: !!c.retired, lap: c.lap, laps: c.laps, pen: +c.penalty.toFixed(2),
      net: c.finishTime ? +c.finishTime.toFixed(2) : null, total: c.totalTime ? +c.totalTime.toFixed(2) : null,
    })) : [];
    return { t: +(S.rp ? S.rp.time : 0).toFixed(1), offline: !!S.offline, settled: !!S._offlineSettled,
      laps: S.laps, clock: S.raceClock, cars,
      settlement: (S.settlement || []).map((r) => ({ name: r.name, fin: !!r.fin, dnf: !!r.dnf, lap: r.lap, net: r.net, rank: r.rank })),
      settlementShown: !document.getElementById('settlement').classList.contains('hidden'),
      resultRows: Array.from(document.querySelectorAll('#results tbody tr')).map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim()) };
  })()`);
  console.log('   t=' + (snap && snap.t) + 's  ' + (snap ? snap.cars.map((c) => c.name + ' lap' + c.lap + '/' + c.laps + (c.finished ? '完赛' : c.retired ? '退赛' : '')).join(' | ') : ''));
  if (snap && snap.settled) { settled = true; break; }
}

ok(!!snap, '拿到页面快照');
ok(settled, '单机比赛产生结算（' + LAPS + ' 圈内）', 't=' + (snap && snap.t) + 's');
if (snap) {
  console.log('\n  结算数据（S.settlement）：');
  for (const r of snap.settlement) {
    console.log('    名次' + r.rank + '  ' + r.name + '  fin=' + r.fin + ' dnf=' + r.dnf + ' lap=' + r.lap + ' net=' + (r.net === null ? 'null' : r.net.toFixed(2)));
  }
  const ai = snap.settlement.filter((r) => /^AI/.test(r.name));
  ok(ai.length >= 3 && ai.every((r) => r.fin && !r.dnf && r.net > 0),
    '3 台 AI 冲线即记为已完赛（fin=true / 有净用时）',
    ai.map((r) => r.name + ':' + (r.net !== null ? r.net.toFixed(1) : 'null')).join(' '));

  // ★ 核心复现：本地车在 DNF 宽限到点后才冲线 —— 之前它会永远停在"未完赛"。
  //   用 `S.rp.finishCar(localCar)` 触发：这就是"车压过终点线"内部走的同一个调用。
  const late = await ev(`(() => {
    const S = window.__S;
    const c = S.localCar; if (!c) return { ok: false };
    const before = { fin: !!c.finished, ret: !!c.retired };
    S.rp.finishCar(c);                       // 模拟"之后才冲过终点线"
    return { ok: true, before, after: { fin: !!c.finished, ret: !!c.retired } };
  })()`);
  ok(late && late.ok, '能触发"结算之后才冲线"', JSON.stringify(late));
  await sleep(1200);
  const after = await ev(`(() => {
    const S = window.__S;
    return {
      settlement: (S.settlement || []).map((r) => ({ name: r.name, fin: !!r.fin, dnf: !!r.dnf, net: r.net })),
      settleRows: Array.from(document.querySelectorAll('#settleBody .stl-row')).map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
      resultRows: Array.from(document.querySelectorAll('#results tbody tr')).map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
    };
  })()`);
  console.log('\n  迟到冲线后 S.settlement：');
  for (const r of after.settlement) console.log('    ' + r.name + ' fin=' + r.fin + ' dnf=' + r.dnf + ' net=' + (r.net === null ? 'null' : r.net.toFixed(2)));
  const me = after.settlement.find((r) => r.name === snap.settlement.find((x) => !/^AI/.test(x.name)).name);
  ok(me && me.fin && !me.dnf, '★迟到冲线的车刷新为已完赛（不再停在"未完赛"）',
    me ? (me.name + ' fin=' + me.fin + ' dnf=' + me.dnf + ' net=' + (me.net === null ? 'null' : me.net.toFixed(2))) : '未找到');
  const texts = (after.settleRows || []).concat(after.resultRows || []);
  const bad = texts.filter((s) => /未完赛|DNF/.test(s));
  ok(bad.length === 0, '★界面不再出现"未完赛/DNF"（全员冲线后）',
    bad.length ? JSON.stringify(bad.slice(0, 3)) : '无');
  console.log('\n  界面行：' + JSON.stringify(texts));
}

writeFileSync('ai-race.json', JSON.stringify({ snap }, null, 2));
console.log('\n明细 -> ai-race.json');
try { child.kill(); } catch (_) { /* ignore */ }
try { srv.kill(); } catch (_) { /* ignore */ }
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
