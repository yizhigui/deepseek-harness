/**
 * Carrier for a shell-owned native opener (Electron `shell.showItemInFolder` /
 * `shell.openPath`) inside a Host process that has no display of its own.
 *
 * A Host that runs under the Electron desktop shell cannot observe a desktop
 * directly: the bundled Node child has no `shell` module, and spawning
 * `explorer.exe` from it selects nothing on current Windows builds. The shell
 * therefore registers one bridge on `globalThis` before it composes the Host,
 * and the path openers below prefer it over any spawned command.
 *
 * The process global is the carrier because the Host package graph is loaded
 * dynamically (profiles, loader entries) while the reaching code lives in this
 * leaf package, which must not depend on an application. `Symbol.for` keeps the
 * key stable across duplicate package instances in one process.
 * @module @deepseek-ai/dsh-native-command/desktop-bridge
 */

/** Native path operations only a GUI shell can perform. */
export interface NativeDesktopBridge {
  /**
   * Show one file in the platform file manager with the item selected, or open
   * the folder itself when the path names a directory.
   * @param path - absolute, host-resolved path.
   * @param signal - caller/connection lifetime.
   */
  reveal(path: string, signal: AbortSignal): Promise<void>
  /**
   * Open one path with the operating system's registered application.
   * @param path - absolute, host-resolved path.
   * @param signal - caller/connection lifetime.
   */
  open(path: string, signal: AbortSignal): Promise<void>
}

/**
 * Process-wide registry of the shell's native opener. A `Map` on one
 * `Symbol.for` key keeps registration stable across duplicate package instances
 * in one process without dynamic property deletion.
 */
const BRIDGES = new Map<symbol, NativeDesktopBridge>()
const BRIDGE_KEY = Symbol.for('dsh.native-command.desktopBridge')

/**
 * Install the shell's native opener for this process.
 * @param bridge - the GUI shell implementation.
 * @returns a disposer restoring the previous registration.
 */
export function registerNativeDesktopBridge(bridge: NativeDesktopBridge): () => void {
  const previous = BRIDGES.get(BRIDGE_KEY)
  BRIDGES.set(BRIDGE_KEY, bridge)
  return () => {
    if (previous === undefined) BRIDGES.delete(BRIDGE_KEY)
    else BRIDGES.set(BRIDGE_KEY, previous)
  }
}

/**
 * Read the installed shell bridge, when this process runs under a GUI shell.
 * @returns the registered bridge, or undefined for an ordinary Host.
 */
export function nativeDesktopBridge(): NativeDesktopBridge | undefined {
  return BRIDGES.get(BRIDGE_KEY)
}
