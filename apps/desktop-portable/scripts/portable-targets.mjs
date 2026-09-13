/**
 * Additive electron-builder targets for the official DeepSeek Harness desktop shell.
 *
 * The official configuration factory stays the single source of truth: this module imports it and
 * appends a `portable` target, then redirects the artifact directory to `dist-desktop/`. Nothing in
 * the official shell or its packaging pipeline is copied or replaced.
 *
 * @module @deepseek-ai/dsh-desktop-portable/portable-targets
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADDON_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(ADDON_ROOT, '..', '..')
const DESKTOP_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop')

/** Shared build root of the official desktop target, relative to the repository. */
export const DESKTOP_BUILD_ROOT = join(DESKTOP_ROOT, '.desktop-build')

/** Directory the add-on writes installers into, relative to the repository. */
export const DESKTOP_DIST_ROOT = join(REPOSITORY_ROOT, 'dist-desktop')

/** Where electron-builder keeps its downloaded toolsets for add-on builds. */
export const DESKTOP_BUILDER_CACHE = join(DESKTOP_BUILD_ROOT, 'downloads', 'electron-builder-cache')

/**
 * Load the official electron-builder configuration factory.
 *
 * The official module is TypeScript-free ESM executed by the same Node.js that runs this script, so
 * it is imported directly rather than reimplemented.
 * @returns The official `createElectronBuilderConfig` factory.
 */
export async function loadOfficialConfigFactory() {
  const module = await import(new URL('../../desktop/electron-builder.config.mjs', import.meta.url))
  if (typeof module.createElectronBuilderConfig !== 'function') {
    throw new Error('desktop portable: apps/desktop/electron-builder.config.mjs no longer exports createElectronBuilderConfig')
  }
  return module.createElectronBuilderConfig
}

/**
 * Build the configuration used by the add-on targets.
 *
 * `env` must already carry `DSH_DESKTOP_TARGET_PLATFORM=win32`, `DSH_DESKTOP_TARGET_ARCH=x64`, and
 * `DSH_DESKTOP_UNSIGNED=1`; this function only layers the extra target, its distinct artifact name,
 * the artifact directory, and the same-volume tool cache on top of the official configuration.
 *
 * The portable target shares the default `${productName}-${version}-setup.${ext}` name with the NSIS
 * installer, so both targets would otherwise write one file and the second would silently overwrite
 * the first. A distinct `portable.artifactName` keeps both artifacts.
 * @param environment - Packaging environment, normally `process.env`.
 * @returns electron-builder configuration with NSIS plus portable targets.
 */
export async function createPortableConfig(environment = process.env) {
  const createElectronBuilderConfig = await loadOfficialConfigFactory()
  const official = createElectronBuilderConfig(environment)
  const windowsTargets = official.win?.target
  if (!Array.isArray(windowsTargets) || !windowsTargets.includes('nsis')) {
    throw new Error('desktop portable: the official Win target no longer includes nsis')
  }
  return {
    ...official,
    directories: { ...official.directories, output: DESKTOP_DIST_ROOT },
    // electron-builder replaces this array instead of merging it, so the official target is restated.
    win: { ...official.win, target: [...windowsTargets, 'portable'] },
    portable: {
      ...official.portable,
      artifactName: 'deepseek-harness-${version}-win-x64-portable.${ext}',
    },
  }
}

/**
 * Locate the electron-builder CLI entry that `apps/desktop` resolves.
 *
 * The add-on reuses the official dependency instance rather than installing a second one.
 * @returns Absolute path of electron-builder's CLI script.
 */
export function resolveElectronBuilderCli() {
  const require = createRequire(join(DESKTOP_ROOT, 'package.json'))
  return require.resolve('electron-builder/out/cli/cli.js')
}

export { ADDON_ROOT, DESKTOP_ROOT, REPOSITORY_ROOT }
