/** Kernel exclusion for Desktop transactions and their independently surviving pnpm workers. */

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const ACTIVE = 'desktop project: another package transaction is active'

/** A process-held kernel guard; its pathname is not an ownership record. */
export interface PackageGuard {
  /** Release only this holder's kernel resource. */
  release(): Promise<void>
}

/**
 * Canonical sibling paths keep POSIX lock inodes outside profile reset.
 * @param profile - Existing, non-linked Desktop profile.
 * @returns Separate guards for the manager and its pnpm worker.
 */
export function packageGuardPaths(profile: string): { owner: string; worker: string } {
  const canonical = realpathSync.native(profile)
  const prefix = join(dirname(canonical), `.${basename(canonical)}-packages`)
  return { owner: `${prefix}-owner.guard`, worker: `${prefix}-worker.guard` }
}

/**
 * Acquire without waiting or inferring ownership from a PID or clock.
 * @param path - Canonical guard identity; persistent inode on POSIX.
 * @param runtime - Immutable runtime containing the existing native flock package.
 * @returns A guard released by close or process death.
 */
export async function acquirePackageGuard(path: string, runtime: string): Promise<PackageGuard> {
  if (process.platform === 'win32') {
    const name = `\\\\.\\pipe\\dsh-packages-${createHash('sha256').update(path.toLowerCase()).digest('hex')}`
    const server = createServer((socket) => { socket.destroy() })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(name, resolve)
      })
    } catch (error) {
      server.close()
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(ACTIVE)
      throw error
    }
    return { release: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }) }
  }
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info !== undefined && !info.isFile()) throw new Error('desktop project: invalid package guard')
  const handle = await open(path, 'a+', 0o600)
  try {
    const native = createRequire(join(runtime, 'package.json'))('@deepseek-ai/node-addon-system/flock') as {
      tryLockExclusive(fd: number): Promise<void>
    }
    await native.tryLockExclusive(handle.fd)
    const held = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    if (held.ino !== current.ino || held.dev !== current.dev) throw new Error('desktop project: package guard was replaced')
    return { release: () => handle.close() }
  } catch (error) {
    await handle.close()
    if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error(ACTIVE)
    throw error
  }
}

/**
 * Publish a complete transaction record; interruption cannot expose a truncated owner or snapshot.
 * @param path - Destination in the held transaction's profile.
 * @param value - JSON-serializable record.
 */
export function writePackageRecord(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  try { renameSync(temp, path) } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

interface PackageOwner {
  readonly schemaVersion: 1
  readonly pid: number
  readonly token: string
  readonly workerPid?: number
}

function assertAbandoned(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info === undefined) return
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('desktop project: package transaction lock is not a regular file')
  const text = readFileSync(path, 'utf8').trim()
  // A released PID-only writer never held the new guards. Its live/unknown PID
  // remains protected; its missing start identity cannot be reconstructed.
  if (/^[1-9]\d*$/u.test(text)) {
    const pid = Number(text)
    if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) throw new Error('desktop project: invalid package transaction owner')
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    throw new Error(ACTIVE)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('desktop project: invalid package transaction owner') }
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('pid' in value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || !('token' in value) || typeof value.token !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.token)
    || ('workerPid' in value && (!Number.isSafeInteger(value.workerPid) || (value.workerPid as number) <= 0))) {
    throw new Error('desktop project: invalid package transaction owner')
  }
  // Both kernel guards are held by this acquirer. Any new-format record left
  // behind is abandoned, even if the recorded PID now names another process.
}

/** One manager transaction, with the worker guard fencing orphaned pnpm execution. */
export class DesktopPackageLock {
  private constructor(
    readonly path: string, readonly workerPath: string, private readonly guard: PackageGuard, private owner: PackageOwner,
  ) {}

  /**
   * Atomically exclude normal writers and recovery contenders before inspecting metadata.
   * @param path - Profile's diagnostic owner record.
   * @param runtime - Immutable runtime for native POSIX locking.
   * @returns Exclusive transaction ownership.
   */
  static async acquire(path: string, runtime: string): Promise<DesktopPackageLock> {
    const paths = packageGuardPaths(dirname(path))
    const guard = await acquirePackageGuard(paths.owner, runtime)
    try {
      const worker = await acquirePackageGuard(paths.worker, runtime)
      try {
        assertAbandoned(path)
        const owner: PackageOwner = { schemaVersion: 1, pid: process.pid, token: randomUUID() }
        writePackageRecord(path, owner)
        return new DesktopPackageLock(path, paths.worker, guard, owner)
      } finally { await worker.release() }
    } catch (error) { await guard.release(); throw error }
  }

  /**
   * Record the already-guarded worker before granting it permission to run pnpm.
   * @param pid - Ready worker PID, or undefined after its process has closed.
   */
  worker(pid: number | undefined): void {
    this.owner = { schemaVersion: 1, pid: this.owner.pid, token: this.owner.token, ...(pid === undefined ? {} : { workerPid: pid }) }
    writePackageRecord(this.path, this.owner)
  }

  /** Remove the diagnostic record while still holding kernel exclusion. */
  async release(): Promise<void> {
    try { unlinkSync(this.path) } finally { await this.guard.release() }
  }
}
