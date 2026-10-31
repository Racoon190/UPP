# UPP 交付手册（团队 / 用户版）

> 这份手册面向两类人：**装插件的人**（3 分钟）和**做插件的人**（30 分钟）。
> 不需要读规范也能用；需要细节时按链接进 `docs/`。
> 版本基线：`upp-v1.0.0`（GitHub `Racoon190/UPP`，main 绿色 CI）。

## 1. 你拿到的是什么

一套跨三端的插件标准 + 工具链，不是又一个运行时：

| 交付物 | 是什么 | 在哪 |
|---|---|---|
| `upp` 全局命令 | 安装/校验/打包/离线包/分析迁移 | `~/.upp/bin/upp`（`upp setup-cli` 安装） |
| UPP 规范 | 一个插件怎么写才能三端通吃 | [01-spec.md](01-spec.md) |
| 工具链源码 | 零依赖 Node，单文件 2,700 行 | `upp/tools/upp.mjs` |
| 示例插件 ×2 | `hello-upp`（最小）、`hello-upp-ui`（面板） | `upp/examples/` |
| 生产力插件 | `doc-toolkit`（本地文档/表格解析） | [13-productivity-plugin.md](13-productivity-plugin.md) |
| 分发产物 | `.upp` + `.sha256` + `.sig.json` + 离线一键包 | `dist/`、`upp pack` / `bundle-offline` |

一句话：**写一个零依赖 Node MCP server（它同时是 CLI）+ 一份 `upp.json` + 一个 `SKILL.md`，
三端各自用自己的原生机制装进去。**

## 2. 给最终用户：装一个插件

### 方式 A：离线一键包（最省事，推荐给非开发同学）

拿到 `offline-<id>-<version>.zip` 后：

1. 解压到任意目录；
2. Windows 双击 `install.cmd`，macOS/Linux 执行 `sh install.sh`；
3. 脚本自动完成：校验哈希与签名 → 三端安装 → 自检并打印结果。

无需网络、无需 npm、无需 Node 之外的依赖（Node 18+，本机 `node -v` 确认即可）。

### 方式 B：一条命令（机器上已有 `upp`）

```bash
upp verify-signature --from hello-upp-1.0.0.upp --require
upp install --from hello-upp-1.0.0.upp --hosts dsh,workbuddy,accio
upp verify --pkg ~/.upp/store/hello-upp/1.0.0
```

`install` 会先校验 sha256（可选 ed25519 签名），再解到稳定 store `~/.upp/store/<id>/<version>/`，
最后按宿主流派登记——不会出现"源码目录被改了就跟着变"的情况。

### 方式 C：第一次使用，先装全局命令

```bash
node tools/upp.mjs setup-cli          # 写 ~/.upp/bin/upp(.cmd)，并把该目录加入用户 PATH
# 新开一个终端后：
upp detect                            # 看到三端与 CLI 路径
upp doctor                            # 9 项体检（node/profile/skills/mcp/gateway/CLI 版本…）
```

## 3. 给插件作者：30 分钟做一个三端插件

```bash
upp init --id my-plugin --dir ../my-plugin     # 生成 upp.json + runtime + skills + 三端清单
cd ../my-plugin
# 1) 改 runtime/server.mjs 的 HANDLERS（业务逻辑，本地执行）
# 2) 改 runtime/tools.json（工具名、description、inputSchema；description 写"何时用"）
# 3) 改 skills/my-plugin/SKILL.md（三步探测：MCP → CLI → 纯技能）
upp validate --pkg .          # 规范 + tokenBudget 门槛
upp build   --pkg .           # 生成三端清单与 DSH patch
node ../upp/tests/mcp-smoke.mjs .   # MCP/CLI 同数据断言
upp install --pkg . --hosts dsh,workbuddy,accio
upp verify  --pkg .
```

写插件的三条硬规则：

1. **业务逻辑只在本地跑**：插件内部不调用模型（唯一例外是 `upp analyze --polish`，默认关闭且显式配环境变量才联网）；
2. **模型可见面最小**：工具只暴露必要参数；重活藏在代码/技能脚本里按需调用；`tokenBudget.alwaysLoadedBytes` 由校验器强制；
3. **结果统一信封**：`{ok, data, channel, host, elapsedMs}`；错误码只用
   `INVALID_ARGS / NOT_FOUND / PERMISSION_DENIED / TIMEOUT / UPSTREAM_ERROR / INTERNAL`。

## 4. 已有插件迁移（不必重写）

```bash
upp import ~/.workbuddy/plugins/marketplaces/xxx/plugins/foo --out imports/foo --analyze
```

- 自动识别来源（UPP / WorkBuddy / Claude / Accio / 通用 plugin.json），抽取工具、技能、命令、子代理、CLI、MCP 声明；
- 有上游 MCP server 时生成**透明代理运行时**（工具契约名不变，请求原样转发）；
- 没有上游时生成 `describe` 兜底工具，保证三通道契约成立；
- `--analyze` 额外产出 `IMPORT-REPORT.md` + `ANALYSIS.md` + `contract.json`（低 token 复刻契约）；
- 只能搬"声明与元数据"：handler 语义、宿主专有 API、RPA/UI/hooks 会列入 `P2 gaps`，需要人工补齐。

已实测迁入：Accio 电商工具包（21 技能/2 CLI）、WorkBuddy `agent-sdk-dev`、`game-dev-studio`（9 子代理），
`validate/build/mcp-smoke` 全绿。

