// =============================================================================
//  test_shim/glm/glm.hpp —— **仅用于本机无 GLM 时的编译/运行验证，不是 GLM 的替代品**
//
//  本机没有 GLM 也没有网络，无法安装真库。为了让 rigid_body_replicator_test.cpp
//  能真正编译并执行（Python 镜像只能验证数学，验证不了 C++ 实现本身），
//  这里提供一个**最小子集 shim**：只实现代码实际用到的那几个 API，
//  且**签名与 GLM 保持一致**（若签名对不上，编译会失败 —— 这正是我们想暴露的信息）。
//
//  使用：g++ -I test_shim ...
//  ⚠️ 生产环境请使用真 GLM：apt install libglm-dev / vcpkg install glm
// =============================================================================
#pragma once
#include <cmath>
#include <cstddef>

namespace glm {

using length_t = int;

template <typename T> struct vec3_t {
  T x{}, y{}, z{};
  vec3_t() = default;
  explicit vec3_t(T s) : x(s), y(s), z(s) {}
  vec3_t(T a, T b, T c) : x(a), y(b), z(c) {}
  T& operator[](length_t i) { return (&x)[i]; }
  const T& operator[](length_t i) const { return (&x)[i]; }
};

using vec3 = vec3_t<float>;
using vec2 = vec3_t<float>;   // 本工程未用 vec2，占位

template <typename T> inline vec3_t<T> operator+(vec3_t<T> a, vec3_t<T> b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
template <typename T> inline vec3_t<T> operator-(vec3_t<T> a, vec3_t<T> b) { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
template <typename T> inline vec3_t<T> operator*(vec3_t<T> a, T s) { return {a.x*s, a.y*s, a.z*s}; }
template <typename T> inline vec3_t<T> operator*(T s, vec3_t<T> a) { return a * s; }
template <typename T> inline vec3_t<T>& operator+=(vec3_t<T>& a, vec3_t<T> b) { a.x+=b.x; a.y+=b.y; a.z+=b.z; return a; }
template <typename T> inline vec3_t<T>& operator-=(vec3_t<T>& a, vec3_t<T> b) { a.x-=b.x; a.y-=b.y; a.z-=b.z; return a; }
template <typename T> inline vec3_t<T>& operator*=(vec3_t<T>& a, T s) { a.x*=s; a.y*=s; a.z*=s; return a; }
template <typename T> inline vec3_t<T> operator/(vec3_t<T> a, T s) { return {a.x/s, a.y/s, a.z/s}; }
template <typename T> inline vec3_t<T>& operator/=(vec3_t<T>& a, T s) { a.x/=s; a.y/=s; a.z/=s; return a; }

template <typename T> inline T dot(vec3_t<T> a, vec3_t<T> b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
template <typename T> inline T length(vec3_t<T> a) { return std::sqrt(dot(a, a)); }
template <typename T> inline vec3_t<T> normalize(vec3_t<T> a) {
  const T l = length(a); return (l > T(0)) ? a * (T(1) / l) : a;
}
template <typename T> inline vec3_t<T> cross(vec3_t<T> a, vec3_t<T> b) {
  return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
inline float abs(float s) { return std::fabs(s); }

// 4x4 列主序矩阵（与 GLM 一致）
template <typename T> struct mat4_t {
  T m[16]{};
  mat4_t() = default;
  explicit mat4_t(T diag) { m[0]=m[5]=m[10]=m[15]=diag; }
  T& operator[](length_t i) { return m[i]; }
  const T& operator[](length_t i) const { return m[i]; }
};
using mat4 = mat4_t<float>;

template <typename T> inline mat4_t<T> operator*(const mat4_t<T>& a, const mat4_t<T>& b) {
  mat4_t<T> r;
  for (int c = 0; c < 4; ++c) {
    for (int row = 0; row < 4; ++row) {
      T s = T(0);
      for (int k = 0; k < 4; ++k) s += a.m[k * 4 + row] * b.m[c * 4 + k];
      r.m[c * 4 + row] = s;
    }
  }
  return r;
}
// 变换一个点（w=1）
template <typename T> inline vec3_t<T> operator*(const mat4_t<T>& a, vec3_t<T> v) {
  return { a.m[0]*v.x + a.m[4]*v.y + a.m[8]*v.z  + a.m[12],
           a.m[1]*v.x + a.m[5]*v.y + a.m[9]*v.z  + a.m[13],
           a.m[2]*v.x + a.m[6]*v.y + a.m[10]*v.z + a.m[14] };
}

inline float radians(float deg) { return deg * 3.14159265358979323846F / 180.0F; }
inline float degrees(float rad) { return rad * 180.0F / 3.14159265358979323846F; }

}  // namespace glm
