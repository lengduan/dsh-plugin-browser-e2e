/**
 * 右侧实时浏览器面板的宿主半区验证。
 *
 * 分四段：
 *   A. loopback 围栏的判定（纯函数）；
 *   B. 设置合并与越界拒绝（纯函数）；
 *   C. 插件注册面：12 个工具的参数契约没变；
 *   D. 端到端：用真实 http 服务模拟宿主 webServer，注册插件自己的路由与 socket，
 *      真起无头 Edge，走完整协议（attach / hello / 帧 / 动作 / configure /
 *      request-frame / 未知命令 / 协议版本不符 / 关闭后状态清空），并校验围栏
 *      对非 loopback Host 返回 403。
 *
 * 运行：node tests/panel.mjs
 */
import { createServer, request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'

// 测试期间不让空闲回收介入（browser.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { mergeConfig, PANEL_STATE_PATH, PANEL_SOCKET_PATH, PANEL_PROTOCOL_VERSION } =
  await import('../lib/panel.js')
const { isLoopbackRequest, isLoopbackAddress, isLoopbackHostname } = await import('../lib/fence.js')
const { activeSessionKeys, closeAll } = await import('../lib/browser.js')
const { apply } = await import('../lib/index.js')

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待条件成立。 */
async function waitFor(fn, timeoutMs = 8000, stepMs = 50) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(stepMs)
  }
}

/** 造一个假的请求对象（只带围栏会读的字段）。 */
function fakeRequest(remoteAddress, headers) {
  return { socket: { remoteAddress }, headers }
}

