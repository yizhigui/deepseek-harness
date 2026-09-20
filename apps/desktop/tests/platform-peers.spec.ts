/**
 * Desktop provisioning of the renderer shell's platform modules.
 *
 * Reproduces the shipped failures (`dsh-better-sidebar -> react-icons requires
 * missing react@*`, `@linxin666/dsh-web-all -> @linxin666/dsh-client-ui-plugin-manager
 * requires missing react@^18.2.0`, `... requires missing
 * @deepseek-ai/dsh-client-ui-primitives@^0.1.5-rc.1`) and proves that the
 * platform provisioning admits those graphs without introducing a second React
 * instance into the page.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { satisfies } from 'semver'
import { PLATFORM_MODULES } from '@deepseek-ai/dsh-client-web/src/platform.ts'
import { getStaticModules } from '@deepseek-ai/dsh-client-web/src/seed.ts'
import {
  platformClosureRoots, platformPeerRecords, platformRegistryPeers,
} from '../src/platform-peers.ts'
import { selectDesktopPackageClosure, type PackedDesktopPackage } from '../scripts/prepare-package-set.ts'
import { linkDesktopHostPackages, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

/** Version the renderer's bundle carries; peers must be satisfiable against it. */
const REACT_VERSION = '18.3.1'
/** The client platform packages ship on the harness version line. */
const CLIENT_PLATFORM_VERSION = '0.1.5-rc.2'

const RENDERER_ROOT = resolve(import.meta.dirname, '..', '..', 'web')
/** The package that owns the seed table, and therefore resolves every platform module. */
const SEED_ROOT = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'client', 'web')

/** React and ReactDOM only: the renderer's registry peers. */
const REGISTRY_PEERS = [
  { name: 'react', version: REACT_VERSION },
  { name: 'react-dom', version: REACT_VERSION },
] as const
/** Registry peers plus one first-party client platform package (the sidebar's second failure). */
const ALL_PLATFORM_PACKAGES = [
  ...REGISTRY_PEERS,
  { name: '@deepseek-ai/dsh-client-ui-primitives', version: CLIENT_PLATFORM_VERSION },
] as const

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * Profile fixture whose runtime carries the named platform packages.
 * @param packages - Platform packages materialized into the runtime and sealed as shared.
 * @returns The runtime root, its descriptor, and a linked profile.
 */
function fixture(packages: readonly { readonly name: string; readonly version: string }[]) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-platform-peer-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  // `exports: undefined` drops the fixture's entry map, so `react/package.json`
  // stays resolvable exactly as the published package allows.
  for (const entry of packages) writePackage(join(dsh, 'node_modules'), entry.name, { version: entry.version, exports: undefined })
  const runtime = runtimeFixture(dsh, '1.0.0', '24.17.0', packages.map(entry => entry.name))
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, dsh, runtime)
  return { dsh, runtime, profile }
}

/** Package manifest fixture for closure selection. */
function packed(
  name: string,
  dependencies: Record<string, string> = {},
  peerDependencies: Record<string, string> = {},
): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', dependencies, peerDependencies } }
}

// ---------------------------------------------------------------- single source

it('derives every platform peer from PLATFORM_MODULES and classifies each one', () => {
  const records = platformPeerRecords()
  expect(records.map(record => record.specifier)).toEqual([...PLATFORM_MODULES])
  for (const record of records) expect(record.packageName).not.toBe('')
})

it('seeds exactly the classified specifiers into the shell module table', () => {
  // The seed table is what a plugin's `require` actually hits; a specifier the
  // table does not answer would fail at runtime even with a runtime package.
  expect(Object.keys(getStaticModules()).sort()).toEqual([...PLATFORM_MODULES].sort())
})

it('classifies only real packages as provisionable and collapses subpaths', () => {
  const bySpecifier = new Map(platformPeerRecords().map(record => [record.specifier, record]))
  expect(bySpecifier.get('react')).toMatchObject({ packageName: 'react', provisioning: 'registry-peer' })
  expect(bySpecifier.get('react-dom')).toMatchObject({ packageName: 'react-dom', provisioning: 'registry-peer' })
  expect(bySpecifier.get('react/jsx-runtime')).toMatchObject({ packageName: 'react', provisioning: 'inherited-subpath' })
  expect(bySpecifier.get('react-dom/client')).toMatchObject({ packageName: 'react-dom', provisioning: 'inherited-subpath' })
  expect(bySpecifier.get('@deepseek-ai/dsh-client-ui-primitives'))
    .toMatchObject({ packageName: '@deepseek-ai/dsh-client-ui-primitives', provisioning: 'closure-root' })
  // A subpath is never its own runtime link: profile-packages links a shared
  // entry at node_modules/<name>, which a specifier containing "/" cannot be.
  for (const record of platformPeerRecords()) {
    if (record.provisioning === 'inherited-subpath') expect(record.packageName).not.toBe(record.specifier)
  }
})

