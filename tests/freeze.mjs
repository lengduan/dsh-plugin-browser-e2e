/**
 * 动画冻结与动态守护（browser_e2e_start 的 freezeAnimations）独立验收。
 *
 * 按 specs/功能规格/0040-animation-freeze.md「验收」覆盖：
 *   - 用例 1：不传参数时不注入 `#dsh-e2e-freeze`；
 *   - 用例 2：freezeAnimations=true 启动后首标签页已注入；
 *   - 用例 3：换文档后自动重装 + 阴性对照 + **后建动画被守护收掉**（原「已知局限」已反转为断言）；
 *   - 用例 4 / 5：复用路径就地开关（关闭是真撤守）与开启文案；
 *   - 用例 6：裁决补充 C 的五条（后插 !important / 后建 WAAPI / 阴性对照 / 真撤守 / 换文档四路）；
 *     reload 一路**不得**手工装机（那会把「自动重装」证明成「手工装机有效」，断言恒真）；
 *     找不到 Edge 时该路记 SKIP 而不是 PASS（跳过不算通过）；
 *   - 收尾：msedge 主进程回落到运行前基线。
 *
 * 真起无头 Edge；进程数断言以「回落到运行前基线」为准，不看绝对值。
 * 运行：node tests/freeze.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { close, closeAll, launch, sessionOf } = await import('../lib/session.js')
/** 真实会话对象（peekSession 是诊断用的只读视图，没有 pages Map）。 */
const liveSession = () => sessionOf(KEY, SID, { deferTouch: true })
const { navigate, currentTab } = await import('../lib/page.js')
const { installAnimationGuard, uninstallAnimationGuard, animationGuardState } = await import('../lib/animation-guard.js')

const KEY = 'test-freeze-key'
const SID = KEY
/** CDP 接管那一路用独立会话 key：与隔离会话分开，避免模式热切换报错。 */
const CDP_KEY = 'test-freeze-cdp-key'
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

/**
 * 换文档后一次性读「自动重装证据」并造一个动画验证它被拦住。
 *
 * 不调任何装机函数：这个脚本本身只读，样式与 patch 是否存在完全取决于 addInitScript 有没有生效。
 * 返回值同时给 stylePresent / animateIsNative / running / playState，便于一次求值断言多条。
 */
const RELOAD_STATE_SCRIPT = `(() => {
  const el = document.createElement('div')
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  const animation = el.animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 1000, iterations: Infinity, easing: 'linear' },
  )
  return {
    stylePresent: Boolean(document.getElementById('dsh-e2e-freeze')),
    sentinel: Boolean(window.__dshE2eAnimGuard),
    animateIsNative: /\\[native code\\]/.test(String(Element.prototype.animate)),
    playState: animation.playState,
    running: document.getAnimations().filter((a) => a.playState === 'running').length,
  }
})()`

/** 只数 running 动画，不造动画也不改页面（用于「查询无副作用」断言）。 */
const COUNT_RUNNING_SCRIPT = `(() => ({
  running: document.getAnimations().filter((a) => a.playState === 'running').length,
}))()`

/** 页面自插一条更高优先级的 !important 样式，再挂一个带 class 动画的元素（裁决补充 C 第 1 条）。 */
const STYLE_INJECT_SCRIPT = `(() => {
  const style = document.createElement('style')
  style.textContent = '#late-spin{animation:late-spin-kf 1s linear infinite!important}'
    + '@keyframes late-spin-kf{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
  ;(document.head || document.documentElement).appendChild(style)
  const el = document.createElement('div')
  el.id = 'late-spin'
  el.style.width = '10px'
  el.style.height = '10px'
  document.body.appendChild(el)
  return { running: document.getAnimations().filter((a) => a.playState === 'running').length }
})()`

/** 一个最小的稳定页面：served 给 reload / recipe-goto / cdp 三路换文档用。 */
const PAGE_HTML = '<!doctype html><html><head><title>freeze-fixture</title></head><body><h1>freeze-fixture</h1></body></html>'

/** 阴性对照结果（用例 1 采，用例 3 复用同一份证据，避免重复造第二份对照）。 */
let negativeControl = null

let pass = 0
let fail = 0
/**
 * 跳过计数：SKIP 不得记成 PASS。
 *
 * 以前的写法是 `check('...SKIP...', true)`，无条件进 PASS 计数——那条断言永远不会失败，
 * 而且混在 37 里根本看不出来。现在 SKIP 单独累加并在结尾单列，与通过 / 失败分开看。
 */
