# P0 PoC 实机验证报告

> 目标：用一个**最小 UPP 插件**（`examples/hello-upp`）证明「同一份产物，三端安装、三端可用」不是纸面设计。
> 结论先行：**三端 MCP 通道全部端到端跑通（真进程、真协议调用）：DSH 会话内直调、WorkBuddy 技能热加载缓存收录 + `✓ Connected`、Accio Gateway 自动注册 + `server test` 发现工具。三端技能均落盘并按各自机制生效。唯一人工前提是宿主应用在运行（无应用内粘贴命令）。**

## 1. 实测环境

| 项 | 值 |
| --- | --- |
| 时间 | 2026-10-29（Asia/Shanghai） |
| OS / Node | Windows，Node v26.12.0 |
| 工作区 | `H:\Administrator\Documents\deepseek-harness\default-workspace` |
| DSH | `D:\DeepSeek Harness`，profile `desktop`，`C:\Users\Administrator\.dsh\profiles\desktop` |
| WorkBuddy | `D:\Program Files\WorkBuddy`（CodeBuddy 底座），`C:\Users\Administrator\.workbuddy`、`C:\Users\Administrator\.codebuddy` |
| Accio | `D:\Program Files\Accio`，`C:\Users\Administrator\.accio\accounts\1797968970` |

## 2. 被测产物

`examples/hello-upp`——一个同时是三端合法包的**超集目录**，不改一行代码即可被三端消费：

```
hello-upp/
  upp.json                      # UPP 唯一真源清单
  runtime/server.mjs            # MCP stdio + CLI 双模运行时（零依赖）
  runtime/tools.json            # 工具模式（由 upp.json 派生）
  skills/hello-upp/SKILL.md     # 技能引导层
  .claude-plugin/plugin.json    # Accio / CodeBuddy 兼容清单
  .mcp.json                     # WorkBuddy 插件内 MCP 声明
  clis/clis.json                # Accio 插件内 CLI 声明
  package.json                  # DSH bundle 清单
  cordis.patch.yml.tpl          # DSH 适配模板（安装时替换入口路径）
```

内容：一个 `hello` 工具 / 命令 / 技能，返回 `{"ok", "message", "server", "host", "version", "pid"}`。

## 3. 安装与验证结果矩阵

| 能力 | DeepSeek Harness | WorkBuddy | Accio Work |
| --- | --- | --- | --- |
| 安装方式 | `plugin_manager install_bundle`（installer 生成 patch） | 复制技能目录 + 合并 `~/.codebuddy/mcp.json` | 复制技能目录 + 写 `skills_config.json` + 读 Gateway 凭据自动注册 MCP |
| MCP server 被宿主识别 | ✅ **活体验证**：会话工具表出现 `mcp__upp-hello__hello` | ✅ **活体验证**：`mcp list` → `upp-hello … ✓ Connected` | ✅ **活体验证**：`server list` 出现 `upp-hello`；`server test` → 1 tool |
| 工具调用结果 | ✅ 返回 `{"ok":true,"channel":"mcp","host":"dsh"}` | ✅ 同协议握手成功（同一 `server.mjs`） | ✅ SDK 日志 `McpClient connectStdio … store\hello-upp.0.0
untime\server.mjs` |
| 技能被宿主发现 | ✅ 本会话技能目录已出现 `hello-upp`（装入 `~/.dsh/skills` 后由 DSH 技能发现收录） | ✅ `.skill-list-cache.json` 已收录 `hello-upp` | ✅ 目录 + `skills_config.json` 启用条目 |
| 是否零额外步骤 | ✅ 装完即热加载 | ✅ 写 `mcp.json` 即生效（宿主自动重读/重启） | ✅ 应用运行时全自动（无 in-app 命令） |
| 是否零使用成本 | ✅ 模型直接看到工具/技能 | ✅ 同左（`mcp__upp-hello__hello`） | ✅ 同左 |

`node tools/upp.mjs verify` → **13 项检查全绿，failed: 0**（DSH 7 项含技能镜像 / WorkBuddy 3 项 / Accio 3 项，见 [06-toolchain.md](06-toolchain.md) §6）。

## 4. 关键证据

**DSH**（`plugin_manager install_bundle` 成功，profile 写入 `link:` 依赖并加入 `dsh.profile.bundles`）：

```
mcp__upp-hello__hello({"name": "DSH-PoC"})
→ {"ok": true, "message": "Hello, DSH-PoC!", "server": "upp-hello", "version": "1.0.0", "host": "unknown", "pid": 4844, ...}
```

DSH 的 MCP 客户端在 bundle 安装后**热加载**，未重启会话即可见新工具——这满足"像原生适配一样"的最强定义。

**WorkBuddy**（MCP 配置被底座 CLI 解析并实际拉起子进程）：

```
$ codebuddy-lite-wb.mjs mcp list
Checking MCP server health...
upp-hello: node …\upp\examples\hello-upp\runtime\server.mjs - ✓ Connected
```

