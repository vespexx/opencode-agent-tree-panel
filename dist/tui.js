import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "@opentui/solid/jsx-runtime";
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { getLiteLLMData, lookupAlias, lookupPricing, extractAlias, } from "./litellm";
import { MAX_PREVIOUS_MODELS, cachedModelHistory, emptyUsage, mergeUsage, modelKey, modelText, recordModelSwitch, usageOf, } from "./models";
import { fmtDuration, fmtSpend, fmtTokens, rateLine, runDuration, spendOf, sumSpend } from "./format";
import { liveStatus, statusGlyph } from "./liveness";
import { readServed, servedSummary } from "./served";
/** Events that should trigger a panel refresh (from @opencode/protocol session events). */
const SESSION_EVENTS = [
    "session.created",
    "session.deleted",
    "session.forked",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.step.started",
    "session.step.ended",
    "session.step.failed",
    "session.model.selected",
    "session.usage.recorded",
    "session.message.content.updated",
    "session.tool.called",
    "session.tool.success",
    "session.tool.failed",
    "session.idle",
];
/** Text attribute bitmask constants (from @opentui/core). */
const ATTR_BOLD = 1;
const ATTR_DIM = 2;
const ATTR_ITALIC = 3;
const ATTR_UNDERLINE = 4;
/**
 * Status dot: the glyph is filled while the session is running, an x marks a failed last run.
 */
function StatusDot(props) {
    const ctx = usePlugin();
    const glyph = statusGlyph(props.running, props.outcome);
    const color = props.running
        ? ctx.theme.text.feedback.success.base
        : glyph === "✗"
            ? ctx.theme.text.feedback.error.base
            : ctx.theme.text.feedback.info.base;
    return (_jsx("text", { fg: color, selectable: false, flexShrink: 0, children: glyph }));
}
/** Recursive tree builder from flat family list. */
function buildTree(sessionIDs, getSession) {
    const nodes = new Map();
    // Create all nodes first
    for (const id of sessionIDs) {
        const s = getSession(id);
        if (!s)
            continue;
        nodes.set(id, { session: s, children: [], depth: 0 });
    }
    // Link children to parents
    const roots = [];
    for (const [id, node] of nodes) {
        const parentID = node.session.parentID;
        if (parentID && nodes.has(parentID)) {
            nodes.get(parentID).children.push(node);
        }
        else {
            roots.push(node);
        }
    }
    // Set depths
    function setDepth(node, depth) {
        node.depth = depth;
        for (const child of node.children)
            setDepth(child, depth + 1);
    }
    for (const root of roots)
        setDepth(root, 0);
    // Sort children by creation time (older first)
    for (const node of nodes.values()) {
        node.children.sort((a, b) => a.session.time.created - b.session.time.created);
    }
    return roots;
}
/** Total tokens for a session (input + output + reasoning + cache). */
function totalTokens(tokens) {
    return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}
