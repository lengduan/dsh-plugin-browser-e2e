/**
 * M7 鉴权补票验证。
 *
 * 本机起一个「未带 token 就回登录挑战页」的服务，用 setConnectionResolver 注入
 * 一个假的 connection 服务，验证：
 *   - 命中挑战且目标为 loopback 时补一次带 token 的地址，页面真的进了登录后页面；
 *   - Resolver 不存在 / 抛错 / 返回同一地址时不重试、不抛错；
 *   - 非 loopback 目标（data: URL）即使正文像挑战页也不补票；
 *   - 每个 tab 每次导航只补一次。
 *
 * 运行：node tests/auth.mjs
 */
import { createServer } from 'node:http'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, launch, requireSession } = await import('../lib/session.js')
const { evaluate, navigate } = await import('../lib/page.js')
const { setConnectionResolver } = await import('../lib/auth.js')

const KEY = 'test-auth-key'
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

const CHALLENGE_HTML = '<!doctype html><html><head><title>DSH Web Authentication Required</title></head>'
  + '<body><h1>DSH Web Authentication Required</h1><p>provide a valid launch token</p></body></html>'
const OK_HTML = '<!doctype html><html><head><title>signed-in</title></head><body><h1 id="ok">welcome</h1></body></html>'

/** 补票请求计数：验证「每次导航只补一次」。 */
let topUps = 0

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/challenge') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(CHALLENGE_HTML)
    return
  }
  if (url.pathname === '/ok') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(OK_HTML)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/** 假 connection：把挑战页换成带 token 的 /ok。 */
function goodResolver() {
  return {
    authenticatedUrl(target) {
      topUps += 1
      const url = new URL(target)
      if (url.pathname === '/challenge') return `${base}/ok?token=secret`
      url.searchParams.set('token', 'secret')
      return url.toString()
    },
  }
}

try {
  await launch(KEY, { headless: true }, SID)
  session = requireSession(KEY)

  console.log('== 用例 1：命中挑战且 loopback 时补票成功 ==')
  {
    topUps = 0
    setConnectionResolver(goodResolver)
    const info = await navigate(session, `${base}/challenge`, 'load')
    const title = await evaluate(session, 'document.title')
    const heading = await evaluate(session, "document.getElementById('ok')?.textContent || ''")
    check('标记 authRetried', info.authRetried === true, JSON.stringify(info))
    check('页面已进入登录后页面', info.url.includes('/ok') && title.value === 'signed-in', `${info.url} title=${JSON.stringify(title.value)}`)
    check('正文是 welcome', heading.value === 'welcome', JSON.stringify(heading.value))
    check('只补票一次', topUps === 1, String(topUps))
    check('summary 标注已补票', info.summary.includes('已补票'), info.summary)
  }

  console.log('== 用例 2：Resolver 返回同一地址 → 不补票 ==')
  {
    setConnectionResolver(() => ({ authenticatedUrl: (url) => url }))
    const info = await navigate(session, `${base}/challenge`, 'load')
    check('authRetried 为 false', info.authRetried === false, JSON.stringify(info))
    check('页面停留在挑战页', info.title === 'DSH Web Authentication Required', info.title)
  }

  console.log('== 用例 3：没有 connection 服务 → 静默跳过 ==')
  {
    setConnectionResolver(null)
    const info = await navigate(session, `${base}/challenge`, 'load')
    check('不抛错且不补票', info.authRetried === false && info.title === 'DSH Web Authentication Required', JSON.stringify(info))
  }

  console.log('== 用例 4：Resolver 抛错 → 静默跳过 ==')
  {
    setConnectionResolver(() => { throw new Error('connection down') })
    const info = await navigate(session, `${base}/challenge`, 'load')
    check('不抛错且不补票', info.authRetried === false, JSON.stringify(info))
  }

  console.log('== 用例 5：非 loopback 目标不补票 ==')
  {
    topUps = 0
    setConnectionResolver(goodResolver)
    const dataUrl = 'data:text/html,<title>DSH Web Authentication Required</title><body><h1>DSH Web Authentication Required</h1></body>'
    const info = await navigate(session, dataUrl, 'load')
    check('data: 目标保持原状', info.authRetried === false && info.url.startsWith('data:'), JSON.stringify(info))
    check('没有调用补票', topUps === 0, String(topUps))
  }

  console.log('== 用例 6：补票失败（404 地址）不抛错 ==')
  {
    setConnectionResolver(() => ({ authenticatedUrl: () => `${base}/nope` }))
    const info = await navigate(session, `${base}/challenge`, 'load')
    check('重试到 404 也返回结果', typeof info.status === 'number' && info.authRetried === true, JSON.stringify(info))
  }

  console.log('== 用例 7：补票地址与原文相同/空串时跳过 ==')
  {
    setConnectionResolver(() => ({ authenticatedUrl: () => '' }))
    const info = await navigate(session, `${base}/challenge`, 'load')
    check('空串不补票', info.authRetried === false, JSON.stringify(info))
  }
} finally {
  setConnectionResolver(null)
  await closeAll()
  server.close()
  await sleep(300)
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
