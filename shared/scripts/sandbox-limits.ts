// Resource ceilings shared by every QuickJS runtime Restura creates (request
// scripts, eval script scorers and the agent sandbox provider), so a change to
// one cap cannot silently leave another sandbox looser than the rest.

/** Wall-clock ceiling for sync-only scripts. */
export const QUICKJS_MAX_EXECUTION_TIME_MS = 5000;
/**
 * Ceiling for scripts that await host-resolved promises (`pm.sendRequest`,
 * `pm.vault.*`): a sub-request itself takes seconds.
 */
export const QUICKJS_MAX_EXECUTION_TIME_MS_ASYNC = 30000;
/**
 * 64MB — the library bundle (~600KB raw) plus a cheerio DOM tree for a
 * moderate HTML page comfortably exceeds the legacy 10MB ceiling. Per-runtime
 * allocator, freed on dispose().
 */
export const QUICKJS_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
/**
 * Native (WASM) stack ceiling for sandboxed recursion. QuickJS's default
 * bounds it, but pin it so a build/default change can't silently remove the
 * cap. 1MB ≈ a few thousand frames.
 */
export const QUICKJS_MAX_STACK_BYTES = 1024 * 1024;
