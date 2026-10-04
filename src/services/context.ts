// 上下文窗口容量线 + 当前会话识别 + 占用率口径（与官方 ContextMeter 对齐）
//
// 0.5.0 修正三件事（真机日志 + DSH 源码定位）：
//   ① Agent 在本版 DSH 里是 `{ readonly id: SessionId }` —— 没有 .session / .sessionId。
//      旧写法 `agent?.session ?? agent?.sessionId` 永远 undefined，于是 `if (!session) return`，
//      currentSession 从未被赋值。日志里 34 条 `measure: tm=true session=false` 就是这条。
//   ② `ctx.sessions.list()` 的语义是「按创建顺序的全部活动会话」，[0] 是**最旧**的，
//      拿它当「当前会话」等于切会话后稳定指向错的会话。
//   ③ 官方占用率口径是 pressure 投影：`projectedTokens ?? pressureTokens ÷ contextWindow`
//      （dsh-client-ui-conversation 的 contextOccupancy），不是 `surfaceTokens ÷ 写死的 60 万`。

/** 兜底容量线：只有在 pressure 投影拿不到 contextWindow 时才用它。 */
export const DEFAULT_CONTEXT_LIMIT = 600000

export function computeContextPct(tokens: number, limit: number): number {
  if (limit <= 0 || tokens <= 0) return 0
  return Math.min(1, tokens / limit)
}

/** 事件流里见过的会话：sessionId → 最近一次事件时间（ms） */
export type SeenMap = ReadonlyMap<string, number>

/**
 * 挑「当前会话」。优先级（0.5.1：改为**跟随真实活动**，不再钉死根 agent）：
 *   ① 最近一次 turn-stopping / inbox-inserted 事件里的 `agent.id` —— 用户正在用的那个会话；
 *   ② 事件时间表里最新的那个会话（切对话框后一旦有事件就会命中）；
 *   ③ 根 agent 的 id（`ctx.agents.roots()[0].id`）—— 只作冷启动兜底；
 *   ④ 都没有 → null（宁可报 null，也不要退回一个错的会话）。
 *
 * 为什么把根 agent 从第①位降下来：`Agent = { id: SessionId }`，而 roots()[0] 只是注册顺序里
 * 的第一个 agent，用户切换对话框时它**不变** —— 进度条就会永远停在那一个会话上（真机反馈
 * 「切会话进度条不动」，日志里 session-switch 至今只出现过 1 次，正是它）。
 */
export function pickSessionId(input: {
  rootId?: string | null
  activeId?: string | null
  seen?: SeenMap
}): string | null {
  if (input.activeId) return input.activeId
  let best: string | null = null
  let bestT = -1
  for (const [id, t] of input.seen ?? []) {
    if (t > bestT) {
      bestT = t
      best = id
    }
  }
  if (best) return best
  return input.rootId ?? null
}

export interface Occupancy {
  /** 用于显示「已用」的 token */
  tokens: number
  /** 容量线（模型上下文窗口） */
  limit: number
  /** 0~1 的占比 */
  pct: number
  /** 数据来源：pressure = 官方投影；fallback = surfaceTokens ÷ 配置容量；none = 都没拿到 */
  source: 'pressure' | 'fallback' | 'none'
  /** 该会话 id（切会话时用它判断是否要立刻刷新） */
  sessionId?: string
}

interface PressureLike {
  projectedTokens?: number
  pressureTokens?: number
  contextWindow?: number
  surfaceTokens?: number
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 占用率：与官方 ContextMeter 同一口径
 *   used = pressure.projectedTokens ?? pressure.pressureTokens
 *   pct  = used / pressure.contextWindow
 * 拿不到 contextWindow 或 used 时退回 fallback（measure().surfaceTokens ÷ 配置容量线）。
 *
 * 为什么不能拿 totalTokens 当上下文占用：它是「请求压力」，对话结束会归 0；
 * surfaceTokens / projectedTokens 才是会话表面的稳定占用。
 */
export function occupancyOf(
  pressure: unknown,
  fallback: { tokens: number; limit: number } = { tokens: 0, limit: DEFAULT_CONTEXT_LIMIT }
): Occupancy {
  const p = (pressure ?? {}) as PressureLike
  const used = num(p.projectedTokens) ?? num(p.pressureTokens)
  const win = num(p.contextWindow)
  if (used !== undefined && win !== undefined && win > 0) {
    return { tokens: used, limit: win, pct: Math.min(1, used / win), source: 'pressure' }
  }
  const limit = num(fallback.limit) && fallback.limit > 0 ? fallback.limit : DEFAULT_CONTEXT_LIMIT
  const tokens = num(fallback.tokens) ?? 0
  return {
    tokens,
    limit,
    pct: limit > 0 ? Math.min(1, tokens / limit) : 0,
    source: tokens > 0 ? 'fallback' : 'none'
  }
}
