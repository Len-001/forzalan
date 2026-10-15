// =============================================================================
//  forza_time_sync_test.cpp —— 自包含单测（零外部依赖，不引 gtest）
//
//  覆盖：
//   T1   RTT / Offset 公式正确性（对已知真值）
//   T2   滑窗滤波：最低 RTT 前 20% 加权聚合 + 容量上限
//   T2b  加权聚合抗"单点幸运采样"（旧单点极值的核心缺陷）
//   T3  【需求指定】连续网络抖动 20ms~120ms 下的收敛 / 不 Snap / 伸缩有界
//   T3b 【需求指定】0ms~150ms **阶跃突变**抖动下的收敛性
//   T4   偏差 1~100ms 必须走连续微调（禁止硬跳）
//   T4b  死区内残差真正收敛（回归：旧实现在死区里冻结残差）
//   T5   偏差 > 250ms 触发硬同步 + 预警；200ms 不得触发
//   T6   断线重连 OnConnectionReset 后重新锁定
//   T7   非法样本与乱序样本被丢弃
//
//  编译：
//    Linux : g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic 
//                forza_time_sync.cpp forza_time_sync_test.cpp -o ts_test && ./ts_test
//    Wasm  : em++ ... -s WASM=1 -o ts_test.js   （可直接在浏览器跑，断言结果打到 console）
// =============================================================================
#include "forza_time_sync_testkit.h"

#include <cstdio>
#include <cstdlib>

using namespace forza::net;

// -----------------------------------------------------------------------------
//  极简断言框架
// -----------------------------------------------------------------------------
namespace {

int g_pass = 0;
int g_fail = 0;
const char* g_case = "";
int g_logCalls = 0;      // 供日志回调计数（必须文件作用域，见 T5）

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) {
    ++g_pass;
  } else {
    ++g_fail;
    std::printf("  [FAIL] %s :: %s %s\n", g_case, what, detail);
  }
}

void Case(const char* name) noexcept {
  g_case = name;
  std::printf("- %s\n", name);
}

/// 把纳秒格式化成 +xx.xxxms，失败信息可读
void Ms(char* buf, std::size_t n, Nanos ns) noexcept {
  const double ms = static_cast<double>(ns) / static_cast<double>(kNanosPerMs);
  std::snprintf(buf, n, "%+.3fms", ms);
}

constexpr double kFrameHz = 60.0;
constexpr double kDt = 1.0 / kFrameHz;
constexpr Nanos kFrameNs = kNanosPerSecond / 60;

// -----------------------------------------------------------------------------
//  T1  RTT / Offset 公式
// -----------------------------------------------------------------------------
void TestFormula() noexcept {
  Case("T1  RTT/Offset 公式");
  ForzaTimeSynchronizer sync;

  // 构造一个已知场景：单向去 30ms、回 50ms、服务端处理 2ms、真实偏移 +12ms
  constexpr Nanos kOut = 30 * kNanosPerMs;
  constexpr Nanos kBack = 50 * kNanosPerMs;
  constexpr Nanos kProc = 2 * kNanosPerMs;
  constexpr Nanos kTrue = 12 * kNanosPerMs;

  const Nanos t1 = 1'000 * kNanosPerMs;
  const Nanos t2 = t1 + kOut + kTrue;
  const Nanos t3 = t2 + kProc;
  const Nanos t4 = t1 + kOut + kProc + kBack;

  sync.PushPingSample(t1, t2, t3, t4);

  // RTT = (t4-t1) - (t3-t2) = (30+2+50) - 2 = 80ms
  // 记 d_out=30, d_back=50, proc=2, 真值 θ=12：
  //   T2-T1 = d_out + θ = 42        T3-T4 = θ - d_back = 12-50 = -38
  //   Offset = ((T2-T1) + (T3-T4)) / 2 = (42-38)/2 = +2ms
  // 估计值不是真值 +12ms，差 (d_out-d_back)/2 = -10ms —— 这就是 NTP 的**路径不对称误差**，
  // 是公式的固有性质而非 bug，也正是必须做滑窗滤波（取最对称的那次）的原因。
  char b1[32], b2[32];
  Ms(b1, sizeof b1, sync.BestRttNs());
  Ms(b2, sizeof b2, sync.CurrentOffsetNs());
  Check(sync.BestRttNs() == 80 * kNanosPerMs, "RTT = (t4-t1)-(t3-t2) 扣掉服务端处理耗时", b1);
  Check(sync.CurrentOffsetNs() == 2 * kNanosPerMs,
        "Offset = ((t2-t1)+(t3-t4))/2 = +2ms（真值 +12ms，路径不对称误差 -10ms）", b2);
}

