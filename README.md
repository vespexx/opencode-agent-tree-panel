# opencode-agent-tree-panel

Right-sidebar panel for OpenCode showing the agent/sub-agent tree with models, tokens, cost, and current step's tool calls.

## Features

- **Agents section**: Tree view of the current session family (root + sub-agent children) showing:
  - Agent name with kind badge (`· primary` / `· sub`)
  - Model (provider/model@variant)
  - **Model history**: the model in effect now on top, the ones it replaced dimmed below (`↳ …`), newest first —
    a quota/timeout fallback or a manual switch no longer hides which model answered the previous request
  - **Upstream model resolution** for LiteLLM aliases (e.g. `litellm/worker-coder-dev-model → openrouter/minimax/minimax-m3.1-flash`)
  - Total tokens used (input + output + reasoning + cache)
  - Cost
  - Elapsed duration
  - Live status indicator (● running / ○ idle)

- **Tools section**: Tool calls from the current step showing:
  - Tool name
  - Status (▶ running / ✓ done / ✗ error)
  - Duration
  - Input preview (truncated, only for running calls)
  - Error output (if failed)

- **Smart grouping**:
  - Running agents are always shown in full detail (with model, tokens, cost)
  - Finished sub-agents are grouped by agent name with totals: `worker-coder ×3` + summed tokens/cost/duration
  - Finished tools are grouped by tool name: `shell ×4` + total time
  - Groups sorted by most recent activity

- **Sorting**: Running entries first, then most recently updated
- **Live updates**: Subscribes to session events for real-time refresh
- **Theme-aware**: Uses OpenCode theme colors (`text.base`, `text.muted`, `text.faint`, `feedback.*`, `border.base`)

## Installation

### Quick install (recommended)

```bash
# Clone and build
git clone https://github.com/vespexx/opencode-agent-tree-panel
cd opencode-agent-tree-panel
npm install
npm run build

# Install to OpenCode plugins directory
mkdir -p ~/.config/opencode/plugins/agent-tree-panel
cp dist/* ~/.config/opencode/plugins/agent-tree-panel/

# Create plugin package.json
cat > ~/.config/opencode/plugins/agent-tree-panel/package.json <<'EOF'
{
  "name": "opencode-agent-tree-panel",
  "version": "0.2.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./tui": "./tui.js"
  }
}
EOF
```

### Register the plugin

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "./plugins/agent-tree-panel"
  ]
}
```

Restart OpenCode TUI. The panel appears in the right sidebar (same slot as the Context panel).

## LiteLLM upstream model resolution

If you use LiteLLM as a provider with model aliases (e.g. `litellm/worker-coder-dev-model`), the panel can resolve them to the actual upstream model by fetching `/model/info` from your LiteLLM proxy.

### Requirements

- LiteLLM proxy accessible from the machine running OpenCode TUI
- The provider config in `opencode.json` must include `baseURL`, `apiKey`, and the required `Host` header (if your proxy uses Host-based routing)

Example provider config:

```json
{
  "providers": {
    "litellm": {
      "name": "LiteLLM",
      "package": "litellm",
      "settings": {
        "baseURL": "http://127.0.0.1:14000/v1",
        "apiKey": "{file:~/.config/opencode/litellm.key}",
        "headers": {
          "Host": "litellm.prod.local"
        }
      }
    }
  }
}
```

The plugin reads the provider settings from the OpenCode config cache (or falls back to scanning `opencode.json`/`opencode.jsonc` in `~/.config/opencode/` and the project root), resolves `{file:...}` and `{env:...}` templates, and fetches the model map with the correct `Host` header using `node:http` (works reliably in Bun and Node).

Resolved upstream models appear as a dim line under the alias:

```
worker-coder · sub                    2m 15s
  litellm/worker-coder-dev-model
  → openrouter/minimax/minimax-m3.1-flash
  1.2M tok · $0.04
