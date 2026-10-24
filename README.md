# opencode-agent-tree-panel

Right-sidebar panel for OpenCode showing the agent/sub-agent tree with models, tokens, cost, and current step's tool calls.

## Features

- **Agents section**: Tree view of the current session family (root + sub-agent children) showing:
  - Agent name with kind badge (`· primary` / `· sub`)
  - Model (provider/model@variant)
  - **Model history**: the model in effect now on top, the ones it replaced dimmed below (`↳ …`), newest first —
    a quota/timeout fallback or a manual switch no longer hides which model answered the previous request
  - **Spend per replaced model**: the tokens, cost and time a model consumed before it was replaced
    (`↓ 1.2M tok · $0.18 · 38m` above its `↳` line)
  - **Upstream model resolution** for LiteLLM aliases (e.g. `litellm/worker-coder-dev-model → openrouter/minimax/minimax-m3.1-flash`)
  - **Served deployment**: the deployment that actually answered, read from the LiteLLM response headers
    (`x-litellm-model-id`) and shown as a short id after the upstream model; when LiteLLM answered from another
    deployment the panel says so explicitly instead of showing the alias as if it had answered
  - **Cost for models OpenCode cannot price**: when the harness reports `$0.00` for a LiteLLM alias (its registry does
    not know the alias), the panel prices the tokens itself from `/model/info` and marks the number as an estimate
    (`≈ $0.36`), so a paid model never looks free
  - **Totals**: a `session total` line with tokens and cost (summing input + output + reasoning + cache); under the
    primary session an estimated total also shows the rates it used
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
  "version": "0.4.0",
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

The plugin has two entrypoints: `index.js` (server: the `http.response` hook that records which LiteLLM deployment
answered) and `tui.js` (the panel). On this build the server loads the entry per request, so a fresh build starts
writing the served-deployment log with the next request; restart OpenCode if the log stays empty after a few turns. The
TUI half picks up rendering changes on a TUI reload.

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
  → openrouter/minimax/minimax-m3.1-flash · 75921bbf
  session total · 1.2M tok · ≈ $0.04
  ≈ litellm max price · in $0.30/M · out $1.20/M · cache $0.006/M
```

If the fetch fails or the provider isn't LiteLLM, the panel silently shows only the alias — no errors, no clutter.

### What actually answered: `x-litellm-model-id`

An alias can fan out to several deployments, and LiteLLM may answer from a different one than the alias name suggests
(fallbacks, retries, routing). The transcript only records the alias, so the panel also listens on the server side:

- the server entry (`index.js`) registers `ctx.session.hook("http.response")` and, for `litellm` responses, reads
  `x-litellm-model-id`, `x-litellm-model-name`, `x-litellm-model-group`, `x-litellm-model-api-base`,
  `x-litellm-attempted-fallbacks` and `x-litellm-attempted-retries`;
- one compact JSON line per request is appended to `~/.local/share/opencode/agent-tree-panel/served.jsonl`
  (bounded: the file is rewritten with the newest lines once it passes 256 KB);
- the TUI reads that log (cached by file size/mtime) and resolves the deployment id through the same `/model/info`
  map, so the short id after `→` names a real deployment and a fallback becomes visible.

```
build · primary                                 14h 48m
  litellm/deepseek-v4-flash-cloud-deepseek
  → deepseek/deepseek-flash · 75921bbf
  session total · 33.1M tok · ≈ $0.36
  ≈ litellm max price · in $0.30/M · out $1.20/M · cache $0.006/M
```

When LiteLLM answered from another deployment, the alias line stays and a warning line names what came back:

```
  → deepseek/deepseek-flash
  ⚠ litellm served openrouter/meta/llama-3.3-70b · fallback ×1
