/**
 * Deterministic per-environment colour. `Environment` doesn't carry a colour
 * field, so we derive one from `id:name` so the same env reads identically
 * across the sidebar footer, chrome pill, status bar, and env manager.
 *
 * Lives here (not in a `shared/` module) because environments own this
 * concept; the rest of the app reads it back through the helper.
 */
const ENV_COLOR_PALETTE = [
  '#4d9fff', // accent blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a78bfa', // violet
  '#06b6d4', // cyan
  '#e879a4', // pink
  '#f472b6', // hot pink
  '#94a3b8', // slate
] as const;

export function envColorFor(env: { id: string; name: string } | null | undefined): string {
  if (!env) return '#94a3b8';
  const source = `${env.id}:${env.name}`;
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % ENV_COLOR_PALETTE.length;
  return ENV_COLOR_PALETTE[idx] ?? '#4d9fff';
}
