import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { acquirePackageGuard, DesktopPackageLock, packageGuardPaths } from '../src/package-lock.ts'
import { desktopPluginLockHash, readDesktopProfileState } from '../src/profile-packages.ts'
import { type DesktopProjectManager } from '../src/project-manager.ts'
import { PACKAGE_WORKER_SOURCE } from '../src/package-worker.ts'
import { fixtureText, transactionFixture, transactionProcess, type FixtureProcess } from './transaction-lock-fixture.ts'

const roots: string[] = []
const children: FixtureProcess[] = []
const guards: Array<{ release(): Promise<void> }> = []
const hooks = { beforeChange: async () => {}, afterChange: async () => {} }

async function setup(): Promise<{ root: string; manager: DesktopProjectManager }> {
  const fixture = transactionFixture()
  roots.push(fixture.root)
  await fixture.manager.applyRelease()
  await fixture.manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks)
  await fixture.manager.mutate({ type: 'plugin-add', spec: 'unrelated@1.0.0' }, hooks)
  return fixture
}

function start(...args: Parameters<typeof transactionProcess>): FixtureProcess {
  const child = transactionProcess(...args)
  children.push(child)
  return child
}

function state(manager: DesktopProjectManager): unknown {
  const profile = manager.paths.profile
  const require = createRequire(join(profile, 'package.json'))
  return {
    manifest: JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as unknown,
    lockfile: readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'),
    runtime: readDesktopProfileState(profile), installed: manager.listPlugins(),
    plugins: ['plugin', 'unrelated'].map(name => readFileSync(require.resolve(`${name}/package.json`), 'utf8')),
    peers: ['react', 'react-dom'].map(name => realpathSync(join(profile, 'node_modules', name))),
  }
}

function healthy(manager: DesktopProjectManager): void {
  manager.assertProfileRuntime(manager.paths.profile)
  expect(readDesktopProfileState(manager.paths.profile)?.lockHash).toBe(desktopPluginLockHash(manager.paths.profile))
  for (const name of ['lock', 'desktop-packages-pending', 'desktop-transaction-snapshot.json']) {
    expect(existsSync(join(manager.paths.profile, name)), name).toBe(false)
  }
}

