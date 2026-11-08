# 控制台记录按最小严重级别过滤

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（「进程内对象契约 · 其他跨模块字段 · 能力函数返回值被 `tools.js` 各工具 `run` 读的字段」）；specs/项目规格/0002-panel-protocol-v1.md（本项不改协议，面板仍只读）；specs/功能规格/0005-console-network-ring.md（事件环的采集、重置、读取与工具文本，本项在其读取视图上做增补）
代码: lib/page.js / lib/observation.js / lib/tools.js / tests/tools.mjs / tests/invariants.mjs / tests/panel.mjs

## 需求

`browser_e2e_console` 目前只能按 `limit` 从尾部取 N 条，只关心 error 的调用方要先拉一大段文本再自己筛：多一次上下文开销，也容易在长文本里漏看。本项让调用方按「最小严重级别」直接读取不低于该级别的记录；采集、存储、重置与缓冲上限都不变。

## 行为

### 入口与参数

- 扩展现有工具 `browser_e2e_console`，不新增工具。理由：环形缓冲、`tab_id` 隔离、未启动报错、文本行格式全部已在该工具上，新增的只是「读取视图」这一维；另立工具会让「读控制台」出现两条入口，与 `0005` 已固定的 console / network 两个列表工具口径冲突。
- 新增可选参数 `level`：string，取值 `debug` / `log` / `info` / `warning` / `error`，另接受别名 `warn`（等价 `warning`）；不传、`null`、空串视为「不过滤」。
- 严重级别序（从低到高）：`debug < log < info < warning < error`。
- 参数 schema（`lib/tools.js` 的 `browser_e2e_console` 定义）：`level: { type: 'string', enum: [...] }`，enum 与描述都从 `lib/page.js` 导出的常量插值，不写死字面量。
- `limit` 语义不变：integer，缺省 100；`Number.isInteger(limit) && limit > 0` 时取 `Math.min(limit, RING_LIMIT)`，否则回退 100。`tab_id` 缺省用 active tab。

### 过滤与返回

- 归一：`level` 先 `trim()` 再转小写，命中别名后取规范名；返回字段 `level` 写规范名（传 `warn` / `WARN` 都写 `warning`）。未识别值抛错（文案见「边界」）。
- 判定：给了 `level` 时，记录保留条件为 `rank(entry.level) >= rank(level)`。`entry.level` 先做同样归一（记录里的 `warn` 也归一为 `warning`）；规范五级的 `rank` 为 0..4。
- 无法判级的类型一律保留：Playwright `ConsoleMessage.type()` 除上述五级外还会给出 `dir` / `dirxml` / `table` / `trace` / `clear` / `startGroup` / `startGroupCollapsed` / `endGroup` / `assert` / `profile` / `profileEnd` / `count` / `time` / `timeEnd`，这些类型 `rank` 为 -1，任何 `level` 下都返回。理由是不可判级的记录不静默丢弃（断言、表格转储常是排障线索）。
- 先过滤再截尾：命中集合按缓冲顺序取最后 `take` 条，`take` 与今天的 `limit` 口径相同。
- 能力函数签名改为 `consoleEntries(session, limit = 100, tabId, options = {})`，`options` 当前只有 `level`。工具层调用 `consoleEntries(requireSession(sessionKey(exec)), args.limit ?? 100, args.tab_id, { level: args.level })`；会话解析仍是 `requireSession`，未启动时不创建 idle 会话条目。
- 返回对象：`{ tabId, total, matched, count, level, entries, text, summary }`。
  - `total`：`consoleRing` 当前长度（过滤前，语义不变）。
  - `matched`：按 `level` 过滤后的命中条数；未给 `level` 时等于 `total`。
  - `count`：本次返回条数 `Math.min(matched, take)`。
  - `level`：归一后的规范名；未给时为 `null`。
  - `entries`：命中集合尾部 `count` 条，记录对象原样引用。
  - `text` / `summary`：见下。
- 文本行格式不变：`${timeOf(at)} ${level} ${oneLine(text)}`。行内的 `level` 是记录自带类型串（如 `warning`），不是过滤参数。
- 空记录与无命中分两种文案：
  - `total === 0`：`（暂无控制台记录）`。
  - `total > 0` 且给了 `level` 且 `matched === 0`：`（缓冲 ${total} 条记录，没有 level ≥ ${level} 的条目）`。
- 摘要：
  - 未给 `level`：`控制台记录 ${count} 条`，与今天逐字一致。
  - 给了 `level`：`控制台记录 ${count} 条（level ≥ ${level}，命中 ${matched} 条 / 缓冲 ${total} 条）`。
- 工具文本：`${summary}${note}\n${text}`。
  - 未给 `level`：沿用现口径，`total > count` 时 note 为 `（缓冲共 ${total} 条，只取尾部 ${count} 条）`。
  - 给了 `level`：`matched > count` 时 note 为 `（命中 ${matched} 条，只取尾部 ${count} 条）`，否则 note 为空串（摘要已写命中 / 缓冲）。

### 常量与单一来源

