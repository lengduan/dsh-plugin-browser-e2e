/**
 * iframe 内元素操作（功能规格 0018，方案 A1）验收。
 *
 * 覆盖：frame 索引 / name 定位、frame 内 selector 点击与填写、frame 内滚动、
 * frame 0 与不传等价、嵌套 frame、跨源 frame（D1 实测结论）、参数互斥与越界报错。
 * 直接调用 page.js / snapshot.js 的真实实现（不 mock），真起无头 Edge + 本地 HTTP 夹具。
 *
 * 运行：node tests/frames.mjs
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { click, fill, navigate, press, scroll } = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')

const KEY = 'test-frames-key'
const SID = 'test-frames-session'
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

async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 等 Edge 主进程回落到基线：进程退出比 closeAll 返回晚，最多等 5 秒。 */
async function waitProcessExit(baselineCount, timeoutMs = 5000) {
  let count = edgeRootCount()
  const deadline = Date.now() + timeoutMs
  while (count > baselineCount && Date.now() < deadline) {
    await sleep(200)
    count = edgeRootCount()
  }
  return count
}

/** 子 frame 页面：scroller 铺满整个 frame，中心滚轮能命中它。 */
const FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head>'
  + '<body style="margin:0"><div id="scroller" style="position:fixed;inset:0;overflow:auto">'
  + '<button id="inner-btn" style="position:absolute;left:20px;top:20px;width:160px;height:40px"'
  + ' onclick="window.__clicked=(window.__clicked||0)+1">inner</button>'
  + '<input id="inner-input" style="position:absolute;left:20px;top:90px;width:200px">'
  + '<div style="height:2400px"></div>'
  + '</div></body></html>'

/** 嵌套页面：内层再放一个 iframe。 */
const NESTED_HTML = '<!doctype html><html><body style="margin:0">'
  + '<button id="nested-btn" style="position:absolute;left:10px;top:10px;width:120px;height:30px"'
  + ' onclick="window.__nestedClicked=true">nested</button></body></html>'

const FRAME_WITH_NESTED = '<!doctype html><html><body style="margin:0">'
  + '<iframe name="nested-frame" src="/nested" style="position:absolute;left:0;top:0;width:300px;height:200px"></iframe>'
  + '</body></html>'

/** 第二个子 frame 页面：同 selector 指向新文档，用于「frame 导航后 selector 重新解析」。 */
const FRAME2_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>frame2</title></head>'
  + '<body style="margin:0">'
  + '<button id="inner-btn" style="position:absolute;left:20px;top:20px;width:160px;height:40px"'
  + ' onclick="window.__second=(window.__second||0)+1">second</button>'
  + '</body></html>'

/** 主页面：一个同源 iframe。 */
const MAIN_HTML = '<!doctype html><html><body style="margin:0">'
  + '<button id="main-btn" style="position:absolute;left:10px;top:10px" onclick="window.__mainClicked=true">main</button>'
  + '<iframe name="frame-one" src="/frame" style="position:absolute;left:300px;top:10px;width:600px;height:400px"></iframe>'
  + '</body></html>'

const NESTED_MAIN = '<!doctype html><html><body style="margin:0">'
  + '<iframe name="outer-frame" src="/frame-nested" style="position:absolute;left:100px;top:10px;width:500px;height:300px"></iframe>'
  + '</body></html>'

/** 跨源主页面：iframe 指向另一个 host 的端口。 */
function crossMainHtml(crossUrl) {
  return '<!doctype html><html><body style="margin:0">'
    + `<iframe name="cross-frame" src="${crossUrl}" style="position:absolute;left:100px;top:10px;width:600px;height:400px"></iframe>`
    + '</body></html>'
}

async function serve(port, routes) {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    const body = routes[path]
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

/** 当前 active tab 的 page。 */
function pageOf(session) {
  return [...session.pages.values()][0].page
}

/** 等页面里出现至少 n 个 frame。 */
async function waitFrames(page, n, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.frames().length >= n) return true
    await sleep(100)
  }
  return false
}

/** 取索引对应的子 frame（与 frame.js 的编号一致：过滤主文档）。 */
function childFrame(page, index) {
  const main = page.mainFrame()
  const list = [main, ...page.frames().filter((frame) => frame !== main)]
  return list[index]
}

const baseline = edgeRootCount()
let session = null
let serverA = null
let serverB = null

