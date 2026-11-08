/**
 * 摘要：一段 Buffer 的十六进制 SHA-256。
 *
 * 叶子模块：不 import 任何内部模块；observation.js / raw.js / download.js 共用这一份。
 * 流式下载（download.js 的 streamToFd）逐块 update，属不同环节，仍留在原处。
 */
import { createHash } from 'node:crypto'

/** 把一段正文 Buffer 的 sha256 转成十六进制。 */
export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
