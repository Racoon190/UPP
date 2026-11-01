# 06 工具链：`upp` CLI 参考

> **一句话**：`upp.json` 是唯一真源；`upp build` 生成三端各自的清单；`upp pack` 出一个 `.upp`；`upp install` 把它解到稳定 store 并写入三端原生位置；`upp verify`/`upp conformance` 证明"装上了、能跑、三端一致"。
>
> 参考实现：[`tools/upp.mjs`](../tools/upp.mjs)（单文件、零依赖）。本机实测于 Node v26.12.0，规范要求 ≥ 18。

---

## 1. 运行方式

```bash
node upp/tools/upp.mjs <command> [options]
```

| 约束 | 说明 |
|---|---|
| 依赖 | 无。只用 `node:fs/os/path/child_process/net/zlib/url`，不联网、不装包 |
| 平台 | Windows / macOS / Linux；路径一律用 Node `path` 拼接，输出里保留本机分隔符 |
| 输入 | 当前目录下 `examples/hello-upp` 或 `--pkg <dir>`；发布目录用 `--pkg` |
| 输出 | 一行 JSON（`console.log(JSON.stringify(...))`），便于管道/CI 断言 |
| 副作用 | 只写：包目录内派生物、宿主配置文件（带 `.upp-bak-orig` 备份）、`~/.upp/store` |

所有命令的公共参数：`--pkg <dir>`（默认 `examples/hello-upp`）。`--hosts dsh,workbuddy,accio` 用于 install/verify/conformance 限定宿主。

---

## 2. 命令总览

| 命令 | 作用 | 写文件 | 典型用途 |
|---|---|---|---|
| `init` | 从示例脚手架一个新包（改 id/serverName/技能名并 build） | 是 | 新插件起步 |
| `detect` | 探测三端是否安装、路径、Node 版本 | 否 | 首次接入 / 故障排查 |
| `setup-cli` | 把 `upp.mjs` 复制到 `~/.upp/bin`，写 `upp`/`upp.cmd` 启动 shim，Windows 追加用户 PATH（`--no-path` 可跳过） | 是（`~/.upp/bin`、用户 PATH） | 一条命令安装（全局 `upp`） |
| `self-update` | 原地升级 `~/.upp/bin/upp.mjs`：`--from <upp.mjs|dir>`（默认仓库工具链）、`--force` 允许同版本重装/降级；版本比较 + 自动备份 `.bak-<ts>` + 重建 shim + `--version` 自检 | 是（`~/.upp/bin`） | 工具链升级（离线、一条命令）；`upp --version` 查看当前版本 |
| `validate` | 校验 `upp.json` + 包结构（按清单动态，示例 42 项） | 否 | 提交前 / CI |
| `build` | 由 `upp.json` 生成全部派生物（示例 17 个文件，含面板技能与 hooks） | 是 | 开发循环 |
| `build --check` | 只比对不写；有漂移则退出码 1 | 否 | CI 防"忘 build 就提交" |
| `pack` | 打包为 `.upp`（zip，deflate） | 是（dist/） | 交付、分发 |
| `unpack` | 解出 `.upp`（供检查/审计） | 是 | 审计、二次分发 |
| `install` | 安装到宿主；`--from <x.upp>` 先入 store | 是 | 用户唯一需要的命令 |
| `import` | 静态抽取既有插件 → 生成 UPP 包（无上游则 describe 兜底，有上游 MCP 则生成代理 runtime） | 是（`--out`） | 迁移 DSH/WorkBuddy/Accio 既有插件 |
| `analyze` | `import` + 复刻简报 `ANALYSIS.md` + `contract.json`（按 JSON/4 估算 token）；`--polish` 可选 LLM 润色（默认关闭） | 是（`--out`） | 给另两端/模型做低 token 复刻 |
| `verify` | 断言宿主侧安装状态与 live 入口 | 否 | 安装后自检 |
| `conformance` | 规范 + MCP + CLI + 等价性测试 | 否 | 发版门槛 |
| `doctor` | 探测三端 CLI/Gateway/进程 | 否 | 装不上时先跑它 |
| `verify-in-app`（独立脚本） | 只读检查宿主运行态：进程、技能缓存、MCP 健康 | 否 | 补最后两格 / 用户自助排障 |
| `uninstall` | 按安装记录精确回滚 | 是 | 干净卸载 |

