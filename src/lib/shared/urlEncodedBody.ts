import type { FormDataItem } from '@/types';

/**
 * x-www-form-urlencoded bodies. Imported collections store them as text
 * fields (`body.formData`), older ones as a pre-encoded `raw` string. The
 * editor works on fields and keeps `raw` in sync; `{{var}}` tokens stay
 * unencoded so they still resolve at send time.
 */
export interface UrlEncodedField {
  key: string;
  value: string;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

function encode(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(/\{\{[^{}]*\}\}/g)) {
    out += encodeURIComponent(text.slice(last, match.index)) + match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  return out + encodeURIComponent(text.slice(last));
}

export function parseUrlEncoded(raw: string): UrlEncodedField[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1
        ? { key: decode(pair), value: '' }
        : { key: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) };
    });
}

export function serializeUrlEncoded(fields: ReadonlyArray<UrlEncodedField>): string {
  return fields
    .filter((f) => f.key !== '' || f.value !== '')
    .map((f) => `${encode(f.key)}=${encode(f.value)}`)
    .join('&');
}

/** The editable fields of a urlencoded body: stored fields, else the parsed raw string. */
export function urlEncodedItems(
  body: { raw?: string; formData?: FormDataItem[] },
  makeId: () => string
): FormDataItem[] {
  const stored = body.formData?.filter((f) => f.type !== 'file') ?? [];
  if (stored.length > 0) return stored;
  return parseUrlEncoded(body.raw ?? '').map((f) => ({
    id: makeId(),
    key: f.key,
    value: f.value,
    enabled: true,
    type: 'text' as const,
  }));
}

/** Raw string for a set of fields (enabled ones only, as sent). */
export function urlEncodedRaw(items: ReadonlyArray<FormDataItem>): string {
  return serializeUrlEncoded(items.filter((i) => i.enabled));
}