let skip = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
/** 记一条跳过：不进 pass、不算成功，只在结尾单列。 */
function checkSkip(label, why) {
  skip += 1
  console.log(`  SKIP  ${label}${why ? ` —— ${why}` : ''}`)
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

const { requireSession } = await import('../lib/session.js')

/**
 * 换文档第 4 路（CDP 接管）的夹具：真起一个带远程调试端口的 Edge，让插件接管。
 *
 * 与 tests/cdp.mjs 同一手法：系统 Edge + `--remote-debugging-port` + 一次性 user-data-dir。
 * 页面在拉起时就指向夹具 URL，因此接管时它**早已 load 完**——这正是「不会再触发 domcontentloaded」的场景，
 * 只能靠 `installAdoptedGuards` 补装。
 * @param {string} url - 接管页的初始地址
 * @returns {Promise<null | {state: object}>} 找不到 Edge 时返回 null（测试降级为 SKIP，不假通过）
 */
async function captureAdoptedPage(url) {
  const edgePath = resolveEdgePath()
  if (edgePath === null) return null
  const port = await pickPort()
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-freeze-cdp-'))
  const child = spawn(edgePath, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, url,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  ], { stdio: 'ignore' })
  cdpRetrofit.child = child
  cdpRetrofit.userDataDir = userDataDir
  try {
    const ready = await waitForDevTools(port)
    if (!ready) throw new Error('CDP 端点未就绪')
    const info = await launch(CDP_KEY, { mode: 'cdp', cdpEndpoint: `http://127.0.0.1:${port}`, freezeAnimations: true }, CDP_KEY)
    const session = requireSession(CDP_KEY)
    const entry = session.pages.get(session.activeTabId)
    const state = await entry.page.evaluate((source) => ({
      loaded: true,
      docState: document.readyState,
      guard: { stylePresent: Boolean(document.getElementById('dsh-e2e-freeze')) },
      after: eval(source),
    }), LOAD_SCRIPT)
    return { state, launched: info }
  } finally {
    await close(CDP_KEY)
  }
}

/** CDP 夹具的收尾：关浏览器进程、删一次性 user-data-dir。 */
const cdpRetrofit = {
  child: null,
  userDataDir: '',
  async close() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill()
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (this.userDataDir && existsSync(this.userDataDir)) {
      try { rmSync(this.userDataDir, { recursive: true, force: true }) } catch { /* 占用时留待系统清理 */ }
    }
    this.child = null
    this.userDataDir = ''
  },
}

