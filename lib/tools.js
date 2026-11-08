/**
 * 工具表：30 个 browser_e2e_* 工具的单一声明处。
 *
 * 每项声明 name / description / parameters / run / output；index.js 只按表注册并挂生命周期，
 * 不再逐个平铺工具定义。新增工具只改这张表。
 *
 * 会话解析（sessionOf / requireSession）发生在 run 入口：能力函数接收会话对象，
 * 不自己按 key 查全局注册表。
 */
import {
  close, closeTab, exportStorageState, launch, requireSession, sessionOf, tabs as listSessionTabs,
} from './session.js'
import {
  ASSERT_MAX_CHECKS, assertPage,
  click, CLICK_BUTTONS, CLICK_COUNTS, CLICK_MODIFIERS, CLIPBOARD_HTML_LIMIT, CLIPBOARD_TEXT_LIMIT, CONSOLE_LEVEL_ALIASES,
  CONSOLE_LEVELS, clipboard, currentTab, DEFAULT_DRAG_STEPS, DEFAULT_EVALUATE_TIMEOUT_MS, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_RING_QUERY_LIMIT, DEFAULT_SETTLE_MS,
  DEFAULT_VIEWPORT, DEFAULT_WAIT_TIMEOUT_MS, DIALOG_LIMIT_DEFAULT, DIALOG_PROMPT_TEXT_LIMIT, DIALOG_RING_LIMIT,
  drag, evaluate, fill, followTab, FOLLOW_PROBE_TIMEOUT_MS, hover, KEYSTROKE_DELAY_BUDGET_MS, KEYSTROKE_MAX_CHARS,
  KEYSTROKE_MAX_DELAY_MS, MAX_DRAG_STEPS, MAX_EVALUATE_TIMEOUT_MS, MAX_PRESS_REPEAT, MAX_SETTLE_MS, MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES, MIN_DRAG_STEPS, MIN_EVALUATE_TIMEOUT_MS, navigate, PRESS_ACTIONS, press, RING_LIMIT, scroll,
  upload, waitFor, WAIT_STATUS_MAX, WAIT_STATUS_MIN,
} from './page.js'
import {
  SNAPSHOT_LIMIT, SNAPSHOT_QUERY_LIMIT_DEFAULT, SNAPSHOT_QUERY_LIMIT_MAX, snapshot,
} from './snapshot.js'
import {
  consoleEntries, dialogEntries, NETWORK_BODY_TEXT_LIMIT, NETWORK_BODY_TIMEOUT_MAX_MS, NETWORK_BODY_TIMEOUT_MIN_MS,
  NETWORK_BODY_TIMEOUT_MS, networkDetail, networkEntries, setDialogPolicy,
} from './observation.js'
import {
  MAX_SHOT_EDGE, MAX_SHOT_PIXELS, MAX_SHOT_QUALITY, MIN_SHOT_QUALITY, screenshot,
} from './capture.js'
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MAX_MS, DOWNLOAD_TIMEOUT_MIN_MS, MAX_DOWNLOAD_BYTES, download,
} from './download.js'
import {
  FETCH_DEFAULT_SETTLE_MS, FETCH_DEFAULT_TIMEOUT_MS, FETCH_MAX_SETTLE_MS, FETCH_MAX_TEXT_CHARS,
  FETCH_TIMEOUT_MAX_MS, FETCH_TIMEOUT_MIN_MS, fetchText,
} from './fetch.js'
import {
  DEFAULT_HTTP_TIMEOUT_MS, HTTP_MAX_BODY_CHARS, HTTP_MAX_HEADERS, HTTP_MAX_HEADER_CHARS, HTTP_METHODS,
  HTTP_RESULT_MAX_CHARS, MAX_HTTP_TIMEOUT_MS, MIN_HTTP_TIMEOUT_MS, rawHttp,
} from './raw.js'
import { DEFAULT_CDP_ENDPOINT } from './defaults.js'
import { CARRIERS } from './carrier.js'
import {
  DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, listActions,
} from './history.js'
import {
  diagnose, DOCTOR_PROBE_TIMEOUT_DEFAULT_MS, DOCTOR_PROBE_TIMEOUT_MAX_MS, DOCTOR_PROBE_TIMEOUT_MIN_MS,
} from './doctor.js'
import {
  HUMAN_POLL_MS_DEFAULT, HUMAN_POLL_MS_MAX, HUMAN_POLL_MS_MIN, HUMAN_REASON_LIMIT,
  HUMAN_TIMEOUT_MS_DEFAULT, HUMAN_TIMEOUT_MS_MAX, HUMAN_TIMEOUT_MS_MIN,
  humanCheck, waitForHuman,
} from './human.js'
import {
  READ_DEFAULT_ITEMS, READ_MAX_ITEMS, READ_TEXT_LIMIT, readStructured,
} from './read.js'
import {
  RECIPE_DEFAULT_TIMEOUT_MS, RECIPE_EXTRACT_LIMIT_DEFAULT, RECIPE_EXTRACT_LIMIT_MAX, RECIPE_MAX_STEPS,
  RECIPE_MAX_TIMEOUT_MS, RECIPE_MIN_TIMEOUT_MS, RECIPE_OUTPUT_TEXT_LIMIT, RECIPE_STEP_TYPES,
  RECIPE_WAIT_DEFAULT_TIMEOUT_MS, RECIPE_WAIT_MAX_TIMEOUT_MS, RECIPE_WAIT_MIN_TIMEOUT_MS,
  renderRecipeReport, runRecipe,
} from './recipe.js'

/** 作用于页面的工具公共参数：目标标签页。 */
const TAB_ID_PARAM = { type: 'string', description: '目标标签页 id；缺省用当前 active tab' }

/** 标签页工具的 action 取值：list 列出、close 关闭、follow 绑定后续默认标签页。 */
const TABS_ACTIONS = ['list', 'close', 'follow']

/** 字节数的可读大小：≥1 GiB 用 GiB，否则用 MiB；工具描述从字节常量派生，不另写数字。 */
function sizeText(bytes) {
  const GIB = 1024 * 1024 * 1024
  const MIB = 1024 * 1024
  return bytes >= GIB ? `${bytes / GIB} GiB` : `${bytes / MIB} MiB`
}

/** 控制台级别过滤的 enum 与描述：从 page.js 的常量派生，不写死字面量。 */
const CONSOLE_LEVEL_ENUM = [...CONSOLE_LEVELS, ...Object.keys(CONSOLE_LEVEL_ALIASES)]
const CONSOLE_LEVEL_DESC = `最小严重级别，从低到高为 ${CONSOLE_LEVELS.join(' < ')}；`
  + `${Object.entries(CONSOLE_LEVEL_ALIASES).map(([alias, level]) => `${alias} 等同 ${level}`).join(' / ')}。`
  + '只返回不低于该级别的记录；不传则返回全部记录（不可判级的记录类型始终保留）'

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
  // 结构化返回值（如 browser_e2e_assert）自带单行摘要。
  if (value !== null && typeof value === 'object' && typeof value.summary === 'string') {
    return value.summary
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

/** 动作历史读回工具名：工具表与 index.js 的「不记录自身」判断共用，避免两处写字面量。 */
export const HISTORY_TOOL_NAME = 'browser_e2e_history'

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
 * 断言工具的输出契约：结构化返回值 + 每条一行的 PASS / FAIL 渲染。
 * 未通过仍按成功调用返回，render 末尾追加一条等待提示。
 */
function assertOutput() {
  const checkSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      index: { type: 'integer' },
      kind: { type: 'string' },
      expected: { type: 'string' },
      pass: { type: 'boolean' },
      actual: { type: 'string' },
      state: { type: 'string' },
      urlMatch: { type: 'string' },
    },
    required: ['index', 'kind', 'expected', 'pass', 'actual'],
  }
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pass: { type: 'boolean' },
        total: { type: 'integer' },
        passed: { type: 'integer' },
        failed: { type: 'integer' },
        tabId: { type: 'string' },
        url: { type: 'string' },
        elapsedMs: { type: 'integer' },
        checks: { type: 'array', items: checkSchema },
        summary: { type: 'string' },
      },
      required: ['pass', 'total', 'passed', 'failed', 'tabId', 'url', 'elapsedMs', 'checks', 'summary'],
    },
    render: (_args, value) => {
      const lines = [value.summary]
      for (const check of value.checks) {
        lines.push(`${check.pass ? 'PASS' : 'FAIL'} [${check.index}] ${check.kind}: "${check.expected}" → ${check.actual}`)
      }
      if (!value.pass) {
        lines.push('未通过的断言不抛错；需要等待条件满足时先用 browser_e2e_wait。')
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }
}