退出码：`0` 成功；`1` 校验/断言失败（含 `build --check` 漂移、`conformance` 失败）；`2` 用法错误（未知命令、缺参数）。JSON 里同时带 `failed` 计数，CI 可只看 JSON。

---

## 3. 开发循环（生命周期）

```bash
# 1) 脚手架（或手写三样东西，模板见 examples/hello-upp）
node upp/tools/upp.mjs init --id my-plugin --dir ../my-plugin
# 生成：upp.json / runtime/server.mjs / skills/my-plugin/SKILL.md + 五份派生清单
upp/
  upp.json          # 唯一真源：id/version/runtime/tools/skills/hosts/permissions
  runtime/server.mjs# MCP stdio + CLI 双模入口（照抄模板改 HANDLERS）
  skills/<id>/SKILL.md  # 给模型的引导层（三步探测 + 通道降级）

# 2) 校验清单与结构
node upp/tools/upp.mjs validate

# 3) 生成派生物（六个文件）
node upp/tools/upp.mjs build

# 4) 本地安装（从源码目录）
node upp/tools/upp.mjs install --hosts dsh,workbuddy,accio

# 5) 自检
node upp/tools/upp.mjs verify
node upp/tools/upp.mjs conformance

# 6) 出交付物
node upp/tools/upp.mjs pack --out dist
# 用户侧：
node upp/tools/upp.mjs install --from dist/hello-upp-1.0.0.upp
```

### 3.1 `build` 生成什么（全部可重生成，禁止手改）

| 产物 | 服务端 | 内容 |
|---|---|---|
| `runtime/tools.json` | 全部 | `serverName` + 工具清单与 JSON Schema（MCP 与 CLI 共用同一份） |
| `.claude-plugin/plugin.json` | WorkBuddy / Accio | Claude 布局清单（name/displayName/version/author/category/tags） |
| `.mcp.json` | WorkBuddy | `${CODEBUDDY_PLUGIN_ROOT}` 相对的 stdio server + `UPP_HOST=workbuddy` |
| `clis/clis.json` | Accio | 顶层 `tools[]` + `node-cli` source（可用 shell 调起） |
| `package.json` | DSH | `dsh.bundle.patch` 指向 `cordis.patch.yml`，`files` 白名单 |
| `cordis.patch.yml` | DSH | 由 `cordis.patch.yml.tpl` 替换三占位符生成：`insert` 一条 `@deepseek-ai/dsh-mcp-client` 行，绝对路径指向本包 `runtime/server.mjs` |
| `plugin.json` / `.codebuddy-plugin/plugin.json` | Accio / WorkBuddy | P1：根清单（含 `subAgents[]` 双确认）与 CodeBuddy 清单（`skills/commands/agents` 贡献点） |
| `commands/<pid>.md` / `agents/<aid>.md` | WorkBuddy | P1：`prompts[]`→命令（自动补 `$ARGUMENTS`）、`agents[]`→原生 agent |
| `subagents/<aid>/prompt.md` | Accio | P1：子代理系统提示（与根清单 `subAgents[]` 成对） |
| `resources/i18n.json` / `resources/recommend.json` | Accio | P1：`entries` 字典与推荐提示 |

`build --check` 在 CI 中防漂移：任何派生物与 `upp.json` 不一致即 `failed > 0`、退出码 1。

---

## 4. 稳定 store：为什么不能直接 link 源码

`install --from x.upp` 会把包解到：

```
~/.upp/store/<id>/<version>/        # 本机实例：C:\Users\<user>\.upp\store\hello-upp\1.0.0
```

然后三端全部指向 store，而不是开发目录。原因（P0 实测教训）：

1. DSH 的 `plugin_manager install_bundle` 对本地目录做 `link:`，会话运行期间源码被改会直接影响已"安装"的插件——用户在 IDE 里改一行，插件行为就漂移；
2. 开发目录被 `mv`/`rm` 后，三端配置里的绝对路径全部失效；
3. 升级语义需要"版本目录"，`<id>/<version>` 天然支持并存与回滚。

