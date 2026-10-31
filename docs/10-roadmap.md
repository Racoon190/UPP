# 10 路线图与验收

> 本文是"承诺边界"：P0/P1 已交付并可复现；P2 只写边界与试点结论，不做承诺。
> 状态基线：2026-10-29，本机三端实测（Windows 11，DSH 5.x desktop / WorkBuddy 5.9.3 / Accio Work）。

---

## 1. 三层契约（回顾）

| 层 | 内容 | 状态 |
|---|---|---|
| **P0 可移植契约** | 工具（MCP）、CLI、技能（SKILL.md）、配置、权限声明、版本 | ✅ 已实现并实测 |
| **P1 功能等价** | 子代理/命令/推荐提示/i18n/宿主 GUI 入口、迁移器、分析器 | 🟢 已实现：能力映射实测（[11](11-p1-mapping.md)）；`upp import`/`upp analyze` 已实现并对 3 个真实第三方插件验证（[07](07-migration-and-analyzer.md)）；签名/离线包（P1.3）与 DSH UI 生成（P1.4）已实现 |
| **P2 宿主原生** | 原生 UI 组件、hooks、RPA 资产、LSP、专有事件 | ⛔ 不承诺（适配器降级或拒绝）；仅 WorkBuddy `observe` hooks 试点（§4） |

P0 是"100% 可移植"的全部含义：**声明式能力 100% 落地；命令式宿主扩展不承诺。** 任何声称"连 UI 都能 100% 搬"的方案都是不可验证的。

---

## 2. P0 验收矩阵（本机实测）

| # | 验收项 | 判据 | DSH | WorkBuddy | Accio | 证据 |
|---|---|---|---|---|---|---|
| 1 | 零手工配置安装 | `upp install` 后无手工编辑 | ✅ profile 自动登记 | ✅ skills+mcp.json | ✅ 技能落盘 + Gateway 自动注册（凭据自动发现） | [09](09-poc-report.md) |
| 2 | 工具可调用 | MCP `tools/call` 返回统一信封 | ✅ 会话内直接调用 | ✅ CLI `✓ Connected` | ✅ `server test` → 1 tool；SDK 日志 connectStdio 到本包 runtime | [03](03-host-dsh.md)/[04](04-host-workbuddy.md)/[05](05-host-accio.md) |
| 3 | 技能可发现 | SKILL.md 出现在宿主技能列表 | ✅ 技能目录出现 `hello-upp` | ✅ `.skill-list-cache` 收录（watch 3s） | ✅ 目录 + `skills_config`（运行时会话扫描） | 同上 |
| 4 | CLI 兜底 | `node runtime/server.mjs --cli` 可跑 | ✅ | ✅ | ✅ | 06 篇 §8 |
| 5 | 三端同一份产物 | 一次 `pack` 三端安装 | ✅ | ✅ | ✅（技能） | 09 篇 |
| 6 | 无额外 token 成本 | 技能常驻字节 ≤ 1 KB | ✅ 826 B | ✅ | ✅ | 01 篇 §8 |
| 7 | 可卸载 | `upp uninstall` 精确回滚 | ✅ | ✅ | ✅ | 06 篇 §5 |
| 8 | 可复现 | 同一 `.upp` 装到第二台机结果一致 | ✅ store 路径隔离 | ✅ | ✅ | 09 篇 §7 |

**运行态两格已闭环（2026-10-29 22:20–22:27）**：

```bash
node upp/tools/verify-in-app.mjs --pkg ~/.upp/store/hello-upp/1.0.0   # passed 11, failed 0
```

- WorkBuddy：GUI 运行后 `.skill-list-cache.json` 收录 `hello-upp`；`mcp list` → `✓ Connected`；
- Accio：`install --hosts accio` 自动注册（读 `gateway-cli.json` 凭据）→ `server test` → `✓ connected — 1 tool(s) discovered`；SDK 日志证明 runtime 被拉起；
- 拉起方式：`explorer.exe "<install>\WorkBuddy.exe"` / `explorer.exe "<install>\Accio.exe"`（`Start-Process` 会被单实例/会话隔离吞掉）。

