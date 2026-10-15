/**
 * verify_baumgarte.mjs —— 运行时验证 cannon Baumgarte 补丁的**真实效果**（可证伪）
 *
 *   node tools/verify_baumgarte.mjs
 *
 * 为什么需要这个脚本（而不是只靠 selftest 的静态守卫）：
 *   selftest 只能证明"补丁函数被调用了"，无法证明"它真的改变了物理"。
 *   本脚本在同一初始条件下跑两遍（补丁 OFF / ON），直接对比**撞墙反弹速度** ——
 *   这就是用户报的"赛车碰撞后依然弹开"的**直接观测量**。若两者相同，补丁即假绿。
 *
 * 退出码：0 = 补丁有效；1 = 未观察到效果（CI 应当失败）。
 */
const ROOT = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('..', import.meta.url)));
const CANNON = await import('file://' + ROOT + '/public/libs/cannon-es.js');
const CE = CANNON.ContactEquation;
const ORIGINAL = CE.prototype.computeB;

// 判据（可调）：补丁后反弹速度必须低于 0.1 m/s，且相对原版削减 ≥ 90%
const REBOUND_ABS_MAX = 0.1;      // m/s
const REBOUND_CUT_MIN = 0.90;     // 90%

function buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = 14;
  world.solver.tolerance = 0.002;
  const carMat = new CANNON.Material('car'), wallMat = new CANNON.Material('b');
  world.addContactMaterial(new CANNON.ContactMaterial(carMat, wallMat, {
    friction: 0.5, restitution: 0, contactEquationStiffness: 5e5, contactEquationRelaxation: 16,
  }));
  const car = new CANNON.Body({ mass: 1380, material: carMat, shape: new CANNON.Box(new CANNON.Vec3(2, 0.9, 0.6)) });
  car.position.set(0, 0, 0); car.velocity.set(55.556, 0, 0);
  car.__carId = 1;
  world.addBody(car);
  const wall = new CANNON.Body({ mass: 0, material: wallMat, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.7, 5)) });
  wall.position.set(6.0, 0, 0);
  wall.quaternion.setFromEuler(0, 0, +5 * Math.PI / 180);   // 法线带 +Y（朝车微抬）
  world.addBody(wall);
  return { world, car, wall };
}

function run(label, usePatch) {
  CE.prototype.computeB = usePatch ? (CE.prototype.__patched || ORIGINAL) : ORIGINAL;
  const { world, car } = buildWorld();
  const E = () => 0.5 * 1380 * (car.velocity.x ** 2 + car.velocity.y ** 2 + car.velocity.z ** 2);
  const E0 = E();
  let maxKE = E0, maxUpVy = 0;
  for (let i = 0; i < 60; i++) {
    world.step(1 / 60);
    const ke = E();
    if (ke > maxKE) maxKE = ke;
    if (car.velocity.y > maxUpVy) maxUpVy = car.velocity.y;
  }
  return {
    label,
    dKE: maxKE - E0,        // 碰撞过程中动能峰值 - 初动能（>0 = 注入）
    dKEPct: (maxKE - E0) / E0 * 100,
    maxUpVy,                // ★ 向上速度峰值
    vxEnd: car.velocity.x,
    // ★★ 反弹速度：撞墙后朝 −x（离开墙）的速度幅值。
    //    这是"车被弹开"的**直接观测量** —— 规格要求接近 0。
    rebound: Math.max(0, -car.velocity.x),
    reboundKE: (car.velocity.x < 0) ? 0.5 * 1380 * car.velocity.x ** 2 : 0,
  };
}

const off = run('补丁 OFF（原版）', false);
const { installCannonBaumgarteKill } = await import('file://' + ROOT + '/public/js/physics.js');
const installed = installCannonBaumgarteKill();
CE.prototype.__patched = CE.prototype.computeB;
const on = run('补丁 ON（修复）', true);

const f = (r) => `${r.label.padEnd(14)} 反弹速度=${r.rebound.toFixed(4).padStart(8)} m/s ` +
  `反弹动能=${r.reboundKE.toFixed(1).padStart(8)} J 向上vy峰值=${r.maxUpVy.toFixed(4).padStart(8)} ` +
  `ΔKE=${r.dKE.toFixed(2).padStart(8)} J`;

console.log('=== 1380kg 车 200km/h 撞静态墙（无重力），补丁 ON/OFF 对比 ===');
console.log('（"反弹速度" = 撞墙后朝离开墙方向的速度，越小表示越不弹）');
console.log();
console.log(f(off));
console.log(f(on));
console.log();
console.log(`补丁安装返回：${installed}（true = 原型补丁已就位）`);
console.log();
console.log(`反弹速度削减 = ${(off.rebound - on.rebound).toFixed(4)} m/s`);
console.log(`反弹动能削减 = ${(off.reboundKE - on.reboundKE).toFixed(1)} J`);
console.log();
if (off.rebound > 0.1 && on.rebound < off.rebound * 0.2) {
  console.log(`✓ 补丁把撞墙反弹从 ${off.rebound.toFixed(3)} m/s 压到 ${on.rebound.toFixed(4)} m/s ` +
    `（削减 ${(100 * (1 - on.rebound / off.rebound)).toFixed(1)}%）`);
} else if (off.rebound <= 0.1) {
  console.log(`⚠ 原版反弹本就很小（${off.rebound.toFixed(4)} m/s）—— 本场景信号不足`);
} else {
  console.log(`✗ 补丁未显著削减反弹`);
}

// ── 退出码判定（CI 用）──────────────────────────────────────────────────────
const cut = (off.rebound > 1e-9) ? (1 - on.rebound / off.rebound) : 0;
const passAbs = on.rebound <= REBOUND_ABS_MAX;
const passCut = cut >= REBOUND_CUT_MIN;
console.log();
console.log(`判据：补丁后反弹 ≤ ${REBOUND_ABS_MAX} m/s (实测 ${on.rebound.toFixed(4)}) ${passAbs ? '✓' : '✗'}`);
console.log(`      相对原版削减 ≥ ${(REBOUND_CUT_MIN * 100).toFixed(0)}% (实测 ${(cut * 100).toFixed(1)}%) ${passCut ? '✓' : '✗'}`);
const ok = passAbs && passCut;
console.log();
console.log(ok ? 'BAUMGARTE PATCH VERIFIED' : 'BAUMGARTE PATCH FAILED');
process.exit(ok ? 0 : 1);
