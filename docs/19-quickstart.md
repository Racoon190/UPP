# 19 · 新手快速开始（换一台电脑从零到三端可用）

> 目标读者：**没有读过前面 18 篇文档的人**。按本文顺序做完，你在任何一台 Windows / macOS / Linux 电脑上都会得到：
> 一条命令管理 **三端插件 / 技能 / MCP / 工具 / 记忆** 的能力，并且能**从任意一端造出一个三端通用的新插件**。

---

## 1. 先搞清楚它是什么（30 秒）

| 问题 | 答案 |
|---|---|
| 它是不是一个插件？ | **不是。** 插件是它打包、安装、迁移的**对象**，不是它本身。 |
| 它是不是一个技能（skill）？ | **不是。** 技能是它搬运的五类资产之一。DSH 里那个叫 `upp-memory` 的技能只是「记忆共享」在 DSH 侧的落地点。 |
| 它是不是软件？ | **是。** 它是一套**零依赖的 Node 命令行软件（toolchain）**，外加一份**插件协议规范**（UPP）。 |
| 具体有哪几样？ | `upp`（协议 + 插件打包/安装/校验/签名）、`uppenv`（整机环境镜像，Docker 式导出导入）、`upptool`（把重复劳动固化成可本地直跑的工具）、`uppmem`（三端共享记忆池）。后三个都挂在 `upp` 下面：`upp env` / `upp tool` / `upp mem`。 |

一句话：**你装的是一条命令和一份协议；它管的是三端的插件、技能、MCP、工具和记忆。**

---

## 2. 前置条件

1. **Node.js 20 LTS 或更新**（唯一硬依赖，零 npm 依赖、零网络安装）。检查：`node -v`
2. 三端软件按需安装（装哪端就能管哪端，不装不影响其他端）：
   - DeepSeek Harness（DSH）
   - WorkBuddy
   - Accio Work
3. 把这套仓库放到本机任意目录（`git clone` 或直接复制文件夹都行）。

---

## 3. 第一次部署（4 步，约 1 分钟）

```bash
# 0) 进入仓库目录
cd <你放 upp 的目录>
```

**Windows：双击 `install.cmd`**（或在 cmd 里执行它）；**macOS / Linux：**

```bash
sh install.sh
```

它做三件事：检查 Node 版本 → 安装全局命令 `upp`（连同 `upp env|tool|mem` 子工具链）→ 跑一遍 `upp doctor` 自检。

等价的手动命令：

```bash
node tools/upp.mjs setup-cli     # 安装全局命令（~/.upp/bin，自动加 PATH）
node tools/upp.mjs doctor        # 自检
```

预期 `doctor` 里这些是 OK：

```
OK  cli.shim   C:\Users\<你>\.upp\bin\upp.cmd
OK  cli.version 1.4.0
OK  cli.env    uppenv 1.1.0 (schema 1)
OK  cli.tool   upptool 1.0.0 (schema upptool/1)
OK  cli.mem    uppmem 1.0.0 (schema uppmem/1)
OK  dsh.profile / workbuddy.home / accio.account   （装了的端才有）
```

**开一个新终端**（PATH 需要重新加载），验证：

```bash
upp --version            # 打印 toolchain 版本
upp mem stats            # 记忆池统计
upp env version          # 环境镜像工具版本
```

> 三大坑：
> - 报 `unknown command: mem` → 全局命令还是旧版，重新执行 `node tools/upp.mjs setup-cli`。
> - 报 `'upp' 不是内部或外部命令` → 没开新终端，或 PATH 没生效（重开终端 / 重启一次）。
> - 任一端 `doctor` 显示 FAIL 不影响其他端，按提示补装对应软件即可。

---

## 4. 装好之后立刻能做的三件事

### 4.1 三端共享记忆（`uppmem`）

