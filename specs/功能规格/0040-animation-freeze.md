# 动画冻结与动态守护

状态: 已实现
关联: specs/功能规格/0002-browser-launch-and-reuse.md（启动与复用）；specs/功能规格/0008-cdp-attach.md（接管页同样适用）；specs/项目规格/0001-architecture-invariants.md（会话状态机、模块表、依赖方向）
代码: lib/animation-guard.js / lib/page.js / lib/session.js / lib/tools.js / tests/freeze.mjs / tests/animation-guard.mjs

## 需求

无限 CSS 动画会让整页每帧重绘。在节点多、内联样式大、带整屏 canvas 的页面上（实测 DSH GUI：1557 个节点、约 1MB 内联 CSS、1320×860 canvas），
会话行上一个小小的「进行中」旋转点就能把空闲占用从约 71% 拉到 167.8% 单核；Playwright 又默认带
`--disable-renderer-backgrounding` / `--disable-backgrounding-occluded-windows`，headless 下该动画永不节流。

验证工作通常不需要动画：给 `browser_e2e_start` 一个开关，让插件在每次换文档后自动停掉动画，把占用压回基线。

一次性冻结（只在 `domcontentloaded` 那一刻 `pause()`）拦不住之后新造的动画，已被实测确认并写进旧版「已知局限」。
本规格因此把它升级为**持续守护**：只要开关开着，任何时刻新出现的动画都被就地拦住，且关掉开关是**真正撤守**。
实测依据见 `docs/需求-动画动态守护.md` 第 1 节的六行对照表（后插 `!important` 样式、`element.animate()` 新造 WAAPI 都会跑掉，
补一次全量 `pause()` sweep 或 patch `Element.prototype.animate` 后归零；1512 节点下单次 `getAnimations()` 耗时 0.039ms）。

## 行为

- **入口与参数**：`browser_e2e_start` 的 `freezeAnimations`（boolean，默认 false）。
  - 首次启动时写入会话字段 `session.freezeAnimations`，并立即对刚登记的首屏页装机守护（`installAnimationGuard`）。
  - 已启动（复用）时传该参数**就地切换**，不必重开浏览器：开启时对全部已登记标签页装机，返回
    「已开启动画冻结，并对当前 installed/tabs 个标签页装机动画守护（禁用样式 + 拦截 element.animate + 每 250ms 复查）」；
    关闭时对全部已登记标签页撤守，返回
    「已关闭动画冻结，并对当前 removed/tabs 个标签页撤守（已移除禁用样式、还原 Element.prototype.animate、停止周期复查）；已暂停的动画保持暂停，新造动画恢复运行」。
    浏览器尚未启动时返回「浏览器尚未启动，freezeAnimations 将在下次 browser_e2e_start 生效」。
- **守护脚本**（`lib/animation-guard.js` 的 `ANIMATION_GUARD_SCRIPT`，四件套缺一不可）：
  1. **幂等样式守卫**：插入 `<style id="dsh-e2e-freeze">`，内容为
     `*,*::before,*::after{animation:none!important;transition:none!important}`，挂在 `document.head || document.documentElement`；
     页面把它删掉后下一轮 sweep 补回。
  2. **`Element.prototype.animate` patch**：先调原始函数，再对返回对象里 `playState` 为 `running` / `pending` 的动画
     `pause()`，**返回同一个 Animation 对象**（不包装、不复制），并用 `Object.defineProperty` 让包装函数的 `name` / `length`
     与原函数一致。只对 `running` / `pending` 下手，已 `paused` / `finished` / `idle` 的不动。
  3. **周期 sweep**：`setInterval(sweep, GUARD_SWEEP_INTERVAL_MS)`（250ms），每轮补样式 + 遍历 `document.getAnimations()`
     把 `running` / `pending` 的 `pause()`。它兜住 patch 拦不到的两条路：`new Animation(new KeyframeEffect(...))` 直接构造，
     以及页面自插更高优先级的 `!important` 样式。
  4. **撤销路径**（页内哨兵 `window.__dshE2eAnimGuard.state.dispose()`）：`clearInterval` →
     按 id 再查一次并移除 `#dsh-e2e-freeze`（兜住页面复制的同名节点）→ 若 `Element.prototype.animate` 仍是本插件装的那一个
     则还原为原始函数（恒等比较，绝不覆盖第三方 patch）→ 删哨兵。
  - 幂等哨兵 `window.__dshE2eAnimGuard`：重复装机只补样式与 sweep，不叠 interval、不二次 patch。
  - 脚本首行 `if (window.top !== window) return { skipped: 'child-frame' }`：**只覆盖主文档**，同源与跨源子 frame 一律不 patch
    （`addInitScript` 在每个 frame 都执行，必须自带这个判定）。
