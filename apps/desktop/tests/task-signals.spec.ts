/**
 * Terminal-task signal derivation: what produces a completion signal, and what
 * must never produce one twice.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  TaskCompletionWatcher, createSessionLedger, type TaskCompletionSignal,
} from '../src/task-signals.ts'

/** Encode one forwarded-event frame the way the Host writes it. */
function emit(event: string, args: readonly unknown[]): string {
  return `${JSON.stringify({ type: 'emit', event, args })}\n`
}

function status(sessionId: string, running: boolean): string {
  return emit('api-session/status', [sessionId, running])
}

/** A watcher collecting every signal it raises. */
function watcher(): { feed(chunk: string): TaskCompletionSignal[]; seen: TaskCompletionSignal[] } {
  const seen: TaskCompletionSignal[] = []
  const instance = new TaskCompletionWatcher({ onSignal: (signal) => { seen.push(signal) } })
  return { feed: chunk => instance.accept(Buffer.from(chunk, 'utf8')), seen }
}

describe('task completion signals', () => {
  it('reports one completion for a running to idle edge', () => {
    const subject = watcher()
    expect(subject.feed(status('s1', true))).toEqual([])
    expect(subject.feed(status('s1', false))).toEqual([{ sessionId: 's1', outcome: 'completed' }])
    expect(subject.seen).toEqual([{ sessionId: 's1', outcome: 'completed' }])
  })

  it('reports a failure when the agent reported an error during the run', () => {
    const subject = watcher()
    subject.feed(status('s1', true))
    subject.feed(emit('api-session/error', ['s1', 'the provider rejected the request']))
    expect(subject.feed(status('s1', false))).toEqual([{ sessionId: 's1', outcome: 'failed' }])
  })

  it('never signals a session first observed idle, so a reload or resume cannot replay', () => {
    const subject = watcher()
    expect(subject.feed(status('s1', false))).toEqual([])
    expect(subject.feed(status('s1', false))).toEqual([])
    expect(subject.seen).toEqual([])
  })

  it('notifies once per run and re-arms only on a new run', () => {
    const subject = watcher()
    subject.feed(status('s1', true))
    expect(subject.feed(status('s1', false))).toHaveLength(1)
    // A repeated idle frame is not a new edge.
    expect(subject.feed(status('s1', false))).toEqual([])
    // Reconnect/reopen replays of the idle truth stay silent.
    expect(subject.feed(status('s1', false))).toEqual([])
    subject.feed(status('s1', true))
    expect(subject.feed(status('s1', false))).toHaveLength(1)
    expect(subject.seen).toHaveLength(2)
  })

  it('ignores subagent, tool, planner, and session-activity traffic', () => {
    const subject = watcher()
    subject.feed(status('s1', true))
    subject.feed(emit('api-session/added', [{ id: 's2' }]))
    subject.feed(emit('api-session/activity', ['s1', 1]))
    subject.feed(emit('api-session/status', ['s2', false]))
    subject.feed(emit('agent-preset/selected', ['s1', 'preset']))
    subject.feed(`${JSON.stringify({ type: 'ready', clientId: 'c', host: { home: '/home' } })}\n`)
    expect(subject.seen).toEqual([])
  })

  it('does not let a subagent finishing report its parent as complete', () => {
    const subject = watcher()
    subject.feed(status('parent', true))
    subject.feed(status('child', true))
    subject.feed(status('child', false))
    expect(subject.seen).toEqual([{ sessionId: 'child', outcome: 'completed' }])
    // The parent is still running, so no further signal exists yet.
    expect(subject.feed(status('child', false))).toEqual([])
  })

  it('tracks several sessions independently', () => {
    const subject = watcher()
    subject.feed(status('a', true) + status('b', true))
    expect(subject.feed(status('a', false))).toEqual([{ sessionId: 'a', outcome: 'completed' }])
    expect(subject.feed(status('b', false))).toEqual([{ sessionId: 'b', outcome: 'completed' }])
  })

  it('reassembles frames split across chunk boundaries', () => {
    const subject = watcher()
    const frames = status('s1', true) + status('s1', false)
    const cut = 30
    expect(subject.feed(frames.slice(0, cut))).toEqual([])
    expect(subject.feed(frames.slice(cut))).toEqual([{ sessionId: 's1', outcome: 'completed' }])
  })

  it('drops malformed lines without failing the carrier', () => {
    const subject = watcher()
    subject.feed(status('s1', true))
    subject.feed('not json\n')
    subject.feed(`${JSON.stringify({ type: 'emit', event: 'api-session/status', args: ['s1'] })}\n`)
    subject.feed(`${JSON.stringify({ type: 'emit', event: 'api-session/status', args: [42, false] })}\n`)
    expect(subject.feed(status('s1', false))).toEqual([{ sessionId: 's1', outcome: 'completed' }])
  })

  it('drops a removed session, so the next observation only records idle', () => {
    const subject = watcher()
    subject.feed(status('s1', true))
    subject.feed(emit('api-session/removed', ['s1']))
    // Removed means untracked: the next status frame is a first observation again,
    // which records the bit instead of settling a run nobody watched end.
    expect(subject.feed(status('s1', false))).toEqual([])
    expect(subject.seen).toEqual([])
  })

  it('forgets a partial line after a carrier generation ends', () => {
    const ledger = createSessionLedger()
    const instance = new TaskCompletionWatcher({ ledger })
    instance.accept(Buffer.from('{"type":"emit","event":"api-ses', 'utf8'))
    instance.reset()
    instance.accept(Buffer.from(status('s1', true), 'utf8'))
    expect(instance.sessions.get('s1')?.running).toBe(true)
  })

  it('isolates a throwing signal sink from the carrier', () => {
    const ledger = createSessionLedger()
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    const instance = new TaskCompletionWatcher({
      ledger,
      onSignal: () => { throw new Error('sink failed') },
    })
    instance.accept(Buffer.from(status('s1', true), 'utf8'))
    // The signal still reaches the caller even though the sink threw.
    expect(instance.accept(Buffer.from(status('s1', false), 'utf8')))
      .toEqual([{ sessionId: 's1', outcome: 'completed' }])
    expect(failure).toHaveBeenCalled()
    failure.mockRestore()
  })
})
