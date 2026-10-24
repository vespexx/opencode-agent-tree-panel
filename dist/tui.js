import { jsx as _jsx, jsxs as _jsxs } from "@opentui/solid/jsx-runtime";
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
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
/** Display format helpers. */
function fmtTokens(value) {
    if (!Number.isFinite(value) || value <= 0)
        return "0";
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (value >= 1_000)
        return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(Math.round(value));
}
function fmtCost(value) {
    if (!Number.isFinite(value) || value === 0)
        return "$0.00";
    if (value < 0.01)
        return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}
function fmtDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
}
/** Status badge component. */
function StatusBadge(props) {
    const ctx = usePlugin();
    const running = props.status === "running";
    const dotColor = running ? ctx.theme.text.feedback.success.base : ctx.theme.text.feedback.info.base;
    const label = running ? "running" : "idle";
    if (props.variant === "compact") {
        return (_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("box", { width: 1, height: 1, backgroundColor: dotColor }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, children: label })] }));
    }
    return (_jsxs("box", { flexDirection: "row", gap: 1, paddingX: 1, paddingY: 0, backgroundColor: dotColor + "20", children: [_jsx("box", { width: 1, height: 1, backgroundColor: dotColor }), _jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_DIM, children: label })] }));
}
/** Model display: provider/model. */
function ModelLabel(props) {
    const ctx = usePlugin();
    if (!props.model)
        return _jsx("text", { fg: ctx.theme.text.faint, selectable: false, children: "\u2014" });
    // Handle both object and string formats
    if (typeof props.model === "string") {
        return _jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_DIM, children: props.model });
    }
    const { providerID, id, variant } = props.model;
    return (_jsxs("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_DIM, children: [providerID, "/", id, variant ? `@${variant}` : ""] }));
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
/** Elapsed time since session creation (or last update if running). */
function elapsed(session, status) {
    const end = status === "running" ? session.time.updated : (session.time.idle ?? session.time.updated);
    return Math.max(0, end - session.time.created);
}
/** Agent tree section. */
function AgentsSection(props) {
    const ctx = usePlugin();
    // Build the tree from family + cache
    const family = createMemo(() => {
        props.tick; // react to tick for live updates
        const ids = ctx.data.session.family(props.sessionID);
        const get = (id) => ctx.data.session.get(id);
        return buildTree(ids, get);
    });
    // Status per session (for live "running" indicator)
    const statuses = createMemo(() => {
        props.tick;
        const ids = ctx.data.session.family(props.sessionID);
        const map = new Map();
        for (const id of ids) {
            map.set(id, ctx.data.session.status(id));
        }
        return map;
    });
    return (_jsxs("box", { flexDirection: "column", gap: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: "Agents" }), _jsx("box", { flexGrow: 1 }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, children: [family().length, " session", family().length !== 1 ? "s" : ""] })] }), _jsx(For, { each: family(), children: (root) => _jsx(AgentTreeNode, { node: root, statuses: statuses() }) }), _jsx(Show, { when: family().length === 0, children: _jsx("text", { fg: ctx.theme.text.faint, selectable: false, marginTop: 1, children: "No sessions in this family" }) })] }));
}
/** Recursive tree node renderer. */
function AgentTreeNode(props) {
    const { node, statuses } = props;
    const ctx = usePlugin();
    const session = node.session;
    const status = statuses.get(session.id) ?? "idle";
    const tokens = totalTokens(session.tokens);
    const duration = elapsed(session, status);
    const hasChildren = node.children.length > 0;
    const prefix = "  ".repeat(node.depth) + (node.depth > 0 ? "└─ " : "");
    const agentName = session.agent ?? "default";
    return (_jsxs("box", { flexDirection: "column", gap: 0, children: [_jsxs("box", { flexDirection: "row", gap: 1, height: 1, children: [_jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, children: prefix }), _jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: node.depth === 0 ? ATTR_BOLD : 0, children: agentName }), _jsx("box", { flexGrow: 1 }), _jsx(ModelLabel, { model: session.model }), _jsx("box", { width: 1 }), _jsx("text", { fg: ctx.theme.text.muted, selectable: false, attributes: ATTR_DIM, width: 8, children: fmtTokens(tokens) }), _jsx("box", { width: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, width: 7, children: fmtCost(session.cost) }), _jsx("box", { width: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, width: 6, children: fmtDuration(duration) }), _jsx("box", { width: 1 }), _jsx(StatusBadge, { status: status, variant: "compact" })] }), _jsx(Show, { when: hasChildren, children: _jsx(For, { each: node.children, children: (child) => _jsx(AgentTreeNode, { node: child, statuses: statuses }) }) })] }));
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
    const tools = latestTools();
    if (tools.length === 0) {
        return (_jsxs("box", { flexDirection: "column", gap: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: "Tools" }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, children: "(current step)" })] }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, marginTop: 1, children: "No tool calls in the current step" })] }));
    }
    return (_jsxs("box", { flexDirection: "column", gap: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, children: [_jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: "Tools" }), _jsx("box", { flexGrow: 1 }), _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, children: [tools.length, " call", tools.length !== 1 ? "s" : "", " in current step"] })] }), _jsx(For, { each: tools, children: (tool) => _jsx(ToolRow, { tool: tool }) })] }));
}
/** Single tool call row. */
function ToolRow(props) {
    const { tool } = props;
    const ctx = usePlugin();
    const { name, state, time } = tool;
    const status = state.status;
    const running = status === "running" || status === "streaming";
    const completed = status === "completed";
    const error = status === "error";
    // Duration
    let duration = 0;
    if (time.ran && time.created)
        duration = time.ran - time.created;
    if (time.completed && time.ran)
        duration = time.completed - time.ran;
    if (!time.ran && time.created)
        duration = Date.now() - time.created;
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
    return (_jsxs("box", { flexDirection: "column", gap: 0, marginLeft: 1, paddingLeft: 1, children: [_jsxs("box", { flexDirection: "row", gap: 1, height: 1, children: [leftBorder, _jsx("text", { fg: statusColor, selectable: false, attributes: ATTR_DIM, width: 1, children: running ? "▶" : completed ? "✓" : error ? "✗" : "○" }), _jsx("text", { fg: ctx.theme.text.base, selectable: false, attributes: ATTR_BOLD, children: name }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: statusColor, selectable: false, attributes: ATTR_DIM, children: statusLabel }), _jsx("box", { width: 1 }), _jsx("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, width: 6, children: fmtDuration(duration) })] }), _jsx(Show, { when: state.input && Object.keys(state.input).length > 0, children: _jsxs("text", { fg: ctx.theme.text.faint, selectable: false, attributes: ATTR_DIM, marginLeft: 2, wrapMode: "none", children: [JSON.stringify(state.input).slice(0, 120), JSON.stringify(state.input).length > 120 ? "…" : ""] }) }), _jsx(Show, { when: error && state.content && state.content.length > 0, children: _jsx("text", { fg: ctx.theme.text.feedback.error.base, selectable: false, attributes: ATTR_DIM, marginLeft: 2, wrapMode: "none", children: state.content?.[0]?.text?.slice(0, 120) ?? "error" }) })] }));
}
/** Main panel component. */
function Panel(props) {
    const ctx = usePlugin();
    const [tick, setTick] = createSignal(0);
    const [failed, setFailed] = createSignal(false);
    let refreshTimer;
    const REFRESH_DEBOUNCE_MS = 400;
    const TICK_THROTTLE_MS = 250;
    let tickTimer;
    let requestSeq = 0;
    const refresh = async () => {
        const seq = ++requestSeq;
        try {
            // Sync session family to ensure cache is fresh
            await ctx.data.session.sync(props.sessionID);
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
    const onSession = (type, handler) => ctx.data.on(type, (event) => {
        if (event?.data?.sessionID === props.sessionID)
            handler();
    });
    const subscriptions = SESSION_EVENTS.map((type) => {
        const handler = type.includes("execution") || type.includes("step") || type === "session.idle" || type === "session.model.selected" || type === "session.created" || type === "session.deleted" || type === "session.forked"
            ? scheduleRefresh
            : scheduleTick;
        return onSession(type, handler);
    });
    onCleanup(() => {
        for (const off of subscriptions)
            off();
        if (refreshTimer)
            clearTimeout(refreshTimer);
        if (tickTimer)
            clearTimeout(tickTimer);
    });
    onMount(() => {
        void ctx.data.session.sync(props.sessionID);
    });
    return (_jsxs("box", { flexDirection: "column", gap: 1, padding: 1, children: [_jsx(Show, { when: failed(), children: _jsx("text", { fg: ctx.theme.text.feedback.error.base, selectable: false, children: "Failed to load session data" }) }), _jsx(AgentsSection, { sessionID: props.sessionID, tick: tick() }), _jsx("box", { height: 1, backgroundColor: ctx.theme.border.base }), _jsx(ToolsSection, { sessionID: props.sessionID, tick: tick() })] }));
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