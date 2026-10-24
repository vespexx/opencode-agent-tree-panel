/**
 * Server entry point for the agent-tree-panel plugin.
 * This plugin is TUI-only; the server entry is inert.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "agent-tree-panel",
  async setup() {
    // No server-side functionality needed — all data is available client-side
    // via ctx.data.session.family(), ctx.data.session.get(), ctx.data.session.message.list()
  },
})