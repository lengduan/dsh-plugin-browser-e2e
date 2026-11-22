/**
 * 池化接入验收（功能规格 0041 方案 A）：多会话共享同一个浏览器进程、各自一个隔离 context。
 *
 * 真起无头 Edge，用本地临时 HTTP 服务做夹具（cookie / localStorage 需要 http 源）。
 * 覆盖步骤 2 的验收项：
 *   - 两个会话拿到同一个浏览器实例，各自 context 不同；
 *   - close A 之后 A 的 context 已关、B 仍可正常导航与求值（资源归属）；
 *   - A / B 的 cookie 与 localStorage 互不可见（会话隔离 / 不串味）；
 *   - 关闭后再 start 得到新的隔离 context（旧登录态不残留）。
 *
 * 运行：node tests/pool-sessions.mjs
 */
import { createServer } from 'node:http'

process.env.DSH_BROWSER_IDLE_MS = '600000'
process.env.DSH_BROWSER_POOL_IDLE_MS = '2000'

const { activeSessionKeys, close, closeAll, launch, requireSession } = await import('../lib/session.js')
const { evaluate, navigate } = await import('../lib/page.js')
const { poolStats } = await import('../lib/pool.js')

const KEY_A = 'test-pool-session-a'
const KEY_B = 'test-pool-session-b'
const COOKIE_A = 'poolAuth=alice'
const COOKIE_B = 'poolAuth2=bob'
const LOCAL_KEY = 'poolToken'
const LOCAL_VALUE = 'alice-local'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`) }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>pool-page</title></head><body><h1 id="h">池化夹具</h1></body></html>')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 1：两个会话共享同一个浏览器实例，各自一个 context ==')
  {
    const launchesBeforeCase1 = poolStats().launchCount
    const infoA = await launch(KEY_A, { headless: true }, KEY_A)
    const sessionA = requireSession(KEY_A)
    const infoB = await launch(KEY_B, { headless: true }, KEY_B)
    const sessionB = requireSession(KEY_B)
    check('两个会话都启动成功', infoA.reused === false && infoB.reused === false,
      JSON.stringify({ aReused: infoA.reused, bReused: infoB.reused }))
    check('两个会话拿到同一个浏览器实例', sessionA.browser === sessionB.browser)
    check('两个会话的 context 是两个不同的对象', sessionA.context !== sessionB.context
      && Boolean(sessionA.context) && Boolean(sessionB.context))
    check('池里只有一个槽、两份租约',
      poolStats().slots.length === 1 && poolStats().leases === 2, JSON.stringify(poolStats()))
    // 「复用」的唯一硬证据是累计拉起次数没变，而不是「槽里有浏览器」（那个从不说复用）。
    // 两个会话合计最多拉起一次：槽已存在时两次都复用（差 0），槽为空时第一次拉起、第二次复用（差 1）。
    // 差 2 才是缺陷（各起一个）。用 === 1 会在前序用例留下浏览器时误判。
    check('第二个会话是复用了浏览器进程（不是新起一个）',
      poolStats().launchCount - launchesBeforeCase1 <= 1,
      JSON.stringify({ launchesBeforeCase1, now: poolStats().launchCount }))
  }

  console.log('== 用例 2：登录态会话隔离（A 写的 cookie / localStorage B 看不到）==')
  {
    const sessionA = requireSession(KEY_A)
    const sessionB = requireSession(KEY_B)
    await navigate(sessionA, `${base}/page`, 'load')
    await navigate(sessionB, `${base}/page`, 'load')
    const wroteA = await evaluate(sessionA,
      `(() => { document.cookie = '${COOKIE_A}; path=/'; localStorage.setItem('${LOCAL_KEY}', '${LOCAL_VALUE}'); return document.cookie })()`)
    const wroteB = await evaluate(sessionB, `(() => { document.cookie = '${COOKIE_B}; path=/'; return document.cookie })()`)
    check('A 写入自己的 cookie 与 localStorage',
      wroteA.value.includes('alice') && (await evaluate(sessionA, `localStorage.getItem('${LOCAL_KEY}')`)).value === LOCAL_VALUE,
      JSON.stringify(wroteA.value))
    check('B 写入自己的 cookie', wroteB.value.includes('bob'), JSON.stringify(wroteB.value))
    const aSees = await evaluate(sessionA, 'document.cookie')
    const bSees = await evaluate(sessionB, 'document.cookie')
    check('A 看不到 B 的 cookie', !aSees.value.includes('bob'), JSON.stringify(aSees.value))
    check('B 看不到 A 的 cookie 与 localStorage',
      !bSees.value.includes('alice') && (await evaluate(sessionB, `localStorage.getItem('${LOCAL_KEY}')`)).value === null,
      JSON.stringify(bSees.value))
  }

  console.log('== 用例 3：close A 只关 A 的 context，B 完全不受影响 ==')
  {
    const sessionA = requireSession(KEY_A)
    const sessionB = requireSession(KEY_B)
    const closedA = await close(KEY_A)
    check('close A 返回已关闭本会话上下文',
      closedA.closed === true && closedA.summary === '已关闭本会话的浏览器上下文', JSON.stringify(closedA))
    check('A 已从注册表摘除、B 仍在', !activeSessionKeys().includes(KEY_A) && activeSessionKeys().includes(KEY_B),
      JSON.stringify(activeSessionKeys()))
    check('A 自己的 context 已失效（close 后被置空）', sessionA.context === null)
    check('B 的 context 与浏览器仍在', sessionB.context !== null && Boolean(sessionB.browser))
    check('共享浏览器没有被 close A 关掉（租约还剩 1）',
      poolStats().hasBrowser === true && poolStats().leases === 1, JSON.stringify(poolStats()))
    // B 继续用同一个浏览器导航与求值：这是「A 的 close 不影响 B」的直接证据。
    const nav = await navigate(sessionB, `${base}/page`, 'load')
    check('close A 后 B 仍能导航', nav.url === `${base}/page`, JSON.stringify(nav))
    const title = await evaluate(sessionB, 'document.title')
    check('close A 后 B 仍能求值', title.value === 'pool-page', JSON.stringify(title))
  }

  console.log('== 用例 4：重新 start A 得到新的隔离 context（旧登录态不残留）==')
  {
    const info = await launch(KEY_A, { headless: true }, KEY_A)
    const sessionA = requireSession(KEY_A)
    check('重新 start 返回 reused=false', info.reused === false, JSON.stringify(info))
    await navigate(sessionA, `${base}/page`, 'load')
    const cookie = await evaluate(sessionA, 'document.cookie')
    const local = await evaluate(sessionA, `localStorage.getItem('${LOCAL_KEY}')`)
    check('新 context 里旧 cookie 与 localStorage 已清空',
      !cookie.value.includes('alice') && local.value === null, JSON.stringify({ cookie: cookie.value, local: local.value }))
    check('A 与 B 现在共享同一个浏览器但各持独立 context',
      sessionA.browser === requireSession(KEY_B).browser && sessionA.context !== requireSession(KEY_B).context)
  }

  console.log('== 用例 4b：临时页只落在自己的 context 里，用完即关不影响他人 ==')
  {
    // createTransientPage 此前没有直接测试（只有 fetch 链路间接覆盖），
    // 这里直接断它在本仓最要紧的那条性质：临时页归属**自己的** context，
    // 不泄漏到同浏览器的另一会话，且用完从页面计数里消失。
    const { createTransientPage, isTransientPage } = await import('../lib/page.js')
    const sessionA = requireSession(KEY_A)
    const sessionB = requireSession(KEY_B)
    const beforeA = sessionA.context.pages().length
    const beforeB = sessionB.context.pages().length
    const transient = await createTransientPage(sessionA)
    check('临时页被标记为 transient', isTransientPage(transient) === true, String(isTransientPage(transient)))
    check('临时页落在会话 A 自己的 context 里',
      sessionA.context.pages().includes(transient), `pages=${sessionA.context.pages().length}`)
    check('临时页不属于会话 B 的 context（跨会话隔离）',
      !sessionB.context.pages().includes(transient), `B pages=${sessionB.context.pages().length}`)
    check('临时页不计入 session.pages（面板与 tabs 不会多一页）',
      ![...sessionA.pages.values()].some((entry) => entry.page === transient),
      `sessionA.pages=${sessionA.pages.size}`)
    check('B 的页面数不受影响', sessionB.context.pages().length === beforeB,
      `before=${beforeB} after=${sessionB.context.pages().length}`)
    await transient.close()
    await sleep(200)
    // 临时页关掉后回到基线：不累积、不泄漏（WeakSet 里残留也不影响计数）
    check('临时页关闭后 A 的页面数回到基线', sessionA.context.pages().length === beforeA,
      `before=${beforeA} after=${sessionA.context.pages().length}`)
  }
  console.log('== 用例 5：全部 close 后租约归零，共享浏览器由池回收 ==')
  {
    await close(KEY_A)
    await close(KEY_B)
    check('租约归零', poolStats().leases === 0, JSON.stringify(poolStats()))
    const gone = await (async () => {
      const started = Date.now()
      for (;;) {
        if (poolStats().hasBrowser === false) return true
        if (Date.now() - started > 15000) return false
        await sleep(250)
      }
    })()
    check('池级空闲到点后共享浏览器已关', gone, JSON.stringify(poolStats()))
  }

  console.log('== 用例 6：context 级空闲超时只关自己，不波及同浏览器的另一会话 ==')
  {
    // 用例 6 用较短的空闲时限：直接改会话计数器的到期行为不方便，这里改成「手动让 A 空闲到期」
    // —— touchSession 的到期动作就是 close(key)，所以等价于验证 close(A) 的波及面。
    const infoA = await launch(KEY_A, { headless: true }, KEY_A)
    const infoB = await launch(KEY_B, { headless: true }, KEY_B)
    // 注意 reused 是「本会话是否复用」而不是「池是否复用浏览器」：两个会话各自都是首次启动，
    // 所以都返回 reused=false，但池只拉起了一个浏览器进程、两个会话共享它。判据看池状态。
    check('用例 6 前置：两个会话共享同一个浏览器进程',
      infoA.reused === false && infoB.reused === false
        && requireSession(KEY_A).browser === requireSession(KEY_B).browser && poolStats().leases === 2,
      JSON.stringify({ stats: poolStats() }))
    const sessionB = requireSession(KEY_B)
    const browserBefore = sessionB.browser
    const contextB = sessionB.context
    // 模拟 A 的 context 级空闲到期：touchSession 到期走的就是 close(key)。
    await close(KEY_A)
    check('A 到期后 B 的浏览器与 context 都没被换掉',
      sessionB.browser === browserBefore && sessionB.context === contextB && poolStats().leases === 1,
      JSON.stringify(poolStats()))
    const nav = await navigate(requireSession(KEY_B), `${base}/page`, 'load')
    check('A 到期后 B 仍可正常导航', nav.url === `${base}/page`, JSON.stringify(nav))
    await close(KEY_B)
  }

  console.log('== 用例 7：只有全部 context 关闭后，池才关浏览器 ==')
  {
    const launchesBefore7 = poolStats().launchCount
    const infoA = await launch(KEY_A, { headless: true }, KEY_A)
    const infoB = await launch(KEY_B, { headless: true }, KEY_B)
    // 与用例 6 同：两个会话各自首次启动（reused 均为 false），但共享同一个浏览器进程。
    // launchCount 是进程级累计值，只能看**前后差**：">= 2" 方向反了，共享越坏数字越大反而越容易绿。
    // 同上：合计最多拉起一次（差 0 或 1），差 2 才是「各起一个」的缺陷。
    check('用例 7 前置：两个会话共享同一浏览器',
      infoA.reused === false && infoB.reused === false
        && requireSession(KEY_A).browser === requireSession(KEY_B).browser
        && poolStats().launchCount - launchesBefore7 <= 1,
      JSON.stringify({ launchesBefore7, now: poolStats().launchCount }))
    await close(KEY_A)
    // 还有一个租约：池的计时器不应被装上，浏览器不能被关。
    await sleep(500)
    check('还剩一个 context 时浏览器不关',
      poolStats().hasBrowser === true && poolStats().leases === 1 && poolStats().idleArmed === false,
      JSON.stringify(poolStats()))
    await close(KEY_B)
    check('最后一个 context 关闭后租约归零且装上池级计时',
      poolStats().leases === 0 && poolStats().idleArmed === true, JSON.stringify(poolStats()))
    const gone = await (async () => {
      const started = Date.now()
      for (;;) {
        if (poolStats().hasBrowser === false) return true
        if (Date.now() - started > 15000) return false
        await sleep(250)
      }
    })()
    check('池级计时到点后才关浏览器', gone, JSON.stringify(poolStats()))
  }
} finally {
  await closeAll()
  server.close()
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
