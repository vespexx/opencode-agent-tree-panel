#!/usr/bin/env node
// Checks for the "what LiteLLM actually served" path: response headers → JSONL log → panel summary.
//
//   npm run build && npm run check
//
// The header values below are copied from a real LiteLLM 1.106.2 response on this machine, so the parse is checked
// against the shape the proxy really sends. The last block talks to the live proxy when it is reachable.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { servedFile } from "../dist/served.js"

// The log path is read from the environment at call time, so the checks write to a scratch directory.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tree-panel-"))
process.env.AGENT_TREE_PANEL_DIR = scratch

const { appendServed, forgetServed, readServed, servedFromResponse, servedSummary } = await import("../dist/served.js")
const { getLiteLLMData } = await import("../dist/litellm.js")

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

const ALIAS = "deepseek-v4-flash-cloud-deepseek"
const DEPLOYMENT_ID = "75921bbf5223b98a0c2bb3c16acc382dc52f4b77ec33603fdb0f5da01c29fee0"
const MODEL = { providerID: "litellm", id: ALIAS }

/** A real-shaped LiteLLM response: only the headers the panel reads matter. */
function litellmResponse(overrides = {}) {
  const headers = {
    "x-litellm-model-id": DEPLOYMENT_ID,
    "x-litellm-model-name": "deepseek/deepseek-flash",
    "x-litellm-model-group": ALIAS,
    "x-litellm-model-api-base": "https://api.deepseek.com/v1",
    "x-litellm-attempted-fallbacks": "0",
    "x-litellm-attempted-retries": "0",
    ...overrides,
  }
  return new Response("{}", { status: 200, headers })
}

// 1. Parse a normal response.
{
  const record = servedFromResponse({
    sessionID: "ses_test",
    agent: "build",
    kind: "primary",
    model: MODEL,
    response: litellmResponse(),
  })
  check("record is built from a LiteLLM response", Boolean(record))
  check("deployment id is taken from x-litellm-model-id", record?.servedID === DEPLOYMENT_ID, String(record?.servedID))
  check("served model comes from x-litellm-model-name", record?.servedName === "deepseek/deepseek-flash")
  check("alias group comes from x-litellm-model-group", record?.servedGroup === ALIAS)
  check("fallback/retry counters are numbers", record?.fallbacks === 0 && record?.retries === 0)
}

// 2. Things that must not be recorded.
{
  const other = servedFromResponse({
    sessionID: "ses_test",
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    response: litellmResponse(),
  })
  check("non-LiteLLM traffic is ignored", other === undefined)
  const bare = servedFromResponse({ sessionID: "ses_test", model: MODEL, response: new Response("{}") })
  check("a response without LiteLLM headers is ignored", bare === undefined)
  const noSession = servedFromResponse({ model: MODEL, response: litellmResponse() })
  check("a record without a session id is ignored", noSession === undefined)
}

// 3. Append + read round trip, with the dedupe the file relies on.
{
  forgetServed()
  const response = litellmResponse()
  const payload = { sessionID: "ses_a", agent: "build", kind: "primary", model: MODEL, response }
  appendServed(servedFromResponse(payload, 1000))
  appendServed(servedFromResponse(payload, 2000))
  // The hook can be registered twice by the loader; the same observation must not appear twice.
  const duplicate = readServed()[0]
  fs.appendFileSync(servedFile(), `${JSON.stringify(duplicate)}\n`)
  fs.appendFileSync(servedFile(), "not json at all\n")
  forgetServed()
  const records = readServed()
  check("records survive a write/read cycle", records.length === 2, JSON.stringify(records.length))
  check("identical observations are not duplicated", new Set(records.map((r) => r.at)).size === 2)
  check("a malformed line is skipped instead of failing the read", records.every((r) => r.sessionID === "ses_a"))
  check("the log lives in the configured directory", servedFile().startsWith(scratch), servedFile())

  // A hook registered twice would observe the same response twice, milliseconds apart.
  const before = fs.readFileSync(servedFile(), "utf8").split("\n").filter(Boolean).length
  appendServed(servedFromResponse(payload, 1500))
  const after = fs.readFileSync(servedFile(), "utf8").split("\n").filter(Boolean).length
  check("the same response is not appended twice", before === after, `${before} -> ${after}`)
}

