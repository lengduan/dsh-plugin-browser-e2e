/**
 * 人机协同等待：页内人机验证探测与轮询判定。
 *
 * 两个能力：`humanCheck` 非阻塞探测当前页有没有人机验证（结构选择器 + 文本兜底），
 * `waitForHuman` 把页面交给用户、轮询到「验证消失 + 可选完成信号出现」，超时返回
 * `resolved:false` 而不是抛错（人工步骤到点未完成是预期结果，与 `browser_e2e_wait` 口径不同）。
 *
 * 只读：不写 ref 表、快照基线、事件环，不改 activeTabId；不 import 会话层，只依赖 page.js 的 currentTab。
 */
import { currentTab } from './page.js'

/** 单次人工等待的默认上限（毫秒）。 */
export const HUMAN_TIMEOUT_MS_DEFAULT = 60000

/** 单次人工等待允许的最小上限（毫秒）。 */
export const HUMAN_TIMEOUT_MS_MIN = 5000

/** 单次人工等待允许的最大上限（毫秒）；低于默认空闲回收 600000，避免等待期间浏览器被回收。 */
export const HUMAN_TIMEOUT_MS_MAX = 300000

/** 轮询间隔默认值（毫秒）；人机步骤是秒级时间尺度，不必像 wait 那样 100ms。 */
export const HUMAN_POLL_MS_DEFAULT = 1500

/** 轮询间隔下限（毫秒）。 */
export const HUMAN_POLL_MS_MIN = 250

/** 轮询间隔上限（毫秒）。 */
export const HUMAN_POLL_MS_MAX = 10000

/** reason 空白折叠后保留的字符数。 */
export const HUMAN_REASON_LIMIT = 200

/** 文本兜底读取的页面可见文本上限（字符）。 */
export const HUMAN_TEXT_LIMIT = 120000

/** 结构检测分组：按顺序逐组尝试，命中第一组即返回该组 kind。 */
const HUMAN_PROBE_GROUPS = [
  ['hcaptcha', ['iframe[src*="hcaptcha"]', '.h-captcha']],
  ['turnstile', ['iframe[src*="turnstile"]', '.cf-turnstile']],
  ['cloudflare', ['iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form']],
  ['recaptcha', ['iframe[src*="recaptcha"]', '.g-recaptcha', '[data-sitekey]:not(.h-captcha):not(.cf-turnstile)']],
  ['captcha', ['#captcha', '.captcha']],
]

/** 文本兜底短语（正则源，大小写不敏感）。 */
const HUMAN_TEXT_PATTERNS = [
  'verify (that )?you are (a )?human',
  'i.?m not a robot',
  'confirm you.?re human',
  'your activity looks unusual',
  'checking your browser',
  'enable javascript and cookies to continue',
  '人机验证',
  '安全验证',
  '我是人类',
  '滑块验证',
  '拖动滑块',
  '按住滑块',
  '点击.{0,8}验证',
]

/**
 * 生成页内探测脚本：结构检测优先，未命中且 textScan 为真时做文本兜底。
 * 主机名是 loopback 时跳过文本检测（本机页面正文可能只是在讨论验证码，避免自指误报）。
 * @param {boolean} textScan - 是否读页面文本
 * @returns {string} 页面内立即执行的 IIFE 表达式
 */
function humanProbeScript(textScan) {
  return `(() => {
    const groups = ${JSON.stringify(HUMAN_PROBE_GROUPS)};
    for (const [kind, selectors] of groups) {
      for (const selector of selectors) {
        if (document.querySelector(selector)) {
          return { detected: true, kind, evidence: 'selector: ' + selector };
        }
      }
    }
    if (!${textScan ? 'true' : 'false'}) return { detected: false, kind: null, evidence: '' };
    const hostname = String(location.hostname || '').toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
      || hostname === '[::1]' || hostname.endsWith('.localhost');
    if (loopback) return { detected: false, kind: null, evidence: '' };
    const text = String((document.body && document.body.innerText) || '').slice(0, ${HUMAN_TEXT_LIMIT});
    const patterns = ${JSON.stringify(HUMAN_TEXT_PATTERNS)}.map((source) => new RegExp(source, 'i'));
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return { detected: true, kind: 'captcha', evidence: 'text: ' + String(match[0]).slice(0, 40) };
      }
    }
    return { detected: false, kind: null, evidence: '' };
  })()`
}

/** 校验 textScan：缺省 true，非布尔值直接报错。 */
function normalizeTextScan(value) {
  if (value === undefined || value === null) return true
  if (typeof value !== 'boolean') {
    throw new Error('textScan 必须是布尔值（true 读页面文本，false 只看 DOM 结构）')
  }
  return value
}

