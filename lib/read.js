/**
 * 结构化页面读取：controls / links / tables / forms 四节记录 + 页内校验过的唯一 CSS selector。
 *
 * 依赖方向：tools.js → read.js → page.js（只取 currentTab）。不写 ref 表、不建快照基线、
 * 不改协议与面板；页内扫描引擎是本文件的私有 readScript，所有上限经 options 传入，
 * 避免脚本序列化后引用模块作用域。
 */
import { currentTab } from './page.js'

/** 四节的固定输出顺序；请求顺序与重复值不影响结果。 */
export const READ_SECTIONS = ['controls', 'links', 'tables', 'forms']
/** 缺省只读三节（表单按需请求）。 */
export const READ_DEFAULT_SECTIONS = ['controls', 'links', 'tables']
/** 每节最多列出的条目数缺省值。 */
export const READ_DEFAULT_ITEMS = 50
/** 每节最多列出的条目数上限。 */
export const READ_MAX_ITEMS = 100
/** 页内扫描的元素上限，到上限即停止并标记 scanTruncated。 */
export const READ_SCAN_LIMIT = 20000
/** 模型可见 text 的字符预算（摘要与提示行不计入）。 */
export const READ_TEXT_LIMIT = 16000

const SECTION_LABELS = {
  controls: '控件',
  links: '链接',
  tables: '表格',
  forms: '表单',
}

/** sections 入参归一：去重、按固定顺序输出、空数组与未知值报错。 */
function normalizeSections(value) {
  if (value === undefined) return [...READ_DEFAULT_SECTIONS]
  if (!Array.isArray(value)) {
    throw new Error(`sections 需要 controls / links / tables / forms 的数组，收到 ${JSON.stringify(value)}`)
  }
  if (value.length === 0) {
    throw new Error('sections 至少要给一个：controls / links / tables / forms')
  }
  const wanted = new Set()
  for (const section of value) {
    if (!READ_SECTIONS.includes(section)) {
      throw new Error(`未知 section ${JSON.stringify(section)}；可选 controls / links / tables / forms`)
    }
    wanted.add(section)
  }
  return READ_SECTIONS.filter((section) => wanted.has(section))
}

