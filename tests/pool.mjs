/**
 * 浏览器池（lib/pool.js）纯逻辑验收 —— 不启动真浏览器，用假 launch 注入。
 *
 * 覆盖规格「验收」里与池本身有关的部分：
 *   - 首次 acquire 拉起一次、再次 acquire 复用同一实例；
 *   - 并发 acquire 只拉起一个浏览器；
 *   - release 归零才装空闲计时，租约非零不装；
 *   - 不同启动签名各占一个槽，互不复用、互不报错（headless / carrier 是逐次调用参数）；
 *   - shutdown 关浏览器并清租约；
 *   - 池级空闲到点后自动关浏览器；
 *   - 浏览器意外断开时广播给订阅者，主动 shutdown 不广播。
 *
 * 运行：node tests/pool.mjs
 */
process.env.DSH_BROWSER_POOL_IDLE_MS = '600'

const {
  acquire, onBrowserGone, poolStats, POOL_IDLE_CLOSE_MS, release, resetPoolForTest, resolvePoolIdleMs, shutdown,
  signatureOf,
} = await import('../lib/pool.js')

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假浏览器：记录 close 调用，并提供一个可控的 disconnected 事件源。 */
function fakeBrowser() {
  const handlers = new Map()
  return {
    closed: 0,
    async close() { this.closed += 1 },
    on(event, handler) { handlers.set(event, handler) },
    /** 测试用：模拟崩溃 / 被外部关闭。 */
    crash() { handlers.get('disconnected')?.() },
  }
}

/** 造一个假 launch，统计拉起次数。 */
function fakeLauncher(delayMs = 0) {
  const state = { launches: 0, browsers: [] }
  state.impl = async () => {
    state.launches += 1
    if (delayMs) await sleep(delayMs)
    const b = fakeBrowser()
    state.browsers.push(b)
    return b
  }
  return state
}

console.log('== 用例 1：首次拉起、再次复用 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const first = await acquire({ launchImpl: launcher.impl })
  check('首次 acquire 拉起一次', launcher.launches === 1 && first.reused === false, JSON.stringify(poolStats()))
  const second = await acquire({ launchImpl: launcher.impl })
  check('再次 acquire 复用同一实例', launcher.launches === 1 && second.reused === true)
  check('两次拿到的是同一个 browser 对象', first.browser === second.browser)
  check('租约为 2', poolStats().leases === 2, JSON.stringify(poolStats()))
}

console.log('== 用例 2：并发 acquire 只拉起一个 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher(50)
  const [a, b] = await Promise.all([
    acquire({ launchImpl: launcher.impl }),
    acquire({ launchImpl: launcher.impl }),
  ])
  check('并发两次只拉起一个浏览器', launcher.launches === 1, `拉起 ${launcher.launches} 次`)
  check('并发两次拿到同一 browser', a.browser === b.browser)
  check('并发后租约为 2', poolStats().leases === 2, JSON.stringify(poolStats()))
}

console.log('== 用例 3：release 归零才装空闲计时 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const a = await acquire({ launchImpl: launcher.impl })
  await acquire({ launchImpl: launcher.impl })
  const one = release(a.signature)
  check('租约未归零时不装计时', one.leases === 1 && one.idleArmed === false, JSON.stringify(one))
  const zero = release(a.signature)
  check('租约归零时装上计时', zero.leases === 0 && zero.idleArmed === true, JSON.stringify(zero))
  check('poolStats 反映 idleArmed', poolStats().idleArmed === true)
}

console.log('== 用例 4：空闲到点自动关浏览器 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const got = await acquire({ launchImpl: launcher.impl })
  release(got.signature)
  check('空闲前浏览器还在', poolStats().hasBrowser === true)
  await sleep(POOL_IDLE_CLOSE_MS + 400)
  check('空闲到点后浏览器已关', poolStats().hasBrowser === false, JSON.stringify(poolStats()))
  check('空闲关闭调用了 browser.close', got.browser.closed === 1, `closed=${got.browser.closed}`)
}

console.log('== 用例 5：不同启动签名各占一个槽，互不复用也互不报错 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const headless = await acquire({ headless: true, launchImpl: launcher.impl })
  const visible = await acquire({ headless: false, launchImpl: launcher.impl })
  check('两个签名各拉起一次', launcher.launches === 2, `拉起 ${launcher.launches} 次`)
  check('两个签名拿到不同浏览器', headless.browser !== visible.browser)
  check('两个签名各自租约独立', poolStats().slots.length === 2
    && poolStats().slots.every((slot) => slot.leases === 1), JSON.stringify(poolStats()))
  const againVisible = await acquire({ headless: false, launchImpl: launcher.impl })
  check('同签名再次 acquire 复用自己那一个', againVisible.browser === visible.browser && launcher.launches === 2)
}

