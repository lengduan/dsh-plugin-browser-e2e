/**
 * 环境诊断（doctor）验证：覆盖 specs/功能规格/0030-doctor.md「验收」第 1 条的全部用例。
 *
 * 全部本地、不启动浏览器：CDP 夹具用 node:http / node:net 在 127.0.0.1 的 listen(0)
 * 临时端口上提供，端口不写死；每个夹具用例结束关闭服务。边界分支优先走
 * diagnose(options, deps) 的注入点（edgeCandidates / artifactsRoot / platform）。
 *
 * 运行：node tests/doctor.mjs
 * 结束时 closeAll() 清空会话注册表（本文件造的会话都手动 close）。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
// 关闭兜底 / 代理 / 下载目录一律清空，环境诊断的 env / paths 用例才有确定的基线。
process.env.DSH_BROWSER_IDLE_MS = '600000'
delete process.env.DSH_BROWSER_CLOSE_TIMEOUT_MS
delete process.env.DSH_BROWSER_PROXY
delete process.env.DSH_BROWSER_DOWNLOAD_DIR

const {
  CLOSE_TIMEOUT_MS, IDLE_CLOSE_MS, activeSessionKeys, close, closeAll, normalizeCdpEndpoint, peekSession, sessionOf,
} = await import('../lib/session.js')
const {
  DOCTOR_CHECKS, DOCTOR_PROBE_TIMEOUT_DEFAULT_MS, DOCTOR_PROBE_TIMEOUT_MAX_MS, DOCTOR_PROBE_TIMEOUT_MIN_MS, diagnose,
} = await import('../lib/doctor.js')
const { buildToolTable, summaryOf } = await import('../lib/tools.js')
const { DEFAULT_CDP_ENDPOINT } = await import('../lib/defaults.js')

const require = createRequire(import.meta.url)
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const PLAYWRIGHT_VERSION = require('playwright-core/package.json').version

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

/** 报告里的一项检查行：[<STATUS>] <id>：<detail>（中文冒号）。 */
const STATUS_LINE = /^\[(OK|WARN|FAIL|SKIP)\] ([a-z]+)：(.+)$/

/** 把报告拆成首行 / 检查项 / 末行，供各处断言复用。 */
function parseReport(text) {
  const lines = text.split('\n')
  const items = []
  lines.forEach((line, index) => {
    const match = STATUS_LINE.exec(line)
    if (match) items.push({ status: match[1], id: match[2], detail: match[3], index })
  })
  return { lines, items, first: lines[0], last: lines[lines.length - 1] }
}

/** 取唯一一项检查（缺项或重复都算失败）。 */
function itemOf(report, id) {
  const found = report.items.filter((item) => item.id === id)
  return found.length === 1 ? found[0] : null
}

/** 临时产物根目录：让 paths 项的判定落在测试自己的目录里，不碰用户真实产物目录。 */
const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))

/** 诊断注入点基线：win32 + 命中的 Edge 路径 + 已存在的临时产物根目录。 */
function doctorDeps(overrides = {}) {
  return {
    platform: 'win32',
    edgeCandidates: () => [process.execPath],
    artifactsRoot: () => tmpRoot,
    ...overrides,
  }
}

/** 跑一次诊断；缺省 key 不落在注册表里（session 项按未启动报）。 */
function run(options = {}, deps = doctorDeps()) {
  return diagnose({ key: 'doctor-report-key', ...options }, deps)
}