// 4. Summary: which deployment answered, and whether that was a fallback.
{
  const deployments = new Map([
    [DEPLOYMENT_ID.toLowerCase(), { id: DEPLOYMENT_ID, alias: ALIAS, upstream: "deepseek/deepseek-flash" }],
    ["aaaa1111", { id: "aaaa1111", alias: "some-other-alias", upstream: "openrouter/meta/llama-3.3-70b" }],
  ])
  forgetServed()
  const same = servedSummary(readServed(), "ses_a", MODEL, ALIAS, deployments)
  check("summary resolves the deployment to its alias", same?.servedAlias === ALIAS, JSON.stringify(same))
  check("a plain success is not a fallback", same?.fallback === false)
  check("summary keeps the deployment id", same?.servedID === DEPLOYMENT_ID)

  appendServed(
    servedFromResponse(
      {
        sessionID: "ses_b",
        model: MODEL,
        response: litellmResponse({
          "x-litellm-model-id": "aaaa1111",
          "x-litellm-model-name": "openrouter/meta/llama-3.3-70b",
          "x-litellm-model-group": "some-other-alias",
          "x-litellm-attempted-fallbacks": "1",
        }),
      },
      3000,
    ),
  )
  forgetServed()
  const fellBack = servedSummary(readServed(), "ses_b", MODEL, ALIAS, deployments)
  check("a different deployment is marked as a fallback", fellBack?.fallback === true, JSON.stringify(fellBack))
  check("the fallback names what answered", fellBack?.name === "openrouter/meta/llama-3.3-70b", String(fellBack?.name))
  check("the fallback counts the attempts", fellBack?.fallbacks === 1, String(fellBack?.fallbacks))
  check("another session's rows are not mixed in", servedSummary(readServed(), "ses_c", MODEL, ALIAS, deployments) === undefined)
}

// 5. The server entry: one hook registration, and it writes what the hook receives.
{
  const plugin = (await import("../dist/index.js")).default
  const registered = []
  const ctx = {
    session: {
      hook(name, callback) {
        registered.push({ name, callback })
        return Promise.resolve({ dispose: () => {} })
      },
    },
  }
  await plugin.server(ctx)
  plugin.setup(ctx) // the loader may call both; the hook must not be registered twice
  check("server entry registers exactly one hook", registered.length === 1, JSON.stringify(registered.map((r) => r.name)))
  check("the hook is http.response", registered[0]?.name === "http.response", String(registered[0]?.name))

  forgetServed()
  await registered[0]?.callback({
    sessionID: "ses_hook",
    agent: "build",
    kind: "primary",
    model: MODEL,
    response: litellmResponse(),
  })
  forgetServed()
  const written = readServed().filter((record) => record.sessionID === "ses_hook")
  check("the hook appends the served deployment", written.length === 1 && written[0]?.servedID === DEPLOYMENT_ID)
  check(
    "the hook ignores non-LiteLLM traffic",
    (await registered[0]?.callback({
      sessionID: "ses_hook",
      model: { providerID: "opencode", id: "free" },
      response: litellmResponse(),
    })) === undefined && readServed().filter((record) => record.sessionID === "ses_hook").length === 1,
  )}

// 6. Live proxy (optional): a real chat completion must carry the deployment id the map knows.
try {
  const data = await getLiteLLMData("litellm", [])
  check("live /model/info yields aliases", data.aliases.size > 0, `${data.aliases.size} aliases`)
  check("live /model/info yields deployments", data.deployments.size > 0, `${data.deployments.size} deployments`)
  const hit = data.deployments.get(DEPLOYMENT_ID.toLowerCase())
  check("the deployment from the captured headers is known to the live proxy", Boolean(hit), String(hit?.alias))
  const alias = data.aliases.get(ALIAS)
  check("the alias still resolves to its upstream", Boolean(alias?.upstream), String(alias?.upstream))
} catch (error) {
  console.log(`(skipped live proxy checks: ${error.message})`)
}

// 7. Live request (optional): the headers of a real completion, parsed exactly as the server hook does it.
try {
  const { discoverEndpoint } = await import("../dist/litellm.js")
  const { default: http } = await import("node:http")
  const endpoint = discoverEndpoint("litellm", [])
  if (!endpoint) throw new Error("no LiteLLM endpoint in the config")
  const url = new URL("/v1/chat/completions", endpoint.baseURL)
  const headers = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: ALIAS, messages: [{ role: "user", content: "say ok" }], max_tokens: 4 })
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...endpoint.headers,
        },
      },
      (res) => {
        res.resume()
        res.on("end", () => resolve(res.headers))
      },
    )
    req.on("error", reject)
    req.setTimeout(30000, () => req.destroy(new Error("timeout")))
    req.end(body)
  })
  const record = servedFromResponse({
    sessionID: "ses_live",
    model: MODEL,
    response: { headers: { get: (name) => (Array.isArray(headers[name]) ? headers[name][0] : headers[name]) ?? null } },
  })
  check("a live completion reports its deployment id", Boolean(record?.servedID), JSON.stringify(record))
  check("the live deployment belongs to the requested alias", record?.servedGroup === ALIAS, String(record?.servedGroup))
  check("the live request did not fall back", record?.fallbacks === 0, String(record?.fallbacks))
} catch (error) {
  console.log(`(skipped live request check: ${error.message})`)
}

fs.rmSync(scratch, { recursive: true, force: true })
const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
