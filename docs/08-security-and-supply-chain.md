# 08 安全与供应链

**状态**：v1 设计 + 已实现部分混排。标【已证实】的均有文件/实测证据；标【设计/待实现】的是 v1 目标而非现状。
本文的安全模型基线是：**安装器被用户明确授权可以写三端内部配置**——这是最大的信任假设，也是本文所有缓解措施的前提。
包格式与契约等级见 [01-spec.md](01-spec.md)；迁移器（会读第三方代码）见 [07-migration-and-analyzer.md](07-migration-and-analyzer.md)。

---
## 1. 信任边界与威胁模型

| 信任方 | 被信任的内容 | 一旦失守的后果 |
| --- | --- | --- |
| 用户 | 授权 `upp install` 写宿主配置、运行 node 子进程 | 安装器可改 `mcp.json`/`settings.json`/profile（**这是设计意图**） |
| 插件作者 | `upp.json` 的 `permissions` 声明真实 | 声明最小、实际提权（运行时无强制，见 §3.1） |
| 宿主 | DSH/WorkBuddy/Accio 自身沙箱与审批 | 宿主沙箱是这个链条上**唯一真正执行**的那一层 |
| 包内容 | 未被篡改 | 无签名链，只有可选哈希（§6） |

| # | 威胁 | 影响 | 缓解（v1 已有 / 设计） |
| --- | --- | --- | --- |
| T1 | 恶意 DSH bundle 的 `index.js` 在宿主进程内 `apply(ctx)` | 进程内任意 Service/文件访问，绕过一切插件级限制 | 已：UPP **只做 configuration-only MCP bundle**（无 `index.js`）；P2 host-native 代码不打包只声明 |
| T2 | 恶意 MCP 子进程以用户身份执行 | 读写用户文件、外联 | 已：`permissions.{network,shell,filesystem}` 声明 + 宿主审批；设计：`upp verify` 复核 |
| T3 | 本地目录依赖被替换（DSH `link:`） | 安装后代码可变，哈希失效 | **已关闭（v1）**：`install --from` 先解到 `~/.upp/store/<id>/<version>` 再登记 profile，DSH 的 `link:` 只指向 store；源码目录变更不影响已安装副本（[06](06-toolchain.md) §4） |
| T4 | 写入宿主配置时覆盖/污染他插件条目 | 破坏其他插件、静默改行为 | 已：只 add 不 delete + 一次性备份 + `.upp-install.json` 精确回滚（§2） |
| T5 | `.upp` 内路径穿越（`../`、绝对路径） | 写到插件目录之外 | 设计：解包白名单 + 拒绝 `..`/绝对路径；Accio 侧已实测有 "skipping suspicious entry" 防护 |
| T6 | 提示词注入（`SKILL.md` 正文夹带指令） | 模型越权调用工具 | 部分：frontmatter 6 键白名单 + `alwaysLoadedBytes` 上限；本质靠人工审阅，**无法自动判定** |
| T7 | 密钥被写进包（`mcp.json` 的 `env`、i18n 文案） | 明文落盘、进 git | 设计：`env` 只允许"引用宿主已有变量名"，禁止携带值；DSH 侧另有清洗（§4） |
| T8 | 本地 Gateway `127.0.0.1:4097` 被本机其他进程滥用 | 任意注册 MCP server | 已：Bearer token 由 Desktop 注入 `ACCIO_GATEWAY_TOKEN`，无 token 直连被拒；仅 loopback 监听 |
| T9 | 权限继承升级（源插件 `fullAccess:true`） | 越权 | 设计：`import` **只能收紧不能继承**（[07](07-migration-and-analyzer.md) §2.1） |
| T10 | 卸载残留（技能目录、MCP 条目、数据） | 长期驻留、跟踪 | 已：按状态文件精确删除；`UPP_DATA` 默认保留，需 `--purge` 显式清除 |

