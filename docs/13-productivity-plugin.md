# 第一个生产力插件：doc-toolkit（本地解析、按需取用）

> 目标：用**真实工作流**证明「本地执行 + 按需调用」不是口号——把文档/表格的解析放在本机进程里，
> 模型只拿一份约 1 KB 的结构摘要，真需要内容时再取一小段窗口。
> 实测结论：同一份 `.upp` 三端安装成功；6,001 行 × 10 列的工作簿，整本塞进上下文约 24 万 token，
> `digest` 只要约 **389 token**（≈621×）；20,001 行 CSV 从 26.9 万降到 **376 token**（≈714×）。

## 1. 为什么是"文档处理"这个工作流

| 判据 | 这个工作流 |
|---|---|
| 真实高频 | 读需求文档、看销售表、核对导出数据，任何团队每天都在做 |
| 文件大 | 一份 6,000 行的 xlsx 就有 350 KB；整本进上下文既贵又容易超窗 |
| 逻辑全在本地 | 解 ZIP/XML、CSV 转义、列类型推断，不需要任何模型参与 |
| 可量化 | 源文件字节 / 摘要字节 / 取用窗口字节，全部可测 |

这不是"伪示例"：插件已经在三端装好，可以直接让任意一端的 Agent 用。

## 2. 插件形态

`examples/doc-toolkit/` 是一个标准 UPP 包（72 行 `upp.json` + 一个零依赖运行时）：

```
doc-toolkit/
  upp.json                     # 唯一真源：工具面、技能、权限、tokenBudget
  runtime/server.mjs           # MCP stdio + CLI 双模，零依赖，约 560 行
  runtime/tools.json           # 工具模式（build 从清单派生）
  skills/doc-toolkit/SKILL.md  # 引导层：先 digest 后 extract
  smoke.json                   # 测试夹具参数（不属于工具 schema，MCP 客户端看不到）
  cordis.patch.yml.tpl         # DSH 适配模板
  .claude-plugin/ .codebuddy-plugin/ .mcp.json clis/clis.json package.json  # 三端兼容清单（build 生成）
```

权限与成本声明（`upp.json`）：

```json
"permissions": { "network": false, "filesystem": "workspace", "shell": false },
"tokenBudget": {
  "alwaysLoadedBytes": 1600,
  "note": "Two tools only. Heavy parsing stays inside the local runtime; callers pay for a digest (~1 KB) instead of the file."
}
```

`tokenBudget` 是**硬门槛**：`upp validate` 会计算"常驻模型可见面"（两个工具的 schema + description、
SKILL.md 的 name/description）字节数，超过 `alwaysLoadedBytes` 直接 fail。doc-toolkit 实测 1,601 B（PDF/PPTX 支持后仍远低于 1800 B 预算）。

## 3. 工具契约（两个工具，够用为止）

| 工具 | 参数 | 返回（`data`） | 错误码 |
|---|---|---|---|
| `digest` | `path`（必填）；`sampleRows` 1–20 默认 5（xlsx 采样行 / pptx 采样页） | `kind/bytes`、docx 的 `paragraphs/headings/outline/head`、xlsx 的 `sheets/detail[{name,rows,cols,header,sample}]`、csv 的 `rows/cols/header/columns[type]/sample`、html 的 `title/links/images`、pptx 的 `slides/titles/sample[{index,title,chars,head}]`、pdf 的 `pages/images/producer/hasTextLayer`、`digestBytes` | `NOT_FOUND`、`INVALID_ARGS`（不支持的类型） |
| `extract` | `path`（必填）；文本类 `start` / `maxChars`(200–48000)；表格类 `startRow` / `maxRows`(1–200) / `sheet`；pptX `startRow`=首个 slide(0-based) / `maxRows`(1–50)=页数 | 文本 `text/chars/totalChars/nextStart`；表格 `rows/totalRows/nextStartRow/sheet`；pptx `text/slides/totalSlides/nextStartRow`；pdf 同文本 + `pages/hasTextLayer` | 同上 |

设计原则（写进 `SKILL.md` 让模型照做）：

1. **先 digest**：拿到结构、表头、列类型、前几行；
2. 只有用户真的要内容时 `extract` **一个窗口**（默认 200 行 / 4000 字）；
3. 用 `nextStartRow` / `nextStart` 翻页，**不要**一次性取整本；
4. 不把整窗内容复制到回复里，只报需要的行/列。

## 4. 三端安装（同一条命令）

```bash
cd upp
node tools/upp.mjs build   --pkg examples/doc-toolkit
node tools/upp.mjs install --pkg examples/doc-toolkit --hosts dsh,workbuddy,accio
node tools/upp.mjs verify  --pkg examples/doc-toolkit --hosts dsh,workbuddy,accio   # failed=0
```

本次本机实测：

| 宿主 | 落点 | 生效方式 | 实测 |
|---|---|---|---|
| DSH | profile `@upp/doc-toolkit` + patch 的 MCP 行 + `~/.dsh/skills/doc-toolkit` | MCP **热加载**，本会话立即可调 | `mcp__doc-toolkit__digest` 返回 `channel:"mcp"`, `host:"dsh"`, `elapsedMs:92` |
| WorkBuddy | `~/.workbuddy/skills/doc-toolkit` + `~/.codebuddy/mcp.json` + `upp-local` 本地市场插件 | 技能 ~3 s 热重载；MCP 重连后可用 | `verify` 三项全 ok |
| Accio | `~/.accio/accounts/<id>/skills/doc-toolkit` + `skills_config.json` + Gateway `server add` | 自动注册，`server test` 发现 2 个工具 | `verify` 三项全 ok |

