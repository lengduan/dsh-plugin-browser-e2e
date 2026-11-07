/**
 * 跨调用不变量与纯状态机的单元测试（不启动浏览器）。
 *
 * 覆盖：lib/invariants.js 的全部断言、lib/session.js 的状态转移表与 launch 落定/失败清理
 * （用假 chromium 注入，不启动浏览器）、lib/protocol.js 的 panelTabId 组合规则与投屏设置单一来源、
 * lib/client.js 注入块与协议表一致。
 *
 * 运行：node tests/invariants.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  assertBrowserRunning, assertCanCloseLastTab, assertCdpConnected, assertCdpContext, assertCdpHasPages,
  assertCurrentTabAvailable, assertEndpointNotHotSwitched, assertLaunchSettled, assertModeNotHotSwitched,
  assertNotClosedDuringLaunch, assertRefBelongsToTab, assertRefRevalidated, assertSingleScreencast, assertTabExists,
} from '../lib/invariants.js'
import {
  nextSessionState, SESSION_STATES, activeSessionKeys, close, closeAll, closeTab, launch, sessionOf, subscribePanelEvents,
  tabs,
} from '../lib/session.js'
import { createPage, navigate, titleOf } from '../lib/page.js'
import { captureJpeg } from '../lib/capture.js'
import {
  DEFAULT_SCREENCAST_CONFIG, PANEL_COMMANDS, PANEL_CONFIG_LIMITS, PANEL_ERROR_CODES, PANEL_EVENTS,
  PANEL_PROTOCOL_VERSION, PANEL_SOCKET_PATH, PANEL_STATE_PATH, isPanelCommand, isPanelErrorCode,
  isPanelEvent, isSupportedProtocol, panelTabId, parsePanelTabId,
} from '../lib/protocol.js'
import { HEADER, injectProtocol, readSource } from '../scripts/protocol-inject.mjs'
import { DEFAULT_CDP_ENDPOINT } from '../lib/defaults.js'

let pass = 0
let fail = 0

/** 跑一个用例：异常计 FAIL 并继续，保证一次跑完所有断言；用例可以是 async。 */
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        ${String((error && error.message) || error).split('\n').join('\n        ')}`)
  }
}

/** 造一个最小会话状态。 */
function makeSession(overrides = {}) {
  return {
    key: 'k',
    sessionId: 'k',
    state: 'ready',
    browser: {},
    context: {},
    pages: new Map(),
    activeTabId: null,
    ...overrides,
  }
}

console.log('== 用例 A：会话与标签页不变量 ==')
await check('有标签页时 assertBrowserRunning 通过', () => {
  const session = makeSession()
  session.pages.set('t1', { id: 't1' })
  assert.doesNotThrow(() => assertBrowserRunning(session))
})
await check('没有会话时 assertBrowserRunning 报「尚未启动」', () => {
  assert.throws(() => assertBrowserRunning(undefined), /浏览器尚未启动，请先调用 browser_e2e_start/)
  assert.throws(() => assertBrowserRunning(makeSession()), /浏览器尚未启动，请先调用 browser_e2e_start/)
})
await check('assertCurrentTabAvailable：active 存在才通过', () => {
  const session = makeSession({ activeTabId: 't1' })
  assert.throws(() => assertCurrentTabAvailable(session), /没有可用标签页/)
  session.pages.set('t1', { id: 't1' })
  assert.doesNotThrow(() => assertCurrentTabAvailable(session))
  session.activeTabId = 't2'
  assert.throws(() => assertCurrentTabAvailable(session), /没有可用标签页/)
})
await check('assertTabExists 返回条目，缺失时报「不存在」', () => {
  const session = makeSession()
  const entry = { id: 't1', page: {} }
  session.pages.set('t1', entry)
  assert.equal(assertTabExists(session, 't1'), entry)
  assert.throws(() => assertTabExists(session, 't9'), /tab t9 不存在/)
})
await check('assertCanCloseLastTab：只剩一个时报错', () => {
  const session = makeSession()
  session.pages.set('t1', { id: 't1' })
  assert.throws(() => assertCanCloseLastTab(session), /最后一个标签页/)
  session.pages.set('t2', { id: 't2' })
  assert.doesNotThrow(() => assertCanCloseLastTab(session))
})

console.log('== 用例 B：启动/关闭状态不变量 ==')
await check('assertNotClosedDuringLaunch：closing / closed 报并发关闭', () => {
  assert.doesNotThrow(() => assertNotClosedDuringLaunch(makeSession({ state: 'launching' })))
  assert.doesNotThrow(() => assertNotClosedDuringLaunch(makeSession({ state: 'ready' })))
  assert.throws(() => assertNotClosedDuringLaunch(makeSession({ state: 'closing' })), /启动与关闭并发/)
  assert.throws(() => assertNotClosedDuringLaunch(makeSession({ state: 'closed' })), /启动与关闭并发/)
})
await check('assertLaunchSettled：没有浏览器时报启动失败', () => {
  assert.doesNotThrow(() => assertLaunchSettled(makeSession({ browser: {} })))
  assert.throws(() => assertLaunchSettled(makeSession({ browser: null })), /并发启动未成功/)
})
await check('assertModeNotHotSwitched：不一致的两个方向都报错', () => {
  assert.doesNotThrow(() => assertModeNotHotSwitched('isolated', 'isolated'))
  assert.doesNotThrow(() => assertModeNotHotSwitched('cdp', 'cdp'))
  assert.throws(() => assertModeNotHotSwitched('isolated', 'cdp'), /如需切换为 cdp 模式请先 browser_e2e_close/)
  assert.throws(() => assertModeNotHotSwitched('cdp', 'isolated'), /如需切换为 isolated 模式请先 browser_e2e_close/)
})
await check('createPage：CDP 断连时抛友好错误而不是 Target closed', async () => {
  const session = {
    browser: { isConnected: () => false },
    mode: 'cdp',
    context: {
      newPage: async () => {
        throw new Error('Target closed')
      },
    },
  }
  await assert.rejects(() => createPage(session), /CDP 浏览器连接已失效/)
})

await check('assertEndpointNotHotSwitched：端点不一致报错并带两端点', () => {
  assert.doesNotThrow(() => assertEndpointNotHotSwitched('http://127.0.0.1:9222', 'http://127.0.0.1:9222'))
  assert.throws(
    () => assertEndpointNotHotSwitched('http://127.0.0.1:9222', 'http://127.0.0.1:9333'),
    /CDP 端点 http:\/\/127\.0\.0\.1:9222.*http:\/\/127\.0\.0\.1:9333/,
  )
})
await check('CDP 三条不变量各自报原文案', () => {
  assert.doesNotThrow(() => assertCdpConnected(makeSession({ context: {} })))
  assert.doesNotThrow(() => assertCdpConnected(makeSession({ context: {} }), true))
  assert.doesNotThrow(() => assertCdpConnected(makeSession({ context: {} }), undefined))
  assert.throws(() => assertCdpConnected(makeSession({ context: {} }), false), /CDP 浏览器连接已失效/)
  assert.throws(() => assertCdpConnected(makeSession({ context: null })), /CDP 浏览器连接已失效/)
  assert.doesNotThrow(() => assertCdpContext({}))
  assert.throws(() => assertCdpContext(null), /没有可用的 context/)
  assert.doesNotThrow(() => assertCdpHasPages([{}]))
  assert.throws(() => assertCdpHasPages([]), /没有已打开的标签页/)
})

console.log('== 用例 C：ref 表不变量 ==')
await check('assertRefBelongsToTab 按页隔离：别的页 ref 不存在', () => {
  const refsA = new Map([['@0', { xpath: '/html/body/button[1]' }]])
  const item = assertRefBelongsToTab(refsA, '@0')
  assert.equal(item.xpath, '/html/body/button[1]')
  const refsB = new Map()
  assert.throws(() => assertRefBelongsToTab(refsB, '@0'), /ref @0 不存在/)
})
await check('assertRefRevalidated：未命中与零尺寸是两种文案', () => {
  assert.doesNotThrow(() => assertRefRevalidated('@1', { found: true, width: 10, height: 20 }))
  assert.throws(() => assertRefRevalidated('@1', { found: false, width: 0, height: 0 }), /ref @1 已失效，请重新 browser_e2e_snapshot/)
  assert.throws(() => assertRefRevalidated('@1', { found: true, width: 0, height: 20 }), /不可见.*请重新 browser_e2e_snapshot/)
})
await check('assertSingleScreencast：已有 CDP 会话时报串台', () => {
  assert.doesNotThrow(() => assertSingleScreencast(null))
  assert.throws(() => assertSingleScreencast({}), /只能有一个投屏会话/)
})

console.log('== 用例 D：会话状态机（纯转移函数）==')
await check('状态全集为 idle / launching / ready / closing / closed', () => {
  assert.equal(JSON.stringify(SESSION_STATES), JSON.stringify(['idle', 'launching', 'ready', 'closing', 'closed']))
})
await check('合法转移逐条命中', () => {
  const legal = [
    ['idle', 'launch', 'launching'],
    ['idle', 'close', 'closed'],
    ['launching', 'launchSettled', 'ready'],
    ['launching', 'launchFailed', 'idle'],
    ['launching', 'close', 'closing'],
    ['ready', 'close', 'closing'],
    ['closing', 'closeSettled', 'closed'],
  ]
  for (const [from, event, to] of legal) {
    assert.equal(nextSessionState(from, event), to, `${from} --${event}--> ${to}`)
  }
})
await check('非法转移抛错（含终态 closed）', () => {
  const illegal = [
    ['idle', 'launchSettled'],
    ['idle', 'launchFailed'],
    ['idle', 'closeSettled'],
    ['launching', 'launch'],
    ['launching', 'closeSettled'],
    ['ready', 'launch'],
    ['ready', 'launchSettled'],
    ['ready', 'launchFailed'],
    ['ready', 'closeSettled'],
    ['closing', 'close'],
    ['closing', 'launch'],
    ['closing', 'launchSettled'],
    ['closing', 'launchFailed'],
    ['closed', 'launch'],
    ['closed', 'close'],
    ['closed', 'closeSettled'],
    ['closed', 'launchSettled'],
    ['closed', 'launchFailed'],
  ]
  for (const [from, event] of illegal) {
    assert.throws(() => nextSessionState(from, event), /非法会话状态转移/, `${from} --${event} 应非法`)
  }
})
await check('未知状态报错', () => {
  assert.throws(() => nextSessionState('booting', 'launch'), /未知会话状态 booting/)
})

console.log('== 用例 E：面板协议契约（protocol.js 单一来源）==')
await check('panelTabId 组合与拆分可往返', () => {
  assert.equal(panelTabId('session-a', 't1'), 'session-a#t1')
  assert.deepEqual(parsePanelTabId('session-a#t1'), { key: 'session-a', tabId: 't1' })
  // 以最后一个分隔符为界：key 自身含分隔符也能正确拆分（tabId 不含分隔符）。
  assert.deepEqual(parsePanelTabId('a#b#t1'), { key: 'a#b', tabId: 't1' })
  assert.deepEqual(parsePanelTabId(panelTabId('k#x', 't1')), { key: 'k#x', tabId: 't1' })
})
await check('panelTabId 非法格式返回 null', () => {
  assert.equal(parsePanelTabId('#t1'), null)
  assert.equal(parsePanelTabId('session-a#'), null)
  assert.equal(parsePanelTabId('no-separator'), null)
  assert.equal(parsePanelTabId(''), null)
  assert.equal(parsePanelTabId(undefined), null)
  assert.equal(parsePanelTabId(123), null)
})
await check('命令表与事件表是协议的唯一来源', () => {
  assert.deepEqual(Object.values(PANEL_COMMANDS).sort(), ['attach', 'close-tab', 'configure', 'request-frame', 'select-tab'])
  assert.deepEqual(Object.values(PANEL_EVENTS).sort(), ['action', 'error', 'frame', 'hello', 'state'])
  assert.equal(isPanelCommand('attach'), true)
  assert.equal(isPanelCommand('select-tab'), true)
  assert.equal(isPanelCommand('no-such-command'), false)
  assert.equal(isPanelEvent('frame'), true)
  assert.equal(isPanelEvent('no-such-event'), false)
})
await check('错误码表是 error.code 的唯一来源，isPanelErrorCode 只认表内 code', () => {
  assert.deepEqual(Object.values(PANEL_ERROR_CODES).sort(), [
    'capture-failed', 'close-tab-failed', 'command-failed', 'config-sync-failed', 'invalid-command',
    'invalid-config', 'invalid-payload', 'last-tab', 'no-active-tab', 'protocol-mismatch',
    'screencast-failed', 'state-failed', 'unknown-tab',
  ])
  for (const code of Object.values(PANEL_ERROR_CODES)) {
    assert.equal(isPanelErrorCode(code), true, `${code} 应在表内`)
  }
  assert.equal(isPanelErrorCode('no-such-code'), false)
  assert.equal(isPanelErrorCode(''), false)
  assert.equal(isPanelErrorCode(undefined), false)
})
await check('host 源码不手写错误码字面量（panel.js / session.js / screencast.js）', () => {
  const quoted = new RegExp(`['"\`](${Object.values(PANEL_ERROR_CODES).join('|')})['"\`]`)
  for (const file of ['panel.js', 'session.js', 'screencast.js']) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8')
    assert.ok(!quoted.test(source), `lib/${file} 不应手写错误码字面量（应从 PANEL_ERROR_CODES 取）`)
    assert.ok(source.includes('PANEL_ERROR_CODES'), `lib/${file} 应从 protocol.js 取错误码`)
  }
})
await check('协议版本与路径', () => {
  assert.equal(isSupportedProtocol(PANEL_PROTOCOL_VERSION), true)
  assert.equal(isSupportedProtocol(PANEL_PROTOCOL_VERSION + 1), false)
  assert.equal(isSupportedProtocol('1'), false)
  assert.equal(PANEL_SOCKET_PATH, '/api/dsh-browser-e2e/socket')
  assert.equal(PANEL_STATE_PATH, '/api/dsh-browser-e2e/state')
})
await check('投屏区间与默认值自洽（默认值逐项落在区间内）', () => {
  for (const [field, [min, max]] of Object.entries(PANEL_CONFIG_LIMITS)) {
    const value = DEFAULT_SCREENCAST_CONFIG[field]
    assert.ok(Number.isInteger(value) && value >= min && value <= max, `${field}=${value} 不在 [${min}, ${max}]`)
  }
  assert.deepEqual(DEFAULT_SCREENCAST_CONFIG, { quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
})

console.log('== 用例 F：client bundle 的协议常量由 protocol.js 注入 ==')
const clientSource = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
await check('client 源文件只留注入标记，不手写区间与默认值', () => {
  assert.ok(clientSource.includes('/* @inject:panel-protocol:start */'))
  assert.ok(clientSource.includes('/* @inject:panel-protocol:end */'))
  assert.ok(!clientSource.includes('/api/dsh-browser-e2e/socket'), 'client 源文件不应手写 socket 路径')
  assert.ok(!/const PROTOCOL_VERSION = \d+;/.test(clientSource), 'client 源文件不应手写协议版本')
  assert.ok(!/const DEFAULT_CONFIG = \{/.test(clientSource), 'client 源文件不应手写投屏默认值')
})
await check('client 源文件不手写命令 / 事件名', () => {
  assert.ok(!/kind:\s*["'](attach|select-tab|close-tab|request-frame|configure)["']/.test(clientSource),
    'client 源文件不应手写命令名')
  assert.ok(!/kind:\s*["'](hello|state|frame|action|error)["']/.test(clientSource),
    'client 源文件不应手写事件名')
  assert.ok(!/event\.kind\s*===\s*["']/.test(clientSource), 'client 源文件不应手写事件名比较')
})
await check('生成的 bundle 常量与 protocol.js 逐字段一致', () => {
  const readBlock = (pattern) => {
    const match = pattern.exec(bundle)
    assert.ok(match, 'bundle 缺少常量：' + pattern)
    return match[1]
  }
  assert.equal(Number(readBlock(/const PROTOCOL_VERSION = (\d+);/)), PANEL_PROTOCOL_VERSION)
  assert.equal(JSON.parse(readBlock(/const WS_PATH = ("[^"]*");/)), PANEL_SOCKET_PATH)
  assert.deepEqual(JSON.parse(readBlock(/const PANEL_CONFIG_LIMITS = (\{.*?\});/)), PANEL_CONFIG_LIMITS)
  assert.deepEqual(JSON.parse(readBlock(/const DEFAULT_CONFIG = (\{.*?\});/)), DEFAULT_SCREENCAST_CONFIG)
  assert.deepEqual(JSON.parse(readBlock(/const PANEL_COMMANDS = Object\.freeze\((\{.*?\})\);/)), PANEL_COMMANDS)
  assert.deepEqual(JSON.parse(readBlock(/const PANEL_EVENTS = Object\.freeze\((\{.*?\})\);/)), PANEL_EVENTS)
  assert.ok(bundle.startsWith('/* 由 scripts/build-client.mjs 生成，勿手改'))
})
await check('源码 ↔ 产物一致：injectProtocol(readSource()) 即 lib/client.js 全文', () => {
  const expected = HEADER + injectProtocol(readSource())
  const normalized = expected.endsWith('\n') ? expected : expected + '\n'
  assert.equal(bundle, normalized)
})
await check('默认 CDP 端点单源：bundle 注入值等于 lib/defaults.js，client 源文件不手写 9222', () => {
  const injected = /const DEFAULT_CDP_ENDPOINT = ("[^"]*");/.exec(bundle)
  assert.ok(injected, 'bundle 缺少 DEFAULT_CDP_ENDPOINT')
  assert.equal(JSON.parse(injected[1]), DEFAULT_CDP_ENDPOINT)
  assert.ok(!clientSource.includes('9222'), 'client 源文件不应手写默认 CDP 端点')
})
await check('client 不依赖规格外的 state.message 字段', () => {
  assert.ok(!/state\s*&&\s*state\.message|state\.message/.test(clientSource),
    'client 源文件不应读取 state.message')
  assert.ok(!bundle.includes('state.message'), '产物也不应含 state.message')
})
await check('默认 CDP 端点宿主侧取自 lib/defaults.js（session / index 不各写一份）', () => {
  const sessionSource = readFileSync(new URL('../lib/session.js', import.meta.url), 'utf8')
  const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(sessionSource.includes("from './defaults.js'"), 'session.js 应从 defaults.js 取默认端点')
  assert.ok(indexSource.includes("from './defaults.js'"), 'index.js 应从 defaults.js 取默认端点')
  assert.ok(!sessionSource.includes('127.0.0.1:9222'), 'session.js 不应手写默认端点')
  assert.ok(!indexSource.includes('127.0.0.1:9222'), 'index.js 不应手写默认端点（含描述文案）')
  assert.ok(indexSource.includes('DEFAULT_CDP_ENDPOINT'), 'index.js 的 Config 默认值应使用常量')
})

console.log('== 用例 G：launch 落定与失败清理（假 chromium，不起 Edge）==')

/**
 * 假 page：接口满足 addPage / attachPageHooks / reuseInfo 的最小需求。
 * on / emit 让测试能触发页面层监听（例如 page.on('close')），与真实事件回调一致。
 */
function fakePage(overrides = {}) {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args)
    },
    close: async () => {},
    evaluate: async () => 'complete',
    url: () => 'about:blank',
    title: async () => '',
    viewportSize: () => ({ width: 1600, height: 900 }),
    context: () => ({ newCDPSession: async () => ({}) }),
    ...overrides,
  }
}

/** 假 browser：version / process / close 供 reuseInfo 与清理路径使用，closeCalls 记录关闭次数。 */
function fakeBrowser(overrides = {}) {
  const browser = {
    closeCalls: 0,
    version: () => '0.0.0-fake',
    process: () => ({ kill() {} }),
    close: async () => {
      browser.closeCalls += 1
    },
    ...overrides,
  }
  return browser
}

/** 假 chromium：只实现 launch / connectOverCDP 两个入口。 */
function fakeChromium({ launch, connectOverCDP } = {}) {
  return {
    launch: async () => launch(),
    connectOverCDP: async () => connectOverCDP(),
  }
}

/** 假 CDP context：pages() 与 on() 供接管路径使用。 */
function fakeContext(pages) {
  return { pages: () => pages, on() {} }
}

await check('隔离模式 newPage 抛错：launch 失败、状态回 idle 并关闭浏览器', async () => {
  const browser = fakeBrowser({
    newPage: async () => {
      throw new Error('newPage 失败（模拟）')
    },
  })
  const chromium = fakeChromium({ launch: () => browser })
  await assert.rejects(
    () => launch('g-isolated-fail', {}, undefined, {}, { chromium }),
    /newPage 失败（模拟）/,
  )
  const session = sessionOf('g-isolated-fail')
  assert.equal(session.state, 'idle')
  assert.equal(session.browser, null)
  assert.equal(session.context, null)
  assert.equal(session.pages.size, 0)
  assert.equal(browser.closeCalls, 1)
})
await check('失败后同一 key 换正常 chromium 可重新启动到 ready', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  const result = await launch('g-isolated-fail', {}, undefined, {}, { chromium })
  const session = sessionOf('g-isolated-fail')
  assert.equal(session.state, 'ready')
  assert.equal(session.pages.size, 1)
  assert.equal(result.reused, false)
  assert.equal(result.tabs, 1)
})
await check('CDP 模式没有 context：报错、回 idle 并断开连接', async () => {
  const browser = fakeBrowser({ contexts: () => [] })
  const chromium = fakeChromium({ connectOverCDP: () => browser })
  await assert.rejects(
    () => launch('g-cdp-no-context', { mode: 'cdp' }, undefined, {}, { chromium }),
    /没有可用的 context/,
  )
  const session = sessionOf('g-cdp-no-context')
  assert.equal(session.state, 'idle')
  assert.equal(session.browser, null)
  assert.equal(browser.closeCalls, 1)
})
await check('CDP 模式没有已打开标签页：报错、回 idle 并断开连接', async () => {
  const browser = fakeBrowser({ contexts: () => [fakeContext([])] })
  const chromium = fakeChromium({ connectOverCDP: () => browser })
  await assert.rejects(
    () => launch('g-cdp-no-pages', { mode: 'cdp' }, undefined, {}, { chromium }),
    /没有已打开的标签页/,
  )
  const session = sessionOf('g-cdp-no-pages')
  assert.equal(session.state, 'idle')
  assert.equal(session.browser, null)
  assert.equal(browser.closeCalls, 1)
})
await check('隔离模式正常启动：ready + 1 个标签页', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  const result = await launch('g-isolated-ok', {}, undefined, {}, { chromium })
  const session = sessionOf('g-isolated-ok')
  assert.equal(session.state, 'ready')
  assert.equal(session.pages.size, 1)
  assert.equal(result.tabs, 1)
})
await check('复用路径 0 标签页（isolated）：自动补建一页并返回成功', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-reuse-isolated', {}, undefined, {}, { chromium })
  const session = sessionOf('g-reuse-isolated')
  session.pages.clear()
  session.activeTabId = null
  const result = await launch('g-reuse-isolated')
  assert.equal(result.reused, true)
  assert.ok(result.tabs >= 1, `tabs=${result.tabs}`)
  assert.equal(session.pages.size, 1)
  assert.equal(session.state, 'ready')
  assert.equal(browser.closeCalls, 0)
})
await check('复用路径 0 标签页（cdp）：抛可诊断错误而不是静默成功', async () => {
  const browser = fakeBrowser({ contexts: () => [fakeContext([fakePage()])] })
  const chromium = fakeChromium({ connectOverCDP: () => browser })
  await launch('g-reuse-cdp', { mode: 'cdp' }, undefined, {}, { chromium })
  const session = sessionOf('g-reuse-cdp')
  session.pages.clear()
  session.activeTabId = null
  await assert.rejects(
    () => launch('g-reuse-cdp'),
    /CDP 浏览器已没有打开的标签页，请在浏览器里新建标签页，或先 browser_e2e_close 再重新 browser_e2e_start/,
  )
  assert.equal(session.state, 'ready')
})
await check('复用路径 0 标签页（isolated）补建失败：拒绝、收掉浏览器并摘除会话', async () => {
  let failNewPage = false
  const browser = fakeBrowser({
    newPage: async () => {
      if (failNewPage) throw new Error('补建页面失败（模拟）')
      return fakePage()
    },
  })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-reuse-isolated-fail', {}, undefined, {}, { chromium })
  const session = sessionOf('g-reuse-isolated-fail')
  session.pages.clear()
  session.activeTabId = null
  failNewPage = true
  await assert.rejects(
    () => launch('g-reuse-isolated-fail'),
    /补建页面失败（模拟）/,
  )
  assert.equal(browser.closeCalls, 1, '补建失败必须收掉浏览器')
  assert.equal(session.state, 'closed')
  assert.ok(!activeSessionKeys().includes('g-reuse-isolated-fail'), '会话注册表不应残留该 key')
})
await check('失败清理期间被 close：终态 closed，不被启动落定覆写为 idle', async () => {
  let releaseClose = () => {}
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve
  })
  const browser = fakeBrowser({
    newPage: async () => {
      throw new Error('newPage 失败（模拟）')
    },
    close: async () => {
      browser.closeCalls += 1
      await closeGate
    },
  })
  const chromium = fakeChromium({ launch: () => browser })
  const launchPromise = launch('g-fail-close-race', {}, undefined, {}, { chromium }).catch((error) => error)
  const session = sessionOf('g-fail-close-race')
  // 等 launch 进入失败清理、close 被调用且还没 resolve。
  for (let i = 0; i < 400 && browser.closeCalls === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(browser.closeCalls, 1, 'launch 应已进入失败清理')
  const closePromise = close('g-fail-close-race')
  assert.equal(session.state, 'closing')
  releaseClose()
  const error = await launchPromise
  assert.match(String(error && error.message), /newPage 失败（模拟）/)
  await closePromise
  assert.equal(session.state, 'closed')
})
await check('已广播 opened 后启动失败：补广播同 key 的 closed 事件', async () => {
  const events = []
  const unsubscribe = subscribePanelEvents((event) => events.push(event))
  try {
    const browser = fakeBrowser({
      contexts: () => [fakeContext([fakePage()])],
      version: () => {
        throw new Error('version 失败（模拟）')
      },
    })
    const chromium = fakeChromium({ connectOverCDP: () => browser })
    await assert.rejects(
      () => launch('g-opened-failed', { mode: 'cdp' }, undefined, {}, { chromium }),
      /version 失败（模拟）/,
    )
    assert.deepEqual(
      events
        .filter((event) => event.key === 'g-opened-failed' && (event.type === 'opened' || event.type === 'closed'))
        .map((event) => event.type),
      ['opened', 'closed'],
    )
    assert.equal(sessionOf('g-opened-failed').state, 'idle')
  } finally {
    unsubscribe()
  }
})

await check('launch 遇到非法 mode 显式报错，不静默降级为 isolated', async () => {
  const chromium = fakeChromium({
    launch: async () => {
      throw new Error('不应被调用')
    },
  })
  await assert.rejects(
    () => launch('g-bad-mode', { mode: 'cdpp' }, undefined, {}, { chromium }),
    /mode 只支持 isolated \/ cdp/,
  )
  assert.ok(!activeSessionKeys().includes('g-bad-mode'), '非法 mode 不应登记会话')
})
await check('closeTab 关最后一个页：抛结构化 last-tab 错误且页仍在', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-close-last', {}, undefined, {}, { chromium })
  const error = await closeTab('g-close-last', 't1').catch((thrown) => thrown)
  assert.equal(error?.code, 'last-tab')
  assert.match(String(error.message), /最后一个标签页/)
  assert.equal(sessionOf('g-close-last').pages.size, 1)
})

await check('并发 closeTab 两页：恰好一成一败，会话仍保留 1 页', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-close-race-two', {}, undefined, {}, { chromium })
  const session = sessionOf('g-close-race-two')
  session.pages.set('t2', {
    id: 't2',
    page: fakePage(),
    refs: new Map(),
    consoleRing: [],
    networkRing: [],
    networkByRequest: new Map(),
    loading: false,
    origin: 'created',
  })
  const results = await Promise.allSettled([closeTab('g-close-race-two', 't1'), closeTab('g-close-race-two', 't2')])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
  assert.equal(session.pages.size, 1)
  assert.ok(session.activeTabId !== null)
})
await check('只剩一页时并发 closeTab 同一页：至少一个 rejected，页仍保留', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-close-race-one', {}, undefined, {}, { chromium })
  const session = sessionOf('g-close-race-one')
  const results = await Promise.allSettled([closeTab('g-close-race-one', 't1'), closeTab('g-close-race-one', 't1')])
  assert.ok(results.some((item) => item.status === 'rejected'))
  assert.equal(session.pages.size, 1)
})

