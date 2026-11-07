/**
 * 多步声明式步骤编排（browser_e2e_recipe 的能力实现）。
 *
 * 一步 = 一次既有页面动作：navigate / wait / click / fill / press / hover / scroll / extract。
 * 首个失败即停、已执行步骤不回滚；一级校验（normalizeRecipe）在任何页面调用之前完成。
 * 不执行调用方提供的页面脚本：没有 evaluate 步骤，wait 步不接受 expression 条件；
 * extract 的页内脚本是本模块内固定的只读取值代码。
 *
 * 依赖方向：recipe.js → page.js（只调用既有能力函数，不 import 会话层）。
 */
import {
  click, currentTab, fill, hover, KEYSTROKE_MAX_DELAY_MS, MAX_SETTLE_MS,
  navigate, press, requireTarget, scroll, targetOf, waitConditionOf, waitFor,
} from './page.js'

/** 一次 recipe 最多步骤数。 */
export const RECIPE_MAX_STEPS = 20

/** 整次调用总预算的默认值与区间（毫秒）。 */
export const RECIPE_DEFAULT_TIMEOUT_MS = 60000
export const RECIPE_MIN_TIMEOUT_MS = 1000
export const RECIPE_MAX_TIMEOUT_MS = 120000

/** wait 步单步等待上限的默认值与区间（毫秒）。 */
export const RECIPE_WAIT_DEFAULT_TIMEOUT_MS = 10000
export const RECIPE_WAIT_MIN_TIMEOUT_MS = 1000
export const RECIPE_WAIT_MAX_TIMEOUT_MS = 60000

/** 所有 extract 输出合计的字符上限。 */
export const RECIPE_OUTPUT_TEXT_LIMIT = 20000

/** extract links 模式取前多少条链接的默认值与上限。 */
export const RECIPE_EXTRACT_LIMIT_DEFAULT = 100
export const RECIPE_EXTRACT_LIMIT_MAX = 200

/** 步骤类型枚举；顺序即错误文案与文档里的列举顺序。 */
export const RECIPE_STEP_TYPES = ['navigate', 'wait', 'click', 'fill', 'press', 'hover', 'scroll', 'extract']

/** navigate 步允许的 waitUntil 取值。 */
const NAVIGATE_WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle']

/** extract 步允许的 mode 取值。 */
const EXTRACT_MODES = ['text', 'html', 'links', 'attribute']

/** 每类步骤可用的字段（一级校验白名单；与 lib/tools.js 的步骤 schema 同集合）。 */
const STEP_FIELDS = {
  navigate: ['type', 'url', 'waitUntil'],
  wait: [
    'type', 'selector', 'state', 'url', 'urlMatch', 'response', 'responseMethod',
    'statusMin', 'statusMax', 'includeBuffered', 'failOnRequestFailed', 'timeoutMs', 'expression',
  ],
  click: ['type', 'ref', 'selector', 'x', 'y'],
  fill: ['type', 'ref', 'selector', 'x', 'y', 'value', 'mode', 'delayMs'],
  press: ['type', 'key'],
  hover: ['type', 'ref', 'selector', 'x', 'y', 'settleMs'],
  scroll: ['type', 'delta_x', 'delta_y', 'x', 'y'],
  extract: ['type', 'selector', 'mode', 'attribute', 'limit'],
}

/** 把值渲染成错误文案里的「收到 X」。 */
function receivedOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  return typeof value
}

/** 非空字符串判定（空串按未给处理，与既有工具口径一致）。 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/** 给步骤级错误加「第 <i> 步（<type>）：」前缀。 */
function stepError(index, type, error) {
  const message = error?.message ?? String(error)
  return new Error(`第 ${index} 步（${type}）：${message}`)
}

