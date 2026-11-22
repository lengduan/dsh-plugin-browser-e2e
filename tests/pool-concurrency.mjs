/**
 * 多会话并发实测（功能规格 0041「已知局限」里「>2 会话同时 start / close 未实测」的补齐）：走真实工具表（buildToolTable）+ 真起无头 Edge + 真实网页负载，
 * 用不同 exec.agent.id 模拟多个独立会话并发调用，检查「单浏览器复用 + 每会话隔离 context」的调度。
 *
 * 与 tests/pool-sessions.mjs 的差别：那个直接调 session.js / page.js；本脚本走工具定义 run，
 * 即 DSH 里多会话使用插件的真实入口。
 *
 * 运行：node tests/pool-concurrency.mjs
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { countBrowserRoots } from './_process-count.mjs'

process.env.DSH_BROWSER_IDLE_MS = '600000'
process.env.DSH_BROWSER_POOL_IDLE_MS = '0'
process.env.DSH_BROWSER_HISTORY = '0'

const { buildToolTable, withOutput } = await import('../lib/tools.js')
const { activeSessionKeys, closeAll, peekSession } = await import('../lib/session.js')
const { poolStats } = await import('../lib/pool.js')

const table = withOutput(buildToolTable({ ctx: { get: () => undefined }, launchDefaults: () => ({}) }))
const tool = (name) => {
  const def = table.find((d) => d.name === name)
  if (!def) throw new Error('没有工具 ' + name)
  return (args, exec) => def.run(args, exec)
}
const start = tool('browser_e2e_start')
const navigate = tool('browser_e2e_navigate')
const evaluateRaw = tool('browser_e2e_evaluate')
const snapshot = tool('browser_e2e_snapshot')
const tabsTool = tool('browser_e2e_tabs')
const closeTool = tool('browser_e2e_close')
const readTool = tool('browser_e2e_read')

/** evaluate 工具输出「摘要\nJSON」：取第一个换行后的部分并解析。 */
async function evaluate(args, exec) {
  const text = await evaluateRaw(args, exec)
  const body = text.slice(text.indexOf('\n') + 1)
  try { return JSON.parse(body) } catch { return body }
}
/** navigate 输出「摘要\n标题：X\n...」：抽标题行。 */
async function navTitle(url, exec) {
  const text = await navigate({ url }, exec)
  const m = /^标题：(.*)$/m.exec(text)
  return m ? m[1].trim() : ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  PASS  ' + label) }
  else {
    fail += 1
    failures.push(label + (detail ? ' —— ' + detail : ''))
    console.log('  FAIL  ' + label + (detail ? ' —— ' + detail : ''))
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const slow = Number(url.searchParams.get('slow') ?? 0)
  const t = url.searchParams.get('t') ?? 'page'
  const body = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + t
    + '</title></head><body><h1 id="h">' + t + '</h1><button id="btn">click</button></body></html>'
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }, slow)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

const execOf = (id) => ({ agent: { id } })
const KEYS = ['ms-a', 'ms-b', 'ms-c', 'ms-d']
const baseline = countBrowserRoots(null)
console.log('运行前 msedge 主进程基线：' + baseline)
const t0 = Date.now()

