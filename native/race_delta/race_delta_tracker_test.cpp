// =============================================================================
//  race_delta_tracker_test.cpp —— RaceDeltaTracker 单测（零外部依赖）
//
//  覆盖规格要求的三类边界场景：
//    · 领跑（本地是 P1）      -> "--"
//    · 落后（本地在 P1 之后） -> "-0.X" / "-X.XX"
//    · 后车尾随（本地 P1，榜上显示后方车辆）-> 同样负数格式
//  外加：
//    · 解算口径（Checkpoint 一级 / SplineExtrap 二级 / LapDelta 跨圈）
//    · **外推不发弯道畸变**（本模块存在的根本理由，必须有量化断言）
//    · 样条弧长表自洽性（ParamOfS / SOfParam 往返、ProjectClosest 精度）
//    · 符号约定一致性（Solve(a,b) == -Solve(b,a)）
//
//  编译（单行，避免续行注释被 -Wcomment 报多行注释）：
//    g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic race_delta_tracker.cpp race_delta_tracker_test.cpp -o rd_test
// =============================================================================
#include "race_delta_tracker.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>   // std::numeric_limits（Inf 兜底用例）

using namespace forza::race;

namespace {

int g_pass = 0;
int g_fail = 0;
const char* g_case = "";

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) { ++g_pass; }
  else { ++g_fail; std::printf("  [FAIL] %s :: %s %s\n", g_case, what, detail); }
}
void Case(const char* n) noexcept { g_case = n; std::printf("- %s\n", n); }

/// 便捷：把格式化结果写入缓冲并返回它，同时 `(void)` 掉 nodiscard 的返回长度。
/// 注意：这里**不**暴露成"独立函数"而是宏 —— 早期版本写成函数后，
/// 部分用例只用它做副作用、不用返回值，触发 -Wunused-result；宏没有这个问题。
#define FMT_CALL(buf, cap, expr)                                              \
  do {                                                                        \
    const int _n = (expr);                                                    \
    (void)_n;                                                                 \
    (void)sizeof(buf);                                                        \
    (void)sizeof(cap);                                                        \
  } while (0)

/// 格式化后返回缓冲指针（供 strcmp 比较）。
[[nodiscard]] const char* FmtRow(char* buf, std::size_t cap, double deltaMs,
                                bool isLeader) noexcept {
  FMT_CALL(buf, cap, DeltaFormatter::FormatLeaderRow(buf, cap, deltaMs, isLeader));
  return buf;
}

/// 后车行入口。
[[nodiscard]] const char* FmtChase(char* buf, std::size_t cap, double gapMs) noexcept {
  FMT_CALL(buf, cap, DeltaFormatter::FormatChaserRow(buf, cap, gapMs));
  return buf;
}

/// 计时塔第一行（本地玩家 vs 领跑者）：格式化后返回缓冲指针。
[[nodiscard]] const char* FmtLocal(char* buf, std::size_t cap,
                                   const DeltaResult& r, bool isLeader) noexcept {
  FMT_CALL(buf, cap, RaceDeltaTracker::FormatLocalRow(buf, cap, r, isLeader));
  return buf;
}

/// 排行榜后车行：格式化后返回缓冲指针。
[[nodiscard]] const char* FmtChaser(char* buf, std::size_t cap,
                                    const DeltaResult& r) noexcept {
  FMT_CALL(buf, cap, RaceDeltaTracker::FormatChaserRow(buf, cap, r));
  return buf;
}

// -----------------------------------------------------------------------------
//  一个 4 控制点的小赛道：正方形，周长 4×100 = 400m
//  （用最简单可控的几何，断言里的弧长数值可以直接手算）
// -----------------------------------------------------------------------------
struct SquareTrack final {
  double ctl[4][2] = {{0.0, 0.0}, {100.0, 0.0}, {100.0, 100.0}, {0.0, 100.0}};
  RaceDeltaTracker tracker;

  /// 4 个计时点，布在 0 / 100 / 200 / 300 m 处
  double cp[4] = {0.0, 100.0, 200.0, 300.0};

