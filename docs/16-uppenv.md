# 16 · uppenv：环境镜像（Docker 式三端 export / import）

> 一句话：`upp` 把**一个插件**装到三端；`uppenv` 把**一台机器的 agent 环境**（插件 / 技能 / MCP / 工具清单 / 记忆）打成一个文件，在另一台机器上一条命令装回去，可预演、可回滚。

- 状态：**v1 已实现并真机跑通**（2026-11-01，Windows 11，Node v26.12.0）；v1.1 增加 ed25519 签名与 `upp env` 子命令
- 入口：`upp/tools/uppenv.mjs`（零依赖单文件 CLI）+ `upp/lib/uppenv/`（核心与三端适配器）
- 镜像格式：`.uppenv` = 标准 ZIP（任何解压工具可查看，`manifest.json` + `payload/`）
- 自测：`node tools/test-uppenv.mjs`（50 项）+ `node tools/test-roundtrip.mjs`（30 项，含真实导出→签名→导入→回滚→三种冲突策略→篡改拒绝闭环）

---

## 1. 问题与形态取舍

`upp` 的语义是「一份插件，三端原生安装」。但一次真实的换机/交接还要回答另外三个问题：

1. 我装了**哪些**插件/技能/MCP？
2. 它们的**配置**（MCP 命令与参数、绝对路径、环境变量、记忆文件）怎么跟着走？
3. 目标机器上已经有一半时，如何**只补差的**、装错了如何**撤回**？

这就是 `uppenv` 的三件事：**快照（scan）→ 镜像（export）→ 归位（import + rollback）**。

**为什么不做成"容器运行时"**：宿主进程模型、权限、UI 插槽都不归我们管，真正的运行时隔离做不到也不该做（与 [00-overview.md](00-overview.md) §2 的结论一致）。所以取 Docker 的**形**（镜像文件 + build/export/import + 事务回滚），不取 Docker 的**实**（不托管进程、不隔离文件系统）。

**为什么是"一个文件 + 一条命令"而不是"再写一份文档"**：迁移的价值在**可复现**。文档会过期，镜像里的 sha256 不会。

---

## 2. 架构

```
upp/tools/uppenv.mjs           CLI：detect / scan / export / inspect / verify /
                               import / rollback / tx / tools / doctor
upp/lib/uppenv/
  image.mjs                    镜像构建、校验、物化（buildImage / verifyImage / materialize）
  core/
    model.mjs                  schema uppenv/1、kind/host/strategy 枚举、资产规范化
    util.mjs                   sha256、walk、treeDigest、copyTree、${TOKEN} 路径模板
    archive.mjs                零依赖 ZIP 读写（crc32 / writeZip / readZip）
    apply.mjs                  四种落盘原语：copy-tree / merge-json / write-file / append-text
    tx.mjs                     事务：journal.jsonl + backup/ + rollback
    mcp-tools.mjs              MCP stdio 探测（initialize → tools/list，分页）
  hosts/
    index.mjs                  适配器加载与上下文（roots + 模板）
    dsh.mjs                    DSH：profile deps / bundles / skills
    workbuddy.mjs              WorkBuddy：skills / 插件清单 / ~/.codebuddy/mcp.json / memory
    accio.mjs                  Accio：skills + skills_config / mcp-servers / global-memory
```

三个不变量：

- **适配器只描述"东西在哪、怎么装"**，不碰镜像格式；核心只描述"镜像长什么样"，不碰宿主细节。
- **宿主无关的产物可 diff**：每次 export/import 都算内容摘要（`treeDigest` / 文件 sha256），不是比 mtime。
- **任何写操作都进事务**：journal 可回放，`rollback` 能把目标机恢复到导入前。

### 2.1 资产模型（5 类）

| kind | 含义 | 典型 strategy |
|---|---|---|
| `plugin` | 宿主插件（DSH bundle/dep、WorkBuddy/Accio 插件） | `copy-tree` / `merge-json` / `exec` |
| `skill` | 技能目录（`SKILL.md` + 附件） | `copy-tree` |
| `mcp` | MCP server 配置条目 | `merge-json`（结构化合并，非文本替换） |
| `tool` | MCP server 的**工具面快照**（`tools/list`） | `write-file`（写入 uppenv 自己的 store） |
| `memory` | 记忆文件（WorkBuddy `_memory.md`、Accio `PROFILE.md`） | `copy-tree` / `write-file` |

