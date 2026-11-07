/**
 * 面板协议注入：把 lib/protocol.js 的命令 / 事件 / 投屏常量生成 client bundle 的常量块。
 *
 * 构建脚本（scripts/build-client.mjs）与一致性测试（tests/invariants.mjs）共用本模块：
 * 「client 不手写协议常量与协议名」只有这一套生成与判定逻辑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SCREENCAST_CONFIG, PANEL_COMMANDS, PANEL_CONFIG_LIMITS, PANEL_EVENTS, PANEL_PROTOCOL_VERSION,
  PANEL_SOCKET_PATH,
} from '../lib/protocol.js'

/** 生成物头注释（客户看到它就知道不要手改）。 */
export const HEADER = '/* 由 scripts/build-client.mjs 生成，勿手改；源文件：client/index.js */\n'

/** client/index.js 里的注入标记；构建时整段替换成 protocol.js 派生的常量块。 */
export const INJECT_START = '    /* @inject:panel-protocol:start */'
export const INJECT_END = '    /* @inject:panel-protocol:end */'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 读 client/index.js 源文件并统一成 LF。 */
export function readSource() {
  const text = readFileSync(join(root, 'client', 'index.js'), 'utf8')
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/**
 * 由协议表生成 client 需要的常量块。
 *
 * 命令表与事件表也一并注入：client 的发送与事件分支只引用注入常量，不手写协议名。
 * 顺序取 lib/protocol.js 里表的定义顺序，因此输出稳定（同一份协议表只生成一份文本）。
 */
export function protocolBlock() {
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
    `${indent}/** 客户端命令名（线上协议名，host 的命令表同源）。 */`,
    `${indent}const PANEL_COMMANDS = Object.freeze(${JSON.stringify(PANEL_COMMANDS)});`,
    `${indent}/** 服务端事件名（线上协议名，host 的事件表同源）。 */`,
    `${indent}const PANEL_EVENTS = Object.freeze(${JSON.stringify(PANEL_EVENTS)});`,
    INJECT_END,
  ].join('\n')
}

/** 把源码里的注入标记替换成协议常量块；缺标记直接失败。 */
export function injectProtocol(source) {
  const start = source.indexOf(INJECT_START)
  const end = source.indexOf(INJECT_END)
  if (start < 0 || end < 0 || end < start) {
    throw new Error('client/index.js 缺少协议常量注入标记（@inject:panel-protocol）')
  }
  return source.slice(0, start) + protocolBlock() + source.slice(end + INJECT_END.length)
}
