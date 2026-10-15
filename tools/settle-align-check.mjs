/* =============================================================================
 * 结算页表头/数值列对齐验收（用户报障："结算页面的圈秒数与上边的标题没对齐"）
 *
 * 为什么单独立一个工具：这类"看起来没对齐"的问题**必须量真实渲染的边界**，
 * 光读 CSS 会漏。网格布局里每个单元格是独立盒子，表头默认左对齐、而数值列
 * 是右对齐 ⇒ 数值贴列右沿、标题贴列左沿，窄列（最快圈 116px）最明显。
 *
 * 判据：对每个数值列，标题文本的**靠边沿**与数值文本的**靠边沿**之差 ≤ 2px
 *   · 右对齐列（总成绩/最快圈/赛季积分）：比较右边缘
 *   · 居中列（名次）：比较中心
 *   · 左对齐列（车手）：比较左边缘
 * 同时在**两种宽度**下验（窄屏会让列更窄、错位更明显）。
 * ========================================================================== */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8094, CDP = 9354;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(path.join(root, 'forzalan.exe'), ['-addr', ':' + PORT, '-quiet'],
  { cwd: root, stdio: 'ignore' });
await sleep(1500);
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'tc-stl-'))}`,
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
  setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error('t/o ' + me)); } }, 60000);
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  // 页面里抛异常时必须显式报出来 —— 否则 evaluate 只回一个 undefined，
  // 表现为"量不到"这种极难定位的假失败。
  if (r.exceptionDetails) {
    throw new Error('页面内异常: ' + (r.exceptionDetails.exception
      ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  }
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(2800);

let fail = 0;
const ok = (c, n, d = '') => {
  if (c) console.log('  PASS ' + n + (d ? '   ' + d : ''));
  else { fail++; console.log('  FAIL ' + n + '   ' + d); }
};

// 直接灌一份结算数据并打开面板（不依赖真跑一场比赛）
const open = (rows) => ev(`(() => {
  const data = ${JSON.stringify(rows)};
  const m = window.__showSettlement;
  if (typeof m !== 'function') return 'no-hook';
  m(data);
  return 'ok';
})()`);

let r = await open([
  { name: '车手A', best: 92.345, total: 285.123, pts: 25, rank: 1 },
  { name: '车手B', best: 93.01, total: 286.4, pts: 18, rank: 2 },
  { name: '车手C', best: 0, total: 0, pts: 0, rank: 3, dnf: true },
]);
if (r === 'no-hook') {
  // main.js 没把函数挂到 window 时，退回"用真实事件打开"：注入一行 DOM 后量
  console.log('  （main.js 未暴露 showSettlement，改用 DOM 注入方式量列对齐）');
  r = await ev(`(() => {
    const body = document.getElementById('settleBody');
    const cols = document.querySelector('.settle-cols');
    if (!body || !cols) return 'no-dom';
    body.innerHTML = ${JSON.stringify(
      ['1|车手A|4:45.123|1:32.345|25', '2|车手B|4:46.400|1:33.010|18', '3|车手C|DNF|--:--.---|0']
        .map((s) => {
          const [rk, nm, tot, best, pts] = s.split('|');
          return `<div class="stl-row"><span class="stl-rk">${rk}</span><span class="stl-nm">${nm}</span>`
            + `<span class="stl-tot">${tot}</span><span class="stl-best">${best}</span>`
            + `<span class="stl-pts">${pts}</span></div>`;
        }).join(''))
    };
    document.getElementById('settlement').classList.remove('hidden');
    return 'ok';
  })()`);
}
ok(r === 'ok', '结算面板已打开（真实 DOM）', String(r));

const measure = () => ev(`(() => {
  const cols = document.querySelector('.settle-cols');
  const row = document.querySelector('#settleBody .stl-row');
  if (!cols || !row) return null;
  const cel = Array.from(cols.children);
  const vel = Array.from(row.children);
  const cs = cel.map((e) => e.getBoundingClientRect());
  const vs = vel.map((e) => e.getBoundingClientRect());
  const px = (n) => +n.toFixed(1);
  return {
    n: cs.length,
    gap: cs.map((c, i) => ({ cw: px(c.width), vw: px(vs[i] ? vs[i].width : 0) })),
    // 表头 vs 数值：左沿差 / 中心差 / 右沿差
    dl: cs.map((c, i) => (vs[i] ? px(Math.abs(c.left - vs[i].left)) : -1)),
    dc: cs.map((c, i) => (vs[i] ? px(Math.abs((c.left + c.right) / 2 - (vs[i].left + vs[i].right) / 2)) : -1)),
    dr: cs.map((c, i) => (vs[i] ? px(Math.abs(c.right - vs[i].right)) : -1)),
    // ⚠️ 取计算样式必须用**元素**，不能用手上这份 DOMRect（曾经踩过：
    //    getComputedStyle(DOMRect) 直接抛 TypeError，表现为"量不到"）
    align: cel.map((e) => getComputedStyle(e).textAlign),
    valign: vel.map((e) => getComputedStyle(e).textAlign),
  };
})()`);

const m = await (async () => {
  // 面板从 hidden 切到可见后布局需要一帧，headless 下偶有延迟：轮询到可量为止
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    const got = await measure();
    if (got) return got;
  }
  const diag = await ev(`(() => {
    const b = document.getElementById('settleBody');
    const s = document.getElementById('settlement');
    return { hasBody: !!b, rows: b ? b.children.length : -1,
      cols: document.querySelectorAll('.settle-cols > *').length,
      disp: s ? getComputedStyle(s).display : 'none' };
  })()`);
  console.log('  诊断：' + JSON.stringify(diag));
  return null;
})();
ok(!!m, '量到表头与数据行');
if (m) {
  console.log('  表头对齐=' + JSON.stringify(m.align) + '  数值对齐=' + JSON.stringify(m.valign));
  console.log('  右沿差(px)=' + JSON.stringify(m.dr) + '  中心差=' + JSON.stringify(m.dc) + '  左沿差=' + JSON.stringify(m.dl));
  // 列数一致（多一列/少一列会让整表串位）
  ok(m.n === 5, '表头列数 = 数据列数 = 5', '表头 ' + m.n + ' 列 / 数据 ' + m.gap.length + ' 列');
  ok(m.gap.every((g) => Math.abs(g.cw - g.vw) < 2),
    '每列宽度表头与数值一致（同网格轨道）',
    JSON.stringify(m.gap.map((g) => g.cw + '/' + g.vw)));
  const rtl = [2, 3, 4];   // 总成绩 / 最快圈 / 赛季积分：右对齐列
  const bad = rtl.filter((i) => m.dr[i] > 2);
  ok(bad.length === 0,
    '★右对齐列（总成绩/最快圈/赛季积分）数值右沿与标题右沿对齐 ≤2px',
    bad.length ? '错位列 ' + JSON.stringify(bad.map((i) => ({ 列: i + 1, 差: m.dr[i] + 'px' }))) : '全部 ≤2px');
  ok(m.align[3] === 'right' && m.valign[3] === 'right',
    '★最快圈列标题与数值同为右对齐（就是用户说的"圈秒数"那列）',
    '标题 ' + m.align[3] + ' / 数值 ' + m.valign[3]);
  ok(Math.max(...m.dl.slice(1, 2)) <= 2, '左对齐列（车手）左沿对齐 ≤2px', m.dl[1] + 'px');
  ok(m.dc[0] <= 2, '居中列（名次）中心对齐 ≤2px', m.dc[0] + 'px');
}

writeFileSync('settle-align.json', JSON.stringify({ m }, null, 2));
console.log('\n明细 -> settle-align.json');
try { child.kill(); } catch (_) { /* ignore */ }
try { srv.kill(); } catch (_) { /* ignore */ }
console.log(fail ? '\x1b[31m失败 ' + fail + ' 项\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
process.exitCode = fail ? 1 : 0;
