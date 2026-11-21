/**
 * 两个空闲时限的边界验收（DSH_BROWSER_IDLE_MS / DSH_BROWSER_POOL_IDLE_MS）。
 *
 * 约定：
 * - context 级：范围 [60000, 600000]，默认 600000。下限避免计时器在操作中途关掉会话。
 * - 池级：范围 [0, 600000]，默认 120000。0 = 立即回收（等所有 context 关掉后立刻关浏览器）。
 * - 两者非法值都不"静默永不回收"：context 回落默认，池级改写成 0。
 *
 * 常量在模块加载时求值，所以每种取值开一个子进程。
 *
 * 运行：node tests/idle-bounds.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'idle-bounds-child.mjs')

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

/**
 * 用同一条取值跑一次子进程探针。
 * @param {string|undefined} raw - 同时赋给两个环境变量；undefined 表示都不设
 * @returns {object|null}
 */
function probe(raw) {
  const env = { ...process.env }
  delete env.DSH_BROWSER_IDLE_MS
  delete env.DSH_BROWSER_POOL_IDLE_MS
  delete env.DSH_BROWSER_IDLE_MS_MIN_OVERRIDE
  if (raw !== undefined) {
    env.DSH_BROWSER_IDLE_MS = raw
    env.DSH_BROWSER_POOL_IDLE_MS = raw
  }
  const run = spawnSync(process.execPath, [CHILD], { env, encoding: 'utf8', timeout: 30000 })
  const lines = (run.stdout ?? '').trim().split('\n').filter(Boolean)
  const last = lines.length ? lines[lines.length - 1] : ''
  try {
    return JSON.parse(last)
  } catch {
    console.log(`  探针失败 raw=${JSON.stringify(raw)} stderr=${(run.stderr ?? '').trim().slice(0, 300)}`)
    return null
  }
}

console.log('== 用例 1：缺省值与声明的边界常量 ==')
{
  const got = probe(undefined)
  check('context 默认 600000（10 分钟）', got?.ctx === 600000, JSON.stringify(got))
  check('context 边界为 [60000, 600000]', got?.ctxMin === 60000 && got?.ctxMax === 600000, JSON.stringify(got))
  check('池级默认 120000（2 分钟）', got?.pool === 120000, JSON.stringify(got))
  check('池级上限 600000、默认常量 120000', got?.poolMax === 600000 && got?.poolDefault === 120000, JSON.stringify(got))
}

console.log('== 用例 2：context 级下限 1 分钟——小于下限一律抬到 60000 ==')
{
  for (const raw of ['0', '1', '59999']) {
    const got = probe(raw)
    check(`context ${raw} → 60000（不会在操作中途关会话）`, got?.ctx === 60000, JSON.stringify(got))
  }
  const atMin = probe('60000')
  check('context 60000 保持 60000', atMin?.ctx === 60000, JSON.stringify(atMin))
}

console.log('== 用例 3：context 级上限 10 分钟——大于上限一律压到 600000 ==')
{
  const over = probe('9999999')
  check('context 9999999 → 600000', over?.ctx === 600000, JSON.stringify(over))
  const mid = probe('300000')
  check('context 300000 原样保留', mid?.ctx === 300000, JSON.stringify(mid))
}

console.log('== 用例 4：context 级非法值回落默认值（不是永久关闭）==')
{
  for (const raw of ['abc', '-5', ' ', 'NaN', 'Infinity']) {
    const got = probe(raw)
    check(`context 非法值 ${JSON.stringify(raw)} 回落 600000`, got?.ctx === 600000, JSON.stringify(got))
  }
}

console.log('== 用例 5：池级取 0 是立即回收（不是永不回收）==')
{
  const zero = probe('0')
  check('池级 0 保留为 0（立即回收）', zero?.pool === 0, JSON.stringify(zero))
}

console.log('== 用例 6：池级上限 10 分钟 ==')
{
  const over = probe('9999999')
  check('池级 9999999 → 600000', over?.pool === 600000, JSON.stringify(over))
  const mid = probe('300000')
  check('池级 300000 原样保留', mid?.pool === 300000, JSON.stringify(mid))
}

console.log('== 用例 7：池级非法值改写成 0（立即回收）==')
{
  for (const raw of ['abc', '-5', ' ', 'NaN', 'Infinity']) {
    const got = probe(raw)
    check(`池级非法值 ${JSON.stringify(raw)} → 0`, got?.pool === 0, JSON.stringify(got))
  }
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
