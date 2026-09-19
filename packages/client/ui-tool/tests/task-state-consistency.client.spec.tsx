// @vitest-environment jsdom
/**
 * Every task surface reads one collection, so they must agree about it.
 *
 * The plan strip (conversation dock), the todo_write tool row, and the shared
 * derivation itself are three renderings of the same list. Before this suite
 * each filtered for itself; these specs pin the agreement across the whole
 * lifecycle the list actually moves through: nothing started, one task running,
 * finished, and the drift statuses a malformed call can carry.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { todoCounts } from '@deepseek-ai/dsh-client-ui-primitives'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { TodoPanel } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/TodoPanel.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { TodoRow } from '../src/client/tool/toolviews/todo-row.tsx'
import { planSummary } from '../src/client/tool/toolviews/plan-summary.ts'

type TodoRowProps = Parameters<typeof TodoRow>[0]
type TodoPanelProps = Parameters<typeof TodoPanel>[0]

const t: TodoRowProps['t'] = makeTranslate(zh, commonZh)
const panelT: TodoPanelProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

interface Item {
  content: string
  status: TodoItem['status']
}

/** One task collection as the lifecycle moves it, in model order. */
const plan = (completed: number, inProgress: number, pending: number): Item[] => [
  ...Array.from({ length: completed }, (_, i): Item => ({ content: `done-${i}`, status: 'completed' })),
  ...Array.from({ length: inProgress }, (_, i): Item => ({ content: `active-${i}`, status: 'in_progress' })),
  ...Array.from({ length: pending }, (_, i): Item => ({ content: `todo-${i}`, status: 'pending' })),
]

const resultNode = (argsRaw: string): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
  call: { name: 'todo_write', argsRaw },
  content: [], isError: false, subCalls: [],
})

function rowProps(block: unknown): TodoRowProps {
  return {
    callId: 'c1', toolName: 'todo_write', block,
    openFile: vi.fn(),
    sessionId: 's1',
    useSessions: () => undefined,
    t,
  } as unknown as TodoRowProps
}

/** The plan strip's header summary text, with its two en-space separators normalized. */
function stripSummary(todos: Item[]): string {
  const view = render(<TodoPanel todos={todos} t={panelT} />)
  const text = screen.getByTestId('todo-panel').querySelector('[class*="progress"]')?.textContent ?? ''
  view.unmount()
  return text.replaceAll('\u2002', ' ')
}

/** The row's rendered summary text, or null when the row did not render one. */
function rowSummary(): string | null {
  const root = document.querySelector('[data-tool="todo_write"]')
  return root?.querySelector('span[class*="summary"]')?.textContent ?? null
}

describe('task surfaces agree about one collection', () => {
  it.each([
    { label: 'nothing started', items: plan(0, 0, 3) },
    { label: 'one task running', items: plan(0, 1, 2) },
    { label: 'partly finished', items: plan(1, 1, 1) },
    { label: 'all finished', items: plan(3, 0, 0) },
    { label: 'parallel active work', items: plan(1, 3, 1) },
  ])('reports identical counts on strip, row, and shared reading ($label)', ({ items }) => {
    const shared = todoCounts(items)
    const summary = planSummary(items)
    const args = JSON.stringify({ todos: items })

    // The tool row's own derivation.
    expect(summary.done).toBe(shared.completed)
    expect(summary.pending).toBe(shared.pending)
    expect(summary.total).toBe(shared.total)

    // The row renders exactly those numbers, not a second tally. The count is the
    // row's head; an active clause may follow it inside the same text node.
    render(<TodoRow {...rowProps(resultNode(args))} />)
    const head = `${summary.done}/${summary.total} 已完成`
    expect(rowSummary()).toBe(summary.activeContent === null ? head : `${head} · ${summary.activeContent}`)
    cleanup()

    // The plan strip renders the same collection with the same numbers: its
    // "-joined segments are built from the identical reading, zero counts omitted.
    const segments = [
      ...shared.completed > 0 ? [`${shared.completed} 已完成`] : [],
      ...shared.inProgress > 0 ? [`${shared.inProgress} 进行中`] : [],
      ...shared.pending > 0 ? [`${shared.pending} 待处理`] : [],
    ]
    expect(stripSummary(items)).toBe(segments.join(' · '))
  })

  it('gives the row and the strip the same total for a plan with a backlog', () => {
    const items = plan(1, 1, 2)
    // The row stays compact (done/total + the active item); the strip breaks the
    // same reading into segments. Both describe one four-item collection.
    render(<TodoRow {...rowProps(resultNode(JSON.stringify({ todos: items })))} />)
    expect(screen.getByText('1/4 已完成 · active-0')).toBeTruthy()
    cleanup()
    expect(stripSummary(items)).toBe('1 已完成 · 1 进行中 · 2 待处理')
  })

  it('carries the total through a pending → running → completed move without drifting', () => {
    const states = [plan(0, 0, 3), plan(0, 1, 2), plan(1, 1, 1), plan(2, 1, 0), plan(3, 0, 0)]
    for (const items of states) {
      const shared = todoCounts(items)
      expect(shared.total).toBe(3)
      expect(shared.pending + shared.inProgress + shared.completed + shared.other).toBe(3)
      expect(planSummary(items).total).toBe(3)
    }
  })

  it('never invents a completed count for a failed or cancelled status', () => {
    // The tool row parses model-authored args, so a drifted status reaches it.
    // Naming those items completed would report work that was never done, and
    // pending would report work nobody planned. The cast is the point: this input
    // is outside the closed union the projection can carry.
    const drifted = (content: string, status: string): Item => ({ content, status: status as TodoItem['status'] })
    const items: Item[] = [
      { content: 'done', status: 'completed' },
      drifted('failed one', 'failed'),
      drifted('cancelled one', 'cancelled'),
    ]
    const shared = todoCounts(items)
    expect(shared).toEqual({ pending: 0, inProgress: 0, completed: 1, other: 2, total: 3 })
    render(<TodoRow {...rowProps(resultNode(JSON.stringify({ todos: items })))} />)
    // The row reports no pending backlog and no active clause for drift alone.
    expect(screen.getByText('1/3 已完成')).toBeTruthy()
    expect(screen.queryByText(/待处理/)).toBeNull()
  })

  it('re-reads a newer collection instead of a remembered older one', () => {
    // A stale snapshot can only outlive a newer one through a cache; the shared
    // derivation holds none, so each surface re-reads the collection it is handed.
    const older = plan(0, 0, 2)
    const newer = plan(2, 0, 0)
    render(<TodoRow {...rowProps(resultNode(JSON.stringify({ todos: older })))} />)
    expect(screen.getByText('0/2 已完成')).toBeTruthy()
    cleanup()
    render(<TodoRow {...rowProps(resultNode(JSON.stringify({ todos: newer })))} />)
    expect(screen.getByText('2/2 已完成')).toBeTruthy()
    expect(todoCounts(older).completed).toBe(0)
  })

  it('re-reads the strip for a newer collection too', () => {
    expect(stripSummary(plan(0, 0, 2))).toBe('2 待处理')
    expect(stripSummary(plan(2, 0, 0))).toBe('2 已完成')
  })
})
