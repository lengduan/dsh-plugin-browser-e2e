/**
 * 右侧实时浏览器面板的宿主半区。
 *
 * 职责三件：
 * 1. 维护面板协议 v1 的 WebSocket（/api/dsh-browser-e2e/socket）与只读状态路由
 *    （/api/dsh-browser-e2e/state），两条都做 loopback 围栏；
 * 2. 把「哪些会话开着浏览器」推成 tab 状态，把当前 tab 的变化经 CDP 投屏成 JPEG 帧；
 * 3. 把工具动作摘要广播给面板（tab 条旁边的动作提示）。
 *
 * 面板只是视图：它不启动浏览器、不改页面，所有操作仍然只能由 browser_* 工具发起。
 * 协议版本不匹配时关闭连接，未知命令回错误事件而不是静默丢弃。面板协议命令：
 * attach / select-tab / close-tab / request-frame / configure。
 */
import { WebSocket, WebSocketServer } from 'ws'
import { isLoopbackRequest, writeJson } from './fence.js'
import { closeTab, listPanelTabs, panelPage, subscribePanelEvents } from './session.js'
import { captureJpeg } from './capture.js'
import { Screencast } from './screencast.js'
import {
  DEFAULT_SCREENCAST_CONFIG, PANEL_COMMANDS, PANEL_CONFIG_LIMITS, PANEL_EVENTS,
  PANEL_PROTOCOL_MISMATCH_CLOSE_CODE as PROTOCOL_MISMATCH_CLOSE_CODE, PANEL_PROTOCOL_VERSION,
  PANEL_SOCKET_PATH, PANEL_STATE_PATH, isSupportedProtocol, parsePanelTabId,
} from './protocol.js'

/** 状态推送的合并窗口：导航一次会连发多个事件，合并成一次推送。 */
const STATE_DEBOUNCE_MS = 50

/**
 * 校验并合并一组设置。
 * @param {unknown} patch - 客户端发来的 config 片段
 * @param {typeof DEFAULT_SCREENCAST_CONFIG} current - 当前设置
 * @returns {typeof DEFAULT_SCREENCAST_CONFIG} 合并后的新设置
 * @throws 字段非法时抛错，消息直接给用户看
 */
export function mergeConfig(patch, current) {
  if (patch === null || typeof patch !== 'object') {
    throw new Error('config 必须是对象')
  }
  const next = { ...current }
  for (const [field, [min, max]] of Object.entries(PANEL_CONFIG_LIMITS)) {
    const value = patch[field]
    if (value === undefined) continue
    const num = Number(value)
    if (!Number.isInteger(num) || num < min || num > max) {
      throw new Error(`${field} 必须是 ${min}-${max} 的整数，收到 ${value}`)
    }
    next[field] = num
  }
  return next
}

/**
 * 把插件级配置或设置片段整理成一份完整投屏设置。
 *
 * 与 mergeConfig 共用 PANEL_CONFIG_LIMITS 的区间口径，区别在失败策略：socket 里的
 * configure 由用户当场操作，越界要回错误；插件配置来自宿主 profile（可能被手改成
 * 脏值），逐字段回退 DEFAULT_SCREENCAST_CONFIG，不让一处脏值把面板整个卡死。
 * @param {unknown} source - 待整理的部分设置
 * @returns {typeof DEFAULT_SCREENCAST_CONFIG} 完整设置
 */
export function initialConfigOf(source) {
  const next = { ...DEFAULT_SCREENCAST_CONFIG }
  if (source === null || typeof source !== 'object') return next
  for (const [field, [min, max]] of Object.entries(PANEL_CONFIG_LIMITS)) {
    const value = source[field]
    if (value === undefined || value === null) continue
    const num = Number(value)
    if (!Number.isInteger(num) || num < min || num > max) continue
    next[field] = num
  }
  return next
}

/**
 * 面板宿主：连接集合、tab 状态、投屏与设置。
 */
export class PanelHub {
  /**
   * @param {{config?: unknown}} [options] - 初始投屏设置（来自插件级 Config）
   */
  constructor(options = {}) {
    /** @type {Set<{send: (event: object) => void, sessionId?: string}>} 已连接的客户端 */
    this.clients = new Set()
    /** 投屏设置：插件级配置给初值，面板 configure 在进程内继续调整（不落盘）。 */
    this.config = initialConfigOf(options?.config)
    /** 当前选中的 tab（会话 key）。 */
    this.activeTabId = null
    /** 用户是否手动选过 tab：手动选择后 attach 不再按自己的会话改选。 */
    this.activeTabPinned = false
    /** @type {NodeJS.Timeout | null} */
    this.timer = null
    /** @type {Promise<object> | null} 状态同步的串行化句柄 */
    this.syncing = null
    /** 每个 tab 的帧序号，单调递增；客户端按它丢弃旧帧。 */
    this.frameSeq = new Map()
    /** 命令串行队列：同一条连接上的命令按到达顺序逐个处理，前一个失败不影响后续。 */
    this.commandQueue = Promise.resolve()
    this.disposed = false
    this.screencast = new Screencast({
      onFrame: (frame) => this.pushFrame(frame),
      onError: (code, error) => this.reportError(code, error),
    })
    this.wss = new WebSocketServer({ noServer: true })
    this.unsubscribe = subscribePanelEvents(() => this.scheduleSync())
  }

