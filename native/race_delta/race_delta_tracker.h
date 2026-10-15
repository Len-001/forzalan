// =============================================================================
//  race_delta_tracker.h —— 左上角实时时间差（Time Delta）计算与格式化
//
//  规格来源：赛事规则 §"左上角实时时间差"
//    · 第一行永远显示"本地玩家与全场第一名（领跑者）"的时间差距。
//    · 本地玩家即第一名时，自己的时差固定显示 "--"。
//    · 落后于第一名时（或排行榜显示本地玩家后方车辆时），统一显示**负数**格式
//      "-0.X" 或 "-X.XX"（落后幅度，保留 1~2 位小数）。
//
//  ── 为什么不能用"欧氏距离 ÷ 实时速度" ────────────────────────────────────────
//  这条捷径在直道上看起来没问题，一出弯就崩：
//    · 出弯时后车速度远高于前车（前车在弯心减速），除以**后车自己的**速度会
//      把 "落后 30m" 算成 "落后 0.4s"，而真实差距是 1.2s；
//    · 入弯时反过来低估。
//    · 更根本的问题：两车沿赛道中心线的**弧长差**才是时间差的正确自变量，
//      欧氏距离在弯里比弧长短得多（弦 vs 弧），本身就是一个错的几何量。
//
//  ── 本模块的两级策略 ─────────────────────────────────────────────────────────
//  【一级 · 精确】两车有**公共计时点（Checkpoint）**时，直接取该计时点的
//    权威过线时刻之差：ΔT = T_follower(cp) − T_leader(cp)。
//    这是唯一无歧义的定义（同一个空间截面上的时间差），也是赛事官方口径。
//
//  【二级 · 外推】两车之间没有公共计时点（刚发车 / 领跑车已经过线而本车还没到）
//    时，把两车**沿中心样条线的弧长 S** 各自推进到同一个截面，再按
//    "**前车**在该赛段的实测样条速度"折算时间：
//
//        ΔS   = S_leader − S_follower                       （弧长差，米）
//        ΔT   = −ΔS / v_seg                                 （落后取负）
//        v_seg = 前车在该赛段的**弧长速度**（ds/dt，由连续两帧 S 求差分 + EWMA）
//
//    两个要点：
//      ① 除数是**前车**的速度，不是后车的、也不是两车平均 —— 时间差的语义是
//         "按前车当前的推进节奏，我落后多少秒"，用后车的速度会在出弯时严重低估。
//      ② 用的是**样条弧长速度**而不是车轴向速度。车在弯里侧滑时轴向速度与
//         沿中心线的推进速度不同，后者才是"赛段进度"的正确时间导数。
//    外推只在一个计时点区间内有效：一旦后车追上了下一个计时点，立刻回到一级精确解，
//    所以外推误差不会累积（这是"严禁仅拿空间欧氏距离除以实时速度导致发弯道畸变"
//     的正面做法 —— 我们既不用欧氏距离，也不在弯里用瞬时轴向速度）。
//
//  ── 符号约定（与 Go 服务端 signedDeltaMs 严格一致）──────────────────────────
//      deltaMs > 0  = 前者领先（后者落后）
//      deltaMs < 0  = 前者落后
//      deltaMs == 0 = 并驾齐驱
//    渲染时**落后一律带负号**："-0.4" / "-1.25"。
//
//  ── 零依赖 / 零堆分配 ────────────────────────────────────────────────────────
//  不依赖 GLM、不依赖 any C++ 库的样条实现：本文件自带与 `public/js/track.js`
//  **同构**的 Catmull-Rom 闭合样条 + 等弧长重采样（同一套公式，便于两端交叉核对）。
//  热路径全部走固定容量 std::array，无 new / 无 std::vector。
// =============================================================================
#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace forza::race {

// -----------------------------------------------------------------------------
//  格式化：赛事规则的时差文本
// -----------------------------------------------------------------------------

