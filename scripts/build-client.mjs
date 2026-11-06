/**
 * 把 client/index.js（bundle 源码）校验后发布成 lib/client.js。
 *
 * 为什么要有这一步：client/index.js 是浏览器 bundle 源，宿主只加载包内的
 * lib/client.js；两者内容一致，但不能靠人保证。构建时先用 `node --check`
 * 做语法校验（写临时文件后 spawnSync），校验不过就失败，避免把坏文件写出去。
 *
 * 同时做协议常量注入：client 不手写投屏区间 / 默认值 / 版本 / socket 路径，
 * 构建时从 lib/protocol.js（唯一来源）生成常量块，替换源码里的注入标记。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SCREENCAST_CONFIG, PANEL_CONFIG_LIMITS, PANEL_PROTOCOL_VERSION, PANEL_SOCKET_PATH,
} from '../lib/protocol.js'

/** 生成物头注释（客户看到它就知道不要手改）。 */
const HEADER = '/* 由 scripts/build-client.mjs 生成，勿手改；源文件：client/index.js */\n'

/** client/index.js 里的注入标记；构建时整段替换成 protocol.js 派生的常量块。 */
const INJECT_START = '    /* @inject:panel-protocol:start */'
const INJECT_END = '    /* @inject:panel-protocol:end */'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const sourcePath = join(root, 'client', 'index.js')
const outputPath = join(root, 'lib', 'client.js')

/** 读源文件并统一成 LF。 */
function readSource() {
  const text = readFileSync(sourcePath, 'utf8')
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/** 由协议表生成 client 需要的常量块。 */
function protocolBlock() {
  const indent = '    '
  return [
    INJECT_START,
    `${indent}/** 协议版本；host 与 client 必须一致。 */`,
    `${indent}const PROTOCOL_VERSION = ${PANEL_PROTOCOL_VERSION};`,
    `${indent}/** host 半区挂载的 WebSocket 路径。 */`,
    `${indent}const WS_PATH = ${JSON.stringify(PANEL_SOCKET_PATH)};`,
    `${indent}/** 设置卡片可改字段的取值区间（host 与 client 同表）。 */`,
    `${indent}const PANEL_CONFIG_LIMITS = ${JSON.stringify(PANEL_CONFIG_LIMITS)};`,
    `${indent}/** 投屏默认值；host 的 state 到达后以 host 下发的为准。 */`,
    `${indent}const DEFAULT_CONFIG = ${JSON.stringify(DEFAULT_SCREENCAST_CONFIG)};`,
    INJECT_END,
  ].join('\n')
}

/** 把源码里的注入标记替换成协议常量块；缺标记直接失败。 */
function injectProtocol(source) {
  const start = source.indexOf(INJECT_START)
  const end = source.indexOf(INJECT_END)
  if (start < 0 || end < 0 || end < start) {
    throw new Error('client/index.js 缺少协议常量注入标记（@inject:panel-protocol）')
  }
  return source.slice(0, start) + protocolBlock() + source.slice(end + INJECT_END.length)
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
console.log('[build-client] 协议常量已由 lib/protocol.js 注入')
console.log(`[build-client] 已写入 lib/client.js（${bytes} 字节，UTF-8 / LF）`)
