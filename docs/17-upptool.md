# 17 · upptool：可复用工具注册表（省 token）

> 一句话：把「已经写对过一次」的脚本、命令、批处理沉淀成本地工具，下次直接 `upptool run`，不再让模型重新生成——`upp` 管插件、`uppenv` 管整机环境，`upptool` 管**重复劳动**。

- 状态：v1 已实现并真机跑通（2026-11-01，Windows 11，Node v26.12.0）
- 入口：`upp/tools/upptool.mjs`（零依赖）+ `upp/lib/upptool/core.mjs`；也可 `node tools/upp.mjs tool <command>`
- 状态目录：`UPPTOOL_HOME` 或 `~/.upptool/`（`index.json` + `tools/<slug>/` + `runs.jsonl`）

## 1. 它解决什么问题

长任务里反复出现三类浪费：

1. **重复劳动**：同一个「xlsx → csv」脚本，今天写一次，明天让模型再写一次，token 白花还容易写歪；
2. **批处理**：几十个文件要来一遍同样的转换，模型逐步调用既慢又贵；
3. **一次性工具**：为某次任务现场生成的小脚本，用完即弃，下次从零再来。

`upptool` 让这些工具**一次登记、永久本地执行**：模型只需 `upptool suggest "<任务>"` 看有没有现成的，有就 `run`，没有才生成并 `add`。

## 2. 磁盘布局

```
~/.upptool/
  index.json                轻量索引（list/search 用，可重建）
  tools/<slug>/tool.json    完整记录
  tools/<slug>/files/...    登记时复制的文件（脚本、模板、数据）
  runs.jsonl                追加式运行日志（时间/退出码/耗时/估算省下的 token）
  tmp/                      运行期临时目录
```

`tool.json` 关键字段：`id/name/desc/kind(script|command|batch|pipeline)/runtime(node|bash|python|exec|cmd)/entry/command/args/tags/files(rel+sha256+size)/hash/savedTokens/createdFrom.task/runs/savedTotal`。

## 3. 命令

```bash
# 登记：脚本、目录、或一条命令模板
upptool add ./sheet-to-csv.mjs --name sheet-to-csv --desc "xlsx -> csv" --tag xlsx,csv
upptool add ./tools/ --name pdf-batch --entry run.mjs --tag pdf
upptool add --name greet --command 'echo hello $1' --kind command

# 复用：先问有没有，再执行
upptool suggest "把表格转成 csv"        # 0.95  sheet-to-csv  (name prefix match)
upptool list
upptool run sheet-to-csv -- book.xlsx book.csv
upptool batch jobs.json                  # [{"tool":"sheet-to-csv","args":["a.xlsx","a.csv"]}, ...]

# 管理
upptool show sheet-to-csv
upptool rm sheet-to-csv [--force]        # 运行过需 --force
upptool stats                            # runs / 估算省下的 token / top 工具
upptool export -o my-tools.upptool       # 换机器：打包
upptool import my-tools.upptool --on-conflict skip
upptool doctor
```

所有命令支持 `--json`。被运行工具的退出码原样透传（脚本失败 = 非零退出码），`upptool` 自己的用法错误为 2。

## 4. 三个防重复机制（这是省 token 的关键）

1. **内容指纹去重**：`add` 先对源文件算 `sha256` 与 `contentHash`，同样的脚本再登记一次会返回 `duplicateOf`，直接提示去 `run`，不会存第二份；
2. **近似推荐**：`suggest` 对 name/desc/tags 做词重叠 + 前缀打分（≥0.6 就值得复用），避免「其实已经有，但又写一个」；
3. **收益提示**：单文件 < 400B 且没标 `--saved-tokens` 时提醒「登记成本可能高于重写」，防止把一行命令也塞进注册表。

## 5. 与 upp / uppenv 的关系

| 工具 | 管什么 | 产物 |
|---|---|---|
| `upp` | 一个**插件**装到三端 | `.upp` 包 |
| `uppenv` | 一台机器的**环境**（插件/技能/MCP/工具清单/记忆） | `.uppenv` 镜像 |
| `upptool` | 一批**可复用工具**（脚本/命令/批处理） | `~/.upptool` + `.upptool` 包 |

`upptool` 的 `.upptool` 包可以单独带走，也可以被 `uppenv` 当作环境的一部分（工具清单/工具目录）一起迁移。工具执行不依赖网络、不依赖模型，纯本地进程。

## 6. 真机验证

- `add` 脚本 → `run -- a b` 输出 `argv: a,b`；`run -- fail` 退出码 7 原样透传；`runs.jsonl` 与 `savedTotal` 同步累加（2 次运行 = 2000 估算 token）。
- 重复 `add` 同内容 → `skipped: ... already registered`，且**不删除**已有工具（此 bug 在开发中实测修掉）。
- `batch` 两工具 + 一条失败命令 → `1/2 succeeded`，退出码 1，`--continue-on-error` 默认开启。
- `export` → 新 HOME `import` → `run` 仍可执行，`doctor` 全绿（哈希校验通过）。
- `upp tool version` / `upp mem version` 子命令转发正常。

## 7. 边界（诚实声明）

- **不判断任务该不该复用**：`suggest` 只按文本相似度排序，最终由 agent 决定；语义级判断仍要模型参与（这正是 `suggest` 存在的意义：把判断成本从「重新生成」降到「看 3 行列表」）。
- **`savedTokens` 是估算**：默认按 kind 给 300–600，`add --saved-tokens` 可覆盖；`stats` 展示的是「估算省下」，不是计费账单。
- **不隔离运行环境**：工具以当前用户身份、在工作目录/工具目录下执行，没有容器沙箱；登记第三方脚本前应自己审一遍。
- **不做版本管理**：同一工具重复 `--force` 覆盖；需要多版本时用不同 `--name`。
