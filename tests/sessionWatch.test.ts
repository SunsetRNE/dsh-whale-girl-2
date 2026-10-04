import { describe, expect, it } from 'vitest'
import { extractSessionId, SESSION_ID_RE } from '../src/client/sessionWatch'

const A = 'session-17a1e669-b111-4428-84b3-e9871ff6b94e'
const B = 'session-f127367f-dc7a-44e1-96a8-d343f0b3f8d0'

describe('会话嗅探：从流量里认出当前对话框', () => {
  it('从普通 URL 里抠出会话 id', () => {
    expect(extractSessionId(`/api/sessions/${A}/tail?limit=50`)).toBe(A)
  })

  it('一个请求带多个 id 时取最后一个（最接近「当前」）', () => {
    expect(extractSessionId(`{"parent":"${A}","child":"${B}"}`)).toBe(B)
  })

  it('WebSocket 帧里的 id 也能认', () => {
    expect(extractSessionId(`{"type":"session/open","id":"${B}"}`)).toBe(B)
  })

  it('没有 id / 空输入 → null（不编一个出来）', () => {
    expect(extractSessionId('/api/state')).toBeNull()
    expect(extractSessionId('')).toBeNull()
    expect(extractSessionId('session-not-a-uuid')).toBeNull()
  })

  it('正则不是全局共享状态（连续调用结果稳定）', () => {
    const url = `/x/${A}/y`
    expect(extractSessionId(url)).toBe(A)
    expect(extractSessionId(url)).toBe(A)
    expect(SESSION_ID_RE.lastIndex).toBe(0)
  })
})