> 架构结论不变；描述精度已修正为：**三端都可零手工配置，前提是宿主应用在运行**。

---

## 3. P1：从"能装"到"能搬"

### P1.1 迁移器 `upp import`（✅ 已实现，实测 3 个真实插件）
- 输入：现有插件目录 + 来源声明；
- 输出：`upp.json` 草稿、`runtime/server.mjs` 骨架、`import-report.json`（高/中/低置信度提取项、必须人工确认项）；
- 验收：把本机 `ecommerce-automation-toolkit` 迁移为可 `conformance` 通过的 UPP 包；报告里每个"未迁移项"都有原因码；
- 明确不做：静默猜测——任何不确定项必须进人工确认清单。

### P1.2 分析器 `upp analyze`（✅ 已实现，contract.json + ANALYSIS.md）
- 输出宿主中立 IR + `capability-inventory.json` + `replication-brief`（含 token 预算）；
- 验收：对同一包，另两端按 brief 复刻后 `conformance` 通过；brief 常驻 token ≤ 3 KB；
- 明确不做：用 LLM 生成"看起来能跑"的代码而不经验证。

### P1.3 分发加固（✅ 已实现，本机实测）
- `pack` 默认产出 `.upp.sha256` sidecar（`sha256sum -c` 兼容）；`pack --sign` 产出 ed25519 detached 签名 `.upp.sig.json`（公钥内嵌 + 指纹）；
- `verify-signature --require [--pubkey <pem>]`：哈希 + 签名 + 指纹钉扎；`install --from` 自动校验，篡改 1 字节即拒绝；
- `bundle-offline`：一键离线目录（vendored `tools/upp.mjs` + `install.cmd`/`install.sh` + `OFFLINE-MANIFEST.json` + 可选 `.zip`），本机双击等价命令实测三端装完 `failed 0`；
- `tests/run-all.mjs`：11 步发版门槛（规范 / 协议 / import fixtures / LLM 润色离线 mock / DSH UI 静态检查 / 签名 / 篡改拒绝 / 离线包），本机 11/11；
- 边界：自签 + 可选指纹钉扎，**不是** CA/信任链（见 08 §6）。

### P1.5 可选 LLM 增强（✅ 已实现，默认关闭）
- `analyze --polish [--strict-polish]`：OpenAI 兼容 `/chat/completions`，env `UPP_LLM_BASE_URL` / `UPP_LLM_API_KEY` / `UPP_LLM_MODEL`；
- 只写 `ANALYSIS.md` 增强段 + `contract.json.llm`，工具描述按契约名过滤，不改 tools.json/Schema；
- 离线验证 `tests/polish.test.mjs`（本地 mock，9 项断言）；数据外发边界见 [08](08-security-and-supply-chain.md) §4.5。

### P1.4 宿主 GUI 深化（🟢 已实现可生成部分：Accio renderers 面板技能 + 三端技能镜像 + DSH client UI bundle 生成）

已落地：`ui` 块 → 生成含 `renderers` frontmatter 的面板技能 + 单文件 HTML + slot 脚本；三端都作为技能安装（DSH 搜索目录可见 `hello-upp-panel`），Accio 额外解析 renderer。
`ui.dsh: true` 时额外生成 DSH client UI bundle（空壳 `index.js` + 手写 classic-script `client.js` + `dsh.client`/`exports`/自插入 patch 行），见 `examples/hello-upp-ui`；13 项静态断言全绿。
未落地/需人工：DSH 侧**安装后需重启**才加载（HMR 不保证 `package.json` 改动生效），本仓库不自动安装；WorkBuddy 原生 UI 无公开 API；Accio slot 自动触发仍需一次会话。
- WorkBuddy：`.codebuddy-plugin/plugin.json` 真插件通道（含 hooks 时的安全门）；
- Accio：`plugin.json` + `clis.json` + `subAgents` 完整通道，`/plugins/import-local` 自动化；
- DSH：client-UI 插槽可选包（`ui/` 目录），仅 DSH 生效，其余端忽略。

---

## 4. P2：明确不承诺

