# UPP v1.5.3

修好**安装版**（打包 exe / SEA）里「体检无数据」这个真 bug，并把安装链路的自检做扎实。

## 修了什么

- **SEA 模式误判**：打包后 payload 目录恰好等于 payload 内的仓库根，`server.mjs` 用路径比较判断运行模式 → 把自己当成开发态，于是所有走 CLI 的 action（doctor / status / env / plugin …）都拿脚本路径去 spawn 自己的 exe，boot 把路径当子命令，打印 uppgui 帮助并 `exit 2`。GUI 里表现就是「共 0 项检查 / 暂无数据」。现在改用 `node:sea` 的 `isSea()` 判定（`createRequire` 兼容 ESM 与旧版 Node），开发态/安装态各走各的路径。
- **体检表被截断**：`brief` 默认只保留 10 条，13 项检查里若有失败被裁掉还会误报「全部通过」。`doctor` 现在 `brief:false`，v1.5.3 安装版实测显示 13 行、「1 项告警」（Accio 没启动）。
- **子工具链探测**：`upp doctor` 在 SEA 内改用 `exe --cli <tool> version` 探测 `uppenv/upptool/uppmem/uppgui`，不再用脚本路径 spawn。
- **第三方 CLI 探测**：WorkBuddy / Accio 的 JS CLI 改用 PATH 里的 `node`（`UPP_NODE` 可覆盖），打包进程不再拿自己当 Node 跑别人的脚本。
- **显式端口不复用**：`serve --port 7811` 不再被「已有实例在 7799」拦下，`--force` 语义保持不变。

## 升级

    upp self-update && upp setup-cli
    upp gui stop && upp gui start

已装旧版也可以直接下载新的 Setup 覆盖安装。

## 验证

- `tests/run-all.mjs` → 18/18；`tools/test-uppgui.mjs` → 76 passed / 0 failed。
- 安装版实测：本地 `%LOCALAPPDATA%\UPPGUI\uppgui.exe` 起在 7799，GUI「体检」显示 13 项、12 通过、1 项告警（Accio 未启动）；`/api/action doctor` 返回 `code:0 checks:13`。
- 资产（CI 构建）：`UPP-GUI-Setup-1.5.3.exe`、`upp-gui-1.5.3.zip`。
