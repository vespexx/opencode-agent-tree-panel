# opencode-agent-tree-panel

Right-sidebar panel for OpenCode showing the agent/sub-agent tree with models, tokens, cost, and current step's tool calls.

## Features

- **Agents section**: Tree view of the current session family (root + sub-agent children) showing:
  - Agent name
  - Model (provider/model@variant)
  - Total tokens used
  - Cost
  - Elapsed duration
  - Live status (idle/running)

- **Tools section**: Tool calls from the current step showing:
  - Tool name
  - Status (running/completed/error)
  - Duration
  - Input preview (truncated)
  - Error output (if failed)

- **Live updates**: Subscribes to session events for real-time refresh

## Installation

### From source (local development)

```bash
git clone https://github.com/book16/opencode-agent-tree-panel
cd opencode-agent-tree-panel
npm install
npm run build
```

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "./plugins/agent-tree-panel"
  ]
}
```

Then copy the built files to your plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins/agent-tree-panel
cp dist/* ~/.config/opencode/plugins/agent-tree-panel/
```

Create a `package.json` in the plugin directory:

```json
{
  "name": "opencode-agent-tree-panel",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./tui": "./tui.js"
  }
}
```

Restart OpenCode TUI.

## Development

```bash
npm run dev  # TypeScript watch mode
```

## Screenshot

The panel appears in the right sidebar (same slot as the Context panel):

```
┌─────────────────────────────────────────┐
│ Agents                          3 sessions │
│ █ explore                                  │
│   └─ worker-coder                    litellm/deepseek-v4-flash  1.2k  $0.02  45s  ● running
│   └─ worker-verifier                 openrouter/gemma-4-26b     0.8k  $0.01  12s  ○ idle
│ Tools                          2 calls in current step │
│ ▶ read                    done    12ms
│ ✓ edit                    done    45ms
└─────────────────────────────────────────┘
```

## How it works

- Pure TUI plugin (no server component needed)
- Uses `ctx.data.session.family()` to get the session tree
- Uses `ctx.data.session.get()` for per-session details
- Uses `ctx.data.session.message.list()` to find current step's tool calls
- Subscribes to session events (`session.created`, `session.execution.*`, `session.step.*`, `session.tool.*`, etc.) for live updates

## Requirements

- OpenCode v2.1+
- @opencode/plugin v2.1+
- @opentui/core v0.6+
- @opentui/solid v0.6+
- solid-js v1.8+

## License

MIT