/**
 * P0-4「等待 URL / 等待响应」验收测试。
 *
 * 覆盖 specs/功能规格/0013-wait-url-and-response.md「验收」第 1 条的全部用例：
 *   - url 组：当前地址立即命中、未来导航、glob、regex、SPA pushState、超时诊断、
 *     tab_id 作用域、等待期间关页；
 *   - response 组：未来到达、缓冲命中、includeBuffered=false、导航后旧文档缓冲失效、
 *     method / status 过滤、超时诊断、请求失败两种口径、等待期间关页、临时监听移除；
 *   - 校验组：四选一、条件专属参数错配、非法 urlMatch / regex / responseMethod /
 *     status 区间 / timeoutMs。
 *
 * 直接调用 lib/page.js 的 waitFor 真实实现（不 mock），真起无头 Edge；
 * 夹具是 node:http 在 127.0.0.1 随机端口起的本地服务（另起一个随即关闭的端口制造连接拒绝），
 * 不依赖外网。触发请求时表达式立即返回字符串，避免 evaluate 等待 fetch 的 Promise。
 *
 * 运行：node tests/wait.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { currentTab, evaluate, navigate, networkEntries, waitFor } = await import('../lib/page.js')

const KEY = 'test-wait-key'
const SID = 'test-wait-session'
let session = null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

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

/** 期望某次调用抛错，返回错误信息（没抛错返回 null）。 */
async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/** 跑一个用例：函数内部自己 check；抛意外错误时按同名用例记 FAIL，不中断后续用例。 */
async function runCase(label, fn) {
  try {
    await fn()
  } catch (error) {
    check(label, false, `抛出意外错误：${error?.message ?? error}`)
  }
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

const baseline = edgeRootCount()

// 本地夹具：/api/* 返回 JSON，其余路径返回简单 HTML；/api/status/<code> 返回指定状态码。
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.startsWith('/api/status/')) {
    const code = Number(path.split('/').pop())
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code }))
    return
  }
  if (path.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ path, method: req.method }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>${path}</title></head><body><h1 id="title">${path}</h1></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// 请求失败夹具：先监听拿到端口再关掉，fetch 该端口会得到连接拒绝（requestfailed）。
const deadServer = createServer(() => {})
await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
const deadPort = deadServer.address().port
await new Promise((resolve) => deadServer.close(resolve))
const deadBase = `http://127.0.0.1:${deadPort}`

/** 触发一个后台 fetch；表达式立即返回字符串，避免 evaluate 等 fetch 的 Promise。 */
function fireFetch(url, tabId) {
  return evaluate(session, `fetch(${JSON.stringify(url)}).catch(function () {}); 'started'`, tabId)
}

/** 触发 fetch 并等它完成（响应已进网络环），返回状态码。 */
async function fetchAndWait(url, tabId) {
  const result = await evaluate(session, `fetch(${JSON.stringify(url)}).then(function (r) { return r.status }).catch(function () { return -1 })`, tabId)
  await sleep(150)
  return result.value
}

/** 读取页面上的临时监听计数（waitFor 只允许在等待期间挂 response / requestfailed / close / crash）。 */
function listenerCounts(page) {
  return {
    response: page.listenerCount('response'),
    requestfailed: page.listenerCount('requestfailed'),
    close: page.listenerCount('close'),
    crash: page.listenerCount('crash'),
  }
}

