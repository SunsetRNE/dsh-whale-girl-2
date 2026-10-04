# dsh-whale-girl 0.4.2 打包说明（2026-10-04 03:33Z）

## 产物（工作区 `/root/S/dsh-whale-girl-local/`）

| 文件 | 说明 |
|---|---|
| `dsh-whale-girl-0.4.2-*.tar.gz` | 完整包，60 文件，655712 B，根目录 `dsh-whale-girl-local/` |
| `dsh-whale-girl-0.4.2-*.tar.gz.sha256` | 旁挂校验（`sha256sum -c` 直接可用） |
| `MANIFEST-dsh-whale-girl-0.4.2.txt` | 逐文件 sha256（含在包内，可离线核对） |
| `scripts/pack-release.sh` | 打包脚本，自带三项判据，可重复执行 |

## 打包范围

包含：`src/` 15、`lib/`（构建产物 + types）7、`tests/` 4、`scripts/` 6、`assets/` 3、
`docs/` 2、`_backup/` 1、根配置与文档 22。
排除：`node_modules/`（1468 文件，用包内 `package-lock.json` / `pnpm-lock.yaml` 还原）、
`*.tgz`、`*.swp`、归档自身。

包内不含密钥、令牌或凭据文件：值级扫描（`sk-*` / `ghp_*` / `Bearer` / PEM 头）0 命中；
仅有的匹配是环境变量**名** `DSHA_DEEPSEEK_OFFICIAL_API_KEY` 与 PNG/wav 的 base64 内联资源。

## 三项判据（`bash scripts/pack-release.sh` 末尾自动打印）

```
JUDGE-1 完整性 gzip -t: OK
JUDGE-2 逐文件 sha256（清单=包内=工作区）: OK=59 BAD=0
JUDGE-3 可装载: version=0.4.2 main=./lib/index.js
```

## 还原与安装

```bash
tar -xzf dsh-whale-girl-0.4.2-20261004T033308Z.tar.gz -C /root/S
cd /root/S/dsh-whale-girl-local && npm ci && node scripts/build.mjs
```

装机走 profile 软链（本机既有形态，非拷贝安装）：

```bash
ln -sfn /root/S/dsh-whale-girl-local /root/.dsh/profiles/web/node_modules/dsh-whale-girl
bash scripts/install-local.sh          # 可选的自动注册（会先备份 profile 清单）
```

`profiles/web/package.json` 的 `dsh.profile.bundles` 已含 `dsh-whale-girl`；
`patchReload: "startup"` —— 改动随 `dsh web` 重启生效。

## 与运行实例的关系

打包源就是正在跑的那份：构建 2026-10-04 02:57:10 UTC，进程启动 03:11:37 UTC，产物早于启动。
包内 `lib/index.js` sha256 `dc11b34d…4fdbd`、`lib/client.js` sha256 `f116ad23…7588e3`，
与运行实例加载的文件一致。