try {
  console.log('== 场景 1：4 个会话并发 start（并发合流，应只拉起 1 个浏览器进程）==')
  {
    const launchesBefore = poolStats().launchCount
    const results = await Promise.allSettled(KEYS.map((k) => start({ headless: true }, execOf(k))))
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    check('4 个会话并发 start 全部成功', okCount === 4,
      JSON.stringify(results.map((r) => r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'ok')))
    const delta = poolStats().launchCount - launchesBefore
    check('并发 start 只拉起 1 个浏览器进程', delta === 1, 'launchCount 增量=' + delta)
    const stats = poolStats()
    check('池里 1 个槽、4 份租约', stats.slots.length === 1 && stats.leases === 4,
      JSON.stringify({ slots: stats.slots.length, leases: stats.leases }))
    console.log('  并发启动耗时 ' + (Date.now() - t0) + 'ms')
  }

  console.log('== 场景 2：4 个会话并发跑真实工作流（导航 / 求值 / 快照 / 结构读 / 登录态隔离）==')
  {
    const work = KEYS.map(async (k, i) => {
      const exec = execOf(k)
      const tag = 'tag-' + k
      const title = await navTitle(base + '/page?t=' + tag + '&slow=' + (40 + i * 15), exec)
      await evaluate({ expression: "(() => { document.cookie = 'who=" + k + "; path=/'; localStorage.setItem('who', '" + k + "'); return 1 })()" }, exec)
      const snap = await snapshot({}, exec)
      const readResult = await readTool({ sections: ['links'] }, exec)
      const who = await evaluate({ expression: 'document.cookie' }, exec)
      const local = await evaluate({ expression: "localStorage.getItem('who')" }, exec)
      return { k, title, who: String(who), local, snapOk: typeof snap === 'string' && snap.length > 0, readOk: typeof readResult === 'string' && readResult.length > 0 }
    })
    const results = await Promise.allSettled(work)
    const rejected = results.filter((r) => r.status === 'rejected')
    check('4 个会话并发工作流全部成功', rejected.length === 0,
      JSON.stringify(rejected.map((r) => String(r.reason?.message ?? r.reason))))
    const values = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    check('每个会话读到自己的标题（没串页）', values.every((v) => v.title === 'tag-' + v.k),
      JSON.stringify(values.map((v) => v.title)))
    check('每个会话只看到自己写的 cookie（context 隔离）', values.every((v) => v.who === 'who=' + v.k),
      JSON.stringify(values.map((v) => v.who)))
    check('每个会话只看到自己写的 localStorage', values.every((v) => v.local === v.k),
      JSON.stringify(values.map((v) => v.local)))
    check('快照与结构读全部有输出', values.every((v) => v.snapOk && v.readOk))
  }

  console.log('== 场景 3：并发中关掉 2 个会话，剩下 2 个继续工作 ==')
  {
    const closed = await Promise.all([closeTool({}, execOf('ms-a')), closeTool({}, execOf('ms-c'))])
    check('两个会话都报告关闭了自己的上下文', closed.every((c) => String(c).includes('已关闭本会话的浏览器上下文')),
      JSON.stringify(closed))
    check('池里还剩 2 份租约、浏览器仍在', poolStats().leases === 2 && poolStats().hasBrowser === true,
      JSON.stringify({ leases: poolStats().leases, hasBrowser: poolStats().hasBrowser }))
    const survivors = await Promise.allSettled(['ms-b', 'ms-d'].map(async (k) => {
      const exec = execOf(k)
      const title = await navTitle(base + '/page?t=after-' + k, exec)
      const cookie = await evaluate({ expression: 'document.cookie' }, exec)
      return { k, title, cookie: String(cookie) }
    }))
    check('剩余会话仍可导航与求值', survivors.every((r) => r.status === 'fulfilled'),
      JSON.stringify(survivors.map((r) => r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'ok')))
    const ok = survivors.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    check('剩余会话读到自己的页面（不受被关会话影响）', ok.every((v) => v.title === 'after-' + v.k),
      JSON.stringify(ok.map((v) => v.title)))
    check('剩余会话的 cookie 仍是自己的', ok.every((v) => v.cookie === 'who=' + v.k),
      JSON.stringify(ok.map((v) => v.cookie)))
    check('已关闭会话从注册表摘除', !activeSessionKeys().includes('ms-a') && !activeSessionKeys().includes('ms-c'),
      JSON.stringify(activeSessionKeys()))
    check('已关闭会话 peekSession 为空', peekSession('ms-a') === null)
  }

  console.log('== 场景 4：关闭后重启一个会话，得到干净 context 且复用同一浏览器 ==')
  {
    const launchesBefore = poolStats().launchCount
    await start({ headless: true }, execOf('ms-a'))
    check('重启不新拉起浏览器进程', poolStats().launchCount === launchesBefore,
      'launchCount=' + poolStats().launchCount + ' before=' + launchesBefore)
    const exec = execOf('ms-a')
    await navigate({ url: base + '/page?t=fresh' }, exec)
    const cookie = String(await evaluate({ expression: 'document.cookie' }, exec))
    const local = await evaluate({ expression: "localStorage.getItem('who')" }, exec)
    check('重启后的会话没有旧 cookie / localStorage', !cookie.includes('who=ms-a') && local === null,
      JSON.stringify({ cookie, local }))
  }

  console.log('== 场景 5：3 个会话各跑 6 轮混合工作（会话内串行、跨会话并发）==')
  {
    // 会话内必须是串行的：同一 session 的 page 上并发 navigate 会互相打断（Playwright 语义），
    // 真实使用里一个 agent 的工具调用也是串行的。要测的是「跨会话并发」。
    const mixed = ['ms-a', 'ms-b', 'ms-d'].map((k) => (async () => {
      const exec = execOf(k)
      for (let i = 0; i < 6; i += 1) {
        await tabsTool({}, exec)
        await evaluate({ expression: '1+1' }, exec)
        await navigate({ url: base + '/page?t=mix-' + k + '&slow=' + (i * 10) }, exec)
      }
      return k
    })())
    const results = await Promise.allSettled(mixed)
    const rejected = results.filter((r) => r.status === 'rejected')
    check('18 次交错并发调用全部成功', rejected.length === 0,
      JSON.stringify(rejected.slice(0, 3).map((r) => String(r.reason?.message ?? r.reason))))
    check('并发后每个会话仍在注册表', ['ms-a', 'ms-b', 'ms-d'].every((k) => activeSessionKeys().includes(k)),
      JSON.stringify(activeSessionKeys()))
  }

  console.log('== 场景 7：全部关闭后租约归零，池立即回收浏览器；新会话重新冷启 ==')
  {
    const before = poolStats()
    await Promise.all([closeTool({}, execOf('ms-b')), closeTool({}, execOf('ms-d')), closeTool({}, execOf('ms-a'))])
    await sleep(800)
    const after = poolStats()
    check('全部 close 后租约归零', after.leases === 0, JSON.stringify({ before: before.leases, after: after.leases }))
    check('池级 0 时租约归零即回收浏览器', after.hasBrowser === false, JSON.stringify({ hasBrowser: after.hasBrowser }))
    check('没有残留会话', activeSessionKeys().length === 0, JSON.stringify(activeSessionKeys()))

    const launchesBefore = poolStats().launchCount
    const revived = await Promise.allSettled(['ms-x', 'ms-y'].map((k) => start({ headless: true }, execOf(k))))
    check('回收后新会话能冷启成功', revived.every((r) => r.status === 'fulfilled'),
      JSON.stringify(revived.map((r) => r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'ok')))
    check('两个新会话只冷启 1 次（仍合流）', poolStats().launchCount - launchesBefore === 1,
      'delta=' + (poolStats().launchCount - launchesBefore))
    const exec = execOf('ms-x')
    const title = await navTitle(base + '/page?t=revived', exec)
    check('冷启后的会话可正常工作', title === 'revived', 'title=' + title)
    await closeTool({}, execOf('ms-x'))
    await closeTool({}, execOf('ms-y'))
  }

  console.log('== 场景 6：池资源口径（1 次初始拉起 + 1 次回收后冷启）==')
  {
    const stats = poolStats()
    const roots = countBrowserRoots('headless-edge')
    check('累计只拉起 2 次浏览器（初始 1 + 回收后 1），6 个会话没有各自起浏览器',
      stats.launchCount === 2, 'launchCount=' + stats.launchCount)
    check('池启动的 msedge 主进程数为 1', roots === 1, 'roots=' + roots)
    check('场景 7 关闭后槽已清空', stats.slots.length === 0, JSON.stringify(stats.slots.map((s) => s.signature)))
  }

  console.log('== 场景 8：并发压力 —— 8 个会话同时 start 并各自干活，再整体收尾 ==')
  {
    const MANY = Array.from({ length: 8 }, (_, i) => 'stress-' + i)
    const launchesBefore = poolStats().launchCount
    const started = await Promise.allSettled(MANY.map((k) => start({ headless: true }, execOf(k))))
    check('8 个会话并发 start 全部成功', started.every((r) => r.status === 'fulfilled'),
      JSON.stringify(started.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason))))
    check('8 个会话只冷启 1 次', poolStats().launchCount - launchesBefore === 1,
      'delta=' + (poolStats().launchCount - launchesBefore))
    check('池里 8 份租约', poolStats().leases === 8, 'leases=' + poolStats().leases)

    const work = await Promise.allSettled(MANY.map(async (k, i) => {
      const exec = execOf(k)
      // 必须先导航到 http 源再写 cookie：about:blank 上写 document.cookie 会被浏览器拒绝。
      const title = await navTitle(base + '/page?t=' + k + '&slow=' + (i * 8), exec)
      await evaluate({ expression: "(() => { document.cookie = 'who=" + k + "; path=/'; return 1 })()" }, exec)
      const cookie = String(await evaluate({ expression: 'document.cookie' }, exec))
      return { k, title, cookie }
    }))
    const bad = work.filter((r) => r.status === 'rejected')
    check('8 个会话并发干活全部成功', bad.length === 0,
      JSON.stringify(bad.slice(0, 3).map((r) => String(r.reason?.message ?? r.reason))))
    const vals = work.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    check('8 个会话各自隔离（标题与 cookie 都不串）',
      vals.every((v) => v.title === v.k && v.cookie === 'who=' + v.k),
      JSON.stringify(vals.map((v) => v.title + '/' + v.cookie)))

    await Promise.all(MANY.map((k) => closeTool({}, execOf(k))))
    await sleep(800)
    check('8 个会话全部关闭后租约归零、浏览器回收',
      poolStats().leases === 0 && poolStats().hasBrowser === false, JSON.stringify(poolStats()))
  }

  console.log('== 场景 9：竞态 —— 启动中并发 close，不能打死别人 / 不能留孤儿会话 ==')
  {
    const racers = []
    for (const k of ['race-a', 'race-b', 'race-c']) {
      racers.push(start({ headless: true }, execOf(k)))
    }
    // 不等启动落定就 close 其中一个：真实场景里用户可能在启动过程中就点了关闭 / 会话被 dispose。
    racers.push(closeTool({}, execOf('race-c')))
    const results = await Promise.allSettled(racers)
    const startRejected = results.slice(0, 3).filter((r) => r.status === 'rejected')
    check('启动中的 close 不打断其它会话的启动', startRejected.length <= 1,
      JSON.stringify(startRejected.map((r) => String(r.reason?.message ?? r.reason))))
    const alive = ['race-a', 'race-b'].filter((k) => activeSessionKeys().includes(k))
    check('启动成功且未被关的会话仍在注册表', alive.length === 2, JSON.stringify(activeSessionKeys()))
    // 被关的那个要么已关闭、要么启动成功后被关：注册表里都不应残留
    check('被并发关闭的会话不残留在注册表', !activeSessionKeys().includes('race-c'), JSON.stringify(activeSessionKeys()))
    // 幸存会话必须真的可用（不能是「状态还在、其实已经坏了」）
    const usable = await Promise.allSettled(['race-a', 'race-b'].map(async (k) => {
      const title = await navTitle(base + '/page?t=' + k + '-ok', execOf(k))
      return { k, title }
    }))
    check('竞态后幸存会话仍可用', usable.every((r) => r.status === 'fulfilled' && r.value.title === r.value.k + '-ok'),
      JSON.stringify(usable.map((r) => r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : r.value.title)))
    await Promise.all(['race-a', 'race-b'].map((k) => closeTool({}, execOf(k)).catch(() => {})))
    await sleep(500)
  }

  console.log('== 场景 11：池级空闲计时窗口（独立子进程：时限在模块导入时读定）==')
  {
    const child = spawnSync('node', ['tests/pool-concurrency-child.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_BROWSER_POOL_IDLE_MS: '5000' },
      cwd: process.cwd(),
      // 子进程正常约 8s（内含 6.5s 空闲等待）；不设 timeout 时子进程卡住会永久阻塞父测试。
      timeout: 120000,
      windowsHide: true,
    })
    const out = (child.stdout ?? '') + (child.stderr ?? '')
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('PASS  ')) console.log('  PASS  ' + line.slice(6))
      else if (line.startsWith('FAIL  ')) console.log('  FAIL  ' + line.slice(6))
    }
    check('池级空闲窗口用例全部通过', child.status === 0, 'exit=' + child.status + ' ' + out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).join(' | '))
  }

  console.log('== 场景 12：共享浏览器被外部杀掉，多会话必须一起收尾且能各自重启 ==')
  {
    const live = ['crash-a', 'crash-b', 'crash-c']
    for (const k of live) await start({ headless: true }, execOf(k))
    for (const k of live) await navTitle(base + '/page?t=crash-' + k, execOf(k))
    check('崩溃前 3 个会话都在注册表', live.every((k) => activeSessionKeys().includes(k)), JSON.stringify(activeSessionKeys()))
    // 模拟浏览器崩溃：直接杀池启动的那个 msedge 主进程
    const killed = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match 'headless-edge' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }"],
    { encoding: 'utf8', timeout: 30000, windowsHide: true })
    console.log('  已终止浏览器进程：' + killed.stdout.trim().split(/\s+/).filter(Boolean).join(','))
    await sleep(1500)
    const stranded = live.filter((k) => peekSession(k) !== null)
    check('崩溃后没有会话卡在 ready（全部被收掉或如实报错）',
      stranded.length === 0 || stranded.every((k) => peekSession(k).connected === false),
      JSON.stringify(stranded.map((k) => [k, peekSession(k)])))
    check('崩溃后池已清空', poolStats().hasBrowser === false, JSON.stringify(poolStats()))
    // 每个会话都应能重新启动并工作（不能永久坏掉）
    const revived = await Promise.allSettled(live.map((k) => start({ headless: true }, execOf(k))))
    check('崩溃后各会话都能重新启动', revived.every((r) => r.status === 'fulfilled'),
      JSON.stringify(revived.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason))))
    const after = await Promise.allSettled(live.map(async (k) => navTitle(base + '/page?t=after-crash-' + k, execOf(k))))
    check('崩溃重启后各会话可正常工作',
      after.every((r) => r.status === 'fulfilled' && r.value === 'after-crash-' + live[after.indexOf(r)]),
      JSON.stringify(after.map((r) => (r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : r.value))))
    for (const k of live) await closeTool({}, execOf(k)).catch(() => {})
    await sleep(500)
  }

  console.log('== 场景 10：不同启动签名各占一槽，互不复用也不互相报错 ==')
  {
    const launchesBefore = poolStats().launchCount
    await start({ headless: true }, execOf('sig-real'))
    await start({ headless: false }, execOf('sig-headful'))
    const slots = poolStats().slots
    check('两种签名各占一个槽', slots.length === 2, JSON.stringify(slots.map((s) => s.signature)))
    check('每种签名各拉起 1 次（共 2 次）', poolStats().launchCount - launchesBefore === 2,
      'delta=' + (poolStats().launchCount - launchesBefore))
    const t1 = await navTitle(base + '/page?t=sig-real-page', execOf('sig-real'))
    const t2 = await navTitle(base + '/page?t=sig-headful-page', execOf('sig-headful'))
    check('两个签名下的会话都能正常工作', t1 === 'sig-real-page' && t2 === 'sig-headful-page',
      JSON.stringify({ t1, t2 }))
    await closeTool({}, execOf('sig-real'))
    await closeTool({}, execOf('sig-headful'))
    await sleep(600)
  }
} finally {
  await closeAll().catch(() => {})
  await sleep(1500)
  server.close()
  const roots = countBrowserRoots('headless-edge')
  check('收尾后池启动的浏览器进程归零', roots === 0, 'roots=' + roots)
  console.log('\n合计：' + pass + ' PASS / ' + fail + ' FAIL，用时 ' + (Date.now() - t0) + 'ms')
  if (fail > 0) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
  process.exitCode = fail === 0 ? 0 : 1
}
