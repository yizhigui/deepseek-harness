/**
 * Resolve one Plugin Market request into a package spec the desktop transaction may install.
 *
 * The market's registry identifies a plugin by the repository URL it lives in — its card
 * carries `url`, and the UI posts exactly that URL to its install route. That URL is not an
 * install target: `https://github.com/owner/repo` and
 * `https://github.com/owner/repo/tree/<ref>/<subdirectory>` both name a repository, while the
 * installable artifact is an npm package whose name often has no traceable relation to the
 * path. Across the live catalog, 271 of the 2015 entries that publish a package disagree with
 * their own URL's last segment (`packages/dsh-plugin` → `dsh-gungnir`,
 * `packages/plugin-notes` → `@zzerx/dsh-plugin-notes`), so no pathname rule can recover the
 * name.
 *
 * The registry entry already carries the answer in its `npm` field, which is what the market's
 * own installer consumes. This module therefore resolves a request the only way that can be
 * correct AND safe:
 *
 *  1. The request must be an exact `url` of one entry in the registry the shell fetches itself.
 *  2. That entry's `npm` field is the canonical install target — the renderer's own opinion
 *     about a mapping is never read, because the renderer supplies only the lookup key.
 *  3. The result is re-validated by the desktop transaction's own admission
 *     (`packageNameFromSpec`), so nothing this module returns can be a command, a local path,
 *     a `file:` spec, or a git URL.
 *
 * A renderer that posts any other URL — an attacker's host, a repository absent from the
 * registry, a `file:` path, a flag, a shell fragment — matches no entry and is rejected here,
 * before any package manager runs.
 *
 * @module @deepseek-ai/dsh-desktop/market-source
 */

import { gunzipSync } from 'node:zlib'
import { packageNameFromSpec } from './project-manager.ts'

/** The catalog the Plugin Market itself renders from. */
export const MARKET_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/** Fallback route: the same catalog published as an npm package. */
export const MARKET_CATALOG_PACKAGE = 'dsh-plugin-catalog'

/**
 * How long one fetched catalog may answer lookups before it is fetched again.
 *
 * A user who installs several plugins in a row must not pay for the catalog on each
 * one, and a card's Install button is pressed within the lifetime of the page that
 * rendered it — so a short window is enough to make the common case free without
 * letting a long-lived window install from a stale registry.
 */
const CATALOG_TTL_MS = 5 * 60 * 1000

/** One entry of the market catalog, reduced to the fields this module reads. */
export interface MarketRegistryEntry {
  /** Identity of the plugin inside the catalog. */
  readonly name: string
  /** Repository URL that the market UI posts as its install request. */
  readonly url: string
  /** Canonical npm package the entry publishes, when it has one. */
  readonly npm?: string | null
  /** Published version of {@link npm}, when the catalog knows it. */
  readonly version?: string | null
}

/** Catalog document shape this module requires. */
export interface MarketRegistry {
  readonly plugins: readonly MarketRegistryEntry[]
}

/** Why a market request was refused, for the UI's error line. */
export type MarketResolutionFailure =
  /** The request was not one exact registry `url`. */
  | 'not-in-registry'
  /** The entry is catalogued but publishes no npm package the desktop can install. */
  | 'no-npm-target'
  /** The registry answered with something that is not a catalog. */
  | 'registry-unavailable'

/** One resolved market install request. */
export type MarketResolution =
  | { readonly ok: true; readonly spec: string; readonly name: string; readonly entry: MarketRegistryEntry }
  | { readonly ok: false; readonly reason: MarketResolutionFailure; readonly message: string }

/**
 * Load the market catalog.
 * @returns the catalog entries, or null when the catalog cannot be read.
 */
export type MarketRegistryLoader = () => Promise<readonly MarketRegistryEntry[] | null>

/**
 * Build a resolver over one catalog loader.
 *
 * The loader is injected so the resolution rules stay testable without a network, and the
 * cache lives in the closure rather than in module state that a test would have to reset.
 * @param load - Catalog loader, called at most once per cache window.
 * @param now - Clock, injectable for cache-window tests.
 * @returns Resolution function for one market request.
 */
