/**
 * 浏览器内抓取：在当前标签页所属浏览器上下文里开一个临时页，取渲染后的整页正文。
 *
 * 与导航 + 读取的组合不同，抓取不动当前页：不改 activeTabId、不写 ref 表与快照基线、
 * 不产生事件环记录；临时页用完即关，也不登记为标签页（见 page.js 的 createTransientPage）。
 *
 * 不 import 会话层：会话对象由 tools.js 的 run 传入；标签页解析与临时页复用 page.js，
 * 正文预算复用 read.js 的 READ_TEXT_LIMIT，不另写一份。
 */
import { createTransientPage, currentTab } from './page.js'
import { READ_TEXT_LIMIT } from './read.js'

/** domcontentloaded 之后等待页面稳定的缺省毫秒数（与竞品同口径）。 */
export const FETCH_DEFAULT_SETTLE_MS = 400

/** settleMs 的取值上限。 */
export const FETCH_MAX_SETTLE_MS = 5000

/** 导航超时的缺省毫秒数，只约束 goto。 */
export const FETCH_DEFAULT_TIMEOUT_MS = 25000

/** 导航超时下限（毫秒）。 */
export const FETCH_TIMEOUT_MIN_MS = 1000

/** 导航超时上限（毫秒）。 */
export const FETCH_TIMEOUT_MAX_MS = 60000

/** 正文的字符上限；上限值，调用方默认用 READ_TEXT_LIMIT。 */
export const FETCH_MAX_TEXT_CHARS = 180000

/** Playwright 超时判定（与 raw.js / download.js 同口径）。 */
function isTimeoutError(error) {
  return Boolean(error) && (error.name === 'TimeoutError' || /timeout .*exceeded/i.test(error.message || ''))
}

/** 取错误的可读文案。 */
function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

/**
 * 校验并归一入参；任一失败直接抛单次入参错误。
 * @param {object} options - 工具入参
 * @returns {{url: string, settleMs: number, timeoutMs: number, maxChars: number}} 归一后的参数
 */
function validateFetchOptions(options) {
  const opts = options && typeof options === 'object' ? options : {}

  const rawUrl = opts.url
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new Error(`url 必须是 http / https 的绝对地址，收到 ${JSON.stringify(rawUrl)}`)
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`url 必须是 http / https 的绝对地址，收到 ${JSON.stringify(rawUrl)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url 只支持 http / https，收到 ${url.protocol}；如需下载文件请用 browser_e2e_download`)
  }

  const settleMs = opts.settleMs === undefined ? FETCH_DEFAULT_SETTLE_MS : opts.settleMs
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > FETCH_MAX_SETTLE_MS) {
    throw new Error(`settleMs 必须是 0..${FETCH_MAX_SETTLE_MS} 的整数，收到 ${JSON.stringify(opts.settleMs)}`)
  }

  const timeoutMs = opts.timeoutMs === undefined ? FETCH_DEFAULT_TIMEOUT_MS : opts.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < FETCH_TIMEOUT_MIN_MS || timeoutMs > FETCH_TIMEOUT_MAX_MS) {
    throw new Error(`timeoutMs 必须是 ${FETCH_TIMEOUT_MIN_MS}..${FETCH_TIMEOUT_MAX_MS} 的整数，收到 ${JSON.stringify(opts.timeoutMs)}`)
  }

  const maxChars = opts.maxChars === undefined ? READ_TEXT_LIMIT : opts.maxChars
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > FETCH_MAX_TEXT_CHARS) {
    throw new Error(`maxChars 必须是 1..${FETCH_MAX_TEXT_CHARS} 的整数，收到 ${JSON.stringify(opts.maxChars)}`)
  }

  return { url: rawUrl, settleMs, timeoutMs, maxChars }
}

/**
 * 页内提取脚本：语义容器优先，缺省 body；标题取 document.title。
 * 注入到页面上下文执行，不引用外部变量。innerText 只含渲染后的可见文本，
 * 隐藏节点与 script / style 天然剔除，不进入 iframe 与 shadow root（与结构化读取同口径）。
 * @returns {{title: string, text: string}} 标题与正文
 */
function fetchScript() {
  const root = document.querySelector('article, main, [role="main"]') || document.body
  return {
    title: document.title || '',
    text: root ? (root.innerText || '') : '',
  }
}

/** 摘要里的地址部分：取 host + pathname，异常地址退回原串。 */
function summaryTarget(finalUrl) {
  try {
    const url = new URL(finalUrl)
    return `${url.host}${url.pathname}`
  } catch {
    return finalUrl
  }
}

/**
 * 抓取一页正文。
 *
 * 链路：入参校验 → currentTab 解析目标页 → 在它的 context 里建临时页 → goto(domcontentloaded)
 * → 等 settleMs → 页内提取 → 按 maxChars 截断 → finally 关页。非 2xx 与空正文都是结果不是错误。
 * @param {object} session - 会话状态
 * @param {{url: string, settleMs?: number, timeoutMs?: number, maxChars?: number}} options - 抓取参数
 * @param {string} [tabId] - 标签页 id；决定用哪个浏览器上下文（缺省 active tab）
 * @returns {Promise<object>} tabId / url / statusCode / title / text / truncated / empty / elapsedMs / mode / summary
 */
export async function fetchText(session, options = {}, tabId) {
  const input = validateFetchOptions(options)
  const tab = currentTab(session, tabId)
  const started = Date.now()

  let page
  try {
    page = await createTransientPage(session, tab.id)
  } catch (error) {
    throw new Error(`无法创建抓取用临时页：${messageOf(error)}；请先 browser_e2e_tabs 确认当前标签页仍可用`)
  }

  try {
    let response
    try {
      response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs })
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(`获取超时：${input.timeoutMs}ms 内未完成（${input.url}）；可调大 timeoutMs（上限 ${FETCH_TIMEOUT_MAX_MS}）`)
      }
      throw new Error(`获取失败：${messageOf(error)}（${input.url}）`)
    }

    if (input.settleMs > 0) await page.waitForTimeout(input.settleMs)

    let data
    try {
      data = await page.evaluate(fetchScript)
    } catch (error) {
      throw new Error(`获取失败：${messageOf(error)}（${input.url}）`)
    }

    const fullText = typeof data?.text === 'string' ? data.text : ''
    const title = typeof data?.title === 'string' ? data.title : ''
    const truncated = fullText.length > input.maxChars
    const text = truncated ? fullText.slice(0, input.maxChars) : fullText
    const statusCode = response?.status() ?? 0
    const finalUrl = page.url()
    const elapsedMs = Date.now() - started
    const summary = `获取 ${summaryTarget(finalUrl)}（HTTP ${statusCode}，正文 ${text.length} 字符${truncated ? '，已截断' : ''}）`

    return {
      tabId: tab.id,
      url: finalUrl,
      statusCode,
      title,
      text,
      truncated,
      empty: text.length === 0,
      elapsedMs,
      mode: session.mode,
      summary,
    }
  } finally {
    await page.close().catch(() => {})
  }
}
