/**
 * Client-platform singletons the Desktop runtime provisions for external plugins.
 *
 * The renderer shell owns React: `@deepseek-ai/dsh-client-web` seeds a frozen
 * module table (`packages/client/web/src/seed.ts`) with the shell's own
 * `react`, `react/jsx-runtime`, `react-dom`, and `react-dom/client` instances,
 * and every plugin's browser half is built with exactly those specifiers
 * externalized (`PLATFORM_MODULES`, the single source of truth shared with the
 * tsdown client externals). A plugin therefore never carries its own React: its
 * client bundle resolves `react` from the shell's table, so hooks and context
 * cross the plugin boundary inside one instance.
 *
 * That ownership is a CLIENT-face fact, so neither profile installs React:
 * `dsh plugin --profile web add <plugin>` runs pnpm with
 * `autoInstallPeers: false` and a declared `peer react` stays unresolved on
 * disk. Web still loads such plugins because a web profile has no dependency
 * validation at all, while the Desktop profile admits a plugin only after
 * `validateDesktopPluginGraph` resolves every declared dependency and peer
 * against the profile or against a host-owned shared package. A plugin whose
 * graph declares a required `react` peer — `dsh-better-sidebar` directly, or
 * `dsh-web-all` through `@linxin666/dsh-client-ui-plugin-manager`, or any
 * package depending on `react-icons` — is therefore rejected on Desktop before
 * it can boot, with `requires missing react@…`.
 *
 * Provisioning those specifiers as release-owned runtime packages is the same
 * mechanism that already satisfies every other plugin peer: `@deepseek-ai/cordis`,
 * `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-settings` are peer-declared
 * by plugins, host-linked from the immutable runtime, and verified by identity
 * rather than installed into a profile.
 *
 * Linking the runtime copy does NOT introduce a second React instance in the
 * page. The linked tree is reachable from Node only; the renderer's React comes
 * from the frontend bundle, and plugin bundles reach it through the module
 * table's seed branch, which is consulted before any registered factory. The
 * version provisioned here is resolved from the renderer workspace package so
 * the runtime copy and the bundled copy cannot drift.
 *
 * @module @deepseek-ai/dsh-desktop/host-provided-peers
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Module specifiers the Desktop runtime provides to plugins as host-owned peers.
 *
 * Only specifiers the renderer shell actually seeds belong here. A name that no
 * shell instance backs would let a plugin pass profile validation and then fail
 * at runtime instead, which is the failure this list exists to prevent.
 */
export const DESKTOP_HOST_PROVIDED_PEERS = ['react', 'react-dom'] as const

/** One provisioned peer specifier. */
export type DesktopHostProvidedPeer = (typeof DESKTOP_HOST_PROVIDED_PEERS)[number]

/** Exact name and version of one provisioned peer. */
export interface DesktopHostProvidedPeerRecord {
  /** Package name, e.g. `react`. */
  readonly name: DesktopHostProvidedPeer
  /** Exact version materialized into the runtime and recorded as shared. */
  readonly version: string
}

/**
 * Read the exact versions the renderer bundles, from the renderer's own resolution.
 *
 * Resolving through the renderer package is deliberate: it is the workspace
 * package whose build inlines these instances into the shell bundle, so the
 * version pinned into the runtime is by construction the version the page runs.
 * Duplicating a version literal here would let the two drift silently.
 * @param rendererPackageDir - Absolute directory of the renderer workspace package (`apps/web`).
 * @returns One record per provisioned peer, in declaration order.
 * @throws When a declared peer cannot be resolved or carries no usable version.
 */
export function resolveDesktopHostProvidedPeers(
  rendererPackageDir: string,
): readonly DesktopHostProvidedPeerRecord[] {
  const require = createRequire(join(rendererPackageDir, 'package.json'))
  return DESKTOP_HOST_PROVIDED_PEERS.map((name) => {
    let manifestPath: string
    try {
      manifestPath = require.resolve(`${name}/package.json`)
    } catch (error) {
      throw new Error(`desktop host-provided peer: ${name} is not installed for the renderer (${rendererPackageDir}): ${String(error)}`)
    }
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error(`desktop host-provided peer: ${manifestPath} is not a package manifest`)
    }
    const version = (manifest as { version?: unknown }).version
    if (typeof version !== 'string' || version === '') {
      throw new Error(`desktop host-provided peer: ${name} has no version in ${manifestPath}`)
    }
    return { name, version }
  })
}
