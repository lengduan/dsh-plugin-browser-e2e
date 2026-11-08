/**
 * dsh-browser-e2e —— 全局浏览器端到端验证工具集。
 *
 * 本文件只做注册与生命周期：插件级 Config、按 lib/tools.js 的工具表注册工具、
 * session/disposed 与卸载回收、面板路由挂载。工具实现与协议见对应模块。
 *
 * 用系统 Edge（channel: 'msedge'）驱动，不触发 360 主动防御弹窗。
 * 装进 DSH profile 后对所有会话与工作区可用，无需目标项目安装任何依赖。
 *
 * @module dsh-browser-e2e
 */
import { closeAll, closeBySessionId } from './session.js'
import { setConnectionResolver } from './auth.js'
import { buildToolTable, HISTORY_TOOL_NAME, sessionKey, summaryOf, withOutput } from './tools.js'
import { appendAction } from './history.js'
import { accessModeOf, allowScriptOf, decide, toolNamesWithAccess } from './gate.js'
import { PanelHub } from './panel.js'
import { DEFAULT_CDP_ENDPOINT } from './defaults.js'
import { CARRIERS } from './carrier.js'
import { DEFAULT_SCREENCAST_CONFIG, PANEL_CONFIG_LIMITS } from './protocol.js'

/** 插件名（cordis 插件契约）。 */
export const name = 'browser-e2e'

/** 等待工具注册表就绪。 */
export const inject = ['tools']

// 插件级配置项依赖 schemastery 生成 schema。它写在 package.json 的 dependencies 里，
// 但运行期由宿主 profile 提供（desktop profile 已显式安装）；解析失败时导出 undefined，
// 宿主按「无配置」处理。
let Schema
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = undefined
}

/**
 * 插件级配置项：启动模式、CDP 端点与面板投屏参数。
 *
 * 全部字段用 `.volatile()` 声明成「即时字段」：设置页保存时宿主只替换配置引用
 * 里的快照、不重载插件，所以 apply 里读到的是引用（`{ get() }`），运行中的面板
 * 靠 loader/volatile-update 事件跟进。
 */
export const Config = Schema ? Schema.object({
  defaultMode: Schema.union(['isolated', 'cdp']).default('isolated').volatile()
    .description('启动模式：isolated（默认）或 cdp'),
  cdpEndpoint: Schema.string().default(DEFAULT_CDP_ENDPOINT).volatile()
    .description(`CDP 模式接管的 http 端点，默认 ${DEFAULT_CDP_ENDPOINT}；只允许 loopback`),
  defaultCarrier: Schema.union(['edge', 'chrome', 'auto']).volatile()
    .description('隔离模式的浏览器载体：edge（默认，系统 Edge）/ chrome（本机 Google Chrome）/ '
      + 'auto（优先 Chrome，找不到回退 Edge）；缺失取 edge，非法值按 edge 处理'),
  quality: Schema.number().volatile()
    .description(`投屏 JPEG 质量 ${PANEL_CONFIG_LIMITS.quality[0]}-${PANEL_CONFIG_LIMITS.quality[1]}，`
      + `越界或缺失回退默认 ${DEFAULT_SCREENCAST_CONFIG.quality}`),
  maxWidth: Schema.number().volatile()
    .description(`投屏最大宽度（像素）${PANEL_CONFIG_LIMITS.maxWidth[0]}-${PANEL_CONFIG_LIMITS.maxWidth[1]}，`
      + `越界或缺失回退默认 ${DEFAULT_SCREENCAST_CONFIG.maxWidth}`),
  maxHeight: Schema.number().volatile()
    .description(`投屏最大高度（像素）${PANEL_CONFIG_LIMITS.maxHeight[0]}-${PANEL_CONFIG_LIMITS.maxHeight[1]}，`
      + `越界或缺失回退默认 ${DEFAULT_SCREENCAST_CONFIG.maxHeight}`),
  everyNthFrame: Schema.number().volatile()
    .description(`每 N 帧投屏一帧 ${PANEL_CONFIG_LIMITS.everyNthFrame[0]}-${PANEL_CONFIG_LIMITS.everyNthFrame[1]}，`
      + `越界或缺失回退默认 ${DEFAULT_SCREENCAST_CONFIG.everyNthFrame}`),
  accessMode: Schema.union(['full', 'readonly']).volatile()
    .description('工具权限档位：full（默认，全部可用）或 readonly（只放行观察类工具；'
      + '缺失取 full，非法值按 readonly 处理）'),
  allowScript: Schema.boolean().volatile()
    .description('是否允许页面脚本求值（browser_e2e_evaluate 与 browser_e2e_wait 的 expression 条件），'
      + '默认 true；缺失取 true，非法值按 false 处理'),
}) : undefined

