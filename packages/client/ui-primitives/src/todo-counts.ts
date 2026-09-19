/**
 * One reading of a task collection's status breakdown.
 *
 * The same plan is rendered by two independent surfaces — the conversation
 * plan strip (`TodoPanel`) and the `todo_write` tool row — and a third, the
 * host-side tool result, is derived at execution time. Each used to filter the
 * list for itself, so the same collection could be reported with different
 * numbers the moment one of the three changed its filter. This module is the
 * single derivation every surface reads: given a list, it answers the counts,
 * and the surfaces only decide how to present them.
 *
 * It lives with the shared atoms rather than in a plugin because both
 * `ui-conversation` and `ui-tool` consume it, and a cross-plugin value import
 * is a bundle-purity violation by construction.
 *
 * @module todo-counts
 */

/**
 * One item as a caller can see it.
 *
 * `status` stays `unknown` on purpose: the tool row reads model-authored call
 * args that were never schema-checked, so a drifted or mistyped status must
 * not be coerced into a bucket it does not belong to — it lands in
 * {@link TodoCounts.other} instead of silently inflating `pending`.
 */
export interface TodoCountItem {
  readonly status?: unknown
}

/** Status breakdown of one task collection; every item lands in exactly one bucket. */
export interface TodoCounts {
  /** Items explicitly not started. */
  readonly pending: number
  /** Items marked as being worked now (parallel plans may hold several). */
  readonly inProgress: number
  /** Items explicitly finished. */
  readonly completed: number
  /** Items whose status is missing or unrecognized — drift, not a lifecycle state. */
  readonly other: number
  /** `pending + inProgress + completed + other`. */
  readonly total: number
}

/**
 * Derive the status breakdown of one task collection.
 *
 * `pending` is `total - everything else` rather than its own filter so the
 * buckets always sum to `total`: a fourth status can never make the counts
 * describe a list of a different length than the rows shown beside them.
 * @param items - the whole collection, in author order.
 * @returns the counts, all zero for an empty collection.
 */
export function todoCounts(items: readonly TodoCountItem[]): TodoCounts {
  let inProgress = 0
  let completed = 0
  let other = 0
  for (const item of items) {
    if (item.status === 'completed') completed++
    else if (item.status === 'in_progress') inProgress++
    else if (item.status !== 'pending') other++
  }
  return { pending: items.length - inProgress - completed - other, inProgress, completed, other, total: items.length }
}