- **自动重装（四路覆盖，换文档后不会掉）**：
  - A `page.addInitScript({ content: ANIMATION_GUARD_SCRIPT })`：文档创建后、页面脚本运行前注入，**无空窗**；
    navigate / reload / 页面自跳全自动。返回的 `Disposable` 存进按 page 的 WeakMap 句柄。
  - B `page.on('domcontentloaded')`：`lib/page.js` 的 `attachPageHooks` 兜底与自愈，覆盖 init script 竞态、样式被页面删除、
    用户手工刷新、CDP 新开页。
  - C `installAdoptedGuards(session)`：CDP 接管页早已 load 完、不会再触发 `domcontentloaded`，必须对当前文档补装一次。
  - D recipe 内的 `goto`：`lib/recipe.js` 的 navigate 步调 `page.js` 的 `navigate` → `page.goto`，走 A/B，`recipe.js` 零改动。
- **关闭开关 = 真正撤守，四步顺序固定**：
  1. `disposable.dispose()` —— 撤掉 `addInitScript`，保证后续导航不再重装（不做这步，撤了当前页也会在下次导航复活）；
  2. 页内 `ANIMATION_GUARD_DISPOSE_SCRIPT` —— 清定时器、移除样式、还原原型；
  3. `guards.delete(page)`；
  4. 逐页试到底：单页失败不阻断其它页，也不让开关本身失败。
- **已 pause 的动画不主动 resume**：声明式 CSS 动画在 `animation:none` 移除后由浏览器按层叠重新创建，自动恢复 running，不需要我们 play；
  主动恢复 WAAPI 等于替页面做决定（从暂停点继续、时间线与视觉不可预测），且立刻重新耗 CPU——正是关开关想摆脱的。
- **接管页补装**：CDP 分支在登记完 `context.pages()` 后调用一次 `installAdoptedGuards`。
- **查询是纯只读**：`animationGuardState(page)` 只执行 `ANIMATION_GUARD_STATE_SCRIPT`——未装则如实返回 `installed: false`
  （**不替调用方装机**），已装则只做纯 DOM 自愈（`refreshStyle`：样式被页面删掉就补回）再读数。
  它**绝不**调用 `sweep` / `pauseAll`，因此**查询前后页面 running 数完全不变**。
  旧的「查询即确保已装」说法已作废：确保的是**样式在位**，不是「替调用方装机」，更不是暂停动画。
  要装机请显式调 `installAnimationGuard`（它走首次装机语义，该 `sweep` 就 `sweep`）。
  幂等分支同理：重复装机只调 `refreshStyle`，不暂停动画。
- **返回**：首次启动的摘要后追加一行「已开启动画冻结并持续守护：每次换文档后自动注入禁用 animation / transition 的样式、拦截 element.animate 并每 250ms 复查新动画。要复现或验证动画本身时，请传 freezeAnimations=false 关掉（会真正撤守）。」
- **不是启动参数而是会话字段**：`reducedMotion` 不作为替代方案。Playwright 1.63 确有 `newContext({ reducedMotion })`，它只声明 `prefers-reduced-motion` 偏好；
  实测`reduce` 下 `matchMedia` 返回 true，而纯 CSS keyframes 动画**依然 running**。站点是否响应由页面自己决定，不能作为省 CPU 的保证。
