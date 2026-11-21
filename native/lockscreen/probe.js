// 锁屏探针的 JS 侧桥接。原生实现在同目录 bin/ 下，仅 Windows 可用。
// 用法: const { isLocked } = await import('./native/lockscreen/probe.js')
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EXE = join(here, 'bin', 'lockprobe.exe')

/** 探针退出码到结论的映射：0 未锁、1 已锁、2 无法判定 */
const VERDICT_BY_EXIT = { 0: 'UNLOCKED', 1: 'LOCKED', 2: 'UNKNOWN' }

export class LockProbeUnavailableError extends Error {
  constructor (reason) {
    super(`锁屏检测不可用：${reason}`)
    this.name = 'LockProbeUnavailableError'
    this.code = 'LOCKPROBE_UNAVAILABLE'
  }
}

/**
 * 探测当前会话是否锁屏。
 *
 * 锁屏判据来自四路独立 Win32 探测的交叉验证（见 README.md 的「原理」）：
 * 输入桌面可访问性、WTS 会话标志、前台窗口归属、桌面 shell 存活。
 * 强信号冲突时返回 verdict='UNKNOWN' 而不是猜，调用方需自行决定降级策略。
 * @param {object} [options]
 * @param {boolean} [options.json] - 返回完整的四路明细（默认只返回结论）
 * @param {number} [options.timeoutMs] - 子进程超时（默认 5000）
 * @returns {{ verdict: 'LOCKED'|'UNLOCKED'|'UNKNOWN', exitCode: number, detail?: object }}
 */
export function probeLock ({ json = false, timeoutMs = 5000 } = {}) {
  if (process.platform !== 'win32') {
    throw new LockProbeUnavailableError(`仅支持 Windows，当前是 ${process.platform}`)
  }
  if (!existsSync(EXE)) {
    throw new LockProbeUnavailableError(`找不到探针可执行文件 ${EXE}，请先运行 native/lockscreen/build.ps1`)
  }

  const args = json ? ['--json'] : []
  const result = spawnSync(EXE, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
  if (result.error) {
    throw new LockProbeUnavailableError(`探针启动失败：${result.error.message}`)
  }
  if (result.status === null) {
    throw new LockProbeUnavailableError('探针被信号终止或超时')
  }

  const verdict = VERDICT_BY_EXIT[result.status]
  if (verdict === undefined) {
    throw new LockProbeUnavailableError(`探针返回非预期退出码 ${result.status}`)
  }

  if (!json) return { verdict, exitCode: result.status }
  return { verdict, exitCode: result.status, detail: JSON.parse(result.stdout) }
}

/**
 * 便捷判定：只看是否锁屏。
 * @returns {boolean} true 表示已锁屏
 */
export function isLocked () {
  return probeLock().verdict === 'LOCKED'
}

/** 探针是否在当前环境可用（不实际执行）。 */
export function probeAvailable () {
  return process.platform === 'win32' && existsSync(EXE)
}

export const PROBE_PATH = EXE
