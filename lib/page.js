/**
 * 页面层：标签页条目与生命周期、事件环（控制台 / 网络环形缓冲、ref 表）。
 *
 * 本文件不 import 会话层：所有函数接收 session 对象，需要广播面板事件时调用 session.emit
 * （由 session.js 在 sessionOf 里挂上）。因此会话层可以单向调用页面层，页面层不回指。
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

import { topUpIfChallenged } from './auth.js'
import {
  assertBrowserRunning, assertCdpConnected, assertCurrentTabAvailable, assertRefBelongsToTab, assertRefRevalidated,
  assertTabExists,
} from './invariants.js'

/** 默认视口。 */
export const DEFAULT_VIEWPORT = { width: 1600, height: 900 }

/** 控制台 / 网络记录的环形缓冲上限，超出时从头裁。 */
export const RING_LIMIT = 500

/** 单条控制台文本的最大长度。 */
export const CONSOLE_TEXT_LIMIT = 2000

/** snapshot 单次最多返回的节点数（全 DOM 快照比只收可交互元素多得多，上限相应放大）。 */
export const SNAPSHOT_LIMIT = 4000

/** 快照页面脚本单次遍历的元素上限：超过后提前停止并置 scanTruncated。 */
export const SNAPSHOT_SCAN_LIMIT = 20000

/** 快照页面脚本整体执行的宿主侧超时（页面脚本本身无法被终止）。 */
export const SNAPSHOT_SCRIPT_TIMEOUT_MS = 15000

/** delta / query 模型可见文本的字符上限（全量保持既有行为，不套此上限）。 */
export const SNAPSHOT_TEXT_LIMIT = 20000

/** delta 文本里 removed 列表最多逐条列出的条数，超出汇总。 */
export const SNAPSHOT_REMOVED_LIMIT = 200

/** query 缺省返回条数。 */
export const SNAPSHOT_QUERY_LIMIT_DEFAULT = 20

/** query 允许的返回条数上限。 */
export const SNAPSHOT_QUERY_LIMIT_MAX = 100

/** query 页面内原始命中上限（去重前的候选数）。 */
export const SNAPSHOT_QUERY_MAX_MATCHES = 200

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

/** 逐键输入（mode=keystrokes）单次最多写入的字符数（按 Unicode 码点计）。 */
export const KEYSTROKE_MAX_CHARS = 2000

/** 逐键输入的相邻按键等待上限（毫秒）。 */
export const KEYSTROKE_MAX_DELAY_MS = 1000

/** 逐键输入一次调用的等待时间预算（delayMs × 字符数，毫秒）。 */
export const KEYSTROKE_DELAY_BUDGET_MS = 30000

/** 当前时间 ISO 串（控制台 / 网络记录的时间戳）。 */
export function nowAt() {
  return new Date().toISOString()
}