- **实测（2026-11-22，真机三组对照）**：见 `.scratch/measure-guard-ab.mjs` 与本文「验收」第 4 条；
  数字按日期记入本节，复跑以 exit code 与脚本输出为准。

## 边界

> **[已过时 2026-11-21]** 只冻结动画与 transition，不撤已注入的样式：关闭开关后已注入页保持现状，只是后续换文档不再冻结（撤样式要逐页动 DOM，收益不抵风险）。
>
> 现在：关闭开关会**真正撤守**——移除样式、还原 `Element.prototype.animate`、清定时器，后续换文档也不再装。
> 变更原因：需求第 2 节明确「开关关闭时必须真正撤守，不能只改标志位」；不撤 `addInitScript` 时撤了当前页也会在下次导航复活，
> 撤守形同虚设。撤守四步与顺序见「行为」。

- 只覆盖主文档：同源与跨源子 frame 都不 patch、不注入样式（脚本首行的 frame 判定）。不要声称能覆盖全部 frame。
- `Element.prototype.animate` 的 patch 可被页面的 `Element.prototype.animate.toString()` 检测出来（`toString()` 无法伪装成 native 代码）。不承诺隐蔽。
- 已 `pause()` 的 WAAPI 动画在撤守时**不主动 resume**（理由见「行为」）；撤守后**新造**的动画恢复 running，这是可验收的判据。
- 严格 CSP（`style-src` 不含 `unsafe-inline`）下样式守卫可能不生效，此时 patch + 250ms sweep 仍然生效，属降级不属失败。
- 守护失败（页面正在关闭、正在换文档、`evaluate` 失败、`dispose` 失败）一律吞掉：`installAnimationGuard` / `uninstallAnimationGuard`
  返回 `{ ok: false, error }`，不抛给导航、页登记与开关本身。`page` 为空是单次入参问题，能力函数返回 `{ ok: false }` 而不抛。
- `about:blank` 等无 `document.head` 的文档：样式回落到 `document.documentElement`，不会因缺 head 报错。
- 不处理：需要复现动画本身（验证 spinner 行为、量动画时长、测 transition 效果）的场景必须传 false——守护会让这些断言恒假。
- 不影响事件环、ref 表、快照基线：只往 DOM 塞一个不可见 `<style>` 并停动画，不触碰页面其它状态。
- **已知局限（2026-11-22 重写，旧说法保留在此前版本的「已知局限」段）**：
  - 后插 `!important` 样式与后建 WAAPI 动画**已被守护收掉**（250ms sweep + `animate` patch），不再是局限。
  - 剩余局限只有四条：① 子 frame 与跨源 iframe 不覆盖；② 严格 CSP 下样式守卫可能不生效（patch + sweep 仍生效）；
    ③ 页面持续 `play()` 与 250ms sweep 会拉锯——每轮 sweep 之间仍可能有至多一个间隔的 running 时间片，不提高 sweep 频率以免抬开销；
    ④ **单轮 TaskDuration 对比会偶发 C 高于 B，这是采样噪声不是 sweep 开销；且真实 GUI 上比夹具上更常见**（2026-11-22 实测定性）：
    - **夹具**（`.scratch/measure-guard-ab.mjs` 的 7 轮交替对照）：C/B 中位数 0.61、逐轮配对 C 胜 6/7，
      第 3 轮出现 **C/B = 3.14 的真实反例**。
    - **真实 DSH GUI**（`.scratch/verify/probe-gui-ab.mjs`，测试环实测，**不是夹具结论**）：
      5 轮里 **2 轮 C > B**，中位数比 **1.0391**（已贴近 1.05 阈值），其中一轮 **C/B = 3.973**。
      即：负载更重、动画更多的真实页面上，反例比自建夹具**更常见、更接近阈值**，方向的稳定性明显更差。
    - **定性证据（为什么不是 sweep 造成的）**：sweep 的单次成本实测 0.002ms（1500 节点 / 4 动画）到
      0.007ms（5000 节点 / 200 动画），10 秒窗口 40 次合计最多 **0.0003s**，比 C/B 实测差分
      （±0.1~0.4s）小三个数量级。且夹具里波动只出现在 B、C 两组（sd ≈ 0.17，跨度 3.9 / 9.5 倍），
      **A 组几乎无波动**（sd 0.0245，跨度 1.33 倍）——噪声来自「首轮安装策略」这一次性动作的时机
      （首帧绘制、JIT、GC），而不是周期性复查。
    - 因此判据只把 `runningMax === 0` 当硬指标（它在夹具与真实 GUI 上都是每轮成立）；
      TaskDuration 只作方向参考，且**必须报告逐轮配对与全部反例**。
      **不要用调大阈值、挑轮次、只报中位数或把反例归因于夹具来掩盖它**——真实 GUI 负载下它确实会出现。
    - 待办（未做，留给后续批次）：若要给 TaskDuration 一个稳定判据，需要把「一次性安装动作」从采样窗口
      里排除（例如安装后先等固定预热期再开始计 TaskDuration），而不是继续加轮数。

