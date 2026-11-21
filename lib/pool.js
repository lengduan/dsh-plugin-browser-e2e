/**
 * 浏览器实例池：多会话共享同一个无头浏览器进程，各自持有一个隔离 context。
 *
 * 为什么要池化：每个会话各起一个浏览器时，实测 4 个实例 = 35 个进程 / 1940 MB / 空闲 6.7% 单核；
 * 1 个实例 + 4 个隔离 context = 12 个进程 / 748 MB / 空闲 0.5%。省的是进程数与内存，
 * CPU 那一半由 `freezeAnimations`（功能规格 0040）负责，两者正交。
 *
 * 本模块只管「浏览器进程的申请与释放」，不认识会话、不认识标签页、不碰页面能力：
 * 会话层在 launch 时 `acquire`、在最后一份 context 关掉后 `release`。
 * 依赖方向：session.js → pool.js，pool.js 不回指任何上层模块。
 *
 * 为什么按「启动签名」分槽：`browser_e2e_start` 的 headless / proxy / carrier 是逐次调用参数，
 * 不同会话合法地可以要求不同形态的浏览器（例如一个 headless 一个可见、或 edge 与 chrome 并存）。
 * 同签名的会话共享一个浏览器进程（这才是池化的收益），不同签名各占一个槽，互不复用也不互相报错。
 */
import { createRequire } from 'node:module'

import {
  ensureLocalStateSeed, OS_PASSWORD_LAST_CHANGED_SENTINEL, readOsPasswordLastChanged, resolveSlotProfileDir,
} from './browser-profile.js'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

/** 与系统 Edge 对应的 Playwright channel（与 session.js 同值；此处自带一份避免反向依赖）。 */
export const BROWSER_CHANNEL = 'msedge'

/**
 * 池级空闲回收时限（毫秒）：某个槽的租约归零后，再过这么久关掉那个共享浏览器。
 *
 * 比会话级 IDLE_CLOSE_MS（10 分钟）短：context 都空了说明这一轮用完，
 * 留一个空转的浏览器没有意义；但不设 0，避免「关一次立刻再开」的抖动。
 */
export const POOL_IDLE_CLOSE_MS = Number(process.env.DSH_BROWSER_POOL_IDLE_MS ?? 120000)

/** 单槽状态机：empty（没有浏览器）/ launching（正在拉）/ ready（可分配 context）/ closing（正在关）。 */
const SLOT_STATES = ['empty', 'launching', 'ready', 'closing']

/**
 * 共享浏览器意外断开（崩溃 / 被外部关闭）的订阅者。
 *
 * 池化后一个浏览器崩了会影响所有会话，所以会话层必须能收到通知，把所有持有该浏览器的
 * 会话一并收掉，而不是留一堆「以为还活着」的 session（计划风险 R1）。
 */
const goneListeners = new Set()

/**
 * 订阅「共享浏览器已断开」事件。
 * @param {(browser: object) => void} listener - 订阅者；参数是已断开的那一个浏览器
 * @returns {() => void} 取消订阅
 */
export function onBrowserGone(listener) {
  goneListeners.add(listener)
  return () => {
    goneListeners.delete(listener)
  }
}

/** 主动关闭中的槽签名集合：主动关闭不是「意外断开」，不广播。 */
const closingSlots = new Set()

/** 广播浏览器断开。订阅者异常一律吞掉，回收路径不能被订阅者带崩。 */
function emitBrowserGone(browser) {
  for (const listener of [...goneListeners]) {
    try {
      listener(browser)
    } catch {
      // 订阅者的异常与会话无关，忽略
    }
  }
}

/**
 * 进程级单例池：按启动签名分槽，每个槽一个浏览器进程。字段全部私有，
 * 只经本模块导出的函数读写，避免各模块各存一份导致「有的看到浏览器在、有的看到不在」。
 */
const slots = new Map()

/** 累计真正拉起过的浏览器次数（所有槽合计），供诊断与测试观察复用是否生效。 */
let launchCount = 0

/**
 * 归一启动签名：只有会改变浏览器进程形态的字段参与，视口与登录态属于 context 级、不进签名。
 * @param {object} options - acquire 的启动配置
 * @returns {string} 可比较的签名字符串
 */
export function signatureOf(options = {}) {
  const carrier = options.carrier ?? ''
  const channel = options.channel ?? (carrier === 'edge' || carrier === '' ? BROWSER_CHANNEL : '')
  return JSON.stringify({
    headless: options.headless !== false,
    proxy: options.proxy ?? '',
    channel,
    executablePath: options.executablePath ?? '',
    userDataDir: options.userDataDir ?? '',
  })
}

