/**
 * 截图层：截图参数与输出尺寸校验、clip / 倍率、产物目录、单次 JPEG 帧。
 *
 * 单次 JPEG 帧（captureJpeg）与 CDP 投屏（screencast.js）是同一「帧源」接缝上的两个
 * 真实适配器，因此分别成文件；页面对象由调用方（面板层）解析后传入，本文件不读会话注册表。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 截图输出约束：单边最大边长、最大总像素。 */
const MAX_SHOT_EDGE = 8192
const MAX_SHOT_PIXELS = 4194304

/** 截图允许的输出格式与缩放模式（css / device 透传 Playwright，1 / 2 / 3 走 CDP 倍率）。 */
const SHOT_FORMATS = new Set(['png', 'jpeg'])
const SHOT_SCALES = new Set(['css', 'device'])
/** 数值倍率走 Page.captureScreenshot 的 clip.scale。 */
const SHOT_NUMERIC_SCALES = new Set([1, 2, 3])

/** 截图文件名白名单：只允许 ASCII 字母数字与 . _ -。 */
const SHOT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

/** 截图文件名唯一后缀的自增计数（同一毫秒内两次同名调用也不覆盖）。 */
let shotNameSeq = 0

/**
 * 校验并生成截图文件名（不含扩展名）。
 *
 * 同名覆盖与路径穿越都从 name 来，因此只收安全字符：拒绝 . / .. / 含 .. 或路径分隔符的值，
 * 并在合法名字后追加「时间戳 + 自增序号」的唯一后缀。
 * @param {unknown} raw - 用户传入的 name
 * @returns {string | null} 归一后的名字；未传 name 返回 null 由调用方用默认名
 */
function safeShotName(raw) {
  // 没传 name 才走默认名；显式传了（哪怕空串）就必须校验，不能静默回退。
  if (raw === undefined || raw === null) return null
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (typeof raw !== 'string' || !text || !SHOT_NAME_PATTERN.test(text)
    || text === '.' || text === '..' || text.includes('..')) {
    throw new Error(`截图 name 只允许字母、数字、"."、"_"、"-"，且不能含 ".." 或路径分隔符，收到 ${JSON.stringify(raw)}`)
  }
  shotNameSeq += 1
  return `${text}-${Date.now().toString(36)}${shotNameSeq.toString(36)}`
}

/**
 * 保证产物目录存在：~/.dsh/browser-e2e/artifacts/<时间戳>，按会话首次调用时间创建。
 * @param {object} session - 会话状态（只写它的 artifactsDir 字段）
 * @returns {string} 产物目录
 */
export function ensureArtifactsDir(session) {
  if (!session.artifactsDir) {
    const now = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    session.artifactsDir = join(homedir(), '.dsh', 'browser-e2e', 'artifacts', stamp)
    mkdirSync(session.artifactsDir, { recursive: true })
  }
  return session.artifactsDir
}

/** 从 PNG / JPEG 文件头解析图片实际像素尺寸；解析失败返回 null。 */
function imageSize(buffer) {
  // PNG：签名 8 字节 + IHDR，宽高在 16..24 字节。
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG：扫描 SOFn 段，段内依次为精度(1)、高(2)、宽(2)。
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      offset += 2 + buffer.readUInt16BE(offset + 2)
    }
  }
  return null
}

/** 校验 clip 参数：四值整数、x/y 非负、宽高不小于 1。 */
function assertClip(clip) {
  if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
    throw new Error('clip 必须是 { x, y, width, height } 对象')
  }
  for (const field of ['x', 'y', 'width', 'height']) {
    if (!Number.isInteger(clip[field])) {
      throw new Error(`clip.${field} 必须是整数，收到 ${clip[field]}`)
    }
  }
  if (clip.x < 0 || clip.y < 0) {
    throw new Error(`clip.x / clip.y 不能为负数，收到 x=${clip.x}, y=${clip.y}`)
  }
  if (clip.width < 1 || clip.height < 1) {
    throw new Error(`clip.width / clip.height 必须 >= 1，收到 ${clip.width}x${clip.height}`)
  }
}

