/**
 * 环境诊断层：一次调用给出六项只读检查（runtime / edge / cdp / session / paths / env）。
 *
 * 与 browser_e2e_start 的分工：start 失败必须抛错，doctor 负责解释为什么。
 * 因此环境问题一律不抛错——六项照报，问题项由 STATUS 与修法行表达；只有入参非法才抛错。
 *
 * 零副作用：不启动浏览器、不接管 CDP、不建会话、不刷新空闲计时、不改任何会话字段。
 * 唯一的写操作是 paths 项在「已存在」的产物根目录里写一个探针文件并立即删除。
 *
 * 依赖方向：doctor.js → session.js / capture.js / defaults.js（session.js 不回指本文件）。
 */
import { createRequire } from 'node:module'
import { accessSync, constants, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, sep } from 'node:path'

import { artifactsRoot as defaultArtifactsRoot } from './capture.js'
import { DEFAULT_CDP_ENDPOINT } from './defaults.js'
import {
  activeSessionKeys, CLOSE_TIMEOUT_MS, IDLE_CLOSE_MS, normalizeCdpEndpoint, peekSession,
} from './session.js'

const require = createRequire(import.meta.url)

/** CDP 探测超时缺省值（毫秒）。 */
export const DOCTOR_PROBE_TIMEOUT_DEFAULT_MS = 1500
/** CDP 探测超时下限（毫秒）。 */
export const DOCTOR_PROBE_TIMEOUT_MIN_MS = 100
/** CDP 探测超时上限（毫秒）。 */
export const DOCTOR_PROBE_TIMEOUT_MAX_MS = 10000
/** 固定检查顺序；报告按此顺序输出，同一 id 只出现一行。 */
export const DOCTOR_CHECKS = ['runtime', 'edge', 'cdp', 'session', 'paths', 'env']

/** 报告状态全集。 */
const STATUSES = ['OK', 'WARN', 'FAIL', 'SKIP']

/** 入参 mode 校验文案（与 lib/session.js 的 launch 同文）。 */
function assertMode(mode) {
  if (mode !== undefined && mode !== 'isolated' && mode !== 'cdp') {
    throw new Error(`mode 只支持 isolated / cdp，收到 ${JSON.stringify(mode)}`)
  }
}

/** 入参 probeTimeoutMs 校验：必须是 100..10000 的整数。 */
function assertProbeTimeout(value) {
  if (!Number.isInteger(value) || value < DOCTOR_PROBE_TIMEOUT_MIN_MS || value > DOCTOR_PROBE_TIMEOUT_MAX_MS) {
    throw new Error(`probeTimeoutMs 必须是 ${DOCTOR_PROBE_TIMEOUT_MIN_MS}..${DOCTOR_PROBE_TIMEOUT_MAX_MS} 的整数，收到 ${JSON.stringify(value)}`)
  }
}

/** 组装一项检查结果。 */
function checkOf(id, status, detail, fix) {
  if (!STATUSES.includes(status)) throw new Error(`未知诊断状态 ${status}`)
  return fix ? { id, status, detail, fix } : { id, status, detail }
}

/**
 * 系统 Edge 候选路径（判据与 Playwright `channel: 'msedge'` 的解析规则一致）。
 * 不读 EDGE_PATH：该变量只被 tests/cdp.mjs 使用，Playwright 启动时不读它。
 * @param {string} platform - process.platform 或测试注入值
 * @returns {string[]} 候选路径（按查找顺序）
 */