所以规范是：**开发目录只用于 build/pack；安装只从 `.upp` 进 store。** 源码目录直装（`install --pkg` 无 `--from`）只作为开发者快速回路，文档与验收以 store 路径为准。

---

## 5. 三端安装：写了什么、怎么幂等

| 宿主 | 写入 | 幂等性 | 生效时机 |
|---|---|---|---|
| DSH | profile `package.json`：`dependencies["<pkg>"]="link:<store>"` + `dsh.profile.bundles` 追加；随后 `dsh plugin --profile <name> install` 物化 `node_modules` | 重复执行只是覆盖同一 key / 去重追加 | 下次启动（MCP server 由 patch 行拉起） |
| WorkBuddy | `~/.workbuddy/skills/<id>/` 整目录覆盖；`~/.codebuddy/mcp.json` 的 `mcpServers.<serverName>` 覆盖 | 目录覆盖 + 对象 key 覆盖 | 技能 watch 约 3s 热加载；MCP 在宿主重读 mcp.json 后出现在 GUI |
| Accio | `~/.accio/accounts/<id>/skills/<id>/` 覆盖；`skills_config.json` 写 `{enabled,status,installedVersion}`；应用运行时读 `<account>/.accio/runtime/gateway-cli.json` 凭据并自动 `server add`/`update`，再 `server test` 断言 | 同上 | MCP 必须过 Accio Gateway（127.0.0.1:4097，basic auth）；安装器自动发现凭据，应用未运行才退化为启动后重跑 |

**备份策略**：每个将被覆盖的配置文件，首次写入前复制为 `<file>.upp-bak-orig`（已存在则跳过，保证第一次原始态只留一份）。安装记录写 `<pkg>/.upp-install.json`，`uninstall` 只删记录内的路径/键，不猜。

**WorkBuddy 双通道差异**：`~/.workbuddy/skills` 是"用户技能"，改目录即生效；`.codebuddy-plugin/plugin.json` 才是真插件清单，需要市场/安装两步，P0 不走。

**Accio 凭据自动发现**：Accio 的唯一写入口仍是它自己的 Gateway（HTTP 127.0.0.1:4097，basic auth `phoenix:<token>`）。应用把这套凭据写在自己的 CLI 运行时描述里：`<account>/.accio/runtime/gateway-cli.json`（`url/username/password/pid/createdAt`）。安装器读取后注入 `ACCIO_GATEWAY_TOKEN/ACCIO_GATEWAY_USERNAME/ACCIO_LOCAL_GATEWAY_URL`，即可零手工调用 `server add`；重复安装遇 HTTP 409 自动 `server update <name> --json-file`。令牌随应用启动轮换 → 每次安装重新读取（见 05 篇 §4）。

---

## 6. `verify` 检查项

`verify` 只读断言，逐项输出 `{check, ok, detail}`：