/** Running entries first, then the most recently touched ones. */
function sortByActivity(nodes, statuses) {
    return [...nodes].sort((a, b) => {
        const aRunning = statuses.get(a.session.id) === "running" ? 1 : 0;
        const bRunning = statuses.get(b.session.id) === "running" ? 1 : 0;
        if (aRunning !== bRunning)
            return bRunning - aRunning;
        return b.session.time.updated - a.session.time.updated;
    });
}
/** Split children into the ones still running and per-agent totals of the finished ones. */
function splitChildren(nodes, statuses) {
    const sorted = sortByActivity(nodes, statuses);
    const running = sorted.filter((n) => statuses.get(n.session.id) === "running");
    const finished = sorted.filter((n) => statuses.get(n.session.id) !== "running");
    const buckets = new Map();
    for (const node of finished) {
        const session = node.session;
        const key = session.agent ?? "default";
        const bucket = buckets.get(key) ?? {
            group: { agent: key, count: 0, tokens: 0, cost: 0, duration: 0, models: [], updated: 0 },
            models: new Map(),
        };
        bucket.group.count += 1;
        bucket.group.tokens += totalTokens(session.tokens);
        bucket.group.cost += session.cost;
        bucket.group.duration += runDuration(session.time, false);
        bucket.group.updated = Math.max(bucket.group.updated, session.time.updated);
        // Runs of the same agent may sit on different models (a fallback between runs): keep them all, newest first.
        const modelID = modelKey(session.model);
        if (session.model && modelID) {
            const use = bucket.models.get(modelID) ?? {
                ref: session.model,
                requests: 0,
                lastUsed: 0,
                tokens: 0,
                usage: emptyUsage(),
                cost: 0,
                duration: 0,
            };
            use.requests += 1;
            use.tokens += totalTokens(session.tokens);
            mergeUsage(use.usage, usageOf(session.tokens));
            use.cost += session.cost;
            use.duration += runDuration(session.time, false);
            use.lastUsed = Math.max(use.lastUsed, session.time.updated);
            bucket.models.set(modelID, use);
        }
        buckets.set(key, bucket);
    }
    const groups = [...buckets.values()]
        .map(({ group, models }) => ({
        ...group,
        models: [...models.values()].sort((a, b) => b.lastUsed - a.lastUsed),
    }))
        .sort((a, b) => b.updated - a.updated);
    return { running, groups, finishedTotal: finished.length };
}
/**
 * Past models of a session: what each one spent, then the model itself, dimmed under the current one.
 *
 * When LiteLLM reported that the request was answered by another deployment, the served model is named under the
 * alias — that is the one case where the alias and the answer disagree.
 */