```

If the fetch fails or the provider isn't LiteLLM, the panel silently shows only the alias — no errors, no clutter.

## Screenshot

The panel appears in the right sidebar:

```
┌───────────────────────────────────────────────────────┐
│ Agents                                        7 total │
│ ● build · primary                             14h 48m │
│   litellm/deepseek-v4-flash-cloud-deepseek            │
│   → deepseek/deepseek-v4-flash                        │
│   ↓ 1.2M tok · $0.18 · 38m                            │
│   ↳ litellm/deepseek-v4.1-flash-free ×7               │
│   ↳ litellm/qwen3.6-35b-a3b-win-lmstudio ×2           │
│   33.1M tok · $0.00                                   │
│ ● worker-verifier · sub                        2m 12s │
│   litellm/worker-verifier-dev-model                   │
│   → gemini/gemini-3.8-flash                           │
│   160.2k tok · $0.00                                  │
│ ○ worker-coder ×3                             11m 29s │
│   litellm/worker-coder-dev-model                      │
│   → openrouter/minimax/minimax-m3.1-flash             │
│   4.2M tok · $0.00                                    │
│ ○ worker-ops ×8                               21m 40s │
│   litellm/worker-ops-dev-model                        │
│   → openrouter/nvidia/nemotron-3-ultra-550b-a55b:free │
│   6.8M tok · $0.00                                    │
├───────────────────────────────────────────────────────┤
│ Tools                                       3 in step │
│ ▶ shell  running                                   4s │
│   {"command":"ls -la ..."}                            │
│ ✓ subagent ×2                                  1m 12s │
└───────────────────────────────────────────────────────┘
```

## Model changes and fallbacks

A session record only stores the model selected *at this moment*. The panel shows that model on top and keeps the ones
it replaced underneath, so a fallback is visible instead of silently rewriting history:

```
build · primary                                  14h 48m
  litellm/deepseek-v4-flash-cloud-deepseek
  → deepseek/deepseek-v4-flash
  ↓ 1.2M tok · $0.18 · 38m                   ← spent on the model below
  ↳ litellm/deepseek-v4.1-flash-free ×7      ← served 7 requests before the fallback
  ↳ litellm/qwen3.6-35b-a3b-win-lmstudio ×2
```

Where the history comes from:

- `model-switched` transcript entries (the harness writes one per change, with `previous`). Both a `session.switchModel`
  fallback in the middle of a request and a model picked between requests produce one.
- `model` of every assistant message, so the request count and the tokens/cost/time spent per model are real even when
  the switch entry is older than the loaded transcript window.
- `session.model.selected` events seen while the panel is open, which also covers sub-agent sessions (their transcripts
  are not loaded by the panel at all).

Limits worth knowing:

- The client keeps roughly the last 20 messages per session, so on mount the panel can only show the switches still in
  that window; everything it observes afterwards is remembered for the lifetime of the panel. Per-model tokens, cost and
  time therefore cover the loaded window, while the last line under an agent is the session's real total.
- A fallback *inside* one LiteLLM alias (LiteLLM router picking another deployment) is invisible here: the harness still
  records the alias, not the deployment that answered. The `→ upstream` line is the statically resolved alias target.
- At most 3 past models are listed; the rest collapse into `↳ +N earlier`.

## How it works

- Pure TUI plugin (no server component needed)
- Uses `ctx.data.session.family()` to get the session tree
- Uses `ctx.data.session.get()` for per-session details
- Uses `ctx.data.session.message.list()` to find current step's tool calls
- Subscribes to session events (`session.created`, `session.execution.*`, `session.step.*`, `session.tool.*`, etc.) for live updates
- LiteLLM resolution runs once on panel mount (cached for 5 minutes)

## Development

```bash
npm run dev  # TypeScript watch mode
```

## Requirements

- OpenCode v2.1+
- @opencode/plugin v2.1+
- @opentui/core v0.6+
- @opentui/solid v0.6+
- solid-js v1.8+

## License

MIT