/** 临时修改 process.env，结束后逐键恢复（含「原本未设置」）。 */
async function withEnv(changes, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(changes)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 起一个 127.0.0.1 随机端口的 HTTP 夹具，stop() 关服务并断开残留连接。 */
async function startHttpFixture(handler) {
  const sockets = new Set()
  const server = createHttpServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 起一个只收连接、从不回包的 TCP 夹具，用于制造请求超时。 */
async function startSilentTcpFixture() {
  const sockets = new Set()
  const server = createTcpServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 取一个已经关闭、可以稳定拒绝连接的临时端口，用于「连不上」用例。 */
async function closedPort() {
  const server = createTcpServer(() => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 读一次归一化失败时的启动路径原文，供「复用原文」断言。 */
function normalizeError(endpoint) {
  try {
    normalizeCdpEndpoint(endpoint)
    return null
  } catch (error) {
    return error.message
  }
}

const unreachableEndpoint = `http://127.0.0.1:${await closedPort()}`

console.log('== 用例 A：报告骨架 ==')
{
  const report = parseReport(await run())
  check(
    'doctor 报告首行是统计行',
    report.first === `环境诊断：共 6 项，5 通过 / 0 警告 / 0 失败 / 1 跳过（模式 isolated，端点 ${DEFAULT_CDP_ENDPOINT}）`,
    report.first,
  )

  const ids = report.items.map((item) => item.id)
  check(
    'doctor 报告固定六项且每项一行',
    JSON.stringify(ids) === JSON.stringify(DOCTOR_CHECKS)
      && new Set(ids).size === DOCTOR_CHECKS.length
      && report.items.every((item) => item.detail.length > 0),
    JSON.stringify(ids),
  )

  // 同时制造 FAIL（edge）与 WARN（env 代理），覆盖 SKIP 也带修法的固定写法。
  const messy = parseReport(await withEnv({ DSH_BROWSER_PROXY: '127.0.0.1:7897' }, () => run({}, doctorDeps({
    edgeCandidates: () => [join(tmpRoot, 'no-edge-a', 'msedge.exe'), join(tmpRoot, 'no-edge-b', 'msedge.exe')],
  }))))
  const nonOk = messy.items.filter((item) => item.status !== 'OK')
  const nonOkFix = nonOk.every((item) => {
    const next = messy.lines[item.index + 1] ?? ''
    return next.startsWith('   修复：') && next.slice('   修复：'.length).trim().length > 0
  })
  const okNoFix = messy.items.filter((item) => item.status === 'OK')
    .every((item) => !(messy.lines[item.index + 1] ?? '').startsWith('   修复：'))
  check(
    'doctor 非 OK 项各带一行修复',
    nonOk.length >= 3 && nonOkFix && okNoFix,
    JSON.stringify({ statuses: messy.items.map((item) => `${item.id}:${item.status}`), nonOkFix, okNoFix }),
  )

  const failReport = parseReport(await run({ mode: 'cdp', cdpEndpoint: unreachableEndpoint }))
  const warnReport = parseReport(await withEnv({ DSH_BROWSER_PROXY: '127.0.0.1:7897' }, () => run()))
  const okReport = parseReport(await run())
  check(
    'doctor 结论行按最严重项',
    failReport.last === '结论：先修 [FAIL] 项再 browser_e2e_start（本工具不启动浏览器、不改任何状态）。'
      && warnReport.last === '结论：无阻塞项；[WARN] 项可能导致后续调用异常（本工具不启动浏览器、不改任何状态）。'
      && okReport.last === '结论：环境就绪，可以直接 browser_e2e_start（本工具不启动浏览器、不改任何状态）。',
    JSON.stringify({ fail: failReport.last, warn: warnReport.last, ok: okReport.last }),
  )
}

console.log('== 用例 B：runtime / edge ==')
{
  const runtime = itemOf(parseReport(await run()), 'runtime')
  check(
    'doctor runtime 报告 Node 与插件与 playwright-core 版本',
    runtime?.status === 'OK'
      && runtime.detail === `Node ${process.version}（${process.platform} ${process.arch}）；插件 ${PACKAGE_VERSION}；playwright-core ${PLAYWRIGHT_VERSION}`,
    JSON.stringify(runtime),
  )

  const hit = itemOf(parseReport(await run({}, doctorDeps({
    edgeCandidates: () => [join(tmpRoot, 'missing-edge', 'msedge.exe'), process.execPath],
  }))), 'edge')
  check(
    'doctor edge 按 Playwright 的 msedge 候选前缀命中注入路径',
    hit?.status === 'OK' && hit.detail === process.execPath,
    JSON.stringify(hit),
  )

  const firstMissing = join(tmpRoot, 'no-edge', 'msedge.exe')
  const missing = itemOf(parseReport(await run({}, doctorDeps({
    edgeCandidates: () => [firstMissing, join(tmpRoot, 'no-edge2', 'msedge.exe')],
  }))), 'edge')
  check(
    'doctor edge 全部候选不存在时失败并给出首个查找位置',
    missing?.status === 'FAIL'
      && missing.detail.includes('未找到系统 Edge')
      && missing.detail.includes(`首个查找位置：${firstMissing}`),
    JSON.stringify(missing),
  )

  const skipped = itemOf(parseReport(await run({}, doctorDeps({ platform: 'freebsd' }))), 'edge')
  check(
    'doctor edge 非支持平台时跳过',
    skipped?.status === 'SKIP'
      && skipped.detail.includes('当前平台 freebsd 不在 win32 / darwin / linux')
      && skipped.detail.includes('跳过'),
    JSON.stringify(skipped),
  )
}

console.log('== 用例 C：cdp ==')
{
  const isolated = itemOf(parseReport(await run({ mode: 'isolated' })), 'cdp')
  check(
    'doctor cdp 在 isolated 模式跳过并提示传 mode=cdp',
    isolated?.status === 'SKIP' && isolated.detail.includes('mode=cdp'),
    JSON.stringify(isolated),
  )

  const good = await startHttpFixture((req, res) => {
    if (req.url !== '/json/version') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      Browser: 'Edg/140.0.3485.54',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/doctor-fixture',
    }))
  })
  try {
    const item = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: good.endpoint })), 'cdp')
    check(
      'doctor cdp 端点可达且 /json/version 合法时通过',
      item?.status === 'OK' && item.detail.includes('可接管') && item.detail.includes('Edg/140.0.3485.54'),
      JSON.stringify(item),
    )
  } finally {
    await good.stop()
  }

  // 两种「端口通但不是 CDP」：非 JSON、以及 JSON 缺 webSocketDebuggerUrl。
  const notJson = await startHttpFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello, this is not a cdp endpoint')
  })
  const missingWs = await startHttpFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ Browser: 'nope' }))
  })
  try {
    const first = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: notJson.endpoint })), 'cdp')
    const second = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: missingWs.endpoint })), 'cdp')
    check(
      'doctor cdp 端口可通但不是 CDP 时警告',
      first?.status === 'WARN' && first.detail.includes('不像 CDP 端点') && first.detail.includes('不是 JSON')
        && second?.status === 'WARN' && second.detail.includes('缺少 webSocketDebuggerUrl'),
      JSON.stringify({ first, second }),
    )
  } finally {
    await notJson.stop()
    await missingWs.stop()
  }

  const refused = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: unreachableEndpoint })), 'cdp')
  check(
    'doctor cdp 端口连不上时失败',
    refused?.status === 'FAIL'
      && refused.detail.includes(unreachableEndpoint)
      && refused.detail.includes('连不上'),
    JSON.stringify(refused),
  )

  const silent = await startSilentTcpFixture()
  try {
    const started = Date.now()
    const item = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: silent.endpoint, probeTimeoutMs: 200 })), 'cdp')
    const elapsed = Date.now() - started
    // 只判上界：单次探测耗时不应明显超出 probeTimeoutMs。
    check(
      'doctor cdp 请求超时在 probeTimeoutMs 内返回',
      item?.status === 'FAIL' && item.detail.includes('请求超时') && elapsed < 3000,
      JSON.stringify({ item, elapsed }),
    )
  } finally {
    await silent.stop()
  }

  const loopbackError = normalizeError('http://example.com:9222')
  const nonLoopback = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: 'http://example.com:9222' })), 'cdp')
  check(
    'doctor cdp 非 loopback 端点失败并复用启动错误原文',
    loopbackError !== null && nonLoopback?.status === 'FAIL' && nonLoopback.detail === loopbackError,
    JSON.stringify({ loopbackError, nonLoopback }),
  )

  const protocolError = normalizeError('https://127.0.0.1:9222')
  const nonHttp = itemOf(parseReport(await run({ mode: 'cdp', cdpEndpoint: 'https://127.0.0.1:9222' })), 'cdp')
  check(
    'doctor cdp 非 http 端点失败',
    protocolError !== null && nonHttp?.status === 'FAIL' && nonHttp.detail === protocolError,
    JSON.stringify({ protocolError, nonHttp }),
  )
}

