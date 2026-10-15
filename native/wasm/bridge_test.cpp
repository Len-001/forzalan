// =============================================================================
//  bridge_test.cpp —— 桥接层原生测试（不需要 emcc）
//
//  本机没有 emcc，Embind 那层编不了；但**最容易出错、且错了不报错**的部分
//  恰恰是不依赖 emscripten 的：JS 把网络包按字节写进 Wasm 线性内存时，
//  字段落在哪个偏移、字节序是否一致、commit 的时序是否正确。
//
//  本测试模拟 JS 侧行为：**不调用任何 C++ setter**，
//  而是直接往暂存区按偏移灌字节，再 commit，然后断言字段值正确。
//  这等价于浏览器里 `HEAPU8.set(payload, addr)` 之后的所有行为。
//
//  同时把布局 dump 成 layout.json，给 protocol_test.mjs 做两侧交叉核对。
//
//  编译运行：g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic bridge_test.cpp -o bridge_test
// =============================================================================
#include "network_physics_bridge.h"

#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>

using namespace forza::wasm;

namespace {

int g_pass = 0;
int g_fail = 0;

void Check(bool ok, const char* what, const char* detail = "") noexcept {
  if (ok) { ++g_pass; }
  else { ++g_fail; std::printf("  [FAIL] %s %s\n", what, detail); }
}

/// 模拟 JS 的 DataView.setFloat32(offset, value, true) —— **小端**
void WriteF32(std::uint8_t* base, std::uint32_t off, float v) noexcept {
  std::memcpy(base + off, &v, 4);
}
void WriteU32(std::uint8_t* base, std::uint32_t off, std::uint32_t v) noexcept {
  std::memcpy(base + off, &v, 4);
}
void WriteF32x3(std::uint8_t* base, std::uint32_t off, float x, float y, float z) noexcept {
  WriteF32(base, off, x); WriteF32(base, off + 4, y); WriteF32(base, off + 8, z);
}
void WriteF32x4(std::uint8_t* base, std::uint32_t off, float w, float x, float y, float z) noexcept {
  WriteF32(base, off, w); WriteF32(base, off + 4, x);
  WriteF32(base, off + 8, y); WriteF32(base, off + 12, z);
}

bool LittleEndian() noexcept {
  const std::uint32_t one = 1;
  std::uint8_t b[4];
  std::memcpy(b, &one, 4);
  return b[0] == 1;
}

}  // namespace

