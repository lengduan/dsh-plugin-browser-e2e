/**
 * dsh-browser-e2e 工具能力验证：console / network 捕获、snapshot 增强、
 * 点击三种方式、clip 截图、wait 与超时。
 *
 * 直接调用 page.js / capture.js 的真实实现（不 mock），真起无头 Edge；
 * 网络请求用 node:http 在 127.0.0.1 随机端口起本地服务制造。
 *
 * 运行：node tests/tools.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const {
  click, consoleEntries, evaluate, fill, navigate, networkEntries, scroll, snapshot, waitFor,
} = await import('../lib/page.js')
const { currentTab } = await import('../lib/page.js')
const { screenshot } = await import('../lib/capture.js')

const KEY = 'test-tools-key'
let session = null
const SID = 'test-tools-session'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** 读取 PNG 文件头里的宽高。 */
function pngSize(file) {
  const buffer = readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** PNG 行滤波的 Paeth 预测（decodePng 用）。 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 最小 PNG 解码：只支持 8 位非隔行的 RGB / RGBA（Playwright 与 CDP 截图都是这两种）。
 * 返回 { width, height, pixel(x, y) }，供像素级断言使用。
 */
function decodePng(file) {
  const buffer = readFileSync(file)
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const chunks = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bitDepth !== 8 || channels === 0) {
    throw new Error(`不支持的 PNG：bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[i - channels] : 0
      const up = prev ? prev[i] : 0
      const upLeft = prev && i >= channels ? prev[i - channels] : 0
      let value
      if (filter === 0) value = line[i]
      else if (filter === 1) value = line[i] + left
      else if (filter === 2) value = line[i] + up
      else if (filter === 3) value = line[i] + Math.floor((left + up) / 2)
      else if (filter === 4) value = line[i] + paeth(left, up, upLeft)
      else throw new Error(`未知 PNG 行滤波 ${filter}`)
      out[i] = value & 0xff
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + x * channels
      return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] }
    },
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

const baseline = edgeRootCount()
// 运行前可能已有别的进程用 Playwright 起过 Edge（例如其他工具），只断言本测试没有新增残留。
const playwrightBaseline = playwrightEdgeRootCount()
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>tools</title></head><body><h1 id="title">ok</h1></body></html>')
    return
  }
  if (req.url.startsWith('/reload-sub')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('sub')
    return
  }
  if (req.url === '/reload') {
    // 同 URL reload 用例：每次文档加载用 sessionStorage 计数，控制台与子请求都带上序号，
    // 以便区分「旧文档记录」与「新文档自己的记录」。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>reload</title></head><body><button id="marker">marker</button>'
      + '<script>'
      + 'var n = Number(sessionStorage.getItem("docLoads") || "0") + 1;'
      + 'sessionStorage.setItem("docLoads", String(n));'
      + 'console.log("doc-load-" + n);'
      + 'fetch("/reload-sub?n=" + n).catch(function () {});'
      + '</script></body></html>')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 1：启动浏览器（视口 800x600）==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    check('启动成功且有 summary', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    check('Edge 主进程比基线多', edgeRootCount() > baseline, `baseline=${baseline} now=${edgeRootCount()}`)
  }

  console.log('== 用例 2：console 捕获（log / warn / pageerror）==')
  {
    await navigate(session, 'data:text/html,<script>console.log("hello-console");console.warn("warn-msg");setTimeout(function(){throw new Error("boom-pageerror")},50)</script>', 'load')
    await sleep(300)
    const info = await consoleEntries(session, 100)
    const text = info.text
    check('捕获到 console.log', text.includes('hello-console'), text)
    check('捕获到 console.warn', /warn-msg/.test(text), text)
    check('捕获到 pageerror', text.includes('boom-pageerror'), text)
    check('条目结构含 level / text / at', info.entries.every((e) => typeof e.level === 'string' && typeof e.text === 'string' && typeof e.at === 'string'), JSON.stringify(info.entries))
  }

  console.log('== 用例 3：network 捕获（含 status）==')
  {
    await navigate(session, `${base}/page`, 'load')
    // 再发一个必定 404 的请求。
    const fetched = await evaluate(session, "fetch('/missing').then(r => r.status)")
    check('页面内 fetch 返回 404', fetched.value === 404, JSON.stringify(fetched.value))
    await sleep(300)
    const info = await networkEntries(session, 100)
    const pageRecord = info.entries.find((e) => e.url === `${base}/page`)
    const missingRecord = info.entries.find((e) => e.url === `${base}/missing`)
    check('记录到页面请求且 status=200', pageRecord?.status === 200, JSON.stringify(pageRecord))
    check('记录到 404 请求且 status=404', missingRecord?.status === 404, JSON.stringify(missingRecord))
    check('记录含 method / mimeType', pageRecord?.method === 'GET' && /text\/html/.test(pageRecord?.mimeType ?? ''), JSON.stringify(pageRecord))
    check('导航清空旧记录（不含用例 2 的页面）', !info.entries.some((e) => e.url.startsWith('data:')), JSON.stringify(info.entries.map((e) => e.url)))
  }

  console.log('== 用例 3B：事件环按新文档重置（同 URL reload）==')
  {
    await navigate(session, `${base}/reload`, 'load')
    await waitUntil(async () => (await consoleEntries(session, 100)).text.includes('doc-load-1'))
    await sleep(300)
    const beforeConsole = await consoleEntries(session, 100)
    const beforeNetwork = await networkEntries(session, 100)
    check('预置：旧文档 console 已记录', beforeConsole.text.includes('doc-load-1'), beforeConsole.text)
    check('预置：旧文档网络已记录', beforeNetwork.entries.some((e) => e.url === `${base}/reload-sub?n=1`),
      JSON.stringify(beforeNetwork.entries.map((e) => e.url)))
    // 页面内触发同 URL reload：不经过 navigate() 的预清空，能否重置完全看新文档判据。
    await evaluate(session, 'setTimeout(function () { location.reload() }, 0); "scheduled"')
    const reached = await waitUntil(async () => (await consoleEntries(session, 100)).text.includes('doc-load-2'))
    check('reload 后新文档 console 记录到达', reached, (await consoleEntries(session, 100)).text)
    await sleep(300)
    const afterConsole = await consoleEntries(session, 100)
    const afterNetwork = await networkEntries(session, 100)
    check('reload 后旧 console 记录不再出现', !afterConsole.text.includes('doc-load-1'), afterConsole.text)
    check('reload 后新文档 console 记录保留', afterConsole.text.includes('doc-load-2'), afterConsole.text)
    check('reload 后旧网络记录不再出现', !afterNetwork.entries.some((e) => e.url.endsWith('/reload-sub?n=1')),
      JSON.stringify(afterNetwork.entries.map((e) => e.url)))
    const docRecord = afterNetwork.entries.find((e) => e.url === `${base}/reload`)
    const subRecord = afterNetwork.entries.find((e) => e.url === `${base}/reload-sub?n=2`)
    check('reload 后新文档自身请求保留（document + 子请求）', docRecord?.status === 200 && subRecord?.status === 200,
      JSON.stringify(afterNetwork.entries.map((e) => ({ url: e.url, status: e.status }))))
  }

  console.log('== 用例 4：snapshot 的 box / role / depth ==')
  {
    await navigate(session, 'data:text/html,<body><div style="padding:20px"><button id="btn" style="position:fixed;left:100px;top:100px;width:100px;height:40px" onclick="window.__clicked=true">Click Me</button></div><input id="chk" type="checkbox" style="position:fixed;left:10px;top:10px"></body>', 'load')
    const info = await snapshot(session)
    const text = info.text
    check('snapshot 返回 summary 与 truncated 字段', typeof info.summary === 'string' && info.truncated === false, JSON.stringify({ summary: info.summary, truncated: info.truncated }))
    // 全 DOM 快照的节点结构：id / classes / name / depth 四个字段都在且类型正确。
    const structureOk = info.nodes.length > 0 && info.nodes.every((node) => typeof node.id === 'string'
      && Array.isArray(node.classes) && node.classes.every((name) => typeof name === 'string')
      && typeof node.name === 'string' && Number.isInteger(node.depth) && node.depth >= 1)
    check('节点结构含 id / classes / name / depth', structureOk, JSON.stringify(info.nodes.slice(0, 3)))
    // 文本行里带 box(...) 且按钮标签正确。
    check('文本含 box(...)', /box\(100,100,100,40\)/.test(text), text)
    check('文本含按钮标签与缩进', text.includes('"Click Me"'), text)
    check('返回项数不少于 2', info.count >= 2, String(info.count))
    // 用 ref 点击验证 ref 可用（同时验证 ref 表里的条目带 box / depth / role）。
    const refLine = text.split('\n').find((line) => line.includes('"Click Me"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    check('能从文本解析出 ref', Boolean(ref), String(refLine))
    const clicked = await click(session, { ref })
    await sleep(100)
    const flag = await evaluate(session, 'window.__clicked === true')
    check('ref 点击生效', flag.value === true, JSON.stringify(clicked))
  }

  console.log('== 用例 5：selector 点击 / 坐标点击 ==')
  {
    await navigate(session, 'data:text/html,<button id="btn" style="position:fixed;left:100px;top:100px;width:100px;height:40px" onclick="window.__clicked=true">Click Me</button>', 'load')
    const bySelector = await click(session, { selector: '#btn' })
    await sleep(100)
    const afterSelector = await evaluate(session, 'window.__clicked === true')
    check('selector 点击生效', afterSelector.value === true && bySelector.mode === 'selector', JSON.stringify(bySelector))
    // 重置标记，用视口坐标点按钮中心 (150, 120)。
    await evaluate(session, 'window.__clicked = false')
    const byPoint = await click(session, { x: 150, y: 120 })
    await sleep(100)
    const afterPoint = await evaluate(session, 'window.__clicked === true')
    check('坐标点击生效（真实鼠标事件）', afterPoint.value === true && byPoint.mode === 'point', JSON.stringify(byPoint))
    const noneMessage = await expectThrow(() => click(session, {}))
    check('三种目标都不给时报错', Boolean(noneMessage) && /ref|selector|x \+ y/.test(noneMessage ?? ''), String(noneMessage))
  }

  console.log('== 用例 5B：fill 三种目标（ref / selector / 坐标）==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0">'
      + '<input id="a" placeholder="first" style="position:fixed;left:20px;top:20px;width:200px;height:30px">'
      + '<input id="b" placeholder="second" style="position:fixed;left:20px;top:80px;width:200px;height:30px">'
      + '<input id="c" placeholder="third" style="position:fixed;left:20px;top:140px;width:200px;height:30px">'
      + '</body>', 'load')
    const info = await snapshot(session)
    const first = info.nodes.find((node) => node.id === 'a')
    const third = info.nodes.find((node) => node.id === 'c')
    check('快照能定位到三个输入框', Boolean(first) && Boolean(third) && Boolean(info.nodes.find((node) => node.id === 'b')), JSON.stringify(info.nodes.slice(0, 6)))
    const byRef = await fill(session, { ref: first?.ref }, 'ref-value')
    const bySelector = await fill(session, { selector: '#b' }, 'selector-value')
    // 坐标取 #c 的 box 中心；fill 的坐标分支是真实鼠标点击后键入。
    const pointX = third ? third.box.x + Math.round(third.box.width / 2) : 0
    const pointY = third ? third.box.y + Math.round(third.box.height / 2) : 0
    const byPoint = await fill(session, { x: pointX, y: pointY }, 'point-value')
    const values = await evaluate(session, "['a','b','c'].map(function (id) { return document.getElementById(id).value })")
    check('ref 写入生效', values.value?.[0] === 'ref-value' && byRef.mode === 'ref', JSON.stringify({ values: values.value, byRef }))
    check('selector 写入生效', values.value?.[1] === 'selector-value' && bySelector.mode === 'selector', JSON.stringify({ values: values.value, bySelector }))
    check('坐标写入生效', values.value?.[2] === 'point-value' && byPoint.mode === 'point', JSON.stringify({ values: values.value, byPoint }))
    const fillNone = await expectThrow(() => fill(session, {}, 'x'))
    check('三种目标都不给时报错', Boolean(fillNone) && fillNone.includes('ref / selector / x + y'), String(fillNone))
  }

  console.log('== 用例 5D：fill 不误切换 checkbox / radio ==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0">'
      + '<input id="chk" type="checkbox" style="position:fixed;left:20px;top:20px;width:24px;height:24px">'
      + '<input id="rad" type="radio" name="g" style="position:fixed;left:20px;top:80px;width:24px;height:24px">'
      + '<input id="txt" placeholder="text" style="position:fixed;left:20px;top:140px;width:200px;height:30px">'
      + '</body>', 'load')
    const info = await snapshot(session)
    const chk = info.nodes.find((node) => node.id === 'chk')
    const rad = info.nodes.find((node) => node.id === 'rad')
    const txt = info.nodes.find((node) => node.id === 'txt')
    check('快照能定位到 checkbox / radio / 文本框', Boolean(chk) && Boolean(rad) && Boolean(txt), JSON.stringify(info.nodes.slice(0, 8)))
    const chkFill = await expectThrow(() => fill(session, { ref: chk?.ref }, 'on'))
    check('checkbox 用 ref 填写报「可切换控件」并提示改用 click', Boolean(chkFill) && chkFill.includes('可切换控件') && chkFill.includes('browser_e2e_click'), String(chkFill))
    const radFill = await expectThrow(() => fill(session, { ref: rad?.ref }, 'on'))
    check('radio 用 ref 填写报「可切换控件」', Boolean(radFill) && radFill.includes('可切换控件'), String(radFill))
    const states = await evaluate(session, "({ chk: document.getElementById('chk').checked, rad: document.getElementById('rad').checked })")
    check('fill 后 checkbox / radio 勾选状态未变', states.value?.chk === false && states.value?.rad === false, JSON.stringify(states.value))
    // 仍可交互：用 click 明确切换，再用 fill 写文本框。
    await click(session, { ref: chk?.ref })
    const afterClick = await evaluate(session, "document.getElementById('chk').checked")
    check('随后用 click 能正常切换 checkbox', afterClick.value === true, JSON.stringify(afterClick.value))
    const txtFill = await fill(session, { ref: txt?.ref }, 'still-works')
    const txtValue = await evaluate(session, "document.getElementById('txt').value")
    check('同页文本框 fill 仍生效', txtFill.mode === 'ref' && txtValue.value === 'still-works', JSON.stringify({ txtFill, txtValue: txtValue.value }))
  }

  console.log('== 用例 5C：scroll（滚动 / 坐标 / 非法 delta）==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0"><div style="height:3000px;background-color:gray"></div></body>', 'load')
    const before = await evaluate(session, 'window.scrollY')
    const info = await scroll(session, { delta_y: 600 })
    await sleep(200)
    const after = await evaluate(session, 'window.scrollY')
    check('滚动后 window.scrollY 增加', before.value === 0 && after.value > 0, `${before.value} -> ${after.value}`)
    check('返回 deltaX / deltaY 与摘要', info.mode === 'scroll' && info.deltaX === 0 && info.deltaY === 600, JSON.stringify(info))
    // 坐标滚动：先把鼠标移到视口内再滚，scrollY 继续增加。
    const moved = await scroll(session, { x: 200, y: 200, delta_y: 400 })
    await sleep(200)
    const afterPoint = await evaluate(session, 'window.scrollY')
    check('坐标滚动继续增加 scrollY', afterPoint.value > after.value && moved.deltaY === 400, `${after.value} -> ${afterPoint.value}`)
    const zero = await expectThrow(() => scroll(session, { delta_x: 0, delta_y: 0 }))
    check('delta 全 0 报错', Boolean(zero) && zero.includes('非 0'), String(zero))
    const badDelta = await expectThrow(() => scroll(session, { delta_y: 'not-a-number' }))
    check('非数字 delta 报错', Boolean(badDelta) && badDelta.includes('必须是数字'), String(badDelta))
  }

  console.log('== 用例 6：ref 失效检测 ==')
  {
    await navigate(session, 'data:text/html,<button id="btn" onclick="window.__clicked=true">Click Me</button>', 'load')
    const info = await snapshot(session)
    const refLine = info.text.split('\n').find((line) => line.includes('"Click Me"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    await evaluate(session, "document.getElementById('btn').remove()")
    const message = await expectThrow(() => click(session, { ref }))
    check('失效 ref 报「已失效，请重新 snapshot」', Boolean(message) && message.includes('已失效'), String(message))
  }

  console.log('== 用例 7：截图增强（clip / jpeg / 校验链）==')
  {
    await navigate(session, 'data:text/html,<body style="margin:0"><div style="width:200px;height:120px;background:#3a7"></div></body>', 'load')
    const info = await screenshot(session, currentTab(session), { name: 'clip-shot', clip: { x: 10, y: 10, width: 100, height: 50 } })
    check('clip 截图落盘', existsSync(info.file), info.file)
    const size = existsSync(info.file) ? pngSize(info.file) : { width: 0, height: 0 }
    check('clip 截图尺寸为 100x50', size.width === 100 && size.height === 50, JSON.stringify(size))
    check('meta 尺寸与文件一致', info.meta.width === 100 && info.meta.height === 50, JSON.stringify(info.meta))
    check('首行为 summary', info.summary.includes('截图') && info.summary.includes('100x50'), info.summary)

    // 数值倍率 1 / 2 / 3：输出尺寸应是 clip 基准尺寸的整数倍。
    for (const factor of [1, 2, 3]) {
      const scaled = await screenshot(session, currentTab(session), { name: `scale-${factor}`, clip: { x: 10, y: 10, width: 100, height: 50 }, scale: factor })
      const scaledSize = existsSync(scaled.file) ? pngSize(scaled.file) : { width: 0, height: 0 }
      const expectedWidth = 100 * factor
      const expectedHeight = 50 * factor
      check(`scale ${factor} 输出 ${expectedWidth}x${expectedHeight}`, scaledSize.width === expectedWidth
        && scaledSize.height === expectedHeight && scaled.meta.width === expectedWidth
        && scaled.meta.height === expectedHeight, `${JSON.stringify(scaledSize)} meta=${JSON.stringify(scaled.meta)}`)
    }
    const badScale = await expectThrow(() => screenshot(session, currentTab(session), { scale: 4 }))
    check('非法 scale 数字报错', Boolean(badScale) && badScale.includes('scale'), String(badScale))
    const badScaleText = await expectThrow(() => screenshot(session, currentTab(session), { scale: 'zoom' }))
    check('非法 scale 字符串报错', Boolean(badScaleText) && badScaleText.includes('scale'), String(badScaleText))

    const jpegInfo = await screenshot(session, currentTab(session), { name: 'jpeg-shot', format: 'jpeg', quality: 80 })
    check('jpeg 截图落盘且扩展名正确', existsSync(jpegInfo.file) && jpegInfo.file.endsWith('.jpeg'), jpegInfo.file)
    check('jpeg 尺寸为视口 800x600', jpegInfo.meta.width === 800 && jpegInfo.meta.height === 600, JSON.stringify(jpegInfo.meta))

    const outOfViewport = await expectThrow(() => screenshot(session, currentTab(session), { clip: { x: 700, y: 10, width: 200, height: 50 } }))
    check('clip 越出视口报错且带数字', Boolean(outOfViewport) && outOfViewport.includes('超出视口') && outOfViewport.includes('900'), String(outOfViewport))

    const badFormat = await expectThrow(() => screenshot(session, currentTab(session), { format: 'webp' }))
    check('非法 format 报错', Boolean(badFormat) && badFormat.includes('webp'), String(badFormat))

    const badQuality = await expectThrow(() => screenshot(session, currentTab(session), { quality: 50 }))
    check('png 带 quality 报错', Boolean(badQuality) && badQuality.includes('quality'), String(badQuality))

    const badClip = await expectThrow(() => screenshot(session, currentTab(session), { clip: { x: 1.5, y: 0, width: 10, height: 10 } }))
    check('非整数 clip 报错', Boolean(badClip) && badClip.includes('整数'), String(badClip))

    // 滚动后：数值倍率路径必须按页面坐标截取（不能截到文档顶部），无 clip 时倍率要真实生效。
    await navigate(session, 'data:text/html,<body style="margin:0">'
      + '<div style="height:800px;background:rgb(255,0,0)"></div>'
      + '<div style="height:1600px;background:rgb(0,0,255)"></div></body>', 'load')
    await evaluate(session, 'window.scrollTo(0, 1000)')
    await sleep(100)
    const scrolledClip = { x: 0, y: 0, width: 100, height: 100 }
    const cssShot = await screenshot(session, currentTab(session), { name: 'scroll-css', clip: scrolledClip, scale: 'css' })
    const scaleOneShot = await screenshot(session, currentTab(session), { name: 'scroll-scale-1', clip: scrolledClip, scale: 1 })
    const cssPixel = decodePng(cssShot.file).pixel(50, 50)
    const scaleOnePixel = decodePng(scaleOneShot.file).pixel(50, 50)
    check('滚动后 clip 取到视口内容（蓝色，不是白图）', cssPixel.b > 200 && cssPixel.r < 80, JSON.stringify(cssPixel))
    check('滚动后 scale:1 与 scale:"css" 像素一致', JSON.stringify(cssPixel) === JSON.stringify(scaleOnePixel),
      `css=${JSON.stringify(cssPixel)} scale1=${JSON.stringify(scaleOnePixel)}`)

    const viewportScaled = await screenshot(session, currentTab(session), { name: 'viewport-scale-2', scale: 2 })
    const viewportSize = pngSize(viewportScaled.file)
    check('无 clip scale:2 输出 1600x1200（倍率真实生效）', viewportSize.width === 1600 && viewportSize.height === 1200
      && viewportScaled.meta.scale === 2, `${JSON.stringify(viewportSize)} meta=${JSON.stringify(viewportScaled.meta)}`)
    const tooBigPixels = await expectThrow(() => screenshot(session, currentTab(session), { scale: 3 }))
    check('无 clip scale:3 输出 2400x1800 超像素上限报错', Boolean(tooBigPixels)
      && tooBigPixels.includes('超出上限') && tooBigPixels.includes('4320000'), String(tooBigPixels))

    const fullPageShot = await screenshot(session, currentTab(session), { name: 'full-scale-1', fullPage: true, scale: 1 })
    const fullPageDecoded = decodePng(fullPageShot.file)
    check('整页 scale:1 输出 800x2400 且上下两段颜色正确', fullPageDecoded.width === 800 && fullPageDecoded.height === 2400
      && fullPageDecoded.pixel(10, 10).r > 200 && fullPageDecoded.pixel(10, 2390).b > 200,
    `${fullPageDecoded.width}x${fullPageDecoded.height} top=${JSON.stringify(fullPageDecoded.pixel(10, 10))} bottom=${JSON.stringify(fullPageDecoded.pixel(10, 2390))}`)
  }

  console.log('== 用例 8：browser_e2e_wait ==')
  {
    await navigate(session, 'data:text/html,<div id="late" style="display:none">late</div><script>setTimeout(function(){document.getElementById("late").style.display="block"},300)</script>', 'load')
    const visible = await waitFor(session, { selector: '#late', state: 'visible', timeoutMs: 5000 })
    check('wait selector 成功并返回耗时', visible.mode === 'selector' && visible.elapsedMs >= 200, JSON.stringify(visible))
    check('wait 的 summary 含 selector 与耗时', visible.summary.includes('#late') && visible.summary.includes('ms'), visible.summary)

    await evaluate(session, 'window.__later = false; setTimeout(function(){ window.__later = true }, 200)')
    const expression = await waitFor(session, { expression: 'window.__later === true', timeoutMs: 5000 })
    check('wait expression 成功', expression.mode === 'expression' && expression.elapsedMs >= 100, JSON.stringify(expression))

    const timeoutMessage = await expectThrow(() => waitFor(session, { selector: '#never-exists', timeoutMs: 600 }))
    check('wait 超时报错且带实际等待时长', Boolean(timeoutMessage) && timeoutMessage.includes('超时') && /实际等待 \d+ms/.test(timeoutMessage ?? ''), String(timeoutMessage))

    const bothMessage = await expectThrow(() => waitFor(session, { selector: '#late', expression: 'true' }))
    check('selector 与 expression 同时给时报错', Boolean(bothMessage) && bothMessage.includes('二选一'), String(bothMessage))
  }

  console.log('== 用例 9：snapshot 全 DOM 的 4000 条截断 ==')
  {
    await navigate(session, 'data:text/html,<body><script>'
      + 'for (let i = 0; i < 4100; i++) { const b = document.createElement("button"); b.id = "b" + i; b.textContent = "b" + i; '
      + 'b.onclick = function () { window.__lastClick = this.id }; document.body.appendChild(b) }'
      + '</script></body>', 'load')
    const info = await snapshot(session)
    check('truncated 为 true', info.truncated === true, JSON.stringify({ truncated: info.truncated, count: info.count }))
    check('只返回 4000 条', info.count === 4000, String(info.count))
    check('total 记录实际可见节点数', info.total === 4100, String(info.total))
    check('文本尾部有截断提示', info.text.includes('已截断') && info.text.includes('4100'), info.text.slice(-160))
    // 截断只影响返回条数，ref 表仍然可用。
    const refLine = info.text.split('\n').find((line) => line.includes('"b0"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    const clicked = await click(session, { ref })
    await sleep(100)
    const flag = await evaluate(session, 'window.__lastClick === "b0"')
    check('截断后的 ref 点击仍生效', Boolean(ref) && flag.value === true, `${JSON.stringify(clicked)} ref=${ref}`)
  }
  console.log('== 用例 10：index.js 工具注册与截图的文本 + 图片输出 ==')
  {
    const { apply } = await import('../lib/index.js')
    const definitions = []
    const saved = []
    const fakeAttachments = {
      async saveImage({ data, mediaType, name }) {
        saved.push({ mediaType, name, bytes: data.length })
        return { attachmentId: 'att-1', mediaType, bytes: data.length, width: 100, height: 50, name }
      },
    }
    const makeCtx = (attachments) => ({
      get: (name) => (name === 'attachments' ? attachments : undefined),
      tools: { register: (definition) => definitions.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    apply(makeCtx(fakeAttachments))
    const names = definitions.map((definition) => definition.name)
    // 期望从 lib/tools.js 的工具表派生：新增工具只改表，这里不用改断言。
    const { buildToolTable } = await import('../lib/tools.js')
    const table = buildToolTable({ ctx: { get: () => undefined }, launchDefaults: {} })
    check('注册的工具与工具表逐项一致', JSON.stringify(names) === JSON.stringify(table.map((definition) => definition.name)), JSON.stringify(names))
    check('工具名唯一且统一带 browser_e2e_ 前缀', new Set(names).size === names.length
      && names.every((name) => name.startsWith('browser_e2e_')), JSON.stringify(names))
    const fillTool = definitions.find((definition) => definition.name === 'browser_e2e_fill')
    check('fill 把 value 列为必填并提供四种目标参数', fillTool.parameters.required.includes('value')
      && ['ref', 'selector', 'x', 'y', 'tab_id'].every((field) => field in fillTool.parameters.properties),
    JSON.stringify(fillTool.parameters))
    const scrollTool = definitions.find((definition) => definition.name === 'browser_e2e_scroll')
    check('scroll 参数含 delta_x / delta_y / x / y / tab_id', ['delta_x', 'delta_y', 'x', 'y', 'tab_id'].every((field) => field in scrollTool.parameters.properties),
      JSON.stringify(Object.keys(scrollTool.parameters.properties)))

    const screenshotTool = definitions.find((definition) => definition.name === 'browser_e2e_screenshot')
    const exec = { agent: { id: KEY } }
    const value = await screenshotTool.execute({ clip: { x: 10, y: 10, width: 100, height: 50 } }, exec)
    check('截图工具返回 { file, meta }', typeof value.file === 'string' && value.meta.width === 100, JSON.stringify({ file: value.file, meta: value.meta }))
    const content = screenshotTool.output.render({}, value)
    check('附件服务可用时 render 返回文本 + image 块', content.length === 2 && content[1].type === 'image' && content[1].attachment.attachmentId === 'att-1', JSON.stringify(content))
    check('图片实际存入附件服务', saved.length === 1 && saved[0].bytes > 0, JSON.stringify(saved))

    // 附件服务不可用时只返回文本路径。
    const noAttachmentDefs = []
    apply({
      get: () => undefined,
      tools: { register: (definition) => noAttachmentDefs.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    const noAttachmentTool = noAttachmentDefs.find((definition) => definition.name === 'browser_e2e_screenshot')
    const textValue = await noAttachmentTool.execute({ name: 'no-attachment' }, exec)
    const textContent = noAttachmentTool.output.render({}, textValue)
    check('附件服务不可用时只返回文本', textContent.length === 1 && textContent[0].type === 'text' && textContent[0].text.includes(textValue.file), JSON.stringify(textContent))
  }
} finally {
  await closeAll()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const playwrightSettled = await waitUntil(() => playwrightEdgeRootCount() <= playwrightBaseline)
const remaining = edgeRootCount()
const remainingPlaywright = playwrightEdgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
check('本测试未遗留 Playwright Edge 主进程', playwrightSettled && remainingPlaywright <= playwrightBaseline, `playwright 基线=${playwrightBaseline} 残留=${remainingPlaywright}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）；Playwright 主进程 ${remainingPlaywright} 个（基线 ${playwrightBaseline} 个）`)
process.exit(fail === 0 ? 0 : 1)