/** 向环形缓冲追加一条记录，超出上限时从头裁（保留最新）。 */
export function pushRing(ring, entry) {
  ring.push(entry)
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
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
  const entry = {
    id: `t${session.nextTabSeq}`,
    page,
    refs: new Map(),
    consoleRing: [],
    networkRing: [],
    networkByRequest: new Map(),
    /** 快照基线：按 frame 分桶（epoch / key → 摘要与 ref / nextRef / version），只由本文件读写。 */
    snapshotBaselines: new Map(),
    /** 页面是否仍在加载：初始 true，load / domcontentloaded 置 false，主框架导航开始置 true。 */
    loading: true,
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
    const record = {
      url: request.url(),
      method: request.method(),
      status: 0,
      mimeType: '',
      failure: '',
      at: nowAt(),
    }
    entry.networkByRequest.set(request, record)
    // request 事件可能远多于 response / requestfailed，Map 不能无界增长：按插入顺序淘汰最旧的键。
    while (entry.networkByRequest.size > RING_LIMIT) {
      const oldest = entry.networkByRequest.keys().next().value
      entry.networkByRequest.delete(oldest)
    }
    pushRing(entry.networkRing, record)
  })

  page.on('response', (response) => {
    const record = entry.networkByRequest.get(response.request())
    if (!record) return
    record.status = response.status()
    record.mimeType = response.headers()['content-type'] ?? ''
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

/** 清空某个标签页的控制台与网络记录（导航时调用）。 */
export function clearRings(entry) {
  entry.consoleRing.length = 0
  entry.networkRing.length = 0
  entry.networkByRequest.clear()
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
  // 导航开始前先清一次：goto 失败时旧记录也不会挂在新导航结果里；新文档自身的请求
  // 会在 request 事件里重新登记，不会被这里的清空误删。
  clearRings(tab)
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

/**
 * 页面内脚本：收集可见元素（full / delta）或按条件定位（query）。
 *
 * 注入到页面上下文执行，不引用外部变量。delta 的元素身份来自本脚本维护的注册表：
 * 同一文档内多次快照复用同一份 WeakMap，元素 key 稳定；epoch 用来判断页面是否被重置。
 * 不写 DOM 属性，Symbol 键不进 Object.keys，不污染页面选择器。
 * @param {{limit?: number, scanLimit?: number, maxMatches?: number, query?: object}} options - 快照选项
 * @returns {{epoch: string, nodes?: Array<object>, total?: number, scanTruncated?: boolean, matches?: Array<object>, scanned?: number}}
 */
function snapshotScript(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const cap = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 4000
  const scanLimit = Number.isInteger(opts.scanLimit) && opts.scanLimit > 0 ? opts.scanLimit : 20000
  const maxMatches = Number.isInteger(opts.maxMatches) && opts.maxMatches > 0 ? opts.maxMatches : 200
  const query = opts.query && typeof opts.query === 'object' ? opts.query : null
  const NAME_LIMIT = 80
  const TEXT_LIMIT = 120
  const CLASS_LIMIT = 8
  const QUERY_TEXT_LIMIT = 500
  /** 这些标签没有可见内容，直接跳过。 */
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title', 'base'])
  /** 纯布局容器不用后代文本作 name：否则每个祖先都会重复整页文本。 */
  const CONTAINER_TAGS = new Set([
    'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside',
    'nav', 'form', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr',
    'fieldset', 'details', 'dialog', 'figure',
  ])

  /** 元素身份注册表：只在本文件内使用，页面重置后 epoch 会变。 */
  const REGISTRY_KEY = Symbol.for('dsh.browser.e2e.snapshotRegistry')
  function registryOf() {
    const existing = window[REGISTRY_KEY]
    if (existing && existing.ids instanceof WeakMap && typeof existing.epoch === 'string') return existing
    const created = {
      epoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      ids: new WeakMap(),
      next: 0,
    }
    window[REGISTRY_KEY] = created
    return created
  }
  const registry = registryOf()

  function keyFor(el) {
    let key = registry.ids.get(el)
    if (key === undefined) {
      key = registry.next
      registry.next += 1
      registry.ids.set(el, key)
    }
    return key
  }

  /** tag 到 role 的简单映射；有 role 属性时优先用属性。 */
  const roleByTag = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  }

  function roleFor(el) {
    const explicit = (el.getAttribute('role') || '').trim()
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    return roleByTag[tag] ?? ''
  }

  /** 到 body 的层级：body 的直接子元素为 1。 */
  function depthFor(el) {
    let depth = 0
    let node = el
    while (node && node !== document.body && node.parentElement) {
      depth += 1
      node = node.parentElement
    }
    return depth
  }

  function typeIndex(el) {
    let idx = 1
    let sibling = el.previousElementSibling
    while (sibling) {
      if (sibling.tagName === el.tagName) idx += 1
      sibling = sibling.previousElementSibling
    }
    return idx
  }

  function xpathFor(el) {
    if (el.id && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(el.id)) {
      return `//*[@id="${el.id}"]`
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase()
      parts.unshift(`${tag}[${typeIndex(node)}]`)
      node = node.parentElement
    }
    return '/' + parts.join('/')
  }

  /** query 结果里可直接传给 click / fill 的 CSS 选择器：id 优先，否则从 body 起的 tag:nth-of-type 链。 */
  function selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.body) {
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${typeIndex(node)})`)
      node = node.parentElement
    }
    if (node === document.body) parts.unshift('body')
    return parts.join(' > ')
  }

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

  /** 元素文本：压成一行并截断（textContent 会包含隐藏后代文本，这里只做展示用）。 */
  function textOf(el) {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text
  }

  /** 可读名称：aria-label / aria-labelledby 优先，其次表单标签与文本。 */
  function nameFor(el, text) {
    const labelled = (el.getAttribute('aria-label') || '').trim()
    if (labelled) return labelled.slice(0, NAME_LIMIT)
    const by = (el.getAttribute('aria-labelledby') || '').trim()
    if (by) {
      const parts = []
      for (const id of by.split(/\s+/)) {
        const target = id ? document.getElementById(id) : null
        if (target) {
          const part = (target.textContent || '').replace(/\s+/g, ' ').trim()
          if (part) parts.push(part)
        }
      }
      if (parts.length > 0) return parts.join(' ').slice(0, NAME_LIMIT)
    }
    const tagName = el.tagName
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tagName)) {
      const placeholder = (el.getAttribute('placeholder') || '').trim()
      if (placeholder) return placeholder.slice(0, NAME_LIMIT)
      if (el.id) {
        // id 可能含引号等选择器元字符，必须转义，否则 querySelector 抛 SyntaxError 让整次 snapshot 失败。
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (label) {
          const linked = (label.textContent || '').replace(/\s+/g, ' ').trim()
          if (linked) return linked.slice(0, NAME_LIMIT)
        }
      }
      const wrapped = el.closest('label')
      if (wrapped) {
        const linked = (wrapped.textContent || '').replace(/\s+/g, ' ').trim()
        if (linked) return linked.slice(0, NAME_LIMIT)
      }
      const fallback = el.value || el.getAttribute('name') || ''
      if (fallback) return String(fallback).slice(0, NAME_LIMIT)
    }
    if (text && (!CONTAINER_TAGS.has(el.tagName.toLowerCase()) || el.hasAttribute('role'))) {
      return text.slice(0, NAME_LIMIT)
    }
    const alt = (el.getAttribute('alt') || '').trim()
    if (alt) return alt.slice(0, NAME_LIMIT)
    return ''
  }

  /** 视口相对 CSS 像素；四值取整，便于按坐标点击时直接使用。 */
  function boxFor(rect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }

  /** 语义元素：可聚焦 / 可编辑 / 带 role / 带 tabindex / 带 href。 */
  function semanticElement(el) {
    const tag = el.tagName.toLowerCase()
    if (el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('href')) return true
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'a') return true
    if (el.isContentEditable) return true
    return typeof el.tabIndex === 'number' && el.tabIndex >= 0
  }

  function queryMatches(queryOpt) {
    const needle = typeof queryOpt.text === 'string' ? queryOpt.text.toLowerCase() : ''
    const roleNeedle = typeof queryOpt.role === 'string' ? queryOpt.role.toLowerCase() : ''
    const includeHidden = queryOpt.includeHidden === true
    let scanned = 0
    let scanTruncated = false
    let candidates
    if (typeof queryOpt.selector === 'string' && queryOpt.selector.length > 0) {
      try {
        candidates = Array.from(document.querySelectorAll(queryOpt.selector))
      } catch {
        return { invalidSelector: true, matches: [], scanned: 0, scanTruncated: false }
      }
      scanned = candidates.length
    } else {
      candidates = []
      const all = document.body ? document.body.querySelectorAll('*') : []
      for (const el of all) {
        const tag = el.tagName.toLowerCase()
        if (SKIP_TAGS.has(tag)) continue
        if (scanned >= scanLimit) {
          scanTruncated = true
          break
        }
        scanned += 1
        candidates.push(el)
      }
    }

    const hits = []
    for (const el of candidates) {
      if (roleNeedle && roleFor(el).toLowerCase() !== roleNeedle) continue
      if (needle) {
        const text = textOf(el)
        const name = nameFor(el, text)
        const bodyText = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, QUERY_TEXT_LIMIT)
        if (!name.toLowerCase().includes(needle) && !bodyText.toLowerCase().includes(needle)) continue
      }
      const rect = el.getBoundingClientRect()
      const visible = visibleEnough(el, rect)
      if (!visible && !includeHidden) continue
      hits.push({ el, rect, visible, index: hits.length })
      if (hits.length >= maxMatches) break
    }

    // 嵌套命中只保留最内层语义元素；容器祖先与文本后代丢弃。
    const dropped = new Set()
    for (const hit of hits) {
      const isSemantic = semanticElement(hit.el)
      for (const other of hits) {
        if (other.el === hit.el || dropped.has(other.el)) continue
        if (hit.el.contains(other.el) && semanticElement(other.el)) {
          dropped.add(hit.el)
          break
        }
      }
      if (dropped.has(hit.el)) continue
      if (!isSemantic) {
        for (const other of hits) {
          if (other.el !== hit.el && !dropped.has(other.el) && other.el.contains(hit.el) && semanticElement(other.el)) {
            dropped.add(hit.el)
            break
          }
        }
      }
      if (dropped.has(hit.el)) continue
      if (!isSemantic) {
        for (const other of hits) {
          if (other.el !== hit.el && !dropped.has(other.el) && hit.el.contains(other.el)) {
            dropped.add(hit.el)
            break
          }
        }
      }
    }

    // 可见元素优先，其余保持文档顺序。
    const ordered = hits
      .slice()
      .sort((a, b) => (a.visible === b.visible ? a.index - b.index : (a.visible ? -1 : 1)))
    const matches = []
    for (const hit of ordered) {
      if (dropped.has(hit.el)) continue
      const text = textOf(hit.el)
      const match = {
        key: keyFor(hit.el),
        tag: hit.el.tagName.toLowerCase(),
        id: hit.el.id || '',
        classes: hit.el.classList ? Array.from(hit.el.classList).slice(0, CLASS_LIMIT) : [],
        role: roleFor(hit.el),
        name: nameFor(hit.el, text),
        text,
        box: boxFor(hit.rect),
        xpath: xpathFor(hit.el),
        selector: selectorFor(hit.el),
      }
      if (includeHidden && !hit.visible) match.hidden = true
      matches.push(match)
    }
    return { matches, scanned, scanTruncated }
  }

  if (query) {
    const found = queryMatches(query)
    return {
      epoch: registry.epoch,
      query: true,
      invalidSelector: found.invalidSelector === true,
      matches: found.matches,
      scanned: found.scanned,
      scanTruncated: found.scanTruncated === true,
    }
  }

  const nodes = []
  let total = 0
  let scanTruncated = false
  const all = document.body ? document.body.querySelectorAll('*') : []
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i]
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    const rect = el.getBoundingClientRect()
    if (!visibleEnough(el, rect)) continue
    if (total >= scanLimit) {
      scanTruncated = i < all.length - 1
      break
    }
    total += 1
    if (nodes.length >= cap) continue
    const text = textOf(el)
    const classes = el.classList ? Array.from(el.classList).slice(0, CLASS_LIMIT) : []
    nodes.push({
      key: keyFor(el),
      tag,
      id: el.id || '',
      classes,
      role: roleFor(el),
      name: nameFor(el, text),
      text,
      box: boxFor(rect),
      depth: depthFor(el),
      xpath: xpathFor(el),
    })
  }
  return { epoch: registry.epoch, nodes, total, scanTruncated }
}

/** 摘要字段：delta 只比较这 6 个，不含 box / depth / xpath（位置移动与兄弟增删不算变化）。 */
function fieldsOf(node) {
  return {
    tag: node.tag,
    id: node.id,
    classes: Array.isArray(node.classes) ? node.classes.join('.') : '',
    role: node.role,
    name: node.name,
    text: node.text,
  }
}

function digestOf(fields) {
  return JSON.stringify(fields)
}

function changedFieldsOf(prev, next) {
  return ['tag', 'id', 'classes', 'role', 'name', 'text'].filter((key) => prev[key] !== next[key])
}

/** 复制节点并去掉页面侧内部 key（不进入模型可见输出）。 */
function stripKey(node) {
  const { key: _key, ...rest } = node
  return rest
}

function baselineEntryOf(node, ref) {
  const fields = fieldsOf(node)
  return {
    digest: digestOf(fields),
    fields,
    xpath: node.xpath,
    ref,
    tag: node.tag,
    name: node.name,
  }
}

/** 宿主侧超时包装：页面脚本无法被终止，超时只让本次调用失败。 */
function withTimeout(promise, ms, message) {
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

/** 主文档固定索引 0，其余按 page.frames() 顺序过滤主文档后从 1 编号。 */
function frameListOf(page) {
  const main = page.mainFrame()
  return [main, ...page.frames().filter((frame) => frame !== main)]
}

function describeFrames(frames) {
  return frames.map((frame, index) => (index === 0
    ? '0（主文档）'
    : `${index}（"${frame.name()}"，${frame.url()}）`)).join('、')
}

function frameInfoOf(frames, frame, index) {
  if (index === 0) return { index: 0, name: frame.name(), url: frame.url(), parentIndex: null }
  const parent = frame.parentFrame()
  const parentIndex = parent ? frames.indexOf(parent) : -1
  return {
    index,
    name: frame.name(),
    url: frame.url(),
    parentIndex: parentIndex >= 0 ? parentIndex : null,
  }
}

/**
 * 解析 frame 参数：整数为索引（0 主文档），字符串先按 name 精确匹配、再按 url 子串匹配。
 * 每次调用重新取 frame 列表，索引只对本次调用有效。
 */
function resolveSnapshotFrame(page, frameArg) {
  const frames = frameListOf(page)
  let index = 0
  if (frameArg !== undefined && frameArg !== null) {
    if (typeof frameArg === 'number') {
      if (!Number.isInteger(frameArg) || frameArg < 0) {
        throw new Error(`frame 必须是 0 或正整数（0 为主文档），收到 ${frameArg}`)
      }
      index = frameArg
    } else if (typeof frameArg === 'string') {
      const value = frameArg
      const candidates = frames.map((frame, idx) => ({ frame, idx })).filter(({ frame, idx }) => idx > 0)
      if (value.length === 0) throw new Error(`frame 未找到：当前页可用索引 ${describeFrames(frames)}`)
      const byName = candidates.filter(({ frame }) => frame.name() !== '' && frame.name() === value)
      let matched = byName
      if (matched.length === 0) {
        matched = candidates.filter(({ frame }) => frame.url().includes(value))
      }
      if (matched.length === 1) {
        index = matched[0].idx
      } else if (matched.length > 1) {
        throw new Error(`frame "${value}" 命中 ${matched.length} 个（索引 ${matched.map(({ idx }) => idx).join('、')}），请改用 frame 索引`)
      } else {
        throw new Error(`frame "${value}" 未找到：当前页可用索引 ${describeFrames(frames)}`)
      }
    } else {
      throw new Error(`frame 必须是 0 或正整数（0 为主文档），收到 ${String(frameArg)}`)
    }
  }
  if (index >= frames.length) {
    throw new Error(`frame 索引 ${index} 不存在：当前页共 ${frames.length} 个 frame（${describeFrames(frames)}），请重新 browser_e2e_snapshot 查看`)
  }
  return { frame: frames[index], index, info: frameInfoOf(frames, frames[index], index) }
}

/** 只读同源 frame：空 url / about:blank / about:srcdoc 视为同源。 */
function assertSameOriginFrame(page, frame, index) {
  const frameUrl = frame.url()
  if (!frameUrl || frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') return
  let frameOrigin
  try {
    frameOrigin = new URL(frameUrl).origin
  } catch {
    return
  }
  let pageOrigin
  try {
    pageOrigin = new URL(page.url()).origin
  } catch {
    pageOrigin = null
  }
  if (frameOrigin !== pageOrigin) {
    throw new Error(`frame（索引 ${index}，${frameUrl}）跨源：P0-3 只读取同源 iframe，跨源 iframe 的定位与操作待 P1-9`)
  }
}

function snapshotTimeoutMessage() {
  return `快照执行超时（${SNAPSHOT_SCRIPT_TIMEOUT_MS}ms）：页面脚本未返回，可能被同步脚本或死循环占用；可稍后重试或改用 browser_e2e_evaluate 小范围读取`
}

async function readSnapshotRaw(frame, options, index) {
  const detachedMessage = `frame（索引 ${index}）已不可用（已导航或卸载），请重新 browser_e2e_snapshot`
  if (typeof frame.isDetached === 'function' && frame.isDetached()) throw new Error(detachedMessage)
  const arg = {
    limit: SNAPSHOT_LIMIT,
    scanLimit: SNAPSHOT_SCAN_LIMIT,
    maxMatches: SNAPSHOT_QUERY_MAX_MATCHES,
    query: options.query ?? null,
  }
  try {
    return await withTimeout(frame.evaluate(snapshotScript, arg), SNAPSHOT_SCRIPT_TIMEOUT_MS, snapshotTimeoutMessage())
  } catch (error) {
    if (error?.code === 'SNAPSHOT_TIMEOUT') throw error
    if (index === 0) throw error
    if ((typeof frame.isDetached === 'function' && frame.isDetached())
      || /detached|Target closed|Execution context was destroyed/i.test(String(error?.message))) {
      throw new Error(detachedMessage)
    }
    throw new Error(`frame（索引 ${index}）读取失败：${error?.message ?? error}`)
  }
}

function normalizeQuery(query) {
  const text = query.text
  const selector = query.selector
  const role = query.role
  for (const [key, value] of Object.entries({ text, selector, role })) {
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error(`query.${key} 必须是非空字符串`)
    }
  }
  if (!text && !selector && !role) throw new Error('query 至少需要 text / selector / role 之一')
  if (text && selector) throw new Error('query.text 与 query.selector 互斥，只能给一个')
  let limit = SNAPSHOT_QUERY_LIMIT_DEFAULT
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > SNAPSHOT_QUERY_LIMIT_MAX) {
      throw new Error(`query.limit 必须是 1-100 的整数，收到 ${query.limit}`)
    }
    limit = query.limit
  }
  return { text, selector, role, limit, includeHidden: query.includeHidden === true }
}

function normalizeSnapshotOptions(options) {
  const raw = options && typeof options === 'object' ? options : {}
  let query
  if (raw.query !== undefined) {
    if (raw.query === null || typeof raw.query !== 'object' || Array.isArray(raw.query)) {
      throw new Error('query 必须是对象，可含 text / selector / role / limit / includeHidden')
    }
    query = normalizeQuery(raw.query)
  }
  const delta = raw.delta === true
  if (delta && query) {
    throw new Error('query 与 delta 不能同时使用：query 是定位查询（不写快照基线），delta 需要与上一次快照对比；请分两次调用')
  }
  return { delta, query, frame: raw.frame }
}

/** delta / query 文本上限：超出截断并追加提示（全量不套，保持既有行为）。 */
function clipSnapshotText(text) {
  const value = String(text ?? '')
  if (value.length <= SNAPSHOT_TEXT_LIMIT) return value
  return `${value.slice(0, SNAPSHOT_TEXT_LIMIT)}…（已截断：文本上限 ${SNAPSHOT_TEXT_LIMIT} 字符）`
}

function formatNodeLine(item, withRef) {
  const idText = item.id ? `#${item.id}` : ''
  const classText = item.classes.length > 0 ? `.${item.classes.join('.')}` : ''
  const indent = '  '.repeat(item.depth)
  const refText = withRef ? `[${item.ref.replace('@', '')}] ` : ''
  return `${indent}${refText}${item.tag}${idText}${classText} "${item.name}"`
    + ` box(${item.box.x},${item.box.y},${item.box.width},${item.box.height})`
}

function fullScanNotice(total) {
  return `（扫描上限 ${SNAPSHOT_SCAN_LIMIT} 个元素，已提前停止：total=${total} 是已扫描到的可见元素数）`
}

/** 全量快照：主文档重建 ref 表；子 frame 只读并写该 frame 的基线。 */
function runFullSnapshot(tab, frame, index, raw, base) {
  const main = index === 0
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, SNAPSHOT_LIMIT) : []
  const items = rawNodes.map((node, idx) => ({ ...stripKey(node), ref: main ? `@${idx}` : null }))
  if (main) {
    tab.refs.clear()
    for (const item of items) tab.refs.set(item.ref, item)
  }
  const previous = tab.snapshotBaselines.get(frame)
  const bucket = {
    epoch: raw.epoch,
    version: (previous?.version ?? 0) + 1,
    nextRef: main ? items.length : 0,
    keys: new Map(),
  }
  rawNodes.forEach((node, idx) => bucket.keys.set(node.key, baselineEntryOf(node, items[idx].ref)))
  tab.snapshotBaselines.set(frame, bucket)

  const total = Number.isInteger(raw.total) ? raw.total : items.length
  const truncated = total > SNAPSHOT_LIMIT
  const lines = items.map((item) => formatNodeLine(item, main))
  let text = lines.length > 0 ? lines.join('\n') : '（未发现可见元素）'
  if (truncated) {
    text += `\n\n（已截断：共 ${total} 个可见元素，只返回前 ${SNAPSHOT_LIMIT} 个）`
  }
  if (base.scanTruncated) text += `\n\n${fullScanNotice(total)}`
  if (!main) text += '\n\n（子 frame 只读：不分配 ref，元素操作待 P1-9）'
  return {
    ...base,
    count: items.length,
    total,
    truncated,
    nodes: items,
    text,
    summary: `快照 ${items.length} 个可见元素${truncated ? `（共 ${total} 个，已截断到 ${SNAPSHOT_LIMIT} 个）` : ''}`,
  }
}

