/**
 * 页面层：标签页条目与生命周期、事件环（控制台 / 网络环形缓冲、ref 表）。
 *
 * 本文件不 import 会话层：所有函数接收 session 对象，需要广播面板事件时调用 session.emit
 * （由 session.js 在 sessionOf 里挂上）。因此会话层可以单向调用页面层，页面层不回指。
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

import { topUpIfChallenged } from './auth.js'
import { assertBrowserRunning, assertCdpConnected, assertCurrentTabAvailable, assertRefBelongsToTab, assertRefRevalidated,
  assertTabExists,
} from './invariants.js'
import { viewportBounds } from './viewport.js'

/** 默认视口。 */
export const DEFAULT_VIEWPORT = { width: 1600, height: 900 }

/** 跟随标签页时单页可见性探测的宿主侧超时（毫秒）；所有页并行探测。 */
export const FOLLOW_PROBE_TIMEOUT_MS = 2000

/** 跟随标签页探测结果在返回与文本里最多列出的条数。 */
const FOLLOW_PROBE_DISPLAY_LIMIT = 10

/** 控制台 / 网络记录的环形缓冲上限，超出时从头裁。 */
export const RING_LIMIT = 500

/** 读取 console / network 时缺省的尾部条数（工具描述与缺省参数共用这一份）。 */
export const DEFAULT_RING_QUERY_LIMIT = 100

/** 单条控制台文本的最大长度。 */
export const CONSOLE_TEXT_LIMIT = 2000

/** 控制台记录的规范严重级别，从低到高；级别过滤按这个次序比较。 */
export const CONSOLE_LEVELS = ['debug', 'log', 'info', 'warning', 'error']

/** 控制台级别的别名：调用方按源码关键字常写 warn，统一归一到 Playwright 的 warning。 */
export const CONSOLE_LEVEL_ALIASES = { warn: 'warning' }

/**
 * 归一控制台级别：trim、转小写、命中别名后取规范名。
 * 记录里的 msg.type() 与调用方参数走同一路径，避免 warn 与 warning 出现两套比较。
 * @param {string} value - 调用方传入或记录自带的级别
 * @returns {string} 规范名（CONSOLE_LEVELS 之一）
 */
export function normalizeConsoleLevel(value) {
  const normalized = normalizeLevelOrNull(value)
  if (normalized === null) {
    const aliasNote = Object.entries(CONSOLE_LEVEL_ALIASES).map(([alias, level]) => `${alias} 等同 ${level}`).join(' / ')
    throw new Error(`level 只支持 ${CONSOLE_LEVELS.join(' / ')}（${aliasNote}），收到 ${JSON.stringify(value)}；不传 level 则返回全部记录`)
  }
  return normalized
}

/**
 * 级别的排序位次：规范五级为 0..4，无法判级的类型（Playwright 的 dir / table / trace 等）为 -1。
 * 不做抛错，供过滤记录使用；别名与大小写同样归一。
 * @param {string} level - 记录自带或调用方传入的级别
 * @returns {number} 位次，不可判级为 -1
 */
export function consoleLevelRank(level) {
  return CONSOLE_LEVELS.indexOf(normalizeLevelOrNull(level))
}

