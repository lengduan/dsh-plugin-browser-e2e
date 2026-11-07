/**
 * 工具表：18 个 browser_e2e_* 工具的单一声明处。
 *
 * 每项声明 name / description / parameters / run / output；index.js 只按表注册并挂生命周期，
 * 不再逐个平铺工具定义。新增工具只改这张表。
 *
 * 会话解析（sessionOf / requireSession）发生在 run 入口：能力函数接收会话对象，
 * 不自己按 key 查全局注册表。
 */
import {
  close, closeTab, launch, requireSession, sessionOf, tabs as listSessionTabs,
} from './session.js'
import {
  click, consoleEntries, currentTab, DEFAULT_DRAG_STEPS, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_SETTLE_MS,
  DEFAULT_VIEWPORT, drag, evaluate, fill, hover, MAX_DRAG_STEPS, MAX_SETTLE_MS, MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES, MIN_DRAG_STEPS, navigate, networkEntries, press, RING_LIMIT, scroll,
  SNAPSHOT_LIMIT, SNAPSHOT_QUERY_LIMIT_DEFAULT, SNAPSHOT_QUERY_LIMIT_MAX, snapshot, upload,
  waitFor,
} from './page.js'
import { MAX_SHOT_EDGE, MAX_SHOT_PIXELS, screenshot } from './capture.js'
import { DEFAULT_CDP_ENDPOINT } from './defaults.js'

/** 作用于页面的工具（14 个）公共参数：目标标签页。 */
const TAB_ID_PARAM = { type: 'string', description: '目标标签页 id；缺省用当前 active tab' }

