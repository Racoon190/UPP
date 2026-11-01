# 20 · uppgui：本地 GUI + agent 控制面

> 一句话：把 `upp` / `uppenv` / `upptool` / `uppmem` 收进一个本地面板（只听 `127.0.0.1` + token），普通用户双击 exe 就能用，agent 通过 `uppgui --mcp` 的两个工具拿到**同一份 action catalog**——人看得见、模型买得起。

- 状态：v1.5 已实现并真机跑通（2026-11-01，Windows 11，Node v26.12.0；版本 **upp 1.5.0 / uppgui 1.5.0**，`uppgui status` 会打印三端工具链版本）
- 入口：`upp/tools/uppgui.mjs`（CLI）+ `lib/uppgui/{actions,server,mcp}.mjs` + `lib/uppgui/ui/`（原生 HTML/CSS/JS，零运行时依赖、无 CDN）
- 打包：`node tools/build-gui.mjs` → `dist/uppgui.exe`（Node SEA 单文件）、`dist/payload.zip`、`dist/upp-gui-<version>.zip`、`dist/UPP-GUI-Setup-<version>.exe`
- 验收：`node tools/test-uppgui.mjs` 共 75 项检查（静态、catalog、HTTP、MCP、打包 + 36 个 action smoke + 5 项换机向导），全部 PASS（约 12 s）

## 1. 为什么有 GUI

三端（DSH / WorkBuddy / Accio）装的东西散在插件、技能、MCP、工具、记忆五个盘子里：CLI 记得住命令，但**看不见现状**，也**不敢乱点危险操作**。GUI 补的是三件事：

1. **一眼看全**：一个页面同时呈现三端各自的插件、技能、MCP、工具、记忆；`status` / `doctor` 把「能不能用」变成红绿点。
2. **危险操作要二次确认**：`mem.rm`、`env.import`、`env.rollback`、`plugin.install/pack`、`mem.sync` 标记 `danger:true`，UI 会先确认再发请求；CLI/agent 走同一套 action，不会有人绕过确认。
3. **给 agent 一个便宜的入口**：MCP 只暴露 `upp_action` + `upp_catalog` 两个工具，models 不需要背 36 个 schema（实测 `tools/list` 仅 1348 字节）。

它不联网、不装依赖、不改系统代理；唯一监听的地址是 `127.0.0.1`。

## 2. 三种用法

> 鉴权只保护数据、不保护壳：`/`、`/index.html`、`/app.js`、`/style.css`、`/favicon.ico`、`/api/ping` 公开（纯代码/健康检查，ping 还带 `noAuth`/`tokenRequired` 两个标志），`/api/catalog|status|action|log` 才要 token——浏览器取子资源不再 401 白屏；token 泄露只暴露空壳，任何动作仍要 token。

### 2.1 双击 exe（普通用户）

`UPP-GUI-Setup-<version>.exe` 与 `uppgui.exe` 是同一份二进制，只是名字更友好；先在便携目录里双击 `install.cmd`（或跑 `uppgui.exe --install`），开始菜单/桌面就会出现 `UPP GUI` 快捷方式。双击快捷方式：后台起服务、自动打开默认浏览器（URL 自带 `?token=…`）。

端口**固定 7799**（被占用就顺延到 7800…7808），所以书签可以长期用一个地址；再次双击只会复用已在跑的实例，不会堆出第二个。关掉浏览器标签只是断开页面，服务仍在；停止用 `upp gui stop`。

```bash
# 无管理员、无网络的静默安装（自定义目录）
dist\uppgui.exe --install --silent --dir "%LOCALAPPDATA%\UPPGUI"
```

### 2.2 浏览器 URL（开发者）

```bash
upp gui start            # 后台启动（固定端口 7799），打印带 token 的 URL
upp gui url              # 当前实例的 URL，脚本里可直接用
upp gui open             # 没起就起、起了就开浏览器
upp gui stop             # 停掉后台实例（校验 ping 已停）
upp gui status --json    # 健康检查：ok/port/url/ping/pid
node tools/uppgui.mjs serve --port 7799 --no-open --json   # 前台跑，Ctrl+C 退出
```

`--port 0` 仍然可用（让内核挑空闲端口，适合 CI）；`--json` 只打印一行 JSON。`--no-auth` 仅用于本机自检，默认不要用。

### 2.3 挂给 agent（MCP）