int main() {
  std::printf("=== NetworkPhysicsBridge 原生测试（模拟 JS 零拷贝写入）===\n");

  // -------------------------------------------------------------------------
  std::printf("\n[1] 布局与偏移（JS 侧必须用这些值，不能写死常量）\n");
  {
    Check(sizeof(RigidBodyNetSnapshot) == 96, "快照 = 96 字节");
    Check(NetworkPhysicsBridge::SnapshotStageSize() == 96, "暂存区 = 96 字节");
    Check(NetworkPhysicsBridge::MatrixStageSizeBytes() == 64 * sizeof(float),
          "矩阵暂存区 = 4 槽 × 16 float = 256 字节");
    Check(NetworkPhysicsBridge::FieldOffset(0) == offsetof(RigidBodyNetSnapshot, frame),
          "FieldOffset(0) == offsetof(frame)");
    Check(NetworkPhysicsBridge::FieldOffset(3) == offsetof(RigidBodyNetSnapshot, position),
          "FieldOffset(3) == offsetof(position)");
    Check(NetworkPhysicsBridge::FieldOffset(4) == offsetof(RigidBodyNetSnapshot, rotation),
          "FieldOffset(4) == offsetof(rotation)");
    Check(NetworkPhysicsBridge::FieldOffset(7) == offsetof(RigidBodyNetSnapshot, accel),
          "FieldOffset(7) == offsetof(accel)");
    Check(NetworkPhysicsBridge::FieldOffset(99) == 0xFFFFFFFFu,
          "非法 field 返回哨兵值（不静默返回 0 而让 JS 写到 frame 上）");
    Check(LittleEndian(),
          "本平台小端 —— 与 Wasm 线性内存（规范规定小端）一致，字节序无需转换");
  }

  // -------------------------------------------------------------------------
  std::printf("\n[2] 零拷贝快照提交（全程不碰 C++ setter，纯字节写入）\n");
  {
    NetworkPhysicsBridge br;
    std::uint8_t* base = reinterpret_cast<std::uint8_t*>(br.SnapshotStageAddr());

    // 模拟 JS 收到一个 60Hz 快照包后 HEAPU8.set(payload, addr)
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(0), 4242U);          // frame
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(1), 987654U);        // tickMs
    WriteF32(base, NetworkPhysicsBridge::FieldOffset(2), 1234.5F);        // serverTimeSec
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(3), 10.0F, 1.5F, -20.0F);   // position
    WriteF32x4(base, NetworkPhysicsBridge::FieldOffset(4), 1.0F, 0.0F, 0.0F, 0.0F); // rotation
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(5), 55.0F, 0.0F, 0.0F);     // velocity
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(6), 0.1F, 0.0F, 0.2F);      // angularVelocity
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(7), 0.0F, 0.0F, -3.0F);     // accel

    const int accepted = br.SnapshotCommit();
    Check(accepted == 1, "首次 commit 被接受");
    Check(br.HasState(), "物理层已初始化");
    Check(br.LastFrame() == 4242U, "frame 字段落位正确");
    Check(std::abs(br.PhysicsPosition(0) - 10.0) < 1e-6 &&
          std::abs(br.PhysicsPosition(1) - 1.5) < 1e-6 &&
          std::abs(br.PhysicsPosition(2) + 20.0) < 1e-6,
          "position 三字段落位正确");
    Check(std::abs(br.PhysicsVelocity(0) - 55.0) < 1e-6 &&
          std::abs(br.PhysicsVelocity(1)) < 1e-6,
          "velocity 三字段落位正确");

    // 帧号回退 -> 必须被丢弃（乱序通道常态）
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(0), 4241U);
    Check(br.SnapshotCommit() == 0, "帧号回退的包被丢弃");
    Check(br.StaleDropped() == 1U, "丢弃计数 +1");

    // 新帧 -> 接受
    WriteU32(base, NetworkPhysicsBridge::FieldOffset(0), 4243U);
    WriteF32x3(base, NetworkPhysicsBridge::FieldOffset(3), 11.0F, 1.5F, -20.0F);
    Check(br.SnapshotCommit() == 1, "新帧被接受");
    Check(std::abs(br.PhysicsPosition(0) - 11.0) < 1e-6, "新帧 position 生效");
  }

  // -------------------------------------------------------------------------
  std::printf("\n[3] 双层解耦：纠偏瞬间矩阵暂存区的视觉连续性\n");
  {
    NetworkPhysicsBridge br;
    std::uint8_t* base = reinterpret_cast<std::uint8_t*>(br.SnapshotStageAddr());
    const std::uint32_t O_F = NetworkPhysicsBridge::FieldOffset(0);
    const std::uint32_t O_P = NetworkPhysicsBridge::FieldOffset(3);
    const std::uint32_t O_R = NetworkPhysicsBridge::FieldOffset(4);
    const std::uint32_t O_V = NetworkPhysicsBridge::FieldOffset(5);
    const std::uint32_t O_A = NetworkPhysicsBridge::FieldOffset(7);

    auto pack = [&](std::uint32_t frame, float x) {
      std::memset(base, 0, 96);
      WriteU32(base, O_F, frame);
      WriteF32x3(base, O_P, x, 0.0F, 0.0F);
      WriteF32x4(base, O_R, 1.0F, 0.0F, 0.0F, 0.0F);
      WriteF32x3(base, O_V, 30.0F, 0.0F, 0.0F);
      WriteF32x3(base, O_A, 0.0F, 0.0F, 0.0F);
      br.SnapshotCommit();
      br.RefreshMatrices();     // commit 只改状态，矩阵要显式刷新（不推进时间）
    };

    pack(1, 0.0F);
    const double dt = 1.0 / 60.0;
    for (int i = 0; i < 12; ++i) br.Update(dt);       // 200ms 纯外推

    // 矩阵暂存区第 [12][13][14] 是平移列（列主序）
    const std::uint32_t VS = 0U;                      // MatrixSlot::VisualWorld
    auto visX = [&]() {
      return br.MatrixElement(VS, 12);
    };
    const double before = visX();

    // 服务端纠偏：权威位置比外推值落后 0.8m
    pack(2, static_cast<float>(before) - 0.8F);
    const double afterSnap = visX();

    Check(std::abs(afterSnap - before) < 1e-5,
          "收到纠偏的当帧**视觉位置零跳变**（物理层已跳，视觉层吸收误差）");
    Check(br.VisualErrorM() > 0.7, "误差被存进视觉偏移层");
    Check(std::abs(br.MatrixElement(1U, 12) - (before - 0.8)) < 1e-4,
          "物理层矩阵立刻等于权威值（碰撞判定用这个）");

    for (int i = 0; i < 60; ++i) br.Update(dt);
    Check(br.VisualErrorM() < 0.01, "~1s 内视觉误差收敛到 1cm 内");
  }

  // -------------------------------------------------------------------------
  std::printf("\n[4] 布局 dump -> layout.json（供 TS/JS 侧交叉核对）\n");
  {
    std::FILE* f = std::fopen("layout.json", "wb");
    if (f != nullptr) {
      std::fprintf(f,
        "{\n"
        "  \"snapshotSize\": %zu,\n"
        "  \"align\": %zu,\n"
        "  \"littleEndian\": %s,\n"
        "  \"offsets\": {\n"
        "    \"frame\": %zu, \"tickMs\": %zu, \"serverTimeSec\": %zu,\n"
        "    \"position\": %zu, \"rotation\": %zu, \"velocity\": %zu,\n"
        "    \"angularVelocity\": %zu, \"accel\": %zu\n"
        "  }\n"
        "}\n",
        sizeof(RigidBodyNetSnapshot), alignof(RigidBodyNetSnapshot),
        LittleEndian() ? "true" : "false",
        offsetof(RigidBodyNetSnapshot, frame), offsetof(RigidBodyNetSnapshot, tickMs),
        offsetof(RigidBodyNetSnapshot, serverTimeSec), offsetof(RigidBodyNetSnapshot, position),
        offsetof(RigidBodyNetSnapshot, rotation), offsetof(RigidBodyNetSnapshot, velocity),
        offsetof(RigidBodyNetSnapshot, angularVelocity), offsetof(RigidBodyNetSnapshot, accel));
      std::fclose(f);
      std::printf("  已写出 layout.json\n");
      Check(true, "layout.json 写出成功");
    } else {
      Check(false, "layout.json 写出失败");
    }
  }

  std::printf("\n结果：%d 通过 / %d 失败\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
