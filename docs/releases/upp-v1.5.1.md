## UPP 1.5.1 — 跨平台修正 + 发布流程自检

1.5.0 的换机向导与 tag 自动出包已经工作；1.5.1 是它之后的第一份补丁，全部来自「让四个 CI 矩阵全绿」的复检。

### 修正

- **`upptool` 的 `cmd` 运行时在非 Windows 上不再失效**：`cmd` 的语义是「把这条命令交给平台 shell 执行」，此前硬编码 `cmd.exe /d /s /c`，在 Linux/macOS 上直接 ENOENT。现在 Windows 仍用 `ComSpec`，POSIX 走 `/bin/sh -c`，同一个登记工具可以跨平台跑。
- **CI 诊断更直接**：`tests/run-all.mjs` 的 `upptool` 步骤现在会把首条 `FAIL` 行（最多 160 字符）写进门槛摘要，失败时不必再翻完整日志。

### 发布流程验证

`upp-v1.5.0` 的 tag 触发了新增的 `.github/workflows/release.yml`，全流程一次通过：

1. `release gate`（windows-latest）：`node tests/run-all.mjs` → 18/18 步。
2. `build + publish assets`：`node tools/build-gui.mjs` → 冒烟 `--version` / `selftest` / `--cli uppenv|upptool|uppmem` → 挂到 Release。
3. 产物：`UPP-GUI-Setup-1.5.0.exe` 100,492,104 B、`upp-gui-1.5.0.zip` 40,006,851 B，全部由 CI 构建并 `uploaded`，本地不再手动上传。

本版本同样由这条流水线出包。

### 质量门槛

`node tests/run-all.mjs` → 18/18；`test-upptool` 22、`test-uppmem` 34、`test-uppgui` 76、`test-uppenv` 50、`test-roundtrip` 30 全绿。

### 升级

```bash
git pull && node tools/upp.mjs self-update && upp --version   # 1.5.1
```

图形界面无需重装（GUI 逻辑未变）；从 1.5.0 升上来的机器只要刷新 CLI 即可。
