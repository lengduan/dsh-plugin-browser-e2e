/**
 * lib/client.js 的 headless 冒烟测试。
 *
 * 用 Node 内置 vm 起一个假浏览器环境（window.__ModuleLoader__ / document /
 * navigator / WebSocket / require("react") 全部打桩），加载生成后的 bundle，
 * 断言注册面、协议纯函数，并用一个最小 React 运行时真正渲染一次面板：
 * 接 WebSocket → hello/state → frame → 点按钮发命令 → 改设置 → 错误横幅 →
 * 断线退避重连。全部用 PASS/FAIL 计数，失败时退出码为 1。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '..', 'lib', 'client.js')
const bundleCode = readFileSync(bundlePath, 'utf8')

let passed = 0
let failed = 0

/** 跑一个用例：异常计 FAIL 并继续，保证一次跑完所有断言。 */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name)
    console.error('     ' + String((error && error.message) || error).split('\n').join('\n     '))
  }
}

// ── 桩环境 ────────────────────────────────────────────────────────────────
/** React 桩；useState/useEffect/useRef 在下面被替换成可重渲染的最小运行时。 */
const reactStub = {
  createElement(type, props) {
    return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function () {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value === undefined ? null : value }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

/** WebSocket 桩：只记录实例与 send 内容。 */
class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }
}
FakeWebSocket.instances = []

/** 假定时器：重连退避的延时不会真的等待，也别让进程被挂住。 */
const timers = new Map()
let timerSeq = 0
function fakeSetTimeout(fn, ms) {
  timerSeq += 1
  timers.set(timerSeq, { fn, ms })
  return timerSeq
}
function fakeClearTimeout(id) {
  timers.delete(id)
}
/** 取最近一个未触发的定时器（重连退避）。 */
function lastTimer() {
  const entries = Array.from(timers.values())
  return entries[entries.length - 1]
}
/** 触发并移除最近一个定时器。 */
function runLastTimer() {
  const entries = Array.from(timers.entries())
  const [id, entry] = entries[entries.length - 1]
  timers.delete(id)
  entry.fn()
}

/** 只允许 require("react")，其余模块名直接报错。 */
function requireStub(name) {
  if (name === 'react') return reactStub
  throw new Error('bundle 只应 require("react")，实际要求：' + name)
}

const loaderCalls = []
let captured = null

const sandbox = {
  console,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  URL,
  navigator: { language: 'zh-CN' },
  document: {
    createElement() {
      return { dataset: {}, style: {}, appendChild() {}, textContent: '' }
    },
    head: { appendChild() {} },
    querySelector() {
      return null
    },
  },
  WebSocket: FakeWebSocket,
  location: { protocol: 'http:', host: '127.0.0.1:65301' },
  __DSH_TRANSPORT__: undefined,
}
// window 与全局同一对象：bundle 顶层用 window.__ModuleLoader__，面板代码用 window.location。
sandbox.window = sandbox
sandbox.__ModuleLoader__ = {
  load(definition) {
    loaderCalls.push(definition)
    captured = definition
    captured.exports = definition.factory(requireStub)
  },
}

vm.createContext(sandbox)
vm.runInContext(bundleCode, sandbox, { filename: 'lib/client.js' })

const api = captured && captured.exports

// ── bundle 形态 ───────────────────────────────────────────────────────────
check('bundle 以 __ModuleLoader__.load 加载，id 为 dsh-browser-e2e', () => {
  assert.equal(loaderCalls.length, 1)
  assert.equal(captured.id, 'dsh-browser-e2e')
  assert.equal(typeof captured.factory, 'function')
})

check('生成物带“勿手改”头注释', () => {
  assert.ok(bundleCode.startsWith('/* 由 scripts/build-client.mjs 生成，勿手改'))
})

check('模块导出 apply 与 inject', () => {
  assert.equal(typeof api.apply, 'function')
  assert.equal(JSON.stringify(api.inject), JSON.stringify(['slots', 'sidebarRightTabs']))
})

