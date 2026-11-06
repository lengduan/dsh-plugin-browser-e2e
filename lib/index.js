/**
 * dsh-browser-e2e —— 全局浏览器端到端验证工具集。
 *
 * 提供 browser_e2e_* 工具（启动/导航/标签页/快照/点击/填充/滚动/按键/截图/求值/等待/关闭），
 * 用系统 Edge（channel: 'msedge'）驱动，不触发 360 主动防御弹窗。
 * 装进 DSH profile 后对所有会话与工作区可用，无需目标项目安装任何依赖。
 *
 * 实现方式与 PI 的 browser-e2e 扩展一致；工具定义使用注册表的原始 JSON Schema
 * 形式，运行时依赖只有 playwright-core；插件级 Config schema 在宿主 profile 提供
 * @deepseek-ai/schemastery 时导出，否则导出 undefined。
 *
 * @module dsh-browser-e2e
 */
import {
  close, closeAll, closeBySessionId, closeTab, click, consoleEntries, evaluate, fill, launch,
  navigate, networkEntries, press, screenshot, scroll, setConnectionResolver, snapshot, tabs as listSessionTabs,
  waitFor,
} from './browser.js'
import { PanelHub } from './panel.js'

/** 插件名（cordis 插件契约）。 */
export const name = 'browser-e2e'

/** 等待工具注册表就绪。 */
export const inject = ['tools']

// 插件级配置项依赖 schemastery 生成 schema。本插件不把它写进 package.json 依赖，
// 宿主 profile 提供时（desktop profile 已显式安装）才导出 Config，否则导出 undefined。
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
 * 里的快照、不重载插件（见 dsh-settings 的 volatileForm / write 只接受 volatile 路径），
 * 所以 apply 里读到的是引用（`{ get() }`），运行中的面板靠 loader/volatile-update 事件跟进。
 */
export const Config = Schema ? Schema.object({
  defaultMode: Schema.union(['isolated', 'cdp']).default('isolated').volatile()
    .description('启动模式：isolated（默认）或 cdp'),
  cdpEndpoint: Schema.string().default('http://127.0.0.1:9222').volatile()
    .description('CDP 模式接管的 http 端点，默认 http://127.0.0.1:9222；只允许 loopback'),
  quality: Schema.number().volatile()
    .description('投屏 JPEG 质量 10-100，越界或缺失回退默认 70'),
  maxWidth: Schema.number().volatile()
    .description('投屏最大宽度（像素）100-4096，越界或缺失回退默认 1280'),
  maxHeight: Schema.number().volatile()
    .description('投屏最大高度（像素）100-4096，越界或缺失回退默认 800'),
  everyNthFrame: Schema.number().volatile()
    .description('每 N 帧投屏一帧 1-10，越界或缺失回退默认 1'),
}) : undefined

/** 工具结果统一按字符串返回，由 render 转成模型可见文本。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

/**
 * 组装一个工具定义。
 *
 * output 缺省为纯文本；截图这类需要返回图片的工具传入自定义 output，
 * 在 render 里按值组装 [{type:'text'}, {type:'image'}] 内容块。
 */
function tool(toolName, description, parameters, run, output) {
  return {
    name: toolName,
    description,
    parameters,
    output: output ?? textOutput(),
    async execute(args, exec) {
      return run(args ?? {}, exec)
    },
  }
}

/** 参数根对象：默认不接受多余键。 */
function params(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 工具返回值的一句话摘要，供面板动作提示使用。 */
function summaryOf(value) {
  if (typeof value === 'string') return value.split('\n')[0]
  if (value !== null && typeof value === 'object' && typeof value.meta?.summary === 'string') {
    return value.meta.summary
  }
  return ''
}

/** 截图工具的输出契约：先文本摘要，附件服务可用时再追加图片内容块。 */
function screenshotOutput() {
  // 注册表用的是原始 JSON Schema 子集（type/oneOf/properties/required/additionalProperties/items），
  // required 必须是字符串数组，不能写成属性级的 required: true。
  const clipSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
    required: ['x', 'y', 'width', 'height'],
  }
  const attachmentSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string' },
      mediaType: { type: 'string' },
      bytes: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      name: { type: 'string' },
    },
    required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  }
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        meta: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            format: { type: 'string' },
            mediaType: { type: 'string' },
            bytes: { type: 'integer' },
            fullPage: { type: 'boolean' },
            name: { type: 'string' },
            clip: clipSchema,
            scale: { type: 'string' },
            attachment: attachmentSchema,
          },
          required: ['summary', 'width', 'height', 'format', 'mediaType', 'bytes', 'fullPage', 'name'],
        },
      },
      required: ['file', 'meta'],
    },
    render: (_args, value) => {
      const meta = value.meta
      const text = `${meta.summary}\n路径：${value.file}（${meta.mediaType}，${meta.bytes} 字节）`
      if (!meta.attachment) {
        return [{ type: 'text', text }]
      }
      return [
        { type: 'text', text },
        { type: 'image', attachment: meta.attachment },
      ]
    },
  }
}