| 宿主 | check | 断言 |
|---|---|---|
| DSH | `dsh.skill` | `~/.dsh/skills/<id>/SKILL.md`（bundle 内技能不会被扫描根直接收录，安装器负责镜像） |
| DSH | `dsh.dependency` | profile `package.json` 有该包且值可用 |
| DSH | `dsh.bundles` | `dsh.profile.bundles` 含该包（否则不挂载） |
| DSH | `dsh.bundle.patch` | `node_modules/<pkg>/cordis.patch.yml` 存在且含 `dsh-mcp-client` + `serverName` |
| DSH | `dsh.patch.entry` | 无残留 `__UPP_` 占位符 |
| DSH | `dsh.live.entry` | patch 里的 `args[0]` 真实存在（store 路径正确） |
| DSH | `dsh.node_modules` | `node_modules/<scope>/<name>` 已物化（`realpath` 应指向 store） |
| DSH | `dsh.skillMirror` | P1：每个 `prompts[]`/`agents[]` 在 `~/.dsh/skills/<id>-prompt-<pid>`、`<id>-agent-<aid>` 有 SKILL.md 镜像 |
| WorkBuddy | `workbuddy.skill` | `~/.workbuddy/skills/<id>/SKILL.md` |
| WorkBuddy | `workbuddy.mcp` | `mcp.json` 有 `<serverName>`，command/args 正确 |
| WorkBuddy | `workbuddy.mcp.entry` | args[0] 存在 |
| WorkBuddy | `workbuddy.plugin.manifest` | P1：本地市场 `marketplaces/upp-local/plugins/<id>/.codebuddy-plugin/plugin.json` |
| WorkBuddy | `workbuddy.plugin.installed` | P1：`installed_plugins.json` 的 `<id>@upp-local` 指向该插件目录 |
| WorkBuddy | `workbuddy.plugin.enabled` | P1：`settings.json` 的 `enabledPlugins[<id>@upp-local]` 为 true |
| WorkBuddy | `workbuddy.command` | P1：每个 `prompts[]` 生成 `commands/<pid>.md` |
| WorkBuddy | `workbuddy.agent` | P1：每个 `agents[]` 生成 `agents/<aid>.md` |
| Accio | `accio.skill` | 账号 `skills/<id>/SKILL.md` |
| Accio | `accio.skills_config` | 该技能 `installedVersion` 与包一致 |
| Accio | `accio.mcp.payload` | 安装载荷文件存在 |
| Accio | `accio.mcp.registered` | `server test` 通过（工具发现；本轮实测 1 tool） |

`failed > 0` 即退出码 1（全量示例 28 项：DSH 10 + WorkBuddy 11 + Accio 7；P1 插件会按 `prompts`/`agents`/`ui`/`hooks` 数量增加）。`--hosts dsh` 时只断言该端检查项（示例：`verify --pkg examples/hello-upp-ui --hosts dsh` → 12 项）。注意：`verify` 证明"宿主配置写对了"，不证明"宿主 GUI 里点了能用"——后者由各篇的宿主侧验证小节给出人工步骤。

---

## 6.5 `import` / `analyze`：把既有插件搬成 UPP 包

```bash
node tools/upp.mjs import <源插件目录> --out imports/<id> [--analyze]
node tools/upp.mjs analyze <源插件目录> --out imports/<id>     # = import + ANALYSIS.md / contract.json
```

- 识别来源：`upp.json`→upp、`.codebuddy-plugin/plugin.json`→workbuddy、`.claude-plugin/plugin.json`→claude、含 `clis/clis.json` 的 `plugin.json`→accio。
- 抽取：manifest、skills、commands/prompts、agents、Accio `subAgents`、`clis/clis.json`、i18n/recommend、MCP server（plugin.json/.mcp.json/mcp.json/cordis.patch.yml）；`hooks/.lsp/rpa/renderers/ui` 只记为 P2 gap，不生成。
- 运行时：无上游 MCP → `describe` 兜底 server（保证三通道契约可用）；有上游 MCP → `probeMcp()` 实测 `tools/list` 后生成 **stdio 代理**（改写 `serverInfo.name` 为契约名，`--cli` 可用）。
- 产物：`upp.json`、`runtime/tools.json`、`runtime/server.mjs`、`IMPORT-REPORT.md`（抽取表/上游/P2 gaps/下一步）、`cordis.patch.yml.tpl`；`--analyze` 额外 `ANALYSIS.md` + `contract.json`。
- 实测：本机三个真实第三方插件（Accio ecommerce 21 skills/2 clis、WorkBuddy agent-sdk-dev、game-dev-studio 9 agents）导入后 `validate` 分别 35/15/20 项全绿；AI 辅助按 `ANALYSIS.md` 复刻的成本样本 379 token（hello-upp 代理路径）。
- 注意：import 只搬"声明与可静态抽取的契约"，handler 业务语义不保证等价（见 [07](07-migration-and-analyzer.md) §2.3 / §7）。
- 可选 LLM 润色：`analyze <src> --out <dir> --polish [--strict-polish]`，默认关闭，需 `UPP_LLM_BASE_URL` / `UPP_LLM_API_KEY`（可选 `UPP_LLM_MODEL`、`UPP_LLM_TIMEOUT_MS`）。只把 contract 元数据发往 OpenAI 兼容 `/chat/completions`；结果只写 `ANALYSIS.md` 的“LLM 增强摘要”与 `contract.json.llm`，描述项被过滤为契约内工具，**不改** `tools.json`/Schema；`--strict-polish` 在缺 env 或调用失败时退出码 1。数据外发边界见 [08](08-security-and-supply-chain.md) §4。

