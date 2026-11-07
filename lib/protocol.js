/**
 * 面板协议契约的单一来源：路由路径、版本、关闭码，以及面板 tab id 的组合规则。
 *
 * host 半区（panel.js）与客户端 bundle（client/index.js）都从这张表取值，不再各写一份；
 * 客户端里需要的常量由 scripts/build-client.mjs 在构建时注入。
 *
 * 协议：客户端命令 attach / select-tab / close-tab / request-frame / configure；
 * 服务端事件 hello / state / frame / action / error；见 specs/项目规格/0002-panel-protocol-v1.md。
 */

/** 面板 socket 路径（挂到 GUI 同源）。 */
export const PANEL_SOCKET_PATH = '/api/dsh-browser-e2e/socket'

/** 面板状态路由路径（socket 连不上时的兜底探测）。 */
export const PANEL_STATE_PATH = '/api/dsh-browser-e2e/state'

/** 协议版本；host 与 client 必须一致。 */
export const PANEL_PROTOCOL_VERSION = 1

/** 协议不匹配时使用的关闭码。 */
export const PANEL_PROTOCOL_MISMATCH_CLOSE_CODE = 1002

/**
 * 客户端命令表：键是代码里用的短名，值是线上的命令名。
 * host 的命令分发与 client 的发送都从这张表取，未知命令按 invalid-command 回错误。
 */
export const PANEL_COMMANDS = Object.freeze({
  attach: 'attach',
  selectTab: 'select-tab',
  closeTab: 'close-tab',
  requestFrame: 'request-frame',
  configure: 'configure',
})

/** 服务端事件表：键是代码里用的短名，值是线上事件名。 */
export const PANEL_EVENTS = Object.freeze({
  hello: 'hello',
  state: 'state',
  frame: 'frame',
  action: 'action',
  error: 'error',
})

/**
 * 错误码表：error 事件 code 字段的唯一来源。
 * 键是代码里用的短名，值是线上的 code 字符串；host 从这里取，测试断言表外没有字面量。
 */
export const PANEL_ERROR_CODES = Object.freeze({
  invalidPayload: 'invalid-payload',
  protocolMismatch: 'protocol-mismatch',
  unknownTab: 'unknown-tab',
  lastTab: 'last-tab',
  closeTabFailed: 'close-tab-failed',
  noActiveTab: 'no-active-tab',
  captureFailed: 'capture-failed',
  invalidCommand: 'invalid-command',
  invalidConfig: 'invalid-config',
  stateFailed: 'state-failed',
  configSyncFailed: 'config-sync-failed',
  commandFailed: 'command-failed',
  screencastFailed: 'screencast-failed',
})

/** 面板设置可改的字段及其取值区间（非整数或越界一律拒绝）。 */
export const PANEL_CONFIG_LIMITS = Object.freeze({
  quality: Object.freeze([10, 100]),
  maxWidth: Object.freeze([100, 4096]),
  maxHeight: Object.freeze([100, 4096]),
  everyNthFrame: Object.freeze([1, 10]),
})

/** 投屏默认参数（面板设置卡片可改）。 */
export const DEFAULT_SCREENCAST_CONFIG = Object.freeze({
  quality: 70,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
})

/**
 * 事件名是否属于协议表（host 广播与 client 解析共用）。
 * @param {string} kind - 事件名
 * @returns {boolean}
 */
export function isPanelEvent(kind) {
  return Object.values(PANEL_EVENTS).includes(kind)
}

/**
 * 命令名是否属于协议表。
 * @param {string} kind - 命令名
 * @returns {boolean}
 */
export function isPanelCommand(kind) {
  return Object.values(PANEL_COMMANDS).includes(kind)
}

/**
 * 错误码是否属于协议表（host 与测试共用）。
 * @param {string} code - 线上错误码
 * @returns {boolean}
 */
export function isPanelErrorCode(code) {
  return Object.values(PANEL_ERROR_CODES).includes(code)
}

/**
 * 协议版本是否与 host 一致。
 * @param {unknown} version - 客户端声明的主版本
 * @returns {boolean}
 */
export function isSupportedProtocol(version) {
  return version === PANEL_PROTOCOL_VERSION
}

/** 面板 tab id 中「会话 key」与「页面 tab_id」的分隔符。 */
export const PANEL_TAB_SEPARATOR = '#'

/**
 * 组合面板 tab id：会话 key 与页面 tab_id，避免不同会话的同号 tab 撞车。
 * 组合规则是协议契约的一部分，host 与 client 必须用同一套。
 * @param {string} key - 会话 key
 * @param {string} tabId - 页面 tab_id
 * @returns {string} 面板 tab id
 */
export function panelTabId(key, tabId) {
  return `${key}${PANEL_TAB_SEPARATOR}${tabId}`
}

/**
 * 拆开面板 tab id：以最后一个分隔符为界，因此 key 或 tabId 自身含分隔符也能正确拆分。
 * @param {string} panelId - 面板 tab id
 * @returns {{key: string, tabId: string} | null} 格式不对返回 null
 */
export function parsePanelTabId(panelId) {
  if (typeof panelId !== 'string') return null
  const at = panelId.lastIndexOf(PANEL_TAB_SEPARATOR)
  if (at <= 0 || at === panelId.length - 1) return null
  return { key: panelId.slice(0, at), tabId: panelId.slice(at + 1) }
}