/**
 * 每个 agent（会话）一份浏览器状态；无 agent 身份时退回全局的一份。
 *
 * 用 `agent.id`（SessionId）作键而不是 agent 对象：`session/disposed` 只给
 * Session，靠这个同源 id 才能精确回收对应会话的浏览器。
 */
function sessionKey(exec) {
  return exec?.agent?.id ?? exec?.agent ?? 'global'
}

/** 必填字符串校验（原始注册不代做校验）。 */
function requireString(args, field) {
  const value = args[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`缺少必填参数 ${field}（非空字符串）`)
  }
  return value
}

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
 * 或空对象）。这里只接受合法值：mode 只认 isolated / cdp；endpoint 必须是非空字符串，
 * 非法值当作未配置，保持 isolated + 默认端点的既有行为。
 * @param {unknown} config - apply 收到的插件级配置
 * @returns {{mode?: 'isolated'|'cdp', cdpEndpoint?: string}}
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
  return defaults
}

/**
 * 从插件级配置里取面板投屏参数。
 *
 * 只把四个投屏字段摊平成普通值交给 PanelHub：合法性与默认值的判定统一在
 * PanelHub 里按 PANEL_CONFIG_LIMITS 做，避免两处口径分叉。
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

export function apply(ctx, config) {
  // 插件级配置只在首次启动时作为缺省值；用户显式传的工具参数优先，
  // 已启动会话的一致性校验也只认显式参数（见 browser.js 的 launch）。
  const launchDefaults = launchDefaultsOf(config)

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

  const register = (definition) => ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      try {
        const value = await definition.execute(args, exec ?? {})
        hub.broadcastAction(definition.name, summaryOf(value))
        hub.scheduleSync()
        return value
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        hub.broadcastAction(definition.name, `失败：${message}`)
        throw error
      }
    },
  })

  register(tool(
    'browser_e2e_start',
    '启动浏览器（本机系统 Edge，headless 默认开启）。同一会话复用同一实例，无需反复启动。'
      + '未显式传 mode / cdpEndpoint 时，首次启动使用插件设置里的默认值（defaultMode / cdpEndpoint）；'
      + '工具参数优先。如需从 isolated 切换为 cdp（或反之），先 browser_e2e_close 再带 mode 重新启动；'
      + '已启动时传入与当前不一致的 mode/cdpEndpoint 会报错。'
      + '若需观察真实界面，传 headless=false。mode=cdp 时不启动新浏览器，而是经 CDP 接管'
      + '已用远程调试端口启动的浏览器（只连 loopback 端点；不新建页面、不改视口）。',
    params({
      headless: { type: 'boolean', description: '是否无头模式，默认 true（仅隔离模式有效）' },
      proxy: { type: 'string', description: 'HTTP 代理地址，如 http://127.0.0.1:8899；缺省读环境变量 DSH_BROWSER_PROXY' },
      viewportWidth: { type: 'number', description: '视口宽度，默认 1600（仅隔离模式有效）' },
      viewportHeight: { type: 'number', description: '视口高度，默认 900（仅隔离模式有效）' },
      mode: { type: 'string', description: 'isolated（默认，自己拉起 Edge）或 cdp（接管已有浏览器）' },
      cdpEndpoint: { type: 'string', description: 'CDP 模式要接管的 http 端点，默认 http://127.0.0.1:9222；只允许 loopback' },
    }),
    async (args, exec) => {
      // 传 defaults 而不是把配置默认值合进 args：mode / cdpEndpoint 的显式性只由 args 决定，
      // 已启动会话不会因为配置默认值不同而报「mode 不一致」。
      const info = await launch(sessionKey(exec), args, exec?.agent?.id, launchDefaults)
      if (info.reused) {
        return `${info.summary}\n当前地址：${info.url || '空白页'}`
      }
      const lines = [info.summary]
      if (info.mode === 'cdp') {
        lines.push(`接管端点：${info.endpoint}`)
        lines.push('CDP 模式不会关闭你的浏览器，browser_e2e_close 只断开连接。')
        return lines.join('\n')
      }
      lines.push(`产物目录：${info.artifactsDir}`)
      return lines.join('\n')
    },
  ))

  register(tool(
    'browser_e2e_navigate',
    '导航到指定 URL。waitUntil 默认 load；页面含长连接/SSE 时不要用 networkidle，否则会挂起。'
      + '导航后请重新 browser_e2e_snapshot 获取元素 ref。需要认证的本地服务可在 URL 里带 token 查询参数。'
      + 'new_tab=true 时新建标签页并设为当前页；tab_id 指定目标标签页（缺省用当前 active tab）。',
    params({
      url: { type: 'string', description: '目标地址，如 http://127.0.0.1:19387' },
      waitUntil: { type: 'string', description: '等待条件：load | domcontentloaded | networkidle，默认 load' },
      new_tab: { type: 'boolean', description: '是否新建标签页并设为当前页，默认 false' },
      tab_id: { type: 'string', description: '目标标签页 id（browser_e2e_tabs 获得）；缺省用当前 active tab' },
    }, ['url']),
    async (args, exec) => {
      const url = requireString(args, 'url')
      const info = await navigate(sessionKey(exec), url, args.waitUntil ?? 'load', exec?.agent?.id, {
        new_tab: args.new_tab === true,
        tab_id: args.tab_id,
      })
      return `${info.summary}\n标题：${info.title}\n当前标签页：${info.tabId}\n导航后请重新 browser_e2e_snapshot 获取元素 ref。`
    },
  ))

  register(tool(
    'browser_e2e_tabs',
    '列出本会话的标签页：tab_id / url / title / active / loading / origin。作用于页面的工具都可传 tab_id，'
      + '缺省用 active tab。',
    params({}),
    async (_args, exec) => {
      const info = await listSessionTabs(sessionKey(exec))
      return `${info.summary}\nmode=${info.mode}\n${info.text}`
    },
  ))

  register(tool(
    'browser_e2e_close_tab',
    '关闭指定标签页（tabs 得到的 tab_id）。最后一个标签页不允许关闭；'
      + '如需结束整个浏览器请用 browser_e2e_close。',
    params({ tab_id: { type: 'string', description: '要关闭的标签页 id' } }, ['tab_id']),
    async (args, exec) => {
      const tabId = requireString(args, 'tab_id')
      const info = await closeTab(sessionKey(exec), tabId)
      return `${info.summary}\n下一个操作默认作用于：${info.activeTabId ?? '无'}`
    },
  ))

  register(tool(
    'browser_e2e_snapshot',
    '全 DOM 结构化快照：节点含 tag / id / classes / role / name / text / box / depth，上限 4000，'
      + '超限标记 truncated；ref 格式 @N。页面变化后需重新快照，ref 按标签页隔离，切 tab 后旧 ref 失效。',
    params({ tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' } }),
    async (args, exec) => {
      const info = await snapshot(sessionKey(exec), exec?.agent?.id, args.tab_id)
      return `${info.summary}\n当前页面：${info.url}（标签页 ${info.tabId}）\n\n${info.text}`
    },
  ))

  register(tool(
    'browser_e2e_click',
    '点击元素。三种方式三选一：ref（snapshot 得到的 @N，点击前会复验仍可见）、'
      + 'selector（CSS 选择器，先等可见再点）、x + y（视口坐标，真实鼠标事件）。'
      + '页面变化后 ref 会失效，请重新 browser_e2e_snapshot。',
    params({
      ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
      selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
      x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
      y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }),
    async (args, exec) => {
      const info = await click(sessionKey(exec), {
        ref: args.ref,
        selector: args.selector,
        x: args.x,
        y: args.y,
      }, exec?.agent?.id, args.tab_id)
      return `${info.summary}\n如需继续操作请重新 browser_e2e_snapshot。`
    },
  ))

  register(tool(
    'browser_e2e_fill',
    '向输入框填入文本，适用于 input / textarea / contenteditable。三种目标三选一：'
      + 'ref（snapshot 得到的 @N）、selector（CSS 选择器）、x + y（视口坐标，真实鼠标点击后键入）。',
    params({
      ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
      selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
      x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
      y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
      value: { type: 'string', description: '要填入的文本' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }, ['value']),
    async (args, exec) => {
      const value = requireString(args, 'value')
      const hasRef = typeof args.ref === 'string' && args.ref.length > 0
      const hasSelector = typeof args.selector === 'string' && args.selector.length > 0
      const hasPoint = Number.isFinite(args.x) && Number.isFinite(args.y)
      if (!hasRef && !hasSelector && !hasPoint) {
        throw new Error('需要 ref / selector / x + y 三者之一')
      }
      const info = await fill(sessionKey(exec), {
        ref: args.ref,
        selector: args.selector,
        x: args.x,
        y: args.y,
      }, value, exec?.agent?.id, args.tab_id)
      return info.summary
    },
  ))

  register(tool(
    'browser_e2e_scroll',
    '滚动页面，用于触发懒加载或浏览长页。delta_x / delta_y 为滚动距离，至少一个非 0；'
      + '给 x + y 时先移动鼠标到该视口坐标再滚，否则在当前位置滚动。',
    params({
      delta_x: { type: 'number', description: '滚动横向距离（像素），默认 0' },
      delta_y: { type: 'number', description: '滚动纵向距离（像素），默认 0' },
      x: { type: 'number', description: '可选：滚动前把鼠标移动到该视口坐标 x（CSS 像素）' },
      y: { type: 'number', description: '可选：滚动前把鼠标移动到该视口坐标 y（CSS 像素）' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }),
    async (args, exec) => {
      const info = await scroll(sessionKey(exec), {
        delta_x: args.delta_x,
        delta_y: args.delta_y,
        x: args.x,
        y: args.y,
      }, exec?.agent?.id, args.tab_id)
      return info.summary
    },
  ))

  register(tool(
    'browser_e2e_press',
    '按下键盘按键，如 Enter、Tab、Escape、Control+A。作用于当前焦点元素。',
    params({
      key: { type: 'string', description: '按键名，如 Enter' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }, ['key']),
    async (args, exec) => {
      const key = requireString(args, 'key')
      const info = await press(sessionKey(exec), key, exec?.agent?.id, args.tab_id)
      return info.summary
    },
  ))

  register(tool(
    'browser_e2e_screenshot',
    '截取当前页面。默认截视口 PNG，落盘后返回路径；宿主提供附件服务时图片本身也会一并返回。'
      + 'clip 裁剪区域（相对视口 CSS 像素），format 支持 png / jpeg，quality 仅 jpeg（1-100），'
      + 'scale 支持 "css" / "device" 或整数 1 / 2 / 3（1/2/3 为倍率，device 为设备像素比）。'
      + '截图前会校验参数、clip 不越出视口、输出单边 <= 8192 且总像素 <= 4194304。',
    params({
      name: { type: 'string', description: '文件名（不含扩展名），默认按时间戳命名' },
      fullPage: { type: 'boolean', description: '是否截整页，默认 false（仅视口）' },
      clip: {
        type: 'object',
        description: '裁剪区域，视口相对 CSS 像素：{ x, y, width, height }，四值必须为整数',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      format: { type: 'string', description: '输出格式：png（默认）或 jpeg' },
      quality: { type: 'integer', description: 'JPEG 质量 1-100，仅 format=jpeg 时有效' },
      scale: {
        oneOf: [{ type: 'string' }, { type: 'integer' }],
        description: '缩放模式："css" / "device"，或整数倍率 1 / 2 / 3（1/2/3 为倍率，device 为设备像素比）；缺省用 Playwright 默认（device）',
      },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }),
    async (args, exec) => {
      const info = await screenshot(sessionKey(exec), {
        name: args.name,
        fullPage: args.fullPage ?? false,
        clip: args.clip,
        format: args.format,
        quality: args.quality,
        scale: args.scale,
        tab_id: args.tab_id,
      }, exec?.agent?.id)
      // 宿主挂载了附件服务时把图片存成附件，render 再把它作为 image 内容块返回。
      // 附件服务不可用或存图失败时退回纯文本路径，文件此时已经落盘。
      const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
      let attachment
      if (attachments !== undefined && typeof attachments.saveImage === 'function') {
        try {
          const ref = await attachments.saveImage({
            data: info.data,
            mediaType: info.meta.mediaType,
            name: info.meta.name,
          })
          attachment = {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name ? { name: ref.name } : {}),
          }
        } catch {
          attachment = undefined
        }
      }
      return {
        file: info.file,
        meta: {
          ...info.meta,
          ...(attachment ? { attachment } : {}),
          summary: info.summary,
        },
      }
    },
    screenshotOutput(),
  ))

  register(tool(
    'browser_e2e_console',
    '读取当前页面捕获的控制台记录（log / info / warn / error / debug 与未捕获异常），最新在最后。'
      + '缓冲上限 500 条，limit 默认 100（取尾部）。导航时清空。',
    params({
      limit: { type: 'integer', description: '最多返回尾部多少条，默认 100' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }),
    async (args, exec) => {
      const info = await consoleEntries(sessionKey(exec), args.limit ?? 100, args.tab_id)
      const totalNote = info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : ''
      return `${info.summary}${totalNote}\n${info.text}`
    },
  ))

  register(tool(
    'browser_e2e_network',
    '读取当前页面观测到的网络请求（url / method / status / mimeType / failure），最新在最后。'
      + 'status 为 0 表示请求没有拿到响应，此时看 failure。缓冲上限 500 条，limit 默认 100（取尾部）。导航时清空。',
    params({
      limit: { type: 'integer', description: '最多返回尾部多少条，默认 100' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }),
    async (args, exec) => {
      const info = await networkEntries(sessionKey(exec), args.limit ?? 100, args.tab_id)
      const totalNote = info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : ''
      return `${info.summary}${totalNote}\n${info.text}`
    },
  ))

  register(tool(
    'browser_e2e_wait',
    '等待页面条件满足：selector（配合 state）或 expression（页面内 JS 表达式，返回真值即满足）二选一。'
      + 'state 可选 attached / visible / hidden / detached，默认 visible；timeoutMs 默认 10000。'
      + '超时会报错并给出实际等待时长。',
    params({
      selector: { type: 'string', description: 'CSS 选择器；与 expression 二选一' },
      expression: { type: 'string', description: '页面内 JS 表达式；与 selector 二选一，多行逻辑用 IIFE' },
      state: { type: 'string', description: 'selector 的等待状态：attached | visible | hidden | detached，默认 visible' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认 10000' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }),
    async (args, exec) => {
      const info = await waitFor(sessionKey(exec), {
        selector: args.selector,
        expression: args.expression,
        state: args.state,
        timeoutMs: args.timeoutMs,
        tab_id: args.tab_id,
      }, exec?.agent?.id)
      return `${info.summary}\n状态：${info.state}，上限 ${info.timeoutMs}ms`
    },
  ))

  register(tool(
    'browser_e2e_evaluate',
    '在页面上下文执行 JavaScript 并返回 JSON 结果。适合取计算样式、量尺寸、读 DOM 状态。'
      + '脚本必须是表达式；多行逻辑请用 IIFE 包装，例如 (() => ({ color: getComputedStyle(document.body).color }))()',
    params({
      expression: { type: 'string', description: '要执行的 JavaScript 表达式' },
      tab_id: { type: 'string', description: '目标标签页 id；缺省用当前 active tab' },
    }, ['expression']),
    async (args, exec) => {
      const expression = requireString(args, 'expression')
      const info = await evaluate(sessionKey(exec), expression, exec?.agent?.id, args.tab_id)
      let text
      try {
        text = JSON.stringify(info.value, null, 2)
      } catch {
        text = String(info.value)
      }
      return `${info.summary}\n${text === undefined ? 'undefined' : text}`
    },
  ))

  register(tool(
    'browser_e2e_close',
    '关闭本会话的浏览器实例并释放资源。长时间不用时建议关闭。',
    params({}),
    async (_args, exec) => {
      const info = await close(sessionKey(exec))
      return info.summary
    },
  ))

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
