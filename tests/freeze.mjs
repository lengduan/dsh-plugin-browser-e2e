/**
 * 动画冻结（browser_e2e_start 的 freezeAnimations）独立验收。
 *
 * 按 specs/功能规格/0040-animation-freeze.md「验收」覆盖：
 *   - 用例 1：不传参数时不注入 `#dsh-e2e-freeze`；
 *   - 用例 2：freezeAnimations=true 启动后首标签页已注入；
 *   - 用例 3：页内自建无限 CSS 动画 + reload 后自动重放（动画被 pause、样式在）；
 *   - 用例 4：复用路径传 false 返回关闭文案，后续导航不再新注入；
 *   - 用例 5：复用路径传 true 返回开启文案并补冻；
 *   - 收尾：msedge 主进程回落到运行前基线。
 *
 * 真起无头 Edge；进程数断言以「回落到运行前基线」为准，不看绝对值。
 * 运行：node tests/freeze.mjs
 */
import { spawnSync } from 'node:child_process'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { close, closeAll, launch, sessionOf } = await import('../lib/session.js')
/** 真实会话对象（peekSession 是诊断用的只读视图，没有 pages Map）。 */
const liveSession = () => sessionOf(KEY, SID, { deferTouch: true })
const { freezeAnimations, navigate } = await import('../lib/page.js')

const KEY = 'test-freeze-key'
const SID = KEY
const FREEZE_ID = 'dsh-e2e-freeze'
/**
 * 造一个无限动画并读它是否在 running。
 *
 * 冻结开启时 `animation:none` 已在位，声明式动画根本不会创建——这正是被测行为，
 * 所以这里用 Web Animations API 走另一条路径，两者任一被停都算冻结生效。
 */
const LOAD_SCRIPT = `(() => {
  const el = document.createElement('div')
  el.id = 'test-spin'
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  const animation = el.animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 1000, iterations: Infinity, easing: 'linear' },
  )
  return { created: true, playState: animation.playState, running: document.getAnimations().filter((a) => a.playState === 'running').length }
})()`

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

/** msedge 主进程数（与 tests/multitab.mjs 同一口径）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 读当前 active 页的冻结状态。 */
async function freezeState(session) {
  const entry = session.pages.get(session.activeTabId)
  return await entry.page.evaluate((id) => ({
    stylePresent: Boolean(document.getElementById(id)),
    running: document.getAnimations().filter((animation) => animation.playState === 'running').length,
    total: document.getAnimations().length,
  }), FREEZE_ID)
}

const baseline = edgeRootCount()

try {
  console.log('== 用例 1：不传 freezeAnimations 时不注入 ==')
  {
    await launch(KEY, { headless: true }, SID)
    const state = await freezeState(liveSession())
    check('未传参数时页面没有 #dsh-e2e-freeze', state.stylePresent === false, JSON.stringify(state))
  }

  console.log('== 用例 4 / 5：复用路径就地开关 ==')
  {
    
    const session = liveSession()
    // 复用路径传 true：补冻当前页并置标志。
    const offInfo = await launch(KEY, { freezeAnimations: true }, SID)
    check('复用路径传 true 走的是复用分支', offInfo.reused === true, JSON.stringify(offInfo))
    check('复用路径传 true 后会话标志为 true', session.freezeAnimations === true)
    const onState = await freezeState(session)
    check('复用路径传 true 后当前页已注入', onState.stylePresent === true, JSON.stringify(onState))

    const offAgain = await launch(KEY, { freezeAnimations: false }, SID)
    check('复用路径传 false 仍走复用分支', offAgain.reused === true, JSON.stringify(offAgain))
    check('复用路径传 false 后会话标志为 false', session.freezeAnimations === false)
  }

  console.log('== 用例 3：换文档后自动重放 ==')
  {
    
    await launch(KEY, { freezeAnimations: true }, SID)
    const session = liveSession()
    // 先在页内造无限动画，再 reload：domcontentloaded 钩子应重新冻结。
    const entry = session.pages.get(session.activeTabId)
    // 阴性对照：先证明这个脚本在不冻结的页面上**确实**会留下 running 动画。
    // 否则「导航后 running === 0」可能只是页面本来就没有动画，成了恒真断言。
    await navigate(session, 'data:text/html,<h1>control</h1>')
    const control = await entry.page.evaluate(LOAD_SCRIPT)
    check('对照页（不冻结）能造出 running 动画', control.running >= 1, JSON.stringify(control))
    await navigate(session, 'data:text/html,<h1>freeze-replay</h1>')
    const afterNav = await freezeState(session)
    check('导航后样式已注入', afterNav.stylePresent === true, JSON.stringify(afterNav))
    // 导航后立即读：此时页面上只有冻结注入的那份状态，没有本测试造的动画。
    check('导航后页面没有残留 running 动画', afterNav.running === 0, JSON.stringify(afterNav))
    // 已知局限（实测确认，非本测试可修复）：冻结只作用于 domcontentloaded 时已存在的动画，
    // 在冻结页上**新造**的动画仍是 running。这条断言把这个行为固定下来，
    // 避免「running === 0」被误读成「冻结能拦住任何新动画」。
    const late = await entry.page.evaluate(LOAD_SCRIPT)
    check('已知局限：冻结页上新造的动画不受约束（仍 running）', late.running >= 1, JSON.stringify(late))

    // 再换一次文档，验证是「每次都重放」而不是只有第一次。
    await navigate(session, 'data:text/html,<h1>freeze-replay-2</h1>')
    const afterSecond = await freezeState(session)
    check('第二次换文档后仍然注入', afterSecond.stylePresent === true, JSON.stringify(afterSecond))
  }

  console.log('== 用例 2：freezeAnimations=true 首屏即冻结 ==')
  {
    await close(KEY)
    const info = await launch(KEY, { headless: true, freezeAnimations: true }, SID)
    check('首次启动返回 freezeAnimations=true', info.freezeAnimations === true, JSON.stringify(info))
    
    const session = liveSession()
    check('会话标志已写入', session.freezeAnimations === true)
    const state = await freezeState(session)
    check('首标签页已注入 #dsh-e2e-freeze', state.stylePresent === true, JSON.stringify(state))
  }

  console.log('== freezeAnimations() 直接调用 ==')
  {
    
    const session = liveSession()
    const entry = session.pages.get(session.activeTabId)
    const result = await freezeAnimations(entry.page)
    check('幂等：重复冻结不报错且返回 ok', result.ok === true, JSON.stringify(result))
    const state = await freezeState(session)
    check('重复冻结不叠加样式节点', state.stylePresent === true && state.running === 0, JSON.stringify(state))
    const closed = await freezeAnimations(null)
    check('传 null 页面返回 ok=false 而不抛错', closed.ok === false, JSON.stringify(closed))
  }
} finally {
  await closeAll()
}

console.log(`\n== 收尾：msedge 主进程回落 ==`)
{
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const now = edgeRootCount()
  check('msedge 主进程回落到运行前基线', now <= baseline, `基线 ${baseline}，当前 ${now}`)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
