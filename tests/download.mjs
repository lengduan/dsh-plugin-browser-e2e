/**
 * browser_e2e_download 能力验证（规格：specs/功能规格/0016-download-integrity.md）。
 *
 * 覆盖：
 *   - 直接 URL：落盘、字节数、SHA-256、Content-Disposition 文件名优先级、显式 filename、
 *     同名后缀、Cookie 共享、重定向 finalUrl、不导航当前页；
 *   - 完整性：expectedSha256 匹配 / 不匹配、0 字节、Content-Length 预检、分块超限、
 *     HTTP 404、请求超时；失败不留文件；
 *   - 点击触发：ref / selector / x + y 三条路径、未触发下载超时、失效 ref 快速失败、
 *     来源互斥与缺失来源；
 *   - 目录与文件名：默认 downloads 子目录、DSH_BROWSER_DOWNLOAD_DIR 覆盖与相对路径拒绝、
 *     显式 filename 非法、服务器路径穿越只取 basename、Windows 保留名加下划线；
 *   - 参数与生命周期：maxBytes / timeoutMs / expectedSha256 区间、未启动、未知 tab_id、
 *     下载不改变 tab 数量与 activeTabId；工具层三行文本与参数契约。
 *
 * 直接调用 lib/download.js / lib/tools.js 的真实实现（不 mock），真起无头 Edge；
 * HTTP 夹具由 node:http 在 127.0.0.1 随机端口提供，不依赖外网。
 * 运行：node tests/download.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'
// 避免宿主环境里遗留的覆盖目录影响默认目录用例。
delete process.env.DSH_BROWSER_DOWNLOAD_DIR

const { closeAll, launch, requireSession, tabs } = await import('../lib/session.js')
const { currentTab, evaluate, navigate, snapshot } = await import('../lib/page.js')
const { DEFAULT_MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES, download } = await import('../lib/download.js')

const KEY = 'test-download-key'
const SID = 'test-download-session'
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

const REPORT_BODY = Buffer.from('%PDF-1.4\nreport-body-123\n')
const BINARY_BODY = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256))
const CLICK_A = Buffer.from('click-a-body')
const CLICK_B = Buffer.from('click-b-body')
const CLICK_POINT = Buffer.from('click-point-body')

const PAGE_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>download-fixture</title></head>
<body style="margin:0">
  <a id="link-ref" href="/files/click-a.txt" download="click-a.txt"
     style="position:fixed;left:20px;top:20px;display:block;width:240px;height:40px;background:#eee">ref</a>
  <a id="link-selector" href="/files/click-b.txt" download="click-b.txt"
     style="position:fixed;left:20px;top:80px;display:block;width:240px;height:40px;background:#ddd">selector</a>
  <a id="link-point" href="/files/click-point.txt" download="click-point.txt"
     style="position:fixed;left:20px;top:140px;display:block;width:240px;height:40px;background:#ccc">point</a>
  <a id="link-gone" href="/files/click-gone.txt" download="click-gone.txt"
     style="position:fixed;left:20px;top:200px;display:block;width:240px;height:40px;background:#bbb">gone</a>
  <button id="no-download"
     style="position:fixed;left:20px;top:260px;width:240px;height:40px">no download</button>
</body>
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
  if (path === '/files/report.pdf') {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="header-name.txt"',
    })
    res.end(REPORT_BODY)
    return
  }
  if (path === '/files/plain.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(BINARY_BODY)
    return
  }
  if (path === '/files/traversal') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="../evil.txt"',
    })
    res.end('traversal-body')
    return
  }
  if (path === '/files/reserved') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="CON.txt"',
    })
    res.end('reserved-body')
    return
  }
  if (path === '/files/click-a.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(CLICK_A)
    return
  }
  if (path === '/files/click-b.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(CLICK_B)
    return
  }
  if (path === '/files/click-point.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(CLICK_POINT)
    return
  }
  if (path === '/redirect') {
    res.writeHead(302, { location: '/files/report.pdf' })
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
  if (path === '/empty') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '0' })
    res.end()
    return
  }
  if (path === '/big-declared') {
    // 声明 5000 字节，实际也发 5000 字节：命中 Content-Length 预检，不读正文。
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '5000' })
    res.end(Buffer.alloc(5000, 0x61))
    return
  }
  if (path === '/chunked') {
    // 无 Content-Length（分块传输），实际 4096 字节，用于正文读入后的长度判定。
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.write(Buffer.alloc(2048, 0x62))
    res.end(Buffer.alloc(2048, 0x62))
    return
  }
  if (path === '/missing') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  if (path === '/slow') {
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
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
const baseline = edgeRootCount()
const overrideDir = mkdtempSync(join(tmpdir(), 'dsh-download-override-'))

let session = null

try {
  console.log('== 用例 1：直接 URL 下载 ==')
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
  const downloadTool = definitions.find((definition) => definition.name === 'browser_e2e_download')
  const exec = { agent: { id: KEY } }

  {
    const url = `${base}/files/report.pdf`
    const info = await download(session, { url })
    check('直接 URL 下载落盘', info.source === 'request' && info.url === url
      && existsSync(info.file) && readFileSync(info.file).equals(REPORT_BODY), JSON.stringify(info))
    check('返回字节数与文件大小一致', info.bytes === REPORT_BODY.length
      && statSync(info.file).size === REPORT_BODY.length, `${info.bytes} / ${statSync(info.file).size}`)
    check('sha256 与已知内容一致', info.sha256 === sha256Of(REPORT_BODY)
      && /^[0-9a-f]{64}$/.test(info.sha256), info.sha256)
    check('响应头文件名优先于 URL 末段', info.filename === 'header-name.txt'
      && info.suggestedFilename === 'header-name.txt', JSON.stringify({ filename: info.filename, suggested: info.suggestedFilename }))
    check('URL 模式不导航当前页', currentTab(session).page.url() === pageUrlBefore
      && currentTab(session).page.url() === `${base}/page`, currentTab(session).page.url())

    const explicit = await download(session, { url, filename: 'explicit.txt' })
    check('显式 filename 覆盖服务器建议名', explicit.filename === 'explicit.txt'
      && explicit.suggestedFilename === 'header-name.txt'
      && existsSync(join(session.artifactsDir, 'downloads', 'explicit.txt')),
    JSON.stringify({ filename: explicit.filename, suggested: explicit.suggestedFilename }))

    const first = await download(session, { url, filename: 'dup.txt' })
    const second = await download(session, { url, filename: 'dup.txt' })
    check('同名下载自动加 -1 后缀且不覆盖', first.filename === 'dup.txt' && second.filename === 'dup-1.txt'
      && first.file !== second.file && existsSync(first.file) && existsSync(second.file),
    JSON.stringify({ first: first.filename, second: second.filename }))

    const cookieTab = currentTab(session)
    await cookieTab.page.context().addCookies([{ name: 'e2e-cookie', value: 'ok', url: base }])
    const cookieInfo = await download(session, { url: `${base}/cookie` })
    check('cookie 随会话带到下载请求', existsSync(cookieInfo.file)
      && readFileSync(cookieInfo.file, 'utf8') === 'cookie-ok', JSON.stringify(cookieInfo))

    const redirected = await download(session, { url: `${base}/redirect` })
    check('重定向后 finalUrl 指向最终地址', redirected.finalUrl === `${base}/files/report.pdf`
      && redirected.url === `${base}/redirect`, JSON.stringify({ url: redirected.url, finalUrl: redirected.finalUrl }))

    const text = await downloadTool.execute({ url, filename: 'tool-text.txt' }, exec)
    const lines = String(text).split('\n')
    check('工具返回三行文本（摘要 / sha256 / 来源）', lines.length === 3
      && /^下载 \d+ 字节 -> .+tool-text\.txt$/.test(lines[0])
      && /^sha256：[0-9a-f]{64}$/.test(lines[1])
      && lines[2].startsWith('来源：直接请求 ') && lines[2].includes(url) && lines[2].includes('ms）'),
    JSON.stringify(lines))
  }

  console.log('== 用例 2：完整性校验 ==')
  {
    const url = `${base}/files/report.pdf`
    const expected = sha256Of(REPORT_BODY)
    const matched = await download(session, { url, expectedSha256: expected, filename: 'hash-ok.bin' })
    check('expectedSha256 匹配时成功', matched.sha256 === expected && existsSync(matched.file), JSON.stringify(matched))

    const badHash = await expectThrow(() => download(session, { url, expectedSha256: '0'.repeat(64), filename: 'bad-hash.bin' }))
    check('expectedSha256 不匹配时报错并删除文件', Boolean(badHash)
      && badHash.includes('SHA-256 不匹配') && badHash.includes('0'.repeat(64))
      && badHash.includes(expected) && !existsSync(join(session.artifactsDir, 'downloads', 'bad-hash.bin')),
    String(badHash))

    const emptyMessage = await expectThrow(() => download(session, { url: `${base}/empty` }))
    check('0 字节响应报错且不留文件', Boolean(emptyMessage) && emptyMessage.includes('0 字节')
      && !existsSync(join(session.artifactsDir, 'downloads', 'empty')), String(emptyMessage))

    const declaredMessage = await expectThrow(() => download(session, { url: `${base}/big-declared`, maxBytes: 100 }))
    check('Content-Length 超限在读取前报错', Boolean(declaredMessage)
      && declaredMessage.includes('Content-Length 声明 5000') && declaredMessage.includes('maxBytes=100')
      && !existsSync(join(session.artifactsDir, 'downloads', 'big-declared')), String(declaredMessage))

    const chunkedMessage = await expectThrow(() => download(session, { url: `${base}/chunked`, maxBytes: 1024 }))
    check('分块响应超限时中止并删除半成品', Boolean(chunkedMessage)
      && chunkedMessage.includes('maxBytes=1024') && chunkedMessage.includes('实际 4096')
      && !existsSync(join(session.artifactsDir, 'downloads', 'chunked')), String(chunkedMessage))

    const missingMessage = await expectThrow(() => download(session, { url: `${base}/missing` }))
    check('HTTP 404 报错且不留文件', Boolean(missingMessage) && missingMessage.includes('HTTP 404')
      && !existsSync(join(session.artifactsDir, 'downloads', 'missing')), String(missingMessage))

    const startedAt = Date.now()
    const timeoutMessage = await expectThrow(() => download(session, { url: `${base}/slow`, timeoutMs: 1000 }))
    const timeoutElapsed = Date.now() - startedAt
    check('直接 URL 超时时报错且不留文件', Boolean(timeoutMessage) && timeoutMessage.includes('下载超时')
      && timeoutMessage.includes('1000ms') && timeoutElapsed < 5000
      && !existsSync(join(session.artifactsDir, 'downloads', 'slow')),
    JSON.stringify({ message: timeoutMessage, elapsed: timeoutElapsed }))
  }

  console.log('== 用例 3：点击触发下载 ==')
  {
    const fixtureSnapshot = await snapshot(session)
    const refNode = fixtureSnapshot.nodes.find((node) => node.id === 'link-ref')
    const pointNode = fixtureSnapshot.nodes.find((node) => node.id === 'link-point')
    const goneNode = fixtureSnapshot.nodes.find((node) => node.id === 'link-gone')

    const byRef = await download(session, { ref: refNode?.ref })
    check('ref 点击触发下载并落盘', byRef.source === 'browser' && byRef.filename === 'click-a.txt'
      && existsSync(byRef.file) && readFileSync(byRef.file).equals(CLICK_A), JSON.stringify(byRef))

    const bySelector = await download(session, { selector: '#link-selector' })
    check('selector 点击触发下载并落盘', bySelector.source === 'browser' && bySelector.filename === 'click-b.txt'
      && readFileSync(bySelector.file).equals(CLICK_B), JSON.stringify(bySelector))

    const x = pointNode.box.x + Math.round(pointNode.box.width / 2)
    const y = pointNode.box.y + Math.round(pointNode.box.height / 2)
    const byPoint = await download(session, { x, y })
    check('x + y 点击触发下载并落盘', byPoint.source === 'browser' && byPoint.filename === 'click-point.txt'
      && readFileSync(byPoint.file).equals(CLICK_POINT), JSON.stringify(byPoint))

    const noDownload = await expectThrow(() => download(session, { selector: '#no-download', timeoutMs: 1000 }))
    check('点击没有触发下载时报超时', Boolean(noDownload) && noDownload.includes('1000ms 内没有触发下载'),
      String(noDownload))

    await evaluate(session, "document.getElementById('link-gone').remove()")
    const staleStarted = Date.now()
    const staleRef = await expectThrow(() => download(session, { ref: goneNode?.ref, timeoutMs: 5000 }))
    const staleElapsed = Date.now() - staleStarted
    check('失效 ref 报错且不等待完整超时', Boolean(goneNode) && Boolean(staleRef)
      && staleRef.includes('已失效') && staleElapsed < 2500,
    JSON.stringify({ message: staleRef, elapsed: staleElapsed }))

    const mixed = await expectThrow(() => download(session, { url: `${base}/files/report.pdf`, ref: '@0' }))
    check('url 与触发目标同给报互斥', Boolean(mixed) && mixed.includes('只能给一种')
      && mixed.includes('互斥'), String(mixed))
    const twoTriggers = await expectThrow(() => download(session, { ref: '@0', selector: '#link-selector' }))
    check('两种触发目标同给报三选一', Boolean(twoTriggers) && twoTriggers.includes('三选一'), String(twoTriggers))
    const noSource = await expectThrow(() => download(session, {}))
    check('缺少下载来源报错', Boolean(noSource) && noSource.includes('缺少下载来源'), String(noSource))
  }

  console.log('== 用例 4：目录与文件名 ==')
  {
    const downloadsDir = join(session.artifactsDir, 'downloads')
    const normal = await download(session, { url: `${base}/files/plain.bin` })
    check('默认落在产物目录的 downloads 子目录', normal.file === join(downloadsDir, 'plain.bin')
      && normal.file.startsWith(downloadsDir + sep) && existsSync(normal.file), normal.file)

    process.env.DSH_BROWSER_DOWNLOAD_DIR = overrideDir
    try {
      const overridden = await download(session, { url: `${base}/files/plain.bin`, filename: 'override.txt' })
      check('DSH_BROWSER_DOWNLOAD_DIR 覆盖目录', overridden.file === join(overrideDir, 'override.txt')
        && existsSync(overridden.file)
        && !existsSync(join(downloadsDir, 'override.txt')), overridden.file)
    } finally {
      delete process.env.DSH_BROWSER_DOWNLOAD_DIR
    }

    process.env.DSH_BROWSER_DOWNLOAD_DIR = 'relative-downloads'
    try {
      const relative = await expectThrow(() => download(session, { url: `${base}/files/plain.bin` }))
      check('相对 DSH_BROWSER_DOWNLOAD_DIR 报错', Boolean(relative)
        && relative.includes('DSH_BROWSER_DOWNLOAD_DIR') && relative.includes('绝对路径'), String(relative))
    } finally {
      delete process.env.DSH_BROWSER_DOWNLOAD_DIR
    }

    const slashName = await expectThrow(() => download(session, { url: `${base}/files/plain.bin`, filename: 'a/b.txt' }))
    const backslashName = await expectThrow(() => download(session, { url: `${base}/files/plain.bin`, filename: 'a\\b.txt' }))
    check('显式 filename 含路径分隔符被拒', Boolean(slashName) && slashName.includes('纯文件名')
      && Boolean(backslashName) && backslashName.includes('纯文件名'),
    JSON.stringify({ slash: slashName, backslash: backslashName }))

    const dotName = await expectThrow(() => download(session, { url: `${base}/files/plain.bin`, filename: '..' }))
    check('显式 filename 为 .. 被拒', Boolean(dotName) && dotName.includes('不能是 "." 或 ".."'), String(dotName))

    const traversal = await download(session, { url: `${base}/files/traversal` })
    check('服务器文件名含路径穿越时只取 basename', traversal.filename === 'evil.txt'
      && traversal.file === join(downloadsDir, 'evil.txt') && existsSync(traversal.file),
    JSON.stringify({ filename: traversal.filename, file: traversal.file }))

    const reserved = await download(session, { url: `${base}/files/reserved` })
    check('服务器建议名为 Windows 保留名时加下划线', reserved.filename === '_CON.txt'
      && existsSync(join(downloadsDir, '_CON.txt')), reserved.filename)
  }

  console.log('== 用例 5：参数与生命周期 ==')
  {
    const url = `${base}/files/plain.bin`
    const badMax = await Promise.all([
      expectThrow(() => download(session, { url, maxBytes: 0 })),
      expectThrow(() => download(session, { url, maxBytes: MAX_DOWNLOAD_BYTES + 1 })),
      expectThrow(() => download(session, { url, maxBytes: 1.5 })),
    ])
    check('maxBytes 越界报错', badMax.every((message) => Boolean(message) && message.includes('maxBytes'))
      && badMax[0].includes(`1..${MAX_DOWNLOAD_BYTES}`), JSON.stringify(badMax))

    const badTimeout = await Promise.all([
      expectThrow(() => download(session, { url, timeoutMs: 999 })),
      expectThrow(() => download(session, { url, timeoutMs: 300001 })),
      expectThrow(() => download(session, { url, timeoutMs: 1.5 })),
    ])
    check('timeoutMs 越界报错', badTimeout.every((message) => Boolean(message) && message.includes('timeoutMs'))
      && badTimeout[0].includes('1000..300000'), JSON.stringify(badTimeout))

    const badSha = await expectThrow(() => download(session, { url, expectedSha256: 'xyz' }))
    check('expectedSha256 形态非法报错', Boolean(badSha) && badSha.includes('expectedSha256')
      && badSha.includes('64 位十六进制'), String(badSha))

    const coldKey = 'test-download-cold-key'
    const cold = await expectThrow(() => downloadTool.execute({ url }, { agent: { id: coldKey } }))
    check('未启动时下载报「浏览器尚未启动」', Boolean(cold) && cold.includes('浏览器尚未启动'), String(cold))

    const unknownTab = await expectThrow(() => download(session, { url }, 't999'))
    check('不存在的 tab_id 报错', Boolean(unknownTab) && unknownTab.includes('t999')
      && unknownTab.includes('不存在'), String(unknownTab))

    const before = { count: session.pages.size, active: session.activeTabId }
    const tabListBefore = (await tabs(KEY)).tabs.length
    const changed = await download(session, { url, filename: 'tab-stable.txt' })
    const tabListAfter = (await tabs(KEY)).tabs.length
    check('下载不改变 tab 数量与 activeTabId', session.pages.size === before.count
      && session.activeTabId === before.active
      && tabListAfter === tabListBefore && existsSync(changed.file),
    JSON.stringify({ before, after: { count: session.pages.size, active: session.activeTabId }, tabListBefore, tabListAfter }))

    const parameters = downloadTool.parameters
    check('browser_e2e_download 提供两种来源与完整性参数', ['url', 'ref', 'selector', 'x', 'y', 'filename',
      'maxBytes', 'expectedSha256', 'timeoutMs', 'tab_id'].every((field) => field in parameters.properties)
      && parameters.additionalProperties === false, JSON.stringify(Object.keys(parameters.properties)))
  }
} finally {
  await closeAll()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  rmSync(overrideDir, { recursive: true, force: true })
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
