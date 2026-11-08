/**
 * 会话层：会话注册表、显式状态机、启动/关闭、空闲与关闭兜底、面板事件总线。
 *
 * 状态取值 idle | launching | ready | closing | closed；转移只走 nextSessionState 这一张表，
 * 转移函数不读全局 Map（参数全部传入），因此可以被纯函数测试覆盖。
 *
 * 进程回收三道兜底都在本文件：空闲回收（IDLE_CLOSE_MS）、关闭兜底（CLOSE_TIMEOUT_MS）、
 * 以及给 index.js 用的 closeAll / closeBySessionId。
 *
 * 依赖方向：本文件可以调用页面层与截图层，页面层不回指本文件（它接收 session 对象，
 * 广播事件走 session.emit）。
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import {
  addPage, createPage, DEFAULT_VIEWPORT, hasPendingTransientPage, isTransientPage, removePage, titleOf,
} from './page.js'
import { ensureArtifactsDir } from './capture.js'
import {
  assertBrowserRunning, assertCanCloseLastTab, assertCarrierNotHotSwitched, assertCdpContext,
  assertCdpHasPages, assertEndpointNotHotSwitched, assertLaunchSettled, assertModeNotHotSwitched,
  assertNotClosedDuringLaunch, assertSessionContext, assertTabExists,
} from './invariants.js'
import { isLoopbackHostname } from './fence.js'
import { PANEL_ERROR_CODES, panelTabId, parsePanelTabId } from './protocol.js'
import { DEFAULT_CDP_ENDPOINT } from './defaults.js'
import { CARRIERS, carrierLabel, DEFAULT_CARRIER, detectCarrier } from './carrier.js'
import { exportStorageState as writeStorageStateFile, loadStorageState, normalizeDomains } from './auth-state.js'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

/** 与系统 Edge 对应的 Playwright channel。 */
const BROWSER_CHANNEL = 'msedge'

/** key（agent.id）-> 会话状态 */
const sessions = new Map()

/** session.id（与 agent.id 同源）-> 会话 key，供 session/disposed 精确回收。 */
const keyBySessionId = new Map()

/**
 * 右侧面板的事件订阅者。
 *
 * 面板半区需要知道「浏览器开了/关了、页面导航了、标签页变了」才能刷新 tab 状态与投屏；
 * 这里只做进程内广播，不改变任何工具行为。回调异常一律吞掉，面板故障不能影响工具调用。
 * 页面层不改这里的事件总线，只通过 session.emit 触发。
 */
const panelListeners = new Set()

/**
 * 向面板订阅者广播一条事件。
 * @param {{type: 'opened'|'closed'|'changed', key: string}} event - 事件
 */
export function emitPanelEvent(event) {
  for (const listener of [...panelListeners]) {
    try {
      listener(event)
    } catch {
      // 面板侧的异常与工具无关，忽略
    }
  }
}

/**
 * 订阅面板事件。
 * @param {Function} listener - 订阅者
 * @returns {() => void} 取消订阅
 */
export function subscribePanelEvents(listener) {
  panelListeners.add(listener)
  return () => {
    panelListeners.delete(listener)
  }
}

/**
 * 空闲回收时限（毫秒）。
 *
 * 没有它，浏览器会一直挂到 DSH 服务重启：进程托管在 dsh web 上，对话结束、会话切走、
 * 子代理结束都不会回收，无头 Edge 会持续吃 CPU。设 0 可关闭该行为。
 */
export const IDLE_CLOSE_MS = Number(process.env.DSH_BROWSER_IDLE_MS ?? 600000)

/**
 * 关闭浏览器的等待上限（毫秒）。
 *
 * 系统 Edge 偶发在 graceful close 阶段卡住：进程已经退出，Playwright 却等不到退出事件，
 * browser.close() 会一直挂着。超过该时限不再等待，保证关闭路径一定有返回；Playwright 的
 * Browser 没有结束进程的接口（`process()` 只存在于 BrowserServer / ElectronApplication），
 * 所以超时只能如实报告「进程可能残留」，不能强杀。
 */
export const CLOSE_TIMEOUT_MS = Number(process.env.DSH_BROWSER_CLOSE_TIMEOUT_MS ?? 5000)

/** 会话状态全集。 */
export const SESSION_STATES = ['idle', 'launching', 'ready', 'closing', 'closed']

/**
 * 状态转移表。键是「当前状态 + 事件」，值是下一个状态；表里没有的组合一律非法。
 * 事件含义：
 * - launch：开始启动；launchSettled：启动成功且已有浏览器；launchFailed：启动失败
 * - close：开始关闭；closeSettled：浏览器已确实收掉
 */
