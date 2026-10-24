export interface UpstreamModel {
    /** The resolved upstream model identifier (e.g. "openrouter/minimax/minimax-m3.1-flash"). */
    upstream: string;
    /** Human-friendly display name from LiteLLM model_info. */
    display?: string;
}
/** One deployment (a single physical target) behind a LiteLLM alias. */
export interface DeploymentModel {
    /** `model_info.id` — the value LiteLLM returns as `x-litellm-model-id`. */
    id: string;
    /** The alias (`model_name`) this deployment belongs to. */
    alias: string;
    /** The upstream model (`litellm_params.model`). */
    upstream: string;
    display?: string;
}
/** Price of one token, in USD. */
export interface TokenPricing {
    input: number;
    /** Output tokens; reasoning tokens are billed at the same rate. */
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
/** A deployment's published prices, with the alias they belong to. */
export interface ModelPricing extends TokenPricing {
    /** `model_info.id` of the deployment; absent when an alias has several deployments with these same prices. */
    deployment?: string;
    /** The alias (`model_name`) these prices are published under. */
    alias: string;
    /** Upstream model behind the deployment. */
    upstream?: string;
}
/** Token counts of one or more requests, split the way the harness counts them. */
export interface TokenUsage {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
}
/** Everything the panel needs from `/model/info`. */
export interface LiteLLMData {
    /** alias → upstream model. */
    aliases: Map<string, UpstreamModel>;
    /** deployment id (lowercase) → deployment, so a served id can be named. */
    deployments: Map<string, DeploymentModel>;
    /** deployment id (lowercase) → published prices. */
    pricing: Map<string, ModelPricing>;
    /** alias → prices, only when every deployment of that alias publishes the same rates. */
    aliasPricing: Map<string, ModelPricing>;
}
/** One row of `/model/info` — only the fields this module reads. */
export interface ModelInfoRow {
    model_name: string;
    litellm_params?: {
        model?: string;
    };
    model_info?: {
        id?: string;
        display_name?: string;
    } & Record<string, unknown>;
}
/** Provider info shape we can get from ctx.data.location.provider.list(). */
export interface ProviderInfoLike {
    id: string;
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
}
/** Expand `{file:...}` and `{env:...}` templates in config values. */
export declare function resolveTemplate(value: string | undefined): string | undefined;
/** Try to discover LiteLLM endpoint from provider cache or config files. */
export declare function discoverEndpoint(providerID: string, providersFromCache: ProviderInfoLike[]): {
    baseURL: string;
    apiKey: string;
    headers: Record<string, string>;
} | undefined;
/**
 * The highest published per-token price of one deployment, or `undefined` when the proxy publishes none.
 *
 * Why the maximum: a completed request does not say which rate it was billed at (the response headers carry the
 * deployment, not the price), and the panel shows a session that may span peak and off-peak hours. Taking the highest
 * rate makes the number an upper bound — it can be too high, never too low. A deployment whose `input_cost_per_token`
 * is absent or zero is treated as unpriced (free models included).
 */
export declare function readPricing(info: Record<string, unknown> | undefined): TokenPricing | undefined;
/** Build the alias, deployment and pricing maps from `/model/info` rows. */
export declare function buildModelMaps(rows: ModelInfoRow[]): LiteLLMData;
/** Price the tokens of one request at these rates. `undefined` when the model publishes no prices. */
export declare function estimateCost(pricing: TokenPricing | undefined, usage: TokenUsage): number | undefined;
/**
 * Prices for a session's model: the deployment that actually answered wins, the alias is the fallback.
 * The deployment matters when an alias fans out to several targets with different prices.
 */
export declare function lookupPricing(data: LiteLLMData, alias: string | undefined, servedID?: string): ModelPricing | undefined;
/**
 * Get or build the `/model/info` maps.
 * Cached for CACHE_TTL_MS. Concurrent calls deduplicate the fetch.
 */
export declare function getLiteLLMData(providerID: string, providersFromCache: ProviderInfoLike[]): Promise<LiteLLMData>;
/** The alias → upstream map only (kept for callers that do not need deployment ids). */
export declare function getAliasMap(providerID: string, providersFromCache: ProviderInfoLike[]): Promise<Map<string, UpstreamModel>>;
/** Lookup a model alias, returning upstream model or undefined. */
export declare function lookupAlias(map: Map<string, UpstreamModel>, alias: string): UpstreamModel | undefined;
/** Lookup the deployment behind an `x-litellm-model-id` value. */
export declare function lookupDeployment(map: Map<string, DeploymentModel>, servedID: string | undefined): DeploymentModel | undefined;
/** Normalise a session model to its alias string if it looks like a LiteLLM alias. */
export declare function extractAlias(model?: {
    id: string;
    providerID: string;
    variant?: string;
} | string): string | undefined;
//# sourceMappingURL=litellm.d.ts.map