// ── 注册面 ───────────────────────────────────────────────────────────────
const injected = []
const registered = []
const tabDefinitions = []
const ctx = {
  slots: {
    inject(name, callback) {
      injected.push({ name, callback })
      return function () {}
    },
    register(spec, component) {
      registered.push({ spec, component })
      return function () {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      tabDefinitions.push(definition)
      return function () {}
    },
  },
}
api.apply(ctx)

check('apply 注册了 tab 类型', () => {
  assert.equal(tabDefinitions.length, 1)
  const definition = tabDefinitions[0]
  assert.equal(definition.id, 'dsh-browser-e2e')
  assert.equal(definition.kind, 'browser-e2e')
  assert.equal(definition.keepMounted, true)
  assert.equal(definition.priority, 'extension')
  assert.equal(typeof definition.title, 'function')
  assert.ok(definition.title().length > 0)
})

check('tab guide 有一条 order 50 的 open 条目', () => {
  const guide = tabDefinitions[0].guide
  assert.equal(guide.length, 1)
  assert.equal(guide[0].id, 'open')
  assert.equal(guide[0].order, 50)
  assert.equal(typeof guide[0].title, 'function')
  assert.equal(typeof guide[0].description, 'function')
  assert.equal(typeof guide[0].icon, 'function')
  assert.ok(guide[0].title().length > 0)
  assert.ok(guide[0].description().length > 0)
})

check('apply 向两个 slot 注入回调', () => {
  assert.equal(injected.length, 2)
  assert.equal(injected[0].name, 'sidebar.right.pane.tab')
  assert.equal(injected[1].name, 'sidebar.right.pane.tab.title')
})

check('两个 slot 注册同一个 key，pane body 与 title 用不同组件', () => {
  injected[0].callback()
  injected[1].callback()
  assert.equal(registered.length, 2)
  assert.equal(registered[0].spec.name, 'sidebar.right.pane.tab')
  assert.equal(registered[1].spec.name, 'sidebar.right.pane.tab.title')
  assert.equal(registered[0].spec.key, 'dsh-browser-e2e')
  assert.equal(registered[1].spec.key, 'dsh-browser-e2e')
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(typeof registered[1].component, 'function')
  assert.notEqual(registered[0].component, registered[1].component)
})

check('slot 的 inject 回传 {sessionId}', () => {
  const props = registered[0].spec.inject('session-abc')
  assert.equal(JSON.stringify(props), JSON.stringify({ sessionId: 'session-abc' }))
})

// ── 最小 React 运行时（脚手架上的 render / useEffect / setState） ────────
const hooks = { cursor: 0, states: [], refs: [], effects: {}, pending: [], dirty: false }

reactStub.useState = function (initial) {
  const index = hooks.cursor
  hooks.cursor += 1
  if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial
  const setState = function (next) {
    const value = typeof next === 'function' ? next(hooks.states[index]) : next
    if (Object.is(value, hooks.states[index])) return
    hooks.states[index] = value
    hooks.dirty = true
  }
  return [hooks.states[index], setState]
}
reactStub.useRef = function (initial) {
  const index = hooks.cursor
  hooks.cursor += 1
  if (!(index in hooks.refs)) hooks.refs[index] = { current: initial === undefined ? null : initial }
  return hooks.refs[index]
}
reactStub.useEffect = function (fn, deps) {
  const index = hooks.cursor
  hooks.cursor += 1
  hooks.pending.push({ index, fn, deps })
}

function sameDeps(previous, next) {
  if (!previous || !next) return false
  if (previous.length !== next.length) return false
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return false
  }
  return true
}

function runPendingEffects() {
  for (const item of hooks.pending) {
    const previous = hooks.effects[item.index]
    if (previous && previous.ran && sameDeps(previous.deps, item.deps)) continue
    if (previous && typeof previous.cleanup === 'function') previous.cleanup()
    const cleanup = item.fn()
    hooks.effects[item.index] = {
      ran: true,
      deps: item.deps,
      cleanup: typeof cleanup === 'function' ? cleanup : undefined,
    }
  }
}

/** 渲染面板：setState 后自动重渲染，直到状态稳定（最多 10 轮防死循环）。 */
function renderPanel(component, props) {
  let element = null
  for (let round = 0; round < 10; round += 1) {
    hooks.cursor = 0
    hooks.pending = []
    hooks.dirty = false
    element = component(props)
    runPendingEffects()
    if (!hooks.dirty) break
  }
  return element
}

/** 递归取文本内容（字符串子节点）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return (node.children || []).map(textOf).join('')
  return ''
}

/** 递归收集满足条件的元素。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node === 'object') {
    if (node.type !== undefined && predicate(node)) out.push(node)
    for (const child of node.children || []) findAll(child, predicate, out)
  }
  return out
}

function findByPart(root, part) {
  return findAll(root, (node) => node.props && node.props['data-dsh-part'] === part)[0]
}

function findButtonByText(root, text) {
  return findAll(root, (node) => node.type === 'button').find((node) => textOf(node).includes(text))
}

// 用注册出来的真实组件渲染，props 取 slot inject 的回传值。
const panelComponent = registered[0].component
const titleComponent = registered[1].component
const panelProps = registered[0].spec.inject('session-abc')

/** 驱动一次渲染。 */
function render() {
  return renderPanel(panelComponent, panelProps)
}

