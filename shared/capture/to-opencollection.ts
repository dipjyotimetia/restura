/**
 * Export a (already-redacted) capture session to an OpenCollection v1.0.0
 * document. The document shape is declared locally rather than imported from
 * `src/lib/opencollection` because `shared/` must not depend on `src/`; the
 * shape matches the published schema and is validated against it in tests.
 *
 * Callers MUST pass a session whose exchanges have been through
 * `redactExchange` so no plaintext secrets land in the export.
 */
import { redactExchange } from './secret-extractor';
import type { CapturedExchange, CaptureSession } from './types';

interface OcHeader {
  name: string;
  value: string;
}

interface OcHttpItem {
  info: { type: 'http'; name: string };
  http: {
    method: string;
    url: string;
    headers?: OcHeader[];
    body?: { raw: { format: string; value: string } };
  };
}

interface OcGraphqlItem {
  info: { type: 'graphql'; name: string };
  graphql: { url: string; query?: string; variables?: string; headers?: OcHeader[] };
}

interface OcWebsocketItem {
  info: { type: 'websocket'; name: string };
  websocket: { url: string; headers?: OcHeader[] };
}

type OcItem = OcHttpItem | OcGraphqlItem | OcWebsocketItem;

type OcVariable = { secret: true; name: string } | { name: string; value?: string };

export interface OpenCollectionDoc {
  opencollection: '1.0.0';
  info: { name: string };
  config?: { environments?: { name: string; variables?: OcVariable[] }[] };
  items: OcItem[];
}

function bodyFormat(ex: CapturedExchange): string {
  const ct = ex.request.headers
    .find((h) => h.name.toLowerCase() === 'content-type')
    ?.value.toLowerCase();
  if (ct?.includes('json')) return 'json';
  if (ct?.includes('xml')) return 'xml';
  return 'text';
}

function itemName(ex: CapturedExchange): string {
  if (ex.graphql?.operationName) return ex.graphql.operationName;
  try {
    const { pathname } = new URL(ex.url);
    return `${ex.method} ${pathname}`;
  } catch {
    return `${ex.method} ${ex.url}`;
  }
}

function parseGraphqlBody(text: string | undefined): { query?: string; variables?: string } {
  if (!text) return {};
  try {
    const obj = JSON.parse(text) as { query?: unknown; variables?: unknown };
    return {
      ...(typeof obj.query === 'string' ? { query: obj.query } : {}),
      ...(obj.variables !== undefined ? { variables: JSON.stringify(obj.variables) } : {}),
    };
  } catch {
    return {};
  }
}

function toItem(ex: CapturedExchange): OcItem {
  const headers = ex.request.headers.map((h) => ({ name: h.name, value: h.value }));
  if (ex.protocol === 'graphql') {
    return {
      info: { type: 'graphql', name: itemName(ex) },
      graphql: { url: ex.url, headers, ...parseGraphqlBody(ex.request.body?.text) },
    };
  }
  if (ex.protocol === 'websocket') {
    return { info: { type: 'websocket', name: itemName(ex) }, websocket: { url: ex.url, headers } };
  }
  // rest, sse, grpc-web all export as an http item. grpc-web is HTTP at the wire
  // and a passive capture has no .proto descriptor to decode the binary frame
  // into an OC `grpc` item's `message`, so http is the faithful (replayable) target.
  return {
    info: { type: 'http', name: itemName(ex) },
    http: {
      method: ex.method,
      url: ex.url,
      headers,
      ...(ex.request.body?.text
        ? { body: { raw: { format: bodyFormat(ex), value: ex.request.body.text } } }
        : {}),
    },
  };
}

/**
 * Convert a session to an OpenCollection document. Idempotently re-redacts each
 * exchange (defence-in-depth) and collects all referenced secrets into a
 * `Captured` environment of secret variables.
 */
export function sessionToOpenCollection(
  session: CaptureSession,
  opts: { name?: string } = {}
): OpenCollectionDoc {
  const secretNames = new Set<string>();
  const items = session.exchanges.map((ex) => {
    const { exchange, secrets } = redactExchange(ex);
    for (const s of secrets) secretNames.add(s.name);
    return toItem(exchange);
  });

  const variables: OcVariable[] = [...secretNames].map((name) => ({ secret: true, name }));

  return {
    opencollection: '1.0.0',
    info: { name: opts.name ?? 'Captured Session' },
    ...(variables.length > 0
      ? { config: { environments: [{ name: 'Captured', variables }] } }
      : {}),
    items,
  };
}
