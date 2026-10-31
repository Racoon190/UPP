# 03 · DeepSeek Harness 宿主适配（`dsh`）

> 本文是三份宿主文档之一。术语（UPP / 宿主 / 通道 / 适配器 / 契约等级 / 超集目录 / serverName）与契约定义以 [01-spec.md](01-spec.md) 为准，实机证据见 [09-poc-report.md](09-poc-report.md)，调研原文见 [dsh-surface.md](../../research/dsh-surface.md)。
> 证据标记：**【已证实】**＝本机实测或源码原文；**【推测】**＝合理外推；**待验证**＝本轮 PoC 未覆盖，见 §8。

---

## 1. 宿主概览

| 项 | 值 | 证据 |
| --- | --- | --- |
| 产品形态 | Windows 桌面客户端（同进程内 Serve Web GUI，本会话 `http://127.0.0.1:49612`） | 【已证实】 |
| 运行时包 | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.3**（`D:/DeepSeek Harness/resources/app.asar` 内 `/dsh/package.json`） | 【已证实】 |
| Electron | 安装根 `D:/DeepSeek Harness/version` = `44.7.0`（Electron 版本标记） | 【已证实·文件值】 |
| 内置 Node / pnpm | `D:/DeepSeek Harness/resources/runtime/versions.json`：`node 24.21.0`、`pnpm 11.28.5` | 【已证实】 |
| CLI | `D:/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`（无独立 `node.exe`，运行时在 `resources/runtime/primary-runtime/`） | 【已证实】 |
| 用户数据根 | `C:\Users\Administrator\.dsh`（`DSH_HOME`）；profile 根 `…\.dsh\profiles\desktop` | 【已证实】 |
| 插件体系（底座） | **Cordis Loader + bundle**：`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml` 插入 Loader 行；`index.js` 导出 `apply(ctx, config)`（Host 能力），`client.js` 注册 UI 插槽 | 【已证实】 |
| 插件体系（用户向） | 设置页「插件」页 / `plugin_manager` 工具（安装、启停、卸载、版本豁免）；无第三方市场入口 | 【已证实】 |
| 纯配置插件 | 只有 `cordis.patch.yml` + 可选 locale/icon，**没有 `index.js`**；UPP 走的就是这条 | 【已证实】 |
| 技能体系 | 磁盘 `SKILL.md` + YAML frontmatter（`name`/`description` 必填），6 级根、优先级 100–600；插件可随包分发 `skills/` | 【已证实】 |
| MCP | 内置插件 `@deepseek-ai/dsh-mcp-client` 的一行配置；`transport: stdio \| streamable-http`；工具名 `mcp__<serverName>__<tool>` | 【已证实】 |
| 对 UPP 的意义 | P0 通道可用（MCP 工具 + 技能），且**新增 bundle 可热加载**，是本轮最强宿主 | 【已证实】 |

---

## 2. 原生安装点（精确路径表）

| 安装点 | 精确路径 | 作用 |
| --- | --- | --- |
| bundle 清单 | `<pkg>/package.json` | 含 `dsh.bundle.patch` 即被识别为 bundle |
| 组合 patch | `<pkg>/cordis.patch.yml` | Loader YAML：`insert` 一行 `@deepseek-ai/dsh-mcp-client` |
| 包安装落点 | `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\<pkgName>`（扁平，`nodeLinker: hoisted`） | 真实代码位置 |
| 已装声明 | `…\profiles\desktop\package.json` 的 `dependencies` + **有序数组** `dsh.profile.bundles` | 供启动器装配 profile 层 |
| 锁文件 | `…\profiles\desktop\pnpm-lock.yaml`、`pnpm-workspace.yaml` | 依赖可复现 |
| 用户覆盖层 | `…\profiles\desktop\cordis.patch.yml` | 按 `id` 覆盖行，**跨客户端升级保留** |
| 技能目录（6 级根） | 100 `<project>/.dsh/skills`；200 `<project>/.agents/skills`；300 `Config.customSkillDirs`；400 `<dshHome>/skills`；500 `<agentsHome>/skills`；600 内置 bundled | `SKILL.md` 发现（不扫嵌套） |
| MCP 配置 | 无独立文件：就是 patch 里 `name: '@deepseek-ai/dsh-mcp-client'` 那一行的 `config` | `serverName/transport/command/args/env/cwd/url/headers/toolCallTimeoutMs/failOnStartupError/reconnect` |
| 操作日志 | `…\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log`；并发记录 `.plugin-manager\run.json` | 排障 |
| 安装器自身备份 | 安装器写过的每个文件旁 `<file>.upp-bak-orig`（一次性）；安装记录 `<pkg>/.upp-install.json` | 人工回滚点 |

