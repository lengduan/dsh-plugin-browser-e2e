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
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

/** 与系统 Edge 对应的 Playwright channel。 */
const BROWSER_CHANNEL = 'msedge'

/** agent -> { browser, page, refs } */
const sessions = new Map()

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

function sessionOf(key, sessionId) {
  let session = sessions.get(key)
  if (!session) {
    session = {
      key,
      browser: null,
      page: null,
      refs: new Map(),
      artifactsDir: null,
      idleTimer: null,
      launching: false,
      // 控制台与网络记录：每个会话独立、进程内环形缓冲；导航时清空。
      consoleRing: [],
      networkRing: [],
      networkByRequest: new Map(),
      hookedPages: new WeakSet(),
    }
    sessions.set(key, session)
  }
  // key 就是 agent.id，本身就是 SessionId；显式传入时以传入值为准。
  keyBySessionId.set(sessionId ?? key, key)
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
 * 给页面挂上控制台与网络监听。每个 page 只挂一次。
 *
 * 网络记录用「request 事件建占位、response / requestfailed 原地改字段」的做法：
 * Map 里存的就是 ring 中的同一个对象引用，后续事件直接改写该对象，不再二次查表。
 */
function attachPageHooks(session, page) {
  if (session.hookedPages.has(page)) return
  session.hookedPages.add(page)

  page.on('console', (msg) => {
    // Playwright 的 msg.text() 即其对 args 的序列化结果。
    pushRing(session.consoleRing, {
      level: msg.type(),
      text: truncateText(msg.text()),
      at: nowAt(),
    })
  })

  page.on('pageerror', (error) => {
    pushRing(session.consoleRing, {
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
    session.networkByRequest.set(request, record)
    pushRing(session.networkRing, record)
  })

  page.on('response', (response) => {
    const record = session.networkByRequest.get(response.request())
    if (!record) return
    record.status = response.status()
    record.mimeType = response.headers()['content-type'] ?? ''
  })

  page.on('requestfailed', (request) => {
    const record = session.networkByRequest.get(request)
    if (!record) return
    record.failure = request.failure()?.errorText ?? 'request failed'
  })
}

/** 清空某个会话的控制台与网络记录（导航时调用）。 */
function clearRings(session) {
  session.consoleRing.length = 0
  session.networkRing.length = 0
  session.networkByRequest.clear()
}

function requirePage(session) {
  if (!session.page) {
    throw new Error('浏览器尚未启动，请先调用 browser_start')
  }
  return session.page
}

/** 启动浏览器（已启动则复用）。 */
export async function launch(key, options = {}, sessionId) {
  const session = sessionOf(key, sessionId)
  if (session.browser) {
    return { reused: true, version: session.browser.version(), url: session.page?.url() ?? '' }
  }
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
    const viewport = {
      width: options.viewportWidth ?? DEFAULT_VIEWPORT.width,
      height: options.viewportHeight ?? DEFAULT_VIEWPORT.height,
    }
    session.page = await session.browser.newPage({ viewport })
    session.refs.clear()
    clearRings(session)
    attachPageHooks(session, session.page)
    return {
      reused: false,
      headless,
      channel: BROWSER_CHANNEL,
      version: session.browser.version(),
      viewport,
      artifactsDir: ensureArtifactsDir(session),
    }
  } finally {
    // 只有启动真正结束才开始计空闲；启动失败也复位，避免卡住回收。
    session.launching = false
    touch(session)
  }
}

/** 导航并清空 ref 表；同时清空控制台 / 网络记录，让后续读取只反映新页面。 */
export async function navigate(key, url, waitUntil = 'load', sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  clearRings(session)
  const response = await page.goto(url, { waitUntil, timeout: 30000 })
  session.refs.clear()
  const status = response?.status() ?? null
  return {
    url: page.url(),
    status,
    ok: response?.ok() ?? false,
    title: await page.title(),
    summary: status === null ? `导航到 ${page.url()}（无响应对象）` : `导航到 ${page.url()} (HTTP ${status})`,
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
      }
    })
    .filter((i) => i.visible || i.tag === 'input')
    .map((i, idx) => ({ ...i, ref: `@${idx}` }))
}

