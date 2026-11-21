/**
 * 动画抑制：页内动态守护与撤守（功能规格 0040）。
 *
 * 变化原因只有一条：让页面上的动画在任何时刻都不持续消耗 CPU。因此本模块只做三件事——
 * 装守护、撤守护、查状态；开关字段（`session.freezeAnimations`）留在会话层，遍历标签页也在会话层，
 * 钩子接线在 `page.js`。本模块不认识会话、不认识标签页注册表，也不写事件环 / ref 表 / 快照基线。
 *
 * 页内脚本四件套（缺一不可，实测依据见 docs/需求-动画动态守护.md 第 1 节）：
 * 1. 幂等样式守卫 `#dsh-e2e-freeze`：`animation:none!important` 覆盖声明式动画（含后挂既有 class 的新元素）；
 * 2. `Element.prototype.animate` patch：后建 WAAPI 动画在返回前就被 `pause()`，内存里的 Animation 不受样式约束；
 * 3. 周期 sweep：兜住 `new Animation(...)` 直接构造与页面自插更高优先级的 `!important` 样式，并自愈被删掉的样式；
 * 4. 撤销路径：撤样式、还原原型、清定时器、删哨兵。
 *
 * 只覆盖主文档：`addInitScript` 在每个 frame 都执行，脚本首行自带 frame 判定，子 frame 与跨源 iframe 一律不 patch。
 *
 * 依赖方向：本模块不 import 任何内部模块（无回指）；`page.js` 与 `session.js` 单向调用它。
 */
/** 样式守卫的节点 id：页面删掉后 sweep 会按它补回，撤守时按它移除。 */
export const ANIMATION_GUARD_STYLE_ID = 'dsh-e2e-freeze'

/** 全量复查间隔（毫秒）：250ms 是 1512 节点下 0.039ms/次实测开销与拉锯窗口的折中。 */
export const GUARD_SWEEP_INTERVAL_MS = 250

/** 页内哨兵：幂等标记 + 撤销入口（`window.__dshE2eAnimGuard.state`）。 */
const GUARD_SENTINEL = '__dshE2eAnimGuard'

/**
 * 页内守护脚本（字符串 IIFE）。
 *
 * 既作 `page.addInitScript` 的 content（每次换文档无空窗注入），也作 `page.evaluate` 的补装脚本
 * （CDP 接管页、复用切换时对已 load 完的文档立刻生效）。脚本幂等：重复执行只补样式与 sweep。
 */