const TRANSITIONS = {
  idle: { launch: 'launching', close: 'closed' },
  launching: { launchSettled: 'ready', launchFailed: 'idle', close: 'closing' },
  ready: { close: 'closing' },
  closing: { closeSettled: 'closed' },
  closed: {},
}

/**
 * 纯转移函数：state + 事件 -> 新 state；非法转移抛错。
 * 参数全部传入、不读全局 Map，供测试直接驱动。
 * @param {string} state - 当前状态
 * @param {string} event - 事件名
 * @returns {string} 新状态
 */
export function nextSessionState(state, event) {
  if (!SESSION_STATES.includes(state)) {
    throw new Error(`未知会话状态 ${state}`)
  }
  const next = TRANSITIONS[state][event]
  if (!next) {
    throw new Error(`非法会话状态转移：${state} --${event}--> ?`)
  }
  return next
}

/**
 * 会话是否处于不能再接受操作的收尾阶段。
 * @param {object} session - 会话状态
 * @returns {boolean}
 */
function isShuttingDown(session) {
  return session.state === 'closing' || session.state === 'closed'
}

/** 清理某个会话的空闲计时器（无计时器则不动）。 */
function clearIdleTimer(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
}

/**
 * 重置空闲计时器。每次工具调用都刷新，因此只有真正闲置到 IDLE_CLOSE_MS 才关。
 * launch 进行中与收尾阶段不装计时器：此时页还没建好 / 已在关闭，装上会把刚建好的
 * 实例当成闲置回收掉。
 * @param {object} session - 会话状态
 */
export function touchSession(session) {
  // 已被 close 摘除的会话不再计时：旧会话的计时器若按 key 触发，可能误关同 key 的新浏览器。
  if (!IDLE_CLOSE_MS || session.state === 'launching' || isShuttingDown(session)) return
  clearIdleTimer(session)
  session.idleTimer = setTimeout(() => {
    // 计时器只回收自己属于的那个会话，不碰同 key 后来新建的会话。
    if (sessions.get(session.key) === session) void close(session.key)
  }, IDLE_CLOSE_MS)
  // 不因浏览器待回收而拖住进程退出。
  session.idleTimer.unref?.()
}

/**
 * 取会话状态（不存在则创建）；同时登记 session.id 映射并刷新空闲计时。
 * @param {string} key - 会话 key
 * @param {string} [sessionId] - 会话 id
 * @param {{deferTouch?: boolean}} [options] - deferTouch：不在这里装空闲计时器，交给 launch
 * @returns {object} 会话状态
 */
export function sessionOf(key, sessionId, options = {}) {
  let session = sessions.get(key)
  if (!session) {
    session = {
      key,
      sessionId: sessionId ?? key,
      /** 显式状态；启动/关闭/空闲回收都读它，不再靠多个布尔字段交叉推断。 */
      state: 'idle',
      mode: 'isolated',
      /** 实际落地的浏览器载体：edge / chrome（auto 已解析成具体值）；CDP 固定按 edge 记录。 */
      carrier: DEFAULT_CARRIER,
      cdpEndpoint: undefined,
      browser: null,
      context: null,
      /** 本次启动导入的登录态来源与域名过滤（仅 isolated）；用于复用一致性校验与诊断。 */
      storageState: null,
      pages: new Map(),
      activeTabId: null,
      nextTabSeq: 1,
      viewport: null,
      /** 本次启动是否 headless（isolated 写启动值、cdp 写 false、未启动为 null）；人工等待用它判断能否给可见性提示。 */
      headless: null,
      artifactsDir: null,
      idleTimer: null,
      /** launch 进行中的落定 Promise；close 在启动过程中被调用时等它收尾。 */
      launchingPromise: null,
      /** 同一 key 的并发 launch 共用这一个落定 Promise：后到的调用等它，不另起浏览器。 */
      launchTask: null,
      /** 上一次关闭路径的 graceful close 是否超时；超时说明进程可能残留，close 要如实报告。 */
      closeTimedOut: false,
      /** 页面层广播面板事件用的入口（页面层不回指本文件）。 */
      emit: emitPanelEvent,
      hookedPages: new WeakSet(),
    }
    sessions.set(key, session)
  }
  // 页面层不改会话层：计时与事件广播都以函数形式挂在 session 上。
  session.touch = () => touchSession(session)
  // key 就是 agent.id，本身就是 SessionId；显式传入时以传入值为准。
  keyBySessionId.set(sessionId ?? key, key)
  if (sessionId !== undefined) session.sessionId = sessionId
  if (!options.deferTouch) touchSession(session)
  return session
}

/**
 * 取已启动的会话；没起过浏览器时报错，供只读类工具复用。
 * @param {string} key - 会话 key
 * @returns {object} 会话状态
 */
export function requireSession(key) {
  const session = sessions.get(key)
  assertBrowserRunning(session)
  return session
}

