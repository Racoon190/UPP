# UPP v1 包规范（UPP Package Specification）

状态：v1.0.0-draft，P0 已实机验证（见 [09-poc-report.md](09-poc-report.md)）。
本文件是 UPP 的**唯一规范源**；工具链（`tools/upp.mjs`）与三端适配器都必须与本文一致，不一致以本文为准。

---

## 1. 术语

| 术语 | 含义 |
| --- | --- |
| **插件（UPP package）** | 一个目录，含 `upp.json` + 运行时 + 技能层，可被三端安装 |
| **宿主（host）** | DeepSeek Harness（`dsh`）、WorkBuddy（`wb`）、Accio Work（`accio`） |
| **通道（channel）** | 宿主消费插件能力的途径：MCP 工具、CLI、技能指令、提示词/子代理/命令 |
| **适配器（adapter）** | 把 UPP 包映射成某一宿主原生安装形态的代码（`adapters/<host>.mjs`） |
| **契约等级** | P0 强可移植 / P1 功能等价 / P2 不可移植，见 §8 |
| **超集目录（superset layout）** | 同一目录内同时放置三端原生清单，各宿主只读自己认识的子集 |

---

## 2. 包结构

```
<plugin>/
  upp.json                     # 必需：唯一真源清单
  runtime/
    server.mjs                 # 必需（kind=node）：MCP stdio + CLI 双模运行时
    tools.json                 # 由 upp build 生成：工具模式（勿手改）
  skills/<skill-id>/SKILL.md   # capabilities 含 skills 时必需
  .claude-plugin/plugin.json   # 生成：Accio / CodeBuddy 兼容清单
  .mcp.json                    # 生成：WorkBuddy 插件内 MCP 声明
  clis/clis.json               # 生成：Accio 插件内 CLI 声明
  package.json                 # 生成：DSH bundle 清单（含 dsh.bundle.patch）
  cordis.patch.yml             # 生成：DSH patch（.tpl 模板随包分发）
  assets/                      # 可选：图标、模板、数据
```

规则：

1. **`upp.json` 是唯一真源**。`runtime/tools.json` 与三端清单都由 `upp build` 从它派生；CI/发布前必须 `upp build --check` 确认无漂移。
2. 目录名与 `id` 均为 kebab-case：`^[a-z][a-z0-9-]{2,63}$`。
3. `hosts.<host>.serverName` 受最严宿主约束：`^[A-Za-z0-9_-]{1,32}$`（DSH 限制），三端复用同一个 `serverName`。
4. 未知字段与未知文件必须被忽略（前向兼容），生成物不得报错于旧宿主。
5. 插件**不得**在安装时执行网络请求或写插件目录之外的路径；安装器只做文件落位与配置合并。

---

## 3. `upp.json`

### 3.1 最小示例

```json
{
  "uppVersion": "1.0",
  "id": "hello-upp",
  "name": "Hello UPP",
  "version": "1.0.0",
  "description": "最小 UPP 示例：一个工具、一个命令、一个技能。",
  "runtime": { "kind": "node", "entry": "runtime/server.mjs" },
  "capabilities": ["tools", "skills"],
  "permissions": { "network": false, "filesystem": "none", "shell": false },
  "hosts": { "dsh": { "serverName": "upp-hello" }, "workbuddy": { "serverName": "upp-hello" }, "accio": { "serverName": "upp-hello" } },
  "tokenBudget": { "alwaysLoadedBytes": 900 }
}
```

### 3.2 字段

