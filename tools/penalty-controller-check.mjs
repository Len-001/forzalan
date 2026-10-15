/* 裁决时序行为门禁 + 同工程 DOM/CSS 的真实 Edge 验收。 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { PenaltyController } from '../public/js/PenaltyController.js';

let passes = 0;
const check = (ok, label) => { assert.ok(ok, label); console.log('PASS ' + label); passes++; };
let now = 0, next = 1;
const timers = new Map();
const schedule = (fn, delay) => { const id = next++; timers.set(id, { fn, at: now + delay }); return id; };
const advance = target => {
  while (true) {
    const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    now = due[1].at; timers.delete(due[0]); due[1].fn();
  }
  now = target;
};
let mode = 'fm8';
const controller = new PenaltyController({ getMode: () => mode, clock: () => now, schedule, cancel: id => timers.delete(id) });
const wallController = new PenaltyController({ getMode: () => mode, clock: () => now, schedule, cancel: id => timers.delete(id) });
check(wallController.show('撞击', 0, 'wall') && wallController.phase === 'investigating' && wallController.active.sec === 0, '静态墙体无罚时但显示事故调查');
wallController.clear();
controller.show('造成碰撞', 0, 'ram');
advance(1200); controller.show('造成碰撞', 2.5, 'ram');
advance(2499); check(controller.phase === 'investigating', '2499ms 仍处于调查阶段');
advance(2500); check(controller.phase === 'verdict' && controller.active.sec === 2.5, '2500ms 裁决且升级罚时不会延长调查');
advance(5499); check(controller.phase === 'verdict', '裁决严格保持 3000ms');
advance(5500); check(controller.phase === 'leaving', '5500ms 开始上移淡出');
advance(5920); check(controller.phase === 'idle' && controller.active === null, '退出后销毁活动通知');
controller.show('frr_gain', 1.5, 'frr_gain');
controller.show('切弯获利', 3, 'cut');
check(controller.queue.length === 1, '不同事故排队保持时序');
mode = 'horizon'; controller.show('ram', 2, 'ram', mode);
check(controller.phase === 'idle' && controller.queue.length === 0 && timers.size === 0, 'Horizon 清除活动调查、队列和定时器');

/* ★ 反例回归（用户报障"罚时提示一直弹、弹不完"）：
 *   (a) 同一次违规有两条独立链路 —— 本地物理触发 + 服务端 `pen` 广播回显；
 *   (b) 同一个物理事故在不同链路用不同键名（frr_gain / offtrack / 偏离赛道）；
 *   (c) 持续压草皮/连续擦护栏会在几秒内塞爆待播队列（旧上限 8 ⇒ 近 50 秒连环弹窗）。
 *   修复前 (a) 会各弹一条、队列上限 8，(b) 会被当成两类事故，二者都会让提示连续弹出。 */
mode = 'fm8';
controller.clear();
controller.show('造成碰撞', 2, 'ram');
const activeBeforeEcho = controller.active;
advance(6000);
controller.show('造成碰撞', 2, 'ram');
check(controller.queue.length === 0 && controller.active === activeBeforeEcho && controller.active.sec === 2,
  '展示期间收到的同一次事故回显被原地合并，不新增队列项');
// 回显如果晚到（首条已进入退场阶段），同样不得再弹一条 —— 由同键冷却兜住。
advance(11600);  // 绝对时刻：首条已进入退场阶段（5920 + 2500 + 3000 = 11420）
const lateEchoPhase = controller.phase;
const lateEchoAccepted = controller.show('造成碰撞', 2, 'ram');
check(lateEchoPhase === 'leaving' && lateEchoAccepted === false && controller.queue.length === 0,
  `退场期收到的迟到回显被同键冷却忽略，不重复弹窗（phase=${lateEchoPhase}, accepted=${lateEchoAccepted}, queue=${controller.queue.length}）`);
advance(11840);  // 首条彻底退场
controller.show('frr_gain', 1.5, 'frr_gain');
advance(11990);
check(controller.show('偏离赛道', 2, 'offtrack') === true && controller.queue.length === 0 &&
  controller.active.sec === 2,
  'frr_gain / offtrack / 偏离赛道 归并为同一条并原地升级秒数');
advance(12050);
for (const k of ['cut', 'shortcut', 'rescue', 'wall', '碰撞']) controller.show(k, 1, k);
check(controller.queue.length <= 1, `待播裁决队列上限为 1（实际 ${controller.queue.length}）`);
controller.clear();
mode = 'horizon'; controller.show('ram', 2, 'ram', mode);
check(controller.phase === 'idle' && controller.queue.length === 0 && timers.size === 0,
  '队列收敛后 Horizon 仍能一键静默清空');

