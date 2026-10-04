import { describe, expect, it } from 'vitest'
import { WIDGET_CSS } from '../src/client/styles'

/**
 * 定位坐标空间的回归护栏（0.4.8）
 *
 * JS 里 pos/posRef 是 `translate3d(x,y,0) scale(s)` 的 translate 值，而所有边界夹取、
 * 吸附停靠、物理碰撞都把它当「缩放后视觉盒的左上角」用。只要 CSS 的 transform-origin
 * 不是 0 0（默认 center），视觉盒就会偏移 ((1-s)·W/2, (1-s)·H/2)，于是：
 *   ① 松手时把 getBoundingClientRect() 回写 pos → 每次往右下推 29.75px（累积成「松开就往右下角掉」）
 *   ② 夹到右边时视觉多出 29.75px → 看着像被屏幕边切掉一截
 * 这两条一旦回归，本文件立刻红灯。
 */
describe('定位坐标空间：transform 原点必须是左上角', () => {
  it('.wg-root 带 transform-origin: 0 0', () => {
    expect(/\.wg-root\s*\{[^}]*transform-origin:\s*0\s+0\s*;/s.test(WIDGET_CSS)).toBe(true)
  })

  it('.wg-info 带 transform-origin: 0 0', () => {
    expect(/\.wg-info\s*\{[^}]*transform-origin:\s*0\s+0\s*;/s.test(WIDGET_CSS)).toBe(true)
  })

  it('量化：center 原点在 scale=0.65 / 170px 盒子上的偏移正是 +29.75px（本次真机症状的量）', () => {
    expect((170 * (1 - 0.65)) / 2).toBeCloseTo(29.75, 6)
    // 面板 infoScale=0.75 → +16.5px
    expect((132 * (1 - 0.75)) / 2).toBeCloseTo(16.5, 6)
  })
})
