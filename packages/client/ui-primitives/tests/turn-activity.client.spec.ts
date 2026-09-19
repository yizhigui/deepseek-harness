/**
 * One reading of turn activity, shared by the chat view and the conversation
 * shell so neither can publish an end the other has not seen.
 */

import { describe, expect, it } from 'vitest'
import { turnActivity } from '../src/turn-activity.ts'

const open = { turns: new Map([[1, { status: 'open' as const, start: { time: 1_000 } }]]) }
const closed = { turns: new Map([[1, { status: 'closed' as const, start: { time: 1_000 } }]]) }
const empty = { turns: new Map<number, never>() }

describe('turnActivity', () => {
  it('stays active while the running bit is set and no turn is published yet', () => {
    expect(turnActivity({ running: true }, empty)).toEqual({ active: true, startTime: null })
  })

  it('stays active while the open turn outlives the running bit', () => {
    // The Session lane has already reported the end; the Conversation lane still
    // holds the turn open, so a status must not vanish mid-tail.
    expect(turnActivity({ running: false }, open)).toEqual({ active: true, startTime: 1_000 })
  })

  it('reports idle only when both lanes agree the turn ended', () => {
    expect(turnActivity({ running: false }, closed)).toEqual({ active: false, startTime: null })
    expect(turnActivity({ running: false }, empty)).toEqual({ active: false, startTime: null })
  })

  it('anchors the clock to the newest open turn', () => {
    const turns = new Map([
      [1, { status: 'closed' as const, start: { time: 10 } }],
      [2, { status: 'open' as const, start: { time: 20 } }],
      [3, { status: 'open' as const, start: { time: 30 } }],
    ])
    expect(turnActivity({ running: true }, { turns })).toEqual({ active: true, startTime: 30 })
  })

  it('stays active for an open turn whose start boundary is unreadable', () => {
    // `active` answers whether the run ended; the clock anchor is separate and may
    // be missing when the turn boundary is outside the loaded window.
    const turns = new Map([[1, { status: 'open' as const }]])
    expect(turnActivity({ running: false }, { turns })).toEqual({ active: true, startTime: null })
  })

  it('ignores a turn whose status is unknown', () => {
    const turns = new Map([[1, { status: 'unknown' as const, start: { time: 5 } }]])
    expect(turnActivity({ running: false }, { turns })).toEqual({ active: false, startTime: null })
  })
})
