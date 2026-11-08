/**
 * 视口度量：视口基准尺寸。
 *
 * 叶子模块：不 import 任何内部模块；页面对象由调用方传入，因此 page.js 与 capture.js
 * 可以共用同一份口径而不产生回指。
 */

/** 视口基准尺寸：有固定视口用视口；CDP 接管模式没有固定视口，用页面实际内尺寸。 */
export async function viewportBounds(page, viewport) {
  if (viewport) return { width: viewport.width, height: viewport.height }
  try {
    return await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
    }))
  } catch {
    return null
  }
}
