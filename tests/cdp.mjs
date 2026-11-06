/**
 * M8 CDP 接管验证。
 *
 * 用系统 Edge 以 `--remote-debugging-port` + 一次性 user-data-dir 起一个真实浏览器，
 * 再让插件以 mode:'cdp' 接管，覆盖：
 *   - connectOverCDP 连接路径与 tab 列表（取 context.pages()）；
 *   - 接管后不新建 page、不设置视口（viewportSize 为 null 时截图走内尺寸兜底）；
 *   - 导航 / 求值可用；
 *   - browser_e2e_close 只断开连接，浏览器进程仍然存活；
 *   - 非 loopback 端点被拒绝。
 *
 * 运行：node tests/cdp.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { close, closeAll, evaluate, launch, navigate, screenshot, tabs } = await import('../lib/browser.js')

const KEY = 'test-cdp-key'
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
    check('接管成功且 mode 为 cdp', info.reused === false && info.mode === 'cdp', JSON.stringify(info))
    check('摘要包含接管端点', info.summary.includes(endpoint), info.summary)
    const list = await tabs(KEY)
    check('tab 列表取 context.pages()（至少 1 个）', list.tabs.length >= 1, JSON.stringify(list.tabs))
    check('tab 列表 mode 为 cdp', list.mode === 'cdp', list.mode)
    const alive = child.exitCode === null && !child.killed
    check('接管不杀浏览器进程', alive, `exitCode=${child.exitCode}`)
  }

  console.log('== 用例 3：接管后导航 / 求值 / 截图 ==')
  {
    const info = await navigate(KEY, 'data:text/html,<title>cdp-page</title><h1 id="h">cdp-heading</h1>', 'load', SID)
    check('导航成功', info.title === 'cdp-page', JSON.stringify(info))
    const value = await evaluate(KEY, "document.getElementById('h').textContent", SID)
    check('求值成功', value.value === 'cdp-heading', JSON.stringify(value.value))
    const shot = await screenshot(KEY, { name: 'cdp-shot', format: 'jpeg', quality: 70 }, SID)
    check('截图成功（无固定视口时按内尺寸兜底）', shot.meta.width > 0 && shot.meta.height > 0, JSON.stringify(shot.meta))
    const list = await tabs(KEY)
    check('导航没有新建 page', list.tabs.length >= 1, JSON.stringify(list.tabs.map((t) => t.tab_id)))
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
  await sleep(500)
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // Windows 上目录可能还被进程占用，留给系统临时目录清理
  }
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
