/**
 * P2-24 跟随当前标签页（browser_e2e_follow_tab）独立验收。
 *
 * 按 specs/功能规格/0033-follow-active-tab.md「验收」覆盖：
 *   - 用例 1：假页面（不启浏览器）验证焦点 / 可见性判定与探测失败剔除；
 *   - 用例 2：显式 tab_id 绑定、重复绑定、缺省快照跟随、tabs active 标记、activate；
 *   - 用例 3：无参判定（真浏览器）不新建 / 不关闭标签页；
 *   - 用例 4：入参非法、未启动 / 零页、主线程卡死不阻塞、并发 closeTab；
 *   - 收尾：msedge 主进程回落到运行前基线。
 *
 * 真起无头 Edge；进程数断言以「回落到运行前基线」为准，不看绝对值。
 * 运行：node tests/follow.mjs
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, closeTab, launch, requireSession, tabs } = await import('../lib/session.js')
const { evaluate, followTab, FOLLOW_PROBE_TIMEOUT_MS, navigate } = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')

const KEY = 'test-follow-key'
const SID = KEY
let session = null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/** msedge 主进程数（与 tests/multitab.mjs 同一口径）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/**
 * 造一个假页面对象，只带 followTab 会读的面。
 * probe：'ok'（按 visibility / focus 返回）/ 'reject' / 'notObject' / 'hang'（永不落定，模拟主线程卡死）。
 */
function fakePage({ visibility = 'hidden', focus = false, probe = 'ok', front = 'ok' } = {}) {
  const calls = { front: 0 }
  return {
    calls,
    entry: {
      id: null,
      origin: 'created',
      page: {
        async evaluate() {
          if (probe === 'reject') throw new Error('Target page, context or browser has been closed')
          if (probe === 'notObject') return 'visible'
          if (probe === 'hang') return await new Promise(() => {})
          return { visibility, focus }
        },
        async bringToFront() {
          calls.front += 1
          if (front === 'reject') throw new Error('bringToFront 失败')
        },
        async title() {
          return 'fake-title'
        },
        url() {
          return 'about:blank'
        },
      },
    },
  }
}

/** 用假页面拼一个最小会话；entries 为 [{ id, ...fakePage }] 或 [id, fakePage]。 */
function fakeSession(entries, activeTabId) {
  const pages = new Map()
  for (const item of entries) {
    const page = Array.isArray(item) ? item[1] : item
    const id = Array.isArray(item) ? item[0] : item.entry.id
    page.entry.id = id
    pages.set(id, page.entry)
  }
  return { pages, activeTabId }
}

const baseline = edgeRootCount()

