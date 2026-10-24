/**
 * Model bookkeeping for the agent tree panel.
 *
 * A session record only keeps the model selected *right now*. Everything that matters for a fallback — which model
 * served the previous request, which one was left behind by a mid-request switch — lives in the transcript:
 * the harness appends a `model-switched` entry (with `previous`) for every change, and every assistant message
 * records the model that served it. This module turns that into a "current on top, past below" list.
 */
/** Model reference as it arrives from the cache: an object, or a plain "provider/model" string. */
export type ModelValue = {
    id: string;
    providerID: string;
    variant?: string;
} | string;
/** The fields of a transcript entry this module needs. */
export interface TranscriptMessage {
    id: string;
    type: string;
    model?: ModelValue;
    previous?: ModelValue;
    time?: {
        created?: number;
        streamed?: number;
        completed?: number;
    };
    cost?: number;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
}
/** The session fields used here: identity, the current model and the last update timestamp. */
export interface SessionLike {
    id: string;
    model?: ModelValue;
    time: {
        updated: number;
    };
}
/** Tokens of one or more requests, split the way the harness counts them. */
export interface Usage {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
}
/** A zeroed usage (the starting point for accumulation). */
export declare function emptyUsage(): Usage;
/** Split a message's token record into a `Usage`; missing fields count as zero. */
export declare function usageOf(tokens: TranscriptMessage["tokens"]): Usage;
/** Add one message's tokens to a running usage. */
export declare function addUsage(target: Usage, tokens: TranscriptMessage["tokens"]): void;
/** One model that took part in a session: how many requests it served and what they cost. */
export interface ModelUse {
    ref: ModelValue;
    /** Assistant messages attributed to this model (0 when it is known only from a model switch). */
    requests: number;
    /** Timestamp of the newest switch or request that involved it. */
    lastUsed: number;
    /** Tokens (input + output + reasoning + cache) of the requests this model served. */
    tokens: number;
    /** The same tokens split by kind, so a model the harness could not price can still be estimated. */
    usage: Usage;
    /** Cost of those requests. */
    cost: number;
    /** Wall-clock time spent answering them. */
    duration: number;
}
/** The model in effect on top, the ones used before it below, newest first. */
export interface ModelHistory {
    current?: ModelValue;
    previous: ModelUse[];
}
/** How many past models the panel lists before collapsing the rest into one line. */
export declare const MAX_PREVIOUS_MODELS = 3;
/** Model rendered as provider/model@variant, tolerant of string and object shapes. */
export declare function modelText(model?: ModelValue): string;
/** Stable identity of a model reference (variant included). */
export declare function modelKey(model?: ModelValue): string | undefined;
/** Total tokens of a usage record (input + output + reasoning + cache). */
export declare function usageTokens(tokens: TranscriptMessage["tokens"]): number;
/** Add one token breakdown into another (in place). */
export declare function mergeUsage(target: Usage, source: Usage): void;
/** Rebuild a session's model history from its transcript. */
export declare function readModelHistory(session: SessionLike, messages: TranscriptMessage[]): ModelHistory;
/** Remember a `session.model.selected` event so the replaced model shows up under the current one. */
export declare function recordModelSwitch(sessionID: string, model: ModelValue, previous: ModelValue | undefined, at: number): void;
/** Merge live switches into the transcript-derived history, keeping the session's current model on top. */
export declare function mergeLive(history: ModelHistory, sessionID: string): ModelHistory;
/** Full history for a session, memoised: the transcript window is large and changes rarely. */
export declare function cachedModelHistory(session: SessionLike, messages: TranscriptMessage[]): ModelHistory;
/** Drop the memoised state for a session (used when a test wants a clean read). */
export declare function forgetSession(sessionID: string): void;
//# sourceMappingURL=models.d.ts.map