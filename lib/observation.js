/**
 * 观察层：事件环的只读视图与网络正文——console / network 读取、level 过滤视图、
 * 对话框策略与记录读取、网络详情与正文解码、敏感头脱敏。
 *
 * 明确不含：标签页生命周期、事件环写入、快照、交互动作、协议、面板、落盘。
 * consoleRing / networkRing / networkContext / dialogRing / dialogPolicy / dialogPromptText
 * 由 page.js 的 addPage / attachPageHooks 创建并写入，本模块只读写既有字段，不新增跨模块字段；
 * 级别归一、展示格式化与环常量从 page.js 单向借用。
 */
import { createHash } from 'node:crypto'

import {
  consoleLevelRank, currentTab, DEFAULT_DIALOG_POLICY, DEFAULT_RING_QUERY_LIMIT, DIALOG_LIMIT_DEFAULT,
  DIALOG_PROMPT_TEXT_LIMIT, DIALOG_RING_LIMIT, DIALOG_TEXT_LIMIT, normalizeConsoleLevel, oneLine, RING_LIMIT, timeOf,
} from './page.js'

/** 网络详情：文本正文与请求体最多返回的字符数（字符，不是字节）。 */
export const NETWORK_BODY_TEXT_LIMIT = 64 * 1024

/** 网络详情：读取正文的缺省超时（毫秒）。 */
export const NETWORK_BODY_TIMEOUT_MS = 5000

/** 网络详情：timeout_ms 的下限（毫秒）。 */
export const NETWORK_BODY_TIMEOUT_MIN_MS = 100

/** 网络详情：timeout_ms 的上限（毫秒）。 */
export const NETWORK_BODY_TIMEOUT_MAX_MS = 30000

/**
 * 读取控制台记录尾部若干条（默认 100），最新在最后。
 * @param {object} session - 会话状态
 * @param {number} [limit] - 最多返回多少条，缺省 100
 * @param {string} [tabId] - 目标标签页；缺省用 active tab
 * @param {{level?: string}} [options] - `level` 为最小严重级别；不传表示不过滤
 * @returns {Promise<{tabId: string, total: number, matched: number, count: number, level: string|null, entries: object[], text: string, summary: string}>}
 */
export async function consoleEntries(session, limit = DEFAULT_RING_QUERY_LIMIT, tabId, options = {}) {
  session.touch()
  const tab = currentTab(session, tabId)
  const ring = tab.consoleRing
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RING_LIMIT) : DEFAULT_RING_QUERY_LIMIT
  const rawLevel = options?.level
  const level = rawLevel === undefined || rawLevel === null || rawLevel === ''
    ? null
    : normalizeConsoleLevel(rawLevel)
  // 先过滤再截尾：matched 是命中总数，count 是本次返回条数，可以小于 matched。
  const threshold = level === null ? -1 : consoleLevelRank(level)
  const matchedEntries = level === null
    ? ring
    : ring.filter((entry) => {
      const rank = consoleLevelRank(entry.level)
      // 不可判级的类型（rank 为 -1）恒保留：断言、表格转储常是排障线索，不静默丢弃。
      return rank < 0 || rank >= threshold
    })
  const entries = matchedEntries.slice(-take)
  const matched = matchedEntries.length
  const lines = entries.map((entry) => `${timeOf(entry.at)} ${entry.level} ${oneLine(entry.text)}`)
  const emptyText = level !== null && ring.length > 0 && matched === 0
    ? `（缓冲 ${ring.length} 条记录，没有 level ≥ ${level} 的条目）`
    : '（暂无控制台记录）'
  return {
    tabId: tab.id,
    total: ring.length,
    matched,
    count: entries.length,
    level,
    entries,
    text: lines.length > 0 ? lines.join('\n') : emptyText,
    summary: level === null
      ? `控制台记录 ${entries.length} 条`
      : `控制台记录 ${entries.length} 条（level ≥ ${level}，命中 ${matched} 条 / 缓冲 ${ring.length} 条）`,
  }
}

