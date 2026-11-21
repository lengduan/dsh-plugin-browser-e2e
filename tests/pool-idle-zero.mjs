/**
 * DSH_BROWSER_POOL_IDLE_MS 取值的端到端语义验收。
 *
 * 约定：0 表示「租约归零立刻回收」，非法值一律改写成 0；正数值才等计时器。
 * POOL_IDLE_CLOSE_MS 是模块加载时求值的常量，同进程内改不了，
 * 所以每种取值都开一个子进程（pool-idle-zero-child.mjs），让它以该值加载 lib/pool.js。
 *
 * 运行：node tests/pool-idle-zero.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'pool-idle-zero-child.mjs')

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
 * 用指定取值跑一次子进程探针。
 * @param {string|undefined} raw - DSH_BROWSER_POOL_IDLE_MS 取值；undefined 表示完全不设
 * @returns {object|null} 子进程最后一行 JSON，解析失败为 null
 */
function probe(raw) {
  const env = { ...process.env }
  delete env.DSH_BROWSER_POOL_IDLE_MS
  if (raw !== undefined) env.DSH_BROWSER_POOL_IDLE_MS = raw
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

console.log('== 用例 1：不设时默认 120000，租约归零只装计时器、不当场关 ==')
{
  const got = probe(undefined)
  check('解析为 120000', got !== null && got.ms === 120000, JSON.stringify(got))
  check('装了空闲计时器', got !== null && got.idleArmed === true, JSON.stringify(got))
  check('60ms 后浏览器还在（没到点）', got !== null && got.hasBrowser === true && got.closed === 0, JSON.stringify(got))
}

console.log('== 用例 2：取 0 时租约归零立刻关浏览器（不等计时器）==')
{
  const got = probe('0')
  check('解析为 0', got !== null && got.ms === 0, JSON.stringify(got))
  check('没有装计时器（改成立即回收）', got !== null && got.idleArmed === false, JSON.stringify(got))
  check('release 当场就关了浏览器', got !== null && got.hasBrowserRightAfter === false && got.closed === 1, JSON.stringify(got))
}

console.log('== 用例 3：非法值一律改写成 0，同样立即回收（不是静默永不回收）==')
{
  for (const raw of ['abc', '-5', '', ' ', 'NaN', 'Infinity']) {
    const got = probe(raw)
    check(`非法值 ${JSON.stringify(raw)} 解析为 0`, got !== null && got.ms === 0, JSON.stringify(got))
    check(`非法值 ${JSON.stringify(raw)} 立即回收浏览器`,
      got !== null && got.hasBrowser === false && got.closed === 1, JSON.stringify(got))
  }
}

console.log('== 用例 4：正数值仍是「等计时器」，未到点不关 ==')
{
  const got = probe('120')
  check('解析为 120', got !== null && got.ms === 120, JSON.stringify(got))
  check('装了计时器', got !== null && got.idleArmed === true, JSON.stringify(got))
  check('60ms 时还没到点、浏览器仍在', got !== null && got.hasBrowser === true && got.closed === 0, JSON.stringify(got))
}

console.log('== 用例 5：正数值到点后确实关（阴性对照，证明用例 4 不是恒真）==')
{
  const got = probe('30')
  check('解析为 30', got !== null && got.ms === 30, JSON.stringify(got))
  check('30ms 到点后浏览器已被关', got !== null && got.hasBrowser === false && got.closed === 1, JSON.stringify(got))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