  /**
   * 把一条命令排进串行队列。
   * @param {() => Promise<unknown>} task - 待执行任务
   * @returns {Promise<unknown>} 该任务的执行结果
   */
  enqueue(task) {
    const run = this.commandQueue.then(task, task)
    this.commandQueue = run.then(() => {}, () => {})
    return run
  }

  /** 资源清理：断开所有客户端与浏览器投屏。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const sink of this.clients) {
      try {
        sink.close?.()
      } catch {
        // 连接可能已经断掉，忽略
      }
    }
    this.clients.clear()
    this.wss.close()
    void this.screencast.stop()
  }

  /**
   * 组装当前状态（tab 条、活动 tab、运行模式与设置）。
   * @param {string} [sessionId] - 请求方的会话 id，用于首次选中自己的浏览器
   * @returns {Promise<object>} 面板状态
   */
  async state(sessionId) {
    const tabs = await listPanelTabs()
    if (this.activeTabId !== null && !tabs.some((tab) => tab.id === this.activeTabId)) {
      this.activeTabId = null
      this.activeTabPinned = false
    }
    if (tabs.length > 0 && this.activeTabId === null) {
      this.activeTabId = this.pickTab(tabs, sessionId)
    } else if (tabs.length > 0 && !this.activeTabPinned && typeof sessionId === 'string') {
      // 还没有人手动选过 tab：新连接按自己的会话重新默认选中。
      this.activeTabId = this.pickTab(tabs, sessionId)
    }
    // 运行模式与端点跟随当前选中的 tab：session.js 的 listPanelTabs 提供
    // mode / endpoint 时透传，缺失时按隔离模式回退（端点为空串）。
    const active = tabs.find((tab) => tab.id === this.activeTabId) ?? null
    const cdp = active?.mode === 'cdp'
    return {
      tabs,
      activeTabId: this.activeTabId,
      running: tabs.length > 0,
      mode: cdp ? 'cdp' : 'isolated',
      endpoint: cdp ? String(active?.endpoint ?? '') : '',
      config: { ...this.config },
    }
  }

  /**
   * 选一个默认 tab：优先当前连接自己的会话的浏览器，其次列表第一个。
   * @param {Array<{id: string, sessionId: string}>} tabs - 可用 tab
   * @param {string} [sessionId] - 发起 attach 的连接所属会话
   * @returns {string | null}
   */
  pickTab(tabs, sessionId) {
    if (typeof sessionId === 'string') {
      const own = tabs.find((tab) => tab.sessionId === sessionId)
      if (own) return own.id
    }
    return tabs[0]?.id ?? null
  }

  /** 广播一条事件给所有面板。 */
  broadcast(event) {
    for (const sink of [...this.clients]) {
      try {
        sink.send(event)
      } catch {
        // 单个连接发送失败不影响其它面板
      }
    }
  }

  /** 广播当前状态（先同步投屏目标，保证状态与画面一致）。 */
  async broadcastState() {
    const state = await this.state()
    await this.ensureScreencast(state.activeTabId)
    this.broadcast({ v: PANEL_PROTOCOL_VERSION, kind: PANEL_EVENTS.state, state })
    return state
  }