console.log('== 用例 D：session ==')
{
  // 未启动：注册表里没有该 key，诊断不能顺手创建会话。
  const idleKey = 'doctor-session-idle'
  const idleReport = parseReport(await run({ key: idleKey }))
  check(
    'doctor session 未启动时报未启动',
    itemOf(idleReport, 'session')?.status === 'OK'
      && itemOf(idleReport, 'session').detail === '本会话未启动浏览器（工具调用时按需启动）'
      && !activeSessionKeys().includes(idleKey)
      && peekSession(idleKey) === null,
    JSON.stringify({ item: itemOf(idleReport, 'session'), keys: activeSessionKeys() }),
  )

  // 已启动：手动构造只读快照需要的字段（不启动浏览器）。
  const readyKey = 'doctor-session-ready'
  const ready = sessionOf(readyKey, undefined, { deferTouch: true })
  ready.state = 'ready'
  ready.mode = 'isolated'
  ready.browser = { isConnected: () => true, close: async () => {} }
  ready.pages.set('t1', { id: 't1' })
  ready.pages.set('t2', { id: 't2' })
  ready.activeTabId = 't1'
  try {
    const item = itemOf(parseReport(await run({ key: readyKey })), 'session')
    check(
      'doctor session 已启动时报模式与标签页数',
      item?.status === 'OK' && item.detail === 'isolated 模式运行中，2 个标签页，连接正常',
      JSON.stringify(item),
    )
  } finally {
    await close(readyKey)
  }

  const brokenKey = 'doctor-session-broken'
  const broken = sessionOf(brokenKey, undefined, { deferTouch: true })
  broken.state = 'ready'
  broken.mode = 'cdp'
  broken.browser = { isConnected: () => false, close: async () => {} }
  broken.pages.set('t1', { id: 't1' })
  broken.activeTabId = 't1'
  try {
    const item = itemOf(parseReport(await run({ key: brokenKey })), 'session')
    check(
      'doctor session 连接失效时报失败',
      item?.status === 'FAIL' && item.detail.includes('CDP 连接已失效') && item.detail.includes('browser.isConnected() 为 false'),
      JSON.stringify(item),
    )
  } finally {
    await close(brokenKey)
  }

  const launchingKey = 'doctor-session-launching'
  const launching = sessionOf(launchingKey, undefined, { deferTouch: true })
  launching.state = 'launching'
  try {
    const item = itemOf(parseReport(await run({ key: launchingKey })), 'session')
    check(
      'doctor session 处于 launching 时报警告',
      item?.status === 'WARN' && item.detail.includes('会话正在 launching'),
      JSON.stringify(item),
    )
  } finally {
    await close(launchingKey)
  }

  // 零副作用：既不创建会话，也不刷新 / 清掉既有会话的空闲计时器。
  const freshKey = 'doctor-session-not-created'
  const keysBefore = activeSessionKeys().length
  await run({ key: freshKey })
  const createdNone = activeSessionKeys().length === keysBefore && peekSession(freshKey) === null

  const timedKey = 'doctor-session-idle-timer'
  const timed = sessionOf(timedKey)
  const timerBefore = timed.idleTimer
  let timerKept = false
  let stateKept = false
  try {
    await run({ key: timedKey })
    timerKept = timed.idleTimer === timerBefore && timerBefore !== null
    stateKept = timed.state === 'idle' && peekSession(timedKey)?.state === 'idle'
  } finally {
    await close(timedKey)
  }
  check(
    'doctor 不创建会话也不刷新空闲计时',
    createdNone && timerKept && stateKept,
    JSON.stringify({ createdNone, timerKept, stateKept }),
  )
}