/** 读取网络请求记录尾部若干条（默认 100），最新在最后。 */
export async function networkEntries(session, limit = DEFAULT_RING_QUERY_LIMIT, tabId) {
  session.touch()
  const tab = currentTab(session, tabId)
  const ring = tab.networkRing
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RING_LIMIT) : DEFAULT_RING_QUERY_LIMIT
  const entries = ring.slice(-take)
  const lines = entries.map((entry) => {
    const status = entry.status > 0 ? String(entry.status) : '0(无响应)'
    const parts = [`${timeOf(entry.at)}`, `[${entry.request_id}]`, entry.method, status, entry.mimeType || '-', entry.url]
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

/**
 * 设置某标签页后续对话框的应答策略；prompt_text 只允许与 accept 同时出现。
 * @param {object} session - 会话状态
 * @param {string} policy - dismiss（取消）或 accept（确认）
 * @param {string} [promptText] - accept 时 prompt 的输入文本；缺省用页面默认值
 * @param {string} [tabId] - 目标标签页；缺省用 active tab
 * @returns {Promise<{tabId: string, policy: string, promptText: string|null, summary: string}>}
 */
export async function setDialogPolicy(session, policy, promptText, tabId) {
  if (policy !== 'accept' && policy !== 'dismiss') {
    throw new Error(`policy 只支持 dismiss（取消）或 accept（确认），收到 ${JSON.stringify(policy)}`)
  }
  if (promptText !== undefined && promptText !== null) {
    if (typeof promptText !== 'string') {
      throw new Error(`prompt_text 必须是字符串（可传空串表示输入空值），收到 ${typeof promptText}`)
    }
    if (promptText.length > DIALOG_PROMPT_TEXT_LIMIT) {
      throw new Error(`prompt_text 最多 ${DIALOG_PROMPT_TEXT_LIMIT} 个字符，收到 ${promptText.length} 个`)
    }
    if (policy !== 'accept') {
      throw new Error('prompt_text 只在 policy=accept 时生效；要输入 prompt 文本请同时传 policy: "accept"')
    }
  }
  const tab = currentTab(session, tabId)
  tab.dialogPolicy = policy
  tab.dialogPromptText = policy === 'accept' && typeof promptText === 'string' ? promptText : null
  const promptNote = tab.dialogPromptText === null ? '' : `，prompt 文本 "${tab.dialogPromptText}"`
  return {
    tabId: tab.id,
    policy,
    promptText: tab.dialogPromptText,
    summary: policy === 'accept'
      ? `对话框策略已设为 accept（自动确认${tab.dialogPromptText === null ? '，prompt 用页面默认值' : promptNote}）`
      : '对话框策略已设为 dismiss（自动取消）',
  }
}

/**
 * 读取某标签页尾部的对话框记录；最新在最后。
 * @param {object} session - 会话状态
 * @param {number} [limit] - 尾部条数；非正整数回退默认，超过环上限按环上限
 * @param {string} [tabId] - 目标标签页；缺省用 active tab
 * @returns {Promise<{tabId: string, policy: string, promptText: string|null, total: number,
 *   count: number, entries: object[], text: string, summary: string}>}
 */
export async function dialogEntries(session, limit = DIALOG_LIMIT_DEFAULT, tabId) {
  session.touch()
  const tab = currentTab(session, tabId)
  const ring = Array.isArray(tab.dialogRing) ? tab.dialogRing : []
  const take = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, DIALOG_RING_LIMIT)
    : DIALOG_LIMIT_DEFAULT
  const entries = ring.slice(-take)
  const lines = entries.map((entry) => {
    const parts = [timeOf(entry.at), entry.type, entry.accepted ? '已接受' : '已取消', oneLine(entry.message)]
    if (entry.type === 'prompt') parts.push(`（默认值：${oneLine(entry.defaultValue)}）`)
    if (entry.error) parts.push(`（应答失败：${oneLine(entry.error)}）`)
    return parts.join(' ')
  })
  const body = lines.length > 0 ? lines.join('\n') : '（暂无对话框记录）'
  const text = body.length > DIALOG_TEXT_LIMIT ? `${body.slice(0, DIALOG_TEXT_LIMIT)}...(已截断)` : body
  const policy = tab.dialogPolicy === 'accept' ? 'accept' : DEFAULT_DIALOG_POLICY
  const promptNote = tab.dialogPromptText === null || tab.dialogPromptText === undefined ? '' : `，prompt 文本 "${tab.dialogPromptText}"`
  return {
    tabId: tab.id,
    policy,
    promptText: tab.dialogPromptText ?? null,
    total: ring.length,
    count: entries.length,
    entries,
    text,
    summary: `对话框记录 ${entries.length} 条（策略 ${policy}${promptNote}）`,
  }
}

/** 详情结果里默认隐藏的敏感头（小写）。 */
export const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token', 'x-session-token',
  'x-csrf-token', 'x-xsrf-token',
])

