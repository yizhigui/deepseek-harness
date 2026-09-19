/**
 * Desktop-owned configuration under `%APPDATA%\DeepSeekHarness\desktop-config.json`.
 *
 * The desktop shell must decide which Harness home it owns *before* it opens the profile or starts
 * the backend, because `resolveDesktopPaths()` derives the Electron-owned profile and package-manager
 * state from the same home the backend reads. Deriving that home independently in two places would
 * let the shell and its backend disagree about which profile they are using.
 *
 * Precedence, highest first:
 *
 * 1. an absolute `dshHome` in `desktop-config.json`;
 * 2. `$DSH_HOME` inherited from the launching process;
 * 3. the Harness default home, `~/.dsh`.
 *
 * Steps 2 and 3 are the Harness resolution itself: this module never reimplements it, it calls
 * `resolveDshHome` from `@deepseek-ai/dsh-home-paths`, the same helper `paths.ts` and the Harness host
 * already use. The desktop config only gains the ability to outrank the environment, which is what
 * makes the application independent of the parent process that launched it.
 *
 * The resolved value is passed to the backend through the child process environment only. No
 * machine-level or user-level Windows environment variable is read for writing or written.
 *
 * @module @deepseek-ai/dsh-desktop/desktop-config
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** File name of the desktop configuration inside the shell's `%APPDATA%\DeepSeekHarness` directory. */
export const DESKTOP_CONFIG_FILENAME = 'desktop-config.json'

/** Which input decided the resolved Harness home. */
export type DesktopHomeSource = 'desktop-config' | 'environment' | 'default'

/** One resolved Harness home and the input that produced it. */
export interface ResolvedDesktopHome {
  /** Absolute, normalized Harness home passed to `resolveDesktopPaths` and the backend child. */
  readonly home: string
  /** Input that won, for the startup log and diagnostics. */
  readonly source: DesktopHomeSource
  /** Non-fatal problems found while reading the configuration. */
  readonly warnings: readonly string[]
}

/** The configuration path and any problem found while reading it. */
interface ConfigFileRead {
  readonly configured: string | undefined
  readonly warnings: readonly string[]
}

/**
 * Read `desktop-config.json` without ever throwing.
 *
 * A missing file is the compatibility case and stays silent. Unreadable JSON, a non-object root, or a
 * `dshHome` that is not a non-empty string are reported as warnings so the caller can log them; none
 * of them may prevent the application from starting.
 * @param file - Absolute configuration path.
 * @returns The configured home, when one was usable, plus every warning.
 */
function readDesktopConfig(file: string): ConfigFileRead {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing file is the documented compatibility path, not a fault.
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { configured: undefined, warnings: [] }
      : { configured: undefined, warnings: [`could not read ${file}: ${String(code ?? error)}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    return { configured: undefined, warnings: [`${file} is not valid JSON, ignoring it: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { configured: undefined, warnings: [`${file} must contain a JSON object, ignoring it`] }
  }
  const value = (parsed as { dshHome?: unknown }).dshHome
  if (value === undefined) return { configured: undefined, warnings: [] }
  if (typeof value !== 'string' || value.trim() === '') {
    return { configured: undefined, warnings: [`${file}: dshHome must be a non-empty string, ignoring it`] }
  }
  // Tilde forms stay accepted because `resolveDshHome` expands them against the OS home; every other
  // configured home must be absolute so it cannot depend on Electron's working directory.
  if (!isAbsolute(value) && value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) {
    return { configured: undefined, warnings: [`${file}: dshHome must be an absolute path, ignoring ${JSON.stringify(value)}`] }
  }
  return { configured: value, warnings: [] }
}

/**
 * Resolve the Harness home this desktop application owns.
 *
 * Never throws and never mutates the environment: a damaged configuration degrades to the next
 * precedence step and reports why through `warnings`.
 * @param configDirectory - Directory holding `desktop-config.json`.
 * @param environment - Process environment, read for `DSH_HOME` and `APPDATA`.
 * @returns The resolved home, its source, and any configuration warnings.
 */
export function resolveDesktopHome(
  configDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedDesktopHome {
  const { configured, warnings } = readDesktopConfig(resolve(join(configDirectory, DESKTOP_CONFIG_FILENAME)))
  // resolveDshHome owns steps 2 and 3, including the blank-$DSH_HOME case and `~` expansion.
  const home = resolveDshHome(configured, environment)
  if (configured !== undefined) return { home, source: 'desktop-config', warnings }
  const fromEnvironment = environment.DSH_HOME
  const source: DesktopHomeSource = fromEnvironment !== undefined && fromEnvironment.trim().length > 0
    ? 'environment'
    : 'default'
  return { home, source, warnings }
}

/**
 * Build the environment handed to the backend child process.
 *
 * Only `DSH_HOME` is injected, so the backend agrees with the shell about the profile, sessions, and
 * credentials it uses. The OS-home variables are removed at the same time: the backend resolves its
 * own paths from Node's `homedir()`, which reads them, so leaving a parent-process override in place
 * could re-derive a different home inside the child even though `DSH_HOME` is pinned.
 * @param environment - Process environment.
 * @param home - The home resolved by {@link resolveDesktopHome}.
 * @returns A copy of the environment with the resolved home pinned.
 */
export function desktopHostEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const hostEnvironment: NodeJS.ProcessEnv = { ...environment, DSH_HOME: home }
  delete hostEnvironment.HOME
  delete hostEnvironment.HOMEDRIVE
  delete hostEnvironment.HOMEPATH
  return hostEnvironment
}