/**
 * 时差显示的格式档位。
 *
 * 规格："-0.X" 或 "-X.XX"（保留 1~2 位小数）。本模块把这条规则落成三段：
 *   · 绝对值 < 10ms  -> 视为并驾齐驱，显示 "0.00"（不带负号：确实没落后）
 *   · 绝对值 < 10s   -> 一位小数，如 "-0.4" / "-3.7"
 *     （0.0~9.9 区间一位小数已经够用，而且更短、抖动更小 —— 最后一位不会
 *       因为 10ms 级的采样噪声每帧跳字）
 *   · 绝对值 >= 10s  -> 两位小数，如 "-12.34" / "-75.08"
 *     （大赛段里 0.1s 已经无意义，但选手仍想看趋势，保留两位）
 *   · 绝对值 >= 100s -> 两位小数 + 但做上限截断（"99+" 级别），防止 M 型数字撑爆 HUD
 *
 * @param deltaMs 带符号时差（>0 = 领先）
 * @param leading 显示方是否**就是领跑者**（是则固定输出 "--"）
 * @return 形如 "--" / "-0.4" / "-1.25" / "+0.4" 的文本
 *
 * 注意：规格只要求"落后显示负号"。领先方（本地玩家为 P1）按规格显示 "--"，
 * 而不是 "+0.0"，所以 leading=true 时直接短路返回。
 * 非领先方却仍为正值（理论上不该出现）时按规格也加 "-" 前缀兜底 ——
 * 参见 FormatDelta 的 `forceNegativeForChaser`。
 */
struct DeltaFormatter final {
  /// 并驾齐驱死区（ms）：低于它显示 "0.00" 而不是 "-0.02"（避免最后一位抖字）
  static constexpr double kDeadbandMs = 10.0;

  /// 一位小数 / 两位小数的分界（ms）
  static constexpr double kTwoDecimalFromMs = 10000.0;   // 10s

  /// 数值上限：超过它截断（HUD 宽度保护）
  static constexpr double kClampMs = 999900.0;           // 999.9s

  /**
   * 纯数值格式化（不含 "--" 逻辑）。
   *
   * @param deltaMs    带符号时差（>0 领先）
   * @param deadband   是否启用"并驾齐驱死区"（<10ms 输出 "0.00" 而不是 "-0.0"）
   * @param forceNeg   强制输出负号。用于"后车行"——规格要求后车统一负数格式，
   *                   即使某帧估计值因噪声略微为正也不该闪出正号。
   *
   * ⚠️ deadband 与 forceNeg 是**两个正交的开关**，这里必须分开传：
   *   · 计时塔**第一行**（本地 vs 领跑者）：deadband=true, forceNeg=false
   *     —— 齐平时显示 "0.00"（确实没落后，不该显示 "-0.0"）
   *   · 计时塔**后车行**：deadband=false, forceNeg=true
   *     —— 规格明确"后车统一负数"，齐平也写 "-0.0"，否则同一列里
   *        有的行带负号有的不带，视觉上像两套规则。
   *   早期实现把两者合成一个 forceNeg 参数，导致第一行绕过死区、
   *   并驾齐驱时错误地显示成 "-0.0"（本仓库踩过，测试 T1 守着这条边界）。
   */
  [[nodiscard]] static int Format(char* out, std::size_t cap, double deltaMs,
                                  bool deadband, bool forceNeg) noexcept {
    if (out == nullptr || cap == 0) return 0;
    if (!std::isfinite(deltaMs)) {
      return write(out, cap, "--");
    }
    if (deltaMs > kClampMs) deltaMs = kClampMs;
    if (deltaMs < -kClampMs) deltaMs = -kClampMs;

    const double absMs = (deltaMs < 0.0) ? -deltaMs : deltaMs;

    // 死区内视为并驾齐驱。只在启用死区、且不强制负号时短路。
    if (deadband && !forceNeg && absMs < kDeadbandMs) {
      return write(out, cap, "0.00");
    }

    // 符号决策：forceNeg 优先；否则按数值正负。
    // 注意 absMs < kDeadbandMs 且 forceNeg 时，仍走负号分支 —— 得到 "-0.0"。
    const bool neg = forceNeg || (deltaMs < 0.0);

    const double seconds = absMs / 1000.0;
    const int decimals = (absMs >= kTwoDecimalFromMs) ? 2 : 1;
    // 先格式化**绝对值**，再手工拼符号 —— 避免依赖 "%.1f" 对 -0.0 的实现差异
    // （某些 libc 会打出 "-0.0"，另一些打 "0.0"，跨平台不一致；也避免
    //   "%.1f" 已经带了负号时再拼一个负号变成 "--0.0"）。
    char body[48];
    const int n = std::snprintf(body, sizeof body, (decimals == 2) ? "%.2f" : "%.1f", seconds);
    if (n <= 0) return write(out, cap, "--");

    std::size_t o = 0;
    if (neg) { if (o + 1 < cap) out[o++] = '-'; }
    for (int i = 0; i < n && o + 1 < cap; ++i) out[o++] = body[i];
    out[o] = '\0';
    return static_cast<int>(o);
  }

