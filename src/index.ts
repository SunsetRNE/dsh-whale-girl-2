import { fetchBalance, Ledger, fetchProviderBalance } from './services/balance'
import { listProviders, currentModel, selectModel } from './services/providers'
import { computeContextPct, DEFAULT_CONTEXT_LIMIT } from './services/context'
import { estimateCostUnsplit, DEEPSEEK_PRICE } from './services/turnCost'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-whale-girl-2'
export const inject = ['webServer', 'credentials', 'timer', 'tokenMeter', 'sessions', 'agents']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const USAGE_FILE = path.join(DSH_HOME, '.whale-girl-usage.json')
const CONFIG_FILE = path.join(DSH_HOME, '.whale-girl-config.json')
const DIAG_FILE = path.join(DSH_HOME, '.whale-girl-diag.log')
/** CPU 采样缓存（用 os.cpus() 时间差计算占用，Windows 无 loadavg）。 */
let lastCpuTimes: { total: number; busy: number } | null = null
const ASSET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets')

/**
 * 日志转义：diag 的部分参数来自 HTTP 请求体（如 select-model 的 provider / model），
 * 未净化直接落盘时，一个 `\n` 就能伪造出一条日志行（实测：provider="a\nb" 把一行拆成两行）。
 * 控制字符统一转成可见形式，日志每行恒定对应一条记录。
 */
function escapeLog(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f]/g, (c) => {
    const code = c.charCodeAt(0)
    if (code === 10) return '\\n'
    if (code === 13) return '\\r'
    if (code === 9) return '\\t'
    return '\\x' + code.toString(16).padStart(2, '0')
  })
}

/** 诊断记录（排查 client 数据是否到达、host 数据是否就绪）。用完可删除该日志文件。 */
function diag(line: string): void {
  try {
    // 轮转：超过 1MB 归档为 .old，避免长期使用无限增长。
    // statSync 在文件不存在时抛 ENOENT，必须单独兜住 —— 否则异常会被外层 catch 吃掉，
    // appendFileSync 永远执行不到，干净安装上的 diag 会变成彻底的死代码（无任何日志产出）。
    let size = 0
    try {
      size = fs.statSync(DIAG_FILE).size
    } catch {
      size = 0
    }
    if (size > 1024 * 1024) fs.renameSync(DIAG_FILE, DIAG_FILE + '.old')
    fs.appendFileSync(DIAG_FILE, `[${new Date().toISOString()}] ${escapeLog(line)}\n`)
  } catch {
    // ignore
  }
}

/** 详单级诊断（measure 全量 JSON 等）。默认关闭：它每次 /api/state 都会写 800 字节，属于写入热点。 */
const DEBUG = process.env.WHALE_GIRL_DEBUG === '1'

/**
 * 官方 DeepSeek 路由的凭据引用名。
 *
 * 旧版硬编码 'DEEPSEEK_API_KEY'，但在 DSHA 环境里官方 provider 的 apiKeyEnv 被
 * profile 的 cordis.patch.yml 覆盖成了 'DSHA_DEEPSEEK_OFFICIAL_API_KEY'，
 * 于是 resolve 永远拿不到值，日志里只剩一行 'refresh: no-key'、余额恒为 null。
 *
 * DSH 自己的做法（dsh-llm-deepseek-api-key/lib/index.js:40-49）是**从 connection.apiKeyEnv
 * 取引用名**、再退回启动环境变量。这里在插件拿不到 connection 的前提下退而求其次：
 * 按候选名逐个 resolve，命中即用；可用 WHALE_GIRL_KEY_REF 显式指定。
 * 日志只记录**引用名**，绝不记录值。
 */
const OFFICIAL_KEY_REFS: string[] = [
  process.env.WHALE_GIRL_KEY_REF ?? '',
  'DSHA_DEEPSEEK_OFFICIAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_OFFICIAL_API_KEY'
].filter((s) => s !== '')

/** 把凭据服务的返回值统一成字符串：它可能直接给字符串，也可能给 { value }。 */
function unwrapCredential(hit: unknown): string | undefined {
  if (typeof hit === 'string') return hit.length > 0 ? hit : undefined
  if (hit && typeof hit === 'object') {
    const v = (hit as { value?: unknown }).value
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  return undefined
}

/** 逐个候选引用名取密钥，返回命中的名字与值（值只在本进程内存里流转，不落日志）。 */
async function resolveOfficialKey(creds: any): Promise<{ key: string; ref: string } | null> {
  for (const ref of OFFICIAL_KEY_REFS) {
    try {
      const key = unwrapCredential(await creds.resolve(ref))
      if (key !== undefined) return { key, ref }
    } catch {
      // 试下一个
    }
    // 凭据服务没有该引用时，退回启动环境变量（与 DSH 自身的回退顺序一致）
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) return { key: ambient, ref: `${ref} (env)` }
  }
  return null
}

