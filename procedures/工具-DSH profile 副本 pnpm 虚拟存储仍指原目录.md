# 工具-DSH profile 副本 pnpm 虚拟存储仍指原目录

> **触发**：复制 DSH profile 目录做 CLI 验证副本后，`dsh plugin --profile <副本> add` 报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`；删掉包目录再 `install` 又报 `Already up to date`、包没装回来
> **锚点**：`ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`、`virtualStoreDir`、`.modules.yaml`、`dsh plugin --profile`、`Already up to date`、`--force`
> **验证**：`Get-Content "<副本>\node_modules\.modules.yaml"` 里 `virtualStoreDir` 指向副本自身；`dsh plugin --profile <副本> install --force` 后目标包出现在副本的 `node_modules` 下

## 首选

把副本 `node_modules/.modules.yaml` 的 `virtualStoreDir` 改成副本自身路径，然后删包目录并强制 install：

```powershell
# 1) 编辑副本的 node_modules\.modules.yaml，把 virtualStoreDir 改成副本自己的 node_modules\.pnpm 路径
# 2) 删掉目标包目录后强制重装
dsh plugin --profile <副本> install --force
```

## 被挡时

- 不保留副本的 `node_modules`：整份删掉后从零 `install`，让 pnpm 按新路径重建（代价是重新下载；**未验证**）。

## 别再来

| 弯路 | 为什么不通 |
| --- | --- |
| 复制完 profile 直接对副本跑 `dsh plugin --profile <副本> add` | 副本的 `.modules.yaml` 仍记着原 profile 的绝对 `virtualStoreDir`，pnpm 判定存储位置不一致，报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` |
| 删掉包目录再跑 `install` | pnpm 认为 lockfile 与已装状态一致，报 `Already up to date`，不会把删掉的包补回来 |
| 改完 `.modules.yaml` 后仍不加 `--force` 直接 install | 同上，已装状态判定挡住重装；必须强制 |

## 注意

- 根因是绝对路径被写死：pnpm 的 virtual store 路径记录在 `node_modules/.modules.yaml` 的 `virtualStoreDir` 字段，复制目录后它仍指向原 profile。
- 判据：先读 `.modules.yaml` 的 `virtualStoreDir` 是否等于副本路径，再决定改文件与加 `--force`。
- 只对副本验证环境做这件事，不要对真实 profile 做同样操作。

证据：2026-11-08 会话，`dsh plugin --profile <副本> add` 报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`、删包后 `install` 报 `Already up to date`（原 inbox 条目）。
