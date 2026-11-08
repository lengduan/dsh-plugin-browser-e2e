/**
 * 登录态导入与导出（功能规格 0021-auth-state-import.md，方案 A）验收。
 *
 * 真起无头 Edge，用本地临时 HTTP 服务做夹具（cookie / localStorage 需要 http 源）。
 * 覆盖：导入后 cookie / localStorage 生效、新标签页共享登录态、导出形状与再导入、
 * 未传 storageState 时摘要不变；以及文件不存在 / 非法 JSON / 形状非法 / 相对路径 /
 * 域过滤 / 域过滤无命中 / 已启动热导入拒绝 / CDP 拒绝导入 / 导出覆盖与目录限制 /
 * 返回值不含 cookie 值 / 空状态导出 / 两会话互不影响 / close 后不带 storageState 清空。
 *
 * 运行：node tests/auth-state.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const {
  close, closeAll, exportStorageState, launch, requireSession, sessionOf,
} = await import('../lib/session.js')
const { evaluate, navigate } = await import('../lib/page.js')
const { authExportDir, STORAGE_STATE_MAX_BYTES } = await import('../lib/auth-state.js')

const KEY = 'test-auth-state'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = join(tmpdir(), `dsh-auth-state-${process.pid}`)
const exportDir = join(authExportDir(), `test-auth-${process.pid}`)
mkdirSync(root, { recursive: true })

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

/** 当前 msedge 主进程数（排除 --type= 的子进程），只用于收尾观察。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>auth-page</title></head>'
      + '<body><h1 id="h">登录态夹具</h1></body></html>')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const host = new URL(base).hostname

const COOKIE_NAME = 'authToken'
const COOKIE_VALUE = 'alice-secret-value'
const LOCAL_NAME = 'authLocal'
const LOCAL_VALUE = 'alice-local-value'
const OTHER_COOKIE_NAME = 'otherToken'
const OTHER_COOKIE_VALUE = 'bob-cookie-value'

/** 一份合法的 Playwright storageState：本机夹具源 + 一个不会访问的外部域名。 */
function stateFixture({ cookieValue = COOKIE_VALUE, localValue = LOCAL_VALUE } = {}) {
  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value: cookieValue,
        domain: host,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'externalToken',
        value: 'external-value',
        domain: 'example.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [
      { origin: base, localStorage: [{ name: LOCAL_NAME, value: localValue }] },
    ],
  }
}