/** 等一个 sweep 周期（250ms）再多给 50ms 余量：后插 !important 靠周期复查才收得掉。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ONE_SWEEP_MS = 300

/** 本地 HTTP 夹具：reload / recipe-goto / CDP 接管三路换文档都要一个真实可重载的源。 */
let fixtureServer = null
let fixtureUrl = ''
async function serveFixture() {
  if (fixtureServer) return fixtureUrl
  fixtureServer = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE_HTML)
  })
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`
  return fixtureUrl
}
async function closeFixture() {
  if (!fixtureServer) return
  const server = fixtureServer
  fixtureServer = null
  await new Promise((resolve) => server.close(resolve))
}

/** 系统 Edge 路径（与 tests/cdp.mjs 同一批候选）。 */
function resolveEdgePath() {
  if (process.env.EDGE_PATH && existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** 轮询 DevTools HTTP 端点，等浏览器就绪（与 tests/cdp.mjs 同一手法）。 */
function waitForDevTools(port, timeoutMs = 20000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const probe = () => {
      const req = get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve(true)
        else retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) resolve(false)
      else setTimeout(probe, 250)
    }
    probe()
  })
}

/** 找一个当前空闲的 loopback 端口（与 tests/cdp.mjs 同一手法）。 */
function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const baseline = edgeRootCount()

try {
  console.log('== 用例 1：不传 freezeAnimations 时不注入 ==')
  {
    const info = await launch(KEY, { headless: true }, SID)
    const state = await freezeState(liveSession())
    check('未传参数时页面没有 #dsh-e2e-freeze', state.stylePresent === false, JSON.stringify(state))
    // 阴性对照的**唯一正确位置**：会话开关为 false 时跑同一段造动画脚本。
    // 不能像旧版那样「在冻结会话里换个页」当对照——守护的 addInitScript 会随换文档无条件重装，
    // 那样造出来的动画仍被 pause，「对照」就成了假对照。
    const entry = liveSession().pages.get(liveSession().activeTabId)
    negativeControl = await entry.page.evaluate(LOAD_SCRIPT)
    check('阴性对照（未开守护）：同一段造动画脚本留下 running >= 1',
      negativeControl.running >= 1, JSON.stringify(negativeControl) + ' ' + JSON.stringify(info.summary))
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
    // 阴性对照：复用用例 1 在「会话开关为 false」时采到的同一份证据。
    // 否则「导航后 running === 0」可能只是页面本来就没有动画，成了恒真断言。
    check('对照页（不冻结）能造出 running 动画', negativeControl !== null && negativeControl.running >= 1,
      JSON.stringify(negativeControl))
    await navigate(session, 'data:text/html,<h1>freeze-replay</h1>')
    const afterNav = await freezeState(session)
    check('导航后样式已注入', afterNav.stylePresent === true, JSON.stringify(afterNav))
    // 导航后立即读：此时页面上只有冻结注入的那份状态，没有本测试造的动画。
    check('导航后页面没有残留 running 动画', afterNav.running === 0, JSON.stringify(afterNav))
    // 原「已知局限：冻结页上新造的动画不受约束」已在守护实现后反转：
    // 冻结页上新造的 WAAPI 动画必须当场被拦住（animate patch 在返回前 pause）。
    const late = await entry.page.evaluate(LOAD_SCRIPT)
    check('守护后 running === 0：冻结页上新造的 WAAPI 动画被当场拦住', late.running === 0, JSON.stringify(late))
    check('新造 WAAPI 返回对象的 playState 为 paused', late.playState === 'paused', JSON.stringify(late))

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

  console.log('== 动画守护能力函数直接调用 ==')
  {
    const session = liveSession()
    const entry = session.pages.get(session.activeTabId)
    const result = await installAnimationGuard(entry.page)
    check('幂等：重复装机不报错且返回 ok', result.ok === true, JSON.stringify(result))
    const state = await freezeState(session)
    check('重复装机不叠加样式节点', state.stylePresent === true && state.running === 0, JSON.stringify(state))
    const closed = await installAnimationGuard(null)
    check('传 null 页面返回 ok=false 而不抛错', closed.ok === false, JSON.stringify(closed))
    // animationGuardState 是**只读诊断**：只保证样式在位（自愈），绝不暂停动画、也不替调用方装机。
    const runningBefore = await entry.page.evaluate(COUNT_RUNNING_SCRIPT)
    const queried = await animationGuardState(entry.page)
    const runningAfter = await entry.page.evaluate(COUNT_RUNNING_SCRIPT)
    check('animationGuardState 只读查询：返回 ok 且已装', queried.ok === true && queried.installed === true, JSON.stringify(queried))
    check('animationGuardState 查询前后 running 数不变（无暂停副作用）',
      runningAfter.running === runningBefore.running,
      JSON.stringify({ before: runningBefore.running, after: runningAfter.running }))
  }

  console.log('== 用例 6：裁决补充 C 的五条 ==')
  {
    const session = liveSession()
    const entry = session.pages.get(session.activeTabId)
    // C-3 阴性对照：必须**先真正撤守**（撤 addInitScript + 页内状态）再换文档，
    // 否则 domcontentloaded 钩子看到会话开关仍是 true 会把守护装回来，造出假对照。
    const negativeSession = liveSession()
    const offInfo = await launch(KEY, { freezeAnimations: false }, SID)
    check('C-3 前置：复用路径关闭走复用分支并回传统计',
      offInfo.reused === true && offInfo.freezeSwitch?.enabled === false, JSON.stringify(offInfo.freezeSwitch))
    await navigate(negativeSession, 'data:text/html,<h1>c-negative</h1>')
    const negative = await negativeSession.pages.get(negativeSession.activeTabId).page.evaluate(LOAD_SCRIPT)
    check('C-3 阴性对照：真撤守后换文档，同一脚本留下 running >= 1', negative.running >= 1, JSON.stringify(negative))

    // 装回守护（走会话开关，避免只装页内状态而漏掉 addInitScript）。
    const onInfo = await launch(KEY, { freezeAnimations: true }, SID)
    check('C 前置：重新开启走复用分支并回传装机统计',
      onInfo.reused === true && onInfo.freezeSwitch?.enabled === true && onInfo.freezeSwitch?.installed >= 1,
      JSON.stringify(onInfo.freezeSwitch))
    await navigate(session, 'data:text/html,<h1>c-guard</h1>')
    const guarded = await freezeState(session)
    check('C 前置：守护已装机且样式在位', guarded.stylePresent === true, JSON.stringify(guarded))

    // C-1 页面自插 !important 样式：靠 250ms 周期复查收掉，等一个周期再读。
    const injected = await entry.page.evaluate(STYLE_INJECT_SCRIPT)
    check('C-1 前置：页面自插 !important 后确有 running 动画', injected.running >= 1, JSON.stringify(injected))
    await sleep(ONE_SWEEP_MS)
    const afterSweep = await freezeState(session)
    check('C-1 页面自插 !important 样式后，等一个 sweep 周期 running === 0', afterSweep.running === 0, JSON.stringify(afterSweep))

    // C-2 后建 WAAPI：调用返回即被 pause。
    const waapi = await entry.page.evaluate(LOAD_SCRIPT)
    check('C-2 守护开启后新造 WAAPI running === 0', waapi.running === 0, JSON.stringify(waapi))
    check('C-2 新造 WAAPI 返回对象 playState 为 paused', waapi.playState === 'paused', JSON.stringify(waapi))

    // C-4 关闭开关 = 真撤守：撤掉 addInitScript 与页内状态后，换文档也不再重装。
    const info = await launch(KEY, { freezeAnimations: false }, SID)
    check('C-4 复用路径关闭走复用分支并回传开关统计', info.reused === true && info.freezeSwitch?.enabled === false, JSON.stringify(info.freezeSwitch))
    await navigate(session, 'data:text/html,<h1>c-closed</h1>')
    const closedState = await freezeState(session)
    check('C-4 关闭后换文档不再装样式（addInitScript 已撤）', closedState.stylePresent === false, JSON.stringify(closedState))
    const revived = await entry.page.evaluate(LOAD_SCRIPT)
    check('C-4 关闭后同一脚本 running >= 1（真撤守，不是只改标志）', revived.running >= 1, JSON.stringify(revived))

    // C-5 换文档四路：navigate / reload / recipe 内 goto / CDP 接管。
    const fileUrl = await serveFixture()
    try {
      await launch(KEY, { freezeAnimations: true }, SID)
      // 路 1：navigate
      await navigate(session, fileUrl)
      const navPath = await entry.page.evaluate(LOAD_SCRIPT)
      check('C-5 换文档第 1 路 navigate：守护自动重装且 running === 0', navPath.running === 0, JSON.stringify(navPath))
      // 路 2：reload（页面自刷新，不经过 navigate）。
      // 这里**绝不**手工调 installAnimationGuard：那证明的是「手工装机有效」而不是「自动重装」，
      // 断言会变成恒真。reload 后能不能有样式与 patch，全靠 addInitScript 自己生效。
      await entry.page.reload({ waitUntil: 'domcontentloaded' })
      const reloadPath = await entry.page.evaluate(RELOAD_STATE_SCRIPT)
      check('C-5 换文档第 2 路 reload【无手工装机】：样式自动回来', reloadPath.stylePresent === true, JSON.stringify(reloadPath))
      check('C-5 换文档第 2 路 reload【无手工装机】：原型已被自动 patch', reloadPath.animateIsNative === false, JSON.stringify(reloadPath))
      check('C-5 换文档第 2 路 reload【无手工装机】：新造动画 running === 0', reloadPath.running === 0, JSON.stringify(reloadPath))
      check('C-5 换文档第 2 路 reload【无手工装机】：新造动画 playState === paused', reloadPath.playState === 'paused', String(reloadPath.playState))
      // 路 3：recipe 内 goto（走 page.js 的 navigate，recipe.js 零改动）
      const { runRecipe } = await import('../lib/recipe.js')
      await runRecipe(session, { steps: [{ type: 'navigate', url: fileUrl }, { type: 'wait', selector: 'h1' }] }, { tabId: entry.id })
      const recipePath = await entry.page.evaluate(LOAD_SCRIPT)
      check('C-5 换文档第 3 路 recipe 内 goto：守护自动重装且 running === 0', recipePath.running === 0, JSON.stringify(recipePath))
      // 路 4：CDP 真接管。接管页早已 load 完、不会再触发 domcontentloaded，只能靠 installAdoptedGuards 补装。
      // 断言拆两条：接管页已真实 load 完成（证明「不会触发 domcontentloaded」这个前提成立），
      // 且补装后 running === 0（证明补装路径真的生效）。
      const cdp = await captureAdoptedPage(fileUrl)
      try {
        if (cdp === null) {
          // 只有 resolveEdgePath() 真的返回 null 才会走到这里（captureAdoptedPage 的唯一 null 出口）。
          // 用 checkSkip 而不是 check(..., true)：跳过不是通过，不能混进 PASS 计数掩盖覆盖率。
          checkSkip('C-5 换文档第 4 路 CDP 接管', '本机找不到 Edge 可执行文件（设置 EDGE_PATH 后可跑，见 tests/cdp.mjs 同一口径）')
        } else {
          check('C-5 第 4 路前置：接管页已 load 完成（不会再触发 domcontentloaded）',
            cdp.state.loaded === true && cdp.state.docState === 'complete', JSON.stringify(cdp.state))
          check('C-5 换文档第 4 路 CDP 接管补装后 running === 0',
            cdp.state.guard.stylePresent === true && cdp.state.after.running === 0, JSON.stringify(cdp.state))
        }
      } finally {
        await cdpRetrofit.close()
      }
    } finally {
      await closeFixture()
    }
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

console.log(`\n通过 ${pass}，失败 ${fail}，跳过 ${skip}`)
process.exit(fail === 0 ? 0 : 1)