  /** 合并窗口内的状态变化：导航一次会连发 load / domcontentloaded / framenavigated。 */
  scheduleSync() {
    if (this.disposed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sync()
    }, STATE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** 串行执行一次状态同步（并发调用共享同一个 Promise，避免投屏被并发启停）。 */
  sync() {
    if (this.syncing) return this.syncing
    this.syncing = this.broadcastState()
      .catch((error) => this.reportError('state-failed', error))
      .finally(() => {
        this.syncing = null
      })
    return this.syncing
  }

  /**
   * 让投屏目标与 activeTab 一致。
   * @param {string | null} target - 期望投屏的 tab
   */
  async ensureScreencast(target) {
    if (target === null) {
      await this.screencast.stop()
      return
    }
    // 同一个 key 也可能换了页面（关闭后重开），页面对象不一致就重投。
    const page = panelPage(target)
    const samePage = this.screencast.tabId === target && this.screencast.page === page
    if (samePage) return
    await this.screencast.start(target, page, this.config)
  }

  /** 重新开投（设置变化时用）。 */
  async restartScreencast() {
    await this.screencast.stop()
    await this.ensureScreencast(this.activeTabId)
  }

  /**
   * 宿主侧同步入口：用插件级配置重算投屏设置并让运行中的面板立即看到。
   *
   * 设置页保存即时字段后宿主不重载插件，lib/index.js 的 loader/volatile-update
   * 监听就是调这里。未提供的字段回退默认（插件配置是完整快照，避免上一轮残留）；
   * 非法字段回退默认而不是抛错。设置没变化时直接返回，不重开投屏。
   * @param {unknown} config - 插件级配置里的投屏参数
   * @returns {Promise<typeof DEFAULT_SCREENCAST_CONFIG>} 当前设置
   */
  async applyConfig(config) {
    const next = initialConfigOf(config)
    if (this.disposed) {
      this.config = next
      return { ...next }
    }
    if (JSON.stringify(next) === JSON.stringify(this.config)) return { ...next }
    this.config = next
    try {
      // 先按新参数重开投屏，再广播状态：面板拿到的 state.config 与画面一致。
      await this.restartScreencast()
      await this.broadcastState()
    } catch (error) {
      this.reportError('config-sync-failed', error)
    }
    return { ...this.config }
  }

  /**
   * 分配帧号并广播一帧。
   * @param {{tabId: string, width: number, height: number, data: string}} frame - 投屏帧
   */
  pushFrame(frame) {
    const seq = (this.frameSeq.get(frame.tabId) ?? 0) + 1
    this.frameSeq.set(frame.tabId, seq)
    this.broadcast({
      v: PANEL_PROTOCOL_VERSION,
      kind: PANEL_EVENTS.frame,
      tabId: frame.tabId,
      seq,
      width: frame.width,
      height: frame.height,
      data: frame.data,
    })
  }

  /**
   * 广播一次工具动作（tab 条上的动作提示）。
   * @param {string} tool - 工具名
   * @param {string} summary - 一句话摘要
   */
  broadcastAction(tool, summary) {
    this.broadcast({
      v: PANEL_PROTOCOL_VERSION,
      kind: PANEL_EVENTS.action,
      trace: { tool, summary: String(summary ?? ''), at: Date.now() },
    })
  }

  /** 向面板报一个可读错误。 */
  reportError(code, error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
    this.broadcast({ v: PANEL_PROTOCOL_VERSION, kind: PANEL_EVENTS.error, code, message })
  }

  /**
   * 处理一个已连接的面板命令。
   * @param {{send: Function, sessionId?: string}} sink - 该连接
   * @param {unknown} value - 解析后的命令
   * @param {boolean} first - 是否是该连接的第一帧
   * @returns {Promise<'accept'|'close'>} 后续动作
   */
  async handleCommand(sink, value, first) {
    if (value === null || typeof value !== 'object') {
      this.sendError(sink, 'invalid-payload', 'expected a JSON object')
      return first ? 'close' : 'accept'
    }
    if (!isSupportedProtocol(value.v)) {
      this.sendError(
        sink,
        'protocol-mismatch',
        `unsupported protocol version ${String(value.v)}; this host speaks version ${PANEL_PROTOCOL_VERSION}`,
      )
      return first ? 'close' : 'accept'
    }
    switch (value.kind) {
      case PANEL_COMMANDS.attach: {
        // 会话 id 只属于这条连接：多个会话同时打开面板时互不覆盖。
        sink.sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined
        const state = await this.state(sink.sessionId)
        await this.ensureScreencast(state.activeTabId)
        sink.send({ v: PANEL_PROTOCOL_VERSION, kind: PANEL_EVENTS.hello, state })
        return 'accept'
      }
      case PANEL_COMMANDS.selectTab: {
        const tabId = typeof value.tabId === 'string' ? value.tabId : null
        const tabs = await listPanelTabs()
        if (tabId === null || !tabs.some((tab) => tab.id === tabId)) {
          this.sendError(sink, 'unknown-tab', `no such tab: ${String(value.tabId)}`)
          return 'accept'
        }
        this.activeTabId = tabId
        this.activeTabPinned = true
        await this.broadcastState()
        return 'accept'
      }
      case PANEL_COMMANDS.closeTab: {
        const tabId = typeof value.tabId === 'string' ? value.tabId : null
        const tabs = await listPanelTabs()
        if (tabId === null || !tabs.some((tab) => tab.id === tabId)) {
          this.sendError(sink, 'unknown-tab', `no such tab: ${String(value.tabId)}`)
          return 'accept'
        }
        const parsed = parsePanelTabId(tabId)
        if (parsed === null) {
          this.sendError(sink, 'unknown-tab', `no such tab: ${tabId}`)
          return 'accept'
        }
        // 判据按目标 tab 所属会话：别的会话还有页时，本会话的最后一个页也不许关。
        const sameSessionTabs = tabs.filter((tab) => parsePanelTabId(tab.id)?.key === parsed.key)
        if (sameSessionTabs.length <= 1) {
          this.sendError(sink, 'last-tab', '最后一个标签页不能关闭')
          return 'accept'
        }
        try {
          await closeTab(parsed.key, parsed.tabId)
        } catch (error) {
          const code = error?.code === 'last-tab' ? 'last-tab' : 'close-tab-failed'
          this.sendError(sink, code, error instanceof Error ? error.message : String(error))
          return 'accept'
        }
        // 关掉的是当前 tab 时回到自动选择，否则保留用户手动选择。
        if (this.activeTabId === tabId) {
          this.activeTabId = null
          this.activeTabPinned = false
        }
        await this.broadcastState()
        return 'accept'
      }
      case PANEL_COMMANDS.requestFrame: {
        if (this.activeTabId === null) {
          this.sendError(sink, 'no-active-tab', '没有可刷新的画面：当前没有打开的浏览器')
          return 'accept'
        }
        try {
          const frame = await captureJpeg(panelPage(this.activeTabId), { quality: this.config.quality })
          if (frame) this.pushFrame({ tabId: this.activeTabId, ...frame })
        } catch (error) {
          this.reportError('capture-failed', error)
        }
        return 'accept'
      }
      case PANEL_COMMANDS.configure: {
        try {
          this.config = mergeConfig(value.config, this.config)
        } catch (error) {
          this.sendError(sink, 'invalid-config', error instanceof Error ? error.message : String(error))
          return 'accept'
        }
        await this.broadcastState()
        await this.restartScreencast()
        return 'accept'
      }
      default:
        // 未知命令：协议表里没有的 kind 一律回错误事件，不静默丢弃。
        this.sendError(sink, 'invalid-command', `unsupported command ${String(value.kind)}`)
        return 'accept'
    }
  }

  /** 只回给一个连接的错误事件。 */
  sendError(sink, code, message) {
    sink.send({ v: PANEL_PROTOCOL_VERSION, kind: PANEL_EVENTS.error, code, message })
  }

  /**
   * 解析并处理一条原始 WebSocket 帧（字符串形式）。
   * @param {{send: Function}} sink - 该连接
   * @param {string} raw - 原始帧
   * @param {boolean} first - 是否第一帧
   * @returns {Promise<'accept'|'close'>}
   */
  async handleRawFrame(sink, raw, first) {
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      this.sendError(sink, 'invalid-payload', 'expected JSON')
      return first ? 'close' : 'accept'
    }
    return this.handleCommand(sink, value, first)
  }