**生效机制**

- **新增** bundle：`plugin_manager install_bundle` 成功后经 HMR **无需重启**即生效（PoC 中会话工具表立刻出现 `mcp__upp-hello__hello`）。【已证实】
- **替换/升级**已安装包：需要重启以加载新 JS 模块代；返回 `restart-required` 表示未生效。【已证实】
- 兼容性预检失败 → 自动恢复 `package.json` + `pnpm-lock.yaml`，用 `--frozen-lockfile` 重装，报 `dsh: installation rejected: …`，且被拒包**不会 import**。【已证实】
- 技能目录是热监听的：新增/改名/删除无需重启。【已证实】

---

## 3. UPP → DSH 映射

| UPP 产物 | 生成方式 | 落位 | 说明 |
| --- | --- | --- | --- |
| `package.json` | 仓库内**手写/模板**（`upp build` 只读它的 `name` 作为 `hosts.dsh.packageName`） | 包根 | 必须含 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`、`"type":"module"`、`"private":true` |
| `cordis.patch.yml` | `upp build` 从 `cordis.patch.yml.tpl` 渲染：替换 `serverName` 与 `runtime/server.mjs` **绝对路径** | 包根 | 生成物不得残留 `__UPP_*__` 占位符（`upp verify` 有专项检查） |
| `runtime/tools.json` | `upp build` 由 `upp.json.tools` 派生 | `runtime/` | 运行时工具模式，勿手改 |
| `skills/<id>/SKILL.md` | 原样 | 包内 `skills/` | 随 bundle 分发；DSH 侧是否自动收录见 §8 待验证 |
| `.claude-plugin/`、`.mcp.json`、`clis/` | 原样随包 | 包内 | DSH **不读**，仅为超集目录共存，忽略即前向兼容 |
| `ui` 面板技能（P1.4） | `upp build` 生成 `skills/<plugin>-panel/`（含 `renderers:` frontmatter 与单文件 HTML）；安装器镜像到 `~/.dsh/skills/<plugin>-panel/` | `~/.dsh/skills/` | DSH 当普通技能收录（实测技能目录可见），**不渲染 Accio 面板**；DSH 原生面板另见 `ui.dsh`（生成 `index.js`+`client.js`，需重启加载） |
| `hooks`（P2 试点） | 不生成 DSH 形态 | — | DSH 侧无对应扩展点，UPP 只对 WorkBuddy 生成 observe 钩子 |

**最小可安装产物**（P0 工具通道即可跑）

```
hello-upp/                    # 配置型 MCP bundle，无 index.js
├── package.json              # name/version/private/type/files + dsh.bundle.patch
├── cordis.patch.yml          # insert 一行 @deepseek-ai/dsh-mcp-client
└── runtime/
    ├── server.mjs            # MCP stdio（换行分隔 JSON-RPC）+ CLI 双模
    └── tools.json            # tools/list 的权威 schema
