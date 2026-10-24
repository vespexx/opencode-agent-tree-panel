/**
 * LiteLLM alias resolver.
 * Fetches `/model/info` from a LiteLLM proxy (with Host header) and maps
 * model aliases → upstream model and display name.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;
let inflight = null;
/** Expand `{file:...}` and `{env:...}` templates in config values. */
export function resolveTemplate(value) {
    if (!value)
        return undefined;
    const m = value.match(/^\{(file|env):(.+)\}$/);
    if (!m)
        return value;
    const [, type, target] = m;
    if (type === "file") {
        const expanded = target.startsWith("~/")
            ? path.join(os.homedir(), target.slice(2))
            : path.resolve(target);
        try {
            return fs.readFileSync(expanded, "utf8").trim();
        }
        catch {
            return undefined;
        }
    }
    if (type === "env") {
        return process.env[target];
    }
    return value;
}
/** Try to discover LiteLLM endpoint from provider cache or config files. */
export function discoverEndpoint(providerID, providersFromCache) {
    // 1) Try provider cache first
    const cached = providersFromCache.find((p) => p.id === providerID);
    if (cached) {
        const settings = (cached.settings ?? {});
        const baseURL = resolveTemplate(settings.baseURL);
        const apiKey = resolveTemplate(settings.apiKey);
        const headers = settings.headers ?? cached.headers ?? {};
        if (baseURL && apiKey)
            return { baseURL, apiKey, headers };
    }
    // 2) Fallback: scan config files
    const configDirs = [];
    if (process.env.OPENCODE_CONFIG) {
        configDirs.push(path.dirname(process.env.OPENCODE_CONFIG));
    }
    if (process.env.XDG_CONFIG_HOME) {
        configDirs.push(path.join(process.env.XDG_CONFIG_HOME, "opencode"));
    }
    else {
        configDirs.push(path.join(os.homedir(), ".config", "opencode"));
    }
    configDirs.push(process.cwd()); // project root may have opencode.json
    for (const dir of configDirs) {
        for (const name of ["opencode.json", "opencode.jsonc"]) {
            const file = path.join(dir, name);
            try {
                const raw = fs.readFileSync(file, "utf8");
                const json = parseJSONC(raw);
                const providers = (json.providers ?? json.provider ?? {});
                const p = providers[providerID];
                if (!p)
                    continue;
                const settings = p.settings ?? {};
                const baseURL = resolveTemplate(settings.baseURL);
                const apiKey = resolveTemplate(settings.apiKey);
                const headers = { ...(p.headers ?? {}), ...(settings.headers ?? {}) };
                if (baseURL && apiKey)
                    return { baseURL, apiKey, headers };
            }
            catch {
                // ignore parse/read errors
            }
        }
    }
    return undefined;
}
/** Strip JSONC comments (// and block comments) outside strings, then parse JSON. */
function parseJSONC(text) {
    let out = "";
    let i = 0;
    let inString = false;
    let escape = false;
    while (i < text.length) {
        const c = text[i];
        if (!inString) {
            if (c === "/" && text[i + 1] === "/") {
                i += 2;
                while (i < text.length && text[i] !== "\n")
                    i++;
                continue;
            }
            if (c === "/" && text[i + 1] === "*") {
                i += 2;
                while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                    i++;
                i += 2;
                continue;
            }
        }
        out += c;
        if (c === '"' && !escape)
            inString = !inString;
        escape = c === "\\" && !escape;
        i++;
    }
    return JSON.parse(out);
}
/**
 * Cost fields of `model_info` that are per-token prices, grouped by the kind of token they price.
 *
 * LiteLLM publishes more than one rate per token: peak and off-peak (`off_peak_pricing`, DeepSeek's time-of-day
 * billing), speed variants (`_flex`, `_priority`, `_balanced`, `_ultrafast`), batch rates and long-context tiers
 * (`_above_128k_tokens`, `_above_200k_tokens`, …). Every one of them is USD per token, so they all belong here.
 */
const PRICE_FAMILIES = [
    ["input", /^input_cost_per_token/i],
    ["output", /^output_cost_per_token/i],
    ["output", /^output_cost_per_reasoning_token/i],
    ["cacheRead", /^cache_read_input_token_cost/i],
    ["cacheWrite", /^cache_creation_input_token_cost/i],
];
/**
 * The highest published per-token price of one deployment, or `undefined` when the proxy publishes none.
 *
 * Why the maximum: a completed request does not say which rate it was billed at (the response headers carry the
 * deployment, not the price), and the panel shows a session that may span peak and off-peak hours. Taking the highest
 * rate makes the number an upper bound — it can be too high, never too low. A deployment whose `input_cost_per_token`
 * is absent or zero is treated as unpriced (free models included).
 */
