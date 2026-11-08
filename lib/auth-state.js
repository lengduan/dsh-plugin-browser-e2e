/**
 * 登录态导入与导出（功能规格 0021-auth-state-import.md，方案 A）。
 *
 * 两个方向：
 * - 读（导入）：读宿主绝对路径上的 Playwright storageState JSON，按可选域名后缀过滤后
 *   交给 `browser.newContext({ storageState })`。读侧接受任意绝对路径——读的是调用方自己给的文件。
 * - 写（导出）：从当前会话 context 取 `storageState()`，写成一个新 JSON 文件。写侧只允许
 *   `~/.dsh/browser-e2e/auth/` 下的 `.json`——导出物是明文凭据，插件无法判断目标路径是否
 *   落在某个仓库工作树内，因此不做目录豁免。
 *
 * 返回值与错误文案不含任何 cookie 名 / 值，只出现域名与计数。
 * 本模块只做校验、过滤与文件 I/O，不碰会话状态机；导入 / 导出的入口在 `session.js`。
 */
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, dirname, join, resolve, sep } from 'node:path'

/** storageState 文件大小上限（16 MiB）。 */
export const STORAGE_STATE_MAX_BYTES = 16 * 1024 * 1024

/** 导出（写侧）唯一允许的目录：~/.dsh/browser-e2e/auth。 */
export function authExportDir() {
  return join(homedir(), '.dsh', 'browser-e2e', 'auth')
}

/**
 * 归一一个域名后缀：去空白、转小写、去掉前导 `.` 或 `*.`（两者同义）。
 * @param {string} value - 调用方给的域名后缀
 * @returns {string}
 */
function normalizeDomain(value) {
  return value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '')
}

/**
 * 归一域名后缀数组：去重、去空白；未传返回 null（表示不过滤）。
 * @param {unknown} value - 调用方给的值
 * @param {string} label - 报错主语（storageDomains / domains）
 * @returns {string[]|null}
 */
