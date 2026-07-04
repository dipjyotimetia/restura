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
 *   - prod → green (#39b26f) — go signal
 *   - staging / preprod / qa → amber (#d8953d) — caution
 *   - dev / local → cobalt blue (#3d8fe4) — the accent colour
 * Any other name falls through to a hash-based palette pick so distinct envs
 * still get visually distinct colours.
 */
const ENV_COLOR_PALETTE = [
  '#3d8fe4', // accent blue
  '#39b26f', // green
  '#d8953d', // amber
  '#988bdd', // violet
  '#2ba9c2', // cyan
  '#dd7aa2', // pink
  '#dc7095', // hot pink
  '#95a0ab', // slate
] as const;

export function envColorFor(env: { id: string; name: string } | null | undefined): string {
  if (!env) return '#95a0ab';
  const lower = env.name.toLowerCase();
  // `preprod` contains "prod" but is a pre-production env — keep it out of the
  // green (go-signal) bucket so it reads amber like staging/qa.
  if (lower.includes('prod') && !lower.includes('preprod')) return '#39b26f';
  if (lower.includes('stag') || lower.includes('preprod') || /\bqa\b/.test(lower)) return '#d8953d';
  if (lower.includes('dev') || lower.includes('local')) return '#3d8fe4';

  const source = `${env.id}:${env.name}`;
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % ENV_COLOR_PALETTE.length;
  return ENV_COLOR_PALETTE[idx] ?? '#3d8fe4';
}
