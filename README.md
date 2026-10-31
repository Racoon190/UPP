# UPP · Universal Plugin Protocol v1

**一份插件，三端原生安装**：DeepSeek Harness（DSH） / WorkBuddy / Accio Work。

> 状态：**P0 已实现并三端运行态实测**（Windows 11，2026-10-29）：同一份 `.upp` 安装后，DSH 会话内直接调用工具、WorkBuddy 技能缓存收录 + MCP `✓ Connected`、Accio Gateway 自动注册且 `server test` 发现工具。P0 契约 = 工具（MCP）+ CLI + 技能（SKILL.md）+ 配置 + 权限 + 版本，三端 100% 可移植。
> 宿主原生 UI / hooks / RPA / LSP 明确不承诺（见 [docs/10-roadmap.md](docs/10-roadmap.md)）。

---

## 它解决什么

三款桌面 Agent 各有一套插件格式，生态互不相通。UPP 不发明第四套运行时，而是找到三者**已经共同拥有的最小公共面**，把业务核心收敛到一处：

| 公共面 | DSH | WorkBuddy | Accio Work |
|---|---|---|---|
| MCP server（stdio） | `@deepseek-ai/dsh-mcp-client` 配置型 bundle | `~/.codebuddy/mcp.json` | Gateway `accio-mcp-cli server add` |
| SKILL.md 技能 | skills 根目录 | `~/.workbuddy/skills/<id>/`（3s 热加载） | `skills/<id>/` + `skills_config.json` |
| CLI | 任意 shell | 任意 shell | `clis/clis.json` → shell |

一个插件 = **一个零依赖 Node MCP server（同时是 CLI）** + 一份清单 + 一个技能。三端只需"怎么把这三样接进去"的适配器。

---

## 5 分钟上手

```bash
cd upp
node tools/upp.mjs detect                                   # 探测三端 + CLI 路径
node tools/upp.mjs init --id my-plugin --dir ../my-plugin   # 脚手架新插件
node tools/upp.mjs conformance                              # 规范/MCP/CLI 三合一自检（应 failed 0）
```

安装示例插件（开发者回路）：

```bash
node tools/upp.mjs install --hosts dsh,workbuddy,accio
node tools/upp.mjs verify
node tools/verify-in-app.mjs   # 宿主运行态探针（进程/技能缓存/MCP 健康）
```

从交付物安装（用户回路，一条命令）：

```bash
node tools/upp.mjs keygen                                  # 首次：ed25519 发布密钥
node tools/upp.mjs pack --sign --out dist                  # .upp + .sha256 + .sig.json
node tools/upp.mjs install --from dist/hello-upp-1.0.0.upp # 自动校验哈希/签名后安装
```

给最终用户的**离线一键包**（不需要仓库、npm、网络）：

```bash
node tools/upp.mjs bundle-offline --sign --zip
# dist/offline-hello-upp-1.0.0/ → 双击 install.cmd（或 sh install.sh）即可
```

可选：让分析器用模型润色复刻摘要（**默认关闭**，只发 contract 元数据，不发技能正文/源码）：

```bash
UPP_LLM_BASE_URL=https://api.example.com/v1 UPP_LLM_API_KEY=sk-... UPP_LLM_MODEL=deepseek-chat \
  node tools/upp.mjs analyze examples/hello-upp --out imports/hello-upp --polish
# --strict-polish：缺 env / 调用失败时退出码 1；默认 analyze 完全不联网
```

---

## 写一个自己的插件

复制 `examples/hello-upp`，改三样：

1. **`upp.json`** —— 唯一真源：`id`、`version`、`tools[]`（含 JSON Schema）、`skills[]`、`hosts.*.serverName`、`permissions`；
2. **`runtime/server.mjs`** —— 只改 `HANDLERS`（业务函数）与 `tools.json` 保持同构；MCP 协议、参数校验、信封、CLI 解析已内置；
3. **`skills/<id>/SKILL.md`** —— 给模型的引导：先试 MCP 工具名，再试 server，再降级 CLI；只回最小字段，控制 token。

然后：

```bash
node tools/upp.mjs build            # 生成三端清单（示例 17 个文件，禁止手改）
node tools/upp.mjs conformance      # 发版门槛
node tools/upp.mjs pack --out dist  # 交付物
```

产物 `dist/<id>-<version>.upp` 是标准 ZIP，含 `cordis.patch.yml.tpl`，安装端据此重算绝对路径。

