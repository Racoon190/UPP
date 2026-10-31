# 07 迁移器与插件拆解分析器

**状态**：**已实现并实测**（v1）。§1 三端形态为**实测**【已证实】（依据 `research/*-surface.md` 与真实安装目录）；
`upp import` / `upp analyze` 已落在参考工具链 `tools/upp.mjs`（约 2 000 行，零依赖），实际命令形态与验收见 §2.5 与 §8【已证实】。
本文对应 [00-overview.md](00-overview.md) §2 构想 ③，把 [01-spec.md](01-spec.md) §14 的**映射规则**落成可实现流程；安全与完整性约束见 [08-security-and-supply-chain.md](08-security-and-supply-chain.md)。

---
## 1. 三端插件的真实形态（对照）

| 维度 | DeepSeek Harness | WorkBuddy 5.9.3 | Accio Work 0.36.2 |
| --- | --- | --- | --- |
| 清单入口 | `package.json` + `dsh.bundle.patch`（`cordis.patch.yml`） | `.codebuddy-plugin/plugin.json` | `plugin.json`（查找序 `plugin.json` → `.phoenix-plugin/plugin.json` → `.claude-plugin/plugin.json`） |
| 代码入口 | `index.js`（`apply(ctx, config)` 或 service class）；MCP-only bundle **无** `index.js` | 无统一入口；`hooks/hooks.json` 的 `modules[]` 加载 JS | `clis/clis.json` → `node-cli` entry；`subagents/{id}/handlers/*.js` |
| 工具声明 | 运行期 `ctx.tools.register(definition)`（JS，非清单） | **无 host tool 概念**，靠 MCP + skills | `clis[]`（`npm-package`/`bundled-binary`/`node-cli`）+ `subAgents[].customTools` |
| 技能 | `<name>/SKILL.md`，6 级磁盘根；**不扫描嵌套** `**/SKILL.md` | `skills/<id>/SKILL.md` + `plugin.json.skills` | `skills/` **自动扫描**（含 `SKILL.md` 即算） |
| MCP | patch 内 `@deepseek-ai/dsh-mcp-client` 行 | `~/.codebuddy/mcp.json` / 插件 `.mcp.json` / `plugin.json.mcpServers` | 唯一写入口：本地 Gateway `127.0.0.1:4097` |
| 安装 | `plugin_manager install_bundle` → `PROFILE/node_modules/<pkg>` | 目录落位 + `settings.json.enabledPlugins` | `POST /plugins/import-local` 或 UI「Load Local Plugin」 |
| 扩展点 | Tool/Service/Event/Config + client UI 插槽 | skills/mcp/commands/agents/hooks/rules/lsp | skills/clis/subAgents/MCP/renderers/RPA |
| 权限粒度 | 粗（bundle 声明 + approval waterfall） | 两档总开关 + 135 条 fs 三态规则 | `allow/ask/ask_once/deny` 四策略（最细） |
| 静态可读面 | 清单/`patch` YAML 可读；**工具 Schema 在 JS 里** | 清单/`mcp.json`/`hooks.json`/`SKILL.md` 可读；hooks 逻辑在 JS | 清单/`clis.json`/`i18n.json`/`SKILL.md` **全可读** |

**一条结论**：三端**只有"清单 + Markdown + JSON"这一层能静态、确定地提取**。工具的真实输入 Schema 与 handler 语义
在 DSH/WorkBuddy 中存在于运行期 JS（`ctx.tools.register`、`hooks`），静态 AST 只能拿到**字面量**写法那部分——这是 §2.1
"置信度"列与 §4 决策树的全部依据。

---
## 2. 迁移器：`upp import <dir> --out <dir>`（v1 自动识别来源）

| 子命令/退出码 | 含义 |
| --- | --- |
| `import <dir> --from accio --out <work>` / `... --dry-run` | 生成候选 UPP 骨架到 `<work>/<id>/`，**不碰任何宿主配置** / 只分析不写盘（默认安全模式） |
| `import <dir> --from accio --out <work> --strict` | 迁移后自检（`validate` + `build --check`） |
| `0` / `2` / `1` | 无阻塞项 / 参数或清单缺失 / 读写错误**或** `--strict` 下存在 `blocking:true` 项 |

