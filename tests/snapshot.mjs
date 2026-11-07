/**
 * 快照增量 / 过滤 / 跨 frame（P0-3）验证。
 *
 * 覆盖 specs/功能规格/0012-snapshot-delta-query-frame.md「验收」第 1 条固定用例：
 *   delta 13 条、query 11 条、frame 11 条、其他 3 条。
 * 夹具：本地临时 HTTP 服务（同源 iframe、SPA、跨源 iframe 用第二个端口）+ data: URL，
 * 不依赖外网。直接调用 lib/page.js / lib/session.js 的真实实现，真起无头 Edge。
 *
 * 运行：node tests/snapshot.mjs
 * 结束时断言 msedge 主进程回落到运行前基线（不看绝对值）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { click, currentTab, evaluate, navigate, scroll, snapshot } = await import('../lib/page.js')

const KEY = 'test-snapshot-key'
const SID = 'test-snapshot-session'
let session = null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** 把 HTML 包成 data: URL（夹具里含 `#` 等字符时必须编码）。 */
function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** 轮询直到条件成立；进程退出与 frame 挂载都是异步的。 */
async function waitUntil(fn, timeoutMs = 10000, stepMs = 100) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(stepMs)
  }
}

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

const htmlPage = (title, body) => '<!doctype html><html><head><meta charset="utf-8">'
  + `<title>${title}</title><style>body{margin:0;font:14px sans-serif}</style></head><body>${body}</body></html>`

/** 视口内固定位置按钮，保证快照可见。 */
const fixedButton = (id, label, left, top, onclick = '') => '<button id="' + id + '"'
  + ` style="position:fixed;left:${left}px;top:${top}px;width:150px;height:36px"`
  + (onclick ? ` onclick="${onclick}"` : '') + `>${label}</button>`

