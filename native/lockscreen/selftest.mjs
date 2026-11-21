// 锁屏探针的桥接自测。用法: node native/lockscreen/selftest.mjs
import { probeLock, isLocked, probeAvailable, PROBE_PATH } from './probe.js'

const fails = []
const check = (name, ok, extra = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) fails.push(name)
}

if (process.platform !== 'win32') {
  console.log(`[SKIP] 非 Windows 平台（${process.platform}），探针不可用属预期`)
  process.exit(0)
}

check('probeAvailable() 为 true', probeAvailable() === true)
console.log('  probe path =', PROBE_PATH)

const full = probeLock({ json: true })
check('verdict 是三种合法值之一', ['LOCKED', 'UNLOCKED', 'UNKNOWN'].includes(full.verdict), full.verdict)
check('confidence 合法', ['high', 'low', 'none'].includes(full.detail.confidence), full.detail.confidence)
check('四条探测都在', full.detail.signals.length === 4,
  full.detail.signals.map(s => s.name).join(','))
check('退出码与 verdict 自洽',
  (full.verdict === 'LOCKED') === (full.exitCode === 1), `exit=${full.exitCode}`)

const quick = probeLock()
check('轻量调用与明细调用结论一致', quick.verdict === full.verdict)
check('isLocked() 与 verdict 自洽', isLocked() === (full.verdict === 'LOCKED'))

console.log('')
if (fails.length) {
  console.log(`FAILED: ${fails.length} 项`)
  process.exit(1)
}
console.log('bridge ok')
process.exit(0)


