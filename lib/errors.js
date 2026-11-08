/**
 * 错误判定：Playwright 异常的分类判据。
 *
 * 叶子模块：不 import 任何内部模块；fetch.js / raw.js / download.js 共用这一份超时判据，
 * 判据只读错误对象本身，不做 I/O。
 */

/** Playwright 超时判定：错误名对 TimeoutError，或文案里带「timeout ... exceeded」。 */
export function isTimeoutError(error) {
  return Boolean(error) && (error.name === 'TimeoutError' || /timeout .*exceeded/i.test(error.message || ''))
}
