# 05 · Accio Work 宿主适配（`accio`）

> 本文是三份宿主文档之一。术语与契约等级以 [01-spec.md](01-spec.md) 为准，证据见 [09-poc-report.md](09-poc-report.md)，调研原文见 [accio-surface.md](../../research/accio-surface.md)。
> 证据标记：**【已证实】**＝本机实测或源码原文；**【推测】**＝合理外推；**待验证**＝本轮 PoC 未覆盖，见 §8。

---

## 1. 宿主概览

| 项 | 值 | 证据 |
| --- | --- | --- |
| 产品形态 | 阿里 Accio Work Windows 桌面客户端（Electron），产品页 `https://www.accio-ai.com/work` | 【已证实】 |
| 客户端版本 | `@phoenix/desktop` **0.36.2**（`D:/Program Files/Accio/resources/app.asar` 内 `package.json`） | 【已证实】 |
| Electron | 安装根**无** `version` 文件，未取得版本串 | **待验证** |
| 主包 | `resources/app.asar` 131,715,698 B / 1734 成员；更新通道 `beta-win`，源 `https://work-download.accio-ai.com/package/` | 【已证实】 |
| 内置 CLI | `D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs`（161,583 B，`#!/usr/bin/env bun`） | 【已证实】 |
| 本地 Gateway | `127.0.0.1:4097`（`--port` 可改），Bearer/用户名+token；token 由 Desktop 注入环境变量 `ACCIO_GATEWAY_TOKEN` | 【已证实】 |
| 用户数据根 | `C:\Users\Administrator\.accio\`；账号空间 `…\.accio\accounts\1797968970\` | 【已证实】 |
| 插件体系 | 文件式、ZIP 分发、Claude Code 血缘：`plugin.json` + `skills/` + `subagents/` + `clis/` + `resources/`；规范随产品内置为 `plugin-create` 技能（v1.0.3，含 `references/spec.md` 275 行） | 【已证实】 |
| 技能体系 | `SKILL.md` + YAML frontmatter（`name`+`description` 必填），与 Anthropic Agent Skills 同构；层级 `agent > account > builtin` | 【已证实】 |
| MCP | 支持本地 stdio（`type:"local"`）与远端（`type:"remote"`，默认 `streamable-http`）；**唯一写入口是本地 Gateway HTTP API** | 【已证实】 |
| 公开 SDK / 文档 | **无**公开 JS/TS 插件 SDK、无插件 API 文档页（`skill-guide.html` 404、含 `plugin` 的 slug 均 404） | 【已证实】 |
| 对 UPP 的意义 | 插件清单**直接接受 `.claude-plugin/plugin.json`**（Claude 布局），是最强互操作信号；但所有安装动作必须过 Gateway/UI | 【已证实】 |

---

## 2. 原生安装点（精确路径表）

| 安装点 | 精确路径 | 说明 |
| --- | --- | --- |
| 技能目录（账号级） | `C:\Users\Administrator\.accio\accounts\1797968970\skills\<skillId>\SKILL.md` | UPP 安装器落点 |
| 技能清单 | 同目录 `skills_config.json`：`{"<id>": {"enabled": true, "status": "installed", "installedVersion": "<ver>"}}` | 启用状态的权威来源；**无条目 ≈ 已装未启用** |
| 预装/缓存标记 | 同目录 `.preinstalled`、`remote_skills_cache.json` | 宿主自管，勿写 |
| 技能（Agent 级） | `<agent>/agent-core/skills/<dir>/` + `skills.jsonc` | 不在 UPP 范围 |
| 插件目录 | `<space>/plugins/<id>\|<id>__local__…/`；暂存 `<space>/plugins/imported/.probe-<uuid>` | ZIP 解包后的单一根目录 |
| 插件注册表 | `<space>/plugins/plugins.json`：`enabled`/`installOrigin`/`sourceType`/`importedFromPath`/`installedVersion`/`toolDiscoveryState` | 插件被识别的唯一凭据 |
| 插件清单查找 | `plugin.json` → `.phoenix-plugin/plugin.json` → **`.claude-plugin/plugin.json`** | 三选一，命中即用 |
| MCP | **无独立用户配置文件**；全部经 Gateway API 写入（`/mcp/custom/servers/<name>`） | 本机 `mcp-servers/` 仅 `data/oauth`、`plugins/*.json` |
| 插件自带 MCP | `<space>/mcp-servers/plugins/<pluginId>.json`（`servers` + `syncedAt`） | 随插件注入网关 |
| 权限 | `~\.accio\plugin-permissions.json`（`{"plugins":{"<id>":{"fullAccess":true}}}`）；审计 `<space>/permissions/audit.jsonl` | UPP 未写 |
| 安装器备份 | 安装器写过的文件旁 `<file>.upp-bak-orig`（本机 `skills_config.json.upp-bak-orig` 已存在）；安装记录 `<pkg>/.upp-install.json` | 人工回滚点 |

**生效机制**

- 技能：`SkillScanner` 目录扫描发现 `SKILL.md`，但**是否启用**看 `skills_config.json`；纯落盘可能"已安装未启用"。【已证实】
- 插件：必须走 `POST /plugins/import-local`（或 UI `Load Local Plugin`）——探测 → 校验单一根 `plugin.json` → 写 `plugins.json`；仅把目录拷进 `plugins/` **不会被识别**。【已证实·机制 / 推测·拷贝行为】
- MCP：Gateway 写内存/服务端状态，`GET /mcp-servers` 可查；`server add` 立即生效。【已证实】

---

## 3. UPP → Accio 映射

| UPP 产物 | Accio 侧形态 | 落位 | 状态 |
| --- | --- | --- | --- |
| `skills/<id>/SKILL.md` | 原生技能（frontmatter 白名单 `{name, description, license, allowed-tools, metadata, compatibility}`） | `<space>/skills/<id>/` + `skills_config.json` 条目 | **P0，落盘成功，运行态待验证** |
| `.claude-plugin/plugin.json` | **合法插件清单**（Accio 直接读 Claude 布局） | 插件 ZIP 根 | P1，待导入实测 |
| `clis/clis.json` | 插件可执行工具声明，顶层 `tools[]`，`source.type ∈ {npm-package, bundled-binary, node-cli}` | 插件包内 `clis/` | P1 |
| `runtime/server.mjs` | 无直接对应；MCP 用 `command/args` 指过去；CLI 用 `clis` 的 `node-cli.entry` | 插件包内 | P0/P1 |
| MCP server | Gateway 自定义服务器；载荷 `{"mcpServers":{…}}` | 经 `accio-mcp-cli server add` 写入 | **P0，需应用内执行** |
| `subagents/<id>/prompt.md` | 插件子代理，声明 + 目录双重确认 | 插件包内 | ✅ 已生成（`generate` 写 `subAgents[]` + `prompt.md`） |
| `renderers`（P1.4 试点） | SKILL.md frontmatter `renderers: {<id>:{description,app}}` + 单文件 `app/index.html`，经 slot 注入 `:::slot[...]` 后以 `skill-app://app/` iframe 呈现 | 技能目录 | **已生成并落盘（`accio.ui` 断言）；真正渲染需应用内会话触发** |
| RPA（`rpaScriptAssets`） | 绑定 Accio 运行时与 allowedHosts | 插件包内 | **P2，不承诺** |

**最小可安装产物（两种落地方式）**

```
# A. 技能通道（安装器即可落盘，1 次 UI/网关动作激活）
hello-upp/
├── skills/hello-upp/SKILL.md
└── runtime/server.mjs            # 供 CLI/MCP 引用

# B. 插件通道（ZIP，单一根目录）
hello-upp/
├── .claude-plugin/plugin.json    # name/description/version/author/category/tags
├── skills/hello-upp/SKILL.md
├── clis/clis.json                # tools[].source = node-cli
└── runtime/server.mjs
```

**完整产物**：上述 + `upp.json`、`runtime/tools.json`、`subAgents[]`、`resources/`（icon、i18n `{defaultLocale, displayNames, displayDescriptions}`）、`prompt.md`、`businessTools` JSON。

**关键字段映射**

| UPP | Accio |
| --- | --- |
| `id` / `hosts.accio.pluginId` | `plugin.json.name`（slug 化后即 plugin id）；本地插件 id 前缀 `local:` |
| `hosts.accio.serverName` | Gateway 服务器名 → 工具名 `mcp__<serverName>__<tool>`（三端同名） |
| `version` | `plugin.json.version`（缺省 `0.0.0`，用于升级检测） |
| `description` | `plugin.json.description` |
| `runtime.entry` | `clis/clis.json` 的 `source.entry`（`node-cli`，`moduleFormat: "esm"`）与 MCP `args[0]` |
| `capabilities.skills` | `skills/` 自动扫描，**无需**在 plugin.json 列出 |
| `permissions` | 无落点；Accio 有 4 态策略（allow/ask/ask_once/deny）但由宿主侧管理 |

---

## 4. 安装流程

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs build   --pkg examples/hello-upp
node tools/upp.mjs install --pkg examples/hello-upp --hosts accio
# → accio.skill:        C:\Users\Administrator\.accio\accounts\1797968970\skills\hello-upp
# → accio.skills_config: …\skills\skills_config.json
# → accio.mcp.payload:  H:\…\examples\hello-upp\.upp-accio-mcp.json
```

`install --hosts accio` 的实际动作（`installAccio`）：

1. `copyDir` 每个技能到 `<space>/skills/<skillId>`；
2. 合并写 `skills_config.json`：`{enabled:true, status:"installed", installedVersion:<upp.version>}`（只增/覆盖本包键，保留原文件其它条目）；
3. 生成 `.upp-accio-mcp.json` 载荷（`{"mcpServers":{"upp-hello":{"command":"node","args":["<abs runtime>"],"env":{"UPP_HOST":"accio"}}}}`）；
4. **应用运行时**：读 `<account>/.accio/runtime/gateway-cli.json`（应用自己写给 CLI 的 basic-auth 凭据，`username=phoenix`、`password=token`），注入 `ACCIO_GATEWAY_TOKEN/ACCIO_GATEWAY_USERNAME/ACCIO_LOCAL_GATEWAY_URL` 后自动 `server add --json-file`；已存在（HTTP 409）则 `server update <name> --json-file`；随后 `server test <name>` 断言工具发现；
5. 应用未运行（4097 拒绝连接）时才打印"启动后重跑 `install --hosts accio`"。

**零手动步骤（本轮已实现）**

```bash
node tools/upp.mjs install --from dist/hello-upp-1.0.0.upp --hosts accio
# → accio.skill / accio.skills_config / accio.mcp.registered 全 ok
# → "MCP registered through the running Accio Gateway"

# 等价手工命令（应用运行时，排障用；凭据在 <account>/.accio/runtime/gateway-cli.json）
TOK=$(node -e "const c=require(require('os').homedir()+'/.accio/accounts/1797968970/.accio/runtime/gateway-cli.json');process.stdout.write(c.password)")
export ACCIO_GATEWAY_TOKEN=$TOK ACCIO_GATEWAY_USERNAME=phoenix ACCIO_LOCAL_GATEWAY_URL=http://localhost:4097
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server add --json-file "<store>/.upp-accio-mcp.json"
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server update upp-hello --json-file "<store>/.upp-accio-mcp.json"  # 已存在时
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server list
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server test upp-hello

# 技能：落盘 + skills_config 条目即启用（本轮实测）；GUI「选择文件夹」仅作替代路径
```

失败语义【已证实】：无 token 时 `server list/add` 返回 **HTTP 401 Unauthorized**（Gateway basic auth）；应用未运行时 `127.0.0.1:4097` ECONNREFUSED。**解法**：安装器读 `<account>/.accio/runtime/gateway-cli.json` 的 `username/password` 注入 `ACCIO_GATEWAY_TOKEN/ACCIO_GATEWAY_USERNAME`，实测 `server list/add/update/test` 全部成功。

---

## 5. 验证方法

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs verify --pkg examples/hello-upp      # 断言 SKILL.md 存在 + skills_config.enabled + 载荷存在

# 前提：Accio 桌面正在运行
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" list          # 列工具（含 upp-hello 的工具）
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server list   # 列自定义服务器与状态
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server test upp-hello
# 状态取值：connected | needs_oauth | error
```

**运行态检查点（本轮实测通过）**：`GET /mcp-servers`（basic auth）返回 `upp-hello`；`server tools upp-hello` 返回 1 个工具 `hello`；`server test` → `✓ connected — 1 tool(s) discovered`；`~/.accio/logs/sdk.log` 出现 `McpClient connectStdio: command='node', args=…store\hello-upp.0.0
untime\server.mjs`（Accio 真的拉起了我们的 runtime）。技能侧：`<space>/skills/hello-upp/SKILL.md` + `skills_config.json` 条目，运行时按会话扫描。会话内工具名为 `mcp__upp-hello__hello`。

⚠️ `server test` 只证明"连通/发现工具"，**不代表业务鉴权通过**（官方 CLI 原文）。【已证实】

---

## 6. 降级与限制

| 能力 | 等级 | 表现 / 用户看到什么 |
| --- | --- | --- |
| MCP 工具 | **P0** | 应用运行即全自动注册（凭据自动发现）；`cwd` 被忽略、超时固定 120 s（`Gateway fixes timeout at 120000 ms and ignores cwd`） |
| 技能 | **P0** | 目录落盘 + `skills_config.json` 即启用（本轮实测）；GUI 选择文件夹/`/skills/local-install` 为替代路径 |
| CLI 兜底 | **P0** | `node <pkg>/runtime/server.mjs --cli …` 在任何终端可跑（不依赖 Gateway） |
| 插件（skills+clis+subAgents 一体） | P1 | ZIP + Load Local Plugin；无 CLI 安装命令 |
| 子代理 | P1 | 声明 + 目录双重确认；`generate` 已产出 `subAgents[]` + `subagents/<id>/prompt.md` |
| 命令/提示词 | P1 | 无独立扩展点，靠技能正文 |
| hooks / 事件回调 | **P2** | **不存在**（全 asar 无钩子式清单字段） |
| 插件 JS 执行 | P2 | `customTools` handler 为 CommonJS，**无 fs / child_process / process.env**，路径限插件目录 |
| UI 渲染器 / RPA | **P2** | `renderers` + `skill-app://` + iframe 桥，UPP 不承诺 |
| SSE 传输 | — | 未作为可选枚举（CLI 仅 1 次出现）→ 仅用 stdio / streamable-http |
| 公开 SDK | — | **无**，只能写文件 + 调 Gateway |

---

## 7. 卸载与升级

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs uninstall --pkg examples/hello-upp
# 删除 <space>/skills/hello-upp 整目录；尝试从 skills_config.json 删条目

# MCP 侧必须宿主侧执行
node "D:/Program Files/Accio/resources/accio-mcp-cli/accio-mcp.mjs" server remove upp-hello
```

| 项 | 卸载 | 说明 |
| --- | --- | --- |
| 技能目录 | 递归删除（按记录路径） | 幂等 |
| `skills_config.json` 条目 | 期望删除 | 现有实现用 `record.id` 匹配键，而记录里只有 `package`/`hosts`，**可能删不掉** → 已知缺口，卸载后请人工核对 |
| MCP 自定义服务器 | `server remove <name>` | 无配置文件可删 |
| 插件 | 插件页卸载 / 删 `plugins.json` 条目 | 非受支持路径不建议手改 |
| `UPP_DATA` | 保留 | 同上 |
| 宿主升级 | 扩展都在 `~/.accio`（应用目录外），`plugins.json` 持久化 `installedVersion` | 【已证实·路径与字段；推测·升级行为】 |

**升级幂等**：`copyDir` 覆盖同名技能目录；`skills_config.json` 键覆盖（保留其它条目）；MCP 用 `server add/update` 覆盖同名服务器；`install` 可重复执行。插件升级走 `POST /plugins/import-local` 覆盖（宿主会用 `.updating.bak` 备份旧目录）。

---

## 8. 已知风险与待验证项

| # | 项 | 状态 | 验证方法 |
| --- | --- | --- | --- |
| 1 | Accio 运行态未验证（Gateway 未起） | **待验证** | 打开 Accio → `curl`/`server list` → 执行 §4 命令，确认工具与技能可见 |
| 2 | Electron 版本 | **待验证** | 未在安装根找到 `version` 文件；可从 `Accio.exe` 元数据或运行态读取 |
| 3 | 自定义 MCP 的持久化位置 | 【无法证实】 | 本机无自定义 MCP；加一个后查 `~/.accio` 是否出现新 JSON |
| 4 | 技能"纯落盘 + `skills_config.json`"是否足以被 GUI 启用 | 待验证 | 打开技能页看 `hello-upp` 是否 enabled 且可调用 |
| 5 | 插件通道能否导入 UPP 目录（`.claude-plugin/plugin.json`） | 待验证 | `POST /plugins/import-local` 后查 `plugins.json` |
| 6 | `clis/clis.json` 的 `node-cli` 在 Windows 的落地与 PATH | 待验证 | 导入后 `GET /plugins/hello-upp/runtime-info` 看 `cliTools[].state` |
| 7 | MCP 忽略 `cwd` 的影响 | 风险 | 运行时必须用绝对路径/`import.meta.dirname` 自定位，UPP 已按此实现 |
| 8 | `tools[].script`（SKILL.md 声明式脚本工具） | 【推测】不生效 | 解析存在、消费缺失；不要依赖 |
| 9 | 本会话 `curl 127.0.0.1:4097` → 000 | 已知 | 应用未运行；不是适配器缺陷 |

---

**相关文档**：[01-spec.md](01-spec.md) · [03-host-dsh.md](03-host-dsh.md) · [04-host-workbuddy.md](04-host-workbuddy.md) · [09-poc-report.md](09-poc-report.md)
