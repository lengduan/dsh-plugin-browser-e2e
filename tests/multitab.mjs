/**
 * M6 多标签页验证。
 *
 * 真起无头 Edge，覆盖：
 *   - new_tab 新建页并设为 active；
 *   - tabs 列出 tab_id / url / title / active；
 *   - ref 表按页隔离（切 tab 后旧 ref 失效、带 tab_id 可回旧页操作）；
 *   - close_tab 关闭指定页、最后一个不允许关；
 *   - 所有页面工具在缺省 tab_id 时作用于 active tab。
 *
 * 运行：node tests/multitab.mjs
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { close, closeAll, closeTab, launch, requireSession, tabs } = await import('../lib/session.js')
const { click, evaluate, MIN_EVALUATE_TIMEOUT_MS, navigate, press } = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')

const KEY = 'test-multitab-key'
let session = null
const SID = KEY
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

/** 从 snapshot 文本里解析某个标签文本对应的 ref。 */
function refOf(info, label) {
  const line = info.text.split('\n').find((row) => row.includes(`"${label}"`))
  const match = line && /\[(\d+)\]/.exec(line)
  return match ? `@${match[1]}` : null
}

function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

const baseline = edgeRootCount()
const server = createServer((req, res) => {
  if (req.url === '/a') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>page-a</title></head><body><button id="btn" onclick="window.__hit=\'a\'">A Button</button>'
      + '<script>window.__mods=[];document.addEventListener("click",function(e){window.__mods.push({shiftKey:e.shiftKey,ctrlKey:e.ctrlKey})})</script></body></html>')
    return
  }
  if (req.url === '/b') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>page-b</title></head><body><button id="btn" onclick="window.__hit=\'b\'">B Button</button>'
      + '<script>window.__mods=[];document.addEventListener("click",function(e){window.__mods.push({shiftKey:e.shiftKey,ctrlKey:e.ctrlKey})})</script></body></html>')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 1：启动与第一个标签页 ==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    check('启动成功', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    const first = await navigate(session, `${base}/a`, 'load')
    check('首个导航在 t1', first.tabId === 't1' && !first.newTab, JSON.stringify(first))
    const list = await tabs(KEY)
    check('tabs 列出 1 个页且 active 为 t1', list.tabs.length === 1 && list.tabs[0].tab_id === 't1' && list.tabs[0].active === true, JSON.stringify(list.tabs))
    check('tabs 带 url 与 title', list.tabs[0].url.endsWith('/a') && list.tabs[0].title === 'page-a', JSON.stringify(list.tabs[0]))
    check('tabs 带 loading / origin（created）字段', typeof list.tabs[0].loading === 'boolean'
      && list.tabs[0].loading === false && list.tabs[0].origin === 'created', JSON.stringify(list.tabs[0]))
  }

  console.log('== 用例 2：new_tab 新建页并设为 active ==')
  {
    const second = await navigate(session, `${base}/b`, 'load', { new_tab: true })
    check('new_tab 生成 t2 且标记 newTab', second.tabId === 't2' && second.newTab === true, JSON.stringify(second))
    const list = await tabs(KEY)
    check('现在有 2 个页', list.tabs.length === 2, JSON.stringify(list.tabs))
    check('t2 成为 active', list.activeTabId === 't2' && list.tabs.find((t) => t.tab_id === 't2').active === true, JSON.stringify(list))
    check('顺序稳定为 t1 / t2', JSON.stringify(list.tabs.map((t) => t.tab_id)) === JSON.stringify(['t1', 't2']), JSON.stringify(list.tabs.map((t) => t.tab_id)))
  }

  console.log('== 用例 3：ref 表按页隔离 ==')
  {
    const snapA = await snapshot(session, 't1')
    const refA = refOf(snapA, 'A Button')
    check('t1 快照拿到 A 按钮 ref', Boolean(refA), snapA.text)
    const hitA = await evaluate(session, 'window.__hit || null', 't1')
    check('t1 初始未点击', hitA.value === null, JSON.stringify(hitA.value))

    const clickedA = await click(session, { ref: refA }, 't1')
    await sleep(100)
    const afterA = await evaluate(session, "window.__hit || ''", 't1')
    check('带 tab_id 点击 t1 生效', afterA.value === 'a', `${JSON.stringify(clickedA)} hit=${JSON.stringify(afterA.value)}`)

    // 同一个 ref 在 t2 上不存在：ref 表按页隔离。
    const message = await expectThrow(() => click(session, { ref: refA }, 't2'))
    check('t1 的 ref 在 t2 上失效', Boolean(message) && message.includes('不存在'), String(message))

    const snapB = await snapshot(session, 't2')
    const refB = refOf(snapB, 'B Button')
    check('t2 快照是 B 按钮', Boolean(refB), snapB.text)
    await click(session, { ref: refB }, 't2')
    await sleep(100)
    const hitB = await evaluate(session, "window.__hit || ''", 't2')
    check('点击 t2 生效', hitB.value === 'b', JSON.stringify(hitB.value))
  }

  console.log('== 用例 4：缺省 tab_id 用 active tab ==')
  {
    const list = await tabs(KEY)
    check('active 仍是 t2', list.activeTabId === 't2', JSON.stringify(list.activeTabId))
    // 缺省 snapshot 应读到 t2 的 B 按钮。
    const snap = await snapshot(session)
    check('缺省快照作用于 active（t2）', snap.tabId === 't2' && snap.text.includes('B Button'), `${snap.tabId} ${snap.text}`)
    // 切回 t1：导航到 t1 后 active 变成 t1。
    await navigate(session, `${base}/a`, 'load', { tab_id: 't1' })
    const after = await tabs(KEY)
    check('带 tab_id 导航后 active 切到 t1', after.activeTabId === 't1', JSON.stringify(after.activeTabId))
    const snapDefault = await snapshot(session)
    check('active 切换后缺省快照跟到 t1', snapDefault.tabId === 't1' && snapDefault.text.includes('A Button'), `${snapDefault.tabId} ${snapDefault.text}`)
  }

  console.log('== 用例 5：close_tab ==')
  {
    const closed = await closeTab(KEY, 't2')
    check('关闭 t2 成功', closed.tabId === 't2' && closed.remaining === 1, JSON.stringify(closed))
    const list = await tabs(KEY)
    check('只剩 t1 且为 active', list.tabs.length === 1 && list.activeTabId === 't1', JSON.stringify(list))
    const lastError = await expectThrow(() => closeTab(KEY, 't1'))
    check('最后一个不允许关', Boolean(lastError) && lastError.includes('最后一个'), String(lastError))
    const unknownError = await expectThrow(() => closeTab(KEY, 't9'))
    check('不存在的 tab 报错', Boolean(unknownError) && unknownError.includes('不存在'), String(unknownError))
  }

  console.log('== 用例 6：不存在的 tab_id 作用于页面工具时报错 ==')
  {
    const message = await expectThrow(() => snapshot(session, 't9'))
    check('snapshot 未知 tab 报错', Boolean(message) && message.includes('不存在'), String(message))
    const clickMessage = await expectThrow(() => click(session, { selector: '#btn' }, 't9'))
    check('click 未知 tab 报错', Boolean(clickMessage) && clickMessage.includes('不存在'), String(clickMessage))
  }
  console.log('== 用例 7：唯一页被关掉后的零页恢复 ==')
  {
    const only = session.pages.get('t1')
    check('用例 7 前置：只剩 t1 一个页', Boolean(only), JSON.stringify([...session.pages.keys()]))
    // 直接在页面对象上 close，模拟用户在浏览器里关掉唯一标签页。
    await only.page.close()
    for (let i = 0; i < 200 && session.pages.size > 0; i += 1) await sleep(10)
    check('关掉唯一页后 pages 归零', session.pages.size === 0, String(session.pages.size))

    const noTabError = await expectThrow(() => navigate(session, `${base}/a`, 'load'))
    check('零页时不带 new_tab 的导航报「浏览器尚未启动」',
      Boolean(noTabError) && noTabError.includes('浏览器尚未启动'), String(noTabError))

    const recovered = await navigate(session, `${base}/b`, 'load', { new_tab: true })
    check('零页时 new_tab 能新建页并导航成功',
      recovered.newTab === true && recovered.tabId === 't3' && recovered.title === 'page-b', JSON.stringify(recovered))
    const list = await tabs(KEY)
    check('恢复后 tabs 列出 1 个页且为 active',
      list.tabs.length === 1 && list.activeTabId === 't3' && list.tabs[0].tab_id === 't3', JSON.stringify(list))
    const snap = await snapshot(session)
    check('恢复后可 snapshot', snap.tabId === 't3' && snap.text.includes('B Button'), `${snap.tabId} ${snap.text}`)
  }
  console.log('== 用例 8：并发 closeTab 不会把会话关到 0 页 ==')
  {
    await navigate(session, `${base}/a`, 'load', { new_tab: true })
    check('用例 8 前置：当前 2 个页', session.pages.size === 2, JSON.stringify([...session.pages.keys()]))
    const [firstKey, secondKey] = [...session.pages.keys()]
    const results = await Promise.allSettled([closeTab(KEY, firstKey), closeTab(KEY, secondKey)])
    check('并发关两页恰好一成一败',
      results.filter((item) => item.status === 'fulfilled').length === 1
        && results.filter((item) => item.status === 'rejected').length === 1,
      JSON.stringify(results.map((item) => item.status)))
    check('并发关两页后仍有 1 页且 active 不为空',
      session.pages.size === 1 && session.activeTabId !== null, `${session.pages.size} / ${session.activeTabId}`)
  }
  console.log('== 用例 9：一个 tab 的 evaluate 超时不影响另一个 tab ==')
  {
    // 准备两个新页（都在同一浏览器上下文里），分别作为「死循环页」与「旁观页」。
    const stuckTab = await navigate(session, `${base}/a`, 'load', { new_tab: true })
    const otherTab = await navigate(session, `${base}/b`, 'load', { new_tab: true })
    check('用例 9 前置：两个新页可分别求值',
      stuckTab.tabId !== otherTab.tabId
        && (await evaluate(session, 'document.title', stuckTab.tabId)).value === 'page-a'
        && (await evaluate(session, 'document.title', otherTab.tabId)).value === 'page-b',
      JSON.stringify({ stuckTab: stuckTab.tabId, otherTab: otherTab.tabId, pages: [...session.pages.keys()] }))

    // 死在 stuckTab 上的求值不 await，先让另一个 tab 在它超时前完成求值。
    const stuck = expectThrow(() => evaluate(session, 'while (true) {}', stuckTab.tabId,
      { timeoutMs: MIN_EVALUATE_TIMEOUT_MS }))
    await sleep(150)
    const otherStart = Date.now()
    const other = await evaluate(session, 'document.title', otherTab.tabId, { timeoutMs: 5000 })
    const otherElapsed = Date.now() - otherStart
    const stuckMessage = await stuck
    check('一个 tab 的 evaluate 超时不影响另一个 tab',
      other.value === 'page-b' && otherElapsed < MIN_EVALUATE_TIMEOUT_MS
        && Boolean(stuckMessage) && stuckMessage.includes('脚本执行超时')
        && session.pages.size >= 2,
      JSON.stringify({ other: other.value, otherElapsed, stuckMessage, pages: session.pages.size }))
  }
  console.log('== 用例 10：按住状态按 tab 隔离 ==')
  {
    const firstTab = (await tabs(KEY)).activeTabId
    const down = await press(session, 'Shift', firstTab, { action: 'down' })
    // 新建并导航第二个页：navigate 只释放目标页的按住状态。
    const secondTab = (await navigate(session, `${base}/b`, 'load', { new_tab: true })).tabId
    const firstHeld = session.pages.get(firstTab).heldKeys.has('Shift')
    const secondHeld = session.pages.get(secondTab).heldKeys.size
    await click(session, { selector: '#btn' })
    const secondMods = (await evaluate(session, 'window.__mods', secondTab)).value
    await click(session, { selector: '#btn' }, firstTab)
    const firstMods = (await evaluate(session, 'window.__mods', firstTab)).value
    const up = await press(session, 'Shift', firstTab, { action: 'up' })
    check('按住键不跨 tab，navigate 只释放目标页',
      down.held === true && firstHeld === true && secondHeld === 0
        && secondMods?.length === 1 && secondMods[0].shiftKey === false
        && firstMods?.length === 1 && firstMods[0].shiftKey === true
        && up.held === false && session.pages.get(firstTab).heldKeys.size === 0,
      JSON.stringify({ firstHeld, secondHeld, secondMods, firstMods }))
    await closeTab(KEY, secondTab)
  }
} finally {
  await closeAll()
  server.close()
  await sleep(1500)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（基线 ${baseline}）`)
process.exit(fail === 0 ? 0 : 1)
