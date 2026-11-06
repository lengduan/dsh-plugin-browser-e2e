/**
 * 面板路由的 loopback 围栏。
 *
 * `/api/dsh-browser-e2e/state` 与 `/api/dsh-browser-e2e/socket` 由插件自己注册，
 * 不在宿主的路由改写白名单里，因此必须自校验来源：socket 远端地址与 Host 头
 * 都必须是 loopback，并拒绝跨站标记。语义与 @linxin666/dsh-client-ui-browser-view、
 * @lengduan/dsh-usage-stats 的围栏一致：socket 地址是权威依据，永不采信
 * X-Forwarded-For。
 */

/** IPv4 127/8 判定：四段十进制、首段为 127。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * socket 远端地址是否属于 loopback（127/8、::1、IPv4-mapped）。
 * @param {string|undefined|null} address - `request.socket.remoteAddress`
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/**
 * 主机名是否指向 loopback（localhost、[::1]、127/8）。
 * @param {string} hostname - `URL.hostname`
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const value = String(hostname).toLowerCase()
  if (value === 'localhost' || value === '[::1]') return true
  return isIPv4Loopback(value)
}

/**
 * 请求级判定：loopback socket + loopback Host，并校验浏览器同源标记。
 * @param {import('node:http').IncomingMessage} request - 原始请求
 * @returns {boolean}
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 写一条 JSON 响应（统一 no-store 与 no-referrer）。
 * @param {import('node:http').ServerResponse} res - 响应对象
 * @param {number} status - HTTP 状态码
 * @param {unknown} body - 任意可 JSON 序列化的值
 */
export function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
