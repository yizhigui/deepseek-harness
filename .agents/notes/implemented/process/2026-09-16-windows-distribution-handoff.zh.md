# Agent Note: 让 Windows 分发交付可重复执行

Status: implemented

[English](2026-09-16-windows-distribution-handoff.md) | 中文

## 问题

Windows 安装程序与便携版可执行文件由大型暂存树生成。手动复制这些产物无法证明本机凭据、会话、桌面壳配置或个人路径没有进入安装包，也无法为接收者提供稳定的完整性校验与干净用户验证流程。

## 决策

Desktop 便携目标扩展负责分发辅助脚本。`audit-distribution.ps1` 扫描打包树和解包后的 `app.asar`，在不输出秘密值的前提下与本机秘密候选值比较，并在发现用户状态文件、个人路径或类似凭据的值时失败。`verify-clean-user.ps1` 使用隔离的 `DSH_HOME`、`APPDATA` 和 `LOCALAPPDATA` 目录启动已打包的可执行文件，并验证首次配置界面、内置运行时启动和正常退出。`prepare-distribution.ps1` 只把两个面向用户的可执行文件和纯文本 README 复制到被 Git 忽略的 `release-windows` 目录，然后生成 SHA-256 校验值。`build-distribution.ps1` 运行完整的受支持流程，`verify-release-security.ps1` 对最终交付集合复扫个人路径、本机秘密值、类似凭据的 token 和多余文件。

动态 Client bundle 为 CSS 虚拟模块使用相对于仓库的 id。Rolldown 会把虚拟 id 写入生成的区段注释，因此即使 source map 路径已经重定向，绝对 id 仍会泄露构建 checkout。loader 在读取样式表时从稳定 id 还原物理路径。

审计脚本使用 `IndexOf(string, StringComparison)` 重载而非 `String.Contains(string, StringComparison)`，因为后者只存在于 .NET Core 及更高版本；Windows PowerShell 5.1 运行在 .NET Framework 4.x 上，否则审计会在开始扫描前就失败。

仓库中的 `DISTRIBUTION-WINDOWS.md` 说明接收者契约以及复现与验证命令：安装版是主要版本，便携版为可选版本，运行时自包含，凭据归用户所有，卸载后保留用户数据，未签名构建可能触发 SmartScreen。

## 考虑过的替代方案

**直接发布 `dist-desktop`。** 该目录还包含构建器规范文件名、差分块映射和调试元数据。直接发送容易包含不应分发的内容，也不能向接收者明确说明预期文件集合。

**只信任 electron-builder 文件列表而不扫描。** 配置的输入范围很窄，但准备后的运行时树和未来的打包变更仍可能引入生成状态。交付前扫描实际暂存树可以发现这类问题。

**使用维护者日常的 Harness home 做冒烟测试。** 已有凭据和会话可能掩盖首次启动缺陷，也无法证明接收者隔离。

## 影响

Windows 交付现在拥有小而明确的输出集合、可重复生成的校验值、无秘密扫描、干净用户生命周期检查，并且生成的 Client 模块不再包含 checkout 路径。审计脚本可在 Windows PowerShell 5.1 与 PowerShell 7 上运行。扫描器会倾向于阻止类似凭据的内容；依赖未来加入示例 token 时可能需要人工审查。这些脚本验证当前 Windows 主机上的运行时行为，但不能替代代码签名或所有受支持 Windows 配置上的测试。