export const ANIMATION_GUARD_SCRIPT = `(() => {
  // 只覆盖主文档：addInitScript 在每个 frame 都执行，子 frame 与跨源 iframe 一律不 patch。
  if (window.top !== window) return { skipped: 'child-frame' }
  const STYLE_ID = '${ANIMATION_GUARD_STYLE_ID}'
  const SENTINEL = '${GUARD_SENTINEL}'
  const INTERVAL = ${GUARD_SWEEP_INTERVAL_MS}
  const existing = window[SENTINEL]
  if (existing && existing.state && existing.state.styleId === STYLE_ID) {
    // 幂等分支必须**只读**：不叠 interval、不二次 patch，也**不暂停动画**。
    // 这里曾经调的是 sweep()，而 sweep = ensureStyle + pauseAll，于是「再装一次」和
    // 「查询状态」（animationGuardState 走同一条路径）都会顺手把页面正在跑的动画暂停，
    // 名字叫查询却带写副作用。现在拆开：自愈只调 refreshStyle（纯 DOM 修复），
    // 暂停只由周期 sweep 与首次装机负责。
    existing.state.refreshStyle()
    return existing.state.report()
  }

  // 样式守卫必须容得下「document 还没建好」的时刻：addInitScript 在文档创建后、页面脚本运行前执行，
  // 那时 document.documentElement 与 document.head 都可能还是 null（实测 init 阶段两者皆 null，
  // 直接 appendChild 会抛 'Cannot read properties of null'，整段脚本中断、哨兵也留不下）。
  // 落点优先级：head → documentElement → 还没有就等 DOMContentLoaded 后补挂（并让 sweep 每轮重试）。
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return true
    const root = document.head || document.documentElement
    if (!root) return false
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'
    root.appendChild(style)
    return true
  }

  const pauseAll = () => {
    let paused = 0
    let total = 0
    for (const animation of document.getAnimations()) {
      total += 1
      const state = animation.playState
      // 只对 running / pending 下手：已 paused / finished / idle 的不动，避免替页面做决定。
      if (state !== 'running' && state !== 'pending') continue
      try { animation.pause(); paused += 1 } catch (error) { /* 已失效的动画忽略 */ }
    }
    return { paused, total }
  }

  const rawAnimate = Element.prototype.animate
  // patch 必须透明：返回同一个 Animation 对象（不包装、不复制），并保持包装函数的 name / length 与原函数一致。
  const patchedAnimate = function animate(...args) {
    const animation = rawAnimate.apply(this, args)
    try {
      const state = animation && animation.playState
      if (state === 'running' || state === 'pending') animation.pause()
    } catch (error) { /* 已失效的动画忽略 */ }
    return animation
  }
  Object.defineProperty(patchedAnimate, 'name', { value: rawAnimate.name, configurable: true })
  Object.defineProperty(patchedAnimate, 'length', { value: rawAnimate.length, configurable: true })

  const state = {
    styleId: STYLE_ID,
    rawAnimate,
    patchedAnimate,
    timer: null,
    ensureStyle,
    // refreshStyle：只做纯 DOM 自愈（样式被页面删掉时补回），绝不暂停动画。
    // 幂等分支与 animationGuardState 只读路径用它；要暂停请用 sweep。
    refreshStyle: () => ensureStyle(),
    // sweep：自愈 + 暂停全部 running / pending 动画。周期复查与首次装机用它。
    sweep: () => { ensureStyle(); pauseAll() },
    // report 只读：它是「查状态」，不负责收动画。
    // 早先这里调了 pauseAll()，有两个问题：① 装机的调用方都是先 sweep() 再 report()，
    // 那时动画已被暂停，pausedTotal 实测恒为 0，是个永远读不到真值的死字段；
    // ② 名字叫「查询」却会暂停动画，幂等查询（animationGuardState）因此带上副作用。
    // 现在改纯只读：running / total 直接数，pausedTotal 按当前 paused 数量如实统计。
    report: () => {
      const animations = document.getAnimations()
      return {
        ok: true,
        stylePresent: Boolean(document.getElementById(STYLE_ID)),
        patched: Element.prototype.animate === patchedAnimate,
        timerActive: state.timer !== null,
        running: animations.filter((animation) => animation.playState === 'running').length,
        total: animations.length,
        pausedTotal: animations.filter((animation) => animation.playState === 'paused').length,
      }
    },
    dispose: () => {
      // 撤销四步：清定时器 → 按 id 再查一次并移除样式（兜住页面复制的同名节点）
      // → 恒等比较后还原原型（绝不覆盖第三方 patch）→ 删哨兵。
      if (state.timer !== null) { clearInterval(state.timer); state.timer = null }
      for (const node of document.querySelectorAll('style#' + STYLE_ID)) {
        if (node.parentNode) node.parentNode.removeChild(node)
      }
      if (Element.prototype.animate === patchedAnimate) Element.prototype.animate = rawAnimate
      if (window[SENTINEL] === guard) delete window[SENTINEL]
      return { ok: true, disposed: true }
    },
  }

  ensureStyle()
  Element.prototype.animate = patchedAnimate
  state.timer = setInterval(() => { state.sweep() }, INTERVAL)
  const guard = { state }
  window[SENTINEL] = guard
  // init 阶段 document 还没建好时样式挂不上：DOMContentLoaded 后再补一次，其余交给周期 sweep 自愈。
  if (!document.getElementById(STYLE_ID)) {
    document.addEventListener('DOMContentLoaded', () => { state.sweep() }, { once: true })
  }
  state.sweep()
  return state.report()
})()`

/**
 * 页内只读查询脚本（字符串 IIFE）。
 *
 * 与 `ANIMATION_GUARD_SCRIPT` 的区别是**不装机、不暂停**：
 * - 没有哨兵（该文档从未装过守护）时直接返回 `installed: false`，不会替调用方把守护装上；
 * - 有哨兵时只调 `refreshStyle`（纯 DOM 自愈：样式被页面删掉就补回）再 `report`，
 *   绝不调用 `sweep` / `pauseAll`，所以查询前后页面 running 数不变。
 *
 * 这是 `animationGuardState` 的专用脚本：它被当作只读诊断使用，任何暂停副作用都不可接受。
 */
