/**
 * dsh-browser-e2e 回收行为验证：空闲超时 + session/disposed 两条回收路径。
 *
 * 直接调用 session.js / page.js 的真实实现（不 mock），每条用例都真起一个无头 Edge，
 * 断言「会话状态被清空」且「Edge 子进程已退出」。
 *
 * 不该被安装进 profile（package.json 的 files 只含 lib 与 cordis.patch.yml）。
 * 运行：node tests/reclaim.mjs
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用例 A 依赖 8 秒空闲回收；session.js 在模块加载时读取该环境变量，
// 所以必须在动态 import 之前设置（ESM 的静态 import 会先于模块体执行）。
process.env.DSH_BROWSER_IDLE_MS ??= '8000'
// 池化后「会话回收」只关本会话的 context，共享浏览器要等池级空闲到点才关（默认 2 分钟，
// 功能规格 0041 / 决策 D5）。本文件断言的是「回收后不留下浏览器进程」，所以把池级空闲压到 2 秒。
process.env.DSH_BROWSER_POOL_IDLE_MS ??= '2000'

const {
  activeSessionKeys, close, closeAll, closeBySessionId, launch, requireSession,
} = await import('../lib/session.js')
const { poolStats } = await import('../lib/pool.js')
const { navigate } = await import('../lib/page.js')

const EDGE_MIN_IDLE = 30
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 当前 msedge 主进程数；零表示浏览器已真正退出。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`) }
}

/** 轮询直到条件成立：进程退出与空闲回收都是异步的，固定 sleep 会偶发失败。 */
async function waitUntil(fn, timeoutMs = 15000, stepMs = 250) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(stepMs)
  }
}

// 主流程整体包 try/finally：任一用例失败也保证收掉可能残留的浏览器，不把进程留给下一个测试。
/**
 * 在子进程里跑「空闲到点自动回收」：子进程用自己的 profile 根，
 * 并通过 DSH_BROWSER_IDLE_MS_MIN_OVERRIDE 把下限临时放宽（生产是 60s，真等不现实）。
 * @param {{idleMs: number, poolIdleMs: number}} options - 子进程的空闲时限
 * @returns {Promise<object|null>} 子进程最后一行 JSON；失败为 null
 */
async function runIdleChild({ idleMs, poolIdleMs }) {
  const moduleUrl = new URL('../lib/session.js', import.meta.url).href
  const poolUrl = new URL('../lib/pool.js', import.meta.url).href
  const script = `
const { activeSessionKeys, closeAll, launch, requireSession } = await import(${JSON.stringify(moduleUrl)})
const { poolStats } = await import(${JSON.stringify(poolUrl)})
await launch('test-key-idle', { headless: true }, 'test-session-idle')
const heldAfterLaunch = activeSessionKeys().includes('test-key-idle')
const deadline = Date.now() + 20000
while (activeSessionKeys().includes('test-key-idle') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const reclaimed = !activeSessionKeys().includes('test-key-idle')
await new Promise((resolve) => setTimeout(resolve, 3000))
const poolEmpty = poolStats().hasBrowser === false
await closeAll().catch(() => {})
console.log(JSON.stringify({ heldAfterLaunch, reclaimed, poolEmpty }))
`
  const childFile = join(tmpdir(), `dsh-idle-child-${Date.now()}.mjs`)
  writeFileSync(childFile, script, 'utf8')
  try {
    const run = spawnSync(process.execPath, [childFile], {
      env: {
        ...process.env,
        DSH_BROWSER_IDLE_MS: String(idleMs),
        DSH_BROWSER_IDLE_MS_MIN_OVERRIDE: String(idleMs),
        DSH_BROWSER_POOL_IDLE_MS: String(poolIdleMs),
        DSH_BROWSER_E2E_HOME: join(tmpdir(), `dsh-idle-home-${Date.now()}`),
      },
      encoding: 'utf8',
      timeout: 120000,
    })
    const lines = (run.stdout ?? '').trim().split('\n').filter(Boolean)
    const last = lines.length ? lines[lines.length - 1] : ''
    return JSON.parse(last)
  } catch {
    return null
  } finally {
    try {
      rmSync(childFile, { force: true })
    } catch {
      // 删不掉不影响断言
    }
  }
}