/** 复用浏览器时的摘要信息。 */
function reuseInfo(session) {
  const active = session.activeTabId === null ? null : session.pages.get(session.activeTabId)
  return {
    reused: true,
    mode: session.mode,
    carrier: session.carrier ?? DEFAULT_CARRIER,
    version: session.browser.version(),
    url: active?.page.url() ?? '',
    tabs: session.pages.size,
    summary: `浏览器已启动（${session.mode === 'cdp' ? 'CDP 接管' : '隔离'}模式，${carrierLabel(session.carrier)} ${session.browser.version()}，${session.pages.size} 个标签页）`,
  }
}

/**
 * 校验并归一 CDP 端点：必须 http、主机必须是 loopback。
 *
 * 导出供诊断（lib/doctor.js）复用同一条判据与三条错误原文，避免第二份实现。
 */
export function normalizeCdpEndpoint(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_CDP_ENDPOINT
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`cdpEndpoint 不是合法 URL：${text}`)
  }
  if (url.protocol !== 'http:') {
    throw new Error(`cdpEndpoint 只支持 http，收到 ${url.protocol}`)
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`cdpEndpoint 只允许 loopback 主机（localhost / 127.0.0.1 / ::1），收到 ${url.hostname}`)
  }
  return url.toString().replace(/\/$/, '')
}

/**
 * 归一载体入参：只认 edge / chrome / auto，其余按缺省 edge（非法值已在 launch 入口报错）。
 * @param {unknown} value - 请求的载体
 * @returns {'edge'|'chrome'|'auto'}
 */
function carrierOf(value) {
  return CARRIERS.includes(value) ? value : DEFAULT_CARRIER
}

/**
 * 复用分支的并发关闭检查：会话必须仍在注册表里，且不在收尾阶段。
 *
 * 违反后果：close 已摘除会话并报告「浏览器已关闭」，复用分支仍返回「已启动」，
 * 调用方拿到假成功后在已关闭的实例上继续调用工具。
 * @param {string} key - 会话 key
 * @param {object} session - 会话状态
 */
function assertReuseAlive(key, session) {
  if (sessions.get(key) !== session) {
    throw new Error('浏览器已关闭（复用与关闭并发），请重新调用 browser_e2e_start')
  }
  assertNotClosedDuringLaunch(session)
}

/** 已启动后再次传 storageState 的统一文案（不重建 context、不换 tab、不动 ref）。 */
function storageStateHotImportMessage(session) {
  const label = session.mode === 'cdp' ? 'CDP 接管' : 'isolated'
  return `浏览器已启动（${label}）；storageState 只在启动时生效，如需更换登录态请先 browser_e2e_close 再 browser_e2e_start`
}

/** 已启动时校验请求的 mode / cdpEndpoint / carrier / storageState 与当前会话是否一致；不一致直接报错，不静默复用。 */
function assertReuseCompatible(session, options) {
  if (options.mode !== undefined) {
    const wanted = options.mode === 'cdp' ? 'cdp' : 'isolated'
    assertModeNotHotSwitched(session.mode, wanted)
  }
  if (options.cdpEndpoint !== undefined) {
    const wantedEndpoint = normalizeCdpEndpoint(options.cdpEndpoint)
    const currentEndpoint = session.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT
    assertEndpointNotHotSwitched(currentEndpoint, wantedEndpoint)
  }
  // 载体只对隔离模式生效：CDP 的载体由接管端点决定，显式传 carrier 不参与一致性校验。
  if (options.carrier !== undefined && session.mode !== 'cdp') {
    const requested = carrierOf(options.carrier)
    // auto 也先解析成具体载体再比较，解析结果与当前不同即报错，不静默换浏览器。
    const wanted = requested === 'auto' ? detectCarrier('auto').kind : requested
    assertCarrierNotHotSwitched(session.carrier ?? DEFAULT_CARRIER, wanted)
  }
  // 登录态只在启动时导入：并发 start 带同一份 storageState 时按复用返回，其余一律拒绝热导入。
  if (options.storageState !== undefined) {
    const current = session.storageState
    const wantedDomains = normalizeDomains(options.storageDomains, 'storageDomains')
    const same = session.mode !== 'cdp' && current !== null && typeof options.storageState === 'string'
      && resolve(current.path) === resolve(options.storageState.trim())
      && JSON.stringify(current.domains ?? null) === JSON.stringify(wantedDomains)
    if (!same) throw new Error(storageStateHotImportMessage(session))
  }
}

/**
 * 关闭隔离模式的浏览器，返回 graceful close 是否超时。
 *
 * 超时后只能放弃等待：Playwright 的 Browser 不暴露进程句柄（`process()` 在 BrowserServer 上，
 * 不在 Browser 上），无法强制结束。调用方据此如实报告「进程可能残留」，不谎称已关闭进程。
 * @param {object} browser - Playwright Browser
 * @returns {Promise<{timedOut: boolean}>} timedOut 为 true 表示到上限仍未落定
 */