/**
 * 读取插件级配置里的一个字段的值。
 *
 * Config schema 用 `.volatile()` 声明的字段在宿主里是稳定引用：保存设置页时宿主
 * 只替换引用里的快照、不重载插件，因此这里必须经 `get()` 取当前值；测试与无宿主
 * 场景传的是原始值，原样返回。
 * @param {unknown} raw - apply 收到的配置字段
 * @returns {unknown}
 */
function configValue(raw) {
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch {
      return undefined
    }
  }
  return raw
}

/**
 * 从插件级配置里取启动缺省值。
 *
 * 宿主按 Cordis 约定把校验后的配置作为 apply 的第二个参数传入（无配置时为 undefined
 * 或空对象）。这里只接受合法值：mode 只认 isolated / cdp；carrier 只认 edge / chrome / auto；
 * endpoint 必须是非空字符串，非法值当作未配置，保持 isolated + 默认端点的既有行为。
 * @param {unknown} config - apply 收到的插件级配置
 * @returns {{mode?: 'isolated'|'cdp', cdpEndpoint?: string, carrier?: 'edge'|'chrome'|'auto'}}
 */
function launchDefaultsOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const defaults = {}
  const mode = configValue(source.defaultMode)
  if (mode === 'isolated' || mode === 'cdp') {
    defaults.mode = mode
  }
  const endpoint = configValue(source.cdpEndpoint)
  if (typeof endpoint === 'string' && endpoint.trim() !== '') {
    defaults.cdpEndpoint = endpoint
  }
  const carrier = configValue(source.defaultCarrier)
  if (CARRIERS.includes(carrier)) {
    defaults.carrier = carrier
  }
  return defaults
}

/**
 * 从插件级配置里取面板投屏参数。
 *
 * 只把四个投屏字段摊平成普通值交给 PanelHub：合法性与默认值的判定统一在
 * PanelHub 里按 protocol.js 的区间表做，避免两处口径分叉。
 * @param {unknown} config - apply 收到的插件级配置
 * @returns {{quality?: unknown, maxWidth?: unknown, maxHeight?: unknown, everyNthFrame?: unknown}}
 */
function screencastConfigOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    quality: configValue(source.quality),
    maxWidth: configValue(source.maxWidth),
    maxHeight: configValue(source.maxHeight),
    everyNthFrame: configValue(source.everyNthFrame),
  }
}

/**
 * 从插件级配置里取工具门控参数。
 *
 * 与投屏四项不同：门控项缺失取缺省，非法值取更严的一端（fail-closed），
 * 并由 apply 输出一次 warn；口径见功能规格 0023 与 0006 的对照说明。
 * @param {unknown} config - apply 收到的插件级配置
 * @returns {{accessMode: 'full'|'readonly', allowScript: boolean, illegal: boolean}}
 */
function gateConfigOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const mode = accessModeOf(configValue(source.accessMode))
  const script = allowScriptOf(configValue(source.allowScript))
  return { accessMode: mode.mode, allowScript: script.allowScript, illegal: mode.illegal || script.illegal }
}

/**
 * 插件入口：注册工具、挂生命周期、挂面板路由。
 * @param {object} ctx - 插件上下文
 * @param {unknown} config - 插件级配置
 */
