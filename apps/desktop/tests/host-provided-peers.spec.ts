/**
 * Desktop provision of the renderer shell's React singletons.
 *
 * Reproduces the shipped failures (`dsh-better-sidebar -> react-icons requires
 * missing react@*`, `dsh-web-all -> @linxin666/dsh-client-ui-plugin-manager
 * requires missing react@^18.2.0`) and proves that declaring React as a
 * host-provided runtime peer admits those graphs without introducing a second
 * React instance into the profile.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { satisfies } from 'semver'
import { resolveDesktopHostProvidedPeers } from '../src/host-provided-peers.ts'
import { linkDesktopHostPackages, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

/** Version the renderer's bundle carries; peers must be satisfiable against it. */
const REACT_VERSION = '18.3.1'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * Profile fixture whose runtime optionally carries the host-provided peers.
 * @param sharedNames - Peers materialized into the runtime and sealed as shared.
 * @returns The sealed runtime, its root directory, and a linked profile.
 */
function fixture(sharedNames: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-react-peer-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  // `exports: undefined` drops the fixture's entry map, so `react/package.json`
  // stays resolvable exactly as the published package allows.
  for (const name of sharedNames) writePackage(join(dsh, 'node_modules'), name, { version: REACT_VERSION, exports: undefined })
  const runtime = runtimeFixture(dsh, '1.0.0', '24.17.0', sharedNames)
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, dsh, runtime)
  return { dsh, runtime, profile }
}

/**
 * Write the shipped failure shape: a plugin whose DEPENDENCY requires React.
 * @param profile - Linked profile directory.
 * @returns The plugin package directory.
 */
function writeSidebarWithIconDependency(profile: string): string {
  writePackage(join(profile, 'node_modules'), 'react-icons', { peerDependencies: { react: '*' } })
  return writePackage(join(profile, 'node_modules'), 'sidebar', {
    peerDependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
    dependencies: { 'react-icons': '5.7.0' },
  })
}

it('rejects the shipped sidebar graph while React is not a host-provided peer', () => {
  const { dsh, runtime, profile } = fixture()
  writeSidebarWithIconDependency(profile)
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['sidebar']) })
    .toThrow(/sidebar -> react-icons requires missing react@\*/u)
})

it('rejects the shipped web-all graph while React is not a host-provided peer', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'ui-plugin-manager', { peerDependencies: { react: '^18.2.0' } })
  writePackage(join(profile, 'node_modules'), 'web-all', { dependencies: { 'ui-plugin-manager': '1.0.0' } })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['web-all']) })
    .toThrow(/web-all -> ui-plugin-manager requires missing react@\^18\.2\.0/u)
})

it('admits both graphs once React is a host-provided runtime peer', () => {
  const { dsh, runtime, profile } = fixture(['react', 'react-dom'])
  writeSidebarWithIconDependency(profile)
  writePackage(join(profile, 'node_modules'), 'ui-plugin-manager', { peerDependencies: { react: '^18.2.0' } })
  writePackage(join(profile, 'node_modules'), 'web-all', { dependencies: { 'ui-plugin-manager': '1.0.0' } })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['sidebar', 'web-all']) }).not.toThrow()
})

it('resolves React to the single host-owned instance, never a profile-local copy', () => {
  const { dsh, profile } = fixture(['react', 'react-dom'])
  const plugin = writeSidebarWithIconDependency(profile)
  const hostReact = realpathSync.native(join(dsh, 'node_modules', 'react'))
  const fromPlugin = realpathSync.native(resolve(createRequire(join(plugin, 'package.json')).resolve('react/package.json'), '..'))
  const fromIconDependency = realpathSync.native(resolve(createRequire(join(profile, 'node_modules', 'react-icons', 'package.json')).resolve('react/package.json'), '..'))
  expect(fromPlugin).toBe(hostReact)
  expect(fromIconDependency).toBe(hostReact)
})

it('still refuses React declared as an ordinary dependency', () => {
  const { dsh, runtime, profile } = fixture(['react', 'react-dom'])
  writePackage(join(profile, 'node_modules'), 'plugin', { dependencies: { react: REACT_VERSION } })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) })
    .toThrow(/must declare react as a peer dependency/u)
})

it('resolves provisioned peers from the renderer that seeds them', () => {
  const rendererRoot = resolve(import.meta.dirname, '..', '..', 'web')
  const peers = resolveDesktopHostProvidedPeers(rendererRoot)
  expect(peers.map(peer => peer.name)).toEqual(['react', 'react-dom'])
  const react = peers.find(peer => peer.name === 'react')
  const reactDom = peers.find(peer => peer.name === 'react-dom')
  expect(react?.version).toBe(REACT_VERSION)
  expect(reactDom?.version).toBe(REACT_VERSION)
  // The renderer ships one React, so the DOM renderer's own peer range must accept it.
  const require = createRequire(join(rendererRoot, 'package.json'))
  const manifest = JSON.parse(readFileSync(require.resolve('react-dom/package.json'), 'utf8')) as { peerDependencies?: Record<string, string> }
  expect(satisfies(reactDom?.version ?? '', manifest.peerDependencies?.react ?? '*')).toBe(true)
})