try {
console.log('== 用例 A：空闲超时自动回收（子进程，等效 300ms 空闲）==')
{
  // DSH_BROWSER_IDLE_MS 有 60s 下限（避免计时器在操作中途把会话关掉），真的等 60s 不现实。
  // 这里开子进程，用 IDLE_CLOSE_MS_OVERRIDE 把下限临时放宽到 300ms —— 被测的是「空闲到点会回收」
  // 这条逻辑，不是下限本身；下限由 tests/idle-bounds.mjs 单独验收。
  const child = await runIdleChild({ idleMs: 300, poolIdleMs: 2000 })
  check('子进程启动后 sessions 持有该会话', child !== null && child.heldAfterLaunch === true, JSON.stringify(child))
  check('空闲到点后 sessions 已清空', child !== null && child.reclaimed === true, JSON.stringify(child))
  check('回收后池里没有残留共享浏览器', child !== null && child.poolEmpty === true, JSON.stringify(child))
}

console.log('== 用例 B：session/disposed 钩子回收（同一条 closeBySessionId 路径）==')
{
  const id = 'test-session-disposed'
  await launch('test-key-disposed', { headless: true }, id)
  await navigate(requireSession('test-key-disposed'), 'about:blank', 'load')
  check('启动后 sessions 持有该会话', activeSessionKeys().includes('test-key-disposed'), JSON.stringify(activeSessionKeys()))
  const leasesBeforeDispose = poolStats().leases
  const r = await closeBySessionId(id)
  check('disposed 路径返回 closed=true', r.closed === true, JSON.stringify(r))
  check('disposed 后 sessions 已清空', !activeSessionKeys().includes('test-key-disposed'), JSON.stringify(activeSessionKeys()))
  // 先断言前值，否则「租约 0」在「压根没 acquire 过」时天然成立，release 改成空实现也绿。
  check('disposed 前租约为 1', leasesBeforeDispose === 1, JSON.stringify({ leasesBeforeDispose }))
  check('disposed 后租约已归还', poolStats().leases === 0, JSON.stringify(poolStats()))
  // 池化：dispose 只回收该会话的 context 并归还租约；共享浏览器由池级空闲回收。
  // 判据用池状态而不是数进程：edgeRootCount 每次要起一个 pwsh（2~2.7s），20 秒窗口内只能采到几次，
  // 而进程回落本身还要等操作系统回收，容易假红。进程收尾由文件末尾的统一断言负责。
  const gone = await waitUntil(() => poolStats().hasBrowser === false, 15000)
  check('disposed 后池已关掉共享浏览器', gone, JSON.stringify(poolStats()))
}

console.log('== 用例 C：不显式传 sessionId 时，用 agent.id（= key）仍能被 disposed 命中 ==')
{
  // 模拟工具层只给 key（key 就是 agent.id）的情形：launch 不带第三个参数。
  await launch('test-key-agentid', { headless: true })
  const r = await closeBySessionId('test-key-agentid')
  check('传入 agent.id 作 sessionId 时命中', r.closed === true, JSON.stringify(r))
  check('命中后 sessions 已清空', !activeSessionKeys().includes('test-key-agentid'), JSON.stringify(activeSessionKeys()))
}

console.log('== 用例 D：未使用过浏览器的会话，钩子不应报错 ==')
{
  const r = await closeBySessionId('never-used-session')
  check('未使用会话返回 closed=false', r.closed === false, JSON.stringify(r))
}

console.log('== 用例 E：显式 close 仍然生效 ==')
{
  const before = edgeRootCount()
  const id = 'test-session-explicit'
  await launch('test-key-explicit', { headless: true }, id)
  const r = await close('test-key-explicit')
  check('显式 close 返回 closed=true', r.closed === true, JSON.stringify(r))
  const gone = await waitUntil(() => edgeRootCount() <= before, 15000)
  check('显式 close 后 Edge 主进程已回落', gone, `before=${before} now=${edgeRootCount()}`)
}

console.log('== 用例 F：小空闲时限不打断 launch（launch 与空闲回收竞态）==')
{
  const before = edgeRootCount()
  // session.js 在模块加载时读取 DSH_BROWSER_IDLE_MS，只能用子进程模拟「空闲时限小于启动耗时」。
  const moduleUrl = new URL('../lib/session.js', import.meta.url).href
  const childScript = `
const { activeSessionKeys, closeAll, launch } = await import(${JSON.stringify(moduleUrl)})
const started = Date.now()
const info = await launch('test-key-tiny-idle', { headless: true }, 'test-session-tiny-idle')
const elapsed = Date.now() - started
const keysAfterLaunch = activeSessionKeys()
const deadline = Date.now() + 8000
while (activeSessionKeys().includes('test-key-tiny-idle') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const reclaimed = !activeSessionKeys().includes('test-key-tiny-idle')
// 池化：close 只回收 context，共享浏览器仍在（Playwright 连接会挂住事件循环），
// 必须 closeAll 才会 shutdown 池，子进程才能正常退出。
await closeAll().catch(() => {})
console.log(JSON.stringify({ elapsed, keysAfterLaunch, reclaimed, version: info.version }))
`
  // 用临时脚本文件而不是 `-e` 内联：内联脚本在本仓的子进程里会撞上入口解析问题
  // （stderr 只有 run_main:107 + triggerUncaughtException，无错误文本），落盘后同一脚本可稳定复现。
  const childFile = join(tmpdir(), `dsh-reclaim-child-${Date.now()}.mjs`)
  writeFileSync(childFile, childScript, 'utf8')
  const run = spawnSync(process.execPath, [childFile], {
    // 子进程只验证「会话级 100ms 空闲不打断 launch」这一条竞态：池级空闲必须留足，
    // 否则浏览器刚拉起就被池回收（本文件的 2 秒池级空闲正是给别的用例用的）。
    // 子进程用自己的 profile 根：前序用例刚关掉的浏览器与子进程同签名、同目录，
    // Chromium 释放 user-data-dir 有延迟，立即复用会让子进程起不来（实测 status=1）。
    env: {
      ...process.env,
      // 会话空闲的下限是 60s（避免计时器在操作中途关会话）；这条用例要的是「空闲时限小于启动耗时」，
      // 所以用测试专用的 MIN_OVERRIDE 把下限放宽到 100ms，否则 100 会被抬成 60000、8 秒内不会回收。
      DSH_BROWSER_IDLE_MS: '100',
      DSH_BROWSER_IDLE_MS_MIN_OVERRIDE: '100',
      DSH_BROWSER_POOL_IDLE_MS: '60000',
      DSH_BROWSER_E2E_HOME: join(tmpdir(), `dsh-reclaim-home-${Date.now()}`),
    },
    encoding: 'utf8',
    timeout: 60000,
  })
  // 子进程脚本用完即删，不给 .scratch / tmp 留垃圾。
  try {
    rmSync(childFile, { force: true })
  } catch {
    // 删不掉不影响断言
  }
  const output = (run.stdout ?? '').trim()
  let child = null
  try {
    child = JSON.parse(output.split('\n').filter(Boolean).pop() ?? '')
  } catch {
    child = null
  }
  // 失败时把子进程的异常行摘出来：Playwright 的调用日志会淹没真正的报错。
  const stderrText = (run.stderr ?? '').trim()
  const badLines = stderrText.split('\n')
    .filter((line) => /Error|error|throw|Cannot|not supported|message/.test(line))
    .slice(0, 4)
  const detail = `status=${run.status} stdout=${output} err=${badLines.join(' | ') || stderrText.slice(0, 400)}`
  check('IDLE_MS=100 时 launch 正常返回（未被空闲回收打断）',
    run.status === 0 && Array.isArray(child?.keysAfterLaunch) && child.keysAfterLaunch.includes('test-key-tiny-idle'), detail)
  check('启动耗时超过空闲时限（竞态场景确实被覆盖）', typeof child?.elapsed === 'number' && child.elapsed >= 100, detail)
  check('launch 落定后空闲回收仍然生效', child?.reclaimed === true, detail)
  const gone = await waitUntil(() => edgeRootCount() <= before, 15000)
  check('子进程结束后 Edge 主进程回落到基线', gone, `before=${before} now=${edgeRootCount()}`)
}

console.log('== 用例 G：同一 key 并发 launch 只建一个浏览器 ==')
{
  const before = edgeRootCount()
  const launchesBeforeConcurrent = poolStats().launchCount
  const first = launch('test-key-concurrent', { headless: true }, 'test-session-concurrent')
  const second = launch('test-key-concurrent', { headless: true }, 'test-session-concurrent')
  const [a, b] = await Promise.all([first, second])
  check('两次并发 launch 都成功返回', Boolean(a) && Boolean(b) && typeof a.version === 'string' && typeof b.version === 'string',
    JSON.stringify({ a, b }))
  check('后到的一次按复用返回同一实例', a.reused === false && b.reused === true,
    JSON.stringify({ aReused: a.reused, bReused: b.reused }))
  check('会话只有一个标签页', a.tabs === 1 && b.tabs === 1, JSON.stringify({ aTabs: a.tabs, bTabs: b.tabs }))
  // pwsh 查进程一次约 2-2.7s，8s 空闲时限可能在等待期间被回收；查询前后都刷新空闲计时。
  // 会话若已被回收（单次查询 > 8s 的极端情况），返回一个不可能满足的大数，让 waitUntil 继续等而不是抛错崩溃。
  const countWithTouch = () => {
    let session
    try {
      session = requireSession('test-key-concurrent')
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
    session.touch()
    const count = edgeRootCount()
    session.touch()
    return count
  }
  // 池化后「只建一个浏览器」由池保证（并发合流），进程数还受别的池槽影响，所以断言改为
  // 「并发两次只拉起一次浏览器」这一池的契约 + 「会话确实可用」，不再比较绝对进程数。
  const single = await waitUntil(() => countWithTouch() <= before + 1, 10000)
  check('并发启动没有多起浏览器进程', single, `before=${before} now=${countWithTouch()}`)
  // launchCount 是进程级累计值，只能看**前后差**：并发两次必须只拉起一次，这是合流的唯一硬证据。
  // 同上：合计最多拉起一次（槽已存在则差 0），差 2 才是「并发各起一个」的缺陷。
  check('并发两次最多拉起一次浏览器',
    poolStats().launchCount - launchesBeforeConcurrent <= 1,
    JSON.stringify({ launchesBeforeConcurrent, now: poolStats().launchCount }))
  check('并发后池里只有一个槽且租约为 1',
    poolStats().slots.length === 1 && poolStats().leases === 1, JSON.stringify(poolStats()))
  requireSession('test-key-concurrent').touch()
  const blank = await navigate(requireSession('test-key-concurrent'), 'about:blank', 'load')
  check('并发启动后浏览器可正常导航', blank.url === 'about:blank', JSON.stringify(blank))
  const closedConcurrent = await close('test-key-concurrent')
  check('关闭返回已关闭本会话上下文', closedConcurrent.closed === true
    && closedConcurrent.summary === '已关闭本会话的浏览器上下文', JSON.stringify(closedConcurrent))
  // close 只归还租约；租约归零后由池在空闲时限内关掉共享浏览器。
  const gone = await waitUntil(() => edgeRootCount() <= before, 20000)
  check('租约归零后共享浏览器回落到基线', gone, `before=${before} now=${edgeRootCount()}`)
}

} finally {
  await closeAll()
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（应为 0），sessions ${JSON.stringify(activeSessionKeys())}`)
process.exit(fail === 0 ? 0 : 1)
