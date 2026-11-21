/**
 * tests/idle-bounds.mjs 的子进程探针：按环境变量求值两个常量并回报。
 */
const { IDLE_CLOSE_MS, IDLE_MIN_MS, IDLE_MAX_MS } = await import('../lib/session.js')
const { POOL_IDLE_CLOSE_MS, POOL_IDLE_MAX_MS, POOL_IDLE_DEFAULT_MS } = await import('../lib/pool.js')
console.log(JSON.stringify({
  ctx: IDLE_CLOSE_MS, ctxMin: IDLE_MIN_MS, ctxMax: IDLE_MAX_MS,
  pool: POOL_IDLE_CLOSE_MS, poolMax: POOL_IDLE_MAX_MS, poolDefault: POOL_IDLE_DEFAULT_MS,
}))