// 清空会话注册表，避免假会话影响后续用例与进程退出。
await closeAll()
await check('用例 G 结束：会话注册表已清空', () => {
  assert.deepEqual(activeSessionKeys(), [])
})

console.log('== 用例 H：ready 允许 0 页（方案 C）与复用分支并发 close ==')
await check('关闭唯一页后：state 仍 ready、pages 为 0，tabs / navigate 报「尚未启动」，复用 start 补建一页', async () => {
  const browser = fakeBrowser({ newPage: async () => fakePage() })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-ready-zero-page', {}, undefined, {}, { chromium })
  const session = sessionOf('g-ready-zero-page')
  const firstPage = session.pages.get('t1')?.page
  assert.ok(firstPage, '启动后应有标签页 t1')
  // 走页面层真实的 close 回调：只 removePage，不写 session.state。
  firstPage.emit('close')
  assert.equal(session.pages.size, 0)
  assert.equal(session.activeTabId, null)
  assert.equal(session.state, 'ready', '标签页归零不改会话状态')
  await assert.rejects(() => tabs('g-ready-zero-page'), /浏览器尚未启动，请先调用 browser_e2e_start/)
  await assert.rejects(
    () => navigate(session, 'about:blank'),
    /浏览器尚未启动，请先调用 browser_e2e_start/,
  )
  // 复用路径（隔离模式）补建一页后成功返回，浏览器没有被收掉。
  const result = await launch('g-ready-zero-page')
  assert.equal(result.reused, true)
  assert.equal(result.tabs, 1)
  assert.equal(session.pages.size, 1)
  assert.ok(session.pages.has(session.activeTabId), 'activeTabId 应指向补建出的页')
  assert.equal(session.state, 'ready')
  assert.equal(browser.closeCalls, 0)
})

