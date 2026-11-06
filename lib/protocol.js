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
