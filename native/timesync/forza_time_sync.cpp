// =============================================================================
//  forza_time_sync.cpp —— 非热路径模块
//
//  这里的两个东西**刻意不放进头文件的热路径**：
//    · NtpJitterSimulator：确定性网络抖动模拟器（仅供单测 / 压测）
//    · SyncTelemetry     ：同步质量遥测（供 HUD 与单测断言）
//
//  热路径（OnPong / AdjustedDeltaTime）全在头文件里 inline，
//  保证引擎在 -O2 下可以把它们完全内联进主循环，且零堆分配。
// =============================================================================
#include "forza_time_sync_testkit.h"

namespace forza::net {

// -----------------------------------------------------------------------------
//  NtpJitterSimulator
// -----------------------------------------------------------------------------
NtpJitterSimulator::NtpJitterSimulator(const Config& c, std::uint64_t seed) noexcept
    : cfg_(c), rngState_(seed ? seed : 0x9E3779B97F4A7C15ull) {}

double NtpJitterSimulator::NextUnit() noexcept {
  // xorshift64*：无堆、无查表、周期 2^64-1，单测完全可复现
  rngState_ ^= rngState_ >> 12;
  rngState_ ^= rngState_ << 25;
  rngState_ ^= rngState_ >> 27;
  const std::uint64_t x = rngState_ * 0x2545F4914F6CDD1Dull;
  return static_cast<double>(x >> 11) * (1.0 / 9007199254740992.0);   // /2^53
}

Nanos NtpJitterSimulator::MakeRound(Nanos localArrival, Nanos& outT1, Nanos& outT2,
                                    Nanos& outT3, Nanos& outT4) noexcept {
  // 去程/回程**独立**取样 —— 这正是 NTP 偏移误差的来源
  const double u1 = NextUnit();
  const double u2 = NextUnit();
  const double dOut  = cfg_.baseDelayMs + cfg_.jitterLoMs + (cfg_.jitterHiMs - cfg_.jitterLoMs) * u1;
  const double dBack = cfg_.baseDelayMs + cfg_.jitterLoMs + (cfg_.jitterHiMs - cfg_.jitterLoMs) * u2;

  const Nanos outNs  = static_cast<Nanos>(dOut  * static_cast<double>(kNanosPerMs));
  const Nanos backNs = static_cast<Nanos>(dBack * static_cast<double>(kNanosPerMs));

  outT1 = localArrival;
  // 服务端时钟 = 客户端时钟 + 真实偏移 + 累积漂移
  outT2 = outT1 + outNs + cfg_.trueOffsetNs + CurrentDrift(localArrival);
  outT3 = outT2 + cfg_.serverProcNs;
  outT4 = outT1 + outNs + cfg_.serverProcNs + backNs;
  return outT4 - outT1;
}

Nanos NtpJitterSimulator::CurrentDrift(Nanos elapsedLocalNs) const noexcept {
  return static_cast<Nanos>(static_cast<double>(elapsedLocalNs) * cfg_.driftPpm * 1e-6);
}

}  // namespace forza::net
