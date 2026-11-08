/**
 * browser_e2e_clipboard 能力验证（规格：specs/功能规格/0024-clipboard.md）。
 *
 * 覆盖：
 *   - 用例 1：本地 http 夹具（127.0.0.1 是安全上下文）与 contenteditable 目标；
 *   - 用例 2：缺省焦点目标的 paste 投递、两种口味、事件冒泡与可取消；
 *   - 用例 3：ref / selector 目标、互斥文案、selector 5000ms 超时、失效 ref；
 *   - 用例 4：HTML 缺省净化（script / on* / 表单控件 / javascript: URL）与 sanitize=false（isolated）；
 *   - 用例 5：input / textarea 未消费时的光标处兜底插入、普通元素未消费、无焦点报错；
 *   - 用例 6：write 纯文本 / 富文本 / plainDerived，以及 write→read 交替（测试自授 clipboard-read）；
 *   - 用例 7：参数校验与长度上限；
 *   - 用例 8：工具表契约（action 必填枚举、ref / selector / sanitize / tab_id、write 拒绝目标）。
 *
 * 直接调用 lib/page.js / lib/tools.js 的真实实现（不 mock），真起无头 Edge。
 * 运行：node tests/clipboard.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'
// 本测试会经 index.js 接线执行工具：历史写入关闭，避免污染真实 ~/.dsh 历史目录。
process.env.DSH_BROWSER_HISTORY = '0'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { clipboard, currentTab, evaluate, navigate, snapshot } = await import('../lib/page.js')

const KEY = 'test-clipboard-key'
const SID = 'test-clipboard-session'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
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

let pass = 0
let fail = 0
/** 逐条判定：断言用 node:assert/strict（失败不中断，继续跑完拿到完整清单）。 */
function check(label, ok, detail) {
  try {
    assert.ok(ok, detail)
    pass += 1
    console.log(`  PASS  ${label}`)
  } catch {
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

const FIXTURE_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>clipboard-fixture</title></head>
<body style="margin:0">
  <div id="editor" contenteditable="true" style="position:fixed;left:20px;top:20px;width:320px;height:48px;border:1px solid #333">起始文本</div>
  <div id="other" contenteditable="true" style="position:fixed;left:20px;top:90px;width:320px;height:48px;border:1px solid #666">另一个</div>
  <input id="input" type="text" value="abcd" style="position:fixed;left:20px;top:160px;width:320px;height:24px">
  <textarea id="textarea" style="position:fixed;left:20px;top:200px;width:320px;height:60px">efgh</textarea>
  <div id="plain" style="position:fixed;left:20px;top:280px;width:320px;height:40px;background:#eee">普通块</div>
  <div id="gone" style="position:fixed;left:20px;top:340px;width:200px;height:30px;background:#ddd">将删除</div>
  <script>
    window.__pastes = [];
    window.__inputEvents = 0;
    document.addEventListener('paste', function (event) {
      var el = event.target;
      var data = event.clipboardData;
      window.__pastes.push({
        id: el && el.id,
        tag: el && el.tagName,
        text: data ? data.getData('text/plain') : null,
        html: data ? data.getData('text/html') : null,
        hasPlain: data ? Array.prototype.indexOf.call(data.types, 'text/plain') >= 0 : false,
        hasHtml: data ? Array.prototype.indexOf.call(data.types, 'text/html') >= 0 : false,
        bubbles: event.bubbles,
        cancelable: event.cancelable
      });
      // 编辑器自己消费 paste：验证 accepted 由 preventDefault 判定。
      if (el && el.id === 'editor') event.preventDefault();
    });
    document.getElementById('input').addEventListener('input', function () { window.__inputEvents += 1 });
    document.getElementById('textarea').addEventListener('input', function () { window.__inputEvents += 1 });
  </script>
</body>
</html>
`

// 夹具走本地 HTTP：127.0.0.1 属于可信来源（安全上下文），write 才有 navigator.clipboard。
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(FIXTURE_HTML)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const baseline = edgeRootCount()
let session = null
let page = null

/** 读页内 paste 记录的最后一条。 */
async function lastPaste() {
  return (await evaluate(session, 'window.__pastes[window.__pastes.length - 1] ?? null')).value
}

try {
  console.log('== 用例 1：启动浏览器与本地夹具页面 ==')
  {
    await launch(KEY, { headless: true, viewportWidth: 900, viewportHeight: 700 }, SID)
    session = requireSession(KEY)
    page = currentTab(session).page
    const loaded = await navigate(session, origin, 'load')
    check('夹具页面加载成功', loaded.title === 'clipboard-fixture'
      && String(loaded.url).startsWith(`http://127.0.0.1:${server.address().port}`),
    JSON.stringify({ title: loaded.title, url: loaded.url }))
    const secure = await evaluate(session,
      "({ secure: window.isSecureContext, write: typeof navigator.clipboard?.write, item: typeof ClipboardItem })")
    check('夹具页面是安全上下文', secure.value?.secure === true && secure.value?.write === 'function'
      && secure.value?.item === 'function', JSON.stringify(secure.value))
    const fixtureSnapshot = await snapshot(session)
    const editorNode = fixtureSnapshot.nodes.find((node) => node.id === 'editor')
    check('contenteditable 目标在 snapshot 里', Boolean(editorNode) && editorNode.box.width > 0
      && editorNode.box.height > 0 && typeof editorNode.ref === 'string',
    JSON.stringify(editorNode ?? fixtureSnapshot.nodes.map((node) => node.id)))
  }

  console.log('== 用例 2：缺省焦点目标 ==')
  {
    const text = '焦点纯文本'
    const html = '<b>焦点富文本</b>'
    await evaluate(session, "document.getElementById('editor').focus()")
    const info = await clipboard(session, { action: 'paste', text, html })
    const recorded = await lastPaste()
    const active = (await evaluate(session, 'document.activeElement.id')).value
    check('无目标时投递到当前焦点元素', info.target?.mode === 'focused' && info.target?.tag === 'div'
      && recorded?.id === 'editor' && active === 'editor',
    JSON.stringify({ target: info.target, recorded, active }))
    check('页内 handler 收到 text/plain', recorded?.text === text && recorded?.hasPlain === true,
      JSON.stringify({ recorded, text }))
    check('页内 handler 收到 text/html', recorded?.html === html && recorded?.hasHtml === true,
      JSON.stringify({ recorded, html }))
    check('事件冒泡且可取消', recorded?.bubbles === true && recorded?.cancelable === true
      && info.accepted === true, JSON.stringify({ recorded, accepted: info.accepted }))
  }

  console.log('== 用例 3：ref / selector 目标 ==')
  {
    const fixtureSnapshot = await snapshot(session)
    const otherNode = fixtureSnapshot.nodes.find((node) => node.id === 'other')
    const byRef = await clipboard(session, { action: 'paste', text: 'REF 粘贴', ref: otherNode.ref })
    const refRecorded = await lastPaste()
    const refActive = (await evaluate(session, 'document.activeElement.id')).value
    check('ref 粘贴送达并聚焦目标', byRef.target?.mode === 'ref' && byRef.target?.ref === otherNode.ref
      && refRecorded?.id === 'other' && refActive === 'other',
    JSON.stringify({ target: byRef.target, recorded: refRecorded, active: refActive }))

    const bySelector = await clipboard(session, { action: 'paste', text: 'SELECTOR 粘贴', selector: '#other' })
    const selectorRecorded = await lastPaste()
    check('selector 粘贴送达', bySelector.target?.mode === 'selector'
      && bySelector.target?.selector === '#other' && selectorRecorded?.id === 'other',
    JSON.stringify({ target: bySelector.target, recorded: selectorRecorded }))

    const bothMessage = await expectThrow(() => clipboard(session,
      { action: 'paste', text: 'x', ref: otherNode.ref, selector: '#other' }))
    check('ref 与 selector 同时给报「只能给一种」', Boolean(bothMessage) && bothMessage.includes('只能给一种'),
      String(bothMessage))

    const missingMessage = await expectThrow(() => clipboard(session,
      { action: 'paste', text: 'x', selector: '#no-such-target' }))
    check('selector 5000ms 无匹配时报错', Boolean(missingMessage)
      && missingMessage.includes('5000ms') && missingMessage.includes('没有匹配到元素'), String(missingMessage))

    const goneSnapshot = await snapshot(session)
    const goneNode = goneSnapshot.nodes.find((node) => node.id === 'gone')
    await evaluate(session, "document.getElementById('gone').remove()")
    const staleMessage = await expectThrow(() => clipboard(session,
      { action: 'paste', text: 'x', ref: goneNode?.ref }))
    check('失效 ref 报「已失效」', Boolean(goneNode) && Boolean(staleMessage)
      && staleMessage.includes('已失效'), String(staleMessage))
  }

  console.log('== 用例 4：HTML 净化 ==')
  {
    const xssHtml = '<p onclick="window.__xss=1">hi</p><script>window.__xss=2</script>'
      + '<input id="evil"><button>b</button><a href=" javascript:window.__xss=3">j</a>'
      + '<img src="x" onerror="window.__xss=4">'
    const info = await clipboard(session,
      { action: 'paste', text: 'SAN', html: xssHtml, selector: '#editor' })
    const recorded = await lastPaste()
    const executed = (await evaluate(session, "typeof window.__xss !== 'undefined'")).value
    check('sanitize 移除 script', Boolean(recorded?.html) && !recorded.html.includes('<script')
      && executed === false, JSON.stringify({ html: recorded?.html, executed }))
    check('sanitize 移除 on* 事件属性', Boolean(recorded?.html)
      && !/on(click|error)\s*=/i.test(recorded.html), String(recorded?.html))
    check('sanitize 移除 input / button', Boolean(recorded?.html)
      && !/<input/i.test(recorded.html) && !/<button/i.test(recorded.html), String(recorded?.html))
    check('sanitize 移除 javascript: URL', Boolean(recorded?.html)
      && !/javascript:/i.test(recorded.html), String(recorded?.html))

    const rawInfo = await clipboard(session, {
      action: 'paste',
      text: 'RAW',
      sanitize: false,
      html: '<img src="x" onerror="window.__raw=1">',
      selector: '#editor',
    })
    const rawRecorded = await lastPaste()
    check('sanitize=false（isolated）保留 onerror 属性', rawInfo.sanitized === false
      && Boolean(rawRecorded?.html) && rawRecorded.html.includes('onerror'),
    JSON.stringify({ sanitized: rawInfo.sanitized, html: rawRecorded?.html }))
  }

  console.log('== 用例 5：兜底与未消费 ==')
  {
    await evaluate(session, "document.getElementById('input').focus(); document.getElementById('input').setSelectionRange(2, 2)")
    const inputInfo = await clipboard(session, { action: 'paste', text: 'XY', selector: '#input' })
    const inputValue = (await evaluate(session, "document.getElementById('input').value")).value
    check('input 未消费时在光标处插入文本', inputInfo.accepted === false && inputInfo.inserted === true
      && inputValue === 'abXYcd', JSON.stringify({ info: inputInfo, inputValue }))

    const inputEvents = (await evaluate(session, 'window.__inputEvents')).value
    check('inserted 时触发 input 事件', Number.isInteger(inputEvents) && inputEvents >= 1,
      JSON.stringify({ inputEvents }))

    await evaluate(session, "document.getElementById('textarea').focus(); document.getElementById('textarea').setSelectionRange(1, 3)")
    const textareaInfo = await clipboard(session, { action: 'paste', text: 'ZZ', selector: '#textarea' })
    const textareaValue = (await evaluate(session, "document.getElementById('textarea').value")).value
    check('textarea 未消费时插入', textareaInfo.accepted === false && textareaInfo.inserted === true
      && textareaValue === 'eZZh', JSON.stringify({ info: textareaInfo, textareaValue }))

    const plainInfo = await clipboard(session, { action: 'paste', text: 'DIV', selector: '#plain' })
    const divRecorded = await lastPaste()
    check('普通 div 未消费时 accepted=false 且不抛错', plainInfo.accepted === false
      && plainInfo.inserted === false && divRecorded?.id === 'plain',
    JSON.stringify({ info: plainInfo, recorded: divRecorded }))

    const blurred = await evaluate(session,
      "document.activeElement && document.activeElement.blur && document.activeElement.blur(); document.activeElement.tagName")
    const noFocusMessage = await expectThrow(() => clipboard(session, { action: 'paste', text: 'FOCUS' }))
    check('没有焦点元素时报「没有可粘贴的焦点元素」', blurred.value === 'BODY'
      && Boolean(noFocusMessage) && noFocusMessage.includes('没有可粘贴的焦点元素'), String(noFocusMessage))
  }

  console.log('== 用例 6：写入 ==')
  {
    const plainText = '剪贴板纯文本'
    const plainInfo = await clipboard(session, { action: 'write', text: plainText })
    check('write 纯文本可被页内读回', plainInfo.action === 'write' && plainInfo.rich === false
      && plainInfo.plainChars === plainText.length
      && plainInfo.summary === `写入剪贴板：纯文本 ${plainText.length} 个字符`,
    JSON.stringify(plainInfo))

    // 规格「边界」：grantPermissions 是整表授予，工具写完 clipboard-write 后，
    // 测试要读回必须自己重新授予 clipboard-read。
    await page.context().grantPermissions(['clipboard-read'])
    const readText = (await evaluate(session, 'navigator.clipboard.readText()')).value
    check('write 后页内读取纯文本口味一致', readText === plainText, JSON.stringify({ readText }))

    const richText = 'TEXT'
    const richHtml = '<b>BOLD</b>'
    const richInfo = await clipboard(session, { action: 'write', text: richText, html: richHtml })
    await page.context().grantPermissions(['clipboard-read'])
    const readRich = (await evaluate(session, `(async function () {
      const items = await navigator.clipboard.read()
      const out = { types: [] }
      for (const item of items) {
        out.types = Array.from(item.types)
        if (out.types.includes('text/plain')) out.plain = await (await item.getType('text/plain')).text()
        if (out.types.includes('text/html')) out.html = await (await item.getType('text/html')).text()
      }
      return out
    })()`)).value
    check('write 同时带 text 与 html 时两种口味都在',
      richInfo.rich === true && richInfo.plainChars === richText.length
        && richInfo.htmlChars === richHtml.length
        && richInfo.summary === `写入剪贴板：富文本 HTML（${richHtml.length} 字符）+ 纯文本 ${richText.length} 个字符`
        && JSON.stringify(readRich?.types) === JSON.stringify(['text/plain', 'text/html'])
        && readRich?.plain === richText && readRich?.html === richHtml,
      JSON.stringify({ info: richInfo, readRich }))

    const derivedInfo = await clipboard(session, { action: 'write', html: '<b>粗体</b>' })
    await page.context().grantPermissions(['clipboard-read'])
    const derivedPlain = (await evaluate(session, 'navigator.clipboard.readText()')).value
    check('write 只给 html 时 plainDerived=true', derivedInfo.rich === true
      && derivedInfo.plainDerived === true && derivedInfo.plainChars === '粗体'.length
      && derivedInfo.summary.includes('纯文本由 HTML 推导') && derivedPlain === '粗体',
    JSON.stringify({ info: derivedInfo, derivedPlain }))

    const markerText = 'PAYLOAD-TEXT-MARKER'
    const markerHtml = '<b>PAYLOAD-HTML-MARKER</b>'
    const markerInfo = await clipboard(session, { action: 'write', text: markerText, html: markerHtml })
    check('write 摘要不含 payload 内容', !markerInfo.summary.includes('PAYLOAD-TEXT-MARKER')
      && !markerInfo.summary.includes('PAYLOAD-HTML-MARKER')
      && markerInfo.summary.includes(`${markerText.length}`), JSON.stringify(markerInfo))
  }

  console.log('== 用例 7：参数校验 ==')
  {
    const noAction = await expectThrow(() => clipboard(session, {}))
    check('action 缺失报错', Boolean(noAction) && noAction.includes('只支持 write / paste')
      && noAction.includes('undefined'), String(noAction))

    const badAction = await expectThrow(() => clipboard(session, { action: 'copy', text: 'x' }))
    check('action 非法报错', Boolean(badAction) && badAction.includes('只支持 write / paste')
      && badAction.includes('copy'), String(badAction))

    const noPayload = await expectThrow(() => clipboard(session, { action: 'write' }))
    check('write 同时没有 text 与 html 报错', Boolean(noPayload)
      && noPayload.includes('需要 text 或 html'), String(noPayload))

    const emptyPasteText = await expectThrow(() => clipboard(session, { action: 'paste', text: '' }))
    check('paste 的 text 为空报错', Boolean(emptyPasteText) && emptyPasteText.includes('需要非空 text'),
      String(emptyPasteText))

    const badText = await expectThrow(() => clipboard(session, { action: 'paste', text: 123 }))
    check('text 非字符串报错', Boolean(badText) && badText.includes('text 必须是字符串')
      && badText.includes('123'), String(badText))

    const emptyHtmlPaste = await clipboard(session, { action: 'paste', text: 'EH', html: '', selector: '#plain' })
    const emptyHtmlWrite = await expectThrow(() => clipboard(session, { action: 'write', html: '' }))
    check('html 空串视为未给', emptyHtmlPaste.rich === false && emptyHtmlPaste.htmlChars === undefined
      && Boolean(emptyHtmlWrite) && emptyHtmlWrite.includes('需要 text 或 html'),
    JSON.stringify({ paste: emptyHtmlPaste, write: emptyHtmlWrite }))

    const longText = await expectThrow(() => clipboard(session, { action: 'write', text: 'x'.repeat(100001) }))
    check('超长 text 报「100000」', Boolean(longText) && longText.includes('100000')
      && longText.includes('100001'), String(longText))

    const longHtmlMessage = await expectThrow(() => clipboard(session,
      { action: 'paste', text: 'x', html: 'x'.repeat(200001) }))
    check('超长 html 报「200000」', Boolean(longHtmlMessage) && longHtmlMessage.includes('200000')
      && longHtmlMessage.includes('200001'), String(longHtmlMessage))

    const writeWithRef = await expectThrow(() => clipboard(session,
      { action: 'write', text: 'x', ref: '@0' }))
    check('write 带 ref 报「不作用页面元素」', Boolean(writeWithRef)
      && writeWithRef.includes('不作用页面元素'), String(writeWithRef))

    // 未启动：构造一个 idle 会话（pages 为空、没有 active tab），沿用不变量文案。
    const idleSession = { key: 'clipboard-idle', mode: 'isolated', pages: new Map(), activeTabId: null }
    const notStarted = await expectThrow(() => clipboard(idleSession, { action: 'paste', text: 'x' }))
    check('未启动时报「浏览器尚未启动或没有可用标签页」', Boolean(notStarted)
      && notStarted.includes('浏览器尚未启动或没有可用标签页'), String(notStarted))

    const unknownTab = await expectThrow(() => clipboard(session,
      { action: 'paste', text: 'x' }, 't999'))
    check('未知 tab_id 报「不存在」', Boolean(unknownTab)
      && unknownTab.includes('t999') && unknownTab.includes('不存在'), String(unknownTab))
  }

  console.log('== 用例 8：工具契约 ==')
  {
    const { apply } = await import('../lib/index.js')
    const definitions = []
    apply({
      get: () => undefined,
      tools: { register: (definition) => definitions.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    const clipboardTool = definitions.find((definition) => definition.name === 'browser_e2e_clipboard')
    const parameters = clipboardTool?.parameters ?? {}
    const exec = { agent: { id: KEY } }
    check('browser_e2e_clipboard 的 action 为必填枚举',
      JSON.stringify(parameters.required) === JSON.stringify(['action'])
        && parameters.additionalProperties === false
        && parameters.properties?.action?.type === 'string'
        && JSON.stringify(parameters.properties.action.enum) === JSON.stringify(['write', 'paste']),
      JSON.stringify(parameters))

    check('paste 目标参数含 ref / selector',
      parameters.properties?.ref?.type === 'string' && parameters.properties?.selector?.type === 'string'
        && String(parameters.properties.ref.description).includes('paste')
        && String(parameters.properties.selector.description).includes('paste'),
      JSON.stringify({ ref: parameters.properties?.ref, selector: parameters.properties?.selector }))

    check('参数含 sanitize 与 tab_id', parameters.properties?.sanitize?.type === 'boolean'
      && 'tab_id' in (parameters.properties ?? {}), JSON.stringify(Object.keys(parameters.properties ?? {})))

    const toolWriteWithRef = await expectThrow(() => clipboardTool.execute(
      { action: 'write', text: 'x', ref: '@0' }, exec))
    check('write 不接受 ref 目标（工具层同样拒绝）', Boolean(toolWriteWithRef)
      && toolWriteWithRef.includes('不作用页面元素'), String(toolWriteWithRef))

    // 工具返回三行文本：摘要 + 目标/口味 + 按动作的指引。
    const pasteText = await clipboardTool.execute({ action: 'paste', text: 'TOOL', selector: '#plain' }, exec)
    const writeText = await clipboardTool.execute({ action: 'write', text: 'TOOLW' }, exec)
    const pasteLines = String(pasteText).split('\n')
    const writeLines = String(writeText).split('\n')
    check('工具返回三行文本且目标 / 口味 / 指引齐备',
      pasteLines.length === 3 && pasteLines[0].startsWith('粘贴到 selector "#plain"')
        && pasteLines[1].includes('目标：selector "#plain"；sanitize=true；口味：text')
        && pasteLines[2].includes('browser_e2e_press("Control+V")')
        && writeLines.length === 3 && writeLines[0] === '写入剪贴板：纯文本 5 个字符'
        && writeLines[1].includes('目标：剪贴板；sanitize=true；口味：text')
        && writeLines[2].includes('isolated 模式会自动授予本会话浏览器上下文 clipboard-write'),
      JSON.stringify({ pasteLines, writeLines }))

    const writeMarkerText = await clipboardTool.execute(
      { action: 'write', text: 'TOOL-SECRET-TEXT', html: '<b>TOOL-SECRET-HTML</b>' }, exec)
    check('工具层文本同样不出现 payload 内容', !String(writeMarkerText).includes('TOOL-SECRET-TEXT')
      && !String(writeMarkerText).includes('TOOL-SECRET-HTML'), String(writeMarkerText))
  }
} finally {
  await closeAll()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
// 进程退出是异步的：每 250ms 轮询一次，最多等 10s，条件满足即通过。
const edgeSettled = await waitUntil(() => edgeRootCount() <= baseline)
const remaining = edgeRootCount()
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline,
  `baseline=${baseline} remaining=${remaining}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