**协议自身**：`node tools/upp.mjs conformance` → spec checks 全过 + MCP smoke 7/7 + CLI parity 一致（`node tests/mcp-smoke.mjs` 等价，6 项协议 + 1 项 parity）。

## 5. 暴露的问题（已修 / 待修）

1. **已修**：适配模板注释里也含入口占位符，导致 `replaceAll` 把注释路径一并替换 → 模板注释改为不含占位符。
2. **已修**：`verify` 曾在 profile 根 `cordis.patch.yml` 找 bundle 的 patch 行（实际行在 bundle 包内）→ 改为读 `node_modules/<pkg>/cordis.patch.yml`，并新增"占位符是否已替换"检查。
3. **已修**：`verify` 用 `...name.split('/')` 拼路径时把字符串当数组展开（`@\l\o\c\a\l\…`）→ 改为 `...name.split('/')` 正确展开；从 3 项误报回到 failed 0。
4. **已修（关键）**：DSH 对本地目录依赖走 `link:`，bundle 运行时指向源目录，删源即坏 → 新增 `pack`/`unpack` + `install --from <x.upp>`：先解到 `~/.upp/store/<id>/<version>`，再登记 profile。实测 `dsh plugin --profile desktop install` 后 `node_modules/@local/upp-hello` 的 `realpath` 已指向 store。
5. **已修（关键）**：`pack` 曾排除 `cordis.patch.yml.tpl`，导致安装端无法重算绝对路径而直接 `ENOENT` → tpl 纳入包内，安装端由 tpl 重生成 patch（patch 里始终是本机 store 路径）。
6. **已修（Windows）**：`spawnSync("D:/DeepSeek Harness/.../dsh.cmd", args, {shell:true})` 被 `cmd` 按空格拆成 `'D:/DeepSeek'` → 改为整条命令字符串 + `shell:true`。
7. **已修**：patch 现在注入 `env.UPP_HOST: dsh`（WorkBuddy/Accio 分别为 workbuddy/accio），工具返回的 `host` 字段不再是 `unknown`。
8. **待解决**：WorkBuddy GUI / Accio 未运行，技能发现与 Accio MCP 注册缺少运行态证据。

## 6. 运行态两格（Round 1 已闭环，2026-10-29 22:20–22:27）

- WorkBuddy GUI 运行后：`.workbuddy/.skill-list-cache.json`（mtime 22:21）收录 `hello-upp`；`codebuddy-lite-wb.mjs mcp list` → `upp-hello … ✓ Connected`；
- Accio 运行后：安装器读 `<account>/.accio/runtime/gateway-cli.json` 凭据 → `server add`（重复时 `update`）→ `server test` → `✓ connected — 1 tool(s) discovered`；`~/.accio/logs/sdk.log` 出现 `McpClient connectStdio: command='node', args=…store\hello-upp.0.0
untime\server.mjs`（Accio 真的拉起了本包 runtime）；Accio `0.36.2`。

**Agent 也能拉起这两个 GUI**：`Start-Process` 会被单实例/会话隔离吞掉（ExitCode 0、无子进程），改用 `explorer.exe "<install>\WorkBuddy.exe"` / `explorer.exe "<install>\Accio.exe"` 即成功（各 3 个进程）。

`node tools/verify-in-app.mjs --pkg ~/.upp/store/hello-upp/1.0.0` → **passed 11, failed 0**。

## 7. 复现步骤

```bash
cd upp
node tools/upp.mjs detect
node tools/upp.mjs validate
node tools/upp.mjs build
node tools/upp.mjs install --hosts dsh,workbuddy,accio     # 开发者回路（源码目录）
node tools/upp.mjs verify
node tools/upp.mjs conformance                             # spec + MCP smoke + CLI parity

# 分发回路（推荐，稳定 store）
node tools/upp.mjs pack --out dist
node tools/upp.mjs install --from dist/hello-upp-1.0.0.upp
node tools/upp.mjs verify --pkg ~/.upp/store/hello-upp/1.0.0
```

## 8. 收尾验证（同日二次实测，2026-10-29 22:10–22:25）

在完成工具链重写后重新跑完整闭环，全部通过：

| 步骤 | 结果 |
|---|---|
| `validate` | 12 项，`failed 0` |
| `build` / `build --check` | 生成 6 个派生物；二次运行 `drift []`（幂等） |
| `conformance` | spec checks 全过；MCP smoke 7/7；`parity.mcp_vs_cli` 一致 |
| `pack` | `dist/hello-upp-1.0.0.upp`，10 条目（含 `cordis.patch.yml.tpl`），6655 字节 |
| `unpack` 回读 | 与源目录 `diff -r` 无差异（仅源目录多出本地状态文件） |
| `install --from` | 三端 `ok: true`；DSH `dsh.profile.registered` ✅ |
| store 实体 | `C:\Users\Administrator\.upp\store\hello-upp\1.0.0`；`node_modules/@local/upp-hello` 的 `realpath` 指向它 |
| 三端路径一致 | DSH patch `args[0]`、WorkBuddy `mcp.json` args[0]、Accio 载荷 args[0] 全部指向同一 store 的 `runtime/server.mjs` |
| `verify --pkg <store>` | 13 项，`failed 0` |

