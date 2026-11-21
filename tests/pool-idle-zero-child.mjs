/**
 * tests/pool-idle-zero.mjs 的子进程探针：按当前环境变量加载池，acquire 一份租约后立刻 release，
 * 等 60ms 后把观测结果打到 stdout（最后一行 JSON）。
 *
 * 单独成文件是为了让 POOL_IDLE_CLOSE_MS 以子进程自己的环境变量求值——
 * 它是模块加载时的常量，同进程内改不了。
 */
const { acquire, release, poolStats, resetPoolForTest, POOL_IDLE_CLOSE_MS } = await import('../lib/pool.js')

function fakeBrowser() {
  return { closed: 0, on() {}, async close() { this.closed += 1 }, async newContext() { return {} } }
}

resetPoolForTest()
const got = await acquire({ launchImpl: async () => fakeBrowser() })
release(got.signature)
const idleArmed = poolStats().idleArmed
const hasBrowserRightAfter = poolStats().hasBrowser
await new Promise((resolve) => setTimeout(resolve, 60))
console.log(JSON.stringify({
  ms: Number.isFinite(POOL_IDLE_CLOSE_MS) ? POOL_IDLE_CLOSE_MS : String(POOL_IDLE_CLOSE_MS),
  idleArmed,
  hasBrowserRightAfter,
  hasBrowser: poolStats().hasBrowser,
  closed: got.browser.closed,
}))