console.log('== 用例 1：无参判定（假页面，不启动浏览器）==')
{
  const focusedCase = fakeSession([
    ['t1', fakePage({ visibility: 'visible', focus: false })],
    ['t2', fakePage({ visibility: 'visible', focus: true })],
    ['t3', fakePage({ visibility: 'hidden', focus: false })],
  ], 't1')
  const focused = await followTab(focusedCase, {})
  check('聚焦页优先于其他可见页', focused.tabId === 't2' && focused.source === 'focused'
    && focused.ambiguous === false && focused.changed === true
    && focusedCase.activeTabId === 't2', JSON.stringify(focused))

  const visibleCase = fakeSession([
    ['t1', fakePage({ visibility: 'hidden', focus: false })],
    ['t2', fakePage({ visibility: 'visible', focus: false })],
    ['t3', fakePage({ visibility: 'hidden', focus: false })],
  ], 't1')
  const visible = await followTab(visibleCase, { tab_id: '' })
  check('唯一可见页被选中', visible.tabId === 't2' && visible.source === 'visible'
    && visible.changed === true, JSON.stringify(visible))

  const multiVisible = fakeSession([
    ['t1', fakePage({ visibility: 'visible', focus: false })],
    ['t2', fakePage({ visibility: 'visible', focus: false })],
  ], 't2')
  const ambiguous = await followTab(multiVisible, {})
  check('多页可见且无焦点时保持当前（source=current）', ambiguous.tabId === 't2'
    && ambiguous.source === 'current' && ambiguous.ambiguous === true
    && ambiguous.changed === false, JSON.stringify(ambiguous))

  const allHidden = fakeSession([
    ['t1', fakePage({ visibility: 'hidden', focus: false })],
    ['t2', fakePage({ visibility: 'hidden', focus: false })],
  ], 't1')
  const hidden = await followTab(allHidden, {})
  check('全部不可见时保持当前（source=current）', hidden.tabId === 't1'
    && hidden.source === 'current' && hidden.ambiguous === true, JSON.stringify(hidden))

  const partialFail = fakeSession([
    ['t1', fakePage({ probe: 'reject' })],
    ['t2', fakePage({ visibility: 'hidden', focus: true })],
    ['t3', fakePage({ probe: 'notObject' })],
  ], 't1')
  const partial = await followTab(partialFail, {})
  check('探测失败的页不计入候选且 failedProbeCount 正确', partial.tabId === 't2'
    && partial.failedProbeCount === 2 && partial.candidates.length === 1
    && partial.candidates[0].tabId === 't2', JSON.stringify(partial))

  const allFail = fakeSession([
    ['t1', fakePage({ probe: 'reject' })],
    ['t2', fakePage({ probe: 'notObject' })],
  ], 't1')
  const allFailMessage = await expectThrow(() => followTab(allFail, {}))
  check('所有页探测失败时报「无法判定用户当前标签页」', Boolean(allFailMessage)
    && allFailMessage.includes('无法判定用户当前标签页')
    && allFailMessage.includes('所有标签页都未能返回可见性'), String(allFailMessage))

  const frontA = fakePage({ visibility: 'visible', focus: false })
  const frontB = fakePage({ visibility: 'visible', focus: false })
  const undecidable = fakeSession([['t1', frontA], ['t2', frontB]], 't9')
  const undecidableMessage = await expectThrow(() => followTab(undecidable, { activate: true }))
  check('无法判定且传 activate 时不切前台', Boolean(undecidableMessage)
    && undecidableMessage.includes('无法判定用户当前标签页')
    && frontA.calls.front === 0 && frontB.calls.front === 0
    && undecidable.activeTabId === 't9', String(undecidableMessage))

  // 以下为规格「行为 / 边界」的补充覆盖，同样不启浏览器。
  const single = fakePage({ visibility: 'visible', focus: true })
  const emptyTabId = fakeSession([['t1', single]], null)
  const empty = await followTab(emptyTabId, { tab_id: '' })
  check('空串 tab_id 按未给处理并自动判定', empty.tabId === 't1'
    && empty.source === 'focused' && empty.changed === true, JSON.stringify(empty))

  const currentFront = fakePage({ visibility: 'visible', focus: false })
  const currentOther = fakePage({ visibility: 'visible', focus: false })
  const currentCase = fakeSession([['t1', currentFront], ['t2', currentOther]], 't1')
  const currentActivate = await followTab(currentCase, { activate: true })
  check('来源为 current 时 activate 不切前台', currentActivate.tabId === 't1'
    && currentActivate.source === 'current' && currentActivate.activated === false
    && currentFront.calls.front === 0 && currentOther.calls.front === 0,
  JSON.stringify(currentActivate))

  const failFrontTarget = fakePage({ visibility: 'hidden', focus: false, front: 'reject' })
  const failFront = fakeSession([['t1', fakePage({ visibility: 'hidden' })], ['t2', failFrontTarget]], 't1')
  const failFrontMessage = await expectThrow(() => followTab(failFront, { tab_id: 't2', activate: true }))
  check('带到前台失败时报错且不改默认标签页', Boolean(failFrontMessage)
    && failFrontMessage.includes('带到前台失败') && failFrontMessage.includes('默认标签页未改变')
    && failFront.activeTabId === 't1', String(failFrontMessage))

  const many = Array.from({ length: 12 }, (_item, index) => [`t${index + 1}`, fakePage({ visibility: 'visible' })])
  const manyCase = fakeSession(many, 't1')
  const manyResult = await followTab(manyCase, {})
  check('候选按登记顺序排列且最多列出 10 条', manyResult.candidates.length === 10
    && manyResult.candidates[0].tabId === 't1' && manyResult.candidates[9].tabId === 't10'
    && manyResult.tabs === 12, JSON.stringify(manyResult.candidates.map((candidate) => candidate.tabId)))
}

