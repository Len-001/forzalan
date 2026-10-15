#!/usr/bin/env bash
# =============================================================================
#  wasm/ —— 线格式契约验证一键脚本
#
#    ./verify.sh
#
#  做两件事：
#    1) 用**普通 g++** 编译 tools/layout_probe.cpp 并执行 -> 重新生成 layout.json
#       （C++ 的 sizeof/offsetof 是唯一真值）
#    2) 跑 web/tools/verify_wire.mjs -> 用它去解 C++ 吐出的参考字节块，
#       并检查 TS 源码里的偏移常量和 layout.json 是否漂移
#
#  注意：**不需要 Emscripten**。验的是"TS 与 C++ 的二进制契约"，
#  和 Wasm 编译是两件独立的事。Wasm 编译请用 ./build.sh（需 emsdk）。
# =============================================================================
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

GXX=""
command -v g++ >/dev/null 2>&1 && GXX="g++"
[ -n "$GXX" ] || for c in /e/mingw64/bin/g++.exe /c/msys64/mingw64/bin/g++.exe; do
  [ -x "$c" ] && GXX="$c" && break
done
[ -n "$GXX" ] || { echo "找不到 g++" >&2; exit 127; }
export PATH="$(dirname "$GXX"):$PATH"

GLM_DIR=""
for c in /usr/include /usr/local/include /e/mingw64/include \
         /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  [ -f "$c/glm/glm.hpp" ] && GLM_DIR="$c" && break
done
[ -n "$GLM_DIR" ] || { echo "找不到 GLM" >&2; exit 1; }

echo "=== [1/2] 生成 C++ 布局真值 ==="
mkdir -p "$HERE/build"
"$GXX" -std=c++20 -O2 -Wall -Wextra -Wpedantic \
  -I "$ROOT/native/rb_replicator" -I "$GLM_DIR" \
  "$HERE/tools/layout_probe.cpp" -o "$HERE/build/layout_probe.exe"
"$HERE/build/layout_probe.exe" > "$HERE/layout.json"
echo "  -> $HERE/layout.json"

echo
echo "=== [2/2] TS <-> C++ 线格式契约验证 ==="
NODE=""
command -v node >/dev/null 2>&1 && NODE="node"
[ -n "$NODE" ] || NODE="/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"

# --experimental-strip-types：Node >= 22.6 原生剥离 TS 类型。
# 用它就能**直接 import 出货的 .ts**，验的不是镜像而是要发布的代码。
cd "$ROOT"
"$NODE" --experimental-strip-types web/tools/verify_wire.mjs