async function closeBrowser(browser) {
  if (!browser) return { timedOut: false }
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS)
    timer.unref?.()
  })
  const result = await Promise.race([
    browser.close().then(() => 'closed').catch(() => 'closed'),
    timeout,
  ])
  if (timer) clearTimeout(timer)
  return { timedOut: result === 'timeout' }
}

/** 关闭超时的统一文案：如实说明没有强杀，进程可能残留。 */
function closeTimeoutSummary() {
  return `浏览器关闭超时（${CLOSE_TIMEOUT_MS}ms 内 graceful close 未完成）：Playwright 不支持结束进程，浏览器进程可能仍在运行，请手动结束残留进程`
}

/**
 * 启动或接管浏览器（已启动且参数一致则复用）。
 *
 * defaults 是插件级配置给首次启动用的缺省值（mode / cdpEndpoint），只在还没有浏览器时参与；
 * 已启动时的一致性校验只看 options，避免配置默认值让已运行的会话报 mode 不一致。
 * @param {string} key - 会话 key
 * @param {object} [options] - 启动参数
 * @param {string} [sessionId] - 会话 id
 * @param {{mode?: string, cdpEndpoint?: string}} [defaults] - 插件级配置缺省值
 * @param {{chromium?: object}} [deps] - 测试用注入点：可传假的 chromium 实现，缺省用模块级的
 *   playwright-core.chromium；生产调用不需要传。
 * @returns {Promise<object>} 启动结果
 */
