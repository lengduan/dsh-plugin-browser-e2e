/**
 * 多载体选择（功能规格 0034-multi-carrier.md，方案 B1）验收。
 *
 * 纯函数组：注入假 env / platform，不启浏览器、不依赖本机装没装 Chrome。
 * launch 组：注入假 chromium 断言「传给 Playwright 的是 channel 还是 executablePath」、
 * 摘要、复用、热切换与 CDP 忽略；用 DSH_BROWSER_CHROME_PATH 指向临时文件模拟已安装 Chrome。
 * 真机组（可选）：本机确实装有 Chrome 时真起一次 headless Chrome；找不到时打印 SKIP 并以 0 退出。
 *
 * 运行：node tests/carrier.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const {
  CARRIERS, CARRIER_LABELS, DEFAULT_CARRIER, carrierLabel, detectCarrier, searchSummary,
} = await import('../lib/carrier.js')
const { closeAll, launch, requireSession, sessionOf, activeSessionKeys } = await import('../lib/session.js')

const root = mkdtempSync(join(tmpdir(), 'dsh-carrier-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CHROME_FAKE = join(root, 'chrome-fake.exe')
writeFileSync(CHROME_FAKE, '')

let pass = 0
let fail = 0
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
function skipped(label, reason) {
  skip += 1
  console.log(`  SKIP  ${label} —— ${reason}`)
}

async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/** 在临时环境里装上「Chrome」：path 处是存在的文件。 */
function installedEnv(overrides = {}) {
  return { PATH: '', ...overrides }
}

/** 假 page：满足 addPage / attachPageHooks / reuseInfo / evaluate 的最小接口。 */
function fakePage() {
  const handlers = new Map()
  return {
    on(event, handler) {
      handlers.set(event, handler)
    },
    close: async () => {},
    evaluate: async () => 'complete',
    url: () => 'about:blank',
    title: async () => '',
    viewportSize: () => ({ width: 1600, height: 900 }),
    context: () => ({ newCDPSession: async () => ({}) }),
  }
}

/** 假 browser：记录次数即可，不伪造真实 Playwright Browser 没有的接口。 */
function fakeBrowser({ version = '0.0.0-fake', pages = [] } = {}) {
  const browser = {
    closeCalls: 0,
    version: () => version,
    close: async () => {
      browser.closeCalls += 1
    },
    newPage: async () => fakePage(),
    contexts: () => [{ pages: () => pages, on() {} }],
  }
  return browser
}

/** 假 chromium：记录 launch 收到的参数，供断言 channel / executablePath。 */
function fakeChromium({ browser, launchCalls = [] } = {}) {
  return {
    launchCalls,
    launch: async (options) => {
      launchCalls.push(options)
      return browser
    },
    connectOverCDP: async () => browser,
  }
}

/** 让 launch 里的 detectCarrier 找到「Chrome」：临时改环境变量，结束后恢复。 */
async function withChromePath(file, run) {
  const previous = process.env.DSH_BROWSER_CHROME_PATH
  process.env.DSH_BROWSER_CHROME_PATH = file
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_BROWSER_CHROME_PATH
    else process.env.DSH_BROWSER_CHROME_PATH = previous
  }
}

function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

const baseline = edgeRootCount()

