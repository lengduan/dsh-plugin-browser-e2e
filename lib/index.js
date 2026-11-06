/**
 * dsh-browser-e2e —— 全局浏览器端到端验证工具集。
 *
 * 提供 browser_* 工具（启动/导航/快照/点击/填充/按键/截图/求值/关闭），
 * 用系统 Edge（channel: 'msedge'）驱动，不触发 360 主动防御弹窗。
 * 装进 DSH profile 后对所有会话与工作区可用，无需目标项目安装任何依赖。
 *
 * 实现方式与 PI 的 browser-e2e 扩展一致；工具定义使用注册表的原始 JSON Schema
 * 形式，因此本插件除 playwright-core 外不依赖任何 DSH 包。
 *
 * @module dsh-browser-e2e
 */
import {
  close, closeAll, closeBySessionId, click, consoleEntries, evaluate, fill, launch, navigate,
  networkEntries, press, screenshot, snapshot, waitFor,
} from './browser.js'
import { PanelHub } from './panel.js'

/** 插件名（cordis 插件契约）。 */
export const name = 'browser-e2e'

/** 等待工具注册表就绪。 */
export const inject = ['tools']

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

export function apply(ctx) {
  // 面板宿主：维护 socket 客户端、tab 状态与投屏。它不改变工具的参数与返回值，
  // 只在工具执行后广播一条动作摘要、并顺带刷新一次 tab 状态。
  const hub = new PanelHub()

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
    'browser_start',
    '启动浏览器（本机系统 Edge，headless 默认开启）。同一会话内复用同一实例，无需反复启动。'
      + '若需观察真实界面，传 headless=false。',
    params({
      headless: { type: 'boolean', description: '是否无头模式，默认 true' },
      proxy: { type: 'string', description: 'HTTP 代理地址，如 http://127.0.0.1:8899；缺省读环境变量 DSH_BROWSER_PROXY' },
      viewportWidth: { type: 'number', description: '视口宽度，默认 1600' },
      viewportHeight: { type: 'number', description: '视口高度，默认 900' },
    }),
    async (args, exec) => {
      const info = await launch(sessionKey(exec), args, exec?.agent?.id)
      if (info.reused) {
        return `${info.summary}\n当前地址：${info.url || '空白页'}`
      }
      return `${info.summary}\n产物目录：${info.artifactsDir}`
    },
  ))

  register(tool(
    'browser_e2e_navigate',
    '导航到指定 URL。waitUntil 默认 load；页面含长连接/SSE 时不要用 networkidle，否则会挂起。'
      + '导航后请重新 browser_e2e_snapshot 获取元素 ref。需要认证的本地服务可在 URL 里带 token 查询参数。',
    params({
      url: { type: 'string', description: '目标地址，如 http://127.0.0.1:19387' },
      waitUntil: { type: 'string', description: '等待条件：load | domcontentloaded | networkidle，默认 load' },
    }, ['url']),
    async (args, exec) => {
      const url = requireString(args, 'url')
      const info = await navigate(sessionKey(exec), url, args.waitUntil ?? 'load', exec?.agent?.id)
      return `${info.summary}\n标题：${info.title}\n导航后请重新 browser_e2e_snapshot 获取元素 ref。`
    },
  ))

  register(tool(
    'browser_e2e_snapshot',
    '获取当前页面的可交互元素树并分配 ref（格式 @N）。browser_e2e_click / browser_fill 使用这些 ref；'
      + '页面每次变化后都要重新快照。',
    params({}),
    async (_args, exec) => {
      const info = await snapshot(sessionKey(exec), exec?.agent?.id)
      return `${info.summary}\n当前页面：${info.url}\n\n${info.text}`
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
    }),
    async (args, exec) => {
      const info = await click(sessionKey(exec), {
        ref: args.ref,
        selector: args.selector,
        x: args.x,
        y: args.y,
      }, exec?.agent?.id)
      return `${info.summary}\n如需继续操作请重新 browser_e2e_snapshot。`
    },
  ))

  register(tool(
    'browser_fill',
    '向 ref 对应的输入框填入文本，适用于 input / textarea / contenteditable。',
    params({
      ref: { type: 'string', description: '元素引用，格式 @N' },
      value: { type: 'string', description: '要填入的文本' },
    }, ['ref', 'value']),
    async (args, exec) => {
      const ref = requireString(args, 'ref')
      const value = requireString(args, 'value')
      const info = await fill(sessionKey(exec), ref, value, exec?.agent?.id)
      return info.summary
    },
  ))

  register(tool(
    'browser_e2e_press',
    '按下键盘按键，如 Enter、Tab、Escape、Control+A。作用于当前焦点元素。',
    params({ key: { type: 'string', description: '按键名，如 Enter' } }, ['key']),
    async (args, exec) => {
      const key = requireString(args, 'key')
      const info = await press(sessionKey(exec), key, exec?.agent?.id)
      return info.summary
    },
  ))

  register(tool(
    'browser_e2e_screenshot',
    '截取当前页面。默认截视口 PNG，落盘后返回路径；宿主提供附件服务时图片本身也会一并返回。'
      + 'clip 裁剪区域（相对视口 CSS 像素），format 支持 png / jpeg，quality 仅 jpeg（1-100），'
      + 'scale 只支持 "css" / "device"（透传 Playwright，不支持任意倍率）。'
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
      scale: { type: 'string', description: '缩放模式："css" 或 "device"，缺省用 Playwright 默认（device）' },
    }),
    async (args, exec) => {
      const info = await screenshot(sessionKey(exec), {
        name: args.name,
        fullPage: args.fullPage ?? false,
        clip: args.clip,
        format: args.format,
        quality: args.quality,
        scale: args.scale,
      }, exec?.agent?.id)
      // 宿主挂载了附件服务时把图片存成附件，render 再把它作为 image 内容块返回。
      // 附件服务不可用或存图失败时退回纯文本路径，文件此时已经落盘。
      const attachments = ctx.get('attachments')
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
    params({ limit: { type: 'integer', description: '最多返回尾部多少条，默认 100' } }),
    async (args, exec) => {
      const info = await consoleEntries(sessionKey(exec), args.limit ?? 100)
      const totalNote = info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : ''
      return `${info.summary}${totalNote}\n${info.text}`
    },
  ))

  register(tool(
    'browser_e2e_network',
    '读取当前页面观测到的网络请求（url / method / status / mimeType / failure），最新在最后。'
      + 'status 为 0 表示请求没有拿到响应，此时看 failure。缓冲上限 500 条，limit 默认 100（取尾部）。导航时清空。',
    params({ limit: { type: 'integer', description: '最多返回尾部多少条，默认 100' } }),
    async (args, exec) => {
      const info = await networkEntries(sessionKey(exec), args.limit ?? 100)
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
    }),
    async (args, exec) => {
      const info = await waitFor(sessionKey(exec), {
        selector: args.selector,
        expression: args.expression,
        state: args.state,
        timeoutMs: args.timeoutMs,
      }, exec?.agent?.id)
      return `${info.summary}\n状态：${info.state}，上限 ${info.timeoutMs}ms`
    },
  ))

  register(tool(
    'browser_evaluate',
    '在页面上下文执行 JavaScript 并返回 JSON 结果。适合取计算样式、量尺寸、读 DOM 状态。'
      + '脚本必须是表达式；多行逻辑请用 IIFE 包装，例如 (() => ({ color: getComputedStyle(document.body).color }))()',
    params({ expression: { type: 'string', description: '要执行的 JavaScript 表达式' } }, ['expression']),
    async (args, exec) => {
      const expression = requireString(args, 'expression')
      const info = await evaluate(sessionKey(exec), expression, exec?.agent?.id)
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
