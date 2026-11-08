/**
 * 工具级权限门控（功能规格 0023）验收。
 *
 * 纯函数 + 假 ctx：不启动浏览器、不依赖 Edge。覆盖缺省放行、只读拒绝、
 * 脚本开关、配置脏值 fail-closed、工具定性完整性、配置即时生效，
 * 以及「被拒调用不进入 run（不创建会话）」。
 *
 * 运行：node tests/gate.mjs
 */
import { apply } from '../lib/index.js'
import { activeSessionKeys } from '../lib/session.js'
import { buildToolTable } from '../lib/tools.js'
import {
  ACCESS_KINDS,
  accessModeOf,
  accessOf,
  allowScriptOf,
  decide,
  effectiveAccess,
} from '../lib/gate.js'

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

function errorOf(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function asyncErrorOf(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const toolTable = buildToolTable({ ctx: {}, launchDefaults: () => ({}) })
const byName = new Map(toolTable.map((definition) => [definition.name, definition]))
const observeNames = toolTable.filter((d) => accessOf(d) === 'observe').map((d) => d.name)
const interactNames = toolTable.filter((d) => accessOf(d) === 'interact').map((d) => d.name)
const scriptNames = toolTable.filter((d) => accessOf(d) === 'script').map((d) => d.name)

/** 独立注册表 + 假 ctx：apply 一次，拿到每个工具的 execute。 */
function makeRegistry(config) {
  const defs = new Map()
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    on: () => () => {},
    effect: (factory) => { factory(); return () => {} },
    logger: () => ({ warn: () => {} }),
  }
  apply(ctx, config)
  return defs
}

const EXEC = { agent: { id: 'gate-test' } }
// 被拒调用不进入 run 的断言用独立会话 id：放行用例会建立会话条目，不能混用。
const DENY_EXEC = { agent: { id: 'gate-denied' } }

console.log('== 用例 1：纯函数归一 ==')
check('accessMode 缺失按 full', accessModeOf(undefined).mode === 'full' && accessModeOf(undefined).illegal === false)
check('accessMode 合法值原样', accessModeOf('readonly').mode === 'readonly' && accessModeOf('full').mode === 'full')
check('accessMode 非法值按 readonly 并标记 illegal',
  accessModeOf('readonly-ish').mode === 'readonly' && accessModeOf('readonly-ish').illegal === true)
check('allowScript 缺失按 true', allowScriptOf(undefined).allowScript === true && allowScriptOf(undefined).illegal === false)
check('allowScript 合法值原样', allowScriptOf(false).allowScript === false && allowScriptOf(true).allowScript === true)
check('allowScript 非法值按 false 并标记 illegal',
  allowScriptOf('yes').allowScript === false && allowScriptOf('yes').illegal === true)
check('缺 access 的工具按 interact', accessOf({}) === 'interact' && accessOf({ access: 'unknown' }) === 'interact')

console.log('== 用例 2：工具定性完整 ==')
check('工具表的每个工具都有合法 access',
  toolTable.every((definition) => ACCESS_KINDS.includes(definition.access)),
  JSON.stringify(toolTable.filter((d) => !ACCESS_KINDS.includes(d.access)).map((d) => d.name)))
check('定性分布非空且 observe / interact / script 都有',
  observeNames.length > 0 && interactNames.length > 0 && scriptNames.length === 1,
  JSON.stringify({ observe: observeNames.length, interact: interactNames.length, script: scriptNames.length }))
check('evaluate 是唯一的 script 类工具', scriptNames[0] === 'browser_e2e_evaluate', JSON.stringify(scriptNames))
check('wait 默认是 observe，带 expression 时升级为 script',
  accessOf(byName.get('browser_e2e_wait')) === 'observe'
  && effectiveAccess(byName.get('browser_e2e_wait'), { expression: '1 + 1' }) === 'script'
  && effectiveAccess(byName.get('browser_e2e_wait'), { selector: '#a' }) === 'observe')

console.log('== 用例 3：缺省配置全部放行 ==')
{
  const defs = makeRegistry(undefined)
  const rejected = []
  for (const name of [...interactNames, ...scriptNames]) {
    const message = await asyncErrorOf(() => defs.get(name).execute({}, EXEC))
    // 放行后进入 run：未启动浏览器时会报「尚未启动」，不是门控文案。
    if (message !== null && /只读模式|脚本求值已关闭/.test(message)) rejected.push(name)
  }
  check('缺省配置下 interact / script 工具都不被门控拒绝', rejected.length === 0, JSON.stringify(rejected))
  check('缺省配置下 accessMode 为 full / allowScript 为 true',
    accessModeOf(undefined).mode === 'full' && allowScriptOf(undefined).allowScript === true)
}

console.log('== 用例 4：只读模式 ==')
{
  const defs = makeRegistry({ accessMode: 'readonly' })
  const interactRejected = []
  for (const name of interactNames) {
    const message = await asyncErrorOf(() => defs.get(name).execute({}, DENY_EXEC))
    if (typeof message === 'string' && /只读模式（插件设置 accessMode=readonly）/.test(message)) interactRejected.push(name)
  }
  check(`readonly 拒绝全部 interact 工具（${interactNames.length} 个）`,
    interactRejected.length === interactNames.length,
    JSON.stringify(interactNames.filter((n) => !interactRejected.includes(n))))

  const observeEntered = []
  for (const name of observeNames) {
    const message = await asyncErrorOf(() => defs.get(name).execute({}, EXEC))
    // observe 放行后进入 run，报的必然不是门控文案。
    if (!(typeof message === 'string' && /只读模式（插件设置 accessMode=readonly）/.test(message))) observeEntered.push(name)
  }
  check(`readonly 放行全部 observe 工具（${observeNames.length} 个）`,
    observeEntered.length === observeNames.length,
    JSON.stringify(observeNames.filter((n) => !observeEntered.includes(n))))

  const evaluateMessage = await asyncErrorOf(() => defs.get('browser_e2e_evaluate').execute({ expression: '1 + 1' }, DENY_EXEC))
  check('readonly 拒绝 evaluate', typeof evaluateMessage === 'string' && evaluateMessage.includes('accessMode=readonly'), String(evaluateMessage))

  const waitExprMessage = await asyncErrorOf(() => defs.get('browser_e2e_wait').execute({ expression: '1 + 1' }, DENY_EXEC))
  check('readonly 拒绝 wait 的 expression 条件',
    typeof waitExprMessage === 'string' && waitExprMessage.includes('不接受 expression 条件'), String(waitExprMessage))

  const waitSelectorMessage = await asyncErrorOf(() => defs.get('browser_e2e_wait').execute({ selector: '#a' }, EXEC))
  check('readonly 下 wait 的 selector 条件放行',
    !(typeof waitSelectorMessage === 'string' && /只读模式/.test(waitSelectorMessage)), String(waitSelectorMessage))

  const clickMessage = await asyncErrorOf(() => defs.get('browser_e2e_click').execute({ selector: '#a' }, DENY_EXEC))
  check('拒绝文案含工具名 accessMode=readonly 与可用工具清单',
    typeof clickMessage === 'string' && clickMessage.includes('browser_e2e_click')
      && clickMessage.includes('accessMode=readonly') && clickMessage.includes('browser_e2e_snapshot'), String(clickMessage))

  check('被拒调用不进入 run（不创建会话）', !activeSessionKeys().includes('gate-denied'), JSON.stringify(activeSessionKeys()))
}

console.log('== 用例 5：脚本开关 ==')
{
  const offDefs = makeRegistry({ allowScript: false })
  const evaluateMessage = await asyncErrorOf(() => offDefs.get('browser_e2e_evaluate').execute({ expression: '1' }, EXEC))
  check('full + allowScript=false 拒绝 evaluate',
    typeof evaluateMessage === 'string' && evaluateMessage.includes('allowScript=false'), String(evaluateMessage))
  const waitExprMessage = await asyncErrorOf(() => offDefs.get('browser_e2e_wait').execute({ expression: '1' }, EXEC))
  check('full + allowScript=false 拒绝 wait 的 expression 条件',
    typeof waitExprMessage === 'string' && waitExprMessage.includes('allowScript=false'), String(waitExprMessage))
  const clickMessage = await asyncErrorOf(() => offDefs.get('browser_e2e_click').execute({ selector: '#a' }, EXEC))
  check('full + allowScript=false 时 click 仍放行',
    !(typeof clickMessage === 'string' && /allowScript=false/.test(clickMessage)), String(clickMessage))

  const onDefs = makeRegistry({ allowScript: true })
  const onMessage = await asyncErrorOf(() => onDefs.get('browser_e2e_evaluate').execute({ expression: '1' }, EXEC))
  check('full + allowScript=true 放行 evaluate',
    !(typeof onMessage === 'string' && /allowScript=false/.test(onMessage)), String(onMessage))
}

console.log('== 用例 6：配置脏值 fail-closed ==')
{
  const modeDefs = makeRegistry({ accessMode: 'readonly-ish' })
  const modeMessage = await asyncErrorOf(() => modeDefs.get('browser_e2e_click').execute({ selector: '#a' }, EXEC))
  check('accessMode 非法值按 readonly 处理',
    typeof modeMessage === 'string' && modeMessage.includes('只读模式'), String(modeMessage))

  const scriptDefs = makeRegistry({ allowScript: 1 })
  const scriptMessage = await asyncErrorOf(() => scriptDefs.get('browser_e2e_evaluate').execute({ expression: '1' }, EXEC))
  check('allowScript 非法值按 false 处理',
    typeof scriptMessage === 'string' && scriptMessage.includes('allowScript=false'), String(scriptMessage))
}

console.log('== 用例 7：配置即时生效 ==')
{
  const config = { accessMode: 'readonly', allowScript: true }
  const defs = makeRegistry(config)
  const before = await asyncErrorOf(() => defs.get('browser_e2e_click').execute({ selector: '#a' }, EXEC))
  config.accessMode = 'full'
  const after = await asyncErrorOf(() => defs.get('browser_e2e_click').execute({ selector: '#a' }, EXEC))
  check('改配置后下一次调用即按新值判定（无需重启）',
    typeof before === 'string' && before.includes('只读模式')
      && !(typeof after === 'string' && /只读模式/.test(after)), `${before} / ${after}`)
}

console.log('== 用例 8：decide 纯函数直判 ==')
{
  const click = byName.get('browser_e2e_click')
  const denied = decide({ definition: click, args: {}, accessMode: 'readonly', allowScript: true, observeNames })
  const allowed = decide({ definition: click, args: {}, accessMode: 'full', allowScript: true, observeNames })
  check('decide 只读拒绝 interact 且给出一句话摘要',
    denied.allowed === false && typeof denied.summary === 'string' && denied.summary.includes('browser_e2e_click'), JSON.stringify(denied))
  check('decide 全权放行 interact', allowed.allowed === true)
  const waitDef = byName.get('browser_e2e_wait')
  check('decide 把 wait + expression 当脚本拒绝',
    decide({ definition: waitDef, args: { expression: '1' }, accessMode: 'full', allowScript: false, observeNames }).allowed === false)
}

console.log(`\n结果：PASS ${pass}，FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