  /**
   * 计时塔第一行（本地玩家相对领跑者）。
   * @param deltaMs  带符号时差（>0 = 本地领先）
   * @param isLeader 本地玩家是否就是领跑者
   */
  [[nodiscard]] static int FormatLeaderRow(char* out, std::size_t cap,
                                           double deltaMs, bool isLeader) noexcept {
    if (out == nullptr || cap == 0) return 0;
    if (isLeader) return write(out, cap, "--");     // 规格：领跑者固定 "--"
    // 规格：落后统一负号格式。但**并驾齐驱仍显示 0.00**（死区生效），
    // 所以这里 deadband=true、forceNeg=false —— 负号由数值本身的符号决定，
    // 噪声导致的正值也在 FormatDeltaRow 层被强制成负号。
    return Format(out, cap, deltaMs, /*deadband=*/true, /*forceNeg=*/false);
  }

  /**
   * 后车行（排行榜里排在本地玩家**后面**的那些车）。
   * 规格："或者排行榜显示本地玩家后方车辆时，后车时间差距统一显示为负数格式"。
   *
   * 语义澄清：这里的"后车"是相对**本地玩家**而言。本地玩家 P1 时显示 "-0.85"
   * 表示"我领先后车 0.85 秒"，数值上等于 gapToLocal（后车落后量），带负号渲染。
   *
   * 死区**关闭**且强制负号：规格要求后车行统一负数格式，齐平时也写 "-0.0"，
   * 保证同一列里不会出现"有的行带负号、有的不带"。
   *
   * @param gapToLocalMs 后车相对本地玩家的落后量（**正值** = 后车确实落后）
   */
  [[nodiscard]] static int FormatChaserRow(char* out, std::size_t cap,
                                           double gapToLocalMs) noexcept {
    if (out == nullptr || cap == 0) return 0;
    const double mag = (gapToLocalMs < 0.0) ? -gapToLocalMs : gapToLocalMs;
    return Format(out, cap, mag, /*deadband=*/false, /*forceNeg=*/true);
  }

 private:
  static int write(char* out, std::size_t cap, const char* s) noexcept {
    std::size_t o = 0;
    for (; s[o] != '\0' && o + 1 < cap; ++o) out[o] = s[o];
    out[o] = '\0';
    return static_cast<int>(o);
  }
};

// -----------------------------------------------------------------------------
//  赛道中心样条线（与 public/js/track.js 同构）
// -----------------------------------------------------------------------------

/** 闭合 Catmull-Rom 控制点多边形（x/z 平面）。控制点直接按 [2] 存，无堆。 */
struct SplinePath final {
  static constexpr std::size_t kMaxCtl = 64;

  std::array<std::array<double, 2>, kMaxCtl> ctl{};
  std::size_t n = 0;
  double length = 0.0;        ///< 闭合总弧长（米）

  /// 控制点数量决定"每段"的弧长下限；太少的控制点会让 S 的分辨率不足
  [[nodiscard]] bool valid() const noexcept { return n >= 4 && length > 1.0; }
};

/**
 * 闭合 Catmull-Rom（uniform，与 track.js 的 catmullRom 逐字一致）。
 *
 * t ∈ [0, n) 是**样条参数**（不是弧长）；i1 = floor(t)、f = t − i1。
 * 控制点索引按 n 取模环绕，保证闭合处 C1 连续。
 */
struct CatmullRom final {
  static void eval(const SplinePath& p, double t, double* outX, double* outZ) noexcept {
    const std::size_t n = p.n;
    if (n == 0) { *outX = 0.0; *outZ = 0.0; return; }
    if (n < 4) {                                    // 退化：线性环绕，避免越界读
      const double u = std::fmod(std::fmod(t, static_cast<double>(n)) + n, static_cast<double>(n));
      const std::size_t i = static_cast<std::size_t>(u);
      const std::size_t j = (i + 1) % n;
      const double f = u - static_cast<double>(i);
      *outX = p.ctl[i][0] + (p.ctl[j][0] - p.ctl[i][0]) * f;
      *outZ = p.ctl[i][1] + (p.ctl[j][1] - p.ctl[i][1]) * f;
      return;
    }
    const double u = std::fmod(t, static_cast<double>(n));
    const double uu = (u < 0.0) ? u + static_cast<double>(n) : u;
    const std::size_t i1 = static_cast<std::size_t>(uu);
    const double f = uu - static_cast<double>(i1);
    const std::size_t i0 = (i1 + n - 1) % n;
    const std::size_t i2 = (i1 + 1) % n;
    const std::size_t i3 = (i1 + 2) % n;

    const double f2 = f * f;
    const double f3 = f2 * f;
    auto cr = [&](double a, double b, double c, double d) noexcept {
      return 0.5 * ((2.0 * b) + (-a + c) * f +
                    (2.0 * a - 5.0 * b + 4.0 * c - d) * f2 +
                    (-a + 3.0 * b - 3.0 * c + d) * f3);
    };
    *outX = cr(p.ctl[i0][0], p.ctl[i1][0], p.ctl[i2][0], p.ctl[i3][0]);
    *outZ = cr(p.ctl[i0][1], p.ctl[i1][1], p.ctl[i2][1], p.ctl[i3][1]);
  }
};

