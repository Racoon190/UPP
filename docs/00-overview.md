# UPP：一次开发，三端原生运行

**Universal Plugin Package（统一插件包）v1** —— 一份插件产物，不改一行代码、不装额外运行时、不增加用户步骤，即可在
**DeepSeek Harness**、**WorkBuddy**、**Accio Work** 三款桌面端安装并像原生开发一样使用。

> 本目录是可交付的方案 + 规范 + 工具链 + **实机验证过的 PoC**。P0 已在本机三端落盘，其中 DSH 与 WorkBuddy 的 MCP 通道已端到端跑通（真实子进程、真实协议调用），详见 [09-poc-report.md](09-poc-report.md)。

---

## 1. 问题：三端插件生态互不相通

| | DeepSeek Harness | WorkBuddy | Accio Work |
| --- | --- | --- | --- |
| 底座 | Cordis（bundle/patch） | CodeBuddy（Claude Code 血统） | Electron（Claude 插件血缘） |
| 插件形态 | npm bundle + `cordis.patch.yml` | `.codebuddy-plugin/plugin.json` | `plugin.json` + `skills/`+`clis/` |
| 扩展点 | Host Tool/Service/Event + Client UI 插槽 | skills/mcp/commands/agents/hooks/rules/lsp | skills/clis/subAgents/MCP/renderers |
| 技能 | `.dsh/skills`、`~/.dsh/skills` 等 5 级 | `~/.workbuddy/skills/<id>/SKILL.md` | `~/.accio/accounts/<acct>/skills/<id>/` |
| MCP | `@deepseek-ai/dsh-mcp-client` bundle | `~/.codebuddy/mcp.json` | 应用内 Gateway + `accio-mcp-cli` |
| 安装入口 | profile manager | 市场/插件安装 | `/skills/local-install`、`POST /plugins/import-local` |

三套体系各写一份 = 三份测试、三份文档、三份权限声明。**UPP 的做法不是抽象出一层新 SDK，而是找出三端已共同拥有的最小面**，把插件做成"同目录、多清单、自适应"的超集。

## 2. 为什么不是另外三种方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| ① 通用核心 + 三端各自 SDK 接口 | 采用（成为 UPP 的 runtime 层） | 思路正确，但"分别暴露接口"仍需三端代码；UPP 把它压缩成**一个** MCP+CLI 双模运行时 |
| ② docker 式通用容器，打包任意插件 | 不可行（取其意，弃其形） | 三端都没有容器运行时；UI 插槽/hooks/RPA 依赖宿主进程内 API，跨进程无法移植。UPP 用"适配器 + 超集目录"实现**安装形态**的容器化，而非运行时的容器化 |
| ③ 拆解插件→生成复刻文档 | 部分可行（并入 UPP 的 `import`/analyzer） | 静态提取能力清单/工具 Schema/技能可 100% 自动；宿主专有 API、隐式权限、行为语义无法靠"复制粘贴"保证一致 → 作为迁移辅助，不替代运行时 |

## 3. 架构：四层

```
┌──────────────────────────────────────────────────────────────┐
│ L4 分发   .upp 包（ZIP）/ 本地目录 / 内网源 / 可选 SHA256     │
├──────────────────────────────────────────────────────────────┤
│ L3 适配   adapters/{dsh,workbuddy,accio}.mjs → 三端原生落位   │
├──────────────────────────────────────────────────────────────┤
│ L2 通道   MCP 工具 → CLI → 技能指令（逐级自动降级，带 channel）│
├──────────────────────────────────────────────────────────────┤
│ L1 核心   upp.json（真源）+ runtime/server.mjs（零依赖）+    │
│           skills/<id>/SKILL.md（何时用/怎么用/失败怎么退）    │
└──────────────────────────────────────────────────────────────┘
```

- **L1 只写一次**：所有业务逻辑在 `runtime/server.mjs`，MCP 与 CLI 调同一 handler，不存在两套实现。
- **L2 是"原生适配"的关键**：模型在三端看到的都是工具 `mcp__<server>__<tool>`；工具不可用时技能自动退到 CLI，用户无感。
- **L3 把差异关进适配器**：每个宿主一个文件，负责"生成什么清单、写到哪个路径、怎么合并配置、怎么回滚"。
- **L4 保证可分发性**：`.upp` 即 ZIP，安装器接受目录或包，离线可用。

