/**
 * Agent turn activity derived from every lane that reports it.
 *
 * The Session running bit and a view target's open turn are delivered on
 * different lanes at different cadences: the bit on the Session microtask, the
 * turn up to a frame later. Reading either one alone lets one region announce an
 * end the other has not seen, so a status, its clock, and the transcript tail it
 * describes can disagree about whether the turn is still running.
 *
 * This lives with the shared atoms rather than in a plugin because the chat view
 * and the conversation shell both consume it, and a cross-plugin value import is
 * a bundle-purity violation by construction.
 * @module turn-activity
 */

/** Turn boundary facts a view target publishes for the Agent's own turn. */
export interface TurnTimelineRead {
  readonly turns: ReadonlyMap<number, {
    readonly status: 'open' | 'closed' | 'unknown'
    readonly start?: { readonly time?: number } | undefined
  }>
}

/** One reading of whether the Agent's turn is still running. */
export interface TurnActivityRead {
  /** Whether anything still holds the Agent's turn open. */
  readonly active: boolean
  /** Logged `turn/start` time of the newest open turn, or null when none is visible. */
  readonly startTime: number | null
}

/**
 * Resolve the Agent's running turn state from every lane in one reading.
 *
 * Either lane keeps the turn active: the Session bit covers the first-token
 * wait, and an unclosed turn covers the frame after the bit has already ended.
 * @param session - current Session lifecycle state.
 * @param timeline - turn boundary facts from the view target owning the transcript.
 * @returns activity plus the clock anchor to use with it.
 */
export function turnActivity(
  session: { readonly running: boolean },
  timeline: TurnTimelineRead,
): TurnActivityRead {
  let openTurn = false
  let startTime: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status !== 'open') continue
    openTurn = true
    const time = turn.start?.time
    if (typeof time !== 'number') continue
    // Newest open turn owns the clock, so a turn rollover never moves it backwards.
    if (startTime === null || time > startTime) startTime = time
  }
  // An open turn keeps the activity on its own: `active` is about whether the run
  // ended, and `startTime` is only the clock anchor, which may be unreadable when
  // the turn boundary sits outside the loaded window.
  return { active: session.running || openTurn, startTime }
}