function defaultEdgeCandidates(platform) {
  if (platform === 'win32') {
    const prefixes = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.HOMEDRIVE ? `${process.env.HOMEDRIVE}\\Program Files` : undefined,
      process.env.HOMEDRIVE ? `${process.env.HOMEDRIVE}\\Program Files (x86)` : undefined,
    ]
    return prefixes
      .filter((prefix) => typeof prefix === 'string' && prefix.length > 0)
      .map((prefix) => join(prefix, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  if (platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  if (platform === 'linux') return ['/opt/microsoft/msedge/msedge']
  return []
}

/** runtime 项：Node / 平台 / 插件版本 / playwright-core 版本。 */
function checkRuntime() {
  const parts = [`Node ${process.version}（${process.platform} ${process.arch}）`]
  let status = 'OK'
  let fix
  try {
    parts.push(`插件 ${require('../package.json').version}`)
  } catch (error) {
    status = 'WARN'
    parts.push(`插件版本读取失败：${error.message}`)
    fix = '确认插件包内 package.json 可读（重装插件后再试）'
  }
  try {
    parts.push(`playwright-core ${require('playwright-core/package.json').version}`)
  } catch (error) {
    status = 'FAIL'
    parts.push(`playwright-core 读取失败：${error.message}`)
    fix = '重新安装依赖（npm install / pnpm install），确认 playwright-core 已安装'
  }
  return checkOf('runtime', status, parts.join('；'), fix)
}

/** edge 项：按 Playwright 的同一条候选前缀判定系统 Edge 可执行文件是否存在。 */
function checkEdge(platform, edgeCandidates) {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    return checkOf('edge', 'SKIP', `当前平台 ${platform} 不在 win32 / darwin / linux，跳过系统 Edge 查找`, '需要检查浏览器可执行文件时在受支持的平台上运行，或改用 CDP 接管（mode=cdp）')
  }
  const candidates = edgeCandidates()
  const found = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  if (found) return checkOf('edge', 'OK', found)
  const where = candidates.length > 0 ? `首个查找位置：${candidates[0]}` : `当前平台 ${platform} 没有可用的候选前缀（检查 LOCALAPPDATA / PROGRAMFILES / HOMEDRIVE 环境变量）`
  return checkOf(
    'edge',
    'FAIL',
    `未找到系统 Edge（${where}）`,
    '安装 Microsoft Edge，或改用 CDP 接管已启动的浏览器（传 mode=cdp，先用 --remote-debugging-port 启动浏览器）',
  )
}

/**
 * TCP 连一下 host:port。
 * @param {string} host - 主机
 * @param {number} port - 端口
 * @param {number} timeoutMs - 连接上限
 * @returns {Promise<{ok: boolean, timeout?: boolean, code?: string, elapsedMs: number}>}
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = connect({ host, port })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ...result, elapsedMs: Date.now() - started })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ ok: true }))
    socket.once('timeout', () => done({ ok: false, timeout: true, code: 'TIMEOUT' }))
    socket.once('error', (error) => done({ ok: false, code: error.code ?? error.message }))
  })
}

/**
 * 取一次 GET /json/version 的响应（只读探测，不建立 CDP 会话）。
 * @param {string} host - 主机
 * @param {number} port - 端口
 * @param {number} timeoutMs - 请求上限
 * @returns {Promise<{ok: boolean, status?: number, body?: string, timeout?: boolean, code?: string, elapsedMs: number}>}
 */
function httpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve({ ...result, elapsedMs: Date.now() - started })
    }
    const req = httpRequest({
      host,
      port,
      path: '/json/version',
      method: 'GET',
      timeout: timeoutMs,
      headers: { accept: 'application/json' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 65536) req.destroy()
      })
      res.on('end', () => done({ ok: true, status: res.statusCode, body }))
      res.on('error', (error) => done({ ok: false, code: error.code ?? error.message }))
    })
    req.on('timeout', () => {
      req.destroy()
      done({ ok: false, timeout: true, code: 'TIMEOUT' })
    })
    req.on('error', (error) => done({ ok: false, code: error.code ?? error.message }))
    req.end()
  })
}

/** 默认 CDP 端点的端口：修法示例与默认端点共用 defaults.js 的同一份定义。 */
const DEFAULT_CDP_PORT = Number(new URL(DEFAULT_CDP_ENDPOINT).port)