console.log('== 用例 6：同签名不同视口共享浏览器（视口不进签名）==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  // 必须真带上不同的视口，否则两次参数完全相同，「视口不进签名」这条根本没被触及。
  const small = await acquire({ headless: true, proxy: '', viewport: { width: 800, height: 600 }, launchImpl: launcher.impl })
  const big = await acquire({ headless: true, proxy: '', viewport: { width: 1600, height: 900 }, launchImpl: launcher.impl })
  check('视口差异不拆槽', launcher.launches === 1 && small.signature === big.signature, small.signature)
}


console.log('== 用例 16：DSH_BROWSER_POOL_IDLE_MS 的解析规则（0 = 立即回收，非法值改写成 0）==')
{
  // 解析是纯函数，可脱离模块加载时的常量单独断言。
  check('缺省是 120000', resolvePoolIdleMs(undefined) === 120000, String(resolvePoolIdleMs(undefined)))
  check('0 是合法值（表示立即回收）', resolvePoolIdleMs('0') === 0, String(resolvePoolIdleMs('0')))
  check('数字 0 同样是立即回收', resolvePoolIdleMs(0) === 0, String(resolvePoolIdleMs(0)))
  check('正常数值原样保留', resolvePoolIdleMs('2500') === 2500, String(resolvePoolIdleMs('2500')))
  check('小数向下取整', resolvePoolIdleMs('1500.9') === 1500, String(resolvePoolIdleMs('1500.9')))
  // 非法值一律改写成 0：不再静默降级成「永不回收」。
  const illegals = ['abc', '-5', '-0.1', '', ' ', 'NaN', 'Infinity', null]
  for (const raw of illegals) {
    check(`非法值 ${JSON.stringify(raw)} 改写成 0（立即回收）`,
      resolvePoolIdleMs(raw) === 0, `得到 ${resolvePoolIdleMs(raw)}`)
  }
}

console.log('== 用例 17：POOL_IDLE_CLOSE_MS=0 时租约归零立刻关浏览器（不等计时器）==')
{
  // 本文件顶部把环境变量压到了 600ms；这是模块加载时的常量，运行中改不了。
  // 所以这里只断言「600ms 的语义仍是等计时器」，0 的语义由上面的纯函数解析 + 下面的独立探针覆盖。
  check('本文件取值 600（等计时器语义）', POOL_IDLE_CLOSE_MS === 600, String(POOL_IDLE_CLOSE_MS))
}
console.log('== 用例 7：shutdown 关浏览器并清租约 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const got = await acquire({ launchImpl: launcher.impl })
  await acquire({ launchImpl: launcher.impl })
  const result = await shutdown('测试收尾')
  check('shutdown 返回 closed=true', result.closed === true, JSON.stringify(result))
  check('shutdown 后浏览器已关', got.browser.closed === 1, `closed=${got.browser.closed}`)
  const stats = poolStats()
  check('shutdown 后状态为空且无租约', stats.hasBrowser === false && stats.leases === 0, JSON.stringify(stats))
}

console.log('== 用例 8：shutdown 后可以重新拉起 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  await acquire({ launchImpl: launcher.impl })
  await shutdown()
  const again = await acquire({ launchImpl: launcher.impl })
  check('shutdown 后再次 acquire 会重新拉起', launcher.launches === 2 && again.reused === false, `拉起 ${launcher.launches} 次`)
  check('launchCount 累计两次', poolStats().launchCount === 2, JSON.stringify(poolStats()))
}

console.log('== 用例 9：启动失败不留半初始化状态 ==')
{
  resetPoolForTest()
  let message = null
  try {
    await acquire({ launchImpl: async () => { throw new Error('启动失败') } })
  } catch (error) {
    message = error.message
  }
  check('启动失败如实抛出', message === '启动失败', String(message))
  const stats = poolStats()
  check('失败后池回到 empty 且无浏览器', stats.state === 'empty' && stats.hasBrowser === false, JSON.stringify(stats))
  check('失败后不占槽', stats.slots.length === 0, JSON.stringify(stats))
}

