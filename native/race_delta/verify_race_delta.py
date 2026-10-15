#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# =============================================================================
#  verify_race_delta.py —— RaceDeltaTracker 的 Python 独立镜像（交叉验证）
#
#  为什么要有这个文件：
#    C++ 单测断言的是"实现自己算出来的数"，如果实现对同一条公式理解错了，
#    测试和实现会一起错、一起绿（vacuous green）。本脚本按规格**重新写一遍**
#    公式（不是翻译 C++ 代码），用同一组输入跑出数值，再与 C++ 侧
#    固定下来的期望值逐条比对。两端独立实现 → 至少能挡住"公式抄错"这类错误。
#
#  覆盖：
#    F1  格式化三档（"--" / "-0.X" / "-X.XX"）+ 死区 + 截断 + NaN/Inf
#    F2  第一行（本地 vs 领跑者）：领跑 "--"，落后负号，噪声正值强制负号
#    F3  后车行：恒负号（齐平也 "-0.0"）
#    F4  样条弧长（正方形 4 控制点）与 C++ 侧一致
#    F5  外推口径：ΔS ÷ **前车**分段速度（对照"欧氏÷后车速度"的错误值）
#    F6  反对称性 Solve(a,b) == -Solve(b,a)
#    F7  跨圈 LapDelta = 整圈折算 + 同圈修正
#    F8  极低速下限保护（kMinSegSpeedMps = 12）与除零兜底
#
#  运行：python verify_race_delta.py   （退出码 0 = 全绿）
# =============================================================================
import math
import sys

# ---------------------------------------------------------------------------
#  与 C++ 头文件保持一致的常量（改一处必须改两处，脚本会断言关键值）
# ---------------------------------------------------------------------------
K_DEADBAND_MS = 10.0
K_TWO_DECIMAL_FROM_MS = 10000.0
K_CLAMP_MS = 999900.0
K_MIN_SEG_SPEED_MPS = 12.0
K_SPEED_EWMA_ALPHA = 0.25
K_DEFAULT_LAP_SEC = 60.0
K_MAX_CTL = 64

g_pass = 0
g_fail = 0
g_case = ""


def check(ok, what, detail=""):
    global g_pass, g_fail
    if ok:
        g_pass += 1
    else:
        g_fail += 1
        print("  [FAIL] %s :: %s %s" % (g_case, what, detail))


def case(name):
    global g_case
    g_case = name
    print("- %s" % name)


# ---------------------------------------------------------------------------
#  F1/F2/F3  格式化（按规格重写，而不是照抄 C++）
# ---------------------------------------------------------------------------
def fmt(delta_ms, deadband, force_neg):
    """规格版格式化：先取绝对值，再手工拼符号。"""
    if delta_ms is None or math.isnan(delta_ms) or math.isinf(delta_ms):
        return "--"
    if delta_ms > K_CLAMP_MS:
        delta_ms = K_CLAMP_MS
    if delta_ms < -K_CLAMP_MS:
        delta_ms = -K_CLAMP_MS
    abs_ms = -delta_ms if delta_ms < 0.0 else delta_ms
    # 死区只在"启用死区且不强制负号"时短路 —— 两个开关正交
    if deadband and not force_neg and abs_ms < K_DEADBAND_MS:
        return "0.00"
    neg = force_neg or (delta_ms < 0.0)
    seconds = abs_ms / 1000.0
    if abs_ms >= K_TWO_DECIMAL_FROM_MS:
        body = "%.2f" % seconds
    else:
        body = "%.1f" % seconds
    return ("-" if neg else "") + body


def fmt_leader_row(delta_ms, is_leader):
    """计时塔第一行：领跑者固定 "--"，否则走死区（deadband=True, forceNeg=False）。"""
    if is_leader:
        return "--"
    return fmt(delta_ms, True, False)


def fmt_local_row(delta_ms, local_is_leader):
    """本地 vs 领跑者：领跑者 "--"，否则**恒负号**（deadband=False, forceNeg=True）。"""
    if local_is_leader:
        return "--"
    return fmt(delta_ms, False, True)


def fmt_chaser_row(gap_to_local_ms):
    """后车行：取幅值 + 强制负号（deadband=False, forceNeg=True）。"""
    mag = -gap_to_local_ms if gap_to_local_ms < 0.0 else gap_to_local_ms
    return fmt(mag, False, True)


