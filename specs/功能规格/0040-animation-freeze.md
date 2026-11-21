# 动画冻结

状态: 已实现
关联: specs/功能规格/0002-browser-launch-and-reuse.md（启动与复用）；specs/功能规格/0008-cdp-attach.md（接管页同样适用）；specs/项目规格/0001-architecture-invariants.md（会话状态机、模块表）
代码: lib/page.js / lib/session.js / lib/tools.js / tests/freeze.mjs

## 需求

无限 CSS 动画会让整页每帧重绘。在节点多、内联样式大、带整屏 canvas 的页面上（实测 DSH GUI：1557 个节点、约 1MB 内联 CSS、1320×860 canvas），
会话行上一个小小的「进行中」旋转点就能把空闲占用从约 71% 拉到 167.8% 单核；Playwright 又默认带
`--disable-renderer-backgrounding` / `--disable-backgrounding-occluded-windows`，headless 下该动画永不节流。

验证工作通常不需要动画：给 `browser_e2e_start` 一个开关，让插件在每次换文档后自动停掉动画，把占用压回基线。

## 行为

- **入口与参数**：`browser_e2e_start` 新增 `freezeAnimations`（boolean，默认 false）。
  - 首次启动时写入会话字段 `session.freezeAnimations`，并立即对刚登记的首屏页执行一次冻结。
  - 已启动（复用）时传该参数**就地切换**，不必重开浏览器：开启时对所有已登记标签页补冻一次并返回「已开启动画冻结，并对当前 N 个标签页补冻」；
    关闭只改标志，返回「已关闭动画冻结（已注入的页面保持现状，后续换文档不再冻结）」。浏览器尚未启动时返回「浏览器尚未启动，freezeAnimations 将在下次 browser_e2e_start 生效」。
- **冻结脚本**（`lib/page.js` 的 `FREEZE_ANIMATIONS_SCRIPT`）：一次执行做两件事，缺一不可。
  - 幂等插入 `<style id="dsh-e2e-freeze">`，内容为 `*,*::before,*::after{animation:none!important;transition:none!important}`；
  - 遍历 `document.getAnimations()` 逐个 `pause()`。
  - 两句缺一不可的依据：`animation:none` 只约束声明式动画，对 `element.animate()`（Web Animations API）无效；`pause()` 只停当下已存在的动画，换文档后会被重新拉起。
    旧页面实测只插 CSS 仍为 175.4%，两者都做才降到 5.3%（对照不冻结 193.5%，30 秒采样）。
  - 2026-11-20 用本插件的 `freezeAnimations` 在 DSH GUI 上复测（4 个与 `_dsh-state-dot-spin` 同构的 CSS keyframes 无限动画，20 秒采样）：
    不开冻结 `cssAnimationsRunning: 4`、2.98 CPU 秒（14.9% 单核）；开启冻结 `cssAnimationsRunning: 0`、0.27 CPU 秒（1.3% 单核）。
    注意 `animation:none` 对导航之后用 `element.animate()` 新建的 WAAPI 动画无效——这类负载只能靠 `pause()` 在下次 `domcontentloaded` 时收掉，
    因此「导航后立刻用 WAAPI 造动画」的场景不会当帧生效，这是已知边界。
- **自动重放**：冻结挂在 `lib/page.js` 的 `attachPageHooks` 里 `page.on('domcontentloaded')`，不是挂在 `navigate` 上。
  这样 CDP 接管页、用户手工刷新、`browser_e2e_recipe` 步骤内的 `goto` 都能覆盖；回调内不 await，失败只回到不冻结的占用，不影响导航结果。
- **接管页补冻**：CDP 分支在登记完 `context.pages()` 后调用一次 `freezeAllAdopted`——接管页多半早已 load 完，不会再触发 `domcontentloaded`。
- **返回**：首次启动的摘要后追加一行「已开启动画冻结：每次换文档后自动注入禁用 animation / transition 的样式并 pause 现存动画。要复现或验证动画本身时，请传 freezeAnimations=false 关掉。」
- **不是启动参数而是会话字段**：`reducedMotion` 不作为替代方案。Playwright 1.63 确有 `newContext({ reducedMotion })`，它只声明 `prefers-reduced-motion` 偏好；
  实测`reduce` 下 `matchMedia` 返回 true，而纯 CSS keyframes 动画**依然 running**。站点是否响应由页面自己决定，不能作为省 CPU 的保证。

## 边界

- 只冻结动画与 transition，不撤已注入的样式：关闭开关后已注入页保持现状，只是后续换文档不再冻结（撤样式要逐页动 DOM，收益不抵风险）。
- 冻结失败（页面正在关闭、正在换文档、脚本被 CSP 拦截）一律吞掉：`freezeAnimations()` 返回 `{ ok: false, error }`，不抛给导航与页登记。
- `about:blank` 等无 `document.head` 的文档：脚本回落到 `document.documentElement` 挂样式，不会因缺 head 报错。
- 不处理：需要复现动画本身（验证 spinner 行为、量动画时长、测 transition 效果）的场景必须传 false——冻结会让这些断言恒假。
- 不影响事件环、ref 表、快照基线：只往 DOM 塞一个 style 并停动画，不触碰页面其它状态。
- **已知局限（2026-11-21 实测确认）**：冻结只作用于 `domcontentloaded` 时**已存在**的动画。
  在已冻结的页面上用 `element.animate()` **新造**的动画不受约束，仍是 `playState === 'running'`
  （对照页实测同样 running=1，两者一致）。原因是注入的 `animation: none` 只影响新声明的 CSS 动画，
  WAAPI 的 `Animation` 对象已在内存里、不是 DOM 声明。要连它一起停，需要在每次 `domcontentloaded`
  重放时遍历 `document.getAnimations()` 逐个 `pause()`——当前实现**已经**这么做，但那只覆盖
  重放那一刻的动画集合；重放后新造的仍拦住。
  `tests/freeze.mjs` 已把这条行为写成显式断言（「已知局限：冻结页上新造的动画不受约束」），
  避免 `running === 0` 被误读成「能拦住任何新动画」。

## 验收

- `node tests/freeze.mjs`：exit 0、无 FAIL。覆盖
  1) 不传参数时 `getAnimations()` 与真实页一致（未注入 `#dsh-e2e-freeze`）；
  2) `freezeAnimations: true` 启动后，首个标签页存在 `#dsh-e2e-freeze`；
  3) **阴性对照**：同一段造动画脚本在不冻结的对照页上必须留下 `running >= 1`（证明断言不是平凡真）；
     换文档后样式已注入、页面无残留 running 动画；
     且把「冻结页上新造的动画仍 running」这一已知局限固定为断言；
  4) 已启动会话再传 `freezeAnimations: false` 返回关闭文案，且后续导航不再注入新的冻结（既有注入保留）；
  5) 复用路径传 `freezeAnimations: true` 返回「已开启动画冻结」文案。
- 进程口径按仓库惯例：断言回落到运行前基线，不看绝对值。
