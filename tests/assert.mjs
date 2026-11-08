/**
 * browser_e2e_assert 独立验收：一次判定 1-20 条断言（selector / text / url / expression），
 * 逐条给期望与实际证据；未通过不抛错，入参非法 / 未启动 / tab 不存在 / 页面关闭抛错。
 *
 * 覆盖 specs/功能规格/0027-assert-tool.md「验收」的全部用例，另补边界：
 * selector 命中超过 200 个只统计前 200、state / urlMatch 字段只出现在对应条目、
 * summary 未通过超过 5 条只列前 5、工具层 summaryOf 与 PASS/FAIL 渲染。
 *
 * 真起无头 Edge，夹具用 127.0.0.1 随机端口的本地 HTTP 服务，不依赖外网。
 * 运行：node tests/assert.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, closeTab, launch, requireSession } = await import('../lib/session.js')
const {
  assertPage, currentTab, evaluate, navigate,
} = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')
const { buildToolTable, summaryOf } = await import('../lib/tools.js')

const KEY = 'test-assert-key'
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

/**
 * 断言夹具页面：可见元素、display:none 元素、opacity:0 元素各一，
 * 文本同时包含大小写敏感串与隐藏串；window.__value 供 expression 使用。
 */
const FIXTURE_A = '<!doctype html><html><head><title>assert-a</title></head><body>'
  + '<div id="ok" class="btn">提交成功</div>'
  + '<div id="hidden" style="display:none">隐藏文本ABC</div>'
  + '<div id="transparent" style="width:10px;height:10px;opacity:0">透明可见</div>'
  + '<p id="plain">前缀 visible-Text 后缀</p>'
  + '<script>window.__value = 42</script>'
  + '</body></html>'

