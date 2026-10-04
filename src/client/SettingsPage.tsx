import React from 'react'

/**
 * 设置页 · 尺寸与适配
 *
 * 2026-10-04：从骨架页升级为可用控件。
 *   - 挂件大小 widgetScale（0.6~1.5，钳制在 host 与 client 双侧同规则）
 *   - 信息面板大小 infoScale（0.6~1.5）
 *   - 锁定同步 linkScale（挂件与面板一起缩放）
 *
 * 写入策略：先拉全量 config 再改单个字段回灌 —— 只 POST 一个字段会让
 * normalizeConfig 用默认值顶掉其余字段（音效模式、毛玻璃、预警线等都会被打回默认）。
 * 拖动期间本地即时预览，300ms 防抖后落盘。
 *
 * 生效时机：挂件在挂载时读一次 /api/config，改完刷新页面即生效。
 *
 * 待办（下一步）：默认初始大小按视口短边断档推算（autoScale），适配手机 / 平板。
 */
const API = '/dsh-whale-girl-2/api/config'
type Cfg = Record<string, unknown>

const SCALES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'widgetScale', label: '挂件大小', hint: '鲸鱼娘本体的缩放（0.6~1.5）' },
  { key: 'infoScale', label: '信息面板大小', hint: '余额 / 上下文面板独立缩放（0.6~1.5）' }
]

export function SettingsPage(): React.ReactElement {
  const [cfg, setCfg] = React.useState<Cfg | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const cfgRef = React.useRef<Cfg | null>(null)
  const timer = React.useRef<number | null>(null)
  React.useEffect(() => {
    cfgRef.current = cfg
  }, [cfg])

  React.useEffect(() => {
    let alive = true
    fetch(API, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (alive) setCfg(j as Cfg)
      })
      .catch((e) => {
        if (alive) setErr(String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  // 回灌全量：只改一个字段，避免其余字段被 normalizeConfig 用默认值顶掉
  const commit = React.useCallback((): void => {
    const body = cfgRef.current
    if (body === null) return
    setSaving(true)
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.config) setCfg(j.config as Cfg)
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setSaving(false))
  }, [])

  const queue = React.useCallback(
    (patch: Cfg): void => {
      setCfg((c) => (c === null ? c : { ...c, ...patch }))
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(commit, 300)
    },
    [commit]
  )

  const num = (k: string, fallback: number): number => {
    const v = Number(cfg?.[k])
    return Number.isFinite(v) ? v : fallback
  }

  return (
    <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.7 }}>
      <h3 style={{ margin: '0 0 4px' }}>鲸鱼娘 · 尺寸与适配</h3>
      <p style={{ opacity: 0.7, margin: '0 0 16px' }}>
        调整人物与信息面板的大小。手机端建议 0.7~0.9，平板可保持 1.0 以上。
      </p>
      {err !== null && <p style={{ color: '#c33' }}>出错了：{err}</p>}
      {cfg === null ? (
        <p style={{ opacity: 0.7 }}>读取中…</p>
      ) : (
        <div style={{ maxWidth: 420 }}>
          {SCALES.map(({ key, label, hint }) => (
            <div key={key} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{label}</span>
                <code>{num(key, 1).toFixed(2)}</code>
              </div>
              <input
                type="range"
                min={0.6}
                max={1.5}
                step={0.05}
                value={num(key, 1)}
                onChange={(e) => queue({ [key]: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
              <div style={{ opacity: 0.55, fontSize: 12 }}>{hint}</div>
            </div>
          ))}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={cfg.linkScale === true}
              onChange={(e) => queue({ linkScale: e.target.checked })}
            />
            <span>锁定同步：挂件与面板一起缩放</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={cfg.showInfo === true}
              onChange={(e) => queue({ showInfo: e.target.checked })}
            />
            <span>信息面板（CPU / 内存 / 时间）</span>
          </label>

          <div style={{ marginTop: 12, marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>边缘吸附范围</span>
              <code>{num('snapMargin', 0) === 0 ? '关闭' : num('snapMargin', 0) + 'px'}</code>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min={0}
                max={120}
                step={1}
                value={num('snapMargin', 0)}
                onChange={(e) => queue({ snapMargin: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={0}
                max={120}
                step={1}
                value={num('snapMargin', 0)}
                onChange={(e) => queue({ snapMargin: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })}
                style={{ width: 64 }}
              />
            </div>
            <div style={{ opacity: 0.55, fontSize: 12 }}>
              0 = <strong>关闭吸附</strong>（拖到哪停哪）；数值 = 松手时离边多少 px 以内才被吸过去
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={cfg.snapOnRelease !== false}
              onChange={(e) => queue({ snapOnRelease: e.target.checked })}
            />
            <span>松手吸附到边缘（关掉 = 拖到哪停哪）</span>
          </label>

          <div style={{ marginTop: 12, marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>贴边留白</span>
              <code>{num('snapInset', 12) + 'px'}</code>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min={0}
                max={40}
                step={1}
                value={num('snapInset', 12)}
                onChange={(e) => queue({ snapInset: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={0}
                max={40}
                step={1}
                value={num('snapInset', 12)}
                onChange={(e) => queue({ snapInset: Math.max(0, Math.min(40, Number(e.target.value) || 0)) })}
                style={{ width: 64 }}
              />
            </div>
            <div style={{ opacity: 0.55, fontSize: 12 }}>
              角色与屏幕边缘的最小距离 —— 嫌"贴太死"就往右拉（12~20 观感较稳），拉到 0 才是完全贴边
            </div>
          </div>

          <p style={{ opacity: 0.6, margin: '12px 0 0' }}>
            {saving ? '保存中…' : '已保存'} · 挂件在挂载时读取配置，刷新页面即生效。
          </p>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', opacity: 0.7, fontSize: 12 }}>
              当前配置（全部字段）— 调好后把这段发我，可以直接写进手机端默认值
            </summary>
            <pre
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                opacity: 0.8,
                margin: '8px 0 0'
              }}
            >
              {JSON.stringify(cfg, null, 1)}
            </pre>
          </details>
          <p style={{ opacity: 0.6, margin: '8px 0 0' }}>
            默认初始大小（按手机 / 平板自动分档）尚未接入，当前默认值为 1.00。
          </p>
        </div>
      )}
    </div>
  )
}