- `lib/page.js` 导出 `CONSOLE_LEVELS`（`['debug','log','info','warning','error']`）、`CONSOLE_LEVEL_ALIASES`（`{ warn: 'warning' }`）、`normalizeConsoleLevel(value)`、`consoleLevelRank(level)` 四个符号，与 `RING_LIMIT` / `CONSOLE_TEXT_LIMIT` 同处模块常量区。
- `lib/tools.js` 只从 `CONSOLE_LEVELS` / `CONSOLE_LEVEL_ALIASES` 派生 enum 与描述；`normalizeConsoleLevel` / `consoleLevelRank` 由能力函数与单测使用。`tests/invariants.mjs` 用例 K 的「工具描述从常量插值」断言扩展到 `CONSOLE_LEVELS`。
- 不新增 `lib/invariants.js` 断言：级别非法属于单次入参校验，记录永远合法（`msg.type()` 原样透传），不构成跨调用状态损坏。

### 状态变化与明确不做

- 只读：唯一副作用是 `session.touch()` 刷新空闲计时（与今天一致）。不写 ring、不改 `request_id` 计数、不动 ref 表与快照基线、不改会话状态机、不新建页、不动面板协议与投屏。
- `browser_e2e_network` 不加 `level`：竞品只给 `inspect.console`；网络侧更需要 status / failure 过滤，另立功能点。
- 不加 `clear` 参数：`0005` 的重置由「主框架新文档请求」与 `navigate` 驱动，读后清空会改事件环契约。
- 不改采集：记录仍是 `msg.type()` 原样透传、`pageerror` 记 `level: 'error'`（`0005`「缓冲与记录」不变）。

## 边界

- 非法 `level`：`level 只支持 debug / log / info / warning / error（warn 等同 warning），收到 "<值>"；不传 level 则返回全部记录`。值用 `JSON.stringify` 渲染；校验失败不读取、不修改任何记录。
- 校验顺序：先 `session.touch()` 与 `currentTab(session, tabId)`（沿用现有顺序），再归一 `level`。因此「未启动 + 非法 level」报 `浏览器尚未启动，请先调用 browser_e2e_start`；`tab_id` 不存在报 `tab <id> 不存在，请先 browser_e2e_tabs 获取最新 tab_id`。
- `limit` 边界不变：0 / 负数 / 小数 / 字符串回退 100；大于 `RING_LIMIT` 的值按 `RING_LIMIT` 截断。因为先过滤后截尾，`matched` 可以大于 `count`；`matched` 上限是 `RING_LIMIT`（500）。
- 不可判级类型始终保留：`level=error` 仍可能返回 `table` / `dir` / `assert` / `trace` 等行，这是本规格的明示行为，不做二次筛选。
- 别名与大小写：`WARN`、` Warning ` 都归一为 `warning`；`debug` / `log` / `info` / `error` 同样接受大小写与首尾空白。
- CDP 与 isolated 无分支差异（纯读，同一 Playwright 事件环）。iframe 内的 console 由 Playwright 的 page `console` 事件统一进入同一 ring；级别过滤不区分子 frame。
- 无等待、无新增超时、不接 `AbortSignal`（与既有只读工具一致）。
- 记录只存在进程内、随标签页条目丢弃的既有约束不变；本项不落盘、不跨会话。

## 验收

1. `node tests/tools.mjs` → exit 0、无 `FAIL`。新增用例 2B「console 级别过滤」的 check 名固定为：
   - `debug / log / info / warn / error 五级全部记录`
   - `level=error 只回 error（含 pageerror）`
   - `level=warn 等同 warning（含 warning 与 error）`
   - `level=debug 不过滤（matched 等于 total）`
   - `不可判级类型在 level=error 下仍保留`
   - `先过滤后截尾（matched 大于 count，只回最新 count 条）`
   - `返回含 total / matched / count / level`
   - `level 生效时摘要写明命中与缓冲`
   - `无命中文案与暂无记录文案可区分`
   - `非法 level 报错且不改记录`
2. `node tests/panel.mjs` → exit 0、无 `FAIL`。用例 C 新增 `browser_e2e_console 的 level 参数声明枚举`：enum 含 `debug` / `log` / `info` / `warning` / `error` / `warn`，且 `limit` / `tab_id` 仍在 properties。
3. `npm run test:unit` → exit 0、无 `FAIL`。`tests/invariants.mjs` 新增用例 L「console 级别归一与排序」：
   - `normalizeConsoleLevel 归一大小写与 warn 别名`
   - `normalizeConsoleLevel 拒绝未识别值`
   - `consoleLevelRank 对五级递增、对不可判级类型返回 -1`
   - 用例 K 的标识符清单增补 `CONSOLE_LEVELS` / `CONSOLE_LEVEL_ALIASES`（并入 `tools.js 的工具描述从常量插值，不写死默认值` 这条 check，未单立标签）。
4. `node tests/tools.mjs` 原有用例 2 / 3 / 3B / 3C / 3D / 3E 的文案与条数不变：默认不传 `level` 时 `total` / `count` / `text` / 摘要与改动前逐字一致。
5. 全量回归：`npm run test:integration` → exit 0、无 `FAIL`（按任务书串行规则由 tester 跑）。
