/* 聊天面板视觉截图（真机渲染，供人工复核）。零依赖，走 CDP Page.captureScreenshot。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8099, CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c;
  return null;
}
const browser = findBrowser();
if (!browser) { console.log('无浏览器'); process.exit(0); }

const srv = spawn('forzalan.exe', [], { cwd: process.cwd(), stdio: 'ignore' });
await sleep(1600);
const profile = mkdtempSync(join(tmpdir(), 'chat-shot-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url); const c = new CDP(ws);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.w.has(m.id)) { const { res } = c.w.get(m.id); c.w.delete(m.id); res(m.result); }
    });
    await new Promise((r) => ws.addEventListener('open', r));
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.w.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      // 兜底超时：页面导航中偶发丢回包，没有这个守卫脚本会永久挂住
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async eval(e) {
    try {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      return r && r.result ? r.result.value : undefined;
    } catch (_) { return undefined; }
  }
}
const cdp = await CDP.connect(await target());
// Runtime/Page 域是**可选**能力：截图脚本的整体价值是产出一张人工复核用图，
// 若 CDP 域启用失败就直接跳过，不让辅助工具影响交付判定。
try { await cdp.send('Runtime.enable'); } catch (_) { console.log('Runtime 域未就绪，跳过截图'); process.exit(0); }
try { await cdp.send('Page.enable'); } catch (_) {}
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });   // 大厅态：无 WebGL 场景，截图稳定
await sleep(5000);
// 展开面板并注入示例消息
await cdp.eval(`(() => {
  const p = document.getElementById('chatPanel');
  p.classList.remove('hidden'); p.classList.add('show');
  const on = document.getElementById('chatOnline'); if (on) on.textContent = '4';
  const feed = document.getElementById('chatFeed');
  window.__testAppend && [
    {sender:'系统',senderColor:'#7fb2ff',content:'玩家 【阿尔法】 加入了房间',isSystem:true},
    {sender:'系统',senderColor:'#7fb2ff',content:'玩家 【布拉沃】 加入了房间',isSystem:true},
    {sender:'阿尔法',senderColor:'#e10600',content:'今晚跑斯帕？',isSystem:false},
    {sender:'布拉沃',senderColor:'#00b2a9',content:'Eau Rouge 全油门过的那一下太爽了',isSystem:false},
    {sender:'系统',senderColor:'#7fb2ff',content:'玩家 【布拉沃】 已准备就绪',isSystem:true},
    {sender:'系统',senderColor:'#7fb2ff',content:'房主已将赛道切换为【斯帕-弗朗科尔尚赛道】',isSystem:true},
    {sender:'系统',senderColor:'#7fb2ff',content:'[赛事指令] 比赛将在 3 秒后开始...',isSystem:true},
    {sender:'系统',senderColor:'#7fb2ff',content:'[赛事指令] 比赛将在 2 秒后开始...',isSystem:true},
    {sender:'系统',senderColor:'#7fb2ff',content:'[赛事指令] 全员发车！',isSystem:true},
  ].forEach((m) => window.__testAppend(m));
  return true;
})()`);
await sleep(600);
// 截图失败不影响退出码（供人工复核用，不是验收断言）。
try {
  const shot = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(10000).then(() => null),
  ]);
  if (shot && shot.data) {
    writeFileSync('docs/chat-console.png', Buffer.from(shot.data, 'base64'));
    console.log('大厅聊天面板截图: docs/chat-console.png');
  } else {
    console.log('大厅截图跳过（无头合成器忙）');
  }
} catch (e) {
  console.log('大厅截图跳过: ' + e.message);
}

// 局内浮层示例。
// ⚠️ 无头模式下若场景里有活跃 WebGL 渲染循环，Page.captureScreenshot 可能一直不返回
// （合成器忙于光栅化）。因此这里捕获失败**不算错误** —— 局内浮层的样式契约由
// tools/chat-ui-check.mjs 的 computedStyle 断言负责（那才是权威证据），截图只是可选参考。
await sleep(400);
await cdp.eval(`(() => {
  const lobby = document.getElementById('lobby'); if (lobby) lobby.classList.add('hidden');
  const cp = document.getElementById('chatPanel'); if (cp) cp.classList.add('hidden');
  const boot = document.getElementById('boot'); if (boot) boot.classList.add('hidden');
  const hud = document.getElementById('hud'); if (hud) hud.classList.remove('hidden');
  const feed = document.getElementById('hudChatFeed');
  if (!feed) return false;
  feed.innerHTML = '';
  const mk = (html, cls) => { const d = document.createElement('div'); d.className = 'hc-msg in ' + cls;
    d.innerHTML = html; feed.appendChild(d); };
  mk('<span class="hc-text">布拉沃：Eau Rouge 全油门！</span>', '');
  mk('<span class="hc-name">系统：</span><span class="hc-text">[赛事指令] 比赛将在 1 秒后开始...</span>', 'cd');
  mk('<span class="hc-text">[赛事指令] 全员发车！</span>', 'go');
  const bar = document.getElementById('hudChatBar'); if (bar) bar.classList.remove('hidden');
  return true;
})()`);
await sleep(700);
try {
  const shot2 = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ]);
  if (shot2 && shot2.data) {
    writeFileSync('docs/chat-hud-overlay.png', Buffer.from(shot2.data, 'base64'));
    console.log('局内浮层截图: docs/chat-hud-overlay.png');
  } else {
    console.log('局内浮层截图跳过（无头合成器忙）—— 样式契约由 chat-ui-check.mjs 保证');
  }
} catch (e) {
  console.log('局内浮层截图跳过: ' + e.message);
}

console.log('截图脚本完成。');
child.kill(); srv.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
process.exit(0);

// 兜底：任何未捕获路径 25s 后强制退出（无头浏览器偶发不响应 kill 信号）
setTimeout(() => { try { child.kill(); } catch (_) {} try { srv.kill(); } catch (_) {} process.exit(0); }, 25000).unref();