  /**
   * 构建路由族：状态路由 + socket 升级处理。
   * @returns {{routes: Array<object>, upgrade: object}}
   */
  routes() {
    const stateRoute = {
      kind: 'exact',
      path: PANEL_STATE_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        try {
          writeJson(res, 200, { state: await this.state() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    const upgrade = {
      path: PANEL_SOCKET_PATH,
      handler: (req, socket, head) => {
        // 非 loopback 在升级之前就拒绝，行为与 state 路由一致。
        if (!isLoopbackRequest(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
      },
    }
    return { routes: [stateRoute], upgrade }
  }

  /**
   * 接受一条已升级的 WebSocket。
   * @param {import('ws').WebSocket} ws - 升级后的连接
   */
  accept(ws) {
    const sink = {
      send: (event) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
      },
      close: () => {
        try {
          ws.close(1000)
        } catch {
          // 已关闭
        }
      },
    }
    this.clients.add(sink)
    let first = true
    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString()
      // first 在调度时确定并置 false：队列里前一条命令先处理，后到帧不再被当成首帧。
      const isFirst = first
      first = false
      void this.enqueue(() => this.handleRawFrame(sink, raw, isFirst))
        .then((next) => {
          if (next === 'close') {
            try {
              ws.close(PROTOCOL_MISMATCH_CLOSE_CODE)
            } catch {
              // 已关闭
            }
          }
        })
        .catch((error) => this.reportError('command-failed', error))
    })
    const drop = () => {
      this.clients.delete(sink)
    }
    ws.on('close', drop)
    ws.on('error', drop)
    // 客户端 attach 之前也先推一次状态，面板不用等命令往返就能画 tab 条。
    this.scheduleSync()
  }
}