四阶段全部离线，**不执行源插件代码、不联网**：S1 识别（`<dir>` → `{host, manifestPath, rootDir}`）→ S2 静态提取
（→ `import-inventory.json`）→ S3 映射分级（每能力 P0/P1/P2/BLOCKED + `needsHuman[]`）→ S4 生成（`upp.json` +
超集目录 + `import-report.md/.json`）。四步**都不需要执行源码**——这是它们能确定性复现的前提。

### 2.1 自动提取矩阵（置信度：高=字面量确定 / 中=有约定需校验 / 低=只能占位）

| 源形态 | 提取内容 | 置信度 | UPP 落点 |
| --- | --- | --- | --- |
| Accio `clis/clis.json` `tools[].source` | id/类型/entry/commandName/moduleFormat | 高 | `upp.json.clis[]`（`node-cli` 直接复用；`npm-package` → 人工） |
| Accio `plugin.json` metadata + `subAgents[]` + `resources/i18n.json` | id/name/version/description/author/icon/category/tags；子代理字段；entries 翻译 | 高 | `upp.json` 同名段 + `.claude-plugin/plugin.json`；`prompts[]`(P1)；`assets/i18n.json`(P1) |
| Accio `skills/<id>/SKILL.md` | frontmatter `name`/`description` + 正文 | 高 | `skills/<id>/SKILL.md`（frontmatter 收窄至 6 键白名单） |
| WorkBuddy `.codebuddy-plugin/plugin.json` 与 `hooks/hooks.json` | 7 类贡献点路径；10 个事件名（与 Claude Code 同名）+ matcher | 高（字段）/ 低（语义） | 技能→`skills/`；MCP→`.mcp.json`；hooks/lsp→**P2** 声明（`hostNative.workbuddy.hooks`），不迁逻辑 |
| DSH `cordis.patch.yml` 的 MCP 行 | `serverName`/`command`/`args`/`env` | 高 | `.mcp.json` + `upp.json.hosts.*.serverName` |
| DSH `ctx.tools.register({...})` | **字面量** → tool name/description/`parameters`(JSON Schema)；非字面量 → 仅"存在未知工具" | 中 / 低 | `runtime/tools.json` / `needsHuman`（v1 不通 `--probe-exec`） |
| 任意 `SKILL.md` 的 `renderers` / `:::slot` | renderer 名 + 挂载点 | 中 | P2（`hostNative.accio.renderers`） |
| 任意清单的 `permissions`/`fullAccess` | 请求的能力集合 | 高 | `upp.json.permissions`（**只能收紧**，§2.3） |

### 2.2 生成超集目录（与 `generate()` 已实现的生成物对齐，避免两套生成器漂移）

`tools/upp.mjs` 的 `generate()` 确定写出 6 个派生文件【已证实】：`runtime/tools.json`、`.claude-plugin/plugin.json`、
`.mcp.json`（`command:"node"`、`args:["${CODEBUDDY_PLUGIN_ROOT}/<entry>"]`、`env.UPP_HOST:"workbuddy"`）、`clis/clis.json`、
`package.json`（`dsh.bundle:{patch:"./cordis.patch.yml"}`）、`cordis.patch.yml`（由 `.tpl` 替换
`__UPP_SERVER_NAME__`/`__UPP_PACKAGE_NAME__`/`__UPP_RUNTIME_ENTRY__`）。`import` 只产出**输入侧**，派生仍由 `build` 负责：

```
<work>/<id>/  upp.json              # 唯一需要人看/改的文件
              runtime/server.mjs    # 模板生成：每个工具一个返回 {ok:false,code:"E_NOT_IMPLEMENTED"} 的桩
              skills/<id>/SKILL.md  # 原样复制 + frontmatter 收窄
              assets/i18n.json      # 仅当源有 i18n
              import-report.md/.json
```

