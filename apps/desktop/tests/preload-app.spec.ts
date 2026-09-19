/**
 * The shell documents' preload boundary.
 *
 * Two documents load this preload and each receives a different, deliberately
 * narrow surface: the shell's startup page gets the startup controls, and the
 * application document — which carries the plugin market's browser half — gets
 * the carrier marker plus the market's mutation bridge, and nothing else.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopStartupApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
  // Mirrors `webFrame.executeJavaScript(source)` so the recorded call keeps its
  // source argument typed; a zero-parameter mock widens the call tuple to [].
  webFrame: { executeJavaScript: vi.fn((_source: string) => Promise.resolve()) },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

it('gives the startup document controls, not the market bridge', async () => {
  vi.stubGlobal('location', new URL('dsh-app://shell/startup.html'))
  await import('../src/preload-app.ts')
  // The mock's call list carries `any`, so narrow it once at the boundary: the
  // recorded arguments are asserted below, not returned.
  const calls = electron.contextBridge.exposeInMainWorld.mock.calls as unknown[][]
  expect(calls.map(call => call[0])).toEqual(['dshDesktop'])
  const api = calls[0]?.[1] as DshDesktopStartupApi
  await api.locale()
  await api.backend.status()
  await api.disablePlugins()
  await api.resetConfiguration()
  await api.restart()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.localeGet], [DESKTOP_IPC.backendStatus],
    [DESKTOP_IPC.pluginsDisableAll], [DESKTOP_IPC.configurationReset], [DESKTOP_IPC.applicationRestart],
  ])
  const listener = vi.fn()
  const dispose = api.backend.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls[0]?.[1] as (event: unknown, state: unknown) => void
  handler({}, { phase: 'error', message: 'startup failed' })
  expect(listener).toHaveBeenCalledWith({ phase: 'error', message: 'startup failed' })
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.backendState, handler)
  expect(api).not.toHaveProperty('plugins')
  expect(api).not.toHaveProperty('market')
})

it('gives the application document the market bridge and no startup controls', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  // The mock's call list carries `any`, so narrow it once at the boundary: the
  // recorded arguments are asserted below, not returned.
  const calls = electron.contextBridge.exposeInMainWorld.mock.calls as unknown[][]
  expect(calls.map(call => call[0])).toEqual(['dshDesktop', '__dshMarketBridge'])
  expect(calls[0]?.[1]).toEqual({ protocolVersion: 1, market: expect.any(Object) as unknown })
  const bridge = calls[1]?.[1] as {
    install(source: string): Promise<unknown>
    remove(name: string): Promise<unknown>
    update(name: string, version: string): Promise<unknown>
    installed(): Promise<unknown>
  }
  await bridge.install('dsh-context')
  await bridge.remove('dsh-context')
  await bridge.update('dsh-context', '1.0.0')
  await bridge.installed()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.marketInstall, 'dsh-context'],
    [DESKTOP_IPC.marketRemove, 'dsh-context'],
    [DESKTOP_IPC.marketUpdate, 'dsh-context', '1.0.0'],
    [DESKTOP_IPC.marketInstalled],
  ])
  // The application document never receives the shell's own plugin controls.
  const startup = calls[0]?.[1] as Record<string, unknown>
  expect(startup).not.toHaveProperty('plugins')
  expect(startup).not.toHaveProperty('disablePlugins')
  expect(startup).not.toHaveProperty('resetConfiguration')
})

it('patches the market mutation and installed routes in the page realm only', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  expect(electron.webFrame.executeJavaScript).toHaveBeenCalledTimes(1)
  const source = String(electron.webFrame.executeJavaScript.mock.calls[0]?.[0])
  // The page-realm patch redirects mutations and mirrors the installed view.
  expect(source).toContain('/dsh-market/install')
  expect(source).toContain('/dsh-market/uninstall')
  expect(source).toContain('/dsh-market/update')
  expect(source).toContain('/dsh-market/installed')
  expect(source).toContain('/dsh-market/status')
  expect(source).toContain('__dshMarketBridge')
})

it('does not touch the page realm for a shell document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://shell/startup.html'))
  await import('../src/preload-app.ts')
  expect(electron.webFrame.executeJavaScript).not.toHaveBeenCalled()
})
