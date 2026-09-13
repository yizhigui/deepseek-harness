#!/usr/bin/env node
/**
 * Build add-on desktop artifacts from an application directory that the official packaging command
 * already prepared.
 *
 * This intentionally does not rerun the official build. `apps/desktop/scripts/package-target.ts`
 * owns repo compilation, runtime preparation, and the `extraResources` tree; feeding its
 * `win-unpacked` output to electron-builder with `--prepackaged` keeps this script additive and
 * fast, and keeps the official runtime verification (`afterPack`) in effect.
 *
 * @module @deepseek-ai/dsh-desktop-portable/package-portable
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_BUILDER_CACHE,
  DESKTOP_DIST_ROOT,
  REPOSITORY_ROOT,
  resolveElectronBuilderCli,
} from './portable-targets.mjs'

const ADDON_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop-portable')
const DESKTOP_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop')

/**
 * Invoke electron-builder through the same dependency instance `apps/desktop` resolves.
 *
 * Calling the resolved CLI with the current Node.js avoids depending on a shell shim, on
 * `pnpm exec`, or on a second electron-builder installation inside this add-on.
 * @param args - Arguments for the electron-builder CLI.
 * @param environment - Packaging environment.
 * @param workdir - Working directory for the electron-builder process.
 * @returns Resolves on exit code 0.
 */
function runElectronBuilder(args, environment, workdir) {
  return run(process.execPath, [resolveElectronBuilderCli(), ...args], { cwd: workdir, env: environment })
}

/**
 * Run one command, inheriting stdio so electron-builder's progress stays visible.
 * @param command - Executable to run.
 * @param args - Arguments for the executable.
 * @param options - Optional working directory and environment overrides.
 * @returns Resolves on exit code 0.
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ADDON_ROOT,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop portable: ${command} ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * Packaging environment for the add-on targets.
 *
 * `DSH_DESKTOP_APP_ID` stays required by the official configuration and is never defaulted here, so
 * the packaged identity is always the caller's explicit choice. `ELECTRON_BUILDER_CACHE` is
 * redirected onto the build volume because electron-builder extracts each downloaded toolset into a
 * temporary sibling and renames it into place, which fails with `EXDEV` across volumes.
 * `DSH_DESKTOP_LOG_DIR` is exported for builds and for the shell's optional override; the packaged
 * application also defaults to the same directory on its own.
 * @param environment - Base environment.
 * @returns The environment for electron-builder.
 */
export function createPackageEnvironment(environment = process.env) {
  return {
    ...environment,
    DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_UNSIGNED: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    // The bundled NSIS decoder cannot extract 7-Zip's automatic ARM64-filtered entries.
    ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
    ELECTRON_BUILDER_CACHE: DESKTOP_BUILDER_CACHE,
    DSH_DESKTOP_LOG_DIR: defaultLogDirectory(environment),
  }
}

/**
 * Resolve the directory the packaged shell writes `desktop.log` into.
 * @param environment - Base environment carrying `APPDATA`.
 * @returns Absolute log directory, or undefined when `APPDATA` is unavailable.
 */
export function defaultLogDirectory(environment = process.env) {
  const appData = environment.APPDATA
  return appData === undefined || appData.trim() === ''
    ? undefined
    : join(appData, 'DeepSeekHarness', 'logs')
}

/**
 * Parse the add-on command line.
 * @param argv - Arguments after the script path.
 * @returns Target name and the requested build scope.
 */
export function parseArguments(argv) {
  const positionals = argv.filter(argument => !argument.startsWith('--'))
  const programmatic = argv.filter(argument => argument.startsWith('--config.'))
  const flags = new Set(argv.filter(argument => argument.startsWith('--') && !argument.startsWith('--config.')))
  if (positionals.length > 1) throw new Error('desktop portable: expected at most one target')
  const target = positionals[0] ?? 'win-x64'
  if (target !== 'win-x64') throw new Error(`desktop portable: unsupported target ${JSON.stringify(target)}; expected win-x64`)
  return {
    target,
    portableOnly: flags.has('--portable-only'),
    // Re-emit only the friendly-name copies from artifacts an earlier run already produced.
    skipElectronBuilder: flags.has('--aliases-only'),
    programmatic,
  }
}

/**
 * Absolute paths for one target's prepared and produced artifacts.
 * @param target - Validated target name.
 * @returns Input application directory and output artifact directory.
 */
export function targetPaths(target) {
  const key = target === 'win-x64' ? 'win-x64' : target
  return {
    application: join(DESKTOP_ROOT, '.desktop-build', 'targets', key, 'unsigned-artifacts', 'win-unpacked'),
    output: DESKTOP_DIST_ROOT,
  }
}

/**
 * Copy an electron-builder artifact to an additional, friendlier user-facing name.
 *
 * electron-builder always names the NSIS installer `${productName}-${version}-setup.${ext}`, so the
 * canonical name is `deepseek-harness-<version>-win-x64.exe`. The aliases below are copies, never
 * renames: a published release keeps the canonical electron-builder names so its own metadata and
 * differential block map keep resolving.
 * @param directory - Directory holding the built artifacts.
 * @param version - Desktop/dsh version string.
 * @returns Absolute paths of the aliases that were written.
 */
export function writeArtifactAliases(directory, version) {
  const aliases = [
    {
      from: join(directory, `deepseek-harness-${version}-win-x64.exe`),
      to: join(directory, `DeepSeek-Harness-Setup-${version}.exe`),
    },
    {
      from: join(directory, `deepseek-harness-${version}-win-x64-portable.exe`),
      to: join(directory, `DeepSeek-Harness-${version}-portable.exe`),
    },
  ]
  const written = []
  for (const alias of aliases) {
    if (!existsSync(alias.from)) continue
    copyFileSync(alias.from, alias.to)
    written.push(alias.to)
  }
  return written
}

/**
 * Read the desktop package version that the packaged runtime is bound to.
 * @returns Version string from the official desktop package manifest.
 */
export function desktopVersion() {
  const manifest = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('desktop portable: apps/desktop/package.json has no version')
  }
  return manifest.version
}

async function main() {
  const { target, portableOnly, skipElectronBuilder, programmatic } = parseArguments(process.argv.slice(2))
  const { application, output } = targetPaths(target)
  if (!existsSync(join(application, 'DeepSeek Harness.exe'))) {
    throw new Error(`desktop portable: no packaged application at ${application}; run "pnpm run package:desktop:win:x64:unsigned" first`)
  }
  mkdirSync(DESKTOP_BUILDER_CACHE, { recursive: true })
  mkdirSync(output, { recursive: true })
  const environment = createPackageEnvironment()
  const configPath = join(ADDON_ROOT, 'portable.config.mjs')
  // --prepackaged repacks the verified application tree instead of rebuilding or re-preparing it.
  const args = [
    '--config',
    configPath,
    '--win',
    ...(portableOnly ? ['portable'] : ['nsis', 'portable']),
    '--x64',
    '--publish',
    'never',
    '--prepackaged',
    application,
    '--config.directories.output',
    output,
    ...programmatic,
  ]
  console.log(`desktop portable: packaging ${application} -> ${output}`)
  if (!skipElectronBuilder) await runElectronBuilder(args, environment, DESKTOP_ROOT)
  for (const alias of writeArtifactAliases(output, desktopVersion())) {
    console.log(`desktop portable: wrote ${alias}`)
  }
  console.log(`desktop portable: artifacts written to ${output}`)
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
