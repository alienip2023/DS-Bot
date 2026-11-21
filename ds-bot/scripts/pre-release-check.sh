#!/usr/bin/env bash
# ds-bot 发布前自检脚本（防止 D1-D4 回退再次发生）
# 用法: bash scripts/pre-release-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== D1: joinedTurn 在 index.js ==="
grep -q "host/joined-turn.js" index.js || { echo "FAIL: joinedTurn 未接线"; exit 1; }
echo "PASS"

echo "=== D1: MODULES 数量 >= 69 ==="
MODULES_COUNT=$(node -e 'const s=require("fs").readFileSync("index.js","utf8");const n=s.match(/const MODULES\s*=\s*\[([\s\S]*?)\]/)[1].split(",").filter(Boolean).length;console.log(n)')
echo "MODULES = $MODULES_COUNT"
[ "$MODULES_COUNT" -ge 69 ] || { echo "FAIL: MODULES 只有 $MODULES_COUNT"; exit 1; }
echo "PASS"

echo "=== D2: store.js 接受 version 2 ==="
grep -q "STATE_VERSION" src/host/store.js || { echo "FAIL: store.js 读不了新版 state"; exit 1; }
echo "PASS"

echo "=== D3: tarball 含 src/gateway/ ==="
GATEWAY_COUNT=$(npm pack --dry-run 2>&1 | grep -c "src/gateway/")
echo "gateway 文件数 = $GATEWAY_COUNT"
[ "$GATEWAY_COUNT" -ge 7 ] || { echo "FAIL: tarball 缺 src/gateway/"; exit 1; }
echo "PASS"

echo "=== D4: fitSnapshot 导出 ==="
grep -q "export function fitSnapshot" src/host/memory-entries.js || { echo "FAIL: fitSnapshot 缺失"; exit 1; }
echo "PASS"

echo ""
echo "ALL CHECKS PASS ✓"
