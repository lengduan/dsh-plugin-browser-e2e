/**
 * 动画守护模块级验收（lib/animation-guard.js，功能规格 0040）。
 *
 * 与 tests/freeze.mjs 的分工：freeze.mjs 验「browser_e2e_start 的开关语义」，本文件只验模块本身——
 * 四件套、幂等、撤守彻底性、换文档重装、patch 透明性，以及「不扰动事件环与 ref 表」。
 *
 * 覆盖：
 *   - 未守护阴性对照：后建 CSS 动画 / 页面自插 !important / element.animate() 三路都 running >= 1；
 *   - 样式守卫：装机后 #dsh-e2e-freeze 存在，新元素挂既有 class 动画 running === 0；
 *   - 后插 !important：等一个 sweep 周期后 running === 0；
 *   - 后建 WAAPI：调用返回即 running === 0，返回对象 playState === 'paused' 且 instanceof Animation；
 *   - patch 透明性：name / length 与装机前一致、返回值未被包装；
 *   - 幂等：连续 install 三次只有一个 <style>、timerActive 仍为真；
 *   - 撤守：样式不存在、原型 === 原始函数、哨兵不存在、新造 WAAPI running >= 1、声明式动画自动恢复；
 *   - 换文档重装：navigate 与 reload 后 stylePresent === true 且造动画 running === 0；
 *   - 撤守后换文档不复活：撤守 → navigate → stylePresent === false、哨兵不存在；
 *   - 事件环与 ref 表不受扰：装机前后各一次 snapshot，第二次 delta 的 added / changed 均为 0；
 *   - CSP 降级：style-src 'self' 页面上「stylePresent 为真，或 running === 0」二选一。
 *
 * 真起无头 Edge；进程数断言以「回落到运行前基线」为准，不看绝对值。
 * 运行：node tests/animation-guard.mjs
 */
import { createServer as createHttpServer } from 'node:http'
import { countBrowserRoots } from './_process-count.mjs'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, sessionOf } = await import('../lib/session.js')
const { navigate } = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')
const { consoleEntries, networkEntries } = await import('../lib/observation.js')
const {
  ANIMATION_GUARD_DISPOSE_SCRIPT, ANIMATION_GUARD_SCRIPT, ANIMATION_GUARD_STYLE_ID, animationGuardState,
  GUARD_SWEEP_INTERVAL_MS, installAnimationGuard, uninstallAnimationGuard,
} = await import('../lib/animation-guard.js')