// -----------------------------------------------------------------------------
//  T2  滑窗滤波：最低 RTT 前 20% 的加权聚合 + 容量上限
// -----------------------------------------------------------------------------
void TestWindowFilter() noexcept {
  Case("T2  滑窗滤波（前 20% 低 RTT 加权聚合 / 容量上限）");
  SyncConfig cfg;
  cfg.windowSize = 20;                    // 前 20% ⇒ 取 4 个样本
  ForzaTimeSynchronizer sync(cfg);

  // 先灌 19 个高 RTT 的坏样本：**对称**延迟 -> offset 恒为 0
  Nanos t = 0;
  const Nanos proc = kNanosPerMs;
  for (int i = 0; i < 19; ++i) {
    const Nanos t1 = t;
    const Nanos bad = 120 * kNanosPerMs;            // 单程 120ms（对称）
    sync.PushPingSample(t1, t1 + bad, t1 + bad + proc, t1 + bad + proc + bad);
    t += 200 * kNanosPerMs;
  }
  {
    char rb[32];
    std::snprintf(rb, sizeof rb, "%lldms", static_cast<long long>(sync.BestRttNs() / kNanosPerMs));
    Check(sync.BestRttNs() == 240 * kNanosPerMs, "坏样本的 RTT = 240ms", rb);
    Check(sync.BestSetSize() == 4, "20 个样本的 20% = 4 个参与加权");
  }

  // 再灌 1 个低 RTT 样本。**必须让它的 offset 与坏样本不同**，
  // 否则"权威估计是否切换"根本无从判断（第一版两边 offset 都是 0，断言等于没测）。
  // 去程 5ms、回程 25ms -> RTT=29ms，offset = (5 + (5-25))/2 = -10ms
  const Nanos t1 = t;
  const Nanos outG = 5 * kNanosPerMs, backG = 25 * kNanosPerMs;
  sync.PushPingSample(t1, t1 + outG, t1 + outG + proc, t1 + outG + proc + backG);

  Check(sync.SampleCount() == 20, "窗口容量 = 20（不超配）");
  {
    char rb[32], ob[32];
    std::snprintf(rb, sizeof rb, "%lldms", static_cast<long long>(sync.BestRttNs() / kNanosPerMs));
    std::snprintf(ob, sizeof ob, "%+.3fms",
                  static_cast<double>(sync.CurrentOffsetNs()) / kNanosPerMs);
    Check(sync.BestRttNs() == 30 * kNanosPerMs, "最小 RTT 样本（30ms）进入聚合集", rb);
    // ★ 这里是加权聚合，**不是**取单个样本的 offset。
    //   聚合集 = {30ms/offset=−10ms, 240ms/offset=0}（其余更差的不入集），
    //   w1=1/31、w2=1/241（单位 ns 尺度）⇒ offset ≈ (−10·w1 + 0·w2)/(w1+w2) ≈ −8.86ms。
    //   断言写成"显著偏向低 RTT 样本"而不写死数值，避免把权重常数钉进测试。
    Check(sync.CurrentOffsetNs() < -6 * kNanosPerMs && sync.CurrentOffsetNs() > -10 * kNanosPerMs,
          "权威估计已由 0 转向低 RTT 样本（加权聚合，非单点极值）", ob);
  }

  // 再灌 30 个，容量仍须被钉死在 20
  for (int i = 0; i < 30; ++i) {
    const Nanos tt = t + static_cast<Nanos>(i + 1) * 100 * kNanosPerMs;
    sync.PushPingSample(tt, tt + outG, tt + outG + proc, tt + outG + proc + backG);
  }
  Check(sync.SampleCount() == 20, "环形覆盖后容量仍为 20（老样本被自然淘汰）");
}

