/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"

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
] as const

/** Minimal session info from the client cache (matches SessionInfo from @opencode/client). */
interface SessionInfo {
  id: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number }
  title?: string
}

/** Tool call part from an assistant message. */
interface ToolPart {
  type: "tool"
  id: string
  name: string
  executed: boolean
  state: {
    status: "streaming" | "running" | "completed" | "error"
    input?: Record<string, unknown>
    content?: Array<{ type: "text"; text: string }>
    metadata?: Record<string, unknown>
  }
  time: { created: number; ran?: number; completed?: number }
}

/** Assistant message shape (subset). */
interface AssistantMessage {
  type: "assistant"
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  content: Array<{ type: string } | ToolPart>
  time: { created: number; streamed?: number; completed?: number }
}

/** Event payload with sessionID. */
interface SessionEventPayload {
  data?: { sessionID?: string }
}

/** Text attribute bitmask constants (from @opentui/core). */
const ATTR_BOLD = 1
const ATTR_DIM = 2
const ATTR_ITALIC = 3
const ATTR_UNDERLINE = 4

/** Display format helpers. */
function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(value))
}

function fmtCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}

/** Status badge component. */
function StatusBadge(props: { status: "idle" | "running"; variant?: "compact" }) {
  const ctx = usePlugin()
  const running = props.status === "running"
  const dotColor = running ? ctx.theme.text.feedback.success.base : ctx.theme.text.feedback.info.base
  const label = running ? "running" : "idle"

  if (props.variant === "compact") {
    return (
      <box flexDirection="row" gap={1}>
        <box width={1} height={1} backgroundColor={dotColor} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM}>
          {label}
        </text>
      </box>
    )
  }
  return (
    <box flexDirection="row" gap={1} paddingX={1} paddingY={0} backgroundColor={dotColor + "20"}>
      <box width={1} height={1} backgroundColor={dotColor} />
      <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_DIM}>
        {label}
      </text>
    </box>
  )
}

/** Model display: provider/model. */
function ModelLabel(props: { model?: { id: string; providerID: string; variant?: string } | string }) {
  const ctx = usePlugin()
  if (!props.model) return <text fg={ctx.theme.text.faint} selectable={false}>—</text>
  
  // Handle both object and string formats
  if (typeof props.model === "string") {
    return <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_DIM}>{props.model}</text>
  }
  
  const { providerID, id, variant } = props.model
  return (
    <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_DIM}>
      {providerID}/{id}{variant ? `@${variant}` : ""}
    </text>
  )
}

/** Agent node in the tree. */
interface AgentNode {
  session: SessionInfo
  children: AgentNode[]
  depth: number
}

/** Recursive tree builder from flat family list. */
function buildTree(sessionIDs: string[], getSession: (id: string) => SessionInfo | undefined): AgentNode[] {
  const nodes = new Map<string, AgentNode>()

  // Create all nodes first
  for (const id of sessionIDs) {
    const s = getSession(id)
    if (!s) continue
    nodes.set(id, { session: s, children: [], depth: 0 })
  }

  // Link children to parents
  const roots: AgentNode[] = []
  for (const [id, node] of nodes) {
    const parentID = node.session.parentID
    if (parentID && nodes.has(parentID)) {
      nodes.get(parentID)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Set depths
  function setDepth(node: AgentNode, depth: number) {
    node.depth = depth
    for (const child of node.children) setDepth(child, depth + 1)
  }
  for (const root of roots) setDepth(root, 0)

  // Sort children by creation time (older first)
  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.session.time.created - b.session.time.created)
  }

  return roots
}

