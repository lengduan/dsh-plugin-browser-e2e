/**
 * browser_e2e_http 能力验证（规格：specs/功能规格/0035-raw-cdp-http.md，仅 B1 切片 mode=context）。
 *
 * 覆盖：
 *   - 正常路径：GET 文本正文、POST JSON body 与响应回显、自定义请求头、响应头对象、
 *     非 2xx 不抛错、重定向 finalUrl、当前页 Cookie、HEAD 无正文；
 *   - 正文视图：文本 chars / bytes / sha256 / truncated、max_chars 截断、二进制只给
 *     bytes 与 sha256（不返回文本）、敏感响应头脱敏、工具层摘要与正文两段；
 *   - 参数与错误：url 缺失 / 非 http(s)、method 非法、GET / HEAD 带 body、headers
 *     非对象与超限、body 超限、timeout_ms / max_chars 越界、mode=server / cdp 被拒、
 *     未知 tab_id、未启动、请求超时、连接失败；
 *   - 隔离与状态：不改变当前页 URL、不新增标签页、不写 console / network 环、不落盘；
 *   - 收尾：msedge 主进程回落到运行前基线。
 *
 * 直接调用 lib/raw.js / lib/tools.js 的真实实现（不 mock），真起无头 Edge；
 * HTTP 夹具由 node:http 在 127.0.0.1 随机端口提供，不依赖外网。
 * 运行：node tests/raw-http.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'
// 本测试会经 index.js 接线执行工具：历史写入关闭，避免污染真实 ~/.dsh 历史目录。
process.env.DSH_BROWSER_HISTORY = '0'
// 避免宿主环境里遗留的覆盖目录影响「不落盘」用例。
delete process.env.DSH_BROWSER_DOWNLOAD_DIR

const { closeAll, launch, requireSession, tabs } = await import('../lib/session.js')
const { consoleEntries, currentTab, networkEntries, navigate } = await import('../lib/page.js')
const { rawHttp } = await import('../lib/raw.js')

const KEY = 'test-raw-http-key'
const SID = 'test-raw-http-session'
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

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex')

const TEXT_BODY = 'hello raw http 中文正文\n'
const JSON_BODY = JSON.stringify({ ok: true, label: 'json-body' })
const BIG_TEXT = 'x'.repeat(2000)
const BINARY_BODY = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256))

const PAGE_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>raw-http-fixture</title></head>
<body><p>raw http fixture</p></body>
</html>
`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE_HTML)
    return
  }
  if (path === '/text') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-fixture': 'yes' })
    res.end(TEXT_BODY)
    return
  }
  if (path === '/json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON_BODY)
    return
  }
  if (path === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(BINARY_BODY)
    return
  }
  if (path === '/big-text') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(BIG_TEXT)
    return
  }
  if (path === '/echo') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    return
  }
  if (path === '/status/404') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (path === '/redirect') {
    res.writeHead(302, { location: '/text' })
    res.end()
    return
  }
  if (path === '/cookie') {
    if (!String(req.headers.cookie ?? '').includes('e2e-cookie=ok')) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('cookie missing')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('cookie-ok')
    return
  }
  if (path === '/sensitive') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'set-cookie': 'sid=secret',
      authorization: 'Bearer secret',
      'x-visible': 'ok',
    })
    res.end('sensitive')
    return
  }
  if (path === '/slow') {
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('slow-body')
      } catch {
        // 测试已结束或连接已断，忽略。
      }
    }, 3000)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('unknown')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// 连接失败夹具：先在空闲端口起一个服务器再关掉，保证端口当前无人监听。
const deadServer = createServer((_req, res) => res.end('dead'))
await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
const deadBase = `http://127.0.0.1:${deadServer.address().port}`
await new Promise((resolve) => deadServer.close(resolve))

const baseline = edgeRootCount()

/** 产物目录当前的文件清单（相对路径；目录不存在时为空）。 */
function artifactFiles(session) {
  if (!session.artifactsDir || !existsSync(session.artifactsDir)) return []
  return readdirSync(session.artifactsDir, { recursive: true }).map(String).sort()
}