```bash
# 任何支持 MCP stdio 的宿主（DSH 等）
uppgui --mcp
node tools/uppgui.mjs mcp
```

传输是**换行分隔的 JSON-RPC 2.0**（stdout 走协议、stderr 走日志），协议版本 `2024-11-05`，`serverInfo.name = "uppgui"`。agent 用 `upp_catalog` 查 id、用 `upp_action` 执行，读操作优先、写操作先 dry-run。

## 3. 工作区（catalog 驱动，实测 6 组 + 日志控制台）

导航不是写死的：`/api/catalog` 返回什么，左侧栏就渲染什么。实测 6 个 action 组，加底部日志控制台共 7 个可视区。

| 可视区 | 组 id | actions | 主要用途 |
|---|---|---|---|
| 概览 | `overview` | `status` `doctor` | 三端连通性、版本、体检 |
| 记忆 | `memory` | `mem.*`（11 个） | 共享记忆的增删改查、同步、宿主安装 |
| 工具 | `tools` | `tool.*`（6 个） | 工具注册表浏览、推荐、试跑 |
| 环境镜像 | `env` | `env.*`（7 个） | 扫描、导出/导入、校验、回滚 |
| 换机 | `migrate` | `migrate.*`（5 个） | 旧机打包 → 新机核对 → 预演 → 事务导入回滚 |
| 插件 | `plugin` | `plugin.*`（6 个） | 识别、初始化、校验、打包、安装 |
| 日志控制台 | — | `GET /api/log` | 每 2s 轮询，按 level 过滤，可暂停 |

## 4. action 目录（36 个 / 6 组，实测）

`catalog()` 是唯一事实来源：UI、HTTP `/api/catalog`、MCP `upp_catalog`、CLI `uppgui catalog` 都从它生成。下表每个 id 后是它的关键参数（`*` 为必填；`danger` 见 §9）。

| 组 | actions（关键参数） |
|---|---|
| `overview` | `status`；`doctor`（`timeoutMs`） |
| `memory` | `mem.list`（`kind` `tag` `limit`）；`mem.search`（`query*` `kind` `limit`）；`mem.get`（`ref*`）；`mem.add`（`text*` `kind` `key` `tags`）；`mem.update`（`ref*` `text` `kind` `tags`）；`mem.rm`（`ref*`，danger）；`mem.stats`；`mem.sync`（`hosts` `direction` `dryRun`，danger）；`mem.install`（`hosts` `remove` `dryRun`）；`mem.hosts` |
| `tools` | `tool.list`（`tag` `kind` `q`）；`tool.show`（`id*`）；`tool.suggest`（`text*` `limit`）；`tool.run`（`id*` `args` `timeoutMs` `input` `cwd`）；`tool.add`（`path` `name` `runtime` `command` `tags`）；`tool.stats` |
| `env` | `env.scan`（`hosts` `kinds`）；`env.export`（`out` `hosts` `kinds` `sign` `probeTools`）；`env.import`（`file*` `dryRun` `onConflict` `requireSignature`，danger）；`env.verify`（`file*` `requireSignature`）；`env.inspect`（`file*`）；`env.rollback`（`tx`，danger）；`env.tools`（`hosts` `live`） |
| `migrate` | `migrate.plan`（`hosts` `kinds`）；`migrate.pack`（`out` `hosts` `kinds` `sign` `probeTools` `force`）；`migrate.card`（`file*`）；`migrate.preview`（`file*` `hosts` `kinds` `onConflict` `requireSignature`）；`migrate.apply`（`file*` 等同上，danger） |
| `plugin` | `plugin.detect`；`plugin.init`（`id*` `dir`）；`plugin.validate`（`pkg*`）；`plugin.verify`（`pkg*` `hosts`）；`plugin.pack`（`pkg*` `out`，danger）；`plugin.install`（`from*`，danger） |

`brief` 是默认值：数组最多 10 条、长字符串 200 字符，命中时顶层 `truncated:true`；需要全量就传 `full:true`（HTTP body 或 MCP 参数）。参数校验很硬：未知 action / 未知参数 / 缺必填都会返回 `ok:false + hint`，`hint` 里直接给出可用 id 或参数名。

### 4.1 换机向导（v1.5 新增，5 步）

`migrate` 组把「换电脑」做成向导：`migrate.plan` 只读体检（3 端探测 + 资产统计 + 推荐参数 + `steps[]`），UI 按 `steps[]` 渲染进度条。

