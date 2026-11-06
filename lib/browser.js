/**
 * dsh-browser-e2e 的浏览器会话层：系统 Edge + Playwright，供 browser_* 工具调用。
 *
 * 用系统 Edge（channel: 'msedge'）而不是 ms-playwright 下载的 Chromium：
 * 后者位于 %LOCALAPPDATA%\ms-playwright\...，二进制无数字签名，360 主动防御
 * 会判定为远程线程注入并弹窗，必须人工点"允许"才能继续，无人值守时会卡死。
 * 系统 Edge 有微软签名，360 放行；两者同为 Blink 内核，测量结果一致。
 * 该做法与 PI 的 browser-e2e 扩展保持一致。
 *
 * 状态按 agent 隔离：每个 agent（会话）拥有独立的浏览器与 ref 表。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

/** 与系统 Edge 对应的 Playwright channel。 */
const BROWSER_CHANNEL = 'msedge'

/** agent -> { browser, page, refs } */
const sessions = new Map()

/**
 * 右侧面板的事件订阅者。
 *
 * 面板半区需要知道「浏览器开了/关了、页面导航了、标签页变了」才能刷新 tab 状态
 * 与投屏；这里只做进程内广播，不改变任何工具行为。回调异常一律吞掉，面板故障
 * 不能影响工具调用。
 */
const panelListeners = new Set()