`tool` 是这次新增的一类：它不改变宿主，而是把「这台机器上某 MCP server 暴露了哪些工具、参数 schema 长什么样」记下来；导入后可 `tools --live` 再探测一次做**漂移对比**（工具被删/改/加）。这让"工具"从"配置"里独立出来，迁移后能回答"环境是否等价"。

### 2.2 路径可移植

镜像里不写死绝对路径，文本与 JSON 字符串统一用模板：

```
${HOME}  ${DSH_HOME}  ${UPP_STORE}  ${WORKBUDDY_HOME}  ${CODEBUDDY_HOME}
${ACCIO_HOME}  ${WORKSPACE}
```

export 时按「最长根优先」把绝对路径替换成模板；import 时按**目标机**的根展开。实测：`~/.upp/store/doc-toolkit/0.2.0/runtime/server.mjs` → 导入到假 HOME 后变成 `<目标HOME>\.upp\store\doc-toolkit\0.2.0\runtime\server.mjs`。

> 注意：只对**绝对路径**做替换（相对字符串/裸命令名如 `node`、`local`、`https://…` 原样保留）。这条是踩过坑后写进代码的（见 §6）。

### 2.3 导入事务

```
--dry-run  只算计划（create/update/noop/skip），零写入
apply      per-asset 执行；所有写操作先 journal 再落盘
commit     写 result.json
rollback   按 journal 逆序撤销：uppenv 自己 create 的删掉，覆盖过的从 backup 恢复
```

`rollback` 的正确性比 `import` 更难写，见 §6。

---

## 3. 命令

```bash
# 这台机器上有哪些宿主（只读）
node tools/uppenv.mjs detect

# 能导出什么（只读）
node tools/uppenv.mjs scan --host dsh --kind plugin,skill,mcp

# 打镜像（默认五类全导；--no-probe-tools 跳过工具探测）
node tools/uppenv.mjs export -o env-full.uppenv --force

# 看内容 / 校验完整性
node tools/uppenv.mjs inspect env-full.uppenv
node tools/uppenv.mjs verify  env-full.uppenv

# 预演（零写入）→ 真装
node tools/uppenv.mjs import env-full.uppenv --dry-run
node tools/uppenv.mjs import env-full.uppenv --yes

# 回滚（--last 或指定 txid）
node tools/uppenv.mjs rollback --last
node tools/uppenv.mjs tx list

# 工具面清单与漂移
node tools/uppenv.mjs tools --host workbuddy
node tools/uppenv.mjs tools --host workbuddy --live

# 体检
node tools/uppenv.mjs doctor

# 签名 / 验签（ed25519，复用 UPP 密钥与 upp-sig/1 格式）
node tools/uppenv.mjs keygen                              # 首次：建密钥（或复用 upp keygen）
node tools/uppenv.mjs export -o env.uppenv --sign         # 导出即签名
node tools/uppenv.mjs verify-signature env.uppenv --require
node tools/uppenv.mjs import env.uppenv --require-signature --yes
node tools/upp.mjs verify-signature --from env.uppenv --require   # 用 upp 交叉验证同一份镜像

# 也可以从 upp 调用（子命令原样转发）
node tools/upp.mjs env export -o env.uppenv --sign
```

常用 flag：`--host a,b`、`--kind plugin,skill`、`--id <key>`、`--include-builtin`、`--vendor full`、`--on-conflict skip|overwrite|rename`、`--no-probe-tools`、`--probe-timeout 8000`、`--sign`、`--key <pem>`、`--pubkey <pem>`、`--require-signature`、`--json`。

### 3.1 签名与校验

镜像 = 单个 ZIP 文件，签名沿用 UPP 的**分离式 ed25519**：`<image>.sha256` + `<image>.sig.json`，签名字段为 `format: upp-sig/1`、`alg: ed25519`、`kind: uppenv-image`、文件哈希与签名本身。

- **密钥解析顺序**：`--key` → `UPPENV_SIGNING_KEY` → `UPP_SIGNING_KEY` → `~/.uppenv/keys/uppenv-signing.key.pem`（`uppenv keygen`）→ `~/.upp/keys/upp-signing.key.pem`（`upp keygen`）。所以已有 UPP 发布密钥时可直接签镜像，无需再建一套。
- **校验点**：`.sha256` 与文件一致、签名格式合法、签名文件名匹配、签名内哈希一致、ed25519 验签通过；`--pubkey` 额外钉住期望签名者指纹。
- **失败即拒绝**：`import` 前若镜像带签名（或显式 `--require-signature`），验签失败直接退出且**不写任何宿主文件**（实测篡改 1 字节 → `signature.verify: signature does not match`，目标 HOME 零写入）。
- **交叉验证**：因为格式与 UPP 包签名一致，`node tools/upp.mjs verify-signature --from env.uppenv --require` 也能验（实测 `signed: true, fingerprint 288161930ccc2e70`）。

