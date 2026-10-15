// =============================================================================
//  layout_probe.cpp —— 线格式契约的"真值发生器"（用普通 g++ 编译，不需要 Emscripten）
//
//  用途：C++ 结构体的布局是**唯一真值**。TS 侧的偏移常量不允许手抄 ——
//        本程序把 sizeof/offsetof 与一份"已知取值的参考快照字节块"一起吐出来，
//        再由 tools/gen_layout.mjs 生成 snapshotLayout.ts、由 verify_wire.mjs 校验解码。
//
//  为什么必须这么做：TS 与 C++ 之间的偏移一旦漂移，症状是"位置偶尔错乱"，
//  极难定位。把手抄改成生成 + 交叉校验，是这里唯一靠谱的做法。
//
//  编译运行（本机实测）：
//    g++ -std=c++20 -O2 tools/layout_probe.cpp -o build/layout_probe.exe && ./build/layout_probe.exe > layout.json
// =============================================================================
#include "../rb_replicator/rigid_body_replicator.h"

#include <cstddef>
#include <cstdio>
#include <cstring>
#include <vector>

using forza::net::RigidBodyNetSnapshot;

int main() {
  // ---- 1) 布局真值 ----
  std::printf("{\n");
  std::printf("  \"layoutVersion\": 1,\n");
  std::printf("  \"sizeof\": %zu,\n", sizeof(RigidBodyNetSnapshot));
  std::printf("  \"alignof\": %zu,\n", alignof(RigidBodyNetSnapshot));
  std::printf("  \"byteOrder\": \"%s\",\n",
#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
              "big"
#else
              "little"
#endif
  );
  std::printf("  \"offsets\": {\n");
  std::printf("    \"frame\": %zu,\n", offsetof(RigidBodyNetSnapshot, frame));
  std::printf("    \"tickMs\": %zu,\n", offsetof(RigidBodyNetSnapshot, tickMs));
  std::printf("    \"serverTimeSec\": %zu,\n", offsetof(RigidBodyNetSnapshot, serverTimeSec));
  std::printf("    \"position\": %zu,\n", offsetof(RigidBodyNetSnapshot, position));
  std::printf("    \"rotation\": %zu,\n", offsetof(RigidBodyNetSnapshot, rotation));
  std::printf("    \"velocity\": %zu,\n", offsetof(RigidBodyNetSnapshot, velocity));
  std::printf("    \"angularVelocity\": %zu,\n", offsetof(RigidBodyNetSnapshot, angularVelocity));
  std::printf("    \"accel\": %zu\n", offsetof(RigidBodyNetSnapshot, accel));
  std::printf("  },\n");

  // ---- 2) 参考快照：取值全部"可肉眼核对"，避免浮点误差干扰判定 ----
  RigidBodyNetSnapshot s{};
  s.frame = 0x00112233U;
  s.tickMs = 0x00445566U;
  s.serverTimeSec = 12.5F;
  s.position = glm::vec3(1.5F, -2.25F, 3.75F);
  s.rotation = glm::quat(0.5F, 0.5F, 0.5F, 0.5F);   // 单位四元数（90° 绕某轴）
  s.velocity = glm::vec3(30.0F, 0.5F, -12.0F);
  s.angularVelocity = glm::vec3(0.25F, 1.5F, -0.75F);
  s.accel = glm::vec3(9.0F, -1.0F, 0.0F);

  // 快照是 trivially copyable，可直接按字节取出
  static_assert(std::is_trivially_copyable_v<RigidBodyNetSnapshot>);
  std::vector<unsigned char> bytes(sizeof(RigidBodyNetSnapshot));
  std::memcpy(bytes.data(), &s, sizeof(s));

  std::printf("  \"reference\": {\n");
  std::printf("    \"frame\": %u,\n", s.frame);
  std::printf("    \"tickMs\": %u,\n", s.tickMs);
  std::printf("    \"serverTimeSec\": %.6f,\n", static_cast<double>(s.serverTimeSec));
  std::printf("    \"position\": [%.6f, %.6f, %.6f],\n", s.position.x, s.position.y, s.position.z);
  std::printf("    \"rotation\": [%.6f, %.6f, %.6f, %.6f],\n",
              s.rotation.w, s.rotation.x, s.rotation.y, s.rotation.z);
  std::printf("    \"velocity\": [%.6f, %.6f, %.6f],\n", s.velocity.x, s.velocity.y, s.velocity.z);
  std::printf("    \"angularVelocity\": [%.6f, %.6f, %.6f],\n",
              s.angularVelocity.x, s.angularVelocity.y, s.angularVelocity.z);
  std::printf("    \"accel\": [%.6f, %.6f, %.6f]\n", s.accel.x, s.accel.y, s.accel.z);
  std::printf("  },\n");

  // ---- 3) 参考字节块（十六进制）—— 给 JS 侧做真正的解码校验 ----
  std::printf("  \"referenceHex\": \"");
  for (unsigned char b : bytes) std::printf("%02x", b);
  std::printf("\"\n}\n");
  return 0;
}
