#!/usr/bin/env bash
# 容器重启会清空 /etc/hosts（proot bind 挂载，非持久），vitest/vite 随即报
#   Error: getaddrinfo ENOTFOUND localhost
# 进而整个测试链起不来 —— 与插件本身无关，是宿主环境重置。
# 本脚本幂等补齐映射，可放进任何 CI / 手动流程的开头。
set -uo pipefail

miss=0
grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+localhost' /etc/hosts 2>/dev/null || miss=1
grep -qE '^[[:space:]]*::1[[:space:]]+localhost'        /etc/hosts 2>/dev/null || miss=1

if [ "$miss" -eq 0 ]; then
  echo "OK     localhost 映射已在，无需修改"
  exit 0
fi

if printf '127.0.0.1 localhost\n::1 localhost\n' >> /etc/hosts 2>/dev/null; then
  echo "FIXED  已补写 /etc/hosts（127.0.0.1 localhost / ::1 localhost）"
else
  echo "FAIL   /etc/hosts 不可写：需在可写 rootfs 的容器内执行"
  exit 1
fi

node -e "
(async () => {
  const dns = require('node:dns').promises
  try { const a = await dns.lookup('localhost'); console.log('OK     localhost 可解析 ->', a.address) }
  catch (e) { console.log('FAIL   localhost 仍不可解析：' + e.code); process.exit(1) }
})()
"
