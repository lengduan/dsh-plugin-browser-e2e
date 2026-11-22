/**
 * 池级空闲窗口内的多会话接入（必须独立进程：POOL_IDLE_CLOSE_MS 在模块导入时读定）。
 * 运行（由 tests/pool-concurrency.mjs 以子进程拉起，需设 DSH_BROWSER_POOL_IDLE_MS=5000）：node tests/pool-concurrency-child.mjs
 */
process.env.DSH_BROWSER_IDLE_MS = '600000'
process.env.DSH_BROWSER_HISTORY = '0'

const { buildToolTable, withOutput } = await import('../lib/tools.js')
const { activeSessionKeys } = await import('../lib/session.js')
const { poolStats } = await import('../lib/pool.js')

const table = withOutput(buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) }))
const tool = (name) => (args, exec) => table.find((d) => d.name === name).run(args, exec)
const start = tool('browser_e2e_start')
const closeTool = tool('browser_e2e_close')
const execOf = (id) => ({ agent: { id } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const fails = []
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + label) }
  else { fails.push(label + (detail ? ' —— ' + detail : '')); console.log('FAIL  ' + label + (detail ? ' —— ' + detail : '')) }
}

console.log('POOL_IDLE=' + (await import('../lib/pool.js')).POOL_IDLE_CLOSE_MS + 'ms')
await start({ headless: true }, execOf('idle-a'))
const launches = poolStats().launchCount
await closeTool({}, execOf('idle-a'))
check('租约归零后浏览器仍在（空闲计时未到点）', poolStats().hasBrowser === true && poolStats().leases === 0, JSON.stringify(poolStats()))
check('已装上池级空闲计时', poolStats().idleArmed === true, 'idleArmed=' + poolStats().idleArmed)

await start({ headless: true }, execOf('idle-b'))
check('计时窗口内接入没有新拉起浏览器', poolStats().launchCount === launches, 'launchCount=' + poolStats().launchCount + ' before=' + launches)
check('接入后空闲计时被取消', poolStats().idleArmed === false, 'idleArmed=' + poolStats().idleArmed)
check('计时窗口内接入的会话在注册表', activeSessionKeys().includes('idle-b'), JSON.stringify(activeSessionKeys()))
await closeTool({}, execOf('idle-b'))

// 到点后应真的回收
await sleep(6500)
check('空闲到点后浏览器被回收', poolStats().hasBrowser === false, JSON.stringify(poolStats()))

// 回收后再接入必须重新拉起（且只拉 1 次）
const before = poolStats().launchCount
await start({ headless: true }, execOf('idle-c'))
check('回收后接入重新冷启 1 次', poolStats().launchCount === before + 1, 'delta=' + (poolStats().launchCount - before))
await closeTool({}, execOf('idle-c'))

console.log('合计 ' + pass + ' PASS / ' + fails.length + ' FAIL')
for (const f of fails) console.log('  - ' + f)
process.exitCode = fails.length === 0 ? 0 : 1