/**
 * CDP 投屏：把浏览器页面变成面板里的实时画面。
 *
 * 走 Chrome DevTools 协议的 `Page.startScreencast`：页面变化时浏览器主动推一帧
 * JPEG，收到帧后必须回 `Page.screencastFrameAck`，否则浏览器不再推下一帧。
 * 投屏只作用于当前选中的 tab；切换 tab 或关闭浏览器时停止并断开 CDP 会话。
 *
 * 这里是进程内实现，不改变任何 browser_* 工具的行为与返回值。
 */
import { DEFAULT_SCREENCAST_CONFIG } from './protocol.js'

/**
 * 单个 tab 的投屏会话。
 *
 * 同一时刻最多持有一个 CDP 会话：start / stop 都排进同一条串行队列，
 * 并发起停不会交错，因此结构上保证不会有两个页面同时推帧。
 */
export class Screencast {
  /**
   * @param {{onFrame?: (frame: {tabId: string, width: number, height: number, data: string}) => void,
   *          onError?: (code: string, error: unknown) => void}} [handlers] - 帧与错误回调
   */
  constructor(handlers = {}) {
    this.onFrame = handlers.onFrame ?? (() => {})
    this.onError = handlers.onError ?? (() => {})
    /** 正在投屏的 tab id。 */
    this.tabId = null
    /** 当前 CDP 会话绑定的页面对象，用于识别「同一个 key 但页面已经换了」。 */
    this.page = null
    /** @type {import('playwright-core').CDPSession | null} */
    this.cdp = null
    /** 命令串行队列：前一个任务失败不影响后续任务入队。 */
    this.queue = Promise.resolve()
  }

  /**
   * 把一次操作排进串行队列。
   * @param {() => Promise<unknown>} task - 待执行任务
   * @returns {Promise<unknown>} 该任务的执行结果
   */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => {}, () => {})
    return run
  }

  /**
   * 开始投屏（自动停掉上一个）。
   * @param {string} tabId - 面板 tab id（会话 key#tab_id）
   * @param {import('playwright-core').Page | null} page - 该 tab 的页面对象；没有页面时返回 false
   * @param {typeof DEFAULT_SCREENCAST_CONFIG} config - 投屏参数
   * @returns {Promise<boolean>} 已开始返回 true；没有页面或失败返回 false
   */
  async start(tabId, page, config = DEFAULT_SCREENCAST_CONFIG) {
    return this.enqueue(() => this._start(tabId, page, config))
  }

  /**
   * 真正开始投屏：先停掉旧会话（由串行队列保证不会与另一次 start 交错）。
   * @param {string} tabId - 面板 tab id
   * @param {import('playwright-core').Page | null} page - 页面对象
   * @param {typeof DEFAULT_SCREENCAST_CONFIG} config - 投屏参数
   * @returns {Promise<boolean>} 已开始返回 true
   */
  async _start(tabId, page, config) {
    await this._stop()
    if (!page) return false
    let cdp
    try {
      cdp = await page.context().newCDPSession(page)
    } catch (error) {
      this.onError('screencast-failed', error)
      return false
    }
    this.tabId = tabId
    this.page = page
    this.cdp = cdp
    cdp.on('Page.screencastFrame', (params) => {
      // 旧会话的迟到帧直接丢弃，避免切 tab 后画面串台。
      if (this.cdp !== cdp) return
      const metadata = params?.metadata ?? {}
      this.onFrame({
        tabId,
        width: Number(metadata.deviceWidth) || 0,
        height: Number(metadata.deviceHeight) || 0,
        data: String(params?.data ?? ''),
      })
      void cdp.send('Page.screencastFrameAck', { sessionId: params?.sessionId }).catch(() => {})
    })
    try {
      await cdp.send('Page.enable')
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: config.quality,
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight,
        everyNthFrame: config.everyNthFrame,
      })
    } catch (error) {
      await this._stop()
      this.onError('screencast-failed', error)
      return false
    }
    return true
  }

  /** 停止投屏并断开 CDP 会话（排队执行，重复调用安全）。 */
  async stop() {
    return this.enqueue(() => this._stop())
  }

  /**
   * 真正停止投屏并断开 CDP 会话（由串行队列保证不并发）。
   * @returns {Promise<void>}
   */
  async _stop() {
    const cdp = this.cdp
    this.cdp = null
    this.tabId = null
    this.page = null
    if (!cdp) return
    try {
      await cdp.send('Page.stopScreencast')
    } catch {
      // 页面可能已经关掉，忽略
    }
    try {
      await cdp.detach()
    } catch {
      // 同上
    }
  }
}
