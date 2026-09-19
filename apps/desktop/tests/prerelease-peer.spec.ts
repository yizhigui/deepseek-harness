/**
 * A prerelease range member is a statement about a development line, not a
 * promise that the line froze.
 *
 * The workspace's own `@deepseek-ai/dsh-settings@0.1.5-rc.2` meets
 * dshmarket's published peer range `^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2`
 * only once the prerelease gate is read the way the range itself implies. These
 * specs pin the widened reading AND the ordinary semver rules it must not touch,
 * so a stale peer range can never be relaxed into accepting a genuinely
 * different version line.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPluginProfile } from '../src/project-manager.ts'
import { linkDesktopHostPackages, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

/** The range dshmarket publishes from 1.39.0 onward. */
const MARKET_RANGE = '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2'

const roots: string[] = []
function fixture(settingsVersion = '0.1.5-rc.2') {
  const root = mkdtempSync(join(tmpdir(), 'desktop-prerelease-peer-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  // Materialize the release-owned settings package BEFORE sealing the runtime, so
  // the shared inventory records the version this spec is about.
  writePackage(join(dsh, 'node_modules'), '@deepseek-ai/dsh-settings', { version: settingsVersion })
  const runtime = runtimeFixture(dsh, '1.0.0', '24.17.0', ['@deepseek-ai/dsh-settings'])
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, dsh, runtime)
  return { root, dsh, runtime, profile }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('accepts a newer prerelease of the line a peer range names', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'dshmarket', {
    peerDependencies: { '@deepseek-ai/dsh-settings': MARKET_RANGE },
    peerDependenciesMeta: { '@deepseek-ai/dsh-settings': { optional: true } },
  })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['dshmarket']) }).not.toThrow()
})

it.each([
  { version: '0.1.0-rc.7', label: 'the range\'s own first prerelease' },
  { version: '0.1.2-alpha.2', label: 'the range\'s named prerelease' },
  { version: '0.1.5', label: 'the released version of the same line' },
])('still accepts $label', ({ version }) => {
  const { dsh, runtime, profile } = fixture(version)
  writePackage(join(profile, 'node_modules'), 'dshmarket', { peerDependencies: { '@deepseek-ai/dsh-settings': MARKET_RANGE } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['dshmarket']) }).not.toThrow()
})

it.each([
  { version: '0.2.0-rc.1', label: 'the next minor line' },
  { version: '0.2.0', label: 'the next released minor' },
  { version: '1.0.0-rc.1', label: 'the next major line' },
  { version: '1.0.0', label: 'the next released major' },
])('still rejects $label: the gate never widens a version line', ({ version }) => {
  const { dsh, runtime, profile } = fixture(version)
  writePackage(join(profile, 'node_modules'), 'dshmarket', { peerDependencies: { '@deepseek-ai/dsh-settings': MARKET_RANGE } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['dshmarket']) }).toThrow(new RegExp(`found ${version.replaceAll('.', '\\.')}`, 'u'))
})

it('keeps rejecting a stable peer mismatch', () => {
  // The pre-existing behavior this change must not weaken: a plainly wrong
  // stable peer is still an error, for the plugin and for the graph.
  const { dsh, runtime, profile } = fixture('1.0.0')
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { '@deepseek-ai/dsh-settings': '^2.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/requires @deepseek-ai\/dsh-settings@\^2\.0\.0, found 1\.0\.0/u)
})

it('leaves an optional peer absent from the profile skippable', () => {
  // dshmarket's settings peer is optional; the missing-target branch already
  // honors that, and the widened gate must not change it.
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { 'never-installed': '^9.0.0' },
    peerDependenciesMeta: { 'never-installed': { optional: true } },
  })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).not.toThrow()
})

it('still rejects a required peer that is absent', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { 'never-installed': '^9.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/requires missing never-installed@\^9\.0\.0/u)
})
