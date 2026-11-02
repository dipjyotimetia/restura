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
import {
  REFERENCE_ONLY_VALUE,
  redactUrlCredentialsForStorage,
} from '../collections/postman/text-redaction';
import type { AuthConfig, Collection, CollectionItem } from '../types';
import { redactAuthConfigSecrets, redactOcBag } from './collection-redaction';
import { redactSecretKeyValues, type SecretableRow } from './key-value-redaction';

export { redactUrlCredentialsForStorage };

interface McpCredentialBearer {
  url?: string | undefined;
  headers?: SecretableRow[] | undefined;
  auth?: AuthConfig | undefined;
}

function isReference(v: unknown): boolean {
  const raw =
    typeof v === 'string'
      ? v
      : (v as { kind?: string; value?: unknown })?.kind === 'inline'
        ? (v as { value: unknown }).value
        : undefined;
  return typeof raw === 'string' && REFERENCE_ONLY_VALUE.test(raw.trim());
}

/**
 * `redactAuthConfigSecrets`, but inline secret fields that are a single
 * `{{var}}` reference survive (they hold no secret). Everything else is
 * blanked exactly as before.
 */
function redactAuthPreservingReferences(auth: AuthConfig): AuthConfig {
  const redacted = redactAuthConfigSecrets(auth);
  const a = auth as unknown as Record<string, Record<string, unknown> | undefined>;
  const out = redacted as unknown as Record<string, Record<string, unknown> | undefined>;
  for (const group of ['bearer', 'basic', 'apiKey', 'oauth2'] as const) {
    const src = a[group];
    const dst = out[group];
    if (!src || !dst) continue;
    for (const field of ['token', 'password', 'value', 'accessToken']) {
      if (field in src && isReference(src[field])) {
        out[group] = { ...out[group], [field]: src[field] };
      }
    }
  }
  return redacted;
}

/** Copy of an MCP request / connection with credential values blanked. */
export function redactMcpCredentials<T extends McpCredentialBearer>(value: T): T {
  const next = { ...value };
  if (typeof value.url === 'string') next.url = redactUrlCredentialsForStorage(value.url);
  if (Array.isArray(value.headers)) {
    // A row whose value is exactly one `{{var}}` is a pointer, not a secret.
    next.headers = value.headers.map((row) =>
      typeof row.value === 'string' && REFERENCE_ONLY_VALUE.test(row.value.trim())
        ? row
        : (redactSecretKeyValues([row])?.[0] ?? row)
    ) as T['headers'];
  }
  if (value.auth) next.auth = redactAuthPreservingReferences(value.auth);
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
      extensions: {
        ...rootBag.extensions,
        'x-restura-mcp': mcpEntries.map(redactOcMcpEntry),
      },
    };
  }
  return next;
}
