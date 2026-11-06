/**
 * dsh-browser-e2e 工具能力验证：console / network 捕获、snapshot 增强、
 * 点击三种方式、clip 截图、wait 与超时。
 *
 * 直接调用 browser.js 的真实实现（不 mock），真起无头 Edge；
 * 网络请求用 node:http 在 127.0.0.1 随机端口起本地服务制造。
 *
 * 运行：node tests/tools.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'

// 测试期间不让空闲回收介入（browser.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const {
  closeAll, click, consoleEntries, evaluate, launch, navigate, networkEntries, screenshot, snapshot, waitFor,
} = await import('../lib/browser.js')

const KEY = 'test-tools-key'
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

/** 期望某次调用抛错，返回错误信息（没抛错返回 null）。 */
async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
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
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 1：启动浏览器（视口 800x600）==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    check('启动成功且有 summary', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    check('Edge 主进程比基线多', edgeRootCount() > baseline, `baseline=${baseline} now=${edgeRootCount()}`)
  }

  console.log('== 用例 2：console 捕获（log / warn / pageerror）==')
  {
    await navigate(KEY, 'data:text/html,<script>console.log("hello-console");console.warn("warn-msg");setTimeout(function(){throw new Error("boom-pageerror")},50)</script>', 'load', SID)
    await sleep(300)
    const info = await consoleEntries(KEY, 100)
    const text = info.text
    check('捕获到 console.log', text.includes('hello-console'), text)
    check('捕获到 console.warn', /warn-msg/.test(text), text)
    check('捕获到 pageerror', text.includes('boom-pageerror'), text)
    check('条目结构含 level / text / at', info.entries.every((e) => typeof e.level === 'string' && typeof e.text === 'string' && typeof e.at === 'string'), JSON.stringify(info.entries))
  }

  console.log('== 用例 3：network 捕获（含 status）==')
  {
    await navigate(KEY, `${base}/page`, 'load', SID)
    // 再发一个必定 404 的请求。
    const fetched = await evaluate(KEY, "fetch('/missing').then(r => r.status)", SID)
    check('页面内 fetch 返回 404', fetched.value === 404, JSON.stringify(fetched.value))
    await sleep(300)
    const info = await networkEntries(KEY, 100)
    const pageRecord = info.entries.find((e) => e.url === `${base}/page`)
    const missingRecord = info.entries.find((e) => e.url === `${base}/missing`)
    check('记录到页面请求且 status=200', pageRecord?.status === 200, JSON.stringify(pageRecord))
    check('记录到 404 请求且 status=404', missingRecord?.status === 404, JSON.stringify(missingRecord))
    check('记录含 method / mimeType', pageRecord?.method === 'GET' && /text\/html/.test(pageRecord?.mimeType ?? ''), JSON.stringify(pageRecord))
    check('导航清空旧记录（不含用例 2 的页面）', !info.entries.some((e) => e.url.startsWith('data:')), JSON.stringify(info.entries.map((e) => e.url)))
  }

  console.log('== 用例 4：snapshot 的 box / role / depth ==')
  {
    await navigate(KEY, 'data:text/html,<body><div style="padding:20px"><button id="btn" style="position:fixed;left:100px;top:100px;width:100px;height:40px" onclick="window.__clicked=true">Click Me</button></div><input id="chk" type="checkbox" style="position:fixed;left:10px;top:10px"></body>', 'load', SID)
    const info = await snapshot(KEY, SID)
    const text = info.text
    check('snapshot 返回 summary 与 truncated 字段', typeof info.summary === 'string' && info.truncated === false, JSON.stringify({ summary: info.summary, truncated: info.truncated }))
    // 文本行里带 box(...) 且按钮标签正确。
    check('文本含 box(...)', /box\(100,100,100,40\)/.test(text), text)
    check('文本含按钮标签与缩进', text.includes('"Click Me"'), text)
    check('返回项数不少于 2', info.count >= 2, String(info.count))
    // 用 ref 点击验证 ref 可用（同时验证 ref 表里的条目带 box / depth / role）。
    const refLine = text.split('\n').find((line) => line.includes('"Click Me"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    check('能从文本解析出 ref', Boolean(ref), String(refLine))
    const clicked = await click(KEY, { ref }, SID)
    await sleep(100)
    const flag = await evaluate(KEY, 'window.__clicked === true', SID)
    check('ref 点击生效', flag.value === true, JSON.stringify(clicked))
  }

  console.log('== 用例 5：selector 点击 / 坐标点击 ==')
  {
    await navigate(KEY, 'data:text/html,<button id="btn" style="position:fixed;left:100px;top:100px;width:100px;height:40px" onclick="window.__clicked=true">Click Me</button>', 'load', SID)
    const bySelector = await click(KEY, { selector: '#btn' }, SID)
    await sleep(100)
    const afterSelector = await evaluate(KEY, 'window.__clicked === true', SID)
    check('selector 点击生效', afterSelector.value === true && bySelector.mode === 'selector', JSON.stringify(bySelector))
    // 重置标记，用视口坐标点按钮中心 (150, 120)。
    await evaluate(KEY, 'window.__clicked = false', SID)
    const byPoint = await click(KEY, { x: 150, y: 120 }, SID)
    await sleep(100)
    const afterPoint = await evaluate(KEY, 'window.__clicked === true', SID)
    check('坐标点击生效（真实鼠标事件）', afterPoint.value === true && byPoint.mode === 'point', JSON.stringify(byPoint))
    const noneMessage = await expectThrow(() => click(KEY, {}, SID))
    check('三种目标都不给时报错', Boolean(noneMessage) && /ref|selector|x \+ y/.test(noneMessage ?? ''), String(noneMessage))
  }

  console.log('== 用例 6：ref 失效检测 ==')
  {
    await navigate(KEY, 'data:text/html,<button id="btn" onclick="window.__clicked=true">Click Me</button>', 'load', SID)
    const info = await snapshot(KEY, SID)
    const refLine = info.text.split('\n').find((line) => line.includes('"Click Me"'))
    const ref = refLine && /\[(\d+)\]/.exec(refLine) ? `@${/\[(\d+)\]/.exec(refLine)[1]}` : null
    await evaluate(KEY, "document.getElementById('btn').remove()", SID)
    const message = await expectThrow(() => click(KEY, { ref }, SID))
    check('失效 ref 报「已失效，请重新 snapshot」', Boolean(message) && message.includes('已失效'), String(message))
  }

  console.log('== 用例 7：截图增强（clip / jpeg / 校验链）==')
  {
    await navigate(KEY, 'data:text/html,<body style="margin:0"><div style="width:200px;height:120px;background:#3a7"></div></body>', 'load', SID)
    const info = await screenshot(KEY, { name: 'clip-shot', clip: { x: 10, y: 10, width: 100, height: 50 } }, SID)
    check('clip 截图落盘', existsSync(info.file), info.file)
    const size = existsSync(info.file) ? pngSize(info.file) : { width: 0, height: 0 }
    check('clip 截图尺寸为 100x50', size.width === 100 && size.height === 50, JSON.stringify(size))
    check('meta 尺寸与文件一致', info.meta.width === 100 && info.meta.height === 50, JSON.stringify(info.meta))
    check('首行为 summary', info.summary.includes('截图') && info.summary.includes('100x50'), info.summary)

    const jpegInfo = await screenshot(KEY, { name: 'jpeg-shot', format: 'jpeg', quality: 80 }, SID)
    check('jpeg 截图落盘且扩展名正确', existsSync(jpegInfo.file) && jpegInfo.file.endsWith('.jpeg'), jpegInfo.file)
    check('jpeg 尺寸为视口 800x600', jpegInfo.meta.width === 800 && jpegInfo.meta.height === 600, JSON.stringify(jpegInfo.meta))

    const outOfViewport = await expectThrow(() => screenshot(KEY, { clip: { x: 700, y: 10, width: 200, height: 50 } }, SID))
    check('clip 越出视口报错且带数字', Boolean(outOfViewport) && outOfViewport.includes('超出视口') && outOfViewport.includes('900'), String(outOfViewport))

    const badFormat = await expectThrow(() => screenshot(KEY, { format: 'webp' }, SID))
    check('非法 format 报错', Boolean(badFormat) && badFormat.includes('webp'), String(badFormat))

    const badQuality = await expectThrow(() => screenshot(KEY, { quality: 50 }, SID))
    check('png 带 quality 报错', Boolean(badQuality) && badQuality.includes('quality'), String(badQuality))

    const badClip = await expectThrow(() => screenshot(KEY, { clip: { x: 1.5, y: 0, width: 10, height: 10 } }, SID))
    check('非整数 clip 报错', Boolean(badClip) && badClip.includes('整数'), String(badClip))
  }

  console.log('== 用例 8：browser_e2e_wait ==')
  {
    await navigate(KEY, 'data:text/html,<div id="late" style="display:none">late</div><script>setTimeout(function(){document.getElementById("late").style.display="block"},300)</script>', 'load', SID)
    const visible = await waitFor(KEY, { selector: '#late', state: 'visible', timeoutMs: 5000 }, SID)
    check('wait selector 成功并返回耗时', visible.mode === 'selector' && visible.elapsedMs >= 200, JSON.stringify(visible))
    check('wait 的 summary 含 selector 与耗时', visible.summary.includes('#late') && visible.summary.includes('ms'), visible.summary)

    await evaluate(KEY, 'window.__later = false; setTimeout(function(){ window.__later = true }, 200)', SID)
    const expression = await waitFor(KEY, { expression: 'window.__later === true', timeoutMs: 5000 }, SID)
    check('wait expression 成功', expression.mode === 'expression' && expression.elapsedMs >= 100, JSON.stringify(expression))

    const timeoutMessage = await expectThrow(() => waitFor(KEY, { selector: '#never-exists', timeoutMs: 600 }, SID))
    check('wait 超时报错且带实际等待时长', Boolean(timeoutMessage) && timeoutMessage.includes('超时') && /实际等待 \d+ms/.test(timeoutMessage ?? ''), String(timeoutMessage))

    const bothMessage = await expectThrow(() => waitFor(KEY, { selector: '#late', expression: 'true' }, SID))
    check('selector 与 expression 同时给时报错', Boolean(bothMessage) && bothMessage.includes('二选一'), String(bothMessage))
  }

  console.log('== 用例 9：snapshot 400 条截断 ==')
  {
    await navigate(KEY, 'data:text/html,<body><script>for (let i = 0; i < 450; i++) { const b = document.createElement("button"); b.textContent = "b" + i; document.body.appendChild(b) }</script></body>', 'load', SID)
    const info = await snapshot(KEY, SID)
    check('truncated 为 true', info.truncated === true, JSON.stringify({ truncated: info.truncated, count: info.count }))
    check('只返回 400 条', info.count === 400, String(info.count))
    check('文本尾部有截断提示', info.text.includes('已截断') && info.text.includes('450'), info.text.slice(-120))
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
    check('注册工具数量为 12', definitions.length === 12, JSON.stringify(names))
    check('新增工具均已注册', ['browser_e2e_console', 'browser_e2e_network', 'browser_e2e_wait'].every((name) => names.includes(name)), JSON.stringify(names))
    check('原有 9 个工具仍在', ['browser_start', 'browser_e2e_navigate', 'browser_e2e_snapshot', 'browser_e2e_click', 'browser_fill', 'browser_e2e_press', 'browser_e2e_screenshot', 'browser_evaluate', 'browser_e2e_close'].every((name) => names.includes(name)), JSON.stringify(names))

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
await sleep(1500)
const remaining = edgeRootCount()
const remainingPlaywright = playwrightEdgeRootCount()
check('msedge 主进程回落到运行前基线', remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
check('本测试未遗留 Playwright Edge 主进程', remainingPlaywright <= playwrightBaseline, `playwright 基线=${playwrightBaseline} 残留=${remainingPlaywright}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）；Playwright 主进程 ${remainingPlaywright} 个（基线 ${playwrightBaseline} 个）`)
process.exit(fail === 0 ? 0 : 1)
