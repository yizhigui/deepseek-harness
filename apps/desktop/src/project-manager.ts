/** In-place owner of the reserved desktop profile and its private pnpm state. */

import { valid } from 'semver'
import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import { removeOwnedDirectory } from './owned-directory.ts'
import { DesktopPackageLock, writePackageRecord } from './package-lock.ts'
import { PACKAGE_WORKER_SOURCE } from './package-worker.ts'
import type { DesktopRelease } from './release.ts'
import { desktopRuntimeId, readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import {
  desktopPluginLockHash, linkDesktopHostPackages, readDesktopProfileState,
  unlinkDesktopHostPackages, validateDesktopPluginGraph, type DesktopProfileState,
} from './profile-packages.ts'

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** Installed desktop project manifest slice. */
interface DesktopProjectManifest {
  readonly name: string
  readonly private: true
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly dsh: {
    readonly profile: {
      readonly bundles: string[]
    }
  }
}

/** Exact executables the desktop shell bundles. */
export interface DesktopRuntimeExecutables {
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

/** Hooks that stop the backend before profile writes and restart it after success. */
export interface DesktopProjectHooks {
  /** Stop the active backend and await process exit before modifying its files. */
  beforeChange(): Promise<void>
  /** Start the modified profile after package preparation succeeds. */
  afterChange(): Promise<void>
}

/** Supported dependency mutation. */
export type DesktopProjectMutation =
  | { readonly type: 'plugin-add'; readonly spec: string }
  | { readonly type: 'plugin-remove'; readonly name: string }
  | { readonly type: 'plugin-update'; readonly name: string; readonly version: string }
  | { readonly type: 'plugin-toggle'; readonly name: string; readonly enabled: boolean }
  | { readonly type: 'plugins-disable-all' }

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const MAX_PNPM_DIAGNOSTIC_BYTES = 64 * 1024
const DESKTOP_REGISTRY = 'https://registry.npmjs.org/'
/** Marker the profile carries while a package-manager operation is unfinished. */
const PENDING_PACKAGES = 'desktop-packages-pending'
const TRANSACTION_SNAPSHOT = 'desktop-transaction-snapshot.json'

/** Profile bytes one transaction restores when it fails after touching them. */
interface DesktopProfileSnapshot {
  readonly manifest: Buffer
  readonly lockfile: Buffer | undefined
}

/**
 * Failure of one profile mutation.
 *
 * `restored` reports whether the transaction put every profile file back the way
 * it was before the mutation. True means the failure belongs to the requested
 * plugin change and the profile is still the working one; false means the profile
 * could not be restored and the application must treat it as damaged.
 */
export class DesktopProjectMutationError extends Error {
  /**
   * @param message - Failure text for the user; a restored failure keeps the plugin's own message.
   * @param restored - Whether the pre-mutation profile is in place.
   * @param cause - Original failure that triggered the restore.
   */
  constructor(message: string, readonly restored: boolean, cause?: unknown) {
    super(message)
    this.name = 'DesktopProjectMutationError'
    if (cause !== undefined) this.cause = cause
  }
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/**
 * Capture the two files that define the profile's package graph.
 * @param projectDir - Desktop profile directory.
 * @returns Manifest and lockfile bytes, with the missing-lockfile case kept distinct.
 */
function profileSnapshot(projectDir: string): DesktopProfileSnapshot {
  const lockfile = join(projectDir, 'pnpm-lock.yaml')
  return {
    manifest: readFileSync(join(projectDir, 'package.json')),
    lockfile: existsSync(lockfile) ? readFileSync(lockfile) : undefined,
  }
}

/**
 * Report whether a failed operation changed anything a snapshot covers.
 *
 * The rebuild marker is written before pnpm spawns, so a marker this operation
 * introduced proves pnpm reached the package directories even when pnpm failed
 * before rewriting the manifest.
 * @param projectDir - Desktop profile directory.
 * @param snapshot - Bytes captured before the operation.
 * @param markedBefore - Whether the rebuild marker was already present.
 * @returns Whether the profile drifted from the snapshot.
 */
function profileDrifted(projectDir: string, snapshot: DesktopProfileSnapshot, markedBefore: boolean): boolean {
  if (!snapshot.manifest.equals(readFileSync(join(projectDir, 'package.json')))) return true
  const lockfile = join(projectDir, 'pnpm-lock.yaml')
  const current = existsSync(lockfile) ? readFileSync(lockfile) : undefined
  if (snapshot.lockfile === undefined ? current !== undefined : current === undefined || !snapshot.lockfile.equals(current)) {
    return true
  }
  return !markedBefore && existsSync(join(projectDir, PENDING_PACKAGES))
}

/**
 * Write the captured profile bytes back.
 *
 * The lockfile goes first: the rebuild marker lets startup recovery redo the
 * links from it, so a manifest written last can never pair with the wrong graph.
 * @param projectDir - Desktop profile directory.
 * @param snapshot - Bytes captured before the operation.
 */
function restoreProfileSnapshot(projectDir: string, snapshot: DesktopProfileSnapshot): void {
  const lockfile = join(projectDir, 'pnpm-lock.yaml')
  if (snapshot.lockfile === undefined) {
    if (existsSync(lockfile)) unlinkSync(lockfile)
  } else writeFileSync(lockfile, snapshot.lockfile, { mode: 0o600 })
  writeFileSync(join(projectDir, 'package.json'), snapshot.manifest, { mode: 0o600 })
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validate one bare plugin package name.
 * @param name - npm package name, without a version or tag.
 */
export function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`desktop project: invalid npm package name ${JSON.stringify(name)}`)
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`desktop project: invalid exact version ${JSON.stringify(version)}`)
}

/**
 * Validate one registry package spec and return its package name.
 * @param spec - npm registry name with an optional version or tag.
 * @returns Requested package name.
 */
export function packageNameFromSpec(spec: string): string {
  if (spec === '' || spec.startsWith('-') || /[\s\\]/u.test(spec) || spec.includes('://') || spec.startsWith('file:')) {
    throw new Error(`desktop project: unsupported npm package spec ${JSON.stringify(spec)}`)
  }
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash === -1) throw new Error(`desktop project: invalid scoped package spec ${JSON.stringify(spec)}`)
    const versionAt = spec.indexOf('@', slash)
    const name = versionAt === -1 ? spec : spec.slice(0, versionAt)
    assertPackageName(name)
    if (versionAt !== -1) assertVersion(spec.slice(versionAt + 1))
    return name
  }
  const versionAt = spec.indexOf('@')
  const name = versionAt === -1 ? spec : spec.slice(0, versionAt)
  assertPackageName(name)
  if (versionAt !== -1) assertVersion(spec.slice(versionAt + 1))
  return name
}