| 能力 | 为什么不做 | 降级方案 |
|---|---|---|
| 宿主原生 UI 组件 | 三端渲染模型不同（DSH slots / Accio renderers+skill-app / WorkBuddy 无公开 UI API） | 用 MCP 工具返回结构化数据 + 技能里的文本渲染说明 |
| hooks / 事件钩子 | Accio 无公开钩子；DSH/WorkBuddy 事件名与语义不同；`PreToolUse/Stop` 可拦截宿主行为、静默 spawn shell | **P2 试点已做**：仅 WorkBuddy `observe` 钩子（`SessionStart/SessionEnd/PostToolUse`，exit 0 不阻塞）；拦截类事件与 DSH/Accio 钩子不承诺 |
| RPA 资产（Accio rpaScriptAssets） | 绑定 Accio 运行时与 allowedHosts | 抽出为独立工具，权限声明式表达 |
| LSP / 语言服务 | WorkBuddy 专有 | 不迁移，文档标注 |
| 市场一键上架 | 三端市场无统一提交协议 | 本地 `.upp` + 离线安装包 |

---

## 5. 风险登记（按"会不会毁掉承诺"排序）

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 宿主内部格式变更（无公开契约） | 高 | 中 | 适配器隔离在 `tools/upp.mjs` 三函数；`doctor` + `verify` 快速定位；文档标注"待验证" |
| Accio Gateway 未启动/令牌轮换 | 中 | 低 | 安装器每次读 `gateway-cli.json` 现取令牌；4097 不可连时才提示"启动后重跑 install" |
| Windows 路径/空格/编码（`D:/Program Files/...`） | 已发生 | 中 | 已修 `spawnSync` 引号问题；统一 `replaceAll('\\','/')`；CI 三平台矩阵（P1） |
| `node` 不在宿主 PATH | 中 | 高 | 适配器优先宿主自带 node；`minNode` 校验；文档给绝对路径方案 |
| 权限越界（插件静默读写） | 低 | 高 | `permissions` 声明 + 宿主侧权限模型（Accio allow/ask/ask_once/deny）；不做隐形提权 |
| "装的是一份、跑的是另一份"（源码 link 漂移） | 已发生 | 高 | store 目录 + `realpath` 校验（06 篇 §4） |
| 用户误以为 P2 也 100% | 中 | 中 | 00/10 篇反复声明；验收矩阵只列 P0 |

---

## 6. 发布门槛（Definition of Done）

一个 UPP 包可以宣称"三端可用"，当且仅当：

1. `upp validate` → `failed 0`；
2. `upp build --check` → 无漂移；
3. `upp conformance` → spec checks 全过、MCP smoke 全过、CLI parity 一致；
4. `upp pack` → 产出 `.upp`，`unpack` 回读与源目录一致；
5. `upp install --from` → 三端 `ok:true`；
6. `upp verify` → `failed 0`；
7. 在三端各完成一次"人机可见"验证（技能列表出现 + 一次真实工具调用），记录到 09 篇式报告。

---

## 7. 时间线（建议）

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 收尾 | ✅ 已完成：三端运行态闭环 + 报告补全 + 凭据自动发现 | — |
| P0 冻结 | 规范/工具链/文档定稿，打 tag `v1.0.0` | 1 天 |
| P1.1/P1.2 | 迁移器 + 分析器 | ✅ 已完成（2026-10-29，3 个真实插件导入验证） |
| P1.3 | 签名与离线安装包 | 1–2 人日 |
| P1.4 | 三端 GUI 深化（按需） | 2–6 人日 |
| P1.5 | 可选 LLM 润色 | ✅ 已完成（离线 mock 9/9） |

---

## 8. 现在就能做的三件事

```bash
# 1) 验证工具链在本机仍全绿
node upp/tools/upp.mjs doctor
node upp/tools/upp.mjs conformance

# 2) 从打包产物重装（用户视角，一条命令）
node upp/tools/upp.mjs install --from upp/dist/hello-upp-1.0.0.upp
node upp/tools/upp.mjs verify --pkg ~/.upp/store/hello-upp/1.0.0

# 3) 宿主运行态闭环探针（含 Accio Gateway 注册状态）
node upp/tools/verify-in-app.mjs --pkg ~/.upp/store/hello-upp/1.0.0
```