### 2.3 必须人工确认的项（任何自动迁移都不得静默通过）

| 项 | 为什么不自动 | 证据 |
| --- | --- | --- |
| handler 语义 | 只能拿到签名，拿不到"做什么"；重写即重写业务逻辑 | DSH handler 在 `index.js`；Accio customTools 是 CommonJS 函数体 |
| 宿主专有 API | 另一宿主根本没有该能力 | `hostServices`（16 个 `ecommerce.*` 方法）、`requiredBuiltinTools` 的 `browser_rpa_*` |
| 权限升级 | 源插件可能申请了比 UPP 允许更强的权限 | Accio `plugin-permissions.json` 的 `fullAccess:true` vs [01-spec.md](01-spec.md) §10 最小权限 |
| 密钥/账号绑定 | 凭据不可搬且不得入包 | DSH 子进程 env 经 `scrubbedParentEnv()` 清洗（见 [08](08-security-and-supply-chain.md)） |
| 原生依赖 | 违反零依赖/零 npm 安装 | 样本 `dependencies:{"better-sqlite3":"12.9.0"}`；`clis.json` 的 `npm-package` source 亦同 |
| P2 面（renderers/hooks/lsp/RPA） | 契约等级明确不承诺 | [01-spec.md](01-spec.md) §8 |

**`--probe-exec`（默认关闭，v1 不实现）**：要拿真实 JSON Schema 需在子进程 `require` 源插件并喂假 `ctx`——等于**执行不受信任
第三方代码**，必须在隔离环境 + 显式确认下进行。故 v1 不提供，宁可标 `needsHuman`。

### 2.4 产物 schema：`import-report.json`

```json
{ "reportVersion": "1.0",
  "source": { "host": "accio", "root": "…/installed/ecommerce-automation-toolkit", "manifestPath": "plugin.json",
              "id": "ecommerce-automation-toolkit", "version": "0.4.7" },
  "counts": { "skills": 21, "clis": 2, "mcpServers": 0, "tools": 0, "subAgents": 0, "p2Items": 11 },
  "portable": { "p0": 23, "p1": 2, "p2": 11, "blocked": 4 },
  "needsHuman": [
    { "id": "hostServices.commerce", "kind": "host-api", "blocking": true, "action": "drop-or-reimplement",
      "detail": "16 个 Accio 宿主 RPC，另两端无对应物" },
    { "id": "clis.ecomctl", "kind": "dependency", "blocking": false, "action": "replace-with-node-cli-or-drop",
      "detail": "npm-package source 需联网安装" } ],
  "tokenEstimate": { "alwaysLoadedBytes": 432722, "approxTokens": 123635, "budgetBytes": 2048, "overBudget": true } }
```

---
### 2.5 已实现契约（v1 真机，2026-10-29）

```bash
node tools/upp.mjs import <源插件目录> --out imports/<id>            # 写包
node tools/upp.mjs import <源插件目录> --out imports/<id> --analyze  # 写包 + ANALYSIS.md + contract.json
node tools/upp.mjs analyze <源插件目录> --out imports/<id>           # 同上（语义化入口）
```

| 项 | v1 实际行为 |
|---|---|
| 来源识别 | 按目录特征自动判定 `upp` / `workbuddy`(`.codebuddy-plugin/plugin.json`) / `claude`(`.claude-plugin`) / `accio`(`clis/clis.json`)，无需 `--from` |
| MCP 抽取 | `plugin.json`、`.mcp.json`、`mcp.json`、`.claude-plugin/mcp.json`、`cordis.patch.yml` 的 dsh-mcp-client 段（正则取 command/args，不做变量求值） |
| 上游探测 | `probeMcp()` 以 stdio 真连上游跑 `initialize`+`tools/list`（8 s 超时），取 serverInfo 与工具 schema |
| 运行时生成 | 有上游 → **stdio 代理**（`serverInfo.name` 改写为契约名，`--cli` 被动转发）；无上游 → **describe 兜底**（1 个工具，三通道仍可用） |
| 报告 | `IMPORT-REPORT.md`：抽取表、上游探测结果、复制清单、P2 gaps（hooks/lsp/rpa/renderers/ui）、下一步 |
| 复刻产物 | `ANALYSIS.md`（人读）+ `contract.json`（tools+inputSchema+skillIds+cli+错误码+replication 步骤，token 按 JSON/4 估算） |
| 不生成 | hooks、LSP、RPA、renderers、宿主专有 UI、handler 业务逻辑改写（进 `needsHuman`/P2 gap） |