console.log('== 用例 E：paths ==')
{
  const existing = itemOf(parseReport(await run()), 'paths')
  check(
    'doctor paths 报告产物根目录与下载目录',
    existing?.status === 'OK'
      && existing.detail.includes(`产物根目录 ${tmpRoot} 可写`)
      && existing.detail.includes(`下载目录 默认（${tmpRoot}${sep}downloads${sep}，启动后派生）`)
      && !existsSync(join(tmpRoot, '.doctor-probe')),
    JSON.stringify(existing),
  )

  const missingRoot = join(tmpRoot, 'nested', 'artifacts')
  const ancestor = itemOf(parseReport(await run({}, doctorDeps({ artifactsRoot: () => missingRoot }))), 'paths')
  check(
    'doctor paths 根目录不存在时沿祖先链判定',
    ancestor?.status === 'OK'
      && ancestor.detail.includes(`产物根目录 ${missingRoot} 尚未创建；父目录 ${tmpRoot} 可写（首次启动时创建）`),
    JSON.stringify(ancestor),
  )

  const relative = itemOf(parseReport(await withEnv(
    { DSH_BROWSER_DOWNLOAD_DIR: 'relative/downloads' },
    () => run(),
  )), 'paths')
  check(
    'doctor paths 下载目录非绝对路径时失败',
    relative?.status === 'FAIL'
      && relative.detail.includes('DSH_BROWSER_DOWNLOAD_DIR 不是绝对路径')
      && relative.detail.includes('"relative/downloads"'),
    JSON.stringify(relative),
  )
}