/** 敏感头的隐藏占位。 */
export const REDACTED_HEADER_VALUE = '[已隐藏]'

/** 有重定向语义的状态码：Playwright 对 3xx 一律拒读正文，这几个另给出后续请求。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 文本类 mime 的判定：`text/*`、`*json`、`*xml` 与几个明确的文本类型。 */
const TEXT_MIME_PATTERNS = [
  /^text\//,
  /[+/]json$/,
  /[+/]xml$/,
  /^application\/javascript$/,
  /^application\/ecmascript$/,
  /^application\/x-www-form-urlencoded$/,
]

/** 把一段正文 Buffer 的 sha256 转成十六进制。 */
function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 从 content-type 里取 charset，取不到时为空串。 */
function charsetOf(mimeType) {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(String(mimeType ?? ''))
  return match ? match[1].trim().toLowerCase() : ''
}

/** mime 是否属于文本类（忽略 `; charset=` 等参数）。 */
export function isTextMime(mimeType) {
  const mime = String(mimeType ?? '').split(';')[0].trim().toLowerCase()
  if (!mime) return false
  return TEXT_MIME_PATTERNS.some((pattern) => pattern.test(mime))
}

/**
 * 二进制判定：mime 不是文本类，且（mime 非空或字节里含 NUL）。
 * mime 为空且没有 NUL 时按文本尝试解码。
 */
function isBinaryBody(buffer, mimeType) {
  if (isTextMime(mimeType)) return false
  return String(mimeType ?? '').trim().length > 0 || buffer.includes(0)
}