console.log('== 用例 A：loopback 围栏 ==')
{
  check('127.0.0.1 是 loopback', isLoopbackAddress('127.0.0.1'))
  check('::1 是 loopback', isLoopbackAddress('::1'))
  check('::ffff:127.0.0.1 是 loopback', isLoopbackAddress('::ffff:127.0.0.1'))
  check('192.168.1.5 不是 loopback', !isLoopbackAddress('192.168.1.5'))
  check('localhost 主机名是 loopback', isLoopbackHostname('localhost'))
  check('example.com 主机名不是 loopback', !isLoopbackHostname('example.com'))
  check('loopback socket + loopback Host 通过', isLoopbackRequest(fakeRequest('127.0.0.1', { host: '127.0.0.1:65301' })))
  check('非 loopback socket 拒绝', !isLoopbackRequest(fakeRequest('192.168.1.5', { host: '127.0.0.1:65301' })))
  check('非 loopback Host 拒绝', !isLoopbackRequest(fakeRequest('127.0.0.1', { host: 'evil.example:443' })))
  check('cross-site 拒绝', !isLoopbackRequest(fakeRequest('127.0.0.1', { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' })))
  check('同源 Origin 通过', isLoopbackRequest(fakeRequest('127.0.0.1', { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })))
  check('异源 Origin 拒绝', !isLoopbackRequest(fakeRequest('127.0.0.1', { host: '127.0.0.1:1', origin: 'http://127.0.0.1:2' })))
}

console.log('== 用例 B：设置合并 ==')
{
  const base = { quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }
  check('部分字段合并', JSON.stringify(mergeConfig({ quality: 50 }, base)) === JSON.stringify({ ...base, quality: 50 }))
  check('空 patch 不动原值', JSON.stringify(mergeConfig({}, base)) === JSON.stringify(base))
  let error = null
  try { mergeConfig({ quality: 5 }, base) } catch (e) { error = e.message }
  check('quality 越界报错', typeof error === 'string' && error.includes('quality'), String(error))
  error = null
  try { mergeConfig({ maxWidth: 12.5 }, base) } catch (e) { error = e.message }
  check('非整数报错', typeof error === 'string' && error.includes('maxWidth'), String(error))
  error = null
  try { mergeConfig(null, base) } catch (e) { error = e.message }
  check('config 非对象报错', typeof error === 'string', String(error))
}

console.log('== 用例 C：插件注册面（12 个工具的参数未变）==')
const KEY = 'panel-test-key'
// 生产环境里 agent.id 就是 SessionId，两者同源；这里保持同一取值。
const SID = KEY
// 面板 tab id 是「会话 key#页面 tab_id」的组合 id。
const PANEL_TAB = `${KEY}#t1`
const toolNames = []
const tools = new Map()
const routes = new Map()
let upgradeHandler = null
{
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    registerUpgrade(upgrade) {
      upgradeHandler = upgrade.handler
      return () => { upgradeHandler = null }
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        toolNames.push(definition.name)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    on: () => () => {},
    effect(fn) {
      fn()
      return () => {}
    },
    inject(_deps, callback) {
      callback({
        webServer,
        effect: (fn) => { fn(); return () => {} },
        get: (name) => (name === 'webServer' ? webServer : undefined),
      })
    },
  }
  apply(ctx)
  check('注册 14 个工具', toolNames.length === 14, JSON.stringify(toolNames))
  check('browser_e2e_click 参数仍为 ref/selector/x/y + tab_id', JSON.stringify(Object.keys(tools.get('browser_e2e_click').parameters.properties)) === JSON.stringify(['ref', 'selector', 'x', 'y', 'tab_id']))
  check('browser_e2e_screenshot 参数仍含 clip/format/quality/scale', ['name', 'fullPage', 'clip', 'format', 'quality', 'scale'].every((k) => k in tools.get('browser_e2e_screenshot').parameters.properties))
  check('面板 socket 路由已注册', typeof upgradeHandler === 'function')
  check('面板状态路由已注册', routes.has(PANEL_STATE_PATH))
}

/** 起一个模拟宿主：exact 路由 + upgrade 交给插件。 */
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(pathname)
  if (handler) {
    void handler(req, res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  if (pathname === PANEL_SOCKET_PATH && upgradeHandler) {
    upgradeHandler(req, socket, head)
    return
  }
  socket.destroy()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `127.0.0.1:${port}`
console.log(`  模拟宿主监听 http://${origin}`)

/** 连面板 socket 并攒事件。 */
function connectPanel() {
  const events = []
  const ws = new WebSocket(`ws://${origin}${PANEL_SOCKET_PATH}`)
  ws.on('message', (data) => {
    try {
      events.push(JSON.parse(data.toString()))
    } catch {
      // 非 JSON 帧不属于协议，忽略
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, events, opened }
}

const exec = { agent: { id: KEY } }
const WATCH = { agent: { id: KEY } }

console.log('== 用例 D：端到端协议 ==')
const panel = connectPanel()
await panel.opened
panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'attach', sessionId: SID }))
const hello = await waitFor(() => panel.events.find((event) => event.kind === 'hello'))
check('attach 后收到 hello', Boolean(hello), JSON.stringify(panel.events.slice(0, 3)))
check('没有浏览器时 running=false', hello?.state?.running === false, JSON.stringify(hello?.state))
check('没有浏览器时 activeTabId=null', hello?.state?.activeTabId === null, JSON.stringify(hello?.state))

await tools.get('browser_start').execute({ headless: true }, exec)
check('浏览器已启动', activeSessionKeys().includes(KEY), JSON.stringify(activeSessionKeys()))
const stateWithTab = await waitFor(() => panel.events.filter((event) => event.kind === 'state').find((event) => event.state.tabs.length > 0))
check('启动后推送含 tab 的状态', Boolean(stateWithTab), JSON.stringify(panel.events.map((e) => e.kind)))
check('tab id 是「会话 key#页面 tab_id」组合', stateWithTab?.state?.tabs?.[0]?.id === PANEL_TAB, JSON.stringify(stateWithTab?.state?.tabs))
check('tab 带 sessionId', stateWithTab?.state?.tabs?.[0]?.sessionId === SID, JSON.stringify(stateWithTab?.state?.tabs))
check('默认选中该 tab', stateWithTab?.state?.activeTabId === PANEL_TAB, String(stateWithTab?.state?.activeTabId))

await tools.get('browser_e2e_navigate').execute({ url: 'data:text/html,<title>panel</title><h1>hello panel</h1>' }, exec)
const frame = await waitFor(() => panel.events.find((event) => event.kind === 'frame' && event.tabId === PANEL_TAB && event.seq > 0))
check('投屏帧到达', Boolean(frame), JSON.stringify(panel.events.map((e) => e.kind)))
check('帧是 base64 JPEG', typeof frame?.data === 'string' && frame.data.startsWith('/9j/'), String(frame?.data?.slice(0, 8)))
check('帧带宽高', frame?.width > 0 && frame?.height > 0, `${frame?.width}x${frame?.height}`)

const framesBefore = panel.events.filter((event) => event.kind === 'frame').length
panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'request-frame' }))
const refreshed = await waitFor(() => panel.events.filter((event) => event.kind === 'frame').length > framesBefore)
check('刷新按钮产生新帧', refreshed, String(framesBefore))

const actionsBefore = panel.events.filter((event) => event.kind === 'action').length
await tools.get('browser_e2e_snapshot').execute({}, exec)
const action = await waitFor(() => panel.events.filter((event) => event.kind === 'action')[actionsBefore])
check('工具动作被广播', action?.trace?.tool === 'browser_e2e_snapshot', JSON.stringify(action))
check('动作带摘要与时间', typeof action?.trace?.summary === 'string' && action.trace.summary.length > 0 && typeof action?.trace?.at === 'number', JSON.stringify(action?.trace))

panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'configure', config: { quality: 55, maxWidth: 900 } }))
const configured = await waitFor(() => panel.events.filter((event) => event.kind === 'state').find((event) => event.state.config.quality === 55))
check('configure 生效并回推状态', Boolean(configured), JSON.stringify(panel.events.filter((e) => e.kind === 'state').slice(-2)))
check('未提供的字段保持不变', configured?.state?.config?.maxHeight === 800, JSON.stringify(configured?.state?.config))

panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'configure', config: { quality: 1 } }))
const configError = await waitFor(() => panel.events.find((event) => event.kind === 'error' && event.code === 'invalid-config'))
check('非法设置回 error 事件', Boolean(configError), JSON.stringify(panel.events.filter((e) => e.kind === 'error')))

panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'select-tab', tabId: 'no-such-tab' }))
const tabError = await waitFor(() => panel.events.find((event) => event.kind === 'error' && event.code === 'unknown-tab'))
check('未知 tab 回 error 事件', Boolean(tabError), JSON.stringify(panel.events.filter((e) => e.kind === 'error')))

const stateResponse = await fetch(`http://${origin}${PANEL_STATE_PATH}`)
const stateBody = await stateResponse.json()
check('状态路由 200', stateResponse.status === 200, String(stateResponse.status))
check('状态路由含 tabs', Array.isArray(stateBody?.state?.tabs) && stateBody.state.tabs.length === 1, JSON.stringify(stateBody))

const forbidden = await new Promise((resolve) => {
  const req = httpRequest({ host: '127.0.0.1', port, path: PANEL_STATE_PATH, method: 'GET', headers: { host: 'evil.example:4444' } }, (res) => {
    res.resume()
    resolve(res.statusCode)
  })
  req.on('error', () => resolve('error'))
  req.end()
})
check('非 loopback Host 的状态请求 403', forbidden === 403, String(forbidden))

const rejectedUpgrade = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://${origin}${PANEL_SOCKET_PATH}`, { headers: { host: 'evil.example:4444' } })
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode))
  ws.on('open', () => resolve('opened'))
  ws.on('error', () => resolve('error'))
})
check('非 loopback Host 的升级请求 403', rejectedUpgrade === 403, String(rejectedUpgrade))

const mismatch = connectPanel()
await mismatch.opened
mismatch.ws.send(JSON.stringify({ v: 99, kind: 'attach' }))
const mismatchError = await waitFor(() => mismatch.events.find((event) => event.kind === 'error'))
check('协议版本不符回 error', mismatchError?.code === 'protocol-mismatch', JSON.stringify(mismatchError))
const closedCode = await new Promise((resolve) => {
  if (mismatch.ws.readyState === WebSocket.CLOSED) resolve(1002)
  else mismatch.ws.once('close', (code) => resolve(code))
})
check('协议版本不符关闭连接（1002）', closedCode === 1002, String(closedCode))

await tools.get('browser_e2e_close').execute({}, WATCH)
const emptyState = await waitFor(() => panel.events.filter((event) => event.kind === 'state').find((event) => event.state.tabs.length === 0))
check('关闭浏览器后推送空状态', Boolean(emptyState), JSON.stringify(panel.events.filter((e) => e.kind === 'state').slice(-2)))
check('关闭后 running=false', emptyState?.state?.running === false, JSON.stringify(emptyState?.state))

panel.ws.close()
server.close()
await closeAll()
await sleep(200)
check('收尾后 sessions 为空', activeSessionKeys().length === 0, JSON.stringify(activeSessionKeys()))

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
