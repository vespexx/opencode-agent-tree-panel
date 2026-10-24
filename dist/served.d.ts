/** One observed LiteLLM response. */
export interface ServedRecord {
    /** When the response arrived (ms since epoch). */
    at: number;
    sessionID: string;
    agent?: string;
    /** Why the request was made: "primary" for the agent loop, "title"/"compaction"/"generate" for auxiliary calls. */
    kind?: string;
    /** The model OpenCode asked for (the LiteLLM alias for this provider). */
    model: {
        id: string;
        providerID: string;
        variant?: string;
    };
    /** `x-litellm-model-id`: the deployment that actually answered. */
    servedID?: string;
    /** `x-litellm-model-name`: the upstream model behind that deployment. */
    servedName?: string;
    /** `x-litellm-model-group`: the alias the served deployment belongs to. */
    servedGroup?: string;
    /** `x-litellm-model-api-base`, when LiteLLM reports it. */
    apiBase?: string;
    /** `x-litellm-attempted-fallbacks`: LiteLLM itself moved to another deployment. */
    fallbacks: number;
    /** `x-litellm-attempted-retries`. */
    retries: number;
}
/** The part of a hook payload this module needs (works for any `{ headers }` shaped response). */
export interface ServedSource {
    readonly sessionID?: string;
    readonly agent?: unknown;
    readonly kind?: unknown;
    readonly model?: unknown;
    readonly response?: {
        readonly headers?: {
            get(name: string): string | null;
        };
    } | undefined;
}
/** Directory holding the served-model log. `AGENT_TREE_PANEL_DIR` overrides it (used by the checks). */
export declare function servedDir(): string;
/** Absolute path of the served-model log. */
export declare function servedFile(): string;
/**
 * Turn a response hook payload into a record, or `undefined` when it is not a LiteLLM response we can describe.
 * Everything comes from the real headers; nothing is guessed from the requested model.
 */
export declare function servedFromResponse(source: ServedSource, at?: number): ServedRecord | undefined;
/**
 * Append one observation. Never throws: this runs inside a request hook, and a panel that cannot write its log must not
 * break the session.
 */
export declare function appendServed(record: ServedRecord): void;
/** Parse the log, memoised on the file's size/mtime. Malformed lines are skipped, never fatal. */
export declare function readServed(): ServedRecord[];
/** Drop the memoised log (used by the checks). */
export declare function forgetServed(): void;
/** What the panel needs to know about one model of one session. */
export interface ServedSummary {
    /** The upstream model that answered (latest request). */
    name?: string;
    /** The deployment id that answered (latest request). */
    servedID?: string;
    /** The alias that deployment belongs to; differs from the requested alias when LiteLLM fell back. */
    servedAlias?: string;
    /** Observations for this model in this session. */
    count: number;
    /** Sum of `x-litellm-attempted-fallbacks` over those observations. */
    fallbacks: number;
    retries: number;
    /** Newest observation. */
    at: number;
    /** True when LiteLLM (or the router) answered from something other than the requested alias. */
    fallback: boolean;
}
/**
 * Summarise the observations for one model of one session.
 *
 * `requestedAlias` is what OpenCode asked for (the LiteLLM alias). When the deployment that answered belongs to a
 * different alias, or LiteLLM reports an attempted fallback, the summary is marked as a fallback — that case is exactly
 * what this file exists for.
 */
export declare function servedSummary(records: ServedRecord[], sessionID: string, model: {
    id: string;
    providerID: string;
    variant?: string;
} | string | undefined, requestedAlias?: string, deployments?: Map<string, {
    alias?: string;
    upstream?: string;
}>): ServedSummary | undefined;
//# sourceMappingURL=served.d.ts.map