// 真浏览器夹具：两个页面，标题能区分。
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  const title = req.url === '/b' ? 'page-b' : 'page-a'
  const label = req.url === '/b' ? 'B Button' : 'A Button'
  res.end(`<!doctype html><html><head><title>${title}</title></head><body><button id="btn">${label}</button></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  const launched = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
  session = requireSession(KEY)
  const first = await navigate(session, `${base}/a`, 'load')
  const second = await navigate(session, `${base}/b`, 'load', { new_tab: true })
  check('用例 2 前置：两个标签页 t1 / t2，active 为 t2',
    launched.reused === false && first.tabId === 't1' && second.tabId === 't2'
      && session.activeTabId === 't2', JSON.stringify({ first: first.tabId, second: second.tabId, active: session.activeTabId }))

  console.log('== 用例 2：显式绑定与 activate（真浏览器）==')
  {
    const bound = await followTab(session, { tab_id: 't1' })
    check('显式 tab_id 绑定成功且 changed=true', bound.tabId === 't1' && bound.changed === true
      && bound.previousTabId === 't2' && bound.source === 'explicit' && bound.activated === false
      && bound.url.endsWith('/a') && bound.title === 'page-a' && bound.tabs === 2
      && session.activeTabId === 't1', JSON.stringify(bound))

    const again = await followTab(session, { tab_id: 't1', activate: false })
    check('重复绑定同一页 changed=false', again.tabId === 't1' && again.changed === false
      && again.previousTabId === 't1', JSON.stringify(again))

    const snap = await snapshot(session)
    check('绑定后缺省 tab_id 的快照作用于新绑定页', snap.tabId === 't1'
      && snap.text.includes('A Button'), `${snap.tabId} ${snap.text.slice(0, 120)}`)

    const list = await tabs(KEY)
    check('tabs 的 active 标记随绑定切换', list.activeTabId === 't1'
      && list.tabs.find((tab) => tab.tab_id === 't1')?.active === true
      && list.tabs.find((tab) => tab.tab_id === 't2')?.active === false, JSON.stringify(list.tabs))

    const activated = await followTab(session, { tab_id: 't2', activate: true })
    check('activate=true 返回 activated=true', activated.tabId === 't2'
      && activated.activated === true && activated.changed === true
      && session.activeTabId === 't2', JSON.stringify(activated))

    const visibility = await evaluate(session, 'document.visibilityState', 't2')
    check('activate 后目标页 document.visibilityState 为 visible', visibility.value === 'visible',
      JSON.stringify(visibility.value))
  }

  console.log('== 用例 3：无参判定（真浏览器）==')
  {
    const activated = await followTab(session, { tab_id: 't1', activate: true })
    const detected = await followTab(session, {})
    check('activate 后无参判定回到被激活页', activated.activated === true
      && detected.tabId === 't1'
      && ['focused', 'visible', 'current'].includes(detected.source)
      && session.activeTabId === 't1', JSON.stringify({ activated, detected }))

    const closed = await closeTab(KEY, 't2')
    const single = await followTab(session, {})
    check('单页会话无参判定返回该页', closed.remaining === 1 && session.pages.size === 1
      && single.tabId === 't1' && single.changed === false
      && single.tabs === 1 && single.candidates.length === 1, JSON.stringify(single))

    const before = await tabs(KEY)
    const auto = await followTab(session, {})
    const after = await tabs(KEY)
    check('无参判定不新建也不关闭标签页', before.tabs.length === 1 && after.tabs.length === 1
      && after.activeTabId === auto.tabId
      && JSON.stringify(before.tabs.map((tab) => tab.tab_id)) === JSON.stringify(after.tabs.map((tab) => tab.tab_id)),
    JSON.stringify(after.tabs.map((tab) => tab.tab_id)))
  }

  console.log('== 用例 4：边界与并发 ==')
  {
    const unknown = await expectThrow(() => followTab(session, { tab_id: 't99' }))
    check('未知 tab_id 报「不存在」', Boolean(unknown) && unknown.includes('不存在'), String(unknown))

    const numberMessage = await expectThrow(() => followTab(session, { tab_id: 2 }))
    const nullMessage = await expectThrow(() => followTab(session, { tab_id: null }))
    check('tab_id 非字符串报错', Boolean(numberMessage) && numberMessage.includes('tab_id 必须是字符串')
      && Boolean(nullMessage) && nullMessage.includes('tab_id 必须是字符串')
      && session.activeTabId === 't1',
    JSON.stringify({ numberMessage, nullMessage }))

    const notStarted = await expectThrow(() => followTab(undefined, {}))
    const noSession = await expectThrow(() => followTab(null, { tab_id: 't1' }))
    check('未启动时报「浏览器尚未启动」', Boolean(notStarted) && notStarted.includes('浏览器尚未启动')
      && Boolean(noSession) && noSession.includes('浏览器尚未启动'), JSON.stringify({ notStarted, noSession }))

    const zeroPages = await expectThrow(() => followTab({ pages: new Map(), activeTabId: null }, {}))
    check('零页时报「浏览器尚未启动」', Boolean(zeroPages) && zeroPages.includes('浏览器尚未启动'), String(zeroPages))

    // 主线程卡死的页：宿主侧 evaluate 永不落定，等价于真实死循环页对探测的表现。
    const stuckCase = fakeSession([
      ['t1', fakePage({ visibility: 'visible', focus: false })],
      ['t2', fakePage({ probe: 'hang' })],
    ], 't1')
    const stuckStarted = Date.now()
    const stuck = await followTab(stuckCase, {})
    const stuckElapsed = Date.now() - stuckStarted
    check('主线程卡死的页不阻塞判定（整次调用 5000ms 内返回）',
      stuck.tabId === 't1' && stuck.failedProbeCount === 1
        && stuck.candidates.length === 1
        && stuckElapsed >= FOLLOW_PROBE_TIMEOUT_MS - 100 && stuckElapsed < 5000,
      JSON.stringify({ elapsed: stuckElapsed, result: stuck }))

    // 并发 closeTab 与 follow：无论谁先落定，activeTabId 都不能指向已摘除的页。
    await navigate(session, `${base}/a`, 'load', { new_tab: true })
    const closingTab = await navigate(session, `${base}/b`, 'load', { new_tab: true })
    const race = await Promise.allSettled([
      followTab(session, {}),
      closeTab(KEY, closingTab.tabId),
    ])
    check('并发 closeTab 与 follow 后 activeTabId 仍指向存在的页',
      session.pages.size >= 1 && typeof session.activeTabId === 'string'
        && session.pages.has(session.activeTabId)
        && race.some((item) => item.status === 'fulfilled'),
    JSON.stringify({ statuses: race.map((item) => item.status), active: session.activeTabId, pages: [...session.pages.keys()] }))
  }
} finally {
  await closeAll()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

// 浏览器进程回收可能滞后：轮询等待回落到运行前基线，超时才判 FAIL。
let finalRoots = edgeRootCount()
{
  const started = Date.now()
  while (finalRoots > baseline && Date.now() - started < 15000) {
    await sleep(300)
    finalRoots = edgeRootCount()
  }
}
check('msedge 主进程回落到运行前基线', Number.isFinite(finalRoots) && finalRoots <= baseline,
  `剩余 ${finalRoots} 个（基线 ${baseline}）`)

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${finalRoots} 个（基线 ${baseline}）`)
process.exit(fail === 0 ? 0 : 1)
