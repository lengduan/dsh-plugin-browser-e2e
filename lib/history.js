/**
 * 动作历史：宿主侧 append-only JSONL 落盘 + 写入前脱敏 + 只读读回。
 *
 * 每次 browser_e2e_* 工具调用结束（成功或失败）由 index.js 追加一条记录；
 * 记录只含 seq / at / tool / ok / summary / session，不落工具入参与返回值。
 * 脱敏只在写入前执行一次：按 SENSITIVE_ARGS 的字段表从入参取值，把摘要里所有
 * 出现替换成 [已脱敏 N 个字符]；action 事件、面板显示与工具返回值都不受影响。
 *
 * 存储是有界的：超过 上限 + 余量 时整份重写为最后 上限 条（临时文件 + rename）。
 * 任何写失败都只吞掉，工具调用结果不受影响。
 *
 * @module history
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { oneLine, timeOf } from './page.js'

/** 读回的默认条数。 */
export const DEFAULT_HISTORY_LIMIT = 20
/** 读回的条数上限。 */
export const MAX_HISTORY_LIMIT = 200
/** 保留条数上限（DSH_BROWSER_HISTORY_MAX 覆盖为正整数时生效）。 */
export const HISTORY_MAX_ENTRIES = 2000
/** 裁剪余量：追加后超过「上限 + 余量」才整份重写。 */
export const HISTORY_PRUNE_SLACK = 200
/** 单条摘要落盘上限（UTF-16 码元），超出追加截断标记。 */
export const HISTORY_SUMMARY_LIMIT = 500

/**
 * 脱敏字段表：工具名 → 入参里需要从摘要中抹掉的字段。
 *
 * 这是唯一执行点；新增工具若在摘要里回显用户输入，必须同步扩这张表。
 */
export const SENSITIVE_ARGS = Object.freeze({
  browser_e2e_fill: Object.freeze(['value']),
  browser_e2e_dialog: Object.freeze(['prompt_text']),
})

/** 模块内状态：按绝对路径索引，换文件路径自然换状态。 */
const states = new Map()

/**
 * 历史文件绝对路径。
 *
 * 每次调用都读环境变量，便于测试与多实例按用例切换文件；DSH_BROWSER_HISTORY_FILE
 * 不是绝对路径时按默认路径处理。
 * @returns {string} 绝对路径
 */
export function actionHistoryPath() {
  const override = process.env.DSH_BROWSER_HISTORY_FILE
  if (typeof override === 'string' && override !== '' && isAbsolute(override)) {
    return override
  }
  return join(homedir(), '.dsh', 'browser-e2e', 'history', 'actions.jsonl')
}

/**
 * 是否允许写入历史：DSH_BROWSER_HISTORY 为 0 / false 时关闭。
 * 读回不受此开关影响。
 * @returns {boolean}
 */
export function historyEnabled() {
  const raw = process.env.DSH_BROWSER_HISTORY
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  return value !== '0' && value !== 'false'
}

/** 从环境变量解析保留条数上限：正整数才生效，否则用默认值。 */
function maxEntries() {
  const value = Number(process.env.DSH_BROWSER_HISTORY_MAX)
  return Number.isInteger(value) && value > 0 ? value : HISTORY_MAX_ENTRIES
}

/**
 * 脱敏纯函数：把摘要里出现的敏感入参值替换为 [已脱敏 N 个字符]。
 *
 * 替换走 split / join，不用正则，避免值里的元字符与引号导致漏配。N 按码点计。
 * @param {string} tool - 工具名
 * @param {unknown} summary - 本次摘要
 * @param {object} args - 本次工具入参（只用于取值，不落盘）
 * @returns {string} 脱敏后的摘要
 */
export function redactActionSummary(tool, summary, args) {
  let text = typeof summary === 'string' ? summary : String(summary ?? '')
  const fields = SENSITIVE_ARGS[tool]
  if (!Array.isArray(fields) || args === null || typeof args !== 'object') return text
  for (const field of fields) {
    const value = args[field]
    if (typeof value !== 'string' || value === '') continue
    text = text.split(value).join(`[已脱敏 ${Array.from(value).length} 个字符]`)
  }
  return text
}

/**
 * 读文件并逐行校验：at 数字、tool 字符串、ok 布尔三者齐才收；
 * summary 非字符串按空串；session 非空字符串才带；seq 非数字按 0。
 * 坏行、空行跳过，文件头 BOM 先剥。
 * @param {string} file - 历史文件路径
 * @returns {Array<object>} 有效记录（文件顺序）
 */
function readEntries(file) {
  const raw = readFileSync(file, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (typeof record.at !== 'number' || typeof record.tool !== 'string' || typeof record.ok !== 'boolean') continue
    const entry = {
      seq: typeof record.seq === 'number' ? record.seq : 0,
      at: record.at,
      tool: record.tool,
      ok: record.ok,
      summary: typeof record.summary === 'string' ? record.summary : '',
    }
    if (typeof record.session === 'string' && record.session !== '') entry.session = record.session
    entries.push(entry)
  }
  return entries
}

/**
 * 懒加载某个文件的进程内状态：有效条数、下一条 seq、自上次裁剪后的追加数。
 * 读失败按空文件处理（追加仍会尝试，裁剪下次读成功后再算）。
 * @param {string} file - 历史文件路径
 * @returns {{knownEntries: number, nextSeq: number, appendedSincePrune: number}}
 */
