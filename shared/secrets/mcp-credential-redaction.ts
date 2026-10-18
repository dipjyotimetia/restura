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
 * and the row kept so the request shape survives.
 */
import type { AuthConfig, Collection, CollectionItem } from '../types';
import { redactAuthConfigSecrets, redactOcBag } from './collection-redaction';
import { redactSecretKeyValues, type SecretableRow } from './key-value-redaction';

interface McpCredentialBearer {
  headers?: SecretableRow[] | undefined;
  auth?: AuthConfig | undefined;
}

/** Copy of an MCP request / connection with credential values blanked. */
export function redactMcpCredentials<T extends McpCredentialBearer>(value: T): T {
  const next = { ...value };
  if (Array.isArray(value.headers)) {
    next.headers = redactSecretKeyValues(value.headers) as T['headers'];
  }
  if (value.auth) next.auth = redactAuthConfigSecrets(value.auth);
  return next;
}

function redactItem(item: CollectionItem): CollectionItem {
  let next = item;
  if (item.items) {
    next = { ...next, items: item.items.map(redactItem) };
  }
  if (item.type === 'request' && item.request?.type === 'mcp') {
    next = { ...next, request: redactMcpCredentials(item.request) };
    const bag = (item as { _oc?: unknown })._oc;
    if (bag !== undefined) (next as { _oc?: unknown })._oc = redactOcBag(bag);
  }
  return next;
}

/**
 * Copy of a collection with every saved MCP request's credentials blanked,
 * including the root OpenCollection bag's `x-restura-mcp` extension entries.
 * Non-MCP items are untouched.
 */
export function redactMcpCollectionCredentials(collection: Collection): Collection {
  const next = { ...collection, items: collection.items.map(redactItem) } as Collection & {
    _oc?: unknown;
  };
  const rootBag = next._oc as { extensions?: Record<string, unknown> } | undefined;
  const mcpEntries = rootBag?.extensions?.['x-restura-mcp'];
  if (rootBag && Array.isArray(mcpEntries)) {
    next._oc = {
      ...rootBag,
      extensions: { ...rootBag.extensions, 'x-restura-mcp': redactOcBag(mcpEntries) },
    };
  }
  return next;
}