/** 校验 wait 步的单步 timeoutMs 区间。 */
function checkWaitTimeout(index, value) {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < RECIPE_WAIT_MIN_TIMEOUT_MS || value > RECIPE_WAIT_MAX_TIMEOUT_MS) {
    throw new Error(`第 ${index} 步（wait）的 timeoutMs 必须是 ${RECIPE_WAIT_MIN_TIMEOUT_MS}-${RECIPE_WAIT_MAX_TIMEOUT_MS} 的整数（毫秒），收到 ${value}`)
  }
}

/** 校验单步；全部通过返回该步（原字段不变）。 */
function normalizeStep(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`第 ${index} 步必须是对象`)
  }
  const type = raw.type
  if (type === undefined) {
    throw new Error(`第 ${index} 步缺少 type（可选 ${RECIPE_STEP_TYPES.join(' / ')}）`)
  }
  if (!RECIPE_STEP_TYPES.includes(type)) {
    throw new Error(`第 ${index} 步的 type "${String(type)}" 不支持，可选 ${RECIPE_STEP_TYPES.join(' / ')}`)
  }
  const allowed = STEP_FIELDS[type]
  const unknown = Object.keys(raw).filter((name) => !allowed.includes(name))
  if (unknown.length > 0) {
    throw new Error(`第 ${index} 步（${type}）不接受字段 ${unknown.join('、')}；该步骤可用字段：${allowed.join('、')}`)
  }

  if (type === 'navigate') {
    if (!isNonEmptyString(raw.url)) {
      throw new Error(`第 ${index} 步（navigate）缺少 url（非空字符串）`)
    }
    const waitUntil = raw.waitUntil ?? 'load'
    if (!NAVIGATE_WAIT_UNTIL.includes(waitUntil)) {
      throw new Error(`第 ${index} 步（navigate）的 waitUntil 只支持 ${NAVIGATE_WAIT_UNTIL.join(' / ')}，收到 "${waitUntil}"`)
    }
  } else if (type === 'wait') {
    // expression 是刻意保留的字段名：给出专门文案，绝不传给 waitFor。
    if (isNonEmptyString(raw.expression)) {
      throw new Error(`第 ${index} 步（wait）不接受 expression 条件：recipe 不执行调用方提供的页面脚本；`
        + '需要页面内脚本条件请单独调用 browser_e2e_wait 或 browser_e2e_evaluate')
    }
    const provided = ['selector', 'url', 'response'].filter((name) => isNonEmptyString(raw[name]))
    if (provided.length !== 1) {
      throw new Error(`第 ${index} 步（wait）必须且只能给 selector / url / response 之一，`
        + `当前收到：${provided.length > 0 ? provided.join('、') : '无'}`)
    }
    checkWaitTimeout(index, raw.timeoutMs)
    try {
      waitConditionOf(raw)
    } catch (error) {
      throw stepError(index, type, error)
    }
  } else if (type === 'click' || type === 'fill') {
    try {
      targetOf(raw, type)
    } catch (error) {
      throw stepError(index, type, error)
    }
    if (type === 'fill') {
      if (typeof raw.value !== 'string') {
        throw new Error(`第 ${index} 步（fill）的 value 必须是字符串（空串表示清空），收到 ${raw.value === null ? 'null' : typeof raw.value}`)
      }
      const mode = raw.mode ?? 'insert'
      if (mode !== 'insert' && mode !== 'keystrokes') {
        throw new Error(`第 ${index} 步（fill）的 mode 只支持 insert / keystrokes，收到 "${String(raw.mode)}"`)
      }
      if (raw.delayMs !== undefined) {
        if (!Number.isInteger(raw.delayMs) || raw.delayMs < 0 || raw.delayMs > KEYSTROKE_MAX_DELAY_MS) {
          throw new Error(`第 ${index} 步（fill）的 delayMs 必须是 0-${KEYSTROKE_MAX_DELAY_MS} 的整数，收到 ${raw.delayMs}`)
        }
      }
    }
  } else if (type === 'hover') {
    try {
      requireTarget(raw, '悬停', '悬停到错误元素')
    } catch (error) {
      throw stepError(index, type, error)
    }
    if (raw.settleMs !== undefined) {
      if (!Number.isInteger(raw.settleMs) || raw.settleMs < 0 || raw.settleMs > MAX_SETTLE_MS) {
        throw new Error(`第 ${index} 步（hover）：settleMs 必须是 0-${MAX_SETTLE_MS} 的整数，收到 ${raw.settleMs}`)
      }
    }
  } else if (type === 'press') {
    if (!isNonEmptyString(raw.key)) {
      throw new Error(`第 ${index} 步（press）缺少 key（非空字符串）`)
    }
  } else if (type === 'scroll') {
    if ((raw.x === undefined) !== (raw.y === undefined)) {
      throw new Error(`第 ${index} 步（scroll）的 x / y 必须同时给（视口坐标）`)
    }
    const deltaX = Number(raw.delta_x ?? 0)
    const deltaY = Number(raw.delta_y ?? 0)
    if (deltaX === 0 && deltaY === 0) {
      throw new Error(`第 ${index} 步（scroll）的 delta_x / delta_y 至少有一个非 0，否则页面不会滚动`)
    }
  } else {
    // extract
    const mode = raw.mode ?? 'text'
    if (!EXTRACT_MODES.includes(mode)) {
      throw new Error(`第 ${index} 步（extract）的 mode 只支持 ${EXTRACT_MODES.join(' / ')}，收到 "${String(raw.mode)}"`)
    }
    if (mode === 'attribute' && !isNonEmptyString(raw.attribute)) {
      throw new Error(`第 ${index} 步（extract）的 mode=attribute 需要 attribute（非空字符串）`)
    }
    if (mode !== 'attribute' && raw.attribute !== undefined) {
      throw new Error(`第 ${index} 步（extract）的 attribute 只对 mode=attribute 生效`)
    }
    if (raw.limit !== undefined) {
      if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > RECIPE_EXTRACT_LIMIT_MAX) {
        throw new Error(`第 ${index} 步（extract）的 limit 必须是 1-${RECIPE_EXTRACT_LIMIT_MAX} 的整数，收到 ${raw.limit}`)
      }
      if (mode !== 'links') {
        throw new Error(`第 ${index} 步（extract）的 limit 只对 mode=links 生效`)
      }
    }
  }
  return { ...raw }
}