await check('复用分支与 close 并发：close 先生效时 launch 只能抛并发关闭错误，不返回 reused:true', async () => {
  let releaseNewPage = () => {}
  const newPageGate = new Promise((resolve) => {
    releaseNewPage = resolve
  })
  let newPageCalls = 0
  const browser = fakeBrowser({
    newPage: async () => {
      newPageCalls += 1
      // 首次启动直接返回页；复用分支的补建页停在 gate 上，制造「补建中」的窗口。
      if (newPageCalls > 1) await newPageGate
      return fakePage()
    },
  })
  const chromium = fakeChromium({ launch: () => browser })
  await launch('g-reuse-close-race', {}, undefined, {}, { chromium })
  const session = sessionOf('g-reuse-close-race')
  session.pages.clear()
  session.activeTabId = null
  // 复用分支进入补建页的 await；落定信号此时已建立。
  const launchOutcome = launch('g-reuse-close-race').then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  )
  const closePromise = close('g-reuse-close-race')
  // close 的同步段已把会话从 registry 摘除，而 launch 还没返回。
  assert.ok(!activeSessionKeys().includes('g-reuse-close-race'))
  releaseNewPage()
  const outcome = await launchOutcome
  await closePromise
  // 接受的结果只有一种：rejected（并发关闭错误）。fulfilled（reused:true）即假成功。
  assert.equal(outcome.status, 'rejected', `close 生效后 launch 不得成功返回：${JSON.stringify(outcome.value)}`)
  assert.match(String(outcome.error?.message), /浏览器已关闭（(?:复用|启动)与关闭并发）/)
  assert.equal(session.state, 'closed')
  assert.equal(session.pages.size, 0, '补建出的页不应登记到已关闭的会话')
})

