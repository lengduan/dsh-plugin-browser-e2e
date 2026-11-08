/**
 * 快照引擎：DOM 快照的页内扫描脚本、ref 分配、delta / query / frame 分支，
 * 以及快照基线的比较与文本整形。
 *
 * 明确不含：标签页生命周期、事件环写入、交互动作、网络正文、协议、面板。
 * 标签页条目上的 refs / snapshotBaselines 字段由 page.js 的 addPage 创建并持有，
 * 本模块只读写既有字段，不新增跨模块字段；withTimeout 与 currentTab 从 page.js 单向借用。
 */
import { currentTab, withTimeout } from './page.js'

/** snapshot 单次最多返回的节点数（全 DOM 快照比只收可交互元素多得多，上限相应放大）。 */
export const SNAPSHOT_LIMIT = 4000

/** 快照页面脚本单次遍历的元素上限：超过后提前停止并置 scanTruncated。 */
const SNAPSHOT_SCAN_LIMIT = 20000

/** 快照页面脚本整体执行的宿主侧超时（页面脚本本身无法被终止）。 */
const SNAPSHOT_SCRIPT_TIMEOUT_MS = 15000

/** delta / query 模型可见文本的字符上限（全量保持既有行为，不套此上限）。 */
const SNAPSHOT_TEXT_LIMIT = 20000

/** delta 文本里 removed 列表最多逐条列出的条数，超出汇总。 */
const SNAPSHOT_REMOVED_LIMIT = 200

/** query 缺省返回条数。 */
export const SNAPSHOT_QUERY_LIMIT_DEFAULT = 20

/** query 允许的返回条数上限。 */
export const SNAPSHOT_QUERY_LIMIT_MAX = 100

/** query 页面内原始命中上限（去重前的候选数）。 */
const SNAPSHOT_QUERY_MAX_MATCHES = 200

/**
 * 页面内脚本：收集可见元素（full / delta）或按条件定位（query）。
 *
 * 注入到页面上下文执行，不引用外部变量。delta 的元素身份来自本脚本维护的注册表：
 * 同一文档内多次快照复用同一份 WeakMap，元素 key 稳定；epoch 用来判断页面是否被重置。
 * 不写 DOM 属性，Symbol 键不进 Object.keys，不污染页面选择器。
 * @param {{limit?: number, scanLimit?: number, maxMatches?: number, query?: object}} options - 快照选项
 * @returns {{epoch: string, nodes?: Array<object>, total?: number, scanTruncated?: boolean, matches?: Array<object>, scanned?: number}}
 */
