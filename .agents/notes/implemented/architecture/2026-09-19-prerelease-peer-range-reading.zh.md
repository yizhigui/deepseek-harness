# Agent Note：把预发布 peer 范围读作它自身所指的那条线

Status: implemented

[English](2026-09-19-prerelease-peer-range-reading.md) | 中文

## Problem

`dshmarket` 这样声明它的 `@deepseek-ai/dsh-settings` peer：

```
^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2
```

而工作区发布的是 `@deepseek-ai/dsh-settings@0.1.5-rc.2`。Semver 的默认比较会拒绝每一个预发布版本，除非范围中写明了 `major.minor.patch` 三元组完全相同的预发布版本，因此 `satisfies('0.1.5-rc.2', range)` 为 `false`，`validateDesktopPluginGraph()` 拒绝启用该插件。已发布的任何 `dshmarket` 版本都没有声明能接受它的范围 —— 最新的 `1.48.0` 携带的仍是同一段陈旧范围 —— 所以升级无法解决。

然而运行时 API 表面是兼容的。`dshmarket` 完全没有从 `@deepseek-ai/dsh-settings` 导入任何东西；它以结构化方式寻址 `settings` 服务（`ctx.inject(['settings'])`，随后 `settings.register(ns, schema, { base })`、`scope.get()`、`scope.watch()`），而这些在 `0.1.5-rc.2` 中全部存在且签名兼容。`0.1.2-alpha.2` 与 `0.1.5-rc.2` 已发布的 `lib/index.js` 与 `lib/types/index.d.ts` 逐字节相同；真正的破坏边界更早，在 `0.1.2-alpha.1`，它删除了 `installSettingsSection` 与 `settingsNamespace` —— 恰好是 `dshmarket` 在放宽其范围时已经移除的那些导入。该 peer 范围是陈旧的元数据，而不是不兼容。

## Decision

`satisfiesPeer()` **仅当已安装的候版本本身是预发布版本时**才传入 `{ includePrerelease: true }`。稳定版本仍以未经改动的默认比较来检验，因此任何普通 semver 规则都不会移动。

这一改动在构造上就是狭窄的。使用真实的 `semver@7.8.5` 与已发布范围验证后，该闸门只对预发布候选改变结论：

- 新被接受：`0.1.3-alpha.1`、`0.1.5-rc.1`、`0.1.5-rc.2`、`0.1.6-rc.1` —— 全部是该范围所指 `0.1.x` 线上的预发布版本；
- 保持不变地拒绝：`0.2.0-rc.1`、`0.2.0`、`1.0.0-rc.1`、`1.0.0` —— 不同的次版本或主版本线依旧不兼容；
- 保持不变地接受：该范围原本已点名的每个成员，以及该线上已发布的版本。

由于该选项只会对预发布候选生效，每个稳定版本的结果都与改动前逐位相同。

## Alternatives considered

**改为在范围检查中尊重 `peerDependenciesMeta.optional`。** `dshmarket` 确实把该 peer 标记为可选，而未被满足的可选 peer 本不应阻塞启用。否决其作为此处修法：这是对图校验器语义更宽泛的改动，而具体缺陷是预发布闸门，不是可选标记。缺失目标的分支依旧照原样尊重 `optional`，而缺失的必需 peer 仍然是错误。

**等待上游发布放宽范围的 `dshmarket` 版本。** 否决：没有任何已发布版本这样做，因此这会因一个纯元数据的不匹配而无限期阻塞。

**把工作区降级到范围之内的版本（`0.1.2-rc.1`）。** 否决：为了让一个并不导入它的插件的陈旧元数据得到满足，而降级一个第一方包。

**通过改写已安装的 peer 元数据或打补丁 `dshmarket` 来满足该范围。** 直接否决：那等于就实际安装了什么而发布一个谎言。

## Consequences

范围中点名了某条预发布线的插件，现在可以针对同一条线上更新的预发布版本启用 —— 这正是范围作者所要求的。`apps/desktop/tests/prerelease-peer.spec.ts` 同时锁定两半：对已发布范围而言对 `0.1.5-rc.2` 的放宽接受，以及不许移动的那些拒绝 —— `0.2.0-rc.1`、`0.2.0`、`1.0.0-rc.1`、`1.0.0`、一个明显错误的稳定 peer，以及一个缺失的必需 peer。该范围仍然是一次真实的检查：另一条线上不兼容的预发布版本会像以前一样被拒绝。