console.log('== 用例 I：page.js 标题兜底 ==')
await check('titleOf：标题先返回时清掉 400ms 兜底定时器', async () => {
  const cleared = []
  const realClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = (timer) => {
    cleared.push(timer)
    return realClearTimeout(timer)
  }
  try {
    assert.equal(await titleOf({ title: async () => '页面标题' }), '页面标题')
    assert.equal(cleared.length, 1, '标题正常返回后应清掉兜底定时器')
  } finally {
    globalThis.clearTimeout = realClearTimeout
  }
})

await check('titleOf：标题超时返回空串，同样清理定时器', async () => {
  const cleared = []
  const realClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = (timer) => {
    cleared.push(timer)
    return realClearTimeout(timer)
  }
  try {
    const pending = new Promise(() => {})
    // titleOf 的兜底定时器 unref 过，单独等它会让事件循环空转退出；
    // 并行持一个 ref 的 500ms 定时器，保证 400ms 兜底分支真的被跑到。
    let title
    await Promise.all([
      titleOf({ title: () => pending }).then((value) => { title = value }),
      new Promise((resolve) => { setTimeout(resolve, 500) }),
    ])
    assert.equal(title, '')
    assert.equal(cleared.length, 1, '超时分支也应清掉已触发的定时器句柄')
  } finally {
    globalThis.clearTimeout = realClearTimeout
  }
})

