/**
 * Table view over an x-www-form-urlencoded body string. The stored shape stays
 * the raw string (what the wire sends), so the table parses it for display and
 * re-serializes on edit. `{{var}}` tokens are left unencoded so they still
 * resolve at send time.
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