**真机验收**（同一命令跑三个真实插件）：
- Accio `ecommerce-automation-toolkit`：21 skills / 2 clis，`validate` 35 项 0 失败；pack 851 条目 10 202 494 B（技能自带大资源，未建议原样分发）。
- WorkBuddy `agent-sdk-dev`：1 prompt / 2 agents / 1 工具，`validate` 15 项 0 失败，`build` 后 `mcp-smoke` 7/7。
- WorkBuddy `game-dev-studio`：9 agents，`validate` 20 项 0 失败。
- 自有 `hello-upp`（反向基线）：代理路径 `--cli describe` 返回 `{"ok":true,...}`，`ANALYSIS.md` 估算 379 token。

## 3. 分析器：确定性流水线（构想 ③ 的可实现部分）

```
源目录 ──S1 静态扫描──▶ 文件树+字节+SHA256 ──S2 能力清单──▶ capability-inventory.json
                                              ├─S3 语义摘要──▶ summary.md + summary.json
                                              └─S4 复刻指令包─▶ replication-brief.json/.md
```

| 阶段 | 产物 | 确定性 | 依赖 LLM |
| --- | --- | --- | --- |
| S1 静态扫描 | 文件清单 + 类型/字节数/SHA256 | **100%**（纯文件 IO） | 否 |
| S2 能力清单 | `capability-inventory.json`（§3.1） | **100%**（清单字段 + frontmatter 键值 + JSON 路径） | 否 |
| S3+S4 摘要与 brief | `summary.json/md` + `replication-brief.json`（§3.2/§3.3） | 模板化 + **确定性提取** | 否（增强才用） |

**关键约束**：S1–S4 全链不执行源代码、不联网、不读宿主配置，因此**不接 LLM 也能产出可用结果**——只是摘要更像"索引"而非散文。
这恰好符合"极低 token"目标：目的不是写得漂亮，而是让另一端**先读 brief 再决定要不要读全文**。

### 3.1 `capability-inventory.json` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `capabilityVersion` / `source.{host,id,version}` | `"1.0"` / string | schema 版本 / 来源三元组 |
| `items[].kind` | `skill`\|`tool`\|`cli`\|`subagent`\|`mcp`\|`host-api`\|`ui`\|`hook`\|`asset` | 能力类别 |
| `items[].id` | string | 宿主内稳定 id（Accio skill=目录名；DSH tool=注册名） |
| `items[].contract` | `"P0"`\|`"P1"`\|`"P2"`\|`"BLOCKED"` | 依 [01-spec.md](01-spec.md) §8 判定 |
| `items[].portableTo` / `items[].bytes` | `["dsh","workbuddy","accio"]` 子集 / number | 预计可落地宿主 / token 预算用体积 |
| `items[].evidence` / `items[].dependsOn` | `{path, line?}` / string[] | **每条必须有文件证据**（无证据即 BLOCKED）/ 依赖（CLI、host-api 等） |

确定性判定规则：出现 `hostServices`/`requiredBuiltinTools`/`rpaScriptAssets` → `BLOCKED` 或 `P2`；出现
`renderers`/`ui`/`hooks`/`lsp` → `P2`；纯 `SKILL.md` + `node-cli` → `P0`；`npm-package`/原生依赖 → `P1` 且强制 `needsHuman`。

### 3.2 语义摘要（人读一页 + 机读一页）

