# uppmem — 共享记忆池（契约冻结，v1）

三端（DSH / WorkBuddy / Accio）的 agent 共用一个记忆池：`~/.uppmem/`。
`uppmem` 零依赖 ESM CLI（`tools/uppmem.mjs`）+ 核心（`lib/uppmem/core.mjs`）+ 宿主适配器（`lib/uppmem/hosts/<host>.mjs`）+ MCP stdio 服务器（`lib/uppmem/mcp-server.mjs`，命令 `uppmem mcp`）。

## 存储布局

```
$UPPMEM_HOME 或 ~/.uppmem/
  pool/entries/<id>.json   # 一条记忆一个文件
  index.json               # 索引：schema/updatedAt/count/byKind/digest/entries[]（可随时从 pool 重建）
                         # digest = sha256 over sorted lines "<entry.id>:<entry.hash>"
  MEMORY.md                # 给 agent 直接读的规范快照（有界、稳定排序）
  state.json               # 每个宿主的最近同步信息（file sha256 / 时间）
```

启动时的根目录探测复用 `lib/uppenv/core/util.mjs` 的 `detectRoots()`；`UPPMEM_HOME` 覆盖默认路径。

## 记忆条目（canonical entry）

```js
{
  schema: 'uppmem/1',
  id: 'm-<12hex>',            // 稳定：由 key 或 text 归一化哈希派生
  key: 'user.language',       // 可选语义键（同一 key 覆盖更新）
  text: '用户偏好用中文回答',   // 必填，单条 ≤ 4000 字符
  kind: 'fact',               // fact | preference | decision | project | convention | task | note
  tags: ['lang'],             // 字符串数组，小写 kebab
  scope: 'global',            // global（默认）；host:<name> 表示仅该宿主
  source: { host: 'workbuddy', path: '~/.workbuddy/memory/x_memory.md' },  // 来源，可空
  createdAt: ISO, updatedAt: ISO,
  hash: '<sha256(text 归一化)>',   // 去重/合并依据
  managed: true                // 是否由 uppmem 写入宿主文件（宿主原生条目为 false）
}
```

归一化：`text` **保留作者字符**（全角标点、中文标点原样保留），只去首尾空白并折叠内部空白；
`hash = sha256(NFKC(text))` —— 身份判定（去重/ID）按 NFKC，展示与回写按原文。
`raw` 字段恒为 `null`（保留位，兼容宿主差异）。
合并规则：同 `key` 或同 `hash` → 更新（LWW：`updatedAt` 较新者胜，旧的作为 `prev` 不落盘）；`id` 由 `key` 或 `hash` 派生，保证跨机稳定。

## 宿主适配器契约（`lib/uppmem/hosts/<host>.mjs`）

```js
export const name = 'workbuddy'          // 必填，与文件名一致
export const memoryFileFormat = 'markdown-json-block'   // 说明性

export function detect(ctx) -> {
  host, available: boolean, version?, reason?,
  paths: { memoryFile?: abs, account?: string, ... }     // 用于 hosts 命令展示
}

// 从宿主原生记忆拉取到池（只读宿主；不写）
export async function pull(ctx) -> {
  host, available,
  files: [{
    path, format, exists, size?, sha256?,
    entries: [{ key?, text, kind?, tags?, updatedAt? }],
    raw?: string            // 可选：解析失败时保留原文
  }],
  warnings: []
}

// 把池内条目写回宿主原生记忆（保留宿主其它内容；写前备份；受 tx 保护）
export async function push(ctx, { entries, dryRun, tx }) -> {
  host,
  files: [{ path, action: 'create'|'update'|'noop'|'skip', entries: n, bytes?, skipped?: string }],
  warnings: []
}

// 可选：给没有原生记忆文件的宿主安装采集入口（DSH 用）
export async function install(ctx, { dryRun, tx }) -> { host, files: [...], warnings: [] }
```

`ctx`：`{ roots, env, options: {dryRun, onConflict, scope}, log(msg), now() }`，`roots` 来自 `detectRoots()`，至少含 `home, dshHome, workbuddyHome, codebuddyHome, accioHome, uppStore, uppMemHome`。
所有写操作必须走 `tx`（`lib/uppenv/core/tx.mjs` 的 Tx 实例，提供 `backup/writeFile/writeText/remove/log`）；`dryRun` 时不落盘。
托管内容用标记包裹，push 幂等（同内容 → `noop`）：
`<!-- uppmem:begin --> ... <!-- uppmem:end -->`

## CLI 命令（冻结）

```
uppmem add <text> [--kind fact] [--tag a,b] [--key k] [--scope global|host:dsh] [--source host] [--json]
uppmem list [--kind] [--tag] [--scope] [--json]
uppmem search <query> [--kind] [--tag] [--limit 20] [--json]
uppmem get <id|key> [--json]
uppmem rm <id|key> [--force] [--json]
uppmem build                      # 重建 index.json + MEMORY.md
uppmem export -o mem.uppmem [--json]     # ZIP，含 manifest.json + pool/entries/*.json
uppmem import <mem.uppmem> [--on-conflict skip|overwrite|rename] [--dry-run] [--yes]
uppmem sync --host workbuddy|accio|dsh [--push|--pull|--both] [--dry-run] [--json]
uppmem hosts [--json]
uppmem mcp                        # stdio MCP server（内存工具）
uppmem doctor [--json]
uppmem stats [--json]
uppmem version | help
```

- 默认 `--both`；`--dry-run` 打印计划零写入。
- `sync --pull` 只读宿主写池；`--push` 只写宿主；输出每文件 `create/update/noop/skip`。
- `--json` 输出机器可读结果（测试依赖）。
- MCP 服务器工具名：`memory_search`、`memory_list`、`memory_get`、`memory_add`、`memory_stats`；JSON-RPC 2.0 ndjson over stdio，`initialize` 后 `tools/list`。

## 验收

- 三端各一条 `test-uppmem.mjs` 用例：假 HOME 下 `add → sync --push → sync --pull` 往返、托管标记幂等、`--dry-run` 零写入。
- `uppmem export/import` 往返（跨机器）后条目与哈希一致。
- MCP：spawn `uppmem mcp` 完成 `initialize` + `tools/list` + 一次 `memory_add`/`memory_search` 往返。