function writeState(name, value) {
  const file = join(root, name)
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

const stateFile = writeState('state.json', stateFixture())
const otherStateFile = writeState('state-other.json', {
  cookies: [{
    name: OTHER_COOKIE_NAME,
    value: OTHER_COOKIE_VALUE,
    domain: host,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  }],
  origins: [],
})
const exportFile = join(exportDir, 'state.json')

const baseline = edgeRootCount()

try {
  console.log('== 用例 1：导入 storageState 后 cookie 与 localStorage 生效 ==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600, storageState: stateFile }, KEY)
    check('启动返回带 storageState 计数',
      info.reused === false && info.storageState?.cookies === 2 && info.storageState?.origins === 1,
      JSON.stringify(info))
    check('启动摘要标注导入的 cookie / origin / 域名数',
      info.summary.includes(`已导入 2 个 cookie、1 个 origin（2 个域名）`), info.summary)
    const session = requireSession(KEY)
    check('隔离模式会话持有显式 context 与登录态来源',
      Boolean(session.context) && session.storageState?.path === stateFile,
      JSON.stringify({ context: Boolean(session.context), storageState: session.storageState }))
    await navigate(session, `${base}/page`, 'load')
    const cookie = await evaluate(session, 'document.cookie')
    const local = await evaluate(session, `localStorage.getItem('${LOCAL_NAME}')`)
    check('导入 storageState 后页面 cookie 生效', cookie.value.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`), cookie.value)
    check('导入 storageState 后同源 localStorage 生效', local.value === LOCAL_VALUE, String(local.value))
    // 域过滤之外的 cookie 也按文件导入（不传 storageDomains = 全部条目）。
    const cookies = await session.context.cookies()
    check('不传 storageDomains 时按文件全部条目导入',
      cookies.length === 2 && cookies.some((item) => item.name === 'externalToken'),
      JSON.stringify(cookies.map((item) => item.name)))
  }

  console.log('== 用例 2：导入后新开标签页共享同一登录态 ==')
  {
    const session = requireSession(KEY)
    const opened = await navigate(session, `${base}/page`, 'load', { new_tab: true })
    const cookie = await evaluate(session, 'document.cookie', opened.tabId)
    const local = await evaluate(session, `localStorage.getItem('${LOCAL_NAME}')`, opened.tabId)
    check('导入后新开标签页共享同一登录态',
      cookie.value.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`) && local.value === LOCAL_VALUE,
      JSON.stringify({ tab: opened.tabId, cookie: cookie.value, local: local.value }))
  }

  console.log('== 用例 3：导出文件是 Playwright storageState 形状，且可再次导入 ==')
  {
    const exported = await exportStorageState(KEY, { path: exportFile })
    check('导出文件是 Playwright storageState 形状',
      existsSync(exportFile) && exported.cookies === 2 && exported.origins === 1
        && exported.domains.length === 2 && exported.bytes > 0,
      JSON.stringify(exported))
    const parsed = JSON.parse(readFileSync(exportFile, 'utf8'))
    check('导出内容含 cookies / origins 两个数组且 cookie 值已落盘',
      Array.isArray(parsed.cookies) && Array.isArray(parsed.origins)
        && parsed.cookies.some((item) => item.name === COOKIE_NAME && item.value === COOKIE_VALUE),
      JSON.stringify({ cookies: parsed.cookies?.length, origins: parsed.origins?.length }))
    check('导出返回值与摘要不含 cookie 值',
      !JSON.stringify(exported).includes(COOKIE_VALUE) && !exported.summary.includes(COOKIE_VALUE),
      JSON.stringify(exported))

    const importedKey = `${KEY}-reimport`
    const info = await launch(importedKey, { headless: true, storageState: exportFile }, importedKey)
    const session = requireSession(importedKey)
    await navigate(session, `${base}/page`, 'load')
    const cookie = await evaluate(session, 'document.cookie')
    const local = await evaluate(session, `localStorage.getItem('${LOCAL_NAME}')`)
    check('导出的文件可在下一次 start 重新导入',
      info.reused === false && cookie.value.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`) && local.value === LOCAL_VALUE,
      JSON.stringify({ cookie: cookie.value, local: local.value }))
    await close(importedKey)
  }

  console.log('== 用例 4：未传 storageState 时启动摘要与现状一致 ==')
  {
    const plainKey = `${KEY}-plain`
    const info = await launch(plainKey, { headless: true, viewportWidth: 800, viewportHeight: 600 }, plainKey)
    check('未传 storageState 时启动摘要与现状一致',
      info.summary === `启动浏览器 系统 Edge ${info.version}（headless=true，视口 800x600）`
        && Object.prototype.hasOwnProperty.call(info, 'storageState') === false
        && sessionOf(plainKey).storageState === null,
      JSON.stringify(info))
    await close(plainKey)
  }

  console.log('== 用例 5：storageState 文件校验 ==')
  {
    const ready = requireSession(KEY)
    const beforeContext = ready.context

    const missing = await expectThrow(() => launch(`${KEY}-missing`, { storageState: join(root, 'missing.json') },
      `${KEY}-missing`))
    check('storageState 文件不存在时报错',
      Boolean(missing) && missing.includes('storageState 文件不存在'), String(missing))

    const badJson = writeState('bad.json', '{ not json')
    const badJsonMessage = await expectThrow(() => launch(`${KEY}-bad-json`, { storageState: badJson }, `${KEY}-bad-json`))
    check('storageState 不是合法 JSON 时报错',
      Boolean(badJsonMessage) && badJsonMessage.includes('不是合法 JSON'), String(badJsonMessage))

    const badShape = writeState('bad-shape.json', JSON.stringify({ cookies: {} }))
    const badShapeMessage = await expectThrow(() => launch(`${KEY}-bad-shape`, { storageState: badShape }, `${KEY}-bad-shape`))
    check('storageState 形状非法时报错',
      Boolean(badShapeMessage) && badShapeMessage.includes('形状非法'), String(badShapeMessage))

    const relative = await expectThrow(() => launch(`${KEY}-relative`, { storageState: 'state.json' }, `${KEY}-relative`))
    check('storageState 相对路径报错', Boolean(relative) && relative.includes('必须是绝对路径'), String(relative))

    const hot = await expectThrow(() => launch(KEY, { storageState: stateFile }, KEY))
    check('已启动时再传 storageState 报错且不重建 context',
      Boolean(hot) && hot.includes('storageState 只在启动时生效') && ready.context === beforeContext,
      JSON.stringify({ message: hot, sameContext: ready.context === beforeContext }))
  }

  console.log('== 用例 6：storageDomains 过滤 ==')
  {
    const filteredKey = `${KEY}-filtered`
    const info = await launch(filteredKey, { headless: true, storageState: stateFile, storageDomains: ['example.com'] }, filteredKey)
    check('storageDomains 过滤只导入命中域名',
      info.storageState?.cookies === 1 && info.storageState?.origins === 0
        && JSON.stringify(info.storageState?.domains) === JSON.stringify(['example.com']),
      JSON.stringify(info.storageState))
    const session = requireSession(filteredKey)
    const cookies = await session.context.cookies()
    check('过滤后只保留命中域名的 cookie',
      cookies.length === 1 && cookies[0].name === 'externalToken', JSON.stringify(cookies.map((c) => c.name)))
    await close(filteredKey)

    const noMatch = await expectThrow(() => launch(`${KEY}-no-match`,
      { storageState: stateFile, storageDomains: ['not-in-state.example'] }, `${KEY}-no-match`))
    check('storageDomains 无命中时报错',
      Boolean(noMatch) && noMatch.includes('没有命中 storageDomains'), String(noMatch))

    const badDomains = await expectThrow(() => launch(`${KEY}-bad-domains`,
      { storageState: stateFile, storageDomains: 'example.com' }, `${KEY}-bad-domains`))
    check('storageDomains 形态非法时报错',
      Boolean(badDomains) && badDomains.includes('必须是域名后缀字符串数组'), String(badDomains))
  }

  console.log('== 用例 7：CDP 模式拒绝导入（不建立连接） ==')
  {
    const cdpKey = `${KEY}-cdp`
    const message = await expectThrow(() => launch(cdpKey, {
      mode: 'cdp',
      cdpEndpoint: 'http://127.0.0.1:9',
      storageState: stateFile,
    }, cdpKey))
    check('CDP 模式传 storageState 先报错且不建立连接',
      Boolean(message) && message.includes('CDP 模式不导入登录态')
        && sessionOf(cdpKey).browser === null && sessionOf(cdpKey).context === null,
      JSON.stringify({ message, browser: sessionOf(cdpKey).browser }))
  }

  console.log('== 用例 8：导出路径与覆盖语义 ==')
  {
    const again = await expectThrow(() => exportStorageState(KEY, { path: exportFile }))
    check('导出路径已存在且未传 overwrite 时报错',
      Boolean(again) && again.includes('文件已存在'), String(again))

    const overwritten = await exportStorageState(KEY, { path: exportFile, overwrite: true })
    check('overwrite=true 时覆盖成功', overwritten.overwrite === true && existsSync(exportFile), JSON.stringify(overwritten))

    const outside = await expectThrow(() => exportStorageState(KEY, { path: join(root, 'outside.json') }))
    check('导出路径不在 ~/.dsh/browser-e2e/auth/ 时报错',
      Boolean(outside) && outside.includes('导出路径必须位于'), String(outside))

    const notJson = await expectThrow(() => exportStorageState(KEY, { path: join(exportDir, 'state.txt') }))
    check('导出路径不是 .json 时报错', Boolean(notJson) && notJson.includes('path 必须是 .json'), String(notJson))
  }

  console.log('== 用例 9：空状态导出仍成功并标注 ==')
  {
    const emptyKey = `${KEY}-empty`
    await launch(emptyKey, { headless: true }, emptyKey)
    const emptyFile = join(exportDir, 'empty.json')
    const info = await exportStorageState(emptyKey, { path: emptyFile })
    check('空上下文导出仍成功并标注空状态',
      info.cookies === 0 && info.origins === 0 && existsSync(emptyFile)
        && info.summary.includes('当前上下文没有 cookie / localStorage，导出的是空状态'),
      JSON.stringify(info))
    await close(emptyKey)
  }

  console.log('== 用例 10：两个会话各自导入不同 storageState 互不影响 ==')
  {
    const keyA = `${KEY}-a`
    const keyB = `${KEY}-b`
    await launch(keyA, { headless: true, storageState: stateFile }, keyA)
    await launch(keyB, { headless: true, storageState: otherStateFile }, keyB)
    const sessionA = requireSession(keyA)
    const sessionB = requireSession(keyB)
    await navigate(sessionA, `${base}/page`, 'load')
    await navigate(sessionB, `${base}/page`, 'load')
    const cookieA = await evaluate(sessionA, 'document.cookie')
    const cookieB = await evaluate(sessionB, 'document.cookie')
    check('两个会话各自导入不同 storageState 互不影响',
      cookieA.value.includes(COOKIE_NAME) && !cookieA.value.includes(OTHER_COOKIE_NAME)
        && cookieB.value.includes(OTHER_COOKIE_NAME) && !cookieB.value.includes(COOKIE_NAME),
      JSON.stringify({ a: cookieA.value, b: cookieB.value }))
    await close(keyA)
    await close(keyB)
  }

  console.log('== 用例 11：close 后不带 storageState 再 start 登录态清空 ==')
  {
    await close(KEY)
    const info = await launch(KEY, { headless: true }, KEY)
    const session = requireSession(KEY)
    await navigate(session, `${base}/page`, 'load')
    const cookie = await evaluate(session, 'document.cookie')
    const local = await evaluate(session, `localStorage.getItem('${LOCAL_NAME}')`)
    check('close 后不带 storageState 再 start 登录态清空',
      info.reused === false && !cookie.value.includes(COOKIE_NAME) && local.value === null
        && session.storageState === null,
      JSON.stringify({ cookie: cookie.value, local: local.value }))
  }

  console.log('== 用例 12：文件过大与非法路径文案 ==')
  {
    const big = join(root, 'big.json')
    writeFileSync(big, 'x'.repeat(STORAGE_STATE_MAX_BYTES + 1))
    const bigMessage = await expectThrow(() => launch(`${KEY}-big`, { storageState: big }, `${KEY}-big`))
    check('storageState 文件过大时报错并带上限',
      Boolean(bigMessage) && bigMessage.includes('文件过大') && bigMessage.includes(String(STORAGE_STATE_MAX_BYTES)),
      String(bigMessage))
  }
} finally {
  await closeAll()
  server.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(exportDir, { recursive: true, force: true })
  await sleep(1500)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${edgeRootCount()} 个（基线 ${baseline}）`)
process.exit(fail === 0 ? 0 : 1)
