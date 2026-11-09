/**
 * CDP 复制接管验证（功能规格 0039-cdp-profile-copy.md）。
 *
 * 用一份构造的「源 profile」目录，验证 `cdpCopyProfile: true` 的完整链路：
 *   - 复制登录态与扩展白名单到副本目录；
 *   - 用副本启动 Edge 并接管（原 profile 不被连接）；
 *   - 源目录文件内容不变；
 *   - close 结束副本进程并删除副本目录；
 *   - 非法参数与热切换被拒绝。
 *
 * 运行：node tests/cdp-copy.mjs
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_BROWSER_IDLE_MS = '600000'

const { close, closeAll, launch, requireSession, tabs } = await import('../lib/session.js')

const KEY = 'test-cdp-copy-key'
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'

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

/** 文件内容哈希，用来证明源目录没被改写。 */
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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

// 构造源 profile：登录态文件 + 一个扩展 + 一份扩展本地存储。
const sourceDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-copy-src-'))
const extDir = join(sourceDir, 'Default', 'Extensions', EXT_ID, '1.0.0_0')
mkdirSync(join(sourceDir, 'Default', 'Network'), { recursive: true })
mkdirSync(join(sourceDir, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
mkdirSync(extDir, { recursive: true })
writeFileSync(join(sourceDir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'fake' } }), 'utf8')
writeFileSync(join(sourceDir, 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'copy-test' } }), 'utf8')
writeFileSync(join(sourceDir, 'Default', 'Secure Preferences'), '{}', 'utf8')
writeFileSync(join(sourceDir, 'Default', 'Network', 'Cookies'), 'fake-cookies', 'utf8')
writeFileSync(join(sourceDir, 'Default', 'Local Storage', 'leveldb', '001.log'), 'ls', 'utf8')
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'copy-ext', version: '1.0.0' }), 'utf8')

const sourceHashBefore = hashFile(join(sourceDir, 'Default', 'Network', 'Cookies'))

const port = await pickPort()
const endpoint = `http://127.0.0.1:${port}`
let session = null

