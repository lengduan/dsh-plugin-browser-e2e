/**
 * browser_e2e_fetch 能力验证（规格：specs/功能规格/0036-web-fetch-browser.md，仅 B 切片）。
 *
 * 覆盖：
 *   - 正常抓取：最终 URL / 状态码 / 标题、正文关键文本、隐藏节点与 script / style 文本剔除、
 *     302 后返回最终地址、缺省 truncated / empty；
 *   - 参数与错误：url 非字符串 / 相对地址 / 非 http(s)、settleMs / timeoutMs / maxChars
 *     越界、未知 tab_id、未启动；
 *   - 临时页隔离：不改变当前页 URL、不改变 tabs 数量与 activeTabId、不写 ref 表、
 *     不向 console / network 环形缓冲新增记录、面板 tab 列表不变、临时页不进 session.pages、
 *     抓取结束后浏览器 pages 数回到抓取前；
 *   - 正文与边界：maxChars 截断并置 truncated、缺省按 16000 截断、settleMs 等待延迟渲染、
 *     非 2xx 返回结果不抛错、图片响应返回 empty 与状态码、空正文不抛错且工具层给出提示；
 *   - 超时与关页：导航超过 timeoutMs 报「获取超时」、失败路径不留下额外页面；
 *   - 工具契约：参数 schema 与工具层三段文本；
 *   - 收尾：msedge 主进程回落到运行前基线。
 *
 * CDP 模式差异（登录态共享 / 不新增标签页 / 页面数回落）在 tests/cdp.mjs 验证：
 * isolated 模式每个标签页各自一个 context，没有跨页 Cookie 可共享，只验证抓取正常返回。
 *
 * 直接调用 lib/fetch.js / lib/tools.js 的真实实现（不 mock），真起无头 Edge；
 * HTTP 夹具由 node:http 在 127.0.0.1 随机端口提供，不依赖外网。
 * 运行：node tests/fetch.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, listPanelTabs, requireSession, tabs } = await import('../lib/session.js')
const { consoleEntries, currentTab, networkEntries, navigate, snapshot } = await import('../lib/page.js')
const {
  FETCH_DEFAULT_SETTLE_MS, FETCH_DEFAULT_TIMEOUT_MS, FETCH_MAX_SETTLE_MS, FETCH_MAX_TEXT_CHARS,
  FETCH_TIMEOUT_MAX_MS, FETCH_TIMEOUT_MIN_MS, fetchText,
} = await import('../lib/fetch.js')
const { READ_TEXT_LIMIT } = await import('../lib/read.js')

const KEY = 'test-fetch-key'
const SID = 'test-fetch-session'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 轮询直到条件成立；进程退出是异步的，固定 sleep 会偶发失败。 */
async function waitUntil(fn, timeoutMs = 10000, stepMs = 250) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(stepMs)
  }
}