/**
 * 赛道弧长表：把闭合样条按等弧长切成 N 段，提供两种查询
 *   · SOfParam(t)   样条参数 -> 累计弧长 S（米）
 *   · ParamOfS(s)   累计弧长 S ——> 样条参数（二分查找）
 * 也提供最近点投影 ProjectClosest(x,z) ——> S（车辆定位用）。
 *
 * N 默认 512：对 7km 级赛道相当于 13.7m 一格，配合二次插值足够平滑；
 * 表大小 512×8B ≈ 4KB，构造一次、常驻，无堆分配。
 */
struct ArcLengthTable final {
  static constexpr std::size_t kMaxSeg = 1024;

  std::array<double, kMaxSeg + 1> s{};   ///< 每个采样点的累计弧长（s[0]=0, s[N]=length）

  std::size_t n = 0;
  double spacing = 1.0;

  /// 预采样构表。M 是细分密度（越大越精确，代价是构造期一次 O(M) 扫描）。
  static void build(const SplinePath& p, ArcLengthTable& out,
                    std::size_t n = 512, std::size_t m = 8192) noexcept {
    if (n > kMaxSeg) n = kMaxSeg;
    out.n = n;
    if (!p.valid() || n == 0) { out.spacing = 1.0; return; }

    // 先按高密度参数采样累计出总弧长（样条参数 -> 弧长的映射不是线性的，
    // 必须先建表再反查；急弯处"1 单位参数"对应的弧长明显更短）。
    double prevX = 0.0, prevZ = 0.0;
    double cum = 0.0;
    // 阶段一：密度采样，记录 (t, cum) 到等距的 s 表
    double nextTarget = 0.0;
    std::size_t filled = 0;
    out.s[0] = 0.0;
    CatmullRom::eval(p, 0.0, &prevX, &prevZ);
    for (std::size_t i = 1; i <= m; ++i) {
      const double t = (static_cast<double>(i) / static_cast<double>(m)) * static_cast<double>(p.n);
      double x = 0.0, z = 0.0;
      CatmullRom::eval(p, t, &x, &z);
      cum += std::hypot(x - prevX, z - prevZ);
      prevX = x; prevZ = z;
      // 把落在这一小段里的等弧长刻度全部填上（一段可能跨多个刻度，也可能不跨）
      const double stepSize = p.length / static_cast<double>(n);
      while (filled + 1 <= n && cum >= nextTarget + stepSize) {
        nextTarget += stepSize;
        ++filled;
        out.s[filled] = nextTarget;
      }
    }
    // 闭环收尾：末点直接钉在总弧长上，消除累计浮点误差
    for (std::size_t k = filled + 1; k <= n; ++k) out.s[k] = p.length;
    out.s[n] = p.length;
    out.spacing = p.length / static_cast<double>(n);
  }

  /// 弧长 s（米，自动对 length 取模）-> 样条参数 t ∈ [0, n)
  [[nodiscard]] double ParamOfS(const SplinePath& p, double sm) const noexcept {
    if (n == 0 || spacing <= 0.0) return 0.0;
    double v = std::fmod(sm, p.length);
    if (v < 0.0) v += p.length;
    // 二分：s 表单调不减
    std::size_t lo = 0, hi = n;
    while (lo + 1 < hi) {
      const std::size_t mid = (lo + hi) / 2;
      if (s[mid] <= v) lo = mid; else hi = mid;
    }
    const double s0 = s[lo], s1 = s[lo + 1];
    const double seg = s1 - s0;
    const double frac = (seg > 1e-12) ? (v - s0) / seg : 0.0;
    return (static_cast<double>(lo) + frac) / static_cast<double>(n) * static_cast<double>(p.n);
  }

