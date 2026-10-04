import React from 'react'

/**
 * 设置页 · 尺寸与适配（骨架）
 *
 * 2026-10-04 注册空白页。目的：给「控制人物大小 / 默认初始大小」留一个正式入口，
 * 用于适配 DSHA 这类手机 App 与平板分辨率。
 *
 * 现状：只读展示宿主 /api/config 里的三个尺寸相关字段，不提供写入。
 * 下一步（研究项）：
 *   1. 默认初始大小按宿主视口推算（手机 vs 平板的断点策略）
 *   2. 写入通道复用 host 侧 /api/config（当前 handler 只读）
 *   3. 尺寸变化后重启物理循环的缩放感知（上游 0.3.11 已有大小变化回默认悬浮位的行为）
 */
export function SettingsPage(): React.ReactElement {
  const [cfg, setCfg] = React.useState<Record<string, unknown> | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    fetch('/dsh-whale-girl-2/api/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (alive) setCfg(j as Record<string, unknown>)
      })
      .catch((e) => {
        if (alive) setErr(String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  const keys = ['widgetScale', 'infoScale', 'linkScale', 'showInfo']

  return (
    <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.7 }}>
      <h3 style={{ margin: '0 0 4px' }}>鲸鱼娘 · 尺寸与适配</h3>
      <p style={{ opacity: 0.7, margin: '0 0 12px' }}>
        骨架页。下一步在此接入「人物大小 / 默认初始大小」，用于适配 DSHA 手机 App 与平板分辨率。
      </p>
      {err !== null && <p style={{ color: '#c33' }}>读取配置失败：{err}</p>}
      {cfg === null ? (
        <p style={{ opacity: 0.7 }}>读取中…</p>
      ) : (
        <div>
          {keys.map((k) => (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '6px 0',
                borderBottom: '1px solid rgba(128,128,128,.2)'
              }}
            >
              <span>{k}</span>
              <code>{String(cfg[k] ?? '—')}</code>
            </div>
          ))}
        </div>
      )}
      <p style={{ opacity: 0.6, marginTop: 12 }}>
        以上读自宿主 <code>/api/config</code>，只读展示，尚未提供写入通道。
      </p>
    </div>
  )
}