/** 工具结果统一按字符串返回，由 render 转成模型可见文本。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

/** 参数根对象：默认不接受多余键。 */
function params(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** drag 的 from / to 嵌套目标 schema：ref / selector / x + y 三选一，由能力函数校验。 */
function dragTarget(label) {
  return {
    type: 'object',
    description: `${label}：ref / selector / x + y 三选一，由能力函数校验`,
    additionalProperties: false,
    properties: {
      ref: { type: 'string', description: '元素引用，格式 @N' },
      selector: { type: 'string', description: 'CSS 选择器' },
      x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用' },
      y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
    },
  }
}

/** 工具返回值的一句话摘要，供面板动作提示使用。 */
export function summaryOf(value) {
  if (typeof value === 'string') return value.split('\n')[0]
  if (value !== null && typeof value === 'object' && typeof value.meta?.summary === 'string') {
    return value.meta.summary
  }
  return ''
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
 * 每个 agent（会话）一份浏览器状态；无 agent 身份时退回全局的一份。
 * 用 agent.id（SessionId）作键：session/disposed 只给 Session，靠同源 id 精确回收。
 * @param {object} exec - 工具执行上下文
 * @returns {string} 会话 key
 */
export function sessionKey(exec) {
  return exec?.agent?.id ?? exec?.agent ?? 'global'
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
            scale: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
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
 * 组装工具表。
 * @param {object} deps - 宿主依赖
 * @param {object} deps.ctx - 插件 ctx（截图工具用于取 attachments 服务）
 * @param {() => {mode?: string, cdpEndpoint?: string}} deps.launchDefaults - 返回插件级配置启动缺省值的 getter
 *   （每次 start 重新读取，宿主即时字段更新后对后续启动生效）
 * @returns {Array<object>} 工具定义表
 */
export function buildToolTable({ ctx, launchDefaults }) {
  return [
    {
      name: 'browser_e2e_start',
      description: '启动浏览器（本机系统 Edge，headless 默认开启）。同一会话复用同一实例，无需反复启动。'
        + '未显式传 mode / cdpEndpoint 时，首次启动使用插件设置里的默认值（defaultMode / cdpEndpoint）；'
        + '工具参数优先。如需从 isolated 切换为 cdp（或反之），先 browser_e2e_close 再带 mode 重新启动；'
        + '已启动时传入与当前不一致的 mode/cdpEndpoint 会报错。'
        + '若需观察真实界面，传 headless=false。mode=cdp 时不启动新浏览器，而是经 CDP 接管'
        + '已用远程调试端口启动的浏览器（只连 loopback 端点；不新建页面、不改视口）。',
      parameters: params({
        headless: { type: 'boolean', description: '是否无头模式，默认 true（仅隔离模式有效）' },
        proxy: { type: 'string', description: 'HTTP 代理地址，如 http://127.0.0.1:8899；缺省读环境变量 DSH_BROWSER_PROXY' },
        viewportWidth: { type: 'number', description: `视口宽度，默认 ${DEFAULT_VIEWPORT.width}（仅隔离模式有效）` },
        viewportHeight: { type: 'number', description: `视口高度，默认 ${DEFAULT_VIEWPORT.height}（仅隔离模式有效）` },
        mode: {
          type: 'string',
          enum: ['isolated', 'cdp'],
          description: 'isolated（默认，自己拉起 Edge）或 cdp（接管已有浏览器）',
        },
        cdpEndpoint: { type: 'string', description: `CDP 模式要接管的 http 端点，默认 ${DEFAULT_CDP_ENDPOINT}；只允许 loopback` },
      }),
      async run(args, exec) {
        // 传 defaults 而不是把配置默认值合进 args：mode / cdpEndpoint 的显式性只由 args 决定，
        // 已启动会话不会因为配置默认值不同而报「mode 不一致」。
        const info = await launch(sessionKey(exec), args, exec?.agent?.id, launchDefaults())
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
    },
    {
      name: 'browser_e2e_navigate',
      description: '导航到指定 URL。waitUntil 默认 load；页面含长连接/SSE 时不要用 networkidle，否则会挂起。'
        + '导航后请重新 browser_e2e_snapshot 获取元素 ref。需要认证的本地服务可在 URL 里带 token 查询参数。'
        + 'new_tab=true 时新建标签页并设为当前页；tab_id 指定目标标签页（缺省用当前 active tab）。',
      parameters: params({
        url: { type: 'string', description: '目标地址，如 http://127.0.0.1:19387' },
        waitUntil: { type: 'string', description: '等待条件：load | domcontentloaded | networkidle，默认 load' },
        new_tab: { type: 'boolean', description: '是否新建标签页并设为当前页，默认 false' },
        tab_id: TAB_ID_PARAM,
      }, ['url']),
      async run(args, exec) {
        const url = requireString(args, 'url')
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await navigate(session, url, args.waitUntil ?? 'load', {
          new_tab: args.new_tab === true,
          tab_id: args.tab_id,
        })
        return `${info.summary}\n标题：${info.title}\n当前标签页：${info.tabId}\n导航后请重新 browser_e2e_snapshot 获取元素 ref。`
      },
    },
    {
      name: 'browser_e2e_tabs',
      description: '列出本会话的标签页：tab_id / url / title / active / loading / origin。作用于页面的工具都可传 tab_id，'
        + '缺省用 active tab。',
      parameters: params({}),
      async run(_args, exec) {
        const info = await listSessionTabs(sessionKey(exec))
        return `${info.summary}\nmode=${info.mode}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_close_tab',
      description: '关闭指定标签页（tabs 得到的 tab_id）。最后一个标签页不允许关闭；'
        + '如需结束整个浏览器请用 browser_e2e_close。',
      parameters: params({ tab_id: { type: 'string', description: '要关闭的标签页 id' } }, ['tab_id']),
      async run(args, exec) {
        const tabId = requireString(args, 'tab_id')
        const info = await closeTab(sessionKey(exec), tabId)
        return `${info.summary}\n下一个操作默认作用于：${info.activeTabId ?? '无'}`
      },
    },
    {
      name: 'browser_e2e_snapshot',
      description: `全 DOM 结构化快照：节点含 tag / id / classes / role / name / text / box / depth，上限 ${SNAPSHOT_LIMIT}，`
        + '超限标记 truncated；ref 格式 @N。页面变化后需重新快照，ref 按标签页隔离，切 tab 后旧 ref 失效。'
        + 'delta=true 只返回自上次快照以来的新增 / 变化 / 移除（与 query 互斥）；'
        + 'query 按 text / CSS selector / role 定位元素并返回可点击的 selector（不写快照基线）；'
        + 'frame 读取指定 iframe：整数为索引（0 主文档，n>=1 按 frames 顺序），字符串按 name 精确匹配、'
        + '无命中再按 url 子串匹配；只支持同源 iframe，子 frame 只读（不分配 ref）。',
      parameters: params({
        tab_id: TAB_ID_PARAM,
        delta: {
          type: 'boolean',
          description: '只返回自上次快照以来的变化节点（新增 / 变化 / 移除）；与 query 互斥',
        },
        frame: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: '读取指定 iframe：整数为索引（0 主文档，n>=1 按 page.frames() 顺序过滤主文档后的第 n 个），'
            + '字符串按 frame name 精确匹配、无命中再按 url 子串匹配；只支持同源 iframe',
        },
        query: {
          type: 'object',
          additionalProperties: false,
          description: '定位元素而不是读整页：按 text / CSS selector / role 过滤，返回可点击的 selector；text 与 selector 互斥',
          properties: {
            text: { type: 'string', description: '大小写不敏感的 name / 正文子串' },
            selector: { type: 'string', description: 'CSS 选择器' },
            role: { type: 'string', description: 'ARIA role，作为附加过滤；可与 text 或 selector 组合' },
            limit: {
              type: 'integer',
              description: `最多返回条数，1-${SNAPSHOT_QUERY_LIMIT_MAX}，默认 ${SNAPSHOT_QUERY_LIMIT_DEFAULT}`,
            },
            includeHidden: { type: 'boolean', description: '包含不可见元素（标 hidden: true），默认 false' },
          },
        },
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await snapshot(session, args.tab_id, {
          delta: args.delta === true,
          query: args.query,
          frame: args.frame,
        })
        if (info.mode === 'full') {
          return `${info.summary}\n当前页面：${info.url}（标签页 ${info.tabId}）\n\n${info.text}`
        }
        const frameText = info.frame.index === 0
          ? ''
          : `（frame ${info.frame.index}${info.frame.name ? ` "${info.frame.name}"` : ''}）`
        return `${info.summary}\n当前页面：${info.url}（标签页 ${info.tabId}）${frameText}\n\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_click',
      description: '点击元素。三种方式三选一：ref（snapshot 得到的 @N，点击前会复验仍可见）、'
        + 'selector（CSS 选择器，先等可见再点）、x + y（视口坐标，真实鼠标事件）。'
        + '页面变化后 ref 会失效，请重新 browser_e2e_snapshot。',
      parameters: params({
        ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
        selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
        x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
        y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await click(session, {
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
        }, args.tab_id)
        return `${info.summary}\n如需继续操作请重新 browser_e2e_snapshot。`
      },
    },
    {
      name: 'browser_e2e_fill',
      description: '向输入框填入文本，适用于 input / textarea / contenteditable。三种目标三选一：'
        + 'ref（snapshot 得到的 @N）、selector（CSS 选择器）、x + y（视口坐标，真实鼠标点击后键入）。',
      parameters: params({
        ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
        selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
        x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
        y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
        value: { type: 'string', description: '要填入的文本' },
        tab_id: TAB_ID_PARAM,
      }, ['value']),
      async run(args, exec) {
        const value = requireString(args, 'value')
        const hasRef = typeof args.ref === 'string' && args.ref.length > 0
        const hasSelector = typeof args.selector === 'string' && args.selector.length > 0
        const hasPoint = Number.isFinite(args.x) && Number.isFinite(args.y)
        if (!hasRef && !hasSelector && !hasPoint) {
          throw new Error('需要 ref / selector / x + y 三者之一')
        }
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await fill(session, {
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
        }, value, args.tab_id)
        return info.summary
      },
    },
    {
      name: 'browser_e2e_hover',
      description: '悬停元素或视口坐标，用真实鼠标移动触发 CSS :hover 与 mouseover / mouseenter，'
        + '适合展开菜单或提示。三种目标三选一：ref（snapshot 得到的 @N，先复验仍可见）、'
        + 'selector（CSS 选择器，先等可见）、x + y（视口坐标）。'
        + `settleMs 是悬停后等待页面反应的毫秒数，默认 ${DEFAULT_SETTLE_MS}`
        + `（0-${MAX_SETTLE_MS}，0 表示不等待）。悬停后页面可能变化，需操作新出现的元素时请重新快照。`,
      parameters: params({
        ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
        selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
        x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
        y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
        settleMs: {
          type: 'integer',
          description: `悬停后等待页面反应的毫秒数，默认 ${DEFAULT_SETTLE_MS}；0 表示不等待，取值 0-${MAX_SETTLE_MS}`,
        },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await hover(session, {
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
          settleMs: args.settleMs,
        }, args.tab_id)
        return `${info.summary}\n悬停后页面可能变化，如需操作新出现的元素请重新 browser_e2e_snapshot。`
      },
    },
    {
      name: 'browser_e2e_drag',
      description: '用真实鼠标拖拽，适合排序、滑块与 HTML5 draggable。from / to 各是一个目标，'
        + '三选一：ref（snapshot 得到的 @N）、selector（CSS 选择器）、x + y（视口坐标）；'
        + '两侧都是元素时走 Playwright dragTo（按下 / 插值移动 / 释放并转成原生 drag 事件），'
        + '任一侧是坐标时手写鼠标序列。'
        + `steps 是按下与松开之间的插值 mousemove 次数，默认 ${DEFAULT_DRAG_STEPS}（${MIN_DRAG_STEPS}-${MAX_DRAG_STEPS}）；`
        + `settleMs 是释放后等待页面更新的毫秒数，默认 ${DEFAULT_SETTLE_MS}（0-${MAX_SETTLE_MS}）。`
        + '拖拽后 DOM 可能已重排，请重新 browser_e2e_snapshot 再继续。',
      parameters: params({
        from: dragTarget('拖拽起点'),
        to: dragTarget('拖拽终点'),
        steps: {
          type: 'integer',
          description: `按下与松开之间的插值 mousemove 次数，默认 ${DEFAULT_DRAG_STEPS}，取值 ${MIN_DRAG_STEPS}-${MAX_DRAG_STEPS}`,
        },
        settleMs: {
          type: 'integer',
          description: `释放后等待页面更新的毫秒数，默认 ${DEFAULT_SETTLE_MS}；0 表示不等待，取值 0-${MAX_SETTLE_MS}`,
        },
        tab_id: TAB_ID_PARAM,
      }, ['from', 'to']),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await drag(session, {
          from: args.from,
          to: args.to,
          steps: args.steps,
          settleMs: args.settleMs,
        }, args.tab_id)
        return `${info.summary}\n拖拽后 DOM 可能已重排，请重新 browser_e2e_snapshot 再继续。`
      },
    },
    {
      name: 'browser_e2e_upload',
      description: '把宿主上的本地文件附加到 input[type=file]，走浏览器真实的文件选择路径'
        + '（不是用 DataTransfer 在页面里合成 File）。目标 ref / selector / x + y 三选一；'
        + '只接受 input[type=file]，不做 label 下钻。'
        + `files 必填：宿主绝对路径字符串或数组，最多 ${MAX_UPLOAD_FILES} 个，总大小默认 <= ${DEFAULT_MAX_UPLOAD_BYTES} 字节，`
        + `可用 maxBytes 调到 ${MAX_UPLOAD_BYTES} 字节。`
        + 'clear 默认 true：再次调用会覆盖本次选择（不追加）；clear=false 只在控件没有选择时设置。'
        + 'x + y 是真实点击该坐标后在 5000ms 内接住浏览器弹出的文件选择器。',
      parameters: params({
        ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
        selector: { type: 'string', description: 'CSS 选择器（指向 input[type=file]）；与 ref / x+y 三选一' },
        x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，表示点击该位置后在 5000ms 内接住文件选择器' },
        y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
        files: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: `宿主上的绝对路径：单个字符串或字符串数组（最多 ${MAX_UPLOAD_FILES} 个，`
            + `总大小默认 <= ${DEFAULT_MAX_UPLOAD_BYTES} 字节，可用 maxBytes 调整）。扩展名不限；`
            + '传空数组会清空当前选择。',
        },
        maxBytes: {
          type: 'integer',
          description: `本次 files 的总字节数上限，默认 ${DEFAULT_MAX_UPLOAD_BYTES}（20 MiB），取值 1..${MAX_UPLOAD_BYTES}（512 MiB）`,
        },
        clear: { type: 'boolean', description: '默认 true：替换控件已有选择；false：只在控件没有选择时设置，已有选择则报错（不支持追加）' },
        tab_id: TAB_ID_PARAM,
      }, ['files']),
      async run(args, exec) {
        // 工具层把单个字符串归一为单元素数组；空串 / 非字符串原样交给能力函数报形态错误。
        const files = typeof args.files === 'string' && args.files.length > 0 ? [args.files] : args.files
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await upload(session, {
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
        }, files, { maxBytes: args.maxBytes, clear: args.clear }, args.tab_id)
        const parts = [`控件：${info.multiple ? 'multiple' : '单文件'}`]
        if (info.accept) {
          const accept = info.accept.length > 120 ? `${info.accept.slice(0, 120)}…` : info.accept
          parts.push(`，accept="${accept}"`)
        }
        parts.push(`；共 ${info.totalBytes} 字节`)
        if (info.visible === false) parts.push('；当前不可见（按 DOM 注入）')
        if (info.replaced > 0) parts.push(`；已替换原有 ${info.replaced} 个选择`)
        if (Number.isInteger(info.selected) && info.selected !== info.files.length) {
          parts.push(`；页面当前选择 ${info.selected} 个文件`)
        }
        return `${info.summary}\n${parts.join('')}\n再次调用会覆盖本次选择（clear 默认 true）；要清空已选文件请传 files: []。`
      },
    },
    {
      name: 'browser_e2e_scroll',
      description: '滚动页面，用于触发懒加载或浏览长页。delta_x / delta_y 为滚动距离，至少一个非 0；'
        + '给 x + y 时先移动鼠标到该视口坐标再滚，否则在当前位置滚动。',
      parameters: params({
        delta_x: { type: 'number', description: '滚动横向距离（像素），默认 0' },
        delta_y: { type: 'number', description: '滚动纵向距离（像素），默认 0' },
        x: { type: 'number', description: '可选：滚动前把鼠标移动到该视口坐标 x（CSS 像素）' },
        y: { type: 'number', description: '可选：滚动前把鼠标移动到该视口坐标 y（CSS 像素）' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await scroll(session, {
          delta_x: args.delta_x,
          delta_y: args.delta_y,
          x: args.x,
          y: args.y,
        }, args.tab_id)
        return info.summary
      },
    },
    {
      name: 'browser_e2e_press',
      description: '按下键盘按键，如 Enter、Tab、Escape、Control+A。作用于当前焦点元素。',
      parameters: params({
        key: { type: 'string', description: '按键名，如 Enter' },
        tab_id: TAB_ID_PARAM,
      }, ['key']),
      async run(args, exec) {
        const key = requireString(args, 'key')
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await press(session, key, args.tab_id)
        return info.summary
      },
    },
    {
      name: 'browser_e2e_screenshot',
      description: '截取当前页面。默认截视口 PNG，落盘后返回路径；宿主提供附件服务时图片本身也会一并返回。'
        + 'clip 裁剪区域（相对视口 CSS 像素），format 支持 png / jpeg，quality 仅 jpeg（1-100），'
        + 'scale 支持 "css" / "device" 或整数 1 / 2 / 3（1/2/3 为倍率，device 为设备像素比）。'
        + `截图前会校验参数、clip 不越出视口、输出单边 <= ${MAX_SHOT_EDGE} 且总像素 <= ${MAX_SHOT_PIXELS}。`,
      parameters: params({
        name: {
          type: 'string',
          description: '文件名前缀（不含扩展名）。只允许字母、数字、"."、"_"、"-"，不能含 ".." 与路径分隔符；'
            + '落盘时自动追加唯一后缀（时间戳 + 序号）防覆盖，因此实际文件名形如 <name>-<后缀>.png。'
            + '缺省用 shot-<时间戳+序号> 命名，同样带唯一后缀。',
        },
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
        tab_id: TAB_ID_PARAM,
      }),
      output: screenshotOutput(),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await screenshot(session, currentTab(session, args.tab_id), {
          name: args.name,
          fullPage: args.fullPage ?? false,
          clip: args.clip,
          format: args.format,
          quality: args.quality,
          scale: args.scale,
        })
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
    },
    {
      name: 'browser_e2e_console',
      description: '读取当前页面捕获的控制台记录（log / info / warn / error / debug 与未捕获异常），最新在最后。'
        + `缓冲上限 ${RING_LIMIT} 条，limit 默认 100（取尾部）。导航时清空。`,
      parameters: params({
        limit: { type: 'integer', description: '最多返回尾部多少条，默认 100' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const info = await consoleEntries(requireSession(sessionKey(exec)), args.limit ?? 100, args.tab_id)
        const totalNote = info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : ''
        return `${info.summary}${totalNote}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_network',
      description: '读取当前页面观测到的网络请求（url / method / status / mimeType / failure），最新在最后。'
        + `status 为 0 表示请求没有拿到响应，此时看 failure。缓冲上限 ${RING_LIMIT} 条，limit 默认 100（取尾部）。导航时清空。`,
      parameters: params({
        limit: { type: 'integer', description: '最多返回尾部多少条，默认 100' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const info = await networkEntries(requireSession(sessionKey(exec)), args.limit ?? 100, args.tab_id)
        const totalNote = info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : ''
        return `${info.summary}${totalNote}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_wait',
      description: '等待页面条件满足：selector / expression / url / response 四选一。'
        + 'selector 配合 state（attached / visible / hidden / detached，默认 visible）；'
        + 'expression 是页面内 JS 表达式，返回真值即满足；'
        + 'url 等待主框架地址命中；response 等待匹配的响应到达，可用 responseMethod 与 statusMin / statusMax 过滤。'
        + 'url / response 的 URL 匹配方式由 urlMatch 决定（includes / glob / regex，默认 includes）。'
        + `response 的 includeBuffered 默认 true，会先回放当前文档已完成的响应（缓冲上限 ${RING_LIMIT} 条）；`
        + 'failOnRequestFailed 默认 true，匹配的请求失败立即报错。'
        + 'timeoutMs 默认 10000；超时会报错并带实际等待时长与诊断。',
      parameters: params({
        selector: { type: 'string', description: 'CSS 选择器；与 expression / url / response 四选一' },
        expression: { type: 'string', description: '页面内 JS 表达式；与 selector / url / response 四选一，多行逻辑用 IIFE' },
        url: { type: 'string', description: '地址匹配模式；与 selector / expression / response 四选一' },
        response: { type: 'string', description: '响应的 URL 匹配模式；与 selector / expression / url 四选一' },
        state: { type: 'string', description: 'selector 的等待状态：attached | visible | hidden | detached，默认 visible' },
        urlMatch: { type: 'string', description: 'url / response 的匹配方式：includes | glob | regex，默认 includes' },
        responseMethod: { type: 'string', description: 'response 条件的 HTTP 方法过滤；不给表示不限，比较时转大写' },
        statusMin: { type: 'integer', description: 'response 条件的状态码下限，100-599，默认 100' },
        statusMax: { type: 'integer', description: 'response 条件的状态码上限，100-599，默认 599' },
        includeBuffered: { type: 'boolean', description: 'response 条件是否回放等待开始前已完成的响应，默认 true' },
        failOnRequestFailed: { type: 'boolean', description: 'response 条件匹配的请求失败时是否立即报错，默认 true' },
        timeoutMs: { type: 'integer', description: '超时毫秒数，默认 10000' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await waitFor(session, {
          selector: args.selector,
          expression: args.expression,
          url: args.url,
          response: args.response,
          state: args.state,
          urlMatch: args.urlMatch,
          responseMethod: args.responseMethod,
          statusMin: args.statusMin,
          statusMax: args.statusMax,
          includeBuffered: args.includeBuffered,
          failOnRequestFailed: args.failOnRequestFailed,
          timeoutMs: args.timeoutMs,
          tab_id: args.tab_id,
        })
        let detail
        if (info.mode === 'selector') {
          detail = `状态：${info.state}，上限 ${info.timeoutMs}ms`
        } else if (info.mode === 'expression') {
          detail = `上限 ${info.timeoutMs}ms`
        } else if (info.mode === 'url') {
          detail = `匹配方式：${info.urlMatch}；命中来源：${info.matchedCurrent ? '当前地址' : '等待期间的新地址'}；上限 ${info.timeoutMs}ms`
        } else {
          detail = '匹配方式：' + `${info.urlMatch}；命中来源：${info.matchedResponse.buffered ? '调用前已缓冲' : '等待期间到达'}；`
            + `上限 ${info.timeoutMs}ms`
        }
        return `${info.summary}\n${detail}`
      },
    },
    {
      name: 'browser_e2e_evaluate',
      description: '在页面上下文执行 JavaScript 并返回 JSON 结果。适合取计算样式、量尺寸、读 DOM 状态。'
        + '脚本必须是表达式；多行逻辑请用 IIFE 包装，例如 (() => ({ color: getComputedStyle(document.body).color }))()',
      parameters: params({
        expression: { type: 'string', description: '要执行的 JavaScript 表达式' },
        tab_id: TAB_ID_PARAM,
      }, ['expression']),
      async run(args, exec) {
        const expression = requireString(args, 'expression')
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await evaluate(session, expression, args.tab_id)
        let text
        try {
          text = JSON.stringify(info.value, null, 2)
        } catch {
          text = String(info.value)
        }
        return `${info.summary}\n${text === undefined ? 'undefined' : text}`
      },
    },
    {
      name: 'browser_e2e_close',
      description: '关闭本会话的浏览器实例并释放资源。长时间不用时建议关闭。',
      parameters: params({}),
      async run(_args, exec) {
        const info = await close(sessionKey(exec))
        return info.summary
      },
    },
  ]
}

/** 工具表里每个定义补上统一的 output 字段（缺省纯文本）。 */
export function withOutput(definitions) {
  return definitions.map((definition) => ({
    ...definition,
    output: definition.output ?? textOutput(),
  }))
}
