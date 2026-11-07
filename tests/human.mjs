/**
 * browser_e2e_captcha_check / browser_e2e_wait_for_human 独立验收：覆盖
 * specs/功能规格/0029-human-wait-captcha.md「验收」的全部用例，另补边界：
 * 五类结构检测的优先级、文本短语兜底、loopback 跳过文本检测、textScan=false、
 * 检测工具页面不可读时的固定文案、等待工具的字段与摘要口径、完成信号、
 * 导航期间探针失败不中断等待、标签页关闭、并发等待、参数区间与截断。
 *
 * 真起无头 Edge；结构 / 等待类夹具用 127.0.0.1 随机端口的本地 HTTP 服务，
 * 文本兜底与多标签页夹具用 data: URL，不依赖外网。
 * 运行：node tests/human.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, closeTab, launch, requireSession } = await import('../lib/session.js')
const { currentTab, navigate, snapshot } = await import('../lib/page.js')
const { humanCheck, waitForHuman } = await import('../lib/human.js')
const { buildToolTable } = await import('../lib/tools.js')

const KEY = 'test-human-key'
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

/** 把 HTML 包成 data: URL：夹具里含 `#` 选择器，必须编码，否则 `#` 会被当成 URL 片段。 */
function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** 工具表按名字索引；工具层用 run 直接执行，和 index.js 注册后一致。 */
const TOOLS = new Map(buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
  .map((definition) => [definition.name, definition]))

const CLEAN_PAGE = '<!doctype html><html><head><title>clean</title></head><body><h1 id="ok">已完成</h1></body></html>'
const RECAPTCHA_PAGE = '<!doctype html><html><head><title>recaptcha</title></head><body>'
  + '<div class="g-recaptcha" data-sitekey="site-key"></div></body></html>'
// 用 data: URL 做超时夹具：页面不发任何网络请求，便于断言等待不写事件环。
const CAPTCHA_SELECTOR_PAGE = '<!doctype html><html><head><title>captcha-selector</title></head><body>'
  + '<div class="g-recaptcha" data-sitekey="site-key"></div><div id="done">已登录</div></body></html>'

