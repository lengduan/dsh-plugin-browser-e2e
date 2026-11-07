/**
 * browser_e2e_upload 能力验证（规格：specs/功能规格/0010-upload-file.md）。
 *
 * 覆盖：
 *   - 夹具页：本地临时目录 + file:// 页面（不依赖外网），可见 / 隐藏文件控件与 snapshot 的关系；
 *   - ref / selector / 坐标三条下发路径，multiple 多文件与文件顺序；
 *   - 覆盖与清空（clear 缺省 true / false / files: []）；
 *   - 宿主侧路径校验与 maxBytes 区间；
 *   - 目标控件校验（标签、类型、disabled、multiple、目标参数三选一、失效 ref）；
 *   - 工具契约（files 必填、字符串与数组、tab_id）。
 *
 * 直接调用 lib/page.js / lib/tools.js 的真实实现（不 mock），真起无头 Edge。
 * 运行：node tests/upload.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { evaluate, navigate, snapshot, upload } = await import('../lib/page.js')

const KEY = 'test-upload-key'
const SID = 'test-upload-session'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
<head><meta charset="utf-8"><title>upload-fixture</title></head>
<body style="margin:0">
  <input id="single" type="file" style="position:fixed;left:20px;top:20px;width:260px;height:32px">
  <input id="multi" type="file" multiple style="position:fixed;left:20px;top:80px;width:260px;height:32px">
  <input id="disabled" type="file" disabled style="position:fixed;left:20px;top:140px;width:260px;height:32px">
  <input id="text" type="text" style="position:fixed;left:20px;top:200px;width:260px;height:32px">
  <label id="label" for="hidden" style="position:fixed;left:20px;top:260px;display:block;width:200px;height:24px;background:#eee">label-for-hidden</label>
  <label id="picker" for="coord" style="position:fixed;left:20px;top:320px;display:block;width:200px;height:48px;background:#ddd;text-align:center;line-height:48px">picker</label>
  <input id="gone" type="file" style="position:fixed;left:20px;top:380px;width:260px;height:32px">
  <input id="hidden" type="file" style="display:none">
  <input id="coord" type="file" style="display:none">
  <script>
    window.__changes = [];
    window.__clicks = [];
    document.addEventListener('click', function (event) {
      var target = event.target || {};
      window.__clicks.push(target.id || target.tagName || '');
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[type=file]'), function (input) {
      input.addEventListener('change', function () {
        window.__changes.push({
          id: input.id,
          count: input.files.length,
          names: Array.prototype.map.call(input.files, function (file) { return file.name; })
        });
      });
    });
  </script>
</body>
</html>
`

const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-test-'))
const fixtureFile = join(dir, 'fixture.html')
writeFileSync(fixtureFile, FIXTURE_HTML, 'utf8')
const aFile = join(dir, 'a.txt')
const bFile = join(dir, 'b.txt')
const cFile = join(dir, 'c.txt')
const bigFile = join(dir, 'big.txt')
writeFileSync(aFile, 'A')
writeFileSync(bFile, 'BB')
writeFileSync(cFile, 'CCC')
writeFileSync(bigFile, 'x'.repeat(4096))
const fixtureUrl = pathToFileURL(fixtureFile).href

const baseline = edgeRootCount()
let session = null
let firstTabId = null

try {
  console.log('== 用例 1：启动浏览器与本地夹具页面 ==')
  {
    await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    const loaded = await navigate(session, fixtureUrl, 'load')
    firstTabId = loaded.tabId
    const protocol = await evaluate(session, 'location.protocol')
    check('本地夹具页面加载成功', loaded.title === 'upload-fixture' && protocol.value === 'file:',
      JSON.stringify({ title: loaded.title, protocol: protocol.value }))
  }

  // 工具表：用例 3 / 6 / 9 通过真实工具定义下发（同时验证工具层归一与文本）。
  const { apply } = await import('../lib/index.js')
  const definitions = []
  apply({
    get: () => undefined,
    tools: { register: (definition) => definitions.push(definition) },
    on: () => () => {},
    effect: (factory) => { factory() },
  })
  const uploadTool = definitions.find((definition) => definition.name === 'browser_e2e_upload')
  const exec = { agent: { id: KEY } }

  const fixtureSnapshot = await snapshot(session)
  const singleNode = fixtureSnapshot.nodes.find((node) => node.id === 'single')
  const multiNode = fixtureSnapshot.nodes.find((node) => node.id === 'multi')
  check('可见文件控件出现在 snapshot 里', Boolean(singleNode) && Boolean(multiNode)
    && singleNode.box.width > 0 && singleNode.box.height > 0,
  JSON.stringify(fixtureSnapshot.nodes.filter((node) => node.tag === 'input')))
  check('隐藏文件控件不在 snapshot 里',
    !fixtureSnapshot.nodes.some((node) => node.id === 'hidden') && !fixtureSnapshot.nodes.some((node) => node.id === 'coord'),
    JSON.stringify(fixtureSnapshot.nodes.map((node) => node.id)))

  console.log('== 用例 2：ref 路径 ==')
  {
    const info = await upload(session, { ref: singleNode.ref }, aFile)
    check('ref 上传生效', info.mode === 'ref' && info.ref === singleNode.ref && info.replaced === 0
      && info.files.length === 1 && info.files[0].name === 'a.txt' && info.totalBytes === 1, JSON.stringify(info))
    const selected = await evaluate(session,
      "Array.from(document.getElementById('single').files).map(function (f) { return f.name })")
    check('input.files 的名字与入参一致', Array.isArray(selected.value) && selected.value.length === 1
      && selected.value[0] === 'a.txt', JSON.stringify(selected.value))
    const changes = await evaluate(session,
      "window.__changes.filter(function (c) { return c.id === 'single' })")
    check('change 事件触发一次且 files.length 为 1', Array.isArray(changes.value) && changes.value.length === 1
      && changes.value[0].count === 1 && JSON.stringify(changes.value[0].names) === JSON.stringify(['a.txt']),
    JSON.stringify(changes.value))
  }

  console.log('== 用例 3：selector 路径（隐藏控件）==')
  {
    const text = await uploadTool.execute({ selector: '#hidden', files: aFile }, exec)
    const selected = await evaluate(session,
      "Array.from(document.getElementById('hidden').files).map(function (f) { return f.name })")
    check('隐藏文件控件用 selector 上传生效', typeof text === 'string'
      && text.includes('上传 1 个文件到 selector "#hidden"') && JSON.stringify(selected.value) === JSON.stringify(['a.txt']),
    JSON.stringify({ text, selected: selected.value }))
    check('摘要标注当前不可见', typeof text === 'string' && text.includes('当前不可见（按 DOM 注入）'), String(text))
  }

  console.log('== 用例 4：multiple 控件多文件 ==')
  {
    const info = await upload(session, { ref: multiNode.ref }, [aFile, bFile])
    check('multiple 控件接受 2 个文件', info.multiple === true && info.files.length === 2
      && info.totalBytes === 3, JSON.stringify(info))
    const selected = await evaluate(session,
      "Array.from(document.getElementById('multi').files).map(function (f) { return f.name })")
    check('files 顺序与入参一致', JSON.stringify(selected.value) === JSON.stringify(['a.txt', 'b.txt']),
      JSON.stringify(selected.value))
  }

  console.log('== 用例 5：坐标路径 ==')
  {
    const picker = fixtureSnapshot.nodes.find((node) => node.id === 'picker')
    const x = picker.box.x + Math.round(picker.box.width / 2)
    const y = picker.box.y + Math.round(picker.box.height / 2)
    const info = await upload(session, { x, y }, aFile)
    const selected = await evaluate(session,
      "Array.from(document.getElementById('coord').files).map(function (f) { return f.name })")
    const changes = await evaluate(session,
      "window.__changes.filter(function (c) { return c.id === 'coord' })")
    check('坐标点击接住文件选择器并写入', info.mode === 'point' && info.x === x && info.y === y
      && JSON.stringify(selected.value) === JSON.stringify(['a.txt']) && changes.value.length === 1
      && changes.value[0].count === 1,
    JSON.stringify({ info, selected: selected.value, changes: changes.value }))
  }

  console.log('== 用例 6：覆盖与清空 ==')
  {
    const replacedText = await uploadTool.execute({ selector: '#single', files: bFile }, exec)
    const replacedNames = await evaluate(session,
      "Array.from(document.getElementById('single').files).map(function (f) { return f.name })")
    check('第二次上传替换第一次的选择', JSON.stringify(replacedNames.value) === JSON.stringify(['b.txt']),
      JSON.stringify({ text: replacedText, names: replacedNames.value }))
    check('摘要回显已替换原有的 1 个选择', typeof replacedText === 'string' && replacedText.includes('已替换原有 1 个选择'), String(replacedText))

    const notCleared = await expectThrow(() => upload(session, { selector: '#single' }, cFile, { clear: false }))
    const afterNotCleared = await evaluate(session,
      "Array.from(document.getElementById('single').files).map(function (f) { return f.name })")
    check('clear=false 且已有选择时报错且选择未变', Boolean(notCleared)
      && notCleared.includes('clear=false 不会覆盖') && JSON.stringify(afterNotCleared.value) === JSON.stringify(['b.txt']),
    JSON.stringify({ message: notCleared, names: afterNotCleared.value }))

    const cleared = await upload(session, { selector: '#single' }, [])
    const afterClear = await evaluate(session,
      "Array.from(document.getElementById('single').files).map(function (f) { return f.name })")
    check('files 传空数组后 files.length 为 0', cleared.cleared === true && cleared.files.length === 0
      && Array.isArray(afterClear.value) && afterClear.value.length === 0
      && cleared.summary.includes('清空 selector "#single" 的 1 个已选文件'),
    JSON.stringify({ cleared, names: afterClear.value }))

    const emptyNotClear = await expectThrow(() => upload(session, { selector: '#single' }, [], { clear: false }))
    check('files 为空且 clear=false 时报错', Boolean(emptyNotClear)
      && emptyNotClear.includes('files 为空且 clear=false'), String(emptyNotClear))

    const clicksBefore = await evaluate(session, 'window.__clicks.length')
    const pointNotClear = await expectThrow(() => upload(session, { x: 120, y: 344 }, cFile, { clear: false }))
    const clicksAfter = await evaluate(session, 'window.__clicks.length')
    check('clear=false 与 x + y 组合在点击前报错', Boolean(pointNotClear)
      && pointNotClear.includes('x + y 路径不支持 clear=false') && clicksBefore.value === clicksAfter.value,
    JSON.stringify({ message: pointNotClear, clicksBefore: clicksBefore.value, clicksAfter: clicksAfter.value }))
  }

  console.log('== 用例 7：宿主侧校验 ==')
  {
    const relative = await expectThrow(() => upload(session, { selector: '#single' }, 'a.txt'))
    check('相对路径报「必须是绝对路径」', Boolean(relative) && relative.includes('必须是绝对路径'), String(relative))
    const missing = await expectThrow(() => upload(session, { selector: '#single' }, join(dir, 'missing-file.txt')))
    check('不存在的路径报「文件不存在」', Boolean(missing) && missing.includes('文件不存在'), String(missing))
    const directory = await expectThrow(() => upload(session, { selector: '#single' }, dir))
    check('目录报「路径不是文件」', Boolean(directory) && directory.includes('路径不是文件'), String(directory))
    const tooBig = await expectThrow(() => upload(session, { selector: '#single' }, bigFile, { maxBytes: 1024 }))
    check('超过 maxBytes 报「超过上限」', Boolean(tooBig) && tooBig.includes('超过上限')
      && tooBig.includes('maxBytes=1024'), String(tooBig))
    const tooMany = Array.from({ length: 21 }, (_, index) => join(dir, `bulk-${index}.txt`))
    const tooManyMessage = await expectThrow(() => upload(session, { selector: '#single' }, tooMany))
    check('21 个文件报「一次最多上传 20 个」', Boolean(tooManyMessage)
      && tooManyMessage.includes('一次最多上传 20 个文件') && tooManyMessage.includes('21'), String(tooManyMessage))
    const badMax = await expectThrow(() => upload(session, { selector: '#single' }, aFile, { maxBytes: 0 }))
    check('maxBytes 越界报「1..536870912」', Boolean(badMax)
      && badMax.includes('1..536870912') && badMax.includes('maxBytes'), String(badMax))
    const badFiles = await expectThrow(() => upload(session, { selector: '#single' }, 123))
    check('files 非字符串非数组报形态错误', Boolean(badFiles)
      && badFiles.includes('绝对路径字符串或其数组') && badFiles.includes('123'), String(badFiles))
  }

  console.log('== 用例 8：目标控件校验 ==')
  {
    const textTarget = await expectThrow(() => upload(session, { selector: '#text' }, aFile))
    check('文本输入框报「不是文件控件」', Boolean(textTarget)
      && textTarget.includes('不是文件控件') && textTarget.includes('input[type=text]'), String(textTarget))
    const disabledTarget = await expectThrow(() => upload(session, { selector: '#disabled' }, aFile))
    check('disabled 文件控件报「已禁用」', Boolean(disabledTarget) && disabledTarget.includes('已禁用'), String(disabledTarget))
    const labelTarget = await expectThrow(() => upload(session, { selector: '#label' }, aFile))
    check('label 报「目标不是文件控件」', Boolean(labelTarget)
      && labelTarget.includes('目标不是文件控件') && labelTarget.includes('是 label'), String(labelTarget))
    const multiUnsupported = await expectThrow(() => upload(session, { selector: '#single' }, [aFile, bFile]))
    check('无 multiple 的控件传 2 个文件报「不支持多选」', Boolean(multiUnsupported)
      && multiUnsupported.includes('不支持多选'), String(multiUnsupported))
    const noTarget = await expectThrow(() => upload(session, {}, aFile))
    check('三种目标都不给报「缺少上传目标」', Boolean(noTarget) && noTarget.includes('缺少上传目标'), String(noTarget))
    const twoTargets = await expectThrow(() => upload(session, { ref: '@0', selector: '#single' }, aFile))
    check('两种目标同给报「只能给一种」', Boolean(twoTargets) && twoTargets.includes('只能给一种'), String(twoTargets))
    const goneSnapshot = await snapshot(session)
    const goneNode = goneSnapshot.nodes.find((node) => node.id === 'gone')
    await evaluate(session, "document.getElementById('gone').remove()")
    const staleRef = await expectThrow(() => upload(session, { ref: goneNode?.ref }, aFile))
    check('失效 ref 报「已失效」', Boolean(goneNode) && Boolean(staleRef) && staleRef.includes('已失效'), String(staleRef))
  }

  console.log('== 用例 9：工具契约 ==')
  {
    const parameters = uploadTool.parameters
    const filesSchema = parameters.properties.files
    const oneOf = Array.isArray(filesSchema?.oneOf) ? filesSchema.oneOf : []
    check('browser_e2e_upload 把 files 列为必填', Array.isArray(parameters.required)
      && parameters.required.includes('files'), JSON.stringify(parameters.required))

    // tab_id 的实际语义：上传作用在指定页，不落到 active tab。
    const second = await navigate(session, fixtureUrl, 'load', { new_tab: true })
    const tab2 = second.tabId
    const asString = await uploadTool.execute({ selector: '#single', files: aFile, tab_id: tab2 }, exec)
    const tab2Names = await evaluate(session,
      "Array.from(document.getElementById('single').files).map(function (f) { return f.name })", tab2)
    const tab1Count = await evaluate(session, "document.getElementById('single').files.length", firstTabId)
    check('upload 接受 tab_id', 'tab_id' in parameters.properties && typeof tab2 === 'string'
      && JSON.stringify(tab2Names.value) === JSON.stringify(['a.txt']) && tab1Count.value === 0
      && asString.includes('上传 1 个文件到 selector "#single"'),
    JSON.stringify({ tab2, tab2Names: tab2Names.value, tab1Count: tab1Count.value, text: asString }))

    const asArray = await uploadTool.execute({ selector: '#multi', files: [aFile, bFile], tab_id: tab2 }, exec)
    const multiNames = await evaluate(session,
      "Array.from(document.getElementById('multi').files).map(function (f) { return f.name })", tab2)
    check('files 支持字符串与数组', oneOf.length === 2
      && oneOf.some((item) => item.type === 'string')
      && oneOf.some((item) => item.type === 'array' && item.items?.type === 'string')
      && asString.includes('上传 1 个文件')
      && asArray.includes('上传 2 个文件')
      && JSON.stringify(multiNames.value) === JSON.stringify(['a.txt', 'b.txt']),
    JSON.stringify({ oneOf, single: asString, array: asArray, names: multiNames.value }))
  }
} finally {
  await closeAll()
  rmSync(dir, { recursive: true, force: true })
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