/** 取（必要时新建）该签名对应的槽。 */
function slotOf(signature) {
  let slot = slots.get(signature)
  if (!slot) {
    slot = {
      signature,
      state: 'empty',
      /** Playwright Browser 实例；state=ready 时非空。 */
      browser: null,
      /** 正在进行的启动 Promise：并发 acquire 共用它，不重复拉浏览器。 */
      launchTask: null,
      /** 当前借出的 context 数：归零后开始该槽的池级空闲计时。 */
      leases: 0,
      /** 槽级空闲计时器句柄。 */
      idleTimer: null,
      /** 该槽的启动配置。 */
      options: null,
    }
    slots.set(signature, slot)
  }
  return slot
}

/** 把槽状态切到下一个；非法转移直接抛错，避免状态机被绕开。 */
function transition(slot, next) {
  if (!SLOT_STATES.includes(next)) throw new Error(`池状态非法：${JSON.stringify(next)}`)
  slot.state = next
}

/** 清掉某个槽的空闲计时器。 */
function clearSlotIdleTimer(slot) {
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer)
    slot.idleTimer = null
  }
}

/**
 * 给槽装空闲计时器：到点仍没人租用就关掉该槽的浏览器。
 * 计时器 unref，不阻止宿主进程退出（与 session.js 的空闲计时同口径）。
 */
function armSlotIdleTimer(slot) {
  clearSlotIdleTimer(slot)
  if (!POOL_IDLE_CLOSE_MS || POOL_IDLE_CLOSE_MS <= 0) return
  slot.idleTimer = setTimeout(() => {
    slot.idleTimer = null
    if (slot.leases === 0) void shutdownSlot(slot, '空闲回收')
  }, POOL_IDLE_CLOSE_MS)
  slot.idleTimer.unref?.()
}

/**
 * 申请一份浏览器使用权：该签名下没有浏览器就拉起，有就复用。
 *
 * 并发调用共用同一个 launchTask：两个会话同时 start 只会拉起一个浏览器进程。
 * @param {{headless?: boolean, proxy?: string, carrier?: string, channel?: string,
 *   executablePath?: string, userDataDir?: string, launchImpl?: Function}} [options] - 启动配置；
 *   launchImpl 供测试注入假实现，收到的是整理好的 Playwright 启动参数
 * @returns {Promise<{browser: object, reused: boolean, launchCount: number, signature: string}>}
 *   共享浏览器、是否复用、累计拉起次数与本次租约所属的签名
 */
