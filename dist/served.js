/**
 * What LiteLLM actually served, per request.
 *
 * The harness records the *requested* model (the LiteLLM alias), so when the LiteLLM router answers from another
 * deployment — a provider fallback, a retry on a different deployment — the transcript shows the alias and the truth
 * stays in the response headers:
 *
 *   x-litellm-model-id           75921bbf…fee0   (the deployment that answered)
 *   x-litellm-model-name         deepseek/deepseek-flash
 *   x-litellm-model-group        deepseek-v4-flash-cloud-deepseek
 *   x-litellm-attempted-fallbacks 0
 *   x-litellm-attempted-retries   0
 *
 * The server entry of this plugin sees every response (`session.hook("http.response")`) and appends one compact line
 * per request here. The TUI reads the same file: server and TUI share a machine, and a file is the one channel that
 * needs no RPC handshake, works across process restarts and survives a hot reload of either side.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelKey } from "./models.js";
/** How many lines the file keeps; older ones are dropped on append. */
const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 300;
/** Directory holding the served-model log. `AGENT_TREE_PANEL_DIR` overrides it (used by the checks). */
export function servedDir() {
    const override = process.env.AGENT_TREE_PANEL_DIR;
    if (override)
        return override;
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".local", "share", "opencode");
    return path.join(base, "agent-tree-panel");
}
/** Absolute path of the served-model log. */
export function servedFile() {
    return path.join(servedDir(), "served.jsonl");
}
function toNumber(value) {
    const n = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function normalizeModel(model) {
    if (!model)
        return undefined;
    if (typeof model === "string") {
        const [providerID, id, variant] = model.split(/[/@]/);
        return providerID && id ? { providerID, id, variant } : undefined;
    }
    if (typeof model !== "object")
        return undefined;
    const ref = model;
    if (typeof ref.id !== "string" || !ref.id)
        return undefined;
    return {
        id: ref.id,
        providerID: typeof ref.providerID === "string" ? ref.providerID : "unknown",
        variant: typeof ref.variant === "string" ? ref.variant : undefined,
    };
}
/**
 * Turn a response hook payload into a record, or `undefined` when it is not a LiteLLM response we can describe.
 * Everything comes from the real headers; nothing is guessed from the requested model.
 */
export function servedFromResponse(source, at = Date.now()) {
    const headers = source.response?.headers;
    const model = normalizeModel(source.model);
    const sessionID = typeof source.sessionID === "string" ? source.sessionID : undefined;
    if (!headers || !model || !sessionID)
        return undefined;
    if (model.providerID !== "litellm")
        return undefined;
    const servedID = headers.get("x-litellm-model-id") ?? undefined;
    const servedName = headers.get("x-litellm-model-name") ?? undefined;
    const servedGroup = headers.get("x-litellm-model-group") ?? undefined;
    if (!servedID && !servedName && !servedGroup)
        return undefined;
    return {
        at,
        sessionID,
        agent: typeof source.agent === "string" ? source.agent : undefined,
        kind: typeof source.kind === "string" ? source.kind : undefined,
        model,
        servedID,
        servedName,
        servedGroup,
        apiBase: headers.get("x-litellm-model-api-base") ?? undefined,
        fallbacks: toNumber(headers.get("x-litellm-attempted-fallbacks")),
        retries: toNumber(headers.get("x-litellm-attempted-retries")),
    };
}
/** Keep the file bounded: when it grows past MAX_BYTES, rewrite it with the newest lines only. */
function prune(file) {
    let lines;
    try {
        lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    }
    catch {
        return;
    }
    if (lines.length <= KEEP_LINES)
        return;
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
        fs.renameSync(tmp, file);
    }
    catch {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // nothing else to do: a malformed tail only costs a few unread lines
        }
    }
}
/**
 * Append one observation. Never throws: this runs inside a request hook, and a panel that cannot write its log must not
 * break the session.
 */
export function appendServed(record) {
    if (isRepeat(record))
        return;
    const file = servedFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > MAX_BYTES)
                prune(file);
        }
        catch {
            // file does not exist yet
        }
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
        lastWritten = record;
    }
    catch {
        // ignore: the panel simply shows the statically resolved alias
    }
}
/** The newest record written by this process, so a twice-registered hook cannot log the same response twice. */
let lastWritten;
/** Same session, model and deployment within a second: the same response observed twice. */
function isRepeat(record) {
    if (!lastWritten)
        return false;
    return (lastWritten.sessionID === record.sessionID &&
        lastWritten.model?.id === record.model?.id &&
        lastWritten.servedID === record.servedID &&
        Math.abs(record.at - lastWritten.at) < 1000);
}
let readCache;
/** Parse the log, memoised on the file's size/mtime. Malformed lines are skipped, never fatal. */
export function readServed() {
    const file = servedFile();
    let stamp;
    try {
        const stat = fs.statSync(file);
        stamp = `${stat.size}:${stat.mtimeMs}`;
    }
    catch {
        readCache = undefined;
        return [];
    }
    if (readCache && readCache.stamp === stamp)
        return readCache.records;
    let records = [];
    try {
        const seen = new Set();
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            if (!line.trim())
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!parsed || typeof parsed !== "object" || typeof parsed.sessionID !== "string")
                continue;
            // The hook can be registered twice across a reload; identical observations are not worth two rows.
            const key = `${parsed.sessionID}|${parsed.at}|${parsed.model?.id ?? ""}|${parsed.servedID ?? ""}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            records.push(parsed);
        }
    }
    catch {
        records = [];
    }
    readCache = { stamp, records };
    return records;
}
/** Drop the memoised log (used by the checks). */
export function forgetServed() {
    readCache = undefined;
}
/**
 * Summarise the observations for one model of one session.
 *
 * `requestedAlias` is what OpenCode asked for (the LiteLLM alias). When the deployment that answered belongs to a
 * different alias, or LiteLLM reports an attempted fallback, the summary is marked as a fallback — that case is exactly
 * what this file exists for.
 */
export function servedSummary(records, sessionID, model, requestedAlias, deployments) {
    if (!model)
        return undefined;
    const key = typeof model === "string" ? model : modelKey(model);
    let summary;
    for (const record of records) {
        if (record.sessionID !== sessionID)
            continue;
        if (modelKey(record.model) !== key)
            continue;
        const deployment = record.servedID ? deployments?.get(record.servedID.toLowerCase()) : undefined;
        const servedAlias = record.servedGroup ?? deployment?.alias;
        if (!summary) {
            summary = { count: 0, fallbacks: 0, retries: 0, at: 0, fallback: false };
        }
        summary.count += 1;
        summary.fallbacks += record.fallbacks ?? 0;
        summary.retries += record.retries ?? 0;
        if (record.at > summary.at) {
            summary.at = record.at;
            summary.name = record.servedName ?? deployment?.upstream;
            summary.servedID = record.servedID;
            summary.servedAlias = servedAlias;
        }
    }
    if (!summary)
        return undefined;
    summary.fallback =
        summary.fallbacks > 0 || Boolean(summary.servedAlias && requestedAlias && summary.servedAlias !== requestedAlias);
    return summary;
}
//# sourceMappingURL=served.js.map