| 字段 | 必填 | 类型 | 约束 / 说明 |
| --- | --- | --- | --- |
| `uppVersion` | ✅ | string | 规范主版本，当前 `"1.0"`；宿主适配器按此判定兼容 |
| `id` | ✅ | string | kebab-case，三端唯一；= 包目录名建议 |
| `name` | ✅ | string | 人类可读名，≤ 64 字符 |
| `version` | ✅ | string | SemVer |
| `description` | ✅ | string | ≤ 280 字符；同时用于工具/技能描述的前缀 |
| `author` / `license` / `homepage` | | string | 展示用 |
| `minNode` | | string | 运行时最低 Node 版本，默认 `"18"` |
| `runtime.kind` | ✅ | `"node"` | v1 仅支持 Node（三端均自带 Node，零安装成本） |
| `runtime.entry` | ✅ | string | 相对路径；必须可被 `node <abs>` 直接执行 |
| `runtime.protocol` | | `"mcp/stdio"` | 默认值；运行时必须实现 MCP stdio 子集（§4.1） |
| `capabilities` | ✅ | string[] | `tools` / `skills` / `prompts` / `agents` / `i18n` / `recommend` / `clis` / `ui` / `hooks` 的子集，声明即承诺对应等级 |
| `skills` | | object[] | `{ id, path }`；缺省时扫描 `skills/*` |
| `tools` | | object[] | `{ name, description, inputSchema, cli? }`；缺省时读 `runtime/tools.json` |
| `prompts` | | object[] | `{ id, description, path }`，映射到宿主提示词/命令（P1） |
| `clis` | | object[] | `{ id, commandName, entry, moduleFormat }`（Accio clis.json 语义） |
| `agents` | | object[] | `{ id, description, tools?, skills?, timeoutSeconds?, path }`：Accio `subAgents[]` + WorkBuddy agents（P1） |
| `i18n` | | object | `{ defaultLocale, entries }`：生成 Accio `resources/i18n.json`，`entries` 用非默认语言键（P1） |
| `recommend` | | object[] | `[{ title, prompts:[{ text }] }]`：生成 Accio `resources/recommend.json`（P1） |
| `ui` | | object | `{ rendererId?, skillId?, title?, entry }`：面板技能，Accio `renderers` frontmatter + 单文件 HTML；DSH/WorkBuddy 作为普通技能镜像（P1.4） |
| `hooks` | | object[] | `{ id, event, matcher?, timeoutSeconds?, mode? }`：仅 WorkBuddy 观察钩子；`event ∈ {SessionStart, SessionEnd, PostToolUse}`，`mode` 仅 `observe`（P2 试点） |
| `permissions` | ✅ | object | 见 §10；三端权限模型的最小公倍数 |
| `hosts` | | object | 逐端覆盖：`{ serverName?, pluginId?, skillDir?, extra? }` |
| `tokenBudget` | | object | 自约束：`alwaysLoadedBytes`（技能常驻部分预算，建议 ≤ 2048）、`toolDescriptionBytes` |
| `hostNative` | | object | 显式声明 P2 原生能力：`{ dsh?: {ui, hooks}, workbuddy?: {hooks, lsp}, accio?: {renderers, rpa} }`；只做存在性声明，不承诺可移植 |

### 3.3 校验规则（`upp validate`）

- 必填字段齐全、类型正确、`id`/`serverName`/`version` 正则通过；
- `runtime.entry`、`skills[].path` 存在且不越出包目录；
- `capabilities` 里声明的项都有对应产物（工具可在 tools.json 找到、技能目录含 `SKILL.md`）；
- `permissions` 不超出 `network=false, filesystem=none, shell=false` 之外而未在 `hostNative` 说明（默认最小权限）；
- `tokenBudget.alwaysLoadedBytes` 超预算时告警（不阻断）。

---

## 4. 运行时协议

### 4.1 MCP stdio（主通道）

运行时 `node runtime/server.mjs` 必须在 stdin/stdout 上实现 MCP（JSON-RPC 2.0，**换行分隔**，非 LSP 长度前缀）：

| 方法 | 响应要点 |
| --- | --- |
| `initialize` | `{protocolVersion, capabilities:{tools:{},resources:{},prompts:{}}, serverInfo:{name,version}}` |
| `notifications/initialized` | 无响应 |
| `ping` | `{}` |
| `tools/list` | `{tools:[{name,description,inputSchema}]}` |
| `tools/call` | `{content:[{type:"text",text:"<JSON>"}], isError?}` |
| `resources/list`、`prompts/list` | 可为空数组（宿主容忍缺失） |