console.log('== 用例 J：captureJpeg 默认质量单一来源 ==')
await check('captureJpeg：未传 quality 时取 DEFAULT_SCREENCAST_CONFIG.quality', async () => {
  const calls = []
  const fakePage = {
    screenshot: async (options) => {
      calls.push(options)
      return Buffer.alloc(0)
    },
    viewportSize: () => ({ width: 10, height: 10 }),
  }
  const frame = await captureJpeg(fakePage)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].type, 'jpeg')
  assert.equal(calls[0].quality, DEFAULT_SCREENCAST_CONFIG.quality,
    `默认质量应取协议表 ${DEFAULT_SCREENCAST_CONFIG.quality}，实际 ${calls[0].quality}`)
  assert.equal(frame.width, 10)
  assert.equal(frame.height, 10)
})

await check('capture.js 的默认质量来自 protocol.js，没有写死数字', () => {
  const source = readFileSync(new URL('../lib/capture.js', import.meta.url), 'utf8')
  assert.ok(source.includes("from './protocol.js'"), 'capture.js 应 import protocol.js')
  assert.ok(source.includes('DEFAULT_SCREENCAST_CONFIG.quality'), '默认质量应取自协议表')
  assert.ok(!/Number\.isInteger\(options\.quality\)\s*\?\s*options\.quality\s*:\s*\d+/.test(source),
    'captureJpeg 不应把默认质量写成数字字面量')
})

