/**
 * Startup controls for shell documents, plus the plugin-market mutation bridge
 * for application documents.
 *
 * The application document carries the plugin market's browser half, whose own
 * HTTP mutation route is unusable in this shell: `/dsh-market/install` is
 * guarded by an HTTP same-origin check a `dsh-app://` document can never
 * satisfy, and it would install with an externally provisioned pnpm. Those
 * mutations therefore cross this preload boundary instead, landing on the
 * desktop's own package transaction.
 *
 * Nothing else is added for application documents: no filesystem, no
 * `child_process`, no Node integration. The renderer names a plugin source or an
 * installed plugin identity, and the shell decides what that means.
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  DESKTOP_IPC,
  type DesktopMarketMutationResult,
  type DesktopMarketPlugin,
  type DshDesktopMarketApi,
  type DshDesktopStartupApi,
} from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'

const startup: DshDesktopStartupApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopStartupApi['locale']>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopStartupApi['backend']['status']>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

/** Desktop-owned plugin-market mutations, for the application document only. */
const market: DshDesktopMarketApi = {
  install: source => ipcRenderer.invoke(DESKTOP_IPC.marketInstall, source) as Promise<DesktopMarketMutationResult>,
  remove: name => ipcRenderer.invoke(DESKTOP_IPC.marketRemove, name) as Promise<DesktopMarketMutationResult>,
  update: (name, version) => ipcRenderer.invoke(DESKTOP_IPC.marketUpdate, name, version) as Promise<DesktopMarketMutationResult>,
  installed: () => ipcRenderer.invoke(DESKTOP_IPC.marketInstalled) as Promise<readonly DesktopMarketPlugin[]>,
}

contextBridge.exposeInMainWorld('dshDesktop', location.protocol === 'dsh-app:' && location.hostname === 'shell'
  ? startup
  : { protocolVersion: 1, market })

/**
 * Route the market's mutation endpoints into the desktop transaction.
 *
 * The market UI runs in this document and calls its own HTTP routes for
 * mutations. In this shell those routes cannot work — `/dsh-market/install` is
 * behind an HTTP same-origin check a `dsh-app://` document cannot satisfy, and
 * it would install with an externally provisioned pnpm — while every read-only
 * route (`registry`, `status`, `installed`) is reached through the socket-free
 * seat and keeps working.
 *
 * Only the three mutation paths are redirected, and each one is answered with
 * the same JSON shape the market's own route returns, so the market's catalog,
 * cards, search, and metadata stay exactly as they are. A failure is reported
 * as `{ ok: false, error }` where the HTTP route would have answered 4xx.
 */
if (!(location.protocol === 'dsh-app:' && location.hostname === 'shell')) {
  // Hand the page realm a narrow, name-only surface; the page script below
  // cannot see preload bindings directly.
  contextBridge.exposeInMainWorld('__dshMarketBridge', {
    install: (source: string) => market.install(source),
    remove: (name: string) => market.remove(name),
    update: (name: string, version: string) => market.update(name, version),
    installed: () => market.installed(),
  })
  // The patch must exist in the page's own realm before the market bundle runs.
  webFrame.executeJavaScript(`(() => {
    const routes = {
      '/dsh-market/install': 'install',
      '/dsh-market/uninstall': 'remove',
      '/dsh-market/update': 'update',
    }
    const original = window.fetch
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : (input && input.url) || ''
      let url = null
      try { url = new URL(raw, location.href) } catch { url = null }
      const pathname = url === null ? '' : url.pathname
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      if (method !== 'POST' || routes[pathname] === undefined) {
        const response = await original(input, init)
        if (pathname === '/dsh-market/status' && response.ok) {
          // The market gates its Install/Update actions on this one capability
          // bit. In this shell the desktop owns the package transaction and its
          // own bundled pnpm, so the answer is yes regardless of what the host
          // can probe on PATH. Everything else the probe reports stays as-is.
          try {
            const status = await response.clone().json()
            if (status === null || typeof status !== 'object') return response
            return new Response(JSON.stringify({ ...status, pnpm: true }), {
              status: response.status,
              headers: { 'content-type': 'application/json' },
            })
          } catch { return response }
        }
        if (pathname === '/dsh-market/installed' && response.ok) {
          // The market renders its installed list from this route, which reports
          // the market's own profile. A desktop install lands in the desktop
          // profile instead, so the authoritative list is the shell's, reported
          // in the shape this route's reader expects.
          try {
            const bridge = globalThis.__dshMarketBridge
            if (!bridge) return response
            const plugins = await bridge.installed()
            const installed = {}
            const present = []
            const disabled = []
            for (const plugin of plugins) {
              installed[plugin.name] = plugin.version
              present.push(plugin.name)
              if (plugin.enabled !== true) disabled.push(plugin.name)
            }
            return new Response(JSON.stringify({ installed, present, disabled, bundles: present, live: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          } catch { return response }
        }
        return response
      }
      let body = {}
      try { body = JSON.parse((init && init.body) || '{}') } catch { body = {} }
      const bridge = globalThis.__dshMarketBridge
      if (!bridge) return original(input, init)
      const action = routes[pathname]
      const outcome = action === 'install'
        ? await bridge.install(body.url)
        : action === 'remove'
          ? await bridge.remove(body.name)
          : await bridge.update(body.name, body.version)
      return new Response(JSON.stringify(outcome), {
        status: outcome && outcome.ok ? 200 : 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    globalThis.__dshMarketFetchPatched = true
  })()`).catch((error: unknown) => { console.error('[desktop] market bridge patch failed', error) })
}