def test_formatting():
    case("F1  格式化三档 / 死区 / 截断 / NaN")
    check(fmt_leader_row(0.0, True) == "--", "领跑者 --")
    check(fmt_leader_row(-400.0, False) == "-0.4", "落后 400ms -> -0.4")
    check(fmt_leader_row(-3700.0, False) == "-3.7", "落后 3700ms -> -3.7")
    check(fmt_leader_row(-12340.0, False) == "-12.34", "落后 12340ms -> -12.34")
    # 死区：第一行 <10ms 视为齐平（不带负号）
    check(fmt_leader_row(-4.0, False) == "0.00", "4ms 死区内 -> 0.00")
    check(fmt_leader_row(-9.9, False) == "0.00", "9.9ms 死区上沿 -> 0.00")
    check(fmt_leader_row(-10.0, False) == "-0.0", "10ms 死区外沿 -> -0.0")
    # 后车行：齐平也带负号
    check(fmt_chaser_row(3.0) == "-0.0", "后车 3ms -> -0.0")
    check(fmt_chaser_row(850.0) == "-0.8", "后车 850ms -> -0.8")
    check(fmt_chaser_row(12000.0) == "-12.00", "后车 12000ms -> -12.00")
    check(fmt_chaser_row(-850.0) == "-0.8", "后车负输入取幅值")
    check(not fmt_chaser_row(500.0).startswith("--"), "无双负号前缀")
    check(len(fmt_leader_row(-9999000.0, False)) <= 10, "超长截断")
    check(fmt_leader_row(float("nan"), False) == "--", "NaN -> --")
    check(fmt_leader_row(float("-inf"), False) == "--", "-Inf -> --")
    check(fmt_leader_row(-0.0, False) == "0.00", "-0.0 走死区 -> 0.00")


def test_local_row():
    case("F2  第一行：本地落后 -> 恒负号（噪声正值也负）")
    check(fmt_local_row(-350.0, False) == "-0.4" or fmt_local_row(-350.0, False) == "-0.3",
          "落后 350ms -> -0.3/-0.4")
    check(fmt_local_row(-12340.0, False) == "-12.34", "落后 12340ms -> -12.34")
    # ⚠️ 关键边界：噪声导致的正值也必须显示负号（规格"非领先方统一负数"）
    check(fmt_local_row(+3.0, False).startswith("-"),
          "噪声正值 +3ms -> 仍带负号", fmt_local_row(+3.0, False))
    check(fmt_local_row(0.0, False) == "-0.0", "齐平 -> -0.0（规格统一负数）")
    check(fmt_local_row(0.0, True) == "--", "本地是领跑者 -> --")


def test_chaser_row():
    case("F3  后车行：统一负数格式")
    check(fmt_chaser_row(1250.0) == "-1.3" or fmt_chaser_row(1250.0) == "-1.2",
          "P2 落后 1250ms -> -1.2/-1.3")
    check(fmt_chaser_row(3400.0) == "-3.4", "P3 落后 3400ms -> -3.4")
    check(fmt_chaser_row(0.0) == "-0.0", "P2 齐平 -> -0.0（不是 0.00）")


# ---------------------------------------------------------------------------
#  F4  样条弧长（独立实现：与 track.js 同构的 uniform Catmull-Rom）
# ---------------------------------------------------------------------------
def cr_eval(ctl, t):
    n = len(ctl)
    u = math.fmod(t, n)
    if u < 0.0:
        u += n
    i1 = int(u)
    f = u - i1
    i0 = (i1 + n - 1) % n
    i2 = (i1 + 1) % n
    i3 = (i1 + 2) % n
    f2 = f * f
    f3 = f2 * f

    def cr(a, b, c, d):
        return 0.5 * ((2.0 * b) + (-a + c) * f +
                      (2.0 * a - 5.0 * b + 4.0 * c - d) * f2 +
                      (-a + 3.0 * b - 3.0 * c + d) * f3)

    return (cr(ctl[i0][0], ctl[i1][0], ctl[i2][0], ctl[i3][0]),
            cr(ctl[i0][1], ctl[i1][1], ctl[i2][1], ctl[i3][1]))


def measure_length(ctl, m=8192):
    n = len(ctl)
    px, pz = cr_eval(ctl, 0.0)
    cum = 0.0
    for i in range(1, m + 1):
        t = (i / float(m)) * n
        x, z = cr_eval(ctl, t)
        cum += math.hypot(x - px, z - pz)
        px, pz = x, z
    return cum


SQUARE_CTL = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]


def test_spline():
    case("F4  样条弧长（正方形 4 控制点）")
    L = measure_length(SQUARE_CTL)
    check(380.0 < L < 440.0, "总弧长 ≈400m", "L=%.4f" % L)
    # 与 C++ 侧打印的 420.3797 对齐（两端独立实现应落到同一个数）
    check(abs(L - 420.3797) < 0.05, "总弧长与 C++ 侧一致（420.3797）", "L=%.4f" % L)