console.log('== 用例 F：env ==')
{
  const defaults = itemOf(parseReport(await withEnv({ DSH_BROWSER_IDLE_MS: undefined }, () => run())), 'env')
  check(
    'doctor env 默认值正常',
    defaults?.status === 'OK'
      && defaults.detail === `空闲回收 ${IDLE_CLOSE_MS}ms（默认）；关闭兜底 ${CLOSE_TIMEOUT_MS}ms（默认）；代理 未设置`
      && IDLE_CLOSE_MS === 600000 && CLOSE_TIMEOUT_MS === 5000,
    JSON.stringify({ item: defaults, IDLE_CLOSE_MS, CLOSE_TIMEOUT_MS }),
  )

  const badIdle = itemOf(parseReport(await withEnv(
    { DSH_BROWSER_IDLE_MS: 'abc' },
    () => run(),
  )), 'env')
  check(
    'doctor env 空闲回收非法时失败',
    badIdle?.status === 'FAIL'
      && badIdle.detail.includes('DSH_BROWSER_IDLE_MS 不是非负整数')
      && badIdle.detail.includes('"abc"'),
    JSON.stringify(badIdle),
  )

  const badClose = itemOf(parseReport(await withEnv(
    { DSH_BROWSER_CLOSE_TIMEOUT_MS: '0' },
    () => run(),
  )), 'env')
  check(
    'doctor env 关闭兜底非法时警告',
    badClose?.status === 'WARN'
      && badClose.detail.includes('DSH_BROWSER_CLOSE_TIMEOUT_MS 不是正整数')
      && badClose.detail.includes('"0"'),
    JSON.stringify(badClose),
  )

  const badProxy = itemOf(parseReport(await withEnv(
    { DSH_BROWSER_PROXY: '127.0.0.1:7897' },
    () => run(),
  )), 'env')
  check(
    'doctor env 代理缺协议时警告',
    badProxy?.status === 'WARN'
      && badProxy.detail.includes('代理 非法')
      && badProxy.detail.includes('"127.0.0.1:7897"'),
    JSON.stringify(badProxy),
  )

  const goodProxy = itemOf(parseReport(await withEnv(
    { DSH_BROWSER_PROXY: 'http://127.0.0.1:7897' },
    () => run(),
  )), 'env')
  check(
    'doctor env 代理合法时不报警',
    goodProxy?.status === 'OK' && goodProxy.detail.includes('代理 http://127.0.0.1:7897'),
    JSON.stringify(goodProxy),
  )
}

