/**
 * browser_e2e_read 结构化读取验证（规格：specs/功能规格/0017-structured-read.md）。
 *
 * 覆盖：
 *   - 夹具页默认三节（controls / links / tables）与 forms 按需请求；
 *   - 控件记录：role / name / type / hasValue / value / checked / disabled / readonly /
 *     required / options / contenteditable / 所属表单，不可见控件排除；
 *   - 链接记录：绝对 href、text、target、超长 href 截断、不可见链接排除；
 *   - 表格记录：thead 最后一行 / 首行全 th / 无表头 / totalRows / maxItems 行截断 / ARIA 表格；
 *   - 唯一 selector：可直接 fill / click、表格命中、重复结构仍唯一、全部 unique 记录唯一命中；
 *   - 表单节：action / method / fieldCount；
 *   - 作用域 selector、参数错误文案、顺序与去重、maxItems 预算；
 *   - 文本预算按节份额截断并计入 omitted；只请求一节时可用全部预算；
 *   - 工具契约（注册、参数、tab_id、未知 tab 与未启动文案）；
 *   - 不污染快照 ref 表，read 后 ref 仍可点击。
 *
 * 夹具：node:http 本地临时服务，不依赖外网。直接调用 lib/read.js / lib/session.js /
 * lib/page.js / lib/tools.js 的真实实现，真起无头 Edge。
 *
 * 运行：node tests/read.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { click, currentTab, evaluate, fill, navigate, snapshot } = await import('../lib/page.js')
const { readStructured } = await import('../lib/read.js')

const KEY = 'test-read-key'
const SID = 'test-read-session'
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

/** 轮询直到条件成立；进程退出是异步的，固定 sleep 会偶发失败。 */
async function waitUntil(fn, timeoutMs = 10000, stepMs = 250) {
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

/** 由 Playwright 临时 profile 启动的 msedge 主进程数。 */
function playwrightEdgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'playwright_chromiumdev_profile' -and $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

/** 按 selector 找记录；没有记录时返回 undefined（断言里给出实际值）。 */
function bySelector(list, selector) {
  return (list ?? []).find((record) => record.selector === selector)
}

/** 从 snapshot 文本里解析某个名字对应的 ref。 */
function refOf(info, name) {
  const line = info.text.split('\n').find((row) => row.includes(`"${name}"`))
  const match = line && /\[(\d+)\]/.exec(line)
  return match ? `@${match[1]}` : null
}

/** 每节文本（标题行 + JSON 行）的字符数；末尾提示行不计入。 */
function sectionLengths(info) {
  const lines = info.text.split('\n')
  return info.sections.map((section, index) => {
    const title = lines[index * 2] ?? ''
    const json = lines[index * 2 + 1] ?? ''
    return title.length + 1 + json.length
  })
}

const BIG_LINK_COUNT = 120
const BIG_TABLE_ROWS = 100

const page = (title, body) => '<!doctype html><html lang="zh"><head><meta charset="utf-8">'  + `<title>${title}</title><style>body{margin:0;font:14px sans-serif}`
  + '.card{padding:4px;border:1px solid #ccc;margin:4px}</style></head><body>' + body + '</body></html>'

const LONG_LINK_PATH = 'L'.repeat(600)

/** 主夹具：四节记录、错误路径、selector 操作与快照 ref 都从这一页取。 */
const FIXTURE_HTML = page('read-fixture', [
  '<form id="profile-form" name="profile" action="/submit-profile" method="post"'
    + ' style="position:fixed;left:10px;top:10px;width:360px;height:250px">',
  '  <label for="name-input">姓名</label>',
  '  <input id="name-input" type="text" value="张三" placeholder="请输入姓名" style="width:200px;height:24px">',
  '  <label for="city">城市</label>',
  '  <select id="city" style="width:200px;height:24px">',
  '    <option value="beijing" selected>北京</option>',
  '    <option value="shanghai">上海</option>',
  '  </select>',
  '  <input id="readonly-input" type="text" value="只读" readonly style="width:200px;height:24px">',
  '  <input id="required-input" type="text" required style="width:200px;height:24px">',
  '  <input id="password" type="password" value="s3cret" style="width:200px;height:24px">',
  '  <input id="email" type="email" placeholder="邮箱" style="width:200px;height:24px">',
  '  <button id="submit-btn" type="submit" disabled>提交</button>',
  '</form>',
  '<select id="tags" multiple style="position:fixed;left:400px;top:10px;width:200px;height:90px">',
  '  <option value="a" selected>A</option>',
  '  <option value="b" selected>B</option>',
  '  <option value="c">C</option>',
  '</select>',
  '<label for="agree" style="position:fixed;left:400px;top:110px">同意条款</label>',
  '<input id="agree" type="checkbox" checked style="position:fixed;left:400px;top:130px;width:20px;height:20px">',
  '<div id="editor" contenteditable="true" style="position:fixed;left:400px;top:170px;width:200px;height:40px">可编辑内容</div>',
  '<button id="ref-btn" style="position:fixed;left:400px;top:220px;width:80px;height:30px"'
    + ' onclick="window.__refClicked=true">ref按钮</button>',
  '<input id="hidden-control" type="text" value="secret" style="display:none">',
  '<div id="cards" style="position:fixed;left:600px;top:10px;width:180px">',
  '  <div class="card"><span>卡片一</span><button class="dup-btn" onclick="window.__dup=\'one\'">删除</button></div>',
  '  <div class="card"><span>卡片二</span><button class="dup-btn" onclick="window.__dup=\'two\'">删除</button></div>',
  '</div>',
  '<a id="click-link" href="#clicked" style="position:fixed;left:600px;top:150px"'
    + ' onclick="window.__linkClicked=true;return false">可点击链接</a>',
  '<a id="docs-link" href="/docs/page?x=1" style="position:fixed;left:10px;top:300px">文档链接</a>',
  '<a id="blank-link" href="/blank" target="_blank" style="position:fixed;left:150px;top:300px">新窗口</a>',
  '<a id="long-link" href="/long?' + LONG_LINK_PATH + '" style="position:fixed;left:300px;top:300px">长链接</a>',
  '<a id="hidden-link" href="/hidden" style="display:none">隐藏链接</a>',
  '<table id="thead-table" style="position:fixed;left:10px;top:340px;width:300px">',
  '  <caption>销售表</caption>',
  '  <thead><tr><th>旧列一</th><th>旧列二</th></tr><tr><th>产品</th><th>数量</th></tr></thead>',
  '  <tbody><tr><td>苹果</td><td>1</td></tr><tr><td>香蕉</td><td>2</td></tr></tbody>',
  '</table>',
  '<table id="th-first-table" style="position:fixed;left:340px;top:340px;width:220px">',
  '  <tr><th>姓名</th><th>年龄</th></tr>',
  '  <tr><td>张三</td><td>20</td></tr>',
  '  <tr><td>李四</td><td>30</td></tr>',
  '</table>',
  '<table id="plain-table" style="position:fixed;left:600px;top:340px;width:180px">',
  '  <tr><td>a1</td><td>b1</td></tr>',
  '  <tr><td>a2</td><td>b2</td></tr>',
  '</table>',
  '<table id="rows-table" style="position:fixed;left:10px;top:430px;width:200px">',
  '  <tbody><tr><td>r1</td></tr><tr><td>r2</td></tr><tr><td>r3</td></tr><tr><td>r4</td></tr><tr><td>r5</td></tr></tbody>',
  '</table>',
  '<div role="table" id="aria-table" style="position:fixed;left:340px;top:430px;width:220px">',
  '  <div role="row"><div role="columnheader">名称</div><div role="columnheader">数量</div></div>',
  '  <div role="row"><div role="cell">苹果</div><div role="cell">3</div></div>',
  '</div>',
  '<script>window.__linkClicked=false;window.__dup="";window.__refClicked=false</script>',
].join('\n'))

/** 预算夹具：120 条链接，默认 maxItems 50 / 文本预算 16000 都会被触发。 */
const BIG_LINKS_HTML = page('read-big', Array.from({ length: BIG_LINK_COUNT }, (_, index) => (
  `<div><a class="big-link" href="/big/${index}">${'L'.repeat(200)}</a></div>`
)).join(''))

/** 预算夹具：100 行 × 两列 120 字符，只请求 tables 时文本预算会先丢行。 */
const BIG_TABLE_HTML = page('read-big-table', '<table id="big-table"><tbody>'
  + Array.from({ length: BIG_TABLE_ROWS }, () => (
    `<tr><td>${'C'.repeat(120)}</td><td>${'D'.repeat(120)}</td></tr>`
  )).join('')
  + '</tbody></table>')

const baseline = edgeRootCount()
const playwrightBaseline = playwrightEdgeRootCount()
const server = createServer((req, res) => {
  const path = String(req.url || '').split('?')[0]
  if (path === '/read-fixture') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
    return
  }
  if (path === '/read-big') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(BIG_LINKS_HTML)
    return
  }
  if (path === '/read-big-table') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(BIG_TABLE_HTML)
    return
  }
  if (path === '/long') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('long-ok')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  console.log('== 用例 1：启动、夹具页与默认三节 ==')
  {
    const started = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    session = requireSession(KEY)
    const nav = await navigate(session, `${base}/read-fixture`, 'load')
    check('夹具页加载成功', started.reused === false && nav.url === `${base}/read-fixture`
      && nav.title === 'read-fixture', JSON.stringify({ nav, started: started.summary }))

    const info = await readStructured(session)
    check('默认读取返回控件 / 链接 / 表格三节',
      JSON.stringify(info.sections) === JSON.stringify(['controls', 'links', 'tables'])
      && Array.isArray(info.controls) && Array.isArray(info.links) && Array.isArray(info.tables),
      JSON.stringify(info.sections))
    check('未请求的表单节不出现', !('forms' in info) && !('forms' in info.counts)
      && !('forms' in info.omitted) && !info.text.includes('表单'), JSON.stringify(Object.keys(info)))
    check('默认读取计数与摘要正确', info.counts.controls === 13 && info.counts.links === 4
      && info.counts.tables === 5 && info.summary === '结构化读取 控件 13 / 链接 4 / 表格 5'
      && info.truncated === false && info.scanTruncated === false,
    JSON.stringify({ summary: info.summary, counts: info.counts, truncated: info.truncated }))
    check('默认读取每节两行文本', info.text.split('\n')[0] === '控件 13 个'
      && info.text.split('\n')[2] === '链接 4 个'
      && info.text.split('\n')[4] === '表格 5 个', info.text.slice(0, 120))
  }

  console.log('== 用例 2：控件记录 ==')
  {
    const info = await readStructured(session)
    const nameInput = bySelector(info.controls, '#name-input')
    check('文本输入带 role / name / type', nameInput?.role === 'textbox'
      && nameInput?.name === '姓名' && nameInput?.type === 'text', JSON.stringify(nameInput))

    const city = bySelector(info.controls, '#city')
    check('select 带 options 与 selected', city?.role === 'combobox' && city?.type === 'select-one'
      && city?.options?.length === 2 && city.options[0].value === 'beijing'
      && city.options[0].label === '北京' && city.options[0].selected === true
      && city.options[1].selected === undefined, JSON.stringify(city))

    const tags = bySelector(info.controls, '#tags')
    check('多选 select 的 type 为 select-multiple', tags?.type === 'select-multiple'
      && tags?.role === 'listbox' && tags?.options?.length === 3, JSON.stringify(tags))

    const agree = bySelector(info.controls, '#agree')
    check('checkbox 带 checked', agree?.type === 'checkbox' && agree?.role === 'checkbox'
      && agree?.checked === true, JSON.stringify(agree))

    const submit = bySelector(info.controls, '#submit-btn')
    check('disabled 提交按钮带 disabled', submit?.role === 'button' && submit?.disabled === true,
      JSON.stringify(submit))

    const readonly = bySelector(info.controls, '#readonly-input')
    check('readonly 输入带 readonly', readonly?.readonly === true, JSON.stringify(readonly))

    const required = bySelector(info.controls, '#required-input')
    check('required 输入带 required', required?.required === true, JSON.stringify(required))

    const password = bySelector(info.controls, '#password')
    check('password 控件不给 value 但 hasValue', password?.hasValue === true
      && !('value' in (password ?? {})), JSON.stringify(password))

    const valued = await readStructured(session, { includeValues: true })
    const valuedName = bySelector(valued.controls, '#name-input')
    check('includeValues 返回文本控件的 value', valuedName?.value === '张三', JSON.stringify(valuedName))
    const valuedPassword = bySelector(valued.controls, '#password')
    check('includeValues 不返回 password 的 value', valuedPassword?.hasValue === true
      && !('value' in (valuedPassword ?? {})), JSON.stringify(valuedPassword))

    const editor = bySelector(info.controls, '#editor')
    check('contenteditable 作为控件列出', editor?.type === 'contenteditable'
      && editor?.role === '', JSON.stringify(editor))
    check('不可见控件不列出', !info.controls.some((record) => record.selector === '#hidden-control'),
      JSON.stringify(info.controls.map((record) => record.selector)))
    check('控件带所属表单 selector', nameInput?.form === '#profile-form'
      && submit?.form === '#profile-form', JSON.stringify({ name: nameInput?.form, submit: submit?.form }))
  }

  console.log('== 用例 3：链接记录 ==')
  {
    const info = await readStructured(session, { sections: ['links'] })
    const docs = bySelector(info.links, '#docs-link')
    check('链接带绝对 href', docs?.href === `${base}/docs/page?x=1`, JSON.stringify(docs))
    check('链接 text 与记录对应', docs?.text === '文档链接', JSON.stringify(docs?.text))
    const blank = bySelector(info.links, '#blank-link')
    check('target=_blank 标出 target', blank?.target === '_blank', JSON.stringify(blank))
    const long = bySelector(info.links, '#long-link')
    check('超长 href 截断并标 hrefTruncated', long?.hrefTruncated === true
      && long?.href?.length === 501 && long.href.endsWith('…'), JSON.stringify({
      truncated: long?.hrefTruncated, length: long?.href?.length,
    }))
    check('不可见链接不列出', !info.links.some((record) => record.selector === '#hidden-link'),
      JSON.stringify(info.links.map((record) => record.selector)))
  }

  console.log('== 用例 4：表格记录 ==')
  {
    const info = await readStructured(session, { sections: ['tables'] })
    const thead = bySelector(info.tables, '#thead-table')
    check('表头取 thead 最后一行', JSON.stringify(thead?.headers) === JSON.stringify(['产品', '数量'])
      && thead?.name === '销售表', JSON.stringify(thead))
    check('rows 按单元格拆分', JSON.stringify(thead?.rows) === JSON.stringify([['苹果', '1'], ['香蕉', '2']]),
      JSON.stringify(thead?.rows))

    const thFirst = bySelector(info.tables, '#th-first-table')
    check('无 thead 且首行全 th 时取首行做表头',
      JSON.stringify(thFirst?.headers) === JSON.stringify(['姓名', '年龄'])
      && JSON.stringify(thFirst?.rows) === JSON.stringify([['张三', '20'], ['李四', '30']]),
      JSON.stringify(thFirst))

    const plain = bySelector(info.tables, '#plain-table')
    check('无表头表格 headers 为空且 rows 含全部行',
      JSON.stringify(plain?.headers) === JSON.stringify([])
      && JSON.stringify(plain?.rows) === JSON.stringify([['a1', 'b1'], ['a2', 'b2']]),
      JSON.stringify(plain))

    const rowsTable = bySelector(info.tables, '#rows-table')
    check('totalRows 记录 DOM 行数', rowsTable?.totalRows === 5 && rowsTable?.rows?.length === 5,
      JSON.stringify(rowsTable))

    const scoped = await readStructured(session, { sections: ['tables'], selector: '#rows-table', maxItems: 2 })
    const limited = scoped.tables[0]
    check('maxItems 截断行并给 omittedRows', limited?.rows?.length === 2
      && limited?.totalRows === 5 && limited?.omittedRows === 3 && scoped.truncated === true,
    JSON.stringify({ rows: limited?.rows?.length, total: limited?.totalRows, omittedRows: limited?.omittedRows }))

    const aria = bySelector(info.tables, '#aria-table')
    check('ARIA table 按 role=row / gridcell 读取',
      JSON.stringify(aria?.headers) === JSON.stringify(['名称', '数量'])
      && JSON.stringify(aria?.rows) === JSON.stringify([['苹果', '3']]), JSON.stringify(aria))
  }

  console.log('== 用例 5：唯一 selector 可直接操作 ==')
  {
    const info = await readStructured(session, { sections: ['controls', 'links', 'tables'] })
    const nameInput = bySelector(info.controls, '#name-input')
    const clickLink = bySelector(info.links, '#click-link')
    const table = bySelector(info.tables, '#thead-table')
    check('控件 selector 可用于 fill 前置', nameInput?.unique === true && typeof nameInput.selector === 'string',
      JSON.stringify(nameInput))
    await fill(session, { selector: nameInput.selector }, '李四')
    const filled = await evaluate(session, 'document.querySelector("#name-input").value === "李四"')
    check('控件 selector 可用于 fill', filled.value === true, JSON.stringify(filled))

    await click(session, { selector: clickLink.selector })
    const clicked = await evaluate(session, 'window.__linkClicked === true')
    check('链接 selector 可用于 click', clicked.value === true, JSON.stringify(clicked))

    const tableHit = await evaluate(session,
      '(() => { const el = document.querySelector("#thead-table"); return Boolean(el)'
      + ' && el.tagName === "TABLE" && document.querySelectorAll("#thead-table").length === 1 })()')
    check('表格 selector 命中表格元素', table?.unique === true && tableHit.value === true,
      JSON.stringify({ table: table?.selector, hit: tableHit.value }))

    const dupButtons = info.controls.filter((record) => record.name === '删除')
    const dupHit = await evaluate(session, `(${JSON.stringify(dupButtons.map((record) => record.selector))})`
      + '.map((selector) => document.querySelectorAll(selector).length)')
    const dupSelectors = dupButtons.map((record) => record.selector)
    check('重复结构下 selector 仍唯一', dupButtons.length === 2
      && dupButtons.every((record) => record.unique === true && typeof record.selector === 'string')
      && dupSelectors[0] !== dupSelectors[1]
      && JSON.stringify(dupHit.value) === JSON.stringify([1, 1]),
    JSON.stringify({ selectors: dupSelectors, hits: dupHit.value, records: dupButtons }))

    // 点击第一个重复结构按钮，确认 selector 指向的确实是第一条记录。
    await click(session, { selector: dupSelectors[0] })
    const dup = await evaluate(session, 'window.__dup')
    check('重复结构 selector 指向正确记录', dup.value === 'one', JSON.stringify(dup))

    const all = await readStructured(session, { sections: ['controls', 'links', 'tables', 'forms'] })
    const uniqueRecords = [...all.controls, ...all.links, ...all.tables, ...all.forms]
      .filter((record) => record.unique === true)
    const hits = await evaluate(session, `(${JSON.stringify(uniqueRecords.map((record) => record.selector))})`
      + '.map((selector) => document.querySelectorAll(selector).length)')
    const bad = uniqueRecords.filter((record, index) => hits.value[index] !== 1)
      .map((record, index) => ({ selector: record.selector, hits: hits.value[index] }))
    check('unique 为 true 的记录都能在页面里唯一命中',
      uniqueRecords.length > 0 && bad.length === 0,
      JSON.stringify({ total: uniqueRecords.length, bad }))
  }

  console.log('== 用例 6：表单节 ==')
  {
    const onlyForms = await readStructured(session, { sections: ['forms'] })
    check('sections 只给 forms 时只返回表单', JSON.stringify(onlyForms.sections) === JSON.stringify(['forms'])
      && Array.isArray(onlyForms.forms) && onlyForms.forms.length === 1
      && !('controls' in onlyForms) && !('links' in onlyForms) && !('tables' in onlyForms)
      && !('controls' in onlyForms.counts) && onlyForms.text.split('\n')[0] === '表单 1 个',
    JSON.stringify({ sections: onlyForms.sections, forms: onlyForms.forms, text: onlyForms.text.slice(0, 80) }))

    const form = bySelector(onlyForms.forms, '#profile-form')
    check('表单记录带 action / method / fieldCount',
      form?.id === 'profile-form' && form?.name === 'profile'
      && form?.action === `${base}/submit-profile` && form?.method === 'post'
      && form?.fieldCount === 7, JSON.stringify(form))
  }

  console.log('== 用例 7：作用域与参数 ==')
  {
    const scoped = await readStructured(session, { sections: ['controls'], selector: '#profile-form' })
    check('selector 限定到表单后只读到该表单控件',
      scoped.controls.length === 7 && scoped.counts.controls === 7
      && scoped.controls.every((record) => record.form === '#profile-form')
      && !scoped.controls.some((record) => record.selector === '#agree'),
      JSON.stringify({ count: scoped.controls.length, selectors: scoped.controls.map((record) => record.selector) }))

    const noMatch = await expectThrow(() => readStructured(session, { selector: '#no-such-node' }))
    check('selector 无匹配时报错并提示 snapshot', typeof noMatch === 'string'
      && noMatch.includes('没有匹配元素') && noMatch.includes('browser_e2e_snapshot'), String(noMatch))

    const invalid = await expectThrow(() => readStructured(session, { selector: 'div[' }))
    check('selector 非法时报「不是合法 CSS 选择器」', typeof invalid === 'string'
      && invalid.includes('不是合法 CSS 选择器') && invalid.includes('browser_e2e_snapshot'), String(invalid))

    const emptySections = await expectThrow(() => readStructured(session, { sections: [] }))
    check('sections 空数组报错', typeof emptySections === 'string'
      && emptySections.includes('sections 至少要给一个'), String(emptySections))

    const unknownSection = await expectThrow(() => readStructured(session, { sections: ['dialogs'] }))
    check('未知 section 报错', typeof unknownSection === 'string'
      && unknownSection.includes('未知 section "dialogs"'), String(unknownSection))

    const nonArraySections = await expectThrow(() => readStructured(session, { sections: 'links' }))
    check('sections 非数组报错', typeof nonArraySections === 'string'
      && nonArraySections.includes('sections 需要 controls / links / tables / forms 的数组'), String(nonArraySections))

    const maxItemsZero = await expectThrow(() => readStructured(session, { maxItems: 0 }))
    const maxItemsBig = await expectThrow(() => readStructured(session, { maxItems: 101 }))
    const maxItemsFloat = await expectThrow(() => readStructured(session, { maxItems: 1.5 }))
    check('maxItems 越界报错', [maxItemsZero, maxItemsBig, maxItemsFloat].every((message) => (
      typeof message === 'string' && message.includes('maxItems 必须是 1..100 的整数'))),
    JSON.stringify({ maxItemsZero, maxItemsBig, maxItemsFloat }))

    const nonStringSelector = await expectThrow(() => readStructured(session, { selector: 42 }))
    check('selector 非字符串报错', typeof nonStringSelector === 'string'
      && nonStringSelector.includes('selector 需要字符串'), String(nonStringSelector))

    const one = await readStructured(session, { maxItems: 1 })
    check('maxItems=1 时每节只列 1 条并标已截断',
      one.controls.length === 1 && one.links.length === 1 && one.tables.length === 1
      && one.omitted.controls === 12 && one.omitted.links === 3
      && one.tables[0].omittedRows === 1 && one.truncated === true
      && one.summary.endsWith('（已截断）') && one.text.includes('已截断'),
      JSON.stringify({
        controls: one.controls.length, links: one.links.length, tables: one.tables.length,
        omitted: one.omitted, summary: one.summary,
      }))

    const ordered = await readStructured(session, { sections: ['forms', 'tables', 'links', 'controls'] })
    const titles = ordered.text.split('\n').filter((line, index) => index % 2 === 0).slice(0, 4)
    check('sections 顺序无关且输出固定顺序',
      JSON.stringify(ordered.sections) === JSON.stringify(['controls', 'links', 'tables', 'forms'])
      && titles[0].startsWith('控件 ') && titles[1].startsWith('链接 ')
      && titles[2].startsWith('表格 ') && titles[3].startsWith('表单 '),
    JSON.stringify({ sections: ordered.sections, titles }))

    const deduped = await readStructured(session, { sections: ['links', 'links', 'controls'] })
    check('sections 重复值去重', JSON.stringify(deduped.sections) === JSON.stringify(['controls', 'links'])
      && !('tables' in deduped) && !('forms' in deduped)
      && Object.keys(deduped.counts).join(',') === 'controls,links',
    JSON.stringify({ sections: deduped.sections, counts: deduped.counts }))

    const whole = await readStructured(session, { sections: ['controls'], selector: '' })
    check('selector 空串按未给处理', whole.controls.length === 13, String(whole.controls.length))
  }

  console.log('== 用例 8：截断与文本预算 ==')
  {
    await navigate(session, `${base}/read-big`, 'load')
    const linksOnly = await readStructured(session, { sections: ['links'], maxItems: 100 })
    const linksSectionLength = sectionLengths(linksOnly)[0]
    check('只请求 links 时该节可用全部预算',
      linksOnly.counts.links === BIG_LINK_COUNT && linksOnly.links.length < 100
      && linksSectionLength <= 16000
      && linksOnly.omitted.links === linksOnly.counts.links - linksOnly.links.length
      && linksOnly.truncated === true
      && linksOnly.text.includes('（文本已按 16000 字符上限截断；要读更多请只请求一节，或用 selector 缩小范围）'),
      JSON.stringify({
        counts: linksOnly.counts, listed: linksOnly.links.length,
        omitted: linksOnly.omitted, length: linksSectionLength,
      }))

    const allSections = await readStructured(session, {
      sections: ['controls', 'links', 'tables', 'forms'], maxItems: 100,
    })
    const lengths = sectionLengths(allSections)
    check('文本超预算时按节份额截断并计入 omitted',
      allSections.links.length < linksOnly.links.length
      && lengths.every((length) => length <= 4000)
      && allSections.omitted.links === allSections.counts.links - allSections.links.length
      && allSections.truncated === true
      && allSections.text.includes('文本已按 16000 字符上限截断'),
    JSON.stringify({
      linksOnly: linksOnly.links.length, linksAll: allSections.links.length,
      lengths, omitted: allSections.omitted,
    }))

    await navigate(session, `${base}/read-big-table`, 'load')
    const tableOnly = await readStructured(session, { sections: ['tables'], maxItems: 100 })
    const table = tableOnly.tables[0]
    const tableSectionLength = sectionLengths(tableOnly)[0]
    check('表格超预算时先丢行并计入 omittedRows',
      table?.totalRows === BIG_TABLE_ROWS && table.rows.length < BIG_TABLE_ROWS
      && table.omittedRows === BIG_TABLE_ROWS - table.rows.length
      && tableSectionLength <= 16000 && tableOnly.truncated === true
      && tableOnly.text.includes('文本已按 16000 字符上限截断'),
    JSON.stringify({ totalRows: table?.totalRows, rows: table?.rows?.length, sectionLength: tableSectionLength }))
  }

  console.log('== 用例 9：工具契约 ==')
  {
    const { apply } = await import('../lib/index.js')
    const definitions = []
    const makeCtx = (attachments) => ({
      get: (name) => (name === 'attachments' ? attachments : undefined),
      tools: { register: (definition) => definitions.push(definition) },
      on: () => () => {},
      effect: (factory) => { factory() },
    })
    apply(makeCtx(undefined))
    const registeredNames = definitions.map((definition) => definition.name)
    const readTool = definitions.find((definition) => definition.name === 'browser_e2e_read')
    check('browser_e2e_read 注册且带 tab_id', registeredNames.length === 22
      && registeredNames.includes('browser_e2e_read')
      && readTool?.parameters?.properties?.sections?.type === 'array'
      && readTool.parameters.properties.sections.items?.type === 'string'
      && readTool.parameters.properties.maxItems?.type === 'integer'
      && readTool.parameters.properties.includeValues?.type === 'boolean'
      && readTool.parameters.properties.selector?.type === 'string'
      && 'tab_id' in readTool.parameters.properties
      && readTool.parameters.additionalProperties === false,
    JSON.stringify({ count: registeredNames.length, parameters: readTool?.parameters }))

    await navigate(session, `${base}/read-fixture`, 'load')
    const exec = { agent: { id: KEY } }
    const output = await readTool.execute({}, exec)
    const tabId = currentTab(session).id
    check('工具层输出摘要 / 当前页面 / 文本三段',
      output.startsWith(`结构化读取 控件 13 / 链接 4 / 表格 5\n当前页面：${base}/read-fixture（标签页 ${tabId}）\n\n`)
      && output.includes('\n\n控件 13 个\n'), output.slice(0, 160))

    const unknownTab = await expectThrow(() => readTool.execute({ tab_id: 't99' }, exec))
    check('read 未知 tab 报既有文案', typeof unknownTab === 'string'
      && unknownTab.includes('tab t99 不存在，请先 browser_e2e_tabs 获取最新 tab_id'), String(unknownTab))

    const notStarted = await expectThrow(() => readTool.execute({}, { agent: { id: 'test-read-unstarted' } }))
    check('read 未启动时报既有文案', typeof notStarted === 'string'
      && notStarted.includes('浏览器尚未启动或没有可用标签页，请先 browser_e2e_start'), String(notStarted))
  }

  console.log('== 用例 10：不污染既有状态 ==')
  {
    await navigate(session, `${base}/read-fixture`, 'load')
    const prepared = await snapshot(session)
    const ref = refOf(prepared, 'ref按钮')
    const tab = currentTab(session)
    const beforeRefs = JSON.stringify([...tab.refs.entries()].map(([key, item]) => [key, item.xpath]))
    const info = await readStructured(session, { includeValues: true })
    const afterRefs = JSON.stringify([...tab.refs.entries()].map(([key, item]) => [key, item.xpath]))
    check('read 不改变 tab.refs 内容', beforeRefs === afterRefs && tab.refs.size > 0,
      JSON.stringify({ before: tab.refs.size, after: tab.refs.size }))

    await click(session, { ref })
    const clicked = await evaluate(session, 'window.__refClicked === true')
    check('read 后 snapshot 的 ref 仍可点击', Boolean(ref) && clicked.value === true,
      JSON.stringify({ ref, clicked: clicked.value, summary: info.summary }))
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
check('msedge 主进程回落到运行前基线', edgeSettled && remaining <= baseline,
  `baseline=${baseline} remaining=${remaining}`)
check('本测试未遗留 Playwright Edge 主进程', playwrightSettled && remainingPlaywright <= playwrightBaseline,
  `playwright 基线=${playwrightBaseline} 残留=${remainingPlaywright}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）；`
  + `Playwright 主进程 ${remainingPlaywright} 个（基线 ${playwrightBaseline} 个）`)
process.exit(fail === 0 ? 0 : 1)
