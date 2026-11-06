/**
 * 过渡文件：页面能力、鉴权补票与截图尚未拆到 page.js / capture.js / auth.js 的部分。
 * 会话层已抽到 session.js、标签页与事件环已抽到 page.js；本文件在 S3（实现层拆分）
 * 完成后删除。
 *
 * 用系统 Edge（channel: 'msedge'）而不是 ms-playwright 下载的 Chromium：后者位于
 * %LOCALAPPDATA%\ms-playwright\...，二进制无数字签名，360 主动防御会判定为远程线程注入
 * 并弹窗；系统 Edge 有微软签名，360 放行。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  addPage, clearRings, createPage, currentTab, oneLine, RING_LIMIT, SNAPSHOT_LIMIT, timeOf,
} from './page.js'
import {
  close, closeAll, closeBySessionId, closeTab, ensureArtifactsDir, emitPanelEvent, launch, listPanelTabs,
  panelPage, requireSession, sessionOf, subscribePanelEvents, tabs, touchSession, activeSessionKeys,
} from './session.js'
import { isLoopbackHostname } from './fence.js'
import { assertRefBelongsToTab, assertRefRevalidated } from './invariants.js'

/** 截图输出约束：单边最大边长、最大总像素。 */
const MAX_SHOT_EDGE = 8192
const MAX_SHOT_PIXELS = 4194304

/** 截图允许的输出格式与缩放模式（css / device 透传 Playwright，1 / 2 / 3 走 CDP 倍率）。 */
const SHOT_FORMATS = new Set(['png', 'jpeg'])
const SHOT_SCALES = new Set(['css', 'device'])
/** 数值倍率走 Page.captureScreenshot 的 clip.scale。 */
const SHOT_NUMERIC_SCALES = new Set([1, 2, 3])

/** browser_e2e_wait 的 selector 状态。 */
const WAIT_STATES = ['attached', 'visible', 'hidden', 'detached']

/** 登录挑战的识别词（页面标题或正文命中即视为需要补票）。 */
const AUTH_CHALLENGE_PATTERN = /authenticat(e|ion)\s+required/i

/** 登录探测只读正文开头这一段，避免大页面拖慢导航。 */
const AUTH_PROBE_TEXT_LIMIT = 4000

/** 外部注入的 connection 读取器；宿主没有该服务时保持 null，补票静默跳过。 */
let connectionResolver = null

/**
 * 注入 connection 服务读取器（M7 鉴权补票用）。
 * @param {(() => unknown) | null} resolver - 读取器；null 表示关闭补票
 */
export function setConnectionResolver(resolver) {
  connectionResolver = typeof resolver === 'function' ? resolver : null
}