const baseline = edgeRootCount()
const playwrightBaseline = playwrightEdgeRootCount()
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/assert-page') {
    const state = url.searchParams.get('state')
    const html = state === 'b'
      ? '<!doctype html><html><head><title>assert-b</title></head><body><h1>B 页独有标记</h1></body></html>'
      : FIXTURE_A
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
  if (url.pathname === '/one-line') {
    // 行内元素夹具：innerText 不含换行，用于验证「每条断言一行」的渲染格式。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>one-line</title></head><body>'
      + '<span id="ok" class="btn">提交成功</span> <span>前缀 visible-Text 后缀</span>'
      + '</body></html>')
    return
  }
  if (url.pathname === '/many') {
    let html = '<!doctype html><html><head><title>assert-many</title></head><body>'
    for (let i = 0; i < 201; i += 1) {
      html += `<div class="hit" style="width:5px;height:5px">hit${i}</div>`
    }
    html += '</body></html>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
  if (url.pathname === '/slow') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>assert-slow</title></head><body>slow</body></html>')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, 'test-assert-session')
  session = requireSession(KEY)
  console.log('== 准备：启动浏览器并打开断言夹具 ==')
  check('启动成功', info.reused === false && edgeRootCount() > baseline, JSON.stringify(info))

  await navigate(session, `${base}/assert-page?state=a`, 'load')
  const mainUrl = currentTab(session).page.url()
  const tab = currentTab(session)
  const exec = { agent: { id: KEY } }
  const tool = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) })
    .find((definition) => definition.name === 'browser_e2e_assert')

  console.log('== 通过组 ==')
  {
    const result = await assertPage(session, {
      checks: [
        { selector: '#ok' },
        { text: '提交成功' },
        { expression: 'window.__value === 42' },
      ],
    })
    check('assert 三条断言全通过返回 pass=true',
      result.pass === true && result.total === 3 && result.passed === 3 && result.failed === 0
        && result.tabId === tab.id && result.url === mainUrl
        && Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0
        && result.checks.length === 3 && result.checks.every((item) => item.pass === true),
      JSON.stringify(result))

    const attached = await assertPage(session, { checks: [{ selector: '#hidden', state: 'attached' }] })
    check('assert selector attached 对隐藏元素通过',
      attached.pass === true && attached.checks[0].state === 'attached'
        && attached.checks[0].actual.includes('命中 1 个（可见 0 个）'),
      JSON.stringify(attached.checks[0]))

    const defaultVisible = await assertPage(session, { checks: [{ selector: '#hidden' }] })
    check('assert selector 缺省 visible 对隐藏元素不通过',
      defaultVisible.pass === false && defaultVisible.checks[0].state === 'visible'
        && defaultVisible.checks[0].actual.includes('命中 1 个（可见 0 个）'),
      JSON.stringify(defaultVisible.checks[0]))

    const states = await assertPage(session, {
      checks: [
        { selector: '#hidden', state: 'hidden' },
        { selector: '#gone', state: 'detached' },
        { selector: '#ok', state: 'detached' },
        { selector: '#ok', state: 'hidden' },
        { selector: '#transparent' },
      ],
    })
    check('assert selector hidden 与 detached 语义',
      JSON.stringify(states.checks.map((item) => item.pass)) === JSON.stringify([true, true, false, false, true])
        && states.checks[1].actual === '未命中任何元素'
        && states.checks[4].actual.includes('命中 1 个（可见 1 个）'),
      JSON.stringify(states.checks))

    const offset = (await evaluate(session, "document.body.innerText.indexOf('visible-Text')")).value
    const textHit = await assertPage(session, { checks: [{ text: 'visible-Text' }] })
    check('assert text 命中并给出偏移',
      Number.isInteger(offset) && offset >= 0 && textHit.pass === true
        && textHit.checks[0].actual.includes(`第 ${offset} 个字符起`)
        && textHit.checks[0].actual.includes('visible-Text'),
      JSON.stringify({ offset, check: textHit.checks[0] }))

    const includes = await assertPage(session, { checks: [{ url: `${base}/assert-page` }] })
    check('assert url includes 匹配',
      includes.pass === true && includes.checks[0].urlMatch === 'includes'
        && includes.checks[0].actual === `实际地址 ${mainUrl}`,
      JSON.stringify(includes.checks[0]))

    const glob = await assertPage(session, { checks: [{ url: `${base}/assert-page?*`, urlMatch: 'glob' }] })
    check('assert url glob 匹配',
      glob.pass === true && glob.checks[0].urlMatch === 'glob'
        && glob.checks[0].actual === `实际地址 ${mainUrl}`,
      JSON.stringify(glob.checks[0]))

    const regex = await assertPage(session, { checks: [{ url: 'assert-page\\?state=a$', urlMatch: 'regex' }] })
    check('assert url regex 匹配',
      regex.pass === true && regex.checks[0].urlMatch === 'regex'
        && regex.checks[0].actual === `实际地址 ${mainUrl}`,
      JSON.stringify(regex.checks[0]))

    const truthy = await assertPage(session, { checks: [{ expression: 'window.__value === 42' }] })
    check('assert expression 真值',
      truthy.pass === true && truthy.checks[0].actual === '真值（返回 true）',
      JSON.stringify(truthy.checks[0]))
  }

  console.log('== 失败与证据组 ==')
  {
    const result = await assertPage(session, {
      checks: [
        { text: '不存在的文案XYZ' },
        { expression: '(window.__order = (window.__order || []).concat("second")).length === 1' },
        { text: 'visible-Text' },
      ],
    })
    const order = (await evaluate(session, 'window.__order')).value
    check('assert 一条不通过时其余条目仍执行',
      result.pass === false && result.failed === 1
        && JSON.stringify(result.checks.map((item) => item.pass)) === JSON.stringify([false, true, true])
        && Array.isArray(order) && order.length === 1,
      JSON.stringify({ checks: result.checks, order }))

    const miss = await assertPage(session, { checks: [{ text: '不存在的文案XYZ' }] })
    const missActual = miss.checks[0].actual
    check('assert text 未命中给出页面文本开头',
      miss.pass === false && /^未找到；页面可见文本 \d+ 字，开头 "/.test(missActual)
        && missActual.includes('提交成功'),
      missActual)

    const caseSensitive = await assertPage(session, {
      checks: [{ text: 'visible-Text' }, { text: 'VISIBLE-TEXT' }, { text: '隐藏文本ABC' }],
    })
    check('assert text 区分大小写且不匹配隐藏文本',
      JSON.stringify(caseSensitive.checks.map((item) => item.pass)) === JSON.stringify([true, false, false]),
      JSON.stringify(caseSensitive.checks))

    const falsy = await assertPage(session, { checks: [{ expression: '1 + 1 === 3' }] })
    check('assert expression 假值',
      falsy.pass === false && falsy.checks[0].actual === '假值（返回 false）',
      JSON.stringify(falsy.checks[0]))

    const thrown = await assertPage(session, {
      checks: [
        { expression: '(function () { throw new Error("断言炸了") })()' },
        { text: 'visible-Text' },
      ],
    })
    check('assert expression 抛错只让该条失败',
      JSON.stringify(thrown.checks.map((item) => item.pass)) === JSON.stringify([false, true])
        && thrown.checks[0].actual === '求值抛错：断言炸了',
      JSON.stringify(thrown.checks))

    const none = await assertPage(session, { checks: [{ selector: '#none' }] })
    check('assert selector 未命中证据为未命中任何元素',
      none.pass === false && none.checks[0].actual === '未命中任何元素',
      JSON.stringify(none.checks[0]))

    const mixed = await assertPage(session, {
      checks: [
        { selector: '#ok', state: 'visible' },
        { text: '不存在的文案XYZ' },
        { url: 'assert-page', urlMatch: 'regex' },
        { expression: 'false' },
      ],
    })
    const everyHasFields = mixed.checks.every((item) => item.index >= 1
      && ['selector', 'text', 'url', 'expression'].includes(item.kind)
      && typeof item.expected === 'string' && typeof item.actual === 'string'
      && typeof item.pass === 'boolean')
    check('assert checks 每项含 index / kind / expected / pass / actual',
      mixed.checks.length === 4 && everyHasFields
        && JSON.stringify(mixed.checks.map((item) => item.index)) === JSON.stringify([1, 2, 3, 4])
        && mixed.checks[0].kind === 'selector' && mixed.checks[0].state === 'visible'
        && mixed.checks[1].state === undefined
        && mixed.checks[2].urlMatch === 'regex' && mixed.checks[3].urlMatch === undefined,
      JSON.stringify(mixed.checks))
  }

  console.log('== 渲染与摘要组 ==')
  {
    const allPass = await assertPage(session, {
      checks: [{ selector: '#ok' }, { text: '提交成功' }, { expression: 'window.__value === 42' }],
    })
    check('assert summary 全通过文案',
      allPass.summary === `断言通过：3/3 条（标签页 ${tab.id}，耗时 ${allPass.elapsedMs}ms）`,
      allPass.summary)

    const failed = await assertPage(session, {
      checks: [{ text: 'visible-Text' }, { text: '无此文本一' }, { text: '提交成功' }, { text: '无此文本二' }],
    })
    check('assert summary 未通过时列出条目号',
      failed.summary.startsWith(`断言失败：2/4 条通过（未通过第 2、4 条；标签页 ${tab.id}，耗时 `)
        && failed.summary.endsWith('ms）'),
      failed.summary)

    const manyFailed = await assertPage(session, {
      checks: Array.from({ length: 7 }, (_item, index) => ({ text: `无此文本-${index}` })),
    })
    check('assert summary 未通过超过 5 条只列前 5 条并加等',
      manyFailed.summary.includes('未通过第 1、2、3、4、5 条等；'),
      manyFailed.summary)

    // 渲染格式用 innerText 不含换行的行内夹具，逐条比对「一行一条」。
    await navigate(session, `${base}/one-line`, 'load')
    const renderFailed = await assertPage(session, {
      checks: [{ text: 'visible-Text' }, { text: '无此文本一' }, { text: '提交成功' }, { text: '无此文本二' }],
    })
    const rendered = tool.output.render({}, renderFailed)
    const lines = rendered[0].text.split('\n')
    const checkLines = lines.slice(1, 1 + renderFailed.checks.length)
    const formatOk = checkLines.every((line, index) => {
      const item = renderFailed.checks[index]
      const prefix = item.pass ? 'PASS' : 'FAIL'
      return line === `${prefix} [${item.index}] ${item.kind}: "${item.expected}" → ${item.actual}`
    })
    check('assert render 每条一行 PASS 或 FAIL',
      rendered.length === 1 && rendered[0].type === 'text'
        && lines.length === renderFailed.checks.length + 2
        && lines[0] === renderFailed.summary && formatOk
        && lines.at(-1) === '未通过的断言不抛错；需要等待条件满足时先用 browser_e2e_wait。'
        && !tool.output.render({}, allPass)[0].text.split('\n')
          .includes('未通过的断言不抛错；需要等待条件满足时先用 browser_e2e_wait。'),
      JSON.stringify({
        renderedType: rendered[0].type, lineCount: lines.length,
        expectedLineCount: renderFailed.checks.length + 2,
        summaryMatch: lines[0] === renderFailed.summary, formatOk,
        hintMatch: lines.at(-1) === '未通过的断言不抛错；需要等待条件满足时先用 browser_e2e_wait。',
        lines,
      }))

    const toolValue = await tool.run({
      checks: [
        { selector: '#ok' },
        { text: '提交成功' },
        { expression: 'document.title === "one-line"' },
      ],
    }, exec)
    check('assert summary 被 summaryOf 采用',
      toolValue.pass === true && summaryOf(toolValue) === toolValue.summary
        && tool.output.render({}, toolValue)[0].text.split('\n')[0] === toolValue.summary,
      JSON.stringify({ summary: toolValue.summary, summaryOf: summaryOf(toolValue) }))
  }

  console.log('== 校验组 ==')
  {
    const notArray = await expectThrow(() => assertPage(session, { checks: 'x' }))
    const nullChecks = await expectThrow(() => assertPage(session, { checks: null }))
    check('assert checks 非数组报错',
      notArray === 'checks 必须是数组（1-20 条断言），收到 string'
        && nullChecks === 'checks 必须是数组（1-20 条断言），收到 null',
      JSON.stringify({ notArray, nullChecks }))

    const empty = await expectThrow(() => assertPage(session, { checks: [] }))
    const tooMany = await expectThrow(() => assertPage(session, {
      checks: Array.from({ length: 21 }, () => ({ text: 'x' })),
    }))
    check('assert checks 为空数组或超过 20 条报错',
      empty === 'checks 必须是 1-20 条，收到 0 条'
        && tooMany === 'checks 必须是 1-20 条，收到 21 条',
      JSON.stringify({ empty, tooMany }))

    const twoKinds = await expectThrow(() => assertPage(session, {
      checks: [{ selector: '#ok', text: '提交成功' }],
    }))
    check('assert 单条给两个条件报错',
      twoKinds === '第 1 条断言必须且只能给 selector / text / url / expression 之一，当前收到：selector、text',
      String(twoKinds))

    const noKind = await expectThrow(() => assertPage(session, { checks: [{}] }))
    const blankKinds = await expectThrow(() => assertPage(session, {
      checks: [{ selector: '', text: '', url: '', expression: '' }],
    }))
    check('assert 单条一个条件都不给报错',
      noKind === '第 1 条断言必须且只能给 selector / text / url / expression 之一，当前收到：无'
        && blankKinds === noKind,
      JSON.stringify({ noKind, blankKinds }))

    const blankIgnored = await assertPage(session, { checks: [{ selector: '', text: 'visible-Text' }] })
    check('assert 空串按未给处理',
      blankIgnored.pass === true && blankIgnored.checks[0].kind === 'text'
        && blankIgnored.checks[0].expected === 'visible-Text',
      JSON.stringify(blankIgnored.checks[0]))

    const stateOnText = await expectThrow(() => assertPage(session, {
      checks: [{ text: 'visible-Text', state: 'visible' }],
    }))
    check('assert state 用于非 selector 条目报错',
      stateOnText === '第 1 条断言的 state 只对 selector 有效（当前是 text 条件）',
      String(stateOnText))

    const badState = await expectThrow(() => assertPage(session, {
      checks: [{ selector: '#ok', state: 'shown' }],
    }))
    check('assert state 非法值报错',
      badState === '第 1 条断言的 state "shown" 不支持，可选 attached / visible / hidden / detached',
      String(badState))

    const urlMatchOnText = await expectThrow(() => assertPage(session, {
      checks: [{ text: 'visible-Text', urlMatch: 'glob' }],
    }))
    check('assert urlMatch 用于非 url 条目报错',
      urlMatchOnText === '第 1 条断言的 urlMatch 只对 url 有效（当前是 text 条件）',
      String(urlMatchOnText))

    const badUrlMatch = await expectThrow(() => assertPage(session, {
      checks: [{ url: 'x', urlMatch: 'prefix' }],
    }))
    check('assert urlMatch 非法值报错',
      badUrlMatch === '第 1 条断言的 urlMatch "prefix" 不支持，可选 includes / glob / regex',
      String(badUrlMatch))

    const badRegex = await expectThrow(() => assertPage(session, {
      checks: [{ text: 'visible-Text' }, { url: '([', urlMatch: 'regex' }],
    }))
    check('assert url regex 非法报错带条目号',
      badRegex?.startsWith('第 2 条断言：url 的正则无效') && badRegex.includes('第 2 条断言：'),
      String(badRegex))

    const statement = await expectThrow(() => assertPage(session, {
      checks: [{ expression: 'a; b' }],
    }))
    const awaitSyntax = await expectThrow(() => assertPage(session, {
      checks: [{ expression: 'await 1' }],
    }))
    check('assert expression 语法非法在入参阶段报错',
      statement?.startsWith('第 1 条断言的 expression 语法无效：')
        && statement.includes('只能是表达式，不能含语句或顶层 await')
        && awaitSyntax?.startsWith('第 1 条断言的 expression 语法无效：'),
      JSON.stringify({ statement, awaitSyntax }))

    const badSelector = await expectThrow(() => assertPage(session, {
      checks: [{ selector: 'div[[' }],
    }))
    check('assert selector 语法非法抛错而不是判失败',
      badSelector?.startsWith('第 1 条断言的 selector 无效（div[[）：')
        && badSelector.includes('请修正 CSS 选择器'),
      String(badSelector))

    const notObject = await expectThrow(() => assertPage(session, { checks: [null] }))
    check('assert 某条不是对象报错',
      notObject === '第 1 条断言必须是对象', String(notObject))
  }

  console.log('== 目标与状态组 ==')
  {
    const tabB = await navigate(session, `${base}/assert-page?state=b`, 'load', { new_tab: true })
    // 再开一个 A 页作为 active tab，让待验证的 tab_id 不是 active tab。
    const tabA2 = await navigate(session, `${base}/assert-page?state=a`, 'load', { new_tab: true })
    const targeted = await assertPage(session, {
      checks: [{ text: 'B 页独有标记' }, { url: 'state=b' }],
      tab_id: tabB.tabId,
    })
    const activeBefore = currentTab(session).id
    check('assert 按 tab_id 只作用于指定标签页',
      targeted.tabId === tabB.tabId && targeted.pass === true
        && targeted.url.includes('state=b') && activeBefore === tabA2.tabId
        && activeBefore !== tabB.tabId
        && targeted.checks[1].actual.includes('state=b'),
      JSON.stringify({ tabB: tabB.tabId, tabA2: tabA2.tabId, activeBefore, targeted }))
    await closeTab(KEY, tabB.tabId)
    await closeTab(KEY, tabA2.tabId)

    const missingTab = await expectThrow(() => assertPage(session, {
      checks: [{ text: 'x' }], tab_id: 't99',
    }))
    check('assert tab_id 不存在报错',
      missingTab === 'tab t99 不存在，请先 browser_e2e_tabs 获取最新 tab_id',
      String(missingTab))

    const { sessionOf } = await import('../lib/session.js')
    const unstarted = sessionOf('test-assert-unstarted', 'test-assert-unstarted')
    const paramFirst = await expectThrow(() => assertPage(unstarted, { checks: [{ text: '' }] }))
    const notStarted = await expectThrow(() => assertPage(unstarted, { checks: [{ text: 'x' }] }))
    check('assert 未启动时报浏览器未启动',
      paramFirst === '第 1 条断言必须且只能给 selector / text / url / expression 之一，当前收到：无'
        && notStarted === '浏览器尚未启动或没有可用标签页，请先 browser_e2e_start',
      JSON.stringify({ paramFirst, notStarted }))

    await navigate(session, `${base}/assert-page?state=a`, 'load')
    const pageTab = currentTab(session)
    // 先建立 ref 表与快照基线，再验证断言不写这两处。
    await snapshot(session)
    const refsBefore = JSON.stringify([...pageTab.refs.entries()].map(([key, value]) => [key, value.xpath]))
    const baselinesBefore = JSON.stringify([...pageTab.snapshotBaselines].map(([, bucket]) =>
      [bucket.epoch, bucket.version, bucket.nextRef, bucket.keys.size]))
    await assertPage(session, {
      checks: [
        { selector: '#ok' },
        { text: '提交成功' },
        { url: 'assert-page' },
        { expression: 'window.__value' },
      ],
    })
    const refsAfter = JSON.stringify([...pageTab.refs.entries()].map(([key, value]) => [key, value.xpath]))
    const baselinesAfter = JSON.stringify([...pageTab.snapshotBaselines].map(([, bucket]) =>
      [bucket.epoch, bucket.version, bucket.nextRef, bucket.keys.size]))
    check('assert 不写 ref 表与快照基线',
      pageTab.refs.size > 0 && refsAfter === refsBefore && baselinesAfter === baselinesBefore,
      JSON.stringify({
        refs: pageTab.refs.size,
        baselinesBefore,
        refsBefore,
        refsAfter,
        baselinesAfter,
      }))

    const manyTab = await navigate(session, `${base}/many`, 'load', { new_tab: true })
    const many = await assertPage(session, { checks: [{ selector: '.hit' }], tab_id: manyTab.tabId })
    check('assert selector 命中超过 200 个只统计前 200 个',
      many.pass === true && many.checks[0].actual.includes('命中 201 个（可见 200 个，只统计前 200 个）'),
      JSON.stringify(many.checks[0]))
    await closeTab(KEY, manyTab.tabId)

    // 页面关闭：expression 正在页内执行时关掉该页，必须抛关闭错误而不是判失败。
    const closingTab = await navigate(session, `${base}/slow`, 'load', { new_tab: true })
    const closingPage = currentTab(session, closingTab.tabId).page
    const pending = assertPage(session, {
      checks: [{ expression: '(() => { const end = Date.now() + 800; while (Date.now() < end) {} return true })()' }],
      tab_id: closingTab.tabId,
    }).then(() => null, (error) => error?.message ?? String(error))
    await sleep(150)
    await closingPage.close()
    const closedMessage = await Promise.race([pending, sleep(5000).then(() => 'TIMEOUT')])
    check('assert 执行期间页面关闭抛错',
      closedMessage === `断言期间标签页已关闭（${closingTab.tabId}），请重新 browser_e2e_tabs 获取可用标签页`,
      String(closedMessage))
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
