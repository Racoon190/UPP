## UPP 1.5.0 — 一键换机向导 + 自动出包

1.4.0 给了 UPP 一个本地面板。1.5.0 补上它最缺的两件事：**换机器不再是命令行作业**，**发布不再手动传 105 MB**。

### 一键换机（GUI 新增「换机」工作区）

把 `uppenv` 的 export → 传输 → 校验 → 预演 → 导入 串成一个 5 步向导，每步只做一件事：

| 步骤 | 做什么 | 给谁看 |
|---|---|---|
| ① 旧机器打包 | 勾三端、勾五类资产，导出 `.uppenv`（默认签名） | 出交接卡：文件、大小、sha256、签名指纹 |
| ② 传输 | U 盘 / 网盘 / scp，随手记 sha256 | 人 |
| ③ 新机器核对 | 校验哈希 + 签名 + 资产清单 | 绿=都对 / 黄=未签名 / 红=拒绝导入 |
| ④ 预演导入 | dry-run，零写入 | create / update / noop / skip / error 计数 + 逐条落点 |
| ⑤ 真正导入 | 事务写入，失败可回滚 | 给出 `tx` id 与 `upp env rollback <tx>` |

每步都印出等价 CLI（`upp env export …` / `upp env import … --dry-run`），所以「会点界面」自动等于「会敲命令」。向导背后是 5 个新 action：`migrate.plan` / `migrate.pack` / `migrate.card` / `migrate.preview` / `migrate.apply`（后者 `danger:true`），同样对 MCP 暴露——agent 可以一个 action 一步地替人完成换机。

实测（真机）：65 assets → 签名导出 317.7 KB → 核对「哈希与签名都对」（指纹 `0f012f6363b1eb1b`）→ 预演 create 9 / update 6 / noop 34 / skip 25 / error 0。

### 镜像完整性收紧

`uppenv verify` 现在同时检查 zip 的**规范布局**：尾部追加字节、中央目录与 EOCD 对不上、归档前有前置数据，都会被判失败（`migrate.card` 直接 `valid:false` 并拒绝导入）。

边界说明：payload 哈希 + 布局检查挡的是内容损坏与越界数据；zip 元数据内部的位级改动只有 ed25519 签名覆盖（`--sign` 对整文件写 `.sha256` + `.sig.json`）。不可信传输请用签名镜像 + `--require-signature`。

### tag → exe，发布自动化

`.github/workflows/release.yml`：推送 `upp-v*` tag 后，在 `windows-latest` 上先跑完整 **18 步**回归门槛，通过后用 `node tools/build-gui.mjs` 构建 exe / 便携包，冒烟 `--version` / `selftest` / `--cli uppenv|upptool|uppmem`，再自动挂到对应 Release（资产 + 说明）。

```bash
git tag -a upp-v1.5.0 -m "UPP 1.5.0 — 一键换机向导 + 自动出包"
git push origin upp-v1.5.0        # 之后什么都不用做
```

- Release 说明来源：`docs/releases/<tag>.md`（本文件），缺失时回退 `docs/releases/_template.md`。
- 手动重跑：Actions → `release` → Run workflow，填 tag。
- 需要重发旧版本？同样填 tag 即可，资产会被覆盖更新。

### 质量门槛

`node tests/run-all.mjs` → **18/18 步全绿**：validate 42 · verify 28 · conformance 70 · upptool 22 · uppmem 34 · **uppgui 76** · setup-cli 14 等。
`node tools/test-uppgui.mjs` → **76 passed / 0 failed**（36 actions / 6 组、换机 5 个 action 的功能与零写入断言、追加字节篡改拒绝、MCP 2 工具 1348 B 预算）。
`node tools/test-uppenv.mjs` → 50 passed；`node tools/test-roundtrip.mjs` → 30 passed。

### 升级

```bash
git pull && node tools/upp.mjs self-update
upp --version          # 1.5.0
```

已有的 GUI 安装（1.4.0 装到 `%LOCALAPPDATA%\UPPGUI`）直接下新 Setup exe 覆盖安装即可；换机向导在「换机」工作区。

文档：`docs/20-uppgui.md`（换机向导、安全模型、实测字节）、`docs/16-uppenv.md`（镜像格式与事务）、`README.md`（发布自动化一节的命令）。
