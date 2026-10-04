import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_LIMIT, occupancyOf, pickSessionId } from '../src/services/context'

describe('当前会话识别（切会话就能换判定）', () => {
  it('优先根 agent 的 id —— Agent 在本版 DSH 是 { id }，旧代码读 .session 永远 undefined', () => {
    const seen = new Map([['s-other', 9]])
    expect(pickSessionId({ rootId: 's-root', activeId: 's-active', seen })).toBe('s-root')
  })

  it('没有根 agent 时用最近一次 turn 的 agent.id', () => {
    expect(pickSessionId({ activeId: 's-active', seen: new Map([['s-other', 9]]) })).toBe('s-active')
  })

  it('都没有时取事件时间表里最新的 —— 不是 sessions.list()[0]（那是最旧的，切会话后必错）', () => {
    const seen = new Map([
      ['oldest', 1],
      ['middle', 5],
      ['newest', 9]
    ])
    expect(pickSessionId({ seen })).toBe('newest')
  })

  it('全空返回 null，不退回一个错的会话', () => {
    expect(pickSessionId({})).toBeNull()
  })
})

describe('上下文占用率（与官方 ContextMeter 同口径）', () => {
  it('pressure 投影：projectedTokens ÷ contextWindow', () => {
    const o = occupancyOf({ projectedTokens: 120000, contextWindow: 600000, surfaceTokens: 9 })
    expect(o).toMatchObject({ tokens: 120000, limit: 600000, source: 'pressure' })
    expect(o.pct).toBeCloseTo(0.2, 6)
  })

  it('没有 projectedTokens 时退回 pressureTokens', () => {
    expect(occupancyOf({ pressureTokens: 30000, contextWindow: 300000 }).pct).toBeCloseTo(0.1, 6)
  })

  it('没有 contextWindow 时退回 surfaceTokens ÷ 配置容量线', () => {
    const o = occupancyOf({ surfaceTokens: 120000 }, { tokens: 120000, limit: 600000 })
    expect(o).toMatchObject({ tokens: 120000, limit: 600000, source: 'fallback' })
    expect(o.pct).toBeCloseTo(0.2, 6)
  })

  it('什么都没拿到 → source=none，不编数字', () => {
    const o = occupancyOf(undefined, { tokens: 0, limit: 0 })
    expect(o.source).toBe('none')
    expect(o.tokens).toBe(0)
    expect(o.limit).toBe(DEFAULT_CONTEXT_LIMIT)
  })

  it('超过窗口也不溢出 1', () => {
    expect(occupancyOf({ projectedTokens: 900000, contextWindow: 600000 }).pct).toBe(1)
  })

  it('切会话：换了投影值立刻给出新的占比（无需等下一轮）', () => {
    const a = occupancyOf({ projectedTokens: 60000, contextWindow: 600000 })
    const b = occupancyOf({ projectedTokens: 300000, contextWindow: 600000 })
    expect(a.pct).toBeCloseTo(0.1, 6)
    expect(b.pct).toBeCloseTo(0.5, 6)
    expect(a.pct).not.toBe(b.pct)
  })
})
