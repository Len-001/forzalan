// test_shim/glm/gtx/quaternion.hpp —— 见 glm/glm.hpp 顶部说明（最小子集 shim）
#pragma once
#include <glm/gtc/quaternion.hpp>

namespace glm {

// 旋转角 ∈ [0, π]（与 GLM 一致）
template <typename T> inline T angle(quat_t<T> q) {
  T w = q.w;
  if (w < T(0)) w = -w;
  if (w > T(1)) w = T(1);
  return T(2) * std::acos(w);
}

// 球面线性插值（与 GLM 同签名：slerp(x, y, a)）
template <typename T> inline quat_t<T> slerp(quat_t<T> x, quat_t<T> y, T a) {
  T d = dot(x, y);
  if (d < T(0)) { y = quat_t<T>(-y.w, -y.x, -y.y, -y.z); d = -d; }
  if (d > T(0.9995)) {   // 夹角极小 -> 退化成 nlerp，避免除零
    return normalize(quat_t<T>(x.w + (y.w - x.w) * a, x.x + (y.x - x.x) * a,
                               x.y + (y.y - x.y) * a, x.z + (y.z - x.z) * a));
  }
  const T th0 = std::acos(d);
  const T th  = th0 * a;
  const T s0  = std::sin(th0 - th) / std::sin(th0);
  const T s1  = std::sin(th) / std::sin(th0);
  return normalize(quat_t<T>(x.w*s0 + y.w*s1, x.x*s0 + y.x*s1,
                             x.y*s0 + y.y*s1, x.z*s0 + y.z*s1));
}

}  // namespace glm
