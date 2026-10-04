import { describe, expect, it } from 'vitest'
import { flingBounds } from '../src/client/PhysicsFling'

describe('甩抛边界（松手惯性滑行的活动范围）', () => {
  it('用传入的 padding（贴边保底留白），不再写死 8px', () => {
    const b = flingBounds(110.5, 117, 18, 360, 800)
    expect(b).toEqual({ left: 18, top: 18, right: 360 - 110.5 - 18, bottom: 800 - 117 - 18 })
  })

  it('padding 非法或 0 时回退 8（旧行为）', () => {
    expect(flingBounds(100, 100, 0, 400, 800).left).toBe(8)
    expect(flingBounds(100, 100, Number.NaN, 400, 800).left).toBe(8)
    expect(flingBounds(100, 100, -5, 400, 800).left).toBe(8)
  })

  it('视口比挂件还小时区间不会反号（避免角色被推到屏幕外）', () => {
    const b = flingBounds(400, 400, 20, 360, 360)
    expect(b.right).toBeGreaterThanOrEqual(b.left)
    expect(b.bottom).toBeGreaterThanOrEqual(b.top)
  })
})