/** 目标地址是否 loopback http(s)（只有这种目标值得补票）。 */
function isLoopbackTarget(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

/** 页面是否落在 DSH 的登录挑战页上（标题或正文命中识别词）。 */
async function isAuthChallenge(page) {
  try {
    const probe = await page.evaluate((limit) => ({
      title: document.title || '',
      text: (document.body?.innerText || '').slice(0, limit),
    }), AUTH_PROBE_TEXT_LIMIT)
    return AUTH_CHALLENGE_PATTERN.test(String(probe.title)) || AUTH_CHALLENGE_PATTERN.test(String(probe.text))
  } catch {
    return false
  }
}

/**
 * 命中登录挑战时向 connection 服务要一条带 launch-token 的地址并重试一次。
 *
 * 取不到服务 / 拿不到地址 / 重试失败都返回 null，由调用方保持原导航结果，不抛错；
 * 因此没有 connection 服务的宿主里这段就是空操作。
 * @param {import('playwright-core').Page} page - 当前页面
 * @param {string} url - 原始目标地址
 * @returns {Promise<import('playwright-core').Response | null>} 重试的响应，失败为 null
 */
async function tryAuthTopUp(page, url) {
  if (!isLoopbackTarget(url)) return null
  if (typeof connectionResolver !== 'function') return null
  let connection
  try {
    connection = connectionResolver()
  } catch {
    return null
  }
  if (!connection || typeof connection.authenticatedUrl !== 'function') return null
  let authenticated
  try {
    authenticated = connection.authenticatedUrl(url)
  } catch {
    return null
  }
  if (typeof authenticated !== 'string' || authenticated.length === 0 || authenticated === url) return null
  try {
    return await page.goto(authenticated, { waitUntil: 'load', timeout: 30000 })
  } catch {
    return null
  }
}

/**
 * 导航到指定地址；new_tab 为真时新建标签页，否则用 tab_id 指定的页（缺省 active）。
 * 导航成功会清空该页的 ref 表与控制台 / 网络记录。
 * @param {string} key - 会话 key
 * @param {string} url - 目标地址
 * @param {string} [waitUntil] - load | domcontentloaded | networkidle
 * @param {string} [sessionId] - 会话 id
 * @param {{tab_id?: string, new_tab?: boolean}} [options] - 目标标签页 / 是否新开
 * @returns {Promise<object>} 导航结果
 */
export async function navigate(key, url, waitUntil = 'load', sessionId, options = {}) {
  const session = sessionOf(key, sessionId)
  if (session.pages.size === 0) {
    throw new Error('浏览器尚未启动，请先调用 browser_e2e_start')
  }
  let tab
  if (options.new_tab === true) {
    tab = addPage(session, await createPage(session))
  } else {
    tab = currentTab(session, options.tab_id)
  }
  session.activeTabId = tab.id
  // 导航开始前先清一次：goto 失败时旧记录也不会挂在新导航结果里；新文档自身的请求
  // 会在 request 事件里重新登记，不会被这里的清空误删。
  clearRings(tab)
  tab.refs.clear()
  let response = await tab.page.goto(url, { waitUntil, timeout: 30000 })
  // M7：命中登录挑战时补一次带 launch-token 的地址；每个 tab 每次导航只试一次。
  let authRetried = false
  if (await isAuthChallenge(tab.page)) {
    const retried = await tryAuthTopUp(tab.page, url)
    if (retried) {
      response = retried
      authRetried = true
    }
  }
  tab.refs.clear()
  emitPanelEvent({ type: 'changed', key })
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
      ? `导航到 ${finalUrl}（tag ${tab.id}，无响应对象${authRetried ? '，已补票' : ''}）`
      : `导航到 ${finalUrl}（tag ${tab.id}，HTTP ${status}${authRetried ? '，已补票' : ''}）`,
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
        const label = document.querySelector(`label[for="${el.id}"]`)
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
 */
export async function snapshot(key, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
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

function requireRef(tab, ref) {
  return assertRefBelongsToTab(tab.refs, ref)
}

/**
 * 视口基准尺寸：有固定视口用视口；CDP 接管模式没有固定视口，用页面实际内尺寸。
 * @returns {Promise<{width: number, height: number} | null>} 取不到时返回 null
 */
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

/**
 * 点击。三种方式三选一：
 * - ref：来自 snapshot 的 @N，点击前先复验 xpath 仍命中且有可见尺寸；
 * - selector：CSS 选择器，先等可见再点；
 * - x + y：视口坐标，走真实鼠标事件。
 */
export async function click(key, target = {}, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const tab = currentTab(session, tabId)
  const page = tab.page
  // 向后兼容旧签名 click(key, ref)。
  const options = typeof target === 'string' ? { ref: target } : target ?? {}
  const ref = typeof options.ref === 'string' && options.ref.length > 0 ? options.ref : null
  const selector = typeof options.selector === 'string' && options.selector.length > 0 ? options.selector : null
  const hasPoint = Number.isFinite(options.x) && Number.isFinite(options.y)
  const modes = [ref, selector, hasPoint].filter(Boolean).length

  if (modes === 0) {
    throw new Error('缺少点击目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一')
  }
  if (modes > 1) {
    throw new Error('点击目标只能给一种：ref / selector / x + y 三选一，避免点错位置')
  }

  if (ref) {
    const item = requireRef(tab, ref)
    // 点击前复验：xpath 仍命中节点，且节点有可见尺寸；失效就直接报错，不静默点错。
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

  const x = Number(options.x)
  const y = Number(options.y)
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
 */
export async function fill(key, target, value, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const tab = currentTab(session, tabId)
  const page = tab.page
  // 向后兼容旧签名 fill(key, ref, value)。
  const options = typeof target === 'string' ? { ref: target } : target ?? {}
  const ref = typeof options.ref === 'string' && options.ref.length > 0 ? options.ref : null
  const selector = typeof options.selector === 'string' && options.selector.length > 0 ? options.selector : null
  const hasPoint = Number.isFinite(options.x) && Number.isFinite(options.y)
  const modes = [ref, selector, hasPoint].filter(Boolean).length

  if (modes === 0) {
    throw new Error('缺少填写目标：需要 ref / selector / x + y 三者之一')
  }
  if (modes > 1) {
    throw new Error('填写目标只能给一种：ref / selector / x + y 三选一，避免填错位置')
  }

  if (ref) {
    const item = requireRef(tab, ref)
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

  const x = Number(options.x)
  const y = Number(options.y)
  await assertPointInViewport(page, x, y)
  await page.mouse.click(x, y)
  await page.keyboard.type(value)
  return { mode: 'point', x, y, value, summary: `填写坐标 (${x}, ${y}) <- "${value}"` }
}

/**
 * 滚动页面。有 x / y 时先移动鼠标到该坐标再滚；否则在当前位置滚动。
 */
export async function scroll(key, options = {}, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
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
  touchSession(session)
  return {
    mode: 'scroll',
    deltaX,
    deltaY,
    summary: `滚动页面 (${deltaX}, ${deltaY})`,
  }
}

/** 键盘按键，如 Enter / Tab / Control+A。 */
export async function press(key, keyName, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const page = currentTab(session, tabId).page
  await page.keyboard.press(keyName)
  return { key: keyName, summary: `按键 ${keyName}` }
}

/** 从 PNG / JPEG 文件头解析图片实际像素尺寸；解析失败返回 null。 */
function imageSize(buffer) {
  // PNG：签名 8 字节 + IHDR，宽高在 16..24 字节。
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG：扫描 SOFn 段，段内依次为精度(1)、高(2)、宽(2)。
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      offset += 2 + buffer.readUInt16BE(offset + 2)
    }
  }
  return null
}

/** 校验 clip 参数：四值整数、x/y 非负、宽高不小于 1。 */
function assertClip(clip) {
  if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
    throw new Error('clip 必须是 { x, y, width, height } 对象')
  }
  for (const field of ['x', 'y', 'width', 'height']) {
    if (!Number.isInteger(clip[field])) {
      throw new Error(`clip.${field} 必须是整数，收到 ${clip[field]}`)
    }
  }
  if (clip.x < 0 || clip.y < 0) {
    throw new Error(`clip.x / clip.y 不能为负数，收到 x=${clip.x}, y=${clip.y}`)
  }
  if (clip.width < 1 || clip.height < 1) {
    throw new Error(`clip.width / clip.height 必须 >= 1，收到 ${clip.width}x${clip.height}`)
  }
}

/** 计算截图的 CSS 像素基准尺寸（clip 优先、其次整页、最后视口）。 */
async function shotBaseSize(page, { clip, fullPage, viewport }) {
  if (clip) return { width: clip.width, height: clip.height }
  if (fullPage) {
    return await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    }))
  }
  if (!viewport) {
    // CDP 接管模式没有固定视口（视口属于用户浏览器），按页面实际内尺寸兜底。
    return await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
    }))
  }
  return { width: viewport.width, height: viewport.height }
}