const root = resolve(import.meta.dirname, '..');
const publicRoot = join(root, 'public');
const server = createServer((req, res) => {
  try {
    let url = decodeURIComponent(new URL(req.url, 'http://test').pathname);
    const fixture = url === '/__ui_test__';
    if (fixture) url = '/index.html';
    const filename = resolve(publicRoot, '.' + url);
    if (!filename.startsWith(publicRoot)) { res.writeHead(403); res.end(); return; }
    let data = readFileSync(filename);
    if (fixture) data = Buffer.from(data.toString().replace('<script type="module" src="./js/main.js"></script>', ''));
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(filename)] || 'application/octet-stream');
    res.end(data);
  } catch (_) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const cdpPort = 9451;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--remote-debugging-port=' + cdpPort, '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'penalty-ui-')),
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });
let ws, serial = 0;
const pending = new Map(), errors = [];
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
try {
  for (let i = 0; i < 75 && !ws; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = pages.find(p => p.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); }); }
    } catch (_) { ws = null; }
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error('Edge CDP unavailable');
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.setItem("forza_lan_name", "存储昵称甲")' });
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/__ui_test__` });
  for (let i = 0; i < 50; i++) { if (await evaluate('document.getElementById("profileName")?.textContent === "存储昵称甲"')) break; await sleep(100); }
  check(await evaluate('document.getElementById("profileName").textContent === "存储昵称甲"'), '未建房前 Profile 已显示 LocalStorage 昵称');
  const css = await evaluate('(() => { const e = document.getElementById("minimap"), s = getComputedStyle(e); return { background:s.backgroundColor, blur:s.backdropFilter }; })()');
  check(css.background.includes('0.52') && css.blur.includes('blur'), '小地图半透明深灰背景与 backdrop-filter 已生效');
  check(await evaluate('!!document.getElementById("btnAddAI")'), '房间存在添加人机入口');
  await evaluate('(async () => { window.__penalty = await import("./js/PenaltyController.js"); window.__penalty.showPenaltyEvent("造成碰撞",0,"collision","fm8"); })()');
  await sleep(550);
  const first = await evaluate('(() => { const e=document.getElementById("frrBanner"); return {phase:e.dataset.phase,left:e.getBoundingClientRect().left,text:e.querySelector(".impact-label").textContent,spin:getComputedStyle(e.querySelector(".impact-loader")).animationTimingFunction}; })()');
  check(first.phase === 'investigating' && first.text === '撞击' && first.spin === 'linear', '顶部白胶囊含匀速旋转加载图标');
  await sleep(2120);
  const second = await evaluate('(() => { const e=document.getElementById("frrBanner"), v=e.querySelector(".impact-verdict"); return {phase:e.dataset.phase,dt:+e.dataset.verdictAt-+e.dataset.startedAt,text:v.textContent,color:getComputedStyle(v).backgroundColor,left:e.getBoundingClientRect().left}; })()');
  check(second.phase === 'verdict' && second.dt >= 2490 && second.dt < 2800, '真实浏览器约2500ms切换裁决');
  check(second.text === '无处罚' && second.color === 'rgb(0, 224, 116)', '无处罚色块精确为 #00E074');
  check(Math.abs(first.left - second.left) < 1, '胶囊左端固定，向右展开');
  await sleep(3400);
  const gone = await evaluate('(() => { const e=document.getElementById("frrBanner"); return {hidden:e.hidden,n:e.children.length,exit:+e.dataset.exitAt-+e.dataset.verdictAt}; })()');
  check(gone.hidden && gone.n === 0 && gone.exit >= 2990 && gone.exit < 3300, '真实裁决保持3秒后上移淡出并销毁子节点');
  await evaluate('window.__penalty.showPenaltyEvent("造成碰撞",2.5,"ram","fm8")');
  await sleep(2660);
  check(await evaluate('document.getElementById("impactVerdict").textContent === "+2.500s" && document.getElementById("frrBanner").classList.contains("penalized")'), '有处罚显示毫秒精度橙黄色块');
  await evaluate('window.__penalty.showPenaltyEvent("造成碰撞",1,"ram","horizon")');
  check(await evaluate('document.getElementById("frrBanner").hidden && document.getElementById("frrBanner").children.length === 0'), 'Horizon 在真实 DOM 中立即静默清空');
  check(errors.length === 0, '真实浏览器异常为零');
  console.log(JSON.stringify({ passes, timing: second.dt, verdict: gone.exit, errors }));
} finally {
  ws?.close(); browser.kill(); await new Promise(r => server.close(r));
}
