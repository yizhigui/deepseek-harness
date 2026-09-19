# Agent Note: One task-count derivation for every task surface

Status: implemented

English | [中文](2026-09-19-shared-task-count-derivation.zh.md)

## Problem

The same task collection is rendered by two independent surfaces — the conversation plan strip (`TodoPanel`) and the `todo_write` tool row — and a third, the host-side tool result, derives counts at execution time. Each computed its own reading:

- `TodoPanel.progressLabel` filtered the projected list twice and derived `pending` as `length - done - active`.
- `planSummary` filtered the same list for `completed` and `in_progress` again, with its own "done" count.
- The tool's `execute` counted the validated list once more for its model-facing text.

Three filters over one collection means three chances to disagree. The strip's `pending` was a remainder that silently absorbed any status it did not name, so a drifted status reaching the row through unvalidated model JSON would be reported as pending work nobody planned.

## Decision

`todoCounts` (`packages/client/ui-primitives/src/todo-counts.ts`) is the single derivation. Given a collection it answers `{ pending, inProgress, completed, other, total }`, and the surfaces only choose how to present it:

- `TodoPanel.progressLabel` renders the reading as its "·"-joined segments.
- `planSummary` returns `done`/`pending`/`total` straight from the reading and adds only the active-item clause the row needs.
- The tool row keeps its compact `done/total` head and its parallel-active suffix.

Two properties are load-bearing:

**Every item lands in exactly one bucket.** `pending` is the remainder after `completed`, `in_progress`, and `other`, so the buckets always sum to `total` and a count-based summary can never describe a list of a different length than the rows rendered beside it.

**A status outside the lifecycle is `other`, not `pending`.** `TodoItem.status` is a closed three-state union, so a fourth status cannot arrive through the typed projection; it reaches the row through model-authored call args, which are never schema-checked. Folding it into `pending` would report work nobody planned and counting it as `completed` would claim work was done. It stays visible as drift instead.

The module lives with the shared atoms rather than in a plugin because both `ui-conversation` and `ui-tool` consume it, and a cross-plugin value import is a bundle-purity violation by construction — the same reason `turnActivity` sits there.

## Alternatives considered

**Export the selector from `ui-tool` and import it in `ui-conversation`.** Rejected: `ui-conversation` would then take a runtime dependency on a feature plugin, which the client export discipline forbids.

**Have the row defer entirely to the `todos` projection.** Rejected: the row documents a historical call, and reading the current projection would make a row change meaning when a later turn rewrites the list.

**Add the pending count to the row's visible text.** Rejected as a UI change this task did not ask for; the row keeps its compact head, and the agreement is asserted instead.

## Consequences

A status the lifecycle does not define is now reported as `other` rather than absorbed into `pending`. `planSummary` gained a `pending` field, and the strip's numbers are unchanged for every well-formed list. The consistency is pinned across the lifecycle (`packages/client/ui-tool/tests/task-state-consistency.client.spec.tsx` renders the row and the strip against identical lists for nothing-started, running, partly-finished, all-finished, and parallel-active plans; `packages/client/ui-primitives/tests/todo-counts.client.spec.ts` pins the derivation itself, including that it holds no state, so a newer collection always wins over an older one).