/**
 * 截图落盘，返回绝对路径与元数据。
 *
 * 支持 clip / format / quality / scale；截图前完成全部参数与输出尺寸校验，
 * 报错里带具体数字。返回的 data 为图片原始字节，供工具层转存为附件。
 */
export async function screenshot(key, options = {}, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const tab = currentTab(session, options.tab_id ?? tabId)
  const page = tab.page

  const format = options.format ?? 'png'
  if (!SHOT_FORMATS.has(format)) {
    throw new Error(`不支持的截图格式 "${format}"，只支持 png 或 jpeg`)
  }
  const quality = options.quality
  if (quality !== undefined) {
    if (format !== 'jpeg') {
      throw new Error('quality 仅适用于 format="jpeg"')
    }
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new Error(`quality 必须是 1-100 的整数，收到 ${quality}`)
    }
  }
  const scale = options.scale
  // 数值倍率（1 / 2 / 3）走 CDP 的 clip.scale；css / device 仍透传 Playwright。
  const numericScale = SHOT_NUMERIC_SCALES.has(scale) ? scale : null
  if (scale !== undefined && numericScale === null && !SHOT_SCALES.has(scale)) {
    throw new Error(`scale 只支持 "css" / "device" / 1 / 2 / 3，收到 ${JSON.stringify(scale)}`)
  }
  const clip = options.clip
  if (clip !== undefined) assertClip(clip)
  const fullPage = options.fullPage ?? false
  if (clip !== undefined && fullPage) {
    throw new Error('clip 与 fullPage 不能同时使用')
  }

  const viewport = page.viewportSize()
  // CDP 接管模式没有固定视口，用页面实际内尺寸做 clip 边界校验，与隔离模式同口径。
  const clipBounds = clip ? await viewportBounds(page, viewport) : null
  if (clip && clipBounds) {
    if (clip.x + clip.width > clipBounds.width) {
      throw new Error(`clip 超出视口宽度：x + width = ${clip.x + clip.width} > 视口宽度 ${clipBounds.width}`)
    }
    if (clip.y + clip.height > clipBounds.height) {
      throw new Error(`clip 超出视口高度：y + height = ${clip.y + clip.height} > 视口高度 ${clipBounds.height}`)
    }
  }

  const base = await shotBaseSize(page, { clip, fullPage, viewport })
  // 数值倍率按倍率换算；css / device 按 Playwright 实际生效的缩放（device 默认）换算。
  let factor
  if (numericScale !== null) factor = numericScale
  else if (scale === 'css') factor = 1
  else factor = await page.evaluate(() => window.devicePixelRatio || 1)
  const outWidth = Math.round(base.width * factor)
  const outHeight = Math.round(base.height * factor)
  if (outWidth > MAX_SHOT_EDGE || outHeight > MAX_SHOT_EDGE) {
    throw new Error(`截图输出 ${outWidth}x${outHeight} 超出单边上限 ${MAX_SHOT_EDGE}`)
  }
  if (outWidth * outHeight > MAX_SHOT_PIXELS) {
    throw new Error(`截图输出 ${outWidth}x${outHeight} 共 ${outWidth * outHeight} 像素，超出上限 ${MAX_SHOT_PIXELS}`)
  }

  let buffer
  if (numericScale !== null) {
    // Playwright 的 scale 只有 css / device，倍率截图改用 CDP 的 Page.captureScreenshot。
    const client = await page.context().newCDPSession(page)
    try {
      const params = { format, captureBeyondViewport: false }
      if (format === 'jpeg' && quality !== undefined) params.quality = quality
      if (clip) {
        params.clip = {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: numericScale,
        }
      } else if (fullPage) {
        // 整页 + 倍率：必须显式给整页 clip，否则只能截到视口那一屏。
        params.clip = { x: 0, y: 0, width: base.width, height: base.height, scale: numericScale }
        params.captureBeyondViewport = true
      }
      const shot = await client.send('Page.captureScreenshot', params)
      buffer = Buffer.from(shot.data, 'base64')
    } finally {
      await client.detach().catch(() => {})
    }
  } else {
    // Playwright 的截图格式参数名是 type（png / jpeg），不是 format。
    const shotOptions = { fullPage, type: format }
    if (clip) shotOptions.clip = clip
    if (quality !== undefined) shotOptions.quality = quality
    if (scale === 'css' || scale === 'device') shotOptions.scale = scale
    buffer = await page.screenshot(shotOptions)
  }
  const dir = ensureArtifactsDir(session)
  const extension = format === 'jpeg' ? 'jpeg' : 'png'
  const baseName = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : `shot-${Date.now()}`
  const file = join(dir, `${baseName}.${extension}`)
  writeFileSync(file, buffer)

  const actual = imageSize(buffer)
  const width = actual?.width ?? outWidth
  const height = actual?.height ?? outHeight
  const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  return {
    file,
    data: buffer,
    meta: {
      width,
      height,
      format,
      mediaType,
      bytes: buffer.length,
      fullPage,
      name: `${baseName}.${extension}`,
      ...(clip !== undefined ? { clip } : {}),
      ...(scale !== undefined ? { scale } : {}),
    },
    summary: `截图 ${width}x${height} -> ${file}`,
  }
}

