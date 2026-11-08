/**
 * 下载层：URL 直接取回 / 点击触发 download 事件、下载目录与文件名、大小上限、SHA-256。
 *
 * 不 import session.js：会话对象由 tools.js 的 run 传入；页面能力复用 page.js 的
 * currentTab / click，产物目录复用 capture.js 的 ensureArtifactsDir。
 * 下载目录是唯一可配置项（环境变量 DSH_BROWSER_DOWNLOAD_DIR），不提供按次 savePath。
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { click, currentTab } from './page.js'
import { ensureArtifactsDir } from './capture.js'
import { isTimeoutError } from './errors.js'
import { sha256Of } from './hash.js'

/** 单文件默认上限 100 MiB。 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
/** 单文件硬上限 1 GiB。 */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
/** 超时下限 / 上限（毫秒）。 */
export const DOWNLOAD_TIMEOUT_MIN_MS = 1000
export const DOWNLOAD_TIMEOUT_MAX_MS = 300000

/** 未传 timeoutMs 时的默认总预算。 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000
/** 显式 filename 的长度上限。 */
const MAX_FILENAME_LENGTH = 180
/** 同名文件最多尝试的后缀个数。 */
const MAX_FILENAME_ATTEMPTS = 1000
/** Windows 保留设备名（按第一个点号前的主体判断）。 */
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/
/** 文件名里必须拒绝的控制字符与 Windows 非法字符。 */
const FILENAME_ILLEGAL = /[\u0000-\u001f\u007f<>:"|?*]/
/** 服务器建议名清洗时去掉的控制字符与不可见字符（含双向覆盖与行分隔符）。 */
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g

/** 解析本次调用的来源与参数；顺序固定，任一失败即抛。 */
function parseOptions(options) {
  const opts = options || {}
  const url = typeof opts.url === 'string' && opts.url.length > 0 ? opts.url : ''
  const ref = typeof opts.ref === 'string' && opts.ref.length > 0 ? opts.ref : ''
  const selector = typeof opts.selector === 'string' && opts.selector.length > 0 ? opts.selector : ''
  const hasPoint = Number.isFinite(opts.x) && Number.isFinite(opts.y)
  const triggerCount = (ref ? 1 : 0) + (selector ? 1 : 0) + (hasPoint ? 1 : 0)

  if (!url && triggerCount === 0) {
    throw new Error('缺少下载来源：请给 url（直接下载）或 ref / selector / x + y（点击触发下载）')
  }
  if (url && triggerCount > 0) {
    throw new Error('下载来源只能给一种：url 与 ref / selector / x + y 互斥')
  }
  if (triggerCount > 1) {
    throw new Error('下载触发目标只能给一种：ref / selector / x + y 三选一')
  }

  if (url) {
    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      protocol = ''
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`下载 url 只支持 HTTP(S)，收到 "${url}"；请给形如 https://example.com/report.pdf 的地址`)
    }
  }

  let filename = ''
  if (opts.filename !== undefined) {
    filename = assertRequestedFilename(opts.filename)
  }

  let maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES
  if (opts.maxBytes !== undefined) {
    if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > MAX_DOWNLOAD_BYTES) {
      throw new Error(`maxBytes 必须是 1..${MAX_DOWNLOAD_BYTES} 的整数，收到 ${JSON.stringify(opts.maxBytes)}`)
    }
    maxBytes = opts.maxBytes
  }

  let expectedSha256 = ''
  if (opts.expectedSha256 !== undefined) {
    if (typeof opts.expectedSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(opts.expectedSha256)) {
      throw new Error(`expectedSha256 必须是 64 位十六进制字符串，收到 ${JSON.stringify(opts.expectedSha256)}`)
    }
    expectedSha256 = opts.expectedSha256.toLowerCase()
  }

  let timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
  if (opts.timeoutMs !== undefined) {
    if (!Number.isInteger(opts.timeoutMs)
      || opts.timeoutMs < DOWNLOAD_TIMEOUT_MIN_MS
      || opts.timeoutMs > DOWNLOAD_TIMEOUT_MAX_MS) {
      throw new Error(`timeoutMs 必须是 ${DOWNLOAD_TIMEOUT_MIN_MS}..${DOWNLOAD_TIMEOUT_MAX_MS} 的整数，收到 ${JSON.stringify(opts.timeoutMs)}`)
    }
    timeoutMs = opts.timeoutMs
  }

  return {
    url,
    target: { ref: ref || undefined, selector: selector || undefined, x: opts.x, y: opts.y },
    isTrigger: triggerCount > 0,
    filename,
    maxBytes,
    expectedSha256,
    timeoutMs,
  }
}

