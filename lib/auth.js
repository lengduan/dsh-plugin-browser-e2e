/**
 * 鉴权补票（本机 DSH GUI）。
 *
 * 导航后如果页面落在登录挑战（标题或正文含 authentication required）且目标为 loopback
 * http(s)，就向宿主 connection 服务要一条带 launch-token 的地址并重试一次；每个 tab
 * 每次导航只重试一次。取不到服务 / 拿不到地址 / 重试失败都静默保持原导航结果，不抛错。
 *
 * 单独成文件的原因：可以整体删除而不影响其它能力（删除测试）。
 */
import { isLoopbackHostname } from './fence.js'

/** 登录挑战的识别词（页面标题或正文命中即视为需要补票）。 */
const AUTH_CHALLENGE_PATTERN = /authenticat(e|ion)\s+required/i

/** 登录探测只读正文开头这一段，避免大页面拖慢导航。 */
const AUTH_PROBE_TEXT_LIMIT = 4000

/** 外部注入的 connection 读取器；宿主没有该服务时保持 null，补票静默跳过。 */
let connectionResolver = null

/**
 * 注入 connection 服务读取器。
 *
 * 由 index.js 传入 `() => ctx.get('connection')`：读取发生在导航时，因此 connection
 * 服务晚于插件加载也没关系；读不到就返回 undefined，静默跳过。
 * @param {(() => unknown) | null} resolver - 读取器；null 表示关闭补票
 */
export function setConnectionResolver(resolver) {
  connectionResolver = typeof resolver === 'function' ? resolver : null
}

/** 目标地址是否 loopback http(s)（只有这种目标值得补票）。 */
function isLoopbackTarget(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

/** 页面是否落在 DSH 的登录挑战页上（标题或正文命中识别词）。 */
async function isAuthChallenge(page) {
  try {
    const probe = await page.evaluate((limit) => ({
      title: document.title || '',
      text: (document.body?.innerText || '').slice(0, limit),
    }), AUTH_PROBE_TEXT_LIMIT)
    return AUTH_CHALLENGE_PATTERN.test(String(probe.title)) || AUTH_CHALLENGE_PATTERN.test(String(probe.text))
  } catch {
    return false
  }
}

/**
 * 命中登录挑战时向 connection 服务要一条带 launch-token 的地址并重试一次。
 * @param {import('playwright-core').Page} page - 当前页面
 * @param {string} url - 原始目标地址
 * @returns {Promise<import('playwright-core').Response | null>} 重试的响应，失败为 null
 */
export async function tryAuthTopUp(page, url) {
  if (!isLoopbackTarget(url)) return null
  if (typeof connectionResolver !== 'function') return null
  let connection
  try {
    connection = connectionResolver()
  } catch {
    return null
  }
  if (!connection || typeof connection.authenticatedUrl !== 'function') return null
  let authenticated
  try {
    authenticated = connection.authenticatedUrl(url)
  } catch {
    return null
  }
  if (typeof authenticated !== 'string' || authenticated.length === 0 || authenticated === url) return null
  try {
    return await page.goto(authenticated, { waitUntil: 'load', timeout: 30000 })
  } catch {
    return null
  }
}

/**
 * 导航后是否需要补票，并在需要时补一次。
 * @param {import('playwright-core').Page} page - 当前页面
 * @param {string} url - 原始目标地址
 * @param {import('playwright-core').Response} response - goto 的响应
 * @returns {Promise<{response: import('playwright-core').Response, retried: boolean}>}
 */
export async function topUpIfChallenged(page, url, response) {
  if (!(await isAuthChallenge(page))) return { response, retried: false }
  const retried = await tryAuthTopUp(page, url)
  if (!retried) return { response, retried: false }
  return { response: retried, retried: true }
}