```

**完整产物**：上述 + `skills/<id>/SKILL.md`（技能层）+ `upp.json` + `locale/*.json`、`icon.*`（可选展示）+ 其它两端清单（`.claude-plugin/plugin.json`、`.mcp.json`、`clis/clis.json`）。

**关键字段映射**

| `upp.json` | DSH 产物字段 | 约束 |
| --- | --- | --- |
| `hosts.dsh.serverName` | patch 行 `config.serverName` | `^[A-Za-z0-9_-]{1,32}$`，最严约束，三端复用 |
| `runtime.entry` | patch 行 `config.args[0]`（绝对路径） | 不改写为相对路径；`file`/`link` 安装不适用相对解析 |
| `version` / `id` | `package.json.version` / 包目录名 | 包名建议 `@upp/<id>` 或 `@local/<id>` |
| `capabilities.tools` | patch 行存在 | 无工具也合法（空 MCP） |
| `capabilities.skills` | 包内 `skills/` | 需宿主侧确认（§8） |
| `permissions` | 不写宿主配置 | DSH 无对应声明位，靠 `env` 与工具实现自律 |

生成的 patch（本机 PoC 真值，行号 1–18）：

```yaml
- insert:
    - id: upp-hello-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: upp-hello
        transport: stdio
        command: node
        args: ['H:/Administrator/Documents/deepseek-harness/default-workspace/upp/examples/hello-upp/runtime/server.mjs']
        env:
          UPP_HOST: dsh
        failOnStartupError: false
        toolCallTimeoutMs: 60000
```

---

## 4. 安装流程

`node tools/upp.mjs install --pkg <pkg> --hosts dsh`（`--hosts` 省略时为 `dsh,workbuddy,accio`）对 DSH 只做**两件不碰宿主的事**：

1. 校验包内 `cordis.patch.yml` 已生成（缺失直接报 `run build first`，先跑 `node tools/upp.mjs build --pkg <pkg>`）；
2. 把 bundle 路径、包名、patch 路径、入口绝对路径写入 `<pkg>/.upp-install.json` 的 `hosts.dsh`，并输出下一步命令。

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs build   --pkg examples/hello-upp
node tools/upp.mjs install --pkg examples/hello-upp --hosts dsh
# 期望输出含：next: plugin_manager({action:"install_bundle", target:"H:\\…\\examples\\hello-upp"})
```

**必须宿主侧执行的一步**（DSH 没有可外部调用的安装 CLI，只有插件管理器 API）：

```js
// 本会话内的 plugin_manager 工具调用（target 必须是绝对路径；本地目录记为 link:）
plugin_manager({ action: "install_bundle", target: "H:/Administrator/Documents/deepseek-harness/default-workspace/upp/examples/hello-upp" })
// 返回 application: applied | restart-required | failed | overridden
```

参数要点【已证实】：

| 参数/行为 | 语义 |
| --- | --- |
| `target`（本地路径） | 必须**绝对路径**；`file:`/`link:` 前缀会被剥离，`link:` 记录为 `link:<abs>` |
| 写 `dsh.profile.bundles` | 仅当依赖包含 `dsh.bundle`；否则只装成普通依赖并警告 |
| `approvedBuilds` | 只在该 profile 弹出 `pendingBuilds` 且用户明确批准后传；UPP 包无构建脚本，正常不会触发 |
| 返回 `overridden` | 更高优先级层（如用户 patch）已覆盖，不算失败 |
| 返回 `restart-required` | 未生效，需重启宿主 |

> 禁止手工改 profile 文件或在 profile 里手跑 pnpm；安装语义由插件管理器独占（DSH 官方插件技能明确约束）。【已证实】

---

## 5. 验证方法

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp

# 1) 安装器视角（不依赖宿主运行态）
node tools/upp.mjs verify  --pkg examples/hello-upp   # 28 项全绿 = failed: 0
node tools/upp.mjs doctor                             # 宿主探测 + WorkBuddy CLI 健康检查

# 2) 纯协议层（与宿主无关，确认 server.mjs 本身正确）
node tests/mcp-smoke.mjs examples/hello-upp           # MCP smoke 7/7（含 CLI parity）
```

**会话工具表**（最强证据，安装后由模型侧直接看到）：

- 工具名 `mcp__upp-hello__hello`（`mcp__<serverName>__<tool>`，与 [01-spec.md](01-spec.md) §7 一致）；
- 调用 `mcp__upp-hello__hello({"name":"DSH-PoC"})` → 返回单 JSON 文本块，`ok: true` 且 `host` 字段为 `dsh`（安装器已注入 `env.UPP_HOST=dsh`）。

`upp verify` 对 DSH 的 6 项断言：`dsh.dependency`（profile `dependencies` 有记录）、`dsh.bundles`（`dsh.profile.bundles` 含包名）、`dsh.bundle.patch`（`node_modules/<pkg>/cordis.patch.yml` 含 mcp-client 行与 serverName）、`dsh.patch.entry`（无 `__UPP_` 残留）、`dsh.live.entry`（patch 中入口绝对路径存在）、`dsh.node_modules`（包目录存在）。全部只读，不修改 profile。

---

## 6. 降级与限制

| 能力 | UPP 用法 | 契约等级 | 用户会看到什么 |
| --- | --- | --- | --- |
| MCP 工具 | patch 一行 stdio | **P0** | 会话工具表出现 `mcp__upp-hello__hello`，带 schema |
| 技能 | 包内 `skills/<id>/SKILL.md` | **P0** | 技能可被路由（DSH 侧收录机制见 §8） |
| CLI 兜底 | `node <pkg>/runtime/server.mjs --cli …` | **P0** | 技能降级步骤里可直接执行 |
| 提示词/命令 | 需 `index.js` + `systemPrompt.section()` / `commands.register` | P1 → 以**技能镜像**落地：`<id>-prompt-<pid>` 写入 `~/.dsh/skills`，模型可见（见 11） | 无；UPP v1 不生成 Host 半代码 |
| 子代理 | 需插件注册 agent preset | P1 → 以**技能镜像**落地：`<id>-agent-<aid>`（见 11） | 无 |
| UI 插槽 / 事件 hooks / LSP / RPA | Client Slot（103 条 CLIENT_SLOT_API）、`tools/pre-execute` 等 waterfall | **P1.4 已可生成 / 其余 P2** | `ui.dsh` 生成 client bundle（静态验证，安装后需重启）；hooks/LSP/RPA 仍不做 |
| 权限声明 | `permissions` 无落点 | P1 文档级 | 无 UI 提示，靠运行时自律 |
| 安装动作 | 不能在装配器里完成 | P0 但需宿主侧 | 用户/代理需执行一次 `plugin_manager` 调用 |

**结论**：DSH 上 UPP 是"纯配置插件"，零代码接入；代价是 P1/P2 能力全部缺失，且安装的最后一步不可脚本化（只有 `plugin_manager` 工具或 GUI 插件页）。

---

## 7. 卸载与升级

```bash
cd H:/Administrator/Documents/deepseek-harness/default-workspace/upp
node tools/upp.mjs uninstall --pkg examples/hello-upp
# 输出会明确提示：DSH 侧需 plugin_manager({action:"remove_bundle", …}) 或改 profile；
# 文件级回退不安全（安装器不会替你删 node_modules 条目）
```

**卸载删除/保留**

| 项 | 处理 |
| --- | --- |
| 技能目录 | 由 bundle 自带，随 bundle 卸载消失；若曾复制到 `~/.dsh/skills` 需手工删 |
| profile `dependencies` / `dsh.profile.bundles` 条目 | 由 `remove_bundle` 移除；不手改 |
| `node_modules/<pkg>` | 由插件管理器回收 |
| `<pkg>/.upp-install.json`、`.upp-*.json`、`*.upp-bak-orig` | 安装器工件，可保留；`upp pack` 自动排除 |
| `UPP_DATA`（`<hostData>/upp-data/<id>/`） | **保留**（除非 `--purge`，v1 未实现） |

**升级幂等**：`upp build` 可重复执行（覆盖生成物，首次写前留 `.upp-bak-orig`）；`install` 只刷新记录；真正的替换由 `plugin_manager` 重装同一 `target` 完成（版本变化需重启）。`verify` 幂等且只读，可反复跑。

---

## 8. 已知风险与待验证项

| # | 项 | 状态 | 说明 / 验证方法 |
| --- | --- | --- | --- |
| 1 | 技能如何被 DSH 收录 | **✅ 已验证** | bundle 内的 `skills/` 不会被技能扫描根直接收录；安装器把技能镜像到 `~/.dsh/skills/<id>/` 后，本会话技能目录立即出现 `hello-upp`（`upp install --hosts dsh` 新增 `dsh.skill` 检查） |
| 2 | 替换已装 bundle 的完整热更新边界 | 待验证 | 只证实"新增 bundle 热加载"；升级后需重启【已证实】，HMR 是否部分生效未测 |
| 3 | `link:` 安装指向源目录 | **风险（已知待修）** | PoC 问题 #3：删源即坏；分发前应 `upp pack` 后从稳定 store 目录安装 |
| 4 | `dsh.cmd` 是否有 `plugin list` 类只读校验命令 | 待验证 | 未在 PoC 使用；当前以 `upp verify` + 会话工具表为准 |
| 5 | `engines.dsh` 与本机 `0.2.1-rc.3` 的匹配策略 | 待验证 | 包未声明 `engines.dsh`；应补 `"engines": {"dsh": ">=0.2.0"}` 并实测被拒/放行行为 |
| 6 | `host` 字段曾为 `unknown` | 已修 | 适配器注入 `env.UPP_HOST=dsh`，运行时读取后写回结果 |
| 7 | 用户 patch 层与 UPP 行的 id 冲突 | 待验证 | bundle 行 `id` 固定 `upp-hello-mcp`；与用户覆盖层同名时以用户层优先（`overridden`） |

---

**相关文档**：[01-spec.md](01-spec.md) · [04-host-workbuddy.md](04-host-workbuddy.md) · [05-host-accio.md](05-host-accio.md) · [09-poc-report.md](09-poc-report.md)