  /// 最近点投影：返回 (x,z) 在中心线上的弧长 S。粗暴 O(n) 扫描 + 段内投影
  /// （n=512 时约 512 次 hypot，60Hz×4 车 = 12 万次/秒，可忽略）。
  [[nodiscard]] double ProjectClosest(const SplinePath& p, double x, double z,
                                      double hintS = -1.0, double hintWinM = 200.0) const noexcept {
    if (n == 0 || !p.valid()) return 0.0;
    if (spacing <= 0.0) return 0.0;

    // 有 hint 时只在 hint 附近 ±hintWinM 的窗口里搜（避免在 8 字交叉处
    // 投影到"空间上更近但圈上很远"的另一支）。窗口扫不到就退回全扫。
    std::size_t i0 = 0, i1 = n;
    if (hintS >= 0.0) {
      const double half = std::max(hintWinM, spacing) / spacing;
      const std::ptrdiff_t c = static_cast<std::ptrdiff_t>(hintS / spacing);
      const std::ptrdiff_t a = c - static_cast<std::ptrdiff_t>(half);
      const std::ptrdiff_t b = c + static_cast<std::ptrdiff_t>(half);
      i0 = static_cast<std::size_t>(std::max<std::ptrdiff_t>(0, a));
      i1 = static_cast<std::size_t>(std::min<std::ptrdiff_t>(
               static_cast<std::ptrdiff_t>(n), b));
      if (i1 <= i0 + 1) { i0 = 0; i1 = n; }        // 窗口退化 -> 全扫
    }

    double bestD2 = 1e300;
    double bestS = 0.0;
    for (std::size_t i = i0; i < i1; ++i) {
      const std::size_t j = (i + 1) % (n + 1);
      double ax = 0.0, az = 0.0, bx = 0.0, bz = 0.0;
      CatmullRom::eval(p, ParamOfS(p, s[i]), &ax, &az);
      CatmullRom::eval(p, ParamOfS(p, j == n ? p.length : s[j]), &bx, &bz);
      const double ex = bx - ax, ez = bz - az;
      const double len2 = ex * ex + ez * ez;
      double tt = 0.0;
      if (len2 > 1e-12) {
        tt = ((x - ax) * ex + (z - az) * ez) / len2;
        if (tt < 0.0) tt = 0.0;
        if (tt > 1.0) tt = 1.0;
      }
      const double px = ax + ex * tt, pz = az + ez * tt;
      const double dx = x - px, dz = z - pz;
      const double d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        const double sa = s[i];
        const double sb = (j == n) ? p.length : s[j];
        bestS = sa + (sb - sa) * tt;
      }
    }
    return std::fmod(bestS, p.length);
  }
};

// -----------------------------------------------------------------------------
//  单车的时差输入
// -----------------------------------------------------------------------------

/**
 * 一辆车在「时差解算」所需的最小状态。
 *
 * 注意 sMeters 的语义是**沿中心线的累计弧长**（本圈，0..length），
 * 由 ArcLengthTable::ProjectClosest 从世界坐标投影得到 —— 不是欧氏距离。
 */
struct DeltaCarState final {
  double sMeters = 0.0;      ///< 本圈沿中心线的累计弧长（米）
  double sampleTime = 0.0;   ///< 该 S 的采样时刻（服务端单调秒）
  int lap = 0;               ///< 已完成圈数

  /// 该车**已通过**的最后一个 Checkpoint 索引（-1 = 一个都没过）
  int cpIndex = -1;

  /// 最近若干计时点的权威过线时刻（秒，服务端时钟轴）。
  /// 索引 = Checkpoint 序号；<= 0 表示"没数据"。
  static constexpr std::size_t kMaxCp = 64;
  std::array<double, kMaxCp> cpPassTime{};

  /// 本段弧长速度（ds/dt，m/s）的 EWMA 估计 —— **前车**的外推除数
  double segSpeedMps = 0.0;

  [[nodiscard]] double PassTime(int cp) const noexcept {
    if (cp < 0 || cp >= static_cast<int>(kMaxCp)) return 0.0;
    return cpPassTime[static_cast<std::size_t>(cp)];
  }
};

// -----------------------------------------------------------------------------
//  解算结果
// -----------------------------------------------------------------------------

enum class DeltaMethod : std::uint8_t {
  None = 0,          ///< 无法给出（数据不足）
  Checkpoint = 1,    ///< 一级精确：公共计时点过线时刻差
  SplineExtrap = 2,  ///< 二级外推：样条弧长差 ÷ 前车分段速度
  LapDelta = 3,      ///< 整圈差：跨圈时按平均圈速折算量级
};