## 6.6 `ui` 面板与 `hooks` 观察钩子（P1.4 / P2 试点）

`upp.json` 新增两个可选块，`build` 生成宿主原生形态，`validate`/`verify` 断言：

```json
"ui": { "rendererId": "hello-panel", "skillId": "hello-upp-panel", "entry": "ui/app/index.html" },
"hooks": [{ "id": "session-log", "event": "SessionStart", "matcher": "startup", "timeoutSeconds": 10, "mode": "observe" }]
```

| 产物 | 落位 | 断言 |
|---|---|---|
| `skills/<skillId>/SKILL.md`（含 `renderers:` frontmatter） | 三端技能目录；Accio 额外解析 renderer，DSH/WorkBuddy 当普通技能 | `accio.ui` / `accio.ui.renderer` |
| `skills/<skillId>/app/index.html` | 面板单文件（禁远程资源、禁直取 `skill-app://app`） | `ui.entry.resize` / `ui.entry.ready` / `ui.entry.remote` / `ui.entry.shared-origin` |
| `skills/<skillId>/scripts/show.mjs` | 打印一行 slot JSON，供宿主注入 `:::slot[...]` | 由宿主解析，无静态断言 |
| `hooks/hooks.json` + `hooks/scripts/<id>.mjs` | `<plugin>/hooks/`，且 `plugin.json.hooks = "./hooks/hooks.json"` | `workbuddy.hooks` / `workbuddy.hooks.manifest` |
| DSH `index.js` + `client.js`（`ui.dsh: true` 时） | 空壳 Host 半边 + 手写 classic-script 客户端，注册到 `conversation.input.dock`（composer 卡片上方）；`package.json.dsh.client` + `exports["./client"]`；patch 自插入包行 | `dsh.ui.client` / `dsh.ui.exports` / `dsh.ui.index` / `dsh.ui.bundle` / `dsh.ui.row` |

边界（诚实标注）：

- UI 面板是**静态单文件 + `ui/ready`/`ui/resize` postMessage 握手**，不是任意 JS 应用；Accio renderer 要出现在对话里仍需要一次应用内会话让技能脚本输出 slot，UPP 不承诺"落盘即渲染"。
- hooks 只生成 `observe` 模式（永远 exit 0、不写 stdout、不改工具入参），事件限 `SessionStart/SessionEnd/PostToolUse`；`PreToolUse/Stop` 会拦截宿主行为，留 P3。
- WorkBuddy 的钩子是否被桌面端加载取决于插件开关与重启：`hooks.json` 结构与脚本契约已用 WorkBuddy 自带 `plugin validate` + 直接执行脚本验证；**未见其运行日志前不宣称端到端生效**。

---

## 7. `pack` / `.upp` 格式

- 容器：标准 ZIP（deflate），单文件 `dist/<id>-<version>.upp`；
- 条目：`upp.json`、`runtime/**`、`skills/**`、生成的 5 个清单、`cordis.patch.yml.tpl`（安装端据此重算绝对路径）；
- 排除：`node_modules/`、`dist/`、`.git/`、`.upp-install.json`、`.upp-accio-mcp.json`、`*.upp-bak-orig`；
- **完整性（默认）**：`pack` 一定写 `dist/<id>-<version>.upp.sha256`（`<sha256>  <file>`，与 `sha256sum -c` 兼容）。
- **签名（可选）**：`pack --sign [--key <pem>]` 额外写 `<file>.upp.sig.json`：
  `{format:"upp-sig/1", alg:"ed25519", file, sha256, keyFingerprint, publicKey, signature, signedAt}`，
  签名对象是 `.upp` 的完整字节（detached），公钥内嵌、指纹为 spki DER 的 sha256 前 16 位。