/** 快照可交互元素并重建 ref 表。 */
export async function snapshot(key, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  const items = await page.evaluate(snapshotScript)
  session.refs.clear()
  for (const item of items) session.refs.set(item.ref, item)
  const lines = items.map((i) => {
    const flags = [
      i.disabled ? 'disabled' : '',
      i.checked ? 'checked' : '',
      i.visible ? '' : 'hidden',
    ].filter(Boolean).join(',')
    const typeText = i.type ? `(${i.type})` : ''
    return `[${i.ref.replace('@', '')}] ${i.tag}${typeText} "${i.label}"${flags ? ` [${flags}]` : ''}`
  })
  return {
    url: page.url(),
    count: items.length,
    text: lines.length > 0 ? lines.join('\n') : '（未发现可交互元素）',
  }
}

function requireRef(session, ref) {
  const item = session.refs.get(ref)
  if (!item) {
    throw new Error(`ref ${ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref`)
  }
  return item
}

/** 按 ref 点击。 */
export async function click(key, ref, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  const item = requireRef(session, ref)
  const locator = page.locator(`xpath=${item.xpath}`)
  await locator.scrollIntoViewIfNeeded()
  await locator.click({ timeout: 10000 })
  return { ref, tag: item.tag, label: item.label }
}

/** 按 ref 填入文本。 */
export async function fill(key, ref, value, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  const item = requireRef(session, ref)
  const locator = page.locator(`xpath=${item.xpath}`)
  await locator.scrollIntoViewIfNeeded()
  await locator.fill(value, { timeout: 10000 })
  return { ref, tag: item.tag, label: item.label, value }
}

/** 键盘按键，如 Enter / Tab / Control+A。 */
export async function press(key, keyName, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  await page.keyboard.press(keyName)
  return { key: keyName }
}

/** 截图落盘，返回绝对路径。 */
export async function screenshot(key, name, fullPage = false, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  const dir = ensureArtifactsDir(session)
  const file = join(dir, `${name ?? `shot-${Date.now()}`}.png`)
  await page.screenshot({ path: file, fullPage })
  return { file, fullPage }
}

/** 在页面上下文执行 JavaScript 表达式并返回结果。 */
export async function evaluate(key, expression, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  const value = await page.evaluate(expression)
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  return { value, summary: `求值 JS 表达式（返回 ${type}）` }
}

/** 没起过浏览器时报错，供只读类工具复用。 */
function requireSession(key) {
  const session = sessions.get(key)
  if (!session?.page) {
    throw new Error('浏览器尚未启动，请先调用 browser_start')
  }
  return session
}

/** 读取控制台记录尾部若干条（默认 100），最新在最后。 */
export async function consoleEntries(key, limit = 100) {
  const session = requireSession(key)
  touch(session)
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RING_LIMIT) : 100
  const entries = session.consoleRing.slice(-take)
  const lines = entries.map((entry) => `${timeOf(entry.at)} ${entry.level} ${oneLine(entry.text)}`)
  return {
    total: session.consoleRing.length,
    count: entries.length,
    entries,
    text: lines.length > 0 ? lines.join('\n') : '（暂无控制台记录）',
    summary: `控制台记录 ${entries.length} 条`,
  }
}

/** 读取网络请求记录尾部若干条（默认 100），最新在最后。 */
export async function networkEntries(key, limit = 100) {
  const session = requireSession(key)
  touch(session)
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RING_LIMIT) : 100
  const entries = session.networkRing.slice(-take)
  const lines = entries.map((entry) => {
    const status = entry.status > 0 ? String(entry.status) : '0(无响应)'
    const parts = [`${timeOf(entry.at)}`, entry.method, status, entry.mimeType || '-', entry.url]
    if (entry.failure) parts.push(`失败: ${entry.failure}`)
    return parts.join(' ')
  })
  return {
    total: session.networkRing.length,
    count: entries.length,
    entries,
    text: lines.length > 0 ? lines.join('\n') : '（暂无网络记录）',
    summary: `网络请求 ${entries.length} 条`,
  }
}

/** 等待 selector 或 expression 满足条件，返回实际耗时。 */
export async function waitFor(key, options = {}, sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
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

/** 关闭并清理该 agent 的浏览器。 */
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
  return { closed: true, summary: '浏览器已关闭' }
}

/** 带超时兜底的浏览器关闭：超时就强制结束进程，避免永久挂起。 */
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
