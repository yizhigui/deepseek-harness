# Agent Note: Reading a prerelease peer range as its own line

Status: implemented

English | [中文](2026-09-19-prerelease-peer-range-reading.zh.md)

## Problem

`dshmarket` declares its `@deepseek-ai/dsh-settings` peer as

```
^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2
```

and the workspace ships `@deepseek-ai/dsh-settings@0.1.5-rc.2`. Semver's default comparison refuses every prerelease version unless the range spells a prerelease with the same `major.minor.patch` tuple, so `satisfies('0.1.5-rc.2', range)` is `false` and `validateDesktopPluginGraph()` refused to enable the plugin. No published `dshmarket` version declares a range that accepts it — `1.48.0`, the newest, carries the same stale range — so no upgrade can fix it.

The runtime API surface is nonetheless compatible. `dshmarket` imports nothing at all from `@deepseek-ai/dsh-settings`; it addresses the `settings` service structurally (`ctx.inject(['settings'])`, then `settings.register(ns, schema, { base })`, `scope.get()`, `scope.watch()`), and every one of those exists with a compatible signature in `0.1.5-rc.2`. The published `lib/index.js` and `lib/types/index.d.ts` of `0.1.2-alpha.2` and `0.1.5-rc.2` are byte-identical; the real breaking boundary is earlier, at `0.1.2-alpha.1`, which deleted `installSettingsSection` and `settingsNamespace` — exactly the imports `dshmarket` had already removed when it widened its range. The peer range is stale metadata, not an incompatibility.

## Decision

`satisfiesPeer()` passes `{ includePrerelease: true }` **only when the installed candidate is itself a prerelease**. A stable version is tested with the untouched default comparison, so no ordinary semver rule moves.

This is narrow by construction. Verified against the real `semver@7.8.5` with the published range, the gate changes the answer for prerelease candidates alone:

- newly accepted: `0.1.3-alpha.1`, `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.6-rc.1` — all prereleases of the `0.1.x` line the range names;
- unchanged refusals: `0.2.0-rc.1`, `0.2.0`, `1.0.0-rc.1`, `1.0.0` — a different minor or major line stays incompatible;
- unchanged acceptances: every member the range already named, and the line's released versions.

Because the option is only reached for a prerelease candidate, every stable version's result is bit-for-bit what it was.

## Alternatives considered

**Honor `peerDependenciesMeta.optional` in the range check instead.** `dshmarket` does mark the peer optional, and an unmet optional peer should not block activation. Rejected as the fix here: it is a broader change to the graph validator's meaning, and the concrete defect is the prerelease gate, not the optional flag. The missing-target branch keeps honoring `optional` unchanged, and a required peer that is absent is still an error.

**Wait for an upstream `dshmarket` release that widens the range.** Rejected: no published version does, so this blocks indefinitely on a metadata-only mismatch.

**Downgrade the workspace to a version inside the range (`0.1.2-rc.1`).** Rejected: that is a downgrade of a first-party package to satisfy stale metadata for a plugin that does not import it.

**Satisfy the range by rewriting the installed peer metadata or patching `dshmarket`.** Rejected outright: it would ship a lie about what was installed.

## Consequences

A plugin whose range names a prerelease line can now be enabled against a newer prerelease of that same line, which is what the range author asked for. `apps/desktop/tests/prerelease-peer.spec.ts` pins both halves: the widened acceptance of `0.1.5-rc.2` against the published range, and the refusals that must not move — `0.2.0-rc.1`, `0.2.0`, `1.0.0-rc.1`, `1.0.0`, a plainly wrong stable peer, and a required peer that is absent. The range is still a real check: an incompatible prerelease of another line is refused exactly as before.