| 输出 | 内容 | 预算 |
| --- | --- | --- |
| `summary.json` | 每能力 `{id, kind, contract, oneLine, evidence}` | ≤ 80 B / 项 |
| `summary.md` | 按"能做什么 / 依赖什么 / 缺什么"三段 | ≤ 300 B/技能；≤ 120 B/工具 |

`oneLine` 是**抽取而非生成**：Accio 取 `description` 字段，WorkBuddy 取 `plugin.json.description` 或 `SKILL.md` frontmatter 的
`description`，DSH 取 `ctx.tools.register` 的 `description` 字面量；缺失则填 `"(no description in source)"` 并记一条 `gap`——**不许 LLM 猜**。

### 3.3 复刻指令包 `replication-brief` 与"极低 token"预算

预算用**字节**而非 token 表述（字节确定可测，token 依赖分词器）；换算按 **3.5 B/token（中英混排经验值）** 标注。

| 产物 | 预算 | 约合 token | 依据 |
| --- | --- | --- | --- |
| 整个 brief | ≤ 4 200 B | **≤ 1 200** | 另一端读完即可开工 |
| 每个工具条目 | ≤ 420 B | ≤ 120 | 名称+描述+schema 摘要+错误码 |
| 每个技能摘要 | ≤ 1 050 B | ≤ 300 | 触发条件+步骤骨架+证据路径 |
| 每条验收用例 | ≤ 210 B | ≤ 60 | 输入 + 期望 `{ok,code}` |
| `alwaysLoaded` 常驻 | ≤ 2 048 B | ≈ 585 | 与 [01-spec.md](01-spec.md) §3 `tokenBudget.alwaysLoadedBytes` 同口径 |

```json
{ "briefVersion": "1.0", "source": { "host": "accio", "id": "hello-toolkit", "version": "1.0.0" },
  "oneLine": "把选中的文件转成 Markdown 摘要。",
  "contract": [ { "tool": "summarize_file", "description": "Summarize one file to Markdown.",
      "input": { "path": "string (required)", "maxChars": "number (default 4000)" },
      "result": "{ok:true,data:{markdown,truncated}} | {ok:false,code}", "errors": ["E_INVALID_INPUT", "E_IO"],
      "budgetBytes": 380 } ],
  "skills": [ { "id": "summarize", "whenToUse": "…", "steps": ["…"], "evidence": "skills/summarize/SKILL.md",
      "budgetBytes": 640 } ],
  "nonPortable": [ { "item": "renderers.summary-card", "contract": "P2", "reason": "Accio UI slot" } ],
  "acceptance": [
    { "id": "happy-1", "kind": "happy", "tool": "summarize_file", "input": {"path":"README.md"}, "expect": {"ok": true} },
    { "id": "error-1", "kind": "error", "tool": "summarize_file", "input": {}, "expect": {"ok": false, "code": "E_INVALID_INPUT"} } ],
  "gaps": ["无结果 Schema 证据：仅能从示例输出推断"] }
```

验收用例由**确定性规则**生成：每工具一条 happy（按 schema required 字段填类型默认值）+ 一条 error（删必填字段，期望
`{ok:false,code:"E_INVALID_INPUT"}`，见 [01-spec.md](01-spec.md) §4.1 错误信封）+ 一条 `cli-parity`
（CLI 与 MCP 结果 deep-equal，见 [01-spec.md](01-spec.md) §4.2）——都可机器判定，不依赖人读。

### 3.4 确定性提取 vs 可选 LLM 增强

| 环节 | 无 LLM | 有 LLM | 允许 LLM 改写哪部分 |
| --- | --- | --- | --- |
| 复刻建议 / 语义摘要 | 摘要抽取 `description`；复刻建议留空 | 摘要可润色为中文；可给 handler 骨架 | 允许，但必须标 `"polished":true` / `"llmGenerated":true` |
| 能力清单 / 验收用例 | 字段直取；规则生成 | 同左（LLM 不参与） | **不允许**（否则无法判定） |

