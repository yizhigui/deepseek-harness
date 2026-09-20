/** Materialize the complete production runtime before publishing Desktop resources. */

import { spawn, execFile } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokeDesktopRuntime } from './smoke-runtime.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { platformClosureRoots, platformRegistryPeers } from '../src/platform-peers.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const RENDERER_ROOT = resolve(APP_ROOT, '..', 'web')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
const STORE_ROOT = join(BUILD_ROOT, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(RUNTIME_ROOT, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      PNPM,
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        PATH: `${dirname(NODE)}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

async function main(): Promise<void> {
  rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
  rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  try {
    const release = desktopRelease()
    // Resolved before the runtime is materialized: the renderer's own installed
    // versions are the ones its bundle inlines, so these entries are what a
    // plugin's client face actually executes against. First-party platform
    // packages need no resolution here 鈥?they already arrive inside the packed
    // core closure (`prepare-package-set.ts` adds them as closure roots).
    console.log(`desktop runtime: platform closure roots ${platformClosureRoots().join(', ')}`)
    const platformPeers = platformRegistryPeers(RENDERER_ROOT)
    console.log(`desktop runtime: registry platform peers ${platformPeers.map(peer => `${peer.name}@${peer.version}`).join(', ')}`)
    copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
    createRuntimeProjectMetadata(BUILD_ROOT, release, platformPeers)
    await runPnpm(['install', '--lockfile-only'])
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile'])
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: targetName.endsWith('arm64') ? 'arm64' : 'x64' }
    const modules = join(BUILD_ROOT, 'node_modules')
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
      recursive: true, dereference: true,
      filter: source => desktopRuntimeFileExclusion(relative(modules, source), target) === undefined,
    })
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: {
        ...Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
        ...Object.fromEntries(platformPeers.map(peer => [peer.name, peer.version])),
      },
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    // Share a peer only once it is provably on disk: an entry recorded without a
    // materialized package would link a broken junction into every profile and
    // admit a plugin whose peer nothing satisfies.
    for (const peer of platformPeers) {
      const manifestPath = join(DSH_OUTPUT_ROOT, 'node_modules', peer.name, 'package.json')
      if (!existsSync(manifestPath)) throw new Error(`desktop runtime: host-provided peer ${peer.name}@${peer.version} was not materialized`)
      const materialized = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
      if (materialized.version !== peer.version) {
        throw new Error(`desktop runtime: host-provided peer ${peer.name} materialized as ${String(materialized.version)}, expected ${peer.version}`)
      }
    }
    if (process.platform === 'darwin') {
      await signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env))
    }
    writeDesktopRuntime(
      DSH_OUTPUT_ROOT, release,
      [...packageSet.packages.map(entry => entry.name), ...platformPeers.map(peer => peer.name)],
      target,
    )
    const descriptor = await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
    await new Promise<void>((accept, reject) => {
      execFile(NODE, [join(APP_ROOT, 'tests/fixtures/runtime-payload-smoke.mjs'), DSH_OUTPUT_ROOT],
        { timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } }, (error, stdout, stderr) => {
          if (error !== null) reject(new Error(`desktop native payload smoke failed: ${stderr}`, { cause: error }))
          else { process.stdout.write(stdout); accept() }
        })
    })
    await smokeDesktopRuntime(DSH_OUTPUT_ROOT, NODE, descriptor)
    await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(BUILD_ROOT, { recursive: true, force: true })
    rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  }
}

await main()