- **验收**：`verify-signature --from x.upp [--require] [--pubkey <pem>]` 同时校验 sidecar 与签名；
  `--pubkey` 做指纹钉扎（防同作者换钥）；`install --from` **自动**校验（有签名就必验），`--require-signature` 拒绝未签名包。
- **语义边界见 [08-security-and-supply-chain.md](08-security-and-supply-chain.md) §6**：这是"作者自签 + 指纹钉扎"，不是 CA/信任链，也不是身份证明。
- 不联网、不依赖 openssl：ed25519 走 Node 内置 `node:crypto`。

`unpack --from x.upp --dir out` 可解包审计；本机实测与源目录 `diff -r` 无差异（P1 后 20 条目、11460 字节；P0 时为 9 条目 6655 字节）。`install --from x.upp` 会先解到 `~/.upp/store/<id>/<version>/`，再按宿主原生方式登记，因此安装路径不依赖源码目录。

### 7.1 离线安装包 `bundle-offline`

```bash
node tools/upp.mjs keygen                                   # 首次：生成 ~/.upp/keys/upp-signing.key.pem
node tools/upp.mjs bundle-offline --pkg examples/hello-upp --sign --zip
```

产物 `dist/offline-<id>-<version>/`：

```text
install.cmd / install.sh    # 一键：Node 检查 → verify-signature → install --from → verify
<id>-<version>.upp          # 包本体
<id>-<version>.upp.sha256   # 哈希
<id>-<version>.upp.sig.json # 签名（--sign 时）
tools/upp.mjs               # vendored 工具链（用户机器不需要仓库/npm）
tests/mcp-smoke.mjs         # verify 依赖的协议自检
OFFLINE-MANIFEST.json       # 逐文件 sha256 + 安装入口 + 签名指纹
README.txt                  # 双击说明
```

本机实测：双击等价命令 `cmd /c "install.cmd < nul"` 后，签名校验、三端安装、`verify` 全绿（failed 0）；`--zip` 额外产出同名 `.zip` 便于传输。

---

## 8. `conformance`：发版门槛

一次跑完三类：

1. **spec checks**：`validate` 的 21 项（P0 的 id/version/runtime/tools/skills/hosts/permissions + P1 的 `prompts`/`agents` 文件存在、capability 一致、i18n locale 与 entries、recommend 结构）+ `build.upToDate` 幂等；
2. **MCP smoke**：spawn `runtime/server.mjs`，8s 超时内完成 `initialize → tools/list → tools/call`，断言 result 是统一信封；
3. **CLI parity**：同一工具用 `--cli <tool> --json` 再跑一次，去掉 `pid/ts/elapsedMs` 后 `data` 必须与 MCP 完全一致；
4. **host checks**（`--hosts`）：`verify` 的三端断言全量并入。

本机结果：**spec 23 + smoke 7 + host 20 = 50 项全过（failed 0）**；`verify` 20 项 0 失败；`install` 三端分别为 dsh 5/5、workbuddy 3/3、accio 3/3。CI 里把它当唯一门槛即可。

---

## 8.5 `verify-in-app`：运行态探针

```bash
node tools/verify-in-app.mjs --pkg ~/.upp/store/hello-upp/1.0.0
```

和 `verify` 的区别：`verify` 只看磁盘上的安装结果；`verify-in-app` 还看**宿主进程是否在跑**、WorkBuddy 热加载缓存里是否出现技能、Accio Gateway 是否监听、`mcp list` 是否健康。它是唯一能区分"我们写错了"与"宿主没开"的检查，退出码 0 才算运行态闭环。

## 9. `doctor`：装不上时先跑它