function loadState(file) {
  const cached = states.get(file)
  if (cached) return cached
  const state = { knownEntries: 0, nextSeq: 1, appendedSincePrune: 0 }
  try {
    const entries = readEntries(file)
    state.knownEntries = entries.length
    const last = entries[entries.length - 1]
    state.nextSeq = last ? last.seq + 1 : 1
  } catch {
    // 文件不存在或读失败：按空文件处理。
  }
  states.set(file, state)
  return state
}

/**
 * 裁剪：保留最后 max 条，写同目录临时文件再 rename 覆盖。
 * 失败时保留原文件与计数，等下一次追加重试。
 * @param {string} file - 历史文件路径
 * @param {{knownEntries: number, appendedSincePrune: number}} state - 该文件的状态
 */
function prune(file, state) {
  const max = maxEntries()
  let entries
  try {
    entries = readEntries(file)
  } catch {
    return
  }
  const kept = entries.slice(-max)
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    return
  }
  state.knownEntries = kept.length
  state.appendedSincePrune = 0
}

/**
 * 追加一条动作记录：脱敏 → 截断 → 追加一行 JSON。
 *
 * 任何异常（目录不可写、磁盘满、序列化失败）都吞掉并返回 null，工具调用照常。
 * @param {object} record - 本次动作
 * @param {string} record.tool - 工具名
 * @param {unknown} record.summary - 摘要（成功取 summaryOf，失败取「失败：…」）
 * @param {object} [record.args] - 工具入参，只用于脱敏计算，不落盘
 * @param {boolean} record.ok - 成功 / 失败
 * @param {string} [record.session] - 会话 key，非空才写
 * @returns {object|null} 写入的记录；关闭或失败时 null
 */
export function appendAction({ tool, summary, args, ok, session } = {}) {
  if (!historyEnabled()) return null
  try {
    const file = actionHistoryPath()
    let text = redactActionSummary(tool, summary, args)
    if (text.length > HISTORY_SUMMARY_LIMIT) {
      text = `${text.slice(0, HISTORY_SUMMARY_LIMIT)}...(已截断)`
    }
    const state = loadState(file)
    const record = { seq: state.nextSeq, at: Date.now(), tool: String(tool ?? ''), ok: Boolean(ok) }
    record.summary = text
    if (typeof session === 'string' && session !== '') record.session = session
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    state.nextSeq += 1
    state.appendedSincePrune += 1
    if (state.knownEntries + state.appendedSincePrune > maxEntries() + HISTORY_PRUNE_SLACK) {
      prune(file, state)
    }
    return record
  } catch {
    return null
  }
}

/**
 * 读回动作历史：过滤 → 截到最近上限条 → 最新在前 → 渲染文本。
 *
 * 文件不存在按空处理；读失败不抛错，`error` 带消息。返回的 `text` 是完整输出文本。
 * @param {object} [options] - 查询条件
 * @param {number} [options.limit] - 返回条数，非正整数回退默认，超过上限截到上限
 * @param {string} [options.tool] - 按工具名精确过滤
 * @param {boolean} [options.ok] - 只取成功 / 失败
 * @param {string} [options.session] - 只看该会话
 * @param {'self'|'all'} [options.scope] - 显式查询范围；all 时不过滤会话并在首行标注
 * @returns {{file: string, total: number, count: number, entries: Array<object>, text: string, error?: string}}
 */
export function listActions({ limit, tool, ok, session, scope } = {}) {
  const take = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_HISTORY_LIMIT)
    : DEFAULT_HISTORY_LIMIT
  const file = actionHistoryPath()
  let entries = []
  let error
  try {
    entries = readEntries(file)
  } catch (err) {
    if (err?.code !== 'ENOENT') error = err instanceof Error ? err.message : String(err)
  }
  const window = entries.slice(-maxEntries())
  const total = window.length
  const all = scope === 'all'
  const bySession = !all && typeof session === 'string' && session !== ''
  const matched = window.filter((entry) => (typeof tool === 'string' && tool !== '' ? entry.tool === tool : true)
    && (typeof ok === 'boolean' ? entry.ok === ok : true)
    && (bySession ? entry.session === session : true))
  const picked = matched.slice(-take).reverse()

  const notes = []
  if (typeof tool === 'string' && tool !== '') notes.push(`tool=${tool}`)
  if (typeof ok === 'boolean') notes.push(`ok=${ok}`)
  if (all) notes.push('scope=all')

  const lines = []
  if (total === 0) {
    lines.push(`还没有动作记录（文件：${file}）`)
    if (error !== undefined) lines.push(`读取历史失败：${error}`)
  } else {
    const note = notes.length > 0 ? `；${notes.join('；')}` : ''
    lines.push(`动作历史 ${picked.length} 条（共 ${total} 条${note}）`)
    lines.push(`文件：${file}`)
    if (picked.length === 0) lines.push('（没有匹配的记录）')
  }
  for (const entry of picked) {
    const iso = Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : ''
    const head = `#${entry.seq} ${timeOf(iso)} ${entry.tool}`.trimEnd()
    const summary = oneLine(entry.summary)
    lines.push(summary === '' ? head : `${head} ${summary}`)
  }

  const result = { file, total, count: picked.length, entries: picked, text: lines.join('\n') }
  if (error !== undefined) result.error = error
  return result
}