```

For a model that was already replaced, the same information is added under its `↳` line.

### Why a paid model can show `$0.00`, and what the panel does about it

OpenCode prices a request only when it knows the model id (its own model registry). A LiteLLM alias defined locally is
not in that registry, so a paid model served through the alias comes back with `cost: 0` on every message — the session
looks free although the proxy charged for it. (`x-litellm-model-id` does not help here: the response headers carry the
deployment, not the price.)

The panel therefore prices those tokens itself, from the same `/model/info`:

- rates come from `model_info` (`input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`,
  `cache_creation_input_token_cost`); reasoning tokens are billed at the output rate, cache reads at the cache rate and
  `tokens.input` is already the non-cached part, so nothing is counted twice;
- LiteLLM can publish several rates per token — peak and off-peak (`off_peak_pricing`, DeepSeek's time-of-day billing),
  speed variants (`_flex`, `_priority`, `_balanced`, `_ultrafast`), batch rates and long-context tiers
  (`_above_200k_tokens`, …). A finished request does not say which one applied, so the panel takes the **maximum**: the
  number is an upper bound and is shown with `≈`;
- the prices of the deployment that answered are used when `served.jsonl` knows it, otherwise the alias's own prices;
  an alias whose deployments disagree on price is never priced blindly (only its served deployment is);
- when OpenCode did report a non-zero cost, that number wins and is printed without `≈`.

For the session in the example above (`deepseek-v4-flash-cloud-deepseek`, peak rates $0.30/M in, $1.20/M out,
$0.006/M cache read) 195.5k input + 119.1k output/reasoning + 26.9M cache-read tokens come to **≈ $0.36**; at the
off-peak rate the same traffic would have cost about half. Under the primary session's `session total` the panel prints
the rates it used, so the estimate explains itself:

```
session total · 33.1M tok · ≈ $0.36
≈ litellm max price · in $0.30/M · out $1.20/M · cache $0.006/M
```


## Screenshot

The panel appears in the right sidebar:

```
┌───────────────────────────────────────────────────────┐
│ Agents                                        7 total │
│ ● build · primary                             14h 48m │
│   litellm/deepseek-v4-flash-cloud-deepseek            │
│   → deepseek/deepseek-flash · 75921bbf                │
│   ↓ 1.2M tok · $0.18 · 38m                            │
│   ↳ litellm/deepseek-v4.1-flash-free ×7               │
│   ↳ litellm/qwen3.6-35b-a3b-win-lmstudio ×2           │
│   session total · 33.1M tok · ≈ $0.36                  │
│   ≈ litellm max price · in $0.30/M · out $1.20/M …     │
│ ● worker-verifier · sub                        2m 12s │
│   litellm/worker-verifier-dev-model                   │
│   → gemini/gemini-3.8-flash                           │
│   session total · 160.2k tok · $0.01                  │
│ ○ worker-coder ×3                             11m 29s │
│   litellm/worker-coder-dev-model                      │
│   → openrouter/minimax/minimax-m3.1-flash             │
│   group total · 4.2M tok · ≈ $1.31                    │
│ ○ worker-ops ×8                               21m 40s │
│   litellm/worker-ops-dev-model                        │
│   → openrouter/nvidia/nemotron-3-ultra-550b-a55b:free │
│   group total · 6.8M tok · $0.00                      │
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
  → deepseek/deepseek-flash · 75921bbf        ← deployment that answered
  ↓ 1.2M tok · $0.18 · 38m                    ← spent on the model below
  ↳ litellm/deepseek-v4.1-flash-free ×7       ← served 7 requests before the fallback
  ↳ litellm/qwen3.6-35b-a3b-win-lmstudio ×2
  session total · 33.1M tok · ≈ $0.36         ← estimated: OpenCode reports 0 for this alias
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
  time therefore cover the loaded window, while the `session total` line is the session's real total.
- Served-deployment data starts with the first request handled after the server entry is on disk; it cannot be
  reconstructed from older transcripts. The log keeps the newest ~300 responses, 256 KB at most.
- The server and the TUI must run on the same machine: the hook writes
  `~/.local/share/opencode/agent-tree-panel/served.jsonl`, the panel reads it. `AGENT_TREE_PANEL_DIR` overrides the path
  (used by the checks).
- Grouped finished sub-agents (`worker-coder ×3`) do not carry a served-deployment id: the record is per session and a
  group spans several of them, so the group row shows the statically resolved alias only.
- At most 3 past models are listed; the rest collapse into `↳ +N earlier`.
- An `≈` cost is an estimate at the highest rate LiteLLM publishes for that deployment, computed from the session's own
  token counts (per model, from the loaded transcript window). It is an upper bound: peak instead of off-peak, the most
  expensive speed variant, and long-context tiers treated as if they applied to every request. Models for which the
  proxy publishes no per-token price stay at `$0.00`, as do genuinely free ones.

## How it works

- TUI plugin for the panel, plus a minimal server entry for the response hook
- Uses `ctx.data.session.family()` to get the session tree
- Uses `ctx.data.session.get()` for per-session details
- Uses `ctx.data.session.message.list()` to find current step's tool calls and the model history
- Subscribes to session events (`session.created`, `session.execution.*`, `session.step.*`, `session.tool.*`, etc.) for live updates
- LiteLLM resolution runs once on panel mount (cached for 5 minutes), and it carries the prices used for estimates; the served-deployment log is re-read only when the file changes
- The server entry registers one `http.response` hook, scoped by provider id (`litellm`) inside the callback, and appends
  to the log; it never blocks or fails a request

## Development

```bash
npm run dev    # TypeScript watch mode
npm run check  # model-history + served-deployment + pricing checks (65 assertions)
```

## Requirements

- OpenCode v2.1+
- @opencode/plugin v2.1+
- @opentui/core v0.6+
- @opentui/solid v0.6+
- solid-js v1.8+

## License

MIT