/** 归一的内部实现：未识别值返回 null（不抛错）。 */
function normalizeLevelOrNull(value) {
  if (typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  const level = CONSOLE_LEVEL_ALIASES[lower] ?? lower
  return CONSOLE_LEVELS.includes(level) ? level : null
}

/** 上传：单次文件总字节数缺省上限（20 MiB）。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** 上传：单次文件总字节数允许调到的上限（512 MiB）。 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/** 上传：单次最多文件个数。 */
export const MAX_UPLOAD_FILES = 20

/** hover / drag 动作完成后等待页面反应的缺省毫秒数。 */
export const DEFAULT_SETTLE_MS = 300

/** settleMs 的取值上限。 */
export const MAX_SETTLE_MS = 5000

/** drag 在 mousedown 与 mouseup 之间的缺省插值 mousemove 次数。 */
export const DEFAULT_DRAG_STEPS = 12

/** drag 的 steps 下限。 */
export const MIN_DRAG_STEPS = 1

/** drag 的 steps 上限。 */
export const MAX_DRAG_STEPS = 60

/** click 的 clickCount 取值区间：1 单击、2 双击、3 三击。 */
export const CLICK_COUNTS = { min: 1, max: 3 }

/** click 支持的鼠标键。 */
export const CLICK_BUTTONS = ['left', 'right', 'middle']

/** click 支持的修饰键（Playwright 的键盘键名）。 */
export const CLICK_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift']

/** press 支持的动作。 */
export const PRESS_ACTIONS = ['press', 'down', 'up']

/** press 的 repeat 下限。 */
const MIN_PRESS_REPEAT = 1

/** press 的 repeat 上限。 */
export const MAX_PRESS_REPEAT = 100

/** 逐键输入（mode=keystrokes）单次最多写入的字符数（按 Unicode 码点计）。 */
export const KEYSTROKE_MAX_CHARS = 2000

/** 逐键输入的相邻按键等待上限（毫秒）。 */
export const KEYSTROKE_MAX_DELAY_MS = 1000

/** 逐键输入一次调用的等待时间预算（delayMs × 字符数，毫秒）。 */
export const KEYSTROKE_DELAY_BUDGET_MS = 30000

/** 剪贴板单次投递的纯文本上限（UTF-16 码元）。 */
export const CLIPBOARD_TEXT_LIMIT = 100000

/** 剪贴板单次投递的 HTML 上限（UTF-16 码元）。 */
export const CLIPBOARD_HTML_LIMIT = 200000

/** 对话框记录的环形上限。 */
export const DIALOG_RING_LIMIT = 50

/** browser_e2e_dialog 的缺省读取条数。 */
export const DIALOG_LIMIT_DEFAULT = 20

/** 单条对话框文案的最大长度。 */
const DIALOG_MESSAGE_LIMIT = 2000

/** prompt 应答文本的最大长度。 */
export const DIALOG_PROMPT_TEXT_LIMIT = 1000

/** browser_e2e_dialog 文本块的最大字符数（对话框记录由本文件写入，读取在 observation.js）。 */
export const DIALOG_TEXT_LIMIT = 20000

/** 对话框策略缺省值：取消（与 Playwright 无监听器时的默认一致）。 */
export const DEFAULT_DIALOG_POLICY = 'dismiss'

/** browser_e2e_evaluate 的缺省执行上限（毫秒）。 */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 30000

/** browser_e2e_evaluate 的执行下限（毫秒）。 */
export const MIN_EVALUATE_TIMEOUT_MS = 1000

/** browser_e2e_evaluate 的执行上限（毫秒）。 */
export const MAX_EVALUATE_TIMEOUT_MS = 120000

/** 当前时间 ISO 串（控制台 / 网络记录的时间戳）。 */
export function nowAt() {
  return new Date().toISOString()
}

/**
 * 向环形缓冲追加一条记录，超出上限时从头裁（保留最新）。
 * @param {Array} ring - 环形缓冲
 * @param {object} entry - 新记录
 * @param {(evicted: object) => void} [onEvict] - 淘汰回调，用于同步清理与记录配套的内部状态
 * @param {number} [limit] - 该环的上限，缺省为 RING_LIMIT
 */
export function pushRing(ring, entry, onEvict, limit = RING_LIMIT) {
  ring.push(entry)
  const overflow = ring.length - limit
  if (overflow <= 0) return
  const removed = ring.splice(0, overflow)
  if (typeof onEvict === 'function') for (const item of removed) onEvict(item)
}

/** 文本截断到指定长度，超出部分替换为提示。 */
export function truncateText(text, limit = CONSOLE_TEXT_LIMIT) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}...(已截断)` : value
}

/** 控制台 / 网络记录的时间显示（HH:MM:SS.mmm）。 */
export function timeOf(at) {
  return typeof at === 'string' ? at.slice(11, 23) : ''
}

/** 多行文本压成一行，保证每条记录只占一行。 */
export function oneLine(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ')
}

/**
 * 新建一个标签页条目，挂上监听并登记到会话。
 * @param {object} session - 会话状态
 * @param {import('playwright-core').Page} page - Playwright 页面
 * @param {'created'|'adopted'} [origin] - 来源：本会话新建 / 从 CDP 浏览器接管
 * @returns {object} 标签页条目
 */
export function addPage(session, page, origin = 'created') {
  // 抓取使用的一次性临时页不属于标签页注册表：CDP 分支的 page 监听另有豁免，这里是防御。
  if (isTransientPage(page)) return null
  const entry = {
    id: `t${session.nextTabSeq}`,
    page,
    refs: new Map(),
    consoleRing: [],
    networkRing: [],
    networkByRequest: new Map(),
    /** 网络上下文：request_id → { request, response }，只在详情调用时回取正文，事件里只存引用。 */
    networkContext: new Map(),
    /** 按标签页自增的 request_id 计数：分配时先自增，因此从 n1 起，文档重置不归零。 */
    nextNetworkSeq: 0,
    /** 快照基线：按 frame 分桶（epoch / key → 摘要与 ref / nextRef / version），只由本文件读写。 */
    snapshotBaselines: new Map(),
    /** 对话框策略：dismiss（默认，取消）或 accept（确认）。 */
    dialogPolicy: DEFAULT_DIALOG_POLICY,
    /** accept 时 prompt 的输入文本；null 表示用页面默认值。 */
    dialogPromptText: null,
    /** 对话框记录环形缓冲：每页一个，上限 DIALOG_RING_LIMIT。 */
    dialogRing: [],
    /** 页面是否仍在加载：初始 true，load / domcontentloaded 置 false，主框架导航开始置 true。 */
    loading: true,
    /** 跨调用按住的按键名集合（press action=down/up 读写，navigate 前释放并清空）。 */
    heldKeys: new Set(),
    /** 标签页来源：created（createPage 新建）或 adopted（CDP 接管已有页）。 */
    origin,
  }
  session.nextTabSeq += 1
  session.pages.set(entry.id, entry)
  attachPageHooks(session, entry)
  if (session.activeTabId === null) session.activeTabId = entry.id
  session.emit({ type: 'changed', key: session.key })
  return entry
}

/**
 * 移除一个标签页条目；active tab 落到剩余的第一个。
 * @param {object} session - 会话状态
 * @param {string} tabId - 标签页 id
 * @returns {boolean} 是否真的移除了
 */
export function removePage(session, tabId) {
  if (!session.pages.has(tabId)) return false
  session.pages.delete(tabId)
  if (session.activeTabId === tabId) {
    session.activeTabId = session.pages.keys().next().value ?? null
  }
  session.emit({ type: 'changed', key: session.key })
  return true
}

/**
 * 取当前要操作的标签页：显式 tab_id 优先，缺省用 active tab。
 * @param {object} session - 会话状态
 * @param {string} [tabId] - 显式 tab_id
 * @returns {object} 标签页条目
 */
export function currentTab(session, tabId) {
  if (typeof tabId === 'string' && tabId.length > 0) {
    return assertTabExists(session, tabId)
  }
  assertCurrentTabAvailable(session)
  return session.pages.get(session.activeTabId)
}

/**
 * 新建一个页面并返回（隔离模式沿用启动时的视口，CDP 模式用浏览器默认）。
 *
 * 前置只查「浏览器在」而不查页数：零页恢复（唯一页被关掉后 navigate {new_tab:true}）
 * 走的正是这条路径，此时 pages 已归零但浏览器仍活着。
 * @param {object} session - 会话状态
 * @returns {Promise<object>} 新建的页面
 */
export async function createPage(session) {
  if (!session || !session.browser) {
    throw new Error('浏览器尚未启动，请先调用 browser_e2e_start')
  }
  if (session.mode === 'cdp') {
    assertCdpConnected(session, session.browser.isConnected?.() !== false)
    return await session.context.newPage()
  }
  return await session.browser.newPage({ viewport: session.viewport ?? DEFAULT_VIEWPORT })
}

/** 抓取等功能自建的临时页：不登记为标签页、不挂事件钩子，用完即关。 */
const transientPages = new WeakSet()

/** 正在建临时页的会话计数：CDP 的 page 事件可能早于 newPage() 返回，建页期间同样要豁免。 */
const pendingTransient = new WeakMap()

/**
 * 判断页面是否由本插件自建、不属于任何标签页。
 * @param {import('playwright-core').Page} page - Playwright 页面
 * @returns {boolean} 临时页返回 true
 */
export function isTransientPage(page) {
  return transientPages.has(page)
}

/**
 * 该会话是否有正在创建的临时页。
 *
 * CDP 模式下 `context.newPage()` 触发的 `page` 事件可能早于 Promise 返回，
 * 此时 WeakSet 还没记上，监听方需要靠这个计数豁免。
 * @param {object} session - 会话状态
 * @returns {boolean} 建页期间返回 true
 */
export function hasPendingTransientPage(session) {
  return (pendingTransient.get(session) ?? 0) > 0
}

/**
 * 在指定标签页所属的浏览器上下文里新建一个临时页。
 *
 * CDP 模式用当前页的 context（用户浏览器整体共享登录态）；隔离模式不能用
 * `context().newPage()` —— `browser.newPage` 建出的 context 会报「Please use browser.newContext()」，
 * 且该模式本来每个标签页各自一个 context、没有跨页登录态可共享，因此直接在浏览器上开一页
 * （Playwright 文档：关闭该页会一并关闭它所属的 context）。
 * 临时页不写进 session.pages，CDP 分支的 context.on('page') 也会跳过它，
 * 因此 tabs 与面板不会多出一页。
 * @param {object} session - 会话状态
 * @param {string} [tabId] - 目标标签页；缺省用 active tab
 * @returns {Promise<import('playwright-core').Page>} 临时页
 */
export async function createTransientPage(session, tabId) {
  const tab = currentTab(session, tabId)
  pendingTransient.set(session, (pendingTransient.get(session) ?? 0) + 1)
  try {
    const page = session.mode === 'cdp'
      ? await tab.page.context().newPage()
      : await session.browser.newPage({ viewport: session.viewport ?? DEFAULT_VIEWPORT })
    transientPages.add(page)
    return page
  } finally {
    const remaining = (pendingTransient.get(session) ?? 1) - 1
    if (remaining > 0) pendingTransient.set(session, remaining)
    else pendingTransient.delete(session)
  }
}

/**
 * 给页面挂上控制台与网络监听。每个 page 只挂一次。
 *
 * 网络记录用「request 事件建占位、response / requestfailed 原地改字段」的做法：
 * Map 里存的就是 ring 中的同一个对象引用，后续事件直接改写该对象，不再二次查表。
 */
export function attachPageHooks(session, entry) {
  const page = entry.page
  if (session.hookedPages.has(page)) return
  session.hookedPages.add(page)

  page.on('console', (msg) => {
    // Playwright 的 msg.text() 即其对 args 的序列化结果。
    pushRing(entry.consoleRing, {
      level: msg.type(),
      text: truncateText(msg.text()),
      at: nowAt(),
    })
  })

  page.on('pageerror', (error) => {
    pushRing(entry.consoleRing, {
      level: 'error',
      text: truncateText(error?.message ?? error),
      at: nowAt(),
    })
  })

  page.on('request', (request) => {
    // 主框架的新文档请求是「事件环该重置」的等价判据：Playwright 的 Page 事件不带
    // loaderId，但同 URL reload、goto 同地址都会发出主框架 document 请求，而 hash
    // 变化与 SPA 路由不会。先清旧文档的记录再登记本次请求，新文档自身已经发出的
    // 请求不会被删掉。
    if (isNewDocumentRequest(request, page)) {
      clearRings(entry)
      entry.refs.clear()
      invalidateBaselines(entry)
    }
    const context = networkContextOf(entry)
    entry.nextNetworkSeq += 1
    const requestId = `n${entry.nextNetworkSeq}`
    const record = {
      request_id: requestId,
      url: request.url(),
      method: request.method(),
      status: 0,
      mimeType: '',
      failure: '',
      at: nowAt(),
    }
    // 事件里只存 Request 引用与轻量元数据，不读头 / 正文：列表读取保持零 I/O。
    context.set(requestId, { request, response: null })
    entry.networkByRequest.set(request, record)
    // request 事件可能远多于 response / requestfailed，Map 不能无界增长：按插入顺序淘汰最旧的键。
    while (entry.networkByRequest.size > RING_LIMIT) {
      const oldest = entry.networkByRequest.keys().next().value
      const oldestRecord = entry.networkByRequest.get(oldest)
      entry.networkByRequest.delete(oldest)
      if (oldestRecord?.request_id) context.delete(oldestRecord.request_id)
    }
    pushRing(entry.networkRing, record, (evicted) => context.delete(evicted.request_id))
  })

  page.on('response', (response) => {
    const record = entry.networkByRequest.get(response.request())
    if (!record) return
    record.status = response.status()
    record.mimeType = response.headers()['content-type'] ?? ''
    // 详情调用时才读头与正文；这里只留引用，供 networkDetail 回取。
    const context = entry.networkContext?.get(record.request_id)
    if (context) context.response = response
  })

  page.on('requestfailed', (request) => {
    const record = entry.networkByRequest.get(request)
    if (!record) return
    record.failure = request.failure()?.errorText ?? 'request failed'
  })

  // 面板需要知道页面换没换：地址与标题都会变，投屏也要重新判断是否仍在同一页。
  const notifyChanged = () => session.emit({ type: 'changed', key: session.key })
  page.on('domcontentloaded', () => {
    entry.loading = false
    notifyChanged()
  })
  page.on('load', () => {
    entry.loading = false
    notifyChanged()
  })
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      // 子 frame 导航后该 frame 的稳定 key 与文档都换了：丢弃 key / ref，但保留 reset 标记。
      invalidateBaselines(entry, frame)
      return
    }
    // 主框架开始导航：进入 loading。事件环的重置在 request 里按新文档请求做，
    // 这里不再按 URL 判断（同 URL reload 也会换文档）。
    entry.loading = true
    notifyChanged()
  })
  // 标签页被关掉 / 崩溃只摘除该页，不改会话状态：state=ready 表示「浏览器可用」，
  // 0 页是可恢复态（页面工具报尚未启动，start 的复用路径会补建）。是否关闭浏览器只由 close 决定。
  page.on('close', () => {
    removePage(session, entry.id)
  })
  // 对话框必须在事件回调里立即应答：注册了监听器后 Playwright 不再自动关闭对话框，
  // 不应答页面会冻结、click 之类的动作永远不结束（types.d.ts 的 page.on('dialog') 文档）。
  page.on('dialog', (dialog) => {
    const type = String(dialog.type())
    if (!Array.isArray(entry.dialogRing)) entry.dialogRing = []
    const policy = entry.dialogPolicy === 'accept' ? 'accept' : DEFAULT_DIALOG_POLICY
    // beforeunload 与 Playwright 无监听器时的内部默认一致：一律接受，避免改变导航语义。
    const accepted = type === 'beforeunload' ? true : policy === 'accept'
    const record = {
      at: nowAt(),
      type,
      message: truncateText(dialog.message(), DIALOG_MESSAGE_LIMIT),
      defaultValue: type === 'prompt' ? String(dialog.defaultValue() ?? '') : '',
      accepted,
      error: '',
    }
    pushRing(entry.dialogRing, record, undefined, DIALOG_RING_LIMIT)
    // prompt 的 accept 必须显式给文本：实测 dialog.accept(undefined) 会传空串，
    // 而规格要求「没设置 prompt_text 时用页面默认值」，所以这里用 defaultValue() 补上。
    const promptText = type === 'prompt'
      ? (entry.dialogPromptText !== null && entry.dialogPromptText !== undefined
        ? entry.dialogPromptText
        : dialog.defaultValue())
      : undefined
    const answer = accepted
      ? dialog.accept(type === 'prompt' ? promptText : undefined)
      : dialog.dismiss()
    // 事件回调里抛错会变成未处理拒绝；应答失败（对话框已被关掉等）只记在该条记录上。
    answer.catch((error) => { record.error = String(error?.message ?? error) })
  })
  page.on('crash', () => {
    removePage(session, entry.id)
  })

  // 接管已有页面时通常已经加载完成，不会再触发 load；用 readyState 校正初始 loading。
  if (entry.origin === 'adopted') {
    void page.evaluate(() => document.readyState)
      .then((state) => {
        if (state === 'complete') {
          entry.loading = false
          notifyChanged()
        }
      })
      .catch(() => {})
  }
}

/**
 * 判断一条请求是不是该页面主框架的新文档请求（等价于 loaderId 变化的判据）。
 * @param {import('playwright-core').Request} request - 网络请求
 * @param {import('playwright-core').Page} page - 所属页面
 * @returns {boolean} 是主框架新文档请求时为 true
 */
export function isNewDocumentRequest(request, page) {
  if (!request.isNavigationRequest()) return false
  try {
    return request.frame() === page.mainFrame()
  } catch {
    // 请求所属 frame 已 detach 时 frame() 会抛错，按「不是本次页面的新文档」处理。
    return false
  }
}

/** 清空某个标签页的控制台与网络记录（导航时调用）。request_id 计数不归零。 */
export function clearRings(entry) {
  entry.consoleRing.length = 0
  entry.networkRing.length = 0
  entry.networkByRequest.clear()
  entry.networkContext?.clear()
}

/**
 * 取标签页的网络上下文表；fake entry 或更早创建的条目可能没有该字段，就地补建。
 * @param {object} entry - 标签页条目
 * @returns {Map<string, { request: object, response: object | null }>} 网络上下文
 */
function networkContextOf(entry) {
  if (!(entry.networkContext instanceof Map)) entry.networkContext = new Map()
  if (!Number.isInteger(entry.nextNetworkSeq)) entry.nextNetworkSeq = 0
  return entry.networkContext
}

/**
 * 让快照基线失效：丢弃 key / ref（不保留元素身份），但保留「曾经有基线」的标记，
 * 使下一次 delta 能报 `baseline: 'reset'` 而不是 `'missing'`。
 * @param {object} entry - 标签页条目
 * @param {object} [frame] - 只失效该 frame；缺省失效全部 frame
 */
function invalidateBaselines(entry, frame) {
  for (const [key, bucket] of entry.snapshotBaselines) {
    if (frame && key !== frame) continue
    entry.snapshotBaselines.set(key, {
      epoch: null,
      version: bucket?.version ?? 0,
      nextRef: 0,
      keys: new Map(),
      invalidated: true,
    })
  }
}

/** 取页面标题；取不到或超时返回空串，用于 tab 列表。 */
export async function titleOf(page) {
  let timer
  try {
    return await Promise.race([
      page.title(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(''), 400)
        timer.unref?.()
      }),
    ])
  } catch {
    return ''
  } finally {
    // 标题先返回时清掉兜底定时器，避免每次调用都留一个 400ms 后空跑的回调。
    clearTimeout(timer)
  }
}

/**
 * 导航到指定地址；new_tab 为真时新建标签页，否则用 tab_id 指定的页（缺省 active）。
 * 导航成功会清空该页的 ref 表与控制台 / 网络记录。
 * @param {object} session - 会话状态
 * @param {string} url - 目标地址
 * @param {string} [waitUntil] - load | domcontentloaded | networkidle
 * @param {{tab_id?: string, new_tab?: boolean}} [options] - 目标标签页 / 是否新开
 * @returns {Promise<object>} 导航结果
 */
export async function navigate(session, url, waitUntil = 'load', options = {}) {
  let tab
  if (options.new_tab === true) {
    // new_tab 不要求现成标签页：CDP 接管模式下用户关掉唯一页后，这里是恢复入口。
    // 浏览器本身不在时由 createPage 报「浏览器尚未启动」。
    tab = addPage(session, await createPage(session))
  } else {
    assertBrowserRunning(session)
    tab = currentTab(session, options.tab_id)
  }
  session.activeTabId = tab.id
  // 旧文档上按住的键不能带进新文档：goto 之前逐个释放并清空。
  await releaseHeldKeys(tab)
  // 导航开始前先清一次：goto 失败时旧记录也不会挂在新导航结果里；新文档自身的请求
  // 会在 request 事件里重新登记，不会被这里的清空误删。
  clearRings(tab)
  // 对话框记录属于旧文档：导航后清掉，新文档从空环开始（策略保留在标签页上）。
  tab.dialogRing.length = 0
  tab.refs.clear()
  invalidateBaselines(tab)
  let response = await tab.page.goto(url, { waitUntil, timeout: 30000 })
  // 命中登录挑战时补一次带 launch-token 的地址；每个 tab 每次导航只试一次。
  const topped = await topUpIfChallenged(tab.page, url, response)
  response = topped.response
  const authRetried = topped.retried
  tab.refs.clear()
  invalidateBaselines(tab)
  session.emit({ type: 'changed', key: session.key })
  const status = response?.status() ?? null
  const finalUrl = tab.page.url()
  return {
    tabId: tab.id,
    newTab: options.new_tab === true,
    authRetried,
    url: finalUrl,
    status,
    ok: response?.ok() ?? false,
    title: await tab.page.title(),
    summary: status === null
      ? `导航到 ${finalUrl}（标签页 ${tab.id}，无响应对象${authRetried ? '，已补票' : ''}）`
      : `导航到 ${finalUrl}（标签页 ${tab.id}，HTTP ${status}${authRetried ? '，已补票' : ''}）`,
  }
}

/** 探测单个标签页主文档的可见性与焦点；失败由调用方计入候选剔除。 */
async function probeTabVisibility(tab) {
  return await withTimeout(
    tab.page.evaluate(() => ({ visibility: document.visibilityState, focus: document.hasFocus() })),
    FOLLOW_PROBE_TIMEOUT_MS,
    `探测标签页 ${tab.id} 的可见性超时（${FOLLOW_PROBE_TIMEOUT_MS}ms）`,
  )
}

/**
 * 绑定后续页面工具的默认标签页（跟随用户当前标签页）。
 *
 * 显式 tab_id 优先；不给时并行探测已登记页的主文档可见性 / 焦点，按
 * 「唯一聚焦页 → 唯一可见页 → 保持当前 activeTab」判定，无法唯一判定且当前页
 * 不在候选时报错，不猜。只做一次显式绑定，不做静默实时跟随。
 * @param {object} session - 会话状态
 * @param {{tab_id?: string, activate?: boolean}} [options] - 目标标签页 / 是否带到前台
 * @returns {Promise<object>} 绑定结果
 */
export async function followTab(session, options = {}) {
  assertBrowserRunning(session)
  const rawTabId = options.tab_id
  if (rawTabId !== undefined && typeof rawTabId !== 'string') {
    throw new Error('tab_id 必须是字符串（browser_e2e_tabs 得到的 t1、t2…）；不传表示自动判定用户当前标签页')
  }
  const activate = options.activate === true
  const previousTabId = session.activeTabId ?? null
  let tab
  let source
  let probes = null
  let failedProbeCount = 0
  if (typeof rawTabId === 'string' && rawTabId.length > 0) {
    tab = assertTabExists(session, rawTabId)
    source = 'explicit'
  } else {
    const entries = [...session.pages.values()]
    const settled = await Promise.allSettled(entries.map((entry) => probeTabVisibility(entry)))
    probes = []
    let firstFailure = ''
    settled.forEach((outcome, index) => {
      const entry = entries[index]
      if (outcome.status === 'rejected') {
        failedProbeCount += 1
        if (!firstFailure) {
          firstFailure = outcome.reason && typeof outcome.reason.message === 'string'
            ? outcome.reason.message
            : String(outcome.reason)
        }
        return
      }
      const value = outcome.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        failedProbeCount += 1
        if (!firstFailure) firstFailure = `标签页 ${entry.id} 返回的探测结果不是对象`
        return
      }
      probes.push({
        entry,
        tabId: entry.id,
        visibility: typeof value.visibility === 'string' ? value.visibility : 'unknown',
        focus: value.focus === true,
      })
    })
    if (probes.length === 0) {
      throw new Error(`无法判定用户当前标签页：所有标签页都未能返回可见性（${firstFailure || '未知原因'}）；请先 browser_e2e_tabs，再带 tab_id 调用 browser_e2e_follow_tab`)
    }
    const focused = probes.filter((probe) => probe.focus)
    if (focused.length === 1) {
      tab = focused[0].entry
      source = 'focused'
    } else {
      const visible = probes.filter((probe) => probe.visibility === 'visible')
      if (visible.length === 1) {
        tab = visible[0].entry
        source = 'visible'
      } else {
        const current = probes.find((probe) => probe.tabId === session.activeTabId)
        if (!current) {
          throw new Error(`无法判定用户当前标签页：${probes.length} 个标签页同时可见或都不可见，当前默认标签页也不在可探测结果里；请先 browser_e2e_tabs，再带 tab_id 调用 browser_e2e_follow_tab`)
        }
        tab = current.entry
        source = 'current'
      }
    }
  }
  // 来源为 current 时即使传了 activate 也不抢用户焦点。
  let activated = false
  if (activate && source !== 'current') {
    try {
      await tab.page.bringToFront()
      activated = true
    } catch (error) {
      const message = error && typeof error.message === 'string' ? error.message : String(error)
      throw new Error(`标签页 ${tab.id} 带到前台失败：${message}；默认标签页未改变`)
    }
  }
  // 探测 / 激活期间目标可能已被关掉：不把已摘除的 tab 写回 activeTabId。
  if (!session.pages.has(tab.id)) {
    throw new Error(`标签页 ${tab.id} 在跟随过程中已关闭，请先 browser_e2e_tabs 确认最新标签页`)
  }
  session.activeTabId = tab.id
  let url = ''
  try {
    url = tab.page.url()
  } catch {
    url = ''
  }
  const title = await titleOf(tab.page)
  const label = title || url || '(无标题)'
  const result = {
    tabId: tab.id,
    previousTabId,
    changed: previousTabId !== tab.id,
    source,
    activated,
    ambiguous: source === 'current',
    url,
    title,
    tabs: session.pages.size,
    summary: source === 'current'
      ? `未能唯一判定用户当前标签页，保持标签页 ${tab.id}（${label}）`
      : `跟随标签页 ${tab.id}（${label}）${activated ? '，已带到前台' : ''}`,
  }
  if (probes !== null) {
    result.candidates = probes.slice(0, FOLLOW_PROBE_DISPLAY_LIMIT).map((probe) => ({
      tabId: probe.tabId,
      visibility: probe.visibility,
      focus: probe.focus,
    }))
    result.failedProbeCount = failedProbeCount
  }
  return result
}

/** 宿主侧超时包装：页面脚本无法被终止，超时只让本次调用失败。 */
export function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message)
      error.code = 'SNAPSHOT_TIMEOUT'
      reject(error)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 校验视口坐标：非负，且 x / y 不超过视口边界（width - 1 / height - 1）。 */
async function assertPointInViewport(page, x, y, viewport = page.viewportSize()) {
  if (x < 0 || y < 0) {
    throw new Error(`坐标不能为负数，收到 x=${x}, y=${y}`)
  }
  const bounds = await viewportBounds(page, viewport)
  if (!bounds) return
  if (x > bounds.width - 1) {
    throw new Error(`坐标 x=${x} 超出视口宽度（视口宽度 ${bounds.width}，可用范围 0-${bounds.width - 1}）`)
  }
  if (y > bounds.height - 1) {
    throw new Error(`坐标 y=${y} 超出视口高度（视口高度 ${bounds.height}，可用范围 0-${bounds.height - 1}）`)
  }
}

/** 目标参数的两句报错文案：click / fill 与既有文案逐字一致，upload 用自己的两句。 */
const TARGET_MESSAGES = {
  click: [
    '缺少点击目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一',
    '点击目标只能给一种：ref / selector / x + y 三选一，避免点错位置',
  ],
  fill: [
    '缺少填写目标：需要 ref / selector / x + y 三者之一',
    '填写目标只能给一种：ref / selector / x + y 三选一，避免填错位置',
  ],
  upload: [
    '缺少上传目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一',
    '上传目标只能给一种：ref / selector / x + y 三选一，避免传错控件',
  ],
}

/**
 * 读取交互目标三元组：ref / selector / x + y，只做归一化，不判断互斥。
 * @param {object} options - 目标参数
 * @returns {{ref: string|null, selector: string|null, hasPoint: boolean}}
 */
function readTarget(options) {
  const input = options ?? {}
  const ref = typeof input.ref === 'string' && input.ref.length > 0 ? input.ref : null
  const selector = typeof input.selector === 'string' && input.selector.length > 0 ? input.selector : null
  const hasPoint = Number.isFinite(input.x) && Number.isFinite(input.y)
  return { ref, selector, hasPoint }
}

/**
 * 解析交互目标：ref / selector / x + y 三选一。
 * @param {object} options - 目标参数
 * @param {string} verb - 动作词（click / fill / upload），决定报错文案
 * @returns {{ref: string|null, selector: string|null, hasPoint: boolean}}
 */
export function targetOf(options, verb) {
  const target = readTarget(options)
  const modes = [target.ref, target.selector, target.hasPoint].filter(Boolean).length
  const messages = TARGET_MESSAGES[verb]
  if (modes === 0) throw new Error(messages[0])
  if (modes > 1) throw new Error(messages[1])
  return target
}

/**
 * hover / drag 的目标三选一校验：缺少或多于一种都报错，不猜调用方意图。
 * @param {object} options - 目标参数
 * @param {string} label - 报错主语，如 `悬停`、`拖拽起点（from）`
 * @param {string} avoid - 多目标时的后果短语，如 `悬停到错误元素`、`拖拽错元素`
 * @returns {{ref: string|null, selector: string|null, hasPoint: boolean}}
 */
export function requireTarget(options, label, avoid) {
  const target = readTarget(options)
  const modes = [target.ref, target.selector, target.hasPoint].filter(Boolean).length
  if (modes === 0) {
    throw new Error(`缺少${label}目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一`)
  }
  if (modes > 1) {
    throw new Error(`${label}目标只能给一种：ref / selector / x + y 三选一，避免${avoid}`)
  }
  return target
}

/** 解析 settleMs：缺省用 DEFAULT_SETTLE_MS，必须是 0-MAX_SETTLE_MS 的整数。 */
function readSettleMs(value) {
  const settleMs = value ?? DEFAULT_SETTLE_MS
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > MAX_SETTLE_MS) {
    throw new Error(`settleMs 必须是 0-${MAX_SETTLE_MS} 的整数，收到 ${settleMs}`)
  }
  return settleMs
}

/** 解析 drag 的 steps：缺省用 DEFAULT_DRAG_STEPS，必须是 MIN-MAX 的整数。 */
function readSteps(value) {
  const steps = value ?? DEFAULT_DRAG_STEPS
  if (!Number.isInteger(steps) || steps < MIN_DRAG_STEPS || steps > MAX_DRAG_STEPS) {
    throw new Error(`steps 必须是 ${MIN_DRAG_STEPS}-${MAX_DRAG_STEPS} 的整数，收到 ${steps}`)
  }
  return steps
}

/** 解析 click 的指针参数：clickCount / button / modifiers，缺省与区间见功能规格 0025。 */
function readClickOptions(options) {
  const input = options ?? {}
  const clickCount = input.clickCount ?? 1
  if (!Number.isInteger(clickCount) || clickCount < CLICK_COUNTS.min || clickCount > CLICK_COUNTS.max) {
    throw new Error(`clickCount 必须是 ${CLICK_COUNTS.min}-${CLICK_COUNTS.max} 的整数，收到 ${clickCount}`)
  }
  const button = input.button ?? 'left'
  if (!CLICK_BUTTONS.includes(button)) {
    throw new Error(`button 只支持 left / right / middle，收到 "${button}"`)
  }
  const modifiers = input.modifiers ?? []
  if (!Array.isArray(modifiers) || modifiers.some((modifier) => !CLICK_MODIFIERS.includes(modifier))) {
    throw new Error(`modifiers 必须是数组，且每个元素只能是 Alt / Control / Meta / Shift，收到 ${JSON.stringify(modifiers)}`)
  }
  return { clickCount, button, modifiers }
}

/**
 * 按住本次显式给的修饰键执行一次动作，结束后只释放本次按下的键。
 * 已由 press action=down 按住的键跳过（保持按住状态），不重复 down、也不误释放。
 */
async function withModifiers(page, tab, modifiers, run) {
  const pressed = []
  try {
    for (const modifier of modifiers) {
      if (tab.heldKeys?.has(modifier)) continue
      await page.keyboard.down(modifier)
      pressed.push(modifier)
    }
    return await run()
  } finally {
    for (const modifier of pressed.reverse()) {
      try {
        await page.keyboard.up(modifier)
      } catch {
        // 释放失败只可能来自页面已销毁；保留原始错误，不在这里覆盖。
      }
    }
  }
}

/** 释放该标签页上本工具按住的全部按键（导航前调用）：逐个 keyup，失败也清空记账。 */
async function releaseHeldKeys(tab) {
  if (!(tab.heldKeys instanceof Set) || tab.heldKeys.size === 0) return
  const keys = Array.from(tab.heldKeys)
  tab.heldKeys.clear()
  for (const key of keys) {
    try {
      await tab.page.keyboard.up(key)
    } catch {
      // 页面已关闭 / 崩溃时 keyup 必然失败；按住状态随页面对象消失。
    }
  }
}

/**
 * 点击。三种方式三选一：
 * - ref：来自 snapshot 的 @N，点击前先复验 xpath 仍命中且有可见尺寸；
 * - selector：CSS 选择器，先等可见再点；
 * - x + y：视口坐标，走真实鼠标事件。
 * @param {object} session - 会话状态
 * @param {{ref?: string, selector?: string, x?: number, y?: number, clickCount?: number, button?: 'left'|'right'|'middle', modifiers?: string[]}} target - 目标与指针参数
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 点击结果
 */
/**
 * 点击 / 填写前复验 ref：xpath 仍命中节点，且节点有可见尺寸。
 *
 * 失效就直接报错，不静默点到空处或另一个元素。
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {{xpath: string}} item - snapshot 记录的 ref 条目
 * @param {string} ref - ref 文本（@N）
 * @returns {Promise<void>}
 */
async function revalidateRef(page, item, ref) {
  const check = await page.evaluate((xpath) => {
    let el = null
    try {
      el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
    } catch {
      el = null
    }
    if (!el) return { found: false, width: 0, height: 0 }
    const rect = el.getBoundingClientRect()
    return { found: true, width: rect.width, height: rect.height }
  }, item.xpath)
  assertRefRevalidated(ref, check)
}

export async function click(session, target = {}, tabId) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  // 参数错误必须在任何输入事件（含 scrollIntoView）之前抛出。
  const { clickCount, button, modifiers } = readClickOptions(target)
  const { ref, selector, hasPoint } = targetOf(target, 'click')
  const actionWord = clickCount === 2 ? '双击' : (clickCount === 3 ? '三击' : '点击')
  const suffixParts = []
  if (button === 'right') suffixParts.push('右键')
  else if (button === 'middle') suffixParts.push('中键')
  if (modifiers.length > 0) suffixParts.push(`按住 ${modifiers.join('+')}`)
  const suffix = suffixParts.length > 0 ? `（${suffixParts.join('，')}）` : ''

  if (ref) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    // 点击前复验：xpath 仍命中节点，且节点有可见尺寸；失效就直接报错，不静默点错。
    await revalidateRef(page, item, ref)
    const locator = page.locator(`xpath=${item.xpath}`)
    await withModifiers(page, tab, modifiers, async () => {
      await locator.scrollIntoViewIfNeeded()
      await locator.click({ timeout: 10000, clickCount, button })
    })
    return {
      mode: 'ref',
      ref,
      tag: item.tag,
      name: item.name,
      clickCount,
      button,
      modifiers,
      summary: `${actionWord} ${ref} (${item.tag} "${item.name}")${suffix}`,
    }
  }

  if (selector) {
    const locator = page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    await withModifiers(page, tab, modifiers, () => locator.click({ timeout: 10000, clickCount, button }))
    return {
      mode: 'selector',
      selector,
      clickCount,
      button,
      modifiers,
      summary: `${actionWord} selector "${selector}"${suffix}`,
    }
  }

  const x = Number(target.x)
  const y = Number(target.y)
  await assertPointInViewport(page, x, y)
  await withModifiers(page, tab, modifiers, () => page.mouse.click(x, y, { clickCount, button }))
  return {
    mode: 'point',
    x,
    y,
    clickCount,
    button,
    modifiers,
    summary: `${actionWord}坐标 (${x}, ${y})${suffix}`,
  }
}

/**
 * 填写前校验目标不是可切换控件。
 *
 * checkbox / radio 的「填写」没有文本语义，旧写法「先 click 再 fill」还会把勾选状态切反；
 * 这里在点击之前就报错，让调用方改用 browser_e2e_click 明确切换。
 */
async function assertFillable(locator, label) {
  const info = await locator.evaluate((el) => ({
    tag: String(el.tagName || '').toLowerCase(),
    type: String(el.type || '').toLowerCase(),
  })).catch(() => null)
  if (info && info.tag === 'input' && (info.type === 'checkbox' || info.type === 'radio')) {
    throw new Error(`${label} 是可切换控件 input[type=${info.type}]，填写不会改变勾选状态；请改用 browser_e2e_click 切换`)
  }
}

/** 可以逐键输入的 input type 白名单。 */
const KEYSTROKE_INPUT_TYPES = ['text', 'search', 'tel', 'url', 'email', 'password', 'number']

/**
 * 逐键输入前校验目标类型：只允许文本 input / textarea / contenteditable。
 *
 * select 与非文本 input（file / date / color / range 等）没有可逐键写入的文本语义，
 * 在点击之前就报错并给出改用路径。evaluate 失败时返回 null，跳过中文校验，
 * 与 assertFillable 同口径，交 Playwright 报错。
 * @param {import('playwright-core').Locator} locator - 元素定位器
 * @param {string} label - 报错主语（`ref @N` 或 `selector "..."`）
 * @returns {Promise<void>}
 */
async function assertKeystrokeTarget(locator, label) {
  const info = await locator.evaluate((el) => ({
    tag: String(el.tagName || '').toLowerCase(),
    type: String(el.type || '').toLowerCase(),
    editable: el.isContentEditable === true,
  })).catch(() => null)
  if (!info) return
  if (info.tag === 'select') {
    throw new Error(`${label} 是下拉选择控件 select，不能逐键输入；请先用 browser_e2e_click 展开，再用 browser_e2e_press（方向键 / Enter）选择`)
  }
  if (info.tag === 'textarea') return
  if (info.tag === 'input' && KEYSTROKE_INPUT_TYPES.includes(info.type)) return
  if (info.editable) return
  throw new Error(`${label} 不是可逐键输入的文本目标（${info.tag}[type=${info.type}]）；需要 input / textarea / contenteditable，非文本控件请改用默认 mode=insert`)
}

/**
 * 填写文本。三种目标三选一（ref / selector / x + y）。
 *
 * `mode=insert`（缺省）走一次赋值；`mode=keystrokes` 先清空再逐键输入，
 * 只支持 ref / selector，目标限文本 input / textarea / contenteditable。
 * @param {object} session - 会话状态
 * @param {{ref?: string, selector?: string, x?: number, y?: number}} target - 目标
 * @param {string} value - 要填入的文本
 * @param {string} [tabId] - 标签页 id
 * @param {{mode?: 'insert'|'keystrokes', delayMs?: number}} [options] - 写入方式与逐键延迟
 * @returns {Promise<object>} 填写结果
 */
export async function fill(session, target, value, tabId, options = {}) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  const { ref, selector } = targetOf(target, 'fill')
  const opts = options || {}
  const mode = opts.mode ?? 'insert'

  if (mode !== 'insert' && mode !== 'keystrokes') {
    throw new Error(`mode 只支持 insert / keystrokes，收到 "${String(opts.mode)}"`)
  }
  if (mode === 'insert' && opts.delayMs !== undefined) {
    throw new Error('delayMs 只对 mode=keystrokes 生效；mode=insert 请去掉 delayMs')
  }

  const useKeys = mode === 'keystrokes'
  let delayMs = 0
  let chars = 0
  if (useKeys) {
    delayMs = opts.delayMs ?? 0
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > KEYSTROKE_MAX_DELAY_MS) {
      throw new Error(`delayMs 必须是 0-${KEYSTROKE_MAX_DELAY_MS} 的整数，收到 ${String(delayMs)}`)
    }
    chars = Array.from(String(value)).length
    if (chars > KEYSTROKE_MAX_CHARS) {
      throw new Error(`mode=keystrokes 一次最多 ${KEYSTROKE_MAX_CHARS} 个字符（按码点计），收到 ${chars} 个；长文本请用默认 mode=insert`)
    }
    if (delayMs * chars > KEYSTROKE_DELAY_BUDGET_MS) {
      throw new Error(`mode=keystrokes 的 delayMs × 字符数不能超过 ${KEYSTROKE_DELAY_BUDGET_MS} ms（当前 ${delayMs} × ${chars} = ${delayMs * chars} ms）；请减小 delayMs 或分段输入`)
    }
    if (!ref && !selector) {
      throw new Error('mode=keystrokes 需要 ref 或 selector（坐标目标无法可靠清空和校验可编辑性）；请改用 ref / selector，或使用默认 mode=insert')
    }
  }

  const keystrokeSummary = (targetText) => `逐键填写 ${targetText} <- "${value}"（${chars} 个字符，delayMs=${delayMs}）`

  /** 按模式写入：insert 一次赋值；keystrokes 先清空再逐键。 */
  const writeInto = async (locator) => {
    if (!useKeys) {
      await locator.fill(value, { timeout: 10000 })
      return
    }
    await locator.fill('', { timeout: 10000 })
    await locator.pressSequentially(value, { delay: delayMs, timeout: 10000 })
  }

  if (ref) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    // 与 click 同一条复验：元素被移除 / 不可见时直接报「已失效」，不往旧 xpath 上填。
    await revalidateRef(page, item, ref)
    const locator = page.locator(`xpath=${item.xpath}`)
    await locator.scrollIntoViewIfNeeded()
    await assertFillable(locator, `ref ${ref}`)
    if (useKeys) await assertKeystrokeTarget(locator, `ref ${ref}`)
    await locator.click({ timeout: 10000 })
    await writeInto(locator)
    const result = {
      mode: 'ref',
      ref,
      tag: item.tag,
      label: item.name,
      value,
      summary: `填写 ${ref} (${item.tag} "${item.name}") <- "${value}"`,
    }
    if (!useKeys) return result
    return {
      ...result,
      inputMode: 'keystrokes',
      chars,
      delayMs,
      summary: keystrokeSummary(`${ref} (${item.tag} "${item.name}")`),
    }
  }

  if (selector) {
    const locator = page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    await assertFillable(locator, `selector "${selector}"`)
    if (useKeys) await assertKeystrokeTarget(locator, `selector "${selector}"`)
    await locator.click({ timeout: 10000 })
    await writeInto(locator)
    if (!useKeys) {
      return { mode: 'selector', selector, value, summary: `填写 selector "${selector}" <- "${value}"` }
    }
    return {
      mode: 'selector',
      selector,
      value,
      inputMode: 'keystrokes',
      chars,
      delayMs,
      summary: keystrokeSummary(`selector "${selector}"`),
    }
  }

  const x = Number(target.x)
  const y = Number(target.y)
  await assertPointInViewport(page, x, y)
  await page.mouse.click(x, y)
  await page.keyboard.type(value)
  return { mode: 'point', x, y, value, summary: `填写坐标 (${x}, ${y}) <- "${value}"` }
}

/**
 * 取元素中心点：等可见、滚入视口（拖拽源还要先悬停）后读 boundingBox。
 * 元素不可见或零尺寸时报错，不静默把拖拽落到别处。
 * @param {import('playwright-core').Locator} locator - 元素定位器
 * @param {string} label - 报错主语
 * @param {boolean} [hoverFirst] - 是否先悬停到位（拖拽源元素用）
 * @returns {Promise<{x: number, y: number}>} 视口 CSS 像素中心点
 */
async function elementCenter(locator, label, hoverFirst = false) {
  await locator.waitFor({ state: 'visible', timeout: 5000 })
  await locator.scrollIntoViewIfNeeded()
  if (hoverFirst) await locator.hover({ timeout: 10000 })
  const box = await locator.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`${label}没有可见尺寸，无法定位拖拽点，请改用 selector/ref 指向可见元素或改用 x + y`)
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** 拖拽返回值 / 摘要里的单侧目标描述。 */
function dragTargetText(target) {
  if (target.mode === 'ref') return `${target.ref} (${target.tag} "${target.name}")`
  if (target.mode === 'selector') return `selector "${target.selector}"`
  return `(${target.x}, ${target.y})`
}

/** 拖拽返回值里的单侧目标：按定位分支只带对应字段。 */
function dragTargetPayload(target) {
  if (target.mode === 'ref') return { ref: target.ref, tag: target.tag, name: target.name }
  if (target.mode === 'selector') return { selector: target.selector }
  return { x: target.x, y: target.y }
}

/**
 * 解析拖拽的一侧目标并在按下鼠标之前完成全部预检：
 * ref 查表 + 复验、selector 等可见、坐标校验越界。
 */
async function resolveDragTarget(page, tab, side) {
  const target = requireTarget(side.options, side.label, '拖拽错元素')
  if (target.ref) {
    const item = assertRefBelongsToTab(tab.refs, target.ref)
    await revalidateRef(page, item, target.ref)
    return {
      mode: 'ref',
      ref: target.ref,
      tag: item.tag,
      name: item.name,
      locator: page.locator(`xpath=${item.xpath}`),
    }
  }
  if (target.selector) {
    const locator = page.locator(target.selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    return { mode: 'selector', selector: target.selector, locator }
  }
  const x = Number(side.options.x)
  const y = Number(side.options.y)
  await assertPointInViewport(page, x, y)
  return { mode: 'point', x, y }
}

/**
 * 悬停：把真实鼠标移到目标上，触发 CSS :hover 与 mouseover / mouseenter。
 * 三种目标三选一，判定口径与 click 一致；settleMs 为动作完成后的等待。
 * @param {object} session - 会话状态
 * @param {{ref?: string, selector?: string, x?: number, y?: number, settleMs?: number}} target - 目标与等待时长
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 悬停结果
 */
export async function hover(session, target = {}, tabId) {
  const { ref, selector } = requireTarget(target, '悬停', '悬停到错误元素')
  const settleMs = readSettleMs(target.settleMs)
  const tab = currentTab(session, tabId)
  const page = tab.page

  if (ref) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    await revalidateRef(page, item, ref)
    const locator = page.locator(`xpath=${item.xpath}`)
    await locator.scrollIntoViewIfNeeded()
    await locator.hover({ timeout: 10000 })
    if (settleMs > 0) await page.waitForTimeout(settleMs)
    return {
      mode: 'ref',
      ref,
      tag: item.tag,
      name: item.name,
      settleMs,
      summary: `悬停 ${ref} (${item.tag} "${item.name}")`,
    }
  }

  if (selector) {
    const locator = page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    await locator.hover({ timeout: 10000 })
    if (settleMs > 0) await page.waitForTimeout(settleMs)
    return { mode: 'selector', selector, settleMs, summary: `悬停 selector "${selector}"` }
  }

  const x = Number(target.x)
  const y = Number(target.y)
  await assertPointInViewport(page, x, y)
  await page.mouse.move(x, y)
  if (settleMs > 0) await page.waitForTimeout(settleMs)
  return { mode: 'point', x, y, settleMs, summary: `悬停坐标 (${x}, ${y})` }
}

/**
 * 拖拽：from / to 各是一个三选一目标。
 * - 两侧都是元素：locator.dragTo，由 Playwright 完成真实的按下 / 插值移动 / 释放，
 *   Chromium 下会转成原生 dragenter / dragover / drop，覆盖 HTML5 draggable 与 pointer 事件页面。
 * - 任一侧是坐标：手写 page.mouse 序列，源元素先悬停 + 读中心，目标用 steps 次插值移动后释放。
 * 按下后异常一定补 mouse.up()，避免按键卡在按下状态污染后续调用。
 * @param {object} session - 会话状态
 * @param {object} [options] - from / to 目标与 steps / settleMs
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 拖拽结果
 */
export async function drag(session, options = {}, tabId) {
  const steps = readSteps(options.steps)
  const settleMs = readSettleMs(options.settleMs)
  const tab = currentTab(session, tabId)
  const page = tab.page
  const from = await resolveDragTarget(page, tab, { options: options.from, label: '拖拽起点（from）' })
  const to = await resolveDragTarget(page, tab, { options: options.to, label: '拖拽终点（to）' })
  const path = from.mode !== 'point' && to.mode !== 'point' ? 'dragTo' : 'mouse'

  if (path === 'dragTo') {
    try {
      await from.locator.dragTo(to.locator, { steps, timeout: 10000 })
    } catch (error) {
      // dragTo 在源已按下、目标重试失败时没有兜底释放，补一次再原样抛出。
      await page.mouse.up().catch(() => {})
      throw error
    }
  } else {
    let pressed = false
    try {
      if (from.mode === 'point') {
        await page.mouse.move(from.x, from.y)
      } else {
        const center = await elementCenter(from.locator, '拖拽起点（from）', true)
        await page.mouse.move(center.x, center.y)
      }
      await page.mouse.down()
      pressed = true
      if (to.mode === 'point') {
        await page.mouse.move(to.x, to.y, { steps })
      } else {
        const center = await elementCenter(to.locator, '拖拽终点（to）')
        await page.mouse.move(center.x, center.y, { steps })
      }
      await page.mouse.up()
      pressed = false
    } finally {
      if (pressed) await page.mouse.up().catch(() => {})
    }
  }

  if (settleMs > 0) await page.waitForTimeout(settleMs)
  return {
    fromMode: from.mode,
    toMode: to.mode,
    path,
    steps,
    settleMs,
    from: dragTargetPayload(from),
    to: dragTargetPayload(to),
    summary: `拖拽 ${dragTargetText(from)} → ${dragTargetText(to)}（steps=${steps}）`,
  }
}

/** 上传 files 形态归一：单个字符串当单元素数组；数组逐项必须是非空字符串。 */
function normalizeUploadFiles(files) {
  if (files === undefined) {
    throw new Error('缺少必填参数 files（绝对路径字符串或其数组）')
  }
  if (typeof files === 'string') {
    if (files.length === 0) {
      throw new Error('缺少必填参数 files（绝对路径字符串或其数组）')
    }
    return [files]
  }
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file !== 'string' || file.length === 0) {
        throw new Error(`files 里有一项不是非空字符串：${JSON.stringify(file)}；请传宿主上的绝对路径`)
      }
    }
    return files
  }
  throw new Error(`files 需要绝对路径字符串或其数组，收到 ${JSON.stringify(files)}`)
}

/**
 * 宿主侧路径校验（只读）：数量、绝对路径、存在、是普通文件、可读、总大小。
 * 顺序固定，任一失败即抛错，不静默跳过；路径原样交给后续下发，不复制、不改写文件内容。
 */
function resolveUploadFiles(files, maxBytes) {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new Error(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件，收到 ${files.length} 个；请分批上传`)
  }
  const resolved = []
  let totalBytes = 0
  for (const filePath of files) {
    if (!isAbsolute(filePath)) {
      throw new Error(`文件路径必须是绝对路径：${filePath}；请给出宿主上的完整路径（如 C:\\tmp\\a.txt）`)
    }
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      throw new Error(`文件不存在：${filePath}；请确认路径拼写，并确认文件在运行插件的这台机器上`)
    }
    if (!stat.isFile()) {
      throw new Error(`路径不是文件：${filePath}；请指向具体文件（目录上传不在本工具范围）`)
    }
    try {
      accessSync(filePath, fsConstants.R_OK)
    } catch {
      throw new Error(`文件不可读（宿主权限不足）：${filePath}；请检查文件 ACL，或换一个文件`)
    }
    totalBytes += stat.size
    resolved.push({ path: filePath, name: basename(filePath), size: stat.size })
  }
  if (totalBytes > maxBytes) {
    throw new Error(`文件总大小 ${totalBytes} 字节超过上限 maxBytes=${maxBytes} 字节；请提高 maxBytes（上限 ${MAX_UPLOAD_BYTES}）或换更小的文件`)
  }
  return { files: resolved, totalBytes }
}

