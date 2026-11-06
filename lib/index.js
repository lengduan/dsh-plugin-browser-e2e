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

/** 组装一个工具定义。 */
function tool(toolName, description, parameters, run) {
  return {
    name: toolName,
    description,
    parameters,
    output: textOutput(),
    async execute(args, exec) {
      return run(args ?? {}, exec)
    },
  }
}

/** 参数根对象：默认不接受多余键。 */
function params(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
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
  const register = (definition) => ctx.tools.register(definition)

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
        return `浏览器已启动（系统 Edge ${info.version}），当前地址：${info.url || '空白页'}`
      }
      return `浏览器已启动：系统 Edge ${info.version}，headless=${info.headless}，`
        + `视口 ${info.viewport.width}x${info.viewport.height}\n产物目录：${info.artifactsDir}`
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
      const state = info.status === null ? '（无响应对象，可能是 about:blank 或 file://）' : `HTTP ${info.status} ${info.ok ? 'OK' : '异常'}`
      return `已导航至 ${info.url}\n${state}\n标题：${info.title}`
    },
  ))

  register(tool(
    'browser_e2e_snapshot',
    '获取当前页面的可交互元素树并分配 ref（格式 @N）。browser_e2e_click / browser_fill 使用这些 ref；'
      + '页面每次变化后都要重新快照。',
    params({}),
    async (_args, exec) => {
      const info = await snapshot(sessionKey(exec), exec?.agent?.id)
      return `当前页面：${info.url}（可交互元素 ${info.count} 个）\n\n${info.text}`
    },
  ))

  register(tool(
    'browser_e2e_click',
    '点击 ref 对应的元素。ref 来自最近一次 browser_e2e_snapshot；页面变化后需重新快照。',
    params({ ref: { type: 'string', description: '元素引用，格式 @N' } }, ['ref']),
    async (args, exec) => {
      const ref = requireString(args, 'ref')
      const info = await click(sessionKey(exec), ref, exec?.agent?.id)
      return `已点击 ${info.ref}（${info.tag} "${info.label}"）。如需继续操作请重新 browser_e2e_snapshot。`
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
      return `已向 ${info.ref}（${info.tag} "${info.label}"）填入 "${info.value}"`
    },
  ))

  register(tool(
    'browser_e2e_press',
    '按下键盘按键，如 Enter、Tab、Escape、Control+A。作用于当前焦点元素。',
    params({ key: { type: 'string', description: '按键名，如 Enter' } }, ['key']),
    async (args, exec) => {
      const key = requireString(args, 'key')
      await press(sessionKey(exec), key, exec?.agent?.id)
      return `已按下 ${key}`
    },
  ))

  register(tool(
    'browser_e2e_screenshot',
    '截取当前页面并保存为 PNG，返回绝对路径（不会把图片本身返回给模型）。'
      + '需要看图时请让用户打开该路径。',
    params({
      name: { type: 'string', description: '文件名（不含扩展名），默认按时间戳命名' },
      fullPage: { type: 'boolean', description: '是否截整页，默认 false（仅视口）' },
    }),
    async (args, exec) => {
      const info = await screenshot(sessionKey(exec), args.name, args.fullPage ?? false, exec?.agent?.id)
      return `截图已保存：${info.file}${info.fullPage ? '（整页）' : ''}`
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
      return text === undefined ? 'undefined' : text
    },
  ))

  register(tool(
    'browser_e2e_close',
    '关闭本会话的浏览器实例并释放资源。长时间不用时建议关闭。',
    params({}),
    async (_args, exec) => {
      const info = await close(sessionKey(exec))
      return info.closed ? '浏览器已关闭' : '浏览器未启动，无需关闭'
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
}