// 挂件配置默认值（也是"自定义接口"的字段说明：直接编辑 ~/.dsh/.whale-girl-config.json 即可自定义显示组合）
export interface WidgetConfig {
  /** 音效：'cute' 可爱合成音 / 'duck' 鸭叫（需要 mp3，可能被 webserver 403 拦截时无声） */
  soundMode: 'cute' | 'duck'
  /** 是否显示底部上下文进度条 */
  showProgress: boolean
  /** 是否显示彩蛋/随机台词气泡 */
  showBubble: boolean
  /** 是否在进度条详情里显示余额 */
  showBalance: boolean
  /** 是否在进度条详情里显示峰谷提醒 */
  showPeak: boolean
  /** 中键弹弓发射力度系数（松手速度 = 拉开距离 × 该系数），范围 5~60 */
  slingPower: number
  /** 省电模式：空闲 60 秒后暂停漂浮动画并停用常驻毛玻璃（交互立即恢复） */
  ecoMode: boolean
  /** 毛玻璃强度（进度条底板 blur 像素，0=关闭），0~16 默认 4 */
  frost: number
  /** 进度条底板背景不透明度，0.2~1 默认 0.82（越小越透） */
  panelOpacity: number
  /** 余额预警线（元）：低于该值时气泡提醒充值，0=关闭预警 */
  lowBalance: number
  /** 是否显示 Agent 工作状态徽章（思考中/搞定啦）与过渡台词 */
  showWorkState: boolean
  /** 实时余额刷新：开启后余额/用量按约 10 秒刷新（默认 60 秒，比 whale-widget 更实时） */
  realtimeBalance: boolean
  /** 是否显示信息面板（时间/系统资源） */
  showInfo: boolean
  /** 信息面板跟随角色的距离阈值（超过则脱钩独立）；px */
  followThreshold: number
  /** 信息面板高斯模糊强度（backdrop-filter blur，0=关闭），0~16 默认 4；与进度条 frost 独立 */
  infoFrost: number
  /** DSH 输出/思考（thinking）时是否暂停信息面板物理循环（省主线程，默认开） */
  pauseOnThinking: boolean
  /** 挂件整体缩放（visual scale），0.6~1.5 默认 1 */
  widgetScale: number
  /** 信息面板大小（visual scale），0.6~1.5 默认 1；若锁定同步则跟随挂件大小 */
  infoScale: number
  /** 锁定角色与面板大小同步（面板大小=挂件大小） */
  linkScale: boolean
  /** 边缘吸附范围（px）：0 = 按视口自动（窄屏自动收窄），>0 = 手动指定 */
  snapMargin: number
  /** 贴边留白（px）：角色与屏幕边缘之间至少留这么多 —— 用来让挂件/徽章/气泡不顶着屏幕边 */
  snapInset: number
  /** 松手时是否吸附到最近侧边：关掉 = 拖到哪就停哪（仅越界时夹回屏内） */
  snapOnRelease: boolean
  /** 边缘保底留白（dp）：关掉吸附后越界夹取仍保留的最小距离（0 = 允许完全贴边） */
  edgeGuard: number
  /** 松手甩抛（惯性滑行）：false = 松手就地停住（默认关） */
  flingOnRelease: boolean
  /** 绳摆模式：拖拽时角色以弹性绳挂在鼠标上 */
  ropeMode: boolean
  /** 重力模式：松手落地（关闭=悬浮归位） */
  gravityMode: boolean
  /** 弹性绳弹簧系数（加速度 = K × 伸长量） */
  ropeK: number
  /** 空气阻力系数 0~10（越高收敛越快） */
  ropeDamp: number
  /** 弹性上限：绳子最大可伸长量（px），超过后刚性拉住 */
  ropeMax: number
  /** 角色反弹弹性 0.1~1（1=完全弹性，越小撞墙损失越多） */
  bounceE: number
  /** 重力模式落地滑行的地面摩擦 0.8~0.99（越小越滑） */
  groundFriction: number
  /** DeepSleep 挺尸态：无任务+无互动 5~10 分钟后睡觉，交互唤醒（默认开） */
  deepSleep: boolean
}

