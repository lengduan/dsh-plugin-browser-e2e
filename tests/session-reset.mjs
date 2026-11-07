/**
 * P1-11 会话上下文重置验收测试（规格 specs/功能规格/0020-session-reset.md 验收 1-5）。
 *
 * 本项不新增工具：重置由既有 `browser_e2e_close` + `browser_e2e_start` 承担。
 * 真起无头 Edge，用本地临时 HTTP 服务做夹具（cookie / localStorage 需要 http 源，data: URL 不行），覆盖：
 *   - 重置前 cookie 与 localStorage 已写入；
 *   - close + start 后新一次性 profile 里 cookie / localStorage 已清空，start 返回 reused=false；
 *   - 重置后标签页从 t1 重新开始且只有一页（origin 为 created）；
 *   - 重置只影响本 agent 的 key，另一会话的浏览器与登录态不受影响；
 *   - close 清掉旧会话空闲计时器，新会话对象重新计时。
 * 另覆盖规格「边界」中的两条：两步之间页面工具报「浏览器尚未启动」；未启动时 close 返回「无需关闭」。
 *
 * 运行：node tests/session-reset.mjs
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { activeSessionKeys, close, closeAll, launch, requireSession, tabs } = await import('../lib/session.js')
const { evaluate, navigate } = await import('../lib/page.js')

const KEY_A = 'test-session-reset-a'
const KEY_B = 'test-session-reset-b'
const COOKIE_A = 'resetAuth=alice'
const COOKIE_B = 'otherAuth=bob'
const LOCAL_KEY = 'resetToken'
const LOCAL_VALUE = 'alice-local'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/** Edge 根进程数（排除渲染 / 工具子进程），只用于收尾诊断。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

const baseline = edgeRootCount()
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>reset-page</title></head><body><h1 id="h">重置夹具</h1></body></html>')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 0：准备两个互相独立的会话 ==')
  {
    const infoA = await launch(KEY_A, { headless: true, viewportWidth: 800, viewportHeight: 600 }, KEY_A)
    const infoB = await launch(KEY_B, { headless: true, viewportWidth: 800, viewportHeight: 600 }, KEY_B)
    check('两个会话各自启动成功', infoA.reused === false && infoB.reused === false
      && infoA.mode === 'isolated' && infoB.mode === 'isolated', JSON.stringify({ infoA, infoB }))
    const listA = await tabs(KEY_A)
    const listB = await tabs(KEY_B)
    check('两个会话各自只有自己的 t1', listA.tabs.length === 1 && listB.tabs.length === 1
      && listA.tabs[0].tab_id === 't1' && listB.tabs[0].tab_id === 't1',
    JSON.stringify({ a: listA.tabs, b: listB.tabs }))
  }

  console.log('== 用例 1：重置前 cookie 与 localStorage 已写入 ==')
  {
    const sessionA = requireSession(KEY_A)
    const sessionB = requireSession(KEY_B)
    await navigate(sessionA, `${base}/page`, 'load')
    await navigate(sessionB, `${base}/page`, 'load')
    const wroteA = await evaluate(sessionA,
      `(() => { document.cookie = '${COOKIE_A}; path=/'; localStorage.setItem('${LOCAL_KEY}', '${LOCAL_VALUE}'); return document.cookie })()`)
    const localA = await evaluate(sessionA, `localStorage.getItem('${LOCAL_KEY}')`)
    const wroteB = await evaluate(sessionB, `(() => { document.cookie = '${COOKIE_B}; path=/'; return document.cookie })()`)
    check('重置前 cookie 与 localStorage 已写入',
      wroteA.value.includes(COOKIE_A) && localA.value === LOCAL_VALUE,
      JSON.stringify({ cookie: wroteA.value, local: localA.value }))
    check('用例 1 前置：另一会话也写入了自己的 cookie', wroteB.value.includes(COOKIE_B), JSON.stringify(wroteB.value))
    check('用例 1 前置：两个会话都在 activeSessionKeys 里',
      activeSessionKeys().includes(KEY_A) && activeSessionKeys().includes(KEY_B),
      JSON.stringify(activeSessionKeys()))
  }

  // 用例 2 / 3 / 5 的公共步骤：先记下旧会话对象，再 close + start。
  console.log('== 重置动作：close 再 start ==')
  let oldSession = null
  let oldIdleAfterClose
  let sessionA2 = null
  let startInfo = null
  let tabsAfterStart = null
  {
    oldSession = requireSession(KEY_A)
    check('重置前旧会话的空闲计时空在跑', oldSession.idleTimer !== null, String(oldSession.idleTimer))
    const closed = await close(KEY_A)
    check('close 返回隔离模式已关闭', closed.closed === true && closed.mode === 'isolated'
      && closed.summary === '浏览器已关闭', JSON.stringify(closed))
    oldIdleAfterClose = oldSession.idleTimer
    const between = await expectThrow(() => requireSession(KEY_A))
    check('两步之间页面工具报未启动',
      Boolean(between) && between.includes('浏览器尚未启动'), String(between))
    // 不传 mode：close 不保留上一会话的运行参数，缺省回到 isolated。
    startInfo = await launch(KEY_A, { headless: true, viewportWidth: 800, viewportHeight: 600 }, KEY_A)
    sessionA2 = requireSession(KEY_A)
    tabsAfterStart = await tabs(KEY_A)
  }

  console.log('== 用例 2：close 再 start 后 cookie 与 localStorage 已清空 ==')
  {
    await navigate(sessionA2, `${base}/page`, 'load')
    const cookie = await evaluate(sessionA2, 'document.cookie')
    const local = await evaluate(sessionA2, `localStorage.getItem('${LOCAL_KEY}')`)
    check('close 再 start 后 cookie 与 localStorage 已清空',
      !cookie.value.includes(COOKIE_A) && local.value === null && startInfo.reused === false,
      JSON.stringify({ cookie: cookie.value, local: local.value, reused: startInfo.reused }))
    check('重启缺省回到 isolated 模式', startInfo.mode === 'isolated', JSON.stringify(startInfo))
  }

  console.log('== 用例 3：重置后标签页从 t1 重新开始且只有一页 ==')
  {
    check('重置后标签页从 t1 重新开始且只有一页',
      tabsAfterStart.tabs.length === 1 && tabsAfterStart.tabs[0].tab_id === 't1'
        && tabsAfterStart.tabs[0].active === true && tabsAfterStart.activeTabId === 't1',
      JSON.stringify(tabsAfterStart.tabs))
    check('重开后首个标签页 origin 为 created（新建而非沿用）',
      tabsAfterStart.tabs[0].origin === 'created', JSON.stringify(tabsAfterStart.tabs[0]))
  }

  console.log('== 用例 4：重置不影响另一个会话的登录态 ==')
  {
    const sessionB = requireSession(KEY_B)
    const cookieB = await evaluate(sessionB, 'document.cookie')
    const listB = await tabs(KEY_B)
    const keys = activeSessionKeys()
    check('重置不影响另一个会话的登录态',
      cookieB.value.includes(COOKIE_B) && keys.includes(KEY_A) && keys.includes(KEY_B),
      JSON.stringify({ cookieB: cookieB.value, keys }))
    check('另一会话的标签页未被重置波及',
      listB.tabs.length === 1 && listB.tabs[0].tab_id === 't1' && listB.tabs[0].active === true,
      JSON.stringify(listB.tabs))
  }

  console.log('== 用例 5：重置后旧计时器清空且新会话重新计时 ==')
  {
    check('重置后旧计时器清空且新会话重新计时',
      oldIdleAfterClose === null && sessionA2 !== oldSession && sessionA2.idleTimer !== null,
      JSON.stringify({
        oldIdle: oldIdleAfterClose === null ? null : String(oldIdleAfterClose),
        sameObject: sessionA2 === oldSession,
        newIdle: sessionA2.idleTimer === null ? null : String(sessionA2.idleTimer),
      }))
    check('新会话对象进入 ready 状态', sessionA2.state === 'ready', String(sessionA2.state))
  }

  console.log('== 用例 6：边界——未启动时 close 返回无需关闭 ==')
  {
    const idle = await close('test-session-reset-never-started')
    check('未启动时 close 返回无需关闭', idle.closed === false
      && String(idle.summary).includes('无需关闭'), JSON.stringify(idle))
  }
} finally {
  await closeAll()
  server.close()
  await sleep(1500)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（基线 ${baseline}）`)
process.exit(fail === 0 ? 0 : 1)