/** cdp 项的修法文案：接管路径的通用起法。 */
function cdpLaunchFix(endpoint) {
  let port = DEFAULT_CDP_PORT
  try {
    const parsed = new URL(endpoint)
    if (parsed.port) port = Number(parsed.port)
  } catch {
    // 端点本身非法时用默认端口给示例
  }
  return `用 msedge.exe --remote-debugging-port=${port} --user-data-dir=<非默认目录> 启动浏览器后重试；Chrome/Edge 136+ 对默认数据目录忽略该开关`
}

/** cdp 项：端点归一 + TCP 可达 + GET /json/version 是 CDP 端点。 */
async function checkCdp(mode, rawEndpoint, probeTimeoutMs) {
  if (mode !== 'cdp') {
    return checkOf('cdp', 'SKIP', 'isolated 模式不探测 CDP（检查 CDP 接管环境时请传 mode=cdp）', '需要检查 CDP 接管环境时传 mode=cdp')
  }
  let endpoint
  try {
    endpoint = normalizeCdpEndpoint(rawEndpoint)
  } catch (error) {
    return checkOf('cdp', 'FAIL', error.message, `检查 cdpEndpoint：只支持 http + loopback，例如 ${DEFAULT_CDP_ENDPOINT}`)
  }
  const url = new URL(endpoint)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || 80)
  const tcp = await tcpProbe(host, port, probeTimeoutMs)
  if (!tcp.ok) {
    const reason = tcp.timeout ? '连接超时' : tcp.code
    return checkOf('cdp', 'FAIL', `${endpoint} 连不上（${reason}，${tcp.elapsedMs}ms）`, cdpLaunchFix(endpoint))
  }
  const http = await httpProbe(host, port, probeTimeoutMs)
  const totalMs = tcp.elapsedMs + http.elapsedMs
  if (!http.ok) {
    const reason = http.timeout ? '请求超时' : http.code
    return checkOf('cdp', 'FAIL', `${endpoint} 连不上（${reason}，${totalMs}ms）`, cdpLaunchFix(endpoint))
  }
  if (http.status !== 200) {
    return checkOf('cdp', 'WARN', `${endpoint} 不像 CDP 端点：/json/version 返回 HTTP ${http.status}`, '确认该端口是浏览器远程调试端口（--remote-debugging-port），不是其它服务')
  }
  let info
  try {
    info = JSON.parse(http.body)
  } catch {
    return checkOf('cdp', 'WARN', `${endpoint} 不像 CDP 端点：/json/version 不是 JSON`, '确认该端口是浏览器远程调试端口（--remote-debugging-port），不是其它服务')
  }
  if (info === null || typeof info !== 'object' || typeof info.webSocketDebuggerUrl !== 'string') {
    return checkOf('cdp', 'WARN', `${endpoint} 不像 CDP 端点：/json/version 缺少 webSocketDebuggerUrl`, '确认该端口是浏览器远程调试端口（--remote-debugging-port），不是其它服务')
  }
  const browser = typeof info.Browser === 'string' && info.Browser ? info.Browser : '版本未知'
  return checkOf('cdp', 'OK', `${endpoint} 可接管（${browser}）`)
}

/** 本进程里「持有浏览器」的其他会话数（只读注册表，不探测连接）。 */
function otherSessionCount(key) {
  return activeSessionKeys()
    .filter((other) => other !== key)
    .filter((other) => {
      const snapshot = peekSession(other)
      return snapshot !== null && (snapshot.state === 'ready' || snapshot.state === 'launching' || snapshot.state === 'closing')
    })
    .length
}