/** 打开最近创建的 WebSocket（模拟 onopen 前的 readyState）。 */
function openSocket(socket) {
  socket.readyState = 1
  if (typeof socket.onopen === 'function') socket.onopen()
}

/** 推一条事件给面板。 */
function pushEvent(socket, event) {
  if (typeof socket.onmessage === 'function') socket.onmessage({ data: JSON.stringify(event) })
}

let panelTree = render()

check('首次渲染：根节点为 flex column 面板，未连接时显示连接中', () => {
  assert.equal(panelTree.type, 'div')
  assert.equal(panelTree.props['data-dsh-plugin'], 'browser-e2e')
  assert.equal(panelTree.props['data-dsh-part'], 'panel')
  assert.equal(panelTree.props.style.display, 'flex')
  assert.equal(panelTree.props.style.flexDirection, 'column')
  const placeholder = findByPart(panelTree, 'stage')
  assert.ok(textOf(placeholder).includes('正在连接实时画面'))
})

check('首次渲染即按同源推导出 socket 并建立连接', () => {
  assert.equal(FakeWebSocket.instances.length, 1)
  const socket = FakeWebSocket.instances[0]
  assert.equal(socket.url, 'ws://127.0.0.1:65301/api/dsh-browser-e2e/socket')
  assert.equal(findByPart(panelTree, 'toolbar').props['data-dsh-part'], 'toolbar')
})

const socket = FakeWebSocket.instances[0]

check('onopen 后先发 attach{sessionId}', () => {
  openSocket(socket)
  assert.equal(socket.sent.length, 1)
  const attach = JSON.parse(socket.sent[0])
  assert.equal(attach.v, 1)
  assert.equal(attach.kind, 'attach')
  assert.equal(attach.sessionId, 'session-abc')
  panelTree = render()
  assert.equal(panelTree.props['data-dsh-connection'], 'open')
  assert.ok(textOf(findByPart(panelTree, 'toolbar')).includes('实时'))
})

