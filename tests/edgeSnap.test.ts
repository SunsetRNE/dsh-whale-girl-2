import { describe, expect, it } from 'vitest'
import {
  alignEdge,
  alignSize,
  clampPos,
  formatInset,
  guardBounds,
  measureInset,
  renderScale,
  safeDpr,
  stepPx,
  stopPos
} from '../src/client/edgeSnap'

const W = 170
const H = 180
const SC = 0.65

/** 浮点安全判断：v 是否落在物理像素格上（v*dpr 为整数） */
const isGrid = (v: number, dpr: number): boolean => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6

describe('贴边停靠的物理像素对齐', () => {
  const cases = [
    { name: '1080 宽 / dpr2.625', vw: 1080 / 2.625, dpr: 2.625, phys: 16 },
    { name: '1080 宽 / dpr3', vw: 1080 / 3, dpr: 3, phys: 18 },
    { name: '桌面 1280 / dpr1', vw: 1280, dpr: 1, phys: 6 }
  ]

  for (const c of cases) {
    it(`${c.name}：右侧停靠边压在整物理格，生效留白 ${c.phys} 物理px`, () => {
      const s = stopPos({
        vw: c.vw, vh: 800, baseW: W, baseH: H, scale: SC, ins: 6, side: 'right', dpr: c.dpr
      })
      expect(isGrid(s.x + s.w, c.dpr)).toBe(true)
      expect(isGrid(s.w, c.dpr)).toBe(true)
      expect(isGrid(s.y, c.dpr)).toBe(true)
      expect(s.physInset).toBe(c.phys)
    })

    it(`${c.name}：左侧停靠同样上格`, () => {
      const s = stopPos({
        vw: c.vw, vh: 800, baseW: W, baseH: H, scale: SC, ins: 6, side: 'left', dpr: c.dpr
      })
      expect(isGrid(s.x, c.dpr)).toBe(true)
      expect(s.physInset).toBe(c.phys)
    })
  }

  it('反例：只量化 x 会把本来已对齐的 dpr=3 机型推到半格（1062.5）', () => {
    const dpr = 3
    const vw = 1080 / 3
    const w = W * SC
    const rawEdge = (vw - w - 6 + w) * dpr
    expect(rawEdge).toBe(1062) // 原始就已经是整格
    const naiveEdge = (alignEdge(vw - w - 6, dpr) + w) * dpr
    expect(Number.isInteger(naiveEdge)).toBe(false) // 只量化 x → 1062.5，越改越糊
  })

  it('缩放上格后宽度是整物理像素倍，且缩放偏差 ≤0.5 物理像素', () => {
    for (const dpr of [1, 2.625, 3]) {
      const q = renderScale(W, SC, dpr)
      expect(isGrid(W * q, dpr)).toBe(true)
      expect(Math.abs(W * q * dpr - W * SC * dpr)).toBeLessThanOrEqual(0.5)
    }
  })

  it('拖拽反推：把落点换算回留白，且吸到整物理像素', () => {
    const dpr = 2.625
    const vw = 1080 / dpr
    const s = stopPos({ vw, vh: 800, baseW: W, baseH: H, scale: SC, ins: 6, side: 'right', dpr })
    const back = measureInset(s.x, s.w, vw, dpr)
    // 反推回来的是「上格后的留白」：6 dp 吸到整格 = 16 物理px = 6.095… dp
    expect(Math.round(back * dpr)).toBe(16)
    expect(Math.abs(back - 6)).toBeLessThanOrEqual(1 / dpr)
    expect(isGrid(back, dpr)).toBe(true)
  })

  it('单位读数与步进', () => {
    expect(formatInset(6, 2.625)).toBe('6 dp = 16 物理px（1dp=2.625px）')
    expect(stepPx(2.625)).toBeCloseTo(0.380952, 5)
    expect(safeDpr(0)).toBe(1)
    expect(safeDpr(Number.NaN)).toBe(1)
    expect(alignSize(110.5, 3)).toBeCloseTo(332 / 3, 6)
  })

  it('越界夹取用 edgeGuard 保底留白（关掉吸附后不再顶死）', () => {
    const dpr = 3
    const vw = 360
    const vh = 800
    const g0 = guardBounds(vw, vh, W, H, SC, 0, dpr)
    const g6 = guardBounds(vw, vh, W, H, SC, 6, dpr)
    // guard=0 → 旧行为：允许完全贴边
    expect(clampPos(-50, g0.xLo, g0.xHi, dpr)).toBe(0)
    // guard=6dp（dpr=3）→ 拖到最左也停在 18 物理px
    expect(Math.round(clampPos(-50, g6.xLo, g6.xHi, dpr) * dpr)).toBe(18)
    // 右侧同理，且右边整格
    const right = clampPos(9999, g6.xLo, g6.xHi, dpr)
    expect(isGrid(right + g6.w, dpr)).toBe(true)
    expect(Math.round((vw - (right + g6.w)) * dpr)).toBe(18)
  })
})
