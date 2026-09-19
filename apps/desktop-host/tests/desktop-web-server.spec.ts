/**
 * Socket-free desktop plugin route seat.
 *
 * These cases exercise the exact handler shapes the installed market plugin
 * registers (`node:http` request/response, method guards, `sendJson`, a prefix
 * asset route, and an awaited body read), because that plugin is the reason the
 * seat exists: without it a plugin declaring `inject: ['webServer']` never
 * activates and its routes never mount.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopWebServer, nodeRequestOf, nodeResponseOf,
} from '../src/desktop-web-server.ts'

/** A seat wired to a real Cordis context, disposed by the caller's test. */
function seat(): DesktopWebServer {
  return new DesktopWebServer(new Context())
}

/** The JSON response helper the market plugin uses. */
function sendJson(response: import('node:http').ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

describe('desktop plugin web server seat', () => {
  it('registers itself as the webServer service on the given context', () => {
    const root = new Context()
    // The seat registers through the Cordis `Service` constructor, which is what a
    // plugin's `inject: ['webServer']` resolves against.
    expect(() => new DesktopWebServer(root)).not.toThrow()
    expect(root.get('webServer')).toBeDefined()
  })

  it('matches the market registry route and returns its JSON, not a fallback document', async () => {
    const server = seat()
    server.register({
      kind: 'exact',
      path: '/dsh-market/registry',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, { plugins: [{ name: 'dsh-market-probe' }], categories: ['probe'] })
      },
    })
    const response = await server.fetch(new Request('dsh-app://app/dsh-market/registry'))
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response?.headers.get('cache-control')).toBe('no-store')
    await expect(response?.json()).resolves.toEqual({
      plugins: [{ name: 'dsh-market-probe' }],
      categories: ['probe'],
    })
  })

  it('runs the handler method guard instead of answering on the plugin\'s behalf', async () => {
    const server = seat()
    const reached = vi.fn()
    server.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: (request, response) => {
        reached(request.method)
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, {})
      },
    })
    const response = await server.fetch(new Request('dsh-app://app/dsh-market/status', { method: 'POST' }))
    // The seat must route any method to the handler, which owns its own guard.
    expect(reached).toHaveBeenCalledWith('POST')
    expect(response?.status).toBe(405)
  })

  it('delivers a request body to a handler that awaits it', async () => {
    const server = seat()
    const seen = vi.fn()
    server.register({
      kind: 'exact',
      path: '/dsh-market/install',
      handler: async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk)
        const body = Buffer.concat(chunks).toString('utf8')
        seen(body)
        sendJson(response, 200, { echoed: body })
      },
    })
    const response = await server.fetch(new Request('dsh-app://app/dsh-market/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dsh-market-probe' }),
    }))
    expect(seen).toHaveBeenCalledWith('{"source":"dsh-market-probe"}')
    await expect(response?.json()).resolves.toEqual({ echoed: '{"source":"dsh-market-probe"}' })
  })

  it('matches a prefix route on the prefix itself and on a nested path', async () => {
    const server = seat()
    server.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(`bundle:${new URL(String(request.url), 'http://dsh.internal').pathname}`)
      },
    })
    const direct = await server.fetch(new Request('dsh-app://app/plugins'))
    expect(await direct?.text()).toBe('bundle:/plugins')
    const nested = await server.fetch(new Request('dsh-app://app/plugins/chat/client.js'))
    expect(await nested?.text()).toBe('bundle:/plugins/chat/client.js')
  })

  it('prefers the longest matching prefix', async () => {
    const server = seat()
    server.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (_request, response) => { response.end('short') },
    })
    server.register({
      kind: 'prefix',
      path: '/plugins/events',
      handler: (_request, response) => { response.end('long') },
    })
    const response = await server.fetch(new Request('dsh-app://app/plugins/events'))
    expect(await response?.text()).toBe('long')
  })

  it('prefers an exact route over a prefix route for the same path', async () => {
    const server = seat()
    server.register({
      kind: 'prefix',
      path: '/dsh-market',
      handler: (_request, response) => { response.end('prefix') },
    })
    server.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: (_request, response) => { response.end('exact') },
    })
    const response = await server.fetch(new Request('dsh-app://app/dsh-market/status'))
    expect(await response?.text()).toBe('exact')
  })

  it('declines a path no route claims so the Host can keep its static fallback', async () => {
    const server = seat()
    server.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: (_request, response) => { response.end('{}') },
    })
    await expect(server.fetch(new Request('dsh-app://app/index.html'))).resolves.toBeUndefined()
    await expect(server.fetch(new Request('dsh-app://app/assets/app.js'))).resolves.toBeUndefined()
  })

  it('serves a claimed fallback seat for unmatched paths', async () => {
    const server = seat()
    server.registerFallback((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>fallback</html>')
    })
    const response = await server.fetch(new Request('dsh-app://app/anything/else'))
    expect(await response?.text()).toBe('<html>fallback</html>')
  })

  it('rejects duplicate registrations and a second fallback seat', () => {
    const server = seat()
    const route = { kind: 'exact' as const, path: '/dsh-market/status', handler: () => {} }
    server.register(route)
    expect(() => server.register({ ...route })).toThrow('duplicate exact route "/dsh-market/status"')
    server.registerFallback(() => {})
    expect(() => server.registerFallback(() => {})).toThrow('fallback already registered')
  })

  it('unregisters a route through its disposer', async () => {
    const server = seat()
    const dispose = server.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: (_request, response) => { response.end('{}') },
    })
    expect(server.ownsRoutes).toBe(true)
    dispose()
    await expect(server.fetch(new Request('dsh-app://app/dsh-market/status'))).resolves.toBeUndefined()
  })

  it('tracks an upgrade registration without dispatching it, since Desktop hands over no socket', () => {
    const server = seat()
    const dispose = server.registerUpgrade({ path: '/api/remote.mux', handler: () => {} })
    expect(() => server.registerUpgrade({ path: '/api/remote.mux', handler: () => {} }))
      .toThrow('duplicate upgrade route "/api/remote.mux"')
    expect(() => { dispose() }).not.toThrow()
  })

  it('ends a response for a handler that answered without ending it', async () => {
    const server = seat()
    server.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: (_request, response) => {
        response.writeHead(201, { 'content-type': 'text/plain' })
        response.write('partial')
      },
    })
    const response = await server.fetch(new Request('dsh-app://app/dsh-market/status'))
    expect(response?.status).toBe(201)
    expect(await response?.text()).toBe('partial')
  })

  it('reports the listener facts the seat never binds', () => {
    const server = seat()
    expect(server.host).toBe('127.0.0.1')
    expect(server.port).toBe(0)
    expect(server.ownsRoutes).toBe(false)
    expect(() => { server.tapIndex() }).not.toThrow()
  })
})

