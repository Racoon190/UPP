## UPP GUI — Windows 版

下载下面任意一个即可：

- **UPP-GUI-Setup-{{VERSION}}.exe**（推荐）— 双击安装，开始菜单/桌面出现 UPP GUI，之后双击即用；`--install --silent` 可静默安装，`--uninstall` 卸载。
- **upp-gui-{{VERSION}}.zip** — 便携版，解压后直接运行 `uppgui.exe`，不写注册表。

安装后的三种入口：

| 入口 | 怎么用 | 给谁 |
|---|---|---|
| 图形界面 | 双击 UPP GUI | 不想敲命令的人 |
| CLI | `node tools/uppgui.mjs`（仓库内） | 开发者 |
| MCP | `uppgui.exe --mcp` | agent（仅 2 个工具，catalog 1274 字节） |

换了机器？GUI 里的「换机」向导把打包 → 传输 → 校验 → 预演 → 导入串成 5 步，导入是事务，出错可一键回滚。

版本与资产由 tag `upp-v{{VERSION}}` 自动构建（`.github/workflows/release.yml`）。源码与文档见仓库根 `README.md` 与 `docs/20-uppgui.md`。