/** maxItems 入参归一：整数 1..100，缺省 50。 */
function normalizeMaxItems(value) {
  if (value === undefined) return READ_DEFAULT_ITEMS
  if (!Number.isInteger(value) || value < 1 || value > READ_MAX_ITEMS) {
    throw new Error(`maxItems 必须是 1..${READ_MAX_ITEMS} 的整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/** selector 入参归一：空串按未给处理（与 ref / selector 约定一致）。 */
function normalizeSelector(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new Error(`selector 需要字符串，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 页内扫描脚本：由 Playwright 序列化到页面执行，不能引用模块作用域变量。
 * 返回 { counts, scanTruncated, <section>? } 或 { error: 'invalid-selector' | 'no-match', message? }。
 */
function readScript(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const sections = Array.isArray(opts.sections) ? opts.sections : []
  const maxItems = Number.isInteger(opts.maxItems) && opts.maxItems > 0 ? opts.maxItems : 50
  const includeValues = opts.includeValues === true
  const selector = typeof opts.selector === 'string' ? opts.selector : ''
  const scanLimit = Number.isInteger(opts.scanLimit) && opts.scanLimit > 0 ? opts.scanLimit : 20000

  const NAME_LIMIT = 200
  const TEXT_LIMIT = 200
  const VALUE_LIMIT = 500
  const HREF_LIMIT = 500
  const CELL_LIMIT = 120
  const OPTIONS_LIMIT = 100
  const SELECTOR_LIMIT = 500

  const WIDGET_ROLES = new Set([
    'button', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox',
    'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option',
  ])
  const TABLE_ROLES = new Set(['table', 'grid', 'treegrid'])

  /** 超长字符串按字符截断并追加省略号。 */
  function truncate(value, limit) {
    const text = value === null || value === undefined ? '' : String(value)
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }

  /** 空白折叠成一行。 */
  function foldSpaces(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim()
  }

  function textOf(el, limit) {
    return truncate(foldSpaces(el.textContent || ''), limit)
  }

  function tagOf(el) {
    return el.tagName.toLowerCase()
  }

  /** 显式 role 只取第一个（ARIA 允许多值回退列表）。 */
  function explicitRole(el) {
    const raw = (el.getAttribute('role') || '').trim()
    if (!raw) return ''
    return raw.split(/\s+/)[0]
  }

  function isContentEditable(el) {
    if (!el.hasAttribute('contenteditable')) return false
    const value = (el.getAttribute('contenteditable') || '').trim().toLowerCase()
    return value !== 'false'
  }

  /** 与 snapshotScript 的 visibleEnough 同判据。 */
  function visibleEnough(el) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
      } catch {
        // 旧内核不支持参数时退回样式判断
      }
    }
    const style = window.getComputedStyle(el)
    if (!style) return true
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  }

  function escapeAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function typeIndex(node) {
    let index = 1
    let sibling = node.previousElementSibling
    while (sibling) {
      if (sibling.tagName === node.tagName) index += 1
      sibling = sibling.previousElementSibling
    }
    return index
  }

  function countMatches(candidate) {
    try {
      return document.querySelectorAll(candidate).length
    } catch {
      return 0
    }
  }

  /**
   * 唯一 selector：id → data-testid → 表单控件 name → 链接 href → html 起的 nth-of-type 链。
   * 每个候选立即在整文档校验（返回的 selector 要交给没有作用域上下文的 click / fill）。
   */
  function selectorFor(el) {
    const tag = tagOf(el)
    const candidates = []
    if (el.id) candidates.push(`#${CSS.escape(el.id)}`)
    const testId = el.getAttribute('data-testid')
    if (testId) candidates.push(`${tag}[data-testid="${escapeAttr(testId)}"]`)
    const name = el.getAttribute('name')
    if (name && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button')) {
      let candidate = `${tag}[name="${escapeAttr(name)}"]`
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        candidate += `[type="${escapeAttr(type)}"]`
        if (type === 'radio' || type === 'checkbox') {
          candidate += `[value="${escapeAttr(el.getAttribute('value') || '')}"]`
        }
      }
      candidates.push(candidate)
    }
    if (tag === 'a' || tag === 'area') {
      const href = el.getAttribute('href')
      if (href) candidates.push(`${tag}[href="${escapeAttr(href)}"]`)
    }
    for (const candidate of candidates) {
      if (countMatches(candidate) === 1) return { selector: candidate, unique: true }
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1) {
      parts.unshift(`${tagOf(node)}:nth-of-type(${typeIndex(node)})`)
      if (node === document.documentElement) break
      node = node.parentElement
    }
    const full = parts.join(' > ')
    const matches = countMatches(full)
    if (matches === 1) return { selector: full, unique: true }
    return { selector: full, unique: false, matches }
  }

  /** selector 字段整形：超过 500 字符时省略（不返回半截选择器）。 */
  function selectorFields(el) {
    const found = selectorFor(el)
    if (found.selector.length > SELECTOR_LIMIT) {
      return { unique: false, matches: found.matches ?? 1 }
    }
    return found
  }

  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').trim()
    if (!ids) return ''
    const parts = []
    for (const id of ids.split(/\s+/)) {
      const target = document.getElementById(id)
      if (target) {
        const text = foldSpaces(target.textContent || '')
        if (text) parts.push(text)
      }
    }
    return parts.join(' ')
  }

  function labelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${escapeAttr(el.id)}"]`)
      if (label) return foldSpaces(label.textContent || '')
    }
    const ancestor = typeof el.closest === 'function' ? el.closest('label') : null
    return ancestor ? foldSpaces(ancestor.textContent || '') : ''
  }

  /** 可读名称：aria-labelledby → aria-label → label → placeholder → 自身文本 → title → alt。 */
  function nameOf(el, tag, text) {
    const labelled = labelledByText(el)
    if (labelled) return truncate(labelled, NAME_LIMIT)
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel && ariaLabel.trim()) return truncate(foldSpaces(ariaLabel), NAME_LIMIT)
    const label = labelText(el)
    if (label) return truncate(label, NAME_LIMIT)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder && placeholder.trim()) return truncate(foldSpaces(placeholder), NAME_LIMIT)
    if (tag === 'button' || explicitRole(el) === 'option') {
      if (text) return truncate(text, NAME_LIMIT)
    }
    const title = el.getAttribute('title')
    if (title && title.trim()) return truncate(foldSpaces(title), NAME_LIMIT)
    const alt = el.getAttribute('alt')
    if (alt && alt.trim()) return truncate(foldSpaces(alt), NAME_LIMIT)
    return ''
  }

  function implicitRole(el, tag) {
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'reset' || type === 'button' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'button') return 'button'
    return ''
  }

  function typeOf(el, tag) {
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase()
    if (tag === 'select') return el.multiple ? 'select-multiple' : 'select-one'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'button') return 'button'
    if (isContentEditable(el)) return 'contenteditable'
    return ''
  }

  function attrTrue(el, name) {
    const value = el.getAttribute(name)
    return value === 'true' || value === ''
  }

  function formOf(el) {
    if (el.form) return el.form
    return typeof el.closest === 'function' ? el.closest('form') : null
  }

  function controlRecord(el) {
    const tag = tagOf(el)
    const type = typeOf(el, tag)
    const explicit = explicitRole(el)
    const text = textOf(el, TEXT_LIMIT)
    const record = {
      role: explicit || implicitRole(el, tag),
      name: nameOf(el, tag, text),
    }
    if (type) record.type = type
    const noValueTypes = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image'])
    if (tag === 'input') {
      if (!noValueTypes.has(type)) {
        record.hasValue = type === 'file' ? el.files.length > 0 : el.value !== ''
      }
    } else if (tag === 'textarea' || tag === 'select') {
      record.hasValue = el.value !== ''
    } else if (tag === 'button') {
      // button 自身的 value 不参与 hasValue 判定
    } else {
      record.hasValue = (el.textContent || '').trim().length > 0
    }
    if (includeValues && !(tag === 'input' && (type === 'password' || type === 'file'))) {
      if (tag === 'select' && el.multiple) {
        record.value = Array.from(el.selectedOptions).map((option) => truncate(option.value, VALUE_LIMIT))
      } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        record.value = truncate(el.value, VALUE_LIMIT)
      } else {
        record.value = truncate(foldSpaces(el.textContent || ''), VALUE_LIMIT)
      }
    }
    const ariaChecked = el.getAttribute('aria-checked')
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      if (el.checked) record.checked = true
      else if (ariaChecked === 'true') record.checked = true
      else if (ariaChecked === 'mixed') record.checked = 'mixed'
    } else if (ariaChecked === 'true') {
      record.checked = true
    } else if (ariaChecked === 'mixed') {
      record.checked = 'mixed'
    }
    if (el.disabled === true || attrTrue(el, 'aria-disabled')) record.disabled = true
    if (el.readOnly === true || attrTrue(el, 'aria-readonly')) record.readonly = true
    if (el.required === true || attrTrue(el, 'aria-required')) record.required = true
    if (tag === 'select') {
      const options = Array.from(el.options)
      record.options = options.slice(0, OPTIONS_LIMIT).map((option) => ({
        value: truncate(option.value, VALUE_LIMIT),
        label: truncate(foldSpaces(option.label || option.textContent || ''), CELL_LIMIT),
        ...(option.selected ? { selected: true } : {}),
      }))
      if (options.length > OPTIONS_LIMIT) record.optionsTotal = options.length
    }
    const owner = formOf(el)
    if (owner) {
      const fields = selectorFields(owner)
      if (fields.selector) record.form = fields.selector
    }
    return Object.assign(record, selectorFields(el))
  }

  function linkRecord(el) {
    const raw = el.getAttribute('href') || ''
    let href
    try {
      href = new URL(raw, document.baseURI).href
    } catch {
      href = raw
    }
    const record = {
      text: textOf(el, TEXT_LIMIT),
      href: href.length > HREF_LIMIT ? `${href.slice(0, HREF_LIMIT)}…` : href,
    }
    if (el.getAttribute('target') === '_blank') record.target = '_blank'
    if (href.length > HREF_LIMIT) record.hrefTruncated = true
    return Object.assign(record, selectorFields(el))
  }

  function cellText(cell) {
    return truncate(foldSpaces(cell.textContent || ''), CELL_LIMIT)
  }

  function tableRecord(el) {
    const tag = tagOf(el)
    let headers = []
    let bodyRows = []
    if (tag !== 'table') {
      const rows = Array.from(el.querySelectorAll('[role="row"]'))
        .filter((row) => row.closest('[role="table"], [role="grid"], [role="treegrid"]') === el)
      const headerRow = rows[0]
      if (headerRow) {
        headers = Array.from(headerRow.querySelectorAll('[role="columnheader"]')).map(cellText)
        bodyRows = headers.length > 0 ? rows.filter((row) => row !== headerRow) : rows
      }
      bodyRows = bodyRows.map((row) => Array.from(
        row.querySelectorAll('[role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"]'),
      ).filter((cell) => cell.closest('[role="row"]') === row).map(cellText))
    } else {
      const allRows = Array.from(el.querySelectorAll('tr')).filter((row) => row.closest('table') === el)
      const theadRows = allRows.filter((row) => row.closest('thead'))
      const candidates = allRows.filter((row) => !row.closest('thead'))
      let headerRow = null
      if (theadRows.length > 0) {
        headerRow = theadRows[theadRows.length - 1]
      } else if (candidates.length > 0) {
        const cells = Array.from(candidates[0].querySelectorAll('th, td'))
          .filter((cell) => cell.closest('table') === el)
        if (cells.length > 0 && cells.every((cell) => tagOf(cell) === 'th')) headerRow = candidates[0]
      }
      if (headerRow) {
        headers = Array.from(headerRow.querySelectorAll('th, td'))
          .filter((cell) => cell.closest('table') === el)
          .map(cellText)
        bodyRows = candidates.filter((row) => row !== headerRow)
      } else {
        bodyRows = candidates
      }
      bodyRows = bodyRows.map((row) => Array.from(row.querySelectorAll('th, td'))
        .filter((cell) => cell.closest('table') === el)
        .map(cellText))
    }
    const caption = tag === 'table' ? el.querySelector('caption') : null
    const name = caption ? foldSpaces(caption.textContent || '') : foldSpaces(el.getAttribute('aria-label') || '')
    const totalRows = bodyRows.length
    const record = {}
    if (name) record.name = truncate(name, NAME_LIMIT)
    record.headers = headers
    record.rows = bodyRows.slice(0, maxItems)
    record.totalRows = totalRows
    if (totalRows > record.rows.length) record.omittedRows = totalRows - record.rows.length
    return Object.assign(record, selectorFields(el))
  }

  function formRecord(el, fieldCount) {
    const record = {}
    if (el.id) record.id = el.id
    const name = el.getAttribute('name')
    if (name) record.name = name
    record.action = truncate(el.action || '', VALUE_LIMIT)
    record.method = (el.getAttribute('method') || 'get').toLowerCase()
    record.fieldCount = fieldCount
    return Object.assign(record, selectorFields(el))
  }

  let root
  if (selector) {
    try {
      root = document.querySelector(selector)
    } catch (error) {
      return { error: 'invalid-selector', message: String(error && error.message ? error.message : error) }
    }
    if (!root) return { error: 'no-match' }
  } else {
    root = document.body || document.documentElement
  }
  if (!root) return { error: 'no-match' }

  const all = [root, ...Array.from(root.querySelectorAll('*'))]
  const scanTruncated = all.length > scanLimit
  const elements = scanTruncated ? all.slice(0, scanLimit) : all

  const counts = {}
  const buckets = {}
  for (const section of sections) {
    counts[section] = 0
    buckets[section] = []
  }
  const formFieldCounts = new Map()

  function isControl(el, tag, role) {
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return true
    if (isContentEditable(el)) return true
    return WIDGET_ROLES.has(role)
  }

  for (const el of elements) {
    const tag = tagOf(el)
    const role = explicitRole(el)
    if (isControl(el, tag, role)) {
      // 表单 fieldCount 与是否请求 controls 节无关：控件归类始终参与统计。
      if (visibleEnough(el)) {
        if (sections.includes('controls')) {
          counts.controls += 1
          if (buckets.controls.length < maxItems) buckets.controls.push(el)
        }
        const owner = typeof el.closest === 'function' ? el.closest('form') : null
        if (owner) formFieldCounts.set(owner, (formFieldCounts.get(owner) || 0) + 1)
      }
      continue
    }
    if (sections.includes('links') && (tag === 'a' || tag === 'area') && el.hasAttribute('href')) {
      if (visibleEnough(el)) {
        counts.links += 1
        if (buckets.links.length < maxItems) buckets.links.push(el)
      }
      continue
    }
    if (sections.includes('tables') && (tag === 'table' || TABLE_ROLES.has(role))) {
      if (visibleEnough(el)) {
        counts.tables += 1
        if (buckets.tables.length < maxItems) buckets.tables.push(el)
      }
      continue
    }
    if (sections.includes('forms') && tag === 'form') {
      if (visibleEnough(el)) {
        counts.forms += 1
        if (buckets.forms.length < maxItems) buckets.forms.push(el)
      }
    }
  }

  const records = {}
  if (sections.includes('controls')) records.controls = buckets.controls.map(controlRecord)
  if (sections.includes('links')) records.links = buckets.links.map(linkRecord)
  if (sections.includes('tables')) records.tables = buckets.tables.map(tableRecord)
  if (sections.includes('forms')) {
    records.forms = buckets.forms.map((el) => formRecord(el, formFieldCounts.get(el) || 0))
  }

  const result = { counts, scanTruncated }
  for (const section of sections) result[section] = records[section]
  return result
}