const DEFAULT_CONFIG: WidgetConfig = {
  soundMode: 'cute',
  showProgress: true,
  showBubble: true,
  showBalance: true,
  showPeak: true,
  slingPower: 20,
  ecoMode: true,
  frost: 4,
  panelOpacity: 0.82,
  lowBalance: 10,
  showWorkState: true,
  realtimeBalance: false,
  showInfo: false,
  followThreshold: 180,
  infoFrost: 4,
  pauseOnThinking: true,
  // ── 手机端默认档（2026-10-04 由设置页「当前配置」回灌，见 CHANGELOG 0.4.9）──
  widgetScale: 0.65,
  infoScale: 0.75,
  linkScale: true,
  gravityMode: false,
  ropeMode: false,
  ropeK: 80,
  ropeDamp: 3,
  ropeMax: 150,
  bounceE: 1,
  groundFriction: 0.95,
  deepSleep: true,
  snapMargin: 0,
  snapInset: 6,
  snapOnRelease: false,
  edgeGuard: 6,
  flingOnRelease: false
}

function normalizeConfig(raw: unknown): WidgetConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const power = Number(o.slingPower)
  return {
    soundMode: o.soundMode === 'duck' ? 'duck' : 'cute',
    showProgress: o.showProgress !== false,
    showBubble: o.showBubble !== false,
    showBalance: o.showBalance !== false,
    showPeak: o.showPeak !== false,
    slingPower: Number.isFinite(power) ? Math.min(60, Math.max(5, power)) : 20,
    ecoMode: o.ecoMode !== false,
    frost: Number.isFinite(Number(o.frost)) ? Math.min(16, Math.max(0, Math.round(Number(o.frost)))) : 4,
    panelOpacity: Number.isFinite(Number(o.panelOpacity)) ? Math.min(1, Math.max(0.2, Number(o.panelOpacity))) : 0.82,
    lowBalance: Number.isFinite(Number(o.lowBalance)) ? Math.max(0, Number(o.lowBalance)) : 10,
    showWorkState: o.showWorkState !== false,
    realtimeBalance: o.realtimeBalance === true,
    // 与 DEFAULT_CONFIG 对齐：信息面板默认关闭，只有显式 true 才开。
    // 旧写法 `!== false` 是「缺省即开」—— 任何一次只带部分字段的 POST 都会把这个默认关掉的面板
    // 自己打开（实测：只提交尺寸三字段就让 CPU/内存面板凭空冒出来）。上游 0.4.2 起就有这处不一致。
    showInfo: o.showInfo === true,
    followThreshold: Number.isFinite(Number(o.followThreshold)) ? Math.min(360, Math.max(60, Math.round(Number(o.followThreshold)))) : 180,
    infoFrost: Number.isFinite(Number(o.infoFrost)) ? Math.min(16, Math.max(0, Math.round(Number(o.infoFrost)))) : 4,
    pauseOnThinking: o.pauseOnThinking !== false,
    // 手机端默认档：缺失字段回退到 0.65 / 0.75（不再是桌面口径的 1）
    widgetScale: Number.isFinite(Number(o.widgetScale)) ? Math.min(1.5, Math.max(0.6, Number(o.widgetScale))) : 0.65,
    infoScale: Number.isFinite(Number(o.infoScale)) ? Math.min(1.5, Math.max(0.6, Number(o.infoScale))) : 0.75,
    linkScale: o.linkScale !== false,
    gravityMode: o.gravityMode === true,
    ropeMode: o.ropeMode === true,
    ropeK: Number.isFinite(Number(o.ropeK)) ? Math.min(200, Math.max(20, Number(o.ropeK))) : 80,
    ropeDamp: Number.isFinite(Number(o.ropeDamp)) ? Math.min(10, Math.max(0, Number(o.ropeDamp))) : 3,
    ropeMax: Number.isFinite(Number(o.ropeMax)) ? Math.min(400, Math.max(40, Number(o.ropeMax))) : 150,
    bounceE: Number.isFinite(Number(o.bounceE)) ? Math.min(1, Math.max(0.1, Number(o.bounceE))) : 1,
    groundFriction: Number.isFinite(Number(o.groundFriction)) ? Math.min(0.99, Math.max(0.8, Number(o.groundFriction))) : 0.95,
    deepSleep: o.deepSleep !== false,
    snapMargin: Number.isFinite(Number(o.snapMargin))
      ? Math.min(200, Math.max(0, Math.round(Number(o.snapMargin))))
      : 0,
    // 0 是合法值（完全贴边），因此不能用 `|| 12` 兜底。
    // 不再 Math.round：最细步进 = 1 物理像素 = 1/dpr dp（dpr=2.625 时 0.381），
    // 宿主侧取整会把精度吃掉 —— 设置页调了小数、落盘后被抹平，边缘纹丝不动。
    snapInset: Number.isFinite(Number(o.snapInset)) ? Math.min(60, Math.max(0, Number(o.snapInset))) : 6,
    // 边缘保底留白：关掉贴边吸附后越界夹取仍保留的最小距离（0 = 允许完全贴边）
    edgeGuard: Number.isFinite(Number(o.edgeGuard)) ? Math.min(60, Math.max(0, Number(o.edgeGuard))) : 6,
    // 松手吸附开关：手机端默认关（拖到哪停哪），要吸附在设置页打开
    snapOnRelease: o.snapOnRelease === true,
    // 松手甩抛：默认关 —— 旧行为是松手后按末速继续滑（摩擦 0.985/帧，800px/s 的轻甩可滑近千 px）钉在角落
    flingOnRelease: o.flingOnRelease === true
  }
}