afterEach(async () => {
  for (const root of roots) {
    writeFileSync(join(root, 'release'), '')
    writeFileSync(join(root, 'release-worker'), '')
  }
  await Promise.all(guards.splice(0).map(guard => guard.release()))
  await Promise.all(children.splice(0).map(async ({ child, done }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done
  }))
  for (const root of roots) {
    if (fixtureText(root, 'worker-ready') === undefined) continue
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        const guard = await acquirePackageGuard(packageGuardPaths(join(root, 'home/profiles/desktop')).worker, join(root, 'runtime'))
        await guard.release()
        break
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('another package transaction is active') || Date.now() >= deadline) throw error
        await sleep(10)
      }
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop package transaction ownership', () => {
  it('runs pnpm worker threads without inheriting the launcher eval mode', async () => {
    const { root, manager } = await setup()
    writeFileSync(join(root, 'thread-probe'), '')
    await manager.mutate({ type: 'plugin-add', spec: 'threaded@1.0.0' }, hooks)
    healthy(manager)
  })

  it('does not execute pnpm when its parent disconnects before granting the worker', async () => {
    const { manager } = await setup()
    const before = state(manager)
    const child = spawn(process.execPath, [
      '--eval', `void (async () => { ${PACKAGE_WORKER_SOURCE} })()`,
      packageGuardPaths(manager.paths.profile).worker, manager.runtime.dsh, manager.runtime.pnpm, 'remove', 'plugin',
    ], { cwd: manager.paths.profile, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    // With ignored stdio there is nothing to drain. Observe OS exit and IPC
    // closure separately: Windows Node can omit close after parent disconnect.
    const disconnected = new Promise<void>(resolve => child.once('disconnect', resolve))
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { resolve({ code, signal, output: '' }) })
    })
    const done = Promise.all([exited, disconnected]).then(([outcome]) => outcome)
    children.push({ child, done })
    const ready = await Promise.race([
      new Promise(resolve => child.once('message', resolve)),
      done.then(() => { throw new Error('worker exited before readiness') }),
    ])
    expect(ready).toEqual({ type: 'package-worker-ready' })
    await expect(manager.applyRelease()).rejects.toThrow('another package transaction is active')
    child.disconnect()
    expect(await done).toMatchObject({ code: 1, signal: null })
    expect(state(manager)).toEqual(before)
    await manager.applyRelease()
    healthy(manager)
  })

  it('releases normal transactions and preserves exclusion across managers and old timestamps', async () => {
    const { manager } = await setup()
    healthy(manager)
    const lock = await DesktopPackageLock.acquire(manager.paths.lock, manager.runtime.dsh)
    guards.push(lock)
    utimesSync(manager.paths.lock, new Date(0), new Date(0))
    await expect(manager.applyRelease()).rejects.toThrow('another package transaction is active')
    expect(JSON.parse(readFileSync(manager.paths.lock, 'utf8'))).toMatchObject({ pid: process.pid, schemaVersion: 1 })
    await lock.release()
    guards.pop()
    await manager.mutate({ type: 'plugin-update', name: 'plugin', version: '1.1.0' }, hooks)
    healthy(manager)
  })

  it('recovers a new-format record naming an unrelated live PID without treating it as its owner', async () => {
    const { manager } = await setup()
    writeFileSync(manager.paths.lock, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() }))
    await manager.applyRelease()
    healthy(manager)
  })

  it.each(['', '{broken', '{"schemaVersion":1}', '123junk', '0'])('fails closed on corrupt owner metadata %j', async (body) => {
    const { manager } = await setup()
    writeFileSync(manager.paths.lock, body)
    await expect(manager.applyRelease()).rejects.toThrow('invalid package transaction owner')
    expect(readFileSync(manager.paths.lock, 'utf8')).toBe(body)
  })

  it('does not infer a stale legacy PID while that process is alive', async () => {
    const { manager } = await setup()
    writeFileSync(manager.paths.lock, `${process.pid}\n`)
    await expect(manager.applyRelease()).rejects.toThrow('another package transaction is active')
    expect(readFileSync(manager.paths.lock, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('reconciles pending-only state without an owner file', async () => {
    const { manager } = await setup()
    const before = state(manager)
    writeFileSync(join(manager.paths.profile, 'desktop-packages-pending'), '')
    await expect(manager.applyRelease()).resolves.toBe(true)
    expect(state(manager)).toEqual(before)
    healthy(manager)
  })

  it('rejects a concurrent mutation, then recovers after a real holder dies without pending', async ({ task, signal }) => {
    const { root, manager } = await setup()
    const child = start(root, 'hold')
    await expect.poll(() => { signal.throwIfAborted(); return fixtureText(root, 'hold-entered') }, { timeout: task.timeout }).toBe('')
    await expect(manager.mutate({ type: 'plugin-add', spec: 'second@1.0.0' }, hooks)).rejects.toThrow('another package transaction is active')
    expect(existsSync(join(manager.paths.profile, 'desktop-packages-pending'))).toBe(false)
    child.child.kill('SIGKILL')
    await child.done
    expect(existsSync(manager.paths.lock)).toBe(true)
    await manager.applyRelease()
    healthy(manager)
    // The same dead PID is also safely migrated from the old released format.
    writeFileSync(manager.paths.lock, `${String(child.child.pid)}\n`)
    await manager.applyRelease()
    healthy(manager)
  })

  it.for(['after-pnpm', 'before-finish'] as const)('restores the complete pre-mutation graph after a crash %s', async (stage, { task, signal }) => {
    const { root, manager } = await setup()
    const before = state(manager)
    const child = start(root, stage)
    await expect.poll(() => { signal.throwIfAborted(); return fixtureText(root, `${stage}-entered`) }, { timeout: task.timeout }).toBe('')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(false)
    expect(existsSync(join(manager.paths.profile, 'desktop-packages-pending'))).toBe(true)
    child.child.kill('SIGKILL')
    await child.done
    await expect(manager.applyRelease()).resolves.toBe(true)
    expect(state(manager)).toEqual(before)
    healthy(manager)
    await manager.mutate({ type: 'plugin-add', spec: 'next@1.0.0' }, hooks)
    await manager.mutate({ type: 'plugin-remove', name: 'next' }, hooks)
    expect(state(manager)).toEqual(before)
    healthy(manager)
  })

  it('keeps failed crash recovery retryable without deleting its evidence', async ({ task, signal }) => {
    const { root, manager } = await setup()
    const before = state(manager)
    const child = start(root, 'after-pnpm')
    await expect.poll(() => { signal.throwIfAborted(); return fixtureText(root, 'after-pnpm-entered') }, { timeout: task.timeout }).toBe('')
    child.child.kill('SIGKILL')
    await child.done
    writeFileSync(join(root, 'fail-recovery'), '')
    await expect(manager.applyRelease()).rejects.toThrow('pnpm exited with 7')
    expect(existsSync(manager.paths.lock)).toBe(false)
    expect(existsSync(join(manager.paths.profile, 'desktop-packages-pending'))).toBe(true)
    expect(existsSync(join(manager.paths.profile, 'desktop-transaction-snapshot.json'))).toBe(true)
    unlinkSync(join(root, 'fail-recovery'))
    await manager.applyRelease()
    expect(state(manager)).toEqual(before)
    healthy(manager)
  })

  it('keeps a surviving pnpm worker exclusive after its Desktop owner dies', async ({ task, signal }) => {
    const { root, manager } = await setup()
    const before = state(manager)
    writeFileSync(join(root, 'block-worker'), '')
    const child = start(root, 'worker')
    await expect.poll(() => { signal.throwIfAborted(); return fixtureText(root, 'worker-ready') }, { timeout: task.timeout }).toMatch(/^\d+$/u)
    await expect(acquirePackageGuard(packageGuardPaths(manager.paths.profile).worker, manager.runtime.dsh)).rejects.toThrow('another package transaction is active')
    const workerPid = Number(fixtureText(root, 'worker-ready'))
    child.child.kill('SIGKILL')
    await child.done
    expect(() => process.kill(workerPid, 0)).not.toThrow()
    await expect(manager.applyRelease()).rejects.toThrow('another package transaction is active')
    writeFileSync(join(root, 'release-worker'), '')
    await expect.poll(async () => {
      signal.throwIfAborted()
      try {
        const guard = await acquirePackageGuard(packageGuardPaths(manager.paths.profile).worker, manager.runtime.dsh)
        await guard.release()
        return true
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('another package transaction is active')) throw error
        return false
      }
    }, { timeout: task.timeout }).toBe(true)
    await manager.applyRelease()
    expect(state(manager)).toEqual(before)
    healthy(manager)
  })

  it('grants only one of two overlapping recovery contenders ownership', async ({ task, signal }) => {
    const { root, manager } = await setup()
    writeFileSync(manager.paths.lock, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() }))
    writeFileSync(join(manager.paths.profile, 'desktop-packages-pending'), '')
    const a = start(root, 'contend', 'a'), b = start(root, 'contend', 'b')
    await expect.poll(() => { signal.throwIfAborted(); return ['a', 'b'].every(id => fixtureText(root, `${id}-ready`) === '') }, { timeout: task.timeout }).toBe(true)
    writeFileSync(join(root, 'contend'), '')
    await expect.poll(() => { signal.throwIfAborted(); return ['a', 'b'].filter(id => fixtureText(root, `${id}-failure`)?.includes('another package transaction is active')).length }, { timeout: task.timeout }).toBe(1)
    expect(['a', 'b'].filter(id => fixtureText(root, `${id}-entered`) === '')).toHaveLength(1)
    writeFileSync(join(root, 'release'), '')
    const outcomes = await Promise.all([a.done, b.done])
    expect(outcomes.map(outcome => outcome.code).sort()).toEqual([0, 1])
    expect(outcomes.every(outcome => outcome.signal === null)).toBe(true)
    healthy(manager)
  })
})
