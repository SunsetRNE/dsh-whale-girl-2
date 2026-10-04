import React from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WhaleWidget } from './WhaleWidget'
import { SettingsPage } from './SettingsPage'

export const name = 'dsh-whale-girl-2'

/**
 * Cordis 服务依赖：`slots` 由 @deepseek-ai/dsh-client-ui-renderer 提供
 * （dsh-client-ui-renderer/lib/client.js:1323 `super(ctx, "slots")`）。
 *
 * 旧版没有这行，只有 `const slots = ctx.get('slots'); if (slots === undefined) return` ——
 * 服务还没就绪就静默返回：挂件消失、控制台无提示、宿主日志无痕迹。
 * 热加载进一个已经跑起来的页面时服务早就有了，所以看不出问题；
 * 一旦进程重启、模块按 boot 图顺序冷启动，就稳定复现「重启后挂件不见了」。
 */
export const inject = ['slots']

/** 客户端侧诊断：全局留痕 + 控制台，避免再次"无声消失"。 */
function cdiag(step: string): void {
  const w = window as unknown as { __wgClientDiag?: string[] }
  w.__wgClientDiag = w.__wgClientDiag ?? []
  w.__wgClientDiag.push(`${new Date().toISOString()} ${step}`)
  console.info(`[dsh-whale-girl-2] ${step}`)
}

export function apply(ctx: any) {
  const w = window as unknown as {
    __wgMounted?: boolean
    __wgClientDiag?: string[]
  }
  // 重入守卫（本地）：HMR / 重复 apply 时不要在 body 上叠第二个挂载点。
  if (w.__wgMounted) {
    cdiag('skip: already mounted in this page')
    return
  }

  // 挂载到 shell.overlay 会被 better-sidebar 等固定定位容器遮挡（层叠上下文问题）。
  // 改用 React portal / React root 直接渲染到 document.body 顶层，确保挂件永远在所有 UI 之上。
  const mountToBody = (): HTMLElement => {
    // 上游 0.4.4 的双激活防护：官方 loader 走 bundles + 插件自带 patch 两条路径时
    // apply 会被跑两次，mount 点已存在即复用，不再新建第二个。
    const existed = document.getElementById('dsh-whale-girl-2-mount')
    if (existed) return existed
    const host = document.createElement('div')
    host.id = 'dsh-whale-girl-2-mount'
    // 独立层叠上下文 + 最高层级，防被其他插件覆盖。
    // 不设 pointer-events，让挂件（拖动/点击/右键菜单）正常交互。
    host.style.position = 'fixed'
    host.style.zIndex = '2147483647'
    host.style.top = '0'
    host.style.left = '0'
    host.style.width = '0'
    host.style.height = '0'
    // 冷启动时客户端模块可能在 <body> 建出来之前就跑（脚本在 <head>），
    // 旧版直接 document.body.appendChild 会抛 TypeError，让整块客户端失效。
    const parent = document.body ?? document.documentElement
    parent.appendChild(host)
    return host
  }

  // 第三层保险（本地）：`inject = ['slots']` 等的是 Cordis 服务就绪；这里的轮询兜住
  // 「服务迟早会来、但目前还没到」的窗口。旧版在这个窗口里直接 return，于是
  // 冷启动 = 静默消失，热加载 = 因为服务早就有所以看不出问题。
  let tries = 0
  const MAX_TRIES = 40 // 250ms × 40 = 10 秒
  const RETRY_MS = 250

  // 直接 React root 挂 body 顶层：官方 Desktop 无 slots 服务时的路径（上游 0.4.4），
  // 也是本机等不到 slots 时的兜底 —— 两条路都不能静默。
  const mountDirect = (reason: string): void => {
    cdiag(reason)
    const host = mountToBody()
    w.__wgMounted = true
    createRoot(host).render(<WhaleWidget />)
  }

  const attempt = (): void => {
    const slots = ctx?.get?.('slots') ?? ctx?.slots
    if (slots === undefined) {
      tries += 1
      if (tries === 1 || tries % 8 === 0) cdiag(`waiting slots… (${tries}/${MAX_TRIES})`)
      if (tries >= MAX_TRIES) {
        mountDirect('slots unavailable after 10s → fallback: direct React root on body')
        return
      }
      window.setTimeout(attempt, RETRY_MS)
      return
    }
    const host = mountToBody()
    w.__wgMounted = true
    cdiag(`mount ok (parent=${document.body ? 'body' : 'documentElement'})`)
    if (typeof slots.inject === 'function' && typeof slots.register === 'function') {
      slots.inject('shell.overlay', () =>
        slots.register(
          { name: 'shell.overlay', id: 'whale-girl-widget', order: 70, label: '鲸鱼娘' },
          () => createPortal(<WhaleWidget />, host)
        )
      )
      cdiag('registered into shell.overlay as whale-girl-widget')
      // 设置页：注册进 settings.section —— 该 slot 由 @deepseek-ai/dsh-client-ui-settings 声明，
      // 由 ui-settings-general 渲染设置外壳与左侧导航。id 唯一即可，order 决定导航排序。
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'whale-girl', order: 90, label: () => '鲸鱼娘' },
          SettingsPage
        )
      )
      cdiag('registered settings.section as whale-girl')
      return
    }
    // slots 对象在、但不含 inject/register（宿主版本漂移）→ 同样退回直挂，不静默。
    mountDirect('slots present but lacks inject/register → fallback: direct React root on body')
  }

  attempt()
}
