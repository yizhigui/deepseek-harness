/**
 * Host-child side of the shell's native path opener.
 *
 * The Host process has no display and no Electron `shell` module, so a reveal
 * request must reach the Electron process that owns the window. The byte pipe
 * already carries `dsh-app://` traffic, so the request rides it as one reserved
 * path: the Electron protocol handler answers it and the Host child never sees
 * it. Registration installs a {@link NativeDesktopBridge}, which makes
 * `revealNativePath`/`openNativePath` prefer the shell over a spawned command.
 * @module native-bridge
 */

import { registerNativeDesktopBridge, type NativeDesktopBridge } from '@deepseek-ai/dsh-native-command'
/** Reserved loopback path the Electron protocol handler answers instead of the Host. */
export const DESKTOP_NATIVE_PATH = '/.dsh/native-path'

/** Operations the reserved path accepts. */
export type DesktopNativeOperation = 'reveal' | 'open'

/** One native path request as it crosses the pipe. */
export interface DesktopNativeRequest {
  readonly operation: DesktopNativeOperation
  readonly path: string
}

/** Reply the shell returns for one native path request. */
interface DesktopNativeReply {
  readonly ok: boolean
  readonly message?: string
}

/** The single Electron origin any `dsh-app:` request is addressed to. */
const OWN_ORIGIN = 'dsh-app://app'
/**
 * Perform one native operation through the shell.
 *
 * A refused or failed operation rejects with the shell's message, so the
 * requesting route can report it rather than acknowledging a reveal that never
 * happened.
 * @param request - operation and absolute path.
 * @param signal - caller/connection lifetime.
 * @returns completion after the shell has answered.
 */
export async function requestNativeOperation(request: DesktopNativeRequest, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${OWN_ORIGIN}${DESKTOP_NATIVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  let reply: DesktopNativeReply
  try {
    reply = await response.json() as DesktopNativeReply
  } catch {
    throw new Error(`desktop native path request failed: HTTP ${String(response.status)}`)
  }
  if (reply.ok) return
  throw new Error(reply.message === undefined || reply.message === ''
    ? 'the desktop shell refused the native path request'
    : reply.message)
}

/**
 * Install the shell-backed native opener for this Host process.
 * @returns the disposer restoring the previous registration.
 */
export function installNativeDesktopBridge(): () => void {
  const bridge: NativeDesktopBridge = {
    reveal: (path, signal) => requestNativeOperation({ operation: 'reveal', path }, signal),
    open: (path, signal) => requestNativeOperation({ operation: 'open', path }, signal),
  }
  return registerNativeDesktopBridge(bridge)
}
