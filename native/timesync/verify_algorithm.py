#!/usr/bin/env python3
"""ForzaTimeSynchronizer 算法数值验证（Python 镜像）。

存在意义：把 C++ 侧**完全相同的方程**用 Python 重写一遍并真跑，
用来独立验证算法本身的收敛性 / 不 Snap / 伸缩有界 / 硬同步阈值 ——
C++ 单测（forza_time_sync_test.cpp，50 项）是主要证据，本文件是**交叉复核**：
两条独立实现若给出同一结论，说明方程本身是对的，而不是某一处转写写对了。

镜像范围（与 C++ 口径严格对齐，改 C++ 必须同步改这里）：
  · PushPingSample(t1..t4)   -> rtt/offset、环形窗口、**前 20% 低 RTT 加权聚合**、硬同步
  · GetAdjustedDeltaTime(dt) -> clamp(err*gain, ±1.5%) / 生效偏移按实际 dt 推进 /
                                **死区内也连续微调**（不冻结残差）
  · Jitter                   -> 双向独立随机延迟 + 客户端 ppm 漂移 + 阶跃突变

与 C++ 的关键口径（别写回旧版）：
  window_size = 30（不是 24）、best_ratio = 0.20（不是取单点最小值）、
  hard_ns = 250ms（不是 200ms）、死区不冻结残差。
"""
import math

NS = 1_000_000_000
MS = 1_000_000
US = 1_000

MAX_WINDOW = 32
NO_SAMPLE = float("inf")


class Sync:
    def __init__(self, window_size=30, best_ratio=0.20, deadband_ns=1 * MS,
                 hard_ns=250 * MS, max_warp=0.015, gain=0.1, max_rtt_ns=500 * MS,
                 grace_ns=300 * MS):
        self.cfg = dict(window_size=window_size, best_ratio=best_ratio,
                        deadband_ns=deadband_ns, hard_ns=hard_ns, max_warp=max_warp,
                        gain=gain, max_rtt_ns=max_rtt_ns, grace_ns=grace_ns)
        self.window = [None] * MAX_WINDOW      # 环形缓冲
        self.head = 0
        self.count = 0
        self.best_rtt = NO_SAMPLE
        self.target = 0
        self.applied = 0
        self.last_t1 = None
        self.first_pong = None
        self.hard_synced = False
        self.warp = 0.0
        self.snaps = 0
        self.rejected = 0

    # ---------------- 滤波：前 20% 低 RTT 加权聚合 ----------------
    def best_set_size(self):
        k = int(self.cfg["window_size"] * self.cfg["best_ratio"])
        return max(1, min(self.cfg["window_size"], k))

    def weighted_best_offset(self):
        """窗口内 RTT 最低的前 k 个样本，按 1/(rtt+1ns) 加权平均 offset。

        扫描**从最新往最旧**，插入用严格 `>` —— 于是 RTT 打平时**最新的**保留
        （局域网里同刻度同链路的 RTT 精确相等很常见；若保留最旧，真实阶跃偏移
         会被历史压住，连 >250ms 的硬同步都触发不了）。
        """
        n = self.count
        if n == 0:
            self.best_rtt = NO_SAMPLE
            return 0
        k = min(self.best_set_size(), n)

        br, bo = [], []                    # 升序的小数组（索引 0 = 最小 RTT）
        for i in range(n - 1, -1, -1):     # 最新 -> 最旧
            rtt, off = self.window[(self.head - n + i) % MAX_WINDOW]
            if len(br) == k and rtt >= br[-1]:
                continue                   # 已满且不比最差的好 -> 剪掉
            pos = len(br)
            while pos > 0 and br[pos - 1] > rtt:   # 严格 > 才右移 => 同 RTT 保留最新
                if pos < k:
                    br.insert(pos, br[pos - 1])
                    bo.insert(pos, bo[pos - 1])
                    del br[pos - 1]
                    del bo[pos - 1]
                pos -= 1
            if pos < k:
                br.insert(pos, rtt)
                bo.insert(pos, off)
            else:
                br.append(rtt)
                bo.append(off)
            if len(br) > k:
                br = br[:k]
                bo = bo[:k]

        self.best_rtt = br[0]
        wsum = sum(1.0 / (float(r) + 1.0) for r in br)
        acc = sum((1.0 / (float(r) + 1.0)) * float(o) for r, o in zip(br, bo))
        return int(acc / wsum + (0.5 if acc >= 0 else -0.5))

    # ---------------- OnPong ----------------
    def on_pong(self, t1, t2, t3, t4):
        P = self.cfg
        if t2 < t1 or t3 < t2 or t4 < t1:
            self.rejected += 1
            return "SampleRejected"
        if self.last_t1 is not None and t1 <= self.last_t1:
            self.rejected += 1
            return "SampleRejected"

        rtt = (t4 - t1) - (t3 - t2)
        offset = ((t2 - t1) + (t3 - t4)) / 2.0
        if rtt < 0 or rtt > P["max_rtt_ns"]:
            self.rejected += 1
            return "SampleRejected"
        self.last_t1 = t1

        # 环形写入
        self.window[self.head] = (rtt, offset)
        self.head = (self.head + 1) % MAX_WINDOW
        if self.count < P["window_size"]:
            self.count += 1

        # 滤波：窗口内 RTT 最低的前 20% 加权聚合（不再取单点最小值）
        self.target = self.weighted_best_offset()

        if not self.hard_synced:
            if self.first_pong is None:
                self.first_pong = t4
            enough = self.count >= P["window_size"]
            in_grace = (t4 - self.first_pong) < P["grace_ns"]
            if enough or in_grace:
                self.applied = self.target          # 首次/宽限期直接对齐
            if enough:
                self.hard_synced = True
            return "None"

        err = self.target - self.applied
        if abs(err) > P["hard_ns"]:
            self.applied = self.target              # 唯一允许 Snap 的场景
            self.warp = 0.0
            self.snaps += 1
            return "HardResync"
        return "None"

    # ---------------- GetAdjustedDeltaTime ----------------
    def adjusted_dt(self, base_dt):
        P = self.cfg
        if not self.hard_synced:
            self.warp = 0.0
            return base_dt
        err = self.target - self.applied
        # ★ 死区内**也**按同一方程算 warp（残差小时它本来就极小，自然被 ±1.5% 夹住）。
        #   旧版在死区内 `warp=0; return base_dt` 且不推进 applied -> 残差被永久冻结，
        #   <1ms 的恒定漂移永远收敛不掉 = 物理 Tick 长期微抖动。这是本轮修掉的真实缺陷。
        err_sec = err / NS
        w = max(-P["max_warp"], min(P["max_warp"], err_sec * P["gain"]))
        self.warp = w
        warped = base_dt * (1.0 + w)
        # ★ 用**实际返回的 dt'** 推进生效偏移（与 warped 的定义严格自洽），
        #   不是 w*base_dt —— 否则一旦 dt' 被夹取，两者失配、残差永远不收敛。
        self.applied += int((warped - base_dt) * NS)
        return warped