---
## 2. 写宿主配置：风险面与备份 / 幂等 / 回滚

### 2.1 风险面（安装器会碰到的真实文件）

| 宿主 | 被写入的位置 | 风险 |
| --- | --- | --- |
| DSH | profile `package.json` 的 `dependencies` + `dsh.profile.bundles`；`<profile>/node_modules/<pkg>` | **参考实现不直接写**，只输出 `plugin_manager install_bundle` 指令 |
| WorkBuddy | `~/.workbuddy/skills/<id>/`、`~/.codebuddy/mcp.json` | 覆盖同名技能、污染他人 `mcpServers` 条目 |
| Accio | `<acct>/skills/<id>/`、`skills/skills_config.json`、`<pkg>/.upp-accio-mcp.json`（人工执行） | 覆盖账号级技能配置；Gateway 只在 app 运行时可用 |

### 2.2 三道保险

| 保险 | 实现 | 证据 |
| --- | --- | --- |
| **一次性备份** | `backupOnce(file)`：`if (!existsSync(bak)) copyFileSync(file, bak)`，`bak = \`${file}.upp-bak-orig\`` | `tools/upp.mjs` 的 `backupOnce()`；实盘每份被改文件旁都有 `.upp-bak-orig` |
| **幂等** | 所有写入先 `generate()` 比对内容，`build --check` 只报 `drift[]`，不写盘；重复 `install` 结果相同 | `generate()` 的 `drift` 计算；`install` 前必跑 `generate()` |
| **精确回滚** | 状态文件 `<pkg>/.upp-install.json` 记录每个宿主的落点（skillDir/mcpConfig/serverName） | 实测 1 318 B；`uninstall` 只按它删 |

### 2.3 语义边界（必须明说的两点）

| 事实 | 含义 |
| --- | --- |
| 备份**只做一次** | 第二次 `install` 不会用新备份覆盖首个 `.upp-bak-orig`。若用户在两次安装之间手改过宿主配置，那份手改内容不在备份里——回滚回的是**最初**状态 |
| DSH 卸载走 **profile 语义** | `uninstall` 删除 profile `package.json` 的 `dependencies[<pkg>]` 与 `dsh.profile.bundles` 条目，再执行 `dsh plugin --profile <name> install` 让 pnpm 剪掉 `node_modules`；不手写 YAML，store 目录保留可复用 |

```bash
# 安装前先看差异（不写盘）
node tools/upp.mjs build --check --pkg examples/hello-upp
# 安装（幂等；每个被改文件旁生成 .upp-bak-orig）
node tools/upp.mjs install --pkg examples/hello-upp --hosts workbuddy,accio
# 人工回滚某个宿主文件到安装前（示例：WorkBuddy 的 mcp.json）
cp ~/.codebuddy/mcp.json.upp-bak-orig ~/.codebuddy/mcp.json
```

---
## 3. 最小权限与 `permissions` 三端映射

### 3.1 先诚实说明：UPP 的 `permissions` 是**声明**，不是运行时沙箱

三端都**不读** `upp.json`，因此 UPP 的 `permissions` 只在两个时刻起作用：① `validate`/`install` 时的检查；② 安装器把这些
约定翻译成宿主自己的配置。**真正执行拦截的是宿主沙箱**。夸大这一点会让读者以为 UPP 提供了隔离——它没有。

| 字段（[01-spec.md](01-spec.md) §10） | 取值 | 三端落地方式 |
| --- | --- | --- |
| `network` / `networkHosts` | `false` / 域名白名单 | Accio：网络默认 `allow`，需在宿主里显式收紧；DSH/WorkBuddy：无按插件的网络开关，靠 MCP 子进程自律 |
| `filesystem` | `none`\|`data`\|`workspace` | `data` = 只允许 `UPP_DATA`；`workspace` 才需要用户级授权 |
| `shell` | `false`（v1 默认） | Accio 托管 CLI 硬约束 `shell:false`；WorkBuddy 侧**无 skill 级沙箱**，只能靠声明 |
| `env` | 变量名数组 | 只允许引用宿主已有变量名，**不得携带值**（§4） |