## 5. 分发与签名

```bash
upp keygen --out ~/.upp/keys                 # 只做一次：ed25519 密钥（私钥 0600）
upp pack --sign --key ~/.upp/keys/upp-signing.key.pem --out dist
# dist/<id>-<ver>.upp + .upp.sha256 + .upp.sig.json（含 keyFingerprint / publicKey / signature）
upp bundle-offline --sign --key … --zip      # 离线一键包（含 vendored 工具链 + install.cmd/sh + manifest）
```

- 接收端：`upp verify-signature --from x.upp --require`；`upp install --from x.upp --require-signature`；
- 篡改 1 字节 → 校验失败、拒绝落盘（回归用例 `tamper-detected`）；
- 私钥不要进仓库；CI 用 GitHub Actions secrets 注入（`.github/workflows/ci.yml` 有产物 job）。

## 6. 三端落点与生效方式

| 宿主 | 技能 | 工具（MCP） | 生效方式 |
|---|---|---|---|
| DeepSeek Harness | `~/.dsh/skills/<id>`（P1 能力还会镜像成技能） | profile 依赖 + `cordis.patch.yml` 一行 `@deepseek-ai/dsh-mcp-client` | MCP **热加载**；client UI 面板需重启一次 |
| WorkBuddy | `~/.workbuddy/skills/<id>` + `upp-local` 本地市场插件 | `~/.codebuddy/mcp.json` 的 `mcpServers.<id>` | 技能 ~3 s 热重载；MCP 随会话重连 |
| Accio Work | `~/.accio/accounts/<id>/skills/<id>` + `skills_config.json` | 读 Gateway 凭据后 `server add`（409→`update`） | 自动注册；renderer 面板需在会话里触发一次 |

共同前提：**宿主应用在运行**（离线安装不依赖宿主，但生效需要宿主）。

## 7. 卸载与回滚

```bash
upp uninstall --pkg examples/doc-toolkit --hosts dsh,workbuddy,accio
```

- 按 `.upp-install.json` 记录逐项删除（技能、mcp 配置、市场条目、profile 依赖/patch 行），有备份文件则还原；
- 升级前用 `upp self-update --from <new upp.mjs>` 备份旧工具链为 `upp.mjs.bak-<ts>`；
- 两个示例均可安全反复安装/卸载（CI 每次全新 runner 验证）。

## 8. 成本模型（为什么省积分）

| 项 | 成本 |
|---|---|
| 插件执行 | **0 模型 token**、0 网络（声明 `network:false` 时校验器强制） |
| 常驻工具面 | 每个插件一次：schema + 技能描述（doc-toolkit 实测 1,461 B ≈ 365 token） |
| 每次调用 | 只有工具返回值进上下文（doc-toolkit 摘要 ≈ 376 token / 6,001 行表） |
| 取用细节 | 按窗口付费（20 行 ≈ 1,522 token），不读整本 |

对照：一本 6,001 行工作簿整本进上下文 ≈ 24 万 token。**这就是"贵的东西留在本地"的量化意义。**

## 9. 承诺边界（请按这个预期使用）

| 等级 | 内容 | 状态 |
|---|---|---|
| P0（100% 可移植，实测） | 工具 / CLI / 技能 / 配置 / 资产管理 / 权限 / 版本 / 安装 / 签名 / 离线包 | ✅ |
| P1（功能等价，允许降级） | prompts / commands / agents / i18n / recommend / UI 面板（DSH client UI、Accio renderer） | ✅ 已实现并实测 |
| P2（不承诺） | 宿主原生 hooks 的全事件与拦截语义（仅 WorkBuddy `observe` 试点）、RPA、LSP、Accio 深度 UI slot | 🟡 试点/边界见 [10-roadmap.md](10-roadmap.md) |

## 10. 常见问题

| 现象 | 处理 |
|---|---|
| 装上后工具没出现（DSH） | MCP 是热加载；client UI 面板需重启 DSH 一次；`upp doctor` 看 `dsh.profile` |
| `upp` 命令找不到 | `setup-cli` 改了用户 PATH，**新开终端**；或直接用 `node ~/.upp/bin/upp.mjs` |
| WorkBuddy 技能没进菜单 | 确认 `~/.workbuddy/skills/<id>/SKILL.md` 存在；3 秒热重载，重启客户端亦可 |
| Accio 注册失败 401/403 | Accio 必须在运行；安装器从 `gateway-cli.json` 取凭据，`upp doctor` 的 `accio.gateway` 应为 ✅ |
| Accio 面板不显示 | 面板需在会话里触发（技能脚本输出 slot JSON，模型回显标记）；见 [05-host-accio.md](05-host-accio.md) |
| 签名校验失败 | 包被改动或公钥不匹配；用 `verify-signature --pubkey` 指定发布公钥重试 |
| 想要更省 token | 精简工具 description、把重活移进插件代码、用 `extract` 窗口而不是整本 |

## 11. 支持与追溯

- 仓库：私有 `Racoon190/UPP`，main 绿色 CI（ubuntu/windows × node 20/22，13 步发布门）；
- 回归：`node tests/run-all.mjs` → 13/13；`upp verify` 28 项；`conformance` 44 项；
- 版本与清理口径：[12-repo-health.md](12-repo-health.md)；
- 本手册对应的实测记录：[09-poc-report.md](09-poc-report.md)、[11-p1-mapping.md](11-p1-mapping.md)、[13-productivity-plugin.md](13-productivity-plugin.md)。