---

## 4. 真机实测（2026-11-01，Windows 11 / Node v26.12.0）

### 4.1 环境识别

```
dsh        present  profile  C:\Users\Administrator\.dsh\profiles\desktop
workbuddy  present  4 skills · 55 plugins · 3 mcp
accio      present  10 skills · 13 plugins · 3 mcp
```

### 4.2 全量镜像

```
node tools/uppenv.mjs export -o ../uppenv-test/env-full.uppenv --force
→ 309.0 KB, 69 assets

kind     assets            明细
plugin   42                 dsh 15（含 @upp/* 3、@local/* 2、本地 link 1）+ workbuddy 14 + accio 13
skill    11                 dsh 3 + workbuddy 4 + accio 4
mcp      7                  workbuddy 3 + accio 4（含 1 个 remote）
memory   2                  workbuddy `_memory.md` + accio `global-memory/PROFILE.md`
tool     7                  workbuddy 3 + accio 4（MCP `tools/list` 快照）

verify → OK 69 asset(s) verified, all payload hashes match
```

### 4.3 导入预演（同一台机器，零写入）

```
import --dry-run  →  noop=30  update=7  skip=25  create=7
```

- `noop`：内容摘要一致，什么都不做（registry 插件按 `name@version` 比对）。
- `update`：DSH 的本地 link 插件与 `@upp/*` 包——计划把树复制进 `<profile>/.uppenv/vendor/<id>` 并重指 `package.json`；`cc-safety-net` 走 `exec` 重装。
- `create`：7 个工具面快照（写入 `~/.uppenv/tools/…`）。
- `skip`：25 个**明确不可导出/不应导入**的资产，理由写在计划里：
  - WorkBuddy：`host-managed plugin … installs it from marketplace "…"`（市场托管，由宿主自己装）
  - Accio：`only a manifest was exported`（远端插件树可重新下载，镜像只留清单）

> 这就是「dry-run 要能说人话」的意义：25 个 skip 不是失败，是**边界被显式声明**。

### 4.4 假 HOME 闭环（导出 → 导入 → 回滚）

`tools/test-fakehome.sh`（真实二进制，假 HOME）：

```
技能树        4 个技能目录 + 嵌套 reference/script 文件全部落盘
mcp.json      3 个 server，路径展开到 <假HOME>\.upp\store\…
tool 快照     3 个 JSON 写入 <假HOME>\.uppenv\tools\workbuddy\
rollback      rolled back …: restored 0, removed 8
回滚后        假 HOME 只剩 tx 元数据（journal/result/rolled-back）
```

`tools/test-roundtrip.mjs`（自包含、只用 `os.tmpdir()`）：源码宿主里放 1 个技能 + 1 个内联 MCP fixture server → 导出 → 导入到第二个空 HOME → 断言文件/路径/工具面 → 回滚断言全部消失 → **再导入并分别用三种冲突策略改写同一文件**。**27/27 通过**。

### 4.5 冲突策略（实机验证）

同一个已存在的技能文件，改过本地内容后分别导入三次：

| `--on-conflict` | 计划 | 结果 |
|---|---|---|
| `skip` | `skip=1` | 本地编辑保留，镜像不落盘 |
| `overwrite` | `update=1` | 本地编辑被镜像内容覆盖 |
| `rename` | 目标目录改名为 `doc-toolkit.uppenv-bak-2026-11-01T11-48-16` | 旧树（含本地编辑）完整保留，新树写入镜像内容 |

> `rename` 的语义是「把冲突目标整个挪开再装」，不是「合并」——所以旧内容永远可找回。三种策略都进同一个事务，`rollback --last` 撤销的是最后一次**成功**的导入。

---

## 5. 与 UPP 的关系

