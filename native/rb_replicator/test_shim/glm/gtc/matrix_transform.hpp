// test_shim/glm/gtc/matrix_transform.hpp —— 见 glm/glm.hpp 顶部说明（最小子集 shim）
#pragma once
#include <glm/glm.hpp>

namespace glm {

// translate(mat4, vec3)：把平移写进列主序矩阵的第 4 列（与 GLM 一致）
template <typename T> inline mat4_t<T> translate(const mat4_t<T>& m0, vec3_t<T> v) {
  mat4_t<T> r = m0;
  r.m[12] = m0.m[0]*v.x + m0.m[4]*v.y + m0.m[8]*v.z  + m0.m[12];
  r.m[13] = m0.m[1]*v.x + m0.m[5]*v.y + m0.m[9]*v.z  + m0.m[13];
  r.m[14] = m0.m[2]*v.x + m0.m[6]*v.y + m0.m[10]*v.z + m0.m[14];
  r.m[15] = m0.m[3]*v.x + m0.m[7]*v.y + m0.m[11]*v.z + m0.m[15];
  return r;
}

}  // namespace glm