function projectManifest(projectDir: string): DesktopProjectManifest {
  const path = join(projectDir, 'package.json')
  const value = readJson(path)
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  if (!isRecord(value) || value.name !== PROJECT_NAME || value.private !== true
    || typeof value.version !== 'string' || (value.dependencies !== undefined && !isRecord(value.dependencies))
    || !Array.isArray(profile?.bundles) || !profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error(`desktop project: invalid desktop profile manifest ${path}`)
  }
  const manifest = { ...value, dependencies: value.dependencies ?? {} } as unknown as DesktopProjectManifest
  if (Object.entries(manifest.dependencies).some(([name, version]) => !PACKAGE_NAME_PATTERN.test(name)
    || typeof version !== 'string' || valid(version) !== version)) {
    throw new Error('desktop project: plugin dependencies must use exact registry versions')
  }
  return manifest
}

function profilePluginNames(projectDir: string): readonly string[] {
  const bundles = projectManifest(projectDir).dsh.profile.bundles
  if (!DESKTOP_PROFILE_BUNDLES.every((bundle, index) => bundles[index] === bundle)) {
    throw new Error('desktop project: profile must begin with the built-in desktop bundle list')
  }
  const plugins = bundles.slice(DESKTOP_PROFILE_BUNDLES.length)
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  for (const plugin of plugins) assertPackageName(plugin)
  return plugins
}

function pluginRecords(projectDir: string): readonly DesktopPluginRecord[] {
  return Object.keys(projectManifest(projectDir).dependencies).sort().map(name => inspectPlugin(projectDir, name))
}

