# Agent Note: Recover abandoned Desktop package transactions

Status: implemented

English | [中文](2026-09-21-desktop-package-lock-recovery.zh.md)

## Problem

A PID file cannot distinguish a reused PID from its original owner. Reading a dead owner, unlinking its file, and exclusively recreating it permits two recoverers to enter: a delayed reader can unlink the first recoverer's new file. Process death bypasses in-memory rollback and can leave package metadata and bundle registration at different mutation stages.

## Decision

The manager holds a kernel guard throughout each transaction. Pnpm holds a separate guard before requesting permission to execute; loss of the parent before permission exits without importing pnpm. After permission, the worker retains its guard through process exit, including if Desktop dies first. Acquisition takes the manager guard and proves the worker guard available before interpreting durable ownership. A delayed, ungranted worker cannot write packages.

Windows uses Node's exclusive named-pipe listener, named by the hash of the canonical, case-folded profile guard path. Libuv binds its first instance exclusively; process death removes the listener. POSIX reuses the shipped native-system nonblocking flock primitive on stable sibling guard files, verifies inode identity, and never unlinks those files during reset. No age threshold decides ownership. Owner JSON contains schemaVersion, manager pid, token, and optional workerPid for diagnostics. Both guards being free proves a valid new-format record abandoned, regardless of PID reuse. Legacy PID-only records lack identity evidence, so only ESRCH permits migration; corrupt records and unknown liveness fail closed. See [Node IPC semantics](https://nodejs.org/api/net.html#ipc-support) and [libuv Windows bind](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c).

Package mutations atomically persist the existing manifest/lockfile snapshot before detaching host links. Startup restores it through the same restorePackages/finishPackageOperation path used by exception rollback. Preparation removes pending, then commits by deleting the snapshot before backend restart. A crash before commit restores the old graph; a crash after commit retains the new graph. Failed restoration retains the snapshot for retry. Pending without a snapshot uses existing frozen installation, rebuild, and validation. It is preparation state, not ownership.

This partially supersedes failure handling in the [in-place profile decision](../architecture/2026-09-09-desktop-in-place-profile.md) and [direct startup decision](../architecture/2026-09-09-desktop-immediate-window-and-direct-start.md). Those records retain their no-staging and window-lifecycle rationale. No package directory copy, second recovery engine, or backend shutdown change is introduced.

## Alternatives considered

**PID plus creation time alone** identifies a process more accurately but does not serialize stale-file removers or cover a pnpm spawn before publication. Kernel guards address ownership directly without an additional process-inspection API.

**Expiring lockfiles** can steal a legitimate long installation. An unresponsive live owner remains exclusive until it exits.

**Deleting ownership without restoring metadata** leaves interrupted add/remove operations with inconsistent manifest, lockfile, and bundles. Persisting the existing small rollback snapshot retains the established recovery path instead of copying the profile.

## Consequences

New-format abandoned transactions recover automatically; ambiguous live legacy PID records still require the actual owner to exit or separately established operator evidence. POSIX guard files persist as inodes, not active transaction markers. The inline bootstrap lets upstream Node run pnpm without reading Electron's app.asar and preserves direct-CLI worker-thread launch semantics. Deterministic subprocess barriers cover owner death, surviving workers, simultaneous recoverers, corruption, failed recovery, and subsequent operations. Installed Windows Electron crash/restart remains release qualification.