/** 向面板订阅者广播一条事件。 */
function emitPanelEvent(event) {
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
 * @param {(event: {type: 'opened'|'closed'|'changed', key: string}) => void} listener - 订阅者
 * @returns {() => void} 取消订阅
 */
export function subscribePanelEvents(listener) {
  panelListeners.add(listener)
  return () => {
    panelListeners.delete(listener)
  }
}

/** 默认视口。 */
const DEFAULT_VIEWPORT = { width: 1600, height: 900 }

/**
 * 空闲回收时限（毫秒）。超过此时限没有任何 browser_* 调用，自动关闭该 agent 的浏览器。
 *
 * 没有它，浏览器会一直挂到 DSH 服务重启：进程托管在 dsh web 上，对话结束、
 * 会话切走、子代理结束都不会回收，无头 Edge 会持续吃 CPU。
 * 设 0 可关闭该行为（排查长时间挂起时才需要）。
 */
const IDLE_CLOSE_MS = Number(process.env.DSH_BROWSER_IDLE_MS ?? 600000)

/** session.id（与 agent.id 同源）-> 会话 key，供 session/disposed 精确回收。 */
const keyBySessionId = new Map()

/** 控制台 / 网络记录的环形缓冲上限，超出时从头裁。 */
const RING_LIMIT = 500

/** 单条控制台文本的最大长度。 */
const CONSOLE_TEXT_LIMIT = 2000

/** snapshot 单次最多返回的条目数。 */
const SNAPSHOT_LIMIT = 400

/** 截图输出约束：单边最大边长、最大总像素。 */
const MAX_SHOT_EDGE = 8192
const MAX_SHOT_PIXELS = 4194304

/** 截图允许的输出格式与缩放模式（缩放模式直接透传 Playwright，不自造倍率）。 */
const SHOT_FORMATS = new Set(['png', 'jpeg'])
const SHOT_SCALES = new Set(['css', 'device'])

/** browser_e2e_wait 的 selector 状态。 */
const WAIT_STATES = ['attached', 'visible', 'hidden', 'detached']

/**
 * 关闭浏览器的等待上限（毫秒）。
 *
 * 系统 Edge 偶发在 graceful close 阶段卡住：进程已经退出，Playwright 却等不到
 * 退出事件，`browser.close()` 会一直挂着（实测超过 4 分钟），工具调用随之卡死。
 * 超过该时限就强制结束进程，保证关闭路径一定有返回。
 */
const CLOSE_TIMEOUT_MS = Number(process.env.DSH_BROWSER_CLOSE_TIMEOUT_MS ?? 5000)

/** 清理某个会话的空闲计时器（无计时器则不动）。 */
function clearIdleTimer(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
}

/**
 * 重置空闲计时器。每次 browser_* 调用都刷新，因此只有真正闲置到 IDLE_CLOSE_MS
 * 才关；正在连续操作的会话不受影响。
 *
 * launch 进行中（`session.launching`）不重新计时：此时页还没建好，此时关掉会让
 * 调用直接失败。等 launch 落地后再计时。
 */
function touch(session) {
  if (!IDLE_CLOSE_MS || session.launching) return
  clearIdleTimer(session)
  session.idleTimer = setTimeout(() => {
    void close(session.key)
  }, IDLE_CLOSE_MS)
  // 不因浏览器待回收而拖住进程退出。
  session.idleTimer.unref?.()
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 产物目录：~/.dsh/browser-e2e/artifacts/<时间戳>，按 agent 首次调用时间创建。 */
function ensureArtifactsDir(session) {
  if (!session.artifactsDir) {
    session.artifactsDir = join(homedir(), '.dsh', 'browser-e2e', 'artifacts', stamp())
    mkdirSync(session.artifactsDir, { recursive: true })
  }
  return session.artifactsDir
}

/**
 * 会话状态：一个会话一个浏览器实例，但可以有多个标签页。
 *
 * pages 按稳定的 tab_id（t1、t2 …）索引；ref 表、控制台与网络记录都挂在页上，
 * 因此切 tab 后旧 ref 不会串到另一个页面。activeTabId 是「不给 tab_id 时」的默认页。
 */
function sessionOf(key, sessionId) {
  let session = sessions.get(key)
  if (!session) {
    session = {
      key,
      sessionId: sessionId ?? key,
      mode: 'isolated',
      browser: null,
      context: null,
      pages: new Map(),
      activeTabId: null,
      nextTabSeq: 1,
      viewport: null,
      artifactsDir: null,
      idleTimer: null,
      launching: false,
      hookedPages: new WeakSet(),
    }
    sessions.set(key, session)
  }
  // key 就是 agent.id，本身就是 SessionId；显式传入时以传入值为准。
  keyBySessionId.set(sessionId ?? key, key)
  if (sessionId !== undefined) session.sessionId = sessionId
  touch(session)
  return session
}

/** 当前时间的 ISO 字符串，记录控制台 / 网络条目的发生时刻。 */
function nowAt() {
  return new Date().toISOString()
}

/** 向环形缓冲追加一条记录，超出上限时从头裁（保留最新）。 */
function pushRing(ring, entry) {
  ring.push(entry)
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
}

/** 文本截断到指定长度，超出部分替换为提示。 */
function truncateText(text, limit = CONSOLE_TEXT_LIMIT) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}...(已截断)` : value
}

/** 控制台 / 网络记录的时间显示（HH:MM:SS.mmm）。 */
function timeOf(at) {
  return typeof at === 'string' ? at.slice(11, 23) : ''
}

/** 多行文本压成一行，保证每条记录只占一行。 */
function oneLine(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ')
}

/**
 * 新建一个标签页条目，挂上监听并登记到会话。
 * @param {object} session - 会话状态
 * @param {import('playwright-core').Page} page - Playwright 页面
 * @returns {object} 标签页条目
 */
function addPage(session, page) {
  const entry = {
    id: `t${session.nextTabSeq}`,
    page,
    refs: new Map(),
    consoleRing: [],
    networkRing: [],
    networkByRequest: new Map(),
  }
  session.nextTabSeq += 1
  session.pages.set(entry.id, entry)
  attachPageHooks(session, entry)
  if (session.activeTabId === null) session.activeTabId = entry.id
  emitPanelEvent({ type: 'changed', key: session.key })
  return entry
}

/**
 * 移除一个标签页条目；active tab 落到剩余的第一个。
 * @param {object} session - 会话状态
 * @param {string} tabId - 标签页 id
 * @returns {boolean} 是否真的移除了
 */
function removePage(session, tabId) {
  if (!session.pages.has(tabId)) return false
  session.pages.delete(tabId)
  if (session.activeTabId === tabId) {
    session.activeTabId = session.pages.keys().next().value ?? null
  }
  emitPanelEvent({ type: 'changed', key: session.key })
  return true
}

/**
 * 取当前要操作的标签页。
 * @param {object} session - 会话状态
 * @param {string} [tabId] - 显式 tab_id；缺省用 active tab
 * @returns {object} 标签页条目
 */
function currentTab(session, tabId) {
  if (typeof tabId === 'string' && tabId.length > 0) {
    const entry = session.pages.get(tabId)
    if (!entry) {
      throw new Error(`tab ${tabId} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`)
    }
    return entry
  }
  const active = session.activeTabId === null ? null : session.pages.get(session.activeTabId)
  if (!active) {
    throw new Error('浏览器尚未启动或没有可用标签页，请先 browser_start')
  }
  return active
}

/** 新建一个页面并返回（隔离模式沿用启动时的视口）。 */
async function createPage(session) {
  return await session.browser.newPage({ viewport: session.viewport ?? DEFAULT_VIEWPORT })
}

/**
 * 给页面挂上控制台与网络监听。每个 page 只挂一次。
 *
 * 网络记录用「request 事件建占位、response / requestfailed 原地改字段」的做法：
 * Map 里存的就是 ring 中的同一个对象引用，后续事件直接改写该对象，不再二次查表。
 */
function attachPageHooks(session, entry) {
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
  const notifyChanged = () => emitPanelEvent({ type: 'changed', key: session.key })
  page.on('domcontentloaded', notifyChanged)
  page.on('load', notifyChanged)
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) notifyChanged()
  })
  page.on('close', () => {
    removePage(session, entry.id)
  })
  page.on('crash', () => {
    removePage(session, entry.id)
  })
}

/** 清空某个标签页的控制台与网络记录（导航时调用）。 */
function clearRings(entry) {
  entry.consoleRing.length = 0
  entry.networkRing.length = 0
  entry.networkByRequest.clear()
}

/** 关闭浏览器等待上限内强制结束进程（隔离模式用）。 */
async function closeBrowser(browser) {
  if (!browser) return
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
  if (result === 'timeout') {
    try {
      browser.process()?.kill()
    } catch {
      // 进程可能已经退出，忽略
    }
  }
}

/** 复用浏览器时的摘要信息。 */
function reuseInfo(session) {
  const active = session.activeTabId === null ? null : session.pages.get(session.activeTabId)
  return {
    reused: true,
    version: session.browser.version(),
    url: active?.page.url() ?? '',
    tabs: session.pages.size,
    summary: `浏览器已启动 系统 Edge ${session.browser.version()}（${session.pages.size} 个标签页）`,
  }
}

/** 启动浏览器（已启动则复用）。 */
export async function launch(key, options = {}, sessionId) {
  const session = sessionOf(key, sessionId)
  if (session.browser) return reuseInfo(session)
  const headless = options.headless ?? true
  const proxy = options.proxy ?? process.env.DSH_BROWSER_PROXY ?? ''
  session.launching = true
  try {
    session.browser = await chromium.launch({
      channel: BROWSER_CHANNEL,
      headless,
      ignoreHTTPSErrors: true,
      ...(proxy ? { proxy: { server: proxy } } : {}),
    })
    session.mode = 'isolated'
    session.viewport = {
      width: options.viewportWidth ?? DEFAULT_VIEWPORT.width,
      height: options.viewportHeight ?? DEFAULT_VIEWPORT.height,
    }
    const page = await session.browser.newPage({ viewport: session.viewport })
    addPage(session, page)
    emitPanelEvent({ type: 'opened', key })
    return {
      reused: false,
      headless,
      channel: BROWSER_CHANNEL,
      version: session.browser.version(),
      viewport: session.viewport,
      tabs: 1,
      artifactsDir: ensureArtifactsDir(session),
      summary: `启动浏览器 系统 Edge ${session.browser.version()}（headless=${headless}，视口 ${session.viewport.width}x${session.viewport.height}）`,
    }
  } finally {
    // 只有启动真正结束才开始计空闲；启动失败也复位，避免卡住回收。
    session.launching = false
    touch(session)
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
    throw new Error('浏览器尚未启动，请先调用 browser_start')
  }
  let tab
  if (options.new_tab === true) {
    tab = addPage(session, await createPage(session))
  } else {
    tab = currentTab(session, options.tab_id)
  }
  session.activeTabId = tab.id
  clearRings(tab)
  tab.refs.clear()
  const response = await tab.page.goto(url, { waitUntil, timeout: 30000 })
  tab.refs.clear()
  emitPanelEvent({ type: 'changed', key })
  const status = response?.status() ?? null
  const finalUrl = tab.page.url()
  return {
    tabId: tab.id,
    newTab: options.new_tab === true,
    url: finalUrl,
    status,
    ok: response?.ok() ?? false,
    title: await tab.page.title(),
    summary: status === null
      ? `导航到 ${finalUrl}（tag ${tab.id}，无响应对象）`
      : `导航到 ${finalUrl}（tag ${tab.id}，HTTP ${status}）`,
  }
}

/** 页面内脚本：收集可交互元素并给出 xpath（注入到页面上下文执行）。 */
function snapshotScript() {
  const selector = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
    '[data-testid]',
  ].join(',')

  /** tag 到 role 的简单映射；有 role 属性时优先用属性。 */
  const roleByTag = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
  }

  function roleFor(el) {
    const explicit = (el.getAttribute('role') || '').trim()
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return ''
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

  return Array.from(document.querySelectorAll(selector))
    .map((e) => {
      const rect = e.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0
      let label = e.getAttribute('aria-label') || e.getAttribute('placeholder') || ''
      if (!label.trim()) {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName)) {
          let linked = ''
          if (e.id) {
            const l = document.querySelector(`label[for="${e.id}"]`)
            if (l) linked = (l.textContent || '').trim()
          }
          if (!linked && e.closest('label')) {
            const cloned = e.closest('label').cloneNode(true)
            cloned.querySelectorAll('input,select,textarea,button').forEach((x) => x.remove())
            linked = (cloned.textContent || '').trim()
          }
          label = linked
        } else {
          label = (e.textContent || '').trim()
        }
      }
      if (!label.trim()) {
        label = e.value || e.getAttribute('name') || e.tagName.toLowerCase()
      }
      return {
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type') || (e.tagName === 'SELECT' ? 'select' : ''),
        label: String(label).slice(0, 80),
        visible,
        disabled: e.disabled === true,
        checked: e.checked === true,
        xpath: xpathFor(e),
        // 视口相对 CSS 像素；四值取整，便于按坐标点击时直接使用。
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        depth: depthFor(e),
        role: roleFor(e),
      }
    })
    .filter((i) => i.visible || i.tag === 'input')
    .map((i, idx) => ({ ...i, ref: `@${idx}` }))
}

/** 快照可交互元素并重建该标签页的 ref 表。 */
export async function snapshot(key, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const tab = currentTab(session, tabId)
  const page = tab.page
  const all = await page.evaluate(snapshotScript)
  const truncated = all.length > SNAPSHOT_LIMIT
  const items = truncated ? all.slice(0, SNAPSHOT_LIMIT) : all
  tab.refs.clear()
  for (const item of items) tab.refs.set(item.ref, item)
  const lines = items.map((i) => {
    const flags = [
      i.disabled ? 'disabled' : '',
      i.checked ? 'checked' : '',
      i.visible ? '' : 'hidden',
    ].filter(Boolean).join(',')
    const typeText = i.type ? `(${i.type})` : ''
    // 按到 body 的层级缩进两格，层级关系一眼可见。
    const indent = '  '.repeat(i.depth)
    return `${indent}[${i.ref.replace('@', '')}] ${i.tag}${typeText} "${i.label}"`
      + `${flags ? ` [${flags}]` : ''} box(${i.box.x},${i.box.y},${i.box.width},${i.box.height})`
  })
  const text = lines.length > 0 ? lines.join('\n') : '（未发现可交互元素）'
  return {
    tabId: tab.id,
    url: page.url(),
    count: items.length,
    total: all.length,
    truncated,
    text: truncated
      ? `${text}\n\n（已截断：共 ${all.length} 个可交互元素，只返回前 ${SNAPSHOT_LIMIT} 个）`
      : text,
    summary: `快照 ${items.length} 个可交互元素${truncated ? `（共 ${all.length} 个，已截断到 ${SNAPSHOT_LIMIT} 个）` : ''}`,
  }
}

function requireRef(tab, ref) {
  const item = tab.refs.get(ref)
  if (!item) {
    throw new Error(`ref ${ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref`)
  }
  return item
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
    if (!check.found) {
      throw new Error(`ref ${ref} 已失效，请重新 browser_e2e_snapshot`)
    }
    if (!(check.width > 0 && check.height > 0)) {
      throw new Error(`ref ${ref} 已失效（当前尺寸 ${Math.round(check.width)}x${Math.round(check.height)}，不可见），请重新 browser_e2e_snapshot`)
    }
    const locator = page.locator(`xpath=${item.xpath}`)
    await locator.scrollIntoViewIfNeeded()
    await locator.click({ timeout: 10000 })
    return { mode: 'ref', ref, tag: item.tag, label: item.label, summary: `点击 ${ref} (${item.tag} "${item.label}")` }
  }

  if (selector) {
    const locator = page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    await locator.click({ timeout: 10000 })
    return { mode: 'selector', selector, summary: `点击 selector "${selector}"` }
  }

  const x = Number(options.x)
  const y = Number(options.y)
  if (x < 0 || y < 0) {
    throw new Error(`坐标不能为负数，收到 x=${x}, y=${y}`)
  }
  await page.mouse.click(x, y)
  return { mode: 'point', x, y, summary: `点击坐标 (${x}, ${y})` }
}

/** 按 ref 填入文本。 */
export async function fill(key, ref, value, sessionId, tabId) {
  const session = sessionOf(key, sessionId)
  const tab = currentTab(session, tabId)
  const page = tab.page
  const item = requireRef(tab, ref)
  const locator = page.locator(`xpath=${item.xpath}`)
  await locator.scrollIntoViewIfNeeded()
  await locator.fill(value, { timeout: 10000 })
  return {
    ref,
    tag: item.tag,
    label: item.label,
    value,
    summary: `填写 ${ref} (${item.tag} "${item.label}") <- "${value}"`,
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
    const size = await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    }))
    return size
  }
  if (!viewport) {
    throw new Error('当前页面没有可用视口尺寸，无法校验截图输出')
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
  if (scale !== undefined && !SHOT_SCALES.has(scale)) {
    throw new Error(`scale 只支持 "css" 或 "device"，收到 "${scale}"`)
  }
  const clip = options.clip
  if (clip !== undefined) assertClip(clip)
  const fullPage = options.fullPage ?? false
  if (clip !== undefined && fullPage) {
    throw new Error('clip 与 fullPage 不能同时使用')
  }

  const viewport = page.viewportSize()
  if (clip && viewport) {
    if (clip.x + clip.width > viewport.width) {
      throw new Error(`clip 超出视口宽度：x + width = ${clip.x + clip.width} > 视口宽度 ${viewport.width}`)
    }
    if (clip.y + clip.height > viewport.height) {
      throw new Error(`clip 超出视口高度：y + height = ${clip.y + clip.height} > 视口高度 ${viewport.height}`)
    }
  }

  const base = await shotBaseSize(page, { clip, fullPage, viewport })
  // Playwright 的 scale 默认 device；这里按实际生效的缩放换算输出像素。
  const useDeviceScale = scale !== 'css'
  const factor = useDeviceScale ? await page.evaluate(() => window.devicePixelRatio || 1) : 1
  const outWidth = Math.round(base.width * factor)
  const outHeight = Math.round(base.height * factor)
  if (outWidth > MAX_SHOT_EDGE || outHeight > MAX_SHOT_EDGE) {
    throw new Error(`截图输出 ${outWidth}x${outHeight} 超出单边上限 ${MAX_SHOT_EDGE}`)
  }
  if (outWidth * outHeight > MAX_SHOT_PIXELS) {
    throw new Error(`截图输出 ${outWidth}x${outHeight} 共 ${outWidth * outHeight} 像素，超出上限 ${MAX_SHOT_PIXELS}`)
  }

  // Playwright 的截图格式参数名是 type（png / jpeg），不是 format。
  const shotOptions = { fullPage, type: format }
  if (clip) shotOptions.clip = clip
  if (quality !== undefined) shotOptions.quality = quality
  if (scale !== undefined) shotOptions.scale = scale

  const buffer = await page.screenshot(shotOptions)
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

/** 没起过浏览器时报错，供只读类工具复用。 */
function requireSession(key) {
  const session = sessions.get(key)
  if (!session || session.pages.size === 0) {
    throw new Error('浏览器尚未启动，请先调用 browser_start')
  }
  return session
}

/** 读取控制台记录尾部若干条（默认 100），最新在最后。 */
export async function consoleEntries(key, limit = 100, tabId) {
  const session = requireSession(key)
  touch(session)
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
  touch(session)
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
 * 关闭并清理该 agent 的浏览器。
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
  await closeBrowser(session.browser)
  emitPanelEvent({ type: 'closed', key })
  return { closed: true, summary: '浏览器已关闭' }
}

/**
 * 关闭指定标签页；最后一个标签页不允许关闭。
 * @param {string} key - 会话 key
 * @param {string} tabId - 标签页 id
 * @returns {Promise<object>} 关闭结果
 */
export async function closeTab(key, tabId) {
  const session = sessions.get(key)
  if (!session || session.pages.size === 0) {
    throw new Error('浏览器尚未启动，请先调用 browser_start')
  }
  if (typeof tabId !== 'string' || tabId.length === 0) {
    throw new Error('缺少 tab_id，请先 browser_e2e_tabs 获取')
  }
  const tab = session.pages.get(tabId)
  if (!tab) {
    throw new Error(`tab ${tabId} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`)
  }
  if (session.pages.size <= 1) {
    throw new Error('这是最后一个标签页，不能关闭；如需结束整个浏览器请用 browser_e2e_close')
  }
  await tab.page.close().catch(() => {})
  removePage(session, tabId)
  return {
    tabId,
    remaining: session.pages.size,
    activeTabId: session.activeTabId,
    summary: `关闭标签页 ${tabId}（剩余 ${session.pages.size} 个，当前 ${session.activeTabId ?? '无'}）`,
  }
}

/** 取页面标题；取不到或超时返回空串，用于 tab 列表。 */
async function titleOf(page) {
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

/**
 * 列出本会话的标签页（工具 browser_e2e_tabs 用）。
 * @param {string} key - 会话 key
 * @returns {Promise<object>} 标签页列表
 */
export async function tabs(key) {
  const session = requireSession(key)
  touch(session)
  const list = []
  for (const tab of session.pages.values()) {
    list.push({
      tab_id: tab.id,
      url: tab.page.url(),
      title: await titleOf(tab.page),
      active: tab.id === session.activeTabId,
    })
  }
  const lines = list.map((tab) => `${tab.active ? '*' : ' '} ${tab.tab_id}  ${tab.title || '(无标题)'}  ${tab.url}`)
  return {
    mode: session.mode,
    tabs: list,
    activeTabId: session.activeTabId,
    text: lines.join('\n'),
    summary: `共 ${list.length} 个标签页，当前 ${session.activeTabId ?? '无'}`,
  }
}

/**
 * 按 session.id 回收浏览器，供 `session/disposed` 钩子调用。
 *
 * 需要它是因为工具层用的是 `exec.agent.id`，而 dispose 事件只给 Session；
 * 两者同源，共用同一个 SessionId（`Agent.id` 的类型就是 `SessionId`）。
 *
 * @param sessionId - 被销毁会话的 id。
 * @returns 关掉了返回 true；该会话没起过浏览器返回 false。
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

/** 面板 tab id：会话 key 与页面 tab_id 的组合，避免不同会话的同号 tab 撞车。 */
export function panelTabId(key, tabId) {
  return `${key}#${tabId}`
}

/** 拆开面板 tab id；格式不对返回 null。 */
function parsePanelTabId(panelId) {
  if (typeof panelId !== 'string') return null
  const at = panelId.lastIndexOf('#')
  if (at <= 0 || at === panelId.length - 1) return null
  return { key: panelId.slice(0, at), tabId: panelId.slice(at + 1) }
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
 * 标题取不到时返回空串，不影响状态推送。
 * @returns {Promise<Array<{id: string, sessionId: string, url: string, title: string, loading: boolean}>>}
 */
export async function listPanelTabs() {
  const list = []
  for (const [key, session] of sessions) {
    for (const tab of session.pages.values()) {
      list.push({
        id: panelTabId(key, tab.id),
        sessionId: session.sessionId ?? key,
        url: tab.page.url(),
        title: await titleOf(tab.page),
        loading: false,
      })
    }
  }
  return list
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
