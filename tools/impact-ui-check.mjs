/* 真实浏览器验收：护栏撞击无罚时与视频式调查/结果动画。 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const port = 8097;
const cdpPort = 9377;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = process.env.TMPDIR || tmpdir();
const srv = spawn(join(root, 'forzalan.exe'), ['-addr', ':' + port, '-quiet'], { cwd: root, stdio: 'ignore' });
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + cdpPort,
  '--user-data-dir=' + mkdtempSync(join(scratch, 'impact-ui-')),
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
  `http://127.0.0.1:${port}/?solo=1&dbg=1&track=suzuka&laps=1`,
], { stdio: 'ignore' });

let ws;
let nextId = 0;
const waits = new Map();
const exceptions = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { waits.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
  waits.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page evaluation failed');
  return result.result.value;
};
const assert = (ok, text) => {
  if (!ok) throw new Error('FAIL ' + text);
  console.log('PASS ' + text);
};

try {
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve);
          ws.addEventListener('error', reject);
        });
      }
    } catch (_) {}
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error('CDP 未就绪');
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails || {};
      exceptions.push(detail.exception?.description || detail.description || detail.text || JSON.stringify(detail));
    }
    if (message.id && waits.has(message.id)) {
      const wait = waits.get(message.id);
      waits.delete(message.id);
      clearTimeout(wait.timer);
      if (message.error) wait.reject(new Error(message.error.message));
      else wait.resolve(message.result);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  for (let i = 0; i < 80; i++) {
    if (await ev('!!(window.__S && window.__S.rp && window.__S.rp.racing)')) break;
    await sleep(250);
  }
  assert(await ev('!!(window.__S && window.__S.rp && window.__S.rp.racing)'), '单机进入竞速状态');
  const before = await ev(`(() => {
    const s = window.__S, c = s.localCar;
    const p = Object.assign({}, s.penalties);
    s.rp.onIncident(c, { cause: '撞击', kind: 'wall' });
    const e = document.getElementById('frrBanner');
    return { classes: e.className, label: document.getElementById('frrTxt').textContent, penalties: s.penalties, unchanged: JSON.stringify(p) === JSON.stringify(s.penalties) };
  })()`);
  assert(before.classes.includes('on'), '调查阶段立即显示顶部撞击胶囊');
  assert(before.label === '撞击', '调查阶段显示撞击');
  assert(before.unchanged, '护栏撞击未增加罚时');
  await sleep(4700);
  const result = await ev(`(() => {
    const e = document.getElementById('frrBanner');
    return { classes: e.className, label: document.getElementById('frrTxt').textContent, verdict: document.getElementById('impactVerdict').textContent };
  })()`);
  assert(result.classes.includes('result'), '约4.5秒后进入结果展开状态');
  assert(result.label === '撞击' && result.verdict === '无处罚', '结果条左侧撞击、右侧无处罚');
  await sleep(2700);
  assert(await ev('!document.getElementById("frrBanner").classList.contains("on")'), '结果停留后淡出上移消失');
  assert(exceptions.length === 0, '浏览器 Runtime.exceptionThrown 为零');
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  browser.kill();
  srv.kill();
}