### 3.2 三端策略粒度映射

| UPP 意图 | Accio（最细，四策略） | WorkBuddy（两档 + 135 条 fs 规则） | DSH（粗） |
| --- | --- | --- | --- |
| 只读数据 | `allow` | 规则 `read:allow` | 无 per-plugin 规则，靠 bundle 声明 |
| 写 `UPP_DATA` | `allow`（路径前缀） | 沙箱全放行目录之一，或 `extraAllowWrite[]` | `UPP_DATA` 明文约定 |
| 写工作区 | `ask` / `ask_once` | 默认工作区边界内 allow，越界 ask | 无 |
| 执行 shell | `ask`（默认） | 危险命令黑名单 + 命令前缀规则 | approval waterfall |
| 网络访问 | 默认 `allow`（需反向收紧） | 域名规则 | 无 |
| 全部放行 | `fullAccess:true`（**UPP 永不生成**） | 「允许完全访问」全局开关 | 不适用 |

关键结论：**Accio 的 `allow/ask/ask_once/deny` 是唯一能表达"最小权限"的机制**；另两端口径更粗，所以 UPP 的策略是
"按最弱的一档写默认值 + 在强的一档做得更好"，而不是假设三端等强。Accio 侧权限落在
`C:\Users\Administrator\.accio\plugin-permissions.json`（实测该文件已存在，样例插件被授予 `fullAccess:true`——UPP 不继承它）。

---
## 4. 密钥与 env 清洗

| 宿主 | 机制 | 证据 |
| --- | --- | --- |
| DSH | 子进程 env 以 `scrubbedParentEnv()` 为基座：正则 `SENSITIVE_ENV_PATTERN = /KEY\|PASSWORD\|SECRET\|TOKEN/i` 的变量名**全部丢弃**，`DSH_*` 也全部丢弃；显式配置的 `env` 在**清洗之后**合并；显式 `undefined` 作为 tombstone 删除普通项 | `dsh-subprocess/lib/index.js`；`dsh-mcp-client/README.zh.md`「环境清洗（stdio）」 |
| WorkBuddy | 子进程继承宿主 env，插件可用 `env`/`staticEnv` 覆盖；无内置清洗 | `plugin.json`/`mcp.json` 的 `env` 字段 |
| Accio | MCP 配置的 `env` → 宿主内部 `environment`；SubAgent `customTools` 明确禁止 `process.env`（原文：`No fs / child_process / process.env`） | Accio 插件规范 §2 |

UPP 的规则（设计，写入 CI 检查）：

1. `upp.json.permissions.env` **只列变量名**，不列值；提交里出现 `sk-` / `Bearer` / `PRIVATE KEY` 形态一律失败。
2. `import` 迁移时，源清单里 `env` 的**值**全部丢弃，只在 `needsHuman` 里记一条"需要用户自行配置"。
3. 生成的 `.mcp.json`/patch 只写 `env: { UPP_HOST: "workbuddy" }` 这类非敏感项（`generate()` 现状即如此）。
4. DSH 侧不要试图用 `env` 传密钥去抵消清洗——显式值会合并进去，等于把密钥写进 YAML 落盘。

### 4.5 可选 LLM 增强（`analyze --polish`）的数据外发边界

