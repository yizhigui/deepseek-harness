# DeepSeek Harness Desktop 附加打包目标

English | [中文](README.md)

本目录**只包含附加的桌面打包代码**，服务于已经位于 [`apps/desktop`](../desktop) 的官方 Electron
桌面应用。它不派生、不复制、也不替换该外壳、内置运行时或任何 Harness 源码。

## 本目录存在的原因

`apps/desktop` 是官方 Electron 外壳，已经承担了真正的工作：它把内置的 Harness 后端作为受管子进程
启动、等待其就绪，并对外提供 Web UI。它的 Windows 目标只有 NSIS（`apps/desktop/electron-builder.config.mjs`
中的 `win.target === ['nsis']`）。

本目录在不修改该配置的前提下，增加了本地桌面分发所需的额外目标：

1. 与现有 NSIS 安装程序并存的 **portable** `.exe`；
2. 输出写入 `dist-desktop/`；
3. 与构建暂存目录位于同一卷上的构建器缓存位置。

## 本目录解决的 `EXDEV` 问题

`electron-builder` 会把它的 NSIS 和 7-Zip 工具集下载到
`%LOCALAPPDATA%\electron-builder\Cache`，先把每个归档解压到同级的 `.tmp` 目录，再重命名到最终位置。
当构建暂存目录位于另一个卷上时，最后这次 `rename` 会跨设备并失败：

```
EXDEV: cross-device link not permitted, rename
  'C:\Users\<user>\AppData\Local\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-a34pt.tmp'
  -> '...\7zip-win-x64-a34pt'
```

本目录中的脚本都会把 `ELECTRON_BUILDER_CACHE` 设置为构建输出旁边的一个目录，因此下载内容、它的临时同级
目录和最终名称始终位于同一个卷上。

## 脚本

需要 `pnpm run package:desktop:win:x64:unsigned` 已经在
`apps/desktop/.desktop-build/targets/win-x64/` 下准备好的产物，以及一个已经打包完成的应用目录。

```powershell
# From the repository root.
# Build the full installer + portable exe from the unpacked application.
pnpm --dir apps/desktop-portable exec node scripts/package-portable.mjs win-x64

# Only the portable exe.
pnpm --dir apps/desktop-portable exec node scripts/package-portable.mjs win-x64 --portable-only
```

本目录中的 `node_modules` 按照 `apps/desktop` 的解析结果链接工作区的 `electron-builder`、
`app-builder-lib` 和 `electron`，因此不需要额外的安装步骤。

## 应用图标

`apps/desktop/assets/` 存放图标集，由仓库已经附带的图形素材构建而成：

| 文件 | 作用 |
|---|---|
| `icon-source.svg` | 唯一的源文件：官方鲸鱼路径、品牌蓝 `#4D6BFE`、1024x1024、透明、安全边距 |
| `icon.png` | 1024x1024 透明位图 |
| `icon.ico` | 16、24、32、48、64、128 和 256 各尺寸条目 |

用以下命令从官方图形素材重新生成这三个文件：

```sh
pnpm --dir apps/desktop-portable run icons
```

生成器从 `apps/web/public/favicon.svg` 中读取鲸鱼路径（该文件与 `website/public/favicon.svg` 的图形
字节一致，并以相同的品牌蓝渲染），绝不会描摹、拉伸或重绘该标志。`sharp` 从
`packages/attachment/attachment-local` 解析，这是已经依赖它的工作区包，因此没有引入新依赖。

`apps/desktop/electron-builder.config.mjs` 会把 `assets/icon.ico` 嵌入 `DeepSeek Harness.exe`，
NSIS、portable 存根、卸载程序以及两个快捷方式都从该可执行文件资源继承它——因此更换图标只需重新生成一个
文件再加一次重新构建，无需维护单独的 `.ico` 路径。未打包的开发外壳把 `BrowserWindow` 指向同一个文件，
因为开发版 Electron 二进制自身不携带嵌入资源。