约束：

- **stdout 只输出协议消息**，日志/诊断一律写 stderr（DSH 与 CodeBuddy 都会把 stdout 当协议流）。
- 工具结果统一为**一个 JSON 文本块**：`{"ok":true,...}` 或 `{"ok":false,"code":"...","message":"..."}`，错误不要只靠 `isError` 表达。
- 单个工具调用应 ≤ 15s（DSH 默认 60s、Accio 120s、WorkBuddy 默认 60s，取最严者的安全余量）。
- 运行时零 npm 依赖（Node 内置模块即可）；`package.json` 的 `dependencies` 必须为空。

### 4.2 CLI（兜底通道，三端都可用）

```
node <abs>/runtime/server.mjs --list
node <abs>/runtime/server.mjs --info
node <abs>/runtime/server.mjs --cli <tool> --json '<input-json>'
```

- 退出码 `0` = 成功，`2` = 业务错误（`{"ok":false}` 打到 stdout），`1` = 运行时错误（stderr）。
- `--json` 省略时按 argv 键值 `--name value` 解析；仍只输出一个 JSON。
- CLI 与 MCP 必须调用**同一** handler（禁止两套实现）。

### 4.3 宿主感知

运行时读取 `UPP_HOST`（`dsh|workbuddy|accio`）与 `UPP_DATA`（可写数据目录，安装器注入）。缺少时不得崩溃；`UPP_HOST` 仅用于提示与日志，**不得改变工具的语义**。

---

## 5. 技能层

`skills/<id>/SKILL.md`：

```markdown
---
name: hello-upp
description: 返回一句问候并证明 UPP 插件已在该宿主上安装成功。当用户要求"测试插件/验证安装"时使用。
---

# Hello UPP

按下列顺序探测（命中即停，不要解释探测过程）：

1. 工具：若存在 `mcp__upp-hello__hello`，调用它，参数 `{"name":"<用户称呼或 world>"}`。
2. 命令行：执行
   `node "<plugin-root>/runtime/server.mjs" --cli hello --json '{"name":"<...>"}'`
3. 以上都不可用：说明本宿主只能以只读方式使用本技能，并给出手动步骤。

报告只包含：结果 `ok`、`message`、`host`。不要输出原始 JSON 全文。
```

规则：

- frontmatter **最少** `name` + `description`；为三端兼容，只允许 `{name, description, license, allowed-tools, metadata, compatibility}`（Accio 官方白名单）。
- 常驻部分（描述 + 探测步骤）≤ `tokenBudget.alwaysLoadedBytes`；详细知识放 `references/*.md`，按需读取。
- 步骤 2 的路径必须是**安装后绝对路径**（由适配器在安装时替换），或使用宿主提供的插件根变量；不得写相对路径。
- 技能不重复描述工具能力：工具是事实，技能是"何时用、怎么用、失败怎么退"。

---

## 6. 通道优先级与降级

宿主能力探测顺序（写进 SKILL.md 与运行时）：

```
1) MCP 工具可见        → 结构化调用（首选，带 schema）
2) CLI 可执行          → 等价调用（stdout JSON）
3) 仅技能指令          → 模型按步骤手工执行（降级，允许慢）
```

降级必须**逐级声明**，不得静默失败：每次降级在结果里带 `"channel":"mcp|cli|skill"`。

---

## 7. 三端映射

