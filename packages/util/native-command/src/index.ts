/**
 * Host-native command execution and path-opening utilities.
 * @module @deepseek-ai/dsh-native-command
 */

export { runNativeCommand } from './runner.ts'
export type { NativeCommandRunner } from './runner.ts'
export {
  canOpenNativePath,
  nativeFileManager,
  revealNativePath,
  openNativePath,
  openNativeTextFile,
} from './path-opener.ts'
export type {
  NativeFileManager,
  PathOpenerInternals,
  PathOpenerRunner,
} from './path-opener.ts'
export { nativeDesktopBridge, registerNativeDesktopBridge } from './desktop-bridge.ts'
export type { NativeDesktopBridge } from './desktop-bridge.ts'