export async function launch(key, options = {}, sessionId, defaults = {}, deps = {}) {
  const chromiumImpl = deps.chromium ?? chromium
  // mode 非法值显式报错，不静默降级成 isolated（否则「切换模式」失败会被当成启动成功）。
  if (options.mode !== undefined && options.mode !== 'isolated' && options.mode !== 'cdp') {
    throw new Error(`mode 只支持 isolated / cdp，收到 ${JSON.stringify(options.mode)}`)
  }
  // carrier 同理：非法值在登记会话之前报错，不留下会话条目（与 mode 的既有校验同口径）。
  if (options.carrier !== undefined && !CARRIERS.includes(options.carrier)) {
    throw new Error(`carrier 只支持 edge / chrome / auto，收到 ${JSON.stringify(options.carrier)}`)
  }
  // 计时器由本函数接管：必须先把「启动中」立起来，再决定要不要装空闲计时器。
  const session = sessionOf(key, sessionId, { deferTouch: true })
  // 上一次清理超时的标记只对上一次关闭有效；本次启动重新计，避免旧标记污染后续 close 文案。
  session.closeTimedOut = false
  // 同一 key 已有启动在进行：等它落定后按复用返回，绝不并行拉起第二个浏览器。
  if (session.launchTask) {
    await session.launchTask.catch(() => {})
    assertNotClosedDuringLaunch(session)
    assertLaunchSettled(session)
    assertReuseCompatible(session, options)
    touchSession(session)
    return reuseInfo(session)
  }
  if (session.browser) {
    assertReuseCompatible(session, options)
    // 复用分支也有 await（补建标签页），因此同样要建立落定信号：并发 close 必须等它走完
    // 再关浏览器，并发 launch 必须等它落定，不能两个调用各自取页、各自补页。
    let settleReuse = () => {}
    session.launchingPromise = new Promise((resolve) => {
      settleReuse = resolve
    })
    let settleReuseTask = () => {}
    session.launchTask = new Promise((resolve) => {
      settleReuseTask = resolve
    })
    /** 收掉落定信号。必须先落定再让 close 进入：否则 close 等 launchingPromise、本分支等 close，互相卡死。 */
    const settleReuseBranch = () => {
      settleReuse()
      settleReuseTask()
      session.launchingPromise = null
      session.launchTask = null
    }
    try {
      // 浏览器在但一个标签页都没有：隔离模式补建一页后按复用返回；CDP 模式没有可接管的页，
      // 报可诊断错误，不能静默返回「已启动（0 个标签页）」让后续页面工具全部落空。
      if (session.pages.size === 0) {
        if (session.mode === 'cdp') {
          throw new Error('CDP 浏览器已没有打开的标签页，请在浏览器里新建标签页，或先 browser_e2e_close 再重新 browser_e2e_start')
        }
        try {
          const page = await createPage(session)
          // 补建页期间可能已被 close 摘除：这一页不能登记到已关闭的会话上。
          assertReuseAlive(key, session)
          const entry = addPage(session, page, 'created')
          // 旧 activeTabId 可能指向已经消失的页，补建后直接切到新页（addPage 只在 null 时设置）。
          session.activeTabId = entry.id
        } catch (error) {
          // 补建失败：先落定信号（否则 close 会一直等它），再自己收掉浏览器并把会话摘除，
          // 否则会停在 ready + 0 页，后续复用继续报「已启动（0 个标签页）」而页面工具报未启动。
          settleReuseBranch()
          await close(key)
          throw error
        }
      }
      // 返回成功前复查：会话仍在 registry 里且不在收尾，否则这次「复用成功」是假成功。
      assertReuseAlive(key, session)
      return reuseInfo(session)
    } finally {
      settleReuseBranch()
      // 复用期间被 close：close 在等落定信号，由本分支把 closing 收成 closed（与启动路径一致）。
      if (session.state === 'closing') session.state = nextSessionState('closing', 'closeSettled')
      touchSession(session)
    }
  }
  const mode = (options.mode ?? defaults.mode) === 'cdp' ? 'cdp' : 'isolated'
  // CDP 模式不导入登录态：接管的是用户自己的浏览器，其 cookie 由用户维护；在 connectOverCDP 之前拒绝。
  if (mode === 'cdp' && options.storageState !== undefined) {
    throw new Error('CDP 模式不导入登录态：接管的是用户自己的浏览器，其 cookie 由用户维护；请在 isolated 模式使用 storageState')
  }
  const headless = options.headless ?? true
  const proxy = options.proxy ?? process.env.DSH_BROWSER_PROXY ?? ''
  // 登录态文件在启动前同步读取并校验：文件非法时不拉起浏览器，也不留半初始化会话。
  const storage = mode === 'isolated' && options.storageState !== undefined
    ? loadStorageState(options.storageState, options.storageDomains)
    : null
  session.state = nextSessionState(session.state, 'launch')
  // 上一次（失败的）启动可能留下计时器；先清掉，启动期间不再计时。
  clearIdleTimer(session)
  let settleLaunch = () => {}
  session.launchingPromise = new Promise((resolve) => {
    settleLaunch = resolve
  })
  let settleTask = () => {}
  session.launchTask = new Promise((resolve) => {
    settleTask = resolve
  })
  /** 启动过程中若已被 close 摘除，立刻停下：否则会在已关闭的浏览器上继续 newPage。 */
  const ensureAlive = () => assertNotClosedDuringLaunch(session)
  /** 本次 launch 是否正常走完且留下了可操作的标签页；finally 用它决定落定与清理。 */
  let launched = false
  /** 是否已广播 opened：失败清理只对已广播过 opened 的会话补 closed，避免面板残留。 */
  let opened = false
  try {
    if (mode === 'cdp') {
      // 接管已有浏览器：不启动进程、不新建 page、不改视口；tab 列表取 context.pages()。
      const endpoint = normalizeCdpEndpoint(options.cdpEndpoint ?? defaults.cdpEndpoint)
      const browser = await chromiumImpl.connectOverCDP(endpoint)
      session.browser = browser
      session.mode = 'cdp'
      session.cdpEndpoint = endpoint
      // CDP 的载体由接管端点决定、产品名不可知：固定按 edge 记录，摘要维持「系统 Edge」。
      session.carrier = DEFAULT_CARRIER
      // CDP 接管按可见处理：不探测用户浏览器本身是否 headless。
      session.headless = false
      ensureAlive()
      const context = browser.contexts()[0]
      assertCdpContext(context)
      session.context = context
      const pages = context.pages()
      assertCdpHasPages(pages)
      for (const page of pages) addPage(session, page, 'adopted')
      session.activeTabId = session.pages.keys().next().value ?? null
      // 用户在真实浏览器里新开的标签页也纳入本会话（CDP 模式下 tab 列表以浏览器为准）。
      context.on('page', (page) => {
        // 本插件自己创建的抓取临时页不登记；用户新开的页照旧。
        // page 事件可能早于 newPage() 返回，建页期间的会话也要豁免。
        if (isTransientPage(page) || hasPendingTransientPage(session)) return
        for (const entry of session.pages.values()) {
          if (entry.page === page) return
        }
        addPage(session, page, 'adopted')
      })
      emitPanelEvent({ type: 'opened', key })
      opened = true
      const version = browser.version()
      launched = true
      return {
        reused: false,
        mode,
        endpoint,
        version,
        tabs: session.pages.size,
        summary: `接管 CDP 浏览器 ${endpoint}（${session.pages.size} 个标签页，系统 Edge ${version}）`,
      }
    }
    const requested = carrierOf(options.carrier ?? defaults.carrier)
    // 载体探测在 chromiumImpl.launch 之前同步完成：失败不留半初始化会话。
    const resolved = detectCarrier(requested)
    const browser = await chromiumImpl.launch({
      // edge 走 Playwright 的 msedge channel（与既有行为逐字一致）；chrome 用探测到的可执行文件。
      ...(resolved.kind === 'edge' ? { channel: BROWSER_CHANNEL } : { executablePath: resolved.executablePath }),
      headless,
      ignoreHTTPSErrors: true,
      ...(proxy ? { proxy: { server: proxy } } : {}),
    })
    session.browser = browser
    session.mode = 'isolated'
    session.carrier = resolved.kind
    session.headless = headless
    ensureAlive()
    session.viewport = {
      width: options.viewportWidth ?? DEFAULT_VIEWPORT.width,
      height: options.viewportHeight ?? DEFAULT_VIEWPORT.height,
    }
    // 隔离模式改为每会话一个显式 context：全部标签页共享 cookie / localStorage，
    // 登录态导入才能在会话级生效（功能规格 0021 方案 A）。不传 storageState 时形状与
    // browser.newPage({ viewport }) 等价。
    session.context = await browser.newContext({
      viewport: session.viewport,
      ...(storage ? { storageState: { cookies: storage.cookies, origins: storage.origins } } : {}),
    })
    ensureAlive()
    const page = await session.context.newPage()
    ensureAlive()
    addPage(session, page, 'created')
    // 只记录来源路径与域名过滤，不复制 cookie：供复用一致性与诊断使用。
    session.storageState = storage ? { path: storage.path, domains: storage.domains } : null
    emitPanelEvent({ type: 'opened', key })
    opened = true
    const version = browser.version()
    const artifactsDir = ensureArtifactsDir(session)
    launched = true
    return {
      reused: false,
      mode,
      headless,
      // channel 只在 edge 载体下有意义（chrome 走 executablePath，没有 Playwright channel）。
      ...(resolved.kind === 'edge' ? { channel: BROWSER_CHANNEL } : {}),
      carrier: resolved.kind,
      version,
      viewport: session.viewport,
      tabs: 1,
      artifactsDir,
      // 只在传了 storageState 时返回该字段；不传时返回形状与摘要逐字不变。
      ...(storage
        ? {
          storageState: {
            path: storage.path,
            cookies: storage.cookies.length,
            origins: storage.origins.length,
            domains: storage.domains,
          },
        }
        : {}),
      summary: `启动浏览器 ${carrierLabel(resolved.kind)} ${version}（headless=${headless}，视口 ${session.viewport.width}x${session.viewport.height}）`
        + (storage
          ? `，已导入 ${storage.cookies.length} 个 cookie、${storage.origins.length} 个 origin（${storage.domains.length} 个域名）`
          : ''),
    }
  } finally {
    // 启动中被 close：把可能已经建立的浏览器收掉，不留半初始化会话与孤儿进程。
    if (session.state === 'closing') {
      const browser = session.browser
      session.browser = null
      session.context = null
      if (browser) {
        // 清理按本次启动的目标模式走：隔离模式用 closeBrowser（超时只能如实记录，无法强杀）；
        // CDP 的 close 只断连，不动用户浏览器。用局部 mode 不依赖字段赋值时序。
        if (mode === 'cdp') await browser.close().catch(() => {})
        else ({ timedOut: session.closeTimedOut } = await closeBrowser(browser))
      }
      session.state = nextSessionState('closing', 'closeSettled')
    } else if (session.state === 'launching') {
      // 成功判据是「本次 launch 正常走完、浏览器在、至少有一个标签页」。浏览器已建立但后续
      // 步骤失败（隔离模式 newPage 抛错、CDP 没有 context / 标签页）时必须先清理再落定：
      // 否则会话会停在 ready + 0 页，复用分支报「已启动（0 个标签页）」而页面工具报未启动。
      if (!launched) {
        const browser = session.browser
        session.browser = null
        session.context = null
        session.pages.clear()
        session.activeTabId = null
        if (browser) {
          // 清理按本次启动的目标模式走，理由同上；超时标记留给下一次 close 如实报告。
          if (mode === 'cdp') await browser.close().catch(() => {})
          else ({ timedOut: session.closeTimedOut } = await closeBrowser(browser))
        }
        // 已广播过 opened 才补 closed：面板不能留下一个已经收掉的会话 tab。
        if (opened) emitPanelEvent({ type: 'closed', key })
      }
      // 清理期间有 await，可能被 close() 摘除并置为 closing：此时必须按关闭落定，
      // 不能按启动结果覆写，否则对象终态会变成 idle 而 close 已报告关闭。
      session.state = session.state === 'closing'
        ? nextSessionState('closing', 'closeSettled')
        : nextSessionState('launching', launched ? 'launchSettled' : 'launchFailed')
    }
    session.launchingPromise = null
    // 通知正在等待的 close：启动已落定，可以安全返回。
    settleLaunch()
    // 通知并发 launch：启动已落定，按结果复用或报错。
    session.launchTask = null
    settleTask()
    // 只有启动真正结束才开始计空闲；启动失败也复位，避免卡住回收。
    touchSession(session)
  }
}