**已实现（P1.5，可选，默认关闭）**：`analyze --polish` 走 OpenAI 兼容 `/chat/completions`，产物只追加 `ANALYSIS.md` 的“LLM 增强摘要”（摘要 / 逐工具描述 / 复刻提示 / 风险）并写 `contract.json.llm`；描述项先按 `contract.json.tools` 过滤，不会新增或改写工具、Schema、验收用例。`--strict-polish` 在缺 env / HTTP 失败 / 非 JSON 回包时退出码 1；默认 `analyze` 不联网。离线测试：`tests/polish.test.mjs`（9 项断言，含 mock 与“默认不调用”）。

---
## 4. 为什么"复制粘贴式复刻"不能替代 UPP 运行时

| 失败模式 | 机制 | 本机证据 |
| --- | --- | --- |
| 宿主专有 API 不存在 | 另一端无同名 RPC/内置工具，复刻件一调用即失败 | `hostServices` 16 方法、`requiredBuiltinTools` 的 `browser_rpa_*` |
| 隐式权限被放大或绕过 | 同一脚本在 A 端受四策略约束，在 B 端以用户身份直跑 | Accio `allow/ask/ask_once/deny`；WorkBuddy「Skill 脚本由通用 Bash 执行，**无 skill 级沙箱**」 |
| 运行时状态丢失 / 行为漂移无检测 | DSH 工具/服务活在宿主进程内（Service/Event），跨进程复制只剩函数体；复刻件无版本锚点，源插件 0.4.7→0.5.0 后静默分叉 | DSH `ctx.tools.register` 与 4 种 Event mode；无 `uppVersion`/conformance 即无法发现漂移 |
| token 成本爆炸 | 把全部技能正文喂给模型 | 样本 24 个 `SKILL.md` 共 432 722 B ≈ 108k–124k token，是 §3.3 常驻预算 2 048 B 的 **200 倍以上** |

```
能力必须宿主进程内 API（UI 插槽 / hooks / RPA / host service）？ ──是──▶ 该宿主原生实现，不进 UPP（P2 声明+warn）
└─否─▶ 纯函数式（输入 → JSON 输出，无宿主状态）？ ──是──▶ UPP 便携（P0）：一份 MCP tool + CLI，三端共用
        └─否─▶ 依赖本地文件/网络/子进程？ ──是，且能用 UPP_DATA + permissions 表达──▶ UPP 便携（P0/P1）
                └─否（隐式权限 / 进程内状态 / 原生依赖）──▶ 复刻（短生命周期）或放弃
```

**结论**：复刻只是一次性知识搬运，产物没有 conformance、没有版本锚点、没有跨端一致性；UPP 的 P0 契约是"同一工具名、
同一 input schema、同一结果 JSON 在三端 deep-equal"，这只有**一份代码三处安装**能做到。

---
## 5. 与用户三个原始构想的关系

| 原始构想 | 落点 | 结论 | 理由 |
| --- | --- | --- | --- |
| ① 通用核心 + 三端接口 | UPP 的 **runtime 层**（`runtime/server.mjs` 一份代码 + MCP/CLI 双模） | **可行（已实现）** | 三端共性面 = MCP stdio + CLI；`conformance` 的 MCP smoke 7/7 + CLI parity 通过，DSH/WorkBuddy 端到端实测 |
| ② docker 式容器：打包任意插件 | UPP 的**适配器 + 安装器**（超集目录 + `upp install`） | **部分可行（取其意弃其形）** | 三端**没有容器运行时**；UI 插槽/hooks/RPA 依赖宿主进程内 API，跨进程无法移植。能做的是"安装形态容器化"，不是"运行时容器化" |
| ③ 拆解插件 → 生成复刻文档 | 本文的 `import` + analyzer 流水线 | **部分可行** | 静态可提取（清单/Schema 字面量/技能）100% 自动；handler 语义、宿主专有 API、隐式权限**无法**保证一致 → 迁移辅助，不替代运行时 |

