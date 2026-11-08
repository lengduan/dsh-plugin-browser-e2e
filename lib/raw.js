/**
 * 原始 HTTP 逃生口（仅 `mode=context`）：用当前标签页所属浏览器上下文的请求客户端
 * 发任意方法 / 头 / 正文，返回状态、响应头与正文。
 *
 * 不 import 会话层：会话对象由 tools.js 的 run 传入；标签页与正文视图的纯函数复用
 * page.js（currentTab / settleWithin / SENSITIVE_HEADERS / REDACTED_HEADER_VALUE /
 * isTextMime / decodeText），不另造一套。原始 CDP 与 `mode=server` 未实现（0003 #9）。
 */
import { createHash } from 'node:crypto'

import {
  currentTab, decodeText, isTextMime, REDACTED_HEADER_VALUE, SENSITIVE_HEADERS, settleWithin,
} from './page.js'

/** 允许的 HTTP 方法：拒绝 CONNECT / TRACE 与任意扩展方法。 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** 请求超时缺省值（毫秒）。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 30000

/** 请求超时下限（毫秒）。 */
export const MIN_HTTP_TIMEOUT_MS = 1000

/** 请求超时上限（毫秒）。 */
export const MAX_HTTP_TIMEOUT_MS = 120000

/** 请求头最多项数。 */
export const HTTP_MAX_HEADERS = 50

/** 单个请求头值的字符上限。 */
export const HTTP_MAX_HEADER_CHARS = 8192

/** 请求体的字符上限。 */
export const HTTP_MAX_BODY_CHARS = 262144

/** 返回正文的字符上限（只约束文本，不约束下载体积）。 */
export const HTTP_RESULT_MAX_CHARS = 65536

/** 最多跟随的重定向次数（与 Playwright 默认值一致）。 */
export const HTTP_MAX_REDIRECTS = 20

/** 单次调用里等待 response.dispose() 的上限（毫秒），避免释放挂住工具返回。 */
const DISPOSE_TIMEOUT_MS = 1000

/** 十六进制 SHA-256。 */
function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Playwright 请求超时判定（与 download.js 同口径）。 */
function isTimeoutError(error) {
  return Boolean(error) && (error.name === 'TimeoutError' || /timeout .*exceeded/i.test(error.message || ''))
}

/** 校验并按固定顺序解析入参；任一失败直接抛单次入参错误。 */
function validateHttpOptions(options) {
  const opts = options && typeof options === 'object' ? options : {}

  let url
  try {
    url = new URL(String(opts.url ?? ''))
  } catch {
    url = null
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`url 必须是 http / https 的绝对地址，收到 ${JSON.stringify(opts.url)}`)
  }

  const method = opts.method ?? 'GET'
  if (typeof method !== 'string' || !HTTP_METHODS.includes(method)) {
    throw new Error(`method 只支持 ${HTTP_METHODS.join(' / ')}，收到 ${JSON.stringify(opts.method)}`)
  }

  let headers = {}
  if (opts.headers !== undefined) {
    if (opts.headers === null || typeof opts.headers !== 'object' || Array.isArray(opts.headers)) {
      throw new Error(`headers 必须是字符串键值对对象，收到 ${JSON.stringify(opts.headers)}`)
    }
    const entries = Object.entries(opts.headers)
    if (entries.length > HTTP_MAX_HEADERS) {
      throw new Error(`headers 超过上限（${HTTP_MAX_HEADERS} 项 / 单项 ${HTTP_MAX_HEADER_CHARS} 字符），当前 ${entries.length} 项`)
    }
    for (const [key, value] of entries) {
      if (typeof value !== 'string') {
        throw new Error(`headers 必须是字符串键值对对象，收到 ${JSON.stringify(opts.headers)}`)
      }
      if (value.length > HTTP_MAX_HEADER_CHARS || key.length === 0) {
        throw new Error(`headers 超过上限（${HTTP_MAX_HEADERS} 项 / 单项 ${HTTP_MAX_HEADER_CHARS} 字符），当前 ${entries.length} 项`)
      }
      headers[key] = value
    }
  }

  let body
  if (opts.body !== undefined) {
    if (typeof opts.body !== 'string') {
      throw new Error(`body 必须是字符串，收到 ${JSON.stringify(opts.body)}`)
    }
    if (method === 'GET' || method === 'HEAD') {
      throw new Error('GET / HEAD 请求不能带 body')
    }
    if (opts.body.length > HTTP_MAX_BODY_CHARS) {
      throw new Error(`body 超过上限 ${HTTP_MAX_BODY_CHARS} 字符，当前 ${opts.body.length}`)
    }
    body = opts.body
  }

  // 本切片只支持浏览器上下文出口；服务端直连模式未实现（0003 #9）。
  const mode = opts.mode ?? 'context'
  if (mode !== 'context') {
    throw new Error(`mode 只支持 context，收到 ${JSON.stringify(opts.mode)}`)
  }

  let timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  if (opts.timeoutMs !== undefined) {
    if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < MIN_HTTP_TIMEOUT_MS || opts.timeoutMs > MAX_HTTP_TIMEOUT_MS) {
      throw new Error(`timeout_ms 必须是 ${MIN_HTTP_TIMEOUT_MS}..${MAX_HTTP_TIMEOUT_MS} 的整数，收到 ${JSON.stringify(opts.timeoutMs)}`)
    }
    timeoutMs = opts.timeoutMs
  }

  let maxChars = HTTP_RESULT_MAX_CHARS
  if (opts.maxChars !== undefined) {
    if (!Number.isInteger(opts.maxChars) || opts.maxChars < 1 || opts.maxChars > HTTP_RESULT_MAX_CHARS) {
      throw new Error(`max_chars 必须是 1..${HTTP_RESULT_MAX_CHARS} 的整数，收到 ${JSON.stringify(opts.maxChars)}`)
    }
    maxChars = opts.maxChars
  }

  return { url: url.toString(), method, headers, body, mode, timeoutMs, maxChars }
}