const helloState = {
  tabs: [
    { id: 'tab-1', url: 'http://127.0.0.1:19387/', title: '首页', loading: false },
    { id: 'tab-2', url: 'http://127.0.0.1:19388/', title: '', loading: true },
  ],
  activeTabId: 'tab-1',
  running: true,
  config: { quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
}

check('hello/state 后渲染 tab 条与当前 URL', () => {
  pushEvent(socket, { v: 1, kind: 'hello', state: helloState })
  panelTree = render()
  const tabBar = findByPart(panelTree, 'tabs')
  const tabButtons = findAll(tabBar, (node) => node.type === 'button')
  assert.equal(tabButtons.length, 2)
  assert.equal(textOf(tabButtons[0]), '首页')
  // 无标题时退回 url
  assert.equal(textOf(tabButtons[1]), 'http://127.0.0.1:19388/加载中')
  assert.equal(tabButtons[0].props['data-dsh-active'], 'true')
  assert.equal(tabButtons[1].props['data-dsh-active'], 'false')
  assert.ok(textOf(findByPart(panelTree, 'toolbar')).includes('http://127.0.0.1:19387/'))
})

check('frame 事件渲染成 data:image/jpeg;base64 图片', () => {
  pushEvent(socket, { v: 1, kind: 'frame', tabId: 'tab-1', seq: 5, width: 1280, height: 800, data: 'AAA' })
  panelTree = render()
  const images = findAll(panelTree, (node) => node.type === 'img')
  assert.equal(images.length, 1)
  assert.equal(images[0].props.src, 'data:image/jpeg;base64,AAA')
})

check('旧 seq 帧不覆盖画面', () => {
  pushEvent(socket, { v: 1, kind: 'frame', tabId: 'tab-1', seq: 4, width: 1280, height: 800, data: 'OLD' })
  panelTree = render()
  const images = findAll(panelTree, (node) => node.type === 'img')
  assert.equal(images[0].props.src, 'data:image/jpeg;base64,AAA')
})

check('点 tab 发 select-tab，点刷新发 request-frame', () => {
  const tabBar = findByPart(panelTree, 'tabs')
  const tabButtons = findAll(tabBar, (node) => node.type === 'button')
  tabButtons[1].props.onClick()
  const selectCommand = JSON.parse(socket.sent[socket.sent.length - 1])
  assert.equal(selectCommand.kind, 'select-tab')
  assert.equal(selectCommand.tabId, 'tab-2')

  const refresh = findButtonByText(panelTree, '刷新')
  assert.ok(refresh)
  assert.equal(refresh.props.disabled, false)
  refresh.props.onClick()
  const frameCommand = JSON.parse(socket.sent[socket.sent.length - 1])
  assert.equal(frameCommand.kind, 'request-frame')
})

check('设置卡片可展开，改 quality 发 configure', () => {
  const head = findButtonByText(panelTree, '画面设置')
  assert.ok(head)
  head.props.onClick()
  panelTree = render()
  const inputs = findAll(panelTree, (node) => node.type === 'input')
  assert.equal(inputs.length, 4)
  assert.equal(inputs[0].props.value, '70')
  assert.equal(inputs[0].props.min, 10)
  assert.equal(inputs[0].props.max, 100)

  inputs[0].props.onChange({ target: { value: '40' } })
  const configure = JSON.parse(socket.sent[socket.sent.length - 1])
  assert.equal(configure.kind, 'configure')
  assert.equal(configure.config.quality, 40)
  assert.equal(configure.config.maxWidth, 1280)
  assert.equal(configure.config.everyNthFrame, 1)

  panelTree = render()
  const updated = findAll(panelTree, (node) => node.type === 'input')
  assert.equal(updated[0].props.value, '40')
})

check('error 事件显示 code + message 横幅', () => {
  pushEvent(socket, { v: 1, kind: 'error', code: 'socket_closed', message: '连不上实时通道' })
  panelTree = render()
  const banner = findByPart(panelTree, 'error')
  assert.ok(banner)
  const text = textOf(banner)
  assert.ok(text.includes('socket_closed'))
  assert.ok(text.includes('连不上实时通道'))
})

check('action 事件渲染最近动作', () => {
  pushEvent(socket, { v: 1, kind: 'action', trace: { tool: 'browser_e2e_click', summary: '点击 @1', at: Date.now() } })
  panelTree = render()
  const action = findByPart(panelTree, 'action')
  assert.ok(action)
  assert.ok(textOf(action).includes('点击 @1'))
})

check('tab chip 渲染字形与名称', () => {
  const chip = renderPanel(titleComponent, { sessionId: 'session-abc' })
  assert.equal(chip.props['data-dsh-plugin'], 'browser-e2e')
  assert.equal(chip.props['data-dsh-part'], 'tab-title')
  assert.ok(textOf(chip).includes('浏览器画面'))
  // 字形是独立组件，执行一次确认它返回 svg。
  const marks = findAll(chip, (node) => typeof node.type === 'function')
  assert.equal(marks.length, 1)
  const glyph = marks[0].type({})
  assert.equal(glyph.type, 'svg')
})

check('断线后按 500ms 起、每次翻倍、上限 15s 退避重连', () => {
  const delays = []
  let current = socket
  for (let i = 0; i < 7; i += 1) {
    current.readyState = 3
    current.onclose()
    const timer = lastTimer()
    assert.ok(timer, '第 ' + (i + 1) + ' 次断线应安排重连定时器')
    delays.push(timer.ms)
    runLastTimer()
    current = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    // 每轮重连都会先 onopen 重置退避，之后再次断线才继续翻倍；
    // 这里不 onopen，直接让它断线，观察退避上限。
  }
  assert.equal(JSON.stringify(delays), JSON.stringify([500, 1000, 2000, 4000, 8000, 15000, 15000]))
})

// ── socketUrl ────────────────────────────────────────────────────────────
const socketUrl = api.socketUrl
const expected = 'ws://127.0.0.1:65301/api/dsh-browser-e2e/socket'

check('socketUrl: http 同源推导 ws', () => {
  assert.equal(socketUrl({ protocol: 'http:', host: '127.0.0.1:65301' }), expected)
})

check('socketUrl: https 推导 wss', () => {
  assert.equal(
    socketUrl({ protocol: 'https:', host: 'example.test:8443' }),
    'wss://example.test:8443/api/dsh-browser-e2e/socket',
  )
})

check('socketUrl: 非 http/https 时取 transport.streamBaseUrl 的 authority', () => {
  assert.equal(
    socketUrl({ protocol: 'file:' }, { streamBaseUrl: 'http://127.0.0.1:9001/base/path' }),
    'ws://127.0.0.1:9001/api/dsh-browser-e2e/socket',
  )
  assert.equal(
    socketUrl({ protocol: 'app:' }, { streamBaseUrl: 'https://host.local:9443/' }),
    'wss://host.local:9443/api/dsh-browser-e2e/socket',
  )
})

check('socketUrl: 取不到 authority 时返回 null', () => {
  assert.equal(socketUrl({ protocol: 'file:' }), null)
  assert.equal(socketUrl(undefined, undefined), null)
  assert.equal(socketUrl({ protocol: 'http:', host: '' }), null)
  assert.equal(socketUrl({ protocol: 'file:' }, { streamBaseUrl: 'not a url' }), null)
  assert.equal(socketUrl({ protocol: 'file:' }, { streamBaseUrl: 'ftp://127.0.0.1:1' }), null)
})

// ── parseEvent ───────────────────────────────────────────────────────────
const parseEvent = api.parseEvent

check('parseEvent: 合法事件返回对象', () => {
  const event = parseEvent(JSON.stringify({ v: 1, kind: 'frame', tabId: 'a', seq: 3, data: 'AA' }))
  assert.equal(event.kind, 'frame')
  assert.equal(event.seq, 3)
})

check('parseEvent: 非法输入返回 null', () => {
  assert.equal(parseEvent(''), null)
  assert.equal(parseEvent('not json'), null)
  assert.equal(parseEvent('"hello"'), null)
  assert.equal(parseEvent('[1,2,3]'), null)
  assert.equal(parseEvent('null'), null)
  assert.equal(parseEvent(JSON.stringify({ v: 1 })), null)
  assert.equal(parseEvent(JSON.stringify({ v: 2, kind: 'state' })), null)
  assert.equal(parseEvent(undefined), null)
})

// ── reduceEvent ──────────────────────────────────────────────────────────
const reduceEvent = api.reduceEvent
const emptyView = { state: null, frame: null, seqs: {}, error: null, action: null }

check('reduceEvent: hello/state 收敛成新 state', () => {
  const event = {
    v: 1,
    kind: 'state',
    state: {
      tabs: [{ id: 'tab-1', url: 'http://127.0.0.1:1/', title: '首页', loading: false }],
      activeTabId: 'tab-1',
      running: true,
      config: { quality: 55, maxWidth: 800, maxHeight: 600, everyNthFrame: 2 },
    },
  }
  const next = reduceEvent(emptyView, event)
  assert.equal(next.state.tabs.length, 1)
  assert.equal(next.state.activeTabId, 'tab-1')
  assert.equal(next.state.running, true)
  assert.equal(next.state.config.quality, 55)
  assert.equal(next.state.config.everyNthFrame, 2)

  const hello = reduceEvent(emptyView, { v: 1, kind: 'hello', state: event.state })
  assert.equal(hello.state.activeTabId, 'tab-1')
})

check('reduceEvent: 按 seq 丢弃旧帧、接受新帧', () => {
  const frame = (seq, data) => ({ v: 1, kind: 'frame', tabId: 'tab-1', seq, width: 640, height: 480, data })
  const first = reduceEvent(emptyView, frame(2, 'AAA'))
  assert.equal(first.frame.seq, 2)
  assert.equal(first.frame.data, 'AAA')
  assert.equal(first.frame.width, 640)

  const stale = reduceEvent(first, frame(2, 'OLD'))
  assert.equal(stale, first)
  const older = reduceEvent(first, frame(1, 'OLDER'))
  assert.equal(older, first)

  const newer = reduceEvent(first, frame(3, 'BBB'))
  assert.equal(newer.frame.seq, 3)
  assert.equal(newer.frame.data, 'BBB')
})

check('reduceEvent: 缺字段的 frame 被忽略', () => {
  const base = reduceEvent(emptyView, { kind: 'frame', tabId: 't', seq: 1, data: 'AA' })
  assert.equal(reduceEvent(base, { kind: 'frame', tabId: 't', seq: 2, data: '' }), base)
  assert.equal(reduceEvent(base, { kind: 'frame', tabId: '', seq: 2, data: 'BB' }), base)
})

check('reduceEvent: error 与 action 事件', () => {
  const errored = reduceEvent(emptyView, { kind: 'error', code: 'socket_closed', message: '连不上' })
  assert.equal(errored.error.code, 'socket_closed')
  assert.equal(errored.error.message, '连不上')

  const acted = reduceEvent(emptyView, { kind: 'action', trace: { tool: 'browser_e2e_click', summary: '点击 @1', at: 1 } })
  assert.equal(acted.action.tool, 'browser_e2e_click')
  assert.equal(acted.action.summary, '点击 @1')
})

check('reduceEvent: 未知事件原样返回', () => {
  assert.equal(reduceEvent(emptyView, { kind: 'unknown' }), emptyView)
  assert.equal(reduceEvent(emptyView, { kind: 'state', state: null }), emptyView)
})

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log('')
console.log(`SUMMARY: ${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
