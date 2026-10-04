import React from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WhaleWidget } from './WhaleWidget'

export const name = 'dsh-whale-girl'

export function apply(ctx: any) {
  // 10/4 官方 Desktop 兼容：官方 web-app 没有 slots 服务（ctx.get('slots') === undefined），
  // 旧实现第一行就静默 return → 挂件无声消失。现在双路：
  //   有 slots（第三方宿主）→ 走 shell.overlay slot + portal（原有路径不变）
  //   无 slots（官方端）  → 直接 React root 挂到 body 顶层
  // 双激活防护：官方 loader 可能双路径 apply，mount 点已存在即跳过。
  if (document.getElementById('dsh-whale-girl-mount')) return

  // 挂载到 shell.overlay 会被 better-sidebar 等固定定位容器遮挡（层叠上下文问题）。
  // 改用 React portal 直接渲染到 document.body 顶层，确保挂件永远在所有 UI 之上。
  const host = document.createElement('div')
  host.id = 'dsh-whale-girl-mount'
  // 独立层叠上下文 + 最高层级，防被其他插件覆盖。
  // 不设 pointer-events，让挂件（拖动/点击/右键菜单）正常交互。
  host.style.position = 'fixed'
  host.style.zIndex = '2147483647'
  host.style.top = '0'
  host.style.left = '0'
  host.style.width = '0'
  host.style.height = '0'
  document.body.appendChild(host)

  const slots = ctx?.get?.('slots')
  if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    slots.inject('shell.overlay', () =>
      slots.register(
        { name: 'shell.overlay', id: 'whale-girl-widget', order: 70, label: '鲸鱼娘' },
        () => createPortal(<WhaleWidget />, host)
      )
    )
    return
  }

  createRoot(host).render(<WhaleWidget />)
}
