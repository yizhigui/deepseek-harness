/**
 * Desktop provisioning of the renderer shell's platform modules.
 *
 * The shell owns a frozen module table: `packages/client/web/src/seed.ts`
 * statically imports the instances the shell bundle inlines, and
 * `packages/client/web/src/platform.ts` (`PLATFORM_MODULES`) is the single
 * source of truth for the specifiers that table answers — the same list the
 * tsdown client externals build plugin bundles against. A plugin's browser half
 * therefore never ships React or the shell's UI packages: `require` for one of
 * those specifiers is answered by the seed branch of the client module system
 * (`packages/client/modules/src/client/system.ts`), which is consulted before
 * any registered factory, so hooks and context cross the plugin boundary inside
 * one instance.
 *
 * That ownership is a CLIENT-face fact, so no profile installs these packages:
 * `dsh plugin --profile <name> add <plugin>` runs pnpm with
 * `autoInstallPeers: false`, and a declared `peer react` stays unresolved on
 * disk. Web still loads such plugins because a web profile has no dependency
 * validation, while a Desktop profile admits a plugin only after
 * `validateDesktopPluginGraph` resolves every declared dependency and peer
 * against the profile or against a host-owned shared package. A plugin whose
 * graph declares a required platform peer — `dsh-better-sidebar` (React through
 * `react-icons`, `@deepseek-ai/dsh-client-ui-primitives` directly),
 * `@linxin666/dsh-web-all` (React through `@linxin666/dsh-client-ui-plugin-manager`),
 * anything depending on `lucide-react`, `tldraw`, `@xyflow/react`, or `sonner` —
 * is therefore rejected on Desktop before it can boot.
 *
 * This module turns that list into the provisioning plan the Desktop build
 * executes, without restating the list itself:
 *
 *  - `closure-root`: a first-party package the release `dsh` pack already
 *    publishes as a tarball. It joins {@link selectDesktopPackageClosure}, so it
 *    reaches the runtime through the same packed artifacts as every other core
 *    package and needs no registry access at build time.
 *  - `registry-peer`: an external package the renderer bundles. It has no
 *    tarball in the pack, so the build pins it from the renderer's own resolved
 *    version and installs it into the runtime beside the core packages.
 *  - `inherited-subpath`: a subpath of another entry (`react/jsx-runtime`).
 *    Node resolution answers it from the parent package's directory, so it must
 *    never become a link of its own — `profile-packages.ts` links a shared
 *    entry at `node_modules/<name>`, which a specifier with a slash cannot be.
 *
 * Whatever the origin, the runtime copy stays Node-only. It exists so peer
 * resolution and host-side `import` succeed and so the validator can compare
 * identity; the renderer still reaches the shell's single instance through the
 * module table, and the scan that turns installed packages into client bundles
 * is Loader-entry driven, so a merely-provisioned package is never served as a
 * bundle either.
 *
 * @module @deepseek-ai/dsh-desktop/platform-peers
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PLATFORM_MODULES, type PlatformModule } from '@deepseek-ai/dsh-client-web/src/platform.ts'

/** How one platform specifier reaches the Desktop runtime. */
export type PlatformPeerProvisioning =
  /** First-party release package: joins the packed core closure. */
  | 'closure-root'
  /** External package: pinned from the renderer and installed into the runtime. */
  | 'registry-peer'
  /** Subpath of another entry: satisfied by that entry's package directory. */
  | 'inherited-subpath'

/** One classified platform specifier. */
export interface PlatformPeerRecord {
  /** The specifier exactly as the renderer's module table spells it. */
  readonly specifier: PlatformModule
  /** Package that owns the specifier; a subpath resolves to its parent. */
  readonly packageName: string
  /** How the Desktop runtime makes this specifier resolvable. */
  readonly provisioning: PlatformPeerProvisioning
}

/** Package name of a specifier, collapsing `pkg/sub` to `pkg`. */
function owningPackage(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier
  const [scope, name] = specifier.split('/')
  return name === undefined ? specifier : `${scope}/${name}`
}

/** First-party scope the release pack ships; everything else comes from the registry. */
const FIRST_PARTY_SCOPE = '@deepseek-ai/'

/**
 * Classification of every platform specifier.
 *
 * The LIST is never restated here: {@link platformPeerRecords} derives it from
 * {@link PLATFORM_MODULES}, and `platform-peers.spec.ts` fails if a specifier
 * gains no classification or a classification outlives its specifier.
 */