try {
  console.log('== 前置：启动无头 Edge ==')
  await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
  session = requireSession(KEY)

  // ---------------- url 组（8 个用例） ----------------

  await runCase('wait url 当前地址立即命中（matchedCurrent）', async () => {
    console.log('== url 组 ==')
    await navigate(session, `${base}/wait-current`, 'load')
    const info = await waitFor(session, { url: '/wait-current', timeoutMs: 3000 })
    check('wait url 当前地址立即命中（matchedCurrent）',
      info.mode === 'url' && info.matchedCurrent === true
      && info.matchedUrl === `${base}/wait-current` && info.urlMatch === 'includes'
      && info.tabId === session.activeTabId && info.elapsedMs < 200
      && info.summary.includes('当前地址已满足'),
      JSON.stringify(info))
  })

  await runCase('wait url 等待未来导航', async () => {
    await navigate(session, `${base}/future-start`, 'load')
    await evaluate(session, `setTimeout(function () { location.href = ${JSON.stringify(`${base}/future-arrival`)} }, 300); 'scheduled'`)
    const info = await waitFor(session, { url: '/future-arrival', timeoutMs: 5000 })
    check('wait url 等待未来导航',
      info.mode === 'url' && info.matchedCurrent === false
      && info.matchedUrl === `${base}/future-arrival`
      && info.elapsedMs >= 200 && info.summary.includes('等待期间导航到达'),
      JSON.stringify(info))
  })

  await runCase('wait url glob 匹配', async () => {
    await navigate(session, `${base}/glob/deep/x`, 'load')
    const info = await waitFor(session, { url: '**/glob/*/x', urlMatch: 'glob', timeoutMs: 3000 })
    check('wait url glob 匹配',
      info.mode === 'url' && info.urlMatch === 'glob' && info.matchedCurrent === true
      && info.matchedUrl === `${base}/glob/deep/x`,
      JSON.stringify(info))
  })

  await runCase('wait url regex 匹配', async () => {
    await navigate(session, `${base}/rx/123`, 'load')
    const info = await waitFor(session, { url: '/rx/\\d+$', urlMatch: 'regex', timeoutMs: 3000 })
    check('wait url regex 匹配',
      info.mode === 'url' && info.urlMatch === 'regex' && info.matchedCurrent === true
      && info.matchedUrl === `${base}/rx/123`,
      JSON.stringify(info))
  })

  await runCase('wait url 跟随 SPA pushState', async () => {
    await navigate(session, `${base}/spa`, 'load')
    await evaluate(session, "setTimeout(function () { history.pushState({}, '', '/spa-step2') }, 300); 'scheduled'")
    const info = await waitFor(session, { url: '/spa-step2', timeoutMs: 3000 })
    check('wait url 跟随 SPA pushState',
      info.mode === 'url' && info.matchedCurrent === false
      && info.matchedUrl.endsWith('/spa-step2') && info.elapsedMs >= 200,
      JSON.stringify(info))
  })

  await runCase('wait url 超时报当前地址', async () => {
    await navigate(session, `${base}/url-timeout`, 'load')
    const message = await expectThrow(() => waitFor(session, { url: '/never-here', timeoutMs: 500 }))
    check('wait url 超时报当前地址',
      Boolean(message) && message.includes('等待 URL 匹配超时')
      && /实际等待 \d+ms/.test(message) && message.includes('上限 500ms')
      && message.includes(`${base}/url-timeout`),
      String(message))
  })

  await runCase('wait url 按 tab_id 作用于指定标签页', async () => {
    const tabOne = await navigate(session, `${base}/tab-one`, 'load')
    const tabTwo = await navigate(session, `${base}/tab-two`, 'load', { new_tab: true })
    // active tab 是刚新建的 tabTwo；显式 tab_id 必须读到 tabOne 的地址。
    const info = await waitFor(session, { url: '/tab-one', timeoutMs: 3000, tab_id: tabOne.tabId })
    check('wait url 按 tab_id 作用于指定标签页',
      info.tabId === tabOne.tabId && info.matchedUrl === `${base}/tab-one`
      && session.activeTabId === tabTwo.tabId && currentTab(session).id === tabTwo.tabId,
      JSON.stringify({ info, activeTabId: session.activeTabId, tabTwo: tabTwo.tabId }))
  })

  await runCase('wait url 期间关页报标签页已关闭', async () => {
    const tabClose = await navigate(session, `${base}/url-close`, 'load', { new_tab: true })
    const pending = expectThrow(() => waitFor(session, { url: '/url-close-target', timeoutMs: 5000, tab_id: tabClose.tabId }))
    await sleep(300)
    await currentTab(session, tabClose.tabId).page.close()
    const message = await pending
    check('wait url 期间关页报标签页已关闭',
      Boolean(message) && message.includes('等待 URL 期间标签页已关闭') && message.includes(tabClose.tabId),
      String(message))
  })

  // ---------------- response 组（11 个用例） ----------------

  await runCase('wait response 等待期间到达（buffered=false）', async () => {
    console.log('== response 组 ==')
    await navigate(session, `${base}/resp-live-page`, 'load')
    const pending = waitFor(session, { response: '/api/live', timeoutMs: 5000 })
    await sleep(100)
    await fireFetch(`${base}/api/live`)
    const info = await pending
    check('wait response 等待期间到达（buffered=false）',
      info.mode === 'response' && info.matchedResponse.buffered === false
      && info.matchedResponse.url === `${base}/api/live`
      && info.matchedResponse.method === 'GET' && info.matchedResponse.status === 200
      && info.matchedResponse.mimeType.includes('application/json')
      && info.responseMethod === null && info.statusMin === 100 && info.statusMax === 599
      && info.includeBuffered === true && info.summary.includes('等待期间到达'),
      JSON.stringify(info))
  })

  await runCase('wait response 已缓冲命中（buffered=true）', async () => {
    await navigate(session, `${base}/resp-buffered-page`, 'load')
    await fetchAndWait(`${base}/api/buffered`)
    const info = await waitFor(session, { response: '/api/buffered', timeoutMs: 3000 })
    check('wait response 已缓冲命中（buffered=true）',
      info.mode === 'response' && info.matchedResponse.buffered === true
      && info.matchedResponse.url === `${base}/api/buffered`
      && info.matchedResponse.status === 200 && info.elapsedMs < 500
      && info.summary.includes('调用前已缓冲'),
      JSON.stringify(info))
  })

  await runCase('wait response includeBuffered=false 时已到达响应导致超时', async () => {
    await navigate(session, `${base}/resp-buffer-off-page`, 'load')
    await fetchAndWait(`${base}/api/buffered`)
    const message = await expectThrow(() => waitFor(session, { response: '/api/buffered', includeBuffered: false, timeoutMs: 600 }))
    check('wait response includeBuffered=false 时已到达响应导致超时',
      Boolean(message) && message.includes('等待响应超时')
      && /实际等待 \d+ms/.test(message) && message.includes('上限 600ms')
      && message.includes('已缓冲响应'),
      String(message))
  })

  await runCase('wait response 导航后旧文档缓冲不参与匹配', async () => {
    await navigate(session, `${base}/doc1`, 'load')
    await fetchAndWait(`${base}/api/doc1-only`)
    const before = await networkEntries(session, 100)
    await navigate(session, `${base}/doc2`, 'load')
    const after = await networkEntries(session, 100)
    const message = await expectThrow(() => waitFor(session, { response: '/api/doc1-only', timeoutMs: 600 }))
    check('wait response 导航后旧文档缓冲不参与匹配',
      before.text.includes('/api/doc1-only') && !after.text.includes('/api/doc1-only')
      && Boolean(message) && message.includes('等待响应超时'),
      JSON.stringify({ inBefore: before.text.includes('/api/doc1-only'), inAfter: after.text.includes('/api/doc1-only'), message }))
  })

  await runCase('wait response method 过滤', async () => {
    await navigate(session, `${base}/resp-method-page`, 'load')
    await fetchAndWait(`${base}/api/method`)
    const pending = waitFor(session, { response: '/api/method', responseMethod: 'post', timeoutMs: 5000 })
    await sleep(100)
    await evaluate(session, `fetch(${JSON.stringify(`${base}/api/method`)}, { method: 'POST', body: 'x' }).catch(function () {}); 'started'`)
    const info = await pending
    check('wait response method 过滤',
      info.matchedResponse.method === 'POST' && info.matchedResponse.buffered === false
      && info.responseMethod === 'POST',
      JSON.stringify(info))
  })

  await runCase('wait response status 区间过滤', async () => {
    await navigate(session, `${base}/resp-status-page`, 'load')
    await fetchAndWait(`${base}/api/status/404`)
    const info = await waitFor(session, { response: '/api/status', statusMin: 400, statusMax: 499, timeoutMs: 3000 })
    check('wait response status 区间过滤',
      info.matchedResponse.status === 404 && info.matchedResponse.buffered === true
      && info.statusMin === 400 && info.statusMax === 499,
      JSON.stringify(info))
  })

  await runCase('wait response 状态不符时超时错误列出已捕获响应', async () => {
    await navigate(session, `${base}/resp-near-miss-page`, 'load')
    await fetchAndWait(`${base}/api/status/404`)
    const message = await expectThrow(() => waitFor(session, { response: '/api/status', statusMin: 200, statusMax: 299, timeoutMs: 600 }))
    check('wait response 状态不符时超时错误列出已捕获响应',
      Boolean(message) && message.includes('URL/method 命中但状态不符')
      && message.includes('404') && message.includes('status=200-299')
      && message.includes('已缓冲响应'),
      String(message))
  })

  await runCase('wait response 请求失败默认立即报错', async () => {
    await navigate(session, `${base}/resp-fail-page`, 'load')
    const pending = expectThrow(() => waitFor(session, { response: '/api/fail-target', timeoutMs: 5000 }))
    await sleep(100)
    await fireFetch(`${deadBase}/api/fail-target`)
    const message = await pending
    check('wait response 请求失败默认立即报错',
      Boolean(message) && message.includes('等待的请求在响应前失败')
      && message.includes('/api/fail-target') && message.includes('failOnRequestFailed=false')
      && /net::|ERR_/.test(message),
      String(message))
  })

  await runCase('wait response failOnRequestFailed=false 时超时错误列出失败请求', async () => {
    await navigate(session, `${base}/resp-fail-keep-page`, 'load')
    const pending = expectThrow(() => waitFor(session, {
      response: '/api/fail-target', failOnRequestFailed: false, timeoutMs: 900,
    }))
    await sleep(100)
    await fireFetch(`${deadBase}/api/fail-target?n=1`)
    const message = await pending
    check('wait response failOnRequestFailed=false 时超时错误列出失败请求',
      Boolean(message) && message.includes('等待响应超时')
      && message.includes('匹配的失败请求') && message.includes('/api/fail-target')
      && /net::|ERR_/.test(message),
      String(message))
  })

  await runCase('wait response 期间关页报标签页已关闭', async () => {
    const tabClose = await navigate(session, `${base}/resp-close-page`, 'load', { new_tab: true })
    const pending = expectThrow(() => waitFor(session, { response: '/never-response', timeoutMs: 5000, tab_id: tabClose.tabId }))
    await sleep(300)
    await currentTab(session, tabClose.tabId).page.close()
    const message = await pending
    check('wait response 期间关页报标签页已关闭',
      Boolean(message) && message.includes('等待响应期间标签页已关闭') && message.includes(tabClose.tabId),
      String(message))
  })

  await runCase('wait 结束后临时监听已移除', async () => {
    await navigate(session, `${base}/listener-page`, 'load')
    const page = currentTab(session).page
    const before = listenerCounts(page)
    await waitFor(session, { url: '/listener-page', timeoutMs: 2000 })
    await expectThrow(() => waitFor(session, { response: '/api/listener-never', timeoutMs: 400 }))
    const after = listenerCounts(page)
    check('wait 结束后临时监听已移除',
      JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify({ before, after }))
  })

  // ---------------- 校验组（9 个用例） ----------------

  await runCase('wait 四种条件都不给报错', async () => {
    console.log('== 校验组 ==')
    const none = await expectThrow(() => waitFor(session, {}))
    const empty = await expectThrow(() => waitFor(session, { selector: '', expression: '', url: '', response: '' }))
    check('wait 四种条件都不给报错',
      Boolean(none) && none.includes('四选一') && none.includes('当前收到：无')
      && Boolean(empty) && empty.includes('四选一') && empty.includes('当前收到：无'),
      JSON.stringify({ none, empty }))
  })

  await runCase('wait 同时给两个条件报四选一', async () => {
    const message = await expectThrow(() => waitFor(session, { url: '/a', response: '/b' }))
    check('wait 同时给两个条件报四选一',
      Boolean(message) && message.includes('四选一') && message.includes('当前收到：url、response'),
      String(message))
  })

  await runCase('wait selector 与 expression 同时给仍报二选一', async () => {
    const message = await expectThrow(() => waitFor(session, { selector: '#x', expression: 'true' }))
    check('wait selector 与 expression 同时给仍报二选一',
      Boolean(message) && message.includes('二选一') && message.includes('当前收到：selector、expression'),
      String(message))
  })

  await runCase('wait urlMatch 非法报错', async () => {
    const message = await expectThrow(() => waitFor(session, { url: '/x', urlMatch: 'fuzzy' }))
    check('wait urlMatch 非法报错',
      Boolean(message) && message.includes('不支持的 urlMatch')
      && message.includes('includes') && message.includes('glob') && message.includes('regex'),
      String(message))
  })

  await runCase('wait regex 非法报错', async () => {
    const message = await expectThrow(() => waitFor(session, { url: '(', urlMatch: 'regex' }))
    check('wait regex 非法报错',
      Boolean(message) && message.includes('正则无效') && message.includes('urlMatch=includes'),
      String(message))
  })

  await runCase('wait responseMethod 空串报错', async () => {
    const message = await expectThrow(() => waitFor(session, { response: '/x', responseMethod: '' }))
    check('wait responseMethod 空串报错',
      Boolean(message) && message.includes('responseMethod 不能是空字符串'),
      String(message))
  })

  await runCase('wait status 区间非法或倒置报错', async () => {
    const below = await expectThrow(() => waitFor(session, { response: '/x', statusMin: 99 }))
    const above = await expectThrow(() => waitFor(session, { response: '/x', statusMax: 700 }))
    const inverted = await expectThrow(() => waitFor(session, { response: '/x', statusMin: 500, statusMax: 400 }))
    const fraction = await expectThrow(() => waitFor(session, { response: '/x', statusMin: 200.5 }))
    check('wait status 区间非法或倒置报错',
      Boolean(below) && below.includes('100-599') && below.includes('statusMin=99')
      && Boolean(above) && above.includes('100-599') && above.includes('statusMax=700')
      && Boolean(inverted) && inverted.includes('statusMin 不能大于 statusMax')
      && Boolean(fraction) && fraction.includes('100-599'),
      JSON.stringify({ below, above, inverted, fraction }))
  })

  await runCase('wait 条件专属参数错配报错', async () => {
    const stateMisuse = await expectThrow(() => waitFor(session, { url: '/x', state: 'visible' }))
    const urlMatchMisuse = await expectThrow(() => waitFor(session, { selector: '#x', urlMatch: 'glob' }))
    const responseMethodMisuse = await expectThrow(() => waitFor(session, { url: '/x', responseMethod: 'GET' }))
    const bufferedMisuse = await expectThrow(() => waitFor(session, { selector: '#x', includeBuffered: false }))
    check('wait 条件专属参数错配报错',
      Boolean(stateMisuse) && stateMisuse.includes('state 只对 selector 条件有效')
      && Boolean(urlMatchMisuse) && urlMatchMisuse.includes('urlMatch 只对 url / response 条件有效')
      && Boolean(responseMethodMisuse) && responseMethodMisuse.includes('只对 response 条件有效')
      && Boolean(bufferedMisuse) && bufferedMisuse.includes('只对 response 条件有效'),
      JSON.stringify({ stateMisuse, urlMatchMisuse, responseMethodMisuse, bufferedMisuse }))
  })

  await runCase('wait 非正整数 timeoutMs 报错', async () => {
    const zero = await expectThrow(() => waitFor(session, { url: '/x', timeoutMs: 0 }))
    const negative = await expectThrow(() => waitFor(session, { url: '/x', timeoutMs: -1 }))
    const fraction = await expectThrow(() => waitFor(session, { url: '/x', timeoutMs: 1.5 }))
    const string = await expectThrow(() => waitFor(session, { url: '/x', timeoutMs: '1000' }))
    check('wait 非正整数 timeoutMs 报错',
      [zero, negative, fraction, string].every((message) => Boolean(message) && message.includes('timeoutMs 必须是正整数')),
      JSON.stringify({ zero, negative, fraction, string }))
  })
} finally {
  await closeAll()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const remaining = edgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）`)
process.exit(fail === 0 ? 0 : 1)
