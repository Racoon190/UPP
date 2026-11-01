# upptool — 可复用工具注册表（契约冻结，v1）

把任务里「重复劳动 / 批处理 / 现场生成的一次性脚本」沉淀成本地工具：下次 `upptool run <id>` 直接执行，不再让模型重新生成，省 token。
零依赖 ESM CLI：`tools/upptool.mjs` + 核心 `lib/upptool/core.mjs`；打包复用 `lib/uppenv/core/archive.mjs` 的 `writeZip/readZip`。

## 存储布局

```
$UPPTOOL_HOME 或 ~/.upptool/
  index.json                  # 轻量索引（list/search 用）
  tools/<slug>/tool.json      # 完整记录
  tools/<slug>/files/...      # 被登记的文件（脚本、模板、数据）
  runs.jsonl                  # 追加式运行日志
  tmp/                        # 运行期临时目录
```

`slug` 由 `name` 归一化派生（小写 kebab，冲突加 `-2`），`id === slug`。

## 工具记录（tool.json）

```js
{
  schema: 'upptool/1',
  id: 'sheet-to-csv',
  name: 'sheet-to-csv',
  desc: '把 xlsx 第一个 sheet 转成 csv',
  kind: 'script',              // script | command | batch | pipeline
  runtime: 'node',             // node | bash | python | exec | cmd
  entry: 'files/sheet-to-csv.mjs',   // 相对 tools/<slug>/；command 类可为 null
  command: null,               // runtime=command/cmd 时的完整命令模板（含 $1 $2 占位）
  args: [{ name, desc, required, default }],
  usage: 'upptool run sheet-to-csv -- in.xlsx out.csv',
  examples: ['upptool run sheet-to-csv -- book.xlsx book.csv'],
  tags: ['xlsx', 'csv'],
  inputs: 'xlsx path', outputs: 'csv path',
  files: [{ rel, sha256, size }],       // 所有被登记文件
  hash: '<sha256(tool.json 去掉运行时计数字段)>',  // 内容指纹
  createdFrom: { task: '任务描述', source: 'agent', host: 'dsh' },
  savedTokens: 800,           // 估算：不登记时每次重新生成该工具的 token 成本
  version: 1,
  createdAt: ISO, updatedAt: ISO,
  runs: 0, lastRunAt: null, savedTotal: 0
}
```

`index.json`：`{ schema:'upptool/1', updatedAt, count, tools:[{id,name,desc,kind,runtime,tags,hash,runs,savedTotal}] }`。

## 核心 API（`lib/upptool/core.mjs`）

- `root(env?)`、`loadIndex()`、`saveIndex()`、`rebuildIndex()`
- `listTools({ tag, kind, q })`
- `resolveTool(ref)`：`id` / `name` / 唯一前缀 / 唯一子串；歧义时抛 `E_AMBIGUOUS`（附候选）
- `addTool({ from, name, desc, kind, runtime, entry, command, tags, args, examples, inputs, outputs, savedTokens, task, source, host, copy = true, force = false })` → `{ created, tool, duplicateOf?, warnings }`；`from` 为文件或目录；同 `hash` 已存在且未 `--force` → `created:false, duplicateOf`
- `updateTool(id, patch)`、`removeTool(id, { force })`
- `runTool(id, argv, { cwd, input, timeoutMs, env })` → `{ ok, exit, signal?, durationMs, stdout, stderr, savedTokens, logLine }`；写 runs.jsonl 并更新记录计数
- `runBatch(file, { cwd, timeoutMs, continueOnError })`：文件为 JSON `[{ tool, args }]` 或 JSONL；也接受 `{ command }` 原始命令（走 `exec`）
- `suggestTools(text)`：对 name/desc/tags 做 token 重叠 + 前缀匹配打分，返回 `[{ id, score, why }]`
- `exportBundle(file, { ids })` / `importBundle(file, { onConflict })` → ZIP：`manifest.json` + `tools/<slug>/**`
- `stats()` → `{ tools, runs, savedTokens, topTools:[{id,runs,savedTotal}] }`

## CLI 命令（冻结）

```
upptool add <file|dir> --name <id> [--desc] [--kind script|command|batch] [--runtime node|bash|python|exec|cmd]
             [--entry <rel>] [--command "<tpl>"] [--tag a,b] [--task "<原始任务>"]
             [--saved-tokens N] [--from-host dsh|workbuddy|accio] [--force] [--json]
upptool list [--tag a,b] [--kind] [--json]
upptool show <id> [--json]
upptool run <id> [--cwd <dir>] [--timeout 120000] [--json] -- [args...]
upptool batch <file.json|jsonl> [--continue-on-error] [--json]
upptool suggest "<task text>" [--json]
upptool search <query> [--json]
upptool rm <id> [--force] [--json]
upptool export -o bundle.upptool [--id a,b] [--json]
upptool import <bundle.upptool> [--on-conflict skip|overwrite|rename] [--force] [--json]
upptool stats [--json]
upptool doctor [--json]
upptool version | help
```

退出码：工具自身成功 → 0；被运行的工具失败 → 透传其退出码；`upptool` 用法错误 → 2。

## 判定「值不值得登记」

`add` 时给提示（不阻断）：文件 < 400 字节且 `savedTokens < 200` → 提醒「太小，收益有限」；`suggest` 有 ≥0.6 相似项 → 提示「已有近似工具 <id>，是否用 `run` 复用」。

## 验收（`tools/test-upptool.mjs`）

- add/list/show/search/suggest/rm 全链路；重复 add 返回 `duplicateOf`
- `run` 一个 node 脚本与一个 `command` 工具，退出码透传、runs.jsonl 增加、`savedTokens` 累计
- `batch` 两工具顺序执行、失败不中断（`--continue-on-error`）
- export → 新 HOME import → `run` 仍可执行（哈希一致）
- `stats --json` 数字自洽
