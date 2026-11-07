/**
 * browser_e2e_dialog 对话框处理验证（规格：specs/功能规格/0022-dialog-handling.md）。
 *
 * 覆盖：
 *   - alert / confirm / prompt 的记录与应答，以及页面里 observable 的返回值；
 *   - policy dismiss / accept、prompt_text（含显式空串、用页面默认值）；
 *   - 记录环形上限 50、limit 取尾部 / 非正整数回退 / 超过 50 按 50；
 *   - 策略与记录按 tab_id 隔离，新标签页从 dismiss 开始；
 *   - 未知 tab_id、未启动、非法参数的错误文案；
 *   - beforeunload 一律接受；navigate 清空旧文档记录且保留策略；
 *   - 工具声明的参数契约与「设置摘要 + 读取摘要 + 文本块」输出。
 *
 * 夹具全部是 data: URL 页面，不依赖外网。直接调用 lib/session.js / lib/page.js /
 * lib/tools.js 的真实实现，真起无头 Edge，串行执行。
 *
 * 运行：node tests/dialog.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { activeSessionKeys, closeAll, launch, requireSession } = await import('../lib/session.js')
const {
  DIALOG_LIMIT_DEFAULT, DIALOG_PROMPT_TEXT_LIMIT, DIALOG_RING_LIMIT,
  click, currentTab, dialogEntries, evaluate, navigate, setDialogPolicy,
} = await import('../lib/page.js')
const { apply } = await import('../lib/index.js')

const KEY = 'test-dialog-key'
const SID = 'test-dialog-session'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let session = null

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

/** 把 HTML 包成 data: URL。 */
function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** 轮询直到条件成立；进程退出与事件回调都是异步的，固定 sleep 会偶发失败。 */
async function waitUntil(fn, timeoutMs = 10000, stepMs = 100) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(stepMs)
  }
}

/**
 * 轮询读取对话框记录，直到 predicate 成立或超时；返回最后一次读取结果。
 * 记录写入发生在页面事件回调里，可能比触发它的调用返回晚几毫秒。
 */
async function readWhen(predicate, tabId, timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    const info = await dialogEntries(session, DIALOG_RING_LIMIT, tabId)
    if (predicate(info)) return info
    if (Date.now() - started > timeoutMs) return info
    await sleep(30)
  }
}

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 带三个对话框触发按钮的夹具：记录页面里 observable 的返回值。 */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>dialog-fixture</title></head><body>
<button id="confirm" style="position:fixed;left:10px;top:10px;width:240px;height:60px">confirm</button>
<button id="alert" style="position:fixed;left:10px;top:90px;width:240px;height:60px">alert</button>
<button id="prompt" style="position:fixed;left:10px;top:170px;width:240px;height:60px">prompt</button>
<script>
window.__r = { confirm: null, prompt: null, after: 0 };
document.getElementById('confirm').addEventListener('click', function () {
  window.__r.confirm = confirm('确认继续吗');
});
document.getElementById('alert').addEventListener('click', function () {
  window.__r.after = 1;
  alert('提示文案');
  window.__r.after = 2;
});
document.getElementById('prompt').addEventListener('click', function () {
  window.__r.prompt = prompt('请输入名称', '默认名称');
});
</script></body></html>`

/** beforeunload 夹具：点击产生用户激活，再导航离开会触发 beforeunload 对话框。 */
const BEFOREUNLOAD_FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>dialog-beforeunload</title></head><body>
<button id="gesture" style="position:fixed;left:10px;top:10px;width:240px;height:60px">gesture</button>
<script>
window.addEventListener('beforeunload', function (event) {
  event.preventDefault();
  event.returnValue = '确定离开？';
  return '确定离开？';
});
</script></body></html>`

const baseline = edgeRootCount()

// 注册面：用插件自己的 apply 拿带 execute 包装的工具定义（与宿主一致）。
const definitions = []
apply({
  get: () => undefined,
  tools: { register: (definition) => definitions.push(definition) },
  on: () => () => {},
  effect: (factory) => { factory() },
})
const dialogTool = definitions.find((definition) => definition.name === 'browser_e2e_dialog')
const exec = { agent: { id: KEY } }