function PastModels(props) {
    const ctx = usePlugin();
    const shown = () => props.models.slice(0, MAX_PREVIOUS_MODELS);
    const hidden = () => Math.max(0, props.models.length - shown().length);
    const summaryOf = (use) => props.sessionID
        ? servedSummary(props.served ?? [], props.sessionID, use.ref, extractAlias(use.ref), props.llm.deployments)
        : undefined;
    const spendOfUse = (use) => spendOf(use.cost, use.usage, lookupPricing(props.llm, extractAlias(use.ref), summaryOf(use)?.servedID));
    return (_jsxs(_Fragment, { children: [_jsx(For, { each: shown(), children: (use) => {
                    const summary = () => summaryOf(use);
                    const spend = () => spendOfUse(use);
                    return (_jsxs(_Fragment, { children: [_jsx(Show, { when: use.tokens > 0 || use.cost > 0 || use.duration > 0, children: _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["\u2193 ", fmtTokens(use.tokens), " tok \u00B7 ", fmtSpend(spend()), " \u00B7 ", fmtDuration(use.duration)] }) }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["\u21B3 ", modelText(use.ref), use.requests > 0 ? ` ×${use.requests}` : ""] }), _jsx(Show, { when: summary()?.fallback, children: _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["  → ", summary()?.name ?? summary()?.servedAlias ?? "another deployment", " ⚠"] }) })] }));
                } }), _jsx(Show, { when: hidden() > 0, children: _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["\u21B3 +", hidden(), " earlier"] }) })] }));
}
/** Completed runs of one agent, rolled into a three-line block with totals. */
function AgentGroupRow(props) {
    const ctx = usePlugin();
    const group = props.group;
    // Resolve upstream model for LiteLLM aliases
    const current = group.models[0];
    const alias = current ? extractAlias(current.ref) : undefined;
    const upstream = alias ? lookupAlias(props.llm.aliases, alias) : undefined;
    // A group spans several sessions, so each of its models is priced on its own and the parts are added up.
    const groupSpend = () => group.models.length === 0
        ? { cost: group.cost, estimated: false }
        : sumSpend(group.models.map((use) => spendOf(use.cost, use.usage, lookupPricing(props.llm, extractAlias(use.ref)))));
    return (_jsxs("box", { flexDirection: "column", gap: 0, marginLeft: 2, children: [_jsxs("box", { flexDirection: "row", gap: 1, height: 1, children: [_jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: "\u25CB" }), _jsxs("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, wrapMode: "none", truncate: true, flexShrink: 1, children: [group.agent, " \u00D7", group.count] }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: fmtDuration(group.duration) })] }), _jsxs("box", { flexDirection: "column", paddingLeft: 2, children: [_jsx("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: modelText(current?.ref) }), (() => {
                        const u = upstream;
                        return u ? (_jsxs("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["\u2192 ", u.upstream] })) : null;
                    })(), _jsx(PastModels, { models: group.models.slice(1), llm: props.llm }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["group total \u00B7 ", fmtTokens(group.tokens), " tok \u00B7 ", fmtSpend(groupSpend())] })] })] }));
}
/** Agent tree section. */
function AgentsSection(props) {
    const ctx = usePlugin();
    // What LiteLLM actually served, read from the server hook's log (memoised on the file's size/mtime).
    const served = createMemo(() => {
        props.tick;
        return readServed();
    });
    // Build the tree from family + cache
    const family = createMemo(() => {
        props.tick; // react to tick for live updates
        const ids = ctx.data.session.family(props.sessionID);
        const get = (id) => ctx.data.session.get(id);
        return buildTree(ids, get);
    });
    // Status per session (for live "running" indicator).
    // The event flag alone is not trustworthy (see liveness.ts) and refresh() keeps the whole family's records current,
    // so the two are reconciled here.
    const statuses = createMemo(() => {
        props.tick;
        const map = new Map();
        // The tree holds the family nested, so it is walked down: every session needs a status, not only the roots.
        const visit = (nodes) => {
            for (const node of nodes) {
                const session = node.session;
                map.set(session.id, liveStatus({
                    reported: ctx.data.session.status(session.id),
                    idle: session.time?.idle,
                    updated: session.time?.updated ?? 0,
                    tokens: totalTokens(session.tokens),
                }));
                if (node.children.length > 0)
                    visit(node.children);
            }
        };
        visit(family());
        // A session announced but not in the tree yet (its record is not cached) keeps the event flag as it stands.
        for (const id of ctx.data.session.family(props.sessionID)) {
            if (map.has(id))
                continue;
            map.set(id, ctx.data.session.status(id));
        }
        return map;
    });
    const roots = createMemo(() => sortByActivity(family(), statuses()));
    return (_jsxs("box", { flexDirection: "column", gap: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: "Agents" }), _jsx("box", { flexGrow: 1 }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: [family().length, " total"] })] }), _jsx(For, { each: roots(), children: (root) => _jsx(AgentTreeNode, { node: root, statuses: statuses(), llm: props.llm, served: served() }) }), _jsx(Show, { when: family().length === 0, children: _jsx("text", { fg: ctx.theme.text.faint, selectable: false, marginTop: 1, children: "No sessions in this family" }) })] }));
}
/** Recursive tree node renderer. */
function AgentTreeNode(props) {
    const { node, statuses, llm, served } = props;
    const ctx = usePlugin();
    const session = node.session;
    const status = statuses.get(session.id) ?? "idle";
    const running = status === "running";
    const tokens = totalTokens(session.tokens);
    const duration = runDuration(session.time, running);
    const hasChildren = node.children.length > 0;
    const children = splitChildren(node.children, statuses);
    const agentName = session.agent ?? "default";
    const kind = session.parentID ? "sub" : "primary";
    // Nesting already indents by 2 per level, so only non-root nodes add their own step.
    const indent = node.depth > 0 ? 2 : 0;
    // Resolve upstream model for LiteLLM aliases
    const alias = extractAlias(session.model);
    const upstream = alias ? lookupAlias(llm.aliases, alias) : undefined;
    // The session record only holds the model in effect now; earlier ones come from the transcript.
    const history = cachedModelHistory(session, (ctx.data.session.message.list(session.id) ?? []));
    // What LiteLLM actually served for the model in effect (from the response headers, via the server hook).
    const summary = servedSummary(served, session.id, history.current ?? session.model, alias, llm.deployments);
    const servedID = summary?.servedID?.slice(0, 8);
    // Prices of the deployment that answered (or of the alias), used when the harness itself reported no cost.
    const pricing = lookupPricing(llm, alias, summary?.servedID);
    const spend = spendOf(session.cost, usageOf(session.tokens), pricing);
    // Rates behind an estimate. Built up front: nothing here may touch `pricing` when the LiteLLM map is still loading.
    const rates = rateLine(spend, pricing, kind === "primary");
    return (_jsxs("box", { flexDirection: "column", gap: 0, marginLeft: indent, children: [_jsxs("box", { flexDirection: "row", gap: 1, height: 1, children: [_jsx(StatusDot, { running: running, outcome: session.outcome }), _jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: node.depth === 0 ? ATTR_BOLD : 0, wrapMode: "none", truncate: true, flexShrink: 1, children: agentName }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: ["\u00B7 ", kind] }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: fmtDuration(duration) })] }), _jsxs("box", { flexDirection: "column", paddingLeft: 2, children: [_jsx("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: modelText(history.current ?? session.model) }), (() => {
                        const u = upstream;
                        // The deployment id proves which target answered; without a served record there is nothing to add.
                        const suffix = servedID && !summary?.fallback ? ` · ${servedID}` : "";
                        // A fallback without a known alias target is described by the warning line alone.
                        if (!u && (!summary || summary.fallback))
                            return null;
                        return (_jsxs("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["\u2192 ", u?.upstream ?? summary?.name ?? (summary?.servedAlias || "deployment"), suffix] }));
                    })(), _jsx(Show, { when: summary?.fallback, children: _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["\u26A0 litellm served ", summary?.name ?? summary?.servedAlias ?? "another deployment", servedID ? ` · ${servedID}` : "", summary?.fallbacks ? ` · fallback ×${summary.fallbacks}` : ""] }) }), _jsx(PastModels, { models: history.previous, llm: llm, sessionID: session.id, served: served }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: ["session total \u00B7 ", fmtTokens(tokens), " tok \u00B7 ", fmtSpend(spend)] }), _jsx(Show, { when: rates, children: _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, wrapMode: "char", children: rates }) })] }), _jsxs(Show, { when: hasChildren, children: [_jsx(For, { each: children.running, children: (child) => _jsx(AgentTreeNode, { node: child, statuses: statuses, llm: llm, served: served }) }), _jsx(For, { each: children.groups, children: (group) => _jsx(AgentGroupRow, { group: group, llm: llm }) })] })] }));
}
/** A tool is "running" while it streams input or executes. */
function isToolRunning(tool) {
    return tool.state.status === "running" || tool.state.status === "streaming";
}
/** Wall-clock time a tool call took: queued plus executed. */
function toolDuration(tool) {
    const { time } = tool;
    if (time.completed && time.created)
        return time.completed - time.created;
    if (time.ran && time.created)
        return time.ran - time.created;
    if (time.created)
        return Date.now() - time.created;
    return 0;
}
/** Tools section showing current step's tool calls. */
function ToolsSection(props) {
    const ctx = usePlugin();
    // Get latest assistant message with tool parts
    const latestTools = createMemo(() => {
        props.tick;
        const messages = (ctx.data.session.message.list(props.sessionID) ?? []);
        // Find the most recent assistant message that has tool parts
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.type !== "assistant")
                continue;
            const tools = msg.content.filter((p) => p.type === "tool");
            if (tools.length > 0)
                return tools;
        }
        return [];
    });
    // Running calls in full detail, finished ones rolled up per tool name.
    const ordered = createMemo(() => {
        const sorted = [...latestTools()].sort((a, b) => {
            const aRunning = isToolRunning(a) ? 1 : 0;
            const bRunning = isToolRunning(b) ? 1 : 0;
            if (aRunning !== bRunning)
                return bRunning - aRunning;
            return b.time.created - a.time.created;
        });
        const buckets = new Map();
        for (const tool of sorted) {
            if (isToolRunning(tool))
                continue;
            const bucket = buckets.get(tool.name) ?? { name: tool.name, count: 0, duration: 0, updated: 0 };
            bucket.count += 1;
            bucket.duration += toolDuration(tool);
            bucket.updated = Math.max(bucket.updated, tool.time.completed ?? tool.time.ran ?? tool.time.created);
            buckets.set(tool.name, bucket);
        }
        return {
            running: sorted.filter(isToolRunning),
            groups: [...buckets.values()].sort((a, b) => b.updated - a.updated),
            total: sorted.length,
        };
    });
    const tools = ordered();
    if (tools.total === 0) {
        return (_jsxs("box", { flexDirection: "column", gap: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: "Tools" }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, children: "(current step)" })] }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, marginTop: 1, children: "No tool calls in the current step" })] }));
    }
    return (_jsxs("box", { flexDirection: "column", gap: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: "Tools" }), _jsx("box", { flexGrow: 1 }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: [tools.total, " in current step"] })] }), _jsx(For, { each: tools.running, children: (tool) => _jsx(ToolRow, { tool: tool }) }), _jsx(For, { each: tools.groups, children: (group) => _jsx(ToolGroupRow, { group: group }) })] }));
}
/** Completed calls of one tool, rolled into a single line with the total time. */
function ToolGroupRow(props) {
    const ctx = usePlugin();
    return (_jsxs("box", { flexDirection: "row", gap: 1, height: 1, marginLeft: 1, paddingLeft: 1, children: [_jsx("text", { fg: ctx.theme.text.feedback.success.base, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: "\u2713" }), _jsxs("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, wrapMode: "none", truncate: true, flexShrink: 1, children: [props.group.name, " \u00D7", props.group.count] }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, flexShrink: 0, children: fmtDuration(props.group.duration) })] }));
}
/** Single tool call row (only ever rendered for calls that are still running). */
function ToolRow(props) {
    const { tool } = props;
    const ctx = usePlugin();
    const { name, state } = tool;
    const status = state.status;
    const running = status === "running" || status === "streaming";
    const completed = status === "completed";
    const error = status === "error";
    const duration = toolDuration(tool);
    const statusColor = error
        ? ctx.theme.text.feedback.error.base
        : running
            ? ctx.theme.text.feedback.warning.base
            : completed
                ? ctx.theme.text.feedback.success.base
                : ctx.theme.text.faint;
    const statusLabel = error ? "error" : running ? "running" : completed ? "done" : "pending";
    // Use a colored left border via a thin box
    const leftBorder = _jsx("box", { width: 1, backgroundColor: statusColor + "80", height: 1 });
    return (_jsxs("box", { flexDirection: "column", gap: 0, marginLeft: 1, paddingLeft: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, height: 1, children: [leftBorder, _jsx("text", { fg: statusColor, selectable: false, attributes: ATTR_DIM, width: 1, children: running ? "▶" : completed ? "✓" : error ? "✗" : "○" }), _jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: name }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: statusColor, selectable: false, attributes: ATTR_DIM, children: statusLabel }), _jsx("box", { width: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, width: 6, children: fmtDuration(duration) })] }), _jsx(Show, { when: state.input && Object.keys(state.input).length > 0, children: _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, marginLeft: 2, wrapMode: "char", children: [JSON.stringify(state.input).slice(0, 120), JSON.stringify(state.input).length > 120 ? "…" : ""] }) }), _jsx(Show, { when: error && state.content && state.content.length > 0, children: _jsx("text", { fg: ctx.theme.text.feedback.error.base, selectable: false, attributes: ATTR_DIM, marginLeft: 2, wrapMode: "none", children: state.content?.[0]?.text?.slice(0, 120) ?? "error" }) })] }));
}
/** Main panel component. */
function Panel(props) {
    const ctx = usePlugin();
    const [tick, setTick] = createSignal(0);
    const [failed, setFailed] = createSignal(false);
    const [llm, setLlm] = createSignal({
        aliases: new Map(),
        deployments: new Map(),
        pricing: new Map(),
        aliasPricing: new Map(),
    });
    const [aliasLoading, setAliasLoading] = createSignal(false);
    // Load alias + deployment maps on first mount
    createEffect(on(() => props.sessionID, async () => {
        setAliasLoading(true);
        try {
            // Sync providers to ensure cache is fresh
            await ctx.data.location.provider.sync();
            const providers = (ctx.data.location.provider.list() ?? []);
            setLlm(await getLiteLLMData("litellm", providers));
        }
        catch {
            // silently ignore — upstream display is optional
        }
        finally {
            setAliasLoading(false);
        }
    }));
    let refreshTimer;
    const REFRESH_DEBOUNCE_MS = 400;
    const TICK_THROTTLE_MS = 250;
    let tickTimer;
    let requestSeq = 0;
    // The family list is otherwise only what the events happened to announce, and a child's record (tokens,
    // time.updated, time.idle) is never re-fetched after it was announced: the root is fetched with its children.
    // The plugin's context typing declares the one-argument form only, while the store the TUI passes in also accepts
    // `{ children: true }` (the session plus its direct children), so the view is widened instead of the method rebound.
    const sessions = ctx.data.session;
    const refresh = async () => {
        const seq = ++requestSeq;
        try {
            const rootID = ctx.data.session.root(props.sessionID);
            await sessions.sync(rootID, { children: true });
            if (seq !== requestSeq)
                return;
            if (rootID !== props.sessionID)
                await sessions.sync(props.sessionID);
            if (seq !== requestSeq)
                return;
            setTick((v) => v + 1);
            setFailed(false);
        }
        catch {
            if (seq !== requestSeq)
                return;
            setFailed(true);
        }
    };
    /** Re-read when session changes. */
    createEffect(on(() => props.sessionID, () => {
        if (refreshTimer)
            clearTimeout(refreshTimer);
        refreshTimer = undefined;
        setFailed(false);
        void refresh();
    }));
    const scheduleRefresh = () => {
        if (refreshTimer)
            clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh();
        }, REFRESH_DEBOUNCE_MS);
    };
    const scheduleTick = () => {
        if (tickTimer)
            return;
        tickTimer = setTimeout(() => {
            tickTimer = undefined;
            setTick((v) => v + 1);
        }, TICK_THROTTLE_MS);
    };
    /**
     * Does the event belong to the panel's session family? Sub-agents report under their own sessionID, so a filter
     * on the root alone would freeze every sub-agent row (model switches, steps, idle) until the root happens to move.
     */
    const inFamily = (data) => {
        const id = data?.sessionID;
        if (!id)
            return false;
        if (id === props.sessionID)
            return true;
        const family = ctx.data.session.family(props.sessionID);
        if (family.includes(id))
            return true;
        // A brand-new sub-agent is not in the family yet when its first event arrives.
        const parentID = data?.parentID;
        return !!parentID && (parentID === props.sessionID || family.includes(parentID));
    };
    const onSession = (type, handler) => ctx.data.on(type, (event) => {
        if (inFamily(event?.data))
            handler();
    });
    const subscriptions = SESSION_EVENTS.map((type) => {
        const handler = type.includes("execution") || type.includes("step") || type === "session.idle" || type === "session.model.selected" || type === "session.created" || type === "session.deleted" || type === "session.forked"
            ? scheduleRefresh
            : scheduleTick;
        return onSession(type, handler);
    });
    // Keep the model history in memory: a switch may be the only trace of a fallback in a short transcript window.
    const offModelSwitch = ctx.data.on("session.model.selected", (event) => {
        const data = event?.data;
        if (!inFamily(data) || !data?.sessionID || !data.model)
            return;
        recordModelSwitch(data.sessionID, data.model, data.previous, event.created ?? Date.now());
    });
    subscriptions.push(offModelSwitch);
    onCleanup(() => {
        for (const off of subscriptions)
            off();
        if (refreshTimer)
            clearTimeout(refreshTimer);
        if (tickTimer)
            clearTimeout(tickTimer);
    });
    return (_jsxs("box", { flexDirection: "column", gap: 1, padding: 1, children: [_jsx(Show, { when: failed(), children: _jsx("text", { fg: ctx.theme.text.feedback.error.base, selectable: false, children: "Failed to load session data" }) }), _jsx(AgentsSection, { sessionID: props.sessionID, tick: tick(), llm: llm() }), _jsx(ToolsSection, { sessionID: props.sessionID, tick: tick() })] }));
}
/** Plugin definition. */
export default Plugin.define({
    id: "agent-tree-panel",
    setup(ctx) {
        ctx.ui.slot({
            prepend: "sidebar.content",
            render: (input) => _jsx(Panel, { sessionID: input.sessionID }),
        });
    },
});
//# sourceMappingURL=tui.js.map