/** 读文件控件信息；元素已从页面移除时抛「目标文件控件不可用」。 */
async function fileInputInfo(locator, label) {
  let info
  try {
    info = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      let visible = rect.width > 0 && rect.height > 0
      if (visible && typeof el.checkVisibility === 'function') {
        try {
          visible = el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
        } catch {
          // 参数不被旧内核支持时保留正尺寸判定
        }
      }
      return {
        tag: String(el.tagName || '').toLowerCase(),
        type: String(el.type || '').toLowerCase(),
        disabled: el.disabled === true,
        multiple: el.multiple === true,
        accept: typeof el.accept === 'string' ? el.accept : '',
        count: el.files ? el.files.length : 0,
        visible,
      }
    })
  } catch {
    throw new Error(`目标文件控件不可用：${label}；请重新 browser_e2e_snapshot 后重试`)
  }
  return info
}

/** 该控件不支持多选时的统一报错。 */
function multipleUnsupportedError(names) {
  return new Error(`该控件不支持多选（没有 multiple 属性），收到 ${names.length} 个文件：${names.join('、')}；请只传 1 个文件，或改用支持多选的控件`)
}

/** 控件类型 / disabled / 多选三条校验。 */
function assertFileInput(info, label, names) {
  if (info.tag !== 'input') {
    throw new Error(`目标不是文件控件：${label} 是 ${info.tag}；本工具只接受 input[type=file]，请先用 browser_e2e_snapshot 找到文件控件，再传它的 selector`)
  }
  if (info.type !== 'file') {
    throw new Error(`目标是 input[type=${info.type}]，不是文件控件；请传 input[type=file] 的 selector`)
  }
  if (info.disabled) {
    throw new Error(`文件控件已禁用（disabled）：${label}；页面不会接受这次选择，请先解除禁用或换一个控件`)
  }
  if (names.length > 1 && !info.multiple) {
    throw multipleUnsupportedError(names)
  }
}