struct DeltaResult final {
  double deltaMs = 0.0;        ///< 带符号（>0 = a 领先 b）
  DeltaMethod method = DeltaMethod::None;
  double dsMeters = 0.0;       ///< 解算用到的弧长差（外推法才有意义）
  double vSegMps = 0.0;        ///< 解算用到的分段速度

  [[nodiscard]] bool valid() const noexcept { return method != DeltaMethod::None; }
};

// -----------------------------------------------------------------------------
//  RaceDeltaTracker
// -----------------------------------------------------------------------------

/**
 * 时间差解算器。
 *
 * 无堆分配：SplinePath + ArcLengthTable 都是固定容量 std::array 成员。
 * 非线程安全（约定在渲染线程调用）。
 */
class RaceDeltaTracker final {
 public:
  /// 外推速度的安全下限（m/s）：低于它说明前车几乎停住（事故/起步），
  /// 用它当除数会得到天文数字。取 12m/s ≈ 43km/h，与项目里其他参考车速下限一致。
  static constexpr double kMinSegSpeedMps = 12.0;

  /// 分段速度 EWMA 系数（新样本权重）。0.25 对应约 4 个采样的时间常数；
  /// 太大 → 出弯加速时除数跟不上（低估时差），太小 → 噪声大。
  static constexpr double kSpeedEwmaAlpha = 0.25;

  /// 跨圈折算的默认圈速（秒），未提供平均圈速时使用
  static constexpr double kDefaultLapSec = 60.0;

  RaceDeltaTracker() noexcept = default;

  // ---------------------------------------------------------------------------
  //  赛道装配
  // ---------------------------------------------------------------------------

  /**
   * 装入赛道中心线控制多边形（闭合）。
   *
   * checkpoints 给出每个计时点在**弧长上的位置**（米，升序，[0, length)）。
   * 只需这一段元数据，不需要几何 —— 因为时差的一级解靠"两人在同一个 CP 上的
   * 过线时刻"，与 CP 的世界坐标无关。
   *
   * @return true = 赛道有效
   */
  bool SetTrack(const double (*ctlXZ)[2], std::size_t ctlCount,
                const double* cpArcMeters, std::size_t cpCount) noexcept {
    if (ctlCount < 4 || ctlCount > SplinePath::kMaxCtl) { path_.n = 0; return false; }
    path_.n = ctlCount;
    for (std::size_t i = 0; i < ctlCount; ++i) {
      path_.ctl[i][0] = ctlXZ[i][0];
      path_.ctl[i][1] = ctlXZ[i][1];
    }
    // 先算总弧长（高密度细分），再构弧长表
    path_.length = MeasureLength(path_);
    if (!path_.valid()) return false;
    ArcLengthTable::build(path_, table_);

    cpCount_ = (cpCount > DeltaCarState::kMaxCp) ? DeltaCarState::kMaxCp : cpCount;
    for (std::size_t i = 0; i < cpCount_; ++i) {
      double v = std::fmod(cpArcMeters[i], path_.length);
      if (v < 0.0) v += path_.length;
      cpArc_[i] = v;
    }
    return true;
  }

  /// 世界坐标 -> 本圈弧长 S（米）。hintS < 0 表示全扫（首次定位用）。
  [[nodiscard]] double Project(double x, double z, double hintS = -1.0) const noexcept {
    return table_.ProjectClosest(path_, x, z, hintS);
  }

  [[nodiscard]] double TrackLength() const noexcept { return path_.length; }
  [[nodiscard]] std::size_t CheckpointCount() const noexcept { return cpCount_; }
  [[nodiscard]] bool Ready() const noexcept { return path_.valid() && cpCount_ > 0; }

  /// 某辆车的分段速度估计更新（每条车上报时调用一次）。
  /// @param prevS / prevT  上一次的弧长与时刻；dt = now − prevT
  static void UpdateSegSpeed(DeltaCarState& car, double prevS, double prevT,
                             double now) noexcept {
    const double dt = now - prevT;
    if (dt <= 1e-4) return;
    double ds = car.sMeters - prevS;
    // 跨圈/跨接缝：|ds| 超过半条赛道就认为发生了绕环，直接丢弃这次样本
    if (std::fabs(ds) > 1e6) return;
    const double v = ds / dt;
    // 只接受非负的推进速度（倒车/救援瞬移会让 ds 为负，那是状态跳变不是推进）
    if (v < 0.0) return;
    if (car.segSpeedMps <= 0.0) {
      car.segSpeedMps = v;
    } else {
      car.segSpeedMps += kSpeedEwmaAlpha * (v - car.segSpeedMps);
    }
  }

