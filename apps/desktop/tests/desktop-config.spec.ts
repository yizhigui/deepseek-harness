/**
 * Desktop-owned Harness home resolution: precedence, degraded configuration, and child environment.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopConfigDirectory } from '../src/config-directory.ts'
import {
  DESKTOP_CONFIG_FILENAME,
  desktopHostEnvironment,
  resolveDesktopHome,
} from '../src/desktop-config.ts'

const roots: string[] = []

function fixtureDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-config-'))
  roots.push(root)
  return root
}

function writeConfig(configDirectory: string, contents: string): void {
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(join(configDirectory, DESKTOP_CONFIG_FILENAME), contents)
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('desktop configuration directory', () => {
  it('uses the stable %APPDATA% directory on Windows and the user-data fallback elsewhere', () => {
    expect(desktopConfigDirectory({ APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, 'C:\\user-data'))
      .toBe(join('C:\\Users\\someone\\AppData\\Roaming', 'DeepSeekHarness'))
    expect(desktopConfigDirectory({ APPDATA: '   ' }, 'C:\\user-data'))
      .toBe(join('C:\\user-data', 'desktop-config'))
    expect(desktopConfigDirectory({}, 'C:\\user-data'))
      .toBe(join('C:\\user-data', 'desktop-config'))
  })
})

describe('resolveDesktopHome precedence', () => {
  it('prefers an absolute dshHome from desktop-config.json over the environment', () => {
    const root = fixtureDirectory()
    const configured = join(root, 'configured-home')
    writeConfig(root, JSON.stringify({ dshHome: configured }))
    expect(resolveDesktopHome(root, { DSH_HOME: join(root, 'environment-home') }))
      .toEqual({ home: resolve(configured), source: 'desktop-config', warnings: [] })
  })

  it('uses DSH_HOME when the configuration file is absent', () => {
    const root = fixtureDirectory()
    expect(resolveDesktopHome(root, { DSH_HOME: join(root, 'environment-home') }))
      .toEqual({ home: resolve(join(root, 'environment-home')), source: 'environment', warnings: [] })
  })

  it('falls back to the Harness default home when neither source is present', () => {
    const root = fixtureDirectory()
    const resolved = resolveDesktopHome(root, {})
    expect(resolved.source).toBe('default')
    expect(resolved.home).toBe(resolve(join(homedir(), '.dsh')))
    expect(resolved.warnings).toEqual([])
  })

  it('treats a blank DSH_HOME as unset rather than resolving it against the working directory', () => {
    const root = fixtureDirectory()
    expect(resolveDesktopHome(root, { DSH_HOME: '   ' }).source).toBe('default')
  })

  it('accepts a configuration without dshHome and continues to the environment', () => {
    const root = fixtureDirectory()
    writeConfig(root, JSON.stringify({ other: true }))
    const resolved = resolveDesktopHome(root, { DSH_HOME: join(root, 'environment-home') })
    expect(resolved.source).toBe('environment')
    expect(resolved.warnings).toEqual([])
  })

  it('expands a tilde home exactly as the Harness resolver does', () => {
    const root = fixtureDirectory()
    writeConfig(root, JSON.stringify({ dshHome: '~/configured-home' }))
    const resolved = resolveDesktopHome(root, { DSH_HOME: join(root, 'environment-home') })
    expect(resolved.source).toBe('desktop-config')
    expect(resolved.home).toBe(resolve(join(homedir(), 'configured-home')))
  })
})

describe('resolveDesktopHome resilience', () => {
  const degraded: readonly (readonly [string, string])[] = [
    ['invalid JSON', '{ this is not json'],
    ['a JSON array', '[]'],
    ['a JSON null root', 'null'],
    ['a JSON string root', '"home"'],
    ['an empty dshHome', JSON.stringify({ dshHome: '' })],
    ['a whitespace dshHome', JSON.stringify({ dshHome: '   ' })],
    ['a non-string dshHome', JSON.stringify({ dshHome: 42 })],
    ['a relative dshHome', JSON.stringify({ dshHome: 'relative/home' })],
  ]

  it.each(degraded)('reports %s and falls back instead of failing', (_label, contents) => {
    const root = fixtureDirectory()
    writeConfig(root, contents)
    const resolved = resolveDesktopHome(root, { DSH_HOME: join(root, 'environment-home') })
    expect(resolved.source).toBe('environment')
    expect(resolved.home).toBe(resolve(join(root, 'environment-home')))
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain(DESKTOP_CONFIG_FILENAME)
  })

  it('falls back to the default home when the damaged configuration is the only source', () => {
    const root = fixtureDirectory()
    writeConfig(root, 'not json')
    const resolved = resolveDesktopHome(root, {})
    expect(resolved.source).toBe('default')
    expect(resolved.warnings).toHaveLength(1)
  })

  it('reports an unreadable configuration path instead of throwing', () => {
    const root = fixtureDirectory()
    // A directory where the file is expected fails with EISDIR, not ENOENT.
    mkdirSync(join(root, DESKTOP_CONFIG_FILENAME))
    const resolved = resolveDesktopHome(root, {})
    expect(resolved.source).toBe('default')
    expect(resolved.warnings).toHaveLength(1)
  })
})

describe('desktopHostEnvironment', () => {
  it('pins the resolved home and removes OS-home overrides', () => {
    const resolved = resolve('C:\\resolved-home')
    const environment = desktopHostEnvironment({
      HOME: '/inherited-home',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\someone',
      DSH_HOME: 'C:\\inherited-dsh-home',
      PATH: '/usr/bin',
      DSH_DESKTOP_APP_ID: 'ai.deepseek.harness',
    }, resolved)
    expect(environment.DSH_HOME).toBe(resolved)
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.DSH_DESKTOP_APP_ID).toBe('ai.deepseek.harness')
    expect('HOME' in environment).toBe(false)
    expect('HOMEDRIVE' in environment).toBe(false)
    expect('HOMEPATH' in environment).toBe(false)
  })
})
