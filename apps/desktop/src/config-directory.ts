/**
 * Shared location of everything the Electron shell owns under the user's application data.
 *
 * Windows uses `%APPDATA%\DeepSeekHarness`, deliberately independent of Electron's
 * product-name-derived user-data directory so that renaming the product cannot strand shell state.
 * Other platforms fall back to the Electron user-data directory, which keeps a single shell-owned
 * root on every platform.
 *
 * @module @deepseek-ai/dsh-desktop/config-directory
 */

import { join } from 'node:path'

/** Directory name created under `%APPDATA%` on Windows. */
export const DESKTOP_APPDATA_DIR_NAME = 'DeepSeekHarness'

/**
 * Resolve the Electron-owned configuration directory.
 * @param environment - Process environment.
 * @param userDataPath - `app.getPath('userData')` from the Electron main process.
 * @returns Absolute configuration directory.
 */
export function desktopConfigDirectory(environment: NodeJS.ProcessEnv, userDataPath: string): string {
  const appData = environment.APPDATA
  return appData === undefined || appData.trim() === ''
    ? join(userDataPath, 'desktop-config')
    : join(appData, DESKTOP_APPDATA_DIR_NAME)
}

/**
 * Resolve the shell log directory.
 *
 * Lives beside {@link desktopConfigDirectory} so one directory holds the shell's configuration and
 * its diagnostics.
 * @param environment - Process environment.
 * @param userDataPath - `app.getPath('userData')` from the Electron main process.
 * @returns Absolute log directory, or undefined when no explicit log directory is configured.
 */
export function defaultShellLogDirectory(environment: NodeJS.ProcessEnv, userDataPath: string): string {
  return join(desktopConfigDirectory(environment, userDataPath), 'logs')
}