export function apply(ctx, config) {
  // 插件级配置用 getter 读取：设置页保存只替换配置引用里的快照、不重载插件，
  // 因此每次 start 都重新读，改 defaultMode / cdpEndpoint 后对后续启动即时生效。
  const launchDefaults = () => launchDefaultsOf(config)

  // 面板宿主：维护 socket 客户端、tab 状态与投屏。它不改变工具的参数与返回值，
  // 只在工具执行后广播一条动作摘要、并顺带刷新一次 tab 状态。
  // 投屏参数取自插件级配置，非法值由 PanelHub 按区间表逐字段回退默认。
  const hub = new PanelHub({ config: screencastConfigOf(config) })

  // 设置页保存投屏参数时宿主走即时字段通道：不卸载插件，只更新配置引用并广播
  // loader/volatile-update。这里重读同一份引用的最新快照，推给正在运行的面板。
  ctx.on('loader/volatile-update', () => {
    void hub.applyConfig(screencastConfigOf(config))
  })

  // M7：导航命中登录挑战时向 connection 服务要带 launch-token 的地址。
  // 不写进 inject：服务不存在时每次读取返回 undefined，补票静默跳过。
  setConnectionResolver(() => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined))

  // 工具表是唯一声明处；这里只负责注册与「工具执行后广播面板动作」这层编排。
  // 动作历史与面板广播同源：成功取 summaryOf，失败取「失败：…」，写入前由 history.js 脱敏。
  // browser_e2e_history 自身不记录，避免「读历史」这个动作反复进入历史。
  const recordAction = (definition, summary, ok, args, exec) => {
    if (definition.name === HISTORY_TOOL_NAME) return
    appendAction({
      tool: definition.name,
      summary,
      args,
      ok,
      session: sessionKey(exec),
    })
  }
  const toolTable = withOutput(buildToolTable({ ctx, launchDefaults }))
  // 只读模式的拒绝文案要列出可用工具，从同一张表派生，避免第二份清单。
  const observeNames = toolNamesWithAccess(toolTable, 'observe')
  // 门控配置每次调用现读：volatile 字段保存后下一次调用即生效。
  const gateConfigOfCall = () => gateConfigOf(config)
  // 非法配置只在首次被判定时提示一次，避免每次调用刷屏；静默不等于放行。
  let gateWarned = false
  const warnIllegalGateConfig = () => {
    if (gateWarned) return
    gateWarned = true
    ctx.logger?.('browser-e2e')?.warn?.(
      '插件设置 accessMode / allowScript 存在非法值，已按更严的一端处理（readonly / false）；请在设置页修正。',
    )
  }
  for (const definition of toolTable) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output,
      async execute(args, exec) {
        const input = args ?? {}
        const context = exec ?? {}
        // 门控在 definition.run 之前：被拒调用不产生页面动作、不刷新空闲计时、不写会话状态。
        const gateConfig = gateConfigOfCall()
        if (gateConfig.illegal) warnIllegalGateConfig()
        const decision = decide({
          definition,
          args: input,
          accessMode: gateConfig.accessMode,
          allowScript: gateConfig.allowScript,
          observeNames,
        })
        if (!decision.allowed) {
          hub.broadcastAction(definition.name, `被拒绝：${decision.summary}`)
          recordAction(definition, `被拒绝：${decision.summary}`, false, input, context)
          throw new Error(decision.message)
        }
        try {
          const value = await definition.run(input, context)
          const summary = summaryOf(value)
          hub.broadcastAction(definition.name, summary)
          hub.scheduleSync()
          recordAction(definition, summary, true, input, context)
          return value
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const summary = `失败：${message}`
          hub.broadcastAction(definition.name, summary)
          recordAction(definition, summary, false, input, context)
          throw error
        }
      },
    })
  }

  // 会话销毁时回收它的浏览器：显式 browser_e2e_close 之外的第二道保险。
  ctx.on('session/disposed', (session) => {
    void closeBySessionId(session?.id)
  })

  // 插件卸载/热替换时清理所有浏览器（cordis effect 的返回值即清理函数）
  ctx.effect(() => () => {
    void closeAll()
  })

  // 面板路由只挂在提供 webServer 的宿主上（GUI）。CLI 场景没有 webServer，
  // 工具照常可用，只是没有右侧面板。
  const mountPanel = (webCtx) => {
    webCtx.effect(() => {
      const { routes, upgrade } = hub.routes()
      const disposers = routes.map((route) => webCtx.webServer.register(route))
      const disposeUpgrade = webCtx.webServer.registerUpgrade(upgrade)
      return () => {
        for (const dispose of disposers) dispose()
        disposeUpgrade()
      }
    }, 'browser-e2e: panel routes')
  }
  if (typeof ctx.inject === 'function') {
    // 标准路径：webServer 服务晚于插件加载时也能等它就绪再挂。
    ctx.inject(['webServer'], (webCtx) => mountPanel(webCtx))
  } else if (typeof ctx.get === 'function' && ctx.get('webServer') !== undefined) {
    // 老宿主没有 ctx.inject：apply 时服务已在就直接挂。
    mountPanel({ webServer: ctx.get('webServer'), effect: (fn) => ctx.effect(fn) })
  }

  // 插件卸载时断开面板连接与投屏。
  ctx.effect(() => () => hub.dispose())
}