/** 二进制判定：mime 不是文本类时按二进制；mime 缺失且没有 NUL 字节时按文本尝试解码。 */
function isBinaryBody(buffer, mimeType) {
  if (isTextMime(mimeType)) return false
  return String(mimeType ?? '').trim().length > 0 || buffer.includes(0)
}

/**
 * 正文视图：文本类给 text / chars / truncated，二进制只给 bytes / sha256（不返回 base64）。
 * 空正文单独标记，避免把 0 字节当成解码失败。
 */
function bodyViewOf(buffer, mimeType, maxChars) {
  const bytes = buffer.length
  const sha256 = sha256Of(buffer)
  if (bytes === 0) {
    return { kind: 'empty', mimeType, bytes: 0, chars: 0, truncated: false, sha256, text: '' }
  }
  if (isBinaryBody(buffer, mimeType)) return { kind: 'binary', mimeType, bytes, sha256 }
  const decoded = decodeText(buffer, mimeType)
  const chars = decoded.length
  const truncated = chars > maxChars
  return {
    kind: 'text',
    mimeType,
    bytes,
    chars,
    truncated,
    sha256,
    text: truncated ? decoded.slice(0, maxChars) : decoded,
  }
}

/** 响应头对象：敏感头替换为隐藏占位（与 browser_e2e_network_detail 同口径）。 */
function redactHeaders(rawHeaders) {
  const redacted = {}
  for (const [key, value] of Object.entries(rawHeaders ?? {})) {
    redacted[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED_HEADER_VALUE : value
  }
  return redacted
}

/**
 * 是否发生过重定向。
 *
 * Playwright 1.63 的 APIResponse 没有 request() / redirectedFrom()，取不到逐跳请求链，
 * 因此这里只能给出 0（未重定向）/ 1（重定向过），不是逐跳计数；跟随上限仍由
 * fetch 的 maxRedirects=20 保证（超出由 Playwright 报错，按请求失败返回）。
 */
function redirectCountOf(response, requestedUrl) {
  return response.url() !== requestedUrl ? 1 : 0
}

/** 把请求异常转成规格里的固定文案。 */
function requestError(error, params) {
  if (isTimeoutError(error)) {
    return new Error(`HTTP 请求超时：${params.url} 在 ${params.timeoutMs}ms 内未完成；可调大 timeout_ms（上限 ${MAX_HTTP_TIMEOUT_MS}）`)
  }
  return new Error(`HTTP 请求失败：${params.url} → ${error?.message ?? error}`)
}

/**
 * 用当前标签页的浏览器上下文发一次 HTTP 请求（mode=context）。
 * @param {object} session - 会话状态
 * @param {object} options - url / method / headers / body / mode / timeoutMs / maxChars
 * @param {string} [tabId] - 目标标签页；缺省用 active tab
 * @returns {Promise<object>} mode / url / finalUrl / status / ok / headers / body / redirect / elapsedMs / summary
 */
export async function rawHttp(session, options = {}, tabId) {
  const params = validateHttpOptions(options)
  const tab = currentTab(session, tabId)
  const started = Date.now()

  let response
  try {
    response = await tab.page.context().request.fetch(params.url, {
      method: params.method,
      headers: params.headers,
      data: params.body,
      timeout: params.timeoutMs,
      maxRedirects: HTTP_MAX_REDIRECTS,
      failOnStatusCode: false,
    })
  } catch (error) {
    throw requestError(error, params)
  }

  try {
    let buffer
    try {
      buffer = await response.body()
    } catch (error) {
      throw requestError(error, params)
    }
    const headers = redactHeaders(response.headers())
    const body = bodyViewOf(buffer, headers['content-type'] ?? '', params.maxChars)
    const status = response.status()
    const finalUrl = response.url()
    const elapsedMs = Date.now() - started
    const sizeText = body.kind === 'binary' ? `${body.bytes} 字节` : `${body.chars} 字符`
    return {
      mode: params.mode,
      url: params.url,
      finalUrl,
      status,
      ok: status >= 200 && status < 300,
      headers,
      body,
      redirect: { finalUrl, count: redirectCountOf(response, params.url) },
      elapsedMs,
      summary: `HTTP ${params.method} ${new URL(params.url).host}${new URL(params.url).pathname}`
        + ` → ${status} ${body.mimeType || '-'}（${sizeText}，${elapsedMs}ms，浏览器上下文）`,
    }
  } finally {
    // Playwright 要求显式释放正文缓冲；释放失败不影响本次结果，也不阻塞返回。
    await settleWithin(Promise.resolve().then(() => response.dispose()), DISPOSE_TIMEOUT_MS)
  }
}