1. `migrate.pack`：导出 `.uppenv` 并生成交接卡（文件、大小、sha256、签名指纹、下一步）。
2. 手动拷文件到新机器（U 盘 / 网盘 / scp），顺手核对 sha256。
3. `migrate.card`：核对大小/哈希/签名；坏镜像返回 `valid:false + problems`，拒绝导入。
4. `migrate.preview`：零写入 dry-run，每个资产给出 create/update/noop/skip。
5. `migrate.apply`：事务导入，返回 `tx` 与 `upp env rollback <tx>`。

`migrate.pack` 的 id 虽以 `.pack` 结尾，但只写新文件、不改宿主，是 danger 后缀规则唯一的 allowlist 例外（见 `CONTRACT.md` §1）；真正改宿主的是 `migrate.apply`（`danger:true`）。

## 5. HTTP API（全部只绑 127.0.0.1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 公开：`{ok, app:"uppgui", version, actionCount, uptimeMs, pid, noAuth, tokenRequired}` |
| GET | `/api/catalog` | 分组 catalog（verbose，带 args 描述） |
| GET | `/api/status` | 等价于跑一次 `status` action |
| POST | `/api/action` | body `{action, params?, full?}` → action envelope |
| GET | `/api/log?since=<seq>` | 增量日志 `{ok, next, events:[{seq,ts,level,msg}]}`，环形 500 条 |
| GET | `/`、`/app.js`、`/style.css` | 静态 UI，来自 `lib/uppgui/ui/` |

鉴权：除 `--no-auth` 外，`/api/catalog`、`/api/status`、`/api/action`、`/api/log` 要带 token——`X-UPP-Token: <token>` 或 `?token=<token>`；缺/错返回 HTTP 401 + `{ok:false,error:"unauthorized"}`。静态壳与 `/api/ping` 公开（见 §2），所以浏览器子资源不会 401 白屏。action 业务失败仍返回 HTTP 200，用 envelope 里的 `ok` 区分，方便前端/agent 统一处理。

```bash
curl -s -H "X-UPP-Token: $TOKEN" http://127.0.0.1:64536/api/ping
curl -s -H "X-UPP-Token: $TOKEN" -H "content-type: application/json" \
  -d '{"action":"mem.list","params":{"limit":5}}' http://127.0.0.1:64536/api/action
```

## 6. MCP：只给两个工具

