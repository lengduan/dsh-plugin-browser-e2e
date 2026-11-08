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

check('apply 只向面板两个 slot 注入回调（设置页与插件卡片座位已移除）', () => {
  assert.equal(injected.length, 2)
  assert.equal(injected[0].name, 'sidebar.right.pane.tab')
  assert.equal(injected[1].name, 'sidebar.right.pane.tab.title')
})

check('座位注册：面板两个 slot 同 key 不同组件', () => {
  for (const item of injected) item.callback()
  assert.equal(registered.length, 2)
  assert.equal(registered[0].spec.name, 'sidebar.right.pane.tab')
  assert.equal(registered[1].spec.name, 'sidebar.right.pane.tab.title')
  assert.equal(registered[0].spec.key, 'dsh-browser-e2e')
  assert.equal(registered[1].spec.key, 'dsh-browser-e2e')
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(typeof registered[1].component, 'function')
  assert.notEqual(registered[0].component, registered[1].component)
})

check('slot 的 inject 回传 {sessionId, liveTitle}，两个 slot 共用一个标题通道', () => {
  const panelFace = registered[0].spec.inject('session-abc')
  const titleFace = registered[1].spec.inject('session-abc')
  assert.equal(panelFace.sessionId, 'session-abc')
  assert.equal(titleFace.sessionId, 'session-abc')
  assert.equal(panelFace.liveTitle, titleFace.liveTitle)
  assert.equal(typeof panelFace.liveTitle.get, 'function')
  assert.equal(typeof panelFace.liveTitle.set, 'function')
  assert.equal(typeof panelFace.liveTitle.subscribe, 'function')
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

/**
 * useSyncExternalStore 桩：读快照同步返回，订阅在一次渲染后装好；
 * store 通知时标记需要重渲染，由 renderPanel 的循环消费。
 */
reactStub.useSyncExternalStore = function (subscribe, getSnapshot) {
  const index = hooks.cursor
  hooks.cursor += 1
  hooks.pending.push({
    index,
    deps: [subscribe, getSnapshot],
    fn() {
      return subscribe(function () { hooks.dirty = true })
    },
  })
  return getSnapshot()
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
const titleProps = registered[1].spec.inject('session-abc')

/** 驱动一次渲染。 */
function render() {
  return renderPanel(panelComponent, panelProps)
}

/**
 * 渲染 chip：它与面板是两个不同的 slot 组件，假运行时的 hook 槽按组件隔离，
 * 否则 chip 的 hook 槽会读到面板遗留的状态。
 */
function renderChip(props) {
  const saved = {
    cursor: hooks.cursor,
    states: hooks.states,
    refs: hooks.refs,
    effects: hooks.effects,
    pending: hooks.pending,
    dirty: hooks.dirty,
  }
  hooks.cursor = 0
  hooks.states = []
  hooks.refs = []
  hooks.effects = {}
  hooks.pending = []
  hooks.dirty = false
  try {
    return renderPanel(titleComponent, props)
  } finally {
    hooks.cursor = saved.cursor
    hooks.states = saved.states
    hooks.refs = saved.refs
    hooks.effects = saved.effects
    hooks.pending = saved.pending
    hooks.dirty = saved.dirty
  }
}

/** 工具条里的历史切换按钮（data-dsh-part="history-toggle"）。 */
function historyToggle(root) {
  return findAll(findByPart(root, 'toolbar'), (node) => node.type === 'button'
    && node.props && node.props['data-dsh-part'] === 'history-toggle')[0]
}

/** 历史抽屉里的条目行（data-dsh-part="history-item"），从新到旧。 */
function historyItems(root) {
  return findAll(findByPart(root, 'history'), (node) => node.props && node.props['data-dsh-part'] === 'history-item')
}

/** 造一条 action 事件（载荷形状见协议表 PANEL_EVENTS.action）。 */
function actionEvent(tool, summary, at) {
  return { v: 1, kind: 'action', trace: { tool, summary, at } }
}

/**
 * 用独立的 hook 槽渲染一个全新面板实例：历史用例需要干净的动作数组，
 * 而主实例到用例 5 时已累积了动作。与 renderChip 同理，退出时恢复主实例的 hook 槽。
 */
function withFreshPanel(fn) {
  const saved = {
    cursor: hooks.cursor,
    states: hooks.states,
    refs: hooks.refs,
    effects: hooks.effects,
    pending: hooks.pending,
    dirty: hooks.dirty,
  }
  hooks.cursor = 0
  hooks.states = []
  hooks.refs = []
  hooks.effects = {}
  hooks.pending = []
  hooks.dirty = false
  try {
    return fn()
  } finally {
    hooks.cursor = saved.cursor
    hooks.states = saved.states
    hooks.refs = saved.refs
    hooks.effects = saved.effects
    hooks.pending = saved.pending
    hooks.dirty = saved.dirty
  }
}

/**
 * 在新的 hook 槽里渲染面板、连上它的 socket、点开历史抽屉。
 * liveTitle 用独立桩，避免新实例把共享标题通道改写成空串、影响后续 chip 用例。
 */
function openFreshHistoryPanel() {
  const freshLiveTitle = {
    get() { return '' },
    set() {},
    subscribe() { return function () {} },
  }
  const freshProps = { sessionId: 'session-abc', liveTitle: freshLiveTitle }
  let tree = renderPanel(panelComponent, freshProps)
  const freshSocket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  openSocket(freshSocket)
  historyToggle(tree).props.onClick()
  tree = renderPanel(panelComponent, freshProps)
  return {
    socket: freshSocket,
    render() {
      tree = renderPanel(panelComponent, freshProps)
      return tree
    },
    push(tool, summary, at) {
      pushEvent(freshSocket, actionEvent(tool, summary, at))
    },
  }
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

// ── 历史抽屉：工具条入口、空态与开合（此时还没有任何 action 事件）──────
check('历史抽屉：工具条有历史按钮', () => {
  const toggle = historyToggle(panelTree)
  assert.ok(toggle, '工具条应有 data-dsh-part="history-toggle" 的按钮')
  assert.equal(toggle.type, 'button')
  assert.ok(textOf(toggle).includes('历史'))
  assert.equal(toggle.props.title, '操作历史')
  assert.equal(toggle.props['aria-label'], '操作历史')
  assert.equal(toggle.props['aria-expanded'], 'false')
  assert.notEqual(toggle.props.disabled, true, '无动作时按钮不禁用')
})

check('历史抽屉：点击按钮展开抽屉', () => {
  historyToggle(panelTree).props.onClick()
  panelTree = render()
  assert.ok(findByPart(panelTree, 'history'), '应出现 data-dsh-part="history" 的抽屉')
  assert.equal(findByPart(panelTree, 'stage'), undefined, '抽屉打开时画面区应被替换')
  assert.equal(historyToggle(panelTree).props['aria-expanded'], 'true')
})

check('历史抽屉：没有动作时显示空态', () => {
  const history = findByPart(panelTree, 'history')
  const empty = findByPart(history, 'history-empty')
  assert.ok(empty, '无动作时应渲染 data-dsh-part="history-empty"')
  assert.ok(textOf(empty).includes('还没有动作'))
  assert.equal(historyItems(panelTree).length, 0)
  assert.ok(textOf(history).includes('共 0 条'), textOf(history))
  const close = findByPart(history, 'history-close')
  assert.ok(close, '抽屉内应有 history-close 按钮')
  assert.equal(close.type, 'button')
  assert.ok(textOf(close).includes('关闭'))
  assert.notEqual(close.props.disabled, true, '关闭按钮应可用')
})

check('历史抽屉：关闭后回到画面', () => {
  findByPart(panelTree, 'history-close').props.onClick()
  panelTree = render()
  assert.equal(findByPart(panelTree, 'history'), undefined)
  assert.ok(findByPart(panelTree, 'stage'))
  assert.equal(historyToggle(panelTree).props['aria-expanded'], 'false')
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
  // tab 标题透传；无标题时退回固定文案。每个 tab 末尾还有关闭按钮的 ×。
  assert.ok(textOf(tabButtons[0]).startsWith('首页'))
  assert.ok(textOf(tabButtons[1]).startsWith('浏览器画面'))
  assert.ok(textOf(tabButtons[1]).includes('加载中'))
  assert.equal(tabButtons[0].props['data-dsh-active'], 'true')
  assert.equal(tabButtons[1].props['data-dsh-active'], 'false')
  // 地址栏改成只读输入框：值即当前 URL，聚焦时全选便于复制。
  const urlInput = findAll(findByPart(panelTree, 'toolbar'), (node) => node.type === 'input')[0]
  assert.ok(urlInput)
  assert.equal(urlInput.props.value, 'http://127.0.0.1:19387/')
  assert.equal(urlInput.props.readOnly, true)
  assert.equal(typeof urlInput.props.onFocus, 'function')
  // 工具条带模式 chip（隔离 / CDP 接管）。
  assert.equal(findByPart(panelTree, 'mode').props['data-dsh-mode'], 'isolated')
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

// ── 复制画面到剪贴板（纯客户端，零协议）─────────────────────────────────
/** 工具条里的「复制画面」按钮（data-dsh-part="copy-frame"）。 */
function copyFrameButton(root) {
  return findAll(findByPart(root, 'toolbar'), (node) => node.type === 'button'
    && node.props && node.props['data-dsh-part'] === 'copy-frame')[0]
}

check('复制画面：工具条有复制按钮', () => {
  const button = copyFrameButton(panelTree)
  assert.ok(button, '工具条应有 data-dsh-part="copy-frame" 的按钮')
  assert.equal(button.type, 'button')
  assert.ok(textOf(button).includes('复制画面'))
  assert.equal(button.props['aria-label'], '复制画面到剪贴板')
  assert.ok(button.props.title.includes('复制画面到剪贴板'))
  assert.ok(button.props.title.includes('系统剪贴板'), button.props.title)
  // 位置在「历史」按钮之后。
  const buttons = findAll(findByPart(panelTree, 'toolbar'), (node) => node.type === 'button')
  const copyIndex = buttons.findIndex((node) => node.props['data-dsh-part'] === 'copy-frame')
  const historyIndex = buttons.findIndex((node) => node.props['data-dsh-part'] === 'history-toggle')
  assert.ok(historyIndex >= 0 && copyIndex === historyIndex + 1, '复制按钮应紧跟在历史按钮之后')
})

check('复制画面：无帧时按钮禁用', () => {
  withFreshPanel(() => {
    const emptyLiveTitle = { get() { return '' }, set() {}, subscribe() { return function () {} } }
    const tree = renderPanel(panelComponent, { sessionId: 'session-copy-empty', liveTitle: emptyLiveTitle })
    const button = copyFrameButton(tree)
    assert.ok(button)
    assert.equal(button.props.disabled, true, '没有帧时按钮应禁用')
    assert.ok(button.props.title.includes('暂无可复制的画面'), button.props.title)
  })
})

check('复制画面：有帧时按钮可用', () => {
  const button = copyFrameButton(panelTree)
  assert.ok(button)
  assert.equal(button.props.disabled, false)
})

check('复制画面：Clipboard API 不可用时显示失败提示', () => {
  // 桩环境没有 navigator.clipboard，点击后应在 errorBanner 位置给出一行失败提示。
  const before = socket.sent.length
  copyFrameButton(panelTree).props.onClick()
  panelTree = render()
  const banner = findByPart(panelTree, 'copy-error')
  assert.ok(banner, '应渲染 data-dsh-part="copy-error" 的失败提示')
  assert.ok(textOf(banner).includes('复制画面失败：'), textOf(banner))
  assert.equal(socket.sent.length, before, '复制画面不应发协议命令')
  assert.ok(!textOf(copyFrameButton(panelTree)).includes('已复制'))
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

check('点 tab 上的关闭按钮发 close-tab', () => {
  const tabBar = findByPart(panelTree, 'tabs')
  const closes = findAll(tabBar, (node) => node.props && node.props['data-dsh-part'] === 'tab-close')
  assert.equal(closes.length, 2)
  closes[1].props.onClick({ stopPropagation() {} })
  const closeCommand = JSON.parse(socket.sent[socket.sent.length - 1])
  assert.equal(closeCommand.kind, 'close-tab')
  assert.equal(closeCommand.tabId, 'tab-2')
})

check('设置卡片可展开，改 quality 发 configure', () => {
  const head = findButtonByText(panelTree, '画面设置')
  assert.ok(head)
  head.props.onClick()
  panelTree = render()
  // 工具条也有一个只读地址栏，这里只取设置卡片里的 4 个数值输入。
  const inputs = findAll(findByPart(panelTree, 'settings'), (node) => node.type === 'input')
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
  const updated = findAll(findByPart(panelTree, 'settings'), (node) => node.type === 'input')
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

check('动作提示只保留最近 5 条，新的在前', () => {
  for (let i = 0; i < 6; i += 1) {
    pushEvent(socket, { v: 1, kind: 'action', trace: { tool: 'browser_e2e_click', summary: `动作${i}`, at: 1000 + i } })
  }
  panelTree = render()
  const lines = findAll(findByPart(panelTree, 'actions'), (node) => node.props && node.props['data-dsh-part'] === 'action')
  assert.equal(lines.length, 5)
  assert.ok(textOf(lines[0]).includes('动作5'))
  assert.ok(!textOf(findByPart(panelTree, 'actions')).includes('动作0'))
})

check('历史抽屉：第 6 条动作只在抽屉里可见', () => {
  withFreshPanel(() => {
    const panel = openFreshHistoryPanel()
    for (let i = 1; i <= 6; i += 1) panel.push('browser_e2e_click', `第${i}条`, 1000 + i)
    const tree = panel.render()
    const inline = findAll(findByPart(tree, 'actions'), (node) => node.props && node.props['data-dsh-part'] === 'action')
    assert.equal(inline.length, 5, '内联动作提示仍只渲染前 5 条')
    const items = historyItems(tree)
    assert.equal(items.length, 6, '抽屉应收下第 6 条')
    assert.ok(!textOf(findByPart(tree, 'actions')).includes('第1条'), '最早的第 1 条不应出现在内联提示里')
    assert.ok(textOf(items[0]).includes('第6条'))
    assert.ok(textOf(items[5]).includes('第1条'))
  })
})

check('历史抽屉：抽屉保留最近 50 条并丢弃最旧', () => {
  withFreshPanel(() => {
    const panel = openFreshHistoryPanel()
    for (let i = 1; i <= 51; i += 1) panel.push('browser_e2e_click', `第${i}条`, 1000 + i)
    const tree = panel.render()
    const items = historyItems(tree)
    assert.equal(items.length, 50, '条目上限为 50')
    assert.ok(textOf(items[0]).includes('第51条'), '首条应是最新动作')
    assert.ok(textOf(items[49]).includes('第2条'), '末条应是最旧一条保留的动作')
    const drawerText = textOf(findByPart(tree, 'history'))
    assert.ok(!drawerText.includes('第1条'), '最旧动作应被丢弃')
    assert.ok(drawerText.includes('共 50 条'), drawerText)
  })
})

check('历史抽屉：新的在前', () => {
  withFreshPanel(() => {
    const panel = openFreshHistoryPanel()
    panel.push('browser_e2e_navigate', '打开首页', 1000)
    panel.push('browser_e2e_click', '点击 @1', 2000)
    const tree = panel.render()
    const items = historyItems(tree)
    assert.equal(items.length, 2)
    assert.ok(textOf(items[0]).includes('browser_e2e_click'))
    assert.ok(textOf(items[0]).includes('点击 @1'))
    assert.equal(items[0].props.title, 'browser_e2e_click：点击 @1')
    assert.ok(textOf(items[1]).includes('browser_e2e_navigate'))
  })
})

check('历史抽屉：action 不带 trace 时不记录', () => {
  withFreshPanel(() => {
    const panel = openFreshHistoryPanel()
    panel.push('browser_e2e_click', '点击 @1', 1000)
    let tree = panel.render()
    assert.equal(historyItems(tree).length, 1)
    pushEvent(panel.socket, { v: 1, kind: 'action' })
    tree = panel.render()
    assert.equal(historyItems(tree).length, 1, '无 trace 的 action 不应进入历史')
    assert.ok(textOf(findByPart(tree, 'history')).includes('共 1 条'))
  })
})

check('tab chip 显示 active tab 的页面标题', () => {
  const chip = renderChip(titleProps)
  assert.equal(chip.props['data-dsh-plugin'], 'browser-e2e')
  assert.equal(chip.props['data-dsh-part'], 'tab-title')
  assert.ok(textOf(chip).includes('首页'))
  assert.ok(!textOf(chip).includes('浏览器画面'))
  // 字形是独立组件，执行一次确认它返回 svg。
  const marks = findAll(chip, (node) => typeof node.type === 'function')
  assert.equal(marks.length, 1)
  const glyph = marks[0].type({})
  assert.equal(glyph.type, 'svg')
})

check('没有页面标题时 tab chip 回退「浏览器画面」', () => {
  const noState = renderChip(registered[1].spec.inject('session-unknown'))
  assert.ok(textOf(noState).includes('浏览器画面'))
})

check('标题变化后 tab chip 更新', () => {
  const nextState = {
    tabs: [
      { id: 'tab-1', url: 'http://127.0.0.1:19387/', title: '结算页', loading: false },
      { id: 'tab-2', url: 'http://127.0.0.1:19388/', title: '', loading: true },
    ],
    activeTabId: 'tab-1',
    running: true,
  }
  pushEvent(socket, { v: 1, kind: 'state', state: nextState })
  panelTree = render()
  const chip = renderChip(titleProps)
  assert.ok(textOf(chip).includes('结算页'))
  assert.ok(!textOf(chip).includes('首页'))
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

check('reduceEvent: state 的 mode / endpoint 归一', () => {
  const cdp = reduceEvent(emptyView, {
    v: 1,
    kind: 'state',
    state: {
      tabs: [{ id: 't', url: 'http://127.0.0.1:1/', title: '', loading: false, origin: 'adopted' }],
      activeTabId: 't',
      running: true,
      mode: 'cdp',
      endpoint: 'http://127.0.0.1:9222',
      config: {},
    },
  })
  assert.equal(cdp.state.mode, 'cdp')
  assert.equal(cdp.state.endpoint, 'http://127.0.0.1:9222')
  assert.equal(cdp.state.tabs[0].origin, 'adopted')
  const isolated = reduceEvent(emptyView, {
    v: 1, kind: 'state', state: { tabs: [], activeTabId: null, running: false, mode: 'isolated', endpoint: 'x', config: {} },
  })
  assert.equal(isolated.state.mode, 'isolated')
  assert.equal(isolated.state.endpoint, '')
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
