#!/usr/bin/env node
// 把 dsh-whale-girl-2 改造成可在本机 DSH 0.1.7-rc.2 / DSHA 容器下本地 link 安装的形态。
// 只动副本；原文件哈希见 ../ORIGINAL.sha256
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changed = []

// 1) dsh.client.inject：去掉本机不存在的 @deepseek-ai/dsh-client-runtime
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const before = [...(pkg.dsh?.client?.inject ?? [])]
const keep = before.filter((n) => n !== '@deepseek-ai/dsh-client-runtime')
if (keep.length !== before.length) {
  pkg.dsh.client.inject = keep
  changed.push(`package.json: dsh.client.inject ${JSON.stringify(before)} -> ${JSON.stringify(keep)}`)
}
// 2) exports.types 指向的 lib/types 在发布包里缺失，补一个最小声明（不改 exports）
const typesDir = join(root, 'lib', 'types')
if (!existsSync(join(typesDir, 'index.d.ts'))) {
  mkdirSync(typesDir, { recursive: true })
  writeFileSync(
    join(typesDir, 'index.d.ts'),
    '// 本地占位：发布包未带 lib/types，仅用于让 exports["."].types 可解析。\n' +
      'declare const plugin: unknown\nexport default plugin\n'
  )
  changed.push('lib/types/index.d.ts: 新建最小声明（原包缺失，仅影响 TS 类型解析）')
}
if (changed.length) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// 3) pnpm-workspace.yaml 里的 allowBuilds 不是合法 pnpm 键，值还是占位文本
const wsPath = join(root, 'pnpm-workspace.yaml')
const ws = readFileSync(wsPath, 'utf8')
if (ws.includes('allowBuilds')) {
  writeFileSync(wsPath, 'packages:\n  - .\n\nonlyBuiltDependencies:\n  - esbuild\n')
  changed.push('pnpm-workspace.yaml: allowBuilds 占位文本 -> onlyBuiltDependencies: [esbuild]')
}

console.log(changed.length ? changed.map((c) => 'MODIFIED  ' + c).join('\n') : 'NOCHANGE  副本已是改造后形态')
process.exit(0)
