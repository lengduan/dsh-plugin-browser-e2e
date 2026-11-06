/**
 * 把 client/index.js（bundle 源码）校验后发布成 lib/client.js。
 *
 * 为什么要有这一步：client/index.js 是浏览器 bundle 源，宿主只加载包内的
 * lib/client.js；两者内容一致，但不能靠人保证。构建时先用 `node --check`
 * 做语法校验（写临时文件后 spawnSync），校验不过就失败，避免把坏文件写出去。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 生成物头注释（客户看到它就知道不要手改）。 */
const HEADER = '/* 由 scripts/build-client.mjs 生成，勿手改；源文件：client/index.js */\n'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const sourcePath = join(root, 'client', 'index.js')
const outputPath = join(root, 'lib', 'client.js')

/** 读源文件并统一成 LF。 */
function readSource() {
  const text = readFileSync(sourcePath, 'utf8')
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

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

const source = readSource()
if (source.trim().length === 0) {
  throw new Error('client/index.js 为空，拒绝生成 lib/client.js')
}
checkSyntax(source)

const output = HEADER + source + (source.endsWith('\n') ? '' : '\n')
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, output, 'utf8')

const bytes = Buffer.byteLength(output, 'utf8')
console.log('[build-client] 语法校验通过（node --check）')
console.log(`[build-client] 已写入 lib/client.js（${bytes} 字节，UTF-8 / LF）`)
