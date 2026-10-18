/**
 * MCP credential redaction for browser persistence (#896, SEC-3).
 *
 * The web build stores state in IndexedDB unencrypted (there is no OS keychain
 * to wrap a key), so secret-bearing MCP credentials must not be written there
 * by default: the connection profile's headers, an MCP tab's headers + auth,
 * and saved MCP requests in collections (typed fields AND their OpenCollection
 * `_oc` passthrough bags) are persisted with credential values blanked. The
 * user re-enters them after a reload. Desktop is unaffected — its store is
 * encrypted with a keychain-wrapped key and offers SecretRef handles.
 *
 * Same policy as export redaction (`collection-redaction.ts`): inline values
 * are blanked, SecretRef handles / external refs are preserved (opaque ids,
 * no plaintext), credential-named or `secret`-flagged header rows are blanked
 * and the row kept so the request shape survives. The server URL loses any
 * `user:pass@` userinfo and the values of credential-named query params.
 */
import type { AuthConfig, Collection, CollectionItem } from '../types';
import { redactAuthConfigSecrets, redactOcBag } from './collection-redaction';
import {
  isSecretFieldName,
  redactSecretKeyValues,
  type SecretableRow,
} from './key-value-redaction';

interface McpCredentialBearer {
  url?: string | undefined;
  headers?: SecretableRow[] | undefined;
  auth?: AuthConfig | undefined;
}

/** A value that is exactly one `{{var}}` reference — a pointer, not a secret. */
const SINGLE_VARIABLE_REFERENCE = /^\{\{\s*[^{}\s]+\s*\}\}$/;

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * Strip `user:pass@` userinfo and blank credential-named query parameter
 * values (`?api_key=…`, `?access_token=…`) from a server URL. String-level so
 * templated URLs (`{{base}}/mcp?token={{t}}`) survive untouched apart from
 * the credential; a value that is a single `{{var}}` reference is kept.
 */
export function redactUrlCredentialsForStorage(url: string): string {
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
  const queryStart = out.indexOf('?');
  if (queryStart === -1) return out;
  const hashStart = out.indexOf('#', queryStart);
  const end = hashStart === -1 ? out.length : hashStart;
  const query = out
    .slice(queryStart + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = decodeComponent(pair.slice(0, eq));
      const value = pair.slice(eq + 1);
      if (!value || SINGLE_VARIABLE_REFERENCE.test(decodeComponent(value).trim())) return pair;
      return isSecretFieldName(name) ? `${pair.slice(0, eq)}=` : pair;
    })
    .join('&');
  out = `${out.slice(0, queryStart + 1)}${query}${out.slice(end)}`;
  return out;
}

/** Copy of an MCP request / connection with credential values blanked. */
export function redactMcpCredentials<T extends McpCredentialBearer>(value: T): T {
  const next = { ...value };
  if (typeof value.url === 'string') next.url = redactUrlCredentialsForStorage(value.url);
  if (Array.isArray(value.headers)) {
    next.headers = redactSecretKeyValues(value.headers) as T['headers'];
  }
  if (value.auth) next.auth = redactAuthConfigSecrets(value.auth);
  return next;
}

/** Redact one cached OC MCP entry (`{ info, mcp: { url, headers, auth } }`). */
function redactOcMcpEntry(entry: unknown): unknown {
  const out = redactOcBag(entry);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  const mcp = (out as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object' || typeof (mcp as { url?: unknown }).url !== 'string') {
    return out;
  }
  const url = redactUrlCredentialsForStorage((mcp as { url: string }).url);
  return { ...out, mcp: { ...mcp, url } };
}

/**
 * Legacy / sparse persisted collections may lack `items` (or hold junk); treat
 * a missing or non-array list as empty and leave its shape untouched.
 */
function redactItems(items: unknown): CollectionItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.map((item) =>
    item && typeof item === 'object' ? redactItem(item as CollectionItem) : item
  );
}

function redactItem(item: CollectionItem): CollectionItem {
  let next = item;
  const items = redactItems(item.items);
  if (items) next = { ...next, items };
  if (item.type === 'request' && item.request?.type === 'mcp') {
    next = { ...next, request: redactMcpCredentials(item.request) };
    const bag = (item as { _oc?: unknown })._oc;
    if (bag !== undefined) (next as { _oc?: unknown })._oc = redactOcMcpEntry(bag);
  }
  return next;
}

/**
 * Copy of a collection with every saved MCP request's credentials blanked,
 * including the root OpenCollection bag's `x-restura-mcp` extension entries.
 * Non-MCP items are untouched.
 */
export function redactMcpCollectionCredentials(collection: Collection): Collection {
  const items = redactItems(collection.items);
  const next = { ...collection, ...(items ? { items } : {}) } as Collection & {
    _oc?: unknown;
  };
  const rootBag = next._oc as { extensions?: Record<string, unknown> } | undefined;
  const mcpEntries = rootBag?.extensions?.['x-restura-mcp'];
  if (rootBag && Array.isArray(mcpEntries)) {
    next._oc = {
      ...rootBag,
      extensions: { ...rootBag.extensions, 'x-restura-mcp': mcpEntries.map(redactOcMcpEntry) },
    };
  }
  return next;
}
