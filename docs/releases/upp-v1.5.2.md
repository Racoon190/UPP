## UPP 1.5.2 — 图形界面「找得到、连得上、停得掉」

1.5.x 的 GUI 一直是「起在随机端口、URL 只打印一次」：关掉浏览器标签、重启电脑、或者随手关掉那个黑框，之前存的书签就变成 `ERR_CONNECTION_REFUSED`——这次把这层体验补齐。

### 固定端口 + 生命周期命令

- **默认端口固定 `7799`**（被占用自动顺延 `7800…7808`），书签可以长期用同一个地址。
- **重复启动自动复用**：已经在跑就只把浏览器打开到现有实例，不会后台堆出第二个服务。
- 新增 `upp gui` 子命令（也可直接用 `uppgui`）：

```bash
upp gui start          # 后台启动（关终端也不退），打印带 token 的 URL
upp gui url            # 当前实例地址（脚本里可直接取）
upp gui open           # 没起就起，起了就开浏览器
upp gui stop           # 停掉后台实例，并校验 ping 已停
upp gui status --json  # ok / port / url / ping / pid
```

- 双击桌面快捷方式 = `upp gui start` 语义：后台起服务 + 开浏览器，**不再留一个关掉就断服务的控制台窗口**。
- `upp doctor` 新增 `cli.gui` 检查；`upp setup-cli` 现在会把 `uppgui` 一起装进 `~/.upp/bin`，所以 `upp gui ...` 在任何目录都可用（仓库搬走也不影响）。

### 顺带修掉的三处

| 问题 | 修法 |
|---|---|
| `upp doctor` 从已安装 shim 运行时 `cli.version` 恒为 `1.5.x != null` | 没有 checkout 时回退用已安装副本的版本比较 |
| `upp gui status` 偶尔报 `This operation was aborted`（冷启动第一请求丢 2.5 s 竞速） | ping 改为 3 次重试（2.5 s → 4 s，带 `connection: close`） |
| `uppgui version` 只打印帮助、退出 2 | 补上 `version` 子命令，供 `doctor` 探测 |

### 升级

```bash
git pull && node tools/upp.mjs self-update && upp --version   # 1.5.2
```

已经装了 GUI 的机器：下新 `UPP-GUI-Setup-1.5.2.exe` 覆盖安装一次（安装目录 `%LOCALAPPDATA%\UPPGUI`），之后双击图标就是固定端口 + 后台常驻。

### 质量门槛

`node tests/run-all.mjs` → 18/18；`test-uppgui` 76、`test-uppmem` 34、`test-upptool` 22、`test-uppenv` 50、`test-roundtrip` 30。