export function normalizeDomains(value, label = 'storageDomains') {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} 必须是域名后缀字符串数组，收到 ${JSON.stringify(value)}；例如 ["example.com"]`)
  }
  return [...new Set(value.map(normalizeDomain))]
}

/** 主机是否命中任一域名后缀：去掉前导点后 `host === d` 或 `host.endsWith('.' + d)`。 */
function hostMatches(host, domains) {
  if (!domains) return true
  const normalized = String(host ?? '').trim().toLowerCase().replace(/^\./, '')
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))
}

/** 从 origin 字符串取 hostname；非法 URL 视为不命中（导入时由 Playwright 校验，这里只过滤）。 */
function hostnameOf(origin) {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/**
 * 按域名后缀过滤 storageState 的 cookies 与 origins。
 * @param {{cookies: object[], origins: object[]}} state - Playwright storageState
 * @param {string[]|null} domains - 归一后的域名后缀；null 表示全部保留
 * @returns {{cookies: object[], origins: object[]}}
 */
export function filterStorageState(state, domains) {
  if (!domains) return { cookies: state.cookies, origins: state.origins }
  return {
    cookies: state.cookies.filter((cookie) => hostMatches(cookie?.domain, domains)),
    origins: state.origins.filter((entry) => hostMatches(hostnameOf(entry?.origin), domains)),
  }
}

/**
 * 从 storageState 条目里收集域名：cookie 的 domain（去前导点）与 origin 的 hostname，升序去重。
 * @param {{cookies: object[], origins: object[]}} state - Playwright storageState
 * @returns {string[]}
 */
export function domainsOfStorageState(state) {
  const domains = new Set()
  for (const cookie of state.cookies) {
    const domain = String(cookie?.domain ?? '').trim().toLowerCase().replace(/^\./, '')
    if (domain) domains.add(domain)
  }
  for (const entry of state.origins) {
    const host = hostnameOf(entry?.origin).toLowerCase()
    if (host) domains.add(host)
  }
  return [...domains].sort()
}

/** 导入失败文案：单条读取路径。 */
function assertStorageStatePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`storageState 必须是 .json 文件的绝对路径，收到 ${JSON.stringify(value)}；请先用 browser_e2e_auth_export 生成`)
  }
  const path = value.trim()
  if (!isAbsolute(path)) {
    throw new Error(`storageState 必须是绝对路径：${path}；请给出宿主上的完整路径（如 C:\\tmp\\state.json）`)
  }
  return path
}

/** 校验 storageState 形状：cookies 必须是数组、origins 每项必须是带 origin 字符串的对象。 */
function assertStorageStateShape(value) {
  const cookies = value?.cookies
  const origins = value?.origins
  if (!Array.isArray(cookies)) {
    throw new Error('storageState 形状非法：cookies 必须是数组、origins 每项必须是带 origin 字符串的对象；请用 browser_e2e_auth_export 生成')
  }
  if (!Array.isArray(origins)
    || origins.some((entry) => entry === null || typeof entry !== 'object'
      || typeof entry.origin !== 'string' || entry.origin.trim() === '')) {
    throw new Error('storageState 形状非法：cookies 必须是数组、origins 每项必须是带 origin 字符串的对象；请用 browser_e2e_auth_export 生成')
  }
  return { cookies, origins }
}

/**
 * 读取并校验一份 storageState 文件，按可选域名后缀过滤。
 *
 * 同步读 + JSON 解析，设 16 MiB 上限；不设超时。所有失败都抛带修法的一句话错误。
 * @param {string} value - storageState 路径
 * @param {unknown} domainsValue - storageDomains（可选）
 * @returns {{path: string, cookies: object[], origins: object[], domains: string[]}}
 */
export function loadStorageState(value, domainsValue) {
  const path = assertStorageStatePath(value)
  if (!existsSync(path)) {
    throw new Error(`storageState 文件不存在：${path}；请确认路径拼写，并确认文件在运行插件的这台机器上`)
  }
  const stats = statSync(path)
  if (!stats.isFile()) {
    throw new Error(`storageState 路径不是文件：${path}；请指向具体的 .json 文件`)
  }
  if (stats.size > STORAGE_STATE_MAX_BYTES) {
    throw new Error(`storageState 文件过大：${stats.size} 字节，上限 ${STORAGE_STATE_MAX_BYTES} 字节；`
      + '请换一份更小的登录态文件，或先用 storageDomains 收窄导入范围')
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`storageState 不是合法 JSON：${path}；请确认它是 Playwright storageState（cookies / origins）文件`)
  }
  const state = assertStorageStateShape(parsed)
  const domains = normalizeDomains(domainsValue, 'storageDomains')
  const filtered = filterStorageState(state, domains)
  if (domains && filtered.cookies.length === 0 && filtered.origins.length === 0) {
    throw new Error('storageState 里没有命中 storageDomains 的条目（cookie 域名与 origin 主机都没匹配）；'
      + '请检查域名后缀，或去掉 storageDomains')
  }
  return {
    path,
    cookies: filtered.cookies,
    origins: filtered.origins,
    domains: domainsOfStorageState(filtered),
  }
}

/**
 * 校验导出路径：必须是 `~/.dsh/browser-e2e/auth/` 下的 `.json` 绝对路径。
 * @param {unknown} value - 调用方给的 path
 * @returns {string} 归一后的绝对路径
 */
function resolveExportPath(value) {
  if (typeof value !== 'string' || value.trim() === '' || !value.trim().toLowerCase().endsWith('.json')) {
    throw new Error(`path 必须是 .json 文件的绝对路径，收到 ${JSON.stringify(value)}；例如 C:\\tmp\\state.json`)
  }
  const path = value.trim()
  if (!isAbsolute(path)) {
    throw new Error(`path 必须是 .json 文件的绝对路径，收到 ${JSON.stringify(value)}；例如 C:\\tmp\\state.json`)
  }
  const target = resolve(path)
  const root = resolve(authExportDir())
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`导出路径必须位于 ~/.dsh/browser-e2e/auth/ 下：${path}；该目录存放明文登录态，避免误写进仓库工作树`)
  }
  return target
}

/**
 * 导出登录态到磁盘：同目录临时文件 + rename 替换，权限 0o600（POSIX；Windows 上 mode 位不生效）。
 * @param {object} context - Playwright BrowserContext
 * @param {{path: unknown, domains?: unknown, overwrite?: unknown}} options - 导出参数
 * @returns {Promise<{file: string, bytes: number, cookies: number, origins: number, domains: string[], overwrite: boolean, summary: string}>}
 */
export async function exportStorageState(context, options = {}) {
  const file = resolveExportPath(options.path)
  const domains = normalizeDomains(options.domains, 'domains')
  const overwrite = options.overwrite === true
  if (existsSync(file) && !overwrite) {
    throw new Error(`文件已存在：${file}；导出的是明文凭据，确认覆盖请传 overwrite: true`)
  }
  const state = await context.storageState()
  const filtered = filterStorageState(state, domains)
  const domainList = domainsOfStorageState(filtered)
  const text = `${JSON.stringify({ cookies: filtered.cookies, origins: filtered.origins }, null, 2)}\n`
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(temp, 0o600)
    } catch {
      // Windows 上 chmod 只改只读位、mode 位不生效；文件名与内容正确即可。
    }
    // Windows 的 rename 不能覆盖已存在文件：覆盖分支先删目标，再 rename。
    if (existsSync(file)) rmSync(file, { force: true })
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清理失败不覆盖原始错误。
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`导出登录态失败：${reason}；未写入目标文件（临时文件已清理）`)
  }
  const empty = filtered.cookies.length === 0 && filtered.origins.length === 0
  const summary = `已导出登录态到 ${file}：${filtered.cookies.length} 个 cookie、${filtered.origins.length} 个 origin`
    + `（${domainList.length} 个域名）；文件含明文凭据，勿提交仓库`
  return {
    file,
    bytes: Buffer.byteLength(text),
    cookies: filtered.cookies.length,
    origins: filtered.origins.length,
    domains: domainList,
    overwrite,
    summary: empty ? `${summary}\n当前上下文没有 cookie / localStorage，导出的是空状态` : summary,
  }
}