describe('node request and response adaptation', () => {
  it('presents method, pathname, query, and headers to a handler', () => {
    const url = new URL('dsh-app://app/dsh-market/registry?force=1')
    const request = nodeRequestOf(
      new Request('dsh-app://app/dsh-market/registry?force=1', { method: 'POST', headers: { 'x-probe': 'yes' } }),
      url,
      Buffer.from('body'),
    )
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/dsh-market/registry?force=1')
    expect(request.headers['x-probe']).toBe('yes')
  })

  it('ends an empty request stream so `for await` terminates', async () => {
    const request = nodeRequestOf(
      new Request('dsh-app://app/x'),
      new URL('dsh-app://app/x'),
      null,
    )
    const chunks: Buffer[] = []
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk)
    expect(chunks).toHaveLength(0)
  })

  it('captures the status and headers a handler declares with writeHead', async () => {
    const request = nodeRequestOf(new Request('dsh-app://app/x'), new URL('dsh-app://app/x'), null)
    const { response, sink, head } = nodeResponseOf(request)
    response.writeHead(202, { 'content-type': 'text/plain' })
    const declared = head()
    response.write('one')
    response.end('two')
    // `end(payload)` serializes after the header block, which the sink discards,
    // so the collected bytes are exactly the body.
    await new Promise(resolve => setImmediate(resolve))
    expect(Buffer.concat(sink.chunks).toString('utf8')).toBe('onetwo')
    // `writeHead` stops reporting these fields on the response itself, so the
    // captured head is the only place they survive.
    expect(declared.status).toBe(202)
    expect(declared.headers.get('content-type')).toBe('text/plain')
  })

  it('captures status and headers set through the accessors, as sendJson does', async () => {
    const request = nodeRequestOf(new Request('dsh-app://app/x'), new URL('dsh-app://app/x'), null)
    const { response, sink, head } = nodeResponseOf(request)
    response.statusCode = 200
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end('{"a":1}')
    // `head` reads the declared status and headers only; the body comes from the sink.
    const declared = head()
    expect(declared.status).toBe(200)
    expect(declared.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(declared.headers.get('cache-control')).toBe('no-store')
    await new Promise(resolve => setImmediate(resolve))
    expect(Buffer.concat(sink.chunks).toString('utf8')).toBe('{"a":1}')
  })
})