try {
  console.log('== 用例 1：非法参数 ==')
  {
    const missing = await expectThrow(() => launch('test-cdp-copy-bad', {
      mode: 'cdp', cdpCopyProfile: true, cdpProfileSource: join(tmpdir(), 'dsh-cdp-copy-not-exist-xyz'),
    }, 'test-cdp-copy-bad'))
    check('源目录不存在时报错', Boolean(missing) && missing.includes('profile 源目录不存在'), String(missing))

    const isolatedCopy = await expectThrow(() => launch('test-cdp-copy-bad', {
      mode: 'isolated', cdpProfileSource: sourceDir,
    }, 'test-cdp-copy-bad'))
    check('isolated 模式传复制参数被拒绝',
      Boolean(isolatedCopy) && isolatedCopy.includes('只在 cdpCopyProfile=true 时生效'), String(isolatedCopy))
  }

  console.log('== 用例 2：复制 profile 并接管副本 ==')
  {
    const info = await launch(KEY, {
      mode: 'cdp', cdpCopyProfile: true, cdpProfileSource: sourceDir, cdpEndpoint: endpoint,
    }, KEY)
    session = requireSession(KEY)
    check('接管成功且 mode 为 cdp', info.reused === false && info.mode === 'cdp', JSON.stringify(info))
    check('返回 cdpProfile 来源与副本目录', Boolean(info.cdpProfile)
      && info.cdpProfile.source === sourceDir && existsSync(info.cdpProfile.dir), JSON.stringify(info.cdpProfile))
    check('摘要标注已复制 profile', info.summary.includes('已复制 profile'), info.summary)

    const copyDir = info.cdpProfile.dir
    check('副本包含 Local State / Preferences / Secure Preferences',
      existsSync(join(copyDir, 'Local State'))
        && existsSync(join(copyDir, 'Default', 'Preferences'))
        && existsSync(join(copyDir, 'Default', 'Secure Preferences')))
    check('副本包含 cookies 与扩展目录',
      existsSync(join(copyDir, 'Default', 'Network', 'Cookies'))
        && existsSync(join(copyDir, 'Default', 'Extensions', EXT_ID, '1.0.0_0', 'manifest.json')))
    check('副本包含扩展本地存储', existsSync(join(copyDir, 'Default', 'Local Extension Settings'))
      || existsSync(join(copyDir, 'Default', 'Local Storage', 'leveldb', '001.log')))

    const list = await tabs(KEY)
    check('接管副本后有标签页', list.tabs.length >= 1, JSON.stringify(list.tabs))
    check('会话记录了副本启动信息', Boolean(session.cdpLaunched)
      && session.cdpLaunched.dir === copyDir && session.cdpLaunched.port === port, JSON.stringify(session.cdpLaunched ?? null))

    // 热切换：复制接管不能直接改成直连。
    const hotSwitch = await expectThrow(() => launch(KEY, { mode: 'cdp', cdpCopyProfile: false, cdpEndpoint: endpoint }, KEY))
    check('已启动后关闭复制开关被拒绝',
      Boolean(hotSwitch) && hotSwitch.includes('如需切换请先 browser_e2e_close'), String(hotSwitch))

    // 源目录必须原样保留。
    const sourceHashAfter = hashFile(join(sourceDir, 'Default', 'Network', 'Cookies'))
    check('源 profile 文件未被改写', sourceHashAfter === sourceHashBefore,
      `${sourceHashBefore} -> ${sourceHashAfter}`)
    check('源扩展目录仍在', existsSync(join(extDir, 'manifest.json')))

    console.log('== 用例 3：close 结束副本并删除副本目录 ==')
    const closed = await close(KEY)
    check('close 返回 cdp 模式', closed.closed === true && closed.mode === 'cdp', JSON.stringify(closed))
    check('close 摘要说明原 profile 未改动', String(closed.summary).includes('原 profile 未改动'), closed.summary)
    check('副本目录已删除', !existsSync(copyDir), copyDir)
    check('源 profile 仍然存在', existsSync(join(sourceDir, 'Default', 'Network', 'Cookies')))
  }

  console.log('== 用例 4：直连默认 Profile 被防呆拒绝 ==')
  {
    const edgePath = resolveEdgePath()
    if (edgePath === null) {
      console.log('  SKIP  本机找不到 Edge 可执行文件，防呆未验证')
    } else {
      const fakeLocal = mkdtempSync(join(tmpdir(), 'dsh-cdp-guard-local-'))
      const fakeUserData = join(fakeLocal, 'Microsoft', 'Edge', 'User Data')
      mkdirSync(fakeUserData, { recursive: true })
      const guardPort = await pickPort()
      const guardChild = spawn(edgePath, [
        '--headless=new', '--disable-gpu', '--no-first-run',
        `--remote-debugging-port=${guardPort}`, `--user-data-dir=${fakeUserData}`, 'about:blank',
      ], { stdio: 'ignore', windowsHide: true })
      const oldLocalAppData = process.env.LOCALAPPDATA
      process.env.LOCALAPPDATA = fakeLocal
      try {
        const ready = await waitForDevTools(guardPort)
        check('防呆用浏览器就绪', ready)
        const message = await expectThrow(() => launch('test-cdp-guard', {
          mode: 'cdp', cdpEndpoint: `http://127.0.0.1:${guardPort}`,
        }, 'test-cdp-guard'))
        check('直连默认 Profile 被拒绝',
          Boolean(message) && message.includes('拒绝直接接管系统 Edge 的默认 Profile'), String(message))
      } finally {
        process.env.LOCALAPPDATA = oldLocalAppData
        guardChild.kill()
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
        try {
          rmSync(fakeLocal, { recursive: true, force: true })
        } catch {
          // 临时目录删不掉不影响结论
        }
      }
    }
  }
} finally {
  await closeAll()
  try {
    rmSync(sourceDir, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不影响结论
  }
}

console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