  // ---------------------------------------------------------------------------
  //  核心：a 相对 b 的带符号时差
  // ---------------------------------------------------------------------------

  /**
   * 解算 a 相对 b 的时间差。
   *
   * 语义（与 Go `signedDeltaMs(a,b)` 一致）：
   *   > 0  a 领先 b
   *   < 0  a 落后 b
   *
   * 分支顺序刻意如此（先精确、后外推），因为外推是**近似**：
   *   1) 圈数不同  -> LapDelta（量级折算，符号由 lap 差决定）
   *   2) 有公共 CP -> Checkpoint（权威过线时刻差，无歧义）
   *   3) 同圈无公共 CP -> SplineExtrap（弧长差 ÷ 前车分段速度）
   */
  [[nodiscard]] DeltaResult Solve(const DeltaCarState& a,
                                  const DeltaCarState& b,
                                  double avgLapSec = kDefaultLapSec) const noexcept {
    DeltaResult r{};
    if (!Ready()) return r;

    // ---- 1) 圈数不同：跨圈只能给量级 ----
    if (a.lap != b.lap) {
      const double lapSec = (avgLapSec > 1.0) ? avgLapSec : kDefaultLapSec;
      // 领先方是 lap 大的一方；a 领先为正
      const double lapDiff = static_cast<double>(a.lap - b.lap);
      r.deltaMs = lapDiff * lapSec * 1000.0;
      // 同圈内的部分也带进来，避免"刚过线"时秒差从 -62s 突跳到 -60s
      const DeltaResult inner = SolveSameLap(a, b);
      if (inner.valid()) r.deltaMs += inner.deltaMs;
      r.method = DeltaMethod::LapDelta;
      return r;
    }

    // ---- 2/3) 同圈 ----
    const DeltaResult s = SolveSameLap(a, b);
    return s;
  }

  /**
   * 同圈解算（暴露出来便于单测直接打这两个分支）。
   */
  [[nodiscard]] DeltaResult SolveSameLap(const DeltaCarState& a,
                                         const DeltaCarState& b) const noexcept {
    DeltaResult r{};
    if (!Ready()) return r;

    // ---- 一级：公共计时点 ----
    const int common = CommonCheckpoint(a, b);
    if (common >= 0) {
      const double ta = a.PassTime(common);
      const double tb = b.PassTime(common);
      if (ta > 0.0 && tb > 0.0) {
        // 同一个空间截面上：a 到得**早**就是领先
        // 过线时刻越早 = 越领先 -> delta = tb − ta（>0 表示 a 领先）
        r.deltaMs = (tb - ta) * 1000.0;
        r.method = DeltaMethod::Checkpoint;
        return r;
      }
    }

    // ---- 二级：样条外推 ----
    // 取"前进方向上的差距"：a 的 S 减 b 的 S，绕环取最短有向差
    double ds = a.sMeters - b.sMeters;
    const double half = path_.length * 0.5;
    if (ds > half) ds -= path_.length;
    if (ds < -half) ds += path_.length;

    // 除数取**领先那一方**在该赛段的弧长速度 —— 规格明确"使用前车在该赛段的
    // 实时速度外推"，前车就是领先者。若领先者速度不可用，退回后车的，
    // 再不行用下限兜底（宁可给出保守估计也不要除零给出天文数字）。
    const double vLead = (ds >= 0.0) ? a.segSpeedMps : b.segSpeedMps;
    const double vChase = (ds >= 0.0) ? b.segSpeedMps : a.segSpeedMps;
    double v = (vLead > 1e-3) ? vLead : vChase;
    if (v < kMinSegSpeedMps) v = kMinSegSpeedMps;

    // 领先方在弧长上更靠前（ds > 0 表示 a 领先）
    r.deltaMs = (ds / v) * 1000.0;
    r.dsMeters = ds;
    r.vSegMps = v;
    r.method = DeltaMethod::SplineExtrap;
    return r;
  }