function snapshotScript(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const cap = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 4000
  const scanLimit = Number.isInteger(opts.scanLimit) && opts.scanLimit > 0 ? opts.scanLimit : 20000
  const maxMatches = Number.isInteger(opts.maxMatches) && opts.maxMatches > 0 ? opts.maxMatches : 200
  const query = opts.query && typeof opts.query === 'object' ? opts.query : null
  const NAME_LIMIT = 80
  const TEXT_LIMIT = 120
  const CLASS_LIMIT = 8
  const QUERY_TEXT_LIMIT = 500
  /** 这些标签没有可见内容，直接跳过。 */
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title', 'base'])
  /** 纯布局容器不用后代文本作 name：否则每个祖先都会重复整页文本。 */
  const CONTAINER_TAGS = new Set([
    'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside',
    'nav', 'form', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr',
    'fieldset', 'details', 'dialog', 'figure',
  ])

  /** 元素身份注册表：只在本文件内使用，页面重置后 epoch 会变。 */
  const REGISTRY_KEY = Symbol.for('dsh.browser.e2e.snapshotRegistry')
  function registryOf() {
    const existing = window[REGISTRY_KEY]
    if (existing && existing.ids instanceof WeakMap && typeof existing.epoch === 'string') return existing
    const created = {
      epoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      ids: new WeakMap(),
      next: 0,
    }
    window[REGISTRY_KEY] = created
    return created
  }
  const registry = registryOf()

  function keyFor(el) {
    let key = registry.ids.get(el)
    if (key === undefined) {
      key = registry.next
      registry.next += 1
      registry.ids.set(el, key)
    }
    return key
  }

  /** tag 到 role 的简单映射；有 role 属性时优先用属性。 */
  const roleByTag = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  }

  function roleFor(el) {
    const explicit = (el.getAttribute('role') || '').trim()
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    return roleByTag[tag] ?? ''
  }

  /** 到 body 的层级：body 的直接子元素为 1。 */
  function depthFor(el) {
    let depth = 0
    let node = el
    while (node && node !== document.body && node.parentElement) {
      depth += 1
      node = node.parentElement
    }
    return depth
  }

  function typeIndex(el) {
    let idx = 1
    let sibling = el.previousElementSibling
    while (sibling) {
      if (sibling.tagName === el.tagName) idx += 1
      sibling = sibling.previousElementSibling
    }
    return idx
  }

  function xpathFor(el) {
    if (el.id && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(el.id)) {
      return `//*[@id="${el.id}"]`
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase()
      parts.unshift(`${tag}[${typeIndex(node)}]`)
      node = node.parentElement
    }
    return '/' + parts.join('/')
  }

  /** query 结果里可直接传给 click / fill 的 CSS 选择器：id 优先，否则从 body 起的 tag:nth-of-type 链。 */
  function selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.body) {
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${typeIndex(node)})`)
      node = node.parentElement
    }
    if (node === document.body) parts.unshift('body')
    return parts.join(' > ')
  }

  function visibleEnough(el, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
      } catch {
        // 参数不被旧内核支持时退回样式判断
      }
    }
    const style = window.getComputedStyle(el)
    if (!style) return true
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  }

  /** 元素文本：压成一行并截断（textContent 会包含隐藏后代文本，这里只做展示用）。 */
  function textOf(el) {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text
  }

  /** 可读名称：aria-label / aria-labelledby 优先，其次表单标签与文本。 */
  function nameFor(el, text) {
    const labelled = (el.getAttribute('aria-label') || '').trim()
    if (labelled) return labelled.slice(0, NAME_LIMIT)
    const by = (el.getAttribute('aria-labelledby') || '').trim()
    if (by) {
      const parts = []
      for (const id of by.split(/\s+/)) {
        const target = id ? document.getElementById(id) : null
        if (target) {
          const part = (target.textContent || '').replace(/\s+/g, ' ').trim()
          if (part) parts.push(part)
        }
      }
      if (parts.length > 0) return parts.join(' ').slice(0, NAME_LIMIT)
    }
    const tagName = el.tagName
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tagName)) {
      const placeholder = (el.getAttribute('placeholder') || '').trim()
      if (placeholder) return placeholder.slice(0, NAME_LIMIT)
      if (el.id) {
        // id 可能含引号等选择器元字符，必须转义，否则 querySelector 抛 SyntaxError 让整次 snapshot 失败。
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (label) {
          const linked = (label.textContent || '').replace(/\s+/g, ' ').trim()
          if (linked) return linked.slice(0, NAME_LIMIT)
        }
      }
      const wrapped = el.closest('label')
      if (wrapped) {
        const linked = (wrapped.textContent || '').replace(/\s+/g, ' ').trim()
        if (linked) return linked.slice(0, NAME_LIMIT)
      }
      const fallback = el.value || el.getAttribute('name') || ''
      if (fallback) return String(fallback).slice(0, NAME_LIMIT)
    }
    if (text && (!CONTAINER_TAGS.has(el.tagName.toLowerCase()) || el.hasAttribute('role'))) {
      return text.slice(0, NAME_LIMIT)
    }
    const alt = (el.getAttribute('alt') || '').trim()
    if (alt) return alt.slice(0, NAME_LIMIT)
    return ''
  }

  /** 视口相对 CSS 像素；四值取整，便于按坐标点击时直接使用。 */
  function boxFor(rect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }

  /** 语义元素：可聚焦 / 可编辑 / 带 role / 带 tabindex / 带 href。 */
  function semanticElement(el) {
    const tag = el.tagName.toLowerCase()
    if (el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('href')) return true
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'a') return true
    if (el.isContentEditable) return true
    return typeof el.tabIndex === 'number' && el.tabIndex >= 0
  }

  function queryMatches(queryOpt) {
    const needle = typeof queryOpt.text === 'string' ? queryOpt.text.toLowerCase() : ''
    const roleNeedle = typeof queryOpt.role === 'string' ? queryOpt.role.toLowerCase() : ''
    const includeHidden = queryOpt.includeHidden === true
    let scanned = 0
    let scanTruncated = false
    let candidates
    if (typeof queryOpt.selector === 'string' && queryOpt.selector.length > 0) {
      try {
        candidates = Array.from(document.querySelectorAll(queryOpt.selector))
      } catch {
        return { invalidSelector: true, matches: [], scanned: 0, scanTruncated: false }
      }
      scanned = candidates.length
    } else {
      candidates = []
      const all = document.body ? document.body.querySelectorAll('*') : []
      for (const el of all) {
        const tag = el.tagName.toLowerCase()
        if (SKIP_TAGS.has(tag)) continue
        if (scanned >= scanLimit) {
          scanTruncated = true
          break
        }
        scanned += 1
        candidates.push(el)
      }
    }

    const hits = []
    for (const el of candidates) {
      if (roleNeedle && roleFor(el).toLowerCase() !== roleNeedle) continue
      if (needle) {
        const text = textOf(el)
        const name = nameFor(el, text)
        const bodyText = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, QUERY_TEXT_LIMIT)
        if (!name.toLowerCase().includes(needle) && !bodyText.toLowerCase().includes(needle)) continue
      }
      const rect = el.getBoundingClientRect()
      const visible = visibleEnough(el, rect)
      if (!visible && !includeHidden) continue
      hits.push({ el, rect, visible, index: hits.length })
      if (hits.length >= maxMatches) break
    }

    // 嵌套命中只保留最内层语义元素；容器祖先与文本后代丢弃。
    const dropped = new Set()
    for (const hit of hits) {
      const isSemantic = semanticElement(hit.el)
      for (const other of hits) {
        if (other.el === hit.el || dropped.has(other.el)) continue
        if (hit.el.contains(other.el) && semanticElement(other.el)) {
          dropped.add(hit.el)
          break
        }
      }
      if (dropped.has(hit.el)) continue
      if (!isSemantic) {
        for (const other of hits) {
          if (other.el !== hit.el && !dropped.has(other.el) && other.el.contains(hit.el) && semanticElement(other.el)) {
            dropped.add(hit.el)
            break
          }
        }
      }
      if (dropped.has(hit.el)) continue
      if (!isSemantic) {
        for (const other of hits) {
          if (other.el !== hit.el && !dropped.has(other.el) && hit.el.contains(other.el)) {
            dropped.add(hit.el)
            break
          }
        }
      }
    }

    // 可见元素优先，其余保持文档顺序。
    const ordered = hits
      .slice()
      .sort((a, b) => (a.visible === b.visible ? a.index - b.index : (a.visible ? -1 : 1)))
    const matches = []
    for (const hit of ordered) {
      if (dropped.has(hit.el)) continue
      const text = textOf(hit.el)
      const match = {
        key: keyFor(hit.el),
        tag: hit.el.tagName.toLowerCase(),
        id: hit.el.id || '',
        classes: hit.el.classList ? Array.from(hit.el.classList).slice(0, CLASS_LIMIT) : [],
        role: roleFor(hit.el),
        name: nameFor(hit.el, text),
        text,
        box: boxFor(hit.rect),
        xpath: xpathFor(hit.el),
        selector: selectorFor(hit.el),
      }
      if (includeHidden && !hit.visible) match.hidden = true
      matches.push(match)
    }
    return { matches, scanned, scanTruncated }
  }

  if (query) {
    const found = queryMatches(query)
    return {
      epoch: registry.epoch,
      query: true,
      invalidSelector: found.invalidSelector === true,
      matches: found.matches,
      scanned: found.scanned,
      scanTruncated: found.scanTruncated === true,
    }
  }

  const nodes = []
  let total = 0
  let scanTruncated = false
  const all = document.body ? document.body.querySelectorAll('*') : []
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i]
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    const rect = el.getBoundingClientRect()
    if (!visibleEnough(el, rect)) continue
    if (total >= scanLimit) {
      scanTruncated = i < all.length - 1
      break
    }
    total += 1
    if (nodes.length >= cap) continue
    const text = textOf(el)
    const classes = el.classList ? Array.from(el.classList).slice(0, CLASS_LIMIT) : []
    nodes.push({
      key: keyFor(el),
      tag,
      id: el.id || '',
      classes,
      role: roleFor(el),
      name: nameFor(el, text),
      text,
      box: boxFor(rect),
      depth: depthFor(el),
      xpath: xpathFor(el),
    })
  }
  return { epoch: registry.epoch, nodes, total, scanTruncated }
}

/** 摘要字段：delta 只比较这 6 个，不含 box / depth / xpath（位置移动与兄弟增删不算变化）。 */
function fieldsOf(node) {
  return {
    tag: node.tag,
    id: node.id,
    classes: Array.isArray(node.classes) ? node.classes.join('.') : '',
    role: node.role,
    name: node.name,
    text: node.text,
  }
}

function digestOf(fields) {
  return JSON.stringify(fields)
}

function changedFieldsOf(prev, next) {
  return ['tag', 'id', 'classes', 'role', 'name', 'text'].filter((key) => prev[key] !== next[key])
}

/** 复制节点并去掉页面侧内部 key（不进入模型可见输出）。 */
function stripKey(node) {
  const { key: _key, ...rest } = node
  return rest
}

function baselineEntryOf(node, ref) {
  const fields = fieldsOf(node)
  return {
    digest: digestOf(fields),
    fields,
    xpath: node.xpath,
    ref,
    tag: node.tag,
    name: node.name,
  }
}


/** 主文档固定索引 0，其余按 page.frames() 顺序过滤主文档后从 1 编号。 */
function frameListOf(page) {
  const main = page.mainFrame()
  return [main, ...page.frames().filter((frame) => frame !== main)]
}

function describeFrames(frames) {
  return frames.map((frame, index) => (index === 0
    ? '0（主文档）'
    : `${index}（"${frame.name()}"，${frame.url()}）`)).join('、')
}

function frameInfoOf(frames, frame, index) {
  if (index === 0) return { index: 0, name: frame.name(), url: frame.url(), parentIndex: null }
  const parent = frame.parentFrame()
  const parentIndex = parent ? frames.indexOf(parent) : -1
  return {
    index,
    name: frame.name(),
    url: frame.url(),
    parentIndex: parentIndex >= 0 ? parentIndex : null,
  }
}

/**
 * 解析 frame 参数：整数为索引（0 主文档），字符串先按 name 精确匹配、再按 url 子串匹配。
 * 每次调用重新取 frame 列表，索引只对本次调用有效。
 */
function resolveSnapshotFrame(page, frameArg) {
  const frames = frameListOf(page)
  let index = 0
  if (frameArg !== undefined && frameArg !== null) {
    if (typeof frameArg === 'number') {
      if (!Number.isInteger(frameArg) || frameArg < 0) {
        throw new Error(`frame 必须是 0 或正整数（0 为主文档），收到 ${frameArg}`)
      }
      index = frameArg
    } else if (typeof frameArg === 'string') {
      const value = frameArg
      const candidates = frames.map((frame, idx) => ({ frame, idx })).filter(({ frame, idx }) => idx > 0)
      if (value.length === 0) throw new Error(`frame 未找到：当前页可用索引 ${describeFrames(frames)}`)
      const byName = candidates.filter(({ frame }) => frame.name() !== '' && frame.name() === value)
      let matched = byName
      if (matched.length === 0) {
        matched = candidates.filter(({ frame }) => frame.url().includes(value))
      }
      if (matched.length === 1) {
        index = matched[0].idx
      } else if (matched.length > 1) {
        throw new Error(`frame "${value}" 命中 ${matched.length} 个（索引 ${matched.map(({ idx }) => idx).join('、')}），请改用 frame 索引`)
      } else {
        throw new Error(`frame "${value}" 未找到：当前页可用索引 ${describeFrames(frames)}`)
      }
    } else {
      throw new Error(`frame 必须是 0 或正整数（0 为主文档），收到 ${String(frameArg)}`)
    }
  }
  if (index >= frames.length) {
    throw new Error(`frame 索引 ${index} 不存在：当前页共 ${frames.length} 个 frame（${describeFrames(frames)}），请重新 browser_e2e_snapshot 查看`)
  }
  return { frame: frames[index], index, info: frameInfoOf(frames, frames[index], index) }
}

/** 只读同源 frame：空 url / about:blank / about:srcdoc 视为同源。 */
function assertSameOriginFrame(page, frame, index) {
  const frameUrl = frame.url()
  if (!frameUrl || frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') return
  let frameOrigin
  try {
    frameOrigin = new URL(frameUrl).origin
  } catch {
    return
  }
  let pageOrigin
  try {
    pageOrigin = new URL(page.url()).origin
  } catch {
    pageOrigin = null
  }
  if (frameOrigin !== pageOrigin) {
    throw new Error(`frame（索引 ${index}，${frameUrl}）跨源：P0-3 只读取同源 iframe，跨源 iframe 的定位与操作待 P1-9`)
  }
}

function snapshotTimeoutMessage() {
  return `快照执行超时（${SNAPSHOT_SCRIPT_TIMEOUT_MS}ms）：页面脚本未返回，可能被同步脚本或死循环占用；可稍后重试或改用 browser_e2e_evaluate 小范围读取`
}

async function readSnapshotRaw(frame, options, index) {
  const detachedMessage = `frame（索引 ${index}）已不可用（已导航或卸载），请重新 browser_e2e_snapshot`
  if (typeof frame.isDetached === 'function' && frame.isDetached()) throw new Error(detachedMessage)
  const arg = {
    limit: SNAPSHOT_LIMIT,
    scanLimit: SNAPSHOT_SCAN_LIMIT,
    maxMatches: SNAPSHOT_QUERY_MAX_MATCHES,
    query: options.query ?? null,
  }
  try {
    return await withTimeout(frame.evaluate(snapshotScript, arg), SNAPSHOT_SCRIPT_TIMEOUT_MS, snapshotTimeoutMessage())
  } catch (error) {
    if (error?.code === 'SNAPSHOT_TIMEOUT') throw error
    if (index === 0) throw error
    if ((typeof frame.isDetached === 'function' && frame.isDetached())
      || /detached|Target closed|Execution context was destroyed/i.test(String(error?.message))) {
      throw new Error(detachedMessage)
    }
    throw new Error(`frame（索引 ${index}）读取失败：${error?.message ?? error}`)
  }
}

function normalizeQuery(query) {
  const text = query.text
  const selector = query.selector
  const role = query.role
  for (const [key, value] of Object.entries({ text, selector, role })) {
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error(`query.${key} 必须是非空字符串`)
    }
  }
  if (!text && !selector && !role) throw new Error('query 至少需要 text / selector / role 之一')
  if (text && selector) throw new Error('query.text 与 query.selector 互斥，只能给一个')
  let limit = SNAPSHOT_QUERY_LIMIT_DEFAULT
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > SNAPSHOT_QUERY_LIMIT_MAX) {
      throw new Error(`query.limit 必须是 1-100 的整数，收到 ${query.limit}`)
    }
    limit = query.limit
  }
  return { text, selector, role, limit, includeHidden: query.includeHidden === true }
}

function normalizeSnapshotOptions(options) {
  const raw = options && typeof options === 'object' ? options : {}
  let query
  if (raw.query !== undefined) {
    if (raw.query === null || typeof raw.query !== 'object' || Array.isArray(raw.query)) {
      throw new Error('query 必须是对象，可含 text / selector / role / limit / includeHidden')
    }
    query = normalizeQuery(raw.query)
  }
  const delta = raw.delta === true
  if (delta && query) {
    throw new Error('query 与 delta 不能同时使用：query 是定位查询（不写快照基线），delta 需要与上一次快照对比；请分两次调用')
  }
  return { delta, query, frame: raw.frame }
}

/** delta / query 文本上限：超出截断并追加提示（全量不套，保持既有行为）。 */
function clipSnapshotText(text) {
  const value = String(text ?? '')
  if (value.length <= SNAPSHOT_TEXT_LIMIT) return value
  return `${value.slice(0, SNAPSHOT_TEXT_LIMIT)}…（已截断：文本上限 ${SNAPSHOT_TEXT_LIMIT} 字符）`
}

function formatNodeLine(item, withRef) {
  const idText = item.id ? `#${item.id}` : ''
  const classText = item.classes.length > 0 ? `.${item.classes.join('.')}` : ''
  const indent = '  '.repeat(item.depth)
  const refText = withRef ? `[${item.ref.replace('@', '')}] ` : ''
  return `${indent}${refText}${item.tag}${idText}${classText} "${item.name}"`
    + ` box(${item.box.x},${item.box.y},${item.box.width},${item.box.height})`
}

