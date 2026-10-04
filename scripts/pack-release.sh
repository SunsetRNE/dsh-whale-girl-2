#!/usr/bin/env bash
# 打包 dsh-whale-girl 当前可用版本到工作区，自带三项判据。
# 用法: bash scripts/pack-release.sh [源码目录] [输出目录]
set -euo pipefail

SRC="${1:-/root/S/dsh-whale-girl-local}"
OUT="${2:-$SRC}"
VER="$(node -p "require('$SRC/package.json').version")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="dsh-whale-girl-$VER-$STAMP"
MF="$SRC/MANIFEST-dsh-whale-girl-$VER.txt"

# 1) 清单：先剔除所有归档文件，避免自引用（清单/包的哈希互相包含是无解循环）
{
  echo "dsh-whale-girl 打包清单"
  echo "版本: $VER"
  echo "打包时刻(UTC): $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "构建时刻(UTC): $(stat -c %y "$SRC/lib/index.js" | cut -d. -f1)"
  echo "运行实例: dsh $(dsh --version 2>/dev/null || echo '?') / node $(node -v)"
  echo "排除: node_modules/, *.tgz, *.swp"
  echo "RELEASE_STAMP: $STAMP"
  echo
  echo "=== 逐文件: 大小 sha256 路径 ==="
} > "$MF"
cd "$SRC"
find . -path ./node_modules -prune -o -type f \
     ! -name '*.tar.gz' ! -name '*.tgz' ! -name '*.swp' -print0 \
  | sort -z | while IFS= read -r -d '' f; do
      printf '%s  %s  %s\n' "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
    done >> "$MF"
printf '打包产物自身 sha256 见旁挂文件: %s.tar.gz.sha256\n' "$NAME" >> "$MF"

# 2) 打包：输出到 /tmp 再搬入，避免 tar 把自己写进包里
rm -f "$OUT/$NAME.tar.gz"
tar --exclude="$(basename "$SRC")/node_modules" --exclude='*.tgz' --exclude='*.swp' \
    -czf "/tmp/$NAME.tar.gz" -C "$(dirname "$SRC")" "$(basename "$SRC")"
cp "/tmp/$NAME.tar.gz" "$OUT/$NAME.tar.gz"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

# 3) 判据：完整性 / 逐文件一致 / 可装载
R="$(mktemp -d)"; trap 'rm -rf "$R"' EXIT
tar -xzf "$OUT/$NAME.tar.gz" -C "$R"
S="$R/$(basename "$SRC")"
gzip -t "$OUT/$NAME.tar.gz" && echo "JUDGE-1 完整性 gzip -t: OK"
python3 - "$S" "$SRC" <<'PY'
import hashlib,os,re,sys
src,ws=sys.argv[1],sys.argv[2]
mf=os.path.join(src,[x for x in os.listdir(src) if x.startswith("MANIFEST-")][0])
rows=[m.groups() for m in (re.match(r'^(\d+)\s+([0-9a-f]{64})\s+(\./.+)$',l)
      for l in open(mf,encoding='utf-8')) if m and 'MANIFEST' not in m.group(3)]
ok=bad=0
for size,h,p in rows:
    a=hashlib.sha256(open(os.path.join(src,p[2:]),'rb').read()).hexdigest()
    w=hashlib.sha256(open(os.path.join(ws,p[2:]),'rb').read()).hexdigest()
    if a==h==w: ok+=1
    else: bad+=1; print("MISMATCH",p)
print(f"JUDGE-2 逐文件 sha256（清单=包内=工作区）: OK={ok} BAD={bad}")
PY
node --check "$S/lib/index.js"
node --check "$S/lib/client.js"
node -p "'JUDGE-3 可装载: version='+require('$S/package.json').version+' main='+require('$S/package.json').main"
echo "产物: $OUT/$NAME.tar.gz  ($(stat -c %s "$OUT/$NAME.tar.gz") B)"