```bash
upp mem add "我的偏好：用中文回答" --kind preference --key user.language
upp mem add "本机仓库在 D:/code/upp" --kind project --key project.repo
upp mem sync --host dsh,workbuddy,accio --both     # 双向同步到三端
upp mem search 中文                                 # 随时检索
```

- 权威存储：`~/.uppmem/pool/`；给模型读的快照：`~/.uppmem/MEMORY.md`
- 三端落点：DSH 自动生成 `upp-memory` 技能；WorkBuddy / Accio 在各自记忆文件里追加一个托管区（原生内容一字不动）
- 支持 MCP 的客户端可以直接挂：`node <仓库>/tools/uppmem.mjs mcp`
- 一条命令替你写进宿主配置（只加 `uppmem` 这一条，其它 server 不动）：
  `upp mem install --host workbuddy` / `upp mem install --host accio`
  （加 `--remove` 反注册，加 `--dry-run` 只看计划；装完重启宿主进程生效）
- 先看效果不写入：`upp mem sync --host dsh,workbuddy,accio --both --dry-run`

### 4.2 重复劳动固化成工具（`upptool`）

```bash
upp tool add ./scripts/rename_files.mjs --name rename-files --tags fs,batch
upp tool list
upp tool run rename-files -- <参数>
upp tool suggest "批量重命名文件"        # 下次先问有没有现成的
upp tool stats                            # 省下的 token/时间估算
```

跑一次就登记一次运行记录；同名同内容自动判重，不会把已有工具覆盖掉。

### 4.3 换机迁移（`uppenv`）

```bash
# 旧机器
upp env export -o env.uppenv --sign            # 打包插件/技能/MCP/工具/记忆
# 新机器（装好 Node 后）
upp env import env.uppenv --dry-run            # 先看计划
upp env import env.uppenv                      # 真导入（有事务，可回滚）
upp env rollback --last                        # 后悔药
```

镜像可以签名验签，`--require-signature` 会拒绝来源不明的镜像。

### 4.4 图形界面（`uppgui`，不想敲命令就用它）

装完 exe 以后，桌面会有 **UPP GUI**；不想装 exe 也可以直接起本地网页：

```bash
node tools/uppgui.mjs          # 打开 http://127.0.0.1:<随机端口>/?token=...
node tools/uppgui.mjs selftest # 第一次用先自检，全绿再往下
```

界面左侧 6 个工作区——概览 / 记忆 / 工具 / 环境镜像 / 插件 / Agent——每个按钮下面都写着**等价的 CLI 与 MCP 调用**，所以学会了界面就等于学会了命令。写入类操作（删除记忆、导入镜像、打包装插件）会先要求确认，且都可以先 dry-run。

同一个界面还能被 agent 直接操作：启动 `uppgui.exe --mcp`（或 `node tools/uppgui.mjs mcp`）挂进任意 MCP 客户端，agent 只需两个工具 `upp_action` / `upp_catalog` 就能控制全部 31 个动作，工具描述总大小 1274 字节，调用默认返回精简结果——这是它省 token 的关键。

---

## 5. 从任意一端造一个「三端通用新插件」

UPP 插件的真相：**一个目录 = 一份 `upp.json` 源 + 技能 + MCP runtime**，三端清单由 `upp build` 自动生成。

```bash
# ① 脚手架（三端清单、技能、MCP server、示例工具都生成好）
upp init my-plugin
cd my-plugin

# ② 只改这 3 个地方
#    upp.json                -> name / description / version
#    skills/my-plugin/SKILL.md  -> 模型看到的用法说明
#    runtime/server.mjs       -> 你的 MCP 工具实现（tools.json 里登记）

# ③ 自查（离线，不碰宿主）
upp validate --pkg .            # 规范检查，示例：36 checks / 0 failed
upp verify   --pkg .            # 离线规范 + MCP 冒烟（initialize/tools/list/call/CLI 对齐）
upp conformance --pkg .         # 三端一致性，示例：45 passed / 0 failed

# ④ 打包（可签名）
upp pack --pkg . --sign         # 产物 dist/my-plugin-1.0.0.upp (+.sha256/.sig.json)

# ⑤ 装到三端
upp install --pkg . --hosts dsh,workbuddy,accio

# ⑥ 验收 / 卸载
upp verify --pkg .              # 安装后会自动做三端检查
upp uninstall --pkg .           # 精确回滚（记录在 .upp-install.json）
```