try {
  const portA = 34721
  const portB = 34722
  const crossUrl = `http://localhost:${portB}/frame`
  serverA = await serve(portA, {
    '/': MAIN_HTML,
    '/frame': FRAME_HTML,
    '/frame2': FRAME2_HTML,
    '/nested': NESTED_HTML,
    '/frame-nested': FRAME_WITH_NESTED,
    '/nested-main': NESTED_MAIN,
  })
  serverB = await serve(portB, { '/frame': FRAME_HTML, '/cross-main': crossMainHtml(crossUrl) })

  const base = `http://127.0.0.1:${portA}`
  await launch(KEY, { headless: true }, SID)
  session = requireSession(KEY)

  console.log('== 用例 1：同源 frame 内点击 / 填写 / name 定位 ==')
  await navigate(session, `${base}/`)
  let page = pageOf(session)
  check('子 frame 已加载', await waitFrames(page, 2), String(page.frames().length))

  const clickResult = await click(session, { selector: '#inner-btn', frame: 1 })
  const frame1 = childFrame(page, 1)
  const clicked = await frame1.evaluate(() => window.__clicked === 1)
  check('frame 1 内 selector 点击生效', clicked === true, JSON.stringify(clickResult))
  check('点击返回值带 frame 信息且摘要带后缀',
    clickResult.frame?.index === 1 && clickResult.summary.includes('（frame 1'), JSON.stringify(clickResult))

  await fill(session, { selector: '#inner-input', frame: 1 }, 'hello-frame')
  const filled = await frame1.evaluate(() => document.querySelector('#inner-input').value)
  check('frame 1 内 selector 填写生效', filled === 'hello-frame', String(filled))

  // 焦点进 frame：先把焦点交给子 frame 内的输入框，再发按键，键事件应落在该 frame 的文档上。
  await frame1.evaluate(() => {
    window.__keys = []
    document.addEventListener('keydown', (event) => window.__keys.push(event.key))
  })
  await click(session, { selector: '#inner-input', frame: 1 })
  await press(session, 'a')
  const keysInFrame = await frame1.evaluate(() => window.__keys)
  check('frame 1 内点击后 press 生效', Array.isArray(keysInFrame) && keysInFrame.includes('a'),
    JSON.stringify(keysInFrame))

  // 坐标始终是主视口 CSS 像素：iframe 元素的 boundingBox 加上元素在子 frame 内的位置。
  const innerBox = await frame1.evaluate(() => {
    const rect = document.querySelector('#inner-btn').getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  // iframe 在主文档里的位置：主视口坐标 = iframe 的 getBoundingClientRect + 元素在子 frame 内的位置。
  const frameRect = await page.evaluate(() => {
    const rect = document.querySelector('iframe[name="frame-one"]').getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })
  const beforeCoord = await frame1.evaluate(() => window.__clicked ?? 0)
  const coordX = Math.round(frameRect.x + innerBox.x)
  const coordY = Math.round(frameRect.y + innerBox.y)
  await click(session, { x: coordX, y: coordY })
  const afterCoord = await frame1.evaluate(() => window.__clicked ?? 0)
  check('frame 内坐标点击按主视口命中', afterCoord === beforeCoord + 1,
    `${beforeCoord} -> ${afterCoord} at (${coordX}, ${coordY})`)

  const beforeName = await frame1.evaluate(() => window.__clicked)
  await click(session, { selector: '#inner-btn', frame: 'frame-one' })
  const afterName = await frame1.evaluate(() => window.__clicked)
  check('frame 按 name 定位 selector 点击', afterName === beforeName + 1, `${beforeName} -> ${afterName}`)

  console.log('== 用例 2：frame 0 与不传等价、滚动 ==')
  const byZero = await click(session, { selector: '#main-btn', frame: 0 })
  const byNone = await click(session, { selector: '#main-btn' })
  const mainClicked = await page.evaluate(() => window.__mainClicked === true)
  check('frame 0 与不传 frame 等价', byZero.summary === byNone.summary && byZero.frame === undefined && mainClicked, `${byZero.summary} / ${byNone.summary}`)

  await scroll(session, { delta_y: 400, frame: 1 })
  await sleep(300)
  const scrollTop = await frame1.evaluate(() => document.querySelector('#scroller').scrollTop)
  check('frame 1 内滚动生效', scrollTop > 0, String(scrollTop))

  const scrollMix = await expectThrow(() => scroll(session, { delta_y: 100, x: 50, y: 50, frame: 1 }))
  check('scroll 的 frame 与坐标互斥报错', typeof scrollMix === 'string' && scrollMix.includes('只能给一种'), String(scrollMix))

  // 子 frame 导航：frame 对象保持不变，selector 在新文档里重新解析，不会命中旧元素。
  await frame1.evaluate(() => { window.location.href = '/frame2' })
  const frameDeadline = Date.now() + 10000
  let frameReloaded = false
  while (Date.now() < frameDeadline) {
    frameReloaded = await frame1.evaluate(() => document.readyState === 'complete'
      && Boolean(document.querySelector('#inner-btn'))).catch(() => false)
    if (frameReloaded) break
    await sleep(100)
  }
  const navFrameClick = await click(session, { selector: '#inner-btn', frame: 1 })
  const secondCount = await frame1.evaluate(() => window.__second ?? 0)
  check('frame 导航后 selector 重新解析', secondCount === 1, JSON.stringify({ frameReloaded, navFrameClick }))

  console.log('== 用例 3：参数互斥与越界 ==')
  const refMix = await expectThrow(() => click(session, { ref: '@0', frame: 1 }))
  check('frame 与 ref 同时给报错', typeof refMix === 'string' && refMix.includes('frame 只能与 selector 组合'), String(refMix))
  const pointMix = await expectThrow(() => click(session, { x: 10, y: 10, frame: 1 }))
  check('frame 与坐标同时给报错', typeof pointMix === 'string' && pointMix.includes('只能给一种'), String(pointMix))
  const outOfRange = await expectThrow(() => click(session, { selector: '#inner-btn', frame: 9 }))
  check('frame 越界报错', typeof outOfRange === 'string' && outOfRange.includes('不存在'), String(outOfRange))
  const badType = await expectThrow(() => click(session, { selector: '#inner-btn', frame: -1 }))
  check('frame 非法值报错', typeof badType === 'string' && badType.includes('0 或正整数'), String(badType))

  console.log('== 用例 4：嵌套 frame ==')
  await navigate(session, `${base}/nested-main`)
  page = pageOf(session)
  check('嵌套页面 frame 已加载', await waitFrames(page, 3), String(page.frames().length))
  const nestedResult = await click(session, { selector: '#nested-btn', frame: 2 })
  const nestedFrame = childFrame(page, 2)
  const nestedClicked = await nestedFrame.evaluate(() => window.__nestedClicked === true)
  check('嵌套 frame 内 selector 点击生效', nestedClicked === true, JSON.stringify(nestedResult))

  console.log('== 用例 5：跨源 frame ==')
  await navigate(session, `http://127.0.0.1:${portB}/cross-main`)
  page = pageOf(session)
  check('跨源页面 frame 已加载', await waitFrames(page, 2), String(page.frames().length))
  const crossFrame = childFrame(page, 1)
  const crossResult = await click(session, { selector: '#inner-btn', frame: 1 })
  const crossClicked = await crossFrame.evaluate(() => window.__clicked === 1)
  check('跨源 frame 内 selector 点击生效', crossClicked === true, JSON.stringify(crossResult))

  console.log('== 用例 6：快照 frame 仍只读同源 ==')
  await navigate(session, `${base}/`)
  const snap = await snapshot(session, undefined, { frame: 1 })
  check('快照 frame 1 返回子 frame 信息且节点 ref 为 null',
    snap.frame?.index === 1 && snap.nodes.every((node) => node.ref === null),
    JSON.stringify({ frame: snap.frame, sample: snap.nodes.slice(0, 1) }))

  console.log('== 用例 7：两个标签页的 frame 互不影响 ==')
  const t1Page = pageOf(session)
  const t1Frame = childFrame(t1Page, 1)
  const beforeT1 = await t1Frame.evaluate(() => window.__clicked ?? 0)
  await navigate(session, `${base}/`, 'load', { new_tab: true })
  const tabIds = [...session.pages.keys()]
  const t2Id = tabIds[tabIds.length - 1]
  const t2Page = session.pages.get(t2Id).page
  check('第二标签页 frame 已加载', await waitFrames(t2Page, 2), String(t2Page.frames().length))
  await click(session, { selector: '#inner-btn', frame: 1 }, t2Id)
  const t2Frame = childFrame(t2Page, 1)
  const afterT2 = await t2Frame.evaluate(() => window.__clicked ?? 0)
  const afterT1 = await t1Frame.evaluate(() => window.__clicked ?? 0)
  check('t1 与 t2 的 frame 互不影响', afterT2 === 1 && afterT1 === beforeT1,
    `t1 ${beforeT1} -> ${afterT1}; t2 ${afterT2}`)
} finally {
  await closeAll()
  serverA?.close()
  serverB?.close()
}

const after = await waitProcessExit(baseline)
check('msedge 主进程回落到运行前基线', after <= baseline, `before=${baseline} after=${after}`)
console.log(`\n结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
