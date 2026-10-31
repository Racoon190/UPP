# 11 P1 能力映射：一份声明，三端原生形态

> **一句话**：P0 只保证"工具 + 技能"能用；P1 解决"插件里除了工具和技能，还有提示词、子代理、命令、多语言、推荐提示"这些能力怎么在三个宿主里各自落到最原生、最省 token 的位置。
>
> 本文是**实现说明 + 实测记录**。设计来源见 [07-migration-and-analyzer.md](07-migration-and-analyzer.md)，契约正文见 [01-spec.md](01-spec.md)。

---

## 1. 为什么要做 P1

三个宿主能共同识别的只有"工具调用（MCP/CLI）"和"技能（SKILL.md）"。但一个真实插件通常还带：

| 作者想表达的 | 在 Claude/CodeBuddy 系生态里的原生形态 |
|---|---|
| 一段可复用的操作提示词 | slash command / prompt command（`commands/*.md`，支持 `$ARGUMENTS`） |
| 一个有独立系统提示的子代理 | subagent / agent 配置 |
| 插件名/描述的多语言 | i18n 资源 |
| "试试这些"的推荐入口 | recommend / prompt 建议 |

UPP 的做法：**作者在 `upp.json` 里声明一次**，`upp build` 把它编译成每个宿主自己的原生文件；宿主没有对应能力时，降级成"技能"而不是丢弃。

---

## 2. 映射矩阵

| UPP 能力 | DeepSeek Harness | WorkBuddy / CodeBuddy | Accio Work | 降级策略 |
|---|---|---|---|---|
| `tools[]` | MCP server（bundle patch + `dsh-mcp-client`） | MCP server（`~/.codebuddy/mcp.json`） | MCP server（Gateway `server add`） | 同 P0 |
| `skills[]` | `~/.dsh/skills/<id>/SKILL.md`（技能扫描根） | `~/.workbuddy/skills/<id>/SKILL.md`（3s 热重载） | `skills/<id>/` + `skills_config.json` | 同 P0 |
| `prompts[]` | **镜像为技能** `~/.dsh/skills/<plugin>-prompt-<id>/SKILL.md` | **原生 command** `commands/<id>.md`（frontmatter `description`/`argument-hint`，正文追加 `$ARGUMENTS`） | 无原生命令位 → 已随插件 `skills/` 进包，由模型按需读取 | 命令位不存在时→技能镜像；两者都无→只保留在包内 |
| `agents[]` | **镜像为技能** `~/.dsh/skills/<plugin>-agent-<id>/SKILL.md`（DSH 无 bundle 级子代理贡献点） | **原生 agent** `agents/<id>.md`，由 `.codebuddy-plugin/plugin.json` 的 `agents` 字段声明 | **原生子代理** `subAgents[]`（声明）+ `subagents/<id>/prompt.md`（目录）双确认 | 子代理能力缺失→技能镜像（语义等价、无独立上下文） |
| `i18n` | 技能/工具描述仍为单语；`displayName`/`displayDescription` 写入 Accio/WB 清单 | `.codebuddy-plugin/plugin.json` 的 `displayName`/`displayDescription` 支持 `{locale: text}` | 根 `plugin.json` 同名对象字段 + `resources/i18n.json`（`entries` 格式） | 无 i18n 位→用默认语言 |
| `recommend` | 无 | 无（保留在包内 `resources/recommend.json`） | `resources/recommend.json` `[{title,prompts:[{text}]}]` | 无→省略 |
| `clis[]` | CLI 通道兜底（同 P0） | 同左 | 原生 `clis/clis.json`（`node-cli` 源） | 无→只用 MCP |

**关键取舍**：`prompts`/`agents` 在 DSH 上不做"假命令/假子代理"。DSH 的技能是模型可发现的、常驻便宜（只加载 frontmatter），因此把提示词/子代理镜像成技能，是"功能等价、成本可测"的降级，而不是假装原生。

---

## 3. 实现要点（`tools/upp.mjs`）

### 3.1 声明与发现

- `upp.json` 里 `prompts[]`/`agents[]` 可以**只写元数据**（`id`、`description`、`argumentHint`、`tools`、`skills`、`timeoutSeconds`），文件自动按 `prompts/<id>.md`、`agents/<id>.md` 解析；也可以显式给 `path`。
- 没有声明时，`upp build` 自动扫描 `prompts/`、`agents/` 目录（`.md` 文件名即 id）。
- `i18n`/`recommend` 从包根 `i18n.json`、`recommend.json` 读取，并写进 `resources/`。

### 3.2 编译产物

`upp build` 新增生成：