/** clear=false 时只在控件没有选择时设置；Playwright 无法把已选 File 还原成宿主路径，因此不支持追加。 */
function assertClearable(info, clear) {
  if (clear !== false || info.count === 0) return
  throw new Error(`控件已选择 ${info.count} 个文件，clear=false 不会覆盖；要替换请传 clear: true，要清空请传 files: [] 且 clear: true`)
}

/** 设置后尽力读回当前选择；元素已移除或页面脚本清空都不算失败，返回 null。 */
async function readSelectedFiles(locator) {
  try {
    return await locator.evaluate((el) => ({
      count: el.files ? el.files.length : 0,
      names: el.files ? Array.from(el.files).map((file) => file.name) : [],
    }))
  } catch {
    return null
  }
}

/** 首行摘要里列文件：超过 5 个只列前 5 个，避免把长清单灌进上下文。 */
function describeUploadFiles(files) {
  const listed = files.slice(0, 5).map((file) => `${file.name}（${file.size} 字节）`).join('、')
  return files.length > 5 ? `${listed}、等 ${files.length} 个文件` : listed
}

/**
 * 拼装上传能力返回值。`selected` 是设置后读回的文件数（读不到为 null），
 * 只供工具层在第二行补「页面当前选择 N 个文件」。
 */
async function buildUploadResult({ mode, ref, selector, x, y, locator, label, info, resolved }) {
  const previousCount = info.count
  const cleared = resolved.files.length === 0
  const replaced = cleared ? 0 : previousCount
  const readback = await readSelectedFiles(locator)
  const files = resolved.files.map((file) => ({ name: file.name, size: file.size }))
  const result = {
    mode,
    files,
    totalBytes: resolved.totalBytes,
    multiple: info.multiple,
    accept: info.accept,
    visible: info.visible,
    replaced,
    cleared,
    selected: readback && Number.isInteger(readback.count) ? readback.count : null,
    summary: cleared
      ? (previousCount > 0 ? `清空 ${label} 的 ${previousCount} 个已选文件` : `控件本来没有已选文件（${label}）`)
      : `上传 ${files.length} 个文件到 ${label}：${describeUploadFiles(files)}`,
  }
  if (ref) result.ref = ref
  if (selector) result.selector = selector
  if (mode === 'point') {
    result.x = x
    result.y = y
  }
  return result
}

