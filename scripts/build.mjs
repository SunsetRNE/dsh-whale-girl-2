import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

fs.rmSync('lib', { recursive: true, force: true })
execSync('npx tsdown', { stdio: 'inherit', shell: process.platform === 'win32' })

// 声明产物归位。
// tsdown.config.ts 的 host 构建同时开着 dts:true 与 outputOptions.entryFileNames:'index.js'，
// 实测声明产物落到 lib/index.ts（不是 lib/index.d.ts），而 package.json 的
// exports["."].types 指向 ./lib/types/index.d.ts —— 三处路径互不相符，TS 消费方解析不到类型。
// 这里做一次确定性归位，不去赌 tsdown 的 dts 选项名：
const DECL_CANDIDATES = ['lib/index.d.ts', 'lib/index.ts']
const decl = DECL_CANDIDATES.find((f) => fs.existsSync(f))
if (!decl) {
  console.error('[build] 警告：没找到声明产物，lib/types/index.d.ts 会缺失（exports.types 将指向空文件）')
  process.exitCode = 1
} else {
  fs.mkdirSync(path.join('lib', 'types'), { recursive: true })
  fs.copyFileSync(decl, path.join('lib', 'types', 'index.d.ts'))
  console.log(`[build] 声明产物归位：${decl} → lib/types/index.d.ts`)
}