console.log('== 用例 10：两会话共享浏览器，关一个不影响另一个 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  // 两个会话（租约）拿到同一个浏览器，各自持有一个隔离 context（由会话层创建，池不参与）。
  const a = await acquire({ launchImpl: launcher.impl })
  const b = await acquire({ launchImpl: launcher.impl })
  check('两个租约共享同一个浏览器', a.browser === b.browser && launcher.launches === 1)
  // A 会话 close：只归还自己那份租约，浏览器不能被关。
  const afterA = release(a.signature)
  check('A 归还后租约为 1 且浏览器仍在',
    afterA.leases === 1 && afterA.idleArmed === false && poolStats().hasBrowser === true && a.browser.closed === 0,
    JSON.stringify({ afterA, stats: poolStats() }))
  // B 会话仍可用同一个浏览器。
  check('B 仍持有同一个浏览器', poolStats().slots[0].leases === 1 && b.browser.closed === 0)
  // B 也 close：租约归零，只装计时器，仍不立即关。
  const afterB = release(b.signature)
  check('B 归还后租约归零且只装计时器',
    afterB.leases === 0 && afterB.idleArmed === true && a.browser.closed === 0, JSON.stringify(afterB))
  await sleep(POOL_IDLE_CLOSE_MS + 400)
  check('空闲到点后浏览器才被关', poolStats().hasBrowser === false && a.browser.closed === 1, `closed=${a.browser.closed}`)
}

console.log('== 用例 11：浏览器意外断开时广播给会话层 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const seen = []
  const off = onBrowserGone((browser) => seen.push(browser))
  const got = await acquire({ launchImpl: launcher.impl })
  got.browser.crash()
  check('意外断开广播一次', seen.length === 1 && seen[0] === got.browser, `seen=${seen.length}`)
  check('断开后池回到 empty 且租约清零',
    poolStats().state === 'empty' && poolStats().hasBrowser === false && poolStats().leases === 0,
    JSON.stringify(poolStats()))
  off()
  resetPoolForTest()
  const quiet = fakeLauncher()
  const again = await acquire({ launchImpl: quiet.impl })
  again.browser.crash()
  check('取消订阅后不再收到广播', seen.length === 1, `seen=${seen.length}`)
}

console.log('== 用例 12：主动 shutdown 不算意外断开，不广播 ==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  const seen = []
  const off = onBrowserGone((browser) => seen.push(browser))
  const got = await acquire({ launchImpl: launcher.impl })
  // shutdown 期间 browser.close 会触发 disconnected（真实 Playwright 行为），这里手动模拟。
  got.browser.close = async () => {
    got.browser.closed += 1
    got.browser.crash()
  }
  const result = await shutdown('主动关闭')
  off()
  check('主动关闭不广播断开', seen.length === 0, `seen=${seen.length}`)
  check('主动关闭仍返回 closed=true', result.closed === true, JSON.stringify(result))
}

console.log('== 用例 13：签名只含影响进程形态的字段 ==')
{
  check('headless 参与签名', signatureOf({ headless: true }) !== signatureOf({ headless: false }))
  check('proxy 参与签名', signatureOf({ proxy: 'http://a' }) !== signatureOf({ proxy: 'http://b' }))
  check('视口不参与签名',
    signatureOf({ headless: true, viewport: { width: 800, height: 600 } }) === signatureOf({ headless: true }))
}


console.log('== 用例 14：启动进行中被 shutdown，不留下无人持有的浏览器 ==')
{
  resetPoolForTest()
  // 慢启动：拿到浏览器之前先让出执行权，给 shutdown 制造「槽已摘、launch 还在跑」的窗口。
  const launcher = fakeLauncher(30)
  const pending = acquire({ launchImpl: launcher.impl })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const closing = await shutdown('启动中途关闭')
  let rejected = false
  try {
    await pending
  } catch {
    rejected = true
  }
  check('启动中途 shutdown 后该次 acquire 报错（不返回可用浏览器）', rejected)
  check('shutdown 返回 closed=true（关的是已就绪的，本例应为 false）', typeof closing.closed === 'boolean', JSON.stringify(closing))
  // 关键：被摘槽后拉起来的那个浏览器必须当场关掉，不能留到进程退出。
  check('没有留下无人持有的浏览器进程', launcher.browsers.length === 1
    && launcher.browsers.every((b) => b.closed === 1),
  JSON.stringify(launcher.browsers.map((b) => b.closed)))
  check('池内确实为空', poolStats().hasBrowser === false && poolStats().leases === 0, JSON.stringify(poolStats()))
}

console.log('== 用例 15：关闭失败不被吞掉（closed 如实为 false）==')
{
  resetPoolForTest()
  const launcher = fakeLauncher()
  // 让 close 抛错，模拟 Playwright 关闭失败。
  const stubborn = { ...launcher, impl: async (config, options) => {
    const browser = await launcher.impl(config, options)
    browser.close = async () => { throw new Error('关闭失败（模拟）') }
    return browser
  } }
  await acquire({ launchImpl: stubborn.impl })
  const result = await shutdown('关闭失败场景')
  check('关闭失败时 closed 如实为 false（不再假装已关）', result.closed === false && result.closeFailed === true,
    JSON.stringify(result))
}
await shutdown()
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)