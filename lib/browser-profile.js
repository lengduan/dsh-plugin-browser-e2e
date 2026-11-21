/**
 * 浏览器 profile 目录与 `Local State` 预置标记（账户锁定防护第一层，功能规格 0042）。
 *
 * 背景：Chromium 每次**浏览器进程启动**都会用空密码调 Windows 登录接口探测「本机是否设了密码」，
 * 密码错就记一笔 4625 登录失败；本机策略 10 次 / 14 分钟 / 锁 15 分钟，AI 频繁启停浏览器极易触发
 * 账户锁定（实测 30 天内 msedge.exe 造成 127 条 4625、峰值 21 次/14 分钟）。
 * Chromium 把「已测过」记在 profile 的 `Local State` 里，所以只要 **profile 目录稳定 + 标记仍在**，
 * 后续启动就不再探测。
 *
 * 本模块只做「目录解析 + Local State 读写」，不碰会话、不碰页面能力、不启动浏览器：
 * 依赖方向 pool.js → browser-profile.js，不回指任何上层模块。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 与既有 auth/ / history/ / artifacts/ 同根的 profile 子目录名。 */
const PROFILE_DIR_NAME = 'browser-profile'

/**
 * 哨兵值：`password_manager.os_password_last_changed` 的预置取值。
 *
 * 选一个明显不可能由 Chromium 自己写出的值（Unix 微秒时间戳不会到 2^63-1），
 * 测试据此判断「Chromium 是否读过并改写了这个字段」——被改写过说明它真的消费了这个标记，
 * 从而不再重新做空密码探测。这是 A 方案（哨兵值法）的判据，无需管理员权限。
 */
export const OS_PASSWORD_LAST_CHANGED_SENTINEL = '9223372036854775807'

/**
 * profile 目录根：`~/.dsh/browser-e2e/browser-profile/`。
 *
 * **常驻**：不随池 shutdown / 空闲回收删除（决策 D13）。收益公式是「每个池生命周期只触发一次 4625」，
 * 前提正是这个目录常驻——下次 acquire 复用同一目录，Local State 标记仍有效。
 * 只在显式重置时清理。
 * @returns {string} 绝对路径
 */
export function resolveBrowserProfileDir() {
  const root = process.env.DSH_BROWSER_E2E_HOME
    ? resolve(process.env.DSH_BROWSER_E2E_HOME)
    : join(homedir(), '.dsh', 'browser-e2e')
  return join(root, PROFILE_DIR_NAME)
}

/**
 * 某个启动签名专属的 profile 子目录。
 *
 * **Chromium 独占 user-data-dir**：实测第二个 launchPersistentContext 用同一目录会直接报
 * 「Target page, context or browser has been closed」。池按签名分槽、一个槽一个浏览器进程，
 * 所以每个槽必须有自己的目录，否则第二个槽永远起不来。
 *
 * 目录**常驻**（决策 D13）：每个槽的 Local State 标记都留着，下次复用同一目录就不再探测；
 * 收益公式因此是「每次槽生命周期最多一次 4625」，而不是「每次池生命周期一次」。
 * @param {string} signature - pool.signatureOf() 的返回值
 * @returns {string} 绝对路径；签名非法时退回根目录
 */
export function resolveSlotProfileDir(signature) {
  if (typeof signature !== 'string' || !signature) return resolveBrowserProfileDir()
  // 签名是 JSON 字符串，直接当目录名不安全：用稳定哈希取短名，同时保留可读前缀。
  let hash = 0
  for (let index = 0; index < signature.length; index += 1) {
    hash = (hash * 31 + signature.charCodeAt(index)) | 0
  }
  const suffix = Math.abs(hash).toString(16).padStart(8, '0')
  // 前缀只为可读性（排查时一眼看出这个目录是哪种浏览器），判据必须是精确的字段值：
  // edge 的 executablePath 是空串，不能凭「字段存在」判断。
  let parsed = {}
  try {
    parsed = JSON.parse(signature)
  } catch {
    parsed = {}
  }
  const headless = parsed.headless === false ? 'visible' : 'headless'
  const chrome = typeof parsed.executablePath === 'string' && parsed.executablePath ? 'chrome' : 'edge'
  return join(resolveBrowserProfileDir(), `${headless}-${chrome}-${suffix}`)
}

/**
 * 读 `Local State`（不存在或损坏都返回空对象，不抛）。
 * @param {string} dir - profile 目录
 * @returns {{ data: object, existed: boolean, recovered: boolean }} 内容与「原本是否存在 / 是否从损坏中恢复」
 */