export function createMarketInstallResolver(
  load: MarketRegistryLoader,
  now: () => number = Date.now,
): (request: string) => Promise<MarketResolution> {
  let cached: readonly MarketRegistryEntry[] | null = null
  let cachedAt = 0

  return async (request: string): Promise<MarketResolution> => {
    const key = normalizeRegistryKey(request)
    if (key === null) {
      return {
        ok: false,
        reason: 'not-in-registry',
        message: `plugin market: ${JSON.stringify(request)} is not a plugin registry URL`,
      }
    }

    if (cached === null || now() - cachedAt > CATALOG_TTL_MS) {
      const loaded = await load()
      if (loaded === null) {
        // A catalog that cannot be read authorizes nothing. Answering from a previous
        // fetch would install from a registry the shell can no longer confirm.
        return {
          ok: false,
          reason: 'registry-unavailable',
          message: 'plugin market: the plugin registry is unavailable, so this install cannot be authorized',
        }
      }
      cached = loaded
      cachedAt = now()
    }

    const entry = cached.find(candidate => normalizeRegistryKey(candidate.url) === key)
    if (entry === undefined) {
      // The decisive admission: a renderer can only name an entry the registry already
      // publishes, so it cannot direct the shell at a repository of its own choosing.
      return {
        ok: false,
        reason: 'not-in-registry',
        message: `plugin market: ${JSON.stringify(request)} is not a plugin in the current registry`,
      }
    }

    const resolved = installTargetOf(entry)
    if (resolved === null) {
      return {
        ok: false,
        reason: 'no-npm-target',
        message: `plugin market: ${JSON.stringify(entry.name)} does not publish an npm package the desktop can install`,
      }
    }
    return { ok: true, ...resolved, entry }
  }
}

/**
 * Canonical registry key for one URL.
 *
 * Only the form the registry actually uses is accepted: an `https://github.com/...` URL. A
 * trailing slash is insignificant and is dropped; nothing else is rewritten, so two different
 * URLs never collapse into one entry.
 * @param url - Candidate registry URL.
 * @returns the comparison key, or null when the value cannot be a registry URL.
 */
export function normalizeRegistryKey(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname.toLowerCase() !== 'github.com') return null
  if (parsed.search !== '' || parsed.hash !== '') return null
  // Reject percent-encoding and dot-segments rather than letting the URL parser hide them:
  // a key must be the literal string the registry published.
  if (parsed.pathname.includes('%') || parsed.pathname.includes('/../') || parsed.pathname.includes('/./')) return null
  const path = parsed.pathname.replace(/\/+$/u, '')
  if (path.split('/').filter(segment => segment !== '').length < 2) return null
  return `https://github.com${path}`
}

/**
 * The canonical install target of one registry entry.
 *
 * Mirrors the market's own installer precedence — a published npm package wins over any git
 * target — and the version is pinned to the catalog's own value exactly as the market does.
 * @param entry - Registry entry that was matched by URL.
 * @returns the install spec and package name, or null when the entry has no npm target.
 */
export function installTargetOf(entry: MarketRegistryEntry): { readonly spec: string; readonly name: string } | null {
  const npm = typeof entry.npm === 'string' ? entry.npm.trim() : ''
  if (npm === '') return null

  // Admits exactly what the desktop transaction will accept: a registry package name, with
  // an optional version or tag. This rejects a catalog that tries to smuggle a URL, a flag, a
  // local path, a `file:` spec, or a git shortcut through the npm field.
  let name: string
  try {
    name = packageNameFromSpec(npm)
  } catch {
    return null
  }

  // Pin to the catalog's version only when the catalog has one. Without it the spec stays a
  // bare name and the registry resolves the version, which is the market's own semantics.
  const version = typeof entry.version === 'string' ? entry.version.trim() : ''
  if (version === '') return { spec: name, name }
  const pinned = `${name}@${version}`
  try {
    packageNameFromSpec(pinned)
  } catch {
    return { spec: name, name }
  }
  return { spec: pinned, name }
}

/**
 * Fetch the market catalog over HTTP.
 *
 * Uses the same two routes the market documents — the published origin, then the catalog
 * package — and accepts a document only when it carries a usable `plugins` array.
 * @param fetchImpl - Fetch implementation.
 * @returns the catalog entries, or null when no route produced one.
 */