export function readPricing(info) {
    if (!info)
        return undefined;
    const rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const take = (key, value) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
            return;
        for (const [kind, pattern] of PRICE_FAMILIES) {
            if (pattern.test(key) && value > rates[kind])
                rates[kind] = value;
        }
    };
    for (const [key, value] of Object.entries(info)) {
        // Off-peak rates are nested one level down; they are usually lower, but they are still candidates.
        if (key === "off_peak_pricing" && value && typeof value === "object") {
            for (const [nestedKey, nestedValue] of Object.entries(value))
                take(nestedKey, nestedValue);
            continue;
        }
        take(key, value);
    }
    return rates.input > 0 ? rates : undefined;
}
function sameRates(a, b) {
    return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}
/** Build the alias, deployment and pricing maps from `/model/info` rows. */
export function buildModelMaps(rows) {
    const aliases = new Map();
    const deployments = new Map();
    const pricing = new Map();
    const perAlias = new Map();
    for (const m of rows) {
        const alias = m.model_name;
        const upstream = m.litellm_params?.model;
        const display = m.model_info?.display_name;
        if (!alias || !upstream)
            continue;
        aliases.set(alias, { upstream, display });
        // model_info.id is exactly what LiteLLM echoes in x-litellm-model-id on the response.
        const id = m.model_info?.id;
        if (id)
            deployments.set(id.toLowerCase(), { id, alias, upstream, display });
        const rates = readPricing(m.model_info);
        if (!id || !rates)
            continue;
        const entry = { ...rates, deployment: id, alias, upstream };
        pricing.set(id.toLowerCase(), entry);
        const group = perAlias.get(alias) ?? [];
        group.push(entry);
        perAlias.set(alias, group);
    }
    // An alias is priced as a whole only when all its deployments agree; otherwise only the served deployment is priced.
    const aliasPricing = new Map();
    for (const [alias, entries] of perAlias) {
        const first = entries[0];
        if (!first)
            continue;
        if (entries.every((entry) => sameRates(entry, first))) {
            aliasPricing.set(alias, { ...first, deployment: entries.length === 1 ? first.deployment : undefined });
        }
    }
    return { aliases, deployments, pricing, aliasPricing };
}
/** Price the tokens of one request at these rates. `undefined` when the model publishes no prices. */
export function estimateCost(pricing, usage) {
    if (!pricing)
        return undefined;
    return (usage.input * pricing.input +
        (usage.output + usage.reasoning) * pricing.output +
        usage.cacheRead * pricing.cacheRead +
        usage.cacheWrite * pricing.cacheWrite);
}
/**
 * Prices for a session's model: the deployment that actually answered wins, the alias is the fallback.
 * The deployment matters when an alias fans out to several targets with different prices.
 */
export function lookupPricing(data, alias, servedID) {
    if (servedID) {
        const served = data.pricing.get(servedID.toLowerCase());
        if (served)
            return served;
    }
    return alias ? data.aliasPricing.get(alias) : undefined;
}
/** Fetch /model/info from LiteLLM using node:http (reliably sets Host header). */
async function fetchModelInfoRaw(baseURL, apiKey, extraHeaders, infoPath = "/model/info", timeout = 10000) {
    const url = new URL(infoPath, baseURL);
    const data = await new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: "application/json",
                ...extraHeaders,
            },
        }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, data: body }));
        });
        req.on("error", reject);
        req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
        req.end();
    });
    if (data.status !== 200) {
        throw new Error(`LiteLLM /model/info returned ${data.status}: ${data.data.slice(0, 120)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(data.data);
    }
    catch {
        throw new Error("Failed to parse LiteLLM /model/info JSON");
    }
    return buildModelMaps(parsed.data ?? []);
}
/**
 * Get or build the `/model/info` maps.
 * Cached for CACHE_TTL_MS. Concurrent calls deduplicate the fetch.
 */
export async function getLiteLLMData(providerID, providersFromCache) {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS)
        return cache.data;
    if (!inflight) {
        inflight = (async () => {
            const endpoint = discoverEndpoint(providerID, providersFromCache);
            if (!endpoint)
                throw new Error(`LiteLLM endpoint not found for provider ${providerID}`);
            const data = await fetchModelInfoRaw(endpoint.baseURL, endpoint.apiKey, endpoint.headers);
            cache = { data, fetchedAt: Date.now() };
            inflight = null;
            return cache;
        })();
    }
    return inflight.then((c) => c.data);
}
/** The alias → upstream map only (kept for callers that do not need deployment ids). */
export async function getAliasMap(providerID, providersFromCache) {
    return (await getLiteLLMData(providerID, providersFromCache)).aliases;
}
/** Lookup a model alias, returning upstream model or undefined. */
export function lookupAlias(map, alias) {
    return map.get(alias);
}
/** Lookup the deployment behind an `x-litellm-model-id` value. */
export function lookupDeployment(map, servedID) {
    if (!servedID)
        return undefined;
    return map.get(servedID.toLowerCase());
}
/** Normalise a session model to its alias string if it looks like a LiteLLM alias. */
export function extractAlias(model) {
    if (!model)
        return undefined;
    if (typeof model === "string")
        return model;
    return model.providerID === "litellm" ? model.id : undefined;
}
//# sourceMappingURL=litellm.js.map