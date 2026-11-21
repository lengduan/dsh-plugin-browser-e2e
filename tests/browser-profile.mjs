/**
 * 账户锁定防护第一层验收（功能规格 0041「profile 目录」）：profile 目录、Local State 预置、哨兵值法自检。
 *
 * 用**哨兵值法**（无需管理员）：启动前把 `password_manager.os_password_last_changed`
 * 写成 `9223372036854775807`，真起一次浏览器、close() 之后读回。它只能证明
 * 「Chromium 读过并改写了这个字段」，**不能**证明「跳过了空密码探测」——后者已在 4625 实测中被证伪
 * （功能规格 0041「profile 目录」一节）。本文件因此不再把它当「防护生效」的验收，只锁字段级契约。
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
      const stats = await import('../lib/pool.js').then((m) => m.poolStats())
      // 这条断言原来断的是「启动后立刻回读，标记已被消费」，而那个字段恒为 false：
      // 回读发生在 close() 之前，此时 Chromium 还没落盘（实测 3.1 秒内始终是原值）。
      // 现在断的是如实语义：本例**先自己 seed 过**（第 157 行），所以池内的 ensureLocalStateSeed
      // 必然幂等跳过、记账必须是 'skipped'。这正好把「判据 after !== SENTINEL 恒真」这个坑钉死：
      // 只要有人把这里改成无条件断言 'written'，就说明他没意识到幂等。
      check('池如实记录本轮是幂等跳过（此前已写入过标记）',
        stats.slots.some((s) => s.localStateConsumed === 'skipped'),
        JSON.stringify(stats.slots.map((s) => ({ consumed: s.localStateConsumed }))))
      check('记账取值只可能是三态之一',
        stats.slots.every((s) => ['written', 'unchanged', 'skipped'].includes(s.localStateConsumed)),
        JSON.stringify(stats.slots.map((s) => ({ consumed: s.localStateConsumed }))))
      const raw = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'))
      check('Local State 仍保留大量既有字段（未被整体覆盖）', Object.keys(raw).length >= 5,
        `keys=${Object.keys(raw).length}`)
      check('password_manager 段仍在', Boolean(raw.password_manager && typeof raw.password_manager === 'object'))
    } finally {
      await shutdown('收尾').catch(() => {})
    }
    // 哨兵值法唯一可靠的观测点在 close() 之后：实测启动后 3.1 秒内读到的始终是原值。
    // 它证明「Chromium 读过并改写了这个字段」，但**不**证明「跳过了空密码探测」——
    // 该等价关系已被 4625 A/B 实测证伪（功能规格 0041「profile 目录」一节）。
    const after = readOsPasswordLastChanged(dir)
    check('close() 之后哨兵值被 Chromium 改写（仅证明字段被消费，不证明跳过探测）',
      after !== before && after !== null, `before=${before} after=${after}`)
    const statsAfterClose = await import('../lib/pool.js').then((m) => m.poolStats())
    check('池记录了关闭后回读结果（与真实文件一致）',
      statsAfterClose.slots.every((s) => s.localStateFlushedAfterClose === (after !== before)),
      JSON.stringify({ slots: statsAfterClose.slots.map((s) => s.localStateFlushedAfterClose), after, before }))
  }

  console.log('== 用例 10：default context 不参与池的关闭判断（只看租约）==')
  {
    // launchPersistentContext 会带一个 profile 宿主的 default context，它无法单独关闭。
    // 这条锁住「池的关闭判断只看 slot.leases、不清点 browser.contexts()」这一性质：
    // 若以后有人改成数 context，default context 会让回收永远不触发，这里立刻报红。
    const { acquire, release, poolStats, shutdown, resetPoolForTest } = await import('../lib/pool.js')
    try {
      const got = await acquire({ headless: true, carrier: 'edge' })
      const b = got.browser
      const beforeClose = b.contexts().length
      check('启动后浏览器上至少有 default context + 我们的（≥1）', beforeClose >= 1, `contexts=${beforeClose}`)
      // 自建一个隔离 context，模拟会话的用法
      const own = await b.newContext({ viewport: { width: 640, height: 480 } })
      await own.newPage()
      const withOwn = b.contexts().length
      check('自建 context 后数量增加', withOwn === beforeClose + 1, `before=${beforeClose} after=${withOwn}`)
      await own.close()
      // 归还租约：池级空闲到点（或 0 立即）应关浏览器，与残留的 default context 无关
      const res = release(got.signature)
      check('归还后租约归零', res.leases === 0, JSON.stringify(res))
      const gone = await (async () => {
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          if (poolStats().hasBrowser === false) return true
          await new Promise((r) => setTimeout(r, 100))
        }
        return false
      })()
      check('即使 default context 仍存活，租约归零后浏览器照样被回收', gone, JSON.stringify(poolStats()))
    } finally {
      await shutdown('default context 用例收尾').catch(() => {})
      resetPoolForTest?.()
    }
  }
} finally {
  await import('../lib/pool.js').then((m) => m.shutdown('收尾')).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`)
process.exit(fail === 0 ? 0 : 1)