// 静态资源：图片 + 音效（给客户端挂件用，带缓存头）
// 10/4：官方 Desktop loader 会因 bundles+插件自带 patch 双路径产生两次 apply，
// 路由重复注册会让第二次激活整个失败（表现为挂件消失）——所有 register 改为容错，
// 重复路由跳过并记 diag，不再抛死。
function safeRegister(server: any, entry: { path?: string } & Record<string, unknown>): void {
  try {
    server.register(entry)
  } catch (e: any) {
    diag(`register-skip ${entry?.path ?? '?'}: ${e?.message ?? String(e)}`)
  }
}

function registerAssetRoutes(ctx: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  for (const f of ['whale-girl.png', 'Ya1.mp3', 'Ya2.mp3']) {
    safeRegister(webServer, {
      kind: 'exact',
      path: `/dsh-whale-girl-2/${f}`,
      handler: (req: unknown, res: any) => {
        try {
          const buf = fs.readFileSync(path.join(ASSET_ROOT, f))
          res.writeHead(200, {
            'Content-Type': f.endsWith('.mp3') ? 'audio/mpeg' : 'image/png',
            'Cache-Control': 'public, max-age=86400, immutable',
            'Content-Length': String(buf.length)
          })
          res.end(buf)
        } catch {
          res.writeHead(404)
          res.end()
        }
      }
    })
  }
}

