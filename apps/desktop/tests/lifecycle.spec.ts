/**
 * Desktop lifecycle policy: close-to-tray versus real quit, notification
 * suppression and de-duplication, and the tray controls.
 */

import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  class FakeNotification {
    static supported = true
    static readonly instances: FakeNotification[] = []
    readonly listeners = new Map<string, () => void>()
    readonly show = vi.fn()
    constructor(readonly options: { title: string; body: string }) {
      FakeNotification.instances.push(this)
    }
    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener)
      return this
    }
    click(): void {
      this.listeners.get('click')?.()
    }
    static isSupported(): boolean { return FakeNotification.supported }
    static reset(): void { FakeNotification.instances.length = 0 }
  }
  class FakeTray {
    static readonly instances: FakeTray[] = []
    readonly listeners = new Map<string, () => void>()
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { FakeTray.instances.push(this) }
    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener)
      return this
    }
    emit(event: string): void { this.listeners.get(event)?.() }
    static reset(): void { FakeTray.instances.length = 0 }
  }
  const app = {
    name: 'DeepSeek Harness',
    isPackaged: true,
    getAppPath: () => 'C:\\app',
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
  }
  return {
    FakeNotification, FakeTray, app,
    Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
    nativeImage: {
      createFromPath: vi.fn((path: string) => ({ isEmpty: () => path.includes('missing'), path })),
    },
    powerMonitor: { on: vi.fn() },
    existsSync: vi.fn<(path: string) => boolean>(() => true),
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  Menu: electron.Menu,
  Notification: electron.FakeNotification,
  Tray: electron.FakeTray,
  nativeImage: electron.nativeImage,
  powerMonitor: electron.powerMonitor,
}))
vi.mock('node:fs', () => ({ existsSync: electron.existsSync }))

import { DesktopLifecycle, DESKTOP_APP_USER_MODEL_ID, resolveTrayIconPath } from '../src/lifecycle.ts'
import type { DesktopMessages } from '../src/locale.ts'
import { en } from '../src/locale.ts'

const messages = en as DesktopMessages

/** Build a lifecycle over a controllable fake window. */
function harness(options: { quitting?: boolean; focused?: boolean; window?: boolean } = {}) {
  const quit = vi.fn()
  const activate = vi.fn()
  const window = {
    isDestroyed: () => false,
    isFocused: () => options.focused ?? false,
    isMinimized: () => false,
    hide: vi.fn(),
    restore: vi.fn(),
  }
  const lifecycle = new DesktopLifecycle({
    messages,
    windows: {
      current: () => (options.window === false ? undefined : window as never),
      activate,
    },
    quitting: () => options.quitting ?? false,
    quit,
  })
  return { lifecycle, window, quit, activate }
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.FakeNotification.reset()
  electron.FakeTray.reset()
  electron.existsSync.mockReturnValue(true)
  electron.FakeNotification.supported = true
})

describe('quit versus window close', () => {
  it('turns a window close into a hide so background work keeps running', () => {
    const subject = harness()
    const event = { preventDefault: vi.fn() }
    expect(subject.lifecycle.handleWindowClose(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(subject.window.hide).toHaveBeenCalledOnce()
  })

  it('never hides once the application is quitting, so teardown can finish', () => {
    const subject = harness({ quitting: true })
    const event = { preventDefault: vi.fn() }
    expect(subject.lifecycle.handleWindowClose(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(subject.window.hide).not.toHaveBeenCalled()
  })

  it('hides without a window present rather than failing', () => {
    const subject = harness({ window: false })
    const event = { preventDefault: vi.fn() }
    expect(subject.lifecycle.handleWindowClose(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})

describe('task notifications', () => {
  it('notifies once for a completed task while the window is not focused', () => {
    const subject = harness()
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'completed' })
    expect(electron.FakeNotification.instances).toHaveLength(1)
    expect(electron.FakeNotification.instances[0]!.options).toEqual({
      title: 'DeepSeek Harness',
      body: messages.notificationTaskCompleted,
    })
    expect(electron.FakeNotification.instances[0]!.show).toHaveBeenCalledOnce()
  })

  it('notifies once for a failed task with the failure copy', () => {
    const subject = harness()
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'failed' })
    expect(electron.FakeNotification.instances[0]!.options.body).toBe(messages.notificationTaskFailed)
  })

  it('suppresses the notification while the window is focused', () => {
    const subject = harness({ focused: true })
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'completed' })
    expect(electron.FakeNotification.instances).toHaveLength(0)
  })

  it('notifies when no window exists at all', () => {
    const subject = harness({ window: false })
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'completed' })
    expect(electron.FakeNotification.instances).toHaveLength(1)
  })

  it('stays silent when the platform cannot present a notification', () => {
    electron.FakeNotification.supported = false
    const subject = harness()
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'completed' })
    expect(electron.FakeNotification.instances).toHaveLength(0)
  })

  it('shows and focuses the window when the notification is clicked', () => {
    const subject = harness()
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'completed' })
    electron.FakeNotification.instances[0]!.click()
    expect(subject.activate).toHaveBeenCalledOnce()
  })

  it('never raises a notification after disposal', () => {
    const subject = harness()
    subject.lifecycle.dispose()
    subject.lifecycle.notifyTask({ sessionId: 's1', outcome: 'completed' })
    expect(electron.FakeNotification.instances).toHaveLength(0)
  })
})

