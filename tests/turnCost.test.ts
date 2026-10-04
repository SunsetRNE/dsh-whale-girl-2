import { describe, it, expect } from 'vitest'
import { estimateCost, estimateCostUnsplit, DEEPSEEK_PRICE } from '../src/services/turnCost'

describe('estimateCost', () => {
  it('computes cost from token split', () => {
    const cost = estimateCost(1000, { input: 0.5, output: 2, inputTokens: 600, outputTokens: 400 })
    // 600 * 0.5 / 1e6 + 400 * 2 / 1e6 = 0.0003 + 0.0008 = 0.0011
    expect(cost).toBeCloseTo(0.0011, 6)
  })
  it('returns 0 for zero tokens', () => {
    expect(estimateCost(0, { input: 0.5, output: 2, inputTokens: 0, outputTokens: 0 })).toBe(0)
  })
  it('handles all-input tokens', () => {
    expect(estimateCost(500, { input: 1, output: 2, inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.0005, 6)
  })
  it('honours an explicit outputTokens instead of deriving it', () => {
    // inT=600, outT=min(400, 1000-600)=400 → 600*0.5/1e6 + 400*2/1e6 = 0.0011
    expect(estimateCost(1000, { input: 0.5, output: 2, inputTokens: 600, outputTokens: 400 })).toBeCloseTo(0.0011, 6)
  })
  it('clamps outputTokens so it can never exceed the remaining total', () => {
    // outT = min(9999, 1000-600) = 400 → 与上例同值，不会把成本算成天价
    expect(estimateCost(1000, { input: 0.5, output: 2, inputTokens: 600, outputTokens: 9999 })).toBeCloseTo(0.0011, 6)
  })
})

// 回归：旧调用点传的是 { inputTokens: total, outputTokens: 0 }，output 单价永不生效。
describe('estimateCostUnsplit', () => {
  it('prices the whole total at the input rate', () => {
    expect(estimateCostUnsplit(1_000_000, DEEPSEEK_PRICE)).toBeCloseTo(0.5, 6)
  })
  it('returns 0 for zero or negative tokens', () => {
    expect(estimateCostUnsplit(0, DEEPSEEK_PRICE)).toBe(0)
    expect(estimateCostUnsplit(-5, DEEPSEEK_PRICE)).toBe(0)
  })
  it('stays below the split-aware result, i.e. the documented conservatism', () => {
    const unsplit = estimateCostUnsplit(1000, DEEPSEEK_PRICE)
    const split = estimateCost(1000, { input: 0.5, output: 2, inputTokens: 600, outputTokens: 400 })
    expect(unsplit).toBeLessThan(split)
  })
})
