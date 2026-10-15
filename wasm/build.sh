#!/usr/bin/env bash
# =============================================================================
#  forza_net —— 一键 Wasm 构建（等价于 CMakeLists.txt，供不想用 CMake 时直用）
#
#    EMSDK=<emsdk 路径> ./build.sh
#
#  本机**未安装 emsdk**，脚本会先检查；缺了会给出安装指引而不是静默失败。
# =============================================================================
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# ---- GLM：与 native/run_tests.sh 用同一套探测顺序 ----
GLM_DIR=""
for c in /usr/include /usr/local/include /e/mingw64/include \
         /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  if [ -f "$c/glm/glm.hpp" ]; then GLM_DIR="$c"; break; fi
done
[ -n "$GLM_DIR" ] || { echo "找不到 GLM（需要含 glm/ 的父目录）" >&2; exit 1; }

# ---- emsdk ----
if ! command -v em++ >/dev/null 2>&1; then
  for c in "$ROOT/../emsdk" /e/emsdk /c/emsdk; do
    if [ -f "$c/emsdk_env.sh" ]; then
      # shellcheck disable=SC1091
      . "$c/emsdk_env.sh" >/dev/null 2>&1 || true
      break
    fi
  done
fi
if ! command -v em++ >/dev/null 2>&1; then
  cat >&2 <<'MSG'
找不到 em++。本机目前未安装 Emscripten。安装方式（任选其一）：
  git clone https://github.com/emscripten-core/emsdk.git && cd emsdk \
    && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
装好后重新执行本脚本即可。源码与 CMake 配置无需改动。
MSG
  exit 1
fi

echo "em++: $(em++ --version | head -1)"
echo "GLM : $GLM_DIR"

mkdir -p "$HERE/dist"
em++ -std=c++20 -O3 -flto -msimd128 -fno-exceptions -fno-rtti \
  --bind \
  -I"$HERE" -I"$ROOT/native/rb_replicator" -I"$ROOT/native/timesync" -I"$GLM_DIR" \
  "$HERE/bindings.cpp" "$ROOT/native/timesync/forza_time_sync.cpp" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createForzaNet \
  -sENVIRONMENT=web,worker \
  -sINITIAL_MEMORY=67108864 -sALLOW_MEMORY_GROWTH=1 \
  -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 -sASSERTIONS=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -sEXPORTED_FUNCTIONS=_forzaPushSnapshot,_forzaUpdate,_forzaVisualMatrixPtr,_forzaPhysicsMatrixPtr,_forzaClockOnPong,_forzaClockAdjustedDt,_forzaClockServerNow,_forzaClockWarp,_forzaClockReset,_forzaReplState,_forzaReplVisualError,_forzaSnapshotStride,_forzaSnapshotOffset,_malloc,_free \
  -o "$HERE/dist/forza_net.js"

echo "构建完成: $HERE/dist/forza_net.js (+ .wasm)"