### 一条命令安装（全局 CLI）

```bash
node tools/upp.mjs setup-cli       # 装到 ~/.upp/bin 并加入用户 PATH（Windows 用户级；--no-path 只装不写 PATH）
upp install --from hello-upp-1.0.0.upp --hosts dsh,workbuddy,accio   # 之后任意目录一条命令装插件
```

>= 离线包（`bundle-offline`）内附 `setup-cli.cmd` / `setup-cli.sh`，双击安装器后再执行一次即可全局可用；toolchain 仍是单文件零依赖 `upp.mjs`，`upp` / `upp.cmd` 只是两行启动 shim。

---

## 目录

```
upp/
  docs/                 # 规范与实现文档（见下）
  tools/upp.mjs         # CLI：detect/init/import/analyze/validate/build/install/verify/conformance/pack/
                        #      keygen/verify-signature/bundle-offline/doctor/uninstall
  tests/mcp-smoke.mjs   # 独立 MCP 握手 + CLI parity 测试（不依赖宿主）
  tests/import.test.mjs # 4 个合成插件 fixtures 的 import→validate→build→smoke 矩阵
  tests/polish.test.mjs # 可选 LLM 润色的离线 mock 测试（默认不调用、strict 会失败）
  tests/run-all.mjs     # 发版门槛：12 步全链路（规范/协议/导入/润色/DSH UI/签名/篡改/离线包/全局 CLI）
  fixtures/             # dsh/claude/workbuddy/accio 四种最小来源包，供 import 回归
  examples/hello-upp/   # 超集包：同一目录是三端各自的合法包
    upp.json
    runtime/server.mjs  # MCP stdio + CLI 双模（零依赖）
    runtime/tools.json  # 生成物：工具清单与 Schema
    skills/hello-upp/SKILL.md
    .claude-plugin/plugin.json
    .mcp.json
    clis/clis.json
    package.json + cordis.patch.yml.tpl   # DSH 配置型 bundle
  dist/                 # 打包产物（.upp / .sha256 / .sig.json / offline-*）
```

## 文档

| 文档 | 读它是因为 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | 为什么这样设计、四层架构、三个原构想的取舍、"100%"的严格定义 |
| [docs/01-spec.md](docs/01-spec.md) | **规范正文**：upp.json 字段、MCP/CLI 契约、技能层、通道优先级、契约等级、conformance |
| [docs/02-channels.md](docs/02-channels.md) | 三通道如何判定与降级、错误码、token 成本 |
| [docs/03-host-dsh.md](docs/03-host-dsh.md) | DSH 适配：bundle、patch、profile、reload 语义 |
| [docs/04-host-workbuddy.md](docs/04-host-workbuddy.md) | WorkBuddy 适配：skills 热加载、mcp.json、双体系差异 |
| [docs/05-host-accio.md](docs/05-host-accio.md) | Accio 适配：Gateway、skills_config、插件导入 |
| [docs/06-toolchain.md](docs/06-toolchain.md) | 工具链命令、store 语义、检查项、故障排查、CI |
| [docs/07-migration-and-analyzer.md](docs/07-migration-and-analyzer.md) | 现有插件迁移 `upp import` 与拆解分析 `upp analyze`（v1 已实现 + 真机验收） |
| [docs/08-security-and-supply-chain.md](docs/08-security-and-supply-chain.md) | 威胁模型、权限映射、回滚与完整性 |
| [docs/09-poc-report.md](docs/09-poc-report.md) | P0 实机验证报告：矩阵、证据、问题、复现 |
| [docs/10-roadmap.md](docs/10-roadmap.md) | P0/P1/P2 验收门槛、风险登记、时间线 |
| [docs/11-p1-mapping.md](docs/11-p1-mapping.md) | P1 能力映射：prompts/agents/i18n/recommend 三端落地与降级 |
| [docs/12-repo-health.md](docs/12-repo-health.md) | 仓库基线（commit/tag）、清理口径、`upp doctor`、发布前复现矩阵 |

---

## 第二批交付（P1）

