/**
 * Desktop shell lifecycle: system-tray presence, terminal-task notifications,
 * and the window-close versus application-quit distinction.
 *
 * Three rules keep this consistent with the rest of the shell:
 *
 * - **Closing a window is not quitting.** The main window's `close` hides it to
 *   the notification area so background work and the Host child survive. Only
 *   the tray's Quit item (or an explicit application quit) tears the backend
 *   down.
 * - **Real quits stay real.** An OS session end, the updater's installer
 *   hand-off, an explicit `quit`, and application relaunch all set the quit
 *   state, so `close` stops intercepting and `before-quit` can run its
 *   teardown. Nothing here blocks shutdown or uninstall.
 * - **Notifications describe one terminal transition.** The signal itself is
 *   already deduplicated once-per-run and never replayed across reconnects (see
 *   `task-signals.ts`); this module adds the presentation policy only.
 * @module lifecycle
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  Tray,
  type BrowserWindow,
  type NativeImage,
} from 'electron'
import type { DesktopMessages } from './locale.ts'
import type { TaskCompletionSignal } from './task-signals.ts'

/** Single Windows AppUserModelID shared with the installed application identity. */
export const DESKTOP_APP_USER_MODEL_ID = 'ai.deepseek.harness'

/** Lifecycle surface `main.ts` provides to the tray and notification policy. */
export interface LifecycleWindowControl {
  /** The live main window, or undefined while it is being recreated. */
  current(): BrowserWindow | undefined
  /** Show, restore, and focus the main window, recreating a destroyed one. */
  activate(): void
}

/** Options for {@link DesktopLifecycle}. */
export interface DesktopLifecycleOptions {
  readonly messages: DesktopMessages
  readonly windows: LifecycleWindowControl
  /** Whether the application is on its way out; close stops hiding once true. */
  readonly quitting: () => boolean
  /** Enter application-quit mode and quit, tearing the backend down once. */
  readonly quit: () => void
}

/**
 * Where the packaged tray icon lives, or undefined when no icon file was
 * shipped. `files` in the electron-builder config includes `assets/`, so a
 * packaged application resolves the first candidate; a development shell is
 * launched with the app directory as its app path, which resolves the second.
 * @param isPackaged - whether the shell runs from a packaged application.
 * @param appPath - `app.getAppPath()`.
 * @param resourcesPath - `process.resourcesPath`.
 * @returns the first existing icon path, or undefined.
 */
export function resolveTrayIconPath(
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string,
): string | undefined {
  const roots = isPackaged ? [appPath, resourcesPath] : [appPath]
  for (const root of roots) {
    for (const name of ['icon.ico', 'icon.png']) {
      const candidate = join(root, 'assets', name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Tray icon, close-to-tray policy, notification policy, and the quit state they
 * share. Every constructor side effect is deferred to {@link setup} so tests can
 * observe the decisions without an Electron runtime.
 */
export class DesktopLifecycle {
  private tray: Tray | undefined
  private disposed = false

  constructor(private readonly options: DesktopLifecycleOptions) {}

  /**
   * Publish the application identity Windows needs for a native toast, open the
   * notification area icon, and remember OS session ends as real quits.
   *
   * Must run after `app.whenReady()`: both `setAppUserModelId` and `Tray`
   * require a ready application.
   * @returns completion; a tray that cannot be created never fails startup.
   */
  setup(): void {
    if (process.platform === 'win32') {
      try {
        // Toast attribution needs the installed identity, not a second id of our
        // own; the packaged app id is the one its shortcut registers.
        app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID)
      } catch (error) {
        console.error('[desktop] could not publish the application identity', error)
      }
    }
    this.installSessionEndGuard()
    try {
      this.createTray()
    } catch (error) {
      // A missing notification area (some kiosk and server sessions) must not
      // stop the application; close-to-tray still hides the window.
      console.error('[desktop] system tray unavailable', error)
    }
  }

  /**
   * The main window's `close` policy.
   * @param event - the window close event being decided.
   * @returns whether the close was turned into a hide.
   */
  handleWindowClose(event: { preventDefault(): void }): boolean {
    if (this.options.quitting()) return false
    event.preventDefault()
    this.hideMainWindow()
    return true
  }

  /**
   * Whether a task outcome should raise a native notification right now.
   *
   * A focused window already shows the outcome, so it is suppressed there; every
   * background state (another window focused, minimized, hidden to the tray)
   * notifies.
   * @returns true when the shell is not the user's active window.
   */
  shouldNotify(): boolean {
    const window = this.options.windows.current()
    if (window === undefined || window.isDestroyed()) return true
    return !window.isFocused()
  }

  /**
   * Raise one Windows native notification for a terminal task outcome.
   * @param signal - the deduplicated terminal signal.
   */
  notifyTask(signal: TaskCompletionSignal): void {
    if (this.disposed) return
    if (!this.shouldNotify()) return
    try {
      if (!Notification.isSupported()) return
      const messages = this.options.messages
      const notification = new Notification({
        title: app.name,
        body: signal.outcome === 'failed'
          ? messages.notificationTaskFailed
          : messages.notificationTaskCompleted,
      })
      notification.on('click', () => { this.options.windows.activate() })
      notification.show()
    } catch (error) {
      console.error('[desktop] task notification failed', error)
    }
  }

  /** Destroy the notification-area icon. */
  dispose(): void {
    this.disposed = true
    this.tray?.destroy()
    this.tray = undefined
  }

  /** Show, restore, and focus the main window. */
  private activate(): void {
    this.options.windows.activate()
  }

  /** Hide the window without destroying it, so the backend keeps running. */
  private hideMainWindow(): void {
    const window = this.options.windows.current()
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.hide()
  }

  /** Create the tray icon and its menu, preferring the shipped asset. */
  private createTray(): void {
    const icon = this.trayImage()
    this.tray = icon === undefined ? new Tray(this.fallbackImage()) : new Tray(icon)
    this.tray.setToolTip(app.name)
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: app.name, enabled: false },
      { label: this.options.messages.trayOpen, click: () => { this.activate() } },
      { type: 'separator' },
      { label: this.options.messages.trayQuit, click: () => { this.options.quit() } },
    ]))
    this.tray.on('double-click', () => { this.activate() })
    this.tray.on('click', () => { this.activate() })
  }

  /** The packaged or development icon asset, when one is on disk. */
  private trayImage(): NativeImage | undefined {
    const path = resolveTrayIconPath(app.isPackaged, app.getAppPath(), process.resourcesPath)
    if (path === undefined) return undefined
    const image = nativeImage.createFromPath(path)
    return image.isEmpty() ? undefined : image
  }

  /**
   * Last-resort tray image: the executable's own embedded icon. A `Tray` never
   * accepts an empty image, so this keeps the icon present even without an asset.
   */
  private fallbackImage(): NativeImage {
    return nativeImage.createFromPath(process.execPath)
  }

  /**
   * Treat a Windows session end as an application quit. `close` must stop hiding
   * the window once shutdown starts, or logoff and uninstall could be held open
   * by an application that refuses to disappear.
   */
  private installSessionEndGuard(): void {
    if (process.platform !== 'win32') return
    powerMonitor.on('shutdown', () => {
      this.dispose()
      app.quit()
    })
  }
}