安装程序无需任何安装后步骤即可创建这两个快捷方式：

```jsonc
nsis: { createStartMenuShortcut: true, createDesktopShortcut: true, shortcutName: 'DeepSeek Harness' }
```

`scripts/verify-desktop-shortcut.ps1` 通过 Windows 卸载注册表（依次为 `DisplayIcon`、
`InstallLocation`、`UninstallString`，然后是 `Programs` 目录——绝不使用构建输出）定位已安装的应用，
通过 Shell 特殊文件夹 API 解析桌面目录，在需要时创建快捷方式，校验每个字段，并且在使用 `-Launch` 时
通过快捷方式启动应用，检查后端是否就绪、随后是否随应用一同退出。

## 外壳配置与外壳拥有的 Harness home

外壳在打开 profile 或启动后端**之前**就解析它拥有的 Harness home，因为 `resolveDesktopPaths()` 会从
后端所读取的同一个 home 派生 Electron 拥有的 profile 和包管理器状态。若在两处分别派生该 home，外壳与
其后端就可能对正在使用的 profile 产生分歧，因此外壳只解析一次并将其固定到后端的子进程环境中。

`%APPDATA%\DeepSeekHarness\` 下存在两个由外壳拥有的配置位置：

| 路径 | 用途 |
|---|---|
| `desktop-config.json` | 可选。`{ "dshHome": "<absolute path>" }` |
| `logs\desktop.log` | 启动、已解析 home 与后端生命周期诊断 |

优先级从高到低：

1. `desktop-config.json` 中的绝对 `dshHome`；
2. 从启动该应用的进程继承的 `DSH_HOME`；
3. Harness 默认 home，`~/.dsh`。

第 2 步和第 3 步就是 Harness 自身的解析逻辑——外壳调用 `@deepseek-ai/dsh-home-paths` 中的
`resolveDshHome`，也就是 `apps/desktop/src/paths.ts` 和 Harness 宿主使用的同一个辅助函数。桌面配置
只增加了压过环境变量的能力，这正是让应用独立于任何启动它的进程的原因。诸如 `~/harness-home` 这样的
波浪号形式也由同一个辅助函数展开。

启动时会记录该决策，因此当前生效的 home 从不是猜测：

```
Resolved DSH_HOME: D:\example\harness-home
Source: desktop-config
```

`Source` 的取值为 `desktop-config`、`environment` 或 `default`。

失败处理刻意设计为非致命。文件缺失时保持原有行为。文件不可读、JSON 无效、根不是 JSON 对象，或
其 `dshHome` 为空、非字符串或为相对路径时，会被忽略并在日志中写入一行 `Configuration warning:`，
解析继续进入下一步。应用绝不会因为自身配置而拒绝启动。

只有 `DSH_HOME` 会被注入后端子进程环境，同时会移除 `HOME`/`HOMEDRIVE`/`HOMEPATH` 覆盖。不会为写入
而读取任何机器级或用户级环境变量，也不会写入任何环境变量。

## 与官方外壳的关系

| 关注点 | 归属 |
|---|---|
| Electron 主进程、preload、窗口、IPC、协议 | `apps/desktop`（未改动） |
| 后端子进程生命周期与就绪状态 | `apps/desktop`（未改动） |
| 内置 Node.js、pnpm 和生产 Harness 树 | `apps/desktop`（未改动） |
| 应用图标、NSIS 安装程序与快捷方式配置 | `apps/desktop`（官方配置） |
| 图标图形素材与生成 | `apps/desktop/assets/`、`scripts/build-icons.mjs` |
| Harness home 解析与外壳日志 | `apps/desktop/src/desktop-config.ts`、`logger.ts` |
| 额外的 `portable` 目标、`dist-desktop/` 输出、构建器缓存位置 | 本目录 |

`scripts/portable-targets.mjs` 导入官方配置工厂
（`apps/desktop/electron-builder.config.mjs`），并且只追加一个目标，因此升级、运行时校验和签名配置
始终来自官方单一事实来源。
