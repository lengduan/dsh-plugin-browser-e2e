/**
 * browser_e2e_recipe 独立验收：按 specs/功能规格/0028-recipe-script.md「验收」逐条覆盖。
 *
 * 分两段：
 *   A. 纯校验与渲染组（不启动浏览器）：常量与工具描述 / README 一致、一级校验全部错误文案、
 *      三选一与区间、合法 recipe 归一化保序、校验失败不碰会话、四种摘要文案、PASS / FAIL 行、
 *      20000 字符截断、summaryOf 取首行。摘要组用假 session + 假 page 驱动 runRecipe 真实分支。
 *   B. 执行组（真起无头 Edge + 本地 node:http 夹具）：登录链路、首个失败即停、navigate 后
 *      ref 失效、wait 命中与超时、总预算在步骤间耗尽（含末步之后补检）、extract 三种取值与
 *      未命中、tab_id 隔离、不写 ref 表与快照基线、page_closed、输出截断、工具层渲染、
 *      press / hover / scroll。
 *
 * 夹具全部走 127.0.0.1 随机端口，不依赖外网。
 * 运行：node tests/recipe.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, closeTab, launch, requireSession } = await import('../lib/session.js')
const { currentTab, evaluate, navigate } = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')
const {
  normalizeRecipe, RECIPE_DEFAULT_TIMEOUT_MS, RECIPE_EXTRACT_LIMIT_DEFAULT, RECIPE_EXTRACT_LIMIT_MAX,
  RECIPE_MAX_STEPS, RECIPE_MAX_TIMEOUT_MS, RECIPE_MIN_TIMEOUT_MS, RECIPE_OUTPUT_TEXT_LIMIT,
  RECIPE_STEP_TYPES, RECIPE_WAIT_DEFAULT_TIMEOUT_MS, RECIPE_WAIT_MAX_TIMEOUT_MS, RECIPE_WAIT_MIN_TIMEOUT_MS,
  renderRecipeReport, runRecipe,
} = await import('../lib/recipe.js')
const { buildToolTable, summaryOf } = await import('../lib/tools.js')

const KEY = 'test-recipe-key'
let session = null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 由 Playwright 临时 profile 启动的 msedge 主进程数；正常应归零。 */
function playwrightEdgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'playwright_chromiumdev_profile' -and $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 期望某次调用抛错，返回错误信息（没抛错返回 null）。 */
async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/** 轮询直到条件成立；进程退出是异步的，固定 sleep 会偶发失败。 */
async function waitUntil(fn, timeoutMs = 10000, stepMs = 250) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(stepMs)
  }
}

/** 从 snapshot 文本里解析某个标签文本对应的 ref。 */
function refOf(info, label) {
  const line = info.text.split('\n').find((row) => row.includes(`"${label}"`))
  const match = line && /\[(\d+)\]/.exec(line)
  return match ? `@${match[1]}` : null
}

/** ref 表 / 快照基线的可比较快照（与 tests/assert.mjs 同口径）。 */
function serializeRefs(tab) {
  return JSON.stringify([...tab.refs.entries()].map(([key, value]) => [key, value.xpath]))
}
function serializeBaselines(tab) {
  return JSON.stringify([...tab.snapshotBaselines].map(([, bucket]) =>
    [bucket.epoch, bucket.version, bucket.nextRef, bucket.keys.size]))
}

/**
 * 假 page：只实现 runRecipe 用到的 isClosed / url / evaluate，用来在纯校验组驱动
 * extract 成功、失败、超预算、关页四种报告分支，不启动浏览器。
 */
function fakePage({ value = '', found = true, delayMs = 0, throwError = null } = {}) {
  let closed = false
  return {
    isClosed: () => closed,
    url: () => 'http://fake.test/',
    async evaluate() {
      if (delayMs > 0) await sleep(delayMs)
      if (throwError) {
        closed = true
        throw new Error(throwError)
      }
      return found ? { found: true, value } : { found: false }
    },
  }
}

/** 假 session：结构满足 currentTab / assertBrowserRunning，用于纯组驱动 runRecipe。 */
function fakeSession(page) {
  const tab = { id: 't1', page, refs: new Map(), snapshotBaselines: new Map() }
  return {
    key: 'fake-recipe-session',
    activeTabId: 't1',
    pages: new Map([['t1', tab]]),
    touchCount: 0,
    touch() { this.touchCount += 1 },
  }
}

const baseline = edgeRootCount()
const playwrightBaseline = playwrightEdgeRootCount()