export async function acquire(options = {}) {
  const signature = signatureOf(options)
  const slot = slotOf(signature)
  // 已经在启动中：等它落定后按复用返回，绝不并行拉第二个。
  // 注意这里拿到的是 launchImpl 的**原始返回值**（生产环境是 launchPersistentContext 的
  // BrowserContext，没有 newContext / version），必须与 :170 的常规复用分支归一成同一种形态，
  // 否则并发第二个会话会在 session.js 的 browser.newContext() 上直接抛错。
  if (slot.launchTask) {
    const launched = await slot.launchTask
    const browser = typeof launched?.browser === 'function' ? launched.browser() : launched
    slot.leases += 1
    clearSlotIdleTimer(slot)
    return { browser, reused: true, launchCount, signature }
  }
  if (slot.browser && slot.state === 'ready') {
    slot.leases += 1
    clearSlotIdleTimer(slot)
    return { browser: slot.browser, reused: true, launchCount, signature }
  }
  transition(slot, 'launching')
  const launchImpl = options.launchImpl ?? ((config) => chromium.launchPersistentContext(config.userDataDir, config))
  // 每个签名一个 profile 子目录：Chromium 独占 user-data-dir，同目录第二个实例必然起不来。
  const profileDir = options.userDataDir ?? resolveSlotProfileDir(signature)
  // carrier='edge' 等价于 channel='msedge'（与 session.js 的既有装配一致）：只在传了 carrier 没传 channel 时推导，
  // 否则 Playwright 会退回它自带的 chromium，而本机通常只装了 Edge。
  const channel = options.channel
    ?? (options.carrier === 'edge' ? BROWSER_CHANNEL : undefined)
  const config = {
    ...(channel ? { channel } : {}),
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    headless: options.headless !== false,
    ignoreHTTPSErrors: true,
    ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
    // 固定 profile 目录：Chromium 把「已探测过系统密码」记在这里的 Local State，
    // 目录常驻 → 每次池生命周期最多只触发一次 4625（决策 D13、功能规格 0042）。
    userDataDir: profileDir,
    // 我们要额外关掉的自动填入身份验证探测；与 Playwright 默认 15 项拼成单一开关（见 mergeDisabledFeatures）。
    ...(options.disableFeatures ? { args: [`--disable-features=${mergeDisabledFeatures(options.disableFeatures)}`] } : {}),
  }
  // 并发合流必须在**第一次 await 之前**就把 launchTask 赋值：否则并发的第二个 acquire 看到
  // launchTask 仍为 null（第一个还卡在预热里），会各自拉起一个浏览器（实测拉起 2 次）。
  // 预热（预置 Local State + 锁屏闸门）是异步的，所以只能放进这个 task 里面。
  slot.launchTask = (async () => {
    // 1) 预置 Local State 标记，让 Chromium 跳过空密码探测；
    // 2) 锁屏闸门：已锁屏时尝试安全启动，profile 不可写才拒绝（决策 D11）。
    ensureLocalStateSeed(profileDir)
    await assertSafeToLaunch(profileDir)
    return await launchImpl(config, options)
  })()
  try {
    const launched = await slot.launchTask
    // 启动后立即回读：哨兵值若仍是原样，说明 Chromium 没消费这个标记，防护未生效。
    // 不在这里抛错（浏览器已经起来了），由 tests/browser-profile.mjs 与 doctor 断言。
    slot.localStateConsumed = readOsPasswordLastChanged(profileDir) !== OS_PASSWORD_LAST_CHANGED_SENTINEL
    // launchPersistentContext 返回的是 BrowserContext（profile 宿主的那个），
    // 但它的 browser() 就是共享 Browser 实例：会话的隔离 context 仍由 browser.newContext() 分出。
    // 真实 Browser 没有 browser()，所以两种形状都能吃（测试注入的假 browser 是后者）。
    const persistent = typeof launched?.browser === 'function' ? launched : null
    const browser = persistent ? persistent.browser() : launched
    if (!browser) throw new Error('浏览器启动失败：launchPersistentContext 没有返回 browser')
    // 启动期间被 shutdown 摘槽：这个浏览器已经没有被任何槽持有，筹码也没人要，
    // 必须当场收掉，否则它会一直活着到进程退出（没人会再来 release 它）。
    if (slots.get(signature) !== slot) {
      await persistent?.close?.().catch(() => {})
      await browser.close?.().catch(() => {})
      throw new Error('浏览器启动期间池已被关闭，本次启动作废')
    }
    slot.persistent = persistent
    slot.browser = browser
    slot.options = { ...options }
    launchCount += 1
    slot.leases += 1
    // 池化后一个浏览器崩掉会影响所有会话：必须能在它断开时通知会话层清掉所有租约，
    // 否则会话会停在「以为浏览器还在」的状态（计划风险 R1）。
    browser.on?.('disconnected', () => {
      // 主动关闭期间状态由 shutdown 自己收，不重复广播。
      if (closingSlots.has(signature)) return
      if (slot.browser !== browser) return
      clearSlotIdleTimer(slot)
      slot.browser = null
      slot.persistent = null
      slot.options = null
      slot.leases = 0
      transition(slot, 'empty')
      slots.delete(signature)
      emitBrowserGone(browser)
    })
    transition(slot, 'ready')
    return { browser, reused: false, launchCount, signature }
  } catch (error) {
    slot.browser = null
    slot.persistent = null
    slot.options = null
    transition(slot, 'empty')
    slots.delete(signature)
    throw error
  } finally {
    slot.launchTask = null
  }
}

/**
 * 归还一份使用权：该槽租约归零才开始池级空闲计时，不立即关浏览器。
 *
 * 「关浏览器」是池的决定，不是会话的决定：一个会话 close 不能把别人的浏览器也关掉。
 * @param {string} signature - acquire 返回的签名
 * @returns {{leases: number, idleArmed: boolean}} 归还后的租约数与是否装上了空闲计时
 */
export function release(signature) {
  const slot = slots.get(signature)
  if (!slot) return { leases: 0, idleArmed: false }
  slot.leases = Math.max(0, slot.leases - 1)
  if (slot.leases === 0 && slot.browser) {
    armSlotIdleTimer(slot)
    return { leases: 0, idleArmed: slot.idleTimer !== null }
  }
  return { leases: slot.leases, idleArmed: false }
}