console.log('== 用例 G：入参与工具表 ==')
{
  const table = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
  const definitions = table.filter((definition) => definition.name === 'browser_e2e_doctor')
  const definition = definitions[0]
  const parameters = definition?.parameters
  check(
    'doctor 工具定义在工具表里且参数 schema 正确',
    definitions.length === 1
      && JSON.stringify(table.map((item) => item.name)).includes('"browser_e2e_doctor"')
      && typeof definition.description === 'string' && definition.description.includes('诊断')
      && typeof definition.run === 'function'
      && typeof definition.output?.render === 'function'
      && parameters?.type === 'object' && parameters.additionalProperties === false
      && JSON.stringify(parameters.required) === '[]'
      && parameters.properties.mode?.type === 'string'
      && JSON.stringify(parameters.properties.mode?.enum) === JSON.stringify(['isolated', 'cdp'])
      && parameters.properties.cdpEndpoint?.type === 'string'
      && parameters.properties.probeTimeoutMs?.type === 'integer',
    JSON.stringify({ parameters, description: definition?.description }),
  )

  const toolError = await definition.run({ mode: 'cdpp' }, { agent: { id: 'doctor-bad-mode' } })
    .then(() => null, (error) => error)
  const directError = await diagnose({ mode: 'cdpp' }, doctorDeps()).then(() => null, (error) => error)
  check(
    'doctor 非法 mode 报错',
    directError?.message === 'mode 只支持 isolated / cdp，收到 "cdpp"' && toolError?.message === directError.message,
    JSON.stringify({ directError: directError?.message, toolError: toolError?.message }),
  )

  const outOfRange = []
  for (const value of [DOCTOR_PROBE_TIMEOUT_MIN_MS - 1, DOCTOR_PROBE_TIMEOUT_MAX_MS + 1, 100.5]) {
    const error = await diagnose({ mode: 'isolated', probeTimeoutMs: value }, doctorDeps())
      .then(() => null, (thrown) => thrown)
    outOfRange.push(error?.message ?? null)
  }
  check(
    'doctor probeTimeoutMs 越界报错',
    DOCTOR_PROBE_TIMEOUT_DEFAULT_MS === 1500
      && DOCTOR_PROBE_TIMEOUT_MIN_MS === 100
      && DOCTOR_PROBE_TIMEOUT_MAX_MS === 10000
      && outOfRange[0] === `probeTimeoutMs 必须是 ${DOCTOR_PROBE_TIMEOUT_MIN_MS}..${DOCTOR_PROBE_TIMEOUT_MAX_MS} 的整数，收到 99`
      && outOfRange[1] === `probeTimeoutMs 必须是 ${DOCTOR_PROBE_TIMEOUT_MIN_MS}..${DOCTOR_PROBE_TIMEOUT_MAX_MS} 的整数，收到 10001`
      && outOfRange[2] === `probeTimeoutMs 必须是 ${DOCTOR_PROBE_TIMEOUT_MIN_MS}..${DOCTOR_PROBE_TIMEOUT_MAX_MS} 的整数，收到 100.5`,
    JSON.stringify(outOfRange),
  )

  const output = await definition.run({ mode: 'isolated' }, { agent: { id: 'doctor-summary-key' } })
  const report = parseReport(output)
  check(
    'doctor 汇总摘要被 summaryOf 采用',
    typeof output === 'string'
      && summaryOf(output) === report.first
      && summaryOf(output).startsWith('环境诊断：共 6 项，')
      && summaryOf(output).includes('模式 isolated'),
    JSON.stringify({ summary: summaryOf(output) }),
  )
}

// 清空会话注册表；本文件造的会话都已 close，这里只兜底。诊断类计时器不拖住进程退出。
await closeAll()
rmSync(tmpRoot, { recursive: true, force: true })

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
