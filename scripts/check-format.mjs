#!/usr/bin/env node
// Checks for the formatting/cost-estimate helpers the panel renders.
//
//   npm run build && npm run check
//
// The first case is the crash that shipped in 0.4.0: the panel renders before `/model/info` has answered, so the
// "rates used" line was built from an undefined pricing object and took the whole sidebar slot down.
import { fmtCost, fmtRate, fmtSpend, fmtTokens, rateLine, spendOf, sumSpend } from "../dist/format.js"
import { readPricing } from "../dist/litellm.js"

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

const usage = { input: 195530, output: 65727, reasoning: 53403, cacheRead: 26891776, cacheWrite: 0 }

// Prices as LiteLLM publishes them for deepseek-v4-flash-cloud-deepseek: peak rates plus a lower off-peak set.
const peak = { ...readPricing({ input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6, cache_read_input_token_cost: 6e-9 }), alias: "deepseek-v4-flash-cloud-deepseek" }
const offPeak = {
  ...readPricing({
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 6e-7,
    cache_read_input_token_cost: 3e-9,
    off_peak_pricing: { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, cache_read_input_token_cost: 3e-9 },
  }),
  alias: "deepseek-v4-flash-cloud-deepseek",
}

// 1. No prices yet (first render, non-LiteLLM model, unpriced deployment): everything must stay quiet.
{
  const unpriced = spendOf(0, usage, undefined)
  check("a session without prices is not estimated", unpriced.estimated === false && unpriced.cost === 0)
  check("no prices means no rate line", rateLine(unpriced, undefined, true) === undefined)
  check("an unpriced session still renders a total", fmtSpend(unpriced) === "$0.00")
  const priced = spendOf(0, usage, peak)
  check("the rate line never throws without a pricing object", rateLine(priced, undefined, true) === undefined)
  check("only the primary session explains its rates", rateLine(priced, peak, false) === undefined)
  check("a reported cost prints without the estimate marker", fmtSpend(spendOf(0.5, usage, peak)) === "$0.50")
}

// 2. The estimate itself: the screenshot session at LiteLLM's peak rates.
{
  const spend = spendOf(0, usage, peak)
  check("tokens are priced when nothing was reported", spend.estimated === true)
  check("the estimate matches the published rates", fmtSpend(spend) === "≈ $0.36", fmtSpend(spend))
  check(
    "the rate line names the rates in $/M",
    rateLine(spend, peak, true) === "≈ litellm max price · in $0.30/M · out $1.20/M · cache $0.006/M",
    String(rateLine(spend, peak, true)),
  )
  check(
    "off-peak rates would cost about half",
    Math.abs(spendOf(0, usage, offPeak).cost * 2 - spend.cost) < 1e-9,
    String(spendOf(0, usage, offPeak).cost),
  )
}

// 3. Small and large numbers keep their shape.
{
  check("sub-cent costs keep four digits", fmtCost(0.0035) === "$0.0035", fmtCost(0.0035))
  check("ordinary costs keep two", fmtCost(12.345) === "$12.35", fmtCost(12.345))
  check("zero stays zero", fmtCost(0) === "$0.00")
  check("rates below a cent per M keep three digits", fmtRate(6e-9) === "$0.006", fmtRate(6e-9))
  check("free rates are $0", fmtRate(0) === "$0")
  check("tokens use k/M", fmtTokens(195530) === "195.5k" && fmtTokens(26_891_776) === "26.9M", fmtTokens(195530))
}

// 4. A group total adds up per model and stays an estimate when any part of it is.
{
  const estimated = spendOf(0, usage, peak)
  const reported = spendOf(0.25, usage, undefined)
  const zero = spendOf(0, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, peak)
  check("an empty model contributes nothing", zero.cost === 0 && zero.estimated === false)
  const total = sumSpend([estimated, reported])
  check("a group total sums the parts", Math.abs(total.cost - (estimated.cost + 0.25)) < 1e-12, String(total.cost))
  check("a group total is marked when any part is estimated", total.estimated === true)
  check("a group of reported costs is not marked", sumSpend([reported]).estimated === false)
}

const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