try {
  console.log('== 用例 1：载体常量与展示名 ==')
  {
    check('CARRIERS 为 edge / chrome / auto', JSON.stringify(CARRIERS) === JSON.stringify(['edge', 'chrome', 'auto']),
      JSON.stringify(CARRIERS))
    check('缺省载体为 edge', DEFAULT_CARRIER === 'edge', DEFAULT_CARRIER)
    check('carrierLabel 返回中文展示名', carrierLabel('edge') === '系统 Edge'
      && carrierLabel('chrome') === '系统 Chrome' && carrierLabel('auto') === '自动',
    JSON.stringify(CARRIER_LABELS))
    check('carrierLabel 未知值按 edge 处理', carrierLabel('firefox') === '系统 Edge', carrierLabel('firefox'))
  }

  console.log('== 用例 2：detectCarrier 纯函数组（注入 env / platform）==')
  {
    const edge = detectCarrier('edge', installedEnv({ DSH_BROWSER_CHROME_PATH: join(root, 'missing.exe') }), 'linux')
    check('detectCarrier：edge 不探测文件直接返回 edge',
      edge.kind === 'edge' && edge.executablePath === undefined, JSON.stringify(edge))

    const viaEnv = detectCarrier('chrome', installedEnv({ DSH_BROWSER_CHROME_PATH: CHROME_FAKE }), 'linux')
    check('detectCarrier：chrome 命中 DSH_BROWSER_CHROME_PATH',
      viaEnv.kind === 'chrome' && viaEnv.executablePath === CHROME_FAKE, JSON.stringify(viaEnv))

    const pathDir = join(root, 'bin')
    mkdirSync(pathDir, { recursive: true })
    const pathChrome = join(pathDir, 'chrome.exe')
    writeFileSync(pathChrome, '')
    const viaPath = detectCarrier('chrome', installedEnv({ PATH: pathDir }), 'win32')
    check('detectCarrier：chrome 命中 PATH', viaPath.kind === 'chrome' && viaPath.executablePath === pathChrome,
      JSON.stringify(viaPath))

    const programFiles = join(root, 'ProgramFiles')
    const installDir = join(programFiles, 'Google', 'Chrome', 'Application')
    mkdirSync(installDir, { recursive: true })
    const installed = join(installDir, 'chrome.exe')
    writeFileSync(installed, '')
    const viaConvention = detectCarrier('chrome',
      installedEnv({ ProgramFiles: programFiles, LOCALAPPDATA: join(root, 'LocalAppData') }), 'win32')
    check('detectCarrier：chrome 命中平台安装位置',
      viaConvention.kind === 'chrome' && viaConvention.executablePath === installed, JSON.stringify(viaConvention))

    const autoChrome = detectCarrier('auto', installedEnv({ PATH: pathDir }), 'win32')
    const autoEdge = detectCarrier('auto', installedEnv(), 'win32')
    check('detectCarrier：auto 优先 chrome、无 Chrome 时回退 edge',
      autoChrome.kind === 'chrome' && autoChrome.executablePath === pathChrome && autoEdge.kind === 'edge',
      JSON.stringify({ autoChrome, autoEdge }))

    const missingEnv = installedEnv({ ProgramFiles: join(root, 'Nowhere'), LOCALAPPDATA: join(root, 'NoLocal') })
    const missing = await expectThrow(() => detectCarrier('chrome', missingEnv, 'win32'))
    check('detectCarrier：都找不到时报错并列出查过的位置',
      Boolean(missing) && missing.includes('本机没有找到 Google Chrome')
        && missing.includes(join(root, 'Nowhere', 'Google', 'Chrome', 'Application', 'chrome.exe')),
      String(missing))

    check('searchSummary 返回名称与展开后的绝对路径',
      searchSummary('chrome', missingEnv, 'win32').includes('平台惯例安装位置')
        && searchSummary('edge').includes('msedge'),
      searchSummary('chrome', missingEnv, 'win32'))
  }

  const KEY_EDGE = 'test-carrier-edge'
  const KEY_CHROME = 'test-carrier-chrome'
  const KEY_AUTO = 'test-carrier-auto'
  const KEY_CDP = 'test-carrier-cdp'
  const KEY_REAL = 'test-carrier-real'

  console.log('== 用例 3：carrier 入参校验与 launch 装配（假 chromium）==')
  {
    const chromium = fakeChromium({ browser: fakeBrowser() })
    const message = await expectThrow(() => launch('test-carrier-illegal', { carrier: 'firefox' }, undefined, {}, { chromium }))
    check('carrier 非法值报错且不登记会话',
      Boolean(message) && message.includes('carrier 只支持 edge / chrome / auto')
        && !activeSessionKeys().includes('test-carrier-illegal'),
      String(message))

    const edgeBrowser = fakeBrowser({ version: '1.2.3' })
    const edgeChromium = fakeChromium({ browser: edgeBrowser })
    const edgeInfo = await launch(KEY_EDGE, { carrier: 'edge', headless: true }, undefined, {}, { chromium: edgeChromium })
    const edgeCall = edgeChromium.launchCalls[0] ?? {}
    check('carrier=edge 时 launch 传 channel=msedge',
      edgeCall.channel === 'msedge' && edgeCall.executablePath === undefined && edgeInfo.carrier === 'edge'
        && sessionOf(KEY_EDGE).carrier === 'edge', JSON.stringify({ edgeCall, carrier: edgeInfo.carrier }))
    check('默认不传 carrier 时启动摘要与既有逐字一致',
      edgeInfo.summary === `启动浏览器 系统 Edge ${edgeInfo.version}（headless=true，视口 1600x900）`,
      edgeInfo.summary)

    const chromeBrowser = fakeBrowser({ version: '1.2.3' })
    const chromeChromium = fakeChromium({ browser: chromeBrowser })
    const chromeInfo = await withChromePath(CHROME_FAKE,
      () => launch(KEY_CHROME, { carrier: 'chrome', headless: true }, undefined, {}, { chromium: chromeChromium }))
    const chromeCall = chromeChromium.launchCalls[0] ?? {}
    check('carrier=chrome 时 launch 传 executablePath 而不是 channel',
      chromeCall.executablePath === CHROME_FAKE && chromeCall.channel === undefined
        && chromeInfo.carrier === 'chrome' && sessionOf(KEY_CHROME).carrier === 'chrome',
      JSON.stringify({ chromeCall, carrier: chromeInfo.carrier }))
    check('carrier=chrome 的启动摘要写系统 Chrome',
      chromeInfo.summary === `启动浏览器 系统 Chrome ${chromeInfo.version}（headless=true，视口 1600x900）`,
      chromeInfo.summary)

    const reused = await launch(KEY_CHROME, { carrier: 'chrome' }, undefined, {}, { chromium: chromeChromium })
    check('复用返回带 carrier 且摘要含载体名',
      reused.reused === true && reused.carrier === 'chrome' && reused.summary.includes('系统 Chrome'),
      JSON.stringify(reused))

    const hot = await expectThrow(() => launch(KEY_CHROME, { carrier: 'edge' }, undefined, {}, { chromium: chromeChromium }))
    check('已启动后传不同 carrier 报热切换错误',
      Boolean(hot) && hot.includes('载体 系统 Chrome') && hot.includes('系统 Edge') && hot.includes('browser_e2e_close'),
      String(hot))

    // 已在跑的 edge 会话显式传 auto：DSH_BROWSER_CHROME_PATH 指向存在的文件时 auto 解析成 chrome，
    // 与当前 edge 不同 → 报热切换错误，而不是静默换浏览器。
    const autoHot = await withChromePath(CHROME_FAKE,
      () => expectThrow(() => launch(KEY_EDGE, { carrier: 'auto' }, undefined, {}, { chromium: edgeChromium })))
    check('显式 auto 解析结果与当前不同时报热切换错误',
      Boolean(autoHot) && autoHot.includes('载体 系统 Edge') && autoHot.includes('系统 Chrome'),
      String(autoHot))
  }

  console.log('== 用例 4：CDP 模式忽略 carrier（假 chromium）==')
  {
    const browser = fakeBrowser({ version: '9.9.9', pages: [fakePage()] })
    const chromium = fakeChromium({ browser })
    const info = await launch(KEY_CDP, { mode: 'cdp', carrier: 'chrome' }, undefined, {}, { chromium })
    check('CDP 模式忽略 carrier 且返回不带 carrier',
      info.mode === 'cdp' && Object.prototype.hasOwnProperty.call(info, 'carrier') === false
        && sessionOf(KEY_CDP).carrier === 'edge',
      JSON.stringify(info))
    // 复用路径同样忽略 carrier 的一致性校验（CDP 载体由端点决定）。
    const reused = await launch(KEY_CDP, { mode: 'cdp', carrier: 'chrome' }, undefined, {}, { chromium })
    check('CDP 复用路径也不因 carrier 报热切换', reused.reused === true, JSON.stringify(reused))
  }

  console.log('== 用例 5：真机（可选）carrier=chrome 启动 ==')
  {
    const realChrome = detectCarrier('chrome', process.env, process.platform)
    if (realChrome.kind !== 'chrome') {
      skipped('本机装有 Chrome 时 carrier=chrome 启动成功', 'SKIP：本机找不到 Google Chrome')
    } else {
      const info = await launch(KEY_REAL, { carrier: 'chrome', headless: true }, undefined, {})
      check('本机装有 Chrome 时 carrier=chrome 启动成功',
        info.reused === false && info.carrier === 'chrome' && info.summary.includes('系统 Chrome')
          && requireSession(KEY_REAL).state === 'ready',
        JSON.stringify(info))
    }
  }
} finally {
  await closeAll()
  rmSync(root, { recursive: true, force: true })
  await sleep(1000)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（基线 ${baseline}；真实 Chrome 进程由本机任务管理器观察）`)
process.exit(fail === 0 ? 0 : 1)