try {
  console.log('== 用例 1：启动与空记录 ==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    check('启动成功', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    await navigate(session, dataUrl(FIXTURE), 'load')
    const empty = await dialogEntries(session)
    check('默认策略为 dismiss 且无对话时返回空记录',
      empty.tabId === currentTab(session).id
      && empty.policy === 'dismiss' && empty.promptText === null
      && empty.total === 0 && empty.count === 0 && empty.entries.length === 0
      && empty.text === '（暂无对话框记录）'
      && empty.summary === '对话框记录 0 条（策略 dismiss）',
      JSON.stringify(empty))
  }

  console.log('== 用例 2：默认策略下 confirm 被取消 ==')
  {
    await click(session, { selector: '#confirm' })
    const value = await evaluate(session, 'window.__r.confirm')
    const info = await readWhen((current) => current.total === 1)
    const record = info.entries.at(-1)
    const line = info.text.split('\n').at(-1)
    check('默认策略下 confirm 被取消、页面走取消分支并记录文案',
      value.value === false
      && info.total === 1 && info.count === 1
      && record.type === 'confirm' && record.message === '确认继续吗'
      && record.accepted === false && record.defaultValue === '' && record.error === ''
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at)
      && /^\d{2}:\d{2}:\d{2}\.\d{3} confirm 已取消 确认继续吗$/.test(line)
      && info.summary === '对话框记录 1 条（策略 dismiss）',
      JSON.stringify({ value: value.value, info }))
  }

  console.log('== 用例 3：policy=accept 确认 confirm ==')
  {
    const output = await dialogTool.execute({ policy: 'accept' }, exec)
    const previous = await dialogEntries(session)
    await click(session, { selector: '#confirm' })
    const value = await evaluate(session, 'window.__r.confirm')
    const info = await readWhen((current) => current.total === 2)
    check('policy=accept 时 confirm 被确认、页面走确认分支',
      output.startsWith('对话框策略已设为 accept（自动确认，prompt 用页面默认值）\n对话框记录 1 条（策略 accept）\n')
      && previous.promptText === null && previous.policy === 'accept'
      && value.value === true
      && info.total === 2 && info.entries.at(-1).accepted === true
      && info.summary === '对话框记录 2 条（策略 accept）',
      JSON.stringify({ value: value.value, output, info }))
  }

  console.log('== 用例 4：alert 应答后脚本继续执行 ==')
  {
    await setDialogPolicy(session, 'dismiss')
    await click(session, { selector: '#alert' })
    const after = await evaluate(session, 'window.__r.after')
    const info = await readWhen((current) => current.total === 3)
    const record = info.entries.at(-1)
    check('alert 被应答后页面脚本继续执行且记录 type=alert',
      after.value === 2 && record.type === 'alert' && record.message === '提示文案'
      && record.accepted === false && record.defaultValue === ''
      && info.text.split('\n').at(-1).endsWith(' alert 已取消 提示文案'),
      JSON.stringify({ after: after.value, record }))
  }

  console.log('== 用例 5：prompt 默认取消 ==')
  {
    await click(session, { selector: '#prompt' })
    const value = await evaluate(session, 'window.__r.prompt')
    const info = await readWhen((current) => current.total === 4)
    const record = info.entries.at(-1)
    const line = info.text.split('\n').at(-1)
    check('prompt 默认取消返回 null 并记录默认值',
      value.value === null && record.type === 'prompt' && record.accepted === false
      && record.defaultValue === '默认名称'
      && line.includes('prompt 已取消 请输入名称') && line.includes('（默认值：默认名称）'),
      JSON.stringify({ value: value.value, record, line }))
  }

  console.log('== 用例 6：prompt accept 用页面默认值 ==')
  {
    await setDialogPolicy(session, 'accept')
    await click(session, { selector: '#prompt' })
    const value = await evaluate(session, 'window.__r.prompt')
    const info = await readWhen((current) => current.total === 5)
    const record = info.entries.at(-1)
    check('prompt accept 未给 prompt_text 时使用页面默认值',
      value.value === '默认名称' && record.accepted === true
      && record.defaultValue === '默认名称'
      && info.promptText === null
      && info.summary === '对话框记录 5 条（策略 accept）',
      JSON.stringify({ value: value.value, record, summary: info.summary }))
  }

  console.log('== 用例 7：prompt accept 用 prompt_text ==')
  {
    const changed = await setDialogPolicy(session, 'accept', '我方输入')
    await click(session, { selector: '#prompt' })
    const value = await evaluate(session, 'window.__r.prompt')
    const info = await readWhen((current) => current.total === 6)
    const record = info.entries.at(-1)
    check('prompt accept 给了 prompt_text 时用该文本、记录仍保留默认值',
      changed.promptText === '我方输入'
      && changed.summary === '对话框策略已设为 accept（自动确认，prompt 文本 "我方输入"）'
      && value.value === '我方输入' && record.accepted === true
      && record.defaultValue === '默认名称'
      && info.promptText === '我方输入'
      && info.summary === '对话框记录 6 条（策略 accept，prompt 文本 "我方输入"）'
      && info.text.includes('（默认值：默认名称）'),
      JSON.stringify({ value: value.value, record, summary: info.summary }))
  }

  console.log('== 用例 7B：prompt_text 显式空串 ==')
  {
    const changed = await setDialogPolicy(session, 'accept', '')
    await click(session, { selector: '#prompt' })
    const value = await evaluate(session, 'window.__r.prompt')
    const info = await readWhen((current) => current.total === 7)
    check('prompt_text 显式空串时输入空值且策略保留空串',
      changed.promptText === '' && changed.summary === '对话框策略已设为 accept（自动确认，prompt 文本 ""）'
      && value.value === ''
      && info.promptText === '' && info.entries.at(-1).accepted === true
      && info.summary === '对话框记录 7 条（策略 accept，prompt 文本 ""）',
      JSON.stringify({ changed, value: value.value, summary: info.summary }))
  }

  console.log('== 用例 8：prompt_text 与 policy 互斥 ==')
  {
    const dismissError = await expectThrow(() => dialogTool.execute({ policy: 'dismiss', prompt_text: 'x' }, exec))
    const missingError = await expectThrow(() => dialogTool.execute({ prompt_text: 'x' }, exec))
    const expected = 'prompt_text 只在 policy=accept 时生效；要输入 prompt 文本请同时传 policy: "accept"'
    check('prompt_text 与 policy=dismiss 或缺失 policy 时报错',
      dismissError === expected && missingError === expected,
      JSON.stringify({ dismissError, missingError }))
  }

  console.log('== 用例 9：policy 非法值 ==')
  {
    const viaTool = await expectThrow(() => dialogTool.execute({ policy: 'deny' }, exec))
    const viaFunction = await expectThrow(() => setDialogPolicy(session, undefined))
    check('policy 非法值报错并给出取值指引',
      viaTool === 'policy 只支持 dismiss（取消）或 accept（确认），收到 "deny"'
      && viaFunction === 'policy 只支持 dismiss（取消）或 accept（确认），收到 undefined',
      JSON.stringify({ viaTool, viaFunction }))
  }

  console.log('== 用例 10：prompt_text 非字符串 / 超长 ==')
  {
    const typeError = await expectThrow(() => setDialogPolicy(session, 'accept', 123))
    const longError = await expectThrow(() => setDialogPolicy(session, 'accept', 'x'.repeat(DIALOG_PROMPT_TEXT_LIMIT + 1)))
    check('prompt_text 非字符串 / 超长分别报错',
      typeError === 'prompt_text 必须是字符串（可传空串表示输入空值），收到 number'
      && longError === `prompt_text 最多 ${DIALOG_PROMPT_TEXT_LIMIT} 个字符，收到 ${DIALOG_PROMPT_TEXT_LIMIT + 1} 个`,
      JSON.stringify({ typeError, longError }))
  }

  console.log('== 用例 11：环形上限 50 条 ==')
  {
    await setDialogPolicy(session, 'dismiss')
    await navigate(session, 'data:text/html,<title>dialog-ring</title><p>ring</p>', 'load')
    await evaluate(session, 'for (let i = 0; i < 55; i += 1) alert("环形" + i)')
    const full = await readWhen((current) => current.total === DIALOG_RING_LIMIT)
    const messages = full.entries.map((entry) => entry.message)
    const defaultRead = await dialogEntries(session)
    check('对话框记录环形上限 50 条，超出淘汰最旧',
      full.total === DIALOG_RING_LIMIT && full.count === DIALOG_RING_LIMIT
      && messages[0] === '环形5' && messages.at(-1) === '环形54'
      && !messages.includes('环形0') && !messages.includes('环形4')
      && defaultRead.count === DIALOG_LIMIT_DEFAULT
      && defaultRead.entries.at(-1).message === '环形54',
      JSON.stringify({ total: full.total, first: messages[0], last: messages.at(-1), defaultCount: defaultRead.count }))
  }

  console.log('== 用例 12：limit 口径 ==')
  {
    const tail = await dialogEntries(session, 5)
    const oversized = await dialogEntries(session, 100)
    const zero = await dialogEntries(session, 0)
    const negative = await dialogEntries(session, -3)
    const fractional = await dialogEntries(session, 2.5)
    const stringLimit = await dialogEntries(session, '7')
    const limitSummary = `对话框记录 5 条（策略 dismiss）`
    check('limit 取尾部、非正整数回退默认、超过 50 按 50',
      tail.total === DIALOG_RING_LIMIT && tail.count === 5
      && JSON.stringify(tail.entries.map((entry) => entry.message))
        === JSON.stringify(['环形50', '环形51', '环形52', '环形53', '环形54'])
      && tail.summary === limitSummary
      && oversized.count === DIALOG_RING_LIMIT
      && zero.count === DIALOG_LIMIT_DEFAULT && negative.count === DIALOG_LIMIT_DEFAULT
      && fractional.count === DIALOG_LIMIT_DEFAULT && stringLimit.count === DIALOG_LIMIT_DEFAULT
      && zero.entries.at(-1).message === '环形54',
      JSON.stringify({
        tail: tail.count, oversized: oversized.count,
        zero: zero.count, negative: negative.count, fractional: fractional.count, stringLimit: stringLimit.count,
      }))
  }

  console.log('== 用例 13：策略与记录按 tab_id 隔离 ==')
  {
    await setDialogPolicy(session, 'accept', 't1文本', 't1')
    const second = await navigate(session, dataUrl(FIXTURE), 'load', { new_tab: true })
    const t2 = second.tabId
    const t2Empty = await dialogEntries(session, DIALOG_LIMIT_DEFAULT, t2)
    await click(session, { selector: '#confirm' }, t2)
    const t2Value = await evaluate(session, 'window.__r.confirm', t2)
    const t2Info = await readWhen((current) => current.total === 1, t2)
    const t1Info = await dialogEntries(session, DIALOG_RING_LIMIT, 't1')
    const t1Value = await evaluate(session, "prompt('隔离检查', '默认名称')", 't1')
    const t1After = await readWhen((current) => current.entries.at(-1).type === 'prompt', 't1')
    const t2After = await dialogEntries(session, DIALOG_RING_LIMIT, t2)
    const activeRead = await dialogEntries(session)
    check('策略与记录按 tab_id 隔离，新标签页从 dismiss 开始',
      t2 !== 't1'
      && t2Empty.policy === 'dismiss' && t2Empty.promptText === null && t2Empty.total === 0
      && t2Value.value === false
      && t2Info.policy === 'dismiss' && t2Info.entries.at(-1).type === 'confirm'
      && t1Info.policy === 'accept' && t1Info.promptText === 't1文本' && t1Info.total === DIALOG_RING_LIMIT
      && t1Value.value === 't1文本'
      && t1After.policy === 'accept' && t1After.entries.at(-1).accepted === true
      && t1After.entries.at(-1).type === 'prompt'
      && t2After.total === 1 && t2After.entries.at(-1).type === 'confirm'
      && activeRead.tabId === t2,
      JSON.stringify({ t2Empty, t1: { policy: t1Info.policy, total: t1Info.total }, t1Value: t1Value.value, t2After }))
  }

  console.log('== 用例 14：未知 tab_id ==')
  {
    const readError = await expectThrow(() => dialogEntries(session, DIALOG_LIMIT_DEFAULT, 't99'))
    const setError = await expectThrow(() => setDialogPolicy(session, 'dismiss', undefined, 't99'))
    const toolError = await expectThrow(() => dialogTool.execute({ tab_id: 't99' }, exec))
    const expected = 'tab t99 不存在，请先 browser_e2e_tabs 获取最新 tab_id'
    check('未知 tab_id 报错', readError === expected && setError === expected && toolError === expected,
      JSON.stringify({ readError, setError, toolError }))
  }

  console.log('== 用例 15：未启动 ==')
  {
    const unstartedKey = 'test-dialog-unstarted'
    const error = await expectThrow(() => dialogTool.execute({}, { agent: { id: unstartedKey } }))
    const policyError = await expectThrow(() => dialogTool.execute({ policy: 'accept' }, { agent: { id: unstartedKey } }))
    check('未启动时工具报「浏览器尚未启动」',
      error === '浏览器尚未启动，请先调用 browser_e2e_start'
      && policyError === error
      && !activeSessionKeys().includes(unstartedKey),
      JSON.stringify({ error, policyError, keys: activeSessionKeys() }))
  }

  console.log('== 用例 16：工具参数契约与输出 ==')
  {
    const parameters = dialogTool?.parameters
    const contractOk = Boolean(dialogTool)
      && typeof dialogTool.description === 'string' && dialogTool.description.length > 0
      && dialogTool.description.includes('对话框') && dialogTool.description.includes('accept')
      && parameters.type === 'object' && parameters.additionalProperties === false
      && JSON.stringify(parameters.required) === JSON.stringify([])
      && parameters.properties.policy.type === 'string'
      && JSON.stringify(parameters.properties.policy.enum) === JSON.stringify(['dismiss', 'accept'])
      && parameters.properties.prompt_text.type === 'string'
      && parameters.properties.limit.type === 'integer'
      && 'tab_id' in parameters.properties
    check('工具声明 policy 枚举与 limit / prompt_text / tab_id 参数', contractOk, JSON.stringify(parameters))

    const readOnly = await dialogTool.execute({ limit: 1, tab_id: 't2' }, exec)
    const changedOutput = await dialogTool.execute({ policy: 'accept', prompt_text: '契约文本', tab_id: 't2' }, exec)
    const after = await dialogEntries(session, DIALOG_LIMIT_DEFAULT, 't2')
    check('工具输出为「设置摘要 + 读取摘要 + 文本块」',
      readOnly.startsWith('对话框记录 1 条（策略 dismiss）\n')
      && /^\d{2}:\d{2}:\d{2}\.\d{3} confirm 已取消 确认继续吗$/.test(readOnly.split('\n')[1])
      && changedOutput.startsWith('对话框策略已设为 accept（自动确认，prompt 文本 "契约文本"）\n'
        + '对话框记录 1 条（策略 accept，prompt 文本 "契约文本"）\n')
      && after.promptText === '契约文本' && after.entries.at(-1).accepted === false,
      JSON.stringify({ readOnly, changedOutput }))
  }

  console.log('== 用例 17：navigate 清空记录并保留策略 ==')
  {
    await setDialogPolicy(session, 'accept', '导航文本', 't2')
    await click(session, { selector: '#prompt' }, 't2')
    const before = await readWhen((current) => current.entries.at(-1)?.type === 'prompt', 't2')
    const nav = await navigate(session, 'data:text/html,<title>dialog-after-nav</title><p>after</p>', 'load', { tab_id: 't2' })
    const after = await dialogEntries(session, DIALOG_LIMIT_DEFAULT, 't2')
    check('navigate 清空旧文档的对话框记录且保留策略',
      before.entries.at(-1).accepted === true && before.entries.at(-1).message === '请输入名称'
      && nav.title === 'dialog-after-nav'
      && after.total === 0 && after.count === 0
      && after.text === '（暂无对话框记录）'
      && after.policy === 'accept' && after.promptText === '导航文本',
      JSON.stringify({ before: before.entries.length, nav, after }))
  }

  console.log('== 用例 18：beforeunload 一律接受 ==')
  {
    await setDialogPolicy(session, 'dismiss', undefined, 't2')
    await navigate(session, dataUrl(BEFOREUNLOAD_FIXTURE), 'load', { tab_id: 't2' })
    await click(session, { selector: '#gesture' }, 't2')
    const nav = await navigate(session, 'data:text/html,<title>dialog-after-unload</title><p>after</p>', 'load', { tab_id: 't2' })
    const info = await readWhen((current) => current.entries.some((entry) => entry.type === 'beforeunload'), 't2')
    const record = info.entries.find((entry) => entry.type === 'beforeunload')
    check('beforeunload 与策略无关一律接受并记录',
      nav.title === 'dialog-after-unload'
      && Boolean(record) && record.accepted === true && record.error === ''
      && record.defaultValue === '' && typeof record.message === 'string'
      && info.policy === 'dismiss',
      JSON.stringify({ nav, record, policy: info.policy }))
  }
} catch (error) {
  fail += 1
  console.log(`  FAIL  用例执行异常 —— ${error?.stack ?? error}`)
} finally {
  await closeAll()
  const settled = await waitUntil(() => edgeRootCount() === baseline, 15000, 250)
  console.log('')
  console.log(`结果：PASS ${pass} / FAIL ${fail}`)
  console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（基线 ${baseline}）${settled ? '' : '（未回落）'}`)
  process.exit(fail === 0 && settled ? 0 : 1)
}
