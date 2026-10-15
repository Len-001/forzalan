#!/usr/bin/env bash
# =============================================================================
#  native/ —— C++ 模块的编译 + 单测一键脚本
#
#    ./run_tests.sh
#
#  八段：timesync / rb_replicator / wasm bridge / safe_physics(新) / safe_collision(废弃转发层) /
#        race_delta / harness(全链路压测) / mp_chaos(单机无头多人混沌仿真)。
#  safe_physics 段是本工程"零反弹"命题的**权威实现**（SafePhysicsSolver，117 项）。
#  safe_collision 段退化为**兼容壳**的回归验证（旧类名必须转发到新行为）。
#  timesync 段另附 Python 镜像交叉验证（verify_algorithm.py，28 项）—— 两条独立实现互证。
#  race_delta 段同样另有 Python 镜像（verify_race_delta.py，37 项）。
#  rb_replicator 段另有 verify_blending.py 数学镜像（V1~V7）。
#  mp_chaos 段：一个进程起 1 服务端 + 4 客户端（1 本地 + 3 无头 Bot），
#  注入混沌信道（RTT 100ms / 抖动 20~160ms 长尾 / 8% 丢包 / 5% 乱序），
#  量化闪现(Rubberbanding)、HUD 秒差双分支、碰撞不弹开 —— 28 项 + 确定性回归。
#
#  本机 g++ 位于 /e/mingw64/bin（不在默认 PATH 上），脚本会自动找。
#  rb_replicator 需要 GLM：本机没装且无网络，脚本回退到 test_shim/ 的
#  **最小子集 shim**（签名对齐 GLM）—— 能验证 C++ 实现与算法，
#  但**不能**验证与真 GLM 的 API 兼容性。装了真 GLM 时会自动优先用它。
#  [7/7] harness 例外：压测需要真实四元数/矩阵行为，**不回退 shim**，
#  找不到真 GLM 时整段跳过并在末尾提示。
# =============================================================================
set -u

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

CXXFLAGS="-std=c++20 -O2 -Wall -Wextra -Wpedantic"
FAILED=0
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "编译器: $("$GXX" --version | head -1)"
echo

# ---------------------------------------------------------------------------
# 1) ForzaTimeSynchronizer —— 零外部依赖
# ---------------------------------------------------------------------------
echo "=== [1/8] timesync ==="
cd "$HERE/timesync" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS forza_time_sync.cpp forza_time_sync_test.cpp -o build/ts_test.exe; then
  ./build/ts_test.exe || FAILED=1
else
  echo "  [编译失败] timesync" >&2
  FAILED=1
fi
# Python 镜像交叉复核：两条独立实现给同一结论，说明方程本身对（非单处转写凑巧）
for PY in python python3 "$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
          /c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  —— Python 镜像交叉验证（verify_algorithm.py）——"
    "$PY" verify_algorithm.py || FAILED=1
    break
  fi
done
echo

# ---------------------------------------------------------------------------
# 2) NetworkRigidBodyReplicator —— 依赖 GLM
# ---------------------------------------------------------------------------
echo "=== [2/8] rb_replicator ==="
cd "$HERE/rb_replicator" || exit 1
# 优先真 GLM；都找不到才回退 shim。
# 注意 GLM 的 -I 要指向**含 glm/ 子目录的父目录**，不是 glm/ 本身。
GLM_FLAGS=""
GLM_SRC=""
for cand in /usr/include /usr/local/include /e/mingw64/include \
            /e/g-truc-glm-8d1fd52 /e/glm /e/GLM; do
  if [ -f "$cand/glm/glm.hpp" ]; then GLM_SRC="$cand"; break; fi
done
if [ -n "$GLM_SRC" ]; then
  GLM_FLAGS="-I $GLM_SRC"
  echo "  (使用真 GLM: $GLM_SRC)"
else
  echo "  (未找到真 GLM -> 回退 test_shim/ 最小子集 shim。"
  echo "   它只能验证 C++ 实现与算法，**不能**验证与真 GLM 的 API 兼容性)"
  GLM_FLAGS="-I test_shim"
fi
if "$GXX" $CXXFLAGS $GLM_FLAGS rigid_body_replicator_test.cpp -o build_rb.exe; then
  ./build_rb.exe || FAILED=1
else
  echo "  [编译失败] rb_replicator" >&2
  FAILED=1
fi
# Python 数学镜像：验证"半衰期/帧率无关/零跳变/150ms 截断+滑行/短弧"五个定量性质
for PY in python python3 "$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
          /c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  —— Python 数学镜像（verify_blending.py）——"
    "$PY" verify_blending.py || FAILED=1
    break
  fi
done
echo