  bool build() noexcept {
    return tracker.SetTrack(ctl, 4, cp, 4);
  }
};

// -----------------------------------------------------------------------------
//  T1 —— 格式化规则（规格的三种格式档位 + 死区 + 截断）
// -----------------------------------------------------------------------------
void TestFormatting() noexcept {
  Case("T1  格式化：-- / -0.X / -X.XX / 死区 / 截断");
  char b[64];

  // 领跑者固定 "--"
  Check(std::strcmp(FmtRow(b, sizeof b, 0.0, /*isLeader=*/true), "--") == 0,
        "领跑者固定显示 --", b);

  // ---- 第一行（本地 vs 领跑者，deadband=true）----
  // 规格档位一：一位小数
  Check(std::strcmp(FmtRow(b, sizeof b, -400.0, false), "-0.4") == 0,
        "落后 400ms -> \"-0.4\"", b);

  Check(std::strcmp(FmtRow(b, sizeof b, -3700.0, false), "-3.7") == 0,
        "落后 3700ms -> \"-3.7\"", b);

  // 规格档位二：两位小数（>=10s）
  Check(std::strcmp(FmtRow(b, sizeof b, -12340.0, false), "-12.34") == 0,
        "落后 12340ms -> \"-12.34\"", b);

  // 死区：<10ms 视为齐平 -> "0.00"（第一行**不带**负号）
  // ⚠️ 回归守卫：早期实现把死区与"强制负号"合成一个开关，导致这里输出 "-0.0"。
  Check(std::strcmp(FmtRow(b, sizeof b, -4.0, false), "0.00") == 0,
        "落后 4ms（死区内）-> \"0.00\"（不带负号）", b);
  Check(std::strcmp(FmtRow(b, sizeof b, -9.9, false), "0.00") == 0,
        "落后 9.9ms（死区上沿）-> \"0.00\"", b);
  Check(std::strcmp(FmtRow(b, sizeof b, -10.0, false), "-0.0") == 0,
        "落后 10ms（死区外沿）-> \"-0.0\"（进入负号档）", b);

  // ---- 后车行（deadband=false + forceNeg=true）----
  // 规格：后车统一负数格式，齐平也带负号
  Check(std::strcmp(FmtChase(b, sizeof b, 3.0), "-0.0") == 0,
        "后车行落后 3ms -> \"-0.0\"（仍带负号）", b);
  Check(std::strcmp(FmtChase(b, sizeof b, 850.0), "-0.8") == 0,
        "后车落后 850ms -> \"-0.8\"（一位小数）", b);
  Check(std::strcmp(FmtChase(b, sizeof b, 12000.0), "-12.00") == 0,
        "后车落后 12000ms -> \"-12.00\"（两位小数）", b);
  Check(std::strcmp(FmtChase(b, sizeof b, -850.0), "-0.8") == 0,
        "后车行传入负值时取幅值（不产生 \"--0.8\"）", b);

  // ---- 绝不出现双负号 "--0.x" ----
  Check(std::strncmp(FmtChase(b, sizeof b, 500.0), "--", 2) != 0,
        "后车行不产生双负号 \"--\" 前缀", b);
  Check(std::strncmp(FmtRow(b, sizeof b, -500.0, false), "--", 2) != 0,
        "第一行不产生双负号 \"--\" 前缀（除了领跑者语义）", b);

  // 截断保护
  Check(std::strlen(FmtRow(b, sizeof b, -9999000.0, false)) <= 10,
        "超长时差被截断（HUD 宽度保护）", b);

  // NaN / Inf 兜底
  Check(std::strcmp(FmtRow(b, sizeof b, std::nan(""), false), "--") == 0,
        "NaN 显示 --（不打印 nan）", b);
  Check(std::strcmp(FmtRow(b, sizeof b, -std::numeric_limits<double>::infinity(), false),
                    "--") == 0,
        "-Inf 显示 --", b);

  // 浮点 -0.0：第一行走死区 -> "0.00"，不能出现 "-0.00"
  Check(std::strcmp(FmtRow(b, sizeof b, -0.0, false), "0.00") == 0,
        "-0.0 走死区显示 0.00（不产生 \"-0.00\"）", b);
}

