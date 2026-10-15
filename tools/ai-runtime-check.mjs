/* 12车单机真实浏览器验收：运行期异常、AI名色、计时塔、名牌、地图与轮胎状态。 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.AI_CHECK_PORT || 8091);
const cdpPort = Number(process.env.AI_CHECK_CDP || 9371);
const mode = process.env.AI_CHECK_MODE === 'horizon' ? 'horizon' : 'fm8';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = process.env.TMPDIR || tmpdir();
const srv = spawn(join(root, 'forzalan.exe'), ['-addr', ':' + port, '-quiet'], { cwd: root, stdio: 'ignore' });
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + cdpPort,
  '--user-data-dir=' + mkdtempSync(join(scratch, 'ai-runtime-')),
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,900',
  `http://127.0.0.1:${port}/?solo=1&dbg=1&track=suzuka&laps=1&mode=${mode}`,
], { stdio: 'ignore' });

let ws;
let nextId = 0;
const waits = new Map();
const exceptions = [];
const sleepPoll = async (fn, ms = 200, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch (_) {}
    await sleep(ms);
  }
  return false;
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { waits.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
  waits.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalPage = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'page evaluation failed');
  return r.result.value;
};
const assert = (ok, text) => {
  if (!ok) throw new Error('FAIL ' + text);
  console.log('PASS ' + text);
};

try {
  const ready = await sleepPoll(async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    if (!page) return false;
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        exceptions.push(d.exception?.description || d.description || d.text || JSON.stringify(d));
      }
      if (m.id && waits.has(m.id)) {
        const w = waits.get(m.id); waits.delete(m.id); clearTimeout(w.timer);
        if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result);
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    return true;
  });
  if (!ready) throw new Error('CDP 未就绪');

  const racing = await sleepPoll(() => evalPage('!!(window.__S && window.__S.rp && window.__S.rp.racing)'), 250, 80);
  assert(racing, '12车单机进入竞速状态');
  await sleep(3000);

  const result = await evalPage(`(() => {
    const s = window.__S, cars = s.rp.cars || [];
    const names = cars.map(c => c.name);
    const colors = cars.map(c => c.color);
    const rows = [...document.querySelectorAll('#standList > *')];
    const plates = [...document.querySelectorAll('#nameplates > *')].filter(x => getComputedStyle(x).display !== 'none');
    const map = document.getElementById('minimap');
    const mapCard = document.querySelector('.map-card');
    return {
      count: cars.length,
      aiCount: cars.filter(c => c.ai).length,
      names, colors,
      uniqueNames: new Set(names).size,
      uniqueColors: new Set(colors).size,
      rows: rows.length,
      plateCount: plates.length,
      mapWidth: map && map.width,
      mapBg: map && getComputedStyle(map).backgroundColor,
      mapRadius: map && getComputedStyle(map).borderRadius,
      tire: cars[0] && { temp: cars[0].tireTemp, grip: cars[0].tireGrip, slip: cars[0].slipAngleDeg },
      mode: s.gameMode,
    };
  })()`);
  assert(result.count === 12 && result.aiCount === 11, `12车名册（AI ${result.aiCount}）`);
  assert(result.uniqueNames === 12 && result.names.every(Boolean), 'AI姓名唯一且非空');
  assert(result.uniqueColors >= 4 && result.colors.every(Boolean), `12车颜色已分散（${result.uniqueColors} 种）`);
  assert(result.rows <= 4, '计时塔最多显示4行');
  assert(result.plateCount <= 4, '车顶名牌最多显示最近4名');
  assert(result.mapWidth === 320 && result.mapBg === 'rgba(35, 39, 44, 0.52)' && result.mapRadius === '50%', '地图尺寸、半透明深灰圆形背景生效');
  assert(Array.isArray(result.tire.temp) && result.tire.temp.length === 4 && Number.isFinite(result.tire.grip), '硬胎温度与抓地状态可读');
  assert(result.mode === mode, `游戏模式生效（${mode}）`);
  if (exceptions.length) console.error('Runtime exceptions:', JSON.stringify(exceptions, null, 2));
  assert(exceptions.length === 0, 'Runtime.exceptionThrown 为零');
  console.log(JSON.stringify({ ...result, exceptions }, null, 2));
} catch (err) {
  console.error(err.stack || err);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  browser.kill();
  srv.kill();
}