# ---------------------------------------------------------------------------
# 3) wasm 宿主层 —— 32B 线格式 + 多车注册表 + HUD 文本 + 跨语言逐字节校验
#    （Embind 那层需要 emcc，本机没有；但它只是薄封装，风险集中在下面这些）
# ---------------------------------------------------------------------------
echo "=== [3/8] wasm host（wire / registry / HUD）==="
cd "$HERE/wasm" || exit 1
if "$GXX" $CXXFLAGS ${GLM_FLAGS:--I test_shim} \
     wasm_bindings_test.cpp ../timesync/forza_time_sync.cpp ../race_delta/race_delta_tracker.cpp \
     -o bridge_test.exe 2>/dev/null || \
   "$GXX" $CXXFLAGS -I /e/g-truc-glm-8d1fd52 \
     wasm_bindings_test.cpp ../timesync/forza_time_sync.cpp ../race_delta/race_delta_tracker.cpp \
     -o bridge_test.exe; then
  ./bridge_test.exe || FAILED=1
else
  echo "  [编译失败] wasm/wasm_bindings_test.cpp" >&2
  FAILED=1
fi
# 跨语言逐字节校验（node）：C++ dump 真值 vs TS 位打包器
#   ⚠️ 这一步非有不可：NetworkEngine.ts 里有一份**独立的 JS 位打包实现**，
#      两处只要有一位不一致，就只在"跨语言"时暴露 —— 单语言测试永远绿。
if command -v node >/dev/null 2>&1; then
  ./bridge_test.exe --dump-wire wire_dump.json >/dev/null 2>&1 || true
  node verify_engine_wire.mjs || FAILED=1
else
  echo "  (跳过 verify_engine_wire.mjs：未找到 node)"
fi

# 跨语言布局校验（node）：拿 layout.json 去对 TS 里硬写的 96B 期望值
node verify_layout.mjs || FAILED=1

# TS 严格类型检查（需要 tsc；装法见下）
TSC=""
for c in "$HOME/.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc" \
         /c/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc; do
  if [ -f "$c" ]; then TSC="$c"; break; fi
done
if [ -n "$TSC" ] && command -v node >/dev/null 2>&1; then
  echo "  —— TS 严格类型检查（NetworkPhysicsClient + NetworkEngine）——"
  node "$TSC" -p tsconfig.check.json && echo "  TS 类型检查通过" || FAILED=1
else
  echo "  (跳过 TS 类型检查：未找到 tsc)"
  echo "   装法：cd ~/.workbuddy/binaries/node/workspace && npm install typescript"
fi
echo

# ---------------------------------------------------------------------------
# 4) SafePhysicsSolver —— 零外部依赖（本工程"零反弹"命题的**权威实现**）
#    核心命题：分离冲量**绝不注入虚假动能**（防炸车/防弹飞的根因）
#    关键性质：§1 无条件法线平整化（防跳板）/ §2 速度自适应塑性恢复（阈值以上 e=0）
#              §3 分离冲量（位置相不碰 velocity，单子步 ≤3cm）/ §4 悬挂解耦
#              §5 冲量硬截断（4e4 N·s）
#    验收：两车 200km/h 侧撞与正撞，碰后法向分离速度 ≤ 0.5 m/s（彻底无反弹）
# ---------------------------------------------------------------------------
echo "=== [4/8] safe_physics ==="
cd "$HERE/safe_physics" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS safe_physics_test.cpp -o build/safe_physics_test.exe; then
  ./build/safe_physics_test.exe || FAILED=1
else
  echo "  [编译失败] safe_physics" >&2
  FAILED=1
fi
echo

# ---------------------------------------------------------------------------
# 5) SafeCollisionResolver —— 【废弃转发层】只做兼容性回归
#    本文件已无实现，全部算法在 safe_physics。此段验证：
#      · 旧类名/旧类型别名仍可编译（下游不炸）
#      · 旧类名调用**确实转发到新行为**（不是静默走旧参数）
#      · 旧的 ResolverConfig{} 仍能 aggregate-init
# ---------------------------------------------------------------------------
echo "=== [5/8] safe_collision（deprecated 转发层回归）==="
cd "$HERE/safe_collision" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS -I "$HERE/safe_physics" safe_collision_test.cpp -o build/safe_test.exe; then
  ./build/safe_test.exe || FAILED=1
else
  echo "  [编译失败] safe_collision" >&2
  FAILED=1
fi
echo

# ---------------------------------------------------------------------------
# 6) RaceDeltaTracker —— 零外部依赖
#    核心命题：时差必须走"弧长差 ÷ **前车**分段速度"，绝不用欧氏距离 ÷ 实时速度
#    关键性质：格式化三档（--/-0.X/-X.XX）、非领先方恒负号、外推不发弯道畸变
# ---------------------------------------------------------------------------
echo "=== [6/8] race_delta ==="
cd "$HERE/race_delta" || exit 1
mkdir -p build
if "$GXX" $CXXFLAGS race_delta_tracker.cpp race_delta_tracker_test.cpp -o build/rd_test.exe; then
  ./build/rd_test.exe || FAILED=1