- `upp` = **插件级**打包/安装协议；`uppenv` = **环境级**快照/迁移工具。两者是「文件 vs 目录」「点 vs 面」的关系，不重复。
- `uppenv` 识别 `~/.upp/store`：托管在 store 的包标 `managedBy: upp`，导出时优先 vendored（保证离线可装）；`@upp/*` 依赖在 DSH 侧按 link 处理。实测本次全量镜像 69 个资产中 **24 个是 UPP 托管的**（DSH 3 个 `@upp/*` 插件、WorkBuddy 3 技能 + 3 插件、Accio 3 技能 + 3 MCP 等），`source:'upp'` 会写进 `asset.json` 与 `manifest.json`，可追溯。
- 建议组合用法：`upp build` 产出单插件包 → 装进 store → `uppenv export` 把「插件 + 配置 + 记忆 + 工具面」一起带走。
- 边界：`uppenv` 不做供应链治理（不锁依赖、不做市场校验）；签名是**同一套** ed25519/`upp-sig/1`，一份密钥签 `.upp` 与 `.uppenv`，任一方验签器都能验。

---

## 6. 调试记录（两个真 bug，值得写进文档）

**① 路径模板把普通字符串也改了。** 症状：MCP 条目里出现 `"type": "${WORKSPACE}/local"`。根因：`pathToTemplate()` 对相对字符串先 `path.resolve()`，落到了 cwd（workspace 根），于是 `local` 被当成 workspace 内路径。修复：非绝对路径直接 `return null`（`lib/uppenv/core/util.mjs`）。教训：**路径归一化函数只应接受绝对路径**。

**② 回滚会把新建文件留下。** 症状：假 HOME 导入后 `mcp.json` 是本次新建的，回滚后它还在。根因：`rollbackTx` 逆序扫 journal 时，第一个 MCP server 先 `create` 了 `mcp.json`，第二个 server 又对它 `backup`，逆序处理时 `backup` 抢在 `create` 前面恢复出"中间状态"。修复：**两遍算法**——正序记录每个 path 的**最早操作**（`earliest`）与首个备份槽；逆序按 path 撤销：`earliest === 'create'` 就整体删除（哪怕中途被备份过），否则恢复备份；rename 单独收集后逆序还原。教训：**事务回滚的判定单位是 path 的初始状态，不是最后一条日志**。

---

## 7. 已知边界（诚实清单）

| 边界 | 现状 | 后续 |
|---|---|---|
| registry 依赖 | 镜像只记 `name@version`，导入靠 `exec` 现场安装 | 需要离线时用 `--vendor full` |
| WorkBuddy 市场插件 | 不导出树，导入跳过 | 依赖宿主自身安装能力（本就由市场托管） |
| Accio 远端插件 | 只导 manifest | 同上，可从远端重下 |
| 工具面 | 只做「快照 + 漂移对比」，不做调用验证 | 可在 import 后按需 `--live` 探测 |
| 镜像签名 | 已支持（ed25519，`upp-sig/1`，与 `upp` 共用密钥/验签器） | 默认不强制；可加 `--require-signature` 策略 |
| 跨平台 | 只在 Windows 11 实测 | 路径模板已抽象，Linux/macOS 待验 |

---

## 8. 复现

```bash
cd upp
node tools/test-uppenv.mjs      # 50 项核心/适配器单测
node tools/test-roundtrip.mjs   # 30 项真实导出→签名→导入→回滚→冲突策略→篡改拒绝（只用临时目录）
node tools/uppenv.mjs detect
node tools/uppenv.mjs export -o ../uppenv-test/env-full.uppenv --force
node tools/uppenv.mjs verify  ../uppenv-test/env-full.uppenv
node tools/uppenv.mjs import  ../uppenv-test/env-full.uppenv --dry-run
```

假 HOME 版（不会碰真实宿主）：

```bash
bash tools/test-fakehome.sh
```

---

## 9. 一页速记

- **是什么**：`uppenv` = agent 环境的 `.uppenv` 镜像 + build/export/import/rollback。
- **五类资产**：plugin / skill / mcp / tool / memory；**三端**：DSH / WorkBuddy / Accio。
- **一条命令迁移**：`uppenv export -o env.uppenv` → `uppenv import env.uppenv --dry-run` → `--yes`。
- **安全网**：先 dry-run 看计划；写全进事务；`rollback --last` 一键撤回；假 HOME 自测不碰真机。
- **签名**：`export --sign` / `sign` / `verify-signature`，`import --require-signature` 才装；密钥与 `upp` 共用。
- **从 upp 调用**：`upp env <command>` 原样转发到 `tools/uppenv.mjs`。
- **与 UPP**：upp 管插件，uppenv 管环境；两者可组合，互不替代。
