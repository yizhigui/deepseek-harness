/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'
import type { DesktopBackendState } from './backend-controller.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  pluginsToggle: 'dsh-desktop:plugins-toggle',
  pluginsDisableAll: 'dsh-desktop:plugins-disable-all',
  /**
   * Plugin-market mutations, addressed by the application document rather than
   * the shell document. The market keeps owning its catalog; a desktop install
   * must own the mutations, so those four calls cross this boundary instead of
   * the market's own HTTP route.
   */
  marketInstall: 'dsh-desktop:market-install',
  marketRemove: 'dsh-desktop:market-remove',
  marketUpdate: 'dsh-desktop:market-update',
  marketInstalled: 'dsh-desktop:market-installed',
  backendStatus: 'dsh-desktop:backend-status',
  backendRetry: 'dsh-desktop:backend-retry',
  applicationRestart: 'dsh-desktop:application-restart',
  configurationReset: 'dsh-desktop:configuration-reset',
  backendState: 'dsh-desktop:backend-state',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
    toggle(name: string, enabled: boolean): Promise<void>
    disableAll(): Promise<void>
  }
  readonly backend: {
    status(): Promise<DesktopBackendState>
    retry(): Promise<void>
    subscribe(listener: (state: DesktopBackendState) => void): () => void
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
}

/** Startup-page controls, unavailable to backend-provided application documents. */
export interface DshDesktopStartupApi extends Pick<DshDesktopApi, 'protocolVersion' | 'locale'> {
  readonly backend: Omit<DshDesktopApi['backend'], 'retry'>
  disablePlugins(): Promise<void>
  restart(): Promise<void>
  resetConfiguration(): Promise<void>
}

/** One installed plugin as the market's installed view reads it. */
export interface DesktopMarketPlugin {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** Outcome of one market mutation, shaped as the market UI expects. */
export interface DesktopMarketMutationResult {
  readonly ok: boolean
  readonly error?: string
}

/**
 * Desktop-owned plugin-market bridge.
 *
 * The application document carries the market's UI, so it — and only it —
 * receives these calls. Each one crosses the preload boundary and lands on the
 * desktop's own package transaction; the renderer never names a command, only a
 * plugin source or an installed plugin identity.
 */
export interface DshDesktopMarketApi {
  install(source: string): Promise<DesktopMarketMutationResult>
  remove(name: string): Promise<DesktopMarketMutationResult>
  update(name: string, version: string): Promise<DesktopMarketMutationResult>
  installed(): Promise<readonly DesktopMarketPlugin[]>
}