/**
 * 关闭并清理该会话的浏览器。
 *
 * 隔离模式关闭自己拉起的 Edge；CDP 模式只断开连接，绝不结束用户的浏览器进程。
 * @param {string} key - 会话 key
 * @returns {Promise<object>} 关闭结果
 */
export async function close(key) {
  const session = sessions.get(key)
  if (!session) return { closed: false, summary: '浏览器未启动，无需关闭' }
  clearIdleTimer(session)
  // 先摘除会话状态，再等浏览器关闭：即使关闭卡住，会话也不会继续被引用。
  sessions.delete(key)
  for (const [sessionId, mapped] of keyBySessionId) {
    if (mapped === key) keyBySessionId.delete(sessionId)
  }
  const closing = nextSessionState(session.state, 'close')
  session.state = closing
  // 空闲态（还没起过浏览器）直接进入终态，没有浏览器可收；上一次清理若超时（进程可能残留），
  // 这里要如实带出来，不能因为「会话已不在注册表」就报干净的「浏览器已关闭」。
  if (closing === 'closed') {
    emitPanelEvent({ type: 'closed', key })
    if (session.closeTimedOut) {
      return { closed: true, mode: session.mode, timedOut: true, summary: closeTimeoutSummary() }
    }
    return { closed: true, mode: session.mode, summary: '浏览器已关闭' }
  }
  // launch 进行中：等它落定。launch 自己会收掉已建立的浏览器，close 不再插手，
  // 避免出现「close 关了浏览器、launch 又 newPage」的 Target ... has been closed。
  if (session.launchingPromise) {
    await session.launchingPromise.catch(() => {})
    emitPanelEvent({ type: 'closed', key })
    if (session.closeTimedOut) {
      return { closed: true, mode: session.mode, timedOut: true, summary: closeTimeoutSummary() }
    }
    return { closed: true, mode: session.mode, summary: '浏览器已关闭' }
  }
  let timedOut = false
  if (session.mode === 'cdp') {
    // connectOverCDP 得到的 browser.close() 只断开连接并清理本连接创建的 context，
    // 不会结束浏览器进程，也不会关掉用户的标签页。
    await session.browser?.close().catch(() => {})
  } else {
    ({ timedOut } = await closeBrowser(session.browser))
  }
  session.state = nextSessionState('closing', 'closeSettled')
  emitPanelEvent({ type: 'closed', key })
  if (timedOut) {
    return { closed: true, mode: 'isolated', timedOut: true, summary: closeTimeoutSummary() }
  }
  return session.mode === 'cdp'
    ? { closed: true, mode: 'cdp', summary: '已断开 CDP 连接（用户浏览器保持运行）' }
    : { closed: true, mode: 'isolated', summary: '浏览器已关闭' }
}