/**
 * 归还租约，并在「归零且调用方是本次拉起的唯一持有者」时立刻收掉浏览器。
 *
 * 用于**启动失败**路径：那一轮 acquire 已经把浏览器拉起来了，但会话没建成、也留不下 context，
 * 若只归还租约就要等池级空闲计时（默认 2 分钟）才关——期间一个没人用的浏览器白占内存与进程，
 * 而且后续 acquire 会把它当成「可复用」借出去（实测会让注入的假 chromium 用例连坐）。
 * @param {string} signature - acquire 返回的签名
 * @returns {Promise<{leases: number, closed: boolean}>} 归还后的租约数与是否顺手关掉了浏览器
 */
export async function abandon(signature) {
  const slot = slots.get(signature)
  if (!slot) return { leases: 0, closed: false }
  const { leases } = release(signature)
  if (leases === 0 && slot.browser) {
    const result = await shutdownSlot(slot, '启动失败回收')
    return { leases: 0, closed: result.closed }
  }
  return { leases, closed: false }
}

/**
 * 立刻关掉某个槽的共享浏览器（池级空闲回收、该槽最后一个租约回收、测试收尾用）。
 *
 * 与 release 的区别：release 只是不再借出，shutdown 是真结束进程。
 * 关闭失败不抛：清理由调用方兜底报告，不能让卸载流程挂在这。
 * @param {object} slot - 槽
 * @param {string} reason - 关闭原因，仅用于返回摘要
 * @returns {Promise<{closed: boolean, reason: string, launchCount: number}>} 关闭结果
 */
async function shutdownSlot(slot, reason) {
  clearSlotIdleTimer(slot)
  // 先摘槽再关进程：关闭过程中若有新 acquire 打到同一签名，必须拿不到这个正在死的槽
  // （否则它会在 browser.close() 还没落定时把该浏览器再借出去，关掉后调用方立刻失效）。
  if (slots.get(slot.signature) === slot) slots.delete(slot.signature)
  const browser = slot.browser
  const persistent = slot.persistent
  slot.browser = null
  slot.persistent = null
  slot.options = null
  slot.leases = 0
  transition(slot, 'closing')
  closingSlots.add(slot.signature)
  let closeFailed = false
  try {
    // 优先关 profile 宿主的那个 context（启动者）：它会连浏览器一起收掉，并落盘 Local State。
    // 只关 browser 在某些 Playwright 版本下会留下 persistent context 未关闭的告警。
    if (persistent) await persistent.close()
    else if (browser) await browser.close()
  } catch {
    // 关闭失败不能吞：调用方需要知道「以为关了其实没关」，否则进程残留会被当成已回收。
    closeFailed = true
  } finally {
    closingSlots.delete(slot.signature)
  }
  transition(slot, 'empty')
  return { closed: Boolean(browser) && !closeFailed, closeFailed, reason, launchCount }
}

/**
 * 立刻关掉共享浏览器（插件卸载、池级空闲回收、测试收尾用）。
 * @param {string} [reason] - 关闭原因，仅用于返回摘要
 * @returns {Promise<{closed: boolean, reason: string, launchCount: number}>} 关闭结果；
 *   closed 表示是否真的关掉过至少一个浏览器
 */
export async function shutdown(reason = '手动关闭') {
  let closed = false
  let closeFailed = false
  for (const slot of [...slots.values()]) {
    const result = await shutdownSlot(slot, reason)
    closed = closed || result.closed
    closeFailed = closeFailed || result.closeFailed === true
  }
  return { closed, closeFailed, reason, launchCount }
}

/**
 * 池的只读快照（诊断与测试用）：不创建、不修改任何状态。
 * @returns {{state: string, hasBrowser: boolean, leases: number, launchCount: number,
 *   idleArmed: boolean, options: object|null, slots: Array<object>}} 快照；
 *   顶层字段是「所有槽的聚合」，slots 是逐槽明细（签名内的浏览器与租约）
 */
/**
 * Playwright 默认禁用的 feature 清单，逐字对齐本仓依赖的 playwright-core@1.63.0
 * （源：`node_modules/playwright-core/lib/coreBundle.js` 的 chromiumSwitches）。升级依赖后必须重跑
 * `.scratch/extract-features.mjs` 核对，否则会与「默认 15 项」不等价。
 *
 * 为什么在这里抄一份：`--disable-features` 在 Chromium 上「重复开关取哪个」没有权威结论，
 * 而 Playwright 会先放默认 15 项、再追加用户 args。若我们只追加裸清单，可能整体替换掉默认项，
 * 让 DestroyProfileOnBrowserClose / HttpsUpgrades / PaintHolding 等失效，影响既有行为。
 * 因此拼成「默认 15 项 + 我们的 2 项」的**单一开关**放在最后：无论 Chromium 取首个还是末个，结果一致。
 */