export async function loadMarketRegistry(fetchImpl: typeof fetch = fetch): Promise<readonly MarketRegistryEntry[] | null> {
  const direct = await loadCatalogUrl(MARKET_CATALOG_URL, fetchImpl)
  if (direct !== null) return direct
  return loadCatalogFromPackage(fetchImpl)
}

/**
 * Download and parse one catalog document from a URL.
 * @param url - Catalog URL.
 * @param fetchImpl - Fetch implementation.
 * @returns the entries, or null when the response was not a usable catalog.
 */
async function loadCatalogUrl(url: string, fetchImpl: typeof fetch): Promise<readonly MarketRegistryEntry[] | null> {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return asCatalog(await response.json())
  } catch {
    return null
  }
}

/**
 * Read the catalog from its published npm package.
 *
 * The package route is documented by the market as the path that survives its origin host
 * being unreachable, so a build whose shell can reach npm but not the site still resolves.
 * The entry point of that package IS the catalog document, so this is the same shape the URL
 * route returns.
 * @param fetchImpl - Fetch implementation.
 * @returns the entries, or null when the package route failed as well.
 */
async function loadCatalogFromPackage(fetchImpl: typeof fetch): Promise<readonly MarketRegistryEntry[] | null> {
  try {
    const meta = await fetchImpl(`https://registry.npmjs.org/${MARKET_CATALOG_PACKAGE}/latest`, { headers: { accept: 'application/json' } })
    if (!meta.ok) return null
    const manifest = await meta.json() as { main?: unknown; dist?: { tarball?: unknown } }
    if (typeof manifest.main !== 'string' || typeof manifest.dist?.tarball !== 'string') return null
    const archive = await fetchImpl(manifest.dist.tarball)
    if (!archive.ok) return null
    const entryPath = manifest.main.replace(/^\.\//u, '')
    return asCatalog(extractTarballEntry(new Uint8Array(await archive.arrayBuffer()), `package/${entryPath}`))
  } catch {
    return null
  }
}

/**
 * Extract one named file from an uncompressed-codec npm tarball.
 *
 * npm tarballs are gzip-compressed `ustar` archives. Walking the header chain keeps this
 * independent of any archive dependency the desktop package does not already carry, and a
 * malformed member ends the walk instead of being guessed at.
 * @param bytes - Raw `.tgz` bytes as downloaded.
 * @param wanted - Archive path to return, e.g. `package/plugins.json`.
 * @returns the parsed JSON of that member, or null when it is absent or unreadable.
 */
function extractTarballEntry(bytes: Uint8Array, wanted: string): unknown {
  let tar: Buffer
  try {
    tar = gunzipSync(Buffer.from(bytes))
  } catch {
    return null
  }
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // An all-zero block is the end-of-archive marker.
    if (header.every(byte => byte === 0)) break
    const readField = (start: number, length: number): string => {
      const raw = header.subarray(start, start + length)
      const end = raw.indexOf(0)
      return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').trim()
    }
    const name = readField(0, 100)
    const prefix = readField(345, 155)
    const size = Number.parseInt(readField(124, 12), 8)
    const memberPath = prefix === '' ? name : `${prefix}/${name}`
    if (!Number.isFinite(size) || size < 0) return null
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (memberPath === wanted) {
      try {
        return JSON.parse(body.toString('utf8'))
      } catch {
        return null
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

/**
 * Narrow an unknown document to the catalog entries this module reads.
 * @param value - Parsed catalog document.
 * @returns the entries, or null when the document is not a catalog.
 */
export function asCatalog(value: unknown): readonly MarketRegistryEntry[] | null {
  if (typeof value !== 'object' || value === null) return null
  const plugins = (value as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return null
  const entries: MarketRegistryEntry[] = []
  for (const candidate of plugins) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.url !== 'string') continue
    entries.push({
      name: record.name,
      url: record.url,
      npm: typeof record.npm === 'string' ? record.npm : null,
      version: typeof record.version === 'string' ? record.version : null,
    })
  }
  return entries
}
