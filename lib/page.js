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

/** 上传：单次文件总字节数缺省上限（20 MiB）。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** 上传：单次文件总字节数允许调到的上限（512 MiB）。 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/** 上传：单次最多文件个数。 */
export const MAX_UPLOAD_FILES = 20

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
    if (frame !== page.mainFrame()) return
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
  let response = await tab.page.goto(url, { waitUntil, timeout: 30000 })
  // 命中登录挑战时补一次带 launch-token 的地址；每个 tab 每次导航只试一次。
  const topped = await topUpIfChallenged(tab.page, url, response)
  response = topped.response
  const authRetried = topped.retried
  tab.refs.clear()
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
 * 页面内脚本：收集全部可见元素并给出 xpath（注入到页面上下文执行，不引用外部变量）。
 * @param {number} limit - 最多返回的节点数；total 仍是实际可见节点数
 * @returns {{nodes: Array<object>, total: number}}
 */
function snapshotScript(limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 4000
  const NAME_LIMIT = 80
  const TEXT_LIMIT = 120
  const CLASS_LIMIT = 8
  /** 这些标签没有可见内容，直接跳过。 */
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title', 'base'])
  /** 纯布局容器不用后代文本作 name：否则每个祖先都会重复整页文本。 */
  const CONTAINER_TAGS = new Set([
    'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside',
    'nav', 'form', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr',
    'fieldset', 'details', 'dialog', 'figure',
  ])

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

  function xpathFor(el) {
    if (el.id && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(el.id)) {
      return `//*[@id="${el.id}"]`
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase()
      let idx = 1
      let sib = node.previousElementSibling
      while (sib) {
        if (sib.tagName === node.tagName) idx++
        sib = sib.previousElementSibling
      }
      parts.unshift(`${tag}[${idx}]`)
      node = node.parentElement
    }
    return '/' + parts.join('/')
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

  const nodes = []
  let total = 0
  const all = document.body ? document.body.querySelectorAll('*') : []
  for (const el of all) {
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    const rect = el.getBoundingClientRect()
    if (!visibleEnough(el, rect)) continue
    total += 1
    if (nodes.length >= cap) continue
    const text = textOf(el)
    const classes = el.classList ? Array.from(el.classList).slice(0, CLASS_LIMIT) : []
    nodes.push({
      tag,
      id: el.id || '',
      classes,
      role: roleFor(el),
      name: nameFor(el, text),
      text,
      // 视口相对 CSS 像素；四值取整，便于按坐标点击时直接使用。
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      depth: depthFor(el),
      xpath: xpathFor(el),
    })
  }
  return { nodes, total }
}

/**
 * 快照整页可见元素并重建该标签页的 ref 表。
 * ref 为 @N（按节点数组下标，从 0 开始），click / fill 的 ref 分支沿用 refs 表里的 xpath。
 * @param {object} session - 会话状态
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 快照结果
 */
export async function snapshot(session, tabId) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  const collected = await page.evaluate(snapshotScript, SNAPSHOT_LIMIT)
  const all = Array.isArray(collected?.nodes) ? collected.nodes : []
  const total = Number.isInteger(collected?.total) ? collected.total : all.length
  const truncated = total > SNAPSHOT_LIMIT
  const items = (truncated ? all.slice(0, SNAPSHOT_LIMIT) : all).map((node, idx) => ({ ...node, ref: `@${idx}` }))
  tab.refs.clear()
  for (const item of items) tab.refs.set(item.ref, item)
  const lines = items.map((i) => {
    const idText = i.id ? `#${i.id}` : ''
    const classText = i.classes.length > 0 ? `.${i.classes.join('.')}` : ''
    // 按到 body 的层级缩进两格，层级关系一眼可见。
    const indent = '  '.repeat(i.depth)
    return `${indent}[${i.ref.replace('@', '')}] ${i.tag}${idText}${classText} "${i.name}"`
      + ` box(${i.box.x},${i.box.y},${i.box.width},${i.box.height})`
  })
  const text = lines.length > 0 ? lines.join('\n') : '（未发现可见元素）'
  return {
    tabId: tab.id,
    url: page.url(),
    count: items.length,
    total,
    truncated,
    nodes: items,
    text: truncated
      ? `${text}\n\n（已截断：共 ${total} 个可见元素，只返回前 ${SNAPSHOT_LIMIT} 个）`
      : text,
    summary: `快照 ${items.length} 个可见元素${truncated ? `（共 ${total} 个，已截断到 ${SNAPSHOT_LIMIT} 个）` : ''}`,
  }
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
 * 解析交互目标：ref / selector / x + y 三选一。
 * @param {object} options - 目标参数
 * @param {string} verb - 动作词（click / fill / upload），决定报错文案
 * @returns {{ref: string|null, selector: string|null, hasPoint: boolean}}
 */
function targetOf(options, verb) {
  const ref = typeof options.ref === 'string' && options.ref.length > 0 ? options.ref : null
  const selector = typeof options.selector === 'string' && options.selector.length > 0 ? options.selector : null
  const hasPoint = Number.isFinite(options.x) && Number.isFinite(options.y)
  const modes = [ref, selector, hasPoint].filter(Boolean).length
  const messages = TARGET_MESSAGES[verb]
  if (modes === 0) throw new Error(messages[0])
  if (modes > 1) throw new Error(messages[1])
  return { ref, selector, hasPoint }
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

/**
 * 填写文本。三种目标三选一（ref / selector / x + y）。
 * @param {object} session - 会话状态
 * @param {{ref?: string, selector?: string, x?: number, y?: number}} target - 目标
 * @param {string} value - 要填入的文本
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} 填写结果
 */
export async function fill(session, target, value, tabId) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  const { ref, selector } = targetOf(target, 'fill')

  if (ref) {
    const item = assertRefBelongsToTab(tab.refs, ref)
    // 与 click 同一条复验：元素被移除 / 不可见时直接报「已失效」，不往旧 xpath 上填。
    await revalidateRef(page, item, ref)
    const locator = page.locator(`xpath=${item.xpath}`)
    await locator.scrollIntoViewIfNeeded()
    await assertFillable(locator, `ref ${ref}`)
    await locator.click({ timeout: 10000 })
    await locator.fill(value, { timeout: 10000 })
    return {
      mode: 'ref',
      ref,
      tag: item.tag,
      label: item.name,
      value,
      summary: `填写 ${ref} (${item.tag} "${item.name}") <- "${value}"`,
    }
  }

  if (selector) {
    const locator = page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    await assertFillable(locator, `selector "${selector}"`)
    await locator.click({ timeout: 10000 })
    await locator.fill(value, { timeout: 10000 })
    return { mode: 'selector', selector, value, summary: `填写 selector "${selector}" <- "${value}"` }
  }

  const x = Number(target.x)
  const y = Number(target.y)
  await assertPointInViewport(page, x, y)
  await page.mouse.click(x, y)
  await page.keyboard.type(value)
  return { mode: 'point', x, y, value, summary: `填写坐标 (${x}, ${y}) <- "${value}"` }
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

/** 等待 selector 或 expression 满足条件，返回实际耗时。 */
export async function waitFor(session, options = {}, tabId) {
  const page = currentTab(session, options.tab_id ?? tabId).page
  const selector = typeof options.selector === 'string' && options.selector.length > 0 ? options.selector : null
  const expression = typeof options.expression === 'string' && options.expression.length > 0 ? options.expression : null
  if (Boolean(selector) === Boolean(expression)) {
    throw new Error('selector 与 expression 二选一，必须且只能给一个')
  }
  const state = options.state ?? 'visible'
  if (!WAIT_STATES.includes(state)) {
    throw new Error(`不支持的 state "${state}"，可选 attached / visible / hidden / detached`)
  }
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs 必须是正整数，收到 ${timeoutMs}`)
  }

  const started = Date.now()
  try {
    if (selector) {
      await page.waitForSelector(selector, { state, timeout: timeoutMs })
    } else {
      await page.waitForFunction(expression, undefined, { timeout: timeoutMs })
    }
  } catch (error) {
    // 只有超时才改写成「等待超时」；非法 selector / 目标页已关闭等异常原样抛出，
    // 否则调用方会把参数错误误读成「等不到元素」。
    const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message ?? error))
    if (!isTimeout) throw error
    const elapsed = Date.now() - started
    const target = selector ? `selector "${selector}"（state=${state}）` : `表达式 ${expression}`
    throw new Error(`等待 ${target} 超时：实际等待 ${elapsed}ms（上限 ${timeoutMs}ms）`)
  }
  const elapsedMs = Date.now() - started
  return {
    mode: selector ? 'selector' : 'expression',
    state,
    timeoutMs,
    elapsedMs,
    summary: selector ? `等待 selector "${selector}" ${state} ${elapsedMs}ms` : `等待表达式 ${expression} ${elapsedMs}ms`,
  }
}
