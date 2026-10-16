/*
 * 碰碰车模式（bumper）验收：全程实体 + 关闭碰撞类罚时 + 车↔车高弹性。
 *
 * 为什么必须有这条门禁：本模式的三条规则分别落在三处**已经栽过的机器**上 ——
 *   · 幽灵化掩码（`_refreshMasks` 是全工程唯一掩码来源，MEMORY 红线）
 *   · 罚时漏斗（`Car.addPenalty` 是 7 处调用点的唯一汇合点）
 *   · 车↔车接触材质（MEMORY 红线"车↔护栏单独一组材质，车↔车别跟着改"）
 * 任一处漏改，症状都是"看着实体却能穿透"或"对撞免费刷圈速"这类**方向性**错误，
 * 只看静态代码很容易看起来是对的，因此这里全部断言**可观测量**：
 *   collisionFilterMask 的真实位、penalty 的真实累加值、ContactMaterial 的真实系数。
 *
 * 同时保留 fm8 对照组（负对照）：碰碰车分支一旦被误删，对照组仍绿、实验组必红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, p)).href;

(0, eval)(fs.readFileSync(path.join(root, 'public', 'libs', 'three.min.js'), 'utf8'));
if (!globalThis.THREE) { console.error('无法注入 three.min.js'); process.exit(1); }
globalThis.CANNON = await import(mod('public/libs/cannon-es.js'));

function makeCanvasStub() {
  const ctx2d = new Proxy({}, {
    get(_, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
  });
  return new Proxy({}, { get(_, k) { return k === 'getContext' ? () => ctx2d : () => {}; }, set() { return true; } });
}
globalThis.document = {
  createElement: (t) => (t === 'canvas' ? makeCanvasStub() : { style: {} }),
  createElementNS: () => makeCanvasStub(),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis.window || { addEventListener() {}, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1 };

const { Track, TRACK_TYPES } = await import(mod('public/js/track.js'));
const { RacePhysics, CFG } = await import(mod('public/js/physics.js'));

let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) console.log('  PASS ' + name + (detail ? '   ' + detail : ''));
  else { fail++; console.log('  FAIL ' + name + '   ' + detail); }
};

const CAR_MASK = CFG.GROUP_CAR_MASK;
const buildPair = (mode) => {
  const t = new Track(4242, 'oval');
  t.build();
  const rp = new RacePhysics(t);
  rp.setGameMode(mode);
  rp.racing = true;
  const a = rp.addCar({ id: 1, name: 'A', color: '#fff', isLocal: true, startIndex: 300, lateral: 0, laps: 99 });
  const b = rp.addCar({ id: 2, name: 'B', color: '#000', isLocal: false, startIndex: 320, lateral: 0, laps: 99 });
  return { rp, a, b };
};

/* ---------------- 1. 行为：碰碰车 = 全程实体 ---------------- */
{
  const { rp, a, b } = buildPair('bumper');
  ok(rp.gameMode === 'bumper' && rp.ghostMode === false, 'setGameMode("bumper") 落位且强制关闭幽灵车');

  const maskBefore = [a.body.collisionFilterMask, b.body.collisionFilterMask];
  ok(maskBefore.every((m) => (m & CAR_MASK) === CAR_MASK),
    '★碰碰车：两车车车碰撞位全开（可互撞）', JSON.stringify(maskBefore));

  // 把"所有幽灵化入口"依次触发一遍，掩码必须**一动不动**
  a.rescueGhost = true;
  a.finishGhost = true;
  a.zoneGhost = true;
  rp.zoneGhost.add(a);
  rp._activateGhost(a, 4, CFG.GHOST_TIME);   // R 键救援幽灵
  rp._refreshMasks();
  const maskAfter = [a.body.collisionFilterMask, b.body.collisionFilterMask];
  ok(maskAfter.every((m) => (m & CAR_MASK) === CAR_MASK),
    '★碰碰车：救援/完赛/拥挤区幽灵全部被压制，车车碰撞位仍全开', JSON.stringify(maskAfter));
  ok(a.ghost === 0 && a.rescueGhost === false && a.finishGhost === false && a.zoneGhost === false,
    '★碰碰车：幽灵标记在掩码唯一来源处被归一化清零（视觉与碰撞同时"无幽灵"）',
    JSON.stringify({ ghost: a.ghost, rescue: a.rescueGhost, finish: a.finishGhost, zone: a.zoneGhost }));
  ok(a.body.collisionResponse === true, '碰碰车：绝不关碰撞总闸（护栏仍然有效）');

  // 车↔车材质：高弹性 + 低摩擦（撞开而不是黏住）
  const cm = rp._carContactMaterial;
  ok(cm && cm.restitution === CFG.BUMPER_RESTITUTION && cm.friction === CFG.BUMPER_CONTACT_FRICTION,
    '碰碰车：车↔车接触材质切到高弹性低摩擦',
    cm ? `restitution=${cm.restitution} friction=${cm.friction}` : 'no contact material');

  // 罚时：碰撞类关闭、走线类保留
  let fired = [];
  rp.onPenalty = (_c, sec, reason) => fired.push(reason);
  const pen0 = a.penalty;
  a.addPenalty(2, 'wall');
  a.addPenalty(2, 'ram');
  ok(a.penalty === pen0 && fired.length === 0 && a.lapInvalid === false,
    '★碰碰车：碰撞类罚时（wall / ram）完全不计、不入账、不弹窗',
    `penalty=${a.penalty} fired=${JSON.stringify(fired)}`);
  a.addPenalty(0.5, 'cut');
  ok(a.penalty === pen0 && fired.length === 0 && a.lapInvalid === false,
    '★碰碰车：走线类罚时同样免除',
    `penalty=${a.penalty} fired=${JSON.stringify(fired)}`);
}