function formatDeltaNodeLine(marker, item) {
  const idText = item.id ? `#${item.id}` : ''
  const classText = item.classes.length > 0 ? `.${item.classes.join('.')}` : ''
  const refText = item.ref ? item.ref.replace('@', '') : '-'
  const fieldsText = item.changedFields && item.changedFields.length > 0 ? `（${item.changedFields.join('、')}）` : ''
  return `  ${marker} [${refText}] ${item.tag}${idText}${classText} "${item.name}"`
    + ` box(${item.box.x},${item.box.y},${item.box.width},${item.box.height})${fieldsText}`
}

/** delta：按稳定 key 与基线对比；主文档增量并入 ref 表，子 frame 只更新该 frame 的基线。 */
function runDeltaSnapshot(tab, frame, index, raw, base) {
  const main = index === 0
  const existing = tab.snapshotBaselines.get(frame)
  const status = !existing
    ? 'missing'
    : (existing.invalidated === true || existing.epoch !== raw.epoch ? 'reset' : 'ok')
  if (status !== 'ok') {
    const full = runFullSnapshot(tab, frame, index, raw, base)
    return {
      ...full,
      baseline: status,
      version: tab.snapshotBaselines.get(frame)?.version ?? 1,
      added: [],
      changed: [],
      removed: [],
      addedCount: 0,
      changedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      text: `无增量基线（首次快照或页面已更换），已返回全量\n\n${full.text}`,
    }
  }

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, SNAPSHOT_LIMIT) : []
  const currentKeys = new Set(rawNodes.map((node) => node.key))
  const added = []
  const changed = []
  let unchangedCount = 0
  let nextRef = Number.isInteger(existing.nextRef) ? existing.nextRef : 0
  const nextKeys = new Map()
  for (const node of rawNodes) {
    const previous = existing.keys.get(node.key)
    const fields = fieldsOf(node)
    const digest = digestOf(fields)
    const stripped = stripKey(node)
    if (!previous) {
      const ref = main ? `@${nextRef}` : null
      if (main) nextRef += 1
      const item = { ...stripped, ref }
      added.push(item)
      if (main) tab.refs.set(item.ref, item)
      nextKeys.set(node.key, baselineEntryOf(node, ref))
    } else if (previous.digest !== digest) {
      const ref = previous.ref ?? null
      changed.push({ ...stripped, ref, changedFields: changedFieldsOf(previous.fields, fields) })
      if (main && ref) tab.refs.set(ref, { ...stripped, ref })
      nextKeys.set(node.key, baselineEntryOf(node, ref))
    } else {
      unchangedCount += 1
      const ref = previous.ref ?? null
      if (main && ref) tab.refs.set(ref, { ...stripped, ref })
      nextKeys.set(node.key, baselineEntryOf(node, ref))
    }
  }
  const removed = []
  for (const [key, previous] of existing.keys) {
    if (currentKeys.has(key)) continue
    removed.push({
      ref: main ? (previous.ref ?? null) : null,
      tag: previous.tag,
      name: previous.name,
      xpath: previous.xpath,
    })
    if (main && previous.ref) tab.refs.delete(previous.ref)
  }

  const version = (existing.version ?? 0) + 1
  tab.snapshotBaselines.set(frame, {
    epoch: raw.epoch,
    version,
    nextRef: main ? nextRef : 0,
    keys: nextKeys,
  })

  const total = Number.isInteger(raw.total) ? raw.total : rawNodes.length
  const changesCount = added.length + changed.length + removed.length
  const truncated = raw.scanTruncated === true || total > SNAPSHOT_LIMIT || changesCount > SNAPSHOT_LIMIT
  const lines = [`增量 v${version}（标签页 ${base.tabId}，frame ${index}）`]
  if (changesCount === 0) {
    lines.push('（无可见变化）')
  } else {
    if (added.length > 0) {
      lines.push(`新增 ${added.length} 个：`)
      for (const item of added) lines.push(formatDeltaNodeLine('+', item))
    }
    if (changed.length > 0) {
      lines.push(`变化 ${changed.length} 个：`)
      for (const item of changed) lines.push(formatDeltaNodeLine('~', item))
    }
    if (removed.length > 0) {
      lines.push(`移除 ${removed.length} 个：`)
      for (const item of removed.slice(0, SNAPSHOT_REMOVED_LIMIT)) {
        lines.push(`  - ${item.ref ?? '-'} ${item.tag} "${item.name}"`)
      }
      if (removed.length > SNAPSHOT_REMOVED_LIMIT) {
        lines.push(`  …等 ${removed.length - SNAPSHOT_REMOVED_LIMIT} 个`)
      }
    }
  }
  if (truncated) {
    if (total > SNAPSHOT_LIMIT) lines.push(`（本次只对比前 ${SNAPSHOT_LIMIT} 个可见节点）`)
    if (changesCount > SNAPSHOT_LIMIT) lines.push(`（变化节点超过 ${SNAPSHOT_LIMIT} 个）`)
    if (raw.scanTruncated === true) lines.push(fullScanNotice(total))
  }
  return {
    ...base,
    baseline: 'ok',
    version,
    added,
    changed,
    removed,
    addedCount: added.length,
    changedCount: changed.length,
    removedCount: removed.length,
    unchangedCount,
    total,
    truncated,
    text: clipSnapshotText(lines.join('\n')),
    summary: `增量：新增 ${added.length} / 变化 ${changed.length} / 移除 ${removed.length}（标签页 ${base.tabId}）`,
  }
}

