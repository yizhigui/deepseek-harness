/**
 * The shell's static module table against the platform contract.
 *
 * These assertions moved here from `apps/desktop/tests/platform-peers.spec.ts`
 * with the compilation face they need: evaluating `seed.ts` statically imports
 * React and the shell's UI packages, and that graph is Client-face
 * (`tsconfig.base.client.json` owns `jsx`). The Desktop spec keeps the Host-face
 * provisioning plan and names the contract through its published subpath;
 * nothing was dropped in the move.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../src/platform.ts'
import { getStaticModules } from '../src/seed.ts'

/** The renderer workspace package whose resolution the shell's seed is compared against. */
const RENDERER_ROOT = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web')

describe('platform module contract', () => {
  it('seeds exactly the contract specifiers into the shell module table', () => {
    // The seed table is what a plugin's `require` actually hits; a specifier the
    // table does not answer would fail at runtime even with a runtime package.
    expect(Object.keys(getStaticModules()).sort()).toEqual([...PLATFORM_MODULES].sort())
  })

  it('keeps the seeded React instance the one the renderer resolves', () => {
    // The seed holds the shell's own static import; identity therefore follows
    // from module resolution, and the runtime copy can only ever be a second
    // on-disk artifact for Node, never a second instance for the page.
    const require = createRequire(resolve(RENDERER_ROOT, 'package.json'))
    const seeded = getStaticModules().react as { version?: string }
    const resolved = JSON.parse(readFileSync(require.resolve('react/package.json'), 'utf8')) as { version: string }
    expect(seeded.version).toBe(resolved.version)
  })

  it('keeps the contract module import-free so Host-face code can name it', () => {
    // `@deepseek-ai/dsh-client-web/platform` is the Host-face door into this
    // package. A value or re-export added to the contract module would pull the
    // Client source graph back into the Host program, which is the boundary the
    // published subpath exists to hold.
    const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'platform.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*(?:import|export)\s[^\n]*\bfrom\s/m)
    expect(source).not.toMatch(/^\s*import\s*\(/m)
  })
})