/**
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
      access: 'observe',
      description: '启动浏览器（默认本机系统 Edge，carrier 可选系统 Chrome；headless 默认开启）。同一会话复用同一实例，无需反复启动。'
        + '未显式传 mode / cdpEndpoint / carrier 时，首次启动使用插件设置里的默认值'
        + '（defaultMode / cdpEndpoint / defaultCarrier）；工具参数优先。如需从 isolated 切换为 cdp（或反之），'
        + '先 browser_e2e_close 再带 mode 重新启动；已启动时传入与当前不一致的 mode/cdpEndpoint/carrier 会报错。'
        + 'carrier 只对隔离模式生效（cdp 忽略，载体由接管端点决定）；含义：edge 系统 Edge、'
        + 'chrome 本机 Google Chrome（路径由 DSH_BROWSER_CHROME_PATH 与平台惯例位置决定，不接受路径参数）、'
        + 'auto 优先 Chrome 找不到回退 Edge。'
        + 'storageState（宿主绝对 .json，仅 isolated 新启动时读取）与 storageDomains（域名后缀过滤）'
        + '用于把已保存的登录态带进本会话；已启动后再传 storageState 会报错，cdp 模式拒绝导入。'
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
          description: 'isolated（默认，自己拉起浏览器）或 cdp（接管已有浏览器）',
        },
        cdpEndpoint: { type: 'string', description: `CDP 模式要接管的 http 端点，默认 ${DEFAULT_CDP_ENDPOINT}；只允许 loopback` },
        carrier: {
          type: 'string',
          enum: CARRIERS,
          description: '隔离模式的浏览器载体：edge 系统 Edge（默认）、chrome 本机 Google Chrome、'
            + 'auto 优先 Chrome 找不到回退 Edge；未传时取插件 defaultCarrier；cdp 模式忽略',
        },
        storageState: {
          type: 'string',
          description: '登录态文件路径（宿主绝对 .json，Playwright storageState）；只在 isolated 新启动时读取，'
            + '已启动后传会报错，cdp 模式拒绝导入',
        },
        storageDomains: {
          type: 'array',
          items: { type: 'string' },
          description: '只导入命中域名的 cookie / origin（域名后缀，example.com 与 *.example.com 同义）；不传=文件内全部条目',
        },
      }),
      async run(args, exec) {
        // 传 defaults 而不是把配置默认值合进 args：mode / cdpEndpoint 的显式性只由 args 决定，
        // 已启动会话不会因为配置默认值不同而报「mode 不一致」。
        const info = await launch(sessionKey(exec), args, exec?.agent?.id, launchDefaults())
        if (info.reused) {
          const reusedLines = [info.summary, `当前地址：${info.url || '空白页'}`]
          if (info.mode === 'cdp' && args.carrier !== undefined) {
            reusedLines.push('CDP 模式载体由接管端点决定，carrier 参数不参与。')
          }
          return reusedLines.join('\n')
        }
        const lines = [info.summary]
        if (info.mode === 'cdp') {
          lines.push(`接管端点：${info.endpoint}`)
          if (args.carrier !== undefined) lines.push('CDP 模式载体由接管端点决定，carrier 参数不参与。')
          lines.push('CDP 模式不会关闭你的浏览器，browser_e2e_close 只断开连接。')
          return lines.join('\n')
        }
        lines.push(`产物目录：${info.artifactsDir}`)
        return lines.join('\n')
      },
    },
    {
      name: 'browser_e2e_auth_export',
      access: 'observe',
      description: '把当前 isolated 会话的登录态（cookie + localStorage）导出成 Playwright storageState JSON 文件。'
        + 'path 必填，必须是 ~/.dsh/browser-e2e/auth/ 下的 .json 绝对路径（上级目录不存在时自动创建）；'
        + '文件已存在时必须显式 overwrite: true。domains 可选，按域名后缀过滤。'
        + '返回路径 / 字节数 / 条目数与域名，不含任何 cookie 名或值；文件是明文凭据，勿提交仓库。'
        + 'CDP 模式拒绝导出（那会把用户浏览器的 cookie 写到磁盘）；close 与空闲回收不会自动导出。',
      parameters: params({
        path: {
          type: 'string',
          description: '导出到的宿主绝对路径，.json，且必须位于 ~/.dsh/browser-e2e/auth/ 下',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: '只导出命中域名的 cookie / origin；不传=当前上下文全部条目',
        },
        overwrite: { type: 'boolean', description: '文件已存在时必须显式 true 才覆盖，默认 false' },
      }, ['path']),
      async run(args, exec) {
        const info = await exportStorageState(sessionKey(exec), args)
        return info.summary
      },
    },
    {
      name: 'browser_e2e_navigate',
      access: 'observe',
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
      access: 'observe',
      description: '标签页操作，由 action 选择：list（缺省）列出本会话标签页（tab_id / url / title / active / loading / origin），'
        + '作用于页面的工具都可传 tab_id，缺省用 active tab；'
        + 'close 关闭 tab_id 指定的标签页，最后一个标签页不允许关闭（结束整个浏览器用 browser_e2e_close）；'
        + 'follow 把后续页面工具的默认标签页绑定到 tab_id，不给 tab_id 时自动判定用户当前正在看的标签页'
        + '（窗口焦点所在页优先，其次唯一可见页，无法唯一判定时保持当前页），activate=true 把该页带到前台'
        + `（单页探测超时 ${FOLLOW_PROBE_TIMEOUT_MS}ms）；绑定后不传 tab_id 的工具都默认作用到该页，`
        + '不做静默自动跟随，用户切页后仍需显式调用本工具。',
      parameters: params({
        action: {
          type: 'string',
          enum: TABS_ACTIONS,
          description: 'list（缺省）列出标签页；close 关闭指定标签页（需要 tab_id）；'
            + 'follow 绑定默认标签页（tab_id 可选，缺省自动判定用户当前正在看的页）',
        },
        tab_id: {
          type: 'string',
          description: '标签页 id（browser_e2e_tabs 得到，形如 t1、t2…）：action=close 必填；'
            + 'action=follow 给了就跳过自动判定；action=list 不接受',
        },
        activate: {
          type: 'boolean',
          description: '仅 action=follow：绑定后把该页带到前台，默认 false；只对 CDP 接管 / 有头隔离模式有可见效果',
        },
      }),
      async run(args, exec) {
        const action = args.action ?? 'list'
        if (!TABS_ACTIONS.includes(action)) {
          throw new Error(`action 只支持 ${TABS_ACTIONS.join(' / ')}，收到 ${JSON.stringify(action)}；不传 action 等于 list`)
        }
        if (action === 'close') {
          if (args.activate !== undefined) {
            throw new Error('action=close 不接受 activate：带到前台只在 action=follow 时有效')
          }
          const tabId = requireString(args, 'tab_id')
          const info = await closeTab(sessionKey(exec), tabId)
          return `${info.summary}\n下一个操作默认作用于：${info.activeTabId ?? '无'}`
        }
        if (action === 'follow') {
          const session = sessionOf(sessionKey(exec), exec?.agent?.id)
          const info = await followTab(session, { tab_id: args.tab_id, activate: args.activate })
          const sourceText = {
            explicit: '显式 tab_id',
            focused: '窗口焦点所在页',
            visible: '唯一可见页',
            current: '多个页同时可见或都不可见，保持当前',
          }[info.source] ?? info.source
          const lines = [
            info.summary,
            `判定依据：${sourceText}`,
            `上一个默认标签页：${info.previousTabId ?? '无'}`,
          ]
          if (Array.isArray(info.candidates)) {
            const probeText = info.candidates
              .map((candidate) => `${candidate.tabId} ${candidate.visibility} / ${candidate.focus ? '已聚焦' : '未聚焦'}`)
              .join('；')
            const omitted = info.tabs - (info.failedProbeCount ?? 0) - info.candidates.length
            lines.push(`探测结果：${probeText}${omitted > 0 ? `；…等 ${omitted} 个` : ''}`)
          }
          if (args.activate === true) {
            lines.push(`已请求带到前台：${info.activated ? '是' : '否'}`)
            lines.push('无头模式没有可见窗口，activate 只对 CDP 接管 / 有头隔离模式有可见效果。')
          }
          lines.push(`后续作用于页面的工具不传 tab_id 时默认作用在 ${info.tabId}。`)
          return lines.join('\n')
        }
        if (args.tab_id !== undefined || args.activate !== undefined) {
          throw new Error('action=list 不接受 tab_id / activate：列出标签页请只传 action: "list"（或不传 action）')
        }
        const info = await listSessionTabs(sessionKey(exec))
        return `${info.summary}\nmode=${info.mode}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_snapshot',
      access: 'observe',
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
      name: 'browser_e2e_read',
      access: 'observe',
      description: '结构化读取页面：按 controls / links / tables / forms 四节返回记录'
        + '（控件带 role / name / type / value / checked / options / form，链接带绝对 href，表格带表头与行矩阵，表单带 action / fieldCount），'
        + '每条记录带一个经页面校验的 CSS selector，unique 为 true 时可直接传给 browser_e2e_click / browser_e2e_fill；'
        + 'unique 为 false 的 selector 在页面上不唯一（或超长被省略），不能直接用于 click / fill。'
        + `默认读 controls / links / tables 三节，maxItems 默认 ${READ_DEFAULT_ITEMS}（1-${READ_MAX_ITEMS}）；`
        + 'includeValues 默认 false，password / file 永不返回值；selector 作为作用域根收窄范围。'
        + '只读主文档，不进入 iframe 与 shadow root；不写快照 ref、不建快照基线。'
        + `模型可见文本上限 ${READ_TEXT_LIMIT} 字符，超出按节截断并标「已截断」，要读更多请只请求一节或用 selector 收窄范围。`,
      parameters: params({
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: '要读的节：controls / links / tables / forms；重复值去重，空数组报错，输出顺序固定为 controls → links → tables → forms，默认 controls / links / tables',
        },
        maxItems: {
          type: 'integer',
          description: `每节最多列出的条目数（表格另用它限制每张表列出的行数），默认 ${READ_DEFAULT_ITEMS}，取值 1-${READ_MAX_ITEMS}`,
        },
        includeValues: { type: 'boolean', description: '是否返回控件当前值；默认 false，password / file 永不返回' },
        selector: { type: 'string', description: 'CSS 选择器作为作用域根，只读它及其后代；空串按未给处理' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await readStructured(session, {
          sections: args.sections,
          maxItems: args.maxItems,
          includeValues: args.includeValues,
          selector: args.selector,
        }, args.tab_id)
        return `${info.summary}\n当前页面：${info.url}（标签页 ${info.tabId}）\n\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_click',
      access: 'interact',
      description: '点击元素。三种方式三选一：ref（snapshot 得到的 @N，点击前会复验仍可见）、'
        + 'selector（CSS 选择器，先等可见再点）、x + y（视口坐标，真实鼠标事件）。'
        + 'clickCount 1-3 表示单击 / 双击 / 三击；button 选左键 / 右键 / 中键；'
        + 'modifiers 在点击期间额外按住 Alt / Control / Meta / Shift，已按住的键用 browser_e2e_press action=up 释放。'
        + '页面变化后 ref 会失效，请重新 browser_e2e_snapshot。',
      parameters: params({
        ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
        selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
        x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
        y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
        clickCount: {
          type: 'integer',
          description: `点击次数 ${CLICK_COUNTS.min}-${CLICK_COUNTS.max}，缺省 1；2 为双击、3 为三击`,
        },
        button: {
          type: 'string',
          enum: CLICK_BUTTONS,
          description: '鼠标键，缺省 left；right 触发 contextmenu，middle 触发 auxclick',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: CLICK_MODIFIERS },
          description: '点击期间额外按住的修饰键，缺省不额外按；点击后只释放本次按下的键',
        },
        frame: {
          type: ['integer', 'string'],
          description: '目标 iframe：0 为主文档（缺省），n≥1 按 frame 顺序取第 n 个，字符串先按 name 精确匹配、再按 url 子串；只能与 selector 组合（子 frame 不分配 ref），与 ref / x+y 互斥',
        },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await click(session, {
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
          clickCount: args.clickCount,
          button: args.button,
          modifiers: args.modifiers,
          frame: args.frame,
        }, args.tab_id)
        return `${info.summary}\n如需继续操作请重新 browser_e2e_snapshot。`
      },
    },
    {
      name: 'browser_e2e_fill',
      access: 'interact',
      description: '向输入框填入文本，适用于 input / textarea / contenteditable。三种目标三选一：'
        + 'ref（snapshot 得到的 @N）、selector（CSS 选择器）、x + y（视口坐标，真实鼠标点击后键入）。'
        + 'mode 缺省 insert：一次写入并替换原值；mode=keystrokes 先清空再逐键输入，'
        + '用于受控组件、掩码输入、防抖输入或只监听 keydown / keypress / keyup 的输入框，只支持 ref / selector。'
        + `delayMs 是相邻按键之间的等待毫秒数，默认 0（0-${KEYSTROKE_MAX_DELAY_MS}），仅 mode=keystrokes 有效；`
        + `keystrokes 一次最多 ${KEYSTROKE_MAX_CHARS} 个字符（按码点计），且 delayMs × 字符数不超过 ${KEYSTROKE_DELAY_BUDGET_MS} ms。`,
      parameters: params({
        ref: { type: 'string', description: '元素引用，格式 @N；与 selector / x+y 三选一' },
        selector: { type: 'string', description: 'CSS 选择器；与 ref / x+y 三选一' },
        x: { type: 'number', description: '视口坐标 x（CSS 像素）；与 y 一起使用，与 ref / selector 三选一' },
        y: { type: 'number', description: '视口坐标 y（CSS 像素）；与 x 一起使用' },
        value: { type: 'string', description: '要填入的文本' },
        mode: {
          type: 'string',
          enum: ['insert', 'keystrokes'],
          description: '写入方式，缺省 insert（一次赋值并替换）；keystrokes 逐键输入（先清空再按键），只支持 ref / selector',
        },
        delayMs: {
          type: 'integer',
          description: `相邻按键之间的等待毫秒数，默认 0；仅 mode=keystrokes 有效，取值 0-${KEYSTROKE_MAX_DELAY_MS}`,
        },
        frame: {
          type: ['integer', 'string'],
          description: '目标 iframe：0 为主文档（缺省），n≥1 按 frame 顺序取第 n 个，字符串先按 name 精确匹配、再按 url 子串；只能与 selector 组合（子 frame 不分配 ref），与 ref / x+y 互斥',
        },
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
          frame: args.frame,
        }, value, args.tab_id, { mode: args.mode, delayMs: args.delayMs })
        return info.summary
      },
    },
    {
      name: 'browser_e2e_hover',
      access: 'interact',
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
      access: 'interact',
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
      access: 'interact',
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
          description: `本次 files 的总字节数上限，默认 ${DEFAULT_MAX_UPLOAD_BYTES}（${sizeText(DEFAULT_MAX_UPLOAD_BYTES)}），取值 1..${MAX_UPLOAD_BYTES}（${sizeText(MAX_UPLOAD_BYTES)}）`,
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
      access: 'interact',
      description: '滚动页面，用于触发懒加载或浏览长页。delta_x / delta_y 为滚动距离，至少一个非 0；'
        + '给 x + y 时先移动鼠标到该视口坐标再滚，否则在当前位置滚动。',
      parameters: params({
        delta_x: { type: 'number', description: '滚动横向距离（像素），默认 0' },
        delta_y: { type: 'number', description: '滚动纵向距离（像素），默认 0' },
        x: { type: 'number', description: '可选：滚动前把鼠标移动到该视口坐标 x（CSS 像素）' },
        y: { type: 'number', description: '可选：滚动前把鼠标移动到该视口坐标 y（CSS 像素）' },
        frame: {
          type: ['integer', 'string'],
          description: '目标 iframe：0 为主文档（缺省），n≥1 按 frame 顺序取第 n 个，字符串先按 name 精确匹配、再按 url 子串；与 x / y 互斥。滚轮落在 frame 元素中心，实际滚动量由页面决定',
        },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await scroll(session, {
          delta_x: args.delta_x,
          delta_y: args.delta_y,
          x: args.x,
          y: args.y,
          frame: args.frame,
        }, args.tab_id)
        return info.summary
      },
    },
    {
      name: 'browser_e2e_press',
      access: 'interact',
      description: `键盘按键，作用于当前焦点元素。action=press（缺省）按下并抬起一次，repeat 1-${MAX_PRESS_REPEAT} 重复整次按键；`
        + 'action=down 只按下并保持按住，action=up 只释放。按住的键按标签页记账，会影响随后的 click / fill，'
        + 'navigate 前自动释放；down / up 只接受单个按键名（如 Shift、a、Enter），组合键（Control+A）用 action=press。',
      parameters: params({
        key: { type: 'string', description: '按键名，如 Enter；action=press 支持 Control+A 这类组合键，down / up 只接受单个按键名' },
        action: {
          type: 'string',
          enum: PRESS_ACTIONS,
          description: 'press（缺省）按下并抬起；down 只按下并保持按住；up 只释放',
        },
        repeat: {
          type: 'integer',
          description: `重复整次按下 / 抬起的次数，1-${MAX_PRESS_REPEAT}，缺省 1；只对 action=press 生效`,
        },
        tab_id: TAB_ID_PARAM,
      }, ['key']),
      async run(args, exec) {
        const key = requireString(args, 'key')
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await press(session, key, args.tab_id, { action: args.action, repeat: args.repeat })
        return info.summary
      },
    },
    {
      name: 'browser_e2e_clipboard',
      access: 'interact',
      description: '剪贴板写入与粘贴投递。action=write：把文本与可选富文本 HTML 写进浏览器剪贴板；'
        + 'action=paste：把带 text/plain / text/html 的 paste 事件投递到 ref / selector 目标，'
        + '缺省当前焦点元素（contenteditable 容器常被裁剪，selector 只要求 attached）。'
        + `text 最多 ${CLIPBOARD_TEXT_LIMIT} 字符，html 最多 ${CLIPBOARD_HTML_LIMIT} 字符；`
        + 'html 缺省在页内按白名单净化（移除脚本 / 表单元素 / on* 属性与非 http(s) URL），sanitize: false 只在 isolated 模式允许。'
        + 'isolated 模式写入前自动授予本会话浏览器上下文 clipboard-write；cdp 模式不授权，被拒绝时需在该站点手动允许。'
        + '不做真实快捷键粘贴（method=system），也不回读剪贴板内容。',
      parameters: params({
        action: { type: 'string', enum: ['write', 'paste'], description: 'write：写浏览器剪贴板；paste：投递 paste 事件' },
        text: { type: 'string', description: '纯文本：action=write 时与 html 至少一个非空；action=paste 时必须非空' },
        html: { type: 'string', description: '富文本 HTML；空串按未给处理，缺省在页内按白名单净化' },
        sanitize: { type: 'boolean', description: '默认 true：用页内白名单清理 HTML；false 只在 isolated 模式允许，只对带 html 的调用生效' },
        ref: { type: 'string', description: '粘贴目标元素引用，格式 @N；与 selector 二选一，仅 action=paste' },
        selector: { type: 'string', description: '粘贴目标 CSS 选择器；与 ref 二选一，仅 action=paste' },
        tab_id: TAB_ID_PARAM,
      }, ['action']),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await clipboard(session, {
          action: args.action,
          text: args.text,
          html: args.html,
          sanitize: args.sanitize,
          ref: args.ref,
          selector: args.selector,
        }, args.tab_id)
        const sanitize = args.sanitize !== false
        const flavor = info.rich ? 'text+html' : 'text'
        if (info.action === 'paste') {
          const target = info.target
          const text = target.mode === 'ref'
            ? `ref ${target.ref} (${target.tag} "${target.name}")`
            : target.mode === 'selector'
              ? `selector "${target.selector}"`
              : '当前焦点元素'
          return `${info.summary}\n目标：${text}；sanitize=${sanitize}；口味：${flavor}`
            + '\n若页面没有消费该事件，说明它没有 paste 处理器；真实快捷键粘贴可先 action=write 再 browser_e2e_press("Control+V")（不保证投递成功）。'
        }
        return `${info.summary}\n目标：剪贴板；sanitize=${sanitize}；口味：${flavor}`
          + '\nisolated 模式会自动授予本会话浏览器上下文 clipboard-write；cdp 模式不授权，被拒绝时请手动允许该站点写剪贴板。'
      },
    },
    {
      name: 'browser_e2e_screenshot',
      access: 'observe',
      description: '截取当前页面。默认截视口 PNG，落盘后返回路径；宿主提供附件服务时图片本身也会一并返回。'
        + `clip 裁剪区域（相对视口 CSS 像素），format 支持 png / jpeg，quality 仅 jpeg（${MIN_SHOT_QUALITY}-${MAX_SHOT_QUALITY}），`
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
        quality: { type: 'integer', description: `JPEG 质量 ${MIN_SHOT_QUALITY}-${MAX_SHOT_QUALITY}，仅 format=jpeg 时有效` },
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
      name: 'browser_e2e_download',
      access: 'interact',
      description: '下载一个文件并做完整性校验：来源二选一——url（HTTP(S) 直接经当前浏览器上下文请求，'
        + '不导航当前页，共享 Cookie / 登录态），或 ref / selector / x + y（先挂 download 事件再按 click 语义点击触发）。'
        + '落盘到会话产物目录的 downloads 子目录，可用环境变量 DSH_BROWSER_DOWNLOAD_DIR（绝对路径）覆盖；'
        + `单文件上限默认 ${DEFAULT_MAX_DOWNLOAD_BYTES} 字节（${sizeText(DEFAULT_MAX_DOWNLOAD_BYTES)}），可调到 ${MAX_DOWNLOAD_BYTES} 字节（${sizeText(MAX_DOWNLOAD_BYTES)}）；`
        + '0 字节与超限都按失败处理并删除半成品，同名自动加 -1 / -2 后缀，绝不覆盖。'
        + '成功返回文件绝对路径、字节数与 SHA-256；expectedSha256 给了就强校验，不匹配时报错并删除文件。'
        + `timeoutMs 默认 ${DEFAULT_DOWNLOAD_TIMEOUT_MS}，取值 ${DOWNLOAD_TIMEOUT_MIN_MS}..${DOWNLOAD_TIMEOUT_MAX_MS}，是等待与写盘的总预算。`,
      parameters: params({
        url: { type: 'string', description: 'HTTP(S) 地址；与 ref / selector / x + y 互斥。直接经当前浏览器上下文请求，不导航页面，共享 Cookie / 登录态' },
        ref: { type: 'string', description: '触发下载的元素引用（snapshot 得到的 @N）；与 url / selector / x + y 互斥' },
        selector: { type: 'string', description: '触发下载的 CSS 选择器；与 url / ref / x + y 互斥' },
        x: { type: 'number', description: '触发下载的视口坐标 x（CSS 像素）；与 y 一起使用' },
        y: { type: 'number', description: '触发下载的视口坐标 y（CSS 像素）；与 x 一起使用' },
        filename: { type: 'string', description: '纯文件名（不含目录），覆盖服务器建议名；同名自动加 -1 / -2 后缀，不覆盖' },
        maxBytes: {
          type: 'integer',
          description: `单文件上限，默认 ${DEFAULT_MAX_DOWNLOAD_BYTES}（${sizeText(DEFAULT_MAX_DOWNLOAD_BYTES)}），取值 1..${MAX_DOWNLOAD_BYTES}（${sizeText(MAX_DOWNLOAD_BYTES)}）`,
        },
        expectedSha256: { type: 'string', description: '可选：64 位十六进制 SHA-256；不匹配时报错并删除文件' },
        timeoutMs: {
          type: 'integer',
          description: `总预算，默认 ${DEFAULT_DOWNLOAD_TIMEOUT_MS}，取值 ${DOWNLOAD_TIMEOUT_MIN_MS}..${DOWNLOAD_TIMEOUT_MAX_MS}`,
        },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await download(session, {
          url: args.url,
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
          filename: args.filename,
          maxBytes: args.maxBytes,
          expectedSha256: args.expectedSha256,
          timeoutMs: args.timeoutMs,
        }, args.tab_id)
        const origin = info.source === 'request' ? '直接请求' : '点击触发'
        return `${info.summary}\nsha256：${info.sha256}\n来源：${origin} ${info.url}（${info.elapsedMs}ms）`
      },
    },
    {
      name: 'browser_e2e_fetch',
      access: 'observe',
      description: '用会话浏览器抓取一页正文，不导航当前标签页、不重置 ref 表与事件环。'
        + '在 tab_id 所属浏览器上下文里开一个临时页（共享该页 Cookie / 登录态）→ domcontentloaded → 等 settleMs → '
        + '取 article / main / [role=main]（缺省 body）的 innerText 与 document.title，'
        + '返回 tabId / url / statusCode / title / text / truncated / empty / elapsedMs / mode。'
        + '非 2xx 与空正文都是结果不是错误。临时页用完即关、不登记为标签页（CDP 模式下会在用户浏览器里一闪）。'
        + `正文上限 maxChars 默认 ${READ_TEXT_LIMIT}（1-${FETCH_MAX_TEXT_CHARS}），`
        + `settleMs 默认 ${FETCH_DEFAULT_SETTLE_MS}（0-${FETCH_MAX_SETTLE_MS}），`
        + `timeoutMs 默认 ${FETCH_DEFAULT_TIMEOUT_MS}（${FETCH_TIMEOUT_MIN_MS}-${FETCH_TIMEOUT_MAX_MS}，只约束导航）。`
        + '只支持 http / https；不返回 HTML，不进入 iframe / shadow DOM，不落盘（要文件用 browser_e2e_download）。',
      parameters: params({
        url: { type: 'string', description: 'http / https 绝对地址' },
        settleMs: {
          type: 'integer',
          description: `domcontentloaded 之后等待页面稳定的毫秒数，默认 ${FETCH_DEFAULT_SETTLE_MS}；0 表示不等，取值 0-${FETCH_MAX_SETTLE_MS}`,
        },
        timeoutMs: {
          type: 'integer',
          description: `导航超时毫秒数，默认 ${FETCH_DEFAULT_TIMEOUT_MS}，取值 ${FETCH_TIMEOUT_MIN_MS}..${FETCH_TIMEOUT_MAX_MS}；只约束 goto，不约束整次调用`,
        },
        maxChars: {
          type: 'integer',
          description: `正文的字符上限，默认 ${READ_TEXT_LIMIT}，取值 1..${FETCH_MAX_TEXT_CHARS}；超出截断并置 truncated`,
        },
        tab_id: TAB_ID_PARAM,
      }, ['url']),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await fetchText(session, {
          url: args.url,
          settleMs: args.settleMs,
          timeoutMs: args.timeoutMs,
          maxChars: args.maxChars,
        }, args.tab_id)
        const lines = [
          info.summary,
          `标题：${info.title || '（空）'}`,
          `来源标签页：${info.tabId}（${info.mode === 'cdp' ? 'CDP 接管' : '隔离'}）`,
        ]
        if (info.empty) {
          lines.push('（正文为空：页面可能在脚本渲染完成后才有内容，可调大 settleMs，或改用 browser_e2e_navigate + browser_e2e_read）')
        }
        lines.push('', info.text)
        return lines.join('\n')
      },
    },
    {
      name: 'browser_e2e_http',
      access: 'interact',
      description: '原始 HTTP 请求（仅浏览器上下文模式 mode=context）：用当前标签页所属浏览器上下文的请求客户端'
        + '发任意 method / headers / body，不导航当前页、共享该页 Cookie 与登录态、不受页面 CORS 限制（不是页面内 fetch）。'
        + '返回状态码、响应头（authorization / cookie / set-cookie 等敏感头脱敏）与正文：文本类按 max_chars 截断，'
        + '二进制只给字节数与 SHA-256（不返回 base64）。非 2xx 是结果不是错误（ok=false）。不落盘；'
        + `需要落盘与完整性校验用 browser_e2e_download。timeout_ms 默认 ${DEFAULT_HTTP_TIMEOUT_MS}（${MIN_HTTP_TIMEOUT_MS}..${MAX_HTTP_TIMEOUT_MS}）。`
        + '只支持 mode=context；原始 CDP 与服务端直连模式未实现。',
      parameters: params({
        url: { type: 'string', description: 'http / https 绝对地址' },
        method: {
          type: 'string',
          enum: HTTP_METHODS,
          description: `请求方法，默认 GET；只支持 ${HTTP_METHODS.join(' / ')}`,
        },
        headers: {
          type: 'object',
          description: `请求头字符串键值对，最多 ${HTTP_MAX_HEADERS} 项、单项值最长 ${HTTP_MAX_HEADER_CHARS} 字符`,
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: `请求体，最长 ${HTTP_MAX_BODY_CHARS} 字符；GET / HEAD 不能带 body`,
        },
        mode: {
          type: 'string',
          enum: ['context'],
          description: '请求出口；本工具只支持 context（当前页所属浏览器上下文，共享 Cookie），缺省即 context',
        },
        timeout_ms: {
          type: 'integer',
          description: `请求超时毫秒数，默认 ${DEFAULT_HTTP_TIMEOUT_MS}，取值 ${MIN_HTTP_TIMEOUT_MS}..${MAX_HTTP_TIMEOUT_MS}`,
        },
        max_chars: {
          type: 'integer',
          description: `返回正文的字符上限，默认 ${HTTP_RESULT_MAX_CHARS}，取值 1..${HTTP_RESULT_MAX_CHARS}`,
        },
        tab_id: TAB_ID_PARAM,
      }, ['url']),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await rawHttp(session, {
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
          mode: args.mode,
          timeoutMs: args.timeout_ms,
          maxChars: args.max_chars,
        }, args.tab_id)
        const body = info.body
        const bodyText = body.kind === 'binary'
          ? `（二进制正文 ${body.bytes} 字节，sha256 ${body.sha256}）`
          : (body.kind === 'empty' ? '（空正文）' : body.text)
        return `${info.summary}\n${bodyText}`
      },
    },
    {
      name: 'browser_e2e_console',
      access: 'observe',
      description: '读取当前页面捕获的控制台记录（log / info / warn / error / debug 与未捕获异常），最新在最后。'
        + '可用 level 只读取不低于某严重级别的记录；不可判级的记录类型（如 table / assert）始终保留。'
        + `缓冲上限 ${RING_LIMIT} 条，limit 默认 ${DEFAULT_RING_QUERY_LIMIT}（取尾部）。导航时清空。`,
      parameters: params({
        limit: { type: 'integer', description: `最多返回尾部多少条，默认 ${DEFAULT_RING_QUERY_LIMIT}` },
        level: { type: 'string', enum: CONSOLE_LEVEL_ENUM, description: CONSOLE_LEVEL_DESC },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const info = await consoleEntries(
          requireSession(sessionKey(exec)), args.limit ?? DEFAULT_RING_QUERY_LIMIT, args.tab_id, { level: args.level },
        )
        const note = info.level !== null
          ? (info.matched > info.count ? `（命中 ${info.matched} 条，只取尾部 ${info.count} 条）` : '')
          : (info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : '')
        return `${info.summary}${note}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_network',
      access: 'observe',
      description: '读取当前页面观测到的网络请求（url / method / status / mimeType / failure），最新在最后。'
        + '每条记录带 request_id（n1、n2…）；传 request_id 时改读该条请求的详情：请求头、请求体、响应头、响应体（JSON 自动格式化），'
        + `文本正文与请求体最多 ${NETWORK_BODY_TEXT_LIMIT} 字符，读取正文超时默认 ${NETWORK_BODY_TIMEOUT_MS}ms`
        + `（${NETWORK_BODY_TIMEOUT_MIN_MS}..${NETWORK_BODY_TIMEOUT_MAX_MS}），二进制只回大小与 sha256（不返回 base64），`
        + '默认隐藏敏感头（include_sensitive 可显式打开）。'
        + `status 为 0 表示请求没有拿到响应，此时看 failure。缓冲上限 ${RING_LIMIT} 条，limit 默认 ${DEFAULT_RING_QUERY_LIMIT}（取尾部）。导航时清空。`,
      parameters: params({
        limit: { type: 'integer', description: `最多返回尾部多少条，默认 ${DEFAULT_RING_QUERY_LIMIT}` },
        request_id: {
          type: 'string',
          description: '可选：给了就按列表里的 n3 这类 id 读取单条请求详情（此时不接受 limit）；不传走列表模式',
        },
        max_chars: {
          type: 'integer',
          description: `仅 request_id 模式：文本正文与请求体最多返回的字符数，1..${NETWORK_BODY_TEXT_LIMIT}，默认 ${NETWORK_BODY_TEXT_LIMIT}`,
        },
        timeout_ms: {
          type: 'integer',
          description: `仅 request_id 模式：读取正文的超时毫秒数，${NETWORK_BODY_TIMEOUT_MIN_MS}..${NETWORK_BODY_TIMEOUT_MAX_MS}，默认 ${NETWORK_BODY_TIMEOUT_MS}`,
        },
        include_sensitive: {
          type: 'boolean',
          description: '仅 request_id 模式：是否显示敏感头（authorization / cookie 等）原值，默认 false',
        },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = requireSession(sessionKey(exec))
        if (args.request_id === undefined) {
          if (args.max_chars !== undefined || args.timeout_ms !== undefined || args.include_sensitive !== undefined) {
            throw new Error('max_chars / timeout_ms / include_sensitive 只在传 request_id 时生效；只读列表请不传这三个参数')
          }
          const info = await networkEntries(session, args.limit ?? DEFAULT_RING_QUERY_LIMIT, args.tab_id)
          const totalNote = info.total > info.count ? `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）` : ''
          return `${info.summary}${totalNote}\n${info.text}`
        }
        if (args.limit !== undefined) {
          throw new Error('request_id 模式下不接受 limit：看列表用 limit，读详情用 request_id')
        }
        const info = await networkDetail(session, requireString(args, 'request_id'), {
          maxChars: args.max_chars,
          timeoutMs: args.timeout_ms,
          includeSensitive: args.include_sensitive,
        }, args.tab_id)
        return `${info.summary}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_dialog',
      access: 'interact',
      description: '报告页面弹出的 JavaScript 对话框（alert / confirm / prompt），并按标签页选择如何应答。'
        + '每个对话框在打开时**立即**按当时策略应答并记录（类型 / 文案 / prompt 默认值 / 实际应答），'
        + '所以策略必须在触发动作**之前**设好：要读文案用默认 dismiss（记录照写），要走确认分支先设 accept。'
        + '策略只对设置之后打开的对话框生效，新标签页从 dismiss 开始。'
        + 'accept 时 prompt 用 prompt_text，没给就用页面默认值；beforeunload 一律接受（与浏览器默认一致）。'
        + `记录上限 ${DIALOG_RING_LIMIT} 条，limit 默认 ${DIALOG_LIMIT_DEFAULT}（取尾部，最多 ${DIALOG_RING_LIMIT}）。`
        + 'HTTP 认证 / 权限请求不在覆盖范围。',
      parameters: params({
        policy: {
          type: 'string',
          enum: ['dismiss', 'accept'],
          description: '设置该标签页后续对话框的应答策略，不传表示只读；accept 时 prompt 用 prompt_text（没给用页面默认值）',
        },
        prompt_text: {
          type: 'string',
          description: `policy=accept 时 prompt 的输入文本，0..${DIALOG_PROMPT_TEXT_LIMIT} 字符；与 policy=dismiss 互斥`,
        },
        limit: {
          type: 'integer',
          description: `读取尾部条数，默认 ${DIALOG_LIMIT_DEFAULT}，超过 ${DIALOG_RING_LIMIT} 按 ${DIALOG_RING_LIMIT}；非正整数回退默认`,
        },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = requireSession(sessionKey(exec))
        // 只给 prompt_text 而没有 policy 是调用错误，不能静默忽略（见功能规格的错误文案）。
        if (args.policy === undefined && args.prompt_text !== undefined) {
          throw new Error('prompt_text 只在 policy=accept 时生效；要输入 prompt 文本请同时传 policy: "accept"')
        }
        const changed = args.policy === undefined
          ? null
          : await setDialogPolicy(session, args.policy, args.prompt_text, args.tab_id)
        const info = await dialogEntries(session, args.limit ?? DIALOG_LIMIT_DEFAULT, args.tab_id)
        const head = changed === null ? info.summary : `${changed.summary}\n${info.summary}`
        return `${head}\n${info.text}`
      },
    },
    {
      name: 'browser_e2e_wait',
      access: 'observe',
      description: '等待页面条件满足：selector / expression / url / response 四选一。'
        + 'selector 配合 state（attached / visible / hidden / detached，默认 visible）；'
        + 'expression 是页面内 JS 表达式，返回真值即满足；'
        + 'url 等待主框架地址命中；response 等待匹配的响应到达，可用 responseMethod 与 statusMin / statusMax 过滤。'
        + 'url / response 的 URL 匹配方式由 urlMatch 决定（includes / glob / regex，默认 includes）。'
        + `response 的 includeBuffered 默认 true，会先回放当前文档已完成的响应（缓冲上限 ${RING_LIMIT} 条）；`
        + 'failOnRequestFailed 默认 true，匹配的请求失败立即报错。'
        + `timeoutMs 默认 ${DEFAULT_WAIT_TIMEOUT_MS}；超时会报错并带实际等待时长与诊断。`,
      parameters: params({
        selector: { type: 'string', description: 'CSS 选择器；与 expression / url / response 四选一' },
        expression: { type: 'string', description: '页面内 JS 表达式；与 selector / url / response 四选一，多行逻辑用 IIFE' },
        url: { type: 'string', description: '地址匹配模式；与 selector / expression / response 四选一' },
        response: { type: 'string', description: '响应的 URL 匹配模式；与 selector / expression / url 四选一' },
        state: { type: 'string', description: 'selector 的等待状态：attached | visible | hidden | detached，默认 visible' },
        urlMatch: { type: 'string', description: 'url / response 的匹配方式：includes | glob | regex，默认 includes' },
        responseMethod: { type: 'string', description: 'response 条件的 HTTP 方法过滤；不给表示不限，比较时转大写' },
        statusMin: { type: 'integer', description: `response 条件的状态码下限，${WAIT_STATUS_MIN}-${WAIT_STATUS_MAX}，默认 ${WAIT_STATUS_MIN}` },
        statusMax: { type: 'integer', description: `response 条件的状态码上限，${WAIT_STATUS_MIN}-${WAIT_STATUS_MAX}，默认 ${WAIT_STATUS_MAX}` },
        includeBuffered: { type: 'boolean', description: 'response 条件是否回放等待开始前已完成的响应，默认 true' },
        failOnRequestFailed: { type: 'boolean', description: 'response 条件匹配的请求失败时是否立即报错，默认 true' },
        timeoutMs: { type: 'integer', description: `超时毫秒数，默认 ${DEFAULT_WAIT_TIMEOUT_MS}` },
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
      name: 'browser_e2e_captcha_check',
      access: 'observe',
      description: '非阻塞探测当前页面有没有人机验证（reCAPTCHA / hCaptcha / Turnstile / Cloudflare 挑战 / 通用 captcha），'
        + '返回 detected、kind 与 evidence（命中的选择器或文本片段）。'
        + '结构检测优先；未命中且 textScan 为 true 时读页面可见文本做兜底，loopback 主机名跳过文本检测以免误报。'
        + '检测是启发式：detected=false 只表示未检测到，不是「页面一定没有验证」；'
        + '需要等用户处理完再继续时用 browser_e2e_wait_for_human。',
      parameters: params({
        textScan: { type: 'boolean', description: '是否读页面文本做兜底，默认 true；false 只做 DOM 结构检测' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await humanCheck(session, { textScan: args.textScan, tab_id: args.tab_id })
        const lines = [info.summary, `当前页面：${info.url}（标签页 ${info.tabId}）`]
        if (info.detected) lines.push(`依据：${info.evidence}`)
        return lines.join('\n')
      },
    },
    {
      name: 'browser_e2e_wait_for_human',
      access: 'interact',
      description: '把页面交给用户完成人机验证（扫码登录 / 2FA / 滑块 / reCAPTCHA），轮询到「验证消失 + 可选完成信号出现」。'
        + `reason 是自由文本（默认 confirm，空白折叠后保留前 ${HUMAN_REASON_LIMIT} 字符）。`
        + `timeoutMs 默认 ${HUMAN_TIMEOUT_MS_DEFAULT}，允许 ${HUMAN_TIMEOUT_MS_MIN}-${HUMAN_TIMEOUT_MS_MAX}；`
        + `pollMs 默认 ${HUMAN_POLL_MS_DEFAULT}，允许 ${HUMAN_POLL_MS_MIN}-${HUMAN_POLL_MS_MAX}。`
        + 'selector 是可选完成信号（如登录成功后的元素），与「未检测到验证」同时满足才返回。'
        + '超时不是错误：返回 resolved=false 与 hint，确认用户完成后可再次调用。'
        + '调用前先把「去哪个窗口做什么」告诉用户；isolated 默认 headless 时用户看不到窗口，结果里的 headless 与提示用于改走 headless=false 或 cdp。',
      parameters: params({
        reason: { type: 'string', description: `等待原因，自由文本，如 captcha / login / 2fa / confirm；默认 confirm，超长截断到 ${HUMAN_REASON_LIMIT} 字符` },
        timeoutMs: { type: 'integer', description: `等待上限（毫秒），${HUMAN_TIMEOUT_MS_MIN}-${HUMAN_TIMEOUT_MS_MAX}，默认 ${HUMAN_TIMEOUT_MS_DEFAULT}` },
        pollMs: { type: 'integer', description: `轮询间隔（毫秒），${HUMAN_POLL_MS_MIN}-${HUMAN_POLL_MS_MAX}，默认 ${HUMAN_POLL_MS_DEFAULT}` },
        selector: { type: 'string', description: '可选的完成信号 CSS 选择器（如登录成功后的元素）；空串与纯空白按未给处理' },
        textScan: { type: 'boolean', description: '是否读页面文本做兜底，默认 true；false 只做 DOM 结构检测' },
        tab_id: TAB_ID_PARAM,
      }),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await waitForHuman(session, {
          reason: args.reason,
          timeoutMs: args.timeoutMs,
          pollMs: args.pollMs,
          selector: args.selector,
          textScan: args.textScan,
          tab_id: args.tab_id,
        })
        const lines = [info.summary, `当前页面：${info.url}（标签页 ${info.tabId}）`]
        if (info.selector) lines.push(`完成信号：${info.selector}`)
        if (!info.resolved) lines.push(`提示：${info.hint}`)
        if (info.probeErrors > 0) lines.push(`最近一次探测失败：${info.lastProbeError}`)
        return lines.join('\n')
      },
    },
    {
      name: 'browser_e2e_recipe',
      access: 'interact',
      description: `一次按顺序执行 1-${RECIPE_MAX_STEPS} 个声明式步骤（${RECIPE_STEP_TYPES.join(' / ')}），`
        + '首个失败即停、已执行步骤不回滚，返回逐步结果与失败步号。'
        + '步骤是数据不是代码：不执行调用方提供的页面脚本——没有 evaluate 步骤，wait 步不接受 expression 条件；'
        + '需要页面脚本请单独用 browser_e2e_evaluate。每步字段与对应工具的顶层参数同名，由对应能力函数原样校验。'
        + `整次调用总预算 timeoutMs 默认 ${RECIPE_DEFAULT_TIMEOUT_MS}，允许 ${RECIPE_MIN_TIMEOUT_MS}-${RECIPE_MAX_TIMEOUT_MS}；`
        + '预算只在步骤之间检查，正在执行的 Playwright 动作无法中断。'
        + `wait 步的单步等待上限默认 ${RECIPE_WAIT_DEFAULT_TIMEOUT_MS}，允许 ${RECIPE_WAIT_MIN_TIMEOUT_MS}-${RECIPE_WAIT_MAX_TIMEOUT_MS}，`
        + '并按剩余总预算截断。'
        + `extract 只读主文档（不穿透 iframe 与 shadow DOM），links 模式取前 1-${RECIPE_EXTRACT_LIMIT_MAX} 条 a[href]`
        + `（默认 ${RECIPE_EXTRACT_LIMIT_DEFAULT}）；所有输出合计上限 ${RECIPE_OUTPUT_TEXT_LIMIT} 字符，超出会截断并标注。`,
      parameters: params({
        steps: {
          type: 'array',
          description: `按顺序执行的 1-${RECIPE_MAX_STEPS} 个声明式步骤；首个失败即停，已执行步骤不回滚`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: RECIPE_STEP_TYPES, description: '步骤类型' },
              url: { type: 'string', description: 'navigate：目标地址；wait（url 条件）：地址匹配模式' },
              waitUntil: { type: 'string', description: 'navigate 的等待条件：load | domcontentloaded | networkidle，默认 load' },
              selector: { type: 'string', description: 'wait / click / fill / hover 的 CSS 选择器；extract 的取值范围，缺省 body' },
              state: { type: 'string', description: 'wait（selector 条件）的等待状态：attached | visible | hidden | detached，默认 visible' },
              response: { type: 'string', description: 'wait（response 条件）的响应 URL 匹配模式' },
              urlMatch: { type: 'string', description: 'wait（url / response 条件）的匹配方式：includes | glob | regex，默认 includes' },
              expression: { type: 'string', description: '不支持：recipe 不执行调用方提供的页面脚本；需要页面内脚本条件请单独调用 browser_e2e_wait' },
              responseMethod: { type: 'string', description: 'wait（response 条件）的 HTTP 方法过滤' },
              statusMin: { type: 'integer', description: `wait（response 条件）的状态码下限，${WAIT_STATUS_MIN}-${WAIT_STATUS_MAX}，默认 ${WAIT_STATUS_MIN}` },
              statusMax: { type: 'integer', description: `wait（response 条件）的状态码上限，${WAIT_STATUS_MIN}-${WAIT_STATUS_MAX}，默认 ${WAIT_STATUS_MAX}` },
              includeBuffered: { type: 'boolean', description: 'wait（response 条件）是否回放已缓冲的响应，默认 true' },
              failOnRequestFailed: { type: 'boolean', description: 'wait（response 条件）匹配请求失败时是否立即报错，默认 true' },
              ref: { type: 'string', description: 'click / fill / hover 的元素引用，格式 @N；与 selector / x + y 三选一' },
              x: { type: 'number', description: 'click / fill / hover / scroll 的视口坐标 x（CSS 像素）' },
              y: { type: 'number', description: 'click / fill / hover / scroll 的视口坐标 y（CSS 像素）' },
              value: { type: 'string', description: 'fill 要填入的文本；空串表示清空' },
              mode: { type: 'string', description: 'fill：insert | keystrokes，默认 insert；extract：text | html | links | attribute，默认 text' },
              delayMs: { type: 'integer', description: `fill 的 mode=keystrokes 逐键延迟 0-${KEYSTROKE_MAX_DELAY_MS}，默认 0` },
              key: { type: 'string', description: 'press 的键盘按键名，如 Enter、Control+A' },
              settleMs: { type: 'integer', description: `hover 动作完成后的等待 0-${MAX_SETTLE_MS}，默认 ${DEFAULT_SETTLE_MS}` },
              delta_x: { type: 'number', description: 'scroll 的横向滚动量' },
              delta_y: { type: 'number', description: 'scroll 的纵向滚动量' },
              attribute: { type: 'string', description: 'extract（mode=attribute）要读取的属性名' },
              limit: { type: 'integer', description: `extract（mode=links）最多取多少条链接，1-${RECIPE_EXTRACT_LIMIT_MAX}，默认 ${RECIPE_EXTRACT_LIMIT_DEFAULT}` },
              timeoutMs: { type: 'integer', description: `仅 wait 步：该步等待上限 ${RECIPE_WAIT_MIN_TIMEOUT_MS}-${RECIPE_WAIT_MAX_TIMEOUT_MS}，默认 ${RECIPE_WAIT_DEFAULT_TIMEOUT_MS}` },
            },
            required: ['type'],
          },
        },
        tab_id: TAB_ID_PARAM,
        timeoutMs: { type: 'integer', description: `整次调用总预算，${RECIPE_MIN_TIMEOUT_MS}-${RECIPE_MAX_TIMEOUT_MS}，默认 ${RECIPE_DEFAULT_TIMEOUT_MS}` },
      }, ['steps']),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        return renderRecipeReport(await runRecipe(session, args))
      },
    },
    {
      name: 'browser_e2e_assert',
      access: 'observe',
      description: `一次判定当前页的 1-${ASSERT_MAX_CHECKS} 条断言，逐条给期望与实际证据。`
        + '每条 checks 项必须且只能给 selector / text / url / expression 之一：'
        + 'selector 配合 state（attached / visible / hidden / detached，默认 visible）；'
        + 'text 匹配页面可见文本子串（区分大小写）；url 配合 urlMatch（includes / glob / regex，默认 includes）匹配主框架地址；'
        + 'expression 是页面内同步表达式，真值即通过，不等待 Promise。'
        + '任一条未通过不抛错，返回 pass=false 与全部条目的证据（index / kind / expected / pass / actual）。'
        + '不等待、不重试、只作用于主文档；需要「等到满足」时先用 browser_e2e_wait。',
      parameters: params({
        checks: {
          type: 'array',
          description: `断言列表，1-${ASSERT_MAX_CHECKS} 条，按数组顺序执行且不短路；每条是一个对象`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              selector: { type: 'string', description: 'CSS 选择器；与 text / url / expression 互斥，配合 state' },
              text: { type: 'string', description: '页面可见文本（document.body.innerText）必须包含的子串，区分大小写；与其余三个条件互斥' },
              url: { type: 'string', description: '主框架地址匹配模式；与其余三个条件互斥，配合 urlMatch' },
              expression: { type: 'string', description: '页面内同步 JS 表达式，真值即通过；与其余三个条件互斥，不等待 Promise' },
              state: { type: 'string', description: 'selector 的期望状态：attached | visible | hidden | detached，默认 visible；只对 selector 有效' },
              urlMatch: { type: 'string', description: 'url 的匹配方式：includes | glob | regex，默认 includes；只对 url 有效' },
            },
          },
        },
        tab_id: TAB_ID_PARAM,
      }, ['checks']),
      async run(args, exec) {
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        return await assertPage(session, { checks: args.checks, tab_id: args.tab_id })
      },
      output: assertOutput(),
    },

    {
      name: 'browser_e2e_evaluate',
      access: 'script',
      description: '在页面上下文执行 JavaScript 并返回 JSON 结果。适合取计算样式、量尺寸、读 DOM 状态。'
        + '脚本必须是表达式；多行逻辑请用 IIFE 包装，例如 (() => ({ color: getComputedStyle(document.body).color }))()。'
        + `执行上限 timeoutMs（默认 ${DEFAULT_EVALUATE_TIMEOUT_MS}，允许 ${MIN_EVALUATE_TIMEOUT_MS}-${MAX_EVALUATE_TIMEOUT_MS}）`
        + '到点会中断页面内正在执行的脚本并报错，页面与标签页保持打开；等待永不返回的 Promise 不会被中断。',
      parameters: params({
        expression: { type: 'string', description: '要执行的 JavaScript 表达式' },
        tab_id: TAB_ID_PARAM,
        timeoutMs: {
          type: 'integer',
          description: `单次求值的执行上限（毫秒），${MIN_EVALUATE_TIMEOUT_MS}-${MAX_EVALUATE_TIMEOUT_MS}，默认 ${DEFAULT_EVALUATE_TIMEOUT_MS}；到点中断页内脚本并报错`,
        },
      }, ['expression']),
      async run(args, exec) {
        const expression = requireString(args, 'expression')
        const session = sessionOf(sessionKey(exec), exec?.agent?.id)
        const info = await evaluate(session, expression, args.tab_id, { timeoutMs: args.timeoutMs })
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
      name: 'browser_e2e_doctor',
      access: 'observe',
      description: '诊断浏览器环境（只读，不启动浏览器、不改任何状态）：一次给出六项检查 '
        + 'runtime / edge / cdp / session / paths / env，每项带 OK / WARN / FAIL / SKIP 与证据，'
        + '非 OK 项各带一行修法，末行按最严重项给结论。'
        + `默认按插件设置的模式诊断；检查 CDP 接管环境时传 mode: "cdp"（缺省 ${DOCTOR_PROBE_TIMEOUT_DEFAULT_MS}ms 端点探测超时）。`
        + 'browser_e2e_start 报错后先跑它，按 [FAIL] 项修好再重试。',
      parameters: params({
        mode: {
          type: 'string',
          enum: ['isolated', 'cdp'],
          description: '诊断哪种启动模式，缺省取插件设置的 defaultMode（未配置时 isolated）',
        },
        cdpEndpoint: {
          type: 'string',
          description: `CDP 模式要检查的 http 端点，默认 ${DEFAULT_CDP_ENDPOINT}；只允许 loopback。`
            + '非法端点只报 cdp 项 FAIL，不抛错',
        },
        probeTimeoutMs: {
          type: 'integer',
          description: `CDP 端点探测超时（毫秒），${DOCTOR_PROBE_TIMEOUT_MIN_MS}-${DOCTOR_PROBE_TIMEOUT_MAX_MS}，默认 ${DOCTOR_PROBE_TIMEOUT_DEFAULT_MS}`,
        },
      }),
      async run(args, exec) {
        return await diagnose({
          key: sessionKey(exec),
          mode: args.mode,
          cdpEndpoint: args.cdpEndpoint,
          probeTimeoutMs: args.probeTimeoutMs,
          defaults: launchDefaults(),
        })
      },
      output: textOutput(),
    },
    {
      name: HISTORY_TOOL_NAME,
      access: 'observe',
      description: '读取本机动作历史（宿主落盘、已脱敏）：每次 browser_e2e_* 工具调用结束后写入一条，'
        + '按时间倒序返回 #seq / 时间（UTC）/ 工具名 / 摘要。fill 与 dialog 的输入值在落盘前已替换为 [已脱敏 N 个字符]。'
        + `limit 默认 ${DEFAULT_HISTORY_LIMIT}（最多 ${MAX_HISTORY_LIMIT}）；scope=self（默认）只看本会话，scope=all 含其它会话。`
        + '本工具不需要浏览器已启动，读取动作也不会写入历史。',
      parameters: params({
        limit: {
          type: 'integer',
          description: `最多返回条数，1-${MAX_HISTORY_LIMIT}，默认 ${DEFAULT_HISTORY_LIMIT}`,
        },
        tool: { type: 'string', description: '只取某个工具的记录，如 browser_e2e_fill（精确匹配）' },
        ok: { type: 'boolean', description: 'true 只看成功，false 只看失败；缺省两者都要' },
        scope: { type: 'string', enum: ['self', 'all'], description: 'self（默认）只看本会话；all 含同机其它会话' },
      }),
      async run(args, exec) {
        return listActions({
          limit: args.limit,
          tool: typeof args.tool === 'string' && args.tool.trim() !== '' ? args.tool.trim() : undefined,
          ok: typeof args.ok === 'boolean' ? args.ok : undefined,
          session: sessionKey(exec),
          scope: args.scope === 'all' ? 'all' : 'self',
        }).text
      },
      output: textOutput(),
    },
    {
      name: 'browser_e2e_close',
      access: 'observe',
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