| 问题 | 事实 |
| --- | --- |
| 默认是否联网 | **否**。只有显式 `--polish` 且设置 `UPP_LLM_BASE_URL`+`UPP_LLM_API_KEY` 才发请求 |
| 发什么 | `contract.json` 的元数据：id/name/version/description、工具名+描述+inputSchema、skillIds/promptIds/agentIds、cli 摘要 |
| 不发什么 | 技能正文与文件内容、插件源码、宿主机路径、凭据、`UPP_DATA`、安装记录 |
| 回包用途 | 只写 `ANALYSIS.md` 增强段与 `contract.json.llm`；工具描述先按契约名过滤；**不改** tools.json / Schema / 验收用例 |
| 端点 | 任意 OpenAI 兼容 `/chat/completions`（可指向本地 Ollama/vLLM，保持离线） |
| 失败语义 | 默认 warn 后跳过；`--strict-polish` 退出码 1（缺 env / HTTP 非 2xx / 非 JSON） |
| 测试 | `tests/polish.test.mjs`：本地 mock server 9 项断言，证明默认不调用、strict 会失败 |

---
## 5. MCP 子进程的沙箱边界

| 维度 | DSH | WorkBuddy | Accio |
| --- | --- | --- | --- |
| 谁 spawn | MCP SDK（`@deepseek-ai/dsh-mcp-client`） | 宿主自身 | 本地 Gateway（Desktop 进程） |
| 超时 | `toolCallTimeoutMs: 60000` | `timeout` 默认 30000（另有 2e4 = 20 s 的调用超时） | **固定 120 000ms，且忽略 `cwd`** |
| cwd | 可配 `cwd` | 可配 `cwd`（4.22.15+） | 忽略 |
| env | `scrubbedParentEnv()` 基座 + 显式 `env` | 继承 + 覆盖 | `environment` |
| 运行期沙箱 | 无独立进程沙箱，靠宿主审批 | 135 条 fs 规则 + 危险文件黑名单（含 `.mcp.json`、`.gitconfig`、`.bashrc`） | 路径白名单 + `realpath` 防符号链接 + 每次操作边界检查 |
| 其他硬限制 | `maxInstructionBytes:32768`、`failOnStartupError:false`、重连退避 | 插件 MCP 优先级**最低**（会被用户级配置覆盖） | 托管 CLI：`shell:false`、`maxOutputBytes:33554432`、并发≤64、`readOnly:true` |

**边界结论**：UPP runtime 是一个**普通 node 子进程**，它继承宿主给的权限。所以"沙箱"实际由宿主决定，UPP 能做的是
**把最小必要面暴露出去**：零 npm 依赖、不写插件目录之外、只写 `UPP_DATA`、默认 `shell:false`、默认 `network:false`。
Accio 的托管 CLI 限制（`shell:false`、只读、30s）反而是三端里最接近"能力受限"的形态，值得作为 UPP runtime 的自我约束参照。

---
## 6. `.upp` 包完整性与供应链

### 6.1 现状【已实现并实测】

| 项 | 现状 |
| --- | --- |
| 打包 | `upp pack` → `dist/<id>-<version>.upp`（ZIP，`deflateRawSync` + 自实现 `crc32`，零依赖） |
| 排除项 | `node_modules/`、`dist/`、`.git/`、`.upp-install.json`、`.upp-accio-mcp.json`、`*.upp-bak-orig` |
| 内容哈希 | 每次 `pack` 写 `<file>.upp.sha256`：`<sha256>  <file>`（LF），与 `sha256sum -c` / `certutil` 交叉可验 |
| 签名 | `pack --sign [--key <pem>]` 写 `<file>.upp.sig.json`（ed25519 detached，Node 内置 `node:crypto`） |
| 安装校验 | `install --from x.upp` 自动校验：有签名必验签名+哈希；`--require-signature` 拒绝未签名包；任一不一致直接退出 1、**不落盘** |
| 篡改实测 | 复制包并翻转 1 字节 → `verify-signature` 退出 1，报告 4 项失败（sidecar、文件名、签名哈希、签名本身） |
| 免安装校验 | `verify-signature --from x.upp [--require] [--pubkey <pem>]`；`--pubkey` 做指纹钉扎 |

`<file>.upp.sig.json` 格式：