console.log('== 用例 A：纯校验与渲染组（不启动浏览器）==')
const toolTable = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
const recipeTool = toolTable.find((definition) => definition.name === 'browser_e2e_recipe')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
{
  check('recipe 常量与工具描述一致', (() => {
    const description = recipeTool?.description ?? ''
    return RECIPE_MAX_STEPS === 20
      && RECIPE_DEFAULT_TIMEOUT_MS === 60000
      && RECIPE_MIN_TIMEOUT_MS === 1000
      && RECIPE_MAX_TIMEOUT_MS === 120000
      && RECIPE_OUTPUT_TEXT_LIMIT === 20000
      && RECIPE_WAIT_DEFAULT_TIMEOUT_MS === 10000
      && RECIPE_WAIT_MIN_TIMEOUT_MS === 1000
      && RECIPE_WAIT_MAX_TIMEOUT_MS === 60000
      && RECIPE_EXTRACT_LIMIT_DEFAULT === 100
      && RECIPE_EXTRACT_LIMIT_MAX === 200
      && RECIPE_STEP_TYPES.join(' / ') === 'navigate / wait / click / fill / press / hover / scroll / extract'
      && description.includes(`1-${RECIPE_MAX_STEPS}`)
      && description.includes(String(RECIPE_DEFAULT_TIMEOUT_MS))
      && description.includes(`${RECIPE_MIN_TIMEOUT_MS}-${RECIPE_MAX_TIMEOUT_MS}`)
      && description.includes(String(RECIPE_WAIT_DEFAULT_TIMEOUT_MS))
      && description.includes(`${RECIPE_WAIT_MIN_TIMEOUT_MS}-${RECIPE_WAIT_MAX_TIMEOUT_MS}`)
      && description.includes(String(RECIPE_OUTPUT_TEXT_LIMIT))
      && RECIPE_STEP_TYPES.every((type) => description.includes(type))
  })(), JSON.stringify({
    description: recipeTool?.description,
    constants: {
      RECIPE_MAX_STEPS,
      RECIPE_DEFAULT_TIMEOUT_MS,
      RECIPE_MIN_TIMEOUT_MS,
      RECIPE_MAX_TIMEOUT_MS,
      RECIPE_OUTPUT_TEXT_LIMIT,
      RECIPE_WAIT_DEFAULT_TIMEOUT_MS,
      RECIPE_WAIT_MIN_TIMEOUT_MS,
      RECIPE_WAIT_MAX_TIMEOUT_MS,
    },
  }))
  check('README 多步步骤小节与常量口径一致',
    readme.includes('### 多步步骤（recipe）')
      && readme.includes('browser_e2e_recipe')
      && readme.includes('1-20 个声明式步骤')
      && readme.includes(`默认 ${RECIPE_DEFAULT_TIMEOUT_MS}`)
      && readme.includes(`${RECIPE_MIN_TIMEOUT_MS}-${RECIPE_MAX_TIMEOUT_MS}`)
      && readme.includes(`${RECIPE_OUTPUT_TEXT_LIMIT} 字符`),
    JSON.stringify({ hasSection: readme.includes('### 多步步骤（recipe）') }))

  const notArrayString = await expectThrow(() => normalizeRecipe({ steps: 'x' }))
  const notArrayNull = await expectThrow(() => normalizeRecipe({ steps: null }))
  const notArrayUndefined = await expectThrow(() => normalizeRecipe({}))
  check('steps 非数组报错',
    notArrayString === 'steps 必须是数组（1-20 步），收到 string'
      && notArrayNull === 'steps 必须是数组（1-20 步），收到 null'
      && notArrayUndefined === 'steps 必须是数组（1-20 步），收到 undefined',
    JSON.stringify({ notArrayString, notArrayNull, notArrayUndefined }))

  const empty = await expectThrow(() => normalizeRecipe({ steps: [] }))
  const tooMany = await expectThrow(() => normalizeRecipe({
    steps: Array.from({ length: 21 }, () => ({ type: 'extract' })),
  }))
  check('steps 为空或超过 20 步报错',
    empty === 'steps 必须是 1-20 步，收到 0 步'
      && tooMany === 'steps 必须是 1-20 步，收到 21 步',
    JSON.stringify({ empty, tooMany }))

  const nullStep = await expectThrow(() => normalizeRecipe({ steps: [null] }))
  const stringStep = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'extract' }, 'x'] }))
  check('单步不是对象报错',
    nullStep === '第 1 步必须是对象' && stringStep === '第 2 步必须是对象',
    JSON.stringify({ nullStep, stringStep }))

  const missingType = await expectThrow(() => normalizeRecipe({ steps: [{}] }))
  const badType = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'evaluate' }] }))
  check('type 缺失或非法报错',
    missingType === '第 1 步缺少 type（可选 navigate / wait / click / fill / press / hover / scroll / extract）'
      && badType === '第 1 步的 type "evaluate" 不支持，可选 navigate / wait / click / fill / press / hover / scroll / extract',
    JSON.stringify({ missingType, badType }))

  const unknownClick = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'click', value: 'x' }] }))
  const unknownExtract = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'extract', tag: 'x' }] }))
  check('步骤带未知字段报错并列出可用字段',
    unknownClick === '第 1 步（click）不接受字段 value；该步骤可用字段：type、ref、selector、x、y'
      && unknownExtract === '第 1 步（extract）不接受字段 tag；该步骤可用字段：type、selector、mode、attribute、limit',
    JSON.stringify({ unknownClick, unknownExtract }))

  const expression = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'wait', selector: '#a', expression: 'window.ok === true' }],
  }))
  check('wait 步不接受 expression 条件',
    expression === '第 1 步（wait）不接受 expression 条件：recipe 不执行调用方提供的页面脚本；'
      + '需要页面内脚本条件请单独调用 browser_e2e_wait 或 browser_e2e_evaluate',
    String(expression))

  const noCondition = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'wait' }] }))
  const twoConditions = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'wait', selector: '#a', url: '/x' }],
  }))
  check('wait 步三选一必须且只能给一个',
    noCondition === '第 1 步（wait）必须且只能给 selector / url / response 之一，当前收到：无'
      && twoConditions === '第 1 步（wait）必须且只能给 selector / url / response 之一，当前收到：selector、url',
    JSON.stringify({ noCondition, twoConditions }))

  const waitTooSmall = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'wait', selector: '#a', timeoutMs: 999 }],
  }))
  const waitTooBig = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'wait', selector: '#a', timeoutMs: 60001 }],
  }))
  check('wait 步 timeoutMs 越界报错',
    waitTooSmall === '第 1 步（wait）的 timeoutMs 必须是 1000-60000 的整数（毫秒），收到 999'
      && waitTooBig === '第 1 步（wait）的 timeoutMs 必须是 1000-60000 的整数（毫秒），收到 60001',
    JSON.stringify({ waitTooSmall, waitTooBig }))

  const clickNone = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'click' }] }))
  check('click 步三选一报错（0 个）',
    clickNone === '第 1 步（click）：缺少点击目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）'
      + '或 x + y（视口坐标）三选一',
    String(clickNone))

  const clickTwo = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'click', ref: '@1', selector: '#a' }] }))
  const clickPointAndSelector = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'click', selector: '#a', x: 1, y: 2 }],
  }))
  check('click 步三选一报错（2 个）',
    clickTwo === '第 1 步（click）：点击目标只能给一种：ref / selector / x + y 三选一，避免点错位置'
      && clickPointAndSelector === clickTwo,
    JSON.stringify({ clickTwo, clickPointAndSelector }))

  const missingValue = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'fill', selector: '#a' }] }))
  const nonStringValue = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'fill', selector: '#a', value: 1 }],
  }))
  check('fill 步缺 value 报错',
    missingValue === '第 1 步（fill）的 value 必须是字符串（空串表示清空），收到 undefined'
      && nonStringValue === '第 1 步（fill）的 value 必须是字符串（空串表示清空），收到 number',
    JSON.stringify({ missingValue, nonStringValue }))

  const settleTooBig = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'hover', selector: '#a', settleMs: 5001 }],
  }))
  const settleNegative = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'hover', selector: '#a', settleMs: -1 }],
  }))
  check('hover 步 settleMs 越界报错',
    settleTooBig?.startsWith('第 1 步（hover）：settleMs 必须是 0-5000 的整数，收到 5001')
      && settleNegative?.startsWith('第 1 步（hover）：settleMs 必须是 0-5000 的整数，收到 -1'),
    JSON.stringify({ settleTooBig, settleNegative }))

  const scrollZero = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'scroll', delta_y: 0 }] }))
  const scrollBothZero = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'scroll', delta_x: 0, delta_y: 0 }],
  }))
  check('scroll 步两个方向都为 0 报错',
    scrollZero === '第 1 步（scroll）的 delta_x / delta_y 至少有一个非 0，否则页面不会滚动'
      && scrollBothZero === scrollZero,
    JSON.stringify({ scrollZero, scrollBothZero }))

  const attributeMissing = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'extract', mode: 'attribute' }],
  }))
  check('extract 步 attribute 模式缺 attribute 报错',
    attributeMissing === '第 1 步（extract）的 mode=attribute 需要 attribute（非空字符串）',
    String(attributeMissing))

  const limitTooBig = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'extract', mode: 'links', limit: 201 }],
  }))
  const limitTooSmall = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'extract', mode: 'links', limit: 0 }],
  }))
  const limitOnText = await expectThrow(() => normalizeRecipe({
    steps: [{ type: 'extract', mode: 'text', limit: 5 }],
  }))
  check('extract 步 limit 越界报错',
    limitTooBig === '第 1 步（extract）的 limit 必须是 1-200 的整数，收到 201'
      && limitTooSmall === '第 1 步（extract）的 limit 必须是 1-200 的整数，收到 0'
      && limitOnText === '第 1 步（extract）的 limit 只对 mode=links 生效',
    JSON.stringify({ limitTooBig, limitTooSmall, limitOnText }))

  const timeoutTooSmall = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'extract' }], timeoutMs: 999 }))
  const timeoutTooBig = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'extract' }], timeoutMs: 120001 }))
  const timeoutFloat = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'extract' }], timeoutMs: 1500.5 }))
  const timeoutString = await expectThrow(() => normalizeRecipe({ steps: [{ type: 'extract' }], timeoutMs: '5000' }))
  const timeoutMessage = (value) => `timeoutMs 必须是 1000 到 120000 之间的整数（毫秒），收到 ${value}`
  check('timeoutMs 越界与非整数报错',
    timeoutTooSmall === timeoutMessage(999)
      && timeoutTooBig === timeoutMessage(120001)
      && timeoutFloat === timeoutMessage(1500.5)
      && timeoutString === timeoutMessage(5000),
    JSON.stringify({ timeoutTooSmall, timeoutTooBig, timeoutFloat, timeoutString }))

  const legalSteps = [
    { type: 'navigate', url: 'http://127.0.0.1:1/x', waitUntil: 'domcontentloaded' },
    { type: 'wait', selector: '#a', state: 'hidden', timeoutMs: 2000 },
    { type: 'click', selector: '#b' },
    { type: 'fill', x: 10, y: 20, value: '', mode: 'keystrokes', delayMs: 0 },
    { type: 'press', key: 'Enter' },
    { type: 'hover', selector: '#c', settleMs: 0 },
    { type: 'scroll', delta_y: 120 },
    { type: 'extract', selector: '#d', mode: 'links', limit: 3 },
  ]
  const normalized = normalizeRecipe({ steps: legalSteps, timeoutMs: 5000 })
  const normalizedDefault = normalizeRecipe({ steps: legalSteps })
  check('合法 recipe 归一化后保留步序与字段',
    normalized.steps.length === 8
      && JSON.stringify(normalized.steps) === JSON.stringify(legalSteps)
      && normalized.timeoutMs === 5000
      && normalizedDefault.timeoutMs === RECIPE_DEFAULT_TIMEOUT_MS,
    JSON.stringify({ count: normalized.steps.length, timeoutMs: normalized.timeoutMs, defaultTimeout: normalizedDefault.timeoutMs }))

  // 假 session 上所有属性访问都抛 SESSION_TOUCHED：一级校验若在页面前失败，就看不到这个错误。
  const guardedSession = new Proxy({}, {
    get() { throw new Error('SESSION_TOUCHED') },
  })
  const guardedSteps = await expectThrow(() => runRecipe(guardedSession, { steps: 'x' }))
  const guardedClick = await expectThrow(() => runRecipe(guardedSession, { steps: [{ type: 'click' }] }))
  check('校验失败不产生任何页面调用',
    guardedSteps === 'steps 必须是数组（1-20 步），收到 string'
      && guardedClick === '第 1 步（click）：缺少点击目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）'
        + '或 x + y（视口坐标）三选一'
      && !String(guardedSteps).includes('SESSION_TOUCHED')
      && !String(guardedClick).includes('SESSION_TOUCHED'),
    JSON.stringify({ guardedSteps, guardedClick }))

  const completed = await runRecipe(fakeSession(fakePage({ value: 'hi' })), {
    steps: [{ type: 'extract', selector: '#x' }],
  })
  const stepFailed = await runRecipe(fakeSession(fakePage({ found: false })), {
    steps: [{ type: 'extract', selector: '#no' }],
  })
  const budgetStopped = await runRecipe(fakeSession(fakePage({ value: 'a', delayMs: 1100 })), {
    timeoutMs: 1000,
    steps: [{ type: 'extract', selector: '#x' }, { type: 'extract', selector: '#y' }],
  })
  const pageClosed = await runRecipe(fakeSession(fakePage({ throwError: 'page closed' })), {
    steps: [{ type: 'extract', selector: '#x' }],
  })
  const renderCompleted = renderRecipeReport(completed)
  const renderFailed = renderRecipeReport(stepFailed)
  const renderBudget = renderRecipeReport(budgetStopped)
  const renderClosed = renderRecipeReport(pageClosed)
  check('renderRecipeReport 四种摘要文案',
    completed.status === 'completed'
      && /^recipe 完成：1\/1 步（标签页 t1，耗时 \d+ms，输出 1 项）$/.test(completed.summary)
      && renderCompleted.split('\n')[0] === completed.summary
      && stepFailed.status === 'step_failed'
      && /^recipe 在第 1 步（extract）失败：0\/1 步已完成，已执行步骤不回滚（标签页 t1，耗时 \d+ms）$/.test(stepFailed.summary)
      && renderFailed.split('\n')[0] === stepFailed.summary
      && budgetStopped.status === 'budget_exceeded'
      && /^recipe 超出总预算 1000ms：在第 2 步前停止，已完成 1\/2 步，已执行步骤不回滚（标签页 t1）$/.test(budgetStopped.summary)
      && renderBudget.split('\n')[0] === budgetStopped.summary
      && pageClosed.status === 'page_closed'
      && /^recipe 中断：标签页 t1 在运行时关闭，已完成 0\/1 步，已执行步骤不回滚$/.test(pageClosed.summary)
      && renderClosed.split('\n')[0] === pageClosed.summary
      && !renderCompleted.includes('失败的步骤不回滚')
      && renderFailed.includes('失败的步骤不回滚；调整后可从剩余步骤继续，已执行过的步骤不要重复。')
      && renderClosed.includes('失败的步骤不回滚')
      && !renderBudget.includes('失败的步骤不回滚'),
    JSON.stringify({
      completed: completed.summary,
      stepFailed: stepFailed.summary,
      budget: budgetStopped.summary,
      pageClosed: pageClosed.summary,
    }))

  const renderLines = renderFailed.split('\n')
  const renderPass = renderRecipeReport({
    summary: 'recipe 完成：2/2 步（标签页 t1，耗时 10ms，输出 2 项）',
    status: 'completed',
    steps: [
      { index: 1, type: 'navigate', ok: true, summary: '导航到 http://x/（标签页 t1，HTTP 200）' },
      { index: 2, type: 'extract', ok: true, summary: '提取 text（selector "#a"）：3 字符' },
    ],
    outputs: [],
    outputsTruncated: false,
  }).split('\n')
  check('renderRecipeReport 逐步 PASS / FAIL 行',
    renderLines[0] === stepFailed.summary
      && renderLines[1] === 'FAIL [1] extract：extract 未命中元素：selector "#no"'
      && renderPass[1] === 'PASS [1] navigate：导航到 http://x/（标签页 t1，HTTP 200）'
      && renderPass[2] === 'PASS [2] extract：提取 text（selector "#a"）：3 字符',
    JSON.stringify({ renderLines, renderPass }))

  const truncated = await runRecipe(fakeSession(fakePage({ value: 'x'.repeat(25000) })), {
    steps: [{ type: 'extract', selector: '#big' }],
  })
  const truncatedRender = renderRecipeReport(truncated).split('\n')
  check('renderRecipeReport 截断输出到 20000 字符',
    truncated.outputs.length === 1
      && truncated.outputs[0].value.length === RECIPE_OUTPUT_TEXT_LIMIT
      && truncated.outputs[0].truncated === true
      && truncated.outputsTruncated === true
      && truncatedRender.at(-1) === `（输出已截断：上限 ${RECIPE_OUTPUT_TEXT_LIMIT} 字符）`,
    JSON.stringify({
      limit: RECIPE_OUTPUT_TEXT_LIMIT,
      length: truncated.outputs[0]?.value.length,
      truncated: truncated.outputs[0]?.truncated,
      outputsTruncated: truncated.outputsTruncated,
      lastLine: truncatedRender.at(-1),
    }))

  check('summaryOf 取 recipe 报告首行',
    summaryOf(renderCompleted) === completed.summary
      && renderCompleted.split('\n')[0] === completed.summary,
    JSON.stringify({ summaryOf: summaryOf(renderCompleted), summary: completed.summary }))
}

