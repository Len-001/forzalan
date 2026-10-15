// =============================================================================
//  race_delta_tracker.cpp —— RaceDeltaTracker 的非内联实现
//
//  为什么还要一个 .cpp（本模块绝大部分逻辑已在头里内联）：
//    · 给"时差语义"这个最容易在两端漂移的东西留一个**权威实现点**。
//      符号约定、分支优先级、外推除数选取都写在这里，头文件只做声明转发。
//    · 让 RaceDeltaTracker 能被单独编译进一个静态库（CMake 目标 race_delta），
//      服务端/客户端/Wasm 三端共享同一份目标文件，不可能各自实现一遍。
//    · 单元测试可以直接对**这个**符号做断言，而不是对头里的内联副本做断言。
// =============================================================================
#include "race_delta_tracker.h"

namespace forza::race {

// -----------------------------------------------------------------------------
//  符号约定的单一来源
// -----------------------------------------------------------------------------

const char* DeltaMethodName(DeltaMethod m) noexcept {
  switch (m) {
    case DeltaMethod::None:         return "none";
    case DeltaMethod::Checkpoint:   return "checkpoint";
    case DeltaMethod::SplineExtrap: return "spline-extrap";
    case DeltaMethod::LapDelta:     return "lap-delta";
  }
  return "?";
}

/**
 * 把 Solve 的结果压成"赛事 HUD 需要的一行字"。
 *
 * 这里刻意把**所有**格式决策收在一个函数里（而不是散落在渲染代码中），
 * 因为规格对格式的要求是精确的（"--" / "-0.X" / "-X.XX"），
 * 散落实现迟早会出现"某个分支忘了负号"这类视觉 bug。
 *
 * @param r          Solve 的结果
 * @param isLeader   显示方是否就是领跑者
 * @param forceChase true = 这一行表示"后方车辆"，按规格一律负号
 */
int FormatDeltaRow(char* out, std::size_t cap, const DeltaResult& r,
                   bool isLeader, bool forceChase) noexcept {
  if (out == nullptr || cap == 0) return 0;
  if (isLeader) return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
  if (!r.valid()) return DeltaFormatter::FormatLeaderRow(out, cap, 0.0, true);
  if (forceChase) {
    // 后车行：落后量 = 该结果的绝对值（Solve(chaser, leader) 给出负值）
    const double mag = (r.deltaMs < 0.0) ? -r.deltaMs : r.deltaMs;
    return DeltaFormatter::FormatChaserRow(out, cap, mag);
  }
  // 普通行（非领先方）：规格要求负号格式。这里用死区关 + 强制负号，
  // 因为"非领先方"这一行按规格**恒为负数**（噪声正值也要显示成负的）。
  return DeltaFormatter::Format(out, cap, r.deltaMs, /*deadband=*/false, /*forceNeg=*/true);
}

}  // namespace forza::race