it('plans the first-party platform packages as packed closure roots only', () => {
  expect(platformClosureRoots()).toEqual([
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-dockkit',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-slots',
  ])
})

// ---------------------------------------------------------------- runtime closure

it('adds the platform packages to the packed closure', () => {
  // The real pack carries the first-party platform packages and no registry
  // package at all, so `react` cannot enter the closure this way.
  const available = new Map<string, PackedDesktopPackage>([
    ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ['@deepseek-ai/dsh-client-ui-primitives', packed('@deepseek-ai/dsh-client-ui-primitives', {}, { react: '^18.2.0' })],
    ['@deepseek-ai/dsh-client-ui-slots', packed('@deepseek-ai/dsh-client-ui-slots')],
    ['@deepseek-ai/dsh-client-ui-dockkit', packed('@deepseek-ai/dsh-client-ui-dockkit')],
    ['@deepseek-ai/dsh-client-store', packed('@deepseek-ai/dsh-client-store')],
    ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
  ])
  const baseline = selectDesktopPackageClosure(available).map(entry => entry.manifest.name)
  expect(baseline).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  const selected = selectDesktopPackageClosure(available, platformClosureRoots()).map(entry => entry.manifest.name)
  for (const name of platformClosureRoots()) expect(selected).toContain(name)
  expect(selected).not.toContain('react')
})

it('refuses a platform closure root the pack does not carry', () => {
  const available = new Map<string, PackedDesktopPackage>([
    ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
  ])
  expect(() => selectDesktopPackageClosure(available, ['@deepseek-ai/dsh-client-ui-primitives']))
    .toThrow(/packed inputs omit platform package/u)
})

// ---------------------------------------------------------------- versions

it('pins the registry peers to the versions the renderer bundles', () => {
  const peers = platformRegistryPeers(RENDERER_ROOT)
  expect(peers.map(peer => peer.name)).toEqual(['react', 'react-dom'])
  expect(peers.find(peer => peer.name === 'react')?.version).toBe(REACT_VERSION)
  expect(peers.find(peer => peer.name === 'react-dom')?.version).toBe(REACT_VERSION)
  // One React ships in the shell, so the DOM renderer must accept that instance.
  const require = createRequire(join(RENDERER_ROOT, 'package.json'))
  const manifest = JSON.parse(readFileSync(require.resolve('react-dom/package.json'), 'utf8')) as { peerDependencies?: Record<string, string> }
  expect(satisfies(REACT_VERSION, manifest.peerDependencies?.react ?? '*')).toBe(true)
})

// ---------------------------------------------------------------- peer admission

it('admits the shipped sidebar graph once the platform packages are provisioned', () => {
  const { dsh, runtime, profile } = fixture(ALL_PLATFORM_PACKAGES)
  writePackage(join(profile, 'node_modules'), 'react-icons', { peerDependencies: { react: '*' } })
  writePackage(join(profile, 'node_modules'), '@deepseek-ai/dsh-client-ui-primitives', { version: CLIENT_PLATFORM_VERSION })
  writePackage(join(profile, 'node_modules'), 'sidebar', {
    peerDependencies: {
      react: '^18.2.0', 'react-dom': '^18.2.0', '@deepseek-ai/dsh-client-ui-primitives': '^0.1.5-rc.1',
    },
    dependencies: { 'react-icons': '5.7.0' },
  })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['sidebar']) }).not.toThrow()
})

it('admits the shipped web-all graph through its plugin-manager dependency', () => {
  const { dsh, runtime, profile } = fixture(REGISTRY_PEERS)
  writePackage(join(profile, 'node_modules'), 'ui-plugin-manager', { peerDependencies: { react: '^18.2.0' } })
  writePackage(join(profile, 'node_modules'), 'web-all', { dependencies: { 'ui-plugin-manager': '1.0.0' } })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['web-all']) }).not.toThrow()
})

