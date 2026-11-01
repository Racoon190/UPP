# 18 · uppmem：三端共享记忆池

> 一句话：DSH / WorkBuddy / Accio 三端的 agent 共用一个记忆目录 `~/.uppmem`；每个宿主的原生记忆文件通过 `uppmem sync` 与它双向同步，MCP 宿主还可以直接挂 `uppmem mcp` 在线读写。

- 状态：v1 已实现并真机跑通（2026-11-01，Windows 11，Node v26.12.0）
- 入口：`upp/tools/uppmem.mjs`（零依赖）+ `lib/uppmem/core.mjs` + `lib/uppmem/hosts/{dsh,workbuddy,accio}.mjs` + `lib/uppmem/mcp-server.mjs`；也可 `node tools/upp.mjs mem <command>`
- 状态目录：`UPPMEM_HOME` 或 `~/.uppmem/`

## 1. 为什么需要「共享」而不是各记各的

三端各自有记忆能力，但彼此不可见：在 DSH 里说过的偏好，切到 WorkBuddy 就不存在了；Accio 的 PROFILE 又只有它自己读。结果是同一个人要在三个地方重复交代同一件事。

`uppmem` 把记忆抽成一个**机器级单一事实源**：

- 一份权威副本：`~/.uppmem/pool/entries/*.json`（跨宿主、跨会话、跨重启）；
- 一份人/agent 可直读快照：`~/.uppmem/MEMORY.md`（有界、稳定排序，agent 读它比逐条搜索便宜）；
- 每个宿主的原生记忆文件只是**投影**：`sync` 负责双向对齐，写前备份、幂等、可回滚。

## 2. 布局与条目

```
~/.uppmem/
  pool/entries/<id>.json   一条记忆一个文件（schema uppmem/1）
  index.json               索引（count/byKind/tags，可重建）
  MEMORY.md                生成快照（按 kind 分组，最多 200 条，单条截断 500 字符）
  state.json               每个宿主的最近同步信息
  tx/<ts>/                 同步写入的事务日志与备份（rollback 用）
```

条目：

```json
{
  "schema": "uppmem/1",
  "id": "m-2b5d090fab38",
  "key": "user.language",
  "text": "用户偏好中文回答",
  "kind": "preference",
  "tags": ["lang"],
  "scope": "global",
  "source": { "host": "workbuddy", "path": "..._memory.md" },
  "createdAt": "...", "updatedAt": "...",
  "hash": "<sha256(归一化文本)>",
  "managed": true
}
```

- `kind`：`fact | preference | decision | project | convention | task | note`
- `key` 语义键（如 `user.language`）→ 同 key 覆盖更新；无 key 时按文本哈希去重
- `id` 由 key 或文本哈希派生 → 跨机器稳定，导出/导入不会变成两条
- 归一化：NFKC + 折叠空白 + 去首尾；`hash` 用于去重与冲突判定

## 3. 命令

```bash
uppmem add "用户偏好中文回答与简洁结论" --kind preference --tag lang --key user.language
uppmem search "语言" --limit 5
uppmem list --kind decision
uppmem get user.language
uppmem rm m-2b5d090fab38

uppmem build                    # 重建 index.json + MEMORY.md
uppmem stats
uppmem export -o memory.uppmem  # 整池打包（跨机器）
uppmem import memory.uppmem --on-conflict skip

uppmem hosts                    # 三端记忆位置探测
uppmem sync --host workbuddy --both          # 默认 both
uppmem sync --host dsh,workbuddy,accio --dry-run
uppmem install --host dsh       # 只装采集入口（SKILL.md）
uppmem mcp                      # stdio MCP server
uppmem doctor
```

全部 `--json`。

## 4. 三端怎么接（都是「投影」，不是搬家）

| 宿主 | 原生位置 | 同步方式 |
|---|---|---|
| **WorkBuddy** | `~/.workbuddy/memory/<account>_memory.md`（`# User Memory Profile` + `RAW_JSON_START` 块） | 在文件末尾追加/更新 `<!-- uppmem:begin --> ... <!-- uppmem:end -->` 托管区；**RAW JSON 块与其它内容原样保留**；account id 自动探测 |
| **Accio** | `~/.accio/accounts/<account>/global-memory/PROFILE.md` | 同样用托管区追加，不动模板正文 |
| **DSH** | 无原生记忆文件 | 安装 `~/.dsh/skills/upp-memory/SKILL.md`（指导 agent 先读 MEMORY.md 再 `uppmem search/add`）+ 生成 `MEMORY.md` 快照；DSH 是无头宿主，靠**技能 + shell** 接入 |

