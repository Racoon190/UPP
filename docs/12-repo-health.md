# 12 仓库基线与发布健康检查

> 用途：把"可交付"变成"可追溯"。本页记录仓库基线（commit/tag）、清理口径、`upp doctor` 健康结果与复现命令。
> 基线时间：2026-10-31；环境：Windows 11，Node v26.12.0，DSH 5.x desktop / WorkBuddy 5.9.3 / Accio Work。

---

## 1. 仓库基线

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 首次提交 | `119f5a7ac95213427615d05900ba52fd4bdbbdaf` |
| 基线提交 | `dc1cab8`（doc-toolkit）；本页随团队插件提交更新，HEAD 以 `git log -1` 为准 |
| 标签 | `upp-v1.0.0`（annotated，指向绿色 CI 提交 `cc23a56`） |
| 跟踪文件 | 142 个；工作区 1.9 MB；`.git` 798 KB |
| 换行 | `.gitattributes`：`* text=auto eol=lf`，`*.cmd/*.bat eol=crlf` |

提交内容 = 规范/文档（`docs/00–15` + 索引）、工具链（`tools/upp.mjs`、`tools/verify-in-app.mjs`）、测试（`tests/` 6 个测试 + fixtures）、示例（`examples/hello-upp`、`hello-upp-ui`、`doc-toolkit`、`sheet-toolkit`、`log-toolkit`）、CI 与脚本。

> 安装态说明：本机三端**只保留三个生产力插件**（doc/sheet/log-toolkit）；`hello-upp`、`hello-upp-ui` 是仓库内的框架示例，已从三端卸载（Accio `custom.json`、WB `upp-local` 市场、DSH profile 均无残留）。

## 2. 清理口径（不进入版本库）

| 路径 | 原因 |
|---|---|
| `imports/`（62 MB） | 分析器对真实第三方插件的导入产物，可随时重跑 |
| `*.log.json` | 历史 install/verify/conformance 输出，非契约 |
| `*.upp-bak-orig` | 安装器首次写入前的备份 |
| `tests/.tmp-*`、`tests/.runall-report.json` | 测试临时目录/报告 |
| `examples/*/cordis.patch.yml`、`examples/*/.upp-accio-mcp.json`、`examples/*/dist/` | `build` 生成且含本机绝对路径，由 `upp.json + *.tpl` 重建 |
| `dist/` | 发布产物，由 `pack`/`bundle-offline` 重建 |

> 文档（03/04/05/09）中保留的 `H:\...` 绝对路径是**实测证据**，不参与构建，不影响移植。

## 3. `upp doctor` 健康结果

```bash
node tools/upp.mjs doctor
```

| 检查项 | 结果 | 说明 |
|---|---|---|
| `node` | ✅ v26.12.0 | 运行时 ≥ 18 即可 |
| `cli.shim` | ✅ `~/.upp/bin/upp.cmd` | 全局 `upp` 已安装（`node tools/upp.mjs setup-cli`） |
| `cli.version` | ✅ `1.5.1` | 已安装工具链与仓库 `tools/upp.mjs` 同版本；落后时 `upp self-update` |
| `dsh.profile` | ✅ `C:\Users\Administrator\.dsh\profiles\desktop` | profile 可写、可登记 bundle |
| `workbuddy.home` | ✅ `~/.workbuddy/skills` | 技能根存在 |
| `accio.account` | ✅ `~/.accio/accounts/1797968970/skills` | 账号技能根存在 |
| `workbuddy.cli.mcp` | ✅ `doc-toolkit / sheet-toolkit / log-toolkit … ✓ Connected` | 三个插件都能被底座 CLI 拉起 |
| `accio.gateway` | ✅ `127.0.0.1:4097 open` | Gateway 可连（Accio 运行时） |
| `accio.cli.mcp` | ✅ `MCP Servers (5)` | Accio 端 `server list` 可读；UPP 三个插件已注册 |

结论：上表 9 项在**当前机器（宿主在运行、全局 CLI 已装、三个 UPP 插件已安装）**全部通过；宿主未启动时 `workbuddy.cli.mcp` / `accio.gateway` / `accio.cli.mcp` 会显示预期失败。doctor 是只读检查，不修改任何宿主配置。

## 4. 复现矩阵（发布前必跑）

```bash
node tools/upp.mjs validate --pkg examples/hello-upp        # 42 checks
node tools/upp.mjs build --pkg examples/hello-upp --check   # 零漂移
node tests/run-all.mjs                                      # 17 步全绿
node tools/upp.mjs conformance --pkg examples/hello-upp --hosts dsh,workbuddy,accio   # 70 checks
node tools/upp.mjs verify --pkg examples/hello-upp          # 28 checks（可加 --hosts dsh 只看单端）
node tools/upp.mjs pack --pkg examples/hello-upp --out dist/hello-upp-1.0.0.upp
```

最近一次结果：`run-all 17/17`、`conformance 70 passed / 0 failed`、`verify 28 / 0 failed`。

全局 CLI：`node tools/upp.mjs setup-cli` → `~/.upp/bin/upp.cmd`（Windows 用户 PATH 已追加）；新终端里 `upp detect` 可直接跑，`upp install --from <x.upp> --hosts ...` 即"一条命令安装"。

工具链升级：`upp self-update`（默认取仓库 `tools/upp.mjs`；也可 `--from <upp.mjs|dir>`，`--force` 允许同版本重装/降级，自动备份 `.bak-<ts>` 并重建 shim；`upp --version` 查看版本）。

## 5. 发布产物

| 产物 | 大小 | 说明 |
|---|---|---|
| `dist/doc-toolkit-0.2.0.upp` | 15,201 B | 签名包（ed25519 指纹 `0f012f6363b1eb1b`），含 PDF/PPTX |
| `dist/sheet-toolkit-0.1.0.upp` | 14,069 B | 签名包，xlsx/csv 概览/清洗/汇总 |
| `dist/log-toolkit-0.1.0.upp` | 11,690 B | 签名包，日志扫描/grep/窗口 |
| `dist/hello-upp-1.0.0.upp` | 14,885 B | 框架示例包（三端同包） |
| `dist/hello-upp-1.0.0.upp.sha256` | 86 B | `<hash>  <file>` |
| `dist/hello-upp-1.0.0.upp.sig.json` | 485 B | ed25519，指纹 `91bc497df70128c8` |
| `dist/offline-hello-upp-1.0.0.zip` | 48,205 B | 含 `tools/upp.mjs`、`install.cmd/sh`、哈希/签名 |

## 6. 非阻塞遗留

- `docs/` 为中文实机报告，含本机路径与宿主版本号（证据用途，非产品文档）；
- 示例目录内的生成物不提交，首次 `install` 前需 `build`（README 已写明）；
- `.github/workflows/ci.yml` 已提交，但尚未在远端跑过（无远端仓库）。