function findRefByXpath(tab, xpath) {
  for (const [ref, item] of tab.refs) {
    if (item.xpath === xpath) return ref
  }
  return null
}

function describeQuery(query) {
  const parts = []
  if (query.text) parts.push(`text "${query.text}"`)
  else if (query.selector) parts.push(`selector "${query.selector}"`)
  if (query.role) parts.push(`role "${query.role}"`)
  return parts.join('，')
}

function formatQueryLine(item) {
  const idText = item.id ? `#${item.id}` : ''
  const classText = item.classes.length > 0 ? `.${item.classes.join('.')}` : ''
  const refText = item.ref ? item.ref.replace('@', '') : '-'
  const hiddenText = item.hidden === true ? 'hidden' : 'visible'
  return `  [${refText}] ${item.tag}${idText}${classText} "${item.name}"`
    + ` · selector=${item.selector} · ${hiddenText}`
}

/** query：定位元素并给出可直接使用的 selector；不读写 ref 表与 delta 基线。 */
function runQuery(tab, index, raw, base, query) {
  const matches = (Array.isArray(raw.matches) ? raw.matches : []).map((match) => {
    const item = {
      ref: index === 0 ? findRefByXpath(tab, match.xpath) : null,
      tag: match.tag,
      id: match.id,
      classes: match.classes,
      role: match.role,
      name: match.name,
      text: match.text,
      box: match.box,
      xpath: match.xpath,
      selector: match.selector,
    }
    if (match.hidden === true) item.hidden = true
    return item
  })
  const totalMatched = matches.length
  const count = Math.min(query.limit, totalMatched)
  const shown = matches.slice(0, count)
  const truncated = totalMatched > count
  const desc = describeQuery(query)
  let text
  if (shown.length === 0) {
    text = `未命中 ${desc} 的元素（已扫描 ${raw.scanned ?? 0} 个）；可放宽 includeHidden、改用 selector 或去掉 role 限制`
  } else {
    const lines = [`查询命中 ${count} 个元素（${desc}）`]
    for (const item of shown) lines.push(formatQueryLine(item))
    if (truncated) lines.push(`（共 ${totalMatched} 个命中，只列出前 ${count} 个）`)
    text = lines.join('\n')
  }
  return {
    ...base,
    count,
    totalMatched,
    matches: shown,
    truncated,
    text: clipSnapshotText(text),
    summary: `查询命中 ${count} 个元素`,
  }
}

