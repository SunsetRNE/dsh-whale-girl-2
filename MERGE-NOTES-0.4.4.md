# 合并说明：upstream v0.4.4 → 本地二改

分支 `merge-0.4.4`，基线 `main@ce2765d`。合并方式：`git apply --3way upstream-v0.4.2-to-v0.4.4.patch`。

## 一、冲突面（实测）

| 文件 | 冲突块 | 处置 |
|---|---|---|
| `src/client/WhaleWidget.tsx` | 1 | 保本地，补注释记录上游意图 |
| `src/client/index.tsx` | 2 | **重新合成**（两边都要） |
| `lib/client.js`、`lib/client.js.map`、`lib/index.js.map` | 3 | 弃用冲突、`git checkout HEAD --` 回退，合并后重跑 `node scripts/build.mjs` 覆盖 |
| 其余（`src/index.ts`、`styles.ts`、`WidgetMenu.tsx`、`package.json`、`assets/*`） | 0 | 干净应用 |

产物文件永远不手解 —— 本仓构建已实测可复现（同源码 → 同字节），重建即得。

## 二、取上游（0.4.3 + 0.4.4）

- `safeRegister()` 及 9 处调用：官方 loader 双路径 apply 时的重复路由兜底（本机 profile 正是 bundles + 自带 patch 形态）
- `deepSleep` 配置项与挺尸态、拖尾、表情帧（痛颜 / 闭眼 / 惊醒泡泡）
- 新资源：`src/client/whalePoseDataUrls.ts`、`assets/poses/{whale-base,whale-pain,whale-sleep}.png`
- `package.json` 版本 `0.4.4`、`README.md`、`CHANGELOG.md`、`docs/promo/*`

## 三、保本地（工程加固，与上游无功能重叠）

- `WhaleWidget.tsx`：热路径直写 `transform`（拖动 / 甩抛 / 弹跳 / 绳摆 / 重力滑行不进 React）、状态帧逐字段合并
- `WhaleWidget.tsx` `onPointerMove`：**不**调 `markActive()`。上游 0.4.3 写成 `if (dragRef.current) markActive()`，拖拽中仍是每帧重建 60 秒定时器 —— 正是本地要消掉的开销；唤醒只认 `pointerdown`，悬停与划过一律不算，上游「哄睡后不被打扰」的诉求已被覆盖
- `src/index.ts`：diag 死代码修复、凭据候选引用名回退、`WHALE_GIRL_DEBUG` 开关
- `services/providers.ts`：`select-model` 入口白名单 + 原子写 + `.bak`
- `services/balance.ts` 时区统一 `+8`；`services/turnCost.ts` 真正使用 `outputTokens`
- `scripts/*`：`SRC` 自解析、`fix-hosts.sh`、`build.mjs` 声明产物归位

## 四、新合成的部分

`src/client/index.tsx` 的 `apply()` 两条路线合并为一条链：

1. 重入守卫 `__wgMounted`（本地）
2. `mountToBody()` 内加 DOM 存在即复用（上游 0.4.4 双激活防护）
3. 轮询等待 `slots`，250ms × 40 = 10 秒（本地）
4. `slots` 就绪 → `slots.inject` + `slots.register` 走 `shell.overlay` portal（原路径）
5. `slots` 等不到 **或** 对象在但缺 `inject/register` → `mountDirect()` 用 `createRoot` 直接挂 body 顶层（上游无 slots 环境的路线），不再静默 return

## 五、验证

```bash
node scripts/build.mjs        # Build complete ×2 + 声明产物归位
npx vitest run                # 4 文件 21 用例全过
bash scripts/verify-local.sh  # 8/8，VERDICT 包形态就绪
```

## 六、回滚

```bash
git switch main               # 放弃整个合并，回到 0.4.2 + 二改基线
# 或单文件回退：
git checkout main -- src/client/WhaleWidget.tsx
```

未做：装机与重启实测。当前运行的仍是 `main` 分支的 0.4.2 产物（profile 是软链，切分支即换产物，重启后才生效）。
