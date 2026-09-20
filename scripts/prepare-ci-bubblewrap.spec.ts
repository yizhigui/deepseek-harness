/**
 * CI provisioning contract for the sandbox helper.
 *
 * The coverage and consumer lanes run this script before their gates, so a
 * regression here takes both lanes down during setup and reports nothing about
 * the commit under test. The contract is therefore pinned twice: structurally
 * (it resolves the package instead of pinning an archive filename, and it
 * verifies what it downloaded) and by running its failure path where it lives.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(new URL('./prepare-ci-bubblewrap.sh', import.meta.url))
const script = readFileSync(scriptPath, 'utf8')

describe('bubblewrap provisioning', () => {
  it('resolves the distribution package instead of pinning an archive filename', () => {
    // Ubuntu removes a superseded revision from the pool, so a pinned pool URL
    // rots: the previous `bubblewrap_0.9.0-1ubuntu0.1_amd64.deb` returned 404 and
    // failed both lanes during setup.
    expect(script).not.toContain('archive.ubuntu.com')
    expect(script).not.toMatch(/readonly BUBBLEWRAP_(?:VERSION|SHA256)=/)
    expect(script).toContain('apt-get download bubblewrap')
  })

  it('records the payload it resolved and proves it confines a process', () => {
    expect(script).toContain('sha256sum "$archive"')
    expect(script).toContain('dpkg-deb --extract "$archive" "$root"')
    expect(script).toContain('--unshare-pid')
  })

  it('requires the runner environment instead of guessing a location', () => {
    expect(script).toContain(': "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"')
    expect(script).toContain(': "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"')
  })
})

describe.skipIf(process.platform === 'win32')('bubblewrap provisioning on a Linux runner', () => {
  // The script provisions Linux runners only, so its loud failure contract is
  // exercised where it actually runs.
  it.each(['RUNNER_TEMP', 'GITHUB_PATH'])('fails loudly when %s is unset', (name) => {
    // The child gets an environment without the variable, exactly as a lane that
    // never exported it would.
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        RUNNER_TEMP: '/tmp',
        GITHUB_PATH: '/tmp/dsh-github-path',
      }).filter(([key]) => key !== name),
    )
    const result = spawnSync('bash', [scriptPath], { env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(name)
  })
})