class Jitter:
    """确定性 xorshift64*，与 C++ 侧同构"""
    def __init__(self, seed):
        self.s = seed or 0x9E3779B97F4A7C15

    def unit(self):
        s = self.s
        s ^= (s >> 12) & 0xFFFFFFFFFFFFFFFF
        s ^= (s << 25) & 0xFFFFFFFFFFFFFFFF
        s ^= (s >> 27) & 0xFFFFFFFFFFFFFFFF
        self.s = s
        x = (s * 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF
        return (x >> 11) / float(1 << 53)

    def rng(self, lo, hi):
        return lo + (hi - lo) * self.unit()


class Net:
    def __init__(self, seed, true_offset_ns=37 * MS, drift_ppm=50.0,
                 base_ms=4.0, jlo=20.0, jhi=120.0, proc_ns=120 * US):
        self.r = Jitter(seed)
        self.true_off = true_offset_ns
        self.ppm = drift_ppm
        self.base = base_ms
        self.jlo, self.jhi = jlo, jhi
        self.proc = proc_ns

    def drift(self, elapsed):
        return int(elapsed * self.ppm * 1e-6)

    def round(self, local):
        d_out = self.base + self.r.rng(self.jlo, self.jhi)
        d_back = self.base + self.r.rng(self.jlo, self.jhi)
        out = int(d_out * MS)
        back = int(d_back * MS)
        t1 = local
        t2 = t1 + out + self.true_off + self.drift(local)
        t3 = t2 + self.proc
        t4 = t1 + out + self.proc + back
        return t1, t2, t3, t4


def main():
    print("=== ForzaTimeSynchronizer 算法数值验证（Python 镜像）===\n")
    fails = []

    def check(ok, what, detail=""):
        print(("  PASS  " if ok else "  FAIL  ") + what + ("   " + detail if detail else ""))
        if not ok:
            fails.append(what)

    # ---- T3 抖动 20~120ms ----
    print("[T3] 网络抖动 20ms~120ms")
    sync = Sync()                       # 默认 window=30 / best_ratio=0.20 / hard=250ms
    net = Net(0xC0FFEE, true_offset_ns=37 * MS, drift_ppm=50.0, jlo=20.0, jhi=120.0)
    dt = 1.0 / 60.0
    local = 0
    max_warp = 0.0
    max_step = 0
    err_after_lock = 0
    locked_at = None
    for i in range(240):
        t1, t2, t3, t4 = net.round(local)
        sync.on_pong(t1, t2, t3, t4)
        # 关键：判据必须是**每帧**的变化量，不是每个采样周期的。
        # 上界 = maxWarpRatio * dt = 0.015 * 16.67ms = 0.25ms。
        # （按采样周期统计会得到 ~2ms/s 的"伪超标" —— 那是正常的 slew 速率，
        #   15ms/s 才是上限。）
        for f in range(60):
            fr_prev = sync.applied
            d = sync.adjusted_dt(dt)
            if sync.hard_synced:
                max_step = max(max_step, abs(sync.applied - fr_prev))
            max_warp = max(max_warp, abs(sync.warp))
            assert d > 0 and d <= dt * 1.02, "dt 越界"
            local += int(d * NS)
        if sync.hard_synced and locked_at is None:
            locked_at = local
        if sync.hard_synced and i > 24:
            truth = sync.applied  # 占位，下面用真实误差覆盖
        if sync.hard_synced and i > 24:
            truth_off = net.true_off + net.drift(local)
            err_after_lock = max(err_after_lock, abs(sync.applied - truth_off))

    check(sync.hard_synced, "抖动 20~120ms 下完成锁定")
    check(sync.snaps == 0, "稳态期间零硬同步", f"snaps={sync.snaps}")
    check(max_warp <= 0.015 + 1e-12, "伸缩比例始终 <= ±1.5%", f"maxWarp={max_warp:.6f}")
    check(max_step <= 260 * US, "生效偏移**单帧**变化 <= 0.26ms（=1.5%×dt，无硬跳）",
          f"maxStep={max_step/MS:.4f}ms")
    check(err_after_lock < 30 * MS, "锁定后残余误差 < 30ms（优于 50ms 理论最坏值）",
          f"残余={err_after_lock/MS:.2f}ms")
    check(locked_at is not None and locked_at < 30 * NS, "30 秒内完成锁定",
          f"lockedAt={locked_at/NS if locked_at else float('nan'):.1f}s")

    # ---- T4 1~100ms 阶跃不 Snap ----
    print("\n[T4] 偏差 80ms 只做连续微调")
    s2 = Sync()
    q = 3 * MS
    local = 0
    for i in range(40):
        s2.on_pong(local, local + q, local + q + US, local + q + US + q)
        for f in range(30):
            s2.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s2.hard_synced, "前置：已锁定")
    snaps_before = s2.snaps
    step = 80 * MS
    prev = s2.applied
    mx = 0
    for i in range(20):
        t1 = local
        s2.on_pong(t1, t1 + q + step, t1 + q + US + step, t1 + q + US + q)
        for f in range(60):
            s2.adjusted_dt(dt)
            mx = max(mx, abs(s2.applied - prev))
            prev = s2.applied
            local += int(dt * NS)
        local += NS
    check(s2.snaps == snaps_before, "80ms 阶跃未触发硬同步", f"snaps={s2.snaps}")
    check(mx <= 300 * US, "阶跃被摊成连续微调", f"maxStep={mx/MS:.4f}ms")
    check(s2.applied > 40 * MS, "确实在向 80ms 收敛", f"applied={s2.applied/MS:.2f}ms")

    # ---- T3b 阶跃突变抖动 0ms~150ms（规格指定的收敛性用例）----
    # 注意：单程延迟改变**不**改变 offset（offset = 真时钟差），所以只改延迟的
    # 测试是**空跑**（残差恒为 0，假绿）。必须同时注入一个真实 offset 阶跃。
    print("\n[T3b] 阶跃突变抖动 0ms~150ms（含 +120ms 真实 offset 阶跃，不许 Snap）")
    s5 = Sync()
    local = 0
    # A 段：空闲 0ms，先锁到 offset=+45ms
    A_OFF = 45 * MS
    for i in range(40):
        s5.on_pong(local, local + A_OFF, local + A_OFF + US, local + A_OFF + US)
        for f in range(30):
            s5.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s5.hard_synced, "A 段：已锁定（空闲 0ms）")

    snaps_before = s5.snaps
    # B 段：单程一步到 150ms（RTT 300ms），并叠加 +120ms 真实偏移阶跃（共 165ms < 250ms）
    B_OFF = A_OFF + 120 * MS
    ONE = 150 * MS
    max_warp5 = 0.0
    max_step5 = 0
    peak_res = 0
    prev = s5.applied
    for i in range(120):
        t1 = local
        s5.on_pong(t1, t1 + ONE + B_OFF, t1 + ONE + B_OFF + US, t1 + ONE + ONE + US)
        for f in range(60):
            d = s5.adjusted_dt(dt)
            assert d > 0 and d <= dt * 1.02, "dt 越界"
            max_warp5 = max(max_warp5, abs(s5.warp))
            max_step5 = max(max_step5, abs(s5.applied - prev))
            prev = s5.applied
            peak_res = max(peak_res, abs(s5.target - s5.applied))
            local += int(d * NS)
        local += NS

    check(s5.snaps == snaps_before, "★ 165ms 阶跃**未**触发硬同步（<250ms 阈值）", f"snaps={s5.snaps}")
    check(max_warp5 <= 0.015 + 1e-12, "伸缩比例 <= ±1.5%", f"maxWarp={max_warp5:.6f}")
    check(max_step5 <= 260 * US, "生效偏移单帧变化 <= 0.26ms（无硬跳）", f"maxStep={max_step5/MS:.4f}ms")
    check(peak_res > 50 * MS, "★ 非空跑守卫：确实观测到大残差（否则测试没测到东西）",
          f"峰值残差={peak_res/MS:.2f}ms")
    final_res = abs(s5.target - s5.applied)
    check(final_res < 0.5 * MS, "末态残差 < 0.5ms（真正收敛）", f"末态残差={final_res/MS:.4f}ms")

    # ---- T4b 死区内残差真正收敛（回归：旧实现会永久冻结）----
    print("\n[T4b] 死区内恒定 0.5ms 偏差必须收敛（旧实现冻结 -> 回归）")
    s6 = Sync()
    local = 0
    q2 = 5 * MS          # 单程 5ms，RTT 10ms；offset = +0.5ms（落在 1ms 死区内）
    bias = 500 * US
    for i in range(200):
        s6.on_pong(local, local + q2 + bias, local + q2 + US + bias, local + q2 + US + q2)
        for f in range(30):
            s6.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s6.hard_synced, "前置：已锁定")
    r6 = abs(s6.target - s6.applied)
    check(s6.applied > 300 * US, "★ 死区内的 0.5ms 偏差确实被消化（未被冻结）",
          f"applied={s6.applied/US:.1f}us")
    check(r6 < 150 * US, "★ 残差收敛到 0.15ms 内（不是永久冻结在 0.5ms）",
          f"残差={r6/US:.1f}us")

    # ---- T5 > 250ms 硬同步 ----
    print("\n[T5] 偏差 400ms 触发硬同步")
    s3 = Sync()
    local = 0
    for i in range(40):
        s3.on_pong(local, local + q, local + q + US, local + q + US + q)
        for f in range(20):
            s3.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    ev = "None"
    for i in range(10):
        t1 = local
        ev = s3.on_pong(t1, t1 + q + 400 * MS, t1 + q + US + 400 * MS, t1 + q + US + q)
        if ev == "HardResync":
            break
        local += NS
    check(ev == "HardResync", "400ms 偏差返回 HardResync")
    # Snap 后 applied 必须直接等于当前权威目标（残差归零），而不是"累积到 300ms 以上"
    check(abs(s3.target - s3.applied) == 0, "★ Snap 后残差严格归零（applied == target）",
          f"残差={(s3.target - s3.applied)/MS:.4f}ms")
    check(s3.applied > 250 * MS, "已对齐到 >250ms 的新时基", f"applied={s3.applied/MS:.1f}ms")

    # ---- T5b 反向守卫：200ms 未超阈值，不得 Snap ----
    print("\n[T5b] 偏差 200ms 位于阈值内侧，不得 Snap")
    s7 = Sync()
    local = 0
    for i in range(40):
        s7.on_pong(local, local + q, local + q + US, local + q + US + q)
        for f in range(20):
            s7.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    snaps0 = s7.snaps
    for i in range(10):
        t1 = local
        s7.on_pong(t1, t1 + q + 200 * MS, t1 + q + US + 200 * MS, t1 + q + US + q)
        for f in range(20):
            s7.adjusted_dt(dt)
            local += int(dt * NS)
        local += NS
    check(s7.snaps == snaps0, "200ms 未触发硬同步（阈值 250ms 守住了）", f"snaps={s7.snaps}")

    # ---- T7 非法/乱序 ----
    print("\n[T7] 非法与乱序样本")
    s4 = Sync()
    check(s4.on_pong(100 * MS, 50 * MS, 60 * MS, 200 * MS) == "SampleRejected", "T2<T1 被拒")
    big = 600 * MS
    check(s4.on_pong(1000 * MS, 1000 * MS + big, 1000 * MS + big + 1000,
                     1000 * MS + 2 * big) == "SampleRejected", "RTT>500ms 被拒")
    t1 = 5000 * MS
    check(s4.on_pong(t1, t1 + q, t1 + q + US, t1 + q + US + q) == "None", "正常样本被接受")
    check(s4.on_pong(t1 - 10 * MS, t1, t1 + US, t1 + 20 * MS) == "SampleRejected", "T1 回退被拒")

    print(f"\n结果：{'全部通过' if not fails else str(len(fails)) + ' 项失败'}")
    for f in fails:
        print("  ✗ " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