/** 校验 timeoutMs：缺省 60000，必须是 5000-300000 的整数。 */
function normalizeTimeoutMs(value) {
  const timeoutMs = value === undefined || value === null ? HUMAN_TIMEOUT_MS_DEFAULT : value
  if (!Number.isInteger(timeoutMs) || timeoutMs < HUMAN_TIMEOUT_MS_MIN || timeoutMs > HUMAN_TIMEOUT_MS_MAX) {
    throw new Error(`timeoutMs 必须是 ${HUMAN_TIMEOUT_MS_MIN}-${HUMAN_TIMEOUT_MS_MAX} 的整数，收到 ${timeoutMs}`)
  }
  return timeoutMs
}

/** 校验 pollMs：缺省 1500，必须是 250-10000 的整数。 */
function normalizePollMs(value) {
  const pollMs = value === undefined || value === null ? HUMAN_POLL_MS_DEFAULT : value
  if (!Number.isInteger(pollMs) || pollMs < HUMAN_POLL_MS_MIN || pollMs > HUMAN_POLL_MS_MAX) {
    throw new Error(`pollMs 必须是 ${HUMAN_POLL_MS_MIN}-${HUMAN_POLL_MS_MAX} 的整数，收到 ${pollMs}`)
  }
  return pollMs
}

/** 校验并归一 reason：缺省 confirm，空白折叠后截前 200 字符（超出截断不报错）。 */
function normalizeReason(value) {
  if (value === undefined || value === null) return 'confirm'
  if (typeof value !== 'string') {
    throw new Error('reason 必须是字符串（如 captcha / login / 2fa / confirm）')
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, HUMAN_REASON_LIMIT)
}