/** 视口基准尺寸：有固定视口用视口；CDP 接管模式没有固定视口，用页面实际内尺寸。 */
async function viewportBounds(page, viewport) {
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

/** 计算截图的 CSS 像素基准尺寸（clip 优先、其次整页、最后视口）。 */
async function shotBaseSize(page, { clip, fullPage, viewport }) {
  if (clip) return { width: clip.width, height: clip.height }
  if (fullPage) {
    return await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    }))
  }
  if (!viewport) {
    // CDP 接管模式没有固定视口（视口属于用户浏览器），按页面实际内尺寸兜底。
    return await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
    }))
  }
  return { width: viewport.width, height: viewport.height }
}

/**
 * 截图落盘，返回绝对路径与元数据。
 *
 * 支持 clip / format / quality / scale；截图前完成全部参数与输出尺寸校验，
 * 报错里带具体数字。返回的 data 为图片原始字节，供工具层转存为附件。
 * @param {object} session - 会话状态（产物目录挂在它上面）
 * @param {object} tab - 标签页条目
 * @param {object} [options] - 截图参数
 * @returns {Promise<object>} 截图结果
 */
export async function screenshot(session, tab, options = {}) {
  const page = tab.page

  const format = options.format ?? 'png'
  if (!SHOT_FORMATS.has(format)) {
    throw new Error(`不支持的截图格式 "${format}"，只支持 png 或 jpeg`)
  }
  const quality = options.quality
  if (quality !== undefined) {
    if (format !== 'jpeg') {
      throw new Error('quality 仅适用于 format="jpeg"')
    }
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new Error(`quality 必须是 1-100 的整数，收到 ${quality}`)
    }
  }
  const scale = options.scale
  // 数值倍率（1 / 2 / 3）走 CDP 的 clip.scale；css / device 仍透传 Playwright。
  const numericScale = SHOT_NUMERIC_SCALES.has(scale) ? scale : null
  if (scale !== undefined && numericScale === null && !SHOT_SCALES.has(scale)) {
    throw new Error(`scale 只支持 "css" / "device" / 1 / 2 / 3，收到 ${JSON.stringify(scale)}`)
  }
  const clip = options.clip
  if (clip !== undefined) assertClip(clip)
  const fullPage = options.fullPage ?? false
  if (clip !== undefined && fullPage) {
    throw new Error('clip 与 fullPage 不能同时使用')
  }
  // 文件名校验也属于参数校验：先失败，不白截一张图。
  const baseName = safeShotName(options.name) ?? `shot-${Date.now()}`

  const viewport = page.viewportSize()
  // CDP 接管模式没有固定视口，用页面实际内尺寸做 clip 边界校验，与隔离模式同口径。
  const clipBounds = clip ? await viewportBounds(page, viewport) : null
  if (clip && clipBounds) {
    if (clip.x + clip.width > clipBounds.width) {
      throw new Error(`clip 超出视口宽度：x + width = ${clip.x + clip.width} > 视口宽度 ${clipBounds.width}`)
    }
    if (clip.y + clip.height > clipBounds.height) {
      throw new Error(`clip 超出视口高度：y + height = ${clip.y + clip.height} > 视口高度 ${clipBounds.height}`)
    }
  }

  const base = await shotBaseSize(page, { clip, fullPage, viewport })
  // 数值倍率按倍率换算；css / device 按 Playwright 实际生效的缩放（device 默认）换算。
  let factor
  if (numericScale !== null) factor = numericScale
  else if (scale === 'css') factor = 1
  else factor = await page.evaluate(() => window.devicePixelRatio || 1)
  const outWidth = Math.round(base.width * factor)
  const outHeight = Math.round(base.height * factor)
  if (outWidth > MAX_SHOT_EDGE || outHeight > MAX_SHOT_EDGE) {
    throw new Error(`截图输出 ${outWidth}x${outHeight} 超出单边上限 ${MAX_SHOT_EDGE}`)
  }
  if (outWidth * outHeight > MAX_SHOT_PIXELS) {
    throw new Error(`截图输出 ${outWidth}x${outHeight} 共 ${outWidth * outHeight} 像素，超出上限 ${MAX_SHOT_PIXELS}`)
  }

  let buffer
  if (numericScale !== null) {
    // Playwright 的 scale 只有 css / device，倍率截图改用 CDP 的 Page.captureScreenshot。
    // CDP 的 clip 是页面坐标，而用户传入的 clip 与视口基准都以视口为准：必须先加滚动量，
    // 否则滚动后截到的是文档顶部；无 clip 时也必须显式给视口 clip，倍率才会真正生效。
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    const client = await page.context().newCDPSession(page)
    try {
      const params = { format, captureBeyondViewport: false }
      if (format === 'jpeg' && quality !== undefined) params.quality = quality
      if (clip) {
        params.clip = {
          x: clip.x + scroll.x,
          y: clip.y + scroll.y,
          width: clip.width,
          height: clip.height,
          scale: numericScale,
        }
      } else if (fullPage) {
        // 整页 + 倍率：必须显式给整页 clip，否则只能截到视口那一屏。
        params.clip = { x: 0, y: 0, width: base.width, height: base.height, scale: numericScale }
        params.captureBeyondViewport = true
      } else {
        // 视口 + 倍率：clip 用当前滚动位置的页面坐标，与视口一一对应。
        params.clip = { x: scroll.x, y: scroll.y, width: base.width, height: base.height, scale: numericScale }
      }
      const shot = await client.send('Page.captureScreenshot', params)
      buffer = Buffer.from(shot.data, 'base64')
    } finally {
      await client.detach().catch(() => {})
    }
  } else {
    // Playwright 的截图格式参数名是 type（png / jpeg），不是 format。
    const shotOptions = { fullPage, type: format }
    if (clip) shotOptions.clip = clip
    if (quality !== undefined) shotOptions.quality = quality
    if (scale === 'css' || scale === 'device') shotOptions.scale = scale
    buffer = await page.screenshot(shotOptions)
  }
  const dir = ensureArtifactsDir(session)
  const extension = format === 'jpeg' ? 'jpeg' : 'png'
  const file = join(dir, `${baseName}.${extension}`)
  writeFileSync(file, buffer)

  const actual = imageSize(buffer)
  const width = actual?.width ?? outWidth
  const height = actual?.height ?? outHeight
  const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  return {
    file,
    data: buffer,
    meta: {
      width,
      height,
      format,
      mediaType,
      bytes: buffer.length,
      fullPage,
      name: `${baseName}.${extension}`,
      ...(clip !== undefined ? { clip } : {}),
      // meta.scale 记录调用方传入的 scale 形态：css / device 为字符串，数值倍率为该整数。
      ...(scale !== undefined ? { scale } : {}),
    },
    summary: `截图 ${width}x${height} -> ${file}`,
  }
}

/**
 * 抓一帧 JPEG（base64），供刷新按钮与静态页面兜底。
 *
 * 投屏只在页面变化时产生帧，静态页面会停在最后一帧；刷新按钮走这条路径，
 * 保证「按一下就有画面」。
 * @param {import('playwright-core').Page | null} page - 页面对象；没有页面时返回 null
 * @param {{quality?: number}} [options] - quality 为 1-100 的 JPEG 质量
 * @returns {Promise<{data: string, width: number, height: number} | null>} 帧
 */
export async function captureJpeg(page, options = {}) {
  if (!page) return null
  const quality = Number.isInteger(options.quality) ? options.quality : 70
  const buffer = await page.screenshot({ type: 'jpeg', quality })
  const actual = imageSize(buffer)
  const viewport = page.viewportSize()
  return {
    data: buffer.toString('base64'),
    width: actual?.width ?? viewport?.width ?? 0,
    height: actual?.height ?? viewport?.height ?? 0,
  }
}