/**
 * 上传本地文件到 input[type=file]。三种目标三选一：
 * - ref：复用 ref 表并复验，控件必须有可见尺寸（与 click / fill 同口径）；
 * - selector：只要求 attached，允许被 display:none 隐藏后再由 label 触发；
 * - x + y：真实点击该坐标，在 5000ms 内接住浏览器弹出的文件选择器。
 *
 * 只接受 input[type=file]，不做 label 下钻、不校验 accept、不复制文件内容；
 * 空数组表示清空选择。上传完成后不点提交、不等待上传请求。
 * @param {object} session - 会话状态
 * @param {{ref?: string, selector?: string, x?: number, y?: number}} target - 目标控件
 * @param {string|string[]} files - 宿主上的绝对路径；空数组表示清空
 * @param {{maxBytes?: number, clear?: boolean}} [options] - 总大小上限与覆盖语义
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 上传结果
 */
export async function upload(session, target = {}, files, options = {}, tabId) {
  const { ref, selector, hasPoint } = targetOf(target, 'upload')
  const clear = options.clear ?? true
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`maxBytes 必须是 1..${MAX_UPLOAD_BYTES} 的整数，收到 ${JSON.stringify(options.maxBytes)}`)
  }
  const requested = normalizeUploadFiles(files)
  // 纯参数互斥：x + y 要先点击才读得到当前选择，因此不支持 clear=false；
  // 空 files + clear=false 什么也不做，直接报错让调用方明确意图。
  if (clear === false && hasPoint) {
    throw new Error('x + y 路径不支持 clear=false（要先点击才能读到控件当前选择）；请改用 ref / selector')
  }
  if (requested.length === 0 && clear === false) {
    throw new Error('files 为空且 clear=false：不会改变当前选择；要清空已选文件请传 clear: true')
  }
  const resolved = resolveUploadFiles(requested, maxBytes)
  const tab = currentTab(session, tabId)
  const page = tab.page
  const paths = resolved.files.map((file) => file.path)
  const names = resolved.files.map((file) => file.name)

  if (ref) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    await revalidateRef(page, item, ref)
    const locator = page.locator(`xpath=${item.xpath}`)
    const label = `ref ${ref}`
    const info = await fileInputInfo(locator, label)
    assertFileInput(info, label, names)
    assertClearable(info, clear)
    await locator.setInputFiles(paths, { timeout: 10000 })
    return buildUploadResult({ mode: 'ref', ref, locator, label, info, resolved })
  }

  if (selector) {
    const locator = page.locator(selector)
    try {
      await locator.waitFor({ state: 'attached', timeout: 5000 })
    } catch (error) {
      const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message ?? error))
      if (!isTimeout) throw error
      throw new Error(`选择器 "${selector}" 在 5000ms 内没有匹配到元素；请先用 browser_e2e_snapshot 确认文件控件的选择器`)
    }
    const label = `selector "${selector}"`
    const info = await fileInputInfo(locator, label)
    assertFileInput(info, label, names)
    assertClearable(info, clear)
    await locator.setInputFiles(paths, { timeout: 10000 })
    return buildUploadResult({ mode: 'selector', selector, locator, label, info, resolved })
  }

  const x = Number(target.x)
  const y = Number(target.y)
  const label = `坐标 (${x}, ${y})`
  await assertPointInViewport(page, x, y)
  // 先建 promise 并挂 catch：点击后页面若没打开选择器，底层拒绝不会变成未处理拒绝。
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 })
  chooserPromise.catch(() => {})
  await page.mouse.click(x, y)
  let chooser
  try {
    chooser = await chooserPromise
  } catch {
    throw new Error(`点击坐标 (${x}, ${y}) 后 5000ms 内没有出现文件选择器；请确认该位置会打开文件选择，或改用 ref / selector`)
  }
  const element = chooser.element()
  const info = await fileInputInfo(element, label)
  if (info.tag !== 'input' || info.type !== 'file') {
    throw new Error(`坐标 (${x}, ${y}) 处打开的文件选择器不属于 input[type=file]（${info.tag}）；请改用 ref / selector`)
  }
  if (names.length > 1 && !(await chooser.isMultiple())) {
    throw multipleUnsupportedError(names)
  }
  await chooser.setFiles(paths, { timeout: 10000 })
  return buildUploadResult({ mode: 'point', x, y, locator: element, label, info, resolved })
}

/**
 * 滚动页面。有 x / y 时先移动鼠标到该坐标再滚；否则在当前位置滚动。
 * @param {object} session - 会话状态
 * @param {object} [options] - 滚动增量与光标位置
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 滚动结果
 */
export async function scroll(session, options = {}, tabId) {
  const page = currentTab(session, options.tab_id ?? tabId).page
  const deltaX = Number(options.delta_x ?? 0)
  const deltaY = Number(options.delta_y ?? 0)
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new Error(`delta_x / delta_y 必须是数字，收到 delta_x=${options.delta_x}, delta_y=${options.delta_y}`)
  }
  if (deltaX === 0 && deltaY === 0) {
    throw new Error('delta_x / delta_y 至少有一个非 0，否则页面不会滚动')
  }
  const hasPoint = Number.isFinite(options.x) && Number.isFinite(options.y)
  if (hasPoint) {
    const x = Number(options.x)
    const y = Number(options.y)
    await assertPointInViewport(page, x, y)
    await page.mouse.move(x, y)
  }
  await page.mouse.wheel(deltaX, deltaY)
  session.touch()
  return {
    mode: 'scroll',
    deltaX,
    deltaY,
    summary: `滚动页面 (${deltaX}, ${deltaY})`,
  }
}

/**
 * 键盘按键：单次按下并抬起（缺省）、只按下保持（down）、只释放（up）。
 *
 * 按住状态记在标签页条目的 `heldKeys` 上，供随后的 click / fill 自然继承修饰键；
 * `navigate` 在 goto 前释放，忘记 up 的键会一直影响后续输入（规格明确不设自动计时）。
 * @param {object} session - 会话状态
 * @param {string} keyName - Playwright 按键名；press 允许组合键，down / up 只允许单个键
 * @param {string} [tabId] - 标签页 id
 * @param {{action?: 'press'|'down'|'up', repeat?: number}} [options] - 动作与重复次数
 * @returns {Promise<object>} `{ key, action, repeat, held, summary }`
 */
export async function press(session, keyName, tabId, options = {}) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  const opts = options ?? {}
  const action = opts.action ?? 'press'
  if (!PRESS_ACTIONS.includes(action)) {
    throw new Error(`action 只支持 press / down / up，收到 "${action}"`)
  }
  const repeat = opts.repeat ?? 1
  if (!Number.isInteger(repeat) || repeat < MIN_PRESS_REPEAT || repeat > MAX_PRESS_REPEAT) {
    throw new Error(`repeat 必须是 ${MIN_PRESS_REPEAT}-${MAX_PRESS_REPEAT} 的整数，收到 ${repeat}`)
  }
  if (action !== 'press' && opts.repeat !== undefined) {
    throw new Error('repeat 只对 action=press 生效；action=down / up 时请去掉 repeat')
  }
  if (action !== 'press' && keyName.includes('+')) {
    throw new Error('action=down / up 的 key 必须是单个按键名（如 Shift、a、Enter）；组合键请用 action=press，例如 key: "Control+A"')
  }
  if (!(tab.heldKeys instanceof Set)) tab.heldKeys = new Set()

  if (action === 'down') {
    await page.keyboard.down(keyName)
    tab.heldKeys.add(keyName)
    return {
      key: keyName,
      action,
      repeat,
      held: true,
      summary: `按下 ${keyName}（保持按住；释放需 action=up）`,
    }
  }

  if (action === 'up') {
    await page.keyboard.up(keyName)
    tab.heldKeys.delete(keyName)
    return { key: keyName, action, repeat, held: false, summary: `释放 ${keyName}` }
  }

  for (let index = 0; index < repeat; index += 1) {
    await page.keyboard.press(keyName)
  }
  return {
    key: keyName,
    action,
    repeat,
    held: tab.heldKeys.has(keyName),
    summary: `按键 ${keyName}${repeat > 1 ? ` ×${repeat}` : ''}`,
  }
}

/**
 * 页内 HTML 白名单净化：移除可执行元素与事件属性，保留下载外的常规排版。
 *
 * 只保证「不把可执行元素与事件属性交给页面」，不是完整 XSS 过滤器；
 * 需要验证被测应用自身净化逻辑时用 sanitize: false（仅 isolated）。
 * @param {string} html - 原始 HTML 片段
 * @returns {string} 清理后的 body.innerHTML
 */
function sanitizeClipboardHtmlInPage(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocked = [
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input',
    'button', 'select', 'textarea', 'template', 'noscript', 'meta', 'link', 'base', 'svg', 'math',
  ]
  for (const tag of blocked) {
    for (const el of Array.from(doc.querySelectorAll(tag))) el.remove()
  }
  const urlAttrs = ['href', 'src', 'xlink:href']
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action') {
        el.removeAttribute(attr.name)
        continue
      }
      if (!urlAttrs.includes(name)) continue
      const value = String(attr.value).replace(/^[\s\u0000]+/, '').toLowerCase()
      if (value.startsWith('javascript:') || value.startsWith('data:') || value.startsWith('vbscript:')) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return doc.body.innerHTML
}

