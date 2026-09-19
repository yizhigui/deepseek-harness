/**
 * One reading of a task collection's status breakdown.
 *
 * The plan strip, the todo_write row, and the host tool result all render the
 * same collection, so this module owns the counts they must agree on: every
 * item lands in exactly one bucket, the buckets always sum to `total`, and a
 * status nobody recognizes is drift rather than an invented lifecycle state.
 */

import { describe, expect, it } from 'vitest'
import { todoCounts } from '../src/todo-counts.ts'

/** One task collection as the three-state lifecycle actually moves it. */
const at = (completed: number, inProgress: number, pending: number) => [
  ...Array.from({ length: completed }, () => ({ status: 'completed' })),
  ...Array.from({ length: inProgress }, () => ({ status: 'in_progress' })),
  ...Array.from({ length: pending }, () => ({ status: 'pending' })),
]

describe('todoCounts', () => {
  it('sums an empty collection to all zeros', () => {
    expect(todoCounts([])).toEqual({ pending: 0, inProgress: 0, completed: 0, other: 0, total: 0 })
  })

  it('reads a plan that has not started yet', () => {
    expect(todoCounts(at(0, 0, 3))).toEqual({ pending: 3, inProgress: 0, completed: 0, other: 0, total: 3 })
  })

  it('moves one task pending → running without changing the total', () => {
    expect(todoCounts(at(0, 1, 2))).toEqual({ pending: 2, inProgress: 1, completed: 0, other: 0, total: 3 })
  })

  it('moves one task running → completed without changing the total', () => {
    expect(todoCounts(at(2, 1, 0))).toEqual({ pending: 0, inProgress: 1, completed: 2, other: 0, total: 3 })
  })

  it('reads a fully finished plan', () => {
    expect(todoCounts(at(3, 0, 0))).toEqual({ pending: 0, inProgress: 0, completed: 3, other: 0, total: 3 })
  })

  it('counts parallel work as parallel active items', () => {
    expect(todoCounts(at(1, 3, 1))).toEqual({ pending: 1, inProgress: 3, completed: 1, other: 0, total: 5 })
  })

  it('buckets a status outside the lifecycle as drift, never as pending', () => {
    // `TodoItem.status` is a closed three-state union, so this cannot arrive
    // through the typed projection. It reaches the tool row through model-authored
    // call args, where a drifted status must be visible as drift: folding it into
    // `pending` would report work to do that nobody planned, and counting it as
    // `completed` would claim work was done.
    const counts = todoCounts([
      { status: 'completed' }, { status: 'in_progress' }, { status: 'failed' }, { status: 'cancelled' },
    ])
    expect(counts).toEqual({ pending: 0, inProgress: 1, completed: 1, other: 2, total: 4 })
  })

  it.each([
    { label: 'missing status', item: {} },
    { label: 'null status', item: { status: null } },
    { label: 'mistyped status', item: { status: 42 } },
    { label: 'case-drifted status', item: { status: 'Completed' } },
  ])('treats a $label as drift rather than a bucket', ({ item }) => {
    const counts = todoCounts([item])
    expect(counts).toEqual({ pending: 0, inProgress: 0, completed: 0, other: 1, total: 1 })
  })

  it('keeps the buckets summing to the total for any collection', () => {
    // The invariant the surfaces rely on: a count-based summary can never
    // describe a list of a different length than the rows rendered beside it.
    for (const list of [[], at(1, 0, 0), at(2, 2, 2), at(0, 0, 1), at(5, 1, 4)]) {
      const c = todoCounts(list)
      expect(c.pending + c.inProgress + c.completed + c.other).toBe(c.total)
      expect(c.total).toBe(list.length)
    }
  })

  it('is a pure function of the list it is given', () => {
    // Ceilings and caches are exactly how a stale reading outlives a newer one;
    // the derivation holds no state, so a newer collection always wins.
    const older = at(0, 0, 2)
    const newer = at(2, 0, 0)
    expect(todoCounts(older).completed).toBe(0)
    expect(todoCounts(newer).completed).toBe(2)
    expect(todoCounts(older).completed).toBe(0)
  })
})
