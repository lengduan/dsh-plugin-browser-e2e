# AGENTS.md

本仓是 DeepSeek Harness（DSH）浏览器端到端验证插件：宿主半区 15 个 `browser_e2e_*` 工具 + 右侧实时浏览器面板。
`README.md` 是给使用者的说明书；本文件只规定代理在本仓做事时的流程与固定约定。

## 做需求前先读规格

任何改动之前，按顺序读完下面两处，再动代码：

1. **项目规格** —— `specs/项目规格/`：范围、非目标、架构约束、跨功能的契约与不变量。
2. **功能规格** —— `specs/功能规格/`：与本次需求对应的功能点的行为、边界与验收标准。

规则：

- 目录里没有相关文件，说明该层尚无规格，不要据此推断需求；先向用户确认，或先补规格再实现。
- 规格与实现不一致时以规格为准；确需改语义，先改规格并说明理由，再改代码。
- 需求改变了已有规格的语义，同步更新对应文件；新功能点新增一份 `specs/功能规格/NNNN-<slug>.md`。
- 分不清项目级还是功能级时放功能规格，并在文中引用项目规格的相关条目。

## 开发约定

- 纯 JS + ESM，无打包器。宿主半区 `lib/`（工具表 `tools.js`、协议表 `protocol.js`、不变量 `invariants.js`、会话 `session.js`、页面 `page.js`、截图 `capture.js`、补票 `auth.js`），客户端 `client/index.js`，测试 `tests/*.mjs`；每个测试都直接用 `node tests/<name>.mjs` 跑，没有测试框架、没有 `npm test`。
- 改了 `client/index.js` 必须跑 `node scripts/build-client.mjs` 重新生成并提交 `lib/client.js`；该脚本做 `node --check` 语法校验，并从 `lib/protocol.js` 注入协议常量。
- 工具定义、协议契约、跨调用不变量分别只在 `lib/tools.js` / `lib/protocol.js` / `lib/invariants.js` 维护，不要在别处复制一份。
- 测试会真起无头 Edge：进程数断言以「回落到运行前基线」为准，不看绝对值；跑前避免本机其它自动化同时操作 Edge。
- 改协议或工具参数时，同时看 `tests/panel.mjs`（协议与参数契约）与 `tests/tools.mjs`（工具能力）。
- `package.json` 的 `files` 只含 `lib` 与 `cordis.patch.yml`，`client/`、`scripts/`、`tests/` 不进 profile。
- 注释与文档用中文，文件 UTF-8；不做与需求无关的重构与格式化。

## 还需要的背景

- 工具表、面板协议、CDP 接管、进程回收、已知限制：`README.md` 对应小节。
- 安装与版本快照：README「安装」节 —— profile 里是 commit 快照，改完要 commit + push 后重新解析，否则跑的还是旧提交。