let crossBase = ''
const server = createServer((req, res) => {
  const path = String(req.url || '').split('?')[0]
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  if (path === '/delta-base') {
    return send(htmlPage('delta-base', fixedButton('base-btn', 'Base', 10, 10)))
  }
  if (path === '/delta-next') {
    return send(htmlPage('delta-next', fixedButton('next-btn', 'Next', 10, 10)))
  }
  if (path === '/spa') {
    return send(htmlPage('spa', fixedButton('spa-btn', 'SPA', 10, 10)
      + '<div id="spa-slot" style="position:fixed;left:10px;top:80px;width:120px;height:40px">slot</div>'))
  }
  if (path === '/frame-a') {
    return send(htmlPage('frame-a', fixedButton('inner-a', 'Inner A', 10, 10)
      + '<input id="inner-input" placeholder="inner" style="position:fixed;left:10px;top:60px;width:180px;height:30px">'))
  }
  if (path === '/frame-b') {
    return send(htmlPage('frame-b', fixedButton('inner-b', 'Inner B', 10, 10)))
  }
  if (path === '/outer-srcdoc') {
    const srcdoc = '<iframe id="f1" name="inner" style="position:fixed;left:10px;top:90px;width:400px;height:200px;border:0"'
      + ' srcdoc="<button id=\'in1\' style=\'position:fixed;left:10px;top:10px;width:160px;height:36px\''
      + ' onclick=\'window.__in=1\'>Inside Button</button>"></iframe>'
    return send(htmlPage('outer-srcdoc', fixedButton('outer-btn', 'Outer Button', 10, 10, 'window.__outer=true') + srcdoc))
  }
  if (path === '/outer-url') {
    const frame = '<iframe id="f1" name="named-frame" src="/frame-a"'
      + ' style="position:fixed;left:10px;top:90px;width:400px;height:200px;border:0"></iframe>'
    return send(htmlPage('outer-url', fixedButton('outer-url-btn', 'Outer URL', 10, 10) + frame))
  }
  if (path === '/outer-multi') {
    const frames = '<iframe id="fa" src="/frame-a" style="position:fixed;left:10px;top:90px;width:300px;height:180px;border:0"></iframe>'
      + '<iframe id="fb" src="/frame-b" style="position:fixed;left:10px;top:300px;width:300px;height:180px;border:0"></iframe>'
    return send(htmlPage('outer-multi', frames))
  }
  if (path === '/outer-cross') {
    const frame = `<iframe id="fc" src="${crossBase}/frame-cross"`
      + ' style="position:fixed;left:10px;top:90px;width:400px;height:200px;border:0"></iframe>'
    return send(htmlPage('outer-cross', frame))
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// 跨源 frame：同一主机不同端口即不同 origin，另一个本地服务提供 iframe 内容。
const crossServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(htmlPage('frame-cross', fixedButton('cross-btn', 'Cross', 10, 10)))
})
await new Promise((resolve) => crossServer.listen(0, '127.0.0.1', resolve))
crossBase = `http://127.0.0.1:${crossServer.address().port}`

/** t1 的导航：data: / 本地服务两条路径，都显式带 tab_id。 */
const nav = (html) => navigate(session, dataUrl(html), 'load', { tab_id: 't1' })
const navUrl = (path, tabId = 't1') => navigate(session, `${base}${path}`, 'load', { tab_id: tabId })
const snapT1 = (options) => snapshot(session, 't1', options)

/** 取某 tab 当前的 frame 列表（主文档在 0）。 */
function framesOf(tabId) {
  return currentTab(session, tabId).page.frames()
}

/** 等到目标页挂上足够多的 frame，且额外条件成立。 */
async function waitFrames(tabId, count, predicate) {
  return waitUntil(() => {
    const frames = framesOf(tabId)
    return frames.length >= count && (!predicate || frames.some(predicate))
  }, 8000)
}

const baseline = edgeRootCount()
let t2Id = null

try {
  console.log('== 启动 ==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    assert.equal(info.reused, false, JSON.stringify(info))
    assert.equal(session.pages.size, 1)
    await navUrl('/delta-base')
    console.log(`  PASS  浏览器启动（${info.summary}）`)
  }

  console.log('== delta 组 ==')
  {
    await nav('<body style="margin:0">' + fixedButton('stable', 'Stable', 10, 10) + '</body>')
    const first = await snapT1()
    assert.equal(first.mode, 'full')
    const info = await snapT1({ delta: true })
    check('delta 无变化返回三零与提示', info.mode === 'delta' && info.baseline === 'ok'
      && info.addedCount === 0 && info.changedCount === 0 && info.removedCount === 0
      && info.unchangedCount > 0 && info.text.includes('（无可见变化）')
      && info.summary.includes('新增 0') && info.summary.includes('变化 0') && info.summary.includes('移除 0'),
    JSON.stringify({ mode: info.mode, baseline: info.baseline, counts: [info.addedCount, info.changedCount, info.removedCount], summary: info.summary }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('origin', 'Origin', 10, 10) + '</body>')
    const first = await snapT1()
    assert.equal(first.count, 1, JSON.stringify({ count: first.count }))
    await evaluate(session, "(() => { const b = document.createElement('button'); b.id = 'added';"
      + " b.textContent = 'Added'; b.style.cssText = 'position:fixed;left:10px;top:80px;width:150px;height:36px';"
      + ' document.body.appendChild(b); return true })()', 't1')
    const info = await snapT1({ delta: true })
    check('delta 新增节点带新 ref', info.baseline === 'ok' && info.addedCount === 1
      && info.added[0]?.id === 'added' && info.added[0]?.ref === `@${first.count}`
      && info.summary.includes('新增 1'),
    JSON.stringify({ added: info.added, summary: info.summary }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('origin2', 'Origin 2', 10, 10) + '</body>')
    await snapT1()
    await evaluate(session, "(() => { const b = document.createElement('button'); b.id = 'added-click';"
      + " b.textContent = 'Added Click'; b.style.cssText = 'position:fixed;left:10px;top:80px;width:150px;height:36px';"
      + " b.onclick = function () { window.__addedClick = true }; document.body.appendChild(b); return true })()", 't1')
    const info = await snapT1({ delta: true })
    const addedRef = info.added.find((item) => item.id === 'added-click')?.ref
    const clicked = addedRef ? await click(session, { ref: addedRef }, 't1') : null
    const flag = await evaluate(session, 'window.__addedClick === true', 't1')
    check('新增 ref 可点击', Boolean(addedRef) && flag.value === true,
      JSON.stringify({ addedRef, clicked, flag: flag.value }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('keep', 'Keep', 10, 10) + fixedButton('gone', 'Gone', 10, 80) + '</body>')
    const first = await snapT1()
    const goneRef = first.nodes.find((node) => node.id === 'gone')?.ref
    assert.ok(goneRef, JSON.stringify(first.nodes.map((node) => node.id)))
    await evaluate(session, "document.getElementById('gone').remove()", 't1')
    const info = await snapT1({ delta: true })
    const removed = info.removed.find((item) => item.ref === goneRef)
    check('delta 删除节点列出旧 ref', info.baseline === 'ok' && info.removedCount === 1
      && Boolean(removed) && removed.tag === 'button' && removed.name === 'Gone'
      && typeof removed.xpath === 'string' && removed.xpath.includes('gone'),
    JSON.stringify({ goneRef, removed: info.removed }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('keep2', 'Keep 2', 10, 10) + fixedButton('gone2', 'Gone 2', 10, 80) + '</body>')
    const first = await snapT1()
    const goneRef = first.nodes.find((node) => node.id === 'gone2')?.ref
    await evaluate(session, "document.getElementById('gone2').remove()", 't1')
    const info = await snapT1({ delta: true })
    const message = await expectThrow(() => click(session, { ref: goneRef }, 't1'))
    check('被移除的 ref 再点击报不存在', info.removed.some((item) => item.ref === goneRef)
      && Boolean(message) && message.includes('不存在') && message.includes('browser_e2e_snapshot'),
    JSON.stringify({ goneRef, message }))
  }

  {
    await nav('<body style="margin:0"><div id="tx" style="position:fixed;left:10px;top:10px;width:200px;height:40px">one</div></body>')
    const first = await snapT1()
    const ref = first.nodes.find((node) => node.id === 'tx')?.ref
    await evaluate(session, "(() => { const el = document.getElementById('tx'); el.textContent = 'two'; el.className = 'a b'; return true })()", 't1')
    const info = await snapT1({ delta: true })
    const changed = info.changed[0]
    check('delta 文本变化带 changedFields', info.baseline === 'ok' && info.changedCount === 1
      && changed?.ref === ref && Array.isArray(changed.changedFields)
      && changed.changedFields.includes('text') && changed.changedFields.includes('classes'),
    JSON.stringify({ ref, changed }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('mv', 'Move', 10, 10) + '</body>')
    await snapT1()
    await evaluate(session, "document.getElementById('mv').style.left = '210px'", 't1')
    const moved = await evaluate(session, "Math.round(document.getElementById('mv').getBoundingClientRect().x)", 't1')
    const info = await snapT1({ delta: true })
    check('delta 仅位置移动不报变化', moved.value === 210 && info.baseline === 'ok'
      && info.addedCount === 0 && info.changedCount === 0 && info.removedCount === 0
      && info.text.includes('（无可见变化）'),
    JSON.stringify({ movedX: moved.value, counts: [info.addedCount, info.changedCount, info.removedCount] }))
  }

  {
    await nav('<body style="margin:0"><div style="height:2200px;background:#eeeeee"></div>'
      + fixedButton('fixed-btn', 'Fixed', 10, 10) + '</body>')
    await snapT1()
    await scroll(session, { delta_y: 300 }, 't1')
    // mouse.wheel 只负责派发，滚动位置与布局移动需要等一帧；
    // 不等待会读到滚动前的 scrollY，属测试自身的时序问题。
    await sleep(200)
    const scrollY = await evaluate(session, 'window.scrollY', 't1')
    const info = await snapT1({ delta: true })
    check('delta 滚动不报变化', scrollY.value > 0 && info.baseline === 'ok'
      && info.addedCount === 0 && info.changedCount === 0 && info.removedCount === 0,
    JSON.stringify({ scrollY: scrollY.value, counts: [info.addedCount, info.changedCount, info.removedCount] }))
  }

  {
    const created = await navigate(session, dataUrl('<body style="margin:0">' + fixedButton('fresh', 'Fresh', 10, 10) + '</body>'),
      'load', { new_tab: true })
    t2Id = created.tabId
    assert.equal(created.newTab, true, JSON.stringify(created))
    const info = await snapshot(session, t2Id, { delta: true })
    check('首帧 delta 退化为全量（baseline=missing）', info.mode === 'delta' && info.baseline === 'missing'
      && Array.isArray(info.nodes) && info.nodes.length > 0 && info.nodes[0]?.ref === '@0'
      && info.text.startsWith('无增量基线') && info.addedCount === 0,
    JSON.stringify({ baseline: info.baseline, nodes: info.nodes?.length, text: info.text.slice(0, 40) }))
  }

  {
    await navUrl('/delta-base')
    await snapT1()
    await navUrl('/delta-next')
    const info = await snapT1({ delta: true })
    check('新文档后 delta 退化为全量（baseline=reset）', info.mode === 'delta' && info.baseline === 'reset'
      && Array.isArray(info.nodes) && info.nodes[0]?.ref === '@0' && info.text.startsWith('无增量基线'),
    JSON.stringify({ baseline: info.baseline, nodes: info.nodes?.length, text: info.text.slice(0, 40) }))
  }

  {
    await navUrl('/spa')
    const first = await snapT1()
    assert.equal(first.mode, 'full')
    await evaluate(session, "history.pushState({}, '', '/spa-route'); location.pathname", 't1')
    const info = await snapT1({ delta: true })
    check('SPA 路由后 delta 基线保留', info.baseline === 'ok' && info.addedCount === 0
      && info.changedCount === 0 && info.removedCount === 0 && info.version >= 2,
    JSON.stringify({ baseline: info.baseline, version: info.version }))
  }

  {
    await nav('<body style="margin:0"><script>for (let i = 0; i < 4100; i += 1) {'
      + ' const b = document.createElement("button"); b.id = "b" + i; b.textContent = "b" + i;'
      + ' document.body.appendChild(b) }</script></body>')
    const first = await snapT1()
    const info = await snapT1({ delta: true })
    check('delta 只对比前 4000 个节点并标 truncated', first.count === 4000 && first.truncated === true
      && info.truncated === true && info.total === 4100 && info.unchangedCount === 4000
      && info.text.includes('只对比前 4000'),
    JSON.stringify({ count: first.count, total: info.total, unchanged: info.unchangedCount, truncated: info.truncated }))
  }

  {
    const message = await expectThrow(() => snapT1({ delta: true, query: { text: 'x' } }))
    check('delta 与 query 同用报互斥', Boolean(message) && message.includes('delta') && message.includes('query')
      && /互斥|不能同时使用/.test(message),
    String(message))
  }

  console.log('== query 组 ==')
  {
    await nav('<body style="margin:0">' + fixedButton('q1', 'Q1', 10, 10, 'window.__q1=true') + '</body>')
    const info = await snapT1({ query: { selector: '#q1' } })
    const selector = info.matches[0]?.selector
    if (selector) await click(session, { selector }, 't1')
    const flag = await evaluate(session, 'window.__q1 === true', 't1')
    check('query selector 命中且 selector 可点击', info.mode === 'query' && info.count === 1
      && info.totalMatched === 1 && info.matches[0]?.id === 'q1' && selector === '#q1'
      && flag.value === true,
    JSON.stringify({ mode: info.mode, count: info.count, totalMatched: info.totalMatched, matches: info.matches, flag: flag.value }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('save-btn', 'Save Draft', 10, 10)
      + fixedButton('del-btn', 'Delete', 10, 80) + '</body>')
    const info = await snapT1({ query: { text: 'save' } })
    check('query text 命中', info.mode === 'query' && info.count === 1 && info.totalMatched === 1
      && info.matches[0]?.id === 'save-btn' && info.matches[0]?.name.includes('Save'),
    JSON.stringify({ count: info.count, matches: info.matches.map((item) => ({ id: item.id, name: item.name })) }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('r1', 'B1', 10, 10)
      + '<input id="r2" placeholder="x" style="position:fixed;left:10px;top:80px;width:180px;height:30px">'
      + '<div role="alert" id="r3" style="position:fixed;left:10px;top:130px;width:120px;height:40px">A</div></body>')
    const byButton = await snapT1({ query: { role: 'button' } })
    const byTextbox = await snapT1({ query: { role: 'textbox' } })
    const byAlert = await snapT1({ query: { role: 'alert' } })
    check('query role 命中', byButton.count === 1 && byButton.matches[0]?.id === 'r1'
      && byTextbox.count === 1 && byTextbox.matches[0]?.id === 'r2'
      && byAlert.count === 1 && byAlert.matches[0]?.id === 'r3',
    JSON.stringify({ button: byButton.matches.map((item) => item.id), textbox: byTextbox.matches.map((item) => item.id), alert: byAlert.matches.map((item) => item.id) }))
  }

  {
    let buttons = ''
    for (let i = 0; i < 5; i += 1) buttons += fixedButton(`lim-${i}`, `Limit ${i}`, 10, 10 + i * 50)
    await nav(`<body style="margin:0">${buttons}</body>`)
    const one = await snapT1({ query: { selector: 'button', limit: 1 } })
    const hundred = await snapT1({ query: { selector: 'button', limit: 100 } })
    check('query limit 边界', one.count === 1 && one.totalMatched === 5 && one.truncated === true
      && one.matches.length === 1
      && hundred.count === 5 && hundred.totalMatched === 5 && hundred.truncated === false
      && hundred.matches.length === 5,
    JSON.stringify({ one: { count: one.count, total: one.totalMatched, truncated: one.truncated }, hundred: { count: hundred.count, total: hundred.totalMatched, truncated: hundred.truncated } }))
  }

  {
    const zero = await expectThrow(() => snapT1({ query: { selector: 'button', limit: 0 } }))
    const tooBig = await expectThrow(() => snapT1({ query: { selector: 'button', limit: 101 } }))
    const fraction = await expectThrow(() => snapT1({ query: { selector: 'button', limit: 1.5 } }))
    check('query limit 越界报错', [zero, tooBig, fraction].every((message) => Boolean(message) && message.includes('limit')),
      JSON.stringify({ zero, tooBig, fraction }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('mutex', 'Mutex', 10, 10) + '</body>')
    const message = await expectThrow(() => snapT1({ query: { text: 'mutex', selector: '#mutex' } }))
    check('query text 与 selector 互斥报错', Boolean(message) && message.includes('互斥')
      && message.includes('text') && message.includes('selector'),
    String(message))
  }

  {
    const message = await expectThrow(() => snapT1({ query: {} }))
    check('query 三者都不给报错', Boolean(message) && message.includes('至少需要')
      && message.includes('text') && message.includes('selector') && message.includes('role'),
    String(message))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('badsel', 'Bad Selector', 10, 10) + '</body>')
    const message = await expectThrow(() => snapT1({ query: { selector: 'foo(' } }))
    check('query 非法 selector 报错', Boolean(message) && message.includes('不是合法 CSS 选择器')
      && !message.includes('SyntaxError'),
    String(message))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('nomatch', 'No Match', 10, 10) + '</body>')
    const info = await snapT1({ query: { text: '完全不存在的文本' } })
    check('query 未命中不抛错', info.mode === 'query' && info.count === 0 && info.totalMatched === 0
      && Array.isArray(info.matches) && info.matches.length === 0 && info.text.includes('未命中'),
    JSON.stringify({ count: info.count, totalMatched: info.totalMatched, text: info.text }))
  }

  {
    await nav('<body style="margin:0"><div id="vis" style="position:fixed;left:10px;top:10px;width:80px;height:40px">V</div>'
      + '<div id="hid" style="display:none">H</div></body>')
    const off = await snapT1({ query: { selector: 'div' } })
    const on = await snapT1({ query: { selector: 'div', includeHidden: true } })
    const hidden = on.matches.find((item) => item.id === 'hid')
    const visible = on.matches.find((item) => item.id === 'vis')
    check('query includeHidden 生效', off.count === 1 && off.matches[0]?.id === 'vis'
      && on.count === 2 && hidden?.hidden === true && Boolean(visible) && visible.hidden === undefined,
    JSON.stringify({ off: off.matches.map((item) => item.id), on: on.matches.map((item) => ({ id: item.id, hidden: item.hidden })) }))
  }

  {
    await nav('<body style="margin:0">' + fixedButton('keep-ref', 'Keep Ref', 10, 10, 'window.__keepRef=true') + '</body>')
    const first = await snapT1()
    const ref = first.nodes.find((node) => node.id === 'keep-ref')?.ref
    await snapT1({ query: { text: 'keep' } })
    await click(session, { ref }, 't1')
    const flag = await evaluate(session, 'window.__keepRef === true', 't1')
    // query 之后换文档再 delta：基线仍是「已失效」而不是被 query 重建的 'ok'。
    await nav('<body style="margin:0">' + fixedButton('other', 'Other', 10, 10) + '</body>')
    await snapT1({ query: { text: 'other' } })
    const after = await snapT1({ delta: true })
    check('query 不改变 ref 表', flag.value === true && after.baseline === 'reset'
      && Array.isArray(after.nodes) && after.nodes.length > 0,
    JSON.stringify({ flag: flag.value, baseline: after.baseline }))
  }

  console.log('== frame 组 ==')
  {
    await navUrl('/outer-srcdoc')
    assert.ok(await waitFrames('t1', 2), JSON.stringify(framesOf('t1').map((frame) => frame.url())))
    const withFrame0 = await snapT1({ frame: 0 })
    const plain = await snapT1()
    check('frame 索引 0 等价主文档', withFrame0.mode === 'full' && withFrame0.frame.index === 0
      && withFrame0.frame.parentIndex === null && plain.frame.index === 0
      && withFrame0.frame.url === plain.frame.url
      && withFrame0.count === plain.count
      && JSON.stringify(withFrame0.nodes.map((node) => node.id)) === JSON.stringify(plain.nodes.map((node) => node.id)),
    JSON.stringify({ frame0: withFrame0.frame, counts: [withFrame0.count, plain.count] }))
  }

  {
    await navUrl('/outer-srcdoc')
    assert.ok(await waitFrames('t1', 2))
    const info = await snapT1({ frame: 1 })
    check('frame 索引 1 读到同源 iframe', info.mode === 'full' && info.frame.index === 1
      && info.frame.parentIndex === 0 && info.frame.name === 'inner' && info.frame.url === 'about:srcdoc'
      && info.count >= 1 && info.nodes.every((node) => node.ref === null)
      && info.nodes.some((node) => node.id === 'in1') && !/\[\d+\]/.test(info.text)
      && info.text.includes('子 frame 只读'),
    JSON.stringify({ frame: info.frame, count: info.count, nodes: info.nodes.map((node) => ({ id: node.id, ref: node.ref })), text: info.text }))
  }

  {
    await navUrl('/outer-url')
    assert.ok(await waitFrames('t1', 2, (frame) => frame.name() === 'named-frame'))
    const info = await snapT1({ frame: 'named-frame' })
    check('frame 按 name 定位', info.frame.index === 1 && info.frame.name === 'named-frame'
      && info.nodes.some((node) => node.id === 'inner-a'),
    JSON.stringify({ frame: info.frame, nodes: info.nodes.map((node) => node.id) }))
  }

  {
    await navUrl('/outer-url')
    assert.ok(await waitFrames('t1', 2, (frame) => frame.url().includes('/frame-a')))
    const info = await snapT1({ frame: '/frame-a' })
    check('frame 按 url 子串定位', info.frame.index === 1 && info.frame.url.includes('/frame-a')
      && info.nodes.some((node) => node.id === 'inner-a'),
    JSON.stringify({ frame: info.frame, nodes: info.nodes.map((node) => node.id) }))
  }

  {
    await navUrl('/outer-url')
    assert.ok(await waitFrames('t1', 2))
    const message = await expectThrow(() => snapT1({ frame: 5 }))
    check('frame 越界报错', Boolean(message) && message.includes('不存在')
      && message.includes('0（主文档）') && message.includes('/frame-a'),
    String(message))
  }

  {
    await navUrl('/outer-url')
    assert.ok(await waitFrames('t1', 2))
    const message = await expectThrow(() => snapT1({ frame: 'no-such-frame' }))
    check('frame 未命中报错', Boolean(message) && message.includes('未找到')
      && message.includes('当前页可用索引') && message.includes('0（主文档）'),
    String(message))
  }

  {
    await navUrl('/outer-multi')
    assert.ok(await waitFrames('t1', 3))
    const message = await expectThrow(() => snapT1({ frame: '/frame' }))
    check('frame 多命中报错', Boolean(message) && message.includes('命中 2 个')
      && message.includes('请改用 frame 索引'),
    String(message))
  }

  {
    await navUrl('/outer-cross')
    assert.ok(await waitFrames('t1', 2, (frame) => frame.url().includes(crossBase)), JSON.stringify(framesOf('t1').map((frame) => frame.url())))
    const message = await expectThrow(() => snapT1({ frame: 1 }))
    check('frame 跨源报错', Boolean(message) && message.includes('跨源') && message.includes('P0-3'),
      String(message))
  }

  {
    await navUrl('/outer-srcdoc')
    assert.ok(await waitFrames('t1', 2))
    const main = await snapT1()
    const outerRef = main.nodes.find((node) => node.id === 'outer-btn')?.ref
    assert.ok(outerRef, JSON.stringify(main.nodes.map((node) => node.id)))
    const sub = await snapT1({ frame: 1 })
    await click(session, { ref: outerRef }, 't1')
    const flag = await evaluate(session, 'window.__outer === true', 't1')
    const delta = await snapT1({ delta: true })
    check('子 frame 快照不污染主文档 ref', sub.nodes.every((node) => node.ref === null)
      && flag.value === true
      && delta.baseline === 'ok' && delta.addedCount === 0 && delta.changedCount === 0 && delta.removedCount === 0,
    JSON.stringify({ outerRef, flag: flag.value, delta: { baseline: delta.baseline, added: delta.addedCount, changed: delta.changedCount, removed: delta.removedCount } }))
  }

  {
    await navUrl('/outer-srcdoc')
    assert.ok(await waitFrames('t1', 2))
    const first = await snapT1({ frame: 1 })
    assert.equal(first.mode, 'full')
    await evaluate(session, "(() => { const d = document.getElementById('f1').contentDocument;"
      + " const b = d.createElement('button'); b.id = 'in2'; b.textContent = 'Inside Two';"
      + ' d.body.appendChild(b); return d.querySelectorAll("button").length })()', 't1')
    const info = await snapT1({ frame: 1, delta: true })
    check('frame + delta 报子 frame 变化', info.mode === 'delta' && info.baseline === 'ok'
      && info.frame.index === 1 && info.addedCount === 1 && info.added[0]?.id === 'in2'
      && info.added[0]?.ref === null && info.text.includes('新增 1'),
    JSON.stringify({ baseline: info.baseline, added: info.added, text: info.text.slice(0, 120) }))
  }

  {
    await navUrl('/outer-srcdoc')
    assert.ok(await waitFrames('t1', 2))
    await snapT1()
    const info = await snapT1({ frame: 1, query: { text: 'inside' } })
    check('frame + query 返回 ref=null', info.mode === 'query' && info.frame.index === 1
      && info.count === 1 && info.matches[0]?.ref === null
      && typeof info.matches[0]?.selector === 'string' && info.matches[0].selector.length > 0,
    JSON.stringify({ frame: info.frame, count: info.count, matches: info.matches }))
  }

  console.log('== 其他 ==')
  {
    await navUrl('/delta-base', 't1')
    await snapT1()
    await navUrl('/delta-base', t2Id)
    await snapshot(session, t2Id)
    await evaluate(session, "(() => { const b = document.createElement('button'); b.id = 't2-only';"
      + " b.textContent = 'T2 Only'; b.style.cssText = 'position:fixed;left:10px;top:80px;width:150px;height:36px';"
      + ' document.body.appendChild(b); return true })()', t2Id)
    const d1 = await snapT1({ delta: true })
    const d2 = await snapshot(session, t2Id, { delta: true })
    check('t1 与 t2 的 delta 基线互不影响', d1.baseline === 'ok'
      && d1.addedCount === 0 && d1.changedCount === 0 && d1.removedCount === 0
      && d2.baseline === 'ok' && d2.addedCount === 1 && d2.added[0]?.id === 't2-only',
    JSON.stringify({ t1: { baseline: d1.baseline, added: d1.addedCount }, t2: { baseline: d2.baseline, added: d2.addedCount } }))
  }

  {
    const message = await expectThrow(() => snapshot(session, 't99'))
    check('未知 tab 报既有文案', Boolean(message) && message.includes('t99 不存在')
      && message.includes('browser_e2e_tabs'),
    String(message))
  }

  {
    await navUrl('/delta-next')
    const info = await snapshot(session)
    check('缺省快照仍为全量且 truncated=false', info.tabId === 't1' && info.mode === 'full'
      && info.truncated === false && info.scanTruncated === false
      && info.frame.index === 0 && info.frame.parentIndex === null && info.count > 0
      && info.nodes.every((node, index) => node.ref === `@${index}`),
    JSON.stringify({ tabId: info.tabId, mode: info.mode, count: info.count, truncated: info.truncated, frame: info.frame }))
  }
} finally {
  await closeAll()
  server.close()
  crossServer.close()
}

console.log('')
const settled = await waitUntil(() => edgeRootCount() <= baseline, 15000)
const remaining = edgeRootCount()
check('msedge 主进程回落到运行前基线', settled && remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）`)
process.exit(fail === 0 ? 0 : 1)