const baseline = edgeRootCount()
// 运行前可能已有别的进程用 Playwright 起过 Edge（例如其他工具），只断言本测试没有新增残留。
const playwrightBaseline = playwrightEdgeRootCount()
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const html = (body, title = path) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
  if (path === '/clean') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<h1 id="ok">已完成</h1>'))
    return
  }
  if (path === '/recaptcha') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<div class="g-recaptcha" data-sitekey="site-key"></div>'))
    return
  }
  if (path === '/loop-text') {
    // loopback 主机名：正文含验证码字样也不做文本兜底。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<p>人机验证 安全验证 请拖动滑块</p>'))
    return
  }
  if (path === '/remove-captcha') {
    // 900ms 后移除验证码：等待应继续轮询，直到验证消失才返回。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<div class="g-recaptcha" data-sitekey="site-key"></div>'
      + '<script>setTimeout(function () { document.querySelector(".g-recaptcha").remove() }, 900)</script>'))
    return
  }
  if (path === '/selector-later') {
    // 800ms 后出现完成信号：无验证码时也要等 selector 出现才返回。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<div id="host"></div>'
      + '<script>setTimeout(function () { var d = document.createElement("div"); d.id = "done"; document.body.appendChild(d) }, 800)</script>'))
    return
  }
  if (path === '/captcha-selector') {
    // 验证码与完成信号同时在场：selector 出现也不能提前 resolved。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<div class="g-recaptcha" data-sitekey="site-key"></div><div id="done">已登录</div>'))
    return
  }
  if (path === '/nav-start') {
    // 400ms 后让探针抛错（模拟登录提交后的导航窗口），3s 后真实导航到无验证码页面：
    // 探针失败只记证据，不能中断等待；新文档可读后仍应正常返回 resolved=true。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<div class="g-recaptcha" data-sitekey="site-key"></div>'
      + '<script>'
      + 'setTimeout(function () { document.querySelector = function () { throw new Error("导航探针不可读") } }, 400);'
      + 'setTimeout(function () { location.href = "/clean" }, 3000);'
      + '</script>'))
    return
  }
  if (path === '/broken-query') {
    // 页面自毁 querySelector：用来验证检测工具「页面不可读」的固定错误文案。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('<h1>broken</h1><script>document.querySelector = function () { throw new Error("页面炸了") }</script>'))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const exec = { agent: { id: KEY } }

try {
  const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, 'test-human-session')
  session = requireSession(KEY)
  console.log('== 准备：启动浏览器 ==')
  check('启动成功', info.reused === false && edgeRootCount() > baseline, JSON.stringify(info))

  console.log('== 检测组 ==')
  {
    // 无验证码：结构未命中、文本无短语，返回空 evidence。
    await navigate(session, dataUrl(CLEAN_PAGE), 'load')
    const none = await humanCheck(session)
    check('captcha 无验证码页面返回 detected=false',
      none.detected === false && none.kind === null && none.evidence === ''
        && none.summary === '人机验证：未检测到'
        && typeof none.url === 'string' && none.tabId === currentTab(session).id,
      JSON.stringify(none))
    const cleanText = await TOOLS.get('browser_e2e_captcha_check').run({}, exec)
    check('检测工具文本：未检测到只有摘要与页面两行',
      cleanText.split('\n').length === 2 && cleanText.startsWith('人机验证：未检测到\n当前页面：'),
      JSON.stringify(cleanText))
  }

  {
    // reCAPTCHA：class 命中，证据是实际命中的单个选择器；只有 data-sitekey 也按 recaptcha 处理。
    await navigate(session, dataUrl(RECAPTCHA_PAGE), 'load')
    const recaptcha = await humanCheck(session)
    check('captcha 识别 recaptcha 并给出 selector 证据',
      recaptcha.detected === true && recaptcha.kind === 'recaptcha'
        && recaptcha.evidence === 'selector: .g-recaptcha'
        && recaptcha.summary === '人机验证：检测到 recaptcha',
      JSON.stringify(recaptcha))
    const text = await TOOLS.get('browser_e2e_captcha_check').run({}, exec)
    check('检测工具文本：检测到时有摘要 / 页面 / 依据三行',
      text.split('\n').length === 3 && text.startsWith('人机验证：检测到 recaptcha\n当前页面：')
        && text.endsWith('依据：selector: .g-recaptcha'),
      JSON.stringify(text))
    await navigate(session, dataUrl('<!doctype html><body><div data-sitekey="only-key"></div></body>'), 'load')
    const sitekeyOnly = await humanCheck(session)
    check('只有 data-sitekey 时按 recaptcha 分类',
      sitekeyOnly.detected === true && sitekeyOnly.kind === 'recaptcha'
        && sitekeyOnly.evidence === 'selector: [data-sitekey]:not(.h-captcha):not(.cf-turnstile)',
      JSON.stringify(sitekeyOnly))
  }

  {
    await navigate(session, dataUrl('<!doctype html><body><div class="h-captcha"></div></body>'), 'load')
    const hcaptcha = await humanCheck(session)
    check('captcha 识别 hcaptcha',
      hcaptcha.detected === true && hcaptcha.kind === 'hcaptcha' && hcaptcha.evidence === 'selector: .h-captcha',
      JSON.stringify(hcaptcha))
  }

  {
    await navigate(session, dataUrl('<!doctype html><body><div class="cf-turnstile" data-sitekey="k"></div></body>'), 'load')
    const turnstile = await humanCheck(session)
    check('captcha 识别 turnstile',
      turnstile.detected === true && turnstile.kind === 'turnstile' && turnstile.evidence === 'selector: .cf-turnstile',
      JSON.stringify(turnstile))
  }

  {
    await navigate(session, dataUrl('<!doctype html><body><form id="challenge-form"></form></body>'), 'load')
    const cloudflare = await humanCheck(session)
    check('captcha 识别 cloudflare 挑战页',
      cloudflare.detected === true && cloudflare.kind === 'cloudflare' && cloudflare.evidence === 'selector: #challenge-form',
      JSON.stringify(cloudflare))
  }

  {
    await navigate(session, dataUrl('<!doctype html><body><div id="captcha">输入验证码</div></body>'), 'load')
    const generic = await humanCheck(session)
    check('captcha 识别通用 captcha',
      generic.detected === true && generic.kind === 'captcha' && generic.evidence === 'selector: #captcha',
      JSON.stringify(generic))
  }

  {
    // data: 页面主机名为空（不是 loopback），文本兜底生效；大小写不敏感。
    await navigate(session, dataUrl('<!doctype html><body><p>请完成安全验证后继续</p></body>'), 'load')
    const textHit = await humanCheck(session)
    check('captcha 文本兜底识别 data: 页面的中文提示',
      textHit.detected === true && textHit.kind === 'captcha'
        && textHit.evidence.startsWith('text: ')
        && textHit.evidence.length <= 'text: '.length + 40
        && textHit.summary === '人机验证：检测到 captcha',
      JSON.stringify(textHit))
    await navigate(session, dataUrl('<!doctype html><body><p>Verify you are human</p></body>'), 'load')
    const englishHit = await humanCheck(session)
    check('文本兜底命中英文短语（大小写不敏感）',
      englishHit.detected === true && englishHit.kind === 'captcha' && englishHit.evidence.includes('Verify you are human'),
      JSON.stringify(englishHit))
  }

  {
    // loopback 页面跳过文本兜底，但结构检测不受影响。
    await navigate(session, `${base}/loop-text`, 'load')
    const loopText = await humanCheck(session)
    check('captcha loopback 页面不做文本兜底',
      loopText.detected === false && loopText.kind === null && loopText.evidence === '',
      JSON.stringify(loopText))
    await navigate(session, `${base}/recaptcha`, 'load')
    const loopStructure = await humanCheck(session)
    check('loopback 页面的结构检测仍然生效',
      loopStructure.detected === true && loopStructure.kind === 'recaptcha',
      JSON.stringify(loopStructure))
  }

  {
    await navigate(session, dataUrl('<!doctype html><body><p>人机验证</p></body>'), 'load')
    const skipped = await humanCheck(session, { textScan: false })
    const scanned = await humanCheck(session, { textScan: true })
    check('captcha textScan=false 时不做文本兜底',
      skipped.detected === false && scanned.detected === true,
      JSON.stringify({ skipped, scanned }))
  }

  {
    // 两个标签页：一个无验证码、一个 reCAPTCHA；按 tab_id 只检测指定页，不看 active。
    await navigate(session, dataUrl(CLEAN_PAGE), 'load')
    const cleanTab = currentTab(session).id
    const captchaTabInfo = await navigate(session, dataUrl(RECAPTCHA_PAGE), 'load', { new_tab: true })
    const captchaTab = captchaTabInfo.tabId
    check('夹具就绪：新增标签页且 active 在验证码页',
      currentTab(session).id === captchaTab && currentTab(session).id !== cleanTab,
      JSON.stringify({ cleanTab, captchaTab, active: currentTab(session).id }))
    const onCaptcha = await humanCheck(session, { tab_id: captchaTab })
    const onClean = await humanCheck(session, { tab_id: cleanTab })
    check('captcha 按 tab_id 只检测指定标签页',
      onCaptcha.detected === true && onCaptcha.tabId === captchaTab
        && onClean.detected === false && onClean.tabId === cleanTab,
      JSON.stringify({ onCaptcha, onClean }))
    const unknown = await expectThrow(() => humanCheck(session, { tab_id: 't99' }))
    check('检测工具未知 tab_id 报既有文案',
      typeof unknown === 'string' && unknown.includes('tab t99 不存在，请先 browser_e2e_tabs 获取最新 tab_id'),
      String(unknown))
    // 只关掉新增的验证码页；cleanTab 是主标签页，留着给后续用例，且最后一页本来也不允许关。
    await closeTab(KEY, captchaTab)
  }

  {
    const unstartedKey = 'test-human-unstarted'
    const captchaNotStarted = await expectThrow(() => TOOLS.get('browser_e2e_captcha_check')
      .run({}, { agent: { id: unstartedKey } }))
    const waitNotStarted = await expectThrow(() => TOOLS.get('browser_e2e_wait_for_human')
      .run({}, { agent: { id: 'test-human-unstarted-wait' } }))
    check('captcha 未启动时报浏览器尚未启动',
      typeof captchaNotStarted === 'string'
        && captchaNotStarted.includes('浏览器尚未启动或没有可用标签页，请先 browser_e2e_start')
        && typeof waitNotStarted === 'string'
        && waitNotStarted.includes('浏览器尚未启动或没有可用标签页，请先 browser_e2e_start'),
      JSON.stringify({ captchaNotStarted, waitNotStarted }))
  }

  {
    await navigate(session, `${base}/broken-query`, 'load')
    const broken = await expectThrow(() => humanCheck(session))
    check('检测工具页面不可读时抛固定文案',
      typeof broken === 'string'
        && broken.startsWith('检测人机验证失败：页面不可读（可能正在导航或已关闭）：')
        && broken.includes('页面炸了')
        && broken.endsWith('；请稍后重试'),
      String(broken))
  }

  console.log('== 等待组 ==')
  {
    await navigate(session, dataUrl(CLEAN_PAGE), 'load')
    const started = Date.now()
    const immediate = await waitForHuman(session, { reason: 'confirm' })
    const elapsed = Date.now() - started
    check('wait_human 无验证码时立即 resolved=true 且 needed=false',
      immediate.resolved === true && immediate.needed === false
        && immediate.polls === 1 && immediate.detected === false && immediate.kind === null
        && immediate.selector === '' && immediate.reason === 'confirm'
        && immediate.timeoutMs === 60000 && immediate.pollMs === 1500
        && immediate.probeErrors === 0 && elapsed < 2000 && immediate.waitedMs < 2000
        && immediate.headless === true && !('hint' in immediate) && !('lastProbeError' in immediate)
        && immediate.tabId === currentTab(session).id
        && immediate.summary === `无需等待：confirm（未检测到人机验证，耗时 ${immediate.waitedMs}ms，轮询 1 次）`,
      JSON.stringify({ immediate, elapsed }))
  }

  {
    await navigate(session, `${base}/remove-captcha`, 'load')
    const removed = await waitForHuman(session, { reason: 'captcha', timeoutMs: 5000, pollMs: 250 })
    check('wait_human 验证码消失后 resolved=true 且 needed=true',
      removed.resolved === true && removed.needed === true && removed.detected === false
        && removed.kind === 'recaptcha' && removed.probeErrors === 0
        && removed.polls >= 2 && removed.waitedMs >= 500
        && removed.summary === `等待人工处理完成：captcha（recaptcha 已消失，耗时 ${removed.waitedMs}ms，轮询 ${removed.polls} 次）`,
      JSON.stringify(removed))
  }

  {
    await navigate(session, `${base}/selector-later`, 'load')
    const text = await TOOLS.get('browser_e2e_wait_for_human').run({
      reason: 'login', selector: '#done', timeoutMs: 5000, pollMs: 250,
    }, exec)
    const lines = text.split('\n')
    check('wait_human selector 作为完成信号',
      lines.length === 3
        && lines[0].startsWith('等待完成：login（未检测到人机验证，完成信号 #done 已出现，耗时 ')
        && /，轮询 \d+ 次）$/.test(lines[0])
        && lines[1].startsWith('当前页面：')
        && lines[2] === '完成信号：#done',
      JSON.stringify(text))
  }

  let timeoutResult = null
  {
    // 验证码与完成信号同时在场：selector 已出现也不能返回 resolved=true，必须等验证消失。
    await navigate(session, dataUrl(CAPTCHA_SELECTOR_PAGE), 'load')
    await snapshot(session)
    const tab = currentTab(session)
    const before = {
      refs: JSON.stringify([...tab.refs.entries()]),
      baselines: JSON.stringify([...tab.snapshotBaselines.entries()].map(([key, value]) => [key, value.version])),
      console: tab.consoleRing.length,
      network: tab.networkRing.length,
      active: session.activeTabId,
    }
    const started = Date.now()
    timeoutResult = await waitForHuman(session, {
      reason: 'login', selector: '#done', timeoutMs: 5000, pollMs: 250, textScan: false,
    })
    const elapsed = Date.now() - started
    const afterTab = currentTab(session)
    const after = {
      refs: JSON.stringify([...afterTab.refs.entries()]),
      baselines: JSON.stringify([...afterTab.snapshotBaselines.entries()].map(([key, value]) => [key, value.version])),
      console: afterTab.consoleRing.length,
      network: afterTab.networkRing.length,
      active: session.activeTabId,
    }
    check('wait_human 验证码仍在时 selector 出现也不提前 resolved',
      timeoutResult.resolved === false && timeoutResult.needed === true
        && timeoutResult.detected === true && timeoutResult.kind === 'recaptcha'
        && timeoutResult.selector === '#done' && timeoutResult.polls >= 2
        && elapsed >= 5000 && timeoutResult.waitedMs >= 5000,
      JSON.stringify({ timeoutResult, elapsed }))
    check('wait_human 超时返回 resolved=false 且带 kind 与提示',
      timeoutResult.resolved === false && timeoutResult.kind === 'recaptcha'
        && typeof timeoutResult.hint === 'string'
        && /^等待人工处理超时：login（仍检测到 recaptcha，已等 \d+ms，轮询 \d+ 次）$/.test(timeoutResult.summary),
      JSON.stringify(timeoutResult))
    check('wait_human headless 会话在超时结果里标注 headless',
      timeoutResult.headless === true
        && timeoutResult.hint.includes('当前浏览器是 headless 的')
        && timeoutResult.hint.includes('headless=false')
        && timeoutResult.hint.includes('browser_e2e_close')
        && timeoutResult.hint.includes('cdp'),
      JSON.stringify({ headless: timeoutResult.headless, hint: timeoutResult.hint }))
    check('wait_human 不写 ref 表与事件环',
      before.refs === after.refs && before.baselines === after.baselines
        && before.console === after.console && before.network === after.network
        && before.active === after.active
        && JSON.parse(before.refs).length > 0 && before.baselines !== '[]',
      JSON.stringify({ before, after }))
  }

  {
    await navigate(session, `${base}/nav-start`, 'load')
    const nav = await waitForHuman(session, { reason: 'login', timeoutMs: 5000, pollMs: 250, textScan: false })
    check('wait_human 导航期间探针失败不中断等待',
      nav.resolved === true && nav.needed === true
        && nav.probeErrors > 0 && typeof nav.lastProbeError === 'string' && nav.lastProbeError.length > 0
        && nav.probeErrors < nav.polls
        && /^等待人工处理完成：login（recaptcha 已消失，耗时 \d+ms，轮询 \d+ 次）$/.test(nav.summary),
      JSON.stringify(nav))
  }

  {
    const extra = await navigate(session, dataUrl(RECAPTCHA_PAGE), 'load', { new_tab: true })
    const closedTabId = extra.tabId
    const pending = waitForHuman(session, { reason: 'login', timeoutMs: 5000, pollMs: 250, tab_id: closedTabId })
    await sleep(700)
    await closeTab(KEY, closedTabId)
    const closed = await expectThrow(() => pending)
    check('wait_human 等待期间标签页关闭立即报错',
      typeof closed === 'string'
        && closed === `等待人工处理期间标签页已关闭（${closedTabId}），请重新 browser_e2e_tabs 获取可用标签页`,
      String(closed))
  }

  {
    // active 在验证码页、目标是无验证码页：按 tab_id 立即返回，且等待期间不改 active。
    const cleanInfo = await navigate(session, dataUrl(CLEAN_PAGE), 'load', { new_tab: true })
    const cleanTabId = cleanInfo.tabId
    const captchaInfo = await navigate(session, dataUrl(RECAPTCHA_PAGE), 'load', { new_tab: true })
    const captchaTabId = captchaInfo.tabId
    const started = Date.now()
    const targeted = await waitForHuman(session, {
      reason: 'confirm', timeoutMs: 5000, pollMs: 250, tab_id: cleanTabId,
    })
    const elapsed = Date.now() - started
    check('wait_human 按 tab_id 作用于指定标签页',
      currentTab(session).id === captchaTabId
        && targeted.resolved === true && targeted.needed === false
        && targeted.tabId === cleanTabId && targeted.url.startsWith('data:')
        && elapsed < 2000 && session.activeTabId === captchaTabId,
      JSON.stringify({ targeted, elapsed, active: session.activeTabId, captchaTabId }))
    await closeTab(KEY, captchaTabId)
    await closeTab(KEY, cleanTabId)
  }

  {
    // 两个等待并发：一个要等验证码消失，一个立即返回；结果各自独立。
    const removeInfo = await navigate(session, `${base}/remove-captcha`, 'load', { new_tab: true })
    const cleanInfo = await navigate(session, dataUrl(CLEAN_PAGE), 'load', { new_tab: true })
    const [removed, clean] = await Promise.all([
      waitForHuman(session, { reason: 'login', timeoutMs: 5000, pollMs: 250, tab_id: removeInfo.tabId }),
      waitForHuman(session, { reason: 'login', timeoutMs: 5000, pollMs: 250, tab_id: cleanInfo.tabId }),
    ])
    check('wait_human 并发两个等待互不干扰',
      removed.resolved === true && removed.needed === true && removed.polls >= 2
        && clean.resolved === true && clean.needed === false && clean.polls === 1
        && removed.tabId === removeInfo.tabId && clean.tabId === cleanInfo.tabId
        && removed.tabId !== clean.tabId,
      JSON.stringify({ removed, clean }))
    await closeTab(KEY, removeInfo.tabId)
    await closeTab(KEY, cleanInfo.tabId)
  }

  console.log('== 校验组 ==')
  {
    await navigate(session, dataUrl(CLEAN_PAGE), 'load')
    const failures = []
    for (const value of [4999, 300001, 5000.5]) {
      failures.push(await expectThrow(() => waitForHuman(session, { timeoutMs: value })))
    }
    check('wait_human timeoutMs 越界或非整数报错',
      failures.every((message, index) => typeof message === 'string'
        && message === `timeoutMs 必须是 5000-300000 的整数，收到 ${[4999, 300001, 5000.5][index]}`),
      JSON.stringify(failures))
  }

  {
    const failures = []
    for (const value of [249, 10001, 250.5]) {
      failures.push(await expectThrow(() => waitForHuman(session, { pollMs: value })))
    }
    check('wait_human pollMs 越界或非整数报错',
      failures.every((message, index) => typeof message === 'string'
        && message === `pollMs 必须是 250-10000 的整数，收到 ${[249, 10001, 250.5][index]}`),
      JSON.stringify(failures))
  }

  {
    const started = Date.now()
    const invalidSelector = await expectThrow(() => waitForHuman(session, { selector: '[[[', timeoutMs: 5000 }))
    const elapsed = Date.now() - started
    check('wait_human 非法 selector 在等待前报错',
      typeof invalidSelector === 'string'
        && invalidSelector.startsWith('selector 无法在等待开始前解析：')
        && invalidSelector.endsWith('；请检查 CSS 选择器后重试')
        && elapsed < 2000,
      JSON.stringify({ invalidSelector, elapsed }))
  }

  {
    await navigate(session, dataUrl(CLEAN_PAGE), 'load')
    const reason = `  captcha\n login  ${'x'.repeat(250)}`
    const result = await waitForHuman(session, { reason })
    const normalized = `captcha login ${'x'.repeat(250)}`.slice(0, 200)
    const toolText = await TOOLS.get('browser_e2e_wait_for_human').run({ reason }, exec)
    check('wait_human reason 超长截断到 200 字符',
      result.reason === normalized && result.reason.length === 200
        && result.reason.startsWith('captcha login ')
        && result.summary.startsWith(`无需等待：${normalized}（未检测到人机验证，耗时 `)
        && toolText.split('\n')[0].startsWith(`无需等待：${normalized}（未检测到人机验证，耗时 `),
      JSON.stringify({ reason: result.reason, summary: result.summary, firstLine: toolText.split('\n')[0] }))
  }

  {
    // 规格错误表里的其余参数校验：reason / textScan 类型、两个工具共用 textScan 校验。
    const reasonError = await expectThrow(() => waitForHuman(session, { reason: 42 }))
    const waitTextScanError = await expectThrow(() => waitForHuman(session, { textScan: 'false' }))
    const checkTextScanError = await expectThrow(() => humanCheck(session, { textScan: 0 }))
    const expectedTextScan = 'textScan 必须是布尔值（true 读页面文本，false 只看 DOM 结构）'
    check('reason / textScan 类型校验与两工具共用文案',
      reasonError === 'reason 必须是字符串（如 captcha / login / 2fa / confirm）'
        && waitTextScanError === expectedTextScan && checkTextScanError === expectedTextScan,
      JSON.stringify({ reasonError, waitTextScanError, checkTextScanError }))
    const emptySelector = await waitForHuman(session, { selector: '   ', timeoutMs: 5000, pollMs: 250 })
    check('selector 纯空白按未给处理且正常返回',
      emptySelector.selector === '' && emptySelector.resolved === true && emptySelector.needed === false,
      JSON.stringify(emptySelector))
  }

  {
    // 工具参数契约：范围 / 默认 / 类型都从 human.js 常量派生，这里只断言声明的形状。
    const captchaTool = TOOLS.get('browser_e2e_captcha_check')
    const waitTool = TOOLS.get('browser_e2e_wait_for_human')
    check('captcha_check 参数契约：textScan / tab_id 且无必填',
      JSON.stringify(Object.keys(captchaTool.parameters.properties).sort()) === JSON.stringify(['tab_id', 'textScan'])
        && captchaTool.parameters.properties.textScan.type === 'boolean'
        && captchaTool.parameters.properties.tab_id.type === 'string'
        && captchaTool.parameters.additionalProperties === false
        && captchaTool.parameters.required.length === 0,
      JSON.stringify(captchaTool.parameters))
    check('wait_for_human 参数契约：reason / timeoutMs / pollMs / selector / textScan / tab_id 且无必填',
      JSON.stringify(Object.keys(waitTool.parameters.properties).sort())
        === JSON.stringify(['pollMs', 'reason', 'selector', 'tab_id', 'textScan', 'timeoutMs'])
        && waitTool.parameters.properties.reason.type === 'string'
        && waitTool.parameters.properties.timeoutMs.type === 'integer'
        && waitTool.parameters.properties.pollMs.type === 'integer'
        && waitTool.parameters.properties.selector.type === 'string'
        && waitTool.parameters.properties.textScan.type === 'boolean'
        && waitTool.parameters.additionalProperties === false
        && waitTool.parameters.required.length === 0,
      JSON.stringify(waitTool.parameters))
  }
} finally {
  await closeAll()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
async function waitUntil(fn, timeoutMs = 10000, stepMs = 250) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(stepMs)
  }
}
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const playwrightSettled = await waitUntil(() => playwrightEdgeRootCount() <= playwrightBaseline)
const remaining = edgeRootCount()
const remainingPlaywright = playwrightEdgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline,
  `baseline=${baseline} remaining=${remaining}`)
check('本测试未遗留 Playwright Edge 主进程', playwrightSettled && remainingPlaywright <= playwrightBaseline,
  `playwright 基线=${playwrightBaseline} 残留=${remainingPlaywright}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