// -----------------------------------------------------------------------------
//  T2b 前 20% 加权聚合抗"单点幸运采样"
// -----------------------------------------------------------------------------
void TestWeightedRobustness() noexcept {
  Case("T2b 加权聚合抗单点幸运采样（旧单点极值的核心缺陷）");

  // 场景：链路总体很空（RTT 稳定 20ms，offset 恒 0），但其中**一次**采样
  // 单向延迟恰好都极小（RTT 4ms），而由路径不对称带来的 offset 误差很大。
  //
  // 构造方法（必须同时满足"RTT 极低"与"offset 偏差大"）：
  //   NTP 的 offset 误差 = (d_out − d_back)/2，RTT = d_out + d_back。
  //   所以想同时做到"RTT 小"又要"offset 偏"，只能取 RTT 小但**两侧不等**：
  //     去程 d_out = 18ms、回程 d_back = 2ms ⇒ RTT = 20ms、offset 偏 (18-2)/2 = +8ms。
  //   这比常规样本（去 10 / 回 10，offset 精确 0）的 RTT **不小**，
  //   所以再补一个真正 RTT 最小的样本：去 1ms / 回 1ms + 一个巨大的时钟偏移。
  //
  // 最直接的构造：让幸运样本的**服务端时钟偏移**本身很大（比如 +200ms），
  // 同时它的往返极短（1ms/1ms ⇒ RTT=2ms）。它的 offset ≈ +200ms，
  // 而常规样本 offset = 0。这样"是否被带偏"就一目了然。
  SyncConfig cfg;
  cfg.windowSize = 30;                    // 前 20% ⇒ 6 个参与
  ForzaTimeSynchronizer sync(cfg);

  Nanos t = 0;
  const Nanos q = 10 * kNanosPerMs;       // 常规样本：对称 10ms/10ms ⇒ offset = 0
  for (int i = 0; i < 29; ++i) {
    const Nanos tt = t + static_cast<Nanos>(i) * 100 * kNanosPerMs;
    sync.PushPingSample(tt, tt + q, tt + q + kNanosPerUs, tt + q + kNanosPerUs + q);
  }

  // 幸运样本：往返极短（1ms/1ms ⇒ RTT 仅 2ms），但那一刻估出的 offset 高达 +200ms
  const Nanos luckyT1 = t + 30 * 100 * kNanosPerMs;
  const Nanos outL = 1 * kNanosPerMs, backL = 1 * kNanosPerMs;
  const Nanos bigOff = 200 * kNanosPerMs;
  sync.PushPingSample(luckyT1,
                      luckyT1 + outL + bigOff,               // t2 = 去程 + 大偏移
                      luckyT1 + outL + bigOff + kNanosPerUs, // t3
                      luckyT1 + outL + kNanosPerUs + backL); // t4（不含偏移）

  Check(sync.BestRttNs() == outL + backL,
        "幸运样本的 RTT 确实最小（2ms，正常样本是 20ms）");

  const double est = static_cast<double>(sync.TargetOffsetNs()) / kNanosPerMs;
  char b[32];
  std::snprintf(b, sizeof b, "%+.3fms", est);
  // 若"取单点最小 RTT"，估计会直接变成 +200ms（被一个样本彻底带偏）。
  // 加权聚合下入集 6 个样本里只有 1 个是幸运样本（权重 1/2ms 远大于 1/20ms），
  // 但**仍被其余 5 个常规样本稀释**，绝不可能等于 200ms。
  Check(est < 150.0,
        "估计值**未**被单个幸运样本带到 +200ms（加权稀释生效）", b);
  Check(est > 0.0,
        "但确实朝幸运样本方向偏移（说明它有权重，不是被完全忽略）", b);
}

