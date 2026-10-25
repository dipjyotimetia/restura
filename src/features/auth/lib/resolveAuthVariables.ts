/**
 * Resolve `{{vars}}` in every auth type's user-entered fields. The
 * implementation lives in `shared/auth/resolve-variables.ts` so the CLI (which
 * cannot import `src/`) resolves auth identically; see that module for the
 * field map and SecretRef semantics (handle / external refs pass through).
 */
export { resolveAuthVariables } from '@shared/auth/resolve-variables';