/** 显式 filename：严格校验，不 trim、不替换、不截断。 */
function assertRequestedFilename(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`filename 必须是非空字符串，收到 ${JSON.stringify(value)}`)
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`filename 必须是纯文件名（不能含 / 或 \\），收到 "${value}"`)
  }
  if (FILENAME_ILLEGAL.test(value)) {
    throw new Error(`filename 不能包含控制字符或 < > : " | ? *，收到 "${value}"`)
  }
  if (value === '.' || value === '..' || /^\.+$/.test(value)) {
    throw new Error('filename 不能是 "." 或 ".."，也不能是纯点号')
  }
  if (value.endsWith('.') || value.endsWith(' ')) {
    throw new Error(`filename 不能以 "." 或空格结尾，收到 "${value}"`)
  }
  if (WINDOWS_RESERVED_NAME.test(value.split('.')[0].toUpperCase())) {
    throw new Error(`filename 不能是 Windows 保留设备名（CON / PRN / AUX / NUL / COM1-COM9 / LPT1-LPT9），收到 "${value}"`)
  }
  if (value.length > MAX_FILENAME_LENGTH) {
    throw new Error(`filename 超过 ${MAX_FILENAME_LENGTH} 字符，收到 ${value.length} 字符`)
  }
  return value
}

/** 服务器建议名：只取 basename、清洗非法字符，空值回退 download。 */
function sanitizeSuggestedName(raw) {
  let name = typeof raw === 'string' ? raw : ''
  name = name.replace(INVISIBLE_CHARS, '')
  const parts = name.split(/[\\/]/)
  name = parts[parts.length - 1] || ''
  name = name.replace(/[<>:"|?*]/g, '_')
  name = name.replace(/[. ]+$/, '')
  if (!name || name === '.' || name === '..' || /^\.+$/.test(name)) {
    name = 'download'
  }
  if (WINDOWS_RESERVED_NAME.test(name.split('.')[0].toUpperCase())) {
    name = `_${name}`
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot - 1 <= 20 ? name.slice(dot) : ''
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext
  }
  return name
}

/** 从 Content-Disposition 取建议名：filename* 优先，其次 filename。 */
function nameFromContentDisposition(header) {
  if (typeof header !== 'string' || header.length === 0) return ''
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header)
  if (star) {
    let value = star[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    const encoded = /^[^']*'[^']*'(.*)$/.exec(value)
    const target = encoded ? encoded[1] : value
    try {
      return decodeURIComponent(target)
    } catch {
      return target
    }
  }
  const plain = /filename\s*=\s*([^;]+)/i.exec(header)
  if (!plain) return ''
  let value = plain[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value.replace(/\\"/g, '"')
}

/** 从 URL 路径最后一段取建议名（百分号解码）；取不到返回空串。 */
function nameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname
    const segments = pathname.split('/')
    const last = segments[segments.length - 1] || ''
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  } catch {
    return ''
  }
}

/** 解析下载目录：环境变量绝对路径优先，否则 <产物目录>/downloads。 */
function downloadDirFor(session) {
  const raw = process.env.DSH_BROWSER_DOWNLOAD_DIR
  const configured = typeof raw === 'string' ? raw.trim() : ''
  if (configured && !isAbsolute(configured)) {
    throw new Error(`DSH_BROWSER_DOWNLOAD_DIR 必须是绝对路径，收到 "${configured}"`)
  }
  const dir = configured || join(ensureArtifactsDir(session), 'downloads')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new Error(`下载目录不可用：${dir}；${err.message}`)
  }
  return dir
}

/** 构造 name-1.ext / name-2.ext … 形式的候选名。 */
function suffixedName(filename, index) {
  const dot = filename.lastIndexOf('.')
  if (dot > 0) return `${filename.slice(0, dot)}-${index}${filename.slice(dot)}`
  return `${filename}-${index}`
}

/** 独占创建最终文件；命中 EEXIST 依次试后缀，绝不覆盖已有文件。 */
function claimFile(dir, filename) {
  for (let index = 0; index < MAX_FILENAME_ATTEMPTS; index += 1) {
    const candidate = index === 0 ? filename : suffixedName(filename, index)
    const file = join(dir, candidate)
    try {
      const fd = openSync(file, 'wx')
      return { file, filename: candidate, fd }
    } catch (err) {
      if (err && err.code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error(`下载目录里找不到可用文件名：${filename}（已尝试 ${MAX_FILENAME_ATTEMPTS} 个后缀）`)
}

/** 按 fd 写完整个 Buffer（writeSync 可能部分写入）。 */
function writeAllSync(fd, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset)
  }
}

/** 删除文件；失败静默（清理尽力而为）。 */
function removeFile(file) {
  try {
    unlinkSync(file)
  } catch {
    // 清理失败不覆盖原始错误。
  }
}

/** 写 URL 响应体：整包读入内存后落盘，并在写盘前完成全部长度校验。 */
async function fetchToFile(session, params, dir, startedAt) {
  const { url, filename, maxBytes, expectedSha256, timeoutMs } = params
  const deadline = startedAt + timeoutMs
  const tab = currentTab(session, params.tabId)
  let response
  try {
    response = await tab.page.context().request.get(url, {
      timeout: timeoutMs,
      failOnStatusCode: false,
    })
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`下载超时：${timeoutMs}ms 内未完成（${url}）`)
    }
    throw new Error(`下载失败：${err.message}（${url}）`)
  }

  const status = response.status()
  if (status < 200 || status > 299) {
    throw new Error(`下载失败：HTTP ${status}（${url}）`)
  }

  const declared = Number.parseInt(response.headers()['content-length'] ?? '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`下载超过 maxBytes=${maxBytes} 字节上限（Content-Length 声明 ${declared} 字节），未写入文件（${url}）`)
  }

  let body
  try {
    body = await response.body()
  } catch (err) {
    if (isTimeoutError(err) || Date.now() > deadline) {
      throw new Error(`下载超时：${timeoutMs}ms 内未完成（${url}）`)
    }
    throw new Error(`下载失败：${err.message}（${url}）`)
  }
  if (Date.now() > deadline) {
    throw new Error(`下载超时：${timeoutMs}ms 内未完成（${url}）`)
  }
  if (body.length === 0) {
    throw new Error(`下载失败：响应体为 0 字节，未写入文件（${url}）`)
  }
  if (body.length > maxBytes) {
    throw new Error(`下载超过 maxBytes=${maxBytes} 字节上限（实际 ${body.length} 字节），未写入文件（${url}）`)
  }

  const rawSuggested = nameFromContentDisposition(response.headers()['content-disposition'])
    || nameFromUrl(url)
  const suggestedFilename = rawSuggested ? sanitizeSuggestedName(rawSuggested) : ''
  const finalFilename = filename || suggestedFilename || 'download'

  const claim = claimFile(dir, finalFilename)
  let done = false
  try {
    writeAllSync(claim.fd, body)
    closeSync(claim.fd)
    done = true
  } finally {
    if (!done) {
      try {
        closeSync(claim.fd)
      } catch {
        // fd 可能已关闭。
      }
      removeFile(claim.file)
    }
  }

  const sha256 = sha256Of(body)
  if (expectedSha256 && sha256 !== expectedSha256) {
    removeFile(claim.file)
    throw new Error(`SHA-256 不匹配：期望 ${expectedSha256}，实际 ${sha256}；文件已删除（${claim.file}）`)
  }

  const elapsedMs = Date.now() - startedAt
  const finalUrl = response.url()
  const result = {
    source: 'request',
    file: claim.file,
    filename: claim.filename,
    suggestedFilename,
    url,
    bytes: body.length,
    sha256,
    timeoutMs,
    elapsedMs,
    summary: `下载 ${body.length} 字节 -> ${claim.file}`,
  }
  if (finalUrl && finalUrl !== url) result.finalUrl = finalUrl
  return result
}

/** 流式写入下载事件字节：边读边计数 / 算哈希，超限或到点销毁流。 */
async function streamToFd(stream, fd, params, url) {
  const { maxBytes, timeoutMs } = params
  const hash = createHash('sha256')
  let bytes = 0
  let timedOut = false
  const remaining = Math.max(0, params.deadline - Date.now())
  const timer = setTimeout(() => {
    timedOut = true
    stream.destroy(new Error('下载超时'))
  }, remaining)
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        stream.destroy()
        throw new Error(`下载超过 maxBytes=${maxBytes} 字节上限，已中止并删除半成品（已写入 ${bytes} 字节）`)
      }
      hash.update(chunk)
      writeAllSync(fd, chunk)
    }
  } catch (err) {
    if (timedOut) {
      throw new Error(`下载超时：${timeoutMs}ms 内未完成（${url}）`)
    }
    if (err && err.message && err.message.startsWith('下载超过')) throw err
    throw new Error(`下载中断：${err.message}；半成品已删除`)
  } finally {
    clearTimeout(timer)
  }
  if (timedOut) {
    throw new Error(`下载超时：${timeoutMs}ms 内未完成（${url}）`)
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** 点击触发下载：先挂事件监听，再复用 click 语义点击，最后流式落盘。 */
async function triggerDownload(session, params, dir, startedAt) {
  const { maxBytes, expectedSha256, timeoutMs } = params
  const tab = currentTab(session, params.tabId)
  const page = tab.page
  params.deadline = startedAt + timeoutMs

  let settled = false
  let eventValue
  const rawEvent = page.waitForEvent('download', { timeout: timeoutMs })
  rawEvent.catch(() => {})
  const eventPromise = rawEvent.then((value) => {
    settled = true
    eventValue = value
    return value
  }, (err) => {
    settled = true
    throw err
  })
  eventPromise.catch(() => {})

  let clickError = null
  try {
    await click(session, params.target, params.tabId)
  } catch (err) {
    clickError = err
  }
  if (clickError && !settled) throw clickError

  let download
  if (settled && eventValue) {
    download = eventValue
  } else {
    try {
      download = await eventPromise
    } catch {
      throw new Error(`点击后 ${timeoutMs}ms 内没有触发下载；请确认该操作会开始下载，或改用 url 模式`)
    }
  }

  const url = typeof download.url === 'function' ? download.url() : ''
  const suggestedFilename = typeof download.suggestedFilename === 'function'
    ? sanitizeSuggestedName(download.suggestedFilename())
    : ''
  const finalFilename = params.filename || suggestedFilename || 'download'

  let stream
  try {
    stream = typeof download.createReadStream === 'function' ? await download.createReadStream() : null
  } catch {
    stream = null
  }
  if (!stream) {
    throw new Error(`浏览器没有提供下载字节流：${url}`)
  }

  const claim = claimFile(dir, finalFilename)
  let done = false
  let written
  try {
    written = await streamToFd(stream, claim.fd, params, url)
    closeSync(claim.fd)
    done = true
  } finally {
    if (!done) {
      try {
        closeSync(claim.fd)
      } catch {
        // fd 可能已关闭。
      }
      removeFile(claim.file)
    }
  }

  if (written.bytes === 0) {
    removeFile(claim.file)
    throw new Error(`下载失败：响应体为 0 字节，未写入文件（${url}）`)
  }

  const failure = typeof download.failure === 'function'
    ? await download.failure().catch(() => null)
    : null
  if (failure) {
    removeFile(claim.file)
    throw new Error(`浏览器报告下载失败：${failure}（${url}）`)
  }

  if (expectedSha256 && written.sha256 !== expectedSha256) {
    removeFile(claim.file)
    throw new Error(`SHA-256 不匹配：期望 ${expectedSha256}，实际 ${written.sha256}；文件已删除（${claim.file}）`)
  }

  const elapsedMs = Date.now() - startedAt
  return {
    source: 'browser',
    file: claim.file,
    filename: claim.filename,
    suggestedFilename,
    url,
    bytes: written.bytes,
    sha256: written.sha256,
    timeoutMs,
    elapsedMs,
    summary: `下载 ${written.bytes} 字节 -> ${claim.file}`,
  }
}

/**
 * 下载一个文件并做完整性校验。
 * @param {object} session - 会话状态
 * @param {object} [options] - 下载参数
 * @param {string} [tabId] - 目标标签页 id
 * @returns {Promise<object>} 下载结果（含 file / bytes / sha256 等）
 */
export async function download(session, options = {}, tabId) {
  const startedAt = Date.now()
  const params = parseOptions(options)
  params.tabId = tabId
  const dir = downloadDirFor(session)
  session.touch?.()
  try {
    return params.isTrigger
      ? await triggerDownload(session, params, dir, startedAt)
      : await fetchToFile(session, params, dir, startedAt)
  } finally {
    session.touch?.()
  }
}