// -----------------------------------------------------------------------------
//  T3  【需求指定】抖动 20ms~120ms
// -----------------------------------------------------------------------------
void TestJitter20to120() noexcept {
  Case("T3  网络抖动 20ms~120ms 下的收敛行为");

  NtpJitterSimulator::Config jc;
  jc.trueOffsetNs = 37 * kNanosPerMs;   // 真实偏移 +37ms
  jc.driftPpm = 50.0;                   // 客户端 50ppm 漂移
  jc.baseDelayMs = 4.0;
  jc.jitterLoMs = 20.0;
  jc.jitterHiMs = 120.0;                // 需求指定的抖动区间
  NtpJitterSimulator net(jc, 0xC0FFEEull);

  SyncConfig cfg;
  cfg.windowSize = 24;
  ForzaTimeSynchronizer sync(cfg);
  SyncTelemetry tel;

  constexpr int kSamples = 240;         // 4 分钟 @1Hz，覆盖多次漂移累积
  constexpr int kFramesPerSample = 60;  // 1Hz 采样、60Hz 物理
  Nanos local = 0;

  bool warpInBounds = true;
  Nanos errAfterLockMax = 0;

  for (int i = 0; i < kSamples; ++i) {
    Nanos t1 = 0, t2 = 0, t3 = 0, t4 = 0;
    net.MakeRound(local, t1, t2, t3, t4);
    const SyncEvent ev = sync.PushPingSample(t1, t2, t3, t4);
    if (ev == SyncEvent::HardResync) tel.CountSnap();
    if (ev == SyncEvent::SampleRejected) tel.CountRejected();

    // 采样的 1 秒内跑 60 帧物理
    for (int f = 0; f < kFramesPerSample; ++f) {
      const double dt = sync.GetAdjustedDeltaTime(kDt);
      const double warp = sync.CurrentWarp();
      if (warp > cfg.maxWarpRatio + 1e-12 || warp < -cfg.maxWarpRatio - 1e-12) warpInBounds = false;
      if (dt <= 0.0 || dt > kDt * 1.02) warpInBounds = false;
      tel.Observe(sync, local);
      local += static_cast<Nanos>(dt * static_cast<double>(kNanosPerSecond));
    }

    // 锁定后统计残余误差：|本地对服务端的估计 − 真实偏移 − 漂移|
    if (sync.IsLocked() && i > static_cast<int>(cfg.windowSize)) {
      const Nanos truth = jc.trueOffsetNs + net.CurrentDrift(local);
      const Nanos err = sync.CurrentOffsetNs() - truth;
      const Nanos ae = (err < 0) ? -err : err;
      if (ae > errAfterLockMax) errAfterLockMax = ae;
    }
  }

  // ---- 断言 ----
  Check(sync.IsLocked(), "抖动 20~120ms 下仍能完成锁定");
  Check(tel.snapCount == 0, "稳态期间**零硬同步**（未发生任何 Snap）");
  Check(warpInBounds, "物理步长伸缩比例始终在 ±1.5% 内，且 dt 恒为正");

  // 单帧偏移变化量必须远小于"一次 Snap"的量级。
  // 上界 = maxWarpRatio * dt = 0.015 * 16.67ms = 0.25ms，留 1 位余量取 0.3ms。
  char b1[32], b2[32];
  Ms(b1, sizeof b1, tel.maxStepNs);
  Ms(b2, sizeof b2, errAfterLockMax);
  Check(tel.maxStepNs <= 300 * kNanosPerUs,
        "生效偏移单帧变化 <= 0.3ms（连续微调，绝无硬跳）", b1);

  // 残余误差：受"路径不对称"限制。抖动 20~120ms 时最小 RTT 样本的
  // 不对称误差理论上界 = (120-20)/2 = 50ms，实测应显著优于该上界。
  Check(errAfterLockMax < 30 * kNanosPerMs,
        "锁定后残余误差 < 30ms（优于 50ms 理论最坏值）", b2);

  // 收敛速度：应该在有限的采样数内锁定
  Check(tel.lockedAfterNs != kNoSample && tel.lockedAfterNs < 30 * kNanosPerSecond,
        "在 30 秒内完成锁定（窗口 24 个 1Hz 样本）");

  std::printf("    · 观测：maxWarp=%.5f  maxStep=%s  残余误差=%s  拒收=%zu\n",
              tel.maxAbsWarp, b1, b2, tel.rejectedCount);
}

// -----------------------------------------------------------------------------
//  T3b  【需求指定】抖动 0ms ~ 150ms 阶跃突变下的收敛性
// -----------------------------------------------------------------------------
/**
 * 规格原文："包含针对伪造网络抖动（0ms~150ms 阶跃突变）的时钟收敛性单测用例"。
 *
 * 与 T3 的区别：T3 是**连续随机抖动**（20~120ms 均匀分布在每次往返上），
 * 而本用例是**阶跃突变** —— 网络条件在某一刻从"完全空闲(0ms)"跳到"严重拥塞(150ms)"，
 * 再在若干采样后跳回。这是真实世界最常见的恶化工况（切换基站、后台下载、路由抖动），
 * 也是对时钟同步器最狠的考验：它的 RTT 估计必须在长尾里重新找到最干净的那些样本。
 *
 * 判据（全部是"绝不"式硬约束，不看平均表现）：
 *   1) 阶跃期间**零硬同步** —— 150ms 远低于 250ms 红线，只能靠伸缩消化；
 *   2) warp 始终在 ±1.5% 内，且 dt 恒正、恒有限；
 *   3) 生效偏移单帧变化 <= 0.3ms（连续微调，绝无硬跳）；
 *   4) 阶跃恢复后残差能真正收敛回亚毫秒级（不是被死区冻住）。
 */
