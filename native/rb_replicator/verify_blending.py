#!/usr/bin/env python3
"""NetworkRigidBodyReplicator 数学验证（Python 镜像）。

为什么存在：本机没有 C++ 编译器（只有 go/node/python/git），无法编译
rigid_body_replicator_test.cpp。这里用与头文件**完全相同的公式**真跑一遍，
验证四个容易被写错、且肉眼难发现的定量性质：

  V1  半衰期语义：经过 T½ 秒，偏移必须恰好剩 50%
  V2  **帧率无关性**：60Hz 与 144Hz 下，经过相同墙钟时间偏移必须一致
      （这是"每帧乘固定系数"写法会失败的地方，也是最容易被忽略的坑）
  V3  纠偏瞬间视觉位置**连续**（零跳变）—— 双层解耦的全部意义所在
  V4  外推时长硬截断 150ms + 触顶后**阻尼滑行** + 传送保护（>snapDistanceM 直接吸附）
  V5  强制短弧（dot<0 反转）：-q 等价姿态不得被算成 358° 长弧
  V6  过期帧丢弃

注意：本文件验证算法，**不能替代 C++ 编译验证**，两者都要各自说清楚。
"""
import math

kIdentity = (1.0, 0.0, 0.0, 0.0)


# ----------------------------- 极简 GLM 等价物 -----------------------------
def v3(*a):
    return list(a) if len(a) == 3 else list(a[0])


def vadd(a, b):
    return [a[i] + b[i] for i in range(3)]


def vsub(a, b):
    return [a[i] - b[i] for i in range(3)]


def vmul(a, s):
    return [a[i] * s for i in range(3)]


def vlen(a):
    return math.sqrt(sum(x * x for x in a))


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def qconj(q):
    return (q[0], -q[1], -q[2], -q[3])


def qdot(a, b):
    return sum(a[i] * b[i] for i in range(4))


def qnorm(q):
    n = math.sqrt(sum(x * x for x in q))
    return kIdentity if n < 1e-12 else tuple(x / n for x in q)


def short_arc(ref, q):
    """强制短弧：dot(ref, q) < 0 时取 -q（与 C++ ShortArc 逐字一致）。"""
    return tuple(-x for x in q) if qdot(ref, q) < 0.0 else q


def qslerp(a, b, t):
    d = sum(a[i] * b[i] for i in range(4))
    if d < 0.0:
        b = tuple(-x for x in b)
        d = -d
    if d > 0.9995:
        return qnorm(tuple(a[i] + (b[i] - a[i]) * t for i in range(4)))
    th0 = math.acos(max(-1.0, min(1.0, d)))
    th = th0 * t
    s0 = math.sin(th0 - th) / math.sin(th0)
    s1 = math.sin(th) / math.sin(th0)
    return qnorm(tuple(a[i] * s0 + b[i] * s1 for i in range(4)))


def qangle(q):
    """glm::angle(q) 等价：绕轴旋转角 ∈ [0, π]"""
    w = max(-1.0, min(1.0, abs(q[0])))
    return 2.0 * math.acos(w)


def qaxis(angle, axis):
    l = math.sqrt(sum(x * x for x in axis))
    if l < 1e-9:
        return kIdentity
    axis = [x / l for x in axis]
    h = angle * 0.5
    s = math.sin(h)
    return (math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s)


