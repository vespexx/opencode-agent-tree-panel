#!/usr/bin/env node
// Checks for the "is this row still running" rules and the duration shown next to it.
//
//   npm run build && npm run check
//
// The reported case: the panel showed `worker-ops · 3ms` as running while the TUI was running `worker-explorer`.
// Two things were wrong. The client's event flag had `running` left over from an earlier run (nothing cleared it),
// and a child session's cached record is never re-fetched after creation, so its duration was `time.updated - created`
// — a few milliseconds, forever. Both are checked here without a TUI.
import { liveStatus, statusGlyph } from "../dist/liveness.js"
import { runDuration } from "../dist/format.js"

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

// 1. A stale `running` flag on a session whose run already completed is corrected.
{
  // Exactly the screenshot: a finished worker-ops run, still flagged running by the client.
  const stale = liveStatus({ reported: "running", idle: 1_792_872_000_000, updated: 1_792_871_999_000, tokens: 379_700 })
  check("a completed run is idle even when the flag still says running", stale === "idle", stale)
  const equal = liveStatus({ reported: "running", idle: 1000, updated: 1000, tokens: 42 })
  check("updated equal to idle is still a completed run", equal === "idle", equal)
}
// 2. A real run after an earlier completion is running.
{
  const next = liveStatus({ reported: "running", idle: 1000, updated: 2000, tokens: 10 })
  check("work after the last completion means a new run", next === "running", next)
}
// 3. Sessions that never completed a run: the flag is all there is, and the tokens catch a missed start event.
{
  const fresh = liveStatus({ reported: "running", idle: undefined, updated: 5, tokens: 0 })
  check("a started run with no history is running", fresh === "running", fresh)
  const missedStart = liveStatus({ reported: "idle", idle: undefined, updated: 5000, tokens: 100 })
  check("tokens without a terminal transition mean the start event was missed", missedStart === "running", missedStart)
  const neverStarted = liveStatus({ reported: "idle", idle: undefined, updated: 3, tokens: 0 })
  check("a created but unused session is idle", neverStarted === "idle", neverStarted)
  const finished = liveStatus({ reported: "idle", idle: 1000, updated: 998, tokens: 100 })
  check("a finished session reported idle stays idle", finished === "idle", finished)
}
// 4. Glyphs: filled while running, x for a failed last run.
{
  check("a running row is a filled dot", statusGlyph(true, undefined) === "●", statusGlyph(true, undefined))
  check("a failed run is marked with an x", statusGlyph(false, "failed") === "✗", statusGlyph(false, "failed"))
  check("a successful run is an open circle", statusGlyph(false, "succeeded") === "○", statusGlyph(false, "succeeded"))
  check("an interrupted run is an open circle", statusGlyph(false, "interrupted") === "○", statusGlyph(false, "interrupted"))
  check("a running row ignores the previous outcome", statusGlyph(true, "failed") === "●", statusGlyph(true, "failed"))
}
// 5. Durations: wall clock while running, the completion once stopped.
{
  // The 3ms bug: the cached record still holds the creation time, the row must still show real elapsed time.
  const running = runDuration({ created: 1000, updated: 1003 }, true, 91_000)
  check("a running row counts wall clock, not the stale record", running === 90_000, String(running))
  const idle = runDuration({ created: 1000, updated: 9000, idle: 9500 }, false, 0)
  check("a finished row ends at its last completion", idle === 8500, String(idle))
  const noIdle = runDuration({ created: 1000, updated: 9000 }, false, 0)
  check("a row without a completion ends at its last update", noIdle === 8000, String(noIdle))
  check("a duration is never negative", runDuration({ created: 5000, updated: 4000 }, false, 0) === 0)
}

const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