console.log('== 用例 B：真起无头 Edge 的执行组 ==')

/** 登录链路夹具：输入、按钮、结果区、extract 用的文本 / 属性 / 链接。 */
const LOGIN_HTML = '<!doctype html><html><head><title>recipe-login</title></head><body>'
  + '<h1 id="title">登录</h1>'
  + '<input id="user" style="position:fixed;left:20px;top:20px;width:200px;height:30px">'
  + '<input id="pass" type="password" style="position:fixed;left:20px;top:60px;width:200px;height:30px">'
  + '<button id="submit" style="position:fixed;left:20px;top:100px;width:120px;height:30px">登录</button>'
  + '<div id="info" data-code="A-42" style="position:fixed;left:20px;top:150px"><b>信息块</b></div>'
  + '<div id="links" style="position:fixed;left:20px;top:190px">'
  + '<a href="/second?from=1">链接一</a><a href="/second?from=2">链接二</a><a href="/login?self=1">自链接</a>'
  + '</div>'
  + '<div id="result" style="position:fixed;left:20px;top:250px;display:none">未登录</div>'
  + '<script>'
  + 'window.__clicks = 0;'
  + 'document.getElementById("submit").addEventListener("click", function () {'
  + '  window.__clicks += 1;'
  + '  var result = document.getElementById("result");'
  + '  result.style.display = "block";'
  + '  result.textContent = "登录成功 user=" + document.getElementById("user").value'
  + '    + " pass=" + document.getElementById("pass").value;'
  + '});'
  + '</script>'
  + '</body></html>'