function fullScanNotice(total) {
  return `（扫描上限 ${SNAPSHOT_SCAN_LIMIT} 个元素，已提前停止：total=${total} 是已扫描到的可见元素数）`
}

/** 全量快照：主文档重建 ref 表；子 frame 只读并写该 frame 的基线。 */
function runFullSnapshot(tab, frame, index, raw, base) {
  const main = index === 0
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, SNAPSHOT_LIMIT) : []
  const items = rawNodes.map((node, idx) => ({ ...stripKey(node), ref: main ? `@${idx}` : null }))
  if (main) {
    tab.refs.clear()
    for (const item of items) tab.refs.set(item.ref, item)
  }
  const previous = tab.snapshotBaselines.get(frame)
  const bucket = {
    epoch: raw.epoch,
    version: (previous?.version ?? 0) + 1,
    nextRef: main ? items.length : 0,
    keys: new Map(),
  }
  rawNodes.forEach((node, idx) => bucket.keys.set(node.key, baselineEntryOf(node, items[idx].ref)))
  tab.snapshotBaselines.set(frame, bucket)

  const total = Number.isInteger(raw.total) ? raw.total : items.length
  const truncated = total > SNAPSHOT_LIMIT
  const lines = items.map((item) => formatNodeLine(item, main))
  let text = lines.length > 0 ? lines.join('\n') : '（未发现可见元素）'
  if (truncated) {
    text += `\n\n（已截断：共 ${total} 个可见元素，只返回前 ${SNAPSHOT_LIMIT} 个）`
  }
  if (base.scanTruncated) text += `\n\n${fullScanNotice(total)}`
  if (!main) text += '\n\n（子 frame 只读：不分配 ref，元素操作待 P1-9）'
  return {
    ...base,
    count: items.length,
    total,
    truncated,
    nodes: items,
    text,
    summary: `快照 ${items.length} 个可见元素${truncated ? `（共 ${total} 个，已截断到 ${SNAPSHOT_LIMIT} 个）` : ''}`,
  }
}