it('keeps rejecting a missing non-platform peer', () => {
  const { dsh, runtime, profile } = fixture(REGISTRY_PEERS)
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { 'some-nonexistent-peer': '^1.0.0' } })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) })
    .toThrow(/plugin requires missing some-nonexistent-peer@\^1\.0\.0/u)
})

it('keeps rejecting a host-owned package declared as an ordinary dependency', () => {
  const { dsh, runtime, profile } = fixture(REGISTRY_PEERS)
  writePackage(join(profile, 'node_modules'), 'plugin', { dependencies: { react: REACT_VERSION } })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) })
    .toThrow(/must declare react as a peer dependency/u)
})

// ---------------------------------------------------------------- semver

it.each([
  ['^18.2.0', true],
  ['^18.3.1', true],
  ['*', true],
  ['>=18', true],
  ['^18.0.0 || ^19.0.0', true],
  ['^19.0.0', false],
  ['>=19', false],
])('answers a plugin that requires react %s with %s', (range, admitted) => {
  const { dsh, runtime, profile } = fixture(REGISTRY_PEERS)
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { react: range } })
  const run = (): void => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }
  if (admitted) expect(run).not.toThrow()
  else expect(run).toThrow(/requires react@/u)
})

// ---------------------------------------------------------------- singleton

it('resolves React to the single host-owned instance for the plugin and its dependency', () => {
  const { dsh, profile } = fixture(REGISTRY_PEERS)
  writePackage(join(profile, 'node_modules'), 'react-icons', { peerDependencies: { react: '*' } })
  const plugin = writePackage(join(profile, 'node_modules'), 'sidebar', {
    peerDependencies: { react: '^18.2.0' }, dependencies: { 'react-icons': '5.7.0' },
  })
  const hostReact = realpathSync.native(join(dsh, 'node_modules', 'react'))
  const fromPlugin = realpathSync.native(resolve(createRequire(join(plugin, 'package.json')).resolve('react/package.json'), '..'))
  const fromIconDependency = realpathSync.native(resolve(
    createRequire(join(profile, 'node_modules', 'react-icons', 'package.json')).resolve('react/package.json'), '..',
  ))
  expect(fromPlugin).toBe(hostReact)
  expect(fromIconDependency).toBe(hostReact)
})

it('provisions no package that could become a second client bundle', () => {
  // The client module scan is Loader-entry driven, so a package that is only
  // linked is never served as a bundle. Platform packages must therefore carry
  // no `dsh.client` declaration at all — a linked copy could not double-mount.
  const require = createRequire(join(SEED_ROOT, 'package.json'))
  for (const record of platformPeerRecords()) {
    const manifest = JSON.parse(readFileSync(require.resolve(`${record.packageName}/package.json`), 'utf8')) as { dsh?: { client?: unknown } }
    expect(manifest.dsh?.client).toBeUndefined()
  }
})

it('keeps the seeded React instance the one the renderer resolves', () => {
  // The seed holds the shell's own static import; identity therefore follows
  // from module resolution, and the runtime copy can only ever be a second
  // on-disk artifact for Node, never a second instance for the page.
  const require = createRequire(join(RENDERER_ROOT, 'package.json'))
  const seeded = getStaticModules().react as { version?: string }
  const resolved = JSON.parse(readFileSync(require.resolve('react/package.json'), 'utf8')) as { version: string }
  expect(seeded.version).toBe(resolved.version)
})

it('writes a manifest the profile can link without a duplicate name', () => {
  const { profile } = fixture(REGISTRY_PEERS)
  const state = JSON.parse(readFileSync(join(profile, 'desktop-runtime-state.json'), 'utf8')) as { links: { name: string }[] }
  const names = state.links.map(link => link.name)
  expect(new Set(names).size).toBe(names.length)
  expect(names).toContain('react')
  expect(names).toContain('react-dom')
  expect(names).not.toContain('react/jsx-runtime')
})

it('records the provisioned peers in the sealed runtime descriptor', () => {
  const { runtime } = fixture(REGISTRY_PEERS)
  const entry = runtime.sharedPackages.find(candidate => candidate.name === 'react')
  expect(entry).toMatchObject({ version: REACT_VERSION, path: 'node_modules/react' })
})