/** 按 charset 解码正文，不认识的 charset 回退 UTF-8。 */
export function decodeText(buffer, mimeType) {
  try {
    return new TextDecoder(charsetOf(mimeType) || 'utf-8').decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

/**
 * 尝试把文本解析成 JSON：仅当 mime 含 json 或文本以 `{` / `[` 开头时解析。
 * @returns {*} 解析结果；不是 JSON 时返回 undefined（用于区分 JSON 的 null）
 */
function tryParseJson(text, mimeType) {
  const trimmed = text.trim()
  const mime = String(mimeType ?? '').toLowerCase()
  if (!mime.includes('json') && !trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 把正文 Buffer 分类成视图：文本类给 text / chars / truncated，JSON 额外给解析结果与
 * 两空格格式化文本，二进制只给 bytes / sha256（不返回 base64，也不写正文）。
 * @param {Buffer} buffer - 完整正文
 * @param {string} mimeType - content-type（可带 charset）
 * @param {number} maxChars - 文本最多保留的字符数
 * @returns {object} 正文视图
 */
function bodyViewOf(buffer, mimeType, maxChars) {
  const bytes = buffer.length
  const sha256 = sha256Of(buffer)
  if (bytes === 0) {
    return { kind: 'empty', mimeType, bytes: 0, chars: 0, truncated: false, sha256, text: '空（0 字节）' }
  }
  if (isBinaryBody(buffer, mimeType)) return { kind: 'binary', mimeType, bytes, sha256 }
  const decoded = decodeText(buffer, mimeType)
  const chars = decoded.length
  const truncated = chars > maxChars
  const text = truncated ? decoded.slice(0, maxChars) : decoded
  const view = { kind: 'text', mimeType, bytes, chars, truncated, sha256, text }
  if (truncated) return view
  const json = tryParseJson(decoded, mimeType)
  if (json === undefined) return view
  return { kind: 'json', mimeType, bytes, chars, truncated, sha256, json, text: JSON.stringify(json, null, 2) }
}

/**
 * 给一个 Promise 套超时：到点抛 makeError() 的结果（底层读取不保证被取消，只丢弃结果）。
 * @param {Promise<*>} promise - 待等待的读取
 * @param {number} timeoutMs - 超时毫秒数
 * @param {() => Error} makeError - 超时错误构造
 * @returns {Promise<*>} 读取结果
 */
function withBodyTimeout(promise, timeoutMs, makeError) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(makeError()), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 响应体读取超时错误（带标记，便于与「不可读」区分）。 */
function bodyTimeoutError(timeoutMs) {
  const error = new Error(
    `读取响应体超时（${timeoutMs}ms）：响应可能仍在流式传输（SSE / 长轮询），本工具只读取已完成的响应`,
  )
  error.bodyTimeout = true
  return error
}

/**
 * 读取并规整请求 / 响应头：头名统一小写，include_sensitive 为 false 时脱敏敏感值。
 * 套 timeout_ms：`request.allHeaders()` 对尚未响应的请求会等到响应头到达，不能无限等。
 * 头读取失败或超时按空头处理（详情仍可返回其余部分）。
 * @param {object} source - Playwright Request / Response
 * @param {boolean} includeSensitive - 是否显示敏感头原值
 * @param {number} timeoutMs - 读取超时毫秒数
 * @returns {Promise<object>} 头对象
 */
async function headersOf(source, includeSensitive, timeoutMs) {
  if (typeof source?.allHeaders !== 'function') return {}
  let raw
  try {
    raw = await withBodyTimeout(source.allHeaders(), timeoutMs, () => new Error('读取头超时'))
  } catch {
    return {}
  }
  const headers = {}
  for (const [name, value] of Object.entries(raw ?? {})) {
    const key = name.toLowerCase()
    headers[key] = !includeSensitive && SENSITIVE_HEADERS.has(key) ? REDACTED_HEADER_VALUE : value
  }
  return headers
}

/** 请求体视图：无请求体或读取失败时返回 null（读取超时只丢弃结果）。 */
async function postDataViewOf(request, requestHeaders, timeoutMs, maxChars) {
  if (typeof request?.postDataBuffer !== 'function') return null
  let buffer
  try {
    buffer = await withBodyTimeout(
      request.postDataBuffer(),
      timeoutMs,
      () => new Error(`读取请求体超时（${timeoutMs}ms）`),
    )
  } catch {
    return null
  }
  if (!buffer || buffer.length === 0) return null
  return bodyViewOf(buffer, requestHeaders['content-type'] ?? '', maxChars)
}

/** 安全取请求地址。 */
function requestUrlOf(request) {
  try {
    return typeof request?.url === 'function' ? request.url() : ''
  } catch {
    return ''
  }
}

/** 安全取重定向目标请求（fake Request 可能没有该方法）。 */
function redirectedToOf(request) {
  try {
    return typeof request?.redirectedTo === 'function' ? request.redirectedTo() : null
  } catch {
    return null
  }
}

/** 无重定向目标的 3xx 正文视图。 */
function noBodyRedirectView(mimeType) {
  return { kind: 'none', mimeType, bytes: 0, text: '无正文（3xx）' }
}

/** 重定向正文视图：给出状态、Location 与后续请求。 */
function redirectView(status, location, toRequestId, toUrl) {
  const locationPart = location ? `，Location: ${location}` : ''
  let targetPart = ''
  if (toRequestId) targetPart = `；后续请求 request_id ${toRequestId}`
  else if (toUrl) targetPart = `；后续请求：${toUrl}`
  return { kind: 'redirect', mimeType: '', bytes: 0, text: `无（${status} 重定向${locationPart}${targetPart}）` }
}

/** 读取响应体并分类；超时抛超时错误，其余失败转「不可读」错误。 */
async function responseBodyViewOf(response, mimeType, timeoutMs, maxChars) {
  if (typeof response?.body !== 'function') {
    return { kind: 'none', mimeType, bytes: 0, text: '无正文（响应对象不可用）' }
  }
  let buffer
  try {
    buffer = await withBodyTimeout(response.body(), timeoutMs, () => bodyTimeoutError(timeoutMs))
  } catch (error) {
    if (error?.bodyTimeout) throw error
    throw new Error(
      `响应体不可读：页面可能已关闭或导航，浏览器不再保留该响应体（${error?.message ?? error}）；请在发起请求的同一文档内读取`,
    )
  }
  return bodyViewOf(buffer, mimeType, maxChars)
}

/** 渲染头对象为多行文本；头为空时显式写「（无）」。 */
function renderHeaders(headers) {
  const names = Object.keys(headers ?? {})
  if (names.length === 0) return ['  （无）']
  return names.map((name) => `  ${name}: ${headers[name]}`)
}

/** 渲染请求体 / 响应体视图为若干行。二进制只描述大小与 sha256，不写正文。 */
function renderBodyView(view) {
  if (!view) return ['无']
  if (view.kind === 'binary') {
    return [`二进制 ${view.mimeType || '-'}（${view.bytes} 字节，sha256 ${view.sha256}），未返回 base64`]
  }
  if (view.kind === 'text' || view.kind === 'json') {
    const label = view.kind === 'json' ? 'JSON' : '文本'
    const note = view.truncated ? '，已截断到 max_chars' : ''
    return [`${label}（${view.bytes} 字节，${view.chars} 字符${note}，sha256 ${view.sha256}）`, view.text]
  }
  return [view.text ?? '无']
}

/** 把「标签：第一行 + 其余行」追加到输出行里。 */
function pushBodySection(lines, label, view) {
  const bodyLines = renderBodyView(view)
  lines.push(`${label}：${bodyLines[0]}`, ...bodyLines.slice(1))
}

/** 按 id 读取一条仍在环形缓冲里的网络记录详情（头、请求体、响应体）。 */
export async function networkDetail(session, requestId, options = {}, tabId) {
  session.touch()
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('缺少必填参数 request_id（非空字符串）')
  }
  if (!/^n[1-9][0-9]*$/.test(requestId)) {
    throw new Error(`request_id 格式不对：需要 browser_e2e_network 返回的 n<N>（例如 n3），收到 ${JSON.stringify(requestId)}`)
  }
  const maxChars = options.maxChars === undefined ? NETWORK_BODY_TEXT_LIMIT : options.maxChars
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > NETWORK_BODY_TEXT_LIMIT) {
    throw new Error(`max_chars 必须是 1..${NETWORK_BODY_TEXT_LIMIT} 的整数，收到 ${maxChars}`)
  }
  const timeoutMs = options.timeoutMs === undefined ? NETWORK_BODY_TIMEOUT_MS : options.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < NETWORK_BODY_TIMEOUT_MIN_MS || timeoutMs > NETWORK_BODY_TIMEOUT_MAX_MS) {
    throw new Error(`timeout_ms 必须是 ${NETWORK_BODY_TIMEOUT_MIN_MS}..${NETWORK_BODY_TIMEOUT_MAX_MS} 的整数，收到 ${timeoutMs}`)
  }
  const includeSensitive = options.includeSensitive === true

  const tab = currentTab(session, tabId)
  const ring = tab.networkRing
  const record = ring.find((item) => item.request_id === requestId)
  const context = tab.networkContext?.get(requestId)
  if (!record || !context) {
    throw new Error(
      `网络记录里没有 request_id ${requestId}（当前环形缓冲 ${ring.length} 条）：`
      + `可能已被 ${RING_LIMIT} 条上限淘汰，或页面已导航导致记录重置；请重新调用 browser_e2e_network 获取最新 request_id`,
    )
  }

  const request = context.request
  // 分支在入口一次性判定：`request.allHeaders()` 对尚未响应的请求会等到响应头到达，
  // 若读完头再判状态，会把「调用时仍未完成」的请求误判成已完成。
  const status = record.status
  const response = context.response ?? null
  const requestHeaders = await headersOf(request, includeSensitive, timeoutMs)
  const postData = await postDataViewOf(request, requestHeaders, timeoutMs, maxChars)

  let responseHeaders = {}
  let body
  let redirect = null
  if (!response && record.failure) {
    // 没有拿到响应的失败请求（连接被拒、请求中止）：不读正文。
    body = {
      kind: 'failed',
      mimeType: record.mimeType,
      bytes: 0,
      reason: record.failure,
      text: `无（请求失败：${record.failure}）`,
    }
  } else if (status === 0) {
    // 尚未响应：不阻塞等待，返回已能拿到的请求头 / 请求体。
    body = { kind: 'pending', mimeType: record.mimeType, bytes: 0, text: '请求尚未完成（status 0），请稍后重试或先用 browser_e2e_wait 等待' }
  } else if (response) {
    responseHeaders = await headersOf(response, includeSensitive, timeoutMs)
    if (REDIRECT_STATUSES.has(status)) {
      // Playwright 对 3xx 一律拒读正文；这里只给状态、Location 与后续请求。
      const next = redirectedToOf(request)
      const location = responseHeaders.location ?? ''
      const toUrl = next ? requestUrlOf(next) : location
      const toRequestId = next ? tab.networkByRequest.get(next)?.request_id : undefined
      redirect = { from: record.url, toUrl, ...(toRequestId ? { toRequestId } : {}) }
      body = redirectView(status, location, toRequestId, toUrl)
    } else if (status >= 300 && status < 400) {
      body = noBodyRedirectView(record.mimeType)
    } else if (status === 204 || status === 205) {
      // 204 / 205 按规范没有正文；Playwright 对这类响应调用 body() 会报「No data found」，
      // 直接按 0 字节的空正文返回。
      body = bodyViewOf(Buffer.alloc(0), record.mimeType, maxChars)
    } else {
      body = await responseBodyViewOf(response, record.mimeType, timeoutMs, maxChars)
    }
  } else {
    body = { kind: 'none', mimeType: record.mimeType, bytes: 0, text: '无正文（响应对象不可用）' }
  }

  const statusText = status > 0 ? String(status) : '0(无响应)'
  const summary = `网络请求详情 ${requestId}：${record.method} ${record.url} → ${statusText} ${record.mimeType || '-'}`
  const lines = [`请求：${record.method} ${record.url}`, `状态：${statusText} ${record.mimeType || '-'}`]
  if (record.failure) lines.push(`失败：${record.failure}`)
  lines.push('请求头：', ...renderHeaders(requestHeaders))
  pushBodySection(lines, '请求体', postData)
  lines.push('响应头：', ...renderHeaders(responseHeaders))
  pushBodySection(lines, '响应体', body)

  return {
    tabId: tab.id,
    request_id: requestId,
    url: record.url,
    method: record.method,
    status,
    mimeType: record.mimeType,
    failure: record.failure,
    at: record.at,
    redirect,
    request: { headers: requestHeaders, postData },
    response: { headers: responseHeaders, body },
    summary,
    text: lines.join('\n'),
  }
}