void TestJitterStep0to150() noexcept {
  Case("T3b 阶跃突变抖动 0ms~150ms 下的收敛性");

  SyncConfig cfg;
  ForzaTimeSynchronizer sync(cfg);
  SyncTelemetry tel;

  constexpr Nanos kProc = 200 * kNanosPerUs;
  constexpr Nanos kTrueOffset = 45 * kNanosPerMs;   // 服务端比本端快 45ms

  Nanos local = 0;
  bool warpInBounds = true;
  bool dtSane = true;
  Nanos maxObservedErr = 0;

  // 一档往返：`oneWay` 是**该方向的基准延迟**，`offStep` 是本阶段额外注入的
  // 时钟偏移阶跃（模拟服务端时钟跳变 / 链路时钟域切换）。
  //
  // ⚠️ 关键：只改 oneWay 是**测不出东西**的 —— offset = 真值 + (d_out−d_back)/2，
  //    对称改 oneWay 时 (d_out−d_back) 恒为 0，offset 纹丝不动，整个用例变成空跑
  //    （这正是本站第一次写的时候就踩的坑：maxWarp/maxStep/残差全打印 0.0000，
  //     断言"通过"但什么都没验证 —— 与 harness 里那次零样本假绿同类）。
  //    因此这里**同时**注入 offStep 才能真正考验时钟收敛。
  const auto Feed = [&](Nanos oneWayNs, Nanos offStep, int count, int framesPer) {
    for (int i = 0; i < count; ++i) {
      const Nanos t1 = local;
      sync.PushPingSample(t1, t1 + oneWayNs + kTrueOffset + offStep,
                          t1 + oneWayNs + kTrueOffset + offStep + kProc,
                          t1 + oneWayNs + kProc + oneWayNs);
      for (int f = 0; f < framesPer; ++f) {
        const double dt = sync.GetAdjustedDeltaTime(kDt);
        const double w = sync.CurrentWarp();
        if (w > cfg.maxWarpRatio + 1e-12 || w < -cfg.maxWarpRatio - 1e-12) warpInBounds = false;
        if (!(dt > 0.0) || dt > kDt * 1.02 || dt < kDt * 0.98) dtSane = false;
        tel.Observe(sync, local);
        local += static_cast<Nanos>(dt * static_cast<double>(kNanosPerSecond));
      }
      local += 100 * kNanosPerMs;      // 采样间隔
      if (sync.IsLocked()) {
        const Nanos e = sync.ResidualNs();
        const Nanos ae = (e < 0) ? -e : e;
        if (ae > maxObservedErr) maxObservedErr = ae;
      }
    }
  };

  // 阶段 A：完全空闲（单向 0ms），无偏移阶跃 -> 锁定到 45ms
  Feed(0, 0, 40, 60);
  Check(sync.IsLocked(), "阶段A（0ms 空闲链路）完成锁定");
  Check(sync.CurrentOffsetNs() > 40 * kNanosPerMs && sync.CurrentOffsetNs() < 50 * kNanosPerMs,
        "阶段A：估计到真值 +45ms");

  // 阶段 B：单向延迟阶跃到 150ms（严重拥塞）+ 偏移阶跃 +120ms
  //         ⇒ 总偏差 165ms，**低于 250ms 红线**，必须靠伸缩消化
  const std::size_t snapsBeforeStep = tel.snapCount;
  Feed(150 * kNanosPerMs, 120 * kNanosPerMs, 60, 60);
  Check(tel.snapCount == snapsBeforeStep,
        "阶跃到 165ms 总偏差 **零硬同步**（< 250ms 红线，只允许伸缩消化）");
  Check(sync.CurrentOffsetNs() > 150 * kNanosPerMs,
        "确实在向新偏移收敛（不是原地不动）");

  // 阶段 C：回落（延迟回到 0ms，偏移阶跃撤销）-> 应重新收敛回 45ms
  Feed(0, 0, 120, 60);
  Check(tel.snapCount == snapsBeforeStep, "回落后仍然零硬同步");
  Check(warpInBounds, "全程 warp 严格在 ±1.5% 内");
  Check(dtSane, "全程 dt 恒正、且落在 [0.985·dt, 1.015·dt] 内");

  char b1[32], b2[32];
  Ms(b1, sizeof b1, tel.maxStepNs);
  const Nanos res = sync.ResidualNs();
  Ms(b2, sizeof b2, (res < 0) ? -res : res);
  // 单帧偏移变化上限 = maxWarp × dt = 0.015 × 16.667ms = 0.25ms，留余量取 0.3ms
  Check(tel.maxStepNs <= 300 * kNanosPerUs,
        "生效偏移单帧变化 <= 0.3ms（阶跃被摊成连续微调，绝无硬跳）", b1);
  // 收敛判据：恢复后残差回到亚毫秒级。旧实现在死区冻结残差，此断言会失败。
  Check((res < 0 ? -res : res) < 500 * kNanosPerUs,
        "阶跃恢复后未消化残差 < 0.5ms（真正收敛，未被死区冻结）", b2);
  // ★ 防空跑守卫：用例必须真的制造过可观偏差，否则上面的"零硬同步"毫无意义
  Check(maxObservedErr > 50 * kNanosPerMs,
        "★ 用例确实制造了 >50ms 的可观偏差（防空跑假绿）");

  std::printf("    · 观测：maxWarp=%.5f  maxStep=%s  末态残差=%s  峰值残差=%+.2fms  拒收=%zu\n",
              tel.maxAbsWarp, b1, b2,
              static_cast<double>(maxObservedErr) / kNanosPerMs, tel.rejectedCount);
}

