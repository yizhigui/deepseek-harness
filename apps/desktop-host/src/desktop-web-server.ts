/**
 * Socket-free `webServer` seat for the Electron Host child.
 *
 * The shared Web composition mounts plugin HTTP routes on `ctx.webServer`, a
 * `node:http` listener. Desktop composes no listener by design (every byte
 * crosses the Electron byte pipes instead), so a plugin whose host half
 * declares `inject: ['webServer']` never activates and its routes never mount —
 * its frontend then reads a static fallback document where it expected JSON.
 *
 * This seat keeps the registration contract while owning no socket: routes are
 * matched in-process and dispatched from the Host's existing fetch pipeline, so
 * plugin routes reach the renderer over the same carrier as `/api`. Match order
 * mirrors the listener implementation (exact, then longest prefix, then one
 * fallback seat) and duplicate registration throws the same way, so a route
 * behaves identically on either carrier.
 *
 * Handlers are ordinary `node:http` handlers. The response side is a real
 * `ServerResponse` bound to an in-memory `PassThrough` instead of a socket, so
 * header and body semantics (streaming, backpressure, `write`/`end` overloads,
 * implicit chunked encoding) stay Node's rather than a reimplementation's.
 * @module desktop-web-server
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import type { Socket } from 'node:net'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebRouteKind, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

/** Registration contract shared with the listening `webServer` service. */
export interface DesktopWebRoute {
  readonly kind: WebRouteKind
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Address facts `ServerResponse` reads from its socket. */
function socketFacts(): Record<string, unknown> {
  return {
    remoteAddress: '127.0.0.1',
    remotePort: 0,
    localAddress: '127.0.0.1',
    localPort: 0,
  }
}

/**
 * Capture the status line and header set a handler produced.
 *
 * `node:http` moves a `writeHead(status, headers)` straight into the serialized
 * response and then stops reporting those fields, so a response that reaches for
 * that overload would otherwise lose everything it declared. Both write styles
 * are therefore recorded as they happen: `setHeader` through the live accessors,
 * and `writeHead` through a wrapper installed in its place that reads the
 * arguments before delegating.
 * @param response - the response handed to the handler.
 * @returns a reader for the captured status and headers.
 */
function captureResponse(response: ServerResponse): () => Response {
  let status = response.statusCode
  let headers: Record<string, string> = lowercaseHeaders(response.getHeaders())
  const declaredWriteHead: ServerResponse['writeHead'] = response.writeHead.bind(response)
  const recording: ServerResponse['writeHead'] = (...args) => {
    // The declaration is read from the arguments, not from the response afterwards:
    // `writeHead(status, headers)` hands its headers straight to the socket-bound
    // serializer and the live accessors stop reporting them right away, so nothing
    // observable remains once the original returns.
    const declaration = args[0]
    if (typeof declaration === 'number') status = declaration
    const names = args[1]
    if (typeof names === 'object' && !Array.isArray(names)) {
      Object.assign(headers, lowercaseHeaders(names))
    } else if (typeof names === 'string' && typeof args[2] === 'string') {
      headers[names.toLowerCase()] = args[2]
    } else if (Array.isArray(names)) {
      for (let index = 0; index + 1 < names.length; index += 2) {
        headers[String(names[index]).toLowerCase()] = String(names[index + 1])
      }
    }
    return Reflect.apply(declaredWriteHead, response, args) as ServerResponse
  }
  response.writeHead = recording
  return () => {
    // `setHeader`/`setStatusCode` write through the live accessors, which stop
    // reporting them once the response flushes; the `writeHead` declaration was
    // captured above and wins nothing that was set explicitly afterwards.
    headers = { ...headers, ...lowercaseHeaders(response.getHeaders()) }
    return new Response(null, { status, headers })
  }
}

/** Normalize a header bag to lowercase names, which is what the wire uses. */
function lowercaseHeaders(bag: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bag).map(([name, value]) => [name.toLowerCase(), String(value)]),
  )
}

/** The writable end a buffered response is serialized into. */
export interface DesktopResponseBuffer {
  readonly stream: Writable
  readonly chunks: Buffer[]
  bytes: number
}

/**
 * Ceiling for one route response. Writes are accepted without backpressure, so
 * this bound — not a stream high-water mark — is what stops a route that writes
 * without ever ending from growing the child without limit.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/**
 * Split a socket-bound HTTP response stream into its header block and body.
 *
 * `ServerResponse` serializes the status line and headers through the same
 * writable as the body, so the sink must drop the header block to expose body
 * bytes alone. The split is on the header terminator, which cannot appear in a
 * header block; everything a route writes after that point is body.
 * @param chunks - body chunks collected by the returned writable.
 * @param onBytes - receives the running body byte count.
 * @returns a writable accepting the serialized response.
 */
function responseSink(chunks: Buffer[], onBytes: (bytes: number) => void): Writable {
  const terminator = Buffer.from('\r\n\r\n')
  let pending: Buffer[] = []
  let pendingBytes = 0
  let headersDone = false
  let total = 0
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      let buffer = chunk
      if (!headersDone) {
        pending.push(buffer)
        pendingBytes += buffer.byteLength
        const joined = Buffer.concat(pending, pendingBytes)
        const boundary = joined.indexOf(terminator)
        if (boundary === -1) {
          done()
          return
        }
        headersDone = true
        buffer = joined.subarray(boundary + terminator.byteLength)
        pending = []
        pendingBytes = 0
      }
      total += buffer.byteLength
      onBytes(total)
      if (total > MAX_RESPONSE_BYTES) {
        done(new Error('desktop web server: route response exceeded the collection ceiling'))
        return
      }
      if (buffer.byteLength > 0) chunks.push(buffer)
      done()
    },
  })
}

