/**
 * 把 client/index.js（bundle 源码）校验后发布成 lib/client.js。
 *
 * 为什么要有这一步：client/index.js 是浏览器 bundle 源，宿主只加载包内的
 * lib/client.js；两者内容一致，但不能靠人保证。构建时先用 `node --check`
 * 做语法校验（写临时文件后 spawnSync），校验不过就失败，避免把坏文件写出去。
 *
 * 同时做协议注入：client 不手写投屏区间 / 默认值 / 版本 / socket 路径 / 命令与事件名，
 * 构建时从 lib/protocol.js（唯一来源）生成常量块，替换源码里的注入标记。
 * 生成与替换逻辑在 scripts/protocol-inject.mjs，测试复用同一模块做源码↔产物一致性断言。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HEADER, injectProtocol, readSource } from './protocol-inject.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outputPath = join(root, 'lib', 'client.js')

/** 用 `node --check` 校验源码语法；失败时抛错并带 stderr。 */
function checkSyntax(text) {
  const tempPath = join(tmpdir(), `dsh-browser-e2e-client-${process.pid}.js`)
  try {
    writeFileSync(tempPath, text, 'utf8')
    const result = spawnSync(process.execPath, ['--check', tempPath], { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error('node --check 未通过：\n' + (result.stderr || '').trim())
    }
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件已被清理时忽略
    }
  }
}

const source = injectProtocol(readSource())
if (source.trim().length === 0) {
  throw new Error('client/index.js 为空，拒绝生成 lib/client.js')
}
checkSyntax(source)

const output = HEADER + source + (source.endsWith('\n') ? '' : '\n')
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, output, 'utf8')

const bytes = Buffer.byteLength(output, 'utf8')
console.log('[build-client] 语法校验通过（node --check）')
console.log('[build-client] 协议常量与命令 / 事件名已由 lib/protocol.js 注入')
console.log(`[build-client] 已写入 lib/client.js（${bytes} 字节，UTF-8 / LF）`)
