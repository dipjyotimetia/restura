/**
 * Deterministic per-environment colour. `Environment` doesn't carry a colour
 * field, so we derive one from the name (and `id` as a tiebreaker) so the
 * same env reads identically across the sidebar footer, chrome pill, status
 * bar, and env manager.
 *
 * Lives here (not in a `shared/` module) because environments own this
 * concept; the rest of the app reads it back through the helper.
 *
 * Naming heuristics override the hash so the common cases ("Production" /
 * "Staging" / "Local") read with their conventional colours and a user's
 * muscle memory transfers across projects:
 *   - prod → green (#22c55e) — go signal
 *   - staging / preprod / qa → amber (#f59e0b) — caution
 *   - dev / local → cobalt blue (#4d9fff) — the accent colour
 * Any other name falls through to a hash-based palette pick so distinct envs
 * still get visually distinct colours.
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
  const lower = env.name.toLowerCase();
  if (lower.includes('prod')) return '#22c55e';
  if (lower.includes('stag') || lower.includes('preprod') || /\bqa\b/.test(lower)) return '#f59e0b';
  if (lower.includes('dev') || lower.includes('local')) return '#4d9fff';

  const source = `${env.id}:${env.name}`;
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % ENV_COLOR_PALETTE.length;
  return ENV_COLOR_PALETTE[idx] ?? '#4d9fff';
}
