/**
 * The plugin market's desktop mutation bridge.
 *
 * A desktop install must never reach the market's own HTTP mutation route:
 * that route sits behind an HTTP same-origin check a `dsh-app://` document
 * cannot satisfy, and it would install with an externally provisioned pnpm.
 * These specs pin the two properties the desktop adapter is responsible for —
 * that a market mutation is answered from the desktop's own transaction, and
 * that the renderer can never hand the shell a command.
 */
import { describe, expect, it } from 'vitest'
import { assertPackageName, packageNameFromSpec } from '../src/project-manager.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

describe('market mutation channels', () => {
  it('names one channel per mutation plus the installed read', () => {
    expect(DESKTOP_IPC.marketInstall).toBe('dsh-desktop:market-install')
    expect(DESKTOP_IPC.marketRemove).toBe('dsh-desktop:market-remove')
    expect(DESKTOP_IPC.marketUpdate).toBe('dsh-desktop:market-update')
    expect(DESKTOP_IPC.marketInstalled).toBe('dsh-desktop:market-installed')
  })

  it('keeps the market channels distinct from the shell plugin channels', () => {
    // The shell window and the application document must not share a channel:
    // the shell's own add path is a different trust boundary.
    const marketChannels = [DESKTOP_IPC.marketInstall, DESKTOP_IPC.marketRemove, DESKTOP_IPC.marketUpdate, DESKTOP_IPC.marketInstalled]
    const shellChannels = [DESKTOP_IPC.pluginsAdd, DESKTOP_IPC.pluginsRemove, DESKTOP_IPC.pluginsUpdate, DESKTOP_IPC.pluginsList]
    expect(new Set(marketChannels).size).toBe(marketChannels.length)
    for (const channel of marketChannels) expect(shellChannels).not.toContain(channel)
  })
})

describe('market install source admission', () => {
  it.each([
    'dsh-context',
    '@scope/plugin',
    'dsh-context@1.2.3',
    '@scope/plugin@0.1.0-rc.2',
    'dsh-context@latest',
  ])('accepts the registry spec %s', (spec) => {
    expect(() => packageNameFromSpec(spec)).not.toThrow()
  })

  it.each([
    { spec: 'dsh-context; rm -rf /', label: 'a shell separator' },
    { spec: 'dsh-context && whoami', label: 'a shell AND list' },
    { spec: 'dsh-context | cat /etc/passwd', label: 'a shell pipe' },
    { spec: '$(whoami)', label: 'a command substitution' },
    { spec: '`whoami`', label: 'a backtick substitution' },
    { spec: 'dsh-context\nrm -rf /', label: 'a newline' },
    { spec: 'dsh-context > out.txt', label: 'a redirect' },
    { spec: '--registry=http://evil', label: 'an option-looking spec' },
    { spec: 'file:/etc/passwd', label: 'a file spec' },
    { spec: 'https://evil.example/plugin.tgz', label: 'an http spec' },
    { spec: 'C:\\Windows\\System32', label: 'a windows path' },
    { spec: '/usr/bin/env', label: 'a posix path' },
    { spec: '', label: 'an empty spec' },
  ])('refuses $label', ({ spec }) => {
    expect(() => packageNameFromSpec(spec)).toThrow()
  })

  it.each([
    { name: 'dsh-context', ok: true },
    { name: '@scope/plugin', ok: true },
    { name: 'dsh-context; rm -rf /', ok: false },
    { name: '../escape', ok: false },
    { name: '', ok: false },
  ])('admits a bare plugin name only when it is one ($name)', ({ name, ok }) => {
    const attempt = (): void => { assertPackageName(name) }
    if (ok) expect(attempt).not.toThrow()
    else expect(attempt).toThrow()
  })
})
