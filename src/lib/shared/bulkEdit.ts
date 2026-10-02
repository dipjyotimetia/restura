import type { KeyValue } from '@/types';

/**
 * Postman-style bulk edit for params/headers: one `key: value` per line,
 * disabled rows prefixed with `//`. Descriptions aren't representable in the
 * text, so they (and row ids) are carried over by matching keys in order.
 */
export function toBulkText(rows: ReadonlyArray<KeyValue>): string {
  return rows
    .filter((r) => r.key || r.value)
    .map((r) => `${r.enabled ? '' : '//'}${r.key}: ${r.value}`)
    .join('\n');
}

export function fromBulkText(
  text: string,
  existing: ReadonlyArray<KeyValue>,
  makeId: () => string
): KeyValue[] {
  const used = new Set<string>();
  const out: KeyValue[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    const enabled = !line.startsWith('//');
    if (!enabled) line = line.slice(2).trim();
    const colon = line.indexOf(':');
    const key = (colon === -1 ? line : line.slice(0, colon)).trim();
    const value = colon === -1 ? '' : line.slice(colon + 1).trim();
    if (!key) continue;
    const match = existing.find((r) => r.key === key && !used.has(r.id));
    if (match) used.add(match.id);
    out.push({
      ...(match ?? {}),
      id: match?.id ?? makeId(),
      key,
      value,
      enabled,
    });
  }
  return out;
}
