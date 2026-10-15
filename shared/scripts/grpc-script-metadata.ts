import type { KeyValue } from '../types';

/**
 * gRPC metadata <-> script bridge (#910). A pre-request script sees the
 * outgoing metadata as a flat `rs.request.metadata` map; its edits come back
 * on `ScriptResult.requestMetadata` and are folded into the request's
 * `KeyValue[]` before the call is prepared. Shared by the renderer protocol
 * module and the CLI runner so both harnesses apply edits identically.
 */

/** The metadata map a script sees: enabled, keyed entries, lowercased keys, resolved values. */
export function grpcMetadataForScript(
  metadata: readonly KeyValue[],
  resolve: (text: string) => string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of metadata) {
    if (m.enabled && m.key) out[m.key.toLowerCase()] = resolve(m.value);
  }
  return out;
}

/**
 * Fold a script's final metadata map back onto the request's entries.
 * Keys are matched case-insensitively; a mixed-case write
 * (`metadata['Authorization'] = …`) beats the untouched lowercase original.
 * Keys whose value is unchanged keep every entry verbatim (so duplicates and
 * `{{var}}` templates survive); edited values replace the first entry and
 * disable its duplicates; keys the script deleted are disabled; new keys are
 * appended. Disabled entries are left untouched.
 */
export function applyScriptMetadata(
  metadata: readonly KeyValue[],
  final: Readonly<Record<string, string>>,
  resolve: (text: string) => string
): KeyValue[] {
  const original = grpcMetadataForScript(metadata, resolve);
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(final)) {
    const lower = key.toLowerCase();
    if (!Object.hasOwn(lowered, lower) || value !== original[lower]) lowered[lower] = value;
  }
  const seen = new Set<string>();
  const next: KeyValue[] = metadata.map((m) => {
    if (!m.enabled || !m.key) return m;
    const key = m.key.toLowerCase();
    if (!Object.hasOwn(lowered, key)) return { ...m, enabled: false };
    const value = lowered[key] as string;
    const unchanged = value === original[key];
    if (!unchanged && seen.has(key)) return { ...m, enabled: false };
    seen.add(key);
    return unchanged || resolve(m.value) === value ? m : { ...m, value };
  });
  for (const [key, value] of Object.entries(lowered)) {
    if (!seen.has(key)) next.push({ id: `script:${key}`, key, value, enabled: true });
  }
  return next;
}
