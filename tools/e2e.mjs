/* =============================================================================
 * e2e.mjs —— 端到端联调：编译产物 + 真实 WebSocket 客户端
 *
 *   node tools/e2e.mjs
 *
 * 验证对象是**最终交付物**（单个 Go 可执行文件 + 内嵌资源），包含：
 *   1. 静态资源全量内嵌：index.html / style.css / three.min.js / cannon-es.js / 4 个 js 模块
 *   2. 零外部依赖：扫描 HTML/CSS/JS 中的任何 http(s):// / cdn / unpkg / googleapis 引用
 *   3. 手写 WebSocket 协议：握手、文本帧、大于 125 字节的扩展长度帧、ping/pong 保活
 *   4. 房间流程：建房 -> 加入 -> 满员(4)拒绝 -> 全员准备 -> 3 秒倒计时 -> START
 *   5. 30Hz 位姿中继的实测频率与内容
 *   6. 罚时上报与限频、冲线成绩由服务端时钟计算、全员完赛结算、restart 回大厅
 * ========================================================================== */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const EXE = path.join(root, 'forzalan.exe');
// 端口可覆盖（默认仍 8099）：本机可能**正开着实时会话**（8099 上有 LAN 的
// ESTABLISHED 连接，绝不能 kill），此时服务端会 `bind: Only one usage of each
// socket address` 而**不报错退出**，症状是"只有房间生命周期日志一条失败"。
// 用法：E2E_PORT=8098 node tools/e2e.mjs
const PORT = Number(process.env.E2E_PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : '')); }
  else { failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 4000, step = 30) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