| UPP 产物 | DSH | WorkBuddy | Accio |
| --- | --- | --- | --- |
| MCP server 定义 | bundle 内 `cordis.patch.yml`：`@deepseek-ai/dsh-mcp-client` + `serverName/command/args` | `~/.codebuddy/mcp.json` 的 `mcpServers.<serverName>`（或插件内 `.mcp.json`） | 应用内 `accio-mcp-cli server add`（Gateway 写入） |
| 工具可见名 | `mcp__<serverName>__<tool>` | 同左 | 同左 |
| 技能 | 随 bundle 生效 | `~/.workbuddy/skills/<id>/` | `~/.accio/accounts/<acct>/skills/<id>/` + `skills_config.json` |
| 插件清单 | `package.json` + `dsh.bundle.patch` | `.claude-plugin/plugin.json` | `.claude-plugin/plugin.json`（Claude 血缘） |
| 命令/CLI | 工具即命令 | 插件 `commands/`（P1） | `clis/clis.json` |
| 安装动作 | `plugin_manager install_bundle` | 复制目录（技能 ~3s 热重载）+ 配置合并 | 技能：`/skills/local-install` 或写配置；插件：`POST /plugins/import-local` |

**安装器分工**：文件落位与配置合并由 `upp install` 完成；只有"必须经宿主 API/GUI"的动作（Accio MCP 注册、Accio 插件导入、DSH bundle 安装）留给宿主侧执行，并给出可直接粘贴的命令。

---

## 8. 契约等级

| 等级 | 内容 | 承诺 | 验收 |
| --- | --- | --- | --- |
| **P0** | 工具名、输入 schema、结果 JSON、错误码、CLI 行为、技能可发现性 | **100% 可移植**，逐端实机验证 | `upp conformance` 在三端各跑一遍，全绿 |
| **P1** | 提示词/命令、子代理、推荐提示、i18n、assets | **功能等价**，允许形态差异（需文档说明） | 三端手动清单验收 |
| **P2** | UI 插槽、事件钩子（hooks）、LSP、RPA、宿主专有沙箱 | **不承诺**，声明存在即可；适配器忽略并告警 | 无 |

**"100% 可移植"的定义**（必须写进任何对外承诺）：在 P0 契约内、且宿主版本在 §9 列出的支持下，同一 UPP 包在三端的工具/技能行为一致——同输入同输出、同错误码、同技能触发条件；差异只能是"设备/权限/网络"等外部环境差异。

---

## 9. 版本与兼容

- `uppVersion`：主版本不同即不兼容；工具链拒绝安装并提示升级。
- `minNode`：低于宿主自带 Node 版本时告警但仍尝试运行（三端均自带 Node ≥ 18）。
- 宿主支持矩阵：`docs/compat-matrix.md` 记录已实测版本；未列版本按"尽力兼容"处理，不承诺 P0。
- 适配器必须对**宿主未知字段**宽容：写入配置时保留原有键（只增不删）。

---

## 10. 权限

`permissions` 取三端权限模型的交集（Accio 的 `allow/ask/ask_once/deny` 最细，DSH/WorkBuddy 的 ask/deny 较粗）：

```json
"permissions": {
  "network": false,            // 是否出网
  "networkHosts": [],           // 允许域名（network=true 时必填）
  "filesystem": "none",         // none | data($UPP_DATA) | workspace
  "shell": false,               // 是否允许执行子进程
  "env": []                     // 需要读取的环境变量名（默认全部清洗）
}
```

安装器把 `permissions` 写入各端配置（Accio 的 `plugin-permissions.json`、WorkBuddy 的自定义 MCP 总闸提示、DSH 的 bundle 声明），并在 `upp verify` 中复核。**默认最小权限**：`network=false, filesystem=none, shell=false`。

---

## 10.5 本地优先与按需调用（成本契约）

目标是"可复用的能力只在本机实现一次，宿主按需调用"，避免为省事把逻辑塞进模型上下文或每端重写：