const KEY = 'test-animation-guard-key'
const SID = KEY
const liveSession = () => sessionOf(KEY, SID, { deferTouch: true })
const activeEntry = () => {
  const session = liveSession()
  return session.pages.get(session.activeTabId)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ONE_SWEEP_MS = GUARD_SWEEP_INTERVAL_MS + 50

/** 造 WAAPI 动画并读页内状态（与 freeze.mjs 同一段脚本，便于两份测试互相印证）。 */
const WAAPI_SCRIPT = `(() => {
  const el = document.createElement('div')
  el.id = 'guard-spin'
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  const animation = el.animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 1000, iterations: Infinity, easing: 'linear' },
  )
  return {
    playState: animation.playState,
    instanceOfAnimation: animation instanceof Animation,
    running: document.getAnimations().filter((a) => a.playState === 'running').length,
  }
})()`

/** 页面自插更高优先级的 !important 样式（patch 拦不到的路径之一）。 */
const INJECT_SCRIPT = `(() => {
  const style = document.createElement('style')
  style.textContent = '#inject-spin{animation:inject-kf 1s linear infinite!important}'
    + '@keyframes inject-kf{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
  ;(document.head || document.documentElement).appendChild(style)
  const el = document.createElement('div')
  el.id = 'inject-spin'
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  return { running: document.getAnimations().filter((a) => a.playState === 'running').length }
})()`

/** 用 new Animation(...) 直接构造（既不经过 animate patch，也不来自 DOM 声明）。 */
const DIRECT_ANIMATION_SCRIPT = `(() => {
  const el = document.createElement('div')
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  const effect = new KeyframeEffect(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 1000, iterations: Infinity })
  const animation = new Animation(effect, document.timeline)
  animation.play()
  return { playState: animation.playState, running: document.getAnimations().filter((a) => a.playState === 'running').length }
})()`

/** 带既有 class 的声明式动画：样式守卫应让它根本不跑起来。 */
const CLASS_ANIMATION_SCRIPT = `(() => {
  if (!document.getElementById('guard-kf')) {
    const style = document.createElement('style')
    style.id = 'guard-kf'
    style.textContent = '.guard-spin{animation:guard-kf-anim 1s linear infinite}'
      + '@keyframes guard-kf-anim{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
    ;(document.head || document.documentElement).appendChild(style)
  }
  const el = document.createElement('div')
  el.className = 'guard-spin'
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  return { running: document.getAnimations().filter((a) => a.playState === 'running').length }
})()`

/** 读页内守护现状（不装机、不改状态）。 */
const READ_STATE = `(() => ({
  styleId: '${ANIMATION_GUARD_STYLE_ID}',
  styleCount: document.querySelectorAll('style#${ANIMATION_GUARD_STYLE_ID}').length,
  stylePresent: Boolean(document.getElementById('${ANIMATION_GUARD_STYLE_ID}')),
  sentinel: Boolean(window.__dshE2eAnimGuard),
  animateName: Element.prototype.animate.name,
  animateLength: Element.prototype.animate.length,
  animateIsNative: /\\[native code\\]/.test(String(Element.prototype.animate)),
  running: document.getAnimations().filter((a) => a.playState === 'running').length,
}))()`

/** 装机前的原型签名：patch 透明性用例拿它做基线（不写死数字，避免依赖引擎当前的 length）。 */
let baselineAnimate = null

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** msedge 主进程数（与 tests/freeze.mjs 同一口径）。 */

/** 本地 HTTP 夹具：换文档、CSP 降级、事件环用例都需要真实可重载的源。 */
let fixtureServer = null
let fixtureBase = ''
async function serveFixture() {
  if (fixtureServer) return fixtureBase
  fixtureServer = createHttpServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/csp') {
      // 严格 CSP：style-src 不含 unsafe-inline，注入 <style> 可能被拦（降级用例）。
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-inline'",
      })
      res.end('<!doctype html><html><head><title>guard-csp</title></head><body><h1>csp</h1></body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>guard-fixture</title></head>'
      + '<body><h1 id="h">guard-fixture</h1><button id="b">b</button></body></html>')
  })
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`
  return fixtureBase
}
async function closeFixture() {
  if (!fixtureServer) return
  const server = fixtureServer
  fixtureServer = null
  await new Promise((resolve) => server.close(resolve))
}

const baseline = countBrowserRoots()

try {
  const base = await serveFixture()

  console.log('== 用例 0：未守护的阴性对照（三路都留下 running 动画）==')
  {
    await launch(KEY, { headless: true }, SID)
    const entry = activeEntry()
    await navigate(liveSession(), `${base}/`)
    const waapi = await entry.page.evaluate(WAAPI_SCRIPT)
    check('未守护：element.animate() 造出 running >= 1', waapi.running >= 1, JSON.stringify(waapi))
    const injected = await entry.page.evaluate(INJECT_SCRIPT)
    check('未守护：页面自插 !important 后 running >= 1', injected.running >= 1, JSON.stringify(injected))
    const direct = await entry.page.evaluate(DIRECT_ANIMATION_SCRIPT)
    check('未守护：new Animation(...) 直接构造后 running >= 1', direct.running >= 1, JSON.stringify(direct))
  }

  console.log('== 用例 1：装机与样式守卫 ==')
  {
    const entry = activeEntry()
    await navigate(liveSession(), `${base}/`)
    const before = await entry.page.evaluate(READ_STATE)
    check('装机前原型是原生函数（未 patch）', before.animateIsNative === true && before.sentinel === false, JSON.stringify(before))
    baselineAnimate = { name: before.animateName, length: before.animateLength }

    const installed = await installAnimationGuard(entry.page)
    check('装机返回 ok 且 stylePresent / patched / timerActive 为真',
      installed.ok === true && installed.stylePresent === true && installed.patched === true
      && installed.timerActive === true, JSON.stringify(installed))
    const after = await entry.page.evaluate(READ_STATE)
    check('页面里恰好一个 #dsh-e2e-freeze 样式', after.styleCount === 1, JSON.stringify(after))
    check('页面里出现守护哨兵', after.sentinel === true, JSON.stringify(after))

    const classAnim = await entry.page.evaluate(CLASS_ANIMATION_SCRIPT)
    check('样式守卫：新元素挂既有 class 动画 running === 0', classAnim.running === 0, JSON.stringify(classAnim))
  }

  console.log('== 用例 2：patch 透明性 ==')
  {
    const entry = activeEntry()
    const state = await entry.page.evaluate(READ_STATE)
    check('patch 后 name 与装机前一致', baselineAnimate !== null && state.animateName === baselineAnimate.name,
      `${baselineAnimate?.name} -> ${state.animateName}`)
    check('patch 后 length 与装机前一致', baselineAnimate !== null && state.animateLength === baselineAnimate.length,
      `${baselineAnimate?.length} -> ${state.animateLength}`)
    const transparent = await entry.page.evaluate(`(() => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const a = el.animate([{ opacity: 0 }, { opacity: 1 }], 100)
      return {
        instanceOfAnimation: a instanceof Animation,
        hasPause: typeof a.pause === 'function',
        ownKeysPatched: Object.getOwnPropertyDescriptor(Element.prototype, 'animate').value.length,
      }
    })()`)
    check('返回值仍是真正的 Animation 实例（未被包装）', transparent.instanceOfAnimation === true && transparent.hasPause === true,
      JSON.stringify(transparent))
  }

  console.log('== 用例 3：后建 WAAPI 与后插 !important ==')
  {
    const entry = activeEntry()
    const waapi = await entry.page.evaluate(WAAPI_SCRIPT)
    check('后建 WAAPI：调用返回即 running === 0', waapi.running === 0, JSON.stringify(waapi))
    check('后建 WAAPI：返回对象 playState === paused', waapi.playState === 'paused', waapi.playState)
    check('后建 WAAPI：返回对象 instanceof Animation', waapi.instanceOfAnimation === true, JSON.stringify(waapi))

    const injected = await entry.page.evaluate(INJECT_SCRIPT)
    check('后插 !important 前置：注入瞬间确有 running 动画', injected.running >= 1, JSON.stringify(injected))
    await sleep(ONE_SWEEP_MS)
    const afterSweep = await entry.page.evaluate(READ_STATE)
    check('后插 !important：等一个 sweep 周期后 running === 0', afterSweep.running === 0, JSON.stringify(afterSweep))

    const direct = await entry.page.evaluate(DIRECT_ANIMATION_SCRIPT)
    check('new Animation(...) 前置：直接构造会跑起来', direct.running >= 1, JSON.stringify(direct))
    await sleep(ONE_SWEEP_MS)
    const directAfter = await entry.page.evaluate(READ_STATE)
    check('new Animation(...)：等一个 sweep 周期后 running === 0', directAfter.running === 0, JSON.stringify(directAfter))
  }

  console.log('== 用例 4：幂等（连续装机三次）==')
  {
    const entry = activeEntry()
    await installAnimationGuard(entry.page)
    await installAnimationGuard(entry.page)
    const third = await installAnimationGuard(entry.page)
    check('连续装机三次仍返回 ok 且 timerActive 为真', third.ok === true && third.timerActive === true, JSON.stringify(third))
    const state = await entry.page.evaluate(READ_STATE)
    check('连续装机三次后 <style> 仍只有一个', state.styleCount === 1, JSON.stringify(state))
    // 不叠 interval 的可观测判据：setInterval 句柄只有一个，重复装机后 sweep 不会报错、running 仍归零。
    const waapi = await entry.page.evaluate(WAAPI_SCRIPT)
    check('连续装机三次后仍然有效（新造动画 running === 0）', waapi.running === 0, JSON.stringify(waapi))
  }

  console.log('== 用例 5：事件环与 ref 表不受扰 ==')
  {
    const session = liveSession()
    const entry = activeEntry()
    await navigate(session, `${base}/`)
    // 基线快照在装机之后采：这样第二次 delta 只反映「守护本身」有没有往 DOM 里加东西。
    await installAnimationGuard(entry.page)
    // snapshot 的签名是 (session, tabId, options)：漏掉 tabId 会把 options 当 tabId，delta 退化。
    await snapshot(session, entry.id, {})
    const consoleBefore = (await consoleEntries(session, { limit: 100 })).total
    const networkBefore = (await networkEntries(session, { limit: 100 })).total
    await sleep(ONE_SWEEP_MS)
    const second = await snapshot(session, entry.id, { delta: true })
    // snapshot 的 delta 返回 added / changed 数组与 addedCount / changedCount 计数：判据用计数。
    check('装机前后各一次快照：delta 的 addedCount === 0', second.addedCount === 0, JSON.stringify({ addedCount: second.addedCount }))
    check('装机前后各一次快照：delta 的 changedCount === 0', second.changedCount === 0, JSON.stringify({ changedCount: second.changedCount }))
    const consoleAfter = (await consoleEntries(session, { limit: 100 })).total
    const networkAfter = (await networkEntries(session, { limit: 100 })).total
    check('守护不往 console 环里写记录', consoleAfter === consoleBefore, `${consoleBefore} -> ${consoleAfter}`)
    check('守护不往 network 环里写记录', networkAfter === networkBefore, `${networkBefore} -> ${networkAfter}`)
  }

  console.log('== 用例 6：换文档重装（navigate / reload）==')
  {
    const session = liveSession()
    const entry = activeEntry()
    await navigate(session, `${base}/?nav=1`)
    const afterNav = await entry.page.evaluate(READ_STATE)
    check('navigate 后 stylePresent === true', afterNav.stylePresent === true, JSON.stringify(afterNav))
    const navAnim = await entry.page.evaluate(WAAPI_SCRIPT)
    check('navigate 后造动画 running === 0', navAnim.running === 0, JSON.stringify(navAnim))

    // 这里**绝不**手工调 installAnimationGuard：那证明的是「手工装机有效」而不是「自动重装」，
    // 断言会变成恒真。reload 后样式与 patch 只能来自 addInitScript 自己。
    await entry.page.reload({ waitUntil: 'domcontentloaded' })
    const afterReload = await entry.page.evaluate(READ_STATE)
    check('reload 后【无手工装机】stylePresent === true', afterReload.stylePresent === true, JSON.stringify(afterReload))
    check('reload 后【无手工装机】原型已被自动 patch', afterReload.animateIsNative === false, JSON.stringify(afterReload))
    check('reload 后【无手工装机】哨兵自动回来', afterReload.sentinel === true, JSON.stringify(afterReload))
    const reloadAnim = await entry.page.evaluate(WAAPI_SCRIPT)
    check('reload 后【无手工装机】造动画 running === 0', reloadAnim.running === 0, JSON.stringify(reloadAnim))
    check('reload 后【无手工装机】造动画 playState === paused', reloadAnim.playState === 'paused', String(reloadAnim.playState))
  }

  console.log('== 用例 7：撤守彻底性与「撤守后换文档不复活」==')
  {
    const session = liveSession()
    const entry = activeEntry()
    const before = await entry.page.evaluate(READ_STATE)
    const removed = await uninstallAnimationGuard(entry.page)
    check('撤守返回 ok 且 disposed 为真', removed.ok === true && removed.disposed === true, JSON.stringify(removed))
    check('撤守后样式被移除', removed.styleRemoved === true, JSON.stringify(removed))
    check('撤守后原型被还原（恒等比较通过）', removed.patchedRestored === true, JSON.stringify(removed))
    check('撤守后定时器被清掉', removed.timerCleared === true, JSON.stringify(removed))

    const after = await entry.page.evaluate(READ_STATE)
    check('撤守后 #dsh-e2e-freeze 不存在', after.stylePresent === false, JSON.stringify(after))
    check('撤守后原型是原生函数', after.animateIsNative === true, JSON.stringify(after))
    check('撤守后哨兵已删除', after.sentinel === false, JSON.stringify(after))

    const revived = await entry.page.evaluate(WAAPI_SCRIPT)
    check('撤守后新造 WAAPI running >= 1（真撤守）', revived.running >= 1, JSON.stringify(revived))
    check('撤守后新造 WAAPI playState === running', revived.playState === 'running', revived.playState)
    const classAnim = await entry.page.evaluate(CLASS_ANIMATION_SCRIPT)
    check('撤守后声明式动画自动恢复 running', classAnim.running >= 1, JSON.stringify(classAnim))

    // 关键：撤守后换文档不能复活（这一步不撤 addInitScript 就会失败）。
    await navigate(session, `${base}/?after-uninstall=1`)
    const afterNav = await entry.page.evaluate(READ_STATE)
    check('撤守后 navigate：stylePresent === false（addInitScript 已撤）', afterNav.stylePresent === false, JSON.stringify(afterNav))
    check('撤守后 navigate：哨兵不存在', afterNav.sentinel === false, JSON.stringify(afterNav))
    const navAnim = await entry.page.evaluate(WAAPI_SCRIPT)
    check('撤守后 navigate：造动画 running >= 1', navAnim.running >= 1, JSON.stringify(navAnim))
    check('撤守前确实装过守护（前后对照成立）', before.stylePresent === true, JSON.stringify(before))
  }

  console.log('== 用例 6b：animationGuardState 是纯只读查询（不暂停、不替调用方装机）==')
  {
    const session = liveSession()
    const entry = activeEntry()
    await navigate(session, `${base}/?state=1`)
    // 未装状态：只读查询必须如实返回 installed:false，且不替调用方把守护装上。
    const uninstalled = await animationGuardState(entry.page)
    check('未装状态下返回 installed:false', uninstalled.ok === true && uninstalled.installed === false, JSON.stringify(uninstalled))
    const sentinelAfterQuery = await entry.page.evaluate(`Boolean(window.__dshE2eAnimGuard)`)
    check('未装状态下查询不会替调用方装机（哨兵仍不存在）', sentinelAfterQuery === false, String(sentinelAfterQuery))

    // 已装状态：查询前后 running 数必须完全不变。
    await installAnimationGuard(entry.page)
    await entry.page.evaluate(DIRECT_ANIMATION_SCRIPT)
    const before = await entry.page.evaluate(READ_STATE)
    const queried = await animationGuardState(entry.page)
    const after = await entry.page.evaluate(READ_STATE)
    check('已装状态下返回 installed:true', queried.ok === true && queried.installed === true, JSON.stringify(queried))
    check('查询前后 running 数不变（无暂停副作用）', after.running === before.running,
      JSON.stringify({ before: before.running, after: after.running, queried: queried.running }))

    // 自愈意图仍成立：页面删掉样式后查询能补回，且不暂停。
    await entry.page.evaluate(`(() => {
      for (const node of document.querySelectorAll('style#${ANIMATION_GUARD_STYLE_ID}')) node.remove()
    })()`)
    await entry.page.evaluate(DIRECT_ANIMATION_SCRIPT)
    const beforeHeal = await entry.page.evaluate(READ_STATE)
    const healed = await animationGuardState(entry.page)
    const afterHeal = await entry.page.evaluate(READ_STATE)
    check('样式被删后查询自动补回（确保的是样式在位）', healed.stylePresent === true, JSON.stringify(healed))
    check('自愈过程中没有暂停动画', afterHeal.running === beforeHeal.running,
      JSON.stringify({ before: beforeHeal.running, after: afterHeal.running }))
  }

  console.log('== 用例 7b：反向判别——证明「reload 后自动重装」不是恒真 ==')
  {
    const session = liveSession()
    const entry = activeEntry()
    // 用例 7 结束时已撤守，这里必须自己重新装回基线，不能假设上一个用例留下的状态。
    await navigate(session, `${base}/?discriminate=1`)
    const on = await installAnimationGuard(entry.page)
    check('判别前置：重新装机成功', on.ok === true && on.stylePresent === true, JSON.stringify(on))
    const onBaseline = await entry.page.evaluate(READ_STATE)
    check('判别前置：当前处于守护开启状态（样式在位）', onBaseline.stylePresent === true, JSON.stringify(onBaseline))

    // 反向：真撤守后 reload，守护必须**不**自动出现，否则用例 6 的断言就是恒真。
    const off = await uninstallAnimationGuard(entry.page)
    check('判别前置：撤守成功', off.ok === true && off.disposed === true, JSON.stringify(off))
    await entry.page.reload({ waitUntil: 'domcontentloaded' })
    const afterOffReload = await entry.page.evaluate(READ_STATE)
    check('撤守后 reload：stylePresent === false（addInitScript 确已撤掉）',
      afterOffReload.stylePresent === false, JSON.stringify(afterOffReload))
    check('撤守后 reload：原型回到原生函数', afterOffReload.animateIsNative === true, JSON.stringify(afterOffReload))
    const offAnim = await entry.page.evaluate(WAAPI_SCRIPT)
    check('撤守后 reload：造动画 running >= 1', offAnim.running >= 1, JSON.stringify(offAnim))

    // 再开启后 reload：样式必须自动回来（关闭→开启后 addInitScript 重新登记）。
    const onAgain = await installAnimationGuard(entry.page)
    check('重新开启成功', onAgain.ok === true && onAgain.stylePresent === true, JSON.stringify(onAgain))
    await entry.page.reload({ waitUntil: 'domcontentloaded' })
    const afterOnReload = await entry.page.evaluate(READ_STATE)
    check('再开启后 reload：样式自动回来（无手工装机）', afterOnReload.stylePresent === true, JSON.stringify(afterOnReload))
    const onAnim = await entry.page.evaluate(WAAPI_SCRIPT)
    check('再开启后 reload：造动画 running === 0', onAnim.running === 0, JSON.stringify(onAnim))
  }

  console.log('== 用例 8：CSP 降级（二选一，不写成恒假）==')
  {
    const session = liveSession()
    const entry = activeEntry()
    await navigate(session, `${base}/csp`)
    await installAnimationGuard(entry.page)
    const state = await entry.page.evaluate(READ_STATE)
    const waapi = await entry.page.evaluate(WAAPI_SCRIPT)
    check('严格 CSP 页：样式守卫在位，或 patch + sweep 仍把动画停住（二选一）',
      state.stylePresent === true || waapi.running === 0,
      JSON.stringify({ stylePresent: state.stylePresent, running: waapi.running, patched: state.animateIsNative === false }))
    check('严格 CSP 页上前提成立：确实装了守护（哨兵在）', state.sentinel === true, JSON.stringify(state))
  }

  console.log('== 用例 9：页内脚本常量与模块契约 ==')
  {
    check('ANIMATION_GUARD_STYLE_ID 为 dsh-e2e-freeze', ANIMATION_GUARD_STYLE_ID === 'dsh-e2e-freeze', ANIMATION_GUARD_STYLE_ID)
    check('GUARD_SWEEP_INTERVAL_MS 为 250', GUARD_SWEEP_INTERVAL_MS === 250, String(GUARD_SWEEP_INTERVAL_MS))
    check('守护脚本首行是 frame 判定（只覆盖主文档）',
      ANIMATION_GUARD_SCRIPT.includes("if (window.top !== window) return { skipped: 'child-frame' }"))
    check('撤守脚本也带 frame 判定',
      ANIMATION_GUARD_DISPOSE_SCRIPT.includes("if (window.top !== window) return { skipped: 'child-frame' }"))
    check('守护脚本包含四件套：样式守卫 / animate patch / sweep / dispose',
      ANIMATION_GUARD_SCRIPT.includes('ensureStyle') && ANIMATION_GUARD_SCRIPT.includes('patchedAnimate')
      && ANIMATION_GUARD_SCRIPT.includes('setInterval') && ANIMATION_GUARD_SCRIPT.includes('dispose'))
  }
} finally {
  await closeFixture()
  await closeAll()
}

console.log('\n== 收尾：msedge 主进程回落 ==')
{
  await sleep(1500)
  const now = countBrowserRoots()
  check('msedge 主进程回落到运行前基线', now <= baseline, `基线 ${baseline}，当前 ${now}`)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
