#!/usr/bin/env bash
# 回滚：从 _backup 里最近一次安装前快照恢复 profile，并卸掉 link。
set -euo pipefail
SRC="${SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROF="${PROF:-/root/.dsh/profiles/web}"
BK="$(ls -1t "$SRC/_backup"/package.json.* 2>/dev/null | head -1 || true)"
[ -n "$BK" ] || { echo "FAIL _backup 里没有 package.json 快照"; exit 1; }
STAMP="${BK##*.}"
cp -a "$BK" "$PROF/package.json"
[ -f "$SRC/_backup/pnpm-lock.yaml.$STAMP" ] && cp -a "$SRC/_backup/pnpm-lock.yaml.$STAMP" "$PROF/pnpm-lock.yaml"
echo "RESTORED  profile/package.json <- $BK"
node -e '
const p=require(process.argv[1]+"/package.json");
const dep=Object.keys(p.dependencies||{}).includes("dsh-whale-girl-2");
const bun=(p.dsh?.profile?.bundles||[]).includes("dsh-whale-girl-2");
if(dep||bun){console.error("FAIL 回滚后仍在注册表里");process.exit(1)}
console.log("OK        已从 dependencies 与 dsh.profile.bundles 中移除");
' "$PROF"
cd "$PROF" && pnpm install --ignore-scripts 2>&1 | tail -5
echo "DONE 重启 DSH 后挂件消失。"