/** 在页面上下文执行 JavaScript 表达式并返回结果。 */
export async function evaluate(key, expression, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const page = currentTab(session, tabId).page
  const value = await page.evaluate(expression)
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  return { value, summary: `求值 JS 表达式（返回 ${type}）` }
}

/** 读取控制台记录尾部若干条（默认 100），最新在最后。 */
export async function consoleEntries(key, limit = 100, tabId) {
  const session = requireSession(key)
  touchSession(session)
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
export async function networkEntries(key, limit = 100, tabId) {
  const session = requireSession(key)
  touchSession(session)
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

/** 等待 selector 或 expression 满足条件，返回实际耗时。 */
export async function waitFor(key, options = {}, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
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
  } catch {
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

/**
 * 抓一帧 JPEG（base64），供刷新按钮与静态页面兜底。
 *
 * 投屏只在页面变化时产生帧，静态页面会停在最后一帧；刷新按钮走这条路径，
 * 保证「按一下就有画面」。
 * @param {string} panelId - 面板 tab id（`会话key#tab_id`）
 * @param {{quality?: number}} [options] - quality 为 1-100 的 JPEG 质量
 * @returns {Promise<{data: string, width: number, height: number} | null>} 无页面时返回 null
 */
export async function captureJpeg(panelId, options = {}) {
  const page = panelPage(panelId)
  if (!page) return null
  const quality = Number.isInteger(options.quality) ? options.quality : 70
  const buffer = await page.screenshot({ type: 'jpeg', quality })
  const actual = imageSize(buffer)
  const viewport = page.viewportSize()
  return {
    data: buffer.toString('base64'),
    width: actual?.width ?? viewport?.width ?? 0,
    height: actual?.height ?? viewport?.height ?? 0,
  }
}

// ── 过渡期转发（S3 拆分完成后删除，仅让既有 import 路径在本步继续可用） ──────────
export {
  activeSessionKeys, close, closeAll, closeBySessionId, closeTab, emitPanelEvent, ensureArtifactsDir, launch,
  listPanelTabs, panelPage, subscribePanelEvents, tabs,
}