/** 一节标题 + 紧凑 JSON；截断时标题带「共 N 个，已截断」。 */
function sectionText(name, list, counts, omitted) {
  const label = SECTION_LABELS[name]
  const tableRowsTruncated = name === 'tables' && list.some((table) => (table.omittedRows ?? 0) > 0)
  const truncated = (omitted[name] ?? 0) > 0 || tableRowsTruncated
  const title = truncated
    ? `${label} ${list.length} 个（共 ${counts[name] ?? 0} 个，已截断）`
    : `${label} ${list.length} 个`
  return `${title}\n${JSON.stringify(list)}`
}

/**
 * 按节份额修剪文本，直到每节不超过 floor(16000 / 节数)。
 * 非表格节从数组末尾整条丢弃；表格先丢该表 rows 末尾的行，行丢完再丢整张表。
 * @returns {boolean} 是否发生过文本预算丢弃
 */
function applyTextBudget(sections, lists, counts, omitted, share) {
  let dropped = false
  for (const name of sections) {
    const list = lists[name]
    while (sectionText(name, list, counts, omitted).length > share) {
      if (name === 'tables') {
        let trimmed = false
        for (let index = list.length - 1; index >= 0; index -= 1) {
          const table = list[index]
          if (table.rows.length > 0) {
            table.rows.pop()
            table.omittedRows = table.totalRows - table.rows.length
            trimmed = true
            break
          }
        }
        if (!trimmed) {
          if (list.length === 0) break
          list.pop()
          omitted.tables = (omitted.tables ?? 0) + 1
        }
      } else {
        if (list.length === 0) break
        list.pop()
        omitted[name] = (omitted[name] ?? 0) + 1
      }
      dropped = true
    }
  }
  return dropped
}

