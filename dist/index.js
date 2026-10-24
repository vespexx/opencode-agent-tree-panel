/**
 * Server entry point for the agent-tree-panel plugin.
 *
 * The panel itself is a TUI plugin, but one fact only exists on the server side: which LiteLLM *deployment* answered a
 * request. OpenCode records the model it asked for (the LiteLLM alias), while the response headers carry the truth:
 *
 *   x-litellm-model-id      the deployment that answered
 *   x-litellm-model-name    the upstream model behind it
 *   x-litellm-model-group   the alias that deployment belongs to
 *   x-litellm-attempted-fallbacks / -retries
 *
 * So this entry only registers one `http.response` hook, filters LiteLLM traffic and appends a line to a small log the
 * TUI reads (see served.ts). It deliberately exports a plain plugin object — the same shape the model-fallback plugin
 * uses on this build — so no Effect runtime has to be imported here.
 */
import { appendServed, servedFromResponse } from "./served.js";
/** Contexts a hook is already registered for; the loader may call both `server()` and `setup()`. */
const installed = new WeakSet();
function install(ctx) {
    if (!ctx || typeof ctx !== "object" || installed.has(ctx))
        return;
    const hook = ctx.session?.hook;
    if (typeof hook !== "function")
        return;
    installed.add(ctx);
    const registration = hook("http.response", async (event) => {
        const record = servedFromResponse(event);
        if (record)
            appendServed(record);
    });
    if (registration && typeof registration.then === "function") {
        ;
        registration.catch(() => {
            // The panel falls back to the statically resolved alias; never fail a request because of the log.
        });
    }
}
export default {
    id: "agent-tree-panel",
    /** Current loader shape (same one the model-fallback plugin uses). */
    async server(ctx) {
        install(ctx);
        return {};
    },
    /** Older snapshots call setup() instead. */
    setup(ctx) {
        install(ctx);
        return () => { };
    },
};
//# sourceMappingURL=index.js.map