## 5. 省积分实测（同一台机器，2026-11-01）

测量口径：**全量进上下文** = 把文件内容全部转成文本/CSV 后按 4 字节≈1 token 估算；
**digest** = 工具返回值（含 sample 行）的真实字节数 ÷ 4；两者都是输入 token。

| 文件 | 规模 | 全量进上下文 | `digest` 实测 | 倍数 |
|---|---|---|---|---|
| `big.csv` | 1.07 MB / 20,001 行 × 8 列 | ≈268,600 token | **376 token**（1,503 B） | **≈714×** |
| `big.xlsx` | 350 KB / 6,001 行 × 10 列 | ≈241,600 token | **389 token**（1,555 B） | **≈621×** |
| `big.docx` | 38.7 KB / 190,676 字 / 32,403 词 | ≈47,700 token | **273 token**（1,093 B） | **≈175×** |

按需取用窗口（big.xlsx，从第 100 行起）：

| `maxRows` | 返回字节 | ≈token | 本机耗时 |
|---|---|---|---|
| 5 | 1,805 B | 451 | 166 ms |
| 20 | 6,088 B | 1,522 | 163 ms |
| 50 | 14,695 B | 3,674 | 170 ms |

结论：

- **插件本身不产生任何模型调用**（零 LLM、零网络、零积分），积分只花在"模型读工具返回值"上；
- 单文件输入成本从 **六位数 token 降到三位数**；需要细节时按窗口加，不读整本；
- 解析延迟 78–170 ms，比一次模型往返便宜得多；
- 常驻工具面 1,461 B（≈365 token），只付一次。

> 这就是"本地执行、按需调用"的可量化收益：**贵的东西留在本地，上下文只放结论和窗口。**

## 6. 在 DSH 会话里的真实调用

```
mcp__doc-toolkit__digest  { path: "…/tests/.tmp-big/big.xlsx", sampleRows: 3 }
→ {"ok":true,"data":{"kind":"xlsx","sheets":1,"detail":[{"name":"Export","rows":6001,"cols":10,
   "header":["id","date","region","product","units","revenue","cost","margin","rep","note"], …}],
   "digestBytes":736},"channel":"mcp","host":"dsh","elapsedMs":92}
```

同一份产物在 WorkBuddy / Accio 是同一个 MCP server、同一份 `tools.json`、同一个信封；
CLI 通道（`node runtime/server.mjs --cli digest --json '{...}'`）返回同样的 `data`，
由 `tests/mcp-smoke.mjs` 的 `parity.mcp_vs_cli` 断言保证。

## 7. 想换成你自己的业务逻辑

1. 复制 `examples/doc-toolkit` → 改 `upp.json` 的 `id/name/hosts`；
2. 在 `runtime/server.mjs` 的 `HANDLERS` 里换实现（保持"参数校验 → 处理 → 返回 data"三段式）；
3. 改 `runtime/tools.json` 的 `description/inputSchema`（描述要写"什么时候用"，这是模型唯一的入口信息）；
4. 改 `skills/<id>/SKILL.md` 的三步探测与使用顺序；
5. `node tools/upp.mjs validate/build/install/verify` + `node tests/mcp-smoke.mjs examples/<id>`。

## 8. 边界（诚实声明）

- docx：读取段落文本、标题层级、表格单元格文本；**不解析**页眉页脚/批注/修订/嵌入对象；
- xlsx：读取单元格值（含 inlineStr/sharedStrings）；**不求值**公式（读缓存值）；不读图表/图片；
- csv：RFC4180（引号、转义、CRLF）；不做编码探测（按 UTF-8）；
- html：去 script/style 后的正文；不做完整 DOM/选择器；
- pptx：按 `ppt/presentation.xml` 的 sldId 顺序读每页 `<a:t>` 文本与标题占位符；**不解析**图表/图片/动画/备注；
- pdf：本地流式解析文本层（FlateDecode + `BT/ET`、`Tj/TJ`、ToUnicode CMap）；**扫描版 PDF 返回 `hasTextLayer:false` 且无文本**（OCR 不在范围内），页数按页对象计数为近似值；
- 单文件读取上限 48,000 字符/窗（可翻页）；PDF 不支持（见 [10-roadmap.md](10-roadmap.md) 的候选）。

## 9. 回归与证据

```bash
node tests/doc-toolkit.test.mjs        # 40 项：七格式 digest + 四类窗口（文本/行/slide）+ 错误码 + tokenBudget
node tests/run-all.mjs                 # 13 步发布门（第 7 步就是本插件）
node tools/upp.mjs verify --pkg examples/doc-toolkit --hosts dsh,workbuddy,accio
```

夹具与复现脚本：`tests/fixtures/doc/`（7 个样本：docx/xlsx/csv/html/pdf/pdf-flate/pptx，已提交）、`tests/_make_doc_fixtures.py` 与 `tests/_make_pdf_pptx_fixtures.py`（用 python-docx/openpyxl/python-pptx + 手写最小 PDF 重新生成）。