let pass = 0
let fail = 0
/** 逐条判定：断言用 node:assert/strict（失败不中断，继续跑完拿到完整清单）。 */
function check(label, ok, detail) {
  try {
    assert.ok(ok, detail)
    pass += 1
    console.log(`  PASS  ${label}`)
  } catch {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 期望某次调用抛错，返回错误信息（没抛错返回 null）。 */
async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/** 浏览器当前实际打开的页面数（隔离模式下每页一个 context）。 */
function browserPageCount(session) {
  return session.browser.contexts().reduce((total, context) => total + context.pages().length, 0)
}

const NORMAL_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>fetch-fixture</title></head>
<body>
<main>
  <h1>抓取夹具标题</h1>
  <p id="visible">VISIBLE_MARKER 正常抓取正文标记</p>
  <div style="display:none">HIDDEN_SECRET_TEXT 隐藏节点文本</div>
  <div hidden>HIDDEN2_SECRET_TEXT 隐藏属性文本</div>
  <style>.hidden-node { color: red } STYLE_SECRET_TEXT</style>
  <script>var SCRIPT_SECRET_TEXT = 'SCRIPT_SECRET_TEXT'</script>
</main>
</body>
</html>
`

const SECOND_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>second-fixture</title></head>
<body><p>SECOND_MARKER 第二个标签页</p></body>
</html>
`

const EMPTY_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>empty-fixture</title></head>
<body><script>window.__emptyMarker = 'EMPTY_SCRIPT_TEXT'</script></body>
</html>
`

const LONG_TEXT = 'x'.repeat(400)
const HUGE_TEXT = 'y'.repeat(20000)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/normal') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(NORMAL_HTML)
    return
  }
  if (path === '/second') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(SECOND_HTML)
    return
  }
  if (path === '/redirect') {
    res.writeHead(302, { location: '/normal' })
    res.end()
    return
  }
  if (path === '/empty') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(EMPTY_HTML)
    return
  }
  if (path === '/late') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>late-fixture</title></head>'
      + '<body><p>BASE_MARKER</p><script>setTimeout(function () {'
      + 'var p = document.createElement("p"); p.textContent = "LATE_MARKER"; document.body.appendChild(p)'
      + '}, 700)</script></body></html>')
    return
  }
  if (path === '/long') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>long-fixture</title></head>`
      + `<body><p>${LONG_TEXT}</p></body></html>`)
    return
  }
  if (path === '/huge') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>huge-fixture</title></head>`
      + `<body><p>${HUGE_TEXT}</p></body></html>`)
    return
  }
  if (path === '/missing') {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>missing-fixture</title></head>'
      + '<body><p>NOT_FOUND_MARKER</p></body></html>')
    return
  }
  if (path === '/image.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) })
    res.end(PNG_1X1)
    return
  }
  if (path === '/slow') {
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>slow-fixture</title></head>'
          + '<body><p>SLOW_MARKER</p></body></html>')
      } catch {
        // 测试已结束或连接已断，忽略。
      }
    }, 2500)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('unknown')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const baseline = edgeRootCount()

let session = null

try {
  console.log('== 用例 1：夹具与正常抓取 ==')
  await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
  session = requireSession(KEY)
  const loaded = await navigate(session, `${base}/normal`, 'load')
  check('夹具页加载成功', loaded.url === `${base}/normal` && loaded.title === 'fetch-fixture',
    JSON.stringify({ url: loaded.url, title: loaded.title }))
  const tabId = currentTab(session).id
  const pageUrlBefore = currentTab(session).page.url()

  const { apply } = await import('../lib/index.js')
  const definitions = []
  apply({
    get: () => undefined,
    tools: { register: (definition) => definitions.push(definition) },
    on: () => () => {},
    effect: (factory) => { factory() },
  })
  const fetchTool = definitions.find((definition) => definition.name === 'browser_e2e_fetch')
  const exec = { agent: { id: KEY } }

  {
    const info = await fetchText(session, { url: `${base}/normal` })
    check('抓取返回最终 URL / 状态码 200 / 标题', info.url === `${base}/normal`
      && info.statusCode === 200 && info.title === 'fetch-fixture', JSON.stringify(info))
    check('正文含夹具页关键文本', info.text.includes('VISIBLE_MARKER')
      && info.text.includes('正常抓取正文标记') && info.text.includes('抓取夹具标题'), info.text)
    check('正文不含 script 与隐藏节点文本', !info.text.includes('SCRIPT_SECRET_TEXT')
      && !info.text.includes('STYLE_SECRET_TEXT')
      && !info.text.includes('HIDDEN_SECRET_TEXT')
      && !info.text.includes('HIDDEN2_SECRET_TEXT'), info.text)
    check('缺省返回 tabId / mode / empty / elapsedMs', info.tabId === tabId
      && info.mode === 'isolated' && info.empty === false && info.truncated === false
      && Number.isInteger(info.elapsedMs) && typeof info.summary === 'string', JSON.stringify(info))

    const redirected = await fetchText(session, { url: `${base}/redirect` })
    check('302 后返回最终地址', redirected.url === `${base}/normal`
      && redirected.statusCode === 200 && redirected.text.includes('VISIBLE_MARKER'),
    JSON.stringify({ url: redirected.url, status: redirected.statusCode }))
  }

  console.log('== 用例 2：参数与错误 ==')
  {
    const nonString = await expectThrow(() => fetchText(session, { url: 123 }))
    check('url 非字符串报错', Boolean(nonString)
      && nonString.includes('url 必须是 http / https 的绝对地址') && nonString.includes('123'), nonString)

    const relative = await expectThrow(() => fetchText(session, { url: 'not-a-url' }))
    check('url 非绝对地址报错', Boolean(relative)
      && relative.includes('url 必须是 http / https 的绝对地址') && relative.includes('not-a-url'), relative)

    const ftp = await expectThrow(() => fetchText(session, { url: 'ftp://example.com/x' }))
    check('非 http(s) 协议报错', Boolean(ftp) && ftp.includes('url 只支持 http / https')
      && ftp.includes('ftp:') && ftp.includes('browser_e2e_download'), ftp)

    const badTimeout = await Promise.all([
      expectThrow(() => fetchText(session, { url: `${base}/normal`, timeoutMs: 999 })),
      expectThrow(() => fetchText(session, { url: `${base}/normal`, timeoutMs: 60001 })),
      expectThrow(() => fetchText(session, { url: `${base}/normal`, timeoutMs: 1.5 })),
    ])
    check('timeoutMs 越界报错', badTimeout.every((message) => Boolean(message)
      && message.includes(`timeoutMs 必须是 ${FETCH_TIMEOUT_MIN_MS}..${FETCH_TIMEOUT_MAX_MS} 的整数`)),
    JSON.stringify(badTimeout))

    const badSettle = await Promise.all([
      expectThrow(() => fetchText(session, { url: `${base}/normal`, settleMs: -1 })),
      expectThrow(() => fetchText(session, { url: `${base}/normal`, settleMs: FETCH_MAX_SETTLE_MS + 1 })),
      expectThrow(() => fetchText(session, { url: `${base}/normal`, settleMs: 1.5 })),
    ])
    check('settleMs 越界报错', badSettle.every((message) => Boolean(message)
      && message.includes(`settleMs 必须是 0..${FETCH_MAX_SETTLE_MS} 的整数`)), JSON.stringify(badSettle))

    const badMaxChars = await Promise.all([
      expectThrow(() => fetchText(session, { url: `${base}/normal`, maxChars: 0 })),
      expectThrow(() => fetchText(session, { url: `${base}/normal`, maxChars: FETCH_MAX_TEXT_CHARS + 1 })),
      expectThrow(() => fetchText(session, { url: `${base}/normal`, maxChars: 1.5 })),
    ])
    check('maxChars 越界报错', badMaxChars.every((message) => Boolean(message)
      && message.includes(`maxChars 必须是 1..${FETCH_MAX_TEXT_CHARS} 的整数`)), JSON.stringify(badMaxChars))

    const unknownTab = await expectThrow(() => fetchText(session, { url: `${base}/normal` }, 't999'))
    check('未知 tab_id 报「不存在」', Boolean(unknownTab) && unknownTab.includes('tab t999 不存在')
      && unknownTab.includes('browser_e2e_tabs'), unknownTab)

    const coldKey = 'test-fetch-cold-key'
    const cold = await expectThrow(() => fetchTool.execute({ url: `${base}/normal` }, { agent: { id: coldKey } }))
    check('未启动时报「浏览器尚未启动或没有可用标签页」', Boolean(cold)
      && cold.includes('浏览器尚未启动或没有可用标签页，请先 browser_e2e_start'), cold)
  }

  console.log('== 用例 3：登录态共享（isolated 只验证正常返回）==')
  {
    // isolated 每个标签页各自一个 context，没有跨页 Cookie 可共享；CDP 的 Cookie 用例在 tests/cdp.mjs。
    const isolated = await fetchText(session, { url: `${base}/normal` })
    check('隔离模式下抓取正常返回（不做 Cookie 断言）', isolated.statusCode === 200
      && isolated.mode === 'isolated' && isolated.text.includes('VISIBLE_MARKER'), JSON.stringify(isolated))
  }

  console.log('== 用例 4：不污染既有状态 ==')
  {
    const second = await navigate(session, `${base}/second`, 'load', { new_tab: true })
    const secondTabId = second.tabId
    const firstSnapshot = await snapshot(session, tabId)
    const firstTab = currentTab(session, tabId)

    const stateBefore = {
      tabIds: (await tabs(KEY)).tabs.map((tab) => tab.tab_id),
      activeTabId: session.activeTabId,
      firstUrl: firstTab.page.url(),
      refs: JSON.stringify([...firstTab.refs.entries()]),
      consoleTotal: (await consoleEntries(session, 100, tabId)).total,
      networkTotal: (await networkEntries(session, 100, tabId)).total,
      panelIds: (await listPanelTabs()).map((tab) => tab.id),
      pageKeys: [...session.pages.keys()],
      pageObjects: [...session.pages.values()].map((entry) => entry.page),
      browserPages: browserPageCount(session),
    }

    const fetched = await fetchText(session, { url: `${base}/normal` }, tabId)
    const fetchedSecond = await fetchText(session, { url: `${base}/second` }, secondTabId)

    const stateAfter = {
      tabIds: (await tabs(KEY)).tabs.map((tab) => tab.tab_id),
      activeTabId: session.activeTabId,
      firstUrl: firstTab.page.url(),
      refs: JSON.stringify([...firstTab.refs.entries()]),
      consoleTotal: (await consoleEntries(session, 100, tabId)).total,
      networkTotal: (await networkEntries(session, 100, tabId)).total,
      panelIds: (await listPanelTabs()).map((tab) => tab.id),
      pageKeys: [...session.pages.keys()],
      pageObjects: [...session.pages.values()].map((entry) => entry.page),
      browserPages: browserPageCount(session),
    }

    check('抓取后 tabs 数量不变', stateAfter.tabIds.length === stateBefore.tabIds.length
      && JSON.stringify(stateAfter.tabIds) === JSON.stringify(stateBefore.tabIds),
    JSON.stringify({ before: stateBefore.tabIds, after: stateAfter.tabIds }))
    check('抓取后 activeTabId 不变', stateAfter.activeTabId === stateBefore.activeTabId,
      `${stateBefore.activeTabId} -> ${stateAfter.activeTabId}`)
    check('抓取后当前页 URL 不变', stateAfter.firstUrl === stateBefore.firstUrl
      && stateAfter.firstUrl === pageUrlBefore, `${stateBefore.firstUrl} -> ${stateAfter.firstUrl}`)
    check('抓取后 tab.refs 内容不变', stateAfter.refs === stateBefore.refs,
      JSON.stringify({ before: firstSnapshot.count, after: firstTab.refs.size }))
    check('抓取不向 console / network 环形缓冲新增记录',
      stateAfter.consoleTotal === stateBefore.consoleTotal
        && stateAfter.networkTotal === stateBefore.networkTotal,
      JSON.stringify({ console: [stateBefore.consoleTotal, stateAfter.consoleTotal],
        network: [stateBefore.networkTotal, stateAfter.networkTotal] }))
    check('抓取后面板 tab 列表不含临时页',
      JSON.stringify(stateAfter.panelIds) === JSON.stringify(stateBefore.panelIds),
      JSON.stringify({ before: stateBefore.panelIds, after: stateAfter.panelIds }))
    check('临时页不进 session.pages', JSON.stringify(stateAfter.pageKeys) === JSON.stringify(stateBefore.pageKeys)
      && stateAfter.pageObjects.length === stateBefore.pageObjects.length
      && stateAfter.pageObjects.every((page, index) => page === stateBefore.pageObjects[index]),
    JSON.stringify({ before: stateBefore.pageKeys, after: stateAfter.pageKeys }))
    check('抓取结束后浏览器 pages 数回到抓取前', stateAfter.browserPages === stateBefore.browserPages,
      `${stateBefore.browserPages} -> ${stateAfter.browserPages}`)
    check('显式 tab_id 决定抓取来源', fetched.tabId === tabId && fetchedSecond.tabId === secondTabId,
      JSON.stringify({ first: fetched.tabId, second: fetchedSecond.tabId }))
  }

  console.log('== 用例 5：截断、空正文与非 2xx ==')
  {
    const truncated = await fetchText(session, { url: `${base}/long`, maxChars: 100 })
    check('maxChars 截断并置 truncated', truncated.truncated === true && truncated.text.length === 100
      && truncated.text === LONG_TEXT.slice(0, 100), JSON.stringify({ len: truncated.text.length,
      truncated: truncated.truncated }))

    const huge = await fetchText(session, { url: `${base}/huge` })
    check('maxChars 缺省按 16000 截断', READ_TEXT_LIMIT === 16000 && huge.truncated === true
      && huge.text.length === READ_TEXT_LIMIT, JSON.stringify({ limit: READ_TEXT_LIMIT,
      len: huge.text.length, truncated: huge.truncated }))

    const missing = await fetchText(session, { url: `${base}/missing` })
    check('非 2xx 返回结果不抛错', missing.statusCode === 404 && missing.empty === false
      && missing.text.includes('NOT_FOUND_MARKER'), JSON.stringify(missing))

    const image = await fetchText(session, { url: `${base}/image.png` })
    check('二进制响应返回 empty 与状态码', image.statusCode === 200 && image.empty === true
      && image.text === '', JSON.stringify({ status: image.statusCode, empty: image.empty,
      text: image.text }))

    const empty = await fetchText(session, { url: `${base}/empty` })
    check('正文为空时不抛错', empty.statusCode === 200 && empty.empty === true && empty.text === '',
      JSON.stringify({ status: empty.statusCode, empty: empty.empty }))
    const emptyToolText = String(await fetchTool.execute({ url: `${base}/empty` }, exec))
    check('正文为空时提示改用 navigate + read', emptyToolText.includes('正文为空')
      && emptyToolText.includes('settleMs')
      && emptyToolText.includes('browser_e2e_navigate + browser_e2e_read'), emptyToolText)

    const lateImmediate = await fetchText(session, { url: `${base}/late`, settleMs: 0 })
    const lateSettled = await fetchText(session, { url: `${base}/late`, settleMs: 1500 })
    check('settleMs 等待后能看到延迟渲染文本',
      !lateImmediate.text.includes('LATE_MARKER') && lateSettled.text.includes('LATE_MARKER'),
      JSON.stringify({ immediate: lateImmediate.text, settled: lateSettled.text }))
  }

  console.log('== 用例 6：超时与关页 ==')
  {
    const pagesBefore = browserPageCount(session)
    const tabIdsBefore = (await tabs(KEY)).tabs.map((tab) => tab.tab_id)
    const startedAt = Date.now()
    const timeout = await expectThrow(() => fetchText(session, { url: `${base}/slow`, timeoutMs: 1000 }))
    const timeoutElapsed = Date.now() - startedAt
    check('导航超过 timeoutMs 报「获取超时」', Boolean(timeout)
      && timeout.includes(`获取超时：1000ms 内未完成（${base}/slow）`)
      && timeout.includes('可调大 timeoutMs（上限 60000）') && timeoutElapsed < 5000,
    JSON.stringify({ message: timeout, elapsed: timeoutElapsed }))

    const pagesAfter = browserPageCount(session)
    const tabIdsAfter = (await tabs(KEY)).tabs.map((tab) => tab.tab_id)
    check('失败路径不留下额外页面（浏览器 pages 数回到抓取前）',
      pagesAfter === pagesBefore && JSON.stringify(tabIdsAfter) === JSON.stringify(tabIdsBefore),
      JSON.stringify({ pages: [pagesBefore, pagesAfter], tabs: [tabIdsBefore, tabIdsAfter] }))
  }

  console.log('== 用例 7：工具契约与工具层文本 ==')
  {
    check('browser_e2e_fetch 注册且参数契约完整', Boolean(fetchTool)
      && ['url', 'settleMs', 'timeoutMs', 'maxChars', 'tab_id']
        .every((field) => field in fetchTool.parameters.properties)
      && JSON.stringify(fetchTool.parameters.required) === JSON.stringify(['url'])
      && fetchTool.parameters.additionalProperties === false,
    JSON.stringify(fetchTool?.parameters))

    check('抓取常量与规格一致', FETCH_DEFAULT_SETTLE_MS === 400 && FETCH_MAX_SETTLE_MS === 5000
      && FETCH_DEFAULT_TIMEOUT_MS === 25000 && FETCH_TIMEOUT_MIN_MS === 1000
      && FETCH_TIMEOUT_MAX_MS === 60000 && FETCH_MAX_TEXT_CHARS === 180000
      && READ_TEXT_LIMIT === 16000,
    JSON.stringify({ settle: FETCH_DEFAULT_SETTLE_MS, maxSettle: FETCH_MAX_SETTLE_MS,
      timeout: FETCH_DEFAULT_TIMEOUT_MS, maxChars: FETCH_MAX_TEXT_CHARS }))

    const toolText = String(await fetchTool.execute({ url: `${base}/normal`, tab_id: tabId }, exec))
    const lines = toolText.split('\n')
    check('工具层输出摘要 / 标题 / 来源三段', /^获取 127\.0\.0\.1:\d+\/normal（HTTP 200，正文 \d+ 字符）$/.test(lines[0])
      && lines[1] === '标题：fetch-fixture'
      && lines[2] === `来源标签页：${tabId}（隔离）`
      && lines[3] === '' && lines.slice(4).join('\n').includes('VISIBLE_MARKER'),
    JSON.stringify(lines.slice(0, 4)))

    const truncatedToolText = String(await fetchTool.execute({ url: `${base}/long`, maxChars: 32, tab_id: tabId }, exec))
    check('工具层摘要标明截断与正文长度', truncatedToolText.includes('，已截断）')
      && truncatedToolText.split('\n').slice(4).join('\n').trim().length === 32,
    truncatedToolText.slice(0, 160))

    const unknownToolTab = await expectThrow(() => fetchTool.execute({ url: `${base}/normal`, tab_id: 't999' }, exec))
    check('工具层未知 tab_id 报「不存在」', Boolean(unknownToolTab)
      && unknownToolTab.includes('tab t999 不存在'), unknownToolTab)
  }
} finally {
  await closeAll()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const remaining = edgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline,
  `baseline=${baseline} remaining=${remaining}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
