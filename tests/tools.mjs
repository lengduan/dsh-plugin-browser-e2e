/**
 * dsh-browser-e2e 工具能力验证：console / network 捕获、网络响应体详情、
 * snapshot 增强、点击三种方式、悬停、拖拽、clip 截图、wait 与超时。
 *
 * 直接调用 page.js / capture.js 的真实实现（不 mock），真起无头 Edge；
 * 网络请求用 node:http 在 127.0.0.1 随机端口起本地服务制造。
 *
 * 运行：node tests/tools.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, closeTab, launch, requireSession } = await import('../lib/session.js')
const {
  attachPageHooks, clearRings, CLIPBOARD_HTML_LIMIT, CLIPBOARD_TEXT_LIMIT, click, consoleEntries,
  DEFAULT_EVALUATE_TIMEOUT_MS, drag, evaluate, fill, hover,
  MAX_EVALUATE_TIMEOUT_MS, MIN_EVALUATE_TIMEOUT_MS, navigate,
  NETWORK_BODY_TEXT_LIMIT, NETWORK_BODY_TIMEOUT_MAX_MS, NETWORK_BODY_TIMEOUT_MIN_MS, NETWORK_BODY_TIMEOUT_MS,
  networkDetail, networkEntries, RING_LIMIT, scroll, snapshot, waitFor,
} = await import('../lib/page.js')
const { currentTab } = await import('../lib/page.js')
const { screenshot } = await import('../lib/capture.js')

const KEY = 'test-tools-key'
let session = null
const SID = 'test-tools-session'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 由 Playwright 临时 profile 启动的 msedge 主进程数；正常应归零。 */
function playwrightEdgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'playwright_chromiumdev_profile' -and $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
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

