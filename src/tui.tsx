/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import {
  getAliasMap,
  lookupAlias,
  extractAlias,
  type UpstreamModel,
  type ProviderInfoLike,
} from "./litellm"

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
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`
}

/** Model rendered as provider/model@variant, tolerant of string and object shapes. */
function modelText(model?: { id: string; providerID: string; variant?: string } | string): string {
  if (!model) return "unknown model"
  if (typeof model === "string") return model
  const variant = model.variant && model.variant !== "default" ? `@${model.variant}` : ""
  return `${model.providerID}/${model.id}${variant}`
}

/** Status dot: filled while the session is running. */
function StatusDot(props: { running: boolean }) {
  const ctx = usePlugin()
  const color = props.running ? ctx.theme.text.feedback.success.base : ctx.theme.text.feedback.info.base
  return (
    <text fg={color} selectable={false} flexShrink={0}>
      {props.running ? "●" : "○"}
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

/** Running entries first, then the most recently touched ones. */
function sortByActivity(nodes: AgentNode[], statuses: Map<string, "idle" | "running">): AgentNode[] {
  return [...nodes].sort((a, b) => {
    const aRunning = statuses.get(a.session.id) === "running" ? 1 : 0
    const bRunning = statuses.get(b.session.id) === "running" ? 1 : 0
    if (aRunning !== bRunning) return bRunning - aRunning
    return b.session.time.updated - a.session.time.updated
  })
}

/** One finished-agent bucket: every completed run of the same agent, summed up. */
interface AgentGroup {
  agent: string
  count: number
  tokens: number
  cost: number
  duration: number
  model: string
  modelRef?: { id: string; providerID: string; variant?: string } | string
  updated: number
}

/** Split children into the ones still running and per-agent totals of the finished ones. */
function splitChildren(nodes: AgentNode[], statuses: Map<string, "idle" | "running">) {
  const sorted = sortByActivity(nodes, statuses)
  const running = sorted.filter((n) => statuses.get(n.session.id) === "running")
  const finished = sorted.filter((n) => statuses.get(n.session.id) !== "running")

  const buckets = new Map<string, { group: AgentGroup; models: Set<string> }>()
  for (const node of finished) {
    const session = node.session
    const key = session.agent ?? "default"
    const model = modelText(session.model)
    const bucket = buckets.get(key) ?? {
      group: { agent: key, count: 0, tokens: 0, cost: 0, duration: 0, model, modelRef: session.model, updated: 0 },
      models: new Set<string>(),
    }
    bucket.group.count += 1
    bucket.group.tokens += totalTokens(session.tokens)
    bucket.group.cost += session.cost
    bucket.group.duration += elapsed(session, "idle")
    bucket.group.updated = Math.max(bucket.group.updated, session.time.updated)
    bucket.models.add(model)
    buckets.set(key, bucket)
  }

  const groups = [...buckets.values()]
    .map(({ group, models }) => ({
      ...group,
      model: models.size === 1 ? [...models][0]! : `${models.size} models`,
    }))
    .sort((a, b) => b.updated - a.updated)

  return { running, groups, finishedTotal: finished.length }
}

/** Completed runs of one agent, rolled into a three-line block with totals. */
function AgentGroupRow(props: { group: AgentGroup; aliasMap: Map<string, UpstreamModel> }) {
  const ctx = usePlugin()
  const group = props.group

  // Resolve upstream model for LiteLLM aliases
  const alias = group.modelRef ? extractAlias(group.modelRef) : undefined
  const upstream = alias ? lookupAlias(props.aliasMap, alias) : undefined

  return (
    <box flexDirection="column" gap={0} marginLeft={2}>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
          ○
        </text>
        <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} wrapMode="none" truncate flexShrink={1}>
          {group.agent} ×{group.count}
        </text>
        <box flexGrow={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
          {fmtDuration(group.duration)}
        </text>
      </box>
      <box flexDirection="column" paddingLeft={2}>
        <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} wrapMode="char">
          {group.model}
        </text>
        {(() => {
          const u = upstream
          return u ? (
            <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} wrapMode="char">
              → {u.upstream}
            </text>
          ) : null
        })()}
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} wrapMode="char">
          {fmtTokens(group.tokens)} tok · {fmtCost(group.cost)}
        </text>
      </box>
    </box>
  )
}

/** Agent tree section. */
function AgentsSection(props: { sessionID: string; tick: number; aliasMap: Map<string, UpstreamModel> }) {
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

  const roots = createMemo(() => sortByActivity(family(), statuses()))

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={ctx.theme.text.base} selectable={false} attributes={ATTR_BOLD}>
          Agents
        </text>
        <box flexGrow={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
          {family().length} total
        </text>
      </box>

      <For each={roots()}>{(root) => <AgentTreeNode node={root} statuses={statuses()} aliasMap={props.aliasMap} />}</For>

      <Show when={family().length === 0}>
        <text fg={ctx.theme.text.faint} selectable={false} marginTop={1}>
          No sessions in this family
        </text>
      </Show>
    </box>
  )
}

/** Recursive tree node renderer. */
function AgentTreeNode(props: {
  node: AgentNode
  statuses: Map<string, "idle" | "running">
  aliasMap: Map<string, UpstreamModel>
}) {
  const { node, statuses, aliasMap } = props
  const ctx = usePlugin()
  const session = node.session
  const status = statuses.get(session.id) ?? "idle"
  const running = status === "running"
  const tokens = totalTokens(session.tokens)
  const duration = elapsed(session, status)
  const hasChildren = node.children.length > 0
  const children = splitChildren(node.children, statuses)

  const agentName = session.agent ?? "default"
  const kind = session.parentID ? "sub" : "primary"
  // Nesting already indents by 2 per level, so only non-root nodes add their own step.
  const indent = node.depth > 0 ? 2 : 0

  // Resolve upstream model for LiteLLM aliases
  const alias = extractAlias(session.model)
  const upstream = alias ? lookupAlias(aliasMap, alias) : undefined

  return (
    <box flexDirection="column" gap={0} marginLeft={indent}>
      {/* Line 1: status + agent name + kind, duration on the right (never shrinks). */}
      <box flexDirection="row" gap={1} height={1}>
        <StatusDot running={running} />
        <text
          fg={ctx.theme.text.base}
          selectable={false}
          attributes={node.depth === 0 ? ATTR_BOLD : 0}
          wrapMode="none"
          truncate
          flexShrink={1}
        >
          {agentName}
        </text>
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
          · {kind}
        </text>
        <box flexGrow={1} />
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
          {fmtDuration(duration)}
        </text>
      </box>

      {/* Line 2: the model wraps on its own line so long names stay readable. */}
      <box flexDirection="column" paddingLeft={2}>
        <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} wrapMode="char">
          {modelText(session.model)}
        </text>
        {(() => {
          const u = upstream
          return u ? (
            <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} wrapMode="char">
              → {u.upstream}
            </text>
          ) : null
        })()}
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} wrapMode="char">
          {fmtTokens(tokens)} tok · {fmtCost(session.cost)}
        </text>
      </box>

      {/* Live sub-agents in full detail, finished ones rolled up per agent. */}
      <Show when={hasChildren}>
        <For each={children.running}>
          {(child) => <AgentTreeNode node={child} statuses={statuses} aliasMap={aliasMap} />}
        </For>
        <For each={children.groups}>
          {(group) => <AgentGroupRow group={group} aliasMap={aliasMap} />}
        </For>
      </Show>
    </box>
  )
}

/** A tool is "running" while it streams input or executes. */
function isToolRunning(tool: ToolPart): boolean {
  return tool.state.status === "running" || tool.state.status === "streaming"
}

/** Wall-clock time a tool call took: queued plus executed. */
function toolDuration(tool: ToolPart): number {
  const { time } = tool
  if (time.completed && time.created) return time.completed - time.created
  if (time.ran && time.created) return time.ran - time.created
  if (time.created) return Date.now() - time.created
  return 0
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

  // Running calls in full detail, finished ones rolled up per tool name.
  const ordered = createMemo(() => {
    const sorted = [...latestTools()].sort((a, b) => {
      const aRunning = isToolRunning(a) ? 1 : 0
      const bRunning = isToolRunning(b) ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return b.time.created - a.time.created
    })

    const buckets = new Map<string, { name: string; count: number; duration: number; updated: number }>()
    for (const tool of sorted) {
      if (isToolRunning(tool)) continue
      const bucket = buckets.get(tool.name) ?? { name: tool.name, count: 0, duration: 0, updated: 0 }
      bucket.count += 1
      bucket.duration += toolDuration(tool)
      bucket.updated = Math.max(bucket.updated, tool.time.completed ?? tool.time.ran ?? tool.time.created)
      buckets.set(tool.name, bucket)
    }

    return {
      running: sorted.filter(isToolRunning),
      groups: [...buckets.values()].sort((a, b) => b.updated - a.updated),
      total: sorted.length,
    }
  })

  const tools = ordered()

  if (tools.total === 0) {
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
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
          {tools.total} in current step
        </text>
      </box>

      <For each={tools.running}>{(tool) => <ToolRow tool={tool} />}</For>
      <For each={tools.groups}>{(group) => <ToolGroupRow group={group} />}</For>
    </box>
  )
}

/** Completed calls of one tool, rolled into a single line with the total time. */
function ToolGroupRow(props: { group: { name: string; count: number; duration: number } }) {
  const ctx = usePlugin()
  return (
    <box flexDirection="row" gap={1} height={1} marginLeft={1} paddingLeft={1}>
      <text fg={ctx.theme.text.feedback.success.base} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
        ✓
      </text>
      <text fg={ctx.theme.text.muted} selectable={false} attributes={ATTR_DIM} wrapMode="none" truncate flexShrink={1}>
        {props.group.name} ×{props.group.count}
      </text>
      <box flexGrow={1} />
      <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} flexShrink={0}>
        {fmtDuration(props.group.duration)}
      </text>
    </box>
  )
}

/** Single tool call row (only ever rendered for calls that are still running). */
function ToolRow(props: { tool: ToolPart }) {
  const { tool } = props
  const ctx = usePlugin()
  const { name, state } = tool
  const status = state.status
  const running = status === "running" || status === "streaming"
  const completed = status === "completed"
  const error = status === "error"

  const duration = toolDuration(tool)

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
        <text fg={ctx.theme.text.faint} selectable={false} attributes={ATTR_DIM} marginLeft={2} wrapMode="char">
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
  const [aliasMap, setAliasMap] = createSignal<Map<string, UpstreamModel>>(new Map())
  const [aliasLoading, setAliasLoading] = createSignal(false)

  // Load alias map on first mount
  createEffect(
    on(
      () => props.sessionID,
      async () => {
        setAliasLoading(true)
        try {
          // Sync providers to ensure cache is fresh
          await ctx.data.location.provider.sync()
          const providers = (ctx.data.location.provider.list() ?? []) as ProviderInfoLike[]
          const map = await getAliasMap("litellm", providers)
          setAliasMap(map)
        } catch {
          // silently ignore — upstream display is optional
        } finally {
          setAliasLoading(false)
        }
      },
    ),
  )

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

      <AgentsSection sessionID={props.sessionID} tick={tick()} aliasMap={aliasMap()} />
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