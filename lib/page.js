/**
 * 页面层：标签页条目与生命周期、事件环（控制台 / 网络环形缓冲、ref 表）。
 *
 * 本文件不 import 会话层：所有函数接收 session 对象，需要广播面板事件时调用 session.emit
 * （由 session.js 在 sessionOf 里挂上）。因此会话层可以单向调用页面层，页面层不回指。
 */
import { assertBrowserRunning, assertCdpConnected, assertCurrentTabAvailable, assertTabExists } from './invariants.js'

/** 默认视口。 */
export const DEFAULT_VIEWPORT = { width: 1600, height: 900 }

/** 控制台 / 网络记录的环形缓冲上限，超出时从头裁。 */
export const RING_LIMIT = 500

/** 单条控制台文本的最大长度。 */
export const CONSOLE_TEXT_LIMIT = 2000

/** snapshot 单次最多返回的节点数（全 DOM 快照比只收可交互元素多得多，上限相应放大）。 */
export const SNAPSHOT_LIMIT = 4000

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

/** 新建一个页面并返回（隔离模式沿用启动时的视口，CDP 模式用浏览器默认）。 */
export async function createPage(session) {
  if (session.mode === 'cdp') {
    assertCdpConnected(session)
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
    if (frame !== page.mainFrame()) return
    // 主框架开始导航：进入 loading。事件环的重置在 request 里按新文档请求做，
    // 这里不再按 URL 判断（同 URL reload 也会换文档）。
    entry.loading = true
    notifyChanged()
  })
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

/** 取页面标题；取不到或超时返回空串，用于 tab 列表。 */
export async function titleOf(page) {
  try {
    return await Promise.race([
      page.title(),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(''), 400)
        timer.unref?.()
      }),
    ])
  } catch {
    return ''
  }
}
