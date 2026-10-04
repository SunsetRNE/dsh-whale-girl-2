/**
 * 会话嗅探（0.5.2）：从页面自己的网络流量里认出「当前打开的对话框」。
 *
 * 为什么要这么干：DSH 的 Web 端把「当前会话」放在应用状态里（官方组件靠 props 拿 useSession /
 * useProjection），而挂件是挂在 shell.overlay 上的独立根，**拿不到那套 props**（真机实测：
 * 控制台没有 slot props 行）。宿主侧也猜不准 —— 「打开对话框」这个动作本身不产生 session 事件。
 * 但无论 UI 用什么状态管理，**打开一个会话一定会去拉它的数据**，那串 `session-<uuid>` 必然
 * 出现在 fetch URL 或 WebSocket 帧里。嗅探它，就是我们能拿到的最靠得住的「当前对话框」信号。
 */

/** 会话 id 形状：session-<8>-<4>-<4>-<4>-<12>（小写 hex） */
export const SESSION_ID_RE =
  /session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

/** 从任意文本（URL / WS 帧）里取**最后一个**会话 id —— 一个请求可能带多个 id，最后一个最接近「当前」 */
export function extractSessionId(text: string): string | null {
  if (!text) return null
  const all = text.match(SESSION_ID_RE)
  return all && all.length > 0 ? all[all.length - 1] : null
}

type Listener = (id: string) => void
const listeners = new Set<Listener>()
let watched: string | null = null

export const getWatchedSession = (): string | null => watched

export function noteSessionId(id: string): void {
  if (!id || id === watched) return
  watched = id
  for (const l of listeners) {
    try {
      l(id)
    } catch {
      // 单个订阅者出错不影响其它订阅者
    }
  }
}

export function subscribeSession(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * 装上嗅探：包 fetch 与 WebSocket.send。返回卸载函数。
 * `report` 用于把「看到了什么」写回宿主日志 —— 客户端没有可读日志，这是唯一的取证通道。
 */
export function installSessionSniffer(report: (msg: string) => void): () => void {
  const w = window as unknown as { __wgSnifferOn?: boolean }
  if (w.__wgSnifferOn) return () => undefined
  w.__wgSnifferOn = true
  const cleanups: Array<() => void> = []

  // ① fetch
  try {
    const origFetch = window.fetch
    if (typeof origFetch === 'function') {
      window.fetch = function patched(input: RequestInfo | URL, init?: RequestInit) {
        try {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url ?? ''
          const id = extractSessionId(String(url))
          if (id) {
            if (id !== watched) report(`sniff/fetch → ${id}`)
            noteSessionId(id)
          }
        } catch {
          // 嗅探失败绝不影响正常请求
        }
        return origFetch.call(window, input as RequestInfo, init)
      } as typeof window.fetch
      cleanups.push(() => {
        window.fetch = origFetch
      })
    }
  } catch {
    // ignore
  }

  // ② WebSocket.send（会话数据也常走 WS）
  try {
    const origSend = WebSocket.prototype.send
    WebSocket.prototype.send = function patchedSend(data: unknown) {
      try {
        if (typeof data === 'string') {
          const id = extractSessionId(data)
          if (id) {
            if (id !== watched) report(`sniff/ws → ${id}`)
            noteSessionId(id)
          }
        }
      } catch {
        // ignore
      }
      return origSend.call(this, data as never)
    }
    cleanups.push(() => {
      WebSocket.prototype.send = origSend
    })
  } catch {
    // ignore
  }

  return () => {
    for (const c of cleanups) c()
    w.__wgSnifferOn = false
  }
}