/**
 * 页内粘贴投递：DataTransfer + ClipboardEvent 派发到目标元素。
 *
 * 返回值只含观测结果（页面是否 preventDefault、是否走 input/textarea 兜底插入），
 * 不在页内抛错，由宿主按固定文案转成中文错误。
 * @param {Element} el - 粘贴目标元素
 * @param {{text: string, html: string|null}} payload - 已净化的口味
 * @returns {object} `{ failed, accepted, inserted, tag, name }`
 */
function clipboardPasteInElement(el, payload) {
  el.focus?.()
  const data = new DataTransfer()
  data.setData('text/plain', payload.text)
  if (payload.html !== null) data.setData('text/html', payload.html)
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
  if (event.clipboardData === null) {
    try {
      Object.defineProperty(event, 'clipboardData', { value: data })
    } catch {
      // 覆盖失败时由下面的统一判定返回 failed
    }
  }
  if (event.clipboardData === null) {
    return { failed: true, accepted: false, inserted: false, tag: String(el.tagName || '').toLowerCase(), name: '' }
  }
  const accepted = el.dispatchEvent(event) === false
  let inserted = false
  if (!accepted) {
    const tag = String(el.tagName || '').toLowerCase()
    const type = String(el.type || '').toLowerCase()
    const writable = tag === 'textarea'
      || (tag === 'input' && type !== 'file' && type !== 'checkbox' && type !== 'radio')
    if (writable) {
      const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      const current = typeof el.value === 'string' ? el.value : ''
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : current.length
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start
      const next = current.slice(0, start) + payload.text + current.slice(end)
      if (setter) setter.call(el, next)
      else el.value = next
      el.dispatchEvent(new Event('input', { bubbles: true }))
      inserted = true
    }
  }
  return {
    failed: false,
    accepted,
    inserted,
    tag: String(el.tagName || '').toLowerCase(),
    name: typeof el.getAttribute === 'function' ? (el.getAttribute('name') ?? '') : '',
  }
}

/**
 * 页内剪贴板写入：探测安全上下文后调 navigator.clipboard.write。
 * text 为 null 时纯文本口味由 html 的 innerText 推导。
 * @param {{text: string|null, html: string|null}} payload - 已净化的口味
 * @returns {Promise<object>} 状态与长度（不回传内容）
 */
async function clipboardWriteInPage(payload) {
  if (window.isSecureContext !== true || typeof navigator.clipboard?.write !== 'function') {
    return { status: 'insecure-context', origin: String(location.origin) }
  }
  let plain = payload.text
  let plainDerived = false
  if (plain === null) {
    const doc = new DOMParser().parseFromString(payload.html, 'text/html')
    plain = doc.body.innerText ?? doc.body.textContent ?? ''
    plainDerived = true
  }
  const flavors = { 'text/plain': new Blob([plain], { type: 'text/plain' }) }
  if (payload.html !== null) flavors['text/html'] = new Blob([payload.html], { type: 'text/html' })
  try {
    await navigator.clipboard.write([new ClipboardItem(flavors)])
  } catch (error) {
    return {
      status: 'rejected',
      name: String(error?.name ?? ''),
      message: String(error?.message ?? error),
    }
  }
  return {
    status: 'ok',
    plainChars: plain.length,
    htmlChars: payload.html === null ? 0 : payload.html.length,
    plainDerived,
  }
}

/**
 * isolated 模式写入前授予该页面所属上下文 clipboard-write；cdp 不改用户浏览器权限。
 *
 * 每次写入都授予：Playwright 的 grantPermissions 是整表授予，测试授予过 clipboard-read
 * 后必须重新授予 clipboard-write 才写得进去（见功能规格 0024「边界」）。
 * @param {import('playwright-core').Page} page - 页面对象
 * @returns {Promise<void>}
 */
async function grantClipboardWrite(page) {
  try {
    await page.context().grantPermissions(['clipboard-write'])
  } catch {
    // 授权失败不提前报错：实际写入时的 NotAllowedError 会带上可诊断信息
  }
}

/** 读取剪贴板载荷：非字符串直接报错；空串按未给处理。 */
function readClipboardPayload(options) {
  const input = options ?? {}
  if (input.text !== undefined && typeof input.text !== 'string') {
    throw new Error(`text 必须是字符串，收到 ${JSON.stringify(input.text)}`)
  }
  if (input.html !== undefined && typeof input.html !== 'string') {
    throw new Error(`html 必须是字符串，收到 ${JSON.stringify(input.html)}`)
  }
  return {
    text: typeof input.text === 'string' && input.text.length > 0 ? input.text : null,
    html: typeof input.html === 'string' && input.html.length > 0 ? input.html : null,
  }
}

/** 载荷长度按 UTF-16 码元校验。 */
function assertClipboardLimits(text, html) {
  if (text !== null && text.length > CLIPBOARD_TEXT_LIMIT) {
    throw new Error(`一次最多投递 ${CLIPBOARD_TEXT_LIMIT} 个字符（收到 ${text.length} 个）；请拆分内容后分多次操作`)
  }
  if (html !== null && html.length > CLIPBOARD_HTML_LIMIT) {
    throw new Error(`一次最多投递 ${CLIPBOARD_HTML_LIMIT} 个 HTML 字符（收到 ${html.length} 个）；请裁剪 HTML 或改用 text`)
  }
}

/** 摘要里的目标描述，与 click / fill 的目标文案同风格。 */
function describeClipboardTarget(target) {
  if (target.mode === 'ref') return `ref ${target.ref} (${target.tag} "${target.name}")`
  if (target.mode === 'selector') return `selector "${target.selector}"`
  return '当前焦点元素'
}

/**
 * 剪贴板写入与粘贴投递。
 *
 * - action=write：把 text 与可选 html 写进浏览器剪贴板；isolated 自动授予 clipboard-write，
 *   cdp 不授权。纯文本为空而 html 非空时由净化后 HTML 的 innerText 推导。
 * - action=paste：向 ref / selector / 当前焦点元素派发带 text/plain、text/html 的 paste 事件；
 *   页面未消费且目标是 input / textarea 时在选区处插入文本并派发 input。
 * 不提供系统快捷键粘贴（method=system），也不回读剪贴板内容。
 * @param {object} session - 会话状态
 * @param {object} options - action / text / html / sanitize / ref / selector
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 写入或投递结果
 */
export async function clipboard(session, options = {}, tabId) {
  const input = options ?? {}
  const action = input.action
  if (action !== 'write' && action !== 'paste') {
    throw new Error(`action 只支持 write / paste，收到 ${JSON.stringify(action)}`)
  }
  const { text, html } = readClipboardPayload(input)
  const sanitize = input.sanitize !== false
  if (!sanitize && session.mode === 'cdp') {
    throw new Error('sanitize=false 只在 isolated 模式可用：cdp 接管的是用户真实浏览器，不能把未过滤的 HTML 交给页面；请改用 sanitize=true 或 isolated 模式')
  }

  if (action === 'write') {
    if (input.ref !== undefined || input.selector !== undefined) {
      throw new Error('action=write 不作用页面元素：请去掉 ref / selector（写剪贴板不需要目标）')
    }
    if (text === null && html === null) {
      throw new Error('action=write 需要 text 或 html 至少一个非空值；例如 text: "hello" 或 html: "<b>hi</b>"')
    }
    assertClipboardLimits(text, html)
    const tab = currentTab(session, tabId)
    const page = tab.page
    const effectiveHtml = html !== null && sanitize
      ? await page.evaluate(sanitizeClipboardHtmlInPage, html)
      : html
    if (session.mode !== 'cdp') await grantClipboardWrite(page)
    const result = await page.evaluate(clipboardWriteInPage, { text, html: effectiveHtml })
    if (result.status === 'insecure-context') {
      throw new Error(`当前页面不是安全上下文（${result.origin}），浏览器不提供剪贴板写入 API；请改用 action=paste（合成粘贴事件不依赖安全上下文），或在 https / localhost 页面重试`)
    }
    if (result.status === 'rejected') {
      const name = result.name || 'Error'
      if (name === 'NotAllowedError' && session.mode === 'cdp') {
        throw new Error(`页面拒绝写剪贴板（NotAllowedError）：${result.message}；cdp 模式不会自动改你的浏览器权限，请在该站点手动允许写剪贴板，或改用 action=paste`)
      }
      throw new Error(`写入剪贴板失败（${name}）：${result.message}`)
    }
    const summary = effectiveHtml === null
      ? `写入剪贴板：纯文本 ${result.plainChars} 个字符`
      : result.plainDerived
        ? `写入剪贴板：富文本 HTML（${result.htmlChars} 字符），纯文本由 HTML 推导（${result.plainChars} 个字符）`
        : `写入剪贴板：富文本 HTML（${result.htmlChars} 字符）+ 纯文本 ${result.plainChars} 个字符`
    return {
      action: 'write',
      tabId: tab.id,
      rich: effectiveHtml !== null,
      plainChars: result.plainChars,
      htmlChars: result.htmlChars,
      plainDerived: result.plainDerived,
      summary,
    }
  }

  if (text === null) {
    throw new Error('action=paste 需要非空 text（页面没有可消费的纯文本口味）')
  }
  const ref = typeof input.ref === 'string' && input.ref.length > 0 ? input.ref : null
  const selector = typeof input.selector === 'string' && input.selector.length > 0 ? input.selector : null
  if (ref !== null && selector !== null) {
    throw new Error('粘贴目标只能给一种：ref / selector 二选一（都不给时用当前焦点元素）')
  }
  assertClipboardLimits(text, html)
  const tab = currentTab(session, tabId)
  const page = tab.page
  const effectiveHtml = html !== null && sanitize
    ? await page.evaluate(sanitizeClipboardHtmlInPage, html)
    : html

  let element
  let target
  if (ref !== null) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    await revalidateRef(page, item, ref)
    element = await page.locator(`xpath=${item.xpath}`).elementHandle()
    target = { mode: 'ref', ref, tag: item.tag, name: item.name }
  } else if (selector !== null) {
    const locator = page.locator(selector)
    try {
      await locator.waitFor({ state: 'attached', timeout: 5000 })
    } catch (error) {
      const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message ?? error))
      if (!isTimeout) throw error
      throw new Error(`选择器 "${selector}" 在 5000ms 内没有匹配到元素；请先用 browser_e2e_snapshot 确认粘贴目标的选择器`)
    }
    element = await locator.elementHandle()
    target = { mode: 'selector', selector }
  } else {
    const handle = await page.evaluateHandle(() => document.activeElement)
    element = handle.asElement()
    const tag = element === null
      ? 'null'
      : await element.evaluate((el) => String(el.tagName || '').toLowerCase())
    if (element === null || tag === 'body' || tag === 'html') {
      throw new Error(`当前没有可粘贴的焦点元素（activeElement 是 ${tag}）；请给 ref 或 selector，或先 browser_e2e_click 聚焦目标`)
    }
    target = { mode: 'focused', tag }
  }

  const result = await element.evaluate(clipboardPasteInElement, { text, html: effectiveHtml })
  if (result.failed) {
    throw new Error('当前页面无法构造带数据的 paste 事件（ClipboardEvent.clipboardData 不可写）；请改用 browser_e2e_evaluate 自建事件，或升级 Edge')
  }
  if (target.mode !== 'ref') {
    target.tag = result.tag
    if (result.name) target.name = result.name
  }
  const rich = effectiveHtml !== null
  const htmlChars = rich ? effectiveHtml.length : undefined
  const summary = `粘贴到 ${describeClipboardTarget(target)}：${text.length} 个字符`
    + (rich ? `（含 HTML，${htmlChars} 字符）` : '')
    + (result.accepted ? '；页面已消费 paste 事件' : '；页面没有消费 paste 事件')
    + (result.inserted ? '；已在光标处插入文本' : '')
  const output = {
    action: 'paste',
    tabId: tab.id,
    target,
    chars: text.length,
    rich,
    sanitized: rich && sanitize,
    accepted: result.accepted,
    inserted: result.inserted,
    summary,
  }
  if (rich) output.htmlChars = htmlChars
  return output
}

/** 在 limitMs 内等待 promise：按时完成回 true，超时或失败回 false（不抛错）。 */
export function settleWithin(promise, limitMs) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), limitMs)
    timer.unref?.()
  })
  return Promise.race([promise.then(() => true, () => false), guard])
    .finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 中断页面主线程当前正在执行的脚本：向已建立的 CDP 会话下发 `Runtime.terminateExecution`。
 *
 * 该命令由渲染进程主线程派发，若在死循环开始后才新建会话，命令会一直排队（实测 >5s 不返回）；
 * 因此调用方必须在发起 page.evaluate 之前建好会话。失败不抛错，由调用方决定文案。
 */
async function interruptPageScript(cdp) {
  try {
    const settled = await settleWithin(cdp.send('Runtime.terminateExecution'), 1000)
    if (!settled) return { ok: false, reason: 'Runtime.terminateExecution 未在 1000ms 内完成' }
    return { ok: true, reason: '' }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
  }
}

