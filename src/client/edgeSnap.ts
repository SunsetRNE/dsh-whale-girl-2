/**
 * 贴边定位的物理像素对齐（v0.4.5）
 *
 * 背景：WebView 里 1 CSS px 就等于 1 dp（密度无关），但渲染时会被映射到 dpr 个物理像素。
 * 旧的停靠式 `vw - W*sc - ins` 全是浮点：1080 宽、dpr=2.625 的机器上右边缘落在
 * 1064.25 物理 px —— 半格，于是「留白忽宽忽窄、边缘发虚、怎么调都不齐」。
 *
 * 三条规则（顺序不能反）：
 *   ① 量化「边」，不要只量化 x。dpr=3 的机型本来边缘就是整格（1062.0），
 *      只量化 x 反而把它推到 1062.5 —— 越改越糊。
 *   ② 尺寸先上格。170×0.65=110.5 本身就落在 0.0625 物理像素上，光挪位置永远对不齐。
 *      做法是把缩放本身吸到格上（renderScale），保持等比缩放、不拉伸画面。
 *   ③ 留白值本身也上格，且宿主端不能把小数 round 掉 —— 最细步进 = 1 物理像素 = 1/dpr dp。
 *
 * 代价：视觉尺寸会被吸到最近整格，偏差 ≤0.5 物理像素（dpr=2.625 时约 0.19 CSS px），
 * 肉眼不可见；换来的是边缘正好压在物理像素边界上。
 */

export type StopSide = 'left' | 'right'

export interface StopInput {
  /** 视口宽（CSS px） */
  vw: number
  /** 视口高（CSS px） */
  vh: number
  /** 未缩放的挂件基准宽（WIDGET_W） */
  baseW: number
  /** 未缩放的挂件基准高（WIDGET_H） */
  baseH: number
  /** 配置里的缩放（widgetScale） */
  scale: number
  /** 贴边留白（dp / CSS px，允许小数） */
  ins: number
  side: StopSide
  /** window.devicePixelRatio */
  dpr: number
}

export interface StopResult {
  x: number
  y: number
  /** 已上格的缩放 —— 渲染时用它，别用配置原值，否则边缘又掉回半格 */
  scale: number
  /** 视觉尺寸（CSS px，宽已是整物理像素倍） */
  w: number
  h: number
  /** y 的下限（底部留白钳制） */
  maxY: number
  /** 真正生效的留白（物理像素，整数） */
  physInset: number
}

/** dpr 兜底：0 / NaN / 负值一律当 1，避免除以 0 把位置打成 Infinity */
export const safeDpr = (dpr: number): number => (Number.isFinite(dpr) && dpr > 0 ? dpr : 1)

/** 最细可调步进 = 1 物理像素，换算成 CSS px（dpr=2.625 时约 0.381） */
export const stepPx = (dpr: number): number => 1 / safeDpr(dpr)

/** 把坐标系上的一个点（某条边）量化到物理像素格 */
export const alignEdge = (edge: number, dpr: number): number => Math.round(edge * safeDpr(dpr)) / safeDpr(dpr)

/** 把尺寸量化到物理像素格 */
export const alignSize = (size: number, dpr: number): number => Math.round(size * safeDpr(dpr)) / safeDpr(dpr)

/**
 * 等比缩放上格：让 base*scale 正好是整物理像素倍。
 * 返回的是缩放值本身（不是尺寸），所以画面不会被拉伸 —— 只会有 ≤0.5 物理像素的等比微调。
 */
export const renderScale = (base: number, scale: number, dpr: number): number => {
  const d = safeDpr(dpr)
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(scale) || scale <= 0) return scale
  return Math.round(base * scale * d) / (base * d)
}

/**
 * 停靠位：保证 (x + w) 与 (y + h) 的**边**落在整物理格上。
 * 注意不是保证 x/y 自己是整格 —— 单量化 x 会破坏本来已对齐的机型。
 */
export function stopPos(o: StopInput): StopResult {
  const d = safeDpr(o.dpr)
  const scale = renderScale(o.baseW, o.scale, d)
  const w = o.baseW * scale
  const h = o.baseH * scale
  const inQ = alignEdge(o.ins, d)
  const x = o.side === 'left' ? inQ : alignEdge(o.vw - inQ, d) - w
  const maxY = alignEdge(o.vh - inQ, d) - h
  const edge = o.side === 'left' ? x : x + w
  const physInset = Math.round((o.side === 'left' ? edge : o.vw - edge) * d)
  return { x, y: inQ, scale, w, h, maxY, physInset }
}

/**
 * 拖拽反推：按当前落点算「你看着顺眼的那条留白」，并吸到整物理像素。
 * 这是省掉手调数字的主路径 —— 拖到位 → 一键写回 snapInset。
 */
export function measureInset(x: number, w: number, vw: number, dpr: number): number {
  const d = safeDpr(dpr)
  const left = x
  const right = vw - (x + w)
  const nearer = left <= right ? left : right
  return Math.max(0, Math.round(nearer * d) / d)
}

/** 读数：dp（= CSS px）/ 物理 px 双单位，设置页用它显示真实生效值 */
export function formatInset(ins: number, dpr: number): string {
  const d = safeDpr(dpr)
  return `${round(ins, 2)} dp = ${Math.round(ins * d)} 物理px（1dp=${round(d, 3)}px）`
}

const round = (v: number, n: number): number => {
  const p = 10 ** n
  return Math.round(v * p) / p
}