function writeProfilePlugins(projectDir: string, plugins: readonly DesktopPluginRecord[]): void {
  const manifest = projectManifest(projectDir)
  writeJson(join(projectDir, 'package.json'), {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: [...DESKTOP_PROFILE_BUNDLES, ...plugins.filter(plugin => plugin.enabled).map(plugin => plugin.name)],
      },
    },
  } satisfies DesktopProjectManifest)
}

function inspectPlugin(projectDir: string, requestedName: string): DesktopPluginRecord {
  const manifestPath = join(projectDir, 'node_modules', ...requestedName.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has no manifest`)
  }
  const manifest = readJson(manifestPath)
  if (!isRecord(manifest) || manifest.name !== requestedName || typeof manifest.version !== 'string') {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has inconsistent name or version`)
  }
  const dsh = manifest.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  const patch = isRecord(bundle) ? bundle.patch : undefined
  if (typeof patch !== 'string' || patch === '') {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} does not declare dsh.bundle.patch`)
  }
  const packageDir = dirname(manifestPath)
  const patchPath = resolve(packageDir, patch)
  if ((patchPath !== packageDir && !patchPath.startsWith(packageDir + sep)) || !existsSync(patchPath)) {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} declares an invalid bundle patch`)
  }
  return { name: requestedName, version: manifest.version, enabled: profilePluginNames(projectDir).includes(requestedName) }
}

/** Desktop npm project manager: one profile transaction at a time, rolling a failed change back. */
export class DesktopProjectManager {
  private transactionLock: DesktopPackageLock | undefined
  private descriptor: DesktopRuntimeDescriptor | undefined

  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - absolute bundled Node.js and pnpm entry paths.
   * @param environment - environment for package-manager children, carrying the resolved `DSH_HOME`.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: DesktopRuntimeExecutables,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Read the active desktop plugin inventory. */
  listPlugins(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    return pluginRecords(this.paths.profile)
  }