每一端怎么看到它：

| 端 | 落地形态 | 验证方式 |
|---|---|---|
| DSH | profile 注册 + 技能镜像到 `~/.dsh/skills/<id>` | 重启 DSH，技能目录出现 `<id>` |
| WorkBuddy | `skills/<id>` + `~/.codebuddy/mcp.json` 一条 server | `workbuddy mcp list` |
| Accio | 技能目录 + 账号级 `mcp-servers/custom.json` | Accio 里 `server list` 看到 `connected` |

> 你的插件里只要写了技能 + MCP 工具，**三端能力是同一份代码**：DSH 走技能+CLI，WorkBuddy/Accio 走 MCP。不需要为三端写三套。

---

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `unknown command: mem` | 全局命令是旧版：`node tools/upp.mjs setup-cli`（会同时装 `upp env/tool/mem` 子工具链） |
| `upp` 找不到 | 开新终端；或在 PowerShell 里把 `~/.upp/bin` 加进 PATH |
| `upp doctor` 的 `accio.gateway` FAIL | Accio 没启动，先在 Accio 里打开它再安装/注册 |
| `verify` 报 `missing .../SKILL.md (run install --hosts dsh)` | 还没安装。先 `upp install --pkg . --hosts dsh`，再 `upp verify --pkg .` |
| 想卸载重来 | `upp uninstall --pkg <包> --hosts dsh,workbuddy,accio` |
| 想升级仓库里的 CLI | `cd <仓库> && git pull && upp self-update --force`（或重跑 `install.cmd`） |
| 记忆同步怕写坏宿主记忆 | 先 `--dry-run`；`sync` 本身带事务，失败可 `upp mem` 的事务日志回滚 |

---

## 7. 文件地图（装完之后东西都在哪）

| 路径 | 内容 |
|---|---|
| `~/.upp/bin/` | 全局 `upp` 命令 + `tools/` 子工具链 + `lib/` |
| `~/.upp/store/` | UPP 插件缓存（`upp install` 用的） |
| `~/.upp/keys/` | 签名密钥（`upp keygen` 生成） |
| `~/.uppmem/` | 共享记忆池（`pool/entries/<id>.json`、`MEMORY.md`、`index.json`、`tx/`） |
| `~/.upptool/` | 工具注册表（`index.json`、`tools/<slug>/`、`runs.jsonl`） |
| `~/.uppenv/` | 环境镜像的导入事务与回滚记录 |

---

## 8. 边界（先说清楚，避免误会）

- 不承诺：宿主原生 UI 插槽、可拦截 hooks、RPA、LSP 深度集成（UPP P2 范围外）。
- `upp install` 只做**协议内**的事：技能目录、MCP 配置、profile 注册；不会去改宿主二进制或界面。
- `uppmem` 对 WorkBuddy/Accio 的记忆文件**只动托管区**（`<!-- uppmem:begin --> ... <!-- uppmem:end -->`），宿主自己的内容一个字节都不改。
- 旧版 WorkBuddy / Accio 若改了记忆文件格式，`sync` 会给出 warning 而不是猜着写。

---

继续读：[06-toolchain.md](06-toolchain.md)（命令全集）、[16-uppenv.md](16-uppenv.md)（环境镜像）、[17-upptool.md](17-upptool.md)、[18-uppmem.md](18-uppmem.md)、[14-delivery-guide.md](14-delivery-guide.md)（交付/FAQ）。