describe('tray', () => {
  it('creates the notification-area icon with its menu', () => {
    const subject = harness()
    subject.lifecycle.setup()
    expect(electron.FakeTray.instances).toHaveLength(1)
    const tray = electron.FakeTray.instances[0]!
    expect(tray.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
    const template = electron.Menu.buildFromTemplate.mock.calls[0]![0] as Array<{ label?: string; click?: () => void }>
    expect(template.map(item => item.label ?? '---')).toEqual([
      'DeepSeek Harness', messages.trayOpen, '---', messages.trayQuit,
    ])
    template[1]!.click!()
    expect(subject.activate).toHaveBeenCalledOnce()
  })

  // `DesktopLifecycle.setup` publishes the identity only on win32, where an
  // installed application id is what attributes a native toast; the call is not
  // part of the cross-platform setup path.
  it.skipIf(process.platform !== 'win32')('publishes the Windows toast identity', () => {
    const subject = harness()
    subject.lifecycle.setup()
    expect(electron.app.setAppUserModelId).toHaveBeenCalledWith(DESKTOP_APP_USER_MODEL_ID)
  })

  it('quits only through the tray Quit item', () => {
    const subject = harness()
    subject.lifecycle.setup()
    const template = electron.Menu.buildFromTemplate.mock.calls[0]![0] as Array<{ label?: string; click?: () => void }>
    template[3]!.click!()
    expect(subject.quit).toHaveBeenCalledOnce()
  })

  it('opens the window on a tray double click and on a single click', () => {
    const subject = harness()
    subject.lifecycle.setup()
    const tray = electron.FakeTray.instances[0]!
    tray.emit('double-click')
    expect(subject.activate).toHaveBeenCalledOnce()
    tray.emit('click')
    expect(subject.activate).toHaveBeenCalledTimes(2)
  })

  it('destroys the icon on disposal', () => {
    const subject = harness()
    subject.lifecycle.setup()
    subject.lifecycle.dispose()
    expect(electron.FakeTray.instances[0]!.destroy).toHaveBeenCalledOnce()
  })

  // `installSessionEndGuard` registers the powerMonitor 'shutdown' listener only
  // on win32, where logoff and uninstall must be able to close the application.
  it.skipIf(process.platform !== 'win32')('registers the OS session-end guard so shutdown is never blocked', () => {
    const subject = harness()
    subject.lifecycle.setup()
    expect(electron.powerMonitor.on).toHaveBeenCalledWith('shutdown', expect.any(Function))
    const handler = electron.powerMonitor.on.mock.calls[0]![1] as () => void
    handler()
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(electron.FakeTray.instances[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('survives a tray that cannot be created', () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(electron.Menu.buildFromTemplate).mockImplementationOnce(() => { throw new Error('no notification area') })
    const subject = harness()
    expect(() => { subject.lifecycle.setup() }).not.toThrow()
    expect(failure).toHaveBeenCalled()
    failure.mockRestore()
  })
})

describe('tray icon resolution', () => {
  // The roots are spelled the way the Windows distribution lays them out; the
  // expected value is built with `join`, so the candidate ordering is asserted
  // identically wherever the suite runs instead of assuming a separator.
  const APP_PATH = 'C:\\app'
  const RESOURCES_PATH = 'C:\\resources'

  it('prefers the application path and falls back to the resources path', () => {
    electron.existsSync.mockImplementation((path: string) => path.includes('resources'))
    expect(resolveTrayIconPath(true, APP_PATH, RESOURCES_PATH))
      .toBe(join(RESOURCES_PATH, 'assets', 'icon.ico'))
  })

  it('resolves the shipped asset in a development shell', () => {
    electron.existsSync.mockImplementation((path: string) => path.endsWith('icon.ico'))
    expect(resolveTrayIconPath(false, APP_PATH, RESOURCES_PATH)).toBe(join(APP_PATH, 'assets', 'icon.ico'))
  })

  it('reports no asset when nothing was shipped', () => {
    electron.existsSync.mockReturnValue(false)
    expect(resolveTrayIconPath(true, APP_PATH, RESOURCES_PATH)).toBeUndefined()
  })
})