---
## 6. 端到端评估示例（只评估，不执行迁移）

### 6.1 `examples/hello-upp`（UPP 原生包，反向基线）

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| `upp.json` / `tools.json` / `SKILL.md` | 951 B / 473 B / 826 B | `examples/hello-upp/` |
| 三端 MCP 落点 | DSH 与 WorkBuddy **已连通**；Accio Gateway 未启动（app 未运行） | [09-poc-report.md](09-poc-report.md) |
| conformance | `verify` 12 项全绿 + smoke 7/7 + parity | 同上 |
| 结论 | 原生 UPP 包**本来就不需要 import**；它证明"三端共用一份 runtime"是成本最低路径 | — |

### 6.2 真实 Accio 插件 `ecommerce-automation-toolkit` 0.4.7

| 维度 | 实测 | 迁移判定 |
| --- | --- | --- |
| 体积 / 技能 | 57 463 594 B；`skills/` 51 425 313 B；21 个技能目录但 **24** 个 `SKILL.md` | P0 可搬，但 `ecommerce-search/store-monitor`、`platforms/pinduoduo` 是**嵌套** `SKILL.md`——DSH 不扫描嵌套，需扁平化（人工确认） |
| CLI | `ecomctl`（npm-package `@accio-ai/ecommerce-cli@0.4.11`）、`ecom-dash`（node-cli `scripts/dashboard-cli.cjs`） | `ecom-dash` → P0 复用；`ecomctl` → **BLOCKED**（零依赖 + 需联网安装） |
| 技能正文 | 432 722 B；最大单技能 `ecommerce-search/SKILL.md` 51 674 B | 须重写为"常驻摘要 ≤2 048 B + 按需加载"，否则违反 §3 `tokenBudget` |
| `hostServices` + `requiredBuiltinTools` | 16 个 `ecommerce.*`/`dashboard.*`/`catalog.*` 宿主 RPC；5 个 `browser_rpa_*` 内置工具 | **BLOCKED**：Accio 宿主进程内能力，另两端无对应物 |
| `rpaScriptAssets` / `dependencies` | 8 个 `{path,sha256,allowedHosts[]}`；`better-sqlite3` 12.9.0（原生模块） | RPA → P2（哈希+域名白名单是**好实践**，见 [08](08-security-and-supply-chain.md)）；原生依赖 → **BLOCKED**（违反零依赖） |
| `subAgents` / i18n | 无 `subagents/`；有 `resources/i18n.json`（entries 格式） | 子代理不适用；i18n → P1 可搬 |
| 综合 | P0 23 / P1 2 / P2 11 / BLOCKED 4 | **部分可迁移**：技能层可带走，业务执行层不可——它依赖的是"Accio 这个宿主"，不是"插件自己" |

---
## 7. 实施状态与明确不做的部分

| 能力 | 状态 |
| --- | --- |
| `upp import` / `upp analyze`（识别 + 静态提取 + 报告/简报） | 【已实现】`--out` 写包；`--analyze` 写 `ANALYSIS.md` + `contract.json`；无上游 MCP 时生成 describe 兜底，有上游时生成 stdio 代理 |
| 超集目录生成（`generate()` 的 6 个派生文件） | 【已证实】已实现，`build --check` 可查漂移 |
| capability inventory / summary / replication brief | 【已实现】`IMPORT-REPORT.md`（抽取表/P2 gaps/下一步）+ `contract.json`（tools/schema/skillIds/cli/错误码/复刻步骤/token 估算） |
| `--probe-exec`（执行源插件拿真实 Schema）；自动改写 handler 业务逻辑；自动迁移 P2 | **v1 不做**：前两者等于执行不受信任代码或猜语义；P2 只声明存在并 warn |
| `analyze --polish`（可选 LLM 润色） | 【已实现】默认关闭；只润色摘要/描述/提示，**不改**契约；离线 mock 测试 9 项全绿；数据外发仅 contract 元数据（见 08 §4） |