/** Total tokens for a session (input + output + reasoning + cache). */
function totalTokens(tokens: SessionInfo["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/** Elapsed time since session creation (or last update if running). */
function elapsed(session: SessionInfo, status: "idle" | "running"): number {
  const end = status === "running" ? session.time.updated : (session.time.idle ?? session.time.updated)
  return Math.max(0, end - session.time.created)
}

/** Agent tree section. */
function AgentsSection(props: { sessionID: string; tick: number }) {
  const ctx = usePlugin()

  // Build the tree from family + cache
  const family = createMemo(() => {
    props.tick // react to tick for live updates
    const ids = ctx.data.session.family(props.sessionID)
    const get = (id: string) => ctx.data.session.get(id)
    return buildTree(ids, get)
  })

  // Status per session (for live "running" indicator)
  const statuses = createMemo(() => {
    props.tick
    const ids = ctx.data.session.family(props.sessionID)
    const map = new Map<string, "idle" | "running">()
    for (const id of ids) {
      map.set(id, ctx.data.session.status(id))
    }
    return map
  })

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_BOLD}>
          Agents
        </text>
        <box flexGrow={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM}>
          {family().length} session{family().length !== 1 ? "s" : ""}
        </text>
      </box>

      <For each={family()}>
        {(root) => <AgentTreeNode node={root} statuses={statuses()} />}
      </For>

      <Show when={family().length === 0}>
        <text fg={ctx.theme.text.faint} selectable={false} marginTop={1}>
          No sessions in this family
        </text>
      </Show>
    </box>
  )
}

/** Recursive tree node renderer. */
function AgentTreeNode(props: { node: AgentNode; statuses: Map<string, "idle" | "running"> }) {
  const { node, statuses } = props
  const ctx = usePlugin()
  const session = node.session
  const status = statuses.get(session.id) ?? "idle"
  const tokens = totalTokens(session.tokens)
  const duration = elapsed(session, status)
  const hasChildren = node.children.length > 0

  const prefix = "  ".repeat(node.depth) + (node.depth > 0 ? "└─ " : "")
  const agentName = session.agent ?? "default"

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM}>
          {prefix}
        </text>
        <text fg={ctx.theme.text.base} selectable={false} attributes={node.depth === 0 ? ATTR_BOLD : 0}>
          {agentName}
        </text>
        <box flexGrow={1} />
        <ModelLabel model={session.model} />
        <box width={1} />
        <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} width={8}>
          {fmtTokens(tokens)}
        </text>
        <box width={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} width={7}>
          {fmtCost(session.cost)}
        </text>
        <box width={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} width={6}>
          {fmtDuration(duration)}
        </text>
        <box width={1} />
        <StatusBadge status={status} variant="compact" />
      </box>

      <Show when={hasChildren}>
        <For each={node.children}>
          {(child) => <AgentTreeNode node={child} statuses={statuses} />}
        </For>
      </Show>
    </box>
  )
}

/** Tools section showing current step's tool calls. */
function ToolsSection(props: { sessionID: string; tick: number }) {
  const ctx = usePlugin()

  // Get latest assistant message with tool parts
  const latestTools = createMemo<ToolPart[]>(() => {
    props.tick
    const messages = (ctx.data.session.message.list(props.sessionID) ?? []) as AssistantMessage[]
    // Find the most recent assistant message that has tool parts
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.type !== "assistant") continue
      const tools = msg.content.filter((p): p is ToolPart => p.type === "tool")
      if (tools.length > 0) return tools
    }
    return []
  })

  const tools = latestTools()

  if (tools.length === 0) {
    return (
      <box flexDirection="column" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_BOLD}>
            Tools
          </text>
          <box flexGrow={1} />
          <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM}>
            (current step)
          </text>
        </box>
        <text fg={ctx.theme.text.faint} selectable={false} marginTop={1}>
          No tool calls in the current step
        </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_BOLD}>
          Tools
        </text>
        <box flexGrow={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM}>
          {tools.length} call{tools.length !== 1 ? "s" : ""} in current step
        </text>
      </box>

      <For each={tools}>
        {(tool) => <ToolRow tool={tool} />}
      </For>
    </box>
  )
}