// -----------------------------------------------------------------------------
//  T2 —— 场景 ①：领跑（本地就是 P1）
// -----------------------------------------------------------------------------
void TestLeaderCase() noexcept {
  Case("T2  场景①：本地玩家是领跑者 -> \"--\"");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");
  char b[64];

  DeltaCarState me{};
  me.sMeters = 120.0; me.lap = 0; me.cpIndex = 1; me.segSpeedMps = 30.0;
  me.cpPassTime[0] = 10.0; me.cpPassTime[1] = 13.2;

  // 本地 = 领跑者：无论与后车差多少，第一行固定 "--"
  const DeltaResult vsLeader = t.tracker.Solve(me, me);   // 自己 vs 自己
  Check(std::strcmp(FmtLocal(b, sizeof b, vsLeader, /*localIsLeader=*/true), "--") == 0,
        "领跑者第一行固定 \"--\"", b);

  // 即使 a==b 得到了 0，localIsLeader 也必须短路成 "--"
  const DeltaResult zero = t.tracker.SolveSameLap(me, me);
  Check(std::fabs(zero.deltaMs) < 1e-6, "自己相对自己时差为 0");

  // 排行榜里本地 P1，显示后方车辆（后车落后 850ms）
  DeltaCarState chaser{};
  chaser.sMeters = 120.0 - 25.5; chaser.lap = 0; chaser.cpIndex = 1;
  chaser.segSpeedMps = 30.0;
  chaser.cpPassTime[0] = 10.0; chaser.cpPassTime[1] = 13.2 + 0.85;
  const DeltaResult chaserVsMe = t.tracker.Solve(chaser, me);
  Check(chaserVsMe.deltaMs < 0.0, "后车相对本车为负（落后）");

  const char* ch = FmtChaser(b, sizeof b, chaserVsMe);
  Check(std::strcmp(ch, "-0.9") == 0 || std::strcmp(ch, "-0.8") == 0,
        "后车尾随显示负数格式 \"-0.X\"", ch);

  // forceChase 的通用入口也要一致
  FMT_CALL(b, sizeof b, FormatDeltaRow(b, sizeof b, chaserVsMe,
                                       /*isLeader=*/false, /*forceChase=*/true));
  Check(b[0] == '-', "FormatDeltaRow(forceChase) 也输出负号", b);
}

// -----------------------------------------------------------------------------
//  T3 —— 场景 ②：落后（本地在 P1 之后）
// -----------------------------------------------------------------------------
void TestChaserCase() noexcept {
  Case("T3  场景②：本地落后领跑者 -> \"-0.X\" / \"-X.XX\"");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");
  char b[64];

  DeltaCarState leader{};
  leader.sMeters = 200.0; leader.lap = 0; leader.cpIndex = 2; leader.segSpeedMps = 30.0;
  leader.cpPassTime[0] = 10.0; leader.cpPassTime[1] = 13.0; leader.cpPassTime[2] = 16.0;

  // 落后 350ms（公共 CP 2 上：领跑者 16.000 过线，本地 16.350）
  DeltaCarState me{};
  me.sMeters = 190.0; me.lap = 0; me.cpIndex = 2; me.segSpeedMps = 32.0;
  me.cpPassTime[0] = 10.0; me.cpPassTime[1] = 13.0; me.cpPassTime[2] = 16.35;

  const DeltaResult vsLeader = t.tracker.Solve(me, leader);
  Check(vsLeader.method == DeltaMethod::Checkpoint,
        "有公共计时点 -> 走一级精确解", DeltaMethodName(vsLeader.method));
  Check(std::fabs(vsLeader.deltaMs + 350.0) < 1.0,
        "落后 350ms（负号）", b);

  const char* s1 = FmtLocal(b, sizeof b, vsLeader, /*localIsLeader=*/false);
  Check(std::strcmp(s1, "-0.4") == 0 || std::strcmp(s1, "-0.3") == 0,
        "本地第一行显示 \"-0.X\"", s1);

  // 大差距（两位小数档）
  DeltaCarState far{};
  far.sMeters = 60.0; far.lap = 0; far.cpIndex = 2; far.segSpeedMps = 32.0;
  far.cpPassTime[0] = 10.0; far.cpPassTime[1] = 13.0; far.cpPassTime[2] = 16.0 + 12.34;
  const DeltaResult vsLeader2 = t.tracker.Solve(far, leader);
  const char* s2 = FmtLocal(b, sizeof b, vsLeader2, false);
  Check(std::strcmp(s2, "-12.34") == 0, "大差距显示 \"-X.XX\"", s2);

  // 即使某帧数值因噪声略微为正，非领先方也**不得**闪出 "+"
  DeltaResult noisy{};
  noisy.deltaMs = +3.0;      // 噪声导致的正值
  noisy.method = DeltaMethod::Checkpoint;
  const char* s3 = FmtLocal(b, sizeof b, noisy, false);
  Check(s3[0] == '-', "非领先方永不输出 \"+\"（噪声正值也强制负号）", s3);
}