else
  echo "  [编译失败] race_delta" >&2
  FAILED=1
fi
# Python 镜像交叉复核：独立按规格重写公式，与 C++ 侧数值逐条比对
for PY in python python3 "$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
          /c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe; do
  if command -v "$PY" >/dev/null 2>&1; then
    echo "  —— Python 镜像交叉验证（verify_race_delta.py）——"
    "$PY" verify_race_delta.py || FAILED=1
    break
  fi
done
echo

echo "=== [7/8] harness（四模块全链路 + 混沌网络压测） ==="
cd "$HERE/harness" || exit 1
# 压测需要真 GLM（glm::quat / glm::angleAxis），不回退 shim
if [ -n "$GLM_SRC" ]; then
  if "$GXX" $CXXFLAGS -I "$HERE/timesync" -I "$HERE/rb_replicator" -I "$HERE/wasm" \
       -I "$HERE/safe_collision" -I "$HERE/safe_physics" -I "$GLM_SRC" \
       simulation_harness.cpp "$HERE/timesync/forza_time_sync.cpp" -o harness.exe; then
    ./harness.exe || FAILED=1
  else
    echo "  [编译失败] simulation_harness.cpp" >&2
    FAILED=1
  fi
else
  echo "  [跳过] 未找到真 GLM（压测需要真实四元数行为，不回退 shim）"
fi
echo

# ---------------------------------------------------------------------------
# 8) mp_chaos —— 单机无头多人混沌仿真测试台（Simulation Test Harness）
#    一个进程内起 1 权威服务端 + 4 客户端（1 本地带渲染平滑层 + 3 无头 Bot），
#    注入 **混沌信道**（RTT 100ms / 抖动 20~160ms 非对称长尾 / 8% 丢包 /
#    5% 乱序），用 Client 0 观察远端 3 车，量化"闪现 / Rubberbanding"。
#    四相断言：A 信道统计 / B Jitter 与 Jerk / C HUD 秒差双分支 / D 碰撞不弹开。
#    复用真模块：ForzaTimeSynchronizer + NetworkRigidBodyReplicator +
#                SafePhysicsSolver + RaceDeltaTracker；零额外依赖。
#    确定性：同 seed ⇒ 逐字节一致的日志（可当回归基线）。
#    需要真 GLM（rb_replicator 用 glm::quat），不回退 shim。
# ---------------------------------------------------------------------------
echo "=== [8/8] mp_chaos（单机无头多人混沌仿真测试台） ==="
cd "$HERE/mp_chaos" || exit 1
mkdir -p build
if [ -n "$GLM_SRC" ]; then
  if "$GXX" $CXXFLAGS -I "$HERE/timesync" -I "$HERE/rb_replicator" \
       -I "$HERE/safe_physics" -I "$HERE/race_delta" -I "$GLM_SRC" \
       mp_chaos_harness.cpp "$HERE/timesync/forza_time_sync.cpp" \
       "$HERE/race_delta/race_delta_tracker.cpp" -o build/mp_chaos.exe; then
    ./build/mp_chaos.exe || FAILED=1
    # 确定性回归：同 seed 两次运行必须一致（日志可当基线）
    #   屏蔽掉所有**墙钟相关**的输出行再比对 —— 它们随机器负载浮动，不是"随机源"：
    #     · 真实墙钟 / 等效帧率 / 仿真吞吐（都是耗时统计）
    if ./build/mp_chaos.exe -q > .det_a.txt 2>&1 && \
       ./build/mp_chaos.exe -q > .det_b.txt 2>&1; then
      if diff -q <(grep -v "真实墙钟\|等效帧率\|仿真吞吐" .det_a.txt) \
                 <(grep -v "真实墙钟\|等效帧率\|仿真吞吐" .det_b.txt) >/dev/null; then
        echo "  [PASS] ★★ 同 seed 输出逐字一致（确定性 ⇒ 可当回归基线）"
      else
        echo "  [FAIL] 同 seed 输出不一致（随机源没接确定性 RNG？）" >&2
        FAILED=1
      fi
    fi
    rm -f .det_a.txt .det_b.txt
  else
    echo "  [编译失败] mp_chaos_harness.cpp" >&2
    FAILED=1
  fi
else
  echo "  [跳过] 未找到真 GLM（rb_replicator 需要真实四元数，不回退 shim）"
fi
echo

if [ "$FAILED" -eq 0 ]; then
  echo "=== 全部通过 ==="
else
  echo "=== 有失败项 ===" >&2
fi
exit "$FAILED"