/**
 * 读取页面的结构化记录（只读）。
 * @param {object} session - 会话状态
 * @param {{sections?: string[], maxItems?: number, includeValues?: boolean, selector?: string}} [options] - 入参
 * @param {string} [tabId] - 标签页 id
 * @returns {Promise<object>} tabId / url / mode / sections / counts / omitted / 各节记录 / text / summary / truncated / scanTruncated
 */
export async function readStructured(session, options = {}, tabId) {
  const sections = normalizeSections(options.sections)
  const maxItems = normalizeMaxItems(options.maxItems)
  const includeValues = options.includeValues === true
  const selector = normalizeSelector(options.selector)
  const tab = currentTab(session, tabId)
  const raw = await tab.page.evaluate(readScript, {
    sections,
    maxItems,
    includeValues,
    selector,
    scanLimit: READ_SCAN_LIMIT,
  })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('结构化读取失败：页面返回了非对象结果')
  }
  if (raw.error === 'invalid-selector') {
    throw new Error(
      `selector "${selector}" 不是合法 CSS 选择器：${raw.message}；请先用 browser_e2e_snapshot 确认页面结构`,
    )
  }
  if (raw.error === 'no-match') {
    throw new Error(
      `selector "${selector}" 没有匹配元素；请先用 browser_e2e_snapshot 确认页面结构，或去掉 selector 读整页`,
    )
  }

  const counts = {}
  const omitted = {}
  const lists = {}
  for (const name of sections) {
    const list = Array.isArray(raw[name]) ? raw[name] : []
    lists[name] = list
    counts[name] = Number.isInteger(raw.counts?.[name]) ? raw.counts[name] : list.length
    omitted[name] = counts[name] - list.length
  }
  const share = Math.floor(READ_TEXT_LIMIT / sections.length)
  const budgetDropped = applyTextBudget(sections, lists, counts, omitted, share)
  const scanTruncated = raw.scanTruncated === true

  const tableRowsTruncated = sections.includes('tables')
    && lists.tables.some((table) => (table.omittedRows ?? 0) > 0)
  const truncated = budgetDropped
    || sections.some((name) => omitted[name] > 0)
    || tableRowsTruncated

  const lines = sections.map((name) => sectionText(name, lists[name], counts, omitted))
  if (budgetDropped) {
    lines.push(`（文本已按 ${READ_TEXT_LIMIT} 字符上限截断；要读更多请只请求一节，或用 selector 缩小范围）`)
  }
  if (scanTruncated) {
    lines.push(`（已扫描 ${READ_SCAN_LIMIT} 个元素后停止，结果可能不完整；请用 selector 缩小范围）`)
  }
  const summaryParts = sections.map((name) => `${SECTION_LABELS[name]} ${lists[name].length}`)
  const summary = `结构化读取 ${summaryParts.join(' / ')}${truncated ? '（已截断）' : ''}`

  const info = {
    tabId: tab.id,
    url: tab.page.url(),
    mode: 'read',
    sections,
    counts,
    omitted,
  }
  for (const name of sections) info[name] = lists[name]
  info.text = lines.join('\n')
  info.summary = summary
  info.truncated = truncated
  info.scanTruncated = scanTruncated
  return info
}