# ----------------------------- 镜像核心 -----------------------------
class Repl:
    def __init__(self, half_life=0.080, max_extrap=0.150, accel_trust=0.100,
                 snap_dist=5.0, snap_ang=0.9, omega_trust=0.150,
                 coast_half_life=0.600):
        self.cfg = dict(half_life=half_life, max_extrap=max_extrap,
                        accel_trust=accel_trust, snap_dist=snap_dist,
                        snap_ang=snap_ang, omega_trust=omega_trust,
                        coast_half_life=coast_half_life)
        self.pos = [0.0, 0.0, 0.0]
        self.rot = kIdentity
        self.vel = [0.0, 0.0, 0.0]
        self.omega = [0.0, 0.0, 0.0]
        self.acc = [0.0, 0.0, 0.0]
        self.off_pos = [0.0, 0.0, 0.0]
        self.off_rot = kIdentity
        self.last_frame = 0
        self.extrap = 0.0
        self.has_state = False
        self.snaps = 0
        self.stale_dropped = 0
        self.coasting = False

    @staticmethod
    def decay_factor(dt, half_life):
        # k = 0.5^(dt/T½) = exp(-dt*ln2/T½)   —— ln2 不能漏
        return 0.0 if half_life <= 1e-6 else math.exp(-dt * math.log(2.0) / half_life)

    def on_snapshot(self, s):
        if self.has_state and s["frame"] <= self.last_frame:
            self.stale_dropped += 1
            return False
        if not self.has_state:
            self.pos = list(s["pos"])
            self.rot = qnorm(s["rot"])
            self.vel = list(s["vel"])
            self.omega = list(s["omega"])
            self.acc = list(s["acc"])
            self.off_pos = [0.0, 0.0, 0.0]
            self.off_rot = kIdentity
            self.last_frame = s["frame"]
            self.extrap = 0.0
            self.has_state = True
            return True

        # 0) 半球归一：把新快照旋转搬到与当前 rot 同半球
        new_rot = short_arc(self.rot, qnorm(s["rot"]))
        # 1) 记录当前视觉空间
        cur_vis_pos = vadd(self.pos, self.off_pos)
        cur_vis_rot = qnorm(qmul(self.rot, self.off_rot))
        # 2) 物理层直接采用权威状态
        self.pos = list(s["pos"])
        self.rot = new_rot
        self.vel = list(s["vel"])
        self.omega = list(s["omega"])
        self.acc = list(s["acc"])
        self.last_frame = s["frame"]
        self.extrap = 0.0
        self.coasting = False
        # 3) 误差转移进视觉层（误差四元数也取短弧）
        new_off_pos = vsub(cur_vis_pos, self.pos)
        new_off_rot = short_arc(kIdentity, qnorm(qmul(qconj(self.rot), cur_vis_rot)))
        # 4) 传送保护
        if vlen(new_off_pos) > self.cfg["snap_dist"] or qangle(new_off_rot) > self.cfg["snap_ang"]:
            self.off_pos = [0.0, 0.0, 0.0]
            self.off_rot = kIdentity
            self.snaps += 1
        else:
            self.off_pos = new_off_pos
            self.off_rot = new_off_rot
        return True

    def update(self, dt):
        if not self.has_state or dt <= 0:
            return
        # A) 航位推测：推进期 / 滑行期
        if self.extrap < self.cfg["max_extrap"] - 1e-6:
            room = self.cfg["max_extrap"] - self.extrap
            dte = min(dt, max(0.0, room))
            if dte > 0:
                a = self.acc if self.extrap < self.cfg["accel_trust"] else [0.0, 0.0, 0.0]
                self.pos = vadd(self.pos, vadd(vmul(self.vel, dte),
                                               vmul(a, 0.5 * dte * dte)))
                self.vel = vadd(self.vel, vmul(a, dte))
                if self.extrap < self.cfg["omega_trust"]:
                    wl = vlen(self.omega)
                    if wl > 1e-6:
                        dq = qaxis(wl * dte, self.omega)
                        self.rot = qnorm(qmul(self.rot, dq))
                self.extrap += dte
                self.coasting = False
        else:
            # A-2) 滑行期：位置仍按当前速度前进，但速度/角速度按 coast 半衰期衰减
            kc = self.decay_factor(dt, self.cfg["coast_half_life"])
            self.pos = vadd(self.pos, vmul(self.vel, dt))
            self.vel = vmul(self.vel, kc)
            self.omega = vmul(self.omega, kc)
            self.coasting = True

        # B) 双层误差衰减（衰减前重置半球，防长弧翻滚）
        k = self.decay_factor(dt, self.cfg["half_life"])
        self.off_pos = vmul(self.off_pos, k)
        self.off_rot = qnorm(qslerp(kIdentity, short_arc(kIdentity, self.off_rot), k))
        if sum(x * x for x in self.off_pos) < 1e-8:
            self.off_pos = [0.0, 0.0, 0.0]
        if abs(qdot(self.off_rot, kIdentity)) > 1.0 - 1e-9:
            self.off_rot = kIdentity

    def visual_pos(self):
        return vadd(self.pos, self.off_pos)

    def visual_rot(self):
        return qnorm(qmul(self.rot, self.off_rot))


def snap(frame, pos, rot=kIdentity, vel=(0.0, 0.0, 0.0), omega=(0.0, 0.0, 0.0), acc=(0.0, 0.0, 0.0)):
    return dict(frame=frame, pos=pos, rot=rot, vel=vel, omega=omega, acc=acc)