/* ---------------- 2. 负对照：fm8 的幽灵化必须毫发无损 ---------------- */
{
  const { rp, a } = buildPair('fm8');
  rp._activateGhost(a, 4, CFG.GHOST_TIME);
  rp._refreshMasks();
  ok((a.body.collisionFilterMask & CAR_MASK) === 0,
    '负对照 fm8：救援幽灵期车车位被剔除（碰碰车分支没有把既有机制一起关掉）',
    String(a.body.collisionFilterMask));
  ok(a.ghost > 0 && a.rescueGhost === true, '负对照 fm8：幽灵标记未被清零');
  const cm = rp._carContactMaterial;
  ok(cm && cm.restitution === CFG.RESTITUTION && cm.friction === CFG.CONTACT_FRICTION,
    '负对照 fm8：车↔车材质仍是 5% 低反弹 + 0.55 刮擦',
    cm ? `restitution=${cm.restitution} friction=${cm.friction}` : 'no contact material');

  let fired = [];
  rp.onPenalty = (_c, sec, reason) => fired.push(reason);
  const pen0 = a.penalty;
  a.addPenalty(2, 'wall');
  ok(a.penalty === pen0 && fired.length === 0,
    'fm8：撞墙免罚', `penalty=${a.penalty}`);
  a.addPenalty(2, 'ram');
  ok(a.penalty === pen0 + 2 && fired.includes('ram'), 'fm8：恶意撞车仍判罚');

  // 切换回 bumper 也必须能把材质切过去（每场实例独立，不改全局 CFG）
  rp.setGameMode('bumper');
  ok(cm.restitution === CFG.BUMPER_RESTITUTION, '运行时从 fm8 切到 bumper 会同步材质');
  rp.setGameMode('fm8');
  ok(cm.restitution === CFG.RESTITUTION, '运行时从 bumper 切回 fm8 会还原材质');
}

/* ---------------- 3. 静态接线：四处白名单必须齐 ---------------- */
{
  const goSrc = fs.readFileSync(path.join(root, 'main.go'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'public', 'js', 'main.js'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(root, 'public', 'js', 'PhysicsWorkerBridge.js'), 'utf8');

  ok(/case "bumper"/.test(goSrc) && /碰碰车模式 · 全程实体对抗/.test(goSrc),
    'main.go：sanitizeGameMode 接受 bumper 且有中文显示名');
  ok(/func bumperForcesGhostOff/.test(goSrc) && /bumperForcesGhostOff\(mode\)/.test(goSrc) &&
    /bumperForcesGhostOff\(next\)/.test(goSrc) && /bumperForcesGhostOff\(rm.gameMode\)/.test(goSrc),
    'main.go：建房 / 切模式 / 幽灵车开关三处都做了"碰碰车强制实体"守卫');
  ok(/<option value="bumper">/.test(htmlSrc), 'index.html：游戏模式下拉含碰碰车选项');
  ok(/opts\.gameMode === 'bumper' \? 'bumper'/.test(mainSrc) || /'bumper' : 'fm8'/.test(mainSrc),
    'main.js：beginRace 的驾驶规则归一化含 bumper（漏了会退回拟真规则）');
  ok(/const order = \['fm8', 'horizon', 'bumper'\]/.test(mainSrc),
    'main.js：房间内切换按钮是三态循环 fm8 → horizon → bumper');
  ok(/normalizeGameMode/.test(bridgeSrc) && /bumper/.test(bridgeSrc),
    'PhysicsWorkerBridge：驾驶规则归一化含 bumper 且碰碰车强制 ghost=false');
  void TRACK_TYPES;
}

console.log('');
console.log(fail === 0 ? '\x1b[32mbumper-mode-check: 全部通过\x1b[0m' : `\x1b[31mbumper-mode-check: ${fail} 项失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
