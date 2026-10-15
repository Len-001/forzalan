// test_shim/glm/gtc/quaternion.hpp —— 见 glm/glm.hpp 顶部说明（最小子集 shim）
#pragma once
#include <glm/glm.hpp>

namespace glm {

// 与 GLM 一致：(w, x, y, z)
template <typename T> struct quat_t {
  T w{}, x{}, y{}, z{};
  quat_t() = default;
  quat_t(T w_, T x_, T y_, T z_) : w(w_), x(x_), y(y_), z(z_) {}
};
using quat = quat_t<float>;

template <typename T> inline T dot(quat_t<T> a, quat_t<T> b) {
  return a.w*b.w + a.x*b.x + a.y*b.y + a.z*b.z;
}
template <typename T> inline T length(quat_t<T> q) { return std::sqrt(dot(q, q)); }
template <typename T> inline quat_t<T> normalize(quat_t<T> q) {
  const T l = length(q); if (l <= T(0)) return quat_t<T>(T(1), T(0), T(0), T(0));
  return quat_t<T>(q.w/l, q.x/l, q.y/l, q.z/l);
}
template <typename T> inline quat_t<T> operator*(quat_t<T> a, quat_t<T> b) {
  return quat_t<T>(
    a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w);
}
// GLM: inverse(quat) 即共轭/模长平方（单位四元数下就是共轭）
template <typename T> inline quat_t<T> inverse(quat_t<T> q) {
  const T d = dot(q, q); if (d <= T(0)) return quat_t<T>(T(1), T(0), T(0), T(0));
  return quat_t<T>(q.w/d, -q.x/d, -q.y/d, -q.z/d);
}
// 轴角 -> 四元数
template <typename T> inline quat_t<T> angleAxis(T angle, vec3_t<T> axis) {
  const T l = length(axis);
  if (l <= T(0)) return quat_t<T>(T(1), T(0), T(0), T(0));
  const vec3_t<T> a = axis * (T(1) / l);
  const T h = angle * T(0.5);
  const T s = std::sin(h);
  return quat_t<T>(std::cos(h), a.x*s, a.y*s, a.z*s);
}
// 四元数 -> 旋转矩阵（列主序）
template <typename T> inline mat4_t<T> mat4_cast(quat_t<T> q) {
  const T xx=q.x*q.x, yy=q.y*q.y, zz=q.z*q.z;
  const T xy=q.x*q.y, xz=q.x*q.z, yz=q.y*q.z;
  const T wx=q.w*q.x, wy=q.w*q.y, wz=q.w*q.z;
  mat4_t<T> r(T(1));
  r.m[0]=T(1)-T(2)*(yy+zz); r.m[1]=T(2)*(xy+wz);      r.m[2]=T(2)*(xz-wy);
  r.m[4]=T(2)*(xy-wz);      r.m[5]=T(1)-T(2)*(xx+zz);  r.m[6]=T(2)*(yz+wx);
  r.m[8]=T(2)*(xz+wy);      r.m[9]=T(2)*(yz-wx);       r.m[10]=T(1)-T(2)*(xx+yy);
  return r;
}

}  // namespace glm