| 工具 | 输入 schema | 输出 |
|---|---|---|
| `upp_action` | `{action:string, params?:object, full?:boolean}`，`required:["action"]` | action envelope 的 JSON 文本 |
| `upp_catalog` | `{}`（无参数） | `{count, groups:[{id, actions:[{id, args, danger}]}]}` 极简版 |

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"upp_action","arguments":{"action":"mem.search","params":{"query":"upp","limit":3}}}}
```

返回 `result.content[0].text` 是 envelope JSON（`ok/data/truncated/tookMs`）。`tools/list` 的每个工具都带 `inputSchema`，但**只有两个**——这是 token 设计：36 个 action 的名字/参数通过 catalog 现查，不常住上下文。

## 7. 安装与卸载

- 安装根目录优先级：`--dir <path>` > `UPPGUI_HOME` > `%LOCALAPPDATA%\UPPGUI`；payload 解到 `<root>/app`，只有 `.payload.json` 的 `version + sha256` 都与已装的一致、且 `server.mjs` 还在时才跳过解包，否则整目录重解。
- 注册表（仅当前用户，HKCU，无需管理员）：`Software\Microsoft\Windows\CurrentVersion\Uninstall\uppgui`，写入 `DisplayName / DisplayVersion / InstallLocation / UninstallString / DisplayIcon`，控制面板可见。
- 快捷方式：开始菜单 + 桌面 `UPP GUI.lnk` 指向 `<root>\uppgui.exe`；`--silent` 只输出一段 JSON 摘要，适合脚本。
- 卸载：`uppgui.exe --uninstall [--dir P]` 删快捷方式、注册表项、payload 与安装目录；正在运行的 exe 通过 `%TEMP%` 批处理延迟自删。

```bash
dist\uppgui.exe --install --silent --dir D:\Tools\UPPGUI
dist\uppgui.exe --uninstall --dir D:\Tools\UPPGUI
```

## 8. token 经济性（真机实测字节数）

| 项 | 实测 |
|---|---|
| MCP `tools/list` 全量响应 | **1348 B**（2 个工具，远低于 4096 B 预算） |
| MCP `upp_catalog` 返回文本 | **2519 B**（36 个 id + 参数名 + danger） |
| HTTP `/api/catalog`（verbose，带描述） | **13805 B**（只给 UI 用，不进模型上下文） |
| HTTP `/api/ping` | **122 B**（含 `noAuth`/`tokenRequired`；pid/uptime 位数浮动 1–2 B） |
| `mem.list` brief（13 条记录） | **1708 B**（截到 10 条，`truncated:true`） |
| `mem.list` full（13 条记录） | **2140 B**（多 432 B，换全量） |
| `tool.list` / `env.scan` 典型响应 | 166 B / 96 B |
| `migrate.plan` / `migrate.card` 典型响应 | **1348 B** / **417 B**（plan 含 `steps[]` 向导） |

结论：agent 侧常驻成本 = `tools/list` 1348 B；一次目录查询 2519 B；一次典型 action 响应 0.1–2 KB，brief 默认值让「列 13 条」比全量省 ~20%。catalog 的 verbose 版只服务浏览器，**不会**被塞进模型上下文。

## 9. 安全模型

- **只听 127.0.0.1**：`server.listen(port, '127.0.0.1')`，不绑 `0.0.0.0`，局域网/公网连不上。
- **token**：默认 `crypto.randomBytes(16)` 32 位 hex，URL query 与 `X-UPP-Token` 二选一；`--no-auth` 明确 opt-in，仅自检/离线演示用。
- **无网络**：UI 没有 CDN、字体、图片外链（图标是内联 SVG sprite），运行期不发起任何出站请求。
- **危险操作二次确认**：`danger:true` 的 action 在 UI 里必须先确认；HTTP/MCP 层照常执行但 envelope 带 `note:"mutating action"`，agent 应先 dry-run。
- **可回滚 / 需确认**：`env.import` 由 `uppenv` 事务化（返回 `tx`），`env.rollback` 默认 `--last` 撤销最近一次；`mem.install{remove:true}` 反向撤销宿主挂载；`plugin.install` 走 `upp install` 自带的校验与备份；`mem.rm` 是**硬删除**（danger，UI 必须二次确认），删完重建 memory 索引。
- **镜像完整性**：payload 哈希 + canonical zip 布局能挡住内容损坏、越界元数据和尾部追加（`migrate.card` 会报 `trailing data` 并拒绝导入）；但 zip 元数据内部的位级改动只有 ed25519 签名覆盖——`migrate.pack {sign:true}` 会对整文件写 `.sha256` + `.sig.json`，不可信传输请用签名镜像，并配合 `--require-signature` 导入。
- **状态文件**：`~/.uppgui/last-server.json` 只存 port/token/url/pid，便于 `uppgui status` / `open` 复用实例，不存业务数据。

## 10. 已知边界

- **ESM / SEA**：payload 是一张 ESM 图，SEA 宿主用 `require(esm)` 加载，图里不能有 top-level await（`tools/uppgui.mjs` 因此把启动逻辑放进 `main()`）；`build-gui --skip-sea` 只打 `payload.zip`，用于快速验证。
- **端口**：默认固定 `7799`（`UPPGUI_PORT` 可改），被占时顺延到 7808；已有实例在跑就直接复用并打印它的 URL，`--force` 才另起。显式 `--port N` 表示「就要这个实例」，不会被复用逻辑接管。
- **杀软误报**：单文件 SEA exe 未签名，Windows SmartScreen/部分杀软会拦首次运行；需手动「仍要运行」或加排除目录。
- **brief 截断**：默认 10 条 / 200 字符，看全量要 `full:true`；`doctor` 例外（`brief:false`），体检表永远给全 13 行，否则失败项会被数组上限挡掉。日志环形缓冲只保留 500 条。
- **单实例状态**：多个 `serve` 会互相覆盖 `last-server.json`，`open`/`status` 以最后一次为准；需要多实例请显式指定 `--port` 和 `--token`。
- **UI 是薄壳**：没有框架、没有构建步骤，页面能力完全由 catalog 决定；新增 action 只要在 `actions.mjs` 注册，UI 自动出现入口，但复杂交互（如批量编辑）仍要回到 CLI。