let session = null

try {
  console.log('== 用例 1：正常路径 ==')
  await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
  session = requireSession(KEY)
  const loaded = await navigate(session, `${base}/page`, 'load')
  const pageUrlBefore = loaded.url

  const { apply } = await import('../lib/index.js')
  const definitions = []
  apply({
    get: () => undefined,
    tools: { register: (definition) => definitions.push(definition) },
    on: () => () => {},
    effect: (factory) => { factory() },
  })
  const httpTool = definitions.find((definition) => definition.name === 'browser_e2e_http')
  const exec = { agent: { id: KEY } }

  {
    const info = await rawHttp(session, { url: `${base}/text` })
    check('GET 返回 200 与文本正文', info.mode === 'context' && info.url === `${base}/text`
      && info.finalUrl === `${base}/text` && info.status === 200 && info.ok === true
      && info.body.kind === 'text' && info.body.text === TEXT_BODY
      && info.body.chars === TEXT_BODY.length && info.body.bytes === Buffer.byteLength(TEXT_BODY)
      && info.body.truncated === false && info.body.sha256 === sha256Of(Buffer.from(TEXT_BODY))
      && Number.isInteger(info.elapsedMs), JSON.stringify(info))

    const payload = JSON.stringify({ hello: 'world' })
    const post = await rawHttp(session, {
      url: `${base}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raw-test': 'post-header' },
      body: payload,
    })
    const echoed = post.body.kind === 'text' ? JSON.parse(post.body.text) : null
    check('POST 带 JSON body 与响应回显', post.status === 200 && echoed !== null
      && echoed.method === 'POST' && echoed.body === payload, JSON.stringify(post))
    check('自定义请求头被服务端收到', echoed?.headers?.['x-raw-test'] === 'post-header'
      && echoed?.headers?.['content-type'] === 'application/json', JSON.stringify(echoed?.headers))

    check('响应头按对象返回', info.headers !== null && typeof info.headers === 'object'
      && !Array.isArray(info.headers) && info.headers['x-fixture'] === 'yes'
      && /^text\/plain/.test(String(info.headers['content-type'])), JSON.stringify(info.headers))

    const missing = await rawHttp(session, { url: `${base}/status/404` })
    check('非 2xx 返回状态不抛错', missing.status === 404 && missing.ok === false
      && missing.body.kind === 'text' && missing.body.text === 'not found', JSON.stringify(missing))

    const redirected = await rawHttp(session, { url: `${base}/redirect` })
    check('redirect 后 finalUrl 是最终地址', redirected.url === `${base}/redirect`
      && redirected.finalUrl === `${base}/text` && redirected.status === 200
      && redirected.redirect?.finalUrl === `${base}/text` && redirected.redirect?.count === 1,
    JSON.stringify({ url: redirected.url, finalUrl: redirected.finalUrl, redirect: redirected.redirect }))

    await currentTab(session).page.context().addCookies([{ name: 'e2e-cookie', value: 'ok', url: base }])
    const cookieInfo = await rawHttp(session, { url: `${base}/cookie` })
    check('context 模式带上当前页 Cookie', cookieInfo.status === 200
      && cookieInfo.body.text === 'cookie-ok', JSON.stringify(cookieInfo))

    const binary = await rawHttp(session, { url: `${base}/binary` })
    check('二进制正文只给 bytes 与 sha256（不返回文本）', binary.status === 200
      && binary.body.kind === 'binary' && binary.body.bytes === BINARY_BODY.length
      && binary.body.sha256 === sha256Of(BINARY_BODY) && !('text' in binary.body),
    JSON.stringify(binary.body))

    const big = await rawHttp(session, { url: `${base}/big-text`, maxChars: 100 })
    check('max_chars 截断文本并置 truncated', big.body.kind === 'text'
      && big.body.chars === BIG_TEXT.length && big.body.truncated === true
      && big.body.text.length === 100 && big.body.text === BIG_TEXT.slice(0, 100),
    JSON.stringify({ chars: big.body.chars, truncated: big.body.truncated, len: big.body.text?.length }))

    const sensitive = await rawHttp(session, { url: `${base}/sensitive` })
    check('敏感响应头替换为脱敏占位', sensitive.headers['set-cookie'] === '[已隐藏]'
      && sensitive.headers.authorization === '[已隐藏]' && sensitive.headers['x-visible'] === 'ok',
    JSON.stringify(sensitive.headers))

    const head = await rawHttp(session, { url: `${base}/text`, method: 'HEAD' })
    check('HEAD 请求成功且无正文', head.status === 200 && head.ok === true
      && head.body.bytes === 0, JSON.stringify(head.body))

    const toolText = String(await httpTool.execute({ url: `${base}/text` }, exec))
    const lines = toolText.split('\n')
    check('工具层返回摘要与正文两段', lines.length >= 2
      && /^HTTP GET 127\.0\.0\.1:\d+\/text → 200 text\/plain; charset=utf-8（\d+ 字符，\d+ms，浏览器上下文）$/.test(lines[0])
      && lines.slice(1).join('\n') === TEXT_BODY, JSON.stringify(lines))

    const toolTruncated = String(await httpTool.execute({ url: `${base}/big-text`, max_chars: 64 }, exec))
    const truncLines = toolTruncated.split('\n')
    check('工具层 max_chars 映射到正文截断', truncLines.length === 2
      && truncLines[0].includes('2000 字符') && truncLines[1].length === 64, JSON.stringify(truncLines))

    const toolBinary = String(await httpTool.execute({ url: `${base}/binary` }, exec))
    check('工具层二进制正文只报字节数与 sha256', toolBinary.includes(`（二进制正文 ${BINARY_BODY.length} 字节，sha256 ${sha256Of(BINARY_BODY)}）`)
      && !toolBinary.includes(BINARY_BODY.toString('latin1')), toolBinary.slice(0, 200))
  }

  console.log('== 用例 2：参数与错误 ==')
  {
    const cases = []

    const noUrl = await expectThrow(() => httpTool.execute({}, exec))
    cases.push(['url 缺失报错', Boolean(noUrl) && noUrl.includes('url 必须是 http / https 的绝对地址')
      && noUrl.includes('undefined'), noUrl])

    const ftpUrl = await expectThrow(() => httpTool.execute({ url: 'ftp://example.com/x' }, exec))
    cases.push(['非 http(s) 协议报错', Boolean(ftpUrl) && ftpUrl.includes('url 必须是 http / https 的绝对地址')
      && ftpUrl.includes('ftp://example.com/x'), ftpUrl])

    const relativeUrl = await expectThrow(() => httpTool.execute({ url: 'not-a-url' }, exec))
    cases.push(['相对地址报错', Boolean(relativeUrl) && relativeUrl.includes('url 必须是 http / https 的绝对地址'), relativeUrl])

    const trace = await expectThrow(() => httpTool.execute({ url: `${base}/text`, method: 'TRACE' }, exec))
    const connect = await expectThrow(() => httpTool.execute({ url: `${base}/text`, method: 'CONNECT' }, exec))
    cases.push(['method 非法报错', Boolean(trace) && trace.includes('method 只支持 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS')
      && trace.includes('TRACE') && Boolean(connect) && connect.includes('CONNECT'), JSON.stringify([trace, connect])])

    const getBody = await expectThrow(() => httpTool.execute({ url: `${base}/text`, body: 'x' }, exec))
    const headBody = await expectThrow(() => httpTool.execute({ url: `${base}/text`, method: 'HEAD', body: 'x' }, exec))
    cases.push(['GET 带 body 报错', Boolean(getBody) && getBody.includes('GET / HEAD 请求不能带 body')
      && Boolean(headBody) && headBody.includes('GET / HEAD 请求不能带 body'), JSON.stringify([getBody, headBody])])

    const headersString = await expectThrow(() => httpTool.execute({ url: `${base}/text`, headers: 'x' }, exec))
    const headersArray = await expectThrow(() => httpTool.execute({ url: `${base}/text`, headers: ['a'] }, exec))
    cases.push(['headers 非对象报错', Boolean(headersString) && headersString.includes('headers 必须是字符串键值对对象')
      && Boolean(headersArray) && headersArray.includes('headers 必须是字符串键值对对象'),
    JSON.stringify([headersString, headersArray])])

    const manyHeaders = {}
    for (let index = 0; index < 51; index += 1) manyHeaders[`x-h-${index}`] = 'v'
    const tooManyHeaders = await expectThrow(() => httpTool.execute({ url: `${base}/text`, headers: manyHeaders }, exec))
    const tooLongHeader = await expectThrow(() => httpTool.execute({
      url: `${base}/text`, headers: { 'x-long': 'a'.repeat(8193) },
    }, exec))
    cases.push(['headers 超过上限（50 项 / 单项 8192 字符）报错',
      Boolean(tooManyHeaders) && tooManyHeaders.includes('headers 超过上限（50 项 / 单项 8192 字符）')
      && tooManyHeaders.includes('当前 51 项')
      && Boolean(tooLongHeader) && tooLongHeader.includes('headers 超过上限（50 项 / 单项 8192 字符）'),
      JSON.stringify([tooManyHeaders, tooLongHeader])])

    const tooBigBody = await expectThrow(() => httpTool.execute({
      url: `${base}/echo`, method: 'POST', body: 'a'.repeat(262145),
    }, exec))
    cases.push(['body 超过上限 262144 字符报错', Boolean(tooBigBody)
      && tooBigBody.includes('body 超过上限 262144 字符，当前 262145'), tooBigBody])

    const badTimeout = await Promise.all([
      expectThrow(() => httpTool.execute({ url: `${base}/text`, timeout_ms: 999 }, exec)),
      expectThrow(() => httpTool.execute({ url: `${base}/text`, timeout_ms: 120001 }, exec)),
      expectThrow(() => httpTool.execute({ url: `${base}/text`, timeout_ms: 1.5 }, exec)),
    ])
    cases.push(['timeout_ms 越界报错', badTimeout.every((message) => Boolean(message)
      && message.includes('timeout_ms 必须是 1000..120000 的整数'))
      && badTimeout[0].includes('999') && badTimeout[1].includes('120001'), JSON.stringify(badTimeout)])

    const badMaxChars = await Promise.all([
      expectThrow(() => httpTool.execute({ url: `${base}/text`, max_chars: 0 }, exec)),
      expectThrow(() => httpTool.execute({ url: `${base}/text`, max_chars: 65537 }, exec)),
    ])
    cases.push(['max_chars 越界报错', badMaxChars.every((message) => Boolean(message)
      && message.includes('max_chars 必须是 1..65536 的整数'))
      && badMaxChars[0].includes('0') && badMaxChars[1].includes('65537'), JSON.stringify(badMaxChars)])

    const serverMode = await expectThrow(() => httpTool.execute({ url: `${base}/text`, mode: 'server' }, exec))
    const cdpMode = await expectThrow(() => httpTool.execute({ url: `${base}/text`, mode: 'cdp' }, exec))
    cases.push(['mode=server 在 B1 下报「只支持 context」', Boolean(serverMode)
      && serverMode.includes('mode 只支持 context') && serverMode.includes('server'), serverMode])
    cases.push(['mode=cdp 报「只支持 context」', Boolean(cdpMode)
      && cdpMode.includes('mode 只支持 context') && cdpMode.includes('cdp'), cdpMode])

    const unknownTab = await expectThrow(() => httpTool.execute({ url: `${base}/text`, tab_id: 't999' }, exec))
    cases.push(['未知 tab_id 报「不存在」', Boolean(unknownTab)
      && unknownTab.includes('tab t999 不存在') && unknownTab.includes('browser_e2e_tabs'), unknownTab])

    const coldKey = 'test-raw-http-cold-key'
    const cold = await expectThrow(() => httpTool.execute({ url: `${base}/text` }, { agent: { id: coldKey } }))
    cases.push(['未启动时报「浏览器尚未启动或没有可用标签页」', Boolean(cold)
      && cold.includes('浏览器尚未启动或没有可用标签页，请先 browser_e2e_start'), cold])

    const startedAt = Date.now()
    const timeout = await expectThrow(() => httpTool.execute({ url: `${base}/slow`, timeout_ms: 1000 }, exec))
    const timeoutElapsed = Date.now() - startedAt
    cases.push(['超时按固定文案报错', Boolean(timeout)
      && timeout.includes(`HTTP 请求超时：${base}/slow 在 1000ms 内未完成`)
      && timeout.includes('可调大 timeout_ms（上限 120000）') && timeoutElapsed < 5000,
    JSON.stringify({ message: timeout, elapsed: timeoutElapsed })])

    const dead = await expectThrow(() => httpTool.execute({ url: `${deadBase}/x`, timeout_ms: 2000 }, exec))
    cases.push(['连接失败按固定文案报错', Boolean(dead)
      && dead.includes(`HTTP 请求失败：${deadBase}/x →`), dead])

    for (const [label, ok, detail] of cases) check(label, ok, detail)
  }

  console.log('== 用例 3：隔离与状态 ==')
  {
    const tabListBefore = (await tabs(KEY)).tabs.length
    const countBefore = session.pages.size
    const activeBefore = session.activeTabId
    const consoleBefore = (await consoleEntries(session)).total
    const networkBefore = (await networkEntries(session)).total
    const filesBefore = artifactFiles(session)

    const first = await rawHttp(session, { url: `${base}/text` })
    const second = await rawHttp(session, { url: `${base}/json`, method: 'POST', body: 'x=1' })
    await rawHttp(session, { url: `${base}/binary` })

    check('请求不改变当前页 URL', currentTab(session).page.url() === pageUrlBefore
      && currentTab(session).page.url() === `${base}/page`, currentTab(session).page.url())

    const tabListAfter = (await tabs(KEY)).tabs.length
    check('请求不新增标签页', session.pages.size === countBefore && tabListAfter === tabListBefore
      && session.activeTabId === activeBefore,
    JSON.stringify({ before: { count: countBefore, tabs: tabListBefore, active: activeBefore },
      after: { count: session.pages.size, tabs: tabListAfter, active: session.activeTabId } }))

    check('请求不写 console 环', (await consoleEntries(session)).total === consoleBefore,
      `${consoleBefore} -> ${(await consoleEntries(session)).total}`)

    check('请求不写 network 环', (await networkEntries(session)).total === networkBefore,
      `${networkBefore} -> ${(await networkEntries(session)).total}`)

    check('不落盘（产物目录无新文件）', JSON.stringify(artifactFiles(session)) === JSON.stringify(filesBefore),
      JSON.stringify({ before: filesBefore, after: artifactFiles(session) }))

    check('请求返回体互不串扰', first.body.text === TEXT_BODY && second.body.text === JSON_BODY
      && first.status === 200 && second.status === 200, JSON.stringify({ first: first.body.kind, second: second.body.kind }))
  }

  console.log('== 用例 4：工具契约 ==')
  {
    const parameters = httpTool.parameters
    check('browser_e2e_http 参数契约（mode 只列 context）',
      ['url', 'method', 'headers', 'body', 'mode', 'timeout_ms', 'max_chars', 'tab_id']
        .every((field) => field in parameters.properties)
      && JSON.stringify(parameters.required) === JSON.stringify(['url'])
      && JSON.stringify(parameters.properties.mode?.enum) === JSON.stringify(['context'])
      && parameters.additionalProperties === false,
      JSON.stringify({ required: parameters.required, mode: parameters.properties.mode }))
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