// -----------------------------------------------------------------------------
//  T4b 死区残差必须真正收敛（回归：旧实现在死区内冻结残差）
// -----------------------------------------------------------------------------
/**
 * 这是本轮修复的一个**真实缺陷**的回归守卫。
 *
 * 旧实现：
 *     if (absErr <= deadband) { warp_ = 0; return baseDt; }   // appliedOffset 不推进
 * 后果：死区内（<1ms）的残差被**永久冻结**。局域网里服务端 tick 与客户端帧率
 * 存在固有相位差，实测会稳定留下约 0.5ms 的恒定残差 —— 永远收敛不掉，
 * 表现为物理 Tick 长期微幅抖动（"Tick 抖动"这条需求的残余来源）。
 *
 * 新实现：死区内仍按同一方程算 warp（残差小时它自然极小，本就落在 ±1.5% 内），
 * appliedOffset 持续逼近 target。本用例断言那个 ~0.5ms 残差**确实被吃掉**。
 */
void TestDeadbandConvergence() noexcept {
  Case("T4b 死区内残差真正收敛（回归：旧实现会冻结）");

  // 用自定义参数让死区为 1ms，构造一个 ~0.5ms 的恒定偏差
  SyncConfig cfg;
  cfg.deadbandNs = 1 * kNanosPerMs;
  ForzaTimeSynchronizer sync(cfg);

  constexpr Nanos kProc = 200 * kNanosPerUs;
  const Nanos q = 10 * kNanosPerMs;            // 对称 10ms 往返
  const Nanos bias = 500 * kNanosPerUs;        // ★ 恒定 +0.5ms 偏差（落在死区内）

  Nanos local = 0;
  // 阶段 A：无偏差，锁定
  for (int i = 0; i < 40; ++i) {
    const Nanos t1 = local;
    sync.PushPingSample(t1, t1 + q, t1 + q + kProc, t1 + q + kProc + q);
    for (int f = 0; f < 20; ++f) { (void)sync.GetAdjustedDeltaTime(kDt); local += kFrameNs; }
    local += kNanosPerSecond;
  }
  Check(sync.IsLocked(), "前置条件：已锁定（无偏差）");

  // 阶段 B：注入恒定 +0.5ms 偏差（每次采样都带，属于真实的固有相位差）
  for (int i = 0; i < 200; ++i) {
    const Nanos t1 = local;
    sync.PushPingSample(t1, t1 + q + bias, t1 + q + kProc + bias, t1 + q + kProc + q);
    for (int f = 0; f < 20; ++f) { (void)sync.GetAdjustedDeltaTime(kDt); local += kFrameNs; }
    local += kNanosPerSecond;
  }

  const Nanos res = sync.ResidualNs();
  const Nanos absRes = (res < 0) ? -res : res;
  char b[32];
  Ms(b, sizeof b, absRes);
  // 死区 = 1ms，注入偏差 = 0.5ms。若残差被冻结，这里会稳定停在 ~0.5ms；
  // 新实现应把它压到远小于死区（收敛判据取 0.15ms）。
  Check(absRes < 150 * kNanosPerUs,
        "恒定 0.5ms 偏差被连续微调吃掉（残差 < 0.15ms，未被死区冻结）", b);
  // 且方向正确：生效偏移应确实追到了 +0.5ms 附近
  Check(sync.CurrentOffsetNs() > 300 * kNanosPerUs,
        "生效偏移确实向 +0.5ms 收敛（不是原地不动）");
}