/**
 * 快照：缺省全量；`delta: true` 只返回自上次快照以来的变化；`query` 定位元素；`frame` 读取同源 iframe。
 *
 * ref 语义：全量在主文档重建 ref 表（旧 ref 全部失效）；delta 按稳定 key 增量并入，仍在的元素
 * 继续可用旧 ref；子 frame 只读，不分配 ref、不写 ref 表。
 * @param {object} session - 会话状态
 * @param {string} [tabId] - 标签页 id
 * @param {{delta?: boolean, query?: object, frame?: number|string}} [options] - 快照选项
 * @returns {Promise<object>} 快照结果
 */
export async function snapshot(session, tabId, options = {}) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  const opts = normalizeSnapshotOptions(options)
  const { frame, index, info } = resolveSnapshotFrame(page, opts.frame)
  if (index > 0) assertSameOriginFrame(page, frame, index)
  const raw = await readSnapshotRaw(frame, opts, index)
  if (raw?.invalidSelector === true) {
    throw new Error(`query.selector 不是合法 CSS 选择器：${opts.query.selector}`)
  }
  const base = {
    tabId: tab.id,
    url: page.url(),
    mode: opts.query ? 'query' : (opts.delta ? 'delta' : 'full'),
    frame: info,
    scanTruncated: raw?.scanTruncated === true,
  }
  if (opts.query) return runQuery(tab, index, raw, base, opts.query)
  if (opts.delta) return runDeltaSnapshot(tab, frame, index, raw, base)
  return runFullSnapshot(tab, frame, index, raw, base)
}

