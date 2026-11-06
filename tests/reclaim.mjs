/**
 * dsh-browser-e2e 回收行为验证：空闲超时 + session/disposed 两条回收路径。
 *
 * 直接调用 browser.js 的真实实现（不 mock），每条用例都真起一个无头 Edge，
 * 断言「会话状态被清空」且「Edge 子进程已退出」。
 *
 * 不该被安装进 profile（package.json 的 files 只含 lib 与 cordis.patch.yml）。
 * 运行：node tests/reclaim.mjs
 */
import { spawnSync } from 'node:child_process'

// 用例 A 依赖 8 秒空闲回收；browser.js 在模块加载时读取该环境变量，
// 所以必须在动态 import 之前设置（ESM 的静态 import 会先于模块体执行）。
process.env.DSH_BROWSER_IDLE_MS ??= '8000'

const {
  activeSessionKeys, close, closeBySessionId, launch, navigate,
} = await import('../lib/browser.js')

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

console.log('== 用例 A：空闲超时自动回收（DSH_BROWSER_IDLE_MS=8000）==')
{
  const before = edgeRootCount()
  const id = 'test-session-idle'
  await launch('test-key-idle', { headless: true }, id)
  await navigate('test-key-idle', 'about:blank', 'load', id)
  check('启动后 sessions 持有该会话', activeSessionKeys().includes('test-key-idle'), JSON.stringify(activeSessionKeys()))
  check('启动后 Edge 主进程增加', edgeRootCount() > before, `before=${before} now=${edgeRootCount()}`)
  console.log('  等待 8s 空闲超时 + 2s 收敛…')
  await sleep(10000)
  check('超时后 sessions 已清空', !activeSessionKeys().includes('test-key-idle'), JSON.stringify(activeSessionKeys()))
  check('超时后 Edge 主进程已回落', edgeRootCount() <= before, `before=${before} now=${edgeRootCount()}`)
}

console.log('== 用例 B：session/disposed 钩子回收（同一条 closeBySessionId 路径）==')
{
  const before = edgeRootCount()
  const id = 'test-session-disposed'
  await launch('test-key-disposed', { headless: true }, id)
  await navigate('test-key-disposed', 'about:blank', 'load', id)
  check('启动后 sessions 持有该会话', activeSessionKeys().includes('test-key-disposed'), JSON.stringify(activeSessionKeys()))
  const r = await closeBySessionId(id)
  check('disposed 路径返回 closed=true', r.closed === true, JSON.stringify(r))
  check('disposed 后 sessions 已清空', !activeSessionKeys().includes('test-key-disposed'), JSON.stringify(activeSessionKeys()))
  await sleep(1500)
  check('disposed 后 Edge 主进程已回落', edgeRootCount() <= before, `before=${before} now=${edgeRootCount()}`)
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
  await sleep(1500)
  check('显式 close 后 Edge 主进程已回落', edgeRootCount() <= before, `before=${before} now=${edgeRootCount()}`)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（应为 0），sessions ${JSON.stringify(activeSessionKeys())}`)
process.exit(fail === 0 ? 0 : 1)
