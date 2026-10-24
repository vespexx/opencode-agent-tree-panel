/**
 * LiteLLM alias resolver.
 * Fetches `/model/info` from a LiteLLM proxy (with Host header) and maps
 * model aliases → upstream model and display name.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

export interface UpstreamModel {
  /** The resolved upstream model identifier (e.g. "openrouter/minimax/minimax-m3.1-flash"). */
  upstream: string
  /** Human-friendly display name from LiteLLM model_info. */
  display?: string
}

/** Provider info shape we can get from ctx.data.location.provider.list(). */
export interface ProviderInfoLike {
  id: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
}

/** Cache entry for /model/info. */
interface CacheEntry {
  map: Map<string, UpstreamModel>
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
let cache: CacheEntry | null = null
let inflight: Promise<CacheEntry> | null = null

/** Expand `{file:...}` and `{env:...}` templates in config values. */
export function resolveTemplate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const m = value.match(/^\{(file|env):(.+)\}$/)
  if (!m) return value
  const [, type, target] = m
  if (type === "file") {
    const expanded = target.startsWith("~/")
      ? path.join(os.homedir(), target.slice(2))
      : path.resolve(target)
    try {
      return fs.readFileSync(expanded, "utf8").trim()
    } catch {
      return undefined
    }
  }
  if (type === "env") {
    return process.env[target]
  }
  return value
}

/** Try to discover LiteLLM endpoint from provider cache or config files. */
export function discoverEndpoint(
  providerID: string,
  providersFromCache: ProviderInfoLike[],
): { baseURL: string; apiKey: string; headers: Record<string, string> } | undefined {
  // 1) Try provider cache first
  const cached = providersFromCache.find((p) => p.id === providerID)
  if (cached) {
    const settings = (cached.settings ?? {}) as Record<string, unknown>
    const baseURL = resolveTemplate(settings.baseURL as string)
    const apiKey = resolveTemplate(settings.apiKey as string)
    const headers = (settings.headers as Record<string, string>) ?? cached.headers ?? {}
    if (baseURL && apiKey) return { baseURL, apiKey, headers }
  }

  // 2) Fallback: scan config files
  const configDirs: string[] = []
  if (process.env.OPENCODE_CONFIG) {
    configDirs.push(path.dirname(process.env.OPENCODE_CONFIG))
  }
  if (process.env.XDG_CONFIG_HOME) {
    configDirs.push(path.join(process.env.XDG_CONFIG_HOME, "opencode"))
  } else {
    configDirs.push(path.join(os.homedir(), ".config", "opencode"))
  }
  configDirs.push(process.cwd()) // project root may have opencode.json

  for (const dir of configDirs) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(dir, name)
      try {
        const raw = fs.readFileSync(file, "utf8")
        const json = parseJSONC(raw) as Record<string, unknown>
        const providers = (json.providers ?? json.provider ?? {}) as Record<string, unknown>
        const p = providers[providerID] as Record<string, unknown> | undefined
        if (!p) continue
        const settings = (p.settings as Record<string, unknown>) ?? {}
        const baseURL = resolveTemplate(settings.baseURL as string)
        const apiKey = resolveTemplate(settings.apiKey as string)
        const headers = { ...((p.headers as Record<string, string>) ?? {}), ...((settings.headers as Record<string, string>) ?? {}) }
        if (baseURL && apiKey) return { baseURL, apiKey, headers }
      } catch {
        // ignore parse/read errors
      }
    }
  }
  return undefined
}

/** Strip JSONC comments (// and block comments) outside strings, then parse JSON. */
function parseJSONC(text: string): Record<string, unknown> {
  let out = ""
  let i = 0
  let inString = false
  let escape = false
  while (i < text.length) {
    const c = text[i]
    if (!inString) {
      if (c === "/" && text[i + 1] === "/") {
        i += 2
        while (i < text.length && text[i] !== "\n") i++
        continue
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
        i += 2
        continue
      }
    }
    out += c
    if (c === '"' && !escape) inString = !inString
    escape = c === "\\" && !escape
    i++
  }
  return JSON.parse(out)
}

/** Fetch /model/info from LiteLLM using node:http (reliably sets Host header). */
async function fetchModelInfoRaw(
  baseURL: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  infoPath = "/model/info",
  timeout = 10000,
): Promise<Map<string, UpstreamModel>> {
  const url = new URL(infoPath, baseURL)
  const data = await new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...extraHeaders,
        },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data: body }))
      },
    )
    req.on("error", reject)
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")))
    req.end()
  })

  if (data.status !== 200) {
    throw new Error(`LiteLLM /model/info returned ${data.status}: ${data.data.slice(0, 120)}`)
  }

  let parsed: { data?: Array<{ model_name: string; litellm_params?: { model?: string }; model_info?: { display_name?: string } }> }
  try {
    parsed = JSON.parse(data.data)
  } catch {
    throw new Error("Failed to parse LiteLLM /model/info JSON")
  }

  const map = new Map<string, UpstreamModel>()
  for (const m of parsed.data ?? []) {
    const alias = m.model_name
    const upstream = m.litellm_params?.model
    const display = m.model_info?.display_name
    if (alias && upstream) map.set(alias, { upstream, display })
  }
  return map
}

/**
 * Get or build the alias → upstream map.
 * Cached for CACHE_TTL_MS. Concurrent calls deduplicate the fetch.
 */
export async function getAliasMap(
  providerID: string,
  providersFromCache: ProviderInfoLike[],
): Promise<Map<string, UpstreamModel>> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.map

  if (!inflight) {
    inflight = (async () => {
      const endpoint = discoverEndpoint(providerID, providersFromCache)
      if (!endpoint) throw new Error(`LiteLLM endpoint not found for provider ${providerID}`)
      const map = await fetchModelInfoRaw(
        endpoint.baseURL,
        endpoint.apiKey,
        endpoint.headers,
      )
      cache = { map, fetchedAt: Date.now() }
      inflight = null
      return cache
    })()
  }
  return inflight.then((c) => c.map)
}

/** Lookup a model alias, returning upstream model or undefined. */
export function lookupAlias(map: Map<string, UpstreamModel>, alias: string): UpstreamModel | undefined {
  return map.get(alias)
}

/** Normalise a session model to its alias string if it looks like a LiteLLM alias. */
export function extractAlias(model?: { id: string; providerID: string; variant?: string } | string): string | undefined {
  if (!model) return undefined
  if (typeof model === "string") return model
  return model.providerID === "litellm" ? model.id : undefined
}