# 04 · WorkBuddy 宿主适配（`workbuddy`）

> 本文是三份宿主文档之一。术语与契约等级以 [01-spec.md](01-spec.md) 为准，证据见 [09-poc-report.md](09-poc-report.md)，调研原文见 [workbuddy-surface.md](../../research/workbuddy-surface.md)。
> 证据标记：**【已证实】**＝本机实测或源码原文；**【推测】**＝合理外推；**待验证**＝本轮 PoC 未覆盖，见 §8。

---

## 1. 宿主概览

| 项 | 值 | 证据 |
| --- | --- | --- |
| 产品形态 | 腾讯 WorkBuddy 桌面客户端（Windows），CodeBuddy 共享底座；`productName: "WorkBuddy"`，端点 `https://www.workbuddy.cn` | 【已证实】 |
| 客户端版本 | **5.9.3**（`D:/Program Files/WorkBuddy/resources/install-manifest.json` 的 `appVersion`） | 【已证实】 |
| Electron | `D:/Program Files/WorkBuddy/version` = `37.10.3-43` | 【已证实】 |
| 主包 / CLI | `resources/app.asar` 181,996,084 B；CLI `resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs` 9,880,062 B | 【已证实】 |
| MCP 子进程 Node | 系统 `node`（本机 v26.12.0）；包内无宿主托管 Node 时靠 PATH | 【已证实·本机】 |
| 用户数据根 | 主 `C:\Users\Administrator\.workbuddy`；旧/共享 `C:\Users\Administrator\.codebuddy`；Electron userData `%APPDATA%\CodeBuddy CN` | 【已证实】 |
| 用户向扩展 | **Skills + MCP + 连接器（Connector）**，官方文档只宣传这一套；技能市场来自第三方 SkillHub（`lightmake.site`） | 【已证实】 |
| 底座插件系统 | `~/.workbuddy/plugins/`，清单 `.codebuddy-plugin/plugin.json`，7 类贡献点（skills/mcpServers/commands/agents/hooks/rules/lsp）；UI 未暴露入口 | 【已证实】 |
| 内核 | 自研微内核（`grep -aoc cordis app.asar` = **0**），**不是** Cordis；插件 JS 模块经 `hooks/hooks.json` 的 `modules[]` 注册 `register(on)` | 【已证实】 |
| 对 UPP 的意义 | Skills 与 MCP 两条通道都原生支持；MCP 已实测 `✓ Connected`，技能目录可热加载 | 【已证实】 |

---

## 2. 原生安装点（精确路径表）