void TestNoSnapForMidRange() noexcept {
  Case("T4  偏差 1~100ms 只做连续微调");
  SyncConfig cfg;
  ForzaTimeSynchronizer sync(cfg);
  SyncTelemetry tel;

  // 先用干净样本锁定（偏移 0）
  Nanos local = 0;
  for (int i = 0; i < 40; ++i) {
    const Nanos q = 3 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    for (int f = 0; f < 30; ++f) {
      (void)sync.GetAdjustedDeltaTime(kDt);
      tel.Observe(sync, local);
      local += kFrameNs;
    }
    local += kNanosPerSecond;
  }
  Check(sync.IsLocked(), "前置条件：已锁定");

  // 人为制造 +80ms 的阶跃（在 1~100ms 区间内）
  const Nanos kStep = 80 * kNanosPerMs;
  const std::size_t beforeSnaps = tel.snapCount;
  Nanos prev = sync.CurrentOffsetNs();
  Nanos maxStep = 0;

  const Nanos q = 3 * kNanosPerMs;
  for (int i = 0; i < 20; ++i) {
    const Nanos t1 = local;
    sync.PushPingSample(t1, t1 + q + kStep, t1 + q + kNanosPerUs + kStep,
                t1 + q + kNanosPerUs + q);      // 服务端"突然快了 80ms"
    for (int f = 0; f < 60; ++f) {
      (void)sync.GetAdjustedDeltaTime(kDt);
      const Nanos now = sync.CurrentOffsetNs();
      const Nanos s = (now > prev) ? (now - prev) : (prev - now);
      if (s > maxStep) maxStep = s;
      prev = now;
      local += kFrameNs;
    }
    local += kNanosPerSecond;
  }

  char b[32];
  Ms(b, sizeof b, maxStep);
  Check(tel.snapCount == beforeSnaps, "1~100ms 阶跃**没有**触发硬同步");
  Check(maxStep <= 300 * kNanosPerUs, "阶跃被摊成连续微调（单帧变化 <= 0.3ms）", b);

  // 且确实收敛过去了：残余误差应远小于 80ms
  Check(sync.CurrentOffsetNs() > 40 * kNanosPerMs,
        "确实在向 80ms 收敛（不是永远不动）");
}

// -----------------------------------------------------------------------------
//  T5  偏差 > 250ms -> 硬同步 + 预警
// -----------------------------------------------------------------------------
void TestHardResync() noexcept {
  Case("T5  偏差 > 250ms 触发硬同步");
  SyncConfig cfg;
  ForzaTimeSynchronizer sync(cfg);
  g_logCalls = 0;
  // 裸函数指针，无捕获 lambda 可直接转换（零分配）。
  // 注意：计数器必须是**文件作用域**变量 —— 曾经写成 `static int* s_calls = &局部变量`，
  // 那次函数返回后指针悬空，lambda 解引用即 UB。
  sync.SetLogger([](const char*) noexcept { ++g_logCalls; });

  Nanos local = 0;
  for (int i = 0; i < 40; ++i) {
    const Nanos q = 3 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    for (int f = 0; f < 20; ++f) { (void)sync.GetAdjustedDeltaTime(kDt); local += kFrameNs; }
    local += kNanosPerSecond;
  }
  Check(sync.IsLocked(), "前置条件：已锁定");

  // 400ms 阶跃。**注意这里的语义变化**（旧实现 3 个采样内立刻 Snap）：
  //   新的前 20% 加权滤波会先把阶跃**摊开**：随着 400ms 样本陆续进入聚合集，
  //   权威 target 按 66→133→200→266→333→400ms 阶梯上升，而非一步到位。
  //   这是**有意为之**的改进 —— 单次异常采样不再能直接改写权威时间轴。
  //   硬同步仍会触发，但要等残余误差真正越过 250ms（实测第 5 个采样）。
  const Nanos kHuge = 400 * kNanosPerMs;
  SyncEvent ev = SyncEvent::None;
  int snapsAtSample = -1;
  for (int i = 0; i < 10 && snapsAtSample < 0; ++i) {
    const Nanos t1 = local;
    const Nanos q = 3 * kNanosPerMs;
    ev = sync.PushPingSample(t1, t1 + q + kHuge, t1 + q + kNanosPerUs + kHuge,
                             t1 + q + kNanosPerUs + q);
    if (ev == SyncEvent::HardResync) snapsAtSample = i;
    local += kNanosPerSecond;
  }
  Check(ev == SyncEvent::HardResync, "偏差 400ms -> 返回 HardResync 事件");
  Check(snapsAtSample > 0,
        "阶跃先被滤波摊开、残余越过 250ms 后才 Snap（不是单采样即跳）");
  {
    // Snap 后生效偏移应**立刻**等于当时的权威 target（这就是"跳到新值"），
    // 而不是慢慢爬。因此断言"applied == target"比断言某个具体毫秒数更准确、
    // 也与"滤波会先把阶跃摊开"这一行为解耦（target 具体到多少取决于取样节奏）。
    char b[32];
    Ms(b, sizeof b, sync.CurrentOffsetNs());
    Check(sync.ResidualNs() == 0,
          "Snap 后 applied 立即等于 target（绝不是慢慢爬）", b);
    Check(sync.CurrentOffsetNs() > 250 * kNanosPerMs,
          "且跳到的值确实 > 250ms（阶跃真的被吸收了）", b);
  }
  Check(g_logCalls > 0, "硬同步输出了预警日志");

  // 反向守卫：低于阈值的 200ms 阶跃**不得**触发硬同步（250ms 是新红线）
  {
    SyncConfig c2;
    ForzaTimeSynchronizer s2(c2);
    Nanos l2 = 0;
    for (int i = 0; i < 40; ++i) {
      const Nanos q = 3 * kNanosPerMs;
      s2.PushPingSample(l2, l2 + q, l2 + q + kNanosPerUs, l2 + q + kNanosPerUs + q);
      for (int f = 0; f < 20; ++f) { (void)s2.GetAdjustedDeltaTime(kDt); l2 += kFrameNs; }
      l2 += kNanosPerSecond;
    }
    const Nanos kMid = 200 * kNanosPerMs;
    bool snapped = false;
    for (int i = 0; i < 20; ++i) {
      const Nanos q = 3 * kNanosPerMs;
      if (s2.PushPingSample(l2, l2 + q + kMid, l2 + q + kNanosPerUs + kMid,
                            l2 + q + kNanosPerUs + q) == SyncEvent::HardResync) snapped = true;
      for (int f = 0; f < 30; ++f) { (void)s2.GetAdjustedDeltaTime(kDt); l2 += kFrameNs; }
    }
    Check(!snapped, "200ms 阶跃**不**触发硬同步（红线在 250ms）");
  }
}