/**
 * 把当前会话的登录态导出到磁盘（`browser_e2e_auth_export` 的入口）。
 *
 * 只在 isolated 生效：CDP 接管的是用户自己的浏览器，导出等于把用户 cookie 复制到磁盘。
 * 导出路径与覆盖语义见 `lib/auth-state.js`；close / 空闲回收不会自动导出。
 * @param {string} key - 会话 key
 * @param {{path: string, domains?: string[], overwrite?: boolean}} [options] - 导出参数
 * @returns {Promise<object>} 导出结果（含 summary）
 */
export async function exportStorageState(key, options = {}) {
  const session = requireSession(key)
  if (session.mode === 'cdp') {
    throw new Error('CDP 模式不导出登录态：那会把用户浏览器的 cookie 写到磁盘；请在 isolated 模式导出')
  }
  assertSessionContext(session)
  return await writeStorageStateFile(session.context, options)
}

/**
 * 关闭指定标签页；最后一个标签页不允许关闭。
 * @param {string} key - 会话 key
 * @param {string} tabId - 标签页 id
 * @returns {Promise<object>} 关闭结果
 */
export async function closeTab(key, tabId) {
  const session = sessions.get(key)
  assertBrowserRunning(session)
  if (typeof tabId !== 'string' || tabId.length === 0) {
    throw new Error('缺少 tab_id，请先 browser_e2e_tabs 获取')
  }
  const tab = assertTabExists(session, tabId)
  try {
    assertCanCloseLastTab(session)
  } catch (error) {
    // 面板按 error.code 区分「最后一个标签页」与其它关闭失败，不做文案匹配。
    if (error instanceof Error) error.code = PANEL_ERROR_CODES.lastTab
    throw error
  }
  // 校验与摘除必须落在同一同步段：中间不 await，否则两个并发 closeTab 可能都通过
  // 「还有 >1 页」的检查，把会话关到 0 页。页已摘除后即使 close 失败也不回滚（该页已不可用）。
  removePage(session, tabId)
  await tab.page.close().catch(() => {})
  // 关页也要刷新空闲计时，否则紧接着可能被回收（会话本身还活着）。
  touchSession(session)
  return {
    tabId,
    remaining: session.pages.size,
    activeTabId: session.activeTabId,
    summary: `关闭标签页 ${tabId}（剩余 ${session.pages.size} 个，当前 ${session.activeTabId ?? '无'}）`,
  }
}