/** session 项：本会话在注册表里的只读视图。 */
function checkSession(key) {
  const others = otherSessionCount(key)
  const suffix = others > 0 ? `；本进程另有 ${others} 个会话持有浏览器` : ''
  const snapshot = peekSession(key)
  if (snapshot === null || snapshot.state === 'idle') {
    return checkOf('session', 'OK', `本会话未启动浏览器（工具调用时按需启动）${suffix}`)
  }
  if (snapshot.state === 'launching') {
    return checkOf('session', 'WARN', `会话正在 launching，诊断结果可能瞬时${suffix}`, '等启动落定后再重跑诊断')
  }
  if (snapshot.state === 'closing') {
    return checkOf('session', 'WARN', `会话正在 closing，诊断结果可能瞬时${suffix}`, '等关闭完成后再重跑诊断')
  }
  if (snapshot.state === 'closed') {
    return checkOf('session', 'WARN', `会话已关闭，诊断结果可能瞬时${suffix}`, '重新 browser_e2e_start 后重跑诊断')
  }
  if (!snapshot.connected) {
    return checkOf(
      'session',
      'FAIL',
      `CDP 连接已失效（browser.isConnected() 为 false，模式 ${snapshot.mode}）${suffix}`,
      '先 browser_e2e_close 关闭失效会话，再 browser_e2e_start 重新启动（CDP 模式请确认浏览器仍开着调试端口）',
    )
  }
  return checkOf('session', 'OK', `${snapshot.mode} 模式运行中，${snapshot.pages} 个标签页，连接正常${suffix}`)
}

