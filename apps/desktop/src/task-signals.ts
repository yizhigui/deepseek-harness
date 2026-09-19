/**
 * Terminal-task signals derived from the Host's forwarded-event stream.
 *
 * Main is a byte-transparent carrier for `dsh-app://app`, so it can observe the
 * one stream that already carries this application's lifecycle facts:
 * `POST /.dsh/remote-stream` encodes the Gateway forwarded-event downlink as
 * NDJSON lines (see `remoteStreamHandler` in the Host child). The shared renderer
 * derives its own completion reminder from the same `api-session/status` edge,
 * so the shell and the UI agree on what "finished" means instead of the shell
 * inventing a second lifecycle.
 *
 * Two properties matter for correctness and are asserted by the tests:
 *
 * - **Terminal only.** A signal is produced by a `running: true → false` edge,
 *   never by a subagent finishing, a tool call returning, or a planner step.
 * - **Once per run.** The first observation of a session only records its
 *   running bit, so a reconnect, a resume, a page reload, or reopening the
 *   window cannot replay a completion that already happened.
 * @module task-signals
 */

/** What one observed session is currently doing. */
export interface TaskSessionState {
  /** Whether the session is armed: a `true` bit was observed after the last settle. */
  armed: boolean
  /** The armed run already produced a signal, so this run can never produce another. */
  settled: boolean
  /** Last Agent failure reported for the session without a durable turn position. */
  failed: boolean
  /** Whether a running bit has ever been observed; the first observation only records. */
  observed: boolean
  /** Last running bit, the edge detector's left-hand side. */
  running: boolean
}

/** One terminal task outcome worth a native notification. */
export interface TaskCompletionSignal {
  readonly sessionId: string
  readonly outcome: 'completed' | 'failed'
}

/** Reconcile once; the returned signal is the only thing that may raise a notification. */
export interface SessionLedger {
  readonly sessions: Map<string, TaskSessionState>
  /**
   * Feed one decoded forwarded event.
   * @param frame - one NDJSON-decoded forwarded-event frame.
   * @returns the terminal signal this event produced, when it produced one.
   */
  accept(frame: unknown): TaskCompletionSignal | undefined
  /** Drop tracking for a session the Host no longer registers. */
  forget(sessionId: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (!isRecord(value)) return undefined
  const id = value.id ?? value.sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Create the per-session completion ledger.
 * @returns the ledger consumed by {@link TaskCompletionWatcher}.
 */
export function createSessionLedger(): SessionLedger {
  const sessions = new Map<string, TaskSessionState>()
  return {
    sessions,
    accept(frame: unknown): TaskCompletionSignal | undefined {
      if (!isRecord(frame) || frame.type !== 'emit') return undefined
      const args = Array.isArray(frame.args) ? frame.args : undefined
      if (args === undefined) return undefined
      if (frame.event === 'api-session/removed') {
        const sessionId = sessionIdOf(args[0])
        if (sessionId !== undefined) sessions.delete(sessionId)
        return undefined
      }
      if (frame.event === 'api-session/error') {
        const sessionId = sessionIdOf(args[0])
        const state = sessionId === undefined ? undefined : sessions.get(sessionId)
        // An error for an unobserved session carries no running context yet; the
        // next status edge is what decides whether it becomes a failure signal.
        if (state !== undefined) state.failed = true
        return undefined
      }
      if (frame.event !== 'api-session/status') return undefined
      const sessionId = sessionIdOf(args[0])
      if (sessionId === undefined || typeof args[1] !== 'boolean') return undefined
      const running = args[1]
      const existing = sessions.get(sessionId)
      if (existing === undefined) {
        // First observation records the bit only: a session already idle when the
        // shell attaches, a reconnect, or a fresh page load must not notify.
        sessions.set(sessionId, {
          armed: running, settled: false, failed: false, observed: true, running,
        })
        return undefined
      }
      if (existing.observed && existing.running === running) return undefined
      const wasRunning = existing.observed && existing.running
      existing.observed = true
      existing.running = running
      if (running) {
        // A new run re-arms the session, so the next stop is a fresh completion.
        existing.armed = true
        existing.settled = false
        existing.failed = false
        return undefined
      }
      if (!wasRunning || existing.settled) return undefined
      existing.settled = true
      existing.armed = false
      const outcome = existing.failed ? 'failed' : 'completed'
      existing.failed = false
      return { sessionId, outcome }
    },
    forget(sessionId: string): void {
      sessions.delete(sessionId)
    },
  }
}

/**
 * Incremental NDJSON observer over one forwarded-event downlink.
 *
 * Bytes are accumulated and split on newlines because the carrier chunks frames
 * at its own boundaries; a partial trailing line is held until the next chunk.
 */
export class TaskCompletionWatcher {
  private pending = ''
  private readonly ledger: SessionLedger
  private readonly onSignal: (signal: TaskCompletionSignal) => void

  /**
   * @param options - optional injected ledger and signal sink for deterministic tests.
   */
  constructor(options: { ledger?: SessionLedger; onSignal?: (signal: TaskCompletionSignal) => void } = {}) {
    this.ledger = options.ledger ?? createSessionLedger()
    this.onSignal = options.onSignal ?? (() => undefined)
  }

  /** Tracked sessions, keyed by Session identity (test/diagnostic surface). */
  get sessions(): ReadonlyMap<string, TaskSessionState> {
    return this.ledger.sessions
  }

  /**
   * Feed the next bytes of one forwarded-event downlink.
   * @param chunk - raw NDJSON bytes as the Host wrote them.
   * @returns one signal per session that reached a terminal state in this chunk.
   */
  accept(chunk: Uint8Array): TaskCompletionSignal[] {
    this.pending += Buffer.from(chunk).toString('utf8')
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    const signals: TaskCompletionSignal[] = []
    for (const line of lines) {
      if (line === '') continue
      let frame: unknown
      try {
        frame = JSON.parse(line) as unknown
      } catch {
        // A malformed line is dropped: this observer must never be the reason a
        // renderer's own stream fails.
        continue
      }
      if (!isRecord(frame)) continue
      const signal = this.ledger.accept(frame)
      if (signal === undefined) continue
      signals.push(signal)
    }
    for (const signal of signals) {
      try {
        this.onSignal(signal)
      } catch (error) {
        console.error('[desktop] task completion sink failed', error)
      }
    }
    return signals
  }

  /** Drop the held partial line after a stream generation ends. */
  reset(): void {
    this.pending = ''
  }
}
