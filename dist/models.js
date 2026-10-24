/**
 * Model bookkeeping for the agent tree panel.
 *
 * A session record only keeps the model selected *right now*. Everything that matters for a fallback — which model
 * served the previous request, which one was left behind by a mid-request switch — lives in the transcript:
 * the harness appends a `model-switched` entry (with `previous`) for every change, and every assistant message
 * records the model that served it. This module turns that into a "current on top, past below" list.
 */
/** How many past models the panel lists before collapsing the rest into one line. */
export const MAX_PREVIOUS_MODELS = 3;
/** Model rendered as provider/model@variant, tolerant of string and object shapes. */
export function modelText(model) {
    if (!model)
        return "unknown model";
    if (typeof model === "string")
        return model;
    const variant = model.variant && model.variant !== "default" ? `@${model.variant}` : "";
    return `${model.providerID}/${model.id}${variant}`;
}
/** Stable identity of a model reference (variant included). */
export function modelKey(model) {
    if (!model)
        return undefined;
    if (typeof model === "string")
        return model;
    const variant = model.variant && model.variant !== "default" ? `@${model.variant}` : "";
    return `${model.providerID}/${model.id}${variant}`;
}
/** Rebuild a session's model history from its transcript. */
export function readModelHistory(session, messages) {
    const uses = new Map();
    const note = (model, at, request) => {
        const key = modelKey(model);
        if (!key || !model)
            return;
        let use = uses.get(key);
        if (!use) {
            use = { ref: model, requests: 0, lastUsed: 0 };
            uses.set(key, use);
        }
        if (request)
            use.requests += 1;
        if (Number.isFinite(at) && at > use.lastUsed)
            use.lastUsed = at;
    };
    for (const message of messages) {
        if (message.type === "model-switched") {
            const at = message.time?.created ?? 0;
            // The model that was left belongs in the history too, even when nothing else recorded it.
            note(message.previous, Math.max(0, at - 1), false);
            note(message.model, at, false);
        }
        else if (message.type === "assistant") {
            note(message.model, message.time?.completed ?? message.time?.created ?? 0, true);
        }
    }
    // The session record is authoritative for the current model, even when the transcript window is older.
    const currentKey = modelKey(session.model);
    const previous = [...uses.entries()]
        .filter(([key]) => key !== currentKey)
        .map(([, use]) => use)
        .sort((a, b) => b.lastUsed - a.lastUsed);
    return { current: session.model, previous };
}
/**
 * Model switches seen live, per session. The client keeps a short transcript window (20 messages by default) and
 * does not load sub-agent transcripts at all, so switches are also remembered as they arrive.
 */
const liveModelSwitches = new Map();
function noteLiveModel(entries, model, at) {
    const key = modelKey(model);
    if (!key)
        return;
    const existing = entries.find((entry) => modelKey(entry.ref) === key);
    if (existing) {
        existing.lastUsed = Math.max(existing.lastUsed, at);
        return;
    }
    entries.push({ ref: model, requests: 0, lastUsed: at });
}
/** Remember a `session.model.selected` event so the replaced model shows up under the current one. */
export function recordModelSwitch(sessionID, model, previous, at) {
    const entries = liveModelSwitches.get(sessionID) ?? [];
    if (previous)
        noteLiveModel(entries, previous, Math.max(0, at - 1));
    noteLiveModel(entries, model, at);
    liveModelSwitches.set(sessionID, entries.slice(-12));
}
/** Merge live switches into the transcript-derived history, keeping the session's current model on top. */
export function mergeLive(history, sessionID) {
    const live = liveModelSwitches.get(sessionID);
    if (!live || live.length === 0)
        return history;
    // A switch is usually in both places (live event and transcript entry): dedupe on the model identity.
    const seen = new Set([modelKey(history.current)]);
    const previous = [...history.previous];
    for (const use of previous)
        seen.add(modelKey(use.ref));
    for (const use of live) {
        const key = modelKey(use.ref);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        previous.push(use);
    }
    previous.sort((a, b) => b.lastUsed - a.lastUsed);
    return { current: history.current, previous };
}
const historyCache = new Map();
/** Full history for a session, memoised: the transcript window is large and changes rarely. */
export function cachedModelHistory(session, messages) {
    const last = messages[messages.length - 1];
    const version = [
        messages.length,
        last?.id ?? "",
        modelKey(session.model) ?? "",
        session.time.updated,
        liveModelSwitches.get(session.id)?.length ?? 0,
    ].join(":");
    const cached = historyCache.get(session.id);
    if (cached && cached.version === version)
        return cached.history;
    const history = mergeLive(readModelHistory(session, messages), session.id);
    historyCache.set(session.id, { version, history });
    return history;
}
/** Drop the memoised state for a session (used when a test wants a clean read). */
export function forgetSession(sessionID) {
    historyCache.delete(sessionID);
    liveModelSwitches.delete(sessionID);
}
//# sourceMappingURL=models.js.map