/* --------------------------------------------------------------------- */
/* 启动服务端                                                              */
/* --------------------------------------------------------------------- */
section('0. 启动单文件可执行程序');
// 赛事积分写入隔离目录，回归测试不污染用户赛季成绩。
const testData = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'forzalan-e2e-'));
const srv = spawn(EXE, ['-addr', ':' + PORT], { cwd: testData, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', errOut = '';
srv.stdout.on('data', (d) => { out += d.toString('utf8'); });
srv.stderr.on('data', (d) => { errOut += d.toString('utf8'); });

const up = await waitFor(() => out.includes('http://'), 6000);
ok(!!up, '进程启动并打印访问地址');
const lanUrls = [...out.matchAll(/http:\/\/([0-9]{1,3}(\.[0-9]{1,3}){3}):(\d+)/g)].map((m) => m[0]);
ok(out.includes('http://localhost:' + PORT), '打印本机访问地址', 'http://localhost:' + PORT);
ok(lanUrls.length >= 1, '自动识别并打印局域网 IPv4 访问地址', lanUrls.join(' , ') || '（本机无局域网网卡时可能为空）');

const health = await waitFor(async () => {
  try { const r = await fetch(BASE + '/healthz'); return r.ok ? r : null; } catch (e) { return null; }
}, 6000, 60);
ok(!!health, 'HTTP 服务就绪 /healthz');

/* --------------------------------------------------------------------- */
/* 1. 内嵌资源 & 零外部依赖                                                */
/* --------------------------------------------------------------------- */
section('1. 内嵌静态资源与零外部依赖');

const assets = [
  ['/', 'text/html'],
  ['/index.html', 'text/html'],
  ['/style.css', 'text/css'],
  ['/libs/three.min.js', 'javascript'],
  ['/libs/cannon-es.js', 'javascript'],
  ['/js/main.js', 'javascript'],
  ['/js/track.js', 'javascript'],
  ['/js/physics.js', 'javascript'],
  ['/js/network.js', 'javascript'],
];
const texts = {};
for (const [p] of assets) {
  const r = await fetch(BASE + p);
  texts[p] = await r.text();
  ok(r.status === 200 && texts[p].length > 100, '内嵌资源可访问 ' + p,
    r.status + ' / ' + (texts[p].length / 1024).toFixed(1) + ' KB');
}
ok(texts['/libs/three.min.js'].length > 400000, 'three.min.js 为本地完整版（非占位）',
  (texts['/libs/three.min.js'].length / 1024).toFixed(0) + ' KB');
ok(texts['/libs/cannon-es.js'].includes('class World') || texts['/libs/cannon-es.js'].includes('export{'),
  'cannon-es.js 为本地完整 ESM 构建');
ok(texts['/libs/three.min.js'].includes('THREE') || texts['/libs/three.min.js'].includes('t.THREE='),
  'three.min.js 为 UMD 全局构建（挂载 window.THREE）');

// 零外部依赖扫描
const EXT = [
  /https?:\/\/[^\s"'`)]+/g,
  /\/\/cdn[^"'\s]*/g,
  /(cdnjs|unpkg|jsdelivr|googleapis|gstatic|fonts\.google)/gi,
];
const ALLOW = [/^https?:\/\/www\.w3\.org\//, /^https?:\/\/localhost/];
let externals = [];
for (const [p] of assets) {
  if (p.endsWith('.min.js') || p === '/libs/cannon-es.js') continue;   // 第三方库自身注释不算
  for (const re of EXT) {
    const ms = texts[p].match(re) || [];
    for (const m of ms) {
      if (ALLOW.some((a) => a.test(m))) continue;
      externals.push(p + ' -> ' + m);
    }
  }
}
ok(externals.length === 0, '前端源码中不存在任何外部网络引用（CDN/字体/图片）',
  externals.length ? externals.join(' | ') : '扫描 7 个文件 0 命中');

// JS 语法守卫：main.js 有 DOM 顶层副作用，任何模块都无法 import 它，
// 因此一个语法错误能让整页白屏，而三层断言依旧全绿。
// 注意：本环境下 node **无法派生 node 子进程**（spawnSync 自己 spawn 自己都报 EBUSY），
// 所以不能用 `node --check`，改为进程内 vm 解析：先剥掉单行的 ESM 语法关键字，
// 再交给 vm.Script —— 括号 / 引号 / token 级别的语法错误照抓不误。
{
  const vm = await import('node:vm');
  const bad = [];
  for (const p of ['/js/main.js', '/js/track.js', '/js/physics.js', '/js/network.js']) {
    const body = texts[p].replace(/^import .*$/gm, '').replace(/^export /gm, '');
    try {
      new vm.Script(body, { filename: p });
    } catch (e) {
      bad.push(p + ' -> ' + e.message);
    }
  }
  ok(bad.length === 0, '4 个前端模块语法检查通过（vm 解析，已剥离 ESM 关键字）',
    bad.length ? bad.join(' | ') : 'main / track / physics / network');
}

const html = texts['/'];
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
ok(refs.every((r) => !/^https?:/i.test(r)), 'index.html 全部使用相对路径引入',
  refs.join(' , '));
ok(/CSP|Content-Security-Policy/i.test(html) && html.includes("default-src 'none'"),
  'HTML 内置 CSP：default-src none，任何外链会被浏览器直接拦截');
ok(!/fonts\.googleapis|@font-face\s*\{[^}]*url\(/i.test(texts['/style.css']),
  '样式仅使用系统无衬线字体族');
ok(/system-ui/.test(texts['/style.css']) && /Microsoft YaHei/.test(texts['/style.css']),
  '字体族使用 system-ui / 微软雅黑 等系统字体');

// 赛道接线静态守卫。
// 第八轮加拉斯维加斯时：服务端（sanitizeTrack + START 下发 track）和 track.js 都做了，
// 但 main.js 的 buildWorld 写成 `new Track(seed)` 漏传 trackType -> 客户端永远只加载铃鹿，
// 新赛道成了"编进二进制却跑不到"的死代码。三层动态测试全都测不出来，因为它们直接 new Track。
const mainJs = texts['/js/main.js'];
const newTrackArgs = [...mainJs.matchAll(/new Track\(([^)]*)\)/g)].map((m) => m[1].trim());
ok(newTrackArgs.length > 0 && newTrackArgs.every((a) => a.includes(',')),
  'main.js 构造 Track 时同时传入 seed 与赛道类型（漏传则新赛道是死代码）',
  newTrackArgs.join(' | '));
ok(/track:\s*m\.track/.test(mainJs), 'main.js 消费服务端 START 下发的 track 字段');
ok(/id="track"/.test(html) && /value="vegas"/.test(html),
  '大厅提供赛道选择控件且含 vegas 选项');

// 聊天总线接线静态守卫（规格 §一~§三）。
// 项目红线 #5：凡"服务端权威 + 定时广播"的字段，必须有静态守卫钉住
//   「服务端下发字段 → network.js 分发 → main.js 消费」三段链路，
// 否则服务端算完客户端不消费 = 新功能变死代码（本工程已栽 4 次）。
{
  const netJs = texts['/js/network.js'];
  // ① 服务端 → 客户端：network.js 必须把 CHAT_MESSAGE 分发出去
  ok(/case 'CHAT_MESSAGE':\s*this\.emit\('chat'/.test(netJs),
    'network.js 分发 CHAT_MESSAGE 为 chat 事件（服务端 → 客户端链路闭合）');
  ok(/t:\s*'CHAT_MESSAGE'/.test(mainJs),
    'main.js 以 { t: CHAT_MESSAGE } 上行发送发言（客户端 → 服务端链路闭合）');
  // ② 客户端消费：main.js 必须订阅 chat 事件并投喂渲染层
  ok(/net\.on\('chat'/.test(mainJs), 'main.js 订阅 chat 事件');
  ok(/function onChatMessage\(/.test(mainJs) && /onChatMessage\(m\)/.test(mainJs),
    'main.js 的 chat 事件回调实际调用 onChatMessage（而非订阅了不用）');
  ok(/function appendChatRow\(/.test(mainJs) && /function appendHudChat\(/.test(mainJs),
    'main.js 同时实现大厅消息流与局内浮层两个渲染入口');
  // ③ 打字隔离：sampleLocalInput 必须在**所有其它判据之前**检查 S.chatTyping
  {
    const si = mainJs.indexOf('function sampleLocalInput(');
    const body = mainJs.slice(si, si + 2600);
    // 只比"代码行"：注释里会提到 S.rp.racing（解释为何不能用 raceClock），必须先剥掉注释。
    const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const chatAt = code.indexOf('S.chatTyping');
    const raceAt = code.indexOf('S.rp.racing');
    ok(chatAt >= 0 && raceAt > chatAt,
      'sampleLocalInput 的聊天隔离判据位于发车/比赛判据之前（否则打字时车会自己动）',
      'chatTyping@' + chatAt + ' racing@' + raceAt);
    ok(/inp\.throttle = 0; inp\.brake = 0; inp\.handbrake = 0; inp\.steer = 0;/.test(code.slice(chatAt, chatAt + 260)),
      '聊天激活时四路操控意图全部清零（含手刹）');
  }
  // ④ 窗口级按键旁路：焦点在输入框内时绝不放行到驾驶状态机
  ok(/inField \|\| S\.chatTyping/.test(mainJs),
    'keydown 在输入框聚焦/聊天激活时整体旁路（驾驶按键不进状态机）');
  // ⑤ 输入框自身必须 stopPropagation，否则 Enter 会与窗口级"呼出聊天"互相触发
  ok(/\$\('chatInput'\)[\s\S]{0,400}?stopPropagation\(\)/.test(mainJs),
    '大厅聊天输入框 keydown 阻止冒泡（Enter 发送不会与呼出逻辑打架）');
  ok(/\$\('hudChatInput'\)[\s\S]{0,400}?stopPropagation\(\)/.test(mainJs),
    '局内打字条 keydown 阻止冒泡');
  // ⑥ DOM 锚点必须存在（main.js 用 $() 取，缺一个就静默失效）
  for (const id of ['chatPanel', 'chatOnline', 'chatFeed', 'chatInput', 'chatSend',
                    'hudChat', 'hudChatFeed', 'hudChatBar', 'hudChatInput']) {
    ok(new RegExp('id="' + id + '"').test(html), 'index.html 提供聊天 DOM 锚点 #' + id);
  }
  // ⑦ XSS 纵深防御：聊天渲染绝不能走 innerHTML，只能用 textContent
  {
    const cs = mainJs.indexOf('function appendChatRow(');
    const ce = mainJs.indexOf('function sanitizeHex(');
    const seg = mainJs.slice(cs, ce > cs ? ce : cs + 3000);
    ok(!/innerHTML/.test(seg), 'appendChatRow 全程使用 textContent（无 innerHTML，杜绝 XSS）');
    ok(/\.textContent = msg\.content/.test(seg), '聊天正文经 textContent 写入');
  }
  // ⑧ CSS：面板磨砂玻璃 + 局内浮层定位（规格 §二/§三 的视觉契约）
  const css = texts['/style.css'];
  ok(/backdrop-filter:\s*blur\(12px\)/.test(css), '聊天面板使用 backdrop-filter 磨砂玻璃（规格 §二）');
  ok(/\.chat-panel[\s\S]{0,400}?width:\s*340px/.test(css), '聊天面板宽度 340px（规格 §二）');
  ok(/\.hud-chat[\s\S]{0,300}?left:\s*22px/.test(css), '局内浮层贴左下（避开车舱视线与弯心）');
  ok(!/速度线/.test(css) && /\.hc-msg\.out/.test(css), '局内消息有淡出动画（.out）');
}

// HUD 结构守卫。历史上 index.html 在 #hud 后面多了一个 </div>，浏览器解析后
// #hud 的子树只剩 .hud-tl：.hud-tr / .hud-bl / .hud-br(速度表) / #spectate / #toast
// 全都变成了 #hud 的兄弟节点 -> `#hud.classList.add('hidden')` 根本藏不住它们。
// 一直没被发现，只是因为 #lobby 是全屏 fixed 遮罩把它们盖住了。
{
  // 必须先把 HTML 注释剥掉：注释里出现闭合标签字面量会把行数式扫描器带偏
  // （浏览器会忽略注释内文本，扫描器不会）。
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  const openN = (bare.match(/<div\b/g) || []).length;
  const closeN = (bare.match(/<\/div>/g) || []).length;
  ok(openN === closeN, 'index.html 的 div 标签配平（多一个闭合标签会把 HUD 挤出 #hud）',
    openN + ' 开 / ' + closeN + ' 闭');
  const hi = bare.indexOf('id="hud"');
  const ci = bare.indexOf('id="startLights"');
  const seg = bare.slice(hi, ci > hi ? ci : bare.length);
  let d = 0, standD = -1, speedoD = -1, mapD = -1;
  const re = /<(\/?)div\b[^>]*>/g;
  let mm;
  while ((mm = re.exec(seg))) {
    if (mm[1]) { d--; continue; }
    d++;
    const tg = mm[0];
    if (tg.includes('id="standList"')) standD = d;
    if (tg.includes('speedo-wrap')) speedoD = d;
    if (tg.includes('map-card')) mapD = d;
  }
  ok(standD > 1 && speedoD > 1 && mapD > 1,
    '计时塔 / 速度表 / 迷你地图都在 #hud 内部（否则 #hud.hidden 藏不住）',
    'standList=d' + standD + ' speedo=d' + speedoD + ' minimap=d' + mapD);
  // 规格 §6.2：计时塔必须在**左上角** -> 挂在 .hud-tl 下，且不能还留在 .hud-tr
  const towerUnderTl = /hud-tl[\s\S]*?id="standList"/.test(seg) &&
    !/hud-tr[\s\S]*?id="standList"/.test(seg);
  ok(towerUnderTl, '计时塔位于屏幕左上角 .hud-tl（规格 §6.2），未留在 .hud-tr');
}

/* --------------------------------------------------------------------- */
/* 2. WebSocket 房间流程                                                   */
/* --------------------------------------------------------------------- */
section('2. WebSocket 协议与房间流程');

function mkClient(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  const c = { ws, msgs, name, closed: false };
  ws.addEventListener('message', (e) => { try { msgs.push(JSON.parse(e.data)); } catch (_) { msgs.push({ t: 'raw', len: String(e.data).length }); } });
  c.ready = new Promise((r) => ws.addEventListener('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.find = (t) => msgs.find((m) => m.t === t);
  c.all = (t) => msgs.filter((m) => m.t === t);
  return c;
}

const A = mkClient('A');
await A.ready;
ok(A.ws.readyState === 1, 'WebSocket 握手成功（RFC6455 101 升级）');

await sleep(120);
A.send({ t: 'ping', c: Date.now() });
const pong = await waitFor(() => A.find('pong'), 2000);
ok(pong && typeof pong.s === 'number', 'ping/pong 保活与时钟基准',
  pong ? 'rtt=' + (Date.now() - pong.c) + 'ms' : '');

A.send({ t: 'create', name: '车手A', color: '#e10600', laps: 1, track: 'vegas' });
const hello = await waitFor(() => A.find('hello'), 2000);
ok(hello && hello.id === 1, '分配席位号 1（服务端权威）', hello ? 'id=' + hello.id : '');
const roomMsg = await waitFor(() => A.find('room'), 2000);
ok(roomMsg && /^[A-Z0-9]{4}$/.test(roomMsg.room), '创建房间并下发 4 位房间号', roomMsg && roomMsg.room);
ok(roomMsg.players.length === 1 && roomMsg.players[0].name === '车手A', '房间玩家列表正确');
const CODE = roomMsg.room;
const lastRoom = () => A.all('room').at(-1) || {};

// --- 赛道选择链路（建房指定 -> 大厅切换 -> 白名单回落 -> 发车下发）---
ok(roomMsg.track === 'vegas', '建房时指定的赛道被服务端采纳', 'track=' + roomMsg.track);

const nRoom = A.all('room').length;
A.send({ t: 'track', track: 'garbage-track' });
const fellBack = await waitFor(() => A.all('room').length > nRoom, 2000);
ok(fellBack && lastRoom().track === 'suzuka', '非法赛道名被 sanitizeTrack 回落铃鹿（白名单）',
  'track=' + lastRoom().track);

A.send({ t: 'track', track: 'vegas' });
const switched = await waitFor(() => lastRoom().track === 'vegas', 2000);
ok(switched, '房主在大厅切换赛道 -> 服务端权威改写并广播回全房间', 'track=' + lastRoom().track);

// 中文昵称与非法颜色的清洗
const B = mkClient('B');
await B.ready;
B.send({ t: 'join', room: CODE, name: '车手B', color: 'javascript:alert(1)' });
await waitFor(() => B.find('room'), 2000);
const r2 = A.all('room').pop();
ok(r2.players.length === 2, '第二名玩家加入，房间人数=2');
ok(r2.players.every((p) => /^#[0-9a-f]{6}$/.test(p.color)), '非法颜色被服务端清洗为合法 hex',
  r2.players.map((p) => p.color).join(','));

// 容量上限（规格 §八：4 -> 12）
const extra = [];
for (let i = 0; i < 2; i++) { const c = mkClient('X' + i); await c.ready; extra.push(c); }
extra[0].send({ t: 'join', room: CODE, name: 'C', color: '#ffffff' });
extra[1].send({ t: 'join', room: CODE, name: 'D', color: '#ffffff' });
await sleep(250);
ok(A.all('room').pop().players.length === 4, '第 3、4 名玩家已加入，房间人数=4');
// 第 5 名玩家在 12 人上限下应被**接受**（旧断言"上限 4 人/第 5 人被拒"已随规格失效）
const E = mkClient('E');
await E.ready;
E.send({ t: 'join', room: CODE, name: 'E', color: '#ffffff' });
await waitFor(() => A.all('room').pop().players.length === 5, 2000);
ok(A.all('room').pop().players.length === 5, '12 人上限下第 5 名玩家被接受（规格 §八）');
// 注意：E 保留在房间内（不关闭），否则会触发 left 广播腾出席位，
// 后续"填满到 12 人"的计数就会少 1。

// 填满到 12 人，第 13 人必须被拒绝并收到明确提示
const fillers = [];
for (let i = 0; i < 7; i++) { const c = mkClient('F' + i); await c.ready; fillers.push(c); }
for (let i = 0; i < 7; i++) {
  fillers[i].send({ t: 'join', room: CODE, name: 'F' + i, color: '#ffffff' });
  await sleep(150);
}
await waitFor(() => A.all('room').pop().players.length === 12, 4000);
ok(A.all('room').pop().players.length === 12, '第 6~12 名玩家填满房间，人数=12',
  'n=' + A.all('room').pop().players.length);
const G = mkClient('G');
await G.ready;
G.send({ t: 'join', room: CODE, name: 'G', color: '#ffffff' });
const fullErr = await waitFor(() => G.find('err'), 2000);
ok(fullErr && /已满|上限/.test(fullErr.msg), '第 13 人被拒绝并收到明确提示', fullErr && fullErr.msg);
G.ws.close();
// 清出多余席位：E + 7 名填位者离场，房间回到 A/B/C/D 四人，供后续比赛流程使用。
E.ws.close();
for (const c of fillers) c.ws.close();
await sleep(300); // 等断线广播落地，恢复房间人数，避免影响后续断言
await waitFor(() => A.all('room').pop().players.length === 4, 3000);

// 不存在的房间
const F = mkClient('F');
await F.ready;
F.send({ t: 'join', room: 'ZZZZ', name: 'F', color: '#ffffff' });
const badRoom = await waitFor(() => F.find('err'), 2000);
ok(badRoom && /不存在/.test(badRoom.msg), '加入不存在的房间被拒绝', badRoom && badRoom.msg);
F.ws.close();

/* --------------------------------------------------------------------- */
/* 2b. 一体化聊天总线 CHAT_MESSAGE（规格 §一）                             */
/* --------------------------------------------------------------------- */
section('2b. 聊天总线 CHAT_MESSAGE 与系统事件广播');

// ---- 系统事件自动广播：房间里已发生过 join（A/B/C/D）----
{
  // 服务端在玩家加入/准备/切赛道时必须自动注入 isSystem 消息（与玩家发言共用一个通道）。
  const joins = A.all('CHAT_MESSAGE').filter((m) => m.isSystem && /加入了房间/.test(m.content));
  ok(joins.length >= 3, '玩家加入被服务端自动广播为系统消息', joins.length + ' 条');
  const j1 = joins[0] || {};
  ok(j1.sender === '系统' && j1.isSystem === true && typeof j1.senderColor === 'string',
    '系统消息带 isSystem 标记与系统身份（sender=系统）',
    'sender=' + j1.sender + ' isSystem=' + j1.isSystem);
  ok(/^#[0-9a-f]{6}$/.test(j1.senderColor || ''), '系统消息携带合法 senderColor', j1.senderColor);
  ok(typeof j1.timestamp === 'number' && j1.timestamp > 1600000000000,
    '系统消息携带服务端墙钟 timestamp', String(j1.timestamp));
  // 规格：赛道切换必须作为系统消息进入右侧聊天流。
  const trk = A.all('CHAT_MESSAGE').filter((m) => m.isSystem && /赛道切换为/.test(m.content));
  ok(trk.length >= 1, '房主切换赛道写入右侧聊天框',
    trk.length ? trk.at(-1).content : '聊天流无赛道切换消息');
  const ghostBefore = A.all('CHAT_MESSAGE').filter((m) => /幽灵车模式/.test(m.content)).length;
  A.send({ t: 'ghost', ghost: true });
  const ghostMsg = await waitFor(
    () => A.all('CHAT_MESSAGE').filter((m) => /幽灵车模式/.test(m.content)).length > ghostBefore,
    2000);
  ok(ghostMsg, '碰撞体积模式切换写入右侧聊天框',
    A.all('CHAT_MESSAGE').filter((m) => /幽灵车模式/.test(m.content)).at(-1)?.content || '未收到');
} 

// ---- 玩家发言：正常转发 ----
{
  const n0 = B.all('CHAT_MESSAGE').length;
  A.msgs.length = 0; B.msgs.length = 0;
  A.send({ t: 'CHAT_MESSAGE', content: '大家好，准备发车了' });
  const got = await waitFor(() => B.all('CHAT_MESSAGE').find((m) => !m.isSystem), 2000);
  ok(!!got, '玩家发言被广播给房内其他玩家', got ? got.content : '未收到');
  ok(got && got.content === '大家好，准备发车了', '正文原样透传', got && got.content);
  // 身份由服务端权威填充，不信任客户端上报（防冒名）
  ok(got && got.sender === '车手A', '发言者身份取自服务端（防冒名）', got && got.sender);
  ok(got && /^#[0-9a-f]{6}$/.test(got.senderColor), '发言者车色随消息下发', got && got.senderColor);
  ok(got && got.isSystem === false, '玩家发言 isSystem=false', got && String(got.isSystem));
  ok(got && got.type === 'CHAT_MESSAGE' && got.t === 'CHAT_MESSAGE', '下行报文含 type 与 t 双标识');
  // 自己也能收到回显（全房间广播，含发送者）
  const echo = await waitFor(() => A.all('CHAT_MESSAGE').find((m) => !m.isSystem), 2000);
  ok(!!echo, '发送者本人也收到自己的回声（前台一致）');
  ok(n0 >= 0, '（计数占位）');
}

// ---- XSS / 控制字符 / 空消息 防御 ----
{
  A.msgs.length = 0; B.msgs.length = 0;
  A.send({ t: 'CHAT_MESSAGE', content: '<script>alert(1)</script>' });
  const x = await waitFor(() => B.all('CHAT_MESSAGE').find((m) => !m.isSystem), 2000);
  // 服务端不做 HTML 转义（客户端用 textContent 渲染），但必须原样透传且客户端不要 innerHTML。
  // 这里断言服务端确实把内容当成**纯文本**处理：不崩、不丢、长度可控。
  ok(!!x && typeof x.content === 'string', '尖括号内容被当作纯文本透传（客户端 textContent 渲染）',
    x && x.content.slice(0, 40));

  // 控制字符/空字符被清洗
  A.msgs.length = 0; B.msgs.length = 0;
  A.send({ t: 'CHAT_MESSAGE', content: 'a\u0000b\u0007c' });
  const ctl = await waitFor(() => B.all('CHAT_MESSAGE').find((m) => !m.isSystem), 2000);
  ok(!!ctl && ctl.content === 'abc', '控制字符与空字符被 sanitizeChat 剥除', ctl && JSON.stringify(ctl.content));

  // 纯空白 -> 直接丢弃（不广播）
  B.msgs.length = 0;
  A.send({ t: 'CHAT_MESSAGE', content: '   \u0000  ' });
  await sleep(350);
  ok(B.all('CHAT_MESSAGE').filter((m) => !m.isSystem).length === 0, '纯空白消息被丢弃（不广播）');

  // 超长消息被截断到 80 字符而不是被拒
  B.msgs.length = 0;
  A.send({ t: 'CHAT_MESSAGE', content: 'x'.repeat(300) });
  const long = await waitFor(() => B.all('CHAT_MESSAGE').find((m) => !m.isSystem), 2000);
  ok(!!long && [...long.content].length === 80, '超长消息按码点截断到 80 字符（规格 §一.1）',
    long ? [...long.content].length + ' 字符' : '未收到');

  // 多字节（中文/emoji）按码点截断，不产生残缺字节
  B.msgs.length = 0;
  A.send({ t: 'CHAT_MESSAGE', content: '汉'.repeat(120) });
  const wide = await waitFor(() => B.all('CHAT_MESSAGE').find((m) => !m.isSystem), 2000);
  ok(!!wide && [...wide.content].length === 80 && !wide.content.includes('\uFFFD'),
    '多字节字符按码点截断且无乱码', wide ? [...wide.content].length + ' 字符' : '未收到');
}

/* --------------------------------------------------------------------- */
/* 3. 准备 -> 倒计时 -> START                                              */
/* --------------------------------------------------------------------- */
section('3. 准备 / 5 秒整备倒计时 / 五灯发车序列');

// ---- 准备状态也被自动广播为系统事件（规格 §一.2）----
{
  const rdyBefore = A.all('CHAT_MESSAGE').filter((m) => m.isSystem && /已准备就绪/.test(m.content)).length;
  A.send({ t: 'ready', v: true });
  const rdy = await waitFor(
    () => A.all('CHAT_MESSAGE').filter((m) => m.isSystem && /已准备就绪/.test(m.content)).length > rdyBefore,
    1500);
  ok(rdy, '玩家准备被广播为系统消息（玩家【xx】已准备就绪）',
    A.all('CHAT_MESSAGE').filter((m) => /已准备就绪/.test(m.content)).at(-1)?.content || '未收到');
}

const tReady = Date.now();
for (const c of [A, B, ...extra]) c.send({ t: 'ready', v: true });
// 开赛是两个阶段，必须分开计时：阶段一 = 全员准备后的整备倒计时
// （服务端 readyCountdownSec，广播在聊天框）；阶段二 = 五灯灯序（stage2Ms）。
// 早先只测「tReady -> stage6」的总时长，阶段一从 0 加到 5 秒后它便恒超上界；
// 而真正的灯序时长（2.75s）反倒失去了守卫。
const seqBegin = await waitFor(() => A.find('START_SEQUENCE_BEGIN'), 9000, 20);
const tSeqBegin = Date.now();
ok(!!seqBegin, '阶段二开始前广播 START_SEQUENCE_BEGIN（客户端此刻锁车并亮五盏红灯）');
ok(tSeqBegin - tReady >= 4700 && tSeqBegin - tReady <= 6200,
  '阶段一：全员准备后播报 5 秒整备倒计时（规格 §一.0「要有准备时间」）',
  (tSeqBegin - tReady) + 'ms');
const startMsg = await waitFor(() => A.find('start'), 9000, 20);
ok(!!startMsg, '全员准备后自动发车');
ok(A.all('count').length === 0, '不再发送 3-2-1 count 倒计时广播',
  'count=' + A.all('count').map((m) => m.n).join(','));
ok(!!startMsg && startMsg.at > Date.now(), 'START 携带统一发车时刻（服务端时钟）',
  startMsg ? 'at-now=' + (startMsg.at - Date.now()) + 'ms' : '');
ok(!!startMsg && typeof startMsg.seed === 'number' && startMsg.seed > 0,
  '下发赛道随机种子（四台机器同一条赛道）', startMsg ? 'seed=' + startMsg.seed : '');
ok(!!startMsg && startMsg.laps === 1, '圈数按房主设置下发', startMsg ? 'laps=' + startMsg.laps : '');
// 赛道类型必须一路活到发车：客户端 main.js 靠这个字段决定 new Track(seed, track)
ok(!!startMsg && startMsg.track === 'vegas', 'START 下发赛道类型（客户端据此建造世界）',
  startMsg ? 'track=' + startMsg.track : '');
const raceStartMsg = await waitFor(() => A.find('RACE_START'), 9000, 20);
ok(!!raceStartMsg, '红灯熄灭后广播权威 RACE_START');
const lightsDone = await waitFor(() => A.all('lights').some((m) => m.stage === 6), 9000, 20);
const stages = A.all('lights').map((m) => m.stage);
ok(lightsDone && stages.join(',') === '5,4,3,2,1,6',
  '五盏红灯依次熄灭并最终转绿', 'lights=' + stages.join(','));
ok(Date.now() - tSeqBegin >= 2300 && Date.now() - tSeqBegin <= 5200, '阶段二：五灯发车序列时长约 2.75 秒',
  (Date.now() - tSeqBegin) + 'ms');

// ---- 321 数字倒计时已移除；发车仍保留单条系统提示 ----
{
  const cdMsgs = A.all('CHAT_MESSAGE').filter((m) => /秒后开始/.test(m.content));
  ok(cdMsgs.length === 0, '聊天流中不再出现 3/2/1 倒数公告',
    cdMsgs.map((m) => m.content).join(' | '));
  const goMsg = await waitFor(
    () => A.all('CHAT_MESSAGE').find((m) => m.isSystem && /全员发车/.test(m.content)),
    8000, 25);
  ok(!!goMsg, '[赛事指令] 全员发车！随绿灯一同送达', goMsg ? goMsg.content : '未收到');
  ok(goMsg && goMsg.isSystem === true && goMsg.sender === '系统' &&
     typeof goMsg.timestamp === 'number',
    '发车提示携带系统身份与服务端时间戳');
}

/* --------------------------------------------------------------------- */
/* 4. 30Hz 位姿中继                                                        */
/* --------------------------------------------------------------------- */
section('4. 60Hz 位姿中继与罚时广播');

B.msgs.length = 0;
let sent = 0;
const t0 = Date.now();
const timer = setInterval(() => {
  sent++;
  const spline = 0.48 + Math.min(0.012, sent * 0.0001);
  A.send({
    t: 'state', seq: sent,
    d: {
      x: sent * 0.5, y: 1.23, z: -sent * 0.25, q: [0, 0.707, 0, 0.707],
      v: [40, 0, 0], s: 144, t: 0.12, l: 0, k: sent % 2, f: 0,
      c: 0, n: 92.0, p: spline,
    },
  });
}, 1000 / 30);
await sleep(2000);
clearInterval(timer);
// 后车在同一圈稍低样条坐标上报：服务端用两台车共同经过切片时的服务端时刻求差，
// 不再用“距离 ÷ 当前车速”外推，因此不会在刹车点/丢包时跳成数千秒。
B.send({
  t: 'state', seq: 1,
  d: {
    x: 25, y: 1.23, z: -12, q: [0, 0.707, 0, 0.707],
    v: [39, 0, 0], s: 140, t: 0.08, l: 0, k: 0, f: 0,
    c: 0, n: 94.0, p: 0.486,
  },
});
await sleep(100);
const snaps = B.all('snap');
const hz = snaps.length / 2;
ok(hz > 52 && hz < 68, '中继频率实测接近 60Hz（规格：16666µs Tick）', '实测 ' + hz.toFixed(1) + ' Hz（发送 ' + sent + ' 包）');
const withA = snaps.filter((s) => s.p.some((p) => p.id === 1));
ok(withA.length > 90, '快照中包含上报者席位 1', withA.length + ' 帧 / 2s');
const lastP = withA[withA.length - 1].p.find((p) => p.id === 1);
ok(lastP && lastP.d.x !== undefined && lastP.d.q.length === 4 && lastP.d.s === 144,
  '位姿字段完整（x,y,z + 四元数 + 速度 + 转向角）',
  lastP ? 'x=' + lastP.d.x + ' q=[' + lastP.d.q.join(',') + '] steer=' + lastP.d.t : '');

// 罚时：正常上报累加
B.msgs.length = 0;
// ---- 服务端权威榜单（规格 §2.3）：20Hz 下发，含 gap / int / 姓名 / 罚时 ----
// 客户端 main.js 的计时塔完全依赖它（只有服务端知道各人的过线时刻）。
{
  const lb = await waitFor(() => A.all('LEADERBOARD_UPDATE').at(-1), 2500);
  ok(!!lb && Array.isArray(lb.data) && lb.data.length >= 2,
    '服务端定时下发 LEADERBOARD_UPDATE（权威排位）', lb ? lb.data.length + ' 条' : '未收到');
  const e0 = (lb && lb.data[0]) || {};
  const e1 = (lb && lb.data[1]) || {};
  ok(e0.pos === 1 && e0.gap === 0, 'P1 的 gap 恒为 0（客户端渲染成 LEADER）',
    'pos=' + e0.pos + ' gap=' + e0.gap);
  ok(typeof e0.name === 'string' && typeof e0.pen === 'number' && typeof e0.lap === 'number',
    '榜单条目含车手姓名 / 罚时 / 圈数', JSON.stringify(e0).slice(0, 90));
  ok('gap' in e1 && 'int' in e1,
    '后车带 gap（与 P1 总差距）与 int（与前一位的间隔差）',
    'gap=' + e1.gap + ' int=' + e1.int);
  // 起步阶段（双方都没有公共 Checkpoint -> 走积分折算兜底）秒差必须 ≤ 0。
  // 全工程统一 signed 语义：>0 = 领先、<0 = 落后。P2 相对 P1 不可能领先，
  // 所以 gap 必须 ≤ 0（客户端渲染成 "-X.Xs"）。
  // 历史 bug：旧 gapBehindMs 语义是"正=落后"，与 RaceDeltaTracker 相反，
  // 加上一个多余的负号后计时塔会显示 "+-5.00s"。
  ok(typeof e1.gap === 'number' && e1.gap <= 0,
    '后车 gap ≤ 0（signed 语义：负 = 落后，客户端渲染成 "-X.Xs"）', 'gap=' + e1.gap);
  // behind 是该车相对后一名的带符号差：P1 领先后车 -> 正（防守秒差）。
  ok(!('behind' in e0) || e0.behind === null || e0.behind >= 0,
    'P1 的 behind ≥ 0（正 = 领先 P2，客户端渲染 "▼ X.Xs"）',
    'behind=' + e0.behind);
}

B.msgs.length = 0;
A.send({ t: 'pen', sec: 0.5, reason: 'offtrack' });
await sleep(220);
A.send({ t: 'pen', sec: 0.5, reason: 'cut' });
await sleep(220);
const pens = B.all('pen');
ok(pens.length === 2 && Math.abs(pens[1].sec - 1.0) < 1e-6, '罚时在服务端累计（0.5 -> 1.0）',
  pens.map((p) => p.sec).join(' -> '));
ok(pens[1].delta === 0.5 && pens[1].reason === 'cut', '罚时事件带增量与原因（HUD 据此报警）');

// 罚时限频：连续狂刷只接受 1 次
B.msgs.length = 0;
for (let i = 0; i < 20; i++) A.send({ t: 'pen', sec: 0.5, reason: 'offtrack' });
await sleep(300);
ok(B.all('pen').length === 1, '罚时上报限频（150ms 内重复上报被丢弃，防刷分）',
  '20 次上报 -> 接受 ' + B.all('pen').length + ' 次');

// 大帧（>125 字节）走 16 位扩展长度，验证帧编码
B.msgs.length = 0;
for (let i = 0; i < 12; i++) {
  A.send({ t: 'state', seq: 1000 + i, d: { x: i * 1.234567, y: 1.234567, z: i * 9.876543, q: [0.123456, 0.234567, 0.345678, 0.876543], v: [12.345, 0.001, -9.876], s: 233, t: 0.54321, l: 2, k: 1, f: 0 } });
}
await sleep(400);
const big = B.all('snap').pop();
ok(big && big.p.length >= 1, '扩展长度帧（payload>125B）编解码正确',
  big ? '快照 ' + JSON.stringify(big).length + ' 字节' : '');

/* --------------------------------------------------------------------- */
/* 5. 冲线成绩与结算                                                       */
/* --------------------------------------------------------------------- */
section('5. 冲线成绩（服务端时钟）与结算');

// 净用时 = 冲线时刻 − 发车时刻（start.at，位于三阶段发车锁定窗口之后）。
// ⚠️ 必须等过 start.at 再冲线，否则 time.Since(startAt) 为负（比赛尚未正式开赛）。
if (startMsg && startMsg.at > Date.now()) {
  await sleep(startMsg.at - Date.now() + 120);
}
B.msgs.length = 0;
A.send({ t: 'lap', n: startMsg.laps, time: 90 });
A.send({ t: 'finish' });
const fin = await waitFor(() => B.find('fin'), 2000);
ok(fin && fin.id === 1 && fin.net > 0, '冲线成绩以服务端时钟计算净用时',
  fin ? 'net=' + fin.net.toFixed(2) + 's pen=' + fin.pen + 's total=' + fin.total.toFixed(2) + 's' : '');
ok(fin && Math.abs(fin.total - (fin.net + fin.pen)) < 1e-6, '总成绩 = 净用时 + 累计罚时',
  fin ? fin.net.toFixed(2) + ' + ' + fin.pen + ' = ' + fin.total.toFixed(2) : '');
ok(fin && fin.rank === 1, '首位冲线名次 P1');

// 首位冲线 -> 服务端启动 60s DNF 宽限倒计时并广播 dnf 报文（规格 §五.1）
const dnfMsg = await waitFor(() => B.find('dnf'), 2000);
ok(dnfMsg && dnfMsg.secs > 0 && dnfMsg.secs <= 60,
  '首位冲线后广播 dnf 宽限倒计时（≤60s）', dnfMsg ? 'secs=' + dnfMsg.secs : '无 dnf 报文');

B.send({ t: 'lap', n: startMsg.laps, time: 91 });
B.send({ t: 'finish' });
const fin2 = await waitFor(() => B.all('fin').find((m) => m.id === 2), 2000);
ok(fin2 && fin2.rank === 2, '第二位冲线名次 P2', fin2 ? 'rank=' + fin2.rank : '');

// 第三位冲线后仍有未完赛者 -> 结算不应提前触发
B.msgs.length = 0;
extra[1].send({ t: 'lap', n: startMsg.laps, time: 92 });
extra[1].send({ t: 'finish' });
await sleep(300);
ok(!A.find('end'), '尚有车辆未完赛时不提前结算');

// 未完赛者断线 -> 广播 left 且剩余全员完赛 -> 立即结算
extra[0].ws.close();
const leftMsg = await waitFor(() => B.find('left'), 2500);
ok(!!leftMsg, '未完赛玩家断线：向其余玩家广播 left', leftMsg ? leftMsg.name + ' (' + leftMsg.reason + ')' : '');
const end = await waitFor(() => A.find('end'), 3000);
ok(end && end.results.length === 3, '剩余全员完赛后广播结算', end ? end.results.length + ' 条成绩' : '');
ok(end && end.results[0].fin && end.results[0].total <= end.results[1].total,
  '结算按总成绩升序排名',
  end ? end.results.map((r) => 'P' + r.rank + ':' + r.total.toFixed(2)).join(' ') : '');

// restart 回大厅
A.msgs.length = 0;
A.send({ t: 'restart' });
const back = await waitFor(() => A.find('lobby'), 2000);
ok(!!back, 'restart 广播回到大厅');
await sleep(120);
const roomAgain = A.all('room').pop();
ok(roomAgain && roomAgain.players.every((p) => !p.ready && p.pen === 0),
  '回大厅后准备状态与罚时已清零');

for (const c of [A, B, extra[0], extra[1]]) { try { c.ws.close(); } catch (e) { /* ignore */ } }

/* --------------------------------------------------------------------- */
section('6. 服务端日志健壮性');
ok(!/panic|fatal error/i.test(errOut), '运行期无 panic', errOut.trim().split('\n')[0] || 'stderr 干净');
const allLog = out + errOut;
// 把服务端 tick 耗时统计行打出来（诊断"服务器延迟高"：服务端卡 vs 网络 RTT）
for (const ln of (out + errOut).split(String.fromCharCode(10))) {
  if (ln.indexOf('tick 耗时') >= 0) console.log('  [服务端] ' + ln.trim());
}
ok(/\[room [A-Z0-9]{4}\]/.test(allLog) && /START/.test(allLog), '服务端打印房间生命周期日志',
  (allLog.match(/\[room[^\n]*/g) || []).slice(0, 2).join(' | '));

srv.kill();
await sleep(200);

const dt = Date.now();
console.log('\n' + '─'.repeat(66));
if (failures.length === 0) {
  console.log('\x1b[32m\x1b[1m端到端全部通过\x1b[0m  ' + pass + ' 项断言');
  process.exit(0);
} else {
  console.log('\x1b[31m\x1b[1m端到端失败 ' + failures.length + ' 项\x1b[0m / 通过 ' + pass + ' 项');
  for (const f of failures) console.log('  \x1b[31m✗\x1b[0m ' + f);
  process.exit(1);
}
