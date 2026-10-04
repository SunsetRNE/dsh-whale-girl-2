import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 手机端默认档护栏（0.4.9）
 *
 * 2026-10-04 用户从设置页「当前配置」把调好的整份配置回灌，要求写进手机端默认值。
 * 这里直接读源码断言，防止后续谁把默认值改回桌面口径（1.0 缩放 / 12dp 留白 / 默认吸附）。
 * 同时保证宿主 DEFAULT_CONFIG 与客户端 DEFAULT_MENU_CONFIG 两边同值 —— 两边不一致时
 * 会出现「刷新前一个样、刷新后另一个样」的经典双源漂移。
 */
const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const menu = readFileSync(new URL('../src/client/WidgetMenu.tsx', import.meta.url), 'utf8')

const PHONE_PROFILE: Array<[string, string | number]> = [
  ['widgetScale', 0.65],
  ['infoScale', 0.75],
  ['linkScale', 'true'],
  ['snapMargin', 0],
  ['snapInset', 6],
  ['snapOnRelease', 'false'],
  ['edgeGuard', 6],
  ['flingOnRelease', 'false']
]

describe('手机端默认档（用户 2026-10-04 回灌）', () => {
  for (const [key, value] of PHONE_PROFILE) {
    it(`${key}: ${value} 在宿主与客户端默认值里同时存在`, () => {
      const re = new RegExp(`${key}:\\s*${value}\\b`)
      expect(re.test(host)).toBe(true)
      expect(re.test(menu)).toBe(true)
    })
  }

  it('normalizeConfig 缺字段时的回退也是手机档（0.65 / 0.75 / 6dp / 不吸附）', () => {
    expect(/widgetScale[\s\S]{0,120}?: 0\.65/.test(host)).toBe(true)
    expect(/widgetScale[\s\S]{0,120}?: 0\.65/.test(readFileSync(new URL('../src/client/WhaleWidget.tsx', import.meta.url), 'utf8'))).toBe(true)
    expect(/snapOnRelease: o\.snapOnRelease === true/.test(host)).toBe(true)
  })
})