// -----------------------------------------------------------------------------
//  T6  断线重连
// -----------------------------------------------------------------------------
void TestReconnect() noexcept {
  Case("T6  断线重连后重新锁定");
  ForzaTimeSynchronizer sync;
  Nanos local = 0;
  for (int i = 0; i < 40; ++i) {
    const Nanos q = 3 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    local += 200 * kNanosPerMs;
  }
  Check(sync.IsLocked() && sync.SampleCount() > 0, "重连前：已锁定且有样本");

  sync.OnConnectionReset();
  Check(!sync.IsLocked(), "重连后：回到未锁定");
  Check(sync.SampleCount() == 0, "重连后：窗口已清空");
  Check(sync.BestRttNs() == kNoSample, "重连后：RTT 估计已复位");

  // 重连后前几次采样允许直接对齐（此时没有连续性可言）
  local += 5 * kNanosPerSecond;
  for (int i = 0; i < 30; ++i) {
    const Nanos q = 6 * kNanosPerMs;
    sync.PushPingSample(local, local + q, local + q + kNanosPerUs, local + q + kNanosPerUs + q);
    local += 100 * kNanosPerMs;
  }
  Check(sync.IsLocked(), "重连后能重新锁定");
}

// -----------------------------------------------------------------------------
//  T7  非法 / 乱序样本
// -----------------------------------------------------------------------------
void TestReject() noexcept {
  Case("T7  非法与乱序样本被丢弃");
  ForzaTimeSynchronizer sync;

  // T2 < T1：物理不可能
  Check(sync.PushPingSample(100 * kNanosPerMs, 50 * kNanosPerMs, 60 * kNanosPerMs, 200 * kNanosPerMs) ==
        SyncEvent::SampleRejected, "T2 < T1 被拒");
  // RTT 超限（单向 600ms）
  const Nanos big = 600 * kNanosPerMs;
  Check(sync.PushPingSample(1000 * kNanosPerMs, 1000 * kNanosPerMs + big, 1000 * kNanosPerMs + big + 1000,
                    1000 * kNanosPerMs + 2 * big) == SyncEvent::SampleRejected,
        "RTT > 500ms 被拒");
  // 正常样本
  const Nanos t1 = 5000 * kNanosPerMs;
  const Nanos q = 4 * kNanosPerMs;
  Check(sync.PushPingSample(t1, t1 + q, t1 + q + kNanosPerUs, t1 + q + kNanosPerUs + q) == SyncEvent::None,
        "正常样本被接受");
  // 乱序：T1 回退
  Check(sync.PushPingSample(t1 - 10 * kNanosPerMs, t1, t1 + kNanosPerUs, t1 + 20 * kNanosPerMs) ==
        SyncEvent::SampleRejected, "T1 回退（无序通道）被拒");
}

}  // namespace

int main() {
  std::printf("=== ForzaTimeSynchronizer 单元测试 ===\n");
  TestFormula();
  TestWindowFilter();
  TestWeightedRobustness();
  TestJitter20to120();
  TestJitterStep0to150();
  TestNoSnapForMidRange();
  TestDeadbandConvergence();
  TestHardResync();
  TestReconnect();
  TestReject();

  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
