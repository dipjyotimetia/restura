import {
  countUrlStringSecrets,
  redactUrlCredentialsForStorage,
} from '../collections/postman/text-redaction';
import type { CollectionRequest, KeyValue, SocketIoRequest, WebSocketRequest } from '../types';
import { countSecretKeyValues, redactSecretKeyValues } from './key-value-redaction';

/**
 * Export-time redaction for saved WebSocket / Socket.IO connections (#1209).
 *
 * Handshake headers go through the generic credential-name row walk in
 * `collection-redaction.ts`; Socket.IO `query` rows use the same rule here.
 * On top of that:
 *  - URL userinfo (`wss://user:pw@host`) is stripped and credential-named
 *    query values in the URL (`?access_token=…`) are blanked; a value that is
 *    one `{{var}}` reference is kept (a reference is not a secret).
 *  - The Socket.IO handshake auth payload (`handshakeAuth`) exists to carry
 *    credentials, so EVERY literal value is blanked whatever its key; values
 *    made only of `{{var}}` references are kept.
 *  - The JSON-mode payload (`handshakeAuthJson`) follows the same rule at every
 *    depth: each literal leaf (string, number, boolean) becomes `""`, keys and
 *    structure are kept, and `{{var}}`-only strings and bare `{{var}}` tokens
 *    survive. Text that can't be parsed is blanked whole (fail closed).
 */

// Leading whitespace sits outside the repeat so adjacent `\s*` never overlap
// (no catastrophic backtracking on `{{}}\t{{}}\t…`). Adjacent references with
// no whitespace between them (`{{a}}{{b}}`) are still reference-only.
const TEMPLATE_ONLY = /^\s*(?:\{\{[^{}]*\}\}\s*)+$/;

function isLiteralValue(value: string): boolean {
  return value !== '' && !TEMPLATE_ONLY.test(value);
}

function blankLiteral(rows: KeyValue[]): KeyValue[] {
  return rows.map((row) => (isLiteralValue(row.value) ? { ...row, value: '' } : row));
}

// A bare `{{var}}` outside a JSON string (e.g. `{"id": {{uid}}}`) makes the
// text invalid JSON. Swap each for a sentinel string so it parses, then put the
// original token back after redaction.
const SENTINEL = (i: number) => `\u0000tpl${i}\u0000`;
const BARE_TEMPLATE = /\{\{[^{}]*\}\}/y;

function protectBareTemplates(text: string): { json: string; tokens: string[] } {
  const tokens: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    BARE_TEMPLATE.lastIndex = i;
    const m = BARE_TEMPLATE.exec(text);
    if (m) {
      out += JSON.stringify(SENTINEL(tokens.length));
      tokens.push(m[0]);
      i += m[0].length - 1;
      continue;
    }
    out += ch;
  }
  return { json: out, tokens };
}

const SENTINEL_STRING = /^\u0000tpl\d+\u0000$/;

/** Blank literal leaves; returns the redacted value and how many leaves were blanked. */
function blankJsonLeaves(value: unknown, depth = 0): { value: unknown; blanked: number } {
  if (depth > 64) return { value: '', blanked: 1 };
  if (typeof value === 'string') {
    if (SENTINEL_STRING.test(value) || !isLiteralValue(value)) return { value, blanked: 0 };
    return { value: '', blanked: 1 };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { value: '', blanked: 1 };
  if (value === null || typeof value !== 'object') return { value, blanked: 0 };
  let blanked = 0;
  if (Array.isArray(value)) {
    const out = value.map((v) => {
      const r = blankJsonLeaves(v, depth + 1);
      blanked += r.blanked;
      return r.value;
    });
    return { value: out, blanked };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const r = blankJsonLeaves(v, depth + 1);
    blanked += r.blanked;
    out[k] = r.value;
  }
  return { value: out, blanked };
}

/**
 * Redact a JSON-mode Socket.IO handshake auth payload for export. Exported for
 * tests; callers go through {@link redactStreamPreset}.
 */
export function redactAuthJson(text: string): { text: string; blanked: number } {
  if (text.trim() === '') return { text, blanked: 0 };
  const { json, tokens } = protectBareTemplates(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Unparseable: we can't tell secrets from structure, so drop all of it.
    return { text: '', blanked: 1 };
  }
  const { value, blanked } = blankJsonLeaves(parsed);
  let out = JSON.stringify(value, null, 2);
  tokens.forEach((token, i) => {
    out = out.replace(JSON.stringify(SENTINEL(i)), token);
  });
  return { text: out, blanked };
}

/** Copy of a WebSocket / Socket.IO item with credentials removed; other kinds unchanged. */
export function redactStreamPreset<T extends CollectionRequest>(request: T): T {
  if (request.type === 'websocket') {
    const r = request as WebSocketRequest;
    return { ...r, url: redactUrlCredentialsForStorage(r.url) } as T;
  }
  if (request.type === 'socketio') {
    const r = request as SocketIoRequest;
    return {
      ...r,
      url: redactUrlCredentialsForStorage(r.url),
      handshakeAuth: blankLiteral(r.handshakeAuth),
      ...(r.handshakeAuthJson !== undefined
        ? { handshakeAuthJson: redactAuthJson(r.handshakeAuthJson).text }
        : {}),
      query: redactSecretKeyValues(r.query) ?? [],
    } as T;
  }
  return request;
}

/**
 * Plaintext credentials {@link redactStreamPreset} would remove (headers are
 * counted by the generic row walk in `countCollectionInlineSecrets`).
 */
export function countStreamPresetSecrets(request: CollectionRequest): number {
  if (request.type === 'websocket') return countUrlStringSecrets(request.url);
  if (request.type === 'socketio') {
    return (
      countUrlStringSecrets(request.url) +
      request.handshakeAuth.filter((row) => isLiteralValue(row.value)).length +
      (request.handshakeAuthJson ? redactAuthJson(request.handshakeAuthJson).blanked : 0) +
      countSecretKeyValues(request.query)
    );
  }
  return 0;
}