/** 在页面上下文执行 JavaScript 表达式并返回结果；超时到点中断页内脚本并报错。 */
export async function evaluate(session, expression, tabId, options = {}) {
  const page = currentTab(session, tabId).page
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_EVALUATE_TIMEOUT_MS || timeoutMs > MAX_EVALUATE_TIMEOUT_MS) {
    throw new Error(`timeoutMs 必须是 ${MIN_EVALUATE_TIMEOUT_MS} 到 ${MAX_EVALUATE_TIMEOUT_MS} 之间的整数（毫秒），收到 ${timeoutMs}`)
  }
  // 先建 CDP 会话再发起求值：死循环期间新建的会话下发终止命令会排队（见 interruptPageScript）。
  let cdp = null
  let cdpError = ''
  try {
    cdp = await page.context().newCDPSession(page)
  } catch (error) {
    cdpError = String(error?.message ?? error).slice(0, 200)
  }
  const started = Date.now()
  const pending = page.evaluate(expression)
  let timer = null
  const timeoutError = new Error('脚本求值超时（内部标记，不对外）')
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs)
    timer.unref?.()
  })
  try {
    const value = await Promise.race([pending, timeout])
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    return { value, elapsedMs: Date.now() - started, timeoutMs, summary: `求值 JS 表达式（返回 ${type}）` }
  } catch (error) {
    if (error !== timeoutError) throw error
    const elapsedMs = Date.now() - started
    const interrupted = cdp === null
      ? { ok: false, reason: cdpError || '无法新建 CDP 会话' }
      : await interruptPageScript(cdp)
    if (interrupted.ok) {
      throw new Error(`脚本执行超时：实际执行 ${elapsedMs}ms（上限 ${timeoutMs}ms）；已中断页面主线程正在执行的脚本，页面与标签页保持打开。等待永不返回的 Promise 不会被中断；如脚本本应更久，请提高 timeoutMs（上限 ${MAX_EVALUATE_TIMEOUT_MS}）后重试`)
    }
    throw new Error(`脚本执行超时：实际执行 ${elapsedMs}ms（上限 ${timeoutMs}ms）；未能中断页面内脚本（${interrupted.reason}），页面可能仍在执行该脚本；请重新 browser_e2e_snapshot 确认页面状态，或 browser_e2e_close 后重开浏览器`)
  } finally {
    if (timer) clearTimeout(timer)
    if (cdp) await settleWithin(cdp.detach(), 500)
  }
}

/** browser_e2e_wait 的 selector 状态。 */
const WAIT_STATES = ['attached', 'visible', 'hidden', 'detached']

/** url / response 条件共用的 URL 匹配方式。 */
const URL_MATCH_MODES = ['includes', 'glob', 'regex']

/** url 条件的轮询间隔（毫秒）。 */
const WAIT_POLL_MS = 100

/** response 条件缺省的状态码区间。 */
export const WAIT_STATUS_MIN = 100
export const WAIT_STATUS_MAX = 599

/** waitFor 缺省的等待超时（毫秒）。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 10000

/** 超时错误里每类诊断列表最多列出的条数。 */
const WAIT_DIAG_LIMIT = 3

/** 等待用的休眠。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 glob 编译成整串锚定的正则：`**` 任意字符（含 /）、`*` 非 / 的任意个、`?` 单个非 / 字符。 */
function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** 按 urlMatch 生成 `(url) => boolean`；regex 编译失败在入口报错。 */
function urlMatcherOf(pattern, mode) {
  if (mode === 'includes') return (url) => url.includes(pattern)
  if (mode === 'glob') {
    const regexp = globToRegExp(pattern)
    return (url) => regexp.test(url)
  }
  try {
    const regexp = new RegExp(pattern)
    return (url) => regexp.test(url)
  } catch (error) {
    throw new Error(`url 的正则无效（urlMatch=regex，url=${pattern}）：${error?.message ?? error}；可改用 urlMatch=includes 或修正正则`)
  }
}

/**
 * 校验并解析等待条件：selector / expression / url / response 四选一，
 * 条件专属参数错配直接报错。
 * @param {object} options - 工具入参
 * @returns {object} 归一后的条件
 */
export function waitConditionOf(options) {
  const values = {
    url: typeof options.url === 'string' && options.url.length > 0 ? options.url : '',
    response: typeof options.response === 'string' && options.response.length > 0 ? options.response : '',
    selector: typeof options.selector === 'string' && options.selector.length > 0 ? options.selector : '',
    expression: typeof options.expression === 'string' && options.expression.length > 0 ? options.expression : '',
  }
  const provided = Object.keys(values).filter((name) => values[name].length > 0)
  if (provided.length !== 1) {
    throw new Error('等待条件四选一（url / response / selector / expression），必须且只能给一个'
      + `（selector 与 expression 仍按二选一）；当前收到：${provided.length > 0 ? provided.join('、') : '无'}`)
  }
  const name = provided[0]
  const pattern = values[name]

  if (name !== 'selector' && options.state !== undefined) {
    throw new Error(`state 只对 selector 条件有效（当前是 ${name} 条件）；请移除 state，或把条件改为 selector`)
  }
  if (name !== 'url' && name !== 'response' && options.urlMatch !== undefined) {
    throw new Error(`urlMatch 只对 url / response 条件有效（当前是 ${name} 条件）`)
  }
  const hasResponseOnly = options.responseMethod !== undefined || options.statusMin !== undefined
    || options.statusMax !== undefined || options.includeBuffered !== undefined
    || options.failOnRequestFailed !== undefined
  if (name !== 'response' && hasResponseOnly) {
    throw new Error('responseMethod / statusMin / statusMax / includeBuffered / failOnRequestFailed '
      + `只对 response 条件有效（当前是 ${name} 条件）；请移除这些参数`)
  }

  if (name === 'selector') {
    const state = options.state ?? 'visible'
    if (!WAIT_STATES.includes(state)) {
      throw new Error(`不支持的 state "${state}"，可选 attached / visible / hidden / detached`)
    }
    return { name, pattern, state }
  }
  if (name === 'expression') return { name, pattern }

  const urlMatch = options.urlMatch ?? 'includes'
  if (!URL_MATCH_MODES.includes(urlMatch)) {
    throw new Error(`不支持的 urlMatch "${urlMatch}"，可选 includes / glob / regex`)
  }
  const matcher = urlMatcherOf(pattern, urlMatch)
  if (name === 'url') return { name, pattern, urlMatch, matcher }

  let responseMethod = null
  if (options.responseMethod !== undefined) {
    if (typeof options.responseMethod !== 'string' || options.responseMethod.length === 0) {
      throw new Error('responseMethod 不能是空字符串；不限制方法时不要传该参数')
    }
    responseMethod = options.responseMethod.toUpperCase()
  }
  const statusMin = options.statusMin ?? WAIT_STATUS_MIN
  const statusMax = options.statusMax ?? WAIT_STATUS_MAX
  if (!Number.isInteger(statusMin) || statusMin < WAIT_STATUS_MIN || statusMin > WAIT_STATUS_MAX
    || !Number.isInteger(statusMax) || statusMax < WAIT_STATUS_MIN || statusMax > WAIT_STATUS_MAX) {
    throw new Error(`statusMin / statusMax 必须是 ${WAIT_STATUS_MIN}-${WAIT_STATUS_MAX} 的整数，`
      + `收到 statusMin=${statusMin}、statusMax=${statusMax}`)
  }
  if (statusMin > statusMax) {
    throw new Error(`statusMin 不能大于 statusMax（收到 statusMin=${statusMin}、statusMax=${statusMax}）`)
  }
  return {
    name,
    pattern,
    urlMatch,
    matcher,
    responseMethod,
    statusMin,
    statusMax,
    includeBuffered: options.includeBuffered ?? true,
    failOnRequestFailed: options.failOnRequestFailed ?? true,
  }
}

/** 等待 selector：与既有行为一致，超时改写为「等待 selector 超时」。 */
async function waitForSelectorCondition(page, condition, timeoutMs) {
  const started = Date.now()
  try {
    await page.waitForSelector(condition.pattern, { state: condition.state, timeout: timeoutMs })
  } catch (error) {
    // 只有超时才改写成「等待超时」；非法 selector / 目标页已关闭等异常原样抛出，
    // 否则调用方会把参数错误误读成「等不到元素」。
    const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message ?? error))
    if (!isTimeout) throw error
    const elapsed = Date.now() - started
    throw new Error(`等待 selector "${condition.pattern}"（state=${condition.state}）超时：实际等待 ${elapsed}ms（上限 ${timeoutMs}ms）`)
  }
  const elapsedMs = Date.now() - started
  return {
    mode: 'selector',
    state: condition.state,
    timeoutMs,
    elapsedMs,
    summary: `等待 selector "${condition.pattern}" ${condition.state} ${elapsedMs}ms`,
  }
}

/** 等待页面内 JS 表达式返回真值：与既有行为一致，超时改写为「等待表达式超时」。 */
async function waitForExpressionCondition(page, condition, timeoutMs) {
  const started = Date.now()
  try {
    await page.waitForFunction(condition.pattern, undefined, { timeout: timeoutMs })
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message ?? error))
    if (!isTimeout) throw error
    const elapsed = Date.now() - started
    throw new Error(`等待表达式 ${condition.pattern} 超时：实际等待 ${elapsed}ms（上限 ${timeoutMs}ms）`)
  }
  const elapsedMs = Date.now() - started
  return {
    mode: 'expression',
    timeoutMs,
    elapsedMs,
    summary: `等待表达式 ${condition.pattern} ${elapsedMs}ms`,
  }
}

/** 等待主框架地址命中：先同步比一次当前地址，未命中再按 100ms 轮询。 */
async function waitForUrlCondition(page, tab, condition, timeoutMs) {
  const started = Date.now()
  const current = page.url()
  if (condition.matcher(current)) {
    const elapsedMs = Date.now() - started
    return {
      mode: 'url',
      tabId: tab.id,
      pattern: condition.pattern,
      urlMatch: condition.urlMatch,
      matchedUrl: current,
      matchedCurrent: true,
      timeoutMs,
      elapsedMs,
      summary: `等待 URL 命中 ${current}（${condition.urlMatch}，当前地址已满足，耗时 ${elapsedMs}ms）`,
    }
  }

  while (true) {
    if (page.isClosed()) {
      throw new Error(`等待 URL 期间标签页已关闭（${tab.id}），请重新 browser_e2e_tabs 获取可用标签页`)
    }
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) break
    await sleep(Math.min(WAIT_POLL_MS, remaining))
    if (page.isClosed()) {
      throw new Error(`等待 URL 期间标签页已关闭（${tab.id}），请重新 browser_e2e_tabs 获取可用标签页`)
    }
    const url = page.url()
    if (condition.matcher(url)) {
      const elapsedMs = Date.now() - started
      return {
        mode: 'url',
        tabId: tab.id,
        pattern: condition.pattern,
        urlMatch: condition.urlMatch,
        matchedUrl: url,
        matchedCurrent: false,
        timeoutMs,
        elapsedMs,
        summary: `等待 URL 命中 ${url}（${condition.urlMatch}，等待期间导航到达，耗时 ${elapsedMs}ms）`,
      }
    }
  }
  const elapsed = Date.now() - started
  throw new Error(`等待 URL 匹配超时：实际等待 ${elapsed}ms（上限 ${timeoutMs}ms）；`
    + `匹配方式 ${condition.urlMatch}，目标 ${condition.pattern}；当前地址 ${page.url()}`)
}

/** 判断一条响应记录是否 URL 与 method 都命中（不看状态）。 */
function responseMatchesTarget(condition, url, method) {
  if (!condition.matcher(url)) return false
  return !condition.responseMethod || String(method ?? '').toUpperCase() === condition.responseMethod
}

/** 把 Playwright Response 转成摘要记录；request() 抛错时返回 null。 */
function responseRecordOf(response) {
  let method
  try {
    method = response.request().method()
  } catch {
    return null
  }
  return {
    url: response.url(),
    method,
    status: response.status(),
    mimeType: response.headers()['content-type'] ?? '',
    at: nowAt(),
    buffered: false,
  }
}

/**
 * 等待匹配的响应：先（可选）回放该标签页的 networkRing，再临时监听未来的
 * response / requestfailed 事件。命中、超时、失败、关页都会移除临时监听。
 */
async function waitForResponseCondition(tab, condition, timeoutMs) {
  const page = tab.page
  const started = Date.now()
  const bufferedTotal = tab.networkRing.filter((record) => record.status > 0).length
  const nearMisses = []
  const failures = []

  const match = await new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const cleanup = () => {
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
      page.off('close', onClose)
      page.off('crash', onClose)
      if (timer) clearTimeout(timer)
      timer = null
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const noteNearMiss = (method, url, status) => {
      if (nearMisses.length < WAIT_DIAG_LIMIT) {
        nearMisses.push(`${String(method ?? '').toUpperCase()} ${url} -> ${status}`)
      }
    }
    const timeoutError = () => {
      const elapsed = Date.now() - started
      return new Error(`等待响应超时：实际等待 ${elapsed}ms（上限 ${timeoutMs}ms）；`
        + `条件 urlMatch=${condition.urlMatch} "${condition.pattern}"、`
        + `method=${condition.responseMethod ?? '不限'}、status=${condition.statusMin}-${condition.statusMax}；`
        + `已缓冲响应 ${bufferedTotal} 条；`
        + `URL/method 命中但状态不符：${nearMisses.length > 0 ? nearMisses.join('；') : '无'}；`
        + `匹配的失败请求：${failures.length > 0 ? failures.join('；') : '无'}；`
        + '提示：缓存命中或 Service Worker 代理的响应可能不产生 response 事件，可加 cache-busting 查询参数后重试')
    }

    function onResponse(response) {
      const record = responseRecordOf(response)
      if (!record) return
      if (!responseMatchesTarget(condition, record.url, record.method)) return
      if (record.status < condition.statusMin || record.status > condition.statusMax) {
        noteNearMiss(record.method, record.url, record.status)
        return
      }
      finish({ response: record })
    }
    function onRequestFailed(request) {
      let method
      try {
        method = request.method()
      } catch {
        return
      }
      if (!responseMatchesTarget(condition, request.url(), method)) return
      const reason = request.failure()?.errorText ?? 'request failed'
      if (condition.failOnRequestFailed) {
        fail(new Error(`等待的请求在响应前失败：${String(method).toUpperCase()} ${request.url()}（${reason}）；`
          + '如属预期（例如导航中止），传 failOnRequestFailed=false 继续等待其它响应'))
        return
      }
      if (failures.length < WAIT_DIAG_LIMIT) {
        failures.push(`${String(method).toUpperCase()} ${request.url()} -> ${reason}`)
      }
    }
    function onClose() {
      fail(new Error(`等待响应期间标签页已关闭（${tab.id}），请重新 browser_e2e_tabs 获取可用标签页`))
    }

    // 先挂监听再扫缓冲：避免「扫描完、监听还没挂上」这段缝隙里到达的响应被漏掉。
    page.on('response', onResponse)
    page.on('requestfailed', onRequestFailed)
    page.on('close', onClose)
    page.on('crash', onClose)
    timer = setTimeout(() => fail(timeoutError()), timeoutMs)

    if (condition.includeBuffered) {
      for (const record of tab.networkRing) {
        if (!(record.status > 0)) continue
        if (!responseMatchesTarget(condition, record.url, record.method)) continue
        if (record.status < condition.statusMin || record.status > condition.statusMax) {
          noteNearMiss(record.method, record.url, record.status)
          continue
        }
        finish({
          response: {
            url: record.url,
            method: record.method,
            status: record.status,
            mimeType: record.mimeType,
            at: record.at,
            buffered: true,
          },
        })
        return
      }
    }
  })

  const matched = match.response
  const elapsedMs = Date.now() - started
  return {
    mode: 'response',
    tabId: tab.id,
    pattern: condition.pattern,
    urlMatch: condition.urlMatch,
    responseMethod: condition.responseMethod,
    statusMin: condition.statusMin,
    statusMax: condition.statusMax,
    includeBuffered: condition.includeBuffered,
    matchedResponse: matched,
    timeoutMs,
    elapsedMs,
    summary: `等待响应命中：${String(matched.method).toUpperCase()} ${matched.url}`
      + `（HTTP ${matched.status}，${matched.mimeType || '-'}，`
      + `${matched.buffered ? '调用前已缓冲' : '等待期间到达'}，耗时 ${elapsedMs}ms）`,
  }
}