const PROVISIONING: Readonly<Record<string, PlatformPeerProvisioning>> = {
  'react': 'registry-peer',
  'react-dom': 'registry-peer',
  // Subpaths of the two entries above. The shell seeds them from the same
  // package directory Node resolves them from, so nothing extra is provisioned.
  'react/jsx-runtime': 'inherited-subpath',
  'react-dom/client': 'inherited-subpath',
  // First-party packages: the release `dsh` pack publishes each one, and the
  // shell seeds them from the bundle rather than from a profile install.
  '@deepseek-ai/cordis': 'closure-root',
  '@deepseek-ai/dsh-client-store': 'closure-root',
  '@deepseek-ai/dsh-client-ui-slots': 'closure-root',
  '@deepseek-ai/dsh-client-ui-primitives': 'closure-root',
  '@deepseek-ai/dsh-client-ui-dockkit': 'closure-root',
}

/**
 * Every platform specifier with its provisioning.
 * @returns One record per {@link PLATFORM_MODULES} entry, in that order.
 * @throws When a specifier carries no classification, or a subpath names a package no entry provides.
 */
export function platformPeerRecords(): readonly PlatformPeerRecord[] {
  const records = PLATFORM_MODULES.map((specifier): PlatformPeerRecord => {
    const provisioning = PROVISIONING[specifier]
    if (provisioning === undefined) {
      throw new Error(`desktop platform peers: ${JSON.stringify(specifier)} is in PLATFORM_MODULES but has no provisioning classification`)
    }
    const packageName = owningPackage(specifier)
    if (provisioning === 'inherited-subpath' && !PLATFORM_MODULES.includes(packageName as PlatformModule)) {
      throw new Error(`desktop platform peers: ${JSON.stringify(specifier)} is a subpath of ${JSON.stringify(packageName)}, which no platform entry provides`)
    }
    if (provisioning !== 'inherited-subpath' && packageName !== specifier) {
      throw new Error(`desktop platform peers: ${JSON.stringify(specifier)} is a subpath but is not classified as one`)
    }
    if (provisioning === 'closure-root' && !packageName.startsWith(FIRST_PARTY_SCOPE)) {
      throw new Error(`desktop platform peers: ${JSON.stringify(specifier)} is not a first-party package, so no release tarball supplies it`)
    }
    if (provisioning === 'registry-peer' && packageName.startsWith(FIRST_PARTY_SCOPE)) {
      throw new Error(`desktop platform peers: ${JSON.stringify(specifier)} is first-party, so it belongs in the packed closure`)
    }
    return { specifier, packageName, provisioning }
  })
  return records
}

/**
 * First-party platform packages the core closure must include, deduplicated.
 *
 * Adding a package the closure already reaches is harmless: closure selection is
 * keyed by name.
 * @returns Package names to add as extra closure roots, sorted.
 */
export function platformClosureRoots(): readonly string[] {
  const names = new Set(
    platformPeerRecords()
      .filter(record => record.provisioning === 'closure-root')
      .map(record => record.packageName),
  )
  return [...names].sort()
}

/**
 * External platform packages the runtime must carry, with exact versions.
 * @param rendererPackageDir - Absolute directory of the renderer workspace package (`apps/web`).
 * @returns One name/version pair per registry peer, in declaration order.
 * @throws When a package cannot be resolved from the renderer or carries no version.
 */
export function platformRegistryPeers(
  rendererPackageDir: string,
): readonly { readonly name: string; readonly version: string }[] {
  const require = createRequire(join(rendererPackageDir, 'package.json'))
  const names = [...new Set(
    platformPeerRecords()
      .filter(record => record.provisioning === 'registry-peer')
      .map(record => record.packageName),
  )]
  return names.map((name) => {
    let manifestPath: string
    try {
      manifestPath = require.resolve(`${name}/package.json`)
    } catch (error) {
      throw new Error(`desktop platform peers: ${name} is not installed for the renderer (${rendererPackageDir}): ${String(error)}`)
    }
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error(`desktop platform peers: ${manifestPath} is not a package manifest`)
    }
    const version = (manifest as { version?: unknown }).version
    if (typeof version !== 'string' || version === '') {
      throw new Error(`desktop platform peers: ${name} has no version in ${manifestPath}`)
    }
    return { name, version }
  })
}
