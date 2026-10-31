# 团队高频插件：sheet-toolkit 与 log-toolkit（同一模板的复制验证）

> 目标：证明 doc-toolkit 不是一次性特例——**同一套 UPP 包结构与"本地执行 + 按需取用"模式，可以低成本复制成团队每天都会用的插件**。
> 本文记录两个真实工作流的落地数据，作为"再做一个插件"的参照。

## 1. 选型：为什么是"Excel 清洗/报表汇总"与"日志检索"

| 判据 | sheet-toolkit | log-toolkit |
|---|---|---|
| 真实高频 | 每周都在清洗导出表、按区域/产品汇总 | 线上问题第一反应就是翻日志 |
| 输入大 | 6000 行 × 10 列 = 350 KB；整表进上下文约 24 万 token | 日志动辄几十万行；整份进上下文不可能 |
| 逻辑全在本地 | ZIP/XML 解析、去空行/去重/trim、分组聚合 | 流式扫描、级别统计、正则匹配、窗口读取 |
| 可量化 | 行数/列数/汇总值硬校验 | 级别计数/首末时间/命中行号硬校验 |
| 三端都需要 | DSH / WorkBuddy / Accio 用户在同一份表上协作 | 同一批机器日志要在三端都能查 |

两个插件均已用 `upp install` 装到三端，`upp verify --hosts dsh,workbuddy,accio` 各 16 项全过。

## 2. 契约（模型看到的就是这些）

### sheet-toolkit

| 工具 | 入参 | 返回（`data`） |
|---|---|---|
| `sheet_profile` | `path*`、`sheet?`、`sampleRows 1-20` | `files/sheets/activeSheet/rows/cols/columns[{name,type,nonEmpty,duplicates}]/sampleRows/truncated` |
| `sheet_clean` | `path*`、`sheet?`、`dropEmptyRows=true`、`trim=true`、`dropDuplicates=true`、`maxRows 1-200` | `rows`（清洗后预览）、`before/after/removedEmpty/removedDuplicate/trimmedCells`、`truncated` |
| `sheet_summary` | `path*`、`sheet?`、`groupBy*`、`values*`（1-5 列）、`aggs`（sum/avg/min/max/count）、`topN 1-50` | `rows:[[group, ...aggs]]`、`totals`、`groups`、`truncated` |

### log-toolkit

| 工具 | 入参 | 返回（`data`） |
|---|---|---|
| `log_scan` | `path*`、`maxLines 100-5000=500`、`tail=true` | `bytes/linesScanned/levelCounts{error,warn,info,debug,other}/firstTs/lastTs/topMessages[{message,count}](≤10)` |
| `log_grep` | `path*`、`pattern*`、`ignoreCase=true`、`contextLines 0-5`、`maxMatches 1-200=50`、`tail=true` | `matches[{line,context}]`、`truncated`、`scannedLines` |
| `log_window` | `path*`、`startLine*`(1-based)、`maxLines 1-200=50` | `lines`、`startLine/endLine/totalLines` |

统一约束（与 doc-toolkit 相同）：仅 `node:` 内置模块、`permissions {network:false, filesystem:'workspace', shell:false}`、统一信封 `{ok,data,channel,host,elapsedMs}`、错误码 `INVALID_ARGS/NOT_FOUND`、单次输出硬上限（sheet ≈12 KB、log ≈16 KB）、`tokenBudget.alwaysLoadedBytes` 1600（实测 sheet 1501 B / log 1582 B）。

## 3. 实测数据

| 项 | sheet-toolkit | log-toolkit |
|---|---|---|
| 运行时行数 | `runtime/server.mjs` 690 行 | 497 行 |
| 规格校验 | `validate` failed 0（1501/1600 B） | failed 0（1582/1600 B） |
| 构建幂等 | 8 个产物，二次 `upToDate:true` | 8 个产物，二次 `upToDate:true` |
| MCP+CLI 对等 | `mcp-smoke` 7/7 | `mcp-smoke` 7/7 |
| 插件测试 | **55 项全 PASS** | **47 项全 PASS** |
| 三端安装 | DSH/WB/Accio install ok，verify 16/16 | 同左，verify 16/16 |
| 活体调用（DSH 本会话） | `mcp__sheet-toolkit__sheet_profile` → 3 sheets / 6 行 / 3 列，`host:"dsh"`，4 ms | `mcp__log-toolkit__log_scan` → 30 行，error 6 / warn 6 / info 12 / debug 5，`host:"dsh"`，2 ms |

关键断言（节选）：

- sheet：Data 表 6 行 3 列、Region 重复 2；`clean` 6→4（空行 1、重复 1、trim 4 个单元格）；`summary` North 2400 / South 1100 / East 500、totals sum 4000 count 5；大文件 `maxRows=200` 时 `truncated:true` 且 stdout < 12 KB。
- log：`tail:true` 取最后 100 行 error=2、`tail:false` 取最前 100 行 error=0；grep 字面/正则、`contextLines`、`ignoreCase`、`maxMatches` 截断；长行输出截到 2000 字符仍按原文匹配；`window` 越界 → `INVALID_ARGS`、缺文件 → `NOT_FOUND`；坏正则 → `INVALID_ARGS`。

## 4. 复制一个插件要改什么

以这两次交付为模板，新插件只需 5 个文件 + 测试：

1. `upp.json`：id/version、`capabilities:[tools,skills]`、`permissions`、三端 `hosts.*.serverName`、`tokenBudget.alwaysLoadedBytes`。
2. `runtime/server.mjs`：`callTool` 信封 + `HANDLERS`（照抄 doc-toolkit/sheet-toolkit 的信封与错误码段）。
3. `runtime/tools.json`：工具名/描述/`inputSchema`（`additionalProperties:false`）。
4. `skills/<id>/SKILL.md`：≤40 字 description + 三步用法（先粗后细）。
5. `smoke.json` + `cordis.patch.yml.tpl`（从任一现成插件复制）。
6. `tests/<id>.test.mjs`：happy path + 边界 + 错误码 + 输出上限；加进 `tests/run-all.mjs`。

**三条硬规则**（违反即测不过或模型侧变贵）：工具只返回 bounded 摘要/窗口；重逻辑留在本地进程；常驻工具面 ≤ 1.6 KB（`validate` 会算）。

## 5. 边界

- sheet：列类型只推断 `number|string|date|empty`；公式按缓存值读（不是重算）；`dropDuplicates` 以整行值比较；超大表超预算即 `truncated`，不报错。
- log：文本日志（`.log/.txt/.jsonl/.csv`），不做二进制/压缩包；`topMessages` 归一化会去掉时间戳/数字/hex，聚合结果用于"找模式"而非精确计数；grep 命中预算即截断。
- 两者都**不联网、不执行插件外的代码**；文件路径必须在可读工作区。

## 6. 复现

```bash
cd upp
node tools/upp.mjs validate --pkg examples/sheet-toolkit
node tools/upp.mjs validate --pkg examples/log-toolkit
node tests/sheet-toolkit.test.mjs     # 55 checks
node tests/log-toolkit.test.mjs       # 47 checks
node tools/upp.mjs install --pkg examples/sheet-toolkit --hosts dsh,workbuddy,accio
node tools/upp.mjs install --pkg examples/log-toolkit   --hosts dsh,workbuddy,accio
node tools/upp.mjs verify  --pkg examples/sheet-toolkit --hosts dsh,workbuddy,accio
node tools/upp.mjs verify  --pkg examples/log-toolkit   --hosts dsh,workbuddy,accio
node tests/run-all.mjs                # 15 步发版门槛
```