/**
 * 按 session.id 回收浏览器，供 `session/disposed` 钩子调用。
 *
 * 需要它是因为工具层用的是 `exec.agent.id`，而 dispose 事件只给 Session；两者同源，
 * 共用同一个 SessionId。
 * @param {string} sessionId - 被销毁会话的 id
 * @returns {Promise<{closed: boolean}>} 关掉了返回 closed=true
 */
export async function closeBySessionId(sessionId) {
  const key = keyBySessionId.get(sessionId)
  if (key === undefined) return { closed: false }
  return close(key)
}

/** 关闭全部会话（插件卸载时调用）。 */
export async function closeAll() {
  for (const key of [...sessions.keys()]) await close(key)
}

/** 当前持有浏览器状态的会话 key（供测试与诊断用，不改变任何状态）。 */
export function activeSessionKeys() {
  return [...sessions.keys()]
}

/**
 * 注册表的只读视图：本会话的状态快照（供诊断用）。
 *
 * 不创建会话、不刷新空闲计时、不探测浏览器：诊断不能给浏览器续命，也不能因为
 * 被诊断对象坏了就抛错。没有该 key 时返回 null。
 * @param {string} key - 会话 key
 * @returns {{state: string, mode: string, endpoint: string|undefined, pages: number,
 *   activeTabId: string|null, connected: boolean, artifactsDir: string|null} | null}
 */
export function peekSession(key) {
  const session = sessions.get(key)
  if (!session) return null
  return {
    state: session.state,
    mode: session.mode,
    endpoint: session.cdpEndpoint,
    pages: session.pages.size,
    activeTabId: session.activeTabId,
    connected: session.browser?.isConnected?.() ?? false,
    artifactsDir: session.artifactsDir,
  }
}

/**
 * 列出本会话的标签页（工具 browser_e2e_tabs 用）。
 * @param {string} key - 会话 key
 * @returns {Promise<object>} 标签页列表
 */
export async function tabs(key) {
  const session = requireSession(key)
  touchSession(session)
  const list = []
  for (const tab of session.pages.values()) {
    list.push({
      tab_id: tab.id,
      url: tab.page.url(),
      title: await titleOf(tab.page),
      active: tab.id === session.activeTabId,
      loading: tab.loading !== false,
      origin: tab.origin,
    })
  }
  const lines = list.map((tab) => `${tab.active ? '*' : ' '} ${tab.tab_id}  ${tab.title || '(无标题)'}`
    + `  ${tab.loading ? '加载中' : '已加载'}  ${tab.origin}  ${tab.url}`)
  return {
    mode: session.mode,
    tabs: list,
    activeTabId: session.activeTabId,
    text: lines.join('\n'),
    summary: `共 ${list.length} 个标签页，当前 ${session.activeTabId ?? '无'}`,
  }
}

/**
 * 面板半区取页面的只读入口（参数是 panelTabId 组合 id）。
 *
 * 只返回已经存在的页面，绝不启动浏览器：面板是视图，启动仍然只能由工具调用触发。
 * @param {string} panelId - 面板 tab id（`会话key#tab_id`）
 * @returns {import('playwright-core').Page | null}
 */
export function panelPage(panelId) {
  const parsed = parsePanelTabId(panelId)
  if (parsed === null) return null
  return sessions.get(parsed.key)?.pages.get(parsed.tabId)?.page ?? null
}

/**
 * 列出所有会话的所有标签页，供面板 tab 条使用。
 * mode / endpoint 跟随所属会话：CDP 接管时 endpoint 是实际接管的端点，隔离模式为空串。
 * @returns {Promise<Array<object>>} 面板 tab 列表
 */
export async function listPanelTabs() {
  const list = []
  for (const [key, session] of sessions) {
    const mode = session.mode === 'cdp' ? 'cdp' : 'isolated'
    const endpoint = mode === 'cdp' ? (session.cdpEndpoint ?? '') : ''
    for (const tab of session.pages.values()) {
      list.push({
        id: panelTabId(key, tab.id),
        sessionId: session.sessionId ?? key,
        url: tab.page.url(),
        title: await titleOf(tab.page),
        loading: tab.loading !== false,
        origin: tab.origin,
        mode,
        endpoint,
      })
    }
  }
  return list
}