这一轮把两个"会把承诺打穿"的问题（源码 link 漂移、tpl 缺失导致安装失败）变成回归项，并验证了"用户只跑一条 `install --from`"的完整路径。

## 9. 运行态收尾（原"待用户配合"格已关闭）

- WorkBuddy：✅ 技能缓存已收录 `hello-upp`；✅ CLI `mcp list` 健康；GUI 技能页/工具页视觉确认建议补一张截图（不影响协议结论）。
- Accio：✅ MCP 注册成功且 `server test` 发现工具；✅ 技能目录 + 启用条目已写；✅ SDK 日志证明 runtime 被真实拉起。

**此前"agent 无法拉起 GUI"的限制已解除**：`explorer.exe <exe>` 可拉起（`Start-Process` 仍会被吞）；被拉起后所有运行态检查均通过。

为此提供只读探针（不安装、不改配置）：

```bash
node upp/tools/verify-in-app.mjs --pkg ~/.upp/store/hello-upp/1.0.0
```

它会检查：三端进程是否在跑、DSH profile 依赖与 bundles、WorkBuddy 技能目录与热加载缓存、WorkBuddy CLI `mcp list` 健康、Accio Gateway 与已注册 server 列表，并在失败时打印"下一步该做什么"（例如启动 Accio 后重跑 `install --hosts accio`——安装器检测到 4097 可连时会**自动**通过 Gateway 注册 MCP，无需手工粘贴命令）。

两者都不影响 P0 契约的成立（协议级握手与三端口径已实测），只影响"是否需要重启/一次点击"的描述精度。

---

## 10. P1 复测补充（2026-10-29 晚）

P1 能力映射（prompts/agents/i18n/recommend 三端落地）完成后，用同一个示例包复测：

| 项 | 结果 |
|---|---|
| `validate` | 21 项，failed 0（P0 为 12 项） |
| `build` | 12 个产物，0 drift（新增 commands/agents/subagents/resources/plugin.json/.codebuddy-plugin） |
| `install` | 三端 ok: true；WorkBuddy 额外写入本地市场 `upp-local` + `installed_plugins.json` + `enabledPlugins` |
| `verify` | 20 项，failed 0（新增 dsh.skillMirror / workbuddy.plugin.* / workbuddy.command / workbuddy.agent） |
| `conformance --hosts` | 50 项，failed 0 |
| DSH 运行态 | 技能目录新增 `hello-upp-prompt-hello-report`、`hello-upp-agent-reviewer`；MCP 调用回包 `host: "dsh"` |
| WorkBuddy 运行态 | `daemon.log` 出现 `skill-md` change 与 `push skillsVersionChanged`（技能热加载）；插件清单 `plugin validate` → valid |
| Accio 运行态 | Gateway 自动注册 → `connection status: connected`；`sdk.log` 连接成功并发现 1 个工具；`server tools upp-hello` 回读 `hello` |

详见 [11-p1-mapping.md](11-p1-mapping.md)。P0 的 13 项记录属于当轮快照，保留不改。

---

## 附录 A. P1.4 / P2 试点实测（2026-10-31）

| 项 | 证据 | 结论 |
| --- | --- | --- |
| `validate`（示例全量） | failed 0（42 项，含 ui/hooks 校验） | 通过 |
| `build` | 17 个文件（新增 `skills/hello-upp-panel/*`、`hooks/hooks.json`、`hooks/scripts/session-log.mjs`）；`build --check` upToDate=true | 通过 |
| `tests/run-all.mjs` | 12/12（含 conformance 42、签名/篡改/离线包、DSH UI 静态检查、全局 CLI 自举） | 通过 |
| `install` + `verify` | 三端 ok；verify 28 项 failed 0 | 通过 |
| `conformance --hosts` | 70 项 failed 0 | 通过 |
| DSH 面板技能 | `~/.dsh/skills/hello-upp-panel/` 出现在技能目录（模型可见） | 镜像生效，未渲染面板 |
| WorkBuddy hooks | `plugin validate` valid；脚本直跑 exit 0 且写日志；桌面端重启后日志无 hello-upp 加载行 | 契约验证通过，加载**未证实** |
| Accio renderer | 面板技能落盘 + `skills_config` 登记；未见 renderer 解析日志 | 落盘生效，渲染**未证实** |
| DSH client UI bundle | `examples/hello-upp-ui` 生成 `index.js`/`client.js`，`dsh.client.platform=web`、`exports["./client"]`、patch 自插入行；`node --check` 与 14 项静态断言通过 | 生成与一致性**已证实**；**未安装**（加载需重启 DSH） |

诚实边界：以上"未证实"项不计入 P0/P1 验收，只作为后续观察点。