| 文件 | 消费者 | 说明 |
|---|---|---|
| `commands/<id>.md` | WorkBuddy | frontmatter 只保留官方允许的 `description`、`argument-hint`；正文没有 `$ARGUMENTS` 时自动追加 |
| `agents/<id>.md` | WorkBuddy | 原样复制作者文件（frontmatter + 正文） |
| `subagents/<id>/prompt.md` | Accio | 取作者 agent 正文（去 frontmatter） |
| `resources/i18n.json` | Accio | `{version:"1.0", defaultLocale, entries}` |
| `resources/recommend.json` | Accio | 原样 |
| `plugin.json` | Accio | 根清单，含 `subAgents[]`（`systemPromptFile` 指向 `subagents/<id>/prompt.md`） |
| `.claude-plugin/plugin.json` | WorkBuddy/Accio 兼容 | 纯工具+技能清单，保持 P0 兼容 |
| `.codebuddy-plugin/plugin.json` | WorkBuddy | 加 `skills/commands/agents` 贡献点 |

### 3.3 WorkBuddy 原生插件安装（P1 核心突破）

WorkBuddy 的插件系统是 CodeBuddy 血统，正常路径是"添加市场 → 安装插件"两步 UI。UPP 用**本地目录市场**把它变成零点击：

```
~/.workbuddy/plugins/
  marketplaces/upp-local/.codebuddy-plugin/marketplace.json   # {name, plugins:[{name, version, source}]}
  marketplaces/upp-local/plugins/<id>/                        # 插件本体
  known_marketplaces.json                                     # type:"directory", installLocation
  installed_plugins.json                                      # "<id>@upp-local": [{scope,installPath,version}]
~/.workbuddy/settings.json + ~/.codebuddy/settings.json       # enabledPlugins["<id>@upp-local"]=true
```

写这四类文件 = 两步 UI 的等价物。`upp uninstall` 会精确反向删除（并清理空市场）。

### 3.4 DSH 镜像安装

`install --hosts dsh` 除了复制 `skills/`，还按下面的规则写技能镜像：

```
~/.dsh/skills/<plugin>-prompt-<id>/SKILL.md
~/.dsh/skills/<plugin>-agent-<id>/SKILL.md
```

frontmatter 只有 `name` + `description`（description 取声明值，缺省回退插件描述），正文是作者 markdown 原文。DSH 的技能目录是递归扫描的，装完即出现在模型可见的技能目录（本机已复现，见 §4）。

### 3.5 校验

`upp validate` 新增：

- `manifest.prompts` / `manifest.agents`：声明的 md 文件必须存在；
- capability 与声明必须一致（声明了 `prompts` 才能有 `prompts[]`，反之亦然）；
- `i18n.defaultLocale` 必须是 `ll` 或 `ll-CC`；`entries` 不能把 `defaultLocale` 再写一遍（Accio 规范）；
- `recommend[]` 必须是 `[{title, prompts:[{text}]}]`。

`upp verify` 新增宿主侧断言（本机 `verify` 现在 20 项）：

- `dsh.skillMirror`（每个 prompt/agent 一条）
- `workbuddy.plugin.manifest` / `workbuddy.plugin.installed` / `workbuddy.plugin.enabled`
- `workbuddy.command`（每个 prompt）/ `workbuddy.agent`（每个 agent）

`upp conformance` 自动带 `--hosts` 时同步包含上述断言（本机 50 项全过）。

---

## 4. 本机实测（2026-10-29，三端全部在运行）

```bash
node upp/tools/upp.mjs build      --pkg examples/hello-upp   # 12 个产物，0 drift
node upp/tools/upp.mjs validate   --pkg examples/hello-upp   # 21 项，failed 0
node upp/tools/upp.mjs install    --pkg examples/hello-upp   # 三端 ok: true
node upp/tools/upp.mjs verify     --pkg examples/hello-upp   # 20 项，failed 0，smoke pass
node upp/tools/upp.mjs conformance --pkg examples/hello-upp --hosts   # 50 项，failed 0
```

### 4.1 DSH：镜像技能真的进了模型可见目录

安装后本会话的技能目录新增三条（无需重启）：

- `hello-upp`（P0 技能）
- `hello-upp-prompt-hello-report`（P1：prompt → 技能镜像）
- `hello-upp-agent-reviewer`（P1：agent → 技能镜像）

MCP 工具调用回包带宿主标记：

```json
{"ok":true,"data":{"message":"Hello, DSH-P1!","server":"upp-hello","version":"1.0.0","host":"dsh"},"channel":"mcp","host":"dsh"}
```

### 4.2 WorkBuddy：本地目录市场 + 技能热重载

- `plugin validate`（CodeBuddy CLI）对市场清单与插件清单均返回 `valid: true`；市场清单加 `version` 后无 warning。
- `~/.workbuddy/logs/daemon.log` 出现技能监听器事件：
  `"acceptedInWindow":7,"sampleAccepted":{"dir":"...\\.workbuddy\\skills","filename":"hello-upp\\SKILL.md","event":"change","reason":"skill-md"}`，并 `push skillsVersionChanged` —— 运行时确实热加载了技能。