# ----------------------------- 验证 -----------------------------
def main():
    print("=== NetworkRigidBodyReplicator 数学验证（Python 镜像）===\n")
    fails = []

    def check(ok, what, detail=""):
        print(("  PASS  " if ok else "  FAIL  ") + what + ("   " + detail if detail else ""))
        if not ok:
            fails.append(what)

    HL = 0.090
    print("[V1] 半衰期语义")
    r = Repl(half_life=HL)
    r.on_snapshot(snap(1, (0, 0, 0)))
    r.update(1e-6)
    r.off_pos = [1.0, 0.0, 0.0]          # 人为塞 1m 横向误差
    # 一次推进恰好一个半衰期
    r.update(HL)
    ratio = vlen(r.off_pos) / 1.0
    check(abs(ratio - 0.5) < 1e-6, "经过 T½=90ms 偏移恰好剩 50%", f"ratio={ratio:.6f}")
    print(f"        （若误写成 exp(-dt/T½) 会得到 0.367879 —— 那是时间常数不是半衰期）")
    r2 = Repl(half_life=HL)
    r2.on_snapshot(snap(1, (0, 0, 0)))
    r2.update(1e-6)
    r2.off_pos = [1.0, 0.0, 0.0]
    for _ in range(3):
        r2.update(HL)
    check(abs(vlen(r2.off_pos) - 0.125) < 1e-6, "经过 3·T½ 剩 12.5%",
          f"{vlen(r2.off_pos):.6f}")

    print("\n[V2] 帧率无关性（最容易写错的地方）")
    # 关键：各刷新率下推进的**总墙钟时间必须严格相等**（180ms = 2 个半衰期），
    # 否则测的是"步数取整误差"而不是帧率无关性。
    # 取 n 使 0.180/n 恰好整除：n = 5/11/26/43 -> 约 28/61/144/239 Hz
    worst = 0.0
    for n in (5, 11, 26, 43):
        dt = 0.180 / n
        rr = Repl(half_life=HL)
        rr.on_snapshot(snap(1, (0, 0, 0)))
        rr.update(1e-6)
        rr.off_pos = [1.0, 0.0, 0.0]
        for _ in range(n):
            rr.update(dt)
        rem = vlen(rr.off_pos)
        hz = 1.0 / dt
        print(f"        {hz:6.1f}Hz ({n:2d} 步 × {dt*1000:5.2f}ms) -> 剩余 {rem:.6f} m")
        worst = max(worst, abs(rem - 0.25))
    check(worst < 1e-9, "28/61/144/239Hz 下 180ms 后剩余**完全相同** = 25%（帧率无关）",
          f"最大偏差 {worst:.2e}")

    print("\n[V3] 纠偏瞬间视觉位置连续（零跳变）")
    r3 = Repl(half_life=HL)
    r3.on_snapshot(snap(1, (0, 0, 0), vel=(30.0, 0.0, 0.0), acc=(0.0, 0.0, 0.0)))
    dt = 1.0 / 60.0
    for _ in range(12):                    # 跑 200ms，期间无新包 -> 在纯外推
        r3.update(dt)
    visual_before = list(r3.visual_pos())
    # 服务端纠偏：权威位置比外推值落后 0.8m（典型的位置回拉）
    authoritative = vsub(visual_before, [0.8, 0.0, 0.0])
    r3.on_snapshot(snap(2, authoritative, vel=(30.0, 0.0, 0.0)))
    visual_after = r3.visual_pos()
    jump = vlen(vsub(visual_after, visual_before))
    check(jump < 1e-9, "收到纠偏的**当帧**视觉位置零跳变",
          f"jump={jump:.3e} m（物理层已跳到权威值，视觉层吸收全部误差）")
    check(vlen(r3.off_pos) > 0.7, "误差确实被存进了视觉偏移层",
          f"|offset|={vlen(r3.off_pos):.3f} m")

    # 随后平滑收敛，且每帧位移连续
    max_frame_step = 0.0
    prev = list(visual_after)
    for _ in range(60):
        r3.update(dt)
        cur = r3.visual_pos()
        max_frame_step = max(max_frame_step, vlen(vsub(cur, prev)))
        prev = list(cur)
    check(vlen(r3.off_pos) < 0.01, "~1s 内视觉误差收敛到 1cm 内",
          f"|offset|={vlen(r3.off_pos)*1000:.2f} mm")
    check(max_frame_step < 30.0 * dt * 1.5, "每帧位移不超过车速 × dt 的 1.5 倍（无抽搐）",
          f"maxStep={max_frame_step*1000:.2f} mm/frame")

    print("\n[V4] 旋转误差用 slerp 衰减 + 传送保护")
    r4 = Repl(half_life=HL)
    r4.on_snapshot(snap(1, (0, 0, 0)))
    r4.update(1e-6)
    r4.off_rot = qaxis(math.radians(30.0), (0.0, 1.0, 0.0))   # 30° 姿态误差
    r4.update(HL)
    ang = math.degrees(qangle(r4.off_rot))
    check(abs(ang - 15.0) < 0.05, "姿态误差经过 T½ 恰好减半（slerp 与位置同节奏）",
          f"{ang:.3f}°")

    r5 = Repl(half_life=HL)
    r5.on_snapshot(snap(1, (0, 0, 0)))
    dt = 1.0 / 60.0
    for _ in range(12):
        r5.update(dt)
    far = vadd(r5.visual_pos(), [50.0, 0.0, 0.0])   # 传送级别（50m）
    r5.on_snapshot(snap(2, far))
    check(r5.snaps == 1 and vlen(r5.off_pos) < 1e-9,
          "误差 > snapDistanceM(5m) -> 直接吸附清零，不做长尾滑行",
          f"snaps={r5.snaps}")

    print("\n[V5] 外推硬截断 150ms + 触顶后阻尼滑行")
    r6 = Repl(half_life=HL, max_extrap=0.150)
    r6.on_snapshot(snap(1, (0, 0, 0), vel=(55.0, 0.0, 0.0)))   # 200km/h
    for _ in range(9):                                          # 恰好推进 150ms
        r6.update(dt)
    check(abs(r6.extrap - 0.150) < 1e-6, "外推时长被钉死在上限 150ms",
          f"extrap={r6.extrap:.3f}s")
    check(abs(r6.pos[0] - 55.0 * 0.150) < 1e-6,
          "推进期位移 = v × 150ms（不会一路飞出地图）", f"x={r6.pos[0]:.2f}m")
    x_cap = r6.pos[0]
    v_cap = vlen(r6.vel)
    for _ in range(60):                                         # 再滑 1 秒
        r6.update(dt)
    check(r6.coasting, "触顶后进入滑行期（coasting 标志置位）")
    check(vlen(r6.vel) < v_cap * 0.5, "滑行 1s 后速度衰减到 50% 以下（coast T½=0.6s）",
          f"{v_cap:.1f} -> {vlen(r6.vel):.2f} m/s")
    check(r6.pos[0] > x_cap + 1.0, "滑行期位置仍在前进（视觉上'还在滑'，非硬冻结）",
          f"多飞 {r6.pos[0]-x_cap:.1f}m（匀速假设会是 55.0m）")
    check(r6.pos[0] - x_cap < 55.0 * 0.8, "滑行位移显著小于'匀速飞出去'（阻尼生效）")

    print("\n[V6] 强制短弧（dot<0 反转，防长弧翻滚）")
    r8 = Repl(half_life=HL)
    base = qaxis(math.radians(1.0), (0.0, 1.0, 0.0))
    r8.on_snapshot(snap(1, (0, 0, 0), rot=base))
    r8.update(1e-6)
    neg_base = tuple(-x for x in base)
    r8.on_snapshot(snap(2, (0, 0, 0), rot=neg_base))
    off_ang = math.degrees(qangle(r8.off_rot))
    check(off_ang < 1.0, "-q 输入被判为同姿态（误差 <1°，不是 358°）",
          f"offset={off_ang:.3f}°")
    check(r8.snaps == 0, "不因 -q 误触发传送吸附", f"snaps={r8.snaps}")

    print("\n[V7] 过期帧丢弃")
    r7 = Repl()
    r7.on_snapshot(snap(10, (0, 0, 0)))
    r7.on_snapshot(snap(9, (5, 0, 0)))
    check(r7.stale_dropped == 1 and vlen(r7.pos) < 1e-9, "帧号回退的包被丢弃",
          f"dropped={r7.stale_dropped}")

    print(f"\n结果：{'全部通过' if not fails else str(len(fails)) + ' 项失败'}")
    for f in fails:
        print("  ✗ " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
