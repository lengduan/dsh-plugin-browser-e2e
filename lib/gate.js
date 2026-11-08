/**
 * 工具级权限门控（功能规格 0023-tool-permission-gating.md）。
 *
 * 纯函数层：只读配置值与工具定义，不做 I/O、不碰会话状态。判定在 lib/index.js 的
 * execute 入口执行——被拒调用不进入 definition.run，因此不产生页面动作、不刷新
 * 空闲计时、不写会话 / 标签页状态。
 *
 * 定性只有三种：observe（不放发页面输入、不跑调用方脚本）、interact（向页面派发
 * 真实输入事件）、script（在页面上下文执行任意 JS）。定性写在 lib/tools.js 的每个
 * 工具定义上，本文件只读取，不维护第二份清单。
 *
 * @module dsh-browser-e2e/lib/gate
 */

/** 合法定性；缺失或非法一律按 interact 处理（最严）。 */
export const ACCESS_KINDS = ['observe', 'interact', 'script']

/** 只读档位与全权档位。 */
export const ACCESS_MODE_FULL = 'full'
export const ACCESS_MODE_READONLY = 'readonly'

/** wait 带 expression 条件时按脚本处理，其余按定义时的定性。 */
const WAIT_TOOL_NAME = 'browser_e2e_wait'

/**
 * 归一 `accessMode`：字段缺失取缺省 `full`；字段存在但不合法取更严的 `readonly`。
 *
 * 与 `0006-plugin-config-and-live-apply.md` 的「脏值逐字段回退默认」口径相反：
 * 门控项是安全向配置，「读不懂」不得解析为「允许」。
 * @param {unknown} raw - 配置里的原始值
 * @returns {{mode: 'full'|'readonly', illegal: boolean}}
 */
export function accessModeOf(raw) {
  if (raw === undefined || raw === null) return { mode: ACCESS_MODE_FULL, illegal: false }
  if (raw === ACCESS_MODE_FULL || raw === ACCESS_MODE_READONLY) return { mode: raw, illegal: false }
  return { mode: ACCESS_MODE_READONLY, illegal: true }
}

/**
 * 归一 `allowScript`：字段缺失取缺省 `true`；字段存在但非法取更严的 `false`。
 * @param {unknown} raw - 配置里的原始值
 * @returns {{allowScript: boolean, illegal: boolean}}
 */
export function allowScriptOf(raw) {
  if (raw === undefined || raw === null) return { allowScript: true, illegal: false }
  if (typeof raw === 'boolean') return { allowScript: raw, illegal: false }
  return { allowScript: false, illegal: true }
}

/**
 * 读取一个工具定义的定性；未定义或非法按 interact（将来新增工具忘了定性时默认被拒）。
 * @param {{access?: string}|undefined} definition - 工具定义
 * @returns {'observe'|'interact'|'script'}
 */
export function accessOf(definition) {
  const access = definition?.access
  return ACCESS_KINDS.includes(access) ? access : 'interact'
}

/**
 * 本次调用的有效定性：`browser_e2e_wait` 带非空 `expression` 条件时按 script 处理。
 * @param {{name?: string, access?: string}|undefined} definition - 工具定义
 * @param {object|undefined} args - 本次调用参数
 * @returns {'observe'|'interact'|'script'}
 */
export function effectiveAccess(definition, args) {
  const access = accessOf(definition)
  if (definition?.name === WAIT_TOOL_NAME && typeof args?.expression === 'string' && args.expression.trim() !== '') {
    return 'script'
  }
  return access
}

/**
 * 工具表里所有 observe 类工具的名字，供拒绝文案列出「只读模式可用的工具」。
 * @param {Array<{name: string, access?: string}>} table - 工具表
 * @param {(definition: object) => boolean} [filter] - 可选过滤
 * @returns {string[]}
 */
export function toolNamesWithAccess(table, kind) {
  return (table ?? []).filter((definition) => accessOf(definition) === kind).map((definition) => definition.name)
}

/** 由工具名拼出「browser_e2e_x / y / z」形式的清单文本。 */
function toolListText(names) {
  return (names ?? []).map((name) => name.replace(/^browser_e2e_/, 'browser_e2e_')).join(' / ')
}

/** 拒绝结果的统一形状。 */
function reject(summary, message) {
  return { allowed: false, summary, message }
}

/**
 * 门控判定。
 * @param {object} input - 判定输入
 * @param {{name: string, access?: string}} input.definition - 工具定义
 * @param {object|undefined} input.args - 本次调用参数
 * @param {'full'|'readonly'} input.accessMode - 归一后的档位
 * @param {boolean} input.allowScript - 归一后的脚本开关
 * @param {string[]} [input.observeNames] - 只读模式下可用的工具名清单（用于文案）
 * @returns {{allowed: true} | {allowed: false, summary: string, message: string}}
 */
export function decide({ definition, args, accessMode, allowScript, observeNames = [] }) {
  const access = effectiveAccess(definition, args)
  const name = definition?.name ?? 'browser_e2e_未知工具'
  const isWaitExpression = access === 'script' && accessOf(definition) === 'observe'

  if (accessMode === ACCESS_MODE_READONLY) {
    if (access === 'observe') return { allowed: true }
    if (isWaitExpression) {
      const summary = 'browser_e2e_wait 不接受 expression 条件（只读模式）'
      return reject(
        summary,
        `只读模式（插件设置 accessMode=readonly）：browser_e2e_wait 不接受 expression 条件（页面脚本可能改变 DOM）。`
          + '请改用 selector / url / response 条件；确需 expression，请把插件设置 accessMode 改为 full（保存后下一次调用即生效）。',
      )
    }
    if (access === 'script') {
      const summary = `${name} 会执行页面脚本（只读模式）`
      return reject(
        summary,
        `只读模式（插件设置 accessMode=readonly）：${name} 会在页面上下文执行任意脚本，可能改变页面与登录态，已拒绝执行。`
          + '需要读取页面请用 browser_e2e_snapshot；确需执行脚本，请把插件设置 accessMode 改为 full（保存后下一次调用即生效）。',
      )
    }
    const summary = `${name} 会向页面派发输入事件（只读模式）`
    return reject(
      summary,
      `只读模式（插件设置 accessMode=readonly）：${name} 会向页面派发真实输入事件，已拒绝执行。`
        + `只读模式可用的工具：${toolListText(observeNames)}。`
        + '如需操作页面，请把插件设置 accessMode 改为 full（保存后下一次调用即生效）。',
    )
  }

  if (!allowScript && access === 'script') {
    if (isWaitExpression) {
      const summary = 'browser_e2e_wait 不接受 expression 条件（脚本已关闭）'
      return reject(
        summary,
        '页面脚本求值已关闭（插件设置 allowScript=false）：browser_e2e_wait 不接受 expression 条件。'
          + '请改用 selector / url / response 条件，或把插件设置 allowScript 改为 true。',
      )
    }
    const summary = `${name} 会执行页面脚本（脚本已关闭）`
    return reject(
      summary,
      `页面脚本求值已关闭（插件设置 allowScript=false）：${name} 会在页面上下文执行任意脚本。`
        + '需要读取页面请用 browser_e2e_snapshot；确需执行脚本，请把插件设置 allowScript 改为 true（保存后下一次调用即生效）。',
    )
  }

  return { allowed: true }
}