/** Single tool call row. */
function ToolRow(props: { tool: ToolPart }) {
  const { tool } = props
  const ctx = usePlugin()
  const { name, state, time } = tool
  const status = state.status
  const running = status === "running" || status === "streaming"
  const completed = status === "completed"
  const error = status === "error"

  // Duration
  let duration = 0
  if (time.ran && time.created) duration = time.ran - time.created
  if (time.completed && time.ran) duration = time.completed - time.ran
  if (!time.ran && time.created) duration = Date.now() - time.created

  const statusColor = error
    ? ctx.theme.text.feedback.error.base
    : running
    ? ctx.theme.text.feedback.warning.base
    : completed
    ? ctx.theme.text.feedback.success.base
    : ctx.theme.text.faint

  const statusLabel = error ? "error" : running ? "running" : completed ? "done" : "pending"

  // Use a colored left border via a thin box
  const leftBorder = <box width={1} backgroundColor={statusColor + "80"} height={1} />

  return (
    <box flexDirection="column" gap={0} marginLeft={1} paddingLeft={1}>
      <box flexDirection="row" gap={1} height={1}>
        {leftBorder}
        <text fg={statusColor} selectable={false} attributes={ATTR_DIM} width={1}>
          {running ? "▶" : completed ? "✓" : error ? "✗" : "○"}
        </text>
        <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_BOLD}>
          {name}
        </text>
        <box flexGrow={1} />
        <text fg={statusColor} selectable={false} attributes={ATTR_DIM}>
          {statusLabel}
        </text>
        <box width={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} width={6}>
          {fmtDuration(duration)}
        </text>
      </box>

      <Show when={state.input && Object.keys(state.input).length > 0}>
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} marginLeft={2} wrapMode="none">
          {JSON.stringify(state.input).slice(0, 120)}{JSON.stringify(state.input).length > 120 ? "…" : ""}
        </text>
      </Show>

      <Show when={error && state.content && state.content.length > 0}>
        <text fg={ctx.theme.text.feedback.error.base} selectable={false} attributes={ATTR_DIM} marginLeft={2} wrapMode="none">
          {state.content?.[0]?.text?.slice(0, 120) ?? "error"}
        </text>
      </Show>
    </box>
  )
}

/** Main panel component. */
function Panel(props: { sessionID: string }) {
  const ctx = usePlugin()
  const [tick, setTick] = createSignal(0)
  const [failed, setFailed] = createSignal(false)

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const REFRESH_DEBOUNCE_MS = 400
  const TICK_THROTTLE_MS = 250
  let tickTimer: ReturnType<typeof setTimeout> | undefined
  let requestSeq = 0

  const refresh = async () => {
    const seq = ++requestSeq
    try {
      // Sync session family to ensure cache is fresh
      await ctx.data.session.sync(props.sessionID)
      if (seq !== requestSeq) return
      setTick((v) => v + 1)
      setFailed(false)
    } catch {
      if (seq !== requestSeq) return
      setFailed(true)
    }
  }

  /** Re-read when session changes. */
  createEffect(
    on(
      () => props.sessionID,
      () => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = undefined
        setFailed(false)
        void refresh()
      },
    ),
  )

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  const scheduleTick = () => {
    if (tickTimer) return
    tickTimer = setTimeout(() => {
      tickTimer = undefined
      setTick((v) => v + 1)
    }, TICK_THROTTLE_MS)
  }

  const onSession = (type: typeof SESSION_EVENTS[number], handler: () => void) =>
    ctx.data.on(type as any, (event: SessionEventPayload) => {
      if (event?.data?.sessionID === props.sessionID) handler()
    })

  const subscriptions = SESSION_EVENTS.map((type) => {
    const handler = type.includes("execution") || type.includes("step") || type === "session.idle" || type === "session.model.selected" || type === "session.created" || type === "session.deleted" || type === "session.forked"
      ? scheduleRefresh
      : scheduleTick
    return onSession(type, handler)
  })

  onCleanup(() => {
    for (const off of subscriptions) off()
    if (refreshTimer) clearTimeout(refreshTimer)
    if (tickTimer) clearTimeout(tickTimer)
  })

  onMount(() => {
    void ctx.data.session.sync(props.sessionID)
  })

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <Show when={failed()}>
        <text fg={ctx.theme.text.feedback.error.base} selectable={false}>
          Failed to load session data
        </text>
      </Show>

      <AgentsSection sessionID={props.sessionID} tick={tick()} />
      <box height={1} backgroundColor={ctx.theme.border.base} />
      <ToolsSection sessionID={props.sessionID} tick={tick()} />
    </box>
  )
}

/** Plugin definition. */
export default Plugin.define({
  id: "agent-tree-panel",
  setup(ctx) {
    ctx.ui.slot({
      prepend: "sidebar.content",
      render: (input) => <Panel sessionID={input.sessionID} />,
    })
  },
})