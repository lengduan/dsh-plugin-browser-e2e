/**
 * 用户 Profile 复制（功能规格 0039-cdp-profile-copy.md）。
 *
 * 只做三件事：定位默认 Edge User Data、把登录态与扩展复制到指定目录、清理副本。
 * 不启动浏览器、不碰 CDP —— 启动与接管在 session.js。
 *
 * 复制白名单是「最小可登录 + 可带扩展」集合：登录态（Local State / Preferences /
 * Secure Preferences / Cookies / Login Data / Web Data / Bookmarks / Local Storage）
 * 加上扩展本体与扩展配置（Extensions / Local Extension Settings / Extension State 等）。
 * 缓存类目录（Cache / Code Cache / Service Worker / GPUCache）不复制，避免 GB 级拷贝。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 相对 User Data 的复制文件清单。 */
const COPY_FILES = [
  'Local State',
  'First Run',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Login Data',
  'Default/Web Data',
  'Default/Bookmarks',
  'Default/Network/Cookies',
]

/** 相对 User Data 的复制目录清单。 */
const COPY_DIRS = [
  'Default/Local Storage',
  'Default/Extensions',
  'Default/Local Extension Settings',
  'Default/Extension State',
  'Default/Extension Rules',
  'Default/Extension Scripts',
  'Default/Sync Extension Settings',
]

/** 判断路径是否为存在目录。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 判断路径是否为存在文件。 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 系统 Edge 的默认 User Data 目录。
 *
 * 只给平台惯例位置，不接受任意路径；调用方可用 `cdpProfileSource` 覆盖。
 * @param {object} [env] - 环境变量（默认 process.env，测试可注入）
 * @param {string} [platform] - 平台标识（默认 process.platform）
 * @returns {string} User Data 目录的绝对路径
 */
export function defaultEdgeUserDataDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (!local) throw new Error('无法定位 Edge 用户数据目录：LOCALAPPDATA 为空；请用 cdpProfileSource 显式指定')
    return join(local, 'Microsoft', 'Edge', 'User Data')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Microsoft Edge')
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'microsoft-edge')
}

/**
 * 解析并校验源 profile 目录。
 * @param {object} options - { sourceDir, env, platform }
 * @returns {string} 源目录绝对路径
 */
export function resolveProfileSource(options = {}) {
  const { sourceDir, env = process.env, platform = process.platform } = options
  const source = typeof sourceDir === 'string' && sourceDir.trim()
    ? resolve(sourceDir.trim())
    : defaultEdgeUserDataDir(env, platform)
  if (!isDirectory(source)) {
    throw new Error(`profile 源目录不存在：${source}；请确认路径，或先关闭 Edge 后用 cdpProfileSource 指定`)
  }
  if (!isFile(join(source, 'Local State'))) {
    throw new Error(`profile 源目录不是 Edge User Data（缺少 Local State）：${source}`)
  }
  return source
}

/**
 * 复制源 profile 的登录态与扩展到目标目录。
 *
 * 源目录被运行中的 Edge 占用时，复制会以 EACCES / EBUSY / EPERM 失败；
 * 统一转成「请先完全关闭 Edge」的可诊断错误，不复制半份数据。
 * @param {object} options - { sourceDir, targetDir }
 * @returns {{source: string, target: string, files: number, dirs: number}}
 */
export function copyUserProfile({ sourceDir, targetDir }) {
  const source = resolve(sourceDir)
  const target = resolve(targetDir)
  if (existsSync(target)) {
    throw new Error(`profile 副本目录已存在：${target}；请换一个 cdpProfileDir，或先删除该目录`)
  }
  mkdirSync(join(target, 'Default', 'Network'), { recursive: true })
  let files = 0
  let dirs = 0
  try {
    for (const relative of COPY_FILES) {
      const from = join(source, relative)
      if (!isFile(from)) continue
      mkdirSync(dirname(join(target, relative)), { recursive: true })
      cpSync(from, join(target, relative))
      files += 1
    }
    for (const relative of COPY_DIRS) {
      const from = join(source, relative)
      if (!isDirectory(from)) continue
      cpSync(from, join(target, relative), { recursive: true })
      dirs += 1
    }
  } catch (error) {
    // 复制失败不留下半份副本：里面可能有明文凭据。
    rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
    const code = error?.code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error(`复制 profile 失败（${code}）：源目录正被运行中的 Edge 占用，请先完全关闭 Edge 再重试；`
        + `源目录：${source}`)
    }
    throw new Error(`复制 profile 失败：${error?.message ?? error}`)
  }
  return { source, target, files, dirs }
}

/**
 * 删除副本目录；删不掉（进程仍占用）时返回 false，不抛错。
 * @param {string} targetDir - 副本目录
 * @returns {boolean} 是否已删除
 */
export function removeUserProfileDir(targetDir) {
  try {
    rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    return true
  } catch {
    return false
  }
}

/**
 * 生成缺省副本目录（系统临时目录下）。
 * @returns {string} 绝对路径
 */
export function defaultProfileCopyDir() {
  return join(tmpdir(), 'dsh-browser-e2e-cdp', `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}
