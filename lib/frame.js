/**
 * 页面 frame 定位（快照与交互工具共用同一份实现）。
 *
 * `browser_e2e_snapshot` 与 `browser_e2e_click` / `browser_e2e_fill` / `browser_e2e_scroll`
 * 的 `frame` 参数必须按同一套规则解析：整数 0 为主文档、n ≥ 1 为本次调用 `page.frames()`
 * 过滤主文档后的第 n 个；字符串先按 `frame.name()` 精确匹配、无命中再按 `frame.url()`
 * 子串匹配；多命中要求改用索引；每次调用重新取列表，索引只对本次调用有效。
 *
 * 本模块只做定位与文案，不做同源检查（跨源支持与否由调用方决定）：
 * 快照仍只读同源 iframe，交互工具按实测结论支持跨源。
 *
 * @module dsh-browser-e2e/lib/frame
 */

/**
 * 主文档固定索引 0，其余按 `page.frames()` 顺序过滤主文档后从 1 编号。
 * @param {import('playwright-core').Page} page - 页面对象
 * @returns {import('playwright-core').Frame[]}
 */
export function frameListOf(page) {
  const main = page.mainFrame()
  return [main, ...page.frames().filter((frame) => frame !== main)]
}

/**
 * 把 frame 列表渲染成 `0（主文档）、1（"name"，url）…` 形式的可用索引。
 * @param {import('playwright-core').Frame[]} frames - frame 列表
 * @returns {string}
 */
export function describeFrames(frames) {
  return frames.map((frame, index) => (index === 0
    ? '0（主文档）'
    : `${index}（"${frame.name()}"，${frame.url()}）`)).join('、')
}

/**
 * 生成 frame 的对外信息形状，与快照返回的 `frame` 字段同形。
 * @param {import('playwright-core').Frame[]} frames - frame 列表
 * @param {import('playwright-core').Frame} frame - 目标 frame
 * @param {number} index - 目标 frame 在列表中的索引
 * @returns {{index: number, name: string, url: string, parentIndex: number|null}}
 */
export function frameInfoOf(frames, frame, index) {
  if (index === 0) return { index: 0, name: frame.name(), url: frame.url(), parentIndex: null }
  const parent = frame.parentFrame()
  const parentIndex = parent ? frames.indexOf(parent) : -1
  return {
    index,
    name: frame.name(),
    url: frame.url(),
    parentIndex: parentIndex >= 0 ? parentIndex : null,
  }
}

/**
 * 解析 `frame` 参数。
 *
 * 文案与判据与快照完全一致；调用方负责同源 / 跨源等额外限制。
 * @param {import('playwright-core').Frame[]} frames - 本次调用重新取的 frame 列表
 * @param {number|string|undefined|null} frameArg - 工具参数里的 frame
 * @returns {{frame: import('playwright-core').Frame, index: number, info: object}}
 */
export function resolveFrame(frames, frameArg) {
  let index = 0
  if (frameArg !== undefined && frameArg !== null) {
    if (typeof frameArg === 'number') {
      if (!Number.isInteger(frameArg) || frameArg < 0) {
        throw new Error(`frame 必须是 0 或正整数（0 为主文档），收到 ${frameArg}`)
      }
      index = frameArg
    } else if (typeof frameArg === 'string') {
      const value = frameArg
      const candidates = frames.map((frame, idx) => ({ frame, idx })).filter(({ idx }) => idx > 0)
      if (value.length === 0) throw new Error(`frame 未找到：当前页可用索引 ${describeFrames(frames)}`)
      const byName = candidates.filter(({ frame }) => frame.name() !== '' && frame.name() === value)
      let matched = byName
      if (matched.length === 0) {
        matched = candidates.filter(({ frame }) => frame.url().includes(value))
      }
      if (matched.length === 1) {
        index = matched[0].idx
      } else if (matched.length > 1) {
        throw new Error(`frame "${value}" 命中 ${matched.length} 个（索引 ${matched.map(({ idx }) => idx).join('、')}），请改用 frame 索引`)
      } else {
        throw new Error(`frame "${value}" 未找到：当前页可用索引 ${describeFrames(frames)}`)
      }
    } else {
      throw new Error(`frame 必须是 0 或正整数（0 为主文档），收到 ${String(frameArg)}`)
    }
  }
  if (index >= frames.length) {
    throw new Error(`frame 索引 ${index} 不存在：当前页共 ${frames.length} 个 frame（${describeFrames(frames)}），请重新 browser_e2e_snapshot 查看`)
  }
  return { frame: frames[index], index, info: frameInfoOf(frames, frames[index], index) }
}

/**
 * 交互工具的目标 frame：`frame` 缺省或为 0 时返回 null（主文档），否则解析出子 frame。
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {number|string|undefined|null} frameArg - 工具参数里的 frame
 * @returns {{frame: import('playwright-core').Frame, index: number, info: object}|null}
 */
export function actionFrameOf(page, frameArg) {
  if (frameArg === undefined || frameArg === null) return null
  if (frameArg === 0) return null
  const { frame, index, info } = resolveFrame(frameListOf(page), frameArg)
  return index === 0 ? null : { frame, index, info }
}