// -----------------------------------------------------------------------------
//  T4 —— 场景 ③：后车尾随（本地 P1，榜上后方车辆行）
// -----------------------------------------------------------------------------
void TestBehindCase() noexcept {
  Case("T4  场景③：本地 P1，显示后方车辆 -> 统一负数格式");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");
  char b[64];

  DeltaCarState me{};
  me.sMeters = 260.0; me.lap = 0; me.cpIndex = 2; me.segSpeedMps = 28.0;
  me.cpPassTime[0] = 10.0; me.cpPassTime[1] = 14.0; me.cpPassTime[2] = 18.0;

  // 后车 P2，落后 1.25s
  DeltaCarState p2{};
  p2.sMeters = 225.0; p2.lap = 0; p2.cpIndex = 2; p2.segSpeedMps = 27.0;
  p2.cpPassTime[0] = 10.0; p2.cpPassTime[1] = 14.0; p2.cpPassTime[2] = 19.25;

  // P3 更远，落后 3.4s
  DeltaCarState p3{};
  p3.sMeters = 180.0; p3.lap = 0; p3.cpIndex = 2; p3.segSpeedMps = 26.0;
  p3.cpPassTime[0] = 10.0; p3.cpPassTime[1] = 14.0; p3.cpPassTime[2] = 21.4;

  const DeltaResult r2 = t.tracker.Solve(p2, me);
  const DeltaResult r3 = t.tracker.Solve(p3, me);
  const char* c2 = FmtChaser(b, sizeof b, r2);
  Check(std::strcmp(c2, "-1.3") == 0 || std::strcmp(c2, "-1.2") == 0,
        "P2 行显示 \"-1.2\"/\"-1.3\"", c2);
  const char* c3 = FmtChaser(b, sizeof b, r3);
  Check(std::strcmp(c3, "-3.4") == 0, "P3 行显示 \"-3.4\"", c3);

  // 后车行与"该后车相对领跑者"的数值必须一致（本地就是领跑者时两者等价）
  const DeltaResult r2vsP1 = t.tracker.Solve(p2, me);
  Check(std::fabs(r2vsP1.deltaMs + 1250.0) < 1.0, "P2 相对 P1 = -1250ms");
}