export function apply(ctx: any) {
  diag('apply-ok')
  registerAssetRoutes(ctx)

  const ledger = new Ledger()
  try {
    ledger.load(fs.readFileSync(USAGE_FILE, 'utf8'))
  } catch {
    // first run
  }

  // 挂件配置（读取/写入 CONFIG_FILE；client 通过 api/config GET/POST 读写）
  let widgetConfig: WidgetConfig = DEFAULT_CONFIG
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    widgetConfig = normalizeConfig(JSON.parse(raw))
  } catch {
    // use defaults on first run / malformed config
  }

  /**
   * 配置落盘：原子写 + 留档。
   * 旧写法是裸 writeFileSync —— 写到一半被中断会留下截断的 JSON，
   * 下次启动 normalizeConfig 解析失败就静默退回全部默认值（用户的尺寸/音效设置悄悄丢失）。
   * 这里先备 .bak 再 rename：原始值永远可从 .whale-girl-config.json.bak 取回。
   */
  function writeConfigFile(cfg: WidgetConfig): boolean {
    try {
      try {
        fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak')
      } catch {
        // 首次运行没有原文件，属正常
      }
      const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      fs.renameSync(tmp, CONFIG_FILE)
      return true
    } catch (e) {
      diag(`config-write-failed: ${String(e)}`)
      return false
    }
  }

  let cachedBalance: number | null = null
  let cachedCurrency = 'CNY'
  let lastTurnCost: number | null = null
  // 活跃子代理（分身的 running 计数），由 jobs 服务回调维护（装 subagent bundle 后生效）
  let subagentRunning = 0
  // 当前活跃会话（turn-stopping 时记录；ctx.sessions.list()[0] 不稳定）
  let currentSession: any = null
  // 缓存最近一次成功获取的会话，避免 buildState 轮询时会话引用短暂丢失导致上下文闪 0
  let lastKnownSession: any = null

  // DeepSeek 官方峰谷时段（北京时间）：工作日 9-12 点与 14-18 点为高峰，其余为低谷；周末全天低谷。
  // 依据系统时间判断（与 dsh-whale-widget 的 isPeakTime 一致）。
  function isPeakTime(timeSec: number): boolean {
    if (!isFinite(timeSec)) return false
    const bj = new Date(timeSec * 1000 + 8 * 3600 * 1000)
    const dow = bj.getUTCDay() // 0=周日 6=周六（按北京时间读 UTC 即北京日历日）
    if (dow === 0 || dow === 6) return false
    const hour = bj.getUTCHours()
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  }

  /** 当前时段峰谷：官方时段总是高峰或低谷。 */
  function computePeak(now: Date): 'high' | 'low' {
    return isPeakTime(Math.floor(now.getTime() / 1000)) ? 'high' : 'low'
  }

  async function refreshBalance(): Promise<void> {
    try {
      const creds = ctx.credentials ?? ctx.get('credentials')
      if (!creds) diag('refresh: no-credentials（继续走启动环境变量回退）')
      // 不再硬编码单个引用名：DSHA 环境把官方 provider 的 apiKeyEnv 覆盖掉了，
      // 只认 'DEEPSEEK_API_KEY' 会永远拿不到密钥（旧日志里那串 'refresh: no-key' 就是它）。
      const hit = await resolveOfficialKey(creds ?? { resolve: async () => undefined })
      if (!hit) {
        diag(`refresh: no-key，已试过 ${OFFICIAL_KEY_REFS.join(' / ')}`)
        return
      }
      diag(`refresh: key-from ${hit.ref}`)
      const key = hit.key
      const { totalBalance, currency } = await fetchBalance(key)
      cachedBalance = totalBalance
      cachedCurrency = currency
      ledger.observe(totalBalance)
      diag(`refresh-ok balance=${totalBalance} currency=${currency}`)
      try {
        fs.writeFileSync(USAGE_FILE, JSON.stringify(ledger.state))
      } catch {
        // storage not writable
      }
    } catch (err: any) {
      diag(`refresh-fail ${err?.message ?? String(err)}`)
      // keep last values
    }
  }

  void refreshBalance()

  // 余额刷新：按「实时令牌」配置决定间隔（60s / 10s），自调度使切换即时生效（无需重启）
  const scheduleBalance = () => {
    const ms = widgetConfig.realtimeBalance ? 10000 : 60000
    setTimeout(() => {
      void refreshBalance()
      scheduleBalance()
    }, ms)
  }
  scheduleBalance()

  // 子代理状态感知：统计主 agent 的 running subagent（kind=subagent，status=running/stopping）。
  // 用主 agent 作为 caller 调 jobs.list（caller 相对围栏），回调触发即重算；纯本地、零 API 开销。
  const subagentJobs = ctx.get('jobs')
  const recountSubagents = () => {
    try {
      const agent = ctx.agents?.roots?.()[0] ?? ctx.agents?.list?.()[0]
      if (!subagentJobs || !agent || typeof subagentJobs.list !== 'function') return
      const snaps = (subagentJobs.list(agent) ?? []) as Array<Record<string, unknown>>
      let n = 0
      for (const s of snaps) {
        if (s && s.kind === 'subagent' && (s.status === 'running' || s.status === 'stopping')) n++
      }
      if (n !== subagentRunning) {
        subagentRunning = n
        diag(`subagents: ${n}`)
      }
    } catch {
      // ignore
    }
  }
  if (subagentJobs) {
    if (typeof subagentJobs.onJobsChanged === 'function') subagentJobs.onJobsChanged(() => recountSubagents())
    if (typeof subagentJobs.onJobDone === 'function') subagentJobs.onJobDone(() => recountSubagents())
    if (ctx.on) {
      ctx.on('subagent/start', () => recountSubagents())
      ctx.on('subagent/end', () => recountSubagents())
    }
    recountSubagents()
    setTimeout(recountSubagents, 3000) // 启动后兜底
  }

  // 事件流：任意会话事件都更新当前活跃会话引用（whale-widget 同款方式，重启后会话恢复也能拿到）
  ctx.on('session/event', (session: any) => {
    if (session) currentSession = session
  })

  // 工作状态机（轻量版）：thinking → done → idle。done 判定复用 buildState 的 measure 缓存（60 秒节奏），
  // 不新增任何 measure 调用（此前 10 秒一次的全量 measure 拖慢宿主，曾致渲染器启动超时，已回滚）
  let workState: 'idle' | 'thinking' | 'done' = 'idle'
  let workStateSince = Date.now()
  let lastGrowthTotal = -1
  let lastGrowthAt = 0
  let lastMeasureTotal = 0
  function setWorkState(s: 'idle' | 'thinking' | 'done'): void {
    if (workState === s) return
    workState = s
    workStateSince = Date.now()
    if (s === 'thinking') {
      lastGrowthTotal = -1
      lastGrowthAt = Date.now()
    }
    diag(`workstate: ${s}`)
  }
  // 用户发消息 → 思考中（事件名沿用 pelican 生态验证过的用法；try 包裹防宿主版本差异）
  try {
    ctx.on('agent/inbox/inserted', () => setWorkState('thinking'))
  } catch {
    diag('workstate: agent/inbox/inserted 事件不可用')
  }

  // 每轮消耗：turn 即将结束时用 tokenMeter 测当前会话 token，估算本轮成本 + 记入当前小时桶
  ctx.on('agent/turn-stopping', (payload: any) => {
    setWorkState('done')
    try {
      const agent = payload?.agent
      const session =
        agent?.session ??
        (agent?.sessionId ? ctx.sessions?.get?.(agent.sessionId) : undefined)
      if (!session) return
      currentSession = session
      const tm = ctx.tokenMeter ?? ctx.get('tokenMeter')
      if (!tm) return
      const m = tm.measure(session)
      const total = Number(m?.totalTokens ?? m?.tokens ?? m?.total ?? 0)
      if (total > 0) {
        // tokenMeter 只给总量，拿不到输入/输出拆分 → 用退化估算（全部按输入价，口径偏低），
        // 前端把它显示为「估算」。旧写法传 `{ inputTokens: total, outputTokens: 0 }`，
        // 等于宣称本轮全是输入，turnCost 里的 output 单价成了永不执行的死代码。
        lastTurnCost = estimateCostUnsplit(total, DEEPSEEK_PRICE)
      }
    } catch {
      // ignore measurement errors
    }
  })

  // 数据接口：webServer JSON 路由（npm 编译插件用 webServer，不用 Builtin harness）
  function buildState(): object {
    let contextTokens = 0
    try {
      const tm = ctx.tokenMeter ?? ctx.get('tokenMeter')
      const agent = ctx.agents?.roots?.()[0] ?? ctx.agents?.list?.()[0]
      const session =
        currentSession ??
        lastKnownSession ??
        agent?.session ??
        ctx.sessions?.list?.()[0] ??
        ctx.sessions?.get?.()
      if (session) lastKnownSession = session
      if (tm && session) {
        const m = tm.measure(session)
        try {
          if (DEBUG) {
            diag(`measure-keys: ${Object.keys(m).join(',')}`)
            diag(`measure: ${JSON.stringify(m).slice(0, 800)}`)
          }
        } catch (e: any) {
          diag(`measure-err: ${String(e)}`)
        }
        // surfaceTokens = 会话表面稳定占用（对话结束不清零）；totalTokens = 请求压力（对话结束归 0）
        contextTokens = Number(m?.surfaceTokens ?? m?.totalTokens ?? m?.tokens ?? m?.total ?? 0)
        // 工作状态机：缓存本次 measure 总量，用于 done 判定（60 秒节奏，零额外成本）
        lastMeasureTotal = Number(m?.totalTokens ?? m?.tokens ?? m?.total ?? 0)
        if (workState === 'thinking') {
          if (lastMeasureTotal !== lastGrowthTotal) {
            lastGrowthTotal = lastMeasureTotal
            lastGrowthAt = Date.now()
          } else if (lastGrowthTotal >= 0 && Date.now() - lastGrowthAt > 50000) {
            setWorkState('done')
          }
        }
      } else {
        diag(`measure: tm=${!!tm} session=${!!session}`)
      }
    } catch {
      // ignore
    }
    const peak = computePeak(new Date())
    if (DEBUG) {
      diag(`peak: ${peak}`)
      diag(
        `state: ctxTokens=${contextTokens} balance=${cachedBalance} currency=${cachedCurrency} todayUsage=${ledger.state.todayUsage} lastTurnCost=${lastTurnCost}`
      )
    }
    return {
      balance: cachedBalance,
      currency: cachedCurrency,
      todayUsage: ledger.state.todayUsage,
      contextPct: computeContextPct(contextTokens, DEFAULT_CONTEXT_LIMIT),
      contextTokens,
      contextLimit: DEFAULT_CONTEXT_LIMIT,
      lastTurnCost,
      peakLow: peak,
      refreshMs: widgetConfig.realtimeBalance ? 10000 : 60000,
      subagentRunning,
      sysInfo: readSys()
    }
  }

  /** 系统资源：内存（os 准确）+ CPU（loadavg 近似，避免引入笨重 sysinfo 依赖）。 */
  function readSys(): { memPct: number; memUsed: number; memTotal: number; cpu: number } {
    try {
      const total = os.totalmem()
      const free = os.freemem()
      const used = total - free
      const memPct = total > 0 ? Math.round((used / total) * 100) : 0
      // CPU：用 os.cpus() 时间差（loadavg 在 Windows 恒为 0，这里跨两次采样算真实占用）
      const cpus = os.cpus()
      let cpuTotal = 0
      let cpuIdle = 0
      for (const c of cpus) {
        const t = c.times as unknown as Record<string, number>
        cpuTotal += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0)
        cpuIdle += t.idle || 0
      }
      const cpuBusy = cpuTotal - cpuIdle
      let cpu = 0
      if (lastCpuTimes) {
        const dTotal = cpuTotal - lastCpuTimes.total
        const dBusy = cpuBusy - lastCpuTimes.busy
        if (dTotal > 0) cpu = Math.min(100, Math.round((dBusy / dTotal) * 100))
      }
      lastCpuTimes = { total: cpuTotal, busy: cpuBusy }
      return {
        memPct,
        memUsed: Math.round((used / 1024 ** 3) * 10) / 10,
        memTotal: Math.round((total / 1024 ** 3) * 10) / 10,
        cpu
      }
    } catch {
      return { memPct: 0, memUsed: 0, memTotal: 0, cpu: 0 }
    }
  }

  function registerApiRoutes(server: any): void {
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/state',
      handler: (req: unknown, res: any) => {
        if (DEBUG) diag('state-hit')
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(JSON.stringify(buildState()))
      }
    })
    // 工作状态端点：done 30 秒、thinking 10 分钟惰性过期归 idle
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/workstate',
      handler: (req: unknown, res: any) => {
        let s = workState
        const age = Date.now() - workStateSince
        if (s === 'done' && age > 30000) s = 'idle'
        if (s === 'thinking' && age > 600000) s = 'idle'
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(JSON.stringify({ state: s, since: workStateSince }))
      }
    })
    // JSONP 端点：client 用动态 <script> 加载（script 资源请求与 client.js 同通道，可透过 webserver 认证；普通 fetch 会被 403 拦）
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/state.js',
      handler: (req: unknown, res: any) => {
        if (DEBUG) diag('state-jsonp-hit')
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(`window.__wgState=${JSON.stringify(buildState())};`)
      }
    })
    // GET：返回挂件配置；POST：保存挂件配置
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/config',
      handler: (req: any, res: any) => {
        const method = (req.method ?? 'GET').toUpperCase()
        if (method === 'POST' || method === 'PUT') {
          let body = ''
          req.on('data', (c: Buffer) => {
            body += String(c)
          })
          req.on('end', () => {
            let saved = false
            try {
              const parsed = JSON.parse(body)
              widgetConfig = normalizeConfig(parsed)
              saved = writeConfigFile(widgetConfig)
            } catch {
              // keep current on malformed body
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: saved, config: widgetConfig }))
          })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(JSON.stringify(widgetConfig))
      }
    })
    // 交互诊断回流：bridge 脚本收到挂件事件后上报，供宿主写诊断日志（我读日志即可确认弹跳/点击等交互发生）
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/diag-event',
      handler: (req: any, res: any) => {
        let body = ''
        req.on('data', (c: Buffer) => {
          body += String(c)
        })
        req.on('end', () => {
          // 交互回流是"逐次点击"级别的量：实测 32 次点击产生 192 行 event，占日志 24%。
          // 收进 DEBUG —— diag 修好之前的空转让人以为这条链路不要钱，其实不是。
          // 默认只收「诊断价值高、量又小」的两类：点击与吸附（一次点击最多 2 行）。
          // 其余仍在 DEBUG 下才写 —— 实测 32 次点击就产 192 行 event，全开会把日志淹掉。
          if (DEBUG || /"(click|snap)"/.test(body)) diag(`event: ${body.slice(0, 200)}`)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end('{"ok":true}')
        })
      }
    })

    // API providers list + per-provider balance (parallel; null when unsupported)
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/providers',
      handler: (req: unknown, res: any) => {
        void (async () => {
          const creds = ctx.credentials ?? ctx.get('credentials')
          const cur = currentModel()
          const rows = await Promise.all(listProviders().map(async (p) => {
            let balance: number | null = null
            let currency = 'CNY'
            if (creds) {
              try {
                // 官方路由的 apiKeyEnv 会被环境覆盖（本机 profile 把它写成
                // DSHA_DEEPSEEK_OFFICIAL_API_KEY），所以走候选引用名；
                // 其它 provider 仍照各自在 settings.yaml 里声明的引用取。
                const key =
                  p.family === 'deepseek'
                    ? (await resolveOfficialKey(creds))?.key
                    : unwrapCredential(await creds.resolve(p.apiKeyEnv ?? ''))
                if (key) {
                  const r = await fetchProviderBalance({ family: p.family, baseURL: p.baseURL }, key)
                  if (r) { balance = r.totalBalance; currency = r.currency }
                }
              } catch {
                // balance stays null
              }
            }
            return { ...p, balance, currency, active: p.id === cur.provider }
          }))
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          })
          res.end(JSON.stringify({ providers: rows, current: cur }))
        })()
      }
    })

    // Switch default model route (writes agent-default-model in settings.yaml)
    safeRegister(server, {
      kind: 'exact',
      path: '/dsh-whale-girl-2/api/select-model',
      handler: (req: any, res: any) => {
        let body = ''
        req.on('data', (c: Buffer) => {
          body += String(c)
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { provider?: string; model?: string }
            const provider = String(parsed.provider ?? '')
            const model = String(parsed.model ?? '')
            if (!provider || !model) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'provider and model required' }))
              return
            }
            const ok = selectModel(provider, model)
            diag(`select-model ${provider}/${model} ok=${ok}`)
            res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok }))
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'bad json' }))
          }
        })
      }
    })
  }

  const apiServer = ctx.get('webServer')
  if (apiServer) {
    registerApiRoutes(apiServer)
    // 数据桥：把桥接脚本注入主页面顶层（主页面 fetch 带认证，能拿数据），脚本定期拉取并 postMessage 广播给 slots 挂件。
    // slots 组件运行在 iframe/隔离上下文，其自身 fetch 不带认证会被 webserver 403 拦。
    const BRIDGE_JS = `(function () {
  if (window.__wgBridge) return
  window.__wgBridge = true
  var nextDelay = 60000
  var pull = function () {
    try {
      fetch('/dsh-whale-girl-2/api/state', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && typeof d === 'object') {
            window.__wgData = d
            window.postMessage({ __wgData: d }, '*')
          }
          if (d && typeof d.refreshMs === 'number') nextDelay = d.refreshMs
          setTimeout(pull, nextDelay)
        })
        .catch(function () { setTimeout(pull, nextDelay) })
    } catch (e) { setTimeout(pull, nextDelay) }
  }
  pull()
  // 注：pull 自调度，间隔跟随 /api/state 的 refreshMs（实时切换即时生效）
  // 工作状态：5 秒轮询并广播给挂件（读取轻量端点，不触发 measure）
  var pullWork = function () {
    try {
      fetch('/dsh-whale-girl-2/api/workstate', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.state) {
            window.__wgWorkState = d
            window.postMessage({ __wgWorkState: d }, '*')
          }
        })
        .catch(function () {})
    } catch (e) {}
  }
  pullWork()
  setInterval(pullWork, 5000)
  // 交互诊断回流：slots 挂件触发交互时 postMessage 事件，此处接收并上报宿主写日志
  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (d && d.__wgEvent) {
      try {
        fetch('/dsh-whale-girl-2/api/diag-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(d.__wgEvent)
        }).catch(function () {})
      } catch (err) {}
    }
  })
})()`
    // desktop：DSH Desktop 经 collectIndexInjections 用 index-inject
    ctx.on('webserver/index-inject', (table: any[]) => {
      const has = Array.isArray(table) && table.some(
        (row) => row && typeof row === 'object' && typeof row.text === 'string' && row.text.indexOf('__wgBridge') !== -1
      )
      if (!has) {
        diag('index-inject-called')
        table.push({ kind: 'script', placement: 'head', text: BRIDGE_JS })
      }
    })
    // web：web profile 无 index-inject 事件，用 apiServer.tapIndex 注入桥接脚本到 </head> 前（幂等）
    if (apiServer && typeof apiServer.tapIndex === 'function') {
      apiServer.tapIndex((html: string) => {
        if (html.indexOf('__wgBridge') !== -1) return html
        diag('tap-index-called')
        return html.replace('</head>', '<script>' + BRIDGE_JS + '</script></head>')
      })
    }
  }
}
