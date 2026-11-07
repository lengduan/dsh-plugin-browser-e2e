/**
 * M8 CDP 接管验证。
 *
 * 用系统 Edge 以 `--remote-debugging-port` + 一次性 user-data-dir 起一个真实浏览器，
 * 再让插件以 mode:'cdp' 接管，覆盖：
 *   - connectOverCDP 连接路径与 tab 列表（取 context.pages()）；
 *   - 接管后不新建 page、不设置视口（viewportSize 为 null 时截图走内尺寸兜底）；
 *   - 导航 / 求值可用；
 *   - selector / 坐标两条文件上传路径在 CDP 接管下可用（夹具为本地 file:// 页面）；
 *   - browser_e2e_close 只断开连接，浏览器进程仍然存活；
 *   - close 再 start 只重连、不清用户浏览器 cookie（规格 0020 验收 6）；
 *   - 非 loopback 端点被拒绝。
 *
 * 运行：node tests/cdp.mjs
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { close, closeAll, launch, listPanelTabs, requireSession, tabs } = await import('../lib/session.js')
const { currentTab, clipboard, click, dialogEntries, evaluate, MIN_EVALUATE_TIMEOUT_MS, navigate, press, setDialogPolicy, upload } = await import('../lib/page.js')
const { screenshot } = await import('../lib/capture.js')
const { download } = await import('../lib/download.js')

const KEY = 'test-cdp-key'
let session = null
const SID = KEY
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

/** 找一个当前空闲的 loopback 端口。 */
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

/** 轮询 DevTools HTTP 端点，等浏览器就绪。 */
function waitForDevTools(port, timeoutMs = 20000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const probe = () => {
      const req = get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) {
          resolve(true)
          return
        }
        retry()
      })
      req.on('error', retry)
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(probe, 250)
    }
    probe()
  })
}

/** 系统 Edge 路径（与 Playwright channel: msedge 用的是同一个安装）。 */
function resolveEdgePath() {
  if (process.env.EDGE_PATH && existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const edgePath = resolveEdgePath()
if (edgePath === null) {
  console.log('SKIP：本机找不到 Edge 可执行文件，CDP 接管未验证（设置 EDGE_PATH 后可重跑）')
  process.exit(0)
}

const port = await pickPort()
const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-test-'))
// 文件上传夹具：本地临时目录 + file:// 页面，不依赖外网。
const uploadDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-upload-'))
const uploadPagePath = join(uploadDir, 'upload.html')
const uploadFilePath = join(uploadDir, 'cdp.txt')
writeFileSync(uploadPagePath, '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
  + '<title>cdp-upload</title></head><body style="margin:0">'
  + '<input id="single" type="file" style="position:fixed;left:20px;top:20px;width:260px;height:32px">'
  + '<label id="picker" for="coord" style="position:fixed;left:20px;top:120px;display:block;'
  + 'width:200px;height:48px;background:#ddd;text-align:center;line-height:48px">picker</label>'
  + '<input id="coord" type="file" style="display:none">'
  + '<script>window.__changes=[];Array.prototype.forEach.call('
  + 'document.querySelectorAll("input[type=file]"),function(i){i.addEventListener("change",function(){'
  + 'window.__changes.push({id:i.id,names:Array.prototype.map.call(i.files,function(f){return f.name})})})})'
  + '</script></body></html>', 'utf8')
writeFileSync(uploadFilePath, 'cdp')
const uploadPageUrl = pathToFileURL(uploadPagePath).href

// 下载夹具：本地 HTTP 服务（URL 模式只能走 HTTP(S)），页面上的 download 链接覆盖点击触发路径。
const HTTP_BODY = Buffer.from('cdp-http-body')
const CLICK_BODY = Buffer.from('cdp-click-body')
const downloadServer = createHttpServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>cdp-download</title></head>'
      + '<body style="margin:0"><a id="cdp-download" href="/files/cdp-click.txt" download="cdp-click.txt"'
      + ' style="position:fixed;left:20px;top:20px;display:block;width:240px;height:40px;background:#eee">'
      + 'download</a></body></html>')
    return
  }
  // cookie 夹具：CDP 重置语义需要 http 源（data: URL 不能读写 cookie）。
  if (path === '/cookie') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>cdp-cookie</title></head>'
      + '<body><p>cookie</p></body></html>')
    return
  }
  if (path === '/files/cdp-http.txt') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="cdp-http.txt"',
    })
    res.end(HTTP_BODY)
    return
  }
  if (path === '/files/cdp-click.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(CLICK_BODY)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('unknown')
})
await new Promise((resolve) => downloadServer.listen(0, '127.0.0.1', resolve))
const downloadBase = `http://127.0.0.1:${downloadServer.address().port}`