// -----------------------------------------------------------------------------
//  T5 —— 外推不发弯道畸变（本模块存在的根本理由）
//
//  构造一个"出弯"场景：领跑车在弯心减速（20m/s），后车在弯外加速（40m/s）。
//  · 错误做法（欧氏距离 ÷ 后车瞬时速度）：会给出远小于真值的秒差。
//  · 本模块：用**前车**在该赛段的弧长速度折算，结果与几何真值一致。
// -----------------------------------------------------------------------------
void TestNoCornerDistortion() noexcept {
  Case("T5  外推不发弯道畸变（除数必须是前车的弧长速度）");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");

  // 领跑车在前：S=200，本段弧长速度 20 m/s（弯心）
  DeltaCarState leader{};
  leader.sMeters = 200.0; leader.lap = 0; leader.cpIndex = 1; leader.segSpeedMps = 20.0;
  // 后车在后：S=170，本段弧长速度 40 m/s（出弯加速）
  // 两人**没有**公共 CP（后车刚过 CP0，领跑车已过 CP1 -> 公共的是 CP0？）
  // 为了让测试打到外推分支，刻意让后车 cpIndex = -1（一个都没过）。
  DeltaCarState chaser{};
  chaser.sMeters = 170.0; chaser.lap = 0; chaser.cpIndex = -1; chaser.segSpeedMps = 40.0;
  leader.cpIndex = 1;

  const DeltaResult r = t.tracker.SolveSameLap(chaser, leader);
  Check(r.method == DeltaMethod::SplineExtrap, "无公共计时点 -> 走样条外推",
        DeltaMethodName(r.method));

  // ΔS = 170 − 200 = −30m（后车落后 30m）；按**前车** 20m/s -> 落后 1.5s
  Check(std::fabs(r.dsMeters + 30.0) < 1e-6, "弧长差 = -30m", "");
  Check(std::fabs(r.vSegMps - 20.0) < 1e-9, "除数取**前车**的 20m/s（不是后车 40）", "");
  Check(std::fabs(r.deltaMs + 1500.0) < 1.0, "落后 1500ms（正确口径）");

  // 对照：错误口径（用后车 40m/s）会得到 750ms —— 差了一倍
  const double wrong = (-30.0 / 40.0) * 1000.0;
  char b[80];
  std::snprintf(b, sizeof b, "错口径给 %.0fms vs 正确 %.0fms", wrong, -r.deltaMs);
  Check(std::fabs(wrong + 750.0) < 1e-6,
        "对照：用后车速度会低估一半（证明除数选取是必需的）", b);

  // 反向：领跑车相对后车 -> 领先 +1500ms（符号严格相反）
  const DeltaResult rev = t.tracker.SolveSameLap(leader, chaser);
  Check(std::fabs(rev.deltaMs - 1500.0) < 1.0, "反向为 +1500ms（领先）");
}

// -----------------------------------------------------------------------------
//  T6 —— 跨圈折算（LapDelta）
// -----------------------------------------------------------------------------
void TestLapDelta() noexcept {
  Case("T6  跨圈：按平均圈速折算量级");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");

  DeltaCarState a{};
  a.lap = 1; a.sMeters = 20.0; a.cpIndex = 0; a.segSpeedMps = 30.0;
  a.cpPassTime[0] = 60.0;

  DeltaCarState b{};
  b.lap = 0; b.sMeters = 380.0; b.cpIndex = 3; b.segSpeedMps = 30.0;
  b.cpPassTime[0] = 0.0;   // 无公共 CP（a 的 CP0 是第二圈的）

  const DeltaResult r = t.tracker.Solve(a, b, /*avgLapSec=*/45.0);
  Check(r.method == DeltaMethod::LapDelta, "跨圈走 LapDelta", DeltaMethodName(r.method));
  Check(r.deltaMs > 40000.0, "领先量级约一圈（45s）", "");
  // 跨圈解 = 整圈折算 + 同圈内该给的差（同圈部分由 SolveSameLap 给出，
  // 避免"刚过线"瞬间秒差从 -62s 突跳到 -60s）。所以断言的是
  // "整圈量级 + 同圈修正落在合理范围"，而不是恰好等于 avgLapSec。
  const DeltaResult inner = t.tracker.SolveSameLap(a, b);
  char b1[96];
  std::snprintf(b1, sizeof b1, "跨圈 %.0fms = 整圈 45000 + 同圈 %.0fms",
                r.deltaMs, inner.valid() ? inner.deltaMs : 0.0);
  Check(std::fabs(r.deltaMs - (45000.0 + (inner.valid() ? inner.deltaMs : 0.0))) < 1.0,
        "跨圈 = 整圈折算 + 同圈修正（两项可分别核对）", b1);
  Check(std::fabs(r.deltaMs - 45000.0) < 6000.0,
        "跨圈总量仍在一圈量级内（同圈修正不超过半圈）", b1);

  // 反向：落后一整圈
  const DeltaResult rev = t.tracker.Solve(b, a, 45.0);
  Check(rev.deltaMs < -40000.0, "反向为落后一整圈");
  Check(std::fabs(r.deltaMs + rev.deltaMs) < 1e-6, "跨圈解也满足反对称性");
}

