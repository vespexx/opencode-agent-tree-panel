/**
 * Number formatting and cost estimation for the panel.
 *
 * Kept free of JSX and of the TUI runtime so `npm run check` can exercise it directly: these helpers decide what the
 * user reads, and a wrong one is invisible until somebody notices a panel that crashed or a number that makes no sense.
 */
import { estimateCost, type ModelPricing } from "./litellm.js"
import type { Usage } from "./models.js"

export function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(value))
}

export function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`
}

/** A per-token rate as USD per million tokens, the unit prices are usually compared in. */
export function fmtRate(perToken: number): string {
  const perMillion = perToken * 1_000_000
  if (!Number.isFinite(perMillion) || perMillion <= 0) return "$0"
  if (perMillion >= 0.1) return `$${perMillion.toFixed(2)}`
  if (perMillion >= 0.001) return `$${perMillion.toFixed(3)}`
  return `$${perMillion.toFixed(4)}`
}

/** Money shown for one model or session: the reported cost, or an estimate at LiteLLM prices. */
export interface Spend {
  cost: number
  /** True when the number was computed from published rates instead of reported by the harness. */
  estimated: boolean
}

/**
 * Cost of some tokens, preferring the number OpenCode reported.
 *
 * OpenCode prices a model only when it knows the id (its model registry); a locally defined LiteLLM alias is unknown to
 * it, so every message of such a model comes back with `cost: 0` even though the proxy charges for it. In that case the
 * panel prices the tokens itself from `/model/info` — at the highest published rate, so the number is an upper bound.
 */
export function spendOf(reported: number, usage: Usage, pricing: ModelPricing | undefined): Spend {
  if (reported > 0) return { cost: reported, estimated: false }
  const estimate = estimateCost(pricing, usage)
  return estimate && estimate > 0 ? { cost: estimate, estimated: true } : { cost: reported, estimated: false }
}

/** Sum of several spends; the total is an estimate when any part of it is. */
export function sumSpend(spends: Spend[]): Spend {
  return { cost: spends.reduce((sum, spend) => sum + spend.cost, 0), estimated: spends.some((spend) => spend.estimated) }
}

/** `$0.36`, or `≈ $0.36` when the number is an estimate. */
export function fmtSpend(spend: Spend): string {
  return `${spend.estimated ? "≈ " : ""}${fmtCost(spend.cost)}`
}

/**
 * The "which rates did you use" line under the primary session's total — and nothing at all otherwise.
 *
 * Everything here is optional by design: the panel renders before `/model/info` has answered, so a model without prices
 * (or a sub-agent) must produce `undefined` instead of touching `pricing` fields.
 */
export function rateLine(spend: Spend, pricing: ModelPricing | undefined, primary: boolean): string | undefined {
  if (!spend.estimated || !primary || !pricing) return undefined
  return (
    `≈ litellm max price · in ${fmtRate(pricing.input)}/M · out ${fmtRate(pricing.output)}/M · ` +
    `cache ${fmtRate(pricing.cacheRead)}/M`
  )
}