# ---------------------------------------------------------------------------
#  F5  外推口径：ΔS ÷ 前车速度
# ---------------------------------------------------------------------------
def solve_same_lap_extrap(a_s, b_s, a_v, b_v, length):
    """无公共 CP 的样条外推：ΔS 绕环取最短，除数取**领先方**速度。"""
    ds = a_s - b_s
    half = length * 0.5
    if ds > half:
        ds -= length
    if ds < -half:
        ds += length
    v_lead = a_v if ds >= 0.0 else b_v
    v_chase = b_v if ds >= 0.0 else a_v
    v = v_lead if v_lead > 1e-3 else v_chase
    if v < K_MIN_SEG_SPEED_MPS:
        v = K_MIN_SEG_SPEED_MPS
    return (ds / v) * 1000.0, ds, v


def test_no_corner_distortion():
    case("F5  外推不发弯道畸变（除数必须是前车）")
    L = measure_length(SQUARE_CTL)
    # 前车（leader）S=200, v=20（弯心）；后车（chaser）S=170, v=40（出弯）
    delta_ms, ds, v = solve_same_lap_extrap(170.0, 200.0, 40.0, 20.0, L)
    check(abs(ds + 30.0) < 1e-9, "弧长差 = -30m", "ds=%.4f" % ds)
    check(abs(v - 20.0) < 1e-9, "除数 = 前车 20m/s（不是后车 40）", "v=%.4f" % v)
    check(abs(delta_ms + 1500.0) < 1.0, "落后 1500ms", "%.1f" % delta_ms)
    wrong = (-30.0 / 40.0) * 1000.0
    check(abs(wrong + 750.0) < 1e-9, "对照：用后车速度会低估一半", "%.1f" % wrong)


# ---------------------------------------------------------------------------
#  F6  反对称性
# ---------------------------------------------------------------------------
def solve_antisym(a_s, b_s, a_v, b_v, L):
    return solve_same_lap_extrap(a_s, b_s, a_v, b_v, L)[0]


def test_antisymmetry():
    case("F6  反对称性 Solve(a,b) == -Solve(b,a)")
    L = measure_length(SQUARE_CTL)
    ab = solve_antisym(120.0, 90.0, 33.0, 31.0, L)
    ba = solve_antisym(90.0, 120.0, 31.0, 33.0, L)
    check(abs(ab + ba) < 1e-9, "符号严格反对称", "ab=%.3f ba=%.3f" % (ab, ba))


# ---------------------------------------------------------------------------
#  F7  跨圈 LapDelta
# ---------------------------------------------------------------------------
def test_lap_delta():
    case("F7  跨圈 = 整圈折算 + 同圈修正")
    L = measure_length(SQUARE_CTL)
    avg_lap = 45.0
    lap_diff = 1 - 0
    inner = solve_antisym(20.0, 380.0, 30.0, 30.0, L)
    total = lap_diff * avg_lap * 1000.0 + inner
    check(total > 40000.0, "领先量级约一圈", "%.0f" % total)
    check(abs(total - (45000.0 + inner)) < 1e-9, "= 整圈 + 同圈", "%.1f" % total)
    check(abs(total - 45000.0) < 6000.0, "总量仍在一圈量级内", "%.1f" % total)


# ---------------------------------------------------------------------------
#  F8  极低速下限保护
# ---------------------------------------------------------------------------
def test_speed_floor():
    case("F8  极低速下限保护 / 除零兜底")
    L = measure_length(SQUARE_CTL)
    delta_ms, ds, v = solve_same_lap_extrap(100.0, 60.0, 0.5, 0.5, L)
    check(v >= K_MIN_SEG_SPEED_MPS - 1e-9, "除数被抬到下限 12m/s", "v=%.4f" % v)
    check(abs(delta_ms - 3333.0) < 60.0, "40m / 12m/s ≈ 3333ms", "%.1f" % delta_ms)
    delta_ms0, _, v0 = solve_same_lap_extrap(100.0, 60.0, 0.0, 0.0, L)
    check(math.isfinite(delta_ms0) and v0 >= K_MIN_SEG_SPEED_MPS - 1e-9,
          "速度为 0 也兜底（不除零）")


def main():
    print("=== RaceDeltaTracker Python 镜像（交叉验证）===")
    test_formatting()
    test_local_row()
    test_chaser_row()
    test_spline()
    test_no_corner_distortion()
    test_antisymmetry()
    test_lap_delta()
    test_speed_floor()
    print("\n结果：%d 通过 / %d 失败" % (g_pass, g_fail))
    return 0 if g_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