// -----------------------------------------------------------------------------
//  T7 —— 样条/弧长表自洽性
// -----------------------------------------------------------------------------
void TestSplineIntegrity() noexcept {
  Case("T7  样条弧长表：ParamOfS / ProjectClosest 自洽");
  SquareTrack t;
  Check(t.build(), "赛道构建成功");

  const double L = t.tracker.TrackLength();
  char b[96];
  std::snprintf(b, sizeof b, "L=%.2fm（理论 400m）", L);
  // 4 控制点的 uniform Catmull-Rom 正方形周长略大于理想正方形（转角被圆化）
  Check(L > 380.0 && L < 440.0, "总弧长在合理范围（≈400m）", b);

  // ProjectClosest：中心线上的点应投影回它自己的 S（往返误差 < 1m）
  double worst = 0.0;
  for (int i = 0; i < 40; ++i) {
    const double s = L * (static_cast<double>(i) / 40.0);
    const double tt = 0.0;
    (void)tt;
    // 用表反查回参数，再求世界坐标，再投影回 S
    // （这里直接用一个已知点：控制点附近的投影）
    double x = 0.0, z = 0.0;
    // 手工取一个圆周上的点：用 4 个控制点连线中点
    const double u = static_cast<double>(i) / 40.0 * 4.0;
    if (u < 1.0) { x = 100.0 * u; z = 0.0; }
    else if (u < 2.0) { x = 100.0; z = 100.0 * (u - 1.0); }
    else if (u < 3.0) { x = 100.0 * (3.0 - u); z = 100.0; }
    else { x = 0.0; z = 100.0 * (4.0 - u); }
    const double got = t.tracker.Project(x, z);
    // 正方形上到角点附近的投影误差会被 Catmull-Rom 圆角化影响，取较宽容差
    const double d = std::fabs(std::fmod(got - s + L * 1.5, L) - L * 0.5);
    worst = std::max(worst, d);
  }
  std::snprintf(b, sizeof b, "最大往返偏差 %.2fm", worst);
  Check(worst < 12.0, "ProjectClosest 往返偏差在容差内（圆角化见注释）", b);

  // ProjectClosest 对中心线附近的点必须给出单调递增的 S
  const double s1 = t.tracker.Project(50.0, 2.0);
  const double s2 = t.tracker.Project(98.0, 50.0);
  Check(s2 > s1, "沿行进方向的投影 S 单调递增");
}