## 验收

- `node tests/freeze.mjs`：exit 0、无 FAIL。覆盖
  1) 不传参数时未注入 `#dsh-e2e-freeze`；
  2) `freezeAnimations: true` 启动后，首个标签页存在 `#dsh-e2e-freeze`；
  3) **阴性对照**：同一段造动画脚本在未开守护的页面上必须留下 `running >= 1`（证明断言不是平凡真）；
  4) 守护开启后页面自插 `!important` 样式，等 ≥300ms（一个 sweep 周期）后 `running === 0`；
  5) 守护开启后 `element.animate()` 新造 WAAPI，`running === 0` 且返回对象 `playState === 'paused'`；
  6) 关闭开关后同一脚本 `running >= 1`（真撤守，不是只改标志）；
  7) 换文档四路（navigate / reload / recipe 内 goto / CDP 接管）每路装完守护后造动画 `running === 0`；
  8) 复用路径传 `freezeAnimations: true` 返回「已开启动画冻结」文案。
- `node tests/animation-guard.mjs`：exit 0、无 FAIL。模块级用例见该文件头注释（四件套、幂等、撤守后换文档不复活、
  patch 透明性、事件环与 ref 表不受扰动、CSP 降级二选一）。
- **阴性对照必须存在**：未装守护时同一造动画脚本 `running >= 1`；撤守后同一脚本 `running >= 1`。
- **真机三组对照**（`.scratch/measure-guard-ab.mjs`，同一页面、每轮 10 秒窗口、交替轮 A→B→C × 7 轮、headless Edge）：
  A 不冻结 `runningMax >= 1`（阴性对照）；B 仅冻结（旧行为等价）；C 冻结 + 守护。
  - **硬指标**：C 组 `runningMax === 0`（每轮都成立，与 TaskDuration 噪声无关）。
  - **方向指标**：报告**逐轮配对**（同轮 C 是否 `<= B`）与中位数比，并打印组内 min/max/标准差。
  - **反例必须如实留在输出里**：某轮 C > B 就照原样打印，不重跑、不挑选轮次、不改口径。
    单轮 TaskDuration 绝对值小（10 秒窗口 0.04~0.6 秒），噪声可达数倍，3 轮中位数不足以定方向
    （旧口径实测同一命令两次结论相反：C/B 一次 1.06、一次 0.19）。
- **测试里的 SKIP 不得记成 PASS**：`tests/freeze.mjs` 的 CDP 一路只在 `resolveEdgePath()` 真的返回 null 时才跳过，
  且跳过用独立的 `checkSkip` 计数，结尾输出「通过 X，失败 Y，跳过 Z」，不与通过混在一起。
- 进程口径按仓库惯例：断言回落到运行前基线，不看绝对值。