/**
 * 一级校验 + 归一化：steps 条数 / 每步类型与字段 / 枚举与区间 / 三选一 / wait 条件与内部参数。
 * 纯函数：不读会话、不碰页面；失败抛错，调用方一个页面动作都不执行。
 * @param {object} input - 工具入参
 * @returns {{steps: object[], timeoutMs: number}} 归一后的步骤与总预算
 */
export function normalizeRecipe(input) {
  const rawSteps = input?.steps
  if (!Array.isArray(rawSteps)) {
    throw new Error(`steps 必须是数组（1-${RECIPE_MAX_STEPS} 步），收到 ${receivedOf(rawSteps)}`)
  }
  if (rawSteps.length < 1 || rawSteps.length > RECIPE_MAX_STEPS) {
    throw new Error(`steps 必须是 1-${RECIPE_MAX_STEPS} 步，收到 ${rawSteps.length} 步`)
  }
  const steps = rawSteps.map((step, position) => normalizeStep(step, position + 1))

  const rawTimeout = input?.timeoutMs
  const timeoutMs = rawTimeout === undefined ? RECIPE_DEFAULT_TIMEOUT_MS : rawTimeout
  if (!Number.isInteger(timeoutMs) || timeoutMs < RECIPE_MIN_TIMEOUT_MS || timeoutMs > RECIPE_MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs 必须是 ${RECIPE_MIN_TIMEOUT_MS} 到 ${RECIPE_MAX_TIMEOUT_MS} 之间的整数（毫秒），收到 ${rawTimeout === undefined ? 'undefined' : rawTimeout}`)
  }
  return { steps, timeoutMs }
}

/** extract 的固定页内只读脚本；代码不来自调用方。 */
async function extractValue(page, step) {
  const mode = step.mode ?? 'text'
  const selector = isNonEmptyString(step.selector) ? step.selector : 'body'
  const limit = step.limit ?? RECIPE_EXTRACT_LIMIT_DEFAULT
  const attribute = step.attribute
  const result = await page.evaluate(({ selector: target, mode: extractMode, attribute: name, limit: max }) => {
    const el = document.querySelector(target)
    if (!el) return { found: false }
    if (extractMode === 'html') return { found: true, value: el.innerHTML ?? '' }
    if (extractMode === 'links') {
      const list = Array.from(el.querySelectorAll('a[href]')).slice(0, max).map((anchor) => anchor.href)
      return { found: true, value: JSON.stringify(list) }
    }
    if (extractMode === 'attribute') return { found: true, value: el.getAttribute(name) ?? '' }
    return { found: true, value: el.innerText ?? '' }
  }, { selector, mode, attribute, limit })
  if (!result || result.found !== true) {
    throw new Error(`extract 未命中元素：selector "${selector}"`)
  }
  const value = String(result.value)
  return { mode, value, summary: `提取 ${mode}（selector "${selector}"）：${value.length} 字符` }
}

/** 执行单个步骤；预算只用于截断 wait 步的等待上限。 */
async function runRecipeStep(session, step, tab, deadline) {
  if (step.type === 'navigate') {
    return await navigate(session, step.url, step.waitUntil ?? 'load', { tab_id: tab.id })
  }
  if (step.type === 'wait') {
    const stepTimeout = step.timeoutMs ?? RECIPE_WAIT_DEFAULT_TIMEOUT_MS
    const remaining = Math.max(1, deadline - Date.now())
    return await waitFor(session, { ...step, timeoutMs: Math.min(stepTimeout, remaining) }, tab.id)
  }
  if (step.type === 'click') return await click(session, step, tab.id)
  if (step.type === 'fill') {
    return await fill(session, step, step.value, tab.id, { mode: step.mode, delayMs: step.delayMs })
  }
  if (step.type === 'press') return await press(session, step.key, tab.id)
  if (step.type === 'hover') return await hover(session, step, tab.id)
  if (step.type === 'scroll') return await scroll(session, step, tab.id)
  return await extractValue(tab.page, step)
}

/**
 * 按序执行 recipe：入口取页 → 逐步骤执行 → 预算与关页判定 → 结构化报告。
 * 步骤失败作为值返回（ok:false），不抛错；一级校验、浏览器未启动、tab 不存在、
 * 入口时页面已关闭才抛错。
 * @param {object} session - 会话对象
 * @param {object} input - 工具入参
 * @returns {Promise<object>} 结构化报告（字段见功能规格 0028「输出」）
 */
export async function runRecipe(session, input) {
  const { steps, timeoutMs } = normalizeRecipe(input)
  const tab = currentTab(session, input?.tab_id)
  const page = tab.page
  if (page.isClosed()) {
    throw new Error(`recipe 的目标标签页 ${tab.id} 已关闭，请重新 browser_e2e_tabs 获取可用标签页`)
  }

  const started = Date.now()
  const deadline = started + timeoutMs
  const total = steps.length
  const stepResults = []
  const outputs = []
  let outputChars = 0
  let outputsTruncated = false
  let completed = 0
  let status = 'completed'
  let failedStep = null
  let stoppedAt = null

  for (let position = 0; position < total; position += 1) {
    const step = steps[position]
    const index = position + 1
    if (page.isClosed()) {
      status = 'page_closed'
      stoppedAt = index
      break
    }
    // 预算只在步骤之间检查；正在执行的 Playwright 动作无法中断。
    if (Date.now() >= deadline) {
      status = 'budget_exceeded'
      stoppedAt = index
      break
    }
    if (typeof session.touch === 'function') session.touch()
    const stepStarted = Date.now()
    try {
      const info = await runRecipeStep(session, step, tab, deadline)
      const elapsedMs = Date.now() - stepStarted
      stepResults.push({ index, type: step.type, ok: true, elapsedMs, summary: info?.summary ?? '' })
      completed = index
      if (step.type === 'extract') {
        const mode = info.mode
        let value = info.value
        let truncated = false
        const left = RECIPE_OUTPUT_TEXT_LIMIT - outputChars
        if (value.length > left) {
          value = value.slice(0, Math.max(0, left))
          truncated = true
          outputsTruncated = true
        }
        outputChars += value.length
        outputs.push({ step: index, type: 'extract', mode, value, truncated })
      }
    } catch (error) {
      const message = error?.message ?? String(error)
      const elapsedMs = Date.now() - stepStarted
      if (page.isClosed()) {
        status = 'page_closed'
        stoppedAt = index
        stepResults.push({
          index, type: step.type, ok: false, elapsedMs, message: '标签页在该步执行期间关闭',
        })
      } else {
        status = 'step_failed'
        stoppedAt = index
        stepResults.push({ index, type: step.type, ok: false, elapsedMs, message })
        failedStep = { index, type: step.type, message }
      }
      break
    }
  }

  const elapsedMs = Date.now() - started
  // 末步之后补一次预算检查，并如实报「全部执行但超预算」。
  if (status === 'completed' && Date.now() >= deadline) {
    status = 'budget_exceeded'
    stoppedAt = null
  }
  const tabId = tab.id
  let url = ''
  try {
    url = page.url()
  } catch {
    url = ''
  }

  let summary
  if (status === 'completed') {
    summary = `recipe 完成：${completed}/${total} 步（标签页 ${tabId}，耗时 ${elapsedMs}ms，输出 ${outputs.length} 项）`
  } else if (status === 'step_failed') {
    summary = `recipe 在第 ${failedStep.index} 步（${failedStep.type}）失败：${completed}/${total} 步已完成，`
      + `已执行步骤不回滚（标签页 ${tabId}，耗时 ${elapsedMs}ms）`
  } else if (status === 'budget_exceeded') {
    summary = stoppedAt === null
      ? `recipe 全部 ${total} 步已执行，但总耗时 ${elapsedMs}ms 超出预算 ${timeoutMs}ms（标签页 ${tabId}）`
      : `recipe 超出总预算 ${timeoutMs}ms：在第 ${stoppedAt} 步前停止，已完成 ${completed}/${total} 步，`
        + `已执行步骤不回滚（标签页 ${tabId}）`
  } else {
    summary = `recipe 中断：标签页 ${tabId} 在运行时关闭，已完成 ${completed}/${total} 步，已执行步骤不回滚`
  }

  const report = {
    ok: status === 'completed',
    status,
    total,
    completed,
    tabId,
    url,
    elapsedMs,
    timeoutMs,
    steps: stepResults,
    outputs,
    outputsTruncated,
    summary,
  }
  if (failedStep !== null) report.failedStep = failedStep
  return report
}

/**
 * 把结构化报告渲染成模型可见文本：首行摘要 + 逐步 PASS / FAIL + extract 输出 + 截断与失败尾注。
 * @param {object} report - runRecipe 的返回值
 * @returns {string} 多行文本
 */
export function renderRecipeReport(report) {
  const lines = [report.summary]
  for (const step of report.steps ?? []) {
    const detail = step.ok ? (step.summary ?? '') : (step.message ?? '')
    lines.push(`${step.ok ? 'PASS' : 'FAIL'} [${step.index}] ${step.type}：${detail}`)
  }
  for (const output of report.outputs ?? []) {
    lines.push(`输出 [${output.step}] extract（${output.mode}）：${output.value}`)
  }
  if (report.status === 'step_failed' || report.status === 'page_closed') {
    lines.push('失败的步骤不回滚；调整后可从剩余步骤继续，已执行过的步骤不要重复。')
  }
  if (report.outputsTruncated) {
    lines.push(`（输出已截断：上限 ${RECIPE_OUTPUT_TEXT_LIMIT} 字符）`)
  }
  return lines.join('\n')
}
