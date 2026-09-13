/**
 * Desktop shell logging owned by the Electron main process.
 *
 * The shell has two independent diagnostic sinks:
 *
 * 1. `DSH_DESKTOP_DIAGNOSTIC_FILE` — the pre-existing single-file fatal-startup hook, kept as-is.
 * 2. `DSH_DESKTOP_LOG_DIR` — an optional rotating-ish append log with a stderr mirror, used by the
 *    add-on Windows launcher so a windowed build leaves a record under
 *    `%APPDATA%\DeepSeekHarness\logs\`.
 *
 * This module is deliberately self-contained: it uses only `node:` builtins and must never import a
 * dependency, because the shell is bundled into `app.asar` and the packaged dsh runtime's
 * `node_modules` is not resolvable from the shell's module graph.
 *
 * Secrets are never written through this module by construction: the shell logs lifecycle facts and
 * backend error messages only. Model credentials stay in the Harness credential system
 * (`$DSH_HOME/.credentials.yaml`) and are never read by the shell.
 *
 * @module @deepseek-ai/dsh-desktop/logger
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Longest diagnostic line this module writes, in characters. */
const MAX_LINE_CHARACTERS = 4_000

/** Active log file, or undefined when logging is disabled. */
let activeLogFile: string | undefined

/** Whether logger initialization already reported its own failure. */
let initializationFailureReported = false

function describe(value: unknown): string {
  if (value instanceof Error) {
    const stack = value.stack ?? `${value.name}: ${value.message}`
    return value.cause === undefined ? stack : `${stack}\nCaused by: ${describe(value.cause)}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Resolve the log directory when no explicit override is configured.
 *
 * A packaged Windows application cannot carry an environment variable, and the portable executable
 * has no launcher to set one, so the shell computes this default itself. Windows uses the stable
 * `%APPDATA%\DeepSeekHarness\logs` location independent of Electron's product-name-derived user-data
 * directory; other platforms fall back to the Electron user-data directory.
 * @param environment - Process environment.
 * @param userDataPath - `app.getPath('userData')` from the Electron main process.
 * @returns Absolute log directory.
 */
export function defaultShellLogDirectory(environment: NodeJS.ProcessEnv, userDataPath: string): string {
  const appData = environment.APPDATA
  return appData === undefined || appData.trim() === ''
    ? join(userDataPath, 'logs')
    : join(appData, 'DeepSeekHarness', 'logs')
}

/**
 * Initialize the optional shell log.
 *
 * Creates the directory when needed. A directory that cannot be created disables logging instead of
 * failing startup: diagnostics must never be the reason the application cannot open a window.
 * @param directory - Absolute log directory, normally `DSH_DESKTOP_LOG_DIR`.
 * @param fileName - Log file name inside that directory.
 * @returns The active log file, or undefined when logging is unavailable.
 */
export function initializeShellLog(directory: string | undefined, fileName = 'desktop.log'): string | undefined {
  if (directory === undefined || directory.trim() === '') return undefined
  const file = join(directory, fileName)
  try {
    mkdirSync(directory, { recursive: true })
    activeLogFile = file
    writeShellLog('----- DeepSeek Harness desktop started -----')
    return file
  } catch (error: unknown) {
    activeLogFile = undefined
    if (!initializationFailureReported) {
      initializationFailureReported = true
      console.error(`dsh desktop: could not initialize ${file}: ${describe(error)}`)
    }
    return undefined
  }
}

/**
 * Append one timestamped record to the active log and mirror it to stderr.
 *
 * Writing is best-effort: a full disk or a removed directory must not interrupt the application.
 * @param message - Diagnostic text to record.
 */
export function writeShellLog(message: string): void {
  const line = `${new Date().toISOString()} ${message}`.slice(0, MAX_LINE_CHARACTERS)
  console.error(line)
  const file = activeLogFile
  if (file === undefined) return
  try {
    appendFileSync(file, `${line}\n`)
  } catch {
    // Diagnostics are best-effort; the stderr mirror above already emitted the record.
  }
}

/** Path of the active log file, or undefined when logging is disabled. */
export function shellLogFile(): string | undefined {
  return activeLogFile
}