  /**
   * Reinitialize the profile, deleting configuration and third-party packages without a backup.
   * @param hooks - Stop the Host before resetting files; restart after preparation succeeds.
   * @returns Completion of reset; the held lock and shared product data are preserved.
   */
  async resetConfiguration(hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      await hooks.beforeChange()
      this.descriptor = this.readRuntime()
      for (const entry of readdirSync(this.paths.profile, { withFileTypes: true })) {
        const path = join(this.paths.profile, entry.name)
        if (path === this.paths.lock) continue
        if (entry.isDirectory()) removeOwnedDirectory(path)
        else unlinkSync(path)
      }
      createPluginProfile(this.paths.profile)
      this.prepareProfile(this.paths.profile)
      await hooks.afterChange()
    })
  }

  /** Read the dsh version supplied by this application's verified resources. */
  dshVersion(): string {
    return this.currentRuntime().release.version
  }

  /** Read the release most recently applied to the active profile. */
  releaseVersion(): string {
    const state = readDesktopProfileState(this.paths.profile)
    if (state === undefined) throw new Error('desktop project: active profile has no runtime state')
    return state.version
  }

  /** Reject a profile whose dependency links were prepared for another runtime. */
  assertProfileRuntime(projectDir: string): void {
    if (existsSync(this.pendingPackages)) throw new Error('desktop project: package preparation is incomplete; retry startup')
    if (readDesktopProfileState(projectDir)?.runtimeId !== desktopRuntimeId(this.currentRuntime())) {
      throw new Error('desktop project: profile does not match this application runtime')
    }
  }

  /** @returns Whether application resources support profile recovery. */
  canRecoverProfile(): boolean {
    return this.descriptor !== undefined && existsSync(this.runtime.node) && existsSync(this.runtime.dsh)
  }

  private get pendingPackages(): string { return join(this.paths.profile, PENDING_PACKAGES) }
  private get transactionSnapshot(): string { return join(this.paths.profile, TRANSACTION_SNAPSHOT) }

  private saveTransactionSnapshot(snapshot: DesktopProfileSnapshot): void {
    writePackageRecord(this.transactionSnapshot, {
      schemaVersion: 1, manifest: snapshot.manifest.toString('base64'), lockfile: snapshot.lockfile?.toString('base64'),
    })
  }

  private clearTransactionSnapshot(): void {
    if (existsSync(this.transactionSnapshot)) unlinkSync(this.transactionSnapshot)
  }

  private async recoverInterruptedMutation(): Promise<boolean> {
    if (!existsSync(this.transactionSnapshot)) return false
    const value = readJson(this.transactionSnapshot)
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.manifest !== 'string'
      || (value.lockfile !== undefined && typeof value.lockfile !== 'string')) {
      throw new Error('desktop project: invalid package transaction snapshot')
    }
    const decode = (text: string): Buffer => {
      const bytes = Buffer.from(text, 'base64')
      if (bytes.toString('base64') !== text) throw new Error('desktop project: invalid package transaction snapshot encoding')
      return bytes
    }
    const snapshot: DesktopProfileSnapshot = {
      manifest: decode(value.manifest), lockfile: value.lockfile === undefined ? undefined : decode(value.lockfile),
    }
    writeFileSync(this.pendingPackages, '')
    restoreProfileSnapshot(this.paths.profile, snapshot)
    await this.restorePackages(this.paths.profile, snapshot)
    this.clearTransactionSnapshot()
    return true
  }

  private currentRuntime(): DesktopRuntimeDescriptor {
    if (this.descriptor === undefined) throw new Error('desktop project: runtime metadata has not been loaded')
    return this.descriptor
  }

  private readRuntime(): DesktopRuntimeDescriptor {
    this.descriptor = undefined
    return readDesktopRuntime(this.runtime.dsh)
  }

  private prepareProfile(projectDir: string): void {
    const runtime = this.currentRuntime()
    linkDesktopHostPackages(projectDir, this.runtime.dsh, runtime)
    validateDesktopPluginGraph(projectDir, this.runtime.dsh, runtime, profilePluginNames(projectDir))
  }

  /** Read release metadata and reconcile its external profile without installing core packages. */
  async applyRelease(): Promise<boolean> {
    return this.withLock(async () => {
      const target = this.readRuntime()
      this.descriptor = target
      const recovered = await this.recoverInterruptedMutation()
      const previous = readDesktopProfileState(this.paths.profile)
      if (!existsSync(this.pendingPackages) && previous?.runtimeId === desktopRuntimeId(target)
        && previous.lockHash === desktopPluginLockHash(this.paths.profile)
        && previous.links.length === target.sharedPackages.length
        && previous.links.every(link => existsSync(link.target)
          && existsSync(join(this.paths.profile, 'node_modules', link.name))
          && realpathSync.native(link.target) === realpathSync.native(join(this.runtime.dsh, 'node_modules', link.name)))) {
        return recovered
      }
      if (previous === undefined) createPluginProfile(this.paths.profile)
      await this.reconcileProfile(this.paths.profile, previous)
      return true
    })
  }

  /**
   * Modify the current profile while its backend is stopped.
   *
   * The profile is one transaction. When any step after the first profile write
   * fails — pnpm, plugin inspection, bundle registration, peer or graph
   * validation, host relinking — the pre-mutation profile goes back, so a failed
   * install never leaves a half-installed profile behind. The backend restart
   * that follows a successful change stays outside the transaction: its failure
   * keeps the new, already valid profile.
   * @param mutation - Dependency or activation change to apply.
   * @param hooks - Stop the Host before profile writes; restart it after success.
   */
  async mutate(mutation: DesktopProjectMutation, hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      this.currentRuntime()
      if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
      await hooks.beforeChange()
      if (mutation.type === 'plugin-add' || mutation.type === 'plugin-remove' || mutation.type === 'plugin-update') {
        await this.recoverInterruptedMutation()
        if (existsSync(this.pendingPackages)) await this.reconcileProfile(this.paths.profile, readDesktopProfileState(this.paths.profile))
      }
      const snapshot = profileSnapshot(this.paths.profile)
      const markedBefore = existsSync(this.pendingPackages)
      if (mutation.type === 'plugins-disable-all') {
        try {
          const manifest = projectManifest(this.paths.profile)
          writeJson(join(this.paths.profile, 'package.json'), {
            ...manifest,
            dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [...DESKTOP_PROFILE_BUNDLES] } },
          })
          this.prepareProfile(this.paths.profile)
          this.clearTransactionSnapshot()
        } catch (error) {
          throw await this.restoreFailure(this.paths.profile, snapshot, false, markedBefore, error)
        }
        await hooks.afterChange()
        return
      }
      const previous = readDesktopProfileState(this.paths.profile)
      const packagesChanged = mutation.type !== 'plugin-toggle'
      if (packagesChanged) this.saveTransactionSnapshot(snapshot)
      try {
        if (packagesChanged) unlinkDesktopHostPackages(this.paths.profile)
        try {
          await this.applyMutation(this.paths.profile, mutation)
        } finally {
          if (packagesChanged) linkDesktopHostPackages(this.paths.profile, this.runtime.dsh, this.currentRuntime())
        }
        await this.reconcileProfile(this.paths.profile, previous, packagesChanged)
      } catch (error) {
        const failure = await this.restoreFailure(this.paths.profile, snapshot, packagesChanged, markedBefore, error)
        if (packagesChanged && failure.restored) this.clearTransactionSnapshot()
        throw failure
      }
      if (packagesChanged) this.clearTransactionSnapshot()
      await hooks.afterChange()
    })
  }

  /**
   * Put a profile back the way it was before a mutation that failed.
   * @param projectDir - Profile the failed mutation may have changed.
   * @param snapshot - Manifest and lockfile bytes captured before the mutation.
   * @param packagesChanged - Whether the mutation owned package directories.
   * @param markedBefore - Whether the rebuild marker was already present.
   * @param failure - Failure that triggered the restore.
   * @returns The failure to report, carrying the profile outcome; never throws,
   *   so the caller's own `throw` states what leaves the transaction.
   */
  private async restoreFailure(
    projectDir: string, snapshot: DesktopProfileSnapshot, packagesChanged: boolean,
    markedBefore: boolean, failure: unknown,
  ): Promise<DesktopProjectMutationError> {
    const reason = errorOf(failure, 'desktop project: package transaction failed')
    // A rejection that never reached a profile write — an unsupported spec, a
    // reserved host package, a plugin that is not installed — changed nothing, so
    // there is no drift to undo and no reason to touch node_modules.
    if (!profileDrifted(projectDir, snapshot, markedBefore)) {
      return new DesktopProjectMutationError(reason.message, true, failure)
    }
    try {
      // The marker goes first when the package directories are part of the
      // restore: whatever happens next, the next startup rebuilds the links from
      // the lockfile this restore is about to put back.
      if (packagesChanged && snapshot.lockfile !== undefined) writeFileSync(this.pendingPackages, '')
      restoreProfileSnapshot(projectDir, snapshot)
      if (packagesChanged) await this.restorePackages(projectDir, snapshot)
      else {
        // Activation and bundle-list changes own no package directories: the
        // restored manifest is the whole profile again.
        this.prepareProfile(projectDir)
      }
    } catch (error) {
      return new DesktopProjectMutationError(
        `${reason.message} (the desktop profile could not be restored: ${errorOf(error, 'unknown recovery failure').message})`,
        false,
        failure,
      )
    }
    return new DesktopProjectMutationError(reason.message, true, failure)
  }

  /**
   * Reproduce the pre-mutation package directories from the restored lockfile.
   * @param projectDir - Profile whose manifest and lockfile are already restored.
   * @param snapshot - Bytes captured before the mutation.
   */
  private async restorePackages(projectDir: string, snapshot: DesktopProfileSnapshot): Promise<void> {
    // The whole package directory goes, without consulting the recorded links
    // first: the failed operation may have left packages the old lockfile never
    // named, or replaced a runtime link with a real directory, and removing the
    // tree unlinks nested links without visiting their targets either way.
    removeOwnedDirectory(join(projectDir, 'node_modules'))
    if (snapshot.lockfile === undefined) {
      // The pre-mutation profile owned no lockfile, so its node_modules only ever
      // held host links: relinking is the whole restore, with no manager run.
      this.prepareProfile(projectDir)
      if (existsSync(this.pendingPackages)) unlinkSync(this.pendingPackages)
      return
    }
    // Reinstall from the restored lockfile through the same pending path a runtime
    // change uses: a frozen install rebuilds every link, and the marker the caller
    // already wrote stays behind if that install fails, so startup recovery retries it.
    await this.runPnpm(projectDir, ['install', '--frozen-lockfile', '--ignore-scripts'])
    await this.finishPackageOperation(projectDir)
  }

  private async reconcileProfile(projectDir: string, previous: DesktopProfileState | undefined, packagesChanged = false): Promise<void> {
    const target = this.currentRuntime()
    const rebuild = (!packagesChanged && existsSync(this.pendingPackages))
      || (previous !== undefined && pluginRecords(projectDir).length > 0
      && (previous.nodeVersion !== target.release.nodeVersion || previous.platform !== target.platform || previous.arch !== target.arch))
    if (rebuild) {
      writeFileSync(this.pendingPackages, '')
      unlinkDesktopHostPackages(projectDir)
      removeOwnedDirectory(join(projectDir, 'node_modules'))
      await this.runPnpm(projectDir, ['install', '--frozen-lockfile', '--ignore-scripts'])
    }
    if (rebuild || packagesChanged) await this.finishPackageOperation(projectDir)
    else this.prepareProfile(projectDir)
  }

  private async finishPackageOperation(projectDir: string): Promise<void> {
    this.prepareProfile(projectDir)
    await this.runPnpm(projectDir, ['rebuild', '--pending'])
    this.prepareProfile(projectDir)
    unlinkSync(this.pendingPackages)
  }

  private async applyMutation(projectDir: string, mutation: Exclude<DesktopProjectMutation, { type: 'plugins-disable-all' }>): Promise<void> {
    switch (mutation.type) {
      case 'plugin-add': {
        const requestedName = packageNameFromSpec(mutation.spec)
        if (this.currentRuntime().sharedPackages.some(entry => entry.name === requestedName)) {
          throw new Error(`desktop project: cannot install host-owned package ${requestedName}`)
        }
        await this.runPnpm(projectDir, ['add', mutation.spec, '--save-exact', '--ignore-scripts'])
        const installed = { ...inspectPlugin(projectDir, requestedName), enabled: true }
        const current = pluginRecords(projectDir).filter(plugin => plugin.name !== installed.name)
        writeProfilePlugins(
          projectDir,
          [...current, installed].sort((left, right) => left.name.localeCompare(right.name)),
        )
        return
      }
      case 'plugin-remove': {
        assertPackageName(mutation.name)
        if (!Object.hasOwn(projectManifest(projectDir).dependencies, mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        const remaining = pluginRecords(projectDir).filter(plugin => plugin.name !== mutation.name)
        await this.runPnpm(projectDir, ['remove', mutation.name, '--config.ignore-scripts=true'])
        writeProfilePlugins(projectDir, remaining)
        return
      }
      case 'plugin-update':
        assertPackageName(mutation.name)
        assertVersion(mutation.version)
        if (!Object.hasOwn(projectManifest(projectDir).dependencies, mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        await this.runPnpm(projectDir, ['add', `${mutation.name}@${mutation.version}`, '--save-exact', '--ignore-scripts'])
        {
          const installed = inspectPlugin(projectDir, mutation.name)
          writeProfilePlugins(
            projectDir,
            pluginRecords(projectDir).map(plugin => plugin.name === installed.name ? installed : plugin),
          )
        }
        return
      case 'plugin-toggle': {
        assertPackageName(mutation.name)
        const plugins = pluginRecords(projectDir)
        if (!plugins.some(plugin => plugin.name === mutation.name)) throw new Error(`desktop project: plugin ${mutation.name} is not installed`)
        writeProfilePlugins(projectDir, plugins.map(plugin => (
          plugin.name === mutation.name ? { ...plugin, enabled: mutation.enabled } : plugin
        )))
        return
      }
      default:
        mutation satisfies never
    }
  }

  private async runPnpm(projectDir: string, args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop project: pnpm command is required')
    for (const path of [this.paths.root, this.paths.pnpm.store, this.paths.pnpm.cache,
      this.paths.pnpm.state, this.paths.pnpm.config, this.paths.pnpm.home]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    const npmrc = join(this.paths.pnpm.config, 'npmrc')
    if (!existsSync(npmrc)) writeFileSync(npmrc, '', { mode: 0o600 })
    const inherited = Object.fromEntries(Object.entries(this.environment).filter(([name]) => (
      name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    )))
    writeFileSync(this.pendingPackages, '')
    const lock = this.transactionLock
    if (lock === undefined) throw new Error('desktop project: package transaction lost its lock')
    await new Promise<void>((settle, reject) => {
      const child = spawn(this.runtime.node, [
        '--eval', `void (async () => { ${PACKAGE_WORKER_SOURCE} })()`, lock.workerPath, this.runtime.dsh,
        this.runtime.pnpm,
        `--config.registry=${DESKTOP_REGISTRY}`,
        `--config.store-dir=${this.paths.pnpm.store}`,
        '--config.enable-global-virtual-store=false',
        `--config.userconfig=${npmrc}`,
        command,
        ...commandArgs,
      ], {
        cwd: projectDir,
        env: {
          ...inherited,
          COREPACK_HOME: this.paths.pnpm.home,
          NPM_CONFIG_REGISTRY: DESKTOP_REGISTRY,
          NPM_CONFIG_STORE_DIR: this.paths.pnpm.store,
          NPM_CONFIG_USERCONFIG: npmrc,
          PATH: `${dirname(this.runtime.node)}${delimiter}${this.environment.PATH ?? ''}`,
          PNPM_HOME: this.paths.pnpm.home,
          XDG_CACHE_HOME: this.paths.pnpm.cache,
          XDG_CONFIG_HOME: this.paths.pnpm.config,
          XDG_STATE_HOME: this.paths.pnpm.state,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      })
      let failure: Error | undefined
      let diagnostics = ''
      let completed = false
      const appendDiagnostics = (chunk: string): void => {
        diagnostics = (diagnostics + chunk).slice(-MAX_PNPM_DIAGNOSTIC_BYTES)
      }
      // The IPC overload is nullable, but descriptors 1 and 2 above are pipes.
      for (const output of [child.stdout as Readable, child.stderr as Readable]) {
        output.setEncoding('utf8')
        output.on('data', appendDiagnostics)
      }
      const complete = (settleChild: () => void): void => {
        if (completed) return
        completed = true
        try {
          lock.worker(undefined)
        } catch (error) {
          reject(errorOf(error, 'desktop project: failed to return the package transaction lock to Electron'))
          return
        }
        settleChild()
      }
      child.once('error', (error) => { failure = error })
      child.once('close', (code, signal) => {
        complete(() => {
          if (failure !== undefined) { reject(failure); return }
          if (code === 0) {
            settle()
            return
          }
          reject(new Error(
            `desktop project: pnpm exited with ${String(code ?? signal)}${diagnostics.trim() === '' ? '' : `: ${diagnostics.trim()}`}`,
          ))
        })
      })
      child.once('message', (message: unknown) => {
        try {
          if (!isRecord(message) || message.type !== 'package-worker-ready' || child.pid === undefined) {
            throw new Error('desktop project: invalid package worker readiness')
          }
          lock.worker(child.pid)
          child.send({ type: 'run' }, (error) => {
            if (error === null) return
            failure = error
            child.kill('SIGKILL')
          })
        } catch (error) {
          failure = errorOf(error, 'desktop project: failed to grant the package transaction to pnpm')
          child.kill('SIGKILL')
        }
      })
    })
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    if (lstatSync(this.paths.profile).isSymbolicLink()) throw new Error('desktop project: profile directory must not be a link')
    const lock = await DesktopPackageLock.acquire(this.paths.lock, this.runtime.dsh)
    try {
      this.transactionLock = lock
      return await operation()
    } finally {
      this.transactionLock = undefined
      await lock.release()
    }
  }
}

/**
 * Create build-only project metadata for materializing the signed runtime.
 * @param projectDir - Build directory holding the verified package set.
 * @param release - Release identity bound to the packaged application.
 * @param hostProvidedPeers - Client-platform singletons the runtime must also
 *   materialize for plugins. They are pinned exactly and installed from the
 *   registry, because no core tarball supplies them and the Desktop runtime
 *   directory is their only home.
 */
export function createRuntimeProjectMetadata(
  projectDir: string,
  release: DesktopRelease,
  hostProvidedPeers: readonly { readonly name: string; readonly version: string }[] = [],
): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest: DesktopProjectManifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      ...desktopCorePackageOverrides(packageSet),
      ...Object.fromEntries(hostProvidedPeers.map(peer => [peer.name, peer.version])),
    },
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  writeJson(join(projectDir, 'package.json'), {
    name: PROJECT_NAME, private: true, version: '0.0.0', dependencies: {},
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  } satisfies DesktopProjectManifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}
