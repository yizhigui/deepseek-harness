/**
 * The desktop application's user-visible identity.
 *
 * The shell titles its Windows toast and its tray icon with Electron's
 * `app.name`. Electron prefers a package.json `productName` over `name`, and the
 * packaged manifest carried only the scoped npm name — so every real install
 * titled its notifications `@deepseek-ai/dsh-desktop` while the unit test, which
 * supplies its own `app.name`, saw nothing wrong. This spec pins the manifest
 * fact the unit test cannot see.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest: unknown = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

describe('desktop application identity', () => {
  it('declares the product name the toast and tray publish', () => {
    // Electron's `app.name` is `productName` when present, else `name`. Without
    // this field a packaged install publishes the scoped npm name.
    expect(field(manifest, 'productName')).toBe('DeepSeek Harness')
  })

  it('keeps the product name distinct from the npm package name', () => {
    // The regression is exactly this collapse: if the two ever agree, the toast
    // titles itself with the package scope again.
    expect(field(manifest, 'name')).toBe('@deepseek-ai/dsh-desktop')
    expect(field(manifest, 'productName')).not.toBe(field(manifest, 'name'))
  })

  it('publishes a product name with no package scope or path characters', () => {
    const productName = field(manifest, 'productName')
    expect(typeof productName).toBe('string')
    expect(productName as string).not.toContain('@')
    expect(productName as string).not.toContain('/')
    expect((productName as string).trim()).toBe(productName)
  })
})