输出 9 项：`node` 版本、`cli.shim`（全局 launcher 是否存在）、`cli.version`（已安装工具链与仓库是否同版本）、三端探测到的 profile/技能根、`dsh.cmd`/WorkBuddy CLI/Accio CLI 是否存在、Accio Gateway `127.0.0.1:4097` 是否可连、WorkBuddy `mcp list` / Accio `server list` 是否列出本 server。典型用途：区分"我们没写对配置"和"宿主没运行/被总闸禁用"，以及"工具链该 `upp self-update` 了"。

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `ENOENT ... cordis.patch.yml.tpl` | 老版本 `pack` 把 tpl 排除，安装端无法重算路径 | 用当前版本重新 `pack`（tpl 已纳入条目） |
| `'D:/DeepSeek' is not recognized` | Windows 下 `.cmd` 路径含空格，`spawnSync` 传数组 + `shell:true` 被 `cmd` 按空格拆 | 已改为整条命令字符串 `"<dsh.cmd>" plugin ... install`；自研脚本同理 |
| DSH 里工具不存在 | 没重启 / 没 reload 会话；或 bundles 缺该包 | 重启 DSH；`verify` 看 `dsh.bundles` |
| DSH 加载了旧路径 | store 换版本后 profile 的 `link:` 未更新 | 重跑 `install --from`（覆盖 dependency 并再次 `dsh plugin install`） |
| WorkBuddy GUI 里看不到 | 只写了 skills 未重读 mcp.json；或"自定义 MCP"总闸被关 | 重启 WorkBuddy；设置里打开自定义 MCP |
| Accio MCP 不生效 | 应用未运行 / 令牌轮换 / 只落盘没过 Gateway | 启动 Accio 后重跑 `upp install --hosts accio`（安装器自动读 `gateway-cli.json` 并 add/update） |
| `node` 不在宿主 PATH | 宿主用自带 node，shell 用系统 node | 让 `command` 解析到宿主自身 node，或写绝对路径（P1 适配器处理） |

---

## 11. CI 配方（GitHub Actions 片段）

本仓库自带 `.github/workflows/ci.yml`，唯一门槛是一条：

```yaml
- run: node tests/run-all.mjs
```

`tests/run-all.mjs` 聚合 17 步：`validate`、`build --check`、`mcp-smoke`（7 项）、`import` fixtures（4 个合成插件）、DSH UI 包静态检查（14 项）、生产力插件 doc-toolkit（40 项：docx/xlsx/csv/html/pdf/pptx 摘要 + 文本/行/slide 窗口 + 错误码 + tokenBudget）、sheet-toolkit（55 项：概览/清洗/分组汇总/边界/输出上限）、log-toolkit（47 项：扫描/grep/窗口/坏正则/输出上限）、全局 CLI 自举（14 项：shim + `self-update` 升级/备份/降级拒绝/同版本 no-op）、
`analyze-polish`（离线 mock，9 项断言）、`conformance`（30 项）、`pack-sign`、`verify-signature`、
`tamper-detected`（改 1 字节必须被拒）、`offline-bundle`、
`upptool`（22 项：注册/判重/运行/退出码/批处理/导出导入/统计/doctor）、`uppmem`（28 项：池/检索/去重/build/导出导入/三宿主 dry-run 零写入/托管区幂等/MCP 往返）。
本机 Node 26 实测 **17/17 步通过**；同一份脚本可在 Windows / macOS / Linux 运行（无 shell 方言依赖）。

本地等价：`node tests/run-all.mjs`；只跑 import 矩阵：`node tests/import.test.mjs`；只跑 LLM 润色：`node tests/polish.test.mjs`；只跑生产力插件：`node tests/doc-toolkit.test.mjs`。
新增来源格式时，把最小样例加到 `fixtures/`，`import.test.mjs` 自动纳入。

**不要**在 CI 里跑 `install`：安装是宿主侧动作，产物是 `.upp`，装机由用户/安装器完成。

---

## 12. 迁移与分析（P1 设计，语义见 07 篇）

`upp import <dir> --from dsh|workbuddy|accio`：识别三端布局 → 生成 `upp.json` 草稿 + `runtime/server.mjs` 骨架（把原 skills/commands 转成工具或技能）→ 输出 `import-report.json` 与"必须人工确认项"清单；`--dry-run` 只出报告。

`upp analyze <x.upp|dir>`：把包拆成宿主中立 IR（tools/skills/permissions/assets），输出 `capability-inventory.json` 与 `replication-brief`（含 token 预算），供另两端复刻。

这两个命令 **已实现并真机验收**：实现细节、代理 runtime / describe 兜底、三个真实插件的实测数字见 [07-migration-and-analyzer.md](07-migration-and-analyzer.md) §2.5；日常用法见 §6.5。