/** 视口基准尺寸：有固定视口用视口；CDP 接管模式没有固定视口，用页面实际内尺寸。 */
async function viewportBounds(page, viewport) {
  if (viewport) return { width: viewport.width, height: viewport.height }
  try {
    return await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
    }))
  } catch {
    return null
  }
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
function targetOf(options, verb) {
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
function requireTarget(options, label, avoid) {
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

/**
 * 点击。三种方式三选一：
 * - ref：来自 snapshot 的 @N，点击前先复验 xpath 仍命中且有可见尺寸；
 * - selector：CSS 选择器，先等可见再点；
 * - x + y：视口坐标，走真实鼠标事件。
 * @param {object} session - 会话状态
 * @param {{ref?: string, selector?: string, x?: number, y?: number}} target - 目标
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
  const { ref, selector, hasPoint } = targetOf(target, 'click')

  if (ref) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    // 点击前复验：xpath 仍命中节点，且节点有可见尺寸；失效就直接报错，不静默点错。
    await revalidateRef(page, item, ref)
    const locator = page.locator(`xpath=${item.xpath}`)
    await locator.scrollIntoViewIfNeeded()
    await locator.click({ timeout: 10000 })
    return { mode: 'ref', ref, tag: item.tag, name: item.name, summary: `点击 ${ref} (${item.tag} "${item.name}")` }
  }

  if (selector) {
    const locator = page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    await locator.click({ timeout: 10000 })
    return { mode: 'selector', selector, summary: `点击 selector "${selector}"` }
  }

  const x = Number(target.x)
  const y = Number(target.y)
  await assertPointInViewport(page, x, y)
  await page.mouse.click(x, y)
  return { mode: 'point', x, y, summary: `点击坐标 (${x}, ${y})` }
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

/** 键盘按键，如 Enter / Tab / Control+A。 */
export async function press(session, keyName, tabId) {
  const page = currentTab(session, tabId).page
  await page.keyboard.press(keyName)
  return { key: keyName, summary: `按键 ${keyName}` }
}

/** 在页面上下文执行 JavaScript 表达式并返回结果。 */
export async function evaluate(session, expression, tabId) {
  const page = currentTab(session, tabId).page
  const value = await page.evaluate(expression)
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  return { value, summary: `求值 JS 表达式（返回 ${type}）` }
}

/** 读取控制台记录尾部若干条（默认 100），最新在最后。 */
export async function consoleEntries(session, limit = 100, tabId) {
  session.touch()
  const tab = currentTab(session, tabId)
  const ring = tab.consoleRing
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RING_LIMIT) : 100
  const entries = ring.slice(-take)
  const lines = entries.map((entry) => `${timeOf(entry.at)} ${entry.level} ${oneLine(entry.text)}`)
  return {
    tabId: tab.id,
    total: ring.length,
    count: entries.length,
    entries,
    text: lines.length > 0 ? lines.join('\n') : '（暂无控制台记录）',
    summary: `控制台记录 ${entries.length} 条`,
  }
}

/** 读取网络请求记录尾部若干条（默认 100），最新在最后。 */
export async function networkEntries(session, limit = 100, tabId) {
  session.touch()
  const tab = currentTab(session, tabId)
  const ring = tab.networkRing
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RING_LIMIT) : 100
  const entries = ring.slice(-take)
  const lines = entries.map((entry) => {
    const status = entry.status > 0 ? String(entry.status) : '0(无响应)'
    const parts = [`${timeOf(entry.at)}`, entry.method, status, entry.mimeType || '-', entry.url]
    if (entry.failure) parts.push(`失败: ${entry.failure}`)
    return parts.join(' ')
  })
  return {
    tabId: tab.id,
    total: ring.length,
    count: entries.length,
    entries,
    text: lines.length > 0 ? lines.join('\n') : '（暂无网络记录）',
    summary: `网络请求 ${entries.length} 条`,
  }
}

/** browser_e2e_wait 的 selector 状态。 */
const WAIT_STATES = ['attached', 'visible', 'hidden', 'detached']

/** url / response 条件共用的 URL 匹配方式。 */
const URL_MATCH_MODES = ['includes', 'glob', 'regex']

/** url 条件的轮询间隔（毫秒）。 */
const WAIT_POLL_MS = 100

/** response 条件缺省的状态码区间。 */
const WAIT_STATUS_MIN = 100
const WAIT_STATUS_MAX = 599

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
function waitConditionOf(options) {
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
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs 必须是正整数，收到 ${timeoutMs}`)
  }
  if (condition.name === 'selector') return await waitForSelectorCondition(tab.page, condition, timeoutMs)
  if (condition.name === 'expression') return await waitForExpressionCondition(tab.page, condition, timeoutMs)
  if (condition.name === 'url') return await waitForUrlCondition(tab.page, tab, condition, timeoutMs)
  return await waitForResponseCondition(tab, condition, timeoutMs)
}