- 插件（commands/agents）登记在 `installed_plugins.json` + `enabledPlugins`；CodeBuddy 血统的插件清单由应用在**下次读取插件注册表时**加载（本机安装时应用已在运行，日志未出现 plugin reload 记录）。这是 P1 唯一"需要一次重载/重启"的项，已在 [04-host-workbuddy.md](04-host-workbuddy.md) 标注。

### 4.3 Accio：网关注册 + 原生子代理目录

- `install` 自动经 Gateway 注册 MCP：`Updated custom MCP server 'upp-hello': configuration saved; connection status: connected.`
- Accio `sdk.log`：`connect: SUCCESS for 'upp-hello' (stdio) in 99.0ms` → `listToolsSnapshot: SUCCESS ... found 1 tools`。
- Gateway CLI 回读：`server tools upp-hello` → `hello`。
- 技能：`skills/hello-upp/` + `skills_config.json` `{"enabled":true,"status":"installed","installedVersion":"1.0.0"}`；子代理清单 `subAgents[0].id = reviewer` + `subagents/reviewer/prompt.md` 同时存在（满足 Accio 双确认规则）。

---

## 5. 已知边界（P1 内不承诺）

1. **DSH 不产生真子代理**：子代理在 DSH 里是"技能 + 明确指令"，没有独立上下文/独立模型。要真子代理需 P2 宿主原生扩展。
2. **WorkBuddy 插件加载时机**：文件登记完成即"已安装"，但 commands/agents 由应用在读取注册表时加载；安装时应用若在运行，可能需要一次应用重载。技能不受影响（已验证热重载）。
3. **Accio 无 prompt 命令位**：`prompts` 不会变成 slash command，只作为包内技能/资源存在；Accio 的 `recommend.json` 已原生落地。
4. **i18n 只覆盖清单字段**：工具描述、技能正文不做运行时多语言。
5. **hooks / UI 扩展 / RPA 资产**仍是 P2，不进入 P1 映射。

---

## 5.5 ui 面板与 hooks 观察钩子（P1.4 / P2 试点）

| `upp.json` 字段 | 三端形态 | 实测 |
| --- | --- | --- |
| `ui` | Accio：技能 `SKILL.md` 的 `renderers: {<id>:{description,app}}` + `app/index.html` + `scripts/show.mjs`（输出 slot JSON）；DSH/WorkBuddy：同一面板目录作为普通技能镜像 | Accio **已实测渲染**（截图）；握手需 `ui/ready` + **顶层 `height`** 的 `ui/resize` + 监听 `ui/initialize`，否则 20s `handshake_timeout`；DSH 技能目录出现 `hello-upp-panel` |
| `hooks`（仅 WorkBuddy） | `hooks/hooks.json`（`{hooks:{<Event>:[{matcher?,hooks:[{type:'command',command,timeout}]}]}}`）+ `hooks/scripts/<id>.mjs`；`plugin.json.hooks = "./hooks/hooks.json"` | 脚本直接执行 exit 0、日志写入 `%LOCALAPPDATA%` 数据目录；`plugin validate` valid；桌面端未见 `Loaded hooks configuration from extension:` 的 hello-upp 行 |
| `ui.dsh`（P1.4 补充） | DSH 原生面板：空壳 `index.js` + 手写 classic-script `client.js`（`window.__ModuleLoader__.load`，注册 `conversation.input.dock`，渲染 composer 上方卡片）+ `package.json.dsh.client` + `exports["./client"]` + patch 自插入包行 | `examples/hello-upp-ui` 14 项静态断言全绿、`node --check` 通过；**已安装并实测**：DSH 重启后 slot inspector 显示 `hello-ui-panel`（order 50、active） |
| 校验 | `validate`：ui 的 renderer/skill kebab、entry 存在、HTML 必须同时含 `ui/ready`、顶层 `height` 的 `ui/resize`、监听 `ui/initialize`，禁远程与 `skill-app://app` 直取、capability 一致；hooks 事件白名单、`mode==='observe'`、timeout ≤ 60、capability 一致 | `verify` 28 项 failed 0（含 `accio.ui.renderer`、`workbuddy.hooks.manifest`）；`run-all` 12/12 |

**为什么不承诺更多**：Accio slot 需要会话内脚本输出触发；DSH client-UI 插槽需要 React 插件包与 `ctx.slots`，无零构建路径；WorkBuddy 原生 UI 无公开 API。详见 [06 §6.6](06-toolchain.md) 与 [10 §4](10-roadmap.md)。

---

## 6. 复现命令

```bash
cd <repo>/upp
node tools/upp.mjs build --pkg examples/hello-upp
node tools/upp.mjs install --pkg examples/hello-upp     # 需要三端已安装
node tools/upp.mjs verify --pkg examples/hello-upp
node tools/upp.mjs conformance --pkg examples/hello-upp --hosts
```

只想看某一端：`--hosts workbuddy` / `--hosts accio` / `--hosts dsh`。