export const ANIMATION_GUARD_STATE_SCRIPT = `(() => {
  if (window.top !== window) return { skipped: 'child-frame' }
  const guard = window['${GUARD_SENTINEL}']
  if (!guard || !guard.state) {
    return {
      ok: true,
      installed: false,
      stylePresent: Boolean(document.getElementById('${ANIMATION_GUARD_STYLE_ID}')),
      patched: false,
      timerActive: false,
      running: document.getAnimations().filter((animation) => animation.playState === 'running').length,
      total: document.getAnimations().length,
      pausedTotal: document.getAnimations().filter((animation) => animation.playState === 'paused').length,
    }
  }
  // 只读：只做纯 DOM 自愈，不暂停任何动画。
  guard.state.refreshStyle()
  const report = guard.state.report()
  return { ...report, installed: true }
})()`

/**
 * 页内撤守脚本（字符串 IIFE）：调页内哨兵的 dispose，并报告撤守结果。
 *
 * 幂等：没有哨兵时返回 `disposed: false`（该文档从未装过守护，或已被撤过一次），不报错。
 */
export const ANIMATION_GUARD_DISPOSE_SCRIPT = `(() => {
  if (window.top !== window) return { skipped: 'child-frame' }
  const STYLE_ID = '${ANIMATION_GUARD_STYLE_ID}'
  const guard = window['${GUARD_SENTINEL}']
  const styleBefore = Boolean(document.getElementById(STYLE_ID))
  const patchedBefore = guard && guard.state ? Element.prototype.animate === guard.state.patchedAnimate : false
  if (guard && guard.state) guard.state.dispose()
  return {
    ok: true,
    disposed: Boolean(guard && guard.state),
    styleRemoved: styleBefore && !document.getElementById(STYLE_ID),
    patchedRestored: patchedBefore ? Element.prototype.animate !== (guard && guard.state ? guard.state.patchedAnimate : null) : false,
    timerCleared: Boolean(guard && guard.state) ? guard.state.timer === null : true,
    sentinelPresent: Boolean(window['${GUARD_SENTINEL}']),
  }
})()`

/**
 * 按 page 的守护句柄：值是 `{ disposable, installedAt }`。
 *
 * 用 WeakMap 而不是标签页条目字段：页对象关闭后无强引用、随 GC 回收，
 * `removePage` 与 `page.on('close')` 都不需要为此加代码（功能规格 0040「生命周期」）。
 */
const guards = new WeakMap()

/** 判断页面是否还能求值：已关闭的页直接返回失败，避免抛 Target closed。 */
function pageUsable(page) {
  if (!page || typeof page.evaluate !== 'function') return false
  return !(typeof page.isClosed === 'function' && page.isClosed())
}

/** 把异常归一成一行原因：调用方只用来写摘要与诊断，不解析。 */
function reasonOf(error) {
  return String(error?.message ?? error)
}

/**
 * 组装能力函数对外的状态形状：查询与装机/撤守共用同一份字段，避免三处各拼一套。
 * @param {object} evaluated - 页内脚本返回的原始结果
 * @param {boolean} installed - 本进程侧是否持有该页的守护句柄
 * @returns {object} 状态
 */
function stateOf(evaluated, installed) {
  return {
    ok: true,
    installed,
    stylePresent: evaluated.stylePresent === true,
    patched: evaluated.patched === true,
    timerActive: evaluated.timerActive === true,
    running: evaluated.running ?? 0,
    total: evaluated.total ?? 0,
    pausedTotal: evaluated.pausedTotal ?? 0,
  }
}

/**
 * 对一页装机动画守护；页面已关闭 / 求值失败都只记原因，不抛错。
 *
 * 两个动作缺一不可：`addInitScript` 保证换文档后无空窗重装（返回的 `Disposable` 存起来供撤守用），
 * `evaluate` 对**当前**文档立刻生效（已有文档不会重跑 init script）。
 * @param {import('playwright-core').Page} page - Playwright 页面
 * @returns {Promise<object>} `{ ok, installed, stylePresent, patched, timerActive, running, total, pausedTotal }` 或 `{ ok: false, error }`
 */