```json
{
  "format": "upp-sig/1",
  "alg": "ed25519",
  "file": "hello-upp-1.0.0.upp",
  "sha256": "22b1…f9a3",
  "keyFingerprint": "0f012f6363b1eb1b",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n…",
  "signature": "base64…",
  "signedAt": "2026-10-31T02:20:00.000Z"
}
```

签名对象是 `.upp` 的**完整字节**；`keyFingerprint` = spki DER 的 sha256 前 16 位，用于人工核对/钉扎。

### 6.2 校验顺序（安装器内固定）

1. 读 `x.upp` → 算 sha256；有 `.sha256` sidecar 则必须一致；
2. 有 `.sig.json`：校验 format/alg/file/sha256，再用内嵌公钥验签；`--pubkey` 时比对指纹；
3. 任一失败 → 打印 checks 并退出 1，**不**解包、**不**写宿主配置；
4. 全过 → 解包到 `~/.upp/store/<id>/<version>/`，再登记宿主。

### 6.3 签名能证明什么、不能证明什么

**能**：包未被改动；签名者持有对应私钥；同一作者可通过 `--pubkey` 钉扎识别。

**不能**：作者真实身份（自签，无 CA/证书/时间戳）；吊销与轮换（无 CRL/OCSP）；"这个包安全"（签名不等于审计）。

因此 v1 的定位仍是**本地/内网/受信渠道**，签名用于"防篡改 + 防错装 + 可钉扎"，不是"第三方市场准入"。要接市场，
应由宿主/平台做上架审核与证书体系；UPP 只提供可验证的包格式（可被平台签名覆盖，边界见 10 §4）。

---

## 7. 审计与卸载可验证

| 审计面 | 位置 | 可验证性 |
| --- | --- | --- |
| 安装状态（UPP 自己的） | `<pkg>/.upp-install.json`（id/version/serverName + 每宿主落点） | 高：`uninstall` 完全由它驱动 |
| DSH 安装日志 | `<profile>\.plugin-manager\logs\operation-*\pnpm.log` | 高：宿主自己产生 |
| Accio 权限审计 | `<acct>/permissions/audit.jsonl` | 高：宿主自己产生 |
| WorkBuddy | 安全中心「审计中心」可导出；沙箱 135 条规则在 `settings.json.sandbox.orderedRules.file` | 中：界面导出 |
| UPP 侧旁路审计 | 无（v1 不写自己的日志文件） | **设计**：`install` 打印结构化 JSON，由调用方留档 |

```bash
# 卸载 → 验证：三端都不再持有该插件
node tools/upp.mjs uninstall --pkg examples/hello-upp
node tools/upp.mjs verify --pkg examples/hello-upp     # 期望 failed>0，说明确实清掉了
node -e "const j=require('C:/Users/Administrator/.codebuddy/mcp.json');console.log(j.mcpServers['upp-hello']===undefined)"
```

注意：`verify` 失败在**卸载后是期望结果**；把它当"卸载验证器"用时要看的是 `failed` 是否等于安装时的检查数。
`UPP_DATA`（`<hostData>/upp-data/<id>/`）默认保留，只有 `--purge` 才删——这是有意的，避免卸载即毁数据。

---
## 8. 合规与分发

| 话题 | 事实/立场 |
| --- | --- |
| 三端商店条款 | **本文未逐条核实**三端市场政策原文，故不引用任何条款号。可证实的只有 WorkBuddy 的官方风险提示原文（"非官方 Skill 可能存在恶意提示词注入、越权访问、后门程序"）；DSH/Accio 的对应文案未核实 |
| v1 分发范围 | **仅本地/内网/受信渠道**（[01-spec.md](01-spec.md) §13：marketplace listing 不进 v1）。上架三端市场是后续工作，需重新做合规评估 |
| 私有分发 | 目录拷贝或 `.upp` 文件交付；`.sha256` 随包生成，签名包附 `.sig.json`；建议同时留存本次安装的 `verify` 输出 |
| 用户告知义务 | 安装前须让用户看到：① `permissions` 原文；② 将被写的宿主文件清单；③ P2 项被丢弃的列表 |
| 数据处理 | UPP 不自建遥测；插件若需上报，必须在 `permissions.networkHosts` 显式列出域名 |

