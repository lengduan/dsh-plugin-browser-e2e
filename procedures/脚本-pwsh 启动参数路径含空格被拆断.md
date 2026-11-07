# 脚本-pwsh 启动参数路径含空格被拆断

> **触发**：`Start-Process` 给程序传一个值里带空格的参数（如 `--user-data-dir=C:\...\User Data`），程序没报错但行为诡异：旁边冒出个截断名字的新目录（`...\Edge\User`），或者程序说找不到路径、用了默认配置
> **锚点**：`Start-Process`、`-ArgumentList`、`--user-data-dir=`、`User Data`、`Application Data`、`带空格`
> **验证**：启动后读进程完整命令行（`Get-CimInstance Win32_Process`）确认参数是一个整体；再查目标程序自己报告的路径（如 `edge://version` 的「用户配置路径」），看是否完整

## 首选

把每个参数**连同内嵌引号**作为一个字符串传，或者整串自己拼好引号：

```powershell
Start-Process -FilePath $exe -ArgumentList ('--remote-debugging-port=9222 --user-data-dir="' + $path + '"')

# 或
$arg = '--user-data-dir="C:\Users\IT\AppData\Local\Microsoft\Edge\User Data"'
Start-Process -FilePath $exe -ArgumentList $arg
```

## 被挡时

- 改用调用运算符让 PowerShell 自己处理引用：`& $exe "--user-data-dir=$path"`（交互式场景够用，缺点是没法脱离当前会话）。
- 或用 `cmd /c start "" "$exe" "--user-data-dir=$path"`。

## 别再来

| 弯路 | 为什么不通 |
| --- | --- |
| `Start-Process $exe -ArgumentList "--user-data-dir=$path"`，`$path` 含空格 | 值被按空格拆成两个参数，程序只拿到前半截，剩余部分变成位置参数；Edge 因此在旁边建了 `...\Microsoft\Edge\User`（实测 65.3 MB 空 profile） |
| 看到"目录已存在/数据不对"先去怀疑程序 bug | 先看进程命令行与程序自报的路径，80% 是参数在传递层就被拆了 |

## 注意

- pwsh 的 `Start-Process` 不做自动引用：`-ArgumentList` 传单个字符串时，引号必须自己写在值里。
- 症状容易伪装成别的问题。本会话真实表现是：Edge 正常启动、用户看到"登录信息全没了"，实际是它用了截断路径新建的空 profile——不是 profile 损坏，也不是同步丢了。
- 排查顺位：进程完整命令行 → 磁盘上实际被创建/使用的目录（看创建时间）→ 程序自报路径。

证据：2026-11-07 本会话，`...\Microsoft\Edge\User` 创建时间 21:39:32（正是那次 `Start-Process` 的时刻），65.3 MB，子目录只有组件缓存；删除后重传正确引号即正常。
