#!/usr/bin/env node
// Sanity checks for the model-history logic used by the sidebar panel.
//
//   npm run build && npm run check
//
// The first cases are synthetic (they describe the situations the panel must survive); the last one replays a real
// session from ~/.local/share/opencode/opencode.db when the database is available.
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { cachedModelHistory, forgetSession, readModelHistory, recordModelSwitch } from "../dist/models.js"

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

const A = { providerID: "opencode", id: "deepseek-v4.1-flash-free" }
const B = { providerID: "litellm", id: "deepseek-v4-flash-cloud-deepseek" }
const C = { providerID: "lmstudio", id: "qwen3.6-35b-a3b-win-lmstudio" }
const session = (id, model, updated = 9999) => ({ id, model, time: { updated } })

// 1. Fallback in the middle of a request: the transcript has one assistant turn on A, then a switch to B.
{
  forgetSession("s-mid")
  const history = readModelHistory(session("s-mid", B), [
    {
      id: "m1",
      type: "assistant",
      model: A,
      time: { created: 1000, completed: 1600 },
      cost: 0.002,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
    },
    { id: "m2", type: "model-switched", model: B, previous: A, time: { created: 2000 } },
  ])
  check("mid-request fallback keeps the current model", history.current === B)
  check("mid-request fallback lists the replaced model", history.previous.length === 1 && history.previous[0].ref === A,
    JSON.stringify(history.previous))
  check("the replaced model keeps its request count", history.previous[0]?.requests === 1)
  check("the replaced model reports its own tokens", history.previous[0]?.tokens === 115, String(history.previous[0]?.tokens))
  check("the replaced model reports its own cost", history.previous[0]?.cost === 0.002, String(history.previous[0]?.cost))
  check("the replaced model reports its own time", history.previous[0]?.duration === 600, String(history.previous[0]?.duration))
}

// 2. Two user switches between requests: A -> B -> A. A is current again, B is the only past model.
{
  forgetSession("s-user")
  const history = readModelHistory(session("s-user", A), [
    { id: "m1", type: "assistant", model: A, time: { created: 1000, completed: 1100 } },
    { id: "m2", type: "model-switched", model: B, previous: A, time: { created: 2000 } },
    { id: "m3", type: "assistant", model: B, time: { created: 3000, completed: 3100 } },
    { id: "m4", type: "model-switched", model: A, previous: B, time: { created: 4000 } },
    { id: "m5", type: "assistant", model: A, time: { created: 5000, completed: 5100 } },
  ])
  check("a model used again stays on top", history.current === A)
  check("models are not duplicated after a round trip", history.previous.length === 1 && history.previous[0].ref === B,
    JSON.stringify(history.previous.map((use) => use.ref)))
  check("all requests of the past model are counted", history.previous[0]?.requests === 1)
}

// 3. A switch that fell out of the short transcript window is recovered from the live event.
{
  forgetSession("s-live")
  recordModelSwitch("s-live", B, A, 8000)
  const history = cachedModelHistory(session("s-live", B), [
    { id: "m1", type: "assistant", model: B, time: { created: 8000, completed: 8100 } },
  ])
  check("live switch adds the model that was left", history.previous.length === 1 && history.previous[0].ref === A,
    JSON.stringify(history.previous.map((use) => use.ref)))
  // Cached read must be stable for the same input.
  const again = cachedModelHistory(session("s-live", B), [
    { id: "m1", type: "assistant", model: B, time: { created: 8000, completed: 8100 } },
  ])
  check("history is memoised", again === history)
  // A new switch invalidates the memo even without new messages.
  recordModelSwitch("s-live", C, B, 9000)
  const next = cachedModelHistory(session("s-live", C), [
    { id: "m1", type: "assistant", model: B, time: { created: 8000, completed: 8100 } },
  ])
  check("a live switch invalidates the cached history", next !== history && next.current === C)
  check("both past models are kept", next.previous.map((use) => use.ref).length === 2,
    JSON.stringify(next.previous.map((use) => use.ref)))
}

// 4. Replay a real session from the local database, if present.
const db = path.join(os.homedir(), ".local/share/opencode/opencode.db")
try {
  const query = (sql) => JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }) || "[]")
  const [worst] = query(
    "select session_id, count(*) as switches from session_message where type='model-switched' group by session_id order by switches desc limit 1",
  )
  if (worst?.session_id) {
    const [row] = query(`select model from session_v2 where id='${worst.session_id}'`)
    // Same shape the panel sees: the tail of the transcript, newest 20 entries.
    const rows = query(
      `select type, time_created, data from session_message where session_id='${worst.session_id}' order by seq desc limit 20`,
    ).reverse()
    const messages = rows
      .map((entry) => ({ id: String(entry.data).slice(0, 24), type: entry.type, ...JSON.parse(entry.data) }))
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        model: entry.model,
        previous: entry.previous,
        time: entry.time,
        cost: entry.cost,
        tokens: entry.tokens,
      }))
    const model = row?.model ? JSON.parse(row.model) : undefined
    forgetSession(worst.session_id)
    const history = readModelHistory(session(worst.session_id, model), messages)
    check("real session: current model matches the session record", Boolean(model) && history.current === model,
      `db=${JSON.stringify(model)} history=${JSON.stringify(history.current)}`)
    check("real session: the replaced model has usage attached",
      history.previous.every((use) => use.tokens > 0 && use.duration > 0),
      JSON.stringify(history.previous))
    console.log(
      `real session ${worst.session_id} (${worst.switches} switches, window ${messages.length} messages):\n` +
        `  current: ${JSON.stringify(history.current)} (session totals ${history.previous.length} other models)\n` +
        history.previous
          .map(
            (use) =>
              `  past:    ${JSON.stringify(use.ref)} ×${use.requests} — ${use.tokens} tok, $${use.cost}, ${use.duration}ms`,
          )
          .join("\n"),
    )
  }
} catch (error) {
  console.log(`(skipped real-session replay: ${error.message})`)
}

const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
