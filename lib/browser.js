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
    session = { key, browser: null, page: null, refs: new Map(), artifactsDir: null, idleTimer: null, launching: false }
    sessions.set(key, session)
  }
  // key 就是 agent.id，本身就是 SessionId；显式传入时以传入值为准。
  keyBySessionId.set(sessionId ?? key, key)
  touch(session)
  return session
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

/** 导航并清空 ref 表。 */
export async function navigate(key, url, waitUntil = 'load', sessionId) {
  const session = sessionOf(key, sessionId)
  const page = requirePage(session)
  const response = await page.goto(url, { waitUntil, timeout: 30000 })
  session.refs.clear()
  return {
    url: page.url(),
    status: response?.status() ?? null,
    ok: response?.ok() ?? false,
    title: await page.title(),
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
  return { value }
}

/** 关闭并清理该 agent 的浏览器。 */
export async function close(key) {
  const session = sessions.get(key)
  if (!session) return { closed: false }
  clearIdleTimer(session)
  try {
    await session.browser?.close()
  } catch {
    // 浏览器可能已自行退出，忽略
  }
  sessions.delete(key)
  for (const [sessionId, mapped] of keyBySessionId) {
    if (mapped === key) keyBySessionId.delete(sessionId)
  }
  return { closed: true }
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