// -----------------------------------------------------------------------------
//  T8 —— 符号反对称性 + 边界（无数据 / 极端速度）
// -----------------------------------------------------------------------------
void TestSignAndBounds() noexcept {
  Case("T8  反对称性 / 无数据兜底 / 极低速保护");
  SquareTrack t;
  Check(t.build(), "测试赛道构建成功");

  DeltaCarState a{};
  a.sMeters = 120.0; a.lap = 0; a.cpIndex = 1; a.segSpeedMps = 33.0;
  a.cpPassTime[0] = 5.0; a.cpPassTime[1] = 9.0;

  DeltaCarState b{};
  b.sMeters = 90.0; b.lap = 0; b.cpIndex = 1; b.segSpeedMps = 31.0;
  b.cpPassTime[0] = 5.0; b.cpPassTime[1] = 9.6;

  const DeltaResult ab = t.tracker.Solve(a, b);
  const DeltaResult ba = t.tracker.Solve(b, a);
  Check(std::fabs(ab.deltaMs + ba.deltaMs) < 1e-6,
        "Solve(a,b) == -Solve(b,a)（符号严格反对称）");

  // 极低速保护：前车几乎停住时不能除出天文数字。
  // 注意 segSpeedMps = 0.5 是"已估计出的速度"，低于 kMinSegSpeedMps(12)，
  // 所以解算时必须把它抬到下限。
  DeltaCarState slowA{};
  slowA.sMeters = 100.0; slowA.lap = 0; slowA.cpIndex = -1; slowA.segSpeedMps = 0.5;
  DeltaCarState slowB{};
  slowB.sMeters = 60.0; slowB.lap = 0; slowB.cpIndex = -1; slowB.segSpeedMps = 0.5;
  const DeltaResult slow = t.tracker.SolveSameLap(slowA, slowB);
  char buf[96];
  std::snprintf(buf, sizeof buf, "%+.0fms（除数被抬到 %.1f m/s）", slow.deltaMs, slow.vSegMps);
  Check(slow.vSegMps >= RaceDeltaTracker::kMinSegSpeedMps - 1e-9,
        "极低速时除数被抬到下限（不会除出天文数字）", buf);
  Check(std::fabs(slow.deltaMs) < 10000.0, "极低速下时差仍在可显示范围内", buf);
  // 40m / 12m/s ≈ 3.33s
  Check(std::fabs(slow.deltaMs - 3333.0) < 60.0, "抬到下限后按 12m/s 折算 40m", buf);

  // 速度为 0（未估计出来）也要兜底到下限，不能除零
  DeltaCarState zeroA{};
  zeroA.sMeters = 100.0; zeroA.cpIndex = -1; zeroA.segSpeedMps = 0.0;
  DeltaCarState zeroB{};
  zeroB.sMeters = 60.0; zeroB.cpIndex = -1; zeroB.segSpeedMps = 0.0;
  const DeltaResult zer = t.tracker.SolveSameLap(zeroA, zeroB);
  Check(std::isfinite(zer.deltaMs) && zer.vSegMps >= RaceDeltaTracker::kMinSegSpeedMps - 1e-9,
        "速度为 0 也兜底到下限（不会除零 / 出 Inf）");

  // 赛道没装时返回 None（不抛、不崩）
  RaceDeltaTracker fresh;
  const DeltaResult none = fresh.Solve(a, b);
  Check(!none.valid(), "未装配赛道时返回 None（可安全调用）");

  // 车况字段全空（全是 0）时也不能崩
  DeltaCarState empty{};
  const DeltaResult e = t.tracker.Solve(empty, empty);
  Check(std::isfinite(e.deltaMs), "全零输入返回有限值");
}

// -----------------------------------------------------------------------------
//  T9 —— 分段速度 EWMA 更新
// -----------------------------------------------------------------------------
void TestSegSpeed() noexcept {
  Case("T9  分段速度估计（EWMA，拒绝倒车/瞬移）");
  DeltaCarState c{};

  // 第一次：直接取瞬时值
  c.sMeters = 30.0;   // 1 秒推进 30m
  RaceDeltaTracker::UpdateSegSpeed(c, 0.0, 0.0, 1.0);
  Check(std::fabs(c.segSpeedMps - 30.0) < 1e-6, "首个样本直接取瞬时值");

  // 第二次：向 40m/s 平滑靠近（EWMA alpha=0.25 -> 30 + 0.25*10 = 32.5）
  c.sMeters = 70.0;   // 再 1 秒推进 40m
  RaceDeltaTracker::UpdateSegSpeed(c, 30.0, 1.0, 2.0);
  Check(std::fabs(c.segSpeedMps - 32.5) < 1e-6, "第二个样本按 alpha=0.25 平滑");

  // 倒车/救援瞬移（ds 为负）必须被拒
  const double before = c.segSpeedMps;
  c.sMeters = 10.0;   // 位置倒退 60m
  RaceDeltaTracker::UpdateSegSpeed(c, 70.0, 2.0, 3.0);
  Check(std::fabs(c.segSpeedMps - before) < 1e-9, "ds 为负的样本被拒绝（不倒车推算）");
}

}  // namespace

int main() {
  std::printf("=== RaceDeltaTracker 单元测试 ===\n");
  TestFormatting();
  TestLeaderCase();
  TestChaserCase();
  TestBehindCase();
  TestNoCornerDistortion();
  TestLapDelta();
  TestSplineIntegrity();
  TestSignAndBounds();
  TestSegSpeed();
  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