function formatDeltaNodeLine(marker, item) {
  const idText = item.id ? `#${item.id}` : ''
  const classText = item.classes.length > 0 ? `.${item.classes.join('.')}` : ''
  const refText = item.ref ? item.ref.replace('@', '') : '-'
  const fieldsText = item.changedFields && item.changedFields.length > 0 ? `（${item.changedFields.join('、')}）` : ''
  return `  ${marker} [${refText}] ${item.tag}${idText}${classText} "${item.name}"`
    + ` box(${item.box.x},${item.box.y},${item.box.width},${item.box.height})${fieldsText}`
}

/** delta：按稳定 key 与基线对比；主文档增量并入 ref 表，子 frame 只更新该 frame 的基线。 */
function runDeltaSnapshot(tab, frame, index, raw, base) {
  const main = index === 0
  const existing = tab.snapshotBaselines.get(frame)
  const status = !existing
    ? 'missing'
    : (existing.invalidated === true || existing.epoch !== raw.epoch ? 'reset' : 'ok')
  if (status !== 'ok') {
    const full = runFullSnapshot(tab, frame, index, raw, base)
    return {
      ...full,
      baseline: status,
      version: tab.snapshotBaselines.get(frame)?.version ?? 1,
      added: [],
      changed: [],
      removed: [],
      addedCount: 0,
      changedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      text: `无增量基线（首次快照或页面已更换），已返回全量\n\n${full.text}`,
    }
  }

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, SNAPSHOT_LIMIT) : []
  const currentKeys = new Set(rawNodes.map((node) => node.key))
  const added = []
  const changed = []
  let unchangedCount = 0
  let nextRef = Number.isInteger(existing.nextRef) ? existing.nextRef : 0
  const nextKeys = new Map()
  for (const node of rawNodes) {
    const previous = existing.keys.get(node.key)
    const fields = fieldsOf(node)
    const digest = digestOf(fields)
    const stripped = stripKey(node)
    if (!previous) {
      const ref = main ? `@${nextRef}` : null
      if (main) nextRef += 1
      const item = { ...stripped, ref }
      added.push(item)
      if (main) tab.refs.set(item.ref, item)
      nextKeys.set(node.key, baselineEntryOf(node, ref))
    } else if (previous.digest !== digest) {
      const ref = previous.ref ?? null
      changed.push({ ...stripped, ref, changedFields: changedFieldsOf(previous.fields, fields) })
      if (main && ref) tab.refs.set(ref, { ...stripped, ref })
      nextKeys.set(node.key, baselineEntryOf(node, ref))
    } else {
      unchangedCount += 1
      const ref = previous.ref ?? null
      if (main && ref) tab.refs.set(ref, { ...stripped, ref })
      nextKeys.set(node.key, baselineEntryOf(node, ref))
    }
  }
  const removed = []
  for (const [key, previous] of existing.keys) {
    if (currentKeys.has(key)) continue
    removed.push({
      ref: main ? (previous.ref ?? null) : null,
      tag: previous.tag,
      name: previous.name,
      xpath: previous.xpath,
    })
    if (main && previous.ref) tab.refs.delete(previous.ref)
  }

  const version = (existing.version ?? 0) + 1
  tab.snapshotBaselines.set(frame, {
    epoch: raw.epoch,
    version,
    nextRef: main ? nextRef : 0,
    keys: nextKeys,
  })

  const total = Number.isInteger(raw.total) ? raw.total : rawNodes.length
  const changesCount = added.length + changed.length + removed.length
  const truncated = raw.scanTruncated === true || total > SNAPSHOT_LIMIT || changesCount > SNAPSHOT_LIMIT
  const lines = [`增量 v${version}（标签页 ${base.tabId}，frame ${index}）`]
  if (changesCount === 0) {
    lines.push('（无可见变化）')
  } else {
    if (added.length > 0) {
      lines.push(`新增 ${added.length} 个：`)
      for (const item of added) lines.push(formatDeltaNodeLine('+', item))
    }
    if (changed.length > 0) {
      lines.push(`变化 ${changed.length} 个：`)
      for (const item of changed) lines.push(formatDeltaNodeLine('~', item))
    }
    if (removed.length > 0) {
      lines.push(`移除 ${removed.length} 个：`)
      for (const item of removed.slice(0, SNAPSHOT_REMOVED_LIMIT)) {
        lines.push(`  - ${item.ref ?? '-'} ${item.tag} "${item.name}"`)
      }
      if (removed.length > SNAPSHOT_REMOVED_LIMIT) {
        lines.push(`  …等 ${removed.length - SNAPSHOT_REMOVED_LIMIT} 个`)
      }
    }
  }
  if (truncated) {
    if (total > SNAPSHOT_LIMIT) lines.push(`（本次只对比前 ${SNAPSHOT_LIMIT} 个可见节点）`)
    if (changesCount > SNAPSHOT_LIMIT) lines.push(`（变化节点超过 ${SNAPSHOT_LIMIT} 个）`)
    if (raw.scanTruncated === true) lines.push(fullScanNotice(total))
  }
  return {
    ...base,
    baseline: 'ok',
    version,
    added,
    changed,
    removed,
    addedCount: added.length,
    changedCount: changed.length,
    removedCount: removed.length,
    unchangedCount,
    total,
    truncated,
    text: clipSnapshotText(lines.join('\n')),
    summary: `增量：新增 ${added.length} / 变化 ${changed.length} / 移除 ${removed.length}（标签页 ${base.tabId}）`,
  }
}