/** 沿祖先链找最近存在的目录（用于产物根目录尚未创建时判可写性）。 */
function nearestExistingDir(path) {
  let current = path
  for (;;) {
    try {
      if (existsSync(current) && statSync(current).isDirectory()) return current
    } catch {
      // 无权限读该层：继续往上找
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 在目录里写一个探针文件并立即删除；写失败即判定不可写。 */
function probeWritable(dir) {
  const probe = join(dir, '.doctor-probe')
  writeFileSync(probe, '')
  try {
    unlinkSync(probe)
  } catch {
    // 探测已成功，删除失败不影响结论
  }
}

/** paths 项：产物根目录可写性 + 下载目录合法性。 */
function checkPaths(snapshot, artifactsRootFn) {
  const positives = []
  const problems = []
  let status = 'OK'
  let fix
  let root
  try {
    root = artifactsRootFn()
  } catch (error) {
    return checkOf('paths', 'FAIL', `产物根目录无法确定：${error.message}`, '确认 ~/.dsh/browser-e2e 可访问后重试')
  }
  if (existsSync(root)) {
    try {
      probeWritable(root)
      positives.push(`产物根目录 ${root} 可写`)
    } catch (error) {
      status = 'FAIL'
      problems.push(`产物根目录 ${root} 不可写（${error.message}）`)
      fix = '确认 ~/.dsh/browser-e2e/artifacts 的目录权限与磁盘可用空间后重试'
    }
  } else {
    const ancestor = nearestExistingDir(root)
    if (ancestor === null) {
      status = 'FAIL'
      problems.push(`产物根目录 ${root} 不存在，且找不到存在的祖先目录`)
      fix = '确认 ~/.dsh/browser-e2e 的上级目录可访问后重试'
    } else {
      try {
        accessSync(ancestor, constants.W_OK)
        positives.push(`产物根目录 ${root} 尚未创建；父目录 ${ancestor} 可写（首次启动时创建）`)
      } catch (error) {
        status = 'FAIL'
        problems.push(`产物根目录 ${root} 不存在，且父目录 ${ancestor} 不可写（${error.message}）`)
        fix = '确认 ~/.dsh/browser-e2e 的上级目录可写后重试'
      }
    }
  }
  const rawDownload = process.env.DSH_BROWSER_DOWNLOAD_DIR
  const download = typeof rawDownload === 'string' ? rawDownload.trim() : ''
  if (download && !isAbsolute(download)) {
    status = 'FAIL'
    problems.push(`下载目录 DSH_BROWSER_DOWNLOAD_DIR 不是绝对路径（收到 ${JSON.stringify(download)}）`)
    fix = '把 DSH_BROWSER_DOWNLOAD_DIR 改成绝对路径，或删除该环境变量改用默认下载目录'
  } else if (download) {
    positives.push(`下载目录 ${download}`)
  } else {
    const base = snapshot?.artifactsDir ?? root
    positives.push(`下载目录 默认（${base}${sep}downloads${sep}，启动后派生）`)
  }
  const detail = [...positives, ...problems].join('；')
  return checkOf('paths', status, detail, fix)
}

/** 解析环境变量里的整数：不是整数文本时返回 null。 */
function integerTextOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

/** env 项：空闲回收 / 关闭兜底 / 代理的合法性与生效值。 */
function checkEnv() {
  const parts = []
  let status = 'OK'
  let fix

  const idleRaw = process.env.DSH_BROWSER_IDLE_MS
  const idleParsed = integerTextOf(idleRaw)
  if (idleRaw === undefined) {
    parts.push(`空闲回收 ${IDLE_CLOSE_MS}ms（默认）`)
  } else if (idleParsed !== null && idleParsed >= 0) {
    parts.push(`空闲回收 ${IDLE_CLOSE_MS}ms（环境变量 ${JSON.stringify(idleRaw)}）`)
  } else {
    status = 'FAIL'
    parts.push(`空闲回收 非法：DSH_BROWSER_IDLE_MS 不是非负整数（收到 ${JSON.stringify(idleRaw)}；这类值会被 Number() 解析为 NaN，空闲回收会在启动落定后立刻触发），生效值 ${IDLE_CLOSE_MS}ms（模块加载时求值）`)
    fix = '把 DSH_BROWSER_IDLE_MS 设为非负整数（默认 600000，0 关闭空闲回收）后重启宿主进程'
  }

  const closeRaw = process.env.DSH_BROWSER_CLOSE_TIMEOUT_MS
  const closeParsed = integerTextOf(closeRaw)
  if (closeRaw === undefined) {
    parts.push(`关闭兜底 ${CLOSE_TIMEOUT_MS}ms（默认）`)
  } else if (closeParsed !== null && closeParsed > 0) {
    parts.push(`关闭兜底 ${CLOSE_TIMEOUT_MS}ms（环境变量 ${JSON.stringify(closeRaw)}）`)
  } else {
    if (status !== 'FAIL') status = 'WARN'
    parts.push(`关闭兜底 非法：DSH_BROWSER_CLOSE_TIMEOUT_MS 不是正整数（收到 ${JSON.stringify(closeRaw)}），生效值 ${CLOSE_TIMEOUT_MS}ms（模块加载时求值）`)
    fix = fix ?? '把 DSH_BROWSER_CLOSE_TIMEOUT_MS 设为正整数（默认 5000）后重启宿主进程'
  }

  const proxyRaw = process.env.DSH_BROWSER_PROXY
  const proxy = typeof proxyRaw === 'string' ? proxyRaw.trim() : ''
  let proxyValid = false
  if (proxy) {
    try {
      const url = new URL(proxy)
      proxyValid = (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
    } catch {
      proxyValid = false
    }
  }
  if (!proxy) {
    parts.push('代理 未设置')
  } else if (proxyValid) {
    parts.push(`代理 ${proxy}`)
  } else {
    if (status !== 'FAIL') status = 'WARN'
    parts.push(`代理 非法：DSH_BROWSER_PROXY 不是完整 URL（收到 ${JSON.stringify(proxy)}，需要 http(s)://host:port）`)
    fix = fix ?? '把 DSH_BROWSER_PROXY 写成完整 URL（如 http://127.0.0.1:7897），或删除该环境变量'
  }

  return checkOf('env', status, parts.join('；'), fix)
}

/** 按最严重项给结论行。 */
function conclusionOf(checks) {
  const count = (status) => checks.filter((check) => check.status === status).length
  if (count('FAIL') > 0) return '结论：先修 [FAIL] 项再 browser_e2e_start（本工具不启动浏览器、不改任何状态）。'
  if (count('WARN') > 0) return '结论：无阻塞项；[WARN] 项可能导致后续调用异常（本工具不启动浏览器、不改任何状态）。'
  return '结论：环境就绪，可以直接 browser_e2e_start（本工具不启动浏览器、不改任何状态）。'
}

/** 拼报告文本：首行统计 + 每项一行 + 非 OK 项各一行修法 + 末行结论。 */
function reportOf(checks, mode, endpoint) {
  const count = (status) => checks.filter((check) => check.status === status).length
  const lines = [
    `环境诊断：共 ${DOCTOR_CHECKS.length} 项，${count('OK')} 通过 / ${count('WARN')} 警告 / ${count('FAIL')} 失败 / ${count('SKIP')} 跳过（模式 ${mode}，端点 ${endpoint}）`,
  ]
  for (const check of checks) {
    lines.push(`[${check.status}] ${check.id}：${check.detail}`)
    if (check.status !== 'OK' && check.fix) lines.push(`   修复：${check.fix}`)
  }
  lines.push(conclusionOf(checks))
  return lines.join('\n')
}

/**
 * 诊断浏览器环境，返回固定六项的文本报告。
 *
 * @param {object} [options] - 入参
 * @param {string} [options.key] - 会话 key（由工具层的 sessionKey 给）
 * @param {string} [options.mode] - isolated / cdp（缺省取 defaults.mode，再缺省 isolated）
 * @param {string} [options.cdpEndpoint] - CDP 端点（缺省取 defaults.cdpEndpoint，再缺省 DEFAULT_CDP_ENDPOINT）
 * @param {number} [options.probeTimeoutMs] - CDP 探测超时，100..10000，默认 1500
 * @param {object} [options.defaults] - 插件配置的启动缺省值（只读）
 * @param {object} [deps] - 测试注入点
 * @param {() => string[]} [deps.edgeCandidates] - 覆盖 Edge 候选路径
 * @param {() => string} [deps.artifactsRoot] - 覆盖产物根目录
 * @param {string} [deps.platform] - 覆盖 process.platform
 * @returns {Promise<string>} 报告文本
 */
export async function diagnose(options = {}, deps = {}) {
  assertMode(options.mode)
  const probeTimeoutMs = options.probeTimeoutMs === undefined
    ? DOCTOR_PROBE_TIMEOUT_DEFAULT_MS
    : options.probeTimeoutMs
  assertProbeTimeout(probeTimeoutMs)

  const mode = (options.mode ?? options.defaults?.mode) === 'cdp' ? 'cdp' : 'isolated'
  const rawEndpoint = options.cdpEndpoint ?? options.defaults?.cdpEndpoint
  let endpointForSummary
  try {
    endpointForSummary = normalizeCdpEndpoint(rawEndpoint)
  } catch {
    endpointForSummary = typeof rawEndpoint === 'string' && rawEndpoint.trim()
      ? rawEndpoint.trim()
      : DEFAULT_CDP_ENDPOINT
  }

  const platform = deps.platform ?? process.platform
  const edgeCandidates = deps.edgeCandidates ?? (() => defaultEdgeCandidates(platform))
  const artifactsRootFn = deps.artifactsRoot ?? defaultArtifactsRoot
  const cdpCheck = await checkCdp(mode, rawEndpoint, probeTimeoutMs)
  // 会话快照在其它检查之后再取，尽量贴近报告时点（仍不创建会话、不刷新计时）。
  const snapshot = peekSession(options.key)

  const checks = [
    checkRuntime(),
    checkEdge(platform, edgeCandidates),
    cdpCheck,
    checkSession(options.key),
    checkPaths(snapshot, artifactsRootFn),
    checkEnv(),
  ]
  return reportOf(checks, mode, endpointForSummary)
}
