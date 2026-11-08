# 测试-裸 Promise 伪造关闭超时触发 unsettled top-level await

> **触发**：写「browser.close() 永挂」的假对象来测关闭超时，测试报 `Detected unsettled top-level await` 后直接退出，后面的用例不执行
> **锚点**：`Detected unsettled top-level await`、`new Promise(() => {})`、`unref()`、`setTimeout`、`clearTimeout`、`closeBrowser`
> **验证**：测试跑到该用例后不再报 `Detected unsettled top-level await`、进程退出码 0；用例结束时清掉定时器，事件循环能自然排空

## 首选

假 close 挂在一个 ref'd 定时器上，用例结束时清掉：

```js
let timer
const hang = new Promise((resolve) => {
  timer = setTimeout(resolve, 60_000) // ref'd：给事件循环留一个句柄
})
// 把 hang 当 browser.close() 的返回值
// ...用例结束后：
clearTimeout(timer)
```

## 被挡时

- 让假 close 接受一个可主动中止的信号（`AbortController`），用例结束时 reject 掉（**未验证**，取决于被测函数是否接受 signal）。

## 别再来

| 弯路 | 为什么不通 |
| --- | --- |
| 用 `new Promise(() => {})` 当永挂的 close | 裸 Promise 不提供任何事件循环句柄；`closeBrowser` 的超时定时器带 `unref()`，两者叠加后没有 ref'd 句柄，顶层 await 永远不落定，Node 报 `Detected unsettled top-level await` 并退出 |

## 注意

- 原因在定时器：被测实现的超时定时器 `unref()` 是为了不拖住进程，但同时意味着「只剩它时进程可以退出」；假 close 必须自己提供 ref'd 句柄。
- 判据：看测试是否在预期位置之后继续执行、进程退出码是否为 0，而不是只看有没有超时文案。

证据：2026-11-08 会话测试写法（原 inbox 条目），报错原文 `Detected unsettled top-level await`。
