# UPP 文档索引

> 先读 [00-overview.md](00-overview.md)；要动手写插件读 [01-spec.md](01-spec.md) + [06-toolchain.md](06-toolchain.md)；
> 排查"某端装不上"直接跳到对应宿主篇。

## 三条阅读路径

**决策者 / 评审**（30 分钟）
1. [00-overview.md](00-overview.md) —— 四层架构、三个原构想取舍、"100%"的严格定义
2. [09-poc-report.md](09-poc-report.md) —— 本机实测矩阵与证据
3. [10-roadmap.md](10-roadmap.md) —— 承诺边界、风险、验收门槛

**插件作者**（1 小时）
1. [01-spec.md](01-spec.md) —— `upp.json`、MCP/CLI 契约、技能层
2. [06-toolchain.md](06-toolchain.md) —— build/pack/install/verify/conformance
3. [02-channels.md](02-channels.md) —— MCP→CLI→技能如何降级、错误码

**宿主适配者**（按端选读）
- DSH：[03-host-dsh.md](03-host-dsh.md)
- WorkBuddy：[04-host-workbuddy.md](04-host-workbuddy.md)
- Accio Work：[05-host-accio.md](05-host-accio.md)

**使用者 / 交付负责人**（10 分钟）
1. [14-delivery-guide.md](14-delivery-guide.md) —— 三条安装路径、成本模型、边界、FAQ
2. [13-productivity-plugin.md](13-productivity-plugin.md) —— 一个真实插件的完整案例与量化收益

**换机 / 环境迁移**：[16-uppenv.md](16-uppenv.md) —— `uppenv` 环境镜像：五类资产一把导出、一条命令导入、可预演可回滚、可签名验签

**P1 规划**：[07-migration-and-analyzer.md](07-migration-and-analyzer.md)（迁移器/分析器）、[08-security-and-supply-chain.md](08-security-and-supply-chain.md)（签名、供应链、回滚）

## 全部文档

| 文档 | 一句话 |
|---|---|
| [00-overview.md](00-overview.md) | 问题、架构、取舍、实测结论、快速开始 |
| [01-spec.md](01-spec.md) | UPP v1 规范正文（字段、协议、契约等级、conformance） |
| [02-channels.md](02-channels.md) | 三通道判定算法、错误语义、token 成本 |
| [03-host-dsh.md](03-host-dsh.md) | DSH：bundle/patch/profile/skills 四通道与验证 |
| [04-host-workbuddy.md](04-host-workbuddy.md) | WorkBuddy：skills 热加载 + mcp.json + 双体系差异 |
| [05-host-accio.md](05-host-accio.md) | Accio：Gateway 唯一写入口、skills_config、插件导入 |
| [06-toolchain.md](06-toolchain.md) | `upp` CLI 全命令、store 语义、检查项、故障排查、CI |
| [07-migration-and-analyzer.md](07-migration-and-analyzer.md) | 迁移器 `upp import` 与分析器 `upp analyze`（设计+验收） |
| [08-security-and-supply-chain.md](08-security-and-supply-chain.md) | 威胁模型、权限映射、完整性、回滚 |
| [09-poc-report.md](09-poc-report.md) | P0 实机验证报告（环境、矩阵、证据、问题、复现） |
| [10-roadmap.md](10-roadmap.md) | P0/P1/P2 验收矩阵、风险登记、时间线 |
| [11-p1-mapping.md](11-p1-mapping.md) | P1 能力映射实现与实测：prompts/agents/i18n/recommend 三端落地与降级 |
| [12-repo-health.md](12-repo-health.md) | 仓库基线（commit/tag）、清理口径、`upp doctor`、发布前复现矩阵 |
| [13-productivity-plugin.md](13-productivity-plugin.md) | 生产力插件 doc-toolkit：本地解析文档/表格、按需取窗口、省 token 实测 |
| [15-team-plugins.md](15-team-plugins.md) | 团队高频插件 sheet-toolkit / log-toolkit：同一模板复制、契约与实测 |
| [14-delivery-guide.md](14-delivery-guide.md) | **交付手册（团队/用户版）**：安装、开发、迁移、分发、落点、FAQ |
| [16-uppenv.md](16-uppenv.md) | **uppenv 环境镜像**：三端 插件/技能/MCP/工具/记忆 的 Docker 式 export/import/rollback、真机数据、边界 |

> `upp import` / `upp analyze`（构想 ③）的实现与真机验收见 [07-migration-and-analyzer.md](07-migration-and-analyzer.md) §2.5。