---
## 8.5 P1.4 / P2 新增面：面板 iframe 与 observe 钩子

| 面 | 风险 | UPP 的处理 |
| --- | --- | --- |
| Accio 面板 `skill-app://` iframe | 宿主 sandbox 为 `allow-scripts allow-forms allow-same-origin` 且无 CSP，所有技能共享 `skill-app://app` 源，理论上可跨插件读文件 | UPP 生成的 HTML **不含远程资源**、不含 `fetch("skill-app://app/…")`，`validate` 强制检查；面板只做展示与 `postMessage` 握手，不代持凭据 |
| 面板技能镜像到 DSH/WorkBuddy | 面板 HTML 被当普通技能安装，模型可读其文本；若内嵌敏感数据会外泄 | 面板不含运行时数据；`validate` 禁止 `https?:` 与跨技能取数；文档提示面板内容视为公开 |
| WorkBuddy observe hooks | 宿主以用户身份静默 spawn `node`，可读写文件/环境；脚本有 bug 可能影响会话 | 仅 `observe` 模式（永远 exit 0、不写 stdout）、超时 ≤ 60s、只 append 日志；`PreToolUse/Stop` 等可拦截事件不生成；用户可 `CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS=1` 总闸 |
| 第三方插件导入（import） | 被分析插件可能带恶意 hooks/renderers/RPA | import 只读取声明与文件、**不执行**源插件代码；提取结果是"文本+清单"，需用户审阅 `IMPORT-REPORT.md` 后才 `install` |
| DSH client bundle（`ui.dsh`） | 生成的 `client.js` 由宿主在 Web UI 源内执行（同源、可访问页面上下文），错误只进 console，可能导致面板空白 | 生成器只产出"展示 + `slots.register`"的最简 classic script，不含远程资源、不读取凭据；安装后在重启前不生效；UPP `verify` 做静态一致性检查，运行时行为需人工看 F12 console |

**未证明的**：WorkBuddy 桌面端实际加载我们的 hooks（无运行日志证据）；Accio 面板真实渲染（需会话触发）。两者都不得在对外材料中宣称为"端到端已验证"。

## 9. 残余风险与明确不做的部分

| 残余风险 | 为什么 v1 接受 | 何时必须解决 |
| --- | --- | --- |
| 无签名，无法证明作者身份 | 无宿主级验证机制，自建签名链是虚假保证 | 上架商店或跨组织分发时 |
| `link:` 安装导致代码可变（T3） | 分发默认走 store 安装（`install --from`）；仅开发者回路仍 link 源码 | **已关闭**（开发者回路为显式选择） |
| `permissions` 无运行时强制 | 三端不读 `upp.json`，只能声明 | 需三端任一提供插件级权限 API（目前只有 Accio 接近） |
| 提示词注入无法自动检测 | 只能白名单 + 字节上限 + 人工审阅 | 长期 |
| 本机 Gateway（4097）依赖 token 与 loopback 绑定 | 已由宿主实现，UPP 无法加强 | 若 Accio 改为对外监听则需重评 |
| 备份只做一次，不跟踪用户手改 | 简化状态机 | 多版本共存时 |

**明确不做**：① 代码签名链/证书体系；② 自建沙箱或容器；③ 密钥托管（UPP 不存任何密钥）；④ 依赖漏洞扫描（零依赖使
此项基本不适用）；⑤ 运行时完整性证明（attestation）；⑥ 自动判定"恶意插件"——安全结论一律由人做，工具只负责**把风险摆在明面上**。