1. **业务逻辑在本地进程**：`runtime/server.mjs` 由宿主按需 spawn（MCP stdio 长连接缓存；CLI 每次调用即用即退），默认零网络。出网必须显式 `permissions.network=true` + `networkHosts`。
2. **一份实现、三端复用**：同一 `runtime` 入口同时提供 MCP 与 CLI，DSH/WorkBuddy/Accio 通过各自通道调用同一份代码，不复制业务逻辑。
3. **模型侧只暴露最小可发现面**：工具 `description` 一句话、`inputSchema` 只列必要字段；重逻辑放代码或技能脚本里，**调用时才进入上下文**；技能按渐进披露组织（`SKILL.md` 只放入口，细节进 `references/`）。
4. **插件执行路径不含 LLM**：唯一可选的模型调用是 `upp import --analyze --polish`（默认关闭，必须显式提供 `UPP_LLM_*` 环境变量；`--strict-polish` 缺配置即失败）。
5. **安装/校验/打包全离线**：`upp` 是单文件零依赖；不联网、不装包、不下载。`pack`/`bundle-offline`/`verify-signature` 都在本机完成。
6. **可度量**：`upp.json.tokenBudget.alwaysLoadedBytes` 建议 ≤ 2048（工具+技能描述常驻部分），`upp validate` 会在超限时给出检查项。

---

## 11. 数据目录

- 可写数据只允许在 `UPP_DATA`（安装器创建：`<hostData>/upp-data/<id>/`）。
- 插件不得写注册表、不得写其他插件目录、不得改宿主全局设置（适配器负责配置合并，而不是插件）。
- 卸载时删除技能/MCP 配置，保留 `UPP_DATA`（除非 `--purge`）。

---

## 12. 一致性测试（conformance）

`upp conformance --pkg <dir>` 对每端执行同一组用例（与宿主无关的确定性用例）：

1. `upp validate` 通过；
2. MCP 握手 + `tools/list` 与 `upp.json` 声明一致（名字、必填参数）；
3. 每个工具至少一个正常用例 + 一个错误用例，三端结果 JSON 深度相等；
4. CLI 与 MCP 结果相等；
5. 技能 frontmatter 合法且探测路径可达（文件存在/工具名正确）；
6. 安装 → 卸载 → 再安装幂等（不残留、不重复键）。

`tools/mcp-smoke.mjs` 是 conformance 的最小内核（当前 7 项断言：6 项协议 + 1 项 CLI parity）。`upp conformance` 的实际组成：12 项 spec 校验 + `build.upToDate`（幂等）+ `protocol.smoke` + 7 项 smoke + 可选 `--hosts` 宿主 verify，合计 21 项；`failed > 0` 即退出码 1。

---

## 13. 打包与分发

- `upp pack` 产出 `dist/<id>-<version>.upp`（ZIP，含 `upp.json` 与全部产物，不含 `node_modules`、`.upp-*`、`*.upp-bak-orig`）。
- `.upp` 可改名 `.zip` 直接解压检查；安装器接受目录或 `.upp`。
- 已实现：`pack` 写 `<id>-<version>.upp.sha256` 内容哈希；`pack --sign` 追加 ed25519 detached 签名 `.upp.sig.json`；`verify-signature --require [--pubkey <pem>]` 校验；`install --from` 自动校验。仅自签 + 可选指纹钉扎，**无 CA/信任链**（见 08 §6）。
- 上架三端市场不在 v1 范围；v1 只保证本地/内网分发。

---

## 14. 从现有插件迁移（映射规则）

| 来源 | 可自动迁移 | 映射 |
| --- | --- | --- |
| DSH 插件（host tool/service） | 工具/服务 → UPP 工具；UI/hooks → P2 丢弃 | 提取 handler 语义，重写为 MCP handler |
| WorkBuddy/CodeBuddy 插件 | skills/commands/MCP → 技能/命令/MCP；hooks → P2 | `.codebuddy-plugin/plugin.json` → `.claude-plugin/plugin.json` |
| Accio 插件 | skills/clis/subAgents → 技能/CLI/子代理(P1)；renderers/RPA → P2 | `plugin.json` 字段直接复用 |

详见 [07-migration-and-analyzer.md](07-migration-and-analyzer.md)：迁移器与"插件拆解分析器"的设计，对应用户最初的构想 3。
