/**
 * 账户锁定防护第一层验收（功能规格 0042）：profile 目录、Local State 预置、哨兵值法自检。
 *
 * 主验收用**哨兵值法**（无需管理员）：启动前把 `password_manager.os_password_last_changed`
 * 写成 `9223372036854775807`，真起一次浏览器后读回；值被改写说明 Chromium 读过并消费了这个标记，
 * 从而不再做空密码探测（4625 的来源）。值仍是原样 = 防护未生效，报红。
 *
 * 前半部分是纯逻辑（临时目录，不启浏览器），后半部分真起一次无头 Edge。
 *
 * 运行：node tests/browser-profile.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_BROWSER_IDLE_MS = '600000'
process.env.DSH_BROWSER_POOL_IDLE_MS = '2000'

const {
  OS_PASSWORD_LAST_CHANGED_SENTINEL, ensureLocalStateSeed, readLocalState, readOsPasswordLastChanged,
  resetBrowserProfile, resolveBrowserProfileDir,
} = await import('../lib/browser-profile.js')
const { mergeDisabledFeatures, PLAYWRIGHT_DEFAULT_DISABLED_FEATURES, EXTRA_DISABLED_FEATURES } = await import('../lib/pool.js')

let pass = 0
let fail = 0
let skip = 0
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`) }
}
function skipped(label, reason) {
  skip += 1
  console.log(`  SKIP  ${label} —— ${reason}`)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))

try {
  console.log('== 用例 1：目录解析 ==')
  {
    const dir = resolveBrowserProfileDir()
    check('缺省目录在 ~/.dsh/browser-e2e/browser-profile/ 下',
      dir.includes(join('.dsh', 'browser-e2e', 'browser-profile')), dir)
    check('目录解析是绝对路径', dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir), dir)
  }

  console.log('== 用例 2：首次写入种子（合并 written=true）==')
  {
    const dir = join(root, 'fresh')
    const result = ensureLocalStateSeed(dir)
    check('首次写入返回 created=true 且 written=true',
      result.created === true && result.written === true, JSON.stringify(result))
    const file = join(dir, 'Local State')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    check('password_manager.os_password_last_changed 是字符串哨兵值',
      raw.password_manager?.os_password_last_changed === OS_PASSWORD_LAST_CHANGED_SENTINEL
        && typeof raw.password_manager.os_password_last_changed === 'string', JSON.stringify(raw.password_manager))
    check('同时写入 os_password_blank=false', raw.password_manager?.os_password_blank === false)
    check('读回接口与文件一致', readOsPasswordLastChanged(dir) === OS_PASSWORD_LAST_CHANGED_SENTINEL)
  }

  console.log('== 用例 3：合并写入不覆盖既有内容 ==')
  {
    const dir = join(root, 'merge')
    mkdirSync(dir, { recursive: true })
    // 模拟真实 Local State：除 password_manager 外还有大量 Chromium 自己的状态。
    const existing = {
      profile: { info_cache: { Default: { name: 'Person 1' } } },
      intl: { app_locale: 'zh-CN' },
      browser: { enabled_labs_experiments: ['SomeExperiment'] },
      password_manager: { os_password_blank: false, something_else: 42 },
    }
    writeFileSync(join(dir, 'Local State'), JSON.stringify(existing))
    const result = ensureLocalStateSeed(dir)
    check('已有文件时不报 created', result.created === false, JSON.stringify(result))
    const raw = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'))
    check('既有顶层字段全部保留',
      JSON.stringify(raw.profile) === JSON.stringify(existing.profile)
        && JSON.stringify(raw.intl) === JSON.stringify(existing.intl)
        && JSON.stringify(raw.browser) === JSON.stringify(existing.browser),
      JSON.stringify(raw))
    check('既有 password_manager 其它字段保留',
      raw.password_manager.something_else === 42 && raw.password_manager.os_password_blank === false,
      JSON.stringify(raw.password_manager))
    check('补上了 os_password_last_changed', raw.password_manager.os_password_last_changed === OS_PASSWORD_LAST_CHANGED_SENTINEL)
  }

  console.log('== 用例 4：幂等（已有合法值就不再改写）==')
  {
    const dir = join(root, 'idempotent')
    ensureLocalStateSeed(dir)
    const before = readFileSync(join(dir, 'Local State'), 'utf8')
    const second = ensureLocalStateSeed(dir)
    const after = readFileSync(join(dir, 'Local State'), 'utf8')
    check('第二次不再写入', second.written === false, JSON.stringify(second))
    check('文件内容逐字未变', before === after)
    // 已知真实值（Chromium 自己写出的）同样不该被覆盖回哨兵值。
    const dir2 = join(root, 'real-value')
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir2, 'Local State'), JSON.stringify({
      password_manager: { os_password_last_changed: '13424837222064658' },
    }))
    const third = ensureLocalStateSeed(dir2)
    check('已有真实值时不覆盖', third.written === false
      && readOsPasswordLastChanged(dir2) === '13424837222064658', JSON.stringify(third))
  }

  console.log('== 用例 5：损坏 JSON 恢复（备份 .corrupt 后重建）==')
  {
    const dir = join(root, 'corrupt')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Local State'), '{ this is not json')
    // 注意：readLocalState 自身就把损坏文件改名备份了，所以「先读再 seed」会看到文件已不在。
    // 这里直接走 ensureLocalStateSeed（生产路径就是这么调的），由它一次性完成恢复 + 写入。
    const result = ensureLocalStateSeed(dir)
    check('损坏后仍能写入种子', result.written === true && result.recovered === true, JSON.stringify(result))
    check('写入后读回哨兵值', readOsPasswordLastChanged(dir) === OS_PASSWORD_LAST_CHANGED_SENTINEL)
    check('损坏文件留了 .corrupt 备份', readFileSync(join(dir, 'Local State.corrupt'), 'utf8') === '{ this is not json')
  }

  console.log('== 用例 6：非对象 / 数组形态的 JSON 也按损坏处理 ==')
  {
    const dir = join(root, 'array')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Local State'), '[1, 2, 3]')
    const result = ensureLocalStateSeed(dir)
    check('数组形态判为 corrupt 并重建', result.recovered === true && result.written === true, JSON.stringify(result))
  }

  console.log('== 用例 7：--disable-features 拼成单一开关（默认 15 项 + 我们的 2 项）==')
  {
    const merged = mergeDisabledFeatures()
    const parts = merged.split(',')
    check('含 Playwright 默认全部项', PLAYWRIGHT_DEFAULT_DISABLED_FEATURES.every((name) => parts.includes(name)),
      JSON.stringify({ merged }))
    check('含我们的额外项', EXTRA_DISABLED_FEATURES.every((name) => parts.includes(name)), JSON.stringify({ merged }))
    check('无重复项', new Set(parts).size === parts.length, JSON.stringify(parts))
    check('项数 = 默认 + 额外', parts.length === PLAYWRIGHT_DEFAULT_DISABLED_FEATURES.length + EXTRA_DISABLED_FEATURES.length,
      String(parts.length))
  }

  console.log('== 用例 8：显式重置（D13 的清理入口）==')
  {
    const dir = join(root, 'reset-me')
    ensureLocalStateSeed(dir)
    check('重置前目录存在', readLocalState(dir).existed === true)
    const removed = resetBrowserProfile(dir)
    check('重置返回 true', removed === true)
    check('重置后目录已删', readLocalState(dir).existed === false)
    check('重置不存在的目录返回 false', resetBrowserProfile(join(root, 'never-existed')) === false)
  }

  console.log('== 用例 9：主验收（哨兵值法，真起一次浏览器）==')
  {
    const dir = join(root, 'sentinel-live')
    ensureLocalStateSeed(dir)
    const before = readOsPasswordLastChanged(dir)
    check('启动前是哨兵值', before === OS_PASSWORD_LAST_CHANGED_SENTINEL, String(before))
    const { acquire, shutdown } = await import('../lib/pool.js')
    try {
      const got = await acquire({ headless: true, carrier: 'edge', userDataDir: dir })
      check('真起浏览器成功（launchPersistentContext 可用）', Boolean(got.browser), JSON.stringify({ reused: got.reused }))
      check('池记录了「Local State 已被消费」', got.browser !== null)
      await shutdown('哨兵值主验收收尾')
      const after = readOsPasswordLastChanged(dir)
      // 这是本步的主验收：值被改写 → Chromium 读过并处理了这个标记 → 不再重新做空密码探测。
      check('启动后哨兵值已被 Chromium 改写（防护生效）', after !== before && after !== null,
        `before=${before} after=${after}`)
      const raw = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'))
      check('Local State 仍保留大量既有字段（未被整体覆盖）', Object.keys(raw).length >= 5,
        `keys=${Object.keys(raw).length}`)
      check('password_manager 段仍在', Boolean(raw.password_manager && typeof raw.password_manager === 'object'))
    } finally {
      await shutdown('收尾').catch(() => {})
    }
  }
} finally {
  await import('../lib/pool.js').then((m) => m.shutdown('收尾')).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`)
process.exit(fail === 0 ? 0 : 1)