function findRefByXpath(tab, xpath) {
  for (const [ref, item] of tab.refs) {
    if (item.xpath === xpath) return ref
  }
  return null
}

function describeQuery(query) {
  const parts = []
  if (query.text) parts.push(`text "${query.text}"`)
  else if (query.selector) parts.push(`selector "${query.selector}"`)
  if (query.role) parts.push(`role "${query.role}"`)
  return parts.join('，')
}

function formatQueryLine(item) {
  const idText = item.id ? `#${item.id}` : ''
  const classText = item.classes.length > 0 ? `.${item.classes.join('.')}` : ''
  const refText = item.ref ? item.ref.replace('@', '') : '-'
  const hiddenText = item.hidden === true ? 'hidden' : 'visible'
  return `  [${refText}] ${item.tag}${idText}${classText} "${item.name}"`
    + ` · selector=${item.selector} · ${hiddenText}`
}

/** query：定位元素并给出可直接使用的 selector；不读写 ref 表与 delta 基线。 */
function runQuery(tab, index, raw, base, query) {
  const matches = (Array.isArray(raw.matches) ? raw.matches : []).map((match) => {
    const item = {
      ref: index === 0 ? findRefByXpath(tab, match.xpath) : null,
      tag: match.tag,
      id: match.id,
      classes: match.classes,
      role: match.role,
      name: match.name,
      text: match.text,
      box: match.box,
      xpath: match.xpath,
      selector: match.selector,
    }
    if (match.hidden === true) item.hidden = true
    return item
  })
  const totalMatched = matches.length
  const count = Math.min(query.limit, totalMatched)
  const shown = matches.slice(0, count)
  const truncated = totalMatched > count
  const desc = describeQuery(query)
  let text
  if (shown.length === 0) {
    text = `未命中 ${desc} 的元素（已扫描 ${raw.scanned ?? 0} 个）；可放宽 includeHidden、改用 selector 或去掉 role 限制`
  } else {
    const lines = [`查询命中 ${count} 个元素（${desc}）`]
    for (const item of shown) lines.push(formatQueryLine(item))
    if (truncated) lines.push(`（共 ${totalMatched} 个命中，只列出前 ${count} 个）`)
    text = lines.join('\n')
  }
  return {
    ...base,
    count,
    totalMatched,
    matches: shown,
    truncated,
    text: clipSnapshotText(text),
    summary: `查询命中 ${count} 个元素`,
  }
}