/** 等待页面条件满足（selector / expression / url / response 四选一），返回实际耗时。 */
export async function waitFor(session, options = {}, tabId) {
  const tab = currentTab(session, options.tab_id ?? tabId)
  const condition = waitConditionOf(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs 必须是正整数，收到 ${timeoutMs}`)
  }
  if (condition.name === 'selector') return await waitForSelectorCondition(tab.page, condition, timeoutMs)
  if (condition.name === 'expression') return await waitForExpressionCondition(tab.page, condition, timeoutMs)
  if (condition.name === 'url') return await waitForUrlCondition(tab.page, tab, condition, timeoutMs)
  return await waitForResponseCondition(tab, condition, timeoutMs)
}

/** browser_e2e_assert 一次最多判定的断言条数。 */
export const ASSERT_MAX_CHECKS = 20

/** text 未命中证据里页面可见文本的开头字数。 */
const ASSERT_TEXT_EVIDENCE_LIMIT = 120

/** expression 证据里返回值预览的字数。 */
const ASSERT_VALUE_EVIDENCE_LIMIT = 200

/** selector 证据里统计可见性的命中元素上限（命中数本身不受限）。 */
const ASSERT_VISIBLE_SCAN_LIMIT = 200

/** 断言的四种条件名（每条必须且只能给一个）。 */
const ASSERT_KINDS = ['selector', 'text', 'url', 'expression']

/** 断言期间标签页已关闭。 */
function assertTabClosedError(tabId) {
  return new Error(`断言期间标签页已关闭（${tabId}），请重新 browser_e2e_tabs 获取可用标签页`)
}

/** expression 的宿主侧语法预检：只编译、不执行，语句与顶层 await 在这里被拒。 */
function compileAssertExpression(expression, index) {
  try {
    // 只用于语法编译；页面内另按字符串脚本执行。
    new Function(`return (${expression})`)
  } catch (error) {
    throw new Error(`第 ${index} 条断言的 expression 语法无效：${error?.message ?? error}；`
      + '只能是表达式，不能含语句或顶层 await')
  }
}

/**
 * 校验并归一断言列表：形状、四选一、state / urlMatch 适用范围与枚举、正则与表达式语法。
 * 全部在发起页面调用之前完成，任一项不合法直接抛错。
 * @param {object} options - 工具入参
 * @returns {object[]} 归一后的断言（index / kind / expected / state / urlMatch / matcher）
 */
function normalizeAssertChecks(options) {
  const raw = options?.checks
  if (!Array.isArray(raw)) {
    throw new Error(`checks 必须是数组（1-20 条断言），收到 ${raw === null ? 'null' : typeof raw}`)
  }
  if (raw.length < 1 || raw.length > ASSERT_MAX_CHECKS) {
    throw new Error(`checks 必须是 1-${ASSERT_MAX_CHECKS} 条，收到 ${raw.length} 条`)
  }
  return raw.map((item, position) => {
    const index = position + 1
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${index} 条断言必须是对象`)
    }
    const values = {}
    for (const kind of ASSERT_KINDS) {
      const value = item[kind]
      // 空串按未给处理（与 wait 的 url / response 条件口径一致）。
      values[kind] = typeof value === 'string' && value.length > 0 ? value : ''
    }
    const provided = ASSERT_KINDS.filter((kind) => values[kind].length > 0)
    if (provided.length !== 1) {
      throw new Error(`第 ${index} 条断言必须且只能给 selector / text / url / expression 之一，`
        + `当前收到：${provided.length > 0 ? provided.join('、') : '无'}`)
    }
    const kind = provided[0]
    const expected = values[kind]
    const check = { index, kind, expected }

    if (item.state !== undefined) {
      if (kind !== 'selector') {
        throw new Error(`第 ${index} 条断言的 state 只对 selector 有效（当前是 ${kind} 条件）`)
      }
      if (!WAIT_STATES.includes(item.state)) {
        throw new Error(`第 ${index} 条断言的 state "${item.state}" 不支持，`
          + '可选 attached / visible / hidden / detached')
      }
      check.state = item.state
    } else if (kind === 'selector') {
      check.state = 'visible'
    }

    if (item.urlMatch !== undefined) {
      if (kind !== 'url') {
        throw new Error(`第 ${index} 条断言的 urlMatch 只对 url 有效（当前是 ${kind} 条件）`)
      }
      if (!URL_MATCH_MODES.includes(item.urlMatch)) {
        throw new Error(`第 ${index} 条断言的 urlMatch "${item.urlMatch}" 不支持，可选 includes / glob / regex`)
      }
      check.urlMatch = item.urlMatch
    } else if (kind === 'url') {
      check.urlMatch = 'includes'
    }

    if (kind === 'url') {
      try {
        check.matcher = urlMatcherOf(expected, check.urlMatch)
      } catch (error) {
        throw new Error(`第 ${index} 条断言：${error?.message ?? error}`)
      }
    }
    if (kind === 'expression') compileAssertExpression(expected, index)
    return check
  })
}

/** 判定 selector 条件：页内数命中与可见数，并给出首个命中元素的描述。 */
async function assertSelectorCheck(page, tab, check) {
  let result
  try {
    result = await page.evaluate(({ selector, scanLimit }) => {
      // 可见性口径与 snapshotScript 的 visibleEnough 一致（同一口径的两处内联实现）。
      function visibleEnough(el, rect) {
        if (rect.width <= 0 || rect.height <= 0) return false
        if (typeof el.checkVisibility === 'function') {
          try {
            return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
          } catch {
            // 参数不被旧内核支持时退回样式判断
          }
        }
        const style = window.getComputedStyle(el)
        if (!style) return true
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      }
      let nodes
      try {
        nodes = document.querySelectorAll(selector)
      } catch (error) {
        return { invalid: String(error?.message ?? error) }
      }
      const count = nodes.length
      const scan = Math.min(count, scanLimit)
      let visibleCount = 0
      for (let i = 0; i < scan; i += 1) {
        const el = nodes[i]
        if (visibleEnough(el, el.getBoundingClientRect())) visibleCount += 1
      }
      let first = ''
      if (count > 0) {
        const el = nodes[0]
        let desc = el.tagName.toLowerCase()
        if (el.id) desc += `#${el.id}`
        const classes = Array.from(el.classList || [])
        if (classes.length > 0) desc += `.${classes.join('.')}`
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
        if (text) desc += ` "${text.slice(0, 40)}"`
        first = desc
      }
      return { count, visibleCount, first }
    }, { selector: check.expected, scanLimit: ASSERT_VISIBLE_SCAN_LIMIT })
  } catch (error) {
    if (page.isClosed()) throw assertTabClosedError(tab.id)
    throw new Error(`断言的 selector 检查执行失败（${check.expected}）：${error?.message ?? error}`)
  }
  if (result?.invalid) {
    throw new Error(`第 ${check.index} 条断言的 selector 无效（${check.expected}）：${result.invalid}；请修正 CSS 选择器`)
  }
  const { count, visibleCount, first } = result
  const overLimit = count > ASSERT_VISIBLE_SCAN_LIMIT
  const actual = count === 0
    ? '未命中任何元素'
    : `命中 ${count} 个（可见 ${visibleCount} 个${overLimit ? `，只统计前 ${ASSERT_VISIBLE_SCAN_LIMIT} 个` : ''}）；首个：${first}`
  const pass = check.state === 'attached'
    ? count > 0
    : check.state === 'visible'
      ? visibleCount > 0
      : check.state === 'hidden'
        ? visibleCount === 0
        : count === 0
  return { pass, actual }
}

/** 判定 text 条件：匹配 document.body.innerText（区分大小写），给出偏移或页面文本开头。 */
async function assertTextCheck(page, tab, check) {
  let result
  try {
    result = await page.evaluate(({ text, limit }) => {
      const full = document.body ? String(document.body.innerText ?? '') : ''
      const offset = full.indexOf(text)
      const folded = full.replace(/\s+/g, ' ').trim()
      if (offset < 0) {
        return { found: false, length: folded.length, preview: folded.slice(0, limit) }
      }
      const context = full.slice(Math.max(0, offset - 20), offset + text.length + 20)
      return { found: true, offset, context }
    }, { text: check.expected, limit: ASSERT_TEXT_EVIDENCE_LIMIT })
  } catch (error) {
    if (page.isClosed()) throw assertTabClosedError(tab.id)
    throw new Error(`断言的 text 检查执行失败（${check.expected}）：${error?.message ?? error}`)
  }
  if (result?.found) {
    return { pass: true, actual: `命中（第 ${result.offset} 个字符起，上下文 "${result.context}"）` }
  }
  return {
    pass: false,
    actual: `未找到；页面可见文本 ${result?.length ?? 0} 字，开头 "${result?.preview ?? ''}"`,
  }
}

/** 判定 url 条件：宿主侧读 page.url() 后按 urlMatch 匹配，零页内调用。 */
function assertUrlCheck(page, tab, check) {
  if (page.isClosed()) throw assertTabClosedError(tab.id)
  const url = page.url()
  return { pass: check.matcher(url), actual: `实际地址 ${url}` }
}

/** 判定 expression 条件：同步表达式求值，真值即通过；求值抛错只让该条失败。 */
async function assertExpressionCheck(page, tab, check) {
  const script = '(() => { try { const value = (' + check.expected + '); let preview; '
    + 'try { preview = JSON.stringify(value) } catch {} '
    + `if (preview === undefined) preview = String(value); `
    + `return { truthy: !!value, preview: String(preview).slice(0, ${ASSERT_VALUE_EVIDENCE_LIMIT}) } `
    + '} catch (error) { return { error: String(error && error.message ? error.message : error) } } })()'
  let result
  try {
    result = await page.evaluate(script)
  } catch (error) {
    if (page.isClosed()) throw assertTabClosedError(tab.id)
    return { pass: false, actual: `求值抛错：${error?.message ?? error}` }
  }
  if (result && result.error !== undefined) {
    return { pass: false, actual: `求值抛错：${result.error}` }
  }
  const truthy = result?.truthy === true
  return { pass: truthy, actual: `${truthy ? '真值' : '假值'}（返回 ${result?.preview ?? 'undefined'}）` }
}

/**
 * 一次性判定当前页的 1-20 条断言（selector / text / url / expression 四选一）。
 * 未通过不抛错，由返回值的 pass 表达结论；入参非法与运行时错误才抛错。
 * @param {object} session - 会话状态
 * @param {object} options - `checks` 必填；`tab_id` 可选
 * @param {string} [tabId] - 显式 tab_id 回退（与 options.tab_id 同义）
 * @returns {Promise<object>} `{ pass, total, passed, failed, tabId, url, elapsedMs, checks, summary }`
 */
export async function assertPage(session, options = {}, tabId) {
  // 先校验入参、再取页：未启动且入参非法时报入参错误。
  const checks = normalizeAssertChecks(options)
  const tab = currentTab(session, options.tab_id ?? tabId)
  const page = tab.page
  const started = Date.now()
  const results = []
  let passed = 0

  for (const check of checks) {
    if (page.isClosed()) throw assertTabClosedError(tab.id)
    let outcome
    if (check.kind === 'selector') outcome = await assertSelectorCheck(page, tab, check)
    else if (check.kind === 'text') outcome = await assertTextCheck(page, tab, check)
    else if (check.kind === 'url') outcome = assertUrlCheck(page, tab, check)
    else outcome = await assertExpressionCheck(page, tab, check)
    if (outcome.pass) passed += 1
    const entry = {
      index: check.index,
      kind: check.kind,
      expected: check.expected,
      pass: outcome.pass,
      actual: outcome.actual,
    }
    if (check.kind === 'selector') entry.state = check.state
    if (check.kind === 'url') entry.urlMatch = check.urlMatch
    results.push(entry)
  }

  if (page.isClosed()) throw assertTabClosedError(tab.id)
  const url = page.url()
  const elapsedMs = Date.now() - started
  const total = results.length
  const failed = total - passed
  const failedIndexes = results.filter((item) => !item.pass).map((item) => item.index)
  const summary = failed === 0
    ? `断言通过：${total}/${total} 条（标签页 ${tab.id}，耗时 ${elapsedMs}ms）`
    : `断言失败：${passed}/${total} 条通过（未通过第 ${failedIndexes.slice(0, 5).join('、')} 条`
      + `${failed > 5 ? '等' : ''}；标签页 ${tab.id}，耗时 ${elapsedMs}ms）`
  return {
    pass: failed === 0,
    total,
    passed,
    failed,
    tabId: tab.id,
    url,
    elapsedMs,
    checks: results,
    summary,
  }
}