const child = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

const endpoint = `http://127.0.0.1:${port}`

try {
  const ready = await waitForDevTools(port)
  check('Edge 远程调试端点就绪', ready, endpoint)
  if (!ready) throw new Error('devtools endpoint never came up')

  console.log('== 用例 1：非 loopback 端点被拒绝 ==')
  {
    const message = await expectThrow(() => launch('test-cdp-bad', { mode: 'cdp', cdpEndpoint: 'http://10.0.0.5:9222' }, 'test-cdp-bad'))
    check('非 loopback 端点报错', Boolean(message) && message.includes('loopback'), String(message))
    const badMode = await expectThrow(() => launch('test-cdp-bad', { mode: 'cdp', cdpEndpoint: 'ftp://127.0.0.1:9222' }, 'test-cdp-bad'))
    check('非 http 端点报错', Boolean(badMode) && badMode.includes('只支持 http'), String(badMode))
  }

  console.log('== 用例 2：CDP 接管 ==')
  {
    const info = await launch(KEY, { mode: 'cdp', cdpEndpoint: endpoint }, SID)
    session = requireSession(KEY)
    check('接管成功且 mode 为 cdp', info.reused === false && info.mode === 'cdp', JSON.stringify(info))
    check('摘要包含接管端点', info.summary.includes(endpoint), info.summary)
    const list = await tabs(KEY)
    check('tab 列表取 context.pages()（至少 1 个）', list.tabs.length >= 1, JSON.stringify(list.tabs))
    check('tab 列表 mode 为 cdp', list.mode === 'cdp', list.mode)
    check('接管页 origin 为 adopted、loading 为布尔', list.tabs.every((tab) => tab.origin === 'adopted'
      && typeof tab.loading === 'boolean'), JSON.stringify(list.tabs))
    const alive = child.exitCode === null && !child.killed
    check('接管不杀浏览器进程', alive, `exitCode=${child.exitCode}`)
    // 面板 tab 需要带 mode / endpoint，否则面板会一直显示「隔离」。
    const panelTabs = await listPanelTabs()
    check('面板 tab 带 mode=cdp 与实际接管端点', panelTabs.length >= 1
      && panelTabs.every((tab) => tab.mode === 'cdp' && tab.endpoint === endpoint), JSON.stringify(panelTabs))
  }

  console.log('== 用例 3：接管后导航 / 求值 / 截图 ==')
  {
    const info = await navigate(session, 'data:text/html,<title>cdp-page</title><h1 id="h">cdp-heading</h1>', 'load')
    check('导航成功', info.title === 'cdp-page', JSON.stringify(info))
    const value = await evaluate(session, "document.getElementById('h').textContent")
    check('求值成功', value.value === 'cdp-heading', JSON.stringify(value.value))
    const shot = await screenshot(session, currentTab(session), { name: 'cdp-shot', format: 'jpeg', quality: 70 })
    check('截图成功（无固定视口时按内尺寸兜底）', shot.meta.width > 0 && shot.meta.height > 0, JSON.stringify(shot.meta))
    const list = await tabs(KEY)
    check('导航没有新建 page', list.tabs.length >= 1, JSON.stringify(list.tabs.map((t) => t.tab_id)))
  }

  console.log('== 用例 3A：CDP 接管下对话框策略生效并记录 ==')
  {
    await navigate(session, 'data:text/html,<title>cdp-dialog</title><p>dialog</p>', 'load')
    await setDialogPolicy(session, 'accept')
    const confirmValue = await evaluate(session, "confirm('CDP 确认吗')")
    const confirmInfo = await dialogEntries(session)
    check('CDP 接管下 confirm 被策略应答并记录', confirmValue.value === true
      && confirmInfo.policy === 'accept'
      && confirmInfo.entries.at(-1)?.type === 'confirm'
      && confirmInfo.entries.at(-1)?.message === 'CDP 确认吗'
      && confirmInfo.entries.at(-1)?.accepted === true,
    JSON.stringify({ value: confirmValue.value, info: confirmInfo }))

    await setDialogPolicy(session, 'accept', 'CDP 文本')
    const promptValue = await evaluate(session, "prompt('CDP 输入', 'CDP 默认')")
    const promptInfo = await dialogEntries(session)
    check('CDP 接管下 prompt 使用 prompt_text 并保留默认值', promptValue.value === 'CDP 文本'
      && promptInfo.promptText === 'CDP 文本'
      && promptInfo.entries.at(-1)?.type === 'prompt'
      && promptInfo.entries.at(-1)?.defaultValue === 'CDP 默认'
      && promptInfo.entries.at(-1)?.accepted === true,
    JSON.stringify({ value: promptValue.value, info: promptInfo }))
  }

  console.log('== 用例 3B：CDP 接管下 selector 上传生效 ==')
  {
    await navigate(session, uploadPageUrl, 'load')
    const info = await upload(session, { selector: '#single' }, uploadFilePath)
    const names = await evaluate(session,
      "Array.from(document.getElementById('single').files).map(function (f) { return f.name })")
    check('CDP 接管下 selector 上传生效', info.mode === 'selector'
      && JSON.stringify(names.value) === JSON.stringify(['cdp.txt']),
    JSON.stringify({ info, names: names.value }))
  }

  console.log('== 用例 3C：CDP 接管下坐标上传生效 ==')
  {
    // 坐标取 picker 标签（label[for=coord]）中心，真实点击后由 Playwright 接住文件选择器。
    const info = await upload(session, { x: 120, y: 144 }, uploadFilePath)
    const names = await evaluate(session,
      "Array.from(document.getElementById('coord').files).map(function (f) { return f.name })")
    const changes = await evaluate(session,
      "window.__changes.filter(function (c) { return c.id === 'coord' })")
    check('CDP 接管下坐标上传生效', info.mode === 'point' && info.x === 120 && info.y === 144
      && JSON.stringify(names.value) === JSON.stringify(['cdp.txt']) && changes.value.length === 1,
    JSON.stringify({ info, names: names.value, changes: changes.value }))
  }

  console.log('== 用例 3D：CDP 接管下下载（直接 URL / 点击触发）==')
  {
    const tabsBefore = (await tabs(KEY)).tabs
    const contentTabsBefore = tabsBefore.filter((tab) => !String(tab.url).startsWith('edge://'))
    const httpInfo = await download(session, { url: `${downloadBase}/files/cdp-http.txt` })
    check('CDP 接管下直接 URL 下载成功', httpInfo.source === 'request'
      && httpInfo.filename === 'cdp-http.txt' && existsSync(httpInfo.file)
      && readFileSync(httpInfo.file).equals(HTTP_BODY), JSON.stringify(httpInfo))
    check('CDP 下载 sha256 与内容一致', httpInfo.sha256
      === createHash('sha256').update(HTTP_BODY).digest('hex') && /^[0-9a-f]{64}$/.test(httpInfo.sha256),
    httpInfo.sha256)

    await navigate(session, `${downloadBase}/page`, 'load')
    const clickInfo = await download(session, { selector: '#cdp-download' })
    check('CDP 接管下点击触发下载成功（createReadStream 路径）', clickInfo.source === 'browser'
      && clickInfo.filename === 'cdp-click.txt' && existsSync(clickInfo.file)
      && readFileSync(clickInfo.file).equals(CLICK_BODY), JSON.stringify(clickInfo))

    // 规格 0016「状态变化 / 标签页」：工具不额外建页；浏览器自己打开的 edge:// 内部页
    // （本机 Edge 下载开始时会开 edge://downloads-hub/）不算工具建页。
    const tabsAfter = (await tabs(KEY)).tabs
    const contentTabsAfter = tabsAfter.filter((tab) => !String(tab.url).startsWith('edge://'))
    const extraPages = tabsAfter.filter((tab) => !tabsBefore.some((before) => before.tab_id === tab.tab_id))
    check('CDP 下载不新建标签页', contentTabsAfter.length === contentTabsBefore.length
      && extraPages.every((tab) => String(tab.url).startsWith('edge://')),
    JSON.stringify({ before: tabsBefore.map((tab) => `${tab.tab_id}:${tab.url}`), after: tabsAfter.map((tab) => `${tab.tab_id}:${tab.url}`) }))
  }

  console.log('== 用例 3E：CDP 接管下 evaluate 死循环超时后页面仍可求值 ==')
  {
    await navigate(session, 'data:text/html,<title>cdp-evaluate-timeout</title><h1 id="h">cdp-timeout</h1>', 'load')
    const started = Date.now()
    const message = await expectThrow(() => evaluate(session, 'while (true) {}', undefined,
      { timeoutMs: MIN_EVALUATE_TIMEOUT_MS }))
    const elapsed = Date.now() - started
    const after = await evaluate(session, 'document.title')
    const alive = child.exitCode === null && !child.killed
    check('CDP 模式 evaluate 死循环超时后页面仍可求值',
      Boolean(message) && message.includes('脚本执行超时')
        && elapsed >= MIN_EVALUATE_TIMEOUT_MS && elapsed <= 5000
        && after.value === 'cdp-evaluate-timeout' && alive,
      JSON.stringify({ elapsed, message, after: after.value, alive }))
  }

  console.log('== 用例 3F：CDP 模式下 close 再 start 不清用户浏览器 cookie ==')
  {
    await navigate(session, `${downloadBase}/cookie`, 'load')
    const wrote = await evaluate(session,
      "(() => { document.cookie = 'cdpKeep=1; path=/'; return document.cookie })()")
    check('用例 3F 前置：cookie 已写入 CDP 用户浏览器',
      String(wrote.value).includes('cdpKeep=1'), JSON.stringify(wrote.value))

    const closedInfo = await close(KEY)
    check('CDP 重置第一步：close 只断连', closedInfo.closed === true && closedInfo.mode === 'cdp',
      JSON.stringify(closedInfo))
    const restarted = await launch(KEY, { mode: 'cdp', cdpEndpoint: endpoint }, SID)
    session = requireSession(KEY)
    await navigate(session, `${downloadBase}/cookie`, 'load')
    const cookie = await evaluate(session, 'document.cookie')
    check('CDP 模式下 close 再 start 不清用户浏览器 cookie',
      String(cookie.value).includes('cdpKeep=1') && restarted.mode === 'cdp' && restarted.reused === false,
      JSON.stringify({ cookie: cookie.value, mode: restarted.mode, reused: restarted.reused }))

    const list = await tabs(KEY)
    check('CDP 重连后按用户浏览器重新接管（adopted）',
      list.mode === 'cdp' && list.tabs.length >= 1 && list.tabs.every((tab) => tab.origin === 'adopted'),
      JSON.stringify(list.tabs))
    const alive = child.exitCode === null && !child.killed
    check('CDP 重置不结束用户浏览器进程', alive, `exitCode=${child.exitCode}`)
  }

  console.log('== 用例 3G：CDP 接管下粘贴投递与 sanitize=false 拒绝 ==')
  {
    await navigate(session, 'data:text/html,<title>cdp-clipboard</title>'
      + '<div id="editor" contenteditable="true" style="width:300px;height:60px;border:1px solid black">cdp</div>'
      + '<script>window.__pastes=[];document.addEventListener("paste",function(e){'
      + 'window.__pastes.push({id:e.target&&e.target.id,'
      + 'text:e.clipboardData?(e.clipboardData.getData("text/plain")||""):null,'
      + 'html:e.clipboardData?(e.clipboardData.getData("text/html")||""):null});'
      + 'if(e.target&&e.target.id==="editor")e.preventDefault()})</script>', 'load')
    const info = await clipboard(session,
      { action: 'paste', text: 'CDP 粘贴', html: '<b>CDP</b>', selector: '#editor' })
    const recorded = await evaluate(session, 'window.__pastes[window.__pastes.length - 1]')
    check('CDP 接管下粘贴事件投递生效', info.accepted === true && info.target?.mode === 'selector'
      && recorded.value?.id === 'editor' && recorded.value?.text === 'CDP 粘贴'
      && recorded.value?.html === '<b>CDP</b>',
    JSON.stringify({ info, recorded: recorded.value }))

    // cdp 模式不自动授权，write 的结果取决于用户浏览器，因此只覆盖 sanitize=false 的拒绝路径。
    const rawMessage = await expectThrow(() => clipboard(session,
      { action: 'paste', text: 'x', html: '<b>x</b>', sanitize: false }))
    check('CDP 接管下 sanitize=false 报错', Boolean(rawMessage)
      && rawMessage.includes('sanitize=false 只在 isolated 模式可用'), String(rawMessage))
  }

  console.log('== 用例 3H：CDP 接管下双击 / 右键 / 按住 Shift 点击 ==')
  {
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>cdp-click</title></head>'
      + '<body style="margin:0"><button id="btn" style="position:fixed;left:100px;top:100px;'
      + 'width:120px;height:40px">CDP Press Me</button>'
      + '<script>window.__events=[];'
      + '["mousedown","mouseup","click","dblclick","contextmenu","auxclick"].forEach(function(name){'
      + 'document.addEventListener(name,function(event){'
      + 'window.__events.push({type:name,detail:event.detail,button:event.button,'
      + 'shiftKey:event.shiftKey,ctrlKey:event.ctrlKey})'
      + '},true)})'
      + '</script></body></html>'
    await navigate(session, 'data:text/html;charset=utf-8,' + encodeURIComponent(html), 'load')
    // CDP 接管的用户浏览器里，插件当前页不一定是窗口的前台 tab（前面的下载用例可能
    // 让 Edge 自己开过内部页）；后台 tab 上 locator.click 会报 element is outside of the
    // viewport。这里只把被测页切到前台，属于测试夹具准备，不改插件行为。
    await currentTab(session).page.bringToFront()

    await evaluate(session, 'window.__events = []')
    const dbl = await click(session, { selector: '#btn', clickCount: 2 })
    const dblEvents = (await evaluate(session, 'window.__events')).value
    const dblClicks = dblEvents.filter((event) => event.type === 'click')
    const dblDbl = dblEvents.filter((event) => event.type === 'dblclick')
    await evaluate(session, 'window.__events = []')
    const right = await click(session, { selector: '#btn', button: 'right' })
    const rightEvents = (await evaluate(session, 'window.__events')).value
    const rightClicks = rightEvents.filter((event) => event.type === 'click')
    const rightMenus = rightEvents.filter((event) => event.type === 'contextmenu')
    check('CDP 接管下双击与右键事件生效',
      dbl.clickCount === 2 && dblClicks.length === 2
        && dblClicks.map((event) => event.detail).join(',') === '1,2'
        && dblDbl.length === 1
        && right.button === 'right' && right.summary === '点击 selector "#btn"（右键）'
        && rightMenus.length === 1 && rightClicks.length === 0,
      JSON.stringify({ dbl, dblEvents, right, rightEvents }))

    await evaluate(session, 'window.__events = []')
    const down = await press(session, 'Shift', undefined, { action: 'down' })
    const heldClick = await click(session, { selector: '#btn' })
    const heldEvents = (await evaluate(session, 'window.__events')).value
    const heldClicks = heldEvents.filter((event) => event.type === 'click')
    const up = await press(session, 'Shift', undefined, { action: 'up' })
    await evaluate(session, 'window.__events = []')
    const plainClick = await click(session, { selector: '#btn' })
    const plainEvents = (await evaluate(session, 'window.__events')).value
    const plainClicks = plainEvents.filter((event) => event.type === 'click')
    check('CDP 接管下按住 Shift 点击生效',
      down.held === true && heldClick.summary === '点击 selector "#btn"'
        && heldClicks.length === 1 && heldClicks[0].shiftKey === true
        && up.held === false && plainClick.summary === '点击 selector "#btn"'
        && plainClicks.length === 1 && plainClicks[0].shiftKey === false,
      JSON.stringify({ down, up, heldClicks, plainClicks }))
  }

  console.log('== 用例 4：close 只断开连接 ==')
  {
    const info = await close(KEY)
    check('close 返回 cdp 模式', info.closed === true && info.mode === 'cdp', JSON.stringify(info))
    await sleep(500)
    check('浏览器进程仍然存活', child.exitCode === null && !child.killed, `exitCode=${child.exitCode}`)
    // 端点仍然可用，证明用户浏览器没被关掉。
    const stillUp = await waitForDevTools(port, 3000)
    check('DevTools 端点仍可访问', stillUp, endpoint)
  }
} finally {
  await closeAll()
  child.kill()
  downloadServer.closeAllConnections?.()
  await new Promise((resolve) => downloadServer.close(resolve))
  await sleep(500)
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // Windows 上目录可能还被进程占用，留给系统临时目录清理
  }
  try {
    rmSync(uploadDir, { recursive: true, force: true })
  } catch {
    // 同上：夹具目录只是临时文件，删不掉不影响结论
  }
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