### 超集目录（一份产物，三端都是合法包）

```
hello-upp/
  upp.json                     # 唯一真源
  runtime/server.mjs           # MCP stdio + CLI
  skills/hello-upp/SKILL.md    # 三端通用的技能层
  .claude-plugin/plugin.json   # Accio + CodeBuddy 认得
  .mcp.json                    # WorkBuddy 插件内 MCP
  clis/clis.json               # Accio 插件内 CLI
  package.json                 # DSH bundle
  cordis.patch.yml             # DSH MCP 行（.tpl 模板 + 安装时替换入口）
```

## 4. "像原生一样"的判据

| 判据 | 定义 | 现状 |
| --- | --- | --- |
| **安装 0 步** | 一条命令完成；无需重启宿主（或仅宿主本来的刷新） | DSH ✅ 装完即热加载；WorkBuddy ✅ MCP 配置即生效、技能目录热重载；Accio ✅ 技能落盘 + 配置启用；MCP 由安装器读 Gateway 凭据自动注册（应用需在运行）|
| **使用 0 学习** | 模型通过统一工具名/技能描述即可用，用户不需要知道"这是移植插件" | ✅ 三端工具名一致 `mcp__<server>__<tool>` |
| **行为 0 差异** | P0 契约同输入同输出、同错误码 | ✅ 同进程同运行时；已用 conformance（MCP smoke 7/7 + CLI parity）与 DSH 实调验证 |

## 5. "100% 可移植"的严格定义

UPP 承诺的是**契约范围内的 100%**，而不是"任何插件的一切都能无损搬运"：

- **P0（承诺 100%，逐端实测）**：工具名、输入 JSON Schema、结果 JSON、错误码、CLI 行为、技能可发现性、安装/卸载幂等。
- **P1（承诺功能等价，能力映射已实现并实测）**：提示词/命令、子代理、i18n、推荐提示——见 [11-p1-mapping.md](11-p1-mapping.md)；迁移器/分析器已实现并真机验收——见 [07-migration-and-analyzer.md](07-migration-and-analyzer.md)。
- **P1（已部分落地）**：`ui` 面板技能（三端技能镜像；Accio 额外解析 `renderers`）、`agents` / `prompts` / `i18n` / `recommend` 三端原生形态或语义降级。
- **P2（明确不承诺）**：Client UI 插槽（DSH/WorkBuddy 原生 UI）、可拦截事件 hooks、LSP、RPA、宿主专有沙箱。适配器忽略并告警。
- **P2 试点（已实现，能力受限）**：WorkBuddy `observe` 钩子（`SessionStart/SessionEnd/PostToolUse`，永远 exit 0），`hooks/hooks.json` + 脚本契约经 WorkBuddy 自带 `plugin validate` 验证；拦截类事件（`PreToolUse/Stop`）不做。
- **P1.4 已可生成**：`ui.dsh` → DSH client UI bundle（4 文件零构建形态：`package.json` + 空壳 `index.js` + 手写 `client.js` + 自插入 patch）；一致性经 14 项静态断言，**安装后需重启 DSH**。

任何对外承诺都必须带上这句边界，否则就是虚假的"100%"。详见 [01-spec.md](01-spec.md) §8。

## 6. 实测结论（本机，2026-10-29）

| 端 | 安装 | MCP 工具 | 技能 | 证据 |
| --- | --- | --- | --- | --- |
| DSH | ✅ `install_bundle` | ✅ 会话内出现 `mcp__upp-hello__hello`，实调返回 `{"ok":true,…}` | ✅ 随 bundle | 活体调用 |
| WorkBuddy | ✅ 目录 + `mcp.json` 合并 | ✅ `mcp list` → `upp-hello … ✓ Connected` | ✅ `.skill-list-cache.json` 已收录 `hello-upp`（GUI 运行中热加载） | 缓存 + 底座 CLI |
| Accio | ✅ 技能目录 + `skills_config.json` | ✅ 安装器自动注册 Gateway；`server list` 出现 `upp-hello`、`server tools` 发现 `hello` | ✅ 目录 + 启用条目（运行时按会话扫描） | Gateway API + SDK 日志 |