- **声明一次，三端原生**：`prompts[]` 在 WorkBuddy 编译为 `commands/*.md`，在 DSH 镜像为技能；`agents[]` 在 WorkBuddy 是原生 agent、Accio 是 `subAgents[]` + `subagents/<id>/prompt.md` 双确认、DSH 降级为技能镜像；`i18n`/`recommend` 写进 Accio `resources/` 与清单。
- **WorkBuddy 零点击插件安装**：写本地目录市场 `~/.workbuddy/plugins/marketplaces/upp-local` + `known_marketplaces.json` + `installed_plugins.json` + `settings.enabledPlugins`，等价于"添加市场→安装"两步。
- **分发加固**：`.upp` 自带 `.sha256`；`pack --sign` 出 ed25519 签名，`install --from` 自动校验、`--require-signature` 拒绝未签名；`bundle-offline` 一键离线包（双击安装，无需仓库/npm/网络）；`tests/run-all.mjs` 12 步发版门槛（含"篡改 1 字节必须被拒"与全局 CLI 自举）。详见 [docs/06-toolchain.md](docs/06-toolchain.md) §7 / [docs/08-security-and-supply-chain.md](docs/08-security-and-supply-chain.md) §6。
- **实测**：`validate` 42 项 / `verify` 28 项 / `conformance --hosts` 70 项全绿；`tests/run-all.mjs` 12 步全过；DSH 技能目录实时出现镜像；Accio 自动注册 `connected` 且 `server tools` 看到工具。详见 [docs/11-p1-mapping.md](docs/11-p1-mapping.md) 与 [docs/12-repo-health.md](docs/12-repo-health.md)。
- **可追溯基线**：`main` 首次提交 `119f5a7`，标签 `upp-v1.0.0`；`upp doctor` 6 项（5 通过，`accio.gateway` 需 Accio 在运行）。
- **可选 LLM 润色**：`analyze --polish`（默认关闭）把复刻摘要/工具描述润色为中文并写 `contract.json.llm`，工具描述先按契约名过滤、**不改** Schema；离线 mock 测试 9 项全绿；数据外发边界见 [08](docs/08-security-and-supply-chain.md) §4.5。
- **UI 面板（P1.4）**：`upp.json.ui` → 生成含 Accio `renderers` frontmatter 的面板技能 + 单文件 `app/index.html` + slot 脚本；三端都作为技能安装（DSH 技能目录实测可见），Accio 真正渲染需一次应用内会话。边界见 [06](docs/06-toolchain.md) §6.6。
- **观察钩子（P2 试点）**：`upp.json.hooks`（仅 `observe`）→ WorkBuddy `hooks/hooks.json` + 独立脚本，永远 exit 0、不改工具入参；`PreToolUse/Stop` 等拦截类事件不做。边界见 [06](docs/06-toolchain.md) §6.6。
- **DSH 原生面板（P1.4）**：`upp.json.ui.dsh = true` → 额外生成空壳 `index.js` + 手写 classic-script `client.js`（零构建、React 来自宿主 seed），注册到 `conversation.composer.dock`；示例 [examples/hello-upp-ui](examples/hello-upp-ui)。**安装后需重启 DSH**，本仓库不自动安装（避免在会话内重载 UI）。
- **既有插件可搬**：`upp import`/`upp analyze` 已实现；对 3 个真实第三方插件（Accio ecommerce、WorkBuddy agent-sdk-dev / game-dev-studio）导入后 `validate` 35/15/20 项全绿，并产出 `ANALYSIS.md` + `contract.json` 复刻契约。详见 [docs/07-migration-and-analyzer.md](docs/07-migration-and-analyzer.md) §2.5。

---

## 诚实边界

- **能 100% 搬的**：工具语义、CLI、技能、权限声明、版本、数据目录约定；
- **只能降级的**：宿主原生 UI 插槽、可拦截 hooks、RPA 资产、LSP —— 见 10 篇 §4；observe hooks 与面板技能已有 P2 试点/P1.4 落地。
- **需要宿主在运行**：Accio 的 MCP 只能经 Gateway 写入（凭据自动发现），WorkBuddy 需宿主重读 `mcp.json`；安装器在应用运行时全自动，未运行时退化为"启动后重跑 install"；
- 宿主内部格式无公开契约，适配器集中在 `tools/upp.mjs` 的三个函数里，宿主升级时只改那里，并用 `doctor`/`verify` 回归。

---

## 环境要求

- Node ≥ 18（运行时与 CLI 零依赖；不建议用宿主内置 node 时要检查 PATH）
- 三端任一已安装；`detect` 会打印实际探测路径
- 无需网络、无需包管理器、无需注册市场