export const PLAYWRIGHT_DEFAULT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]

/** 我们要额外关掉的 feature：Chromium 156+ 起自动填入会额外触发身份验证探测。 */
export const EXTRA_DISABLED_FEATURES = ['AutofillAiWalletPrivatePasses', 'AutofillAmbientAutofill']

/**
 * 拼出唯一的 `--disable-features` 取值：Playwright 默认 15 项 + 我们的 2 项，去重保序。
 * @param {string[]} [extra] - 额外要禁用的 feature，缺省用 EXTRA_DISABLED_FEATURES
 * @returns {string} 逗号分隔的清单
 */
export function mergeDisabledFeatures(extra = EXTRA_DISABLED_FEATURES) {
  const seen = new Set()
  const list = []
  for (const name of [...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES, ...extra]) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    list.push(name)
  }
  return list.join(',')
}

/**
 * 锁屏闸门：只在「真正拉起浏览器进程」的分支执行（复用路径不检测——那时没有新进程，检测纯属浪费）。
 *
 * 语义（规格 0041 的三条约束）：
 * 1. `UNKNOWN` ≠ 未锁：不据此拒绝，按可测情况放行；
 * 2. 「探针不可用」（非 Windows / exe 缺失 / 超时）与 `UNKNOWN` 是两种降级，都不阻塞启动；
 * 3. 已锁屏时**默认尝试安全启动**（profile 已预置 Local State，理论上不再产生 4625），
 *    仅当安全启动不可用（profile 目录写不进去）时才拒绝并说明原因（决策 D11）。
 * @param {string} profileDir - profile 目录
 * @returns {Promise<void>} 拒绝时抛错
 */
async function assertSafeToLaunch(profileDir) {
  let verdict = 'UNKNOWN'
  try {
    const { probeLock, probeAvailable } = await import('../native/lockscreen/probe.js')
    if (probeAvailable()) verdict = probeLock({ timeoutMs: LOCK_PROBE_TIMEOUT_MS }).verdict
  } catch {
    // 探针不可用是独立降级：不阻塞启动（规格 0041「边界」）。
    return
  }
  if (verdict !== 'LOCKED') return
  // 安全启动的前提是「profile 里真的有可用标记」而不是「刚写过一次没报错」：
  // 调用方在进闸门前已经 ensureLocalStateSeed 过，这时再调一次必然成功，等于没判。
  // 这里回读实际值——缺失（null）说明标记没落盘，这时才拒绝。
  try {
    if (readOsPasswordLastChanged(profileDir) === null) throw new Error('Local State 里没有 os_password_last_changed 标记')
  } catch (error) {
    throw new Error('检测到已锁屏，且安全启动不可用（profile 目录不可写：'
      + `${error?.message ?? error}）；为免触发 Windows 账户锁定已拒绝启动。`
      + '请解锁后再调用 browser_e2e_start，或检查 ~/.dsh/browser-e2e/browser-profile/ 的权限')
  }
}

/** 锁屏探针的超时预算（毫秒）：冷启动约 60~90ms，留足余量但不拖慢启动。 */
const LOCK_PROBE_TIMEOUT_MS = 5000

export function poolStats() {
  const list = [...slots.values()]
  return {
    state: list.length === 0 ? 'empty' : (list.some((slot) => slot.state === 'ready') ? 'ready' : list[0].state),
    hasBrowser: list.some((slot) => Boolean(slot.browser)),
    leases: list.reduce((sum, slot) => sum + slot.leases, 0),
    launchCount,
    idleArmed: list.some((slot) => slot.idleTimer !== null),
    options: list[0]?.options ? { ...list[0].options } : null,
    slots: list.map((slot) => ({
      signature: slot.signature,
      state: slot.state,
      hasBrowser: Boolean(slot.browser),
      leases: slot.leases,
      idleArmed: slot.idleTimer !== null,
    })),
  }
}

/**
 * 重置池（仅测试用）：清计时器与状态，不关浏览器。
 *
 * 生产路径不要调用；它的存在是为了让每个测试文件从干净的单例开始。
 * @returns {void}
 */
export function resetPoolForTest() {
  for (const slot of slots.values()) clearSlotIdleTimer(slot)
  slots.clear()
  closingSlots.clear()
  launchCount = 0
}
