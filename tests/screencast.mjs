/**
 * 投屏与面板命令的并发行为验证（纯假实现，不启动浏览器）。
 *
 * 覆盖：
 *   - Screencast 的 start / stop 串行队列：并发两次 start 最终只保留一个 CDP 会话，
 *     前一个已 stop 并 detach；start 后立刻 stop 也按顺序收尾。
 *   - Screencast 的失败路径不留 CDP 会话、错误回调带上 code。
 *   - PanelHub.enqueue 串行执行（两个 async 任务不重叠）。
 *   - PanelHub.accept 对连续两条原始帧按顺序处理，且 first 标志在调度时确定。
 *
 * 运行：node tests/screencast.mjs
 */
const { Screencast } = await import('../lib/screencast.js')
const { PanelHub } = await import('../lib/panel.js')

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

/** 假 CDP 会话：记录 send 过的方法，detach 置位。 */
class FakeCdp {
  constructor(label) {
    this.label = label
    this.sent = []
    this.detached = false
    this.frameHandler = null
  }

  on(event, handler) {
    if (event === 'Page.screencastFrame') this.frameHandler = handler
  }

  async send(method) {
    this.sent.push(method)
    return {}
  }

  async detach() {
    this.detached = true
  }

  /** 模拟浏览器推一帧（用于验证旧会话的迟到帧被丢弃）。 */
  emitFrame(params) {
    this.frameHandler?.(params)
  }
}

/** 假页面：只提供 newCDPSession 入口。 */
function fakePage(cdp) {
  return { context: () => ({ newCDPSession: async () => cdp }) }
}

const config = { quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }

console.log('== 用例 A：Screencast 串行队列 ==')
{
  const screencast = new Screencast()
  const cdpA = new FakeCdp('a')
  const cdpB = new FakeCdp('b')
  // 不 await 第一次 start 就发第二次：旧会话必须先停掉，最终只留后一次。
  const [first, second] = await Promise.all([
    screencast.start('s#t1', fakePage(cdpA), config),
    screencast.start('s#t2', fakePage(cdpB), config),
  ])
  check('并发两次 start 都返回 true', first === true && second === true, `${first} / ${second}`)
  check('最终 tabId 是后一次请求', screencast.tabId === 's#t2', String(screencast.tabId))
  check('最终只保留后一个 CDP 会话', screencast.cdp === cdpB, String(screencast.cdp?.label))
  check('前一个 CDP 会话已 stop 并 detach',
    cdpA.detached === true && cdpA.sent.includes('Page.stopScreencast'), JSON.stringify(cdpA.sent))
  check('两个会话各成功 start 一次',
    cdpA.sent.includes('Page.startScreencast') && cdpB.sent.includes('Page.startScreencast'),
    `${JSON.stringify(cdpA.sent)} / ${JSON.stringify(cdpB.sent)}`)
  // 旧会话的迟到帧不能推给面板。
  const frames = []
  screencast.onFrame = (frame) => frames.push(frame)
  cdpA.emitFrame({ metadata: { deviceWidth: 1, deviceHeight: 1 }, data: 'OLD', sessionId: 1 })
  cdpB.emitFrame({ metadata: { deviceWidth: 2, deviceHeight: 2 }, data: 'NEW', sessionId: 2 })
  await sleep(10)
  check('旧会话迟到帧被丢弃、新会话帧正常上报',
    frames.length === 1 && frames[0].tabId === 's#t2' && frames[0].data === 'NEW', JSON.stringify(frames))
  await screencast.stop()
  check('stop 后 cdp / tabId 清空且已 detach', screencast.cdp === null && screencast.tabId === null && cdpB.detached === true)
}

console.log('== 用例 B：start 后立刻 stop 排队执行 ==')
{
  const screencast = new Screencast()
  const cdp = new FakeCdp('c')
  const started = screencast.start('s#t1', fakePage(cdp), config)
  const stopped = screencast.stop()
  const [ok] = await Promise.all([started, stopped])
  check('start 成功但随后被 stop 收掉', ok === true && screencast.cdp === null && cdp.detached === true,
    `${ok} / ${String(screencast.cdp)} / ${cdp.detached}`)
}

console.log('== 用例 C：Screencast 失败与空页面 ==')
{
  const screencast = new Screencast()
  check('没有页面时 start 返回 false 且不留会话',
    (await screencast.start('s#t1', null)) === false && screencast.cdp === null)
  const errors = []
  const failingScreencast = new Screencast({ onError: (code, error) => errors.push({ code, message: error?.message }) })
  const failingPage = { context: () => ({ newCDPSession: async () => { throw new Error('newCDPSession 失败（模拟）') } }) }
  const result = await failingScreencast.start('s#t1', failingPage, config)
  check('newCDPSession 失败：返回 false、不留 CDP 会话、报 screencast-failed',
    result === false && failingScreencast.cdp === null && errors[0]?.code === 'screencast-failed'
      && errors[0]?.message.includes('newCDPSession 失败'), JSON.stringify(errors))
}

console.log('== 用例 D：PanelHub 命令串行队列 ==')
{
  const hub = new PanelHub()
  let running = 0
  let maxRunning = 0
  const order = []
  const makeTask = (label, delay) => async () => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    order.push(`${label}-start`)
    await sleep(delay)
    order.push(`${label}-end`)
    running -= 1
  }
  const first = hub.enqueue(makeTask('a', 30))
  const second = hub.enqueue(makeTask('b', 5))
  await Promise.all([first, second])
  check('两个 async 任务不重叠（最大并发 1）', maxRunning === 1, String(maxRunning))
  check('任务按入队顺序执行', order.join(',') === 'a-start,a-end,b-start,b-end', order.join(','))

  // 前一个任务抛错不阻塞后续入队。
  const rejected = hub.enqueue(async () => {
    throw new Error('boom')
  }).catch((error) => error.message)
  const after = hub.enqueue(async () => 'after')
  check('任务失败不影响后续任务', (await rejected) === 'boom' && (await after) === 'after')

  // 连续两条原始帧按顺序处理，first 只在第一帧为 true。
  const calls = []
  hub.handleRawFrame = async (sink, raw, isFirst) => {
    calls.push({ raw, first: isFirst })
    if (raw === 'one') await sleep(30)
    return 'accept'
  }
  const ws = {
    readyState: 1,
    handlers: {},
    sent: [],
    on(event, handler) {
      this.handlers[event] = handler
    },
    send(data) {
      this.sent.push(data)
    },
    close() {},
  }
  hub.accept(ws)
  ws.handlers.message('one')
  ws.handlers.message('two')
  const deadline = Date.now() + 2000
  while (calls.length < 2 && Date.now() < deadline) await sleep(10)
  check('两条原始帧按到达顺序处理且不交错',
    calls.length === 2 && calls[0].raw === 'one' && calls[1].raw === 'two', JSON.stringify(calls))
  check('first 标志在调度时确定（首帧 true、次帧 false）',
    calls[0]?.first === true && calls[1]?.first === false, JSON.stringify(calls))
  hub.dispose()
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