export function readLocalState(dir) {
  const file = join(dir, 'Local State')
  if (!existsSync(file)) return { data: {}, existed: false, recovered: false }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { data: {}, existed: true, recovered: true }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, existed: true, recovered: true }
    }
    return { data: parsed, existed: true, recovered: false }
  } catch {
    // 损坏的 JSON 不能原地覆盖成新文件：留一份 .corrupt 备份便于事后排查，再从空对象重建。
    try {
      renameSync(file, `${file}.corrupt`)
    } catch {
      // 备份失败也要继续：宁可重建也不能挡启动
    }
    return { data: {}, existed: true, recovered: true }
  }
}

/**
 * 确保 profile 目录里 `Local State` 带有「已探测过系统密码」的标记。
 *
 * **必须合并写入，不能整体覆盖**：`Local State` 还有大量其它 Chromium 状态
 * （profile 信息、本地化、各项 feature 的实验配置等），整体覆盖会让浏览器退化成首次启动。
 * `os_password_last_changed` 必须是**字符串**：写成数字 Chromium 判定格式非法并重新测试。
 * @param {string} [dir] - profile 目录，缺省取 resolveBrowserProfileDir()
 * @returns {{ dir: string, file: string, written: boolean, created: boolean, recovered: boolean,
 *   previous: string|null }} 结果；written=false 表示标记已是正确形态、无需改写
 */
export function ensureLocalStateSeed(dir = resolveBrowserProfileDir()) {
  const target = resolve(dir)
  mkdirSync(target, { recursive: true })
  const file = join(target, 'Local State')
  const { data, existed, recovered } = readLocalState(target)
  // 损坏恢复后文件已被改名备份，这里 existed 必然是 false；recovered 必须沿用第一次读取的结论，
  // 否则调用方会看到「created=true, recovered=false」这种自相矛盾的结果。
  const wasRecovered = recovered
  // password_manager 是数组 / 非对象时，不能把它整体替换成 {}——那会丢掉里面本来好好的字段。
  // 只有「完全不是对象」才重建；数组也保留原始内容放回，只额外挂上标记字段不可行（数组不能带键），
  // 因此这里改为保留原值到旁路键，避免静默丢数据。
  const isPlainObject = data.password_manager && typeof data.password_manager === 'object'
    && !Array.isArray(data.password_manager)
  const passwordManager = isPlainObject ? { ...data.password_manager } : {}
  const salvaged = isPlainObject ? {} : (data.password_manager === undefined ? {} : { password_manager_original: data.password_manager })
  const previous = typeof passwordManager.os_password_last_changed === 'string'
    ? passwordManager.os_password_last_changed
    : null
  // 已有合法字符串就不动它：Chromium 会自己把它改写成新值，我们再覆盖回哨兵值反而会误导它重新探测。
  if (previous !== null) {
    return { dir: target, file, written: false, created: !existed, recovered: wasRecovered, previous }
  }
  passwordManager.os_password_last_changed = OS_PASSWORD_LAST_CHANGED_SENTINEL
  if (passwordManager.os_password_blank === undefined) passwordManager.os_password_blank = false
  const next = { ...data, ...salvaged, password_manager: passwordManager }
  // 原子写：临时文件 + rename，避免写到一半被读到半份 JSON。
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  return { dir: target, file, written: true, created: !existed && !wasRecovered, recovered: wasRecovered, previous }
}

/**
 * 读回 `os_password_last_changed`（哨兵值法的判据入口）。
 * @param {string} [dir] - profile 目录
 * @returns {string|null} 当前值；字段缺失或不是字符串时返回 null
 */
export function readOsPasswordLastChanged(dir = resolveBrowserProfileDir()) {
  const { data } = readLocalState(resolve(dir))
  const value = data.password_manager?.os_password_last_changed
  return typeof value === 'string' ? value : null
}

/**
 * 显式重置 profile（仅供测试与幂等场景；生产路径不调用）。
 * @param {string} [dir] - profile 目录
 * @returns {boolean} 是否真的删掉了
 */
export function resetBrowserProfile(dir = resolveBrowserProfileDir()) {
  const target = resolve(dir)
  if (!existsSync(target)) return false
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 原子写文本文件：同目录临时文件 + rename。 */
function writeAtomic(file, text) {
  const temp = join(dirname(file), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
}
