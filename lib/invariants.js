/**
 * 跨调用不变量断言。
 *
 * 判据只有一条：违反它说明「跨多次调用积累的状态机、注册表或资源」处在不允许的组合，
 * 换一次调用不会自愈，必须修状态或重启。单次入参校验（参数类型、区间、互斥）留在各
 * 能力函数入口，不搬进来。
 *
 * 全部纯函数：只读传入参数，不读全局 Map，不做 I/O，不启动浏览器。因此这里可以也只
 * 应该被纯函数测试覆盖（tests/invariants.mjs）。每个断言都写明违反后果。
 */

/** 抛错信息统一从 Error 出来，保持与拆分前逐字一致（既有测试按文案子串断言）。 */
function fail(message) {
  throw new Error(message)
}

/**
 * 会话可用：存在且至少有一个标签页。
 * 违反后果：页面工具在 undefined 上取 page 属性，报 TypeError 而不是可读错误。
 * @param {object | undefined | null} session - 会话状态
 */
export function assertBrowserRunning(session) {
  if (!session || !session.pages || session.pages.size === 0) {
    fail('浏览器尚未启动，请先调用 browser_e2e_start')
  }
}

/**
 * 当前标签页可用：会话有 activeTabId 且指向一个存在的页。
 * 违反后果：缺省 tab_id 的调用作用在不存在的页上。
 * @param {object} session - 会话状态
 */
export function assertCurrentTabAvailable(session) {
  if (!session || session.activeTabId === null || session.activeTabId === undefined
    || !session.pages || !session.pages.get(session.activeTabId)) {
    fail('浏览器尚未启动或没有可用标签页，请先 browser_e2e_start')
  }
}

/**
 * 指定标签页存在。
 * 违反后果：对不存在的 tab 取页对象会操作错页，或把旧 ref 表写到另一页。
 * @param {object} session - 会话状态
 * @param {string} tabId - 标签页 id
 * @returns {object} 命中的标签页条目（调用方不必二次查表）
 */
export function assertTabExists(session, tabId) {
  const entry = session && session.pages ? session.pages.get(tabId) : undefined
  if (!entry) fail(`tab ${tabId} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`)
  return entry
}

/**
 * 最后一个标签页不可关闭。
 * 违反后果：会话失去全部页面，后续页面工具都报「尚未启动」；隔离模式下可再 start 补建，
 * CDP 模式需要用户在浏览器里自行新建标签页，因此默认拒绝而不是留一个 0 页会话。
 * @param {object} session - 会话状态
 */
export function assertCanCloseLastTab(session) {
  if (session.pages.size <= 1) {
    fail('这是最后一个标签页，不能关闭；如需结束整个浏览器请用 browser_e2e_close')
  }
}

/**
 * 启动与关闭并发时，启动流程必须立即停下。
 * 违反后果：在已关闭的浏览器上继续 newPage（Target page ... has been closed），
 * 或留下只建了一半的会话状态。
 * @param {object} session - 会话状态
 */
export function assertNotClosedDuringLaunch(session) {
  if (session.state === 'closing' || session.state === 'closed') {
    fail('浏览器已关闭（启动与关闭并发），请重新调用 browser_e2e_start')
  }
}

/**
 * 同一 key 的并发启动落定后必须有可复用实例。
 * 违反后果：后到的调用拿到半初始化会话，后续调用全部落空。
 * @param {object} session - 会话状态
 */
export function assertLaunchSettled(session) {
  if (!session.browser) {
    fail('浏览器启动失败（同一会话的并发启动未成功），请重试 browser_e2e_start')
  }
}

/**
 * 已启动的会话不允许热切换 mode。
 * 违反后果：隔离模式拉起的进程会被当成 CDP 连接关闭（或反之），进程泄漏或断不开。
 * @param {'isolated'|'cdp'} currentMode - 会话当前模式
 * @param {'isolated'|'cdp'} requestedMode - 本次请求的模式
 */
export function assertModeNotHotSwitched(currentMode, requestedMode) {
  if (requestedMode !== currentMode) {
    fail(`浏览器已启动（${currentMode} 模式）；如需切换为 ${requestedMode} 模式请先 browser_e2e_close`)
  }
}

/**
 * 已启动的会话不允许热切换 CDP 端点。
 * 违反后果：连到另一个浏览器，旧浏览器连接泄漏。
 * @param {string} currentEndpoint - 会话当前端点
 * @param {string} requestedEndpoint - 本次请求的端点
 */
export function assertEndpointNotHotSwitched(currentEndpoint, requestedEndpoint) {
  if (requestedEndpoint !== currentEndpoint) {
    fail(`浏览器已启动（CDP 端点 ${currentEndpoint}）；如需切换为 ${requestedEndpoint} 请先 browser_e2e_close`)
  }
}

/**
 * CDP 会话仍持有 context。
 * 违反后果：newPage 抛 Target closed，页面能力全部失效。
 * @param {object} session - 会话状态
 */
export function assertCdpConnected(session) {
  if (!session.context) {
    fail('CDP 浏览器连接已失效，请重新 browser_e2e_start')
  }
}

/**
 * 接管前置：浏览器至少要有一个 context。
 * 违反后果：接管得到空会话，后续所有工具都不可用。
 * @param {unknown} context - 浏览器 context
 */
export function assertCdpContext(context) {
  if (!context) fail('CDP 浏览器没有可用的 context')
}

/**
 * 接管前置：浏览器至少有一个已打开的标签页。
 * 违反后果：接管后没有页面可操作，工具报「尚未启动」。
 * @param {unknown[]} pages - context.pages()
 */
export function assertCdpHasPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    fail('CDP 浏览器没有已打开的标签页，无法接管')
  }
}

/**
 * ref 必须属于当前标签页的 ref 表（ref 按页隔离）。
 * 违反后果：切 tab 后旧 ref 落到另一页，按 xpath 点到错误元素。
 * @param {Map<string, object>} refs - 该标签页的 ref 表
 * @param {string} ref - 元素引用（@N）
 * @returns {object} 命中的 ref 条目
 */
export function assertRefBelongsToTab(refs, ref) {
  const item = refs.get(ref)
  if (!item) fail(`ref ${ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref`)
  return item
}

/**
 * snapshot 之后元素仍可点：xpath 命中且有可见尺寸。
 * 违反后果：按旧 xpath 点击会静默点空或点到别处，调用方误以为点击成功。
 * @param {string} ref - 元素引用
 * @param {{found: boolean, width: number, height: number}} check - 复验结果
 */
export function assertRefRevalidated(ref, check) {
  if (!check.found) fail(`ref ${ref} 已失效，请重新 browser_e2e_snapshot`)
  if (!(check.width > 0 && check.height > 0)) {
    fail(`ref ${ref} 已失效（当前尺寸 ${Math.round(check.width)}x${Math.round(check.height)}，不可见），请重新 browser_e2e_snapshot`)
  }
}

/**
 * 同一时刻只允许一个投屏会话。
 * 违反后果：两个 CDP 会话同时推帧，面板画面在两个页面间串台。
 * @param {unknown} activeCdp - 当前已持有的 CDP 会话；null 表示没有
 */
export function assertSingleScreencast(activeCdp) {
  if (activeCdp !== null && activeCdp !== undefined) {
    fail('同一时刻只能有一个投屏会话（违反后果：画面串台）')
  }
}