| 安装点 | 精确路径 | 说明 |
| --- | --- | --- |
| 技能目录（用户主目录） | `C:\Users\Administrator\.workbuddy\skills\<skillId>\SKILL.md` | UPP 安装器落点；watch 热加载 |
| 技能目录（其它根） | `~/.codebuddy/skills-marketplace/skills/`、内置 `…\app.asar.unpacked\resources\plugins\workbuddy-builtin\skills\`（24 个）、`~/.workbuddy/connectors/skills/`、`~/.workbuddy/project-resources/<projectId>/`、插件内 `<plugin>/skills/` | 只读/自管，勿写 |
| 技能索引缓存 | `~/.workbuddy\.skill-list-cache.json`（`version: 6`，含 `scopeKey` 与 `watch.dirs`） | 运行态派生文件，不要手改 |
| 技能开关 | `~/.workbuddy\settings.json` 的 `skillOverrides`（如 `"user-invocable-only"`） | 关闭 ≠ 卸载 |
| MCP（用户级） | `C:\Users\Administrator\.codebuddy\mcp.json` | UPP 合并点；默认空结构 `{"mcpServers":{},"disabledMcpServers":[]}` |
| MCP（项目级） | `<workspace>/.mcp.json` 或 `mcp.json`；`~/.workbuddy/project-resources/<projectId>/mcp.json` | 不在 UPP 写入范围 |
| MCP（插件级） | `<plugin>/mcp.json` 或 `<plugin>/.mcp.json` | 优先级最低（数组靠后者覆盖靠前者） |
| 插件根 | `~/.workbuddy\plugins\cache/<marketplace>/<plugin>/<version>/`；注册表 `plugins\installed_plugins.json`；市场 `plugins\known_marketplaces.json`；启停 `settings.json.enabledPlugins` | 真插件路线，UPP v1 未使用 |
| 权限/沙箱 | `~/.workbuddy\settings.json` 的 `sandbox`（135 条三态 `orderedRules` + 命令前缀 + 网络规则） | `~/.workbuddy/skills/` 等目录已授予读写删全放行 |
| 连接器 | `~/.workbuddy\connectors\` + `.credentials.v3.json` + `.master.key` | P1 候选通道，UPP 未使用 |

**生效机制**

- **技能**：目录落盘即被 watch 扫描，`debounce 3000 ms`（`WATCH_SETUP_DELAY 2000 ms`），**无需重启**。【已证实】
- **MCP**：写 `~/.codebuddy/mcp.json` 后由宿主重读；底座 CLI 会**立即解析并拉起子进程**做健康检查（实测 `upp-hello … ✓ Connected`）；GUI 运行时 `mcp list` 同样 `✓ Connected`，GUI 工具/技能页视觉确认未截图。【已证实·CLI+进程】
- **总闸**：安全中心「工具管控 → MCP → 自定义 MCP」统一开关，关闭后所有自行添加的 MCP 不可调用。【已证实】

**备份与回滚点**

| 点 | 位置 |
| --- | --- |
| 安装器一次性备份 | `~/.codebuddy/mcp.json.upp-bak-orig`（首次写入前复制，之后不覆盖） |
| 安装记录 | `<pkg>/.upp-install.json`（记录 skillDir、mcpConfig、serverName） |
| 宿主自身更新器 | `%LOCALAPPDATA%\@genieworkbuddy-desktop-updater\installer.exe`，只替换 `D:/Program Files/WorkBuddy`，不动 `%USERPROFILE%` 下扩展【已证实·路径布局】 |

---

## 3. UPP → WorkBuddy 映射

| UPP 产物 | WorkBuddy 侧形态 | 落位 | 状态 |
| --- | --- | --- | --- |
| `skills/<id>/SKILL.md` | 原生技能（`name` + `description` 最小集即可） | `~/.workbuddy/skills/<id>/` 整目录复制 | **P0，已实测落盘** |
| MCP server（`serverName`） | `~/.codebuddy/mcp.json` 的 `mcpServers.<serverName>` | 用户级配置合并（只增不删） | **P0，CLI 实测连接成功** |
| `.mcp.json`（插件内声明） | `<plugin>/mcp.json` 或 `.mcp.json` | **仅插件安装时生效**；直接拷技能时被忽略 | P1，待验证 |
| `.claude-plugin/plugin.json` | **WorkBuddy 不读**；真插件只认 `.codebuddy-plugin/plugin.json` | — | P1 待验证 |
| `clis/clis.json` | 无对应扩展点（连接器侧有 `cli.json`，字段不同） | — | P2 |
| `runtime/*` | 无；由 MCP 行 `args` 指向绝对路径 | 包内 | P0 |
| `hooks/hooks.json`（P2 试点） | 插件扩展点 `hooks`：`{ hooks: { <Event>: [{ matcher?, hooks: [{ type: "command", command, timeout }] }] } }` | `<plugin>/hooks/hooks.json` + `plugin.json.hooks = "./hooks/hooks.json"` | **已生成并通过 WorkBuddy 自带 `plugin validate`；桌面端加载需重启后看日志** |

> 关键取舍：UPP v1 在 WorkBuddy 上**只走"技能目录 + 用户级 MCP 配置"**，因为这是本机唯一已实测生效、且官方背书的路径；`.claude-plugin` 与 `.mcp.json` 是为未来插件路线预置的超集产物。

**最小可安装产物**

```
hello-upp/
├── skills/hello-upp/SKILL.md     # 必需：技能通道（name+description）
└── runtime/server.mjs            # 必需：MCP 通道被 mcp.json 引用
# 加上 ~/.codebuddy/mcp.json 中的一条：
# "upp-hello": { "command": "node", "args": ["<pkg>/runtime/server.mjs"], "env": { "UPP_HOST": "workbuddy" } }
```

**完整产物**：上述 + `upp.json`、`runtime/tools.json`、`.claude-plugin/plugin.json`、`.mcp.json`（`${CODEBUDDY_PLUGIN_ROOT}/runtime/server.mjs`）、`clis/clis.json`，以及**未来**的 `.codebuddy-plugin/plugin.json`（`name`/`version`/`skills`/`mcpServers` 内联，待验证）。

**关键字段映射**

| UPP | WorkBuddy |
| --- | --- |
| `id` | 技能目录名；`skillOverrides` 键；MCP 不作 id |
| `hosts.workbuddy.serverName` | `mcpServers` 键（同 DSH 的 `serverName`，最严约束 `^[A-Za-z0-9_-]{1,32}$`） |
| `runtime.entry` | `mcpServers.<name>.args[0]`，**绝对路径**（非插件安装时变量不展开） |
| `version` | SKILL.md 可选 `version`；市场提交才强制 |
| `permissions` | 无声明位；靠「自定义 MCP」总闸与沙箱规则 |

---

## 4. 安装流程

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs detect                                   # 确认 workbuddy.available = true
node tools/upp.mjs build   --pkg examples/hello-upp
node tools/upp.mjs install --pkg examples/hello-upp --hosts workbuddy
# → workbuddy.skill: C:\Users\Administrator\.workbuddy\skills\hello-upp
# → workbuddy.mcp:   C:\Users\Administrator\.codebuddy\mcp.json#upp-hello
```

`install --hosts workbuddy` 的实际动作（`tools/upp.mjs` 的 `installWorkBuddy`）：

1. 对 `upp.json.skills` 逐项 `copyDir` 到 `~/.workbuddy/skills/<skillId>`（幂等覆盖）；
2. 读 `~/.codebuddy/mcp.json`（缺失则新建空结构，保留 `disabledMcpServers` 等原有键），写入/覆盖 `mcpServers.<serverName> = { command: "node", args: [<abs runtime>], env: { UPP_HOST: "workbuddy" } }`；
3. 写 `.upp-install.json` 记录，打印提示（技能 ~3 s 热加载；MCP 需宿主重读 `mcp.json`）。

**必须宿主侧/用户侧完成的步骤**

| 步骤 | 做法 | 是否可脚本化 |
| --- | --- | --- |
| 打开自定义 MCP 总闸 | GUI 安全中心 → 工具管控 → MCP → 自定义 MCP | 否（GUI） |
| 让 GUI 重读 `mcp.json` | 应用启动时读取；已运行时**待验证**是否需重启 | 部分 |
| 插件路线（可选） | 添加市场（`owner/repo` 或 https）→ 安装 → 启用（2–3 步）；或按 §3 补 `.codebuddy-plugin/plugin.json` 后投递（非受支持路径） | 否 |

没有 `workbuddy skill install` / `workbuddy mcp add` 之类 CLI（调研结论：未发现）。【已证实】

---

## 5. 验证方法

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp

# 1) 安装器视角
node tools/upp.mjs verify --pkg examples/hello-upp

# 2) 用底座 CLI 做活体健康检查（本机实测输出）
node "D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" mcp list
# Checking MCP server health...
# upp-hello: node H:\…\examples\hello-upp\runtime\server.mjs - ✓ Connected
```

**技能是否被发现**：GUI 运行后 `~/.workbuddy/.skill-list-cache.json`（mtime 22:21）已出现 `hello-upp` 条目 —— 热加载生效的硬证据；GUI 技能页检索名为视觉确认。

**工具名**：安装成功后与 DSH 一致为 `mcp__upp-hello__hello`（`mcp__<serverName>__<tool>`），§7 的映射表要求三端同名。

---

## 6. 降级与限制

| 能力 | 等级 | 表现 / 用户看到什么 |
| --- | --- | --- |
| MCP 工具 | **P0** | 需「自定义 MCP」总闸打开；否则工具不可见，无报错提示 |
| 技能 | **P0** | 目录热加载 ~3 s；上传 zip/`.skill` 亦可（官方零步骤） |
| CLI 兜底 | **P0** | 技能步骤里可直接 `node <pkg>/runtime/server.mjs --cli …` |
| 插件打包（skills+mcp+hooks 一体） | P1 | 需 `.codebuddy-plugin/plugin.json`；UPP v1 不生成，且插件商店 2 步起步 |
| commands / agents / rules 贡献点 | P1 | ✅ 已实现：`commands/<id>.md`、`agents/*.md` + `.codebuddy-plugin/plugin.json` 原生声明（见 11） |
| hooks（`PreToolUse` 等 10 类 + JS 模块） | **P2** | UPP 只声明存在；WorkBuddy 内核非 Cordis，不可移植 |
| LSP | P2 | 未实现 |
| UI 扩展（Module Federation） | **P2** | 现存全部 `kind:"builtin"`，第三方可装性【无法证实】 |
| 沙箱/权限 | P1 | 统一策略层，无技能级沙箱；`~/.workbuddy/skills/` 已全放行 |

---

## 7. 卸载与升级

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs uninstall --pkg examples/hello-upp
# 删除 ~/.workbuddy/skills/hello-upp（整个目录）
# 删除 ~/.codebuddy/mcp.json 的 mcpServers.upp-hello（保留其它服务与 disabledMcpServers）
```

| 项 | 卸载 | 说明 |
| --- | --- | --- |
| 技能目录 | 递归删除 | 按 `.upp-install.json` 记录的绝对路径删，不按名字猜 |
| `mcpServers` 键 | 删除 | 只删本包写入的 `serverName`，其它键与文件其它字段保留 |
| `settings.json.skillOverrides` | **安装器不清理** | 若用户手动关过该技能，残留键无害；需要时手工删 |
| `UPP_DATA` | 保留 | v1 无 `--purge` |
| 宿主缓存 | `.skill-list-cache.json` 由宿主自愈 | 不手改 |

**升级幂等**：`copyDir` 覆盖同名技能目录（旧文件不残留，因为整目录替换；若技能重命名需先卸载）；`mcpServers` 键整体覆盖；`install` 可重复执行，`verify` 只读。`upp build` 重复执行安全，首次写文件前留 `.upp-bak-orig`。

---

## 8. 已知风险与待验证项

| # | 项 | 状态 | 验证方法 |
| --- | --- | --- | --- |
| 1 | GUI 技能列表是否收录 `hello-upp` | **✅ 已验证（缓存收录）** | `.skill-list-cache.json` 已含 `hello-upp`；技能页截图仍可补 |
| 2 | 已运行时写 `mcp.json` 是否需重启才进 GUI | 待验证 | 不重启 → 新会话看 `mcp__upp-hello__hello`；再重启对比 |
| 3 | 「自定义 MCP」总闸默认是否开启 | 待验证 | 安全中心查看；关闭态下工具不可见的用户提示未记录 |
| 4 | `.codebuddy-plugin/plugin.json` 能否被 GUI 识别（插件路线） | 待验证 | 造一个含该清单的目录，走「添加市场 → 安装」或直接投递 |
| 5 | 自动更新/seed 是否重置 `settings.json` 的 `enabledPlugins`/`skillOverrides` | 【无法证实】 | 改开关 → 升级 → diff `settings.json` |
| 6 | `${CODEBUDDY_PLUGIN_ROOT}` 在非插件作用域是否原样透传 | 待验证 | 把变量写进用户级 mcp.json 观察是否展开失败 |
| 7 | 技能名与 DSH 同 id 的冲突 | 待验证 | 两宿主并存不影响（各写各目录），但用户认知需文档说明 |
| 8 | PoC 记录"未留技能发现证据" | 已知 | 本轮只证明 MCP；技能仅目录落盘 |

---

**相关文档**：[01-spec.md](01-spec.md) · [03-host-dsh.md](03-host-dsh.md) · [05-host-accio.md](05-host-accio.md) · [09-poc-report.md](09-poc-report.md)
