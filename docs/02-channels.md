# 02 · 三通道模型（MCP / CLI / 技能）

UPP 的可移植性来自"**同构的三条通道**"，而不是给每个宿主写一套代码。运行时只实现一次，三条通道共享同一 handler。

```
                 ┌──────────────── runtime/server.mjs ────────────────┐
  MCP 工具 ────► │  dispatch(tool, args) → handler(args) → envelope   │ ◄──── CLI
  (mcp__s__t)    └────────────────────────────────────────────────────┘
                                    ▲
                              技能指令（SKILL.md 告诉模型该走哪条）
```

---

## 1. 结果契约（先定语义，再定协议）

所有通道返回**同一个信封**（JSON）：

```json
{ "ok": true,  "data": { }, "channel": "mcp", "host": "dsh", "elapsedMs": 12 }
{ "ok": false, "code": "INVALID_ARGS", "message": "name must be a string", "channel": "cli", "host": "workbuddy" }
```

| 字段 | 说明 |
| --- | --- |
| `ok` | 唯一成功判据。宿主侧的 `isError` 只是补充，不得作为唯一语义 |
| `code` | 稳定错误码：`INVALID_ARGS` / `NOT_FOUND` / `PERMISSION_DENIED` / `TIMEOUT` / `UPSTREAM_ERROR` / `INTERNAL` |
| `message` | 面向模型的一句话，可直接展示给用户 |
| `channel` | `mcp` \| `cli` \| `skill`，用于诊断降级 |
| `host` | `dsh` \| `workbuddy` \| `accio`，来自 `UPP_HOST` |

**禁止**：同一错误在 MCP 与 CLI 下给不同 `code`；禁止把人类日志混进 stdout。

---

## 2. 通道 A：MCP 工具（首选）

### 2.1 协议子集

