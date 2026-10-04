#!/usr/bin/env bash
# 判据：不碰 profile，只验「包形态可被 DSH 装载」的四条硬条件。
set -uo pipefail
SRC="${SRC:-/root/S/dsh-whale-girl-local}"
fail=0
chk() { printf '%-6s %s\n' "$1" "$2"; [ "$1" = OK ] || fail=1; }

[ -f "$SRC/lib/index.js" ] && chk OK "host 入口 lib/index.js 存在" || chk FAIL "缺 lib/index.js"
[ -f "$SRC/lib/client.js" ] && chk OK "client 入口 lib/client.js 存在" || chk FAIL "缺 lib/client.js"
[ -f "$SRC/cordis.patch.yml" ] && chk OK "bundle patch cordis.patch.yml 存在" || chk FAIL "缺 cordis.patch.yml"

node --check "$SRC/lib/index.js" 2>&1 | head -3 && chk OK "lib/index.js 语法通过" || chk FAIL "lib/index.js 语法错"
node --check "$SRC/lib/client.js" 2>&1 | head -3 && chk OK "lib/client.js 语法通过" || chk FAIL "lib/client.js 语法错"

SRC="$SRC" node -e '
const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.env.SRC+"/package.json","utf8"));
const bad=(p.dsh?.client?.inject||[]).filter(n=>n==="@deepseek-ai/dsh-client-runtime");
console.log((bad.length?"FAIL  ":"OK    ")+"dsh.client.inject = "+JSON.stringify(p.dsh.client.inject));
const need=["react","react-dom","react/jsx-runtime"];
const txt=fs.readFileSync(process.env.SRC+"/lib/client.js","utf8");
const miss=need.filter(n=>!txt.includes("require(\""+n+"\")"));
console.log((miss.length?"WARN  ":"OK    ")+"client 实际 require："+need.join(", ")+(miss.length?"  未出现: "+miss.join(","):""));
const patch=fs.readFileSync(process.env.SRC+"/cordis.patch.yml","utf8");
console.log((/id:\s*whale-girl/.test(patch)?"OK    ":"FAIL  ")+"patch 行 id: whale-girl");
process.exit(bad.length?1:0)
'
rc=$?

echo "--- 摘要 ---"
if [ $fail -eq 0 ] && [ $rc -eq 0 ]; then echo "VERDICT 包形态就绪，可装（装载期行为仍需重启后实测）"; else echo "VERDICT 有项未过，见上面 FAIL 行"; fi
exit $(( fail + rc ))