await check('captureJpeg：显式 quality 优先于默认值', async () => {
  const calls = []
  const fakePage = {
    screenshot: async (options) => {
      calls.push(options)
      return Buffer.alloc(0)
    },
    viewportSize: () => null,
  }
  await captureJpeg(fakePage, { quality: 42 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].quality, 42)
})

console.log('== 用例 K：tools.js 描述常量单源 ==')
await check('tools.js 的工具描述从常量插值，不写死默认值', () => {
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('http://127.0.0.1:9222'), 'CDP 默认端点应取自 defaults.js')
  assert.ok(!/\b(1600|900|9222|4000|8192|4194304|500)\b/.test(source),
    '视口 / 端点 / 快照 / 截图 / 缓冲上限不应写成数字字面量')
  for (const name of [
    'DEFAULT_VIEWPORT.width', 'DEFAULT_VIEWPORT.height', 'DEFAULT_CDP_ENDPOINT',
    'SNAPSHOT_LIMIT', 'MAX_SHOT_EDGE', 'MAX_SHOT_PIXELS', 'RING_LIMIT',
  ]) {
    assert.ok(source.includes(name), `tools.js 应引用 ${name}`)
  }
})

await closeAll()
await check('收尾检查：会话注册表已清空', () => {
  assert.deepEqual(activeSessionKeys(), [])
})

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