export async function installAnimationGuard(page) {
  if (!pageUsable(page)) return { ok: false, error: '页面已关闭' }
  try {
    const handle = guards.get(page)
    if (!handle) {
      // addInitScript 的返回值是 Disposable（playwright-core 1.63）：撤守第一步必须 dispose，
      // 否则撤了当前页也会在下次导航复活。
      const disposable = await page.addInitScript({ content: ANIMATION_GUARD_SCRIPT })
      guards.set(page, { disposable, installedAt: Date.now() })
    }
    const evaluated = await page.evaluate(ANIMATION_GUARD_SCRIPT)
    if (evaluated && evaluated.skipped) return { ok: true, skipped: evaluated.skipped, installed: false }
    return stateOf(evaluated ?? {}, true)
  } catch (error) {
    return { ok: false, error: reasonOf(error) }
  }
}

/**
 * 撤掉一页的动画守护（四步顺序固定，见功能规格 0040「关闭开关 = 真正撤守」）。
 *
 * 第一步 `disposable.dispose()` 不能省：不撤 `addInitScript` 时，撤守过的页下次导航又会装上守护。
 * 第二步页内脚本清定时器、移除样式、还原原型。第三步删句柄。每步失败只记原因，不阻断后续步骤。
 * @param {import('playwright-core').Page} page - Playwright 页面
 * @returns {Promise<object>} `{ ok, disposed, styleRemoved, patchedRestored, timerCleared, disposeError }`
 */
export async function uninstallAnimationGuard(page) {
  if (!pageUsable(page)) return { ok: false, error: '页面已关闭' }
  const handle = guards.get(page)
  let disposeError = null
  if (handle?.disposable) {
    try {
      await handle.disposable.dispose()
    } catch (error) {
      // dispose 失败（页已关闭 / 已在别处撤过）只记原因：不能因此跳过后面的页内撤守。
      disposeError = reasonOf(error)
    }
  }
  try {
    const evaluated = await page.evaluate(ANIMATION_GUARD_DISPOSE_SCRIPT)
    guards.delete(page)
    if (evaluated && evaluated.skipped) {
      return { ok: true, skipped: evaluated.skipped, disposed: false, styleRemoved: false, patchedRestored: false, timerCleared: true, disposeError }
    }
    return {
      ok: true,
      disposed: evaluated?.disposed === true,
      styleRemoved: evaluated?.styleRemoved === true,
      patchedRestored: evaluated?.patchedRestored === true,
      timerCleared: evaluated?.timerCleared !== false,
      disposeError,
    }
  } catch (error) {
    guards.delete(page)
    return { ok: false, error: reasonOf(error), disposeError }
  }
}

/**
 * 查询一页的守护状态：**纯只读，绝不暂停动画**。
 *
 * 语义边界（这条是硬要求）：`animationGuardState` 常被当作只读诊断使用，
 * 调用前后页面的 running 动画数必须完全不变。因此它**不走** `installAnimationGuard`：
 * - 装机路径会 `addInitScript` + `sweep()`（后者会 pauseAll），那是写操作；
 * - 这里只执行 `ANIMATION_GUARD_STATE_SCRIPT`：未装则如实返回 `installed: false`（不替调用方装），
 *   已装则只做纯 DOM 自愈（`refreshStyle`，把被页面删掉的样式补回）再读数，不暂停任何动画。
 *
 * 「查询即确保已装」的旧说法已作废：确保的是**样式在位**，不是「替调用方装机」，更不是暂停动画。
 * 要装机请显式调 `installAnimationGuard`。
 * @param {import('playwright-core').Page} page - Playwright 页面
 * @returns {Promise<object>} `{ ok, installed, stylePresent, patched, timerActive, running, total, pausedTotal }` 或 `{ ok: false, error }`
 */
export async function animationGuardState(page) {
  if (!pageUsable(page)) return { ok: false, error: '页面已关闭' }
  try {
    const evaluated = await page.evaluate(ANIMATION_GUARD_STATE_SCRIPT)
    if (evaluated && evaluated.skipped) return { ok: true, skipped: evaluated.skipped, installed: false }
    return {
      ok: true,
      installed: evaluated?.installed === true,
      stylePresent: evaluated?.stylePresent === true,
      patched: evaluated?.patched === true,
      timerActive: evaluated?.timerActive === true,
      running: evaluated?.running ?? 0,
      total: evaluated?.total ?? 0,
      pausedTotal: evaluated?.pausedTotal ?? 0,
    }
  } catch (error) {
    return { ok: false, error: reasonOf(error) }
  }
}
