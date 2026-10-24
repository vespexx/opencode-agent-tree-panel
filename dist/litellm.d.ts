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
/** Everything the panel needs from `/model/info`. */
export interface LiteLLMData {
    /** alias → upstream model. */
    aliases: Map<string, UpstreamModel>;
    /** deployment id (lowercase) → deployment, so a served id can be named. */
    deployments: Map<string, DeploymentModel>;
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