/** selector 归一：空串 / 纯空白 / 非字符串按未给处理。 */
function normalizeSelector(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/** 探测结果在页面不可读时包装成固定错误文案。 */
function humanCheckError(error) {
  return new Error(`检测人机验证失败：页面不可读（可能正在导航或已关闭）：${String(error?.message ?? error)}；请稍后重试`)
}

/** 等待期间会话已关闭（含空闲回收）。 */
function sessionClosedError() {
  return new Error('等待人工处理期间浏览器已关闭（可能是空闲回收），请重新 browser_e2e_start 后再试')
}

/** 等待期间目标标签页已关闭。 */
function tabClosedError(tabId) {
  return new Error(`等待人工处理期间标签页已关闭（${tabId}），请重新 browser_e2e_tabs 获取可用标签页`)
}

/** 睡眠指定毫秒。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 未完成时的可执行提示：headless 用户看不到窗口，必须先把窗口变可见。 */
function humanHint(headless) {
  if (headless === true) {
    return '仍未完成：当前浏览器是 headless 的（用户看不到窗口），请先 browser_e2e_close，再以 headless=false 重新 browser_e2e_start，或改用 cdp 模式接管可见浏览器；确认用户已完成验证后可再次调用 browser_e2e_wait_for_human。'
  }
  return '仍未完成：请确认用户已在浏览器窗口中完成验证，完成后可再次调用 browser_e2e_wait_for_human。'
}

/** 组装等待结果的固定摘要文案。 */
function waitSummary({ needed, resolved, reason, kind, selector, waitedMs, polls, probeErrors, detected }) {
  if (resolved) {
    const elapsed = `耗时 ${waitedMs}ms，轮询 ${polls} 次`
    if (needed) {
      return selector
        ? `等待人工处理完成：${reason}（${kind} 已消失，完成信号 ${selector} 已出现，${elapsed}）`
        : `等待人工处理完成：${reason}（${kind} 已消失，${elapsed}）`
    }
    return selector
      ? `等待完成：${reason}（未检测到人机验证，完成信号 ${selector} 已出现，${elapsed}）`
      : `无需等待：${reason}（未检测到人机验证，${elapsed}）`
  }
  const waited = `已等 ${waitedMs}ms，轮询 ${polls} 次`
  if (detected) return `等待人工处理超时：${reason}（仍检测到 ${kind}，${waited}）`
  if (probeErrors >= polls) return `等待人工处理超时：${reason}（页面探测全部失败，${waited}）`
  return `等待人工处理超时：${reason}（未检测到人机验证，但完成信号 ${selector} 未出现，${waited}）`
}

/**
 * 非阻塞探测当前标签页是否有人机验证。
 * @param {object} session - 会话状态
 * @param {{textScan?: boolean, tab_id?: string}} [options] - 工具入参
 * @param {string} [tabId] - 显式标签页 id（options.tab_id 优先）
 * @returns {Promise<{detected: boolean, kind: string|null, evidence: string, url: string, tabId: string, summary: string}>}
 */
export async function humanCheck(session, options = {}, tabId) {
  const textScan = normalizeTextScan(options?.textScan)
  const tab = currentTab(session, options?.tab_id ?? tabId)
  let result
  try {
    result = await tab.page.evaluate(humanProbeScript(textScan))
  } catch (error) {
    throw humanCheckError(error)
  }
  const detected = result?.detected === true
  const kind = detected ? (result?.kind ?? 'captcha') : null
  const evidence = detected ? String(result?.evidence ?? '') : ''
  return {
    detected,
    kind,
    evidence,
    url: tab.page.url(),
    tabId: tab.id,
    summary: detected ? `人机验证：检测到 ${kind}` : '人机验证：未检测到',
  }
}

/**
 * 把页面交给用户处理人机验证，轮询到「验证消失 + 可选完成信号出现」。
 * 超时返回 `resolved:false` 与可执行提示，不抛错；入参非法、等待期间关页 / 关浏览器才抛错。
 * @param {object} session - 会话状态
 * @param {{reason?: string, timeoutMs?: number, pollMs?: number, selector?: string, textScan?: boolean, tab_id?: string}} [options] - 工具入参
 * @param {string} [tabId] - 显式标签页 id（options.tab_id 优先）
 * @returns {Promise<object>} 见功能规格「输出与渲染」
 */
export async function waitForHuman(session, options = {}, tabId) {
  // 纯入参校验全部在发起页面调用之前完成。
  const reason = normalizeReason(options?.reason)
  const timeoutMs = normalizeTimeoutMs(options?.timeoutMs)
  const pollMs = normalizePollMs(options?.pollMs)
  const selector = normalizeSelector(options?.selector)
  const textScan = normalizeTextScan(options?.textScan)

  // 调用开始时解析一次标签页，等待期间不跟随 active tab 切换。
  const tab = currentTab(session, options?.tab_id ?? tabId)
  const page = tab.page
  const resolvedTabId = tab.id
  const probeScript = humanProbeScript(textScan)

  if (selector) {
    try {
      await page.locator(selector).count()
    } catch (error) {
      throw new Error(`selector 无法在等待开始前解析：${String(error?.message ?? error)}；请检查 CSS 选择器后重试`)
    }
  }

  const started = Date.now()
  const deadline = started + timeoutMs
  let polls = 0
  let probeErrors = 0
  let needed = false
  let detected = false
  let kind = null
  let lastProbeError = ''
  let resolved = false

  while (true) {
    if (session.state === 'closing' || session.state === 'closed') throw sessionClosedError()
    if (page.isClosed()) throw tabClosedError(resolvedTabId)
    polls += 1
    // 探针失败只记证据、本轮不参与判定：登录提交后的导航会让页面脚本短暂不可读。
    let observed = false
    try {
      const result = await page.evaluate(probeScript)
      observed = true
      detected = result?.detected === true
      if (detected) {
        needed = true
        kind = result?.kind ?? 'captcha'
      }
    } catch (error) {
      probeErrors += 1
      lastProbeError = String(error?.message ?? error).slice(0, 200)
    }
    if (observed) {
      let selectorReady = true
      if (selector) {
        try {
          selectorReady = (await page.locator(selector).count()) > 0
        } catch {
          // 页面正在导航时 count() 抛错，按本轮「未命中」处理。
          selectorReady = false
        }
      }
      if (!detected && selectorReady) {
        resolved = true
        break
      }
    }
    const now = Date.now()
    if (now >= deadline) break
    const wait = Math.min(pollMs, Math.max(0, deadline - now))
    if (wait > 0) await sleep(wait)
  }

  const waitedMs = Date.now() - started
  const headless = session.headless ?? null
  const summary = waitSummary({
    needed, resolved, reason, kind, selector, waitedMs, polls, probeErrors, detected,
  })
  const info = {
    needed,
    resolved,
    waitedMs,
    polls,
    probeErrors,
    detected,
    kind,
    url: page.url(),
    reason,
    selector,
    timeoutMs,
    pollMs,
    headless,
    tabId: resolvedTabId,
    summary,
  }
  if (!resolved) info.hint = humanHint(headless)
  if (probeErrors > 0) info.lastProbeError = lastProbeError
  return info
}
