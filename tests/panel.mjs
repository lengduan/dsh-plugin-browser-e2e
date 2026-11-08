/**
 * 右侧实时浏览器面板的宿主半区验证。
 *
 * 分四段：
 *   A. loopback 围栏的判定（纯函数）；
 *   B. 设置合并与越界拒绝（纯函数）；
 *   C. 插件注册面：32 个工具的参数契约；
 *   D. 端到端：用真实 http 服务模拟宿主 webServer，注册插件自己的路由与 socket，
 *      真起无头 Edge，走完整协议（attach / hello / 帧 / 动作 / configure /
 *      request-frame / 未知命令 / 协议版本不符 / 关闭后状态清空），并校验围栏
 *      对非 loopback Host 返回 403。
 *
 * 运行：node tests/panel.mjs
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'
// 动作历史写入临时目录：本测试会多次 apply 并执行真实工具，必须在 apply 之前注入，
// 否则 lib/index.js 的写入接线会落到真实用户目录 ~/.dsh/browser-e2e/history/。
const HISTORY_DIR = mkdtempSync(join(tmpdir(), 'dsh-panel-history-'))
process.env.DSH_BROWSER_HISTORY_FILE = join(HISTORY_DIR, 'actions.jsonl')
delete process.env.DSH_BROWSER_HISTORY

const { mergeConfig, PanelHub } = await import('../lib/panel.js')
const { PANEL_STATE_PATH, PANEL_SOCKET_PATH, PANEL_PROTOCOL_VERSION, PANEL_COMMANDS, PANEL_EVENTS, PANEL_ERROR_CODES } = await import('../lib/protocol.js')
const { isLoopbackRequest, isLoopbackAddress, isLoopbackHostname } = await import('../lib/fence.js')
const { activeSessionKeys, closeAll, listPanelTabs } = await import('../lib/session.js')
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

console.log('== 用例 C0：协议零改动（动作历史抽屉只改客户端，不新增命令 / 事件 / 错误码）==')
{
  const counts = [
    Object.values(PANEL_COMMANDS).length,
    Object.values(PANEL_EVENTS).length,
    Object.values(PANEL_ERROR_CODES).length,
  ]
  check('命令 / 事件 / 错误码计数为 5 / 5 / 13', counts.join(' ') === '5 5 13', counts.join(' '))
}

console.log('== 用例 C：插件注册面（表驱动的工具契约）==')
// 期望从工具表派生：新增工具只改 lib/tools.js，这里不用改断言。
const { buildToolTable } = await import('../lib/tools.js')
const TOOL_TABLE = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
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
  apply(ctx, { quality: 30, maxWidth: 640 })
  check('注册的工具与工具表逐项一致（顺序与名字）',
    JSON.stringify(toolNames) === JSON.stringify(TOOL_TABLE.map((definition) => definition.name)), JSON.stringify(toolNames))
  check('工具表共 32 个', TOOL_TABLE.length === 32, String(TOOL_TABLE.length))
  check('工具名唯一且统一带 browser_e2e_ 前缀',
    new Set(toolNames).size === toolNames.length && toolNames.every((name) => name.startsWith('browser_e2e_')), JSON.stringify(toolNames))
  check('每个工具都有 description 与合法参数 schema（required 是 properties 子集）',
    TOOL_TABLE.every((definition) => typeof definition.description === 'string' && definition.description.length > 0
      && definition.parameters?.type === 'object' && definition.parameters?.additionalProperties === false
      && (definition.parameters.required ?? []).every((field) => field in definition.parameters.properties)))
  check('每个工具都有 run 与 output', TOOL_TABLE.every((definition) => typeof definition.run === 'function'
    && (definition.output === undefined || typeof definition.output.render === 'function')))
  check('新增 scroll 工具已注册', tools.has('browser_e2e_scroll'))
  check('新增 read 工具已注册且带 tab_id', tools.has('browser_e2e_read')
    && ['sections', 'maxItems', 'includeValues', 'selector', 'tab_id']
      .every((field) => field in tools.get('browser_e2e_read').parameters.properties))
  check('browser_e2e_follow_tab 的 tab_id 可选、activate 为布尔', (() => {
    const followTool = tools.get('browser_e2e_follow_tab')
    if (!followTool) return false
    const parameters = followTool.parameters
    return parameters.type === 'object'
      && parameters.additionalProperties === false
      && parameters.properties.tab_id?.type === 'string'
      && parameters.properties.activate?.type === 'boolean'
      && JSON.stringify(parameters.required) === '[]'
  })())
  check('作用于页面的工具都接受 tab_id', ['navigate', 'snapshot', 'read', 'click', 'fill', 'scroll', 'press', 'screenshot', 'console', 'network', 'wait', 'evaluate', 'hover', 'drag', 'download', 'fetch', 'dialog', 'clipboard', 'assert', 'recipe', 'captcha_check', 'wait_for_human', 'follow_tab']
    .every((suffix) => 'tab_id' in tools.get(`browser_e2e_${suffix}`).parameters.properties))
  check('browser_e2e_assert 声明 checks（1-20 条四选一对象）与 tab_id', (() => {
    const assertTool = tools.get('browser_e2e_assert')
    if (!assertTool) return false
    const parameters = assertTool.parameters
    const item = parameters.properties.checks?.items
    return typeof assertTool.description === 'string' && assertTool.description.includes('断言')
      && parameters.additionalProperties === false
      && JSON.stringify(parameters.required) === JSON.stringify(['checks'])
      && parameters.properties.checks?.type === 'array'
      && item?.type === 'object' && item.additionalProperties === false
      && ['selector', 'text', 'url', 'expression', 'state', 'urlMatch']
        .every((field) => item.properties?.[field]?.type === 'string')
      && 'tab_id' in parameters.properties
  })())
  check('browser_e2e_recipe 声明 steps 唯一必填、8 种步骤枚举与 timeoutMs / tab_id', (() => {
    const recipe = tools.get('browser_e2e_recipe')
    if (!recipe) return false
    const parameters = recipe.parameters
    const item = parameters.properties.steps?.items
    return typeof recipe.description === 'string' && recipe.description.includes('声明式步骤')
      && parameters.additionalProperties === false
      && JSON.stringify(parameters.required) === JSON.stringify(['steps'])
      && parameters.properties.steps?.type === 'array'
      && item?.type === 'object' && item.additionalProperties === false
      && JSON.stringify(item.required) === JSON.stringify(['type'])
      && JSON.stringify(item.properties.type?.enum)
        === JSON.stringify(['navigate', 'wait', 'click', 'fill', 'press', 'hover', 'scroll', 'extract'])
      && ['selector', 'ref', 'x', 'y', 'value', 'key', 'delta_x', 'delta_y', 'attribute', 'limit']
        .every((field) => field in item.properties)
      && parameters.properties.timeoutMs?.type === 'integer'
      && 'tab_id' in parameters.properties
  })())
  check('browser_e2e_clipboard 声明 action 枚举与 payload / 目标参数', (() => {
    const clipboard = tools.get('browser_e2e_clipboard')
    if (!clipboard) return false
    const parameters = clipboard.parameters
    return typeof clipboard.description === 'string' && clipboard.description.includes('剪贴板')
      && parameters.additionalProperties === false
      && JSON.stringify(parameters.required) === JSON.stringify(['action'])
      && JSON.stringify(parameters.properties.action?.enum) === JSON.stringify(['write', 'paste'])
      && parameters.properties.text?.type === 'string'
      && parameters.properties.html?.type === 'string'
      && parameters.properties.sanitize?.type === 'boolean'
      && parameters.properties.ref?.type === 'string'
      && parameters.properties.selector?.type === 'string'
      && 'tab_id' in parameters.properties
  })())
  check('browser_e2e_dialog 声明 policy 枚举与 prompt_text / limit / tab_id', (() => {
    const dialog = tools.get('browser_e2e_dialog')
    if (!dialog) return false
    const parameters = dialog.parameters
    return typeof dialog.description === 'string' && dialog.description.includes('对话框')
      && parameters.additionalProperties === false && parameters.required.length === 0
      && parameters.properties.policy?.type === 'string'
      && JSON.stringify(parameters.properties.policy.enum) === JSON.stringify(['dismiss', 'accept'])
      && parameters.properties.prompt_text?.type === 'string'
      && parameters.properties.limit?.type === 'integer'
      && 'tab_id' in parameters.properties
  })())
  check('browser_e2e_fill 把 value 列为必填，且提供 ref/selector/x/y 目标参数', (() => {
    const fill = tools.get('browser_e2e_fill').parameters
    return fill.required.includes('value') && ['ref', 'selector', 'x', 'y'].every((field) => field in fill.properties)
  })())
  check('browser_e2e_history 声明 limit / tool / ok / scope 参数', (() => {
    const historyTool = tools.get('browser_e2e_history')
    if (!historyTool) return false
    const parameters = historyTool.parameters
    return typeof historyTool.description === 'string' && historyTool.description.includes('动作历史')
      && parameters.additionalProperties === false && parameters.required.length === 0
      && parameters.properties.limit?.type === 'integer'
      && parameters.properties.tool?.type === 'string'
      && parameters.properties.ok?.type === 'boolean'
      && parameters.properties.scope?.type === 'string'
      && JSON.stringify(parameters.properties.scope?.enum) === JSON.stringify(['self', 'all'])
  })())
  check('browser_e2e_screenshot 参数含 clip/format/quality/scale', ['name', 'fullPage', 'clip', 'format', 'quality', 'scale'].every((k) => k in tools.get('browser_e2e_screenshot').parameters.properties))
  check('browser_e2e_console 的 level 参数声明枚举', (() => {
    const consoleTool = tools.get('browser_e2e_console')
    if (!consoleTool) return false
    const parameters = consoleTool.parameters
    const levels = parameters.properties.level?.enum ?? []
    return parameters.properties.level?.type === 'string'
      && ['debug', 'log', 'info', 'warning', 'error', 'warn'].every((level) => levels.includes(level))
      && 'limit' in parameters.properties
      && 'tab_id' in parameters.properties
  })())
  check('browser_e2e_click / press 描述与参数声明指针和按住动作', (() => {
    const clickTool = tools.get('browser_e2e_click')
    const pressTool = tools.get('browser_e2e_press')
    if (!clickTool || !pressTool) return false
    const clickParams = clickTool.parameters
    const pressParams = pressTool.parameters
    return typeof clickTool.description === 'string' && clickTool.description.includes('clickCount')
      && clickParams.additionalProperties === false
      && clickParams.properties.clickCount?.type === 'integer'
      && JSON.stringify(clickParams.properties.button?.enum) === JSON.stringify(['left', 'right', 'middle'])
      && clickParams.properties.modifiers?.type === 'array'
      && JSON.stringify(clickParams.properties.modifiers?.items?.enum) === JSON.stringify(['Alt', 'Control', 'Meta', 'Shift'])
      && typeof pressTool.description === 'string' && pressTool.description.includes('action=press')
      && pressParams.additionalProperties === false
      && JSON.stringify(pressParams.required) === JSON.stringify(['key'])
      && JSON.stringify(pressParams.properties.action?.enum) === JSON.stringify(['press', 'down', 'up'])
      && pressParams.properties.repeat?.type === 'integer'
  })())
  check('browser_e2e_captcha_check 声明 textScan / tab_id 且无必填', (() => {
    const captcha = tools.get('browser_e2e_captcha_check')
    if (!captcha) return false
    const parameters = captcha.parameters
    return typeof captcha.description === 'string' && captcha.description.includes('人机验证')
      && parameters.additionalProperties === false && parameters.required.length === 0
      && JSON.stringify(Object.keys(parameters.properties).sort()) === JSON.stringify(['tab_id', 'textScan'])
      && parameters.properties.textScan?.type === 'boolean'
      && parameters.properties.tab_id?.type === 'string'
  })())
  check('browser_e2e_wait_for_human 声明 reason / timeoutMs / pollMs / selector / textScan / tab_id', (() => {
    const waitHuman = tools.get('browser_e2e_wait_for_human')
    if (!waitHuman) return false
    const parameters = waitHuman.parameters
    return typeof waitHuman.description === 'string' && waitHuman.description.includes('人机验证')
      && parameters.additionalProperties === false && parameters.required.length === 0
      && ['reason', 'timeoutMs', 'pollMs', 'selector', 'textScan', 'tab_id']
        .every((field) => field in parameters.properties)
      && parameters.properties.reason?.type === 'string'
      && parameters.properties.timeoutMs?.type === 'integer'
      && parameters.properties.pollMs?.type === 'integer'
      && parameters.properties.selector?.type === 'string'
      && parameters.properties.textScan?.type === 'boolean'
  })())
  check('browser_e2e_start 的 mode 参数声明枚举', JSON.stringify(tools.get('browser_e2e_start').parameters.properties.mode.enum)
    === JSON.stringify(['isolated', 'cdp']), JSON.stringify(tools.get('browser_e2e_start').parameters.properties.mode))
  check('browser_e2e_start 的 carrier 参数声明枚举', JSON.stringify(tools.get('browser_e2e_start').parameters.properties.carrier?.enum)
    === JSON.stringify(['edge', 'chrome', 'auto']), JSON.stringify(tools.get('browser_e2e_start').parameters.properties.carrier))
  check('工具总数不因本项变化', tools.size === TOOL_TABLE.length && tools.size === 32, String(tools.size))
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
check('状态含 mode / endpoint 字段', hello?.state?.mode === 'isolated' && hello?.state?.endpoint === '', JSON.stringify({ mode: hello?.state?.mode, endpoint: hello?.state?.endpoint }))
check('apply 的 Config 投屏参数进入面板初始配置', hello?.state?.config?.quality === 30 && hello?.state?.config?.maxWidth === 640 && hello?.state?.config?.maxHeight === 800 && hello?.state?.config?.everyNthFrame === 1, JSON.stringify(hello?.state?.config))

await tools.get('browser_e2e_start').execute({ headless: true }, exec)
check('浏览器已启动', activeSessionKeys().includes(KEY), JSON.stringify(activeSessionKeys()))
const stateWithTab = await waitFor(() => panel.events.filter((event) => event.kind === 'state').find((event) => event.state.tabs.length > 0))
check('启动后推送含 tab 的状态', Boolean(stateWithTab), JSON.stringify(panel.events.map((e) => e.kind)))
check('tab id 是「会话 key#页面 tab_id」组合', stateWithTab?.state?.tabs?.[0]?.id === PANEL_TAB, JSON.stringify(stateWithTab?.state?.tabs))
check('tab 带 sessionId', stateWithTab?.state?.tabs?.[0]?.sessionId === SID, JSON.stringify(stateWithTab?.state?.tabs))
check('tab 带 loading / origin 字段', typeof stateWithTab?.state?.tabs?.[0]?.loading === 'boolean' && stateWithTab?.state?.tabs?.[0]?.origin === 'created', JSON.stringify(stateWithTab?.state?.tabs?.[0]))
check('tab 带 mode / endpoint 字段（isolated 时 endpoint 为空串）', stateWithTab?.state?.tabs?.[0]?.mode === 'isolated' && stateWithTab?.state?.tabs?.[0]?.endpoint === '', JSON.stringify(stateWithTab?.state?.tabs?.[0]))
check('默认选中该 tab', stateWithTab?.state?.activeTabId === PANEL_TAB, String(stateWithTab?.state?.activeTabId))
check('有浏览器时 mode=isolated / endpoint 为空串', stateWithTab?.state?.mode === 'isolated' && stateWithTab?.state?.endpoint === '', JSON.stringify({ mode: stateWithTab?.state?.mode, endpoint: stateWithTab?.state?.endpoint }))

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

// tab 标题透传：state 里的 title 取页面真实标题。
const titledState = await waitFor(() => panel.events.filter((event) => event.kind === 'state')
  .find((event) => event.state.tabs.some((tab) => tab.title === 'panel')))
check('tab 标题透传', Boolean(titledState), JSON.stringify(panel.events.filter((e) => e.kind === 'state').slice(-3)))

// 动作历史：真实 fill 的明文只存在于入参，落盘与读回都应只剩掩码。
console.log('== 用例 C2：动作历史（真实 fill 落盘与读回）==')
{
  const historyFile = process.env.DSH_BROWSER_HISTORY_FILE
  const SECRET = 'secret-P@ss-2026'
  await tools.get('browser_e2e_navigate').execute({ url: 'data:text/html,<title>history</title><input id="secret">' }, exec)
  await tools.get('browser_e2e_fill').execute({ selector: '#secret', value: SECRET }, exec)
  const raw = readFileSync(historyFile, 'utf8')
  check('真实 fill 的明文不出现在历史文件里', !raw.includes(SECRET) && raw.includes('[已脱敏'), raw.slice(-400))
  const text = await tools.get('browser_e2e_history').execute({ tool: 'browser_e2e_fill', limit: 5, scope: 'self' }, exec)
  const lines = text.split('\n')
  check('browser_e2e_history 读回刚发生的 fill（摘要为掩码）',
    lines[0].includes('；tool=browser_e2e_fill）')
      && lines[1] === `文件：${historyFile}`
      && text.includes(`[已脱敏 ${Array.from(SECRET).length} 个字符]`)
      && !text.includes(SECRET),
    text)
}

// 再开一个 tab，然后用面板命令关掉它。
// 断言只看本次操作之后的事件，避免命中较早遗留的 state（历史事件会让「已关闭」误判成立）。
const eventsBeforeNewTab = panel.events.length
await tools.get('browser_e2e_navigate').execute({ url: 'data:text/html,<title>second</title><h1>second</h1>', new_tab: true }, exec)
const twoTabsState = await waitFor(() => panel.events.slice(eventsBeforeNewTab)
  .filter((event) => event.kind === 'state').find((event) => event.state.tabs.length === 2))
check('新开 tab 后推送 2 个 tab 的状态', Boolean(twoTabsState), JSON.stringify(panel.events.filter((e) => e.kind === 'state').slice(-2)))
const titledSecond = await waitFor(() => panel.events.slice(eventsBeforeNewTab)
  .filter((event) => event.kind === 'state')
  .find((event) => event.state.tabs.some((tab) => tab.title === 'second')))
check('新 tab 标题透传', Boolean(titledSecond), JSON.stringify(titledSecond?.state?.tabs))

const secondPanelTab = `${KEY}#t2`
const eventsBeforeClose = panel.events.length
panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'close-tab', tabId: secondPanelTab }))
const closedState = await waitFor(() => panel.events.slice(eventsBeforeClose).filter((event) => event.kind === 'state')
  .find((event) => event.state.tabs.length === 1 && !event.state.tabs.some((tab) => tab.id === secondPanelTab)))
check('close-tab 关闭 tab 并推送新 state', Boolean(closedState), JSON.stringify(panel.events.filter((e) => e.kind === 'state').slice(-2)))
check('close-tab 后 active tab 回到剩余页', closedState?.state?.activeTabId === PANEL_TAB, String(closedState?.state?.activeTabId))

const eventsBeforeLastClose = panel.events.length
panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'close-tab', tabId: PANEL_TAB }))
const lastTabError = await waitFor(() => panel.events.slice(eventsBeforeLastClose)
  .find((event) => event.kind === 'error' && event.code === 'last-tab'))
check('最后一个 tab 关闭回 error（last-tab）', Boolean(lastTabError), JSON.stringify(panel.events.filter((e) => e.kind === 'error')))
check('last-tab 错误文案来自 panel 判据（不是 session 抛的文案）',
  lastTabError?.message === '最后一个标签页不能关闭', String(lastTabError?.message))

// 多会话：判据是目标 tab 所属会话的页数，别的会话还有页不能让它误判成可关闭。
const KEY2 = 'panel-test-key2'
await tools.get('browser_e2e_start').execute({ headless: true }, { agent: { id: KEY2 } })
const key2PanelTab = `${KEY2}#t1`
const tabsAfterKey2 = await listPanelTabs()
check('第二个会话启动后共有 2 个面板 tab', tabsAfterKey2.length === 2, JSON.stringify(tabsAfterKey2.map((tab) => tab.id)))
const eventsBeforeKey2Close = panel.events.length
panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'close-tab', tabId: key2PanelTab }))
const key2Error = await waitFor(() => panel.events.slice(eventsBeforeKey2Close)
  .find((event) => event.kind === 'error'))
check('关闭另一会话的唯一页回 last-tab（不是 close-tab-failed）', key2Error?.code === 'last-tab', JSON.stringify(key2Error))
check('跨会话 last-tab 走 panel 判据文案', key2Error?.message === '最后一个标签页不能关闭', String(key2Error?.message))
const key2TabsAfter = await listPanelTabs()
check('last-tab 后该会话的页仍在', key2TabsAfter.some((tab) => tab.id === key2PanelTab), JSON.stringify(key2TabsAfter.map((tab) => tab.id)))
// 收尾：关掉第二个会话，后续断言仍按单会话状态进行。
await tools.get('browser_e2e_close').execute({}, { agent: { id: KEY2 } })
const key2Closed = await waitFor(async () => (await listPanelTabs()).length === 1)
check('关掉第二会话后只剩 1 个面板 tab', Boolean(key2Closed), JSON.stringify((await listPanelTabs()).map((tab) => tab.id)))

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

panel.ws.send(JSON.stringify({ v: PANEL_PROTOCOL_VERSION, kind: 'no-such-command' }))
const invalidCommand = await waitFor(() => panel.events.find((event) => event.kind === 'error' && event.code === 'invalid-command'))
check('未知命令 kind 回 invalid-command 错误事件', Boolean(invalidCommand), JSON.stringify(invalidCommand))

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

console.log('== 用例 E：插件 Config 默认值（launch 缺省值）==')
{
  /** 独立的注册表，按需要以不同配置调 apply。 */
  const makeToolCtx = (defs) => ({
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    on: () => () => {},
    effect: (factory) => { factory(); return () => {} },
  })

  // 配置 defaultMode=cdp 时首次启动要走 CDP 分支：非法 loopback 端点被拒绝，证明配置被消费。
  const cdpDefs = new Map()
  apply(makeToolCtx(cdpDefs), { defaultMode: 'cdp', cdpEndpoint: 'http://10.0.0.5:9222' })
  let cdpConfigError = null
  try {
    await cdpDefs.get('browser_e2e_start').execute({ headless: true }, { agent: { id: 'panel-config-cdp' } })
  } catch (error) {
    cdpConfigError = error instanceof Error ? error.message : String(error)
  }
  check('配置 defaultMode=cdp 被首次启动消费', typeof cdpConfigError === 'string' && cdpConfigError.includes('loopback'), String(cdpConfigError))

  // 无配置时保持 isolated。
  const plainDefs = new Map()
  apply(makeToolCtx(plainDefs))
  const started = await plainDefs.get('browser_e2e_start').execute({ headless: true }, { agent: { id: 'panel-config-reuse' } })
  check('未提供配置时默认 isolated', typeof started === 'string' && started.includes('产物目录'), String(started).split('\n')[0])

  // 配置默认值不得让已启动的 isolated 会话在下次 start 时报 mode 不一致。
  const reuseDefs = new Map()
  apply(makeToolCtx(reuseDefs), { defaultMode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' })
  let reuseError = null
  let reused = null
  try {
    reused = await reuseDefs.get('browser_e2e_start').execute({ headless: true }, { agent: { id: 'panel-config-reuse' } })
  } catch (error) {
    reuseError = error instanceof Error ? error.message : String(error)
  }
  check('配置默认值不让已启动会话报 mode 不一致', reuseError === null && typeof reused === 'string' && reused.includes('已启动'), `${reuseError} / ${String(reused).split('\n')[0]}`)
  await reuseDefs.get('browser_e2e_close').execute({}, { agent: { id: 'panel-config-reuse' } })

  // volatile 即时更新：先 apply，再替换配置引用里的快照；后续 start 应读到新值
  // （defaultMode 改成 cdp，端点换成非 loopback，报 loopback 错误即证明两处都读到了新值）。
  const volatileDefs = new Map()
  const volatileConfig = {
    defaultMode: { get: () => 'isolated' },
    cdpEndpoint: { get: () => 'http://127.0.0.1:9222' },
  }
  apply(makeToolCtx(volatileDefs), volatileConfig)
  volatileConfig.defaultMode = { get: () => 'cdp' }
  volatileConfig.cdpEndpoint = { get: () => 'http://10.0.0.5:9222' }
  let volatileError = null
  try {
    await volatileDefs.get('browser_e2e_start').execute({ headless: true }, { agent: { id: 'panel-volatile' } })
  } catch (error) {
    volatileError = error instanceof Error ? error.message : String(error)
  }
  check('volatile 更新后 start 即时读到新 defaultMode / cdpEndpoint',
    typeof volatileError === 'string' && volatileError.includes('loopback'), String(volatileError))

  // mode 非法值显式报错，且不能落成 isolated 会话。
  const badModeDefs = new Map()
  apply(makeToolCtx(badModeDefs))
  let badModeError = null
  try {
    await badModeDefs.get('browser_e2e_start').execute({ mode: 'cdpp' }, { agent: { id: 'panel-bad-mode' } })
  } catch (error) {
    badModeError = error instanceof Error ? error.message : String(error)
  }
  check('mode=cdpp 的 start 显式报错且不启动 isolated',
    typeof badModeError === 'string' && badModeError.includes('mode 只支持 isolated / cdp')
      && !activeSessionKeys().includes('panel-bad-mode'), `${badModeError} / ${JSON.stringify(activeSessionKeys())}`)
}

console.log('== 用例 F：投屏参数接线（Config → PanelHub）==')
{
  // 构造时与 DEFAULT_SCREENCAST_CONFIG 合并：提供的合法字段生效，其余保持默认。
  const merged = new PanelHub({ config: { quality: 30, maxWidth: 640 } })
  check('PanelHub 构造时合并 Config 投屏参数', merged.config.quality === 30 && merged.config.maxWidth === 640
    && merged.config.maxHeight === 800 && merged.config.everyNthFrame === 1, JSON.stringify(merged.config))
  merged.dispose()

  // 非法字段逐字段回退默认，不影响同批合法字段。
  const fallback = new PanelHub({ config: { quality: 5, maxWidth: 640.5, maxHeight: 'wide', everyNthFrame: 99 } })
  check('非法投屏参数逐字段回退默认', JSON.stringify(fallback.config)
    === JSON.stringify({ quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }), JSON.stringify(fallback.config))

  // 已连接客户端在 applyConfig 后收到含新 config 的 state。
  const events = []
  fallback.clients.add({ send: (event) => events.push(event) })
  await fallback.applyConfig({ quality: 42, maxHeight: 720 })
  const pushed = events.filter((event) => event.kind === 'state').at(-1)
  check('applyConfig 回推含新 config 的 state', pushed?.state?.config?.quality === 42
    && pushed?.state?.config?.maxHeight === 720 && pushed?.state?.config?.maxWidth === 1280, JSON.stringify(pushed?.state?.config))

  // 非法值回退默认而不是抛错（宿主配置里的脏值不能让面板起不来）。
  await fallback.applyConfig({ quality: 5 })
  check('applyConfig 非法值回退默认', fallback.config.quality === 70 && fallback.config.maxHeight === 800, JSON.stringify(fallback.config))
  fallback.dispose()

  // 宿主保存即时字段时 apply 收到的是 volatile 引用（{get()}）；这里模拟该形态，
  // 经面板状态路由取回 config，验证 apply 确实读到了引用里的快照。
  const panelRoutes = new Map()
  const cleanups = []
  const configCtx = {
    tools: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => { cleanups.push(fn()); return () => {} },
    get: (name) => (name === 'webServer' ? {
      register(route) { panelRoutes.set(route.path, route.handler); return () => {} },
      registerUpgrade() { return () => {} },
    } : undefined),
  }
  apply(configCtx, { quality: { get: () => 33 }, maxWidth: { get: () => 720 } })
  const response = { status: 0, text: '' }
  await panelRoutes.get(PANEL_STATE_PATH)({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:1' },
    method: 'GET',
  }, {
    writeHead(status) { response.status = status },
    end(text) { response.text = String(text) },
  })
  const body = JSON.parse(response.text === '' ? '{}' : response.text)
  check('apply 读取 volatile 配置引用', response.status === 200 && body?.state?.config?.quality === 33
    && body?.state?.config?.maxWidth === 720, `${response.status} ${response.text.slice(0, 160)}`)
  for (const dispose of cleanups.reverse()) await dispose?.()
}

panel.ws.close()
server.close()
await closeAll()
// closeAll 的清理是异步的：轮询等待会话注册表清空（最多 5s），不做固定 sleep 后立即断言。
const sessionsCleared = await waitFor(() => activeSessionKeys().length === 0, 5000)
check('收尾后 sessions 为空', sessionsCleared === true, JSON.stringify(activeSessionKeys()))

console.log('')
console.log(`动作历史文件（本次临时）：${process.env.DSH_BROWSER_HISTORY_FILE}`)
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
