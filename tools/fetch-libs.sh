#!/usr/bin/env bash
# =============================================================================
# fetch-libs.sh —— 一次性把本地引擎库拉进 public/libs/（此后再也不需要联网）
#
#   bash tools/fetch-libs.sh
#
# 说明：所谓"零 CDN"指的是**运行期**不发起任何外部请求。库文件本身必须有第一次来源，
# 本脚本就是那次唯一的外部动作；执行完 public/libs/ 里就有完整副本，
# 之后拷贝整个项目到任何离线机器都能直接 go build + 运行。
#
# Windows 用户若没有 bash，可直接用 PowerShell 等价写法（二选一）：
#   iwr https://unpkg.com/three@0.128.0/build/three.min.js -OutFile public/libs/three.min.js
#   iwr https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js -OutFile public/libs/cannon-es.js
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

THREE_VER="0.128.0"
CANNON_VER="0.20.0"

mkdir -p public/libs

echo "==> three.js r128  (UMD 构建，挂载 window.THREE)"
curl -fsSL -o public/libs/three.min.js \
  "https://unpkg.com/three@${THREE_VER}/build/three.min.js"

echo "==> cannon-es     (独立 ESM 构建，零依赖)"
curl -fsSL -o public/libs/cannon-es.js \
  "https://unpkg.com/cannon-es@${CANNON_VER}/dist/cannon-es.js"

# cannon-es.js 是 ESM；补一个 package.json 让 Node 侧工具（自检脚本）也按 ESM 解析，
# 浏览器不受影响。
printf '{\n  "type": "module"\n}\n' > public/libs/package.json

echo
ls -l public/libs/
echo
echo "完成。校验："
grep -o 'REVISION="[0-9]*"' public/libs/three.min.js | head -1 || true
grep -c 'process\.env' public/libs/cannon-es.js | sed 's/^/cannon-es 中对 process.env 的引用次数: /'
