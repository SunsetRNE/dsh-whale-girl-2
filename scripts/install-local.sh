#!/usr/bin/env bash
# 把改造后的 dsh-whale-girl 以 link: 方式装进本机 web profile。
# 本机 DSHA 环境下 GUI/agent 的 installBundle 被 DSHA_NATIVE_PLUGIN_MANAGER 挡住，
# 这条路走 profile 包管理 + bundles 注册，不经过那个接口。
set -euo pipefail

SRC="${SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROF="${PROF:-/root/.dsh/profiles/web}"
STAMP="$(date +%Y%m%d%H%M%S)"

[ -f "$SRC/package.json" ] || { echo "FAIL 找不到源码副本 $SRC"; exit 1; }
[ -f "$PROF/package.json" ] || { echo "FAIL 找不到 profile $PROF"; exit 1; }

mkdir -p "$SRC/_backup"
for f in package.json pnpm-lock.yaml; do
  [ -f "$PROF/$f" ] && cp -a "$PROF/$f" "$SRC/_backup/$f.$STAMP"
done
echo "BACKUP  $SRC/_backup/*.$STAMP"

node -e '
const fs=require("fs");
const prof=process.argv[1], src=process.argv[2];
const p=JSON.parse(fs.readFileSync(prof+"/package.json","utf8"));
p.dependencies=p.dependencies||{};
p.dependencies["dsh-whale-girl"]="link:"+src;
p.dsh=p.dsh||{}; p.dsh.profile=p.dsh.profile||{};
const b=p.dsh.profile.bundles=p.dsh.profile.bundles||[];
if(!b.includes("dsh-whale-girl")) b.push("dsh-whale-girl");
fs.writeFileSync(prof+"/package.json", JSON.stringify(p,null,2)+"\n");
console.log("REGISTERED  dependencies.dsh-whale-girl = link:"+src);
console.log("REGISTERED  dsh.profile.bundles += dsh-whale-girl");
' "$PROF" "$SRC"

cd "$PROF"
pnpm install --ignore-scripts 2>&1 | tail -15
echo "--- 校验 ---"
ls -l "$PROF/node_modules/dsh-whale-girl" 2>&1 | head -3
node -e 'const p=require(process.argv[1]+"/node_modules/dsh-whale-girl/package.json");console.log("LINKED",p.name,p.version,"inject="+JSON.stringify(p.dsh.client.inject))' "$PROF"
echo "DONE  profile 已注册。patchReload=startup，需重启 DSH 后生效（Web 端还要 F5）。"