const SECOND_HTML = '<!doctype html><html><head><title>recipe-second</title></head><body>'
  + '<h1 id="second">第二页</h1></body></html>'
const DELAYED_HTML = '<!doctype html><html><head><title>recipe-delayed</title></head><body>'
  + '<div id="host">等待迟到元素</div>'
  + '<script>setTimeout(function () {'
  + '  var el = document.createElement("div");'
  + '  el.id = "late"; el.textContent = "迟到元素";'
  + '  document.body.appendChild(el);'
  + '}, 300)</script></body></html>'
const NEVER_HTML = '<!doctype html><html><head><title>recipe-never</title></head><body>'
  + '<div id="info">never-page</div></body></html>'
const SLOW_HTML = '<!doctype html><html><head><title>recipe-slow</title></head><body>'
  + '<h1 id="title">慢页面</h1></body></html>'
const BIG_HTML = '<!doctype html><html><head><title>recipe-big</title></head><body>'
  + `<div id="big">${'x'.repeat(30000)}</div></body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(LOGIN_HTML)
    return
  }
  if (url.pathname === '/second') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(SECOND_HTML)
    return
  }
  if (url.pathname === '/delayed') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(DELAYED_HTML)
    return
  }
  if (url.pathname === '/never') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(NEVER_HTML)
    return
  }
  if (url.pathname === '/slow-nav') {
    // 故意拖到 1500ms：recipe 总预算 1000ms 时，导航步 1 超预算，步 2 之前必须停下。
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SLOW_HTML)
    }, 1500)
    return
  }
  if (url.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(BIG_HTML)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  const started = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, 'test-recipe-session')
  session = requireSession(KEY)
  const exec = { agent: { id: KEY } }
  const tool = toolTable.find((definition) => definition.name === 'browser_e2e_recipe')
  check('启动成功', started.reused === false && edgeRootCount() > baseline, JSON.stringify(started))

  console.log('== 执行用例 1：登录链路导航等待填写点击全部完成 ==')
  {
    const result = await runRecipe(session, {
      steps: [
        { type: 'navigate', url: `${base}/login` },
        { type: 'wait', selector: '#user' },
        { type: 'fill', selector: '#user', value: 'demo' },
        { type: 'fill', selector: '#pass', value: 'secret', mode: 'keystrokes' },
        { type: 'click', selector: '#submit' },
        { type: 'wait', selector: '#result', state: 'visible' },
        { type: 'extract', selector: '#result' },
      ],
    })
    check('recipe 登录链路导航等待填写点击全部完成',
      result.ok === true && result.status === 'completed'
        && result.total === 7 && result.completed === 7
        && result.steps.length === 7 && result.steps.every((step) => step.ok === true)
        && result.outputs.length === 1
        && result.outputs[0].value === '登录成功 user=demo pass=secret'
        && result.url.includes('/login'),
      JSON.stringify(result))
    check('recipe 完成摘要文案',
      /^recipe 完成：7\/7 步（标签页 t\d+，耗时 \d+ms，输出 1 项）$/.test(renderRecipeReport(result).split('\n')[0]),
      renderRecipeReport(result).split('\n')[0])
  }

  console.log('== 执行用例 2：首个失败即停与结构化报告 ==')
  {
    await navigate(session, `${base}/login`, 'load')
    const result = await runRecipe(session, {
      steps: [
        { type: 'click', ref: '@99' },
        { type: 'click', selector: '#submit' },
      ],
    })
    const clicks = (await evaluate(session, 'window.__clicks')).value
    check('recipe 首步失败后不再执行后续步骤',
      result.status === 'step_failed' && result.steps.length === 1
        && result.completed === 0 && result.total === 2 && clicks === 0,
      JSON.stringify({ result, clicks }))
    check('recipe 步骤失败返回结构化报告且不抛错',
      result.ok === false && result.status === 'step_failed'
        && result.failedStep?.index === 1 && result.failedStep?.type === 'click'
        && result.failedStep.message.includes('ref @99 不存在')
        && renderRecipeReport(result).split('\n').at(-1)
          === '失败的步骤不回滚；调整后可从剩余步骤继续，已执行过的步骤不要重复。',
      JSON.stringify(result))
  }

  console.log('== 执行用例 3：navigate 后 ref 失效 ==')
  {
    await navigate(session, `${base}/login`, 'load')
    const before = await snapshot(session)
    const ref = refOf(before, '登录')
    const result = await runRecipe(session, {
      steps: [
        { type: 'navigate', url: `${base}/login` },
        { type: 'click', ref },
      ],
    })
    check('recipe 含 navigate 时后续 ref 步报 ref 不存在',
      Boolean(ref) && result.status === 'step_failed'
        && result.completed === 1 && result.failedStep?.index === 2
        && result.failedStep.message.includes(`ref ${ref} 不存在`),
      JSON.stringify({ ref, result }))
  }

  console.log('== 执行用例 4：wait 命中与超时 ==')
  {
    const hit = await runRecipe(session, {
      steps: [
        { type: 'navigate', url: `${base}/delayed` },
        { type: 'wait', selector: '#late', timeoutMs: 2000 },
        { type: 'extract', selector: '#late' },
      ],
    })
    check('recipe wait 步命中 selector',
      hit.status === 'completed' && hit.completed === 3
        && hit.outputs[0]?.value === '迟到元素',
      JSON.stringify(hit))

    await navigate(session, `${base}/never`, 'load')
    const timedOut = await runRecipe(session, {
      steps: [{ type: 'wait', selector: '#never', timeoutMs: 1000 }],
    })
    check('recipe wait 步超时按步骤失败返回',
      timedOut.status === 'step_failed' && timedOut.completed === 0
        && timedOut.failedStep?.message.includes('等待 selector "#never"')
        && timedOut.failedStep.message.includes('超时')
        && timedOut.failedStep.message.includes('上限 1000ms'),
      JSON.stringify(timedOut))
  }

  console.log('== 执行用例 5：总预算只在步骤之间检查 ==')
  {
    const stopped = await runRecipe(session, {
      timeoutMs: 1000,
      steps: [
        { type: 'navigate', url: `${base}/slow-nav` },
        { type: 'extract', selector: '#title' },
      ],
    })
    check('recipe 总预算耗尽在下一步前停止',
      stopped.status === 'budget_exceeded' && stopped.ok === false
        && stopped.completed === 1 && stopped.completed < stopped.total
        && stopped.steps.length === 1
        && /^recipe 超出总预算 1000ms：在第 2 步前停止，已完成 1\/2 步，已执行步骤不回滚（标签页 t\d+）$/
          .test(stopped.summary),
      JSON.stringify(stopped))

    const afterLast = await runRecipe(session, {
      timeoutMs: 1000,
      steps: [{ type: 'navigate', url: `${base}/slow-nav` }],
    })
    check('recipe 末步之后补一次预算检查',
      afterLast.status === 'budget_exceeded' && afterLast.completed === afterLast.total
        && /^recipe 全部 1 步已执行，但总耗时 \d+ms 超出预算 1000ms（标签页 t\d+）$/.test(afterLast.summary),
      JSON.stringify(afterLast))
  }

  console.log('== 执行用例 6：extract 三种取值与未命中 ==')
  {
    await navigate(session, `${base}/login`, 'load')
    const result = await runRecipe(session, {
      steps: [
        { type: 'extract', selector: '#info', mode: 'text' },
        { type: 'extract', selector: '#links', mode: 'links', limit: 2 },
        { type: 'extract', selector: '#info', mode: 'attribute', attribute: 'data-code' },
      ],
    })
    const links = JSON.parse(result.outputs[1]?.value ?? '[]')
    check('recipe extract 取文本 / 链接 / 属性三种模式',
      result.status === 'completed' && result.outputs.length === 3
        && result.outputs[0].mode === 'text' && result.outputs[0].value === '信息块'
        && result.outputs[1].mode === 'links' && Array.isArray(links) && links.length === 2
        && links[0].endsWith('/second?from=1') && links[1].endsWith('/second?from=2')
        && result.outputs[2].mode === 'attribute' && result.outputs[2].value === 'A-42'
        && result.outputsTruncated === false,
      JSON.stringify(result))

    const miss = await runRecipe(session, { steps: [{ type: 'extract', selector: '#missing' }] })
    check('recipe extract 未命中元素报步骤失败',
      miss.status === 'step_failed' && miss.completed === 0
        && miss.failedStep?.message === 'extract 未命中元素：selector "#missing"',
      JSON.stringify(miss))
  }

  console.log('== 执行用例 7：tab_id 隔离与不写状态 ==')
  {
    const tabA = currentTab(session).id
    const tabB = await navigate(session, `${base}/second`, 'load', { new_tab: true })
    // 把 active tab 切回 A，确认 recipe 带 tab_id 时只动 B、不改 active。
    await navigate(session, `${base}/login`, 'load', { tab_id: tabA })
    const activeBefore = currentTab(session).id
    const targeted = await runRecipe(session, {
      tab_id: tabB.tabId,
      steps: [{ type: 'extract', selector: '#second', mode: 'text' }],
    })
    const activeAfter = currentTab(session).id
    check('recipe 只作用于指定 tab_id',
      targeted.tabId === tabB.tabId && targeted.status === 'completed'
        && targeted.outputs[0]?.value === '第二页'
        && targeted.url.includes('/second')
        && activeBefore === tabA && activeAfter === tabA,
      JSON.stringify({ tabA, tabB: tabB.tabId, activeBefore, activeAfter, targeted }))
    await closeTab(KEY, tabB.tabId)

    await navigate(session, `${base}/login`, 'load')
    const pageTab = currentTab(session)
    await snapshot(session)
    const refsBefore = serializeRefs(pageTab)
    const baselinesBefore = serializeBaselines(pageTab)
    const clean = await runRecipe(session, {
      steps: [
        { type: 'wait', selector: '#user' },
        { type: 'extract', selector: '#info' },
      ],
    })
    const refsAfter = serializeRefs(pageTab)
    const baselinesAfter = serializeBaselines(pageTab)
    check('recipe 不写 ref 表与快照基线',
      clean.status === 'completed' && pageTab.refs.size > 0
        && refsAfter === refsBefore && baselinesAfter === baselinesBefore
        && currentTab(session).id === pageTab.id,
      JSON.stringify({
        refs: pageTab.refs.size,
        refsBefore,
        refsAfter,
        baselinesBefore,
        baselinesAfter,
      }))
  }

  console.log('== 执行用例 8：页面运行时被关闭 ==')
  {
    const closing = await navigate(session, `${base}/never`, 'load', { new_tab: true })
    const closingPage = currentTab(session, closing.tabId).page
    const pending = runRecipe(session, {
      tab_id: closing.tabId,
      steps: [
        { type: 'extract', selector: '#info' },
        { type: 'wait', selector: '#never', timeoutMs: 5000 },
      ],
    })
    await sleep(200)
    await closingPage.close()
    const closed = await Promise.race([pending, sleep(5000).then(() => null)])
    check('recipe 页面被关闭时报告 page_closed',
      closed !== null && closed.status === 'page_closed' && closed.completed === 1
        && closed.steps.length === 2 && closed.steps[1].ok === false
        && closed.summary === `recipe 中断：标签页 ${closing.tabId} 在运行时关闭，已完成 1/2 步，已执行步骤不回滚`
        && renderRecipeReport(closed).includes('失败的步骤不回滚'),
      JSON.stringify(closed))
  }

  console.log('== 执行用例 9：输出截断与工具层渲染 ==')
  {
    await navigate(session, `${base}/big`, 'load')
    const big = await runRecipe(session, { steps: [{ type: 'extract', selector: '#big' }] })
    check('recipe extract 输出截断到 20000 字符',
      big.status === 'completed'
        && big.outputs[0]?.value.length === RECIPE_OUTPUT_TEXT_LIMIT
        && big.outputs[0]?.truncated === true && big.outputsTruncated === true
        && renderRecipeReport(big).split('\n').at(-1)
          === `（输出已截断：上限 ${RECIPE_OUTPUT_TEXT_LIMIT} 字符）`,
      JSON.stringify({
        length: big.outputs[0]?.value.length,
        truncated: big.outputs[0]?.truncated,
        outputsTruncated: big.outputsTruncated,
      }))

    await navigate(session, `${base}/login`, 'load')
    const text = await tool.run({ steps: [{ type: 'extract', selector: '#info' }] }, exec)
    check('browser_e2e_recipe 工具返回渲染文本',
      typeof text === 'string'
        && text.split('\n')[0] === summaryOf(text)
        && /^recipe 完成：1\/1 步（标签页 t\d+，耗时 \d+ms，输出 1 项）$/.test(text.split('\n')[0])
        && text.includes('输出 [1] extract（text）：信息块'),
      String(text))

    const invalid = await expectThrow(() => tool.run({ steps: [{ type: 'extract', mode: 'attribute' }] }, exec))
    check('browser_e2e_recipe 一级校验失败直接抛错',
      invalid === '第 1 步（extract）的 mode=attribute 需要 attribute（非空字符串）',
      String(invalid))
  }

  console.log('== 执行用例 10：press / hover / scroll ==')
  {
    await navigate(session, `${base}/login`, 'load')
    const result = await runRecipe(session, {
      steps: [
        { type: 'press', key: 'Tab' },
        { type: 'hover', selector: '#info', settleMs: 0 },
        { type: 'scroll', delta_y: 120 },
      ],
    })
    check('recipe press / hover / scroll 步骤均执行成功',
      result.status === 'completed' && result.completed === 3
        && result.steps.map((step) => step.type).join(',') === 'press,hover,scroll'
        && result.steps.every((step) => step.ok === true),
      JSON.stringify(result))
  }
} finally {
  await closeAll()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const playwrightSettled = await waitUntil(() => playwrightEdgeRootCount() <= playwrightBaseline)
const remaining = edgeRootCount()
const remainingPlaywright = playwrightEdgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
check('本测试未遗留 Playwright Edge 主进程', playwrightSettled && remainingPlaywright <= playwrightBaseline,
  `playwright 基线=${playwrightBaseline} 残留=${remainingPlaywright}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）；`
  + `Playwright 主进程 ${remainingPlaywright} 个（基线 ${playwrightBaseline} 个）`)
process.exit(fail === 0 ? 0 : 1)
