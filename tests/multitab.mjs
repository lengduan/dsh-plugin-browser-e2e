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

const { close, closeAll, closeTab, click, evaluate, launch, navigate, snapshot, tabs } =
  await import('../lib/browser.js')

const KEY = 'test-multitab-key'
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
    res.end('<!doctype html><html><head><title>page-a</title></head><body><button id="btn" onclick="window.__hit=\'a\'">A Button</button></body></html>')
    return
  }
  if (req.url === '/b') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>page-b</title></head><body><button id="btn" onclick="window.__hit=\'b\'">B Button</button></body></html>')
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
    check('启动成功', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    const first = await navigate(KEY, `${base}/a`, 'load', SID)
    check('首个导航在 t1', first.tabId === 't1' && !first.newTab, JSON.stringify(first))
    const list = await tabs(KEY)
    check('tabs 列出 1 个页且 active 为 t1', list.tabs.length === 1 && list.tabs[0].tab_id === 't1' && list.tabs[0].active === true, JSON.stringify(list.tabs))
    check('tabs 带 url 与 title', list.tabs[0].url.endsWith('/a') && list.tabs[0].title === 'page-a', JSON.stringify(list.tabs[0]))
    check('tabs 带 loading / origin（created）字段', typeof list.tabs[0].loading === 'boolean'
      && list.tabs[0].loading === false && list.tabs[0].origin === 'created', JSON.stringify(list.tabs[0]))
  }

  console.log('== 用例 2：new_tab 新建页并设为 active ==')
  {
    const second = await navigate(KEY, `${base}/b`, 'load', SID, { new_tab: true })
    check('new_tab 生成 t2 且标记 newTab', second.tabId === 't2' && second.newTab === true, JSON.stringify(second))
    const list = await tabs(KEY)
    check('现在有 2 个页', list.tabs.length === 2, JSON.stringify(list.tabs))
    check('t2 成为 active', list.activeTabId === 't2' && list.tabs.find((t) => t.tab_id === 't2').active === true, JSON.stringify(list))
    check('顺序稳定为 t1 / t2', JSON.stringify(list.tabs.map((t) => t.tab_id)) === JSON.stringify(['t1', 't2']), JSON.stringify(list.tabs.map((t) => t.tab_id)))
  }

  console.log('== 用例 3：ref 表按页隔离 ==')
  {
    const snapA = await snapshot(KEY, SID, 't1')
    const refA = refOf(snapA, 'A Button')
    check('t1 快照拿到 A 按钮 ref', Boolean(refA), snapA.text)
    const hitA = await evaluate(KEY, 'window.__hit || null', SID, 't1')
    check('t1 初始未点击', hitA.value === null, JSON.stringify(hitA.value))

    const clickedA = await click(KEY, { ref: refA }, SID, 't1')
    await sleep(100)
    const afterA = await evaluate(KEY, "window.__hit || ''", SID, 't1')
    check('带 tab_id 点击 t1 生效', afterA.value === 'a', `${JSON.stringify(clickedA)} hit=${JSON.stringify(afterA.value)}`)

    // 同一个 ref 在 t2 上不存在：ref 表按页隔离。
    const message = await expectThrow(() => click(KEY, { ref: refA }, SID, 't2'))
    check('t1 的 ref 在 t2 上失效', Boolean(message) && message.includes('不存在'), String(message))

    const snapB = await snapshot(KEY, SID, 't2')
    const refB = refOf(snapB, 'B Button')
    check('t2 快照是 B 按钮', Boolean(refB), snapB.text)
    await click(KEY, { ref: refB }, SID, 't2')
    await sleep(100)
    const hitB = await evaluate(KEY, "window.__hit || ''", SID, 't2')
    check('点击 t2 生效', hitB.value === 'b', JSON.stringify(hitB.value))
  }

  console.log('== 用例 4：缺省 tab_id 用 active tab ==')
  {
    const list = await tabs(KEY)
    check('active 仍是 t2', list.activeTabId === 't2', JSON.stringify(list.activeTabId))
    // 缺省 snapshot 应读到 t2 的 B 按钮。
    const snap = await snapshot(KEY, SID)
    check('缺省快照作用于 active（t2）', snap.tabId === 't2' && snap.text.includes('B Button'), `${snap.tabId} ${snap.text}`)
    // 切回 t1：导航到 t1 后 active 变成 t1。
    await navigate(KEY, `${base}/a`, 'load', SID, { tab_id: 't1' })
    const after = await tabs(KEY)
    check('带 tab_id 导航后 active 切到 t1', after.activeTabId === 't1', JSON.stringify(after.activeTabId))
    const snapDefault = await snapshot(KEY, SID)
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
    const message = await expectThrow(() => snapshot(KEY, SID, 't9'))
    check('snapshot 未知 tab 报错', Boolean(message) && message.includes('不存在'), String(message))
    const clickMessage = await expectThrow(() => click(KEY, { selector: '#btn' }, SID, 't9'))
    check('click 未知 tab 报错', Boolean(clickMessage) && clickMessage.includes('不存在'), String(clickMessage))
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
