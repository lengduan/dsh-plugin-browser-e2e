/**
 * 浏览器载体探测（功能规格 0034-multi-carrier.md，方案 B1）。
 *
 * 只回答一个问题：隔离模式本次该用哪个本机 Chromium 内核浏览器。
 * - `edge`：直接用 Playwright 的 `channel: 'msedge'`，不探测可执行文件（与既有行为零差异）；
 * - `chrome`：按「环境变量 → PATH → 平台惯例安装位置」三级顺序找 Google Chrome；
 * - `auto`：先按 chrome 探测，找不到回退 edge。
 *
 * 工具参数只接受这三种枚举，不接受任意可执行路径；路径只来自 `DSH_BROWSER_CHROME_PATH`
 * 与平台惯例位置（这是本项的安全取舍）。
 *
 * 探测函数接收注入的 env / platform，纯查文件、不启浏览器，因此可以在测试里构造假环境。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** 载体取值全集。 */
export const CARRIERS = ['edge', 'chrome', 'auto']

/** 载体缺省值。 */
export const DEFAULT_CARRIER = 'edge'

/** 中文展示名（摘要与错误文案共用）。 */
export const CARRIER_LABELS = { edge: '系统 Edge', chrome: '系统 Chrome', auto: '自动' }

/**
 * 载体的中文展示名；未知值按 edge 处理（调用方入口已做非法值校验，这里只做缺省归一）。
 * @param {string} carrier - 载体
 * @returns {string} 展示名
 */
export function carrierLabel(carrier) {
  return CARRIER_LABELS[carrier] ?? CARRIER_LABELS.edge
}

/** 判断一个路径是不是存在的文件；探测失败一律按不存在处理，不抛错。 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** PATH 环境变量按平台分隔符拆成目录列表；空段丢弃。 */
function pathDirectories(env, platform) {
  // Windows 允许 PATH 与 Path 两种写法，读环境变量时不区分大小写但对象键区分。
  const raw = env.PATH ?? env.Path ?? (platform === 'win32' ? env.path : undefined) ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  return String(raw).split(separator).filter((dir) => dir.trim() !== '')
}

/**
 * Chrome 候选清单：按探测顺序列出名称与展开后的绝对路径。
 *
 * 错误文案与探测共用这一份，因此「查过哪些位置」不会与实际查找顺序脱节。
 * @param {object} env - 环境变量（默认真实 process.env，测试可注入）
 * @param {string} platform - 平台标识（默认 process.platform）
 * @returns {Array<{name: string, path: string}>}
 */
function chromeCandidates(env, platform) {
  const candidates = []
  const override = typeof env.DSH_BROWSER_CHROME_PATH === 'string' ? env.DSH_BROWSER_CHROME_PATH.trim() : ''
  if (override) candidates.push({ name: '环境变量 DSH_BROWSER_CHROME_PATH', path: override })
  const executable = platform === 'win32' ? 'chrome.exe' : 'chrome'
  for (const dir of pathDirectories(env, platform)) {
    candidates.push({ name: 'PATH 上的 chrome', path: join(dir, executable) })
  }
  if (platform === 'win32') {
    const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter((base) => typeof base === 'string' && base.trim() !== '')
    for (const base of bases) {
      candidates.push({ name: '平台惯例安装位置', path: join(base, 'Google', 'Chrome', 'Application', 'chrome.exe') })
    }
  } else if (platform === 'darwin') {
    candidates.push({ name: '平台惯例安装位置', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  } else {
    for (const path of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome']) {
      candidates.push({ name: '平台惯例安装位置', path })
    }
  }
  return candidates
}

/**
 * 「本次实际检查过的位置」的可读清单：名称 + 绝对路径，供错误文案与诊断使用。
 * @param {'edge'|'chrome'} kind - 载体种类
 * @param {object} [env] - 环境变量
 * @param {string} [platform] - 平台标识
 * @returns {string} 清单文本（无候选时为「（无候选路径）」）
 */
export function searchSummary(kind, env = process.env, platform = process.platform) {
  if (kind !== 'chrome') return 'Playwright channel msedge（不探测可执行文件）'
  const candidates = chromeCandidates(env, platform)
  if (candidates.length === 0) return '（无候选路径）'
  return candidates.map((candidate) => `${candidate.name} ${candidate.path}`).join('、')
}

/**
 * 解析载体：返回实际落地的种类与（Chrome 的）可执行文件路径。
 *
 * `edge` 不探测文件——避免把用户安装的 Edge Beta 当稳定版；`auto` 探测 Chrome，
 * 找不到就回退 Edge，不报错；显式 `chrome` 找不到时报可诊断错误（文案列出查过的位置）。
 * @param {'edge'|'chrome'|'auto'} carrier - 请求的载体
 * @param {object} [env] - 环境变量
 * @param {string} [platform] - 平台标识
 * @returns {{kind: 'edge'|'chrome', executablePath?: string}} 解析结果
 */
export function detectCarrier(carrier, env = process.env, platform = process.platform) {
  const requested = CARRIERS.includes(carrier) ? carrier : DEFAULT_CARRIER
  if (requested === 'edge') return { kind: 'edge' }
  const found = chromeCandidates(env, platform).find((candidate) => isFile(candidate.path))
  if (found) return { kind: 'chrome', executablePath: found.path }
  if (requested === 'auto') return { kind: 'edge' }
  throw new Error(`本机没有找到 Google Chrome（查过：${searchSummary('chrome', env, platform)}）；`
    + '请安装 Chrome、在插件设置里把 defaultCarrier 改为 edge，或设置 DSH_BROWSER_CHROME_PATH 指向 chrome.exe')
}
