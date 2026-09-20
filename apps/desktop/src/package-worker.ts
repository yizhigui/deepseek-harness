/** Self-contained upstream-Node bootstrap; it also runs when the shell lives inside app.asar. */

// The worker holds its own kernel guard before requesting the parent's grant.
// IPC loss before that grant exits without importing pnpm. Afterwards the guard
// survives the shell and remains held until pnpm's process exits, not just until
// its ESM entry returns. No Electron/native shell ABI crosses this process boundary.
/** Pnpm bootstrap kept inline so upstream Node never needs to read Electron's app.asar. */
export const PACKAGE_WORKER_SOURCE = String.raw`
const { createServer } = await import('node:net')
const { createHash } = await import('node:crypto')
const { open, stat, lstat } = await import('node:fs/promises')
const { createRequire } = await import('node:module')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')
const [guardPath, runtime, pnpm, ...args] = process.argv.slice(1)
const disconnected = () => process.exit(1)
process.once('disconnect', disconnected)
let held
try {
  if (process.platform === 'win32') {
    const name = '\\\\.\\pipe\\dsh-packages-' + createHash('sha256').update(guardPath.toLowerCase()).digest('hex')
    held = createServer(socket => socket.destroy())
    await new Promise((resolve, reject) => { held.once('error', reject); held.listen(name, resolve) })
    held.unref()
  } else {
    const info = await lstat(guardPath).catch(error => { if(error.code !== 'ENOENT') throw error })
    if (info && !info.isFile()) throw new Error('invalid package worker guard')
    held = await open(guardPath, 'a+', 0o600)
    await createRequire(join(runtime, 'package.json'))('@deepseek-ai/node-addon-system/flock').tryLockExclusive(held.fd)
    const ours = await held.stat({bigint:true}), current = await stat(guardPath, {bigint:true})
    if(ours.ino !== current.ino || ours.dev !== current.dev) throw new Error('package worker guard was replaced')
  }
  process.on('exit', () => { void held })
  const granted = new Promise(resolve => process.once('message', resolve))
  if (!process.connected) process.exit(1)
  process.send({type:'package-worker-ready'})
  const message = await granted
  if(message?.type !== 'run') throw new Error('invalid package worker grant')
  process.removeListener('disconnect', disconnected)
  process.disconnect()
  // Pnpm's Worker threads must inherit the direct CLI's flags, not --eval/--input-type.
  process.execArgv = []
  process.argv = [process.execPath, pnpm, ...args]
  await import(pathToFileURL(pnpm).href)
} catch(error) {
  console.error(error)
  process.exit(1)
}
`