运行时必须实现：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`；`resources/*`、`prompts/*` 至少返回空列表。传输为**换行分隔 JSON-RPC 2.0**（每行一条完整消息），stdout 只走协议。

```jsonc
// → initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"host","version":"x"}}}
// ← {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"hello-upp","version":"1.0.0"}}}
// → tools/call
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hello","arguments":{"name":"Ada"}}}
// ← {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"data\":{...}}"}],"isError":false}}
```

### 2.2 三端实测差异

| 项 | DSH | WorkBuddy | Accio |
| --- | --- | --- | --- |
| 传输 | stdio（`transport:"stdio"`）或 streamable-http | stdio / sse / http 均支持 | stdio(local) / streamable-http(remote) |
| 工具名 | `mcp__<server>__<tool>`，64 字符上限，超长截断+哈希 | 同左 | 同左 |
| 超时 | `toolCallTimeoutMs` 默认 60000 | 默认约 60000 | 120000（Gateway 固定） |
| 环境 | 子进程 env 经 `scrubbedParentEnv` 清洗 | 继承，可配 env | 继承，配 `environment` |
| 生效 | bundle 安装后**热加载** | 配置写入后生效（必要时重启宿主） | 经 Gateway **应用内**注册 |

→ 运行时把单次调用控制在 **≤15s**，并对长任务返回 `{"ok":false,"code":"TIMEOUT"}` 的自行兜底，而不是等宿主杀进程。

---

## 3. 通道 B：CLI（三端都有的兜底）

```bash
node <plugin-root>/runtime/server.mjs --info
node <plugin-root>/runtime/server.mjs --list
node <plugin-root>/runtime/server.mjs --cli hello --json '{"name":"Ada"}'
node <plugin-root>/runtime/server.mjs --cli hello --name Ada          # 键值形式
```

| 约定 | 值 |
| --- | --- |
| 成功 | stdout 一个 JSON 信封，退出码 `0` |
| 业务错误 | stdout `{"ok":false,...}`，退出码 `2` |
| 运行时错误 | stderr 文本，退出码 `1` |
| 副作用 | 无（除插件自身声明的数据目录） |

CLI 通道的意义：**任何能被 shell 调用的宿主都能用**——包括未来第四、第五个宿主，不需要新的适配器就能"跑起来"（只是体验不是原生的）。

---

## 4. 通道 C：技能（何时用/怎么用/失败怎么退）

工具与 CLI 是"能力"，技能是"使用说明"。三端都原生读 `SKILL.md`（DSH 技能根、WorkBuddy `~/.workbuddy/skills`、Accio `skills/`），因此技能天然是最便宜的跨端载体。

`SKILL.md` 的探测模板（安装器会把 `<plugin-root>` 替换为绝对路径）：

```markdown
按顺序尝试，命中即停：
1. 若工具列表中存在 `mcp__upp-hello__hello` → 调用之。
2. 否则执行 `node "<plugin-root>/runtime/server.mjs" --cli hello --json '{"name":"…"}'`。
3. 否则只使用本技能的说明文字，并告知用户该宿主缺少运行时（给出安装命令）。
报告 `ok` / `message` / `host`，不要贴原始 JSON。
```

规则：

- 技能**不得**假定工具一定存在；必须写降级路径。
- 技能**不得**重复工具 schema 细节（那是工具的职责，重复=浪费 token 且会漂移）。
- 常驻字节预算：`tokenBudget.alwaysLoadedBytes`（默认 900，建议 ≤2048）；深内容放 `references/`。

---

## 5. 通道判定算法（运行时与技能共用）

```text
capability = detect()
  if env.UPP_CHANNEL_FORCE        -> 用指定通道
  if stdin is a pipe && argv has no --cli
        -> mcp（由宿主拉起）
  if argv contains --cli
        -> cli
  if 模型侧（技能）：
        if tool mcp__<server>__<tool> exists -> mcp
        elif <plugin-root> 存在且 node 可用   -> cli
        else                                -> skill-only（降级并说明）
```

**禁止静默降级**：每次降级在信封里写 `channel`；技能层在降级时给用户一句话说明（"当前宿主未注册工具，已走命令行等价通道"）。

---

## 6. 通道选择矩阵

| 场景 | 首选 | 理由 |
| --- | --- | --- |
| 结构化输入/输出、需要 schema 校验 | MCP | 宿主可见 schema，模型少犯错 |
| 宿主未注册 MCP / 未运行 | CLI | 三端都有 shell/子进程能力 |
| 用户只装了技能、没装运行时 | Skill | 至少可读可解释 |
| 需要宿主权限/审批流 | MCP | 走宿主权限模型（Accio allow/ask、WorkBuddy 总闸） |
| 批量/离线/CI | CLI | 无需宿主进程 |

---

## 7. Token 与性能成本

| 通道 | 每次调用 token 成本 | 说明 |
| --- | --- | --- |
| MCP | 工具描述常驻（受 `toolDescriptionBytes` 约束）+ 结果 JSON | 最低，schema 由宿主注入 |
| CLI | 技能说明常驻 + 一次命令与结果 | 中；适合低频兜底 |
| Skill-only | 技能全文 | 最高；仅降级用 |

设计约束：**默认路径是 MCP**，CLI 只做兜底；技能只写"何时用"，不写实现细节——这是"极低 token 消耗"的实现方式（与 [07-migration-and-analyzer.md](07-migration-and-analyzer.md) 的 replication brief 预算同源）。

---

## 8. 失败模式与处理

| 失败 | 表现 | UPP 处理 |
| --- | --- | --- |
| 宿主不启动 MCP 子进程 | 工具不可见 | 技能自动走 CLI；`upp doctor` 报"宿主未注册 serverName" |
| serverName 冲突 | 工具名覆盖/丢失 | 安装器检测同名 server 并拒绝（除非 `--force`） |
| stdout 被日志污染 | 协议解析失败 | 运行时强制日志到 stderr；smoke 用严格 JSON 解析 |
| 超时 | 宿主杀进程 | 运行时自设 15s 上限并返回 `TIMEOUT` 信封 |
| 权限被拒 | 调用被宿主拦截 | 信封 `PERMISSION_DENIED`；安装器在 `permissions` 里提前声明，减少运行时拒绝 |
| 宿主升级改变格式 | 安装/加载失败 | `upp doctor` + 兼容矩阵；适配器只增不删的配置合并策略降低回滚成本 |

---

## 9. 验证入口

```bash
node tests/mcp-smoke.mjs        # 协议 + CLI 等价性（6 项）
node tools/upp.mjs verify --pkg examples/hello-upp   # 三端落盘与配置（13 项）
```