/**
 * Build the `IncomingMessage` a route handler expects from one piped request.
 * The body is delivered eagerly: the carrier has already buffered it, and route
 * handlers consume it either by `for await` or by `resume()`.
 * @param request - the piped request.
 * @param url - parsed request URL.
 * @param body - buffered request body, or null for a bodyless request.
 * @returns a readable request with headers, method, and URL populated.
 */
export function nodeRequestOf(request: Request, url: URL, body: Buffer | null): IncomingMessage {
  const incoming = new IncomingMessage(new PassThrough() as unknown as Socket)
  incoming.method = request.method
  incoming.url = `${url.pathname}${url.search}`
  incoming.headers = Object.fromEntries(request.headers.entries())
  incoming.httpVersion = '1.1'
  if (body !== null && body.byteLength > 0) incoming.push(body)
  incoming.push(null)
  return incoming
}

/**
 * Bind a `ServerResponse` to a writable sink so a handler's writes are captured
 * in memory. Writes are accepted without backpressure, so the collection ceiling
 * is what bounds growth instead of a stream high-water mark.
 * @param request - the request the response answers.
 * @returns the response, its byte sink, and a reader for its captured status and headers.
 */
export function nodeResponseOf(request: IncomingMessage): {
  response: ServerResponse
  sink: DesktopResponseBuffer
  head: () => Response
} {
  const chunks: Buffer[] = []
  const sink: DesktopResponseBuffer = { stream: responseSink(chunks, (bytes) => { sink.bytes = bytes }), chunks, bytes: 0 }
  const response = new ServerResponse(request)
  // `drain` is re-announced promptly so a handler never parks on a sink nobody reads.
  sink.stream.on('drain', () => { response.emit('drain') })
  response.assignSocket(Object.assign(sink.stream, socketFacts()) as unknown as Socket)
  return { response, sink, head: captureResponse(response) }
}

/**
 * Collect one route response body after the handler has ended it.
 * @param response - the handler-owned response.
 * @param sink - the response's byte sink.
 * @returns the collected body, or null for a bodyless response.
 */
function collectedBody(response: ServerResponse, sink: DesktopResponseBuffer): Buffer | null {
  void response
  return sink.bytes === 0 ? null : Buffer.concat(sink.chunks, sink.bytes)
}

/**
 * The socket-free route registry exposed as `ctx.webServer`.
 *
 * Constructing it registers the service on the owning fiber, exactly like the
 * listening implementation; disposing the fiber removes it.
 */
export class DesktopWebServer extends Service {
  private readonly exact = new Map<string, DesktopWebRoute>()
  private readonly prefixes = new Map<string, DesktopWebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private fallback: DesktopWebRoute['handler'] | undefined

  /**
   * @param ctx - Host context receiving the `webServer` service.
   */
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  /** Listener bind facts; Desktop is loopback-only and never bound. */
  get host(): '127.0.0.1' { return '127.0.0.1' }

  /** No listener exists, so there is no bound port. */
  get port(): number { return 0 }

  /**
   * Register a named route, rejecting a duplicate `(kind, path)` exactly as the
   * listening implementation does.
   * @param route - kind, absolute path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an exact-path upgrade route. Desktop owns no raw socket to hand
   * over, so the registration is tracked and disposed but never dispatched; the
   * carrier-neutral stream transport is its replacement.
   * @param route - pathname and handler.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * Claim the single fallback seat.
   * @param handler - owner of every request no named route matches.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) throw new Error('webserver: fallback already registered')
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /** No listener-owned index exists, so there is nothing to transform. */
  tapIndex(): () => void { return () => {} }

  /** Whether any named route or fallback seat is claimed. */
  get ownsRoutes(): boolean {
    return this.exact.size > 0 || this.prefixes.size > 0 || this.fallback !== undefined
  }

  /**
   * Dispatch one request to its registered route.
   * @param request - the piped request, already routed here by the Host.
   * @returns the handler's response, or undefined when no route matches.
   */
  async fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    const route = this.match(url.pathname)
    if (route === undefined) return undefined
    const requestBody = request.body === null ? null : Buffer.from(await request.arrayBuffer())
    const incoming = nodeRequestOf(request, url, requestBody)
    const { response, sink, head } = nodeResponseOf(incoming)
    // The handler owns the full response lifecycle; awaiting it before reading
    // the sink matches the listener's contract (a handler may answer asynchronously).
    await route.handler(incoming, response)
    // Read the declared status and headers before the final end, because a
    // handler that used `writeHead(status, headers)` stops reporting them.
    const declared = head()
    if (!response.writableEnded) {
      if (!response.headersSent) response.writeHead(200)
      response.end()
    }
    const body = collectedBody(response, sink)
    return new Response(body === null ? null : new Uint8Array(body), {
      status: declared.status,
      headers: declared.headers,
    })
  }

  /** Exact table first, then longest matching prefix, then the fallback seat. */
  private match(pathname: string): DesktopWebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: DesktopWebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    if (best !== undefined) return best
    const fallback = this.fallback
    return fallback === undefined ? undefined : { kind: 'exact', path: pathname, handler: fallback }
  }
}