/** 读取 PNG 文件头里的宽高。 */
function pngSize(file) {
  const buffer = readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** PNG 行滤波的 Paeth 预测（decodePng 用）。 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 最小 PNG 解码：只支持 8 位非隔行的 RGB / RGBA（Playwright 与 CDP 截图都是这两种）。
 * 返回 { width, height, pixel(x, y) }，供像素级断言使用。
 */
function decodePng(file) {
  const buffer = readFileSync(file)
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const chunks = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bitDepth !== 8 || channels === 0) {
    throw new Error(`不支持的 PNG：bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[i - channels] : 0
      const up = prev ? prev[i] : 0
      const upLeft = prev && i >= channels ? prev[i - channels] : 0
      let value
      if (filter === 0) value = line[i]
      else if (filter === 1) value = line[i] + left
      else if (filter === 2) value = line[i] + up
      else if (filter === 3) value = line[i] + Math.floor((left + up) / 2)
      else if (filter === 4) value = line[i] + paeth(left, up, upLeft)
      else throw new Error(`未知 PNG 行滤波 ${filter}`)
      out[i] = value & 0xff
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + x * channels
      return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] }
    },
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

/** 把 HTML 包成 data: URL：夹具里含 `#` 选择器，必须编码，否则 `#` 会被当成 URL 片段。 */
function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
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

/** 轮询当前标签页网络环，直到出现满足条件的记录；返回记录或 null。 */
async function waitNetworkEntry(predicate, timeoutMs = 5000, tabId) {
  let found = null
  await waitUntil(async () => {
    const info = await networkEntries(session, RING_LIMIT, tabId)
    found = info.entries.find(predicate) ?? null
    return found !== null
  }, timeoutMs, 100)
  return found
}

/** 网络详情夹具：10 万字符文本正文，用于 max_chars 截断。 */
const TEXT_BODY = 'A'.repeat(100000)
/** 网络详情夹具：1024 字节确定二进制（0..255 循环），用于校验 bytes / mime / sha256。 */
const BINARY_BODY = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256))
/** 网络详情夹具：JSON 响应体，用于校验解析与两空格格式化。 */
const JSON_FIXTURE = { alpha: 1, beta: { gamma: [1, 2, 3] }, note: '详情夹具' }

const baseline = edgeRootCount()
// 运行前可能已有别的进程用 Playwright 起过 Edge（例如其他工具），只断言本测试没有新增残留。
const playwrightBaseline = playwrightEdgeRootCount()
const server = createServer((req, res) => {
  if (req.url === '/page' || req.url.startsWith('/page?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>tools</title></head><body><h1 id="title">ok</h1></body></html>')
    return
  }
  if (req.url.startsWith('/reload-sub')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('sub')
    return
  }
  if (req.url === '/reload') {
    // 同 URL reload 用例：每次文档加载用 sessionStorage 计数，控制台与子请求都带上序号，
    // 以便区分「旧文档记录」与「新文档自己的记录」。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>reload</title></head><body><button id="marker">marker</button>'
      + '<script>'
      + 'var n = Number(sessionStorage.getItem("docLoads") || "0") + 1;'
      + 'sessionStorage.setItem("docLoads", String(n));'
      + 'console.log("doc-load-" + n);'
      + 'fetch("/reload-sub?n=" + n).catch(function () {});'
      + '</script></body></html>')
    return
  }
  // 用例 3D / 3E 的夹具：JSON、10 万字符文本、1KB 二进制、302 链、204、失败、慢响应、
  // 流式（SSE）与 POST echo；全部在本地，不依赖外网。
  if (req.url === '/tab-b') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>tab-b</title></head><body><h1 id="tab-b">b</h1></body></html>')
    return
  }
  if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(JSON_FIXTURE))
    return
  }
  if (req.url === '/text') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(TEXT_BODY)
    return
  }
  if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(BINARY_BODY)
    return
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/final' })
    res.end()
    return
  }
  if (req.url === '/final') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('final-body')
    return
  }
  if (req.url === '/empty204') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.url === '/fail') {
    // 直接断连接：制造「没有响应对象」的失败请求（net::ERR_EMPTY_RESPONSE）。
    req.socket.destroy()
    return
  }
  if (req.url === '/slow') {
    // 5s 后才回头，供「未完成请求返回 pending」；详情读取按 timeout_ms 放弃，不会挂住测试。
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('slow-body')
      } catch {
        // 测试已结束或连接已断，忽略。
      }
    }, 5000)
    return
  }
  if (req.url === '/stream') {
    // 永不结束的 SSE：response.body() 不会返回，供超时用例使用。
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: start\n\n')
    const timer = setInterval(() => {
      if (res.destroyed) return
      try {
        res.write('data: tick\n\n')
      } catch {
        // 连接已断，忽略。
      }
    }, 100)
    res.on('close', () => clearInterval(timer))
    return
  }
  if (req.url === '/echo') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let received = null
      try {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        received = null
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-detail-header': 'visible-value',
        'set-cookie': 'session=secret-cookie-value; Path=/',
      })
      res.end(JSON.stringify({ ok: true, received }))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 1：启动浏览器（视口 800x600）==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    check('启动成功且有 summary', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    check('Edge 主进程比基线多', edgeRootCount() > baseline, `baseline=${baseline} now=${edgeRootCount()}`)
  }

  console.log('== 用例 2：console 捕获（log / warn / pageerror）==')
  {
    await navigate(session, 'data:text/html,<script>console.log("hello-console");console.warn("warn-msg");setTimeout(function(){throw new Error("boom-pageerror")},50)</script>', 'load')
    await sleep(300)
    const info = await consoleEntries(session, 100)
    const text = info.text
    check('捕获到 console.log', text.includes('hello-console'), text)
    check('捕获到 console.warn', /warn-msg/.test(text), text)
    check('捕获到 pageerror', text.includes('boom-pageerror'), text)
    check('条目结构含 level / text / at', info.entries.every((e) => typeof e.level === 'string' && typeof e.text === 'string' && typeof e.at === 'string'), JSON.stringify(info.entries))
  }

  console.log('== 用例 3：network 捕获（含 status）==')
  {
    await navigate(session, `${base}/page`, 'load')
    // 再发一个必定 404 的请求。
    const fetched = await evaluate(session, "fetch('/missing').then(r => r.status)")
    check('页面内 fetch 返回 404', fetched.value === 404, JSON.stringify(fetched.value))
    await sleep(300)
    const info = await networkEntries(session, 100)
    const pageRecord = info.entries.find((e) => e.url === `${base}/page`)
    const missingRecord = info.entries.find((e) => e.url === `${base}/missing`)
    check('记录到页面请求且 status=200', pageRecord?.status === 200, JSON.stringify(pageRecord))
    check('记录到 404 请求且 status=404', missingRecord?.status === 404, JSON.stringify(missingRecord))
    check('记录含 method / mimeType', pageRecord?.method === 'GET' && /text\/html/.test(pageRecord?.mimeType ?? ''), JSON.stringify(pageRecord))
    check('导航清空旧记录（不含用例 2 的页面）', !info.entries.some((e) => e.url.startsWith('data:')), JSON.stringify(info.entries.map((e) => e.url)))
  }

  console.log('== 用例 3B：事件环按新文档重置（同 URL reload）==')
  {
    await navigate(session, `${base}/reload`, 'load')
    await waitUntil(async () => (await consoleEntries(session, 100)).text.includes('doc-load-1'))
    await sleep(300)
    const beforeConsole = await consoleEntries(session, 100)
    const beforeNetwork = await networkEntries(session, 100)
    check('预置：旧文档 console 已记录', beforeConsole.text.includes('doc-load-1'), beforeConsole.text)
    check('预置：旧文档网络已记录', beforeNetwork.entries.some((e) => e.url === `${base}/reload-sub?n=1`),
      JSON.stringify(beforeNetwork.entries.map((e) => e.url)))
    // 页面内触发同 URL reload：不经过 navigate() 的预清空，能否重置完全看新文档判据。
    await evaluate(session, 'setTimeout(function () { location.reload() }, 0); "scheduled"')
    const reached = await waitUntil(async () => (await consoleEntries(session, 100)).text.includes('doc-load-2'))
    check('reload 后新文档 console 记录到达', reached, (await consoleEntries(session, 100)).text)
    await sleep(300)
    const afterConsole = await consoleEntries(session, 100)
    const afterNetwork = await networkEntries(session, 100)
    check('reload 后旧 console 记录不再出现', !afterConsole.text.includes('doc-load-1'), afterConsole.text)
    check('reload 后新文档 console 记录保留', afterConsole.text.includes('doc-load-2'), afterConsole.text)
    check('reload 后旧网络记录不再出现', !afterNetwork.entries.some((e) => e.url.endsWith('/reload-sub?n=1')),
      JSON.stringify(afterNetwork.entries.map((e) => e.url)))
    const docRecord = afterNetwork.entries.find((e) => e.url === `${base}/reload`)
    const subRecord = afterNetwork.entries.find((e) => e.url === `${base}/reload-sub?n=2`)
    check('reload 后新文档自身请求保留（document + 子请求）', docRecord?.status === 200 && subRecord?.status === 200,
      JSON.stringify(afterNetwork.entries.map((e) => ({ url: e.url, status: e.status }))))
  }

  console.log('== 用例 3C：网络记录上限（request 事件淘汰最旧）==')
  {
    const handlers = {}
    const fakePageObj = {
      on: (event, handler) => {
        handlers[event] = handler
      },
      mainFrame: () => ({}),
      evaluate: async () => 'complete',
      viewportSize: () => ({ width: 800, height: 600 }),
    }
    const entry = {
      id: 'fake',
      page: fakePageObj,
      refs: new Map(),
      consoleRing: [],
      networkRing: [],
      networkByRequest: new Map(),
      loading: false,
      origin: 'created',
    }
    attachPageHooks({ key: 'fake-session', hookedPages: new WeakSet(), emit: () => {} }, entry)
    for (let i = 0; i < RING_LIMIT + 100; i += 1) {
      handlers.request({
        url: () => `http://127.0.0.1/x/${i}`,
        method: () => 'GET',
        isNavigationRequest: () => false,
      })
    }
    check('网络 event Map 不超过 RING_LIMIT', entry.networkByRequest.size === RING_LIMIT, String(entry.networkByRequest.size))
    const oldest = entry.networkByRequest.keys().next().value
    check('淘汰的是最旧请求（保留最后 RING_LIMIT 条）', oldest?.url() === 'http://127.0.0.1/x/100', String(oldest?.url()))
    check('网络 ring 同样只保留 RING_LIMIT 条', entry.networkRing.length === RING_LIMIT, String(entry.networkRing.length))
  }

  console.log('== 用例 3D：网络详情（正常链路）==')
  {
    await navigate(session, `${base}/page`, 'load')
    const list = await networkEntries(session, 100)
    const pageEntry = list.entries.find((entry) => entry.url === `${base}/page`)
    check('网络列表条目带 request_id',
      Boolean(pageEntry) && /^n[1-9][0-9]*$/.test(pageEntry.request_id ?? '')
      && list.entries.every((entry) => /^n[1-9][0-9]*$/.test(entry.request_id ?? ''))
      && list.text.includes(`[${pageEntry?.request_id}]`),
      JSON.stringify({ request_id: pageEntry?.request_id, text: list.text }))

    // JSON：正文自动解析并两空格缩进。
    await evaluate(session, "fetch('/json').then(r => r.status)")
    const jsonEntry = await waitNetworkEntry((entry) => entry.url === `${base}/json` && entry.status === 200)
    const jsonDetail = jsonEntry ? await networkDetail(session, jsonEntry.request_id, { timeoutMs: 3000 }) : null
    check('detail 读取 JSON 正文并格式化',
      Boolean(jsonDetail) && jsonDetail.response.body.kind === 'json'
      && jsonDetail.response.body.json?.alpha === 1
      && jsonDetail.response.body.truncated === false
      && jsonDetail.response.body.text.includes('\n  "alpha": 1')
      && jsonDetail.text.includes('"gamma": ['),
      JSON.stringify(jsonDetail?.response.body))

    // POST echo：同时覆盖请求头、请求体、响应头与敏感头脱敏。
    await evaluate(session, "fetch('/echo', { method: 'POST',"
      + " headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token', 'x-api-key': 'secret-key' },"
      + " body: JSON.stringify({ hello: 'world', nested: { n: 1 } }) }).then(r => r.status)")
    const echoEntry = await waitNetworkEntry((entry) => entry.url === `${base}/echo` && entry.status === 200)
    const echoDetail = echoEntry ? await networkDetail(session, echoEntry.request_id, { timeoutMs: 3000 }) : null
    check('detail 读取请求头',
      Boolean(echoDetail) && /json/.test(echoDetail.request.headers['content-type'] ?? '')
      && Object.keys(echoDetail.request.headers).every((name) => name === name.toLowerCase())
      && echoDetail.text.includes('请求头：'),
      JSON.stringify(echoDetail?.request.headers))
    check('detail 读取请求体',
      Boolean(echoDetail) && echoDetail.request.postData?.kind === 'json'
      && echoDetail.request.postData?.json?.hello === 'world'
      && echoDetail.request.postData?.text.includes('"hello": "world"')
      && echoDetail.text.includes('请求体：'),
      JSON.stringify(echoDetail?.request.postData))
    check('detail 读取响应头',
      Boolean(echoDetail) && /json/.test(echoDetail.response.headers['content-type'] ?? '')
      && echoDetail.response.headers['x-detail-header'] === 'visible-value'
      && echoDetail.text.includes('响应头：'),
      JSON.stringify(echoDetail?.response.headers))

    const sensitiveDetail = echoEntry
      ? await networkDetail(session, echoEntry.request_id, { includeSensitive: true, timeoutMs: 3000 })
      : null
    check('敏感请求头默认隐藏、include_sensitive 后可见',
      Boolean(echoDetail) && echoDetail.request.headers.authorization === '[已隐藏]'
      && echoDetail.request.headers['x-api-key'] === '[已隐藏]'
      && echoDetail.response.headers['set-cookie'] === '[已隐藏]'
      && sensitiveDetail?.request.headers.authorization === 'Bearer secret-token'
      && sensitiveDetail?.request.headers['x-api-key'] === 'secret-key'
      && (sensitiveDetail?.response.headers['set-cookie'] ?? '').includes('secret-cookie-value'),
      JSON.stringify({ hidden: echoDetail?.request.headers, visible: sensitiveDetail?.request.headers }))

    // 二进制：只给 bytes / mime / sha256，不给正文或 base64。
    await evaluate(session, "fetch('/binary').then(r => r.status)")
    const binaryEntry = await waitNetworkEntry((entry) => entry.url === `${base}/binary` && entry.status === 200)
    const binaryDetail = binaryEntry ? await networkDetail(session, binaryEntry.request_id, { timeoutMs: 3000 }) : null
    const binarySha = createHash('sha256').update(BINARY_BODY).digest('hex')
    check('二进制正文只给大小、mime 与 sha256',
      Boolean(binaryDetail) && binaryDetail.response.body.kind === 'binary'
      && binaryDetail.response.body.bytes === BINARY_BODY.length
      && binaryDetail.response.body.mimeType === 'application/octet-stream'
      && binaryDetail.response.body.sha256 === binarySha
      && binaryDetail.response.body.text === undefined
      && binaryDetail.text.includes('未返回 base64'),
      JSON.stringify(binaryDetail?.response.body))

    // 10 万字符文本 + max_chars=100：截断且标记。
    await evaluate(session, "fetch('/text').then(r => r.status)")
    const textEntry = await waitNetworkEntry((entry) => entry.url === `${base}/text` && entry.status === 200)
    const limitedDetail = textEntry
      ? await networkDetail(session, textEntry.request_id, { maxChars: 100, timeoutMs: 3000 })
      : null
    check('max_chars 截断正文并标记 truncated',
      Boolean(limitedDetail) && limitedDetail.response.body.kind === 'text'
      && limitedDetail.response.body.truncated === true
      && limitedDetail.response.body.bytes === TEXT_BODY.length
      && limitedDetail.response.body.chars === TEXT_BODY.length
      && limitedDetail.response.body.text === TEXT_BODY.slice(0, 100),
      JSON.stringify(limitedDetail?.response.body))

    // 404 的正文同样可读（复用服务端兜底的 'not found'）。
    await evaluate(session, "fetch('/missing').then(r => r.status)")
    const missingEntry = await waitNetworkEntry((entry) => entry.url === `${base}/missing` && entry.status === 404)
    const missingDetail = missingEntry
      ? await networkDetail(session, missingEntry.request_id, { timeoutMs: 3000 })
      : null
    check('404 响应正文可读',
      Boolean(missingDetail) && missingDetail.status === 404
      && missingDetail.response.body.kind === 'text'
      && missingDetail.response.body.text === 'not found',
      JSON.stringify(missingDetail?.response.body))
  }

  console.log('== 用例 3E：网络正文边界与错误 ==')
  {
    await navigate(session, `${base}/page`, 'load')

    // 没有响应对象的失败请求：kind=failed，不读正文。
    await evaluate(session, "fetch('/fail').catch(function () {}); 'started'")
    const failEntry = await waitNetworkEntry((entry) => entry.url === `${base}/fail` && entry.failure !== '')
    const failDetail = failEntry
      ? await networkDetail(session, failEntry.request_id, { timeoutMs: 500 })
      : null
    check('失败请求返回 failure 且没有响应体',
      Boolean(failDetail) && failDetail.response.body.kind === 'failed'
      && failDetail.response.body.bytes === 0
      && failDetail.response.body.reason === failEntry.failure
      && failDetail.text.includes('请求失败'),
      JSON.stringify({ failure: failEntry?.failure, body: failDetail?.response.body }))

    // 204：Playwright 下可能同时标记 failure（net::ERR_ABORTED），仍按状态分类为空正文。
    await evaluate(session, "fetch('/empty204').catch(function () {}); 'started'")
    const emptyEntry = await waitNetworkEntry((entry) => entry.url === `${base}/empty204` && entry.status === 204)
    const emptyDetail = emptyEntry
      ? await networkDetail(session, emptyEntry.request_id, { timeoutMs: 500 })
      : null
    check('204 响应按空正文返回（有 failure 也按状态分类）',
      Boolean(emptyDetail) && emptyDetail.response.body.kind === 'empty'
      && emptyDetail.response.body.bytes === 0,
      JSON.stringify({ failure: emptyEntry?.failure, body: emptyDetail?.response.body }))

    // 302 链：重定向记录不给正文，并指向最终请求；最终响应正文可读。
    await evaluate(session, "fetch('/redirect').then(r => r.status)")
    const redirectEntry = await waitNetworkEntry((entry) => entry.url === `${base}/redirect` && entry.status === 302)
    const finalEntry = await waitNetworkEntry((entry) => entry.url === `${base}/final` && entry.status === 200)
    const redirectDetail = redirectEntry
      ? await networkDetail(session, redirectEntry.request_id, { timeoutMs: 3000 })
      : null
    const finalDetail = finalEntry
      ? await networkDetail(session, finalEntry.request_id, { timeoutMs: 3000 })
      : null
    check('重定向响应不给正文并指向最终请求',
      Boolean(redirectDetail) && redirectDetail.response.body.kind === 'redirect'
      && redirectDetail.response.body.bytes === 0
      && redirectDetail.text.includes('302')
      && redirectDetail.redirect?.toUrl === `${base}/final`
      && redirectDetail.redirect?.toRequestId === finalEntry?.request_id,
      JSON.stringify(redirectDetail?.redirect))
    check('最终响应正文可读',
      Boolean(finalDetail) && finalDetail.response.body.kind === 'text'
      && finalDetail.response.body.text === 'final-body',
      JSON.stringify(finalDetail?.response.body))

    // 未完成请求：status 0 时返回 pending，最多被 timeout_ms 拖慢，不挂起。
    await evaluate(session, "fetch('/slow').catch(function () {}); 'started'")
    const slowEntry = await waitNetworkEntry((entry) => entry.url === `${base}/slow` && entry.status === 0, 3000)
    const pendingStartedAt = Date.now()
    const pendingDetail = slowEntry
      ? await networkDetail(session, slowEntry.request_id, { timeoutMs: 300 })
      : null
    const pendingElapsed = Date.now() - pendingStartedAt
    check('未完成请求返回 pending 而不是挂起',
      Boolean(pendingDetail) && pendingDetail.response.body.kind === 'pending'
      && pendingDetail.text.includes('尚未完成')
      && pendingElapsed < 2500,
      JSON.stringify({ elapsed: pendingElapsed, body: pendingDetail?.response.body }))

    // 流式响应（SSE）：body() 不返回，到 timeout_ms 报错。
    await evaluate(session, "fetch('/stream').catch(function () {}); 'started'")
    const streamEntry = await waitNetworkEntry((entry) => entry.url === `${base}/stream` && entry.status === 200, 5000)
    const streamMessage = streamEntry
      ? await expectThrow(() => networkDetail(session, streamEntry.request_id, { timeoutMs: 500 }))
      : null
    check('流式响应读取超时报错',
      Boolean(streamMessage) && streamMessage.includes('读取响应体超时')
      && streamMessage.includes('500'),
      String(streamMessage))

    // 导航后旧 id 不再可查：报「已导航导致记录重置」。
    const staleId = redirectEntry?.request_id ?? finalEntry?.request_id
    await navigate(session, `${base}/page?reset=1`, 'load')
    const resetMessage = staleId ? await expectThrow(() => networkDetail(session, staleId)) : null
    check('导航后旧 request_id 报已重置',
      Boolean(resetMessage) && resetMessage.includes('没有 request_id')
      && resetMessage.includes('页面已导航'),
      String(resetMessage))

    // 未知 / 非法 / 空 request_id 三种错误口径。
    const unknownMessage = await expectThrow(() => networkDetail(session, 'n999999'))
    const invalidMessage = await expectThrow(() => networkDetail(session, 'x1'))
    const missingMessage = await expectThrow(() => networkDetail(session, ''))
    check('未知或非法 request_id 报错',
      Boolean(unknownMessage) && unknownMessage.includes('网络记录里没有 request_id n999999')
      && Boolean(invalidMessage) && invalidMessage.includes('格式不对')
      && Boolean(missingMessage) && missingMessage.includes('缺少必填参数 request_id'),
      JSON.stringify({ unknownMessage, invalidMessage, missingMessage }))

    // max_chars / timeout_ms 越界在入口报错，且常量与规格一致。
    const maxTooSmall = await expectThrow(() => networkDetail(session, 'n1', { maxChars: 0 }))
    const maxTooBig = await expectThrow(() => networkDetail(session, 'n1', { maxChars: NETWORK_BODY_TEXT_LIMIT + 1 }))
    const maxNotInteger = await expectThrow(() => networkDetail(session, 'n1', { maxChars: 1.5 }))
    const timeoutTooSmall = await expectThrow(() => networkDetail(session, 'n1', { timeoutMs: NETWORK_BODY_TIMEOUT_MIN_MS - 1 }))
    const timeoutTooBig = await expectThrow(() => networkDetail(session, 'n1', { timeoutMs: NETWORK_BODY_TIMEOUT_MAX_MS + 1 }))
    check('max_chars / timeout_ms 越界报错',
      [maxTooSmall, maxTooBig, maxNotInteger].every((message) =>
        message?.includes(`max_chars 必须是 1..${NETWORK_BODY_TEXT_LIMIT}`))
      && [timeoutTooSmall, timeoutTooBig].every((message) =>
        message?.includes(`timeout_ms 必须是 ${NETWORK_BODY_TIMEOUT_MIN_MS}..${NETWORK_BODY_TIMEOUT_MAX_MS}`)),
      JSON.stringify({ maxTooSmall, maxTooBig, maxNotInteger, timeoutTooSmall, timeoutTooBig }))
    check('网络正文常量与规格一致',
      NETWORK_BODY_TEXT_LIMIT === 65536 && NETWORK_BODY_TIMEOUT_MS === 5000
      && NETWORK_BODY_TIMEOUT_MIN_MS === 100 && NETWORK_BODY_TIMEOUT_MAX_MS === 30000,
      JSON.stringify({ NETWORK_BODY_TEXT_LIMIT, NETWORK_BODY_TIMEOUT_MS, NETWORK_BODY_TIMEOUT_MIN_MS, NETWORK_BODY_TIMEOUT_MAX_MS }))

    // 网络上下文随环形缓冲淘汰、随 clearRings 清空；request_id 计数不归零。
    const handlers = {}
    const fakePageObj = {
      on: (event, handler) => {
        handlers[event] = handler
      },
      mainFrame: () => ({}),
      evaluate: async () => 'complete',
      viewportSize: () => ({ width: 800, height: 600 }),
    }
    const evictionEntry = {
      id: 'fake-detail',
      page: fakePageObj,
      refs: new Map(),
      consoleRing: [],
      networkRing: [],
      networkByRequest: new Map(),
      networkContext: new Map(),
      nextNetworkSeq: 0,
      loading: false,
      origin: 'created',
    }
    attachPageHooks({ key: 'fake-detail-session', hookedPages: new WeakSet(), emit: () => {} }, evictionEntry)
    for (let i = 0; i < RING_LIMIT + 100; i += 1) {
      handlers.request({
        url: () => `http://127.0.0.1/detail/${i}`,
        method: () => 'GET',
        isNavigationRequest: () => false,
      })
    }
    const evictedOk = evictionEntry.networkContext.size === RING_LIMIT
      && !evictionEntry.networkContext.has('n1')
      && evictionEntry.networkContext.has(`n${RING_LIMIT + 100}`)
      && evictionEntry.networkRing[0].request_id === 'n101'
    clearRings(evictionEntry)
    const clearedOk = evictionEntry.networkContext.size === 0
      && evictionEntry.nextNetworkSeq === RING_LIMIT + 100
    check('网络上下文随环形缓冲淘汰', evictedOk && clearedOk,
      JSON.stringify({ size: RING_LIMIT, nextSeq: evictionEntry.nextNetworkSeq, clearedOk }))

    // tab_id 隔离：同一数字 id 在不同标签页互不串用，跨页查询报记录不存在。
    const tabA = currentTab(session)
    const tabAId = (await networkEntries(session, 100, tabA.id)).entries.at(-1)?.request_id
    const tabB = await navigate(session, `${base}/tab-b`, 'load', { new_tab: true })
    let tabBId = null
    await waitUntil(async () => {
      const info = await networkEntries(session, 100, tabB.tabId)
      tabBId = info.entries.find((entry) => entry.url === `${base}/tab-b`)?.request_id ?? null
      return tabBId !== null
    }, 3000, 100)
    const detailA = tabAId ? await networkDetail(session, tabAId, {}, tabA.id) : null
    const detailB = tabBId ? await networkDetail(session, tabBId, {}, tabB.tabId) : null
    const crossAToB = tabBId ? await expectThrow(() => networkDetail(session, tabBId, {}, tabA.id)) : 'missing tab-b id'
    const crossBToA = tabAId ? await expectThrow(() => networkDetail(session, tabAId, {}, tabB.tabId)) : 'missing tab-a id'
    check('detail 按 tab_id 隔离',
      Boolean(detailA) && detailA.tabId === tabA.id
      && Boolean(detailB) && detailB.tabId === tabB.tabId && detailB.url === `${base}/tab-b`
      && Boolean(crossAToB) && String(crossAToB).includes('网络记录里没有')
      && Boolean(crossBToA) && String(crossBToA).includes('网络记录里没有'),
      JSON.stringify({ tabAId, tabBId, detailB: detailB?.url, crossAToB, crossBToA }))
    // 收掉第二个标签页，保持后续用例「默认只有一个标签页」的前提。
    await closeTab(KEY, tabB.tabId)
  }

  console.log('== 用例 4：snapshot 的 box / role / depth ==')
  {
    await navigate(session, 'data:text/html,<body><div style="padding:20px"><button id="btn" style="position:fixed;left:100px;top:100px;width:100px;height:40px" onclick="window.__clicked=true">Click Me</button></div><input id="chk" type="checkbox" style="position:fixed;left:10px;top:10px"></body>', 'load')
    const info = await snapshot(session)
    const text = info.text
    check('snapshot 返回 summary 与 truncated 字段', typeof info.summary === 'string' && info.truncated === false, JSON.stringify({ summary: info.summary, truncated: info.truncated }))
    // 全 DOM 快照的节点结构：id / classes / name / depth 四个字段都在且类型正确。
    const structureOk = info.nodes.length > 0 && info.nodes.every((node) => typeof node.id === 'string'
      && Array.isArray(node.classes) && node.classes.every((name) => typeof name === 'string')
      && typeof node.name === 'string' && Number.isInteger(node.depth) && node.depth >= 1)
    check('节点结构含 id / classes / name / depth', structureOk, JSON.stringify(info.nodes.slice(0, 3)))
    // 文本行里带 box(...) 且按钮标签正确。
    check('文本含 box(...)', /box\(100,100,100,40\)/.test(text), text)
    check('文本含按钮标签与缩进', text.includes('"Click Me"'), text)
    check('返回项数不少于 2', info.count >= 2, String(info.count))
    // 用 ref 点击验证 ref 可用（同时验证 ref 表里的条目带 box / depth / role）。
    const refLine = text.split('\n').find((line) => line.includes('"Click Me"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    check('能从文本解析出 ref', Boolean(ref), String(refLine))
    const clicked = await click(session, { ref })
    await sleep(100)
    const flag = await evaluate(session, 'window.__clicked === true')
    check('ref 点击生效', flag.value === true, JSON.stringify(clicked))
  }

  console.log('== 用例 4B：id 含引号时 label[for] 不破坏 snapshot ==')
  {
    // id 里带双引号：未转义时查询串变成 label[for="a"b"]，querySelector 抛 SyntaxError，
    // 整次 snapshot 失败。这里验的是快照脚本对 id 做 CSS 转义。
    const quotedHtml = '<body><label for=\'a"b\'>引号标签</label>'
      + '<input id=\'a"b\' style="position:fixed;left:10px;top:10px;width:120px;height:24px"></body>'
    await navigate(session, 'data:text/html;charset=utf-8,' + encodeURIComponent(quotedHtml), 'load')
    let info = null
    let snapshotError = null
    try {
      info = await snapshot(session)
    } catch (error) {
      snapshotError = error
    }
    check('id 含引号时 snapshot 不抛错', snapshotError === null, String(snapshotError))
    const quoted = info?.nodes.find((node) => node.id === 'a"b')
    check('id 含引号时仍能读到 label[for] 文本', quoted?.name === '引号标签',
      JSON.stringify({ names: info?.nodes.map((node) => node.name) }))
  }

  console.log('== 用例 5：selector 点击 / 坐标点击 ==')
  {
    await navigate(session, 'data:text/html,<button id="btn" style="position:fixed;left:100px;top:100px;width:100px;height:40px" onclick="window.__clicked=true">Click Me</button>', 'load')
    const bySelector = await click(session, { selector: '#btn' })
    await sleep(100)
    const afterSelector = await evaluate(session, 'window.__clicked === true')
    check('selector 点击生效', afterSelector.value === true && bySelector.mode === 'selector', JSON.stringify(bySelector))
    // 重置标记，用视口坐标点按钮中心 (150, 120)。
    await evaluate(session, 'window.__clicked = false')
    const byPoint = await click(session, { x: 150, y: 120 })
    await sleep(100)
    const afterPoint = await evaluate(session, 'window.__clicked === true')
    check('坐标点击生效（真实鼠标事件）', afterPoint.value === true && byPoint.mode === 'point', JSON.stringify(byPoint))
    const noneMessage = await expectThrow(() => click(session, {}))
    check('三种目标都不给时报错', Boolean(noneMessage) && /ref|selector|x \+ y/.test(noneMessage ?? ''), String(noneMessage))
  }

  console.log('== 用例 5B：fill 三种目标（ref / selector / 坐标）==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0">'
      + '<input id="a" placeholder="first" style="position:fixed;left:20px;top:20px;width:200px;height:30px">'
      + '<input id="b" placeholder="second" style="position:fixed;left:20px;top:80px;width:200px;height:30px">'
      + '<input id="c" placeholder="third" style="position:fixed;left:20px;top:140px;width:200px;height:30px">'
      + '</body>', 'load')
    const info = await snapshot(session)
    const first = info.nodes.find((node) => node.id === 'a')
    const third = info.nodes.find((node) => node.id === 'c')
    check('快照能定位到三个输入框', Boolean(first) && Boolean(third) && Boolean(info.nodes.find((node) => node.id === 'b')), JSON.stringify(info.nodes.slice(0, 6)))
    const byRef = await fill(session, { ref: first?.ref }, 'ref-value')
    const bySelector = await fill(session, { selector: '#b' }, 'selector-value')
    // 坐标取 #c 的 box 中心；fill 的坐标分支是真实鼠标点击后键入。
    const pointX = third ? third.box.x + Math.round(third.box.width / 2) : 0
    const pointY = third ? third.box.y + Math.round(third.box.height / 2) : 0
    const byPoint = await fill(session, { x: pointX, y: pointY }, 'point-value')
    const values = await evaluate(session, "['a','b','c'].map(function (id) { return document.getElementById(id).value })")
    check('ref 写入生效', values.value?.[0] === 'ref-value' && byRef.mode === 'ref', JSON.stringify({ values: values.value, byRef }))
    check('selector 写入生效', values.value?.[1] === 'selector-value' && bySelector.mode === 'selector', JSON.stringify({ values: values.value, bySelector }))
    check('坐标写入生效', values.value?.[2] === 'point-value' && byPoint.mode === 'point', JSON.stringify({ values: values.value, byPoint }))
    const fillNone = await expectThrow(() => fill(session, {}, 'x'))
    check('三种目标都不给时报错', Boolean(fillNone) && fillNone.includes('ref / selector / x + y'), String(fillNone))
  }

  console.log('== 用例 5D：fill 不误切换 checkbox / radio ==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0">'
      + '<input id="chk" type="checkbox" style="position:fixed;left:20px;top:20px;width:24px;height:24px">'
      + '<input id="rad" type="radio" name="g" style="position:fixed;left:20px;top:80px;width:24px;height:24px">'
      + '<input id="txt" placeholder="text" style="position:fixed;left:20px;top:140px;width:200px;height:30px">'
      + '</body>', 'load')
    const info = await snapshot(session)
    const chk = info.nodes.find((node) => node.id === 'chk')
    const rad = info.nodes.find((node) => node.id === 'rad')
    const txt = info.nodes.find((node) => node.id === 'txt')
    check('快照能定位到 checkbox / radio / 文本框', Boolean(chk) && Boolean(rad) && Boolean(txt), JSON.stringify(info.nodes.slice(0, 8)))
    const chkFill = await expectThrow(() => fill(session, { ref: chk?.ref }, 'on'))
    check('checkbox 用 ref 填写报「可切换控件」并提示改用 click', Boolean(chkFill) && chkFill.includes('可切换控件') && chkFill.includes('browser_e2e_click'), String(chkFill))
    const radFill = await expectThrow(() => fill(session, { ref: rad?.ref }, 'on'))
    check('radio 用 ref 填写报「可切换控件」', Boolean(radFill) && radFill.includes('可切换控件'), String(radFill))
    const states = await evaluate(session, "({ chk: document.getElementById('chk').checked, rad: document.getElementById('rad').checked })")
    check('fill 后 checkbox / radio 勾选状态未变', states.value?.chk === false && states.value?.rad === false, JSON.stringify(states.value))
    // 仍可交互：用 click 明确切换，再用 fill 写文本框。
    await click(session, { ref: chk?.ref })
    const afterClick = await evaluate(session, "document.getElementById('chk').checked")
    check('随后用 click 能正常切换 checkbox', afterClick.value === true, JSON.stringify(afterClick.value))
    const txtFill = await fill(session, { ref: txt?.ref }, 'still-works')
    const txtValue = await evaluate(session, "document.getElementById('txt').value")
    check('同页文本框 fill 仍生效', txtFill.mode === 'ref' && txtValue.value === 'still-works', JSON.stringify({ txtFill, txtValue: txtValue.value }))
  }

  console.log('== 用例 5C：scroll（滚动 / 坐标 / 非法 delta）==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0"><div style="height:3000px;background-color:gray"></div></body>', 'load')
    const before = await evaluate(session, 'window.scrollY')
    const info = await scroll(session, { delta_y: 600 })
    await sleep(200)
    const after = await evaluate(session, 'window.scrollY')
    check('滚动后 window.scrollY 增加', before.value === 0 && after.value > 0, `${before.value} -> ${after.value}`)
    check('返回 deltaX / deltaY 与摘要', info.mode === 'scroll' && info.deltaX === 0 && info.deltaY === 600, JSON.stringify(info))
    // 坐标滚动：先把鼠标移到视口内再滚，scrollY 继续增加。
    const moved = await scroll(session, { x: 200, y: 200, delta_y: 400 })
    await sleep(200)
    const afterPoint = await evaluate(session, 'window.scrollY')
    check('坐标滚动继续增加 scrollY', afterPoint.value > after.value && moved.deltaY === 400, `${after.value} -> ${afterPoint.value}`)
    const zero = await expectThrow(() => scroll(session, { delta_x: 0, delta_y: 0 }))
    check('delta 全 0 报错', Boolean(zero) && zero.includes('非 0'), String(zero))
    const badDelta = await expectThrow(() => scroll(session, { delta_y: 'not-a-number' }))
    check('非数字 delta 报错', Boolean(badDelta) && badDelta.includes('必须是数字'), String(badDelta))
  }

  console.log('== 用例 5E：fill 逐键模式（keystrokes / delayMs / 受控 / 掩码 / 防抖）==')
  {
    // 同一页放齐夹具：普通输入框、textarea、contenteditable、maxlength、防抖、受控、掩码，
    // 以及 select / file 两个非文本目标；document 级监听统一记录 keydown / keyup / input。
    const keystrokeHtml = '<!doctype html><html><body style="margin:0">'
      + '<input id="k" value="old" style="position:fixed;left:20px;top:20px;width:240px;height:30px">'
      + '<textarea id="ta" style="position:fixed;left:20px;top:70px;width:240px;height:60px"></textarea>'
      + '<div id="ce" contenteditable="true" style="position:fixed;left:20px;top:150px;width:240px;height:40px;border:1px solid #999"></div>'
      + '<input id="ml" maxlength="5" style="position:fixed;left:20px;top:210px;width:240px;height:30px">'
      + '<input id="plain" style="position:fixed;left:20px;top:260px;width:240px;height:30px">'
      + '<input id="deb" style="position:fixed;left:20px;top:310px;width:240px;height:30px">'
      + '<input id="ctl" style="position:fixed;left:20px;top:360px;width:240px;height:30px">'
      + '<input id="mask" style="position:fixed;left:20px;top:410px;width:240px;height:30px">'
      + '<select id="sel" style="position:fixed;left:300px;top:20px;width:120px;height:30px"><option>one</option></select>'
      + '<input id="file" type="file" style="position:fixed;left:300px;top:70px;width:200px;height:30px">'
      + '<script>'
      + 'window.__ev = { down: [], up: [], inputs: [] };'
      + 'document.addEventListener("keydown", function (e) { window.__ev.down.push(e.key) });'
      + 'document.addEventListener("keyup", function (e) { window.__ev.up.push(e.key) });'
      + 'document.addEventListener("input", function (e) { window.__ev.inputs.push(e.target.value) });'
      // 防抖：120ms 内的连续 input 只落一次结果，验证逐键路径确实逐字符进入组件。
      + 'window.__debounceRuns = 0; window.__debounced = ""; var debTimer = null; var deb = document.getElementById("deb");'
      + 'deb.addEventListener("input", function () { var v = deb.value; clearTimeout(debTimer);'
      + ' debTimer = setTimeout(function () { window.__debounceRuns += 1; window.__debounced = v }, 120) });'
      // 受控：只保留数字，组件在每次 input 里回写 value；插入式一次性写入只会产生一次 input。
      + 'window.__ctlInputs = []; var ctl = document.getElementById("ctl");'
      + 'ctl.addEventListener("input", function () { var raw = ctl.value; window.__ctlInputs.push(raw);'
      + ' ctl.value = raw.replace(/[^0-9]/g, "") });'
      // 掩码：每 3 位插一个连字符，最终显示值必然与传入 value 不同。
      + 'window.__maskInputs = []; var mask = document.getElementById("mask");'
      + 'mask.addEventListener("input", function () { var d = mask.value.replace(/[^0-9]/g, "").slice(0, 6);'
      + ' var formatted = d.slice(0, 3) + (d.length > 3 ? "-" + d.slice(3) : "");'
      + ' window.__maskInputs.push(formatted); mask.value = formatted });'
      + '</script></body></html>'
    await navigate(session, dataUrl(keystrokeHtml), 'load')
    const resetEvents = () => evaluate(session, 'window.__ev = { down: [], up: [], inputs: [] }; true')
    const eventLog = async () => (await evaluate(session, 'window.__ev')).value

    // ref 路径：逐键写入替换旧值，返回形状与摘要都带 keystrokes 字段。
    const keystrokeSnapshot = await snapshot(session)
    const kNode = keystrokeSnapshot.nodes.find((node) => node.id === 'k')
    const byRef = await fill(session, { ref: kNode?.ref }, 'new', undefined, { mode: 'keystrokes' })
    const kValue = await evaluate(session, "document.getElementById('k').value")
    check('keystrokes 逐键写入并替换旧值', byRef.mode === 'ref' && byRef.inputMode === 'keystrokes'
      && byRef.chars === 3 && byRef.delayMs === 0 && byRef.value === 'new' && kValue.value === 'new'
      && byRef.summary.startsWith(`逐键填写 ${kNode?.ref} `) && byRef.summary.includes('3 个字符')
      && byRef.summary.includes('delayMs=0'),
    JSON.stringify({ byRef, kValue: kValue.value, ref: kNode?.ref }))

    // 每个 US 键盘可表达字符都产生 keydown / keyup（清空产生的那次 Delete 另算）。
    await resetEvents()
    await evaluate(session, "document.getElementById('k').value = 'OLD'")
    const typed = await fill(session, { selector: '#k' }, 'ab12', undefined, { mode: 'keystrokes' })
    const typedEvents = await eventLog()
    check('keystrokes 每个字符产生 keydown / keyup',
      [...'ab12'].every((ch) => typedEvents.down.includes(ch) && typedEvents.up.includes(ch))
        && typed.chars === 4,
      JSON.stringify({ down: typedEvents.down, up: typedEvents.up, chars: typed.chars }))

    // 清空是「全选 + Delete」：非空输入框每次 keystrokes 填写固定产生 1 次 Delete。
    await resetEvents()
    await evaluate(session, "document.getElementById('k').value = 'OLD'")
    await fill(session, { selector: '#k' }, 'z', undefined, { mode: 'keystrokes' })
    const deleteEvents = await eventLog()
    check('keystrokes 清空产生一次 Delete',
      deleteEvents.down.filter((key) => key === 'Delete').length === 1,
      JSON.stringify({ down: deleteEvents.down }))

    // contenteditable：无 input/textarea 包装也能逐键写入。
    await resetEvents()
    const ceFill = await fill(session, { selector: '#ce' }, 'edit', undefined, { mode: 'keystrokes' })
    const ceText = await evaluate(session, "document.getElementById('ce').textContent")
    check('keystrokes 支持 contenteditable',
      ceFill.inputMode === 'keystrokes' && ceFill.chars === 4 && ceText.value === 'edit',
      JSON.stringify({ ceFill, ceText: ceText.value }))

    // textarea 里的 \n 映射为 Enter 键，产生换行而不是插入字面量。
    await resetEvents()
    const taFill = await fill(session, { selector: '#ta' }, 'a\nb', undefined, { mode: 'keystrokes' })
    const taValue = await evaluate(session, "document.getElementById('ta').value")
    const enterDowns = (await eventLog()).down.filter((key) => key === 'Enter').length
    check('keystrokes 在 textarea 中把 \\n 作为 Enter',
      taFill.chars === 3 && taValue.value === 'a\nb' && enterDowns === 1,
      JSON.stringify({ chars: taFill.chars, value: taValue.value, enterDowns }))

    // delayMs 实际拉长耗时；同一页的防抖组件在最后一个按键后落定成完整值。
    const fastStart = Date.now()
    await fill(session, { selector: '#plain' }, 'abcdefghijklmnopqrst', undefined, { mode: 'keystrokes' })
    const fastElapsed = Date.now() - fastStart
    const slowStart = Date.now()
    const slow = await fill(session, { selector: '#plain' }, 'abcdefghijklmnopqrst', undefined,
      { mode: 'keystrokes', delayMs: 30 })
    const slowElapsed = Date.now() - slowStart
    await evaluate(session, 'window.__debounceRuns = 0; window.__debounced = ""')
    const debouncedFill = await fill(session, { selector: '#deb' }, 'abcdef', undefined,
      { mode: 'keystrokes', delayMs: 40 })
    await sleep(400)
    const debouncedState = await evaluate(session, '({ runs: window.__debounceRuns, value: window.__debounced })')
    check('keystrokes 的 delayMs 拉长总耗时', slow.delayMs === 30 && slowElapsed >= fastElapsed + 300
      && debouncedFill.inputMode === 'keystrokes' && debouncedState.value?.runs >= 1
      && debouncedState.value?.value === 'abcdef',
    JSON.stringify({ fastElapsed, slowElapsed, delayMs: slow.delayMs, debounced: debouncedState.value }))

    // 受控组件：每次 input 都回写 value，4 个字符必须产生 4 次 input，最终值是被组件改写的 '12'。
    const controlled = await fill(session, { selector: '#ctl' }, 'a1b2', undefined, { mode: 'keystrokes' })
    const controlledState = await evaluate(session, "({ inputs: window.__ctlInputs, value: document.getElementById('ctl').value })")
    check('keystrokes 逐字符触发受控输入', controlled.inputMode === 'keystrokes'
      && controlledState.value?.inputs.length === 4 && controlledState.value?.inputs.includes('1b')
      && controlledState.value?.value === '12',
    JSON.stringify({ controlled, state: controlledState.value }))

    // 掩码组件：逐字符进入后由组件重排为 123-456，证明每键都触发了 input。
    const masked = await fill(session, { selector: '#mask' }, '123456', undefined, { mode: 'keystrokes' })
    const maskedState = await evaluate(session, "({ inputs: window.__maskInputs, value: document.getElementById('mask').value })")
    check('keystrokes 逐字符触发掩码输入', masked.inputMode === 'keystrokes'
      && maskedState.value?.inputs.length === 6
      && maskedState.value?.inputs.at(-1) === '123-456' && maskedState.value?.value === '123-456',
    JSON.stringify({ masked, state: maskedState.value }))

    // 不回读最终 value：maxlength 截断后 DOM 是 abcde，返回的 value 仍是传入的 abcdef。
    await resetEvents()
    const maxlength = await fill(session, { selector: '#ml' }, 'abcdef', undefined, { mode: 'keystrokes' })
    const maxlengthValue = await evaluate(session, "document.getElementById('ml').value")
    check('keystrokes 不回读最终 value', maxlength.value === 'abcdef' && maxlength.chars === 6
      && maxlengthValue.value === 'abcde' && maxlength.summary.includes('"abcdef"'),
    JSON.stringify({ maxlength, domValue: maxlengthValue.value }))

    // 中文走 Input.insertText：每个码点一次 input，不产生对应 keydown。
    await evaluate(session, "document.getElementById('k').value = ''")
    await resetEvents()
    const chinese = await fill(session, { selector: '#k' }, '中文', undefined, { mode: 'keystrokes' })
    const chineseEvents = await eventLog()
    const chineseValue = await evaluate(session, "document.getElementById('k').value")
    check('keystrokes 中文走 insertText、不产生 keydown', chinese.chars === 2 && chineseValue.value === '中文'
      && !chineseEvents.down.includes('中') && !chineseEvents.down.includes('文')
      && chineseEvents.inputs.length === 2,
    JSON.stringify({ chinese, value: chineseValue.value, down: chineseEvents.down, inputs: chineseEvents.inputs }))

    // 坐标目标在点击前就被拒（无法可靠清空和校验可编辑性）。
    const pointMessage = await expectThrow(() => fill(session, { x: 60, y: 35 }, 'x', undefined, { mode: 'keystrokes' }))
    check('keystrokes 坐标目标报错', Boolean(pointMessage) && pointMessage.includes('需要 ref 或 selector')
      && pointMessage.includes('坐标目标无法可靠清空'), String(pointMessage))

    // select 与非文本 input 按各自文案拒绝，并提示改用路径。
    const selectMessage = await expectThrow(() => fill(session, { selector: '#sel' }, 'x', undefined, { mode: 'keystrokes' }))
    const fileMessage = await expectThrow(() => fill(session, { selector: '#file' }, 'x', undefined, { mode: 'keystrokes' }))
    check('keystrokes 对 select / 非文本 input 报错',
      Boolean(selectMessage) && selectMessage.includes('下拉选择控件 select') && selectMessage.includes('browser_e2e_press')
        && Boolean(fileMessage) && fileMessage.includes('不是可逐键输入的文本目标')
        && fileMessage.includes('input[type=file]'),
      JSON.stringify({ selectMessage, fileMessage }))

    // 参数校验：delayMs 只能配 keystrokes；mode 只接受两个枚举值。
    const insertDelay = await expectThrow(() => fill(session, { selector: '#plain' }, 'x', undefined,
      { mode: 'insert', delayMs: 10 }))
    const implicitInsertDelay = await expectThrow(() => fill(session, { selector: '#plain' }, 'x', undefined, { delayMs: 10 }))
    check('delayMs 只允许 keystrokes', Boolean(insertDelay)
      && insertDelay.includes('delayMs 只对 mode=keystrokes 生效')
      && Boolean(implicitInsertDelay) && implicitInsertDelay.includes('delayMs 只对 mode=keystrokes 生效'),
    JSON.stringify({ insertDelay, implicitInsertDelay }))

    const delayTooBig = await expectThrow(() => fill(session, { selector: '#plain' }, 'x', undefined,
      { mode: 'keystrokes', delayMs: 1001 }))
    const delayNegative = await expectThrow(() => fill(session, { selector: '#plain' }, 'x', undefined,
      { mode: 'keystrokes', delayMs: -1 }))
    const delayFraction = await expectThrow(() => fill(session, { selector: '#plain' }, 'x', undefined,
      { mode: 'keystrokes', delayMs: 1.5 }))
    check('delayMs 越界报错', Boolean(delayTooBig) && delayTooBig.includes('delayMs 必须是 0-1000 的整数，收到 1001')
      && Boolean(delayNegative) && delayNegative.includes('收到 -1')
      && Boolean(delayFraction) && delayFraction.includes('收到 1.5'),
    JSON.stringify({ delayTooBig, delayNegative, delayFraction }))

    const badMode = await expectThrow(() => fill(session, { selector: '#plain' }, 'x', undefined, { mode: 'typing' }))
    check('mode 非法报错', Boolean(badMode) && badMode.includes('mode 只支持 insert / keystrokes')
      && badMode.includes('"typing"'), String(badMode))

    const tooLong = await expectThrow(() => fill(session, { selector: '#plain' }, 'x'.repeat(2001), undefined,
      { mode: 'keystrokes' }))
    check('keystrokes 超过 2000 字符报错', Boolean(tooLong)
      && tooLong.includes('一次最多 2000 个字符') && tooLong.includes('收到 2001'), String(tooLong))

    // 时间预算文案按规格固定：delayMs × 字符数，500 × 100 = 50000 ms 超过 30000 ms。
    const overBudget = await expectThrow(() => fill(session, { selector: '#plain' }, 'x'.repeat(100), undefined,
      { mode: 'keystrokes', delayMs: 500 }))
    check('delayMs × 字符数超过 30000ms 报错', Boolean(overBudget)
      && overBudget.includes('不能超过 30000 ms') && overBudget.includes('500 × 100') && overBudget.includes('50000'),
    String(overBudget))

    // 缺省 insert：一次写入、不产生任何按键事件，返回形状与旧版逐字段一致。
    await evaluate(session, "document.getElementById('plain').value = ''")
    await resetEvents()
    const inserted = await fill(session, { selector: '#plain' }, 'inserted')
    const insertedEvents = await eventLog()
    const insertedValue = await evaluate(session, "document.getElementById('plain').value")
    check('mode 缺省为 insert 且不产生按键事件', inserted.inputMode === undefined && inserted.mode === 'selector'
      && insertedValue.value === 'inserted' && insertedEvents.down.length === 0 && insertedEvents.up.length === 0
      && insertedEvents.inputs.length === 1
      && inserted.summary === '填写 selector "#plain" <- "inserted"',
    JSON.stringify({ inserted, domValue: insertedValue.value, down: insertedEvents.down, inputs: insertedEvents.inputs }))
  }

  console.log('== 用例 5F：hover（ref / selector / 坐标 / settleMs / 失效 ref / 非法输入）==')
  {
    // ref 悬停：CSS :hover 展开子菜单，证明是真实鼠标移动而不是合成事件。
    const menuHtml = '<!doctype html><html><head><style>'
      + '#menu { position: fixed; left: 20px; top: 20px; width: 160px; height: 40px; background: #eeeeee; }'
      + '#sub { display: none; position: fixed; left: 20px; top: 60px; width: 160px; height: 100px; background: #ccddee; }'
      + '#menu:hover ~ #sub { display: block; }'
      + '</style></head><body><div id="menu">菜单</div><div id="sub">子项</div></body></html>'
    await navigate(session, dataUrl(menuHtml), 'load')
    const menuSnapshot = await snapshot(session)
    const menuNode = menuSnapshot.nodes.find((node) => node.id === 'menu')
    const byRef = await hover(session, { ref: menuNode?.ref })
    const subDisplay = await evaluate(session, "getComputedStyle(document.getElementById('sub')).display")
    check('悬停 ref 展开 CSS 菜单', byRef.mode === 'ref' && byRef.ref === menuNode?.ref
      && subDisplay.value === 'block', JSON.stringify({ byRef, ref: menuNode?.ref, subDisplay: subDisplay.value }))

    // selector 悬停：mouseover 事件计数 >= 1。
    const mouseoverHtml = '<!doctype html><html><body style="margin:0">'
      + '<div id="hover-target" style="position:fixed;left:20px;top:20px;width:200px;height:60px;background:#eeeeee">hover me</div>'
      + '<script>window.__over = 0; var t = document.getElementById("hover-target");'
      + ' t.addEventListener("mouseover", function () { window.__over += 1 });</script></body></html>'
    await navigate(session, dataUrl(mouseoverHtml), 'load')
    const bySelector = await hover(session, { selector: '#hover-target' })
    const overCount = await evaluate(session, 'window.__over')
    check('悬停 selector 触发 mouseover 计数', bySelector.mode === 'selector' && bySelector.selector === '#hover-target'
      && overCount.value >= 1, JSON.stringify({ bySelector, overCount: overCount.value }))

    // 坐标悬停：真实鼠标移动（触发 mousemove / mouseenter）但不产生 click。
    const pointHoverHtml = '<!doctype html><html><body style="margin:0">'
      + '<div id="pad" style="position:fixed;left:100px;top:100px;width:200px;height:100px;background:#ffdddd">pad</div>'
      + '<script>window.__hoverStats = { moves: 0, clicks: 0, enters: 0 }; var pad = document.getElementById("pad");'
      + ' pad.addEventListener("mousemove", function () { window.__hoverStats.moves += 1 });'
      + ' pad.addEventListener("click", function () { window.__hoverStats.clicks += 1 });'
      + ' pad.addEventListener("mouseenter", function () { window.__hoverStats.enters += 1 });</script></body></html>'
    await navigate(session, dataUrl(pointHoverHtml), 'load')
    const byPoint = await hover(session, { x: 150, y: 140, settleMs: 300 })
    const hoverStats = await evaluate(session, 'window.__hoverStats')
    check('坐标悬停移动真实鼠标且未触发 click', byPoint.mode === 'point' && byPoint.x === 150 && byPoint.y === 140
      && hoverStats.value?.moves >= 1 && hoverStats.value?.enters >= 1 && hoverStats.value?.clicks === 0,
    JSON.stringify({ byPoint, hoverStats: hoverStats.value }))

    // settleMs 实际等待：600ms 分支实际耗时明显长于 0 分支，且不少于 550ms。
    await navigate(session, dataUrl(menuHtml), 'load')
    const fastStart = Date.now()
    const fast = await hover(session, { selector: '#menu', settleMs: 0 })
    const fastElapsed = Date.now() - fastStart
    const slowStart = Date.now()
    const slow = await hover(session, { selector: '#menu', settleMs: 600 })
    const slowElapsed = Date.now() - slowStart
    check('hover 的 settleMs 实际等待', fast.settleMs === 0 && slow.settleMs === 600
      && slowElapsed >= 550 && slowElapsed > fastElapsed,
    JSON.stringify({ fastSettleMs: fast.settleMs, slowSettleMs: slow.settleMs, fastElapsed, slowElapsed }))

    // 失效 ref：报「已失效」，且没有发出任何鼠标移动。
    const goneHtml = '<!doctype html><html><body style="margin:0">'
      + '<div id="gone" style="position:fixed;left:20px;top:20px;width:160px;height:40px;background:#eeeeee">gone</div>'
      + '<script>window.__mouseMoves = 0; document.addEventListener("mousemove", function () { window.__mouseMoves += 1 });</script></body></html>'
    await navigate(session, dataUrl(goneHtml), 'load')
    const goneSnapshot = await snapshot(session)
    const goneRef = goneSnapshot.nodes.find((node) => node.id === 'gone')?.ref
    await evaluate(session, "document.getElementById('gone').remove()")
    await sleep(100)
    const movesBefore = (await evaluate(session, 'window.__mouseMoves')).value
    const goneMessage = await expectThrow(() => hover(session, { ref: goneRef }))
    const movesAfter = (await evaluate(session, 'window.__mouseMoves')).value
    check('hover 失效 ref 报已失效且未移动鼠标', Boolean(goneMessage) && goneMessage.includes('已失效')
      && movesBefore === 0 && movesAfter === movesBefore,
    JSON.stringify({ goneMessage, movesBefore, movesAfter }))

    // 非法输入：一个目标都没给（含空串视为未给）与多于一种都报错。
    const noTarget = await expectThrow(() => hover(session, {}))
    const blankTarget = await expectThrow(() => hover(session, { ref: '', selector: '' }))
    const twoTargets = await expectThrow(() => hover(session, { selector: '#menu', x: 10, y: 10 }))
    check('hover 三种目标都不给时报错', Boolean(noTarget) && noTarget.includes('缺少悬停目标') && noTarget.includes('三选一')
      && Boolean(blankTarget) && blankTarget.includes('缺少悬停目标')
      && Boolean(twoTargets) && twoTargets.includes('悬停目标只能给一种'),
    JSON.stringify({ noTarget, blankTarget, twoTargets }))
  }

  console.log('== 用例 5G：drag（元素到元素 / 坐标 / steps / 失效目标 / 越界 / 非法输入）==')
  {
    // HTML5 draggable 列表：拖 A 到 C 之后，验证原生 dragstart / dragover / drop 与重排。
    const listHtml = '<!doctype html><html><head><style>'
      + 'body { margin: 0; font: 14px sans-serif; }'
      + '#list { list-style: none; margin: 0; padding: 0; position: fixed; left: 20px; top: 20px; width: 200px; }'
      + '#list li { height: 40px; line-height: 40px; padding-left: 10px; margin-bottom: 4px; background: #ddeeff; border: 1px solid #99aabb; }'
      + '</style></head><body><ul id="list">'
      + '<li id="a" draggable="true">A</li><li id="b" draggable="true">B</li><li id="c" draggable="true">C</li>'
      + '</ul><script>'
      + 'window.__dragEvents = { dragstart: 0, dragover: 0, drop: 0, dragend: 0 }; var list = document.getElementById("list");'
      + ' Array.prototype.forEach.call(list.children, function (li) {'
      + '   li.addEventListener("dragstart", function (e) { window.__dragEvents.dragstart += 1;'
      + '     e.dataTransfer.setData("text/plain", li.id); e.dataTransfer.effectAllowed = "move"; }); });'
      + ' list.addEventListener("dragover", function (e) { e.preventDefault(); e.dataTransfer.dropEffect = "move";'
      + '   window.__dragEvents.dragover += 1; });'
      + ' list.addEventListener("drop", function (e) { e.preventDefault(); window.__dragEvents.drop += 1;'
      + '   var dragged = document.getElementById(e.dataTransfer.getData("text/plain"));'
      + '   var target = e.target && e.target.closest ? e.target.closest("li") : null;'
      + '   if (!dragged || !target || target === dragged) return; list.insertBefore(dragged, target.nextSibling); });'
      + ' list.addEventListener("dragend", function () { window.__dragEvents.dragend += 1; });'
      + '</script></body></html>'
    await navigate(session, dataUrl(listHtml), 'load')
    const listSnapshot = await snapshot(session)
    const refOf = (id) => listSnapshot.nodes.find((node) => node.id === id)?.ref
    const dragged = await drag(session, { from: { ref: refOf('a') }, to: { ref: refOf('c') }, steps: 8, settleMs: 300 })
    const dragEvents = await evaluate(session, 'window.__dragEvents')
    const order = await evaluate(session, "Array.prototype.map.call(document.getElementById('list').children, function (li) { return li.id })")
    check('元素到元素拖拽重排列表并触发 dragstart/dragover/drop', dragged.path === 'dragTo'
      && dragged.fromMode === 'ref' && dragged.toMode === 'ref' && dragged.steps === 8
      && dragEvents.value?.dragstart >= 1 && dragEvents.value?.dragover >= 1 && dragEvents.value?.drop === 1
      && JSON.stringify(order.value) === JSON.stringify(['b', 'c', 'a']),
    JSON.stringify({ dragged, dragEvents: dragEvents.value, order: order.value }))

    // 坐标拖拽：真实指针事件链，isTrusted 必须为 true（合成事件验证会假通过）。
    const padHtml = '<!doctype html><html><body style="margin:0">'
      + '<div id="pad" style="position:fixed;left:0;top:0;width:600px;height:400px;background:#eeeeee">pad</div>'
      + '<script>window.__ptr = { down: 0, move: 0, up: 0, trusted: true };'
      + ' function note(name) { return function (e) { window.__ptr[name] += 1; if (!e.isTrusted) window.__ptr.trusted = false; }; }'
      + ' document.addEventListener("pointerdown", note("down"));'
      + ' document.addEventListener("pointermove", note("move"));'
      + ' document.addEventListener("pointerup", note("up"));'
      + ' window.__dragMoves = { tracking: false, count: 0 };'
      + ' document.addEventListener("mousedown", function () { window.__dragMoves.tracking = true; window.__dragMoves.count = 0; });'
      + ' document.addEventListener("mousemove", function () { if (window.__dragMoves.tracking) window.__dragMoves.count += 1; });'
      + ' document.addEventListener("mouseup", function () { window.__dragMoves.tracking = false; });'
      + '</script></body></html>'
    await navigate(session, dataUrl(padHtml), 'load')
    const pointDrag = await drag(session, { from: { x: 100, y: 100 }, to: { x: 400, y: 300 }, steps: 5, settleMs: 300 })
    const pointerStats = await evaluate(session, 'window.__ptr')
    check('坐标拖拽触发 pointerdown/pointermove/pointerup 且 isTrusted 为 true', pointDrag.path === 'mouse'
      && pointDrag.fromMode === 'point' && pointDrag.toMode === 'point'
      && pointerStats.value?.down >= 1 && pointerStats.value?.move >= 1 && pointerStats.value?.up >= 1
      && pointerStats.value?.trusted === true,
    JSON.stringify({ pointDrag, pointerStats: pointerStats.value }))

    // steps 是按下与松开之间的插值 mousemove 次数：3 与 9 各发对应次数。
    const movesOf = async (steps) => {
      await drag(session, { from: { x: 100, y: 100 }, to: { x: 400, y: 300 }, steps, settleMs: 0 })
      return (await evaluate(session, 'window.__dragMoves.count')).value
    }
    const moves3 = await movesOf(3)
    const moves9 = await movesOf(9)
    check('steps 控制中间 mousemove 次数', moves3 === 3 && moves9 === 9,
      JSON.stringify({ moves3, moves9 }))

    // 目标 ref 失效：按下鼠标之前就报错，不产生 mousedown。
    const staleTargetHtml = '<!doctype html><html><body style="margin:0">'
      + '<div id="src" style="position:fixed;left:20px;top:20px;width:100px;height:100px;background:#ccddee">src</div>'
      + '<div id="dst" style="position:fixed;left:200px;top:20px;width:100px;height:100px;background:#eeddcc">dst</div>'
      + '<script>window.__mouseDowns = 0; document.addEventListener("mousedown", function () { window.__mouseDowns += 1 });</script>'
      + '</body></html>'
    await navigate(session, dataUrl(staleTargetHtml), 'load')
    const staleSnapshot = await snapshot(session)
    const srcRef = staleSnapshot.nodes.find((node) => node.id === 'src')?.ref
    const dstRef = staleSnapshot.nodes.find((node) => node.id === 'dst')?.ref
    await evaluate(session, "document.getElementById('dst').remove()")
    await sleep(100)
    const staleMessage = await expectThrow(() => drag(session, { from: { ref: srcRef }, to: { ref: dstRef } }))
    const mouseDowns = (await evaluate(session, 'window.__mouseDowns')).value
    check('拖拽目标 ref 失效时未按下鼠标', Boolean(staleMessage) && staleMessage.includes('已失效') && mouseDowns === 0,
      JSON.stringify({ staleMessage, mouseDowns }))

    // 坐标越界：负数 / x 超宽 / y 超高，文案沿用 click 口径。
    const negative = await expectThrow(() => drag(session, { from: { x: -1, y: 10 }, to: { x: 10, y: 10 } }))
    const wideX = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 10000, y: 10 } }))
    const tallY = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 10, y: 10000 } }))
    check('drag 坐标越界报错', Boolean(negative) && negative.includes('坐标不能为负数')
      && Boolean(wideX) && wideX.includes('超出视口宽度')
      && Boolean(tallY) && tallY.includes('超出视口高度'),
    JSON.stringify({ negative, wideX, tallY }))

    // 缺 from / 缺 to / 单侧多于一种目标。
    const noFrom = await expectThrow(() => drag(session, {}))
    const noTo = await expectThrow(() => drag(session, { from: { x: 10, y: 10 } }))
    const fromTwo = await expectThrow(() => drag(session, { from: { ref: '@1', selector: '#src' }, to: { x: 10, y: 10 } }))
    const toTwo = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { selector: '#dst', x: 20, y: 20 } }))
    check('drag 缺 from/to 或单侧多目标报错', Boolean(noFrom) && noFrom.includes('缺少拖拽起点（from）目标')
      && Boolean(noTo) && noTo.includes('缺少拖拽终点（to）目标')
      && Boolean(fromTwo) && fromTwo.includes('拖拽起点（from）目标只能给一种')
      && Boolean(toTwo) && toTwo.includes('拖拽终点（to）目标只能给一种'),
    JSON.stringify({ noFrom, noTo, fromTwo, toTwo }))

    // steps / settleMs 区间与整数校验（hover 的 settleMs 同一口径）。
    const stepsZero = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, steps: 0 }))
    const stepsTooMany = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, steps: 61 }))
    const stepsFraction = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, steps: 4.5 }))
    const settleNegative = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, settleMs: -1 }))
    const settleTooBig = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, settleMs: 5001 }))
    const settleFraction = await expectThrow(() => drag(session, { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, settleMs: 1.5 }))
    const hoverSettleBad = await expectThrow(() => hover(session, { x: 10, y: 10, settleMs: 5001 }))
    check('steps 与 settleMs 非法报错', Boolean(stepsZero) && stepsZero.includes('steps 必须是 1-60 的整数，收到 0')
      && Boolean(stepsTooMany) && stepsTooMany.includes('收到 61')
      && Boolean(stepsFraction) && stepsFraction.includes('收到 4.5')
      && Boolean(settleNegative) && settleNegative.includes('settleMs 必须是 0-5000 的整数，收到 -1')
      && Boolean(settleTooBig) && settleTooBig.includes('收到 5001')
      && Boolean(settleFraction) && settleFraction.includes('收到 1.5')
      && Boolean(hoverSettleBad) && hoverSettleBad.includes('settleMs 必须是 0-5000 的整数'),
    JSON.stringify({ stepsZero, stepsTooMany, stepsFraction, settleNegative, settleTooBig, settleFraction, hoverSettleBad }))
  }

  console.log('== 用例 6：ref 失效检测 ==')
  {
    await navigate(session, 'data:text/html,<button id="btn" onclick="window.__clicked=true">Click Me</button>', 'load')
    const info = await snapshot(session)
    const refLine = info.text.split('\n').find((line) => line.includes('"Click Me"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    await evaluate(session, "document.getElementById('btn').remove()")
    const message = await expectThrow(() => click(session, { ref }))
    check('失效 ref 报「已失效，请重新 snapshot」', Boolean(message) && message.includes('已失效'), String(message))
    const fillMessage = await expectThrow(() => fill(session, { ref }, 'x'))
    check('失效 ref 的 fill 同样报「已失效」而不是点空', Boolean(fillMessage) && fillMessage.includes('已失效'), String(fillMessage))
  }

  console.log('== 用例 7：截图增强（clip / jpeg / 校验链）==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0"><div style="width:200px;height:120px;background:#3a7"></div></body>', 'load')
    const info = await screenshot(session, currentTab(session), { name: 'clip-shot', clip: { x: 10, y: 10, width: 100, height: 50 } })
    check('clip 截图落盘', existsSync(info.file), info.file)
    const size = existsSync(info.file) ? pngSize(info.file) : { width: 0, height: 0 }
    check('clip 截图尺寸为 100x50', size.width === 100 && size.height === 50, JSON.stringify(size))
    check('meta 尺寸与文件一致', info.meta.width === 100 && info.meta.height === 50, JSON.stringify(info.meta))
    check('首行为 summary', info.summary.includes('截图') && info.summary.includes('100x50'), info.summary)

    // 数值倍率 1 / 2 / 3：输出尺寸应是 clip 基准尺寸的整数倍。
    for (const factor of [1, 2, 3]) {
      const scaled = await screenshot(session, currentTab(session), { name: `scale-${factor}`, clip: { x: 10, y: 10, width: 100, height: 50 }, scale: factor })
      const scaledSize = existsSync(scaled.file) ? pngSize(scaled.file) : { width: 0, height: 0 }
      const expectedWidth = 100 * factor
      const expectedHeight = 50 * factor
      check(`scale ${factor} 输出 ${expectedWidth}x${expectedHeight}`, scaledSize.width === expectedWidth
        && scaledSize.height === expectedHeight && scaled.meta.width === expectedWidth
        && scaled.meta.height === expectedHeight && scaled.meta.scale === factor,
      `${JSON.stringify(scaledSize)} meta=${JSON.stringify(scaled.meta)}`)
    }
    const badScale = await expectThrow(() => screenshot(session, currentTab(session), { scale: 4 }))
    check('非法 scale 数字报错', Boolean(badScale) && badScale.includes('scale'), String(badScale))
    const badScaleText = await expectThrow(() => screenshot(session, currentTab(session), { scale: 'zoom' }))
    check('非法 scale 字符串报错', Boolean(badScaleText) && badScaleText.includes('scale'), String(badScaleText))

    const jpegInfo = await screenshot(session, currentTab(session), { name: 'jpeg-shot', format: 'jpeg', quality: 80 })
    check('jpeg 截图落盘且扩展名正确', existsSync(jpegInfo.file) && jpegInfo.file.endsWith('.jpeg'), jpegInfo.file)
    check('jpeg 尺寸为视口 800x600', jpegInfo.meta.width === 800 && jpegInfo.meta.height === 600, JSON.stringify(jpegInfo.meta))

    const outOfViewport = await expectThrow(() => screenshot(session, currentTab(session), { clip: { x: 700, y: 10, width: 200, height: 50 } }))
    check('clip 越出视口报错且带数字', Boolean(outOfViewport) && outOfViewport.includes('超出视口') && outOfViewport.includes('900'), String(outOfViewport))

    const badFormat = await expectThrow(() => screenshot(session, currentTab(session), { format: 'webp' }))
    check('非法 format 报错', Boolean(badFormat) && badFormat.includes('webp'), String(badFormat))

    const badQuality = await expectThrow(() => screenshot(session, currentTab(session), { quality: 50 }))
    check('png 带 quality 报错', Boolean(badQuality) && badQuality.includes('quality'), String(badQuality))

    const badClip = await expectThrow(() => screenshot(session, currentTab(session), { clip: { x: 1.5, y: 0, width: 10, height: 10 } }))
    check('非整数 clip 报错', Boolean(badClip) && badClip.includes('整数'), String(badClip))

    // name 消毒：路径穿越与分隔符拒绝，合法同名两次落不同文件。
    const traversal = await expectThrow(() => screenshot(session, currentTab(session), { name: '..\\..\\outside' }))
    check('name 含路径穿越被拒', Boolean(traversal) && traversal.includes('name'), String(traversal))
    const slashName = await expectThrow(() => screenshot(session, currentTab(session), { name: 'a/b' }))
    check('name 含路径分隔符被拒', Boolean(slashName) && slashName.includes('name'), String(slashName))
    for (const badName of ['', ' ', '.', '..']) {
      const badNameMessage = await expectThrow(() => screenshot(session, currentTab(session), { name: badName }))
      check(`显式传 name ${JSON.stringify(badName)} 被拒且文案带 name`,
        Boolean(badNameMessage) && badNameMessage.includes('name'), String(badNameMessage))
    }
    const dupA = await screenshot(session, currentTab(session), { name: 'dup-name' })
    const dupB = await screenshot(session, currentTab(session), { name: 'dup-name' })
    check('同名截图不覆盖且都落盘', dupA.file !== dupB.file && existsSync(dupA.file) && existsSync(dupB.file),
      `${dupA.file} / ${dupB.file}`)

    // 不传 name 的默认名也必须带唯一后缀：旧实现用 shot-<Date.now()>，同毫秒两次会互相覆盖。
    const anonA = await screenshot(session, currentTab(session))
    const anonB = await screenshot(session, currentTab(session))
    check('无 name 的默认截图名带唯一后缀且不覆盖',
      anonA.file !== anonB.file && existsSync(anonA.file) && existsSync(anonB.file)
        && /shot-[0-9a-z]+\.png$/.test(anonA.file) && /shot-[0-9a-z]+\.png$/.test(anonB.file),
      `${anonA.file} / ${anonB.file}`)

    // 固定 Date.now 模拟「同一毫秒」：旧实现两次得到同名路径、第二次覆盖第一次，这条断言会失败。
    const realDateNow = Date.now
    Date.now = () => 1700000000000
    try {
      const sameMsA = await screenshot(session, currentTab(session))
      const sameMsB = await screenshot(session, currentTab(session))
      check('同一毫秒内两次无 name 截图不覆盖（默认名带自增序号）',
        sameMsA.file !== sameMsB.file && existsSync(sameMsA.file) && existsSync(sameMsB.file),
        `${sameMsA.file} / ${sameMsB.file}`)
    } finally {
      Date.now = realDateNow
    }

    // 滚动后：数值倍率路径必须按页面坐标截取（不能截到文档顶部），无 clip 时倍率要真实生效。
    await navigate(session, 'data:text/html,<body style="margin:0">'
      + '<div style="height:800px;background:rgb(255,0,0)"></div>'
      + '<div style="height:1600px;background:rgb(0,0,255)"></div></body>', 'load')
    await evaluate(session, 'window.scrollTo(0, 1000)')
    await sleep(100)
    const scrolledClip = { x: 0, y: 0, width: 100, height: 100 }
    const cssShot = await screenshot(session, currentTab(session), { name: 'scroll-css', clip: scrolledClip, scale: 'css' })
    const scaleOneShot = await screenshot(session, currentTab(session), { name: 'scroll-scale-1', clip: scrolledClip, scale: 1 })
    const cssPixel = decodePng(cssShot.file).pixel(50, 50)
    const scaleOnePixel = decodePng(scaleOneShot.file).pixel(50, 50)
    check('meta.scale 原样回传 css 形态', cssShot.meta.scale === 'css', JSON.stringify(cssShot.meta.scale))
    check('滚动后 clip 取到视口内容（蓝色，不是白图）', cssPixel.b > 200 && cssPixel.r < 80, JSON.stringify(cssPixel))
    check('滚动后 scale:1 与 scale:"css" 像素一致', JSON.stringify(cssPixel) === JSON.stringify(scaleOnePixel),
      `css=${JSON.stringify(cssPixel)} scale1=${JSON.stringify(scaleOnePixel)}`)

    const viewportScaled = await screenshot(session, currentTab(session), { name: 'viewport-scale-2', scale: 2 })
    const viewportSize = pngSize(viewportScaled.file)
    check('无 clip scale:2 输出 1600x1200（倍率真实生效）', viewportSize.width === 1600 && viewportSize.height === 1200
      && viewportScaled.meta.scale === 2, `${JSON.stringify(viewportSize)} meta=${JSON.stringify(viewportScaled.meta)}`)
    const tooBigPixels = await expectThrow(() => screenshot(session, currentTab(session), { scale: 3 }))
    check('无 clip scale:3 输出 2400x1800 超像素上限报错', Boolean(tooBigPixels)
      && tooBigPixels.includes('超出上限') && tooBigPixels.includes('4320000'), String(tooBigPixels))

    const fullPageShot = await screenshot(session, currentTab(session), { name: 'full-scale-1', fullPage: true, scale: 1 })
    const fullPageDecoded = decodePng(fullPageShot.file)
    check('整页 scale:1 输出 800x2400 且上下两段颜色正确', fullPageDecoded.width === 800 && fullPageDecoded.height === 2400
      && fullPageDecoded.pixel(10, 10).r > 200 && fullPageDecoded.pixel(10, 2390).b > 200,
    `${fullPageDecoded.width}x${fullPageDecoded.height} top=${JSON.stringify(fullPageDecoded.pixel(10, 10))} bottom=${JSON.stringify(fullPageDecoded.pixel(10, 2390))}`)
  }

  console.log('== 用例 8：browser_e2e_wait ==')
  {
    await navigate(session, 'data:text/html,<div id="late" style="display:none">late</div><script>setTimeout(function(){document.getElementById("late").style.display="block"},300)</script>', 'load')
    const visible = await waitFor(session, { selector: '#late', state: 'visible', timeoutMs: 5000 })
    check('wait selector 成功并返回耗时', visible.mode === 'selector' && visible.elapsedMs >= 200, JSON.stringify(visible))
    check('wait 的 summary 含 selector 与耗时', visible.summary.includes('#late') && visible.summary.includes('ms'), visible.summary)

    await evaluate(session, 'window.__later = false; setTimeout(function(){ window.__later = true }, 200)')
    const expression = await waitFor(session, { expression: 'window.__later === true', timeoutMs: 5000 })
    check('wait expression 成功', expression.mode === 'expression' && expression.elapsedMs >= 100, JSON.stringify(expression))

    const timeoutMessage = await expectThrow(() => waitFor(session, { selector: '#never-exists', timeoutMs: 600 }))
    check('wait 超时报错且带实际等待时长', Boolean(timeoutMessage) && timeoutMessage.includes('超时') && /实际等待 \d+ms/.test(timeoutMessage ?? ''), String(timeoutMessage))

    const bothMessage = await expectThrow(() => waitFor(session, { selector: '#late', expression: 'true' }))
    check('selector 与 expression 同时给时报错', Boolean(bothMessage) && bothMessage.includes('二选一'), String(bothMessage))
    const invalidSelector = await expectThrow(() => waitFor(session, { selector: 'foo(', timeoutMs: 500 }))
    check('非法 selector 抛解析错误而不是「超时」文案',
      Boolean(invalidSelector) && !invalidSelector.includes('超时'), String(invalidSelector))
  }

  console.log('== 用例 8B：evaluate 超时（默认/边界/文案/超时后可用性）==')
  {
    // 常量与工具描述必须同源：描述里的默认值与区间都从三个导出常量插值。
    const { buildToolTable } = await import('../lib/tools.js')
    const table = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
    const evaluateDefinition = table.find((definition) => definition.name === 'browser_e2e_evaluate')
    const timeoutParam = evaluateDefinition?.parameters?.properties?.timeoutMs
    check('evaluate 默认/下限/上限常量与工具描述一致',
      DEFAULT_EVALUATE_TIMEOUT_MS === 30000 && MIN_EVALUATE_TIMEOUT_MS === 1000
        && MAX_EVALUATE_TIMEOUT_MS === 120000
        && evaluateDefinition?.description.includes(`默认 ${DEFAULT_EVALUATE_TIMEOUT_MS}`)
        && evaluateDefinition.description.includes(`${MIN_EVALUATE_TIMEOUT_MS}-${MAX_EVALUATE_TIMEOUT_MS}`)
        && timeoutParam?.type === 'integer'
        && timeoutParam.description.includes(`${MIN_EVALUATE_TIMEOUT_MS}-${MAX_EVALUATE_TIMEOUT_MS}`)
        && timeoutParam.description.includes(`默认 ${DEFAULT_EVALUATE_TIMEOUT_MS}`),
      JSON.stringify({
        DEFAULT_EVALUATE_TIMEOUT_MS, MIN_EVALUATE_TIMEOUT_MS, MAX_EVALUATE_TIMEOUT_MS,
        description: evaluateDefinition?.description, timeoutParam,
      }))

    // 夹具：可读标题 + 每 50ms 自增的定时器，用于验证超时只打断当前脚本。
    const timeoutHtml = '<!doctype html><html><head><title>evaluate-timeout</title></head><body>'
      + '<h1 id="mark">超时夹具</h1>'
      + '<script>window.__ticks = 0; setInterval(function () { window.__ticks += 1 }, 50)</script>'
      + '</body></html>'
    await navigate(session, dataUrl(timeoutHtml), 'load')
    await sleep(100)

    // 正常表达式：返回结果、elapsedMs 为整数且小于本次 timeoutMs。
    const normal = await evaluate(session, '1 + 1', undefined, { timeoutMs: 2000 })
    check('evaluate 正常表达式返回结果且不触发超时',
      normal.value === 2 && Number.isInteger(normal.elapsedMs) && normal.elapsedMs < normal.timeoutMs
        && normal.timeoutMs === 2000,
      JSON.stringify(normal))

    // 死循环：到点报超时，实际耗时落在 [1000, 5000]。
    const timeoutStart = Date.now()
    const timeoutMessage = await expectThrow(() => evaluate(session, 'while (true) {}', undefined, { timeoutMs: 1000 }))
    const timeoutElapsed = Date.now() - timeoutStart
    check('evaluate 死循环在 timeoutMs 到点返回超时错误',
      Boolean(timeoutMessage) && timeoutMessage.includes('脚本执行超时')
        && timeoutMessage.includes('实际执行')
        && timeoutElapsed >= 1000 && timeoutElapsed <= 5000,
      JSON.stringify({ timeoutElapsed, timeoutMessage }))

    check('evaluate 超时文案包含已中断与页面保持打开',
      Boolean(timeoutMessage) && timeoutMessage.includes('已中断页面主线程正在执行的脚本')
        && timeoutMessage.includes('页面与标签页保持打开'),
      String(timeoutMessage))

    // 中断后页面不关闭：同一页可继续求值。
    const titleAfterTimeout = await evaluate(session, 'document.title')
    check('evaluate 超时后同一页面仍可继续求值',
      titleAfterTimeout.value === 'evaluate-timeout' && typeof titleAfterTimeout.value === 'string',
      JSON.stringify(titleAfterTimeout))

    // 定时器仍在运行：超时只打断那段死循环，不冻结页面。
    const ticksBefore = (await evaluate(session, 'window.__ticks')).value
    await sleep(300)
    const ticksAfter = (await evaluate(session, 'window.__ticks')).value
    check('evaluate 超时后页面定时器仍在运行',
      Number.isInteger(ticksBefore) && Number.isInteger(ticksAfter) && ticksAfter > ticksBefore,
      JSON.stringify({ ticksBefore, ticksAfter }))

    // 永不 resolve 的 Promise：宿主按时返回超时，外部保险计时器不得先触发。
    let guardFired = false
    const guard = setTimeout(() => { guardFired = true }, 8000)
    const promiseStart = Date.now()
    const promiseMessage = await expectThrow(() => evaluate(session, 'new Promise(function () {})', undefined, { timeoutMs: 1000 }))
    const promiseElapsed = Date.now() - promiseStart
    clearTimeout(guard)
    check('evaluate 永不 resolve 的 await 按时返回超时错误',
      Boolean(promiseMessage) && promiseMessage.includes('脚本执行超时')
        && guardFired === false && promiseElapsed < 5000,
      JSON.stringify({ promiseElapsed, guardFired, promiseMessage }))

    // 非法值统一报错，不静默 clamp：低于下限 / 高于上限 / 非整数。
    const belowMin = await expectThrow(() => evaluate(session, '1', undefined, { timeoutMs: MIN_EVALUATE_TIMEOUT_MS - 1 }))
    const aboveMax = await expectThrow(() => evaluate(session, '1', undefined, { timeoutMs: MAX_EVALUATE_TIMEOUT_MS + 1 }))
    const notInteger = await expectThrow(() => evaluate(session, '1', undefined, { timeoutMs: 1.5 }))
    check('evaluate timeoutMs 低于下限/高于上限/非整数分别报错',
      [belowMin, aboveMax, notInteger].every((message) =>
        message?.includes('timeoutMs 必须是 1000 到 120000 之间的整数')),
      JSON.stringify({ belowMin, aboveMax, notInteger }))

    // 工具层：透传 timeoutMs 且 schema 声明 integer；required 仍只有 expression。
    const registered = []
    const { apply } = await import('../lib/index.js')
    apply({
      get: () => undefined,
      tools: { register: (definition) => registered.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    const evaluateTool = registered.find((definition) => definition.name === 'browser_e2e_evaluate')
    const exec = { agent: { id: KEY } }
    const toolMessage = await expectThrow(() => evaluateTool.execute(
      { expression: 'while (true) {}', timeoutMs: MIN_EVALUATE_TIMEOUT_MS }, exec))
    check('browser_e2e_evaluate 工具透传 timeoutMs 并声明 integer 参数',
      Boolean(toolMessage) && toolMessage.includes('脚本执行超时')
        && toolMessage.includes(`上限 ${MIN_EVALUATE_TIMEOUT_MS}ms`)
        && evaluateTool.parameters.properties.timeoutMs?.type === 'integer'
        && JSON.stringify(evaluateTool.parameters.required) === JSON.stringify(['expression']),
      JSON.stringify({ toolMessage, parameters: evaluateTool.parameters }))
  }

  console.log('== 用例 9：snapshot 全 DOM 的 4000 条截断 ==')
  {
    await navigate(session, 'data:text/html,<body><script>'
      + 'for (let i = 0; i < 4100; i++) { const b = document.createElement("button"); b.id = "b" + i; b.textContent = "b" + i; '
      + 'b.onclick = function () { window.__lastClick = this.id }; document.body.appendChild(b) }'
      + '</script></body>', 'load')
    const info = await snapshot(session)
    check('truncated 为 true', info.truncated === true, JSON.stringify({ truncated: info.truncated, count: info.count }))
    check('只返回 4000 条', info.count === 4000, String(info.count))
    check('total 记录实际可见节点数', info.total === 4100, String(info.total))
    check('文本尾部有截断提示', info.text.includes('已截断') && info.text.includes('4100'), info.text.slice(-160))
    // 截断只影响返回条数，ref 表仍然可用。
    const refLine = info.text.split('\n').find((line) => line.includes('"b0"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    const clicked = await click(session, { ref })
    await sleep(100)
    const flag = await evaluate(session, 'window.__lastClick === "b0"')
    check('截断后的 ref 点击仍生效', Boolean(ref) && flag.value === true, `${JSON.stringify(clicked)} ref=${ref}`)
  }
  console.log('== 用例 10：index.js 工具注册与截图的文本 + 图片输出 ==')
  {
    const { apply } = await import('../lib/index.js')
    const definitions = []
    const saved = []
    const fakeAttachments = {
      async saveImage({ data, mediaType, name }) {
        saved.push({ mediaType, name, bytes: data.length })
        return { attachmentId: 'att-1', mediaType, bytes: data.length, width: 100, height: 50, name }
      },
    }
    const makeCtx = (attachments) => ({
      get: (name) => (name === 'attachments' ? attachments : undefined),
      tools: { register: (definition) => definitions.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    apply(makeCtx(fakeAttachments))
    const names = definitions.map((definition) => definition.name)
    // 期望从 lib/tools.js 的工具表派生：新增工具只改表，这里不用改断言。
    const { buildToolTable } = await import('../lib/tools.js')
    const table = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
    check('注册的工具与工具表逐项一致', JSON.stringify(names) === JSON.stringify(table.map((definition) => definition.name)), JSON.stringify(names))
    check('工具表共 23 个（含 read / dialog / clipboard）', table.length === 23 && names.length === 23, String(table.length))
    check('工具名唯一且统一带 browser_e2e_ 前缀', new Set(names).size === names.length
      && names.every((name) => name.startsWith('browser_e2e_')), JSON.stringify(names))
    const readTool = definitions.find((definition) => definition.name === 'browser_e2e_read')
    check('read 参数含 sections / maxItems / includeValues / selector / tab_id',
      ['sections', 'maxItems', 'includeValues', 'selector', 'tab_id']
        .every((field) => field in readTool.parameters.properties)
      && readTool.parameters.properties.sections?.type === 'array'
      && readTool.parameters.properties.sections?.items?.type === 'string'
      && readTool.parameters.properties.maxItems?.type === 'integer'
      && readTool.parameters.properties.includeValues?.type === 'boolean'
      && readTool.parameters.properties.selector?.type === 'string'
      && readTool.parameters.additionalProperties === false
      && readTool.parameters.required.length === 0,
    JSON.stringify(readTool.parameters))
    const fillTool = definitions.find((definition) => definition.name === 'browser_e2e_fill')
    check('fill 把 value 列为必填并提供四种目标参数', fillTool.parameters.required.includes('value')
      && ['ref', 'selector', 'x', 'y', 'tab_id'].every((field) => field in fillTool.parameters.properties),
    JSON.stringify(fillTool.parameters))
    check('fill 参数含 mode 枚举与 delayMs', JSON.stringify(fillTool.parameters.properties.mode?.enum) === JSON.stringify(['insert', 'keystrokes'])
      && 'delayMs' in fillTool.parameters.properties && fillTool.parameters.properties.delayMs?.type === 'integer'
      && fillTool.parameters.required.includes('value'),
    JSON.stringify({ mode: fillTool.parameters.properties.mode, delayMs: fillTool.parameters.properties.delayMs, required: fillTool.parameters.required }))
    const scrollTool = definitions.find((definition) => definition.name === 'browser_e2e_scroll')
    check('scroll 参数含 delta_x / delta_y / x / y / tab_id', ['delta_x', 'delta_y', 'x', 'y', 'tab_id'].every((field) => field in scrollTool.parameters.properties),
      JSON.stringify(Object.keys(scrollTool.parameters.properties)))

    const clickTool = definitions.find((definition) => definition.name === 'browser_e2e_click')
    check('click 参数含 clickCount / button / modifiers',
      ['clickCount', 'button', 'modifiers'].every((field) => field in clickTool.parameters.properties)
        && clickTool.parameters.properties.clickCount?.type === 'integer'
        && JSON.stringify(clickTool.parameters.properties.button?.enum) === JSON.stringify(['left', 'right', 'middle'])
        && clickTool.parameters.properties.modifiers?.type === 'array'
        && JSON.stringify(clickTool.parameters.properties.modifiers?.items?.enum) === JSON.stringify(['Alt', 'Control', 'Meta', 'Shift'])
        && clickTool.parameters.additionalProperties === false,
      JSON.stringify(clickTool.parameters.properties))
    const pressTool = definitions.find((definition) => definition.name === 'browser_e2e_press')
    check('press 参数含 action / repeat',
      JSON.stringify(pressTool.parameters.properties.action?.enum) === JSON.stringify(['press', 'down', 'up'])
        && pressTool.parameters.properties.repeat?.type === 'integer'
        && JSON.stringify(pressTool.parameters.required) === JSON.stringify(['key'])
        && pressTool.parameters.additionalProperties === false,
      JSON.stringify(pressTool.parameters))

    const clipboardTool = definitions.find((definition) => definition.name === 'browser_e2e_clipboard')
    check('clipboard 把 action 列为唯一必填参数且声明 write / paste 枚举',
      JSON.stringify(clipboardTool.parameters.required) === JSON.stringify(['action'])
        && JSON.stringify(clipboardTool.parameters.properties.action?.enum) === JSON.stringify(['write', 'paste'])
        && clipboardTool.parameters.additionalProperties === false,
      JSON.stringify(clipboardTool.parameters))
    check('clipboard 参数含 text / html / sanitize / ref / selector / tab_id',
      ['text', 'html', 'sanitize', 'ref', 'selector', 'tab_id'].every((field) => field in clipboardTool.parameters.properties)
        && clipboardTool.parameters.properties.text?.type === 'string'
        && clipboardTool.parameters.properties.html?.type === 'string'
        && clipboardTool.parameters.properties.sanitize?.type === 'boolean'
        && clipboardTool.parameters.properties.ref?.type === 'string'
        && clipboardTool.parameters.properties.selector?.type === 'string',
      JSON.stringify(Object.keys(clipboardTool.parameters.properties)))
    check('clipboard 描述里的载荷上限取自 page.js 常量',
      clipboardTool.description.includes(String(CLIPBOARD_TEXT_LIMIT))
        && clipboardTool.description.includes(String(CLIPBOARD_HTML_LIMIT))
        && CLIPBOARD_TEXT_LIMIT === 100000 && CLIPBOARD_HTML_LIMIT === 200000,
      JSON.stringify({ CLIPBOARD_TEXT_LIMIT, CLIPBOARD_HTML_LIMIT, description: clipboardTool.description }))

    const downloadTool = definitions.find((definition) => definition.name === 'browser_e2e_download')
    check('download 参数含两种来源与完整性字段', ['url', 'ref', 'selector', 'x', 'y', 'filename',
      'maxBytes', 'expectedSha256', 'timeoutMs', 'tab_id'].every((field) => field in downloadTool.parameters.properties)
      && downloadTool.parameters.additionalProperties === false,
    JSON.stringify(Object.keys(downloadTool.parameters.properties)))

    const screenshotTool = definitions.find((definition) => definition.name === 'browser_e2e_screenshot')
    const exec = { agent: { id: KEY } }
    const value = await screenshotTool.execute({ clip: { x: 10, y: 10, width: 100, height: 50 } }, exec)
    check('截图工具返回 { file, meta }', typeof value.file === 'string' && value.meta.width === 100, JSON.stringify({ file: value.file, meta: value.meta }))
    const content = screenshotTool.output.render({}, value)
    check('附件服务可用时 render 返回文本 + image 块', content.length === 2 && content[1].type === 'image' && content[1].attachment.attachmentId === 'att-1', JSON.stringify(content))
    check('图片实际存入附件服务', saved.length === 1 && saved[0].bytes > 0, JSON.stringify(saved))

    // close_tab 工具：新开一页再按 tab_id 关闭，active tab 提示跟随剩余页。
    const closeTabTool = definitions.find((definition) => definition.name === 'browser_e2e_close_tab')
    const extraTab = await navigate(session, 'data:text/html,<h1>close-me</h1>', 'load', { new_tab: true })
    check('close_tab 前置：新开第二个页', session.pages.size === 2, String(session.pages.size))
    const closeTabResult = await closeTabTool.execute({ tab_id: extraTab.tabId }, exec)
    check('browser_e2e_close_tab 关闭指定页并提示下一个 active', session.pages.size === 1
      && !session.pages.has(extraTab.tabId) && typeof closeTabResult === 'string'
      && closeTabResult.includes('关闭标签页') && closeTabResult.includes(extraTab.tabId), String(closeTabResult))

    // 附件服务不可用时只返回文本路径。
    const noAttachmentDefs = []
    apply({
      get: () => undefined,
      tools: { register: (definition) => noAttachmentDefs.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    const noAttachmentTool = noAttachmentDefs.find((definition) => definition.name === 'browser_e2e_screenshot')
    const textValue = await noAttachmentTool.execute({ name: 'no-attachment' }, exec)
    const textContent = noAttachmentTool.output.render({}, textValue)
    check('附件服务不可用时只返回文本', textContent.length === 1 && textContent[0].type === 'text' && textContent[0].text.includes(textValue.file), JSON.stringify(textContent))
  }
} finally {
  await closeAll()
  // SSE / 慢响应夹具会留下未结束的连接，先强制断开再关服务，避免 close 回调挂住。
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const playwrightSettled = await waitUntil(() => playwrightEdgeRootCount() <= playwrightBaseline)
const remaining = edgeRootCount()
const remainingPlaywright = playwrightEdgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
check('本测试未遗留 Playwright Edge 主进程', playwrightSettled && remainingPlaywright <= playwrightBaseline, `playwright 基线=${playwrightBaseline} 残留=${remainingPlaywright}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）；Playwright 主进程 ${remainingPlaywright} 个（基线 ${playwrightBaseline} 个）`)
process.exit(fail === 0 ? 0 : 1)
