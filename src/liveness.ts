/**
 * Liveness of a session row: is the agent still working?
 *
 * The event stream reports a session as running, but that flag is stale when an event is missed or when a session
 * finishes without a terminal event. The session record is the truth: `time.idle` is written once per completed run and
 * `time.updated` moves on every change, so the record settles a stale event-derived running flag in both directions —
 * a row that says "running" but was updated before its last completion is idle, and a row whose record moved past its
 * last completion is running even if the start event was never seen.
 *
 * The one case this cannot settle is a stale flag on a session that was also touched after its last completion: a late
 * title or usage write and a new run both move `time.updated`, so the events are left to decide.
 */

/** Whether a session is doing work right now. */
export type LiveStatus = "idle" | "running"

/** What the panel knows about one session: the event flag plus the session record. */
export interface LivenessInput {
  /** The status the client cache derived from the event stream. */
  reported: LiveStatus
  /** `time.idle` of the session record: the epoch ms of the last completed run, if any. */
  idle?: number
  /** `time.updated` of the session record: the epoch ms of the last change. */
  updated: number
  /** Total tokens of the session: proof that some run did work. */
  tokens: number
}

/**
 * The status a row should show, reconciled between the event flag and the session record.
 *
 * Without `time.idle` the session never completed a run, so the events are all there is: a running flag sticks, and a
 * missing start event is caught by the tokens.
 */
export function liveStatus(input: LivenessInput): LiveStatus {
  const { reported, idle, updated, tokens } = input
  if (idle === undefined) return reported === "running" || tokens > 0 ? "running" : "idle"
  return reported === "running" && updated > idle ? "running" : "idle"
}

/**
 * The glyph of a status dot: filled while running, an x for a failed last run, an open circle otherwise.
 */
export function statusGlyph(
  running: boolean,
  outcome?: "succeeded" | "failed" | "interrupted",
): string {
  if (running) return "●"
  return outcome === "failed" ? "✗" : "○"
}
