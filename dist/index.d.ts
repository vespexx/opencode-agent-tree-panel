interface HookContext {
    session?: {
        hook?: (name: string, callback: (event: unknown) => Promise<void> | void) => unknown;
    };
}
declare const _default: {
    id: string;
    /** Current loader shape (same one the model-fallback plugin uses). */
    server(ctx: HookContext): Promise<{}>;
    /** Older snapshots call setup() instead. */
    setup(ctx: HookContext): () => void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map