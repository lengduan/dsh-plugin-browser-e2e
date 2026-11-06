/**
 * 跨调用不变量与纯状态机的单元测试（不启动浏览器）。
 *
 * 覆盖：lib/invariants.js 的全部断言、lib/session.js 的状态转移表、
 * lib/protocol.js 的 panelTabId 组合规则与投屏设置单一来源、
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
import { nextSessionState, SESSION_STATES } from '../lib/session.js'
import {
  DEFAULT_SCREENCAST_CONFIG, PANEL_COMMANDS, PANEL_CONFIG_LIMITS, PANEL_EVENTS, PANEL_PROTOCOL_VERSION,
  PANEL_SOCKET_PATH, PANEL_STATE_PATH, isPanelCommand, isPanelEvent, isSupportedProtocol, panelTabId, parsePanelTabId,
} from '../lib/protocol.js'

let pass = 0
let fail = 0

/** 跑一个用例：异常计 FAIL 并继续，保证一次跑完所有断言。 */
function check(name, fn) {
  try {
    fn()
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
check('有标签页时 assertBrowserRunning 通过', () => {
  const session = makeSession()
  session.pages.set('t1', { id: 't1' })
  assert.doesNotThrow(() => assertBrowserRunning(session))
})
check('没有会话时 assertBrowserRunning 报「尚未启动」', () => {
  assert.throws(() => assertBrowserRunning(undefined), /浏览器尚未启动，请先调用 browser_e2e_start/)
  assert.throws(() => assertBrowserRunning(makeSession()), /浏览器尚未启动，请先调用 browser_e2e_start/)
})
check('assertCurrentTabAvailable：active 存在才通过', () => {
  const session = makeSession({ activeTabId: 't1' })
  assert.throws(() => assertCurrentTabAvailable(session), /没有可用标签页/)
  session.pages.set('t1', { id: 't1' })
  assert.doesNotThrow(() => assertCurrentTabAvailable(session))
  session.activeTabId = 't2'
  assert.throws(() => assertCurrentTabAvailable(session), /没有可用标签页/)
})
check('assertTabExists 返回条目，缺失时报「不存在」', () => {
  const session = makeSession()
  const entry = { id: 't1', page: {} }
  session.pages.set('t1', entry)
  assert.equal(assertTabExists(session, 't1'), entry)
  assert.throws(() => assertTabExists(session, 't9'), /tab t9 不存在/)
})
check('assertCanCloseLastTab：只剩一个时报错', () => {
  const session = makeSession()
  session.pages.set('t1', { id: 't1' })
  assert.throws(() => assertCanCloseLastTab(session), /最后一个标签页/)
  session.pages.set('t2', { id: 't2' })
  assert.doesNotThrow(() => assertCanCloseLastTab(session))
})

console.log('== 用例 B：启动/关闭状态不变量 ==')
check('assertNotClosedDuringLaunch：closing / closed 报并发关闭', () => {
  assert.doesNotThrow(() => assertNotClosedDuringLaunch(makeSession({ state: 'launching' })))
  assert.doesNotThrow(() => assertNotClosedDuringLaunch(makeSession({ state: 'ready' })))
  assert.throws(() => assertNotClosedDuringLaunch(makeSession({ state: 'closing' })), /启动与关闭并发/)
  assert.throws(() => assertNotClosedDuringLaunch(makeSession({ state: 'closed' })), /启动与关闭并发/)
})
check('assertLaunchSettled：没有浏览器时报启动失败', () => {
  assert.doesNotThrow(() => assertLaunchSettled(makeSession({ browser: {} })))
  assert.throws(() => assertLaunchSettled(makeSession({ browser: null })), /并发启动未成功/)
})
check('assertModeNotHotSwitched：不一致的两个方向都报错', () => {
  assert.doesNotThrow(() => assertModeNotHotSwitched('isolated', 'isolated'))
  assert.doesNotThrow(() => assertModeNotHotSwitched('cdp', 'cdp'))
  assert.throws(() => assertModeNotHotSwitched('isolated', 'cdp'), /如需切换为 cdp 模式请先 browser_e2e_close/)
  assert.throws(() => assertModeNotHotSwitched('cdp', 'isolated'), /如需切换为 isolated 模式请先 browser_e2e_close/)
})
check('assertEndpointNotHotSwitched：端点不一致报错并带两端点', () => {
  assert.doesNotThrow(() => assertEndpointNotHotSwitched('http://127.0.0.1:9222', 'http://127.0.0.1:9222'))
  assert.throws(
    () => assertEndpointNotHotSwitched('http://127.0.0.1:9222', 'http://127.0.0.1:9333'),
    /CDP 端点 http:\/\/127\.0\.0\.1:9222.*http:\/\/127\.0\.0\.1:9333/,
  )
})
check('CDP 三条不变量各自报原文案', () => {
  assert.doesNotThrow(() => assertCdpConnected(makeSession({ context: {} })))
  assert.throws(() => assertCdpConnected(makeSession({ context: null })), /CDP 浏览器连接已失效/)
  assert.doesNotThrow(() => assertCdpContext({}))
  assert.throws(() => assertCdpContext(null), /没有可用的 context/)
  assert.doesNotThrow(() => assertCdpHasPages([{}]))
  assert.throws(() => assertCdpHasPages([]), /没有已打开的标签页/)
})

console.log('== 用例 C：ref 表不变量 ==')
check('assertRefBelongsToTab 按页隔离：别的页 ref 不存在', () => {
  const refsA = new Map([['@0', { xpath: '/html/body/button[1]' }]])
  const item = assertRefBelongsToTab(refsA, '@0')
  assert.equal(item.xpath, '/html/body/button[1]')
  const refsB = new Map()
  assert.throws(() => assertRefBelongsToTab(refsB, '@0'), /ref @0 不存在/)
})
check('assertRefRevalidated：未命中与零尺寸是两种文案', () => {
  assert.doesNotThrow(() => assertRefRevalidated('@1', { found: true, width: 10, height: 20 }))
  assert.throws(() => assertRefRevalidated('@1', { found: false, width: 0, height: 0 }), /ref @1 已失效，请重新 browser_e2e_snapshot/)
  assert.throws(() => assertRefRevalidated('@1', { found: true, width: 0, height: 20 }), /不可见.*请重新 browser_e2e_snapshot/)
})
check('assertSingleScreencast：已有 CDP 会话时报串台', () => {
  assert.doesNotThrow(() => assertSingleScreencast(null))
  assert.throws(() => assertSingleScreencast({}), /只能有一个投屏会话/)
})

console.log('== 用例 D：会话状态机（纯转移函数）==')
check('状态全集为 idle / launching / ready / closing / closed', () => {
  assert.equal(JSON.stringify(SESSION_STATES), JSON.stringify(['idle', 'launching', 'ready', 'closing', 'closed']))
})
check('合法转移逐条命中', () => {
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
check('非法转移抛错（含终态 closed）', () => {
  const illegal = [
    ['idle', 'launchSettled'],
    ['idle', 'launchFailed'],
    ['idle', 'closeSettled'],
    ['launching', 'launch'],
    ['launching', 'closeSettled'],
    ['ready', 'launch'],
    ['ready', 'launchSettled'],
    ['ready', 'closeSettled'],
    ['closing', 'close'],
    ['closing', 'launch'],
    ['closed', 'launch'],
    ['closed', 'close'],
    ['closed', 'closeSettled'],
  ]
  for (const [from, event] of illegal) {
    assert.throws(() => nextSessionState(from, event), /非法会话状态转移/, `${from} --${event} 应非法`)
  }
})
check('未知状态报错', () => {
  assert.throws(() => nextSessionState('booting', 'launch'), /未知会话状态 booting/)
})

console.log('== 用例 E：面板协议契约（protocol.js 单一来源）==')
check('panelTabId 组合与拆分可往返', () => {
  assert.equal(panelTabId('session-a', 't1'), 'session-a#t1')
  assert.deepEqual(parsePanelTabId('session-a#t1'), { key: 'session-a', tabId: 't1' })
  // 以最后一个分隔符为界：key 自身含分隔符也能正确拆分（tabId 不含分隔符）。
  assert.deepEqual(parsePanelTabId('a#b#t1'), { key: 'a#b', tabId: 't1' })
  assert.deepEqual(parsePanelTabId(panelTabId('k#x', 't1')), { key: 'k#x', tabId: 't1' })
})
check('panelTabId 非法格式返回 null', () => {
  assert.equal(parsePanelTabId('#t1'), null)
  assert.equal(parsePanelTabId('session-a#'), null)
  assert.equal(parsePanelTabId('no-separator'), null)
  assert.equal(parsePanelTabId(''), null)
  assert.equal(parsePanelTabId(undefined), null)
  assert.equal(parsePanelTabId(123), null)
})
check('命令表与事件表是协议的唯一来源', () => {
  assert.deepEqual(Object.values(PANEL_COMMANDS).sort(), ['attach', 'close-tab', 'configure', 'request-frame', 'select-tab'])
  assert.deepEqual(Object.values(PANEL_EVENTS).sort(), ['action', 'error', 'frame', 'hello', 'state'])
  assert.equal(isPanelCommand('attach'), true)
  assert.equal(isPanelCommand('select-tab'), true)
  assert.equal(isPanelCommand('no-such-command'), false)
  assert.equal(isPanelEvent('frame'), true)
  assert.equal(isPanelEvent('no-such-event'), false)
})
check('协议版本与路径', () => {
  assert.equal(isSupportedProtocol(PANEL_PROTOCOL_VERSION), true)
  assert.equal(isSupportedProtocol(PANEL_PROTOCOL_VERSION + 1), false)
  assert.equal(isSupportedProtocol('1'), false)
  assert.equal(PANEL_SOCKET_PATH, '/api/dsh-browser-e2e/socket')
  assert.equal(PANEL_STATE_PATH, '/api/dsh-browser-e2e/state')
})
check('投屏区间与默认值自洽（默认值逐项落在区间内）', () => {
  for (const [field, [min, max]] of Object.entries(PANEL_CONFIG_LIMITS)) {
    const value = DEFAULT_SCREENCAST_CONFIG[field]
    assert.ok(Number.isInteger(value) && value >= min && value <= max, `${field}=${value} 不在 [${min}, ${max}]`)
  }
  assert.deepEqual(DEFAULT_SCREENCAST_CONFIG, { quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
})

console.log('== 用例 F：client bundle 的协议常量由 protocol.js 注入 ==')
const clientSource = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
check('client 源文件只留注入标记，不手写区间与默认值', () => {
  assert.ok(clientSource.includes('/* @inject:panel-protocol:start */'))
  assert.ok(clientSource.includes('/* @inject:panel-protocol:end */'))
  assert.ok(!clientSource.includes('/api/dsh-browser-e2e/socket'), 'client 源文件不应手写 socket 路径')
  assert.ok(!/const PROTOCOL_VERSION = \d+;/.test(clientSource), 'client 源文件不应手写协议版本')
  assert.ok(!/const DEFAULT_CONFIG = \{/.test(clientSource), 'client 源文件不应手写投屏默认值')
})
check('生成的 bundle 常量与 protocol.js 逐字段一致', () => {
  const readBlock = (pattern) => {
    const match = pattern.exec(bundle)
    assert.ok(match, 'bundle 缺少常量：' + pattern)
    return match[1]
  }
  assert.equal(Number(readBlock(/const PROTOCOL_VERSION = (\d+);/)), PANEL_PROTOCOL_VERSION)
  assert.equal(JSON.parse(readBlock(/const WS_PATH = ("[^"]*");/)), PANEL_SOCKET_PATH)
  assert.deepEqual(JSON.parse(readBlock(/const PANEL_CONFIG_LIMITS = (\{.*?\});/)), PANEL_CONFIG_LIMITS)
  assert.deepEqual(JSON.parse(readBlock(/const DEFAULT_CONFIG = (\{.*?\});/)), DEFAULT_SCREENCAST_CONFIG)
  assert.ok(bundle.startsWith('/* 由 scripts/build-client.mjs 生成，勿手改'))
})

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