托管区的条目语法（WorkBuddy / Accio）：

```markdown
<!-- uppmem:begin -->
## Shared memory (managed by uppmem)

- [preference] 用户偏好中文回答 <!-- uppmem:key=user.language tags=lang updated=2026-11-01T13:18:23Z -->
<!-- uppmem:end -->
```

- 重复 push 同内容 → `noop`（字节比较，不重写）
- push 前经 `tx` 备份原文件；失败可回滚
- pull 只读宿主、只解析托管区；宿主原生（非托管）内容按 `note` 吸收，且带 `source` 溯源

## 5. MCP：让任意 MCP 宿主直接共享

```bash
uppmem mcp     # newline-delimited JSON-RPC 2.0 over stdio
```

工具面（5 个）：

| 工具 | 用途 |
|---|---|
| `memory_search` | 按 query/kind/tag 检索全池 |
| `memory_list` | 列最近条目 |
| `memory_get` | 按 id/key 取一条 |
| `memory_add` | 写入一条（自动去重/更新） |
| `memory_stats` | 条目数、kind 分布、已同步宿主 |

MCP 宿主（包括 DSH 的 MCP 能力、任何支持 stdio MCP 的客户端）配一个 server 命令 `node <upp>/tools/uppmem.mjs mcp` 即可获得**同一份**记忆。

## 6. 同步语义（重要）

- `sync --both` = 先 **pull**（宿主 → 池）再 **push**（池 → 宿主）；`--pull`/`--push` 单独执行。
- **LWW**：同一 key/文本，`updatedAt` 较新者胜；pull 到旧版本会跳过（`reason: newer local copy`）。
- **范围**：默认同步 `scope: global`；`host:<name>` 的条目只推给指定宿主。
- **幂等**：同内容再 push 为 `noop`；第二次 `sync --both` 全 noop（真机已验证）。
- **dry-run**：只打印计划，不建目录、不写文件（真机验证 `files-written: 0`）。
- `state.json` 记录每个宿主最近同步时间与文件动作，`uppmem stats` 可查。

## 7. 真机验证（2026-11-01）

- 假 HOME 三宿主（DSH/WB/Accio）各建原生记忆文件 → `uppmem add` 两条 → `sync --both`：三个宿主分别出现 SKILL.md+MEMORY.md、WB 托管区、Accio 托管区；WB 的 `RAW_JSON_START` 块与 Accio 模板正文**逐字节保留**。
- 第二次 `sync --push`：三个宿主全部 `noop`（0 次写入）。
- 把 WB/Accio 的托管区 pull 回空池：`created: 2`，`key/tags/updated` 完整还原（`user.language` 保留）。
- `--dry-run` 于全新假 HOME：`files-written: 0`。
- MCP：`initialize` → `protocolVersion 2024-11-05`、`serverInfo.name uppmem` → `tools/list` 5 个工具 → `memory_add` → `memory_search` 命中 → `memory_stats` 计数 1，全链路通过。
- 真实 DSH profile：`sync --host dsh` 后 `~/.dsh/skills/upp-memory/{SKILL.md,MEMORY.md}` 生成，会话技能目录出现 `upp-memory`（说明技能热加载生效）。

## 8. 边界与安全

- **明文存储**：`~/.uppmem` 与宿主记忆文件都是明文，**不要写密钥/令牌/隐私证件**；SKILL.md 里明确写了这条约束。
- **不替代宿主原生记忆**：托管区之外的内容不会被 uppmem 改写；卸载只需删托管区（或 `rm -rf ~/.uppmem`）。
- **冲突不做三方合并**：LWW + 去重，不做字段级 merge；并发写同一 key 时后写覆盖。
- **DSH 需要主动调用**：没有原生记忆钩子，DSH agent 依赖 `upp-memory` 技能自觉 `search/add`；MCP 接入可减少这一步。
- **大小有界**：单条 ≤ 4000 字符；MEMORY.md 最多 200 条（超出用 `search`）。
