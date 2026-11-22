/**
 * 测试共用的「数浏览器进程」工具。
 *
 * 为什么需要它：每个需要断言「进程回落到基线」的测试都通过 pwsh 调 WMI 数 msedge 主进程。
 * 直接在测试里写 spawnSync 有两个坑：
 *   1) 单次调用实测 1.1~1.3s，开销几乎全在 pwsh 启动。若在 waitUntil 里每 250ms 采一次样，
 *      采样间隔实际由进程启动耗时决定，配 10s 的「超时」会跑成 11.5s 以上；
 *   2) spawnSync 不设 timeout 时，一旦 pwsh 被卡住（WMI 繁忙、安全软件拦截），
 *      整个测试进程会永久阻塞，既不报错也不退出。
 * 所以：单次计数一律经 countBrowserRoots（带硬超时），等条件成立一律经
 * waitBrowserRootsAtMost（把等待放进 pwsh 内部循环，全程只起一个进程）。
 *
 * 不负责什么：不判断「进程回落」是否达成（那是测试的断言），不做清理、不杀进程，
 * 也不参与任何非进程条件的等待（页面 frame、网络环、池状态等仍用各测试自己的 waitUntil）。
 */
import { spawnSync } from 'node:child_process'

/** 单次 pwsh 调用的硬超时。正常一次 1.1~1.3s，30s 足够宽裕又不会永久挂起。 */
export const PW_SH_CALL_TIMEOUT_MS = 30000

/**
 * 数 msedge 主进程（排除 --type= 的子进程）。
 *
 * @param {string|null} commandLinePattern 额外要求命令行匹配的正则片段（例如按 profile 目录区分池槽）。
 *   传 null 表示只按「是主进程」过滤。
 * @returns {number} 进程数；pwsh 失败、超时或输出不可解析时抛错。
 */
export function countBrowserRoots(commandLinePattern = null) {
  // 用 pwsh 的单引号字符串拼正则：调用方传进来的是固定字面量（profile 目录名），不是用户输入。
  const extraFilter = commandLinePattern ? " -and $_.CommandLine -match '" + commandLinePattern + "'" : ''
  const script = "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\""
    + " | Where-Object { $_.CommandLine -notmatch '--type='" + extraFilter + " } | Measure-Object).Count"
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: PW_SH_CALL_TIMEOUT_MS,
    windowsHide: true,
  })
  if (ps.error || ps.status !== 0) {
    throw new Error('数 msedge 进程失败：' + (ps.error?.message ?? ('pwsh 退出码 ' + ps.status)))
  }
  const parsed = Number.parseInt(ps.stdout.trim(), 10)
  if (!Number.isInteger(parsed)) {
    throw new Error('数 msedge 进程得到非数字输出：' + JSON.stringify(ps.stdout))
  }
  return parsed
}

/**
 * 等到 msedge 主进程数 <= limit，返回结束时的**最终进程数**。
 *
 * 等待发生在 pwsh 内部（每 stepMs 采一次样），因此整个过程只起一个 pwsh。
 * 外部 spawnSync 的 timeout 取 timeoutMs + PW_SH_CALL_TIMEOUT_MS，保证即使 pwsh 卡住也有上限。
 *
 * 注意：返回值是进程数，不是布尔。进程数回落到 0 时返回 0，在 JS 里是假值，
 * 直接写 check(..., settled, ...) 会把「成功」判成失败。要布尔判断请用
 * waitBrowserRootsAtMostOk。
 *
 * @param {number} limit 允许的最大进程数（通常是运行前基线）。
 * @param {{timeoutMs?: number, stepMs?: number, commandLinePattern?: string|null}} [options]
 * @returns {number} 结束时的进程数；pwsh 失败或超时返回 -1。
 */
export function waitBrowserRootsAtMost(limit, options = {}) {
  const { timeoutMs = 10000, stepMs = 250, commandLinePattern = null } = options
  const extraFilter = commandLinePattern ? " -and $_.CommandLine -match '" + commandLinePattern + "'" : ''
  const script = [
    '$deadline = (Get-Date).AddMilliseconds(' + timeoutMs + ')',
    'do {',
    '  $count = (Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'"',
    '    | Where-Object { $_.CommandLine -notmatch \'--type=\'' + extraFilter + ' } | Measure-Object).Count',
    '  if ($count -le ' + limit + ') { break }',
    '  Start-Sleep -Milliseconds ' + stepMs,
    '} while ((Get-Date) -lt $deadline)',
    'Write-Output $count',
  ].join('\n')
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs + PW_SH_CALL_TIMEOUT_MS,
    windowsHide: true,
  })
  if (ps.error || ps.status !== 0) return -1
  const parsed = Number.parseInt(ps.stdout.trim(), 10)
  return Number.isInteger(parsed) ? parsed : -1
}

/**
 * 等到 msedge 主进程数 <= limit，返回**布尔**。
 *
 * 供 check(..., ok, ...) 这类真值判断使用：进程数回落到 0 时也是 true。
 * 与旧实现（waitUntil(() => edgeRootCount() <= baseline) 返回 true/false）行为一致。
 *
 * @param {number} limit 允许的最大进程数
 * @param {{timeoutMs?: number, stepMs?: number, commandLinePattern?: string|null}} [options]
 * @returns {boolean} 是否在超时前达成；pwsh 失败或超时视为未达成。
 */
export function waitBrowserRootsAtMostOk(limit, options = {}) {
  const remaining = waitBrowserRootsAtMost(limit, options)
  return remaining >= 0 && remaining <= limit
}