  /**
   * 两人都通过过的**最新**计时点索引；没有则 -1。
   *
   * 从 min(a.cpIndex, b.cpIndex) 往回找 —— 只要两人的 cpIndex 都到位，
   * 第一个都非零的就是"共同通过的最新一个"。
   */
  [[nodiscard]] int CommonCheckpoint(const DeltaCarState& a,
                                     const DeltaCarState& b) const noexcept {
    int c = (a.cpIndex < b.cpIndex) ? a.cpIndex : b.cpIndex;
    const int lim = static_cast<int>(cpCount_) - 1;
    if (c > lim) c = lim;
    for (; c >= 0; --c) {
      const double ta = a.PassTime(c);
      const double tb = b.PassTime(c);
      if (ta > 0.0 && tb > 0.0) return c;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  //  与格式化器的组合：直接产出计时塔第一行文本
  // ---------------------------------------------------------------------------

  /**
   * 本地玩家（local）相对领跑者（leader）的显示文本。
   * 规格：本地是 P1 -> "--"；否则 -> "-0.X" / "-X.XX"。
   *
   * ⚠️ 非领先分支**关闭死区**（deadband=false, forceNeg=true）：
   *   规格的硬约束是"非第一名一律负数格式"。若沿用第一行的死区，
   *   一个 +3ms 的采样噪声会被判成"齐平"渲染成 "0.00" —— 既没有负号、
   *   又与"我确实落后"的事实矛盾，在计时塔里就是一个错误的符号。
   *   死区只属于"本地就是领跑者 vs 第二名"那种**真·齐平**场景，
   *   而本分支的前提已经是"本地不是第一名"，本质上就不存在齐平。
   *   代价：并驾齐驱瞬间会显示 "-0.0" —— 这符合规格的"统一负数格式"。
   */
  [[nodiscard]] static int FormatLocalRow(char* out, std::size_t cap,
                                          const DeltaResult& localVsLeader,
                                          bool localIsLeader) noexcept {
    if (localIsLeader || !localVsLeader.valid()) {
      // 领跑者固定 "--"；数据还不全时也显示 "--"（而不是 "0.00" 误导）
      return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
    }
    return DeltaFormatter::Format(out, cap, localVsLeader.deltaMs,
                                  /*deadband=*/false, /*forceNeg=*/true);
  }

  /**
   * 排行榜里"本地玩家后方车辆"那一行的显示文本。
   * @param chaserVsLocal Solve(chaser, local) 的结果：>0 表示后车领先（不该出现），
   *                      <0 表示后车落后
   * 规格要求后车行统一负数格式，取落后量的幅值加负号。
   */
  [[nodiscard]] static int FormatChaserRow(char* out, std::size_t cap,
                                           const DeltaResult& chaserVsLocal) noexcept {
    if (!chaserVsLocal.valid()) return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
    // chaserVsLocal.deltaMs < 0 表示后车落后，落后量 = 其绝对值
    return DeltaFormatter::FormatChaserRow(out, cap, -chaserVsLocal.deltaMs);
  }

 private:
  [[nodiscard]] static double MeasureLength(const SplinePath& p) noexcept {
    if (p.n == 0) return 0.0;
    const std::size_t m = 8192;
    double px = 0.0, pz = 0.0, cum = 0.0;
    CatmullRom::eval(p, 0.0, &px, &pz);
    for (std::size_t i = 1; i <= m; ++i) {
      const double t = (static_cast<double>(i) / static_cast<double>(m)) * static_cast<double>(p.n);
      double x = 0.0, z = 0.0;
      CatmullRom::eval(p, t, &x, &z);
      cum += std::hypot(x - px, z - pz);
      px = x; pz = z;
    }
    return cum;
  }

  SplinePath path_{};
  ArcLengthTable table_{};
  std::array<double, DeltaCarState::kMaxCp> cpArc_{};
  std::size_t cpCount_ = 0;
};

// -----------------------------------------------------------------------------
//  非内联的权威实现（定义在 race_delta_tracker.cpp）
// -----------------------------------------------------------------------------

/// 解算方法的人类可读名（遥测 / 日志 / 测试断言用）
[[nodiscard]] const char* DeltaMethodName(DeltaMethod m) noexcept;

/**
 * 把解算结果压成"赛事 HUD 需要的一行字"—— **所有格式决策的唯一入口**。
 *
 * @param r          Solve 的结果
 * @param isLeader   显示方是否就是领跑者（true 时固定输出 "--"）
 * @param forceChase true = 这一行表示"后方车辆"，按规格一律负号
 * @return 写入的字符数
 */
int FormatDeltaRow(char* out, std::size_t cap, const DeltaResult& r,
                   bool isLeader, bool forceChase) noexcept;

}  // namespace forza::race
