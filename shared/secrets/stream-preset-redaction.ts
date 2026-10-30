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
      countSecretKeyValues(request.query)
    );
  }
  return 0;
}