/**
 * 快照：缺省全量；`delta: true` 只返回自上次快照以来的变化；`query` 定位元素；`frame` 读取同源 iframe。
 *
 * ref 语义：全量在主文档重建 ref 表（旧 ref 全部失效）；delta 按稳定 key 增量并入，仍在的元素
 * 继续可用旧 ref；子 frame 只读，不分配 ref、不写 ref 表。
 * @param {object} session - 会话状态
 * @param {string} [tabId] - 标签页 id
 * @param {{delta?: boolean, query?: object, frame?: number|string}} [options] - 快照选项
 * @returns {Promise<object>} 快照结果
 */
export async function snapshot(session, tabId, options = {}) {
  const tab = currentTab(session, tabId)
  const page = tab.page
  const opts = normalizeSnapshotOptions(options)
  const { frame, index, info } = resolveSnapshotFrame(page, opts.frame)
  if (index > 0) assertSameOriginFrame(page, frame, index)
  const raw = await readSnapshotRaw(frame, opts, index)
  if (raw?.invalidSelector === true) {
    throw new Error(`query.selector 不是合法 CSS 选择器：${opts.query.selector}`)
  }
  const base = {
    tabId: tab.id,
    url: page.url(),
    mode: opts.query ? 'query' : (opts.delta ? 'delta' : 'full'),
    frame: info,
    scanTruncated: raw?.scanTruncated === true,
  }
  if (opts.query) return runQuery(tab, index, raw, base, opts.query)
  if (opts.delta) return runDeltaSnapshot(tab, frame, index, raw, base)
  return runFullSnapshot(tab, frame, index, raw, base)
}
