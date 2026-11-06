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

// 用例 A 依赖 8 秒空闲回收；session.js 在模块加载时读取该环境变量，
// 所以必须在动态 import 之前设置（ESM 的静态 import 会先于模块体执行）。
process.env.DSH_BROWSER_IDLE_MS ??= '8000'

const {
  activeSessionKeys, close, closeBySessionId, launch, requireSession,
} = await import('../lib/session.js')
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

console.log('== 用例 A：空闲超时自动回收（DSH_BROWSER_IDLE_MS=8000）==')
{
  const before = edgeRootCount()
  const id = 'test-session-idle'
  await launch('test-key-idle', { headless: true }, id)
  await navigate(requireSession('test-key-idle'), 'about:blank', 'load')
  check('启动后 sessions 持有该会话', activeSessionKeys().includes('test-key-idle'), JSON.stringify(activeSessionKeys()))
  check('启动后 Edge 主进程增加', edgeRootCount() > before, `before=${before} now=${edgeRootCount()}`)
  console.log('  等待 8s 空闲超时 + 轮询进程回落（每 250ms，最多 15s）…')
  const cleared = await waitUntil(() => !activeSessionKeys().includes('test-key-idle'), 15000)
  check('超时后 sessions 已清空', cleared, JSON.stringify(activeSessionKeys()))
  const gone = await waitUntil(() => edgeRootCount() <= before, 15000)
  check('超时后 Edge 主进程已回落', gone, `before=${before} now=${edgeRootCount()}`)
}

console.log('== 用例 B：session/disposed 钩子回收（同一条 closeBySessionId 路径）==')
{
  const before = edgeRootCount()
  const id = 'test-session-disposed'
  await launch('test-key-disposed', { headless: true }, id)
  await navigate(requireSession('test-key-disposed'), 'about:blank', 'load')
  check('启动后 sessions 持有该会话', activeSessionKeys().includes('test-key-disposed'), JSON.stringify(activeSessionKeys()))
  const r = await closeBySessionId(id)
  check('disposed 路径返回 closed=true', r.closed === true, JSON.stringify(r))
  check('disposed 后 sessions 已清空', !activeSessionKeys().includes('test-key-disposed'), JSON.stringify(activeSessionKeys()))
  const gone = await waitUntil(() => edgeRootCount() <= before, 15000)
  check('disposed 后 Edge 主进程已回落', gone, `before=${before} now=${edgeRootCount()}`)
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
const { activeSessionKeys, close, launch } = await import(${JSON.stringify(moduleUrl)})
const started = Date.now()
const info = await launch('test-key-tiny-idle', { headless: true }, 'test-session-tiny-idle')
const elapsed = Date.now() - started
const keysAfterLaunch = activeSessionKeys()
const deadline = Date.now() + 8000
while (activeSessionKeys().includes('test-key-tiny-idle') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const reclaimed = !activeSessionKeys().includes('test-key-tiny-idle')
await close('test-key-tiny-idle').catch(() => {})
console.log(JSON.stringify({ elapsed, keysAfterLaunch, reclaimed, version: info.version }))
`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    env: { ...process.env, DSH_BROWSER_IDLE_MS: '100' },
    encoding: 'utf8',
    timeout: 60000,
  })
  const output = (run.stdout ?? '').trim()
  let child = null
  try {
    child = JSON.parse(output.split('\n').filter(Boolean).pop() ?? '')
  } catch {
    child = null
  }
  const detail = `status=${run.status} stdout=${output} stderr=${(run.stderr ?? '').trim()}`
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
  const first = launch('test-key-concurrent', { headless: true }, 'test-session-concurrent')
  const second = launch('test-key-concurrent', { headless: true }, 'test-session-concurrent')
  const [a, b] = await Promise.all([first, second])
  check('两次并发 launch 都成功返回', Boolean(a) && Boolean(b) && typeof a.version === 'string' && typeof b.version === 'string',
    JSON.stringify({ a, b }))
  check('后到的一次按复用返回同一实例', a.reused === false && b.reused === true,
    JSON.stringify({ aReused: a.reused, bReused: b.reused }))
  check('会话只有一个标签页', a.tabs === 1 && b.tabs === 1, JSON.stringify({ aTabs: a.tabs, bTabs: b.tabs }))
  const single = await waitUntil(() => edgeRootCount() <= before + 1, 10000)
  check('只新增一个 Edge 主进程', single && edgeRootCount() === before + 1, `before=${before} now=${edgeRootCount()}`)
  const blank = await navigate(requireSession('test-key-concurrent'), 'about:blank', 'load')
  check('并发启动后浏览器可正常导航', blank.url === 'about:blank', JSON.stringify(blank))
  await close('test-key-concurrent')
  const gone = await waitUntil(() => edgeRootCount() <= before, 15000)
  check('关闭后 Edge 主进程回落到基线', gone, `before=${before} now=${edgeRootCount()}`)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（应为 0），sessions ${JSON.stringify(activeSessionKeys())}`)
process.exit(fail === 0 ? 0 : 1)
