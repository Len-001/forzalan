#!/usr/bin/env bash
# =============================================================================
#  native/harness/ —— 四模块全链路联调 & 混沌网络压测 一键脚本
#
#    ./run_harness.sh                 # 默认 seed=20260925，仿真 12s
#    ./run_harness.sh --seed=7 --sec=20
#
#  链路：timesync + rb_replicator + safe_collision + wasm bridge
#  跑法要点（与 ../run_tests.sh 一致）：
#   · 本机 g++ 位于 /e/mingw64/bin（不在默认 PATH），脚本自动找并导出 PATH
#     —— MinGW 产物需要运行时 DLL，不加 PATH 会以 127 静默退出。
#   · 依赖真 GLM（rb_replicator / wasm bridge 用到 glm::quat / glm::angleAxis）。
#     找不到真 GLM 时**不**回退 shim：压测要的是真实矩阵/四元数行为，
#     shim 缺失 glm::quat(vec3) 等构造，编不过也不该假装能跑。
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"

# ---- 找 g++ ----
GXX=""
if command -v g++ >/dev/null 2>&1; then
  GXX="g++"
else
  for c in /e/mingw64/bin/g++.exe /c/msys64/mingw64/bin/g++.exe /c/mingw64/bin/g++.exe; do
    if [ -x "$c" ]; then GXX="$c"; break; fi
  done
fi
if [ -z "$GXX" ]; then
  echo "找不到 g++。请把编译器目录加进 PATH 后重试。" >&2
  exit 127
fi
# MinGW 产物需要运行时 DLL，把它们所在目录也放进 PATH
GXX_DIR="$(dirname "$GXX")"
export PATH="$GXX_DIR:$PATH"

# ---- 找真 GLM（-I 指向含 glm/ 的父目录）----
GLM_SRC=""
for cand in /usr/include /usr/local/include /e/mingw64/include \
            /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  if [ -f "$cand/glm/glm.hpp" ]; then GLM_SRC="$cand"; break; fi
done
if [ -z "$GLM_SRC" ]; then
  echo "找不到真 GLM（glm/glm.hpp）。压测需要真实四元数/矩阵行为，不回退 shim。" >&2
  echo "改 glm.hpp 的 -I 路径见本脚本顶部 GLM_SRC 候选列表。" >&2
  exit 1
fi

CXXFLAGS="-std=c++20 -O2 -Wall -Wextra -Wpedantic"
INCLUDES="-I $HERE/../timesync -I $HERE/../rb_replicator -I $HERE/../wasm -I $HERE/../safe_collision -I $GLM_SRC"

echo "编译器: $("$GXX" --version | head -1)"
echo "GLM   : $GLM_SRC"
echo

cd "$HERE" || exit 1

# ---------------------------------------------------------------------------
# 编译（-Werror 关掉：压测程序自带大量 %s/%d 打印，
# 但 -Wall -Wextra -Wpedantic 全开会暴露真问题；本模块目标就是 0 warning）
# ---------------------------------------------------------------------------
echo "=== [1/2] 编译 harness ==="
if ! "$GXX" $CXXFLAGS $INCLUDES simulation_harness.cpp ../timesync/forza_time_sync.cpp -o harness.exe; then
  echo "  [编译失败] simulation_harness.cpp" >&2
  exit 1
fi
echo "  编译通过（0 warning）"
echo

# ---------------------------------------------------------------------------
# 运行（参数透传：--seed=N / --sec=N / -q / -v）
# ---------------------------------------------------------------------------
echo "=== [2/2] 运行混沌压测 ==="
./harness.exe "$@"
RC=$?
echo
if [ "$RC" -eq 0 ]; then
  echo "=== harness 通过 ==="
else
  echo "=== harness 有失败项 (rc=$RC) ===" >&2
fi
exit "$RC"
