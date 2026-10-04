export interface TurnPricing {
  input: number // 元 / 百万 token
  output: number // 元 / 百万 token
  inputTokens: number
  outputTokens: number
}

/**
 * 单价（元 / 百万 token）。沿用作者原值，**未独立核价** —— 模型调价时改这里。
 * 旧版把这两个数字硬编码在 src/index.ts 的调用点里，改价要翻源码。
 */
export const DEEPSEEK_PRICE = { input: 0.5, output: 2 } as const

export function estimateCost(tokens: number, p: TurnPricing): number {
  if (tokens <= 0) return 0
  const inT = Math.min(tokens, p.inputTokens)
  // 显式给了 outputTokens 就按它算；没给（0）才用「总量 - 输入量」反推。
  // 旧版完全忽略 p.outputTokens，这个字段一直是个死参数。
  const outT = p.outputTokens > 0
    ? Math.min(p.outputTokens, Math.max(0, tokens - inT))
    : Math.max(0, tokens - inT)
  return (inT * p.input + outT * p.output) / 1_000_000
}

/**
 * 退化估算：只有总 token、拿不到输入/输出拆分时使用（tokenMeter.measure() 目前只给总量）。
 * 全部按输入价折算 —— 这个口径**偏低**，UI 上必须标成「估算」而不是确定值。
 * 存在意义是让调用点不必再编一个假的拆分：旧调用点传的是
 * `{ inputTokens: total, outputTokens: 0 }`，等于宣称「本轮全部是输入」。
 */
export function estimateCostUnsplit(totalTokens: number, price: { input: number }): number {
  if (totalTokens <= 0) return 0
  return (totalTokens * price.input) / 1_000_000
}
