# Agent Note: Make Windows distribution handoff reproducible

Status: implemented

English | [中文](2026-09-16-windows-distribution-handoff.zh.md)

## Problem

The Windows installer and portable executable are generated from a large staging tree. Copying those artifacts by hand does not prove that local credentials, sessions, shell configuration, or personal paths stayed outside the package, and it gives recipients no stable integrity or clean-user verification procedure.

## Decision

The Desktop portable add-on owns the distribution helpers. `audit-distribution.ps1` scans the packaged tree and extracted `app.asar`, compares it with local secret candidates without printing their values, and fails on user-state files, personal paths, or credential-like values. `verify-clean-user.ps1` launches a packaged executable with isolated `DSH_HOME`, `APPDATA`, and `LOCALAPPDATA` directories and proves onboarding UI, bundled-runtime startup, and teardown. `prepare-distribution.ps1` copies only the two user-facing executables and a plain-text README into the ignored `release-windows` directory, then generates SHA-256 sums. `build-distribution.ps1` runs the whole supported pipeline, and `verify-release-security.ps1` re-scans the finished handoff set for personal paths, local secret values, credential-shaped tokens, and unexpected files.

Dynamic Client bundles give CSS virtual modules repository-relative ids. Rolldown includes virtual ids in generated region comments, so absolute ids would disclose the build checkout even though source-map paths were already rebased. Loaders reconstruct the physical path from the stable id when reading the stylesheet.

The audit helpers use the `IndexOf(string, StringComparison)` overload rather than `String.Contains(string, StringComparison)`, because the latter only exists on .NET Core and later; Windows PowerShell 5.1 runs on .NET Framework 4.x, where the audit would otherwise fail before scanning anything.

The checked-in `DISTRIBUTION-WINDOWS.md` documents the recipient contract and the reproduction and verification commands: the installer is primary, the portable artifact is optional, the runtime is self-contained, credentials are user-owned, user data survives uninstall, and unsigned builds can trigger SmartScreen.

## Alternatives considered

**Publish directly from `dist-desktop`.** That directory also contains canonical builder filenames, block maps, and debug metadata. Sending it invites accidental disclosure and gives recipients no single manifest of intended files.

**Trust the electron-builder file list without scanning.** The configured inputs are narrow, but prepared runtime trees and future packaging changes can still introduce generated state. A scan of the exact staging tree catches that class of error before handoff.

**Use the maintainer's normal Harness home for smoke tests.** Existing credentials and sessions can hide first-launch defects and cannot prove recipient isolation.

## Consequences

A Windows handoff now has a small explicit output set, reproducible hashes, a no-secret audit, a clean-user lifecycle check, and no checkout path in generated Client modules. The audit intentionally errs on the side of blocking credential-shaped content and may require review when a dependency adds an example token. The scripts verify runtime behavior on the current Windows host; they do not replace code signing or testing on every supported Windows configuration.