完整矩阵、证据与待补项：[09-poc-report.md](09-poc-report.md)。

## 7. 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-spec.md](01-spec.md) | **规范**：upp.json、运行时协议、技能层、通道、契约等级、打包 |
| [02-channels.md](02-channels.md) | MCP / CLI / 技能三通道的判定算法、错误语义、token 成本 |
| [03-host-dsh.md](03-host-dsh.md) | DeepSeek Harness 适配详解 |
| [04-host-workbuddy.md](04-host-workbuddy.md) | WorkBuddy 适配详解 |
| [05-host-accio.md](05-host-accio.md) | Accio Work 适配详解 |
| [06-toolchain.md](06-toolchain.md) | `upp` 工具链：detect/build/install/verify/pack/uninstall/conformance |
| [07-migration-and-analyzer.md](07-migration-and-analyzer.md) | 现有插件迁移器 + 插件拆解分析器（构想 3 的落地） |
| [08-security-and-supply-chain.md](08-security-and-supply-chain.md) | 威胁模型、权限映射、回滚与完整性 |
| [09-poc-report.md](09-poc-report.md) | P0 实机验证报告 |
| [10-roadmap.md](10-roadmap.md) | P0/P1/P2 里程碑、验收标准、风险登记 |
| [11-p1-mapping.md](11-p1-mapping.md) | P1 能力映射：prompts/agents/i18n/recommend 三端落地与降级 |
| [12-repo-health.md](12-repo-health.md) | 仓库基线（commit/tag）、清理口径、`upp doctor`、发布前复现矩阵 |

## 8. 快速开始

```bash
cd upp
node tools/upp.mjs detect                              # 探测三端安装位置与 CLI
node tools/upp.mjs validate                            # 清单 + 包结构 12 项校验
node tools/upp.mjs build                               # 由 upp.json 生成三端派生物
node tools/upp.mjs install --hosts dsh,workbuddy,accio # 落盘安装（写前自动备份）
node tools/upp.mjs verify                              # 宿主侧 28 项断言
node tools/upp.mjs conformance                         # 规范 + MCP smoke + CLI parity
node tools/upp.mjs pack --out dist                     # 产出 .upp
```

**用户视角（拿到 `.upp` 之后）只需一条命令**：

```bash
node tools/upp.mjs install --from dist/hello-upp-1.0.0.upp
```

它会解到 `~/.upp/store/<id>/<version>`，再写三端原生位置：DSH 用 profile 依赖登记 + `dsh plugin install`，WorkBuddy 拷技能 + 写 `mcp.json`，Accio 拷技能 + 写 `skills_config.json`，并在应用运行时读取 Gateway 凭据自动 `server add`（已存在则 `server update`）。细节见 05 篇。

> 新插件用 `node tools/upp.mjs init --id <id> --dir <dir>` 脚手架：自动改写 `upp.json`、`serverName`、技能名并生成五份派生清单；随后 `validate → conformance` 即可发版。

## 9. 最小可运行示例

`examples/hello-upp` 只有 9 个文件、约 400 行，却同时是三端的合法插件：一个 `hello` 工具、一个 `upp-hello` 命令、一个技能，返回 `{"ok","message","server","host","version","pid"}`。它是规范的"活文档"，也是 conformance 的基准包。

## 10. 边界与诚实声明

- 三端内部格式**没有公开稳定契约**，本方案基于本机实测（版本见 [09-poc-report.md](09-poc-report.md)）；宿主升级可能破坏适配器 → 用 `upp doctor` 与版本矩阵兜底。
- Accio 的 MCP 写入口仍是 Gateway、WorkBuddy 仍需宿主重读配置：**应用必须在运行**。安装器在运行时全自动（Accio 凭据由应用自己写给 CLI：`<account>/.accio/runtime/gateway-cli.json`），未运行时只退化到"启动后重跑 install"，不是另一次手工配置。
- P2 能力（UI/hooks/RPA）不承诺跨端；需要时请为各端单独开发，UPP 负责其余 80% 的确定性部分。
